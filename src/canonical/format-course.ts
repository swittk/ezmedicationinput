/** Native clinical course realization. This module reads canonical facts
 * and the existing grammar renderer, never FHIR rows or persistence markers.
 * Display stays separate from executable interpretation: unknown expressions
 * and boundaries remain visible without inventing values or event dates. */
import type { FormatBatchOptions, FormatOptions, MedicationCondition, FhirDayOfWeek, CanonicalSigClause } from "../types";
import type {
  CanonicalCourse,
  CanonicalBoundary,
  CanonicalAdministration,
  CanonicalMeasure,
  CanonicalRange,
  CanonicalExpression,
  CanonicalDoseLimit,
  CanonicalSafety,
  RegimenPosition,
} from "./course";
import { measureOperator as getQuantityComparator, compareRegimenPositions } from "./course";
import { clauseForAdministration, doseRangeNeedsEndpointPreview } from "./compile";
import { getDoseQuantityUnit } from "../maps";
import { formatCanonicalClause } from "../format";
import {
  resolveSigLocalization,
  resolveCourseLanguage,
  type SigLocalization,
  type CourseLanguage,
} from "../i18n";

/** Resolved once per invocation; recursive clinical composition reuses it. */
interface CourseFormatEnvironment {
  localization?: SigLocalization;
  words: CourseLanguage;
}
function courseEnvironment(options?: FormatOptions): CourseFormatEnvironment {
  const localization = resolveSigLocalization(options?.locale, options?.i18n);
  return { localization, words: resolveCourseLanguage(options?.locale, options?.i18n, localization) };
}

export function joinGeneratedClauses(clauses: readonly string[], separator = "; "): string {
  let result = "";
  for (let index = 0; index < clauses.length; index++) {
    if (index) result += separator;
    result += index < clauses.length - 1 ? clauses[index].replace(/\.\s*$/u, "") : clauses[index];
  }
  return result;
}
function medicationConditionBody(condition: MedicationCondition, words: CourseLanguage): string {
  switch (condition.kind) {
    case "measurement": {
      // Live typed predicate values own the generated instruction. Its
      // authored text remains source data and may describe an older value.
      const operator = { gt: ">", ge: ">=", lt: "<", le: "<=", eq: "=", ne: "!=" }[condition.operation];
      return (
        words.measurementName(condition.name) + " " + operator + " " + condition.value + (condition.unit ? " " + condition.unit : "")
      );
    }
    case "state": {
      return condition.expected ? condition.name : words.notPrefix + condition.name;
    }
    case "text":
      return condition.text;
    case "not":
      return words.notPrefix + "(" + medicationConditionBody(condition.condition, words) + ")";
    case "all":
    case "any": {
      let result = "";
      const separator = condition.kind === "all" ? words.allSeparator : words.anySeparator;
      for (const value of condition.conditions) {
        const body = medicationConditionBody(value, words);
        // Preserve Boolean grouping. Only the outer NOT licenses 'unless'.
        const grouped = (value.kind === "all" || value.kind === "any") && value.kind !== condition.kind;
        if (result) result += separator;
        result += grouped ? "(" + body + ")" : body;
      }
      return result;
    }
  }
}
export function appendMedicationExcludedDatesText(
  text: string,
  dates: readonly string[],
  options?: FormatOptions,
  environment?: CourseFormatEnvironment
): string {
  if (!dates.length) return text;
  const words = (environment ?? courseEnvironment(options)).words;
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + words.exceptDates + " " + dates.join(words.allSeparator) + ".";
}
/** The locale owns weekday vocabulary; clinical exclusion membership is
 * walked once instead of repeatedly looking through prior array members. */
export function appendMedicationExcludedWeekdaysText(
  text: string,
  days: readonly FhirDayOfWeek[],
  options?: FormatOptions,
  environment?: CourseFormatEnvironment
): string {
  if (!days.length) return text;
  const words = (environment ?? courseEnvironment(options)).words;
  const seen = new Set<FhirDayOfWeek>(),
    labels: string[] = [];
  for (const day of days)
    if (!seen.has(day)) {
      seen.add(day);
      labels.push(words.weekdayName(day));
    }
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + words.exceptWeekdays + words.joinList(labels) + ".";
}
export function appendMedicationConditionText(
  text: string,
  condition: MedicationCondition,
  options?: FormatOptions,
  environment?: CourseFormatEnvironment
): string {
  const words = (environment ?? courseEnvironment(options)).words;
  const negated = condition.kind === "not";
  const body = medicationConditionBody(negated ? condition.condition : condition, words);
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + (negated ? words.unless : words.onlyIf) + " " + body + ".";
}

/** Resolve exact day/week quantities without converting clock-time units to calendar days.
 * @param quantity Typed FHIR duration, including its original unit and comparator.
 * @returns Whole nonnegative calendar days, or undefined when not exact.
 */
function exactCourseDays(quantity: CanonicalMeasure | undefined): number | undefined {
  if (
    !quantity ||
    getQuantityComparator(quantity) ||
    quantity.value === undefined ||
    !Number.isFinite(quantity.value) ||
    quantity.value < 0
  )
    return undefined;
  const unit = quantity.code ?? quantity.unit;
  const days = unit === "d" ? quantity.value : unit === "wk" ? quantity.value * 7 : undefined;
  return days !== undefined && Number.isInteger(days) ? days : undefined;
}

/** Adapt exact display offsets to the shared conservative phase ordering. */
function treatmentPosition(quantity: CanonicalMeasure): RegimenPosition | undefined {
  const days = exactCourseDays(quantity);
  if (days !== undefined) return { unit: "d", value: days };
  const unit = quantity.code ?? quantity.unit, value = quantity.value;
  return value !== undefined && Number.isInteger(value) && value >= 0 && (unit === "mo" || unit === "a")
    ? { unit: "mo", value: unit === "a" ? value * 12 : value } : undefined;
}

/** Find gaps in the union of all typed course windows, not between adjacent rows.
 * An open-ended or unresolved parallel stage cannot license a global withholding instruction.
 * @param windows Resolved same-origin windows for every nonempty step.
 * @param repeatCycle Original whole-course period, when the schedule repeats.
 * @returns Half-open day-offset intervals where the entire course has no medication.
 */
function medicationFreeCourseWindows(
  windows: readonly { start: number | undefined; end: number | undefined }[],
  repeatCycle: CanonicalMeasure | undefined
): Array<{ start: number; end: number }> {
  const ordered: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    if (window.start === undefined || (window.end !== undefined && window.end <= window.start)) return [];
    ordered.push({ start: window.start, end: window.end ?? Infinity });
  }
  if (!ordered.length) return [];
  const cycleDays = exactCourseDays(repeatCycle);
  // A stage extending into another cycle can cover its apparent gap. Show
  // the exact stage and repeat period, but never assert a global pause there.
  if (
    repeatCycle &&
    (cycleDays === undefined || cycleDays <= 0 || ordered.some((window) => window.end > cycleDays))
  )
    return [];
  ordered.sort((left, right) => left.start - right.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let coveredUntil = 0;
  for (const window of ordered) {
    if (window.start > coveredUntil) gaps.push({ start: coveredUntil, end: window.start });
    coveredUntil = Math.max(coveredUntil, window.end);
  }
  if (cycleDays !== undefined && cycleDays > coveredUntil) {
    gaps.push({ start: coveredUntil, end: cycleDays });
  }
  return gaps;
}

/** Show an imported expression without evaluating it or inventing a dose.
 * Referenced/named expressions are usable structured data too. */
export function unevaluatedExpressionText(
  expression: CanonicalExpression,
  kind: "dose" | "rate",
  words?: CourseLanguage
): string {
  const detail = expression.expression ?? expression.reference ?? expression.description ?? expression.name;
  return (words ?? resolveCourseLanguage()).expression(kind, detail);
}
/** Preserve temporal units exactly. Locale rules own wording; calendar
 * months/years are never approximated as day counts by realization. */
function formatCourseTimeQuantity(quantity: CanonicalMeasure, words: CourseLanguage): string {
  const unit = quantity.code ?? quantity.unit ?? "";
  const label = words.timeUnit(unit, quantity.value) ?? quantity.unit ?? unit;
  return `${getQuantityComparator(quantity) ?? ""}${quantity.value ?? ""} ${label}`.trim();
}
/** Clinical validity is determined here. The language realizes either a
 * known repetition or an uninterpreted source-qualified interval. */
function formatCourseRepeatCycle(cycle: CanonicalMeasure, words: CourseLanguage, count?: number): string {
  const unit = cycle.code ?? cycle.unit ?? "";
  const exact =
    !getQuantityComparator(cycle) &&
    cycle.value !== undefined &&
    Number.isFinite(cycle.value) &&
    cycle.value > 0 &&
    Boolean(unit);
  return words.repeatCycle(formatCourseTimeQuantity(cycle, words), exact, count);
}

/** Read a typed treatment-start quantity without reinterpreting its calendar unit.
 * @param relative Source R6 boundary and event context.
 * @returns The known nonnegative quantity (including its qualifier), or
 * undefined for another event. exactCourseDays decides whether it licenses
 * exact day numbering or medication-free windows; display keeps the amount.
 */
function treatmentStepOffsetQuantity(
  relative: CanonicalCourse["stages"][number]["start"]
): CanonicalMeasure | undefined {
  if (!relative || (relative.anchor !== "treatment-start" && relative.anchor !== "treatment-day-start") ||
      relative.displacementRange) return undefined;
  const quantity = relative.displacement;
  if (!quantity && relative.anchor === "treatment-day-start") return { value: 0, unit: "d" };
  return quantity && quantity.value !== undefined && Number.isFinite(quantity.value) && quantity.value >= 0
    ? quantity
    : undefined;
}

/** Read exact whole-day offsets without changing the boundary origin.
 * @param relative Source R6 step boundary.
 * @returns Its day offset, leaving month/year boundaries unconverted.
 */
function treatmentStepOffsetDays(relative: CanonicalCourse["stages"][number]["start"]): number | undefined {
  return exactCourseDays(treatmentStepOffsetQuantity(relative));
}

/** Format a calendar-valued step when day ordinals cannot faithfully represent it.
 * @param start Source-backed onset, including an inherited preceding end if known.
 * @param end Source-backed end of the phase.
 * @param thai Whether the requested realization is Thai.
 * @returns Source-qualified relative wording without a guessed treatment start date.
 */
function treatmentBoundaryRangeText(
  boundary: CanonicalCourse["stages"][number]["start"], words: CourseLanguage
): string | undefined {
  if (!boundary || (boundary.anchor !== "treatment-start" && boundary.anchor !== "treatment-day-start") ||
      !boundary.displacementRange) return undefined;
  const { low, high } = boundary.displacementRange;
  const lower = low?.value === undefined ? undefined : formatCourseTimeQuantity(low, words);
  const upper = high?.value === undefined ? undefined : formatCourseTimeQuantity(high, words);
  if (!lower && !upper) return undefined;
  const range = lower && upper ? lower + " – " + upper
    : lower ? (low?.comparator ? "" : ">=") + lower
    : high?.comparator ? upper! : words.upTo(upper!);
  return boundary.anchor === "treatment-day-start"
    ? words.relativeEvent(range, words.treatmentDayStart, false) : words.afterTreatmentStart(range);
}

/** Show a known external event and displacement without inventing its date. */
function boundaryEventText(
  boundary: CanonicalCourse["stages"][number]["start"], words: CourseLanguage
): string | undefined {
  if (!boundary || boundary.anchor === "treatment-start") return undefined;
  const event = boundary.anchor === "treatment-day-start" ? words.treatmentDayStart
    : boundary.anchor === "previous-phase-next-day" ? words.nextDayAfterPreviousPhase
    : boundary.contextCode?.text ?? boundary.contextCode?.coding?.[0]?.display ??
    boundary.contextReference?.display ?? boundary.contextReference?.reference ??
    boundary.contextDefinition ?? boundary.contextPath;
  const quantity = boundary.displacement;
  if (quantity) {
    const before = quantity.value !== undefined && quantity.value < 0 && !getQuantityComparator(quantity);
    const offset = formatCourseTimeQuantity(before ? { ...quantity, value: -quantity.value! } : quantity, words);
    if (offset) return words.relativeEvent(offset, event, before);
  }
  const range = boundary.displacementRange;
  if (range) {
    const lower = range.low?.value === undefined ? undefined : formatCourseTimeQuantity(range.low, words);
    const upper = range.high?.value === undefined ? undefined : formatCourseTimeQuantity(range.high, words);
    const offset = lower && upper ? lower + " – " + upper
      : lower ? (range.low?.comparator ? "" : ">=") + lower
      : upper ? (range.high?.comparator ? "" : "<=") + upper : undefined;
    if (offset) return words.relativeEvent(offset, event, false);
  }
  return event;
}

/** Realize an offset against its typed origin; shared by scalar and range windows. */
function courseBoundaryPoint(
  quantity: CanonicalMeasure | undefined,
  anchor: CanonicalBoundary["anchor"] | undefined,
  words: CourseLanguage
): string | undefined {
  if (!quantity) return undefined;
  const origin = anchor === "treatment-day-start" ? words.treatmentDayStart : words.treatmentStart;
  if (quantity.value === 0 && !getQuantityComparator(quantity)) return origin;
  const offset = formatCourseTimeQuantity(quantity, words);
  return anchor === "treatment-day-start"
    ? words.relativeEvent(offset, origin, false) : words.afterTreatmentStart(offset);
}
function formatCalendarStepWindow(
  start: CanonicalMeasure | undefined,
  end: CanonicalMeasure | undefined,
  words: CourseLanguage,
  startAnchor: CanonicalBoundary["anchor"] = "treatment-start",
  endAnchor: CanonicalBoundary["anchor"] = "treatment-start"
): string {
  return words.calendarWindow(
    courseBoundaryPoint(start, startAnchor, words), courseBoundaryPoint(end, endAnchor, words)
  );
}

/** Source-less native dose/rate ranges retain both independently authored
 * endpoints and their unit/operators, never a guessed shared unit or value. */
export function rateRangePreview(range: CanonicalRange): string | undefined {
  const low = range.low,
    high = range.high;
  const unit = (q: CanonicalMeasure | undefined) => q?.unit ?? getDoseQuantityUnit(q);
  const lowComparator = getQuantityComparator(low);
  const highComparator = getQuantityComparator(high);
  const lower = low?.value === undefined ? undefined : (lowComparator ?? "") + low.value;
  const upper = high?.value === undefined ? undefined : (highComparator ?? "") + high.value;
  if (lower === undefined && upper === undefined) return undefined;
  if (lower !== undefined && upper !== undefined) {
    const loUnit = unit(low),
      hiUnit = unit(high);
    return loUnit === hiUnit
      ? lower + "–" + upper + (loUnit ? " " + loUnit : "")
      : lower + (loUnit ? " " + loUnit : "") + " – " + upper + (hiUnit ? " " + hiUnit : "");
  }
  return lower !== undefined
    ? (lowComparator ? "" : ">=") + lower + (unit(low) ? " " + unit(low) : "")
    : (highComparator ? "" : "<=") + upper + (unit(high) ? " " + unit(high) : "");
}

export function prefersSourceInstruction(course: CanonicalCourse): boolean {
  return Boolean(
    course.cycleInterval || course.cycleCount !== undefined ||
      course.safety ||
      course.stages.some(
        (step) =>
          step.start ||
          step.end ||
          step.count !== undefined ||
          step.safety ||
          step.administrations.some(
            (component) =>
              component.predicate ||
              component.safety ||
              component.siteReference ||
              component.amounts?.some((rate) => rate.expression || rate.rateExpression)
          )
      )
  );
}

/** One pass organizes native choice membership. It never decodes a wire
 * marker or repeatedly scans the entire component array for each branch. */
export function formatCourseChoices<T>(
  members: readonly T[],
  render: (member: T) => string,
  choiceOf: (member: T) => CanonicalAdministration["choice"],
  words: CourseLanguage,
  separator = "; "
): string {
  if (members.length === 1 && !choiceOf(members[0])) return render(members[0]).trim();
  const slots: Array<{ text: string } | { group: string }> = [];
  const groups = new Map<string, Map<string, string[]>>();
  for (const member of members) {
    const text = render(member).trim(),
      choice = choiceOf(member);
    if (!choice) {
      if (text) slots.push({ text });
      continue;
    }
    let branches = groups.get(choice.groupId);
    if (!branches) {
      groups.set(choice.groupId, (branches = new Map()));
      slots.push({ group: choice.groupId });
    }
    let branch = branches.get(choice.branchId);
    if (!branch) branches.set(choice.branchId, (branch = []));
    if (text) branch.push(text.replace(/[.!?]+$/u, ""));
  }
  const output: string[] = [];
  for (const slot of slots) {
    if ("text" in slot) {
      output.push(slot.text);
      continue;
    }
    let body = "";
    for (const branch of groups.get(slot.group)!.values()) {
      const text = branch.join(separator);
      if (!text) continue;
      if (body) body += words.anySeparator;
      body += branch.length > 1 ? `(${text})` : text;
    }
    if (body) output.push(words.choicePrefix + body + ".");
  }
  return joinGeneratedClauses(output, separator);
}
/** Render the value and scope of each authored limit without evaluating it.
 * Member, stage and course owners share this value rendering; their enclosing
 * wording remains separate so a shared allowance is never repeated per dose.
 * Partial quantities and expressions remain visible rather than disappearing
 * merely because numeric execution cannot use them. */
function formatDoseLimits(limits: readonly CanonicalDoseLimit[], words: CourseLanguage): string {
  let rendered = "";
  const readable = (quantity: CanonicalMeasure): string => {
    const unit = quantity.unit ?? quantity.code;
    const value = quantity.value !== undefined && Number.isFinite(quantity.value)
      ? String(quantity.value) : words.unspecified;
    return (quantity.comparator ?? "") + value + (unit ? " " + unit : "");
  };
  for (const limit of limits) {
    const value = limit.amount
      ? readable(limit.amount)
      : limit.count !== undefined
      ? words.administrations(String(limit.count))
      : limit.expression
      ? unevaluatedExpressionText(limit.expression, "dose", words)
      : limit.text?.trim() || words.unspecified;
    const label = limit.scope === "period" ? words.maxPeriodLabel
      : limit.scope === "administration" ? words.maxAdministrationLabel
      : limit.scope === "lifetime" ? words.maxLifetimeLabel : words.maxDosageLabel;
    if (rendered) rendered += "; ";
    rendered += label + value + (limit.period ? " / " + readable(limit.period) : "");
  }
  return rendered;
}
function appendDoseLimits(
  text: string,
  limits: readonly CanonicalDoseLimit[] | undefined,
  words: CourseLanguage,
  owner?: "course" | "stage",
  ifExceeded?: string
): string {
  const action = ifExceeded?.trim();
  if (!limits?.length && !action) return text;
  const label = owner === "course" ? words.courseLimitsLabel
    : owner === "stage" ? words.stageLimitsLabel : "";
  const values = limits?.length ? formatDoseLimits(limits, words) : "";
  const response = action ? words.ifLimitExceeded(action) : "";
  const rendered = label + (response && values ? joinGeneratedClauses([values, response]) : values || response);
  return text ? joinGeneratedClauses([text, rendered]) : rendered;
}

function safetyHasClinicalFacts(safety: CanonicalSafety | undefined): boolean {
  return Boolean(safety?.limits?.length || safety?.ifExceeded?.trim());
}

/** Text and foreign Element metadata alone do not establish clinical facts
 * that can replace an authored instruction with a generated preview. */
function administrationHasClinicalFacts(a: CanonicalAdministration): boolean {
  for (const amount of a.amounts ?? [])
    if (amount.quantity || amount.range || amount.expression || amount.rate ||
        amount.rateRange || amount.rateRatio || amount.rateExpression) return true;
  if (a.asNeeded !== undefined || a.target || a.targetCount !== undefined || a.siteReference ||
      a.route || a.method || a.predicate || a.calendarPredicate || a.patientInstruction ||
      a.additionalInstructions?.length || a.excludedDates?.length || a.excludedWeekdays?.length ||
      a.limits?.length || safetyHasClinicalFacts(a.safety) || a.choice || a.phaseOrigin || a.phaseStart || a.anchoredLength ||
      a.onsetDays !== undefined || a.delayMinutes !== undefined || a.cycleDays) return true;
  const timing = a.schedule;
  if (timing?.explicitEvents?.length || timing?.code) return true;
  const r = timing?.recurrence;
  return !!r && (r.count !== undefined || r.countMax !== undefined || r.frequency !== undefined ||
    r.frequencyMax !== undefined || r.period !== undefined || r.periodMax !== undefined || !!r.periodUnit ||
    r.occurrenceDuration !== undefined || r.occurrenceDurationMax !== undefined || !!r.occurrenceDurationUnit ||
    !!r.courseLength || !!r.courseLengthRange || !!r.calendarWindow || !!r.dayOfWeek?.length ||
    !!r.clocks?.length || !!r.anchors?.length || r.offset !== undefined || r.offsetMin !== undefined ||
    r.offsetMax !== undefined || !!r.monthDays?.length || r.weekdayOrdinal !== undefined ||
    !!r.activityTiming?.length || !!r.occurrenceCap || !!r.clockWindow || !!r.eventWindow ||
    !!r.startOffset || !!r.endOffset);
}
function courseHasClinicalFacts(course: CanonicalCourse): boolean {
  if (course.cycleInterval || course.cycleCount !== undefined || safetyHasClinicalFacts(course.safety)) return true;
  for (const stage of course.stages) {
    if (stage.start || stage.end || stage.count !== undefined || safetyHasClinicalFacts(stage.safety)) return true;
    for (const a of stage.administrations) if (administrationHasClinicalFacts(a)) return true;
  }
  return false;
}

/** Common clause preview; whole-course composition adds rich rates/expressions
 * without routing them through a more restrictive interchange version. */
function formatCanonicalBase(
  a: CanonicalAdministration,
  style: "short" | "long",
  options?: FormatOptions,
  compiled?: CanonicalSigClause,
  environment?: CourseFormatEnvironment,
  source: CanonicalAdministration = a
): string {
  if (a.text?.trim() && !administrationHasClinicalFacts(source)) return a.text;
  const env = environment ?? courseEnvironment(options),
    words = env.words;
  const primary = a.amounts?.[0];
  const maxima = Boolean(a.limits?.length);
  const rich =
    primary?.rate ||
    primary?.rateRatio ||
    primary?.rateRange ||
    primary?.expression ||
    primary?.rateExpression ||
    primary?.quantity?.unit?.includes("/kg") ||
    a.predicate ||
    a.safety ||
    a.siteReference ||
    a.excludedDates?.length ||
    a.excludedWeekdays?.length;
  if (options?.realizationMode !== "normalized" && !a.predicate && !a.safety?.ifExceeded &&
      a.text?.trim() && (maxima || rich)) return a.text;
  // A structured import already built this exact scoped clause for item
  // metadata. Reuse it for both item and whole-course EN/TH previews instead
  // of reconstructing the same dose/timing from native fields five times.
  const clause = compiled ?? clauseForAdministration(a);
  let rendered = formatCanonicalClause(clause, style, env.localization, options);
  if (a.predicate) rendered = appendMedicationConditionText(rendered, a.predicate, options, env);
  if (a.limits?.length || a.safety?.ifExceeded)
    rendered = appendDoseLimits(rendered, a.limits, words, undefined, a.safety?.ifExceeded);
  // The clause's calendar view needs a complete civil date. Partial FHIR
  // dateTimes (for example YYYY-MM) remain useful authored information; show
  // their original values instead of inventing a missing month/day or hiding
  // them when the native-to-clause projection cannot represent them.
  const events = a.schedule?.explicitEvents, calendarEvents = clause.schedule?.calendarEvents;
  if (events?.length && events.length > (calendarEvents?.length ?? 0)) {
    const represented = new Set<string | undefined>();
    for (const event of calendarEvents ?? []) represented.add(event.fhirDateTime ?? event.isoDate);
    const remaining: string[] = [];
    for (const event of events) if (!represented.has(event)) remaining.push(event);
    if (remaining.length) rendered = joinGeneratedClauses([rendered, words.calendarEvents(remaining)]);
  }
  if (a.excludedDates?.length)
    rendered = appendMedicationExcludedDatesText(rendered, a.excludedDates, options, env);
  if (a.excludedWeekdays?.length)
    rendered = appendMedicationExcludedWeekdaysText(rendered, a.excludedWeekdays, options, env);
  const ranges: string[] = [];
  for (let index = 0; index < (a.amounts?.length ?? 0); index++) {
    const amount = a.amounts![index];
    // The clause represents only the first entry; later ordinary doses are
    // independent authored amounts, including a dose after a rate-only entry.
    if (index > 0 && amount.quantity?.value !== undefined && !amount.quantity.comparator) {
      const unit = amount.quantity.unit ?? getDoseQuantityUnit(amount.quantity);
      ranges.push(words.doseLabel + amount.quantity.value + (unit ? " " + unit : ""));
    }
    if (amount.range && (index > 0 || doseRangeNeedsEndpointPreview(amount.range))) {
      const dose = rateRangePreview(amount.range);
      if (dose) ranges.push(words.doseLabel + dose);
    }
    const text = amount.rateRange && rateRangePreview(amount.rateRange);
    if (text) ranges.push(words.rateRangeLabel + text);
  }
  return ranges.length ? joinGeneratedClauses([rendered, ...ranges]) : rendered;
}
export function formatCanonicalAdministration(
  a: CanonicalAdministration,
  style: "short" | "long" = "long",
  options?: FormatOptions,
  compiled?: ReadonlyMap<CanonicalAdministration, CanonicalSigClause>
): string {
  // External R6 fields can be edited independently of their saved wording.
  // Keep that wording in provenance, but preview the current clinical fields.
  if ((a.provenance?.format === "r6" || a.provenance?.sourceTextVerified === false) &&
      options?.realizationMode !== "normalized" && administrationHasClinicalFacts(a)) {
    options = Object.assign({}, options);
    options.realizationMode = "normalized";
  }
  // A component's authored source is distinct from a course-wide instruction.
  if (
    options?.realizationMode !== "normalized" && !a.predicate && !a.safety?.ifExceeded &&
    a.text?.trim() &&
    (a.schedule?.recurrence?.startOffset ||
      a.schedule?.recurrence?.endOffset ||
      a.amounts?.some(
        (v) =>
          v.quantity?.comparator || v.rate || v.rateRatio || v.rateRange || v.expression || v.rateExpression
      ))
  )
    return a.text;
  return formatCanonicalCourse(
    { kind: "course", stages: [{ administrations: [a] }] },
    style,
    options,
    compiled
  );
}

export function formatCanonicalCourse(
  oneOrCourse: CanonicalCourse,
  style: "short" | "long" = "long",
  options?: FormatBatchOptions,
  compiled?: ReadonlyMap<CanonicalAdministration, CanonicalSigClause>
): string {
  // R6 imports preserve original text for interchange. Without an agreement
  // proof it cannot override independently editable structured dose/timing.
  // Parser-owned native courses and reconciled R5 imports retain source mode.
  if (oneOrCourse.provenance?.format === "r6" || oneOrCourse.provenance?.sourceTextVerified === false) {
    const hasFacts = courseHasClinicalFacts(oneOrCourse);
    if (!hasFacts && oneOrCourse.instruction) return oneOrCourse.instruction;
    if (hasFacts && options?.realizationMode !== "normalized") {
      options = Object.assign({}, options);
      options.realizationMode = "normalized";
    }
  }
  if (
    oneOrCourse.instruction &&
    (options === undefined ||
      options.realizationMode === "roundtrip" ||
      (oneOrCourse.stages.length === 0 && !courseHasClinicalFacts(oneOrCourse)) ||
      (options.realizationMode !== "normalized" && prefersSourceInstruction(oneOrCourse)))
  ) return oneOrCourse.instruction;
  if (oneOrCourse.stages.length === 0 && !oneOrCourse.safety?.limits?.length &&
      !oneOrCourse.safety?.ifExceeded && !oneOrCourse.cycleInterval &&
      oneOrCourse.cycleCount === undefined) return "";
  const environment = courseEnvironment(options),
    words = environment.words;
  if (oneOrCourse.stages.length === 0) {
    const repetition = oneOrCourse.cycleInterval
      ? formatCourseRepeatCycle(oneOrCourse.cycleInterval, words, oneOrCourse.cycleCount)
      : oneOrCourse.cycleCount === undefined ? "" : words.repeatCount(oneOrCourse.cycleCount);
    return appendDoseLimits(repetition, oneOrCourse.safety?.limits, words, "course", oneOrCourse.safety?.ifExceeded);
  }
  const only = oneOrCourse.stages.length === 1 ? oneOrCourse.stages[0] : undefined;
  const administration = only?.administrations.length === 1 ? only.administrations[0] : undefined;
  if (
    only &&
    administration &&
    !only.start &&
    !only.end &&
    only.count === undefined &&
    !oneOrCourse.cycleInterval &&
    oneOrCourse.cycleCount === undefined &&
    !administration.phaseStart && !administration.phaseOrigin?.value &&
    !administration.choice
  ) {
    const recurrence = administration.schedule?.recurrence;
    const amount = administration.amounts?.[0];
    if (
      (administration.amounts?.length ?? 0) <= 1 &&
      !recurrence?.startOffset &&
      !recurrence?.endOffset &&
      !amount?.quantity?.comparator &&
      !amount?.rate &&
      !amount?.rateRatio &&
      !amount?.rateRange &&
      !amount?.expression &&
      !amount?.rateExpression
    ) {
      let rendered = formatCanonicalBase(
        administration, style, options, compiled?.get(administration), environment
      );
      if (only.safety)
        rendered = appendDoseLimits(rendered, only.safety.limits, words, "stage", only.safety.ifExceeded);
      if (oneOrCourse.safety)
        rendered = appendDoseLimits(rendered, oneOrCourse.safety.limits, words, "course", oneOrCourse.safety.ifExceeded);
      return rendered;
    }
  }
  // Rendering needs each component's projection, not a persisted copy of
  // the whole course plus edit markers on every component.
  const stages: string[] = [];
  let priorEndDays: number | undefined,
    priorEndAnchor: CanonicalBoundary["anchor"] | undefined,
    hasTimedStages = false,
    gapAnchor: CanonicalBoundary["anchor"] | undefined,
    mixedGapOrigins = false;
  const windows: Array<{
    start: number | undefined; end: number | undefined;
    startAnchor: CanonicalBoundary["anchor"] | undefined;
    endAnchor: CanonicalBoundary["anchor"] | undefined;
  }> = [];
  const activeWindows: Array<{ start: number | undefined; end: number | undefined }> = [];
  // One traversal establishes source windows and explicit boundaries;
  // no separate every/map/some/filter chain.
  for (let index = 0; index < oneOrCourse.stages.length; index++) {
    const step = oneOrCourse.stages[index];
    if (step.start || step.end) hasTimedStages = true;
    const start = step.start ? treatmentStepOffsetDays(step.start) : index === 0 ? 0 : priorEndDays;
    const startAnchor = step.start?.anchor ?? (index === 0 ? "treatment-start" : priorEndAnchor);
    const endAnchor = step.end?.anchor;
    const end = treatmentStepOffsetDays(step.end),
      window = { start, end, startAnchor, endAnchor };
    let activeEnd = end;
    let repetitionResolved = true;
    if (step.count !== undefined && step.count !== 1) {
      if (Number.isInteger(step.count) && step.count > 0 &&
          start !== undefined && end !== undefined && end > start && startAnchor === endAnchor) {
        activeEnd = start + (end - start) * step.count;
      } else {
        repetitionResolved = false;
        activeEnd = undefined;
      }
    }
    priorEndDays = activeEnd;
    priorEndAnchor = endAnchor;
    windows.push(window);
    // The heading describes one stage iteration; global gaps must cover all
    // iterations. An unresolved repeat cannot license a no-dose instruction.
    if (step.administrations.length) {
      if (gapAnchor === undefined) gapAnchor = startAnchor;
      if (startAnchor !== gapAnchor || (endAnchor !== undefined && endAnchor !== gapAnchor))
        mixedGapOrigins = true;
      activeWindows.push({ start: repetitionResolved ? start : undefined, end: activeEnd });
    }
  }
  for (let index = 0; index < oneOrCourse.stages.length; index++) {
    const step = oneOrCourse.stages[index];
    const { start: startDays, end: endDays, startAnchor, endAnchor } = windows[index];
    let rendered = formatCourseChoices(
      step.administrations,
      (component) => {
        const repeat = component.schedule?.recurrence;
        const hasOffsets = repeat?.startOffset !== undefined || repeat?.endOffset !== undefined;
        let display = component;
        // Once R6 offsets restrict the active window, a plain R5 formatter
        // cannot safely describe the entire period as the dose cadence.
        // The read-only display copy drops that misleading interpretation.
        if (hasOffsets && display.schedule?.recurrence) {
          const {
            frequency: _frequency,
            frequencyMax: _frequencyMax,
            period: _period,
            periodMax: _periodMax,
            periodUnit: _periodUnit,
            ...rest
          } = display.schedule.recurrence;
          // A structured count owns cadence. Its stale code must not restore
          // the full-period frequency that this offset-only preview omits.
          const structuredCount = _frequency !== undefined || _frequencyMax !== undefined;
          const { code: _timingCode, ...withoutCode } = display.schedule;
          display = { ...display, schedule: {
            ...(structuredCount ? withoutCode : display.schedule), recurrence: rest
          } };
        }
        // The clause owns the first dose, including its qualifier and target.
        // Supplemental entries and rate qualifiers are rendered below without
        // duplicating an unqualified value in the clause.
        if (
          display.amounts &&
          component.amounts?.some(
            (amount, index) =>
              index > 0 && amount.quantity?.comparator ||
              amount.rate?.comparator ||
              amount.rateRatio?.numerator?.comparator === "~"
          )
        ) {
          display = {
            ...display,
            amounts: display.amounts.map((amount, i) => {
              const source = component.amounts?.[i];
              const clean = { ...amount };
              if (i > 0 && source?.quantity?.comparator) delete clean.quantity;
              if (source?.rate?.comparator) delete clean.rate;
              if (source?.rateRatio?.numerator?.comparator === "~") delete clean.rateRatio;
              return clean;
            }),
          };
        }
        const recognized = formatCanonicalBase(
          display,
          style,
          options,
          display === component ? compiled?.get(component) : undefined,
          environment,
          component
        );
        const expressions: string[] = [];
        if (hasOffsets && repeat) {
          const periodUnit = repeat.periodUnit;
          const period =
            periodUnit && repeat.period !== undefined
              ? repeat.periodMax !== undefined
                ? `${repeat.period}–${formatCourseTimeQuantity(
                    {
                      value: repeat.periodMax,
                      code: periodUnit,
                      unit: periodUnit,
                    },
                    words
                  )}`
                : formatCourseTimeQuantity(
                    {
                      value: repeat.period,
                      code: periodUnit,
                      unit: periodUnit,
                    },
                    words
                  )
              : periodUnit && repeat.periodMax !== undefined
              ? words.upTo(formatCourseTimeQuantity(
                  {
                    value: repeat.periodMax,
                    code: periodUnit,
                    unit: periodUnit,
                  },
                  words
                ))
              : undefined;
          const frequency =
            repeat.frequency !== undefined
              ? repeat.frequencyMax !== undefined
                ? `${repeat.frequency}–${repeat.frequencyMax}`
                : String(repeat.frequency)
              : repeat.frequencyMax !== undefined
              ? words.upTo(String(repeat.frequencyMax))
              : undefined;
          if (frequency) expressions.push(words.administrations(frequency, period));
          else if (period && repeat.periodMax !== undefined) expressions.push(words.dosingPeriod(period));
          const periodContext = period ? words.periodContext(period) : "";
          if (repeat.startOffset) {
            const offset = formatCourseTimeQuantity(repeat.startOffset, words);
            expressions.push(words.startsWithinPeriod(offset, periodContext));
          }
          if (repeat.endOffset) {
            const offset = formatCourseTimeQuantity(repeat.endOffset, words);
            expressions.push(words.endsWithinPeriod(offset, periodContext));
          }
        }
        for (let amountIndex = 0; amountIndex < (component.amounts?.length ?? 0); amountIndex++) {
          const amount = component.amounts![amountIndex];
          // Native R6 Quantity comparators are absent from R5 SimpleQuantity.
          // Keep their actual amount visible in source-less R6 suggestions,
          // without introducing invalid R5 dose/rate choices.
          if (amountIndex > 0 && amount.quantity?.comparator && amount.quantity.value !== undefined) {
            expressions.push(
              words.doseLabel +
                amount.quantity.comparator +
                amount.quantity.value +
                (amount.quantity.unit || amount.quantity.code
                  ? " " + (amount.quantity.unit ?? amount.quantity.code)
                  : "")
            );
          }
          if (amount.rate && (amount.rate.value !== undefined || amount.rate.unit || amount.rate.code)) {
            const rate = amount.rate;
            const unit = rate.unit ?? rate.code;
            expressions.push(
              words.rateLabel +
                (rate.value === undefined
                  ? words.unspecified
                  : (getQuantityComparator(rate) ?? "") + rate.value) +
                (unit ? " " + unit : "")
            );
          }
          const numerator = amount.rateRatio?.numerator;
          const denominator = amount.rateRatio?.denominator;
          const numeratorUnit = numerator?.unit ?? numerator?.code;
          const denominatorUnit = denominator?.unit ?? denominator?.code;
          const hasNumerator = numerator?.value !== undefined || Boolean(numeratorUnit);
          const hasDenominator = denominator?.value !== undefined || Boolean(denominatorUnit);
          if (hasNumerator || hasDenominator) {
            const unspecified = words.unspecified;
            const numeratorValue =
              numerator?.value === undefined
                ? unspecified
                : (getQuantityComparator(numerator) ?? "") + numerator.value;
            const denominatorValue =
              denominator?.value === undefined
                ? unspecified
                : (getQuantityComparator(denominator) ?? "") + denominator.value;
            expressions.push(
              words.rateLabel +
                numeratorValue +
                (numeratorUnit ? " " + numeratorUnit : "") +
                (hasDenominator
                  ? " / " + denominatorValue + (denominatorUnit ? " " + denominatorUnit : "")
                  : "")
            );
          }
          if (amount.expression)
            expressions.push(unevaluatedExpressionText(amount.expression, "dose", words));
          if (amount.rateExpression)
            expressions.push(unevaluatedExpressionText(amount.rateExpression, "rate", words));
        }
        const body = joinGeneratedClauses([recognized, ...expressions].filter(Boolean));
        let memberTiming: string | undefined;
        if (component.phaseStart) {
          const boundary = component.phaseStart;
          const quantity = treatmentStepOffsetQuantity(boundary);
          const days = boundary.anchor === "treatment-day-start" ? exactCourseDays(quantity) : undefined;
          const point = treatmentBoundaryRangeText(boundary, words) ??
            courseBoundaryPoint(quantity, boundary.anchor, words) ?? boundaryEventText(boundary, words);
          const knownOrigin = boundary.anchor === "treatment-start" || boundary.anchor === "treatment-day-start" ||
            (boundary.anchor === "previous-phase-next-day" && (index > 0 || Boolean(component.phasePredecessors?.length)));
          memberTiming = knownOrigin
            ? days !== undefined ? words.fromDay(days + 1)
              : words.calendarWindow(point ?? (boundary.anchor === "treatment-start" ? words.treatmentStart : words.treatmentDayStart))
            : words.reviewTiming(point ?? boundary.description);
        }
        const origin = component.phaseOrigin;
        if (!memberTiming && origin && origin.value !== undefined && origin.value !== 0) {
          const stageOrigin = treatmentStepOffsetQuantity(step.start);
          let stageCoversOrigin = false;
          if (step.start?.anchor === "treatment-start" && stageOrigin &&
              !getQuantityComparator(stageOrigin) && !getQuantityComparator(origin)) {
            const memberPosition = treatmentPosition(origin), stagePosition = treatmentPosition(stageOrigin);
            const order = memberPosition && stagePosition ? compareRegimenPositions(stagePosition, memberPosition) : undefined;
            stageCoversOrigin = order === 0 || order === 1 ||
              (stageOrigin.code ?? stageOrigin.unit) === (origin.code ?? origin.unit) &&
              stageOrigin.value !== undefined && stageOrigin.value >= origin.value;
          }
          if (!stageCoversOrigin) memberTiming = words.calendarWindow(
            words.afterTreatmentStart(formatCourseTimeQuantity(origin, words)), undefined);
        }
        return memberTiming ? memberTiming + ": " + body : body;
      },
      (member) => member.choice,
      words,
      options?.separator
    );
    if (step.safety)
      rendered = appendDoseLimits(rendered, step.safety.limits, words, "stage", step.safety.ifExceeded);
    if (!rendered.trim()) continue;
    let timing = "";
    if (step.start || step.end || index > 0) {
      const previous = !step.start && index > 0 ? oneOrCourse.stages[index - 1] : undefined;
      const inheritedStart = previous && (previous.count === undefined || previous.count === 1)
        ? treatmentStepOffsetQuantity(previous.end) : undefined;
      if (
        (step.start && startDays === undefined) ||
        (inheritedStart && startDays === undefined) ||
        (step.end && endDays === undefined) ||
        (startDays !== undefined && endDays !== undefined && endDays <= startDays)
      ) {
        // Unsupported event anchors must stay visible instead of becoming
        // an unconditional dose when the original source text is absent.
        const startQuantity = step.start
          ? treatmentStepOffsetQuantity(step.start)
          : index === 0
          ? { value: 0, unit: "d" }
          : startDays !== undefined
          ? { value: startDays, unit: "d" }
          : inheritedStart;
        const endQuantity = treatmentStepOffsetQuantity(step.end);
        if (
          (!step.start || startQuantity) &&
          (!step.end || endQuantity) &&
          !(startDays !== undefined && endDays !== undefined && endDays <= startDays)
        ) {
          timing = formatCalendarStepWindow(startQuantity, endQuantity, words, startAnchor, endAnchor);
        } else {
          const startRange = treatmentBoundaryRangeText(step.start, words);
          const endRange = treatmentBoundaryRangeText(step.end, words);
          if ((startRange || !step.start || startQuantity) &&
              (endRange || !step.end || endQuantity) && (startRange || endRange)) {
            timing = words.calendarWindow(startRange ?? courseBoundaryPoint(startQuantity, startAnchor, words), endRange ?? courseBoundaryPoint(endQuantity, endAnchor, words));
          } else {
            // Current structured bounds own the window. Descriptive source is
            // a fallback, and each side is a point rather than an open window.
            const start = startRange ?? boundaryEventText(step.start, words) ??
              courseBoundaryPoint(startQuantity, startAnchor, words) ?? step.start?.description;
            const end = endRange ?? boundaryEventText(step.end, words) ??
              courseBoundaryPoint(endQuantity, endAnchor, words) ?? step.end?.description;
            const contextualStart = index > 0 && step.start?.anchor === "previous-phase-next-day";
            const contextualEnd = index > 0 && step.end?.anchor === "previous-phase-next-day";
            const window = words.calendarWindow(start, end);
            timing = (contextualStart || contextualEnd) &&
              (!step.start || startQuantity || startRange || contextualStart) &&
              (!step.end || endQuantity || endRange || contextualEnd)
              ? window : words.reviewTiming(window || undefined);
          }
        }
      } else if (startAnchor === "treatment-day-start" &&
          (endAnchor === undefined || endAnchor === "treatment-day-start")) {
        timing = endDays !== undefined && startDays !== undefined
          ? words.dayRange(startDays + 1, endDays)
          : startDays !== undefined ? words.fromDay(startDays + 1)
          : endDays !== undefined ? words.throughDay(endDays) : "";
      } else if (startDays !== undefined || endDays !== undefined) {
        timing = formatCalendarStepWindow(
          startDays === undefined ? undefined : { value: startDays, code: "d" },
          endDays === undefined ? undefined : { value: endDays, code: "d" },
          words, startAnchor, endAnchor
        );
      } else if (index > 0) {
        // The next phase is ordered even when its predecessor has no exact
        // end; displaying it without this context would make it immediate.
        timing = inheritedStart
          ? formatCalendarStepWindow(inheritedStart, undefined, words, previous?.end?.anchor)
          : words.afterPreviousPhase;
      }
    }
    const stageCount = step.count !== undefined ? words.phaseCount(step.count) : "";
    const heading = [timing, stageCount].filter(Boolean).join("; ");
    stages.push(heading ? `${heading}: ${rendered}` : rendered);
  }
  if (hasTimedStages && !mixedGapOrigins) {
    const pauses = medicationFreeCourseWindows(activeWindows, oneOrCourse.cycleInterval);
    for (const pause of pauses) {
      stages.push(gapAnchor === "treatment-day-start"
        ? words.noDoseDays(pause.start + 1, pause.end)
        : words.noDoseWindow(
            pause.start === 0 ? words.treatmentStart
              : words.afterTreatmentStart(formatCourseTimeQuantity({ value: pause.start, code: "d" }, words)),
            words.afterTreatmentStart(formatCourseTimeQuantity({ value: pause.end, code: "d" }, words))
          ));
    }
  }
  if (oneOrCourse.cycleInterval) {
    stages.push(formatCourseRepeatCycle(oneOrCourse.cycleInterval, words, oneOrCourse.cycleCount));
  } else if (oneOrCourse.cycleCount !== undefined) {
    stages.push(words.repeatCount(oneOrCourse.cycleCount));
  }
  const rendered = stages.join(options?.separator ??
    (hasTimedStages || oneOrCourse.cycleInterval || oneOrCourse.cycleCount !== undefined
      ? " " : words.stageSeparator));
  return oneOrCourse.safety
    ? appendDoseLimits(rendered, oneOrCourse.safety.limits, words, "course", oneOrCourse.safety.ifExceeded)
    : rendered;
}
