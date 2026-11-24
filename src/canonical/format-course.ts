/** Native clinical course realization. This module reads canonical facts
 * and the existing grammar renderer, never FHIR rows or persistence markers.
 * Display stays separate from executable interpretation: unknown expressions
 * and boundaries remain visible without inventing values or event dates. */
import type { FormatBatchOptions, FormatOptions, MedicationCondition, FhirDayOfWeek, CanonicalSigClause, CanonicalDoseExpr } from "../types";
import type {
  CanonicalCourse,
  CanonicalBoundary,
  CanonicalAdministration,
  CanonicalAmount,
  CanonicalMeasure,
  CanonicalRange,
  CanonicalExpression,
  CanonicalDoseLimit,
  CanonicalSafety,
  RegimenPosition,
} from "./course";
import { measureOperator as getQuantityComparator, compareRegimenPositions, hasAmountRole } from "./course";
import { clauseForAdministration, doseRangeNeedsEndpointPreview } from "./compile";
import { canonicalClauseHasAdministrationSemantics } from "../ir";
import { getDoseQuantityUnit } from "../maps";
import { doseUnitUsesTargetScope, formatCanonicalClause, formatDoseEnglish, timingCodeMatchesRecurrence } from "../format";
import { resolveBodySitePhrase } from "../body-site-grammar";
import {
  resolveSigLocalization,
  resolveCourseLanguage,
  appendClinicalConditionText,
  type SigLocalization,
  type SigDoseScope,
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

function usesTargetScope(quantity: CanonicalMeasure | undefined): boolean {
  return doseUnitUsesTargetScope(getDoseQuantityUnit(quantity));
}

export function joinGeneratedClauses(clauses: readonly string[], separator = "; "): string {
  let result = "";
  for (let index = 0; index < clauses.length; index++) {
    if (index) result += separator;
    result += index < clauses.length - 1 ? clauses[index].replace(/\.\s*$/u, "") : clauses[index];
  }
  return result;
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
  return appendClinicalConditionText(text, condition, words);
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
function afterCourseStart(offset: string, words: CourseLanguage, cycleStart?: string): string {
  return cycleStart === undefined ? words.afterTreatmentStart(offset)
    : words.relativeEvent(offset, cycleStart, false);
}
function treatmentBoundaryRangeText(
  boundary: CanonicalCourse["stages"][number]["start"], words: CourseLanguage, cycleStart?: string
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
    ? words.relativeEvent(range, words.treatmentDayStart, false) : afterCourseStart(range, words, cycleStart);
}

/** Show a known external event and displacement without inventing its date. */
function boundaryEventText(
  boundary: CanonicalCourse["stages"][number]["start"], words: CourseLanguage, cycleStart?: string
): string | undefined {
  if (!boundary || boundary.anchor === "treatment-start" &&
      !(boundary.displacement?.value !== undefined && boundary.displacement.value < 0)) return undefined;
  let context = boundary.contextCode?.text?.trim();
  if (!context) for (const coding of boundary.contextCode?.coding ?? []) {
    const display = coding.display?.trim();
    if (display) { context = display; break; }
  }
  const event = boundary.anchor === "treatment-start" ? cycleStart ?? words.treatmentStart
    : boundary.anchor === "treatment-day-start" ? words.treatmentDayStart
    : boundary.anchor === "previous-phase-next-day" ? words.nextDayAfterPreviousPhase
    : context ??
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
  words: CourseLanguage,
  cycleStart?: string
): string | undefined {
  if (!quantity) return undefined;
  const origin = anchor === "treatment-day-start" ? words.treatmentDayStart : cycleStart ?? words.treatmentStart;
  if (quantity.value === 0 && !getQuantityComparator(quantity)) return origin;
  const offset = formatCourseTimeQuantity(quantity, words);
  return anchor === "treatment-day-start"
    ? words.relativeEvent(offset, origin, false) : afterCourseStart(offset, words, cycleStart);
}
function formatCalendarStepWindow(
  start: CanonicalMeasure | undefined,
  end: CanonicalMeasure | undefined,
  words: CourseLanguage,
  startAnchor: CanonicalBoundary["anchor"] = "treatment-start",
  endAnchor: CanonicalBoundary["anchor"] = "treatment-start",
  cycleStart?: string
): string {
  return words.calendarWindow(
    courseBoundaryPoint(start, startAnchor, words, cycleStart), courseBoundaryPoint(end, endAnchor, words, cycleStart)
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
  separator = "; ",
  courseLabels?: ReadonlyMap<string, ReadonlyMap<string, string>>
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
    const labels = courseLabels?.get(slot.group);
    for (const [branchId, branch] of groups.get(slot.group)!) {
      const text = branch.join(separator);
      if (!text) continue;
      if (body) body += labels ? separator : words.anySeparator;
      const grouped = branch.length > 1 ? "(" + text + ")" : text;
      body += labels ? "(" + labels.get(branchId) + ") " + grouped : grouped;
    }
    if (body) output.push((labels ? "" : words.choicePrefix) + body + ".");
  }
  return joinGeneratedClauses(output, separator);
}
type PreviewChoiceGroups = Map<string, { branches: Set<string>; stages: Set<number> }>;
/** Branch labels are stable across stage headings. The choice is made once
 * for the course, while each stage retains its own timing and dose wording. */
function previewChoiceGroups(course: CanonicalCourse): PreviewChoiceGroups {
  const groups: PreviewChoiceGroups = new Map();
  for (let index = 0; index < course.stages.length; index++) {
    for (const member of course.stages[index].administrations) {
      const choice = member.choice;
      if (!choice) continue;
      let group = groups.get(choice.groupId);
      if (!group) groups.set(choice.groupId, group = { branches: new Set(), stages: new Set() });
      group.branches.add(choice.branchId);
      group.stages.add(index);
    }
  }
  return groups;
}
function previewStageCanDisappear(
  members: readonly CanonicalAdministration[],
  groups: PreviewChoiceGroups,
  selectedGroup?: string
): boolean {
  if (!members.length || members.some(member => !member.choice || member.choice.groupId === selectedGroup)) return false;
  const present = new Map<string, Set<string>>();
  for (const member of members) {
    const choice = member.choice!;
    let branches = present.get(choice.groupId);
    if (!branches) present.set(choice.groupId, branches = new Set());
    branches.add(choice.branchId);
  }
  for (const [group, branches] of present) {
    if (branches.size === groups.get(group)!.branches.size) return false;
  }
  return true;
}
/** Unknown branch-dependent starts cannot license a global no-dose window.
 * Selecting one branch uses the same member/stage filtering as execution;
 * other independent choices stay conservative, without enumerating combinations. */
function previewCourseWindows(
  course: CanonicalCourse,
  groups: PreviewChoiceGroups,
  selected?: { groupId: string; branchId: string }
) {
  let priorEndDays: number | undefined, priorEndAnchor: CanonicalBoundary["anchor"] | undefined;
  let priorOptional = false, included = 0, hasTimedStages = false;
  let gapAnchor: CanonicalBoundary["anchor"] | undefined, mixedGapOrigins = false;
  const windows: Array<{
    start: number | undefined; end: number | undefined;
    startAnchor: CanonicalBoundary["anchor"] | undefined;
    endAnchor: CanonicalBoundary["anchor"] | undefined;
    choiceDependentStart: boolean;
  }> = [];
  const activeWindows: Array<{ start: number | undefined; end: number | undefined }> = [];
  for (const step of course.stages) {
    const members = selected ? step.administrations.filter(member =>
      !member.choice || member.choice.groupId !== selected.groupId || member.choice.branchId === selected.branchId)
      : step.administrations;
    // A choice can remove its own stage, but never an authored empty pause.
    if (selected && !members.length && step.administrations.length > 0) continue;
    if (step.start || step.end) hasTimedStages = true;
    const start = step.start ? treatmentStepOffsetDays(step.start) : included === 0 ? 0 : priorEndDays;
    const startAnchor = step.start?.anchor ?? (included === 0 ? "treatment-start" : priorEndAnchor);
    const endAnchor = step.end?.anchor, end = treatmentStepOffsetDays(step.end);
    const choiceDependentStart = !step.start && priorOptional;
    windows.push({ start, end, startAnchor, endAnchor, choiceDependentStart });
    let activeEnd = end, repetitionResolved = true;
    if (step.count !== undefined && step.count !== 1) {
      // A later implicit start repeats its resolved elapsed span in execution.
      // Across DST that span is not the difference of nominal civil offsets,
      // so it cannot license a global medication-free day window here.
      if (Number.isInteger(step.count) && step.count > 0 &&
          (step.start || step === course.stages[0]) &&
          start !== undefined && end !== undefined && end > start && startAnchor === endAnchor) {
        activeEnd = start + (end - start) * step.count;
      } else {
        repetitionResolved = false;
        activeEnd = undefined;
      }
    }
    priorOptional = groups.size > 0 && previewStageCanDisappear(members, groups, selected?.groupId);
    priorEndDays = priorOptional ? undefined : activeEnd;
    priorEndAnchor = priorOptional ? undefined : endAnchor;
    included++;
    if (members.length) {
      if (gapAnchor === undefined) gapAnchor = startAnchor;
      if (startAnchor !== gapAnchor || (endAnchor !== undefined && endAnchor !== gapAnchor))
        mixedGapOrigins = true;
      activeWindows.push({ start: repetitionResolved ? start : undefined, end: activeEnd });
    }
  }
  return { windows, activeWindows, hasTimedStages, gapAnchor, mixedGapOrigins };
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
function administrationHasAmountFacts(a: CanonicalAdministration): boolean {
  for (const amount of a.amounts ?? [])
    if (amount.quantity?.value !== undefined || amount.range?.low?.value !== undefined ||
        amount.range?.high?.value !== undefined || amount.expression || amount.rate ||
        amount.rateRange || amount.rateRatio || amount.rateExpression) return true;
  return false;
}
function administrationHasClinicalFacts(a: CanonicalAdministration, includeMemberBounds = true, includeSafety = true): boolean {
  if (administrationHasAmountFacts(a)) return true;
  if (a.asNeeded !== undefined || a.target || a.targetCount !== undefined || a.siteReference ||
      a.route || a.method || a.predicate || a.calendarPredicate || a.patientInstruction || a.syntax?.instructionGraph?.actions.length ||
      a.additionalInstructions?.length || a.excludedDates?.length || a.excludedWeekdays?.length ||
      (includeSafety && (a.limits?.length || safetyHasClinicalFacts(a.safety))) || a.choice || a.phaseOrigin ||
      (includeMemberBounds && (a.phaseStart || a.phaseEnd)) || a.anchoredLength ||
      a.onsetDays !== undefined || a.delayMinutes !== undefined || a.cycleDays) return true;
  const timing = a.schedule;
  if (timing?.explicitEvents?.length || timing?.code) return true;
  const r = timing?.recurrence;
  return !!r && (r.count !== undefined || r.countMax !== undefined || r.frequency !== undefined ||
    r.frequencyMax !== undefined || r.period !== undefined || r.periodMax !== undefined || !!r.periodUnit ||
    r.occurrenceDuration !== undefined || r.occurrenceDurationMax !== undefined || !!r.occurrenceDurationUnit || !!r.occurrenceDurationRange ||
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

/** Amount roles qualify their own dose/rate; neither array position nor a
 * preferred role selects a prescription from multiple authored amounts. */
function amountLabel(amount: CanonicalAmount, kind: "dose" | "rate" | "rateRange", words: CourseLanguage): string {
  const ordinary = kind === "dose" ? words.doseLabel : kind === "rate" ? words.rateLabel : words.rateRangeLabel;
  const role = amount.role;
  if (!role) return ordinary;
  let source = role.text?.trim() || undefined;
  for (const coding of role.coding ?? []) {
    if (coding.system === "http://terminology.hl7.org/CodeSystem/dose-rate-type" &&
        (coding.code === "ordered" || coding.code === "calculated"))
      return words.amountRoleLabel(kind, coding.code, source ?? coding.display ?? coding.code);
    source ??= coding.display?.trim() || coding.code;
  }
  return source ? words.amountRoleLabel(kind, undefined, source) : ordinary;
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
  // Member bounds and safety limits qualify the directions; they cannot
  // replace the only authored dose, manner and cadence.
  const authoredDirectionsOnly = a.text?.trim() && !administrationHasClinicalFacts(source, false, false);
  if (authoredDirectionsOnly && !a.limits?.length && !a.safety?.ifExceeded) return a.text!;
  const env = environment ?? courseEnvironment(options),
    words = env.words;
  if (authoredDirectionsOnly)
    return appendDoseLimits(a.text!, a.limits, words, undefined, a.safety?.ifExceeded);
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
  if (source.provenance?.format !== "r6" && source.provenance?.sourceTextVerified !== false &&
      options?.realizationMode !== "normalized" && !a.predicate && !a.safety?.ifExceeded &&
      a.text?.trim() && (maxima || rich)) return a.text;
  // A structured import already built this exact scoped clause for item
  // metadata. Reuse it for both item and whole-course EN/TH previews instead
  // of reconstructing the same dose/timing from native fields five times.
  const clause = compiled ?? clauseForAdministration(a, options);
  // With no structured administration, the live guard qualifies the supplied
  // directions. Independent advice (for example, "Otherwise hold") is not
  // the administration and must not acquire that guard. Do not parse the text.
  const authoredCondition = a.predicate && a.text?.trim() &&
    !canonicalClauseHasAdministrationSemantics(clause) && !clause.instructionGraph?.actions.length;
  const displayClause = authoredCondition
    ? Object.assign({}, clause, { clinicalAdjuncts: Object.assign({}, clause.clinicalAdjuncts, { condition: undefined }) })
    : clause;
  let rendered = formatCanonicalClause(displayClause, style, env.localization, options);
  if (authoredCondition) {
    const directions = appendMedicationConditionText(a.text!, a.predicate!, options, env);
    rendered = a.additionalInstructions?.length || a.patientInstruction
      ? directions + " " + rendered : directions;
  }
  // A route, timing or condition alone cannot replace the only authored
  // dose/manner directions. Label retained source separately from current
  // structured facts; it cannot override a live structured dose or method.
  if (!authoredCondition && a.text?.trim() && (source.schedule || source.route || source.target || source.siteReference || source.predicate) && !administrationHasAmountFacts(source) && !source.method &&
      !clause.instructionGraph?.actions.length)
    rendered = words.withAuthoredDirections(rendered.replace(/\.\s*$/u, ""), a.text);
  if (a.predicate && style !== "long" && !authoredCondition)
    rendered = appendMedicationConditionText(rendered, a.predicate, options, env);
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
  const labelled = (a.amounts?.length ?? 0) > 1 || hasAmountRole(primary?.role);
  // Target count is independent of quantity scope. Labelled discrete amounts
  // can be per-target; metric/biologic totals do not become per-target doses.
  const targetScope: SigDoseScope | undefined = a.targetCount !== undefined && a.targetCount > 1 &&
    a.amounts?.length && (labelled || !clause.dose) ? {
      targetCount: a.targetCount,
      site: resolveBodySitePhrase(clause.site?.text ?? clause.site?.coding?.display ?? "")?.definition
    } : undefined;
  const formatDose = env.localization?.formatDose ?? formatDoseEnglish;
  for (let index = 0; index < (a.amounts?.length ?? 0); index++) {
    const amount = a.amounts![index];
    const scope = targetScope && (amount.quantity ? usesTargetScope(amount.quantity) :
      amount.range && (amount.range.low?.value === undefined || usesTargetScope(amount.range.low)) &&
        (amount.range.high?.value === undefined || usesTargetScope(amount.range.high))) ? targetScope : undefined;
    // A compact clause represents one untyped dose. Multiple entries and
    // explicit roles remain complete, labelled amounts in the native preview.
    if (labelled && amount.quantity) {
      const unit = amount.quantity.unit ?? getDoseQuantityUnit(amount.quantity);
      const fallback = (amount.quantity.value === undefined ? words.unspecified
        : (getQuantityComparator(amount.quantity) ?? "") + amount.quantity.value) + (unit ? " " + unit : "");
      const dose = amount.quantity.value !== undefined
        ? { value: amount.quantity.value, unit, comparator: getQuantityComparator(amount.quantity) } : fallback;
      ranges.push(amountLabel(amount, "dose", words) +
        (formatDose.call(env.localization, dose, style, scope) ?? fallback));
    }
    if (amount.range && (labelled || doseRangeNeedsEndpointPreview(amount.range))) {
      const text = rateRangePreview(amount.range);
      if (text) {
        let dose: CanonicalDoseExpr | string = text;
        if (targetScope && !doseRangeNeedsEndpointPreview(amount.range)) {
          const low = amount.range.low?.value !== undefined ? amount.range.low : undefined;
          const high = amount.range.high?.value !== undefined ? amount.range.high : undefined;
          const unit = low?.unit || getDoseQuantityUnit(low) || high?.unit || getDoseQuantityUnit(high) || undefined;
          dose = { range: { low: amount.range.low?.value, high: amount.range.high?.value }, unit };
        }
        ranges.push(amountLabel(amount, "dose", words) + (targetScope ? formatDose.call(env.localization, dose, style, scope) ?? text : text));
      }
    }
    const text = amount.rateRange && rateRangePreview(amount.rateRange);
    if (text) ranges.push(amountLabel(amount, "rateRange", words) + text);
  }
  return ranges.length ? joinGeneratedClauses(rendered ? [rendered, ...ranges] : ranges) : rendered;
}
export function formatCanonicalAdministration(
  a: CanonicalAdministration,
  style: "short" | "long" = "long",
  options?: FormatOptions,
  compiled?: ReadonlyMap<CanonicalAdministration, CanonicalSigClause>
): string {
  // A component's authored source is distinct from a course-wide instruction.
  if (
    a.provenance?.format !== "r6" && a.provenance?.sourceTextVerified !== false &&
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
  const sourceReplayAllowed = oneOrCourse.provenance?.format !== "r6" &&
    oneOrCourse.provenance?.sourceTextVerified !== false;
  if (!sourceReplayAllowed && oneOrCourse.instruction && !courseHasClinicalFacts(oneOrCourse))
    return oneOrCourse.instruction;
  if (
    sourceReplayAllowed && oneOrCourse.instruction &&
    (options === undefined ||
      options.realizationMode === "roundtrip" ||
      (oneOrCourse.stages.length === 0 && !courseHasClinicalFacts(oneOrCourse)) ||
      (options.realizationMode !== "normalized" && prefersSourceInstruction(oneOrCourse)))
  ) return oneOrCourse.instruction;
  if (oneOrCourse.stages.length === 0 && !oneOrCourse.safety?.limits?.length &&
      !oneOrCourse.safety?.ifExceeded && !oneOrCourse.cycleInterval &&
      oneOrCourse.cycleCount === undefined) return "";
  const environment = courseEnvironment(options);
  // Treatment-start offsets restart with the repeating course. Use that
  // same origin for active windows and their medication-free intervals.
  const words = environment.words;
  const cycleStart = oneOrCourse.cycleInterval ? words.cycleStart : undefined;
  if (oneOrCourse.stages.length === 0) {
    const repetition = oneOrCourse.cycleInterval
      ? formatCourseRepeatCycle(oneOrCourse.cycleInterval, words, oneOrCourse.cycleCount)
      : oneOrCourse.cycleCount === undefined ? "" : words.repeatCount(oneOrCourse.cycleCount);
    // With no administrations, source may be the only dose/manner directions,
    // but can also contain an older cap. Label it beside current structured
    // facts using the same source/current distinction as timing-only members.
    const rendered = appendDoseLimits(repetition, oneOrCourse.safety?.limits, words, "course", oneOrCourse.safety?.ifExceeded);
    return oneOrCourse.instruction ? words.withAuthoredDirections(rendered, oneOrCourse.instruction) : rendered;
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
    !administration.phaseStart && !administration.phaseEnd && !administration.phaseOrigin?.value &&
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
  const groups = previewChoiceGroups(oneOrCourse);
  const labels = new Map<string, Map<string, string>>();
  const stages: string[] = [];
  let labelIndex = 1;
  for (const [groupId, group] of groups) {
    if (group.stages.size < 2 || group.branches.size < 2) continue;
    const branches = new Map<string, string>();
    for (const branchId of group.branches) branches.set(branchId, String(labelIndex++));
    labels.set(groupId, branches);
    stages.push(words.choicePrefix + [...branches.values()].map(label => "(" + label + ")").join(words.anySeparator) + ".");
  }
  const { windows, activeWindows, hasTimedStages, gapAnchor, mixedGapOrigins } = previewCourseWindows(oneOrCourse, groups);
  for (let index = 0; index < oneOrCourse.stages.length; index++) {
    const step = oneOrCourse.stages[index];
    const { start: startDays, end: endDays, startAnchor, endAnchor, choiceDependentStart } = windows[index];
    let rendered = formatCourseChoices(
      step.administrations,
      (component) => {
        const repeat = component.schedule?.recurrence;
        const hasOffsets = repeat?.startOffset !== undefined || repeat?.endOffset !== undefined;
        let display = component;
        const origin = component.phaseOrigin, length = repeat?.courseLength;
        if (origin && length && !component.phaseStart && !component.delayMinutes &&
            !repeat?.calendarWindow && !repeat?.courseLengthRange &&
            step.end?.anchor === "treatment-start" &&
            (!step.start || step.start.anchor === "treatment-start") &&
            !getQuantityComparator(origin) && !getQuantityComparator(length)) {
          const end = treatmentStepOffsetQuantity(step.end);
          const from = treatmentPosition(origin), duration = treatmentPosition(length);
          const until = end && !getQuantityComparator(end) ? treatmentPosition(end) : undefined;
          // Reuse the same conservative position arithmetic as parallel stages.
          // Month additions remain unresolved because their clamping depends on the date.
          const ownEnd = from?.value === 0 ? duration :
            from?.unit === "d" && duration?.unit === "d"
              ? { unit: "d" as const, value: from.value + duration.value } : undefined;
          const order = until && ownEnd ? compareRegimenPositions(until, ownEnd) : undefined;
          const start = step.start && treatmentStepOffsetQuantity(step.start);
          const stageOrigin = start && !getQuantityComparator(start) ? treatmentPosition(start) : undefined;
          const startsHere = from && (stageOrigin ? compareRegimenPositions(from, stageOrigin) === 0 :
            !step.start && from.value === 0);
          // A first-stage authored week must not disappear behind a derived day heading.
          const distinctAuthoredUnit = startsHere && order === 0 &&
            (length.code ?? length.unit) !== (end?.code ?? end?.unit);
          if ((order === 0 || order === -1) && !distinctAuthoredUnit) {
            // The heading already bounds this copied phase. Displaying its whole
            // source length here would suggest restarting it at this global cut.
            const { courseLength: _length, ...cadence } = repeat!;
            display = { ...display, schedule: { ...display.schedule, recurrence: cadence } };
          }
        }
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
          const { code: timingCode, ...withoutCode } = display.schedule;
          const codeAgrees = !(_period === undefined && _periodMax !== undefined) &&
            timingCodeMatchesRecurrence(display.schedule.recurrence,
              timingCode?.coding?.[0]?.code ?? timingCode?.text);
          display = { ...display, schedule: {
            ...(structuredCount || !codeAgrees ? withoutCode : display.schedule), recurrence: rest
          } };
        }
        // The clause owns one untyped dose, including its qualifier and target.
        // Multiple or role-bearing amounts and rate qualifiers remain labelled
        // native entries rather than an unqualified positional dose.
        if (
          display.amounts &&
          component.amounts?.some(
            (amount, index) =>
              amount.rate?.comparator ||
              amount.rateRatio?.numerator?.comparator === "~"
          )
        ) {
          display = {
            ...display,
            amounts: display.amounts.map((amount, i) => {
              const source = component.amounts?.[i];
              const clean = { ...amount };
              if (source?.rate?.comparator) delete clean.rate;
              if (source?.rateRatio?.numerator?.comparator === "~") delete clean.rateRatio;
              return clean;
            }),
          };
        }
        const recognized = formatCanonicalBase(
          display,
          style,
          hasOffsets ? { ...options, includeTimesPerDaySummary: false } : options,
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
          if (amount.rate && (amount.rate.value !== undefined || amount.rate.unit || amount.rate.code)) {
            const rate = amount.rate;
            const unit = rate.unit ?? rate.code;
            expressions.push(
              amountLabel(amount, "rate", words) +
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
          const carrierMaterial = component.syntax?.clinicalQuantity?.carrierMaterial?.text;
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
              amountLabel(amount, "rate", words) +
                numeratorValue +
                (numeratorUnit ? " " + numeratorUnit : "") +
                (carrierMaterial ? " " + carrierMaterial : "") +
                (hasDenominator
                  ? " / " + denominatorValue + (denominatorUnit ? " " + denominatorUnit : "")
                  : "")
            );
          }
          if (amount.expression)
            expressions.push((hasAmountRole(amount.role) ? amountLabel(amount, "dose", words) : "") +
              unevaluatedExpressionText(amount.expression, "dose", words));
          if (amount.rateExpression)
            expressions.push((hasAmountRole(amount.role) ? amountLabel(amount, "rate", words) : "") +
              unevaluatedExpressionText(amount.rateExpression, "rate", words));
        }
        const body = joinGeneratedClauses([recognized, ...expressions].filter(Boolean));
        let memberTiming = component.phasePredecessors?.length && !component.phaseStart && !origin
          ? words.afterPreviousPhase : undefined;
        if (component.phaseStart) {
          const boundary = component.phaseStart;
          const quantity = treatmentStepOffsetQuantity(boundary);
          const days = boundary.anchor === "treatment-day-start" ? exactCourseDays(quantity) : undefined;
          const point = treatmentBoundaryRangeText(boundary, words, cycleStart) ??
            courseBoundaryPoint(quantity, boundary.anchor, words, cycleStart) ?? boundaryEventText(boundary, words, cycleStart);
          const knownOrigin = boundary.anchor === "treatment-start" || boundary.anchor === "treatment-day-start" ||
            (boundary.anchor === "previous-phase-next-day" && (index > 0 || Boolean(component.phasePredecessors?.length)));
          memberTiming = knownOrigin
            ? days !== undefined ? words.fromDay(days + 1)
              : words.calendarWindow(point ?? (boundary.anchor === "treatment-start" ? cycleStart ?? words.treatmentStart : words.treatmentDayStart))
            : words.reviewTiming(point ?? boundary.description);
        }
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
            afterCourseStart(formatCourseTimeQuantity(origin, words), words, cycleStart), undefined);
        }
        if (component.phaseEnd) {
          const boundary = component.phaseEnd;
          const point = treatmentBoundaryRangeText(boundary, words, cycleStart) ??
            courseBoundaryPoint(treatmentStepOffsetQuantity(boundary), boundary.anchor, words, cycleStart) ??
            boundaryEventText(boundary, words, cycleStart);
          const endTiming = point ? words.calendarWindow(undefined, point) : words.reviewTiming(boundary.description);
          memberTiming = memberTiming ? memberTiming + "; " + endTiming : endTiming;
        }
        return memberTiming ? memberTiming + ": " + body : body;
      },
      (member) => member.choice,
      words,
      options?.separator,
      labels
    );
    if (step.safety)
      rendered = appendDoseLimits(rendered, step.safety.limits, words, "stage", step.safety.ifExceeded);
    if (!rendered.trim()) continue;
    let timing = "";
    if (step.start || step.end || index > 0) {
      const previous = !step.start && !choiceDependentStart && index > 0 ? oneOrCourse.stages[index - 1] : undefined;
      const inheritedStart = previous && (previous.count === undefined || previous.count === 1)
        ? treatmentStepOffsetQuantity(previous.end) : undefined;
      const reversedWindow = startAnchor === endAnchor &&
        startDays !== undefined && endDays !== undefined && endDays <= startDays;
      if (
        (step.start && startDays === undefined) ||
        (inheritedStart && startDays === undefined) ||
        (step.end && endDays === undefined) ||
        reversedWindow
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
          !reversedWindow
        ) {
          timing = formatCalendarStepWindow(startQuantity, endQuantity, words, startAnchor, endAnchor, cycleStart);
          if (index > 0 && !step.start && !startQuantity)
            timing = words.afterPreviousPhase + "; " + timing;
        } else {
          const startRange = treatmentBoundaryRangeText(step.start, words, cycleStart);
          const endRange = treatmentBoundaryRangeText(step.end, words, cycleStart);
          if ((startRange || !step.start || startQuantity) &&
              (endRange || !step.end || endQuantity) && (startRange || endRange)) {
            timing = words.calendarWindow(startRange ?? courseBoundaryPoint(startQuantity, startAnchor, words, cycleStart), endRange ?? courseBoundaryPoint(endQuantity, endAnchor, words, cycleStart));
            if (index > 0 && !step.start && !startQuantity)
              timing = words.afterPreviousPhase + "; " + timing;
          } else {
            // Current structured bounds own the window. Descriptive source is
            // a fallback, and each side is a point rather than an open window.
            const start = startRange ?? boundaryEventText(step.start, words, cycleStart) ??
              courseBoundaryPoint(startQuantity, startAnchor, words, cycleStart) ?? step.start?.description;
            const end = endRange ?? boundaryEventText(step.end, words, cycleStart) ??
              courseBoundaryPoint(endQuantity, endAnchor, words, cycleStart) ?? step.end?.description;
            const contextualStart = index > 0 && step.start?.anchor === "previous-phase-next-day";
            const contextualEnd = index > 0 && step.end?.anchor === "previous-phase-next-day";
            const unresolvedEnd = Boolean(step.end && !end);
            const window = unresolvedEnd ? [start, words.reviewTiming(undefined, "end")].filter(Boolean).join("; ")
              : words.calendarWindow(start, end);
            timing = unresolvedEnd ? window : (contextualStart || contextualEnd) &&
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
          words, startAnchor, endAnchor, cycleStart
        );
        if (index > 0 && !step.start && startDays === undefined)
          timing = words.afterPreviousPhase + "; " + timing;
      } else if (index > 0) {
        // The next phase is ordered even when its predecessor has no exact
        // end; displaying it without this context would make it immediate.
        timing = inheritedStart
          ? formatCalendarStepWindow(inheritedStart, undefined, words, previous?.end?.anchor, undefined, cycleStart)
          : words.afterPreviousPhase;
      }
    }
    // A successor can finish this stage before any open-ended continuation.
    // Show the known origin as a point; do not invent an end that could
    // contradict the member's earlier duration/count completion.
    if (!step.end && index + 1 < oneOrCourse.stages.length) {
      const quantity = step.start ? treatmentStepOffsetQuantity(step.start)
        : startDays === undefined ? undefined : { value: startDays, unit: "d" };
      const point = treatmentBoundaryRangeText(step.start, words, cycleStart) ??
        courseBoundaryPoint(quantity, startAnchor, words, cycleStart) ??
        (step.start?.anchor === "previous-phase-next-day" ? boundaryEventText(step.start, words, cycleStart) : undefined);
      if (point) timing = point;
    }
    const stageCount = step.count !== undefined ? words.phaseCount(step.count) : "";
    const heading = [timing, stageCount].filter(Boolean).join("; ");
    stages.push(heading ? `${heading}: ${rendered}` : rendered);
  }
  const pauseText = (pause: { start: number; end: number }, anchor: CanonicalBoundary["anchor"] | undefined): string =>
    anchor === "treatment-day-start"
      ? words.noDoseDays(pause.start + 1, pause.end)
      : words.noDoseWindow(
          pause.start === 0 ? cycleStart ?? words.treatmentStart
            : afterCourseStart(formatCourseTimeQuantity({ value: pause.start, code: "d" }, words), words, cycleStart),
          afterCourseStart(formatCourseTimeQuantity({ value: pause.end, code: "d" }, words), words, cycleStart));
  const pauses = hasTimedStages && !mixedGapOrigins
    ? medicationFreeCourseWindows(activeWindows, oneOrCourse.cycleInterval) : [];
  for (const pause of pauses) stages.push(pauseText(pause, gapAnchor));
  for (const [groupId, branches] of labels) {
    for (const [branchId, label] of branches) {
      const selected = previewCourseWindows(oneOrCourse, groups, { groupId, branchId });
      if (!selected.hasTimedStages || selected.mixedGapOrigins) continue;
      for (const pause of medicationFreeCourseWindows(selected.activeWindows, oneOrCourse.cycleInterval)) {
        if (selected.gapAnchor === gapAnchor && pauses.some(global => global.start === pause.start && global.end === pause.end)) continue;
        stages.push("(" + label + "): " + pauseText(pause, selected.gapAnchor));
      }
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
