import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { candidateTransform } from './integration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const generated = path.join(here, '.generated');
const results = path.join(here, 'results');
const require = createRequire(import.meta.url);
const arg = name => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
const rounds = Number(arg('--rounds') ?? 20);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 500) throw new Error('--rounds must be an integer from 1 to 500');
const benchmark = process.argv.includes('--bench');
const audit = process.argv.includes('--audit');
await fs.mkdir(generated, { recursive: true });
await fs.mkdir(results, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const sourceFiles = ['types.ts', 'structures.ts', 'evidence.ts', 'grammar.ts', 'planner.ts', 'candidate-adapter.ts', 'entry.ts', 'stats.ts', 'corpus.ts', 'regimen.ts', 'integration.mjs', 'specialty-corpus.ts', 'cycles.ts', 'cycle-lexicon.ts', 'bounds.ts', 'admissibility.ts', 'acceptance.spec.ts', 'scheduler-primitives.ts'];
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(file).update(await fs.readFile(path.join(here, file)));
const metadata = { experimentalSourceSha256: sourceHash.digest('hex'), base: git('rev-parse', 'HEAD'), createdAt: new Date().toISOString(),
  node: process.version, cpu: os.cpus()[0]?.model, loadAverage: os.loadavg(), rounds,
  experiment: 'shadow boundary planner; production source unchanged' };

function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Instrumentation anchor changed: ${file}: ${before}`);
  return source.replace(before, after);
}

/** Build-time instrumentation and dependency substitution only; never edit src or published dist. */
async function bundle(candidate, instrumented) {
  const outfile = path.join(generated, `${candidate ? 'candidate' : 'native'}${instrumented ? '-instrumented' : ''}.cjs`);
  const statsPath = path.join(here, 'stats.ts');
  await build({ absWorkingDir: root, entryPoints: [path.join(here, 'entry.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'shadow-only', setup(b) {
      if (candidate) b.onResolve({ filter: /(?:^|\/)hpsg\/segmenter$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (resolved === path.join(root, 'src/hpsg/segmenter')) return { path: path.join(here, 'candidate-adapter.ts') };
      });
      b.onLoad({ filter: /\/(?:src\/(?:index|fhir|schedule|parser|hpsg\/(?:chart|segmenter|clause-parser)|lexer\/(?:lex|locales\/th)))\.ts$/ }, async args => {
        let text = await fs.readFile(args.path, 'utf8');
        if (candidate) text = candidateTransform(text, args.path) ?? text;
        if (!instrumented) return { contents: text, loader: 'ts' };
        const relative = path.relative(root, args.path);
        const prefix = `import { stats as experimentStats } from ${JSON.stringify(statsPath)};\n`;
        if (relative === 'src/parser.ts') text = replaceOnce(text,
          'export function parseClauseState(input: string, options?: ParseOptions): ParserState {',
          'export function parseClauseState(input: string, options?: ParseOptions): ParserState { experimentStats.clauseCalls++;', relative);
        if (relative === 'src/hpsg/segmenter.ts') {
          text = text.replace(/parseClauseState\(/g, 'experimentProbe(');
          text += '\nfunction experimentProbe(...args: Parameters<typeof parseClauseState>) { experimentStats.speculativeProbes++; return parseClauseState(...args); }\n';
        }
        if (relative === 'src/lexer/lex.ts') {
          const signature = /export function lexInput\([^)]*\)[^{]*\{/u.exec(text)?.[0];
          if (!signature) throw new Error('lexInput instrumentation anchor missing');
          text = replaceOnce(text, signature, `${signature} experimentStats.lexicalCalls++;`, relative);
        }
        if (relative === 'src/hpsg/chart.ts') {
          text = replaceOnce(text, 'const limit = options.limit ?? context.tokens.length;',
            'experimentStats.chartCalls++; const limit = options.limit ?? context.tokens.length;', relative);
          text = replaceOnce(text, 'const combined = rule.combine(context, left, right);',
            'experimentStats.combinationAttempts++; const combined = rule.combine(context, left, right);', relative);
          text = replaceOnce(text, 'return { signs, best };',
            'experimentStats.chartSigns += signs.length; experimentStats.agendaItems += processedAgendaItems; if (agendaCursor < agenda.length) experimentStats.chartTruncations++; return { signs, best };', relative);
        }
        return { contents: prefix + text, loader: 'ts' };
      });
    } }] });
  return require(outfile);
}

const native = await bundle(false, false);
const candidate = await bundle(true, false);
const instrumentedNative = await bundle(false, true);
const instrumentedCandidate = await bundle(true, true);
const corpus = native.CORPUS;

function actualCase(api, c) {
  const parsed = api.parseSig(c.input, c.options);
  const due = parsed.items.map(i => api.nextDueDoses(i.fhir, { ...api.SCHEDULE_OPTIONS, ...c.scheduleOptions }));
  const totals = parsed.items.map(i => api.calculateTotalUnits({ dosage: i.fhir, from: api.SCHEDULE_OPTIONS.from,
    timeZone: api.SCHEDULE_OPTIONS.timeZone, durationValue: c.totalDays ?? 70, durationUnit: 'd', ...c.scheduleOptions }));
  return { parsed, due, totals };
}
function clinical(result) {
  return { items: result.parsed.items.map(i => ({ fhir: i.fhir, leftover: i.meta.leftoverText, warnings: i.warnings,
    canonical: i.meta.canonical.clauses.map(c => ({ dose: c.dose, route: c.route, schedule: c.schedule, prn: c.prn })) })),
    due: result.due, totals: result.totals };
}
function goldenErrors(actual, c) {
  const errors = [];
  const eq = (field, got, wanted) => { if (!isDeepStrictEqual(got, wanted)) errors.push({ field, got, expected: wanted }); };
  eq('itemCount', actual.parsed.items.length, c.items.length);
  for (const [index, wanted] of c.items.entries()) {
    const item = actual.parsed.items[index];
    if (!item) continue;
    const fhir = item.fhir, repeat = fhir.timing?.repeat;
    if (c.noLeftovers !== false) eq(`items[${index}].leftover`, item.meta.leftoverText ?? '', '');
    const expected = [
      ['unit', fhir.doseAndRate?.[0]?.doseQuantity?.unit], ['period', repeat?.period], ['periodUnit',repeat?.periodUnit], ['frequency',repeat?.frequency], ['dose', fhir.doseAndRate?.[0]?.doseQuantity?.value], ['dates', fhir.timing?.event],
      ['clocks', repeat?.timeOfDay], ['when', repeat?.when], ['weekdays', repeat?.dayOfWeek],
      ['start', repeat?.boundsPeriod?.start], ['end', repeat?.boundsPeriod?.end],
      ['duration', item.meta.canonical.clauses[0]?.schedule?.duration ?? repeat?.boundsDuration?.value], ['due', actual.due[index]], ['totalUnits', actual.totals[index]?.totalUnits]
    ];
    for (const [key, got] of expected) if (key in wanted) eq(`items[${index}].${key}`, got, wanted[key]);
    if (wanted.noStart) eq(`items[${index}].start`, repeat?.boundsPeriod?.start, undefined);
    if (wanted.noDose) eq(`items[${index}].dose`, fhir.doseAndRate, undefined);
    if (wanted.noDuration) eq(`items[${index}].duration`, repeat?.boundsDuration, undefined);
  }
  return errors;
}
const correctness = [], executions = [];
for (const c of corpus) {
  const baseline = actualCase(native, c);
  const shadow = actualCase(candidate, c);
  const plan = candidate.planBoundaries(c.input, c.options, { trace: true });
  const baselineErrors = goldenErrors(baseline, c), candidateErrors = goldenErrors(shadow, c);
  const same = isDeepStrictEqual(clinical(baseline), clinical(shadow));
  executions.push({id:c.id,partition:c.partition,input:c.input,options:c.options,
    scheduleOptions:{...candidate.SCHEDULE_OPTIONS,...c.scheduleOptions},expected:c.items,
    phaseGraph:candidate.buildRegimenGraph(plan,plan.segments),
    items:shadow.parsed.items.map((item,index)=>({doseAndRate:item.fhir.doseAndRate,
      timing:{event:item.fhir.timing?.event,repeat:item.fhir.timing?.repeat},warnings:item.warnings,
      leftover:item.meta.leftoverText,due:shadow.due[index],totals:shadow.totals[index]}))});
  correctness.push({ id: c.id, family: c.family, partition: c.partition, history: c.history,
    baselinePass: !baselineErrors.length, candidatePass: !candidateErrors.length, sameClinicalOutput: same,
    baselineErrors, candidateErrors, input: c.input,
    baselineSegments: native.boundarySegments(c.input, c.options), candidateSegments: plan.segments,
    metrics: plan.metrics, conflicts: plan.decisions.filter(d => d.conflict).length,
    ...(!same || candidateErrors.length || c.id === 'reported-thai-date-list' ? { decisions: plan.decisions } : {}) });
}
const partitions = {};
for (const partition of ['historical', 'metamorphic', 'challenge', 'specialty']) {
  const rows = correctness.filter(r => r.partition === partition);
  partitions[partition] = { total: rows.length, baselinePassed: rows.filter(r => r.baselinePass).length,
    candidatePassed: rows.filter(r => r.candidatePass).length, sameClinicalOutput: rows.filter(r => r.sameClinicalOutput).length };
}
await fs.writeFile(path.join(results, 'correctness.json'), JSON.stringify({ metadata, partitions, cases: correctness }, null, 2) + '\n');
await fs.writeFile(path.join(results,'clinical-executions.json'),JSON.stringify({metadata,cases:executions},null,2)+'\n');
console.log('CORRECTNESS', JSON.stringify(partitions));
for (const row of correctness.filter(r => !r.candidatePass || process.argv.includes('--verbose') && !r.sameClinicalOutput)) console.log('DIFFERENCE', JSON.stringify({
  id: row.id, baselinePass: row.baselinePass, candidatePass: row.candidatePass, fields: row.candidateErrors.map(e => e.field) }));

// Diagnose shared execution failures with structured FHIR controls, independently of segmentation.
const totalsCase = corpus.find(c => c.id === 'list-th-26');
if (totalsCase) {
  const parsed = native.parseSig(totalsCase.input, totalsCase.options);
  const dosage = parsed.items[1].fhir;
  const options = { dosage, from: native.SCHEDULE_OPTIONS.from, timeZone: 'Asia/Bangkok', durationValue: 70, durationUnit: 'd' };
  const diagnostic = { metadata, case: totalsCase.id, input: totalsCase.input,
    dosage: { doseAndRate: dosage.doseAndRate, timing: dosage.timing },
    actualOccurrences: native.nextDueDoses(dosage, native.SCHEDULE_OPTIONS),
    defaultTotal: native.calculateTotalUnits(options),
    explicitBreakfastClockTotal: native.calculateTotalUnits({ ...options, eventClock: { CM: '08:00' } }),
    explicitTimeOfDayTotal: native.calculateTotalUnits({ ...options, dosage: { ...dosage,
      timing: { ...dosage.timing, repeat: { ...dosage.timing.repeat, when: undefined, timeOfDay: ['08:30:00'] } } } }) };
  await fs.writeFile(path.join(results, 'totals-diagnostic.json'), JSON.stringify(diagnostic, null, 2) + '\n');
}

const costRows = [];
for (const c of corpus) {
  instrumentedNative.resetStats(); instrumentedNative.parseSig(c.input, c.options);
  instrumentedCandidate.resetStats(); instrumentedCandidate.parseSig(c.input, c.options);
  costRows.push({ id: c.id, family: c.family, baseline: instrumentedNative.getStats(), candidate: instrumentedCandidate.getStats() });
}
const sumCosts = key => Object.fromEntries(Object.keys(costRows[0][key]).map(k => [k, costRows.reduce((s, r) => s + r[key][k], 0)]));
await fs.writeFile(path.join(results, 'costs.json'), JSON.stringify({ metadata, baseline: sumCosts('baseline'),
  candidate: sumCosts('candidate'), cases: costRows }, null, 2) + '\n');
console.log('COSTS', JSON.stringify({ baseline: sumCosts('baseline'), candidate: sumCosts('candidate') }));

const ablation = corpus.filter(c => c.partition === 'historical').map(c => {
  const full = candidate.planBoundaries(c.input, c.options);
  const unowned = candidate.planBoundaries(c.input, c.options, { ownership: false });
  const uncached = candidate.planBoundaries(c.input, c.options, { cache: false });
  return { id: c.id, fullMetrics: full.metrics, unownedMetrics: unowned.metrics, uncachedMetrics: uncached.metrics,
    unownedSameSegments: isDeepStrictEqual(full.segments, unowned.segments),
    uncachedSameSegments: isDeepStrictEqual(full.segments, uncached.segments) };
});
await fs.writeFile(path.join(results, 'ablations.json'), JSON.stringify({ metadata, cases: ablation }, null, 2) + '\n');

let performancePassed = true;
if (benchmark) {
  const torture = JSON.parse(await fs.readFile(path.join(root, 'test/real-world-torture-cases.json'), 'utf8'))
    .map(c => ({ id: c.name, input: c.input, options: { locale: c.locale, context: c.context, datePolicy: { referenceDate: '2026-09-27' } } }));
  const composed = corpus.filter(c => c.partition === 'historical' || c.partition === 'challenge');
  const specialty = corpus.filter(c => c.partition === 'specialty');
  const pct = (array, p) => [...array].sort((a, b) => a - b)[Math.min(array.length - 1, Math.ceil(array.length * p) - 1)];
  const summarize = samples => ({ meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50Ms: pct(samples, 0.5), p95Ms: pct(samples, 0.95), p99Ms: pct(samples, 0.99), parses: samples.length });
  const benches = [];
  for (const [name, cases] of [['torture', torture], ['composed', composed], ['specialty', specialty]]) {
    for (let w = 0; w < 3; w++) for (const c of cases) { native.parseSig(c.input, c.options); candidate.parseSig(c.input, c.options); }
    const samples = { baseline: [], candidate: [] }, epochRatios = [];
    for (let r = 0; r < rounds; r++) {
      const epoch = {};
      for (const lane of r % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const api = lane === 'baseline' ? native : candidate;
        let elapsed = 0;
        for (const c of cases) {
          const t = performance.now(); api.parseSig(c.input, c.options);
          const ms = performance.now() - t; samples[lane].push(ms); elapsed += ms;
        }
        epoch[lane] = elapsed;
      }
      epochRatios.push(epoch.candidate / epoch.baseline);
    }
    const baseline = summarize(samples.baseline), shadow = summarize(samples.candidate);
    benches.push({ name, cases: cases.length, baseline, candidate: shadow,
      meanRatio: shadow.meanMs / baseline.meanMs, p95Ratio: shadow.p95Ms / baseline.p95Ms,
      pairedRoundRatioMedian: pct(epochRatios, 0.5), pairedRoundRatios: epochRatios,
      performanceGate: name === 'specialty' ? shadow.p95Ms <= 100 : shadow.meanMs <= baseline.meanMs * 1.05 && shadow.p95Ms <= baseline.p95Ms * 1.05,
      gateBasis: name === 'specialty' ? 'p95 <= 100ms; old lane fails many new semantic cases, so ratio is descriptive only' : 'legacy corpus mean and p95 <= baseline * 1.05' });
    console.log('BENCH', JSON.stringify(benches.at(-1)));
  }
  performancePassed = benches.every(b => b.performanceGate);
  const scaling = [];
  for (const count of [1, 2, 4, 8, 16]) {
    const input = Array.from({ length: count }, (_, i) =>
      `take ${i % 2 + 1} tab at 08:00 on ${i + 1}/10/2026`).join(' and ');
    const options = { datePolicy: { referenceDate: '2026-09-27' } };
    const lanes = {};
    for (const [lane, api] of [['baseline', native], ['candidate', candidate]]) {
      api.parseSig(input, options);
      const ms = [];
      let itemCount = 0;
      for (let sample = 0; sample < 5; sample++) {
        const t = performance.now(); const parsed = api.parseSig(input, options); ms.push(performance.now() - t);
        itemCount = parsed.count;
      }
      lanes[lane] = { medianMs: pct(ms, 0.5), p95Ms: pct(ms, 0.95), itemCount };
    }
    scaling.push({ administrations: count, characters: input.length, ...lanes });
  }
  await fs.writeFile(path.join(results, 'scaling.json'), JSON.stringify({ metadata, cases: scaling }, null, 2) + '\n');
  console.log('SCALING', JSON.stringify(scaling));
  await fs.writeFile(path.join(results, 'performance.json'), JSON.stringify({ metadata,
    note: 'Uninstrumented full parseSig calls, paired AB/BA rounds; 5% noise allowance, no concurrent suite/build. Absolute times are machine-specific.', benches }, null, 2) + '\n');
}

if (audit) {
  const anchors = [
    ['5fca1fc', 'Omitted-head dose continuations and shared safety; clause boundary plus regimen scope'],
    ['245b697', 'Moved cheap lexical rejection ahead of repeated clause probes'],
    ['1f23c87', 'Comma/connector decision duplication and sync/async scope parity'],
    ['892e6fb', 'Carry administration context across omitted-head taper-chain segments'],
    ['d03174f', 'Adjacent timed doses and backward shared-duration propagation'],
    ['34f7bd1', 'Duration propagation before timing-only merge'],
    ['1f45525', 'Calendar span recognition and inter-clause date transition'],
    ['cb315c5', 'Bounds recognized as meaningful schedule across clause positions'],
    ['f7e5a2e', 'Date-clock pairing, schedule union versus sequence'],
    ['11b34f0', 'Date-list ownership protected comma but not all canonical coordinators']
  ];
  const history = anchors.map(([commit, interpretation]) => ({ commit: git('rev-parse', commit),
    subject: git('show', '-s', '--format=%s', commit), interpretation,
    files: git('diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n'),
    selectedDiff: git('show', '--format=', '--unified=2', commit, '--', 'src/hpsg/segmenter.ts', 'src/index.ts'),
    testAdditions: git('show', '--format=', '--unified=0', commit, '--', 'test').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).slice(0, 200) }));
  await fs.writeFile(path.join(results, 'history-audit.json'), JSON.stringify({ metadata,
    note: 'Selected causal audit, not an exhaustive census. File touches are not defect counts. Interpretations are engineering judgments supported by the retained diffs.', history }, null, 2) + '\n');
}

// A failed independent oracle stays failed. The runner never silently changes expected semantics.
const failedRequired = correctness.filter(r => r.partition !== 'challenge' && !r.candidatePass);
const failedChallenges = correctness.filter(r => r.partition === 'challenge' && !r.candidatePass);
const gates = { metadata, historical: partitions.historical.candidatePassed === partitions.historical.total,
  metamorphic: partitions.metamorphic.candidatePassed === partitions.metamorphic.total,
  challenges: failedChallenges.length === 0, specialty: partitions.specialty.candidatePassed === partitions.specialty.total,
  performance: benchmark ? performancePassed : null, unresolved: [...failedRequired, ...failedChallenges].map(c => c.id),
  productionPromotion: false,
  reason: 'This command records a shadow experiment; production promotion is never automatic. Read REPORT.md and validation/performance evidence.' };
await fs.writeFile(path.join(results, 'promotion-gates.json'), JSON.stringify(gates, null, 2) + '\n');
console.log('PROMOTION', failedRequired.length || failedChallenges.length || !performancePassed ? 'BLOCKED: an independent correctness/performance gate failed' : 'NOT AUTOMATIC: review all evidence');
if (failedRequired.length || process.argv.includes('--strict') && failedChallenges.length || !performancePassed) process.exitCode = 1;
