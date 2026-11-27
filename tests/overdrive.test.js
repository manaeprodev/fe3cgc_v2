// Teste l'Overdrive de fin de campagne, le malus d'exil sur toutes les ressources, le compliment et le cadeau sur place,
// les généraux indépendants, les nouvelles classes de Catherine et Rhea, et la liste des bonus et malus des profils.
// Usage : node tests/overdrive.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3124;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', ...env },
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
const set = (n, sql, ...a) => withDb((d) => d.prepare(sql).run(...a, uid(n)));
const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json'));
const resetMap = () => withDb((d) => { const up = d.prepare('UPDATE territories SET faction = ? WHERE id = ?'); for (const t of MAP.territories) up.run(t.faction || null, t.id); d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM general_verdicts'); });
function battle(territory, attacker, defender, contribs, endsIn = 600000) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, territory, attacker, defender, now, now + endsIn).lastInsertRowid);
    for (const [n, side, faction] of contribs) d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'action', 0)").run(id, territory, uid(n), faction, side, now);
    return id;
  });
}

(async () => {
  try {
    console.log('# Sans Overdrive');
    await start();
    await mk('Rouge1', 'rouge'); await mk('Jaune1', 'jaune'); await mk('Bleu1', 'bleue');
    let m = (await C.Rouge1('/map')).d;
    check('pas d\'Overdrive loin de la clôture', m.overdrive === null && m.player.maxActions === 8, JSON.stringify([m.overdrive, m.player.maxActions]));

    console.log('# Classes');
    let pr = await C.Rouge1('/profile?general=catherine');
    check('Catherine est Bretteuse (swordsmaster)', pr.d.class === 'swordsmaster', pr.d.class);
    pr = await C.Rouge1('/profile?general=rhea');
    check('Rhea a la classe légendaire Sainte', pr.d.class === 'saint', pr.d.class);

    console.log('# Compliment et cadeau');
    set('Rouge1', 'UPDATE characters SET gold = 1000 WHERE user_id = ?');
    set('Rouge1', "UPDATE player_state SET actions = 8, actions_at = ?, territory = 'aegir' WHERE user_id = ?", Date.now());
    let r = await C.Rouge1('/relations/gift', { general: 'edelgard', kind: 'compliment' });
    check('compliment : +1 point, 1 action, pas d\'or', r.s === 200 && r.d.gift.points === 1 && r.d.player.actions === 7 && r.d.character.gold === 1000, JSON.stringify([r.d.gift, r.d.player?.actions, r.d.character?.gold]));
    r = await C.Rouge1('/relations/gift', { general: 'edelgard', kind: 'present' });
    check('cadeau : refusé loin du général', r.s === 409 && r.d.error === 'not_here', JSON.stringify(r.d));
    r = await C.Rouge1('/relations/gift', { general: 'ferdinand', kind: 'present' });
    check('cadeau sur place (Ferdinand à Aegir) : +10, gratuit', r.s === 200 && r.d.gift.points === 10 && r.d.player.actions === 7 && r.d.character.gold === 1000, JSON.stringify([r.d.gift, r.d.player?.actions]));
    check('le prochain cadeau est daté', r.d.relations.readyAt.present > Date.now() + 59 * 60000 && r.d.relations.here === 'aegir');
    r = await C.Rouge1('/relations/gift', { general: 'ferdinand', kind: 'present' });
    check('une fois par heure seulement', r.s === 429 && r.d.error === 'gift_cooldown');

    console.log('# Bonus et malus des profils');
    pr = await C.Bleu1('/profile?pseudo=Rouge1');
    check('la liste contient la classe du joueur', (pr.d.mods || []).some((x) => x.type === 'class' && x.class === 'soldier'), JSON.stringify(pr.d.mods));
    pr = await C.Rouge1('/profile?general=edelgard');
    check('un seigneur : règle du seigneur et effets de classe', pr.d.mods.some((x) => x.type === 'lordGen') && pr.d.mods.some((x) => x.type === 'class' && x.class === 'emperor'), JSON.stringify(pr.d.mods));
    withDb((d) => d.exec("INSERT INTO relations (user_id, gid, points) VALUES ((SELECT user_id FROM characters WHERE pseudo = 'Rouge1'), 'manuela', 300) ON CONFLICT (user_id, gid) DO UPDATE SET points = 300"));
    pr = await C.Bleu1('/profile?pseudo=Rouge1');
    check('… et les bonus de soutien actifs', pr.d.mods.some((x) => x.type === 'support' && x.general === 'manuela' && x.level === 'C'), JSON.stringify(pr.d.mods.filter((x) => x.type === 'support')));

    // Autres sources : aura de Ferdinand (Paladin, pour les Soldats) à Aegir, malus d'un Sorcier ennemi présent.
    set('Bleu1', "UPDATE player_state SET territory = 'aegir', status = 'alive' WHERE user_id = ?");
    withDb((d) => d.exec("UPDATE characters SET class = 'warlock', class_path = '[\"monk\",\"mage\",\"warlock\"]' WHERE pseudo = 'Bleu1'"));
    pr = await C.Bleu1('/profile?pseudo=Rouge1');
    const o = pr.d.others || {};
    const au = (o.items || []).find((x) => x.type === 'auras');
    check('autres sources : aura de Ferdinand', au && au.from.includes('Ferdinand') && au.pct >= 3, JSON.stringify(o));
    const dbf = (o.items || []).filter((x) => x.type === 'enemyDebuff');
    check('… et malus du Sorcier ennemi en attaque et en défense', dbf.length === 2 && dbf.every((x) => x.pct === 10 && x.from.includes('Bleu1')), JSON.stringify(dbf));
    check('… résumés en totaux d\'attaque et de défense', o.attackPct === au.pct - 10 && o.defensePct === au.pct - 10, JSON.stringify([o.attackPct, o.defensePct]));
    pr = await C.Rouge1('/profile?general=ferdinand');
    check('un général a aussi ses autres sources', pr.d.others && Array.isArray(pr.d.others.items), JSON.stringify(pr.d.others));
    withDb((d) => d.exec("UPDATE characters SET class = 'soldier', class_path = '[\"soldier\"]' WHERE pseudo = 'Bleu1'"));

    console.log('# Exil : toutes les ressources réduites');
    set('Bleu1', "UPDATE player_state SET exile_faction = 'rouge', territory = 'aegir', actions = 8, actions_at = ?, reward_debuff = 0 WHERE user_id = ?", Date.now());
    set('Bleu1', 'UPDATE characters SET gold = 0, xp = 0 WHERE user_id = ?');
    r = await C.Bleu1('/act', { action: 'gather' });
    check('récolte en exil : 20 or au lieu de 40', r.s === 200 && r.d.character.gold === 20, JSON.stringify([r.d.error, r.d.character?.gold]));
    pr = await C.Rouge1('/profile?pseudo=Bleu1');
    check('le malus d\'exil apparaît dans la liste', pr.d.mods.some((x) => x.type === 'exile' && x.pct === 50), JSON.stringify(pr.d.mods));
    set('Bleu1', 'UPDATE player_state SET exile_faction = NULL WHERE user_id = ?');

    console.log('# Généraux indépendants');
    resetMap();
    set('Rouge1', "UPDATE player_state SET territory = 'brigid', status = 'alive' WHERE user_id = ?");
    battle('brigid', 'rouge', null, [['Rouge1', 'attack', 'rouge']], 1500);
    await C.Rouge1('/map');
    check('Petra défend Brigid quand il est attaqué', !!row("SELECT 1 AS x FROM general_contribs WHERE gid = 'petra' AND side = 'defense'"));
    await sleep(2200);
    await C.Rouge1('/map');
    const petra = row("SELECT status FROM generals WHERE gid = 'petra'").status;
    check('Brigid tombe : Petra est vaincue (captive, épargnable par les Aigles)', petra === 'captive', petra);
    await C.Rouge1('/general/verdict', { general: 'petra', spare: false });
    check('non épargnée, elle meurt', row("SELECT status FROM generals WHERE gid = 'petra'").status === 'dead');
    // Almyra prise par une faction : Nader et Shadid défendent, puis meurent (seuls les Cerfs pourraient les épargner).
    withDb((d) => d.exec("UPDATE territories SET faction = 'bleue' WHERE id = 'almyra'"));
    set('Rouge1', "UPDATE player_state SET territory = 'almyra' WHERE user_id = ?");
    battle('almyra', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge']], 1500);
    await C.Rouge1('/map');
    check('ils défendent leur territoire même quand une faction le tient', !!row("SELECT 1 AS x FROM general_contribs WHERE gid = 'nader' AND side = 'defense'"));
    await sleep(2200);
    await C.Rouge1('/map');
    check('Almyra tombe : Nader et Shadid meurent', row("SELECT status FROM generals WHERE gid = 'nader'").status === 'dead' && row("SELECT status FROM generals WHERE gid = 'shadid'").status === 'dead');

    console.log('# Overdrive');
    await stop();
    // Avant le démarrage : les Cerfs n'ont plus que 9 territoires (minoritaires) quand l'Overdrive commence ; les Lions restent
    // sous la moitié de la carte (pas de coalition).
    resetMap();
    withDb((d) => d.exec('DELETE FROM relations'));
    withDb((d) => { const ids = d.prepare("SELECT id FROM territories WHERE faction = 'jaune'").all().map((x) => x.id); for (const id of ids.slice(9)) d.prepare("UPDATE territories SET faction = 'bleue' WHERE id = ?").run(id); });
    await start({ TEST_END_AT: String(Date.now() + 10 * 3_600_000), OVERDRIVE_HOURS: '24' });
    m = (await C.Rouge1('/map')).d;
    check('24 h avant la clôture : Overdrive pour les Aigles', m.overdrive && m.overdrive.level === 'base' && m.player.maxActions === 10, JSON.stringify([m.overdrive, m.player.maxActions]));
    const mj = (await C.Jaune1('/map')).d;
    check('Overdrive+ pour la faction minoritaire (+3 actions)', mj.overdrive && mj.overdrive.level === 'plus' && mj.player.maxActions === 11, JSON.stringify([mj.overdrive, mj.player.maxActions]));
    const notes = (await C.Rouge1('/notifications')).d.notifications.map((x) => x.type);
    const notesJ = (await C.Jaune1('/notifications')).d.notifications.map((x) => x.type);
    check('notification Overdrive pour les joueurs en jeu', notes.includes('overdrive') && notesJ.includes('overdrive_plus'), JSON.stringify([notes.slice(0, 5), notesJ.slice(0, 5)]));
    check('journal de l\'Overdrive', (await C.Rouge1('/journal')).d.events.some((e) => e.type === 'overdrive'));
    // Puissance d'attaque : +10 %, et +20 % de plus contre Garreg-Mach.
    set('Rouge1', "UPDATE player_state SET territory = 'rowe', status = 'alive' WHERE user_id = ?");
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge']]);
    let b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('attaque : puissance ×1,10', Math.abs(b.power.attack - 1.1) < 0.051, String(b.power.attack));
    resetMap();
    battle('garreg-mach', 'rouge', 'eglise', [['Rouge1', 'attack', 'rouge']]);
    b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'garreg-mach').battle;
    check('contre Garreg-Mach : ×1,10 × 1,20 (après le malus de -10 % des défenseurs présents)', Math.abs(b.power.attack - 0.9 * 1.1 * 1.2) < 0.03, String(b.power.attack));
    // Overdrive+ : +20 or et +2 renommée à chaque gain d'action (récolte des Cerfs).
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM contributions'); const ids = d.prepare("SELECT id FROM territories WHERE faction = 'jaune'").all().map((x) => x.id); for (const id of ids.slice(3)) d.prepare("UPDATE territories SET faction = 'bleue' WHERE id = ?").run(id); });
    const home = row("SELECT id FROM territories WHERE faction = 'jaune' LIMIT 1").id;
    set('Jaune1', 'UPDATE player_state SET territory = ?, actions = 8, actions_at = ?, reward_debuff = 0 WHERE user_id = ?', home, Date.now());
    set('Jaune1', 'UPDATE characters SET gold = 0, xp = 0 WHERE user_id = ?');
    r = await C.Jaune1('/act', { action: 'gather' });
    check('Overdrive+ : récolte 40 + 20 or, 10 + 2 renommée', r.s === 200 && r.d.character.gold === 60 && r.d.character.xp === 12, JSON.stringify([r.d.error, r.d.character?.gold, r.d.character?.xp]));
    pr = await C.Rouge1('/profile?pseudo=Jaune1');
    check('l\'Overdrive+ apparaît dans la liste des bonus', pr.d.mods.some((x) => x.type === 'overdrive' && x.level === 'plus'));
    // Les Lions tiennent maintenant plus de la moitié de la carte : coalition, les Aigles passent aussi en Overdrive+.
    check('coalition contre les Lions : Overdrive+ pour les Aigles', (await C.Rouge1('/map')).d.overdrive?.level === 'plus');
    // Un exilé n'a pas d'Overdrive.
    set('Bleu1', "UPDATE player_state SET exile_faction = 'rouge' WHERE user_id = ?");
    check('un exilé n\'a pas d\'Overdrive', (await C.Bleu1('/map')).d.overdrive === null);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
