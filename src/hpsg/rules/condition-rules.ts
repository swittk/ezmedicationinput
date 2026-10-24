import { AdviceArgumentRole, AdviceFrame, AdvicePolarity, FhirDayOfWeek, MedicationCondition, ParseOptions } from "../../types";
import {
  findMedicationDateListSpans,
  MedicationDateListMatch,
  parseMedicationDateListAt
} from "../../date-interpretation";
import { medicationInstructionActionIsSafetyScopeTarget, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { parseMedicationGuard } from "../../medication-condition";
import {
  ACTION_SEQUENCE_RELATION_SURFACES,
  relationHasGrammarFeature,
  resolveActionRelationSurface
} from "../../relation-terminology";
import { getProceduralFrames, actionEventRelationAt } from "../procedural-context";
import { hasSymptomOnsetPrnAt, startsMaximumCountLead } from "./prn-rules";
import { CALENDAR_UNIVERSAL_DAY_QUANTIFIERS, DOSE_TARGET_QUANTIFIERS, DOSE_TARGET_EVENT_MEMBERS, DOSE_TARGET_SLOT_HEADS } from "../lexical-classes";
import { EVENT_TIMING_TOKENS } from "../../maps";
import {
  HpsgClauseContext,
  lexicalRule,
  medicationGuardForContext,
  normalizeTokenLower,
  startsMedicationGuard
} from "../rule-context";
import {
  HpsgClinicalAdjunctFeature,
  HpsgConditionFeature,
  HpsgLexicalRule,
  lexicalSign
} from "../signature";

const DAYS = [
  FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday,
  FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday,
  FhirDayOfWeek.Sunday
] as const;

const WEEKDAYS: Array<{ day: FhirDayOfWeek; en: RegExp; th: RegExp }> = [
  { day: FhirDayOfWeek.Monday, en: /\bmon(?:day)?s?\b/giu, th: /(?:วัน)?จันทร์/gu },
  { day: FhirDayOfWeek.Tuesday, en: /\btue(?:sday)?s?\b/giu, th: /(?:วัน)?อังคาร/gu },
  { day: FhirDayOfWeek.Wednesday, en: /\bwed(?:nesday)?s?\b/giu, th: /(?:วัน)?พุธ/gu },
  { day: FhirDayOfWeek.Thursday, en: /\bthu(?:rsday)?s?\b/giu, th: /(?:วัน)?พฤหัส(?:บดี)?/gu },
  { day: FhirDayOfWeek.Friday, en: /\bfri(?:day)?s?\b/giu, th: /(?:วัน)?ศุกร์/gu },
  { day: FhirDayOfWeek.Saturday, en: /\bsat(?:urday)?s?\b/giu, th: /(?:วัน)?เสาร์/gu },
  { day: FhirDayOfWeek.Sunday, en: /\bsun(?:day)?s?\b/giu, th: /(?:วัน)?อาทิตย์/gu }
];

// ยกเว้นกรณี is a Boolean guard (unless), not a calendar exclusion.
const EXCLUSION_CUE = /\b(?:except|excluding)\b|ยกเว้น(?!\s*กรณี)|เว้น(?=วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์))/iu;

export interface CalendarExclusion {
  start: number;
  end: number;
  excluded: FhirDayOfWeek[];
  included: FhirDayOfWeek[];
  dates: string[];
}

export function containsCalendarExclusionCue(source: string): boolean {
  return EXCLUSION_CUE.test(source);
}

/** A universal weekday quantifier denotes the existing complete weekday
 * domain. It is NOT a post-parse schedule veto; the typed exclusion carries
 * all seven members and is editable alongside the original positive cadence.
 */
function universalDayScope(source: string): boolean {
  const words = source.trim().toLowerCase().split(/\s+/u);
  return words.length === 2 &&
    CALENDAR_UNIVERSAL_DAY_QUANTIFIERS.has(words[0]) &&
    (words[1] === "day" || words[1] === "days");
}

function uniqueDays(source: string): FhirDayOfWeek[] {
  const values = new Set<FhirDayOfWeek>();
  if (universalDayScope(source)) {
    for (const day of DAYS) values.add(day);
  }
  for (const definition of WEEKDAYS) {
    definition.en.lastIndex = 0;
    definition.th.lastIndex = 0;
    if (definition.en.test(source) || definition.th.test(source)) values.add(definition.day);
  }
  if (/\bweekends?\b/iu.test(source)) {
    values.add(FhirDayOfWeek.Saturday);
    values.add(FhirDayOfWeek.Sunday);
  }
  if (/\bweekdays?\b/iu.test(source)) {
    for (const day of DAYS.slice(0, 5)) values.add(day);
  }
  return DAYS.filter((day) => values.has(day));
}

function isOnlyWeekdays(source: string): boolean {
  if (universalDayScope(source)) return true;
  let remainder = source;
  for (const definition of WEEKDAYS) {
    definition.en.lastIndex = 0;
    definition.th.lastIndex = 0;
    remainder = remainder.replace(definition.en, " ").replace(definition.th, " ");
  }
  remainder = remainder.replace(/\b(?:weekends?|weekdays?|and|or|on|the|every|each)\b|(?:และ|หรือ|วัน|ทุก)|[\s,\/&+]+/giu, "");
  return remainder.length === 0;
}

/** Resolve the lexical payload for a typed calendar-exclusion sign. */
export function matchCalendarExclusion(
  source: string,
  options?: ParseOptions,
  knownDateSpans?: MedicationDateListMatch[]
): CalendarExclusion | undefined {
  const cue = EXCLUSION_CUE.exec(source);
  if (!cue) return undefined;
  const end = source.indexOf(";", cue.index) >= 0 ? source.indexOf(";", cue.index) : source.length;
  const rawStart = cue.index + cue[0].length;
  const rawSuffix = source.slice(rawStart, end);
  const leadingWhitespace = rawSuffix.search(/\S/u);
  if (leadingWhitespace < 0) return undefined;
  const suffixStart = rawStart + leadingWhitespace;
  const suffix = rawSuffix.slice(leadingWhitespace).replace(/\s+$/u, "");
  const excluded: FhirDayOfWeek[] = [];
  const included = uniqueDays(source.slice(0, cue.index));
  let residual = suffix;
  const dates: string[] = [];
  const prefixed = "on " + suffix.replace(/^on\s+/iu, "");
  const whole = parseMedicationDateListAt(prefixed, 0, options);
  if (whole && !whole.unresolved && whole.end === prefixed.length && whole.events.length) {
    for (const event of whole.events) dates.push(event.isoDate);
    residual = "";
  } else {
    const found = knownDateSpans
      ? knownDateSpans.filter((match) =>
        match.start >= suffixStart && match.end <= suffixStart + suffix.length
      ).map((match) => ({
        ...match,
        start: match.start - suffixStart,
        end: match.end - suffixStart
      }))
      : findMedicationDateListSpans(suffix, options);
    for (const match of [...found].sort((a, b) => b.start - a.start)) {
      if (match.unresolved || !match.events.length) return undefined;
      for (const event of match.events) dates.push(event.isoDate);
      residual = residual.slice(0, match.start) +
        " ".repeat(match.end - match.start) + residual.slice(match.end);
    }
  }
  residual = residual.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (value: string) => {
    const date = new Date(value + "T00:00:00Z");
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) {
      dates.push(value);
      return " ";
    }
    return value;
  });
  const weekdayValues = uniqueDays(residual);
  if (weekdayValues.length) excluded.push(...weekdayValues);
  if (residual.trim() && !isOnlyWeekdays(residual)) return undefined;
  if (!excluded.length && !dates.length) return undefined;
  return { start: cue.index, end, excluded, included, dates: [...new Set(dates)].sort() };
}

function overlappingAvailableTokens(
  context: HpsgClauseContext,
  start: number,
  end: number
) {
  return context.tokens.filter((token) =>
    token.sourceStart < end && start < token.sourceEnd &&
    !context.state.consumed.has(token.index)
  );
}

function tokenContainsOffset(
  context: HpsgClauseContext,
  tokenIndex: number,
  offset: number
): boolean {
  const token = context.tokens[tokenIndex];
  return Boolean(token && token.sourceStart <= offset && offset < token.sourceEnd);
}

function clinicalAdjunctSign(
  rule: string,
  context: HpsgClauseContext,
  tokens: ReturnType<typeof overlappingAvailableTokens>,
  feature: HpsgClinicalAdjunctFeature,
  consumedTokens = tokens
) {
  return lexicalSign({
    type: "clinical-adjunct-sign",
    rule,
    tokens,
    consumedTokenIndices: consumedTokens.map((token) => token.index),
    synsem: {
      head: {},
      valence: {},
      cont: { clauseKind: "administration", clinicalAdjunct: feature }
    },
    score: 56 + consumedTokens.length
  });
}

/** Exact nominal source ownership. A medication noun in some other argument
 * (e.g. an AFTER-taking activity) does not make the held object a drug dose. */
function tokenInActionArgument(
  context: HpsgClauseContext, start: number, end: number,
  frame: AdviceFrame, argument: AdviceFrame["args"][number]
): boolean {
  const argumentStart = argument.span?.start ?? context.state.input.indexOf(argument.text, frame.span.start);
  const argumentEnd = argument.span?.end ?? argumentStart + argument.text.length;
  return argumentStart >= frame.span.start && argumentEnd <= frame.span.end &&
    start >= argumentStart && end <= argumentEnd;
}

/**
 * A conditional withhold action contributes the inverse administration
 * guard, not a positive permission to administer when the HOLD predicate is
 * true.  Its object daughter must resolve to a medication-dose noun; holding
 * one's breath or retaining a physical object is a different lexical sense.
 * Predicate and object semantics are already part of the HPSG action frames.
 */
function withholdsMedicationAdministration(
  context: HpsgClauseContext,
  frame: AdviceFrame
): boolean {
  const action = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  const effect = action?.argumentParserConfig?.medicationConditionEffect;
  if (frame.polarity === AdvicePolarity.Negate || !effect) return false;
  // A bare "hold/omit/skip" is an elliptical medication-dose object under
  // this action's valence. It only becomes executable after the HPSG sign
  // unifies with a real administration head: applyClinicalAdjunct refuses
  // orphan predicates without a dose, method, site, or cadence. A physical
  // "hold your breath" has an explicit, nonmedication object and is excluded.
  if (!frame.args.length) return effect === "withhold";
  return frame.args.some((argument) => {
    if (argument.role !== AdviceArgumentRole.Object) return false;
    if (argument.conceptId === "medication-dose") return true;
    const words = context.tokens.filter((token) =>
      tokenInActionArgument(context, token.sourceStart, token.sourceEnd, frame, argument)
    ).map(normalizeTokenLower);
    if (words.some((word) => resolveMedicationInstructionConcept(
      word, context.options
    )?.code === "medication-dose")) return true;

    // A selected dose slot is a nominal head plus its event modifier, not a
    // food object. The typed conditionTarget below must subsequently bind to
    // an actual compatible administration daughter before it is executable.
    // Every object token must belong to that constituent: an explicit food
    // noun outside the slot head keeps its ordinary avoidance interpretation.
    return words.some((word) => DOSE_TARGET_SLOT_HEADS.has(word)) &&
      words.some((word) => DOSE_TARGET_EVENT_MEMBERS.has(EVENT_TIMING_TOKENS[word])) &&
      words.every((word) => DOSE_TARGET_SLOT_HEADS.has(word) ||
        DOSE_TARGET_EVENT_MEMBERS.has(EVENT_TIMING_TOKENS[word]) || DOSE_TARGET_QUANTIFIERS.has(word) ||
        resolveMedicationInstructionConcept(word, context.options)?.code === "product");
  });
}

/** Return an inverse condition only when the selected conditional construction
 * relates a typed withholding action to a medication-dose argument. */
function localWithholdingGuard(
  context: HpsgClauseContext,
  sourceStart: number,
  frame: AdviceFrame,
  sourceEnd?: number
) {
  const cached = medicationGuardForContext(context);
  if (!cached || cached.start !== sourceStart || !withholdsMedicationAdministration(context, frame)) {
    return undefined;
  }
  // A prefixed procedural condition ends at its typed action daughter even
  // without punctuation. Reuse the same Boolean lexical grammar on that
  // bounded constituent; do not let the action become part of a measurement.
  const guard = sourceEnd !== undefined && sourceEnd < cached.end
    ? parseMedicationGuard(context.state.input.slice(sourceStart, sourceEnd))
    : cached;
  if (!guard) return undefined;
  return guard.condition.kind === "not"
    ? guard.condition.condition
    : { kind: "not" as const, condition: guard.condition };
}

/** Resolve the nominal target inside a withholding action. Event words here
 * qualify the dose noun; they are not additional administration occurrences. */
function withholdingDoseTarget(
  context: HpsgClauseContext, frame: AdviceFrame
): NonNullable<HpsgClinicalAdjunctFeature["conditionTarget"]> {
  const target: NonNullable<HpsgClinicalAdjunctFeature["conditionTarget"]> = {};
  for (const argument of frame.args) {
    if (argument.role !== AdviceArgumentRole.Object) continue;
    // Exact source anchoring only: the grammatical tokens are reused, not
    // reparsed from a rendered phrase or interpreted by a second parser.
    for (const token of context.tokens) {
      if (!tokenInActionArgument(context, token.sourceStart, token.sourceEnd, frame, argument)) continue;
      const word = normalizeTokenLower(token);
      const quantifier = DOSE_TARGET_QUANTIFIERS.get(word);
      if (quantifier) target.quantifier = quantifier;
      const event = EVENT_TIMING_TOKENS[word];
      if (!event) continue;
      const members = DOSE_TARGET_EVENT_MEMBERS.get(event) ?? [event];
      target.when = [...new Set([...(target.when ?? []), ...members])];
    }
  }
  return target;
}

/** One typed effect shared by prefix/postfix IF constructions and the
 * medication adjunct sign. The condition owner and nominal target survive
 * until the related regimen daughters have been composed. */
function withholdingAdjunct(
  context: HpsgClauseContext,
  range: { start: number; end: number },
  frames: readonly AdviceFrame[]
): HpsgClinicalAdjunctFeature | undefined {
  for (const frame of frames) {
    const condition = localWithholdingGuard(context, range.start, frame, range.end);
    if (!condition) continue;
    return {
      condition,
      conditionTarget: withholdingDoseTarget(context, frame),
      localRanges: [range],
      evidence: [{
        rule: "hpsg.cx.medication-withholding-conditional",
        kind: "condition",
        ranges: [range]
      }]
    };
  }
  return undefined;
}

/** Medication guards are lexical adjuncts, separate from procedural IF scope. */
export function medicationGuardLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinical.condition", (context, start) => {
    const lead = context.tokens[start];
    if (!lead || context.state.consumed.has(lead.index) ||
        !startsMedicationGuard(context, start)) {
      return [];
    }
    const guard = medicationGuardForContext(context);
    if (!guard) return [];
    const tokens = overlappingAvailableTokens(context, guard.start, guard.end);
    if (!tokens.length) return [];
    const localRanges = [{ start: guard.start, end: guard.end }];
    if (guard.otherwise) localRanges.push({ ...guard.otherwise });
    const consumedTokens = overlappingAvailableTokens(
      context,
      Math.min(...localRanges.map((range) => range.start)),
      Math.max(...localRanges.map((range) => range.end))
    ).filter((token) => localRanges.some((range) =>
      token.sourceStart < range.end && range.start < token.sourceEnd
    ));
    // The procedural conditional construction owns which action this IF
    // modifies, for both prefix and postfix order. Its matcher calls the
    // pure frame helper, never this discovery function, so no recursion.
    const scoped = getConditionFeatures(context).find(feature => feature.sourceStart === guard.start);
    const withheld = scoped && withholdingAdjunct(context,
      { start: scoped.sourceStart, end: scoped.sourceEnd }, scoped.frames);
    return [clinicalAdjunctSign("hpsg.lex.clinical.condition", context, tokens, {
      condition: withheld?.condition ?? guard.condition,
      ...(withheld ? { conditionTarget: withheld.conditionTarget } : {}),
      localRanges,
      evidence: [{
        rule: "hpsg.lex.clinical.condition",
        kind: "condition",
        ranges: localRanges.map((range) => ({ ...range }))
      }]
    }, consumedTokens)];
  });
}

/** Weekday/date omissions are typed adjuncts; projection applies them to cadence. */
export function calendarExclusionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinical.calendar-exclusion", (context, start) => {
    const lead = context.tokens[start];
    if (!lead || context.state.consumed.has(lead.index) ||
        !/(?:except|excluding|ยกเว้น|เว้น)/iu.test(lead.sourceText ?? lead.original)) {
      return [];
    }
    const exclusion = matchCalendarExclusion(
      context.state.input,
      context.options,
      context.dateSpans
    );
    if (!exclusion) {
      const range = {
        start: lead.sourceStart,
        end: context.state.input.indexOf(";", lead.sourceStart) >= 0
          ? context.state.input.indexOf(";", lead.sourceStart)
          : context.state.input.length
      };
      const tokens = overlappingAvailableTokens(context, range.start, range.end);
      if (!tokens.length) return [];
      return [clinicalAdjunctSign(
        "hpsg.lex.clinical.calendar-exclusion.unresolved",
        context,
        tokens,
        {
          unresolved: true,
          localRanges: [range],
          evidence: [{
            rule: "hpsg.lex.clinical.calendar-exclusion.unresolved",
            kind: "unresolved",
            ranges: [range]
          }]
        }
      )];
    }
    if (!tokenContainsOffset(context, start, exclusion.start)) return [];
    const tokens = overlappingAvailableTokens(context, exclusion.start, exclusion.end);
    if (!tokens.length) return [];
    return [clinicalAdjunctSign("hpsg.lex.clinical.calendar-exclusion", context, tokens, {
      excludedDates: exclusion.dates,
      excludedWeekdays: exclusion.excluded,
      includedWeekdays: exclusion.included,
      localRanges: [{ start: exclusion.start, end: exclusion.end }],
      evidence: [{
        rule: "hpsg.lex.clinical.calendar-exclusion",
        kind: "calendar-exclusion",
        ranges: [{ start: exclusion.start, end: exclusion.end }]
      }]
    })];
  });
}

function isScopeTarget(context: HpsgClauseContext, frame: ReturnType<typeof getProceduralFrames>[number]): boolean {
  const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  return Boolean(
    frame.polarity === AdvicePolarity.Negate ||
    definition?.procedural ||
    medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
  );
}

function hasStrongBoundary(text: string): boolean {
  return /[.!?;]/u.test(text);
}

function explicitlySequences(
  context: HpsgClauseContext,
  startSource: number,
  endSource: number
): boolean {
  if (context.state.input.slice(startSource, endSource).includes(",")) return true;
  return context.tokens.some((token) =>
    startSource <= token.sourceStart && token.sourceEnd <= endSource &&
    ACTION_SEQUENCE_RELATION_SURFACES.has(normalizeTokenLower(token))
  );
}

function prefixProgram(
  context: HpsgClauseContext,
  firstTargetIndex: number,
  frames: ReturnType<typeof getProceduralFrames>
): typeof frames {
  const result = [frames[firstTargetIndex]];
  let previous = frames[firstTargetIndex];
  for (let index = firstTargetIndex + 1; index < frames.length; index += 1) {
    const next = frames[index];
    const gap = context.state.input.slice(previous.span.end, next.span.start);
    if (hasStrongBoundary(gap)) break;
    const linked = explicitlySequences(context, previous.span.end, next.span.start);
    if (!linked) break;
    result.push(next);
    previous = next;
  }
  return result;
}

function conditionTokens(
  context: HpsgClauseContext,
  startSource: number,
  endSource: number
) {
  return context.tokens.filter((token) =>
    token.sourceStart >= startSource && token.sourceEnd <= endSource && !context.state.consumed.has(token.index)
  );
}


/** Numeric comparisons own their operator phrases, including surface forms
 * that also introduce dosage caps in another grammatical position. */
function isQuantifiedCondition(condition: MedicationCondition): boolean {
  if (condition.kind === "measurement") return true;
  if (condition.kind === "not") return isQuantifiedCondition(condition.condition);
  if (condition.kind === "all" || condition.kind === "any") {
    return condition.conditions.length > 0 && condition.conditions.every(isQuantifiedCondition);
  }
  return false;
}

function postfixConditionEnd(context: HpsgClauseContext, start: number): number {
  const first = context.tokens[start];
  if (!first) return 0;
  const guard = medicationGuardForContext(context);
  const comparisonEnd = guard?.start === first.sourceStart && isQuantifiedCondition(guard.condition)
    ? guard.end : first.sourceStart;
  let end = context.state.input.length;
  for (let index = start + 1; index < context.limit; index += 1) {
    const current = context.tokens[index];
    if (!current) break;
    if (/^[.;!?]$/u.test(current.original.trim()) ||
        current.sourceStart >= comparisonEnd && startsMaximumCountLead(context, index)) {
      end = current.sourceStart;
      break;
    }
  }
  return end;
}

export function conditionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.condition", (context, start) => {
    const lead = context.tokens[start];
    if (!lead || context.state.consumed.has(lead.index)) return [];
    if (actionEventRelationAt(context, start)) return [];
    const relation = resolveActionRelationSurface(normalizeTokenLower(lead));
    if (!relation || !relationHasGrammarFeature(relation, "conditionalTail")) return [];
    if (relationHasGrammarFeature(relation, "symptomOnsetPrnLead") && hasSymptomOnsetPrnAt(context, start)) return [];

    const frames = getProceduralFrames(context).slice().sort((a, b) =>
      a.span.start - b.span.start || a.span.end - b.span.end
    );

    const nextIndex = frames.findIndex((frame) =>
      frame.span.start >= lead.sourceEnd && isScopeTarget(context, frame)
    );
    if (nextIndex >= 0) {
      const program = prefixProgram(context, nextIndex, frames);
      const targetStart = program[0].span.start;
      const targetEnd = program[program.length - 1].span.end;
      const tokens = conditionTokens(context, lead.sourceStart, targetStart);
      if (!tokens.length) return [];
      const conditionEnd = Math.max(...tokens.map((token) => token.sourceEnd));
      const text = context.state.input.slice(lead.sourceStart, conditionEnd).trim();
      const fullText = context.state.input.slice(lead.sourceStart, targetEnd).trim();
      const safety = program.some((frame) => isScopeTarget(context, frame) && (
        frame.polarity === AdvicePolarity.Negate ||
        medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
      ));
      const sourceRange = { start: lead.sourceStart, end: conditionEnd };
      const withheld = withholdingAdjunct(context, sourceRange, program);
      return [lexicalSign({
        type: "conditional-sign",
        rule: "hpsg.lex.condition",
        tokens,
        synsem: {
          head: {},
          valence: {},
          cont: {
            clauseKind: "administration",
            condition: {
              relation,
              text,
              fullText,
              sourceStart: lead.sourceStart,
              sourceEnd: conditionEnd,
              targetStart,
              targetEnd,
              safety,
              frames: program
            },
            ...(withheld ? { clinicalAdjunct: withheld } : {})
          }
        },
        score: 34 + tokens.length + program.length * 3
      })];
    }

    const previous = frames
      .filter((frame) => frame.span.end <= lead.sourceStart && isScopeTarget(context, frame))
      .sort((a, b) => b.span.end - a.span.end)[0];
    if (!previous) return [];
    const gap = context.state.input.slice(previous.span.end, lead.sourceStart);
    if (
      hasStrongBoundary(gap) ||
      (gap.trim() && !explicitlySequences(context, previous.span.end, lead.sourceStart))
    ) return [];
    const conditionEnd = postfixConditionEnd(context, start);
    const tokens = conditionTokens(context, lead.sourceStart, conditionEnd);
    if (!tokens.length) return [];
    const sourceEnd = Math.max(...tokens.map((token) => token.sourceEnd));
    const text = context.state.input.slice(lead.sourceStart, sourceEnd).trim();
    const fullText = context.state.input.slice(previous.span.start, sourceEnd).trim();
    const safety = previous.polarity === AdvicePolarity.Negate ||
      medicationInstructionActionIsSafetyScopeTarget(previous.predicate.lemma, context.options);
    const sourceRange = { start: lead.sourceStart, end: sourceEnd };
    const withheld = withholdingAdjunct(context, sourceRange, [previous]);
    return [lexicalSign({
      type: "conditional-sign",
      rule: "hpsg.lex.condition",
      tokens,
      synsem: {
        head: {},
        valence: {},
        cont: {
          clauseKind: "administration",
          condition: {
            relation,
            text,
            fullText,
            sourceStart: lead.sourceStart,
            sourceEnd,
            targetStart: previous.span.start,
            targetEnd: previous.span.end,
            safety,
            frames: [previous]
          },
          ...(withheld ? { clinicalAdjunct: withheld } : {})
        }
      },
      score: 34 + tokens.length
    })];
  });
}


const CONDITION_FEATURE_CACHE = new WeakMap<HpsgClauseContext, HpsgConditionFeature[]>();

export function getConditionFeatures(context: HpsgClauseContext): HpsgConditionFeature[] {
  const cached = CONDITION_FEATURE_CACHE.get(context);
  if (cached) return cached;
  const result: HpsgConditionFeature[] = [];
  const rule = conditionLexicalRule();
  for (let index = 0; index < context.limit; index += 1) {
    for (const sign of rule.match(context, index)) {
      const condition = sign.synsem.cont.condition;
      if (condition && !result.some((candidate) =>
        candidate.sourceStart === condition.sourceStart && candidate.sourceEnd === condition.sourceEnd
      )) result.push(condition);
    }
  }
  CONDITION_FEATURE_CACHE.set(context, result);
  return result;
}
