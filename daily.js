'use strict';
// Missions du jour : objectifs courts remis à zéro chaque jour, avec une série de jours consécutifs.
// Réglages dans config/game.json, clé "daily". Les actions comptées sont signalées par le serveur (jamais par l'app).

module.exports = function createDaily(ctx) {
  const { db, config, grant, HttpError } = ctx;
  const D = { streakBonus: 0.1, maxStreak: 7, missions: [], ...(config.daily || {}) };

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      event   TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, event)
    );
    CREATE TABLE IF NOT EXISTS daily_claims (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day        TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      PRIMARY KEY (user_id, day, mission_id)
    );
    -- Série : nombre de jours consécutifs où le joueur a récupéré au moins une mission du jour.
    CREATE TABLE IF NOT EXISTS daily_streaks (
      user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_day TEXT NOT NULL,
      streak   INTEGER NOT NULL
    );
  `);
  const q = {
    bump: db.prepare(`INSERT INTO daily_progress (user_id, day, event, count) VALUES (?, ?, ?, ?)
                      ON CONFLICT (user_id, day, event) DO UPDATE SET count = count + excluded.count`),
    progress: db.prepare('SELECT event, count FROM daily_progress WHERE user_id = ? AND day = ?'),
    claims: db.prepare('SELECT mission_id FROM daily_claims WHERE user_id = ? AND day = ?'),
    claim: db.prepare('INSERT OR IGNORE INTO daily_claims (user_id, day, mission_id) VALUES (?, ?, ?)'),
    streak: db.prepare('SELECT last_day, streak FROM daily_streaks WHERE user_id = ?'),
    setStreak: db.prepare(`INSERT INTO daily_streaks (user_id, last_day, streak) VALUES (?, ?, ?)
                           ON CONFLICT (user_id) DO UPDATE SET last_day = excluded.last_day, streak = excluded.streak`),
    purge: db.prepare('DELETE FROM daily_progress WHERE day < ?'),
    purgeClaims: db.prepare('DELETE FROM daily_claims WHERE day < ?'),
  };

  // Jour courant à l'heure du serveur (TEST_DAY permet de le forcer pour les tests).
  const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => process.env.TEST_DAY || dayOf(new Date());
  const dayBefore = (day) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() - 1); return dayOf(d); };

  function bump(userId, event, n = 1) { q.bump.run(userId, today(), event, n); }

  // Série en cours : elle tient si la dernière récupération date d'aujourd'hui ou d'hier.
  function streakOf(userId) {
    const s = q.streak.get(userId);
    if (!s) return 0;
    return s.last_day === today() || s.last_day === dayBefore(today()) ? s.streak : 0;
  }
  const multiplier = (streak) => 1 + D.streakBonus * Math.min(streak, D.maxStreak);

  function state(userId) {
    const day = today();
    const progress = new Map(q.progress.all(userId, day).map((r) => [r.event, r.count]));
    const claimed = new Set(q.claims.all(userId, day).map((r) => r.mission_id));
    const streak = streakOf(userId);
    // Le bonus affiché est celui que donnerait une récupération maintenant.
    const s = q.streak.get(userId);
    const next = s && s.last_day === day ? streak : streak + 1;
    const mult = multiplier(next);
    return {
      streak,
      bonus: Math.round((mult - 1) * 100),
      missions: D.missions.map((m) => {
        const target = m.condition?.count || 1;
        const current = Math.min(progress.get(m.condition?.event) || 0, target);
        return {
          id: m.id, title: m.title, description: m.description || '', current, target,
          rewards: { gold: Math.round((m.rewards?.gold || 0) * mult), xp: m.rewards?.xp || 0 },
          status: claimed.has(m.id) ? 'claimed' : current >= target ? 'done' : 'active',
        };
      }),
    };
  }
  const claimable = (userId) => state(userId).missions.filter((m) => m.status === 'done').length;

  function claim(userId, id) {
    const day = today();
    const before = state(userId);
    const mission = before.missions.find((m) => m.id === id);
    if (!mission) throw new HttpError(404, 'mission_unknown');
    if (mission.status !== 'done' || q.claim.run(userId, day, id).changes !== 1) throw new HttpError(409, 'reward_unavailable');
    // La première récupération du jour prolonge la série (ou la recommence).
    const s = q.streak.get(userId);
    if (!s || s.last_day !== day) q.setStreak.run(userId, day, streakOf(userId) + 1);
    grant(userId, mission.rewards.gold, mission.rewards.xp);
    return state(userId);
  }

  setInterval(() => { const old = dayBefore(dayBefore(today())); q.purge.run(old); q.purgeClaims.run(old); }, 3_600_000).unref();

  return { bump, state, claim, claimable };
};
