import {
  FhirPeriodUnit,
  ParseOptions,
  ParseResult,
  TextRange
} from "./types";
import { preserveSuggestionWarning } from "./regimen/admissibility";
import { removeInstructionArtifactsOwnedByTemporalRanges } from "./regimen/temporal-artifact-ownership";
import type { HpsgClinicalQuantityFeature } from "./hpsg/signature";
import { containsCalendarExclusionCue } from "./hpsg/rules/condition-rules";

const UCUM = "http://unitsofmeasure.org";
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
    preserveSuggestionWarning(item, source, "timing-text-needs-review");
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
        clinicalQuantity.reviewReason ?? "unsupported-weight-based-dose");
    else
      keepOriginalText(item, source);
  }
  const offset = item.meta.canonical.clauses[0]?.raw.start ?? 0;
  const ownedRanges: TextRange[] = [];
  const own = (range: TextRange) => { ownedRanges.push(range); };
  // All recognized conditions and exclusions are typed on the canonical
  // clause before HPSG scope selection and FHIR lowering. This late pass only
  // accounts for their local source spans in lint and preserves the author's
  // wording; it does not reinterpret or modify FHIR semantics.
  const localAdjunct = item.meta.canonical.clauses[0]?.clinicalAdjuncts;
  if (containsCalendarExclusionCue(source) &&
      !localAdjunct?.excludedDates?.length &&
      !localAdjunct?.excludedWeekdays?.length) {
    preserveSuggestionWarning(item, source, "unresolved-calendar-exclusion");
  }
  if (localAdjunct?.localRanges?.length) {
    for (const range of localAdjunct.localRanges) {
      own(span(source, offset, range.start, range.end));
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
