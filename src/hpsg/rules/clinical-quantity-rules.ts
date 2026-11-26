import { routeLexicalRule } from "./core-rules";
import { LexKind } from "../../lexer/token-types";
import { getRouteMeaning, hasTimingAbbreviationMeaning } from "../../lexer/meaning";
import { FhirPeriodUnit, RouteCode } from "../../types";
import { normalizeUnit } from "../../unit-lexicon";
import {
  HpsgClauseContext, lexicalRule, maximumDosePerPeriodAt, normalizeTokenLower,
  quantityTokenAvailable as available, doseNumberValue, plainClinicalNumberAt, doseUnitIndexAfter
} from "../rule-context";
import { EVERY_INTERVAL_TOKENS, FREQUENCY_NUMBER_WORDS, mapIntervalUnit } from "../timing-lexicon";
import {
  doseComparatorNumberAt,
  doseRangeNumberAt,
  compactMillionDoseNumber,
  DOSE_FRACTION_ARTICLES,
  additiveDoseNumberAt,
  attachedNumberUnitAt,
  DOSE_ADDITIVE_QUANTITY_CONNECTORS,
  DOSE_NUMBER_WORDS,
  DOSE_FRACTION_WORDS,
  DOSE_FRACTION_DENOMINATOR_WORDS,
  DOSE_UNIT_CONNECTORS,
  MEDICATION_OBJECT_FILLERS,
  MAXIMUM_COUNT_LEAD_TOKENS,
  MAXIMUM_COUNT_LEAD_FIRST_TOKENS,
  SITE_TRAILING_INSTRUCTION_WORDS
} from "../lexical-classes";
import {
  HpsgClinicalQuantityFeature,
  HpsgDimensionalQuantityTerm,
  HpsgDoseFeature,
  HpsgLexicalRule,
  HpsgScheduleFeature,
  HpsgSign,
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

function directDoseUnitAfter(
  context: HpsgClauseContext,
  start: number
): { unit: string; end: number } | undefined {
  const cursor = doseUnitIndexAfter(context, start);
  if (cursor === undefined) return undefined;
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
  if (whole === undefined) return undefined;
  const mixed = additiveDoseNumberAt(context.tokens, start, context.limit, whole);
  if (!mixed) return undefined;
  for (let i = start + 2; i <= mixed.numericIndex; i++)
    if (!available(context, i)) return undefined;
  const fractionEnd = mixed.numericIndex + 1;

  const unit = directDoseUnitAfter(context, fractionEnd);
  if (!unit) return undefined;
  const tokens = context.tokens.slice(start, unit.end);
  return lexicalSign({
    type: "dose-sign",
    rule: "hpsg.lex.clinicalQuantity.additiveFractionDose",
    tokens,
    consumedTokenIndices: tokens.map(token => token.index),
    synsem: {
      head: { dose: { value: mixed.value, unit: unit.unit } },
      valence: {},
      cont: { clauseKind: "administration" }
    },
    score: 25
  });
}

function compactUnitExpression(
  context: HpsgClauseContext,
  start: number,
  accepts: (value: string) => boolean,
  attachedPrefix = ""
): UnitExpression | undefined {
  let compact = attachedPrefix.toLowerCase().replace(/[μµ]/gu, "u");
  let result: UnitExpression | undefined = compact && accepts(compact)
    ? { compact, end: start } : undefined;
  const maxLength = attachedPrefix ? 4 : 5;
  // Five tokens cover compact/spaced mixtures such as `mcg/kg per min` and
  // `mg / kg / day` without a clause-wide scan. Longest match prevents /kg
  // from hiding a real time suffix.
  for (let length = 1; length <= maxLength && available(context, start + length - 1); length += 1) {
    const token = context.tokens[start + length - 1];
    const separator = token.original === "/" || normalizeTokenLower(token) === "per";
    // Spaced expressions have a strict UNIT separator UNIT shape. Do not
    // absorb a following route or cadence into an unknown suffix.
    const expectsSeparator = attachedPrefix ? length % 2 === 1 : length % 2 === 0;
    if (length > 1 || attachedPrefix) {
      if (separator !== expectsSeparator) break;
    } else if (separator) break;
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
  if (/^(?:u|iu|\[iu\]|unit|units)$/u.test(normalized)) {
    return { value, unit: "[iU]", dimension: "biologic-activity" };
  }
  return undefined;
}

export function volumeOrMassTerm(value: number, raw: string): HpsgDimensionalQuantityTerm | undefined {
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
  if (token.kind === LexKind.Number) return token.value !== undefined && token.value > 0 ? token.value : undefined;
  const word = normalizeTokenLower(token);
  const value = DOSE_NUMBER_WORDS.get(word) ?? FREQUENCY_NUMBER_WORDS[word] ?? DOSE_FRACTION_WORDS.get(word);
  return value !== undefined && value > 0 ? value : undefined;
}

export function clinicalRatePeriodUnit(raw: string): FhirPeriodUnit.Hour | FhirPeriodUnit.Minute | undefined {
  if (/^(?:h|hr|hrs|hour|hours)$/u.test(raw)) return FhirPeriodUnit.Hour;
  if (/^(?:min|mins|minute|minutes)$/u.test(raw)) return FhirPeriodUnit.Minute;
  return undefined;
}

function weightRatePeriodUnit(
  raw: string
): FhirPeriodUnit.Hour | FhirPeriodUnit.Minute | FhirPeriodUnit.Week | undefined {
  return clinicalRatePeriodUnit(raw) ??
    (/^(?:wk|wks|week|weeks)$/u.test(raw) ? FhirPeriodUnit.Week : undefined);
}

function hasAdministrationCue(context: HpsgClauseContext, before: number, allowPrecedingDose = false): boolean {
  const first = Math.max(0, before - 8);
  const maximum = allowPrecedingDose &&
    MAXIMUM_COUNT_LEAD_FIRST_TOKENS.has(normalizeTokenLower(context.tokens[before]));
  let precedingAmount = false, precedingCadence = false;
  for (let index = before - 1; index >= first; index -= 1) {
    const token = context.tokens[index];
    const lower = normalizeTokenLower(token);
    if (maximum && (EVERY_INTERVAL_TOKENS.has(lower) || hasTimingAbbreviationMeaning(token)))
      precedingCadence = true;
    // An administration head owns its nearest numeric argument. A later
    // cumulative limit cannot borrow it across the already administered dose.
    if (/^(?:infuse|infusion|run|administer|give)$/u.test(lower)) {
      if (!precedingAmount) return true;
      // A recurring dose keeps its own administration head. A later limit
      // cannot borrow that head as an infusion-rate instruction.
      if (!allowPrecedingDose || precedingCadence) return false;
      // A borrowed administration head still belongs to its typed route.
      // Reuse the route constituent so multiword and configured routes retain
      // the same ownership as a single annotated route token.
      const route = routeLexicalRule();
      for (let routeStart = index + 1; routeStart < before; routeStart++)
        for (const sign of route.match(context, routeStart))
          if (sign.tokens[sign.tokens.length - 1].index < context.tokens[before].index &&
              sign.synsem.head.route?.code === RouteCode["Oral route"]) return false;
      return true;
    }
    if ((token.kind === LexKind.Number || token.kind === LexKind.NumberRange ||
        DOSE_NUMBER_WORDS.has(lower) || DOSE_FRACTION_WORDS.has(lower)) &&
        // Only a medication amount owns the cue. Product strengths (0.9 %)
        // and route determiners (via a peripheral IV) are not earlier doses.
        directDoseUnitAfter(context, index + 1)) {
      precedingAmount = true;
    } else if (token.kind === LexKind.Word) {
      // Compact doses own the same numeric argument, including a qualifier
      // attached to that numeral. Reuse the bounded lexical quantity readers.
      const rawUnit = attachedNumberUnitAt(lower)?.rawUnit ??
        doseComparatorNumberAt(context.tokens, index, before, lower)?.rawUnit;
      if (rawUnit && normalizeUnit(rawUnit, context.options)) precedingAmount = true;
    }
  }
  return false;
}

function durationAfter(
  context: HpsgClauseContext,
  start: number
): { value: number; unit: FhirPeriodUnit.Hour | FhirPeriodUnit.Minute; comparator?: NonNullable<HpsgClinicalQuantityFeature["administrationDuration"]>["comparator"]; indices: number[] } | undefined {
  const limit = Math.min(context.limit, start + 8);
  for (let index = start; index + 1 < limit; index += 1) {
    if (!available(context, index)) break;
    const token = normalizeTokenLower(context.tokens[index]);
    if (!INFUSION_DURATION_LEADS.has(token)) {
      const next = context.tokens[index + 1];
      // Only a route marker or an optional comma may intervene between a
      // rate and its duration. Never cross into another clinical action.
      if (getRouteMeaning(context.tokens[index])?.code === RouteCode["Intravenous route"] ||
          (token === "," && next && available(context, index + 1) &&
            (INFUSION_DURATION_LEADS.has(normalizeTokenLower(next)) ||
              getRouteMeaning(next)?.code === RouteCode["Intravenous route"]))) continue;
      break;
    }
    const duration = infusionDurationAt(context, index + 1);
    if (!duration) continue;
    return { value: duration.value, unit: duration.unit, comparator: duration.comparator,
      indices: Array.from({ length: duration.end - index }, (_, offset) => index + offset) };
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
  dose?: HpsgDoseFeature,
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
  value: number,
  attachedUnit?: string,
  phraseStart = start,
  activeRange?: HpsgDoseFeature["range"]
) {
  const unitShift = attachedUnit ? -1 : 0;
  const activeUnitToken = context.tokens[start + 1];
  const activeUnit = attachedUnit ?? (activeUnitToken && normalizeTokenLower(activeUnitToken));
  const possibleProduct = context.tokens[start + 2 + unitShift];
  // Registered product nouns may appear between the active amount and its
  // carrier. Compact >=20mg owns its unit in the same source token.
  const productShift = possibleProduct && available(context, start + 2 + unitShift) &&
    MEDICATION_OBJECT_FILLERS.has(normalizeTokenLower(possibleProduct)) ? 1 : 0;
  const inToken = context.tokens[start + 2 + unitShift + productShift];
  const carrierStart = start + 3 + unitShift + productShift;
  const carrierValueToken = context.tokens[carrierStart];
  if (!activeUnit || !inToken || !carrierValueToken ||
      normalizeTokenLower(inToken) !== "in") return undefined;
  const qualifiedCarrier = carrierValueToken.kind === LexKind.Number ? undefined :
    doseComparatorNumberAt(context.tokens, carrierStart, context.limit, normalizeTokenLower(carrierValueToken));
  const attachedCarrier = !qualifiedCarrier && carrierValueToken.kind !== LexKind.Number
    ? attachedNumberUnitAt(carrierValueToken.lower.replace(/[{};]+|\.+$/gu, "")) : undefined;
  const plainCarrier = !qualifiedCarrier && !attachedCarrier
    ? plainClinicalNumberAt(context, carrierStart) : undefined;
  const carrierNumber = qualifiedCarrier?.value ?? plainCarrier?.value ?? attachedCarrier?.value;
  let carrierUnitStart = (qualifiedCarrier?.numericIndex ?? plainCarrier?.numericIndex ?? carrierStart) + 1;
  // A fractional numeric daughter owns its optional partitive/article,
  // equally for bare and qualified carrier amounts.
  if (!(qualifiedCarrier?.rawUnit || attachedCarrier?.rawUnit) && carrierNumber !== undefined &&
      (carrierNumber < 1 || plainCarrier?.fractional || qualifiedCarrier &&
        DOSE_FRACTION_DENOMINATOR_WORDS.has(normalizeTokenLower(context.tokens[qualifiedCarrier.numericIndex])))) {
    while (available(context, carrierUnitStart) &&
        DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[carrierUnitStart]))) carrierUnitStart++;
  }
  const carrierUnitToken = context.tokens[carrierUnitStart];
  const carrierUnit = qualifiedCarrier?.rawUnit ?? attachedCarrier?.rawUnit ??
    (carrierUnitToken && available(context, carrierUnitStart) ? normalizeTokenLower(carrierUnitToken) : undefined);
  if (carrierNumber === undefined || carrierNumber <= 0 || !carrierUnit) return undefined;
  const activeDose = massTerm(value, normalizeUnit(activeUnit, context.options) ?? activeUnit);
  const carrier = volumeOrMassTerm(carrierNumber, normalizeUnit(carrierUnit, context.options) ?? carrierUnit);
  if (!activeDose || !carrier || carrier.dimension !== "volume" ||
      !hasAdministrationCue(context, phraseStart)) return undefined;
  if (qualifiedCarrier) carrier.comparator = qualifiedCarrier.comparator;

  // The carrier-volume constituent may have a nominal daughter between its
  // unit and the infusion-duration head: "500 mL normal saline over 4 h".
  // This is a bounded lexical NP inside a dimensionally licensed construction,
  // not a dictionary/keyword rule for saline, solution, dextrose, etc.
  // A number or clause separator cannot be silently absorbed as material.
  let cursor = carrierUnitStart + (qualifiedCarrier?.rawUnit || attachedCarrier?.rawUnit ? 0 : 1);
  const materialStart = cursor;
  while (cursor - materialStart < 3 && available(context, cursor)) {
    const token = context.tokens[cursor];
    const word = normalizeTokenLower(token);
    if (INFUSION_DURATION_LEADS.has(word) || SITE_TRAILING_INSTRUCTION_WORDS.has(word) ||
        (getRouteMeaning(token)?.code === RouteCode["Intravenous route"] &&
          available(context, cursor + 1) &&
          (INFUSION_DURATION_LEADS.has(normalizeTokenLower(context.tokens[cursor + 1])) ||
            SITE_TRAILING_INSTRUCTION_WORDS.has(normalizeTokenLower(context.tokens[cursor + 1])))) ||
        token.kind !== LexKind.Word) break;
    cursor++;
  }
  const materialEnd = cursor;
  const mannerStart = cursor;
  while (available(context, cursor) &&
      SITE_TRAILING_INSTRUCTION_WORDS.has(normalizeTokenLower(context.tokens[cursor]))) cursor++;
  const routeIndex = cursor;
  const routeToken = context.tokens[cursor];
  const markedIV = Boolean(routeToken && available(context, cursor) &&
    getRouteMeaning(routeToken)?.code === RouteCode["Intravenous route"]);
  if (markedIV) cursor++;
  // Manner modifiers are independent daughters, not carrier material. Leave
  // their tokens available to the existing instruction lexicon.
  while (available(context, cursor) &&
      SITE_TRAILING_INSTRUCTION_WORDS.has(normalizeTokenLower(context.tokens[cursor]))) cursor++;
  const mannerEnd = cursor;
  const overToken = context.tokens[cursor];
  if (!overToken || !INFUSION_DURATION_LEADS.has(normalizeTokenLower(overToken))) return undefined;
  const duration = infusionDurationAt(context, cursor + 1);
  if (!duration || duration.value <= 0) return undefined;
  const durationValue = duration.value, durationUnit = duration.unit, durationEnd = duration.end;
  const durationQualifier = duration.comparator ? { comparator: duration.comparator } : {};

  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator: carrier,
    denominators: [{ value: durationValue, unit: durationUnit, dimension: "time", ...durationQualifier }],
    ...(!activeRange ? { projectedDose: { value, unit: activeDose.unit } } : {}),
    rateNumerator: { value: carrier.value, unit: carrier.unit,
      ...(carrier.comparator ? { comparator: carrier.comparator } : {}) },
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
    administrationDuration: { value: durationValue, unit: durationUnit, ...durationQualifier }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.activeDoseInCarrierOverTime",
    Array.from({ length: durationEnd - start }, (_, offset) => start + offset)
      .filter(index => index < mannerStart || index >= mannerEnd || markedIV && index === routeIndex),
    clinicalQuantity,
    activeRange ? { range: activeRange, unit: activeDose.unit } : clinicalQuantity.projectedDose,
    { sourceRanges: [{
      start: overToken.sourceStart, end: context.tokens[durationEnd - 1].sourceEnd
    }] },
    undefined,
    markedIV ? RouteCode["Intravenous route"] : undefined
  );
}

/** Shared elapsed-duration daughter of both infusion constructions. */
function infusionDurationAt(context: HpsgClauseContext, start: number) {
  const token = context.tokens[start];
  if (!token || !available(context, start)) return undefined;
  const qualified = token.kind === LexKind.Number ? undefined :
    doseComparatorNumberAt(context.tokens, start, context.limit, normalizeTokenLower(token));
  const articleFraction = !qualified && DOSE_FRACTION_ARTICLES.has(normalizeTokenLower(token)) &&
    available(context, start + 1)
    ? DOSE_FRACTION_WORDS.get(normalizeTokenLower(context.tokens[start + 1])) : undefined;
  const attached = !qualified && token.kind !== LexKind.Number
    ? attachedNumberUnitAt(token.lower.replace(/[{};]+|\.+$/gu, "")) : undefined;
  const cardinal = articleFraction ?? attached?.value ?? (qualified ? undefined : clinicalDurationNumber(token));
  const denominator = articleFraction === undefined && cardinal !== undefined && available(context, start + 1)
    ? DOSE_FRACTION_DENOMINATOR_WORDS.get(normalizeTokenLower(context.tokens[start + 1])) : undefined;
  const exact = cardinal === undefined ? undefined : denominator === undefined ? cardinal : cardinal * denominator;
  const mixed = exact === undefined || denominator !== undefined ? undefined :
    additiveDoseNumberAt(context.tokens, start, context.limit, exact);
  let unitIndex = (qualified?.numericIndex ?? mixed?.numericIndex ??
    (articleFraction === undefined && denominator === undefined ? start : start + 1)) + 1;
  const value = qualified?.value ?? mixed?.value ?? exact;
  const rawUnit = qualified?.rawUnit ?? attached?.rawUnit;
  // The fraction selects its unit complement, including "of an hour".
  // Whole duration numbers retain their direct unit boundary.
  if (!rawUnit && value !== undefined && value > 0 &&
      (value < 1 || denominator !== undefined || qualified &&
        DOSE_FRACTION_DENOMINATOR_WORDS.has(normalizeTokenLower(context.tokens[qualified.numericIndex])))) {
    while (available(context, unitIndex) &&
        DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[unitIndex]))) unitIndex++;
  }
  const unitToken = context.tokens[unitIndex];
  const unit = rawUnit ? clinicalRatePeriodUnit(rawUnit) :
    unitToken && available(context, unitIndex) ? clinicalRatePeriodUnit(normalizeTokenLower(unitToken)) : undefined;
  if (value === undefined || !unit) return undefined;
  return { value, unit, comparator: qualified?.comparator,
    end: unitIndex + (rawUnit ? 0 : 1) };
}

function fixedVolumeOverTime(
  context: HpsgClauseContext,
  start: number,
  value: number,
  attachedUnit?: string,
  phraseStart = start
) {
  const unitToken = context.tokens[start + 1];
  const unit = attachedUnit ?? (unitToken && normalizeTokenLower(unitToken));
  const unitShift = attachedUnit ? -1 : 0;
  // IV may be written between a volume and its administration duration:
  // "Infuse 500 mL IV over 2 hours". License that exact route phrase as a
  // typed lexical contribution; don't reinterpret arbitrary intervening text.
  const possibleRouteToken = context.tokens[start + 2 + unitShift];
  const markedIV = Boolean(possibleRouteToken && available(context, start + 2 + unitShift) &&
    /^(?:iv|intravenously)$/u.test(normalizeTokenLower(possibleRouteToken)));
  const shift = (markedIV ? 1 : 0) + unitShift;
  const overToken = context.tokens[start + 2 + shift];
  if (!unit || !overToken || !INFUSION_DURATION_LEADS.has(normalizeTokenLower(overToken))) return undefined;
  const numerator = volumeOrMassTerm(value, unit);
  const duration = infusionDurationAt(context, start + 3 + shift);
  const durationLead = normalizeTokenLower(overToken);
  if (!numerator || numerator.dimension !== "volume" || !duration ||
      // `volume over elapsed-time` is itself a bounded dimensional
      // constituent. It can therefore be the complement of an inherited
      // administration head in a later regimen phase. In contrast, `for`
      // remains ambiguous with course duration and requires a local head.
      durationLead !== "over" && !hasAdministrationCue(context, phraseStart)) return undefined;
  const durationQualifier = duration.comparator ? { comparator: duration.comparator } : {};
  const clinicalQuantity: HpsgClinicalQuantityFeature = {
    representation: "dose-with-rate-ratio",
    status: "resolved",
    numerator,
    denominators: [{ value: duration.value, unit: duration.unit, dimension: "time", ...durationQualifier }],
    projectedDose: { value, unit: numerator.unit },
    administrationDuration: { value: duration.value, unit: duration.unit, ...durationQualifier }
  };
  return clinicalSign(
    context,
    "hpsg.lex.clinicalQuantity.fixedVolumeOverTime",
    Array.from({ length: duration.end - start }, (_, offset) => start + offset),
    clinicalQuantity,
    clinicalQuantity.projectedDose,
    { sourceRanges: [{
      start: overToken.sourceStart, end: context.tokens[duration.end - 1].sourceEnd
    }] },
    undefined,
    markedIV ? RouteCode["Intravenous route"] : undefined
  );
}

/** Rate heads own their marker before the site/advice fallbacks run. */
function separateRateMarker(context: HpsgClauseContext, phraseStart: number): number | undefined {
  const index = phraseStart - 1, token = context.tokens[index];
  return token && available(context, index) && /^(?:at|@)$/u.test(normalizeTokenLower(token))
    ? index : undefined;
}

function weightQuantity(
  context: HpsgClauseContext,
  start: number,
  value: number,
  expression: UnitExpression,
  phraseStart = start
) {
  const parts = expression.compact.split("/");
  if (parts.length < 2 || parts[1] !== "kg") return undefined;
  const numerator = massTerm(value, parts[0]);
  if (!numerator) return undefined;
  const marker = separateRateMarker(context, phraseStart);
  const indices = [
    ...(marker !== undefined ? [marker] : []),
    ...Array.from({ length: expression.end - start }, (_, offset) => start + offset),
  ];
  const bodyMass: HpsgDimensionalQuantityTerm = {
    value: 1,
    unit: "kg",
    dimension: "patient-mass"
  };
  const suffix = parts[2];
  const perDose = suffix === "dose";
  // Compound denominator morphology (e.g. /24h or /30min) is independent of
  // the medication, route, and placement of a division complement.
  const timeParts = suffix?.match(/^(\d+(?:\.\d+)?|\.\d+)?([a-z]+)$/u);
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
      administrationDuration: duration ? { value: duration.value, unit: duration.unit,
        ...(duration.comparator ? { comparator: duration.comparator } : {}) } : undefined,
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

/** Shared lexical rate-head ownership, including a local route or AT marker. */
export function clinicalRateHeadAt(
  context: HpsgClauseContext, phraseStart: number, end: number, allowPrecedingDose = false
): { licensed: boolean; marker: number | undefined } {
  const cue = context.tokens[phraseStart - 1]?.original === ","
    ? context.tokens[phraseStart - 2] : context.tokens[phraseStart - 1];
  const marker = separateRateMarker(context, phraseStart);
  const next = context.tokens[end];
  const after = next?.original === "," ? context.tokens[end + 1] : next;
  // A route cannot turn the maximum head or its numeric daughter into a rate.
  const maximum = MAXIMUM_COUNT_LEAD_TOKENS.has(normalizeTokenLower(context.tokens[phraseStart])) ||
    cue && MAXIMUM_COUNT_LEAD_TOKENS.has(normalizeTokenLower(cue));
  return { marker, licensed: marker !== undefined || context.tokens[phraseStart].lower.startsWith("@") ||
    !maximum && (getRouteMeaning(cue)?.code === RouteCode["Intravenous route"] ||
      getRouteMeaning(after)?.code === RouteCode["Intravenous route"]) ||
    hasAdministrationCue(context, phraseStart, allowPrecedingDose && !maximum) };
}

function fixedRate(
  context: HpsgClauseContext,
  start: number,
  value: number,
  expression: UnitExpression,
  phraseStart = start,
  comparator?: HpsgClinicalQuantityFeature["numerator"]["comparator"]
) {
  const parts = expression.compact.split("/");
  if (parts.length !== 2) return undefined;
  const numerator = volumeOrMassTerm(value, parts[0]);
  const denominatorUnit = clinicalRatePeriodUnit(parts[1]);
  // A bare/approximate per-time rate can complete the preceding volume,
  // with or without a comma. A qualified limit still needs its own marker
  // or local head; the earlier volume cannot lend the administration cue.
  const completesVolume = comparator === undefined || comparator === "~";
  const duration = durationAfter(context, expression.end);
  // A clause-initial rate with its own elapsed duration is a complete typed
  // complement. The selected sequential construction owns its omitted method.
  const completeRateComplement = completesVolume && phraseStart === 0 && duration !== undefined;
  const head = clinicalRateHeadAt(context, phraseStart, expression.end, completesVolume);
  if (!numerator || !denominatorUnit || (!completeRateComplement && !head.licensed)) return undefined;
  const indices = [
    ...(head.marker !== undefined ? [head.marker] : []),
    ...Array.from({ length: expression.end - start }, (_, offset) => start + offset)
  ];
  if (duration) indices.push(...duration.indices);
  return clinicalSign(context, "hpsg.lex.clinicalQuantity.fixedRate", indices, {
    representation: "rate-quantity",
    status: "resolved",
    numerator,
    denominators: [{ value: 1, unit: denominatorUnit, dimension: "time" }],
    administrationDuration: duration ? { value: duration.value, unit: duration.unit,
        ...(duration.comparator ? { comparator: duration.comparator } : {}) } : undefined
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
  if (context.tokens[cursor] &&
      /^(?:equal|divided)$/u.test(normalizeTokenLower(context.tokens[cursor]))) cursor += 1;
  const doses = context.tokens[cursor];
  if (!doses || !available(context, cursor) || !/^(?:dose|doses)$/u.test(normalizeTokenLower(doses))) return undefined;
  return lexicalSign({
    type: "dose-sign", rule: "hpsg.lex.clinicalQuantity.divisionCount",
    tokens: context.tokens.slice(start, cursor + 1),
    synsem: { head: { dose: { divisionCount: count } }, valence: {}, cont: {} },
    score: 45
  });
}

/** Attach an authored qualifier to the quantity that the numeric head owns.
 * A drug amount in a carrier does not qualify the carrier's volume/rate;
 * a standalone rate qualifier does not qualify an independent drug dose. */
function qualifyClinicalSign(
  context: HpsgClauseContext, phraseStart: number, numericStart: number,
  sign: HpsgSign | undefined,
  comparator: HpsgClinicalQuantityFeature["numerator"]["comparator"]
): HpsgSign | undefined {
  if (!comparator) {
    if (!sign || phraseStart === numericStart) return sign;
    return lexicalSign({ type: sign.type, rule: sign.evidence[0].rule,
      tokens: [...context.tokens.slice(phraseStart, numericStart), ...sign.tokens]
        .sort((a, b) => a.index - b.index),
      synsem: sign.synsem, warnings: sign.warnings,
      score: sign.score + numericStart - phraseStart });
  }
  const dose = sign?.synsem.head.dose;
  const quantity = dose?.clinicalQuantity;
  if (!sign || !dose || !quantity) return undefined;
  const projectedDose = quantity.projectedDose
    ? { ...quantity.projectedDose, comparator } : undefined;
  const clinicalQuantity = {
    ...quantity,
    // Explicit active-in-carrier quantity has a distinct rateNumerator.
    // The leading number belongs only to its projected drug dose.
    numerator: quantity.rateNumerator ? quantity.numerator : { ...quantity.numerator, comparator },
    ...(projectedDose ? { projectedDose } : {})
  };
  const tokens = [...context.tokens.slice(phraseStart, numericStart), ...sign.tokens]
    .sort((a, b) => a.index - b.index);
  return lexicalSign({
    type: "dose-sign", rule: sign.evidence[0].rule,
    tokens,
    synsem: { ...sign.synsem, head: {
      ...sign.synsem.head,
      dose: { ...dose, ...(projectedDose ? { comparator } : {}), clinicalQuantity }
    } },
    warnings: sign.warnings, score: sign.score + numericStart - phraseStart + 2
  });
}

/** Bounded dimensional quantity construction; unresolved weight amounts
 * remain typed rates instead of fabricated scalar administrations. */
/** Instruction lookahead asks the same typed quantity owner before absorbing
 * a later body token. Each start is matched once in this chart context; the
 * normal lexical enumeration then reuses the sign, without a pre-scan. */
export function clinicalQuantityAt(context: HpsgClauseContext, start: number): HpsgSign[] {
  const matches = context.clinicalCache.quantityLookahead ??= new Map<number, HpsgSign[]>();
  const cached = matches.get(start);
  if (cached) return cached;
  const result = matchClinicalQuantity(context, start);
  matches.set(start, result);
  return result;
}

export function clinicalQuantityLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.clinicalQuantity", (context, start) =>
    context.clinicalCache.quantityLookahead?.get(start) ?? matchClinicalQuantity(context, start));
}

function matchClinicalQuantity(context: HpsgClauseContext, start: number): HpsgSign[] {
  const token = context.tokens[start];
  if (!token || !available(context, start)) return [];
  // A complete numeric or qualified daughter owns its suffix, including an
  // unlicensed rate phrase. Its bare value must not become a competing rate.
  if (context.clinicalCache.rateTokenIndices?.has(token.index) ||
      context.clinicalCache.unlicensedRateTokenIndices?.has(token.index)) return [];
  const division = dividedDoseCountSign(context, start);
  if (division) return [division];
  let phraseStart = start;
  let quantityToken = token;
  const lower = token.kind === LexKind.Number ? "" : normalizeTokenLower(token);
  const quantityLower = lower.startsWith("@") && lower.length > 1 ? lower.slice(1) : lower;
  let qualified = token.kind === LexKind.Number ? undefined :
    doseComparatorNumberAt(context.tokens, start, context.limit, quantityLower);
  // AT is a rate head when its following quantity has a per-time unit.
  // Start that constituent at AT, before the generic site rule can claim
  // "at approximately" as an anatomical destination.
  if (!qualified && (lower === "at" || lower === "@")) {
    const next = context.tokens[start + 1];
    if (next && available(context, start + 1)) {
      phraseStart++;
      quantityToken = next;
      qualified = next.kind === LexKind.Number ? undefined :
        doseComparatorNumberAt(context.tokens, phraseStart, context.limit, normalizeTokenLower(next));
    }
  }
  // Read the complete numeric head before an attached unit. A million
  // suffix scales the number, while an attached @ only licenses a rate.
  const attachedLower = !qualified && quantityToken.kind !== LexKind.Number
    ? quantityToken.lower.replace(/^@|[{};]+|\.+$/gu, "") : undefined;
  const compactMillion = attachedLower?.endsWith("m") ? compactMillionDoseNumber(attachedLower) : undefined;
  const markedNumber = quantityToken.lower.startsWith("@") && /^@(?:\d+(?:\.\d+)?|\.\d+)$/u.test(quantityToken.lower)
    ? Number(quantityToken.lower.slice(1)) : undefined;
  const rangedNumber = qualified ? undefined : doseRangeNumberAt(context.tokens, phraseStart, context.limit);
  if (rangedNumber) {
    for (let index = phraseStart; index <= rangedNumber.numericIndex; index++)
      if (!available(context, index)) return [];
  }
  const plainNumber = qualified || rangedNumber ? undefined :
    plainClinicalNumberAt(context, phraseStart, compactMillion ?? markedNumber);
  const numericStart = rangedNumber?.numericIndex ?? qualified?.numericIndex ?? plainNumber?.numericIndex ?? phraseStart;
  // The general lower-case normalizer strips leading punctuation, but a
  // leading dot is a significant decimal point in '.1mcg/kg/min'. Trim
  // trailing sentence punctuation only; never turn .1 into 1.
  const attached = compactMillion === undefined && attachedLower
    ? attachedNumberUnitAt(attachedLower) : undefined;
  const value = rangedNumber?.range.high ?? qualified?.value ?? plainNumber?.value ?? attached?.value;
  // Both a qualified amount ('~0.1mcg/kg per min') and an exact compact
  // amount ('0.1mcg/kg per min') use one bounded dimensional unit grammar.
  const unit = (qualified?.rawUnit ?? attached?.rawUnit)?.replace(/[μµ]/gu, "u");
  if (value === undefined || value <= 0 || (!unit && !available(context, numericStart + 1))) return [];
  // The numeric daughter owns the article/preposition in a fractional unit
  // complement ("half a mL", "three quarters of a mg"). All dimensional
  // constructions start after that complement, keeping its original value.
  let quantityEnd = numericStart;
  if (!unit && (value < 1 || plainNumber?.fractional || qualified &&
      DOSE_FRACTION_DENOMINATOR_WORDS.has(normalizeTokenLower(context.tokens[qualified.numericIndex])))) {
    while (available(context, quantityEnd + 1) &&
        DOSE_UNIT_CONNECTORS.has(normalizeTokenLower(context.tokens[quantityEnd + 1]))) quantityEnd++;
  }
  const comparator = qualified?.comparator;
  // A complete cumulative maximum owns its elapsed period. Its amount must
  // not become a competing volume-over-time administration.
  const maximum = qualified && maximumDosePerPeriodAt(context, phraseStart);
  if (maximum && !maximum.period.unitDenominator) return [];
  const activeInCarrier = qualifyClinicalSign(context, phraseStart, quantityEnd,
    activeDoseInCarrierOverTime(context, quantityEnd, value, unit, phraseStart, rangedNumber?.range), comparator);
  const volume = activeInCarrier ?? (rangedNumber ? undefined : qualifyClinicalSign(context, phraseStart, quantityEnd,
    fixedVolumeOverTime(context, quantityEnd, value, unit, phraseStart), comparator));
  if (volume) {
    // The volume-over-time construction owns its leading rate marker too.
    const sign = phraseStart > start ? lexicalSign({
      type: volume.type, rule: volume.evidence[0].rule,
      tokens: [token, ...volume.tokens], synsem: volume.synsem,
      warnings: volume.warnings, score: volume.score + 1
    }) : volume;
    const owned = context.clinicalCache.rateTokenIndices ??= new Set<number>();
    for (const token of sign.tokens) owned.add(token.index);
    const signs = [sign];
    (context.clinicalCache.quantityLookahead ??= new Map()).set(start, signs);
    return signs;
  }
  const accepts = (candidate: string) =>
    /^(?:mcg|ug|mg|g|u|unit|units|iu)\/kg(?:\/[^/]+)?$/u.test(candidate) ||
    /^(?:ml|l|mcg|ug|mg|g|u|unit|units|iu)\/[^/]+$/u.test(candidate) &&
      Boolean(mapIntervalUnit(candidate.slice(candidate.indexOf("/") + 1)));
  const expression = compactUnitExpression(
    context, quantityEnd + 1, accepts, unit ?? ""
  );
  if (rangedNumber) {
    // An unsupported fixed-rate range still owns both numeric endpoints.
    // Neither endpoint may become an exact rate or an independent scalar dose.
    const weight = expression && weightQuantity(context, quantityEnd, value, expression, phraseStart);
    if (expression && (mapIntervalUnit(expression.compact.split("/")[1]) ||
        weight?.synsem.head.dose?.clinicalQuantity?.representation === "rate-quantity")) {
      const owned = context.clinicalCache.unlicensedRateTokenIndices ??= new Set<number>();
      for (let index = phraseStart; index < expression.end; index++) owned.add(context.tokens[index].index);
    }
    return [];
  }
  if (!expression) {
    // Only a scalar unit can finish the additive dose construction. A per-time
    // continuation belongs to the complete mixed numeric daughter above.
    const additive = plainNumber?.mixed ? additiveFractionDose(context, phraseStart) : undefined;
    return additive ? [additive] : [];
  }
  const weight = qualifyClinicalSign(context, phraseStart, quantityEnd,
    weightQuantity(context, quantityEnd, value, expression, phraseStart), comparator);
  if (weight) {
    // Weight rates own the same external AT/@ marker as fixed rates.
    // Publish ownership before the site fallback examines that marker.
    const owned = context.clinicalCache.rateTokenIndices ??= new Set<number>();
    for (const token of weight.tokens) owned.add(token.index);
    const signs = [weight];
    (context.clinicalCache.quantityLookahead ??= new Map()).set(start, signs);
    return signs;
  }
  const rate = qualifyClinicalSign(context, phraseStart, quantityEnd,
    fixedRate(context, quantityEnd, value, expression, phraseStart, comparator), comparator);
  if (rate) {
    const owned = context.clinicalCache.rateTokenIndices ??= new Set<number>();
    for (const token of rate.tokens) owned.add(token.index);
    const signs = [rate];
    (context.clinicalCache.quantityLookahead ??= new Map()).set(start, signs);
    return signs;
  } else {
    // Unit morphology already established a per-time quantity. Without a
    // licensed rate head it remains source text; its numeric daughter must
    // not become a separate, unitless administration dose.
    const owned = context.clinicalCache.unlicensedRateTokenIndices ??= new Set<number>();
    for (let index = phraseStart; index < expression.end; index++) {
      owned.add(context.tokens[index].index);
    }
  }
  return [];
}
