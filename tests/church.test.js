// Teste l'Église de Seiros : garnison de Garreg-Mach (Rhea et ses chevaliers), croisade contre une faction dominante,
// et éveil de l'Immaculée quand Garreg-Mach tombe (assauts, retour de Rhea, chute de l'Immaculée).
// Usage : node tests/church.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3122;
const TURN = 2000;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', ...env },
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
const NAMES = ['Rouge1', 'Rouge2', 'Bleu1'];
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
const uidOf = (d, name) => d.prepare('SELECT user_id FROM characters WHERE pseudo = ?').get(name).user_id;
const row = (sql, ...a) => withDb((d) => d.prepare(sql).get(...a));
const rows = (sql, ...a) => withDb((d) => d.prepare(sql).all(...a));
const meta = (k) => row('SELECT value FROM campaign_meta WHERE key = ?', k)?.value;
const gen = (gid) => row('SELECT * FROM generals WHERE gid = ?', gid);
const G = require(path.join(process.cwd(), 'public', 'config', 'game.json'));
const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json'));
const ROSTER = G.generals.roster;
const KNIGHTS = ROSTER.filter((g) => g.faction === 'eglise' && g.id !== 'rhea' && g.id !== 'immaculate').map((g) => g.id);
const ANNEX = new Set(G.campaign.annex);
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const noteTypes = async (n) => (await clients[n]('/notifications')).d.notifications.map((x) => x.type);
const journalTypes = async () => (await clients.Rouge1('/journal')).d.events.map((e) => e.type);

// Remet la carte et l'Église dans leur état de départ.
function resetWorld() {
  withDb((d) => {
    d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM general_verdicts');
    d.exec("DELETE FROM campaign_meta WHERE key IN ('crusade', 'immaculate', 'conquest') OR key LIKE 'immac:%'");
    const up = d.prepare('UPDATE territories SET faction = ? WHERE id = ?');
    for (const t of MAP.territories) up.run(t.faction || null, t.id);
    const ug = d.prepare("UPDATE generals SET status = 'alive', territory = ?, faction = ?, spared = 0, actions = 4, actions_at = ?, move_turn = -1 WHERE gid = ?");
    for (const g of ROSTER) ug.run(g.home, g.faction, Date.now(), g.id);
    d.exec("UPDATE generals SET status = 'dormant' WHERE gid = 'immaculate'");
    for (const n of NAMES) d.prepare("UPDATE player_state SET territory = ?, actions = 8, status = 'alive', retreat_until = NULL WHERE user_id = ?").run(n.startsWith('Rouge') ? 'varley' : 'charon', uidOf(d, n));
  });
}
function insertBattle(territory, attacker, defender, endsIn, boss = 0, general = null, contribs = []) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at, general) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(cid, territory, attacker, defender, boss, now, now + endsIn, general).lastInsertRowid);
    for (const [n, side] of contribs) {
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, 'rouge', ?, 1, ?, NULL, 'action', 0)")
        .run(id, territory, uidOf(d, n), side, now);
    }
    return id;
  });
}

(async () => {
  try {
    await start();
    await createAll();
    resetWorld();

    console.log('# Garnison de Garreg-Mach');
    let map = (await clients.Rouge1('/map')).d;
    const gm = terrOf(map, 'garreg-mach').occupants.filter((o) => o.general && o.faction === 'eglise').map((o) => o.pseudo).sort();
    check('Rhea et ses 8 chevaliers gardent Garreg-Mach', gm.length === 9 && gm.includes('Rhea') && gm.includes('Seteth') && gm.includes('Flayn'), gm.join(','));
    check('Rhea est un seigneur', terrOf(map, 'garreg-mach').occupants.find((o) => o.pseudo === 'Rhea')?.lord === true);
    check('l\'Immaculée n\'est pas sur la carte', !map.territories.some((t) => t.occupants.some((o) => o.gid === 'immaculate')));
    let pr = await clients.Rouge1('/profile?general=immaculate');
    check('profil de l\'Immaculée : en sommeil', pr.s === 200 && pr.d.status === 'dormant', JSON.stringify(pr.d.status));
    check('pas de croisade au départ', map.church && map.church.crusade === null && map.church.awakening === null, JSON.stringify(map.church));

    // Garreg-Mach attaqué : Rhea le défend sans dépenser d'action, les chevaliers aussi.
    insertBattle('garreg-mach', 'rouge', 'eglise', 60_000, 0, null, [['Rouge1', 'attack']]);
    await clients.Rouge1('/map');
    await sleep(300);
    await clients.Rouge1('/map');
    const defs = rows("SELECT gid FROM general_contribs WHERE side = 'defense'").map((r) => r.gid);
    check('Rhea défend Garreg-Mach', defs.includes('rhea'), defs.join(','));
    check('… sans dépenser d\'action', gen('rhea').actions === 4, String(gen('rhea').actions));
    check('les chevaliers défendent aussi', KNIGHTS.every((k) => defs.includes(k)), defs.join(','));

    console.log('# Croisade');
    resetWorld();
    // Les Aigles de jais prennent assez de territoires pour tenir 45 % de la carte (hors annexes).
    const main = MAP.territories.filter((t) => !ANNEX.has(t.id) && t.id !== 'garreg-mach');
    const need = Math.ceil(0.45 * (main.length + 1));
    const others = main.filter((t) => t.faction !== 'rouge');
    const extra = others.slice(0, need - main.filter((t) => t.faction === 'rouge').length).map((t) => t.id);
    withDb((d) => { for (const id of extra) d.prepare("UPDATE territories SET faction = 'rouge' WHERE id = ?").run(id); });
    map = (await clients.Rouge1('/map')).d;
    check('croisade déclarée contre la faction dominante', meta('crusade') === 'rouge' && map.church.crusade === 'rouge', JSON.stringify(map.church));
    check('tout le monde est prévenu', (await noteTypes('Bleu1')).includes('crusade_declared') && (await journalTypes()).includes('crusade_declared'));
    // Les chevaliers sortent, un pas par tour : au plus 3, une garnison reste.
    await sleep(TURN + 300);
    await clients.Rouge1('/map');
    await sleep(TURN + 300);
    await clients.Rouge1('/map');
    const out = KNIGHTS.filter((k) => gen(k).territory !== 'garreg-mach');
    check('3 chevaliers partent en croisade, les autres gardent Garreg-Mach', out.length === 3, out.map((k) => `${k}@${gen(k).territory}`).join(','));
    const atk = rows("SELECT b.territory FROM battles b WHERE b.attacker = 'eglise' AND b.resolved_at IS NULL").map((r) => r.territory);
    const rougeLand = new Set(rows("SELECT id FROM territories WHERE faction = 'rouge'").map((r) => r.id));
    check('ils attaquent un territoire des Aigles de jais', atk.length >= 1 && atk.every((x) => rougeLand.has(x)), atk.join(','));
    // La faction redescend sous 38 % : la croisade est levée.
    withDb((d) => { for (const id of extra) d.prepare('UPDATE territories SET faction = ? WHERE id = ?').run(MAP.territories.find((t) => t.id === id).faction, id); });
    await clients.Rouge1('/map');
    check('croisade levée quand la domination recule', !meta('crusade') && (await journalTypes()).includes('crusade_ended'), String(meta('crusade')));

    console.log('# Croisade repoussée');
    // Plusieurs chevaliers vaincus sur une terre des Aigles : un seul tombe (l'épargnable d'abord), les autres rentrent à Garreg-Mach.
    {
      const homes = new Set(ROSTER.map((g) => g.home));
      const land = MAP.territories.find((t) => t.faction === 'rouge' && !homes.has(t.id) && !ANNEX.has(t.id)).id;
      const who = (ks) => ks.map((k) => k + ':' + gen(k).status + '@' + gen(k).territory).join(',');
      const crusadeLost = async (party) => {
        resetWorld();
        withDb((d) => {
          const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
          const now = Date.now();
          for (const [gid] of party) d.prepare("UPDATE generals SET territory = ?, status = 'alive', spared = 0, move_turn = 999999999999 WHERE gid = ?").run(land, gid);
          const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
            .run(cid, land, 'eglise', 'rouge', now, now + 2500).lastInsertRowid);
          for (const [gid, power] of party) d.prepare("INSERT INTO general_contribs (battle_id, gid, side, power) VALUES (?, ?, 'attack', ?)").run(id, gid, power);
          d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, 'rouge', 'defense', 60, ?, NULL, 'action', 0)")
            .run(id, land, uidOf(d, 'Rouge1'), now);
        });
        await sleep(2500 + TURN + 800);
        await clients.Rouge1('/map');
      };
      await restart({ TEST_ROLL: '0.999' });
      await crusadeLost([['seteth', 3], ['shamir', 1], ['cyril', 2]]);
      check("croisade repoussée : un seul chevalier vaincu, l'épargnable (Shamir) attend le verdict", gen('shamir').status === 'captive' && !!row('SELECT 1 FROM general_verdicts WHERE gid = ?', 'shamir'), who(['seteth', 'shamir', 'cyril']));
      check('les autres battent en retraite à Garreg-Mach, vivants', ['seteth', 'cyril'].every((k) => gen(k).status === 'alive' && gen(k).territory === 'garreg-mach'), who(['seteth', 'cyril']));
      check('journal de la retraite', (await journalTypes()).includes('knight_retreated'));
      await crusadeLost([['seteth', 1], ['catherine', 3]]);
      check("sans chevalier épargnable : celui qui a le plus pesé tombe (Catherine), l'autre rentre", gen('catherine').status === 'dead' && gen('seteth').status === 'alive' && gen('seteth').territory === 'garreg-mach', who(['seteth', 'catherine']));
      await restart({});
    }

    console.log('# L\'Immaculée');
    resetWorld();
    insertBattle('garreg-mach', 'rouge', 'eglise', 1200, 0, null, [['Rouge1', 'attack']]);
    await clients.Rouge1('/map');
    await sleep(1600);
    map = (await clients.Rouge1('/map')).d;
    check('Garreg-Mach tombe aux mains des Aigles de jais', terrOf(map, 'garreg-mach').owner === 'rouge' || row("SELECT faction FROM territories WHERE id = 'garreg-mach'").faction === 'rouge');
    check('Rhea ne meurt pas : elle s\'éveille en l\'Immaculée', gen('rhea').status === 'dormant' && gen('immaculate').status === 'alive', `${gen('rhea').status}/${gen('immaculate').status}`);
    let aw = JSON.parse(meta('immaculate') || 'null');
    check('éveil en cours, aucun assaut repoussé', aw && aw.holder === 'rouge' && aw.waves === 0, JSON.stringify(aw));
    check('tout le monde est prévenu', (await noteTypes('Bleu1')).includes('immaculate_awoke') && (await journalTypes()).includes('immaculate_awoke'));
    let wave = row("SELECT * FROM battles WHERE territory = 'garreg-mach' AND resolved_at IS NULL");
    check('premier assaut de l\'Immaculée sur Garreg-Mach (puissance 3 × importance 5 × coef 4)', wave && wave.attacker === 'eglise' && wave.general === 'immaculate' && wave.boss_power === 60, JSON.stringify(wave));
    check('la carte affiche le siège', map.church.awakening && map.church.awakening.total === 3, JSON.stringify(map.church));
    const knightsLeft = KNIGHTS.filter((k) => gen(k).status === 'alive');
    check('les chevaliers qui défendaient Garreg-Mach sont vaincus', knightsLeft.length === 0, knightsLeft.join(','));

    // Assaut réussi : l'Église reprend Garreg-Mach, Rhea revient.
    withDb((d) => d.prepare('UPDATE battles SET ends_at = ? WHERE id = ?').run(Date.now(), wave.id));
    await clients.Rouge1('/map');
    check('assaut réussi : l\'Église reprend Garreg-Mach', row("SELECT faction FROM territories WHERE id = 'garreg-mach'").faction === 'eglise');
    check('Rhea retrouve son siège, l\'Immaculée se rendort', gen('rhea').status === 'alive' && gen('rhea').territory === 'garreg-mach' && gen('immaculate').status === 'dormant' && !meta('immaculate'), `${gen('rhea').status}@${gen('rhea').territory}/${gen('immaculate').status}`);
    check('journal et notification du retour', (await journalTypes()).includes('immaculate_returned') && (await noteTypes('Rouge2')).includes('immaculate_returned'));

    // Assauts repoussés : au troisième, l'Immaculée tombe.
    await restart({ TEST_ROLL: '0.999' });
    resetWorld();
    withDb((d) => {
      d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'garreg-mach'");
      d.exec("UPDATE generals SET status = 'dormant' WHERE gid = 'rhea'; UPDATE generals SET status = 'alive' WHERE gid = 'immaculate'");
      d.prepare("INSERT INTO campaign_meta (key, value) VALUES ('immaculate', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ holder: 'rouge', waves: 0, next: 0, turn: -1 }));
      d.exec("UPDATE player_state SET territory = 'garreg-mach' WHERE user_id IN (SELECT user_id FROM characters WHERE pseudo LIKE 'Rouge%')");
      for (const k of KNIGHTS) d.prepare("UPDATE generals SET status = 'dead' WHERE gid = ?").run(k);
    });
    await clients.Rouge1('/map');
    wave = row("SELECT * FROM battles WHERE territory = 'garreg-mach' AND resolved_at IS NULL");
    withDb((d) => {
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, 'garreg-mach', ?, 'rouge', 'defense', 1, ?, NULL, 'action', 0)").run(wave.id, uidOf(d, 'Rouge2'), Date.now());
      d.prepare('UPDATE battles SET ends_at = ? WHERE id = ?').run(Date.now(), wave.id);
    });
    await clients.Rouge1('/map');
    aw = JSON.parse(meta('immaculate') || 'null');
    check('assaut repoussé : 1 sur 3, le prochain dans 4 heures', aw && aw.waves === 1 && aw.next > Date.now() + 3.9 * 3_600_000, JSON.stringify(aw));
    check('pas de nouvel assaut avant l\'heure', !row("SELECT 1 FROM battles WHERE territory = 'garreg-mach' AND resolved_at IS NULL"));
    check('journal de l\'assaut repoussé', (await journalTypes()).includes('immaculate_wave'));
    // Dernier assaut.
    withDb((d) => d.prepare("UPDATE campaign_meta SET value = ? WHERE key = 'immaculate'").run(JSON.stringify({ holder: 'rouge', waves: 2, next: 0, turn: -1 })));
    await clients.Rouge1('/map');
    wave = row("SELECT * FROM battles WHERE territory = 'garreg-mach' AND resolved_at IS NULL");
    const goldBefore = row("SELECT gold FROM characters WHERE pseudo = 'Rouge2'").gold;
    withDb((d) => {
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, 'garreg-mach', ?, 'rouge', 'defense', 1, ?, NULL, 'action', 0)").run(wave.id, uidOf(d, 'Rouge2'), Date.now());
      d.prepare('UPDATE battles SET ends_at = ? WHERE id = ?').run(Date.now(), wave.id);
    });
    await clients.Rouge1('/map');
    check('troisième assaut repoussé : l\'Immaculée tombe, et Rhea avec elle', gen('immaculate').status === 'dead' && gen('rhea').status === 'dead' && !meta('immaculate'), `${gen('immaculate').status}/${gen('rhea').status}`);
    check('bonus de points pour la faction qui l\'a abattue', meta('immac:rouge') === '1');
    check('journal et notification', (await journalTypes()).includes('immaculate_fell') && (await noteTypes('Bleu1')).includes('immaculate_fell'));
    const goldAfter = row("SELECT gold FROM characters WHERE pseudo = 'Rouge2'").gold;
    check('les défenseurs reçoivent la récompense du général (coef 4)', goldAfter - goldBefore >= 480, String(goldAfter - goldBefore));
    await clients.Rouge1('/map');
    check('plus d\'assaut ni de croisade ensuite', !row("SELECT 1 FROM battles WHERE attacker = 'eglise' AND resolved_at IS NULL") && !meta('crusade'));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
