import { parseClauseState, findUnparsedTokenGroups } from '../../src/parser';
import { parseInstructionActions } from '../../src/instruction-graph';
import { resolveMedicationInstructionAction } from '../../src/instruction-action-terminology';
import { parseAdditionalInstructions } from '../../src/advice';
import { AdviceForce } from '../../src/types';
import { ACTION_COORDINATION_CONNECTORS, CLAUSE_LEAD_WORDS } from '../../src/hpsg/lexical-classes';
import type { AdviceFrame, ParseOptions } from '../../src/types';
import type { Token } from '../../src/parser-state';
import type { PlannerMetrics, ProbeSummary, Range } from './types';
import { lexeme } from './structures';
import { mayContainAdministrationTargetGroup, targetKeys } from './targets';

/** Per-input cache: no global results, no mutation of parser state, no cross-option reuse. */
export class EvidenceContext {
  private readonly cache = new Map<string, ProbeSummary>();
  private readonly actionCache = new Map<string, AdviceFrame[]>();
  private allActions?: AdviceFrame[];
  constructor(readonly input: string, readonly tokens: Token[], readonly options: ParseOptions | undefined,
    readonly metrics: PlannerMetrics, readonly cacheEnabled: boolean) {}

  probe(start: number, end: number): ProbeSummary {
    while (start < end && /\s/u.test(this.input[start])) start++;
    while (end > start && /[\s,;]/u.test(this.input[end - 1])) end--;
    const key = `${start}:${end}`;
    const cached = this.cacheEnabled ? this.cache.get(key) : undefined;
    if (cached) { this.metrics.probeCacheHits++; return cached; }
    const state = parseClauseState(this.input.slice(start, end), this.options);
    this.metrics.clauseProbes++; this.metrics.probedTokens += state.tokens.length;
    const c = state.primaryClause, s = c.schedule;
    const hasTargetCoordinator = state.tokens.some(token =>
      token.original === ',' || ACTION_COORDINATION_CONNECTORS.has(lexeme(token)));
    const directTarget = c.site?.text?.trim().toLowerCase().replace(/\s+/gu, ' ') ||
      (c.site?.coding?.code ? 'code:' + c.site.coding.code : undefined);
    const probeSource = this.input.slice(start, end);
    const targets = (c.site?.text || c.site?.coding)
      ? hasTargetCoordinator && mayContainAdministrationTargetGroup(probeSource, this.options, state.tokens)
        ? targetKeys(probeSource, this.options)
        : directTarget ? [directTarget] : []
      : [];
    const summary: ProbeSummary = {
      start, end, clause: c,
      complete: findUnparsedTokenGroups(state).length === 0,
      hasHead: Boolean(c.method?.coding?.code || c.method?.text || c.dose?.value !== undefined || c.dose?.range ||
        c.site?.coding?.code || c.site?.text || c.patientInstruction || c.additionalInstructions?.length),
      hasDose: Boolean(c.dose),
      method: Boolean(c.method?.coding?.code || c.method?.text),
      hasSchedule: Boolean(s && (s.frequency !== undefined || s.frequencyMax !== undefined || s.period !== undefined ||
        s.periodMax !== undefined || s.duration !== undefined || s.durationMax !== undefined || s.boundsStart !== undefined ||
        s.boundsEnd !== undefined || s.count !== undefined || s.timingCode || s.dayOfWeek?.length || s.when?.length ||
        s.timeOfDay?.length || s.calendarEvents?.length)),
      hasRecurringCadence: Boolean(s && (s.timingCode || s.frequency !== undefined || s.period !== undefined || s.dayOfWeek?.length)),
      hasDates: Boolean(s?.calendarEvents?.length), hasClocks: Boolean(s?.timeOfDay?.length),
      clocks: [...(s?.timeOfDay ?? [])].sort(),
      hasOffset: Boolean(s && (s.offset !== undefined || s.offsetMin !== undefined || s.offsetMax !== undefined ||
        s.activityTiming?.some(t => t.offset !== undefined || t.offsetMin !== undefined || t.offsetMax !== undefined))),
      prn: c.prn?.enabled === true,
      targets,
      hasTargets: targets.length > 0,
      conditionStarts: c.evidence.filter(e => e.rule === 'hpsg.lex.condition').flatMap(e => e.spans.map(r => r.start + start))
    };
    if (this.cacheEnabled) this.cache.set(key, summary);
    return summary;
  }

  actions(start: number, end: number): AdviceFrame[] {
    const key = `${start}:${end}`;
    const cached = this.cacheEnabled ? this.actionCache.get(key) : undefined;
    if (cached) return cached;
    this.metrics.actionScans++;
    const value = parseInstructionActions(this.input.slice(start, end).trim(), 0, this.options);
    if (this.cacheEnabled) this.actionCache.set(key, value);
    return value;
  }

  /** A procedural relation is established by action frames and terminology, not connector spelling. */
  proceduralBridge(range: Range): boolean {
    if (!this.allActions) this.allActions = this.actions(0, this.input.length);
    let left: AdviceFrame | undefined, right: AdviceFrame | undefined;
    for (const action of this.allActions) {
      if (action.span.start < range.start && action.span.end <= range.end + 1) {
        if (!left || action.span.end > left.span.end) left = action;
      } else if (action.span.start >= range.end && (!right || action.span.start < right.span.start)) right = action;
    }
    return Boolean(left && right && resolveMedicationInstructionAction(left.predicate.lemma, this.options)?.procedural &&
      Math.max(0, range.start - left.span.end) <= 2 && Math.max(0, right.span.start - range.end) <= 2);
  }

  instructionContinuation(index: number, end: number): boolean {
    const lead = this.tokens[index], first = this.tokens[index + 1];
    if (!lead || !first || !CLAUSE_LEAD_WORDS.has(lexeme(lead))) return false;
    const start = first.sourceStart;
    return parseAdditionalInstructions(this.input.slice(start, end).replace(/\s+/g, ' ').trim(), { start, end }, {
      defaultPredicate: lexeme(lead), defaultForce: AdviceForce.Instruction, allowFreeTextFallback: false
    }).some(i => i.coding?.code || i.frames.length);
  }
}
