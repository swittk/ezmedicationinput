import { resolveBodySitePhrase } from '../../src/body-site-grammar';
import { lexInput } from '../../src/lexer/lex';
import { annotateLexTokens } from '../../src/lexer/meaning';
import { ACTION_COORDINATION_CONNECTORS, ACTION_SEQUENCE_MARKERS } from '../../src/hpsg/lexical-classes';
import { buildInstructionGraphExtension, MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from '../../src/instruction-graph-fhir';
import type { BodySiteCode, CanonicalSiteExpr, FhirCodeableConcept, LintResult, ParseOptions, ParseResult } from '../../src/types';
import type { Token } from '../../src/parser-state';

export interface AdministrationTarget {
  start: number;
  end: number;
  text: string;
  key: string;
  coding?: BodySiteCode;
  i18n?: Record<string, string>;
  administrationTargetCount?: number;
}
type Render = (dosage: ParseResult['fhir'], style: 'short' | 'long', options?: ParseOptions) => string;
const normalize = (value: string) => value.toLowerCase().replace(/[.,;:!?]+$/gu, '').replace(/\s+/gu, ' ').trim();

function bodySiteCode(value: { code?: string; display?: string; system?: string; i18n?: Record<string,string> } | undefined): BodySiteCode | undefined {
  return value?.code ? { code: value.code, display: value.display, system: value.system, i18n: value.i18n } : undefined;
}

/**
 * Find independently resolvable administration targets without assuming a
 * particular anatomy. Coordinators terminate a target atom; a pre-coordinated
 * coded site such as "both eyes" remains one target.
 */
export function recognizeAdministrationTargets(input: string, options?: ParseOptions): AdministrationTarget[] {
  const tokens = annotateLexTokens(lexInput(input));
  const out: AdministrationTarget[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens.slice(i, i + 1)[0];
    const lexeme = (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/gu, '');
    if (ACTION_COORDINATION_CONNECTORS.has(lexeme) || ACTION_SEQUENCE_MARKERS.has(lexeme) || /[.,;:!?]/u.test(token.original)) continue;
    let best: AdministrationTarget | undefined;
    let bestEnd = i;
    for (let end = i; end < Math.min(tokens.length, i + 6); end++) {
      const current = tokens[end];
      const currentLex = (current.canonical ?? current.lower).replace(/^[.,;:]+|[.,;:]+$/gu, '');
      if (end > i && (ACTION_COORDINATION_CONNECTORS.has(currentLex) || ACTION_SEQUENCE_MARKERS.has(currentLex) || /[.,;:!?]/u.test(current.original))) break;
      const text = input.slice(token.sourceStart, current.sourceEnd).trim();
      const resolved = resolveBodySitePhrase(text, options?.siteCodeMap, {
        bodySiteContext: options?.context?.bodySiteContext,
        allowTerminalModifierInheritance: true
      });
      if (!resolved || (!resolved.coding && !resolved.definition)) continue;
      best = {
        start: token.sourceStart,
        end: current.sourceEnd,
        text: resolved.displayText || text,
        key: resolved.resolutionCanonical || resolved.canonical || normalize(text),
        coding: resolved.coding?.code ? {
          code: resolved.coding.code,
          system: resolved.coding.system,
          display: resolved.coding.display
        } : undefined,
        i18n: resolved.definition?.i18n,
        administrationTargetCount: resolved.definition?.administrationTargetCount
      };
      bestEnd = end;
    }
    if (best) {
      out.push(best);
      i = bestEnd;
    }
  }
  const whole = resolveBodySitePhrase(input.trim(), options?.siteCodeMap, {
    bodySiteContext: options?.context?.bodySiteContext,
    allowTerminalModifierInheritance: true
  });
  if (whole?.coding && out.length > 1) {
    return [{
      start: 0,
      end: input.length,
      text: whole.displayText || input.trim(),
      key: whole.resolutionCanonical || whole.canonical,
      coding: whole.coding?.code ? {
        code: whole.coding.code,
        system: whole.coding.system,
        display: whole.coding.display
      } : undefined,
      i18n: whole.definition?.i18n,
      administrationTargetCount: whole.definition?.administrationTargetCount
    }];
  }
  const unique: AdministrationTarget[] = [];
  for (const target of out) {
    if (!unique.some(value => value.start === target.start && value.end === target.end)) unique.push(target);
  }
  return unique;
}


function targetLexeme(token: Token | undefined): string {
  return token ? (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/gu, '') : '';
}
function resolvedTargetText(text: string, options?: ParseOptions): boolean {
  const resolved = resolveBodySitePhrase(text, options?.siteCodeMap, {
    bodySiteContext: options?.context?.bodySiteContext,
    allowTerminalModifierInheritance: true
  });
  return Boolean(resolved?.coding || resolved?.definition);
}
/**
 * Cheap prefilter for compound-target ownership. It inspects only bounded spans
 * adjacent to an actual coordinator; ordinary procedural coordination never
 * triggers the full target decomposition pass.
 */
export function mayContainAdministrationTargetGroup(
  input: string,
  options?: ParseOptions,
  suppliedTokens?: Token[]
): boolean {
  const tokens = suppliedTokens ?? annotateLexTokens(lexInput(input));
  for (let index = 0; index < tokens.length; index++) {
    const connector = tokens[index];
    const lexeme = targetLexeme(connector);
    if (connector.original !== ',' && !ACTION_COORDINATION_CONNECTORS.has(lexeme)) continue;
    let left = false, right = false;
    for (let width = 1; width <= 3 && index - width >= 0; width++) {
      const first = tokens[index - width], last = tokens[index - 1];
      if (resolvedTargetText(input.slice(first.sourceStart, last.sourceEnd), options)) { left = true; break; }
    }
    if (!left) continue;
    for (let width = 1; width <= 3 && index + width < tokens.length; width++) {
      const first = tokens[index + 1], last = tokens[index + width];
      if (resolvedTargetText(input.slice(first.sourceStart, last.sourceEnd), options)) { right = true; break; }
    }
    if (right) return true;
  }
  return false;
}

export interface AdministrationTargetGroup {
  start: number;
  end: number;
  targets: AdministrationTarget[];
  coordination: 'conjunction' | 'disjunction' | 'mixed';
}
function targetCoordinator(text: string): AdministrationTargetGroup['coordination'] | undefined {
  const tokens = annotateLexTokens(lexInput(text));
  if (!tokens.length) return undefined;
  let conjunctive = false;
  let disjunctive = false;
  for (const token of tokens) {
    const value = (token.canonical ?? token.lower).replace(/^[.,;:]+|[.,;:]+$/gu, '');
    if (token.original === ',') { conjunctive = true; continue; }
    if (!ACTION_COORDINATION_CONNECTORS.has(value)) return undefined;
    if (value === 'or' || value === 'and/or') disjunctive = true;
    else conjunctive = true;
  }
  return conjunctive && disjunctive ? 'mixed' : disjunctive ? 'disjunction' : 'conjunction';
}
/** Coordinated target lists are owned structures; schedule/date text between targets breaks the group. */
export function recognizeAdministrationTargetGroups(input: string, options?: ParseOptions): AdministrationTargetGroup[] {
  const targets = recognizeAdministrationTargets(input, options);
  const groups: AdministrationTargetGroup[] = [];
  let current: AdministrationTarget[] = [];
  let coordination: AdministrationTargetGroup['coordination'] | undefined;
  const flush = () => {
    if (current.length > 1 && coordination) {
      groups.push({ start: current[0].start, end: current[current.length - 1].end, targets: [...current], coordination });
    }
  };
  for (const target of targets) {
    if (!current.length) {
      current = [target];
      coordination = undefined;
      continue;
    }
    const previous = current[current.length - 1];
    const connector = targetCoordinator(input.slice(previous.end, target.start));
    if (connector) {
      current.push(target);
      coordination = !coordination ? connector : coordination === connector ? coordination : 'mixed';
      continue;
    }
    flush();
    current = [target];
    coordination = undefined;
  }
  flush();
  return groups;
}

export function targetKeys(input: string, options?: ParseOptions): string[] {
  return [...new Set(recognizeAdministrationTargets(input, options).map(target => target.key))].sort();
}
function canonicalTarget(target: AdministrationTarget): CanonicalSiteExpr {
  return {
    text: target.text,
    i18n: target.i18n,
    coding: target.coding,
    administrationTargetCount: target.administrationTargetCount,
    source: 'text'
  };
}
function fhirTarget(target: AdministrationTarget): FhirCodeableConcept {
  return {
    text: target.text,
    ...(target.coding ? { coding: [{ system: target.coding.system, code: target.coding.code, display: target.coding.display }] } : {})
  };
}
function targetOwnsLeftover(text: string, targets: AdministrationTarget[]): boolean {
  const value = normalize(text);
  return targets.some(target => normalize(target.text) === value || normalize(target.key) === value);
}

function groupMatchesParsedSite(group: AdministrationTargetGroup, result: ParseResult): boolean {
  const parsed = result.meta.canonical.clauses
    .map(clause => clause.site?.text)
    .filter((value): value is string => Boolean(value))
    .map(normalize);
  const atoms = group.targets.flatMap(target => [normalize(target.text), normalize(target.key)]);
  if (parsed.some(site =>
    atoms.some(atom => site === atom) ||
    group.targets.every(target => site.indexOf(normalize(target.text)) >= 0 || site.indexOf(normalize(target.key)) >= 0)
  )) return true;

  // Locale-neutral ownership: the parsed site's HPSG evidence must overlap the
  // structural target group. Evidence is rebased to the caller input, while the
  // group is relative to the joined clause source, so translate each clause span.
  let joinedOffset = 0;
  for (const clause of result.meta.canonical.clauses) {
    const rawStart = clause.raw.start;
    for (const evidence of clause.evidence ?? []) {
      if (!evidence.rule.startsWith('hpsg.lex.site')) continue;
      for (const span of evidence.spans) {
        const start = joinedOffset + Math.max(0, span.start - rawStart);
        const end = joinedOffset + Math.max(0, span.end - rawStart);
        if (start < group.end && end > group.start) return true;
      }
    }
    joinedOffset += clause.rawText.length + 1;
  }
  return false;
}

function cloneResult(result: ParseResult): ParseResult {
  return JSON.parse(JSON.stringify(result)) as ParseResult;
}

function removeTargetOwnedOpaqueGraph(item: ParseResult, targets: AdministrationTarget[]): void {
  for (const clause of item.meta.canonical.clauses) {
    const graph = clause.instructionGraph;
    if (!graph) continue;
    graph.opaqueSpans = (graph.opaqueSpans ?? []).filter(span => !targetOwnsLeftover(span.text, targets));
    if (graph.coverage) {
      const opaqueCharacters = (graph.opaqueSpans ?? []).reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
      graph.coverage.opaqueCharacters = opaqueCharacters;
      graph.coverage.complete = opaqueCharacters === 0;
      if (graph.sourceText.length) {
        graph.coverage.ratio = Math.min(1, Math.max(0, graph.coverage.understoodCharacters / graph.sourceText.length));
      }
    }
    if (!graph.actions.length && !graph.opaqueSpans?.length) delete clause.instructionGraph;
  }
  const retained = (item.fhir.extension ?? []).filter(extension => extension.url !== MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL);
  const graphExtension = buildInstructionGraphExtension(item.meta.canonical.clauses[0]?.instructionGraph);
  item.fhir.extension = graphExtension ? [...retained, graphExtension] : retained.length ? retained : undefined;
}

/**
 * FHIR Dosage.site is singular. A grammatical multi-target administration is
 * therefore duplicated only at lowering time; phase/timing semantics remain shared.
 */
export function expandAdministrationTargets(
  results: ParseResult[],
  options: ParseOptions | undefined,
  render: Render
): ParseResult[] {
  const output: ParseResult[] = [];
  for (const result of results) {
    const source = result.meta.canonical.clauses.map(clause => clause.rawText).join(' ');
    const needsCompoundAnalysis = result.meta.canonical.clauses.some(clause =>
      Boolean(clause.site) && (!clause.site?.coding || Boolean(clause.leftovers?.length)));
    if (!needsCompoundAnalysis) {
      output.push(result);
      continue;
    }
    const groups = recognizeAdministrationTargetGroups(source, options);
    const conjunction = groups.find(group => group.coordination === 'conjunction' && groupMatchesParsedSite(group, result));
    const alternative = groups.find(group => group.coordination !== 'conjunction' && groupMatchesParsedSite(group, result));
    const hasParsedSite = result.meta.canonical.clauses.some(clause => Boolean(clause.site?.text || clause.site?.coding));
    if (!hasParsedSite || !conjunction) {
      if (hasParsedSite && alternative) {
        const warning = 'Alternative administration targets retained as text; not expanded into simultaneous Dosage items.';
        if (result.warnings.indexOf(warning) < 0) result.warnings.push(warning);
        for (const clause of result.meta.canonical.clauses) {
          clause.warnings = [...(clause.warnings ?? []), warning];
        }
      }
      output.push(result);
      continue;
    }
    const targets = conjunction.targets;
    for (const target of targets) {
      const item = cloneResult(result);
      item.fhir.site = fhirTarget(target);
      for (const clause of item.meta.canonical.clauses) {
        clause.site = canonicalTarget(target);
        clause.leftovers = (clause.leftovers ?? []).filter(leftover => !targetOwnsLeftover(leftover.text, targets));
      }
      const leftovers = item.meta.canonical.clauses.flatMap(clause => clause.leftovers ?? []).map(value => value.text).filter(Boolean);
      item.meta.leftoverText = leftovers.length ? [...new Set(leftovers)].join(' ') : undefined;
      removeTargetOwnedOpaqueGraph(item, targets);
      item.longText = render(item.fhir, 'long', options);
      item.shortText = render(item.fhir, 'short', options);
      item.fhir.text = item.longText;
      output.push(item);
    }
  }
  return output;
}
export function expandLintAdministrationTargets(
  items: LintResult[],
  options: ParseOptions | undefined,
  render: Render
): LintResult[] {
  return items.flatMap(entry => {
    const targets = recognizeAdministrationTargets(entry.result.meta.canonical.clauses.map(clause => clause.rawText).join(' '), options);
    return expandAdministrationTargets([entry.result], options, render).map(result => ({
      result,
      issues: entry.issues.filter(issue => !targetOwnsLeftover(issue.text, targets))
    }));
  });
}
