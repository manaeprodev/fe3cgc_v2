// Teste les effets de classe : puissance en bataille, gains, replis, actions, téléportation, lignée de classes.
// Chaque cas fabrique l'état voulu directement dans la base (joueurs, présence, bataille), puis lit le résultat du serveur.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3117;
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


const ROSTER = require(path.join(process.cwd(), 'public', 'config', 'game.json')).generals.roster;
// Remet les généraux à leur poste (vivants, sur leur territoire d'origine, dans leur faction d'origine) et efface leurs batailles.
function resetGen() {
  withDb((d) => {
    d.exec('DELETE FROM general_contribs; DELETE FROM general_verdicts');
    const up = d.prepare("UPDATE generals SET status = 'alive', territory = ?, faction = ?, spared = 0, actions = 4, actions_at = ?, move_turn = -1 WHERE gid = ?");
    for (const g of ROSTER) up.run(g.home, g.faction, Date.now(), g.id);
    d.exec("DELETE FROM campaign_meta WHERE key IN ('conquest', 'serpents_gone') OR key LIKE 'epi:%'");
    d.exec('UPDATE player_state SET fall_mult = 1');
  });
}
const gen = (gid) => row('SELECT * FROM generals WHERE gid = ?', gid);
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const noteTypes = async (n) => (await clients[n]('/notifications')).d.notifications.map((x) => x.type);

(async () => {
  try {
    await start({ GEN_ATTACK_CHANCE: '0' });
    await createAll();

    // ---------- 1. Réserve d'actions : 8
    console.log('# Actions');
    let m = await me('Rouge1');
    check('un nouveau joueur a 8 actions, pour 8 au maximum', m.player.actions === 8 && m.player.maxActions === 8, JSON.stringify([m.player.actions, m.player.maxActions]));

    // ---------- 2. Généraux sur la carte
    console.log('# Généraux sur la carte');
    resetAll();
    let map = (await clients.Rouge1('/map')).d;
    const names = (id) => terrOf(map, id).occupants.map((o) => o.pseudo).sort().join(',');
    check('Hresvelg : Edelgard, Hubert, Dorothea et Manuela', names('hresvelg') === 'Dorothea,Edelgard,Hubert,Manuela', names('hresvelg'));
    check('Blaiddyd : Dimitri et Dedue', names('blaiddyd') === 'Dedue,Dimitri', names('blaiddyd'));
    check('Phlegethon : Ignatz et Raphael', names('phlegethon') === 'Ignatz,Raphael', names('phlegethon'));
    check('les indépendants tiennent leur territoire (Petra à Brigid, Nader et Shadid à Almyra)', names('brigid') === 'Petra' && names('almyra') === 'Nader,Shadid', names('brigid') + ' / ' + names('almyra'));
    const ed = terrOf(map, 'hresvelg').occupants.find((o) => o.pseudo === 'Edelgard');
    check('un général porte sa faction, sa classe finale, son niveau et son portrait',
      ed.general === true && ed.faction === 'rouge' && ed.class === 'emperor' && ed.level >= 1 && ed.avatar === 'assets/characters/black_eagles/edelgard.webp', JSON.stringify(ed));
    check('les Loups de cendre sont cachés à Garreg-Mach', terrOf(map, 'garreg-mach').occupants.length === 0, names('garreg-mach'));
    check('les Serpents attendent hors carte', !map.territories.some((t) => t.occupants.some((o) => ['Cornelia', 'Epimenides'].includes(o.pseudo))));
    check('la présence compte les généraux dans leur faction', terrOf(map, 'blaiddyd').players.bleue === 2, JSON.stringify(terrOf(map, 'blaiddyd').players));

    // ---------- 3. Niveau : moyenne des joueurs de la faction, selon le coefficient
    console.log('# Niveau des généraux');
    const rouges = ['Rouge1', 'Rouge2', 'Rouge3', 'Rouge4', 'Rouge5', 'Rouge6', 'Rouge7'];
    resetAll();
    applyPlayers(Object.fromEntries(rouges.map((n) => [n, P(['soldier'], { level: 10 })])));
    await restart({ GEN_ATTACK_CHANCE: '0' });
    map = (await clients.Rouge1('/map')).d;
    const lv = (pseudo) => terrOf(map, 'hresvelg').occupants.find((o) => o.pseudo === pseudo).level;
    check('moyenne 10 : coef 2 → 10, coef 1 → 8 (7,5 arrondi), coef 0,5 → 6', lv('Edelgard') === 10 && lv('Hubert') === 8 && lv('Dorothea') === 6, [lv('Edelgard'), lv('Hubert'), lv('Dorothea')].join('/'));
    check('un indépendant suit la moyenne de tous les joueurs (coef 2 : ×1)', (() => { const l = terrOf(map, 'brigid').occupants[0].level; return l >= 1 && l <= 10; })());
    const annette = terrOf(map, 'dominic').occupants.find((o) => o.pseudo === 'Annette');
    check('equilibrage : les Lions (mediane 0) sont en retard sur la moyenne (5) : leurs generaux sont releves de 70 % de l ecart, Annette (coef 2) niveau 4', annette && annette.level === 4, String(annette?.level));

    // ---------- 4. Défense du territoire d'origine, vaincus, épargnés
    console.log('# Défense, verdict');
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe', gold: 0 }), Rouge2: P(['soldier'], { at: 'varley' }) });
    insertBattle({ territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1500);
    map = (await clients.Rouge1('/map')).d;
    const ashe = row("SELECT * FROM general_contribs WHERE gid = 'ashe'");
    check('Ashe défend Rowe, son territoire d\'origine, dès qu\'il est attaqué', ashe && ashe.side === 'defense' && ashe.power > 1, JSON.stringify(ashe));
    check('la bataille compte un défenseur de plus', terrOf(map, 'rowe').battle.defenders === 1, JSON.stringify(terrOf(map, 'rowe').battle));
    check('il a dépensé une de ses 4 actions', gen('ashe').actions === 3, String(gen('ashe').actions));
    await sleep(3300);
    await clients.Rouge1('/map');
    check('l\'attaque réussit, Ashe est vaincu : épargnable par les Aigles de jais, il attend le verdict', gen('ashe').status === 'captive' && row('SELECT * FROM general_verdicts WHERE gid = ?', 'ashe')?.winner === 'rouge');
    map = (await clients.Rouge1('/map')).d;
    check('les vainqueurs voient le verdict, pas les autres', map.verdicts.length === 1 && map.verdicts[0].id === 'ashe' && (await clients.Rouge2('/map')).d.verdicts.length === 0, JSON.stringify(map.verdicts));
    check('le captif a quitté la carte', !terrOf(map, 'rowe').occupants.some((o) => o.pseudo === 'Ashe'));
    const g1 = (await me('Rouge1')).character;
    check('récompense : or et renommée en plus (coef 1 → 120 or, 50 xp) en plus de la conquête (150 or, 60 xp)', g1.gold === 270 && g1.xp === 110, JSON.stringify([g1.gold, g1.xp]));
    check('notification de la victoire sur le général et du verdict', (await noteTypes('Rouge1')).includes('general_defeated') && (await noteTypes('Rouge1')).includes('general_verdict'));
    let v = await clients.Rouge2('/general/verdict', { general: 'ashe', spare: true });
    check('un joueur qui n\'a pas combattu ne peut pas trancher', v.s === 409, JSON.stringify(v.d.error));
    v = await clients.Rouge1('/general/verdict', { general: 'ashe', spare: true });
    check('épargné, Ashe rejoint les Aigles de jais', v.s === 200 && gen('ashe').faction === 'rouge' && gen('ashe').status === 'alive' && gen('ashe').spared === 1 && !row('SELECT 1 FROM general_verdicts'), JSON.stringify(gen('ashe')));
    map = (await clients.Rouge1('/map')).d;
    check('il reste sur son territoire d\'origine, conquis, dans sa nouvelle faction', terrOf(map, 'rowe').occupants.some((o) => o.pseudo === 'Ashe' && o.faction === 'rouge'));
    // Il aime toujours son territoire : attaqué par les Lions, il le défend pour les Aigles ; vaincu une seconde fois, il meurt.
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs'));
    applyPlayers({ Bleu1: P(['soldier'], { at: 'rowe' }) });
    insertBattle({ territory: 'rowe', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    check('épargné, Ashe défend quand même Rowe', row("SELECT * FROM general_contribs WHERE gid = 'ashe'")?.side === 'defense');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('vaincu une deuxième fois, il meurt (pas de nouveau verdict)', gen('ashe').status === 'dead' && !row('SELECT 1 FROM general_verdicts'));
    check('les vainqueurs de ce second combat sont récompensés', (await noteTypes('Bleu1')).includes('general_defeated'));

    // Non épargnable : Felix et Rodrigue (Fraldarius) meurent sur-le-champ.
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'fraldarius', gold: 0 }) });
    insertBattle({ territory: 'fraldarius', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    check('Felix et Rodrigue défendent Fraldarius', row("SELECT count(*) AS n FROM general_contribs").n === 2);
    await sleep(3300);
    await clients.Rouge1('/map');
    check('ni l\'un ni l\'autre ne peut être épargné : tous deux meurent', gen('felix').status === 'dead' && gen('rodrigue').status === 'dead' && !row('SELECT 1 FROM general_verdicts'));
    const g2 = (await me('Rouge1')).character;
    check('récompense cumulée : Felix coef 2 (240 or), Rodrigue coef 1 (120 or), plus la conquête (150)', g2.gold === 510, String(g2.gold));
    map = (await clients.Rouge1('/map')).d;
    check('ils sont effacés de la carte', !terrOf(map, 'fraldarius').occupants.some((o) => ['Felix', 'Rodrigue'].includes(o.pseudo)));
    check('le journal garde la trace', (await clients.Rouge1('/journal')).d.events.some((e) => e.type === 'general_fell' && e.params.general === 'felix'));

    // Épargnable seulement par certaines factions : Ignatz (Cerfs d'or) ne l'est que par les Aigles de jais.
    resetAll(); resetGen();
    applyPlayers({ Bleu1: P(['soldier'], { at: 'phlegethon' }) });
    insertBattle({ territory: 'phlegethon', attacker: 'bleue', defender: 'jaune' }, [['Bleu1', 'attack', 1]], 1500);
    await clients.Bleu1('/map');
    await sleep(3300);
    await clients.Bleu1('/map');
    check('Ignatz battu par les Lions de saphir : pas épargnable, il meurt', gen('ignatz').status === 'dead');
    check('Raphael (épargnable par les Lions) attend le verdict', gen('raphael').status === 'captive' && (await clients.Bleu1('/map')).d.verdicts.some((x) => x.id === 'raphael'));
    // Verdict : le faire mourir.
    v = await clients.Bleu1('/general/verdict', { general: 'raphael', spare: false });
    check('« faire mourir » : le général est effacé', v.s === 200 && gen('raphael').status === 'dead');

    // Verdict laissé sans réponse : il meurt à l'échéance (6 tours).
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'elidure' }) });
    insertBattle({ territory: 'elidure', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Mercedes attend le verdict des Aigles', gen('mercedes').status === 'captive');
    await sleep(13000);
    await clients.Rouge1('/map');
    check('sans réponse, elle meurt à l\'échéance', gen('mercedes').status === 'dead');

    // Un général indépendant défend son territoire neutre, et peut être épargné par qui l'a battu.
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'brigid' }) });
    insertBattle({ territory: 'brigid', attacker: 'rouge', defender: null }, [['Rouge1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    check('Petra défend Brigid, territoire neutre', row("SELECT * FROM general_contribs WHERE gid = 'petra'")?.side === 'defense');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Petra, épargnable par les Aigles, attend leur verdict', gen('petra').status === 'captive');
    v = await clients.Rouge1('/general/verdict', { general: 'petra', spare: true });
    check('épargnée, elle rejoint les Aigles de jais', gen('petra').faction === 'rouge' && gen('petra').spared === 1);

    // La défense réussie d'un général : il survit, sans verdict.
    await restart({ GEN_ATTACK_CHANCE: '0', TEST_ROLL: '0.999' });
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'hresvelg' }) });
    insertBattle({ territory: 'dominic', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Annette repousse l\'attaque : elle reste en vie', gen('annette').status === 'alive' && row("SELECT success FROM battles WHERE territory = 'dominic'").success === 0);

    // ---------- 5. Attaque ratée : repli, chute, retour plus cher
    console.log('# Attaque ratée');
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe', gold: 1000 }), Rouge2: P(['soldier'], { at: 'varley', gold: 1000 }), Rouge3: P(['soldier'], { level: 5, at: 'varley' }) });
    insertBattle({ territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    let st = (await me('Rouge1')).player;
    check('une attaque ratée : l\'attaquant resté sur place doit se replier', st.status === 'retreating' && !!st.retreatUntil, JSON.stringify(st));
    check('prévenu par une notification', (await noteTypes('Rouge1')).includes('must_retreat'));
    check('un allié absent du champ de bataille n\'est pas touché', (await me('Rouge2')).player.status === 'alive');
    let r = await clients.Rouge1('/retreat', { to: 'varley' });
    check('il se replie à temps : en vie, sans amende', r.d.player?.status === 'alive' && r.d.player.territory === 'varley' && r.d.character.gold === 1000, JSON.stringify(r.d.player));
    check('et son retour ne coûte plus rien de plus', row('SELECT fall_mult FROM player_state WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = ?)', 'Rouge1').fall_mult === 1);

    // Sans repli : il tombe, et le retour coûte le double (200 or au lieu de 100).
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe', gold: 150 }), Rouge2: P(['soldier'], { at: 'varley', gold: 1000 }), Rouge3: P(['soldier'], { level: 5, at: 'varley' }) });
    insertBattle({ territory: 'rowe', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]], 1200);
    await sleep(3300);
    await clients.Rouge1('/map');
    await sleep(12500);
    await clients.Rouge1('/map');
    st = (await me('Rouge1')).player;
    check('fenêtre de repli écoulée : puni sans être privé de jeu (capitale, 150 or perdus, actions vidées, gains réduits)',
      st.status === 'alive' && st.territory === 'hresvelg' && st.actions <= 1 && st.rewardDebuff === 10 && (await me('Rouge1')).character.gold === 0, JSON.stringify(st));
    withDb((d) => d.exec("UPDATE player_state SET status = 'dead', fall_mult = 2 WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Rouge1')"));
    withDb((d) => d.exec("UPDATE characters SET gold = 150 WHERE pseudo = 'Rouge1'"));
    check('la chute compte pour la campagne', row("SELECT deaths FROM campaign_scores WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Rouge1')")?.deaths === 1);
    map = (await clients.Rouge1('/map')).d;
    check('retour affiché : 200 or (deux fois le prix d\'un défenseur)', map.costs.revive === 200, String(map.costs.revive));
    r = await clients.Rouge1('/revive', { mode: 'gold' });
    check('150 or ne suffisent pas', r.s === 409 && r.d.error === 'not_enough_gold', JSON.stringify(r.d.error));
    r = await clients.Rouge1('/revive', { mode: 'ask' });
    map = (await clients.Rouge2('/map')).d;
    check('un allié voit la demande au tarif double', map.fallen.length === 1 && map.fallen[0].cost === 200, JSON.stringify(map.fallen));
    r = await clients.Rouge2('/revive/pay', { id: map.fallen[0].id });
    check('l\'allié paie 200 or et le ramène', r.s === 200 && r.d.character.gold === 800 && (await me('Rouge1')).player.status === 'alive', JSON.stringify([r.s, r.d.character?.gold]));
    // Par la renommée : deux fois le coût d'un niveau.
    withDb((d) => d.exec("UPDATE player_state SET status = 'dead', fall_mult = 2 WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Rouge3')"));
    const before = (await me('Rouge3')).character.xp;
    r = await clients.Rouge3('/revive', { mode: 'renown' });
    const lvl5 = 146; // coût d'un niveau 5 : 100 × 1,1^4
    check('renommée : 2 × le coût du niveau', r.s === 200 && before - r.d.character.xp === lvl5 * 2, JSON.stringify([before, r.d.character?.xp]));

    // Un défenseur qui tombe paie toujours le tarif simple.
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE player_state SET status = 'dead', fall_mult = 1 WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Bleu1')"));
    check('tarif de base : 100 or', (await clients.Bleu1('/map')).d.costs.revive === 100);

    // ---------- 6. Les Serpents : généraux en raid, Epimenides en dernier
    console.log('# Serpents des Ténèbres');
    await restart({ GEN_ATTACK_CHANCE: '0', BOSS_CHANCE: '1', GENERAL_CHANCE: '1', TEST_ROLL: '0.999' });
    resetAll(); resetGen();
    withDb((d) => d.exec('DELETE FROM battles'));
    const raid = async () => {
      for (let i = 0; i < 40; i += 1) {
        await clients.Rouge1('/map');
        const b = row("SELECT * FROM battles WHERE attacker = 'serpents' AND general IS NOT NULL ORDER BY id DESC");
        if (b) return b;
        await sleep(500);
      }
      return null;
    };
    const first = await raid();
    const SERP = ['cornelia', 'kronya', 'solon', 'thales', 'nemesis'];
    check('un raid mené par un général des Serpents (chance 100 % ici)', first && SERP.includes(first.general), JSON.stringify(first));
    const coef = ROSTER.find((g) => g.id === first.general).coef;
    const imp = (await clients.Rouge1('/map')).d.territories.find((t) => t.id === first.territory).importance;
    check('sa puissance suit son coefficient (3 × importance × coef)', Math.abs(first.boss_power - 3 * imp * coef) < 0.001, `${first.boss_power} vs ${3 * imp * coef}`);
    map = (await clients.Rouge1('/map')).d;
    check('la bataille nomme le général', terrOf(map, first.territory).battle.general?.id === first.general);
    check('il n\'est pas encore sur la carte', !map.territories.some((t) => t.occupants.some((o) => o.pseudo.toLowerCase() === first.general)));
    await sleep(13500);
    await clients.Rouge1('/map');
    check('raid repoussé : le général meurt', gen(first.general).status === 'dead', JSON.stringify(gen(first.general)));
    // Tous les autres tombés : seul Epimenides peut venir, à coup sûr.
    withDb((d) => { d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'serpents' AND gid != 'epimenides'; DELETE FROM battles"); });
    await restart({ GEN_ATTACK_CHANCE: '0', BOSS_CHANCE: '1', GENERAL_CHANCE: '0', TEST_ROLL: '0.999' });
    const last = await raid();
    check('Epimenides est le dernier, et vient à 100 % (même avec 0 % de chance)', last && last.general === 'epimenides', JSON.stringify(last));
    check('puissance : coef 3', last && Math.abs(last.boss_power - 3 * 3 * (((await clients.Rouge1('/map')).d.territories.find((t) => t.id === last.territory)).importance)) < 0.001);
    await sleep(13500);
    await clients.Rouge1('/map');
    check('Epimenides abattu : les Serpents ne reviennent plus', gen('epimenides').status === 'dead' && row("SELECT value FROM campaign_meta WHERE key = 'serpents_gone'")?.value === '1');
    const defender = last && row('SELECT defender FROM battles WHERE id = ?', last.id).defender;
    check('et la faction qui l\'a abattu gagne le bonus de points (+15 %)', !!defender && row('SELECT value FROM campaign_meta WHERE key = ?', 'epi:' + defender)?.value === '1', String(defender));
    const nBattles = row("SELECT count(*) AS n FROM battles WHERE attacker = 'serpents'").n;
    await sleep(8000);
    await clients.Rouge1('/map');
    check('plus aucun raid ensuite', row("SELECT count(*) AS n FROM battles WHERE attacker = 'serpents'").n === nBattles);
    // Une campagne remet les généraux et les Serpents à zéro.
    // (voir plus bas : la fin programmée)

    // ---------- 7. Sorties des généraux
    console.log('# IA des généraux');
    await restart({ GEN_ATTACK_CHANCE: '1' });
    resetAll(); resetGen();
    withDb((d) => d.exec('DELETE FROM battles'));
    await clients.Rouge1('/map');
    check('avant toute conquête, aucun général ne bouge', row("SELECT count(*) AS n FROM generals g WHERE faction IN ('rouge','bleue','jaune','violette') AND status = 'alive'").n === ROSTER.filter((g) => ['rouge', 'bleue', 'jaune', 'violette'].includes(g.faction)).length
      && ROSTER.filter((g) => g.home).every((g) => gen(g.id).territory === g.home));
    withDb((d) => d.exec("INSERT OR REPLACE INTO campaign_meta (key, value) VALUES ('conquest', '1')"));
    await clients.Rouge1('/map');
    const where = withDb((d) => Object.fromEntries(d.prepare('SELECT gid, territory FROM generals').all().map((r) => [r.gid, r.territory])));
    const out = ROSTER.filter((g) => g.home && where[g.id] !== g.home).map((g) => g.id);
    check('une fois un territoire conquis, des généraux sortent (2 sorties au plus)', out.length >= 1 && out.length <= 2, out.join(','));
    const homeOf = (id) => ROSTER.find((g) => g.id === id).home;
    const moved = out[0];
    check('ils se rendent sur un territoire ennemi voisin', gen(moved).territory !== homeOf(moved));
    await sleep(2500);
    await clients.Rouge1('/map');
    check('au tour suivant, il attaque (une seule fois) : bataille lancée par sa faction', row("SELECT count(*) AS n FROM general_contribs WHERE side = 'attack'").n >= 1 && row("SELECT count(*) AS n FROM battles WHERE attacker = ?", gen(moved).faction).n >= 1);
    await sleep(1000);
    const atkBefore = row('SELECT count(*) AS n FROM general_contribs WHERE gid = ?', moved).n;
    await sleep(2500);
    await clients.Rouge1('/map');
    check('jamais deux actions du meme general dans une meme bataille', row('SELECT count(*) AS n FROM (SELECT battle_id, gid FROM general_contribs GROUP BY battle_id, gid HAVING count(*) > 1)').n === 0 && atkBefore >= 1);

    // ---------- 8. Un exilé ne rapporte rien à une faction
    console.log('# Exil');
    await restart({ GEN_ATTACK_CHANCE: '0' });
    resetAll(); resetGen();
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM campaign_scores'); });
    applyPlayers({ Bleu2: P(['soldier'], { at: 'hresvelg' }) });
    withDb((d) => d.prepare("UPDATE player_state SET exile_faction = 'rouge' WHERE user_id = ?").run(uidOf(d, 'Bleu2')));
    r = await clients.Bleu2('/act', { action: 'gather' });
    const sc = row("SELECT score, faction_score FROM campaign_scores WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Bleu2')");
    check('exilé : il garde un score personnel mais rien pour sa faction', r.s === 200 && sc.score === 2 && sc.faction_score === 0, JSON.stringify(sc));
    check('et ses gains sont réduits de 25 %', r.d.character.gold === 30, String(r.d.character?.gold));
    withDb((d) => d.prepare("UPDATE player_state SET status = 'alive', territory = 'hresvelg' WHERE user_id = ?").run(uidOf(d, 'Bleu2')));
    await clients.Bleu2('/act', { action: 'defend' });
    check('un combat d\'exil est compté', row("SELECT exile_combats FROM campaign_scores WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Bleu2')").exile_combats === 1);

    // Un joueur qui rejoint la campagne alors que sa faction est déjà tombée peut s'exiler aussitôt.
    withDb((d) => d.exec("INSERT OR REPLACE INTO campaign_meta (key, value) VALUES ('held:jaune', '1'), ('out:jaune', '1')"));
    clients.Jaune1 = client();
    await clients.Jaune1('/register', { email: 'jaune1@example.test', password: 'mot-de-passe-Jaune1', passwordConfirm: 'mot-de-passe-Jaune1' });
    r = await clients.Jaune1('/character', { pseudo: 'Jaune1', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'jaune' });
    map = (await clients.Jaune1('/map')).d;
    check('arrivé après la chute des Cerfs d\'or : tombé d\'office, avec des bannières à choisir', r.s === 201 && map.player.status === 'dead' && map.exile && map.exile.options.length > 0, JSON.stringify(map.exile));
    r = await clients.Jaune1('/exile', { faction: map.exile.options[0] });
    check('il s\'exile aussitôt et combat sous cette bannière', r.s === 200 && r.d.player.exile === true && r.d.player.status === 'alive', JSON.stringify(r.d.player || r.d));
    withDb((d) => d.exec("DELETE FROM campaign_meta WHERE key IN ('held:jaune', 'out:jaune')"));

    // ---------- 9. Fin de campagne programmée
    console.log('# Fin programmée');
    const endAt = Date.now() + 9000;
    resetAll(); resetGen();
    withDb((d) => {
      d.exec('DELETE FROM battles; DELETE FROM campaign_scores; DELETE FROM campaign_results');
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const sc2 = (n, score, fscore, deaths, exile) => d.prepare('INSERT OR REPLACE INTO campaign_scores (campaign_id, user_id, score, faction_score, deaths, exile_combats) VALUES (?, ?, ?, ?, ?, ?)').run(cid, uidOf(d, n), score, fscore, deaths, exile || 0);
      sc2('Rouge1', 500, 500, 0); sc2('Rouge2', 200, 200, 0); sc2('Bleu1', 300, 300, 0);
      sc2('Rouge3', 100, 0, 0, 2); // exilé chez les Aigles : ne compte pas pour eux
      d.prepare("UPDATE player_state SET exile_faction = 'rouge' WHERE user_id = ?").run(uidOf(d, 'Rouge3'));
      d.prepare("UPDATE characters SET faction = 'bleue' WHERE pseudo = 'Rouge3'").run();
      d.prepare("UPDATE characters SET faction = 'violette' WHERE pseudo = 'Bleu2'").run();
      sc2('Bleu2', 100, 100, 0);
      d.exec("INSERT OR REPLACE INTO campaign_meta (key, value) VALUES ('epi:rouge', '1')");
      const bt = d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, started_at, ends_at, resolved_at, success, credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 3; i += 1) bt.run(cid, 'rowe', 'violette', 'bleue', 1, 1, 1, 1, null);
      for (let i = 0; i < 2; i += 1) bt.run(cid, 'garreg-mach', 'rouge', 'eglise', 1, 1, 1, 0, 'violette');
    });
    // Un combat encore ouvert au moment de la clôture : il se termine, et la fin de campagne est calculée ensuite.
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'duval'"));
    applyPlayers({ Rouge4: P(['soldier'], { at: 'duval' }) });
    insertBattle({ territory: 'duval', attacker: 'rouge', defender: 'bleue' }, [['Rouge4', 'attack', 1]], endAt + 4500 - Date.now());
    await restart({ GEN_ATTACK_CHANCE: '0', TEST_END_AT: String(endAt), TEST_RESET_AT: String(endAt + 11000) });
    const cid0 = (await clients.Rouge1('/map')).d.campaign.id;
    check('avant l\'heure, la campagne est ouverte', (await clients.Rouge1('/map')).d.campaign.phase === 'open' && (await me('Rouge1')).result === null);
    await sleep(Math.max(0, endAt - Date.now()) + 1500);
    map = (await clients.Rouge1('/map')).d;
    check('à l\'heure dite, la campagne se clôt : plus d\'attaque, mais le combat en cours continue', map.campaign.phase === 'closing' && map.campaign.id === cid0 && !!terrOf(map, 'duval').battle, JSON.stringify(map.campaign));
    r = await clients.Rouge1('/act', { action: 'attack' });
    check('toute nouvelle attaque est refusée', r.s === 409 && r.d.error === 'campaign_closing', JSON.stringify(r.d.error));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'hresvelg' }) });
    r = await clients.Rouge1('/act', { action: 'gather' });
    check('on peut encore récolter (et se déplacer)', r.s === 200, JSON.stringify(r.d.error));
    await sleep(Math.max(0, endAt + 4500 - Date.now()) + 2600);
    map = (await clients.Rouge1('/map')).d;
    check('le combat terminé, la fin de campagne est calculée : pause jusqu\'à la réouverture', map.campaign.phase === 'break' && map.campaign.id === cid0 && map.campaign.resetAt === endAt + 11000, JSON.stringify(map.campaign));
    check('le dernier combat a été résolu (Duval est tombé)', terrOf(map, 'duval').faction === 'rouge' && !terrOf(map, 'duval').battle);
    r = await clients.Rouge1('/act', { action: 'gather' });
    check('pendant la pause plus aucune action', r.s === 409 && r.d.error === 'campaign_break', JSON.stringify(r.d.error));
    r = await clients.Rouge1('/move', { to: 'varley' });
    check('ni déplacement', r.s === 409 && r.d.error === 'campaign_break');
    const res = (await me('Rouge1')).result;
    check('le résultat est proposé au participant', !!res && res.campaign === cid0 && res.reason === 'schedule' && res.faction === 'rouge', JSON.stringify(res)?.slice(0, 400));
    const top = res.standings[0];
    check('la faction qui a le plus de points l\'emporte', res.winner === top.faction && top.points >= res.standings[1].points, JSON.stringify(res.standings));
    const partsOf = (r) => Object.fromEntries(r.parts.map((p) => [p.key, p.points]));
    check('points des Aigles : territoires, survivants, activité (700 × 5 %) — sans l\'exilé — avec ×1,15',
      res.mult === 1.15 && partsOf(res).activity === 37 && partsOf(res).territories > 0, JSON.stringify(res.parts) + ' x' + res.mult);
    const rb = (await me('Bleu1')).result;
    check('Lions : l\'exilé n\'ajoute rien à leur activité, ni survivant (300 × 5 % = 15)', partsOf(rb).activity === 15, JSON.stringify(rb?.parts));
    const rw = (await me('Bleu2')).result;
    const pw = partsOf(rw);
    check('Loups de cendre : 3 attaques (15), 2 défenses créditées (10), aucun mort (80)', pw.attacks === 15 && pw.defenses === 10 && pw.lowDeaths === 80, JSON.stringify(rw?.parts));
    const rx = (await me('Rouge3')).result;
    check('un exilé reçoit sa prime d\'exil (150 or)', rx && rx.exileGold === 150 && rx.exile === 'rouge', JSON.stringify(rx)?.slice(0, 300));
    check('le classement récompense toujours les trois premiers (1er : Rouge1)', res.rank === 1 && res.rankGold === 1000, JSON.stringify([res.rank, res.rankGold]));
    r = await clients.Rouge1('/campaign/seen', {});
    check('une fois lu, le résultat ne revient plus', (await clients.Rouge1('/campaign/seen', {})).d.result === null && (await me('Rouge1')).result === null);
    check('les points sont ajoutés au total des factions', Object.values((await clients.Rouge1('/map')).d.points).some((p) => p > 0));
    await sleep(Math.max(0, endAt + 11000 - Date.now()) + 2600);
    map = (await clients.Rouge1('/map')).d;
    check('à la réouverture : nouvelle campagne, carte remise à zéro', map.campaign.id === cid0 + 1 && map.campaign.phase === 'open' && terrOf(map, 'duval').faction === 'bleue', JSON.stringify(map.campaign));
    check('généraux remis à leur poste, Serpents de nouveau possibles', gen('edelgard').status === 'alive' && gen('epimenides').status === 'alive' && !row("SELECT 1 FROM campaign_meta WHERE key = 'serpents_gone'"));
    r = await clients.Rouge1('/act', { action: 'gather' });
    check('et on rejoue', r.s === 200 || r.d.error !== 'campaign_break', JSON.stringify(r.d.error));
    await sleep(3000);
    check('la campagne suivante ne se termine pas aussitôt', (await clients.Rouge1('/map')).d.campaign.id === cid0 + 1);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
