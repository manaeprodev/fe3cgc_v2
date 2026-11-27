'use strict';
// Distinctions à paliers (rattrapage, paliers, notifications, profil, compteurs) et Strike down! (frapper un vaincu en repli).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3131;
const GAME = require(path.join(process.cwd(), 'public', 'config', 'game.json'));
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_ROLL: '0.999', TEST_MOVE_ROLL: '0.999', TEST_HP_ROLL: '0', HP_ON: '1', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
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
const setEv = (n, ev, v) => run('INSERT INTO player_events (user_id, event, count) VALUES (?, ?, ?) ON CONFLICT (user_id, event) DO UPDATE SET count = excluded.count', uid(n), ev, v);
const ev = (n, e) => row('SELECT count FROM player_events WHERE user_id = ? AND event = ?', uid(n), e)?.count || 0;
const tierOf = (feats, id) => (feats.find((x) => x.id === id) || {}).tier || 0;
const notes = async (n) => (await C[n]('/notifications')).d.notifications;
const hpPts = (n) => row('SELECT hp_pts FROM player_state WHERE user_id = ?', uid(n)).hp_pts;
const maxOf = (cls) => GAME.campaign.hp.max[GAME.classes.find((c) => c.id === cls).tier] + (GAME.campaign.hp.sturdy?.classes?.includes(cls) ? GAME.campaign.hp.sturdy.bonus : 0) - (GAME.campaign.hp.frail?.classes?.includes(cls) ? GAME.campaign.hp.frail.bonus : 0);

(async () => {
  try {
    await start();
    for (const n of ['Rouge1', 'Rouge2', 'Rouge3']) await mk(n, 'rouge');
    for (const n of ['Bleu1', 'Bleu2', 'Bleu3']) await mk(n, 'bleue');

    console.log('# Distinctions à paliers');
    check('47 distinctions dans la config, dont Coupe-gorge', GAME.feats.length === 47 && GAME.feats.some((f) => f.id === 'cutthroat' && f.value === 'stat:strikes'));
    let r = await C.Rouge1('/feats');
    check('aucune distinction au départ', r.s === 200 && r.d.feats.length === 0 && r.d.progress.headhunter === 0, JSON.stringify(r.d.feats));
    // Rattrapage : des compteurs déjà remplis donnent leurs paliers d'un coup (une seule notification groupée).
    const cid = row('SELECT id FROM campaigns WHERE ended_at IS NULL').id;
    setEv('Rouge1', 'gather', 1200);
    setEv('Rouge1', 'gold_spent', 60000);
    run('INSERT INTO campaign_mission_progress (campaign_id, user_id, event, count) VALUES (?, ?, ?, ?)', cid - 1 > 0 ? cid - 1 : 0, uid('Rouge1'), 'general', 7);
    run('INSERT INTO campaign_mission_progress (campaign_id, user_id, event, count) VALUES (?, ?, ?, ?)', cid, uid('Rouge1'), 'general', 5);
    r = await C.Rouge1('/feats');
    check('rattrapage : Moissonneur II, Mécène II, Chasseur de têtes I (généraux cumulés sur les campagnes)', tierOf(r.d.feats, 'harvester') === 2 && tierOf(r.d.feats, 'patron') === 2 && tierOf(r.d.feats, 'headhunter') === 1, JSON.stringify(r.d.feats));
    check('progression renvoyée', r.d.progress.harvester === 1200 && r.d.progress.headhunter === 12, JSON.stringify([r.d.progress.harvester, r.d.progress.headhunter]));
    let ns = await notes('Rouge1');
    check('plus de 2 d\'un coup : une seule notification groupée', ns.filter((x) => x.type === 'feats_many').length === 1 && !ns.some((x) => x.type === 'feat'), JSON.stringify(ns.map((x) => x.type)));
    setEv('Rouge1', 'gather', 5000);
    r = await C.Rouge1('/feats');
    ns = await notes('Rouge1');
    const fn = ns.find((x) => x.type === 'feat');
    check('palier suivant : Moissonneur III, notification dédiée', tierOf(r.d.feats, 'harvester') === 3 && fn && fn.params.feat === 'harvester' && fn.params.tier === 3, JSON.stringify(fn));
    r = await C.Rouge1('/feats');
    check('pas de nouvelle notification sans nouveau palier', (await notes('Rouge1')).filter((x) => x.type === 'feat').length === 1);
    const pr = await C.Bleu1('/profile?pseudo=Rouge1');
    check('le profil montre les paliers', pr.s === 200 && tierOf(pr.d.feats, 'harvester') === 3 && tierOf(pr.d.feats, 'patron') === 2, JSON.stringify(pr.d.feats));
    const me = (await C.Rouge1('/me')).d;
    check('/me donne mes paliers', tierOf(me.feats, 'harvester') === 3, JSON.stringify(me.feats));
    // Valeurs calculées : renommée, avatars possédés.
    run('UPDATE characters SET xp = 100000 WHERE user_id = ?', uid('Rouge3'));
    r = await C.Rouge3('/feats');
    check('Légende vivante d\'après la renommée', tierOf(r.d.feats, 'living_legend') >= 1 && r.d.progress.living_legend >= 10, JSON.stringify(r.d.progress.living_legend));
    check('Collectionneur compte les avatars libres', r.d.progress.collector === GAME.avatars.free.length, String(r.d.progress.collector));

    console.log('# Bataille : siège brisé, Strike down!');
    const land = 'gerth';
    run("UPDATE territories SET faction = 'rouge' WHERE id = ?", land);
    run("UPDATE characters SET class = 'bow-knight', class_path = ? WHERE user_id = ?", JSON.stringify(['fighter', 'archer', 'sniper', 'bow-knight']), uid('Rouge2'));
    for (const n of ['Rouge1', 'Rouge2', 'Rouge3', 'Bleu1', 'Bleu2', 'Bleu3']) run("UPDATE player_state SET territory = ?, status = 'alive', actions = 8, actions_at = ?, hp_pts = NULL, retreat_until = NULL WHERE user_id = ?", land, Date.now(), uid(n));
    run('UPDATE characters SET gold = 1000 WHERE user_id IN (?, ?, ?)', uid('Bleu1'), uid('Bleu2'), uid('Bleu3'));
    const bid = withDb((d) => {
      const now = Date.now();
      const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, land, 'bleue', 'rouge', now, now + 1500).lastInsertRowid);
      const add = d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'action', 0)");
      for (const n of ['Bleu1', 'Bleu2', 'Bleu3']) add.run(id, land, uid(n), 'bleue', 'attack', now);
      for (const n of ['Rouge1', 'Rouge2']) add.run(id, land, uid(n), 'rouge', 'defense', now);
      return id;
    });
    await sleep(2200);
    let map = (await C.Rouge1('/map')).d;
    check('attaque repoussée', row('SELECT success FROM battles WHERE id = ?', bid).success === 0);
    check('Briseur de sièges : 2 défenseurs contre 3 attaquants', ev('Rouge1', 'siege_breaks') === 1 && ev('Rouge2', 'siege_breaks') === 1 && ev('Bleu1', 'siege_breaks') === 0);
    check('les attaquants doivent se replier', ['Bleu1', 'Bleu2', 'Bleu3'].every((n) => row('SELECT status FROM player_state WHERE user_id = ?', uid(n)).status === 'retreating'));
    const targets = (map.strikes || []).map((x) => x.pseudo).sort();
    check('Strike down! proposé au vainqueur : les 3 vaincus en repli, -3 PV', targets.join(',') === 'Bleu1,Bleu2,Bleu3' && map.strikes.every((x) => x.damage === 3), JSON.stringify(map.strikes));
    check('Cavalier archer : -5 PV', ((await C.Rouge2('/map')).d.strikes || []).every((x) => x.damage === 5));
    check('pas pour un allié qui n\'a pas combattu', ((await C.Rouge3('/map')).d.strikes || []).length === 0);
    check('pas pour un vaincu', ((await C.Bleu1('/map')).d.strikes || []).length === 0);
    const maxB = maxOf('soldier');
    const b1 = hpPts('Bleu1') ?? maxB;
    r = await C.Rouge1('/strike', { target: 'Bleu1' });
    check('frappe : Bleu1 perd 3 PV', r.s === 200 && r.d.strike.hp === 3 && !r.d.strike.ko && hpPts('Bleu1') === b1 - 3, JSON.stringify([r.s, r.d.error, r.d.strike, b1, hpPts('Bleu1')]));
    check('Bleu1 est prévenu', (await notes('Bleu1')).some((x) => x.type === 'struck_down' && x.params.pseudo === 'Rouge1' && x.params.hp === 3));
    r = await C.Rouge1('/strike', { target: 'Bleu1' });
    check('une seule frappe par cible et par bataille', r.s === 409 && r.d.error === 'strike_target', JSON.stringify(r.d));
    check('la cible frappée disparaît de la liste', !r.d.map && !((await C.Rouge1('/map')).d.strikes || []).some((x) => x.pseudo === 'Bleu1'));
    r = await C.Rouge3('/strike', { target: 'Bleu2' });
    check('un non-combattant ne peut pas frapper', r.s === 409);
    r = await C.Rouge2('/strike', { target: 'Bleu1' });
    check('un autre vainqueur peut frapper la même cible (Cavalier archer : -5)', r.s === 200 && r.d.strike.hp === 5 && hpPts('Bleu1') === b1 - 8, JSON.stringify([r.d.strike, hpPts('Bleu1')]));
    // À 0 PV : mise hors de combat (retour à la capitale, retour payant, actions vidées).
    run('UPDATE player_state SET hp_pts = 2 WHERE user_id = ?', uid('Bleu2'));
    const gold0 = row('SELECT gold FROM characters WHERE user_id = ?', uid('Bleu2')).gold;
    const deaths0 = row('SELECT coalesce(sum(deaths), 0) AS n FROM campaign_scores WHERE user_id = ?', uid('Bleu2')).n;
    r = await C.Rouge1('/strike', { target: 'Bleu2' });
    const ps2 = row('SELECT territory, status, actions FROM player_state WHERE user_id = ?', uid('Bleu2'));
    check('à 0 PV : mis hors de combat', r.s === 200 && r.d.strike.ko === true && r.d.strike.hp === 2, JSON.stringify(r.d.strike));
    check('… renvoyé à sa capitale, actions vidées', ps2.status === 'alive' && ps2.territory !== land && ps2.actions === 0, JSON.stringify(ps2));
    check('… il paie son retour (x2 après une attaque ratée) et compte une chute', row('SELECT gold FROM characters WHERE user_id = ?', uid('Bleu2')).gold < gold0
      && row('SELECT coalesce(sum(deaths), 0) AS n FROM campaign_scores WHERE user_id = ?', uid('Bleu2')).n === deaths0 + 1);
    check('… notification et journal', (await notes('Bleu2')).some((x) => x.type === 'fallen_hp') && row("SELECT 1 FROM world_events WHERE type = 'struck_down'") !== undefined);
    check('Coupe-gorge : 2 frappes comptées pour Rouge1', ev('Rouge1', 'strikes') === 2 && (await C.Rouge1('/feats')).d.progress.cutthroat === 2);
    console.log('# Fenêtre du patch à la campagne suivante');
    const P = GAME.patches[0];
    const prevTag = GAME.patches[1].rev ? `${GAME.patches[1].id}#${GAME.patches[1].rev}` : GAME.patches[1].id;
    let m1 = (await C.Rouge1('/me')).d;
    check('campagne en cours : révision actuelle, déjà lue par un nouveau compte', P.fromNextCampaign && m1.patch.latest === prevTag && m1.patch.seen === m1.patch.latest, JSON.stringify(m1.patch));
    withDb((d) => { d.prepare('UPDATE campaigns SET ended_at = ? WHERE ended_at IS NULL').run(new Date().toISOString()); d.prepare('INSERT INTO campaigns (started_at) VALUES (?)').run(new Date().toISOString()); });
    m1 = (await C.Rouge1('/me')).d;
    check('nouvelle campagne : le patch ' + P.id + ' s\'annonce à tout le monde (avec le rappel du précédent)', m1.patch.latest === P.id && m1.patch.seen !== m1.patch.latest && !!P.recap, JSON.stringify(m1.patch));
    await C.Rouge1('/patch/seen', {});
    check('une fois relue, elle ne revient plus', (await C.Rouge1('/me')).d.patch.seen === P.id);
    // Sans PV (HP_ON=0), pas de Strike down!.
    await stop();
    await start({ HP_ON: '0' });
    check('sans PV, Strike down! n\'est pas proposé', ((await C.Rouge1('/map')).d.strikes || []).length === 0);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
