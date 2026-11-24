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
  const metric = ctx.metric || (() => {}); // compteurs quotidiens pour régler l'économie (voir server.js)

  const C = {
    turnMinutes: 10, maxActions: 8, startActions: 8, battleTurns: 6, retreatTurns: 6,
    capitals: {}, homeBases: {}, annex: [],
    gather: { gold: 40, xp: 10 }, attackRewards: { gold: 150, xp: 60 }, defenseRewards: { gold: 60, xp: 25 },
    baseDefense: 2, npcDefense: {}, tierPower: {}, renownPower: 0.05, minChance: 0.05, maxChance: 0.95,
    // Contre-attaque : un territoire qui repousse une attaque devient insaisissable `minutes` minutes, et sa faction gagne
    // `attackBonus` % de puissance d'attaque sur les territoires ennemis voisins pendant ce temps (hors Serpents et Église).
    counter: { minutes: 240, attackBonus: 25, factionBonus: {} },
    // Factions qui défendent comme chez elles les territoires d'une autre (Loups de cendre : Église de Seiros).
    guardians: {},
    boss: { faction: 'serpents', chancePerTurn: 0.07, max: 1, power: 3, quietHours: { from: 0, to: 6, timezone: 'Europe/Paris' } },
    points: { win: 100 },
    // Fin de campagne automatique (jour de la semaine : 0 = dimanche … 6 = samedi) et points de fin de campagne par faction.
    // Clôture le mardi à minuit, soit la nuit du lundi au mardi (plus d'attaque, les combats se terminent), puis pause jusqu'à `reopenHour`,
    // `reopenDayOffset` jour(s) après le jour de clôture.
    schedule: { weekday: 2, hour: 0, minute: 0, reopenHour: 4, reopenDayOffset: 0, timezone: 'Europe/Paris' },
    // Repli manqué : le joueur est renvoyé à sa capitale, paie `revive.gold` (x2 après une attaque), perd son stock d'actions et gagne moins pendant `actions` actions.
    wound: { actions: 10 },
    // Victoire écrasante : au-delà de ce rapport de force (attaque / (attaque + défense)) l'issue est certaine, sans tirage.
    decisive: 0.8,
    finale: {
      territory: 10, mapBonus: [], survivor: 3, activityRatio: 0.05,
      efficiency: { attackWon: 5, defenseWon: 5, lowDeaths: { max: 80, deathsPerPlayer: 3 } }, exile: { gold: 150 },
    },
    cadenceGold: 10,
    hire: { gold: 300, power: 1.5, perBattle: 2 },
    revive: { gold: 100, attackerMultiplier: 2 },
    ranking: { combat: 10, victory: 30, gather: 2, rewards: [1000, 600, 300] },
    underdogs: {},
    // Missions de campagne : { id, title, description, condition: { event, count }, rewards: { gold, xp } }.
    missions: [], keyTerritory: 'garreg-mach', reactions: { cheerXp: 10, supportGold: 10, helpPct: 1, dailyCap: 10, cheerMinutes: 60 },
    // Capitale perdue : -lossPct % de puissance pour la faction tant qu'elle ne l'a pas reprise.
    // Capitale d'origine : -lossPct % si elle est perdue ; tenue, sa défense gagne perTerritory × nombre de territoires de la faction.
    capital: { lossPct: 10, perTerritory: 0.04 },
    // Avertissement de fin de campagne (notification à tous) quelques heures avant la clôture.
    endWarningHours: 3,
    // Saison : nombre de campagnes (une par semaine) avant le sacre des champions.
    season: { campaigns: 4 },
    // Constructions : une spécialité par territoire (fortress, market, academy), jusqu'à maxLevel niveaux payés en or (costs) ; perdues à la conquête.
    build: { maxLevel: 3, costs: [], specs: {} },
    // Capacités des seigneurs : la jauge d'une faction monte avec ses combats ; pleine, l'effet du seigneur dure `minutes`.
    gauge: { perAction: 1, perWin: 5, max: 100 }, lords: {},
    // Objectifs hebdomadaires de faction, tirés au sort à chaque campagne (voir objectiveStatus).
    objectives: [],
    // Signalements de faction (pings) : durée en minutes, délai entre deux signalements d'un joueur, maximum affiché.
    pings: { kinds: [], minutes: 30, cooldownSeconds: 60, max: 15 },
    exile: { trailingOnly: true, rewardMultiplier: 0.75, alwaysOpen: [], npcHosts: [] },
    defeat: { consolationGold: 200 },
    classEffects: { auraCap: 25 },
    ...(config.campaign || {}),
  };
  const P = { renownBaseXp: 100, renownGrowth: 1.1, ...(config.player || {}) };
  // Généraux : personnages non joueurs (IA). `roster` liste chacun avec sa faction, son territoire d'origine, sa lignée de classes,
  // son coefficient de puissance et les factions qui peuvent l'épargner.
  const G = {
    actions: 4, level: { min: 1, base: 0.5, perCoef: 0.25 }, reward: { gold: 120, xp: 50 }, attackChance: 0.03, maxSorties: 2, verdictTurns: 6,
    serpents: { chance: 0.3, finalBoss: null, pointsBonus: 0.15 }, roster: [], ...(config.generals || {}),
  };
  const GEN = new Map(G.roster.map((g) => [g.id, g]));
  // Seigneurs : ils ne quittent pas leur capitale tant qu'ils la tiennent, la défendent toujours, et ne meurent pas tant qu'il reste
  // un autre général sous leur bannière (Yuri retourne alors à Garreg-Mach, les autres rejoignent un allié et ordonnent la reprise).
  const LORDS = G.lords || {};
  const isLord = (gid) => Object.values(LORDS).includes(gid);
  // Église de Seiros : ses chevaliers gardent Garreg-Mach autour de Rhea (son seigneur), partent en croisade contre une faction
  // qui domine la carte, et si Garreg-Mach tombe, Rhea s'éveille en l'Immaculée et lance ses assauts pour le reprendre.
  const CH = {
    faction: 'eglise', seat: 'garreg-mach', lord: 'rhea', immaculate: 'immaculate',
    crusade: { start: 0.45, end: 0.38, sorties: 3, garrison: 2 },
    awakening: { waves: 3, waveGapHours: 4, power: 3, raidChance: 0.15, maxRaids: 1, pointsBonus: 0.1 },
    ...(G.church || {}),
  };
  // Overdrive : les dernières heures de la campagne (avant la clôture), les joueurs encore en jeu (pas les exilés) frappent plus fort ;
  // ceux des factions minoritaires reçoivent Overdrive+.
  const OD = {
    hours: 24,
    base: { attackPct: 10, maxActions: 2, garregPct: 20, factionPointsPct: 50 },
    plus: { attackPct: 15, maxActions: 3, garregPct: 25, factionPointsPct: 50, gold: 20, xp: 2 },
    ...(C.overdrive || {}),
  };
  const OD_FLAT_SOURCES = new Set(['gather', 'conquest', 'defense', 'general']);
  if (process.env.OVERDRIVE_HOURS !== undefined) OD.hours = Number(process.env.OVERDRIVE_HOURS); // tests
  const odCfg = (level) => (level ? OD[level] : null);
  // Siège d'un seigneur : la capitale de sa faction, ou Garreg-Mach pour l'Église.
  const seatOf = (f) => C.capitals[f] || (f === CH.faction ? CH.seat : null);
  const raidRoll = () => (process.env.TEST_RAID_ROLL !== undefined ? Number(process.env.TEST_RAID_ROLL) : Math.random());
  // Pour les tests : TURN_SECONDS raccourcit les tours, TEST_ROLL fixe le tirage des batailles (0 = réussite),
  // BOSS_CHANCE remplace la probabilité d'apparition d'un mini-boss.
  const TURN_MS = (Number(process.env.TURN_SECONDS) || C.turnMinutes * 60) * 1000;
  const roll = () => (process.env.TEST_ROLL !== undefined ? Number(process.env.TEST_ROLL) : Math.random());
  const BOSS_CHANCE = process.env.BOSS_CHANCE !== undefined ? Number(process.env.BOSS_CHANCE) : C.boss.chancePerTurn;
  if (process.env.CADENCE_GOLD !== undefined) C.cadenceGold = Number(process.env.CADENCE_GOLD);
  if (process.env.DECISIVE !== undefined) C.decisive = Number(process.env.DECISIVE); // tests
  if (process.env.RETREAT_TURNS !== undefined) C.retreatTurns = Number(process.env.RETREAT_TURNS); // tests

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
    -- Déplacements gratuits du Paladin noir : un par bataille.
    CREATE TABLE IF NOT EXISTS battle_free_moves (
      battle_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      PRIMARY KEY (battle_id, user_id)
    );
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
      deaths      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, user_id)
    );
    -- Distinctions gagnées par un joueur (une par campagne et par type).
    -- Généraux de la campagne en cours. status : alive, captive (vaincu, en attente du verdict des vainqueurs) ou dead.
    -- faction vide = indépendant ; les généraux des Serpents attendent hors carte (territory vide) qu'un raid les fasse apparaître.
    -- Relations (niveau de soutien) d'un joueur avec chaque général : permanentes, elles survivent aux campagnes.
    CREATE TABLE IF NOT EXISTS relations (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gid        TEXT NOT NULL,
      points     INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER,
      PRIMARY KEY (user_id, gid)
    );
    -- Délais entre deux offrandes d'un même type (cadeau sur place : une fois par heure).
    CREATE TABLE IF NOT EXISTS gift_cooldowns (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind    TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS generals (
      gid        TEXT PRIMARY KEY,
      faction    TEXT,
      territory  TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'alive',
      actions    INTEGER NOT NULL,
      actions_at INTEGER NOT NULL,
      spared     INTEGER NOT NULL DEFAULT 0,
      move_turn  INTEGER NOT NULL DEFAULT -1
    );
    -- Actions d'un général dans une bataille (une attaque ou une défense par bataille).
    CREATE TABLE IF NOT EXISTS general_contribs (
      battle_id INTEGER NOT NULL,
      gid       TEXT NOT NULL,
      side      TEXT NOT NULL,
      power     REAL NOT NULL,
      PRIMARY KEY (battle_id, gid)
    );
    -- Général vaincu qui peut être épargné : les vainqueurs ont jusqu'à expires_at pour décider, sinon il meurt.
    CREATE TABLE IF NOT EXISTS general_verdicts (
      gid        TEXT PRIMARY KEY,
      winner     TEXT NOT NULL,
      battle_id  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- Résultat de fin de campagne de chaque participant, montré une fois dans une fenêtre.
    CREATE TABLE IF NOT EXISTS campaign_results (
      campaign_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data        TEXT NOT NULL,
      seen        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS seasons (season INTEGER PRIMARY KEY, data TEXT NOT NULL);
    -- Constructions (une spécialité et un niveau par territoire), objectifs de faction et leur progression, signalements de faction.
    CREATE TABLE IF NOT EXISTS territory_builds (territory TEXT PRIMARY KEY, spec TEXT NOT NULL, level INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS faction_objectives (
      campaign_id INTEGER NOT NULL, faction TEXT NOT NULL, objective TEXT NOT NULL, PRIMARY KEY (campaign_id, faction)
    );
    CREATE TABLE IF NOT EXISTS faction_progress (
      campaign_id INTEGER NOT NULL, faction TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (campaign_id, faction, key)
    );
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, faction TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, territory TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    -- Missions de campagne : progression et récompenses récupérées, remises à zéro à chaque campagne.
    CREATE TABLE IF NOT EXISTS campaign_mission_progress (
      campaign_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event       TEXT NOT NULL,
      count       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, user_id, event)
    );
    CREATE TABLE IF NOT EXISTS campaign_mission_claims (
      campaign_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_id  TEXT NOT NULL,
      PRIMARY KEY (campaign_id, user_id, mission_id)
    );
    -- Réactions du journal du monde (féliciter, soutenir, envoyer de l'aide) : une de chaque type par joueur et par événement.
    CREATE TABLE IF NOT EXISTS journal_reactions (
      event_id INTEGER NOT NULL,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind     TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id, kind)
    );
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
    // Faction créditée d'une défense réussie quand ce n'est pas le propriétaire (Loups de cendre pour l'Église de Seiros).
    if (!cols('battles').includes('credit')) db.exec('ALTER TABLE battles ADD COLUMN credit TEXT');
    if (!cols('campaign_scores').includes('deaths')) db.exec('ALTER TABLE campaign_scores ADD COLUMN deaths INTEGER NOT NULL DEFAULT 0');
    // Un joueur qui tombe après une attaque ratée paie son retour plus cher (fall_mult), et ceux d'un exilé ne comptent pas pour sa faction.
    if (!cols('player_state').includes('fall_mult')) db.exec('ALTER TABLE player_state ADD COLUMN fall_mult REAL NOT NULL DEFAULT 1');
    if (!cols('campaign_scores').includes('faction_score')) db.exec('ALTER TABLE campaign_scores ADD COLUMN faction_score INTEGER NOT NULL DEFAULT 0');
    if (!cols('campaign_scores').includes('exile_combats')) db.exec('ALTER TABLE campaign_scores ADD COLUMN exile_combats INTEGER NOT NULL DEFAULT 0');
    if (!cols('journal_reactions').includes('at')) db.exec('ALTER TABLE journal_reactions ADD COLUMN at INTEGER NOT NULL DEFAULT 0');
    // Aide envoyée par des alliés : points de pourcentage ajoutés (ou retirés, côté défense) aux chances de l'attaque.
    if (!cols('battles').includes('help')) db.exec('ALTER TABLE battles ADD COLUMN help INTEGER NOT NULL DEFAULT 0');
    // Raid des Serpents mené par un général.
    if (!cols('battles').includes('general')) db.exec('ALTER TABLE battles ADD COLUMN general TEXT');
    if (!cols('contributions').includes('streak')) db.exec('ALTER TABLE contributions ADD COLUMN streak INTEGER NOT NULL DEFAULT 0');
    // Points de vie : ancienne fraction des PV max, remplacée par hp_pts (points entiers) ci-dessous.
    if (!cols('player_state').includes('hp')) db.exec('ALTER TABLE player_state ADD COLUMN hp REAL NOT NULL DEFAULT 1');
    if (!cols('player_state').includes('vial_day')) db.exec('ALTER TABLE player_state ADD COLUMN vial_day TEXT');
    if (!cols('player_state').includes('vial_n')) db.exec('ALTER TABLE player_state ADD COLUMN vial_n INTEGER NOT NULL DEFAULT 0');
    if (!cols('generals').includes('hp')) db.exec('ALTER TABLE generals ADD COLUMN hp REAL NOT NULL DEFAULT 1');
    // PV en points entiers (patch 2.0) : vide = pleine santé ; remplace la fraction « hp » (laissée de côté, plus lue).
    if (!cols('player_state').includes('hp_pts')) db.exec('ALTER TABLE player_state ADD COLUMN hp_pts INTEGER');
    if (!cols('generals').includes('hp_pts')) db.exec('ALTER TABLE generals ADD COLUMN hp_pts INTEGER');
  }
  db.exec(`
    -- Relations entre joueurs : une jauge partagée par paire (a < b), permanente comme celles des généraux.
    CREATE TABLE IF NOT EXISTS player_relations (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER,
      PRIMARY KEY (a, b)
    );
    -- Offrandes entre joueurs : pour « Dire merci » (une fois, dans les 24 h) et le délai du cadeau sur place.
    CREATE TABLE IF NOT EXISTS player_gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      points INTEGER NOT NULL,
      at INTEGER NOT NULL,
      thanked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS player_gifts_pair ON player_gifts (from_id, to_id, kind, at);
    -- Ordre donné à un général par un joueur (un seul à la fois) : attaquer, défendre ou se déplacer vers un territoire.
    CREATE TABLE IF NOT EXISTS general_orders (
      gid TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  {
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
    battleRows: db.prepare('SELECT user_id, faction, side, power, kind, streak, created_at FROM contributions WHERE battle_id = ?'),
    setStreak: db.prepare('UPDATE player_state SET streak_territory = ?, streak_count = ? WHERE user_id = ?'),
    setRewardDebuff: db.prepare('UPDATE player_state SET reward_debuff = ? WHERE user_id = ?'),
    tickDebuff: db.prepare('UPDATE player_state SET reward_debuff = MAX(reward_debuff - 1, 0) WHERE user_id = ?'),
    chars: db.prepare('SELECT user_id, faction FROM characters'),
    payGold: db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?'),
    loseXp: db.prepare('UPDATE characters SET xp = xp - ? WHERE user_id = ? AND xp >= ?'),
    state: db.prepare('SELECT * FROM player_state WHERE user_id = ?'),
    insertState: db.prepare('INSERT OR REPLACE INTO player_state (user_id, territory, actions, actions_at, status, retreat_until) VALUES (?, ?, ?, ?, ?, NULL)'),
    setActions: db.prepare('UPDATE player_state SET actions = ?, actions_at = ? WHERE user_id = ?'),
    setHpPts: db.prepare('UPDATE player_state SET hp_pts = ? WHERE user_id = ?'),
    setGenHpPts: db.prepare('UPDATE generals SET hp_pts = ? WHERE gid = ?'),
    orders: db.prepare('SELECT * FROM general_orders'),
    orderOf: db.prepare('SELECT * FROM general_orders WHERE gid = ?'),
    addOrder: db.prepare('INSERT INTO general_orders (gid, user_id, kind, target, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    dropOrder: db.prepare('DELETE FROM general_orders WHERE gid = ?'),
    pairGet: db.prepare('SELECT points FROM player_relations WHERE a = ? AND b = ?'),
    pairSet: db.prepare(`INSERT INTO player_relations (a, b, points, updated_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (a, b) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`),
    pairsOf: db.prepare(`SELECT CASE WHEN r.a = ? THEN r.b ELSE r.a END AS other, r.points FROM player_relations r WHERE (r.a = ? OR r.b = ?) AND r.points > 0`),
    addPlayerGift: db.prepare('INSERT INTO player_gifts (from_id, to_id, kind, points, at) VALUES (?, ?, ?, ?, ?)'),
    lastPlayerGift: db.prepare('SELECT at FROM player_gifts WHERE from_id = ? AND to_id = ? AND kind = ? ORDER BY at DESC LIMIT 1'),
    playerGift: db.prepare('SELECT * FROM player_gifts WHERE id = ?'),
    thankGift: db.prepare('UPDATE player_gifts SET thanked = 1 WHERE id = ? AND thanked = 0'),
    giftsTo: db.prepare('SELECT id, thanked, at FROM player_gifts WHERE to_id = ? AND at >= ?'),
    genFans: db.prepare(`SELECT r.user_id, r.points, c.pseudo, c.avatar FROM relations r JOIN characters c ON c.user_id = r.user_id
                         WHERE r.gid = ? AND r.points > 0 ORDER BY r.points DESC LIMIT ?`),
    setVials: db.prepare('UPDATE player_state SET vial_day = ?, vial_n = ? WHERE user_id = ?'),
    hpPlayers: db.prepare(`SELECT p.user_id, p.territory, COALESCE(p.exile_faction, c.faction) AS faction, c.class
                           FROM player_state p JOIN characters c ON c.user_id = p.user_id WHERE p.status != 'dead' AND p.hp_pts IS NOT NULL`),
    healers: db.prepare(`SELECT c.*, p.territory, COALESCE(p.exile_faction, c.faction) AS faction FROM player_state p
                         JOIN characters c ON c.user_id = p.user_id WHERE p.status = 'alive' AND p.territory IS NOT NULL`),
    hpHere: db.prepare(`SELECT p.user_id, p.hp, c.class, c.pseudo FROM player_state p JOIN characters c ON c.user_id = p.user_id
                        WHERE p.status != 'dead' AND p.territory = ? AND COALESCE(p.exile_faction, c.faction) = ?`),
    setBonusTurn: db.prepare('UPDATE player_state SET bonus_turn = ? WHERE user_id = ?'),
    setTerritory: db.prepare("UPDATE player_state SET territory = ?, status = 'alive', retreat_until = NULL, retreat_penalty = 0, revive_asked = 0, fall_mult = 1 WHERE user_id = ?"),
    setRetreating: db.prepare("UPDATE player_state SET status = 'retreating', retreat_until = ?, retreat_penalty = ?, fall_mult = ? WHERE user_id = ?"),
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
    retreatDue: db.prepare("SELECT user_id, retreat_penalty, fall_mult FROM player_state WHERE status = 'retreating' AND retreat_until <= ?"),
    // Joueurs d'une faction encore en jeu (pour les prévenir).
    factionPlayers: db.prepare(`SELECT p.user_id, p.territory FROM player_state p JOIN characters c ON c.user_id = p.user_id
                                WHERE COALESCE(p.exile_faction, c.faction) = ? AND p.status != 'dead'`),
    factionAll: db.prepare('SELECT user_id FROM characters WHERE faction = ?'),
    fallen: db.prepare(`SELECT c.user_id, c.pseudo, p.fall_mult FROM player_state p JOIN characters c ON c.user_id = p.user_id
                        WHERE COALESCE(p.exile_faction, c.faction) = ? AND p.status = 'dead' AND p.revive_asked = 1 AND c.user_id != ?`),
    // Un exilé compte dans la faction qu'il a rejointe.
    presence: db.prepare(`SELECT p.territory, COALESCE(p.exile_faction, c.faction) AS faction, count(*) AS n FROM player_state p JOIN characters c ON c.user_id = p.user_id
                          WHERE p.status != 'dead' GROUP BY p.territory, COALESCE(p.exile_faction, c.faction)`),
    // Joueurs en vie avec leur position, et ceux qui attaquent ou défendent là où ils se trouvent (bataille en cours ou garnison).
    occupants: db.prepare(`SELECT p.user_id, p.territory, p.status, p.hp, COALESCE(p.exile_faction, c.faction) AS faction, p.exile_faction, c.pseudo, c.avatar, c.class, c.xp
                           FROM player_state p JOIN characters c ON c.user_id = p.user_id WHERE p.status != 'dead' AND p.territory != ''`),
    engaged: db.prepare(`SELECT DISTINCT k.user_id, k.territory FROM contributions k LEFT JOIN battles b ON b.id = k.battle_id
                         WHERE k.kind = 'action' AND ((b.id IS NOT NULL AND b.resolved_at IS NULL) OR (k.battle_id IS NULL AND k.expires_at > ?))`),
    aliveByFaction: db.prepare(`SELECT COALESCE(p.exile_faction, c.faction) AS faction, count(*) AS n, sum(p.status != 'dead') AS alive
                                FROM player_state p JOIN characters c ON c.user_id = p.user_id GROUP BY COALESCE(p.exile_faction, c.faction)`),
    openBattle: db.prepare('SELECT * FROM battles WHERE territory = ? AND resolved_at IS NULL'),
    // Territoires pris et défenses réussies par une faction dans la campagne en cours (Paladin noir).
    factionWins: db.prepare(`SELECT count(*) AS n FROM battles WHERE campaign_id = ? AND resolved_at IS NOT NULL
                             AND ((attacker = ? AND success = 1) OR (defender = ? AND success = 0))`),
    // Défenses réussies récentes (insaisissable et contre-attaque).
    recentDefenses: db.prepare('SELECT territory, attacker, defender, credit, resolved_at FROM battles WHERE campaign_id = ? AND success = 0 AND resolved_at >= ?'),
    freeMoveUsed: db.prepare('SELECT 1 AS used FROM battle_free_moves WHERE battle_id = ? AND user_id = ?'),
    addFreeMove: db.prepare('INSERT OR IGNORE INTO battle_free_moves (battle_id, user_id) VALUES (?, ?)'),
    openBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL'),
    dueBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL AND ends_at <= ? ORDER BY ends_at'),
    insertBattle: db.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    setCredit: db.prepare('UPDATE battles SET credit = ? WHERE id = ?'),
    defenderFactions: db.prepare("SELECT DISTINCT faction FROM contributions WHERE battle_id = ? AND side = 'defense' AND kind = 'action'"),
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
    clearFactionMeta: db.prepare("DELETE FROM campaign_meta WHERE key LIKE 'held:%' OR key LIKE 'out:%' OR key LIKE 'epi:%' OR key LIKE 'finished:%' OR key LIKE 'gauge:%' OR key LIKE 'buff:%' OR key LIKE 'retake:%' OR key LIKE 'warned:%' OR key LIKE 'immac:%' OR key LIKE 'overdrive:%' OR key IN ('conquest', 'serpents_gone', 'reset_at', 'summary', 'crusade', 'immaculate')"),
    addEvent: db.prepare('INSERT INTO world_events (campaign_id, type, params, created_at) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT id, type, params, created_at FROM world_events ORDER BY id DESC LIMIT 40'),
    purgeEvents: db.prepare('DELETE FROM world_events WHERE id <= (SELECT max(id) FROM world_events) - 300'),
    // Un exilé gagne un score personnel (classement) mais rien pour une faction (faction_score).
    addScore: db.prepare(`INSERT INTO campaign_scores (campaign_id, user_id, score, faction_score) VALUES (?, ?, ?, ?)
                          ON CONFLICT (campaign_id, user_id) DO UPDATE SET score = score + excluded.score, faction_score = faction_score + excluded.faction_score`),
    addExileCombat: db.prepare(`INSERT INTO campaign_scores (campaign_id, user_id, exile_combats) VALUES (?, ?, 1)
                                ON CONFLICT (campaign_id, user_id) DO UPDATE SET exile_combats = exile_combats + 1`),
    ranking: db.prepare(`SELECT s.user_id, s.score, c.pseudo, c.faction, c.avatar FROM campaign_scores s
                         JOIN characters c ON c.user_id = s.user_id WHERE s.campaign_id = ? AND s.score > 0
                         ORDER BY s.score DESC, s.user_id LIMIT ?`),
    addDeath: db.prepare(`INSERT INTO campaign_scores (campaign_id, user_id, score, deaths) VALUES (?, ?, 0, 1)
                          ON CONFLICT (campaign_id, user_id) DO UPDATE SET deaths = deaths + 1`),
    flawless: db.prepare('SELECT user_id FROM campaign_scores WHERE campaign_id = ? AND score > 0 AND deaths = 0'),
    mvp: db.prepare(`SELECT s.user_id FROM campaign_scores s JOIN characters c ON c.user_id = s.user_id
                     WHERE s.campaign_id = ? AND s.score > 0 AND c.faction = ? ORDER BY s.score DESC, s.user_id LIMIT 1`),
    sideActors: db.prepare("SELECT DISTINCT user_id FROM contributions WHERE battle_id = ? AND side = ? AND kind = 'action'"),
    myScore: db.prepare('SELECT score FROM campaign_scores WHERE campaign_id = ? AND user_id = ?'),
    betterScores: db.prepare('SELECT count(*) AS n FROM campaign_scores WHERE campaign_id = ? AND score > ?'),
    // Fin de campagne : participants et leurs chiffres, efficacité d'une faction, survivants hors exilés.
    scoresOf: db.prepare(`SELECT s.user_id, s.score, s.faction_score, s.deaths, s.exile_combats, c.faction, p.exile_faction FROM campaign_scores s
                          JOIN characters c ON c.user_id = s.user_id LEFT JOIN player_state p ON p.user_id = s.user_id
                          WHERE s.campaign_id = ? AND (s.score > 0 OR s.exile_combats > 0)`),
    survivors: db.prepare(`SELECT c.faction, count(*) AS n FROM player_state p JOIN characters c ON c.user_id = p.user_id
                           WHERE p.status != 'dead' AND p.exile_faction IS NULL GROUP BY c.faction`),
    attacksWon: db.prepare('SELECT count(*) AS n FROM battles WHERE campaign_id = ? AND attacker = ? AND success = 1 AND resolved_at IS NOT NULL'),
    defensesWon: db.prepare(`SELECT count(*) AS n FROM battles WHERE campaign_id = ? AND success = 0 AND resolved_at IS NOT NULL
                             AND (credit = ? OR (credit IS NULL AND defender = ?))`),
    addResult: db.prepare('INSERT OR REPLACE INTO campaign_results (campaign_id, user_id, data, seen) VALUES (?, ?, ?, 0)'),
    resultFor: db.prepare('SELECT campaign_id, data FROM campaign_results WHERE user_id = ? AND seen = 0 ORDER BY campaign_id DESC LIMIT 1'),
    markResultSeen: db.prepare('UPDATE campaign_results SET seen = 1 WHERE user_id = ?'),
    // Engagement : actions de combat d'un joueur sur un territoire (bataille en cours ou garnison active), annulées s'il en part.
    myEngagements: db.prepare(`SELECT count(*) AS n FROM contributions k LEFT JOIN battles b ON b.id = k.battle_id
                               WHERE k.user_id = ? AND k.territory = ? AND k.kind = 'action' AND ((b.id IS NOT NULL AND b.resolved_at IS NULL) OR (k.battle_id IS NULL AND k.expires_at > ?))`),
    dropEngagements: db.prepare(`DELETE FROM contributions WHERE user_id = ? AND territory = ? AND kind = 'action'
                                 AND (battle_id IS NULL OR battle_id IN (SELECT id FROM battles WHERE resolved_at IS NULL))`),
    dropGenEngagements: db.prepare('DELETE FROM general_contribs WHERE gid = ? AND battle_id IN (SELECT id FROM battles WHERE resolved_at IS NULL AND territory = ?)'),
    exilesAll: db.prepare('SELECT user_id FROM player_state WHERE exile_faction IS NOT NULL'),
    latestEvent: db.prepare('SELECT max(id) AS id FROM world_events'),
    profileOf: db.prepare('SELECT user_id, pseudo, faction, class, class_path, xp, avatar, birthday FROM characters WHERE pseudo = ?'),
    buildGet: db.prepare('SELECT spec, level FROM territory_builds WHERE territory = ?'),
    buildSet: db.prepare(`INSERT INTO territory_builds (territory, spec, level) VALUES (?, ?, ?)
                          ON CONFLICT (territory) DO UPDATE SET spec = excluded.spec, level = excluded.level`),
    buildClear: db.prepare('DELETE FROM territory_builds WHERE territory = ?'),
    buildAll: db.prepare('SELECT territory, spec, level FROM territory_builds'),
    objGet: db.prepare('SELECT objective FROM faction_objectives WHERE campaign_id = ? AND faction = ?'),
    objSet: db.prepare('INSERT OR IGNORE INTO faction_objectives (campaign_id, faction, objective) VALUES (?, ?, ?)'),
    fpBump: db.prepare(`INSERT INTO faction_progress (campaign_id, faction, key, count) VALUES (?, ?, ?, ?)
                        ON CONFLICT (campaign_id, faction, key) DO UPDATE SET count = count + excluded.count`),
    fpGet: db.prepare('SELECT count FROM faction_progress WHERE campaign_id = ? AND faction = ? AND key = ?'),
    pingAdd: db.prepare('INSERT INTO pings (campaign_id, faction, user_id, territory, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    pingDropUser: db.prepare('DELETE FROM pings WHERE user_id = ?'),
    pingLast: db.prepare('SELECT created_at FROM pings WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
    pingsOf: db.prepare(`SELECT p.id, p.territory, p.kind, p.created_at, p.user_id, c.pseudo FROM pings p JOIN characters c ON c.user_id = p.user_id
                         WHERE p.campaign_id = ? AND p.faction = ? AND p.created_at >= ? ORDER BY p.id DESC LIMIT ?`),
    cmBump: db.prepare(`INSERT INTO campaign_mission_progress (campaign_id, user_id, event, count) VALUES (?, ?, ?, ?)
                        ON CONFLICT (campaign_id, user_id, event) DO UPDATE SET count = count + excluded.count`),
    cmProgress: db.prepare('SELECT event, count FROM campaign_mission_progress WHERE campaign_id = ? AND user_id = ?'),
    cmClaims: db.prepare('SELECT mission_id FROM campaign_mission_claims WHERE campaign_id = ? AND user_id = ?'),
    cmClaim: db.prepare('INSERT OR IGNORE INTO campaign_mission_claims (campaign_id, user_id, mission_id) VALUES (?, ?, ?)'),
    myDeaths: db.prepare('SELECT deaths FROM campaign_scores WHERE campaign_id = ? AND user_id = ?'),
    reactionsOf: db.prepare('SELECT event_id, kind FROM journal_reactions WHERE user_id = ?'),
    addReaction: db.prepare('INSERT OR IGNORE INTO journal_reactions (event_id, user_id, kind, at) VALUES (?, ?, ?, ?)'),
    reactionsSince: db.prepare('SELECT count(*) AS n FROM journal_reactions WHERE user_id = ? AND kind = ? AND at >= ?'),
    eventById: db.prepare('SELECT id, type, params, created_at FROM world_events WHERE id = ?'),
    battleById: db.prepare('SELECT * FROM battles WHERE id = ?'),
    addHelp: db.prepare('UPDATE battles SET help = help + ? WHERE id = ? AND resolved_at IS NULL'),
    userChar: db.prepare('SELECT pseudo FROM characters WHERE user_id = ?'),
    // Généraux.
    generals: db.prepare('SELECT * FROM generals'),
    general: db.prepare('SELECT * FROM generals WHERE gid = ?'),
    giftCooldown: db.prepare('SELECT at FROM gift_cooldowns WHERE user_id = ? AND kind = ?'),
    setGiftCooldown: db.prepare('INSERT INTO gift_cooldowns (user_id, kind, at) VALUES (?, ?, ?) ON CONFLICT (user_id, kind) DO UPDATE SET at = excluded.at'),
    insertGeneral: db.prepare("INSERT OR IGNORE INTO generals (gid, faction, territory, status, actions, actions_at) VALUES (?, ?, ?, 'alive', ?, ?)"),
    clearGenerals: db.prepare('DELETE FROM generals'),
    setGeneralActions: db.prepare('UPDATE generals SET actions = ?, actions_at = ? WHERE gid = ?'),
    setGeneralAt: db.prepare('UPDATE generals SET territory = ? WHERE gid = ?'),
    setGeneralMoveTurn: db.prepare('UPDATE generals SET move_turn = ? WHERE gid = ?'),
    setGeneralStatus: db.prepare('UPDATE generals SET status = ? WHERE gid = ?'),
    joinGeneral: db.prepare("UPDATE generals SET faction = ?, status = 'alive', spared = 1 WHERE gid = ?"),
    addGeneralContrib: db.prepare('INSERT OR IGNORE INTO general_contribs (battle_id, gid, side, power) VALUES (?, ?, ?, ?)'),
    generalContribs: db.prepare('SELECT gid, side, power FROM general_contribs WHERE battle_id = ?'),
    generalContribed: db.prepare('SELECT 1 AS yes FROM general_contribs WHERE battle_id = ? AND gid = ?'),
    // Généraux engagés dans une bataille ouverte (jamais cachés) et nombre de sorties offensives en cours.
    generalsEngaged: db.prepare(`SELECT k.gid, b.territory FROM general_contribs k JOIN battles b ON b.id = k.battle_id WHERE b.resolved_at IS NULL`),
    addVerdict: db.prepare('INSERT OR REPLACE INTO general_verdicts (gid, winner, battle_id, expires_at) VALUES (?, ?, ?, ?)'),
    verdicts: db.prepare('SELECT * FROM general_verdicts'),
    verdict: db.prepare('SELECT * FROM general_verdicts WHERE gid = ?'),
    dropVerdict: db.prepare('DELETE FROM general_verdicts WHERE gid = ?'),
    verdictVoter: db.prepare("SELECT 1 AS yes FROM contributions WHERE battle_id = ? AND user_id = ? AND faction = ? AND kind = 'action' LIMIT 1"),
    setBattleGeneral: db.prepare('UPDATE battles SET general = ? WHERE id = ?'),
    charLevels: db.prepare('SELECT c.faction, c.xp, u.last_login_at FROM characters c JOIN users u ON u.id = c.user_id'),
  };

  const ownersMap = () => new Map(q.owners.all().map((r) => [r.id, r.faction]));
  const currentCampaign = () => {
    let c = q.campaign.get();
    if (!c) { q.newCampaign.run(iso()); c = q.campaign.get(); }
    return c;
  };
  const journal = (type, params = {}, t = Date.now()) => q.addEvent.run(currentCampaign().id, type, JSON.stringify(params), t);
  // Un joueur tombe. Seule une fenêtre de repli écoulée est une vraie mort, comptée pour la campagne en cours
  // (mission spéciale « finir sans mourir ») ; la chute de sa faction ne compte pas, il peut s'exiler.
  const markDead = (uid, died = false) => {
    if (died && q.state.get(uid)?.status !== 'dead') q.addDeath.run(currentCampaign().id, uid);
    q.setDead.run(uid);
  };
  // Replis manqués : le joueur n'est pas privé de jeu, mais puni. Il est renvoyé à sa capitale (ou sur un territoire de sa faction),
  // paie le prix d'un retour (x2 après une attaque ratée, plus l'amende de l'Archer d'élite), perd son stock d'actions et gagne moins
  // pendant `wound.actions` actions. Sa faction tombée, il reste hors jeu (exil possible) comme avant.
  function woundPlayer(uid, mult, snipe, t, byHp = false) {
    q.addDeath.run(currentCampaign().id, uid);
    metric('wounded', 1);
    const side = effFaction(uid);
    const spot = side && spawnTerritory(side, ownersMap());
    if (!spot) { q.setDead.run(uid); notify(uid, 'fallen', { wounded: false }); return; }
    const fine = Math.min(q.gold.get(uid)?.gold || 0, Math.round((isExile(uid) ? C.revive.gold : reviveCost(side)) * mult * reviveFactor(uid)) + snipe);
    if (fine > 0) q.takeGold.run(fine, uid);
    q.setTerritory.run(spot, uid);
    q.setActions.run(0, t, uid);
    const woundActions = Math.max(0, C.wound.actions - relSum(relBonuses(uid), 'woundRelief')); // Linhardt
    q.setRewardDebuff.run(woundActions, uid);
    let healed = 0;
    if (hpOn()) {
      const hh = playerHp(uid);
      if (hh) storePlayerHp(uid, Math.max(hh.cur, hpUp((hh.max * HP.koReturnPct) / 100)), hh.max);
      const mar = relSum(relBonuses(uid), 'woundHeal'); // Marianne : soin immédiat après une blessure
      if (mar > 0) healed = healPlayer(uid, mar);
    }
    notify(uid, byHp ? 'fallen_hp' : 'fallen', { wounded: true, gold: fine, actions: woundActions, territory: spot, ...(healed ? { healed } : {}) });
  }
  // Fait reculer des joueurs après une bataille perdue ou un territoire perdu : ils ont quelques tours pour se replier, sinon ils tombent.
  // mult : coût de retour en jeu s'ils tombent (x2 pour un attaquant dont l'attaque a échoué). foes : effets des vainqueurs (Archer).
  function forceRetreat(players, faction, mult, foes, t) {
    const enemyAdj = Math.min(0, ...foes.filter((e) => e.kind === 'retreat').map((e) => e.enemy || 0));
    const penalty = Math.max(0, ...foes.filter((e) => e.kind === 'sniper').map((e) => e.gold || 0));
    for (const uid of players) {
      const refuge = !isExile(uid) && perks(faction).autoRetreat && C.homeBases[faction];
      if (refuge) {
        // Une faction dotée d'un refuge s'y replie d'elle-même.
        const from = q.state.get(uid)?.territory;
        q.setTerritory.run(refuge, uid);
        notify(uid, 'auto_retreat', { territory: from, home: refuge });
      } else {
        const own = fx.sumOf(effectsOfUser(uid), 'retreat', 'own');
        const turns = Math.max(1, C.retreatTurns + own + enemyAdj + relSum(relBonuses(uid), 'retreatDelay')); // Flayn
        q.setRetreating.run(t + turns * TURN_MS, penalty, mult, uid);
        notify(uid, 'must_retreat', { territory: q.state.get(uid)?.territory });
      }
    }
  }
  // Paiement en or d'un joueur (refusé s'il n'a pas assez) ; le total dépensé alimente une mission spéciale.
  const pay = (userId, cost, sink = 'other') => {
    if (q.payGold.run(cost, userId, cost).changes !== 1) return false;
    metric(`gold_out:${sink}`, cost);
    if (ctx.countStat) ctx.countStat(userId, 'gold_spent', cost);
    return true;
  };
  // Série de victoires ou de défaites d'un joueur (attaques ou défenses) et sa meilleure série (missions spéciales).
  function streak(uid, key, won) {
    if (!ctx.setStat || !ctx.statOf) return;
    if (!won) { ctx.setStat(uid, key, 0); return; }
    const v = ctx.statOf(uid, key) + 1;
    ctx.setStat(uid, key, v);
    if (v > ctx.statOf(uid, `best_${key}`)) ctx.setStat(uid, `best_${key}`, v);
  }
  // Score de classement ; un exilé ne rapporte rien à une faction (faction_score).
  const score = (userId, n) => {
    if (!n) return;
    const exiled = !!q.state.get(userId)?.exile_faction;
    n = Math.round(n * (1 + relSum(relBonuses(userId), 'scoreBonus') / 100)); // Rhea
    const od = odCfg(overdriveOf(userId)); // Overdrive : points de faction gagnés en plus
    q.addScore.run(currentCampaign().id, userId, n, exiled ? 0 : Math.round(n * (1 + (od?.factionPointsPct || 0) / 100)));
  };

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
        if (q.state.get(uid)) markDead(uid);
        notify(uid, 'faction_out', { faction: f });
      }
      // Les exilés qui combattaient sous sa bannière tombent aussi, mais peuvent en choisir une autre.
      for (const { user_id: uid } of q.exilesOf.all(f)) {
        q.clearExile.run(uid);
        markDead(uid);
        notify(uid, 'exile_lost', { faction: f });
      }
      honorDefeated(f);
    }
  }

  // ------------------------------------------------------------ Capitales, constructions, objectifs, seigneurs, signalements
  const CAPITALS = new Set(Object.values(C.capitals));
  // Une faction qui a perdu sa capitale (et n'est pas hors jeu) perd de la puissance tant qu'elle ne l'a pas reprise.
  const capitalLost = (f, owners) => !!C.capitals[f] && owners.get(C.capitals[f]) !== f && !isOut(f);
  const capitalGuard = (territory, owners) => {
    const f = Object.keys(C.capitals).find((x) => C.capitals[x] === territory);
    if (!f || owners.get(territory) !== f) return 1;
    return 1 + (C.capital.perTerritory || 0) * TERR.filter((x) => owners.get(x.id) === f).length;
  };
  const capMult = (f, owners) => (f && capitalLost(f, owners) ? 1 - (C.capital.lossPct || 0) / 100 : 1);
  // Constructions.
  const buildOf = (territory) => q.buildGet.get(territory) || null;
  const buildEffect = (territory, key) => { const b = buildOf(territory); return b ? (C.build.specs[b.spec]?.[key] || 0) * b.level : 0; };
  // Progression d'une faction (objectif hebdomadaire) : conquests, defenses, generals, annex, capital.
  const fp = (faction, key, n = 1) => { if (faction && PLAYABLE.has(faction)) q.fpBump.run(currentCampaign().id, faction, key, n); };
  const fpCount = (faction, key) => q.fpGet.get(currentCampaign().id, faction, key)?.count || 0;
  // Objectif de la faction pour cette campagne : tiré parmi ceux qui lui conviennent, une fois (stable ensuite).
  function objectiveOf(faction) {
    const cid = currentCampaign().id;
    const list = (C.objectives || []).filter((o) => !o.factions || o.factions.includes(faction));
    if (!list.length) return null;
    let row = q.objGet.get(cid, faction);
    if (!row) {
      const idx = (cid * 7 + [...PLAYABLE].indexOf(faction) * 3) % list.length;
      q.objSet.run(cid, faction, list[idx].id);
      row = q.objGet.get(cid, faction);
    }
    return C.objectives.find((o) => o.id === row.objective) || null;
  }
  function objectiveStatus(faction, owners) {
    const o = objectiveOf(faction);
    if (!o) return null;
    const main = TERR.filter((x) => !ANNEX.has(x.id));
    let current;
    let target = o.target || 1;
    if (o.type === 'pct') current = Math.round((main.filter((x) => owners.get(x.id) === faction).length / main.length) * 100);
    else if (o.type === 'hold') { current = owners.get(o.territory) === faction ? 1 : 0; target = 1; }
    else current = fpCount(faction, o.type);
    return { id: o.id, title: o.title, description: o.description, type: o.type, current: Math.min(current, target), target, done: current >= target, points: o.points || 0, gold: o.gold || 0 };
  }
  // Seigneurs : la jauge de la faction monte avec ses combats ; pleine, la capacité du seigneur s'active.
  const lordMs = (lord) => Math.round((lord.ability.minutes * TURN_MS) / C.turnMinutes);
  const buffUntil = (f) => Number(q.meta.get(`buff:${f}`)?.value || 0);
  function activeBuff(f) {
    const lord = f && C.lords[f];
    return lord && buffUntil(f) > Date.now() ? lord.ability.effect : null;
  }
  function addGauge(f, n) {
    const lord = f && C.lords[f];
    if (!lord || !n || buffUntil(f) > Date.now()) return; // pendant l'effet, la jauge ne monte pas
    const g = Number(q.meta.get(`gauge:${f}`)?.value || 0) + n;
    if (g < C.gauge.max) { q.setMeta.run(`gauge:${f}`, String(g)); return; }
    q.setMeta.run(`gauge:${f}`, '0');
    q.setMeta.run(`buff:${f}`, String(Date.now() + lordMs(lord)));
    journal('lord_ability', { faction: f, lord: lord.id });
    for (const c of q.chars.all()) notify(c.user_id, 'lord_ability', { faction: f, lord: lord.id }); // tout le monde est prévenu, dans l'app
  }
  const lordMult = (f, side) => { const b = activeBuff(f); return b && b.kind === 'power' && (b.side === 'both' || b.side === side) ? 1 + b.pct / 100 : 1; };
  const hireFactor = (f) => { const b = activeBuff(f); return b && b.kind === 'hireCost' ? 1 - b.pct / 100 : 1; };
  function lordPayload(f) {
    const lord = f && C.lords[f];
    if (!lord) return null;
    const until = buffUntil(f);
    return { faction: f, id: lord.id, ability: { title: lord.ability.title, description: lord.ability.description }, gauge: Number(q.meta.get(`gauge:${f}`)?.value || 0), max: C.gauge.max, activeUntil: until > Date.now() ? until : null };
  }

  // ------------------------------------------------------------ Missions de campagne
  // Événements comptés par le serveur : conquest, defense, garreg_conquest, retake, annex_conquest, spare, general.
  const cm = (userId, event, n = 1) => { q.cmBump.run(currentCampaign().id, userId, event, n); };
  function missionState(userId) {
    const cid = currentCampaign().id;
    const progress = new Map(q.cmProgress.all(cid, userId).map((r) => [r.event, r.count]));
    const claimed = new Set(q.cmClaims.all(cid, userId).map((r) => r.mission_id));
    return (C.missions || []).map((m) => {
      const target = m.condition?.count || 1;
      const current = Math.min(progress.get(m.condition?.event) || 0, target);
      return {
        id: m.id, title: m.title, description: m.description || '', current, target,
        rewards: { gold: m.rewards?.gold || 0, xp: m.rewards?.xp || 0, actions: m.rewards?.actions || 0 },
        status: claimed.has(m.id) ? 'claimed' : current >= target ? 'done' : 'active',
      };
    });
  }
  const missionsClaimable = (userId) => missionState(userId).filter((m) => m.status === 'done').length;
  function claimMission(userId, id) {
    const m = missionState(userId).find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'mission_unknown');
    if (m.status !== 'done' || q.cmClaim.run(currentCampaign().id, userId, id).changes !== 1) throw new HttpError(409, 'reward_unavailable');
    grant(userId, m.rewards.gold, m.rewards.xp, 'mission');
    if (m.rewards.actions) rewardActions(userId, m.rewards.actions);
    return missionState(userId);
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
  const isExile = (userId) => !!q.state.get(userId)?.exile_faction;
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
  const limitsOf = (userId) => {
    const l = fx.actionLimits(effectsOfUser(userId), C.maxActions, TURN_MS, C.turnMinutes);
    return { ...l, max: l.max + relSum(relBonuses(userId), 'maxActions') + (odCfg(overdriveOf(userId))?.maxActions || 0) }; // Manuela, Overdrive
  };
  // Tirage des déplacements gratuits (TEST_MOVE_ROLL le fixe pour les tests).
  const moveRoll = () => (process.env.TEST_MOVE_ROLL !== undefined ? Number(process.env.TEST_MOVE_ROLL) : Math.random());
  const freeMoveChance = (userId) => { const ch = q.char.get(userId); return ch ? fx.freeMoveChance(fx.pathOf(ch), effectsOfRow(ch)) : 0; };
  // Multiplicateurs d'or et d'expérience appliqués à toutes les sources de gains (voir `grant` dans server.js).
  function rewardMods(userId, source = 'other') {
    const effects = effectsOfUser(userId);
    let gold = 1 + fx.sumOf(effects, 'goldBonus') / 100;
    let xp = 1 + fx.sumOf(effects, 'xpBonus') / 100;
    // Soutien : Leonie (toute la renommée), Hanneman (renommée des récoltes), Seteth (missions du jour).
    const rb = relBonuses(userId);
    xp += (relSum(rb, 'xpAll') + (source === 'gather' ? relSum(rb, 'gatherXp') : 0)) / 100;
    if (source === 'daily') { const d = relSum(rb, 'dailyBonus') / 100; gold += d; xp += d; }
    // Exil : toutes les ressources gagnées sont réduites (missions comprises), sauf la prime d'exil de fin de campagne.
    if (source !== 'exile' && q.state.get(userId)?.exile_faction) { const m = C.exile.rewardMultiplier ?? 1; gold *= m; xp *= m; }
    // Overdrive+ : or et renommée en plus à chaque gain tiré d'une action.
    const od = odCfg(overdriveOf(userId));
    const flat = od && OD_FLAT_SOURCES.has(source) ? { plusGold: od.gold || 0, plusXp: od.xp || 0 } : {};
    // Après une téléportation, les récompenses des actions suivantes sont réduites.
    if ((q.state.get(userId)?.reward_debuff || 0) > 0) {
      const f = effects.find((e) => e.kind === 'teleport')?.rewardFactor ?? 0.5;
      gold *= f;
      xp *= f;
    }
    return { gold, xp, ...flat };
  }
  // Un exilé ne profite d'aucun avantage de la faction qu'il sert (capacité du seigneur, avantages des Loups de cendre…).
  const fortifyCost = (userId) => Math.round(C.hire.gold * productOf(effectsOfUser(userId), 'fortifyCost', 'factor') * productOf(effectsOfUser(userId), 'buildCost', 'factor') * (isExile(userId) ? 1 : hireFactor(effFaction(userId))));
  const fortifyPower = (userId) => C.hire.power * productOf(effectsOfUser(userId), 'fortifyPower', 'factor') * (1 + relSum(relBonuses(userId), 'fortifyBoost') / 100); // Gilbert

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
    // Au-delà du maximum (récompenses de missions), la réserve est gardée mais ne se recharge plus.
    return actions >= lim.max ? { actions, at: t, next: null, max: lim.max } : { actions, at, next: at + lim.ms, max: lim.max };
  }
  // Actions offertes (missions) : elles peuvent dépasser le maximum.
  // Hilda : de l'or à chaque action rendue par le compteur. On enregistre alors la recharge (même résultat que settle) pour ne
  // payer chaque action qu'une fois. Une réserve pleine ne se recharge pas, donc ne rapporte rien.
  function collectRegen(userId, t = Date.now()) {
    const gold = relSum(relBonuses(userId), 'regenGold');
    if (!gold) return 0;
    const ps = q.state.get(userId);
    if (!ps) return 0;
    const s = settle(ps, t);
    const gained = s.actions - ps.actions;
    if (gained <= 0) return 0;
    q.setActions.run(s.actions, s.at, userId);
    grant(userId, gold * gained, 0, 'relation');
    return gold * gained;
  }
  function rewardActions(userId, n) {
    if (!n) return;
    const m = q.state.get(userId)?.exile_faction ? C.exile.rewardMultiplier ?? 1 : 1;
    const x = n * m;
    giveActions(userId, Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0));
  }
  function giveActions(userId, n) {
    collectRegen(userId);
    const ps = ensurePlayer(userId);
    if (!ps || !n) return;
    const t = Date.now();
    const s = settle(ps, t);
    q.setActions.run(s.actions + n, s.actions >= s.max ? t : s.at, userId);
  }
  // Montée de niveau (appelée par grant) : actions remplies si `refill`, et autant de PV actuels que de PV max gagnés
  // (un joueur à pleine santé le reste). Renvoie le nombre d'actions rendues.
  function onLevelUp(userId, levels, refill) {
    const ps = q.state.get(userId);
    if (ps && ps.hp_pts != null && hpPerLevel()) q.setHpPts.run(ps.hp_pts + levels * hpPerLevel(), userId);
    return refill ? refillActions(userId) : 0;
  }
  // Remplit la réserve d'actions jusqu'au maximum (une réserve déjà au-delà, par les missions, est gardée).
  function refillActions(userId) {
    collectRegen(userId);
    const ps = q.state.get(userId);
    if (!ps || ps.status === 'dead') return 0;
    const t = Date.now();
    const s = settle(ps, t);
    if (s.actions >= s.max) return 0;
    q.setActions.run(s.max, t, userId);
    return s.max - s.actions;
  }
  // Dépense 1 action. La première action de chaque tour rapporte un petit bonus de régularité.
  function spend(ps, t) {
    const s = settle(ps, t);
    if (s.actions < 1) throw new HttpError(409, 'no_actions');
    metric('actions_spent', 1);
    q.setActions.run(s.actions - 1, s.actions >= s.max ? t : s.at, ps.user_id);
    const turn = Math.floor(t / TURN_MS);
    if (C.cadenceGold > 0 && ps.bonus_turn !== turn) {
      q.setBonusTurn.run(turn, ps.user_id);
      grant(ps.user_id, C.cadenceGold, 0, 'cadence');
      return C.cadenceGold;
    }
    return 0;
  }

  // ------------------------------------------------------------ Points de vie
  // Chaque joueur et chaque général a des PV max selon sa classe (palier, classes lourdes ou fragiles). Les PV se perdent en points
  // à la fin de chaque bataille où l'on a agi (plus en attaque qu'en défense, beaucoup plus en cas de défaite), se régénèrent avec le
  // temps (plus vite sur un territoire allié sans bataille, Infirmerie, Overdrive) et se soignent (action Soigner, fioles).
  // Sous certains seuils, la puissance baisse. À 0 PV, un joueur est mis hors de combat ; un général meurt (seigneurs exceptés).
  // Activation : `start` = 'season' attend la première campagne d'une nouvelle saison (meta hp_from), 'now' tout de suite.
  const HP = {
    enabled: false, start: 'season', max: { base: 30 }, sturdy: { classes: [], bonus: 0 }, frail: { classes: [], bonus: 0 },
    loss: {}, malus: [], regen: { perHour: 2, alliedPerHour: 4, overdriveFactor: 1 }, koReturnPct: 50, heal: {}, selfFactor: 0.5, healXp: 0,
    vial: { gold: 150, hp: 8, perDay: 3 }, generals: { sortieMinPct: 50, healBelowPct: 70 },
    ...(C.hp || {}),
  };
  function hpOn() {
    if (process.env.HP_ON !== undefined) return process.env.HP_ON === '1'; // tests
    if (!HP.enabled) return false;
    return HP.start === 'now' || !!q.meta.get('hp_from');
  }
  function hpMaxOf(classId) {
    let m = HP.max[tierOfClass(classId)] ?? HP.max.base ?? 30;
    if ((HP.sturdy.classes || []).includes(classId)) m += HP.sturdy.bonus || 0;
    if ((HP.frail.classes || []).includes(classId)) m += HP.frail.bonus || 0;
    return Math.max(1, m);
  }
  // PV max d'un joueur : ceux de sa classe, +perLevel par niveau de renommée, plus le bonus de soutien de Mercedes (kind hpMax).
  const hpPerLevel = () => Number(process.env.HP_PER_LEVEL ?? HP.perLevel) || 0; // HP_PER_LEVEL : tests
  const hpMaxPlayer = (uid, classId, rb = relBonuses(uid)) => {
    const lvl = hpPerLevel() ? renown(q.char.get(uid)?.xp || 0).level : 0;
    return hpMaxOf(classId) + lvl * hpPerLevel() + relSum(rb, 'hpMax');
  };
  // PV en points entiers : colonne hp_pts (vide = pleine santé), toujours lue plafonnée au maximum du moment (classe, niveau,
  // soutiens). Tous les gains et toutes les pertes sont des entiers, arrondis au-dessus.
  const hpUp = (n) => Math.max(0, Math.ceil((Number(n) || 0) - 1e-9));
  const ptsOf = (stored, max) => (stored == null ? max : Math.max(0, Math.min(max, Math.round(stored))));
  function playerHp(uid, ps = q.state.get(uid), ch = q.char.get(uid)) {
    if (!ps || !ch) return null;
    const max = hpMaxPlayer(uid, ch.class);
    const cur = ptsOf(ps.hp_pts, max);
    return { cur, max, frac: cur / max };
  }
  function genHpOf(row) {
    if (!row || !GEN.has(row.gid)) return { cur: 1, max: 1, frac: 1 };
    const max = hpMaxOf(genClass(row.gid));
    const cur = ptsOf(row.hp_pts, max);
    return { cur, max, frac: cur / max };
  }
  const storePlayerHp = (uid, cur, max) => q.setHpPts.run(cur >= max ? null : Math.max(0, Math.round(cur)), uid);
  const storeGenHp = (row, cur, max) => { const v = cur >= max ? null : Math.max(0, Math.round(cur)); q.setGenHpPts.run(v, row.gid); row.hp_pts = v; };
  const hpPct = (h) => Math.ceil(h.frac * 100);
  // Malus de puissance selon les PV restants (le seuil le plus bas atteint l'emporte).
  function hpMalus(frac) {
    if (!hpOn()) return 0;
    const pct = frac * 100;
    return [...HP.malus].sort((a, b) => a.below - b.below).find((m) => pct < m.below)?.pct || 0;
  }
  const hpMult = (frac) => 1 - hpMalus(frac) / 100;
  const healOf = (classId) => Number(HP.heal[classId]) || 0;
  function hpLoss(side, success, decisive) {
    const L = HP.loss;
    const won = (side === 'attack') === success;
    if (!won) return (side === 'attack' ? L.attackLoss : L.defenseLoss) || 0;
    if (decisive) return (side === 'attack' ? L.attackDecisive : L.defenseDecisive) || 0;
    return (side === 'attack' ? L.attackWin : L.defenseWin) || 0;
  }
  function hpOfPlayer(userId) {
    const ps = q.state.get(userId);
    const ch = q.char.get(userId);
    const h = playerHp(userId, ps, ch);
    if (!h) return null;
    return { frac: h.frac, max: h.max, hp: h.cur, pct: hpPct(h), malus: hpMalus(h.frac) };
  }
  // Retire des PV à un joueur ; à 0, il est mis hors de combat. Renvoie true s'il tombe.
  function hurtPlayer(uid, pts, t) {
    const ps = q.state.get(uid);
    const ch = q.char.get(uid);
    pts = hpUp(pts);
    if (!ps || !ch || ps.status === 'dead' || !(pts > 0)) return false;
    const h = playerHp(uid, ps, ch);
    if (h.cur - pts > 0) { storePlayerHp(uid, h.cur - pts, h.max); return false; }
    storePlayerHp(uid, 0, h.max);
    woundPlayer(uid, 1, 0, t, true);
    return true;
  }
  function healPlayer(uid, pts) {
    const ps = q.state.get(uid);
    const ch = q.char.get(uid);
    if (!ps || !ch) return 0;
    const h = playerHp(uid, ps, ch);
    const after = Math.min(h.max, h.cur + hpUp(pts));
    storePlayerHp(uid, after, h.max);
    return after - h.cur;
  }
  function healGeneral(row, pts) {
    const h = genHpOf(row);
    const after = Math.min(h.max, h.cur + hpUp(pts));
    storeGenHp(row, after, h.max);
    return after - h.cur;
  }
  // Effets de classe sur les PV (combattants qui ont agi dans la bataille, joueurs et généraux) :
  // hpDodge (chance de ne rien perdre), hpGuard (les alliés du même côté perdent moins, le plus fort compte),
  // hpWound (les ennemis vaincus perdent plus, le plus fort compte), hpOnWin et hpDrain (PV regagnés après une victoire).
  const hpRoll = () => (process.env.TEST_HP_ROLL !== undefined ? Number(process.env.TEST_HP_ROLL) : Math.random());
  function wearParts(b) {
    const parts = [];
    for (const side of ['attack', 'defense']) for (const { user_id: uid } of q.sideActors.all(b.id, side)) parts.push({ id: uid, side, eff: effectsOfUser(uid) });
    for (const c of q.generalContribs.all(b.id)) if (GEN.has(c.gid)) parts.push({ id: `g:${c.gid}`, side: c.side, eff: fx.effectsOfPath(genPath(c.gid)) });
    return parts;
  }
  function wearOf(part, parts, success, decisive) {
    const won = (part.side === 'attack') === success;
    const best = (list, kind, field) => Math.max(0, ...list.flatMap((x) => x.eff.filter((e) => e.kind === kind).map((e) => Number(e[field]) || 0)));
    const mates = parts.filter((x) => x.side === part.side);
    const foes = parts.filter((x) => x.side !== part.side);
    let loss = hpLoss(part.side, success, decisive) - best(mates, 'hpGuard', 'pts') + (won ? 0 : best(foes, 'hpWound', 'pts'));
    const dodge = best([part], 'hpDodge', 'pct');
    if (dodge && hpRoll() * 100 < dodge) loss = 0;
    let gain = 0;
    if (won) {
      gain += part.eff.filter((e) => e.kind === 'hpOnWin').reduce((n, e) => n + (Number(e.pts) || 0), 0);
      for (const e of part.eff.filter((x) => x.kind === 'hpDrain')) gain += Math.min(Number(e.max) || Infinity, (Number(e.perEnemy) || 0) * foes.length);
    }
    return { loss: Math.max(0, loss), gain };
  }
  // Usure d'une bataille pour les joueurs qui y ont agi. Renvoie ceux qui sont tombés à 0 PV (déjà mis hors de combat).
  function battleWear(b, success, decisive, t) {
    const ko = new Set();
    if (!hpOn()) return ko;
    const parts = wearParts(b);
    for (const part of parts) {
      if (typeof part.id !== 'number') continue;
      const w = wearOf(part, parts, success, decisive);
      if (hurtPlayer(part.id, w.loss, t)) ko.add(part.id);
      else if (w.gain) healPlayer(part.id, w.gain);
    }
    return ko;
  }
  // Usure des généraux encore debout après la bataille. À 0 PV, un général meurt d'épuisement, sauf les seigneurs (et l'Immaculée),
  // qui restent à 1 PV.
  function generalsWear(b, success, decisive, t) {
    if (!hpOn()) return;
    const parts = wearParts(b);
    for (const c of q.generalContribs.all(b.id)) {
      const row = q.general.get(c.gid);
      if (!row || row.status !== 'alive' || !GEN.has(row.gid)) continue;
      const h = genHpOf(row);
      const w = wearOf(parts.find((x) => x.id === `g:${c.gid}`) || { id: `g:${c.gid}`, side: c.side, eff: [] }, parts, success, decisive);
      const left = h.cur - hpUp(w.loss);
      if (left > 0) { storeGenHp(row, Math.min(h.max, left + hpUp(w.gain)), h.max); continue; }
      if (isLord(row.gid) || row.gid === CH.lord || row.gid === CH.immaculate) { storeGenHp(row, 1, h.max); continue; }
      storeGenHp(row, 0, h.max);
      killGeneral(row, c.side === 'attack' ? b.defender : b.attacker, row.territory, t, true);
    }
  }
  // Régénération, à chaque heure pleine et en points entiers : plus rapide sur un territoire allié sans bataille, plus encore
  // avec une Infirmerie, le soin passif d'un Évêque ou le soutien de Flayn, doublée pendant l'Overdrive.
  // Soin passif (effet « healAura » de l'Évêque, hérité par ses classes suivantes) : PV par heure pour les alliés
  // de son territoire et des territoires voisins, jusqu'à deux cases avec l'effet « reach » (Gremory).
  // Plusieurs soigneurs ne se cumulent pas : le meilleur soin compte. Clé « faction|territoire » → PV par heure.
  function passiveHeals() {
    const out = new Map();
    const spread = (faction, from, eff) => {
      const pts = Math.max(0, ...eff.filter((e) => e.kind === 'healAura').map((e) => Number(e.pts) || 0));
      if (!pts || !from || !faction) return;
      const base = Math.max(0, ...eff.filter((e) => e.kind === 'healAura').map((e) => (e.range === 'territory' ? 0 : 1)));
      const reach = Math.max(base, ...eff.filter((e) => e.kind === 'reach').map((e) => Number(e.distance) || 0));
      let ring = [from];
      const seen = new Set(ring);
      for (let d = 0; d < reach; d += 1) {
        const next = [];
        for (const id of ring) for (const n of neighbors(id)) if (!seen.has(n)) { seen.add(n); next.push(n); }
        ring = next;
      }
      for (const id of seen) out.set(`${faction}|${id}`, Math.max(out.get(`${faction}|${id}`) || 0, pts));
    };
    for (const p of q.healers.all()) spread(p.faction, p.territory, effectsOfRow(p));
    for (const g of q.generals.all()) if (g.status === 'alive' && g.territory && GEN.has(g.gid)) spread(g.faction, g.territory, fx.effectsOfPath(genPath(g.gid)));
    return out;
  }
  function hpTick(t) {
    if (!hpOn()) return;
    const HOUR = 3_600_000;
    const last = Number(q.meta.get('hp_tick')?.value || 0);
    if (!last) { q.setMeta.run('hp_tick', String(t)); return; }
    const hours = Math.floor((t - last) / HOUR);
    if (hours < 1) return;
    q.setMeta.run('hp_tick', String(hours > 12 ? t : last + hours * HOUR)); // au plus 12 heures rattrapées d'un coup
    const h = Math.min(12, hours);
    const owners = ownersMap();
    const fighting = new Set(q.openBattles.all().map((b) => b.territory));
    const od = overdriveOn(t) ? HP.regen.overdriveFactor || 1 : 1;
    const passive = passiveHeals();
    const rate = (f, at) => {
      const o = owners.get(at) ?? null;
      const allied = !!at && !!f && !fighting.has(at) && (o === f || guardians[f] === o);
      return ((allied ? (HP.regen.alliedPerHour || 0) + buildEffect(at, 'hpRegen') : HP.regen.perHour || 0) + (passive.get(`${f}|${at}`) || 0)) * od;
    };
    for (const p of q.hpPlayers.all()) {
      const flayn = relSum(relBonuses(p.user_id), 'hpRegenHour') * od; // Flayn : PV en plus par heure
      const hh = playerHp(p.user_id);
      if (hh) storePlayerHp(p.user_id, Math.min(hh.max, hh.cur + hpUp((rate(p.faction, p.territory) + flayn) * h)), hh.max);
    }
    for (const g of q.generals.all()) {
      if (g.status !== 'alive' || !g.territory || !GEN.has(g.gid) || g.hp_pts == null) continue;
      const gh = genHpOf(g);
      storeGenHp(g, Math.min(gh.max, gh.cur + hpUp(rate(g.faction, g.territory) * h)), gh.max);
    }
  }
  // Jour des fioles (fuseau de la campagne).
  const vialDay = (t) => { const z = zoneParts(t, C.schedule.timezone || 'Europe/Paris'); return `${z.y}-${z.m}-${z.d}`; };
  const vialsLeft = (ps, t) => Math.max(0, (HP.vial.perDay || 0) - (ps.vial_day === vialDay(t) ? ps.vial_n : 0));
  function hpPayload(userId, ps, ch, t) {
    if (!hpOn()) return null;
    const h = hpOfPlayer(userId);
    if (!h) return null;
    return { ...h, heal: healOf(ch.class), selfHeal: hpUp(healOf(ch.class) * (HP.selfFactor ?? 0.5)), vial: { gold: HP.vial.gold, hp: HP.vial.hp, left: vialsLeft(ps, t), perDay: HP.vial.perDay } };
  }

  // Force d'une action de combat : dépend du rang de la classe et de la renommée du joueur.
  function power(ch) {
    const tier = config.classes.find((c) => c.id === ch.class)?.tier;
    return (C.tierPower[tier] ?? 1) * (1 + renown(ch.xp).level * C.renownPower) * (ch.home && ch.home !== ch.faction ? 1 : powerBonus(ch.faction));
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

  // ------------------------------------------------------------ Généraux
  // Chaque général a une seule vie par campagne. Il se tient sur son territoire d'origine, le défend coûte que coûte quand on l'attaque,
  // et, une fois un premier territoire conquis sur la carte, peut partir en sortie contre un territoire ennemi voisin.
  // Un général battu meurt ou, si les vainqueurs le décident et que sa fiche l'autorise, est épargné une seule fois et rejoint leur faction.
  const tierOfClass = (id) => config.classes.find((c) => c.id === id)?.tier;
  // TEST_NO_GENERALS : désactive les généraux (tests qui isolent les autres règles).
  const GENERALS_ON = process.env.TEST_NO_GENERALS === undefined;
  const genRand = () => (process.env.TEST_GEN_ROLL !== undefined ? Number(process.env.TEST_GEN_ROLL) : Math.random());
  const GEN_ATTACK_CHANCE = process.env.GEN_ATTACK_CHANCE !== undefined ? Number(process.env.GEN_ATTACK_CHANCE) : G.attackChance;
  // Renommée médiane des joueurs actifs de chaque faction (connectés depuis `activeDays` jours ; à défaut, tous ses membres),
  // pour qu'une poignée de comptes inactifs ne tire pas le niveau des généraux vers le bas. Mise en cache quelques secondes.
  let levelCache = null;
  let smooth = null; // niveau lissé de chaque faction (persisté dans la meta glvl)
  let smoothAt = 0;
  const SMOOTH_MS = process.env.GLVL_SMOOTH_MS !== undefined ? Number(process.env.GLVL_SMOOTH_MS) : 60_000;
  const median = (a) => { if (!a.length) return 0; const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  // Niveau de référence de chaque faction pour ses généraux : sa médiane de joueurs actifs, relevée vers la moyenne des factions
  // quand elle est en retard (`level.balance`), puis lissée dans le temps (`level.smoothing` à chaque minute) pour éviter les sauts.
  function avgLevels() {
    if (levelCache && Date.now() - levelCache.at < 5000) return levelCache;
    const now = Date.now();
    const since = now - (G.level.activeDays ?? 7) * 86_400_000;
    const by = new Map();
    const act = new Map();
    const all = [];
    const allAct = [];
    for (const r of q.charLevels.all()) {
      const l = renown(r.xp).level;
      const active = Date.parse(r.last_login_at || 0) >= since;
      all.push(l);
      if (active) allAct.push(l);
      if (!by.has(r.faction)) { by.set(r.faction, []); act.set(r.faction, []); }
      by.get(r.faction).push(l);
      if (active) act.get(r.faction).push(l);
    }
    const pick = (a, b) => (a.length ? median(a) : median(b));
    const raw = new Map([...by].filter(([f]) => PLAYABLE.has(f)).map(([f, a]) => [f, pick(act.get(f), a)]));
    const ref = raw.size ? [...raw.values()].reduce((x, y) => x + y, 0) / raw.size : 0;
    const bal = G.level.balance ?? 0;
    const target = new Map([...raw].map(([f, v]) => [f, v + bal * Math.max(0, ref - v)]));
    if (!smooth) { try { smooth = JSON.parse(q.meta.get('glvl')?.value || '{}'); } catch { smooth = {}; } }
    const alpha = process.env.GLVL_ALPHA !== undefined ? Number(process.env.GLVL_ALPHA) : (G.level.smoothing ?? 0.15);
    const step = now - smoothAt >= SMOOTH_MS;
    for (const [f, v] of target) smooth[f] = smooth[f] === undefined ? v : step ? smooth[f] + (v - smooth[f]) * alpha : smooth[f];
    if (step) { smoothAt = now; q.setMeta.run('glvl', JSON.stringify(smooth)); }
    levelCache = { at: now, all: pick(allAct, all), by: new Map([...target.keys()].map((f) => [f, smooth[f]])) };
    return levelCache;
  }
  // Niveau de renommée d'un général : moyenne de sa faction (ou de tous les joueurs s'il est indépendant), selon son coefficient.
  function genLevel(row) {
    const lv = avgLevels();
    const avg = (row.faction && PLAYABLE.has(row.faction) ? lv.by.get(row.faction) : null) ?? lv.all;
    return Math.max(G.level.min, Math.round(avg * (G.level.base + G.level.perCoef * GEN.get(row.gid).coef)));
  }
  const genPath = (gid) => GEN.get(gid).path;
  const genClass = (gid) => genPath(gid)[genPath(gid).length - 1];
  const genPower = (row) => (C.tierPower[tierOfClass(genClass(row.gid))] ?? 1) * (1 + genLevel(row) * C.renownPower);
  const genPerson = (row, territory = row.territory) => {
    const path = genPath(row.gid);
    return { id: `g:${row.gid}`, faction: row.faction || null, territory: territory || null, classId: genClass(row.gid), path, effects: fx.effectsOfPath(path), level: genLevel(row), general: true };
  };
  const genReward = (gid) => ({ gold: Math.round(G.reward.gold * GEN.get(gid).coef), xp: Math.round(G.reward.xp * GEN.get(gid).coef) });

  function resetGenerals(t) {
    db.exec('DELETE FROM generals; DELETE FROM general_contribs; DELETE FROM general_verdicts; DELETE FROM general_orders');
    if (!GENERALS_ON) return;
    for (const g of G.roster) q.insertGeneral.run(g.id, g.faction || null, g.home || '', G.actions, t);
    if (GEN.has(CH.immaculate)) q.setGeneralStatus.run('dormant', CH.immaculate); // l'Immaculée attend la chute de Garreg-Mach
  }
  const ensureGenerals = (t) => {
    if (!GENERALS_ON) return;
    const fresh = G.roster.filter((g) => q.insertGeneral.run(g.id, g.faction || null, g.home || '', G.actions, t).changes);
    if (fresh.some((g) => g.id === CH.immaculate) && !awakening()) q.setGeneralStatus.run('dormant', CH.immaculate);
    // Église ajoutée en pleine campagne alors que Garreg-Mach est déjà tombé : ses chevaliers n'entrent pas en jeu.
    if (ownersMap().get(CH.seat) !== CH.faction) for (const g of fresh) if (g.faction === CH.faction && g.id !== CH.immaculate) q.setGeneralStatus.run('dead', g.id);
  };

  // Actions d'un général : +1 par tour, 4 au maximum.
  function genActions(row, t) {
    let { actions, actions_at: at } = row;
    if (actions < G.actions) {
      const gained = Math.floor((t - at) / TURN_MS);
      if (gained > 0) { actions = Math.min(G.actions, actions + gained); at += gained * TURN_MS; }
    }
    return actions >= G.actions ? { actions: G.actions, at: t } : { actions, at };
  }
  function spendGen(row, cur, t, n = 1) {
    if (cur.actions >= G.actions) cur.at = t;
    cur.actions -= n;
    q.setGeneralActions.run(cur.actions, cur.at, row.gid);
  }
  // Plus court chemin (cases à traverser, départ exclu) où le général a le droit d'entrer.
  function pathTo(from, to, faction, owners) {
    if (from === to) return [];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const n of neighbors(cur)) {
        if (prev.has(n) || !canEnter(faction, n, owners)) continue;
        prev.set(n, cur);
        if (n === to) { const out = []; for (let x = n; x !== from; x = prev.get(x)) out.unshift(x); return out; }
        queue.push(n);
      }
    }
    return null;
  }
  function genFight(row, cur, battle, side, t, free = false) {
    if ((!free && cur.actions < 1) || q.generalContribed.get(battle.id, row.gid)) return false;
    if (!free) spendGen(row, cur, t);
    q.addGeneralContrib.run(battle.id, row.gid, side, genPower(row));
    return true;
  }
  function genAttack(row, cur, territory, owners, t) {
    let b = q.openBattle.get(territory);
    if (b && b.attacker !== row.faction) return false;
    if (!b) {
      if (shieldUntil(territory, owners, t) || (owners.get(territory) ?? null) === row.faction) return false;
      b = startBattle(territory, row.faction, owners.get(territory) ?? null, t);
    }
    return genFight(row, cur, b, 'attack', t);
  }

  // Un général qui quitte un territoire y perd ses actions de combat en cours (comme un joueur).
  function moveGeneral(row, to) {
    if (row.territory && row.territory !== to) q.dropGenEngagements.run(row.gid, row.territory);
    q.setGeneralAt.run(to, row.gid);
    row.territory = to;
  }
  // Soins d'un général soigneur : l'allié le plus blessé sous le seuil (healBelowPct), sur son territoire, une fois par tour.
  function genHeal(row, cur, t, turn) {
    const amount = healOf(genClass(row.gid));
    if (!amount || cur.actions < 1 || row.move_turn >= turn || !row.faction) return false;
    const limit = (HP.generals.healBelowPct || 0) / 100;
    const cands = [];
    for (const g of q.generals.all()) {
      if (g.status === 'alive' && g.territory === row.territory && g.faction === row.faction && GEN.has(g.gid) && genHpOf(g).frac < limit) cands.push({ frac: genHpOf(g).frac, g });
    }
    for (const p of q.hpHere.all(row.territory, row.faction)) { const f = playerHp(p.user_id)?.frac ?? 1; if (f < limit) cands.push({ frac: f, p }); }
    if (!cands.length) return false;
    cands.sort((a, b) => a.frac - b.frac);
    const c = cands[0];
    spendGen(row, cur, t);
    q.setGeneralMoveTurn.run(turn, row.gid);
    if (c.g) healGeneral(c.g.gid === row.gid ? row : c.g, c.g.gid === row.gid ? amount * (HP.selfFactor ?? 0.5) : amount);
    else healPlayer(c.p.user_id, amount); // sans notification : un soigneur peut agir à chaque tour
    return true;
  }
  // ------------------------------------------------------------ Commandes des généraux
  // Dès le niveau de soutien `orders.minLevel` avec un général de son camp, un joueur peut lui ordonner d'attaquer, de défendre ou de
  // se déplacer vers un territoire. Le général y va avec ses actions, fait ce qu'on lui demande, puis reprend sa vie. Un seul ordre à
  // la fois : les autres joueurs attendent qu'il ait fini. Les seigneurs (et l'Église, qui suit sa propre stratégie) ne se commandent pas.
  const GO = { minLevel: 'C', maxHours: 6, ...(G.orders || {}) };
  const orderMs = () => GO.maxHours * 3_600_000 * (TURN_MS / (C.turnMinutes * 60_000));
  function finishOrder(ord, outcome, t) {
    q.dropOrder.run(ord.gid);
    notify(ord.user_id, 'general_order', { general: ord.gid, kind: ord.kind, territory: ord.target, outcome });
  }
  function orderValid(row, ord, owners) {
    const o = owners.get(ord.target) ?? null;
    if (ord.kind === 'attack') { const b = q.openBattle.get(ord.target); return o !== row.faction && (!b || b.attacker === row.faction); }
    if (ord.kind === 'defend') return o === row.faction;
    return canEnter(row.faction, ord.target, owners);
  }
  function runOrder(row, cur, ord, owners, t, turn) {
    if (t >= ord.expires_at) return finishOrder(ord, ord.kind === 'defend' ? 'held' : 'expired', t);
    if (row.faction !== effFaction(ord.user_id)) return finishOrder(ord, 'failed', t);
    const hereB = q.openBattle.get(row.territory);
    const engagedHere = !!hereB && !!q.generalContribed.get(hereB.id, row.gid);
    if (row.territory !== ord.target) {
      if (!orderValid(row, ord, owners)) return finishOrder(ord, 'failed', t);
      if (engagedHere) return; // il finit d'abord le combat en cours
      const path = pathTo(row.territory, ord.target, row.faction, owners);
      if (!path) return finishOrder(ord, 'failed', t);
      if (row.move_turn < turn && cur.actions >= 1 && path.length) { spendGen(row, cur, t); moveGeneral(row, path[0]); q.setGeneralMoveTurn.run(turn, row.gid); }
      return;
    }
    if (ord.kind === 'move') return finishOrder(ord, 'done', t);
    if (ord.kind === 'attack') {
      if (engagedHere && hereB.attacker === row.faction) return finishOrder(ord, 'done', t);
      if (!orderValid(row, ord, owners)) return finishOrder(ord, 'failed', t);
      if (shieldUntil(ord.target, owners, t)) return finishOrder(ord, 'failed', t);
      if (phase(t) !== 'open') return finishOrder(ord, 'failed', t);
      if (cur.actions >= 1 && genAttack(row, cur, ord.target, owners, t)) finishOrder(ord, 'done', t);
      return;
    }
    // Défendre : il tient le territoire jusqu'à la fin de l'ordre, et le défend s'il est attaqué.
    if (!orderValid(row, ord, owners)) return finishOrder(ord, 'failed', t);
    if (hereB && hereB.attacker !== row.faction) {
      if (engagedHere) return finishOrder(ord, 'done', t);
      if (genFight(row, cur, hereB, 'defense', t)) finishOrder(ord, 'done', t);
    }
  }
  // Territoires où un général peut aller, et ce qu'on peut lui ordonner sur chacun.
  function orderTargets(row, owners) {
    const seen = new Set([row.territory]);
    const queue = [row.territory];
    while (queue.length) {
      const cur = queue.shift();
      for (const n of neighbors(cur)) if (!seen.has(n) && canEnter(row.faction, n, owners)) { seen.add(n); queue.push(n); }
    }
    const out = { attack: [], defend: [], move: [] };
    for (const id of seen) {
      const o = owners.get(id) ?? null;
      const b = q.openBattle.get(id);
      if (o !== row.faction && (!b || b.attacker === row.faction)) out.attack.push(id);
      if (o === row.faction) out.defend.push(id);
      if (id !== row.territory) out.move.push(id);
    }
    return out;
  }
  // Peut-on commander ce général ? Renvoie null si oui, sinon la raison.
  function commandBlock(userId, row) {
    if (!row || row.status !== 'alive' || !row.territory || !GEN.has(row.gid)) return 'unavailable';
    if (isLord(row.gid) || row.gid === CH.lord || row.faction === CH.faction || row.faction === C.boss.faction || !row.faction) return 'unavailable';
    const side = effFaction(userId);
    if (!side || row.faction !== side) return 'camp';
    const need = R.levels.find((l) => l.id === GO.minLevel)?.points || 0;
    if ((relPoints(userId).get(row.gid) || 0) < need) return 'level';
    return null;
  }
  function orderPayload(userId, row) {
    const ord = row ? q.orderOf.get(row.gid) : null;
    const by = ord ? q.char.get(ord.user_id) : null;
    const block = commandBlock(userId, row);
    return {
      order: ord ? { kind: ord.kind, target: ord.target, by: by?.pseudo || null, mine: ord.user_id === userId, until: ord.expires_at } : null,
      command: block === 'unavailable' ? null : { can: !block && !ord, reason: block || (ord ? 'busy' : null), minLevel: GO.minLevel, targets: !block && !ord ? orderTargets(row, ownersMap()) : null },
    };
  }

  // L'IA des généraux, à chaque tick.
  function generalsTick(t) {
    const owners = ownersMap();
    // Ordres d'un général qui n'est plus en état de les suivre (mort, captif) : annulés.
    for (const o of q.orders.all()) { const g = q.general.get(o.gid); if (!g || g.status !== 'alive') finishOrder(o, 'failed', t); }
    const turn = Math.floor(t / TURN_MS);
    const conquered = q.meta.get('conquest')?.value === '1';
    // Généraux déjà sortis de chez eux (en route ou en pleine attaque) : ils comptent dans la limite de sorties.
    let sorties = q.generals.all().filter((g) => g.status === 'alive' && GEN.has(g.gid) && g.faction && PLAYABLE.has(g.faction) && g.territory !== GEN.get(g.gid).home).length;
    for (const row of q.generals.all()) {
      if (row.status !== 'alive' || row.faction === C.boss.faction || !row.territory || !GEN.has(row.gid)) continue;
      // La faction d'un général est tombée : il disparaît de la carte.
      if (row.faction && PLAYABLE.has(row.faction) && isOut(row.faction)) { q.setGeneralStatus.run('dead', row.gid); continue; }
      const cfg = GEN.get(row.gid);
      const cur = genActions(row, t);
      const home = cfg.home;
      const homeOwner = owners.get(home) ?? null;
      const hb = q.openBattle.get(home);
      // Son territoire d'origine est attaqué : il y va (s'il lui reste assez d'actions) et le défend.
      if (hb && hb.attacker !== row.faction && (homeOwner === row.faction || guarding(row.faction, homeOwner, hb) || row.faction === null)) {
        if (row.territory !== home) {
          const path = pathTo(row.territory, home, row.faction, owners);
          if (!path || cur.actions < path.length + 1) continue;
          spendGen(row, cur, t, path.length);
          moveGeneral(row, home);
        }
        genFight(row, cur, hb, 'defense', t, isLord(row.gid) && home === seatOf(row.faction)); // un seigneur défend toujours sa capitale
        continue;
      }
      // Ordre d'un joueur : le général le suit jusqu'au bout (ou jusqu'à ce qu'il devienne impossible).
      const ord = q.orderOf.get(row.gid);
      if (ord) { runOrder(row, cur, ord, owners, t, turn); continue; }
      // Soigneur : une fois par tour, soigne l'allié le plus blessé sur son territoire (général ou joueur), lui compris.
      if (hpOn() && genHeal(row, cur, t, turn)) continue;
      // Seigneur dans sa capitale : il n'en bouge pas.
      if (isLord(row.gid) && seatOf(row.faction) && row.territory === seatOf(row.faction) && owners.get(row.territory) === row.faction) continue;
      // Engagé dans un combat là où il se trouve : il reste jusqu'à la fin (partir annulerait ses actions).
      const hereB = q.openBattle.get(row.territory);
      if (hereB && q.generalContribed.get(hereB.id, row.gid)) continue;
      // Chevaliers de l'Église : garnison, croisade ou reprise de Garreg-Mach.
      if (row.faction === CH.faction) { churchKnight(row, cur, owners, t, turn); continue; }
      // Ralliement : le seigneur a perdu sa capitale et a ordonné sa reprise ; tous les généraux de la faction marchent sur elle.
      const cap = C.capitals[row.faction];
      if (cap && q.meta.get(`retake:${row.faction}`)?.value === '1') {
        if (owners.get(cap) === row.faction) q.setMeta.run(`retake:${row.faction}`, '0');
        else if (phase(t) === 'open') {
          if (row.territory === cap) { if (row.move_turn < turn) genAttack(row, cur, cap, owners, t); continue; }
          const path = pathTo(row.territory, cap, row.faction, owners);
          if (path && path.length && row.move_turn < turn && cur.actions >= 1) { spendGen(row, cur, t); moveGeneral(row, path[0]); q.setGeneralMoveTurn.run(turn, row.gid); continue; }
          if (path) continue;
        }
      }
      if (!conquered || phase(t) !== 'open' || !row.faction || !PLAYABLE.has(row.faction)) continue; // pas d'offensive avant la première conquête, pendant la clôture, ni pour un indépendant
      const here = row.territory;
      const hereOwner = owners.get(here) ?? null;
      const hereBattle = q.openBattle.get(here);
      const rested = row.move_turn < turn;
      if (hereOwner !== row.faction && !isHome(row.faction, here, owners)) {
        // Chez l'ennemi : il attaque une fois (ou rejoint l'attaque de sa faction), sinon il rentre.
        if (!rested) continue;
        if (cur.actions >= 1 && (!hereBattle || hereBattle.attacker === row.faction) && genAttack(row, cur, here, owners, t)) continue;
        if (cur.actions >= 1) {
          const step = (pathTo(here, home, row.faction, owners) || [])[0] || neighbors(here).find((n) => isHome(row.faction, n, owners));
          if (step) { spendGen(row, cur, t); moveGeneral(row, step); q.setGeneralMoveTurn.run(turn, row.gid); }
        }
        continue;
      }
      if (!rested || cur.actions < 2) continue;
      if (here !== home && homeOwner === row.faction) {
        const step = (pathTo(here, home, row.faction, owners) || [])[0];
        if (step) { spendGen(row, cur, t); moveGeneral(row, step); q.setGeneralMoveTurn.run(turn, row.gid); }
        continue;
      }
      // Sortie : un territoire ennemi voisin, de préférence là où sa faction attaque déjà (jamais trop blessé).
      if (sorties >= G.maxSorties) continue;
      if (hpOn() && genHpOf(row).frac * 100 < (HP.generals.sortieMinPct || 0)) continue;
      const targets = neighbors(here).filter((n) => {
        const o = owners.get(n) ?? null;
        const b = q.openBattle.get(n);
        return o !== row.faction && PLAYABLE.has(o) && !ANNEX.has(n) && canEnter(row.faction, n, owners) && (!b || b.attacker === row.faction) && !shieldUntil(n, owners, t);
      });
      if (!targets.length) continue;
      const joining = targets.filter((n) => q.openBattle.get(n));
      if (!joining.length && genRand() >= GEN_ATTACK_CHANCE) continue;
      const pool = joining.length ? joining : targets;
      const target = pool[Math.floor(genRand() * pool.length) % pool.length];
      spendGen(row, cur, t);
      moveGeneral(row, target);
      q.setGeneralMoveTurn.run(turn, row.gid);
      sorties += 1;
    }
  }

  // ------------------------------------------------------------ Église de Seiros
  // Chemin le plus court vers le premier territoire qui remplit `goal` : les chevaliers de l'Église traversent toutes les terres.
  function freePath(from, goal) {
    if (goal(from)) return [];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const n of neighbors(cur)) {
        if (prev.has(n)) continue;
        prev.set(n, cur);
        if (goal(n)) { const out = []; for (let x = n; x !== from; x = prev.get(x)) out.unshift(x); return out; }
        queue.push(n);
      }
    }
    return null;
  }
  const crusadeOf = () => q.meta.get('crusade')?.value || null;
  // Éveil de l'Immaculée en cours : { holder, waves (assauts repoussés), next (prochain assaut sur Garreg-Mach), turn }.
  function awakening() { try { return JSON.parse(q.meta.get('immaculate')?.value || 'null'); } catch { return null; } }
  const knights = () => q.generals.all().filter((g) => g.faction === CH.faction && g.status === 'alive' && GEN.has(g.gid) && g.gid !== CH.lord && g.gid !== CH.immaculate);
  function churchKnight(row, cur, owners, t, turn) {
    if (row.gid === CH.lord || row.gid === CH.immaculate || row.move_turn >= turn || phase(t) !== 'open') return;
    const here = row.territory;
    const step = (to) => { spendGen(row, cur, t); moveGeneral(row, to); q.setGeneralMoveTurn.run(turn, row.gid); };
    const march = (goal) => {
      const path = freePath(here, goal);
      if (path && path.length && cur.actions >= 1) step(path[0]);
    };
    // Garreg-Mach aux mains d'une autre faction (l'Immaculée l'assiège, ou Rhea n'est plus) : les chevaliers marchent dessus.
    if ((owners.get(CH.seat) ?? null) !== CH.faction) {
      if (here === CH.seat) { if (cur.actions >= 1) genAttack(row, cur, here, owners, t); return; }
      return march((id) => id === CH.seat);
    }
    // Croisade : quelques chevaliers sortent (une garnison reste) et attaquent les terres de la faction visée, en commençant par les plus proches.
    const target = crusadeOf();
    if (target) {
      const all = knights();
      const out = all.filter((g) => g.territory !== CH.seat).length;
      const home = all.length - out;
      if (here !== CH.seat || (out < CH.crusade.sorties && home > CH.crusade.garrison)) {
        if (owners.get(here) === target) { if (cur.actions >= 1) genAttack(row, cur, here, owners, t); return; }
        return march((id) => {
          const b = q.openBattle.get(id);
          return owners.get(id) === target && !ANNEX.has(id) && !shieldUntil(id, owners, t) && (!b || b.attacker === CH.faction);
        });
      }
      return;
    }
    // Sinon : retour à Garreg-Mach.
    if (here !== CH.seat) march((id) => id === CH.seat);
  }
  // Croisade (déclarée par Rhea quand une faction tient trop de la carte, levée quand elle redescend) et assauts de l'Immaculée.
  function churchTick(t) {
    if (!GENERALS_ON || !GEN.has(CH.lord)) return;
    const owners = ownersMap();
    const aw = awakening();
    if (aw) { awakeningTick(aw, owners, t); return; }
    const rhea = q.general.get(CH.lord);
    const able = !!rhea && rhea.status === 'alive' && owners.get(CH.seat) === CH.faction && phase(t) === 'open';
    const main = TERR.filter((x) => !ANNEX.has(x.id));
    const share = (f) => main.filter((x) => owners.get(x.id) === f).length / main.length;
    const cur = crusadeOf();
    if (cur) {
      if (!able || share(cur) < CH.crusade.end) { q.setMeta.run('crusade', ''); journal('crusade_ended', { faction: cur }, t); }
      return;
    }
    if (!able) return;
    const [lead, pct] = [...PLAYABLE].map((f) => [f, share(f)]).sort((a, b) => b[1] - a[1])[0] || [];
    if (!lead || pct < CH.crusade.start) return;
    q.setMeta.run('crusade', lead);
    journal('crusade_declared', { faction: lead, general: CH.lord }, t);
    for (const c of q.chars.all()) notify(c.user_id, 'crusade_declared', { faction: lead });
  }
  // Garreg-Mach est tombé : Rhea s'éveille en l'Immaculée (elle quitte la carte, ses assauts commencent).
  function awaken(holder, t) {
    if (!GEN.has(CH.immaculate)) return killGeneral(q.general.get(CH.lord), holder, CH.seat, t);
    q.setGeneralStatus.run('dormant', CH.lord);
    q.setGeneralStatus.run('alive', CH.immaculate);
    q.setMeta.run('immaculate', JSON.stringify({ holder, waves: 0, next: t, turn: -1 }));
    q.setMeta.run('crusade', '');
    journal('immaculate_awoke', { faction: holder || null, general: CH.immaculate }, t);
    for (const c of q.chars.all()) notify(c.user_id, 'immaculate_awoke', { faction: holder || null, waves: CH.awakening.waves });
    return null;
  }
  const immaculatePower = (id) => (CH.awakening.power || 3) * importance(id) * (GEN.get(CH.immaculate)?.coef || 1);
  // Un assaut sur Garreg-Mach dès que le précédent est passé (pas pendant les heures calmes), et des raids sur ses voisins.
  function awakeningTick(aw, owners, t) {
    const A = CH.awakening;
    const holder = owners.get(CH.seat) ?? null;
    if (!holder || holder === CH.faction || phase(t) !== 'open') return;
    const open = q.openBattles.all();
    const raids = open.filter((b) => b.general === CH.immaculate);
    const busy = new Set(open.map((b) => b.territory));
    if (t >= aw.next && !busy.has(CH.seat) && !quietHour(t)) {
      startBattle(CH.seat, CH.faction, holder, t, immaculatePower(CH.seat), CH.immaculate);
      busy.add(CH.seat);
    }
    const turn = Math.floor(t / TURN_MS);
    if (aw.turn === turn) return;
    aw.turn = turn;
    q.setMeta.run('immaculate', JSON.stringify(aw));
    if (quietHour(t) || raids.filter((b) => b.territory !== CH.seat).length >= (A.maxRaids ?? 1) || raidRoll() >= A.raidChance) return;
    const targets = neighbors(CH.seat).filter((n) => PLAYABLE.has(owners.get(n)) && !busy.has(n) && !ANNEX.has(n) && !shieldUntil(n, owners, t));
    if (!targets.length) return;
    const id = targets[Math.floor(Math.random() * targets.length) % targets.length];
    startBattle(id, CH.faction, owners.get(id), t, immaculatePower(id), CH.immaculate);
  }
  // Assaut de l'Immaculée sur Garreg-Mach repoussé : au dernier, elle tombe.
  function waveRepelled(b, by, t) {
    const aw = awakening();
    if (!aw) return;
    aw.waves += 1;
    aw.next = t + (CH.awakening.waveGapHours || 0) * 3_600_000;
    if (aw.waves < CH.awakening.waves) {
      q.setMeta.run('immaculate', JSON.stringify(aw));
      journal('immaculate_wave', { faction: by || null, n: aw.waves, total: CH.awakening.waves }, t);
      return;
    }
    awakeningOver(false, b, t, by);
  }
  // Fin de l'éveil : l'Immaculée a repris Garreg-Mach (Rhea revient), ou elle est tombée (bonus de points pour la faction qui l'a vaincue).
  function awakeningOver(returned, b, t, by = null) {
    q.setMeta.run('immaculate', '');
    if (returned) {
      const rhea = q.general.get(CH.lord);
      if (rhea && rhea.status !== 'dead') { q.setGeneralStatus.run('alive', CH.lord); moveGeneral(rhea, CH.seat); }
      q.setGeneralStatus.run('dormant', CH.immaculate);
      journal('immaculate_returned', { faction: b.defender || null }, t);
      for (const c of q.chars.all()) notify(c.user_id, 'immaculate_returned', { faction: b.defender || null });
      return;
    }
    q.setGeneralStatus.run('dead', CH.immaculate);
    q.setGeneralStatus.run('dead', CH.lord);
    if (by && PLAYABLE.has(by)) { q.setMeta.run(`immac:${by}`, '1'); fp(by, 'generals'); }
    const gain = genReward(CH.immaculate);
    for (const { user_id: uid } of q.sideActors.all(b.id, 'defense')) {
      const m = exileMult(uid);
      const paid = { gold: Math.round(gain.gold * m), xp: Math.round(gain.xp * m) };
      grant(uid, gain.gold, gain.xp, 'general');
      cm(uid, 'general');
      notify(uid, 'general_defeated', { general: CH.immaculate, ...paid });
    }
    journal('immaculate_fell', { faction: by || null }, t);
    for (const c of q.chars.all()) notify(c.user_id, 'immaculate_fell', { faction: by || null });
  }

  // Un général meurt (effacé de la carte). Epimenides : les Serpents ne reviennent plus et la faction qui l'a abattu gagne un bonus de points.
  function killGeneral(row, by, territory, t, exhausted = false) {
    q.setGeneralStatus.run('dead', row.gid);
    q.dropVerdict.run(row.gid);
    journal(exhausted ? 'general_exhausted' : 'general_fell', { general: row.gid, faction: by || null, territory }, t);
    if (row.gid === G.serpents.finalBoss) {
      q.setMeta.run('serpents_gone', '1');
      if (by && PLAYABLE.has(by)) q.setMeta.run(`epi:${by}`, '1');
      journal('serpents_gone', { faction: by || null }, t);
      for (const c of q.chars.all()) notify(c.user_id, 'serpents_gone', { faction: by || null });
    }
  }
  // Le général est vaincu : récompense pour ceux qui l'ont battu, puis il meurt ou attend le verdict de ses vainqueurs.
  // Le seigneur a encore des généraux sous sa bannière : il ne meurt pas. Yuri retourne à Garreg-Mach ; les autres rejoignent un allié
  // et, si leur capitale est tombée, ordonnent sa reprise (ralliement de toute la faction).
  const alliesOf = (row) => q.generals.all().filter((g) => g.gid !== row.gid && g.gid !== CH.immaculate && g.faction === row.faction && (g.status === 'alive' || g.status === 'captive') && GEN.has(g.gid));
  function protectLord(row, t, lost = null) {
    const owners = ownersMap();
    const cap = C.capitals[row.faction];
    // Un allié sur un territoire encore tenu par la faction (jamais celui qui vient de tomber).
    const allies = alliesOf(row).filter((g) => g.status === 'alive' && g.territory && g.territory !== lost && owners.get(g.territory) === row.faction);
    const refuge = !cap ? C.homeBases[row.faction] : (allies.find((g) => g.territory === cap)?.territory || allies[0]?.territory || spawnTerritory(row.faction, owners) || C.homeBases[row.faction]);
    if (refuge) moveGeneral(row, refuge);
    journal('lord_escaped', { general: row.gid, faction: row.faction, territory: refuge || null }, t);
    if (cap && ownersMap().get(cap) !== row.faction) {
      q.setMeta.run(`retake:${row.faction}`, '1');
      journal('lord_rally', { general: row.gid, faction: row.faction, territory: cap }, t);
      for (const pl of q.factionPlayers.all(row.faction)) notify(pl.user_id, 'lord_rally', { general: row.gid, territory: cap });
    }
  }
  function defeatGeneral(row, foes, winner, b, t) {
    const gain = genReward(row.gid);
    fp(winner, 'generals');
    for (const uid of foes) {
      const m = exileMult(uid);
      const paid = { gold: Math.round(gain.gold * m), xp: Math.round(gain.xp * m) };
      grant(uid, gain.gold, gain.xp, 'general');
      cm(uid, 'general');
      notify(uid, 'general_defeated', { general: row.gid, ...paid });
    }
    if (row.gid === CH.immaculate) return null; // l'Immaculée ne tombe qu'à son dernier assaut repoussé
    if (row.gid === CH.lord && b.territory === CH.seat && ownersMap().get(CH.seat) !== CH.faction) return awaken(winner, t);
    if (isLord(row.gid) && alliesOf(row).length) return protectLord(row, t, b.territory);
    const cfg = GEN.get(row.gid);
    const spareable = !row.spared && winner && PLAYABLE.has(winner) && winner !== row.faction && (cfg.spare || []).includes(winner);
    const voters = spareable ? q.sideActors.all(b.id, winner === b.attacker ? 'attack' : 'defense').map((r) => r.user_id) : [];
    if (!voters.length) return killGeneral(row, winner, b.territory, t);
    q.setGeneralStatus.run('captive', row.gid);
    q.addVerdict.run(row.gid, winner, b.id, t + G.verdictTurns * TURN_MS);
    journal('general_captured', { general: row.gid, faction: winner, territory: b.territory }, t);
    for (const uid of voters) notify(uid, 'general_verdict', { general: row.gid });
    return null;
  }
  // Bilan d'une bataille pour les généraux : ceux du camp battu sont vaincus, les autres généraux présents sur un territoire perdu reculent.
  function settleGenerals(b, success, defWinner, t) {
    const handled = new Set();
    for (const c of q.generalContribs.all(b.id)) {
      const row = q.general.get(c.gid);
      if (!row || row.status !== 'alive' || (c.side === 'attack') === success) continue;
      handled.add(row.gid);
      if (c.side === 'defense') defeatGeneral(row, q.sideActors.all(b.id, 'attack').map((r) => r.user_id), b.attacker, b, t);
      else defeatGeneral(row, q.sideActors.all(b.id, 'defense').map((r) => r.user_id), defWinner, b, t);
    }
    if (success) {
      // Territoire conquis : tout général du camp vaincu qui s'y trouve, ou dont c'est la maison, est vaincu avec lui
      // (il meurt, ou attend le verdict s'il est épargnable). Jamais de fantôme ni de général sans maison.
      const camps = defenseCamps(b.defender);
      const mine = (row) => camps.includes(row.faction) || row.faction === null; // un indépendant tombe avec son territoire
      const attackers = q.sideActors.all(b.id, 'attack').map((r) => r.user_id);
      for (const row of q.generals.all()) {
        if (row.status !== 'alive' || !GEN.has(row.gid) || !mine(row) || handled.has(row.gid)) continue;
        if (row.territory === b.territory || GEN.get(row.gid).home === b.territory) defeatGeneral(row, attackers, b.attacker, b, t);
      }
    }
  }
  // Verdict des vainqueurs : épargner (le général rejoint leur faction) ou le faire mourir.
  function decideVerdict(gid, spare, t, userId = null) {
    const v = q.verdict.get(gid);
    const row = q.general.get(gid);
    if (!v || !row) return;
    if (spare) {
      q.joinGeneral.run(v.winner, gid);
      q.dropVerdict.run(gid);
      journal('general_spared', { general: gid, faction: v.winner }, t);
      if (userId) {
        cm(userId, 'spare');
        const xp = relSum(relBonuses(userId), 'spareXp'); // Ashe
        if (xp) grant(userId, 0, xp, 'relation');
      }
    } else killGeneral(row, v.winner, row.territory, t);
  }

  // ------------------------------------------------------------ Batailles
  // Une personne présente ou engagée dans une bataille, avec sa lignée de classes et ses effets cumulés.
  function person(row) {
    const path = fx.pathOf(row);
    return { id: row.user_id, faction: row.faction, territory: row.territory || null, classId: row.class, path, effects: fx.effectsOfPath(path), level: renown(row.xp).level };
  }
  // Un joueur correspond-il à un filtre d'effet ? { flying: true } : classe volante ; { lineage: [...] } : une de ces classes dans son arbre.
  const matchesFilter = (f, p) => !f || ((!f.flying || fx.isFlying(p.classId)) && (!f.lineage || p.path.some((c) => f.lineage.includes(c))));

  // ------------------------------------------------------------ Contre-attaque
  // Une défense réussie contre une autre faction jouable rend le territoire insaisissable et donne à sa faction un bonus
  // d'attaque sur les territoires ennemis voisins, pendant `counter.minutes` minutes de jeu.
  const COUNTER_MS = Math.round(C.counter.minutes * TURN_MS / C.turnMinutes);
  const defensesAt = (at) => q.recentDefenses.all(currentCampaign().id, at - COUNTER_MS)
    .map((r) => ({ ...r, winner: r.credit || r.defender }))
    .filter((r) => r.resolved_at <= at && PLAYABLE.has(r.attacker) && PLAYABLE.has(r.winner));
  const counterBonus = (faction) => C.counter.factionBonus?.[faction] ?? C.counter.attackBonus;
  const guardians = C.guardians || {};
  // Camps qui défendent un territoire : son propriétaire et ceux qui le défendent comme le leur.
  const defenseCamps = (owner) => [owner, ...Object.entries(guardians).filter(([, target]) => target === owner).map(([f]) => f)].filter(Boolean);
  // Cette faction défend-elle ce territoire pour un autre (bataille en cours contre le propriétaire) ?
  const guarding = (faction, owner, battle) => !!battle && guardians[faction] === owner && battle.defender === owner;
  // Fin de l'insaisissable d'un territoire (0 s'il ne l'est pas).
  function shieldUntil(territory, owners, t) {
    let end = 0;
    for (const r of defensesAt(t)) if (r.territory === territory && owners.get(territory) === r.defender) end = Math.max(end, r.resolved_at + COUNTER_MS);
    return end > t ? end : 0;
  }
  // La faction attaque-t-elle ce territoire ennemi en contre-attaque (voisin d'un de ses territoires qui vient de repousser une attaque) ?
  const counterOn = (faction, target, owners, at) => PLAYABLE.has(faction) && owners.get(target) !== faction
    && defensesAt(at).some((r) => r.winner === faction && owners.get(r.territory) === r.defender && neighbors(r.territory).includes(target));

  // Force des deux camps dans une bataille, effets de classe compris.
  // Elle dépend de qui est présent sur le territoire et autour à cet instant : on la calcule donc à la demande, pas à l'action.
  // Chances de réussite de l'attaque : force des attaquants / (attaquants + défense). La défense part d'une base proportionnelle
  // à l'importance du territoire, plus un bonus pour les factions non jouables.
  function battleDetail(b) {
    const gens = new Map(q.generals.all().map((g) => [g.gid, g]));
    const rows = [...q.battleRows.all(b.id), ...q.generalContribs.all(b.id).map((c) => ({
      user_id: `g:${c.gid}`, faction: gens.get(c.gid)?.faction || null, side: c.side, power: c.power, kind: 'action', streak: 0,
    }))];
    const T = b.territory;
    const around = new Set([T, ...neighbors(T)]);
    const people = new Map();
    for (const r of q.alivePlayers.all()) people.set(r.user_id, person(r));
    for (const g of gens.values()) if (g.status === 'alive' && g.territory && GEN.has(g.gid)) people.set(`g:${g.gid}`, genPerson(g));
    // Un joueur engagé qui a quitté les lieux garde ses effets propres, mais ne compte plus parmi les présents.
    for (const r of rows) {
      if (people.has(r.user_id)) continue;
      const ch = q.char.get(r.user_id);
      if (ch) people.set(r.user_id, person({ ...ch, territory: null, faction: r.faction }));
    }
    const camp = { attack: [b.attacker].filter(Boolean), defense: defenseCamps(b.defender) };
    const presentOf = (fs, wide, zone = around) => [...people.values()].filter((p) => fs.includes(p.faction) && p.territory && (wide ? zone.has(p.territory) : p.territory === T));
    const here = { attack: presentOf(camp.attack, false), defense: presentOf(camp.defense, false) };
    const near = { attack: presentOf(camp.attack, true), defense: presentOf(camp.defense, true) };
    const boss = C.boss.faction;
    const enemyLevels = (side) => {
      const other = side === 'attack' ? 'defense' : 'attack';
      return [...here[other].map((p) => p.level), ...rows.filter((r) => r.side === other && people.get(r.user_id)).map((r) => people.get(r.user_id).level)];
    };

    // Territoires pris et défenses réussies de chaque faction (calculé une fois, seulement si un Paladin noir est là).
    const winsCache = new Map();
    const winsOf = (f) => { if (!winsCache.has(f)) winsCache.set(f, q.factionWins.get(currentCampaign().id, f, f).n); return winsCache.get(f); };
    // Territoires à portée de deux cases (auras de la Gremory).
    const around2 = new Set(around);
    for (const n of around) for (const m of neighbors(n)) around2.add(m);
    const dist = (id) => (id === T ? 0 : around.has(id) ? 1 : around2.has(id) ? 2 : 9);
    const within2 = { attack: presentOf(camp.attack, true, around2), defense: presentOf(camp.defense, true, around2) };
    const owners0 = ownersMap();
    const exiles = new Set(q.exilesAll.all().map((r) => r.user_id));
    const relCache = new Map();
    const relMemo = (uid) => { if (!relCache.has(uid)) relCache.set(uid, relBonuses(uid)); return relCache.get(uid); };
    const odCache = new Map();
    const odMemo = (uid) => { if (!odCache.has(uid)) odCache.set(uid, overdriveOf(uid)); return odCache.get(uid); };
    const pairMemo = new Map();
    const partnerCache = new Map();
    const partnersOf = (side, f) => {
      const k = `${side}:${f}`;
      if (!partnerCache.has(k)) partnerCache.set(k, [...new Set(rows.filter((x) => x.side === side && x.kind === 'action' && x.faction === f && typeof x.user_id === 'number').map((x) => x.user_id))]);
      return partnerCache.get(k);
    };
    // PV : un combattant blessé frappe moins fort (malus selon ses PV au moment du calcul).
    const hpOnNow = hpOn();
    const hpRowMult = (id) => {
      if (!hpOnNow) return 1;
      if (typeof id === 'string' && id.startsWith('g:')) return hpMult(genHpOf(gens.get(id.slice(2))).frac);
      return hpMult(playerHp(id)?.frac ?? 1);
    };
    // Contre-attaque : évaluée à l'ouverture de la bataille.
    const counter = b.boss_power === 0 && counterOn(b.attacker, T, owners0, b.started_at);
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
          } else if (e.kind === 'conquests') add += Math.min(e.max ?? Infinity, e.pct * winsOf(me.faction));
        }
        // Auras des alliés présents : chaque porteur compte une fois par effet, dans la limite de auraCap.
        // Gremory : ses auras portent jusqu'à deux cases (effet « reach »), et sur son territoire elles gagnent
        // un pourcentage de l'aura de l'allié le plus fort présent (elle comprise).
        let aura = 0;
        for (const s of within2[side]) {
          const reach = Math.max(0, ...s.effects.filter((e) => e.kind === 'reach').map((e) => e.distance || 0));
          const d = dist(s.territory);
          for (const a of s.effects) {
            if (a.kind !== 'aura') continue;
            if (d > Math.max(a.range === 'territory' ? 0 : 1, reach)) continue;
            if (a.targets && !me.path.some((c) => a.targets.includes(c))) continue;
            if (a.except && me.path.includes(a.except)) continue;
            aura += a.pct;
          }
          if (d === 0) {
            const boost = s.effects.find((e) => e.kind === 'auraBoost');
            if (boost) {
              const strongest = Math.max(0, ...allies.map((p) => fx.sumOf(p.effects, 'aura')));
              aura += (boost.pct / 100) * strongest;
            }
          }
        }
        add += Math.min(AURA_CAP, aura);
        // Bonus de soutien des généraux alliés (Edelgard, Ferdinand, Dimitri, Felix, Annette, Mercedes, Petra).
        if (typeof me.id === 'number') add += relPower(relMemo(me.id), { b, side, T, owners: owners0, rows, here, aura, row: r });
        // Soutiens entre joueurs : partenaires du même camp qui combattent du même côté de cette bataille.
        if (typeof me.id === 'number') add += pairPower(me.id, partnersOf(side, r.faction), pairMemo);
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
          const dm = me.effects.find((e) => e.kind === 'darkMage');
          mult *= enemies.length && enemies.every((p) => !p.path.includes('monk')) ? (dm.freeFactor || 3) : (dm.factor || 2);
        }
        // Chevalier sacré : sa puissance est multipliée sur un territoire conquis par les Serpents.
        const hk = me.effects.find((e) => e.kind === 'holyKnight');
        if (hk && b.defender === boss) mult *= hk.conqueredFactor || 1;
        power *= mult;
      }
      if (r.kind === 'action') power *= hpRowMult(r.user_id);
      const exiled = exiles.has(r.user_id);
      power *= capMult(r.faction, owners0) * (exiled ? 1 : lordMult(r.faction, r.side));
      // Overdrive : puissance d'attaque totale, et plus encore contre Garreg-Mach.
      const od = r.side === 'attack' && typeof r.user_id === 'number' ? odCfg(odMemo(r.user_id)) : null;
      if (od) power *= (1 + (od.attackPct || 0) / 100) * (T === CH.seat ? 1 + (od.garregPct || 0) / 100 : 1);
      if (counter && r.side === 'attack') power *= 1 + (exiled ? C.counter.attackBonus : counterBonus(b.attacker)) / 100;
      sums[r.side] += power;
      perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + power);
    }
    // Chevalier sacré en défense : la puissance d'attaque des Serpents est divisée.
    let bossPower = b.boss_power;
    const holy = here.defense.flatMap((p) => p.effects).find((e) => e.kind === 'holyKnight');
    if (holy && bossPower > 0 && b.attacker === boss) bossPower /= holy.bossDivisor || 1;
    if (bossPower > 0 && b.attacker === boss) bossPower *= 1 - Math.min(90, Math.max(0, ...[...who.defense].filter((id) => typeof id === 'number').map((id) => relSum(relMemo(id), 'bossShield')))) / 100; // Hapi
    const attack = bossPower + sums.attack;
    // Capitale d'origine tenue par sa faction : plus elle a de territoires, plus sa capitale est dure à prendre.
    const defense = (C.baseDefense * importance(T) + (C.npcDefense[b.defender] || 0) + sums.defense) * (1 + buildEffect(T, 'defensePct') / 100) * capitalGuard(T, owners0);
    // Bonus bruts de soutien (Hubert en attaque, Dedue en défense) : le meilleur de chaque camp s'ajoute aux chances.
    const rawOf = (side, kind) => Math.max(0, ...[...who[side]].filter((id) => typeof id === 'number').map((id) => relSum(relMemo(id), kind)));
    const raw = attack / (attack + defense) + (b.help || 0) / 100 + (rawOf('attack', 'rawAttack') - rawOf('defense', 'rawDefense')) / 100;
    let chance = Math.min(C.maxChance, Math.max(C.minChance, raw));
    let decisive = null;
    if (C.decisive && raw >= C.decisive) { chance = 1; decisive = 'win'; } else if (C.decisive && raw <= 1 - C.decisive) { chance = 0; decisive = 'lose'; }
    return { chance, decisive, counter, attack, defense, attackers: who.attack.size, defenders: who.defense.size, perUser };
  }
  const battleInfo = (b) => battleDetail(b);

  function startBattle(territory, attacker, defender, t, bossPower = 0, generalId = null, actorId = null) {
    const info = q.insertBattle.run(currentCampaign().id, territory, attacker, defender, bossPower, t, t + C.battleTurns * TURN_MS);
    const id = Number(info.lastInsertRowid);
    if (generalId) q.setBattleGeneral.run(generalId, id);
    // Les garnisons posées avant l'attaque comptent dans la bataille.
    if (defender) q.attachGarrison.run(id, territory, defender, t);
    for (const f of defenseCamps(defender)) for (const p of q.factionPlayers.all(f)) notify(p.user_id, 'territory_attacked', { territory, faction: attacker });
    journal('battle_started', { territory, attacker, defender, battle: id, ...(generalId ? { general: generalId } : {}), ...(actorId ? { actor: actorId } : {}) }, t);
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
    const { chance, decisive } = battleDetail(b);
    const success = roll() < chance;
    q.closeBattle.run(t, success ? 1 : 0, chance, b.id);
    metric(success ? 'battles_attack_won' : 'battles_defense_won', 1);
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
      return { gold: Math.round(gold), xp: Math.round(xp) }; // le malus d'exil est appliqué par grant
    };
    const shown = (uid, pd) => ({ gold: Math.round(pd.gold * exileMult(uid)), xp: Math.round(pd.xp * exileMult(uid)) });
    if (success) {
      q.setOwner.run(b.attacker, iso(), b.territory);
      battleWear(b, true, decisive, t); // PV : après le changement de camp, un défenseur à 0 PV ne réapparaît pas sur le territoire perdu
      q.setMeta.run('conquest', '1'); // les généraux ne partent en campagne qu'après une première conquête
      q.buildClear.run(b.territory); // les constructions ne survivent pas à la conquête
      fp(b.attacker, 'conquests');
      if (ANNEX.has(b.territory)) fp(b.attacker, 'annex');
      if (CAPITALS.has(b.territory) && C.capitals[b.defender] === b.territory) fp(b.attacker, 'capital');
      addGauge(b.attacker, C.gauge.perWin);
      q.dropGarrison.run(b.territory, t);
      journal('territory_taken', { territory: b.territory, faction: b.attacker, from: b.defender, battle: b.id }, t);
      const perkMult = perks(b.attacker).rewardMultiplier || 1; // gains accrus des Loups de cendre, pas pour leurs exilés
      const reward = { gold: C.attackRewards.gold * scale, xp: C.attackRewards.xp * scale };
      const attackers = q.sideUsers.all(b.id, 'attack').map((r) => r.user_id);
      for (const uid of attackers) {
        const m = isExile(uid) ? 1 : perkMult;
        const rbw = relBonuses(uid);
        const paid = payout(uid, { gold: reward.gold * m * (1 + relSum(rbw, 'winGold') / 100), xp: reward.xp * m * (1 + relSum(rbw, 'attackXp') / 100) }, true);
        grant(uid, paid.gold, paid.xp, 'conquest');
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_conquered', { territory: b.territory, ...shown(uid, paid) });
      }
      stealGold(b, attackers);
      // Séries et exploits en solo (missions spéciales) : seules les actions d'attaque ou de défense comptent, pas les renforts payés.
      const atk = q.sideActors.all(b.id, 'attack').map((r) => r.user_id);
      const retake = !!b.defender && b.defender !== b.attacker && startFaction(terr(b.territory)) === b.attacker;
      for (const uid of atk) {
        cm(uid, 'conquest');
        if (b.territory === C.keyTerritory) cm(uid, 'garreg_conquest');
        if (retake) cm(uid, 'retake');
        if (ANNEX.has(b.territory)) cm(uid, 'annex_conquest');
      }
      for (const uid of atk) streak(uid, 'atk_streak', true);
      if (atk.length === 1 && ctx.countStat) ctx.countStat(atk[0], 'solo_attacks');
      for (const { user_id: uid } of q.sideActors.all(b.id, 'defense')) streak(uid, 'def_streak', false);
      // Dernier territoire d'une faction : ceux qui l'ont défendu reçoivent la distinction « Dernier rempart ».
      if (b.defender && PLAYABLE.has(b.defender) && !perks(b.defender).neverOut) {
        const left = ownersMap();
        if (!TERR.some((x) => left.get(x.id) === b.defender)) {
          for (const { user_id: uid } of q.sideUsers.all(b.id, 'defense')) award(uid, 'last_stand');
        }
      }
      if (b.defender) {
        // Les défenseurs présents sur place doivent se replier, sinon ils tombent. Effets des vainqueurs sur ce repli :
        // l'Archer raccourcit le délai, l'Archer d'élite taxe ceux qui échouent.
        const present = [];
        for (const p of q.factionPlayers.all(b.defender)) {
          notify(p.user_id, 'territory_lost', { territory: b.territory, faction: b.attacker });
          if (p.territory === b.territory) present.push(p.user_id);
        }
        forceRetreat(present, b.defender, 1, attackers.flatMap((uid) => effectsOfUser(uid)), t);
      }
      settleGenerals(b, true, null, t);
      generalsWear(b, true, decisive, t);
      if (b.general === CH.immaculate && b.territory === CH.seat && awakening()) awakeningOver(true, b, t);
    } else {
      // Défense assurée en partie par les gardiens du territoire (Loups de cendre pour l'Église) : c'est eux qui en profitent.
      const guard = Object.keys(guardians).find((f) => guardians[f] === b.defender && q.defenderFactions.all(b.id).some((r) => r.faction === f));
      if (guard) q.setCredit.run(guard, b.id);
      battleWear(b, false, decisive, t); // PV : un attaquant à 0 PV est déjà mis hors de combat, il n'a pas à se replier
      // Une attaque ratée a un prix : les attaquants restés sur place doivent se replier à temps, sinon ils tombent (retour plus cher).
      const stuck = q.sideActors.all(b.id, 'attack').map((r) => r.user_id).filter((uid) => {
        const st = q.state.get(uid);
        return st && st.status === 'alive' && st.territory === b.territory;
      });
      forceRetreat(stuck, b.attacker, C.revive.attackerMultiplier ?? 1, q.sideActors.all(b.id, 'defense').flatMap((r) => effectsOfUser(r.user_id)), t);
      settleGenerals(b, false, guard || b.defender, t);
      generalsWear(b, false, decisive, t);
      // Raid des Serpents mené par un général : repoussé, il meurt.
      if (b.general === CH.immaculate) {
        if (b.territory === CH.seat) waveRepelled(b, guard || b.defender, t); // assaut de l'Immaculée repoussé
      } else if (b.general) {
        const gr = q.general.get(b.general);
        if (gr && gr.status === 'alive') defeatGeneral(gr, q.sideActors.all(b.id, 'defense').map((r) => r.user_id), guard || b.defender, b, t);
      }
      journal('attack_repelled', { territory: b.territory, attacker: b.attacker, faction: guard || b.defender, battle: b.id }, t);
      fp(guard || b.defender, 'defenses');
      addGauge(guard || b.defender, C.gauge.perWin);
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'attack')) notify(uid, 'attack_failed', { territory: b.territory });
      for (const { user_id: uid } of q.sideActors.all(b.id, 'attack')) streak(uid, 'atk_streak', false);
      const def = q.sideActors.all(b.id, 'defense').map((r) => r.user_id);
      for (const uid of def) { streak(uid, 'def_streak', true); cm(uid, 'defense'); }
      if (def.length === 1 && ctx.countStat) ctx.countStat(def[0], 'solo_defenses');
      const reward = { gold: C.defenseRewards.gold * scale, xp: C.defenseRewards.xp * scale };
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'defense')) {
        const rbd = relBonuses(uid);
        const paid = payout(uid, { gold: reward.gold * (1 + relSum(rbd, 'winGold') / 100), xp: reward.xp }, false); // Sylvain
        grant(uid, paid.gold + relSum(rbd, 'defenseGold'), paid.xp, 'defense'); // Alois
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_defended', { territory: b.territory, ...shown(uid, paid) });
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
  // Général des Serpents qui mène le raid : 30 % de chances (les autres raids restent des attaques normales). Epimenides, le dernier,
  // ne vient qu'une fois tous les autres tombés, et alors à coup sûr.
  const SERPENT_GENERAL_CHANCE = process.env.GENERAL_CHANCE !== undefined ? Number(process.env.GENERAL_CHANCE) : G.serpents.chance;
  function pickSerpentGeneral() {
    const pool = q.generals.all().filter((g) => g.faction === C.boss.faction && g.status === 'alive' && GEN.has(g.gid));
    const last = G.serpents.finalBoss;
    const others = pool.filter((g) => g.gid !== last);
    if (!others.length) return pool.find((g) => g.gid === last) || null;
    if (genRand() >= SERPENT_GENERAL_CHANCE) return null;
    return others[Math.floor(genRand() * others.length) % others.length];
  }
  function spawnBosses(t) {
    if (q.meta.get('serpents_gone')?.value === '1' || phase(t) !== 'open') return; // Epimenides est tombé, ou la campagne se clôt
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
      const targets = TERR.filter((x) => !ANNEX.has(x.id) && !busy.has(x.id) && PLAYABLE.has(owners.get(x.id)) && !shieldUntil(x.id, owners, t));
      if (!targets.length) return;
      const target = targets[Math.floor(Math.random() * targets.length)];
      const general = pickSerpentGeneral();
      startBattle(target.id, C.boss.faction, owners.get(target.id), t, C.boss.power * importance(target.id) * (general ? GEN.get(general.gid).coef : 1), general ? general.gid : null);
    }
  }

  // ------------------------------------------------------------ Fin de campagne
  // Fin programmée : le dernier jour de fin passé (par défaut le mardi à minuit, heure de Paris). TEST_END_AT la fixe pour les tests.
  function zoneParts(ms, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    const o = Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, p.value]));
    return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour), min: Number(o.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
  }
  const zoneOffset = (ms, tz) => { const p = zoneParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60000) * 60000; };
  function lastScheduledEnd(t) {
    if (process.env.TEST_END_AT !== undefined) return Number(process.env.TEST_END_AT);
    const S = C.schedule;
    if (!S) return 0;
    const tz = S.timezone || 'UTC';
    const p = zoneParts(t, tz);
    let back = (p.wd - S.weekday + 7) % 7;
    if (back === 0 && (p.h < S.hour || (p.h === S.hour && p.min < (S.minute || 0)))) back = 7;
    const guess = Date.UTC(p.y, p.m - 1, p.d - back, S.hour, S.minute || 0);
    return guess - zoneOffset(guess - zoneOffset(guess, tz), tz);
  }
  // La campagne en cours a franchi une heure de fin programmée. Une campagne déjà en cours quand la fonction a été activée
  // ne compte qu'à partir de cet instant (meta schedule_from), pour ne pas se terminer d'un coup.
  function scheduledEnd(t) {
    const from = Number(q.meta.get('schedule_from')?.value || 0);
    const started = Math.max(Date.parse(currentCampaign().started_at) || 0, from);
    const boundary = lastScheduledEnd(t);
    return boundary > started && boundary <= t;
  }

  // Phase de la campagne : open, closing (clôture : plus d'attaque, les combats en cours se terminent) ou break (résultats donnés,
  // pause jusqu'à la réouverture : plus aucune action).
  // Prochaine clôture programmée (le premier jour de clôture après t).
  const nextClose = (t) => { const n = lastScheduledEnd(t + 7 * 86_400_000); return n > t ? n : null; };
  const isFinished = () => q.meta.get(`finished:${currentCampaign().id}`)?.value === '1';
  const phase = (t) => (isFinished() ? 'break' : scheduledEnd(t) ? 'closing' : 'open');
  // Réouverture : le lendemain de la clôture à `reopenHour` (heure du fuseau). TEST_RESET_AT la fixe pour les tests.
  function reopenTime(boundary) {
    if (process.env.TEST_RESET_AT !== undefined) return Number(process.env.TEST_RESET_AT);
    const S = C.schedule;
    const tz = S.timezone || 'UTC';
    const p = zoneParts(boundary, tz);
    const guess = Date.UTC(p.y, p.m - 1, p.d + (S.reopenDayOffset ?? 1), S.reopenHour ?? 6, 0);
    return guess - zoneOffset(guess - zoneOffset(guess, tz), tz);
  }
  function checkEnd(t) {
    if (isFinished()) {
      if (t >= Number(q.meta.get('reset_at')?.value || 0)) startNextCampaign(t);
      return null;
    }
    const owners = ownersMap();
    const main = TERR.filter((x) => !ANNEX.has(x.id));
    const first = owners.get(main[0].id);
    if (PLAYABLE.has(first) && main.every((x) => owners.get(x.id) === first)) return endCampaign(first, 'conquest', owners, t);
    // Parmi les factions qui ont des joueurs, une seule n'est pas hors jeu.
    const withPlayers = q.aliveByFaction.all().map((r) => r.faction).filter((f) => PLAYABLE.has(f));
    const inPlay = withPlayers.filter((f) => !isOut(f));
    if (withPlayers.length >= 2 && inPlay.length <= 1) return endCampaign(inPlay[0] || null, 'elimination', owners, t);
    // Clôture : dès que le dernier combat est terminé, on calcule la fin de campagne ; la réouverture suit (pause entre les deux).
    if (scheduledEnd(t) && !q.openBattles.all().length) {
      finishCampaign(null, 'schedule', owners, t);
      q.setMeta.run('reset_at', String(reopenTime(lastScheduledEnd(t))));
    }
    return null;
  }

  // Points de fin de campagne de chaque faction : territoires, part de la carte, survivants, efficacité des joueurs
  // (score gagné hors exil) et, pour les factions en infériorité, victoires et peu de morts. Les exilés ne comptent pour aucune faction.
  function tally(owners) {
    const cid = currentCampaign().id;
    const main = TERR.filter((x) => !ANNEX.has(x.id));
    const survivors = new Map(q.survivors.all().map((r) => [r.faction, r.n]));
    const scores = q.scoresOf.all(cid);
    const F = C.finale;
    const out = {};
    for (const f of PLAYABLE) {
      const held = main.filter((x) => owners.get(x.id) === f).length;
      const pct = Math.round((held / main.length) * 100);
      const members = scores.filter((r) => r.faction === f);
      const regulars = members.filter((r) => !r.exile_faction);
      const parts = [];
      const add = (key, points) => { if (Math.round(points) > 0) parts.push({ key, points: Math.round(points) }); };
      add('territories', held * (perks(f).pointsMultiplier || 1) * F.territory);
      add('map', ([...(F.mapBonus || [])].filter((b) => pct >= b.pct).pop() || {}).points || 0);
      add('survivors', (survivors.get(f) || 0) * F.survivor);
      add('activity', members.reduce((a, r) => a + r.faction_score, 0) * F.activityRatio);
      // Capitales : la sienne tenue, et celles des autres factions prises.
      const myCap = C.capitals[f];
      const enemyCaps = Object.entries(C.capitals).filter(([g, c]) => g !== f && owners.get(c) === f).length;
      add('capital', (myCap && owners.get(myCap) === f ? F.capitalOwn || 0 : 0) + enemyCaps * (F.capitalEnemy || 0));
      const obj = objectiveStatus(f, owners);
      if (obj && obj.done) add('objective', obj.points);
      if (perks(f).efficiency && F.efficiency) {
        const e = F.efficiency;
        add('attacks', q.attacksWon.get(cid, f).n * e.attackWon);
        add('defenses', q.defensesWon.get(cid, f, f).n * e.defenseWon);
        const deaths = regulars.reduce((a, r) => a + r.deaths, 0);
        add('lowDeaths', regulars.length ? e.lowDeaths.max * Math.max(0, 1 - deaths / regulars.length / e.lowDeaths.deathsPerPlayer) : 0);
      }
      const base = parts.reduce((a, p) => a + p.points, 0);
      // Epimenides ou l'Immaculée abattus par cette faction.
      const mult = Math.round((1 + (q.meta.get(`epi:${f}`) ? G.serpents.pointsBonus || 0 : 0) + (q.meta.get(`immac:${f}`) ? CH.awakening.pointsBonus || 0 : 0)) * 100) / 100;
      out[f] = { held, pct, parts, base, mult, total: Math.round(base * mult) };
    }
    return out;
  }

  // Fin de saison (toutes les `season.campaigns` campagnes) : faction qui a le plus de points sur la saison, meilleurs joueurs, titres.
  const seasonOf = (campaignId) => Math.ceil(campaignId / C.season.campaigns);
  function seasonTable(first, last, currentGained = null) {
    const totals = {};
    for (const row of db.prepare('SELECT id, summary FROM campaigns WHERE id BETWEEN ? AND ? AND summary IS NOT NULL').all(first, last)) {
      try { for (const [f, n] of Object.entries(JSON.parse(row.summary).points || {})) totals[f] = (totals[f] || 0) + n; } catch { /* campagne sans bilan */ }
    }
    if (currentGained) for (const [f, n] of Object.entries(currentGained)) totals[f] = (totals[f] || 0) + n;
    const players = db.prepare(`SELECT s.user_id, sum(s.score) AS score, c.pseudo, c.faction, c.avatar FROM campaign_scores s JOIN characters c ON c.user_id = s.user_id
                                WHERE s.campaign_id BETWEEN ? AND ? GROUP BY s.user_id HAVING sum(s.score) > 0 ORDER BY score DESC, s.user_id LIMIT 10`).all(first, last);
    return { totals, players };
  }
  function endSeason(lastId, gained) {
    const first = lastId - C.season.campaigns + 1;
    const { totals, players } = seasonTable(first, lastId - 1, gained);
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const winner = ranked.length && ranked[0][1] > 0 && (!ranked[1] || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    const withLast = seasonTable(first, lastId).players; // les points de la dernière campagne comptent aussi pour les joueurs
    withLast.slice(0, 3).forEach((r) => award(r.user_id, 'season_champion'));
    if (winner) {
      for (const r of db.prepare(`SELECT s.user_id FROM campaign_scores s JOIN characters c ON c.user_id = s.user_id WHERE s.campaign_id BETWEEN ? AND ? AND c.faction = ?
                                  GROUP BY s.user_id HAVING sum(s.score) > 0`).all(first, lastId, winner)) award(r.user_id, 'season_victor');
    }
    db.prepare('INSERT OR REPLACE INTO seasons (season, data) VALUES (?, ?)').run(seasonOf(lastId), JSON.stringify({ first, last: lastId, winner, totals, players: withLast.map((r) => ({ pseudo: r.pseudo, faction: r.faction, avatar: r.avatar, score: r.score })) }));
    journal('season_ended', { faction: winner, season: seasonOf(lastId) });
  }

  // Clôture : points, récompenses et résultats de chaque participant. La carte ne bouge qu'à la réouverture (startNextCampaign).
  function finishCampaign(winner, reason, owners, t) {
    const detail = tally(owners);
    // Fin programmée : la faction qui a le plus de points l'emporte (égalité : pas de vainqueur).
    if (reason === 'schedule') {
      const ranked = Object.entries(detail).sort((a, b) => b[1].total - a[1].total);
      winner = ranked.length && ranked[0][1].total > 0 && (!ranked[1] || ranked[0][1].total > ranked[1][1].total) ? ranked[0][0] : null;
    }
    const gained = {};
    for (const f of PLAYABLE) {
      gained[f] = detail[f].total + (f === winner ? C.points.win : 0);
      if (gained[f]) q.addPoints.run(f, gained[f]);
    }
    const campaign = currentCampaign();
    // Les meilleurs joueurs de la campagne sont récompensés.
    const podium = q.ranking.all(campaign.id, C.ranking.rewards.length);
    podium.forEach((r, i) => {
      grant(r.user_id, C.ranking.rewards[i], 0, 'ranking');
      notify(r.user_id, 'campaign_rank', { rank: i + 1, gold: C.ranking.rewards[i] });
    });
    // Résultat de chaque participant (fenêtre à la prochaine connexion) et prime d'exil.
    const order = q.ranking.all(campaign.id, 100000).map((r) => r.user_id);
    const standings = Object.entries(detail).map(([f, d]) => ({ faction: f, points: gained[f], pct: d.pct, held: d.held })).sort((a, b) => b.points - a.points);
    for (const r of q.scoresOf.all(campaign.id)) {
      let exileGold = 0;
      if (r.exile_combats > 0 && C.finale.exile?.gold) { exileGold = C.finale.exile.gold; grant(r.user_id, exileGold, 0, 'exile'); }
      const rank = order.indexOf(r.user_id) + 1 || null;
      q.addResult.run(campaign.id, r.user_id, JSON.stringify({
        campaign: campaign.id, reason, winner, faction: r.faction, won: winner === r.faction, exile: r.exile_faction || null,
        factionPoints: gained[r.faction] || 0, parts: detail[r.faction]?.parts || [], mult: detail[r.faction]?.mult || 1,
        win: r.faction === winner ? C.points.win : 0, standings, score: r.score, rank,
        rankGold: rank && rank <= podium.length ? C.ranking.rewards[rank - 1] : 0, exileGold, at: t,
      }));
    }
    // Objectif de faction atteint : prime d'or pour ses participants.
    for (const f of PLAYABLE) {
      const obj = objectiveStatus(f, owners);
      if (!obj || !obj.done || !obj.gold) continue;
      for (const { user_id: uid } of q.participants.all(campaign.id, f)) { grant(uid, obj.gold, 0, 'objective'); notify(uid, 'objective_done', { gold: obj.gold }); }
    }
    // Exploits de fin de campagne (missions spéciales).
    if (ctx.countStat) {
      if (winner) {
        for (const { user_id: uid } of q.participants.all(campaign.id, winner)) {
          ctx.countStat(uid, 'campaigns_won');
          if (reason === 'conquest') ctx.countStat(uid, 'campaigns_conquest');
        }
        const best = q.mvp.get(campaign.id, winner);
        if (best) ctx.countStat(best.user_id, 'campaigns_mvp');
      }
      for (const r of q.ranking.all(campaign.id, 3)) ctx.countStat(r.user_id, 'campaigns_top3');
      for (const r of q.flawless.all(campaign.id)) ctx.countStat(r.user_id, 'campaigns_flawless');
    }
    const top = podium.map((r) => ({ pseudo: r.pseudo, faction: r.faction, avatar: r.avatar, score: r.score }));
    q.setMeta.run('summary', JSON.stringify({ reason, winner, points: gained, detail, top }));
    if (podium[0]) award(podium[0].user_id, 'campaign_mvp');
    if (campaign.id % C.season.campaigns === 0) endSeason(campaign.id, gained);
    for (const c of q.chars.all()) {
      notify(c.user_id, winner ? 'campaign_end' : 'campaign_end_draw', { faction: winner, points: gained[c.faction] || 0 });
    }
    q.setMeta.run(`finished:${campaign.id}`, '1');
    return winner;
  }
  // Réouverture : la carte revient à son état de départ, les généraux reprennent leur poste, une nouvelle campagne commence.
  function startNextCampaign(t) {
    const campaign = currentCampaign();
    let summary = {};
    try { summary = JSON.parse(q.meta.get('summary')?.value || '{}'); } catch { summary = {}; }
    const winner = summary.winner || null;
    q.endCampaign.run(iso(), winner, JSON.stringify(summary), campaign.id);
    // Remise à zéro : carte de départ, plus aucune bataille, tous les joueurs reviennent dans leur capitale, généraux à leur poste.
    for (const x of TERR) q.setOwner.run(startFaction(x), iso(), x.id);
    q.closeAllBattles.run(t);
    q.clearContributions.run();
    q.clearStates.run();
    db.exec('DELETE FROM territory_builds; DELETE FROM pings');
    q.clearFactionMeta.run();
    q.newCampaign.run(iso());
    // PV : activés à la première campagne d'une nouvelle saison (start = 'season').
    const nid = currentCampaign().id;
    if (HP.enabled && HP.start === 'season' && !q.meta.get('hp_from') && (nid - 1) % C.season.campaigns === 0) q.setMeta.run('hp_from', String(nid));
    resetGenerals(t);
    journal('campaign_ended', { faction: winner }, t);
    updateFactions(ownersMap(), t);
    for (const c of q.chars.all()) ensurePlayer(c.user_id);

    return { winner };
  }
  function endCampaign(winner, reason, owners, t) {
    const w = finishCampaign(winner, reason, owners, t);
    startNextCampaign(t);
    return { winner: w, reason };
  }

  // Met le monde à jour : batailles arrivées à terme, replis expirés, factions hors jeu, mini-boss, fin de campagne.
  let ticking = false;
  let lastFreeze = 0;
  let lastGenTick = 0;
  const GEN_TICK_MS = process.env.GEN_TICK_MS !== undefined ? Number(process.env.GEN_TICK_MS) : 1000; // 0 en test : réaction immédiate
  function tick(t = Date.now()) {
    if (ticking) return;
    ticking = true;
    try {
      currentCampaign();
      for (const b of q.dueBattles.all(t)) resolveBattle(b, t);
      if (phase(t) === 'break') { checkEnd(t); return; } // pause entre deux campagnes : plus rien ne bouge
      for (const { user_id: uid, retreat_penalty: snipe, fall_mult: mult } of q.retreatDue.all(t)) woundPlayer(uid, mult || 1, snipe || 0, t);
      q.dropGarrison.run('', t);
      updateFactions(ownersMap(), t);
      // Généraux vaincus dont les vainqueurs n'ont pas tranché à temps : ils meurent.
      for (const v of q.verdicts.all()) if (v.expires_at <= t) decideVerdict(v.gid, false, t);
      // L'IA des généraux ne tourne qu'une fois par seconde au plus : tick() est appelé à chaque requête.
      if (t - lastGenTick >= GEN_TICK_MS) { lastGenTick = t; generalsTick(t); }
      // Les joueurs tombés dont la faction est hors jeu gardent leur série de missions du jour.
      if (ctx.freezeStreaks && t - lastFreeze > 60_000) {
        lastFreeze = t;
        const ids = q.deadPlayers.all().filter((r) => isOut(r.faction)).map((r) => r.user_id);
        if (ids.length) ctx.freezeStreaks(ids);
      }
      spawnBosses(t);
      hpTick(t);
      churchTick(t);
      overdriveTick(t);
      // Quelques heures avant la clôture : tout le monde est prévenu que tout se joue maintenant (notification et push).
      const nc = phase(t) === 'open' ? nextClose(t) : null;
      const cidW = currentCampaign().id;
      if (nc && nc - t <= (C.endWarningHours || 0) * 3_600_000 && !q.meta.get(`warned:${cidW}`)) {
        q.setMeta.run(`warned:${cidW}`, '1');
        for (const c of q.chars.all()) notify(c.user_id, 'campaign_ending', { hours: C.endWarningHours });
      }
      checkEnd(t);
    } finally { ticking = false; }
  }

  // ------------------------------------------------------------ Ce que voit le joueur
  function playerPayload(userId, t = Date.now()) {
    const regenGold = ensurePlayer(userId) ? collectRegen(userId, t) : 0;
    const ps = ensurePlayer(userId);
    if (!ps) return null;
    const s = settle(ps, t);
    const ch = q.char.get(userId);
    const side = ps.exile_faction || ch.faction; // camp pour lequel il combat
    return {
      now: t, // heure du serveur, pour que l'app affiche des comptes à rebours justes
      territory: ps.territory || null, status: ps.status, retreatUntil: ps.retreat_until,
      actions: s.actions, maxActions: s.max, nextActionAt: s.next,
      regenGold, // or gagné à l'instant grâce à Hilda (actions rendues par le compteur)
      hp: hpPayload(userId, ps, ch, t), // points de vie (null tant qu'ils ne sont pas activés)
      rewardDebuff: ps.reward_debuff || 0, // actions restantes pendant lesquelles les récompenses sont réduites (téléportation)
      faction: side, exile: !!ps.exile_faction,
      factionOut: isOut(side), reviveAsked: !!ps.revive_asked,
      // Pour la fenêtre de game over : campagne, nombre de chutes dans cette campagne, coût de retour majoré (attaque ratée).
      campaignId: currentCampaign().id, deaths: q.myDeaths.get(currentCampaign().id, userId)?.deaths || 0, fallMult: ps.fall_mult || 1,
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
    // Joueurs présents sur chaque territoire. Les factions à « hiddenAtBase » (Loups de cendre) sont invisibles sur leur base
    // tant que leurs membres n'y attaquent ni n'y défendent, sauf pour le joueur lui-même.
    const hidden = new Set(Object.entries(C.underdogs).filter(([, u]) => u.hiddenAtBase).map(([f]) => `${f}:${C.homeBases[f]}`));
    const engaged = new Set(q.engaged.all(t).map((r) => `${r.user_id}:${r.territory}`));
    const hpOnMap = hpOn();
    const ordered = new Set(q.orders.all().map((o) => o.gid));
    const occupants = new Map();
    const presence = new Map();
    const seat = (territory, o) => {
      if (!occupants.has(territory)) { occupants.set(territory, []); presence.set(territory, {}); }
      occupants.get(territory).push(o);
      if (o.faction) presence.get(territory)[o.faction] = (presence.get(territory)[o.faction] || 0) + 1;
    };
    for (const r of q.occupants.all()) {
      if (r.user_id !== userId && !r.exile_faction && hidden.has(`${r.faction}:${r.territory}`) && !engaged.has(`${r.user_id}:${r.territory}`)) continue;
      seat(r.territory, { pseudo: r.pseudo, avatar: r.avatar, faction: r.faction, class: r.class, level: renown(r.xp).level, me: r.user_id === userId, retreating: r.status === 'retreating', hp: hpOnMap ? hpPct(playerHp(r.user_id) || { frac: 1 }) : null });
    }
    // Les généraux se voient comme les joueurs ; ceux des factions cachées sur leur base ne se montrent que s'ils y combattent.
    const genEngaged = new Set(q.generalsEngaged.all().map((r) => `${r.gid}:${r.territory}`));
    for (const g of q.generals.all()) {
      if (g.status !== 'alive' || !g.territory || !GEN.has(g.gid) || g.faction === C.boss.faction) continue;
      if (hidden.has(`${g.faction}:${g.territory}`) && !genEngaged.has(`${g.gid}:${g.territory}`)) continue;
      seat(g.territory, { pseudo: GEN.get(g.gid).name, gid: g.gid, avatar: GEN.get(g.gid).avatar, faction: g.faction || null, class: genClass(g.gid), level: genLevel(g), me: false, retreating: false, general: true, lord: isLord(g.gid), hp: hpOnMap ? hpPct(genHpOf(g)) : null, ordered: ordered.has(g.gid) });
    }
    for (const list of occupants.values()) list.sort((a, b) => (b.me - a.me) || (b.level - a.level) || a.pseudo.localeCompare(b.pseudo));
    const campaign = currentCampaign();
    const ch = q.char.get(userId);
    const here = q.state.get(userId)?.territory;
    const side = effFaction(userId);
    return {
      now: t,
      turnMs: TURN_MS,
      campaign: { id: campaign.id, startedAt: campaign.started_at, phase: phase(t), closesAt: nextClose(t), resetAt: isFinished() ? Number(q.meta.get('reset_at')?.value || 0) : null },
      player: playerPayload(userId, t),
      homeBases: C.homeBases,
      capitals: C.capitals,
      // Église : croisade en cours (faction visée) et éveil de l'Immaculée (assauts repoussés, prochain assaut).
      // Overdrive en cours pour ce joueur (base ou plus) et sa fin (la clôture).
      overdrive: (() => { const lvl = overdriveOf(userId, t); return lvl ? { level: lvl, until: nextClose(t), ...odCfg(lvl) } : null; })(),
      church: (() => { const aw = awakening(); return { crusade: crusadeOf(), awakening: aw ? { holder: aw.holder, waves: aw.waves, total: CH.awakening.waves, next: aw.next } : null }; })(),
      journalLatest: q.latestEvent.get()?.id || 0,
      lord: lordPayload(side),
      objective: side ? objectiveStatus(side, owners) : null,
      // Signalements de ma faction (les plus récents d'abord).
      pings: side ? q.pingsOf.all(campaign.id, side, t - C.pings.minutes * 60000, C.pings.max).map((x) => ({ id: x.id, territory: x.territory, kind: x.kind, pseudo: x.pseudo, at: x.created_at, mine: x.user_id === userId })) : [],
      guardians,
      // hire : bataillon en attaque ; fortify : fortification en défense ; build : bâtiments (moitié prix pour un Prêtre) ; teleport : Évêque noir.
      costs: {
        hire: Math.round(C.hire.gold * (isExile(userId) ? 1 : hireFactor(side)) * hireDiscount(userId, here)), fortify: ch ? Math.round(fortifyCost(userId) * hireDiscount(userId, here)) : C.hire.gold, hireMax: C.hire.perBattle,
        build: ch ? C.build.costs.map((c) => Math.round(c * buildFactor(userId, here))) : C.build.costs, buildMax: C.build.maxLevel,
        revive: side ? Math.round(reviveCost(side) * (q.state.get(userId)?.fall_mult || 1) * reviveFactor(userId)) : C.revive.gold,
        teleport: ch ? (effectsOfUser(userId).find((e) => e.kind === 'teleport')?.gold ?? null) : null,
      },
      // Avantages de ma faction, s'il y en a (affichés dans le menu).
      perks: side && C.underdogs[side] ? { ...C.underdogs[side], powerBonus: Math.round(powerBonus(side) * 10) / 10 } : null,
      points: Object.fromEntries(q.points.all().map((r) => [r.faction, r.points])),
      ranking: rankingPayload(userId),
      // Exil possible pour un joueur dont la faction est hors jeu (factions qui peuvent l'accueillir).
      exile: exileInfo(userId),
      // Alliés tombés qui demandent qu'on paie leur retour.
      fallen: side ? q.fallen.all(side, userId).map((r) => ({ id: r.user_id, pseudo: r.pseudo, cost: Math.round(reviveCost(side) * r.fall_mult) })) : [],
      // Généraux vaincus que ma faction peut épargner ou faire mourir.
      verdicts: q.verdicts.all().filter((v) => q.verdictVoter.get(v.battle_id, userId, v.winner)).map((v) => {
        const g = q.general.get(v.gid);
        return { id: v.gid, name: GEN.get(v.gid)?.name, avatar: GEN.get(v.gid)?.avatar, faction: g?.faction || null, class: genClass(v.gid), level: genLevel(g), until: v.expires_at };
      }),
      territories: TERR.map((x) => {
        const b = battles.get(x.id);
        const info = b ? battleInfo(b) : null;
        return {
          id: x.id, name: x.name, neighbors: neighbors(x.id), faction: owners.get(x.id) || null,
          untouchableUntil: shieldUntil(x.id, owners, t) || null,
          counter: !!side && counterOn(side, x.id, owners, t),
          counterPct: side ? counterBonus(side) : 0,
          capitalBonus: Math.round((capitalGuard(x.id, owners) - 1) * 100), build: buildOf(x.id), importance: importance(x.id), annex: ANNEX.has(x.id), players: presence.get(x.id) || {}, occupants: occupants.get(x.id) || [],
          battle: b ? {
            attacker: b.attacker, defender: b.defender, boss: b.boss_power > 0, endsAt: b.ends_at,
            general: b.general ? { id: b.general, name: GEN.get(b.general)?.name, avatar: GEN.get(b.general)?.avatar } : null,
            counter: info.counter, chance: Math.round(info.chance * 100), decisive: info.decisive, attackers: info.attackers, defenders: info.defenders,
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
    if (phase(t) === 'break') throw new HttpError(409, 'campaign_break');
    collectRegen(user.id, t); // payer les actions rendues avant de les dépenser
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
  // Réactions possibles du joueur à un événement du journal (voir POST /api/journal/react), chacune avec sa limite de validité :
  // soutenir et envoyer de l'aide tant que la bataille est en cours, féliciter pendant `cheerMinutes` après le résultat.
  function reactionKinds(userId, e) {
    let p;
    try { p = JSON.parse(e.params) || {}; } catch { return []; }
    const side = effFaction(userId);
    if (!side || !p.battle) return [];
    const b = q.battleById.get(p.battle);
    const open = !!b && !b.resolved_at;
    const mine = !!q.myContribution.get(p.battle, userId);
    const cheerUntil = e.created_at + (C.reactions.cheerMinutes || 60) * 60000;
    if ((e.type === 'territory_taken' || e.type === 'attack_repelled') && p.faction === side && !mine && Date.now() < cheerUntil) return [{ k: 'cheer', until: cheerUntil }];
    if (e.type === 'battle_started' && p.attacker === side && p.actor && p.actor !== userId && open) return [{ k: 'support', until: b.ends_at }];
    if (e.type === 'rally' && p.faction === side && p.actor !== userId && open) return [{ k: 'help', until: b.ends_at }];
    return [];
  }
  const reviveFactor = (userId) => Math.max(0, 1 - relSum(relBonuses(userId), 'reviveDiscount') / 100);
  const reviveCost = (faction) => (perks(faction).freeRevive ? 0 : C.revive.gold);
  // Quitter un territoire où l'on combat annule ses actions d'attaque ou de défense en cours (sans remboursement) :
  // on ne peut pas peser sur plusieurs batailles à la fois. Sans `leave`, le serveur demande confirmation (409 engaged).
  function leaveEngagements(userId, territory, leave, t) {
    if (!q.myEngagements.get(userId, territory, t).n) return 0;
    if (!leave) throw new HttpError(409, 'engaged');
    return q.dropEngagements.run(userId, territory).changes;
  }
  // Remet en jeu un joueur tombé, à l'endroit où sa faction réapparaît.
  function revive(userId, faction) {
    const spot = spawnTerritory(faction, ownersMap());
    if (!spot) throw new HttpError(409, 'faction_out');
    q.setTerritory.run(spot, userId);
    return spot;
  }

  // ------------------------------------------------------------ Overdrive
  function overdriveOn(t = Date.now()) {
    if (phase(t) !== 'open') return false;
    const nc = nextClose(t);
    return !!nc && nc - t <= OD.hours * 3_600_000;
  }
  // Faction minoritaire : moins de territoires que la moyenne des factions jouables encore en jeu.
  function minorityFaction(f, owners = ownersMap()) {
    const alive = [...PLAYABLE].filter((x) => !isOut(x));
    if (!alive.includes(f)) return false;
    const held = (x) => TERR.filter((tr) => !ANNEX.has(tr.id) && owners.get(tr.id) === x).length;
    const avg = alive.reduce((a, x) => a + held(x), 0) / alive.length;
    return held(f) < avg;
  }
  function overdriveOf(userId, t = Date.now()) {
    if (typeof userId !== 'number' || !overdriveOn(t)) return null;
    const ps = q.state.get(userId);
    const ch = q.char.get(userId);
    if (!ps || !ch || ps.exile_faction || isOut(ch.faction)) return null;
    return minorityFaction(ch.faction) ? 'plus' : 'base';
  }
  // Début de l'Overdrive : notification à chaque joueur concerné (et push, reportée à la fin des heures calmes).
  function overdriveTick(t) {
    const cid = currentCampaign().id;
    if (!overdriveOn(t) || q.meta.get(`overdrive:${cid}`)) return;
    q.setMeta.run(`overdrive:${cid}`, '1');
    journal('overdrive', { hours: OD.hours }, t);
    for (const c of q.chars.all()) {
      const lvl = overdriveOf(c.user_id, t);
      if (lvl) notify(c.user_id, lvl === 'plus' ? 'overdrive_plus' : 'overdrive', { hours: OD.hours, ...odCfg(lvl) });
    }
  }

  // ------------------------------------------------------------ Relations avec les généraux
  // Niveaux de soutien (C à S) gagnés en offrant des fleurs ou en envoyant des lettres aux généraux alliés à son camp.
  // Le niveau S n'est possible qu'avec un seul général : les autres plafonnent juste en dessous.
  const R = {
    levels: [{ id: 'C', points: 250 }, { id: 'C+', points: 400 }, { id: 'B', points: 600 }, { id: 'B+', points: 850 }, { id: 'A', points: 1050 }, { id: 'A+', points: 1400 }, { id: 'S', points: 2000 }],
    gifts: { compliment: { actions: 1, gold: 0, points: 1 }, flower: { actions: 1, gold: 50, points: 5 }, letter: { actions: 1, gold: 200, points: 25 }, present: { actions: 0, gold: 0, points: 10, sameTerritory: true, cooldownMinutes: 60 } },
    exclude: ['immaculate'],
    ...(config.relations || {}),
  };
  const S_POINTS = R.levels[R.levels.length - 1].points;
  const relLevel = (points) => [...R.levels].reverse().find((l) => points >= l.points)?.id || null;
  const relPoints = (userId) => new Map(db.prepare('SELECT gid, points FROM relations WHERE user_id = ?').all(userId).map((r) => [r.gid, r.points]));
  // Généraux qu'on peut fréquenter : ni Serpents, ni exclus (l'Immaculée).
  const befriendable = (gid) => GEN.has(gid) && GEN.get(gid).faction !== C.boss.faction && !R.exclude.includes(gid);
  // Liste de son camp : les généraux vivants alliés d'abord, puis ceux de la faction qui sont morts, captifs ou passés ailleurs (grisés).
  function relationsPayload(userId) {
    const side = effFaction(userId);
    const pts = relPoints(userId);
    const sWith = [...pts].find(([, n]) => n >= S_POINTS)?.[0] || null;
    const rows = q.generals.all().filter((g) => befriendable(g.gid));
    const item = (g, state) => {
      const cfg = GEN.get(g.gid);
      const n = pts.get(g.gid) || 0;
      return { id: g.gid, name: cfg.name, avatar: cfg.avatar, faction: g.faction || null, origin: cfg.faction || null, state, lord: isLord(g.gid), class: genClass(g.gid), territory: g.territory || null, points: n, level: relLevel(n) };
    };
    const allied = rows.filter((g) => side && g.status === 'alive' && g.faction === side).map((g) => item(g, 'allied'));
    const gone = rows.filter((g) => side && GEN.get(g.gid).faction === side && !(g.status === 'alive' && g.faction === side))
      .map((g) => item(g, g.status === 'dead' ? 'dead' : g.status === 'captive' ? 'captive' : g.status === 'dormant' ? 'dormant' : 'joined'));
    const byName = (a, b) => (b.lord - a.lord) || (b.points - a.points) || a.name.localeCompare(b.name);
    const ps = q.state.get(userId);
    const readyAt = Object.fromEntries(Object.entries(R.gifts).filter(([, gf]) => gf.cooldownMinutes).map(([k, gf]) => [k, (q.giftCooldown.get(userId, k)?.at || 0) + gf.cooldownMinutes * 60_000]));
    return { side, levels: R.levels, gifts: R.gifts, sWith, here: ps && ps.status === 'alive' ? ps.territory : null, readyAt, generals: [...allied.sort(byName), ...gone.sort(byName)], players: playerRelList(userId) };
  }
  // Bonus de soutien : un joueur profite du bonus de chaque général vivant allié à son camp, selon son niveau de soutien avec lui
  // (relations.bonuses : kind, values pour C … S, et des précisions selon le bonus : territory, partner, partnerLevel, allies).
  const RB = R.bonuses || {};
  const levelIdx = (points) => R.levels.reduce((i, l, k) => (points >= l.points ? k : i), -1);
  function relBonuses(userId) {
    const side = effFaction(userId);
    if (!side || typeof userId !== 'number') return [];
    const pts = relPoints(userId);
    const out = [];
    for (const g of q.generals.all()) {
      const def = RB[g.gid];
      if (!def || g.status !== 'alive' || g.faction !== side) continue;
      const i = levelIdx(pts.get(g.gid) || 0);
      if (i < 0) continue;
      // Lien croisé (Annette et Mercedes) : avec ce niveau de soutien avec le partenaire, partnerValues s'ajoute au bonus
      // (sans partnerValues, le bonus entier dépend du partenaire).
      const partnerOk = !def.partner || levelIdx(pts.get(def.partner) || 0) >= R.levels.findIndex((l) => l.id === (def.partnerLevel || 'C'));
      if (!partnerOk && !def.partnerValues) continue;
      const extra = def.partnerValues && partnerOk ? def.partnerValues[i] || 0 : 0;
      out.push({ ...def, gid: g.gid, value: def.values[i] + extra, base: def.values[i], extra, partnerOk, ...(def.hp ? { hpValue: def.hp[i] || 0 } : {}) });
    }
    return out;
  }
  const relSum = (list, kind, filter = () => true) => list.filter((b) => b.kind === kind && filter(b)).reduce((a, b) => a + b.value, 0);
  const relRoll = () => (process.env.TEST_REL_ROLL !== undefined ? Number(process.env.TEST_REL_ROLL) : Math.random());
  // Réduction du prix des bataillons et fortifications (Caspar partout, Petra sur son territoire).
  const hireDiscount = (userId, here) => {
    const rb = relBonuses(userId);
    return Math.max(0, 1 - relSum(rb, 'hireDiscount') / 100) * Math.max(0, 1 - relSum(rb, 'territoryBoost', (b) => b.territory === here) / 100);
  };
  // Prix des bâtiments : Prêtre (et ses classes suivantes) moitié prix, Petra sur son territoire, Lorenz partout.
  const buildFactor = (userId, here) => {
    const rb = relBonuses(userId);
    return productOf(effectsOfUser(userId), 'buildCost', 'factor') * Math.max(0, 1 - relSum(rb, 'territoryBoost', (x) => x.territory === here) / 100) * Math.max(0, 1 - relSum(rb, 'buildDiscount') / 100);
  };
  // Dorothea : avec au moins `allies` alliés sur place (joueurs ou généraux), une chance de ne pas consommer l'action et de rendre des PV.
  function saveAction(userId, here, side) {
    const rb = relBonuses(userId);
    const def = rb.find((b) => b.kind === 'saveAction');
    if (!def) return false;
    const players = db.prepare(`SELECT COUNT(*) AS n FROM player_state ps JOIN characters c ON c.user_id = ps.user_id
      WHERE ps.territory = ? AND ps.status = 'alive' AND ps.user_id <> ? AND COALESCE(ps.exile_faction, c.faction) = ?`).get(here, userId, side).n;
    const gens = q.generals.all().filter((g) => g.status === 'alive' && g.territory === here && g.faction === side).length;
    if (players + gens < (def.allies || 2) || relRoll() * 100 >= relSum(rb, 'saveAction')) return false;
    giveActions(userId, 1);
    if (hpOn() && def.hpValue) healPlayer(userId, def.hpValue); // et quelques PV rendus
    return true;
  }
  // Bonus de puissance d'une action de combat (en %), selon la bataille : x = { b, side, T, owners, rows, here, aura, row }.
  function relPower(rb, x) {
    if (!rb.length) return 0;
    const { b, side, T, owners, rows, here, aura, row } = x;
    const mine = row.faction;
    const other = side === 'attack' ? 'defense' : 'attack';
    const atk = side === 'attack';
    let add = 0;
    for (const r of rb) {
      const k = r.kind;
      const ok = (k === 'vsChurch' && (b.attacker === CH.faction || b.defender === CH.faction))
        || (k === 'withGeneral' && (rows.some((w) => w.user_id === `g:${r.gid}` && w.side === side) || here[side].some((p) => p.id === `g:${r.gid}`)))
        || (k === 'nearChurch' && [T, ...neighbors(T)].some((n) => owners.get(n) === CH.faction))
        || (k === 'annexAttack' && atk && ANNEX.has(T))
        || (k === 'partnerAttack' && atk)
        || (k === 'partnerDefense' && !atk)
        || k === 'allPower'
        || ((k === 'territoryBoost' || k === 'territoryPower') && r.territory === T)
        || (k === 'zoneDefense' && !atk && (T === r.territory || neighbors(r.territory).includes(T)))
        || (k === 'homeDefense' && !atk && startFaction(terr(T)) === mine)
        || (k === 'outnumbered' && here[side].length < here[other].length)
        || (k === 'auraBoost' && aura > 0)
        || (k === 'crowdPower' && new Set(rows.filter((w) => w.side === side && typeof w.user_id === 'number' && w.user_id !== row.user_id).map((w) => w.user_id)).size >= 3)
        || (k === 'lateStrike' && row.created_at >= b.ends_at - 2 * TURN_MS)
        || (k === 'capitalAttack' && atk && CAPITALS.has(T))
        || (k === 'flankAttack' && atk && neighbors(T).filter((n) => owners.get(n) === mine).length >= 2)
        || (k === 'crusadeAttack' && atk && b.defender && crusadeOf() === b.defender)
        || (k === 'emptyAttack' && atk && !here.defense.length);
      if (ok) add += r.value;
    }
    return add;
  }

  // Liste de tous les bonus et malus actifs d'un joueur : classes, soutiens, faction, seigneur, capitale, exil, blessure, Overdrive.
  function modsOf(userId) {
    const ch = q.char.get(userId);
    const ps = q.state.get(userId);
    if (!ch) return [];
    const out = [];
    const side = effFaction(userId);
    const exiled = !!ps?.exile_faction;
    for (const id of fx.pathOf(ch)) if (config.classes.find((c) => c.id === id)?.effectText) out.push({ type: 'class', class: id, tone: 'buff' });
    const pts = relPoints(userId);
    for (const b of relBonuses(userId)) out.push({ type: 'support', general: b.gid, kind: b.kind, value: b.value, base: b.base, extra: b.extra || 0, hp: b.hpValue || 0, territory: b.territory || null, partner: b.partner || null, partnerLevel: b.partnerLevel || null, level: relLevel(pts.get(b.gid) || 0), tone: 'buff' });
    const links = side ? playerRelList(userId).filter((x) => x.level && x.faction === side) : [];
    if (links.length) out.push({ type: 'playerSupport', n: links.length, names: links.slice(0, 3).map((x) => x.pseudo).join(', '), cap: RP.bonus.capPct, tone: 'buff' });
    const od = overdriveOf(userId);
    if (od) out.push({ type: 'overdrive', level: od, ...odCfg(od), tone: 'buff' });
    if (side && !exiled) {
      const pk = perks(side);
      if (pk.outnumberedMax) out.push({ type: 'perk', perk: 'outnumbered', n: Math.round(powerBonus(side) * 10) / 10, max: pk.outnumberedMax, tone: 'buff' });
      for (const k of ['neverOut', 'autoRetreat', 'freeRevive', 'efficiency']) if (pk[k]) out.push({ type: 'perk', perk: k, tone: 'buff' });
      if (pk.rewardMultiplier > 1) out.push({ type: 'perk', perk: 'rewards', n: pk.rewardMultiplier, tone: 'buff' });
      if (pk.pointsMultiplier > 1) out.push({ type: 'perk', perk: 'points', n: pk.pointsMultiplier, tone: 'buff' });
      if (pk.hiddenAtBase) out.push({ type: 'perk', perk: 'hidden', place: C.homeBases[side], tone: 'buff' });
      if (activeBuff(side)) out.push({ type: 'lord', faction: side, until: buffUntil(side), tone: 'buff' });
    }
    if (side && capitalLost(side, ownersMap())) out.push({ type: 'capitalLost', pct: C.capital.lossPct || 0, tone: 'debuff' });
    if (exiled) out.push({ type: 'exile', pct: Math.round((1 - (C.exile.rewardMultiplier ?? 1)) * 100), tone: 'debuff' });
    if ((ps?.reward_debuff || 0) > 0) out.push({ type: 'rewardDebuff', n: ps.reward_debuff, tone: 'debuff' });
    if (ps?.status === 'retreating') out.push({ type: 'retreating', until: ps.retreat_until, tone: 'debuff' });
    if (ps?.status === 'dead') out.push({ type: 'wounded', tone: 'debuff' });
    if (ps && ps.status !== 'dead' && hpOn()) { const h = playerHp(userId, ps, ch); const m = h ? hpMalus(h.frac) : 0; if (m) out.push({ type: 'hpLow', pct: m, hp: hpPct(h), tone: 'debuff' }); }
    return out;
  }
  // Autres sources : ce que les autres apportent à une unité là où elle se trouve (auras des alliés proches, malus des ennemis
  // présents, constructions, capitale, appel à l'aide, insaisissable, contre-attaque). Même calcul que dans les batailles.
  function otherSources(me, faction, T, t = Date.now()) {
    if (!T || !faction) return null;
    const owners = ownersMap();
    const people = [];
    for (const r of q.alivePlayers.all()) if (r.territory) people.push({ ...person(r), name: q.char.get(r.user_id)?.pseudo || '' });
    for (const g of q.generals.all()) if (g.status === 'alive' && g.territory && GEN.has(g.gid)) people.push({ ...genPerson(g), name: GEN.get(g.gid).name });
    const others = people.filter((x) => x.id !== me.id);
    const around = new Set([T, ...neighbors(T)]);
    const around2 = new Set(around);
    for (const n of around) for (const m of neighbors(n)) around2.add(m);
    const dist = (id) => (id === T ? 0 : around.has(id) ? 1 : around2.has(id) ? 2 : 9);
    const allies = others.filter((x) => x.faction === faction && around2.has(x.territory));
    const alliesHere = people.filter((x) => x.faction === faction && x.territory === T);
    const enemiesHere = others.filter((x) => x.faction && x.faction !== faction && x.territory === T);
    const items = [];
    // Auras des alliés (portée, classes visées, Gremory), plafonnées comme en bataille.
    let aura = 0;
    const auraFrom = new Set();
    for (const a of allies) {
      const reach = Math.max(0, ...a.effects.filter((e) => e.kind === 'reach').map((e) => e.distance || 0));
      const d = dist(a.territory);
      for (const e of a.effects) {
        if (e.kind !== 'aura' || d > Math.max(e.range === 'territory' ? 0 : 1, reach)) continue;
        if (e.targets && !me.path.some((c) => e.targets.includes(c))) continue;
        if (e.except && me.path.includes(e.except)) continue;
        aura += e.pct;
        auraFrom.add(a.name);
      }
      if (d === 0) {
        const boost = a.effects.find((e) => e.kind === 'auraBoost');
        if (boost) { aura += (boost.pct / 100) * Math.max(0, ...alliesHere.map((x) => fx.sumOf(x.effects, 'aura'))); auraFrom.add(a.name); }
      }
    }
    aura = Math.round(Math.min(AURA_CAP, aura) * 10) / 10;
    if (aura > 0) items.push({ type: 'auras', pct: aura, from: [...auraFrom], tone: 'buff' });
    // Malus des ennemis présents : un même effet ne compte qu'une fois.
    const cut = { attack: 0, defense: 0 };
    const cutFrom = { attack: new Set(), defense: new Set() };
    for (const side of ['attack', 'defense']) {
      const seen = new Set();
      for (const en of enemiesHere) {
        for (const d of en.effects) {
          const key = d.id || `${d.kind}:${d.target}:${d.pct}:${JSON.stringify(d.filter || {})}`;
          if (d.kind !== 'debuff' || seen.has(key) || (d.target !== 'both' && d.target !== side) || !matchesFilter(d.filter, me)) continue;
          seen.add(key);
          cut[side] += d.pct;
          cutFrom[side].add(en.name);
        }
      }
    }
    for (const side of ['attack', 'defense']) if (cut[side]) items.push({ type: 'enemyDebuff', side, pct: cut[side], from: [...cutFrom[side]], tone: 'debuff' });
    // Territoire : constructions, capitale, bataille en cours, insaisissable.
    const mineHere = owners.get(T) === faction;
    const bld = buildOf(T);
    if (bld && mineHere) {
      const spec = C.build.specs[bld.spec] || {};
      items.push({ type: 'building', spec: bld.spec, level: bld.level, pct: (spec.defensePct || spec.goldPct || spec.xpPct || spec.hpRegen || 0) * bld.level, tone: 'buff' });
    }
    const guard = Math.round((capitalGuard(T, owners) - 1) * 100);
    if (guard > 0 && mineHere) items.push({ type: 'capitalGuard', pct: guard, tone: 'buff' });
    const b = q.openBattle.get(T);
    if (b && b.help) {
      const mySide = b.attacker === faction ? 1 : -1;
      items.push({ type: 'rallyHelp', pct: b.help * mySide, tone: b.help * mySide > 0 ? 'buff' : 'debuff' });
    }
    const shield = shieldUntil(T, owners, t);
    if (shield && mineHere) items.push({ type: 'shield', until: shield, tone: 'buff' });
    if (PLAYABLE.has(faction)) {
      const targets = TERR.filter((x) => counterOn(faction, x.id, owners, t)).length;
      if (targets) items.push({ type: 'counter', pct: counterBonus(faction), n: targets, tone: 'buff' });
    }
    return { attackPct: Math.round((aura - cut.attack) * 10) / 10, defensePct: Math.round((aura - cut.defense) * 10) / 10, items };
  }
  function playerOthers(userId) {
    const ps = q.state.get(userId);
    const ch = q.char.get(userId);
    if (!ps || !ch || ps.status === 'dead' || !ps.territory) return null;
    return otherSources(person({ ...ch, user_id: userId, territory: ps.territory, faction: effFaction(userId) }), effFaction(userId), ps.territory);
  }
  function genModsOf(row) {
    const out = [];
    for (const id of genPath(row.gid)) if (config.classes.find((c) => c.id === id)?.effectText) out.push({ type: 'class', class: id, tone: 'buff' });
    if (isLord(row.gid)) out.push({ type: 'lordGen', tone: 'buff' });
    if (row.faction && PLAYABLE.has(row.faction) && activeBuff(row.faction)) out.push({ type: 'lord', faction: row.faction, until: buffUntil(row.faction), tone: 'buff' });
    if (row.faction && PLAYABLE.has(row.faction) && capitalLost(row.faction, ownersMap())) out.push({ type: 'capitalLost', pct: C.capital.lossPct || 0, tone: 'debuff' });
    if (row.status === 'alive' && hpOn()) { const h = genHpOf(row); const m = hpMalus(h.frac); if (m) out.push({ type: 'hpLow', pct: m, hp: hpPct(h), tone: 'debuff' }); }
    return out;
  }

  // Offrir une fleur ou envoyer une lettre : 1 action et de l'or, à un général vivant allié à son camp.
  function giveGift(userId, ps, gid, kind, t) {
    const gift = R.gifts[kind];
    if (!gift || !befriendable(gid)) throw new HttpError(400, 'invalid_action');
    const g = q.general.get(gid);
    if (!g || g.status !== 'alive' || g.faction !== effFaction(userId)) throw new HttpError(409, 'not_allied');
    const pts = relPoints(userId);
    const cur = pts.get(gid) || 0;
    const sElsewhere = [...pts].some(([id, n]) => id !== gid && n >= S_POINTS);
    const cap = sElsewhere ? S_POINTS - 1 : S_POINTS;
    if (cur >= cap) throw new HttpError(409, sElsewhere && cur < S_POINTS ? 'support_s_taken' : 'support_max');
    // Cadeau sur place : il faut être vivant sur le territoire du général, et une fois par heure.
    if (gift.sameTerritory && (ps.status !== 'alive' || ps.territory !== g.territory)) throw new HttpError(409, 'not_here');
    if (gift.cooldownMinutes && t < (q.giftCooldown.get(userId, kind)?.at || 0) + gift.cooldownMinutes * 60_000) throw new HttpError(429, 'gift_cooldown');
    if (settle(ps, t).actions < (gift.actions || 0)) throw new HttpError(409, 'no_actions');
    if (!pay(userId, gift.gold || 0, 'gift')) throw new HttpError(409, 'not_enough_gold');
    for (let i = 0; i < (gift.actions || 0); i += 1) spend(q.state.get(userId), t);
    const next = Math.min(cap, cur + gift.points);
    db.prepare(`INSERT INTO relations (user_id, gid, points, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, gid) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`).run(userId, gid, next, t);
    if (gift.cooldownMinutes) q.setGiftCooldown.run(userId, kind, t);
    metric(`gift:${kind}`, 1);
    return { general: gid, kind, gained: next - cur, points: next, level: relLevel(next), up: relLevel(next) !== relLevel(cur) };
  }

  // ------------------------------------------------------------ Relations entre joueurs
  // Une jauge partagée par paire de joueurs (ce que l'un offre fait monter le niveau des deux), plafonnée à `players.maxLevel` (A+).
  // Même offrandes qu'avec les généraux, sans autre limite que leur prix (le cadeau sur place : une fois par paire toutes les 30 min).
  // Celui qui reçoit peut « Dire merci » une fois (24 h) : +pct % des points de l'offrande. Bonus : quand deux joueurs du même camp
  // combattent dans la même bataille, du même côté, chacun gagne bonus.values[niveau] % de puissance (capPct au total).
  const RP = {
    maxLevel: 'A+', gifts: R.gifts, thanks: { pct: 20, min: 1, hours: 24 }, bonus: { values: [], capPct: 10, heal: [] }, closest: 4,
    ...(R.players || {}),
  };
  const RP_CAP = R.levels.find((l) => l.id === RP.maxLevel)?.points || S_POINTS;
  const pair = (u, v) => (u < v ? [u, v] : [v, u]);
  const pairPoints = (u, v) => (u === v ? 0 : q.pairGet.get(...pair(u, v))?.points || 0);
  function addPairPoints(u, v, n, t) {
    const cur = pairPoints(u, v);
    const next = Math.min(RP_CAP, cur + n);
    q.pairSet.run(...pair(u, v), next, t);
    return { before: cur, after: next, gained: next - cur };
  }
  function playerRelList(userId) {
    return q.pairsOf.all(userId, userId, userId).map((r) => {
      const ch = q.char.get(r.other);
      const prof = ch ? q.profileOf.get(ch.pseudo) : null;
      return ch ? { pseudo: ch.pseudo, avatar: prof?.avatar || null, faction: effFaction(r.other) || ch.faction, class: ch.class, points: r.points, level: relLevel(r.points) } : null;
    }).filter(Boolean).sort((a, b) => b.points - a.points || a.pseudo.localeCompare(b.pseudo));
  }
  const findPlayer = (pseudo) => (pseudo ? q.profileOf.get(String(pseudo)) : null);
  function playerRelationPayload(userId, other, t = Date.now()) {
    const n = pairPoints(userId, other.user_id);
    const me = q.state.get(userId);
    const them = q.state.get(other.user_id);
    const presentGift = RP.gifts.present;
    const last = presentGift?.cooldownMinutes ? q.lastPlayerGift.get(userId, other.user_id, 'present')?.at || 0 : 0;
    return {
      pseudo: other.pseudo, avatar: other.avatar, faction: effFaction(other.user_id) || other.faction, class: other.class, points: n, level: relLevel(n),
      levels: R.levels.filter((l) => l.points <= RP_CAP), cap: RP_CAP, gifts: RP.gifts, bonus: RP.bonus,
      sameCamp: !!effFaction(userId) && effFaction(userId) === effFaction(other.user_id),
      together: !!me && !!them && me.status === 'alive' && them.status === 'alive' && me.territory === them.territory,
      presentReadyAt: presentGift?.cooldownMinutes ? last + presentGift.cooldownMinutes * 60_000 : 0,
    };
  }
  function givePlayerGift(userId, ps, other, kind, t) {
    const gift = RP.gifts[kind];
    if (!gift) throw new HttpError(400, 'invalid_action');
    if (!other || other.user_id === userId) throw new HttpError(409, 'invalid_action');
    const cur = pairPoints(userId, other.user_id);
    if (cur >= RP_CAP) throw new HttpError(409, 'support_max');
    if (gift.sameTerritory) {
      const them = q.state.get(other.user_id);
      if (!ps || ps.status !== 'alive' || !them || them.status !== 'alive' || them.territory !== ps.territory) throw new HttpError(409, 'not_together');
    }
    if (gift.cooldownMinutes && t < (q.lastPlayerGift.get(userId, other.user_id, kind)?.at || 0) + gift.cooldownMinutes * 60_000) throw new HttpError(429, 'gift_cooldown');
    if ((gift.actions || 0) > 0 && (!ps || settle(ps, t).actions < gift.actions)) throw new HttpError(409, 'no_actions');
    if (!pay(userId, gift.gold || 0, 'gift')) throw new HttpError(409, 'not_enough_gold');
    for (let i = 0; i < (gift.actions || 0); i += 1) spend(q.state.get(userId), t);
    const r = addPairPoints(userId, other.user_id, gift.points, t);
    const id = Number(q.addPlayerGift.run(userId, other.user_id, kind, r.gained, t).lastInsertRowid);
    const me = q.char.get(userId);
    notify(other.user_id, 'player_gift', { pseudo: me.pseudo, kind, points: r.gained, gift: id, level: relLevel(r.after) });
    metric(`pgift:${kind}`, 1);
    return { pseudo: other.pseudo, kind, gained: r.gained, points: r.after, level: relLevel(r.after), up: relLevel(r.after) !== relLevel(r.before) };
  }
  function thankGift(userId, giftId, t) {
    const g = q.playerGift.get(Number(giftId) || 0);
    if (!g || g.to_id !== userId) throw new HttpError(404, 'not_found');
    if (g.thanked) throw new HttpError(409, 'already_thanked');
    if (t > g.at + RP.thanks.hours * 3_600_000) throw new HttpError(409, 'thanks_expired');
    if (q.thankGift.run(g.id).changes !== 1) throw new HttpError(409, 'already_thanked');
    const n = Math.max(RP.thanks.min || 0, Math.round(((g.points || 0) * (RP.thanks.pct || 0)) / 100));
    const r = addPairPoints(userId, g.from_id, n, t);
    const me = q.char.get(userId);
    const giver = q.char.get(g.from_id);
    notify(g.from_id, 'player_thanks', { pseudo: me.pseudo, points: r.gained });
    return { pseudo: giver?.pseudo || '', gained: r.gained, points: r.after, level: relLevel(r.after) };
  }
  // État « Dire merci » des offrandes reçues récemment (pour les boutons des notifications).
  function giftStates(userId, t = Date.now()) {
    const out = {};
    for (const g of q.giftsTo.all(userId, t - RP.thanks.hours * 3_600_000)) out[g.id] = g.thanked ? 'thanked' : 'open';
    return out;
  }
  // Bonus de combat entre joueurs : partenaires du même camp, du même côté, dans la même bataille (actions de combat).
  function pairPower(uid, partners, memo) {
    let add = 0;
    for (const v of partners) {
      if (v === uid) continue;
      const key = uid < v ? `${uid}:${v}` : `${v}:${uid}`;
      if (!memo.has(key)) memo.set(key, pairPoints(uid, v));
      const i = levelIdx(memo.get(key));
      if (i >= 0) add += RP.bonus.values[Math.min(i, RP.bonus.values.length - 1)] || 0;
    }
    return Math.min(RP.bonus.capPct || 0, add);
  }
  const pairHeal = (u, v) => { const i = levelIdx(pairPoints(u, v)); return i >= 0 ? RP.bonus.heal?.[Math.min(i, (RP.bonus.heal || []).length - 1)] || 0 : 0; };
  // Les proches d'un joueur (généraux et joueurs confondus) ou d'un général (joueurs).
  function closestOfPlayer(userId) {
    const gens = [...relPoints(userId)].filter(([gid, n]) => n > 0 && GEN.has(gid))
      .map(([gid, n]) => ({ type: 'general', id: gid, name: GEN.get(gid).name, avatar: GEN.get(gid).avatar, points: n, level: relLevel(n) }));
    const pls = playerRelList(userId).map((x) => ({ type: 'player', id: x.pseudo, name: x.pseudo, avatar: x.avatar, points: x.points, level: x.level }));
    return [...gens, ...pls].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, RP.closest);
  }
  const closestOfGeneral = (gid) => q.genFans.all(gid, RP.closest).map((r) => ({ type: 'player', id: r.pseudo, name: r.pseudo, avatar: r.avatar, points: r.points, level: relLevel(r.points) }));

  const routes = {
    'GET /api/relations/player': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      if (!q.char.get(user.id)) throw new HttpError(409, 'no_character');
      const other = findPlayer(new URL(req.url, 'http://x').searchParams.get('pseudo'));
      if (!other || other.user_id === user.id) throw new HttpError(404, 'not_found');
      send(res, 200, playerRelationPayload(user.id, other));
    },
    'POST /api/relations/player/gift': async (req, res) => {
      const { pseudo, kind } = await readJson(req);
      const { user, ps, t } = actor(req);
      const other = findPlayer(pseudo);
      const gift = givePlayerGift(user.id, ps, other, String(kind || ''), t);
      reply(res, user, { gift, relation: playerRelationPayload(user.id, other, t), relations: relationsPayload(user.id) });
    },
    'POST /api/relations/thanks': async (req, res) => {
      const { gift } = await readJson(req);
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      send(res, 200, { thanks: thankGift(user.id, gift, Date.now()) });
    },
    // Donner un ordre à un général de son camp (niveau de soutien suffisant, un seul ordre à la fois), ou annuler le sien.
    'POST /api/general/order': async (req, res) => {
      const { general, kind, target, cancel } = await readJson(req);
      const { user, owners, t } = actor(req);
      const row = q.general.get(String(general || ''));
      const ord = row ? q.orderOf.get(row.gid) : null;
      if (cancel) {
        if (!ord || ord.user_id !== user.id) throw new HttpError(409, 'invalid_action');
        q.dropOrder.run(row.gid);
      } else {
        const block = commandBlock(user.id, row);
        if (block) throw new HttpError(409, block === 'level' ? 'order_level' : block === 'camp' ? 'not_allied' : 'invalid_action');
        if (ord) throw new HttpError(409, 'general_busy');
        if (!['attack', 'defend', 'move'].includes(kind) || !terr(target)) throw new HttpError(400, 'invalid_action');
        if (!orderTargets(row, owners)[kind].includes(target)) throw new HttpError(409, 'order_target');
        q.addOrder.run(row.gid, user.id, kind, target, t, t + orderMs());
        journal('general_order', { general: row.gid, kind, territory: target, pseudo: q.char.get(user.id).pseudo, faction: row.faction }, t);
        metric(`order:${kind}`, 1);
      }
      reply(res, user, { general: { id: row.gid, ...orderPayload(user.id, q.general.get(row.gid)) } });
    },
    'GET /api/relations': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      if (!q.char.get(user.id)) throw new HttpError(409, 'no_character');
      send(res, 200, relationsPayload(user.id));
    },
    'POST /api/relations/gift': async (req, res) => {
      const { general, kind } = await readJson(req);
      const { user, ps, t } = actor(req);
      const gift = giveGift(user.id, ps, String(general || ''), String(kind || ''), t);
      reply(res, user, { gift, relations: relationsPayload(user.id) });
    },
    // Se déplacer vers un territoire voisin (1 action, sauf déplacement gratuit : Chevalier pégase et Chevalier faucon).
    'POST /api/move': async (req, res) => {
      const { to, leave } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (!NEIGHBORS.get(ps.territory)?.has(to)) throw new HttpError(409, 'not_neighbor');
      if (!canEnter(ch.faction, to, owners)) throw new HttpError(409, 'cannot_enter');
      // Paladin noir : rejoindre sans action une bataille menée par sa faction sur un territoire ennemi voisin, une fois par bataille.
      const dest = q.openBattle.get(to);
      const raid = dest && owners.get(to) !== ch.faction && (dest.attacker === ch.faction || dest.defender === ch.faction)
        && effectsOfUser(user.id).some((e) => e.kind === 'enemyMove') && !q.freeMoveUsed.get(dest.id, user.id);
      // Il faut au moins une action pour tenter un déplacement ; il peut alors ne rien coûter.
      if (!raid && settle(ps, t).actions < 1) throw new HttpError(409, 'no_actions');
      const cancelled = leaveEngagements(user.id, ps.territory, leave === true, t);
      if (raid) q.addFreeMove.run(dest.id, user.id);
      const free = raid || moveRoll() * 100 < freeMoveChance(user.id) + relSum(relBonuses(user.id), 'freeMove'); // Judith
      const bonus = free ? 0 : spend(ps, t);
      q.setTerritory.run(to, user.id);
      q.tickDebuff.run(user.id);
      onEvent(user.id, 'move');
      // Territoire ennemi : tenu par une autre faction, et ni refuge de la faction ni territoire qu'elle garde.
      const ruler = owners.get(to);
      if (ruler && ruler !== ch.faction && C.homeBases[ch.faction] !== to && guardians[ch.faction] !== ruler) onEvent(user.id, 'enemy_move');
      reply(res, user, { bonus, free, cancelled });
    },

    // Agir sur le territoire où l'on se trouve.
    // attack, defend, gather : 1 action. hire : renfort payé en or (bataillon en attaque, fortification en défense), sans action.
    'POST /api/act': async (req, res) => {
      const { action, spec, target } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      const here = ps.territory;
      const owner = owners.get(here) || null;
      const battle = q.openBattle.get(here);
      // Série d'actions de combat sur un même territoire (Combattant) : nombre d'actions précédentes d'affilée.
      const streak = ps.streak_territory === here ? ps.streak_count : 0;
      let bonus = 0;
      const relFx = []; // effets de soutien déclenchés, affichés au joueur
      const rb = relBonuses(user.id);
      const relGold = (kind, gold) => { if (gold > 0) { grant(user.id, gold, 0, 'relation'); relFx.push({ kind, gold }); } };
      // Ingrid : rejoindre une bataille où un allié a déjà agi, la première fois.
      const joinAlly = (b, side) => {
        if (!b || q.myContribution.get(b.id, user.id)) return;
        if (db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE battle_id = ? AND side = ? AND user_id <> ? AND kind = 'action'").get(b.id, side, user.id).n) relGold('joinGold', relSum(rb, 'joinGold'));
      };
      const homeXp = () => { const xp = relSum(rb, 'homeXp', (x) => x.territory === here); if (xp) { grant(user.id, 0, xp, 'relation'); relFx.push({ kind: 'homeXp', xp }); } };
      if (action === 'attack') {
        if (owner === ch.faction || guardians[ch.faction] === owner) throw new HttpError(409, 'invalid_action');
        if (battle && battle.attacker !== ch.faction) throw new HttpError(409, 'battle_busy');
        if (shieldUntil(here, owners, t)) throw new HttpError(409, 'untouchable');
        if (phase(t) === 'closing') throw new HttpError(409, 'campaign_closing');
        bonus = spend(ps, t);
        const b = battle || startBattle(here, ch.faction, owner, t, 0, null, user.id);
        joinAlly(battle, 'attack');
        if (streak >= 1) relGold('streakGold', relSum(rb, 'streakGold')); // Bernadetta
        q.setStreak.run(here, streak + 1, user.id);
        onEvent(user.id, 'attack_action');
        cm(user.id, 'combat');
        q.addContribution.run(b.id, here, user.id, ch.faction, 'attack', power(ch), t, null, 'action', streak);
        score(user.id, C.ranking.combat);
        addGauge(ch.faction, C.gauge.perAction);
        if (relRoll() * 100 < relSum(rb, 'gaugeBoost')) addGauge(ch.faction, C.gauge.perAction); // Claude
        onEvent(user.id, 'combat');
        if (ps.exile_faction) { onEvent(user.id, 'exile_combat'); q.addExileCombat.run(currentCampaign().id, user.id); }
        q.tickDebuff.run(user.id);
      } else if (action === 'defend') {
        if (owner !== ch.faction && !guarding(ch.faction, owner, battle)) throw new HttpError(409, 'invalid_action');
        bonus = spend(ps, t);
        joinAlly(battle, 'defense');
        if (streak >= 1) relGold('streakGold', relSum(rb, 'streakGold')); // Bernadetta
        homeXp(); // Monica
        // Pendant une bataille, l'action renforce la défense ; sinon elle pose une garnison qui tient le temps d'une bataille.
        q.setStreak.run(here, streak + 1, user.id);
        onEvent(user.id, 'defend_action');
        cm(user.id, 'combat');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, 'defense', power(ch), t,
          battle ? null : t + C.battleTurns * TURN_MS, 'action', streak);
        score(user.id, C.ranking.combat);
        addGauge(ch.faction, C.gauge.perAction);
        if (relRoll() * 100 < relSum(rb, 'gaugeBoost')) addGauge(ch.faction, C.gauge.perAction); // Claude
        onEvent(user.id, 'combat');
        if (ps.exile_faction) { onEvent(user.id, 'exile_combat'); q.addExileCombat.run(currentCampaign().id, user.id); }
        q.tickDebuff.run(user.id);
      } else if (action === 'gather') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle) throw new HttpError(409, 'battle_here');
        bonus = spend(ps, t);
        const m = 1 + relSum(rb, 'territoryBoost', (x) => x.territory === here) / 100; // Petra (le malus d'exil passe par grant)
        grant(user.id, Math.round(C.gather.gold * m * (1 + buildEffect(here, 'goldPct') / 100)), Math.round(C.gather.xp * m * (1 + buildEffect(here, 'xpPct') / 100)), 'gather');
        homeXp(); // Monica
        score(user.id, C.ranking.gather);
        onEvent(user.id, 'gather');
        q.tickDebuff.run(user.id);
      } else if (action === 'build') {
        // Construire ou améliorer sur son territoire, hors bataille : une spécialité par territoire, 1 action et de l'or.
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle) throw new HttpError(409, 'battle_here');
        const cur = buildOf(here);
        const use = cur ? cur.spec : spec;
        if (!C.build.specs[use] || (cur && spec && spec !== cur.spec)) throw new HttpError(cur ? 409 : 400, cur ? 'build_spec' : 'invalid_action');
        if (C.build.specs[use].hpRegen && !hpOn()) throw new HttpError(409, 'invalid_action'); // Infirmerie : seulement avec les PV
        const level = cur ? cur.level : 0;
        if (level >= C.build.maxLevel) throw new HttpError(409, 'build_max');
        if (settle(ps, t).actions < 1) throw new HttpError(409, 'no_actions');
        const price = Math.round(C.build.costs[level] * buildFactor(user.id, here)); // Prêtre, Petra, Lorenz
        if (!pay(user.id, price, 'build')) throw new HttpError(409, 'not_enough_gold');
        bonus = spend(ps, t);
        q.buildSet.run(here, use, level + 1);
        homeXp(); // Monica
        score(user.id, C.ranking.gather);
        onEvent(user.id, 'build');
        cm(user.id, 'build');
        q.tickDebuff.run(user.id);
      } else if (action === 'hire') {
        // Sur son territoire : fortification (moitié prix pour le Prêtre, plus efficace pour l'Évêque).
        // Ailleurs : bataillon, seulement dans une bataille lancée par sa faction.
        const side = owner === ch.faction || guarding(ch.faction, owner, battle) ? 'defense' : 'attack';
        if (side === 'attack' && (!battle || battle.attacker !== ch.faction)) throw new HttpError(409, 'invalid_action');
        const already = battle ? q.hiredInBattle.get(user.id, battle.id).n : q.hiredGarrison.get(user.id, here, t).n;
        if (already >= C.hire.perBattle) throw new HttpError(409, 'hire_limit');
        const cost = Math.round((side === 'defense' ? fortifyCost(user.id) : C.hire.gold * (ch.home !== ch.faction ? 1 : hireFactor(ch.faction))) * hireDiscount(user.id, here)); // Caspar, Petra
        const strength = side === 'defense' ? fortifyPower(user.id) : C.hire.power;
        if (!pay(user.id, cost, 'hire')) throw new HttpError(409, 'not_enough_gold');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, side, strength, t,
          battle ? null : t + C.battleTurns * TURN_MS, 'hire', 0);
        score(user.id, C.ranking.combat);
        if (side === 'attack') onEvent(user.id, 'battalion');
      } else if (action === 'heal') {
        // Soigner (classes de soin) : 1 action, un allié présent sur le même territoire (joueur ou général), ou soi-même à moitié.
        if (!hpOn()) throw new HttpError(409, 'invalid_action');
        const amount = healOf(ch.class);
        if (!amount) throw new HttpError(409, 'invalid_action');
        const side = effFaction(user.id);
        let heal = null;
        if (!target || target === ch.pseudo) {
          const mine = playerHp(user.id, ps, ch);
          if (mine.cur >= mine.max) throw new HttpError(409, 'hp_full');
          bonus = spend(ps, t);
          heal = { name: ch.pseudo, hp: healPlayer(user.id, amount * (HP.selfFactor ?? 0.5)), self: true };
        } else if (String(target).startsWith('g:')) {
          const g = q.general.get(String(target).slice(2));
          if (!g || g.status !== 'alive' || g.territory !== here || g.faction !== side || !GEN.has(g.gid)) throw new HttpError(409, 'heal_target');
          const gh = genHpOf(g);
          if (gh.cur >= gh.max) throw new HttpError(409, 'hp_full');
          bonus = spend(ps, t);
          heal = { name: GEN.get(g.gid).name, hp: healGeneral(g, amount) };
        } else {
          const other = q.hpHere.all(here, side).find((r) => r.pseudo === target && r.user_id !== user.id);
          if (!other) throw new HttpError(409, 'heal_target');
          const oh = playerHp(other.user_id);
          if (!oh || oh.cur >= oh.max) throw new HttpError(409, 'hp_full');
          bonus = spend(ps, t);
          heal = { name: other.pseudo, hp: healPlayer(other.user_id, amount + pairHeal(user.id, other.user_id)) };
          notify(other.user_id, 'healed_by', { pseudo: ch.pseudo, hp: heal.hp });
        }
        if (!heal.self && HP.healXp) grant(user.id, 0, HP.healXp, 'heal');
        score(user.id, C.ranking.gather);
        onEvent(user.id, 'heal');
        metric('heals', 1);
        q.tickDebuff.run(user.id);
        relFx.push({ kind: 'healed', name: heal.name, hp: heal.hp });
      } else if (action === 'vial') {
        // Fiole : de l'or contre quelques PV, sans action, quelques fois par jour.
        if (!hpOn()) throw new HttpError(409, 'invalid_action');
        const vh = playerHp(user.id, ps, ch);
        if (vh.cur >= vh.max) throw new HttpError(409, 'hp_full');
        const left = vialsLeft(ps, t);
        if (left < 1) throw new HttpError(409, 'vial_limit');
        if (!pay(user.id, HP.vial.gold, 'vial')) throw new HttpError(409, 'not_enough_gold');
        const day = vialDay(t);
        q.setVials.run(day, (ps.vial_day === day ? ps.vial_n : 0) + 1, user.id);
        relFx.push({ kind: 'vial', hp: healPlayer(user.id, HP.vial.hp), left: left - 1 });
      } else throw new HttpError(400, 'invalid_action');
      // Dorothea : l'action peut ne pas être consommée.
      if (['attack', 'defend', 'gather', 'build'].includes(action) && saveAction(user.id, here, ch.faction)) relFx.push({ kind: 'saveAction' });
      else if (action === 'gather' && relRoll() * 100 < relSum(rb, 'gatherSave')) { giveActions(user.id, 1); relFx.push({ kind: 'saveAction' }); } // Cyril
      reply(res, user, { bonus, relFx });
    },

    // Téléportation (Évêque noir) : vers un territoire de sa faction ou voisin d'un territoire de sa faction, contre de l'or,
    // sans dépenser d'action. Les récompenses des actions suivantes sont ensuite réduites ; se téléporter à nouveau renouvelle l'effet.
    'POST /api/teleport': async (req, res) => {
      const { to, leave } = await readJson(req);
      const { user, ps, ch, owners, t } = actor(req);
      mustBeAlive(ps);
      const tp = effectsOfUser(user.id).find((e) => e.kind === 'teleport');
      if (!tp) throw new HttpError(409, 'invalid_action');
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (to === ps.territory) throw new HttpError(409, 'invalid_action');
      if (!canEnter(ch.faction, to, owners)) throw new HttpError(409, 'cannot_enter');
      if (q.myEngagements.get(user.id, ps.territory, t).n && leave !== true) throw new HttpError(409, 'engaged');
      if (!pay(user.id, tp.gold, 'teleport')) throw new HttpError(409, 'not_enough_gold');
      leaveEngagements(user.id, ps.territory, true, t);
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
      if (!battle || (battle.attacker !== ch.faction && battle.defender !== ch.faction && !guarding(ch.faction, battle.defender, battle))) throw new HttpError(409, 'invalid_action');
      if (q.addRally.run(battle.id, user.id).changes !== 1) throw new HttpError(409, 'rally_done');
      const boost = relSum(relBonuses(user.id), 'rallyHelp'); // Ignatz
      if (boost) q.addHelp.run(battle.attacker === ch.faction ? boost : -boost, battle.id);
      for (const p of q.factionPlayers.all(ch.faction)) {
        if (p.user_id !== user.id) notify(p.user_id, 'rally', { pseudo: ch.pseudo, territory: ps.territory });
      }
      journal('rally', { pseudo: ch.pseudo, faction: ch.faction, territory: ps.territory, battle: battle.id, actor: user.id }, t);
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
      const mult = ps.fall_mult || 1; // x2 après une attaque ratée
      if (mode === 'gold') {
        const cost = Math.round(reviveCost(ch.faction) * mult * reviveFactor(user.id)); // Marianne
        if (!pay(user.id, cost, 'revive')) throw new HttpError(409, 'not_enough_gold');
        revive(user.id, ch.faction);
      } else if (mode === 'renown') {
        const level = renown(ch.xp).level;
        if (level < 1) throw new HttpError(409, 'no_renown');
        const cost = Math.round(xpForLevel(level) * mult);
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
      const cost = Math.round(reviveCost(ch.faction) * (target.fall_mult || 1));
      if (!pay(user.id, cost, 'revive')) throw new HttpError(409, 'not_enough_gold');
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

    // Verdict sur un général vaincu : épargné (il rejoint ma faction) ou mort. Réservé à ceux qui ont combattu pour les vainqueurs.
    'POST /api/general/verdict': async (req, res) => {
      const { general, spare } = await readJson(req);
      const { user, t } = actor(req);
      const v = typeof general === 'string' ? q.verdict.get(general) : null;
      if (!v || !q.verdictVoter.get(v.battle_id, user.id, v.winner)) throw new HttpError(409, 'invalid_action');
      decideVerdict(general, spare === true, t, user.id);
      reply(res, user);
    },

    // Le joueur a lu le résultat de la dernière campagne.
    'POST /api/campaign/seen': async (req, res) => {
      await readJson(req);
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      q.markResultSeen.run(user.id);
      send(res, 200, { ...ctx.mePayload(user) });
    },

    // Profil public d'un joueur (?pseudo=) ou d'un général (?general=).
    'GET /api/profile': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      const u = new URL(req.url, 'http://x');
      const gid = u.searchParams.get('general');
      if (gid) {
        const g = q.general.get(gid);
        const cfg = GEN.get(gid);
        if (!g || !cfg) throw new HttpError(404, 'not_found');
        send(res, 200, {
          type: 'general', id: gid, name: cfg.name, avatar: cfg.avatar, faction: g.faction || null, origin: cfg.faction || null, home: cfg.home || null,
          territory: g.territory || null, path: cfg.path, class: genClass(gid), level: genLevel(g), status: g.status, spared: !!g.spared,
          spare: cfg.spare || [], coef: cfg.coef, lord: isLord(gid), mods: genModsOf(g),
          closest: closestOfGeneral(gid), ...orderPayload(user.id, g),
          hp: hpOn() && g.status === 'alive' ? (() => { const h = genHpOf(g); return { hp: h.cur, max: h.max, pct: hpPct(h) }; })() : null,
          others: g.status === 'alive' && g.territory ? otherSources(genPerson(g), g.faction, g.territory) : null,
        });
        return;
      }
      const ch = q.profileOf.get(String(u.searchParams.get('pseudo') || ''));
      if (!ch) throw new HttpError(404, 'not_found');
      const ps = q.state.get(ch.user_id);
      const cid = currentCampaign().id;
      const sc = q.myScore.get(cid, ch.user_id)?.score || 0;
      send(res, 200, {
        type: 'player', pseudo: ch.pseudo, avatar: ch.avatar, faction: ch.faction, exile: ps?.exile_faction || null, territory: ps?.territory || null, class: ch.class, path: fx.pathOf(ch),
        level: renown(ch.xp).level, birthday: ch.birthday, score: sc, rank: sc > 0 ? q.betterScores.get(cid, sc).n + 1 : null,
        distinctions: distinctionsOf(ch.user_id), status: ps?.status || null, me: ch.user_id === user.id, mods: modsOf(ch.user_id), others: playerOthers(ch.user_id),
        hp: hpOn() && ps && ps.status !== 'dead' ? (({ hp, max, pct }) => ({ hp, max, pct }))(hpOfPlayer(ch.user_id)) : null,
        closest: closestOfPlayer(ch.user_id),
        relation: ch.user_id !== user.id && q.char.get(user.id) ? (() => { const n = pairPoints(user.id, ch.user_id); return { points: n, level: relLevel(n) }; })() : null,
      });
    },

    // Bilan personnel de la campagne en cours, et totaux à vie.
    'GET /api/impact': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      const cid = currentCampaign().id;
      const ev = Object.fromEntries(q.cmProgress.all(cid, user.id).map((r) => [r.event, r.count]));
      const row = db.prepare('SELECT score, faction_score, deaths, exile_combats FROM campaign_scores WHERE campaign_id = ? AND user_id = ?').get(cid, user.id) || { score: 0, faction_score: 0, deaths: 0, exile_combats: 0 };
      const ch = q.char.get(user.id);
      const team = db.prepare(`SELECT coalesce(sum(s.faction_score), 0) AS n FROM campaign_scores s JOIN characters c ON c.user_id = s.user_id WHERE s.campaign_id = ? AND c.faction = ?`).get(cid, ch.faction).n;
      const life = {};
      for (const k of ['campaigns_won', 'campaigns_mvp', 'campaigns_top3', 'campaigns_flawless', 'campaigns_conquest', 'serpents_repelled', 'gold_spent', 'best_atk_streak', 'best_def_streak']) life[k] = statOf(user.id, k);
      send(res, 200, {
        campaign: cid, combat: ev.combat || 0, conquests: ev.conquest || 0, defenses: ev.defense || 0, generals: ev.general || 0, spared: ev.spare || 0,
        retakes: ev.retake || 0, annexes: ev.annex_conquest || 0, garreg: ev.garreg_conquest || 0, builds: ev.build || 0,
        deaths: row.deaths, score: row.score, rank: row.score > 0 ? q.betterScores.get(cid, row.score).n + 1 : null,
        share: team > 0 ? Math.round((row.faction_score / team) * 100) : 0, exileCombats: row.exile_combats, life,
      });
    },

    // Panthéon : campagnes passées (vainqueur, meilleurs joueurs), saison en cours et saisons terminées.
    'GET /api/pantheon': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      const cid = currentCampaign().id;
      const N = C.season.campaigns;
      const first = (seasonOf(cid) - 1) * N + 1;
      const parse = (x) => { try { return JSON.parse(x) || {}; } catch { return {}; } };
      const campaigns = db.prepare('SELECT id, ended_at, winner, summary FROM campaigns WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 20').all().map((c) => {
        const sm = parse(c.summary);
        return { id: c.id, endedAt: c.ended_at, winner: c.winner, reason: sm.reason || null, points: sm.points || {}, top: sm.top || [] };
      });
      const cur = seasonTable(first, cid);
      send(res, 200, {
        campaign: cid, season: { number: seasonOf(cid), length: N, first, done: cid - first, factions: cur.totals, players: cur.players.map((r) => ({ pseudo: r.pseudo, faction: r.faction, avatar: r.avatar, score: r.score })) },
        campaigns, seasons: db.prepare('SELECT season, data FROM seasons ORDER BY season DESC LIMIT 10').all().map((r) => ({ season: r.season, ...parse(r.data) })),
      });
    },

    // Signaler une cible ou une intention à sa faction (pings) : un seul signalement actif par joueur, avec un délai entre deux.
    'POST /api/ping': async (req, res) => {
      const { territory, kind } = await readJson(req);
      const { user, ch, t } = actor(req);
      if (!C.pings.kinds.includes(kind) || !terr(territory)) throw new HttpError(400, 'invalid_action');
      const last = q.pingLast.get(user.id);
      if (last && t - last.created_at < C.pings.cooldownSeconds * 1000) throw new HttpError(429, 'ping_cooldown');
      q.pingDropUser.run(user.id);
      q.pingAdd.run(currentCampaign().id, ch.faction, user.id, territory, kind, t);
      reply(res, user);
    },

    // Réagir à un événement du journal. Seulement quand l'action est celle d'un allié, jamais la sienne :
    //  - cheer (territoire pris ou défendu par ma faction) : +10 xp pour moi ;
    //  - support (attaque d'un allié en cours) : +10 or pour l'allié qui l'a lancée ;
    //  - help (appel à l'aide d'un allié, bataille en cours) : +1 point de chance pour son camp.
    'POST /api/journal/react': async (req, res) => {
      const { event, kind } = await readJson(req);
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      if (phase(Date.now()) === 'break') throw new HttpError(409, 'campaign_break');
      const e = Number.isInteger(event) ? q.eventById.get(event) : null;
      if (!e || !['cheer', 'support', 'help'].includes(kind) || !reactionKinds(user.id, e).some((x) => x.k === kind)) throw new HttpError(409, 'invalid_action');
      if (q.reactionsSince.get(user.id, kind, Date.now() - 86_400_000).n >= C.reactions.dailyCap) throw new HttpError(429, 'reaction_cap');
      if (q.addReaction.run(e.id, user.id, kind, Date.now()).changes !== 1) throw new HttpError(409, 'already_done');
      const p = JSON.parse(e.params);
      const R = C.reactions;
      let flash;
      if (kind === 'cheer') { grant(user.id, 0, R.cheerXp, 'reaction'); flash = { xp: R.cheerXp }; }
      if (kind === 'support') {
        grant(p.actor, R.supportGold, 0, 'reaction');
        notify(p.actor, 'supported', { pseudo: q.userChar.get(user.id)?.pseudo || '', gold: R.supportGold, territory: p.territory });
        flash = { gold: R.supportGold, pseudo: q.userChar.get(p.actor)?.pseudo || '' };
      }
      if (kind === 'help') {
        const b = q.battleById.get(p.battle);
        q.addHelp.run(b.attacker === p.faction ? R.helpPct : -R.helpPct, p.battle);
        flash = { pct: R.helpPct };
      }
      send(res, 200, { ...ctx.mePayload(user), flash: { kind, ...flash } });
    },

    // Journal du monde : les derniers événements de la carte.
    'GET /api/journal': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      onEvent(user.id, 'journal_read');
      const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
      const done = new Set(q.reactionsOf.all(user.id).map((r) => `${r.event_id}:${r.kind}`));
      send(res, 200, {
        now: Date.now(),
        events: q.events.all().map((e) => {
          const { actor: _a, battle: _b, ...params } = parse(e.params); // les identifiants de joueurs restent côté serveur
          return { id: e.id, type: e.type, params, at: e.created_at, react: reactionKinds(user.id, e).filter((x) => !done.has(`${e.id}:${x.k}`)) };
        }),
        fallen: mapPayload(user.id).fallen,
        exile: exileInfo(user.id),
        reviveCost: reviveCost(effFaction(user.id)),
      });
    },
  };

  // Au démarrage : une campagne en cours, et un état pour chaque personnage existant.
  currentCampaign();
  if (!q.meta.get('schedule_from')) q.setMeta.run('schedule_from', String(Date.now()));
  ensureGenerals(Date.now());
  updateFactions(ownersMap(), Date.now());
  for (const c of q.chars.all()) ensurePlayer(c.user_id);
  setInterval(() => q.purgeEvents.run(), 3_600_000).unref();

  // Résultat de la dernière campagne terminée que le joueur n'a pas encore vu (null s'il n'y en a pas).
  function resultFor(userId) {
    const r = q.resultFor.get(userId);
    if (!r) return null;
    try { return JSON.parse(r.data); } catch { return null; }
  }

  return { routes, tick, giveActions, onLevelUp, rewardActions, phaseNow: () => phase(Date.now()), missionState, missionsClaimable, claimMission, playerPayload, mapPayload, ensurePlayer, TURN_MS, fallenState, distinctionsOf, rewardMods, exileMult, resultFor, giftStates };
};
