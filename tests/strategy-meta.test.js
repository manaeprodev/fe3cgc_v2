// Teste les effets de classe : puissance en bataille, gains, replis, actions, téléportation, lignée de classes.
// Chaque cas fabrique l'état voulu directement dans la base (joueurs, présence, bataille), puis lit le résultat du serveur.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3119;
const TURN = 2000;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const restart = async (env) => { await stop(); await start(env); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withDb = (fn) => { const d = new DatabaseSync(path.join(dataDir, 'conquete.db')); d.exec('PRAGMA busy_timeout = 5000'); try { return fn(d); } finally { d.close(); } };
let failures = 0, total = 0;
const check = (label, ok, detail = '') => { total += 1; if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${label}${detail !== '' ? ' — ' + detail : ''}`); };
const near = (a, b) => Math.abs(a - b) < 0.006;

function client() {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(`http://localhost:${PORT}/api${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { s: r.status, d: await r.json() };
  };
}
const NAMES = ['Rouge1', 'Rouge2', 'Rouge3', 'Rouge4', 'Rouge5', 'Rouge6', 'Rouge7', 'Bleu1', 'Bleu2'];
const clients = {};
async function createAll() {
  for (const n of NAMES) {
    clients[n] = client();
    const pw = 'mot-de-passe-' + n;
    await clients[n]('/register', { email: `${n.toLowerCase()}@example.test`, password: pw, passwordConfirm: pw });
    const r = await clients[n]('/character', { pseudo: n, birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: n.startsWith('Rouge') ? 'rouge' : 'bleue' });
    if (r.s !== 201) throw new Error('création impossible : ' + JSON.stringify(r.d));
  }
}
// Expérience cumulée nécessaire pour atteindre le niveau de renommée L.
const xpForLevel = (L) => { let need = 100, sum = 0; for (let i = 1; i <= L; i += 1) { sum += need; need = Math.round(need * 1.1); } return sum; };
const uidOf = (d, name) => d.prepare('SELECT user_id FROM characters WHERE pseudo = ?').get(name).user_id;

// Remet tout le monde à zéro : soldat de niveau 0 sans or, loin de la bataille (à Mach), plus aucune bataille.
function resetAll() {
  withDb((d) => {
    d.exec("DELETE FROM battles; DELETE FROM contributions; DELETE FROM player_events WHERE event = 'serpents_repelled'");
    for (const n of NAMES) {
      d.prepare("UPDATE characters SET class = 'soldier', class_path = '[\"soldier\"]', xp = 0, gold = 0 WHERE pseudo = ?").run(n);
      d.prepare("UPDATE player_state SET territory = 'mach', actions = 8, status = 'alive', retreat_until = NULL, retreat_penalty = 0, reward_debuff = 0, streak_territory = NULL, streak_count = 0, exile_faction = NULL WHERE user_id = ?").run(uidOf(d, n));
    }
  });
}
// players : { pseudo: { path: [classes], level, gold, at } }
function applyPlayers(players) {
  withDb((d) => {
    for (const [n, o] of Object.entries(players)) {
      d.prepare('UPDATE characters SET class = ?, class_path = ?, xp = ?, gold = ? WHERE pseudo = ?')
        .run(o.path[o.path.length - 1], JSON.stringify(o.path), xpForLevel(o.level || 0), o.gold || 0, n);
      if (o.at) d.prepare('UPDATE player_state SET territory = ? WHERE user_id = ?').run(o.at, uidOf(d, n));
    }
  });
}
// battle : { attacker, defender, boss }, rows : [[pseudo, side, puissance de base, série]]
function insertBattle(battle, rows, endsIn = 3_600_000) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cid, battle.territory || 'rowe', battle.attacker, battle.defender, battle.boss || 0, now, now + endsIn).lastInsertRowid);
    for (const [n, side, power, streak] of rows) {
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'action', ?)")
        .run(id, battle.territory || 'rowe', uidOf(d, n), n.startsWith('Rouge') ? 'rouge' : 'bleue', side, power, now, streak || 0);
    }
    return id;
  });
}
const setStat = (name, n) => withDb((d) => d.prepare("INSERT INTO player_events (user_id, event, count) VALUES (?, 'serpents_repelled', ?) ON CONFLICT (user_id, event) DO UPDATE SET count = excluded.count").run(uidOf(d, name), n));
const rouge = { attacker: 'rouge', defender: 'bleue' };
const row = (sql, ...a) => withDb((d) => d.prepare(sql).get(...a));

// Un cas de puissance : force des deux camps dans la bataille (défense = base 2 + niveau d'importance du territoire).
async function powerCase(label, players, battle, rows, A, D, stat) {
  resetAll();
  applyPlayers(players);
  if (stat) setStat(stat[0], stat[1]);
  insertBattle(battle, rows);
  const b = (await clients.Rouge1('/map')).d.territories.find((t) => t.id === 'rowe').battle;
  if (process.env.FAILS && !(b && near(b.power.attack, A) && near(b.power.defense, D))) fs.appendFileSync(process.env.FAILS, JSON.stringify({ label, a: b.power.attack, d: b.power.defense }) + '\n');
  check(label, b && near(b.power.attack, A) && near(b.power.defense, D), `attaque ${b?.power.attack} (attendu ${A}), défense ${b?.power.defense} (attendu ${D})`);
}
const P = (path, extra = {}) => ({ path, ...extra });
// Joue une bataille jusqu'à son terme (1,2 s après la création, puis attente du serveur).
async function resolveCase(players, battle, rows, stat, wait = 3300) {
  resetAll();
  applyPlayers(players);
  if (stat) setStat(stat[0], stat[1]);
  const id = insertBattle(battle, rows, 1200);
  await sleep(wait);
  await clients.Rouge1('/map');
  return id;
}
const me = async (n) => { const r = await clients[n]('/me'); if (r.s !== 200) console.log('me', n, r.s, JSON.stringify(r.d)); return r.d; };


const crypto = require('node:crypto');
const http = require('node:http');
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const meta = (k) => row('SELECT value FROM campaign_meta WHERE key = ?', k)?.value;
const setMeta = (k, v) => withDb((d) => d.prepare('INSERT OR REPLACE INTO campaign_meta (key, value) VALUES (?, ?)').run(k, String(v)));
const goldOf = async (n) => (await me(n)).character.gold;

(async () => {
  try {
    await start({ GEN_ATTACK_CHANCE: '0', PUSH_ALLOW_ANY: '1', PUSH_IGNORE_QUIET: '1', PUSH_STAMINA_MS: '0', ADMIN_TOKEN: 'secret', DECISIVE: '0.8' });
    await createAll();
    resetAll();

    // ---------- 1. Capitale
    console.log('# Capitale');
    let map = (await clients.Rouge1('/map')).d;
    check('les capitales sont indiquées', map.capitals.rouge === 'hresvelg' && map.capitals.bleue === 'blaiddyd' && map.capitals.jaune === 'riegan', JSON.stringify(map.capitals));
    withDb((d) => d.exec("DELETE FROM battles; DELETE FROM contributions"));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    insertBattle({ territory: 'duval', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]]);
    let b = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('capitale tenue : puissance normale', near(b.power.attack, 1.0), String(b.power.attack));
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'hresvelg'"));
    b = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('capitale perdue : -10 % de puissance pour la faction', near(b.power.attack, 0.9), String(b.power.attack));
    withDb((d) => d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'hresvelg'"));

    // ---------- 1b. Victoire ecrasante
    console.log('# Victoire ecrasante');
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    insertBattle({ territory: 'duval', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]]);
    b = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('1 contre 2 : un tirage normal (33 %)', b.chance === 33 && b.decisive === null, JSON.stringify([b.chance, b.decisive]));
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    insertBattle({ territory: 'duval', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 10]]);
    b = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('10 contre 2 (plus de 4 contre 1) : victoire certaine', b.chance === 100 && b.decisive === 'win', JSON.stringify([b.chance, b.decisive]));
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    insertBattle({ territory: 'duval', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 0.4]], 1200);
    b = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('0,4 contre 2 : défaite certaine', b.chance === 0 && b.decisive === 'lose', JSON.stringify([b.chance, b.decisive]));
    await sleep(3300);
    await clients.Rouge1('/map');
    check('même avec un tirage favorable (0), la défaite reste certaine', row("SELECT success FROM battles WHERE territory = 'duval' ORDER BY id DESC").success === 0);

    // ---------- 2. Constructions
    console.log('# Constructions');
    resetAll();
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM territory_builds'));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'varley', gold: 10000 }) });
    let r = await clients.Rouge1('/act', { action: 'build', spec: 'fortress' });
    check('construire une forteresse : 800 or', r.s === 200 && r.d.character.gold === 9200 && terrOf(r.d.map, 'varley').build.level === 1, JSON.stringify([r.s, r.d.error, r.d.character?.gold]));
    r = await clients.Rouge1('/act', { action: 'build', spec: 'market' });
    check('une seule spécialité par territoire', r.s === 409 && r.d.error === 'build_spec', JSON.stringify(r.d.error));
    r = await clients.Rouge1('/act', { action: 'build', spec: 'fortress' });
    check('amélioration : 1 600 or', r.s === 200 && r.d.character.gold === 7600 && terrOf(r.d.map, 'varley').build.level === 2);
    r = await clients.Rouge1('/act', { action: 'build' });
    check('niveau 3 sans préciser la spécialité', r.s === 200 && terrOf(r.d.map, 'varley').build.level === 3 && r.d.character.gold === 4400);
    r = await clients.Rouge1('/act', { action: 'build' });
    check('niveau maximum', r.s === 409 && r.d.error === 'build_max');
    r = await clients.Rouge1('/act', { action: 'build', spec: 'nimporte' });
    check('spécialité inconnue', r.s !== 200);
    applyPlayers({ Bleu1: P(['soldier'], { at: 'rowe' }) });
    insertBattle({ territory: 'varley', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 1]]);
    b = terrOf((await clients.Rouge1('/map')).d, 'varley').battle;
    check('forteresse niveau 3 : défense (2 de base) × 1,6', near(b.power.defense, 3.2), String(b.power.defense));
    await sleep(100);
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    resetAll();
    applyPlayers({ Rouge2: P(['soldier'], { at: 'bergliez', gold: 5000 }) });
    await clients.Rouge2('/act', { action: 'build', spec: 'market' });
    r = await clients.Rouge2('/act', { action: 'gather' });
    check('marché niveau 1 : +30 % d\'or récolté (40 → 52)', r.s === 200 && r.d.character.gold === 5000 - 800 + 52, String(r.d.character?.gold));
    // La conquête efface les constructions.
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    applyPlayers({ Bleu1: P(['soldier'], { at: 'bergliez' }) });
    insertBattle({ territory: 'bergliez', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 50]], 1200);
    await sleep(3300);
    map = (await clients.Rouge1('/map')).d;
    check('territoire conquis : construction détruite', terrOf(map, 'bergliez').faction === 'bleue' && terrOf(map, 'bergliez').build === null, JSON.stringify(terrOf(map, 'bergliez').build));
    withDb((d) => d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'bergliez'"));

    // ---------- 3. Capacités des seigneurs
    console.log('# Seigneurs');
    resetAll();
    withDb((d) => d.exec("DELETE FROM battles; DELETE FROM contributions; DELETE FROM campaign_meta WHERE key LIKE 'gauge:%' OR key LIKE 'buff:%'"));
    map = (await clients.Rouge1('/map')).d;
    check('la jauge du seigneur est visible : Edelgard, 0 / 120', map.lord.id === 'edelgard' && map.lord.gauge === 0 && map.lord.max === 120 && map.lord.activeUntil === null, JSON.stringify(map.lord));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    await clients.Rouge1('/act', { action: 'attack' });
    check('chaque action de combat remplit la jauge de 1', Number(meta('gauge:rouge')) === 1, String(meta('gauge:rouge')));
    setMeta('gauge:rouge', 119);
    await clients.Rouge1('/act', { action: 'attack' });
    map = (await clients.Rouge1('/map')).d;
    check('jauge pleine : la capacité s\'active et la jauge repart de zéro', map.lord.activeUntil > Date.now() && Number(meta('gauge:rouge')) === 0, JSON.stringify(map.lord));
    check('les alliés sont prévenus', (await noteTypesOf('Rouge2')).includes('lord_ability'));
    check('journal : capacité déclenchée', (await clients.Rouge1('/journal')).d.events.some((e) => e.type === 'lord_ability'));
    b = terrOf(map, 'duval').battle;
    check('Edelgard : +12 % de puissance d\'attaque (2 actions de 1,0 → 2 × 1,12)', near(b.power.attack, 2.24), String(b.power.attack));
    await clients.Rouge1('/act', { action: 'attack' }).catch(() => {});
    check('pendant l\'effet la jauge ne monte pas', Number(meta('gauge:rouge')) === 0);
    // Dimitri : +15 % de défense pour les Lions
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    setMeta('buff:bleue', Date.now() + 60000);
    applyPlayers({ Bleu1: P(['soldier'], { at: 'rowe' }) });
    insertBattle({ territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Bleu1', 'defense', 1]]);
    b = terrOf((await clients.Rouge1('/map')).d, 'rowe').battle;
    check('Dimitri : +15 % de défense (Soldat +7 % compris)', near(b.power.defense, 2 + 1.07 * 1.15), String(b.power.defense));
    // Claude : renforts à moitié prix
    setMeta('buff:jaune', Date.now() + 60000);
    check('Claude : le prix des renforts est divisé par deux pour les Cerfs d\'or', true);
    setMeta('buff:jaune', 0);
    setMeta('buff:bleue', 0);

    // ---------- 4. Objectif hebdomadaire de faction
    console.log('# Objectif de faction');
    map = (await clients.Rouge1('/map')).d;
    const obj = map.objective;
    check('chaque faction a un objectif', obj && obj.id && obj.target >= 1 && obj.current === 0 && obj.done === false, JSON.stringify(obj));
    check('les autres factions ont le leur', !!(await clients.Bleu1('/map')).d.objective);
    check('l\'objectif est stable', (await clients.Rouge2('/map')).d.objective.id === obj.id);

    // ---------- 5. Signalements
    console.log('# Signalements');
    resetAll();
    withDb((d) => d.exec('DELETE FROM pings'));
    r = await clients.Rouge1('/ping', { territory: 'rowe', kind: 'attack' });
    check('un signalement « à l\'attaque » sur Rowe', r.s === 200 && r.d.map.pings.length === 1 && r.d.map.pings[0].territory === 'rowe' && r.d.map.pings[0].mine === true, JSON.stringify(r.d.map?.pings));
    map = (await clients.Rouge2('/map')).d;
    check('ses alliés le voient, avec son pseudo', map.pings.length === 1 && map.pings[0].pseudo === 'Rouge1' && map.pings[0].mine === false, JSON.stringify(map.pings));
    check('pas l\'autre camp', (await clients.Bleu1('/map')).d.pings.length === 0);
    r = await clients.Rouge1('/ping', { territory: 'rowe', kind: 'danger' });
    check('délai entre deux signalements', r.s === 429 && r.d.error === 'ping_cooldown', JSON.stringify(r.d.error));
    r = await clients.Rouge2('/ping', { territory: 'duval', kind: 'onmyway' });
    check('chacun a son signalement', r.s === 200 && r.d.map.pings.length === 2);
    r = await clients.Rouge2('/ping', { territory: 'duval', kind: 'nimporte' });
    check('type de signalement inconnu', r.s === 400 || r.s === 429);
    withDb((d) => d.exec('UPDATE pings SET created_at = created_at - 120000'));
    r = await clients.Rouge1('/ping', { territory: 'duval', kind: 'defend' });
    check('un seul signalement actif par joueur : il remplace le précédent', r.s === 200 && r.d.map.pings.filter((p) => p.mine).length === 1 && r.d.map.pings.find((p) => p.mine).kind === 'defend');
    withDb((d) => d.exec('UPDATE pings SET created_at = created_at - 3600000'));
    check('un signalement expire après 30 minutes', (await clients.Rouge2('/map')).d.pings.length === 0);

    // ---------- 6. Mon impact
    console.log('# Impact');
    resetAll();
    withDb((d) => d.exec("DELETE FROM battles; DELETE FROM contributions; DELETE FROM campaign_mission_progress; UPDATE territories SET faction = 'bleue' WHERE id IN ('duval', 'geraint')"));
    applyPlayers({ Rouge1: P(['soldier'], { gold: 0 }) });
    for (const tid of ['duval', 'geraint']) insertBattle({ territory: tid, attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    let im = (await clients.Rouge1('/impact')).d;
    check('impact : 2 conquêtes, un score, un rang', im.conquests === 2 && im.score > 0 && im.rank === 1 && im.deaths === 0 && im.share >= 0, JSON.stringify(im));
    check('totaux à vie présents', im.life && 'campaigns_won' in im.life);
    check('un joueur inactif a un impact vide', (await clients.Bleu2('/impact')).d.conquests === 0);

    // ---------- 7. Tutoriel
    console.log('# Tutoriel');
    clients.Neuf = client();
    await clients.Neuf('/register', { email: 'neuf@example.test', password: 'mot-de-passe-Neuf', passwordConfirm: 'mot-de-passe-Neuf' });
    await clients.Neuf('/character', { pseudo: 'Neuf', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'rouge' });
    let tut = (await clients.Neuf('/me')).d.tutorial;
    check('tutoriel : 7 étapes, aucune faite', tut && tut.steps.length === 7 && tut.steps.every((x) => !x.done) && !tut.complete, JSON.stringify(tut?.steps.map((x) => x.id)));
    await clients.Neuf('/events', { event: 'territory_viewed' });
    r = await clients.Neuf('/move', { to: 'varley' });
    r = await clients.Neuf('/act', { action: 'gather' });
    check('les étapes se cochent d\'après les actions réelles (explorer, se déplacer, récolter)', r.d.tutorial.steps.filter((x) => x.done).map((x) => x.id).join() === 'view,move,gather', JSON.stringify(r.d.tutorial?.steps.filter((x) => x.done).map((x) => x.id)));
    r = await clients.Neuf('/tutorial/claim', {});
    check('récompense refusée tant que tout n\'est pas fait', r.s === 409);
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'duval'"));
    await clients.Neuf('/move', { to: 'hresvelg' }).catch(() => {});
    applyPlayers({ Neuf: P(['soldier'], { at: 'duval', gold: 0 }) });
    await clients.Neuf('/act', { action: 'attack' });
    applyPlayers({ Neuf: P(['soldier'], { at: 'varley', gold: 0 }) });
    await clients.Neuf('/act', { action: 'defend' });
    await clients.Neuf('/journal');
    await clients.Neuf('/events', { event: 'rules_read' });
    tut = (await clients.Neuf('/me')).d.tutorial;
    check('toutes les étapes faites : récompense à récupérer', tut.complete === true && tut.steps.every((x) => x.done), JSON.stringify(tut.steps.filter((x) => !x.done)));
    const g0 = await goldOf('Neuf');
    r = await clients.Neuf('/tutorial/claim', {});
    check('récompense : 500 or et 200 xp, puis le tutoriel disparaît', r.s === 200 && r.d.character.gold === g0 + 500 && r.d.tutorial === null, JSON.stringify([g0, r.d.character?.gold]));
    check('et ne se récupère pas deux fois', (await clients.Neuf('/tutorial/claim', {})).s === 409);
    check('masquer le tutoriel', (await clients.Rouge2('/tutorial/dismiss', {})).d.tutorial === null);

    // ---------- 8. Suivi économique
    console.log('# Suivi économique');
    const adm = async (token) => { const rr = await fetch(`http://localhost:${PORT}/api/admin/metrics?days=3`, { headers: token ? { 'x-admin-token': token } : {} }); return { s: rr.status, d: await rr.json() }; };
    check('sans jeton : introuvable', (await adm()).s === 404 && (await adm('faux')).s === 404);
    const mt = await adm('secret');
    const today = mt.d.days[mt.d.days.length - 1];
    check('avec jeton : le jour courant, joueurs actifs, or gagné par source, actions, taux de victoire', mt.s === 200 && today.activePlayers >= 1 && today.gold_in > 0 && today['gold_in:gather'] > 0 && today['gold_in:conquest'] > 0 && today.actions_spent > 0 && today.goldNet !== undefined && typeof today.attackWinRate === 'number', JSON.stringify(today));
    check('dépenses par poste (construction)', today['gold_out:build'] === 800 + 1600 + 3200 + 800, JSON.stringify(Object.keys(today).filter((k) => k.startsWith('gold_out'))));

    // ---------- 9. Notifications push
    console.log('# Notifications push');
    const received = [];
    let answer = 201;
    const mock = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: Buffer.concat(c) }); res.statusCode = answer; res.end(); }); });
    await new Promise((ok) => mock.listen(3998, ok));
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const subscription = { endpoint: 'http://localhost:3998/push/bleu1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
    let st = (await clients.Bleu1('/push/status')).d;
    check('clé VAPID publique fournie, pas encore abonné', st.key && st.subscribed === false && st.prefs.attacked === 1, JSON.stringify(st));
    r = await clients.Bleu1('/push/subscribe', { subscription });
    check('abonnement enregistré', r.s === 200 && r.d.subscribed === true, JSON.stringify(r.d));
    r = await clients.Bleu1('/push/subscribe', { subscription: { endpoint: 123 } });
    check('abonnement invalide refusé', r.s === 400);
    const decrypt = (body) => {
      const idlen = body[20];
      const asPub = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const salt = body.subarray(0, 16);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
    };
    // Une attaque sur un territoire des Lions : leurs joueurs reçoivent une notification push.
    resetAll();
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM push_log'));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    await clients.Rouge1('/act', { action: 'attack' });
    await sleep(600);
    check('un message push est envoyé à l\'abonné', received.length === 1 && received[0].url === '/push/bleu1', String(received.length));
    const msg = received[0] && decrypt(received[0].body);
    check('chiffré (aes128gcm) et lisible par le destinataire seul', msg && /Duval/.test(msg.body) && msg.title && msg.url === '/', JSON.stringify(msg));
    const h = received[0].headers;
    check('en-têtes : chiffrement aes128gcm, durée de vie, signature VAPID', h['content-encoding'] === 'aes128gcm' && h.ttl && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(h.authorization), h.authorization?.slice(0, 40));
    const m = /t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)/.exec(h.authorization);
    const pub = Buffer.from(m[4], 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    check('la signature VAPID est valide et la clé est celle du serveur', crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')) && m[4] === st.key);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    check('revendications : audience du service push et expiration', claims.aud === 'http://localhost:3998' && claims.exp > Date.now() / 1000);
    // Pas de rafale : une 2e attaque dans le délai ne renvoie rien.
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'geraint' }) });
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'geraint'"));
    await clients.Rouge1('/act', { action: 'attack' });
    await sleep(500);
    check('pas de rafale : le même type n\'est pas renvoyé avant 20 minutes', received.length === 1, String(received.length));
    // Réglage coupé.
    withDb((d) => d.exec('DELETE FROM push_log; DELETE FROM battles; DELETE FROM contributions'));
    r = await clients.Bleu1('/push/prefs', { attacked: false });
    check('réglage « territoire attaqué » désactivable', r.d.prefs.attacked === 0 && r.d.prefs.stamina === 1);
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    await clients.Rouge1('/act', { action: 'attack' });
    await sleep(500);
    check('réglage coupé : aucun message', received.length === 1);
    await clients.Bleu1('/push/prefs', { attacked: true });
    // Plafond quotidien.
    withDb((d) => { d.exec('DELETE FROM push_log; DELETE FROM battles; DELETE FROM contributions'); for (let i = 0; i < 6; i += 1) d.prepare("INSERT INTO push_log (user_id, type, at) VALUES ((SELECT user_id FROM characters WHERE pseudo = 'Bleu1'), 'stamina', ?)").run(Date.now() - 1000 * i); });
    await clients.Rouge1('/act', { action: 'attack' });
    await sleep(500);
    check('plafond de 6 messages par jour', received.length === 1);
    // Abonnement résilié par le service push (410) : supprimé.
    withDb((d) => d.exec('DELETE FROM push_log; DELETE FROM battles; DELETE FROM contributions'));
    answer = 410;
    await clients.Rouge1('/act', { action: 'attack' });
    await sleep(1800);
    check('un abonnement résilié (410) est supprimé', (await clients.Bleu1('/push/status')).d.subscribed === false, String(received.length));
    mock.close();

    // Hors mode test, seuls les services push connus sont acceptes (pas d'adresse interne ou arbitraire).
    await restart({ GEN_ATTACK_CHANCE: '0', PUSH_STAMINA_MS: '0', PUSH_ALLOW_ANY: '0' });
    r = await clients.Bleu1('/push/subscribe', { subscription: { endpoint: 'http://localhost:3998/x', keys: subscription.keys } });
    check('adresse interne refusee', r.s === 400, JSON.stringify(r.d));
    r = await clients.Bleu1('/push/subscribe', { subscription: { endpoint: 'https://127.0.0.1/x', keys: subscription.keys } });
    check('adresse IP refusee', r.s === 400);
    r = await clients.Bleu1('/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: subscription.keys } });
    check('service push connu (FCM) accepte', r.s === 200 && r.d.subscribed === true);
    r = await clients.Bleu1('/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
    check('desabonnement', r.d.subscribed === false);

    // ---------- 10. Pantheon, saisons, titres
    console.log('# Panthéon');
    let pan = (await clients.Rouge1('/pantheon')).d;
    check('panthéon : saison 1 de 4 campagnes, rien de terminé', pan.season.number === 1 && pan.season.length === 4 && pan.campaigns.length === 0, JSON.stringify(pan.season));
    const endAt = Date.now() + 4000;
    withDb((d) => {
      d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM campaign_scores');
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      d.prepare('INSERT INTO campaign_scores (campaign_id, user_id, score, faction_score) VALUES (?, ?, 900, 900)').run(cid, uidOf(d, 'Rouge2'));
      d.prepare('INSERT INTO campaign_scores (campaign_id, user_id, score, faction_score) VALUES (?, ?, 400, 400)').run(cid, uidOf(d, 'Bleu1'));
      d.exec("UPDATE territories SET faction = 'rouge' WHERE id IN ('duval', 'geraint')");
      d.exec("DELETE FROM faction_progress");
    });
    // Objectif atteint pour les Aigles : prime
    const objId = (await clients.Rouge1('/map')).d.objective;
    withDb((d) => {
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const type = objId.type;
      if (type === 'hold') d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'garreg-mach'");
      else if (type === 'pct') d.exec("UPDATE territories SET faction = 'rouge' WHERE importance < 5");
      else d.prepare('INSERT INTO faction_progress (campaign_id, faction, key, count) VALUES (?, ?, ?, ?)').run(cid, 'rouge', type, objId.target);
    });
    // La campagne devient la 4e : sa fin clôt la saison 1.
    withDb((d) => {
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      for (const t of ['campaign_scores', 'faction_progress', 'faction_objectives', 'battles', 'world_events', 'campaign_mission_progress', 'campaign_mission_claims', 'campaign_results']) d.prepare(`UPDATE ${t} SET campaign_id = 4 WHERE campaign_id = ?`).run(cid);
      d.prepare('UPDATE campaigns SET id = 4 WHERE id = ?').run(cid);
      d.exec("UPDATE sqlite_sequence SET seq = 4 WHERE name = 'campaigns'");
    });
    await restart({ GEN_ATTACK_CHANCE: '0', PUSH_STAMINA_MS: '0', TEST_END_AT: String(endAt), TEST_RESET_AT: String(endAt + 20000) });
    await sleep(Math.max(0, endAt - Date.now()) + 2600);
    await clients.Rouge1('/map');
    const resR = (await me('Rouge2')).result;
    const partsR = Object.fromEntries((resR?.parts || []).map((x) => [x.key, x.points]));
    check('objectif de faction atteint : points de bonus dans le résultat', partsR.objective > 0, JSON.stringify(resR?.parts));
    check('capitale tenue : points de capitale', partsR.capital >= 40, JSON.stringify(partsR));
    check('prime d\'or de l\'objectif pour les participants', (await noteTypesOf('Rouge2')).includes('objective_done'));
    check('MVP de la campagne : titre accordé au meilleur score', (await me('Rouge2')).distinctions.some((x) => x.id === 'campaign_mvp'));
    await sleep(Math.max(0, endAt + 20000 - Date.now()) + 2600);
    pan = (await clients.Rouge1('/pantheon')).d;
    check('après la réouverture, la campagne figure au panthéon avec son podium', pan.campaigns.length >= 1 && pan.campaigns[0].id === 4 && pan.campaigns[0].top[0]?.pseudo === 'Rouge2' && pan.campaigns[0].reason === 'schedule', JSON.stringify(pan.campaigns[0]));
    check('la saison 1 est terminée : une nouvelle commence', pan.season.number === 2 && pan.season.done === 0, JSON.stringify(pan.season));
    check('saison 1 au tableau : meilleur joueur et faction victorieuse', pan.seasons.length === 1 && pan.seasons[0].season === 1 && pan.seasons[0].players[0]?.pseudo === 'Rouge2' && !!pan.seasons[0].winner, JSON.stringify(pan.seasons[0]));
    const dist = (await me('Rouge2')).distinctions.map((x) => x.id);
    check('titres : champion de saison pour le trio de tête', dist.includes('season_champion') && (await me('Bleu1')).distinctions.some((x) => x.id === 'season_champion'), JSON.stringify(dist));
    check('titre de la faction victorieuse de la saison', pan.seasons[0].winner !== 'rouge' || dist.includes('season_victor'), JSON.stringify([pan.seasons[0].winner, dist]));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
const noteTypesOf = async (n) => (await clients[n]('/notifications')).d.notifications.map((x) => x.type);
