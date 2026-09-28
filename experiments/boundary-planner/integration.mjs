import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
function replace(source, anchor, replacement, count = 1) {
  if (source.split(anchor).length !== count + 1) throw new Error(`Candidate integration contract changed: ${anchor.slice(0, 100)}`);
  return source.split(anchor).join(replacement);
}

/** Build-only injection of real experimental components. No working-tree or published-source edits. */
export function candidateTransform(source, filename) {
  const file = filename.split('?')[0];
  if (file === path.join(root, 'src/index.ts')) {
    source = replace(source,
      'const segments = expandMealDashSegments(parseSigSegments(input, options), options);',
      'const boundaryPlan = createBoundaryPlan(input, options);\n  const segments = expandMealDashSegments(boundaryPlan.segments, options);', 3);
    source = replace(source, 'propagateDateTransitionEventTiming(rawResults, segments, input, options);',
      'composeRegimenPhases(rawResults, segments, boundaryPlan, options, formatSig);', 2);
    source = replace(source, 'propagateDateTransitionEventTiming(lintParseResults, segments, input, options);',
      'composeRegimenPhases(lintParseResults, segments, boundaryPlan, options, formatSig);');
    source = replace(source,
      '  const results = mergeParseResultList(rawResults, options);\n  propagateTrailingSharedSafety(results, options);',
      '  let results = mergeParseResultList(rawResults, options);\n  propagateTrailingSharedSafety(results, options);\n  const compatibilityPrimary = resolvePrimaryParseResult(results, input, options);\n  results = expandAdministrationTargets(results, options, formatSig);', 2);
    source = replace(source,
      '  const primary = resolvePrimaryParseResult(results, input, options);',
      '  const primary = compatibilityPrimary;', 2);
    source = replace(source,
      '  const primary = resolvePrimaryLintResult(results, input, options);',
      '  const expandedLintResults = expandLintAdministrationTargets(results, options, formatSig);\n  const primary = resolvePrimaryLintResult(expandedLintResults, input, options);');
    source = replace(source, '    count: results.length,\n    items: results,\n    result: primary.result,',
      '    count: expandedLintResults.length,\n    items: expandedLintResults,\n    result: primary.result,');
    return `import { createBoundaryPlan } from ${JSON.stringify(path.join(here, 'candidate-adapter.ts'))};\n` +
      `import { composeRegimenPhases } from ${JSON.stringify(path.join(here, 'regimen.ts'))};\n` +
      `import { expandAdministrationTargets, expandLintAdministrationTargets } from ${JSON.stringify(path.join(here, 'targets.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/date-interpretation.ts')) {
    source = replace(source,
      'const DATE_START_INCLUSIVE_LEAD_SOURCE = String.raw`(?:\\bfrom\\b\\s+|\\bstarting(?:\\s+(?:on|from))?\\b\\s+|ตั้งแต่(?:วันที่)?\\s*)`;',
      'const DATE_START_INCLUSIVE_LEAD_SOURCE = TEMPORAL_DATE_RELATION_SOURCES.startInclusive;');
    source = replace(source,
      'const DATE_START_EXCLUSIVE_LEAD_SOURCE = String.raw`(?:\\bafter\\b\\s+|หลัง(?:วันที่)?\\s*)`;',
      'const DATE_START_EXCLUSIVE_LEAD_SOURCE = TEMPORAL_DATE_RELATION_SOURCES.startExclusive;');
    source = replace(source,
      'const DATE_END_INCLUSIVE_LEAD_SOURCE = String.raw`(?:\\buntil\\b\\s+|\\bthrough\\b\\s+|\\btill\\b\\s+|(?:จน)?ถึง(?:วันที่)?\\s*)`;',
      'const DATE_END_INCLUSIVE_LEAD_SOURCE = TEMPORAL_DATE_RELATION_SOURCES.endInclusive;');
    source = replace(source,
      'const DATE_END_EXCLUSIVE_LEAD_SOURCE = String.raw`(?:\\bbefore\\b\\s+|ก่อน(?:วันที่)?\\s*)`;',
      'const DATE_END_EXCLUSIVE_LEAD_SOURCE = TEMPORAL_DATE_RELATION_SOURCES.endExclusive;');
    return `import { TEMPORAL_DATE_RELATION_SOURCES } from ${JSON.stringify(path.join(here,'temporal-relation-vocabulary.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/hpsg/rules/site-rules.ts')) {
    source = replace(source,
      '      const candidateLower = normalizeTokenLower(candidate);',
      '      const candidateLower = normalizeTokenLower(candidate);\n      if (temporalRelationStarts(context, cursor) || coordinationLeadsToSchedule(context, cursor)) break;');
    return `import { temporalRelationStarts, coordinationLeadsToSchedule } from ${JSON.stringify(path.join(here,'temporal-site-boundary.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/lexer/locales/th.ts')) {
    source = replace(source, '  "สัปดาห์ละครั้ง": "weekly",',
      '  "สัปดาห์ละครั้ง": "weekly",\n  "เดือนละครั้ง": "monthly",');
    source = replace(source,
      '  const prepared = splitThaiGrammarPrefixTokens(splitThaiDistributiveUnitTokens(tokens));',
      '  const dateBounded = splitTokensAtRecognizedThaiDateBoundaries(tokens, input, { locale: "th" });\n  const prepared = splitThaiGrammarPrefixTokens(splitThaiDistributiveUnitTokens(dateBounded));');
    return `import { splitTokensAtRecognizedThaiDateBoundaries } from ${JSON.stringify(path.join(here,'thai-date-token-boundaries.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/fhir.ts')) {
    source = replace(source, '  if (schedule?.frequencyMax !== undefined) {',
      '  normalizeAnchoredBounds(repeat, schedule);\n  if (schedule?.frequencyMax !== undefined) {');
    source = replace(source, '  if (hasRepeat) {', '  normalizeClockFrequency(repeat);\n  if (hasRepeat) {');
    return `import { normalizeAnchoredBounds, normalizeClockFrequency } from ${JSON.stringify(path.join(here, 'bounds.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/hpsg/clause-parser.ts')) {
    source = replace(source, '      calendarDateListRule(),',
      '      cycleScheduleRule(),\n      calendarDateListRule(),\n      openEndedBoundMarkerRule(),');
    source = replace(source, '      const conditions = getConditionFeatures(context);',
      "      if (rule.id !== 'hpsg.lex.schedule.finiteCycle' && insideCycle(context, start)) return [];\n      if (rule.id !== 'hpsg.lex.schedule.openEndedMarker' && insideOpenEndedMarker(context, start)) return [];\n      const conditions = getConditionFeatures(context);");
    return `import { cycleScheduleRule, insideCycle } from ${JSON.stringify(path.join(here, 'cycles.ts'))};\n` +
      `import { openEndedBoundMarkerRule, insideOpenEndedMarker } from ${JSON.stringify(path.join(here, 'open-ended.ts'))};\n` + source;
  }
  if (file === path.join(root, 'src/schedule.ts')) {
    source = replace(source,
      '  const lastDay = new Date(candidate.getTime());\n  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);\n  lastDay.setUTCDate(0);\n  const maxDay = getTimeParts(lastDay, timeZone).day;',
      '  const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();');

    const begin = '    const expanded = expandWhenCodes(whenCodes, config, repeat);';
    // Both occurrence and totals paths must use the SAME anchor-expansion implementation.
    const next = source.indexOf(begin), end = source.indexOf('    const includesImmediate', next);
    if (next < 0 || end < next) throw new Error('nextDueDoses anchor seam changed');
    source = source.slice(0, next) + '    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);\n' + source.slice(end);
    for (let remaining = 0; remaining < 2; remaining++) {
      const count = source.indexOf(begin), tail = source.indexOf('    if (arrayIncludes(whenCodes, EventTiming.Immediate))', count);
      if (count < 0 || tail < count) throw new Error('history/count anchor seam changed');
      source = source.slice(0, count) + '    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);\n\n' + source.slice(tail);
    }
    source = replace(source, 'const baseCandidate = effectiveOrderedAt ?? from;', 'const baseCandidate = effectiveOrderedAt ?? boundsStart ?? from;');
    source = replace(source, 'const baseCandidate = effectiveOrderedAt ?? countFrom;', 'const baseCandidate = effectiveOrderedAt ?? boundsStart ?? countFrom;');
    source = replace(source, '    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);',
      '    const cadenceAnchor = resolveRepeatBoundsStart(repeat, timeZone) ?? orderedAt ?? from;\n    const expanded = resolveExplicitClockEntries(repeat, config, enforceDayFilter);', 3);
    source = replace(source,
      'if (!enforceDayFilter || dayFilter.has(weekday)) {\n          for (const entry of expanded)',
      'if ((!enforceDayFilter || dayFilter.has(weekday)) && clockCadenceEligible(currentDay, cadenceAnchor, repeat, timeZone, enforceDayFilter)) {\n          for (const entry of expanded)', 3);
    source += `
const { resolveExplicitClockEntries, clockCadenceEligible } = createTimingPrimitives({
  expandWhenCodes, normalizeClock, inferWhenFallbackEntries, getLocalDayNumber, getLocalMonthIndex,
  getTimeParts, addCalendarMonths, isDateAlignedToPeriodCycle
});
`;
    source = `import { createTimingPrimitives } from ${JSON.stringify(path.join(here,'scheduler-primitives.ts'))};\n` + source;
    return source;
  }
  return undefined;
}
export function candidatePlugin() {
  return { name: 'experimental-regimen-composition', enforce: 'pre', transform(source, id) {
    const changed = candidateTransform(source, id); return changed === undefined ? undefined : { code: changed, map: null };
  } };
}
