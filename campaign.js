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
    boss: { faction: 'serpents', chancePerTurn: 0.1, max: 1, power: 3 },
    points: { win: 100, territory: 10, survivor: 5, loserTerritory: 2, loserSurvivor: 3 },
    cadenceGold: 10,
    hire: { gold: 300, power: 1.5, perBattle: 2 },
    revive: { gold: 100 },
    ranking: { combat: 10, victory: 30, gather: 2, rewards: [1000, 600, 300] },
    underdogs: {},
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
  `);
  {
    const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols('player_state').includes('bonus_turn')) db.exec('ALTER TABLE player_state ADD COLUMN bonus_turn INTEGER');
    if (!cols('player_state').includes('revive_asked')) db.exec('ALTER TABLE player_state ADD COLUMN revive_asked INTEGER NOT NULL DEFAULT 0');
    if (!cols('contributions').includes('kind')) db.exec("ALTER TABLE contributions ADD COLUMN kind TEXT NOT NULL DEFAULT 'action'");
  }

  const iso = () => new Date().toISOString();
  const q = {
    campaign: db.prepare('SELECT * FROM campaigns WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'),
    newCampaign: db.prepare('INSERT INTO campaigns (started_at) VALUES (?)'),
    endCampaign: db.prepare('UPDATE campaigns SET ended_at = ?, winner = ?, summary = ? WHERE id = ?'),
    owners: db.prepare('SELECT id, faction FROM territories'),
    setOwner: db.prepare('UPDATE territories SET faction = ?, updated_at = ? WHERE id = ?'),
    char: db.prepare('SELECT user_id, pseudo, faction, class, xp, gold FROM characters WHERE user_id = ?'),
    chars: db.prepare('SELECT user_id, faction FROM characters'),
    payGold: db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?'),
    loseXp: db.prepare('UPDATE characters SET xp = xp - ? WHERE user_id = ? AND xp >= ?'),
    state: db.prepare('SELECT * FROM player_state WHERE user_id = ?'),
    insertState: db.prepare('INSERT OR REPLACE INTO player_state (user_id, territory, actions, actions_at, status, retreat_until) VALUES (?, ?, ?, ?, ?, NULL)'),
    setActions: db.prepare('UPDATE player_state SET actions = ?, actions_at = ? WHERE user_id = ?'),
    setBonusTurn: db.prepare('UPDATE player_state SET bonus_turn = ? WHERE user_id = ?'),
    setTerritory: db.prepare("UPDATE player_state SET territory = ?, status = 'alive', retreat_until = NULL, revive_asked = 0 WHERE user_id = ?"),
    setRetreating: db.prepare("UPDATE player_state SET status = 'retreating', retreat_until = ? WHERE user_id = ?"),
    setDead: db.prepare("UPDATE player_state SET status = 'dead', retreat_until = NULL WHERE user_id = ?"),
    askRevive: db.prepare('UPDATE player_state SET revive_asked = 1 WHERE user_id = ?'),
    clearStates: db.prepare('DELETE FROM player_state'),
    retreatDue: db.prepare("SELECT user_id FROM player_state WHERE status = 'retreating' AND retreat_until <= ?"),
    // Joueurs d'une faction encore en jeu (pour les prévenir).
    factionPlayers: db.prepare(`SELECT p.user_id, p.territory FROM player_state p JOIN characters c ON c.user_id = p.user_id
                                WHERE c.faction = ? AND p.status != 'dead'`),
    factionAll: db.prepare('SELECT user_id FROM characters WHERE faction = ?'),
    fallen: db.prepare(`SELECT c.user_id, c.pseudo FROM player_state p JOIN characters c ON c.user_id = p.user_id
                        WHERE c.faction = ? AND p.status = 'dead' AND p.revive_asked = 1 AND c.user_id != ?`),
    presence: db.prepare(`SELECT p.territory, c.faction, count(*) AS n FROM player_state p JOIN characters c ON c.user_id = p.user_id
                          WHERE p.status != 'dead' GROUP BY p.territory, c.faction`),
    aliveByFaction: db.prepare(`SELECT c.faction, count(*) AS n, sum(p.status != 'dead') AS alive
                                FROM player_state p JOIN characters c ON c.user_id = p.user_id GROUP BY c.faction`),
    openBattle: db.prepare('SELECT * FROM battles WHERE territory = ? AND resolved_at IS NULL'),
    openBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL'),
    dueBattles: db.prepare('SELECT * FROM battles WHERE resolved_at IS NULL AND ends_at <= ? ORDER BY ends_at'),
    insertBattle: db.prepare('INSERT INTO battles (campaign_id, territory, attacker, defender, boss_power, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    closeBattle: db.prepare('UPDATE battles SET resolved_at = ?, success = ?, chance = ? WHERE id = ?'),
    closeAllBattles: db.prepare('UPDATE battles SET resolved_at = ? WHERE resolved_at IS NULL'),
    addContribution: db.prepare('INSERT INTO contributions (battle_id, territory, user_id, faction, side, power, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
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
    for (const f of PLAYABLE) {
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
    }
  }

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

  // Crée l'état du joueur s'il n'existe pas encore (nouveau personnage ou nouvelle campagne).
  function ensurePlayer(userId) {
    const ps = q.state.get(userId);
    if (ps) return ps;
    const ch = q.char.get(userId);
    if (!ch) return null;
    const spot = spawnTerritory(ch.faction, ownersMap());
    // Une faction hors jeu ne peut plus accueillir de joueur avant la prochaine campagne.
    q.insertState.run(userId, spot || '', C.startActions, Date.now(), spot ? 'alive' : 'dead');
    return q.state.get(userId);
  }

  // Actions disponibles maintenant : +1 par tour écoulé, plafonné ; le compteur ne tourne pas quand la réserve est pleine.
  function settle(ps, t) {
    let { actions, actions_at: at } = ps;
    if (actions < C.maxActions) {
      const gained = Math.floor((t - at) / TURN_MS);
      if (gained > 0) { actions = Math.min(C.maxActions, actions + gained); at += gained * TURN_MS; }
    }
    return actions >= C.maxActions ? { actions: C.maxActions, at: t, next: null } : { actions, at, next: at + TURN_MS };
  }
  // Dépense 1 action. La première action de chaque tour rapporte un petit bonus de régularité.
  function spend(ps, t) {
    const s = settle(ps, t);
    if (s.actions < 1) throw new HttpError(409, 'no_actions');
    q.setActions.run(s.actions - 1, s.actions >= C.maxActions ? t : s.at, ps.user_id);
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
    const others = [...counts].filter(([f]) => f !== faction).map(([, n]) => n);
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
  // Chances de réussite de l'attaque : force des attaquants / (attaquants + défense).
  // La défense part d'une base proportionnelle à l'importance du territoire, plus un bonus pour les factions non jouables.
  function battleInfo(b) {
    const sides = Object.fromEntries(q.sidePower.all(b.id).map((r) => [r.side, r]));
    const attack = b.boss_power + (sides.attack?.power || 0);
    const defense = C.baseDefense * importance(b.territory) + (C.npcDefense[b.defender] || 0) + (sides.defense?.power || 0);
    const chance = Math.min(C.maxChance, Math.max(C.minChance, attack / (attack + defense)));
    return { chance, attackers: sides.attack?.players || 0, defenders: sides.defense?.players || 0 };
  }

  function startBattle(territory, attacker, defender, t, bossPower = 0) {
    const info = q.insertBattle.run(currentCampaign().id, territory, attacker, defender, bossPower, t, t + C.battleTurns * TURN_MS);
    const id = Number(info.lastInsertRowid);
    // Les garnisons posées avant l'attaque comptent dans la bataille.
    if (defender) q.attachGarrison.run(id, territory, defender, t);
    if (defender) for (const p of q.factionPlayers.all(defender)) notify(p.user_id, 'territory_attacked', { territory, faction: attacker });
    journal('battle_started', { territory, attacker, defender }, t);
    return q.openBattle.get(territory);
  }

  function resolveBattle(b, t) {
    const { chance } = battleInfo(b);
    const success = roll() < chance;
    q.closeBattle.run(t, success ? 1 : 0, chance, b.id);
    const scale = importance(b.territory);
    if (success) {
      q.setOwner.run(b.attacker, iso(), b.territory);
      q.dropGarrison.run(b.territory, t);
      journal('territory_taken', { territory: b.territory, faction: b.attacker, from: b.defender }, t);
      const gain = scale * (perks(b.attacker).rewardMultiplier || 1);
      const reward = { gold: C.attackRewards.gold * gain, xp: C.attackRewards.xp * gain };
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'attack')) {
        grant(uid, reward.gold, reward.xp);
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_conquered', { territory: b.territory, ...reward });
      }
      if (b.defender) {
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
            q.setRetreating.run(t + C.retreatTurns * TURN_MS, p.user_id);
            notify(p.user_id, 'must_retreat', { territory: b.territory });
          }
        }
      }
    } else {
      journal('attack_repelled', { territory: b.territory, attacker: b.attacker, faction: b.defender }, t);
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'attack')) notify(uid, 'attack_failed', { territory: b.territory });
      const reward = { gold: C.defenseRewards.gold * scale, xp: C.defenseRewards.xp * scale };
      for (const { user_id: uid } of q.sideUsers.all(b.id, 'defense')) {
        grant(uid, reward.gold, reward.xp);
        score(uid, C.ranking.victory);
        onEvent(uid, 'battle_won');
        notify(uid, 'territory_defended', { territory: b.territory, ...reward });
      }
    }
  }

  // Mini-boss : à chaque nouveau tour, la faction ennemie a une chance d'attaquer un territoire au hasard.
  function spawnBosses(t) {
    const turn = Math.floor(t / TURN_MS);
    const last = Number(q.meta.get('boss_turn')?.value ?? turn);
    q.setMeta.run('boss_turn', String(turn));
    for (let i = Math.max(last + 1, turn - 5); i <= turn; i += 1) {
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
    const withPlayers = q.aliveByFaction.all().map((r) => r.faction);
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
  function tick(t = Date.now()) {
    if (ticking) return;
    ticking = true;
    try {
      currentCampaign();
      for (const b of q.dueBattles.all(t)) resolveBattle(b, t);
      for (const { user_id: uid } of q.retreatDue.all(t)) { q.setDead.run(uid); notify(uid, 'fallen', {}); }
      q.dropGarrison.run('', t);
      updateFactions(ownersMap(), t);
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
    return {
      now: t, // heure du serveur, pour que l'app affiche des comptes à rebours justes
      territory: ps.territory || null, status: ps.status, retreatUntil: ps.retreat_until,
      actions: s.actions, maxActions: C.maxActions, nextActionAt: s.next,
      factionOut: isOut(ch.faction), reviveAsked: !!ps.revive_asked,
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
    return {
      now: t,
      turnMs: TURN_MS,
      campaign: { id: campaign.id, startedAt: campaign.started_at },
      player: playerPayload(userId, t),
      homeBases: C.homeBases,
      costs: { hire: C.hire.gold, hireMax: C.hire.perBattle, revive: ch ? reviveCost(ch.faction) : C.revive.gold },
      // Avantages de ma faction, s'il y en a (affichés dans le menu).
      perks: ch && C.underdogs[ch.faction] ? { ...C.underdogs[ch.faction], powerBonus: Math.round(powerBonus(ch.faction) * 10) / 10 } : null,
      points: Object.fromEntries(q.points.all().map((r) => [r.faction, r.points])),
      ranking: rankingPayload(userId),
      // Alliés tombés qui demandent qu'on paie leur retour.
      fallen: ch ? q.fallen.all(ch.faction, userId).map((r) => ({ id: r.user_id, pseudo: r.pseudo })) : [],
      territories: TERR.map((x) => {
        const b = battles.get(x.id);
        const info = b ? battleInfo(b) : null;
        return {
          id: x.id, name: x.name, neighbors: neighbors(x.id), faction: owners.get(x.id) || null,
          importance: importance(x.id), annex: ANNEX.has(x.id), players: presence.get(x.id) || {},
          battle: b ? {
            attacker: b.attacker, defender: b.defender, boss: b.boss_power > 0, endsAt: b.ends_at,
            chance: Math.round(info.chance * 100), attackers: info.attackers, defenders: info.defenders,
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
    return { user, ps, ch: q.char.get(user.id), t, owners: ownersMap() };
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
    // Se déplacer vers un territoire voisin (1 action).
    'POST /api/move': async (req, res) => {
      const { to } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      if (!terr(to)) throw new HttpError(400, 'invalid_territory');
      if (!NEIGHBORS.get(ps.territory)?.has(to)) throw new HttpError(409, 'not_neighbor');
      if (!canEnter(ch.faction, to, owners)) throw new HttpError(409, 'cannot_enter');
      const bonus = spend(ps, t);
      q.setTerritory.run(to, user.id);
      onEvent(user.id, 'move');
      reply(res, user, { bonus });
    },

    // Agir sur le territoire où l'on se trouve.
    // attack, defend, gather : 1 action. hire : renfort payé en or (mercenaires en attaque, fortification en défense), sans action.
    'POST /api/act': async (req, res) => {
      const { action } = await readJson(req);
      const { user, ps, ch, t, owners } = actor(req);
      mustBeAlive(ps);
      const here = ps.territory;
      const owner = owners.get(here) || null;
      const battle = q.openBattle.get(here);
      let bonus = 0;
      if (action === 'attack') {
        if (owner === ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle && battle.attacker !== ch.faction) throw new HttpError(409, 'battle_busy');
        bonus = spend(ps, t);
        const b = battle || startBattle(here, ch.faction, owner, t);
        q.addContribution.run(b.id, here, user.id, ch.faction, 'attack', power(ch), t, null, 'action');
        score(user.id, C.ranking.combat);
        onEvent(user.id, 'combat');
      } else if (action === 'defend') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        bonus = spend(ps, t);
        // Pendant une bataille, l'action renforce la défense ; sinon elle pose une garnison qui tient le temps d'une bataille.
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, 'defense', power(ch), t,
          battle ? null : t + C.battleTurns * TURN_MS, 'action');
        score(user.id, C.ranking.combat);
        onEvent(user.id, 'combat');
      } else if (action === 'gather') {
        if (owner !== ch.faction) throw new HttpError(409, 'invalid_action');
        if (battle) throw new HttpError(409, 'battle_here');
        bonus = spend(ps, t);
        grant(user.id, C.gather.gold, C.gather.xp);
        score(user.id, C.ranking.gather);
        onEvent(user.id, 'gather');
      } else if (action === 'hire') {
        // Sur son territoire : fortification. Ailleurs : mercenaires, seulement dans une bataille lancée par sa faction.
        const side = owner === ch.faction ? 'defense' : 'attack';
        if (side === 'attack' && (!battle || battle.attacker !== ch.faction)) throw new HttpError(409, 'invalid_action');
        const already = battle ? q.hiredInBattle.get(user.id, battle.id).n : q.hiredGarrison.get(user.id, here, t).n;
        if (already >= C.hire.perBattle) throw new HttpError(409, 'hire_limit');
        if (q.payGold.run(C.hire.gold, user.id, C.hire.gold).changes !== 1) throw new HttpError(409, 'not_enough_gold');
        q.addContribution.run(battle ? battle.id : null, here, user.id, ch.faction, side, C.hire.power, t,
          battle ? null : t + C.battleTurns * TURN_MS, 'hire');
        score(user.id, C.ranking.combat);
      } else throw new HttpError(400, 'invalid_action');
      reply(res, user, { bonus });
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

    // Journal du monde : les derniers événements de la carte.
    'GET /api/journal': async (req, res) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthorized');
      tick();
      const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
      send(res, 200, {
        now: Date.now(),
        events: q.events.all().map((e) => ({ id: e.id, type: e.type, params: parse(e.params), at: e.created_at })),
        fallen: mapPayload(user.id).fallen,
        reviveCost: reviveCost(q.char.get(user.id)?.faction),
      });
    },
  };

  // Au démarrage : une campagne en cours, et un état pour chaque personnage existant.
  currentCampaign();
  updateFactions(ownersMap(), Date.now());
  for (const c of q.chars.all()) ensurePlayer(c.user_id);
  setInterval(() => q.purgeEvents.run(), 3_600_000).unref();

  return { routes, tick, playerPayload, mapPayload, ensurePlayer, TURN_MS };
};
