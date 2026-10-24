'use strict';
// Ladeplan: App-Logik. Alle Daten und Regeln liegen in Supabase (siehe supabase/schema.sql),
// die App zeigt sie an und ruft für jede Aktion eine Datenbank-Funktion auf.

const MIN = 60000, H = 60 * MIN, DAY = 86400000, GRACE = 15 * MIN, UNDO_MS = 5000;
const PREFS = [
  ['remind', 'Erinnerung vor meiner Reservierung', '15 Minuten vor Beginn'],
  ['ending', 'Ladezeit endet bald', '15 Minuten vor dem geplanten Ende'],
  ['expired', 'Reservierung verfallen oder überschrieben', 'Wenn niemand rechtzeitig eingesteckt hat oder jemand anderes lädt'],
  ['free', 'Eine Ladesäule ist frei geworden', 'Jedes Mal, wenn jemand seine Ladung beendet'],
];
const PLUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 10h2a2 2 0 0 1 2 2v3a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="m9.5 6.5-2 3.5h3l-2 3.5"/></svg>';
const MAIL_RE = /^[^@\s<>"']+@[^@\s<>"']+\.[^@\s<>"']+$/;
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// ---- Zustand ----
let session = null, meInfo = null, me = '', loginEmail = '';
let CHARGERS = [], people = new Map(), USERS = [];
let res = [], prefs = {}, watching = false, notes = [], unread = 0, adminList = null, pushOk = false;
let tab = 'home', planDay = 0, offline = !navigator.onLine, offlineAt = Date.now(), channel = null, booting = false;
const pending = new Map();      // Aktionen mit Rückgängig, die erst nach UNDO_MS gesendet werden
const pendingIds = new Set();   // Buchungen, die gerade lokal geändert sind

// ---- Hilfen ----
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const now = () => Date.now();
const fmt = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayDiff = t => Math.round((dayStart(t) - dayStart(now())) / DAY);
const dayLabel = t => { const d = dayDiff(t); if (d === 0) return 'heute'; if (d === 1) return 'morgen'; return new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' }); };
const when = t => dayDiff(t) === 0 ? fmt(t) : `${dayLabel(t)} ${fmt(t)}`;
const dur = ms => { const m = Math.max(0, Math.round(ms / MIN)); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`; };
const who = u => u === me ? 'Du' : u;
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const active = r => r.status === 'reserved' || r.status === 'charging';
const effEnd = r => r.status === 'charging' ? Math.max(r.end, now()) : r.end;
const round15 = t => Math.ceil(t / (15 * MIN)) * 15 * MIN;
const nameOf = pid => people.get(pid)?.name ?? 'Unbekannt';
const appIcon = s => `<img src="icons/icon-192.png" width="${s}" height="${s}" alt="" style="border-radius:${Math.round(s * 0.22)}px;flex:none">`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privater Modus */ } },
};
const norm = row => ({
  id: row.id, c: row.charger_id, pid: row.person_id, user: nameOf(row.person_id), status: row.status,
  start: Date.parse(row.starts_at), end: Date.parse(row.ends_at),
  doneAt: row.done_at ? Date.parse(row.done_at) : null, series: row.series_id,
});

// Datenbank-Funktion aufrufen; Fehlermeldungen kommen auf Deutsch aus schema.sql
async function call(fn, args = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}
function fail(e) { toast('Hat nicht geklappt', esc(e.message || e)); }

// ---- Anmeldung ----
function gate(html) {
  $('#gate').hidden = false; $('#app').hidden = true; $('#tabs').hidden = true;
  $('#gateBody').innerHTML = html;
}
// Anmeldung mit E-Mail und Passwort. Beim ersten Mal legt man ein Passwort fest und löst
// einmal den Startcode ein, den der Admin beim Eintragen bekommen hat (siehe update-01-passwort.sql).
function showLogin(msg, mode = 'login') {
  const reg = mode === 'register';
  gate(`<h1>${reg ? 'Zugang einrichten' : 'Anmelden'}</h1>
    <p>${reg ? 'Gib die E-Mail-Adresse ein, die der Admin für dich eingetragen hat, und wähle ein Passwort.' : 'Mit deiner E-Mail-Adresse und deinem Passwort.'}</p>
    <form id="${reg ? 'registerForm' : 'loginForm'}">
      <div class="field"><label for="l-mail">E-Mail-Adresse</label>
        <input id="l-mail" type="email" autocomplete="email" inputmode="email" required value="${esc(loginEmail || store.get('lastEmail') || '')}"></div>
      <div class="field"><label for="l-pass">${reg ? 'Neues Passwort (mindestens 8 Zeichen)' : 'Passwort'}</label>
        <input id="l-pass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 8 : 1}" required></div>
      ${msg ? `<div class="callout err">${msg}</div>` : ''}
      <button class="btn primary">${reg ? 'Weiter' : 'Anmelden'}</button>
      ${reg ? '<button type="button" class="linkbtn" data-act="toLogin">Ich habe schon ein Passwort</button>'
            : `<button type="button" class="linkbtn" data-act="toRegister">Zum ersten Mal hier? Zugang einrichten</button>
               <button type="button" class="linkbtn" data-act="forgot" style="color:var(--muted);font-weight:600">Passwort vergessen?</button>`}
    </form>`);
}
function showClaim(msg) {
  gate(`<h1>Startcode eingeben</h1>
    <p>Einmalig: Gib den 6-stelligen Startcode ein, den du vom Admin bekommen hast.</p>
    <form id="claimForm">
      <div class="field"><label for="l-code">Startcode</label>
        <input id="l-code" class="code-input" inputmode="numeric" autocomplete="off" maxlength="6" required></div>
      ${msg ? `<div class="callout err">${msg}</div>` : ''}
      <button class="btn primary">Bestätigen</button>
      <button type="button" class="linkbtn" data-act="logout">Abmelden</button>
    </form>`);
  $('#l-code').focus();
}

document.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('.btn.primary');
  if (btn) btn.disabled = true;
  if (e.target.id === 'loginForm' || e.target.id === 'registerForm') {
    const reg = e.target.id === 'registerForm';
    const email = $('#l-mail').value.trim().toLowerCase(), password = $('#l-pass').value;
    loginEmail = email; store.set('lastEmail', email);
    if (reg) {
      const { data, error } = await db.auth.signUp({ email, password });
      if (error) {
        return showLogin(/registered|exists/i.test(error.message)
          ? 'Für diese E-Mail-Adresse gibt es schon ein Passwort. Melde dich an oder bitte den Admin, deinen Zugang zurückzusetzen.'
          : /email signups are disabled/i.test(error.message)
          ? 'Anmeldung per E-Mail ist in Supabase ausgeschaltet. Der Admin muss bei „Email“ den Schalter „Enable Email provider“ einschalten.'
          : /signups? .*(disabled|not allowed)/i.test(error.message)
          ? 'Neue Zugänge sind gerade gesperrt. Der Admin muss in Supabase „Allow new users to sign up“ einschalten.'
          : /password/i.test(error.message) ? 'Das Passwort ist zu kurz oder zu einfach. Nimm mindestens 8 Zeichen.' : esc(error.message), 'register');
      }
      if (!data.session) return showLogin('Die Anmeldung ist noch nicht fertig eingerichtet: In Supabase muss „Confirm email“ ausgeschaltet sein.', 'register');
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) return showLogin(
        /not confirmed/i.test(error.message)
          ? 'Dieser Zugang wurde angelegt, als die E-Mail-Bestätigung noch an war. Der Admin muss ihn in Supabase unter Authentication → Users löschen. Danach „Zugang einrichten“ noch einmal.'
          : /invalid/i.test(error.message) ? 'E-Mail-Adresse oder Passwort stimmt nicht.' : esc(error.message));
    }
    // Bei Erfolg startet onAuthStateChange die App
  }
  if (e.target.id === 'claimForm') {
    try { await call('claim_access', { code: $('#l-code').value.replace(/\D/g, '') }); boot(); }
    catch (x) { showClaim(esc(x.message)); }
  }
});

db.auth.onAuthStateChange((event, s) => {
  session = s;
  // Supabase-Aufrufe nicht direkt im Callback ausführen, sonst kann der Login hängen bleiben
  setTimeout(() => {
    if (event === 'SIGNED_OUT' || !s) { teardown(); showLogin(); }
    else if (!meInfo && !booting) boot();
  }, 0);
});

async function boot() {
  booting = true;
  gate('<div class="spinner" role="status" aria-label="Lädt"></div>');
  try {
    meInfo = await call('whoami');
    if (!meInfo) { showClaim(); return; }
    await loadAll();
    subscribe();
    await checkPush();
    $('#gate').hidden = true; $('#app').hidden = false; $('#tabs').hidden = false;
    render();
    if (!store.get(`onboarded:${meInfo.id}`)) openOnboard();
  } catch (e) {
    meInfo = null;
    gate(`<h1>Keine Verbindung</h1><p>${esc(e.message)}</p><button class="btn primary" data-act="retry">Nochmal versuchen</button>`);
  } finally { booting = false; }
}
function teardown() {
  channel?.unsubscribe(); channel = null;
  meInfo = null; me = ''; res = []; adminList = null; closeSheet();
}

// ---- Daten laden und live halten ----
async function loadAll() {
  const since = new Date(now() - 7 * DAY).toISOString();
  const [p, c, r, pr, w, n] = await Promise.all([
    db.from('people').select('id, name, is_admin, active'),
    db.from('chargers').select('id, name').order('id'),
    db.from('reservations').select('*').or(`ends_at.gte.${since},status.in.(reserved,charging)`).order('starts_at'),
    db.from('prefs').select('*').maybeSingle(),
    db.from('watchers').select('person_id').maybeSingle(),
    db.from('notifications').select('id, body, created_at').order('id', { ascending: false }).limit(30),
  ]);
  for (const x of [p, c, r, pr, w, n]) if (x.error) throw new Error(x.error.message);
  people = new Map(p.data.map(x => [x.id, { ...x, name: esc(x.name) }]));
  USERS = p.data.filter(x => x.active).map(x => esc(x.name)).sort((a, b) => a.localeCompare(b, 'de'));
  CHARGERS = c.data.map(x => x.id);
  document.documentElement.style.setProperty('--cols', CHARGERS.length);
  res = r.data.map(norm).filter(x => !pendingIds.has(x.id)).concat(res.filter(x => pendingIds.has(x.id)));
  prefs = pr.data || {};
  watching = !!w.data;
  notes = n.data;
  const seen = +(store.get(`seen:${meInfo.id}`) || 0);
  unread = notes.filter(x => Date.parse(x.created_at) > seen).length;
  const mine = p.data.find(x => x.id === meInfo.id);
  if (mine) { me = esc(mine.name); meInfo.name = mine.name; meInfo.is_admin = mine.is_admin; }
}
async function refresh() {
  if (!meInfo) return;
  try { await loadAll(); setOffline(false); } catch { setOffline(true); }
  render();
}
function subscribe() {
  channel?.unsubscribe();
  channel = db.channel('ladeplan')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') { res = res.filter(x => x.id !== old.id); render(); return; }
      if (pendingIds.has(row.id)) return;
      const v = norm(row), i = res.findIndex(x => x.id === v.id);
      if (i < 0) res.push(v); else res[i] = v;
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'watchers' }, () => refresh())
    .subscribe(status => {
      if (status === 'SUBSCRIBED') { if (offline) refresh(); else setOffline(false); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setOffline(true);
    });
}
function setOffline(v) {
  if (v && !offline) offlineAt = now();
  if (v !== offline) { offline = v; render(); }
}
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => { refresh(); subscribe(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) [...pending.keys()].forEach(flush);
  else refresh();
});
window.addEventListener('pagehide', () => [...pending.keys()].forEach(flush));

// Aktion mit Rückgängig: sofort anzeigen, erst nach 5 Sekunden an die Datenbank senden
function deferred(key, ids, apply, revert, commit, head, text) {
  ids.forEach(id => pendingIds.add(id));
  apply(); closeSheet(); render();
  const timer = setTimeout(() => flush(key), UNDO_MS);
  pending.set(key, { ids, commit, timer });
  toast(head, text, () => {
    clearTimeout(timer); pending.delete(key); ids.forEach(id => pendingIds.delete(id));
    revert(); render();
  });
}
async function flush(key) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key); clearTimeout(p.timer);
  try { await p.commit(); } catch (e) { fail(e); }
  p.ids.forEach(id => pendingIds.delete(id));
  refresh();
}

// ---- Push-Nachrichten ----
const b64uToBytes = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, ch => ch.charCodeAt(0)); };
async function checkPush() {
  pushOk = false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { pushOk = true; await saveSub(sub); }
}
async function saveSub(sub) {
  const j = sub.toJSON();
  const { error } = await db.from('push_subscriptions').upsert(
    { person_id: meInfo.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw new Error(error.message);
}
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Geht hier nicht', IS_IOS ? 'Füge die App erst über Safari zum Home-Bildschirm hinzu und öffne sie von dort.' : 'Dieser Browser kann keine Push-Nachrichten empfangen.');
    return false;
  }
  if (!CONFIG.VAPID_PUBLIC_KEY) { toast('Noch nicht eingerichtet', 'Push-Nachrichten werden gerade noch eingerichtet.'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Nicht erlaubt', 'Du kannst Push-Nachrichten später in den Handy-Einstellungen erlauben.'); return false; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(CONFIG.VAPID_PUBLIC_KEY) });
    await saveSub(sub);
    pushOk = true;
    toast('Erlaubt', 'Push-Nachrichten sind an.');
    return true;
  } catch (e) { fail(e); return false; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Offline-Modus weiter */ });

// ---- Anzeige ----
function toast(head, text, onUndo) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div><small>${head}</small>${text}</div>`;
  if (onUndo) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Rückgängig';
    b.addEventListener('click', () => { clearTimeout(t); el.remove(); onUndo(); });
    el.append(b);
  }
  $('#toasts').append(el);
  const t = setTimeout(() => el.remove(), onUndo ? UNDO_MS : 4800);
}

function state(c) {
  const n = now();
  const mine = res.filter(r => r.c === c);
  const charging = mine.find(r => r.status === 'charging');
  const waiting = mine.find(r => r.status === 'reserved' && r.start <= n);
  const next = mine.filter(r => r.status === 'reserved' && r.start > n).sort((a, b) => a.start - b.start)[0];
  // Als fertig markiert oder Ladezeit vorbei, aber nicht freigegeben: das Auto steht noch
  if (charging) return { kind: charging.doneAt || n > charging.end ? 'over' : 'busy', r: charging, next };
  if (waiting) return { kind: 'wait', r: waiting, next };
  return { kind: 'free', next };
}

function render() {
  if (!meInfo || $('#app').hidden) return;
  $('#greet').textContent = `Hallo ${meInfo.name}`;
  $('#hello').textContent = `${new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })} · ${fmt(now())} Uhr`;
  $('#bellN').hidden = !unread; $('#bellN').textContent = unread;
  $('#offline').hidden = !offline;
  $('#offlineText').innerHTML = `<b>Keine Verbindung.</b> Du siehst den Stand von <span class="mono">${fmt(offlineAt)}</span>. Laden und Reservieren geht wieder, sobald du online bist.`;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  const scroller = $('.tl-wrap'); const keep = scroller ? scroller.scrollTop : null;
  $('#view').innerHTML = ({ home: viewHome, plan: viewPlan, mine: viewMine, settings: viewSettings })[tab]();
  if (tab === 'plan') $('.tl-wrap').scrollTop = keep ?? (planDay === 0 ? Math.max(0, (now() - dayStart(now())) / H * 40 - 120) : 7 * 40);
}

function tile(c, s) {
  let lbl, t;
  if (s.kind === 'busy') { lbl = 'Belegt'; t = `bis ${fmt(s.r.end)}`; }
  else if (s.kind === 'over') { lbl = 'Steht'; t = `seit ${fmt(s.r.doneAt || s.r.end)}`; }
  else if (s.kind === 'wait') { lbl = 'Wartet'; t = `bis ${fmt(s.r.start + GRACE)}`; }
  else { lbl = 'Frei'; t = s.next && dayDiff(s.next.start) === 0 ? `bis ${fmt(s.next.start)}` : 'heute frei'; }
  return `<button type="button" class="tile ${s.kind}" data-act="jump" data-c="${c}" aria-label="Ladesäule ${c}: ${lbl}, ${t}"><span class="num">${c}</span><span class="lbl">${lbl}</span><span class="t">${t}</span></button>`;
}

function viewHome() {
  const st = CHARGERS.map(state);
  const free = st.filter(s => s.kind === 'free').length;
  const busy = st.filter(s => s.kind === 'busy').length, wait = st.filter(s => s.kind === 'wait').length, over = st.filter(s => s.kind === 'over').length;
  let watch = '';
  if (free === 0) watch = watching
    ? `<div class="watch on"><span>Du bekommst eine Push-Nachricht, sobald eine Säule frei wird.</span><button class="btn sm" data-act="unwatch">Abbrechen</button></div>`
    : `<div class="watch"><span>Gerade ist alles belegt.</span><button class="btn primary sm" data-act="watch">Sag mir Bescheid, wenn eine frei wird</button></div>`;
  return `<div style="display:flex;flex-direction:column;gap:14px">
    <div class="sumtext"><span class="big${free === 0 ? ' none' : ''}">${free}</span><div>${free === 0 ? 'Säulen frei, gerade ist alles belegt' : `von ${CHARGERS.length} Ladesäulen ${free === 1 ? 'ist' : 'sind'} frei`}
      <small>${[busy && `${busy} ${busy === 1 ? 'lädt' : 'laden'}`, wait && `${wait} ${wait === 1 ? 'wartet' : 'warten'} auf Einstecken`, over && `${over} ${over === 1 ? 'steht' : 'stehen'} nach dem Laden noch`].filter(Boolean).join(' · ')}</small></div></div>
    <div class="tiles">${st.map((s, i) => tile(CHARGERS[i], s)).join('')}</div>
    ${watch}
    ${st.map((s, i) => card(CHARGERS[i], s)).join('')}
  </div>`;
}

function card(c, s) {
  const n = now();
  let pill, main, sub, bar = '', acts = '';
  if (s.kind === 'busy' || s.kind === 'over') {
    const r = s.r, over = s.kind === 'over', own = r.user === me;
    pill = !over ? '<span class="pill busy">Belegt</span>'
         : `<span class="pill over">${r.doneAt ? 'Fertig, steht noch' : 'Zeit abgelaufen'}</span>`;
    if (!over) {
      main = `${who(r.user)} ${own ? 'lädst' : 'lädt'} seit <span class="mono">${fmt(r.start)}</span>`;
      sub = `bis ca. <b class="mono">${fmt(r.end)}</b> · noch ${dur(r.end - n)}`;
    } else if (r.doneAt) {
      main = own ? 'Du bist fertig, dein Auto steht noch' : `${r.user} ist fertig, das Auto steht noch`;
      sub = `Fertig seit <b class="mono">${fmt(r.doneAt)}</b>. ${own ? 'Bitte bald umparken und freigeben.' : 'Frei, sobald umgeparkt wird.'}`;
    } else {
      main = own ? 'Deine Ladezeit ist abgelaufen' : `Ladezeit von ${r.user} ist abgelaufen`;
      sub = `Ende war <b class="mono">${fmt(r.end)}</b>, seit ${dur(n - r.end)} nicht freigegeben. Das Auto steht vermutlich noch.`;
    }
    bar = `<div class="bar${over ? ' over' : ''}"><i style="width:${over ? 100 : Math.min(100, (n - r.start) / (r.end - r.start) * 100)}%"></i></div>`;
    if (own) acts = over
      ? `<button class="btn primary grow" data-act="release" data-id="${r.id}">Umgeparkt, Säule freigeben</button>`
      : `<button class="btn primary grow" data-act="release" data-id="${r.id}">Fertig, Säule freigeben</button>
         <button class="btn grow" data-act="markDone" data-id="${r.id}">Geladen, Auto steht noch</button>`;
  } else if (s.kind === 'wait') {
    const r = s.r;
    pill = '<span class="pill wait">Wartet auf Einstecken</span>';
    main = `${who(r.user)} ${r.user === me ? 'hast' : 'hat'} ab <span class="mono">${fmt(r.start)}</span> reserviert`;
    sub = `Verfällt um <b class="mono">${fmt(r.start + GRACE)}</b>, wenn niemand einsteckt · noch ${dur(r.start + GRACE - n)}`;
    bar = `<div class="bar wait"><i style="width:${Math.min(100, (n - r.start) / GRACE * 100)}%"></i></div>`;
    acts = r.user === me
      ? `<button class="btn primary grow" data-act="checkin" data-id="${r.id}">Ich lade jetzt</button>`
      : `<button class="btn grow" data-act="charge" data-c="${c}">Trotzdem laden</button>`;
  } else {
    pill = '<span class="pill free">Frei</span>';
    main = 'Jetzt verfügbar';
    sub = s.next ? `bis <b class="mono">${when(s.next.start)}</b>, dann ${s.next.user === me ? 'deine Reservierung' : `reserviert von ${s.next.user}`}` : 'Keine weiteren Reservierungen';
    const own = s.next && s.next.user === me && s.next.start - n <= GRACE;
    acts = own ? `<button class="btn primary grow" data-act="checkin" data-id="${s.next.id}">Ich lade jetzt (meine Reservierung)</button>`
               : `<button class="btn primary grow" data-act="charge" data-c="${c}">Jetzt laden</button>`;
  }
  const nextLine = s.kind !== 'free' && s.next ? `<p class="next">Danach reserviert: <b>${who(s.next.user)}</b> ab <span class="mono">${when(s.next.start)}</span></p>` : '';
  acts += `<button class="btn" data-act="reserve" data-c="${c}">Reservieren</button>`;
  return `<article class="card" id="card-${c}"><header><div class="ctitle"><span class="cicon ${s.kind}">${PLUG}</span><h2>Ladesäule ${c}</h2></div>${pill}</header>
    <p class="main">${main}</p><p class="sub">${sub}</p>${bar}${nextLine}<div class="actions">${acts}</div></article>`;
}

function viewPlan() {
  const ds = dayStart(now()) + planDay * DAY, de = ds + DAY;
  let days = '';
  for (let d = 0; d < 14; d++) {
    const t = dayStart(now()) + d * DAY;
    const label = d === 0 ? 'Heute' : d === 1 ? 'Morgen' : new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
    days += `<button class="chip" data-act="day" data-d="${d}" aria-pressed="${d === planDay}">${label}</button>`;
  }
  let hours = '';
  for (let h = 1; h < 24; h++) hours += `<span style="top:${h * 40}px">${String(h).padStart(2, '0')}:00</span>`;
  const cols = CHARGERS.map(c => {
    const blocks = res.filter(r => r.c === c && ['reserved', 'charging', 'done'].includes(r.status) && r.start < de && effEnd(r) > ds).map(r => {
      const s = Math.max(r.start, ds), e = Math.min(effEnd(r), de);
      const top = (s - ds) / H * 40, h = Math.max(22, (e - s) / H * 40);
      const cls = r.status === 'reserved' ? 'res' : r.status === 'charging' && (r.doneAt || now() > r.end) ? 'over' : r.status;
      return `<button type="button" class="blk ${cls}${r.user === me ? ' mine' : ''}" data-act="detail" data-id="${r.id}" style="top:${top}px;height:${h}px"><b>${who(r.user)}</b>${fmt(r.start)}–${fmt(r.end)}</button>`;
    }).join('');
    return `<div class="col" data-act="slot" data-c="${c}" title="Tippen zum Reservieren">${blocks}</div>`;
  }).join('');
  const nowline = planDay === 0 ? `<div class="nowline" style="top:${(now() - ds) / H * 40}px"></div>` : '';
  return `<div style="display:flex;flex-direction:column;gap:12px">
    <h2 class="section-h">Zeitplan</h2>
    <div class="days">${days}</div>
    <div class="legend"><span><i style="background:var(--busy)"></i>lädt</span><span><i style="background:var(--wait)"></i>Zeit abgelaufen</span><span><i style="background:var(--res)"></i>reserviert</span><span><i style="background:var(--done)"></i>beendet</span><span>Block antippen für Details, freie Stelle zum Reservieren</span></div>
    <div class="tl-head"><span></span>${CHARGERS.map(c => `<span>Säule ${c}</span>`).join('')}</div>
    <div class="tl-wrap"><div class="tl" style="height:960px"><div class="hours">${hours}</div>${cols}${nowline}</div></div>
  </div>`;
}

function viewMine() {
  const mine = res.filter(r => r.pid === meInfo.id);
  const up = mine.filter(active).sort((a, b) => a.start - b.start);
  const past = mine.filter(r => !active(r)).sort((a, b) => b.start - a.start).slice(0, 8);
  const label = { done: 'Beendet', expired: 'Verfallen', overridden: 'Überschrieben', cancelled: 'Storniert' };
  const rowsUp = up.map(r => `<div class="row"><div class="grow">
      <div class="t">Ladesäule ${r.c} · ${r.status === 'charging' ? (r.doneAt ? 'fertig, steht noch' : 'lädt gerade') : dayLabel(r.start)}${r.series ? '<span class="tag">wöchentlich</span>' : ''}</div>
      <div class="s mono">${fmt(r.start)}–${fmt(r.end)}</div></div>
      ${r.status === 'charging' ? `<button class="btn primary sm" data-act="release" data-id="${r.id}">Freigeben</button>`
        : `<div class="actions"><button class="btn sm" data-act="edit" data-id="${r.id}">Bearbeiten</button><button class="btn danger sm" data-act="cancel" data-id="${r.id}">Stornieren</button></div>`}</div>`).join('');
  const rowsPast = past.map(r => `<div class="row past"><div class="grow">
      <div class="t">Ladesäule ${r.c} · ${dayLabel(r.start)}</div><div class="s"><span class="mono">${fmt(r.start)}–${fmt(r.end)}</span> · ${label[r.status]}</div></div></div>`).join('');
  return `<div style="display:flex;flex-direction:column;gap:12px">
    <h2 class="section-h">Meine Ladezeiten</h2>
    <div class="list">${rowsUp || '<div class="empty">Keine Reservierungen. Auf „Säulen“ kannst du laden oder reservieren.</div>'}</div>
    ${rowsPast ? `<h3 class="muted" style="font-size:14px;margin-top:8px">Letzte 7 Tage</h3><div class="list">${rowsPast}</div>` : ''}
  </div>`;
}

function viewSettings() {
  const isAdmin = meInfo.is_admin;
  if (isAdmin && !adminList) loadAdmin();
  const list = isAdmin && adminList ? adminList : USERS.map(name => ({ name }));
  return `<div style="display:flex;flex-direction:column;gap:12px">
    <h2 class="section-h">Push-Nachrichten</h2>
    ${pushOk ? '<p class="muted">Wähle aus, worüber dich die App benachrichtigt.</p>'
      : `<div class="callout wait" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center"><span style="flex:1 1 200px">Push-Nachrichten sind auf diesem Handy noch nicht erlaubt. Bis dahin bekommst du keine Benachrichtigungen.</span><button class="btn primary sm" data-act="allowPush">Erlauben</button></div>`}
    ${PREFS.map(([k, t, s]) => `<label class="setting" for="p-${k}"><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div>
      <input type="checkbox" role="switch" class="switch" id="p-${k}" data-pref="${k}" ${prefs[k] ? 'checked' : ''}></label>`).join('')}
    <div class="note"><b>iPhone:</b> Push-Nachrichten funktionieren nur, wenn die App in Safari über „Teilen → Zum Home-Bildschirm“ hinzugefügt wurde. Auf Android geht es direkt in Chrome.</div>
    <button class="btn" data-act="onboard">Einrichtung erneut starten</button>

    <h2 class="section-h" style="margin-top:16px">Personen</h2>
    ${isAdmin ? '<p class="muted">Du bist Admin. Du kannst Personen hinzufügen, ändern und entfernen. Neue Personen melden sich mit der hier eingetragenen E-Mail-Adresse an.</p>'
      : `<p class="muted">${USERS.length} Personen haben Zugang. Neue Personen trägt ein Admin ein.</p>`}
    ${isAdmin && !adminList ? '<div class="spinner"></div>' : `<div class="list">${list.map(u => {
      const name = isAdmin ? esc(u.name) : u.name;
      return `<div class="row"><span class="avatar" aria-hidden="true">${name.charAt(0)}</span><div class="grow">
        <div class="t">${name}${name === me ? ' <span class="muted" style="font-weight:600">(du)</span>' : ''}${(isAdmin ? u.is_admin : [...people.values()].some(p => p.name === name && p.is_admin)) ? '<span class="tag admin">Admin</span>' : ''}</div>
        ${isAdmin ? `<div class="s">${esc(u.email) || 'E-Mail-Adresse fehlt noch'}</div>
          ${!u.auth_uid && u.email ? `<div class="s">Noch nicht eingerichtet · Startcode <b class="mono" style="color:var(--ink);letter-spacing:.1em">${esc(u.invite_code)}</b></div>` : ''}` : ''}</div>
        ${isAdmin ? `<div class="actions"><button class="btn sm" data-act="editUser" data-pid="${u.id}">Bearbeiten</button>${u.id === meInfo.id ? '' : `<button class="btn danger sm" data-act="askRemove" data-pid="${u.id}">Entfernen</button>`}</div>` : ''}</div>`;
    }).join('')}</div>`}
    ${isAdmin ? `<div class="adduser">
      <div class="t" style="font-weight:700">Person hinzufügen</div>
      <div class="fields">
        <div class="field"><label for="u-name">Name</label><input id="u-name" autocomplete="off" placeholder="z. B. Sarah"></div>
        <div class="field"><label for="u-mail">E-Mail</label><input id="u-mail" type="email" autocomplete="off" placeholder="name@firma.de"></div>
      </div>
      <div id="u-msg"></div>
      <button class="btn primary" data-act="addUser">Hinzufügen</button>
    </div>` : ''}

    <p class="muted" style="font-size:13px;margin-top:16px">Angemeldet als ${esc(session.user.email)}</p>
    <button class="btn" data-act="logout">Abmelden</button>
  </div>`;
}
async function loadAdmin() {
  try { adminList = await call('admin_people'); } catch (e) { fail(e); adminList = []; }
  if (tab === 'settings') render();
}

// ---- Bottom Sheets ----
function sheet(html) {
  // Ein offenes Sheet wird nur neu befüllt, damit die Einblend-Animation nicht bei jedem Tipp neu startet
  const open = $('.sheet');
  if (open) open.innerHTML = html;
  else $('#sheetRoot').innerHTML = `<div class="overlay" data-act="close"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $('.sheet .btn.primary, .sheet input, .sheet select, .sheet button'); if (f) f.focus({ preventScroll: true });
}
const closeSheet = () => { $('#sheetRoot').innerHTML = ''; };

let chargeDraft = null;
function openCharge(c) {
  const n = now(), s = state(c);
  const override = s.kind === 'wait' && s.r.user !== me ? s.r : null;
  const future = res.filter(r => r.c === c && r.status === 'reserved' && r.start > n).sort((a, b) => a.start - b.start)[0];
  const cap = future ? future.start : null;
  const fits = [30, 60, 120, 180, 240].map(m => m * MIN).filter(o => !cap || n + o <= cap);
  chargeDraft = { c, override, cap, futureR: future, len: fits.length ? fits[Math.min(fits.length - 1, 2)] : (cap ? cap - n : null) };
  drawCharge();
}
function drawCharge() {
  const { c, override, cap, futureR, len } = chargeDraft, n = now();
  const opts = [30, 60, 120, 180, 240].map(m => m * MIN);
  let chips = opts.map(o => `<button class="chip" data-act="len" data-len="${o}" aria-pressed="${o === len}" ${cap && n + o > cap ? 'disabled' : ''}>${dur(o)}</button>`).join('');
  if (cap && !opts.includes(cap - n) && cap - n >= 15 * MIN) chips += `<button class="chip" data-act="len" data-len="${cap - n}" aria-pressed="${cap - n === len}">bis ${fmt(cap)}</button>`;
  const tooShort = cap && cap - n < 15 * MIN;
  sheet(`<h3>Ladesäule ${c}: jetzt laden</h3>
    ${override ? `<div class="callout wait"><b>${override.user}</b> hat ab ${fmt(override.start)} reserviert, aber noch nicht eingesteckt. Wenn du lädst, wird die Reservierung überschrieben und ${override.user} bekommt eine Push-Nachricht.</div>` : ''}
    ${cap ? `<div class="callout info">${who(futureR.user)} ${futureR.user === me ? 'hast' : 'hat'} ab <b class="mono">${when(cap)}</b> reserviert. Bis dahin musst du fertig sein.</div>` : ''}
    ${tooShort ? `<div class="callout err">Bis zur nächsten Reservierung sind es nur ${dur(cap - n)}. Laden ist gerade nicht möglich.</div>` : `
    <div class="field">Wie lange ungefähr?<div class="chips">${chips}</div></div>
    <p class="muted">Geplantes Ende: <b class="mono">${fmt(n + len)}</b></p>`}
    <div class="actions"><button class="btn" data-act="close">Abbrechen</button>
      <button class="btn primary grow" data-act="startCharge" ${tooShort ? 'disabled' : ''}>${override ? 'Überschreiben und laden' : 'Laden starten'}</button></div>`);
}

let reserveDraft = null;
function openReserve(c, startT, editId) {
  const ed = editId ? res.find(r => r.id === editId) : null;
  const n = now();
  const s = ed ? ed.start : (startT ?? round15(n + 30 * MIN));
  const e = ed ? ed.end : s + 2 * H;
  reserveDraft = { editId: ed ? ed.id : null, skipOk: false };
  sheet(`<h3>${ed ? 'Reservierung ändern' : 'Reservieren'}</h3>
    <div class="field"><label for="r-c">Ladesäule</label><select id="r-c">${CHARGERS.map(x => `<option value="${x}" ${x === (ed ? ed.c : c) ? 'selected' : ''}>Ladesäule ${x}</option>`).join('')}</select></div>
    <div class="field"><label for="r-d">Datum</label><input type="date" id="r-d" value="${ymd(s)}" min="${ymd(n)}"></div>
    <div class="fields">
      <div class="field"><label for="r-s">Von</label><input type="time" id="r-s" value="${fmt(s)}" step="900"></div>
      <div class="field"><label for="r-e">Bis</label><input type="time" id="r-e" value="${fmt(e)}" step="900"></div>
    </div>
    ${ed ? (ed.series ? '<p class="muted">Gehört zu einer wöchentlichen Serie. Die Änderung gilt nur für diesen Termin.</p>' : '') : `
    <div class="field"><label for="r-w">Wiederholen</label><select id="r-w">
      <option value="1">Nicht wiederholen</option><option value="4">Jede Woche, 4 Wochen lang</option>
      <option value="8">Jede Woche, 8 Wochen lang</option><option value="12">Jede Woche, 12 Wochen lang</option></select></div>`}
    <div id="r-msg"></div>
    <div class="actions"><button class="btn" data-act="close">Abbrechen</button><button class="btn primary grow" id="r-save" data-act="saveReserve">${ed ? 'Speichern' : 'Reservieren'}</button></div>`);
}
async function saveReserve() {
  const ed = reserveDraft.editId;
  const c = +$('#r-c').value, d = $('#r-d').value;
  const weeks = ed ? 1 : +$('#r-w').value;
  const s = new Date(`${d}T${$('#r-s').value}`).getTime();
  let e = new Date(`${d}T${$('#r-e').value}`).getTime();
  const msg = (t, kind = 'err') => { $('#r-msg').innerHTML = `<div class="callout ${kind}">${t}</div>`; };
  if (isNaN(s) || isNaN(e)) return msg('Bitte Datum und Uhrzeit ausfüllen.');
  if (e <= s) e += DAY; // über Mitternacht
  const args = { c, starts: new Date(s).toISOString(), ends: new Date(e).toISOString() };
  const btn = $('#r-save'); btn.disabled = true;
  try {
    if (ed) {
      await call('update_reservation', { rid: ed, ...args });
      toast('Geändert', `Ladesäule ${c}, ${dayLabel(s)} ${fmt(s)}–${fmt(e)}`);
    } else {
      if (weeks > 1 && !reserveDraft.skipOk) {
        const check = await call('reserve', { ...args, weeks, check_only: true });
        if (check.skipped.length) {
          reserveDraft.skipOk = true;
          msg(`An ${check.skipped.length === 1 ? 'einem Termin' : `${check.skipped.length} Terminen`} ist die Säule schon belegt (${check.skipped.map(x => dayLabel(Date.parse(x))).join(', ')}). ${check.skipped.length === 1 ? 'Dieser wird' : 'Diese werden'} übersprungen.`, 'wait');
          btn.textContent = `${check.created} Termine anlegen`; btn.disabled = false;
          return;
        }
      }
      const out = await call('reserve', { ...args, weeks, check_only: false });
      toast('Reserviert', weeks > 1 ? `Ladesäule ${c}, ${out.created}× wöchentlich ab ${dayLabel(s)}, ${fmt(s)}–${fmt(e)}` : `Ladesäule ${c}, ${dayLabel(s)} ${fmt(s)}–${fmt(e)}`);
    }
    closeSheet(); refresh();
  } catch (err) { msg(esc(err.message)); btn.disabled = false; }
}

function openDetail(r) {
  const n = now(), own = r.user === me;
  const st = { reserved: r.start <= n ? 'Wartet auf Einstecken' : 'Reserviert', charging: r.doneAt || n > r.end ? 'Fertig, Auto steht noch' : 'Lädt gerade', done: 'Beendet' }[r.status];
  let acts = '';
  if (own && r.status === 'reserved') {
    if (n >= r.start - GRACE && !['busy', 'over'].includes(state(r.c).kind)) acts += `<button class="btn primary grow" data-act="checkin" data-id="${r.id}">Ich lade jetzt</button>`;
    acts += `<button class="btn" data-act="edit" data-id="${r.id}">Bearbeiten</button><button class="btn danger" data-act="cancel" data-id="${r.id}">Stornieren</button>`;
  }
  if (own && r.status === 'charging') {
    acts += `<button class="btn primary grow" data-act="release" data-id="${r.id}">Fertig, Säule freigeben</button>`;
    if (!r.doneAt && n <= r.end) acts += `<button class="btn" data-act="markDone" data-id="${r.id}">Geladen, Auto steht noch</button>`;
  }
  sheet(`<h3>Ladesäule ${r.c}</h3>
    <dl class="facts"><dt>Wer</dt><dd>${who(r.user)}</dd>
      <dt>Wann</dt><dd>${dayLabel(r.start)}, <span class="mono">${fmt(r.start)}–${fmt(r.end)}</span></dd>
      <dt>Status</dt><dd>${st}</dd>${r.series ? '<dt>Serie</dt><dd>Wöchentlich</dd>' : ''}</dl>
    <div class="actions">${acts}<button class="btn" data-act="close">Schließen</button></div>`);
}

function cancelIds(ids, label) {
  const list = res.filter(r => ids.includes(r.id));
  deferred(`cancel:${ids.join(',')}`, ids,
    () => list.forEach(r => { r.status = 'cancelled'; }),
    () => list.forEach(r => { r.status = 'reserved'; }),
    () => call('cancel_reservations', { ids }),
    'Storniert', label);
}
function release(r) {
  const prevEnd = r.end;
  deferred(`release:${r.id}`, [r.id],
    () => { r.status = 'done'; r.end = now(); },
    () => { r.status = 'charging'; r.end = prevEnd; },
    () => call('release', { rid: r.id }),
    'Freigegeben', `Ladesäule ${r.c} ist jetzt frei.`);
}

// ---- Einrichtung beim ersten Öffnen ----
let ob = { step: 0, device: IS_IOS ? 'ios' : 'android' };
function openOnboard() { ob.step = 0; drawOnboard(); }
function finishOnboard() { store.set(`onboarded:${meInfo.id}`, '1'); closeSheet(); render(); }
function drawOnboard() {
  const dots = `<div class="dots">${[0, 1, 2].map(i => `<i class="${i === ob.step ? 'on' : ''}"></i>`).join('')}</div>`;
  const head = t => `<div class="ob-head">${appIcon(52)}<div><div class="ob-step">Schritt ${ob.step + 1} von 3</div><h3>${t}</h3></div></div>`;
  if (ob.step === 0) sheet(`${head(`Willkommen, ${me}`)}
    <p>Hier siehst du, welche der ${CHARGERS.length} Ladesäulen frei sind, und kannst dir eine reservieren. Zwei kurze Schritte, dann geht es los.</p>
    ${dots}<div class="actions"><button class="btn primary grow" data-act="obNext">Weiter</button></div>`);
  if (ob.step === 1) {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const steps = ob.device === 'ios'
      ? ['Öffne den Ladeplan-Link in <b>Safari</b>.', 'Tippe unten auf <b>Teilen</b> (Quadrat mit Pfeil nach oben).', 'Wähle <b>Zum Home-Bildschirm</b> und tippe auf <b>Hinzufügen</b>.']
      : ['Öffne den Ladeplan-Link in <b>Chrome</b>.', 'Tippe oben rechts auf das <b>Drei-Punkte-Menü</b>.', 'Wähle <b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b>.'];
    sheet(`${head('Auf den Home-Bildschirm')}
      ${standalone ? '<div class="callout info">Erledigt: Du nutzt die App schon vom Home-Bildschirm.</div>' : `
      <div class="chips"><button class="chip" data-act="obDev" data-v="ios" aria-pressed="${ob.device === 'ios'}">iPhone</button><button class="chip" data-act="obDev" data-v="android" aria-pressed="${ob.device === 'android'}">Android</button></div>
      <ol class="steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      ${ob.device === 'ios' ? '<p class="muted" style="font-size:13px">Auf dem iPhone ist das nötig, damit Push-Nachrichten funktionieren. Danach meldest du dich in der App einmal neu an.</p>' : ''}`}
      ${dots}<div class="actions"><button class="btn" data-act="obBack">Zurück</button><button class="btn primary grow" data-act="obNext">Weiter</button></div>`);
  }
  if (ob.step === 2) sheet(`${head('Push-Nachrichten')}
    <p>Die App kann dich benachrichtigen, zum Beispiel:</p>
    <ul class="bullets">${PREFS.map(p => `<li>${p[1]}</li>`).join('')}</ul>
    <p class="muted" style="font-size:13px">Jede Nachricht kannst du später in den Einstellungen einzeln abschalten.</p>
    ${dots}<div class="actions"><button class="btn" data-act="obDone">Später</button><button class="btn primary grow" data-act="obAllow">Push-Nachrichten erlauben</button></div>`);
}

// ---- Personen bearbeiten (Admin) ----
let editPid = null;
function openUserEdit(pid) {
  const u = adminList.find(x => x.id === pid);
  editPid = pid;
  const lastAdmin = u.is_admin && adminList.filter(x => x.is_admin).length === 1;
  sheet(`<h3>${esc(u.name)} bearbeiten</h3>
    <div class="field"><label for="e-name">Name</label><input id="e-name" value="${esc(u.name)}" autocomplete="off"></div>
    <div class="field"><label for="e-mail">E-Mail</label><input id="e-mail" type="email" value="${esc(u.email || '')}" placeholder="name@firma.de" autocomplete="off"></div>
    <label class="setting flat" for="e-admin"><div class="grow"><div class="t">Admin</div><div class="s">Darf Personen hinzufügen, ändern und entfernen</div></div>
      <input type="checkbox" role="switch" class="switch" id="e-admin" ${u.is_admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}></label>
    ${lastAdmin ? '<p class="muted" style="font-size:13px">Es muss immer mindestens einen Admin geben. Mach zuerst eine andere Person zum Admin.</p>' : ''}
    <p class="muted" style="font-size:13px">Wird die E-Mail-Adresse geändert, bekommt die Person einen neuen Startcode und richtet ihren Zugang neu ein.</p>
    ${u.auth_uid && u.id !== meInfo.id ? `<button class="btn" data-act="askReset" data-pid="${u.id}">Zugang zurücksetzen (Passwort vergessen)</button>` : ''}
    <div id="e-msg"></div>
    <div class="actions"><button class="btn" data-act="close">Abbrechen</button><button class="btn primary grow" data-act="saveUser">Speichern</button></div>`);
}
async function afterPeopleChange(head, text) {
  closeSheet(); toast(head, text);
  await refresh();
  adminList = null; await loadAdmin();
}
// Nach dem Anlegen den Startcode groß zeigen, damit der Admin ihn weitergeben kann
function showStartCode(name, code, intro) {
  sheet(`<h3>Startcode für ${esc(name)}</h3>
    <p>${intro}</p>
    <p class="mono" style="font-size:40px;letter-spacing:.2em;text-align:center">${esc(code)}</p>
    <p class="muted" style="font-size:13px">${esc(name)} öffnet den Ladeplan, tippt auf „Zum ersten Mal hier? Zugang einrichten“, legt ein Passwort fest und gibt diesen Code ein. Du findest ihn auch später in der Personenliste.</p>
    <button class="btn primary" data-act="close">Fertig</button>`);
}

// ---- Klicks ----
const ONLINE_ACTS = new Set(['charge', 'reserve', 'startCharge', 'checkin', 'release', 'cancel', 'cancelOne', 'cancelSeries', 'slot', 'saveReserve', 'edit', 'watch', 'unwatch', 'addUser', 'askRemove', 'removeUser', 'editUser', 'saveUser', 'askReset', 'resetAccess', 'markDone', 'allowPush', 'obAllow']);

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act],[data-tab]');
  if (!el) return;
  if (el.dataset.tab) { tab = el.dataset.tab; window.scrollTo(0, 0); render(); return; }
  const act = el.dataset.act, id = +el.dataset.id, c = +el.dataset.c;
  if (act === 'close' && el.classList.contains('overlay') && e.target !== el) return; // Klick innerhalb des Sheets
  if (offline && ONLINE_ACTS.has(act)) { toast('Offline', 'Dafür brauchst du eine Internetverbindung.'); return; }
  const r = res.find(x => x.id === id);
  try {
    switch (act) {
      case 'close': closeSheet(); break;
      case 'retry': boot(); break;
      case 'toRegister': showLogin('', 'register'); break;
      case 'toLogin': showLogin(); break;
      case 'forgot':
        gate(`<h1>Passwort vergessen?</h1>
          <p>Kein Problem: Bitte den Admin, deinen Zugang zurückzusetzen. Du bekommst einen neuen Startcode und legst dann ein neues Passwort fest.</p>
          <button class="btn primary" data-act="toRegister">Ich habe einen neuen Startcode</button>
          <button type="button" class="linkbtn" data-act="toLogin">Zurück zur Anmeldung</button>`);
        break;
      case 'logout': await db.auth.signOut(); break;
      case 'jump': document.getElementById(`card-${c}`).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); break;
      case 'charge': openCharge(c); break;
      case 'reserve': openReserve(c); break;
      case 'edit': openReserve(r.c, null, r.id); break;
      case 'saveReserve': await saveReserve(); break;
      case 'detail': openDetail(r); break;
      case 'len': chargeDraft.len = +el.dataset.len; drawCharge(); break;
      case 'startCharge': {
        el.disabled = true;
        const { c, len } = chargeDraft;
        await call('start_charging', { c, minutes: Math.round(len / MIN) });
        closeSheet(); toast('Ladung gestartet', `Ladesäule ${c} bis ca. ${fmt(now() + len)}`); refresh(); break;
      }
      case 'checkin':
        await call('check_in', { rid: id });
        closeSheet(); toast('Ladung gestartet', `Ladesäule ${r.c} bis ca. ${fmt(r.end)}`); refresh(); break;
      case 'release': release(r); break;
      case 'markDone':
        await call('mark_done', { rid: id, done: true });
        closeSheet(); refresh();
        toast('Als fertig markiert', `Ladesäule ${r.c} ist jetzt gelb. Bitte bald umparken und freigeben.`,
          () => call('mark_done', { rid: id, done: false }).then(refresh, fail));
        break;
      case 'cancel': {
        const rest = r.series ? res.filter(x => x.series === r.series && x.status === 'reserved' && x.start >= r.start) : [];
        if (rest.length > 1) sheet(`<h3>Reservierung stornieren</h3>
          <p>Dieser Termin gehört zu einer wöchentlichen Serie (${rest.length} offene Termine ab ${dayLabel(r.start)}).</p>
          <div class="actions" style="flex-direction:column"><button class="btn danger" data-act="cancelOne" data-id="${r.id}">Nur ${dayLabel(r.start)}, ${fmt(r.start)} stornieren</button>
          <button class="btn danger" data-act="cancelSeries" data-id="${r.id}">Diesen und alle folgenden stornieren</button>
          <button class="btn" data-act="close">Abbrechen</button></div>`);
        else cancelIds([r.id], `Ladesäule ${r.c}, ${dayLabel(r.start)} ${fmt(r.start)}`);
        break;
      }
      case 'cancelOne': cancelIds([r.id], `Ladesäule ${r.c}, ${dayLabel(r.start)} ${fmt(r.start)}`); break;
      case 'cancelSeries': {
        const ids = res.filter(x => x.series === r.series && x.status === 'reserved' && x.start >= r.start).map(x => x.id);
        cancelIds(ids, `${ids.length} Termine an Ladesäule ${r.c}`); break;
      }
      case 'watch': await call('set_watch', { on_off: true }); watching = true; toast('Alles klar', 'Du bekommst eine Push-Nachricht, sobald eine Säule frei wird.'); render(); break;
      case 'unwatch': await call('set_watch', { on_off: false }); watching = false; render(); break;
      case 'day': planDay = +el.dataset.d; { const w = $('.tl-wrap'); if (w) w.remove(); } render(); break;
      case 'slot': {
        const y = e.clientY - el.getBoundingClientRect().top;
        const t = dayStart(now()) + planDay * DAY + Math.floor(y / 20) * 30 * MIN;
        openReserve(c, Math.max(t, round15(now()))); break;
      }
      case 'allowPush': if (await enablePush()) render(); break;
      case 'onboard': openOnboard(); break;
      case 'obDev': ob.device = el.dataset.v; drawOnboard(); break;
      case 'obNext': ob.step++; drawOnboard(); break;
      case 'obBack': ob.step--; drawOnboard(); break;
      case 'obAllow': await enablePush(); finishOnboard(); break;
      case 'obDone': finishOnboard(); toast('Fertig eingerichtet', 'Push-Nachrichten kannst du jederzeit in den Einstellungen erlauben.'); break;
      case 'addUser': {
        const name = $('#u-name').value.trim(), mail = $('#u-mail').value.trim();
        const err = t => { $('#u-msg').innerHTML = `<div class="callout err">${t}</div>`; };
        if (!name) return err('Bitte einen Namen eingeben.');
        if (!MAIL_RE.test(mail)) return err('Bitte eine gültige E-Mail-Adresse eingeben.');
        let pid;
        try { pid = await call('admin_save_person', { pid: null, p_name: name, p_email: mail, p_admin: false }); }
        catch (x) { return err(esc(x.message)); }
        await afterPeopleChange('Hinzugefügt', `${esc(name)} ist eingetragen.`);
        const added = adminList.find(x => x.id === pid);
        if (added) showStartCode(added.name, added.invite_code, `Gib ${esc(added.name)} diesen Code persönlich oder per Nachricht weiter.`);
        break;
      }
      case 'askReset': {
        const u = adminList.find(x => x.id === el.dataset.pid);
        sheet(`<h3>Zugang von ${esc(u.name)} zurücksetzen?</h3>
          <p>Das alte Passwort gilt danach nicht mehr. ${esc(u.name)} bekommt einen neuen Startcode und legt ein neues Passwort fest. Reservierungen bleiben erhalten.</p>
          <div class="actions"><button class="btn" data-act="close">Abbrechen</button><button class="btn danger grow" data-act="resetAccess" data-pid="${u.id}">Zurücksetzen</button></div>`);
        break;
      }
      case 'resetAccess': {
        const u = adminList.find(x => x.id === el.dataset.pid);
        const code = await call('admin_reset_access', { pid: u.id });
        await afterPeopleChange('Zurückgesetzt', `${esc(u.name)} kann jetzt ein neues Passwort festlegen.`);
        showStartCode(u.name, code, `Der alte Zugang ist gelöscht. Gib ${esc(u.name)} diesen neuen Code weiter.`);
        break;
      }
      case 'editUser': openUserEdit(el.dataset.pid); break;
      case 'saveUser': {
        const name = $('#e-name').value.trim(), mail = $('#e-mail').value.trim();
        const err = t => { $('#e-msg').innerHTML = `<div class="callout err">${t}</div>`; };
        if (mail && !MAIL_RE.test(mail)) return err('Bitte eine gültige E-Mail-Adresse eingeben.');
        try { await call('admin_save_person', { pid: editPid, p_name: name, p_email: mail || null, p_admin: $('#e-admin').checked }); }
        catch (x) { return err(esc(x.message)); }
        afterPeopleChange('Gespeichert', `Änderungen an ${esc(name)} gespeichert`); break;
      }
      case 'askRemove': {
        const u = adminList.find(x => x.id === el.dataset.pid);
        const open = res.filter(x => x.pid === u.id && active(x)).length;
        sheet(`<h3>${esc(u.name)} entfernen?</h3>
          <p>${esc(u.name)} kann den Ladeplan danach nicht mehr öffnen.${open ? ` ${open === 1 ? 'Eine offene Reservierung wird' : `${open} offene Reservierungen werden`} storniert.` : ''}</p>
          <div class="actions"><button class="btn" data-act="close">Abbrechen</button><button class="btn danger grow" data-act="removeUser" data-pid="${u.id}">Entfernen</button></div>`);
        break;
      }
      case 'removeUser': {
        const u = adminList.find(x => x.id === el.dataset.pid);
        await call('admin_remove_person', { pid: u.id });
        afterPeopleChange('Entfernt', `${esc(u.name)} hat keinen Zugang mehr.`); break;
      }
    }
  } catch (x) {
    fail(x); el.disabled = false;
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.pref) {
    const k = t.dataset.pref;
    const { error } = await db.from('prefs').update({ [k]: t.checked }).eq('person_id', meInfo.id);
    if (error) { t.checked = !t.checked; fail(error); return; }
    prefs[k] = t.checked;
    toast('Gespeichert', `${PREFS.find(p => p[0] === k)[1]}: ${t.checked ? 'an' : 'aus'}`);
  }
  if (t.id && t.id.startsWith('r-') && reserveDraft) {
    reserveDraft.skipOk = false; $('#r-msg').innerHTML = '';
    $('#r-save').textContent = reserveDraft.editId ? 'Speichern' : 'Reservieren';
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

$('#bell').addEventListener('click', () => {
  unread = 0; store.set(`seen:${meInfo.id}`, String(now())); render();
  sheet(`<h3>Deine Push-Nachrichten</h3>
    ${notes.length ? `<div class="list">${notes.map(p => `<div class="row"><div class="grow"><div class="s mono">${when(Date.parse(p.created_at))}</div><div>${esc(p.body)}</div></div></div>`).join('')}</div>`
      : '<div class="empty">Noch keine Nachrichten.</div>'}
    <button class="btn" data-act="close">Schließen</button>`);
});

// Einstellungen nicht automatisch neu zeichnen, sonst gehen halb getippte Eingaben verloren
setInterval(() => { if (tab !== 'settings' && !document.hidden) render(); }, 30000);
