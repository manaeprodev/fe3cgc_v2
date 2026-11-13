'use strict';

const app = document.getElementById('app');
const state = {
  config: null,       // config/game.json
  lang: 'fr',         // langue de l'interface
  me: null,           // { user, character, unread, claimable }
  avatars: [],        // fichiers présents dans assets/avatars
  authTab: 'login',
  step: 1,            // étape de création : 1 = personnage, 2 = faction
  draft: { pseudo: '', birthday: '', class: '', avatar: '', faction: '' },
  secretShown: false,
  tab: 'map',         // map | menu | notifs | missions | rules
  back: 'map',
  territories: [],
  selected: null,
  viewedTerritory: false,
  zoom: 1,
  players: [],
};

// ------------------------------------------------------------ Traductions
// Textes de l'interface : i18n/<langue>.json. Contenu du jeu (factions, classes, missions…) :
// config/game.json, où chaque texte peut être une chaîne ou un objet { "fr": "…", "en": "…" }.
const dicts = {};
let dict = {};
let fallbackDict = {};

async function loadDict(code) {
  if (!dicts[code]) dicts[code] = await fetch(`i18n/${encodeURIComponent(code)}.json`).then((r) => (r.ok ? r.json() : {}));
  return dicts[code];
}
const hasText = (key) => key in dict || key in fallbackDict;
function t(key, params) {
  const s = dict[key] ?? fallbackDict[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '') : s;
}
// Texte localisé venant de la config.
function loc(v) {
  if (v && typeof v === 'object') return v[state.lang] ?? v[state.config.defaultLang] ?? Object.values(v)[0] ?? '';
  return v ?? '';
}
const locale = () => state.config.languages.find((l) => l.code === state.lang)?.locale || state.lang;
const isLang = (code) => state.config.languages.some((l) => l.code === code);

function storedLang() {
  try { return localStorage.getItem('lang'); } catch { return null; }
}

async function setLang(code, { save = true } = {}) {
  if (!isLang(code)) return;
  try { dict = await loadDict(code); } catch { return; }
  state.lang = code;
  document.documentElement.lang = code;
  document.title = loc(state.config.title);
  if (save) {
    try { localStorage.setItem('lang', code); } catch { /* stockage indisponible */ }
    if (state.me) api('/lang', { lang: code }).catch(() => {});
  }
}

function langPicker() {
  return `<select class="lang" data-lang aria-label="${esc(t('lang.label'))}" title="${esc(t('lang.label'))}">
    ${state.config.languages.map((l) => `<option value="${esc(l.code)}" ${l.code === state.lang ? 'selected' : ''}>${esc(l.code.toUpperCase())}</option>`).join('')}
  </select>`;
}
function bindLang(root) {
  const sel = root.querySelector('[data-lang]');
  if (sel) sel.addEventListener('change', async () => { await setLang(sel.value); render(); });
}

// ------------------------------------------------------------ Utilitaires
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avatarUrl = (file) => 'assets/avatars/' + encodeURIComponent(file);
const faction = (id) => state.config.factions.find((f) => f.id === id);
const klass = (id) => state.config.classes.find((c) => c.id === id);
const className = (id) => loc(klass(id)?.name) || id;
const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
const fmtNum = (n) => Number(n).toLocaleString(locale());

async function api(path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error(t('error.network'));
  }
  let data = {};
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) {
    // Le serveur renvoie un code d'erreur, traduit ici.
    const key = 'error.' + data.error;
    const err = new Error(hasText(key) ? t(key) : t('error.generic'));
    err.status = res.status;
    throw err;
  }
  return data;
}

function showError(msg) {
  const el = app.querySelector('.error');
  if (el) el.textContent = msg || '';
}

// ------------------------------------------------------------ Aiguillage
function render() {
  const ch = state.me && state.me.character;
  document.body.style.setProperty('--faction', ch ? faction(ch.faction).color : 'var(--accent)');
  if (!state.me) return renderAuth();
  if (!ch) return state.step === 1 ? renderCharacter() : renderFaction();
  return renderGame();
}

// Après connexion : reprend la langue du compte si cet appareil n'en a pas encore choisi une.
async function signedIn(me) {
  state.me = me;
  if (!storedLang() && me.user.lang && me.user.lang !== state.lang) await setLang(me.user.lang);
  else if (me.user.lang !== state.lang) api('/lang', { lang: state.lang }).catch(() => {});
}

// ------------------------------------------------------------ Connexion / inscription
function renderAuth() {
  const login = state.authTab === 'login';
  app.innerHTML = `
    <div class="page">
      <div class="page-top">${langPicker()}</div>
      <div class="brand"><h1>${esc(loc(state.config.title))}</h1><p>${esc(t('app.tagline'))}</p></div>
      <div class="tabs">
        <button type="button" data-tab="login" class="${login ? 'active' : ''}">${esc(t('auth.login'))}</button>
        <button type="button" data-tab="register" class="${login ? '' : 'active'}">${esc(t('auth.register'))}</button>
      </div>
      <form novalidate>
        <label class="field"><span>${esc(t('auth.email'))}</span>
          <input type="email" name="email" autocomplete="email" inputmode="email" required></label>
        <label class="field"><span>${esc(t('auth.password'))}</span>
          <input type="password" name="password" autocomplete="${login ? 'current-password' : 'new-password'}" required></label>
        ${login ? '' : `
        <label class="field"><span>${esc(t('auth.passwordConfirm'))}</span>
          <input type="password" name="passwordConfirm" autocomplete="new-password" required></label>
        <p class="muted small">${esc(t('auth.passwordHint'))}</p>`}
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">${esc(t(login ? 'auth.submitLogin' : 'auth.submitRegister'))}</button>
      </form>
    </div>`;

  bindLang(app);
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.authTab = b.dataset.tab;
    renderAuth();
  }));

  app.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { email: String(f.get('email')).trim(), password: String(f.get('password')) };
    if (!body.email || !body.password) return showError(t('auth.fillAll'));
    if (!login) {
      body.passwordConfirm = String(f.get('passwordConfirm'));
      if (body.password.length < 8) return showError(t('error.password_short'));
      if (body.password !== body.passwordConfirm) return showError(t('error.password_mismatch'));
    }
    const btn = e.target.querySelector('.btn');
    btn.disabled = true;
    try {
      await signedIn(await api(login ? '/login' : '/register', body));
      state.step = 1;
      state.tab = 'map';
      render();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------ Création du personnage (étape 1)
function renderCharacter() {
  const d = state.draft;
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <div class="page">
      <div class="page-top"><div><p class="steps">${esc(t('char.step'))}</p><h1 class="page-title">${esc(t('char.title'))}</h1></div>${langPicker()}</div>
      <p class="notice">${esc(t('char.notice'))}</p>
      <form novalidate>
        <label class="field"><span>${esc(t('char.pseudo'))}</span>
          <input type="text" name="pseudo" maxlength="20" autocomplete="nickname" value="${esc(d.pseudo)}" required></label>
        <label class="field"><span>${esc(t('char.birthday'))}</span>
          <input type="date" name="birthday" min="1900-01-01" max="${today}" value="${esc(d.birthday)}" required></label>
        <div class="field"><span>${esc(t('char.class'))}</span>
          <div class="choices">
            ${state.config.classes.map((c) => `
              <button type="button" class="choice ${d.class === c.id ? 'selected' : ''}" data-class="${esc(c.id)}" aria-pressed="${d.class === c.id}">
                <strong>${esc(loc(c.name))}</strong><small>${esc(loc(c.description))}</small>
              </button>`).join('')}
          </div>
        </div>
        <div class="field"><span>${esc(t('char.avatar'))}</span>
          ${state.avatars.length ? `<div class="avatars">
            ${state.avatars.map((a, i) => `
              <button type="button" class="avatar-btn ${d.avatar === a ? 'selected' : ''}" data-avatar="${esc(a)}" aria-pressed="${d.avatar === a}" aria-label="${esc(t('char.avatarLabel', { n: i + 1 }))}">
                <img class="avatar" src="${avatarUrl(a)}" alt="">
              </button>`).join('')}
          </div>` : `<p class="muted small">${esc(t('char.noAvatar'))}</p>`}
        </div>
        <p class="error" role="alert"></p>
        <button class="btn" type="submit">${esc(t('char.continue'))}</button>
        <button class="btn ghost" type="button" data-logout>${esc(t('common.logout'))}</button>
      </form>
    </div>`;

  const form = app.querySelector('form');
  // Le brouillon suit la saisie, pour ne rien perdre en changeant de langue ou d'étape.
  form.pseudo.addEventListener('input', () => { d.pseudo = form.pseudo.value.trim(); });
  form.birthday.addEventListener('input', () => { d.birthday = form.birthday.value; });
  const pick = (attr, key) => app.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
    d[key] = b.dataset[attr];
    app.querySelectorAll(`[data-${attr}]`).forEach((o) => {
      const on = o === b;
      o.classList.toggle('selected', on);
      o.setAttribute('aria-pressed', on);
    });
  }));
  pick('class', 'class');
  pick('avatar', 'avatar');
  bindLang(app);
  app.querySelector('[data-logout]').addEventListener('click', logout);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    d.pseudo = form.pseudo.value.trim();
    d.birthday = form.birthday.value;
    if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(d.pseudo)) return showError(t('error.invalid_pseudo'));
    if (!d.birthday || d.birthday > today) return showError(t('char.needBirthday'));
    if (!d.class) return showError(t('char.pickClass'));
    if (!d.avatar) return showError(t('char.pickAvatar'));
    state.step = 2;
    render();
  });
}

// ------------------------------------------------------------ Choix de la faction (étape 2)
function renderFaction() {
  const d = state.draft;
  const visible = state.config.factions.filter((f) => !f.secret || state.secretShown);
  app.innerHTML = `
    <div class="page">
      <div class="page-top"><div><p class="steps">${esc(t('faction.step'))}</p><h1 class="page-title">${esc(t('faction.title'))}</h1></div>${langPicker()}</div>
      <div class="factions">
        ${visible.map((f) => `
          <button type="button" class="faction-card ${d.faction === f.id ? 'selected' : ''}" style="--c:${esc(f.color)}" data-faction="${esc(f.id)}" aria-pressed="${d.faction === f.id}">
            <img class="faction-logo" src="${esc(f.logo)}" alt="">
            <span><strong class="faction-name">${esc(loc(f.name))}</strong><span class="faction-desc">${esc(loc(f.description))}</span></span>
          </button>`).join('')}
      </div>
      <p class="error" role="alert"></p>
      <div class="row">
        <button class="btn ghost" type="button" data-back>${esc(t('common.back'))}</button>
        <button class="btn" type="button" data-confirm ${d.faction ? '' : 'disabled'}>${esc(t('faction.join'))}</button>
      </div>
      <p class="muted small">${esc(t('faction.final'))}</p>
      <div class="spacer"></div>
      ${state.secretShown ? '' : '<button type="button" class="secret-btn" data-secret aria-label="?" tabindex="-1">·</button>'}
    </div>`;

  bindLang(app);
  app.querySelectorAll('[data-faction]').forEach((b) => b.addEventListener('click', () => {
    d.faction = b.dataset.faction;
    renderFaction();
  }));
  app.querySelector('[data-back]').addEventListener('click', () => { state.step = 1; render(); });
  const secret = app.querySelector('[data-secret]');
  if (secret) secret.addEventListener('click', () => { state.secretShown = true; renderFaction(); });

  app.querySelector('[data-confirm]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      state.me = await api('/character', d);
      render();
    } catch (err) {
      showError(err.message);
      e.target.disabled = false;
    }
  });
}

// ------------------------------------------------------------ Jeu
// Onglets principaux : map, menu. Écrans secondaires : notifs, missions, rules.
const VIEWS = { map: renderMap, menu: renderMenu, notifs: renderNotifs, missions: renderMissions, rules: renderRules };

function go(tab) {
  if (state.tab === 'map' || state.tab === 'menu') state.back = state.tab;
  state.tab = tab;
  renderGame();
}

function renderGame() {
  const menuSide = state.tab === 'menu' || state.tab === 'rules';
  app.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <main class="view" id="view"></main>
    <nav class="tabbar">
      <button type="button" data-tab="map" class="${state.tab === 'map' ? 'active' : ''}">${esc(t('tab.map'))}</button>
      <button type="button" data-tab="menu" class="${menuSide ? 'active' : ''}">${esc(t('tab.menu'))}</button>
    </nav>`;
  app.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  drawTopbar();
  (VIEWS[state.tab] || renderMap)();
}

// Bandeau du haut : joueur, langue, cloche, parchemin, puis ressources (or et renommée).
function drawTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  const ch = state.me.character;
  const f = faction(ch.faction);
  const r = ch.renown;
  const badge = (n) => (n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
  const { unread, claimable } = state.me;
  bar.innerHTML = `
    <div class="topbar-row">
      <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
      <div class="who"><strong>${esc(ch.pseudo)}</strong>
        <span class="muted small">${esc(className(ch.class))} · <span style="color:${esc(f.color)}">${esc(loc(f.name))}</span></span></div>
      ${langPicker()}
      <button type="button" class="icon-btn ${state.tab === 'notifs' ? 'active' : ''}" data-go="notifs"
        aria-label="${esc(unread ? t('top.notifsUnread', { n: unread }) : t('top.notifs'))}">
        <img src="assets/ui/bell.svg" alt="">${badge(unread)}</button>
      <button type="button" class="icon-btn ${state.tab === 'missions' ? 'active' : ''}" data-go="missions"
        aria-label="${esc(claimable ? t('top.missionsClaimable', { n: claimable }) : t('top.missions'))}">
        <img src="assets/ui/missions.svg" alt="">${badge(claimable)}</button>
    </div>
    <div class="resources">
      <span class="res" title="${esc(t('res.gold'))}"><img src="assets/ui/gold.svg" alt="${esc(t('res.gold'))}"><strong>${fmtNum(ch.gold)}</strong></span>
      <span class="res grow" title="${esc(t('res.renown'))}"><img src="assets/ui/renown.svg" alt="${esc(t('res.renown'))}"><strong>${r.level}</strong>
        <span class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="${r.needed}" aria-valuenow="${r.xp}"
          aria-label="${esc(t('res.xpProgress'))}"><i style="width:${(r.xp / r.needed) * 100}%"></i></span>
        <small class="muted">${esc(t('res.xp', r))}</small></span>
    </div>`;
  bindLang(bar);
  bar.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(state.tab === b.dataset.go ? state.back || 'map' : b.dataset.go)));
}

// Met à jour le joueur (ressources, pastilles) à partir d'une réponse de l'API.
function setMe(me) {
  state.me = { user: me.user, character: me.character, unread: me.unread, claimable: me.claimable };
  // On ne redessine pas le bandeau pendant que le joueur manipule le sélecteur de langue.
  if (!document.activeElement || !document.activeElement.matches('#topbar [data-lang]')) drawTopbar();
}

async function refreshMe() {
  if (!state.me || !state.me.character) return;
  try { setMe(await api('/me')); } catch (err) { if (err.status === 401) sessionLost(); }
}

// Signale au serveur une action utile aux missions.
async function track(event) {
  try { setMe(await api('/events', { event })); } catch (err) { if (err.status === 401) sessionLost(); }
}

function panelHead(title) {
  return `<div class="panel-head"><h1 class="page-title">${esc(title)}</h1>
    <button type="button" class="btn ghost compact" data-close>${esc(t('common.close'))}</button></div>`;
}
function bindClose(view) {
  view.querySelector('[data-close]').addEventListener('click', () => go(state.tab === 'rules' ? 'menu' : state.back || 'map'));
}

async function renderMap() {
  const view = document.getElementById('view');
  const m = state.config.map;
  view.className = 'view';
  view.innerHTML = `
    <div class="map-wrap">
      <div class="map-scroll">
        <div class="map-inner" style="aspect-ratio:${m.width}/${m.height}">
          <img src="${esc(m.image)}" alt="${esc(t('map.alt'))}" draggable="false">
        </div>
      </div>
      <div class="zoom">
        <button type="button" data-zoom="1" aria-label="${esc(t('map.zoomIn'))}">+</button>
        <button type="button" data-zoom="-1" aria-label="${esc(t('map.zoomOut'))}">−</button>
      </div>
    </div>
    <section class="info" aria-live="polite"></section>`;

  const inner = view.querySelector('.map-inner');
  const applyZoom = () => { inner.style.width = state.zoom * 100 + '%'; };
  applyZoom();
  view.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    state.zoom = Math.min(4, Math.max(1, state.zoom + Number(b.dataset.zoom) * 0.5));
    applyZoom();
  }));

  const drawInfo = () => {
    const tr = state.territories.find((x) => x.id === state.selected);
    const owner = tr && tr.faction ? faction(tr.faction) : null;
    view.querySelector('.info').innerHTML = tr
      ? `<h3>${esc(loc(tr.name))}</h3>
         <p class="muted small">${esc(t('map.coords', tr))} · ${owner
    ? `${esc(t('map.owned'))} <span style="color:${esc(owner.color)}">${esc(loc(owner.name))}</span>`
    : esc(t('map.neutral'))}</p>`
      : `<p class="muted">${esc(t('map.hint'))}</p>`;
  };
  const drawMarkers = () => {
    inner.querySelectorAll('.marker').forEach((n) => n.remove());
    for (const tr of state.territories) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'marker' + (tr.id === state.selected ? ' selected' : '');
      b.style.left = (tr.x / m.width) * 100 + '%';
      b.style.top = (tr.y / m.height) * 100 + '%';
      if (tr.faction) b.style.setProperty('--c', faction(tr.faction).color);
      b.setAttribute('aria-label', loc(tr.name));
      b.addEventListener('click', () => {
        state.selected = tr.id;
        drawMarkers();
        drawInfo();
        if (!state.viewedTerritory) { state.viewedTerritory = true; track('territory_viewed'); }
      });
      inner.appendChild(b);
    }
  };
  drawMarkers();
  drawInfo();

  try {
    state.territories = (await api('/map')).territories;
    if (state.tab === 'map' && inner.isConnected) { drawMarkers(); drawInfo(); }
  } catch (err) {
    if (err.status === 401) return sessionLost();
  }
}

async function renderMenu() {
  const view = document.getElementById('view');
  view.className = 'view scroll';

  const draw = () => {
    const ch = state.me.character;
    const f = faction(ch.faction);
    const counts = Object.fromEntries(state.config.factions.map((x) => [x.id, 0]));
    for (const tr of state.territories) if (tr.faction) counts[tr.faction] += 1;
    const shownFactions = state.config.factions.filter((x) => !x.secret || x.id === ch.faction || counts[x.id] > 0
      || state.players.some((p) => p.faction === x.id));
    view.innerHTML = `
      <button class="btn ghost" type="button" data-rules>${esc(t('menu.rules'))}</button>

      <section class="card">
        <h2>${esc(t('menu.character'))}</h2>
        <div class="profile">
          <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
          <div><h3>${esc(ch.pseudo)}</h3><span class="pill">${esc(loc(f.name))}</span></div>
        </div>
        <dl class="kv">
          <dt>${esc(t('menu.class'))}</dt><dd>${esc(className(ch.class))}</dd>
          <dt>${esc(t('menu.birthday'))}</dt><dd>${esc(fmtDate(ch.birthday))}</dd>
          <dt>${esc(t('menu.gold'))}</dt><dd>${fmtNum(ch.gold)}</dd>
          <dt>${esc(t('menu.renown'))}</dt><dd>${esc(t('menu.renownValue', ch.renown))}</dd>
          <dt>${esc(t('menu.email'))}</dt><dd>${esc(state.me.user.email)}</dd>
        </dl>
      </section>

      <section class="card">
        <h2>${esc(t('menu.faction'))}</h2>
        <div class="faction-line">
          <img class="faction-logo" src="${esc(f.logo)}" alt="">
          <div><strong style="color:${esc(f.color)}">${esc(loc(f.name))}</strong><p class="muted small">${esc(loc(f.description))}</p></div>
        </div>
      </section>

      <section class="card">
        <h2>${esc(t('menu.territories'))}</h2>
        ${shownFactions.map((x) => `
          <div class="score" style="--c:${esc(x.color)}"><span class="dot"></span>${esc(loc(x.name))}<span class="n">${counts[x.id]} / ${state.territories.length}</span></div>`).join('')}
      </section>

      <section class="card">
        <h2>${esc(t('menu.players', { n: state.players.length }))}</h2>
        ${state.players.map((p) => {
    const pf = faction(p.faction);
    return `<div class="player">
            <img class="avatar" src="${avatarUrl(p.avatar)}" alt="">
            <div><strong>${esc(p.pseudo)}</strong><small>${esc(className(p.class))} · ${esc(t('menu.playerRenown', { level: Number(p.renown) || 0 }))} · ${esc(fmtDate(p.birthday))}</small></div>
            <span class="pill" style="--c:${esc(pf ? pf.color : '#888')}">${esc(pf ? loc(pf.name) : p.faction)}</span>
          </div>`;
  }).join('') || `<p class="muted small">${esc(t('common.loading'))}</p>`}
      </section>

      <button class="btn danger" type="button" data-logout>${esc(t('common.logout'))}</button>`;
    view.querySelector('[data-logout]').addEventListener('click', logout);
    view.querySelector('[data-rules]').addEventListener('click', () => go('rules'));
  };

  draw();
  try {
    const [players, map] = await Promise.all([api('/players'), api('/map')]);
    state.players = players.players;
    state.territories = map.territories;
    if (state.tab === 'menu' && view.isConnected) draw();
  } catch (err) {
    if (err.status === 401) sessionLost();
  }
}

// Texte d'une notification : le serveur stocke un type et des paramètres, traduits ici.
function notifText(n) {
  if (!n.type || !hasText(`notif.${n.type}.title`)) return { title: n.title, body: n.body };
  const p = { ...n.params };
  if (p.mission) p.mission = loc((state.config.missions || []).find((m) => m.id === p.mission)?.title) || p.mission;
  if (p.faction) p.faction = loc(faction(p.faction)?.name) || p.faction;
  return { title: t(`notif.${n.type}.title`, p), body: t(`notif.${n.type}.body`, p) };
}

async function renderNotifs() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  view.innerHTML = panelHead(t('notifs.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  let list;
  try { list = (await api('/notifications')).notifications; } catch (err) {
    if (err.status === 401) return sessionLost();
    list = null;
  }
  if (state.tab !== 'notifs' || !view.isConnected) return;
  const when = (iso) => new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  view.innerHTML = panelHead(t('notifs.title')) + (list === null
    ? `<p class="error">${esc(t('notifs.error'))}</p>`
    : list.length
      ? list.map((n) => {
        const txt = notifText(n);
        return `
        <article class="card notif ${n.read ? '' : 'unread'}">
          <div class="notif-head"><strong>${esc(txt.title)}</strong>${n.read ? '' : `<span class="new">${esc(t('notifs.new'))}</span>`}</div>
          <p>${esc(txt.body)}</p>
          <small class="muted">${esc(when(n.created_at))}</small>
        </article>`;
      }).join('')
      : `<p class="muted">${esc(t('notifs.empty'))}</p>`);
  bindClose(view);
  // Les notifications affichées passent en « lues ».
  if (list && list.some((n) => !n.read)) {
    try { setMe(await api('/notifications/read', {})); } catch { /* sera réessayé à la prochaine ouverture */ }
  }
}

async function renderMissions() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const rewardText = (rw) => [
    rw.gold ? `<span class="res"><img src="assets/ui/gold.svg" alt="${esc(t('res.gold'))}">+${fmtNum(rw.gold)}</span>` : '',
    rw.xp ? `<span class="res"><img src="assets/ui/renown.svg" alt="${esc(t('missions.xpAlt'))}">+${fmtNum(rw.xp)} xp</span>` : '',
  ].join('');
  const draw = (missions, error) => {
    const order = { done: 0, active: 1, claimed: 2 };
    const sorted = [...missions].sort((a, b) => order[a.status] - order[b.status]);
    view.innerHTML = panelHead(t('missions.title'))
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      + (sorted.length ? sorted.map((m) => `
        <article class="card mission ${m.status}">
          <div class="notif-head"><strong>${esc(loc(m.title))}</strong>
            ${m.status === 'claimed' ? `<span class="muted small">${esc(t('missions.claimed'))}</span>` : ''}</div>
          <p class="muted small">${esc(loc(m.description))}</p>
          ${m.status === 'active' ? `<div class="progress"><span class="xpbar"><i style="width:${(m.current / m.target) * 100}%"></i></span>
            <small class="muted">${m.current} / ${m.target}</small></div>` : ''}
          <div class="rewards">${rewardText(m.rewards)}
            ${m.status === 'done' ? `<button type="button" class="btn compact" data-claim="${esc(m.id)}">${esc(t('missions.claim'))}</button>` : ''}</div>
        </article>`).join('') : (error ? '' : `<p class="muted">${esc(t('missions.empty'))}</p>`));
    bindClose(view);
    view.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await api('/missions/claim', { id: b.dataset.claim });
        setMe(res);
        if (state.tab === 'missions' && view.isConnected) draw(res.missions);
      } catch (err) {
        if (err.status === 401) return sessionLost();
        draw(missions, err.message);
      }
    }));
  };
  view.innerHTML = panelHead(t('missions.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  try {
    const { missions } = await api('/missions');
    if (state.tab === 'missions' && view.isConnected) draw(missions);
    refreshMe();
  } catch (err) {
    if (err.status === 401) return sessionLost();
    draw([], t('missions.error'));
  }
}

function renderRules() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const rules = state.config.rules || [];
  view.innerHTML = panelHead(t('rules.title')) + (rules.length
    ? rules.map((r) => `<section class="card"><h2>${esc(loc(r.title))}</h2><p class="rule-text">${esc(loc(r.text))}</p></section>`).join('')
    : `<p class="muted">${esc(t('rules.empty'))}</p>`);
  bindClose(view);
  track('rules_read');
}

// ------------------------------------------------------------ Session
function resetSession() {
  state.me = null;
  state.step = 1;
  state.draft = { pseudo: '', birthday: '', class: '', avatar: '', faction: '' };
  state.secretShown = false;
  state.selected = null;
  state.players = [];
  state.viewedTerritory = false;
  state.back = 'map';
  state.tab = 'map';
  state.authTab = 'login';
}

async function logout() {
  try { await api('/logout', {}); } catch { /* on déconnecte quand même côté client */ }
  resetSession();
  render();
}

function sessionLost() {
  resetSession();
  render();
}

// ------------------------------------------------------------ Démarrage
async function start() {
  try {
    const [config, avatars] = await Promise.all([
      fetch('config/game.json').then((r) => r.json()),
      fetch('/api/avatars').then((r) => r.json()).catch(() => ({ avatars: [] })),
    ]);
    state.config = config;
    state.avatars = avatars.avatars || [];
    fallbackDict = await loadDict(config.defaultLang);
    // Langue : choix déjà fait sur cet appareil, sinon langue du navigateur, sinon langue par défaut.
    const wanted = [storedLang(), (navigator.language || '').slice(0, 2).toLowerCase(), config.defaultLang].find(isLang);
    await setLang(wanted, { save: false });
  } catch {
    app.innerHTML = '<p class="loading">Impossible de charger le jeu. / Unable to load the game.</p>';
    return;
  }
  try { await signedIn(await api('/me')); } catch { state.me = null; }
  render();
  // Vérifie régulièrement les nouvelles notifications et récompenses.
  setInterval(() => { if (!document.hidden) refreshMe(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMe(); });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
start();
