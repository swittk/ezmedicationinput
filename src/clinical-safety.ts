import {
  FhirDayOfWeek,
  FhirPeriodUnit,
  ParseResult,
  TextRange
} from "./types";
import { preserveSuggestionWarning } from "./regimen/admissibility";
import { removeInstructionArtifactsOwnedByTemporalRanges } from "./regimen/temporal-artifact-ownership";
import { findMedicationDateListSpans, parseMedicationDateListAt } from "./date-interpretation";
import { setDosageCondition, setDosageExcludedDates, setDosageExcludedWeekdays } from "./dosage-course";
import { parseMedicationGuard } from "./medication-condition";
import { ParseOptions } from "./types";
import type { HpsgClinicalQuantityFeature } from "./hpsg/signature";

const UCUM = "http://unitsofmeasure.org";
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

// ยกเว้นกรณี is a condition (unless), not a calendar exclusion.
const EXCLUSION_CUE = /\b(?:except|excluding)\b|ยกเว้น(?!\s*กรณี)|เว้น(?=วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์))/iu;
const CRITICAL_CUE = /\b(?:except|excluding|unless|otherwise|only\s+if|skip\s+\d+\s+days?|as\s+directed|no\s+more\s+than|do\s+not\s+exceed|max(?:imum)?)\b|ยกเว้น|ไม่เกิน|เว้น(?=วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์))/giu;
const MAXIMUM = /\b(?:max(?:imum)?\.?|do\s+not\s+exceed|no\s+more\s+than)\s*(\d+(?:\.\d+)?)\s*(tablets?|tabs?|capsules?|caps?|drops?|mL|mg|mcg|g|puffs?|sprays?)\s*(?:\/|per\s+|a\s+)(day|d|24\s*h(?:ou)?rs?|week|wk)\b/iu;
const THAI_MAXIMUM = /ไม่เกิน\s*วันละ\s*(\d+(?:\.\d+)?)\s*(เม็ด|หยด|มล\.?|มิลลิลิตร)/u;
/**
 * A cheap prerequisite for post-grammar handling that still owns calendar,
 * condition and maximum-dose constraints. Typed HPSG clinical quantities
 * bypass this source-text gate; unresolved weight/infusion text reaches it
 * so the suggestion can retain a warning.
 */
// If a parsed dose still contains an unconsumed cadence, surface the conflict
// for clinician review without discarding the cadence the grammar recognized.
// Only inspect this when leftovers already exist, keeping ordinary complete
// SIGs on the original fast path.
const UNRESOLVED_TIMING_SIGNAL =
  /\b(?:QD|QOD|BID|TID|QID|Q\s*\d+(?:\.\d+)?\s*(?:H|HR|HRS?|MIN(?:UTE)?S?|D(?:AYS?)?|WK|WEEKS?|MO|MONTHS?)|(?:once|twice|three|four)\s+(?:times?\s+)?daily|every\s+\d+(?:\.\d+)?\s*(?:h|hr|hours?|minutes?|days?|weeks?)|\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|hrs?|hr))\b/iu;

const CLINICAL_CONSTRAINT_SIGNAL =
  /\b(?:except|excluding|unless|otherwise|only\s+if|if|up\s+to|starting|beginning|first|second|third|fourth|last|stop\s+for|skip\s+\d+\s+days?|as\s+directed|no\s+more\s+than|do\s+not\s+exceed|max(?:imum)?|infus(?:e|ion)|drip)\b|\b(?:mL|L)\s+over\s+\d|\/(?:\s*kg|\s*(?:h|hr|min|hour|minute)s?\b)|ยกเว้น|เว้นวัน|เว้นแต่|เฉพาะ(?:เมื่อ|หาก)|ไม่เกิน|มิฉะนั้น|ไม่เช่นนั้น/iu;

const unitMap: Record<string, string> = {
  tab: "tab", tabs: "tab", tablet: "tab", tablets: "tab", เม็ด: "tab",
  cap: "cap", caps: "cap", capsule: "cap", capsules: "cap",
  drop: "drop", drops: "drop", หยด: "drop",
  ml: "mL", "มล": "mL", "มล.": "mL", มิลลิลิตร: "mL",
  mg: "mg", mcg: "mcg", g: "g",
  puff: "puff", puffs: "puff", spray: "spray", sprays: "spray"
};

export interface ConstraintApplication {
  /** Absolute source spans confidently understood by the post-grammar resolver. */
  ownedRanges: TextRange[];
}

function span(source: string, offset: number, start: number, end: number): TextRange {
  return { start: start + offset, end: end + offset };
}

function uniqueDays(source: string): FhirDayOfWeek[] {
  const values = new Set<FhirDayOfWeek>();
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
  return DAYS.filter(day => values.has(day));
}

function isOnlyWeekdays(source: string): boolean {
  let remainder = source;
  for (const definition of WEEKDAYS) {
    definition.en.lastIndex = 0;
    definition.th.lastIndex = 0;
    remainder = remainder.replace(definition.en, " ").replace(definition.th, " ");
  }
  remainder = remainder.replace(/\b(?:weekends?|weekdays?|and|or|on|the|every|each)\b|(?:และ|หรือ|วัน|ทุก)|[\s,\/&+]+/giu, "");
  return remainder.length === 0;
}

export interface CalendarExclusion {
  start: number;
  end: number;
  excluded: FhirDayOfWeek[];
  included: FhirDayOfWeek[];
  dates: string[];
}

/** Multi-weekday and independently dated omissions can coexist. */
export function matchCalendarExclusion(source: string, options?: ParseOptions): CalendarExclusion | undefined {
  const cue = EXCLUSION_CUE.exec(source);
  if (!cue) return undefined;
  const end = source.indexOf(";", cue.index) >= 0 ? source.indexOf(";", cue.index) : source.length;
  const suffix = source.slice(cue.index + cue[0].length, end).trim();
  if (!suffix) return undefined;
  const excluded: FhirDayOfWeek[] = [];
  const included = uniqueDays(source.slice(0, cue.index));
  let residual = suffix;
  const dates: string[] = [];
  // A full coordinated date list (English/Thai, DMY/MDY via datePolicy,
  // Gregorian/Buddhist) is resolved with the existing shared date parser.
  const prefixed = "on " + suffix.replace(/^on\s+/iu, "");
  const whole = parseMedicationDateListAt(prefixed, 0, options);
  if (whole && !whole.unresolved && whole.end === prefixed.length && whole.events.length) {
    for (const event of whole.events) dates.push(event.isoDate);
    residual = "";
  } else {
    const found = findMedicationDateListSpans(suffix, options);
    // The date parser may find isolated date clauses in mixed weekday/date
    // exclusions; no overlapping or unresolved list is accepted.
    for (const match of [...found].sort((a, b) => b.start - a.start)) {
      if (match.unresolved || !match.events.length) return undefined;
      for (const event of match.events) dates.push(event.isoDate);
      residual = residual.slice(0, match.start) + " ".repeat(match.end - match.start) + residual.slice(match.end);
    }
  }
  // Explicit ISO dates are already normalized FHIR dates.
  residual = residual.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (value) => {
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

function mergeOwnedRanges(ranges: TextRange[], source: string, offset: number): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && source.slice(previous.end - offset, range.start - offset).trim() === "") {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function markOwned(result: ParseResult, ranges: TextRange[]): void {
  for (const clause of result.meta.canonical.clauses) {
    clause.leftovers = (clause.leftovers ?? []).filter(leftover =>
      !ranges.some(range => range.start <= leftover.start && range.end >= leftover.end)
    );
  }
  const rest = result.meta.canonical.clauses.reduce<string[]>((all, clause) => {
    for (const part of clause.leftovers ?? []) all.push(part.text);
    return all;
  }, []);
  result.meta.leftoverText = rest.length ? rest.join(" ") : undefined;
}

function keepOriginalText(item: ParseResult, source: string): void {
  item.longText = source;
  item.shortText = source;
  item.fhir.text = source;
}

function matchedRange(source: string, match: RegExpExecArray, offset: number): TextRange {
  return span(source, offset, match.index, match.index + match[0].length);
}

/**
 * Best-effort post-grammar handling of clinical medication constraints.
 * Incomplete fragments retain the grammar's editable suggestion and raw source,
 * with warnings for clinician review.
 * All transformations are independent of drug names and clinical specialties.
 */
export function applyClinicalConstraints(item: ParseResult, source: string, options?: ParseOptions): ConstraintApplication {
  const unresolvedText = item.meta.leftoverText;
  if (item.fhir.timing && unresolvedText &&
      UNRESOLVED_TIMING_SIGNAL.test(unresolvedText)) {
    preserveSuggestionWarning(item, source, "unresolved-timing-conflict");
  }
  let clinicalQuantity: HpsgClinicalQuantityFeature | undefined;
  for (const clause of item.meta.canonical.clauses) {
    if (clause.clinicalQuantity === undefined) continue;
    clinicalQuantity = clause.clinicalQuantity;
    break;
  }
  if (!clinicalQuantity && !CLINICAL_CONSTRAINT_SIGNAL.test(source)) return { ownedRanges: [] };
  // Keep explicit but unresolved temporal dependencies visible alongside the
  // best supported schedule instead of turning them into parser-level vetoes.
  if (/\b(?:starting|beginning)(?:\s+on)?\s+(?:tomorrow|(?:the\s+)?date\s+of\s+discharge)\b/iu.test(source)) {
    preserveSuggestionWarning(item, source, "unresolved-relative-course-start");
  }
  // A second unconditional stop duration remains visible as a warning without
  // overriding or deleting the infusion quantity recognized by HPSG.
  if (clinicalQuantity?.administrationDuration) {
    const stop = /\band\s+stop\s+after\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/iu.exec(source);
    if (stop) {
      const stopMinutes = Number(stop[1]) *
        (/^h/iu.test(stop[2]) ? 60 : 1);
      const durationMinutes = clinicalQuantity.administrationDuration.value *
        (clinicalQuantity.administrationDuration.unit === FhirPeriodUnit.Hour ? 60 : 1);
      if (Number.isFinite(stopMinutes) && stopMinutes > 0 &&
          Math.abs(stopMinutes - durationMinutes) > 1e-9) {
        preserveSuggestionWarning(item, source, "conflicting-infusion-stop-duration");
      }
    }
  }
  // A recognized carrier-volume rate must not silently discard a separate
  // active-drug amount. For instance "1 g in 100 mL IV over 30 minutes" is
  // clinically different from 100 mL of an unspecified infusion. Keep both
  // the structured interpretation and a warning about the unresolved amount.
  if (clinicalQuantity?.representation === "dose-with-rate-ratio" &&
      unresolvedText &&
      /(?:^|\s)\d+(?:\.\d+)?\s*(?:mcg|ug|µg|μg|mg|g|iu|units?)\b/iu.test(unresolvedText)) {
    preserveSuggestionWarning(item, source, "unresolved-infusion-instructions");
  }

  if (clinicalQuantity) {
    // HPSG quantity meaning is already lowered by canonicalToFhir. This
    // layer preserves it and adds a warning when part of it is unresolved.
    if (clinicalQuantity.status !== "resolved")
      preserveSuggestionWarning(item, source,
        clinicalQuantity.quarantineReason ?? "unsupported-weight-based-dose");
    else
      keepOriginalText(item, source);
  }
  const offset = item.meta.canonical.clauses[0]?.raw.start ?? 0;
  const ownedRanges: TextRange[] = [];
  const own = (range: TextRange) => { ownedRanges.push(range); };
  const exclusionCue = EXCLUSION_CUE.exec(source);
  if (exclusionCue) {
    const exclusion = matchCalendarExclusion(source, options);
    const repeat = item.fhir.timing?.repeat;
    if (exclusion && repeat &&
      (repeat.frequency !== undefined || repeat.period !== undefined || repeat.when?.length || repeat.timeOfDay?.length)) {
      if (exclusion.excluded.length) {
        const excluded = new Set(exclusion.excluded);
        const allowed = (exclusion.included.length ? exclusion.included : [...DAYS]).filter(day => !excluded.has(day));
        if (!allowed.length) {
          preserveSuggestionWarning(item, source, "weekdays-all-excluded");
        } else {
          repeat.dayOfWeek = allowed;
          setDosageExcludedWeekdays(item.fhir, exclusion.excluded);
          for (const clause of item.meta.canonical.clauses) {
            if (clause.schedule) clause.schedule.dayOfWeek = [...allowed];
          }
        }
      }
      if (exclusion.dates.length) {
        setDosageExcludedDates(item.fhir, exclusion.dates);
        // A bare date inside an exclusion is NOT a positive FHIR Timing.event.
        // The generic date parser can independently recognize it as one, so
        // remove only the negative dates from the positive event list.
        const events = item.fhir.timing?.event;
        if (events?.length) {
          const keep = events.map((value, index) => ({ value, index }))
            .filter(entry => exclusion.dates.indexOf(entry.value.slice(0, 10)) < 0);
          item.fhir.timing!.event = keep.length ? keep.map(entry => entry.value) : undefined;
          item.fhir.timing!._event = keep.length
            ? keep.map(entry => item.fhir.timing!._event?.[entry.index] ?? {})
            : undefined;
        }
        for (const clause of item.meta.canonical.clauses) {
          if (clause.schedule?.calendarEvents?.length) {
            const positive = clause.schedule.calendarEvents.filter(event =>
              exclusion.dates.indexOf(event.isoDate) < 0
            );
            clause.schedule.calendarEvents = positive.length ? positive : undefined;
          }
        }
      }
      own(span(source, offset, exclusion.start, exclusion.end));
      keepOriginalText(item, source);
    } else {
      preserveSuggestionWarning(item, source, "unresolved-calendar-exclusion");
    }
  }

  // Conditions are real predicates on the administration, not an ad-hoc PRN
  // reason and not an unconditional schedule. The predicate remains available
  // for evaluation at each candidate administration time.
  // A procedural workflow (for example inhaler priming if unused for
  // seven days) is not an executable medication administration. Do not
  // attach its condition to a dosage or remove its instruction-graph action.
  const hasAdministration = Boolean(item.fhir.doseAndRate?.length ||
    item.fhir.timing || item.fhir.asNeeded);
  const guard = hasAdministration ? parseMedicationGuard(source) : undefined;
  if (guard) {
    setDosageCondition(item.fhir, guard.condition);
    own(span(source, offset, guard.start, guard.end));
    if (guard.otherwise) own(span(source, offset, guard.otherwise.start, guard.otherwise.end));
    const originalReason = item.fhir.asNeededFor?.map(reason => reason.text ?? "").join(" ").toLowerCase();
    const explicitPrn = /\b(?:prn|as\s+needed)\b|เมื่อมีอาการ/iu.test(source);
    // A recognized measurement/state guard is not itself an as-needed order.
    // PRN requires an independently explicit PRN/as-needed cue; multiple
    // measurements joined by "and" must not remain a pseudo-PRN reason.
    if (!explicitPrn && item.fhir.asNeeded &&
        (!originalReason || source.toLowerCase().indexOf(originalReason) >= 0 ||
          guard.condition.kind === "all" || guard.condition.kind === "any")) {
      delete item.fhir.asNeeded;
      delete item.fhir.asNeededFor;
      for (const clause of item.meta.canonical.clauses) delete clause.prn;
    }
    keepOriginalText(item, source);
  }

  // Retain a scalar suggestion when HPSG has no typed weight evidence, but make
  // the unresolved weight expression explicit for clinician review.
  if (!clinicalQuantity && /\b(?:mg|mcg|ug|g|iu|units?)\s*\/\s*kg\b/iu.test(source)) {
    preserveSuggestionWarning(item, source, "unsupported-weight-based-dose");
  }

  if (!clinicalQuantity &&
    /\b(?:infus(?:e|ion)|drip)\b/iu.test(source) &&
    /\b(?:\w+\s*\/\s*(?:h|hr|min)|over\s+\d)/iu.test(source) &&
    (unresolvedText?.trim() ?? "").length > 0) {
    preserveSuggestionWarning(item, source, "unresolved-infusion-instructions");
  }

  const maximum = MAXIMUM.exec(source);
  const thaiMaximum = maximum ? undefined : THAI_MAXIMUM.exec(source);
  const max = maximum ?? thaiMaximum;
  if (max) {
    const amount = Number(max[1]), unit = unitMap[max[2].toLowerCase()];
    const period = maximum ? (/^(?:week|wk)$/iu.test(max[3]) ? "wk" : "d") : "d";
    if (Number.isFinite(amount) && amount > 0 && unit) {
      item.fhir.maxDosePerPeriod = [{
        numerator: { value: amount, unit },
        denominator: { value: 1, unit: period, system: UCUM, code: period }
      }];
      own(matchedRange(source, max, offset));
      keepOriginalText(item, source);
      const freq = item.fhir.timing?.repeat?.frequency;
      const prescribedDose = item.fhir.doseAndRate?.[0]?.doseQuantity;
      if (period === "d" && typeof freq === "number" && prescribedDose?.value !== undefined &&
        prescribedDose.unit === unit && (item.fhir.timing?.repeat?.period ?? 1) === 1 &&
        (item.fhir.timing?.repeat?.periodUnit ?? "d") === "d" && prescribedDose.value * freq > amount &&
        !item.fhir.asNeeded) {
        preserveSuggestionWarning(item, source, "daily-dose-exceeds-explicit-maximum");
      }
    } else {
      preserveSuggestionWarning(item, source, "unsupported-dose-maximum");
    }
  }

  const ownedText = (index: number, length: number) => ownedRanges.some(range => range.start <= offset + index && range.end >= offset + index + length);
  CRITICAL_CUE.lastIndex = 0;
  let cue: RegExpExecArray | null;
  while ((cue = CRITICAL_CUE.exec(source)) !== null) {
    if (item.warnings.some(warning =>
      warning.startsWith("Unresolved interpretation (") ||
      warning.startsWith("Unresolved schedule (")
    )) break;
    if (ownedText(cue.index, cue[0].length)) continue;
    const knownSafetyAdvice = /^(?:do\s+not\s+exceed|max(?:imum)?|no\s+more\s+than|ไม่เกิน)$/iu.test(cue[0]) && Boolean(max);
    if (knownSafetyAdvice) continue;
    if (/^(?:unless|only\s+if)$/iu.test(cue[0]) && guard &&
      guard.start <= cue.index && guard.end >= cue.index + cue[0].length) continue;
    // A maximum-dose occurrence phrase is already safe to retain when the
    // HPSG grammar explicitly consumed THIS cue into a countMax or periodic
    // occurrenceCap. Use the evidence span rather than English-only words:
    // the same safety rule applies to Thai and other parsed languages.
    const absoluteCueStart = offset + cue.index;
    const absoluteCueEnd = absoluteCueStart + cue[0].length;
    const recognizedCountCap = item.meta.canonical.clauses.some(clause =>
      (clause.schedule?.countMax !== undefined ||
       clause.schedule?.occurrenceCap !== undefined) &&
      (clause.evidence ?? []).some(evidence =>
        (evidence.rule === "hpsg.lex.schedule.occurrenceCap.maximum" ||
         evidence.rule === "hpsg.lex.schedule.count.maximum") &&
        evidence.spans.some(range =>
          range.start <= absoluteCueStart && range.end >= absoluteCueEnd)
      )
    );
    if (recognizedCountCap) continue;
    preserveSuggestionWarning(item, source, "unresolved-critical-constraint");
    break;
  }
  const mergedRanges = mergeOwnedRanges(ownedRanges, source, offset);
  if (mergedRanges.length) {
    markOwned(item, mergedRanges);
    // The HPSG graph must no longer claim recognized safety/quantity terms are opaque.
    removeInstructionArtifactsOwnedByTemporalRanges(item, mergedRanges.map(range => ({
      start: range.start - offset,
      end: range.end - offset
    })));
  }
  return { ownedRanges: mergedRanges };
}
