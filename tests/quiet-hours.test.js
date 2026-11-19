// Teste les heures calmes des Serpents des Ténèbres (pas d'apparition de minuit à 6 h, heure de Paris) et la chance de 7 %.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [serverFile, dataDir] = process.argv.slice(2);
const PORT = 3115;
const TURN = 2000;
let server;
const start = (env = {}) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), CADENCE_GOLD: '0', TEST_ROLL: '0', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, total = 0;
const check = (label, ok, detail = '') => { total += 1; if (!ok) failures += 1; console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${label}${detail !== '' ? ' — ' + detail : ''}`); };
async function bosses() {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(`http://localhost:${PORT}/api${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return r.json();
  };
  await call('/register', { email: 'joueur1@example.test', password: 'mot-de-passe-test-1', passwordConfirm: 'mot-de-passe-test-1' });
  await call('/character', { pseudo: 'Joueur1', birthday: '1995-04-12', class: 'soldier', avatar: 'avatar_1.webp', faction: 'rouge' });
  const map = await call('/map');
  return map.territories.filter((t) => t.battle && t.battle.boss).length;
}
const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(serverFile), 'public', 'config', 'game.json'), 'utf8'));
const paris = (iso) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).format(Date.parse(iso)));

(async () => {
  try {
    check('config : 7 % de chances par tour', cfg.campaign.boss.chancePerTurn === 0.07, String(cfg.campaign.boss.chancePerTurn));
    check('config : interdit de minuit (inclus) à 6 h (exclu), heure de Paris', JSON.stringify(cfg.campaign.boss.quietHours) === '{"from":0,"to":6,"timezone":"Europe/Paris"}');
    // Lecture de l'heure de Paris : heure d'hiver (UTC+1) et d'été (UTC+2), y compris autour de minuit et de 6 h.
    check('heure de Paris, hiver : 23 h 30 UTC = 0 h', paris('2026-01-15T23:30:00Z') === 0);
    check('heure de Paris, hiver : 4 h 59 UTC = 5 h (calme)', paris('2026-01-15T04:59:00Z') === 5);
    check('heure de Paris, hiver : 5 h 00 UTC = 6 h (fin du calme)', paris('2026-01-15T05:00:00Z') === 6);
    check('heure de Paris, été : 22 h 30 UTC = 0 h', paris('2026-07-15T22:30:00Z') === 0);
    check('heure de Paris, été : 3 h 59 UTC = 5 h (calme)', paris('2026-07-15T03:59:00Z') === 5);
    check('heure de Paris, été : 4 h 00 UTC = 6 h (fin du calme)', paris('2026-07-15T04:00:00Z') === 6);

    for (const [hour, expectBoss] of [[0, false], [3, false], [5, false], [6, true], [12, true], [23, true]]) {
      await start({ BOSS_CHANCE: '1', TEST_HOUR: String(hour) });
      await sleep(TURN * 3);
      const n = await bosses();
      await stop();
      check(`à ${hour} h : ${expectBoss ? 'un mini-boss peut apparaître' : 'aucun mini-boss'}`, expectBoss ? n === 1 : n === 0, `${n} mini-boss`);
    }
    // Une bataille déjà commencée continue pendant la nuit : un boss apparu le jour se règle à 3 h.
    await start({ BOSS_CHANCE: '1', TEST_HOUR: '12' });
    await sleep(TURN * 2);
    await bosses();
    await stop();
    server = spawn(process.execPath, [serverFile], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: String(TURN / 1000), CADENCE_GOLD: '0', TEST_ROLL: '0', BOSS_CHANCE: '1', TEST_HOUR: '3' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await sleep(1500 + TURN * 8);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'conquete.db'), { readOnly: true });
    const rows = db.prepare("SELECT resolved_at, success FROM battles WHERE attacker = 'serpents'").all();
    db.close();
    await stop();
    check('une bataille commencée de jour se termine normalement la nuit', rows.length === 1 && rows[0].resolved_at && rows[0].success === 1, JSON.stringify(rows));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
