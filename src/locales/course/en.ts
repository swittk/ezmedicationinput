/** English course wording. Clinical scope and date arithmetic are supplied
 * by the canonical formatter; this module owns words and English inflection. */
import type { CourseLanguage } from "../../localization";
import { joinLocalizedList } from "../../utils/text";

export const ENGLISH_DAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const UNITS: Readonly<Record<string, readonly [string, string]>> = {
  s: ["second", "seconds"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
  wk: ["week", "weeks"],
  mo: ["month", "months"],
  a: ["year", "years"],
};
const MEASUREMENT_NAMES: Readonly<Record<string, string>> = {
  bp: "BP", sbp: "SBP", dbp: "DBP", hr: "HR", spo2: "SpO2",
};
export const ENGLISH_COURSE: CourseLanguage = {
  unresolvedCycleTiming: (days, periodDays, cycles, anchor) => {
    const details = [
      ...(days ? ["cycle days " + days] : []),
      ...(periodDays !== undefined ? [periodDays + "-day cycle"] : []),
      ...(cycles !== undefined ? [cycles + " cycles"] : []),
      ...(anchor ? ["cycle anchor " + anchor] : [])
    ];
    return "Unresolved cycle timing" + (details.length ? " (" + details.join("; ") + ")" : "");
  },
  notPrefix: "not ",
  allSeparator: " and ",
  anySeparator: " or ",
  onlyIf: "only if",
  unless: "unless",
  exceptDates: "except",
  exceptWeekdays: "except ",
  choicePrefix: "Choose one: ",
  stageSeparator: " then ",
  doseLabel: "Dose: ",
  applicationSites: (count) => "across " + count + " sites",
  amountRoleLabel: (kind, role, sourceRole) => {
    const label = kind === "dose" ? "dose" : kind === "rate" ? "rate" : "rate range";
    return role ? (role === "ordered" ? "Ordered " : "Calculated ") + label + ": "
      : label[0].toUpperCase() + label.slice(1) + " (" + sourceRole + "): ";
  },
  rateLabel: "Rate: ",
  rateRangeLabel: "Rate range: ",
  unspecified: "unspecified",
  withAuthoredDirections: (current, source) => (current.startsWith("Current: ") ? current : "Current: " + current) + "; original directions: " + source,
  treatmentStart: "treatment start",
  cycleStart: "each cycle start",
  incompleteInterpretation: "INCOMPLETE medication interpretation — safety restrictions require review",
  retainedStructure: "Structured FHIR data is retained",
  maxAdministrationLabel: "max per administration: ",
  maxLifetimeLabel: "max lifetime: ",
  maxPeriodLabel: "max per period: ",
  maxDosageLabel: "max per dosage: ",
  courseLimitsLabel: "Across this course: ",
  stageLimitsLabel: "Within this stage: ",
  ifLimitExceeded: (action) => "If the limit is exceeded: " + action,
  eventWindow: (start, end) => `between ${start.replace(/^(?:with |at |in the )/u, "")} and ${end.replace(/^(?:with |at |in the )/u, "")}`,
  weekdayName: (day) => ENGLISH_DAY_NAMES[day] ?? day,
  measurementName: (name) => MEASUREMENT_NAMES[name] ?? name,
  joinList: (items) => joinLocalizedList(items,"and"),
  timeUnit: (unit, value) => UNITS[unit]?.[value === 1 ? 0 : 1],
  expression: (kind, detail) => `unevaluated ${kind} expression${detail ? ": " + detail : ""}`,
  upTo: (value) => "up to " + value,
  administrations: (frequency, period) => `${frequency} ${frequency === "1" ? "administration" : "administrations"}${period ? " per " + period : ""}`,
  dosingPeriod: (period) => `Dosing period: ${period}`,
  periodContext: (period) => ` (each period lasts ${period})`,
  startsWithinPeriod: (offset, context) => `Dosing starts ${offset} after the period begins${context}`,
  endsWithinPeriod: (offset, context) => `No doses during the final ${offset} of each period${context}`,
  treatmentDayStart: "the start of the first treatment day",
  afterPreviousPhase: "After the previous phase",
  nextDayAfterPreviousPhase: "the day after the previous phase",
  afterTreatmentStart: (offset) => `${offset} after treatment start`,
  relativeEvent: (offset, event, before) => `${offset} ${before ? "before" : "after"} ${event ?? "the event"}`,
  calendarWindow: (start, end) =>
    start && end ? `From ${start} until ${end}` : start ? `From ${start} onward` : end ? `Until ${end}` : "",
  calendarEvents: (events) => "Scheduled events: " + events.join(", "),
  reviewTiming: (source, boundary) => boundary === "end"
    ? "End timing requires review" + (source ? ": " + source : "")
    : (source ? "Timing requires review: " + source : "Stage timing requires review"),
  dayRange: (first, last) => `Days ${first}–${last}`,
  fromDay: (first) => `From day ${first} onward`,
  throughDay: (last) => `Through day ${last}`,
  noDoseDays: (first, last) => `No doses on days ${first}–${last}.`,
  noDoseWindow: (start, end) => `No doses from ${start} until ${end}.`,
  phaseCount: (count) => `Perform this phase ${count} ${count === 1 ? "time" : "times"}`,
  repeatCount: (count) => `for ${count} ${count === 1 ? "cycle" : "cycles"}`,
  repeatCycle: (interval, exact, count) => {
    if (count === 1) return exact ? "Perform this schedule for 1 cycle total."
      : `1 cycle total; repeat-cycle interval: ${interval}.`;
    const iterations = count === undefined ? "" : ` for ${count} cycles total, including the first cycle`;
    return exact
      ? `Repeat this schedule every ${interval}${iterations} (offsets are measured from each cycle start).`
      : `Repeat-cycle interval: ${interval}${iterations}.`;
  },
};

/** Native clause timing wording; shared formatting supplies resolved clock shifts. */
export const ENGLISH_CLAUSE_TIMING = {
  clockWindow: (start: string, end: string, inclusive: boolean) =>
    `only between ${start} and ${end} each day${inclusive ? "" : " (end excluded)"}`,
  offset: (minutes: number) => Math.abs(minutes) + (minutes < 0 ? " minutes earlier each time" : " minutes later each time"),
  dayShift: (days: number) => days === 1 ? "the following day" : days === -1 ? "the previous day"
    : Math.abs(days) + (days < 0 ? " days earlier" : " days later")
};
