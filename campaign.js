'use strict';
// Moteur de campagne : actions, déplacements, batailles, repli, retour en jeu, mini-boss,
// journal du monde, classement, fin de campagne et points.
// Tous les réglages viennent de config/game.json, clé "campaign".
//
// Le temps est découpé en tours (10 minutes par défaut). Rien ne tourne « en continu » : l'état du monde
// est remis à jour par tick(), appelé régulièrement par le serveur et avant chaque action d'un joueur.

module.exports = function createCampaign(ctx) {
  const { db, config, notify, grant, renown, HttpError, currentUser, readJson, send, startFaction, NEIGHBORS } = ctx;
  const onEvent = ctx.onEvent || (() => {});

  const C = {
    turnMinutes: 10, maxActions: 6, startActions: 6, battleTurns: 6, retreatTurns: 6,
    capitals: {}, homeBases: {}, annex: [],
    gather: { gold: 40, xp: 10 }, attackRewards: { gold: 150, xp: 60 }, defenseRewards: { gold: 60, xp: 25 },
    baseDefense: 2, npcDefense: {}, tierPower: {}, renownPower: 0.05, minChance: 0.05, maxChance: 0.95,
    boss: { faction: 'serpents', chancePerTurn: 0.07, max: 1, power: 3, quietHours: { from: 0, to: 6, timezone: 'Europe/Paris' } },
    points: { win: 100, territory: 10, survivor: 5, loserTerritory: 2, loserSurvivor: 3 },
    cadenceGold: 10,
    hire: { gold: 300, power: 1.5, perBattle: 2 },
    revive: { gold: 100 },
    ranking: { combat: 10, victory: 30, gather: 2, rewards: [1000, 600, 300] },
    underdogs: {},
    exile: { trailingOnly: true, rewardMultiplier: 0.75, alwaysOpen: [], npcHosts: [] },
    defeat: { consolationGold: 200 },
    classEffects: { auraCap: 25 },
    ...(config.campaign || {}),
  };
  const P = { renownBaseXp: 100, renownGrowth: 1.1, ...(config.player || {}) };
  // Pour les tests : TURN_SECONDS raccourcit les tours, TEST_ROLL fixe le tirage des batailles (0 = réussite),
  // BOSS_CHANCE remplace la probabilité d'apparition d'un mini-boss.
  const TURN_MS = (Number(process.env.TURN_SECONDS) || C.turnMinutes * 60) * 1000;
  const roll = () => (process.env.TEST_ROLL !== undefined ? Number(process.env.TEST_ROLL) : Math.random());
  const BOSS_CHANCE = process.env.BOSS_CHANCE !== undefined ? Number(process.env.BOSS_CHANCE) : C.boss.chancePerTurn;
  if (process.env.CADENCE_GOLD !== undefined) C.cadenceGold = Number(process.env.CADENCE_GOLD);

  const TERR = config.map.territories;
  const terr = (id) => TERR.find((t) => t.id === id);
  const ANNEX = new Set(C.annex);
  const PLAYABLE = new Set(config.factions.filter((f) => !f.npc).map((f) => f.id));
  const importance = (id) => Number(terr(id)?.importance) || 1;
  // Avantages d'une faction en infériorité (clé "underdogs") : refuge, retour gratuit, force du petit nombre, gains accrus.
  const perks = (faction) => C.underdogs[faction] || {};
  const neighbors = (id) => [...(NEIGHBORS.get(id) || [])];

  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      winner     TEXT,
      summary    TEXT
    );
    CREATE TABLE IF NOT EXISTS faction_points (
      faction TEXT PRIMARY KEY,
      points  INTEGER NOT NULL DEFAULT 0
    );
    -- État d'un joueur dans la campagne en cours. status : alive, retreating (doit se replier) ou dead.
    CREATE TABLE IF NOT EXISTS player_state (
      user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      territory     TEXT NOT NULL,
      actions       INTEGER NOT NULL,
      actions_at    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'alive',
      retreat_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS battles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      territory   TEXT NOT NULL,
      attacker    TEXT NOT NULL,
      defender    TEXT,
      boss_power  REAL NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL,
      ends_at     INTEGER NOT NULL,
      resolved_at INTEGER,
      success     INTEGER,
      chance      REAL
    );
    CREATE INDEX IF NOT EXISTS battles_open ON battles (resolved_at, territory);
    -- Une ligne par action Attaquer ou Défendre, ou par renfort payé (kind = 'hire').
    -- battle_id vide = garnison posée hors bataille (expire).
    CREATE TABLE IF NOT EXISTS contributions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      battle_id  INTEGER,
      territory  TEXT NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      faction    TEXT NOT NULL,
      side       TEXT NOT NULL,
      power      REAL NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS campaign_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Journal du monde : ce qui se passe sur la carte, visible par tous.
    CREATE TABLE IF NOT EXISTS world_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      type        TEXT NOT NULL,
      params      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    -- Un appel à l'aide par joueur et par bataille.
    CREATE TABLE IF NOT EXISTS battle_rallies (
      battle_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (battle_id, user_id)
    );
    -- Score de chaque joueur dans une campagne (classement).
    CREATE TABLE IF NOT EXISTS campaign_scores (
      campaign_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, user_id)
    );
    -- Distinctions gagnées par un joueur (une par campagne et par type).
    CREATE TABLE IF NOT EXISTS distinctions (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      distinction TEXT NOT NULL,
      campaign_id INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, distinction, campaign_id)
    );
  `);
  {
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols('player_state').includes('bonus_turn')) db.exec('ALTER TABLE player_state ADD COLUMN bonus_turn INTEGER');
    if (!cols('player_state').includes('revive_asked')) db.exec('ALTER TABLE player_state ADD COLUMN revive_asked INTEGER NOT NULL DEFAULT 0');
    if (!cols('contributions').includes('kind')) db.exec("ALTER TABLE contributions ADD COLUMN kind TEXT NOT NULL DEFAULT 'action'");
    // Exil : faction rejointe par un joueur dont la faction est hors jeu (vide = il combat pour la sienne).
    if (!cols('player_state').includes('exile_faction')) db.exec('ALTER TABLE player_state ADD COLUMN exile_faction TEXT');
    // Effets de classe : série d'actions du Combattant, malus de récompense après une téléportation, amende des replis ratés.
    if (!cols('player_state').includes('streak_territory')) db.exec('ALTER TABLE player_state ADD COLUMN streak_territory TEXT');
    if (!cols('player_state').includes('streak_count')) db.exec('ALTER TABLE player_state ADD COLUMN streak_count INTEGER NOT NULL DEFAULT 0');
    if (!cols('player_state').includes('reward_debuff')) db.exec('ALTER TABLE player_state ADD COLUMN reward_debuff INTEGER NOT NULL DEFAULT 0');
    if (!cols('player_state').includes('retreat_penalty')) db.exec('ALTER TABLE player_state ADD COLUMN retreat_penalty INTEGER NOT NULL DEFAULT 0');
    if (!cols('contributions').includes('streak')) db.exec('ALTER TABLE contributions ADD COLUMN streak INTEGER NOT NULL DEFAULT 0');
  }

  const iso = () => new Date().toISOString();
  const q = {
    campaign: db.prepare('SELECT * FROM campaigns WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'),
    newCampaign: db.prepare('INSERT INTO campaigns (started_at) VALUES (?)'),
    endCampaign: db.prepare('UPDATE campaigns SET ended_at = ?, winner = ?, summary = ? WHERE id = ?'),
    owners: db.prepare('SELECT id, faction FROM territories'),
    setOwner: db.prepare('UPDATE territories SET faction = ?, updated_at = ? WHERE id = ?'),
    char: db.prepare('SELECT user_id, pseudo, faction, class, class_path, xp, gold FROM characters WHERE user_id = ?'),
    gold: db.prepare('SELECT gold FROM characters WHERE user_id = ?'),
    takeGold: db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ?'),
    addGoldRaw: db.prepare('UPDATE characters SET gold = gold + ? WHERE user_id = ?'),
    // Joueurs en vie (ou en train de se replier) avec leur camp, leur classe et leur renommée : présence sur la carte.
    alivePlayers: db.prepare(`SELECT p.user_id, p.territory, COALESCE(p.exile_faction, c.faction) AS faction, c.class, c.class_path, c.xp
                              FROM player_state p JOIN characters c ON c.user_id = p.user_id WHERE p.status != 'dead'`),
    battleRows: db.prepare('SELECT user_id, faction, side, power, kind, streak FROM contributions WHERE battle_id = ?'),
    setStreak: db.prepare('UPDATE player_state SET streak_territory = ?, streak_count = ? WHERE user_id = ?'),
    setRewardDebuff: db.prepare('UPDATE player_state SET reward_debuff = ? WHERE user_id = ?'),
    tickDebuff: db.prepare('UPDATE player_state SET reward_debuff = MAX(reward_debuff - 1, 0) WHERE user_id = ?'),
    chars: db.prepare('SELECT user_id, faction FROM characters'),
    payGold: db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?'),
    loseXp: db.prepare('UPDATE characters SET xp = xp - ? WHERE user_id = ? AND xp >= ?'),
    state: db.prepare('SELECT * FROM player_state WHERE user_id = ?'),
    insertState: db.prepare('INSERT OR REPLACE INTO player_state (user_id, territory, actions, actions_at, status, retreat_until) VALUES (?, ?, ?, ?, ?, NULL)'),
    setActions: db.prepare('UPDATE player_state SET actions = ?, actions_at = ? WHERE user_id = ?'),
    setBonusTurn: db.prepare('UPDATE player_state SET bonus_turn = ? WHERE user_id = ?'),
    setTerritory: db.prepare("UPDATE player_state SET territory = ?, status = 'alive', retreat_until = NULL, retreat_penalty = 0, revive_asked = 0 WHERE user_id = ?"),
    setRetreating: db.prepare("UPDATE player_state SET status = 'retreating', retreat_until = ?, retreat_penalty = ? WHERE user_id = ?"),
    setDead: db.prepare("UPDATE player_state SET status = 'dead', retreat_until = NULL WHERE user_id = ?"),
    askRevive: db.prepare('UPDATE player_state SET revive_asked = 1 WHERE user_id = ?'),
    setExile: db.prepare('UPDATE player_state SET exile_faction = ? WHERE user_id = ?'),
    clearExile: db.prepare('UPDATE player_state SET exile_faction = NULL WHERE user_id = ?'),
    exilesOf: db.prepare('SELECT user_id FROM player_state WHERE exile_faction = ?'),
    deadPlayers: db.prepare("SELECT p.user_id, c.faction FROM player_state p JOIN characters c ON c.user_id = p.user_id WHERE p.status = 'dead'"),
    // Membres d'une faction qui ont pris part à la campagne (au moins un point au classement).
    participants: db.prepare('SELECT s.user_id FROM campaign_scores s JOIN characters c ON c.user_id = s.user_id WHERE s.campaign_id = ? AND s.score > 0 AND c.faction = ?'),
    addDistinction: db.prepare('INSERT OR IGNORE INTO distinctions (user_id, distinction, campaign_id, created_at) VALUES (?, ?, ?, ?)'),
    distinctions: db.prepare('SELECT distinction, count(*) AS n FROM distinctions WHERE user_id = ? GROUP BY distinction'),
    clearStates: db.prepare('DELETE FROM player_state'),
    retreatDue: db.prepare("SELECT user_id, retreat_penalty FROM player_state WHERE status = 'retreating' AND retreat_until <= ?"),
    // Joueurs d'une faction encore en jeu (pour les prévenir).
    factionPlayers: db.prepare(`SELECT p.user_id, p.territory FROM player_state p JOIN characters c ON c.user_id = p.user_id
                                WHERE COALESCE(p.exile_faction, c.faction) = ? AND p.status != 'dead'`),
    factionAll: db.prepare('SELECT user_id FROM characters WHERE faction = ?'),
    fallen: db.prepare(`SELECT c.user_id, c.pseudo FROM player_state p JOIN characters c ON c.user_id = p.user_id
                        WHERE COALESCE(p.exile_faction, c.faction) = ? AND p.status = 'dead' AND p.revive_asked = 1 AND c.user_id != ?`),
    // Un exilé compte dans la faction qu'il a rejointe.
    presence: db.prepare(`SELECT p.territory, COALESCE(p.exile_faction, c.faction) AS faction, count(*) AS n FROM player_state p JOIN characters c ON c.user_id = p.user_id
                          WHERE p.status != 'dead' GROUP BY p.territory, COALESCE(p.exile_faction, c.faction)`),
    aliveByFaction: db.prepare(`SELECT COALESCE(p.exile_faction, c.faction) AS faction, count(*) AS n, sum(p.status != 'dead') AS alive
                                FROM player_state p JOIN characters c ON c.user_id = p.user_id GROUP BY COALESCE(p.exile_faction, c.faction)`),
    openBattle: db.prepare('SELECT * FROM battles WHERE territory = ? AND resolved_at IS NULL'),
    openBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL'),
    dueBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL AND ends_at <= ? ORDER BY ends_at'),
    insertBattle: db.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    closeBattle: db.prepare('UPDATE battles SET resolved_at = ?, success = ?, chance = ? WHERE id = ?'),
    closeAllBattles: db.prepare('UPDATE battles SET resolved_at = ? WHERE resolved_at IS NULL'),
    addContribution: db.prepare('INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind, streak) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    attachGarrison: db.prepare(`UPDATE contributions SET battle_id = ?, expires_at = NULL
                                WHERE battle_id IS NULL AND territory = ? AND side = 'defense' AND faction = ? AND expires_at > ?`),
    dropGarrison: db.prepare('DELETE FROM contributions WHERE battle_id IS NULL AND (territory = ? OR expires_at <= ?)'),
    clearContributions: db.prepare('DELETE FROM contributions'),
    sidePower: db.prepare('SELECT side, sum(power) AS power, count(DISTINCT user_id) AS players FROM contributions WHERE battle_id = ? GROUP BY side'),
    sideUsers: db.prepare('SELECT DISTINCT user_id FROM contributions WHERE battle_id = ? AND side = ?'),
    myContribution: db.prepare('SELECT side FROM contributions WHERE battle_id = ? AND user_id = ? LIMIT 1'),
    // Renforts déjà payés par un joueur : dans cette bataille, ou en garnison sur ce territoire.
    hiredInBattle: db.prepare("SELECT count(*) AS n FROM contributions WHERE kind = 'hire' AND user_id = ? AND battle_id = ?"),
    hiredGarrison: db.prepare("SELECT count(*) AS n FROM contributions WHERE kind = 'hire' AND user_id = ? AND battle_id IS NULL AND territory = ? AND expires_at > ?"),
    rallied: db.prepare('SELECT 1 FROM battle_rallies WHERE battle_id = ? AND user_id = ?'),
    addRally: db.prepare('INSERT OR IGNORE INTO battle_rallies (battle_id, user_id) VALUES (?, ?)'),
    points: db.prepare('SELECT faction, points FROM faction_points'),
    addPoints: db.prepare(`INSERT INTO faction_points (faction, points) VALUES (?, ?)
                           ON CONFLICT (faction) DO UPDATE SET points = points + excluded.points`),
    meta: db.prepare('SELECT value FROM campaign_meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO campaign_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    clearFactionMeta: db.prepare("DELETE FROM campaign_meta WHERE key LIKE 'held:%' OR key LIKE 'out:%'"),
    addEvent: db.prepare('INSERT INTO world_events (campaign_id, type, params, created_at) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT id, type, params, created_at FROM world_events ORDER BY id DESC LIMIT 40'),
    purgeEvents: db.prepare('DELETE FROM world_events WHERE id <= (SELECT max(id) FROM world_events) - 300'),
    addScore: db.prepare(`INSERT INTO campaign_scores (campaign_id, user_id, score) VALUES (?, ?, ?)
                          ON CONFLICT (campaign_id, user_id) DO UPDATE SET score = score + excluded.score`),
    ranking: db.prepare(`SELECT s.user_id, s.score, c.pseudo, c.faction, c.avatar FROM campaign_scores s
                         JOIN characters c ON c.user_id = s.user_id WHERE s.campaign_id = ? AND s.score > 0
                         ORDER BY s.score DESC, s.user_id LIMIT ?`),
    myScore: db.prepare('SELECT score FROM campaign_scores WHERE campaign_id = ? AND user_id = ?'),
    betterScores: db.prepare('SELECT count(*) AS n FROM campaign_scores WHERE campaign_id = ? AND score > ?'),
  };

  const ownersMap = () => new Map(q.owners.all().map((r) => [r.id, r.faction]));
  const currentCampaign = () => {
    let c = q.campaign.get();
    if (!c) { q.newCampaign.run(iso()); c = q.campaign.get(); }
    return c;
  };
  const journal = (type, params = {}, t = Date.now()) => q.addEvent.run(currentCampaign().id, type, JSON.stringify(params), t);
  const score = (userId, n) => { if (n) q.addScore.run(currentCampaign().id, userId, n); };

  // ------------------------------------------------------------ Factions et joueurs
  // Une faction est hors jeu (« game over ») quand elle a perdu son dernier territoire.
  // Une faction qui n'en a jamais eu (les Loups de cendre au départ) reste en jeu.
  const isOut = (faction) => q.meta.get(`out:${faction}`)?.value === '1';
  function updateFactions(owners, t) {
    // Les factions non jouables qui accueillent des exilés (l'Église) tombent aussi : leurs exilés doivent choisir une autre bannière.
    for (const f of [...PLAYABLE, ...(C.exile.npcHosts || [])]) {
      const owns = TERR.some((x) => owners.get(x.id) === f);
      if (owns) { q.setMeta.run(`held:${f}`, '1'); continue; }
      if (perks(f).neverOut) continue; // son refuge la garde toujours en jeu
      if (q.meta.get(`held:${f}`)?.value !== '1' || isOut(f)) continue;
      q.setMeta.run(`out:${f}`, '1');
      journal('faction_out', { faction: f }, t);
      for (const { user_id: uid } of q.factionAll.all(f)) {
        if (q.state.get(uid)) q.setDead.run(uid);
        notify(uid, 'faction_out', { faction: f });
      }
      // Les exilés qui combattaient sous sa bannière tombent aussi, mais peuvent en choisir une autre.
      for (const { user_id: uid } of q.exilesOf.all(f)) {
        q.clearExile.run(uid);
        q.setDead.run(uid);
        notify(uid, 'exile_lost', { faction: f });
      }
      honorDefeated(f);
    }
  }

  // ------------------------------------------------------------ Exil et distinctions
  const DISTINCTIONS = new Map((config.distinctions || []).map((d) => [d.id, d]));
  // Camp pour lequel un joueur combat : la faction qu'il a rejointe en exil, sinon la sienne.
  function effFaction(userId) {
    const ch = q.char.get(userId);
    return ch ? (q.state.get(userId)?.exile_faction || ch.faction) : null;
  }
  // Un joueur dont la faction est hors jeu peut s'exiler sous la bannière :
  //  - d'une faction jouable qui ne domine pas la carte (sauf s'il n'y a pas d'autre choix) ;
  //  - d'une faction de `alwaysOpen` (les Loups de cendre), même si elle domine ;
  //  - d'une faction non jouable de `npcHosts` (l'Église de Seiros), tant qu'elle tient un territoire.
  function exileOptions(home) {
    if (!isOut(home)) return [];
    const owners = ownersMap();
    const held = (f) => TERR.filter((x) => !ANNEX.has(x.id) && owners.get(x.id) === f).length;
    const open = [...PLAYABLE].filter((f) => f !== home && !isOut(f) && spawnTerritory(f, owners));
    const top = open.length ? Math.max(...open.map(held)) : 0;
    const trailing = open.filter((f) => held(f) < top);
    const list = C.exile.trailingOnly && trailing.length ? [...trailing] : [...open];
    for (const f of C.exile.alwaysOpen || []) if (open.includes(f) && !list.includes(f)) list.push(f);
    for (const f of C.exile.npcHosts || []) if (!isOut(f) && spawnTerritory(f, owners) && !list.includes(f)) list.push(f);
    return list;
  }
  // Ce que peut faire un joueur tombé dont la faction est hors jeu (null si rien).
  function exileInfo(userId) {
    const ch = q.char.get(userId);
    const ps = q.state.get(userId);
    if (!ch || !ps || ps.status !== 'dead' || ps.exile_faction || !isOut(ch.faction)) return null;
    return { options: exileOptions(ch.faction), malus: Math.round((1 - (C.exile.rewardMultiplier ?? 1)) * 100) };
  }
  // Un exilé est moins bien payé : ses gains d'or et d'expérience sont réduits (rewardMultiplier).
  const exileMult = (userId) => (q.state.get(userId)?.exile_faction ? C.exile.rewardMultiplier ?? 1 : 1);
  // Joueur tombé dont la faction est hors jeu : sa série de missions du jour est gelée.
  function fallenState(userId) {
    const ch = q.char.get(userId);
    if (!ch) return { fallen: false, frozen: false };
    const fallen = isOut(ch.faction);
    return { fallen, frozen: fallen && q.state.get(userId)?.status === 'dead' };
  }
  // Distinction (titre et avatar exclusif), une par campagne et par type.
  function award(userId, id) {
    const d = DISTINCTIONS.get(id);
    if (!d || q.addDistinction.run(userId, id, currentCampaign().id, iso()).changes !== 1) return;
    notify(userId, 'distinction', { distinction: id });
    if (d.avatar && ctx.unlockAvatar) ctx.unlockAvatar(userId, d.avatar, `distinction:${id}`);
  }
  // Honneurs aux vaincus : prime d'or et distinction pour ceux qui ont combattu avant la chute de leur faction.
  function honorDefeated(faction) {
    for (const { user_id: uid } of q.participants.all(currentCampaign().id, faction)) {
      award(uid, 'veteran');
      const gold = C.defeat.consolationGold || 0;
      if (gold) { grant(uid, gold, 0); notify(uid, 'defeat_honors', { faction, gold }); }
    }
  }
  const distinctionsOf = (userId) => q.distinctions.all(userId).map((r) => ({ id: r.distinction, count: r.n }));

  // Un territoire « allié » pour se déplacer, se replier ou apparaître : territoire de la faction,
  // ou sa base (Garreg-Mach pour les Loups de cendre, qui s'en servent sans le contrôler).
  const isHome = (faction, id, owners) => owners.get(id) === faction || C.homeBases[faction] === id;
  const canEnter = (faction, id, owners) => isHome(faction, id, owners) || neighbors(id).some((n) => isHome(faction, n, owners));

  // Où un joueur (ré)apparaît : la capitale si sa faction la tient, sinon sa base, sinon un de ses territoires au hasard.
  function spawnTerritory(faction, owners) {
    if (isOut(faction)) return null;
    const cap = C.capitals[faction];
    if (cap && owners.get(cap) === faction) return cap;
    if (C.homeBases[faction]) return C.homeBases[faction];
    const owned = TERR.filter((t) => owners.get(t.id) === faction);
    return owned.length ? owned[Math.floor(Math.random() * owned.length)].id : null;
  }

  // ------------------------------------------------------------ Effets de classe
  // Chaque classe apporte des effets (config « effects »), que le joueur garde en changeant de classe : voir effects.js.
  const fx = ctx.fx;
  const statOf = ctx.statOf || (() => 0);
  const AURA_CAP = C.classEffects.auraCap ?? 25;
  const effectsOfRow = (row) => fx.effectsOfPath(fx.pathOf(row));
  const effectsOfUser = (userId) => { const ch = q.char.get(userId); return ch ? effectsOfRow(ch) : []; };
  const productOf = (effects, kind, field) => effects.filter((e) => e.kind === kind).reduce((a, e) => a * (Number(e[field]) || 1), 1);
  // Réserve d'actions et vitesse de recharge d'un joueur (Chevalier wyverne et Lord wyverne en ont plus).
  const limitsOf = (userId) => fx.actionLimits(effectsOfUser(userId), C.maxActions, TURN_MS, C.turnMinutes);
  // Tirage des déplacements gratuits (TEST_MOVE_ROLL le fixe pour les tests).
  const moveRoll = () => (process.env.TEST_MOVE_ROLL !== undefined ? Number(process.env.TEST_MOVE_ROLL) : Math.random());
  const freeMoveChance = (userId) => { const ch = q.char.get(userId); return ch ? fx.freeMoveChance(fx.pathOf(ch), effectsOfRow(ch)) : 0; };
  // Multiplicateurs d'or et d'expérience appliqués à toutes les sources de gains (voir `grant` dans server.js).
  function rewardMods(userId) {
    const effects = effectsOfUser(userId);
    let gold = 1 + fx.sumOf(effects, 'goldBonus') / 100;
    let xp = 1 + fx.sumOf(effects, 'xpBonus') / 100;
    // Après une téléportation, les récompenses des actions suivantes sont réduites.
    if ((q.state.get(userId)?.reward_debuff || 0) > 0) {
      const f = effects.find((e) => e.kind === 'teleport')?.rewardFactor ?? 0.5;
      gold *= f;
      xp *= f;
    }
    return { gold, xp };
  }
  const fortifyCost = (userId) => Math.round(C.hire.gold * productOf(effectsOfUser(userId), 'fortifyCost', 'factor'));
  const fortifyPower = (userId) => C.hire.power * productOf(effectsOfUser(userId), 'fortifyPower', 'factor');

  // Crée l'état du joueur s'il n'existe pas encore (nouveau personnage ou nouvelle campagne).
  function ensurePlayer(userId) {
    const ps = q.state.get(userId);
    if (ps) return ps;
    const ch = q.char.get(userId);
    if (!ch) return null;
    const spot = spawnTerritory(ch.faction, ownersMap());
    // Une faction hors jeu ne peut plus accueillir de joueur avant la prochaine campagne.
    q.insertState.run(userId, spot || '', Math.max(C.startActions, limitsOf(userId).max), Date.now(), spot ? 'alive' : 'dead');
    return q.state.get(userId);
  }

  // Actions disponibles maintenant : +1 par intervalle de recharge écoulé, plafonné ; le compteur ne tourne pas quand la réserve est pleine.
  function settle(ps, t, lim = limitsOf(ps.user_id)) {
    let { actions, actions_at: at } = ps;
    if (actions < lim.max) {
      const gained = Math.floor((t - at) / lim.ms);
      if (gained > 0) { actions = Math.min(lim.max, actions + gained); at += gained * lim.ms; }
    }
    return actions >= lim.max ? { actions: lim.max, at: t, next: null, max: lim.max } : { actions, at, next: at + lim.ms, max: lim.max };
  }
  // Dépense 1 action. La première action de chaque tour rapporte un petit bonus de régularité.
  function spend(ps, t) {
    const s = settle(ps, t);
    if (s.actions < 1) throw new HttpError(409, 'no_actions');
    q.setActions.run(s.actions - 1, s.actions >= s.max ? t : s.at, ps.user_id);
    const turn = Math.floor(t / TURN_MS);
    if (C.cadenceGold > 0 && ps.bonus_turn !== turn) {
      q.setBonusTurn.run(turn, ps.user_id);
      grant(ps.user_id, C.cadenceGold, 0);
      return C.cadenceGold;
    }
    return 0;
  }

  // Force d'une action de combat : dépend du rang de la classe et de la renommée du joueur.
  function power(ch) {
    const tier = config.classes.find((c) => c.id === ch.class)?.tier;
    return (C.tierPower[tier] ?? 1) * (1 + renown(ch.xp).level * C.renownPower) * powerBonus(ch.faction);
  }
  // Force du petit nombre : une faction moins nombreuse que la moyenne des autres frappe plus fort, dans la même proportion (plafonnée).
  function powerBonus(faction) {
    const max = perks(faction).outnumberedMax;
    if (!max) return 1;
    const counts = new Map(q.aliveByFaction.all().map((r) => [r.faction, r.n]));
    const mine = counts.get(faction) || 1;
    const others = [...counts].filter(([f]) => f !== faction && PLAYABLE.has(f)).map(([, n]) => n);
    if (!others.length) return 1;
    const avg = others.reduce((a, b) => a + b, 0) / others.length;
    return Math.min(max, Math.max(1, avg / mine));
  }
  // Expérience qu'il a fallu pour atteindre le niveau de renommée n.
  function xpForLevel(n) {
    let need = P.renownBaseXp;
    for (let i = 1; i < n; i += 1) need = Math.round(need * P.renownGrowth);
    return need;
  }

  // ------------------------------------------------------------ Batailles
  // Une personne présente ou engagée dans une bataille, avec sa lignée de classes et ses effets cumulés.
  function person(row) {
    const path = fx.pathOf(row);
    return { id: row.user_id, faction: row.faction, territory: row.territory || null, classId: row.class, path, effects: fx.effectsOfPath(path), level: renown(row.xp).level };
  }
  // Un joueur correspond-il à un filtre d'effet ? { flying: true } : classe volante ; { lineage: [...] } : une de ces classes dans son arbre.
  const matchesFilter = (f, p) => !f || ((!f.flying || fx.isFlying(p.classId)) && (!f.lineage || p.path.some((c) => f.lineage.includes(c))));

  // Force des deux camps dans une bataille, effets de classe compris.
  // Elle dépend de qui est présent sur le territoire et autour à cet instant : on la calcule donc à la demande, pas à l'action.
  // Chances de réussite de l'attaque : force des attaquants / (attaquants + défense). La défense part d'une base proportionnelle
  // à l'importance du territoire, plus un bonus pour les factions non jouables.
  function battleDetail(b) {
    const rows = q.battleRows.all(b.id);
    const T = b.territory;
    const around = new Set([T, ...neighbors(T)]);
    const people = new Map();
    for (const r of q.alivePlayers.all()) people.set(r.user_id, person(r));
    // Un joueur engagé qui a quitté les lieux garde ses effets propres, mais ne compte plus parmi les présents.
    for (const r of rows) {
      if (people.has(r.user_id)) continue;
      const ch = q.char.get(r.user_id);
      if (ch) people.set(r.user_id, person({ ...ch, territory: null, faction: r.faction }));
    }
    const camp = { attack: b.attacker, defense: b.defender };
    const presentOf = (f, wide) => (f ? [...people.values()].filter((p) => p.faction === f && p.territory && (wide ? around.has(p.territory) : p.territory === T)) : []);
    const here = { attack: presentOf(camp.attack, false), defense: presentOf(camp.defense, false) };
    const near = { attack: presentOf(camp.attack, true), defense: presentOf(camp.defense, true) };
    const boss = C.boss.faction;
    const enemyLevels = (side) => {
      const other = side === 'attack' ? 'defense' : 'attack';
      return [...here[other].map((p) => p.level), ...rows.filter((r) => r.side === other && people.get(r.user_id)).map((r) => people.get(r.user_id).level)];
    };

    const sums = { attack: 0, defense: 0 };
    const who = { attack: new Set(), defense: new Set() };
    const perUser = new Map();
    for (const r of rows) {
      who[r.side].add(r.user_id);
      let power = r.power;
      const me = r.kind === 'action' ? people.get(r.user_id) : null; // les renforts payés n'ont pas d'effets de classe
      if (me) {
        const side = r.side;
        const other = side === 'attack' ? 'defense' : 'attack';
        const allies = here[side];
        const enemies = here[other];
        let add = 0;
        for (const e of me.effects) {
          if (e.kind === 'power' && (e.side === 'both' || e.side === side)) add += e.pct;
          else if (e.kind === 'streak') add += Math.min(e.max ?? 100, e.pct * (r.streak || 0));
          else if (e.kind === 'outnumbered' && enemies.length > allies.length) add += e.pct;
          else if (e.kind === 'perAlly' && (!e.side || e.side === side)) add += Math.min(e.max ?? 100, e.pct * near[side].filter((p) => p.id !== me.id).length);
          else if (e.kind === 'perEnemy') add += Math.min(e.max ?? 100, e.pct * enemies.filter((p) => matchesFilter(e.filter, p)).length);
          else if (e.kind === 'warMaster') {
            const levels = enemyLevels(side);
            if (enemies.length && levels.length && me.level >= Math.max(...levels)) add += e.pct;
          } else if (e.kind === 'holyKnight' && b.defender !== boss) {
            add += Math.min(e.repelledMax ?? 100, (e.repelledPct || 0) * statOf(me.id, `${boss}_repelled`));
          }
        }
        // Auras des alliés présents : chaque porteur compte une fois par effet, dans la limite de auraCap.
        let aura = 0;
        for (const s of near[side]) {
          for (const a of s.effects) {
            if (a.kind !== 'aura') continue;
            if (a.range === 'territory' && s.territory !== T) continue;
            if (a.targets && !me.path.some((c) => a.targets.includes(c))) continue;
            if (a.except && me.path.includes(a.except)) continue;
            aura += a.pct;
          }
        }
        add += Math.min(AURA_CAP, aura);
        let mult = 1 + add / 100;
        // Malus des ennemis présents : un même effet ne compte qu'une fois, quel que soit le nombre de porteurs.
        const seen = new Set();
        let cut = 0;
        for (const s of enemies) {
          for (const d of s.effects) {
            if (d.kind !== 'debuff' || seen.has(d.id) || (d.target !== 'both' && d.target !== side) || !matchesFilter(d.filter, me)) continue;
            seen.add(d.id);
            cut += d.pct;
          }
        }
        mult = Math.max(0.1, mult - cut / 100);
        // Mage noir : doublé sans autre allié « Moine » sur place, triplé si aucun ennemi n'en a non plus.
        if (me.effects.some((e) => e.kind === 'darkMage') && !allies.some((p) => p.id !== me.id && p.path.includes('monk'))) {
          mult *= enemies.length && enemies.every((p) => !p.path.includes('monk')) ? 3 : 2;
        }
        // Chevalier sacré : sa puissance est multipliée sur un territoire conquis par les Serpents.
        const hk = me.effects.find((e) => e.kind === 'holyKnight');
        if (hk && b.defender === boss) mult *= hk.conqueredFactor || 1;
        power *= mult;
      }
      sums[r.side] += power;
      perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + power);
    }
    // Chevalier sacré en défense : la puissance d'attaque des Serpents est divisée.
    let bossPower = b.boss_power;
    const holy = here.defense.flatMap((p) => p.effects).find((e) => e.kind === 'holyKnight');
    if (holy && bossPower > 0) bossPower /= holy.bossDivisor || 1;
    const attack = bossPower + sums.attack;
    const defense = C.baseDefense * importance(T) + (C.npcDefense[b.defender] || 0) + sums.defense;
    const chance = Math.min(C.maxChance, Math.max(C.minChance, attack / (attack + defense)));
    return { chance, attack, defense, attackers: who.attack.size, defenders: who.defense.size, perUser };
  }
  const battleInfo = (b) => battleDetail(b);

  function startBattle(territory, attacker, defender, t, bossPower = 0) {
    const info = q.insertBattle.run(currentCampaign().id, territory, attacker, defender, bossPower, t, t + C.battleTurns * TURN_MS);
    const id = Number(info.lastInsertRowid);
    // Les garnisons posées avant l'attaque comptent dans la bataille.
    if (defender) q.attachGarrison.run(id, territory, defender, t);
    if (defender) for (const p of q.factionPlayers.all(defender)) notify(p.user_id, 'territory_attacked', { territory, faction: attacker });
    journal('battle_started', { territory, attacker, defender }, t);
    return q.openBattle.get(territory);
  }

  // Voleur : à chaque conquête, chaque voleur prend de l'or à chaque défenseur du territoire
  // (ceux qui ont défendu et ceux qui s'y trouvaient). L'or volé n'est pas augmenté par les bonus d'or.
  function stealGold(b, attackers) {
    if (!b.defender) return;
    const thieves = attackers.map((uid) => ({ uid, gold: fx.sumOf(effectsOfUser(uid), 'steal', 'gold') })).filter((x) => x.gold > 0);
    if (!thieves.length) return;
    const victims = new Set(q.sideUsers.all(b.id, 'defense').map((r) => r.user_id));
    for (const p of q.factionPlayers.all(b.defender)) if (p.territory === b.territory) victims.add(p.user_id);
    for (const th of thieves) {
      let loot = 0;
      for (const v of victims) {
        const take = Math.min(th.gold, q.gold.get(v)?.gold || 0);
        if (take <= 0) continue;
        q.takeGold.run(take, v);
        loot += take;
        notify(v, 'robbed', { gold: take });
      }
      if (loot) { q.addGoldRaw.run(loot, th.uid); notify(th.uid, 'loot', { gold: loot }); }
    }
  }

  function resolveBattle(b, t) {
    const { chance } = battleDetail(b);
    const success = roll() < chance;
    q.closeBattle.run(t, success ? 1 : 0, chance, b.id);
    const scale = importance(b.territory);
    const vsBoss = b.attacker === C.boss.faction || b.defender === C.boss.faction; // bataille contre les Serpents
    // Gains d'un joueur : base de la bataille, puis effets de classe (Brigand, Guerrier, Chevalier sacré) et malus d'exil.
    const payout = (uid, base, conquest) => {
      const eff = effectsOfUser(uid);
      let gold = base.gold;
      let xp = base.xp + fx.sumOf(eff, 'renownPerWin', 'xp');
      if (conquest) gold *= 1 + fx.sumOf(eff, 'conquestGold') / 100;
      const hk = eff.find((e) => e.kind === 'holyKnight');
      if (hk && vsBoss) { gold += hk.gold || 0; xp += hk.xp || 0; }
      const m = exileMult(uid);
      return { gold: Math.round(gold * m), xp: Math.round(xp * m) };
    };
    if (success) {
      q.setOwner.run(b.attacker, iso(), b.territory);
      q.dropGarrison.run(b.territory, t);
      journal('territory_taken', { territory: b.territory, faction: b.attacker, from: b.defender }, t);
      const gain = scale * (perks(b.attacker).rewardMultiplier || 1);
      const reward = { gold: C.attackRewards.gold * gain, xp: C.attackRewards.xp * gain };
      const attackers = q.sideUsers.all(b.id, 'attack').map((r) => r.user_id);
      for (const uid of attackers) {
        const paid = payout(uid, reward, true);
        grant(uid, paid.gold, paid.xp);
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_conquered', { territory: b.territory, ...paid });
      }
      stealGold(b, attackers);
      // Dernier territoire d'une faction : ceux qui l'ont défendu reçoivent la distinction « Dernier rempart ».
      if (b.defender && PLAYABLE.has(b.defender) && !perks(b.defender).neverOut) {
        const left = ownersMap();
        if (!TERR.some((x) => left.get(x.id) === b.defender)) {
          for (const { user_id: uid } of q.sideUsers.all(b.id, 'defense')) award(uid, 'last_stand');
        }
      }
      if (b.defender) {
        // Effets des vainqueurs sur le repli des vaincus : l'Archer raccourcit leur délai, l'Archer d'élite les taxe s'ils échouent.
        const winners = attackers.flatMap((uid) => effectsOfUser(uid));
        const enemyAdj = Math.min(0, ...winners.filter((e) => e.kind === 'retreat').map((e) => e.enemy || 0));
        const penalty = Math.max(0, ...winners.filter((e) => e.kind === 'sniper').map((e) => e.gold || 0));
        for (const p of q.factionPlayers.all(b.defender)) {
          notify(p.user_id, 'territory_lost', { territory: b.territory, faction: b.attacker });
          // Les défenseurs présents sur place doivent se replier, sinon ils tombent.
          if (p.territory !== b.territory) continue;
          const refuge = perks(b.defender).autoRetreat && C.homeBases[b.defender];
          if (refuge) {
            // Une faction dotée d'un refuge s'y replie d'elle-même.
            q.setTerritory.run(refuge, p.user_id);
            notify(p.user_id, 'auto_retreat', { territory: b.territory, home: refuge });
          } else {
            const own = fx.sumOf(effectsOfUser(p.user_id), 'retreat', 'own');
            const turns = Math.max(1, C.retreatTurns + own + enemyAdj);
            q.setRetreating.run(t + turns * TURN_MS, penalty, p.user_id);
            notify(p.user_id, 'must_retreat', { territory: b.territory });
          }
        }
      }
    } else {
      journal('attack_repelled', { territory: b.territory, attacker: b.attacker, faction: b.defender }, t);
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'attack')) notify(uid, 'attack_failed', { territory: b.territory });
      const reward = { gold: C.defenseRewards.gold * scale, xp: C.defenseRewards.xp * scale };
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'defense')) {
        const paid = payout(uid, reward, false);
        grant(uid, paid.gold, paid.xp);
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_defended', { territory: b.territory, ...paid });
        // Attaque d'une faction non jouable (Serpents des Ténèbres) repoussée : compté pour le joueur, sans limite de campagne.
        if (!PLAYABLE.has(b.attacker) && ctx.countStat) ctx.countStat(uid, `${b.attacker}_repelled`);
      }
    }
  }

  // Heures calmes : aucun mini-boss n'apparaît entre `from` (inclus) et `to` (exclu), à l'heure du fuseau `timezone`.
  // Les batailles déjà commencées continuent. TEST_HOUR force l'heure pour les tests.
  function quietHour(ms) {
    const qh = C.boss.quietHours;
    if (!qh) return false;
    let hour = Number(process.env.TEST_HOUR);
    if (process.env.TEST_HOUR === undefined || Number.isNaN(hour)) {
      hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: qh.timezone || 'UTC' }).format(ms));
    }
    return qh.from <= qh.to ? hour >= qh.from && hour < qh.to : hour >= qh.from || hour < qh.to;
  }

  // Mini-boss : à chaque nouveau tour, la faction ennemie a une chance d'attaquer un territoire au hasard (pas la nuit).
  function spawnBosses(t) {
    const turn = Math.floor(t / TURN_MS);
    const last = Number(q.meta.get('boss_turn')?.value ?? turn);
    q.setMeta.run('boss_turn', String(turn));
    for (let i = Math.max(last + 1, turn - 5); i <= turn; i += 1) {
      if (quietHour(i * TURN_MS)) continue; // on regarde l'heure du tour manqué, pas celle de maintenant
      if (Math.random() >= BOSS_CHANCE) continue;
      const open = q.openBattles.all();
      if (open.filter((b) => b.boss_power > 0).length >= C.boss.max) return;
      const owners = ownersMap();
      const busy = new Set(open.map((b) => b.territory));
      const targets = TERR.filter((x) => !ANNEX.has(x.id) && !busy.has(x.id) && PLAYABLE.has(owners.get(x.id)));
      if (!targets.length) return;
      const target = targets[Math.floor(Math.random() * targets.length)];
      startBattle(target.id, C.boss.faction, owners.get(target.id), t, C.boss.power * importance(target.id));
    }
  }

  // ------------------------------------------------------------ Fin de campagne
  function checkEnd(t) {
    const owners = ownersMap();
    const main = TERR.filter((x) => !ANNEX.has(x.id));
    const first = owners.get(main[0].id);
    if (PLAYABLE.has(first) && main.every((x) => owners.get(x.id) === first)) return endCampaign(first, 'conquest', owners, t);
    // Parmi les factions qui ont des joueurs, une seule n'est pas hors jeu.
    const withPlayers = q.aliveByFaction.all().map((r) => r.faction).filter((f) => PLAYABLE.has(f));
    const inPlay = withPlayers.filter((f) => !isOut(f));
    if (withPlayers.length >= 2 && inPlay.length <= 1) return endCampaign(inPlay[0] || null, 'elimination', owners, t);
    return null;
  }

  function endCampaign(winner, reason, owners, t) {
    const alive = new Map(q.aliveByFaction.all().map((r) => [r.faction, r.alive]));
    const gained = {};
    for (const f of PLAYABLE) {
      const held = TERR.filter((x) => !ANNEX.has(x.id) && owners.get(x.id) === f).length * (perks(f).pointsMultiplier || 1);
      const survivors = alive.get(f) || 0;
      gained[f] = f === winner
        ? C.points.win + held * C.points.territory + survivors * C.points.survivor
        : held * C.points.loserTerritory + survivors * C.points.loserSurvivor;
      if (gained[f]) q.addPoints.run(f, gained[f]);
    }
    const campaign = currentCampaign();
    // Les meilleurs joueurs de la campagne sont récompensés.
    q.ranking.all(campaign.id, C.ranking.rewards.length).forEach((r, i) => {
      grant(r.user_id, C.ranking.rewards[i], 0);
      notify(r.user_id, 'campaign_rank', { rank: i + 1, gold: C.ranking.rewards[i] });
    });
    q.endCampaign.run(iso(), winner, JSON.stringify({ reason, points: gained }), campaign.id);
    for (const c of q.chars.all()) {
      notify(c.user_id, winner ? 'campaign_end' : 'campaign_end_draw', { faction: winner, points: gained[c.faction] || 0 });
    }
    // Remise à zéro : carte de départ, plus aucune bataille, tous les joueurs reviennent dans leur capitale.
    for (const x of TERR) q.setOwner.run(startFaction(x), iso(), x.id);
    q.closeAllBattles.run(t);
    q.clearContributions.run();
    q.clearStates.run();
    q.clearFactionMeta.run();
    q.newCampaign.run(iso());
    journal('campaign_ended', { faction: winner }, t);
    updateFactions(ownersMap(), t);
    for (const c of q.chars.all()) ensurePlayer(c.user_id);
    return { winner, reason };
  }

  // Met le monde à jour : batailles arrivées à terme, replis expirés, factions hors jeu, mini-boss, fin de campagne.
  let ticking = false;
  let lastFreeze = 0;
  function tick(t = Date.now()) {
    if (ticking) return;
    ticking = true;
    try {
      currentCampaign();
      for (const b of q.dueBattles.all(t)) resolveBattle(b, t);
      for (const { user_id: uid, retreat_penalty: fine } of q.retreatDue.all(t)) {
        q.setDead.run(uid);
        notify(uid, 'fallen', {});
        // Un Archer d'élite a vaincu ce joueur : il perd de l'or s'il ne s'est pas replié à temps.
        const taken = Math.min(fine || 0, q.gold.get(uid)?.gold || 0);
        if (taken > 0) { q.takeGold.run(taken, uid); notify(uid, 'sniped', { gold: taken }); }
      }
      q.dropGarrison.run('', t);
      updateFactions(ownersMap(), t);
      // Les joueurs tombés dont la faction est hors jeu gardent leur série de missions du jour.
      if (ctx.freezeStreaks && t - lastFreeze > 60_000) {
        lastFreeze = t;
        const ids = q.deadPlayers.all().filter((r) => isOut(r.faction)).map((r) => r.user_id);
        if (ids.length) ctx.freezeStreaks(ids);
      }
      spawnBosses(t);
      checkEnd(t);
    } finally { ticking = false; }
  }

  // ------------------------------------------------------------ Ce que voit le joueur
  function playerPayload(userId, t = Date.now()) {
    const ps = ensurePlayer(userId);
    if (!ps) return null;
    const s = settle(ps, t);
    const ch = q.char.get(userId);
    const side = ps.exile_faction || ch.faction; // camp pour lequel il combat
    return {
      now: t, // heure du serveur, pour que l'app affiche des comptes à rebours justes
      territory: ps.territory || null, status: ps.status, retreatUntil: ps.retreat_until,
      actions: s.actions, maxActions: s.max, nextActionAt: s.next,
      rewardDebuff: ps.reward_debuff || 0, // actions restantes pendant lesquelles les récompenses sont réduites (téléportation)
      faction: side, exile: !!ps.exile_faction,
      factionOut: isOut(side), reviveAsked: !!ps.revive_asked,
    };
  }

  function rankingPayload(userId) {
    const cid = currentCampaign().id;
    const mine = q.myScore.get(cid, userId)?.score || 0;
    return {
      top: q.ranking.all(cid, 10).map((r, i) => ({ rank: i + 1, pseudo: r.pseudo, faction: r.faction, avatar: r.avatar, score: r.score, me: r.user_id === userId })),
      me: { score: mine, rank: mine > 0 ? q.betterScores.get(cid, mine).n + 1 : null },
      rewards: C.ranking.rewards,
    };
  }

  function mapPayload(userId, t = Date.now()) {
    const owners = ownersMap();
    const battles = new Map(q.openBattles.all().map((b) => [b.territory, b]));
    const presence = new Map();
    for (const r of q.presence.all()) {
      if (!presence.has(r.territory)) presence.set(r.territory, {});
      presence.get(r.territory)[r.faction] = r.n;
    }
    const campaign = currentCampaign();
    const ch = q.char.get(userId);
    const here = q.state.get(userId)?.territory;
    const side = effFaction(userId);
    return {
      now: t,
      turnMs: TURN_MS,
      campaign: { id: campaign.id, startedAt: campaign.started_at },
      player: playerPayload(userId, t),
      homeBases: C.homeBases,
      // hire : bataillon en attaque ; fortify : fortification en défense (moitié prix pour un Prêtre) ; teleport : Évêque noir.
      costs: {
        hire: C.hire.gold, fortify: ch ? fortifyCost(userId) : C.hire.gold, hireMax: C.hire.perBattle,
        revive: side ? reviveCost(side) : C.revive.gold,
        teleport: ch ? (effectsOfUser(userId).find((e) => e.kind === 'teleport')?.gold ?? null) : null,
      },
      // Avantages de ma faction, s'il y en a (affichés dans le menu).
      perks: side && C.underdogs[side] ? { ...C.underdogs[side], powerBonus: Math.round(powerBonus(side) * 10) / 10 } : null,
      points: Object.fromEntries(q.points.all().map((r) => [r.faction, r.points])),
      ranking: rankingPayload(userId),
      // Exil possible pour un joueur dont la faction est hors jeu (factions qui peuvent l'accueillir).
      exile: exileInfo(userId),
      // Alliés tombés qui demandent qu'on paie leur retour.
      fallen: side ? q.fallen.all(side, userId).map((r) => ({ id: r.user_id, pseudo: r.pseudo })) : [],
      territories: TERR.map((x) => {
        const b = battles.get(x.id);
        const info = b ? battleInfo(b) : null;
        return {
          id: x.id, name: x.name, neighbors: neighbors(x.id), faction: owners.get(x.id) || null,
          importance: importance(x.id), annex: ANNEX.has(x.id), players: presence.get(x.id) || {},
          battle: b ? {
            attacker: b.attacker, defender: b.defender, boss: b.boss_power > 0, endsAt: b.ends_at,
            chance: Math.round(info.chance * 100), attackers: info.attackers, defenders: info.defenders,
            power: { attack: Math.round(info.attack * 100) / 100, defense: Math.round(info.defense * 100) / 100 },
            mine: q.myContribution.get(b.id, userId)?.side || null,
            rallied: !!q.rallied.get(b.id, userId),
            hired: q.hiredInBattle.get(userId, b.id).n,
          } : null,
          // Fortifications que j'ai déjà payées ici hors bataille (seulement pour le territoire où je me trouve).
          garrisonHired: !b && x.id === here ? q.hiredGarrison.get(userId, x.id, t).n : 0,
        };
      }),
    };
  }

  // ------------------------------------------------------------ Actions du joueur
  function actor(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthorized');
    const t = Date.now();
    tick(t);
    const ps = ensurePlayer(user.id);
    if (!ps) throw new HttpError(409, 'no_character');
    const own = q.char.get(user.id);
    // Pour toutes les actions, le joueur est dans son camp d'exil s'il en a un ; `home` reste sa faction d'origine.
    return { user, ps, ch: { ...own, home: own.faction, faction: ps.exile_faction || own.faction }, t, owners: ownersMap() };
  }
  const mustBeAlive = (ps) => {
    if (ps.status === 'dead') throw new HttpError(409, 'player_dead');
    if (ps.status === 'retreating') throw new HttpError(409, 'must_retreat');
  };
  const reply = (res, user, extra = {}) => {
    tick();
    send(res, 200, { ...ctx.mePayload(user), map: mapPayload(user.id), ...extra });
  };
  const reviveCost = (faction) => (perks(faction).freeRevive ? 0 : C.revive.gold);
  // Remet en jeu un joueur tombé, à l'endroit où sa faction réapparaît.
  function revive(userId, faction) {
    const spot = spawnTerritory(faction, ownersMap());
    if (!spot) throw new HttpError(409, 'faction_out');
    q.setTerritory.run(spot, userId);
    return spot;
  }

  const routes = {
    // Se déplacer vers un territoire voisin (1 action, sauf déplacement gratuit : Chevalier pégase et Chevalier faucon).
    'POST /api/move': async (req, res) => {
      const { to } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (!NEIGHBORS.get(ps.territory)?.has(to)) throw new HttpError(409, 'not_neighbor');
      if (!canEnter(ch.faction, to, owners)) throw new HttpError(409, 'cannot_enter');
      // Il faut au moins une action pour tenter un déplacement ; il peut alors ne rien coûter.
      if (settle(ps, t).actions < 1) throw new HttpError(409, 'no_actions');
      const free = moveRoll() * 100 < freeMoveChance(user.id);
      const bonus = free ? 0 : spend(ps, t);
      q.setTerritory.run(to, user.id);
      q.tickDebuff.run(user.id);
      onEvent(user.id, 'move');
      reply(res, user, { bonus, free });
    },

    // Agir sur le territoire où l'on se trouve.
    // attack, defend, gather : 1 action. hire : renfort payé en or (bataillon en attaque, fortification en défense), sans action.
    'POST /api/act': async (req, res) => {
      const { action } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      const here = ps.territory;
      const owner = owners.get(here) || null;
      const battle = q.openBattle.get(here);
      // Série d'actions de combat sur un même territoire (Combattant) : nombre d'actions précédentes d'affilée.
      const streak = ps.streak_territory === here ? ps.streak_count : 0;
      let bonus = 0;
      if (action === 'attack') {
        if (owner === ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle && battle.attacker !== ch.faction) throw new HttpError(409, 'battle_busy');
        bonus = spend(ps, t);
        const b = battle || startBattle(here, ch.faction, owner, t);
        q.setStreak.run(here, streak + 1, user.id);
        q.addContribution.run(b.id, here, user.id, ch.faction, 'attack', power(ch), t, null, 'action', streak);
        score(user.id, C.ranking.combat);
        onEvent(user.id, 'combat');
        if (ps.exile_faction) onEvent(user.id, 'exile_combat');
        q.tickDebuff.run(user.id);
      } else if (action === 'defend') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        bonus = spend(ps, t);
        // Pendant une bataille, l'action renforce la défense ; sinon elle pose une garnison qui tient le temps d'une bataille.
        q.setStreak.run(here, streak + 1, user.id);
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, 'defense', power(ch), t,
          battle ? null : t + C.battleTurns * TURN_MS, 'action', streak);
        score(user.id, C.ranking.combat);
        onEvent(user.id, 'combat');
        if (ps.exile_faction) onEvent(user.id, 'exile_combat');
        q.tickDebuff.run(user.id);
      } else if (action === 'gather') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle) throw new HttpError(409, 'battle_here');
        bonus = spend(ps, t);
        const m = exileMult(user.id);
        grant(user.id, Math.round(C.gather.gold * m), Math.round(C.gather.xp * m));
        score(user.id, C.ranking.gather);
        onEvent(user.id, 'gather');
        q.tickDebuff.run(user.id);
      } else if (action === 'hire') {
        // Sur son territoire : fortification (moitié prix pour le Prêtre, plus efficace pour l'Évêque).
        // Ailleurs : bataillon, seulement dans une bataille lancée par sa faction.
        const side = owner === ch.faction ? 'defense' : 'attack';
        if (side === 'attack' && (!battle || battle.attacker !== ch.faction)) throw new HttpError(409, 'invalid_action');
        const already = battle ? q.hiredInBattle.get(user.id, battle.id).n : q.hiredGarrison.get(user.id, here, t).n;
        if (already >= C.hire.perBattle) throw new HttpError(409, 'hire_limit');
        const cost = side === 'defense' ? fortifyCost(user.id) : C.hire.gold;
        const strength = side === 'defense' ? fortifyPower(user.id) : C.hire.power;
        if (q.payGold.run(cost, user.id, cost).changes !== 1) throw new HttpError(409, 'not_enough_gold');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, side, strength, t,
          battle ? null : t + C.battleTurns * TURN_MS, 'hire', 0);
        score(user.id, C.ranking.combat);
      } else throw new HttpError(400, 'invalid_action');
      reply(res, user, { bonus });
    },

    // Téléportation (Évêque noir) : vers un territoire de sa faction ou voisin d'un territoire de sa faction, contre de l'or,
    // sans dépenser d'action. Les récompenses des actions suivantes sont ensuite réduites ; se téléporter à nouveau renouvelle l'effet.
    'POST /api/teleport': async (req, res) => {
      const { to } = await readJson(req);
      const { user, ps, ch, owners } = actor(req);
      mustBeAlive(ps);
      const tp = effectsOfUser(user.id).find((e) => e.kind === 'teleport');
      if (!tp) throw new HttpError(409, 'invalid_action');
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (to === ps.territory) throw new HttpError(409, 'invalid_action');
      if (!canEnter(ch.faction, to, owners)) throw new HttpError(409, 'cannot_enter');
      if (q.payGold.run(tp.gold, user.id, tp.gold).changes !== 1) throw new HttpError(409, 'not_enough_gold');
      q.setTerritory.run(to, user.id);
      q.setRewardDebuff.run(tp.actions, user.id);
      reply(res, user);
    },

    // Appeler sa faction à l'aide dans une bataille où l'on se trouve (gratuit, une fois par bataille).
    'POST /api/rally': async (req, res) => {
      await readJson(req);
      const { user, ps, ch, t } = actor(req);
      mustBeAlive(ps);
      const battle = q.openBattle.get(ps.territory);
      if (!battle || (battle.attacker !== ch.faction && battle.defender !== ch.faction)) throw new HttpError(409, 'invalid_action');
      if (q.addRally.run(battle.id, user.id).changes !== 1) throw new HttpError(409, 'rally_done');
      for (const p of q.factionPlayers.all(ch.faction)) {
        if (p.user_id !== user.id) notify(p.user_id, 'rally', { pseudo: ch.pseudo, territory: ps.territory });
      }
      journal('rally', { pseudo: ch.pseudo, faction: ch.faction, territory: ps.territory }, t);
      reply(res, user);
    },

    // Après la chute de son territoire : se replier sur un territoire allié (gratuit).
    'POST /api/retreat': async (req, res) => {
      const { to } = await readJson(req);
      const { user, ps, ch, owners } = actor(req);
      if (ps.status !== 'retreating') throw new HttpError(409, 'not_retreating');
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (!isHome(ch.faction, to, owners)) throw new HttpError(409, 'invalid_action');
      q.setTerritory.run(to, user.id);
      reply(res, user);
    },

    // Revenir en jeu après être tombé : en payant de l'or (gold), en sacrifiant un niveau de renommée (renown),
    // ou en demandant à un allié de payer (ask).
    'POST /api/revive': async (req, res) => {
      const { mode } = await readJson(req);
      const { user, ps, ch } = actor(req);
      if (ps.status !== 'dead') throw new HttpError(409, 'not_dead');
      if (isOut(ch.faction)) throw new HttpError(409, 'faction_out');
      if (mode === 'gold') {
        const cost = reviveCost(ch.faction);
        if (q.payGold.run(cost, user.id, cost).changes !== 1) throw new HttpError(409, 'not_enough_gold');
        revive(user.id, ch.faction);
      } else if (mode === 'renown') {
        const level = renown(ch.xp).level;
        if (level < 1) throw new HttpError(409, 'no_renown');
        const cost = xpForLevel(level);
        if (q.loseXp.run(cost, user.id, cost).changes !== 1) throw new HttpError(409, 'no_renown');
        revive(user.id, ch.faction);
      } else if (mode === 'ask') {
        if (!ps.revive_asked) {
          q.askRevive.run(user.id);
          for (const p of q.factionPlayers.all(ch.faction)) notify(p.user_id, 'revive_request', { pseudo: ch.pseudo });
        }
      } else throw new HttpError(400, 'invalid_action');
      reply(res, user);
    },

    // Payer le retour d'un allié tombé qui l'a demandé.
    'POST /api/revive/pay': async (req, res) => {
      const { id } = await readJson(req);
      const { user, ps, ch } = actor(req);
      mustBeAlive(ps);
      const target = q.fallen.all(ch.faction, user.id).find((r) => r.user_id === id);
      if (!target) throw new HttpError(409, 'invalid_action');
      if (isOut(ch.faction)) throw new HttpError(409, 'faction_out');
      const cost = reviveCost(ch.faction);
      if (q.payGold.run(cost, user.id, cost).changes !== 1) throw new HttpError(409, 'not_enough_gold');
      revive(target.user_id, ch.faction);
      notify(target.user_id, 'revived_by', { pseudo: ch.pseudo });
      reply(res, user);
    },

    // Exil : un joueur dont la faction est hors jeu prend les armes sous la bannière d'une autre faction
    // (jusqu'à la fin de la campagne, ou jusqu'à la chute de cette faction).
    'POST /api/exile': async (req, res) => {
      const { faction: to } = await readJson(req);
      const { user, ch, owners, t } = actor(req);
      const info = exileInfo(user.id);
      if (!info || typeof to !== 'string' || !info.options.includes(to)) throw new HttpError(409, 'exile_unavailable');
      const spot = spawnTerritory(to, owners);
      if (!spot) throw new HttpError(409, 'exile_unavailable');
      q.setExile.run(to, user.id);
      q.setTerritory.run(spot, user.id);
      journal('exile_joined', { pseudo: ch.pseudo, faction: to }, t);
      onEvent(user.id, 'exile_join');
      reply(res, user);
    },

    // Journal du monde : les derniers événements de la carte.
    'GET /api/journal': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      onEvent(user.id, 'journal_read');
      const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
      send(res, 200, {
        now: Date.now(),
        events: q.events.all().map((e) => ({ id: e.id, type: e.type, params: parse(e.params), at: e.created_at })),
        fallen: mapPayload(user.id).fallen,
        exile: exileInfo(user.id),
        reviveCost: reviveCost(effFaction(user.id)),
      });
    },
  };

  // Au démarrage : une campagne en cours, et un état pour chaque personnage existant.
  currentCampaign();
  updateFactions(ownersMap(), Date.now());
  for (const c of q.chars.all()) ensurePlayer(c.user_id);
  setInterval(() => q.purgeEvents.run(), 3_600_000).unref();

  return { routes, tick, playerPayload, mapPayload, ensurePlayer, TURN_MS, fallenState, distinctionsOf, rewardMods };
};
