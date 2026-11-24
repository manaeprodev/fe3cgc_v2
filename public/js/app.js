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
const klass = (id) => state.config.classes.find((c) => c.id === id) || (state.config.npcClasses || []).find((c) => c.id === id);
// Généraux : personnages non joueurs (config « generals »), avec leur portrait.
const generalName = (id) => (state.config.generals?.roster || []).find((g) => g.id === id)?.name || id;
const occImg = (o) => (o.general ? esc(o.avatar) : avatarUrl(o.avatar));
const className = (id) => loc(klass(id)?.name) || id;
// Carte de faction : drapeau de la maison, drapeau de sa nation en fondu à l'arrière-plan, et le seigneur en pied à droite.
const factionHero = (f, extra = '') => `<span class="faction-hero" style="--c:${esc(f.color)}">
  ${f.nation ? `<img class="fh-nation" src="${esc(f.nation)}" alt="" loading="lazy">` : ''}
  <img class="fh-flag" src="${esc(f.logo)}" alt="${esc(loc(f.name))}">
  <span class="fh-text">${extra}</span>
  ${f.lord ? `<img class="fh-lord" src="${esc(f.lord)}" alt="" loading="lazy">` : ''}</span>`;
// Petit drapeau de faction pour les listes et pastilles.
const flag = (id) => { const f = faction(id); return f?.logo ? `<img class="flag" src="${esc(f.logo)}" alt="">` : ''; };
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
    err.code = data.error;
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
  if (state.me.user && state.me.user.verified === false) return renderVerify();
  if (!ch) return state.step === 1 ? renderCharacter() : renderFaction();
  return renderGame();
}

// Après connexion : reprend la langue du compte si cet appareil n'en a pas encore choisi une.
async function signedIn(me) {
  state.me = me;
  if (!storedLang() && me.user.lang && me.user.lang !== state.lang) await setLang(me.user.lang);
  else if (me.user.lang !== state.lang) api('/lang', { lang: state.lang }).catch(() => {});
  showResult();
  maybeGameOver();
  showMajorPatch();
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
// Confirmation de l'adresse email : le code à 6 chiffres reçu par email, avant de créer son personnage.
function renderVerify() {
  app.innerHTML = `
    <div class="page">
      <div class="page-top"><div><p class="steps">${esc(t('verify.step'))}</p><h1 class="page-title">${esc(t('verify.title'))}</h1></div>${langPicker()}</div>
      <p class="notice">${esc(t('verify.intro', { email: state.me.user.email }))}</p>
      <form novalidate>
        <label class="field"><span>${esc(t('verify.code'))}</span>
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" class="code-input" required></label>
        <p class="error" role="alert" hidden></p>
        <button class="btn" type="submit">${esc(t('verify.submit'))}</button>
      </form>
      <p class="muted small">${esc(t('verify.spam'))}</p>
      <div class="row"><button type="button" class="btn ghost compact" data-resend>${esc(t('verify.resend'))}</button>
        <button type="button" class="btn ghost compact" data-logout>${esc(t('common.logout'))}</button></div>
    </div>`;
  const form = app.querySelector('form');
  const err = app.querySelector('.error');
  const show = (m) => { err.textContent = m; err.hidden = !m; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    show('');
    try {
      const me = await api('/verify', { code: form.code.value });
      state.me = { ...state.me, ...me };
      render();
    } catch (ex) { show(ex.message); }
  });
  app.querySelector('[data-resend]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/verify/resend', {}); flash(t('verify.sent')); } catch (ex) { show(ex.message); }
    setTimeout(() => { e.target.disabled = false; }, 60_000);
  });
  app.querySelector('[data-logout]').addEventListener('click', logout);
  form.code.focus();
}

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
            ${factionHero(f, `<strong class="faction-name">${esc(loc(f.name))}</strong><span class="faction-desc">${esc(loc(f.description))}</span>`)}
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
const VIEWS = { map: renderMap, menu: renderMenu, notifs: renderNotifs, missions: renderMissions, rules: renderRules, classes: renderClasses, avatars: renderAvatars, journal: renderJournal, patches: renderPatches, install: renderInstall, impact: renderImpact, pantheon: renderPantheon, pushsettings: renderPush, bug: renderBug, exile: renderExile };

function go(tab) {
  if (['map', 'menu', 'journal'].includes(state.tab)) state.back = state.tab;
  state.tab = tab;
  renderGame();
}

function renderGame() {
  const menuSide = ['menu', 'rules', 'classes', 'avatars', 'patches', 'install', 'impact', 'pantheon', 'pushsettings', 'bug'].includes(state.tab);
  app.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <main class="view" id="view"></main>
    <nav class="tabbar">
      <button type="button" data-tab="map" class="${state.tab === 'map' ? 'active' : ''}">${esc(t('tab.map'))}</button>
      <button type="button" data-tab="journal" class="${state.tab === 'journal' ? 'active' : ''}">${esc(t('tab.journal'))}${journalUnread() ? '<span class="new-dot journal-dot"></span>' : ''}</button>
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
  if (map.player?.regenGold) flash(t('relfx.regenGold', { gold: map.player.regenGold })); // Hilda
  maybeGameOver();
  updateJournalDot();
}
// Pastille du Journal : un événement plus récent que le dernier lu sur cet appareil.
const journalKey = () => `journalSeen:${state.me?.user?.id}`;
function journalSeen() {
  try { return Number(localStorage.getItem(journalKey()) || 0) || state.journalSeenMem || 0; } catch { return state.journalSeenMem || 0; }
}
function markJournalSeen(id) {
  state.journalSeenMem = Math.max(state.journalSeenMem || 0, id || 0);
  try { localStorage.setItem(journalKey(), String(state.journalSeenMem)); } catch { /* mémoire de la session */ }
  updateJournalDot();
}
const journalUnread = () => state.tab !== 'journal' && (state.map?.journalLatest || 0) > journalSeen();
function updateJournalDot() {
  const btn = document.querySelector('.tabbar [data-tab="journal"]');
  if (!btn) return;
  const dot = btn.querySelector('.journal-dot');
  if (journalUnread() && !dot) btn.insertAdjacentHTML('beforeend', '<span class="new-dot journal-dot"></span>');
  if (!journalUnread() && dot) dot.remove();
}
let mapView = null; // fonctions de l'écran Carte ouvert, pour le rafraîchir sans tout redessiner
// Chaque seconde : met à jour les comptes à rebours ; à l'échéance, redemande l'état au serveur.
let refreshDue = 0;
function tickTimers() {
  let expired = false;
  // Une réaction du journal disparaît dès que l'action n'est plus en cours.
  document.querySelectorAll('[data-expire]').forEach((el) => { if (Number(el.dataset.expire) <= serverNow()) el.remove(); });
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
    ${f.nation ? `<img class="top-nation" src="${esc(f.nation)}" alt="">` : ''}
    <div class="topbar-row">
      <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
      <div class="who"><strong>${esc(ch.pseudo)}${pl?.exile ? ` <span class="tag">${esc(t('exile.tag'))}</span>` : ''}</strong>
        <span class="muted small">${classIcon(klass(ch.class))}${esc(className(ch.class))} · <img class="top-flag" src="${esc(f.logo)}" alt="${esc(loc(f.name))}" title="${esc(loc(f.name))}"></span></div>
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
      ${pl?.hp && pl.status !== 'dead' ? `<span class="res hp ${pl.hp.pct < 25 ? 'crit' : pl.hp.pct < 50 ? 'low' : ''}" title="${esc(t('hp.title', { hp: pl.hp.hp, max: pl.hp.max }))}">
        <span class="hp-ico" aria-hidden="true">\u2764\uFE0F</span><strong>${pl.hp.hp}</strong><small class="muted">/ ${pl.hp.max}</small></span>` : ''}
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
  state.me = { user: me.user, character: me.character, unread: me.unread, claimable: me.claimable, player: me.player, distinctions: me.distinctions || [], stats: me.stats || {}, patch: me.patch || null, result: me.result || null, tutorial: me.tutorial || null };
  syncClock(me.player);
  showResult();
  maybeGameOver();
  showMajorPatch();
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
    go(['rules', 'classes', 'avatars', 'patches', 'install', 'impact', 'pantheon', 'pushsettings', 'bug'].includes(state.tab) ? 'menu' : state.back || 'map');
  });
}

// Premier pas : liste d'étapes à cocher (d'après les actions réelles), puis récompense à récupérer.
function tutorialHtml() {
  const tu = state.me?.tutorial;
  if (!tu) return '';
  const done = tu.steps.filter((x) => x.done).length;
  const next = tu.steps.find((x) => !x.done);
  return `<details class="tutorial" ${state.tutorialOpen ? 'open' : ''}><summary><strong>${esc(t('tutorial.title'))}</strong> <span class="pill">${esc(t('tutorial.progress', { done, total: tu.steps.length }))}</span>${next ? ` <small class="muted">${esc(loc(next.title))}</small>` : ''}</summary>
    <ul>${tu.steps.map((x) => `<li class="${x.done ? 'done' : x === next ? 'next' : ''}"><span aria-hidden="true">${x.done ? '\u2713' : x === next ? '\u25B6' : '\u25CB'}</span> ${esc(loc(x.title))}${x === next ? `<p class="small muted">${esc(loc(x.description))}</p>` : ''}</li>`).join('')}</ul>
    <div class="row">${tu.complete ? `<button type="button" class="btn compact" data-tut="claim">${esc(t('tutorial.claim', { gold: fmtNum(tu.rewards.gold), xp: fmtNum(tu.rewards.xp) }))}</button>` : ''}
      <button type="button" class="btn compact ghost" data-tut="dismiss">${esc(t('tutorial.dismiss'))}</button></div></details>`;
}
function bindTutorial(view) {
  view.querySelector('.tutorial')?.addEventListener('toggle', (e) => { state.tutorialOpen = e.target.open; });
  view.querySelectorAll('[data-tut]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await api(`/tutorial/${b.dataset.tut}`, {});
      setMe(res);
      if (b.dataset.tut === 'claim') flash(t('flash.reward'));
      view.querySelector('.tutorial')?.remove();
    } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
      b.disabled = false;
    }
  }));
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
    ${tutorialHtml()}
    <section class="info map-info" aria-live="polite"></section>`;

  bindTutorial(view);
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
  let lastPos = new Map(); // dernière position de chaque pastille, pour animer les déplacements
  const fxQueue = []; // effets à jouer au prochain dessin (attaque, défense, appel à l'aide…)
  const drawMarkers = () => {
    const u = m.width / (inner.getBoundingClientRect().width || m.width); // unités de carte par pixel d'écran
    const parts = [];
    const pos = new Map();
    const now = serverNow();
    for (const st of state.territories) {
      const s0 = shape(st.id);
      if (!s0) continue;
      const s = { ...s0, x: s0.cx ?? s0.x, y: s0.cy ?? s0.y }; // cx, cy : centre visuel du territoire (map.json)
      if (st.battle) {
        const k = 4 * u;
        parts.push(`<g class="battle-mark" transform="translate(${s.x} ${s.y - 20 * u})">
        <circle r="${9 * u}" fill="${esc(faction(st.battle.attacker)?.color || '#e5484d')}" stroke="#fff" stroke-width="${1.5 * u}"/>
        <path d="M${-k} ${-k}L${k} ${k}M${k} ${-k}L${-k} ${k}" stroke="#fff" stroke-width="${2 * u}" stroke-linecap="round"/></g>`);
      }
      // Capitale d'une faction : couronne dans sa couleur.
      const capOf = Object.entries(state.map?.capitals || {}).find(([, id]) => id === st.id)?.[0];
      if (capOf) {
        parts.push(`<g class="capital-mark" transform="translate(${s.x} ${s.y - 34 * u}) scale(${u * 0.9})"><path d="M-9 4L-11 -6L-5 -1L0 -9L5 -1L11 -6L9 4Z" fill="${esc(faction(capOf)?.color || '#f6c945')}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></g>`);
      }
      // Signalements de ma faction.
      const pingsHere = (state.map?.pings || []).filter((x) => x.territory === st.id);
      pingsHere.slice(0, 2).forEach((x, i) => parts.push(`<text class="ping-mark" x="${s.x + (24 + i * 17) * u}" y="${s.y + 4 * u}" font-size="${15 * u}" text-anchor="middle">${PING_ICON[x.kind] || '📍'}</text>`));
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
          const key = o.gid ? `g:${o.gid}` : `p:${o.pseudo}`;
          pos.set(key, { x: cx, y });
          parts.push(`<g class="pin" data-k="${esc(key)}" ${o.gid ? `data-gprofile="${esc(o.gid)}"` : `data-profile="${esc(o.pseudo)}"`}><clipPath id="${esc(id)}"><circle cx="${cx}" cy="${y}" r="${r}"/></clipPath>
            <circle cx="${cx}" cy="${y}" r="${r + 1.2 * u}" fill="#fff"/>
            <image href="${occImg(o)}" x="${cx - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${esc(id)})" preserveAspectRatio="xMidYMin slice"/>
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
    const s0 = p.territory && shape(p.territory);
    const s = s0 && { ...s0, x: s0.cx ?? s0.x, y: s0.cy ?? s0.y };
    if (s && p.status !== 'dead') {
      pos.set('me', { x: s.x, y: s.y });
      parts.push(`<g data-k="me"><g transform="translate(${s.x} ${s.y})"><circle r="${8 * u}" fill="${esc(faction(myFaction()).color)}" stroke="#fff" stroke-width="${3 * u}"/>
        <circle r="${2.5 * u}" fill="#fff"/></g></g>`);
    }
    // Effets d'action : une icône qui grossit et s'efface au-dessus du territoire.
    const FX = { attack: '\u2694\uFE0F', defend: '\u{1F6E1}\uFE0F', rally: '\u{1F4EF}', build: '\u{1F528}', ping: '\u{1F4E3}' };
    while (fxQueue.length) {
      const f = fxQueue.shift();
      const c = f.territory && shape(f.territory);
      if (!c) continue;
      parts.push(`<g class="fx fx-${esc(f.kind)}" transform="translate(${c.cx ?? c.x} ${c.cy ?? c.y})"><circle class="fx-ring" r="${14 * u}" fill="none" stroke="#fff" stroke-width="${2 * u}"/>
        <text class="fx-icon" font-size="${26 * u}" text-anchor="middle" dominant-baseline="central">${FX[f.kind] || '\u2728'}</text></g>`);
    }
    markers.innerHTML = parts.join('');
    // Déplacements : chaque pastille glisse en ligne droite depuis son ancienne position.
    markers.querySelectorAll('[data-k]').forEach((el) => {
      const now = pos.get(el.dataset.k);
      const was = lastPos.get(el.dataset.k);
      if (!now || !was || (Math.abs(now.x - was.x) < 1 && Math.abs(now.y - was.y) < 1)) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${was.x - now.x}px, ${was.y - now.y}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform .9s linear'; el.style.transform = 'translate(0px, 0px)'; }));
    });
    lastPos = pos;
    markers.querySelectorAll('.fx').forEach((el) => setTimeout(() => el.remove(), 1400));
  };

  // Les actions secondaires (renforts payés, appel à l'aide, retours alternatifs) ont un bouton discret.
  const QUIET = new Set(['hire', 'rally', 'teleport', 'revive-renown', 'revive-ask', 'vial']);
  const btn = (act, label, disabled) => `<button type="button" class="btn compact ${QUIET.has(act) || act.startsWith('heal') ? 'ghost' : ''}" data-act="${act}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
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
          <div class="row act-row"><button type="button" class="btn compact" data-goto-tab="exile">${esc(t('camp.chooseBanner'))}</button></div>`
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
    const phase = state.map?.campaign?.phase || 'open';
    const noAct = !(p.actions > 0) || phase === 'break';
    // Gardiens : défendre comme chez soi le territoire d'une autre faction attaqué (Loups de cendre pour l'Église de Seiros).
    const guarding = !!b && state.map?.guardians?.[myFaction()] === st.faction && b.defender === st.faction;
    const shielded = !!st.untouchableUntil && st.untouchableUntil > serverNow();
    const counterBonus = state.config.campaign?.counter?.attackBonus || 0;
    const capFaction = Object.entries(state.map?.capitals || {}).find(([, id]) => id === tr.id)?.[0];
    const bsp0 = state.config.campaign?.build?.specs || {};
    const tags = [capFaction ? `\u{1F451} ${loc(state.config.campaign?.capitalNames?.[capFaction]) || t('camp.capital', { faction: loc(faction(capFaction)?.name) })}` : '', st.importance > 1 ? t('camp.importance', { n: st.importance }) : '', st.annex ? t('camp.annex') : '',
      st.build ? t('build.current', { name: loc(bsp0[st.build.spec]?.name), level: st.build.level }) : ''].filter(Boolean);
    const present = Object.entries(st.players || {}).map(([f, n]) => `<span class="who-here" title="${esc(loc(faction(f)?.name))}">
      ${flag(f) || `<span class="dot" style="--c:${esc(faction(f)?.color || '#888')}"></span>`}${n}</span>`).join('');

    // Ce que je peux faire ici : agir sur mon territoire, m'y déplacer s'il est voisin, ou m'y replier.
    let actions = '';
    if (p.status === 'retreating') {
      if (isHome(tr.id)) actions = btn('retreat', t('camp.retreat'), false);
    } else if (p.status === 'alive') {
      if (here && st.faction === myFaction()) actions = btn('defend', t('camp.defend'), noAct) + btn('gather', t('camp.gather'), noAct || !!b);
      else if (here && guarding) actions = btn('defend', t('camp.defend'), noAct);
      else if (here) actions = btn('attack', t('camp.attack'), noAct || (b && b.attacker !== myFaction()) || shielded || phase === 'closing');
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
        // Construire sur son territoire (spécialité par territoire, jusqu'au niveau 3), hors bataille.
        const bsp = Object.fromEntries(Object.entries(state.config.campaign?.build?.specs || {}).filter(([, sp]) => !sp.hpRegen || p.hp)); // Infirmerie : seulement avec les PV
        if (st.faction === myFaction() && !b && costs.build) {
          const lvl = st.build?.level || 0;
          if (!st.build) actions += Object.entries(bsp).map(([id, sp]) => btn(`build:${id}`, t('build.build', { name: loc(sp.name), gold: fmtNum(costs.build[0]) }), noAct || mine.gold < costs.build[0])).join('');
          else if (lvl < costs.buildMax) actions += btn(`build:${st.build.spec}`, t('build.upgrade', { name: loc(bsp[st.build.spec]?.name), level: lvl + 1, gold: fmtNum(costs.build[lvl]) }), noAct || mine.gold < costs.build[lvl]);
        }
        // … et appeler sa faction à l'aide, une fois par bataille.
        if (b && (b.attacker === myFaction() || b.defender === myFaction())) actions += btn('rally', t(b.rallied ? 'camp.rallied' : 'camp.rally'), b.rallied);
        // Points de vie : se soigner soi-même (classes de soin) ou boire une fiole (or, sans action).
        const hp = p.hp;
        if (hp && hp.pct < 100) {
          if (hp.heal) actions += btn('heal-self', t('hp.healSelf', { hp: hp.selfHeal }), noAct);
          actions += btn('vial', t('hp.vial', { gold: fmtNum(hp.vial.gold), hp: hp.vial.hp, left: hp.vial.left, max: hp.vial.perDay }), hp.vial.left < 1 || mine.gold < hp.vial.gold);
        }
      }
      // Évêque noir : se téléporter vers un territoire de sa faction ou voisin de sa faction, sans dépenser d'action.
      if (!here && costs.teleport != null && myEffects().some((e) => e.kind === 'teleport') && canEnter(tr.id)) {
        actions += btn('teleport', t('camp.teleport', { gold: fmtNum(costs.teleport) }), mine.gold < costs.teleport);
      }
    }
    // Généraux vaincus par ma faction : les épargner (ils rejoignent ma faction) ou les faire mourir.
    // Phase de la campagne, capacité du seigneur, objectif de la semaine, signalements de la faction.
    const lordInfo = state.map?.lord;
    const obj = state.map?.objective;
    const lordFac = lordInfo && faction(lordInfo.faction);
    const lordPortrait = lordInfo && (state.config.generals?.roster || []).find((x) => x.id === lordInfo.id)?.avatar;
    const lordHtml = lordInfo ? `<div class="strip lord ${lordInfo.activeUntil ? 'on' : ''}" style="--c:${esc(lordFac?.color || '#c9a25a')}" title="${esc(loc(lordInfo.ability.description))}">
        <img class="portrait" src="${esc(lordPortrait || '')}" alt="">
        <div><strong>${esc(loc(lordInfo.ability.title))}</strong>
        ${lordInfo.activeUntil ? `<small class="live">${esc(t('lord.activeShort'))} · <span data-until="${lordInfo.activeUntil}">${fmtLeft(lordInfo.activeUntil - serverNow())}</span></small>`
    : `<span class="xpbar"><i style="width:${Math.min(100, (lordInfo.gauge / lordInfo.max) * 100)}%"></i></span><small>${esc(t('lord.gauge', { n: lordInfo.gauge, max: lordInfo.max }))}</small>`}</div>
        ${lordFac?.logo ? `<img class="banner" src="${esc(lordFac.logo)}" alt="">` : ''}</div>` : '';
    const objHtml = obj ? `<div class="strip objective ${obj.done ? 'done' : ''}" style="--c:${esc(faction(myFaction())?.color || '#c9a25a')}"><span aria-hidden="true">\u{1F3AF}</span><div><strong>${esc(loc(obj.title))}</strong> <small>${obj.done ? esc(t('objective.done')) : `${obj.current} / ${obj.target}`}</small>
        <p class="small muted">${esc(loc(obj.description))}</p></div></div>` : '';
    // Église de Seiros : croisade en cours, ou l'Immaculée qui assiège Garreg-Mach.
    const ch = state.map?.church || {};
    const gAvatar = (id) => (state.config.generals?.roster || []).find((x) => x.id === id)?.avatar || '';
    const churchFac = faction('eglise');
    const churchHtml = ch.awakening ? `<div class="strip church awake" style="--c:${esc(churchFac?.color || '#fff')}"><img class="portrait" src="${esc(gAvatar('immaculate'))}" alt="">
        <div><strong>${esc(t('church.awakening'))}</strong> <small>${esc(t('church.waves', { n: ch.awakening.waves, total: ch.awakening.total }))}</small>
        ${ch.awakening.next > serverNow() ? `<small class="live">${withTimer('church.next', {}, ch.awakening.next)}</small>` : ''}</div>
        ${churchFac?.logo ? `<img class="banner" src="${esc(churchFac.logo)}" alt="">` : ''}</div>`
      : ch.crusade ? `<div class="strip church" style="--c:${esc(faction(ch.crusade)?.color || '#fff')}"><img class="portrait" src="${esc(gAvatar('rhea'))}" alt="">
        <div><strong>\u271D\uFE0F ${esc(t('church.crusade'))}</strong>
        <p class="small muted">${flag(ch.crusade)}${esc(t('church.crusadeTarget', { faction: loc(faction(ch.crusade)?.name) }))}</p></div>
        ${churchFac?.logo ? `<img class="banner" src="${esc(churchFac.logo)}" alt="">` : ''}</div>` : '';
    const od = state.map?.overdrive;
    const odHtml = od ? `<div class="strip overdrive ${od.level === 'plus' ? 'plus' : ''}"><span class="od-bolt" aria-hidden="true">\u26A1</span>
        <div><strong>${esc(t(od.level === 'plus' ? 'overdrive.stripPlus' : 'overdrive.strip'))}</strong>
        <small>${esc(modText({ type: 'overdrive', ...od }).replace(/^Overdrive\+?\s?!\s?/, ''))}</small>
        ${od.until ? `<small class="live">${withTimer('overdrive.left', {}, od.until)}</small>` : ''}</div></div>` : '';
    const phaseHtml = phase === 'closing' ? `<p class="banner">${esc(t('camp.closing'))}</p>`
      : phase === 'break' ? `<p class="banner">${withTimer('camp.break', {}, state.map.campaign.resetAt)}</p>` : '';
    const pingHtml = (state.map?.pings || []).length ? `<div class="chips pings">${state.map.pings.map((x) => `<button type="button" class="chip ping-chip" data-goto="${esc(x.territory)}">${PING_ICON[x.kind] || ''} ${esc(x.pseudo)} · ${esc(loc(shape(x.territory)?.name))}</button>`).join('')}</div>` : '';
    const pingBox = p.status !== 'dead' && (state.config.campaign?.pings?.kinds || []).length ? `<details class="ping-box"><summary>${esc(t('ping.title'))}</summary>
        <div class="row">${state.config.campaign.pings.kinds.map((k) => `<button type="button" class="btn compact ghost" data-act="ping:${esc(k)}">${PING_ICON[k]} ${esc(t(`ping.${k}`))}</button>`).join('')}</div></details>` : '';
    // Bataille : minuteur, chances de MON camp (jauge et libellé), force des deux côtés, victoire ou défaite certaine.
    const battleHtml = (bt, stt) => {
      const defMine = stt.faction === myFaction() || (state.map?.guardians?.[myFaction()] === stt.faction && bt.defender === stt.faction);
      const pct = defMine ? 100 - bt.chance : bt.chance;
      const sure = bt.decisive ? ((bt.decisive === 'win') === !defMine ? 'win' : 'lose') : null;
      const label = sure === 'win' ? t('camp.decisiveWin') : sure === 'lose' ? t('camp.decisiveLose') : pct >= 60 ? t('camp.odds.good') : pct >= 40 ? t('camp.odds.even') : t('camp.odds.bad');
      const tone = sure ? sure : pct >= 60 ? 'good' : pct >= 40 ? 'even' : 'bad';
      return `<div class="small battle-line"><p>${bt.general
        ? withTimer('camp.battleGeneral', { general: bt.general.name, attacker: loc(faction(bt.attacker)?.name), chance: bt.chance }, bt.endsAt)
        : withTimer(numKey('camp.battle', bt.attacker), { attacker: loc(faction(bt.attacker)?.name), chance: bt.chance }, bt.endsAt)}
        · ${esc(t('camp.forces', { attackers: bt.attackers, defenders: bt.defenders }))}</p>
        <div class="odds ${tone}"><span class="odds-bar"><i style="width:${pct}%"></i></span><b>${esc(label)} · ${pct} %</b></div>
        <p class="muted">${esc(t('camp.oddsLine', { attack: bt.power.attack, defense: bt.power.defense }))}</p></div>`;
    };
    // Soigneur sur son territoire : un bouton par allié blessé présent (les plus blessés d'abord).
    const healHtml = here && p.status === 'alive' && p.hp?.heal ? (() => {
      const hurt = (st.occupants || []).filter((o) => !o.me && o.hp != null && o.hp < 100 && o.faction === myFaction()).sort((x, y) => x.hp - y.hp).slice(0, 6);
      return hurt.length ? `<div class="row act-row heal-row">${hurt.map((o) => btn(`heal:${o.general ? `g:${o.gid}` : o.pseudo}`, t('hp.heal', { name: o.pseudo, hp: p.hp.heal, pct: o.hp }), noAct)).join('')}</div>` : '';
    })() : '';
    const verdicts = (state.map?.verdicts || []).map((vd) => `<div class="verdict">
        <img src="${esc(vd.avatar)}" alt="">
        <div><strong>${esc(vd.name)}</strong> <small>${flag(vd.faction)}${esc(className(vd.class))} · ${esc(t('menu.playerRenown', { level: vd.level }))}</small>
          <p class="small">${withTimer('camp.verdictHint', {}, vd.until)}</p>
          <div class="row"><button type="button" class="btn compact" data-verdict="${esc(vd.id)}" data-spare="1">${esc(t('camp.spare'))}</button>
            <button type="button" class="btn compact ghost" data-verdict="${esc(vd.id)}" data-spare="0">${esc(t('camp.execute'))}</button></div></div></div>`).join('');
    box.innerHTML = `${banner}${phaseHtml}<div class="strips">${odHtml}${churchHtml}${lordHtml}${objHtml}</div>${pingHtml}${verdicts ? `<section class="verdicts"><h3>${esc(t('camp.verdictTitle'))}</h3>${verdicts}</section>` : ''}
      <div class="terr-head"><h3>${esc(loc(tr.name))}</h3>${here ? `<span class="pill">${esc(t('camp.you'))}</span>` : ''}</div>
      <p class="muted small">${owner
    ? `${esc(t('map.owned'))} ${flag(owner.id)}<span style="color:${esc(owner.color)}">${esc(loc(owner.name))}</span>`
    : esc(t('map.neutral'))}${tags.length ? ' · ' + esc(tags.join(' · ')) : ''}${present ? ` · ${present}` : ''}</p>
      ${(st.occupants || []).length ? `<div class="present-list" aria-label="${esc(t('camp.present'))}">${st.occupants.map((o) => {
    const of = faction(o.faction);
    return `<span class="who ${o.me ? 'me' : ''} ${o.general ? 'general' : ''}" style="--c:${esc(of?.color || '#888')}" title="${esc(of ? loc(of.name) : '')}" ${o.general ? `data-gprofile="${esc(o.gid)}"` : `data-profile="${esc(o.pseudo)}"`} role="button" tabindex="0">
        <img src="${occImg(o)}" alt=""><span><b>${esc(o.pseudo)}${o.lord ? ' \u{1F451}' : ''}${o.ordered ? ' \u{1F4EF}' : ''}</b>
        <small>${flag(o.faction)}<img class="class-icon tiny" src="${esc(klass(o.class)?.icon || '')}" alt="">${o.general ? `<em>${esc(t('camp.general'))}</em> · ` : ''}${esc(className(o.class))} · ${esc(t('menu.playerRenown', { level: o.level }))}${o.retreating ? ' · ' + esc(t('camp.retreatingTag')) : ''}</small>
        ${o.hp != null ? `<i class="hpbar ${o.hp < 25 ? 'crit' : o.hp < 50 ? 'low' : ''}" title="${esc(t('hp.pct', { pct: o.hp }))}"><b style="width:${o.hp}%"></b></i>` : ''}</span></span>`;
  }).join('')}</div>` : ''}
      ${b ? battleHtml(b, st) : ''}
      ${shielded ? `<p class="small note">${withTimer('camp.untouchable', {}, st.untouchableUntil)}</p>` : ''}
      ${st.counter && !shielded ? `<p class="small note">${esc(t('camp.counter', { pct: st.counterPct || counterBonus }))}</p>` : ''}
      ${p.rewardDebuff > 0 ? `<p class="small note">${esc(t('camp.rewardDebuff', { n: p.rewardDebuff }))}</p>` : ''}
      ${actions ? `<div class="row act-row">${actions}</div>` : ''}
      ${healHtml}
      ${pingBox}
      ${near.length ? `<div class="chips">${near.map((id) => {
    const o = ownerOf(id) ? faction(ownerOf(id)) : null;
    return `<button type="button" class="chip" data-goto="${esc(id)}">${o ? flag(ownerOf(id)) : `<span class="dot" style="--c:#6b7287"></span>`}${esc(loc(shape(id).name))}</button>`;
  }).join('')}</div>` : `<p class="muted small">${esc(t('map.noNeighbors'))}</p>`}`;
    box.querySelectorAll('[data-goto]').forEach((el) => el.addEventListener('click', () => select(el.dataset.goto, true)));
    box.querySelectorAll('[data-verdict]').forEach((el) => el.addEventListener('click', async () => {
      box.querySelectorAll('[data-verdict]').forEach((x) => { x.disabled = true; });
      actionError = '';
      try {
        const spare = el.dataset.spare === '1';
        const res = await api('/general/verdict', { general: el.dataset.verdict, spare });
        setMe(res);
        setMap(res.map);
        flash(t(spare ? 'flash.verdictSpare' : 'flash.verdictKill'));
      } catch (err) {
        if (err.status === 401) return sessionLost();
        flash(err.message, 'error');
      }
      if (state.tab === 'map' && inner.isConnected) refresh();
    }));
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
          : act.startsWith('revive-') ? ['/revive', { mode: act.slice(7) }]
            : act.startsWith('build:') ? ['/act', { action: 'build', spec: act.slice(6) }]
              : act === 'heal-self' ? ['/act', { action: 'heal' }]
              : act.startsWith('heal:') ? ['/act', { action: 'heal', target: act.slice(5) }]
              : act.startsWith('ping:') ? ['/ping', { territory: state.selected, kind: act.slice(5) }] : ['/act', { action: act }];
    actionError = '';
    actionNote = '';
    try {
      let res;
      try { res = await api(path, body); } catch (err) {
        // Quitter un territoire où l'on combat : confirmation, puis les actions de combat y sont annulées.
        if (err.code !== 'engaged' || !(await confirmBox({ title: t('engage.title'), body: t('engage.body', { territory: loc(shape(me().territory)?.name) }), ok: t('engage.leave'), cancel: t('engage.stay') }))) throw err;
        res = await api(path, { ...body, leave: true });
      }
      const from = me().territory;
      setMe(res);
      setMap(res.map);
      if (res.cancelled) flash(t('engage.cancelled'));
      if (['attack', 'defend', 'rally'].includes(act) || act.startsWith('build:')) fxQueue.push({ kind: act.split(':')[0], territory: from });
      if (res.bonus) flash(t('camp.bonus', { gold: res.bonus }));
      if ((res.relFx || []).length) flash(res.relFx.map((x) => t(`relfx.${x.kind}`, x)).join(' · ')); // bonus de soutien déclenchés
      if (res.free) flash(t('camp.freeMove')); // déplacement gratuit (Chevalier pégase, Chevalier faucon)
      if (act.startsWith('ping:')) { flash(t('ping.sent')); fxQueue.push({ kind: 'ping', territory: state.selected }); }
      // De retour en jeu : la carte se place sur le territoire où l'on réapparaît.
      if (act.startsWith('revive-') && res.player.status === 'alive') state.selected = res.player.territory;
    } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
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
  // À l'arrivée sur la carte : déjà un peu zoomée, et centrée sur ma position (ou sur la carte si je n'en ai pas).
  if (inner.isConnected) {
    state.zoom = Math.max(state.zoom, 2.5);
    applyZoom();
    const here = me().territory && shape(me().territory);
    const fx = here ? (here.cx ?? here.x) / m.width : 0.5;
    const fy = here ? (here.cy ?? here.y) / m.height : 0.5;
    scroller.scrollLeft = fx * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = fy * scroller.scrollHeight - scroller.clientHeight / 2;
    drawMarkers();
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
      <details class="menu-fold" data-fold="help" ${state.menuFold?.help ? 'open' : ''}><summary><span>\u2139\uFE0F ${esc(t('menu.helpFold'))}</span></summary>
        <div class="fold-body">
          <button class="btn ghost" type="button" data-rules>\u{1F4DC} ${esc(t('menu.rules'))}</button>
          <button class="btn ghost" type="button" data-pushsettings>\u{1F514} ${esc(t('menu.notifications'))}</button>
          <button class="btn ghost" type="button" data-install>\u{1F4F2} ${esc(t('menu.install'))}</button>
          <button class="btn ghost" type="button" data-bug>\u{1F41E} ${esc(t('menu.bug'))}</button>
        </div></details>
      <details class="menu-fold" data-fold="conquests" ${state.menuFold?.conquests ? 'open' : ''}><summary><span>\u{1F3C6} ${esc(t('menu.conquestFold'))}</span></summary>
        <div class="fold-body">
          <button class="btn ghost" type="button" data-impact>\u{1F4CA} ${esc(t('menu.impact'))}</button>
          <button class="btn ghost" type="button" data-pantheon>\u{1F3DB}\uFE0F ${esc(t('menu.pantheon'))}</button>
        </div></details>
      <button class="btn ghost" type="button" data-patches>\u{1F4F0} ${esc(t('menu.patches'))}${patchUnread() ? `<span class="new-dot" title="${esc(t('patch.new'))}"></span>` : ''}</button>

      <section class="card">
        <h2>${esc(t('menu.character'))}</h2>
        <div class="profile">
          <img class="avatar" src="${avatarUrl(ch.avatar)}" alt="">
          <div><h3>${esc(ch.pseudo)}</h3><span class="pill">${flag(f.id)}${esc(loc(f.name))}</span>
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

      <section class="card relations">
        <h2>\u{1F490} ${esc(t('rel.title'))}</h2>
        <p class="muted small">${esc(t('rel.hint'))}</p>
        ${state.relations ? (state.relations.generals.length ? `<div class="rel-grid">${state.relations.generals.map(relTile).join('')}</div>` : `<p class="muted small">${esc(t('rel.none'))}</p>`) : `<p class="muted small">${esc(t('common.loading'))}</p>`}
        ${state.relations ? `<h3 class="rel-sub">${esc(t('prel.title'))}</h3>
        ${(state.relations.players || []).length ? `<div class="rel-grid">${state.relations.players.map(playerTile).join('')}</div>` : `<p class="muted small">${esc(t('prel.none'))}</p>`}` : ''}
      </section>

      <section class="card">
        <h2>${esc(t('menu.faction'))}</h2>
        <div class="faction-line">${factionHero(f, `<strong class="faction-name">${esc(loc(f.name))}</strong><span class="faction-desc">${esc(loc(f.description))}</span>`)}</div>
        ${state.map?.objective ? `<div class="strip objective ${state.map.objective.done ? 'done' : ''}"><span aria-hidden="true">\u{1F3AF}</span><div><strong>${esc(t('objective.title'))} : ${esc(loc(state.map.objective.title))}</strong>
            <p class="small">${esc(loc(state.map.objective.description))}</p>
            <div class="progress"><span class="xpbar"><i style="width:${(state.map.objective.current / state.map.objective.target) * 100}%"></i></span><small class="muted">${state.map.objective.done ? esc(t('objective.done')) : `${state.map.objective.current} / ${state.map.objective.target}`}</small></div>
            <small class="muted">${esc(t('objective.reward', { points: state.map.objective.points, gold: state.map.objective.gold }))}</small></div></div>` : ''}
        ${pk ? `<ul class="perks">
          ${pk.outnumberedMax ? `<li>${esc(t('perk.outnumbered', { n: fmtNum(pk.powerBonus), max: pk.outnumberedMax }))}</li>` : ''}
          ${pk.neverOut ? `<li>${esc(t('perk.neverOut'))}</li>` : ''}
          ${pk.autoRetreat ? `<li>${esc(t('perk.autoRetreat'))}</li>` : ''}
          ${pk.freeRevive ? `<li>${esc(t('perk.freeRevive'))}</li>` : ''}
          ${pk.rewardMultiplier > 1 ? `<li>${esc(t('perk.rewards', { n: pk.rewardMultiplier }))}</li>` : ''}
          ${pk.efficiency ? `<li>${esc(t('perk.efficiency'))}</li>` : ''}
          ${pk.hiddenAtBase ? `<li>${esc(t('perk.hidden', { place: loc(state.config.map.territories.find((x) => x.id === state.map.homeBases[ch.faction])?.name) }))}</li>` : ''}
          ${pk.pointsMultiplier > 1 ? `<li>${esc(t('perk.points', { n: pk.pointsMultiplier }))}</li>` : ''}
        </ul>` : ''}
      </section>

      <section class="card">
        <h2>${esc(t('camp.title'))}</h2>
        ${state.map ? `<p><strong>${esc(t('camp.number', { n: state.map.campaign.id }))}</strong></p>` : ''}
        ${state.map?.campaign.closesAt ? `<p class="muted small">${esc(t('camp.closesAt', { date: new Date(state.map.campaign.closesAt).toLocaleString(locale(), { weekday: 'long', hour: '2-digit', minute: '2-digit' }) }))}</p>` : ''}
        <p class="muted small">${esc(t('camp.points'))} — ${esc(t('camp.pointsHint'))}</p>
        ${[...playable].sort((a, b) => (points[b.id] || 0) - (points[a.id] || 0)).map((x) => `
          <div class="score" style="--c:${esc(x.color)}">${flag(x.id) || '<span class="dot"></span>'}${esc(loc(x.name))}<span class="n">${esc(t('camp.pts', { n: fmtNum(points[x.id] || 0) }))}</span></div>`).join('')}
      </section>

      ${rk ? `<section class="card">
        <h2>${esc(t('camp.ranking'))}</h2>
        <p class="muted small">${esc(t('camp.rankingHint', { rewards: rk.rewards.map(fmtNum).join(' / ') }))}</p>
        ${rk.top.map((r) => `<div class="player rank ${r.me ? 'me' : ''}" data-profile="${esc(r.pseudo)}" role="button" tabindex="0">
            <img class="avatar" src="${avatarUrl(r.avatar)}" alt="">
            <div><strong>${r.rank}. ${esc(r.pseudo)}</strong><small style="color:${esc(faction(r.faction)?.color || '#888')}">${flag(r.faction)}${esc(loc(faction(r.faction)?.name))}</small></div>
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
    return `<div class="player" data-profile="${esc(p.pseudo)}" role="button" tabindex="0">
            <img class="avatar" src="${avatarUrl(p.avatar)}" alt="">
            <div><strong>${esc(p.pseudo)}</strong><small>${esc(className(p.class))} · ${esc(t('menu.playerRenown', { level: Number(p.renown) || 0 }))} · ${esc(fmtDate(p.birthday))}</small></div>
            <span class="pill" style="--c:${esc(pf ? pf.color : '#888')}">${flag(p.faction)}${esc(pf ? loc(pf.name) : p.faction)}</span>
          </div>`;
  }).join('') || `<p class="muted small">${esc(t('common.loading'))}</p>`}
      </section>

      <button class="btn danger" type="button" data-logout>${esc(t('common.logout'))}</button>`;
    view.querySelector('[data-logout]').addEventListener('click', logout);
    view.querySelectorAll('.menu-fold').forEach((d) => d.addEventListener('toggle', () => { state.menuFold = { ...state.menuFold, [d.dataset.fold]: d.open }; }));
    view.querySelector('[data-rules]').addEventListener('click', () => go('rules'));
    view.querySelector('[data-patches]').addEventListener('click', () => go('patches'));
    view.querySelector('[data-install]').addEventListener('click', () => go('install'));
    view.querySelector('[data-impact]').addEventListener('click', () => go('impact'));
    view.querySelector('[data-pantheon]').addEventListener('click', () => go('pantheon'));
    view.querySelector('[data-bug]').addEventListener('click', () => go('bug'));
    view.querySelector('[data-pushsettings]').addEventListener('click', () => go('pushsettings'));
    view.querySelector('[data-avatars]').addEventListener('click', () => go('avatars'));
    view.querySelectorAll('[data-rel]').forEach((b) => b.addEventListener('click', () => showRelation(b.dataset.rel, draw)));
    view.querySelectorAll('[data-prel]').forEach((b) => b.addEventListener('click', () => showPlayerRelation(b.dataset.prel, draw)));
    view.querySelector('[data-classes]').addEventListener('click', () => {
      state.classesFrom = 'menu';
      state.classSel = state.me.character.class;
      go('classes');
    });
  };

  draw();
  try {
    const [players, map, rel] = await Promise.all([api('/players'), api('/map'), api('/relations').catch(() => null)]);
    state.players = players.players;
    state.relations = rel;
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
  if (p.general) p.general = generalName(p.general);
  if (n.type === 'lord_ability' && n.params.faction) {
    const ab = state.config.campaign?.lords?.[n.params.faction]?.ability;
    p.ability = loc(ab?.title) || '';
    p.effect = loc(ab?.description) || '';
  }
  if (p.class) p.class = className(p.class);
  if (n.type === 'player_gift' && p.kind) p.kind = t(`prel.kind.${p.kind}`);
  if (n.type === 'general_order') p.order = t(`order.kind.${n.params.kind}`);
  if (p.distinction) p.distinction = loc((state.config.distinctions || []).find((x) => x.id === p.distinction)?.name) || p.distinction;
  for (const k of ['territory', 'home']) if (p[k]) p[k] = loc(state.config.map.territories.find((x) => x.id === p[k])?.name) || p[k];
  for (const k of ['gold', 'xp', 'points', 'rank']) if (typeof p[k] === 'number') p[k] = fmtNum(p[k]);
  if (n.type === 'general_order') return { title: t('notif.general_order.title', p), body: t(`notif.general_order.${n.params.outcome}`, p) };
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
          ${n.type === 'player_gift' && n.params.thanks === 'open' ? `<button type="button" class="btn compact" data-thank="${esc(n.params.gift)}">\u{1F64F} ${esc(t('prel.thank'))}</button>` : ''}
          ${n.type === 'player_gift' && n.params.thanks === 'thanked' ? `<small class="muted">\u{1F64F} ${esc(t('prel.thanked'))}</small><br>` : ''}
          <small class="muted">${esc(when(n.created_at))}</small>
        </article>`;
      }).join('')
      : `<p class="muted">${esc(t('notifs.empty'))}</p>`);
  bindClose(view);
  view.querySelectorAll('[data-thank]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await api('/relations/thanks', { gift: Number(b.dataset.thank) });
      flash(t('prel.thankDone', { name: res.thanks.pseudo, points: res.thanks.gained }));
      b.outerHTML = `<small class="muted">\u{1F64F} ${esc(t('prel.thanked'))}</small><br>`;
    } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
    }
  }));
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
    rw.actions ? `<span class="res"><img src="assets/ui/action.svg" alt="${esc(t('res.actions'))}">+${fmtNum(rw.actions)}</span>` : '',
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
  // Missions en cours et à récupérer en tête ; les missions terminées repliées dans un dépliant.
  const listOf = (list, attr) => {
    const open = sorted(list.filter((m) => m.status !== 'claimed'));
    const done = list.filter((m) => m.status === 'claimed');
    return open.map((m) => card(m, attr)).join('') + (done.length ? `<details class="done-fold"><summary>${esc(t('missions.doneFold', { n: done.length }))}</summary>${done.map((m) => card(m, attr)).join('')}</details>` : '');
  };  // data : { missions, daily } tel que renvoyé par le serveur.
  const draw = (data, error) => {
    const { missions = [], daily, specials = [], campaignMissions = [] } = data;
    view.innerHTML = panelHead(t('missions.title'))
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      + (daily && daily.missions.length ? `
        <div class="section-head"><h2>${esc(t('daily.title'))}</h2>
          <span class="pill">${esc(t('daily.streak', { n: daily.streak }))}</span></div>
        <p class="muted small">${esc(t('daily.hint'))} ${esc(t('daily.bonus', { n: daily.bonus }))}</p>
        ${daily.frozen ? `<p class="note small">${esc(t('daily.frozen'))}</p>` : ''}
        ${listOf(daily.missions, 'data-claim-daily')}
        ${daily.exile && daily.exile.length ? `<div class="section-head"><h2>${esc(t('daily.exile'))}</h2></div>
          <p class="muted small">${esc(t('daily.exileHint'))}</p>
          ${listOf(daily.exile, 'data-claim-daily')}` : ''}
        <div class="section-head"><h2>${esc(t('missions.main'))}</h2></div>` : '')
      + (campaignMissions.length ? `<div class="section-head"><h2>${esc(t('campaignMissions.title'))}</h2></div>
        <p class="muted small">${esc(t('campaignMissions.hint'))}</p>
        ${listOf(campaignMissions, 'data-claim-campaign')}` : '')
      + (missions.length ? listOf(missions, 'data-claim') : (error ? '' : `<p class="muted">${esc(t('missions.empty'))}</p>`))
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
        flash(t('flash.reward'));
        if (state.tab === 'missions' && view.isConnected) draw(res);
      } catch (err) {
        if (err.status === 401) return sessionLost();
        draw(data, err.message);
      }
    }));
    claim('data-claim', '/missions/claim');
    claim('data-claim-daily', '/missions/daily/claim');
    claim('data-claim-campaign', '/missions/campaign/claim');
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
const PING_ICON = { attack: '\u2694\uFE0F', defend: '\u{1F6E1}\uFE0F', danger: '\u26A0\uFE0F', onmyway: '\u{1F6B6}', regroup: '\u{1F6A9}' };
const REACT_ICON = { cheer: '\u{1F44F}', support: '\u{1F4AA}', help: '\u{1F91D}' }; // applaudir, soutenir, serrer la main
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
    // Les noms de faction sont repérés (\u0001 id \u0002 nom \u0003) pour être colorés une fois la phrase composée.
    for (const k of ['faction', 'attacker', 'defender', 'from']) if (p[k]) p[k] = `\u0001${p[k]}\u0002${loc(faction(p[k])?.name) || p[k]}\u0003`;
    if (p.territory) p.territory = terrName(p.territory);
    if (p.general) p.general = generalName(p.general);
    let key = 'journal.' + e.type;
    if (e.type === 'battle_started' && p.general) key = e.params.attacker === 'eglise' ? 'journal.battle_started_immaculate' : 'journal.battle_started_general';
    if (['general_fell', 'general_exhausted', 'serpents_gone', 'immaculate_fell'].includes(e.type) && !p.faction) key += '_none';
    if (e.type === 'general_order') key += `_${e.params.kind}`;
    if (e.type === 'battle_started' && p.defender) key += '_def';
    if (e.type === 'campaign_ended' && !p.faction) key += '_draw';
    if (['battle_started', 'territory_taken', 'faction_out', 'general_spared', 'general_captured', 'serpents_gone', 'immaculate_awoke', 'immaculate_wave', 'immaculate_fell'].includes(e.type)) key = numKey(key, main);
    const html = (txt) => esc(txt).replace(/\u0001([a-z]+)\u0002([^\u0003]*)\u0003/g, (_, id, name) => `<span class="fname" style="color:${esc(faction(id)?.color || 'inherit')}">${name}</span>`);
    return hasText(key) ? { html: html(t(key, p)), color: faction(main)?.color } : null;
  };
  let error = '';
  const draw = (data) => {
    markJournalSeen(Math.max(0, ...data.events.map((e) => e.id)));
    const events = data.events.map((e) => ({ e, d: describe(e) })).filter((x) => x.d);
    view.innerHTML = head
      + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
      // Faction hors jeu : choix d'une bannière à rejoindre en exil.
      + (data.exile ? `<section class="card exile-call"><h2>${esc(t('exile.title'))}</h2><p class="small">${esc(t('exile.callout'))}</p>
          <button type="button" class="btn" data-goto-exile>${esc(t('camp.chooseBanner'))}</button></section>` : '')
      + (data.fallen.length ? `<section class="card"><h2>${esc(t('journal.fallen'))}</h2>
          ${data.fallen.map((f) => `<div class="fallen"><strong>${esc(f.pseudo)}</strong>
            <button type="button" class="btn compact" data-pay="${f.id}" ${state.me.character.gold < (f.cost ?? data.reviveCost) ? 'disabled' : ''}>${esc(t('journal.pay', { gold: fmtNum(f.cost ?? data.reviveCost) }))}</button></div>`).join('')}
        </section>` : '')
      + (events.length ? events.map(({ e, d }) => `<article class="card event" style="--c:${esc(d.color || '#6b7287')}">
          <p>${d.html}</p>
          <div class="event-foot"><small class="muted">${esc(ago(e.at, data.now))}</small>
            ${(e.react || []).filter((x) => x.until > serverNow()).map((x) => `<button type="button" class="react" data-react="${x.k}" data-event="${e.id}" data-expire="${x.until}" title="${esc(t(`react.${x.k}`))}" aria-label="${esc(t(`react.${x.k}`))}"><span aria-hidden="true">${REACT_ICON[x.k]}</span></button>`).join('')}</div></article>`).join('')
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
    view.querySelector('[data-goto-exile]')?.addEventListener('click', () => go('exile'));
    view.querySelectorAll('[data-react]').forEach((b) => b.addEventListener('click', async () => {
      view.querySelectorAll('[data-react]').forEach((x) => { x.disabled = true; });
      try {
        const res = await api('/journal/react', { event: Number(b.dataset.event), kind: b.dataset.react });
        setMe(res);
        const f = res.flash || {};
        flash(f.kind === 'cheer' ? t('flash.cheer', { xp: f.xp }) : f.kind === 'support' ? t(f.pseudo ? 'flash.support' : 'flash.supportAnon', { pseudo: f.pseudo, gold: f.gold }) : t('flash.help', { pct: f.pct }));
      } catch (err) {
        if (err.status === 401) return sessionLost();
        flash(err.message, 'error');
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

// Message temporaire en haut de l'écran (sous la bannière), qui disparaît tout seul.
let flashTimer = null;
function flash(msg, kind = 'note') {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  const bar = document.getElementById('topbar');
  el.style.top = `${(bar ? bar.getBoundingClientRect().bottom : 0) + 8}px`;
  el.className = `flash ${kind}`;
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = 'flash hidden'; }, kind === 'error' ? 5000 : 3500);
}

// Fenêtre de game over : quand le joueur tombe, ou quand sa faction tombe. Montrée une fois par chute (mémorisée sur l'appareil).
function maybeGameOver() {
  const p = state.me?.player;
  if (!p || !state.me.character || document.getElementById('gameover-overlay') || document.getElementById('result-overlay')) return;
  // Faction tombée (hors jeu), ou joueur mis hors de combat après un repli manqué (encore pénalisé), ou tombé.
  const kind = p.status === 'dead' && p.factionOut ? 'faction' : p.status === 'dead' ? 'death' : p.deaths > 0 && p.rewardDebuff > 0 ? 'wounded' : null;
  if (!kind) return;
  const key = `gameover:${state.me.user.id}:${p.campaignId}:${kind}:${kind === 'faction' ? 0 : p.deaths}`;
  state.goSeen = state.goSeen || new Set();
  if (state.goSeen.has(key)) return;
  state.goSeen.add(key); // mémoire de secours quand le stockage de l'appareil est indisponible
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* seule la mémoire de la session reste */ }
  const cost = state.map?.costs?.revive;
  const overlay = document.createElement('div');
  overlay.id = 'gameover-overlay';
  overlay.className = 'overlay';
  const title = kind === 'faction' ? 'gameover.factionTitle' : kind === 'wounded' ? 'gameover.woundedTitle' : 'gameover.deadTitle';
  const body = kind === 'faction' ? 'gameover.factionBody' : kind === 'wounded' ? 'gameover.woundedBody' : p.fallMult > 1 ? 'gameover.deadBodyAttack' : 'gameover.deadBody';
  overlay.innerHTML = `<div class="modal gameover ${kind}" role="dialog" aria-modal="true">
    <h2>${esc(t(title))}</h2>
    <p>${esc(t(body))}</p>
    ${kind === 'death' && cost ? `<p class="small muted">${esc(t('gameover.deadCost', { gold: fmtNum(cost) }))}</p>` : ''}
    <div class="row">${kind === 'faction' ? `<button type="button" class="btn" data-exile>${esc(t('gameover.exile'))}</button>` : ''}
      <button type="button" class="btn ${kind === 'faction' ? 'ghost' : ''}" data-close>${esc(t('gameover.close'))}</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-exile]')?.addEventListener('click', () => { overlay.remove(); go('exile'); });
}

// Relations : vignette d'un général (niveau de soutien en bas à droite ; grisé s'il est mort, captif ou passé ailleurs,
// avec une tête de mort ou la bannière de sa nouvelle faction en haut à gauche).
function relTile(g) {
  const mark = g.state === 'dead' ? '<span class="rel-mark skull" aria-hidden="true">\u{1F480}</span>'
    : g.state === 'joined' ? `<span class="rel-mark">${flag(g.faction)}</span>` : '';
  return `<button type="button" class="rel ${g.state === 'allied' ? '' : 'gone'}" data-rel="${esc(g.id)}" title="${esc(t(`rel.state.${g.state}`))}">
    <span class="rel-face"><img src="${esc(g.avatar)}" alt="" loading="lazy">${mark}${g.level ? `<b class="rel-lvl">${esc(g.level)}</b>` : ''}</span>
    <small>${esc(g.name)}${g.lord ? ' \u{1F451}' : ''}</small></button>`;
}
function playerTile(x) {
  return `<button type="button" class="rel" data-prel="${esc(x.pseudo)}">
    <span class="rel-face"><img src="${avatarUrl(x.avatar)}" alt="" loading="lazy"><span class="rel-mark">${flag(x.faction)}</span>${x.level ? `<b class="rel-lvl">${esc(x.level)}</b>` : ''}</span>
    <small>${esc(x.pseudo)}</small></button>`;
}
// Relation avec un autre joueur : jauge partagée (jusqu'à A+), offrandes, bonus quand on combat ensemble.
async function showPlayerRelation(pseudo, redraw) {
  let d;
  try { d = await api(`/relations/player?pseudo=${encodeURIComponent(pseudo)}`); } catch (err) {
    if (err.status === 401) return sessionLost();
    flash(err.message, 'error');
    return;
  }
  document.getElementById('rel-overlay')?.remove();
  const lv = d.levels;
  const idx = lv.findIndex((l) => l.id === d.level);
  const next = lv[idx + 1] || null;
  const from = idx >= 0 ? lv[idx].points : 0;
  const pct = next ? Math.min(100, ((d.points - from) / (next.points - from)) * 100) : 100;
  const pl = state.me.player || {};
  const gold = state.me.character.gold;
  const capped = d.points >= d.cap;
  const fac = faction(d.faction);
  const giftBtn = (kind, icon) => {
    const c = d.gifts[kind];
    const off = capped || (pl.actions || 0) < c.actions || gold < c.gold;
    if (kind === 'compliment') return `<button type="button" class="btn ghost" data-gift="${kind}" ${off ? 'disabled' : ''}>${icon} ${esc(t('rel.compliment', { points: c.points }))}</button>`;
    return `<button type="button" class="btn ${kind === 'letter' ? '' : 'ghost'}" data-gift="${kind}" ${off ? 'disabled' : ''}>${icon} ${esc(t(`rel.${kind}`, { gold: fmtNum(c.gold), points: c.points }))}</button>`;
  };
  const presentBtn = () => {
    const c = d.gifts.present;
    if (!c) return '';
    const wait = d.presentReadyAt > serverNow();
    return `<button type="button" class="btn ghost" data-gift="present" ${capped || !d.together || wait ? 'disabled' : ''}>\u{1F381} ${esc(t('rel.present', { points: c.points }))}</button>
      <p class="muted small">${wait ? withTimer('rel.presentWait', {}, d.presentReadyAt) : esc(t('prel.presentHint', { minutes: c.cooldownMinutes }))}</p>`;
  };
  const bonusVals = d.bonus.values || [];
  const overlay = document.createElement('div');
  overlay.id = 'rel-overlay';
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal rel-card" role="dialog" aria-modal="true" style="--c:${esc(fac?.color || '#c9a25a')}">
    <div class="rel-head"><span class="rel-face big"><img src="${avatarUrl(d.avatar)}" alt=""></span>
      <div><h2>${esc(d.pseudo)}</h2>
        <p class="small">${flag(d.faction)}<span style="color:${esc(fac?.color || 'inherit')}">${esc(fac ? loc(fac.name) : '')}</span> · ${esc(className(d.class))}</p>
        ${d.sameCamp ? '' : `<span class="pill">${esc(t('prel.otherCamp'))}</span>`}</div>
      <b class="rel-big">${esc(d.level || '\u2014')}</b></div>
    <div class="rel-levels">${lv.map((l, i) => `<span class="${i <= idx ? 'on' : ''}">${esc(l.id)}</span>`).join('')}</div>
    <div class="progress"><span class="xpbar"><i style="width:${pct}%"></i></span>
      <small class="muted">${next ? esc(t('rel.progress', { points: fmtNum(d.points), next: fmtNum(next.points), level: next.id })) : esc(t('prel.maxed', { points: fmtNum(d.points) }))}</small></div>
    <p class="muted small">${esc(t('prel.shared'))}</p>
    <div class="rel-gifts">${giftBtn('compliment', '\u{1F4AC}')}${giftBtn('flower', '\u{1F33C}')}${giftBtn('letter', '\u{2709}\uFE0F')}${presentBtn()}</div>
    <p class="muted small">${esc(t('rel.costs', { actions: pl.actions || 0, gold: fmtNum(gold) }))}</p>
    <div class="rel-bonus ${d.sameCamp && idx >= 0 ? 'on' : ''}"><strong>\u2728 ${esc(t('rel.bonus'))}</strong>
      <p class="small">${esc(t('prel.bonus', { v: bonusVals[Math.max(0, idx)] || 0, cap: d.bonus.capPct }))}</p>
      <div class="rel-values">${bonusVals.map((v, i) => `<span class="${i === idx ? 'on' : ''}"><small>${esc(lv[i]?.id || '')}</small>${esc(String(v))}</span>`).join('')}</div>
      ${state.me.player?.hp ? `<p class="small">${esc(t('prel.heal'))}</p>` : ''}
      <p class="muted small">${esc(t(!d.sameCamp ? 'prel.bonusCamp' : idx < 0 ? 'rel.bonusLocked' : 'prel.bonusActive'))}</p></div>
    <p class="error" role="alert" hidden></p>
    <button type="button" class="btn ghost" data-close>${esc(t('common.close'))}</button></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelectorAll('[data-gift]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await api('/relations/player/gift', { pseudo: d.pseudo, kind: b.dataset.gift });
      setMe(res);
      if (res.map) setMap(res.map);
      state.relations = res.relations;
      flash(res.gift.up ? t('rel.levelUp', { name: d.pseudo, level: res.gift.level }) : t('rel.gained', { name: d.pseudo, points: res.gift.gained }));
      if (redraw && document.querySelector('.relations')) redraw();
      showPlayerRelation(d.pseudo, redraw);
    } catch (err) {
      if (err.status === 401) return sessionLost();
      const el = overlay.querySelector('.error');
      el.textContent = err.message;
      el.hidden = false;
      b.disabled = false;
    }
  }));
}
// Commandes d'un général (profil) : ordre en cours, ou choix de l'ordre et du territoire.
function ordersHtml(d) {
  if (!d.command && !d.order) return '';
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  if (d.order) {
    return `<div class="pf-orders"><h3>\u{1F4EF} ${esc(t('order.title'))}</h3>
      <p class="small">${esc(t('order.current', { order: t(`order.kind.${d.order.kind}`), territory: terrName(d.order.target), pseudo: d.order.by || '' }))}</p>
      ${d.order.mine ? `<button type="button" class="btn compact ghost" data-ocancel>${esc(t('order.cancel'))}</button>` : `<p class="muted small">${esc(t('order.busy'))}</p>`}</div>`;
  }
  const c = d.command;
  if (!c.can) return `<div class="pf-orders"><h3>\u{1F4EF} ${esc(t('order.title'))}</h3><p class="muted small">${esc(t(`order.locked.${c.reason}`, { level: c.minLevel }))}</p></div>`;
  return `<div class="pf-orders"><h3>\u{1F4EF} ${esc(t('order.title'))}</h3>
    <p class="muted small">${esc(t('order.hint'))}</p>
    <div class="row order-kinds">${['attack', 'defend', 'move'].map((k, i) => `<button type="button" class="btn compact ${i ? 'ghost' : ''}" data-okind="${k}" ${c.targets[k].length ? '' : 'disabled'}>${esc(t(`order.kind.${k}`))}</button>`).join('')}</div>
    <select class="order-target" data-otarget aria-label="${esc(t('order.target'))}"></select>
    <button type="button" class="btn" data-ogo>${esc(t('order.give'))}</button></div>`;
}
function bindOrders(overlay, d, reopen) {
  const box = overlay.querySelector('.pf-orders');
  if (!box) return;
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  let kind = 'attack';
  const sel = box.querySelector('[data-otarget]');
  const fill = () => {
    if (!sel) return;
    const list = [...(d.command?.targets?.[kind] || [])].sort((a, b) => terrName(a).localeCompare(terrName(b)));
    sel.innerHTML = list.map((id) => `<option value="${esc(id)}">${esc(terrName(id))}</option>`).join('');
    box.querySelectorAll('[data-okind]').forEach((b) => b.classList.toggle('ghost', b.dataset.okind !== kind));
    box.querySelector('[data-ogo]').disabled = !list.length;
  };
  if (d.command?.targets && !d.command.targets.attack.length) kind = d.command.targets.defend.length ? 'defend' : 'move';
  fill();
  box.querySelectorAll('[data-okind]').forEach((b) => b.addEventListener('click', () => { kind = b.dataset.okind; fill(); }));
  const send = async (body) => {
    try {
      const res = await api('/general/order', { general: d.id, ...body });
      setMe(res);
      if (res.map) setMap(res.map);
      flash(body.cancel ? t('order.cancelled') : t('order.given', { name: d.name }));
      overlay.remove();
      reopen();
    } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
    }
  };
  box.querySelector('[data-ogo]')?.addEventListener('click', () => send({ kind, target: sel.value }));
  box.querySelector('[data-ocancel]')?.addEventListener('click', () => send({ cancel: true }));
}
function closestHtml(d) {
  if (!(d.closest || []).length) return '';
  return `<h3>${esc(t('profile.closest'))}</h3><div class="pf-closest">${d.closest.map((c) => `<button type="button" class="close-one" ${c.type === 'general' ? `data-gprofile="${esc(c.id)}"` : `data-profile="${esc(c.id)}"`}>
    <img src="${c.type === 'general' ? esc(c.avatar) : avatarUrl(c.avatar)}" alt=""><b>${esc(c.level || '\u2014')}</b><small>${esc(c.name)}</small></button>`).join('')}</div>`;
}
// Bonus de soutien d'un général : texte au niveau atteint (ou au niveau C), valeurs de C à S, et s'il est actif.
function relBonusHtml(g, idx) {
  const bd = state.config.relations?.bonuses?.[g.id];
  if (!bd) return `<p class="muted small">${esc(t('rel.bonusSoon'))}</p>`;
  const lv = state.relations.levels;
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  const text = t(`relb.${bd.kind}`, { v: bd.values[Math.max(0, idx)], name: g.name, partner: bd.partner ? generalName(bd.partner) : '', level: bd.partnerLevel || '', territory: bd.territory ? terrName(bd.territory) : '' });
  const status = g.state !== 'allied' ? t('rel.bonusInactive') : idx < 0 ? t('rel.bonusLocked') : t('rel.bonusActive');
  return `<div class="rel-bonus ${g.state === 'allied' && idx >= 0 ? 'on' : ''}"><strong>\u2728 ${esc(t('rel.bonus'))}</strong>
    <p class="small">${esc(text)}</p>
    <div class="rel-values">${bd.values.map((v, i) => `<span class="${i === idx ? 'on' : ''}"><small>${esc(lv[i]?.id || '')}</small>${esc(String(v))}</span>`).join('')}</div>
    <p class="muted small">${esc(status)}</p></div>`;
}
// Fenêtre de soutien avec un général : niveau, progression vers le suivant, et les offrandes (fleur, lettre).
function showRelation(gid, redraw) {
  const R = state.relations;
  if (!R) { api('/relations').then((rel) => { state.relations = rel; showRelation(gid, redraw); }).catch(() => {}); return; }
  const g = R && R.generals.find((x) => x.id === gid);
  if (!g) return;
  document.getElementById('rel-overlay')?.remove();
  const lv = R.levels;
  const idx = lv.findIndex((l) => l.id === g.level);
  const next = lv[idx + 1] || null;
  const from = idx >= 0 ? lv[idx].points : 0;
  const pct = next ? Math.min(100, ((g.points - from) / (next.points - from)) * 100) : 100;
  const pl = state.me.player || {};
  const gold = state.me.character.gold;
  const sTaken = R.sWith && R.sWith !== g.id;
  const capped = g.points >= lv[lv.length - 1].points || (sTaken && g.points >= lv[lv.length - 1].points - 1);
  const fac = faction(g.faction);
  const giftBtn = (kind, icon) => {
    const c = R.gifts[kind];
    const off = g.state !== 'allied' || capped || (pl.actions || 0) < c.actions || gold < c.gold;
    if (kind === 'compliment') return `<button type="button" class="btn ghost" data-gift="${kind}" ${off ? 'disabled' : ''}>${icon} ${esc(t('rel.compliment', { points: c.points }))}</button>`;
    return `<button type="button" class="btn ${kind === 'letter' ? '' : 'ghost'}" data-gift="${kind}" ${off ? 'disabled' : ''}>${icon} ${esc(t(`rel.${kind}`, { gold: fmtNum(c.gold), points: c.points }))}</button>`;
  };
  // Cadeau : gratuit, sur le territoire du général, une fois par heure.
  const presentBtn = () => {
    const c = R.gifts.present;
    if (!c) return '';
    const wait = (R.readyAt?.present || 0) > serverNow();
    const off = g.state !== 'allied' || capped || !R.here || R.here !== g.territory || wait;
    return `<button type="button" class="btn ghost" data-gift="present" ${off ? 'disabled' : ''}>\u{1F381} ${esc(t('rel.present', { points: c.points }))}</button>
      <p class="muted small">${wait ? withTimer('rel.presentWait', {}, R.readyAt.present) : esc(t('rel.presentHint'))}</p>`;
  };
  const overlay = document.createElement('div');
  overlay.id = 'rel-overlay';
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal rel-card" role="dialog" aria-modal="true" style="--c:${esc(fac?.color || '#c9a25a')}">
    <div class="rel-head"><span class="rel-face big ${g.state === 'allied' ? '' : 'gone'}"><img src="${esc(g.avatar)}" alt=""></span>
      <div><h2>${esc(g.name)}${g.lord ? ' \u{1F451}' : ''}</h2>
        <p class="small">${flag(g.faction)}<span style="color:${esc(fac?.color || 'inherit')}">${esc(fac ? loc(fac.name) : t('profile.independent'))}</span> · ${esc(className(g.class))}</p>
        ${g.state === 'allied' ? '' : `<span class="pill">${esc(t(`rel.state.${g.state}`))}</span>`}</div>
      <b class="rel-big">${esc(g.level || '\u2014')}</b></div>
    <div class="rel-levels">${lv.map((l, i) => `<span class="${i <= idx ? 'on' : ''}">${esc(l.id)}</span>`).join('')}</div>
    <div class="progress"><span class="xpbar"><i style="width:${pct}%"></i></span>
      <small class="muted">${next ? esc(t('rel.progress', { points: fmtNum(g.points), next: fmtNum(next.points), level: next.id })) : esc(t('rel.maxed', { points: fmtNum(g.points) }))}</small></div>
    ${sTaken ? `<p class="small muted">${esc(t('rel.sTaken', { name: R.generals.find((x) => x.id === R.sWith)?.name || '' }))}</p>` : ''}
    ${g.state === 'allied' ? `<div class="rel-gifts">${giftBtn('compliment', '\u{1F4AC}')}${giftBtn('flower', '\u{1F33C}')}${giftBtn('letter', '\u{2709}\uFE0F')}${presentBtn()}</div>
      <p class="muted small">${esc(t('rel.costs', { actions: pl.actions || 0, gold: fmtNum(gold) }))}</p>` : `<p class="muted small">${esc(t('rel.unavailable'))}</p>`}
    ${relBonusHtml(g, idx)}
    <p class="error" role="alert" hidden></p>
    <button type="button" class="btn ghost" data-close>${esc(t('common.close'))}</button></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelectorAll('[data-gift]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await api('/relations/gift', { general: g.id, kind: b.dataset.gift });
      setMe(res);
      if (res.map) setMap(res.map);
      state.relations = res.relations;
      flash(res.gift.up ? t('rel.levelUp', { name: g.name, level: res.gift.level }) : t('rel.gained', { name: g.name, points: res.gift.gained }));
      if (redraw && document.querySelector('.relations')) redraw();
      showRelation(g.id, redraw);
    } catch (err) {
      if (err.status === 401) return sessionLost();
      const el = overlay.querySelector('.error');
      el.textContent = err.message;
      el.hidden = false;
      b.disabled = false;
    }
  }));
}

// Fenêtre de confirmation (deux boutons) : renvoie une promesse vraie si le joueur confirme.
function confirmBox({ title, body, ok, cancel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal confirm" role="alertdialog" aria-modal="true"><h2>${esc(title)}</h2><p>${esc(body)}</p>
      <div class="row"><button type="button" class="btn" data-no>${esc(cancel)}</button><button type="button" class="btn danger" data-yes>${esc(ok)}</button></div></div>`;
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-yes]').addEventListener('click', () => done(true));
    overlay.querySelector('[data-no]').addEventListener('click', () => done(false));
  });
}

// Bonus et malus actifs : icône et phrase de chaque entrée renvoyée par le serveur.
function modIcon(m) {
  if (m.type === 'class') return classIcon(klass(m.class));
  if (m.type === 'support') return `<img class="mod-face" src="${esc((state.config.generals?.roster || []).find((x) => x.id === m.general)?.avatar || '')}" alt="">`;
  const icons = { overdrive: '\u26A1', perk: '\u{1F43A}', lord: '\u{1F451}', lordGen: '\u{1F451}', capitalLost: '\u{1F3DA}\uFE0F', exile: '\u{1F3F3}\uFE0F', rewardDebuff: '\u{1FA79}', retreating: '\u{1F3C3}', wounded: '\u{1F915}', hpLow: '\u{1F494}', playerSupport: '\u{1F91D}' };
  return `<span class="mod-ico" aria-hidden="true">${icons[m.type] || '\u2728'}</span>`;
}
function modText(m) {
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  switch (m.type) {
    case 'class': return `${className(m.class)} : ${effectText(klass(m.class))}`;
    case 'support': return `${generalName(m.general)} (${m.level}) : ${t(`relb.${m.kind}`, { v: m.value, name: generalName(m.general), partner: m.partner ? generalName(m.partner) : '', level: m.partnerLevel || '', territory: m.territory ? terrName(m.territory) : '' })}`;
    case 'perk': return t(`perk.${m.perk}`, { n: m.n, max: m.max, place: m.place ? terrName(m.place) : '' });
    case 'lord': { const ab = state.config.campaign?.lords?.[m.faction]?.ability; return t('mods.lordActive', { title: loc(ab?.title), effect: loc(ab?.description) }); }
    case 'overdrive': return t(m.level === 'plus' ? 'mods.overdrivePlus' : 'mods.overdrive', m);
    default: return t(`mods.${m.type}`, m);
  }
}
// Autres sources : résumé des puissances d'attaque et de défense apportées par les autres, puis chaque effet.
function othersHtml(d) {
  const o = d.others;
  if (!o) return '';
  const terrName = (id) => loc(state.config.map.territories.find((x) => x.id === id)?.name) || id;
  const signed = (n) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));
  const icons = { auras: '\u{1F31F}', enemyDebuff: '\u{1F480}', building: '\u{1F3F0}', capitalGuard: '\u{1F451}', rallyHelp: '\u{1F91D}', shield: '\u{1F6E1}\uFE0F', counter: '\u2694\uFE0F' };
  const line = (x) => {
    const p = { ...x, from: (x.from || []).join(', '), pct: x.type === 'rallyHelp' ? signed(x.pct) : fmtNum(x.pct) };
    const key = x.type === 'enemyDebuff' ? `others.enemyDebuff.${x.side}` : x.type === 'building' ? `others.building.${x.spec}` : `others.${x.type}`;
    const txt = x.type === 'shield' ? withTimer('others.shield', {}, x.until) : esc(t(key, p));
    return `<li class="${x.tone === 'debuff' ? 'debuff' : 'buff'}"><span class="mod-ico" aria-hidden="true">${icons[x.type] || '\u2728'}</span> <span>${txt}</span></li>`;
  };
  return `<div class="others"><h4>${esc(t('others.title', { territory: terrName(d.territory) }))}</h4>
    <p class="others-total"><b class="${o.attackPct < 0 ? 'neg' : ''}">${esc(t('others.total', { atk: signed(o.attackPct), def: signed(o.defensePct) }))}</b></p>
    ${o.items.length ? `<ul class="mods">${o.items.map(line).join('')}</ul>` : `<p class="muted small">${esc(t('others.none'))}</p>`}</div>`;
}
// Profil d'un joueur ou d'un général : fenêtre aux couleurs de sa faction d'origine (drapeau, nation, seigneur, icônes de classe).
async function showProfile(target) {
  let d;
  try { d = await api(`/profile?${target.general ? `general=${encodeURIComponent(target.general)}` : `pseudo=${encodeURIComponent(target.pseudo)}`}`); } catch (err) {
    if (err.status === 401) return sessionLost();
    flash(err.message, 'error');
    return;
  }
  document.getElementById('profile-overlay')?.remove();
  const home = faction(d.type === 'general' ? (d.origin || d.faction) : d.faction);
  const now = d.type === 'general' ? faction(d.faction) : d.exile ? faction(d.exile) : home;
  const pathHtml = (d.path || []).map((c) => `<span class="path-step">${classIcon(klass(c))}<small>${esc(className(c))}</small></span>`).join('<span class="path-arrow">\u203A</span>');
  const img = d.type === 'general' ? esc(d.avatar) : avatarUrl(d.avatar);
  const row = (k, v) => (v === null || v === undefined || v === '' ? '' : `<div class="pf-row"><span>${esc(k)}</span><b>${v}</b></div>`);
  const statusTxt = d.type === 'general' ? t(`profile.status.${d.status}`) : '';
  const dists = (d.distinctions || []).map((x) => { const def = (state.config.distinctions || []).find((y) => y.id === x.id); return def ? `<span class="pill">${esc(loc(def.name))}${x.count > 1 ? ` \u00D7${x.count}` : ''}</span>` : ''; }).join('');
  const overlay = document.createElement('div');
  overlay.id = 'profile-overlay';
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal profile-card" role="dialog" aria-modal="true" style="--c:${esc(home?.color || '#c9a25a')}">
    <div class="pf-head">
      ${home?.nation ? `<img class="pf-nation" src="${esc(home.nation)}" alt="">` : ''}
      ${home?.lord ? `<img class="pf-lord" src="${esc(home.lord)}" alt="">` : ''}
      <img class="pf-avatar" src="${img}" alt="">
      <div class="pf-id"><h2>${esc(d.type === 'general' ? d.name : d.pseudo)}${d.lord ? ' \u{1F451}' : ''}</h2>
        <p>${home?.logo ? `<img class="pf-flag" src="${esc(home.logo)}" alt="">` : ''}<span style="color:${esc(home?.color || 'inherit')}">${esc(home ? loc(home.name) : t('profile.independent'))}</span></p>
        ${d.type === 'general' ? `<span class="pill">${esc(t(d.lord ? 'profile.lord' : 'camp.general'))}</span>` : ''}
        ${d.exile ? `<span class="pill exile">${esc(t('exile.tag'))} ${flag(d.exile)} ${esc(loc(now?.name))}</span>` : ''}
        ${d.type === 'general' && d.faction && d.faction !== d.origin ? `<span class="pill">${esc(t('profile.joined'))} ${flag(d.faction)} ${esc(loc(now?.name))}</span>` : ''}</div>
    </div>
    <div class="pf-body">
      <div class="pf-class">${classIcon(klass(d.class))}<div><b>${esc(className(d.class))}</b><small>${esc(t('menu.playerRenown', { level: d.level }))}</small></div></div>
      ${row(t('profile.birthday'), d.birthday ? esc(fmtDate(d.birthday)) : null)}
      ${d.type === 'player' ? row(t('profile.score'), `${fmtNum(d.score)}${d.rank ? ` \u00B7 #${d.rank}` : ''}`) : ''}
      ${d.hp ? row(t('hp.label'), `${d.hp.hp} / ${d.hp.max} <i class="hpbar inline ${d.hp.pct < 25 ? 'crit' : d.hp.pct < 50 ? 'low' : ''}"><b style="width:${d.hp.pct}%"></b></i>`) : ''}
      ${d.type === 'general' ? row(t('profile.statusLabel'), esc(statusTxt)) : ''}
      ${d.type === 'general' && d.home ? row(t('profile.home'), esc(loc(state.config.map.territories.find((x) => x.id === d.home)?.name))) : ''}
      ${d.type === 'general' && (d.spare || []).length && !d.spared ? row(t('profile.spare'), d.spare.map((f) => flag(f)).join(' ')) : ''}
      ${d.type === 'player' && d.relation ? row(t('prel.withYou'), esc(d.relation.level || t('prel.noLevel'))) : ''}
      ${ordersHtml(d)}
      ${closestHtml(d)}
      <h3>${esc(t('profile.path'))}</h3><div class="pf-path">${pathHtml}</div>
      ${dists ? `<h3>${esc(t('menu.distinctions'))}</h3><div class="pf-dists">${dists}</div>` : ''}
      <details class="pf-mods"><summary>${esc(t('mods.button', { n: (d.mods || []).length }))}</summary>
        ${(d.mods || []).length ? `<ul class="mods">${d.mods.map((m) => `<li class="${m.tone === 'debuff' ? 'debuff' : 'buff'}">${modIcon(m)} <span>${esc(modText(m))}</span></li>`).join('')}</ul>` : `<p class="muted small">${esc(t('mods.none'))}</p>`}
        ${othersHtml(d)}
      </details>
    </div>
    ${d.type === 'general' ? `<button type="button" class="btn ghost" data-relopen hidden>${esc(t('rel.open'))}</button>` : ''}
    ${d.type === 'player' && !d.me ? `<button type="button" class="btn ghost" data-prelopen>${esc(t('rel.open'))}</button>` : ''}
    <button type="button" class="btn" data-close>${esc(t('common.close'))}</button></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-prelopen]')?.addEventListener('click', () => { overlay.remove(); showPlayerRelation(d.pseudo); });
  bindOrders(overlay, d, () => showProfile(target));
  // Soutien : seulement pour un général de mon camp (vivant allié, ou de ma faction et grisé).
  const relBtn = overlay.querySelector('[data-relopen]');
  if (relBtn) {
    (async () => {
      try { state.relations = await api('/relations'); } catch { return; }
      if (!state.relations.generals.some((x) => x.id === d.id) || !relBtn.isConnected) return;
      relBtn.hidden = false;
      relBtn.addEventListener('click', () => { overlay.remove(); showRelation(d.id); });
    })();
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-profile], [data-gprofile]');
  if (!el || !state.me?.character) return;
  e.stopPropagation();
  showProfile(el.dataset.gprofile ? { general: el.dataset.gprofile } : { pseudo: el.dataset.profile });
}, true);

// Signaler un bug : un court message (500 caractères au plus) envoyé à l'équipe.
function renderBug() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  view.innerHTML = panelHead(`\u{1F41E} ${t('bug.title')}`) + `<p class="muted">${esc(t('bug.intro'))}</p>
    <section class="card"><textarea class="bug-text" maxlength="500" rows="7" placeholder="${esc(t('bug.placeholder'))}"></textarea>
      <div class="row"><small class="muted bug-count">0 / 500</small><button type="button" class="btn" data-send disabled>${esc(t('bug.send'))}</button></div></section>`;
  bindClose(view);
  const ta = view.querySelector('.bug-text');
  const btn = view.querySelector('[data-send]');
  ta.addEventListener('input', () => { view.querySelector('.bug-count').textContent = `${ta.value.length} / 500`; btn.disabled = !ta.value.trim(); });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api('/bug', { message: ta.value.trim() }); flash(t('bug.thanks')); go('menu'); } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
      btn.disabled = false;
    }
  });
}

// Exil : la faction est tombée. Écran solennel, chaque bannière possible avec son drapeau, sa nation et son seigneur.
async function renderExile() {
  const view = document.getElementById('view');
  view.className = 'view scroll exile-view';
  view.innerHTML = panelHead(t('exile.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  let data;
  try { data = await api('/journal'); } catch (err) { if (err.status === 401) return sessionLost(); return; }
  if (state.tab !== 'exile' || !view.isConnected) return;
  const lost = faction(state.me.character.faction);
  const info = data.exile;
  view.innerHTML = panelHead(t('exile.title')) + `
    <section class="exile-fall" style="--c:${esc(lost?.color || '#888')}">
      ${lost?.logo ? `<img class="fallen-flag" src="${esc(lost.logo)}" alt="">` : ''}
      <div><h2>${esc(t('exile.fallTitle', { faction: loc(lost?.name) }))}</h2><p>${esc(t('exile.fallBody'))}</p></div>
    </section>
    ${info ? `<p class="note">${esc(t('exile.rules', { malus: info.malus }))}</p>
      ${info.options.length ? info.options.map((f) => `<div class="exile-option">${factionHero(faction(f), `<strong class="faction-name">${esc(loc(faction(f)?.name))}</strong><span class="faction-desc">${esc(loc(faction(f)?.description))}</span>`)}
        <button type="button" class="btn" data-exile="${esc(f)}">${esc(t('exile.join', { faction: loc(faction(f)?.name) }))}</button></div>`).join('')
    : `<p class="muted">${esc(t('exile.none'))}</p>`}` : `<p class="muted">${esc(t('exile.unavailable'))}</p>`}`;
  bindClose(view);
  view.querySelectorAll('[data-exile]').forEach((b) => b.addEventListener('click', async () => {
    view.querySelectorAll('[data-exile]').forEach((x) => { x.disabled = true; });
    try {
      const res = await api('/exile', { faction: b.dataset.exile });
      setMe(res);
      setMap(res.map);
      state.selected = res.player.territory;
      go('map');
    } catch (err) {
      if (err.status === 401) return sessionLost();
      flash(err.message, 'error');
      view.querySelectorAll('[data-exile]').forEach((x) => { x.disabled = false; });
    }
  }));
}

// Fenêtre de fin de campagne : résultat de la faction, détail des points et classement, montrée une fois à chaque participant.
function showResult() {
  const r = state.me?.result;
  if (!r || !state.me.character || document.getElementById('result-overlay')) return;
  const mine = faction(r.faction);
  const winner = r.winner ? faction(r.winner) : null;
  const verdict = !winner ? t('result.draw') : r.won ? t('result.won') : t(numKey('result.lost', r.winner), { faction: loc(winner.name) });
  const part = (k, v) => `<li><span>${esc(k)}</span><b>+${fmtNum(v)}</b></li>`;
  const lines = [
    ...r.parts.map((x) => part(t(`result.part.${x.key}`), x.points)),
    ...(r.mult > 1 ? [`<li><span>${esc(t('result.mult', { n: Math.round((r.mult - 1) * 100) }))}</span><b>×${r.mult}</b></li>`] : []),
    ...(r.win ? [part(t('result.part.win'), r.win)] : []),
  ].join('');
  const overlay = document.createElement('div');
  overlay.id = 'result-overlay';
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(t('result.title'))}">
    <p class="steps">${esc(t('result.title'))} · ${esc(t(`result.reason.${r.reason}`))}</p>
    <h2 class="${r.won ? 'won' : ''}">${esc(verdict)}</h2>
    <p class="result-faction">${mine ? flag(mine.id) + esc(loc(mine.name)) : ''} <b>${esc(t('result.points', { n: fmtNum(r.factionPoints) }))}</b></p>
    ${r.exile ? `<p class="muted small">${esc(t('result.exileNote'))}</p>` : `<ul class="result-parts">${lines}</ul>`}
    <h3>${esc(t('result.standings'))}</h3>
    <ol class="result-standings">${r.standings.map((x) => `<li>${flag(x.faction)}<span>${esc(loc(faction(x.faction)?.name))}</span><small class="muted">${esc(t('result.map', { pct: x.pct }))}</small><b>${fmtNum(x.points)}</b></li>`).join('')}</ol>
    <p class="small">${r.rank ? esc(t('result.rank', { rank: r.rank, score: fmtNum(r.score) })) : ''}${r.rankGold ? ' · ' + esc(t('result.rankGold', { gold: fmtNum(r.rankGold) })) : ''}${r.exileGold ? ' · ' + esc(t('result.exileGold', { gold: fmtNum(r.exileGold) })) : ''}</p>
    <button type="button" class="btn" data-close>${esc(t('result.close'))}</button></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-close]').addEventListener('click', async () => {
    overlay.remove();
    try { setMe(await api('/campaign/seen', {})); } catch (err) { if (err.status === 401) sessionLost(); }
  });
}

// Mise à jour majeure (« major » dans game.json) pas encore lue : elle s'ouvre d'elle-même à la connexion, une seule fois.
// Elle attend que le bilan de campagne et l'écran de chute soient fermés.
function showMajorPatch() {
  const pt = (state.config.patches || [])[0];
  if (!pt || !pt.major || !state.me?.character || !patchUnread()) return;
  if (document.querySelector('#result-overlay, #gameover-overlay, #patch-overlay, .overlay')) return;
  const markSeen = () => {
    state.me.patch = { ...state.me.patch, seen: state.me.patch.latest };
    document.querySelector('.tabbar .new-dot')?.remove();
    api('/patch/seen', {}).catch(() => {});
  };
  const overlay = document.createElement('div');
  overlay.id = 'patch-overlay';
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal patch-modal" role="dialog" aria-modal="true" aria-label="${esc(loc(pt.title))}">
    ${pt.image ? `<figure class="patch-hero"><img src="${esc(loc(pt.image))}" alt=""></figure>` : ''}
    <div class="patch-modal-body">
      <p class="steps">\u{1F4F0} ${esc(t('patch.major'))}</p>
      <h2>${esc(loc(pt.title))}</h2>
      ${pt.intro ? `<p>${esc(loc(pt.intro))}</p>` : ''}
      ${(pt.sections || []).map((sec) => `<h3>${esc(loc(sec.title))}</h3>
        <ul class="patch-list">${(sec.items || []).map((i) => `<li>${esc(loc(i))}</li>`).join('')}</ul>`).join('')}
    </div>
    <div class="patch-modal-foot"><button type="button" class="btn" data-close>${esc(t('patch.gotIt'))}</button></div></div>`;
  document.body.appendChild(overlay);
  markSeen();
  overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
}

// Mon impact : ce que j'ai accompli dans la campagne en cours, et à vie.
async function renderImpact() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  view.innerHTML = panelHead(t('impact.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  let d;
  try { d = await api('/impact'); } catch (err) { if (err.status === 401) return sessionLost(); view.innerHTML = panelHead(t('impact.title')) + `<p class="error">${esc(err.message)}</p>`; bindClose(view); return; }
  if (state.tab !== 'impact' || !view.isConnected) return;
  const row = (k, v) => `<div class="stat"><span>${esc(t(k))}</span><b>${v}</b></div>`;
  view.innerHTML = panelHead(t('impact.title')) + `
    <section class="card"><h2>${esc(t('impact.campaign'))}</h2><div class="stats">
      ${['conquests', 'defenses', 'combat', 'generals', 'spared', 'retakes', 'annexes', 'garreg', 'builds', 'deaths'].map((k) => row(`impact.${k}`, fmtNum(d[k] || 0))).join('')}
      ${row('impact.score', fmtNum(d.score))}${row('impact.rank', d.rank ? `#${d.rank}` : '–')}${row('impact.share', `${d.share} %`)}</div></section>
    <section class="card"><h2>${esc(t('impact.life'))}</h2><div class="stats">
      ${Object.entries(d.life).map(([k, v]) => row(`impact.life.${k}`, fmtNum(v))).join('')}</div></section>`;
  bindClose(view);
}

// Panthéon : saison en cours, campagnes passées avec leur podium, saisons terminées.
async function renderPantheon() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  view.innerHTML = panelHead(t('pantheon.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  let d;
  try { d = await api('/pantheon'); } catch (err) { if (err.status === 401) return sessionLost(); view.innerHTML = panelHead(t('pantheon.title')) + `<p class="error">${esc(err.message)}</p>`; bindClose(view); return; }
  if (state.tab !== 'pantheon' || !view.isConnected) return;
  const fname = (id) => (id ? `${flag(id)}<span style="color:${esc(faction(id)?.color || 'inherit')}">${esc(loc(faction(id)?.name))}</span>` : '');
  const players = (list) => `<ol class="result-standings">${list.map((x, i) => `<li data-profile="${esc(x.pseudo)}" role="button" tabindex="0"><span class="rk">${i + 1}</span><img class="avatar tiny" src="${avatarUrl(x.avatar)}" alt=""><span>${esc(x.pseudo)} ${flag(x.faction)}</span><b>${fmtNum(x.score)}</b></li>`).join('')}</ol>`;
  const factions = (totals) => `<ol class="result-standings">${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([f, n]) => `<li>${flag(f)}<span>${esc(loc(faction(f)?.name))}</span><b>${fmtNum(n)}</b></li>`).join('')}</ol>`;
  view.innerHTML = panelHead(t('pantheon.title')) + `
    <section class="card"><h2>${esc(t('pantheon.season', { n: d.season.number, done: d.season.done, length: d.season.length }))}</h2>
      ${Object.keys(d.season.factions).length ? `<h3>${esc(t('pantheon.seasonFactions'))}</h3>${factions(d.season.factions)}` : ''}
      ${d.season.players.length ? `<h3>${esc(t('pantheon.seasonPlayers'))}</h3>${players(d.season.players)}` : `<p class="muted">${esc(t('pantheon.empty'))}</p>`}</section>
    ${d.seasons.length ? `<h2 class="section-title">${esc(t('pantheon.seasons'))}</h2>${d.seasons.map((x) => `<section class="card"><h3>${esc(t('pantheon.seasonNo', { n: x.season }))} · ${x.winner ? esc(t('pantheon.winner', { faction: '' })) + fname(x.winner) : esc(t('pantheon.draw'))}</h3>${players(x.players.slice(0, 3))}</section>`).join('')}` : ''}
    ${d.campaigns.length ? `<h2 class="section-title">${esc(t('pantheon.campaigns'))}</h2>${d.campaigns.map((c) => `<section class="card"><h3>${esc(t('pantheon.campaign', { n: c.id }))} · ${c.winner ? esc(t('pantheon.winner', { faction: '' })) + fname(c.winner) : esc(t('pantheon.draw'))}</h3>${c.top.length ? players(c.top) : ''}</section>`).join('')}` : ''}`;
  bindClose(view);
}

// Notifications push : activer sur cet appareil, choisir ce qu'on veut recevoir.
async function renderPush() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  view.innerHTML = panelHead(t('push.title')) + `<p class="muted">${esc(t('common.loading'))}</p>`;
  bindClose(view);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let st;
  try { st = await api('/push/status'); } catch (err) { if (err.status === 401) return sessionLost(); return; }
  if (state.tab !== 'pushsettings' || !view.isConnected) return;
  const reg = supported ? await navigator.serviceWorker.ready.catch(() => null) : null;
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  const on = !!sub && st.subscribed;
  const denied = supported && Notification.permission === 'denied';
  const prefs = ['stamina', 'attacked', 'rally', 'results', 'verdict'];
  view.innerHTML = panelHead(t('push.title')) + `
    <p class="muted">${esc(t('push.hint'))}</p>
    <section class="card">
      ${!supported ? `<p class="note">${esc(t('push.unsupported'))}</p>` : denied ? `<p class="note">${esc(t('push.denied'))}</p>`
    : on ? `<p>${esc(t('push.enabled'))}</p><button type="button" class="btn ghost compact" data-push="off">${esc(t('push.disable'))}</button>`
      : `<button type="button" class="btn" data-push="on">${esc(t('push.enable'))}</button>`}
    </section>
    ${on ? `<section class="card">${prefs.map((k) => `<label class="check"><input type="checkbox" data-pref="${k}" ${st.prefs[k] ? 'checked' : ''}> ${esc(t(`push.${k}`))}</label>`).join('')}</section>` : ''}`;
  bindClose(view);
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  view.querySelector('[data-push=on]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      if ((await Notification.requestPermission()) !== 'granted') return renderPush();
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(st.key) });
      await api('/push/subscribe', { subscription: s.toJSON() });
    } catch (err) { flash(err.message || String(err), 'error'); }
    renderPush();
  });
  view.querySelector('[data-push=off]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await api('/push/unsubscribe', { endpoint });
    } catch (err) { flash(err.message || String(err), 'error'); }
    renderPush();
  });
  view.querySelectorAll('[data-pref]').forEach((c) => c.addEventListener('change', async () => {
    try { await api('/push/prefs', { [c.dataset.pref]: c.checked }); } catch (err) { flash(err.message || String(err), 'error'); }
  }));
}

// Aide : ajouter le jeu à l'écran d'accueil (Android et iOS). La plateforme détectée s'affiche en premier.
function renderInstall() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const block = (title, p) => `<section class="card"><h2>${esc(t(title))}</h2><ol class="install-steps">${[1, 2, 3, 4].map((n) => `<li>${esc(t(`install.${p}${n}`))}</li>`).join('')}</ol></section>`;
  const blocks = [block('install.android', 'a'), block('install.ios', 'i')];
  view.innerHTML = panelHead(t('install.title')) + `<p class="muted">${esc(t('install.intro'))}</p>` + (ios ? blocks.reverse() : blocks).join('')
    + `<p class="muted small">${esc(t('install.note'))}</p>`;
  bindClose(view);
}

// Notes de mise à jour : les plus récentes d'abord. Les ouvrir les marque comme lues (la pastille disparaît).
function renderPatches() {
  const view = document.getElementById('view');
  view.className = 'view scroll';
  const patches = state.config.patches || [];
  const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
  // La dernière mise à jour est affichée ; les précédentes sont archivées chacune dans un dépliant fermé.
  const body = (pt) => `${pt.intro ? `<p class="muted">${esc(loc(pt.intro))}</p>` : ''}
      ${(pt.sections || []).map((sec) => `<h3>${esc(loc(sec.title))}</h3>
        <ul class="patch-list">${(sec.items || []).map((i) => `<li>${esc(loc(i))}</li>`).join('')}</ul>`).join('')}`;
  const head = (pt) => `${esc(loc(pt.title))}${pt.date ? ` <span class="muted small">· ${esc(fmt(pt.date))}</span>` : ''}`;
  // Grosse mise à jour : une illustration (dans la langue du joueur) en tête, fondue dans la carte.
  const hero = (pt) => (pt.image ? `<figure class="patch-hero"><img src="${esc(loc(pt.image))}" alt="${esc(loc(pt.title))}" loading="lazy"></figure>` : '');
  view.innerHTML = panelHead(`\u{1F4F0} ${t('patch.title')}`) + (patches.length ? patches.map((pt, i) => (i === 0
    ? `<section class="card patch ${pt.image ? 'has-hero' : ''}">${hero(pt)}<h2>${head(pt)}</h2>${body(pt)}</section>`
    : `<details class="card patch archived"><summary><strong>${head(pt)}</strong></summary>${hero(pt)}${body(pt)}</details>`)).join('') : `<p class="muted">${esc(t('patch.empty'))}</p>`);
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
    // Classes réservées aux généraux : jamais proposées au joueur, mais connues pour afficher leur nom.
    config.npcClasses = config.classes.filter((c) => c.npc);
    config.classes = config.classes.filter((c) => !c.npc);
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
