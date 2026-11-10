/* Graph Call – one-screen vanilla app */
const $ = (sel) => document.querySelector(sel);

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

const callText = (c) => {
  if (!c.callCount) return 'Not called yet';
  const answered = c.lastAnsweredAt ? ` · answered ${timeAgo(c.lastAnsweredAt)}` : '';
  return `Called ${c.callCount} time${c.callCount === 1 ? '' : 's'}${answered}`;
};

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

/* ------------------------------------------------------------------ */
/* sign in / out                                                       */
/* ------------------------------------------------------------------ */

let me = null;

async function boot() {
  const d = await api('/api/me');
  if (d.authenticated) return enterApp(d.user);
  $('#login-view').classList.remove('hidden');
}

function enterApp(user) {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setMe(user);
  loadContacts();
  api('/api/status')
    .then((s) => $('#demo-note').classList.toggle('hidden', s.callingMode !== 'demo'))
    .catch(() => {});
}

function setMe(user) {
  me = user;
  $('#my-number').innerHTML = user.mobile
    ? `<span class="wide">Your phone: </span>${esc(user.mobile)}`
    : 'Set your phone';
  $('#mobile-form').classList.toggle('hidden', !!user.mobile);
  $('#mobile-input').value = user.mobile || '';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const d = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }),
    });
    enterApp(d.user);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

/* ------------------------------------------------------------------ */
/* my mobile number                                                    */
/* ------------------------------------------------------------------ */

async function saveMobile(value) {
  const d = await api('/api/settings', { method: 'POST', body: JSON.stringify({ mobile: value }) });
  setMe(d.user);
  return d.user;
}

$('#mobile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#mobile-error').textContent = '';
  try {
    await saveMobile($('#mobile-input').value);
    toast('Saved. You can call now.');
  } catch (err) {
    $('#mobile-error').textContent = err.message;
  }
});

$('#my-number').addEventListener('click', async () => {
  const value = prompt('Your mobile number (this phone rings when you press Call):', me.mobile || '');
  if (value === null) return;
  try {
    await saveMobile(value);
    toast('Phone number saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ */
/* my contacts                                                         */
/* ------------------------------------------------------------------ */

let contacts = [];

async function loadContacts() {
  const d = await api('/api/contacts');
  contacts = d.contacts;
  $('#empty').classList.toggle('hidden', contacts.length > 0);
  $('#filter').classList.toggle('hidden', contacts.length < 6);
  renderContacts();
}

function renderContacts() {
  const q = $('#filter').value.trim().toLowerCase();
  const shown = q
    ? contacts.filter((c) => `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(q))
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
}

$('#filter').addEventListener('input', renderContacts);

$('#contacts').addEventListener('click', (e) => {
  const callBtn = e.target.closest('[data-call]');
  const moreBtn = e.target.closest('[data-more]');
  if (callBtn) placeCall(callBtn.dataset.call, callBtn);
  if (moreBtn) openMore(moreBtn.dataset.more);
});

async function placeCall(id, button) {
  if (!me.mobile) {
    $('#mobile-input').focus();
    return toast('Enter your mobile number first.', true);
  }
  const c = contacts.find((x) => String(x.id) === String(id));
  if (button) { button.disabled = true; button.textContent = 'Calling…'; }
  try {
    const d = await api(`/api/contacts/${id}/call`, { method: 'POST', body: JSON.stringify({}) });
    toast(d.mock
      ? `Demo: call to ${c?.name || 'contact'} counted.`
      : `Your phone is ringing. Answer it to talk to ${c?.name || 'the contact'}.`);
    await loadContacts();
  } catch (err) {
    toast(err.message, true);
    if (button) { button.disabled = false; button.textContent = 'Call'; }
  }
}

/* ------------------------------------------------------------------ */
/* pop-up                                                              */
/* ------------------------------------------------------------------ */

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
const closeModal = () => $('#modal').classList.add('hidden');

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* "More": QR code, full call details, remove */
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
          ${h.answered_at ? `<span class="sid">Answered at ${fmtDateTime(h.answered_at)}</span>` : ''}
          ${h.provider_sid ? `<span class="sid">SID: ${esc(h.provider_sid)}</span>` : ''}
          ${h.duration ? `<span class="sid">Dur: ${Math.round(h.duration)}s</span>` : ''}
        </div>
      </li>`,
    )
    .join('');
  openModal(`
    <h3>${esc(c.name)}</h3>
    <div class="muted">${esc(c.phone)}</div>
    ${c.email ? `<div class="muted small">${esc(c.email)}</div>` : ''}
    ${c.jobTitle ? `<div class="muted small">${esc(c.jobTitle)}</div>` : ''}
    <img class="qr" src="/qr/${c.token}.png" alt="QR code for ${esc(c.name)}" />
    <p class="muted small center">Scan with your phone to call ${esc(c.name)} from it.</p>
    <h4>${callText(c)}</h4>
    ${history ? `<ul class="history">${history}</ul>` : `<p class="muted small">No calls yet.</p>`}
    <button class="btn danger-link" id="remove" type="button">Remove from my list</button>`);

  $('#remove').addEventListener('click', async () => {
    if (!confirm(`Remove ${c.name} from your list?`)) return;
    await api(`/api/contacts/${c.id}`, { method: 'DELETE' });
    closeModal();
    loadContacts();
  });
}

/* "Add person": search the Microsoft 365 address book */
function openAdd() {
  openModal(`
    <h3>Add a person</h3>
    <input id="book-search" class="search" type="search" placeholder="Type a name, email or phone…" />
    <ul id="book-list" class="list compact"></ul>
    <p id="book-hint" class="muted">Loading…</p>`);
  const input = $('#book-search');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadAddressBook(input.value), 250);
  });
  input.focus();
  loadAddressBook('');
}

$('#add-open').addEventListener('click', openAdd);
$('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-action="add-open"]')) openAdd(); });

let bookPeople = [];

async function loadAddressBook(query) {
  const hint = $('#book-hint');
  hint.textContent = 'Loading…';
  hint.classList.remove('hidden');
  try {
    const d = await api('/api/address-book?q=' + encodeURIComponent(query));
    bookPeople = d.people;
    if (!bookPeople.length) {
      $('#book-list').innerHTML = '';
      hint.textContent = 'Nobody found.';
      return;
    }
    hint.classList.add('hidden');
    $('#book-list').innerHTML = bookPeople
      .map((p, i) => {
        const button = p.added
          ? '<span class="muted small">Added ✓</span>'
          : p.phone
            ? `<button class="btn primary sm" data-add="${i}" type="button">Add</button>`
            : '<span class="muted small">No phone</span>';
        return `
      <li>
        <div class="info">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.phone || p.email || '')}</div>
        </div>
        ${button}
      </li>`;
      })
      .join('');
  } catch (err) {
    hint.textContent = 'Could not load the address book: ' + err.message;
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const p = bookPeople[Number(btn.dataset.add)];
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
    p.added = true;
    btn.outerHTML = '<span class="muted small">Added ✓</span>';
    loadContacts();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

boot();
