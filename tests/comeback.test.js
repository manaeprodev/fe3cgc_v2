'use strict';
// Retour en force des factions perdantes : désespoir, coalition, prime sur le leader, lignes de ravitaillement,
// généraux en renfort (repli soigné), et fatigue des attaques à la chaîne.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3133;
const GAME = require(path.join(process.cwd(), 'public', 'config', 'game.json'));
const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json'));
const ANNEX = new Set(GAME.campaign.annex);
const CB = GAME.campaign.comeback;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', TEST_HP_ROLL: '0.999', HP_ON: '1', ...env },
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
    const r = await fetch(`http://localhost:${PORT}/api${p}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { s: r.status, d: await r.json() };
  };
}
const C = {};
const mk = async (name, faction) => {
  C[name] = client();
  const pw = 'mot-de-passe-' + name;
  await C[name]('/register', { email: `${name.toLowerCase()}@example.test`, password: pw, passwordConfirm: pw });
  const r = await C[name]('/character', { pseudo: name, birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction });
  if (r.s !== 201) throw new Error(JSON.stringify(r.d));
};
const uid = (n) => withDb((d) => d.prepare('SELECT user_id FROM characters WHERE pseudo = ?').get(n).user_id);
const row = (sql, ...a) => withDb((d) => d.prepare(sql).get(...a));
const run = (sql, ...a) => withDb((d) => d.prepare(sql).run(...a));
const hpPts = (n) => row('SELECT hp_pts FROM player_state WHERE user_id = ?', uid(n)).hp_pts;
const place = (n, at, extra = '') => run(`UPDATE player_state SET territory = ?, status = 'alive', actions = 8, actions_at = ?, retreat_until = NULL ${extra} WHERE user_id = ?`, at, Date.now(), uid(n));
const resetMap = () => withDb((d) => {
  const up = d.prepare('UPDATE territories SET faction = ? WHERE id = ?');
  for (const t of MAP.territories) up.run(t.faction || null, t.id);
  d.exec("DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM general_verdicts; UPDATE player_state SET hp_pts = NULL");
});
// Les Lions prennent toutes les terres des Cerfs d'or sauf trois : Lions en tête et dominants (plus de la moitié de la carte),
// Cerfs en perdition.
const KEEP = ['riegan', 'edmund', 'nilsson'];
const crushDeer = () => withDb((d) => { const up = d.prepare("UPDATE territories SET faction = 'bleue' WHERE id = ?"); for (const t of MAP.territories) if (t.faction === 'jaune' && !KEEP.includes(t.id)) up.run(t.id); });
function battle(territory, attacker, defender, contribs, endsIn = 1500) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, territory, attacker, defender, now, now + endsIn).lastInsertRowid);
    for (const [n, side, faction, power] of contribs) d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'action', 0)").run(id, territory, uid(n), faction, side, power ?? 1, now);
    return id;
  });
}
const mods = async (n) => (await C[n]('/profile?pseudo=' + n)).d.mods || [];
const perk = (ms, k) => ms.find((m) => m.type === 'perk' && m.perk === k);
const terrOf = (map, id) => map.territories.find((t) => t.id === id);

(async () => {
  try {
    await start({ TEST_NO_FATIGUE: '1' });
    await mk('Rouge1', 'rouge'); await mk('Rouge2', 'rouge');
    await mk('Bleu1', 'bleue'); await mk('Bleu2', 'bleue');
    await mk('Jaune1', 'jaune');

    console.log('# Carte de départ : personne en tête ni en perdition');
    let ms = await mods('Rouge1');
    check('Lions 19, Aigles 17, Cerfs 15 : pas de faction en tête (il faut 20 % au-dessus de la moyenne)', !perk(ms, 'bounty') && !perk(ms, 'desperation') && !perk(ms, 'coalition'), JSON.stringify(ms.filter((m) => m.type === 'perk')));

    console.log('# Les Lions écrasent les Cerfs d\'or');
    crushDeer();
    const main = MAP.territories.filter((t) => !ANNEX.has(t.id));
    const avg = (17 + (19 + 15 - KEEP.length) + KEEP.length) / 3;
    const desp = Math.min(CB.desperation.max, Math.round(CB.desperation.perTerritory * (avg - KEEP.length)));
    ms = await mods('Jaune1');
    check(`Force du désespoir pour les Cerfs : +${desp} %`, perk(ms, 'desperation')?.n === desp && perk(ms, 'desperation').hp === CB.desperation.hpLessLoss, JSON.stringify(perk(ms, 'desperation')));
    check('… et ils sont dans la coalition contre les Lions', perk(ms, 'coalition')?.faction === 'bleue');
    ms = await mods('Rouge1');
    check('Aigles : prime sur le leader (les Lions) et coalition', perk(ms, 'bounty')?.faction === 'bleue' && perk(ms, 'bounty').n === CB.bounty.rewardPct && perk(ms, 'coalition')?.faction === 'bleue', JSON.stringify(ms.filter((m) => m.type === 'perk')));
    ms = await mods('Bleu1');
    check('les Lions n\'ont ni prime, ni désespoir, ni coalition', !perk(ms, 'bounty') && !perk(ms, 'desperation') && !perk(ms, 'coalition'));

    // Puissance : une attaque des Cerfs (puissance d'action 1) vaut 1 + désespoir.
    run("UPDATE generals SET status = 'dead' WHERE faction = 'jaune' AND gid != 'claude'"); // pas d'aura de Moine (Marianne) à côté
    place('Jaune1', 'kupala');
    battle('kupala', 'jaune', 'bleue', [['Jaune1', 'attack', 'jaune', 1]], 600000);
    let map = (await C.Jaune1('/map')).d;
    check(`la puissance des Cerfs est relevée de ${desp} %`, Math.abs(terrOf(map, 'kupala').battle.power.attack - (1 + desp / 100)) < 0.011, String(terrOf(map, 'kupala').battle.power.attack));
    run('DELETE FROM battles; DELETE FROM contributions');

    console.log('# Coalition');
    // Les Lions attaquent Nilsson (Cerfs) : un Aigle présent peut le défendre.
    place('Rouge1', 'nilsson');
    battle('nilsson', 'bleue', 'jaune', [['Bleu1', 'attack', 'bleue', 1]], 600000);
    let r = await C.Rouge1('/act', { action: 'defend' });
    check('un Aigle défend un territoire des Cerfs attaqué par les Lions', r.s === 200, JSON.stringify(r.d.error));
    check('la défense compte pour les Aigles dans la bataille', !!row("SELECT 1 FROM contributions WHERE user_id = ? AND side = 'defense' AND faction = 'rouge'", uid('Rouge1')));
    run('DELETE FROM battles; DELETE FROM contributions');
    // Déplacement : depuis une terre des Cerfs, entrer sur une autre terre des Cerfs voisine.
    place('Rouge1', 'edmund');
    r = await C.Rouge1('/move', { to: 'nilsson' });
    check('un Aigle se déplace sur les terres des Cerfs (alliés de coalition)', r.s === 200, JSON.stringify(r.d.error));

    console.log('# Prime sur le leader');
    const target = MAP.territories.find((t) => t.faction === 'bleue' && !ANNEX.has(t.id) && t.id !== 'blaiddyd' && (t.neighbors || []).length).id;
    place('Rouge1', target);
    const imp = terrOf((await C.Rouge1('/map')).d, target).importance;
    battle(target, 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge', 50]]);
    await sleep(2300);
    await C.Rouge1('/map');
    const note = (await C.Rouge1('/notifications')).d.notifications.find((x) => x.type === 'territory_conquered');
    const expGold = Math.round(GAME.campaign.attackRewards.gold * imp * (1 + CB.bounty.rewardPct / 100));
    check(`territoire pris aux Lions : +${CB.bounty.rewardPct} % d'or (${expGold})`, note && note.params.gold === expGold, JSON.stringify(note?.params));
    check('compté pour les points de faction (prime)', row("SELECT count FROM faction_progress WHERE faction = 'rouge' AND key = 'bounty'")?.count === 1);

    console.log('# Lignes de ravitaillement');
    resetMap(); crushDeer();
    for (const n of ['Bleu1', 'Bleu2']) place(n, 'blaiddyd');
    map = (await C.Bleu1('/map')).d;
    const nb = (id) => new Set([...(MAP.territories.find((t) => t.id === id)?.neighbors || []), ...MAP.territories.filter((t) => (t.neighbors || []).includes(id)).map((t) => t.id)]);
    const dist = new Map([['blaiddyd', 0]]);
    let front = ['blaiddyd'];
    for (let d = 1; front.length; d += 1) { const nx = []; for (const id of front) for (const n of nb(id)) if (!dist.has(n)) { dist.set(n, d); nx.push(n); } front = nx; }
    const far = map.territories.find((t) => t.faction === 'bleue' && (dist.get(t.id) ?? 99) > CB.supply.distance);
    const near = map.territories.find((t) => t.faction === 'bleue' && dist.get(t.id) === 1);
    check('territoire des Lions loin de leurs joueurs : ravitaillement coupé', far && far.supplyCut === true, far?.id);
    check('territoire proche de leurs joueurs : ravitaillé', near && near.supplyCut === false, near?.id);
    check('les autres factions ne sont pas concernées', !map.territories.some((t) => t.faction !== 'bleue' && t.supplyCut));

    console.log('# Désespoir : moins de PV perdus en défaite');
    place('Jaune1', 'nilsson');
    battle('nilsson', 'bleue', 'jaune', [['Bleu1', 'attack', 'bleue', 50], ['Jaune1', 'defense', 'jaune', 1]]);
    await sleep(2300);
    await C.Jaune1('/map');
    const maxS = GAME.campaign.hp.max.base;
    check(`défenseur des Cerfs vaincu : ${GAME.campaign.hp.loss.defenseLoss} - ${CB.desperation.hpLessLoss} PV`, hpPts('Jaune1') === maxS - (GAME.campaign.hp.loss.defenseLoss - CB.desperation.hpLessLoss), String(hpPts('Jaune1')));

    console.log('# Généraux en renfort');
    resetMap(); crushDeer();
    run("UPDATE generals SET territory = 'edmund', status = 'alive', actions = 4, move_turn = -1, hp_pts = NULL, reinforcing = NULL WHERE gid = 'marianne'");
    const bid = battle('nilsson', 'bleue', 'jaune', [['Bleu1', 'attack', 'bleue', 80]], 2500);
    await C.Bleu1('/map');
    await sleep(300);
    await C.Bleu1('/map');
    const gr = row("SELECT territory, reinforcing FROM generals WHERE gid = 'marianne'");
    check('Marianne (Cerfs en perdition) vient défendre Nilsson, voisin de chez elle', gr.territory === 'nilsson' && gr.reinforcing === bid && !!row("SELECT 1 FROM general_contribs WHERE gid = 'marianne' AND side = 'defense'"), JSON.stringify(gr));
    run("UPDATE generals SET hp_pts = 2 WHERE gid = 'marianne'"); // blessée pendant le combat
    await sleep(2800);
    await C.Bleu1('/map');
    const g2 = row("SELECT territory, status, hp_pts, reinforcing FROM generals WHERE gid = 'marianne'");
    check('renfort perdu : elle se replie chez elle, vivante, PV restaurés', g2.status === 'alive' && g2.territory === 'edmund' && g2.hp_pts === null && g2.reinforcing === null, JSON.stringify(g2));
    check('journal du repli', !!row("SELECT 1 FROM world_events WHERE type = 'general_fallback'"));

    console.log('# Fatigue');
    await restart({ TEST_NO_FATIGUE: '0' });
    resetMap();
    const F = GAME.campaign.hp.fatigue;
    // Deux attaques déjà menées dans la fenêtre : la troisième coûte 1 PV de plus.
    withDb((d) => {
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const now = Date.now();
      for (let i = 0; i < F.free; i += 1) {
        const id = Number(d.prepare("INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at, resolved_at, success) VALUES (?, 'gerth', 'bleue', 'rouge', 0, ?, ?, ?, 0)").run(cid, now - 60000, now - 1000, now - 1000).lastInsertRowid);
        d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, 'gerth', ?, 'bleue', 'attack', 1, ?, NULL, 'action', 0)").run(id, uid('Bleu2'), now - 60000);
      }
    });
    ms = await mods('Bleu2');
    check(`après ${F.free} attaques, la suivante coûtera ${F.perBattle} PV de plus (affiché)`, perk(ms, 'fatigue')?.n === F.perBattle, JSON.stringify(perk(ms, 'fatigue')));
    const t3 = MAP.territories.find((t) => t.faction === 'rouge' && !ANNEX.has(t.id) && !GAME.generals.roster.some((g) => g.home === t.id)).id;
    place('Bleu2', t3);
    battle(t3, 'bleue', 'rouge', [['Bleu2', 'attack', 'bleue', 50]]);
    await sleep(2300);
    await C.Bleu2('/map');
    check(`3e attaque gagnée : ${GAME.campaign.hp.loss.attackWin} + ${F.perBattle} PV perdus`, hpPts('Bleu2') === maxS - GAME.campaign.hp.loss.attackWin - F.perBattle, String(hpPts('Bleu2')));
    ms = await mods('Rouge2');
    check('sans attaques récentes, pas de fatigue', !perk(ms, 'fatigue'));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
