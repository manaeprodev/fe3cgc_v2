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
    occupants: db.prepare(`SELECT p.user_id, p.territory, p.status, COALESCE(p.exile_faction, c.faction) AS faction, p.exile_faction, c.pseudo, c.avatar, c.class, c.xp
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
    clearFactionMeta: db.prepare("DELETE FROM campaign_meta WHERE key LIKE 'held:%' OR key LIKE 'out:%' OR key LIKE 'epi:%' OR key LIKE 'finished:%' OR key LIKE 'gauge:%' OR key LIKE 'buff:%' OR key LIKE 'retake:%' OR key LIKE 'warned:%' OR key IN ('conquest', 'serpents_gone', 'reset_at', 'summary')"),
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
  function woundPlayer(uid, mult, snipe, t) {
    q.addDeath.run(currentCampaign().id, uid);
    metric('wounded', 1);
    const side = effFaction(uid);
    const spot = side && spawnTerritory(side, ownersMap());
    if (!spot) { q.setDead.run(uid); notify(uid, 'fallen', { wounded: false }); return; }
    const fine = Math.min(q.gold.get(uid)?.gold || 0, Math.round((isExile(uid) ? C.revive.gold : reviveCost(side)) * mult) + snipe);
    if (fine > 0) q.takeGold.run(fine, uid);
    q.setTerritory.run(spot, uid);
    q.setActions.run(0, t, uid);
    q.setRewardDebuff.run(C.wound.actions, uid);
    notify(uid, 'fallen', { wounded: true, gold: fine, actions: C.wound.actions, territory: spot });
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
        const turns = Math.max(1, C.retreatTurns + own + enemyAdj);
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
    q.addScore.run(currentCampaign().id, userId, n, exiled ? 0 : n);
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
    if (m.rewards.actions) giveActions(userId, m.rewards.actions);
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
  // Un exilé ne profite d'aucun avantage de la faction qu'il sert (capacité du seigneur, avantages des Loups de cendre…).
  const fortifyCost = (userId) => Math.round(C.hire.gold * productOf(effectsOfUser(userId), 'fortifyCost', 'factor') * (isExile(userId) ? 1 : hireFactor(effFaction(userId))));
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
    // Au-delà du maximum (récompenses de missions), la réserve est gardée mais ne se recharge plus.
    return actions >= lim.max ? { actions, at: t, next: null, max: lim.max } : { actions, at, next: at + lim.ms, max: lim.max };
  }
  // Actions offertes (missions) : elles peuvent dépasser le maximum.
  function giveActions(userId, n) {
    const ps = ensurePlayer(userId);
    if (!ps || !n) return;
    const t = Date.now();
    const s = settle(ps, t);
    q.setActions.run(s.actions + n, s.actions >= s.max ? t : s.at, userId);
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
    db.exec('DELETE FROM generals; DELETE FROM general_contribs; DELETE FROM general_verdicts');
    if (!GENERALS_ON) return;
    for (const g of G.roster) q.insertGeneral.run(g.id, g.faction || null, g.home || '', G.actions, t);
  }
  const ensureGenerals = (t) => { if (GENERALS_ON) for (const g of G.roster) q.insertGeneral.run(g.id, g.faction || null, g.home || '', G.actions, t); };

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
  // L'IA des généraux, à chaque tick.
  function generalsTick(t) {
    const owners = ownersMap();
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
      if (hb && hb.attacker !== row.faction && (homeOwner === row.faction || guarding(row.faction, homeOwner, hb))) {
        if (row.territory !== home) {
          const path = pathTo(row.territory, home, row.faction, owners);
          if (!path || cur.actions < path.length + 1) continue;
          spendGen(row, cur, t, path.length);
          moveGeneral(row, home);
        }
        genFight(row, cur, hb, 'defense', t, isLord(row.gid) && home === C.capitals[row.faction]); // un seigneur défend toujours sa capitale
        continue;
      }
      // Seigneur dans sa capitale : il n'en bouge pas.
      if (isLord(row.gid) && C.capitals[row.faction] && row.territory === C.capitals[row.faction] && owners.get(row.territory) === row.faction) continue;
      // Engagé dans un combat là où il se trouve : il reste jusqu'à la fin (partir annulerait ses actions).
      const hereB = q.openBattle.get(row.territory);
      if (hereB && q.generalContribed.get(hereB.id, row.gid)) continue;
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
      // Sortie : un territoire ennemi voisin, de préférence là où sa faction attaque déjà.
      if (sorties >= G.maxSorties) continue;
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

  // Un général meurt (effacé de la carte). Epimenides : les Serpents ne reviennent plus et la faction qui l'a abattu gagne un bonus de points.
  function killGeneral(row, by, territory, t) {
    q.setGeneralStatus.run('dead', row.gid);
    q.dropVerdict.run(row.gid);
    journal('general_fell', { general: row.gid, faction: by || null, territory }, t);
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
  const alliesOf = (row) => q.generals.all().filter((g) => g.gid !== row.gid && g.faction === row.faction && (g.status === 'alive' || g.status === 'captive') && GEN.has(g.gid));
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
      grant(uid, paid.gold, paid.xp, 'general');
      cm(uid, 'general');
      notify(uid, 'general_defeated', { general: row.gid, ...paid });
    }
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
      const mine = (row) => camps.includes(row.faction) || (row.faction === null && !b.defender);
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
      if (userId) cm(userId, 'spare');
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
      const exiled = exiles.has(r.user_id);
      power *= capMult(r.faction, owners0) * (exiled ? 1 : lordMult(r.faction, r.side));
      if (counter && r.side === 'attack') power *= 1 + (exiled ? C.counter.attackBonus : counterBonus(b.attacker)) / 100;
      sums[r.side] += power;
      perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + power);
    }
    // Chevalier sacré en défense : la puissance d'attaque des Serpents est divisée.
    let bossPower = b.boss_power;
    const holy = here.defense.flatMap((p) => p.effects).find((e) => e.kind === 'holyKnight');
    if (holy && bossPower > 0) bossPower /= holy.bossDivisor || 1;
    const attack = bossPower + sums.attack;
    // Capitale d'origine tenue par sa faction : plus elle a de territoires, plus sa capitale est dure à prendre.
    const defense = (C.baseDefense * importance(T) + (C.npcDefense[b.defender] || 0) + sums.defense) * (1 + buildEffect(T, 'defensePct') / 100) * capitalGuard(T, owners0);
    const raw = attack / (attack + defense) + (b.help || 0) / 100;
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
    const { chance } = battleDetail(b);
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
      const m = exileMult(uid);
      return { gold: Math.round(gold * m), xp: Math.round(xp * m) };
    };
    if (success) {
      q.setOwner.run(b.attacker, iso(), b.territory);
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
        const paid = payout(uid, { gold: reward.gold * m, xp: reward.xp * m }, true);
        grant(uid, paid.gold, paid.xp, 'conquest');
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_conquered', { territory: b.territory, ...paid });
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
    } else {
      // Défense assurée en partie par les gardiens du territoire (Loups de cendre pour l'Église) : c'est eux qui en profitent.
      const guard = Object.keys(guardians).find((f) => guardians[f] === b.defender && q.defenderFactions.all(b.id).some((r) => r.faction === f));
      if (guard) q.setCredit.run(guard, b.id);
      // Une attaque ratée a un prix : les attaquants restés sur place doivent se replier à temps, sinon ils tombent (retour plus cher).
      const stuck = q.sideActors.all(b.id, 'attack').map((r) => r.user_id).filter((uid) => {
        const st = q.state.get(uid);
        return st && st.status === 'alive' && st.territory === b.territory;
      });
      forceRetreat(stuck, b.attacker, C.revive.attackerMultiplier ?? 1, q.sideActors.all(b.id, 'defense').flatMap((r) => effectsOfUser(r.user_id)), t);
      settleGenerals(b, false, guard || b.defender, t);
      // Raid des Serpents mené par un général : repoussé, il meurt.
      if (b.general) {
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
        const paid = payout(uid, reward, false);
        grant(uid, paid.gold, paid.xp, 'defense');
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
      const mult = q.meta.get(`epi:${f}`) ? 1 + (G.serpents.pointsBonus || 0) : 1; // Epimenides abattu par cette faction
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
    const occupants = new Map();
    const presence = new Map();
    const seat = (territory, o) => {
      if (!occupants.has(territory)) { occupants.set(territory, []); presence.set(territory, {}); }
      occupants.get(territory).push(o);
      if (o.faction) presence.get(territory)[o.faction] = (presence.get(territory)[o.faction] || 0) + 1;
    };
    for (const r of q.occupants.all()) {
      if (r.user_id !== userId && !r.exile_faction && hidden.has(`${r.faction}:${r.territory}`) && !engaged.has(`${r.user_id}:${r.territory}`)) continue;
      seat(r.territory, { pseudo: r.pseudo, avatar: r.avatar, faction: r.faction, class: r.class, level: renown(r.xp).level, me: r.user_id === userId, retreating: r.status === 'retreating' });
    }
    // Les généraux se voient comme les joueurs ; ceux des factions cachées sur leur base ne se montrent que s'ils y combattent.
    const genEngaged = new Set(q.generalsEngaged.all().map((r) => `${r.gid}:${r.territory}`));
    for (const g of q.generals.all()) {
      if (g.status !== 'alive' || !g.territory || !GEN.has(g.gid) || g.faction === C.boss.faction) continue;
      if (hidden.has(`${g.faction}:${g.territory}`) && !genEngaged.has(`${g.gid}:${g.territory}`)) continue;
      seat(g.territory, { pseudo: GEN.get(g.gid).name, gid: g.gid, avatar: GEN.get(g.gid).avatar, faction: g.faction || null, class: genClass(g.gid), level: genLevel(g), me: false, retreating: false, general: true, lord: isLord(g.gid) });
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
      journalLatest: q.latestEvent.get()?.id || 0,
      lord: lordPayload(side),
      objective: side ? objectiveStatus(side, owners) : null,
      // Signalements de ma faction (les plus récents d'abord).
      pings: side ? q.pingsOf.all(campaign.id, side, t - C.pings.minutes * 60000, C.pings.max).map((x) => ({ id: x.id, territory: x.territory, kind: x.kind, pseudo: x.pseudo, at: x.created_at, mine: x.user_id === userId })) : [],
      guardians,
      // hire : bataillon en attaque ; fortify : fortification en défense (moitié prix pour un Prêtre) ; teleport : Évêque noir.
      costs: {
        hire: Math.round(C.hire.gold * (isExile(userId) ? 1 : hireFactor(side))), fortify: ch ? fortifyCost(userId) : C.hire.gold, hireMax: C.hire.perBattle,
        build: C.build.costs, buildMax: C.build.maxLevel,
        revive: side ? Math.round(reviveCost(side) * (q.state.get(userId)?.fall_mult || 1)) : C.revive.gold,
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

  const routes = {
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
      const free = raid || moveRoll() * 100 < freeMoveChance(user.id);
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
      const { action, spec } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      const here = ps.territory;
      const owner = owners.get(here) || null;
      const battle = q.openBattle.get(here);
      // Série d'actions de combat sur un même territoire (Combattant) : nombre d'actions précédentes d'affilée.
      const streak = ps.streak_territory === here ? ps.streak_count : 0;
      let bonus = 0;
      if (action === 'attack') {
        if (owner === ch.faction || guardians[ch.faction] === owner) throw new HttpError(409, 'invalid_action');
        if (battle && battle.attacker !== ch.faction) throw new HttpError(409, 'battle_busy');
        if (shieldUntil(here, owners, t)) throw new HttpError(409, 'untouchable');
        if (phase(t) === 'closing') throw new HttpError(409, 'campaign_closing');
        bonus = spend(ps, t);
        const b = battle || startBattle(here, ch.faction, owner, t, 0, null, user.id);
        q.setStreak.run(here, streak + 1, user.id);
        onEvent(user.id, 'attack_action');
        cm(user.id, 'combat');
        q.addContribution.run(b.id, here, user.id, ch.faction, 'attack', power(ch), t, null, 'action', streak);
        score(user.id, C.ranking.combat);
        addGauge(ch.faction, C.gauge.perAction);
        onEvent(user.id, 'combat');
        if (ps.exile_faction) { onEvent(user.id, 'exile_combat'); q.addExileCombat.run(currentCampaign().id, user.id); }
        q.tickDebuff.run(user.id);
      } else if (action === 'defend') {
        if (owner !== ch.faction && !guarding(ch.faction, owner, battle)) throw new HttpError(409, 'invalid_action');
        bonus = spend(ps, t);
        // Pendant une bataille, l'action renforce la défense ; sinon elle pose une garnison qui tient le temps d'une bataille.
        q.setStreak.run(here, streak + 1, user.id);
        onEvent(user.id, 'defend_action');
        cm(user.id, 'combat');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, 'defense', power(ch), t,
          battle ? null : t + C.battleTurns * TURN_MS, 'action', streak);
        score(user.id, C.ranking.combat);
        addGauge(ch.faction, C.gauge.perAction);
        onEvent(user.id, 'combat');
        if (ps.exile_faction) { onEvent(user.id, 'exile_combat'); q.addExileCombat.run(currentCampaign().id, user.id); }
        q.tickDebuff.run(user.id);
      } else if (action === 'gather') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle) throw new HttpError(409, 'battle_here');
        bonus = spend(ps, t);
        const m = exileMult(user.id);
        grant(user.id, Math.round(C.gather.gold * m * (1 + buildEffect(here, 'goldPct') / 100)), Math.round(C.gather.xp * m * (1 + buildEffect(here, 'xpPct') / 100)), 'gather');
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
        const level = cur ? cur.level : 0;
        if (level >= C.build.maxLevel) throw new HttpError(409, 'build_max');
        if (settle(ps, t).actions < 1) throw new HttpError(409, 'no_actions');
        if (!pay(user.id, C.build.costs[level], 'build')) throw new HttpError(409, 'not_enough_gold');
        bonus = spend(ps, t);
        q.buildSet.run(here, use, level + 1);
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
        const cost = side === 'defense' ? fortifyCost(user.id) : Math.round(C.hire.gold * (ch.home !== ch.faction ? 1 : hireFactor(ch.faction)));
        const strength = side === 'defense' ? fortifyPower(user.id) : C.hire.power;
        if (!pay(user.id, cost, 'hire')) throw new HttpError(409, 'not_enough_gold');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, side, strength, t,
          battle ? null : t + C.battleTurns * TURN_MS, 'hire', 0);
        score(user.id, C.ranking.combat);
        if (side === 'attack') onEvent(user.id, 'battalion');
      } else throw new HttpError(400, 'invalid_action');
      reply(res, user, { bonus });
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
        const cost = Math.round(reviveCost(ch.faction) * mult);
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
          spare: cfg.spare || [], coef: cfg.coef, lord: isLord(gid),
        });
        return;
      }
      const ch = q.profileOf.get(String(u.searchParams.get('pseudo') || ''));
      if (!ch) throw new HttpError(404, 'not_found');
      const ps = q.state.get(ch.user_id);
      const cid = currentCampaign().id;
      const sc = q.myScore.get(cid, ch.user_id)?.score || 0;
      send(res, 200, {
        type: 'player', pseudo: ch.pseudo, avatar: ch.avatar, faction: ch.faction, exile: ps?.exile_faction || null, class: ch.class, path: fx.pathOf(ch),
        level: renown(ch.xp).level, birthday: ch.birthday, score: sc, rank: sc > 0 ? q.betterScores.get(cid, sc).n + 1 : null,
        distinctions: distinctionsOf(ch.user_id), status: ps?.status || null, me: ch.user_id === user.id,
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

  return { routes, tick, giveActions, phaseNow: () => phase(Date.now()), missionState, missionsClaimable, claimMission, playerPayload, mapPayload, ensurePlayer, TURN_MS, fallenState, distinctionsOf, rewardMods, resultFor };
};
