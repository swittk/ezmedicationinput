import { LexKind } from "../../lexer/token-types";
import { FhirPeriodUnit } from "../../types";
import { HpsgClauseContext, lexicalRule, normalizeTokenLower } from "../rule-context";
import {
  HpsgClinicalQuantityFeature,
  HpsgDimensionalQuantityTerm,
  HpsgLexicalRule,
  lexicalSign
} from "../signature";

const WEIGHT_WARNING =
  "Weight-based dose: patient weight is required to calculate the actual administered amount.";
const WEIGHT_RATE_WARNING =
  "Weight-based infusion rate: patientWeightKg is required to calculate an absolute administration rate.";

interface UnitExpression {
  compact: string;
  end: number;
}

function available(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens[index];
  return Boolean(token && index < context.limit && !context.state.consumed.has(token.index));
}

function compactUnitExpression(
  context: HpsgClauseContext,
  start: number,
  accepts: (value: string) => boolean
): UnitExpression | undefined {
  let result: UnitExpression | undefined;
  let compact = "";
  const first = context.tokens[start];
  const maxLength = first?.original.includes("/") ? 1 : 5;
  // One compact token is normal; five covers "mg / kg / min" without a
  // clause-wide scan.  Longest-match prevents /kg from hiding a suffix.
  for (let length = 1; length <= maxLength && available(context, start + length - 1); length += 1) {
    const token = context.tokens[start + length - 1];
    // Spaced expressions have a strict UNIT / UNIT (/ UNIT) shape. Do not
    // absorb a following route or cadence into an "unknown suffix".
    if (length > 1 && length % 2 === 0 && token.original !== "/") break;
    if (length > 1 && length % 2 === 1 && token.original === "/") break;
    compact += token.original.replace(/\s+/gu, "");
    const normalized = compact.toLowerCase().replace(/[μµ]/gu, "u");
    if (accepts(normalized)) result = { compact: normalized, end: start + length };
  }
  return result;
}

function massTerm(value: number, raw: string): HpsgDimensionalQuantityTerm | undefined {
  const normalized = raw.toLowerCase().replace(/[μµ]/gu, "u");
  if (normalized === "mcg" || normalized === "ug") {
    return { value, unit: "ug", dimension: "mass" };
  }
  if (normalized === "mg" || normalized === "g") {
    return { value, unit: normalized, dimension: "mass" };
  }
  if (/^(?:iu|unit|units)$/u.test(normalized)) {
    return { value, unit: "[iU]", dimension: "biologic-activity" };
  }
  return undefined;
}

function volumeOrMassTerm(value: number, raw: string): HpsgDimensionalQuantityTerm | undefined {
  const mass = massTerm(value, raw);
  if (mass) return mass;
  const normalized = raw.toLowerCase();
  if (normalized === "ml") return { value, unit: "mL", dimension: "volume" };
  if (normalized === "l") return { value, unit: "L", dimension: "volume" };
  return undefined;
}

function timeUnit(raw: string): FhirPeriodUnit.Hour | FhirPeriodUnit.Minute | undefined {
  if (/^(?:h|hr|hrs|hour|hours)$/u.test(raw)) return FhirPeriodUnit.Hour;
  if (/^(?:min|mins|minute|minutes)$/u.test(raw)) return FhirPeriodUnit.Minute;
  return undefined;
}

function hasAdministrationCue(context: HpsgClauseContext, before: number): boolean {
  const first = Math.max(0, before - 8);
  for (let index = before - 1; index >= first; index -= 1) {
    const lower = normalizeTokenLower(context.tokens[index]);
    if (/^(?:infuse|infusion|administer|give)$/u.test(lower)) return true;
  }
  return false;
}

function durationAfter(
  context: HpsgClauseContext,
  start: number
): { value: number; unit: FhirPeriodUnit.Hour | FhirPeriodUnit.Minute; indices: number[] } | undefined {
  const limit = Math.min(context.limit, start + 8);
  for (let index = start; index + 2 < limit; index += 1) {
    if (!available(context, index) || normalizeTokenLower(context.tokens[index]) !== "for") continue;
    const valueToken = context.tokens[index + 1];
    const unitToken = context.tokens[index + 2];
    const unit = unitToken ? timeUnit(normalizeTokenLower(unitToken)) : undefined;
    if (!valueToken || valueToken.kind !== LexKind.Number || !unit ||
        valueToken.value === undefined || valueToken.value <= 0) continue;
    return { value: valueToken.value, unit, indices: [index, index + 1, index + 2] };
  }
  return undefined;
}

function tokensAt(context: HpsgClauseContext, indices: number[]) {
  return Array.from(new Set(indices)).sort((a, b) => a - b).map((index) => context.tokens[index]);
}

function clinicalSign(
  context: HpsgClauseContext,
  rule: string,
  indices: number[],
  clinicalQuantity: HpsgClinicalQuantityFeature,
  dose?: { value: number; unit: string },
  schedule?: { frequency: number; period: number; periodUnit: FhirPeriodUnit },
  warning?: string
) {
  const tokens = tokensAt(context, indices);
  return lexicalSign({
    type: "dose-sign",
    rule,
    tokens,
    consumedTokenIndices: tokens.map((token) => token.index),
    synsem: {
      head: {
        dose: { ...dose, clinicalQuantity },
        schedule
      },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    warnings: warning ? [warning] : undefined,
    score: 60
  });
}

function fixedVolumeOverTime(
  context: HpsgClauseContext,
  start: number,
  value: number
) {
  const unitToken = context.tokens[start + 1];
  const overToken = context.tokens[start + 2];
  const durationToken = context.tokens[start + 3];
  const durationUnitToken = context.tokens[start + 4];
  if (!unitToken || !overToken || !durationToken || !durationUnitToken ||
      !available(context, start + 4) || normalizeTokenLower(overToken) !== "over" ||
      durationToken.kind !== LexKind.Number || durationToken.value === undefined ||
      durationToken.value <= 0) return undefined;
  const numerator = volumeOrMassTerm(value, normalizeTokenLower(unitToken));
  const durationUnit = timeUnit(normalizeTokenLower(durationUnitToken));
  if (!numerator || numerator.dimension !== "volume" || !durationUnit ||
      !hasAdministrationCue(context, start)) return undefined;
  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator,
    denominators: [{ value: durationToken.value, unit: durationUnit, dimension: "time" }],
    projectedDose: { value, unit: numerator.unit },
    administrationDuration: { value: durationToken.value, unit: durationUnit }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.fixedVolumeOverTime",
    [start, start + 1, start + 2, start + 3, start + 4],
    clinicalQuantity,
    clinicalQuantity.projectedDose
  );
}

function weightQuantity(
  context: HpsgClauseContext,
  start: number,
  value: number,
  expression: UnitExpression
) {
  const parts = expression.compact.split("/");
  if (parts.length < 2 || parts[1] !== "kg") return undefined;
  const numerator = massTerm(value, parts[0]);
  if (!numerator) return undefined;
  const indices = Array.from({ length: expression.end - start }, (_, offset) => start + offset);
  const bodyMass: HpsgDimensionalQuantityTerm = {
    value: 1,
    unit: "kg",
    dimension: "patient-mass"
  };
  const suffix = parts[2];
  if (parts.length > 3 || (suffix && suffix !== "day" && suffix !== "daily" && suffix !== "d" && !timeUnit(suffix))) {
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weight.unsupported", indices, {
      representation: "rate-quantity",
      status: "unsupported",
      numerator,
      denominators: [bodyMass],
      requiresPatientWeight: true,
      quarantineReason: "unsupported-weight-based-rate"
    });
  }

  const rateTime = suffix ? timeUnit(suffix) : undefined;
  if (rateTime) {
    const duration = durationAfter(context, expression.end);
    if (duration) indices.push(...duration.indices);
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightRate", indices, {
      representation: "rate-quantity",
      status: "resolved",
      numerator,
      denominators: [
        bodyMass,
        { value: 1, unit: rateTime, dimension: "time" }
      ],
      administrationDuration: duration ? { value: duration.value, unit: duration.unit } : undefined,
      requiresPatientWeight: true
    }, undefined, undefined, WEIGHT_RATE_WARNING);
  }

  const doseUnit = `${numerator.unit}/kg`;
  const daily = Boolean(suffix);
  if (!daily) {
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightDose", indices, {
      representation: "dose",
      status: "resolved",
      numerator,
      denominators: [bodyMass],
      projectedDose: { value, unit: doseUnit },
      requiresPatientWeight: true
    }, { value, unit: doseUnit }, undefined, WEIGHT_WARNING);
  }

  const divided = context.tokens[expression.end];
  const into = context.tokens[expression.end + 1];
  const count = context.tokens[expression.end + 2];
  const doses = context.tokens[expression.end + 3];
  if (divided && into && count && doses && available(context, expression.end + 3) &&
      /^(?:divided|divide)$/u.test(normalizeTokenLower(divided)) &&
      /^(?:into|in)$/u.test(normalizeTokenLower(into)) &&
      count.kind === LexKind.Number && count.value !== undefined && Number.isInteger(count.value) && count.value > 0 &&
      /^(?:dose|doses)$/u.test(normalizeTokenLower(doses))) {
    indices.push(expression.end, expression.end + 1, expression.end + 2, expression.end + 3);
    const projectedDose = { value: value / count.value, unit: doseUnit };
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightDailyDivided", indices, {
      representation: "dose",
      status: "resolved",
      numerator,
      denominators: [bodyMass, { value: 1, unit: FhirPeriodUnit.Day, dimension: "time" }],
      projectedDose,
      dailyTotal: true,
      dividedDoseCount: count.value,
      requiresPatientWeight: true
    }, projectedDose, {
      frequency: count.value,
      period: 1,
      periodUnit: FhirPeriodUnit.Day
    }, WEIGHT_WARNING);
  }

  return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightDailyIncomplete", indices, {
    representation: "dose",
    status: "incomplete",
    numerator,
    denominators: [bodyMass, { value: 1, unit: FhirPeriodUnit.Day, dimension: "time" }],
    dailyTotal: true,
    requiresPatientWeight: true,
    quarantineReason: "incomplete-weight-based-dose"
  });
}

function fixedRate(
  context: HpsgClauseContext,
  start: number,
  value: number,
  expression: UnitExpression
) {
  const parts = expression.compact.split("/");
  if (parts.length !== 2) return undefined;
  const numerator = volumeOrMassTerm(value, parts[0]);
  const denominatorUnit = timeUnit(parts[1]);
  const cue = context.tokens[start - 1];
  if (!numerator || !denominatorUnit || !cue || !available(context, start - 1) ||
      !/^(?:at|@)$/u.test(normalizeTokenLower(cue))) return undefined;
  const duration = durationAfter(context, expression.end);
  const indices = [start - 1, ...Array.from(
    { length: expression.end - start }, (_, offset) => start + offset
  )];
  if (duration) indices.push(...duration.indices);
  return clinicalSign(context, "hpsg.lex.clinicalQuantity.fixedRate", indices, {
    representation: "rate-quantity",
    status: "resolved",
    numerator,
    denominators: [{ value: 1, unit: denominatorUnit, dimension: "time" }],
    administrationDuration: duration ? { value: duration.value, unit: duration.unit } : undefined
  });
}

/**
 * Bounded lexical/construction contribution for safety-critical medication
 * quantities. It never searches the full clause and only accepts explicit
 * dimensional forms; unsupported weight suffixes become typed quarantine
 * evidence instead of an ordinary dose.
 */
export function clinicalQuantityLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinicalQuantity", (context, start) => {
    const valueToken = context.tokens[start];
    if (!valueToken || valueToken.kind !== LexKind.Number || valueToken.value === undefined ||
        valueToken.value <= 0 || !available(context, start + 1)) return [];

    const over = fixedVolumeOverTime(context, start, valueToken.value);
    if (over) return [over];

    const expression = compactUnitExpression(context, start + 1, (candidate) =>
      /^(?:mcg|ug|mg|g|unit|units|iu)\/kg(?:\/[^/]+)?$/u.test(candidate) ||
      /^(?:ml|l|mcg|ug|mg|g)\/(?:h|hr|hrs|hour|hours|min|mins|minute|minutes)$/u.test(candidate)
    );
    if (!expression) return [];
    const weight = weightQuantity(context, start, valueToken.value, expression);
    if (weight) return [weight];
    const rate = fixedRate(context, start, valueToken.value, expression);
    return rate ? [rate] : [];
  });
}
