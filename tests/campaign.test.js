// Teste le moteur de campagne complet sur un serveur temporaire : base jetable, tours de 2 secondes.
// Usage : node camp-test2.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3111;
const TURN = 2000;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1200));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const restart = async (env) => { await stop(); await start(env); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (query, ...args) => { const d = new DatabaseSync(path.join(dataDir, 'conquete.db')); d.exec('PRAGMA busy_timeout = 5000'); try { return d.prepare(query).run(...args); } finally { d.close(); } };
const place = (pseudo, territory, actions = 8) => sql('UPDATE player_state SET territory = ?, actions = ? WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = ?)', territory, actions, pseudo);

let failures = 0;
let total = 0;
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
let n = 0;
async function player(faction) {
  n += 1;
  const call = client();
  const pw = 'mot-de-passe-test-' + n;
  await call('/register', { email: `joueur${n}@example.test`, password: pw, passwordConfirm: pw });
  const r = await call('/character', { pseudo: `Joueur${n}`, birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction });
  if (r.s !== 201) throw new Error('création impossible : ' + JSON.stringify(r.d));
  return call;
}
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const notifsOf = async (c) => (await c('/notifications')).d.notifications;

(async () => {
  try {
    // ---------- 1. Actions, déplacements, récolte
    await start();
    const red = await player('rouge');
    let me = (await red('/me')).d;
    check('apparition dans la capitale avec 8 actions', me.player.territory === 'hresvelg' && me.player.actions === 8);
    let r = await red('/act', { action: 'attack' });
    check('pas d\'attaque sur son propre territoire', r.d.error === 'invalid_action', r.d.error);
    r = await red('/act', { action: 'gather' });
    check('récolter : +40 or, 1 action', r.d.character.gold === 540 && r.d.player.actions === 7, `or ${r.d.character?.gold}`);
    r = await red('/move', { to: 'riegan' });
    check('pas de déplacement vers un non-voisin', r.d.error === 'not_neighbor', r.d.error);
    r = await red('/move', { to: 'varley' });
    check('déplacement vers un voisin allié', r.d.player?.territory === 'varley');
    r = await red('/move', { to: 'garreg-mach' });
    check('entrée chez l\'ennemi si un allié touche la cible', r.d.player?.territory === 'garreg-mach');
    r = await red('/move', { to: 'charon' });
    check('entrée refusée sinon', r.d.error === 'cannot_enter', r.d.error);
    await red('/move', { to: 'varley' }); await red('/act', { action: 'gather' }); await red('/act', { action: 'gather' }); await red('/act', { action: 'gather' }); r = await red('/act', { action: 'gather' });
    check('réserve vide après 8 actions', r.d.player.actions === 0);
    r = await red('/act', { action: 'gather' });
    check('action refusée sans réserve', r.d.error === 'no_actions', r.d.error);
    await sleep(TURN * 2 + 300);
    check('2 actions regagnées après 2 tours', (await red('/me')).d.player.actions === 2);

    // ---------- 2. Bonus de régularité (tours de 4 s pour éviter les effets de bord)
    await restart({ CADENCE_GOLD: '10', TURN_SECONDS: '4' });
    place('Joueur1', 'hresvelg');
    await sleep(4000 - (Date.now() % 4000) + 150); // début d'un tour
    let gold = (await red('/me')).d.character.gold;
    r = await red('/act', { action: 'gather' });
    check('1re action du tour : bonus de 10 or', r.d.character.gold === gold + 50 && r.d.bonus === 10, `+${r.d.character.gold - gold}`);
    r = await red('/act', { action: 'gather' });
    check('2e action du même tour : pas de bonus', r.d.character.gold === gold + 90 && r.d.bonus === 0, `+${r.d.character.gold - gold}`);
    await sleep(4100);
    r = await red('/act', { action: 'gather' });
    check('tour suivant : bonus de nouveau', r.d.bonus === 10, 'bonus ' + r.d.bonus);

    // ---------- 3. Bataille, renforts payés, appel à l'aide, journal, classement
    await restart({ TEST_ROLL: '0' });
    const blue = await player('bleue');
    const blue2 = await player('bleue');
    place('Joueur1', 'barnabas'); place('Joueur2', 'rowe'); place('Joueur3', 'blaiddyd');
    sql("UPDATE characters SET gold = 1000 WHERE pseudo IN ('Joueur1', 'Joueur2')");
    r = await blue('/act', { action: 'defend' });
    check('garnison posée avant l\'attaque', r.s === 200);
    r = await blue('/act', { action: 'hire' });
    check('fortification payée hors bataille : -300 or', r.s === 200 && r.d.character.gold === 700, `or ${r.d.character?.gold}`);
    await red('/move', { to: 'rowe' });
    r = await red('/act', { action: 'hire' });
    check('pas de mercenaires sans bataille de sa faction', r.d.error === 'invalid_action', r.d.error);
    r = await red('/act', { action: 'attack' });
    let b = terrOf(r.d.map, 'rowe').battle;
    check('bataille lancée, garnison et fortification comptées', b && b.defenders === 1 && b.chance === 18, JSON.stringify(b && { c: b.chance, d: b.defenders }));
    r = await red('/act', { action: 'hire' });
    const c1 = terrOf(r.d.map, 'rowe').battle.chance;
    check('mercenaires : -300 or et meilleures chances', r.d.character.gold === 700 && c1 > 18, `${c1} %`);
    await red('/act', { action: 'hire' });
    r = await red('/act', { action: 'hire' });
    check('renforts limités à 2 par bataille', r.d.error === 'hire_limit', r.d.error);
    sql("UPDATE characters SET gold = 0 WHERE pseudo = 'Joueur2'");
    r = await blue('/act', { action: 'hire' });
    check('pas de renfort sans or', r.d.error === 'not_enough_gold' || r.d.error === 'hire_limit', r.d.error);
    r = await blue('/rally', {});
    check('appel à l\'aide accepté', r.s === 200 && terrOf(r.d.map, 'rowe').battle.rallied === true);
    r = await blue('/rally', {});
    check('un seul appel par bataille', r.d.error === 'rally_done', r.d.error);
    let nt = await notifsOf(blue2);
    check('l\'allié reçoit l\'appel à l\'aide', nt.some((x) => x.type === 'rally' && x.params.territory === 'rowe' && x.params.pseudo === 'Joueur2'));
    check('et la notification d\'attaque', nt.some((x) => x.type === 'territory_attacked' && x.params.territory === 'rowe'));
    r = await blue2('/rally', {});
    check('pas d\'appel si on n\'est pas sur place', r.d.error === 'invalid_action', r.d.error);
    let j = (await red('/journal')).d.events;
    check('journal : attaque et appel à l\'aide', j.some((e) => e.type === 'battle_started' && e.params.territory === 'rowe') && j.some((e) => e.type === 'rally'));
    await sleep(TURN * 6 + 1500);
    let map = (await red('/map')).d;
    check('après 6 tours, le territoire change de camp', terrOf(map, 'rowe').faction === 'rouge');
    j = (await red('/journal')).d.events;
    check('journal : territoire pris', j.some((e) => e.type === 'territory_taken' && e.params.territory === 'rowe' && e.params.faction === 'rouge'));
    check('classement : l\'attaquant est en tête', map.ranking.top[0]?.pseudo === 'Joueur1' && map.ranking.top[0].score === 10 + 10 + 10 + 30 + 12 + 4 && map.ranking.me.rank === 1 && map.ranking.top[1]?.pseudo === 'Joueur2', JSON.stringify(map.ranking.top.map((x) => x.pseudo + ':' + x.score)));
    const daily = (await red('/missions')).d.daily;
    check('missions du jour : progression comptée par le serveur', daily.missions.find((m) => m.id === 'combat').current === 1 && daily.missions.find((m) => m.id === 'marche').status === 'done', JSON.stringify(daily.missions.map((m) => `${m.id}:${m.current}/${m.target}`)));

    // ---------- 4. Repli, mort, retours en jeu
    me = (await blue('/me')).d;
    check('le défenseur présent doit se replier', me.player.status === 'retreating');
    r = await blue('/retreat', { to: 'blaiddyd' });
    check('repli sur un territoire allié', r.d.player?.status === 'alive' && r.d.player.territory === 'blaiddyd');
    place('Joueur2', 'duval'); place('Joueur1', 'duval');
    await red('/act', { action: 'attack' });
    await sleep(TURN * 12 + 2500);
    me = (await blue('/me')).d;
    check('sans repli à temps, le joueur est puni mais continue de jouer : capitale, actions vidées, gains réduits', me.player.status === 'alive' && me.player.territory === 'blaiddyd' && me.player.actions <= 1 && me.player.rewardDebuff === 10 && !me.player.factionOut, JSON.stringify(me.player));
    sql("UPDATE player_state SET status = 'dead', fall_mult = 1 WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Joueur2')");
    check('la campagne continue (plus de fin par simple mort)', (await red('/map')).d.campaign.id === 1);
    r = await blue('/move', { to: 'gideon' });
    check('aucune action tant qu\'on est tombé', r.d.error === 'player_dead', r.d.error);
    r = await blue('/revive', { mode: 'gold' });
    check('retour refusé sans or', r.d.error === 'not_enough_gold', r.d.error);
    r = await blue('/revive', { mode: 'renown' });
    check('retour refusé sans niveau de renommée', r.d.error === 'no_renown', r.d.error);
    r = await blue('/revive', { mode: 'ask' });
    check('demande d\'aide enregistrée', r.s === 200 && r.d.player.reviveAsked === true && r.d.player.status === 'dead');
    map = (await blue2('/map')).d;
    check('l\'allié voit la demande', map.fallen.length === 1 && map.fallen[0].pseudo === 'Joueur2');
    check('l\'ennemi ne la voit pas', (await red('/map')).d.fallen.length === 0);
    gold = (await blue2('/me')).d.character.gold;
    r = await blue2('/revive/pay', { id: map.fallen[0].id });
    check('l\'allié paie 100 or', r.s === 200 && r.d.character.gold === gold - 100 && r.d.map.fallen.length === 0, `or ${gold} -> ${r.d.character?.gold}`);
    me = (await blue('/me')).d;
    check('le joueur revient dans sa capitale', me.player.status === 'alive' && me.player.territory === 'blaiddyd', JSON.stringify(me.player));
    check('et il est prévenu', (await notifsOf(blue)).some((x) => x.type === 'revived_by' && x.params.pseudo === 'Joueur3'));

    // Retour par l'or, puis par la renommée, avec la capitale perdue.
    sql("UPDATE player_state SET status = 'dead' WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Joueur2')");
    sql("UPDATE characters SET gold = 150, xp = 250 WHERE pseudo = 'Joueur2'"); // 250 xp = niveau 2 (100 + 110) + 40
    r = await blue('/revive', { mode: 'gold' });
    check('retour contre 100 or', r.d.player?.status === 'alive' && r.d.character.gold === 50, `or ${r.d.character?.gold}`);
    sql("UPDATE player_state SET status = 'dead' WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Joueur2')");
    sql("UPDATE territories SET faction = 'rouge' WHERE id = 'blaiddyd'");
    r = await blue('/revive', { mode: 'renown' });
    check('retour contre 1 niveau de renommée', r.d.player?.status === 'alive' && r.d.character.renown.level === 1 && r.d.character.renown.xp === 40, JSON.stringify(r.d.character?.renown));
    check('capitale perdue : retour sur un autre territoire de la faction', r.d.player.territory !== 'blaiddyd' && terrOf(r.d.map, r.d.player.territory).faction === 'bleue', r.d.player?.territory);

    // ---------- 5. Faction hors jeu, fin de campagne, points, récompense du classement
    gold = (await red('/me')).d.character.gold;
    sql("UPDATE territories SET faction = 'rouge' WHERE faction = 'bleue'");
    await sleep(TURN + 1500);
    const after = (await red('/map')).d;
    check('faction sans territoire : hors jeu, fin de campagne', after.campaign.id === 2, 'campagne ' + after.campaign.id);
    nt = await notifsOf(blue);
    check('les joueurs sont prévenus du game over', nt.some((x) => x.type === 'faction_out' && x.params.faction === 'bleue'));
    check('fin de campagne notifiée', nt.some((x) => x.type === 'campaign_end' && x.params.faction === 'rouge'));
    check('carte remise à zéro', terrOf(after, 'rowe').faction === 'bleue' && terrOf(after, 'blaiddyd').faction === 'bleue');
    check('points attribués, vainqueur en tête', after.points.rouge > 100 && after.points.rouge > (after.points.bleue || 0), JSON.stringify(after.points));
    me = (await red('/me')).d;
    check('le 1er du classement reçoit 1000 or', me.character.gold === gold + 1000, `or ${gold} -> ${me.character.gold}`);
    check('nouveau classement vide', after.ranking.top.length === 0);
    me = (await blue('/me')).d;
    check('les joueurs reviennent à la nouvelle campagne', me.player.status === 'alive' && me.player.territory === 'blaiddyd' && !me.player.factionOut);
    j = (await red('/journal')).d.events;
    check('journal : faction hors jeu et fin de campagne', j.some((e) => e.type === 'faction_out') && j.some((e) => e.type === 'campaign_ended'));

    // ---------- 6. Missions du jour et série
    await restart({ TEST_DAY: '2026-03-10' });
    place('Joueur1', 'hresvelg');
    for (let i = 0; i < 3; i += 1) await red('/act', { action: 'gather' });
    let dm = (await red('/missions')).d.daily;
    let m = dm.missions.find((x) => x.id === 'recolte');
    check('mission du jour accomplie', m.status === 'done' && m.rewards.gold === 66 && dm.streak === 0, `${m.status}, ${m.rewards.gold} or, série ${dm.streak}`);
    check('pastille des missions à jour', (await red('/me')).d.claimable >= 1);
    gold = (await red('/me')).d.character.gold;
    r = await red('/missions/daily/claim', { id: 'recolte' });
    check('récompense avec bonus de série (+10 %)', r.s === 200 && r.d.character.gold === gold + 66 && r.d.daily.streak === 1, `+${r.d.character?.gold - gold}, série ${r.d.daily?.streak}`);
    r = await red('/missions/daily/claim', { id: 'recolte' });
    check('pas de double récompense', r.d.error === 'reward_unavailable', r.d.error);
    r = await red('/missions/daily/claim', { id: 'combat' });
    check('mission inachevée refusée', r.d.error === 'reward_unavailable', r.d.error);
    await restart({ TEST_DAY: '2026-03-11' });
    place('Joueur1', 'hresvelg');
    dm = (await red('/missions')).d.daily;
    check('le lendemain : missions remises à zéro, série conservée', dm.missions.every((x) => x.status === 'active' && x.current === 0) && dm.streak === 1, `série ${dm.streak}`);
    for (let i = 0; i < 3; i += 1) await red('/act', { action: 'gather' });
    r = await red('/missions/daily/claim', { id: 'recolte' });
    check('2e jour : série de 2, bonus +20 %', r.d.daily?.streak === 2 && r.d.daily.missions.find((x) => x.id === 'recolte').rewards.gold === 72, `série ${r.d.daily?.streak}`);
    await restart({ TEST_DAY: '2026-03-14' });
    dm = (await red('/missions')).d.daily;
    check('un jour manqué : la série repart de zéro', dm.streak === 0, `série ${dm.streak}`);

    // ---------- 7. Attaque ratée, Église, Loups de cendre, faction ennemie, mini-boss
    await restart({ TEST_ROLL: '0.999' });
    place('Joueur1', 'barnabas');
    await red('/move', { to: 'rowe' });
    r = await red('/act', { action: 'attack' });
    const openChance = terrOf(r.d.map, 'rowe').battle.chance;
    await red('/move', { to: 'barnabas', leave: true }); await red('/move', { to: 'garreg-mach' });
    r = await red('/act', { action: 'attack' });
    const church = terrOf(r.d.map, 'garreg-mach').battle;
    check('Garreg-Mach bien plus dur à prendre', church.chance < openChance / 2, `${church.chance} % contre ${openChance} %`);
    await sleep(TURN * 6 + 1500);
    map = (await red('/map')).d;
    check('attaque ratée : rien ne change de camp', terrOf(map, 'rowe').faction === 'bleue' && terrOf(map, 'garreg-mach').faction === 'eglise');
    check('l\'attaquant est prévenu de l\'échec', (await notifsOf(red)).some((x) => x.type === 'attack_failed'));
    const wolf = await player('violette');
    me = (await wolf('/me')).d;
    check('Loups de cendre : départ à Garreg-Mach, pas hors jeu', me.player.territory === 'garreg-mach' && me.player.status === 'alive' && !me.player.factionOut);
    r = await wolf('/move', { to: 'varley' });
    check('ils entrent chez un voisin de Garreg-Mach', r.d.player?.territory === 'varley', r.d.error);
    r = await wolf('/move', { to: 'hresvelg' });
    check('mais pas plus loin', r.d.error === 'cannot_enter', r.d.error);
    check('la campagne ne s\'arrête pas à leur arrivée', (await wolf('/map')).d.campaign.id === 2);
    const anon = client();
    await anon('/register', { email: 'serpent@example.test', password: 'mot-de-passe-test-s', passwordConfirm: 'mot-de-passe-test-s' });
    r = await anon('/character', { pseudo: 'Serpent', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'serpents' });
    check('la faction ennemie n\'est pas jouable', r.d.error === 'invalid_faction', r.d.error);
    check('journal refusé sans session', (await client()('/journal')).s === 401);

    await restart({ TEST_ROLL: '0', BOSS_CHANCE: '1', TEST_HOUR: '12' }); // jour : les mini-boss peuvent apparaître
    await sleep(TURN * 2 + 500);
    map = (await red('/map')).d;
    const boss = map.territories.filter((x) => x.battle && x.battle.boss);
    check('un mini-boss attaque un territoire', boss.length === 1 && boss[0].battle.attacker === 'serpents');
    await sleep(TURN * 6 + 1500);
    map = (await red('/map')).d;
    check('s\'il gagne, le territoire passe aux Serpents des Ténèbres', boss.length === 1 && terrOf(map, boss[0].id).faction === 'serpents');
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    await stop();
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
  }
})();
