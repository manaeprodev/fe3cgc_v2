'use strict';
// Effets de classe : ce que chaque classe apporte, et ce qu'un joueur cumule au fil de sa progression.
// Les effets sont déclarés dans config/game.json (champ `effects` de chaque classe) ; ce module les lit.
//
// Lignée d'un joueur (son « arbre de classes ») : les classes traversées depuis sa classe de base, dans l'ordre.
// Il garde tous leurs effets, qui se cumulent. Revenir à une classe de base recommence la lignée.

module.exports = function createEffects(config) {
  const CLASSES = new Map((config.classes || []).map((c) => [c.id, c]));
  const BASE = (config.classTiers || [])[0]?.id;
  const FLYING = new Set((config.campaign || {}).flyingClasses || []);

  // Chemin par défaut jusqu'à une classe : on remonte toujours par le premier prérequis.
  function derivePath(classId) {
    const out = [];
    const seen = new Set();
    let cur = CLASSES.get(classId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur.id);
      cur = cur.tier === BASE ? null : CLASSES.get((cur.requires || [])[0]);
    }
    return out;
  }

  // Lignée d'un personnage (ligne `characters`) : champ class_path, ou chemin par défaut s'il manque ou s'il ne finit pas par la classe actuelle.
  function pathOf(row) {
    let p;
    try { p = JSON.parse(row.class_path || '[]'); } catch { p = []; }
    if (!Array.isArray(p) || p.length === 0 || p[p.length - 1] !== row.class) return derivePath(row.class);
    return p;
  }

  // Lignée après un changement de classe : une classe de base recommence la lignée, les autres s'y ajoutent.
  function nextPath(row, target) {
    const cls = CLASSES.get(target);
    if (!cls || cls.tier === BASE) return [target];
    return [...pathOf(row), target];
  }

  // Effets d'une lignée, à plat : chacun garde sa classe d'origine (classId) et reçoit un identifiant unique (id).
  function effectsOfPath(path) {
    const out = [];
    for (const classId of path) (CLASSES.get(classId)?.effects || []).forEach((e, i) => out.push({ ...e, classId, id: `${classId}:${i}` }));
    return out;
  }

  const sumOf = (effects, kind, field = 'pct') => effects.filter((e) => e.kind === kind).reduce((a, e) => a + (Number(e[field]) || 0), 0);

  // Chances (en %) de ne pas dépenser d'action en se déplaçant. Un effet peut gagner un bonus si une classe figure dans la lignée.
  function freeMoveChance(path, effects) {
    let pct = 0;
    for (const e of effects.filter((x) => x.kind === 'freeMove')) {
      pct += e.pct;
      if (e.bonusIfLineage && path.includes(e.bonusIfLineage.class)) pct += e.bonusIfLineage.pct;
    }
    return Math.min(95, pct);
  }

  // Réserve d'actions et vitesse de recharge : chaque effet « actionStock » ajoute un emplacement,
  // la recharge la plus rapide l'emporte (durée en minutes de jeu, ramenée à la durée d'un tour).
  function actionLimits(effects, baseMax, turnMs, turnMinutes) {
    let max = baseMax;
    let ms = turnMs;
    for (const e of effects.filter((x) => x.kind === 'actionStock')) {
      max += e.plus || 0;
      if (e.regenMinutes) ms = Math.min(ms, Math.round((turnMs * e.regenMinutes) / turnMinutes));
    }
    return { max, ms };
  }

  const isFlying = (classId) => FLYING.has(classId);

  return { CLASSES, BASE, derivePath, pathOf, nextPath, effectsOfPath, sumOf, freeMoveChance, actionLimits, isFlying };
};
