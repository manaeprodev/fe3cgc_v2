// Teste les effets de classe : puissance en bataille, gains, replis, actions, téléportation, lignée de classes.
// Chaque cas fabrique l'état voulu directement dans la base (joueurs, présence, bataille), puis lit le résultat du serveur.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3120;
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
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const gen = (gid) => row('SELECT * FROM generals WHERE gid = ?', gid);
const setMeta = (k, v) => withDb((d) => d.prepare('INSERT OR REPLACE INTO campaign_meta (key, value) VALUES (?, ?)').run(k, String(v)));
const meta = (k) => row('SELECT value FROM campaign_meta WHERE key = ?', k)?.value;
const noteTypes = async (n) => (await clients[n]('/notifications')).d.notifications.map((x) => x.type);
function resetGen() {
  withDb((d) => {
    d.exec('DELETE FROM general_contribs; DELETE FROM general_verdicts; DELETE FROM battles; DELETE FROM contributions');
    const up = d.prepare("UPDATE generals SET status = 'alive', territory = ?, faction = ?, spared = 0, actions = 4, actions_at = ?, move_turn = -1 WHERE gid = ?");
    for (const g of ROSTER) up.run(g.home, g.faction, Date.now(), g.id);
    d.exec("DELETE FROM campaign_meta WHERE key IN ('conquest', 'serpents_gone') OR key LIKE 'epi:%' OR key LIKE 'retake:%' OR key LIKE 'gauge:%' OR key LIKE 'buff:%'");
    for (const tt of require(path.join(process.cwd(), 'public', 'config', 'map.json')).territories) d.prepare('UPDATE territories SET faction = ? WHERE id = ?').run(tt.faction, tt.id);
  });
}

(async () => {
  try {
    await start({ GEN_ATTACK_CHANCE: '0' });
    await createAll();

    // ---------- 1. Rester sur place pour combattre
    console.log('# Engagement');
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'bleue'"));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'rowe' }) });
    let r = await clients.Rouge1('/act', { action: 'attack' });
    check('Rouge1 attaque Rowe', r.s === 200, JSON.stringify(r.d.error));
    const contrib = () => row("SELECT count(*) AS n FROM contributions WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Rouge1') AND kind = 'action'").n;
    r = await clients.Rouge1('/move', { to: 'barnabas' });
    check('partir sans confirmer est refusé : il combat ici', r.s === 409 && r.d.error === 'engaged' && r.d.error !== undefined, JSON.stringify(r.d));
    check('ses actions sont toujours là', contrib() === 1);
    r = await clients.Rouge1('/move', { to: 'barnabas', leave: true });
    check('en confirmant, il part et ses actions sont annulées', r.s === 200 && r.d.cancelled === 1 && contrib() === 0 && r.d.player.territory === 'barnabas', JSON.stringify([r.s, r.d.cancelled, contrib()]));
    check('sans remboursement : 2 actions dépensées (attaque, déplacement)', r.d.player.actions === 6, String(r.d.player.actions));
    r = await clients.Rouge1('/act', { action: 'defend' });
    r = await clients.Rouge1('/move', { to: 'varley' });
    check('une garnison posée retient aussi', r.s === 409 && r.d.error === 'engaged');
    r = await clients.Rouge1('/move', { to: 'varley', leave: true });
    check('et elle est annulée au départ', r.s === 200 && contrib() === 0);

    // ---------- 2. Seigneurs
    console.log('# Seigneurs');
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE generals SET actions = 0, actions_at = " + Date.now() + " WHERE gid IN ('edelgard', 'hubert', 'dorothea', 'manuela')"));
    applyPlayers({ Bleu1: P(['soldier'], { at: 'hresvelg' }) });
    insertBattle({ territory: 'hresvelg', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 200]], 1500);
    await clients.Rouge1('/map');
    const defs = withDb((d) => d.prepare('SELECT gid FROM general_contribs').all().map((x) => x.gid));
    check('Edelgard défend sa capitale même sans action ; les autres, sans action, non', defs.join() === 'edelgard', defs.join());
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Hresvelg tombe', row("SELECT faction FROM territories WHERE id = 'hresvelg'").faction === 'bleue');
    const ed = gen('edelgard');
    const esc1 = (await clients.Rouge1('/journal')).d.events.find((e) => e.type === 'lord_escaped');
    check('Edelgard ne meurt pas : il reste des généraux sous sa bannière, elle se replie auprès des siens', ed.status === 'alive' && esc1 && esc1.params.territory && esc1.params.territory !== 'hresvelg', JSON.stringify([ed.status, esc1?.params]));
    check('Hubert, non épargnable, meurt avec la capitale', gen('hubert').status === 'dead');
    check('elle ordonne la reprise de la capitale : ralliement', meta('retake:rouge') === '1' && (await noteTypes('Rouge1')).includes('lord_rally'));
    check('le journal raconte le ralliement', (await clients.Rouge1('/journal')).d.events.some((e) => e.type === 'lord_rally'));
    // Reprise : les généraux marchent sur la capitale.
    await restart({ GEN_ATTACK_CHANCE: '0' });
    withDb((d) => d.exec("UPDATE generals SET actions = 4, move_turn = -1 WHERE faction = 'rouge'"));
    let marched = false;
    for (let i = 0; i < 6 && !marched; i += 1) {
      await sleep(2100);
      await clients.Rouge1('/map');
      marched = !!row("SELECT 1 AS x FROM battles WHERE territory = 'hresvelg' AND attacker = 'rouge' AND resolved_at IS NULL") || !!row("SELECT 1 AS x FROM generals WHERE faction = 'rouge' AND territory = 'hresvelg' AND status = 'alive'");
    }
    check('les généraux de la faction marchent sur la capitale', marched);
    // Seigneur seul : il meurt.
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'rouge' AND gid != 'edelgard'"));
    applyPlayers({ Bleu1: P(['soldier'], { at: 'hresvelg' }) });
    insertBattle({ territory: 'hresvelg', attacker: 'bleue', defender: 'rouge' }, [['Bleu1', 'attack', 200]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('seule sous sa bannière, Edelgard meurt', gen('edelgard').status === 'dead', JSON.stringify(gen('edelgard')));
    // Immobile dans sa capitale.
    resetAll(); resetGen();
    await restart({ GEN_ATTACK_CHANCE: '1' });
    setMeta('conquest', '1');
    for (let i = 0; i < 3; i += 1) { await clients.Rouge1('/map'); await sleep(2100); }
    check('les seigneurs ne quittent pas leur capitale', gen('edelgard').territory === 'hresvelg' && gen('dimitri').territory === 'blaiddyd' && gen('claude').territory === 'riegan');

    // ---------- 3. Yuri
    console.log('# Yuri');
    await restart({ GEN_ATTACK_CHANCE: '0' });
    resetAll(); resetGen();
    applyPlayers({ Rouge1: P(['soldier'], { at: 'garreg-mach' }) });
    insertBattle({ territory: 'garreg-mach', attacker: 'rouge', defender: 'eglise' }, [['Rouge1', 'attack', 500]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('Garreg-Mach tombe', row("SELECT faction FROM territories WHERE id = 'garreg-mach'").faction === 'rouge');
    check('Yuri ne meurt pas tant que Constance, Hapi ou Balthus restent : il est renvoyé à Garreg-Mach', gen('yuri').status === 'alive' && gen('yuri').territory === 'garreg-mach', JSON.stringify(gen('yuri')));
    check('ses compagnons, eux, sont vaincus', ['constance', 'hapi', 'balthus'].every((g) => gen(g).status !== 'alive'));
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'violette' AND gid != 'yuri'"));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'garreg-mach' }) });
    insertBattle({ territory: 'garreg-mach', attacker: 'rouge', defender: 'eglise' }, [['Rouge1', 'attack', 500]], 1500);
    await clients.Rouge1('/map');
    await sleep(3300);
    await clients.Rouge1('/map');
    check('seul Loup de cendre restant, Yuri peut tomber (mort ou à la merci des vainqueurs)', gen('yuri').status !== 'alive', JSON.stringify(gen('yuri')));

    // ---------- 4. Capitale : plus dure à prendre selon la taille de la faction
    console.log('# Capitale');
    resetAll(); resetGen();
    withDb((d) => d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'bleue'"));
    applyPlayers({ Rouge1: P(['soldier'], { at: 'blaiddyd' }) });
    insertBattle({ territory: 'blaiddyd', attacker: 'rouge', defender: 'bleue' }, [['Rouge1', 'attack', 1]]);
    let map = (await clients.Rouge1('/map')).d;
    const nb = map.territories.filter((x) => x.faction === 'bleue').length;
    const bt = terrOf(map, 'blaiddyd').battle;
    check(`défense de Blaiddyd : 2 × 3 × (1 + 4 % × ${nb} territoires)`, near(bt.power.defense, 6 * (1 + 0.04 * nb)), `${bt.power.defense} vs ${6 * (1 + 0.04 * nb)}`);
    check('le bonus est indiqué sur le territoire', terrOf(map, 'blaiddyd').capitalBonus === Math.round(4 * nb), String(terrOf(map, 'blaiddyd').capitalBonus));
    withDb((d) => d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'riegan'"));
    map = (await clients.Rouge1('/map')).d;
    check('une capitale prise par une autre faction ne profite pas du bonus', terrOf(map, 'riegan').capitalBonus === 0);

    // ---------- 5. Énergie offerte par les missions
    console.log('# Énergie');
    resetAll(); resetGen();
    withDb((d) => d.exec('DELETE FROM campaign_mission_progress'));
    withDb((d) => { const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id; d.prepare("INSERT INTO campaign_mission_progress (campaign_id, user_id, event, count) VALUES (?, ?, 'conquest', 3)").run(cid, uidOf(d, 'Rouge2')); });
    withDb((d) => d.prepare('UPDATE player_state SET actions = 8, actions_at = ? WHERE user_id = ?').run(Date.now(), uidOf(d, 'Rouge2')));
    r = await clients.Rouge2('/missions/campaign/claim', { id: 'c-conquest' });
    check('mission de campagne : +3 actions, au-delà du maximum (11 / 8)', r.s === 200 && r.d.player.actions === 11 && r.d.player.maxActions === 8 && r.d.player.nextActionAt === null, JSON.stringify(r.d.player && [r.d.player.actions, r.d.player.maxActions]));
    applyPlayers({ Rouge2: P(['soldier'], { at: 'varley' }) });
    await clients.Rouge2('/act', { action: 'gather' });
    await sleep(2300);
    const pl = (await me('Rouge2')).player;
    check('au-dessus du maximum, la réserve ne se recharge pas (10 après une action)', pl.actions === 10, String(pl.actions));
    const daily = (await clients.Rouge2('/missions')).d.daily.missions;
    check('3 missions du jour rendent de l\'énergie', daily.filter((m) => m.rewards.actions > 0).length === 3, JSON.stringify(daily.map((m) => m.rewards)));
    check('et 3 missions de campagne', (await clients.Rouge2('/missions')).d.campaignMissions.filter((m) => m.rewards.actions > 0).length === 3);

    // ---------- 6. Profils
    console.log('# Profils');
    r = await clients.Bleu1('/profile?pseudo=Rouge1');
    check('profil d\'un joueur : faction, classe, parcours, renommée, anniversaire, points', r.s === 200 && r.d.pseudo === 'Rouge1' && r.d.faction === 'rouge' && r.d.class && Array.isArray(r.d.path) && Number.isInteger(r.d.level) && r.d.birthday === '1995-04-12' && typeof r.d.score === 'number', JSON.stringify(r.d).slice(0, 200));
    r = await clients.Bleu1('/profile?general=dimitri');
    check('profil d\'un général : seigneur, classe légendaire, territoire d\'origine', r.s === 200 && r.d.lord === true && r.d.class === 'great-lord' && r.d.home === 'blaiddyd', JSON.stringify(r.d).slice(0, 200));
    check('profil inconnu : introuvable', (await clients.Bleu1('/profile?pseudo=Personne')).s === 404);
    check('la carte indique le dernier événement du journal (pastille)', (await clients.Rouge1('/map')).d.journalLatest > 0);

    // ---------- 7. Signaler un bug
    console.log('# Bugs');
    check('message vide refusé', (await clients.Bleu2('/bug', { message: '  ' })).s === 400);
    check('message trop long refusé', (await clients.Bleu2('/bug', { message: 'x'.repeat(501) })).s === 400);
    check('signalement enregistré', (await clients.Bleu2('/bug', { message: 'Le bouton Attaquer reste gris.' })).s === 200 && row('SELECT message FROM bug_reports').message === 'Le bouton Attaquer reste gris.');
    await clients.Bleu2('/bug', { message: 'deux' });
    await clients.Bleu2('/bug', { message: 'trois' });
    check('3 par heure au plus', (await clients.Bleu2('/bug', { message: 'quatre' })).s === 429);

    // ---------- 8. Capacité du seigneur : tout le monde est prévenu
    console.log('# Notifications');
    resetAll(); resetGen();
    setMeta('gauge:rouge', 119);
    applyPlayers({ Rouge1: P(['soldier'], { at: 'duval' }) });
    withDb((d) => d.exec("UPDATE generals SET status = 'dead' WHERE faction = 'bleue'"));
    await clients.Rouge1('/act', { action: 'attack' });
    check('la capacité d\'Edelgard prévient aussi les autres factions', (await noteTypes('Bleu1')).includes('lord_ability'));
    // Un exilé ne profite pas de la capacité de son seigneur d'adoption.
    withDb((d) => {
      d.exec('DELETE FROM battles; DELETE FROM contributions');
      d.prepare("UPDATE player_state SET exile_faction = 'rouge', territory = 'duval' WHERE user_id = ?").run(uidOf(d, 'Bleu2'));
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const now = Date.now();
      const id = Number(d.prepare("INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, 'duval', 'rouge', 'bleue', 0, ?, ?)").run(cid, now, now + 3600000).lastInsertRowid);
      const add = d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, 'duval', ?, 'rouge', 'attack', 1, ?, NULL, 'action', 0)");
      add.run(id, uidOf(d, 'Rouge1'), now); add.run(id, uidOf(d, 'Bleu2'), now);
    });
    const b2 = terrOf((await clients.Rouge1('/map')).d, 'duval').battle;
    check('exilé : pas de bonus du seigneur (1 × 1,12 + 1 = 2,12)', near(b2.power.attack, 2.12), String(b2.power.attack));
    withDb((d) => d.prepare('UPDATE player_state SET exile_faction = NULL WHERE user_id = ?').run(uidOf(d, 'Bleu2')));
    // Avertissement de fin de campagne.
    await restart({ GEN_ATTACK_CHANCE: '0', TEST_END_AT: String(Date.now() + 2 * 3600000) });
    await clients.Rouge1('/map');
    await sleep(1200);
    await clients.Rouge1('/map');
    const ending = (await clients.Bleu1('/notifications')).d.notifications.filter((x) => x.type === 'campaign_ending');
    check('quelques heures avant la clôture, tout le monde est prévenu, une seule fois', ending.length === 1, String(ending.length));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
