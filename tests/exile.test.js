// Teste l'exil, les missions d'exil, la série gelée et les distinctions sur un serveur temporaire (tours de 2 secondes).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3113;
const TURN = 2000;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_ROLL: '0', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const restart = async (env) => { await stop(); await start(env); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (query, ...args) => { const d = new DatabaseSync(path.join(dataDir, 'conquete.db')); d.exec('PRAGMA busy_timeout = 5000'); try { return d.prepare(query).run(...args); } finally { d.close(); } };
const place = (pseudo, territory, actions = 6) => sql('UPDATE player_state SET territory = ?, actions = ? WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = ?)', territory, actions, pseudo);
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
let n = 0;
async function player(faction) {
  n += 1;
  const call = client();
  const pw = 'mot-de-passe-test-' + n;
  await call('/register', { email: `joueur${n}@example.test`, password: pw, passwordConfirm: pw });
  await call('/character', { pseudo: `Joueur${n}`, birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction });
  return call;
}
// Les connexions sont perdues au redémarrage du serveur ? Non : les sessions sont en base, les cookies restent valables.
const terrOf = (map, id) => map.territories.find((t) => t.id === id);
const notifsOf = async (c) => (await c('/notifications')).d.notifications;
const ids = (list) => list.map((x) => x.id).sort().join(',');

(async () => {
  try {
    await start();
    const red = await player('rouge');      // Joueur1
    const blue = await player('bleue');     // Joueur2
    const blue3 = await player('bleue');    // Joueur3
    const yellow = await player('jaune');   // Joueur4
    const wolf = await player('violette');  // Joueur5

    // ---------- 1. Dernier territoire, honneurs aux vaincus
    let r = await blue('/act', { action: 'gather' });
    check('avant la chute : récolte du bleu (+2 pts de classement)', r.s === 200 && r.d.character.gold === 540);
    sql("UPDATE territories SET faction = 'rouge' WHERE faction = 'bleue' AND id != 'rowe'");
    place('Joueur3', 'rowe');
    r = await blue3('/act', { action: 'defend' });
    check('le dernier défenseur pose une garnison', r.s === 200);
    place('Joueur1', 'barnabas');
    await red('/move', { to: 'rowe' });
    r = await red('/act', { action: 'attack' });
    check('bataille sur le dernier territoire des bleus', terrOf(r.d.map, 'rowe').battle?.attacker === 'rouge' && terrOf(r.d.map, 'rowe').battle.defenders === 1);
    check('les bleus ne sont pas encore hors jeu', (await blue3('/me')).d.player.status !== 'dead');
    await sleep(TURN * 6 + 2500);
    let map = (await blue('/map')).d;
    check('le dernier territoire est tombé', terrOf(map, 'rowe').faction === 'rouge');
    let me2 = (await blue('/me')).d;
    let me3 = (await blue3('/me')).d;
    check('la faction bleue est hors jeu, ses joueurs sont tombés', me2.player.status === 'dead' && me2.player.factionOut && me3.player.status === 'dead');
    check('« Dernier rempart » au défenseur, et « Vétéran » aussi', ids(me3.distinctions) === 'last_stand,veteran', ids(me3.distinctions));
    check('« Vétéran » seulement pour qui a combattu', ids(me2.distinctions) === 'veteran', ids(me2.distinctions));
    check('prime de consolation de 200 or', me2.character.gold === 740 && me3.character.gold === 700, `${me2.character.gold} / ${me3.character.gold}`);
    check('aucune distinction pour les autres factions', (await yellow('/me')).d.distinctions.length === 0);
    let nt = await notifsOf(blue3);
    check('notifications : distinction et honneurs', nt.some((x) => x.type === 'distinction' && x.params.distinction === 'last_stand') && nt.some((x) => x.type === 'defeat_honors' && x.params.gold === 200));
    const av = (await blue3('/avatars')).d.avatars;
    check('avatars exclusifs de Vétéran et de Dernier rempart débloqués', av.find((a) => a.file === 'avatar_42.webp')?.owned === true && av.find((a) => a.file === 'avatar_36.webp')?.owned === true);
    check('l autre vétéran a aussi l avatar de vétéran', (await blue('/avatars')).d.avatars.find((a) => a.file === 'avatar_42.webp')?.owned === true);

    // ---------- 2. Choix de la bannière : pas celle qui domine la carte
    map = (await blue('/map')).d;
    check('options d\'exil : factions qui ne dominent pas, Loups de cendre et Église', map.exile && map.exile.options.sort().join(',') === 'eglise,jaune,violette' && map.exile.malus === 50, JSON.stringify(map.exile));
    r = await blue('/exile', { faction: 'rouge' });
    check('pas d\'exil chez la faction dominante', r.d.error === 'exile_unavailable', r.d.error);
    r = await blue('/exile', { faction: 'bleue' });
    check('ni chez sa propre faction', r.d.error === 'exile_unavailable', r.d.error);
    r = await blue('/exile', { faction: 'serpents' });
    check('ni chez une faction non jouable', r.d.error === 'exile_unavailable', r.d.error);
    r = await red('/exile', { faction: 'jaune' });
    check('un joueur en jeu ne peut pas s\'exiler', r.d.error === 'exile_unavailable', r.d.error);
    check('l\'exil n\'est pas proposé aux autres', (await red('/map')).d.exile === null && (await yellow('/map')).d.exile === null);
    r = await blue('/exile', { faction: 'jaune' });
    check('exil chez les Cerfs d\'or : de retour en jeu à leur capitale', r.s === 200 && r.d.player.status === 'alive' && r.d.player.territory === 'riegan' && r.d.player.exile && r.d.player.faction === 'jaune', JSON.stringify(r.d.player));
    check('il compte parmi les jaunes sur la carte', terrOf(r.d.map, 'riegan').players.jaune === 2, JSON.stringify(terrOf(r.d.map, 'riegan').players));
    check('plus d\'offre d\'exil une fois exilé', r.d.map.exile === null);
    r = await blue('/exile', { faction: 'violette' });
    check('un seul exil à la fois', r.d.error === 'exile_unavailable', r.d.error);
    const j = (await blue('/journal')).d;
    check('journal : exilé annoncé', j.events.some((e) => e.type === 'exile_joined' && e.params.pseudo === 'Joueur2' && e.params.faction === 'jaune'));

    // L'Église de Seiros accueille elle aussi des exilés, tant qu'elle tient un territoire.
    r = await blue3('/exile', { faction: 'eglise' });
    check('exil chez l\'Église de Seiros : apparition à Garreg-Mach', r.s === 200 && r.d.player.status === 'alive' && r.d.player.territory === 'garreg-mach' && r.d.player.faction === 'eglise' && r.d.player.exile, JSON.stringify(r.d.player || r.d));
    check('il compte parmi les défenseurs de l\'Église sur la carte', terrOf(r.d.map, 'garreg-mach').players.eglise === 1, JSON.stringify(terrOf(r.d.map, 'garreg-mach').players));
    let g3 = (await blue3('/me')).d.character.gold;
    r = await blue3('/act', { action: 'gather' });
    check('exilé de l\'Église : gains réduits de 50 % (20 or au lieu de 40)', r.d.character.gold === g3 + 20, `+${r.d.character?.gold - g3}`);

    // ---------- 3. Combattre en exilé : gains d'or et d'expérience réduits
    let before = (await blue('/me')).d.character;
    r = await blue('/act', { action: 'gather' });
    check('récolte d\'exilé : -50 % (20 or au lieu de 40)', r.d.character.gold === before.gold + 20, `+${r.d.character.gold - before.gold}`);
    place('Joueur2', 'ailell');
    r = await blue('/move', { to: 'galatea' });
    check('l\'exilé entre en territoire ennemi depuis un territoire de sa bannière', r.d.player?.territory === 'galatea', r.d.error);
    r = await blue('/act', { action: 'attack' });
    check('il attaque pour les jaunes', terrOf(r.d.map, 'galatea').battle?.attacker === 'jaune');
    before = (await blue('/me')).d.character;
    await sleep(TURN * 6 + 2500);
    map = (await blue('/map')).d;
    const after = (await blue('/me')).d;
    check('conquête au nom des jaunes', terrOf(map, 'galatea').faction === 'jaune');
    check('gains de bataille -50 % (75 or au lieu de 150, 30 xp au lieu de 60)', after.character.gold === before.gold + 75 && after.character.xp === before.xp + 30, `+${after.character.gold - before.gold} or, +${after.character.xp - before.xp} xp`);
    check('le joueur reste une personne de la faction bleue', after.character.faction === 'bleue' && after.player.faction === 'jaune');
    nt = await notifsOf(red);
    check('personne n\'est prévenu à tort', !nt.some((x) => x.type === 'exile_lost'));

    // ---------- 4. La bannière d'adoption tombe : l'exilé peut en choisir une autre
    sql("UPDATE territories SET faction = 'rouge' WHERE faction = 'jaune'");
    await blue('/map');
    me2 = (await blue('/me')).d;
    check('la bannière tombe : l\'exilé tombe avec elle', me2.player.status === 'dead' && me2.player.exile === false && me2.player.factionOut);
    nt = await notifsOf(blue);
    check('il en est prévenu', nt.some((x) => x.type === 'exile_lost' && x.params.faction === 'jaune'));
    map = (await blue('/map')).d;
    check('et peut choisir une autre bannière', map.exile && map.exile.options.sort().join(',') === 'eglise,violette', JSON.stringify(map.exile));
    check('la campagne continue', map.campaign.id === 1);

    // ---------- 5. Missions d'exil et série gelée (jour fixé pour les tests)
    await restart({ TEST_DAY: '2026-04-10' });
    place('Joueur1', 'hresvelg');
    for (let i = 0; i < 3; i += 1) await red('/act', { action: 'gather' });
    r = await red('/missions/daily/claim', { id: 'recolte' });
    check('témoin : un joueur en jeu n\'a pas de missions d\'exil', r.s === 200 && r.d.daily.exile.length === 0 && r.d.daily.streak === 1, `série ${r.d.daily?.streak}`);
    let dm = (await blue('/missions')).d.daily;
    check('un joueur tombé voit les missions d\'exil', dm.exile.length === 3 && dm.exile.map((m) => m.id).join(',') === 'temoin,armes,autre-banniere', dm.exile.map((m) => m.id).join(','));
    check('et sa série est gelée', dm.frozen === true);
    r = await blue('/missions/daily/claim', { id: 'temoin' });
    check('mission d\'exil non accomplie refusée', r.d.error === 'reward_unavailable', r.d.error);
    await blue('/journal');
    dm = (await blue('/missions')).d.daily;
    check('consulter le journal accomplit « Témoin de l\'histoire »', dm.exile.find((m) => m.id === 'temoin').status === 'done');
    const pill = (await blue('/me')).d.claimable;
    const goldBefore = (await blue('/me')).d.character.gold;
    r = await blue('/missions/daily/claim', { id: 'temoin' });
    check('pastille des missions : compte la mission d\'exil à récupérer', pill >= 1, 'pastille ' + pill);
    check('récompense de l\'exil avec bonus de série (55 or)', r.s === 200 && r.d.daily.streak === 1 && r.d.character.gold === goldBefore + 55, `+${r.d.character?.gold - goldBefore} or, série ${r.d.daily?.streak}`);

    await restart({ TEST_DAY: '2026-04-12' }); // un jour entier sans rien récupérer
    await blue('/map');
    dm = (await blue('/missions')).d.daily;
    check('2 jours plus tard, la série du joueur tombé est intacte', dm.streak === 1 && dm.frozen, `série ${dm.streak}`);
    check('alors que celle d\'un joueur en jeu est cassée', (await red('/missions')).d.daily.streak === 0);
    await blue('/journal');
    r = await blue('/missions/daily/claim', { id: 'temoin' });
    check('et elle continue de grandir', r.d.daily?.streak === 2, `série ${r.d.daily?.streak}`);

    // ---------- 6. Nouvelle bannière chez les Loups de cendre
    r = await blue('/exile', { faction: 'violette' });
    check('exil chez les Loups de cendre : apparition à Garreg-Mach', r.s === 200 && r.d.player.territory === 'garreg-mach' && r.d.player.faction === 'violette' && r.d.player.exile, r.d.error);
    dm = (await blue('/missions')).d.daily;
    check('« Prendre les armes » accomplie, série plus gelée', dm.exile.find((m) => m.id === 'armes').status === 'done' && dm.frozen === false);
    check('nouvelle bannière : bonus de force du petit nombre pour l\'exilé', r.d.map.perks && r.d.map.perks.powerBonus >= 1);

    // ---------- 7. Les Loups de cendre acceptent toujours des exilés, même quand ils dominent la carte
    await restart();
    sql("UPDATE territories SET faction = 'violette' WHERE faction = 'rouge' AND id != 'hresvelg'");
    await yellow('/map');
    let m = (await yellow('/map')).d;
    check('en tête, les Loups acceptent encore des exilés (la faction rouge aussi, l\'Église aussi)', m.exile && m.exile.options.sort().join(',') === 'eglise,rouge,violette', JSON.stringify(m.exile));

    // ---------- 8. L'Église n'accueille plus d'exilés quand elle a perdu son dernier territoire
    me3 = (await blue3('/me')).d;
    check('le joueur exilé chez l\'Église est toujours en jeu', me3.player.exile && me3.player.faction === 'eglise' && me3.player.status === 'alive');
    sql("UPDATE territories SET faction = 'rouge' WHERE id = 'garreg-mach'");
    await blue3('/map');
    me3 = (await blue3('/me')).d;
    check('l\'Église tombe : son exilé tombe avec elle', me3.player.status === 'dead' && !me3.player.exile, JSON.stringify(me3.player));
    nt = await notifsOf(blue3);
    check('il en est prévenu', nt.some((x) => x.type === 'exile_lost' && x.params.faction === 'eglise'));
    m = (await blue3('/map')).d;
    check('l\'Église n\'est plus proposée', m.exile && m.exile.options.sort().join(',') === 'rouge,violette', JSON.stringify(m.exile));
    const j2 = (await blue3('/journal')).d.events;
    check('journal : l\'Église a perdu son dernier territoire', j2.some((e) => e.type === 'faction_out' && e.params.faction === 'eglise'));
    check('la campagne n\'est pas terminée pour autant', (await blue3('/map')).d.campaign.id === 1);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    await stop();
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
  }
})();
