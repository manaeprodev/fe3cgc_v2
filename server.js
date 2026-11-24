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
// DATA_DIR permet de placer la base ailleurs (utile pour les tests).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'assets', 'avatars');
const SESSION_DAYS = 30;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);

const config = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'config', 'game.json'), 'utf8'));
// Carte : image de fond, contour de chaque territoire et liste de ses voisins.
config.map = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'config', 'map.json'), 'utf8'));
// Effets de classe et lignée de classes d'un joueur (voir effects.js).
const fx = require('./effects')(config);

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

// Signalements de bugs des joueurs : gardés en base (visibles sur /admin.html) et envoyés par mail si un serveur SMTP est configuré
// (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS ; destinataire BUG_REPORT_TO). Voir mailer.js.
db.exec(`CREATE TABLE IF NOT EXISTS bug_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pseudo TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL, emailed INTEGER NOT NULL DEFAULT 0)`);
const mailer = require('./mailer');
// Confirmation des adresses email à l'inscription : active dès que l'envoi de mails est configuré (EMAIL_VERIFY=0 pour la couper).
const VERIFY_EMAILS = () => mailer.configured() && process.env.EMAIL_VERIFY !== '0';
async function sendCode(userId, email, lang) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const prev = db.prepare('SELECT sends FROM email_codes WHERE user_id = ?').get(userId);
  db.prepare(`INSERT INTO email_codes (user_id, code_hash, expires_at, attempts, sent_at, sends) VALUES (?, ?, ?, 0, ?, ?)
              ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends`)
    .run(userId, sha256(`${userId}:${code}`), Date.now() + 30 * 60_000, Date.now(), (prev?.sends || 0) + 1);
  const en = lang === 'en';
  await mailer.send({
    to: email,
    subject: en ? `${code} is your Three Crowns code` : `${code} est ton code Three Crowns`,
    text: en
      ? `Welcome to Fire Emblem Three Crowns: Grand Conquests!\n\nYour confirmation code: ${code}\n\nEnter it in the game to confirm your email address. It is valid for 30 minutes.\nIf you did not create an account, ignore this message.`
      : `Bienvenue dans Fire Emblem Three Crowns : Grand Conquests !\n\nTon code de confirmation : ${code}\n\nSaisis-le dans le jeu pour confirmer ton adresse email. Il est valable 30 minutes.\nSi tu n'as pas créé de compte, ignore ce message.`,
  });
}

// Compteurs quotidiens pour régler l'économie : or gagné et dépensé (par source), actions, batailles, joueurs actifs.
db.exec(`
  CREATE TABLE IF NOT EXISTS metrics_daily (day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, key));
  CREATE TABLE IF NOT EXISTS metrics_active (day TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (day, user_id));
`);
const metricBump = db.prepare('INSERT INTO metrics_daily (day, key, value) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET value = value + excluded.value');
const metricActive = db.prepare('INSERT OR IGNORE INTO metrics_active (day, user_id) VALUES (?, ?)');
const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
function metric(key, n = 1) { if (n) { try { metricBump.run(dayKey(), key, n); } catch { /* un compteur manqué ne doit jamais gêner le jeu */ } } }
const seenToday = new Map(); // jour -> ensemble des joueurs déjà comptés
function markActive(userId) {
  const day = dayKey();
  if (!seenToday.has(day)) { seenToday.clear(); seenToday.set(day, new Set()); }
  const set = seenToday.get(day);
  if (set.has(userId)) return;
  set.add(userId);
  try { metricActive.run(day, userId); } catch { /* idem */ }
}

// Réglages du joueur (surchargeables dans config/game.json, clé "player").
const PLAYER = { startGold: 500, renownBaseXp: 100, renownGrowth: 1.1, ...(config.player || {}) };
const MISSIONS = Array.isArray(config.missions) ? config.missions : [];
// Classes : chaque classe appartient à un rang (classTiers), le premier rang étant celui des classes de base.
// Un rang fixe la renommée minimale et le prix en or pour y accéder ; un rang sans prix est verrouillé.
const TIERS = Array.isArray(config.classTiers) ? config.classTiers : [];
const BASE_TIER = TIERS[0]?.id;
// Avatars : `free` (libres, dans l'ordre d'affichage), `locked` ({ file, unlock: "mission" | "gold", price }) et `special`
// (missions spéciales qui débloquent un avatar). Un fichier du dossier assets/avatars qui n'est dans aucune liste n'est pas proposé.
const FREE_AVATARS = config.avatars?.free || [];
const LOCKED_AVATARS = new Map((config.avatars?.locked || []).map((a) => [a.file, a]));
const SPECIALS = config.avatars?.special || [];
// Compteurs durables suivis pour les missions spéciales (actions constatées par le serveur, jamais déclarées par l'app).
const SPECIAL_EVENTS = new Set(SPECIALS.map((m) => m.stat).filter(Boolean));
const classById = (id) => config.classes.find((c) => c.id === id);
const tierById = (id) => TIERS.find((t) => t.id === id);
const TUTORIAL = config.tutorial || { steps: [], rewards: { gold: 0, xp: 0 } };
const MISSION_EVENTS = new Set([...MISSIONS.filter((m) => m.condition?.type === 'event').map((m) => m.condition.event), ...TUTORIAL.steps.map((x) => x.event)]);

// Migration : ressources du joueur (or, et xp dont découle la renommée).
{
  const cols = db.prepare('PRAGMA table_info(characters)').all().map((c) => c.name);
  if (!cols.includes('gold')) db.exec(`ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT ${Number(PLAYER.startGold) || 0}`);
  if (!cols.includes('xp')) db.exec('ALTER TABLE characters ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
  // Lignée de classes (« arbre de classes ») : les classes traversées depuis la classe de base, en JSON.
  if (!cols.includes('class_path')) db.exec('ALTER TABLE characters ADD COLUMN class_path TEXT');
  {
    const fill = db.prepare('UPDATE characters SET class_path = ? WHERE user_id = ?');
    for (const r of db.prepare('SELECT user_id, class, class_path FROM characters').all()) {
      const p = fx.pathOf(r);
      if (r.class_path !== JSON.stringify(p)) fill.run(JSON.stringify(p), r.user_id);
    }
  }
  // Notifications traduisibles : on stocke un type et des paramètres, le texte est produit par l'app.
  const ncols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  if (!ncols.includes('type')) db.exec('ALTER TABLE notifications ADD COLUMN type TEXT');
  if (!ncols.includes('params')) db.exec('ALTER TABLE notifications ADD COLUMN params TEXT');
  // Langue choisie par le joueur (servira aussi aux futurs emails).
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('lang')) db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
  // Dernière mise à jour (patch) lue par le joueur ; vide = jamais lue.
  if (!ucols.includes('patch_seen')) db.exec('ALTER TABLE users ADD COLUMN patch_seen TEXT');
  // Adresse email confirmée (1 par défaut : les comptes créés avant la confirmation par email restent valides).
  if (!ucols.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  // Code de confirmation envoyé par email : haché, valable 30 minutes, 5 essais.
  db.exec(`CREATE TABLE IF NOT EXISTS email_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, sends INTEGER NOT NULL DEFAULT 1
  )`);
  // Journal des changements de classe.
  db.exec(`CREATE TABLE IF NOT EXISTS class_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_class TEXT NOT NULL,
    to_class   TEXT NOT NULL,
    cost       INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS login_events_email ON login_events (email, id)');
  // Avatars débloqués par un joueur (achat ou récompense de mission).
  db.exec(`CREATE TABLE IF NOT EXISTS unlocked_avatars (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar     TEXT NOT NULL,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, avatar)
  )`);
  // Version 1 du schéma : les quatre classes d'origine deviennent les classes de base.
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    const old = { guerrier: 'fighter', eclaireur: 'myrmidon', mage: 'monk', batisseur: 'soldier' };
    const upd = db.prepare('UPDATE characters SET class = ? WHERE class = ?');
    // « mage » existe aussi dans le nouvel arbre : on convertit en une passe, via des noms temporaires.
    for (const k of Object.keys(old)) upd.run(`old:${k}`, k);
    for (const [k, v] of Object.entries(old)) upd.run(v, `old:${k}`);
    db.exec('PRAGMA user_version = 1');
  }
  // Version 2 : les notifications créées avant le multilingue étaient du texte français figé.
  // On les convertit en type + paramètres pour qu'elles suivent la langue du joueur.
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    const upd = db.prepare('UPDATE notifications SET type = ?, params = ? WHERE id = ?');
    const factionOf = db.prepare('SELECT faction FROM characters WHERE user_id = ?');
    const frTitle = (m) => (m.title && typeof m.title === 'object' ? m.title.fr : m.title);
    for (const n of db.prepare('SELECT id, user_id, title, body FROM notifications WHERE type IS NULL').all()) {
      let m;
      let type = null;
      let params = null;
      if (n.title === 'Mission accomplie' && (m = /^« (.+) »/.exec(n.body))) {
        const mission = MISSIONS.find((x) => frTitle(x) === m[1]);
        if (mission) { type = 'mission_done'; params = { mission: mission.id }; }
      } else if ((m = /^Renommée (\d+)$/.exec(n.title))) {
        type = 'renown'; params = { level: Number(m[1]) };
      } else if ((m = /^Bienvenue, (.+) !$/.exec(n.title))) {
        type = 'welcome'; params = { pseudo: m[1], faction: factionOf.get(n.user_id)?.faction };
      }
      // Un texte non reconnu est laissé tel quel : il reste affiché en français.
      if (type) upd.run(type, JSON.stringify(params), n.id);
    }
    db.exec('PRAGMA user_version = 2');
  }
  // Les personnages créés avant les missions comptent aussi comme « créés ».
  db.exec("INSERT OR IGNORE INTO player_events (user_id, event, count) SELECT user_id, 'character_created', 1 FROM characters");
}

const now = () => new Date().toISOString();

// Chaque territoire démarre sous la faction indiquée dans map.json (champ "faction", null = neutre).
const startFaction = (t) => (config.factions.some((f) => f.id === t.faction) ? t.faction : null);
const seedTerritory = db.prepare('INSERT OR IGNORE INTO territories (id, faction, updated_at) VALUES (?, ?, ?)');
for (const t of config.map.territories) seedTerritory.run(t.id, startFaction(t), now());
// Version 3 : les territoires créés avant la répartition de départ étaient tous neutres ; on leur applique.
if (db.prepare('PRAGMA user_version').get().user_version < 3) {
  const give = db.prepare('UPDATE territories SET faction = ?, updated_at = ? WHERE id = ? AND faction IS NULL');
  for (const t of config.map.territories) if (startFaction(t)) give.run(startFaction(t), now(), t.id);
  db.exec('PRAGMA user_version = 3');
}
// Les territoires qui ne figurent plus sur la carte sont retirés de la base.
{
  const known = new Set(config.map.territories.map((t) => t.id));
  const drop = db.prepare('DELETE FROM territories WHERE id = ?');
  for (const row of db.prepare('SELECT id FROM territories').all()) if (!known.has(row.id)) drop.run(row.id);
}
// Deux territoires sont voisins si l'un des deux cite l'autre dans map.json.
const NEIGHBORS = new Map(config.map.territories.map((t) => [t.id, new Set(t.neighbors || [])]));
for (const t of config.map.territories) for (const n of t.neighbors || []) NEIGHBORS.get(n)?.add(t.id);
const areNeighbors = (a, b) => !!NEIGHBORS.get(a)?.has(b);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, password_salt, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
  sessionUser: db.prepare(`SELECT u.id, u.email, u.lang, u.created_at, u.email_verified FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  logEvent: db.prepare('INSERT INTO login_events (user_id, email, event, success, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  character: db.prepare('SELECT pseudo, birthday, class, class_path, avatar, faction, gold, xp, created_at FROM characters WHERE user_id = ?'),
  pseudoTaken: db.prepare('SELECT 1 FROM characters WHERE pseudo = ?'),
  insertCharacter: db.prepare('INSERT INTO characters (user_id, pseudo, birthday, class, class_path, avatar, faction, gold, xp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'),
  players: db.prepare('SELECT pseudo, birthday, class, avatar, faction, xp FROM characters ORDER BY pseudo COLLATE NOCASE'),
  territories: db.prepare('SELECT id, faction FROM territories'),
  addResources: db.prepare('UPDATE characters SET gold = gold + ?, xp = xp + ? WHERE user_id = ?'),
  insertNotif: db.prepare("INSERT INTO notifications (user_id, title, body, type, params, created_at) VALUES (?, ?, '', ?, ?, ?)"),
  notifs: db.prepare('SELECT id, title, body, type, params, created_at, read_at IS NOT NULL AS read FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
  setLang: db.prepare('UPDATE users SET lang = ? WHERE id = ?'),
  patchSeen: db.prepare('SELECT patch_seen FROM users WHERE id = ?'),
  setPatchSeen: db.prepare('UPDATE users SET patch_seen = ? WHERE id = ?'),
  // Échecs de connexion récents sur un email, depuis sa dernière connexion réussie.
  recentFails: db.prepare(`SELECT count(*) AS n FROM login_events
    WHERE email = ? AND event = 'login' AND success = 0 AND created_at > ?
      AND id > COALESCE((SELECT max(id) FROM login_events WHERE email = ? AND event = 'login' AND success = 1), 0)`),
  ownedAvatars: db.prepare('SELECT avatar FROM unlocked_avatars WHERE user_id = ?'),
  unlockAvatar: db.prepare('INSERT OR IGNORE INTO unlocked_avatars (user_id, avatar, source, created_at) VALUES (?, ?, ?, ?)'),
  setAvatar: db.prepare('UPDATE characters SET avatar = ? WHERE user_id = ?'),
  buyAvatar: db.prepare('UPDATE characters SET avatar = ?, gold = gold - ? WHERE user_id = ? AND gold >= ?'),
  changeClass: db.prepare('UPDATE characters SET class = ?, class_path = ?, gold = gold - ? WHERE user_id = ? AND gold >= ?'),
  logClass: db.prepare('INSERT INTO class_changes (user_id, from_class, to_class, cost, created_at) VALUES (?, ?, ?, ?, ?)'),
  unread: db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
  markRead: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
  clearNotifs: db.prepare('DELETE FROM notifications WHERE user_id = ?'),
  missionRows: db.prepare('SELECT mission_id, completed_at, claimed_at FROM mission_progress WHERE user_id = ?'),
  completeMission: db.prepare('INSERT OR IGNORE INTO mission_progress (user_id, mission_id, completed_at) VALUES (?, ?, ?)'),
  claimMission: db.prepare('UPDATE mission_progress SET claimed_at = ? WHERE user_id = ? AND mission_id = ? AND claimed_at IS NULL'),
  events: db.prepare('SELECT event, count FROM player_events WHERE user_id = ?'),
  bumpEvent: db.prepare(`INSERT INTO player_events (user_id, event, count) VALUES (?, ?, 1)
                         ON CONFLICT (user_id, event) DO UPDATE SET count = count + 1`),
  addEvent: db.prepare(`INSERT INTO player_events (user_id, event, count) VALUES (?, ?, ?)
                        ON CONFLICT (user_id, event) DO UPDATE SET count = count + excluded.count`),
  setEvent: db.prepare(`INSERT INTO player_events (user_id, event, count) VALUES (?, ?, ?)
                        ON CONFLICT (user_id, event) DO UPDATE SET count = excluded.count`),
  refund: db.prepare('UPDATE characters SET gold = gold + ? WHERE user_id = ?'),
  allUnlocked: db.prepare('SELECT user_id, avatar, source FROM unlocked_avatars'),
  dropUnlocked: db.prepare('DELETE FROM unlocked_avatars WHERE user_id = ? AND avatar = ?'),
  allChars: db.prepare('SELECT user_id, avatar FROM characters'),
};
q.purgeSessions.run(now());

// Migration : les anciens avatars provisoires (avatar-0N.svg, shop-0N.svg, mission-0N.svg) n'existent plus.
// Les joueurs qui les utilisaient reçoivent un avatar libre, et les achats sont remboursés au prix payé à l'époque.
{
  const known = new Set([...FREE_AVATARS, ...LOCKED_AVATARS.keys()]);
  const OLD_PRICES = { 'shop-01.svg': 600, 'shop-02.svg': 600, 'shop-03.svg': 600, 'shop-04.svg': 900, 'shop-05.svg': 900, 'shop-06.svg': 1500 };
  if (FREE_AVATARS.length && known.size) {
    for (const r of q.allUnlocked.all()) {
      if (known.has(r.avatar)) continue;
      if (r.source === 'gold' && OLD_PRICES[r.avatar]) q.refund.run(OLD_PRICES[r.avatar], r.user_id);
      q.dropUnlocked.run(r.user_id, r.avatar);
    }
    for (const r of q.allChars.all()) {
      if (known.has(r.avatar)) continue;
      const n = Number((/\d+/.exec(r.avatar) || [1])[0]);
      q.setAvatar.run(FREE_AVATARS[(Math.max(1, n) - 1) % FREE_AVATARS.length], r.user_id);
    }
  }
}

// ---------------------------------------------------------------- Utilitaires
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

function verifyPassword(password, salt, expectedHex) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Sécurité
// TRUST_PROXY : nombre de proxys de confiance placés devant le serveur (0 = accès direct).
// Derrière un hébergeur ou un reverse proxy, mettre 1 pour lire la vraie IP du joueur dans X-Forwarded-For.
// À 0, cet en-tête est ignoré, car n'importe quel client peut l'inventer.
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
// ALLOWED_ORIGINS : origines supplémentaires autorisées à appeler l'API (séparées par des virgules).
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// Requêtes autorisées par IP : toutes routes et API par minute, connexion et inscription par 10 minutes.
// static : fichiers (une page en charge des dizaines : avatars, classes, carte), compté à part pour ne pas bloquer le jeu.
const LIMITS = { all: 600, api: 120, auth: 10, static: 3000 };
// Blocage d'un compte après trop d'échecs de connexion.
const LOCK_FAILS = 5;
const LOCK_MINUTES = 15;

function clientIp(req) {
  if (TRUST_PROXY > 0) {
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = list[list.length - TRUST_PROXY];
    if (ip) return ip.slice(0, 64);
  }
  return req.socket.remoteAddress || '?';
}

const isHttps = (req) => !!req.socket.encrypted || (TRUST_PROXY > 0 && req.headers['x-forwarded-proto'] === 'https');

// La page ne peut charger scripts, images et données que depuis ce serveur : un script injecté
// ou hébergé ailleurs ne s'exécute pas. Elle ne peut pas non plus être affichée dans une iframe.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Refuse les requêtes qui modifient des données si elles viennent d'un autre site.
function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { throw new HttpError(403, 'bad_origin'); }
    const own = String((TRUST_PROXY > 0 && req.headers['x-forwarded-host']) || req.headers.host || '').toLowerCase();
    if (host !== own && !ALLOWED_ORIGINS.has(origin.toLowerCase())) throw new HttpError(403, 'bad_origin');
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'bad_origin');
}

function clientInfo(req) {
  return {
    ip: clientIp(req),
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
  const user = q.sessionUser.get(sha256(token), now()) || null;
  if (user) markActive(user.id);
  return user;
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

// Limite de débit par IP : au plus `max` requêtes par fenêtre de `windowMs`, par famille de routes.
const buckets = new Map();
function limit(req, name, max, windowMs) {
  const key = `${name}:${clientIp(req)}`;
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (b.count > max) {
    const e = new HttpError(429, 'rate_limited');
    e.retryAfter = Math.ceil((b.reset - t) / 1000);
    throw e;
  }
}
// Connexion et inscription : limite plus stricte contre la force brute.
const rateLimit = (req) => limit(req, 'auth', LIMITS.auth, 600_000);
setInterval(() => {
  const t = Date.now();
  for (const [key, b] of buckets) if (b.reset <= t) buckets.delete(key);
}, 60_000).unref();
setInterval(() => q.purgeSessions.run(now()), 600_000).unref();

// Avatars proposés : les libres, puis les verrouillés, dans l'ordre de game.json, à condition que le fichier existe.
function listAvatars() {
  let files;
  try { files = new Set(fs.readdirSync(AVATAR_DIR).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))); } catch { return []; }
  return [...FREE_AVATARS, ...LOCKED_AVATARS.keys()].filter((f) => files.has(f));
}

// Avatars vus par un joueur : libres, achetables ou à gagner en mission, avec ceux qu'il possède.
function avatarList(userId) {
  const owned = new Set(userId ? q.ownedAvatars.all(userId).map((r) => r.avatar) : []);
  return listAvatars().map((file) => {
    const l = LOCKED_AVATARS.get(file);
    if (!l) return { file, unlock: 'free', owned: true };
    return { file, unlock: l.unlock === 'gold' ? 'gold' : 'mission', price: l.unlock === 'gold' ? l.price : undefined, owned: owned.has(file) };
  });
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
  if (pushHook) { try { pushHook(userId, type, params); } catch { /* le push est accessoire */ } }
}
let pushHook = null; // notifications push (voir push.js), branchées une fois le moteur démarré

function parseParams(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

// Multiplicateurs d'or et d'expérience du joueur (effets de classe, téléportation de l'Évêque noir…),
// fournis par le moteur de campagne dès qu'il est démarré.
let rewardMods = () => ({ gold: 1, xp: 1 });
let exileMultOf = () => 1;

// Donne de l'or et/ou de l'xp à un joueur, et le prévient s'il gagne un niveau de renommée.
// Toutes les sources de gains passent ici : les bonus et malus de classe s'appliquent donc à toutes.
function grant(userId, gold, xp, source = 'other') {
  const ch = q.character.get(userId);
  if (!ch) return;
  const mods = rewardMods(userId, source);
  const earned = gold > 0 || xp > 0;
  gold = Math.round(gold * mods.gold) + (earned ? mods.plusGold || 0 : 0); // Overdrive+ : bonus fixe à chaque gain d'action
  xp = Math.round(xp * mods.xp) + (earned ? mods.plusXp || 0 : 0);
  if (gold > 0) { metric('gold_in', gold); metric(`gold_in:${source}`, gold); }
  if (xp > 0) { metric('xp_in', xp); metric(`xp_in:${source}`, xp); }
  const before = renown(ch.xp).level;
  q.addResources.run(gold, xp, userId);
  const after = renown(ch.xp + xp).level;
  // Prime de renommée : levelUpGold × nouveau niveau, pour chaque niveau franchi (réduite pour un exilé, comme tous ses gains).
  const per = Number(process.env.LEVEL_UP_GOLD ?? config.player?.levelUpGold) || 0; // LEVEL_UP_GOLD : tests
  for (let l = before + 1; l <= after; l += 1) {
    const bonus = per ? Math.round(per * l * exileMultOf(userId)) : 0;
    if (bonus > 0) { q.addResources.run(bonus, 0, userId); metric('gold_in', bonus); metric('gold_in:renown', bonus); }
    notify(userId, bonus > 0 ? 'renown_gold' : 'renown', { level: l, ...(bonus > 0 ? { gold: bonus } : {}) });
  }
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
      rewards: { gold: m.rewards?.gold || 0, xp: m.rewards?.xp || 0, avatar: m.rewards?.avatar || null },
      status: row ? (row.claimed_at ? 'claimed' : 'done') : 'active',
      current: row ? target : Math.min(current, target),
      target,
    };
  });
}

// Compteurs durables du joueur (exploits, actions comptées pour les missions et les conditions de classe).
const statOf = (userId, event) => q.events.all(userId).find((r) => r.event === event)?.count || 0;

// Dernière mise à jour publiée (la première de la liste « patches » de game.json).
const LATEST_PATCH = (config.patches || [])[0]?.id || null;

// Tutoriel de la première heure : chaque étape est faite quand l'événement correspondant a été constaté au moins une fois.
function tutorialState(userId) {
  if (!TUTORIAL.steps.length) return null;
  const counts = new Map(q.events.all(userId).map((r) => [r.event, r.count]));
  if (counts.get('tutorial_done')) return null;
  const steps = TUTORIAL.steps.map((x) => ({ id: x.id, title: x.title, description: x.description, done: (counts.get(x.event) || 0) >= (x.count || 1) }));
  return { steps, complete: steps.every((x) => x.done), rewards: TUTORIAL.rewards };
}
function mePayload(user) {
  // L'état de campagne d'abord : il peut verser de l'or (Hilda) avant qu'on lise le personnage.
  const player = q.character.get(user.id) ? campaign.playerPayload(user.id) : null;
  const ch = q.character.get(user.id);
  const claimable = missionState(user.id).filter((m) => m.status === 'done').length + (ch ? daily.claimable(user.id) : 0) + (ch ? campaign.missionsClaimable(user.id) : 0);
  return {
    user: { id: user.id, email: user.email, lang: user.lang || null, verified: user.email_verified !== 0 },
    // `path` : lignée de classes du joueur (ses effets de classe se cumulent le long de ce chemin).
    character: ch ? (({ class_path: _p, ...rest }) => ({ ...rest, path: fx.pathOf(ch), renown: renown(ch.xp) }))(ch) : null,
    unread: q.unread.get(user.id).n,
    claimable,
    // Mise à jour la plus récente et celle que le joueur a lue en dernier (différentes : pastille sur « Mises à jour »).
    patch: { latest: LATEST_PATCH, seen: q.patchSeen.get(user.id)?.patch_seen || null },
    // Position, actions disponibles et état du joueur dans la campagne en cours.
    player,
    // Premier pas dans le jeu : étapes à accomplir, et si la récompense est à récupérer (ou déjà prise / masquée).
    tutorial: ch ? tutorialState(user.id) : null,
    // Résultat de la dernière campagne terminée, tant que le joueur ne l'a pas lu (fenêtre de fin de campagne).
    result: ch ? campaign.resultFor(user.id) : null,
    // Distinctions gagnées (titres), avec leur nombre.
    distinctions: ch ? campaign.distinctionsOf(user.id) : [],
    // Compteurs durables (par exemple les attaques des Serpents repoussées), pour les conditions de classe.
    stats: ch ? Object.fromEntries(q.events.all(user.id).map((r) => [r.event, r.count])) : {},
  };
}

// Tableau des compteurs quotidiens : une ligne par jour, avec les ratios utiles pour équilibrer l'économie.
function adminMetrics(req) {
  const days = Math.min(90, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 14));
  const since = dayKey(Date.now() - (days - 1) * 86_400_000);
  const rows = db.prepare('SELECT day, key, value FROM metrics_daily WHERE day >= ? ORDER BY day').all(since);
  const active = new Map(db.prepare('SELECT day, count(*) AS n FROM metrics_active WHERE day >= ? GROUP BY day').all(since).map((r) => [r.day, r.n]));
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, {}); byDay.get(r.day)[r.key] = r.value; }
  for (const d of active.keys()) if (!byDay.has(d)) byDay.set(d, {});
  const out = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, m]) => {
    const n = active.get(day) || 0;
    const won = (m.battles_attack_won || 0);
    const lost = (m.battles_defense_won || 0);
    return {
      day, activePlayers: n, ...m,
      goldNet: (m.gold_in || 0) - Object.entries(m).filter(([k]) => k.startsWith('gold_out:')).reduce((a, [, v]) => a + v, 0),
      goldInPerPlayer: n ? Math.round((m.gold_in || 0) / n) : null,
      attackWinRate: won + lost ? Math.round((won / (won + lost)) * 100) : null,
    };
  });
  return { days: out, players: db.prepare('SELECT count(*) AS n FROM characters').get().n, bugs: db.prepare('SELECT id, pseudo, message, created_at, emailed FROM bug_reports ORDER BY id DESC LIMIT 50').all() };
}
// Moteur de campagne : actions, déplacements, batailles, mini-boss, fin de campagne (voir campaign.js).
// Missions du jour et série de jours consécutifs (voir daily.js).
const daily = require('./daily')({ db, config, grant, HttpError, fallenState: (userId) => campaign.fallenState(userId), giveActions: (userId, n) => campaign.rewardActions(userId, n) });
// Débloque un avatar verrouillé (distinction, mission…) et prévient le joueur.
const unlockAvatar = (userId, file, source) => {
  if (LOCKED_AVATARS.has(file) && q.unlockAvatar.run(userId, file, source, now()).changes === 1) notify(userId, 'avatar_unlocked', { avatar: file });
};
// Compteur durable : ajoute n, puis vérifie les missions spéciales.
function statAdd(userId, key, n = 1) {
  if (n > 0) q.addEvent.run(userId, key, n);
  specialState(userId);
}
// Missions spéciales : chacune débloque un avatar quand son compteur atteint l'objectif (déblocage automatique).
function specialState(userId) {
  if (!SPECIALS.length || !q.character.get(userId)) return [];
  const events = new Map(q.events.all(userId).map((r) => [r.event, r.count]));
  const owned = new Set(q.ownedAvatars.all(userId).map((r) => r.avatar));
  return SPECIALS.map((m) => {
    const target = m.count || 1;
    let current = m.stat ? events.get(m.stat) || 0 : 0;
    if (m.distinction) current = (campaign.distinctionsOf(userId).find((d) => d.id === m.distinction)?.count || 0) > 0 ? 1 : 0;
    const done = owned.has(m.avatar) || current >= target;
    if (done && !owned.has(m.avatar)) unlockAvatar(userId, m.avatar, `special:${m.id}`);
    return { id: m.id, avatar: m.avatar, title: m.title, description: m.description, current: Math.min(current, target), target, done };
  });
}
const campaign = require('./campaign')({
  db, config, notify, grant, renown, HttpError, currentUser, readJson, send, startFaction, NEIGHBORS, mePayload,
  unlockAvatar, freezeStreaks: (userIds) => daily.freeze(userIds),
  countStat: (userId, key, n = 1) => statAdd(userId, key, n),
  setStat: (userId, key, value) => { q.setEvent.run(userId, key, value); specialState(userId); },
  fx, statOf: (userId, event) => statOf(userId, event), metric,
  // Actions de jeu constatées par le serveur : elles font avancer les missions du jour et les missions classiques.
  onEvent: (userId, event) => {
    daily.bump(userId, event);
    if (MISSION_EVENTS.has(event)) q.bumpEvent.run(userId, event);
    if (SPECIAL_EVENTS.has(event)) statAdd(userId, event);
  },
});
// À partir de maintenant, les gains d'or et d'expérience tiennent compte des effets de classe.
rewardMods = campaign.rewardMods;
exileMultOf = campaign.exileMult;
// Notifications push (voir push.js) : chaque notification du jeu qui compte peut aussi réveiller le téléphone.
const push = require('./push')({
  db, config, dataDir: DATA_DIR, publicDir: PUBLIC_DIR, currentUser, readJson, send, HttpError,
  playerState: (userId) => {
    const pl = campaign.playerPayload(userId);
    return pl ? { status: pl.status, actions: pl.actions, maxActions: pl.maxActions, open: campaign.phaseNow() === 'open' } : null;
  },
});
pushHook = push.onNotify;
// Le monde avance tout seul : batailles arrivées à terme, replis expirés, mini-boss.
setInterval(() => { try { campaign.tick(); } catch (e) { console.error(e); } }, Math.min(15_000, campaign.TURN_MS / 2)).unref();

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
    // Un nouveau joueur n'a pas à être prévenu des changements passés.
    if (LATEST_PATCH) q.setPatchSeen.run(LATEST_PATCH, userId);
    q.logEvent.run(userId, mail, 'register', 1, ip, ua, now());
    // Confirmation par email quand l'envoi est configuré (sinon le compte est validé d'office).
    let verified = 1;
    if (VERIFY_EMAILS()) {
      verified = 0;
      db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(userId);
      sendCode(userId, mail, (req.headers['accept-language'] || '').slice(0, 2)).catch((e) => console.error('mail', e.message));
    }
    createSession(req, res, userId);
    send(res, 201, mePayload({ id: userId, email: mail, email_verified: verified }));
  },

  // Confirmer son adresse avec le code reçu par email.
  'POST /api/verify': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { code } = await readJson(req);
    if (user.email_verified) { send(res, 200, mePayload(user)); return; }
    const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(user.id);
    if (!row || row.expires_at < Date.now()) throw new HttpError(409, 'code_expired');
    if (row.attempts >= 5) throw new HttpError(429, 'code_attempts');
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
    const given = String(code || '').replace(/\D/g, '');
    if (!given || !crypto.timingSafeEqual(Buffer.from(sha256(`${user.id}:${given}`)), Buffer.from(row.code_hash))) throw new HttpError(400, 'code_invalid');
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(user.id);
    send(res, 200, mePayload({ ...user, email_verified: 1 }));
  },

  // Renvoyer un code : une minute d'attente entre deux envois, 5 envois au plus par code en cours.
  'POST /api/verify/resend': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    if (user.email_verified) { send(res, 200, mePayload(user)); return; }
    const row = db.prepare('SELECT sent_at, sends FROM email_codes WHERE user_id = ?').get(user.id);
    if (row && Date.now() - row.sent_at < 60_000) throw new HttpError(429, 'code_wait');
    if (row && row.sends >= 5) throw new HttpError(429, 'code_sends');
    if (!mailer.configured()) throw new HttpError(503, 'mail_unavailable');
    await sendCode(user.id, user.email, user.lang);
    send(res, 200, mePayload(user));
  },

  'POST /api/login': async (req, res) => {
    rateLimit(req);
    const { email, password } = await readJson(req);
    const { ip, ua } = clientInfo(req);
    const mail = String(email || '').trim().toLowerCase().slice(0, 254);
    // Compte bloqué : trop d'échecs récents sur cet email, quelle que soit l'IP d'où ils viennent.
    // Pendant le blocage, même le bon mot de passe est refusé et rien n'est ajouté au journal.
    const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
    if (q.recentFails.get(mail, since, mail).n >= LOCK_FAILS) {
      const e = new HttpError(429, 'account_locked');
      e.retryAfter = LOCK_MINUTES * 60;
      throw e;
    }
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

  'GET /api/avatars': async (req, res) => send(res, 200, { avatars: avatarList(currentUser(req)?.id) }),

  // Utilise un avatar libre ou déjà débloqué.
  'POST /api/avatar': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { avatar } = await readJson(req);
    if (!q.character.get(user.id)) throw new HttpError(409, 'no_character');
    const a = avatarList(user.id).find((x) => x.file === avatar);
    if (!a) throw new HttpError(400, 'invalid_avatar');
    if (!a.owned) throw new HttpError(409, 'avatar_locked');
    q.setAvatar.run(a.file, user.id);
    send(res, 200, { ...mePayload(user), avatars: avatarList(user.id) });
  },

  // Achète un avatar vendu contre de l'or, et l'utilise aussitôt.
  'POST /api/avatar/buy': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { avatar } = await readJson(req);
    if (!q.character.get(user.id)) throw new HttpError(409, 'no_character');
    const a = avatarList(user.id).find((x) => x.file === avatar);
    if (!a) throw new HttpError(400, 'invalid_avatar');
    if (a.unlock !== 'gold' || a.owned || !Number.isInteger(a.price) || a.price < 0) throw new HttpError(409, 'avatar_locked');
    // L'or n'est débité que s'il y en a assez (vérifié dans la même requête).
    if (q.buyAvatar.run(a.file, a.price, user.id, a.price).changes !== 1) throw new HttpError(409, 'not_enough_gold');
    q.unlockAvatar.run(user.id, a.file, 'gold', now());
    statAdd(user.id, 'gold_spent', a.price);
    metric('gold_out:avatar', a.price);
    send(res, 200, { ...mePayload(user), avatars: avatarList(user.id) });
  },

  'POST /api/character': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    if (user.email_verified === 0) throw new HttpError(403, 'email_unverified');
    if (q.character.get(user.id)) throw new HttpError(409, 'character_exists');
    const { pseudo, birthday, class: klass, avatar, faction } = await readJson(req);
    if (typeof pseudo !== 'string' || !PSEUDO_RE.test(pseudo)) throw new HttpError(400, 'invalid_pseudo');
    if (!validBirthday(birthday)) throw new HttpError(400, 'invalid_birthday');
    if (classById(klass)?.tier !== BASE_TIER) throw new HttpError(400, 'invalid_class');
    if (!listAvatars().includes(avatar) || LOCKED_AVATARS.has(avatar)) throw new HttpError(400, 'invalid_avatar');
    // Une faction non jouable ("npc": true) ne peut pas être rejointe.
    if (!config.factions.some((f) => f.id === faction && !f.npc)) throw new HttpError(400, 'invalid_faction');
    if (q.pseudoTaken.get(pseudo)) throw new HttpError(409, 'pseudo_taken');
    q.insertCharacter.run(user.id, pseudo, birthday, klass, JSON.stringify([klass]), avatar, faction, Number(PLAYER.startGold) || 0, now());
    q.bumpEvent.run(user.id, 'character_created');
    notify(user.id, 'welcome', { pseudo, faction });
    campaign.ensurePlayer(user.id);
    send(res, 201, mePayload(user));
  },

  'GET /api/players': async (req, res) => {
    if (!currentUser(req)) throw new HttpError(401, 'unauthorized');
    send(res, 200, { players: q.players.all().map(({ xp, ...p }) => ({ ...p, renown: renown(xp).level })) });
  },

  'GET /api/notifications': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    // Offrandes reçues d'un joueur : état du bouton « Dire merci » (ouvert 24 h, une fois).
    const gifts = campaign.giftStates(user.id);
    send(res, 200, { notifications: q.notifs.all(user.id).map((n) => {
      const params = parseParams(n.params);
      if (n.type === 'player_gift') params.thanks = gifts[params.gift] || 'closed';
      return { ...n, params, read: !!n.read };
    }) });
  },

  // Changement de classe.
  // - Vers une classe de base : possible depuis n'importe quelle classe.
  // - Vers une autre classe : la classe actuelle doit faire partie des prérequis de la classe visée.
  // Dans les deux cas, la renommée minimale et le prix sont ceux du rang de la classe visée.
  'POST /api/class': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { class: target } = await readJson(req);
    const ch = q.character.get(user.id);
    if (!ch) throw new HttpError(409, 'no_character');
    const cls = classById(target);
    const tier = cls && tierById(cls.tier);
    if (!cls || cls.npc || !tier || !Number.isInteger(tier.cost) || !Number.isInteger(tier.renown)) throw new HttpError(400, 'invalid_class');
    if (cls.id === ch.class) throw new HttpError(409, 'class_same');
    if (cls.tier !== BASE_TIER && !(cls.requires || []).includes(ch.class)) throw new HttpError(409, 'class_path');
    if (renown(ch.xp).level < tier.renown) throw new HttpError(409, 'class_renown');
    // Certaines classes demandent un exploit en plus (clé "unlock" : event et count), compté par le serveur.
    if (cls.unlock && statOf(user.id, cls.unlock.event) < cls.unlock.count) throw new HttpError(409, 'class_unlock');
    // L'or n'est débité que s'il y en a assez (vérifié dans la même requête).
    // La lignée garde les classes traversées : leurs effets restent acquis (une classe de base la remet à zéro).
    if (q.changeClass.run(cls.id, JSON.stringify(fx.nextPath(ch, cls.id)), tier.cost, user.id, tier.cost).changes !== 1) throw new HttpError(409, 'class_gold');
    statAdd(user.id, 'gold_spent', tier.cost);
    metric('gold_out:class', tier.cost);
    q.logClass.run(user.id, ch.class, cls.id, tier.cost, now());
    notify(user.id, 'class_changed', { class: cls.id });
    send(res, 200, mePayload(user));
  },

  // Mémorise la langue choisie par le joueur.
  // Le joueur a lu les notes de la mise à jour la plus récente.
  'POST /api/patch/seen': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    if (LATEST_PATCH) q.setPatchSeen.run(LATEST_PATCH, user.id);
    send(res, 200, mePayload(user));
  },

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

  // Efface toutes les notifications du joueur.
  'POST /api/notifications/clear': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    q.clearNotifs.run(user.id);
    send(res, 200, mePayload(user));
  },

  // Signaler un bug : 500 caractères au plus, 3 signalements par heure et par joueur.
  'POST /api/bug': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { message } = await readJson(req);
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text || text.length > 500) throw new HttpError(400, 'bug_invalid');
    const since = new Date(Date.now() - 3_600_000).toISOString();
    if (db.prepare('SELECT count(*) AS n FROM bug_reports WHERE user_id = ? AND created_at >= ?').get(user.id, since).n >= 3) throw new HttpError(429, 'bug_limit');
    const ch = q.character.get(user.id);
    const id = Number(db.prepare('INSERT INTO bug_reports (user_id, pseudo, message, created_at) VALUES (?, ?, ?, ?)').run(user.id, ch?.pseudo || null, text, now()).lastInsertRowid);
    const to = process.env.BUG_REPORT_TO;
    if (to && mailer.configured()) {
      const body = `Signalement de bug n° ${id}\nJoueur : ${ch?.pseudo || '(sans personnage)'}${ch ? ` (${ch.faction})` : ''}\nDate : ${now()}\nVersion : ${LATEST_PATCH || '?'}\n\n${text}`;
      mailer.send({ to, subject: `[Three Crowns] Bug signalé par ${ch?.pseudo || 'un joueur'}`, text: body })
        .then(() => db.prepare('UPDATE bug_reports SET emailed = 1 WHERE id = ?').run(id))
        .catch((e) => console.error('mail', e.message));
    }
    send(res, 200, { ok: true });
  },

  // Tutoriel : récupérer la récompense une fois toutes les étapes faites, ou le masquer.
  'POST /api/tutorial/claim': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    const st = q.character.get(user.id) ? tutorialState(user.id) : null;
    if (!st || !st.complete) throw new HttpError(409, 'reward_unavailable');
    q.bumpEvent.run(user.id, 'tutorial_done');
    grant(user.id, TUTORIAL.rewards.gold || 0, TUTORIAL.rewards.xp || 0, 'tutorial');
    send(res, 200, mePayload(user));
  },
  'POST /api/tutorial/dismiss': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    await readJson(req);
    if (q.character.get(user.id)) q.bumpEvent.run(user.id, 'tutorial_done');
    send(res, 200, mePayload(user));
  },

  // Suivi économique (réservé à l'administrateur : en-tête x-admin-token égal à la variable ADMIN_TOKEN).
  'GET /api/admin/metrics': async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || String(req.headers['x-admin-token'] || '') !== token) throw new HttpError(404, 'not_found');
    send(res, 200, adminMetrics(req));
  },

  'GET /api/missions': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    send(res, 200, { missions: missionState(user.id), daily: daily.state(user.id), campaignMissions: campaign.missionState(user.id), specials: specialState(user.id) });
  },

  'POST /api/missions/daily/claim': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { id } = await readJson(req);
    if (!q.character.get(user.id)) throw new HttpError(409, 'no_character');
    const state = daily.claim(user.id, id);
    send(res, 200, { ...mePayload(user), missions: missionState(user.id), daily: state, campaignMissions: campaign.missionState(user.id), specials: specialState(user.id) });
  },

  // Missions de campagne : remises à zéro à chaque campagne (voir campaign.js).
  'POST /api/missions/campaign/claim': async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const { id } = await readJson(req);
    if (!q.character.get(user.id)) throw new HttpError(409, 'no_character');
    const list = campaign.claimMission(user.id, id);
    send(res, 200, { ...mePayload(user), missions: missionState(user.id), daily: daily.state(user.id), campaignMissions: list, specials: specialState(user.id) });
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
    grant(user.id, mission.rewards?.gold || 0, mission.rewards?.xp || 0, 'mission');
    // Une mission peut aussi débloquer un avatar (rewards.avatar).
    const prize = mission.rewards?.avatar;
    if (prize && LOCKED_AVATARS.has(prize) && q.unlockAvatar.run(user.id, prize, `mission:${mission.id}`, now()).changes === 1) {
      notify(user.id, 'avatar_unlocked', { avatar: prize });
    }
    const me = mePayload(user); // réévalue les missions (ex. palier de renommée atteint)
    send(res, 200, { ...me, missions: missionState(user.id), daily: daily.state(user.id), campaignMissions: campaign.missionState(user.id), specials: specialState(user.id) });
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
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    // Les contours sont déjà dans map.json : on ne renvoie ici que l'état du jeu (voir campaign.js).
    campaign.tick();
    send(res, 200, campaign.mapPayload(user.id));
  },

  // POST /api/move, /api/act et /api/retreat : actions de campagne.
  ...campaign.routes,
  ...push.routes,
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
  setSecurityHeaders(req, res);
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); return res.end(); }
  try {
    if (!pathname.startsWith('/api/')) {
      limit(req, 'static', LIMITS.static, 60_000);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    limit(req, 'all', LIMITS.all, 60_000);
    limit(req, 'api', LIMITS.api, 60_000);
    checkOrigin(req);
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) throw new HttpError(404, 'not_found');
    await handler(req, res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return;
    if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'server_error' });
  }
});

// Coupe les connexions qui traînent (requêtes envoyées au compte-gouttes).
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

server.listen(PORT, () => console.log(`Three Crowns : http://localhost:${PORT}`));
