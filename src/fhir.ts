import {
  buildAdditionalInstructionFramesFromCoding,
  findAdditionalInstructionDefinitionByCoding
} from "./advice";
import {
  buildBodySiteSpatialRelationExtensions,
  parseBodySiteSpatialRelationExtension
} from "./body-site-spatial";
import {
  buildBodySiteTopographicalModifierCoding,
  getBodySiteText
} from "./body-site-lookup";
import { cloneExtensions, clonePrimitiveElement } from "./fhir-translations";
import { formatCanonicalClause } from "./format";
import { ParserState } from "./parser-state";
import { joinCanonicalPrnReasonTexts } from "./prn";
import {
  ROUTE_BY_SNOMED,
  ROUTE_SNOMED,
  ROUTE_TEXT,
  findPrnReasonDefinitionByCoding
} from "./maps";
import {
  CanonicalDoseRange,
  CanonicalSigClause,
  EventTiming,
  FhirCodeableConcept,
  FhirDosage,
  FhirPeriodUnit,
  FhirQuantity,
  FhirRange,
  FhirTimingRepeat,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";

const SNOMED_SYSTEM = "http://snomed.info/sct";
const UCUM_SYSTEM = "http://unitsofmeasure.org";
type CodeableConceptCoding = NonNullable<FhirCodeableConcept["coding"]>[number];

export interface FhirProjectionOptions {
  /**
   * Defaults to true. When true, structured spatial body-site phrases such as
   * "top of head" can emit a SNOMED topographical modifier expression in
   * Dosage.site.coding while preserving the spatial-relation extension.
   */
  bodySitePostcoordination?: boolean;
}

function createEmptyCanonicalClause(rawText: string): CanonicalSigClause {
  return {
    kind: "administration",
    rawText,
    raw: {
      start: 0,
      end: rawText.length,
      text: rawText
    },
    leftovers: [],
    evidence: [],
    confidence: 1
  };
}

function selectFirstCodingWithCode(
  concept: FhirCodeableConcept | undefined
): CodeableConceptCoding | undefined {
  if (!concept?.coding?.length) {
    return undefined;
  }
  for (const coding of concept.coding) {
    if (coding.code) {
      return coding;
    }
  }
  return undefined;
}

function selectPreferredSiteCoding(site: FhirCodeableConcept | undefined): CodeableConceptCoding | undefined {
  if (!site?.coding?.length) {
    return undefined;
  }
  for (const coding of site.coding) {
    if (coding.system === SNOMED_SYSTEM && coding.code) {
      return coding;
    }
  }
  return selectFirstCodingWithCode(site);
}

type CanonicalSite = NonNullable<CanonicalSigClause["site"]>;

function selectCanonicalSiteCoding(
  site: CanonicalSite | undefined,
  options?: FhirProjectionOptions
): CanonicalSite["coding"] | undefined {
  if (options?.bodySitePostcoordination === false) {
    return site?.coding;
  }
  const postcoordinated = buildBodySiteTopographicalModifierCoding(
    site?.spatialRelation,
    site?.text,
    { postcoordination: true }
  );
  return options?.bodySitePostcoordination === true
    ? postcoordinated ?? site?.coding
    : site?.coding ?? postcoordinated;
}

function buildSiteCodingArray(
  siteCoding: CanonicalSite["coding"] | undefined
): CodeableConceptCoding[] | undefined {
  if (!siteCoding?.code) {
    return undefined;
  }
  return [
    {
      system: siteCoding.system ?? SNOMED_SYSTEM,
      code: siteCoding.code,
      display: siteCoding.display
    }
  ];
}

function buildFhirDoseRange(range: CanonicalDoseRange, unit: string | undefined): FhirRange | undefined {
  const fhirRange: FhirRange = {};

  if (range.low !== undefined) {
    fhirRange.low = {
      value: range.low,
      unit
    };
  }
  if (range.high !== undefined) {
    fhirRange.high = {
      value: range.high,
      unit
    };
  }

  if (!fhirRange.low && !fhirRange.high) {
    return undefined;
  }

  return fhirRange;
}

function describeDurationUnit(unit: FhirPeriodUnit, value: number | undefined): string {
  const plural = value !== 1;
  switch (unit) {
    case FhirPeriodUnit.Second:
      return plural ? "seconds" : "second";
    case FhirPeriodUnit.Minute:
      return plural ? "minutes" : "minute";
    case FhirPeriodUnit.Hour:
      return plural ? "hours" : "hour";
    case FhirPeriodUnit.Day:
      return plural ? "days" : "day";
    case FhirPeriodUnit.Week:
      return plural ? "weeks" : "week";
    case FhirPeriodUnit.Month:
      return plural ? "months" : "month";
    case FhirPeriodUnit.Year:
      return plural ? "years" : "year";
    default:
      return unit;
  }
}

function buildFhirDurationQuantity(value: number, unit: FhirPeriodUnit): FhirQuantity {
  return {
    value,
    unit: describeDurationUnit(unit, value),
    system: UCUM_SYSTEM,
    code: unit
  };
}

function buildFhirBoundsRange(
  low: number,
  high: number,
  unit: FhirPeriodUnit
): FhirRange {
  return {
    low: buildFhirDurationQuantity(low, unit),
    high: buildFhirDurationQuantity(high, unit)
  };
}

function parseFhirDurationUnit(quantity: FhirQuantity | undefined): FhirPeriodUnit | undefined {
  const candidate = quantity?.code?.trim().toLowerCase() ?? quantity?.unit?.trim().toLowerCase();
  switch (candidate) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return FhirPeriodUnit.Second;
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return FhirPeriodUnit.Minute;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return FhirPeriodUnit.Hour;
    case "d":
    case "day":
    case "days":
      return FhirPeriodUnit.Day;
    case "wk":
    case "wks":
    case "week":
    case "weeks":
      return FhirPeriodUnit.Week;
    case "mo":
    case "month":
    case "months":
      return FhirPeriodUnit.Month;
    case "a":
    case "yr":
    case "yrs":
    case "year":
    case "years":
      return FhirPeriodUnit.Year;
    default:
      return undefined;
  }
}

function extractCanonicalTimingBounds(
  repeat: FhirTimingRepeat | undefined
): { duration?: number; durationMax?: number; durationUnit?: FhirPeriodUnit; warning?: string } {
  if (!repeat) {
    return {};
  }

  if (repeat.boundsDuration?.value !== undefined) {
    const durationUnit = parseFhirDurationUnit(repeat.boundsDuration);
    if (!durationUnit) {
      return {};
    }
    return {
      duration: repeat.boundsDuration.value,
      durationUnit
    };
  }

  if (!repeat.boundsRange) {
    return {};
  }

  const low = repeat.boundsRange.low;
  const high = repeat.boundsRange.high;
  const lowUnit = parseFhirDurationUnit(low);
  const highUnit = parseFhirDurationUnit(high);
  const durationUnit = lowUnit ?? highUnit;
  if (!durationUnit) {
    return {};
  }

  let warning: string | undefined;
  if (lowUnit && highUnit && lowUnit !== highUnit) {
    warning = `FHIR timing boundsRange low/high units differ (${lowUnit} vs ${highUnit}); preserved numeric bounds using ${durationUnit}.`;
  }

  return {
    duration: low?.value,
    durationMax: high?.value,
    durationUnit,
    warning
  };
}

function extractCanonicalDoseRange(
  range: FhirRange
): { range?: CanonicalDoseRange; unit?: string; warning?: string } {
  const canonicalRange: CanonicalDoseRange = {};
  const lowUnit = range.low?.unit;
  const highUnit = range.high?.unit;

  if (range.low?.value !== undefined) {
    canonicalRange.low = range.low.value;
  }
  if (range.high?.value !== undefined) {
    canonicalRange.high = range.high.value;
  }

  if (canonicalRange.low === undefined && canonicalRange.high === undefined) {
    return {};
  }

  const unit = lowUnit ?? highUnit;
  let warning: string | undefined;
  if (lowUnit && highUnit && lowUnit !== highUnit) {
    warning = `FHIR doseRange low/high units differ (${lowUnit} vs ${highUnit}); preserved numeric bounds using ${unit}.`;
  }

  return {
    range: canonicalRange,
    unit,
    warning
  };
}

function appendWarning(warnings: string[] | undefined, warning: string | undefined): string[] | undefined {
  if (!warning) {
    return warnings;
  }
  if (!warnings) {
    return [warning];
  }
  warnings.push(warning);
  return warnings;
}

export function canonicalToFhir(
  clause: CanonicalSigClause,
  textOverride?: string,
  options?: FhirProjectionOptions
): FhirDosage {
  const dosage: FhirDosage = {};
  const repeat: FhirTimingRepeat = {};
  let hasRepeat = false;
  const schedule = clause.schedule;

  if (schedule?.frequency !== undefined) {
    repeat.frequency = schedule.frequency;
    hasRepeat = true;
  }
  if (schedule?.count !== undefined) {
    repeat.count = schedule.count;
    hasRepeat = true;
  }
  if (schedule?.duration !== undefined && schedule.durationUnit) {
    if (schedule.durationMax !== undefined && schedule.durationMax !== schedule.duration) {
      repeat.boundsRange = buildFhirBoundsRange(
        schedule.duration,
        schedule.durationMax,
        schedule.durationUnit
      );
    } else {
      repeat.boundsDuration = buildFhirDurationQuantity(schedule.duration, schedule.durationUnit);
    }
    hasRepeat = true;
  }
  if (schedule?.frequencyMax !== undefined) {
    repeat.frequencyMax = schedule.frequencyMax;
    hasRepeat = true;
  }
  if (schedule?.period !== undefined && schedule.periodUnit) {
    repeat.period = schedule.period;
    repeat.periodUnit = schedule.periodUnit;
    hasRepeat = true;
  }
  if (schedule?.periodMax !== undefined) {
    repeat.periodMax = schedule.periodMax;
    hasRepeat = true;
  }
  if (schedule?.dayOfWeek?.length) {
    repeat.dayOfWeek = [...schedule.dayOfWeek];
    hasRepeat = true;
  }
  if (schedule?.when?.length) {
    repeat.when = [...schedule.when];
    hasRepeat = true;
  }
  if (schedule?.timeOfDay?.length) {
    repeat.timeOfDay = [...schedule.timeOfDay];
    hasRepeat = true;
  }

  if (hasRepeat) {
    dosage.timing = { repeat };
  }

  if (schedule?.timingCode) {
    dosage.timing = dosage.timing ?? {};
    dosage.timing.code = {
      coding: [{ code: schedule.timingCode }],
      text: schedule.timingCode
    };
  }

  if (clause.dose?.range) {
    const doseRange = buildFhirDoseRange(clause.dose.range, clause.dose.unit);
    if (doseRange) {
      dosage.doseAndRate = [
        {
          doseRange
        }
      ];
    }
  } else if (clause.dose?.value !== undefined) {
    dosage.doseAndRate = [
      {
        doseQuantity: {
          value: clause.dose.value,
          unit: clause.dose.unit
        }
      }
    ];
  }

  if (clause.route?.code || clause.route?.text) {
    const routeCode = clause.route?.code;
    const coding = routeCode ? ROUTE_SNOMED[routeCode] : undefined;
    const text = clause.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined);

    if (coding) {
      dosage.route = {
        text,
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: coding.code,
            display: coding.display
          }
        ]
      };
    } else if (text) {
      dosage.route = { text };
    }
  }

  if (clause.site?.text || clause.site?.coding?.code || clause.site?.spatialRelation) {
    const siteCoding = selectCanonicalSiteCoding(clause.site, options);
    dosage.site = {
      text: clause.site?.text,
      coding: buildSiteCodingArray(siteCoding),
      extension: buildBodySiteSpatialRelationExtensions(clause.site?.spatialRelation)
    };
  }

  if (clause.method?.text || clause.method?._text || clause.method?.coding?.code) {
    dosage.method = {
      text: clause.method?.text,
      _text: clonePrimitiveElement(clause.method?._text),
      coding: clause.method?.coding?.code
        ? [
          {
            system: clause.method.coding.system ?? SNOMED_SYSTEM,
            code: clause.method.coding.code,
            display: clause.method.coding.display,
            _display: clonePrimitiveElement(clause.method.coding._display)
          }
        ]
        : undefined
    };
  }

  if (clause.additionalInstructions?.length) {
    dosage.additionalInstruction = [];
    for (const instruction of clause.additionalInstructions) {
      dosage.additionalInstruction.push({
        text: instruction.text,
        coding: instruction.coding?.code
          ? [
            {
              system: instruction.coding.system ?? SNOMED_SYSTEM,
              code: instruction.coding.code,
              display: instruction.coding.display
            }
          ]
          : undefined
      });
    }
  }

  if (clause.prn?.enabled) {
    dosage.asNeededBoolean = true;
    const reasons = clause.prn.reasons?.length ? clause.prn.reasons : clause.prn.reason ? [clause.prn.reason] : [];
    if (reasons.length) {
      dosage.asNeededFor = [];
      for (const reason of reasons) {
        const concept: FhirCodeableConcept = {};
        if (reason.text) {
          concept.text = reason.text;
        }
        if (reason.coding?.code) {
          concept.coding = [
            {
              system: reason.coding.system ?? SNOMED_SYSTEM,
              code: reason.coding.code,
              display: reason.coding.display,
              extension: cloneExtensions(reason.coding.extension)
            }
          ];
        }
        concept.extension = buildBodySiteSpatialRelationExtensions(reason.spatialRelation);
        dosage.asNeededFor.push(concept);
      }
    }
  }

  const longText = textOverride ?? formatCanonicalClause(clause, "long");
  if (longText) {
    dosage.text = longText;
  }
  if (clause.patientInstruction) {
    dosage.patientInstruction = clause.patientInstruction;
  }

  return dosage;
}

export function toFhir(state: ParserState): FhirDosage {
  const clauses = state.clauses;
  const clause = clauses[0] ?? createEmptyCanonicalClause(state.input);
  return canonicalToFhir(clause);
}

export function canonicalFromFhir(dosage: FhirDosage): CanonicalSigClause {
  const rawText = dosage.text ?? "";
  const clause = createEmptyCanonicalClause(rawText);
  let routeCode: RouteCode | undefined;

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    routeCode = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
  }
  if (routeCode || dosage.route?.text) {
    clause.route = {
      code: routeCode,
      text: dosage.route?.text ?? (routeCode ? ROUTE_TEXT[routeCode] : undefined)
    };
  }

  const siteCoding = selectPreferredSiteCoding(dosage.site);
  const siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  const siteText = dosage.site?.text ?? (
    siteCoding?.code
      ? getBodySiteText({
        system: siteCoding.system,
        code: siteCoding.code,
        display: siteCoding.display
      })
      : undefined
  );
  if (siteText || siteCoding?.code || siteSpatialRelation) {
    clause.site = {
      text: siteText,
      spatialRelation: siteSpatialRelation,
      coding: siteCoding?.code
        ? {
          code: siteCoding.code,
          display: siteCoding.display,
          system: siteCoding.system
        }
        : undefined,
      source: "text"
    };
  }

  const methodCoding = selectFirstCodingWithCode(dosage.method);
  if (dosage.method?.text || dosage.method?._text || methodCoding?.code) {
    clause.method = {
      text: dosage.method?.text,
      _text: clonePrimitiveElement(dosage.method?._text),
      coding: methodCoding?.code
        ? {
          code: methodCoding.code,
          display: methodCoding.display,
          system: methodCoding.system,
          _display: clonePrimitiveElement(methodCoding._display)
        }
        : undefined
    };
  }

  const repeat = dosage.timing?.repeat;
  const timingBounds = extractCanonicalTimingBounds(repeat);
  if (
    dosage.timing?.code?.coding?.[0]?.code ||
    repeat?.count !== undefined ||
    repeat?.boundsDuration ||
    repeat?.boundsRange ||
    repeat?.frequency !== undefined ||
    repeat?.frequencyMax !== undefined ||
    repeat?.period !== undefined ||
    repeat?.periodMax !== undefined ||
    repeat?.periodUnit ||
    repeat?.dayOfWeek?.length ||
    repeat?.when?.length ||
    repeat?.timeOfDay?.length
  ) {
    clause.schedule = {
      timingCode: dosage.timing?.code?.coding?.[0]?.code,
      count: repeat?.count,
      duration: timingBounds.duration,
      durationMax: timingBounds.durationMax,
      durationUnit: timingBounds.durationUnit,
      frequency: repeat?.frequency,
      frequencyMax: repeat?.frequencyMax,
      period: repeat?.period,
      periodMax: repeat?.periodMax,
      periodUnit: repeat?.periodUnit,
      dayOfWeek: repeat?.dayOfWeek ? [...repeat.dayOfWeek] : undefined,
      when: repeat?.when ? [...repeat.when] : undefined,
      timeOfDay: repeat?.timeOfDay ? [...repeat.timeOfDay] : undefined
    };
    clause.warnings = appendWarning(clause.warnings, timingBounds.warning);
  }

  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      clause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      clause.warnings = appendWarning(clause.warnings, extracted.warning);
    }
  } else if (doseAndRate?.doseQuantity?.value !== undefined) {
    clause.dose = {
      value: doseAndRate.doseQuantity.value,
      unit: doseAndRate.doseQuantity.unit
    };
  }

  const prnReasons = dosage.asNeededFor?.length
    ? dosage.asNeededFor.map((concept) => {
      const coding = concept.coding?.find((code) => Boolean(code.code));
      return {
        text: concept.text,
        spatialRelation: parseBodySiteSpatialRelationExtension(concept),
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            extension: cloneExtensions(coding.extension)
          }
          : undefined
      };
    })
    : undefined;
  const primaryReason = prnReasons?.[0];
  if (dosage.asNeededBoolean || primaryReason?.text || primaryReason?.coding?.code) {
    clause.prn = {
      enabled: Boolean(dosage.asNeededBoolean || primaryReason?.text || primaryReason?.coding?.code),
      reason:
        prnReasons?.length === 1
          ? primaryReason
          : prnReasons?.length
            ? { text: joinCanonicalPrnReasonTexts(prnReasons) }
            : undefined,
      reasons: prnReasons?.length ? prnReasons : undefined
    };
  }

  if (dosage.additionalInstruction?.length) {
    clause.additionalInstructions = [];
    for (const instruction of dosage.additionalInstruction) {
      const coding = instruction.coding?.find((code) => Boolean(code.code));
      clause.additionalInstructions.push({
        text: instruction.text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system
          }
          : undefined,
        frames: coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            instruction.text ?? coding.display ?? "",
            clause.raw
          )
          : undefined
      });
    }
  }

  if (dosage.patientInstruction) {
    clause.patientInstruction = dosage.patientInstruction;
  }

  return clause;
}

export function parserStateFromFhir(dosage: FhirDosage): ParserState {
  const state = new ParserState(dosage.text ?? "", []);
  const timingBounds = extractCanonicalTimingBounds(dosage.timing?.repeat);
  state.timeOfDay = dosage.timing?.repeat?.timeOfDay
    ? [...dosage.timing.repeat.timeOfDay]
    : [];
  state.timingCode = dosage.timing?.code?.coding?.[0]?.code;
  state.count = dosage.timing?.repeat?.count;
  state.duration = timingBounds.duration;
  state.durationMax = timingBounds.durationMax;
  state.durationUnit = timingBounds.durationUnit;
  state.frequency = dosage.timing?.repeat?.frequency;
  state.frequencyMax = dosage.timing?.repeat?.frequencyMax;
  state.period = dosage.timing?.repeat?.period;
  state.periodMax = dosage.timing?.repeat?.periodMax;
  state.periodUnit = dosage.timing?.repeat?.periodUnit;
  state.routeText = dosage.route?.text;
  const siteCoding = selectPreferredSiteCoding(dosage.site);
  state.siteText = dosage.site?.text ?? (
    siteCoding?.code
      ? getBodySiteText({
        system: siteCoding.system,
        code: siteCoding.code,
        display: siteCoding.display
      })
      : undefined
  );
  state.siteSpatialRelation = parseBodySiteSpatialRelationExtension(dosage.site);
  state.methodText = dosage.method?.text;
  state.methodTextElement = clonePrimitiveElement(dosage.method?._text);
  state.patientInstruction = dosage.patientInstruction;
  state.asNeeded = dosage.asNeededBoolean;
  if (dosage.asNeededFor?.length) {
    const prnReasons = dosage.asNeededFor.map((concept) => {
      const coding = selectFirstCodingWithCode(concept);
      return {
        text: concept.text,
        spatialRelation: parseBodySiteSpatialRelationExtension(concept),
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            extension: cloneExtensions(coding.extension),
            _display: clonePrimitiveElement(coding._display)
          }
          : undefined
      };
    });
    state.asNeededReasons = prnReasons;
    state.asNeededReason = joinCanonicalPrnReasonTexts(prnReasons);
  }

  if (dosage.timing?.repeat?.dayOfWeek) {
    state.dayOfWeek.push(...dosage.timing.repeat.dayOfWeek);
  }
  if (dosage.timing?.repeat?.when) {
    const whenValues = dosage.timing.repeat.when.filter((value): value is EventTiming =>
      arrayIncludes(
        objectValues(EventTiming) as EventTiming[],
        value as EventTiming
      )
    );
    state.when.push(...whenValues);
  }

  const routeCoding = dosage.route?.coding?.find((code) => code.system === SNOMED_SYSTEM);
  if (routeCoding?.code) {
    // Translate SNOMED codings back into the simplified enum for round-trip fidelity.
    const mapped = ROUTE_BY_SNOMED[routeCoding.code as SNOMEDCTRouteCodes];
    if (mapped) {
      state.routeCode = mapped;
      state.routeText = ROUTE_TEXT[mapped];
    }
  }

  if (siteCoding?.code) {
    state.siteCoding = {
      code: siteCoding.code,
      display: siteCoding.display,
      system: siteCoding.system
    };
    state.siteSource = "text";
  } else if (dosage.site?.text) {
    state.siteSource = "text";
  }

  const methodCoding = selectFirstCodingWithCode(dosage.method);
  if (methodCoding?.code) {
    state.methodCoding = {
      code: methodCoding.code,
      display: methodCoding.display,
      system: methodCoding.system,
      _display: clonePrimitiveElement(methodCoding._display)
    };
  }

  if (dosage.asNeededFor?.length === 1) {
    const reasonCoding = selectFirstCodingWithCode(dosage.asNeededFor[0]);
    if (reasonCoding?.code) {
      const defaultDef = findPrnReasonDefinitionByCoding(
        reasonCoding.system ?? SNOMED_SYSTEM,
        reasonCoding.code
      );
      state.asNeededReasonCoding = {
        code: reasonCoding.code,
        display: reasonCoding.display,
        system: reasonCoding.system,
        i18n: defaultDef?.i18n
      };
    }
  }

  if (dosage.additionalInstruction?.length) {
    state.additionalInstructions = dosage.additionalInstruction.map((concept) => {
      const coding = selectFirstCodingWithCode(concept);
      const defaultDef = coding?.code
        ? findAdditionalInstructionDefinitionByCoding(
          coding.system ?? SNOMED_SYSTEM,
          coding.code
        )
        : undefined;

      return {
        text: concept.text,
        coding: coding?.code
          ? {
            code: coding.code,
            display: coding.display,
            system: coding.system,
            i18n: defaultDef?.i18n
          }
          : undefined,
        frames: coding?.code
          ? buildAdditionalInstructionFramesFromCoding(
            coding.system ?? SNOMED_SYSTEM,
            coding.code,
            concept.text ?? coding.display ?? "",
            { start: 0, end: (concept.text ?? coding.display ?? "").length }
          )
          : undefined
      };
    });
  }

  if (timingBounds.warning) {
    const nextWarnings = appendWarning(state.warnings, timingBounds.warning);
    if (nextWarnings) {
      state.warnings = nextWarnings;
    }
  }


  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const extracted = extractCanonicalDoseRange(doseAndRate.doseRange);
    if (extracted.range) {
      state.primaryClause.dose = {
        range: extracted.range,
        unit: extracted.unit
      };
      state.warnings = appendWarning(state.warnings, extracted.warning) ?? state.warnings;
    }
  } else if (doseAndRate?.doseQuantity) {
    const dose = doseAndRate.doseQuantity;
    if (dose.value !== undefined) {
      state.dose = dose.value;
    }
    if (dose.unit) {
      state.unit = dose.unit;
    }
  }

  return state;
}
