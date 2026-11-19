// Teste les avantages des Loups de cendre sur un serveur temporaire (base jetable, tours de 2 secondes).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3112;
const TURN = 2000;
const server = spawn(process.execPath, [serverFile], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_ROLL: '0' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
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
const terrOf = (map, id) => map.territories.find((t) => t.id === id);

(async () => {
  try {
    await sleep(1200);
    const wolf = await player('violette');           // Joueur1
    let map = (await wolf('/map')).d;
    check('seul en jeu : pas de bonus de force', map.perks && map.perks.powerBonus === 1, JSON.stringify(map.perks));
    const red1 = await player('rouge');               // Joueur2
    map = (await wolf('/map')).d;
    check('à effectif égal : pas de bonus', map.perks.powerBonus === 1, map.perks.powerBonus);
    await player('rouge'); await player('rouge');     // Joueur3, Joueur4 : 3 rouges contre 1 loup
    await player('bleue');                            // Joueur5 : moyenne des autres = (3 + 1) / 2 = 2
    map = (await wolf('/map')).d;
    check('en infériorité : bonus égal à l\'écart d\'effectif', map.perks.powerBonus === 2, map.perks.powerBonus);
    check('les autres factions n\'ont pas d\'avantages', (await red1('/map')).d.perks === null);
    for (let i = 0; i < 6; i += 1) await player('rouge'); // 9 rouges : moyenne (9 + 1) / 2 = 5, plafonné à 3
    map = (await wolf('/map')).d;
    check('bonus plafonné à ×3', map.perks.powerBonus === 3, map.perks.powerBonus);
    check('retour en jeu annoncé gratuit', map.costs.revive === 0 && (await red1('/map')).d.costs.revive === 100);

    // Conquête : force triplée, gains doublés
    let r = await wolf('/move', { to: 'varley' });
    r = await wolf('/act', { action: 'attack' });
    const chance = terrOf(r.d.map, 'varley').battle.chance;
    check('une action de Loup pèse 3 (60 % au lieu de 33 %)', chance === 60, chance + ' %');
    let gold = r.d.character.gold;
    await sleep(TURN * 6 + 1500);
    let me = (await wolf('/me')).d;
    map = (await wolf('/map')).d;
    check('territoire conquis', terrOf(map, 'varley').faction === 'violette');
    check('or et expérience doublés', me.character.gold === gold + 300 && me.character.xp === 120, `+${me.character.gold - gold} or, ${me.character.xp} xp`);

    // Perte du territoire : repli automatique, pas de game over
    place('Joueur2', 'varley');
    await red1('/act', { action: 'attack' });
    await sleep(TURN * 6 + 1500);
    me = (await wolf('/me')).d;
    map = (await wolf('/map')).d;
    check('territoire repris par les rouges', terrOf(map, 'varley').faction === 'rouge');
    check('repli automatique à Garreg-Mach, sans délai', me.player.status === 'alive' && me.player.territory === 'garreg-mach', JSON.stringify(me.player));
    check('plus aucun territoire, mais pas hors jeu', me.player.factionOut === false && map.campaign.id === 1);
    const nt = (await wolf('/notifications')).d.notifications;
    check('repli notifié', nt.some((x) => x.type === 'auto_retreat' && x.params.home === 'garreg-mach') && !nt.some((x) => x.type === 'faction_out'));
    r = await wolf('/move', { to: 'varley' });
    check('ils peuvent repartir à l\'attaque', r.d.player?.territory === 'varley', r.d.error);

    // Retour gratuit
    sql("UPDATE player_state SET status = 'dead' WHERE user_id = (SELECT user_id FROM characters WHERE pseudo = 'Joueur1')");
    sql("UPDATE characters SET gold = 0 WHERE pseudo = 'Joueur1'");
    r = await wolf('/revive', { mode: 'gold' });
    check('retour gratuit, même sans or', r.d.player?.status === 'alive' && r.d.player.territory === 'garreg-mach' && r.d.character.gold === 0, r.d.error);

    // Points triplés par territoire : les Loups tiennent Varley, et toutes les autres factions avec joueurs sont hors jeu
    sql("UPDATE territories SET faction = 'violette' WHERE id = 'varley'");
    sql("UPDATE territories SET faction = 'jaune' WHERE faction IN ('rouge', 'bleue')");
    await sleep(TURN + 1500);
    map = (await wolf('/map')).d;
    check('les autres factions hors jeu : les Loups gagnent', map.campaign.id === 2, 'campagne ' + map.campaign.id);
    check('points : 100 + 1 territoire × 10 × 3 + 1 survivant × 5', map.points.violette >= 135 && map.points.violette < 400, JSON.stringify(map.points));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    server.kill();
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
  }
})();
