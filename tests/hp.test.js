// Teste les points de vie : activation, PV max, pertes en fin de bataille, malus de puissance, mise hors de combat à 0 PV,
// régénération, Infirmerie, action Soigner, fioles, usure et soins des généraux, profils, et la prime de renommée.
// Usage : node tests/hp.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3126;
const GAME = require(path.join(process.cwd(), 'public', 'config', 'game.json'));
const HP = GAME.campaign.hp;
let server;
const start = (env = {}) => {
  const base = { ...process.env };
  delete base.HP_ON;
  delete base.LEVEL_UP_GOLD;
  server = spawn(process.execPath, [serverFile], {
    env: { ...base, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', TEST_REL_ROLL: '0.999', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
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
const mk = async (name, faction, klass = 'soldier') => {
  C[name] = client();
  const pw = 'mot-de-passe-' + name;
  await C[name]('/register', { email: `${name.toLowerCase()}@example.test`, password: pw, passwordConfirm: pw });
  const r = await C[name]('/character', { pseudo: name, birthday: '1995-04-12', class: klass, avatar: 'avatar_1.webp', faction });
  if (r.s !== 201) throw new Error(JSON.stringify(r.d));
};
const uid = (n) => withDb((d) => d.prepare('SELECT user_id FROM characters WHERE pseudo = ?').get(n).user_id);
const row = (sql, ...a) => withDb((d) => d.prepare(sql).get(...a));
const run = (sql, ...a) => withDb((d) => d.prepare(sql).run(...a));
const set = (n, sql, ...a) => withDb((d) => d.prepare(sql).run(...a, uid(n)));
const hpOf = (n) => row('SELECT hp FROM player_state WHERE user_id = ?', uid(n)).hp;
const genHp = (g) => row('SELECT hp, status FROM generals WHERE gid = ?', g);
const near = (a, b, eps = 0.002) => Math.abs(a - b) < eps;
const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json'));
const resetMap = () => withDb((d) => { const up = d.prepare('UPDATE territories SET faction = ? WHERE id = ?'); for (const t of MAP.territories) up.run(t.faction || null, t.id); d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM general_verdicts'); });
function battle(territory, attacker, defender, contribs, endsIn = 600000, gens = []) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, territory, attacker, defender, now, now + endsIn).lastInsertRowid);
    for (const [n, side, faction] of contribs) d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'action', 0)").run(id, territory, uid(n), faction, side, now);
    for (const [gid, side] of gens) d.prepare('INSERT INTO general_contribs (battle_id, gid, side, power) VALUES (?, ?, ?, 1)').run(id, gid, side);
    return id;
  });
}
const tierOf = (id) => GAME.classes.find((c) => c.id === id)?.tier;
const maxOf = (id) => (HP.max[tierOf(id)] ?? HP.max.base) + (HP.sturdy.classes.includes(id) ? HP.sturdy.bonus : 0) + (HP.frail.classes.includes(id) ? HP.frail.bonus : 0);
const genClass = (gid) => GAME.generals.roster.find((g) => g.id === gid).path.at(-1);

(async () => {
  try {
    console.log('# PV désactivés (saison en cours)');
    await start();
    await mk('Rouge1', 'rouge'); await mk('Rouge2', 'rouge', 'monk'); await mk('Bleu1', 'bleue');
    let m = (await C.Rouge1('/map')).d;
    check('pas de PV avant la nouvelle saison', m.player.hp === null, JSON.stringify(m.player.hp));
    check('les présents n\'ont pas de PV', m.territories.flatMap((x) => x.occupants).every((o) => o.hp === null));
    let r = await C.Rouge2('/act', { action: 'heal' });
    check('Soigner refusé sans PV', r.s === 409 && r.d.error === 'invalid_action', JSON.stringify(r.d));
    set('Rouge1', 'UPDATE characters SET gold = 5000 WHERE user_id = ?');
    set('Rouge1', "UPDATE player_state SET territory = 'hresvelg', actions = 8, actions_at = ? WHERE user_id = ?", Date.now());
    r = await C.Rouge1('/act', { action: 'build', spec: 'infirmary' });
    check('Infirmerie refusée sans PV', r.s === 409, JSON.stringify(r.d));

    console.log('# Prime de renommée');
    set('Rouge1', "UPDATE characters SET gold = 0, xp = 95 WHERE user_id = ?");
    r = await C.Rouge1('/act', { action: 'gather' });
    check('niveau 1 atteint : 40 or de récolte + 100 or de prime', r.s === 200 && r.d.character.renown.level === 1 && r.d.character.gold === 140, JSON.stringify([r.d.error, r.d.character?.gold, r.d.character?.renown]));
    const notif = row("SELECT type, params FROM notifications WHERE user_id = ? AND type = 'renown_gold' ORDER BY id DESC", uid('Rouge1'));
    check('notification de la prime', !!notif && JSON.parse(notif.params).gold === 100, JSON.stringify(notif));
    // Plusieurs niveaux d'un coup : chaque niveau paie sa prime (niveau 2 : 200, niveau 3 : 300).
    set('Rouge1', "UPDATE characters SET gold = 0, xp = 100 WHERE user_id = ?");
    set('Rouge1', "UPDATE player_state SET actions = 8, actions_at = ? WHERE user_id = ?", Date.now());
    const need = row('SELECT 1 AS x').x && (100 + 110 + 121); // XP cumulée pour le niveau 3
    set('Rouge1', 'UPDATE characters SET xp = ? WHERE user_id = ?', need - 5);
    set('Rouge1', "UPDATE characters SET gold = 0 WHERE user_id = ?");
    const lvlBefore = (await C.Rouge1('/me')).d.character.renown.level;
    r = await C.Rouge1('/act', { action: 'gather' });
    check('un niveau de plus paie 100 × le nouveau niveau', r.d.character.gold === 40 + 100 * (lvlBefore + 1), JSON.stringify([lvlBefore, r.d.character.renown.level, r.d.character.gold]));
    // Exilé : la prime est réduite comme ses autres gains.
    set('Bleu1', "UPDATE player_state SET exile_faction = 'rouge' WHERE user_id = ?");
    set('Bleu1', 'UPDATE characters SET gold = 0, xp = 95 WHERE user_id = ?');
    set('Bleu1', "UPDATE player_state SET territory = 'hresvelg', actions = 8, actions_at = ?, status = 'alive' WHERE user_id = ?", Date.now());
    r = await C.Bleu1('/act', { action: 'gather' });
    const em = GAME.campaign.exile.rewardMultiplier;
    check('exilé : prime réduite', r.s === 200 && r.d.character.gold === Math.round(40 * em) + Math.round(100 * em), JSON.stringify([r.d.error, r.d.character?.gold]));
    set('Bleu1', 'UPDATE player_state SET exile_faction = NULL WHERE user_id = ?');

    console.log('# Activation à la nouvelle saison');
    run("INSERT INTO campaign_meta (key, value) VALUES ('hp_from', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    m = (await C.Rouge1('/map')).d;
    check('PV actifs une fois la saison commencée', m.player.hp && m.player.hp.hp === 30 && m.player.hp.max === 30, JSON.stringify(m.player.hp));
    await stop();

    console.log('# PV actifs');
    await start({ HP_ON: '1', TEST_HP_ROLL: '0.99' });
    // Dorothea (Danseuse) soigne à Hresvelg : on l'écarte pour mesurer les PV sans ses soins.
    run("UPDATE generals SET status = 'dead' WHERE gid = 'dorothea'");
    m = (await C.Rouge2('/map')).d;
    check('moine : 30 - 4 = 26 PV, soigne 6 (3 sur lui-même)', m.player.hp.max === 26 && m.player.hp.heal === 6 && m.player.hp.selfHeal === 3, JSON.stringify(m.player.hp));
    check('les présents ont leurs PV en %', m.territories.flatMap((x) => x.occupants).every((o) => o.hp === 100));

    // Attaque gagnée : -5 ; défense perdue : -10.
    resetMap();
    set('Rouge1', "UPDATE player_state SET territory = 'rowe', status = 'alive', hp = 1 WHERE user_id = ?");
    set('Bleu1', "UPDATE player_state SET territory = 'rowe', status = 'alive', hp = 1 WHERE user_id = ?");
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge'], ['Bleu1', 'defense', 'bleue']], -1000);
    await C.Rouge1('/map');
    check('attaque gagnée : -5 PV (25/30)', near(hpOf('Rouge1'), 25 / 30), String(hpOf('Rouge1') * 30));
    check('défense perdue : -10 PV (20/30)', near(hpOf('Bleu1'), 20 / 30), String(hpOf('Bleu1') * 30));

    // Malus de puissance.
    resetMap();
    set('Rouge1', "UPDATE player_state SET territory = 'rowe', status = 'alive', hp = 0.4 WHERE user_id = ?");
    set('Bleu1', "UPDATE player_state SET territory = 'blaiddyd', status = 'alive' WHERE user_id = ?");
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge']]);
    let b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('sous 50 % de PV : puissance ×0,9', near(b.power.attack, 0.9, 0.011), String(b.power.attack));
    set('Rouge1', 'UPDATE player_state SET hp = 0.2 WHERE user_id = ?');
    b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('sous 25 % de PV : puissance ×0,8', near(b.power.attack, 0.8, 0.011), String(b.power.attack));
    let pr = await C.Bleu1('/profile?pseudo=Rouge1');
    check('profil : PV et malus affichés', pr.d.hp && pr.d.hp.hp === 6 && pr.d.mods.some((x) => x.type === 'hpLow' && x.pct === 20), JSON.stringify([pr.d.hp, pr.d.mods?.filter((x) => x.type === 'hpLow')]));

    // À 0 PV : mise hors de combat, retour à 50 %.
    resetMap();
    set('Rouge1', "UPDATE player_state SET territory = 'rowe', status = 'alive', hp = ?, actions = 5 WHERE user_id = ?", 4 / 30);
    set('Rouge1', 'UPDATE characters SET gold = 1000 WHERE user_id = ?');
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge']], -1000);
    m = (await C.Rouge1('/map')).d;
    check('0 PV : renvoyé à la capitale, actions vidées', m.player.territory === 'hresvelg' && m.player.actions === 0 && m.player.status === 'alive', JSON.stringify([m.player.territory, m.player.actions, m.player.status]));
    check('0 PV : retour à 50 % de PV', near(hpOf('Rouge1'), 0.5), String(hpOf('Rouge1')));
    const fh = row("SELECT params FROM notifications WHERE user_id = ? AND type = 'fallen_hp'", uid('Rouge1'));
    check('0 PV : notification « à bout de forces » avec l\'or perdu', !!fh && JSON.parse(fh.params).gold === 100, JSON.stringify(fh));

    // Régénération : +4/h sur un territoire allié sans bataille, +2/h ailleurs, plus l'Infirmerie.
    resetMap();
    set('Rouge1', "UPDATE player_state SET territory = 'hresvelg', status = 'alive', hp = 0.5 WHERE user_id = ?");
    set('Bleu1', "UPDATE player_state SET territory = 'hresvelg', status = 'alive', hp = 0.5 WHERE user_id = ?");
    run("UPDATE campaign_meta SET value = ? WHERE key = 'hp_tick'", String(Date.now() - 3_600_000));
    await C.Rouge1('/map');
    check('régénération en territoire allié : +6 PV/h', near(hpOf('Rouge1'), 0.5 + 6 / 30, 0.003), String(hpOf('Rouge1') * 30));
    check('régénération en territoire ennemi : +3 PV/h', near(hpOf('Bleu1'), 0.5 + 3 / 30, 0.003), String(hpOf('Bleu1') * 30));
    set('Rouge1', "UPDATE player_state SET actions = 8, actions_at = ? WHERE user_id = ?", Date.now());
    set('Rouge1', 'UPDATE characters SET gold = 5000 WHERE user_id = ?');
    r = await C.Rouge1('/act', { action: 'build', spec: 'infirmary' });
    check('Infirmerie construite', r.s === 200 && r.d.map.territories.find((x) => x.id === 'hresvelg').build?.spec === 'infirmary', JSON.stringify([r.s, r.d.error]));
    set('Rouge1', 'UPDATE player_state SET hp = 0.5 WHERE user_id = ?');
    run("UPDATE campaign_meta SET value = ? WHERE key = 'hp_tick'", String(Date.now() - 3_600_000));
    await C.Rouge1('/map');
    check('Infirmerie niveau 1 : +6 +2 PV/h', near(hpOf('Rouge1'), 0.5 + 8 / 30, 0.003), String(hpOf('Rouge1') * 30));
    pr = await C.Rouge1('/profile?pseudo=Rouge1');
    check('autres sources : Infirmerie', pr.d.others.items.some((x) => x.type === 'building' && x.spec === 'infirmary' && x.pct === 2), JSON.stringify(pr.d.others.items));
    run('DELETE FROM territory_builds');

    console.log('# Soigner');
    set('Rouge1', "UPDATE player_state SET territory = 'hresvelg', status = 'alive', hp = 0.5 WHERE user_id = ?");
    set('Rouge2', "UPDATE player_state SET territory = 'hresvelg', status = 'alive', hp = 1, actions = 8, actions_at = ? WHERE user_id = ?", Date.now());
    set('Rouge2', 'UPDATE characters SET xp = 0 WHERE user_id = ?');
    r = await C.Rouge2('/act', { action: 'heal', target: 'Rouge1' });
    check('le moine soigne un allié : +6 PV, 1 action', r.s === 200 && near(hpOf('Rouge1'), 0.5 + 6 / 30) && r.d.player.actions === 7, JSON.stringify([r.d.error, hpOf('Rouge1') * 30, r.d.player?.actions]));
    check('soigner un allié rapporte de la renommée', r.d.character.xp === HP.healXp, String(r.d.character?.xp));
    check('effet affiché', (r.d.relFx || []).some((x) => x.kind === 'healed' && x.name === 'Rouge1' && x.hp === 6), JSON.stringify(r.d.relFx));
    check('le soigné est prévenu', !!row("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'healed_by'", uid('Rouge1')));
    r = await C.Rouge2('/act', { action: 'heal' });
    check('soi-même à pleine santé : refusé', r.s === 409 && r.d.error === 'hp_full', JSON.stringify(r.d));
    set('Rouge2', 'UPDATE player_state SET hp = 0.5 WHERE user_id = ?');
    r = await C.Rouge2('/act', { action: 'heal' });
    check('soi-même : +3 PV', r.s === 200 && near(hpOf('Rouge2'), 0.5 + 3 / 26), String(hpOf('Rouge2') * 26));
    r = await C.Rouge2('/act', { action: 'heal', target: 'Bleu1' });
    check('un ennemi ne peut pas être soigné', r.s === 409 && r.d.error === 'heal_target', JSON.stringify(r.d));
    set('Rouge1', "UPDATE player_state SET territory = 'aegir' WHERE user_id = ?");
    r = await C.Rouge2('/act', { action: 'heal', target: 'Rouge1' });
    check('un allié ailleurs ne peut pas être soigné', r.s === 409 && r.d.error === 'heal_target', JSON.stringify(r.d));
    r = await C.Rouge1('/act', { action: 'heal' });
    check('un soldat ne sait pas soigner', r.s === 409 && r.d.error === 'invalid_action', JSON.stringify(r.d));
    // Soigner un général allié présent.
    run("UPDATE generals SET hp = 0.5, territory = 'hresvelg', move_turn = 999999999999 WHERE gid = 'ferdinand'"); // il ne rentre pas chez lui
    r = await C.Rouge2('/act', { action: 'heal', target: 'g:ferdinand' });
    const fMax = maxOf(genClass('ferdinand'));
    check('soigner un général allié présent', r.s === 200 && near(genHp('ferdinand').hp, 0.5 + 6 / fMax), JSON.stringify([r.d.error, genHp('ferdinand')]));
    run("UPDATE generals SET hp = 1, territory = 'aegir', move_turn = -1 WHERE gid = 'ferdinand'");

    console.log('# Fioles');
    set('Rouge1', "UPDATE player_state SET territory = 'hresvelg', hp = 0.2, vial_day = NULL, vial_n = 0 WHERE user_id = ?");
    set('Rouge1', 'UPDATE characters SET gold = 1000 WHERE user_id = ?');
    r = await C.Rouge1('/act', { action: 'vial' });
    check('fiole : -150 or, +8 PV, sans action', r.s === 200 && r.d.character.gold === 850 && near(hpOf('Rouge1'), 0.2 + 8 / 30) && r.d.player.hp.vial.left === 2, JSON.stringify([r.d.error, r.d.character?.gold, r.d.player?.hp?.vial]));
    await C.Rouge1('/act', { action: 'vial' });
    await C.Rouge1('/act', { action: 'vial' });
    set('Rouge1', 'UPDATE player_state SET hp = 0.2 WHERE user_id = ?');
    r = await C.Rouge1('/act', { action: 'vial' });
    check('3 fioles par jour au maximum', r.s === 409 && r.d.error === 'vial_limit', JSON.stringify(r.d));
    set('Rouge1', "UPDATE player_state SET vial_day = NULL, vial_n = 0, hp = 1 WHERE user_id = ?");
    r = await C.Rouge1('/act', { action: 'vial' });
    check('fiole refusée à pleine santé', r.s === 409 && r.d.error === 'hp_full', JSON.stringify(r.d));

    console.log('# Généraux');
    resetMap();
    run("UPDATE generals SET hp = 1 WHERE gid = 'ferdinand'");
    battle('rowe', 'rouge', 'bleue', [], -1000, [['ferdinand', 'attack']]);
    await C.Rouge1('/map');
    check('un général vainqueur perd aussi des PV (Ferdinand, Paladin : 5 - 2)', near(genHp('ferdinand').hp, 1 - 3 / fMax), JSON.stringify(genHp('ferdinand')));
    resetMap();
    run("UPDATE generals SET hp = ?, territory = 'aegir', status = 'alive' WHERE gid = 'ferdinand'", 3 / fMax);
    battle('rowe', 'rouge', 'bleue', [], -1000, [['ferdinand', 'attack']]);
    await C.Rouge1('/map');
    check('à 0 PV, un général meurt d\'épuisement', genHp('ferdinand').status === 'dead', JSON.stringify(genHp('ferdinand')));
    check('journal : mort d\'épuisement', (await C.Rouge1('/journal')).d.events.some((e) => e.type === 'general_exhausted' && e.params.general === 'ferdinand'));
    resetMap();
    const eMax = maxOf(genClass('edelgard'));
    run("UPDATE generals SET hp = ? WHERE gid = 'edelgard'", 1 / eMax);
    battle('rowe', 'rouge', 'bleue', [], -1000, [['edelgard', 'attack']]);
    await C.Rouge1('/map');
    check('un seigneur reste debout à 1 PV', genHp('edelgard').status === 'alive' && near(genHp('edelgard').hp, 1 / eMax), JSON.stringify(genHp('edelgard')));
    pr = await C.Rouge1('/profile?general=edelgard');
    check('profil d\'un général : PV et malus', pr.d.hp && pr.d.hp.hp === 1 && pr.d.mods.some((x) => x.type === 'hpLow'), JSON.stringify([pr.d.hp]));
    run("UPDATE generals SET hp = 1 WHERE gid = 'edelgard'");
    // Linhardt (Évêque) soigne un allié blessé sur son territoire.
    resetMap();
    const lin = row("SELECT territory FROM generals WHERE gid = 'linhardt'").territory;
    set('Rouge1', "UPDATE player_state SET territory = ?, status = 'alive', hp = 0.3 WHERE user_id = ?", lin);
    run("UPDATE generals SET actions = 4, move_turn = -1 WHERE gid = 'linhardt'");
    await C.Rouge1('/map');
    check('un général soigneur soigne un allié blessé sur place', hpOf('Rouge1') >= 0.3 + HP.heal.bishop / 30 - 0.002, String(hpOf('Rouge1') * 30));

    console.log('# Effets de classe sur les PV');
    const setClass = (n, path) => set(n, 'UPDATE characters SET class = ?, class_path = ? WHERE user_id = ?', path.at(-1), JSON.stringify(path));
    const fight = async (attackers, defenders) => {
      resetMap();
      for (const n of [...attackers, ...defenders]) set(n, "UPDATE player_state SET territory = 'rowe', status = 'alive', hp = 0.5 WHERE user_id = ?");
      battle('rowe', 'rouge', 'bleue', [...attackers.map((n) => [n, 'attack', 'rouge']), ...defenders.map((n) => [n, 'defense', 'bleue'])], -1000);
      await C.Rouge1('/map');
    };
    // Paladin : lui et ses alliés du même côté perdent 2 PV de moins.
    setClass('Rouge1', ['soldier', 'cavalier', 'paladin']);
    setClass('Rouge2', ['monk']);
    await fight(['Rouge1', 'Rouge2'], []);
    check('Paladin : il perd 5 - 2 = 3 PV', near(hpOf('Rouge1'), 0.5 - 3 / maxOf('paladin')), String(hpOf('Rouge1') * maxOf('paladin')));
    check('Paladin : son allié aussi (3 PV)', near(hpOf('Rouge2'), 0.5 - 3 / maxOf('monk')), String(hpOf('Rouge2') * maxOf('monk')));
    // Guerrier : +5 PV après une victoire (5 perdus, 5 regagnés).
    setClass('Rouge1', ['fighter', 'warrior']);
    await fight(['Rouge1'], []);
    check('Guerrier : regagne 5 PV après la victoire', near(hpOf('Rouge1'), 0.5), String(hpOf('Rouge1') * maxOf('warrior')));
    // Archer d'élite : les ennemis vaincus perdent 3 PV de plus.
    setClass('Rouge1', ['soldier', 'archer', 'sniper']);
    await fight(['Rouge1'], ['Bleu1']);
    check('Archer d\'élite : le défenseur vaincu perd 10 + 3 PV', near(hpOf('Bleu1'), 0.5 - 13 / 30), String(hpOf('Bleu1') * 30));
    // Baladin : vol de vie, 3 PV par ennemi (un défenseur ici).
    setClass('Rouge1', ['myrmidon', 'thief', 'assassin', 'trickster']);
    await fight(['Rouge1'], ['Bleu1']);
    check('Baladin : perd 5, regagne 3', near(hpOf('Rouge1'), 0.5 - 2 / maxOf('trickster')), String(hpOf('Rouge1') * maxOf('trickster')));
    // Bretteur : sans esquive (tirage défavorable), la perte normale.
    setClass('Rouge1', ['myrmidon', 'mercenary', 'swordsmaster']);
    await fight(['Rouge1'], []);
    check('Bretteur sans esquive : perte normale', near(hpOf('Rouge1'), 0.5 - 5 / maxOf('swordsmaster')), String(hpOf('Rouge1') * maxOf('swordsmaster')));
    await stop();
    await start({ HP_ON: '1', TEST_HP_ROLL: '0' });
    await fight(['Rouge1'], []);
    check('Bretteur : esquive, aucun PV perdu', near(hpOf('Rouge1'), 0.5), String(hpOf('Rouge1') * maxOf('swordsmaster')));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
