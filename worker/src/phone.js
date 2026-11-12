/*
 * Public phone page that a QR opens: /c/<token>
 * Same look and behaviour as the Node version, but the API calls stay
 * relative so they hit whichever Worker origin served the page.
 */

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const label = (s) =>
  ({
    direct: 'Called',
    demo: 'Demo call',
    placed: 'Ringing',
    bridged: 'Answered',
    completed: 'Completed',
    busy: 'Busy',
    'no-answer': 'No answer',
    failed: 'Failed',
    canceled: 'Cancelled',
  })[s] || (s ? s[0].toUpperCase() + s.slice(1) : 'Call');

const fmtDur = (v) => {
  const s = Math.max(0, Math.round(Number(v) || 0));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const fmtWhen = (raw) => {
  if (!raw) return '';
  let s = String(raw);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function phonePage({ contact, history, callCount }) {
  const tel = String(contact.phone || '').replace(/[^+\d]/g, '');
  const count = Math.max(0, Number(callCount) || 0);

  const historyHtml = history.length
    ? `<h2 class="history-title">Call history</h2><ul class="history">` +
      history
        .map((h) => {
          const when = h.answered_at || h.created_at;
          const bits = [];
          if (h.duration != null) bits.push(`${fmtDur(h.duration)} talk time`);
          if (h.answered_at) bits.push('Picked up ' + fmtWhen(h.answered_at));
          if (h.ended_at) bits.push('Hung up ' + fmtWhen(h.ended_at));
          if (h.duration == null && !h.answered_at) bits.push('Not connected');
          return `<li><div class="hrow"><span class="hstatus">${escapeHtml(label(h.status))}</span><time class="htime" data-ts="${escapeHtml(when || '')}"></time></div><div class="hsub">${escapeHtml(bits.join(' · '))}</div><div class="hsub mutedsmall">Started ${escapeHtml(fmtWhen(h.created_at))}</div></li>`;
        })
        .join('') +
      `</ul>`
    : `<div class="muted" style="margin-top:16px;font-size:14px">No calls yet.</div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(contact.name)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:#f4f6fb; color:#1b2437; }
  .wrap { max-width:460px; margin:0 auto; padding:24px 18px 40px; }
  .card { background:#fff; border:1px solid #e3e8f2; border-radius:16px; padding:22px; box-shadow:0 8px 24px rgba(20,35,70,.06); }
  h1 { margin:0 0 2px; font-size:22px; }
  .muted { color:#6b7690; font-size:14px; }
  .count { display:inline-block; margin-top:10px; background:#e8f5ee; color:#176b3a; font-weight:600; font-size:14px; padding:4px 12px; border-radius:999px; }
  .phone { font-size:20px; font-weight:600; margin:16px 0 4px; }
  a.big { display:block; text-align:center; text-decoration:none; font-weight:700; font-size:18px; padding:16px; border-radius:12px; margin-top:14px; }
  a.call { background:#1f8a4c; color:#fff; }
  #status { margin-top:12px; font-size:14px; color:#2f7a4f; min-height:20px; }
  .history-title { margin:18px 0 10px; font-size:16px; }
  .history { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
  .history li { border:1px solid #eef2f8; border-radius:12px; padding:10px 12px; }
  .hrow { display:flex; align-items:center; justify-content:space-between; gap:10px; font-weight:600; }
  .hstatus { background:#eef4ff; color:#2451a8; padding:2px 8px; border-radius:999px; font-size:13px; }
  .hsub { margin-top:4px; font-size:13px; color:#6b7690; }
  .mutedsmall { font-size:12px; color:#6b7690; margin-top:2px; }
  .finish { margin-top:14px; border:1px solid #d8e4f5; background:#f7faff; border-radius:12px; padding:14px; }
  .finish.hidden { display:none; }
  .ftitle { font-weight:700; margin-bottom:10px; }
  .frow { display:flex; align-items:center; gap:10px; margin-bottom:12px; font-size:14px; color:#41506b; }
  .frow input { width:96px; padding:8px; border:1px solid #cfd9ea; border-radius:8px; font-size:15px; }
  .fbtns { display:flex; gap:10px; }
  .fbtns button { flex:1; padding:12px; border-radius:10px; border:1px solid transparent; font-size:15px; font-weight:600; cursor:pointer; }
  .fbtns .go { background:#1f8a4c; color:#fff; }
  .fbtns .skip { background:#fff; color:#41506b; border-color:#cfd9ea; }
</style></head>
<body><div class="wrap"><div class="card">
  <h1>${escapeHtml(contact.name)}</h1>
  <div class="muted">${escapeHtml(contact.job_title || '')}${contact.job_title && contact.email ? ' · ' : ''}${escapeHtml(contact.email || '')}</div>
  <div class="count">Called ${count} time${count === 1 ? '' : 's'}</div>
  <div class="phone">${escapeHtml(contact.phone)}</div>
  <a class="big call" id="call" href="tel:${tel}">Call now</a>
  <div id="status" role="status"></div>
  <div id="finish" class="finish hidden">
    <div class="ftitle">How did the call go?</div>
    <div class="frow">
      <label for="dur">Talk time (seconds)</label>
      <input id="dur" type="number" min="0" step="1" inputmode="numeric" />
    </div>
    <div class="fbtns">
      <button id="save" class="go" type="button">Save call</button>
      <button id="noc" class="skip" type="button">Didn't connect</button>
    </div>
  </div>
  ${historyHtml}
</div></div>
<script>
  var token = ${JSON.stringify(contact.public_token)};
  var statusEl = document.getElementById('status');
  var callBtn = document.getElementById('call');
  var finishEl = document.getElementById('finish');
  var durEl = document.getElementById('dur');
  var saveBtn = document.getElementById('save');
  var nocBtn = document.getElementById('noc');
  var pending = 0;
  var KEY_T = 'gc_start_' + token;

  function whenText(raw) {
    if (!raw) return '';
    var s = String(raw);
    if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    var d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  Array.prototype.forEach.call(document.querySelectorAll('time[data-ts]'), function (el) {
    el.textContent = whenText(el.getAttribute('data-ts'));
  });

  callBtn.addEventListener('click', function () {
    var start = Date.now();
    try { sessionStorage.setItem(KEY_T, String(start)); } catch (e) {}
    finishEl.classList.add('hidden');
    pending = 0;
    statusEl.style.color = '#2f7a4f';
    statusEl.textContent = 'Starting the call…';
    fetch('/api/public/' + token + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'direct' }),
      keepalive: true
    }).catch(function () {});
  });

  function takeStart() {
    var start = 0;
    try { start = Number(sessionStorage.getItem(KEY_T) || 0); } catch (e) { start = 0; }
    return start;
  }

  function showFinish() {
    if (pending) return;
    var start = takeStart();
    if (!start) return;
    var secs = Math.round((Date.now() - start) / 1000);
    if (secs > 7200) {
      try { sessionStorage.removeItem(KEY_T); } catch (e) {}
      return;
    }
    pending = start;
    durEl.value = String(Math.max(0, secs));
    finishEl.classList.remove('hidden');
    statusEl.style.color = '#2f7a4f';
    statusEl.textContent = 'Call finished? Check the talk time and save.';
    try { finishEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }

  async function saveCall(status, seconds) {
    if (!pending) return;
    saveBtn.disabled = true;
    nocBtn.disabled = true;
    statusEl.style.color = '#2f7a4f';
    statusEl.textContent = 'Saving…';
    try {
      var r = await fetch('/api/public/' + token + '/call/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: seconds, status: status })
      });
      if (r.ok) {
        try { sessionStorage.removeItem(KEY_T); } catch (e) {}
        location.reload();
        return;
      }
      throw new Error('save failed');
    } catch (e) {
      saveBtn.disabled = false;
      nocBtn.disabled = false;
      statusEl.style.color = '#b4483d';
      statusEl.textContent = 'Could not save. Check your connection and try again.';
    }
  }

  saveBtn.addEventListener('click', function () {
    var secs = Math.max(0, Math.round(Number(durEl.value) || 0));
    if (secs <= 0) {
      durEl.focus();
      statusEl.style.color = '#b4483d';
      statusEl.textContent = 'Enter the talk time in seconds, or tap “Didn’t connect”.';
      return;
    }
    saveCall('completed', secs);
  });

  nocBtn.addEventListener('click', function () {
    saveCall('no-answer', 0);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') showFinish();
  });
  window.addEventListener('focus', showFinish);
  showFinish();
</script>
</body></html>`;
}
