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
const classIcon = (c) => `<img class="class-icon" src="${esc(c?.icon || 'assets/classes/' + (c?.id || '') + '.svg')}" alt="">`;
// Rangs de classes qui contiennent au moins une classe (un rang vide, ex. légendaire, reste caché).
const classTiers = () => (state.config.classTiers || []).filter((tr) => state.config.classes.some((c) => c.tier === tr.id));
const tierOf = (c) => (state.config.classTiers || []).find((tr) => tr.id === c.tier);
const baseTierId = () => state.config.classTiers?.[0]?.id;
const requiresText = (c) => (c.requires || []).map(className).join(t('classes.or'));

// Le joueur peut-il prendre cette classe ? Renvoie { ok } ou { ok: false, why } (mêmes règles que le serveur).
function classAccess(c) {
  const ch = state.me.character;
  const tier = tierOf(c);
  if (c.id === ch.class) return { ok: false, current: true };
  if (!tier || !Number.isInteger(tier.cost) || !Number.isInteger(tier.renown)) return { ok: false, why: t('classes.locked') };
  if (c.tier !== baseTierId() && !(c.requires || []).includes(ch.class)) return { ok: false, why: t('classes.needPath', { list: requiresText(c) }) };
  if (ch.renown.level < tier.renown) return { ok: false, why: t('classes.needRenown', { renown: tier.renown }) };
  if (ch.gold < tier.cost) return { ok: false, why: t('classes.needGold', { gold: fmtNum(tier.cost - ch.gold) }) };
  return { ok: true };
}
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
  // À la création, seuls les avatars libres sont proposés.
  const freeAvatars = state.avatars.filter((a) => a.unlock === 'free').map((a) => a.file);
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
            ${state.config.classes.filter((c) => c.tier === baseTierId()).map((c) => `
              <button type="button" class="choice with-icon ${d.class === c.id ? 'selected' : ''}" data-class="${esc(c.id)}" aria-pressed="${d.class === c.id}">
                ${classIcon(c)}<span><strong>${esc(loc(c.name))}</strong><small>${esc(loc(c.description))}</small></span>
              </button>`).join('')}
          </div>
        </div>
        <div class="field"><span>${esc(t('char.avatar'))}</span>
          ${freeAvatars.length ? `<div class="avatars">
            ${freeAvatars.map((a, i) => `
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
const VIEWS = { map: renderMap, menu: renderMenu, notifs: renderNotifs, missions: renderMissions, rules: renderRules, classes: renderClasses, avatars: renderAvatars };

function go(tab) {
  if (state.tab === 'map' || state.tab === 'menu') state.back = state.tab;
  state.tab = tab;
  renderGame();
}

function renderGame() {
  const menuSide = ['menu', 'rules', 'classes', 'avatars'].includes(state.tab);
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
        <span class="muted small">${classIcon(klass(ch.class))}${esc(className(ch.class))} · <span style="color:${esc(f.color)}">${esc(loc(f.name))}</span></span></div>
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

function panelHead(title, extra = '') {
  return `<div class="panel-head"><h1 class="page-title">${esc(title)}</h1>
    <div class="panel-actions">${extra}<button type="button" class="btn ghost compact" data-close>${esc(t('common.close'))}</button></div></div>`;
}
function bindClose(view) {
  view.querySelector('[data-close]').addEventListener('click', () => {
    if (state.tab === 'classes' && state.classesFrom === 'rules') return go('rules');
    go(['rules', 'classes', 'avatars'].includes(state.tab) ? 'menu' : state.back || 'map');
  });
}

async function renderMap() {
  const view = document.getElementById('view');
  const m = state.config.map;
  view.className = 'view';
  view.innerHTML = `
    <div class="map-wrap">
      <div class="map-scroll">
        <div class="map-inner" style="aspect-ratio:${m.width}/${m.height}">
          <svg class="map" viewBox="0 0 ${m.width} ${m.height}" role="group" aria-label="${esc(t('map.alt'))}">
            <image href="${esc(m.image)}" width="${m.width}" height="${m.height}" preserveAspectRatio="none"/>
            ${m.territories.map((tr) => `<path class="terr" data-id="${esc(tr.id)}" d="${esc(tr.path)}" tabindex="0" role="button" aria-label="${esc(loc(tr.name))}"/>`).join('')}
          </svg>
        </div>
      </div>
      <div class="zoom">
        <button type="button" data-zoom="1" aria-label="${esc(t('map.zoomIn'))}">+</button>
        <button type="button" data-zoom="-1" aria-label="${esc(t('map.zoomOut'))}">−</button>
      </div>
    </div>
    <section class="info map-info" aria-live="polite"></section>`;

  const inner = view.querySelector('.map-inner');
  const scroller = view.querySelector('.map-scroll');
  const svg = view.querySelector('svg.map');
  const applyZoom = () => { inner.style.width = state.zoom * 100 + '%'; };
  applyZoom();
  // Le zoom garde au centre de l'écran le point qui s'y trouvait.
  view.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth;
    const cy = (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight;
    state.zoom = Math.min(6, Math.max(1, state.zoom + Number(b.dataset.zoom) * 0.5));
    applyZoom();
    scroller.scrollLeft = cx * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = cy * scroller.scrollHeight - scroller.clientHeight / 2;
  }));

  const shape = (id) => m.territories.find((x) => x.id === id);
  const ownerOf = (id) => state.territories.find((x) => x.id === id)?.faction || null;
  // Voisins : ceux que le territoire cite dans map.json, et ceux qui le citent.
  const neighborsOf = (id) => m.territories
    .filter((x) => x.id !== id && ((shape(id)?.neighbors || []).includes(x.id) || (x.neighbors || []).includes(id)))
    .map((x) => x.id);

  const drawInfo = () => {
    const tr = shape(state.selected);
    if (!tr) { view.querySelector('.info').innerHTML = `<p class="muted">${esc(t('map.hint'))}</p>`; return; }
    const owner = ownerOf(tr.id) ? faction(ownerOf(tr.id)) : null;
    const near = neighborsOf(tr.id);
    view.querySelector('.info').innerHTML = `
      <h3>${esc(loc(tr.name))}</h3>
      <p class="muted small">${owner
    ? `${esc(t('map.owned'))} <span style="color:${esc(owner.color)}">${esc(loc(owner.name))}</span>`
    : esc(t('map.neutral'))}</p>
      <p class="muted small">${esc(near.length ? t('map.neighbors') : t('map.noNeighbors'))}</p>
      ${near.length ? `<div class="chips">${near.map((id) => {
    const o = ownerOf(id) ? faction(ownerOf(id)) : null;
    return `<button type="button" class="chip" data-goto="${esc(id)}"><span class="dot" style="--c:${esc(o ? o.color : '#6b7287')}"></span>${esc(loc(shape(id).name))}</button>`;
  }).join('')}</div>` : ''}`;
    view.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => select(b.dataset.goto, true)));
  };
  // Colore chaque territoire selon sa faction, et met en évidence le territoire choisi et ses voisins.
  const paint = () => {
    const near = new Set(state.selected ? neighborsOf(state.selected) : []);
    svg.querySelectorAll('.terr').forEach((p) => {
      const o = ownerOf(p.dataset.id);
      p.style.fill = o ? faction(o).color : '';
      p.classList.toggle('owned', !!o);
      p.classList.toggle('selected', p.dataset.id === state.selected);
      p.classList.toggle('neighbor', near.has(p.dataset.id));
    });
    // Le territoire choisi passe au-dessus des autres pour que son contour reste entier.
    const sel = svg.querySelector('.terr.selected');
    if (sel) svg.appendChild(sel);
  };
  const select = (id, reveal) => {
    state.selected = id;
    paint();
    drawInfo();
    if (reveal) svg.querySelector('.terr.selected')?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    if (!state.viewedTerritory) { state.viewedTerritory = true; track('territory_viewed'); }
  };
  svg.addEventListener('click', (e) => {
    const p = e.target.closest('.terr');
    if (p) select(p.dataset.id);
  });
  svg.addEventListener('keydown', (e) => {
    const p = e.target.closest('.terr');
    if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(p.dataset.id); }
  });
  paint();
  drawInfo();

  try {
    state.territories = (await api('/map')).territories;
    if (state.tab === 'map' && inner.isConnected) { paint(); drawInfo(); }
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
        <div class="row">
          <button class="btn ghost" type="button" data-avatars>${esc(t('avatars.change'))}</button>
          <button class="btn ghost" type="button" data-classes>${esc(t('classes.change'))}</button>
        </div>
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
    view.querySelector('[data-avatars]').addEventListener('click', () => go('avatars'));
    view.querySelector('[data-classes]').addEventListener('click', () => {
      state.classesFrom = 'menu';
      state.classSel = state.me.character.class;
      go('classes');
    });
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
  if (p.class) p.class = className(p.class);
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
  const clearBtn = list && list.length ? `<button type="button" class="btn ghost compact" data-clear>${esc(t('notifs.clear'))}</button>` : '';
  view.innerHTML = panelHead(t('notifs.title'), clearBtn) + (list === null
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
  view.querySelector('[data-clear]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { setMe(await api('/notifications/clear', {})); } catch (err) {
      if (err.status === 401) return sessionLost();
      e.target.disabled = false;
      return;
    }
    if (state.tab === 'notifs') renderNotifs();
  });
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
    rw.avatar ? `<span class="res"><img class="reward-avatar" src="${avatarUrl(rw.avatar)}" alt="">${esc(t('missions.avatarReward'))}</span>` : '',
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
    : `<p class="muted">${esc(t('rules.empty'))}</p>`) + classesFold();
  bindClose(view);
  view.querySelector('[data-tree]').addEventListener('click', () => {
    state.classesFrom = 'rules';
    state.classSel = state.me.character.class;
    go('classes');
  });
  track('rules_read');
}

// Choix de l'avatar : avatars disponibles, avatars à acheter, avatars à gagner en mission.
async function renderAvatars() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const lock = '<svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm2 0h6V7a3 3 0 0 0-6 0z" fill="currentColor"/></svg>';

  const draw = (error) => {
    const ch = state.me.character;
    const tile = (a) => {
      const current = a.file === ch.avatar;
      const label = current ? t('avatars.currentLabel')
        : a.owned ? t('avatars.useLabel')
          : a.unlock === 'gold' ? t('avatars.buyLabel', { gold: fmtNum(a.price) }) : t('avatars.lockedLabel');
      return `
        <button type="button" class="avatar-btn ${current ? 'selected' : ''} ${a.owned ? '' : 'locked'} ${state.avatarBuy === a.file ? 'asking' : ''}"
          data-avatar="${esc(a.file)}" aria-label="${esc(label)}" aria-pressed="${current}" ${!a.owned && a.unlock !== 'gold' ? 'disabled' : ''}>
          <img class="avatar" src="${avatarUrl(a.file)}" alt="">
          ${a.owned ? '' : lock}
          ${!a.owned && a.unlock === 'gold' ? `<span class="price"><img src="assets/ui/gold.svg" alt="">${fmtNum(a.price)}</span>` : ''}
        </button>`;
    };
    const section = (title, list, hint) => (list.length ? `
      <section class="card"><h2>${esc(title)}</h2>
        ${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
        <div class="avatars">${list.map(tile).join('')}</div>
      </section>` : '');
    const asking = state.avatars.find((a) => a.file === state.avatarBuy);
    view.innerHTML = panelHead(t('avatars.title'))
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      + section(t('avatars.mine'), state.avatars.filter((a) => a.owned))
      + section(t('avatars.shop'), state.avatars.filter((a) => !a.owned && a.unlock === 'gold'))
      + (asking ? `<div class="card confirm-buy"><p>${esc(t('avatars.buy', { gold: fmtNum(asking.price) }))}</p>
          <div class="row"><button type="button" class="btn ghost" data-cancel>${esc(t('common.cancel'))}</button>
          <button type="button" class="btn" data-buy>${esc(t('common.confirm'))}</button></div></div>` : '')
      + section(t('avatars.missions'), state.avatars.filter((a) => !a.owned && a.unlock === 'mission'), t('avatars.missionHint'));
    bindClose(view);

    const send = async (path, avatar) => {
      state.avatarBuy = null;
      let err;
      try {
        const res = await api(path, { avatar });
        state.avatars = res.avatars;
        setMe(res);
      } catch (e) {
        if (e.status === 401) return sessionLost();
        err = e.message;
      }
      if (state.tab === 'avatars' && view.isConnected) draw(err);
    };
    view.querySelectorAll('[data-avatar]').forEach((b) => b.addEventListener('click', () => {
      const a = state.avatars.find((x) => x.file === b.dataset.avatar);
      if (!a || a.file === ch.avatar) return;
      if (a.owned) return send('/avatar', a.file);
      // Avatar payant : on demande une confirmation avant de dépenser l'or.
      state.avatarBuy = a.file;
      draw();
      view.querySelector('.confirm-buy')?.scrollIntoView({ block: 'nearest' });
    }));
    view.querySelector('[data-cancel]')?.addEventListener('click', () => { state.avatarBuy = null; draw(); });
    view.querySelector('[data-buy]')?.addEventListener('click', (e) => { e.target.disabled = true; send('/avatar/buy', asking.file); });
  };

  state.avatarBuy = null;
  view.innerHTML = panelHead(t('avatars.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  try {
    state.avatars = (await api('/avatars')).avatars;
    if (state.tab === 'avatars' && view.isConnected) draw();
  } catch (err) {
    if (err.status === 401) return sessionLost();
    if (state.tab === 'avatars' && view.isConnected) {
      view.innerHTML = panelHead(t('avatars.title')) + `<p class="error">${esc(t('avatars.error'))}</p>`;
      bindClose(view);
    }
  }
}

// Conditions d'accès à un rang de classes.
function tierCondition(tier) {
  if (!Number.isInteger(tier.cost) || !Number.isInteger(tier.renown)) return t('classes.locked');
  const p = { renown: tier.renown, gold: fmtNum(tier.cost) };
  return tier.id === baseTierId() ? t('classes.baseCond', p) : t('classes.cond', p);
}

// Dépliant des règles : liste des classes par rang, avec description et prérequis.
function classesFold() {
  return `
    <details class="card fold">
      <summary>${esc(t('classes.title'))}</summary>
      <p class="muted small">${esc(t('classes.intro'))}</p>
      <button type="button" class="btn ghost compact" data-tree>${esc(t('classes.tree'))}</button>
      ${classTiers().map((tier) => `
        <h3 class="tier-title">${esc(loc(tier.name))}</h3>
        <p class="muted small">${esc(tierCondition(tier))}</p>
        <ul class="class-list">
          ${state.config.classes.filter((c) => c.tier === tier.id).map((c) => `
            <li>${classIcon(c)}<div><strong>${esc(loc(c.name))}</strong>
              ${loc(c.description) ? `<span class="muted small">${esc(loc(c.description))}</span>` : ''}
              ${(c.requires || []).length ? `<span class="muted small">${esc(t('classes.requires', { list: requiresText(c) }))}</span>` : ''}</div></li>`).join('')}
        </ul>`).join('')}
    </details>`;
}

// Arbre des classes : un rang par colonne, un trait par prérequis.
// Toucher une classe met en évidence tous les chemins qui y mènent et affiche ses conditions.
function renderClasses() {
  const view = document.getElementById('view');
  view.className = 'view';
  const classes = state.config.classes;
  const tiers = classTiers();
  const COL = 90, ROW = 66, NW = 80, NH = 58;
  const rows = Math.max(...tiers.map((tier) => classes.filter((c) => c.tier === tier.id).length));
  const H = rows * ROW;
  const pos = {};
  tiers.forEach((tier, col) => {
    const list = classes.filter((c) => c.tier === tier.id);
    list.forEach((c, i) => { pos[c.id] = { x: col * COL + (COL - NW) / 2, y: (i + 0.5) * (H / list.length) - NH / 2 }; });
  });
  const edges = [];
  for (const c of classes) for (const req of c.requires || []) if (pos[c.id] && pos[req]) edges.push({ from: req, to: c.id });

  // Classes situées sur un chemin menant à la classe choisie.
  const pathTo = (id) => {
    const seen = new Set();
    const walk = (x) => { if (seen.has(x)) return; seen.add(x); for (const req of klass(x)?.requires || []) walk(req); };
    walk(id);
    return seen;
  };

  const draw = (error) => {
    const ch = state.me.character;
    if (!pos[state.classSel]) state.classSel = ch.class;
    const sel = klass(state.classSel);
    const lit = pathTo(sel.id);
    const access = classAccess(sel);
    const tier = tierOf(sel);
    view.innerHTML = `
      <div class="panel-head pad">${`<h1 class="page-title">${esc(t('classes.tree'))}</h1>
        <button type="button" class="btn ghost compact" data-close>${esc(t('common.close'))}</button>`}</div>
      <div class="tree-scroll">
        <div class="tree-heads" style="width:${tiers.length * COL}px">
          ${tiers.map((tr) => `<span style="width:${COL}px">${esc(loc(tr.name))}</span>`).join('')}
        </div>
        <div class="tree" style="width:${tiers.length * COL}px;height:${H}px">
          <svg width="${tiers.length * COL}" height="${H}" aria-hidden="true">
            ${edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
    const on = lit.has(e.to) && lit.has(e.from);
    return `<path class="${on ? 'on' : ''}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
  }).join('')}
          </svg>
          ${classes.filter((c) => pos[c.id]).map((c) => `
            <button type="button" data-node="${esc(c.id)}" aria-pressed="${c.id === sel.id}"
              class="node ${lit.has(c.id) ? 'on' : ''} ${c.id === sel.id ? 'selected' : ''} ${c.id === ch.class ? 'current' : ''}"
              style="left:${pos[c.id].x}px;top:${pos[c.id].y}px;width:${NW}px;height:${NH}px">
              ${classIcon(c)}<span>${esc(loc(c.name))}</span>
            </button>`).join('')}
        </div>
      </div>
      <section class="info class-info" aria-live="polite">
        <div class="class-head">${classIcon(sel)}
          <div><h3>${esc(loc(sel.name))}</h3><span class="muted small">${esc(loc(tier?.name))}${loc(sel.description) ? ' · ' + esc(loc(sel.description)) : ''}</span></div></div>
        ${(sel.requires || []).length ? `<p class="muted small">${esc(t('classes.requires', { list: requiresText(sel) }))}</p>` : ''}
        <p class="muted small">${esc(tier ? tierCondition(tier) : '')}</p>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        ${access.current ? `<p class="current-note">${esc(t('classes.current'))}</p>`
    : !access.ok ? `<p class="why">${esc(access.why)}</p>`
      : state.classConfirm === sel.id
        ? `<p class="small">${esc(t('classes.confirm', { name: loc(sel.name), gold: fmtNum(tier.cost) }))}</p>
           <div class="row"><button type="button" class="btn ghost" data-cancel>${esc(t('common.cancel'))}</button>
           <button type="button" class="btn" data-become>${esc(t('common.confirm'))}</button></div>`
        : `<button type="button" class="btn" data-ask>${esc(t('classes.become', { name: loc(sel.name), gold: fmtNum(tier.cost) }))}</button>`}
      </section>`;
    bindClose(view);
    const scroller = view.querySelector('.tree-scroll');
    view.querySelectorAll('[data-node]').forEach((b) => b.addEventListener('click', () => {
      const keep = { x: scroller.scrollLeft, y: scroller.scrollTop };
      state.classSel = b.dataset.node;
      state.classConfirm = null;
      redraw(keep);
    }));
    // Le changement coûte de l'or : on demande une confirmation avant de l'envoyer.
    view.querySelectorAll('[data-ask], [data-cancel]').forEach((b) => b.addEventListener('click', () => {
      state.classConfirm = b.hasAttribute('data-ask') ? sel.id : null;
      redraw({ x: scroller.scrollLeft, y: scroller.scrollTop });
    }));
    const become = view.querySelector('[data-become]');
    if (become) become.addEventListener('click', async () => {
      become.disabled = true;
      state.classConfirm = null;
      const keep = { x: scroller.scrollLeft, y: scroller.scrollTop };
      let err;
      try { setMe(await api('/class', { class: sel.id })); } catch (e) {
        if (e.status === 401) return sessionLost();
        err = e.message;
      }
      if (state.tab !== 'classes' || !view.isConnected) return;
      redraw(keep, err);
    });
  };
  // Redessine en gardant la position de défilement de l'arbre.
  const redraw = (keep, error) => {
    draw(error);
    const s = view.querySelector('.tree-scroll');
    s.scrollLeft = keep.x;
    s.scrollTop = keep.y;
  };

  state.classConfirm = null;
  draw();
  // Amène la classe choisie dans la zone visible.
  const node = view.querySelector('.node.selected');
  if (node) node.scrollIntoView({ block: 'center', inline: 'center' });
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
    const [config, map, avatars] = await Promise.all([
      fetch('config/game.json').then((r) => r.json()),
      fetch('config/map.json').then((r) => r.json()),
      fetch('/api/avatars').then((r) => r.json()).catch(() => ({ avatars: [] })),
    ]);
    config.map = map;
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
