/** English course wording. Clinical scope and date arithmetic are supplied
 * by the canonical formatter; this module owns words and English inflection. */
import type { CourseLanguage } from "./types";
import { DAY_NAMES, joinWithAnd } from "../../format";
const UNITS: Readonly<Record<string, readonly [string, string]>> = {
  s: ["second", "seconds"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
  wk: ["week", "weeks"],
  mo: ["month", "months"],
  a: ["year", "years"],
};
export const ENGLISH_COURSE: CourseLanguage = {
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
  rateLabel: "Rate: ",
  rateRangeLabel: "Rate range: ",
  unspecified: "unspecified",
  treatmentStart: "treatment start",
  incompleteInterpretation: "INCOMPLETE medication interpretation — safety restrictions require review",
  retainedStructure: "Structured FHIR data is retained",
  maxAdministrationLabel: "max per administration: ",
  maxLifetimeLabel: "max lifetime: ",
  maxPeriodLabel: "max per period: ",
  weekdayName: (day) => DAY_NAMES[day] ?? day,
  joinList: (items) => joinWithAnd(items as string[]),
  timeUnit: (unit, value) => UNITS[unit]?.[value === 1 ? 0 : 1],
  expression: (kind, detail) => `unevaluated ${kind} expression${detail ? ": " + detail : ""}`,
  upTo: (value) => "up to " + value,
  administrations: (frequency, period) => `${frequency} administrations${period ? " per " + period : ""}`,
  dosingPeriod: (period) => `Dosing period: ${period}`,
  periodContext: (period) => ` (each period lasts ${period})`,
  startsWithinPeriod: (offset, context) => `Dosing starts ${offset} after the period begins${context}`,
  endsWithinPeriod: (offset, context) => `No doses during the final ${offset} of each period${context}`,
  afterTreatmentStart: (offset) => `${offset} after treatment start`,
  calendarWindow: (start, end) =>
    start && end ? `From ${start} until ${end}` : start ? `From ${start} onward` : end ? `Until ${end}` : "",
  reviewTiming: (source) => (source ? `Timing requires review: ${source}` : "Stage timing requires review"),
  dayRange: (first, last) => `Days ${first}–${last}`,
  fromDay: (first) => `From day ${first} onward`,
  throughDay: (last) => `Through day ${last}`,
  noDoseDays: (first, last) => `No doses on days ${first}–${last}.`,
  repeatCount: (count) => `for ${count} ${count === 1 ? "cycle" : "cycles"}`,
  repeatCycle: (interval, exact, count) => {
    const iterations = count === undefined ? "" : ` for ${count} ${count === 1 ? "cycle" : "cycles"}`;
    return exact
      ? `Repeat this schedule every ${interval}${iterations} (days are numbered within each cycle).`
      : `Repeat-cycle interval: ${interval}${iterations}.`;
  },
};
