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
// Camp pour lequel le joueur combat : la faction rejointe en exil, sinon la sienne.
const effFaction = () => state.me?.player?.faction || state.me?.character?.faction;
// Accord du verbe : une faction est au pluriel (« Les Aigles de jais ») ou au singulier (« L'Église de Seiros »), selon la langue
// (champ « plural » de la faction dans game.json, pluriel par défaut). Les textes dont la faction est sujet existent en deux
// variantes : la clé, et la même clé suivie de « .pl » pour le pluriel.
const isPlural = (id) => faction(id)?.plural?.[state.lang] !== false;
const numKey = (key, id) => (isPlural(id) && hasText(`${key}.pl`) ? `${key}.pl` : key);
const klass = (id) => state.config.classes.find((c) => c.id === id);
const className = (id) => loc(klass(id)?.name) || id;
const classIcon = (c) => `<img class="class-icon" src="${esc(c?.icon || 'assets/classes/' + (c?.id || '') + '.webp')}" alt="">`;
// Rangs de classes qui contiennent au moins une classe (un rang vide, ex. légendaire, reste caché).
const classTiers = () => (state.config.classTiers || []).filter((tr) => state.config.classes.some((c) => c.tier === tr.id));
const tierOf = (c) => (state.config.classTiers || []).find((tr) => tr.id === c.tier);
const baseTierId = () => state.config.classTiers?.[0]?.id;
const requiresText = (c) => (c.requires || []).map(className).join(t('classes.or'));
// Effet d'une classe, dans la langue du joueur ({c:id} devient le nom de la classe correspondante).
const effectText = (c) => (c?.effectText ? loc(c.effectText).replace(/\{c:([a-z-]+)\}/g, (_, id) => className(id)) : '');
// Effets cumulés du joueur : ceux de toutes les classes de sa lignée.
const myEffects = () => (state.me?.character?.path || []).flatMap((id) => klass(id)?.effects || []);
// Condition supplémentaire d'une classe (exploit compté par le serveur), avec la progression du joueur.
const unlockText = (c) => {
  if (!c.unlock) return '';
  const done = Math.min(state.me?.stats?.[c.unlock.event] || 0, c.unlock.count);
  return t('classes.extra', { text: t(`unlock.${c.unlock.event}`, { n: c.unlock.count, done }) });
};

// Le joueur peut-il prendre cette classe ? Renvoie { ok } ou { ok: false, why } (mêmes règles que le serveur).
function classAccess(c) {
  const ch = state.me.character;
  const tier = tierOf(c);
  if (c.id === ch.class) return { ok: false, current: true };
  if (!tier || !Number.isInteger(tier.cost) || !Number.isInteger(tier.renown)) return { ok: false, why: t('classes.locked') };
  if (c.tier !== baseTierId() && !(c.requires || []).includes(ch.class)) return { ok: false, why: t('classes.needPath', { list: requiresText(c) }) };
  if (ch.renown.level < tier.renown) return { ok: false, why: t('classes.needRenown', { renown: tier.renown }) };
  if (c.unlock && (state.me.stats?.[c.unlock.event] || 0) < c.unlock.count) return { ok: false, why: unlockText(c) };
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
  document.body.style.setProperty('--faction', ch ? faction(effFaction()).color : 'var(--accent)');
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

// Titre du jeu sur l'écran d'accueil : trois couronnes, puis le titre sur trois niveaux
// (config "brand" : top, main, sub ; à défaut, le titre complet sur une ligne).
function brandBlock() {
  const b = state.config.brand;
  const crown = (x, s) => `<path transform="translate(${x} ${s === 1 ? 0 : 6}) scale(${s})" d="M2 22L0 6l8 7 6-13 6 13 8-7-2 16z"/>`;
  return `
    <div class="brand">
      <svg class="crowns" viewBox="0 0 96 26" aria-hidden="true">${crown(4, 0.72)}${crown(34, 1)}${crown(71.800, 0.72)}</svg>
      <h1 aria-label="${esc(loc(state.config.title))}">${b
    ? `<span class="brand-top">${esc(loc(b.top))}</span><span class="brand-main">${esc(loc(b.main))}</span>
         <span class="brand-sub"><i></i>${esc(loc(b.sub))}<i></i></span>`
    : `<span class="brand-main">${esc(loc(state.config.title))}</span>`}</h1>
      <p class="tagline">${esc(t('app.tagline'))}</p>
    </div>`;
}

// ------------------------------------------------------------ Connexion / inscription
function renderAuth() {
  const login = state.authTab === 'login';
  app.innerHTML = `
    <div class="page">
      <div class="page-top">${langPicker()}</div>
      ${brandBlock()}
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
  // Les factions non jouables ne sont pas proposées ; la faction secrète n'apparaît qu'après le bouton caché.
  const visible = state.config.factions.filter((f) => !f.npc && (!f.secret || state.secretShown));
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
// Une mise à jour est-elle sortie sans que le joueur l'ait lue ?
const patchUnread = () => { const p = state.me?.patch; return !!(p && p.latest && p.latest !== p.seen); };

// Onglets principaux : map, menu. Écrans secondaires : notifs, missions, rules.
const VIEWS = { map: renderMap, menu: renderMenu, notifs: renderNotifs, missions: renderMissions, rules: renderRules, classes: renderClasses, avatars: renderAvatars, journal: renderJournal, patches: renderPatches };

function go(tab) {
  if (['map', 'menu', 'journal'].includes(state.tab)) state.back = state.tab;
  state.tab = tab;
  renderGame();
}

function renderGame() {
  const menuSide = ['menu', 'rules', 'classes', 'avatars', 'patches'].includes(state.tab);
  app.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <main class="view" id="view"></main>
    <nav class="tabbar">
      <button type="button" data-tab="map" class="${state.tab === 'map' ? 'active' : ''}">${esc(t('tab.map'))}</button>
      <button type="button" data-tab="journal" class="${state.tab === 'journal' ? 'active' : ''}">${esc(t('tab.journal'))}</button>
      <button type="button" data-tab="menu" class="${menuSide ? 'active' : ''}">${esc(t('tab.menu'))}${patchUnread() ? '<span class="new-dot"></span>' : ''}</button>
    </nav>`;
  app.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  drawTopbar();
  (VIEWS[state.tab] || renderMap)();
}

// ------------------------------------------------------------ Temps de jeu
// Les échéances (prochaine action, fin de bataille, délai de repli) sont données à l'heure du serveur.
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
function syncClock(src) { if (src && src.now) clockOffset = src.now - Date.now(); }
function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
// Phrase traduite contenant un compte à rebours vivant à la place de {time}.
function withTimer(key, params, until) {
  return esc(t(key, { ...params, time: '\u0001' })).replace('\u0001', `<span data-until="${until}">${fmtLeft(until - serverNow())}</span>`);
}
// État de la carte reçu du serveur (territoires, batailles, joueur, campagne, points).
function setMap(map) {
  state.map = map;
  state.territories = map.territories;
  syncClock(map);
  if (state.me && map.player) state.me.player = map.player;
}
let mapView = null; // fonctions de l'écran Carte ouvert, pour le rafraîchir sans tout redessiner
// Chaque seconde : met à jour les comptes à rebours ; à l'échéance, redemande l'état au serveur.
let refreshDue = 0;
function tickTimers() {
  let expired = false;
  document.querySelectorAll('[data-until]').forEach((el) => {
    const left = Number(el.dataset.until) - serverNow();
    el.textContent = fmtLeft(left);
    if (left <= 0) expired = true;
  });
  if (expired && Date.now() > refreshDue && state.me && state.me.character) {
    refreshDue = Date.now() + 3000;
    if (state.tab === 'map' && mapView) mapView.reload(); else refreshMe();
  }
}

// Bandeau du haut : joueur, langue, cloche, parchemin, puis ressources (or, actions et renommée).
function drawTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  const ch = state.me.character;
  const f = faction(effFaction());
  // La couleur d'accent suit le camp pour lequel on combat (change quand on s'exile).
  document.body.style.setProperty('--faction', f.color);
  const r = ch.renown;
  const badge = (n) => (n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
  const { unread, claimable } = state.me;
  const pl = state.me.player;
  bar.innerHTML = `
    <div class="topbar-row">
      <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
      <div class="who"><strong>${esc(ch.pseudo)}${pl?.exile ? ` <span class="tag">${esc(t('exile.tag'))}</span>` : ''}</strong>
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
      ${pl ? `<span class="res" title="${esc(pl.nextActionAt ? t('res.actionsNext', { time: fmtLeft(pl.nextActionAt - serverNow()) }) : t('res.actionsFull'))}">
        <img src="assets/ui/action.svg" alt="${esc(t('res.actions'))}"><strong>${pl.actions}</strong><small class="muted">/ ${pl.maxActions}</small>
        ${pl.nextActionAt ? `<small class="muted timer" data-until="${pl.nextActionAt}">${fmtLeft(pl.nextActionAt - serverNow())}</small>` : ''}</span>` : ''}
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
  state.me = { user: me.user, character: me.character, unread: me.unread, claimable: me.claimable, player: me.player, distinctions: me.distinctions || [], stats: me.stats || {}, patch: me.patch || null };
  syncClock(me.player);
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
    go(['rules', 'classes', 'avatars', 'patches'].includes(state.tab) ? 'menu' : state.back || 'map');
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
  const live = (id) => state.territories.find((x) => x.id === id) || {};
  const ownerOf = (id) => live(id).faction || null;
  // Voisins : ceux que le territoire cite dans map.json, et ceux qui le citent.
  const neighborsOf = (id) => m.territories
    .filter((x) => x.id !== id && ((shape(id)?.neighbors || []).includes(x.id) || (x.neighbors || []).includes(id)))
    .map((x) => x.id);
  const me = () => state.me.player || {};
  const myFaction = () => effFaction();
  // Mêmes règles que le serveur : un territoire « allié » est à ma faction ou est sa base ;
  // on n'entre ailleurs que si la cible touche un territoire allié.
  const isHome = (id) => ownerOf(id) === myFaction() || (state.map?.homeBases || {})[myFaction()] === id;
  const canEnter = (id) => isHome(id) || neighborsOf(id).some(isHome);
  let actionError = '';
  let actionNote = '';

  // Repères dessinés par-dessus la carte : ma position et les batailles en cours.
  const markers = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  markers.setAttribute('class', 'markers');
  svg.appendChild(markers);
  // Boucliers (insaisissable : doré qui brille ; contre-offensive possible : brisé) et pastilles des joueurs présents.
  const SHIELD = 'M12 2.5 4 5.5v5.8c0 4.6 3.2 8.4 8 10.2 4.8-1.8 8-5.6 8-10.2V5.5z';
  const SHIELD_L = 'M12 2.5 4 5.5v5.8c0 4.6 3.2 8.4 8 10.2L10.5 16 13 12 10.5 8z';
  const SHIELD_R = 'M12 2.5 20 5.5v5.8c0 4.6-3.2 8.4-8 10.2L10.5 16 13 12 10.5 8z';
  const shieldAt = (x, y, k, inner) => `<g transform="translate(${x} ${y}) scale(${k}) translate(-12 -12)">${inner}</g>`;
  const drawMarkers = () => {
    const u = m.width / (inner.getBoundingClientRect().width || m.width); // unités de carte par pixel d'écran
    const parts = [];
    const now = serverNow();
    for (const st of state.territories) {
      const s = shape(st.id);
      if (!s) continue;
      if (st.battle) {
        const k = 4 * u;
        parts.push(`<g class="battle-mark" transform="translate(${s.x} ${s.y - 20 * u})">
        <circle r="${9 * u}" fill="${esc(faction(st.battle.attacker)?.color || '#e5484d')}" stroke="#fff" stroke-width="${1.5 * u}"/>
        <path d="M${-k} ${-k}L${k} ${k}M${k} ${-k}L${-k} ${k}" stroke="#fff" stroke-width="${2 * u}" stroke-linecap="round"/></g>`);
      }
      const shielded = st.untouchableUntil && st.untouchableUntil > now;
      if (shielded) {
        parts.push(`<g class="shield-shine">${shieldAt(s.x - 24 * u, s.y - 18 * u, 1.0 * u, `<path d="${SHIELD}" fill="#f6c945" stroke="#fff" stroke-width="1.8"/>
          <path d="M12 6.5v12M7.5 11h9" stroke="#fff6cf" stroke-width="1.6" stroke-linecap="round" opacity=".8"/>
          <path d="M19 1.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" fill="#fff"/>`)}</g>`);
      } else if (st.counter) {
        parts.push(`<g class="shield-broken">${shieldAt(s.x + 24 * u, s.y - 18 * u, 1.0 * u, `
          <path d="${SHIELD_L}" fill="#e5484d" stroke="#fff" stroke-width="1.8" transform="translate(-1.6 0) rotate(-5 12 12)"/>
          <path d="${SHIELD_R}" fill="#e5484d" stroke="#fff" stroke-width="1.8" transform="translate(1.6 .6) rotate(5 12 12)"/>`)}</g>`);
      }
      // Autres joueurs présents : jusqu'à 3 pastilles superposées, puis une pastille « + » s'il y en a plus de 3.
      // Les factions alternent dans la pile, pour que plusieurs camps restent visibles d'un coup d'œil.
      const groups = new Map();
      for (const o of (st.occupants || []).filter((x) => !x.me)) { if (!groups.has(o.faction)) groups.set(o.faction, []); groups.get(o.faction).push(o); }
      const others = [];
      for (let i = 0; others.length < (st.occupants || []).length; i += 1) {
        let added = false;
        for (const g of groups.values()) if (g[i]) { others.push(g[i]); added = true; }
        if (!added) break;
      }
      if (others.length) {
        const shown = others.slice(0, 3);
        const extra = others.length > 3;
        const slots = shown.length + (extra ? 1 : 0);
        const r = 8 * u, step = 11 * u;
        const y = s.y + 21 * u;
        const x0 = s.x - ((slots - 1) * step) / 2;
        shown.forEach((o, i) => {
          const cx = x0 + i * step;
          const id = `pin-${st.id}-${i}`;
          parts.push(`<g class="pin"><clipPath id="${esc(id)}"><circle cx="${cx}" cy="${y}" r="${r}"/></clipPath>
            <circle cx="${cx}" cy="${y}" r="${r + 1.2 * u}" fill="#fff"/>
            <image href="${avatarUrl(o.avatar)}" x="${cx - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${esc(id)})" preserveAspectRatio="xMidYMin slice"/>
            <circle cx="${cx}" cy="${y}" r="${r - 0.6 * u}" fill="none" stroke="${esc(faction(o.faction)?.color || '#888')}" stroke-width="${2.6 * u}"/></g>`);
        });
        if (extra) {
          const cx = x0 + shown.length * step;
          const k = 3.6 * u;
          parts.push(`<g class="pin pin-more"><circle cx="${cx}" cy="${y}" r="${r + 1.2 * u}" fill="#fff"/><circle cx="${cx}" cy="${y}" r="${r}" fill="#1b2030"/>
            <path d="M${cx - k} ${y}H${cx + k}M${cx} ${y - k}V${y + k}" stroke="#fff" stroke-width="${1.8 * u}" stroke-linecap="round"/></g>`);
        }
      }
    }
    const p = me();
    const s = p.territory && shape(p.territory);
    if (s && p.status !== 'dead') {
      parts.push(`<g transform="translate(${s.x} ${s.y})"><circle r="${8 * u}" fill="${esc(faction(myFaction()).color)}" stroke="#fff" stroke-width="${3 * u}"/>
        <circle r="${2.5 * u}" fill="#fff"/></g>`);
    }
    markers.innerHTML = parts.join('');
  };

  // Les actions secondaires (renforts payés, appel à l'aide, retours alternatifs) ont un bouton discret.
  const QUIET = new Set(['hire', 'rally', 'teleport', 'revive-renown', 'revive-ask']);
  const btn = (act, label, disabled) => `<button type="button" class="btn compact ${QUIET.has(act) ? 'ghost' : ''}" data-act="${act}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
  const bindActs = (box) => {
    box.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => {
      box.querySelectorAll('[data-act]').forEach((x) => { x.disabled = true; });
      doAct(el.dataset.act);
    }));
    box.querySelectorAll('[data-goto-tab]').forEach((el) => el.addEventListener('click', () => go(el.dataset.gotoTab)));
  };
  const drawInfo = () => {
    const box = view.querySelector('.info');
    const tr = shape(state.selected);
    const p = me();
    const costs = state.map?.costs || {};
    const mine = state.me.character;
    // Tombé : trois façons de revenir (or, niveau de renommée, aide d'un allié), sauf si la faction est hors jeu.
    const banner = p.status === 'dead'
      ? (state.map?.exile
        ? `<p class="banner">${esc(t('camp.outExile'))}</p>
          <div class="row act-row"><button type="button" class="btn compact" data-goto-tab="journal">${esc(t('camp.chooseBanner'))}</button></div>`
        : p.factionOut ? `<p class="banner">${esc(t('camp.out'))}</p>` : `<p class="banner">${esc(t('camp.dead'))}</p>
          <div class="row act-row">${btn('revive-gold', costs.revive ? t('camp.reviveGold', { gold: fmtNum(costs.revive) }) : t('camp.reviveFree'), mine.gold < costs.revive)}
            ${btn('revive-renown', t('camp.reviveRenown'), mine.renown.level < 1)}
            ${btn('revive-ask', t(p.reviveAsked ? 'camp.reviveAsked' : 'camp.reviveAsk'), p.reviveAsked)}</div>`)
      : p.status === 'retreating' ? `<p class="banner">${withTimer('camp.retreating', {}, p.retreatUntil)}</p>` : '';
    if (!tr) { box.innerHTML = banner + `<p class="muted">${esc(t('map.hint'))}</p>`; bindActs(box); return; }
    const st = live(tr.id);
    const owner = st.faction ? faction(st.faction) : null;
    const near = neighborsOf(tr.id);
    const b = st.battle;
    const here = p.territory === tr.id;
    const noAct = !(p.actions > 0);
    // Gardiens : défendre comme chez soi le territoire d'une autre faction attaqué (Loups de cendre pour l'Église de Seiros).
    const guarding = !!b && state.map?.guardians?.[myFaction()] === st.faction && b.defender === st.faction;
    const shielded = !!st.untouchableUntil && st.untouchableUntil > serverNow();
    const counterBonus = state.config.campaign?.counter?.attackBonus || 0;
    const tags = [st.importance > 1 ? t('camp.importance', { n: st.importance }) : '', st.annex ? t('camp.annex') : ''].filter(Boolean);
    const present = Object.entries(st.players || {}).map(([f, n]) => `<span class="who-here" title="${esc(loc(faction(f)?.name))}">
      <span class="dot" style="--c:${esc(faction(f)?.color || '#888')}"></span>${n}</span>`).join('');

    // Ce que je peux faire ici : agir sur mon territoire, m'y déplacer s'il est voisin, ou m'y replier.
    let actions = '';
    if (p.status === 'retreating') {
      if (isHome(tr.id)) actions = btn('retreat', t('camp.retreat'), false);
    } else if (p.status === 'alive') {
      if (here && st.faction === myFaction()) actions = btn('defend', t('camp.defend'), noAct) + btn('gather', t('camp.gather'), noAct || !!b);
      else if (here && guarding) actions = btn('defend', t('camp.defend'), noAct);
      else if (here) actions = btn('attack', t('camp.attack'), noAct || (b && b.attacker !== myFaction()) || shielded);
      else if (near.includes(p.territory)) {
        actions = canEnter(tr.id) ? btn('move', t('camp.move'), noAct) : `<p class="muted small">${esc(t('camp.cantEnter'))}</p>`;
      }
      if (here) {
        // Sans dépenser d'action : payer un renfort (fortification chez soi, bataillon dans une attaque de sa faction)…
        const home = st.faction === myFaction() || guarding;
        if (home || (b && b.attacker === myFaction())) {
          const hired = b ? b.hired : st.garrisonHired;
          const price = home ? costs.fortify : costs.hire; // le Prêtre fortifie à moitié prix
          actions += btn('hire', t(home ? 'camp.hireDefense' : 'camp.hireAttack', { gold: fmtNum(price) }), hired >= costs.hireMax || mine.gold < price);
        }
        // … et appeler sa faction à l'aide, une fois par bataille.
        if (b && (b.attacker === myFaction() || b.defender === myFaction())) actions += btn('rally', t(b.rallied ? 'camp.rallied' : 'camp.rally'), b.rallied);
      }
      // Évêque noir : se téléporter vers un territoire de sa faction ou voisin de sa faction, sans dépenser d'action.
      if (!here && costs.teleport != null && myEffects().some((e) => e.kind === 'teleport') && canEnter(tr.id)) {
        actions += btn('teleport', t('camp.teleport', { gold: fmtNum(costs.teleport) }), mine.gold < costs.teleport);
      }
    }
    box.innerHTML = `${banner}
      <div class="terr-head"><h3>${esc(loc(tr.name))}</h3>${here ? `<span class="pill">${esc(t('camp.you'))}</span>` : ''}</div>
      <p class="muted small">${owner
    ? `${esc(t('map.owned'))} <span style="color:${esc(owner.color)}">${esc(loc(owner.name))}</span>`
    : esc(t('map.neutral'))}${tags.length ? ' · ' + esc(tags.join(' · ')) : ''}${present ? ` · ${present}` : ''}</p>
      ${(st.occupants || []).length ? `<div class="present-list" aria-label="${esc(t('camp.present'))}">${st.occupants.map((o) => {
    const of = faction(o.faction);
    return `<span class="who ${o.me ? 'me' : ''}" style="--c:${esc(of?.color || '#888')}">
        <img src="${avatarUrl(o.avatar)}" alt=""><span><b>${esc(o.pseudo)}</b>
        <small>${esc(of ? loc(of.name) : o.faction)} · ${esc(className(o.class))} · ${esc(t('menu.playerRenown', { level: o.level }))}${o.retreating ? ' · ' + esc(t('camp.retreatingTag')) : ''}</small></span></span>`;
  }).join('')}</div>` : ''}
      ${b ? `<p class="small battle-line">${withTimer(numKey('camp.battle', b.attacker), { attacker: loc(faction(b.attacker)?.name), chance: b.chance }, b.endsAt)}
        · ${esc(t('camp.forces', { attackers: b.attackers, defenders: b.defenders }))}</p>` : ''}
      ${shielded ? `<p class="small note">${withTimer('camp.untouchable', {}, st.untouchableUntil)}</p>` : ''}
      ${st.counter && !shielded ? `<p class="small note">${esc(t('camp.counter', { pct: st.counterPct || counterBonus }))}</p>` : ''}
      ${actionError ? `<p class="error" role="alert">${esc(actionError)}</p>` : ''}
      ${actionNote ? `<p class="small note">${esc(actionNote)}</p>` : ''}
      ${p.rewardDebuff > 0 ? `<p class="small note">${esc(t('camp.rewardDebuff', { n: p.rewardDebuff }))}</p>` : ''}
      ${actions ? `<div class="row act-row">${actions}</div>` : ''}
      ${near.length ? `<div class="chips">${near.map((id) => {
    const o = ownerOf(id) ? faction(ownerOf(id)) : null;
    return `<button type="button" class="chip" data-goto="${esc(id)}"><span class="dot" style="--c:${esc(o ? o.color : '#6b7287')}"></span>${esc(loc(shape(id).name))}</button>`;
  }).join('')}</div>` : `<p class="muted small">${esc(t('map.noNeighbors'))}</p>`}`;
    box.querySelectorAll('[data-goto]').forEach((el) => el.addEventListener('click', () => select(el.dataset.goto, true)));
    bindActs(box);
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
    // Le territoire choisi passe au-dessus des autres pour que son contour reste entier ; les repères restent tout en haut.
    const sel = svg.querySelector('.terr.selected');
    if (sel) svg.appendChild(sel);
    svg.appendChild(markers);
  };
  const refresh = () => { paint(); drawMarkers(); drawInfo(); };
  const select = (id, reveal) => {
    state.selected = id;
    actionError = '';
    actionNote = '';
    paint();
    drawInfo();
    if (reveal) svg.querySelector('.terr.selected')?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    if (!state.viewedTerritory) { state.viewedTerritory = true; track('territory_viewed'); }
  };
  // Envoie une action de campagne ; le serveur renvoie le joueur et la carte à jour.
  const doAct = async (act) => {
    const [path, body] = act === 'move' ? ['/move', { to: state.selected }]
      : act === 'retreat' ? ['/retreat', { to: state.selected }]
        : act === 'teleport' ? ['/teleport', { to: state.selected }]
        : act === 'rally' ? ['/rally', {}]
          : act.startsWith('revive-') ? ['/revive', { mode: act.slice(7) }] : ['/act', { action: act }];
    actionError = '';
    actionNote = '';
    try {
      const res = await api(path, body);
      setMe(res);
      setMap(res.map);
      if (res.bonus) actionNote = t('camp.bonus', { gold: res.bonus });
      if (res.free) actionNote = t('camp.freeMove'); // déplacement gratuit (Chevalier pégase, Chevalier faucon)
      // De retour en jeu : la carte se place sur le territoire où l'on réapparaît.
      if (act.startsWith('revive-') && res.player.status === 'alive') state.selected = res.player.territory;
    } catch (err) {
      if (err.status === 401) return sessionLost();
      actionError = err.message;
    }
    if (state.tab === 'map' && inner.isConnected) refresh();
  };
  const reload = async () => {
    try {
      setMap(await api('/map'));
    } catch (err) {
      if (err.status === 401) sessionLost();
      return;
    }
    if (state.tab !== 'map' || !inner.isConnected) return;
    drawTopbar();
    // À l'ouverture, le territoire où je me trouve est sélectionné.
    if (!shape(state.selected) && me().territory) state.selected = me().territory;
    refresh();
  };
  mapView = { reload };

  svg.addEventListener('click', (e) => {
    const p = e.target.closest('.terr');
    if (p) select(p.dataset.id);
  });
  svg.addEventListener('keydown', (e) => {
    const p = e.target.closest('.terr');
    if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(p.dataset.id); }
  });
  view.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', drawMarkers));
  refresh();
  await reload();
}

async function renderMenu() {
  const view = document.getElementById('view');
  view.className = 'view scroll';

  const draw = () => {
    const ch = state.me.character;
    const f = faction(ch.faction);
    const counts = Object.fromEntries(state.config.factions.map((x) => [x.id, 0]));
    for (const tr of state.territories) if (tr.faction) counts[tr.faction] += 1;
    const points = state.map?.points || {};
    const rk = state.map?.ranking;
    const pk = state.map?.perks;
    // Titres gagnés (distinctions), avec leur nombre quand on les a obtenus plusieurs fois.
    const dist = (state.me.distinctions || []).map((d) => {
      const def = (state.config.distinctions || []).find((x) => x.id === d.id);
      return def ? esc(loc(def.name)) + (d.count > 1 ? ` ×${d.count}` : '') : null;
    }).filter(Boolean);
    const playable = state.config.factions.filter((x) => !x.npc && (!x.secret || x.id === ch.faction || points[x.id] > 0));
    // Factions non jouables ou secrète : affichées seulement si elles tiennent un territoire ou ont des joueurs.
    const shownFactions = state.config.factions.filter((x) => (!x.secret && !x.npc) || x.id === ch.faction || counts[x.id] > 0
      || state.players.some((p) => p.faction === x.id));
    view.innerHTML = `
      <button class="btn ghost" type="button" data-rules>${esc(t('menu.rules'))}</button>
      <button class="btn ghost" type="button" data-patches>${esc(t('menu.patches'))}${patchUnread() ? `<span class="new-dot" title="${esc(t('patch.new'))}"></span>` : ''}</button>

      <section class="card">
        <h2>${esc(t('menu.character'))}</h2>
        <div class="profile">
          <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
          <div><h3>${esc(ch.pseudo)}</h3><span class="pill">${esc(loc(f.name))}</span>
            ${state.me.player?.exile ? `<span class="pill">${esc(t('exile.tag'))} · ${esc(loc(faction(effFaction()).name))}</span>` : ''}</div>
        </div>
        <dl class="kv">
          <dt>${esc(t('menu.class'))}</dt><dd>${esc(className(ch.class))}</dd>
          <dt>${esc(t('menu.birthday'))}</dt><dd>${esc(fmtDate(ch.birthday))}</dd>
          <dt>${esc(t('menu.gold'))}</dt><dd>${fmtNum(ch.gold)}</dd>
          <dt>${esc(t('menu.renown'))}</dt><dd>${esc(t('menu.renownValue', ch.renown))}</dd>
          ${dist.length ? `<dt>${esc(t('menu.distinctions'))}</dt><dd>${dist.join(', ')}</dd>` : ''}
          <dt>${esc(t('menu.email'))}</dt><dd>${esc(state.me.user.email)}</dd>
        </dl>
        <div class="row">
          <button class="btn ghost" type="button" data-avatars>${esc(t('avatars.change'))}</button>
          <button class="btn ghost" type="button" data-classes>${esc(t('classes.change'))}</button>
        </div>
      </section>

      <section class="card">
        <h2>${esc(t('menu.effects'))}</h2>
        <p class="muted small">${esc(t('menu.effectsHint'))}</p>
        ${(ch.path || []).map((id) => klass(id)).filter((c) => c && effectText(c)).map((c) => `
          <div class="fx-line">${classIcon(c)}<div><strong>${esc(loc(c.name))}</strong><span class="small">${esc(effectText(c))}</span></div></div>`).join('') || `<p class="muted small">${esc(t('menu.noEffects'))}</p>`}
      </section>

      <section class="card">
        <h2>${esc(t('menu.faction'))}</h2>
        <div class="faction-line">
          <img class="faction-logo" src="${esc(f.logo)}" alt="">
          <div><strong style="color:${esc(f.color)}">${esc(loc(f.name))}</strong><p class="muted small">${esc(loc(f.description))}</p></div>
        </div>
        ${pk ? `<ul class="perks">
          ${pk.outnumberedMax ? `<li>${esc(t('perk.outnumbered', { n: fmtNum(pk.powerBonus), max: pk.outnumberedMax }))}</li>` : ''}
          ${pk.neverOut ? `<li>${esc(t('perk.neverOut'))}</li>` : ''}
          ${pk.autoRetreat ? `<li>${esc(t('perk.autoRetreat'))}</li>` : ''}
          ${pk.freeRevive ? `<li>${esc(t('perk.freeRevive'))}</li>` : ''}
          ${pk.rewardMultiplier > 1 ? `<li>${esc(t('perk.rewards', { n: pk.rewardMultiplier }))}</li>` : ''}
          ${pk.hiddenAtBase ? `<li>${esc(t('perk.hidden', { place: loc(state.config.map.territories.find((x) => x.id === state.map.homeBases[ch.faction])?.name) }))}</li>` : ''}
          ${pk.pointsMultiplier > 1 ? `<li>${esc(t('perk.points', { n: pk.pointsMultiplier }))}</li>` : ''}
        </ul>` : ''}
      </section>

      <section class="card">
        <h2>${esc(t('camp.title'))}</h2>
        ${state.map ? `<p><strong>${esc(t('camp.number', { n: state.map.campaign.id }))}</strong></p>` : ''}
        <p class="muted small">${esc(t('camp.points'))} — ${esc(t('camp.pointsHint'))}</p>
        ${[...playable].sort((a, b) => (points[b.id] || 0) - (points[a.id] || 0)).map((x) => `
          <div class="score" style="--c:${esc(x.color)}"><span class="dot"></span>${esc(loc(x.name))}<span class="n">${esc(t('camp.pts', { n: fmtNum(points[x.id] || 0) }))}</span></div>`).join('')}
      </section>

      ${rk ? `<section class="card">
        <h2>${esc(t('camp.ranking'))}</h2>
        <p class="muted small">${esc(t('camp.rankingHint', { rewards: rk.rewards.map(fmtNum).join(' / ') }))}</p>
        ${rk.top.map((r) => `<div class="player rank ${r.me ? 'me' : ''}">
            <img class="avatar" src="${avatarUrl(r.avatar)}" alt="">
            <div><strong>${r.rank}. ${esc(r.pseudo)}</strong><small style="color:${esc(faction(r.faction)?.color || '#888')}">${esc(loc(faction(r.faction)?.name))}</small></div>
            <span class="n">${esc(t('camp.pts', { n: fmtNum(r.score) }))}</span></div>`).join('') || `<p class="muted small">${esc(t('camp.rankingEmpty'))}</p>`}
        <p class="small">${esc(rk.me.rank ? t('camp.myRank', { rank: rk.me.rank, score: fmtNum(rk.me.score) }) : t('camp.myRankNone'))}</p>
      </section>` : ''}

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
    view.querySelector('[data-patches]').addEventListener('click', () => go('patches'));
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
    setMap(map);
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
  if (p.distinction) p.distinction = loc((state.config.distinctions || []).find((x) => x.id === p.distinction)?.name) || p.distinction;
  for (const k of ['territory', 'home']) if (p[k]) p[k] = loc(state.config.map.territories.find((x) => x.id === p[k])?.name) || p[k];
  for (const k of ['gold', 'xp', 'points', 'rank']) if (typeof p[k] === 'number') p[k] = fmtNum(p[k]);
  return { title: t(`notif.${n.type}.title`, p), body: t(numKey(`notif.${n.type}.body`, n.params.faction), p) };
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
  const order = { done: 0, active: 1, claimed: 2 };
  const card = (m, attr) => `
    <article class="card mission ${m.status}">
      <div class="notif-head"><strong>${esc(loc(m.title))}</strong>
        ${m.status === 'claimed' ? `<span class="muted small">${esc(t('missions.claimed'))}</span>` : ''}</div>
      <p class="muted small">${esc(loc(m.description))}</p>
      ${m.status === 'active' ? `<div class="progress"><span class="xpbar"><i style="width:${(m.current / m.target) * 100}%"></i></span>
        <small class="muted">${m.current} / ${m.target}</small></div>` : ''}
      <div class="rewards">${rewardText(m.rewards)}
        ${m.status === 'done' ? `<button type="button" class="btn compact" ${attr}="${esc(m.id)}">${esc(t('missions.claim'))}</button>` : ''}</div>
    </article>`;
  const sorted = (list) => [...list].sort((a, b) => order[a.status] - order[b.status]);
  // data : { missions, daily } tel que renvoyé par le serveur.
  const draw = (data, error) => {
    const { missions = [], daily, specials = [] } = data;
    view.innerHTML = panelHead(t('missions.title'))
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      + (daily && daily.missions.length ? `
        <div class="section-head"><h2>${esc(t('daily.title'))}</h2>
          <span class="pill">${esc(t('daily.streak', { n: daily.streak }))}</span></div>
        <p class="muted small">${esc(t('daily.hint'))} ${esc(t('daily.bonus', { n: daily.bonus }))}</p>
        ${daily.frozen ? `<p class="note small">${esc(t('daily.frozen'))}</p>` : ''}
        ${sorted(daily.missions).map((m) => card(m, 'data-claim-daily')).join('')}
        ${daily.exile && daily.exile.length ? `<div class="section-head"><h2>${esc(t('daily.exile'))}</h2></div>
          <p class="muted small">${esc(t('daily.exileHint'))}</p>
          ${sorted(daily.exile).map((m) => card(m, 'data-claim-daily')).join('')}` : ''}
        <div class="section-head"><h2>${esc(t('missions.main'))}</h2></div>` : '')
      + (missions.length ? sorted(missions).map((m) => card(m, 'data-claim')).join('') : (error ? '' : `<p class="muted">${esc(t('missions.empty'))}</p>`))
      + (specials.length ? `<details class="card specials" ${state.specialsOpen ? 'open' : ''}>
          <summary><strong>${esc(t('missions.specials'))}</strong>
            <span class="pill">${specials.filter((x) => x.done).length} / ${specials.length}</span></summary>
          <p class="muted small">${esc(t('missions.specialsHint'))}</p>
          ${specials.map((x) => `<div class="special ${x.done ? 'done' : ''}">
            <img class="avatar" src="${avatarUrl(x.avatar)}" alt="">
            <div><strong>${esc(loc(x.title))}</strong><p class="muted small">${esc(loc(x.description))}</p>
              ${x.done ? `<small class="muted">${esc(t('missions.obtained'))}</small>`
    : `<div class="progress"><span class="xpbar"><i style="width:${(x.current / x.target) * 100}%"></i></span><small class="muted">${fmtNum(x.current)} / ${fmtNum(x.target)}</small></div>`}</div>
          </div>`).join('')}
        </details>` : '');
    view.querySelector('.specials')?.addEventListener('toggle', (e) => { state.specialsOpen = e.target.open; });
    bindClose(view);
    const claim = (attr, path) => view.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await api(path, { id: b.getAttribute(attr) });
        setMe(res);
        if (state.tab === 'missions' && view.isConnected) draw(res);
      } catch (err) {
        if (err.status === 401) return sessionLost();
        draw(data, err.message);
      }
    }));
    claim('data-claim', '/missions/claim');
    claim('data-claim-daily', '/missions/daily/claim');
  };
  view.innerHTML = panelHead(t('missions.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  try {
    const data = await api('/missions');
    if (state.tab === 'missions' && view.isConnected) draw(data);
    refreshMe();
  } catch (err) {
    if (err.status === 401) return sessionLost();
    draw({}, t('missions.error'));
  }
}

// Journal du monde : derniers événements de la carte, et alliés tombés qui demandent de l'aide.
let journalView = null;
async function renderJournal() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const head = `<div class="panel-head"><h1 class="page-title">${esc(t('journal.title'))}</h1></div>`;
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  const ago = (at, now) => {
    const min = Math.floor((now - at) / 60000);
    if (min < 1) return t('time.now');
    if (min < 60) return t('time.min', { n: min });
    if (min < 1440) return t('time.hour', { n: Math.floor(min / 60) });
    return t('time.day', { n: Math.floor(min / 1440) });
  };
  // Phrase d'un événement, et faction dont la couleur le marque.
  const describe = (e) => {
    const p = { ...e.params };
    const main = p.attacker || p.faction;
    for (const k of ['faction', 'attacker', 'defender', 'from']) if (p[k]) p[k] = loc(faction(p[k])?.name) || p[k];
    if (p.territory) p.territory = terrName(p.territory);
    let key = 'journal.' + e.type;
    if (e.type === 'battle_started' && p.defender) key += '_def';
    if (e.type === 'campaign_ended' && !p.faction) key += '_draw';
    if (['battle_started', 'territory_taken', 'faction_out'].includes(e.type)) key = numKey(key, main);
    return hasText(key) ? { text: t(key, p), color: faction(main)?.color } : null;
  };
  let error = '';
  const draw = (data) => {
    const events = data.events.map((e) => ({ e, d: describe(e) })).filter((x) => x.d);
    view.innerHTML = head
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      // Faction hors jeu : choix d'une bannière à rejoindre en exil.
      + (data.exile ? `<section class="card exile"><h2>${esc(t('exile.title'))}</h2>
          <p class="small">${esc(t('exile.intro', { malus: data.exile.malus }))}</p>
          ${data.exile.options.length ? `<div class="row">${data.exile.options.map((f) => `<button type="button" class="btn compact" data-exile="${esc(f)}">${esc(t('exile.join', { faction: loc(faction(f)?.name) }))}</button>`).join('')}</div>
            <p class="muted small">${esc(t('exile.note'))}</p>` : `<p class="muted small">${esc(t('exile.none'))}</p>`}
        </section>` : '')
      + (data.fallen.length ? `<section class="card"><h2>${esc(t('journal.fallen'))}</h2>
          ${data.fallen.map((f) => `<div class="fallen"><strong>${esc(f.pseudo)}</strong>
            <button type="button" class="btn compact" data-pay="${f.id}" ${state.me.character.gold < data.reviveCost ? 'disabled' : ''}>${esc(t('journal.pay', { gold: fmtNum(data.reviveCost) }))}</button></div>`).join('')}
        </section>` : '')
      + (events.length ? events.map(({ e, d }) => `<article class="card event" style="--c:${esc(d.color || '#6b7287')}">
          <p>${esc(d.text)}</p><small class="muted">${esc(ago(e.at, data.now))}</small></article>`).join('')
        : `<p class="muted">${esc(t('journal.empty'))}</p>`);
    view.querySelectorAll('[data-exile]').forEach((b) => b.addEventListener('click', async () => {
      view.querySelectorAll('[data-exile]').forEach((x) => { x.disabled = true; });
      error = '';
      try {
        const res = await api('/exile', { faction: b.dataset.exile });
        setMe(res);
        setMap(res.map);
        state.selected = res.player.territory; // la carte s'ouvre sur le territoire où l'exilé apparaît
        go('map');
        return;
      } catch (err) {
        if (err.status === 401) return sessionLost();
        error = err.message;
      }
      reload();
    }));
    view.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      error = '';
      try {
        const res = await api('/revive/pay', { id: Number(b.dataset.pay) });
        setMe(res);
        setMap(res.map);
      } catch (err) {
        if (err.status === 401) return sessionLost();
        error = err.message;
      }
      reload();
    }));
  };
  const reload = async () => {
    let data;
    try { data = await api('/journal'); } catch (err) {
      if (err.status === 401) return sessionLost();
      if (state.tab === 'journal' && view.isConnected) view.innerHTML = head + `<p class="error">${esc(t('journal.error'))}</p>`;
      return;
    }
    if (state.tab === 'journal' && view.isConnected) draw(data);
  };
  journalView = { reload };
  view.innerHTML = head + `<p class="muted">${esc(t('common.loading'))}</p>`;
  await reload();
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

// Notes de mise à jour : les plus récentes d'abord. Les ouvrir les marque comme lues (la pastille disparaît).
function renderPatches() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const patches = state.config.patches || [];
  const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
  view.innerHTML = panelHead(t('patch.title')) + (patches.length ? patches.map((pt) => `
    <section class="card patch">
      <h2>${esc(loc(pt.title))}${pt.date ? ` <span class="muted small">· ${esc(fmt(pt.date))}</span>` : ''}</h2>
      ${pt.intro ? `<p class="muted">${esc(loc(pt.intro))}</p>` : ''}
      ${(pt.sections || []).map((sec) => `<h3>${esc(loc(sec.title))}</h3>
        <ul class="patch-list">${(sec.items || []).map((i) => `<li>${esc(loc(i))}</li>`).join('')}</ul>`).join('')}
    </section>`).join('') : `<p class="muted">${esc(t('patch.empty'))}</p>`);
  bindClose(view);
  if (patchUnread()) {
    state.me.patch = { ...state.me.patch, seen: state.me.patch.latest };
    document.querySelector('.tabbar .new-dot')?.remove();
    api('/patch/seen', {}).catch(() => {});
  }
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
              ${effectText(c) ? `<span class="small">${esc(effectText(c))}</span>` : ''}
              ${loc(c.description) ? `<span class="muted small">${esc(loc(c.description))}</span>` : ''}
              ${(c.requires || []).length ? `<span class="muted small">${esc(t('classes.requires', { list: requiresText(c) }))}</span>` : ''}
              ${c.unlock ? `<span class="muted small">${esc(unlockText(c))}</span>` : ''}</div></li>`).join('')}
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
        ${effectText(sel) ? `<p class="small effect">${esc(effectText(sel))}</p>` : ''}
        ${sel.unlock && access.why !== unlockText(sel) ? `<p class="muted small">${esc(unlockText(sel))}</p>` : ''}
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
  // Comptes à rebours, et état de la carte (batailles, positions) toutes les 10 secondes quand elle est ouverte.
  setInterval(tickTimers, 1000);
  setInterval(() => {
    if (document.hidden || !state.me?.character) return;
    if (state.tab === 'map' && mapView) mapView.reload();
    if (state.tab === 'journal' && journalView) journalView.reload();
  }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMe(); });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
start();
