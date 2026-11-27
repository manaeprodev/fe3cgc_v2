'use strict';
// Lance toutes les suites de tests, une par une (chacune démarre son propre serveur sur une base jetable, avec des tours de 2 secondes).
// Usage : node tests/run.js [motif]      (par exemple : node tests/run.js generals)
// Variables : RETREAT_TURNS=6 et DECISIVE=0 ramènent les règles aux valeurs que les suites supposent ; les suites qui isolent les règles
// de campagne désactivent aussi les généraux (TEST_NO_GENERALS).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NO_GENERALS = new Set(['campaign', 'underdogs', 'exile', 'class-unlock', 'quiet-hours', 'classes-and-avatars', 'strategy-meta']);
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(process.argv[2] || '')).sort();
let failed = 0;
for (const f of files) {
  const name = f.replace('.test.js', '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `conquete-${name}-`));
  const env = { ...process.env, RETREAT_TURNS: '6', DECISIVE: '0', GEN_TICK_MS: '0', GLVL_SMOOTH_MS: '0', GLVL_ALPHA: '1', OVERDRIVE_HOURS: '0', HP_ON: '0', LEVEL_UP_GOLD: '0', LEVEL_UP_REFILL: '0', HP_PER_LEVEL: '0', TEST_NO_FATIGUE: '1', ...(NO_GENERALS.has(name) ? { TEST_NO_GENERALS: '1' } : {}) };
  process.stdout.write(`\n=== ${name}\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f), path.join(root, 'server.js'), dir], { cwd: root, env, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const bad = out.split('\n').filter((l) => /ÉCHEC|ERREUR/.test(l));
  process.stdout.write(bad.length ? `${bad.join('\n')}\n` : '');
  // Le résultat est la ligne de bilan de la suite (le serveur peut écrire des avertissements après elle).
  const summary = out.split('\n').filter((l) => /tests passent|ÉCHEC\(S\)/.test(l)).pop() || '';
  process.stdout.write(`${summary || 'aucun bilan : la suite s\'est arrêtée avant la fin'}\n`);
  if (r.status !== 0 || bad.length || !/tests passent/.test(summary)) failed += 1;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} suite(s) en échec.` : '\nToutes les suites passent.');
process.exit(failed ? 1 : 0);
