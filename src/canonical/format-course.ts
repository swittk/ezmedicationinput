/** Native clinical course realization. This module reads canonical facts
 * and the existing grammar renderer, never FHIR rows or persistence markers.
 * Display stays separate from executable interpretation: unknown expressions
 * and boundaries remain visible without inventing values or event dates. */
import type { FormatOptions, MedicationCondition, FhirDayOfWeek } from "../types";
import type {
  CanonicalCourse,
  CanonicalAdministration,
  CanonicalMeasure,
  CanonicalRange,
  CanonicalExpression,
} from "./course";
import { measureOperator as getQuantityComparator } from "./course";
import { clauseForAdministration } from "./compile";
import { DAY_NAMES, formatCanonicalClause, joinWithAnd } from "../format";
import { DAY_NAMES_THAI, joinWithAndThai, resolveSigLocalization } from "../i18n";

export function joinGeneratedClauses(clauses: string[]): string {
  return clauses
    .map((clause, index) => (index < clauses.length - 1 ? clause.replace(/\.\s*$/u, "") : clause))
    .join("; ");
}
function medicationConditionBody(condition: MedicationCondition, locale?: string): string {
  const thai = (locale ?? "").toLowerCase().indexOf("th") === 0;
  switch (condition.kind) {
    case "measurement": {
      // Imported FHIR often supplies only the concept label as text. It is
      // not a realization of a comparator, value, or negated Boolean state.
      if (condition.text?.trim() && condition.text.trim() !== condition.name.trim()) {
        return condition.text.trim();
      }
      const operator = {
        gt: ">",
        ge: ">=",
        lt: "<",
        le: "<=",
        eq: "=",
        ne: "!=",
      }[condition.operation];
      return (
        condition.name + " " + operator + " " + condition.value + (condition.unit ? " " + condition.unit : "")
      );
    }
    case "state":
      // Imported FHIR often supplies only the concept label as text. It is
      // not a realization of a comparator, value, or negated Boolean state.
      if (condition.text?.trim() && condition.text.trim() !== condition.name.trim()) {
        return condition.text.trim();
      }
      return condition.expected ? condition.name : (thai ? "ไม่ " : "not ") + condition.name;
    case "text":
      return condition.text;
    case "not":
      return (thai ? "ไม่ " : "not ") + "(" + medicationConditionBody(condition.condition, locale) + ")";
    case "all":
    case "any":
      return condition.conditions
        .map((value) => {
          const body = medicationConditionBody(value, locale);
          // Mixed Boolean daughters retain the exact tree grouping. Only the
          // outer NOT uses "unless"; an inner NOT must remain explicit here.
          return (value.kind === "all" || value.kind === "any") && value.kind !== condition.kind
            ? "(" + body + ")"
            : body;
        })
        .join(condition.kind === "all" ? (thai ? " และ " : " and ") : thai ? " หรือ " : " or ");
  }
}

export function appendMedicationExcludedDatesText(
  text: string,
  dates: readonly string[],
  options?: FormatOptions
): string {
  if (!dates.length) return text;
  const thai = (options?.locale ?? "").toLowerCase().indexOf("th") === 0;
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  const lead = thai ? "ยกเว้นวันที่" : "except";
  const separator = thai ? " และ " : " and ";
  return (trimmed ? trimmed + " " : "") + lead + " " + dates.join(separator) + ".";
}

/** Realize a typed weekday exclusion when no source-written instruction exists.
 * Reuse the ordinary localizers rather than introducing a competing day lexicon.
 */
export function appendMedicationExcludedWeekdaysText(
  text: string,
  days: readonly FhirDayOfWeek[],
  options?: FormatOptions
): string {
  if (!days.length) return text;
  const thai = (options?.locale ?? "").toLowerCase().startsWith("th");
  const labels = [...new Set(days)].map((day) => (thai ? DAY_NAMES_THAI[day] : DAY_NAMES[day]) ?? day);
  const readable = thai ? joinWithAndThai(labels) : joinWithAnd(labels);
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + (thai ? "ยกเว้น" : "except ") + readable + ".";
}

export function appendMedicationConditionText(
  text: string,
  condition: MedicationCondition,
  options?: FormatOptions
): string {
  const locale = options?.locale;
  const thai = (locale ?? "").toLowerCase().indexOf("th") === 0;
  const body =
    condition.kind === "not"
      ? medicationConditionBody(condition.condition, locale)
      : medicationConditionBody(condition, locale);
  const lead = condition.kind === "not" ? (thai ? "เว้นแต่" : "unless") : thai ? "เฉพาะเมื่อ" : "only if";
  const trimmed = text.trim().replace(/[.!?]+$/u, "");
  return (trimmed ? trimmed + " " : "") + lead + " " + body + ".";
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

/** Find gaps in the union of all typed course windows, not between adjacent rows.
 * An open-ended or unresolved parallel stage cannot license a global withholding instruction.
 * @param windows Resolved treatment-day windows for every nonempty step.
 * @param repeatCycle Original whole-course period, when the schedule repeats.
 * @returns Half-open calendar-day intervals where the entire course has no medication.
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
export function unevaluatedExpressionText(expression: CanonicalExpression, kind: "dose" | "rate"): string {
  const detail = expression.expression ?? expression.reference ?? expression.description ?? expression.name;
  return `unevaluated ${kind} expression${detail ? ": " + detail : ""}`;
}

/** Realize a temporal quantity without approximating calendar months or years.
 * @param quantity Original typed temporal quantity.
 * @param thai Whether the requested realization is Thai.
 * @returns The original amount/comparator with a localized temporal unit.
 */
function formatCourseTimeQuantity(quantity: CanonicalMeasure, thai: boolean): string {
  const units: Record<string, readonly [string, string, string]> = {
    s: ["second", "seconds", "วินาที"],
    min: ["minute", "minutes", "นาที"],
    h: ["hour", "hours", "ชั่วโมง"],
    d: ["day", "days", "วัน"],
    wk: ["week", "weeks", "สัปดาห์"],
    mo: ["month", "months", "เดือน"],
    a: ["year", "years", "ปี"],
  };
  const unit = quantity.code ?? quantity.unit ?? "";
  const label = units[unit]?.[thai ? 2 : quantity.value === 1 ? 0 : 1] ?? quantity.unit ?? unit;
  return `${getQuantityComparator(quantity) ?? ""}${quantity.value ?? ""} ${label}`.trim();
}

/** Render the typed whole-course repetition interval independently of component cadence.
 * @param cycle Original R6 repeatCycle quantity; unknown units remain verbatim.
 * @param thai Whether the requested realization is Thai.
 * @param count Supplied common step repetition count, when explicitly finite.
 * @returns A visible cycle instruction preserving the supplied count without inventing an end date.
 */
function formatCourseRepeatCycle(cycle: CanonicalMeasure, thai: boolean, count?: number): string {
  const unit = cycle.code ?? cycle.unit ?? "";
  const interval = formatCourseTimeQuantity(cycle, thai);
  const iterations =
    count === undefined
      ? ""
      : thai
      ? ` จำนวน ${count} รอบ`
      : ` for ${count} ${count === 1 ? "cycle" : "cycles"}`;
  if (
    getQuantityComparator(cycle) ||
    cycle.value === undefined ||
    !Number.isFinite(cycle.value) ||
    cycle.value <= 0 ||
    !unit
  ) {
    return thai
      ? `ระยะรอบการใช้ยา: ${interval}${iterations}.`
      : `Repeat-cycle interval: ${interval}${iterations}.`;
  }
  return thai
    ? `ทำซ้ำแผนการใช้ยานี้ทุก ${interval}${iterations} (นับวันที่ใหม่ในแต่ละรอบ).`
    : `Repeat this schedule every ${interval}${iterations} (days are numbered within each cycle).`;
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
  if (!relative || relative.anchor !== "treatment-start" || relative.displacementRange) return undefined;
  const quantity = relative.displacement;
  return quantity && quantity.value !== undefined && Number.isFinite(quantity.value) && quantity.value >= 0
    ? quantity
    : undefined;
}

/** Convert an exact treatment-start boundary into a calendar-day ordinal.
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
function formatCalendarStepWindow(
  start: CanonicalMeasure | undefined,
  end: CanonicalMeasure | undefined,
  thai: boolean
): string {
  const point = (quantity: CanonicalMeasure) =>
    quantity.value === 0 && !getQuantityComparator(quantity)
      ? thai
        ? "เริ่มการรักษา"
        : "treatment start"
      : thai
      ? `${formatCourseTimeQuantity(quantity, true)}หลังเริ่มการรักษา`
      : `${formatCourseTimeQuantity(quantity, false)} after treatment start`;
  if (start && end)
    return thai ? `ตั้งแต่${point(start)}จนถึง${point(end)}` : `From ${point(start)} until ${point(end)}`;
  if (start) return thai ? `ตั้งแต่${point(start)}เป็นต้นไป` : `From ${point(start)} onward`;
  return end ? (thai ? `จนถึง${point(end)}` : `Until ${point(end)}`) : "";
}

/** Source-less R6 rateRange remains a range, never a guessed exact rate.
 * Keep both independently authored endpoints and their unit/EMA operators. */
export function rateRangePreview(range: CanonicalRange): string | undefined {
  const low = range.low,
    high = range.high;
  const unit = (q: CanonicalMeasure | undefined) => q?.unit ?? q?.code ?? "";
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
    course.cycleInterval ||
      course.constraints ||
      course.stages.some(
        (step) =>
          step.start ||
          step.end ||
          step.count !== undefined ||
          step.constraints ||
          step.administrations.some(
            (component) =>
              component.predicate ||
              component.constraints ||
              component.siteReference ||
              component.amounts?.some((rate) => rate.expression || rate.rateExpression)
          )
      )
  );
}

/** One pass organizes native choice membership. It never decodes a wire
 * marker or repeatedly scans the entire component array for each branch. */
function formatCanonicalChoices(
  members: readonly CanonicalAdministration[],
  render: (member: CanonicalAdministration) => string,
  options?: FormatOptions,
  separator = "; "
): string {
  const slots: Array<{ text: string } | { group: string }> = [];
  const groups = new Map<string, Map<string, string[]>>();
  for (const member of members) {
    const choice = member.choice,
      text = render(member).trim();
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
  if (!groups.size) return joinGeneratedClauses(slots.map((slot) => (slot as { text: string }).text));
  const thai = (options?.locale ?? "").toLowerCase().startsWith("th");
  return slots
    .map((slot) => {
      if ("text" in slot) return slot.text;
      const choices = [...groups.get(slot.group)!.values()].map((texts) => texts.join("; ")).filter(Boolean);
      return choices.length
        ? (thai ? "เลือกอย่างใดอย่างหนึ่ง: " : "Choose one: ") + choices.join(thai ? " หรือ " : " or ") + "."
        : "";
    })
    .filter(Boolean)
    .join(separator);
}
/** Common clause preview; whole-course composition adds rich rates/expressions
 * without routing them through a more restrictive interchange version. */
function formatCanonicalBase(
  a: CanonicalAdministration,
  style: "short" | "long",
  options?: FormatOptions
): string {
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
    a.constraints ||
    a.siteReference ||
    a.excludedDates?.length ||
    a.excludedWeekdays?.length;
  if (a.text?.trim() && (maxima || rich)) return a.text;
  const clause = clauseForAdministration(a);
  let rendered = formatCanonicalClause(
    clause,
    style,
    resolveSigLocalization(options?.locale, options?.i18n),
    options
  );
  const limits: string[] = [];
  const readable = (q: CanonicalMeasure | undefined) =>
    q?.value !== undefined && Number.isFinite(q.value)
      ? `${q.comparator ?? ""}${q.value}${q.unit || q.code ? " " + (q.unit ?? q.code) : ""}`
      : undefined;
  for (const limit of a.limits ?? []) {
    const amount = readable(limit.amount);
    if (!amount) continue;
    if (limit.scope === "period") {
      const period = readable(limit.period);
      if (period) limits.push("max per period: " + amount + " / " + period);
    } else if (limit.scope === "administration") limits.push("max per administration: " + amount);
    else if (limit.scope === "lifetime") limits.push("max lifetime: " + amount);
  }
  if (limits.length) rendered = joinGeneratedClauses([rendered, ...limits]);
  if (a.predicate) rendered = appendMedicationConditionText(rendered, a.predicate, options);
  if (a.excludedDates?.length)
    rendered = appendMedicationExcludedDatesText(rendered, a.excludedDates, options);
  if (a.excludedWeekdays?.length)
    rendered = appendMedicationExcludedWeekdaysText(rendered, a.excludedWeekdays, options);
  const ranges: string[] = [];
  for (const amount of a.amounts ?? []) {
    const text = amount.rateRange && rateRangePreview(amount.rateRange);
    if (text)
      ranges.push(
        (options?.locale?.toLowerCase().startsWith("th") ? "ช่วงอัตราการให้ยา: " : "Rate range: ") + text
      );
  }
  return ranges.length ? joinGeneratedClauses([rendered, ...ranges]) : rendered;
}
export function formatCanonicalAdministration(
  a: CanonicalAdministration,
  style: "short" | "long" = "long",
  options?: FormatOptions
): string {
  // A component's authored source is distinct from a course-wide instruction.
  if (
    a.text?.trim() &&
    (a.schedule?.recurrence?.startOffset ||
      a.schedule?.recurrence?.endOffset ||
      a.amounts?.some(
        (v) =>
          v.quantity?.comparator || v.rate || v.rateRatio || v.rateRange || v.expression || v.rateExpression
      ))
  )
    return a.text;
  return formatCanonicalCourse({ kind: "course", stages: [{ administrations: [a] }] }, style, options);
}

export function formatCanonicalCourse(
  oneOrCourse: CanonicalCourse,
  style: "short" | "long" = "long",
  options?: FormatOptions
): string {
  // R6's renderedInstruction is the whole-course instruction. Do not
  // accidentally reduce a taper to a single component or discard its
  // boolean conditions in an English/Thai realization attempt. For an
  // ordinary R5-compatible course, explicit format options request a fresh
  // realization instead of the potentially stale saved display string.
  const prefersCourseSource = prefersSourceInstruction(oneOrCourse);
  if (
    oneOrCourse.instruction &&
    (options === undefined ||
      options.realizationMode === "roundtrip" ||
      oneOrCourse.stages.length === 0 ||
      prefersCourseSource)
  ) {
    // An explicitly requested round trip preserves the *original* source
    // surface, not a normalized paraphrase. Edited R5 inputs have their
    // stale source invalidated by the R5->R6 reconciliation first.
    return oneOrCourse.instruction;
  }
  if (oneOrCourse.stages.length === 0) return "";
  // Rendering needs each component's projection, not a persisted copy of
  // the whole course plus edit markers on every component.
  const thai = (options?.locale ?? "").toLowerCase().startsWith("th");
  const stages: string[] = [];
  const firstRepeatCount = oneOrCourse.stages[0]?.count;
  const courseRepeatCount =
    firstRepeatCount !== undefined && oneOrCourse.stages.every((step) => step.count === firstRepeatCount)
      ? firstRepeatCount
      : undefined;
  let priorEndDays: number | undefined;
  const windows = oneOrCourse.stages.map((step, index) => {
    const start = step.start ? treatmentStepOffsetDays(step.start) : index === 0 ? 0 : priorEndDays;
    const end = treatmentStepOffsetDays(step.end);
    priorEndDays = end;
    return { start, end };
  });
  for (const [index, step] of oneOrCourse.stages.entries()) {
    const { start: startDays, end: endDays } = windows[index];
    const rendered = formatCanonicalChoices(
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
          display = { ...display, schedule: { ...display.schedule, recurrence: rest } };
        }
        // R5 consumers must see the numeric value, but an R6 display must
        // not first state an exact dose and then its qualified "~" dose.
        // Suppress only that duplicate in this temporary display projection.
        if (
          display.amounts &&
          component.amounts?.some(
            (amount) =>
              amount.quantity?.comparator ||
              amount.rate?.comparator ||
              amount.rateRatio?.numerator?.comparator === "~"
          )
        ) {
          display = {
            ...display,
            amounts: display.amounts.map((amount, i) => {
              const source = component.amounts?.[i];
              const clean = { ...amount };
              if (source?.quantity?.comparator) delete clean.quantity;
              if (source?.rate?.comparator) delete clean.rate;
              if (source?.rateRatio?.numerator?.comparator === "~") delete clean.rateRatio;
              return clean;
            }),
          };
        }
        const recognized = formatCanonicalBase(display, style, options);
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
                    thai
                  )}`
                : formatCourseTimeQuantity(
                    {
                      value: repeat.period,
                      code: periodUnit,
                      unit: periodUnit,
                    },
                    thai
                  )
              : periodUnit && repeat.periodMax !== undefined
              ? (thai ? "ไม่เกิน " : "up to ") +
                formatCourseTimeQuantity(
                  {
                    value: repeat.periodMax,
                    code: periodUnit,
                    unit: periodUnit,
                  },
                  thai
                )
              : undefined;
          const frequency =
            repeat.frequency !== undefined
              ? repeat.frequencyMax !== undefined
                ? `${repeat.frequency}–${repeat.frequencyMax}`
                : String(repeat.frequency)
              : repeat.frequencyMax !== undefined
              ? (thai ? "ไม่เกิน " : "up to ") + repeat.frequencyMax
              : undefined;
          if (frequency)
            expressions.push(
              thai
                ? `ให้ยา ${frequency} ครั้ง${period ? "ต่อช่วง " + period : ""}`
                : `${frequency} administrations${period ? " per " + period : ""}`
            );
          else if (period && repeat.periodMax !== undefined)
            expressions.push(thai ? `ช่วงเวลาการให้ยา ${period}` : `Dosing period: ${period}`);
          const periodContext = period
            ? thai
              ? ` (รอบละ ${period})`
              : ` (each period lasts ${period})`
            : "";
          if (repeat.startOffset) {
            const offset = formatCourseTimeQuantity(repeat.startOffset, thai);
            expressions.push(
              thai
                ? `เริ่มให้ยาหลังเริ่มรอบ ${offset}${periodContext}`
                : `Dosing starts ${offset} after the period begins${periodContext}`
            );
          }
          if (repeat.endOffset) {
            const offset = formatCourseTimeQuantity(repeat.endOffset, thai);
            expressions.push(
              thai
                ? `งดยาในช่วง ${offset}สุดท้ายของแต่ละรอบ${periodContext}`
                : `No doses during the final ${offset} of each period${periodContext}`
            );
          }
        }
        for (const amount of component.amounts ?? []) {
          // Native R6 Quantity comparators are absent from R5 SimpleQuantity.
          // Keep their actual amount visible in source-less R6 suggestions,
          // without introducing invalid R5 dose/rate choices.
          if (amount.quantity?.comparator && amount.quantity.value !== undefined) {
            expressions.push(
              (thai ? "ขนาดยาต่อครั้ง: " : "Dose: ") +
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
              (thai ? "อัตราการให้ยา: " : "Rate: ") +
                (rate.value === undefined
                  ? thai
                    ? "ไม่ระบุค่า"
                    : "unspecified"
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
            const unspecified = thai ? "ไม่ระบุค่า" : "unspecified";
            const numeratorValue =
              numerator?.value === undefined
                ? unspecified
                : (getQuantityComparator(numerator) ?? "") + numerator.value;
            const denominatorValue =
              denominator?.value === undefined
                ? unspecified
                : (getQuantityComparator(denominator) ?? "") + denominator.value;
            expressions.push(
              (thai ? "อัตราการให้ยา: " : "Rate: ") +
                numeratorValue +
                (numeratorUnit ? " " + numeratorUnit : "") +
                (hasDenominator
                  ? " / " + denominatorValue + (denominatorUnit ? " " + denominatorUnit : "")
                  : "")
            );
          }
          if (amount.expression) expressions.push(unevaluatedExpressionText(amount.expression, "dose"));
          if (amount.rateExpression)
            expressions.push(unevaluatedExpressionText(amount.rateExpression, "rate"));
        }
        return joinGeneratedClauses([recognized, ...expressions].filter(Boolean));
      },
      options
    );
    if (!rendered.trim()) continue;
    let timing = "";
    if (step.start || step.end) {
      if (
        (step.start && startDays === undefined) ||
        (step.end && endDays === undefined) ||
        (startDays !== undefined && endDays !== undefined && endDays <= startDays)
      ) {
        // Unsupported event anchors must stay visible instead of becoming
        // an unconditional dose when the original source text is absent.
        const startQuantity = step.start
          ? treatmentStepOffsetQuantity(step.start)
          : index === 0
          ? { value: 0, unit: "d" }
          : treatmentStepOffsetQuantity(oneOrCourse.stages[index - 1].end);
        const endQuantity = treatmentStepOffsetQuantity(step.end);
        if (
          (!step.start || startQuantity) &&
          (!step.end || endQuantity) &&
          !(startDays !== undefined && endDays !== undefined && endDays <= startDays)
        ) {
          timing = formatCalendarStepWindow(startQuantity, endQuantity, thai);
        } else {
          const source = [step.start?.description, step.end?.description]
            .filter((value): value is string => Boolean(value?.trim()))
            .join("; ");
          timing = source
            ? thai
              ? `ต้องตรวจสอบช่วงเวลา: ${source}`
              : `Timing requires review: ${source}`
            : thai
            ? "ต้องตรวจสอบช่วงเวลาการใช้ยา"
            : "Stage timing requires review";
        }
      } else if (endDays !== undefined && startDays !== undefined) {
        timing = thai ? `วันที่ ${startDays + 1}–${endDays}` : `Days ${startDays + 1}–${endDays}`;
      } else if (startDays !== undefined) {
        timing = thai ? `ตั้งแต่วันที่ ${startDays + 1} เป็นต้นไป` : `From day ${startDays + 1} onward`;
      } else if (endDays !== undefined) {
        timing = thai ? `ถึงวันที่ ${endDays}` : `Through day ${endDays}`;
      }
    }
    const stageCount =
      oneOrCourse.cycleInterval && courseRepeatCount === undefined && step.count !== undefined
        ? thai
          ? `จำนวน ${step.count} รอบ`
          : `for ${step.count} ${step.count === 1 ? "cycle" : "cycles"}`
        : "";
    const heading = [timing, stageCount].filter(Boolean).join("; ");
    stages.push(heading ? `${heading}: ${rendered}` : rendered);
  }
  const hasTimedStages = oneOrCourse.stages.some((step) => step.start || step.end);
  if (hasTimedStages) {
    const pauses = medicationFreeCourseWindows(
      windows.filter((_, index) => oneOrCourse.stages[index].administrations.length > 0),
      oneOrCourse.cycleInterval
    );
    for (const pause of pauses) {
      stages.push(
        thai
          ? `งดยาในวันที่ ${pause.start + 1}–${pause.end}.`
          : `No doses on days ${pause.start + 1}–${pause.end}.`
      );
    }
  }
  if (oneOrCourse.cycleInterval) {
    stages.push(formatCourseRepeatCycle(oneOrCourse.cycleInterval, thai, courseRepeatCount));
  }
  return stages.join(hasTimedStages || oneOrCourse.cycleInterval ? " " : thai ? " จากนั้น " : " then ");
}
