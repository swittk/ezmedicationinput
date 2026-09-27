import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
if (!input) {
  console.error('Usage: npm run explain:boundaries -- "<sig>" [--locale=th] [--reference-date=YYYY-MM-DD] [--json]');
  process.exit(2);
}
const option = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
await fs.mkdir(path.join(here, '.generated'), { recursive: true });
const outfile = path.join(here, '.generated', 'explain.cjs');
await build({ entryPoints: [path.join(here, 'planner.ts')], outfile, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
const { planBoundaries } = createRequire(import.meta.url)(outfile);
const referenceDate = option('--reference-date');
const plan = planBoundaries(input, { locale: option('--locale'), ...(referenceDate ? { datePolicy: { referenceDate } } : {}) }, { trace: true });
if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2));
else {
  console.log('EXPERIMENT ONLY — production parser is unchanged.');
  for (const d of plan.decisions) {
    console.log(`${d.selected.action.toUpperCase()} ${JSON.stringify(d.site.surface || '<adjacent dose>')} [${d.site.start}..${d.site.end}] ${d.selected.rule}`);
    for (const e of d.selected.evidence) console.log(`  ${e.feature} = ${JSON.stringify(e.value)}${e.range ? ` [${e.range.start}..${e.range.end}]` : ''}`);
    if (d.selected.rule === 'boundary.no-licensed-split') for (const r of d.rejectedRules ?? [])
      console.log(`  rejected ${r.rule}: ${r.failedConstraints.join(', ')}`);
  }
  console.log('SEGMENTS', JSON.stringify(plan.segments, null, 2));
  console.log('TRACE COST', JSON.stringify(plan.metrics));
}
