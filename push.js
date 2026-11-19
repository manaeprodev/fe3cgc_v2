'use strict';
// Notifications push (Web Push) sans dépendance : clés VAPID, chiffrement aes128gcm (RFC 8291), envoi, préférences et limites.
// Peu de notifications : chaque type a un délai minimum entre deux envois, un plafond quotidien s'applique, et rien ne part la nuit.
// Réglages dans config/game.json, clé « push ».

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

module.exports = function createPush(ctx) {
  const { db, config, dataDir, publicDir, currentUser, readJson, send, HttpError } = ctx;
  const P = {
    // Types : `pref` (réglage du joueur qui les active), `cooldownMinutes` entre deux envois du même type.
    types: {
      attacked: { pref: 'attacked', cooldownMinutes: 20 },
      retreat: { pref: 'attacked', cooldownMinutes: 30 },
      rally: { pref: 'rally', cooldownMinutes: 10 },
      stamina: { pref: 'stamina', cooldownMinutes: 360 },
      results: { pref: 'results', cooldownMinutes: 60 },
      verdict: { pref: 'verdict', cooldownMinutes: 30 },
    },
    // Notifications du jeu qui deviennent des notifications push.
    map: { territory_attacked: 'attacked', must_retreat: 'retreat', rally: 'rally', campaign_end: 'results', campaign_end_draw: 'results', general_verdict: 'verdict' },
    dailyMax: 6,
    quiet: { from: 23, to: 8, timezone: 'Europe/Paris' },
    ...(config.push || {}),
  };
  const ALLOWED_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)web\.push\.apple\.com$/];

  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      stamina INTEGER NOT NULL DEFAULT 1, attacked INTEGER NOT NULL DEFAULT 1, rally INTEGER NOT NULL DEFAULT 1,
      results INTEGER NOT NULL DEFAULT 1, verdict INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS push_log (user_id INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_log_user ON push_log (user_id, at);
  `);
  const q = {
    subsOf: db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
    allUsers: db.prepare('SELECT DISTINCT user_id FROM push_subs'),
    addSub: db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    dropSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
    dropUserSub: db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?'),
    prefs: db.prepare('SELECT stamina, attacked, rally, results, verdict FROM push_prefs WHERE user_id = ?'),
    ensurePrefs: db.prepare('INSERT OR IGNORE INTO push_prefs (user_id) VALUES (?)'),
    setPrefs: db.prepare('UPDATE push_prefs SET stamina = ?, attacked = ?, rally = ?, results = ?, verdict = ? WHERE user_id = ?'),
    log: db.prepare('INSERT INTO push_log (user_id, type, at) VALUES (?, ?, ?)'),
    lastOf: db.prepare('SELECT max(at) AS at FROM push_log WHERE user_id = ? AND type = ?'),
    countSince: db.prepare('SELECT count(*) AS n FROM push_log WHERE user_id = ? AND at >= ?'),
    purge: db.prepare('DELETE FROM push_log WHERE at < ?'),
    lang: db.prepare('SELECT lang FROM users WHERE id = ?'),
  };

  // ---------------------------------------------------------------- clés VAPID
  const keyFile = path.join(dataDir, 'vapid.json');
  let keys;
  try { keys = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { keys = null; }
  if (!keys) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  function vapidHeader(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
  }

  // ---------------------------------------------------------------- chiffrement du message (RFC 8291, aes128gcm)
  function encrypt(sub, payload) {
    const uaPublic = unb64u(sub.p256dh);
    const authSecret = unb64u(sub.auth);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(uaPublic);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const salt = crypto.randomBytes(16);
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
  }

  // ---------------------------------------------------------------- envoi
  const allowedEndpoint = (endpoint) => {
    let u;
    try { u = new URL(endpoint); } catch { return false; }
    if (process.env.PUSH_ALLOW_ANY === '1') return true;
    return u.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  };
  async function deliver(sub, message) {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal', Authorization: vapidHeader(sub.endpoint) },
      body: encrypt(sub, JSON.stringify(message)),
    });
    if (res.status === 404 || res.status === 410) q.dropSub.run(sub.endpoint); // abonnement résilié
    return res.status;
  }
  // Texte du message dans la langue du joueur, d'après les textes de notification de l'app.
  const dicts = new Map();
  function dict(lang) {
    if (!dicts.has(lang)) {
      try { dicts.set(lang, JSON.parse(fs.readFileSync(path.join(publicDir, 'i18n', `${lang}.json`), 'utf8'))); } catch { dicts.set(lang, {}); }
    }
    return dicts.get(lang);
  }
  function text(userId, key, params) {
    const lang = q.lang.get(userId)?.lang || config.defaultLang || 'fr';
    const d = dict(lang);
    const fb = dict(config.defaultLang || 'fr');
    const loc = (o) => (o && typeof o === 'object' ? o[lang] || o[config.defaultLang || 'fr'] : o);
    const p = { ...params };
    for (const k of ['territory', 'home']) if (p[k]) p[k] = loc(config.map.territories.find((x) => x.id === p[k])?.name) || p[k];
    if (p.faction) p.faction = loc(config.factions.find((x) => x.id === p.faction)?.name) || p.faction;
    if (p.general) p.general = (config.generals?.roster || []).find((g) => g.id === p.general)?.name || p.general;
    const fill = (s) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ''));
    return { title: fill(d[`${key}.title`] ?? fb[`${key}.title`]), body: fill(d[`${key}.body`] ?? fb[`${key}.body`]) };
  }
  function isQuiet(at = Date.now()) {
    const { from, to, timezone } = P.quiet;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(at));
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  }
  // Envoie un message push à un joueur si ses réglages, la nuit, le délai du type et le plafond quotidien le permettent.
  async function sendTo(userId, type, key, params = {}) {
    const def = P.types[type];
    const subs = q.subsOf.all(userId);
    if (!def || !subs.length) return { sent: 0, why: 'no_subscription' };
    const prefs = q.prefs.get(userId);
    if (prefs && !prefs[def.pref]) return { sent: 0, why: 'disabled' };
    const now = Date.now();
    if (process.env.PUSH_IGNORE_QUIET !== '1' && isQuiet(now)) return { sent: 0, why: 'quiet' };
    const last = q.lastOf.get(userId, type)?.at || 0;
    if (now - last < def.cooldownMinutes * 60_000) return { sent: 0, why: 'cooldown' };
    if (q.countSince.get(userId, now - 86_400_000).n >= P.dailyMax) return { sent: 0, why: 'daily_cap' };
    const message = { ...text(userId, key, params), url: '/', tag: type };
    q.log.run(userId, type, now);
    let sent = 0;
    for (const sub of subs) {
      try { if ((await deliver(sub, message)) < 300) sent += 1; } catch { /* point d'arrivée injoignable : on réessaiera au prochain événement */ }
    }
    return { sent };
  }
  // Appelé pour chaque notification du jeu.
  function onNotify(userId, type, params) {
    const pushType = P.map[type];
    if (pushType) sendTo(userId, pushType, `notif.${type}`, params).catch(() => {});
  }
  // Réserve d'actions pleine : un message à chaque passage de « pas pleine » à « pleine ».
  const wasFull = new Map();
  function checkStamina() {
    if (!ctx.playerState) return;
    for (const { user_id: uid } of q.allUsers.all()) {
      const prefs = q.prefs.get(uid);
      if (prefs && !prefs.stamina) continue;
      const st = ctx.playerState(uid);
      if (!st || st.status !== 'alive' || !st.open) { wasFull.delete(uid); continue; }
      const full = st.actions >= st.maxActions;
      if (full && wasFull.get(uid) === false) sendTo(uid, 'stamina', 'notif.stamina_full', {}).catch(() => {});
      wasFull.set(uid, full);
    }
    q.purge.run(Date.now() - 3 * 86_400_000);
  }
  if (process.env.PUSH_STAMINA_MS !== '0') setInterval(() => { try { checkStamina(); } catch (e) { console.error(e); } }, Number(process.env.PUSH_STAMINA_MS) || 60_000).unref();

  // ---------------------------------------------------------------- routes
  const need = (req) => { const u = currentUser(req); if (!u) throw new HttpError(401, 'unauthorized'); return u; };
  const status = (userId) => ({ key: keys.publicKey, subscribed: q.subsOf.all(userId).length > 0, prefs: q.prefs.get(userId) || { stamina: 1, attacked: 1, rally: 1, results: 1, verdict: 1 } });
  const routes = {
    'GET /api/push/status': async (req, res) => { const u = need(req); send(res, 200, status(u.id)); },
    'POST /api/push/subscribe': async (req, res) => {
      const u = need(req);
      const { subscription } = await readJson(req);
      const sub = subscription || {};
      if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000 || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || !allowedEndpoint(sub.endpoint)) throw new HttpError(400, 'invalid_subscription');
      q.addSub.run(u.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
      q.ensurePrefs.run(u.id);
      send(res, 200, status(u.id));
    },
    'POST /api/push/unsubscribe': async (req, res) => {
      const u = need(req);
      const { endpoint } = await readJson(req);
      q.dropUserSub.run(u.id, String(endpoint || ''));
      send(res, 200, status(u.id));
    },
    'POST /api/push/prefs': async (req, res) => {
      const u = need(req);
      const b = await readJson(req);
      q.ensurePrefs.run(u.id);
      const cur = q.prefs.get(u.id);
      const v = (k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : cur[k]);
      q.setPrefs.run(v('stamina'), v('attacked'), v('rally'), v('results'), v('verdict'), u.id);
      send(res, 200, status(u.id));
    },
  };
  return { routes, onNotify, sendTo, encrypt, vapidHeader, publicKey: keys.publicKey, checkStamina, isQuiet };
};
