// Teste la condition supplémentaire de Dark Mage (3) et Dark Bishop (15) : attaques des Serpents repoussées.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3114;
const TURN = 2000;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), BOSS_CHANCE: '0', CADENCE_GOLD: '0', ...env },
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
// Ajoute une bataille déjà lancée dont le joueur est défenseur, qui se termine dans 1,5 seconde.
const addBattle = (attacker, defender, territory, pseudo, bossPower) => withDb((d) => {
  const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
  const now = Date.now();
  const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(cid, territory, attacker, defender, bossPower, now, now + 1500).lastInsertRowid);
  const uid = d.prepare('SELECT user_id FROM characters WHERE pseudo = ?').get(pseudo).user_id;
  d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind) VALUES (?, ?, ?, ?, 'defense', 1, ?, NULL, 'action')")
    .run(id, territory, uid, defender, now);
});
const setStat = (pseudo, n) => withDb((d) => d.prepare(`INSERT INTO player_events (user_id, event, count) VALUES ((SELECT user_id FROM characters WHERE pseudo = ?), 'serpents_repelled', ?)
  ON CONFLICT (user_id, event) DO UPDATE SET count = excluded.count`).run(pseudo, n));

(async () => {
  try {
    await start({ TEST_ROLL: '0.999' }); // les attaques échouent toujours
    const call = client();
    await call('/register', { email: 'joueur1@example.test', password: 'mot-de-passe-test-1', passwordConfirm: 'mot-de-passe-test-1' });
    await call('/character', { pseudo: 'Joueur1', birthday: '1995-04-12', class: 'monk', avatar: 'avatar_1.webp', faction: 'rouge' });
    withDb((d) => d.prepare("UPDATE characters SET class = 'mage', xp = 1000000, gold = 500000 WHERE pseudo = 'Joueur1'").run());
    let me = (await call('/me')).d;
    check('aucune attaque repoussée au départ', !me.stats.serpents_repelled);
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(serverFile), 'public', 'config', 'game.json'), 'utf8'));
    const unlock = (id) => cfg.classes.find((c) => c.id === id)?.unlock;
    check('config : Dark Mage demande 3 attaques repoussées, Dark Bishop 15, aucune autre classe rien',
      unlock('dark-mage')?.count === 3 && unlock('dark-bishop')?.count === 15 && cfg.classes.filter((c) => c.unlock).length === 2);

    let r = await call('/class', { class: 'dark-mage' });
    check('Dark Mage refusé sans l\'exploit, même avec renommée, or et chemin', r.d.error === 'class_unlock', r.d.error);

    // 1. Attaque des Serpents repoussée par un défenseur : +1
    addBattle('serpents', 'rouge', 'hresvelg', 'Joueur1', 3);
    await sleep(3500);
    me = (await call('/me')).d;
    check('une attaque des Serpents repoussée compte (1)', me.stats.serpents_repelled === 1, JSON.stringify(me.stats));
    check('notification de défense réussie', (await call('/notifications')).d.notifications.some((n) => n.type === 'territory_defended'));

    // 2. Attaque d'une faction jouable repoussée : ne compte pas
    addBattle('jaune', 'rouge', 'varley', 'Joueur1', 0);
    await sleep(3500);
    me = (await call('/me')).d;
    check('une attaque repoussée d\'une faction jouable ne compte pas', me.stats.serpents_repelled === 1, JSON.stringify(me.stats));

    // 3. Attaque des Serpents réussie : ne compte pas
    await restart({ TEST_ROLL: '0' });
    addBattle('serpents', 'rouge', 'bergliez', 'Joueur1', 3);
    await sleep(3500);
    me = (await call('/me')).d;
    check('une attaque des Serpents qui réussit ne compte pas', me.stats.serpents_repelled === 1, JSON.stringify(me.stats));
    check('et le territoire passe aux Serpents', (await call('/map')).d.territories.find((t) => t.id === 'bergliez').faction === 'serpents');

    // 4. Seuils : 2 refusé, 3 accepté pour Dark Mage ; 3 refusé, 15 accepté pour Dark Bishop
    setStat('Joueur1', 2);
    r = await call('/class', { class: 'dark-mage' });
    check('2 attaques repoussées : Dark Mage refusé', r.d.error === 'class_unlock', r.d.error);
    setStat('Joueur1', 3);
    const gold = (await call('/me')).d.character.gold;
    r = await call('/class', { class: 'dark-mage' });
    check('3 attaques repoussées : Dark Mage accordé et facturé 7 250 or', r.s === 200 && r.d.character.class === 'dark-mage' && r.d.character.gold === gold - 7250, r.d.error || `${r.d.character?.class} ${r.d.character?.gold}`);
    r = await call('/class', { class: 'dark-bishop' });
    check('Dark Bishop refusé avec 3 seulement', r.d.error === 'class_unlock', r.d.error);
    setStat('Joueur1', 14);
    r = await call('/class', { class: 'dark-bishop' });
    check('14 attaques repoussées : Dark Bishop refusé', r.d.error === 'class_unlock', r.d.error);
    setStat('Joueur1', 15);
    r = await call('/class', { class: 'dark-bishop' });
    check('15 attaques repoussées : Dark Bishop accordé', r.s === 200 && r.d.character.class === 'dark-bishop', r.d.error || r.d.character?.class);
    r = await call('/class', { class: 'warlock' });
    check('les autres classes ne demandent pas cet exploit (prérequis de chemin seulement)', r.d.error === 'class_path', r.d.error);
    me = (await call('/me')).d;
    check('le compteur reste visible dans le profil', me.stats.serpents_repelled === 15);
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    await stop();
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
  }
})();
