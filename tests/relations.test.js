// Teste les relations avec les généraux : liste du camp (alliés, morts, passés ailleurs), offrandes, niveaux, S unique, exil.
// Usage : node tests/relations.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3123;
let server;
const start = () => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_REL_ROLL: '0', TEST_ROLL: '0.999' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
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
const a = client();
const uid = () => withDb((d) => d.prepare("SELECT user_id FROM characters WHERE pseudo = 'Ami'").get().user_id);
const setGold = (n) => withDb((d) => d.prepare('UPDATE characters SET gold = ? WHERE user_id = ?').run(n, uid()));
const setActions = (n) => withDb((d) => d.prepare('UPDATE player_state SET actions = ?, actions_at = ? WHERE user_id = ?').run(n, Date.now(), uid()));
const row = (sql, ...x) => withDb((d) => d.prepare(sql).get(...x));
const setPoints = (gid, n) => withDb((d) => d.prepare('INSERT INTO relations (user_id, gid, points) VALUES (?, ?, ?) ON CONFLICT (user_id, gid) DO UPDATE SET points = excluded.points').run(uid(), gid, n));

(async () => {
  try {
    await start();
    await a('/register', { email: 'ami@example.test', password: 'mot-de-passe-1', passwordConfirm: 'mot-de-passe-1' });
    await a('/character', { pseudo: 'Ami', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'rouge' });
    withDb((d) => {
      d.exec("UPDATE generals SET status = 'dead' WHERE gid = 'hubert'");
      d.exec("UPDATE generals SET faction = 'bleue' WHERE gid = 'dorothea'");
      d.exec("UPDATE generals SET faction = 'rouge' WHERE gid = 'ashe'");
    });

    console.log('# Liste du camp');
    let r = await a('/relations');
    const ids = r.d.generals.map((g) => g.id);
    const byId = (id) => r.d.generals.find((g) => g.id === id);
    check('les généraux vivants des Aigles de jais sont listés, Edelgard en tête', r.s === 200 && ids[0] === 'edelgard' && byId('edelgard').state === 'allied' && byId('edelgard').lord, ids.slice(0, 4).join(','));
    check('un général passé chez les Aigles (Ashe) est un allié', byId('ashe')?.state === 'allied');
    check('Hubert, mort, est en fin de liste', byId('hubert')?.state === 'dead' && ids.indexOf('hubert') > ids.indexOf('ashe'));
    check('Dorothea, passée chez les Lions, est grisée avec sa nouvelle faction', byId('dorothea')?.state === 'joined' && byId('dorothea').faction === 'bleue');
    check('aucun général d\'une autre faction ni Serpent', !ids.includes('dimitri') && !ids.includes('epimenides') && !ids.includes('immaculate'));
    check('les niveaux de C à S', r.d.levels.map((l) => l.id).join() === 'C,C+,B,B+,A,A+,S' && r.d.levels[6].points === 2000);

    console.log('# Offrandes');
    setGold(1000); setActions(8);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'flower' });
    check('une fleur : +5 points', r.s === 200 && r.d.gift.points === 5 && r.d.gift.gained === 5, JSON.stringify(r.d.gift || r.d));
    check('… pour 1 action et 50 or', r.d.character.gold === 950 && r.d.player.actions === 7, JSON.stringify([r.d.character.gold, r.d.player.actions]));
    r = await a('/relations/gift', { general: 'edelgard', kind: 'letter' });
    check('une lettre : +25 points, 200 or', r.s === 200 && r.d.gift.points === 30 && r.d.character.gold === 750 && r.d.player.actions === 6);
    check('la liste renvoyée est à jour', r.d.relations.generals.find((g) => g.id === 'edelgard').points === 30);
    setPoints('edelgard', 240);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'letter' });
    check('palier franchi : niveau C à 250', r.d.gift.level === 'C' && r.d.gift.up === true, JSON.stringify(r.d.gift));
    r = await a('/relations/gift', { general: 'hubert', kind: 'flower' });
    check('pas d\'offrande à un général mort', r.s === 409 && r.d.error === 'not_allied');
    r = await a('/relations/gift', { general: 'dimitri', kind: 'flower' });
    check('ni à un général d\'une autre faction', r.s === 409 && r.d.error === 'not_allied');
    setGold(10);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'flower' });
    check('pas assez d\'or : refusé', r.s === 409 && r.d.error === 'not_enough_gold');
    setGold(1000); setActions(0);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'flower' });
    check('pas d\'action : refusé, l\'or est gardé', r.s === 409 && r.d.error === 'no_actions' && withDb((d) => d.prepare('SELECT gold FROM characters WHERE user_id = ?').get(uid()).gold) === 1000);

    console.log('# Niveau S unique');
    setActions(8);
    setPoints('edelgard', 1990);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'letter' });
    check('niveau S atteint (plafonné à 2000)', r.d.gift.level === 'S' && r.d.gift.points === 2000, JSON.stringify(r.d.gift));
    r = await a('/relations/gift', { general: 'edelgard', kind: 'flower' });
    check('au-delà de S : refusé', r.s === 409 && r.d.error === 'support_max');
    setPoints('ferdinand', 1990);
    r = await a('/relations/gift', { general: 'ferdinand', kind: 'letter' });
    check('un second général plafonne juste sous S', r.s === 200 && r.d.gift.points === 1999 && r.d.gift.level === 'A+', JSON.stringify(r.d.gift || r.d));
    r = await a('/relations/gift', { general: 'ferdinand', kind: 'flower' });
    check('puis est refusé : le S est déjà pris', r.s === 409 && r.d.error === 'support_s_taken');
    check('le S est signalé dans la liste', (await a('/relations')).d.sWith === 'edelgard');

    console.log('# Bonus de soutien');
    const at = (where) => withDb((d) => d.prepare("UPDATE player_state SET territory = ?, status = 'alive', streak_territory = NULL, streak_count = 0 WHERE user_id = ?").run(where, uid()));
    const battleAt = (territory, attacker, defender, side) => withDb((d) => {
      d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs');
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const now = Date.now();
      const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, territory, attacker, defender, now, now + 600000).lastInsertRowid);
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'action', 0)").run(id, territory, uid(), side === 'attack' ? attacker : defender, side, now);
    });
    const powerAt = async (territory) => (await a('/map')).d.territories.find((x) => x.id === territory).battle;
    withDb((d) => { d.prepare('DELETE FROM relations WHERE user_id = ?').run(uid()); d.exec("UPDATE generals SET status = 'alive', faction = 'rouge', territory = 'hresvelg' WHERE gid IN ('hubert', 'dorothea')"); });
    setGold(5000); setActions(8);
    // Manuela : réserve d'actions.
    setPoints('manuela', 250);
    check('Manuela (C) : +1 action en réserve', (await a('/me')).d.player.maxActions === 9, String((await a('/me')).d.player.maxActions));
    // Caspar : bataillons moins chers.
    setPoints('caspar', 250);
    check('Caspar (C) : bataillon à 270 or au lieu de 300', (await a('/map')).d.costs.hire === 270, String((await a('/map')).d.costs.hire));
    // Bernadetta et Monica : défendre deux fois de suite à Hresvelg.
    setPoints('bernadetta', 250); setPoints('monica', 250);
    at('hresvelg');
    r = await a('/act', { action: 'defend' });
    check('première défense : renommée de Monica (+2), pas encore d\'or de Bernadetta', r.s === 200 && r.d.relFx.some((x) => x.kind === 'homeXp' && x.xp === 2) && !r.d.relFx.some((x) => x.kind === 'streakGold'), JSON.stringify(r.d.relFx || r.d));
    const g0 = r.d.character.gold;
    r = await a('/act', { action: 'defend' });
    check('action enchaînée : +3 or (Bernadetta, C)', r.d.relFx.some((x) => x.kind === 'streakGold' && x.gold === 3) && r.d.character.gold === g0 + 3, JSON.stringify([r.d.relFx, g0, r.d.character.gold]));
    // Dorothea : avec 2 alliés ou plus sur place, l'action peut ne pas être consommée (tirage forcé à 0).
    setPoints('dorothea', 250); setActions(8);
    r = await a('/act', { action: 'defend' });
    check('Dorothea (C) : action non consommée à Hresvelg (des généraux alliés sont présents)', r.d.relFx.some((x) => x.kind === 'saveAction') && r.d.player.actions === 8, JSON.stringify([r.d.relFx, r.d.player.actions]));
    at('varley');
    r = await a('/act', { action: 'defend' });
    check('… mais pas avec un seul allié sur place (Varley)', !r.d.relFx.some((x) => x.kind === 'saveAction') && r.d.player.actions === 7, JSON.stringify([r.d.relFx, r.d.player.actions]));
    // Edelgard : contre l'Église.
    at('garreg-mach');
    battleAt('garreg-mach', 'rouge', 'eglise', 'attack');
    let b = await powerAt('garreg-mach');
    const base = b.power.attack;
    setPoints('edelgard', 600);
    b = await powerAt('garreg-mach');
    check('Edelgard (B, +15 %) : puissance contre l\'Église', Math.abs(b.power.attack / base - 1.15) < 0.02, `${base} → ${b.power.attack}`);
    // Hubert : chances brutes en attaque.
    battleAt('rowe', 'rouge', 'bleue', 'attack');
    at('rowe');
    const c0 = (await powerAt('rowe')).chance;
    setPoints('hubert', 1400);
    const c1 = (await powerAt('rowe')).chance;
    check('Hubert (A+) : +6 points de chances en attaque', c1 - c0 === 6, `${c0} → ${c1}`);
    // Linhardt : blessure moins pénalisante.
    setPoints('linhardt', 400);
    withDb((d) => { d.exec('DELETE FROM battles; DELETE FROM contributions'); d.prepare("UPDATE player_state SET status = 'retreating', retreat_until = ? WHERE user_id = ?").run(Date.now() - 1, uid()); });
    await a('/map');
    const st = row('SELECT status, reward_debuff FROM player_state WHERE user_id = ?', uid());
    check('Linhardt (C+) : 8 actions à gains réduits au lieu de 10', st.reward_debuff === 8, JSON.stringify(st));
    // Généraux des Cerfs passés chez les Aigles pour le test : Marianne (retour en jeu), Ignatz (appel à l'aide), Lorenz (constructions).
    withDb((d) => d.exec("UPDATE generals SET faction = 'rouge' WHERE gid IN ('marianne', 'ignatz', 'lorenz')"));
    setPoints('marianne', 250);
    check('Marianne (C) : retour en jeu à 90 or au lieu de 100', (await a('/map')).d.costs.revive === 90, String((await a('/map')).d.costs.revive));
    withDb((d) => d.prepare("UPDATE player_state SET status = 'alive', actions = 8, actions_at = ?, reward_debuff = 0 WHERE user_id = ?").run(Date.now(), uid()));
    at('rowe');
    battleAt('rowe', 'rouge', 'bleue', 'attack');
    const h0 = (await powerAt('rowe')).chance;
    setPoints('ignatz', 850);
    r = await a('/rally', {});
    const h1 = (await powerAt('rowe')).chance;
    check('Ignatz (B+) : appeler à l\'aide ajoute 2 points de chances', r.s === 200 && h1 - h0 === 2, `${h0} → ${h1}`);
    withDb((d) => d.exec('DELETE FROM battles; DELETE FROM contributions'));
    setPoints('lorenz', 250); setGold(5000);
    at('hresvelg');
    withDb((d) => d.exec("DELETE FROM territory_builds"));
    r = await a('/act', { action: 'build', spec: 'fortress' });
    check('Lorenz (C) : construction à 760 or au lieu de 800', r.s === 200 && r.d.character.gold === 5000 - 760, JSON.stringify([r.d.error, r.d.character && r.d.character.gold]));
    withDb((d) => d.exec("UPDATE generals SET faction = 'jaune' WHERE gid IN ('marianne', 'ignatz', 'lorenz')"));
    withDb((d) => d.exec("UPDATE generals SET faction = 'bleue' WHERE gid = 'manuela'"));
    check('un bonus est inactif quand le général n\'est plus allié', (await a('/me')).d.player.maxActions === 8);
    withDb((d) => d.exec("UPDATE generals SET faction = 'rouge' WHERE gid = 'manuela'; UPDATE generals SET faction = 'bleue' WHERE gid = 'dorothea'; DELETE FROM relations"));
    // Hilda : de l'or à chaque action rendue par le compteur (tours de 2 s en test).
    withDb((d) => d.exec("UPDATE generals SET faction = 'rouge' WHERE gid = 'hilda'"));
    setPoints('hilda', 250); setGold(0);
    withDb((d) => d.prepare('UPDATE player_state SET actions = 5, actions_at = ?, reward_debuff = 0 WHERE user_id = ?').run(Date.now() - 4100, uid()));
    r = await a('/me');
    check('Hilda (C) : 2 actions rendues, +6 or', r.d.player.actions === 7 && r.d.character.gold === 6, JSON.stringify([r.d.player.actions, r.d.character.gold]));
    r = await a('/me');
    check('… payées une seule fois', r.d.character.gold === 6, String(r.d.character.gold));
    withDb((d) => d.prepare('UPDATE player_state SET actions = 8, actions_at = ? WHERE user_id = ?').run(Date.now() - 60000, uid()));
    r = await a('/me');
    check('réserve pleine : rien de plus', r.d.character.gold === 6, String(r.d.character.gold));
    withDb((d) => d.exec("UPDATE generals SET faction = 'jaune' WHERE gid = 'hilda'"));
    setPoints('edelgard', 2000); setGold(1000); setActions(8); // la blessure a vidé la réserve

    console.log('# Exil');
    withDb((d) => d.prepare("UPDATE player_state SET exile_faction = 'bleue' WHERE user_id = ?").run(uid()));
    r = await a('/relations');
    const ex = r.d.generals.map((g) => g.id);
    check('en exil chez les Lions : leurs généraux, y compris Dorothea qui les a rejoints', r.d.side === 'bleue' && ex[0] === 'dimitri' && ex.includes('dorothea') && !ex.includes('edelgard'), ex.slice(0, 5).join(','));
    r = await a('/relations/gift', { general: 'dorothea', kind: 'flower' });
    check('on peut se lier avec eux', r.s === 200 && r.d.gift.points === 5);
    r = await a('/relations/gift', { general: 'edelgard', kind: 'flower' });
    check('mais plus avec sa faction d\'origine', r.s === 409 && r.d.error === 'not_allied');
    withDb((d) => { d.prepare("UPDATE player_state SET territory = 'rowe', status = 'alive' WHERE user_id = ?").run(uid()); d.exec("UPDATE territories SET faction = 'rouge' WHERE id = 'rowe'"); });
    withDb((d) => {
      d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs');
      const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
      const now = Date.now();
      const id = Number(d.prepare("INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, 'rowe', 'bleue', 'rouge', 0, ?, ?)").run(cid, now, now + 600000).lastInsertRowid);
      d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, 'rowe', ?, 'bleue', 'attack', 1, ?, NULL, 'action', 0)").run(id, uid(), now);
    });
    const pwr = async () => (await a('/map')).d.territories.find((x) => x.id === 'rowe').battle.power.attack;
    const pa0 = await pwr();
    setPoints('annette', 250);
    const pa1 = await pwr();
    check('Annette (C) sans lien C+ avec Mercedes : pas de bonus', Math.abs(pa1 - pa0) < 0.001, `${pa0} → ${pa1}`);
    setPoints('mercedes', 400);
    const pa2 = await pwr();
    check('avec Mercedes en C+ : +5 % d\'attaque (Annette)', Math.abs(pa2 / pa0 - 1.05) < 0.01, `${pa0} → ${pa2}`);
    check('le soutien acquis est gardé', withDb((d) => d.prepare("SELECT points FROM relations WHERE user_id = ? AND gid = 'edelgard'").get(uid()).points) === 2000);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
