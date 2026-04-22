import {
  buildAdditionalInstructionFramesFromCoding,
  findAdditionalInstructionDefinitionByCoding
} from "./advice";
import { formatCanonicalClause } from "./format";
import { buildCanonicalSigClauses } from "./ir";
import { ParserState } from "./parser-state";
import {
  ROUTE_BY_SNOMED,
  ROUTE_SNOMED,
  ROUTE_TEXT,
  findPrnReasonDefinitionByCoding
} from "./maps";
import {
  CanonicalSigClause,
  EventTiming,
  FhirCodeableConcept,
  FhirDosage,
  FhirTimingRepeat,
  RouteCode,
  SNOMEDCTRouteCodes
} from "./types";
import { objectValues } from "./utils/object";
import { arrayIncludes } from "./utils/array";

const SNOMED_SYSTEM = "http://snomed.info/sct";
type CodeableConceptCoding = NonNullable<FhirCodeableConcept["coding"]>[number];

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

export function canonicalToFhir(
  clause: CanonicalSigClause,
  textOverride?: string
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
  } else {
    dosage.timing = {};
  }

  if (schedule?.timingCode) {
    dosage.timing = dosage.timing ?? {};
    dosage.timing.code = {
      coding: [{ code: schedule.timingCode }],
      text: schedule.timingCode
    };
  }

  if (clause.dose?.range) {
    dosage.doseAndRate = [
      {
        doseRange: {
          low: { value: clause.dose.range.low, unit: clause.dose.unit },
          high: { value: clause.dose.range.high, unit: clause.dose.unit }
        }
      }
    ];
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

  if (clause.site?.text || clause.site?.coding?.code) {
    const coding = clause.site?.coding?.code
      ? [
        {
          system: clause.site.coding.system ?? SNOMED_SYSTEM,
          code: clause.site.coding.code,
          display: clause.site.coding.display
        }
      ]
      : undefined;
    dosage.site = {
      text: clause.site?.text,
      coding
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
    if (clause.prn.reason?.text || clause.prn.reason?.coding?.code) {
      const concept: FhirCodeableConcept = {};
      if (clause.prn.reason?.text) {
        concept.text = clause.prn.reason.text;
      }
      if (clause.prn.reason?.coding?.code) {
        concept.coding = [
          {
            system: clause.prn.reason.coding.system ?? SNOMED_SYSTEM,
            code: clause.prn.reason.coding.code,
            display: clause.prn.reason.coding.display
          }
        ];
      }
      dosage.asNeededFor = [concept];
    }
  }

  const longText = textOverride ?? formatCanonicalClause(clause, "long");
  if (longText) {
    dosage.text = longText;
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
  if (dosage.site?.text || siteCoding?.code) {
    clause.site = {
      text: dosage.site?.text,
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

  const repeat = dosage.timing?.repeat;
  if (
    dosage.timing?.code?.coding?.[0]?.code ||
    repeat?.count !== undefined ||
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
      frequency: repeat?.frequency,
      frequencyMax: repeat?.frequencyMax,
      period: repeat?.period,
      periodMax: repeat?.periodMax,
      periodUnit: repeat?.periodUnit,
      dayOfWeek: repeat?.dayOfWeek ? [...repeat.dayOfWeek] : undefined,
      when: repeat?.when ? [...repeat.when] : undefined,
      timeOfDay: repeat?.timeOfDay ? [...repeat.timeOfDay] : undefined
    };
  }

  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const low = doseAndRate.doseRange.low?.value;
    const high = doseAndRate.doseRange.high?.value;
    if (low !== undefined && high !== undefined) {
      clause.dose = {
        range: { low, high },
        unit: doseAndRate.doseRange.low?.unit ?? doseAndRate.doseRange.high?.unit
      };
    }
  } else if (doseAndRate?.doseQuantity?.value !== undefined) {
    clause.dose = {
      value: doseAndRate.doseQuantity.value,
      unit: doseAndRate.doseQuantity.unit
    };
  }

  const reasonCoding = dosage.asNeededFor?.[0]?.coding?.find((code) => Boolean(code.code));
  if (dosage.asNeededBoolean || dosage.asNeededFor?.[0]?.text || reasonCoding?.code) {
    clause.prn = {
      enabled: Boolean(dosage.asNeededBoolean || dosage.asNeededFor?.[0]?.text || reasonCoding?.code),
      reason:
        dosage.asNeededFor?.[0]?.text || reasonCoding?.code
          ? {
            text: dosage.asNeededFor?.[0]?.text,
            coding: reasonCoding?.code
              ? {
                code: reasonCoding.code,
                display: reasonCoding.display,
                system: reasonCoding.system
              }
              : undefined
          }
          : undefined
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

  return clause;
}

export function parserStateFromFhir(dosage: FhirDosage): ParserState {
  const state = new ParserState(dosage.text ?? "", []);
  state.timeOfDay = dosage.timing?.repeat?.timeOfDay
    ? [...dosage.timing.repeat.timeOfDay]
    : [];
  state.timingCode = dosage.timing?.code?.coding?.[0]?.code;
  state.count = dosage.timing?.repeat?.count;
  state.frequency = dosage.timing?.repeat?.frequency;
  state.frequencyMax = dosage.timing?.repeat?.frequencyMax;
  state.period = dosage.timing?.repeat?.period;
  state.periodMax = dosage.timing?.repeat?.periodMax;
  state.periodUnit = dosage.timing?.repeat?.periodUnit;
  state.routeText = dosage.route?.text;
  state.siteText = dosage.site?.text;
  state.asNeeded = dosage.asNeededBoolean;
  state.asNeededReason = dosage.asNeededFor?.[0]?.text;

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

  const siteCoding = selectPreferredSiteCoding(dosage.site);
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

  const reasonCoding = selectFirstCodingWithCode(dosage.asNeededFor?.[0]);
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


  const doseAndRate = dosage.doseAndRate?.[0];
  if (doseAndRate?.doseRange) {
    const { low, high } = doseAndRate.doseRange;
    if (low?.value !== undefined && high?.value !== undefined) {
      state.doseRange = { low: low.value, high: high.value };
    }
    state.unit = low?.unit ?? high?.unit ?? state.unit;
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
