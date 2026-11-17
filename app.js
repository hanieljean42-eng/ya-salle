'use strict';

const SITES = ['Siège', 'Zinsou', 'Bluetooth', 'Bonoumin', 'Corniche'];
const TTL = 60 * 60 * 1000;
const KEYS = { users: 'iuaSalle.users', session: 'iuaSalle.session', reports: 'iuaSalle.reports', site: 'iuaSalle.site' };
const STATUS = { libre: 'Libre', occupee: 'Occupée' };

const LOGO = `
<svg class="logo-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <rect class="logo-bg" width="64" height="64" rx="16"/>
  <g class="logo-pin">
    <path class="logo-pin-shape" d="M32 60C28 55 9 41 9 27a23 23 0 0 1 46 0c0 14-19 28-23 33z"/>
    <rect class="logo-room" x="22" y="13" width="20" height="27" rx="3"/>
    <g class="logo-avatar"><circle cx="32" cy="23" r="4"/><path d="M25 40a7 8.5 0 0 1 14 0z"/></g>
    <g class="logo-door"><rect x="22" y="13" width="20" height="27" rx="3"/><circle class="logo-knob" cx="37.5" cy="27.5" r="1.8"/></g>
  </g>
</svg>`;

const $ = sel => document.querySelector(sel);
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const pseudoKey = p => p.trim().toLowerCase();
const normalizeRoom = raw => raw
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/^\s*SALLE\b/, '')
  .replace(/[^A-Z0-9-]/g, '')
  .slice(0, 12);

async function hashPin(key, pin) {
  const text = `iua-salle:${key}:${pin}`;
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

const state = { site: SITES.includes(load(KEYS.site, '')) ? load(KEYS.site, '') : SITES[0], filter: 'all', authMode: 'login', pending: null };

function currentUser() {
  const key = load(KEYS.session, null);
  return key ? load(KEYS.users, {})[key] ?? null : null;
}

function getReports() {
  const reports = load(KEYS.reports, []);
  const now = Date.now();
  const last = {};
  for (const r of reports) { const k = `${r.site}|${r.room}`; last[k] = Math.max(last[k] ?? 0, r.at); }
  const alive = reports.filter(r => now - last[`${r.site}|${r.room}`] < TTL);
  if (alive.length !== reports.length) save(KEYS.reports, alive);
  return alive;
}

function roomsFor(site, reports) {
  const groups = {};
  for (const r of reports) if (r.site === site) (groups[r.room] ??= []).push(r);
  return Object.entries(groups).map(([room, votes]) => {
    const free = votes.filter(v => v.status === 'libre').length;
    const busy = votes.length - free;
    const latest = votes.reduce((a, b) => (a.at > b.at ? a : b));
    const status = free > busy ? 'libre' : busy > free ? 'occupee' : latest.status;
    const until = votes.filter(v => v.status === status && v.until).sort((a, b) => b.at - a.at)[0]?.until ?? null;
    return { room, votes, status, until, lastAt: latest.at };
  }).sort((a, b) => (a.status === b.status ? a.room.localeCompare(b.room, 'fr', { numeric: true }) : a.status === 'libre' ? -1 : 1));
}

function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? "à l'instant" : `il y a ${m} min`;
}

function setSite(site) {
  state.site = site;
  save(KEYS.site, site);
  const key = load(KEYS.session, null);
  const users = load(KEYS.users, {});
  if (key && users[key] && users[key].site !== site) { users[key].site = site; save(KEYS.users, users); }
  render();
}

function renderAccount() {
  const user = currentUser();
  $('#account').innerHTML = user
    ? `<span class="user"><span class="avatar" aria-hidden="true">${esc(user.pseudo.slice(0, 2))}</span><span class="user-name">${esc(user.pseudo)}</span></span>
       <button class="btn ghost" type="button" id="logoutBtn">Quitter</button>`
    : `<button class="btn ghost" type="button" id="loginBtn">Connexion</button>`;
}

function renderSites(reports) {
  $('#sites').innerHTML = SITES.map(site => {
    const free = roomsFor(site, reports).filter(r => r.status === 'libre').length;
    return `<button type="button" class="site" data-site="${esc(site)}" aria-pressed="${site === state.site}">
      ${esc(site)}${free ? `<span class="site-count" aria-label="${plural(free, 'salle libre')}">${free}</span>` : ''}
    </button>`;
  }).join('');
}

function renderRooms(reports) {
  const user = currentUser();
  const me = user ? pseudoKey(user.pseudo) : null;
  const all = roomsFor(state.site, reports);
  const list = state.filter === 'libre' ? all.filter(r => r.status === 'libre') : all;
  const free = all.filter(r => r.status === 'libre').length;

  $('#summary').textContent = all.length ? `${state.site} : ${free} libre${free > 1 ? 's' : ''} sur ${plural(all.length, 'salle signalée')}` : '';
  $('#rooms').innerHTML = list.map(r => {
    const mine = me ? r.votes.find(v => v.user === me)?.status : null;
    const until = r.until ? `<span class="room-until">jusqu'à ${esc(r.until)}</span> · ` : '';
    return `<li class="room is-${r.status}">
      <div class="room-head">
        <span class="room-name">${esc(r.room)}</span>
        <span class="badge ${r.status}">${STATUS[r.status]}</span>
      </div>
      <p class="room-meta">${until}${plural(r.votes.length, 'signalement')} · ${ago(r.lastAt)}</p>
      <div class="room-actions">
        ${Object.entries(STATUS).map(([value, label]) => `<button type="button" class="vote" data-room="${esc(r.room)}" data-status="${value}" aria-pressed="${mine === value}">${label}</button>`).join('')}
      </div>
    </li>`;
  }).join('');

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  empty.textContent = all.length
    ? 'Aucune salle libre signalée pour le moment sur ce site.'
    : `Aucune salle signalée à ${state.site} dans la dernière heure. Sois le premier à en signaler une.`;
}

function render() {
  const reports = getReports();
  renderAccount();
  renderSites(reports);
  renderRooms(reports);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const siteOptions = selected => SITES.map(s => `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('');

/* Compte */
function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('#authDialog [role="tab"]').forEach(tab => tab.setAttribute('aria-selected', tab.dataset.tab === mode));
  $('#siteField').hidden = mode !== 'signup';
  $('#authSubmit').textContent = mode === 'signup' ? "S'inscrire" : 'Se connecter';
  $('#authForm').pin.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}

function openAuth(note = '', pending = null) {
  state.pending = pending;
  const form = $('#authForm');
  form.reset();
  form.site.innerHTML = siteOptions(state.site);
  $('#authNote').textContent = note;
  $('#authNote').hidden = !note;
  setAuthMode('login');
  $('#authDialog').showModal();
  form.pseudo.focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.target;
  const pseudo = form.pseudo.value.trim();
  const pin = form.pin.value.trim();
  const error = $('#authError');
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(pseudo)) return (error.textContent = 'Pseudo : 3 à 20 caractères (lettres, chiffres, - ou _).');
  if (!/^\d{4}$/.test(pin)) return (error.textContent = 'Le code PIN doit contenir exactement 4 chiffres.');

  const key = pseudoKey(pseudo);
  const users = load(KEYS.users, {});
  const hash = await hashPin(key, pin);

  if (state.authMode === 'signup') {
    if (users[key]) return (error.textContent = 'Ce pseudo est déjà pris.');
    users[key] = { pseudo, pin: hash, site: SITES.includes(form.site.value) ? form.site.value : SITES[0] };
    save(KEYS.users, users);
  } else if (!users[key] || users[key].pin !== hash) {
    return (error.textContent = 'Pseudo ou code PIN incorrect.');
  }

  save(KEYS.session, key);
  $('#authDialog').close();
  toast(`Bienvenue ${users[key].pseudo}`);
  setSite(users[key].site);
  if (state.pending) openReport(state.pending);
}

/* Signalement */
function openReport(prefill = {}) {
  if (!currentUser()) return openAuth('Connecte-toi pour signaler une salle.', prefill);
  state.pending = null;
  const form = $('#reportForm');
  form.reset();
  form.site.innerHTML = siteOptions(prefill.site ?? state.site);
  form.room.value = prefill.room ?? '';
  if (prefill.status) form.status.value = prefill.status;
  $('#reportError').textContent = '';
  updateRoomHelpers();
  $('#reportDialog').showModal();
  (prefill.room ? form.until : form.room).focus();
}

function updateRoomHelpers() {
  const form = $('#reportForm');
  const room = normalizeRoom(form.room.value);
  $('#roomPreview').textContent = room && room !== form.room.value.trim() ? `Enregistrée comme : ${room}` : '';
  $('#roomSuggestions').innerHTML = roomsFor(form.site.value, getReports()).map(r => `<option value="${esc(r.room)}">`).join('');
}

function submitReport(e) {
  e.preventDefault();
  const user = currentUser();
  if (!user) return $('#reportDialog').close(), openAuth('Connecte-toi pour signaler une salle.');
  const form = e.target;
  const site = SITES.includes(form.site.value) ? form.site.value : state.site;
  const room = normalizeRoom(form.room.value);
  const status = form.status.value in STATUS ? form.status.value : 'libre';
  const until = /^\d{2}:\d{2}$/.test(form.until.value) ? form.until.value : null;
  if (!room) return ($('#reportError').textContent = 'Indiquez le nom ou le numéro de la salle.');

  const me = pseudoKey(user.pseudo);
  const reports = getReports().filter(r => !(r.site === site && r.room === room && r.user === me));
  reports.push({ site, room, user: me, status, until, at: Date.now() });
  save(KEYS.reports, reports);

  $('#reportDialog').close();
  toast(`Salle ${room} signalée ${STATUS[status].toLowerCase()}`);
  setSite(site);
}

/* Événements */
document.querySelectorAll('[data-logo]').forEach(el => { el.innerHTML = LOGO; });

$('#sites').addEventListener('click', e => {
  const btn = e.target.closest('[data-site]');
  if (btn) setSite(btn.dataset.site);
});

$('#rooms').addEventListener('click', e => {
  const btn = e.target.closest('.vote');
  if (btn) openReport({ site: state.site, room: btn.dataset.room, status: btn.dataset.status });
});

$('#account').addEventListener('click', e => {
  if (e.target.closest('#loginBtn')) openAuth();
  if (e.target.closest('#logoutBtn')) { localStorage.removeItem(KEYS.session); render(); toast('Tu es déconnecté'); }
});

document.querySelector('.filter').addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', b === btn));
  render();
});
$('#reportBtn').addEventListener('click', () => openReport());
$('#authDialog [role="tablist"]').addEventListener('click', e => { const tab = e.target.closest('[data-tab]'); if (tab) setAuthMode(tab.dataset.tab); });
$('#authForm').addEventListener('submit', submitAuth);
$('#authForm').pin.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
$('#reportForm').addEventListener('submit', submitReport);
$('#reportForm').room.addEventListener('input', updateRoomHelpers);
$('#reportForm').site.addEventListener('change', updateRoomHelpers);

document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', e => { if (e.target === dialog || e.target.closest('[data-close]')) dialog.close(); });
});

window.addEventListener('storage', render);
setInterval(render, 30000);
render();
