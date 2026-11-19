// Teste les effets de classe : puissance en bataille, gains, replis, actions, téléportation, lignée de classes.
// Chaque cas fabrique l'état voulu directement dans la base (joueurs, présence, bataille), puis lit le résultat du serveur.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3118;
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


const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const mission = async (n, id) => (await clients[n]('/missions')).d.campaignMissions.find((m) => m.id === id);

(async () => {
  try {
    await start({ GEN_ATTACK_CHANCE: '0' });
    await createAll();

    // ---------- 1. Chevalier blindé et chevalier forteresse
    console.log('# Chevaliers');
    resetAll();
    withDb((d) => d.exec("UPDATE generals SET status = 'dead'"));
    await powerCase('Chevalier blindé : +10 % de défense (et +7 % du Soldat)', { Bleu1: P(['soldier', 'armored-knight'], { at: 'duval' }) }, { territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Bleu1', 'defense', 1]], 0, 3.17);
    await powerCase('Chevalier forteresse : +15 % de plus (+7 +10 +15 = +32 %)', { Bleu1: P(['soldier', 'armored-knight', 'fortress-knight'], { at: 'duval' }) }, { territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Bleu1', 'defense', 1]], 0, 3.32);

    // ---------- 2. Missions de campagne
    console.log('# Missions de campagne');
    withDb((d) => d.exec("UPDATE generals SET status = 'alive', spared = 0"));
    let ms = (await clients.Rouge1('/missions')).d.campaignMissions;
    check('7 missions de campagne, toutes à zéro', ms.length === 7 && ms.every((m) => m.current === 0 && m.status === 'active'), ms.map((m) => m.id).join(','));
    resetAll();
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs'); d.exec("UPDATE territories SET faction = 'bleue' WHERE id IN ('varley', 'duval', 'geraint', 'rowe')"); });
    applyPlayers({ Rouge1: P(['soldier'], { gold: 0 }), Rouge2: P(['soldier']) });
    // Trois conquêtes, dont la reprise de Varley (territoire d'origine des Aigles) et celle de Mach (annexe).
    for (const tid of ['varley', 'duval', 'geraint']) insertBattle({ territory: tid, attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1200);
    insertBattle({ territory: 'mach', attacker: 'rouge', defender: null }, [['Rouge1', 'attack', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    check('3 territoires conquis : mission « Conquérir 3 territoires » accomplie (4 conquêtes comptées)', (await mission('Rouge1', 'c-conquest')).status === 'done');
    check('reprise d\'un territoire d\'origine : Varley', (await mission('Rouge1', 'c-retake')).status === 'done');
    check('territoire annexe : Mach', (await mission('Rouge1', 'c-annex')).status === 'done');
    check('Garreg-Mach pas encore', (await mission('Rouge1', 'c-garreg')).current === 0);
    check('un autre joueur n\'a rien', (await mission('Rouge2', 'c-conquest')).current === 0);
    let r = await clients.Rouge1('/missions/campaign/claim', { id: 'c-conquest' });
    check('récompense récupérée (400 or) et mission marquée', r.s === 200 && r.d.character.gold === 400 + 4 * 150 && r.d.campaignMissions.find((m) => m.id === 'c-conquest').status === 'claimed', JSON.stringify([r.s, r.d.character?.gold]));
    r = await clients.Rouge1('/missions/campaign/claim', { id: 'c-conquest' });
    check('on ne la récupère pas deux fois', r.s === 409, JSON.stringify(r.d.error));
    r = await clients.Rouge1('/missions/campaign/claim', { id: 'c-garreg' });
    check('ni une mission non accomplie', r.s === 409);
    check('les missions à récupérer comptent dans la pastille', (await me('Rouge1')).claimable >= 2);
    // Garreg-Mach.
    resetAll();
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'garreg-mach' }) });
    insertBattle({ territory: 'garreg-mach', attacker: 'rouge', defender: 'eglise' }, [['Rouge1', 'attack', 50]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Garreg-Mach conquis : mission accomplie', (await mission('Rouge1', 'c-garreg')).status === 'done');
    // Défenses.
    await restart({ GEN_ATTACK_CHANCE: '0', TEST_ROLL: '0.999' });
    resetAll();
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    applyPlayers({ Bleu1: P(['soldier']) });
    for (const tid of ['blaiddyd', 'dominic', 'galatea']) insertBattle({ territory: tid, attacker: 'rouge', defender: 'bleue' }, [['Bleu1', 'defense', 1]], 1200);
    await sleep(3300);
    await clients.Bleu1('/map');
    check('3 défenses réussies : mission accomplie', (await mission('Bleu1', 'c-defense')).status === 'done');
    // Général vaincu, puis épargné.
    await restart({ GEN_ATTACK_CHANCE: '0' });
    resetAll();
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs'); d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'rowe'"); });
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe' }) });
    insertBattle({ territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('général vaincu : mission accomplie', (await mission('Rouge1', 'c-general')).status === 'done');
    check('mais pas encore épargné', (await mission('Rouge1', 'c-spare')).current === 0);
    await clients.Rouge1('/general/verdict', { general: 'ashe', spare: true });
    check('épargner un général : mission accomplie', (await mission('Rouge1', 'c-spare')).status === 'done');

    // ---------- 3. Réactions du journal
    console.log('# Réactions du journal');
    resetAll();
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM world_events; DELETE FROM journal_reactions'); d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'duval'"); });
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval', gold: 0 }), Rouge2: P(['soldier'], { at: 'varley', gold: 0 }), Bleu1: P(['soldier'], { at: 'blaiddyd' }) });
    r = await clients.Rouge1('/act', { action: 'attack' });
    check('Rouge1 lance une attaque', r.s === 200, JSON.stringify(r.d.error));
    let j = (await clients.Rouge2('/journal')).d.events;
    const started = j.find((e) => e.type === 'battle_started');
    check('un allié peut soutenir cette attaque', started && started.react.join() === 'support' && !('actor' in started.params), JSON.stringify(started));
    check('l\'auteur de l\'attaque ne peut pas se soutenir lui-même', (await clients.Rouge1('/journal')).d.events.find((e) => e.type === 'battle_started').react.length === 0);
    check('un ennemi ne peut pas soutenir', (await clients.Bleu1('/journal')).d.events.find((e) => e.type === 'battle_started').react.length === 0);
    r = await clients.Rouge2('/journal/react', { event: started.id, kind: 'support' });
    check('soutenir : +10 or pour l\'allié à l\'origine de l\'action', r.s === 200 && r.d.flash.gold === 10 && (await me('Rouge1')).character.gold === 10, JSON.stringify(r.d.flash));
    check('il est prévenu', (await clients.Rouge1('/notifications')).d.notifications.some((n) => n.type === 'supported'));
    r = await clients.Rouge2('/journal/react', { event: started.id, kind: 'support' });
    check('une seule fois par événement', r.s === 409, JSON.stringify(r.d.error));
    r = await clients.Rouge2('/journal/react', { event: started.id, kind: 'cheer' });
    check('et pas une autre réaction que celle qui est permise', r.s === 409);
    // Appel à l'aide
    const chance0 = terrOf((await clients.Rouge1('/map')).d, 'duval').battle.chance;
    r = await clients.Rouge1('/rally', {});
    j = (await clients.Rouge2('/journal')).d.events;
    const rally = j.find((e) => e.type === 'rally');
    check('un allié peut envoyer de l\'aide', rally && rally.react.join() === 'help', JSON.stringify(rally));
    check('mais pas celui qui a appelé à l\'aide', (await clients.Rouge1('/journal')).d.events.find((e) => e.type === 'rally').react.length === 0);
    r = await clients.Rouge2('/journal/react', { event: rally.id, kind: 'help' });
    const chance1 = terrOf((await clients.Rouge1('/map')).d, 'duval').battle.chance;
    check('aide : +1 point de chances de succès', r.s === 200 && chance1 === chance0 + 1, `${chance0} → ${chance1}`);
    // Félicitations une fois le territoire pris
    await sleep(13500);
    await clients.Rouge1('/map');
    j = (await clients.Rouge2('/journal')).d.events;
    const taken = j.find((e) => e.type === 'territory_taken');
    check('territoire pris : un allié qui n\'y a pas combattu peut féliciter', taken && taken.react.join() === 'cheer', JSON.stringify(taken));
    check('pas ceux qui ont combattu', (await clients.Rouge1('/journal')).d.events.find((e) => e.type === 'territory_taken').react.length === 0);
    check('ni l\'autre camp', (await clients.Bleu1('/journal')).d.events.find((e) => e.type === 'territory_taken').react.length === 0);
    const xp0 = (await me('Rouge2')).character.xp;
    r = await clients.Rouge2('/journal/react', { event: taken.id, kind: 'cheer' });
    check('féliciter : +10 xp', r.s === 200 && r.d.character.xp === xp0 + 10, JSON.stringify([xp0, r.d.character?.xp]));
    const done = (await clients.Rouge2('/journal')).d.events.find((e) => e.type === 'territory_taken');
    check('la réaction disparaît ensuite', done.react.length === 0);
    // Soutien impossible une fois la bataille terminée
    check('l\'attaque terminée ne se soutient plus', (await clients.Rouge2('/journal')).d.events.find((e) => e.type === 'battle_started').react.length === 0);

    // ---------- 4. Game over : données fournies à l'app
    console.log('# Game over');
    const pl = (await me('Rouge1')).player;
    check('le joueur reçoit la campagne, son nombre de chutes et le coefficient de retour', Number.isInteger(pl.campaignId) && pl.deaths === 0 && pl.fallMult === 1, JSON.stringify(pl));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
