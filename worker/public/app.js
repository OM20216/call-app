/* Graph Call – one-screen vanilla app */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(ts) {
  if (!ts) return '';
  const then = new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDur(v) {
  const s = Math.max(0, Math.round(Number(v) || 0));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let me = null;
let callingMode = 'direct';
let contacts = [];
let contactPage = 1;
let contactHasMore = false;
let contactQuery = '';
let isAdmin = false;

/* ------------------------------------------------------------------ */
/* sign in / out                                                       */
/* ------------------------------------------------------------------ */

async function boot() {
  const d = await api('/api/me');
  if (d.authenticated) return enterApp(d.user);
  $('#login-view').classList.remove('hidden');
}

function enterApp(user) {
  me = user;
  isAdmin = user.role === 'admin';
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setMe(user);
  loadContacts(true);
  api('/api/status')
    .then((s) => {
      callingMode = s.callingMode === 'twilio' ? 'twilio' : 'direct';
      $('#mode-note').classList.toggle('hidden', callingMode !== 'direct');
      setMe(me);
      applyAdminVisibility();
    })
    .catch(() => {});
}

function setMe(user) {
  me = user;
  if (callingMode === 'direct') {
    $('#my-number').innerHTML = '<span class="wide">Mode: </span>Free SIM calling';
    $('#mobile-form').classList.add('hidden');
  } else {
    $('#my-number').innerHTML = user.mobile
      ? `<span class="wide">Your phone: </span>${esc(user.mobile)}`
      : 'Set your phone';
    $('#mobile-form').classList.toggle('hidden', !!user.mobile);
  }
  $('#mobile-input').value = user.mobile || '';
}

function applyAdminVisibility() {
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
}

// Login is handled by the inline onclick="doLogin()" on the Sign in button.
// app.js still boots the dashboard after login (via enterApp called from doLogin).

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

$('#mobile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const d = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ mobile: $('#mobile-input').value }),
    });
    setMe(d.user);
    toast('Saved.');
  } catch (err) {
    $('#mobile-error').textContent = err.message;
  }
});

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.section').forEach((s) => s.classList.toggle('hidden', s.id !== `section-${name}`));
  if (name === 'callbacks') loadCallbacks();
  if (name === 'team') loadTeam();
  if (name === 'reports') loadReports();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ------------------------------------------------------------------ */
/* contacts                                                            */
/* ------------------------------------------------------------------ */

const callText = (c) => {
  if (!c.callCount) return 'Not called yet';
  const answered = c.lastAnsweredAt ? ` · answered ${timeAgo(c.lastAnsweredAt)}` : '';
  const dur = c.lastDuration ? ` · last ${fmtDur(c.lastDuration)}` : '';
  const total = c.totalSeconds ? ` · total ${fmtDur(c.totalSeconds)}` : '';
  return `Called ${c.callCount} time${c.callCount === 1 ? '' : 's'}${answered}${dur}${total}`;
};

function renderContacts() {
  const q = contactQuery.trim().toLowerCase();
  const shown = q
    ? contacts.filter((c) => `${c.name} ${c.phone} ${c.email} ${c.jobTitle}`.toLowerCase().includes(q))
    : contacts;
  $('#contacts').innerHTML = shown
    .map(
      (c) => `
    <li>
      <div class="info">
        <div class="name">${esc(c.name)}</div>
        <div class="meta">${esc(c.phone)}${c.jobTitle ? ' · ' + esc(c.jobTitle) : ''}</div>
        <div class="count">${callText(c)}</div>
      </div>
      <button class="btn primary call" data-call="${c.id}" type="button">Call</button>
      <button class="btn ghost" data-more="${c.id}" type="button">More</button>
    </li>`,
    )
    .join('');
  $('#empty').classList.toggle('hidden', contacts.length > 0);
  $('#load-more-wrap').classList.toggle('hidden', !contactHasMore);
}

async function loadContacts(reset = false) {
  if (reset) { contacts = []; contactPage = 1; }
  const list = $('#contacts');
  const empty = $('#empty');
  if (empty) empty.classList.add('hidden');
  if (reset) list.innerHTML = '<li class="muted" style="padding:12px;">Loading contacts…</li>';
  const d = await api(`/api/contacts?q=${encodeURIComponent(contactQuery)}&page=${contactPage}&limit=50`);
  contacts = reset ? d.contacts : contacts.concat(d.contacts);
  contactHasMore = !!d.hasMore;
  renderContacts();
}

$('#filter').addEventListener('input', (e) => {
  contactQuery = e.target.value;
  loadContacts(true);
});

$('#load-more').addEventListener('click', () => {
  contactPage += 1;
  loadContacts(false);
});

$('#contacts').addEventListener('click', (e) => {
  const callBtn = e.target.closest('[data-call]');
  const moreBtn = e.target.closest('[data-more]');
  if (callBtn) placeCall(callBtn.dataset.call, callBtn);
  if (moreBtn) openMore(moreBtn.dataset.more);
});

async function placeCall(id, button) {
  const c = contacts.find((x) => String(x.id) === String(id));
  if (callingMode === 'twilio' && !me.mobile) {
    $('#mobile-input').focus();
    return toast('Enter your mobile number first.', true);
  }
  if (button) { button.disabled = true; button.textContent = 'Calling…'; }
  try {
    const d = await api(`/api/contacts/${id}/call`, { method: 'POST', body: JSON.stringify({}) });
    await loadContacts(true);
    if (d.mode === 'direct') {
      showCallPanel(c, d.url);
    } else {
      toast(`Your phone is ringing. Answer it to talk to ${c?.name || 'the contact'}.`);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Call'; }
  }
}

function showCallPanel(c, url) {
  const name = c?.name || 'this contact';
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    location.href = url;
    return;
  }
  const token = String(url || '').split('/c/')[1] || c?.token || '';
  openModal(`
    <h3>Call ${esc(name)}</h3>
    <p class="muted">Scan this code with your phone, then tap <b>Call now</b>. Your phone's SIM places the call — free and unlimited.</p>
    <img class="qr" src="/qr/${esc(token)}.png" alt="QR code for ${esc(name)}" />
    <p class="muted small center">Already on your phone? <a href="${esc(url)}">Open the call page</a></p>
    <p class="muted small center">${esc(c?.phone || '')}</p>
    <div class="center" style="margin-top:12px;">
      <button class="btn ghost" type="button" data-close="1">Close</button>
    </div>
  `);
}

/* ------------------------------------------------------------------ */
/* pop-up                                                              */
/* ------------------------------------------------------------------ */

function openModal(html) {
  const m = $('#modal');
  m.style.display = '';
  $('#modal-body').innerHTML = html;
  m.classList.remove('hidden');
}
const closeModal = () => {
  const m = $('#modal');
  m.classList.add('hidden');
  m.style.display = 'none';
};
// Event delegation: works even if the modal content is re-rendered.
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
  if (e.target.id === 'modal-close' || e.target.closest('#modal-close')) closeModal();
  if (e.target.dataset && e.target.dataset.close === '1') closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });

async function openMore(id) {
  const d = await api(`/api/contacts/${id}`);
  const c = d.contact;
  const history = (d.history || [])
    .map(
      (h) => `
      <li>
        <div class="history-time">${fmtDateTime(h.answered_at || h.created_at)}</div>
        <div class="history-meta">
          <span class="badge">${esc(h.status || 'unknown')}</span>
          <div class="history-detail">
            <div>Started: ${fmtDateTime(h.created_at)}</div>
            <div>Picked up: ${h.answered_at ? fmtDateTime(h.answered_at) : 'not recorded'}</div>
            <div>Hung up: ${h.ended_at ? fmtDateTime(h.ended_at) : 'not recorded'}</div>
            <div>Talk time: ${h.duration != null ? fmtDur(h.duration) : 'not recorded'}</div>
            <div>Outcome: ${esc(h.outcome || h.status || '—')}</div>
            ${h.notes ? `<div>Notes: ${esc(h.notes)}</div>` : ''}
            ${h.next_call_date ? `<div>Next call: ${esc(h.next_call_date)}</div>` : ''}
            ${h.provider_sid ? `<div>SID: ${esc(h.provider_sid)}</div>` : ''}
          </div>
        </div>
      </li>`,
    )
    .join('');
  openModal(`
    <h3>${esc(c.name)}</h3>
    <div class="muted">${esc(c.phone)}</div>
    ${c.email ? `<div class="muted small">${esc(c.email)}</div>` : ''}
    ${c.jobTitle ? `<div class="muted small">${esc(c.jobTitle)}</div>` : ''}
    ${c.ownerName ? `<div class="muted small">Owner: ${esc(c.ownerName)} (${esc(c.ownerEmail || '')})</div>` : ''}
    <img class="qr" src="/qr/${c.token}.png" alt="QR code for ${esc(c.name)}" />
    <p class="muted small center">Scan with your phone to call ${esc(c.name)} from it.</p>
    <h4>${callText(c)}</h4>
    ${c.totalSeconds ? `<p class="muted small">Total talk time: ${fmtDur(c.totalSeconds)}</p>` : ''}
    ${history ? `<ul class="history">${history}</ul>` : `<p class="muted small">No calls yet.</p>`}
    <div class="row-actions">
      <button class="btn ghost sm" id="edit-contact" type="button">Edit</button>
      <button class="btn danger-link" id="remove" type="button">Remove</button>
    </div>`);

  $('#remove').addEventListener('click', async () => {
    if (!confirm(`Remove ${c.name} from your list?`)) return;
    await api(`/api/contacts/${c.id}`, { method: 'DELETE' });
    closeModal();
    loadContacts(true);
  });

  $('#edit-contact').addEventListener('click', () => {
    openModal(`
      <h3>Edit ${esc(c.name)}</h3>
      <form id="edit-form" class="form">
        <label>Name<input name="name" value="${esc(c.name)}" required /></label>
        <label>Phone<input name="phone" value="${esc(c.phone)}" required /></label>
        <label>Email<input name="email" value="${esc(c.email || '')}" /></label>
        <label>Job title<input name="jobTitle" value="${esc(c.jobTitle || '')}" /></label>
        <div class="inline">
          <button class="btn primary" type="submit">Save</button>
          <button class="btn ghost" type="button" id="cancel-edit">Cancel</button>
        </div>
      </form>`);
    $('#cancel-edit').addEventListener('click', () => openMore(c.id));
    $('#edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api(`/api/contacts/${c.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: f.name.value,
            phone: f.phone.value,
            email: f.email.value,
            jobTitle: f.jobTitle.value,
          }),
        });
        toast('Updated.');
        openMore(c.id);
        loadContacts(true);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* manual add                                                          */
/* ------------------------------------------------------------------ */

function openAdd() {
  openModal(`
    <h3>Add a person</h3>
    <div class="tabs small">
      <button class="tab active" data-mtab="manual" type="button">Manual</button>
      <button class="tab" data-mtab="directory" type="button">Directory</button>
    </div>
    <div id="manual-pane">
      <form id="manual-form" class="form">
        <label>Name<input name="name" required /></label>
        <label>Phone<input name="phone" type="tel" required /></label>
        <label>Email<input name="email" type="email" /></label>
        <label>Job title<input name="jobTitle" /></label>
        <button class="btn primary" type="submit">Add contact</button>
      </form>
    </div>
    <div id="directory-pane" class="hidden">
      <input id="book-search" class="search" type="search" placeholder="Type a name, email or phone…" />
      <ul id="book-list" class="list compact"></ul>
      <p id="book-hint" class="muted">Loading…</p>
    </div>`);

  $$('.tab[data-mtab]').forEach((t) => t.addEventListener('click', () => {
    $$('.tab[data-mtab]').forEach((x) => x.classList.toggle('active', x === t));
    $('#manual-pane').classList.toggle('hidden', t.dataset.mtab !== 'manual');
    $('#directory-pane').classList.toggle('hidden', t.dataset.mtab !== 'directory');
    if (t.dataset.mtab === 'directory') loadAddressBook('');
  }));

  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name.value,
          phone: f.phone.value,
          email: f.email.value,
          jobTitle: f.jobTitle.value,
        }),
      });
      toast('Contact added.');
      closeModal();
      loadContacts(true);
    } catch (err) {
      toast(err.message, true);
    }
  });

  const input = $('#book-search');
  if (input) {
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadAddressBook(input.value), 250);
    });
    loadAddressBook('');
  }
}

async function loadAddressBook(q) {
  const hint = $('#book-hint');
  const list = $('#book-list');
  if (!list) return;
  try {
    const d = await api(`/api/address-book?q=${encodeURIComponent(q || '')}`);
    const people = d.people || [];
    list.innerHTML = people
      .map(
        (p, i) => `
      <li>
        <div class="info">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.phone || p.email || '')}</div>
        </div>
        ${p.added
          ? '<span class="muted small">Added ✓</span>'
          : p.phone
            ? `<button class="btn primary sm" data-add="${i}" type="button">Add</button>`
            : '<span class="muted small">No phone</span>'}
      </li>`,
      )
      .join('');
    bookPeople = people;
    hint.textContent = people.length ? '' : 'No matches.';
  } catch (err) {
    hint.textContent = 'Could not load the address book: ' + err.message;
  }
}

let bookPeople = [];

$('#contacts').addEventListener('click', () => {});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const p = bookPeople[Number(btn.dataset.add)];
  if (!p) return;
  btn.disabled = true;
  try {
    await api('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name: p.name,
        phone: p.phone,
        email: p.email,
        jobTitle: p.jobTitle,
        graphId: p.graphId,
      }),
    });
    toast('Added.');
    loadContacts(true);
    btn.outerHTML = '<span class="muted small">Added ✓</span>';
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$('#add-open').addEventListener('click', openAdd);
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.action === 'add-open') openAdd();
});

/* ------------------------------------------------------------------ */
/* callbacks                                                           */
/* ------------------------------------------------------------------ */

async function loadCallbacks() {
  try {
    const d = await api('/api/callbacks');
    const list = $('#callbacks');
    const empty = $('#callbacks-empty');
    const items = d.contacts || [];
    list.innerHTML = items
      .map(
        (c) => `
      <li>
        <div class="info">
          <div class="name">${esc(c.name)}</div>
          <div class="meta">${esc(c.phone)}</div>
          <div class="count">${callText(c)}</div>
        </div>
        <button class="btn primary call" data-call="${c.id}" type="button">Call</button>
        <button class="btn ghost" data-more="${c.id}" type="button">More</button>
      </li>`,
      )
      .join('');
    empty.classList.toggle('hidden', items.length > 0);
  } catch (err) {
    toast(err.message, true);
  }
}

$('#callbacks').addEventListener('click', (e) => {
  const callBtn = e.target.closest('[data-call]');
  const moreBtn = e.target.closest('[data-more]');
  if (callBtn) placeCall(callBtn.dataset.call, callBtn);
  if (moreBtn) openMore(moreBtn.dataset.more);
});

/* ------------------------------------------------------------------ */
/* team (admin)                                                        */
/* ------------------------------------------------------------------ */

async function loadTeam() {
  if (!isAdmin) return;
  try {
    const d = await api('/api/users');
    const list = $('#users');
    list.innerHTML = (d.users || [])
      .map(
        (u) => `
      <li>
        <div class="info">
          <div class="name">${esc(u.fullName)} <span class="badge">${esc(u.role)}</span></div>
          <div class="meta">${esc(u.email)}${u.mobile ? ' · ' + esc(u.mobile) : ''}</div>
        </div>
        <button class="btn ghost sm" data-reset="${u.id}" type="button">Reset password</button>
        ${u.id !== me.id ? `<button class="btn danger-link sm" data-deluser="${u.id}" type="button">Remove</button>` : ''}
      </li>`,
      )
      .join('');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#add-user-open').addEventListener('click', () => {
  openModal(`
    <h3>Add recruiter</h3>
    <form id="user-form" class="form">
      <label>Full name<input name="fullName" required /></label>
      <label>Email<input name="email" type="email" required /></label>
      <label>Password<input name="password" type="password" required minlength="6" /></label>
      <label>Mobile<input name="mobile" type="tel" /></label>
      <label>Role<select name="role"><option value="recruiter">Recruiter</option><option value="admin">Admin</option></select></label>
      <button class="btn primary" type="submit">Create</button>
    </form>`);
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          fullName: f.fullName.value,
          email: f.email.value,
          password: f.password.value,
          mobile: f.mobile.value,
          role: f.role.value,
        }),
      });
      toast('Recruiter created.');
      closeModal();
      loadTeam();
    } catch (err) {
      toast(err.message, true);
    }
  });
});

document.addEventListener('click', async (e) => {
  const resetBtn = e.target.closest('[data-reset]');
  const delBtn = e.target.closest('[data-deluser]');
  if (resetBtn) {
    const id = resetBtn.dataset.reset;
    const pw = prompt('New password (min 6 chars):');
    if (!pw) return;
    try {
      await api(`/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
      toast('Password reset.');
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (delBtn) {
    const id = delBtn.dataset.deluser;
    if (!confirm('Remove this user? Their contacts will be deleted.')) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast('Removed.');
      loadTeam();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

/* ------------------------------------------------------------------ */
/* reports (admin)                                                     */
/* ------------------------------------------------------------------ */

async function loadReports() {
  if (!isAdmin) return;
  try {
    const d = await api('/api/reports');
    $('#report-totals').innerHTML = `
      <strong>Totals:</strong> ${d.totals.contacts} contacts · ${d.totals.calls} calls · ${fmtDur(d.totals.totalSeconds)} talk time`;
    const recruiters = d.recruiters || [];
    $('#report-recruiters').innerHTML = recruiters.length
      ? `<table class="report-table"><thead><tr><th>Name</th><th>Role</th><th>Contacts</th><th>Calls</th><th>Answered</th><th>Missed</th><th>Talk</th></tr></thead><tbody>
        ${recruiters.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${r.contacts}</td><td>${r.calls}</td><td>${r.answered}</td><td>${r.missed}</td><td>${fmtDur(r.totalSeconds)}</td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted small">No recruiters yet.</p>';
    const daily = d.daily || [];
    $('#report-daily').innerHTML = daily.length
      ? `<table class="report-table"><thead><tr><th>Day</th><th>Calls</th></tr></thead><tbody>
        ${daily.map((x) => `<tr><td>${esc(x.day)}</td><td>${x.calls}</td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted small">No calls in the last 14 days.</p>';
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* csv export                                                          */
/* ------------------------------------------------------------------ */

$('#export-csv').addEventListener('click', () => {
  window.location.href = '/api/contacts/export.csv';
});

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

boot();
