// Teste les relations entre joueurs (offrandes, relation partagée plafonnée à A+, « Dire merci », bonus de combat ensemble),
// les proches dans les profils, et les ordres donnés aux généraux.
// Usage : node tests/players.test.js <server.js> <dossier de données temporaire>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [serverFile, dataDir] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const PORT = 3127;
const GAME = require(path.join(process.cwd(), 'public', 'config', 'game.json'));
const RP = GAME.relations.players;
let server;
const start = (env = {}) => {
  server = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TURN_SECONDS: '2', BOSS_CHANCE: '0', CADENCE_GOLD: '0', TEST_HOUR: '12', GEN_ATTACK_CHANCE: '0', TEST_RAID_ROLL: '1', TEST_ROLL: '0', TEST_MOVE_ROLL: '0.999', TEST_REL_ROLL: '0.999', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((r) => setTimeout(r, 1500));
};
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
const set = (n, sql, ...a) => withDb((d) => d.prepare(sql).run(...a, uid(n)));
const pairPts = (x, y) => { const [a, b] = [uid(x), uid(y)].sort((m, n) => m - n); return row('SELECT points FROM player_relations WHERE a = ? AND b = ?', a, b)?.points || 0; };
const setPair = (x, y, n) => { const [a, b] = [uid(x), uid(y)].sort((m, n2) => m - n2); run('INSERT INTO player_relations (a, b, points) VALUES (?, ?, ?) ON CONFLICT (a, b) DO UPDATE SET points = excluded.points', a, b, n); };
const fill = (n) => set(n, "UPDATE player_state SET actions = 8, actions_at = ?, status = 'alive' WHERE user_id = ?", Date.now());
const MAP = require(path.join(process.cwd(), 'public', 'config', 'map.json'));
const resetMap = () => withDb((d) => { const up = d.prepare('UPDATE territories SET faction = ? WHERE id = ?'); for (const t of MAP.territories) up.run(t.faction || null, t.id); d.exec('DELETE FROM battles; DELETE FROM contributions; DELETE FROM general_contribs; DELETE FROM general_verdicts'); });
function battle(territory, attacker, defender, contribs) {
  return withDb((d) => {
    const cid = d.prepare('SELECT id FROM campaigns WHERE ended_at IS NULL').get().id;
    const now = Date.now();
    const id = Number(d.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(cid, territory, attacker, defender, now, now + 600000).lastInsertRowid);
    for (const [n, side, faction] of contribs) d.prepare("INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'action', 0)").run(id, territory, uid(n), faction, side, now);
    return id;
  });
}
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(400); } return false; };

(async () => {
  try {
    await start();
    await mk('Rouge1', 'rouge'); await mk('Rouge2', 'rouge'); await mk('Bleu1', 'bleue');
    for (const n of ['Rouge1', 'Rouge2', 'Bleu1']) set(n, 'UPDATE characters SET gold = 5000 WHERE user_id = ?');

    console.log('# Offrandes entre joueurs');
    fill('Rouge1');
    let r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'compliment' });
    check('compliment : 1 action, +1', r.s === 200 && r.d.gift.gained === 1 && r.d.player.actions === 7, JSON.stringify([r.s, r.d.error, r.d.gift]));
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'letter' });
    check('lettre : 200 or, +25', r.s === 200 && r.d.gift.points === 26 && r.d.character.gold === 4800, JSON.stringify([r.d.gift, r.d.character?.gold]));
    r = await C.Rouge2('/relations/player/gift', { pseudo: 'Rouge1', kind: 'flower' });
    check('relation partagée : la fleur de l\'autre s\'ajoute (26 + 5)', r.s === 200 && r.d.gift.points === 31 && pairPts('Rouge1', 'Rouge2') === 31, JSON.stringify([r.d.gift, pairPts('Rouge1', 'Rouge2')]));
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge1', kind: 'flower' });
    check('pas d\'offrande à soi-même', r.s === 409 || r.s === 404, JSON.stringify(r));
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Bleu1', kind: 'flower' });
    check('offrande possible à un joueur d\'un autre camp', r.s === 200, JSON.stringify(r.d));
    // Cadeau sur place : même territoire, toutes les 30 minutes par paire.
    set('Rouge1', "UPDATE player_state SET territory = 'hresvelg' WHERE user_id = ?");
    set('Rouge2', "UPDATE player_state SET territory = 'aegir' WHERE user_id = ?");
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'present' });
    check('cadeau refusé loin de l\'autre joueur', r.s === 409 && r.d.error === 'not_together', JSON.stringify(r.d));
    set('Rouge2', "UPDATE player_state SET territory = 'hresvelg' WHERE user_id = ?");
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'present' });
    check('cadeau sur place : gratuit, +10', r.s === 200 && r.d.gift.gained === 10 && r.d.relation.presentReadyAt > Date.now() + 29 * 60000, JSON.stringify([r.d.error, r.d.gift]));
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'present' });
    check('cadeau : 30 minutes entre deux', r.s === 429 && r.d.error === 'gift_cooldown', JSON.stringify(r.d));
    r = await C.Rouge2('/relations/player/gift', { pseudo: 'Rouge1', kind: 'present' });
    check('le délai est propre à chaque sens', r.s === 200, JSON.stringify(r.d));
    // Plafond : A+.
    setPair('Rouge1', 'Rouge2', RP.maxLevel === 'A+' ? 1390 : 0);
    fill('Rouge1');
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'letter' });
    check('plafond A+ (1 400)', r.s === 200 && r.d.gift.points === 1400 && r.d.gift.level === 'A+', JSON.stringify(r.d.gift));
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'compliment' });
    check('au-delà de A+ : refusé', r.s === 409 && r.d.error === 'support_max', JSON.stringify(r.d));

    console.log('# Dire merci');
    setPair('Rouge1', 'Rouge2', 100);
    fill('Rouge1');
    r = await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'letter' });
    let notifs = (await C.Rouge2('/notifications')).d.notifications.filter((n) => n.type === 'player_gift');
    const letterN = notifs.find((n) => n.params.kind === 'letter');
    check('notification reçue avec le bouton merci', !!letterN && letterN.params.thanks === 'open' && letterN.params.pseudo === 'Rouge1', JSON.stringify(letterN?.params));
    r = await C.Rouge2('/relations/thanks', { gift: letterN.params.gift });
    check('merci : +20 % de 25 = +5', r.s === 200 && r.d.thanks.gained === 5 && pairPts('Rouge1', 'Rouge2') === 130, JSON.stringify([r.d, pairPts('Rouge1', 'Rouge2')]));
    r = await C.Rouge2('/relations/thanks', { gift: letterN.params.gift });
    check('merci une seule fois', r.s === 409 && r.d.error === 'already_thanked', JSON.stringify(r.d));
    notifs = (await C.Rouge2('/notifications')).d.notifications.filter((n) => n.type === 'player_gift' && n.params.gift === letterN.params.gift);
    check('la notification passe à « merci envoyé »', notifs[0]?.params.thanks === 'thanked', JSON.stringify(notifs[0]?.params));
    check('celui qui a offert est prévenu', !!row("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'player_thanks'", uid('Rouge1')));
    r = await C.Rouge1('/relations/thanks', { gift: letterN.params.gift });
    check('seul le destinataire peut dire merci', r.s === 404, JSON.stringify(r.d));
    fill('Rouge1');
    await C.Rouge1('/relations/player/gift', { pseudo: 'Rouge2', kind: 'compliment' });
    const old = row("SELECT id FROM player_gifts WHERE kind = 'compliment' ORDER BY id DESC LIMIT 1").id;
    run('UPDATE player_gifts SET at = ? WHERE id = ?', Date.now() - 25 * 3_600_000, old);
    r = await C.Rouge2('/relations/thanks', { gift: old });
    check('merci au-delà de 24 h : refusé', r.s === 409 && r.d.error === 'thanks_expired', JSON.stringify(r.d));
    r = await C.Rouge1('/relations');
    check('les joueurs apparaissent dans les relations', r.d.players.some((x) => x.pseudo === 'Rouge2' && x.points === 131), JSON.stringify(r.d.players));

    console.log('# Bonus quand on combat ensemble');
    resetMap();
    setPair('Rouge1', 'Rouge2', 600); // B : +3 %
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge'], ['Rouge2', 'attack', 'rouge']]);
    let b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('niveau B : +3 % chacun (2 × 1,03)', Math.abs(b.power.attack - 2.06) < 0.011, String(b.power.attack));
    setPair('Rouge1', 'Rouge2', 1400); // A+ : +6 %
    b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('niveau A+ : +6 % chacun', Math.abs(b.power.attack - 2.12) < 0.011, String(b.power.attack));
    setPair('Rouge1', 'Bleu1', 1400);
    resetMap();
    battle('rowe', 'rouge', 'bleue', [['Rouge1', 'attack', 'rouge'], ['Bleu1', 'defense', 'bleue']]);
    b = (await C.Rouge1('/map')).d.territories.find((x) => x.id === 'rowe').battle;
    check('pas de bonus face à face (camps différents)', Math.abs(b.power.attack - 1) < 0.011, String(b.power.attack));
    let pr = await C.Bleu1('/profile?pseudo=Rouge1');
    check('liste des bonus : soutiens entre joueurs (même camp seulement)', pr.d.mods.some((m) => m.type === 'playerSupport' && m.n === 1), JSON.stringify(pr.d.mods.filter((m) => m.type === 'playerSupport')));
    check('profil : niveau de soutien avec moi', pr.d.relation && pr.d.relation.level === 'A+', JSON.stringify(pr.d.relation));

    console.log('# Les plus proches');
    run("INSERT INTO relations (user_id, gid, points) VALUES (?, 'ferdinand', 500) ON CONFLICT (user_id, gid) DO UPDATE SET points = excluded.points", uid('Rouge1'));
    pr = await C.Rouge2('/profile?pseudo=Rouge1');
    const cl = pr.d.closest || [];
    check('proches d\'un joueur : généraux et joueurs triés', cl.length === 3 && cl[0].points === 1400 && cl.some((x) => x.type === 'general' && x.id === 'ferdinand'), JSON.stringify(cl));
    pr = await C.Rouge2('/profile?general=ferdinand');
    check('proches d\'un général : ses joueurs', (pr.d.closest || []).some((x) => x.id === 'Rouge1' && x.level === 'C+'), JSON.stringify(pr.d.closest));

    console.log('# Ordres aux généraux');
    resetMap();
    run("UPDATE generals SET territory = 'aegir', actions = 4, move_turn = -1, status = 'alive' WHERE gid = 'ferdinand'");
    pr = await C.Rouge2('/profile?general=ferdinand');
    check('sans soutien C : pas d\'ordre possible', pr.d.command && !pr.d.command.can && pr.d.command.reason === 'level', JSON.stringify(pr.d.command));
    r = await C.Rouge2('/general/order', { general: 'ferdinand', kind: 'move', target: 'hresvelg' });
    check('ordre refusé sans soutien C', r.s === 409 && r.d.error === 'order_level', JSON.stringify(r.d));
    pr = await C.Rouge1('/profile?general=ferdinand');
    check('soutien C : ordres et territoires possibles', pr.d.command?.can && pr.d.command.targets.move.length > 0 && pr.d.command.targets.attack.length > 0, JSON.stringify(pr.d.command));
    pr = await C.Bleu1('/profile?general=ferdinand');
    check('un joueur d\'un autre camp ne commande pas', pr.d.command && !pr.d.command.can && pr.d.command.reason === 'camp', JSON.stringify(pr.d.command));
    pr = await C.Rouge1('/profile?general=edelgard');
    check('un seigneur ne se commande pas', pr.d.command === null, JSON.stringify(pr.d.command));
    const terrs = (await C.Rouge1('/map')).d.territories;
    const nb = terrs.find((x) => x.id === 'aegir').neighbors;
    const ownerOf = (id) => terrs.find((x) => x.id === id).faction;
    const moveTo = nb.find((id) => ownerOf(id) === 'rouge');
    run("UPDATE generals SET move_turn = 999999999999 WHERE gid = 'ferdinand'"); // il attend le temps des vérifications
    r = await C.Rouge1('/general/order', { general: 'ferdinand', kind: 'move', target: moveTo });
    check('ordre donné : se déplacer', r.s === 200 && r.d.general.order?.kind === 'move' && r.d.general.order.mine, JSON.stringify([r.s, r.d.error, r.d.general]));
    run("INSERT INTO relations (user_id, gid, points) VALUES (?, 'ferdinand', 300) ON CONFLICT (user_id, gid) DO UPDATE SET points = excluded.points", uid('Rouge2'));
    r = await C.Rouge2('/general/order', { general: 'ferdinand', kind: 'move', target: moveTo });
    check('un seul ordre à la fois', r.s === 409 && r.d.error === 'general_busy', JSON.stringify(r.d));
    pr = await C.Rouge2('/profile?general=ferdinand');
    check('l\'ordre en cours est visible des autres', pr.d.order && pr.d.order.by === 'Rouge1' && !pr.d.order.mine, JSON.stringify(pr.d.order));
    check('sur la carte : général sous ordre', (await C.Rouge1('/map')).d.territories.flatMap((x) => x.occupants).some((o) => o.gid === 'ferdinand' && o.ordered));
    run("UPDATE generals SET move_turn = -1, actions = 4 WHERE gid = 'ferdinand'");
    let done = await until(async () => { await C.Rouge1('/map'); return !row("SELECT 1 FROM general_orders WHERE gid = 'ferdinand'"); });
    const moved = row("SELECT territory FROM generals WHERE gid = 'ferdinand'").territory;
    const nOrd = row("SELECT params FROM notifications WHERE user_id = ? AND type = 'general_order' ORDER BY id DESC", uid('Rouge1'));
    check('le général se déplace et l\'ordre se termine', done && JSON.parse(nOrd?.params || '{}').outcome === 'done', JSON.stringify([done, moved, nOrd]));
    check('journal : ordre donné', (await C.Rouge1('/journal')).d.events.some((e) => e.type === 'general_order' && e.params.kind === 'move'));
    // Annuler son ordre.
    run("UPDATE generals SET territory = 'aegir', actions = 0, actions_at = ?, move_turn = 999999999999 WHERE gid = 'ferdinand'", Date.now());
    r = await C.Rouge1('/general/order', { general: 'ferdinand', kind: 'move', target: moveTo });
    r = await C.Rouge2('/general/order', { general: 'ferdinand', cancel: true });
    check('un autre joueur ne peut pas annuler', r.s === 409, JSON.stringify(r.d));
    r = await C.Rouge1('/general/order', { general: 'ferdinand', cancel: true });
    check('annuler son ordre', r.s === 200 && r.d.general.order === null, JSON.stringify(r.d.general));
    // Attaquer : il marche vers la cible et lance (ou rejoint) l'attaque.
    resetMap();
    run("UPDATE generals SET territory = 'aegir', actions = 4, move_turn = -1, status = 'alive' WHERE gid = 'ferdinand'");
    run("INSERT INTO campaign_meta (key, value) VALUES ('conquest', '1') ON CONFLICT (key) DO UPDATE SET value = '1'");
    pr = await C.Rouge1('/profile?general=ferdinand');
    const atk = pr.d.command.targets.attack.find((id) => nb.includes(id)) || pr.d.command.targets.attack[0];
    r = await C.Rouge1('/general/order', { general: 'ferdinand', kind: 'attack', target: atk });
    check('ordre donné : attaquer', r.s === 200, JSON.stringify(r.d.error));
    done = await until(async () => { await C.Rouge1('/map'); return !row("SELECT 1 FROM general_orders WHERE gid = 'ferdinand'"); }, 30000);
    const fought = row("SELECT b.territory FROM general_contribs g JOIN battles b ON b.id = g.battle_id WHERE g.gid = 'ferdinand' AND g.side = 'attack' ORDER BY b.id DESC");
    check('le général attaque la cible', done && fought?.territory === atk, JSON.stringify([done, fought, atk]));
    r = await C.Rouge1('/general/order', { general: 'ferdinand', kind: 'move', target: 'nowhere' });
    check('cible inconnue refusée', r.s === 400 || r.s === 409, JSON.stringify(r.d));
  } catch (e) {
    failures += 1;
    console.error('ERREUR', e);
  } finally {
    console.log(failures ? `\n${failures} ÉCHEC(S) sur ${total}` : `\nLes ${total} tests passent.`);
    if (server && server.exitCode === null) server.kill();
  }
})();
