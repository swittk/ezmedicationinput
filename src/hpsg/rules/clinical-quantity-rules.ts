import { LexKind, type LexToken } from "../../lexer/token-types";
import { FhirPeriodUnit, RouteCode } from "../../types";
import { HpsgClauseContext, lexicalRule, normalizeTokenLower } from "../rule-context";
import { FREQUENCY_NUMBER_WORDS } from "../timing-lexicon";
import {
  HpsgClinicalQuantityFeature,
  HpsgDimensionalQuantityTerm,
  HpsgLexicalRule,
  lexicalSign
} from "../signature";

const WEIGHT_WARNING =
  "Weight-based dose: patient weight is required to calculate the actual administered amount.";
const WEIGHT_RATE_WARNING =
  "Weight-based rate: patientWeightKg is required to calculate the absolute medication amount.";

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
  const maxLength = 5;
  // Five tokens cover compact/spaced mixtures such as `mcg/kg per min` and
  // `mg / kg / day` without a clause-wide scan. Longest match prevents /kg
  // from hiding a real time suffix.
  for (let length = 1; length <= maxLength && available(context, start + length - 1); length += 1) {
    const token = context.tokens[start + length - 1];
    const separator = token.original === "/" || normalizeTokenLower(token) === "per";
    // Spaced expressions have a strict UNIT separator UNIT shape. Do not
    // absorb a following route or cadence into an unknown suffix.
    if (length > 1 && length % 2 === 0 && !separator) break;
    if (length > 1 && length % 2 === 1 && separator) break;
    compact += separator ? "/" : token.original.replace(/\s+/gu, "");
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

function weightRatePeriodUnit(
  raw: string
): FhirPeriodUnit.Hour | FhirPeriodUnit.Minute | FhirPeriodUnit.Week | undefined {
  return timeUnit(raw) ??
    (/^(?:wk|wks|week|weeks)$/u.test(raw) ? FhirPeriodUnit.Week : undefined);
}

function hasAdministrationCue(context: HpsgClauseContext, before: number): boolean {
  const first = Math.max(0, before - 8);
  for (let index = before - 1; index >= first; index -= 1) {
    const lower = normalizeTokenLower(context.tokens[index]);
    if (/^(?:infuse|infusion|administer|give|run)$/u.test(lower)) return true;
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
  warning?: string,
  explicitRoute?: RouteCode
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
        schedule,
        ...(explicitRoute !== undefined ? { route: { code: explicitRoute, text: "intravenous" } } : {})
      },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    warnings: warning ? [warning] : undefined,
    score: 60
  });
}

function activeDoseInCarrierOverTime(
  context: HpsgClauseContext,
  start: number,
  value: number
) {
  const activeUnitToken = context.tokens[start + 1];
  const inToken = context.tokens[start + 2];
  const carrierValueToken = context.tokens[start + 3];
  const carrierUnitToken = context.tokens[start + 4];
  if (!activeUnitToken || !inToken || !carrierValueToken || !carrierUnitToken ||
      !available(context, start + 4) ||
      normalizeTokenLower(inToken) !== "in" ||
      carrierValueToken.kind !== LexKind.Number ||
      carrierValueToken.value === undefined || carrierValueToken.value <= 0) return undefined;
  const activeDose = massTerm(value, normalizeTokenLower(activeUnitToken));
  const carrier = volumeOrMassTerm(carrierValueToken.value, normalizeTokenLower(carrierUnitToken));
  if (!activeDose || !carrier || carrier.dimension !== "volume" ||
      !hasAdministrationCue(context, start)) return undefined;

  const routeToken = context.tokens[start + 5];
  const markedIV = Boolean(routeToken && available(context, start + 5) &&
    /^(?:iv|intravenously)$/u.test(normalizeTokenLower(routeToken)));
  const shift = markedIV ? 1 : 0;
  const overToken = context.tokens[start + 5 + shift];
  const durationToken = context.tokens[start + 6 + shift];
  const durationUnitToken = context.tokens[start + 7 + shift];
  if (!overToken || !durationToken || !durationUnitToken ||
      !available(context, start + 7 + shift) ||
      normalizeTokenLower(overToken) !== "over" ||
      durationToken.kind !== LexKind.Number || durationToken.value === undefined ||
      durationToken.value <= 0) return undefined;
  const durationUnit = timeUnit(normalizeTokenLower(durationUnitToken));
  if (!durationUnit) return undefined;

  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator: carrier,
    denominators: [{ value: durationToken.value, unit: durationUnit, dimension: "time" }],
    projectedDose: { value, unit: activeDose.unit },
    rateNumerator: { value: carrier.value, unit: carrier.unit },
    administrationDuration: { value: durationToken.value, unit: durationUnit }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.activeDoseInCarrierOverTime",
    Array.from({ length: 8 + shift }, (_, offset) => start + offset),
    clinicalQuantity,
    clinicalQuantity.projectedDose,
    undefined,
    undefined,
    markedIV ? RouteCode["Intravenous route"] : undefined
  );
}

function fixedVolumeOverTime(
  context: HpsgClauseContext,
  start: number,
  value: number
) {
  const unitToken = context.tokens[start + 1];
  // IV may be written between a volume and its administration duration:
  // "Infuse 500 mL IV over 2 hours". License that exact route phrase as a
  // typed lexical contribution; don't reinterpret arbitrary intervening text.
  const possibleRouteToken = context.tokens[start + 2];
  const markedIV = Boolean(possibleRouteToken && available(context, start + 2) &&
    /^(?:iv|intravenously)$/u.test(normalizeTokenLower(possibleRouteToken)));
  const shift = markedIV ? 1 : 0;
  const overToken = context.tokens[start + 2 + shift];
  const durationToken = context.tokens[start + 3 + shift];
  const durationUnitToken = context.tokens[start + 4 + shift];
  if (!unitToken || !overToken || !durationToken || !durationUnitToken ||
      !available(context, start + 4 + shift) || normalizeTokenLower(overToken) !== "over" ||
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
    Array.from({ length: 5 + shift }, (_, offset) => start + offset),
    clinicalQuantity,
    clinicalQuantity.projectedDose,
    undefined,
    undefined,
    markedIV ? RouteCode["Intravenous route"] : undefined
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
  const perDose = suffix === "dose";
  if (parts.length > 3 || (suffix && !perDose && suffix !== "day" && suffix !== "daily" && suffix !== "d" && !weightRatePeriodUnit(suffix))) {
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weight.unsupported", indices, {
      representation: "rate-quantity",
      status: "unsupported",
      numerator,
      denominators: [bodyMass],
      requiresPatientWeight: true,
      quarantineReason: "unsupported-weight-based-rate"
    });
  }

  const rateTime = suffix ? weightRatePeriodUnit(suffix) : undefined;
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
  if (!daily || perDose) {
    return clinicalSign(context,
      perDose ? "hpsg.lex.clinicalQuantity.weightPerDose" : "hpsg.lex.clinicalQuantity.weightDose",
      indices, {
      representation: "dose",
      status: "resolved",
      numerator,
      denominators: [bodyMass],
      projectedDose: { value, unit: doseUnit },
      requiresPatientWeight: true
    }, { value, unit: doseUnit }, undefined, WEIGHT_WARNING);
  }

  const tail = context.tokens.slice(expression.end, expression.end + 5);
  let countToken: LexToken | undefined;
  let dosesToken: LexToken | undefined;
  let tailLength = 0;
  const firstTail = tail[0] ? normalizeTokenLower(tail[0]) : "";
  if (/^(?:divided|divide)$/u.test(firstTail) && /^(?:into|in)$/u.test(tail[1] ? normalizeTokenLower(tail[1]) : "")) {
    countToken = tail[2];
    const maybeEqual = tail[3] && normalizeTokenLower(tail[3]) === "equal";
    dosesToken = tail[maybeEqual ? 4 : 3];
    tailLength = maybeEqual ? 5 : 4;
  } else if (/^(?:into|in)$/u.test(firstTail)) {
    countToken = tail[1];
    const maybeEqual = tail[2] && normalizeTokenLower(tail[2]) === "equal";
    dosesToken = tail[maybeEqual ? 3 : 2];
    tailLength = maybeEqual ? 4 : 3;
  }
  const dividedDoseCount = countToken
    ? countToken.kind === LexKind.Number && countToken.value !== undefined
      ? countToken.value
      : FREQUENCY_NUMBER_WORDS[normalizeTokenLower(countToken)]
    : undefined;
  if (countToken && dosesToken && available(context, expression.end + tailLength - 1) &&
      dividedDoseCount !== undefined && Number.isInteger(dividedDoseCount) && dividedDoseCount > 0 &&
      /^(?:dose|doses)$/u.test(normalizeTokenLower(dosesToken))) {
    for (let index = 0; index < tailLength; index++) indices.push(expression.end + index);
    const projectedDose = { value: value / dividedDoseCount, unit: doseUnit };
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightDailyDivided", indices, {
      representation: "dose",
      status: "resolved",
      numerator,
      denominators: [bodyMass, { value: 1, unit: FhirPeriodUnit.Day, dimension: "time" }],
      projectedDose,
      dailyTotal: true,
      dividedDoseCount,
      requiresPatientWeight: true
    }, projectedDose, {
      frequency: dividedDoseCount,
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
  const hasRateMarker = Boolean(cue && available(context, start - 1) &&
    /^(?:at|@)$/u.test(normalizeTokenLower(cue)));
  // An unmarked rate is valid only inside an explicit infusion/run
  // construction; standalone numeric rates must never be inferred as doses.
  if (!numerator || !denominatorUnit ||
      (!hasRateMarker && !hasAdministrationCue(context, start))) return undefined;
  const duration = durationAfter(context, expression.end);
  const indices = [
    ...(hasRateMarker ? [start - 1] : []),
    ...Array.from({ length: expression.end - start }, (_, offset) => start + offset)
  ];
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
 * dimensional forms; unsupported weight suffixes remain typed unresolved
 * evidence instead of an ordinary dose.
 */
export function clinicalQuantityLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinicalQuantity", (context, start) => {
    const valueToken = context.tokens[start];
    if (!valueToken || valueToken.kind !== LexKind.Number || valueToken.value === undefined ||
        valueToken.value <= 0 || !available(context, start + 1)) return [];

    const activeInCarrier = activeDoseInCarrierOverTime(context, start, valueToken.value);
    if (activeInCarrier) return [activeInCarrier];

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
