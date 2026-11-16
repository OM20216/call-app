/*
 * Office-hosted Graph Call server.
 *
 * Runs the exact same Worker code (worker/src/index.js) on Node, with a local
 * SQLite file instead of Cloudflare D1, and serves worker/public itself.
 * No Cloudflare, no internet required: anyone on the office Wi-Fi can reach
 * http://<this-pc>:4200.
 *
 *   node worker/local/server.mjs
 *
 * Environment (all optional):
 *   PORT              default 4200
 *   HOST              default 0.0.0.0 (all network interfaces)
 *   CALL_DB_FILE      default worker/local/data/call-app.sqlite
 *   PUBLIC_BASE_URL   default: the address the browser used
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');
const DATA_DIR = path.join(HERE, 'data');
const DB_FILE = process.env.CALL_DB_FILE || path.join(DATA_DIR, 'call-app.sqlite');
const PORT = Number(process.env.PORT || 4200);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* D1 shim over node:sqlite                                            */
/* ------------------------------------------------------------------ */

class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args.map((a) => {
      if (a === undefined) return null;
      if (typeof a === 'boolean') return a ? 1 : 0;
      if (a instanceof Date) return a.toISOString();
      return a;
    });
    return this;
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return { success: true, results: rows.map((r) => ({ ...r })) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) },
    };
  }
}

class D1 {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
  async batch(statements) {
    return Promise.all(statements.map((s) => s.run()));
  }
}

/* ------------------------------------------------------------------ */
/* static files (same files wrangler uploads as [assets])              */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(PUBLIC_DIR)) return new Response('Not found', { status: 404 });
    let body;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      body = await fsp.readFile(file);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-cache',
    };
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  },
};

const env = { DB: new D1(DB_FILE), ASSETS, PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '' };

/* ------------------------------------------------------------------ */
/* HTTP -> worker fetch                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await worker.fetch(request, env);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-length') return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err && err.message ? err.message : 'Server error' }));
    } else {
      res.end();
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 1500) console.log(`[slow ${ms}ms] ${req.method} ${req.url}`);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, HOST, () => {
  console.log(`Graph Call (office) listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
