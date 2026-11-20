// Teste les effets de classe : puissance en bataille, gains, replis, actions, téléportation, lignée de classes.
// Chaque cas fabrique l'état voulu directement dans la base (joueurs, présence, bataille), puis lit le résultat du serveur.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3116;
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
      d.prepare("UPDATE player_state SET territory = 'mach', actions = 6, status = 'alive', retreat_until = NULL, retreat_penalty = 0, reward_debuff = 0, streak_territory = NULL, streak_count = 0, exile_faction = NULL WHERE user_id = ?").run(uidOf(d, n));
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

(async () => {
  try {
    await start();
    await createAll();

    // ---------- 1. Puissance en bataille (rowe : importance 1, défense de base 2)
    console.log('# Puissance en bataille');
    await powerCase('Épéiste : +7 % d\'attaque', { Rouge1: P(['myrmidon'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.07, 2);
    await powerCase('Soldat : +7 % de défense, rien en attaque', { Rouge1: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge,
      [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1, 3.07);
    await powerCase('Combattant : +1 % par action consécutive', { Rouge1: P(['fighter'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1, 0], ['Rouge1', 'attack', 1, 5]], 2.1, 2);
    await powerCase('Combattant : plafonné à +20 %', { Rouge1: P(['fighter'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1, 50]], 1.2, 2);
    await powerCase('Moine : +2 % aux alliés d\'un territoire voisin', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(['monk'], { at: 'duval' }) }, rouge, [['Rouge1', 'attack', 1]], 1.04, 2);
    await powerCase('Moine : rien s\'il est trop loin', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(['monk'], { at: 'hresvelg' }) }, rouge, [['Rouge1', 'attack', 1]], 1.0, 2);
    await powerCase('Mage : +2 % aux Épéistes sur place (plus Moine et bonus propre)', { Rouge1: P(['myrmidon'], { at: 'rowe' }), Rouge2: P(['monk', 'mage'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.13, 2);
    await powerCase('Mage : son aura ne passe pas la frontière du territoire (le Moine si)', { Rouge1: P(['myrmidon'], { at: 'rowe' }), Rouge2: P(['monk', 'mage'], { at: 'duval' }) }, rouge, [['Rouge1', 'attack', 1]], 1.11, 2);
    await powerCase('Bretteur : +3 % aux Épéistes sur place, lui compris', { Rouge1: P(['myrmidon'], { at: 'rowe' }), Rouge2: P(['myrmidon', 'mercenary', 'swordsmaster'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.1, 2);
    await powerCase('Paladin : +3 % aux Soldats en défense', { Bleu1: P(['soldier'], { at: 'rowe' }), Bleu2: P(['soldier', 'cavalier', 'paladin'], { at: 'rowe' }) }, rouge, [['Bleu1', 'defense', 1]], 0, 3.1);
    await powerCase('Danseur : +5 % aux alliés, sauf aux Danseurs', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(['myrmidon', 'mercenary', 'swordsmaster', 'dancer'], { at: 'rowe' }) }, rouge,
      [['Rouge1', 'attack', 1], ['Rouge2', 'attack', 1]], 2.15, 2);
    await powerCase('Auras plafonnées à +25 %', Object.fromEntries([['Rouge1', P(['soldier'], { at: 'rowe' })], ...['Rouge2', 'Rouge3', 'Rouge4', 'Rouge5', 'Rouge6', 'Rouge7'].map((n) => [n, P(['myrmidon', 'mercenary', 'swordsmaster', 'dancer'], { at: 'rowe' })])]), rouge,
      [['Rouge1', 'attack', 1]], 1.25, 2);
    await powerCase('Assassin : +3 % puis +5 % d\'attaque (cumul)', { Rouge1: P(['myrmidon', 'thief', 'assassin'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.19, 2);
    await powerCase('Grand chevalier : 3 + 10 + 15 + 20 = +38 % de défense', { Bleu1: P(['soldier', 'armored-knight', 'fortress-knight', 'great-knight'], { at: 'rowe' }) }, rouge, [['Bleu1', 'defense', 1]], 0, 3.52);
    await powerCase('Érudit mortel : +2 % par allié présent sur place et autour (sans lui)',
      { Rouge1: P(['myrmidon', 'mercenary', 'swordsmaster', 'mortal-savant'], { at: 'rowe' }), Rouge2: P(['soldier'], { at: 'duval' }), Rouge3: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.14, 2);
    const filou = ['myrmidon', 'thief', 'assassin', 'trickster'];
    await powerCase('Filou en infériorité numérique : +10 %', { Rouge1: P(filou, { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }), Bleu2: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.29, 2);
    await powerCase('Filou à égalité : pas de bonus', { Rouge1: P(filou, { at: 'rowe' }), Rouge2: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }), Bleu2: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.19, 2);
    const darkMage = ['monk', 'mage', 'dark-mage'];
    await powerCase('Mage noir : ×2,5 sans Moine chez les alliés ni chez les ennemis', { Rouge1: P(darkMage, { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 2.6, 2);
    await powerCase('Mage noir : ×2 si un ennemi a Moine', { Rouge1: P(darkMage, { at: 'rowe' }), Bleu1: P(['monk', 'priest'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 2.08, 2);
    await powerCase('Mage noir : pas de bonus si un allié a Moine', { Rouge1: P(darkMage, { at: 'rowe' }), Rouge2: P(['monk'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.08, 2);
    await powerCase('Mage noir : ×2 quand il n\'y a aucun ennemi', { Rouge1: P(darkMage, { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 2.08, 2);
    await powerCase('Enchanteur : -10 % de pouvoir aux ennemis Épéiste, Soldat ou Combattant',
      { Rouge1: P(['monk', 'mage', 'warlock'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1.04, 2.97);
    await powerCase('Archer : -30 % de défense aux ennemis volants',
      { Rouge1: P(['fighter', 'archer'], { at: 'rowe' }), Bleu1: P(['soldier', 'pegasus-knight'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1, 2.77);
    await powerCase('Cavalier archer : -30 % de plus (60 %) et +10 % par ennemi volant',
      { Rouge1: P(['fighter', 'archer'], { at: 'rowe' }), Rouge2: P(['fighter', 'archer', 'sniper', 'bow-knight'], { at: 'rowe' }), Bleu1: P(['soldier', 'pegasus-knight'], { at: 'rowe' }) }, rouge,
      [['Rouge1', 'attack', 1], ['Rouge2', 'attack', 1], ['Bleu1', 'defense', 1]], 2.1, 2.47);
    await powerCase('Pugiliste : -30 % de défense aux ennemis qui ont Moine',
      { Rouge1: P(['fighter', 'brawler'], { at: 'rowe' }), Bleu1: P(['monk', 'priest'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1, 2.74);
    await powerCase('Batailleur : -30 % de plus (60 %), le Pugiliste ne compte qu\'une fois',
      { Rouge1: P(['fighter', 'brawler'], { at: 'rowe' }), Rouge2: P(['fighter', 'brawler', 'grappler'], { at: 'rowe' }), Bleu1: P(['monk', 'priest'], { at: 'rowe' }) }, rouge,
      [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1, 2.44);
    const warMaster = ['fighter', 'brawler', 'grappler', 'war-master'];
    await powerCase('Maître de guerre : +50 % si sa renommée égale ou dépasse celle de l\'ennemi',
      { Rouge1: P(warMaster, { at: 'rowe', level: 10 }), Bleu1: P(['soldier'], { at: 'rowe', level: 5 }) }, rouge, [['Rouge1', 'attack', 1]], 1.5, 2);
    await powerCase('Maître de guerre : rien face à un ennemi plus renommé',
      { Rouge1: P(warMaster, { at: 'rowe', level: 10 }), Bleu1: P(['soldier'], { at: 'rowe', level: 12 }) }, rouge, [['Rouge1', 'attack', 1]], 1.0, 2);
    await powerCase('Maître de guerre : rien sans ennemi', { Rouge1: P(warMaster, { at: 'rowe', level: 10 }) }, rouge, [['Rouge1', 'attack', 1]], 1.0, 2);
    const holy = ['monk', 'priest', 'bishop', 'holy-knight'];
    await powerCase('Chevalier sacré : +1 % par attaque des Serpents repoussée (10 → +10 %, plus Moine)', { Rouge1: P(holy, { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.14, 2, ['Rouge1', 10]);
    await powerCase('Chevalier sacré : ×4 sur un territoire conquis par les Serpents', { Rouge1: P(holy, { at: 'rowe' }) }, { attacker: 'rouge', defender: 'serpents' }, [['Rouge1', 'attack', 1]], 4.16, 4, ['Rouge1', 10]);
    await powerCase('Chevalier sacré : divise par 4 l\'attaque des Serpents', { Bleu1: P(holy, { at: 'rowe' }) }, { attacker: 'serpents', defender: 'bleue', boss: 3 }, [], 0.75, 2);

    // ---------- 2. Gains de bataille (conquête réussie : 150 or et 60 xp pour le territoire d'importance 1)
    console.log('# Gains en cas de conquête');
    await resolveCase({
      Rouge1: P(['myrmidon', 'mercenary'], { at: 'rowe' }), Rouge2: P(['soldier', 'cavalier'], { at: 'rowe' }),
      Rouge3: P(['fighter', 'brigand'], { at: 'rowe' }), Rouge4: P(['fighter', 'brigand', 'warrior'], { at: 'rowe' }),
    }, rouge, [['Rouge1', 'attack', 1], ['Rouge2', 'attack', 1], ['Rouge3', 'attack', 1], ['Rouge4', 'attack', 1]]);
    const g = async (n) => { const c = (await me(n)).character; return `${c.gold} or, ${c.xp} xp`; };
    check('Mercenaire : +10 % d\'or (165)', (await g('Rouge1')) === '165 or, 60 xp', await g('Rouge1'));
    check('Cavalier : +10 % de renommée (66)', (await g('Rouge2')) === '150 or, 66 xp', await g('Rouge2'));
    check('Brigand : +30 % d\'or sur une attaque réussie (195)', (await g('Rouge3')) === '195 or, 60 xp', await g('Rouge3'));
    check('Guerrier : cumule le Brigand et gagne +25 de renommée (85)', (await g('Rouge4')) === '195 or, 85 xp', await g('Rouge4'));

    await resolveCase({ Rouge1: P(['myrmidon', 'thief'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe', gold: 100 }), Bleu2: P(['soldier'], { at: 'rowe', gold: 20 }) },
      rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]]);
    check('Voleur : 30 or pris à chaque défenseur (le moins fortuné ne perd que ce qu\'il a)', (await me('Bleu1')).character.gold === 70 && (await me('Bleu2')).character.gold === 0,
      `${(await me('Bleu1')).character.gold} / ${(await me('Bleu2')).character.gold}`);
    check('Voleur : empoche le butin (50) en plus de la récompense (150)', (await me('Rouge1')).character.gold === 200, String((await me('Rouge1')).character.gold));
    check('le voleur et ses victimes sont prévenus', (await clients.Rouge1('/notifications')).d.notifications.some((x) => x.type === 'loot' && x.params.gold === 50)
      && (await clients.Bleu1('/notifications')).d.notifications.some((x) => x.type === 'robbed' && x.params.gold === 30));

    // ---------- 2b. Assassin, Gremory, Paladin noir
    console.log('# Assassin, Gremory, Paladin noir');
    await restart();
    await resolveCase({ Rouge1: P(['myrmidon', 'thief', 'assassin'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe', gold: 100 }) }, rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]]);
    check('Assassin : vole 30 + 20 = 50 or à chaque défenseur', (await me('Bleu1')).character.gold === 50 && (await me('Rouge1')).character.gold === 200,
      `${(await me('Bleu1')).character.gold} / ${(await me('Rouge1')).character.gold}`);
    const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json')).territories;
    const nb = (id) => MAP.find((t) => t.id === id).neighbors;
    const ring1 = new Set(nb('rowe'));
    const ring2 = new Set([...ring1].flatMap(nb).filter((x) => x !== 'rowe' && !ring1.has(x)));
    const ring3 = [...ring2].flatMap(nb).find((x) => x !== 'rowe' && !ring1.has(x) && !ring2.has(x));
    const [r1, r2] = [[...ring1][0], [...ring2][0]];
    const gremory = ['monk', 'mage', 'warlock', 'gremory'];
    const dancer = ['myrmidon', 'mercenary', 'swordsmaster', 'dancer'];
    await powerCase('Gremory sur place : ses auras (3 + 2) + 50 % de la sienne (2,5)', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(gremory, { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.09, 2);
    await powerCase('Gremory : aura du plus fort allié le plus fort compte (Danseur 8 : +4)', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(gremory, { at: 'rowe' }), Rouge3: P(dancer, { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]], 1.15, 2);
    await powerCase('Gremory voisine : portée de deux cases, pas de renfort', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(gremory, { at: r1 }) }, rouge, [['Rouge1', 'attack', 1]], 1.06, 2);
    await powerCase('Gremory à deux territoires : ses auras portent encore', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(gremory, { at: r2 }) }, rouge, [['Rouge1', 'attack', 1]], 1.06, 2);
    await powerCase('Gremory à trois territoires : trop loin', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(gremory, { at: ring3 }) }, rouge, [['Rouge1', 'attack', 1]], 1.0, 2);
    await powerCase('Un Moine seul ne porte pas à deux cases', { Rouge1: P(['soldier'], { at: 'rowe' }), Rouge2: P(['monk'], { at: r2 }) }, rouge, [['Rouge1', 'attack', 1]], 1.0, 2);
    const dk = ['soldier', 'cavalier', 'paladin', 'dark-knight'];
    const wins = (n) => withDb((d) => {
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const add = (att, def, ok) => d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, started_at, ends_at, resolved_at, success) VALUES (?, ?, ?, ?, 1, 2, 3, ?)').run(cid, 'duval', att, def, ok);
      for (let i = 0; i < n; i += 1) add('rouge', 'bleue', 1); // territoires pris
      for (let i = 0; i < 2; i += 1) add('serpents', 'rouge', 0); // défenses réussies
      add('rouge', 'bleue', 0); // attaque ratée : ne compte pas
      add('bleue', 'rouge', 1); // territoire perdu : ne compte pas
    });
    resetAll();
    applyPlayers({ Rouge1: P(dk, { at: 'rowe' }) });
    wins(3);
    insertBattle(rouge, [['Rouge1', 'attack', 1]]);
    let pb = (await clients.Rouge1('/map')).d.territories.find((t) => t.id === 'rowe').battle.power;
    check('Paladin noir : +1 % par territoire pris ou défense réussie (3 + 2 = +5 %, plus 3 % de l aura du Paladin)', near(pb.attack, 1.08), String(pb.attack));
    resetAll();
    applyPlayers({ Rouge1: P(dk, { at: 'rowe' }) });
    wins(300);
    insertBattle(rouge, [['Rouge1', 'attack', 1]]);
    pb = (await clients.Rouge1('/map')).d.territories.find((t) => t.id === 'rowe').battle.power;
    check('Paladin noir : plafonné à +50 % (302 victoires)', near(pb.attack, 1 + 0.5 + 0.03), String(pb.attack));
    resetAll();
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'rowe'"));
    applyPlayers({ Rouge1: P(dk, { at: 'arundel' }), Rouge2: P(['soldier'], { at: 'arundel' }) });
    const zero = () => withDb((d) => d.prepare('UPDATE player_state SET actions = 0, actions_at = ?').run(Date.now()));
    zero();
    insertBattle(rouge, [['Rouge2', 'attack', 1]]);
    let mvr = await clients.Rouge1('/move', { to: 'rowe' });
    check('Paladin noir : rejoint sans action la bataille de sa faction sur un territoire ennemi voisin', mvr.s === 200 && mvr.d.free === true && mvr.d.player.territory === 'rowe', JSON.stringify(mvr.d.error || mvr.d.free));
    withDb((d) => d.prepare("UPDATE player_state SET territory = 'arundel' WHERE user_id = ?").run(uidOf(d, 'Rouge1')));
    zero();
    mvr = await clients.Rouge1('/move', { to: 'rowe' });
    check('mais une seule fois par bataille', mvr.d.error === 'no_actions', JSON.stringify([mvr.s, mvr.d.error]));
    mvr = await clients.Rouge2('/move', { to: 'rowe' });
    check('un Soldat sans action ne peut pas', mvr.d.error === 'no_actions', JSON.stringify([mvr.s, mvr.d.error]));

    // ---------- 3. Fenêtre de repli
    console.log('# Fenêtre de repli');
    const retreat = () => withDb((d) => {
      const b = d.prepare('SELECT resolved_at FROM battles ORDER BY id DESC LIMIT 1').get();
      const s = d.prepare("SELECT retreat_until, retreat_penalty, status FROM player_state WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Bleu1')").get();
      return { window: s.retreat_until - b.resolved_at, penalty: s.retreat_penalty, status: s.status };
    });
    await resolveCase({ Rouge1: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]]);
    let r = retreat();
    check('sans effet : 6 tours pour se replier, aucune amende', r.window === 12000 && r.penalty === 0 && r.status === 'retreating', JSON.stringify(r));
    await resolveCase({ Rouge1: P(['fighter', 'archer'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]]);
    r = retreat();
    check('Archer vainqueur : la fenêtre des vaincus perd 1 tour (5)', r.window === 10000 && r.penalty === 0, JSON.stringify(r));
    await resolveCase({ Rouge1: P(['soldier'], { at: 'rowe' }), Bleu1: P(['fighter', 'archer'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1]]);
    r = retreat();
    check('Archer vaincu : sa propre fenêtre gagne 1 tour (7)', r.window === 14000 && r.penalty === 0, JSON.stringify(r));
    await resolveCase({ Rouge1: P(['fighter', 'archer', 'sniper'], { at: 'rowe' }), Bleu1: P(['fighter', 'archer'], { at: 'rowe', gold: 500 }) }, rouge, [['Rouge1', 'attack', 1]]);
    r = retreat();
    check('Archer d\'élite vainqueur d\'un Archer : 7 - 1 = 6 tours, amende de 150 or', r.window === 12000 && r.penalty === 150, JSON.stringify(r));
    await sleep(13000);
    await clients.Rouge1('/map');
    const fell = await me('Bleu1');
    check('sans repli à temps, le vaincu est puni sans être privé de jeu : capitale, 100 or plus 150 or amende, actions vidées, gains réduits', fell.player.status === 'alive' && fell.player.territory === 'blaiddyd' && fell.character.gold === 250 && fell.player.actions <= 1 && fell.player.rewardDebuff === 10, `${fell.player.status}, ${fell.character.gold} or, ${fell.player.actions} actions`);
    check('une fenêtre de repli écoulée est une mort comptée pour la campagne', row("SELECT deaths FROM campaign_scores WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Bleu1')")?.deaths === 1);
    check('et il est prévenu', (await clients.Bleu1('/notifications')).d.notifications.some((x) => x.type === 'fallen' && x.params.wounded === true && x.params.gold === 250));

    // ---------- 4. Fortifier : prix et efficacité
    console.log('# Fortification');
    resetAll();
    applyPlayers({ Rouge1: P(['monk', 'priest'], { at: 'hresvelg', gold: 1000 }), Rouge2: P(['monk', 'priest', 'bishop'], { at: 'hresvelg', gold: 1000 }), Rouge3: P(['soldier'], { at: 'hresvelg', gold: 1000 }) });
    const costs = (await clients.Rouge1('/map')).d.costs;
    check('Prêtre : Fortifier à moitié prix (150 or)', costs.fortify === 150 && costs.hire === 300, JSON.stringify(costs));
    check('un Soldat paie le plein tarif (300 or)', (await clients.Rouge3('/map')).d.costs.fortify === 300);
    await clients.Rouge1('/act', { action: 'hire' });
    await clients.Rouge2('/act', { action: 'hire' });
    await clients.Rouge3('/act', { action: 'hire' });
    const hires = withDb((d) => d.prepare("SELECT c.pseudo, k.power FROM contributions k JOIN characters c ON c.user_id = k.user_id WHERE k.kind = 'hire' ORDER BY c.pseudo").all());
    check('fortification : 1,5 pour un Prêtre ou un Soldat, 2,25 pour un Évêque (+50 %)', hires.map((h) => `${h.pseudo}:${h.power}`).join(' ') === 'Rouge1:1.5 Rouge2:2.25 Rouge3:1.5', hires.map((h) => `${h.pseudo}:${h.power}`).join(' '));
    check('Prêtre : 150 or débités, Évêque : 150 aussi (cumul), Soldat : 300', (await me('Rouge1')).character.gold === 850 && (await me('Rouge2')).character.gold === 850 && (await me('Rouge3')).character.gold === 700);

    // ---------- 5. Réserve d'actions et recharge
    console.log('# Réserve d\'actions');
    resetAll();
    applyPlayers({ Rouge2: P(['fighter', 'brigand', 'wyvern-rider']), Rouge3: P(['fighter', 'brigand', 'wyvern-rider', 'wyvern-knight']), Rouge4: P(['soldier']), Rouge5: P(['fighter', 'brigand', 'warrior', 'wyvern-knight']) });
    withDb((d) => { for (const n of ['Rouge2', 'Rouge3', 'Rouge4', 'Rouge5']) d.prepare('UPDATE player_state SET actions = 0, actions_at = ? WHERE user_id = ?').run(Date.now(), uidOf(d, n)); });
    await sleep(1700);
    const lim = {};
    for (const n of ['Rouge2', 'Rouge3', 'Rouge4', 'Rouge5']) lim[n] = (await me(n)).player;
    check('réserve : 8 (Soldat), 9 (Chevalier wyverne), 10 (Lord wyverne par lui), 9 (Lord wyverne par le Guerrier)',
      lim.Rouge4.maxActions === 8 && lim.Rouge2.maxActions === 9 && lim.Rouge3.maxActions === 10 && lim.Rouge5.maxActions === 9, JSON.stringify(Object.values(lim).map((p) => p.maxActions)));
    check('recharge : 8 min (1,6 s) et 7 min (1,4 s) contre 10 min (2 s)', lim.Rouge2.actions === 1 && lim.Rouge3.actions === 1 && lim.Rouge5.actions === 1 && lim.Rouge4.actions === 0,
      JSON.stringify(Object.values(lim).map((p) => p.actions)));

    // ---------- 6. Téléportation (Évêque noir)
    console.log('# Téléportation');
    resetAll();
    const bishop = ['monk', 'mage', 'dark-mage', 'dark-bishop'];
    applyPlayers({ Rouge1: P(['soldier'], { at: 'hresvelg', gold: 5000 }), Rouge5: P(bishop, { at: 'hresvelg', gold: 3000 }), Rouge6: P(bishop, { at: 'hresvelg', gold: 100 }) });
    let t = await clients.Rouge5('/teleport', { to: 'varley' });
    check('téléportation vers un territoire de sa faction : 500 or, aucune action', t.s === 200 && t.d.player.territory === 'varley' && t.d.character.gold === 2500 && t.d.player.actions === 6, JSON.stringify(t.d.error || [t.d.player?.territory, t.d.character?.gold, t.d.player?.actions]));
    check('récompenses réduites pendant 10 actions', t.d.player.rewardDebuff === 10);
    let g0 = (await me('Rouge5')).character.gold;
    await clients.Rouge5('/act', { action: 'gather' });
    const g1 = (await me('Rouge5')).character;
    check('une récolte rapporte moitié moins (20 au lieu de 40)', g1.gold === g0 + 20, `+${g1.gold - g0}`);
    check('une action de moins sur le compteur de l\'effet (9)', (await me('Rouge5')).player.rewardDebuff === 9);
    t = await clients.Rouge5('/teleport', { to: 'hresvelg' });
    check('se téléporter à nouveau renouvelle l\'effet sans l\'additionner (10)', t.s === 200 && t.d.player.rewardDebuff === 10, String(t.d.player?.rewardDebuff));
    t = await clients.Rouge5('/teleport', { to: 'dagda' });
    check('impossible vers un territoire hors de sa faction et de ses voisins', t.d.error === 'cannot_enter', t.d.error);
    t = await clients.Rouge1('/teleport', { to: 'varley' });
    check('impossible sans la classe', t.d.error === 'invalid_action', t.d.error);
    t = await clients.Rouge6('/teleport', { to: 'varley' });
    check('impossible sans 500 or', t.d.error === 'not_enough_gold', t.d.error);
    withDb((d) => d.prepare('UPDATE player_state SET reward_debuff = 1 WHERE user_id = ?').run(uidOf(d, 'Rouge5')));
    g0 = (await me('Rouge5')).character.gold;
    const ga = await clients.Rouge5('/act', { action: 'gather' });
    if (ga.s !== 200) console.log('gather 1', ga.s, JSON.stringify(ga.d));
    const g2 = (await me('Rouge5')).character.gold;
    const gb = await clients.Rouge5('/act', { action: 'gather' });
    if (gb.s !== 200) console.log('gather 2', gb.s, JSON.stringify(gb.d));
    const g3 = (await me('Rouge5')).character.gold;
    check('la 10e action est encore réduite (20), la suivante rapporte tout (40)', g2 - g0 === 20 && g3 - g2 === 40, `+${g2 - g0} puis +${g3 - g2}`);

    // ---------- 7. Lignée de classes : les effets se conservent, le Guerrier mène au Maître de guerre et au Lord wyverne
    console.log('# Lignée de classes');
    await restart(); // remet à zéro la limite de requêtes par minute
    resetAll();
    withDb((d) => d.prepare('UPDATE characters SET xp = ?, gold = 10000000 WHERE pseudo IN (\'Rouge1\', \'Rouge2\')').run(xpForLevel(40)));
    const pathOf = async (n) => (await me(n)).character.path.join('>');
    check('au départ, la lignée est la classe de base', (await pathOf('Rouge1')) === 'soldier', await pathOf('Rouge1'));
    for (const c of ['armored-knight', 'fortress-knight', 'great-knight']) await clients.Rouge1('/class', { class: c });
    check('Soldat → Chevalier blindé → Chevalier forteresse → Grand chevalier : la lignée garde tout', (await pathOf('Rouge1')) === 'soldier>armored-knight>fortress-knight>great-knight', await pathOf('Rouge1'));
    r = await clients.Rouge1('/class', { class: 'fighter' });
    check('revenir à une classe de base recommence la lignée', r.s === 200 && (await pathOf('Rouge1')) === 'fighter', await pathOf('Rouge1'));
    for (const c of ['brigand', 'warrior']) await clients.Rouge1('/class', { class: c });
    r = await clients.Rouge1('/class', { class: 'war-master' });
    check('le Guerrier évolue en Maître de guerre', r.s === 200 && (await pathOf('Rouge1')) === 'fighter>brigand>warrior>war-master', r.d.error || (await pathOf('Rouge1')));
    for (const c of ['fighter', 'brigand', 'warrior']) await clients.Rouge2('/class', { class: c });
    r = await clients.Rouge2('/class', { class: 'wyvern-knight' });
    check('le Guerrier évolue aussi en Lord wyverne (Wyvern Knight)', r.s === 200 && (await pathOf('Rouge2')) === 'fighter>brigand>warrior>wyvern-knight', r.d.error || (await pathOf('Rouge2')));
    check('et sa réserve passe à 9 actions', (await me('Rouge2')).player.maxActions === 9);
    r = await clients.Rouge1('/class', { class: 'wyvern-knight' });
    check('le Maître de guerre ne mène pas au Lord wyverne', r.d.error === 'class_path', r.d.error);

    // ---------- 8. Défense réussie : gains du Guerrier et du Chevalier sacré (les attaques échouent toujours)
    console.log('# Défense réussie');
    await restart({ TEST_ROLL: '0.999' });
    await resolveCase({ Bleu1: P(holy, { at: 'rowe' }), Bleu2: P(['fighter', 'brigand', 'warrior'], { at: 'rowe' }) },
      { attacker: 'serpents', defender: 'bleue', boss: 3 }, [['Bleu1', 'defense', 1], ['Bleu2', 'defense', 1]]);
    const hk = (await me('Bleu1')).character;
    const wr = (await me('Bleu2')).character;
    check('Chevalier sacré : 60 + 200 or et 25 + 80 de renommée en repoussant les Serpents', hk.gold === 260 && hk.xp === 105, `${hk.gold} or, ${hk.xp} xp`);
    check('Guerrier : +25 de renommée même en défense (le bonus du Brigand ne vaut que pour une conquête)', wr.gold === 60 && wr.xp === 50, `${wr.gold} or, ${wr.xp} xp`);
    check('les attaques des Serpents repoussées sont comptées', (await me('Bleu1')).stats.serpents_repelled === 1 && (await me('Bleu2')).stats.serpents_repelled === 1);

    // ---------- 8b. Contre-attaque : insaisissable et bonus d'attaque (les attaques échouent toujours ici)
    console.log('# Contre-attaque');
    await restart({ TEST_ROLL: '0.999' });
    const own = (id, f) => withDb((d) => d.prepare('UPDATE territories SET faction = ? WHERE id = ?').run(f, id));
    const untouchable = async (id) => (await clients.Rouge1('/map')).d.territories.find((x) => x.id === id).untouchableUntil;
    own('rowe', 'bleue'); own('arundel', 'rouge');
    await resolveCase({ Rouge1: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) }, rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]]);
    check('une attaque repoussée rend le territoire insaisissable', (await untouchable('rowe')) > Date.now(), String(await untouchable('rowe')));
    withDb((d) => d.exec("UPDATE player_state SET status = 'alive', retreat_until = NULL, fall_mult = 1"));
    let ar = await clients.Rouge1('/act', { action: 'attack' });
    check('on ne peut plus l\'attaquer', ar.s === 409 && ar.d.error === 'untouchable', JSON.stringify([ar.s, ar.d.error]));
    check('le territoire d\'à côté reste attaquable', (await untouchable('arundel')) === null);

    // Contre-attaque : la faction qui vient de défendre frappe plus fort sur le territoire ennemi voisin.
    const counterBattle = async (label, A) => {
      withDb((d) => d.exec("DELETE FROM battles WHERE resolved_at IS NULL"));
      applyPlayers({ Bleu1: P(['soldier'], { at: 'arundel' }) });
      insertBattle({ territory: 'arundel', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 1]]);
      const x = (await clients.Bleu1('/map')).d.territories.find((t) => t.id === 'arundel');
      check(label, x.battle && near(x.battle.power.attack, A), `${x.battle?.power.attack} (attendu ${A}), contre-attaque : ${x.battle?.counter}`);
      return x;
    };
    const cx = await counterBattle('contre-attaque : +25 % de puissance d\'attaque sur un territoire ennemi voisin', 1.25);
    check('la bataille et le territoire signalent la contre-attaque', cx.battle.counter === true && cx.counter === true);
    const away = (await clients.Rouge1('/map')).d.territories.find((t) => t.id === 'arundel');
    check('l\'autre faction ne reçoit pas le bonus', away.counter === false);
    // Fenêtre dépassée : plus de bonus ni d'insaisissable (4 h = 48 s avec des tours de 2 s).
    withDb((d) => d.prepare('UPDATE battles SET resolved_at = ? WHERE resolved_at IS NOT NULL AND territory = ?').run(Date.now() - 120_000, 'rowe'));
    check('au bout de 4 heures le territoire est de nouveau attaquable', (await untouchable('rowe')) === null);
    await counterBattle('et le bonus disparaît', 1.0);

    // Les attaques des Serpents ne comptent pas, ni les territoires de l'Église de Seiros.
    await resolveCase({ Bleu1: P(['soldier'], { at: 'rowe' }) }, { attacker: 'serpents', defender: 'bleue', boss: 3 }, [['Bleu1', 'defense', 1]]);
    check('repousser les Serpents ne rend pas insaisissable', (await untouchable('rowe')) === null);
    await resolveCase({ Rouge1: P(['soldier'], { at: 'rowe' }) }, { attacker: 'rouge', defender: 'eglise' }, [['Rouge1', 'attack', 1]]);
    check('l\'Église de Seiros qui repousse une attaque n\'en profite pas', (await untouchable('rowe')) === null);

    // ---------- 8c. Notes de mise à jour : pastille tant que la dernière n'est pas lue
    console.log('# Mises à jour');
    const patches = require(path.join(process.cwd(), 'public', 'config', 'game.json')).patches;
    const latest = patches[0].id;
    check('le patch le plus récent est annoncé au joueur', (await me('Rouge1')).patch.latest === latest);
    check('un nouveau compte n\'a pas de pastille', (await me('Rouge1')).patch.seen === latest);
    withDb((d) => d.exec('UPDATE users SET patch_seen = NULL'));
    check('un ancien compte qui n\'a rien lu en a une', (await me('Rouge1')).patch.seen === null);
    const pr = await clients.Rouge1('/patch/seen', {});
    check('lire la mise à jour fait disparaître la pastille', pr.s === 200 && pr.d.patch.seen === latest && (await me('Rouge1')).patch.seen === latest);
    check('sans toucher aux autres joueurs', (await me('Rouge2')).patch.seen === null);
    check('chaque patch a un texte français et anglais', patches.every((p) => p.title.fr && p.title.en && p.sections.every((s) => s.title.fr && s.title.en && s.items.every((i) => i.fr && i.en))));

    // ---------- 8d. Joueurs présents sur la carte, Loups de cendre cachés à Garreg-Mach
    console.log('# Joueurs présents');
    await restart({ TEST_ROLL: '0.999' });
    resetAll();
    withDb((d) => d.exec("UPDATE characters SET faction = 'violette' WHERE pseudo = 'Bleu2'"));
    applyPlayers({ Bleu2: P(['soldier'], { at: 'garreg-mach' }), Rouge2: P(['myrmidon'], { at: 'rowe', level: 3 }), Rouge3: P(['soldier'], { at: 'rowe', level: 9 }),
      Rouge4: P(['fighter'], { at: 'rowe' }), Bleu1: P(['monk'], { at: 'rowe' }), Rouge5: P(['soldier'], { at: 'rowe' }) });
    const terr = async (who, id) => (await clients[who]('/map')).d.territories.find((x) => x.id === id);
    let gm = await terr('Rouge1', 'garreg-mach');
    check('un Loup de cendre qui ne fait que passer par Garreg-Mach est invisible', gm.occupants.length === 0 && Object.keys(gm.players).length === 0, JSON.stringify(gm.occupants));
    gm = await terr('Bleu2', 'garreg-mach');
    check('mais il se voit lui-même', gm.occupants.length === 1 && gm.occupants[0].me === true && gm.players.violette === 1);
    insertBattle({ territory: 'garreg-mach', attacker: 'rouge', defender: 'violette' }, [['Bleu2', 'defense', 1]]);
    gm = await terr('Rouge1', 'garreg-mach');
    check('dès qu\'il défend Garreg-Mach il apparaît', gm.occupants.length === 1 && gm.occupants[0].pseudo === 'Bleu2' && gm.occupants[0].faction === 'violette', JSON.stringify(gm.occupants));
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    gm = await terr('Rouge1', 'garreg-mach');
    check('et redevient invisible quand la bataille est finie', gm.occupants.length === 0);
    withDb((d) => d.prepare("UPDATE player_state SET territory = 'rowe' WHERE user_id = ?").run(uidOf(d, 'Bleu2')));
    const rw = await terr('Rouge1', 'rowe');
    check('ailleurs qu\'à Garreg-Mach, les Loups sont visibles', rw.occupants.some((o) => o.pseudo === 'Bleu2' && o.faction === 'violette'));
    check('liste des présents : toi d\'abord, puis par renommée (6 joueurs)', rw.occupants.length === 6 && rw.occupants[0].me === true && rw.occupants[0].pseudo === 'Rouge1' ? false : rw.occupants.length === 6, rw.occupants.map((o) => `${o.pseudo}${o.me ? '*' : ''}:${o.level}`).join(' '));
    const viewerAtRowe = withDb((d) => d.prepare("UPDATE player_state SET territory = 'rowe' WHERE user_id = ?").run(uidOf(d, 'Rouge1')));
    const rw2 = await terr('Rouge1', 'rowe');
    check('7 joueurs sur le territoire, le joueur en tête, puis les plus renommés', rw2.occupants.length === 7 && rw2.occupants[0].me === true && rw2.occupants[0].pseudo === 'Rouge1' && rw2.occupants[1].pseudo === 'Rouge3',
      rw2.occupants.map((o) => `${o.pseudo}${o.me ? '*' : ''}:${o.level}`).join(' '));
    check('chaque présent porte sa faction, sa classe et son avatar', rw2.occupants.every((o) => o.faction && o.class && o.avatar && Number.isInteger(o.level)));
    check('les comptes par faction suivent', rw2.players.rouge === 5 && rw2.players.bleue === 1 && rw2.players.violette === 1, JSON.stringify(rw2.players));
    withDb((d) => d.exec("UPDATE characters SET faction = 'bleue' WHERE pseudo = 'Bleu2'"));

    // ---------- 8e. Les Loups de cendre défendent l'Église de Seiros à Garreg-Mach
    console.log('# Loups gardiens de Garreg-Mach');
    await restart({ TEST_ROLL: '0.999' });
    resetAll();
    withDb((d) => { d.exec("UPDATE characters SET faction = 'violette' WHERE pseudo = 'Bleu2'"); d.exec("UPDATE territories SET faction = 'eglise' WHERE id = 'garreg-mach'"); d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'rowe'"); });
    applyPlayers({ Rouge1: P(['soldier'], { at: 'garreg-mach', gold: 1000 }), Bleu2: P(['soldier'], { at: 'garreg-mach', gold: 1000 }) });
    let gr = await clients.Bleu2('/act', { action: 'defend' });
    check('sans attaque, les Loups ne défendent pas le territoire de l\'Église', gr.s === 409, JSON.stringify(gr.d.error));
    gr = await clients.Bleu2('/act', { action: 'attack' });
    check('et ils n\'attaquent pas leur propre refuge', gr.s === 409, JSON.stringify(gr.d.error));
    gr = await clients.Rouge1('/act', { action: 'attack' });
    check('une faction attaque Garreg-Mach', gr.s === 200, JSON.stringify(gr.d.error));
    gr = await clients.Bleu2('/act', { action: 'defend' });
    check('les Loups défendent l\'Église comme leur territoire', gr.s === 200, JSON.stringify(gr.d.error));
    gr = await clients.Bleu2('/act', { action: 'hire' });
    check('et peuvent la fortifier', gr.s === 200, JSON.stringify(gr.d.error));
    const gmb = (await clients.Rouge1('/map')).d.territories.find((x) => x.id === 'garreg-mach').battle;
    check('la bataille compte les Loups parmi les défenseurs', gmb.defenders === 1 && gmb.power.defense > 2, JSON.stringify([gmb.defenders, gmb.power]));
    check('les Loups ont été prévenus de l\'attaque', (await clients.Bleu2('/notifications')).d.notifications.some((x) => x.type === 'territory_attacked'));
    await sleep(13500);
    await clients.Rouge1('/map');
    const credit = row("SELECT credit, success FROM battles WHERE territory = 'garreg-mach' ORDER BY id DESC LIMIT 1");
    check('l\'attaque est repoussée et la défense est créditée aux Loups', credit.success === 0 && credit.credit === 'violette', JSON.stringify(credit));
    const mapW = (await clients.Bleu2('/map')).d;
    check('Garreg-Mach devient insaisissable', mapW.territories.find((x) => x.id === 'garreg-mach').untouchableUntil > Date.now());
    withDb((d) => d.exec("UPDATE player_state SET status = 'alive', retreat_until = NULL, fall_mult = 1"));
    gr = await clients.Rouge1('/act', { action: 'attack' });
    check('on ne peut plus l\'attaquer', gr.d.error === 'untouchable', JSON.stringify(gr.d.error));
    const wolfRowe = mapW.territories.find((x) => x.id === 'rowe');
    check('contre-attaque des Loups sur les territoires ennemis voisins, à 40 %', wolfRowe.counter === true && wolfRowe.counterPct === 40, JSON.stringify([wolfRowe.counter, wolfRowe.counterPct]));
    const rowe2 = (await clients.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe');
    check('les autres factions n\'en profitent pas', rowe2.counter === false && rowe2.counterPct === 25);
    withDb((d) => d.exec('DELETE FROM contributions'));
    applyPlayers({ Bleu2: P(['soldier'], { at: 'rowe' }) });
    insertBattle({ territory: 'rowe', attacker: 'violette', defender: 'bleue' }, [['Bleu2', 'attack', 1]]);
    const wolfPow = (await clients.Bleu2('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('un Loup qui contre-attaque a +40 % de puissance d\'attaque', wolfPow.counter === true && near(wolfPow.power.attack, 1.4), JSON.stringify(wolfPow.power));
    // Sans Loup parmi les défenseurs, l'Église ne donne rien à personne.
    resetAll();
    withDb((d) => { d.exec('DELETE FROM battles'); });
    applyPlayers({ Rouge1: P(['soldier'], { at: 'garreg-mach' }) });
    insertBattle({ territory: 'garreg-mach', attacker: 'rouge', defender: 'eglise' }, [['Rouge1', 'attack', 1]], 1200);
    await sleep(3300);
    const gmEnd = (await clients.Rouge1('/map')).d.territories.find((x) => x.id === 'garreg-mach');
    check('l\'Église seule qui repousse une attaque n\'est pas insaisissable', gmEnd.untouchableUntil === null);
    withDb((d) => d.exec("UPDATE characters SET faction = 'bleue' WHERE pseudo = 'Bleu2'"));

    // ---------- 8f. Avatars : libres, boutique, missions spéciales
    console.log('# Avatars et missions spéciales');
    await restart({ TEST_ROLL: '0' });
    resetAll();
    const AV = require(path.join(process.cwd(), 'public', 'config', 'game.json')).avatars;
    const avs = async (who) => (await clients[who]('/avatars')).d.avatars;
    const list = await avs('Rouge1');
    check('51 avatars proposés : 8 libres, 26 en boutique, 17 à gagner', list.length === 51 && list.filter((a) => a.unlock === 'free').length === 8
      && list.filter((a) => a.unlock === 'gold').length === 26 && list.filter((a) => a.unlock === 'mission').length === 17, JSON.stringify([list.length]));
    check('les libres dans l\'ordre voulu (1, 25, 23, 4, 3, 5, 8, 2)', list.filter((a) => a.unlock === 'free').map((a) => a.file).join() === AV.free.join()
      && AV.free.join() === [1, 25, 23, 4, 3, 5, 8, 2].map((n) => `avatar_${n}.webp`).join());
    const price = (n) => list.find((a) => a.file === `avatar_${n}.webp`)?.price;
    check('prix : 400, 1 200, 3 000 et 20 000 or', price(20) === 400 && price(33) === 400 && price(13) === 1200 && price(34) === 1200 && price(7) === 3000 && price(24) === 3000 && price(37) === 20000 && price(38) === 20000);
    check('35 (Renommée 1) et 36 (Dernier rempart) sont des récompenses', ['avatar_35.webp', 'avatar_36.webp'].every((f) => list.find((a) => a.file === f)?.unlock === 'mission'));
    check('les images sont du WebP présent dans le dossier', list.every((a) => fs.existsSync(path.join(process.cwd(), 'public', 'assets', 'avatars', a.file))));
    const fresh = client();
    await fresh('/register', { email: 'neuf@example.test', password: 'mot-de-passe-neuf', passwordConfirm: 'mot-de-passe-neuf' });
    let cr = await fresh('/character', { pseudo: 'Neuf', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_20.webp', faction: 'rouge' });
    check('à la création, un avatar payant est refusé', cr.s === 400, JSON.stringify(cr.d.error));
    cr = await fresh('/character', { pseudo: 'Neuf', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_25.webp', faction: 'rouge' });
    check('et un avatar libre accepté', cr.s === 201, JSON.stringify(cr.d.error));
    withDb((d) => d.exec("UPDATE characters SET gold = 500 WHERE pseudo = 'Rouge7'"));
    withDb((d) => { const u = uidOf(d, 'Rouge7'); d.prepare('DELETE FROM player_events WHERE user_id = ?').run(u); d.prepare('DELETE FROM unlocked_avatars WHERE user_id = ?').run(u); });
    let buy = await clients.Rouge7('/avatar/buy', { avatar: 'avatar_20.webp' });
    check('acheter un avatar à 400 or', buy.s === 200 && buy.d.character.avatar === 'avatar_20.webp' && buy.d.character.gold === 100, JSON.stringify(buy.d.error || buy.d.character?.gold));
    check('l\'or dépensé est compté (400)', (await me('Rouge7')).stats.gold_spent === 400);
    buy = await clients.Rouge7('/avatar/buy', { avatar: 'avatar_21.webp' });
    check('sans assez d\'or, l\'achat échoue', buy.d.error === 'not_enough_gold');
    const sp = (await clients.Rouge7('/missions')).d.specials;
    check('15 missions spéciales listées avec leur progression', sp.length === 15 && sp.every((m) => m.avatar && m.title.fr && m.title.en && m.description.fr && m.description.en && m.target >= 1 && m.done === false), JSON.stringify(sp.filter((m) => m.done || !m.avatar || !m.title?.fr).map((m) => [m.id, m.done])));
    check('dépenser de l\'or avance « Grand dépensier »', sp.find((m) => m.id === 'gold-12000').current === 400 && sp.find((m) => m.id === 'gold-12000').target === 12000);

    const setStats = (who, o) => withDb((d) => { for (const [k, v] of Object.entries(o)) d.prepare("INSERT INTO player_events (user_id, event, count) VALUES (?, ?, ?) ON CONFLICT (user_id, event) DO UPDATE SET count = excluded.count").run(uidOf(d, who), k, v); });
    const owned = async (who, n) => !!(await avs(who)).find((a) => a.file === `avatar_${n}.webp`)?.owned;
    const own2 = (id, f) => withDb((d) => d.prepare('UPDATE territories SET faction = ? WHERE id = ?').run(f, id));
    own2('rowe', 'bleue'); own2('varley', 'rouge'); own2('arundel', 'rouge');
    applyPlayers({ Rouge2: P(['soldier'], { at: 'varley' }), Rouge3: P(['soldier'], { at: 'arundel' }), Rouge4: P(['soldier'], { at: 'rowe', gold: 1000 }) });
    setStats('Rouge2', { gather: 99 });
    check('avant le 100e, pas d\'avatar', (await owned('Rouge2', 47)) === false);
    await clients.Rouge2('/act', { action: 'gather' });
    check('récolter 100 fois débloque l\'avatar 47', await owned('Rouge2', 47));
    check('et prévient le joueur', (await clients.Rouge2('/notifications')).d.notifications.some((x) => x.type === 'avatar_unlocked' && x.params.avatar === 'avatar_47.webp'));
    setStats('Rouge3', { enemy_move: 69 });
    await clients.Rouge3('/move', { to: 'rowe' });
    check('se déplacer 70 fois chez l\'ennemi débloque l\'avatar 44', (await me('Rouge3')).stats.enemy_move === 70 && await owned('Rouge3', 44));
    await clients.Rouge3('/move', { to: 'arundel' });
    check('rentrer chez soi ne compte pas', (await me('Rouge3')).stats.enemy_move === 70);
    insertBattle(rouge, [['Rouge4', 'attack', 1]]);
    setStats('Rouge4', { battalion: 79 });
    const hb = await clients.Rouge4('/act', { action: 'hire' });
    check('engager un bataillon 80 fois débloque l\'avatar 48', hb.s === 200 && await owned('Rouge4', 48), JSON.stringify(hb.d.error));
    check('et dépense 300 or comptés', (await me('Rouge4')).stats.gold_spent === 300);
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    // Attaque réussie en solo + série de victoires
    resetAll();
    own2('rowe', 'bleue');
    applyPlayers({ Rouge5: P(['soldier'], { at: 'rowe' }), Rouge6: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) });
    setStats('Rouge5', { solo_attacks: 19, atk_streak: 9, best_atk_streak: 9 });
    setStats('Bleu1', { def_streak: 6 });
    insertBattle(rouge, [['Rouge5', 'attack', 1], ['Bleu1', 'defense', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    let st5 = (await me('Rouge5')).stats;
    check('20 attaques réussies en solo : avatar 45', st5.solo_attacks === 20 && await owned('Rouge5', 45), JSON.stringify(st5));
    check('10 attaques de suite : avatar 50', st5.atk_streak === 10 && st5.best_atk_streak === 10 && await owned('Rouge5', 50));
    check('un territoire perdu remet à zéro la série de défense', (await me('Bleu1')).stats.def_streak === 0);
    // Attaque à plusieurs : pas de « solo »
    own2('rowe', 'bleue');
    applyPlayers({ Rouge5: P(['soldier'], { at: 'rowe' }), Rouge6: P(['soldier'], { at: 'rowe' }) });
    insertBattle(rouge, [['Rouge5', 'attack', 1], ['Rouge6', 'attack', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    check('à deux attaquants, ce n\'est pas une attaque en solo', (await me('Rouge6')).stats.solo_attacks === undefined && (await me('Rouge5')).stats.solo_attacks === 20);
    // Défense réussie en solo, série et Serpents (les attaques échouent)
    await restart({ TEST_ROLL: '0.999' });
    resetAll();
    own2('rowe', 'bleue');
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe' }), Bleu1: P(['soldier'], { at: 'rowe' }) });
    setStats('Bleu1', { solo_defenses: 19, def_streak: 9, best_def_streak: 9 });
    setStats('Rouge1', { atk_streak: 5 });
    insertBattle(rouge, [['Rouge1', 'attack', 1], ['Bleu1', 'defense', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    const sb = (await me('Bleu1')).stats;
    check('20 défenses réussies en solo : avatar 46', sb.solo_defenses === 20 && await owned('Bleu1', 46), JSON.stringify(sb));
    check('10 défenses de suite : avatar 49', sb.def_streak === 10 && await owned('Bleu1', 49));
    check('une attaque repoussée remet à zéro la série d\'attaques', (await me('Rouge1')).stats.atk_streak === 0);
    withDb((d) => d.exec('DELETE FROM contributions'));
    own2('rowe', 'bleue');
    applyPlayers({ Bleu2: P(['soldier'], { at: 'rowe' }) });
    setStats('Bleu2', { serpents_repelled: 99 });
    insertBattle({ attacker: 'serpents', defender: 'bleue', boss: 3 }, [['Bleu2', 'defense', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    check('100 attaques des Serpents repoussées : avatar 12', (await me('Bleu2')).stats.serpents_repelled === 100 && await owned('Bleu2', 12));

    // Fin de campagne par conquête : victoire, conquête totale, MVP, podium, campagne sans mort
    await restart();
    resetAll();
    const mainIds = (await clients.Rouge1('/map')).d.territories.filter((x) => !x.annex).map((x) => x.id);
    withDb((d) => {
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const sc = (n, score, deaths) => d.prepare('INSERT OR REPLACE INTO campaign_scores (campaign_id, user_id, score, deaths) VALUES (?, ?, ?, ?)').run(cid, uidOf(d, n), score, deaths);
      sc('Rouge1', 500, 0); sc('Rouge2', 200, 0); sc('Rouge3', 100, 0); sc('Rouge4', 50, 1); sc('Bleu1', 300, 0);
    });
    withDb((d) => d.exec(`UPDATE territories SET faction = 'rouge' WHERE id IN (${mainIds.map((x) => `'${x}'`).join(',')})`));
    await clients.Rouge1('/map');
    await sleep(500);
    const s1 = (await me('Rouge1')).stats;
    check('victoire par conquête totale : campagne gagnée et conquête totale', s1.campaigns_won === 1 && s1.campaigns_conquest === 1, JSON.stringify(s1));
    check('MVP de la faction gagnante : le meilleur score seulement', s1.campaigns_mvp === 1 && (await me('Rouge2')).stats.campaigns_mvp === undefined);
    check('podium : les trois meilleurs scores', s1.campaigns_top3 === 1 && (await me('Bleu1')).stats.campaigns_top3 === 1 && (await me('Rouge2')).stats.campaigns_top3 === 1 && (await me('Rouge3')).stats.campaigns_top3 === undefined);
    check('campagne sans mort : seulement ceux qui n\'en ont subi aucune', s1.campaigns_flawless === 1 && (await me('Rouge4')).stats.campaigns_flawless === undefined && (await me('Bleu1')).stats.campaigns_flawless === 1);
    check('l\'autre faction ne gagne rien', (await me('Bleu1')).stats.campaigns_won === undefined);
    check('avatars 39, 40, 41, 43 débloqués pour le champion', (await owned('Rouge1', 39)) && (await owned('Rouge1', 40)) && (await owned('Rouge1', 41)) && (await owned('Rouge1', 43)));
    check('un simple participant gagne 39 et 40 (même faction) mais pas le MVP', (await owned('Rouge3', 39)) && (await owned('Rouge3', 40)) && !(await owned('Rouge3', 41)));

    // Migration des anciens avatars provisoires : avatar libre et remboursement de l'achat
    withDb((d) => {
      d.prepare("UPDATE characters SET avatar = 'avatar-03.svg', gold = 0 WHERE pseudo = 'Bleu2'").run();
      d.prepare("INSERT INTO unlocked_avatars (user_id, avatar, source, created_at) VALUES (?, 'shop-02.svg', 'gold', 'x')").run(uidOf(d, 'Bleu2'));
    });
    await restart();
    const mg = (await me('Bleu2')).character;
    check('un ancien avatar est remplacé par un avatar libre', mg.avatar === AV.free[2], mg.avatar);
    check('un ancien achat est remboursé (600 or)', mg.gold === 600 && row("SELECT count(*) AS n FROM unlocked_avatars WHERE avatar = 'shop-02.svg'").n === 0, String(mg.gold));

    // ---------- 9. Déplacements gratuits : tirage fixé à 29 %, puis 84 %
    console.log('# Déplacements gratuits');
    const moves = async (env) => {
      await restart(env);
      resetAll();
      applyPlayers({ Rouge1: P(['soldier'], { at: 'hresvelg' }), Rouge2: P(['soldier', 'pegasus-knight'], { at: 'hresvelg' }),
        Rouge3: P(['soldier', 'pegasus-knight', 'falcon-knight'], { at: 'hresvelg' }), Rouge4: P(['fighter', 'brigand', 'wyvern-rider', 'falcon-knight'], { at: 'hresvelg' }) });
      withDb((d) => d.exec('UPDATE player_state SET actions = 5 WHERE actions = 6'));
      const out = {};
      for (const n of ['Rouge1', 'Rouge2', 'Rouge3', 'Rouge4']) { const x = await clients[n]('/move', { to: 'varley' }); out[n] = x.d.free ? 'gratuit' : 'payant'; }
      return out;
    };
    let mv = await moves({ TEST_MOVE_ROLL: '0.29' });
    check('tirage à 29 % : Chevalier pégase (30 %) et Chevalier faucon (50 %) se déplacent gratuitement, pas le Soldat',
      mv.Rouge1 === 'payant' && mv.Rouge2 === 'gratuit' && mv.Rouge4 === 'gratuit', JSON.stringify(mv));
    mv = await moves({ TEST_MOVE_ROLL: '0.84' });
    check('tirage à 84 % : seul le Chevalier faucon qui a le Chevalier pégase (30 + 50 + 5 = 85 %) est gratuit',
      mv.Rouge2 === 'payant' && mv.Rouge3 === 'gratuit' && mv.Rouge4 === 'payant', JSON.stringify(mv));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
