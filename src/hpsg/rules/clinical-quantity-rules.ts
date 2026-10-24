import { LexKind } from "../../lexer/token-types";
import { FhirPeriodUnit, RouteCode } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import { HpsgClauseContext, lexicalRule, normalizeTokenLower } from "../rule-context";
import { FREQUENCY_NUMBER_WORDS } from "../timing-lexicon";
import {
  DOSE_ADDITIVE_QUANTITY_CONNECTORS,
  DOSE_FRACTION_ARTICLES,
  DOSE_FRACTION_DENOMINATOR_WORDS,
  DOSE_FRACTION_WORDS,
  DOSE_NUMBER_WORDS,
  DOSE_UNIT_CONNECTORS,
  MEDICATION_OBJECT_FILLERS
} from "../lexical-classes";
import {
  HpsgClinicalQuantityFeature,
  HpsgDimensionalQuantityTerm,
  HpsgLexicalRule,
  HpsgScheduleFeature,
  lexicalSign
} from "../signature";

/** Both prepositions license elapsed duration under an infusion head;
 * neither means ordinary regimen duration in this dimensional construction. */
const INFUSION_DURATION_LEADS = new Set(["over", "for"]);

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

function doseNumberValue(
  token: HpsgClauseContext["tokens"][number] | undefined
): number | undefined {
  if (!token) return undefined;
  return token.kind === LexKind.Number && token.value !== undefined
    ? token.value
    : DOSE_NUMBER_WORDS.get(normalizeTokenLower(token));
}

function directDoseUnitAfter(
  context: HpsgClauseContext,
  start: number
): { unit: string; end: number } | undefined {
  let cursor = start;
  while (available(context, cursor) &&
      DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[cursor]))) {
    cursor += 1;
  }
  if (!available(context, cursor)) return undefined;
  const unit = normalizeUnit(normalizeTokenLower(context.tokens[cursor]), context.options);
  return unit ? { unit, end: cursor + 1 } : undefined;
}

/**
 * English additive quantity construction with a shared unit:
 * WHOLE + additive connector + FRACTION + UNIT.
 *
 * The unit is a daughter of the whole expression, so this cannot absorb
 * coordination where the first amount already has its own unit (for example,
 * "one tablet and half ...").
 */
function additiveFractionDose(
  context: HpsgClauseContext,
  start: number
) {
  const wholeToken = context.tokens[start];
  if (!wholeToken || !available(context, start) || !available(context, start + 1) ||
      !DOSE_ADDITIVE_QUANTITY_CONNECTORS.has(normalizeTokenLower(context.tokens[start + 1]))) {
    return undefined;
  }
  const whole = doseNumberValue(wholeToken);
  if (whole === undefined || !Number.isInteger(whole) || whole <= 0) return undefined;

  let cursor = start + 2;
  if (available(context, cursor) &&
      DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(context.tokens[cursor]))) {
    cursor += 1;
  }
  if (!available(context, cursor)) return undefined;

  const fractionToken = context.tokens[cursor];
  let fraction = DOSE_FRACTION_WORDS.get(normalizeTokenLower(fractionToken));
  let fractionEnd = cursor + 1;
  if (fraction === undefined) {
    const numerator = doseNumberValue(fractionToken);
    const denominatorToken = context.tokens[cursor + 1];
    const denominator = denominatorToken && available(context, cursor + 1)
      ? DOSE_FRACTION_DENOMINATOR_WORDS.get(normalizeTokenLower(denominatorToken))
      : undefined;
    if (numerator === undefined || denominator === undefined) return undefined;
    fraction = numerator * denominator;
    fractionEnd += 1;
  }
  if (!(fraction > 0 && fraction < 1)) return undefined;

  const unit = directDoseUnitAfter(context, fractionEnd);
  if (!unit) return undefined;
  const tokens = context.tokens.slice(start, unit.end);
  return lexicalSign({
    type: "dose-sign",
    rule: "hpsg.lex.clinicalQuantity.additiveFractionDose",
    tokens,
    consumedTokenIndices: tokens.map(token => token.index),
    synsem: {
      head: { dose: { value: whole + fraction, unit: unit.unit } },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 25
  });
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

/** Shared numeric-word inventory: clinical quantities and ordinary timing
 * interpret the same lexical number daughters, without string special cases. */
function clinicalDurationNumber(token: HpsgClauseContext["tokens"][number] | undefined): number | undefined {
  if (!token) return undefined;
  const value = token.kind === LexKind.Number
    ? token.value
    : DOSE_NUMBER_WORDS.get(normalizeTokenLower(token)) ??
      FREQUENCY_NUMBER_WORDS[normalizeTokenLower(token)];
  return value !== undefined && value > 0 ? value : undefined;
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
    const value = clinicalDurationNumber(valueToken);
    if (value === undefined || !unit) continue;
    return { value, unit, indices: [index, index + 1, index + 2] };
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
  schedule?: HpsgScheduleFeature,
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
  const possibleProduct = context.tokens[start + 2];
  // The same registered medication object noun inventory that HPSG uses
  // for product phrases can stand between a dimensional active dose and its
  // vehicle: "20 mg drug in 500 mL". It is NOT another dose or a blank name.
  const productShift = possibleProduct && available(context, start + 2) &&
      MEDICATION_OBJECT_FILLERS.has(normalizeTokenLower(possibleProduct)) ? 1 : 0;
  const inToken = context.tokens[start + 2 + productShift];
  const carrierValueToken = context.tokens[start + 3 + productShift];
  const carrierUnitToken = context.tokens[start + 4 + productShift];
  if (!activeUnitToken || !inToken || !carrierValueToken || !carrierUnitToken ||
      !available(context, start + 4 + productShift) ||
      normalizeTokenLower(inToken) !== "in" ||
      carrierValueToken.kind !== LexKind.Number ||
      carrierValueToken.value === undefined || carrierValueToken.value <= 0) return undefined;
  const activeDose = massTerm(value, normalizeTokenLower(activeUnitToken));
  const carrier = volumeOrMassTerm(carrierValueToken.value, normalizeTokenLower(carrierUnitToken));
  if (!activeDose || !carrier || carrier.dimension !== "volume" ||
      !hasAdministrationCue(context, start)) return undefined;

  // The carrier-volume constituent may have a nominal daughter between its
  // unit and the infusion-duration head: "500 mL normal saline over 4 h".
  // This is a bounded lexical NP inside a dimensionally licensed construction,
  // not a dictionary/keyword rule for saline, solution, dextrose, etc.
  // A number or clause separator cannot be silently absorbed as material.
  let cursor = start + 5 + productShift;
  const materialStart = cursor;
  while (cursor - materialStart < 3 && available(context, cursor)) {
    const token = context.tokens[cursor];
    const word = normalizeTokenLower(token);
    if (INFUSION_DURATION_LEADS.has(word) ||
        word === "iv" || word === "intravenously" ||
        token.kind !== LexKind.Word) break;
    cursor++;
  }
  const materialEnd = cursor;
  const routeToken = context.tokens[cursor];
  const markedIV = Boolean(routeToken && available(context, cursor) &&
    /^(?:iv|intravenously)$/u.test(normalizeTokenLower(routeToken)));
  if (markedIV) cursor++;
  const overToken = context.tokens[cursor];
  const durationToken = context.tokens[cursor + 1];
  const durationUnitToken = context.tokens[cursor + 2];
  if (!overToken || !durationToken || !durationUnitToken ||
      !available(context, cursor + 2) ||
      !INFUSION_DURATION_LEADS.has(normalizeTokenLower(overToken))) return undefined;
  const durationValue = clinicalDurationNumber(durationToken);
  const durationUnit = timeUnit(normalizeTokenLower(durationUnitToken));
  if (durationValue === undefined || !durationUnit) return undefined;

  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator: carrier,
    denominators: [{ value: durationValue, unit: durationUnit, dimension: "time" }],
    projectedDose: { value, unit: activeDose.unit },
    rateNumerator: { value: carrier.value, unit: carrier.unit },
    ...(materialEnd > materialStart ? { carrierMaterial: {
      text: context.state.input.slice(
        context.tokens[materialStart].sourceStart,
        context.tokens[materialEnd - 1].sourceEnd
      ),
      range: {
        start: context.tokens[materialStart].sourceStart,
        end: context.tokens[materialEnd - 1].sourceEnd
      }
    } } : {}),
    administrationDuration: { value: durationValue, unit: durationUnit }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.activeDoseInCarrierOverTime",
    Array.from({ length: cursor + 3 - start }, (_, offset) => start + offset),
    clinicalQuantity,
    clinicalQuantity.projectedDose,
    { sourceRanges: [{
      start: overToken.sourceStart, end: durationUnitToken.sourceEnd
    }] },
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
      !available(context, start + 4 + shift) || !INFUSION_DURATION_LEADS.has(normalizeTokenLower(overToken))) return undefined;
  const numerator = volumeOrMassTerm(value, normalizeTokenLower(unitToken));
  const durationValue = clinicalDurationNumber(durationToken);
  const durationUnit = timeUnit(normalizeTokenLower(durationUnitToken));
  const durationLead = normalizeTokenLower(overToken);
  if (!numerator || numerator.dimension !== "volume" ||
      durationValue === undefined || !durationUnit ||
      // `volume over elapsed-time` is itself a bounded dimensional
      // constituent. It can therefore be the complement of an inherited
      // administration head in a later regimen phase. In contrast, `for`
      // remains ambiguous with course duration and requires a local head.
      durationLead !== "over" && !hasAdministrationCue(context, start)) return undefined;
  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator,
    denominators: [{ value: durationValue, unit: durationUnit, dimension: "time" }],
    projectedDose: { value, unit: numerator.unit },
    administrationDuration: { value: durationValue, unit: durationUnit }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.fixedVolumeOverTime",
    Array.from({ length: 5 + shift }, (_, offset) => start + offset),
    clinicalQuantity,
    clinicalQuantity.projectedDose,
    { sourceRanges: [{
      start: overToken.sourceStart, end: durationUnitToken.sourceEnd
    }] },
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
  // Compound denominator morphology (e.g. /24h or /30min) is independent of
  // the medication, route, and placement of a division complement.
  const timeParts = suffix?.match(/^(\d+(?:\.\d+)?)?([a-z]+)$/u);
  let periodValue = timeParts?.[1] ? Number(timeParts[1]) : 1;
  let periodUnit: FhirPeriodUnit | undefined = timeParts
    ? /^(?:day|daily|d)$/u.test(timeParts[2]) ? FhirPeriodUnit.Day : weightRatePeriodUnit(timeParts[2])
    : undefined;
  if (periodUnit === FhirPeriodUnit.Hour && periodValue >= 24 && periodValue % 24 === 0) {
    periodValue /= 24;
    periodUnit = FhirPeriodUnit.Day;
  }
  if (parts.length > 3 || (suffix && !perDose && (!periodUnit || periodValue <= 0))) {
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weight.unsupported", indices, {
      representation: "rate-quantity",
      status: "unsupported",
      numerator,
      denominators: [bodyMass],
      requiresPatientWeight: true,
      reviewReason: "unsupported-weight-based-rate"
    });
  }

  const rateTime = periodUnit !== FhirPeriodUnit.Day || periodValue !== 1 ? periodUnit : undefined;
  if (rateTime) {
    const duration = durationAfter(context, expression.end);
    if (duration) indices.push(...duration.indices);
    return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightRate", indices, {
      representation: "rate-quantity",
      status: "resolved",
      numerator,
      denominators: [
        bodyMass,
        { value: periodValue, unit: rateTime, dimension: "time" }
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

  return clinicalSign(context, "hpsg.lex.clinicalQuantity.weightDailyIncomplete", indices, {
    representation: "dose",
    status: "incomplete",
    numerator,
    denominators: [bodyMass, { value: 1, unit: FhirPeriodUnit.Day, dimension: "time" }],
    dailyTotal: true,
    requiresPatientWeight: true,
    reviewReason: "incomplete-weight-based-dose"
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

/** A division complement supplies cardinality, never an administered dose. */
function dividedDoseCountSign(context: HpsgClauseContext, start: number) {
  const first = normalizeTokenLower(context.tokens[start]);
  let cursor = start;
  if (first === "divided" || first === "divide") {
    cursor += 1;
    const connector = context.tokens[cursor];
    if (!connector || !/^(?:in|into)$/u.test(normalizeTokenLower(connector))) return undefined;
  } else if (first !== "in" && first !== "into") return undefined;
  cursor += 1;
  const countToken = context.tokens[cursor++];
  if (!countToken) return undefined;
  const count = countToken.kind === LexKind.Number
    ? countToken.value : FREQUENCY_NUMBER_WORDS[normalizeTokenLower(countToken)];
  if (count === undefined || !Number.isInteger(count) || count <= 0) return undefined;
  if (context.tokens[cursor] && normalizeTokenLower(context.tokens[cursor]) === "equal") cursor += 1;
  const doses = context.tokens[cursor];
  if (!doses || !available(context, cursor) || !/^(?:dose|doses)$/u.test(normalizeTokenLower(doses))) return undefined;
  return lexicalSign({
    type: "dose-sign", rule: "hpsg.lex.clinicalQuantity.divisionCount",
    tokens: context.tokens.slice(start, cursor + 1),
    synsem: { head: { dose: { divisionCount: count } }, valence: {}, cont: {} },
    score: 45
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
    const additive = additiveFractionDose(context, start);
    if (additive) return [additive];
    const division = dividedDoseCountSign(context, start);
    if (division) return [division];
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
