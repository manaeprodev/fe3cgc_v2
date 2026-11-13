'use strict';
// Serveur du jeu : fichiers statiques + API JSON + base SQLite.
// Aucune dépendance externe (Node >= 22.13).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'assets', 'avatars');
const SESSION_DAYS = 30;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);

const config = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'config', 'game.json'), 'utf8'));

// ---------------------------------------------------------------- Base de données
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'conquete.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    pseudo     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    birthday   TEXT NOT NULL,
    class      TEXT NOT NULL,
    avatar     TEXT NOT NULL,
    faction    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );

  -- Journal de toutes les tentatives de connexion / inscription / déconnexion
  CREATE TABLE IF NOT EXISTS login_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email      TEXT,
    event      TEXT NOT NULL,
    success    INTEGER NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );

  -- État des territoires (la définition : nom, coordonnées, est dans config/game.json)
  CREATE TABLE IF NOT EXISTS territories (
    id         TEXT PRIMARY KEY,
    faction    TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, read_at);

  -- Une ligne par mission accomplie ; claimed_at est rempli quand la récompense est récupérée.
  CREATE TABLE IF NOT EXISTS mission_progress (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mission_id   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    claimed_at   TEXT,
    PRIMARY KEY (user_id, mission_id)
  );

  -- Compteurs d'actions du joueur, utilisés par les conditions des missions.
  CREATE TABLE IF NOT EXISTS player_events (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event   TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, event)
  );
`);

// Réglages du joueur (surchargeables dans config/game.json, clé "player").
const PLAYER = { startGold: 500, renownBaseXp: 100, renownGrowth: 1.1, ...(config.player || {}) };
const MISSIONS = Array.isArray(config.missions) ? config.missions : [];
const MISSION_EVENTS = new Set(MISSIONS.filter((m) => m.condition?.type === 'event').map((m) => m.condition.event));

// Migration : ressources du joueur (or, et xp dont découle la renommée).
{
  const cols = db.prepare('PRAGMA table_info(characters)').all().map((c) => c.name);
  if (!cols.includes('gold')) db.exec(`ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT ${Number(PLAYER.startGold) || 0}`);
  if (!cols.includes('xp')) db.exec('ALTER TABLE characters ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
  // Notifications traduisibles : on stocke un type et des paramètres, le texte est produit par l'app.
  const ncols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  if (!ncols.includes('type')) db.exec('ALTER TABLE notifications ADD COLUMN type TEXT');
  if (!ncols.includes('params')) db.exec('ALTER TABLE notifications ADD COLUMN params TEXT');
  // Langue choisie par le joueur (servira aussi aux futurs emails).
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('lang')) db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
  // Les personnages créés avant les missions comptent aussi comme « créés ».
  db.exec("INSERT OR IGNORE INTO player_events (user_id, event, count) SELECT user_id, 'character_created', 1 FROM characters");
}

const now = () => new Date().toISOString();

const seedTerritory = db.prepare('INSERT OR IGNORE INTO territories (id, faction, updated_at) VALUES (?, NULL, ?)');
for (const t of config.map.territories) seedTerritory.run(t.id, now());

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, password_salt, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
  sessionUser: db.prepare(`SELECT u.id, u.email, u.lang, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  logEvent: db.prepare('INSERT INTO login_events (user_id, email, event, success, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  character: db.prepare('SELECT pseudo, birthday, class, avatar, faction, gold, xp, created_at FROM characters WHERE user_id = ?'),
  pseudoTaken: db.prepare('SELECT 1 FROM characters WHERE pseudo = ?'),
  insertCharacter: db.prepare('INSERT INTO characters (user_id, pseudo, birthday, class, avatar, faction, gold, xp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'),
  players: db.prepare('SELECT pseudo, birthday, class, avatar, faction, xp FROM characters ORDER BY pseudo COLLATE NOCASE'),
  territories: db.prepare('SELECT id, faction FROM territories'),
  addResources: db.prepare('UPDATE characters SET gold = gold + ?, xp = xp + ? WHERE user_id = ?'),
  insertNotif: db.prepare("INSERT INTO notifications (user_id, title, body, type, params, created_at) VALUES (?, ?, '', ?, ?, ?)"),
  notifs: db.prepare('SELECT id, title, body, type, params, created_at, read_at IS NOT NULL AS read FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
  setLang: db.prepare('UPDATE users SET lang = ? WHERE id = ?'),
  unread: db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
  markRead: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
  missionRows: db.prepare('SELECT mission_id, completed_at, claimed_at FROM mission_progress WHERE user_id = ?'),
  completeMission: db.prepare('INSERT OR IGNORE INTO mission_progress (user_id, mission_id, completed_at) VALUES (?, ?, ?)'),
  claimMission: db.prepare('UPDATE mission_progress SET claimed_at = ? WHERE user_id = ? AND mission_id = ? AND claimed_at IS NULL'),
  events: db.prepare('SELECT event, count FROM player_events WHERE user_id = ?'),
  bumpEvent: db.prepare(`INSERT INTO player_events (user_id, event, count) VALUES (?, ?, 1)
                         ON CONFLICT (user_id, event) DO UPDATE SET count = count + 1`),
};
q.purgeSessions.run(now());

// ---------------------------------------------------------------- Utilitaires
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

function verifyPassword(password, salt, expectedHex) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientInfo(req) {
  return {
    ip: req.socket.remoteAddress || '',
    ua: String(req.headers['user-agent'] || '').slice(0, 300),
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const { ip, ua } = clientInfo(req);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  q.insertSession.run(sha256(token), userId, now(), expires, ip, ua);
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return q.sessionUser.get(sha256(token), now()) || null;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'bad_format'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

// Limite simple anti force brute : 10 tentatives par IP toutes les 10 minutes.
const attempts = new Map();
function rateLimit(req) {
  const ip = req.socket.remoteAddress || '?';
  const t = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < t) { a = { count: 0, reset: t + 600_000 }; attempts.set(ip, a); }
  a.count += 1;
  if (a.count > 10) throw new HttpError(429, 'rate_limited');
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, a] of attempts) if (a.reset < t) attempts.delete(ip);
  q.purgeSessions.run(now());
}, 600_000).unref();

function listAvatars() {
  try {
    return fs.readdirSync(AVATAR_DIR)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  } catch { return []; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PSEUDO_RE = /^[\p{L}\p{N}_-]{3,20}$/u;

function validBirthday(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  return d.getUTCFullYear() >= 1900 && d.getTime() < Date.now();
}

// Renommée = niveau calculé à partir de l'xp cumulée.
// Niveau 1 : 100 xp, puis chaque niveau coûte 10 % de plus que le précédent (100, 110, 121, 133…).
function renown(totalXp) {
  let level = 0;
  let rest = totalXp;
  let needed = PLAYER.renownBaseXp;
  while (rest >= needed) {
    rest -= needed;
    level += 1;
    needed = Math.round(needed * PLAYER.renownGrowth);
  }
  return { level, xp: rest, needed };
}

// Types de notification : welcome {pseudo, faction}, mission_done {mission}, renown {level}.
// Le texte de chaque type est dans public/i18n/<langue>.json (clés notif.<type>.title / .body).
function notify(userId, type, params = {}) {
  q.insertNotif.run(userId, type, type, JSON.stringify(params), now());
}

function parseParams(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

// Donne de l'or et/ou de l'xp à un joueur, et le prévient s'il gagne un niveau de renommée.
function grant(userId, gold, xp) {
  const ch = q.character.get(userId);
  if (!ch) return;
  const before = renown(ch.xp).level;
  q.addResources.run(gold, xp, userId);
  const after = renown(ch.xp + xp).level;
  for (let l = before + 1; l <= after; l += 1) notify(userId, 'renown', { level: l });
}

// État des missions du joueur. Marque au passage celles dont la condition vient d'être remplie.
function missionState(userId) {
  const ch = q.character.get(userId);
  if (!ch) return [];
  const rows = new Map(q.missionRows.all(userId).map((r) => [r.mission_id, r]));
  const events = new Map(q.events.all(userId).map((r) => [r.event, r.count]));
  const level = renown(ch.xp).level;
  return MISSIONS.map((m) => {
    const c = m.condition || {};
    let current = 0;
    let target = 1;
    if (c.type === 'event') { target = c.count || 1; current = events.get(c.event) || 0; }
    else if (c.type === 'renown') { target = c.level || 1; current = level; }
    else if (c.type === 'gold') { target = c.amount || 1; current = ch.gold; }
    let row = rows.get(m.id);
    if (!row && current >= target) {
      q.completeMission.run(userId, m.id, now());
      notify(userId, 'mission_done', { mission: m.id });
      row = { claimed_at: null };
    }
    return {
      id: m.id,
      title: m.title,
      description: m.description || '',
      rewards: { gold: m.rewards?.gold || 0, xp: m.rewards?.xp || 0 },
      status: row ? (row.claimed_at ? 'claimed' : 'done') : 'active',
      current: row ? target : Math.min(current, target),
      target,
    };
  });
}

function mePayload(user) {
  const claimable = missionState(user.id).filter((m) => m.status === 'done').length;
  const ch = q.character.get(user.id);
  return {
    user: { id: user.id, email: user.email, lang: user.lang || null },
    character: ch ? { ...ch, renown: renown(ch.xp) } : null,
    unread: q.unread.get(user.id).n,
    claimable,
  };
}

// ---------------------------------------------------------------- API
const routes = {
  'POST /api/register': async (req, res) => {
    rateLimit(req);
    const { email, password, passwordConfirm } = await readJson(req);
    const { ip, ua } = clientInfo(req);
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'invalid_email');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'password_short');
    if (password !== passwordConfirm) throw new HttpError(400, 'password_mismatch');
    const mail = email.trim().toLowerCase();
    if (q.userByEmail.get(mail)) {
      q.logEvent.run(null, mail, 'register', 0, ip, ua, now());
      throw new HttpError(409, 'email_taken');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const info = q.insertUser.run(mail, hashPassword(password, salt), salt, now(), now());
    const userId = Number(info.lastInsertRowid);
    q.logEvent.run(userId, mail, 'register', 1, ip, ua, now());
    createSession(req, res, userId);
    send(res, 201, mePayload({ id: userId, email: mail }));
  },

  'POST /api/login': async (req, res) => {
    rateLimit(req);
    const { email, password } = await readJson(req);
    const { ip, ua } = clientInfo(req);
    const mail = String(email || '').trim().toLowerCase().slice(0, 254);
    const user = q.userByEmail.get(mail);
    // On calcule toujours un hash pour ne pas révéler si l'email existe via le temps de réponse.
    const ok = verifyPassword(String(password || ''), user ? user.password_salt : 'x', user ? user.password_hash : '00');
    if (!user || !ok) {
      q.logEvent.run(user ? user.id : null, mail, 'login', 0, ip, ua, now());
      throw new HttpError(401, 'bad_credentials');
    }
    q.touchLogin.run(now(), user.id);
    q.logEvent.run(user.id, mail, 'login', 1, ip, ua, now());
    createSession(req, res, user.id);
    send(res, 200, mePayload(user));
  },

  'POST /api/logout': async (req, res) => {
    const token = parseCookies(req).sid;
    const user = currentUser(req);
    if (token) q.deleteSession.run(sha256(token));
    if (user) {
      const { ip, ua } = clientInfo(req);
      q.logEvent.run(user.id, user.email, 'logout', 1, ip, ua, now());
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    send(res, 200, { ok: true });
  },

  'GET /api/me': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    send(res, 200, mePayload(user));
  },

  'GET /api/avatars': async (req, res) => send(res, 200, { avatars: listAvatars() }),

  'POST /api/character': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    if (q.character.get(user.id)) throw new HttpError(409, 'character_exists');
    const { pseudo, birthday, class: klass, avatar, faction } = await readJson(req);
    if (typeof pseudo !== 'string' || !PSEUDO_RE.test(pseudo)) throw new HttpError(400, 'invalid_pseudo');
    if (!validBirthday(birthday)) throw new HttpError(400, 'invalid_birthday');
    if (!config.classes.some((c) => c.id === klass)) throw new HttpError(400, 'invalid_class');
    if (!listAvatars().includes(avatar)) throw new HttpError(400, 'invalid_avatar');
    if (!config.factions.some((f) => f.id === faction)) throw new HttpError(400, 'invalid_faction');
    if (q.pseudoTaken.get(pseudo)) throw new HttpError(409, 'pseudo_taken');
    q.insertCharacter.run(user.id, pseudo, birthday, klass, avatar, faction, Number(PLAYER.startGold) || 0, now());
    q.bumpEvent.run(user.id, 'character_created');
    notify(user.id, 'welcome', { pseudo, faction });
    send(res, 201, mePayload(user));
  },

  'GET /api/players': async (req, res) => {
    if (!currentUser(req)) throw new HttpError(401, 'unauthorized');
    send(res, 200, { players: q.players.all().map(({ xp, ...p }) => ({ ...p, renown: renown(xp).level })) });
  },

  'GET /api/notifications': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    send(res, 200, { notifications: q.notifs.all(user.id).map((n) => ({ ...n, params: parseParams(n.params), read: !!n.read })) });
  },

  // Mémorise la langue choisie par le joueur.
  'POST /api/lang': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { lang } = await readJson(req);
    if (!(config.languages || []).some((l) => l.code === lang)) throw new HttpError(400, 'invalid_lang');
    q.setLang.run(lang, user.id);
    send(res, 200, { ok: true });
  },

  'POST /api/notifications/read': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    q.markRead.run(now(), user.id);
    send(res, 200, mePayload(user));
  },

  'GET /api/missions': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    send(res, 200, { missions: missionState(user.id) });
  },

  'POST /api/missions/claim': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { id } = await readJson(req);
    const mission = MISSIONS.find((m) => m.id === id);
    if (!mission) throw new HttpError(404, 'mission_unknown');
    missionState(user.id); // enregistre la mission si elle vient d'être accomplie
    // La mise à jour ne touche une ligne que si la mission est accomplie et pas encore récupérée.
    if (q.claimMission.run(now(), user.id, id).changes !== 1) throw new HttpError(409, 'reward_unavailable');
    grant(user.id, mission.rewards?.gold || 0, mission.rewards?.xp || 0);
    const me = mePayload(user); // réévalue les missions (ex. palier de renommée atteint)
    send(res, 200, { ...me, missions: missionState(user.id) });
  },

  // Signale une action du joueur utile aux missions (ex. « rules_read »).
  'POST /api/events': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { event } = await readJson(req);
    if (MISSION_EVENTS.has(event) && q.character.get(user.id)) q.bumpEvent.run(user.id, event);
    send(res, 200, mePayload(user));
  },

  'GET /api/map': async (req, res) => {
    if (!currentUser(req)) throw new HttpError(401, 'unauthorized');
    const owners = new Map(q.territories.all().map((t) => [t.id, t.faction]));
    send(res, 200, {
      territories: config.map.territories.map((t) => ({ ...t, faction: owners.get(t.id) || null })),
    });
  },
};

// ---------------------------------------------------------------- Fichiers statiques
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- Serveur
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    const handler = routes[`${req.method} ${pathname}`];
    try {
      if (!handler) throw new HttpError(404, 'not_found');
      await handler(req, res);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'server_error' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => console.log(`Conquête : http://localhost:${PORT}`));
