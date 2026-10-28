import { medicationGuardLeadLexeme, CIRCUMSTANTIAL_CONDITION_HEADS } from "../../medication-condition";
import { registeredActivityDayAt } from "./instruction-rules";
import { AdviceArgumentRole, AdviceFrame, AdvicePolarity, AdviceRelation, EventTiming, FhirDayOfWeek, MedicationCondition, ParseOptions } from "../../types";
import {
  findMedicationDateListSpans,
  MedicationDateListMatch,
  parseMedicationDateListAt
} from "../../date-interpretation";
import { medicationInstructionActionIsSafetyScopeTarget, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import { parseMedicationGuard, scopeMedicationGuardSign } from "../constructions";
import {
  relationHasGrammarFeature,
  resolveActionRelationSurface
} from "../../relation-terminology";
import { getProceduralFrames, actionEventRelationAt, conditionalAdviceOwnerAt, isConditionalAdviceFrame, instructionActionsAreSequenced as explicitlySequences, proceduralInstructionProgram as prefixProgram } from "../procedural-context";
import { hasSymptomOnsetPrnAt, startsMaximumCountLead } from "./prn-rules";
import { SUPPLEMENTAL_DOSE_MODIFIERS, CALENDAR_COMPLEMENT_DAY_MODIFIERS, CALENDAR_COMPLEMENT_DETERMINERS, CALENDAR_UNIVERSAL_DAY_QUANTIFIERS, DOSE_TARGET_QUANTIFIERS, DOSE_TARGET_MERIDIEM_CLOCK_RANGES, DOSE_TARGET_DAYPART_CLOCK_RANGES, DOSE_TARGET_EVENT_MEMBERS, DOSE_TARGET_SLOT_HEADS } from "../lexical-classes";
import { EVENT_TIMING_TOKENS } from "../../maps";
import { countAndDurationRule, timeOfDayRule, timingLexicalRule, dayRangeLexicalRule } from "./timing-rules";
import { LexKind } from "../../lexer/token-types";
import { normalizeUnit } from "../../unit-lexicon";
import { mapIntervalUnit } from "../timing-lexicon";
import {
  HpsgClauseContext,
  lexicalRule,
  tokensAvailable,
  rangeFromTokens,
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
  const phrase = source.trim().replace(/[.!?]+$/u, "").trim();
  if (universalDayScope(phrase)) return true;
  let remainder = phrase;
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
  knownDateSpans?: MedicationDateListMatch[],
  scopeEnd?: number
): CalendarExclusion | undefined {
  const cue = EXCLUSION_CUE.exec(source);
  if (!cue) return undefined;
  const clauseEnd = source.indexOf(";", cue.index) >= 0
    ? source.indexOf(";", cue.index)
    : source.length;
  const end = Math.min(clauseEnd, scopeEnd ?? clauseEnd);
  const rawStart = cue.index + cue[0].length;
  const rawSuffix = source.slice(rawStart, end);
  const leadingWhitespace = rawSuffix.search(/\S/u);
  if (leadingWhitespace < 0) return undefined;
  const suffixStart = rawStart + leadingWhitespace;
  const suffix = rawSuffix.slice(leadingWhitespace).replace(/\s+$/u, "");
  const excluded: FhirDayOfWeek[] = [];
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
  return { start: cue.index, end, excluded, dates: [...new Set(dates)].sort() };
}

const COURSE_DURATION_RULE = countAndDurationRule();

/** Locate a trailing typed course-duration daughter without consuming it as
 * part of the weekday/date exclusion. The shared timing rule remains the
 * authority for which article/quantity/modifier/unit forms are licensed. */
function trailingCourseDurationBoundary(
  context: HpsgClauseContext,
  exclusionStart: number,
  clauseEnd: number
): number | undefined {
  let boundary: number | undefined;
  for (let index = 0; index < context.limit; index += 1) {
    const token = context.tokens[index];
    if (!token || token.sourceStart <= exclusionStart || token.sourceStart >= clauseEnd) continue;
    for (const sign of COURSE_DURATION_RULE.match(context, index)) {
      if (sign.synsem.head.schedule?.duration === undefined || !sign.tokens.length) continue;
      const start = Math.min(...sign.tokens.map((item) => item.sourceStart));
      const end = Math.max(...sign.tokens.map((item) => item.sourceEnd));
      if (start <= exclusionStart || end > clauseEnd ||
          !/^[\s.,!?]*$/u.test(context.state.input.slice(end, clauseEnd))) continue;
      boundary = boundary === undefined ? start : Math.min(boundary, start);
    }
  }
  return boundary;
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
  const prohibitedAdministration = frame.polarity === AdvicePolarity.Negate &&
    (action?.primaryAdministrationHead || action?.definesDose && action.administrationMethod);
  const effect = prohibitedAdministration ? "withhold" : action?.argumentParserConfig?.medicationConditionEffect;
  if (frame.polarity === AdvicePolarity.Negate && !prohibitedAdministration || !effect) return false;
  // A bare "hold/omit/skip" is an elliptical medication-dose object under
  // this action's valence. It only becomes executable after the HPSG sign
  // unifies with a real administration head: applyClinicalAdjunct refuses
  // orphan predicates without a dose, method, site, or cadence. A physical
  // "hold your breath" has an explicit, nonmedication object and is excluded.
  if (!frame.args.length || frame.args.every(argument =>
      argument.role === AdviceArgumentRole.Time || argument.role === AdviceArgumentRole.Duration)) {
    return effect === "withhold";
  }
  return frame.args.some((argument) => {
    // Registered avoidance uses a Theme argument, whereas HOLD uses Object.
    // A medication/product noun is a legitimate explicit medication target;
    // unrelated food, breath, container and activity objects remain distinct.
    if (argument.role !== AdviceArgumentRole.Object && argument.role !== AdviceArgumentRole.Theme) return false;
    const nominalTokens = context.tokens.filter(token =>
      tokenInActionArgument(context, token.sourceStart, token.sourceEnd, frame, argument));
    const words = nominalTokens.map(normalizeTokenLower);
    // An explicitly supplemental dose is a distinct referent, not the
    // standing administration whose clinical guard is being constructed.
    if (words.some(word => SUPPLEMENTAL_DOSE_MODIFIERS.has(word))) return false;
    if (argument.conceptId === "medication-dose" || argument.conceptId === "product") return true;
    // A registered withholding predicate can select a temporal noun with an
    // elliptical DOSE head (hold 20:00 / omit PM). Physical objects remain
    // distinct; every token must belong to the temporal nominal constituent.
    const temporal = (token: typeof nominalTokens[number]) => token.kind === LexKind.TimeLike ||
      DOSE_TARGET_EVENT_MEMBERS.has(EVENT_TIMING_TOKENS[normalizeTokenLower(token)]) ||
      DOSE_TARGET_MERIDIEM_CLOCK_RANGES.has(normalizeTokenLower(token));
    if (nominalTokens.some(temporal) && nominalTokens.every(token => temporal(token) ||
        ["only", "the"].indexOf(normalizeTokenLower(token)) >= 0 ||
        DOSE_TARGET_QUANTIFIERS.has(normalizeTokenLower(token)))) return true;
    if (words.some(word => resolveMedicationInstructionConcept(word, context.options)?.code === "medication-dose" ||
        prohibitedAdministration && normalizeUnit(word, context.options))) return true;

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
  if (!withholdsMedicationAdministration(context, frame)) return undefined;
  const cached = medicationGuardForContext(context);
  const applicable = cached?.start === sourceStart ? cached : undefined;
  // An explicit ELSE branch does not invert the earlier permission guard.
  if (applicable?.alternative && applicable.alternative.end <= frame.span.start) return undefined;
  // A typed withholding predicate licenses a non-numeric conditional daughter
  // (IF dizzy, HOLD) without reclassifying ordinary TAKE-if-symptom PRN syntax.
  // All predicate/Boolean meaning still comes from the same HPSG constructor.
  const guard = applicable && (sourceEnd === undefined || sourceEnd >= applicable.end)
    ? applicable
    : parseMedicationGuard(context.state.input.slice(sourceStart, sourceEnd), undefined, true);
  if (!guard) return undefined;
  return guard.condition.kind === "not"
    ? guard.condition.condition
    : { kind: "not" as const, condition: guard.condition };
}

/** Resolve either the broad daypart head or one of its meal-relative members
 * to the same typed dose-slot family. Thus BREAKFAST can select a BEFORE
 * BREAKFAST administration just as MORNING can, without rewriting either
 * surface form or widening ordinary food objects into medication doses. */
function doseTargetEventFamily(event: EventTiming): readonly EventTiming[] {
  const direct = DOSE_TARGET_EVENT_MEMBERS.get(event);
  if (direct) return direct;
  for (const members of DOSE_TARGET_EVENT_MEMBERS.values()) {
    if (members.indexOf(event) >= 0) return members;
  }
  return [event];
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
      if (token.kind === LexKind.TimeLike) {
        const typedClock = timeOfDayRule().match(context, token.index).find(sign =>
          sign.synsem.head.schedule?.timeOfDay?.length === 1)?.synsem.head.schedule?.timeOfDay;
        if (typedClock) target.timeOfDay = [...new Set([...(target.timeOfDay ?? []), ...typedClock])];
      }
      const meridiemRange = DOSE_TARGET_MERIDIEM_CLOCK_RANGES.get(word);
      if (meridiemRange) target.clockRange = { ...meridiemRange };
      const quantifier = DOSE_TARGET_QUANTIFIERS.get(word);
      if (quantifier) target.quantifier = quantifier;
      const event = EVENT_TIMING_TOKENS[word];
      if (!event) continue;
      const members = doseTargetEventFamily(event);
      const clockRange = DOSE_TARGET_DAYPART_CLOCK_RANGES.get(event);
      if (clockRange) target.clockRange = { ...clockRange };
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
    const sourceGuard = medicationGuardForContext(context);
    const dayInvariant = sourceGuard?.start === range.start &&
      sourceGuard.sign.synsem.cont.clinicalAdjunct?.calendarDayCondition;
    return {
      condition,
      ...(dayInvariant ? { calendarDayCondition: condition } : {}),
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
    const scope = clinicalAdjunctSign("hpsg.lex.clinical.condition", context, tokens, {
      condition: withheld?.condition ?? guard.condition,
      ...(withheld ? { conditionTarget: withheld.conditionTarget } : {}),
      localRanges,
      evidence: [{
        rule: "hpsg.lex.clinical.condition",
        kind: "condition",
        ranges: localRanges.map((range) => ({ ...range }))
      }]
    }, consumedTokens);
    return [scopeMedicationGuardSign(guard, scope)];
  });
}

/** Weekday/date omissions are typed adjuncts; projection applies them to cadence. */
/** Recognize a complement adjective plus a calendar-day noun. Its weekday
 * antecedent belongs to regimen composition, not this local lexical rule.
 * @param context Shared source tokens and lexical ownership.
 * @param start Optional preposition/determiner or first noun constituent.
 */
function weekdayComplementReferenceAt(context: HpsgClauseContext, start: number) {
  const wordAt = (index: number) => context.tokens[index]
    ? normalizeTokenLower(context.tokens[index]) : "";
  const previous = wordAt(start - 1);
  // EVERY OTHER DAY is the existing two-day interval, never an anaphor.
  if (CALENDAR_UNIVERSAL_DAY_QUANTIFIERS.has(previous) &&
      !CALENDAR_COMPLEMENT_DETERMINERS.has(previous)) return undefined;
  let cursor = start;
  if (resolveActionRelationSurface(wordAt(cursor)) === "on") cursor += 1;
  while (CALENDAR_COMPLEMENT_DETERMINERS.has(wordAt(cursor))) cursor += 1;
  const first = wordAt(cursor), second = wordAt(cursor + 1);
  const modifierFirst = CALENDAR_COMPLEMENT_DAY_MODIFIERS.has(first) && mapIntervalUnit(second) === "d";
  const nounFirst = mapIntervalUnit(first) === "d" && CALENDAR_COMPLEMENT_DAY_MODIFIERS.has(second);
  if (!modifierFirst && !nounFirst) return undefined;
  const tokens = tokensAvailable(context, start, cursor + 2 - start);
  if (!tokens) return undefined;
  const range = rangeFromTokens(tokens);
  if (!range) return undefined;
  const rule = "hpsg.lex.schedule.weekdayComplementReference";
  return lexicalSign({
    type: "schedule-sign", rule, tokens,
    synsem: {
      head: { schedule: { timingReference: "previous-weekday-complement" } },
      valence: { instructions: [{
        text: context.state.input.slice(range.start, range.end),
        evidence: [{ rule, spans: [{ ...range, text: context.state.input.slice(range.start, range.end) }],
          scheduleFields: ["timingReference"] }]
      }] },
      cont: { clauseKind: "administration" }
    },
    score: 48 + tokens.length
  });
}

export function weekdayComplementReferenceLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.schedule.weekdayComplementReference", (context, start) => {
    const sign = weekdayComplementReferenceAt(context, start);
    return sign ? [sign] : [];
  });
}

/** A withholding action can exclude calendar members for its selected dose
 * noun. The registered action, target NP and temporal argument already own
 * their meanings; a calendar exclusion must not apply to unrelated slots.
 * @param context Shared source action frames and lexical tokens.
 * @param start Explicit calendar-exclusion marker token.
 */
function targetedWithholdingCalendarAt(context: HpsgClauseContext, start: number) {
  const lead = context.tokens[start];
  if (!lead) return undefined;
  const word = normalizeTokenLower(lead);
  const action = resolveMedicationInstructionAction(word, context.options);
  const relation = resolveActionRelationSurface(word);
  const isExclusion = EXCLUSION_CUE.test(lead.original);
  const negativeLead = /^(?:do|not|never|ห้าม|อย่า)$/iu.test(word);
  if (!isExclusion && !action?.argumentParserConfig?.medicationConditionEffect &&
      !action?.primaryAdministrationHead && relation !== AdviceRelation.On && !negativeLead) return undefined;
  const weekdayAt = (index: number) => {
    const on = context.tokens[index] && resolveActionRelationSurface(normalizeTokenLower(context.tokens[index])) === AdviceRelation.On;
    const head = index + (on ? 1 : 0);
    return [...dayRangeLexicalRule().match(context, head), ...timingLexicalRule().match(context, head)]
      .find(sign => sign.synsem.head.schedule?.dayOfWeek?.length);
  };
  for (const frame of getProceduralFrames(context)) {
    if (!withholdsMedicationAdministration(context, frame)) continue;
    const target = withholdingDoseTarget(context, frame);
    if (frame.span.start === lead.sourceStart) {
      // The very same registered activity-day constituent can modify a
      // withholding head. Its inverse belongs to administration, with the
      // day-domain certificate retained; physical HOLD objects cannot enter
      // this construction because their valence was rejected above.
      for (const token of context.tokens) {
        if (token.sourceStart < frame.span.start || token.sourceEnd > frame.span.end) continue;
        const day = registeredActivityDayAt(context, token.index, true);
        const predicate = day?.synsem.cont.clinicalAdjunct?.condition;
        if (!day || !predicate) continue;
        const condition: MedicationCondition = predicate.kind === "not"
          ? predicate.condition : { kind: "not", condition: predicate };
        const range = { start: frame.span.start, end: frame.span.end };
        const members = overlappingAvailableTokens(context, range.start, range.end);
        return clinicalAdjunctSign("hpsg.cx.medication-withholding-activity-day", context, members, {
          condition, calendarDayCondition: condition, conditionTarget: target, localRanges: [range],
          evidence: [{ rule: "hpsg.cx.medication-withholding-activity-day", kind: "condition", ranges: [range] }]
        });
      }
    }
    if (!target.when?.length && !target.timeOfDay?.length && !target.clockRange && !target.quantifier) continue;
    let rangeStart = frame.span.start, rangeEnd = frame.span.end;
    let excluded = frame.args.filter(argument => argument.role === AdviceArgumentRole.Time ||
        frame.relation === AdviceRelation.On && argument.role === AdviceArgumentRole.Object)
      .reduce<FhirDayOfWeek[]>((days, argument) => [...new Set([...days, ...uniqueDays(argument.text)])], []);
    if (isExclusion && frame.span.start >= lead.sourceEnd &&
        !context.state.input.slice(lead.sourceEnd, frame.span.start).trim()) rangeStart = lead.sourceStart;
    else if (relation === AdviceRelation.On && frame.span.start > lead.sourceStart) {
      const days = weekdayAt(start);
      const end = days?.tokens[days.tokens.length - 1]?.sourceEnd;
      if (!days || end === undefined || end > frame.span.start ||
          context.state.input.slice(end, frame.span.start).replace(/[,]/gu, '').trim()) continue;
      excluded = days.synsem.head.schedule!.dayOfWeek!;
      // This lexical constituent starts at its ON head. The preceding
      // sentence delimiter remains a separate connector daughter, not an
      // overlapping token silently consumed by a later lexical rule.
      rangeStart = lead.sourceStart;
    } else if (frame.span.start !== lead.sourceStart) continue;
    if (!excluded.length) {
      const next = context.tokens.findIndex(token => token.sourceStart >= frame.span.end);
      if (next < 0 || context.state.input.slice(frame.span.end, context.tokens[next].sourceStart).trim()) continue;
      const days = weekdayAt(next);
      if (!days) continue;
      excluded = days.synsem.head.schedule!.dayOfWeek!;
      rangeEnd = days.tokens[days.tokens.length - 1].sourceEnd;
    }
    const range = { start: rangeStart, end: rangeEnd };
    const members = overlappingAvailableTokens(context, range.start, range.end);
    return clinicalAdjunctSign("hpsg.cx.medication-withholding-calendar-target", context, members, {
      conditionTarget: target, excludedWeekdays: excluded, localRanges: [range],
      evidence: [{ rule: "hpsg.cx.medication-withholding-calendar-target", kind: "calendar-exclusion", ranges: [range] }]
    });
  }
  return undefined;
}

export function calendarExclusionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinical.calendar-exclusion", (context, start) => {
    const lead = context.tokens[start];
    if (!lead || context.state.consumed.has(lead.index) ||
        !EXCLUSION_CUE.test(lead.sourceText ?? lead.original)) {
      return [];
    }
    const clauseEnd = context.state.input.indexOf(";", lead.sourceStart) >= 0
      ? context.state.input.indexOf(";", lead.sourceStart)
      : context.state.input.length;
    const durationBoundary = trailingCourseDurationBoundary(
      context, lead.sourceStart, clauseEnd
    );
    const exclusion = matchCalendarExclusion(
      context.state.input,
      context.options,
      context.dateSpans,
      durationBoundary
    );
    if (!exclusion) {
      const targeted = targetedWithholdingCalendarAt(context, start);
      if (targeted) return [targeted];
      // A registered activity DAY is a known calendar-domain predicate, even
      // when no static dates were supplied. Reuse its typed lexical sign before
      // falling back to source-only unknown-calendar preservation.
      const activityDay = registeredActivityDayAt(context, start);
      if (activityDay) return [activityDay];
      const range = {
        start: lead.sourceStart,
        end: durationBoundary ?? clauseEnd
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
    definition?.procedural || isConditionalAdviceFrame(context, frame) ||
    medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options)
  );
}

function hasStrongBoundary(text: string): boolean {
  return /[.!?;]/u.test(text);
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
    const calendarWithholding = targetedWithholdingCalendarAt(context, start);
    if (calendarWithholding) return [calendarWithholding];
    if (actionEventRelationAt(context, start)) return [];
    const lexicalConditional = CIRCUMSTANTIAL_CONDITION_HEADS.has(normalizeTokenLower(lead))
      ? medicationGuardLeadLexeme(context.state.input.slice(lead.sourceStart), true) : undefined;
    const relation = lexicalConditional?.start === 0 && lexicalConditional.circumstantial
      ? AdviceRelation.If : resolveActionRelationSurface(normalizeTokenLower(lead));
    if (!relation || !relationHasGrammarFeature(relation, "conditionalTail")) return [];
    if (relationHasGrammarFeature(relation, "symptomOnsetPrnLead") && hasSymptomOnsetPrnAt(context, start)) {
      // A recognized onset directly after a quantified administration modifies
      // that dose. A later action cannot take it as its own fronted condition.
      const followsAdministration = getProceduralFrames(context).some(frame => {
        if (frame.polarity === AdvicePolarity.Negate || frame.span.end > lead.sourceStart ||
            context.state.input.slice(frame.span.end, lead.sourceStart).trim()) return false;
        const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
        return (definition?.primaryAdministrationHead ||
          definition?.definesDose && definition.administrationMethod) &&
          frame.args.some(argument => argument.role === AdviceArgumentRole.Amount && argument.quantity);
      });
      if (followsAdministration || !conditionalAdviceOwnerAt(context, start)) return [];
    }

    const frames = getProceduralFrames(context).slice().sort((a, b) =>
      a.span.start - b.span.start || a.span.end - b.span.end
    );

    const nextIndex = frames.findIndex((frame) =>
      frame.span.start >= lead.sourceEnd && isScopeTarget(context, frame) &&
      // The conditional cannot select a later action across a completed
      // directive. A subsequent counseling sentence must not steal the IF
      // daughter from its immediately preceding medication-withholding head.
      !context.tokens.some(token => token.sourceStart >= lead.sourceEnd &&
        token.sourceEnd <= frame.span.start && /^[;.!?]$/u.test(token.original))
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
