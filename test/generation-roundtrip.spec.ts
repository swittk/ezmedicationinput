import { describe,expect,it } from "vitest";
import { courseToR6,R5_SOURCE_ONLY_MAXIMUM_URL } from "../src/adapters/canonical-course";
import { courseFromR5 } from "../src/adapters/r5-course";
import { R6_DRAFT_STEPS_SOURCE_URL,R6_SCOPED_SAFETY_MODIFIER_URL,R6_SINGLE_STEP_SAFETY_SOURCE_URL } from "../src/adapters/canonical-course";
import { conditionToR6,COURSE_CYCLE_COUNT_EXTENSION_URL,decodeR5RetainedFields,decodeR6SourceMetadata,DOSAGE_ALTERNATIVE_CHOICE_URL,DOSAGE_CONDITION_R5_URL,DOSAGE_DETAILS_R5_URL,DOSAGE_EXCLUDED_DATES_R5_URL,DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,DOSAGE_RECONCILIATION_SOURCE_URL,DOSAGE_RENDERED_INSTRUCTION_R5_URL,DOSAGE_RETAINED_R5_SEQUENCE_URL,dosageMatchesSavedProjection,encodeR5RetainedFields,encodeR6SourceMetadata,getCourseCycleCount,getDosageCalendarDayCondition,getDosageCondition,getDosageExcludedDates,isExactConditionBridge,PARALLEL_COMPONENT_PHASE_ORIGIN_URL,R5_RATE_MODIFIERS_R6_URL,readRetainedField,retainField,setDosageCondition,setDosageExcludedDates,setDosageExcludedWeekdays,sourceWithoutNestedHistory,toEzDosages,withDosageEditProvenance } from "../src/dosage-course";
import { ADMINISTRATION_OFFSET_EXTENSION_URL,ANCHORED_COURSE_DURATION_EXTENSION_URL,canonicalFromFhir,canonicalToFhir,CYCLE_DAY_ELIGIBILITY_EXTENSION_URL,getAnchoredCourseDuration,getTimingClocks,PRN_TRIGGER_PHASE_EXTENSION_URL,TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,TIMING_DAY_OF_MONTH_EXTENSION_URL,TIMING_FREQUENCY_MIN_EXTENSION_URL,TIMING_OFFSET_EXACT_EXTENSION_URL,TIMING_OFFSET_MAX_EXTENSION_URL,TIMING_OFFSET_MIN_EXTENSION_URL } from "../src/fhir";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL,EMA_QUANTITY_OPERATOR_SYSTEM,getQuantityComparator,QUANTITY_OPERATOR_SOURCE_URL,quantityForR5,quantityFromR5,simpleQuantityForR5 } from "../src/fhir-quantity-operator";
import { AdviceArgumentRole,AdviceForce,AdvicePolarity,buildInstructionGraphExtension,calculateTotalUnits,EventTiming,FhirDayOfWeek,FhirPeriodUnit,formatCanonicalAdministration,formatCanonicalCourse,formatParseBatch,formatSig,formatSigBatch,fromDosageDetails,fromFhir,fromFhirDosage,getMedicationInstructionAction,importCanonicalCourse,nextDueDoses,parseInstructionGraphExtension,parseSig as parsePublicSig,projectCanonicalCourse,toDosageDetails,toFhirR5Dosages,type CanonicalInstructionGraph,type EzDosage,type FhirDosage,type FhirElement,type FhirExtension,type FhirR6Dosage,type FhirR6DosageCondition,type FhirR6DosageInstructionInput,type FhirR6DosageStep,type FhirR6Quantity,type FhirR6Timing,type FhirRatio } from "../src/index";
import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import type { AdviceArgument,AdviceFrame,CanonicalSigClause,FhirCoding,FhirR6Coding,FhirR6DosageInstruction,FhirR6Extension,FhirR6Range } from "../src/types";
import { type FhirR6DosageSafety,type FhirR6DoseLimit,type FormatOptions,type ParseOptions } from "../src/types";
import { convertQuantityValue } from "../src/utils/units";
import crossLanguageCases from "./generation-cross-language-cases.json";
import cases from "./generation-roundtrip-cases.json";
import thaiCases from "./generation-roundtrip-thai-cases.json";
import { parseSig } from "./helpers/r5-parser";
type Result = ReturnType<typeof parseSig>;

function expectActiveMixedDuration(row: FhirDosage | FhirR6Dosage, expected: FhirR6Range): void {
  const core = row.timing?.repeat?.boundsRange;
  expect(core?.low ?? core?.high).toBeDefined();
  if (core?.low && core.high) {
    expect(core.low.unit).toBe(core.high.unit);
    expect(core.low.code).toBe(core.high.code);
    expect(core.low.system).toBe(core.high.system);
  }
  const marker = row.modifierExtension?.find(item => item.url === ANCHORED_COURSE_DURATION_EXTENSION_URL);
  expect(marker).toBeDefined();
  expect(marker?.extension?.some(item => item.url === "projectedRange")).not.toBe(true);
  for (const endpoint of ["low", "high"] as const) {
    if (core?.[endpoint]) expect(core[endpoint]).toEqual(expected[endpoint]);
    expect(core?.[endpoint]?.comparator).toBeUndefined();
    expect(core?.[endpoint]?._comparator).toBeUndefined();
    expect(marker?.extension?.find(item => item.url === endpoint)?.valueQuantity).toEqual(expected[endpoint]);
  }
  expect(getAnchoredCourseDuration(row)?.valueRange).toEqual(expected);
}

const text = (v: unknown) => String(v ?? "").toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
const key = (concept: any) => {
  const coding = concept?.coding?.[0];
  return coding?.code ? `${coding.system ?? ""}|${coding.code}` : text(concept?.text);
};
const q = (value: any) => value ? { value: value.value, unit: value.unit } : undefined;

function dose(result: Result): unknown {
  const entry = result.fhir.doseAndRate?.[0];
  if (entry?.doseQuantity) return { quantity: q(entry.doseQuantity) };
  if (entry?.doseRange) return { range: { low: q(entry.doseRange.low), high: q(entry.doseRange.high) } };
  return undefined;
}

function schedule(clause: CanonicalSigClause | undefined): unknown {
  const s = clause?.schedule;
  if (!s) return undefined;
  const value = {
    count: s.count, duration: s.duration, durationMax: s.durationMax, durationUnit: s.durationUnit,
    frequency: s.frequency, frequencyMax: s.frequencyMax, period: s.period, periodMax: s.periodMax,
    periodUnit: s.periodUnit, dayOfWeek: [...(s.dayOfWeek ?? [])].sort(),
    when: [...(s.when ?? [])].sort(), timeOfDay: [...(s.timeOfDay ?? [])].sort()
  };
  return (Object.keys(value) as (keyof typeof value)[]).some(name => {
    const item = value[name];
    return Array.isArray(item) ? item.length : item !== undefined;
  }) ? value : undefined;
}

function methodMatches(action: AdviceFrame, result: Result): boolean {
  const coding = result.fhir.method?.coding?.[0];
  if (coding?.code && action.predicate.codings?.some((candidate) =>
    candidate.code === coding.code &&
    (candidate.system ?? "http://snomed.info/sct") === (coding.system ?? "http://snomed.info/sct")
  )) return true;
  const method = text(result.fhir.method?.text);
  return Boolean(method && [action.predicate.lemma, action.predicate.display].map(text).filter(Boolean)
    .some((candidate) => candidate === method || method.includes(candidate) || candidate.includes(method)));
}

function amountCovered(arg: AdviceArgument, result: Result): boolean {
  if (!arg.quantity) return false;
  const entry = result.fhir.doseAndRate?.[0];
  if (entry?.doseQuantity) return arg.quantity.value === entry.doseQuantity.value && arg.quantity.unit === entry.doseQuantity.unit;
  if (entry?.doseRange) return arg.quantity.range?.low === entry.doseRange.low?.value &&
    arg.quantity.range?.high === entry.doseRange.high?.value && arg.quantity.unit === entry.doseRange.low?.unit;
  return false;
}

function siteCovered(arg: AdviceArgument, result: Result): boolean {
  const coding = result.fhir.site?.coding?.[0];
  if (coding?.code && arg.coding?.code === coding.code &&
      (arg.coding.system ?? "http://snomed.info/sct") === (coding.system ?? "http://snomed.info/sct")) return true;
  return Boolean(text(arg.normalized ?? arg.text) && text(arg.normalized ?? arg.text) === text(result.fhir.site?.text));
}

const FILLER = new Set("a an the medication medicine drug via route oral orally ophthalmic otic nasal intravitreal inhalation topical topically transdermal transdermally subcutaneous subcutaneously intramuscular intramuscularly intravenous intravenously rectal rectally vaginal vaginally once twice daily day per times".split(" "));
function freeCovered(arg: AdviceArgument, result: Result): boolean {
  if (arg.role !== "object" && arg.role !== "theme") return false;
  const words = text(arg.text).split(/\s+/).filter(Boolean);
  const timed = Boolean(result.meta.canonical.clauses[0]?.schedule);
  return words.length > 0 && words.every((word) => FILLER.has(word) || (timed && /^[0-9]+(?:\.[0-9]+)?$/.test(word)));
}

function fullyCanonical(action: AdviceFrame, result: Result): boolean {
  return action.polarity !== "negate" && methodMatches(action, result) && action.args.every((arg) =>
    (arg.role === "site" && siteCovered(arg, result)) ||
    (arg.role === "amount" && amountCovered(arg, result)) || freeCovered(arg, result)
  );
}

function argFingerprint(arg: AdviceArgument): unknown {
  const coding = arg.coding?.code ? `${arg.coding.system ?? ""}|${arg.coding.code}` : arg.conceptId;
  return {
    role: arg.role,
    coding,
    quantity: arg.quantity ? { value: arg.quantity.value, range: arg.quantity.range, unit: arg.quantity.unit } : undefined,
    text: !coding && !arg.quantity ? text(arg.normalized ?? arg.text) : undefined
  };
}

function graph(result: Result): unknown {
  const g = result.meta.canonical.clauses[0]?.instructionGraph;
  if (!g) return { actions: [], relations: [], opaque: [] };
  const actions = g.actions ?? [];
  let primary = -1;
  for (let i = 0; i < actions.length; i += 1) {
    if (methodMatches(actions[i], result)) {
      if (fullyCanonical(actions[i], result)) primary = i;
      break;
    }
  }
  const map = new Map<number, number>();
  const kept: unknown[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    if (i === primary) continue;
    map.set(i, kept.length);
    const a = actions[i];
    kept.push({
      predicate: a.predicate.lemma,
      polarity: a.polarity,
      modality: a.modality,
      relation: a.relation,
      args: a.args.map(argFingerprint)
    });
  }
  const relations = (g.relations ?? [])
    .filter((r) =>
      (r.fromActionIndex === undefined || map.has(r.fromActionIndex)) &&
      (r.toActionIndex === undefined || map.has(r.toActionIndex))
    )
    .map((r) => ({
      kind: r.kind,
      from: r.fromActionIndex === undefined ? undefined : map.get(r.fromActionIndex),
      to: r.toActionIndex === undefined ? undefined : map.get(r.toActionIndex),
      condition: r.fromActionIndex === undefined ? text(r.text) : undefined
    }));
  return {
    actions: kept,
    relations,
    opaque: (g.opaqueSpans ?? []).map((span) => text(span.text)).filter(Boolean)
  };
}

function graphRepresents(clause: CanonicalSigClause | undefined, value: string): boolean {
  const normalized = text(value);
  return Boolean(normalized && clause?.instructionGraph?.actions.some((action) => {
    const source = text(action.sourceText);
    return source && (source === normalized || source.includes(normalized) || normalized.includes(source));
  }));
}

function additional(result: Result): string[] {
  const clause = result.meta.canonical.clauses[0];
  return (result.fhir.additionalInstruction ?? [])
    .map((instruction) => {
      const coding = instruction.coding?.[0];
      if (coding?.code) return `${coding.system ?? ""}|${coding.code}`;
      const value = instruction.text ?? "";
      return graphRepresents(clause, value) ? undefined : text(value);
    })
    .filter((value): value is string => Boolean(value))
    .sort();
}

function fingerprint(result: Result): unknown {
  const clause = result.meta.canonical.clauses[0];
  return {
    method: key(result.fhir.method),
    route: key(result.fhir.route),
    site: key(result.fhir.site),
    dose: dose(result),
    schedule: schedule(clause),
    prn: result.fhir.asNeeded === true,
    reasons: (result.fhir.asNeededFor ?? []).map(key).sort(),
    additional: additional(result),
    graph: graph(result)
  };
}

describe("50-case human realization semantic round trip", () => {
  for (const [index, source] of cases.entries()) {
    it(`${index + 1}: ${source}`, () => {
      const parsed = parseSig(source);
      const realized = formatSig(parsed.fhir, "long", {
        locale: "en",
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: "en" });
      expect(fingerprint(reparsed)).toEqual(fingerprint(parsed));
    });
  }
});


describe("25-case Thai human realization semantic round trip", () => {
  for (const [index, source] of thaiCases.entries()) {
    it(`${index + 1}: ${source}`, () => {
      const parsed = parseSig(source, { locale: "th" });
      const realized = formatSig(parsed.fhir, "long", {
        locale: "th",
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: "th" });
      expect(fingerprint(reparsed)).toEqual(fingerprint(parsed));
    });
  }
});


const CROSS_SCOPE_RELATIONS = new Set([
  "before", "after", "during", "until", "if", "unless", "when", "while"
]);

function crossGraph(result: Result): unknown {
  const g = result.meta.canonical.clauses[0]?.instructionGraph;
  if (!g) return { actions: [], relations: [], opaqueCount: 0 };
  const actions = g.actions ?? [];
  let primary = -1;
  for (let index = 0; index < actions.length; index += 1) {
    if (!methodMatches(actions[index], result)) continue;
    if (fullyCanonical(actions[index], result)) primary = index;
    break;
  }
  const indexMap = new Map<number, number>();
  const kept: unknown[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    if (index === primary) continue;
    indexMap.set(index, kept.length);
    const action = actions[index];
    kept.push({
      predicate: action.predicate.lemma,
      polarity: action.polarity,
      modality: action.modality,
      relation: action.relation && CROSS_SCOPE_RELATIONS.has(action.relation)
        ? action.relation
        : undefined,
      args: action.args.map(argFingerprint)
    });
  }
  const relations = (g.relations ?? [])
    .filter((relation) =>
      (relation.fromActionIndex === undefined || indexMap.has(relation.fromActionIndex)) &&
      (relation.toActionIndex === undefined || indexMap.has(relation.toActionIndex))
    )
    .map((relation) => ({
      kind: relation.kind,
      from: relation.fromActionIndex === undefined ? undefined : indexMap.get(relation.fromActionIndex),
      to: relation.toActionIndex === undefined ? undefined : indexMap.get(relation.toActionIndex)
    }));
  return {
    actions: kept,
    relations,
    opaqueCount: g.opaqueSpans?.length ?? 0
  };
}

function crossFingerprint(result: Result): unknown {
  const clause = result.meta.canonical.clauses[0];
  return {
    method: key(result.fhir.method),
    route: key(result.fhir.route),
    site: key(result.fhir.site),
    dose: dose(result),
    schedule: schedule(clause),
    prn: result.fhir.asNeeded === true,
    reasons: (result.fhir.asNeededFor ?? []).map(key).sort(),
    additional: additional(result),
    graph: crossGraph(result)
  };
}

describe("12-case cross-language semantic realization", () => {
  for (const [index, value] of crossLanguageCases.entries()) {
    it(`${index + 1}: ${value.from}->${value.to}: ${value.source}`, () => {
      const parsed = parseSig(value.source, { locale: value.from });
      const realized = formatSig(parsed.fhir, "long", {
        locale: value.to,
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: value.to });
      expect(crossFingerprint(reparsed)).toEqual(crossFingerprint(parsed));
    });
  }
});


/**
 * A source-less FHIR import has to be intelligible without the original SIG.
 * These are independent future administrations, not parser-output snapshots:
 * verify dates, clock opportunities, unequal quantities, and supply as well
 * as the English/Thai text generated from R6 and its strict R5 bridge.
 */
describe("source-less multi-administration treatment course realization", () => {
  const relativeDay = (value: number) => ({
    contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event",
      code: "treatment-start"
    }] },
    offsetDuration: {
      value, code: "d", unit: "d", system: "http://unitsofmeasure.org"
    }
  });
  const clockDose = (quantity: number, times: string[]) => ({
    doseAndRate: [{ doseQuantity: { value: quantity, unit: "tablet" } }],
    timing: { repeat: { timeOfDay: times.map(time => time + ":00") } }
  });
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const dates = [
    "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"
  ];
  const dayClocks = (
    dosage: import("../src/types").FhirR6DosageInstruction |
      readonly import("../src/types").FhirDosage[], date: string
  ) => nextDueDoses(dosage, {
    orderedAt, from: date + "T00:00:00+07:00",
    timeZone: "Asia/Bangkok", limit: 48
  }).filter(value => value.startsWith(date)).map(value => value.slice(11, 16));
  const supply = (
    dosage: import("../src/types").FhirR6DosageInstruction |
      readonly import("../src/types").FhirDosage[]
  ) => calculateTotalUnits({
    dosage, orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
    durationValue: 28, durationUnit: FhirPeriodUnit.Day
  }).totalUnits;

  it("keeps three independent dated daily dose patterns human-readable and executable", () => {
    const course: import("../src/types").FhirR6DosageInstruction = {
      step: [
        {
          end: relativeDay(7),
          component: [
            clockDose(0.5, ["07:00"]),
            clockDose(1, ["12:00"]),
            clockDose(0.5, ["19:00"])
          ]
        },
        {
          start: relativeDay(7), end: relativeDay(14),
          component: [
            clockDose(1, ["07:00", "13:00", "19:00"]),
            clockDose(0.5, ["22:00"])
          ]
        },
        {
          start: relativeDay(14), end: relativeDay(21),
          component: [
            clockDose(1, ["07:00", "13:00"]),
            clockDose(0.5, ["19:00"])
          ]
        }
      ]
    };
    const rows = toFhirR5Dosages(course);
    const reopened = toDosageDetails(rows);
    expect(rows.map(row => row.sequence)).toEqual([1, 1, 1, 2, 2, 3, 3]);
    expect(course.step!.map(stage => stage.component.map(component =>
      component.doseAndRate?.[0]?.doseQuantity?.value
    ))).toEqual([[0.5, 1, 0.5], [1, 0.5], [1, 0.5]]);

    const expectedClocks = [
      ["07:00", "12:00", "19:00"],
      ["07:00", "13:00", "19:00", "22:00"],
      ["07:00", "13:00", "19:00"],
      []
    ];
    for (const dosage of [course, rows, reopened]) {
      expect(dates.map(date => dayClocks(dosage, date))).toEqual(expectedClocks);
      expect(supply(dosage)).toBe(56);
    }

    for (const representation of [course, reopened]) {
      const en = formatSig(representation, "long", { locale: "en" });
      const th = formatSig(representation, "long", { locale: "th" });
      for (const period of ["from treatment start until 7 days after treatment start", "from 7 days after treatment start until 14 days after treatment start", "from 14 days after treatment start until 21 days after treatment start"]) {
        expect(en.toLowerCase()).toContain(period);
      }
      for (const period of ["ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา", "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา", "ตั้งแต่14 วันหลังเริ่มการรักษาจนถึง21 วันหลังเริ่มการรักษา"]) {
        expect(th).toContain(period);
      }
      expect(en).toContain("0.5 tablet");
      expect(en).toContain("10:00 pm");
      expect(th).toContain("0.5 เม็ด");
      expect(th).toContain("22:00");
    }
    const strictR5Text = formatSigBatch(rows, "long", { locale: "en" });
    expect(strictR5Text.toLowerCase()).toContain("from 7 days after treatment start until 14 days after treatment start");
    expect(strictR5Text.toLowerCase()).toContain("from 14 days after treatment start until 21 days after treatment start");

    // Bind each independently specified dose/clock pattern to its own heading.
    // Global token presence also passes when two complete phases are swapped.
    for (const locale of ["en", "th"]) {
      const headings = locale === "en" ? [
        "From treatment start until 7 days after treatment start",
        "From 7 days after treatment start until 14 days after treatment start",
        "From 14 days after treatment start until 21 days after treatment start"
      ] : [
        "ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา",
        "ตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา",
        "ตั้งแต่14 วันหลังเริ่มการรักษาจนถึง21 วันหลังเริ่มการรักษา"
      ];
      const administrations = locale === "en" ? [
        ["Use 0.5 tablets at 7:00 am", "Use 1 tablet at 12:00 pm", "Use 0.5 tablets at 7:00 pm"],
        ["Use 1 tablet at 7:00 am, 1:00 pm, 7:00 pm", "Use 0.5 tablets at 10:00 pm"],
        ["Use 1 tablet at 7:00 am, 1:00 pm", "Use 0.5 tablets at 7:00 pm"]
      ] : [
        ["ใช้ครั้งละ 0.5 เม็ด เวลา 07:00", "ใช้ครั้งละ 1 เม็ด เวลา 12:00", "ใช้ครั้งละ 0.5 เม็ด เวลา 19:00"],
        ["ใช้ครั้งละ 1 เม็ด เวลา 07:00, 13:00, 19:00", "ใช้ครั้งละ 0.5 เม็ด เวลา 22:00"],
        ["ใช้ครั้งละ 1 เม็ด เวลา 07:00, 13:00", "ใช้ครั้งละ 0.5 เม็ด เวลา 19:00"]
      ];
      const previews = [
        formatSig(course, "long", { locale }), formatSig(reopened, "long", { locale }),
        formatSigBatch(rows, "long", { locale })
      ];
      for (const preview of previews) {
        const starts = headings.map(heading => preview.indexOf(heading + ": "));
        expect(starts[0]).toBe(0);
        expect(starts[1]).toBeGreaterThan(starts[0]);
        expect(starts[2]).toBeGreaterThan(starts[1]);
        headings.forEach((heading, index) => {
          const section = preview.slice(starts[index] + heading.length + 2,
            starts[index + 1] ?? preview.length).trim();
          expect(section).toBe(administrations[index].join("; ") + ".");
        });
      }
    }
  });

  it("exposes a full seven-day no-medication interval between complex schedules", () => {
    const course: import("../src/types").FhirR6DosageInstruction = {
      step: [
        {
          end: relativeDay(7),
          component: [
            clockDose(1, ["08:00"]),
            clockDose(0.5, ["12:00"]),
            clockDose(1, ["20:00"])
          ]
        },
        {
          start: relativeDay(14), end: relativeDay(21),
          component: [
            clockDose(0.5, ["08:00"]),
            clockDose(1, ["13:00"]),
            clockDose(1, ["20:00"])
          ]
        }
      ]
    };
    const rows = toFhirR5Dosages(course);
    const expectedClocks = [
      ["08:00", "12:00", "20:00"],
      [],
      ["08:00", "13:00", "20:00"],
      []
    ];
    for (const dosage of [course, rows, toDosageDetails(rows)]) {
      expect(dates.map(date => dayClocks(dosage, date))).toEqual(expectedClocks);
      expect(supply(dosage)).toBe(35);
    }
    for (const representation of [course, toDosageDetails(rows)]) {
      const en = formatSig(representation, "long", { locale: "en" });
      const th = formatSig(representation, "long", { locale: "th" });
      expect(en.toLowerCase()).toContain("from treatment start until 7 days after treatment start");
      expect(en.toLowerCase()).toContain("no doses from 7 days after treatment start until 14 days after treatment start");
      expect(en.toLowerCase()).toContain("from 14 days after treatment start until 21 days after treatment start");
      expect(th).toContain("ตั้งแต่เริ่มการรักษาจนถึง7 วันหลังเริ่มการรักษา");
      expect(th).toContain("งดยาตั้งแต่7 วันหลังเริ่มการรักษาจนถึง14 วันหลังเริ่มการรักษา");
      expect(th).toContain("ตั้งแต่14 วันหลังเริ่มการรักษาจนถึง21 วันหลังเริ่มการรักษา");
    }
    expect(formatSigBatch(rows, "long", { locale: "en" }).toLowerCase())
      .toContain("no doses from 7 days after treatment start until 14 days after treatment start");
  });

  it("renders calendar-bounded unequal clock dosages without original text", () => {
    const dosage: import("../src/types").FhirDosage[] = [
      {
        sequence: 1,
        ...clockDose(0.5, ["08:00"]),
        timing: { repeat: {
          timeOfDay: ["08:00:00"],
          boundsPeriod: { start: "2026-11-02", end: "2026-11-08" }
        } }
      },
      {
        sequence: 1,
        ...clockDose(1, ["20:00"]),
        timing: { repeat: {
          timeOfDay: ["20:00:00"],
          boundsPeriod: { start: "2026-11-02", end: "2026-11-08" }
        } }
      },
      {
        sequence: 2,
        ...clockDose(1, ["08:00"]),
        timing: { repeat: {
          timeOfDay: ["08:00:00"],
          boundsPeriod: { start: "2026-11-09", end: "2026-11-15" }
        } }
      },
      {
        sequence: 2,
        ...clockDose(2, ["20:00"]),
        timing: { repeat: {
          timeOfDay: ["20:00:00"],
          boundsPeriod: { start: "2026-11-09", end: "2026-11-15" }
        } }
      }
    ];
    const course = toDosageDetails(dosage);
    for (const representation of [dosage, course]) {
      expect(dates.map(date => dayClocks(representation, date))).toEqual([
        ["08:00", "20:00"], ["08:00", "20:00"], [], []
      ]);
      expect(supply(representation)).toBe(31.5);
    }
    const en = formatSigBatch(dosage, "long", { locale: "en" });
    const th = formatSigBatch(dosage, "long", { locale: "th" });
    const composed = formatSig(course, "long", { locale: "en" });
    for (const text of [en, composed]) {
      expect(text).toContain("2 Nov 2026");
      expect(text).toContain("9 Nov 2026");
      expect(text).toContain("2 tablets");
    }
    expect(th).toContain("2/11/2569");
    expect(th).toContain("9/11/2569");
    expect(th).toContain("2 เม็ด");
  });

  it("retains an unfamiliar modifier without inventing a warning or interpretation", () => {
    const modifier = {
      url: "https://example.org/fhir/StructureDefinition/opaque-medication-modifier",
      valueString: "uninterpreted external metadata"
    };
    const dosage: import("../src/types").FhirDosage = {
      ...clockDose(1, ["08:00"]),
      modifierExtension: [modifier]
    };
    const without = { ...dosage, modifierExtension: undefined };
    expect(formatSig(dosage, "long", { locale: "en" }))
      .toBe(formatSig(without, "long", { locale: "en" }));
    expect(fromFhirDosage(dosage).fhir.modifierExtension).toEqual([modifier]);
    expect(fromFhirDosage(dosage).warnings).toEqual([]);
  });
});

describe("round49 endpoint units and normalized conditions", () => {
  const cases: Array<{
    name: string;
    range: import("../src/types").FhirRange;
    short: [string, string];
    long: [string, string];
  }> = [
    { name: "authored upper endpoint", range: {
      low: { id: "unit-only-low", unit: "mg", _unit: { id: "low-unit" } },
      high: { id: "valued-high", value: 1, unit: "g", _unit: { id: "high-unit" },
        extension: [{ url: "urn:round49:quantity-note", valueString: "authored gram" }] }
    }, short: ["<=1 g", "<=1 g"], long: ["Use up to 1 g.", "ใช้ครั้งละ ไม่เกิน 1 g."] },
    { name: "coded upper endpoint", range: {
      low: { unit: "mg" }, high: { value: 1, code: "g", system: "http://unitsofmeasure.org" }
    }, short: ["<=1 g", "<=1 g"], long: ["Use up to 1 g.", "ใช้ครั้งละ ไม่เกิน 1 g."] },
    { name: "authored lower endpoint", range: {
      low: { value: 1, unit: "g" }, high: { unit: "mg" }
    }, short: [">=1 g", ">=1 g"], long: ["Use at least 1 g.", "ใช้ครั้งละ อย่างน้อย 1 g."] },
    { name: "same-unit endpoints", range: {
      low: { value: 1, unit: "mg" }, high: { value: 2, unit: "mg" }
    }, short: ["1-2 mg", "1-2 มก."], long: ["Use 1 to 2 mg.", "ใช้ครั้งละ 1 ถึง 2 มิลลิกรัม."] },
    { name: "independently valued endpoints", range: {
      low: { value: 1, unit: "mg" }, high: { value: 1, unit: "g" }
    }, short: ["Dose: 1 mg – 1 g", "ขนาดยาต่อครั้ง: 1 mg – 1 g"],
      long: ["Use; Dose: 1 mg – 1 g", "ใช้; ขนาดยาต่อครั้ง: 1 mg – 1 g"] }
  ];

  it.each(cases)("uses the valued unit without rewriting $name", ({ range, short, long }) => {
    const row: import("../src/types").FhirDosage = { doseAndRate: [{ doseRange: range }],
      extension: [{ url: "urn:round49:row-note", valueString: "preserve unrelated data" }] };
    const saved = JSON.stringify(row);
    for (const [index, locale] of ["en", "th"].entries()) {
      const options = { locale, realizationMode: "normalized" as const };
      expect(formatSig(row, "short", options)).toBe(short[index]);
      expect(formatSig(row, "long", options)).toBe(long[index]);
      const imported = fromFhirDosage(row, options);
      expect(imported.shortText).toBe(short[index]);
      expect(imported.longText).toBe(long[index]);
      expect(imported.fhir).toEqual(row);
    }
    const r6 = JSON.parse(JSON.stringify(toDosageDetails([row])));
    for (const [index, locale] of ["en", "th"].entries()) {
      const options = { locale, realizationMode: "normalized" as const };
      expect(formatSig(r6, "short", options)).toBe(short[index]);
      expect(formatSig(r6, "long", options)).toBe(long[index]);
    }
    expect(r6.step![0].component[0].doseAndRate?.[0].doseRange).toEqual(range);
    expect(r6.step![0].component[0].extension).toContainEqual({
      url: "urn:round49:row-note", valueString: "preserve unrelated data"
    });
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    expect(cold[0].doseAndRate[0].doseRange).toEqual(range);
    expect(cold[0].extension).toContainEqual({
      url: "urn:round49:row-note", valueString: "preserve unrelated data"
    });
    expect(JSON.stringify(row)).toBe(saved);
  });

  it.each(["en", "th"] as const)("normalizes the verified condition in %s while retaining roundtrip source", locale => {
    const source = "Take 1 tablet BID only if BP >160, otherwise hold";
    const row = parsePublicSig(source).fhir[0];
    const saved = JSON.stringify(row);
    const short = locale === "en" ? "1 tab PO BID only if BP > 160."
      : "1 เม็ด PO วันละ 2 ครั้ง เฉพาะเมื่อ BP > 160.";
    const condition = locale === "en" ? "only if BP > 160" : "เฉพาะเมื่อ BP > 160";
    const dose = locale === "en" ? "Take 1 tablet orally twice daily" : "รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง";
    for (const dosage of [row, JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails([row]))))[0]]) {
      const options = { locale, realizationMode: "normalized" as const };
      expect(formatSig(dosage, "short", options)).toBe(short);
      const long = formatSig(dosage, "long", options);
      expect(long).toContain(dose);
      expect(long).toMatch(new RegExp(condition + "(?![0-9]|[.][0-9])", "u"));
      expect(long).toBe(dose + " " + condition + (locale === "en" ? ". Otherwise hold." : ". otherwise hold."));
      const imported = fromFhirDosage(dosage, options);
      expect(imported.shortText).toBe(short);
      expect(imported.longText).toContain(dose);
      expect(imported.longText).toMatch(new RegExp(condition + "(?![0-9]|[.][0-9])", "u"));
      expect(imported.longText).toBe(dose + " " + condition + (locale === "en" ? ". Otherwise hold." : ". otherwise hold."));
      expect(dosage.text).toBe(source);
    }
    // Public parser agreement remains available after ordinary JSON persistence.
    for (const savedRow of [row, JSON.parse(JSON.stringify(row))]) {
      for (const style of ["short", "long"] as const)
        expect(formatSig(savedRow, style, { locale, realizationMode: "roundtrip" })).toBe(source);
      expect(fromFhirDosage(savedRow, { locale, realizationMode: "roundtrip" }).longText).toBe(source);
    }
    expect(JSON.stringify(row)).toBe(saved);
  });
});

describe("round63 imported member preview ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const choice = (branchId: string): FhirR6Extension => ({
    url: DOSAGE_ALTERNATIVE_CHOICE_URL, extension: [
      { url: "groupId", valueString: "daily-time" },
      { url: "branchId", valueString: branchId },
      { url: "selectionBehavior", valueCode: "exactly-one" }
    ]
  });

  it.each(["short", "long"] as const)("retains both authored text-only choice members in %s previews", style => {
    const source: FhirR6DosageInstruction = { step: [{ component: [
      { text: "Take 1 tablet in the morning", modifierExtension: [choice("morning")] },
      { text: "Take 1 tablet at bedtime", modifierExtension: [choice("bedtime")] }
    ] }] };
    const before = fresh(source);
    for (const input of [source, fresh(toFhirR5Dosages(source))]) {
      const rendered = formatSig(input, style, { locale: "en" });
      expect(rendered).toContain("Take 1 tablet in the morning");
      expect(rendered).toContain("Take 1 tablet at bedtime");
      expect(rendered).toMatch(/Take 1 tablet in the morning\.? or Take 1 tablet at bedtime/u);
    }
    const structured = fresh(source);
    structured.step![0].component[0].doseAndRate = [{ doseQuantity: { value: 2, unit: "tab" } }];
    const rendered = formatSig(structured, style, { locale: "en" });
    expect(rendered).toMatch(style === "short" ? /(?:^|[^0-9.])2 tab\b/u : /(?:^|[^0-9.])2 tablets\b/u);
    expect(rendered).toContain("original directions: Take 1 tablet in the morning");
    expect(rendered).toMatch(/original directions: Take 1 tablet in the morning\.? or Take 1 tablet at bedtime/u);
    expect(rendered.split("; original directions: ")[0]).not.toContain("1 tablet");
    expect(structured.step![0].component[0].timing).toBeUndefined();
    expect(source).toEqual(before);
  });

  it.each([false, true])("owns one generated choice prompt beside partial facts (authored prompt %s)", authoredPrompt => {
    const directions = (authoredPrompt ? "Choose one: " : "") + "Apply 1 patch";
    const source: FhirR6DosageInstruction = { step: [{ component: [directions, "Apply 2 patches"].map((text, index) => ({
      text, route: { text: "transdermal" },
      site: { concept: { text: "left arm" } },
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
      safety: { doseLimit: [{ scope: "administration" as const, valueQuantity: { value: 2, unit: "patch" } }] },
      modifierExtension: [{ ...choice(String(index)), id: "choice-" + index,
        extension: [...choice(String(index)).extension!, { url: "urn:test:choice-note", valueString: "Keep this annotation" }] }]
    })) }] };
    const before = fresh(source);
    for (const input of [source, fresh(toFhirR5Dosages(source))]) {
      const original = fresh(input);
      for (const style of ["short", "long"] as const) {
        const rendered = formatSig(input, style, { locale: "en" });
        expect(rendered.match(/Choose one:/gu)).toHaveLength(authoredPrompt ? 2 : 1);
        expect(rendered).toContain(directions);
        expect(rendered).toContain("Apply 2 patches");
        expect(rendered).toContain("left arm");
        expect(rendered).toContain("max per administration: 2 patch");
      }
      expect(input).toEqual(original);
    }
    expect(source).toEqual(before);
  });

  it("keeps explicit member predecessors in the batch preview and independent separators", () => {
    const phase = (sourceMember: number, predecessor?: number): FhirR6Extension => ({
      url: PARALLEL_COMPONENT_PHASE_ORIGIN_URL,
      extension: [{ url: "sourceMember", valueInteger: sourceMember },
        ...(predecessor === undefined ? [] : [{ url: "predecessor", valueInteger: predecessor }])]
    });
    const source: FhirR6DosageInstruction = { step: [{ component: [
      { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, count: 4 } },
        modifierExtension: [phase(0)] },
      { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        modifierExtension: [phase(1, 0)] }
    ] }] };
    const batch = fromFhir(source, { locale: "en" });
    for (const style of ["short", "long"] as const) {
      const rendered = formatParseBatch(batch, style, " | ");
      expect(rendered).toContain("After the previous phase");
      const phases = rendered.split("After the previous phase");
      expect(phases).toHaveLength(2);
      expect(phases[0]).toMatch(style === "short"
        ? /^2 tab 1x\/d x4(?:;|$)/u : /^Use 2 tablets once daily for 4 doses(?:;|$)/u);
      const count = style === "short" ? /x4\b/u : /4 (?:dose|administration)/u;
      expect(phases[0]).toMatch(count);
      expect(phases[1]).toMatch(style === "short"
        ? /^: 1 tab 1x\/d$/u : /^: Use 1 tablet once daily\.$/u);
      expect(phases[1]).not.toMatch(count);
    }
    const independent = fresh(source);
    for (const component of independent.step![0].component) delete component.modifierExtension;
    const separate = fromFhir(independent);
    expect(formatParseBatch(separate, "long", " | ")).toBe(separate.items.map(item => item.longText).join(" | "));
  });

  it("uses normalized batch previews by default while keeping explicit source replay", () => {
    const source = "1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID";
    const complete = fresh(parsePublicSig(source).fhir);
    const normalized = formatSigBatch(complete, "long", { locale: "en", realizationMode: "normalized" });
    expect(formatSigBatch(complete, "long", { locale: "en" })).toBe(normalized);
    expect(normalized).toBe(
      "From treatment start until 7 days after treatment start: Instill 1 drop every 2 hours in the right eye; " +
      "Instill 1 drop four times daily for 1 month in the left eye. " +
      "From 7 days after treatment start until 1 month after treatment start: Instill 1 drop four times daily in the right eye; " +
      "Instill 1 drop four times daily in the left eye. " +
      "From 1 month after treatment start onward: Instill 1 drop four times daily in the right eye; " +
      "Instill 1 drop twice daily in the left eye.");
    expect(formatSigBatch(complete, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
  });
});


describe("round74 incomplete Thai frequency bounds", () => {
  it.each([
    [{ frequency: 1, frequencyMax: 2 }, "1 ถึง 2 ครั้ง"],
    [{ frequencyMax: 2 }, "ไม่เกิน 2 ครั้ง"],
    [{ frequency: 1 }, "ครั้งเดียว"],
    [{ frequency: 2 }, "2 ครั้ง"]
  ] as const)("retains the supplied count bounds without inventing a period: %s", (repeat, expected) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat }
    }] }] };
    const before = JSON.stringify(source), rows = JSON.parse(JSON.stringify(toFhirR5Dosages(source)));
    for (const input of [source, rows, JSON.parse(JSON.stringify(toDosageDetails(rows)))])
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale: "th", realizationMode: "normalized" });
        const exact = style === "short" ? "1 เม็ด " + expected : "ใช้ครั้งละ 1 เม็ด " + expected + ".";
        expect(text).toBe(exact);
        expect(text).not.toMatch(/วัน|สัปดาห์|เดือน|ปี|ชั่วโมง|นาที/u);
        expect(style === "short" ? "1 เม็ด 12 ครั้ง" : "ใช้ครั้งละ 1 เม็ด 12 ครั้ง.").not.toBe(exact);
      }
    expect(JSON.stringify(source)).toBe(before);
    expect(toDosageDetails(rows).step![0].component[0].timing?.repeat).toEqual(repeat);
  });
});


// Public R5/R6 edits and retained interchange meaning use their original helper bindings.
{
const parseSig = parsePublicSig;
const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const q = (value: number) => ({ value, unit: "tab" });
const expression = (name: string) => ({ language: "text/fhirpath", expression: "%" + name });
const course = (component: Partial<FhirR6Dosage> = {}): FhirR6DosageInstruction => ({
  step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], ...component }] }],
});
const r6Save = (value: FhirR6DosageInstruction): FhirR6DosageInstruction => {
  return projectCanonicalCourse(importCanonicalCourse(persist(value))).fhirNext;
};

// Public wire edits are supported inputs. Expected amounts, associations and
// source fragments are authored here independently of the adapter output.
describe("round23 R5 external identity and source preservation", () => {
  it("keeps each same-valued period limit's metadata on its unique ID after reorder and edit", () => {
    const first = { id: "limit-a", scope: "period" as const, valueQuantity: q(4),
      period: { value: 1, unit: "d" }, text: "first limit" };
    const second = { ...first, id: "limit-b", text: "second limit" };
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [first, second] } })));
    rows[0].maxDosePerPeriod!.reverse();
    rows[0].maxDosePerPeriod![1].numerator!.value = 3;
    let actual = toDosageDetails(rows);
    const expected = [second, { ...first, valueQuantity: q(3) }];
    expect(actual.step![0].component[0].safety!.doseLimit).toEqual(expected);
    for (let save = 0; save < 3; save++) {
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
      expect(actual.step![0].component[0].safety!.doseLimit).toEqual(expected);
    }
  });

  it("keeps the unique ID-less period limit's metadata on an ordinary amount edit", () => {
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "one day limit",
    }] } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual([{
      scope: "period", valueQuantity: q(3), period: { value: 1, unit: "d" }, text: "one day limit",
    }]);
  });

  it("does not transfer an old limit's text onto a different explicit ID", () => {
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      id: "old", scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "old label",
    }] } })));
    rows[0].maxDosePerPeriod![0].id = "new";
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual([{
      id: "new", scope: "period", valueQuantity: q(3), period: { value: 1, unit: "d" },
    }]);
  });

  it.each(["dose", "rate"] as const)("keeps anonymous %s expressions with their distinct numeric sibling on reordering", dimension => {
    const entries = dimension === "dose" ? [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] : [
      { doseQuantity: { value: 5, unit: "mg" }, rateExpression: expression("firstRate") },
      { doseQuantity: { value: 10, unit: "mg" }, rateExpression: expression("secondRate") },
    ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.reverse();
    let actual = toDosageDetails(rows);
    const expected = [entries[1], entries[0]];
    for (let save = 0; save < 3; save++) {
      expect(actual.step![0].component[0].doseAndRate).toEqual(expected);
      actual = toDosageDetails(persist(toFhirR5Dosages(actual)));
    }
  });

  it("restores an anonymous expression's unique surviving numeric sibling after deletion", () => {
    const entries = [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.splice(0, 1);
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate).toEqual([entries[1]]);
  });

  it("uses each expression-only slot's own typed source when reordered", () => {
    const entries = [ { doseExpression: expression("firstDose") }, { doseExpression: expression("secondDose") } ];
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: entries })));
    rows[0].doseAndRate!.reverse();
    expect(toDosageDetails(rows).step![0].component[0].doseAndRate).toEqual([entries[1], entries[0]]);
  });

  it("keeps a numeric replacement authoritative after expression slots are reordered", () => {
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] })));
    rows[0].doseAndRate!.reverse();
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    const actual = toDosageDetails(rows);
    expect(actual.step![0].component[0].doseAndRate).toEqual([
      { doseQuantity: { value: 2, unit: "mg" }, rateQuantity: { value: 10, unit: "mL/h" } },
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
    ]);
    expect(JSON.stringify(actual)).toContain("%secondDose");
  });

  it("keeps expression associations inert when numeric edits make the slots ambiguous", () => {
    const rows = persist(toFhirR5Dosages(course({ doseAndRate: [
      { doseExpression: expression("firstDose"), rateQuantity: { value: 5, unit: "mL/h" } },
      { doseExpression: expression("secondDose"), rateQuantity: { value: 10, unit: "mL/h" } },
    ] })));
    rows[0].doseAndRate!.reverse();
    rows[0].doseAndRate![0].rateQuantity!.value = 5;
    const actual = toDosageDetails(rows);
    expect(actual.step![0].component[0].doseAndRate).toEqual([
      { rateQuantity: { value: 5, unit: "mL/h" } }, { rateQuantity: { value: 5, unit: "mL/h" } },
    ]);
    expect(JSON.stringify(actual)).toContain("%firstDose");
    expect(JSON.stringify(actual)).toContain("%secondDose");
  });

  it.each(["empty", "denominator", "numerator", "primitive"] as const)("retains %s-only R5 period Ratio metadata through both boundaries", shape => {
    const ratio: FhirRatio = {
      id: "authored-ratio", extension: [{ url: "urn:test:ratio-note", valueString: "pending amount" }],
      ...(shape === "denominator" ? { denominator: { value: 1, unit: "d" } } : {}),
      ...(shape === "numerator" ? { numerator: q(4) } : {}),
      ...(shape === "primitive" ? {
        numerator: { _value: { extension: [{ url: "urn:test:pending", valueString: "not entered" }] }, unit: "tab" },
        denominator: { value: 1, unit: "d" },
      } : {}),
    };
    const rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [ratio] }];
    const validRatio = shape === "empty" || shape === "primitive";
    const checkR5 = (row: FhirDosage) => {
      expect(row.maxDosePerPeriod).toEqual(validRatio ? [ratio] : undefined);
      if (!validRatio) {
        const marker = row.extension!.find(value => value.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
        expect(marker.valueRatio).toBeUndefined();
        expect(readRetainedField(marker)).toEqual(ratio);
      }
    };
    checkR5(toFhirR5Dosages(rows)[0]);
    let r6 = toDosageDetails(persist(rows));
    for (let save = 0; save < 3; save++) {
      const member = r6.step![0].component[0];
      if (shape === "primitive") {
        expect(member.safety?.doseLimit).toEqual([{ id: ratio.id, extension: ratio.extension,
          scope: "period", valueQuantity: ratio.numerator, period: ratio.denominator }]);
        const limits = importCanonicalCourse(r6).stages[0].administrations[0].limits!;
        expect(limits).toHaveLength(1);
        expect(limits[0].amount).toEqual(ratio.numerator);
        expect(limits[0].period).toEqual(ratio.denominator);
        expect(limits[0].amount!.value).toBeUndefined();
      } else {
        expect(member.safety?.doseLimit).toBeUndefined();
        const marker = member.extension!.find(value => value.url === R5_SOURCE_ONLY_MAXIMUM_URL)!;
        expect(marker.valueRatio).toBeUndefined();
        expect(readRetainedField(marker)).toEqual(ratio);
        expect(importCanonicalCourse(r6).stages[0].administrations[0].limits).toBeUndefined();
      }
      const saved = persist(toFhirR5Dosages(r6));
      checkR5(saved[0]);
      r6 = toDosageDetails(saved);
    }
  });

  it.each([simpleQuantityForR5, quantityForR5])("replaces authored EMA equality when the current comparator changes", convert => {
    const coding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display: "equal to",
      _display: { extension: [{ url: "urn:test:translation", valueString: "เท่ากับ" }] } };
    const unrelated = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000054", display: "range" } };
    const source: FhirR6Quantity = { value: 4, unit: "mg", extension: [
      { id: "operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: coding }, unrelated,
    ] };
    expect(convert(source)).toBe(source);
    const changed = convert({ ...source, comparator: "<" })!;
    const operators = changed.extension!.filter(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
    expect(operators).toEqual(convert === simpleQuantityForR5 ? [
      { id: "operator", url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050", display: "less than" } }, unrelated,
    ] : [unrelated]);
    expect(getQuantityComparator(changed)).toBe("<");
    expect(changed.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
      ...(convert === simpleQuantityForR5 ? { valueCoding: coding } : { extension: [source.extension![0]] }),
    });
    expect(convert(persist({ ...changed, comparator: "<" }))).toEqual(changed);
    const exact = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display: "equal to" };
    expect(convert({ value: 4, unit: "mg", comparator: "<", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: exact,
    }] })!.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source",
      ...(convert === simpleQuantityForR5 ? { valueCoding: exact } : { extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: exact,
      }] }),
    });

  });

  it.each(["draft", "safety"] as const)("preserves authored IDs on recognized %s snapshot children and stays stable", kind => {
    const initial = toDosageDetails([{ sequence: kind === "draft" ? 2 : 1, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { step: kind === "draft" ? [{ sequence: 1, id: "draft-step" }] : [
        { sequence: 1, safety: { doseLimit: [{ scope: "dosage", valueInteger: 3 }] } },
      ] });
    const url = kind === "draft" ? R6_DRAFT_STEPS_SOURCE_URL : R6_SINGLE_STEP_SAFETY_SOURCE_URL;
    const marker = initial.extension!.find(item => item.url === url)!;
    marker.id = "marker-id";
    const projected = marker.extension!.find(item => item.url === "projected")!;
    projected.id = "projected-child-id";
    projected.extension![0].id = "nested-child-id";
    let current = initial;
    for (let save = 0; save < 3; save++) {
      current = r6Save(current);
      expect(current.extension!.find(item => item.url === url)).toEqual(marker);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toHaveLength(0);
    }
  });

  it("retains an independently supplied phase total and its policy metadata", () => {
    const safety = { id: "phase-policy", doseLimit: [{ id: "phase-total",
      scope: "dosage" as const, valueInteger: 3,
      extension: [{ url: "urn:clinic:phase-note", valueString: "retain" }] }] };
    const output = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }], undefined,
      { step: [{ sequence: 1, safety }] });
    const before = persist(output);
    const marker = output.safety?.modifierExtension?.find(item => item.url === R6_SCOPED_SAFETY_MODIFIER_URL);
    expect(marker).toBeDefined();
    expect(decodeR6SourceMetadata(marker!, "safety")).toMatchObject({ step: safety });
    expect(output.safety?.doseLimit).toBeUndefined();
    expect(fromDosageDetails(output).course.step?.[0].safety).toEqual(safety);
    expect(output).toEqual(before);
  });

  it("preserves an authored condition bridge ID while consuming the plain generated bridge", () => {
    const plain: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(plain, { kind: "measurement", name: "systolic blood pressure", operation: "gt", value: 140, text: "systolic blood pressure above 140 mmHg", unit: "mmHg" });
    const bridge = plain.modifierExtension!.find(item => item.url === DOSAGE_CONDITION_R5_URL)!;
    expect(isExactConditionBridge(bridge)).toBe(true);
    const active = toDosageDetails([plain]).step![0].component[0];
    expect(active.modifierExtension).toBeUndefined();
    expect(active.condition).toEqual([{
      code: { text: "systolic blood pressure", coding: [{
        system: "urn:ezmedicationinput:CodeSystem:medication-condition", code: "measurement", display: "systolic blood pressure",
      }] }, operation: "gt",
      valueQuantity: { value: 140, unit: "mmHg" }, text: "systolic blood pressure above 140 mmHg",
    }]);
    bridge.id = "authored-condition-bridge";
    expect(isExactConditionBridge(bridge)).toBe(false);
    let result = toDosageDetails(persist([plain]));
    for (let save = 0; save < 3; save++) {
      const component = result.step![0].component[0];
      expect(component.modifierExtension?.some(item => item.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
      expect(component.extension, "condition source save " + save).toContainEqual({
        url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [bridge],
      });
      result = toDosageDetails(persist(toFhirR5Dosages(result)));
    }
  });
});

describe("round23 external R6 wording across R5", () => {
  it("does not certify the old graph when the current text alone is explicitly replaced", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].component[0].doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let rows = persist(toFhirR5Dosages(source));
    const replacement = "Take 1 tablet every morning with the prescribed infusion.";
    rows[0].text = replacement;
    for (let save = 0; save < 3; save++) {
      const submitted = persist(rows);
      expect(dosageMatchesSavedProjection(rows[0])).toBe(false);
      expect(rows[0].text).toBe(replacement);
      expect(rows[0].doseAndRate).toMatchObject([{
        doseQuantity: { value: 1, unit: "tab" },
        rateQuantity: { value: 5, unit: "mL/h" }
      }]);
      expect(rows[0].timing?.repeat).toMatchObject({
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day
      });
      // Current structured rate wording remains authoritative. Roundtrip may
      // show the explicit replacement separately, without certifying its graph.
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const current = "Take 1 tablet orally once daily; Rate: 5 mL/h";
        const preview = formatSig(rows[0], "long", { locale: "en", realizationMode });
        const [active, original] = preview.split("; original directions: ");
        expect(active.replace(/^Current: /u, "")).toBe(current);
        if (original !== undefined) expect(original).toBe(replacement);
        const imported = fromFhirDosage(rows[0], { locale: "en", realizationMode });
        expect(imported.longText).toBe(preview);
        expect(imported.fhir).toEqual(submitted[0]);
        expect(imported.meta.canonical.clauses[0].rawText).toBe(replacement);
      }
      expect(rows).toEqual(submitted);
      rows = persist(toFhirR5Dosages(rows));
    }
  });

  it("accepts explicit text and dose replacements on a later unverified R5 row", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    const component = source.step![0].component[0];
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    source.step![0].component.push(persist(component));
    const rows = persist(toFhirR5Dosages(source));
    rows[1].doseAndRate![0].doseQuantity!.value = 2;
    rows[1].text = "Take 2 tablets orally each morning with the prescribed infusion.";
    const submitted = persist(rows);
    expect(dosageMatchesSavedProjection(rows[1])).toBe(false);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const current = "Take 2 tablets orally once daily; Rate: 5 mL/h";
      const expected = "Current: " + current + "; original directions: " + rows[1].text;
      expect(formatSig(rows[1], "long", { locale: "en", realizationMode })).toBe(expected);
      const imported = fromFhirDosage(rows[1], { locale: "en", realizationMode });
      expect(imported.longText).toBe(expected);
      expect(imported.fhir).toEqual(submitted[1]);
      expect(imported.meta.canonical.clauses[0].rawText).toBe(rows[1].text);
    }
    const current = toDosageDetails(rows);
    expect(current.step![0].component).toHaveLength(2);
    for (const [index, value] of [1, 2].entries()) {
      const member = current.step![0].component[index];
      expect(member.doseAndRate).toEqual(submitted[index].doseAndRate);
      expect(member.doseAndRate).toMatchObject([{
        doseQuantity: { value, unit: "tab" },
        rateQuantity: { value: 5, unit: "mL/h" }
      }]);
      expect(member.timing).toEqual(submitted[index].timing);
      expect(member.timing?.repeat).toMatchObject({
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day
      });
    }
    expect(current.step![0].component[1].text).toBe(rows[1].text);
    expect(JSON.stringify(current)).toContain("Take 1 tablet orally daily.");
    expect(rows).toEqual(submitted);
  });

  it("keeps fromDosageDetails wording unverified through persisted R6 and R5 crossings", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].count = 2;
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let edit = persist(fromDosageDetails(source));
    for (let save = 0; save < 3; save++) {
      expect(edit.course.renderedInstruction).toBe("Take 1 tablet orally daily.");
      expect(edit.dosages[0].text).toContain("1 tablet");
      expect(edit.dosages[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      expect(dosageMatchesSavedProjection(edit.dosages[0])).toBe(false);
      for (const input of [edit.dosages, edit.dosages[0]]) {
        const display = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
        expect(display).toContain("2 tablets");
        expect(display).not.toContain("1 tablet");
      }
      const reopened = persist(toDosageDetails(edit.dosages));
      expect(reopened.renderedInstruction).toBe("Take 1 tablet orally daily.");
      expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      edit = persist(fromDosageDetails(reopened));
    }
  });

  it("retains an explicit replacement course instruction without discarding its original", () => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].count = 2;
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const edit = persist(fromDosageDetails(source));
    edit.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    edit.course.renderedInstruction = "Take 2 tablets daily; repeat this course twice as directed.";
    const current = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(current.renderedInstruction).toBe(edit.course.renderedInstruction);
    expect(current.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(JSON.stringify(current)).toContain("Take 1 tablet orally daily.");
    const native = courseFromR5(edit.dosages, undefined, edit.course);
    const projected = projectCanonicalCourse(native).fhir;
    expect(formatSig(projected, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(edit.course.renderedInstruction);
    expect(projected[0].text).toContain("1 tablet");
    expect(formatSig(projected[0], "long", { locale: "en", realizationMode: "roundtrip" })).toContain("2 tablets");
  });

  it.each([true, false])("marks each later rich R5 row independently without duplicating source headers (header %s)", header => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    if (!header) delete source.renderedInstruction;
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    source.step![0].component.push(persist(component));
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      for (const row of rows) {
        expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toContain("2 tablets");
        expect(row.text).toContain("1 tablet");
      }
      expect(rows[1].extension!.filter(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)).toMatchObject([{
        url: DOSAGE_RENDERED_INSTRUCTION_R5_URL,
        extension: expect.arrayContaining([{ url: "textFingerprint", valueString: expect.any(String) }]),
      }]);
      const reopened = toDosageDetails(rows);
      expect(reopened.renderedInstruction).toBe(source.renderedInstruction);
      rows = persist(toFhirR5Dosages(reopened));
    }
  });

  it.each([
    ["step", undefined], ["step", "roundtrip"], ["rate", undefined], ["rate", "roundtrip"],
  ] as const)("uses current dose after a rich %s R6 source crosses R5 (mode %s)", (shape, realizationMode) => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    const component = source.step![0].component[0];
    component.doseAndRate![0].doseQuantity!.value = 2;
    if (shape === "step") source.step![0].count = 2;
    else component.doseAndRate![0].rateQuantity = { value: 5, unit: "mL/h" };
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      expect(rows[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const display = formatSig(rows, "long", { locale: "en", realizationMode });
      expect(display).toContain("2 tablets");
      expect(display).not.toContain("1 tablet");
      expect(JSON.stringify(rows)).toContain("Take 1 tablet orally daily.");
      const reopened = toDosageDetails(rows);
      expect(reopened.renderedInstruction).toBe(source.renderedInstruction);
      rows = persist(toFhirR5Dosages(reopened));
    }
  });

  it.each([undefined, "roundtrip"] as const)("does not bless a stale one-tablet R6 source after exporting two tablets (mode %s)", realizationMode => {
    const source = persist(parseSig("Take 1 tablet orally daily.").fhirNext);
    source.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      expect(rows[0].doseAndRate![0].doseQuantity!.value).toBe(2);
      const display = formatSig(rows, "long", { locale: "en", realizationMode });
      expect(display).toContain("2 tablets");
      expect(display).not.toContain("1 tablet");
      expect(JSON.stringify(rows)).toContain("Take 1 tablet orally daily.");
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });
});

describe("round23 typed timing replay observations", () => {
  it.each([TIMING_OFFSET_EXACT_EXTENSION_URL, TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL])(
    "imports each newly submitted typed offset value: %s", url => {
      const input: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { extension: [{ url, valueDecimal: 0.5 }] } } };
      const field = url === TIMING_OFFSET_EXACT_EXTENSION_URL ? "offset"
        : url === TIMING_OFFSET_MIN_EXTENSION_URL ? "offsetMin" : "offsetMax";
      expect(importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence?.[field]).toBe(0.5);
      const submitted = persist(input);
      submitted.timing!.repeat!.extension![0].valueDecimal = 1.5;
      const before = persist(submitted);
      expect(importCanonicalCourse(submitted).stages[0].administrations[0].schedule?.recurrence?.[field]).toBe(1.5);
      expect(submitted).toEqual(before);
    });

  it.each([false, true])("renders a newly submitted Thai minimum offset from 30 to 60 minutes (original persisted %s)", saved => {
    const parsed = parseSig("รับประทาน 1 เม็ด ก่อนอาหารอย่างน้อย 30 นาที", { locale: "th" });
    let row = saved ? persist(parsed.fhir[0]) : parsed.fhir[0];
    expect(formatSig(row, "long", { locale: "th" })).toContain("30 นาที");
    row = persist(row);
    row.timing!.repeat!.extension!.find(item => item.url === TIMING_OFFSET_MIN_EXTENSION_URL)!.valueInteger = 60;
    const text = formatSig(row, "long", { locale: "th" });
    expect(text).toBe("รับประทานครั้งละ 1 เม็ด ก่อนอาหารอย่างน้อย 1 ชั่วโมง.");
    expect(text).not.toContain("30 นาที");
  });
});


describe("round24 supported FHIR edit boundaries", () => {
  const ucum = "http://unitsofmeasure.org";
  const relative = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d", code: "d" } });
  const approximate: FhirExtension = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
    valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" } };

  it("uses a live positive R6 frequency and retires only its old zero marker", () => {
    const sibling = { id: "timing-note", url: "urn:test:frequency-note", valueString: "keep" };
    const input = course({ timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      extension: [{ url: TIMING_FREQUENCY_MIN_EXTENSION_URL, valueInteger: 0 }, sibling],
    } } });
    const native = importCanonicalCourse(input);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.frequency).toBe(2);
    for (const row of [courseToR6(native).step![0].component[0], toFhirR5Dosages(input)[0]]) {
      expect(row.timing?.repeat?.frequency).toBe(2);
      expect(row.timing?.repeat?.extension).toEqual([sibling]);
    }
    const zero = persist(input);
    delete zero.step![0].component[0].timing!.repeat!.frequency;
    expect(importCanonicalCourse(zero).stages[0].administrations[0].schedule?.recurrence?.frequency).toBe(0);
  });

  it("leaves ambiguous legacy same-site references inert while matching a distinct site", () => {
    const concepts = [{ text: "eye" }, { text: "eye" }, { text: "left arm" }];
    const references = ["BodyStructure/right-eye", "BodyStructure/left-eye", "BodyStructure/left-arm"];
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
      url: "dosageDetails", extension: [{ url: "step", extension: concepts.map((concept, index) => ({
        url: "component", extension: [
          { url: "site", valueCodeableReference: { concept, reference: { reference: references[index] } } },
          { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(index + 1) }] },
        ],
      })) }],
    }] };
    const rows: FhirDosage[] = [1, 0, 2].map(index => ({ sequence: 1, site: concepts[index],
      doseAndRate: [{ doseQuantity: q((index + 1) * 10) }], modifierExtension: [marker],
    }));
    const result = toDosageDetails(persist(rows));
    expect(result.step![0].component.map(value => value.doseAndRate![0].doseQuantity!.value)).toEqual([20, 10, 30]);
    expect(result.step![0].component.slice(0, 2).map(value => value.site)).toEqual([
      { concept: concepts[0] }, { concept: concepts[1] },
    ]);
    expect(result.step![0].component[2].site).toEqual({ concept: concepts[2], reference: { reference: references[2] } });
    expect(result.extension?.filter(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      .some(value => value.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
  });

  it("keeps an in-memory external edit to a synthesized start independent of its draft snapshot", () => {
    const input: FhirR6DosageInstruction = { step: [
      { end: relative(2), component: [] }, { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] },
    ] };
    const output = courseToR6(importCanonicalCourse(input));
    expect(importCanonicalCourse(output).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    output.step![0].start!.contextCode!.coding![0].code = "treatment-end";
    const marker = output.extension!.find(value => value.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    const saved = decodeR6SourceMetadata(marker, "drafts") as { projected: FhirR6DosageStep[] };
    expect(saved.projected[0].start!.contextCode!.coding![0].code).toBe("treatment-start");
    const current = importCanonicalCourse(output);
    expect(current.stages).toHaveLength(1);
    expect(courseToR6(current).step![0].start).toEqual({
      ...relative(2), contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-end" }] },
    });
  });

  it("keeps period-local offsets for frequency edits but retires changed or ineligible periods", () => {
    const input = course({ timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
    } } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].timing!.repeat!.frequency = 20;
    expect(toDosageDetails(rows).step![0].component[0].timing!.repeat).toEqual({
      frequency: 20, period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, unit: "d", code: "d" }, endOffset: { value: 5, unit: "d", code: "d" },
    });
    for (const edit of [{ period: 30 }, { frequency: 1 }]) {
      const changed = persist(rows);
      Object.assign(changed[0].timing!.repeat!, edit);
      const repeat = toDosageDetails(changed).step![0].component[0].timing!.repeat!;
      expect(repeat).not.toHaveProperty("startOffset");
      expect(repeat).not.toHaveProperty("endOffset");
    }
  });

  it("gives an emitted native Quantity comparator sole authority over enriched EMA source", () => {
    const authored: FhirExtension = { id: "operator-source", ...approximate,
      valueCoding: { ...approximate.valueCoding!, display: "approximately equal to",
        _display: { extension: [{ url: "urn:test:translation", valueString: "ประมาณ" }] } } };
    const input: FhirDosage = { doseAndRate: [{ rateRatio: {
      numerator: { value: 50, unit: "mL", extension: [authored] }, denominator: { value: 1, unit: "h" },
    } }] };
    const output = courseToR6(importCanonicalCourse(input));
    const numerator = output.step![0].component[0].doseAndRate![0].rateRatio!.numerator!;
    expect(numerator.comparator).toBe("~");
    expect(numerator.extension?.some(value => value.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)).toBe(false);
    expect(numerator.extension).toContainEqual({ url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [authored] });
    delete numerator.comparator;
    const cleared = courseToR6(importCanonicalCourse(output));
    expect(getQuantityComparator(cleared.step![0].component[0].doseAndRate![0].rateRatio!.numerator)).toBeUndefined();
    expect(cleared.step![0].component[0].doseAndRate![0].rateRatio!.numerator!.extension).toEqual(numerator.extension);
    expect(getQuantityComparator(input.doseAndRate![0].rateRatio!.numerator)).toBe("~");
  });

  it.each(["at most 5 mg PO daily", "approximately 5 mg PO daily"])("marks a parsed qualified R5 dose as modified: %s", text => {
    const parsed = parseSig(text);
    const row = parsed.fhir[0];
    expect(row.doseAndRate![0].doseQuantity!.value).toBe(5);
    expect(row.doseAndRate![0].doseQuantity).not.toHaveProperty("comparator");
    const modifier = row.modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
    expect(modifier).toBeDefined();
    const retained = decodeR5RetainedFields(modifier);
    expect(retained.component!.doseAndRate![0].doseQuantity!.value).toBe(5);
    expect(getQuantityComparator(retained.component!.doseAndRate![0].doseQuantity)).toBe(text.startsWith("at most") ? "<=" : "~");
    expect(getQuantityComparator(toDosageDetails(persist([row])).step![0].component[0].doseAndRate![0].doseQuantity))
      .toBe(text.startsWith("at most") ? "<=" : "~");
    expect(parseSig("5 mg PO daily").fhir[0].modifierExtension?.some(value => value.url === DOSAGE_DETAILS_R5_URL)).not.toBe(true);
  });

  it.each([
    { text: "at most 5 mg daily then at most 3 mg daily", counts: [1, 1] },
    { text: "at most 5 mg every morning and at most 3 mg every evening", counts: [2] },
  ])("assigns final source indices to qualified parser rows: $text", ({ text, counts }) => {
    const parsed = parseSig(text);
    let rows = persist(parsed.fhir);
    expect(rows.map(row => decodeR5RetainedFields(row.modifierExtension!
      .find(value => value.url === DOSAGE_DETAILS_R5_URL)!).rowIndex)).toEqual([0, 1]);
    const unchanged = toDosageDetails(rows);
    expect(unchanged.renderedInstruction).toBe(text);
    expect(unchanged.step!.map(step => step.component.length)).toEqual(counts);
    expect(unchanged.extension?.some(value => value.url === DOSAGE_RECONCILIATION_SOURCE_URL)).not.toBe(true);
    rows = persist(rows);
    rows[1].doseAndRate![0].doseQuantity!.value = 7;
    const edited = toDosageDetails(rows);
    const components = edited.step!.length === 2
      ? [edited.step![0].component[0], edited.step![1].component[0]] : edited.step![0].component;
    expect(components.map(value => value.doseAndRate![0].doseQuantity!.value)).toEqual([5, 7]);
    expect(components.map(value => getQuantityComparator(value.doseAndRate![0].doseQuantity))).toEqual(["<=", "<="]);
    expect(components[0].text).toBe(parsed.fhir[0].text);
    expect(components[1].text).toBeUndefined();
    expect(edited.renderedInstruction).toBeUndefined();
  });

  it("marks qualified range endpoints and ratio denominators on strict R5 output", () => {
    const input = course({ doseAndRate: [{ doseRange: { low: simpleQuantityForR5({ value: 2, unit: "mg", comparator: "~" })!, high: { value: 4, unit: "mg" } },
      rateRatio: { numerator: { value: 50, unit: "mL" }, denominator: simpleQuantityForR5({ value: 1, unit: "h", comparator: ">=" })! } }] });
    const rows = toFhirR5Dosages(input);
    expect(rows[0].modifierExtension?.some(value => value.url === DOSAGE_DETAILS_R5_URL)).toBe(true);
    const amount = toDosageDetails(persist(rows)).step![0].component[0].doseAndRate![0];
    expect(getQuantityComparator(amount.doseRange!.low)).toBe("~");
    expect(getQuantityComparator(amount.rateRatio!.denominator)).toBe(">=");
  });

  it.each([false, true])("uses a newly submitted month-day edit (original persisted=%s)", saved => {
    const parsed = parseSig("Take 1 tablet PO on day 1 of every month");
    let row = saved ? persist(parsed.fhir[0]) : parsed.fhir[0];
    formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    row = persist(row);
    const marker = row.timing!.repeat!.extension!.find(value => value.url === TIMING_DAY_OF_MONTH_EXTENSION_URL)!;
    expect(marker.valuePositiveInt).toBe(1);
    marker.valuePositiveInt = 15;
    const text = formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(text).toMatch(/(?:^|[^0-9])15(?:[^0-9]|$)/u);
    expect(text).not.toContain("day 1 of every month");
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it.each([undefined, "~"] as const)("keeps a lower-only duration range and its endpoint qualifier %s", comparator => {
    const low = simpleQuantityForR5({ value: 5, unit: "days", code: "d", system: ucum, ...(comparator ? { comparator } : {}) })!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { frequency: 1,
      period: 1, periodUnit: FhirPeriodUnit.Day, boundsRange: { low },
    } } };
    const clause = canonicalFromFhir(row);
    expect(clause.schedule?.durationIsRange).toBe(true);
    expect(clause.schedule?.duration).toBe(5);
    expect(clause.schedule?.durationMax).toBeUndefined();
    const restored = canonicalToFhir(clause);
    expect(restored.timing!.repeat!.boundsRange).toEqual({ low });
    expect(restored.timing!.repeat!.boundsDuration).toBeUndefined();
    const native = importCanonicalCourse(row);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLength).toBeUndefined();
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLengthRange?.low?.value).toBe(5);
    for (const wire of [row, courseToR6(native)]) {
      expect(formatSig(wire, "short", { locale: "en", realizationMode: "normalized" })).toContain(`x>=${comparator ?? ""}5d`);
      expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" })).toContain(`for at least ${comparator ?? ""}5 days`);
      expect(formatSig(wire, "long", { locale: "th", realizationMode: "normalized" })).toContain(`อย่างน้อย ${comparator ?? ""}5 วัน`);
    }
    const scalar = canonicalFromFhir({ timing: { repeat: { boundsDuration: { value: 5, code: "d" } } } });
    expect(scalar.schedule?.durationIsRange).toBeUndefined();
    expect(canonicalToFhir(scalar).timing?.repeat?.boundsDuration?.value).toBe(5);
    const upper = canonicalToFhir(canonicalFromFhir({ timing: { repeat: { boundsRange: { high: { value: 5, code: "d" } } } } }));
    expect(upper.timing?.repeat?.boundsRange?.low).toBeUndefined();
    expect(upper.timing?.repeat?.boundsRange?.high?.value).toBe(5);
  });

  it("accepts the pinned R6 Timing and condition choices without executing uninterpreted values", () => {
    const timing: FhirR6Timing = { modifierExtension: [{ url: "urn:test:timing-modifier", valueBoolean: true }],
      repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
    const conditions: FhirR6DosageCondition[] = [
      { code: { text: "observer count" }, valuePositiveInt: 3, _valuePositiveInt: { id: "count-value" } },
      { code: { text: "opaque large integer" }, valueInteger64: "9223372036854775807" },
      { code: { text: "clinical availability" }, valueAvailability: { availableTime: [{ daysOfWeek: ["mon"] }] } },
      { code: { text: "external dosage detail" }, valueDosage: { patientInstruction: "source condition" } },
    ];
    // @ts-expect-error A positiveInt is numeric, with no permissive index signature.
    const invalid: FhirR6DosageCondition = { code: { text: "count" }, valuePositiveInt: "three" };
    void invalid;
    const input = course({ timing, condition: conditions });
    expect(courseToR6(importCanonicalCourse(input)).step![0].component[0].timing).toEqual(timing);
    const current = toDosageDetails(persist(toFhirR5Dosages(input)));
    expect(current.step![0].component[0].condition).toEqual(conditions);
    expect(importCanonicalCourse(input).stages[0].administrations[0].predicate?.kind).not.toBe("measurement");
  });

  it("accepts the public optional-step R6 input type at both execution APIs", () => {
    const input: FhirR6DosageInstructionInput = course({ timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"],
    } } });
    const options = { from: "2026-11-20T00:00:00Z", orderedAt: "2026-11-20T00:00:00Z", timeZone: "UTC", limit: 2 };
    expect(nextDueDoses(input, options)).toEqual(["2026-11-20T08:00:00+00:00", "2026-11-21T08:00:00+00:00"]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(2);
    const header: FhirR6DosageInstructionInput = { renderedInstruction: "Use as directed" };
    expect(nextDueDoses(header, options)).toEqual([]);
  });

  it("reopens an unchanged approximate Ratio draft snapshot and invalidates a real numerator edit", () => {
    const input: FhirR6DosageInstruction = { step: [{ id: "draft", component: [] }, { component: [{ doseAndRate: [{
      rateRatio: { numerator: { value: 50, unit: "mL", comparator: "~", extension: [approximate] },
        denominator: { value: 1, unit: "h" } },
    }] }] }] };
    const output = courseToR6(importCanonicalCourse(input));
    expect(importCanonicalCourse(persist(output)).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    const numerator = output.step![0].component[0].doseAndRate![0].rateRatio!.numerator!;
    expect(numerator.comparator).toBe("~");
    const rows = persist(toFhirR5Dosages(output));
    expect(rows[0].doseAndRate![0].rateRatio!.numerator!.extension).toContainEqual(approximate);
    expect(rows[0].doseAndRate![0].rateRatio!.numerator!.comparator).toBeUndefined();
    const saved = decodeR5RetainedFields(rows[0].modifierExtension!.find(item => item.url === DOSAGE_DETAILS_R5_URL)!);
    const draftSource = saved.course!.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL)!;
    // Retained source keeps its authored wire spelling; the live R5 Quantity
    // above uses the existing EMA representation and the draft still reopens.
    expect(draftSource).toEqual(output.extension!.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL));
    const snapshot = decodeR6SourceMetadata(draftSource, "drafts") as { projected: FhirR6DosageStep[] };
    expect(snapshot.projected[0].component[0].doseAndRate![0].rateRatio!.numerator!.comparator).toBe("~");
    expect(importCanonicalCourse(rows).stages.map(stage => stage.administrations.length)).toEqual([0, 1]);
    numerator.value = 51;
    expect(importCanonicalCourse(persist(output)).stages.map(stage => stage.administrations.length)).toEqual([1]);
  });

  it("preserves limit wrapper metadata across coded display edits but not changed codes", () => {
    const metadata = { id: "limit-wrapper", extension: [{ url: "urn:test:limit-note", valueString: "authored" }] };
    const input = course({ safety: { doseLimit: [{ ...metadata, scope: "administration",
      valueQuantity: { value: 2, unit: "mg", system: ucum, code: "mg" },
    }] } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].maxDosePerAdministration!.unit = "milligrams";
    const limit = toDosageDetails(rows).step![0].component[0].safety!.doseLimit![0];
    expect(limit).toEqual({ ...metadata, scope: "administration", valueQuantity: { value: 2, unit: "milligrams", system: ucum, code: "mg" } });
    rows[0].maxDosePerAdministration!.code = "mL";
    rows[0].maxDosePerAdministration!.unit = "mL";
    const changed = toDosageDetails(rows).step![0].component[0].safety!.doseLimit![0];
    expect(changed.id).toBeUndefined();
    expect(changed.extension).toBeUndefined();
    expect(changed.valueQuantity!.code).toBe("mL");
  });

  it("keeps outer CodeableReference metadata after a live concept edit without reviving the old reference", () => {
    const metadata = { id: "site-wrapper", extension: [{ url: "urn:test:site-note", valueString: "authored" }] };
    const input = course({ site: { ...metadata, concept: { text: "right eye" }, reference: { reference: "BodyStructure/right-eye" } } });
    const rows = persist(toFhirR5Dosages(input));
    rows[0].site = { text: "left eye" };
    let current = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(current.step![0].component[0].site).toEqual({ ...metadata, concept: { text: "left eye" } });
      expect(JSON.stringify(current.extension)).toContain("BodyStructure/right-eye");
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
    }
  });
});

describe("round33 interchange ownership families", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const relative = (value: number) => ({ contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const threshold = (value: number) => ({
    kind: "measurement" as const, name: "sbp", operation: "gt" as const, value, text: "SBP above " + value, unit: "mmHg",
  });
  const induction = (identified = true, additionalComponent = false) => toDosageDetails([
    { id: "induction-dose", sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
    ...(additionalComponent ? [{ id: "second-dose", sequence: 1, doseAndRate: [{ doseQuantity: q(0.5) }], timing: { repeat: daily } }] : []),
  ], undefined, { step: [{ sequence: 1, ...(identified ? { id: "induction" } : {}),
    safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2) }], ifExceeded: "Review induction" },
  }] });

  it.each(["id", "extension"] as const)("keeps lifted safety on its phase after only %s changes", field => {
    let wire = persist(induction());
    wire.step!.push({ id: "maintenance", component: [{ doseAndRate: [{ doseQuantity: q(3) }], timing: { repeat: daily } }] });
    if (field === "id") wire.safety!.id = "updated-safety";
    else wire.safety!.extension = [{ url: "urn:test:safety-note", valueString: "updated-safety" }];
    const before = JSON.stringify(wire);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0]).toMatchObject({ scope: "administration", amount: { value: 2 } });
      expect(native.stages[1].safety).toBeUndefined();
      expect(native.stages[1].administrations[0].amounts![0].quantity?.value).toBe(3);
      const output = r6Save(wire);
      expect(JSON.stringify(output.step![0].safety)).toContain("updated-safety");
      if (!save) expect(JSON.stringify(wire)).toBe(before);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : output;
    }
  });

  it.each(["dose", "component-order"] as const)("keeps stable phase identity for lifted safety after %s component edits", edit => {
    let wire = induction(false, edit === "component-order");
    if (edit === "component-order") wire.step![0].component.reverse();
    wire.step![0].component.find(row => row.id === "induction-dose")!.doseAndRate![0].doseQuantity!.value = 1.5;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0].amount?.value).toBe(2);
      expect(wire.step![0].component.find(row => row.id === "induction-dose")!.doseAndRate![0].doseQuantity!.value).toBe(1.5);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replacement", "split-owner"] as const)("keeps lifted policy on its existing phase after %s component edits", edit => {
    const wire = induction(false);
    if (edit === "replacement") wire.step![0].component[0].id = "replacement-dose";
    else wire.step!.push({ component: [persist(wire.step![0].component[0])] });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    const native = importCanonicalCourse(wire);
    expect(native.safety).toBeUndefined();
    // The exported phase now owns a phase ID. Replacing or duplicating one
    // component does not clear that phase's independently authored policy.
    expect(native.stages[0].safety!.limits![0].amount).toEqual(q(2));
    expect(native.stages[0].safety!.ifExceeded).toBe("Review induction");
    if (edit === "split-owner") expect(native.stages[1].safety).toBeUndefined();
    expect(JSON.stringify(r6Save(wire))).toContain("Review induction");
  });

  it.each(["limit", "action"] as const)("keeps an actual %s edit authoritative", edit => {
    const wire = induction();
    if (edit === "limit") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    else wire.safety!.ifExceeded = "Contact the clinician";
    const native = importCanonicalCourse(wire);
    if (edit === "limit") {
      expect(native.stages[0].safety).toBeUndefined();
      expect(native.safety?.limits?.[0].amount?.value).toBe(3);
    } else {
      expect(native.safety?.ifExceeded).toBe("Contact the clinician");
      expect(native.safety?.limits ?? []).toEqual([]);
      expect(native.stages[0].safety?.limits?.[0].amount?.value).toBe(2);
      expect(native.stages[0].safety?.ifExceeded).toBeUndefined();
    }
  });

  it("keeps an explicit planned pause after a successor cadence edit", () => {
    let wire = toDosageDetails([
      { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } },
      { sequence: 3, doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, frequency: 2 } } },
    ], undefined, { step: [
      { sequence: 1, id: "induction", end: relative(3) },
      { sequence: 2, id: "pause", end: relative(5), extension: [{ url: "urn:test:pause", valueString: "Pause until day six" }] },
      { sequence: 3, id: "maintenance", end: relative(8) },
    ] });
    wire.step![1].component[0].timing!.repeat!.frequency = 1;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([1, 0, 1]);
      expect(native.stages[1].end?.displacement?.value).toBe(5);
      expect(native.stages[2].end?.displacement?.value).toBe(8);
      expect(native.stages[2].administrations[0].schedule?.recurrence?.frequency).toBe(1);
      wire = r6Save(wire);
    }
  });

  it.each([false, true])("retires a qualified occurrence duration when exact core duration replaces it (annotation %s)", annotated => {
    const marker: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      ...(annotated ? { id: "old-duration-note" } : {}),
      valueQuantity: quantityForR5({ value: 90, unit: "min", comparator: "~" })! };
    let wire = toDosageDetails([{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, extension: [marker] } } }]);
    const original = persist(wire.step![0].component[0].timing!.repeat!.extension!.find(item => item.url === marker.url)!);
    expect(importCanonicalCourse(r6Save(wire)).stages[0].administrations[0].schedule?.recurrence)
      .toMatchObject({ occurrenceDuration: 90, occurrenceDurationUnit: "min", occurrenceDurationComparator: "~" });
    const repeat = wire.step![0].component[0].timing!.repeat!;
    repeat.duration = 60; repeat.durationUnit = FhirPeriodUnit.Minute;
    wire = r6Save(wire);
    expect(wire.step![0].component[0].timing!.repeat!.extension?.some(item => item.url === marker.url) ?? false).toBe(false);
    expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBe(60);
    expect(JSON.stringify(wire)).toContain(JSON.stringify(original));
    delete wire.step![0].component[0].timing!.repeat!.duration;
    delete wire.step![0].component[0].timing!.repeat!.durationUnit;
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
      expect(JSON.stringify(wire)).toContain(JSON.stringify(original));
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each([false, true])("retains a disagreeing exact condition bridge as inactive source (annotation %s)", annotated => {
    const stale: FhirDosage = {};
    setDosageCondition(stale, threshold(150));
    const marker = stale.modifierExtension![0];
    if (annotated) marker.id = "condition-note";
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(source, threshold(160));
    const row = toEzDosages([source])[0];
    row.modifierExtension = [marker];
    expect(isExactConditionBridge(marker)).toBe(!annotated);
    const before = JSON.stringify(row);
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(threshold(160));
      const component = wire.step![0].component[0];
      expect(component.modifierExtension?.some(item => item.url === DOSAGE_CONDITION_R5_URL) ?? false).toBe(false);
      expect(JSON.stringify(component.extension)).toContain(JSON.stringify(marker));
      wire = r6Save(wire);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["replace", "clear", "same-r5-value"] as const)("synchronizes lifted condition mirrors for %s", edit => {
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }] };
    setDosageCondition(source, threshold(160));
    source.modifierExtension![0].id = "old-condition-bridge-note";
    const row = persist(toEzDosages([source])[0]);
    row.condition![0].id = "old-native-condition-note";
    if (edit === "same-r5-value") row.condition = [{ ...conditionToR6(threshold(150)), id: "old-native-condition-note" }];
    const expected = edit === "clear" ? undefined : threshold(edit === "same-r5-value" ? 160 : 150);
    setDosageCondition(row, expected);
    expect(getDosageCondition(row)).toEqual(expected);
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      expect(importCanonicalCourse(wire).stages[0].administrations[0].predicate).toEqual(expected);
      expect(JSON.stringify(wire)).toContain("old-native-condition-note");
      expect(JSON.stringify(wire)).toContain("old-condition-bridge-note");
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each([false, true])("keeps calendar predicate ownership explicit during condition edits (new day predicate %s)", explicit => {
    const old = { kind: "state" as const, name: "workday", expected: true, text: "workday" };
    const current = { kind: "state" as const, name: "weekend", expected: true, text: "weekend" };
    const source: FhirDosage = {};
    setDosageCondition(source, old, old);
    const row = persist(toEzDosages([source])[0]);
    setDosageCondition(row, current, explicit ? current : undefined);
    expect(getDosageCondition(row)).toEqual(current);
    expect(getDosageCalendarDayCondition(row)).toEqual(explicit ? current : undefined);
    setDosageCondition(row, undefined);
    expect(getDosageCondition(row)).toBeUndefined();
    expect(getDosageCalendarDayCondition(row)).toBeUndefined();
  });

  it.each(["remove", "add"] as const)("uses a newly submitted PRN reason after trigger phase %s", edit => {
    const phase: FhirExtension = { url: PRN_TRIGGER_PHASE_EXTENSION_URL, valueCode: "onset" };
    const text = edit === "remove" ? "Take 1 tablet at onset of migraine, maximum 2 tablets per dose"
      : "Take 1 tablet as needed for migraine, maximum 2 tablets per dose";
    let rows = toFhirR5Dosages([{ text, doseAndRate: [{ doseQuantity: q(1) }],
      asNeeded: true, asNeededFor: [{ text: "migraine", extension: edit === "remove" ? [phase] : [] }],
      maxDosePerAdministration: q(2) }]);
    formatSig(rows[0]);
    rows = persist(rows);
    rows[0].asNeededFor![0].extension = edit === "remove" ? [] : [phase];
    const before = JSON.stringify(rows[0]);
    for (const row of [rows[0], persist(rows[0])]) {
      const actual = formatSig(row, "long");
      expect(dosageMatchesSavedProjection(row)).toBe(false);
      expect(canonicalFromFhir(row).prn?.reasons?.[0].triggerPhase).toBe(edit === "add" ? "onset" : undefined);
      expect(actual.toLowerCase().includes("onset")).toBe(edit === "add");
      expect(actual.toLowerCase()).toContain("migraine");
    }
    expect(JSON.stringify(rows[0])).toBe(before);
  });

  it("types and preserves the markdown primitive metadata on the R6 instruction header", () => {
    const source: FhirR6DosageInstruction = { renderedInstruction: "Take once daily",
      _renderedInstruction: { id: "authored-header", extension: [{ url: "urn:test:header", valueString: "authored metadata" }] } };
    const before = JSON.stringify(source);
    const imported = fromFhir(source);
    expect(imported.fhirNext._renderedInstruction).toEqual(source._renderedInstruction);
    expect(toDosageDetails(persist(imported.fhir))._renderedInstruction).toEqual(source._renderedInstruction);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("round33 mixed clock carrier ownership", () => {
  const marker = (): FhirExtension => ({ url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, id: "authored-clock-carrier",
    valueTime: "09:00:00", _valueTime: { id: "authored-clock", extension: [{ url: "urn:test:clock", valueString: "authored precision" }] },
    extension: [{ url: "urn:test:clock-envelope", valueString: "retain this note" }] });
  const input = (): FhirDosage => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
    frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, when: [EventTiming.Morning], extension: [marker()],
  } } });

  it("keeps primitive metadata on the current clock carrier and never revives its retired predecessor", () => {
    const row = input(), before = JSON.stringify(row);
    let wire = toDosageDetails([row]);
    const repeat = wire.step![0].component[0].timing!.repeat!;
    expect(repeat.timeOfDay).toBeUndefined();
    expect(repeat._timeOfDay).toBeUndefined();
    expect(repeat.extension).toContainEqual(marker());
    expect(JSON.stringify(row)).toBe(before);
    repeat.timeOfDay = ["10:00:00"];
    repeat._timeOfDay = [{ id: "current-clock" }];
    wire = r6Save(wire);
    const current = wire.step![0].component[0].timing!.repeat!;
    const currentClock = current.extension?.find(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL);
    expect(currentClock?.valueTime).toBe("10:00:00");
    expect(currentClock?._valueTime).toEqual({ id: "current-clock" });
    current.extension = current.extension?.filter(item => item.url !== TIMING_ADDITIONAL_CLOCK_EXTENSION_URL);
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      const current = rows[0].timing!.repeat!;
      expect(current.timeOfDay?.length ?? 0).toBe(0);
      expect(current.extension?.some(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? false).toBe(false);
      expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.clocks?.length ?? 0).toBe(0);
      expect(JSON.stringify(rows)).toContain("retain this note");
      wire = toDosageDetails(rows);
    }
  });

  it.each([false, true])("keeps current explicit core clock edits authoritative (clear %s)", clear => {
    const row = input();
    row.timing!.repeat!.timeOfDay = clear ? [] : ["10:00:00"];
    row.timing!.repeat!._timeOfDay = clear ? [] : [{ id: "current-clock" }];
    let rows = persist(toFhirR5Dosages([row]));
    for (let save = 0; save < 3; save++) {
      const repeat = rows[0].timing!.repeat!;
      const active = repeat.extension?.filter(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? [];
      expect(active.map(item => item.valueTime)).toEqual(clear ? [] : ["10:00:00"]);
      if (!clear) expect(active[0]._valueTime).toEqual({ id: "current-clock" });
      expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.clocks ?? []).toEqual(clear ? [] : ["10:00:00"]);
      expect(JSON.stringify(rows)).toContain("authored-clock-carrier");
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
  });

  it.each(["R5", "R6"] as const)("preserves metadata-only clock tails through %s without inventing an occurrence", boundary => {
    const timing = { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      when: [EventTiming.Morning], timeOfDay: ["09:00:00"],
      _timeOfDay: [null, { id: "unmeasured-clock-note", extension: [
        { url: "urn:test:clock-tail", valueString: "retain without a clock" },
      ] }],
    } };
    const source = boundary === "R5"
      ? [{ doseAndRate: [{ doseQuantity: q(1) }], timing }]
      : course({ timing });
    const before = JSON.stringify(source);
    let wire = projectCanonicalCourse(importCanonicalCourse(source)).fhirNext;
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      for (const candidate of [wire, rows]) {
        expect(JSON.stringify(candidate)).toContain("unmeasured-clock-note");
        expect(JSON.stringify(candidate)).toContain("retain without a clock");
        expect(importCanonicalCourse(candidate).stages[0].administrations[0].schedule?.recurrence?.clocks)
          .toEqual(["09:00:00"]);
        expect(nextDueDoses(candidate, {
          orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
          timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3,
        })).toEqual(["2026-12-01T08:00:00+00:00", "2026-12-01T09:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
      }
      wire = toDosageDetails(rows);
    }
    expect(JSON.stringify(source)).toBe(before);
    delete wire.step![0].component[0].timing!.repeat!.when;
    const withoutAnchor = r6Save(wire);
    expect(JSON.stringify(withoutAnchor)).toContain("unmeasured-clock-note");
    expect(withoutAnchor.step![0].component[0].timing!.repeat!.timeOfDay).toEqual(["09:00:00", null]);
    expect(withoutAnchor.step![0].component[0].timing!.repeat!._timeOfDay)
      .toEqual([null, timing.repeat._timeOfDay[1]]);
    expect(nextDueDoses(withoutAnchor, {
      orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 2,
    })).toEqual(["2026-12-01T09:00:00+00:00", "2026-12-02T09:00:00+00:00"]);
  });

  it("restores core clocks with their primitive metadata after the symbolic event is removed", () => {
    const row = input();
    delete row.timing!.repeat!.when;
    const repeat = toFhirR5Dosages([row])[0].timing!.repeat!;
    expect(repeat.timeOfDay).toEqual(["09:00:00"]);
    expect(repeat._timeOfDay).toEqual([marker()._valueTime]);
    expect(repeat.extension?.some(item => item.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL) ?? false).toBe(false);
  });

  it("uses a newly submitted bridge clock in the public display", () => {
    const text = "Take 1 tablet in the morning and at 09:00";
    let rows = withDosageEditProvenance([{ ...input(), text }], text);
    formatSig(rows[0], "long");
    rows = persist(rows);
    rows[0].timing!.repeat!.extension![0].valueTime = "10:00:00";
    expect(dosageMatchesSavedProjection(rows[0])).toBe(false);
    for (const row of [rows[0], persist(rows[0])]) {
      expect(importCanonicalCourse(row).stages[0].administrations[0].schedule?.recurrence?.clocks).toEqual(["10:00:00"]);
      const displayed = formatSig(row, "long");
      expect(displayed).toContain("10:00");
      expect(displayed).not.toContain("09:00");
    }
  });
});

// Consolidated external R5 ownership and quantity boundary cases.
describe("R5 edit ownership and quantity boundaries", () => {
  it("retains independent course and local step counts through both external boundaries", () => {
    const source = course();
    source.repeatCycle = { value: 7, unit: "d" };
    source.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      id: "course-count" }, { url: "urn:test:count-note", valueString: "retain" }];
    source.step![0].count = 2;
    const native = importCanonicalCourse(source);
    expect(native.cycleCount).toBe(3);
    expect(native.stages[0].count).toBe(2);
    const strict = persist(toFhirR5Dosages(source));
    const reopened = toDosageDetails(strict);
    expect(reopened).toEqual(source);
    expect(getCourseCycleCount(reopened)).toBe(3);
    expect(importCanonicalCourse(strict).cycleCount).toBe(3);
    expect(importCanonicalCourse(strict).stages[0].count).toBe(2);
  });

  it("uses an externally edited course count without changing the local step count", () => {
    const source = course();
    source.repeatCycle = { value: 7, unit: "d" };
    source.modifierExtension = [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }];
    source.step![0].count = 2;
    const edit = persist(fromDosageDetails(source));
    edit.course.modifierExtension![0].valueInteger = 4;
    const changed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(getCourseCycleCount(changed)).toBe(4);
    expect(changed.step![0].count).toBe(2);
    const next = persist(fromDosageDetails(changed));
    next.course.modifierExtension = [];
    const cleared = toDosageDetails(next.dosages, undefined, next.course);
    expect(getCourseCycleCount(cleared)).toBeUndefined();
    expect(importCanonicalCourse(cleared).cycleCount).toBeUndefined();
    expect(cleared.step![0].count).toBe(2);
    expect(getCourseCycleCount(toDosageDetails(persist(toFhirR5Dosages(cleared)))))
      .toBeUndefined();
  });

  it("distinguishes an omitted step list from removal of a fieldless empty stage", () => {
    const wire = toDosageDetails([{ sequence: 2, doseAndRate: [{ doseQuantity: q(1) }] }],
      undefined, { step: [{ sequence: 1 }] });
    const edit = persist(fromDosageDetails(wire));
    expect(edit.course.step).toContainEqual({ sequence: 1 });
    const omitted = { ...edit.course };
    delete omitted.step;
    expect(importCanonicalCourse(toDosageDetails(edit.dosages, undefined, omitted)).stages)
      .toHaveLength(2);
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    for (const current of [removed, toDosageDetails(persist(toFhirR5Dosages(removed)))]) {
      const stages = importCanonicalCourse(current).stages;
      expect(stages).toHaveLength(1);
      expect(stages[0].administrations).toHaveLength(1);
      expect(stages[0].administrations[0].amounts![0]).toMatchObject({ quantity: { value: 1, unit: "tab" } });
    }
  });

  it("removes the final metadata-only carrier stage without losing its raw annotations", () => {
    const wire = toDosageDetails([], undefined, { step: [{ sequence: 1, id: "draft",
      extension: [{ url: "urn:test:draft-source", valueString: "keep original" }] }] });
    const edit = persist(fromDosageDetails(wire));
    edit.course.step = [];
    const removed = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(removed.step).toBeUndefined();
    expect(importCanonicalCourse(removed).stages).toEqual([]);
    const annotation = { url: "urn:test:draft-source", valueString: "keep original" };
    expect(JSON.stringify(removed.extension)).toContain(JSON.stringify(annotation));
    const saved = persist(fromDosageDetails(removed));
    const reopened = toDosageDetails(saved.dosages, undefined, saved.course);
    expect(importCanonicalCourse(reopened).stages).toEqual([]);
    expect(JSON.stringify(reopened.extension)).toContain(JSON.stringify(annotation));
  });

  it.each([false, true])("applies edited R5 maxima when unchanged lifted safety remains (metadata %s)", rich => {
    const safety = {
      doseLimit: [
        { scope: "administration" as const, valueQuantity: q(4),
          ...(rich ? { id: "numeric-limit", extension: [{ url: "urn:test:limit", valueString: "keep" }] } : {}) },
        ...(rich ? [{ scope: "dosage" as const, valueInteger: 3, text: "three administrations" }] : []),
      ],
      ...(rich ? { ifExceeded: "call" } : {}),
    };
    const edit = persist(fromDosageDetails(course({ safety })));
    edit.dosages[0].maxDosePerAdministration!.value = 2;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].safety!;
    expect(actual.doseLimit).toEqual([
      { ...safety.doseLimit[0], valueQuantity: q(2) }, ...safety.doseLimit.slice(1),
    ]);
    if (rich) {
      expect(actual.doseLimit).toContainEqual(safety.doseLimit[1]);
      expect(actual.ifExceeded).toEqual(safety.ifExceeded);
      expect(actual.doseLimit![0]).toMatchObject({ id: "numeric-limit",
        extension: [{ url: "urn:test:limit", valueString: "keep" }] });
    }
  });

  it.each(["lifetime", "period"] as const)("reconciles the changed %s maximum without reviving the lifted copy", scope => {
    const source = course({ safety: { doseLimit: [{
      scope, valueQuantity: q(4), ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
    }] } });
    const edit = persist(fromDosageDetails(source));
    if (scope === "period") edit.dosages[0].maxDosePerPeriod![0].numerator!.value = 2;
    else edit.dosages[0].maxDosePerLifetime!.value = 2;
    const output = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(output.step![0].component[0].safety!.doseLimit).toEqual([{
      scope, valueQuantity: q(2), ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
    }]);
  });

  it("keeps an explicitly edited lifted safety value authoritative", () => {
    const edit = persist(fromDosageDetails(course({
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] },
    })));
    edit.dosages[0].maxDosePerAdministration!.value = 2;
    edit.dosages[0].safety!.doseLimit![0].valueQuantity!.value = 3;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0];
    expect(actual.safety!.doseLimit![0].valueQuantity!.value).toBe(3);
  });

  it("removes a deleted R5 maximum and preserves unrelated R6-only safety", () => {
    const edit = persist(fromDosageDetails(course({
      safety: { ifExceeded: "call", doseLimit: [
        { scope: "administration", valueQuantity: q(4) },
        { scope: "dosage", valueInteger: 3 },
      ] },
    })));
    delete edit.dosages[0].maxDosePerAdministration;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].safety!;
    expect(actual.doseLimit).toEqual([{ scope: "dosage", valueInteger: 3 }]);
    expect(actual.ifExceeded).toEqual("call");
  });

  const legacyExpressionRow = (): EzDosage => ({
    sequence: 1,
    doseAndRate: [{ type: { text: "calculated" } }],
    modifierExtension: [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{ url: "step", extension: [{
        url: "component", extension: [{ url: "doseAndRate", extension: [
          { url: "type", valueCodeableConcept: { text: "calculated" } },
          { url: "doseExpression", valueExpression: { language: "text/fhirpath", expression: "%oldDose" } },
          { url: "rateExpression", valueExpression: { language: "text/fhirpath", expression: "%oldRate" } },
        ] }],
      }] }] }],
    }],
  });
  it.each(["doseExpression", "rateExpression"] as const)(
    "honors a live %s edit under the full retained-course bridge", field => {
      const row = legacyExpressionRow();
      row.doseAndRate![0][field] = { language: "text/fhirpath", expression: "%edited" };
      const actual = toDosageDetails([row]).step![0].component[0].doseAndRate![0];
      expect(actual[field]!.expression).toBe("%edited");
      const untouched = field === "doseExpression" ? "rateExpression" : "doseExpression";
      expect(actual[untouched]!.expression).toBe(field === "doseExpression" ? "%oldRate" : "%oldDose");
    }
  );
  it("restores absent strict-R5 expressions while respecting an explicit editable clear", () => {
    const strict = legacyExpressionRow();
    expect(toDosageDetails([strict]).step![0].component[0].doseAndRate![0]).toMatchObject({
      doseExpression: { expression: "%oldDose" }, rateExpression: { expression: "%oldRate" },
    });
    strict.doseAndRate![0].doseExpression = undefined;
    const cleared = toDosageDetails([strict]).step![0].component[0].doseAndRate![0];
    expect(cleared.doseExpression).toBeUndefined();
    expect(cleared.rateExpression!.expression).toBe("%oldRate");
  });
  it("honors explicit expression clearing under the compact bridge", () => {
    const edit = fromDosageDetails({ step: [{ component: [{
      doseAndRate: [{ doseExpression: { expression: "%dose" }, rateExpression: { expression: "%rate" } }],
    }] }] });
    edit.dosages[0].doseAndRate![0].doseExpression = undefined;
    const actual = toDosageDetails(edit.dosages, undefined, edit.course).step![0].component[0].doseAndRate![0];
    expect(actual.doseExpression).toBeUndefined();
    expect(actual.rateExpression!.expression).toBe("%rate");
  });

  it("keeps a persist deletion of an editable expression distinct from a strict R5 omission", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseExpression: { expression: "%dose" }, rateExpression: { expression: "%rate" } }],
    }] }] };
    const edit = persist(fromDosageDetails(source));
    delete edit.dosages[0].doseAndRate![0].doseExpression;
    const reopened = toDosageDetails(persist(edit.dosages), undefined, edit.course);
    expect(reopened.step![0].component[0].doseAndRate![0].doseExpression).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].rateExpression!.expression).toBe("%rate");
    const strict = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(strict.step![0].component[0].doseAndRate![0].doseExpression!.expression).toBe("%dose");
  });

  it("does not combine stale row text with a current text-only edit", () => {
    const edit = persist(fromDosageDetails({
      renderedInstruction: "Two administration times were prescribed",
      step: [{ component: [
        { text: "Take one in morning", doseAndRate: [{ doseQuantity: q(1) }] },
        { text: "Take one in evening", doseAndRate: [{ doseQuantity: q(1) }] },
      ] }],
    }));
    edit.dosages[0].doseAndRate![0].doseQuantity!.value = 2;
    edit.dosages[1].text = "Take one at bedtime";
    const actual = toDosageDetails(edit.dosages, undefined, edit.course);
    expect(actual.renderedInstruction).toBeUndefined();
    expect(actual.step![0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(actual.step![0].component[0].text).toBeUndefined();
    expect(actual.step![0].component[1].text).toBe("Take one at bedtime");
    const retiredRows: ReturnType<typeof decodeR5RetainedFields>[] = [];
    for (const item of actual.extension ?? []) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
      for (const source of item.extension ?? []) if (source.url === DOSAGE_DETAILS_R5_URL)
        retiredRows.push(decodeR5RetainedFields(source));
    expect(retiredRows).toContainEqual({ rowIndex: 0, sequence: 1, component: { text: "Take one in morning" } });
  });
  it("honors whole-course text-only edits while all row text remains current", () => {
    const edit = persist(fromDosageDetails({
      renderedInstruction: "Original wording",
      step: [{ component: [
        { text: "Take one morning", doseAndRate: [{ doseQuantity: q(1) }] },
        { text: "Take one evening", doseAndRate: [{ doseQuantity: q(1) }] },
      ] }],
    }));
    edit.dosages[1].text = "Take one bedtime";
    expect(toDosageDetails(edit.dosages, undefined, edit.course).renderedInstruction)
      .toBe("Take one morning; Take one bedtime");
  });

  it("retires an old marker after the final retained timing offset is cleared", () => {
    const rows = toFhirR5Dosages(course({ timing: { repeat: {
      frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: { value: 8, unit: "h", code: "h" },
    } } }));
    const changed = persist(rows);
    // Changing the live period retires offsets tied to its old window.
    changed[0].timing!.repeat!.period = 2;
    const output = toFhirR5Dosages(changed);
    expect(toDosageDetails(output).step![0].component[0].timing!.repeat!.startOffset).toBeUndefined();
    // Returning to the earlier cadence later must not revive a retired marker.
    output[0].timing!.repeat!.period = 1;
    const next = toDosageDetails(persist(output)).step![0].component[0];
    expect(next.timing!.repeat!.period).toBe(1);
    expect(next.timing!.repeat!.startOffset).toBeUndefined();
    expect(toDosageDetails(rows).step![0].component[0].timing!.repeat!.startOffset).toMatchObject({ value: 8 });
  });

  it.each([false, true])("retains a high-only approximate course length (anchored %s)", anchored => {
    const high = simpleQuantityForR5({ value: 7, code: "d", unit: "days", comparator: "~" })!;
    const row: FhirDosage = {
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        ...(anchored ? { boundsPeriod: { start: "2026-11-20" } } : { boundsRange: { high } }),
      } },
      ...(anchored ? { modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, valueRange: { high } }] } : {}),
    };
    const output = canonicalToFhir(canonicalFromFhir(row));
    const bound = anchored
      ? output.modifierExtension!.find(value => value.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!.valueRange!
      : output.timing!.repeat!.boundsRange!;
    expect(bound.low).toBeUndefined();
    expect(bound.high!.value).toBe(7);
    expect(getQuantityComparator(bound.high)).toBe("~");
    expect(output.timing!.repeat!.frequency).toBe(1);
    if (anchored) expect(output.timing!.repeat!.boundsPeriod!.start).toBe("2026-11-20");
  });

  it("keeps both equal-valued course bounds when only the lower endpoint is qualified", () => {
    const row: FhirDosage = { timing: { repeat: { boundsRange: {
      low: simpleQuantityForR5({ value: 7, unit: "days", code: "d", comparator: "~" }),
      high: { value: 7, unit: "days", code: "d" },
    } } } };
    const bound = canonicalToFhir(canonicalFromFhir(row)).timing!.repeat!.boundsRange!;
    expect(bound.low!.value).toBe(7);
    expect(getQuantityComparator(bound.low)).toBe("~");
    expect(bound.high!.value).toBe(7);
    expect(getQuantityComparator(bound.high)).toBeUndefined();
  });

  it.each(["<", "<=", ">", ">=", "~"] as const)("does not create edit history for an unchanged scalar %s roundtrip", comparator => {
    const source = course({ doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator }) }] });
    const reopened = toDosageDetails(persist(toFhirR5Dosages(source)));
    expect(getQuantityComparator(reopened.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(reopened).toEqual(source);
    expect(reopened.extension).toBeUndefined();
    expect(reopened.step![0].component[0].doseAndRate![0].doseQuantity).not.toHaveProperty("comparator");
  });

  it("shows qualified R5 range endpoints in the clinician preview", () => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: simpleQuantityForR5({ value: 500, unit: "mg", comparator: "~" }),
      high: { value: 1000, unit: "mg" },
    } }] };
    const text = formatSig(row, "long", { locale: "en", realizationMode: "normalized" });
    expect(text).toMatch(/(?:about|approximately|~)\s*500/i);
    expect(text).toContain("1000");
    expect(text).toContain("mg");
  });

  it("does not generate a redundant R5 comparator fallback beside unrelated metadata", () => {
    const extension: FhirExtension = { url: "urn:test:note", valueString: "keep" };
    const projected = quantityForR5({ value: 7, unit: "d", comparator: "<", extension: [extension] })!;
    expect(projected).toEqual({ value: 7, unit: "d", comparator: "<", extension: [extension] });
    delete projected.comparator;
    expect(quantityFromR5(projected)!.comparator).toBeUndefined();
  });
  it("keeps a native operator active and its enriched previous EMA annotation inert", () => {
    const authored = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, id: "operator", valueCoding: {
      system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", display: "approximately equal to",
    } };
    const note = { url: "urn:test:note", valueString: "keep" };
    const projected = quantityForR5({ value: 7, comparator: "<=", extension: [authored, note] })!;
    expect(projected.comparator).toBe("<=");
    expect(projected.extension).toEqual([
      { url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [authored] }, note,
    ]);
    delete projected.comparator;
    expect(getQuantityComparator(projected)).toBeUndefined();
  });
});

describe("round34 interchange current clinical ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 10 };
  const boundary = (days: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value: days, unit: "d" } });

  it("retires the saved missing-predecessor reason when its real first phase is restored", () => {
    const input: FhirR6DosageInstruction = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 3 } } }] },
      { start: { contextCode: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day" }] } },
        component: [{ doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, count: 1 } } }] },
    ] };
    const original = persist(toFhirR5Dosages(input));
    const incomplete = persist(toFhirR5Dosages(toDosageDetails(original.slice(1))));
    expect(() => nextDueDoses(incomplete, options)).toThrow(/complete dosage array/i);
    let restored = [original[0], ...incomplete];
    for (let save = 0; save < 3; save++) {
      expect(nextDueDoses(restored, options).map(value => new Date(value).toISOString())).toEqual([
        "2026-11-21T08:00:00.000Z", "2026-11-22T08:00:00.000Z",
        "2026-11-23T08:00:00.000Z", "2026-11-24T08:00:00.000Z",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: restored, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(5);
      expect(importCanonicalCourse(restored).stages[1].administrations[0].missingContexts).toBeUndefined();
      restored = persist(toFhirR5Dosages(toDosageDetails(restored)));
    }
    expect(JSON.stringify(toDosageDetails(restored).extension)).toContain("predecessor");
  });

  it.each([false, true])("keeps mixed saved R5 count meanings unresolved in either row order (%s)", reverse => {
    // Actual former writer's first-stage course count shape, combined with a
    // current explicitly step-scoped row from the same persisted course.
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [
      { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
      { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
      { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
      { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
    ] };
    const old: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { ...daily, boundsDuration: { value: 7, unit: "d", code: "d" } } }, modifierExtension: [marker] };
    const current = persist(old);
    current.modifierExtension![0].extension![0].valueInteger = 1;
    current.modifierExtension![0].extension!.push({ url: "countScope", valueCode: "step" });
    let rows = reverse ? [current, old] : [old, current];
    for (let save = 0; save < 3; save++) {
      expect(() => nextDueDoses(rows, { ...options, limit: 50 })).toThrow(/conflicting|complete dosage array|resolve/i);
      expect(() => calculateTotalUnits({ ...options, dosage: rows, durationValue: 42, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/conflicting|complete dosage array|resolve/i);
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    const resolved = toDosageDetails(rows, undefined, { step: [{ sequence: 1, count: 1 }],
      modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] }, { resolvedPhaseSequences: [1] });
    const actual = nextDueDoses(resolved, { ...options, limit: 100 });
    expect(actual).toHaveLength(42); // two members, three seven-day active blocks
    expect(new Set(actual).size).toBe(21);
    expect(new Date(actual[41]).toISOString()).toBe("2026-12-25T08:00:00.000Z");
    expect(calculateTotalUnits({ ...options, dosage: resolved, durationValue: 42, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    expect(JSON.stringify(resolved.extension)).toContain("72f2f03d1f8289c5");
  });

  it("does not move an unidentified phase policy with its member into a new identified phase", () => {
    let wire = toDosageDetails([{ id: "original-member", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } }],
      undefined, { step: [{ sequence: 1, safety: {
        doseLimit: [{ scope: "administration", valueQuantity: q(2) }], ifExceeded: "Review the original phase",
      } }] });
    wire.step = [{ id: "replacement-phase", component: wire.step![0].component }];
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety).toBeUndefined();
      expect(JSON.stringify(r6Save(wire).extension)).toContain("Review the original phase");
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replace", "clear", "stale-mirror"] as const)("synchronizes the lifted date owner on setter %s", edit => {
    const row: EzDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };
    setDosageExcludedDates(row, ["2026-11-22"]);
    row.excludedDates = ["2026-11-22"];
    if (edit === "stale-mirror") row.excludedDates = ["2026-11-23"];
    const dates = edit === "clear" ? [] : edit === "replace" ? ["2026-11-23"] : ["2026-11-22"];
    setDosageExcludedDates(row, dates);
    expect(getDosageExcludedDates(row)).toEqual(dates);
    const expected = ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"].filter(day => dates.indexOf(day) < 0);
    expect(nextDueDoses(row, { ...options, limit: expected.length }).map(value => value.slice(0, 10))).toEqual(expected);
    const wire = toDosageDetails([row]);
    expect(getDosageExcludedDates({ modifierExtension: wire.step![0].component[0].modifierExtension })).toEqual(dates);
  });

  it.each(["value", "period", "scope", "action", "expression"] as const)("uses a newly submitted lifted safety %s edit in the preview", edit => {
    const row: EzDosage = { text: "Take one tablet daily; maximum four tablets per dose.",
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] } };
    if (edit === "period") row.safety!.doseLimit![0] = { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" } };
    if (edit === "expression") row.safety!.doseLimit![0] = { scope: "administration", valueExpression: expression("originalLimit") };
    let saved = persist(withDosageEditProvenance([row], row.text)[0]);
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    expect(formatSig(saved, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(row.text);
    saved = persist(saved);
    if (edit === "value") saved.safety!.doseLimit![0].valueQuantity!.value = 2;
    else if (edit === "period") saved.safety!.doseLimit![0].period!.value = 2;
    else if (edit === "scope") saved.safety!.doseLimit![0].scope = "lifetime";
    else if (edit === "action") saved.safety!.ifExceeded = "Contact the clinician";
    else saved.safety!.doseLimit![0].valueExpression!.expression = "%currentLimit";
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    const warm = formatSig(saved, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(warm).toBe(formatSig(persist(saved), "long", { locale: "en", realizationMode: "roundtrip" }));
    expect(warm).not.toBe(row.text);
    if (edit === "value") expect(warm).toContain("2 tab");
    if (edit === "action") expect(warm).toContain("Contact the clinician");
  });

  it("keeps a primitive-metadata-only R6 header as a header without inventing a dosage", () => {
    const input = { _renderedInstruction: { id: "instruction-annotation", extension: [
      { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" },
    ] } };
    let current: FhirR6DosageInstructionInput = input;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(current);
      expect(native.stages).toEqual([]);
      const output = projectCanonicalCourse(native).fhirNext;
      expect(output._renderedInstruction).toEqual(input._renderedInstruction);
      expect(output.step).toBeUndefined();
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : persist(output);
    }
  });

  it.each(["unchanged", "replace", "clear"] as const)("preserves rate wrapper annotations while current modifier %s owns the value", edit => {
    const original = { url: "urn:test:rate-policy", valueString: "Original clinical rate policy" };
    const replacement = { url: "urn:test:rate-policy", valueString: "Replacement clinical rate policy" };
    const wrapper = { id: "authored-rate-wrapper", url: R5_RATE_MODIFIERS_R6_URL, extension: [original] };
    const input = course({ doseAndRate: [{ doseQuantity: q(1), extension: [wrapper, { url: "urn:test:rate-note", valueString: "Keep rate note" }] }] });
    let rows = persist(toFhirR5Dosages(input));
    if (edit !== "unchanged") rows[0].doseAndRate![0].modifierExtension = edit === "replace" ? [replacement] : [];
    for (let save = 0; save < 3; save++) {
      const output = toDosageDetails(rows);
      const rate = output.step![0].component[0].doseAndRate![0];
      const active = rate.extension?.find(marker => marker.url === R5_RATE_MODIFIERS_R6_URL);
      if (edit === "clear") {
        expect(active).toBeUndefined();
        expect(JSON.stringify(rate.extension)).toContain("authored-rate-wrapper");
      } else expect(active).toEqual({ ...wrapper, extension: [edit === "replace" ? replacement : original] });
      expect(rate.extension).toContainEqual({ url: "urn:test:rate-note", valueString: "Keep rate note" });
      rows = persist(toFhirR5Dosages(output));
    }
  });

  it("retains a displaced authored course count without rewriting it to the first value", () => {
    const first = { id: "authoritative-count", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 2 };
    const second = { id: "displaced-count", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      extension: [{ url: "urn:test:count-note", valueString: "Second authored cycle count" }] };
    const unknown = { url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueString: "unresolved authored value" };
    let current: FhirR6DosageInstruction = { ...course({ timing: { repeat: { ...daily, count: 1 } } }),
      repeatCycle: { value: 7, unit: "d" }, modifierExtension: [first, second, unknown] };
    for (let save = 0; save < 3; save++) {
      const output = r6Save(current);
      expect(output.modifierExtension).toEqual([first, unknown]);
      expect(output.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [second] });
      expect(nextDueDoses(output, options).map(value => value.slice(0, 10))).toEqual(["2026-11-21", "2026-11-28"]);
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(output))) : output;
    }
  });

  it("retains independent phase start and end with their authored wrapper annotations", () => {
    const start = { ...boundary(2), id: "component-start" }, end = { ...boundary(35), id: "component-cutoff" };
    const marker = encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start, end }, "step");
    marker.id = "phase-window";
    marker.extension!.push({ url: "urn:test:phase-note", valueString: "Independent member interval" });
    let current = course({ modifierExtension: [marker], timing: { repeat: daily } });
    for (let save = 0; save < 3; save++) {
      const member = importCanonicalCourse(current).stages[0].administrations[0];
      expect(member.phaseStart?.displacement?.value).toBe(2);
      expect(member.phaseEnd?.displacement?.value).toBe(35);
      current = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(current))) : r6Save(current);
      expect(current.step![0].component[0].modifierExtension).toContainEqual(marker);
    }
  });
});


describe("round35 interchange field ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const ucum = "http://unitsofmeasure.org";

  it.each(["~", "<", ">="] as const)("preserves the decoded %s denominator beside an approximate rate numerator", comparator => {
    const source = course({ doseAndRate: [{ rateRatio: {
      numerator: { value: 5, unit: "mL", comparator: "~" },
      denominator: simpleQuantityForR5({ value: 1, unit: "h", comparator }),
    } }] });
    let rows = persist(toFhirR5Dosages(source));
    for (let save = 0; save < 3; save++) {
      const amount = importCanonicalCourse(rows).stages[0].administrations[0].amounts![0];
      expect(amount.rateRatio?.numerator).toMatchObject({ value: 5, comparator: "~" });
      expect(amount.rateRatio?.denominator).toMatchObject({ value: 1, comparator });
      rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    }
    rows[0].doseAndRate![0].rateRatio!.denominator = simpleQuantityForR5({ value: 2, unit: "h", comparator: "<=" })!;
    expect(importCanonicalCourse(rows).stages[0].administrations[0].amounts![0].rateRatio?.denominator)
      .toMatchObject({ value: 2, comparator: "<=" });
  });

  it("keeps a lifted anonymous phase maximum after a live dose amount edit", () => {
    let wire = r6Save({ step: [{ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3), text: "Phase maximum" }] },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] });
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const source = JSON.stringify(wire);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety?.limits?.[0]).toMatchObject({ amount: { value: 3 }, text: "Phase maximum" });
      expect(native.stages[0].administrations[0].amounts![0].quantity?.value).toBe(2);
      if (!save) expect(JSON.stringify(wire)).toBe(source);
      wire = save === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["replace", "duplicate"] as const)("does not attach a lifted anonymous phase maximum to a %s owner", edit => {
    const wire = r6Save({ step: [{ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3), text: "Old phase limit" }] },
      component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }] });
    if (edit === "replace") wire.step = [{ component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] }];
    else wire.step!.push(persist(wire.step![0]));
    const native = importCanonicalCourse(wire);
    expect(native.safety).toBeUndefined();
    for (const stage of native.stages) expect(stage.safety).toBeUndefined();
    expect(JSON.stringify(r6Save(wire).extension)).toContain("Old phase limit");
  });

  it.each(["date", "day"] as const)("clears every duplicate %s restriction while retaining source annotations", kind => {
    const url = kind === "date" ? DOSAGE_EXCLUDED_DATES_R5_URL : DOSAGE_EXCLUDED_WEEKDAYS_R5_URL;
    const markers: FhirExtension[] = [0, 1].map(index => ({ id: "calendar-" + index, url,
      extension: [{ id: "value-" + index, url: kind,
        ...(kind === "date" ? { valueDate: "2026-11-2" + (2 + index) } : { valueCode: index ? "tue" : "mon" }) }] }));
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      ...(kind === "date" ? { modifierExtension: markers } : { extension: markers }) };
    if (kind === "date") setDosageExcludedDates(row, []);
    else setDosageExcludedWeekdays(row, []);
    expect((kind === "date" ? row.modifierExtension : row.extension)?.some(item => item.url === url)).toBeFalsy();
    if (kind === "date") expect(getDosageExcludedDates(row)).toEqual([]);
    const retained: FhirExtension[] = [];
    for (const item of row.extension!) if (item.url === DOSAGE_RECONCILIATION_SOURCE_URL) retained.push(...(item.extension ?? []));
    expect(retained).toEqual(expect.arrayContaining(markers));
    const wire = toDosageDetails(persist([row]));
    for (const marker of markers) expect(JSON.stringify(wire)).toContain(marker.id);
  });

  it("reconciles duplicate calendar sources without replacing an unchanged primary wrapper", () => {
    const first: FhirExtension = { id: "primary", url: DOSAGE_EXCLUDED_DATES_R5_URL,
      extension: [{ url: "date", valueDate: "2026-11-22" }] };
    const second: FhirExtension = { id: "duplicate", url: DOSAGE_EXCLUDED_DATES_R5_URL,
      extension: [{ url: "date", valueDate: "2026-11-23" }] };
    const row: FhirDosage = { modifierExtension: [first, second] };
    setDosageExcludedDates(row, ["2026-11-22"]);
    expect(row.modifierExtension).toEqual([first]);
    expect(row.modifierExtension![0]).toBe(first);
    expect(row.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [second] });
  });

  it.each(["period", "unit"] as const)("keeps distinct ID-less %s limit text after both amounts are edited", identity => {
    const limits = [
      { scope: "period" as const, valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "Daily ceiling" },
      { scope: "period" as const, valueQuantity: { value: 12, unit: identity === "unit" ? "mL" : "tab" },
        period: { value: identity === "period" ? 7 : 1, unit: "d" }, text: "Independent ceiling" },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 3;
    rows[0].maxDosePerPeriod![1].numerator!.value = 10;
    rows[0].maxDosePerPeriod!.reverse();
    let wire = toDosageDetails(rows);
    const expected = [{ ...limits[1], valueQuantity: { ...limits[1].valueQuantity, value: 10 } }, { ...limits[0], valueQuantity: q(3) }];
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety!.doseLimit).toEqual(expected);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it("keeps ambiguous old period-limit text inactive and recoverable", () => {
    const limits = [
      { scope: "period" as const, valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "First old ceiling" },
      { scope: "period" as const, valueQuantity: q(5), period: { value: 1, unit: "d" }, text: "Second old ceiling" },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 2;
    rows[0].maxDosePerPeriod![1].numerator!.value = 3;
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety!.doseLimit!.map(limit => limit.text)).toEqual([undefined, undefined]);
      expect(wire.step![0].component[0].safety!.doseLimit!.map(limit => limit.valueQuantity!.value)).toEqual([2, 3]);
      const retained = JSON.stringify(wire.extension);
      expect(retained).toContain("First old ceiling");
      expect(retained).toContain("Second old ceiling");
      expect(wire.step![0].component[0].safety!.extension).toBeUndefined();
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it("clears active safety while retaining the removed final limit in inactive source", () => {
    const original = course({ safety: { doseLimit: [{ scope: "administration", valueQuantity: q(3),
      text: "Authored maximum removed by clinician" }] } });
    const rows = persist(fromDosageDetails(original).dosages);
    delete rows[0].maxDosePerAdministration;
    let wire = toDosageDetails(rows);
    for (let save = 0; save < 3; save++) {
      expect(wire.step![0].component[0].safety).toBeUndefined();
      const member = importCanonicalCourse(wire).stages[0].administrations[0];
      expect(member.safety).toBeUndefined();
      expect(member.limits).toBeUndefined();
      expect(JSON.stringify(wire.extension)).toContain("Authored maximum removed by clinician");
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([["h", 48, "d", 3], ["mo", 1, "wk", 6]] as const)(
    "keeps the prescriber's active range (%s, %s, %s, %s) in R5 and R6", (lowUnit, lowValue, highUnit, highValue) => {
      const range = { id: "authored-duration", low: { value: lowValue, unit: lowUnit, code: lowUnit, system: ucum, _unit: { id: "low-label" } },
        high: { value: highValue, unit: highUnit, code: highUnit, system: ucum } };
      const input = course({ timing: { repeat: { ...daily, boundsRange: { id: range.id, low: range.low } } },
        modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
          { url: "low", valueQuantity: range.low }, { url: "high", valueQuantity: range.high },
          retainField("rangeMetadata", { id: range.id }),
        ] }] });
      const before = persist(input);
      let wire = input;
      for (let save = 0; save < 3; save++) {
        const projected = projectCanonicalCourse(importCanonicalCourse(wire));
        expectActiveMixedDuration(projected.fhir[0], range);
        expectActiveMixedDuration(projected.fhirNext.step![0].component[0], range);
        for (const current of [projected.fhir, projected.fhirNext])
          expect(importCanonicalCourse(current).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
            .toEqual(range);
        wire = toDosageDetails(persist(projected.fhir));
      }
      expect(input).toEqual(before);
    });

  it("preserves current duration endpoints and their independently supplied modifier annotations", () => {
    const low = { value: 48, unit: "hours", code: "h", system: ucum, _unit: { id: "hour-label" } };
    const high = { value: 3, unit: "days", code: "d", system: ucum };
    const note = { url: "urn:test:duration-note", valueString: "Duration annotation" };
    const marker: FhirExtension = { id: "duration-source-id", url: ANCHORED_COURSE_DURATION_EXTENSION_URL,
      extension: [{ url: "low", valueQuantity: low }, { url: "high", valueQuantity: high }, note] };
    const input = course({ timing: { repeat: { boundsRange: { low } } }, modifierExtension: [marker] });
    const before = persist(input);
    let wire = input;
    for (let save = 0; save < 3; save++) {
      wire = r6Save(wire);
      const row = wire.step![0].component[0];
      expectActiveMixedDuration(row, { low, high });
      const current = row.modifierExtension!.find(value => value.url === ANCHORED_COURSE_DURATION_EXTENSION_URL)!;
      expect(current.id).toBe("duration-source-id");
      expect(current.extension).toContainEqual(note);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange)
        .toEqual({ low, high });
    }
    expect(input).toEqual(before);
  });

  it("restores metadata-only comparator primitives without inventing an operator", () => {
    const original = { value: 2, unit: "tab", _comparator: { id: "operator-slot",
      extension: [{ url: "urn:test:operator-note", valueString: "Pending operator" }] } };
    let current = original;
    for (let save = 0; save < 3; save++) {
      const simple = simpleQuantityForR5(current)!;
      expect(simple).not.toHaveProperty("comparator");
      expect(simple).not.toHaveProperty("_comparator");
      current = quantityFromR5(persist(simple))! as typeof original;
      expect(current._comparator).toEqual(original._comparator);
      expect(current).not.toHaveProperty("comparator");
    }
  });

  it("does not select among conflicting metadata-only comparator source markers", () => {
    const first = simpleQuantityForR5({ value: 2, _comparator: { id: "first-slot" } })!;
    const second = simpleQuantityForR5({ value: 2, _comparator: { id: "second-slot" } })!;
    const mixed = { ...first, extension: [...first.extension!, ...second.extension!] };
    expect(quantityFromR5(mixed)).toEqual(mixed);
  });

  it.each(["100000000049", "100000000052", "unrecognized"])("does not attach metadata-only comparator source to a live operator %s", code => {
    const simple = simpleQuantityForR5({ value: 2, _comparator: { id: "empty-operator-slot" } })!;
    simple.extension!.push({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } });
    const restored = quantityFromR5(simple)!;
    expect(restored._comparator).toBeUndefined();
    expect(JSON.stringify(restored.extension)).toContain("empty-operator-slot");
    expect(restored.comparator).toBe(code === "100000000052" ? "<=" : undefined);
  });

  it("retains a compatible authored method alias and its primitive translation", () => {
    const swallow = parseSig("Swallow 1 tablet daily").fhir[0].method!.coding!;
    const translation = { id: "authored-method-text", extension: [{ url: "urn:test:translation", valueString: "กลืน" }] };
    const row: FhirDosage = { method: { text: "Swallowing", _text: translation, coding: swallow } };
    expect(canonicalFromFhir(row).method).toMatchObject({ text: "Swallowing", _text: translation });
    row.method!.coding = parseSig("Chew 1 tablet daily").fhir[0].method!.coding!;
    const edited = canonicalFromFhir(row).method!;
    expect(edited.text).toBe("Chew");
    expect(edited._text).toBeUndefined();
  });

  it.each([{ clocks: [] as string[] }, { clocks: ["09:00:00"] }])("retires the mixed clock bridge on an explicit core edit $clocks", ({ clocks }) => {
    const row = persist(toFhirR5Dosages(course({ timing: { repeat: { ...daily, when: [EventTiming.Breakfast], timeOfDay: ["08:00:00"] } } }))[0]);
    const marker = row.timing!.repeat!.extension!.find(value => value.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL)!;
    marker.id = "old-clock-source";
    row.timing!.repeat!.timeOfDay = clocks;
    const projected = projectCanonicalCourse(importCanonicalCourse(row));
    for (const wire of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
      const repeat = wire.timing!.repeat!;
      expect(repeat.when).toEqual([EventTiming.Breakfast]);
      // An explicit [] is already a correct edit signal. Do not erase it only
      // for wire-schema neatness; the old bridge is inactive in either case.
      expect(repeat.timeOfDay).toEqual(clocks.length ? undefined : []);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.clocks ?? []).toEqual(clocks);
      expect(repeat.extension?.filter(value => value.url === TIMING_ADDITIONAL_CLOCK_EXTENSION_URL).map(value => value.valueTime) ?? []).toEqual(clocks);
      expect(JSON.stringify(repeat.extension)).toContain("old-clock-source");
    }
  });

  it("uses a newly submitted asNeededBoolean in a capped scheduled preview", () => {
    const parsed = parseSig("Take 1 tablet daily, maximum 2 tablets per day");
    const row = persist(parsed.fhir[0]) as FhirDosage & { asNeededBoolean?: boolean };
    expect(row.text).toBeTruthy();
    row.asNeededBoolean = true;
    expect(fromFhirDosage(row).longText).toMatch(/as needed/i);
    expect(formatSig(row, "long")).toMatch(/as needed/i);
  });

  it.each([true, false])("keeps explicit asNeeded %s authoritative over the alternative R5 spelling", asNeeded => {
    const row: FhirDosage & { asNeededBoolean?: boolean } = { asNeeded, asNeededBoolean: !asNeeded,
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };
    expect(importCanonicalCourse(row).stages[0].administrations[0].asNeeded).toBe(asNeeded);
  });

  it.each(["doseExpression", "rateExpression"] as const)("uses newly submitted %s edits instead of the saved baseline", field => {
    const row: EzDosage = { text: "Use the specified expression.", doseAndRate: [{ [field]: expression("original") }] };
    let saved = persist(withDosageEditProvenance([row], row.text)[0]) as EzDosage;
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    saved = persist(saved);
    saved.doseAndRate![0][field]!.expression = "%current";
    expect(dosageMatchesSavedProjection(saved)).toBe(false);
    expect(dosageMatchesSavedProjection(persist(saved))).toBe(false);
  });

  it.each(["label", "uncoded", "amount", "comparator", "annotation"] as const)("compares repeated course interval identity independently from its %s", edit => {
    const oldCycle = { value: 28, unit: "days", system: ucum, code: "d" };
    const currentCycle: FhirR6Quantity = edit === "label" ? { ...oldCycle, unit: "d" }
      : edit === "uncoded" ? { value: 28, unit: "weeks" }
      : edit === "amount" ? { ...oldCycle, value: 14 }
      : edit === "annotation" ? { ...oldCycle, extension: [{ url: "urn:test:repeat-note", valueString: "Changed interval annotation" }] }
      : { ...oldCycle, comparator: "<" };
    const historicalCycle = edit === "uncoded" ? { value: 28, unit: "days" } : oldCycle;
    const fields = encodeR5RetainedFields({ course: { repeatCycle: historicalCycle } })
      .find(value => value.url === "course")!.extension!;
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], modifierExtension: [{
      url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [...fields,
        encodeR6SourceMetadata("step", { component: [{ doseAndRate: [{ doseQuantity: q(1) }] }] }, "step")] }],
    }] };
    const compact = toFhirR5Dosages({ repeatCycle: currentCycle, step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ ...q(2), comparator: "~" })! }],
    }] }] })[0];
    const rows = persist([historical, compact]);
    const imported = importCanonicalCourse(rows);
    if (edit === "label") {
      expect(imported.contextIssue).toBeUndefined();
      expect(imported.cycleInterval).toMatchObject({ value: 28, code: "d", system: ucum });
    } else expect(imported.contextIssue).toBe("missing-course-context");
    let output = toDosageDetails(rows);
    for (let save = 0; save <= 3; save++) {
      const intervals: FhirR6Quantity[] = output.repeatCycle ? [output.repeatCycle] : [];
      const collect = (markers: readonly FhirR6Extension[] | undefined): void => {
        for (const marker of markers ?? []) {
          if (marker.url === "course" || marker.url === "dosageDetails") {
            const decoded = decodeR5RetainedFields({ url: DOSAGE_DETAILS_R5_URL,
              extension: [{ url: "course", extension: marker.extension }] });
            if (decoded.course?.repeatCycle) intervals.push(decoded.course.repeatCycle);
          }
          collect(marker.extension);
        }
      };
      collect(output.extension);
      expect(intervals).toContainEqual(historicalCycle);
      expect(intervals).toContainEqual(currentCycle);
      if (save < 3) output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
  });

  it("retains authored history IDs and contents through text-only R5 edits", () => {
    const old: FhirExtension = { id: "old-history-child", url: "urn:test:old-text", valueString: "Earlier authored instructions" };
    let wire: FhirR6DosageInstruction = { renderedInstruction: "Current authored instructions",
      extension: [{ id: "authored-history-envelope", url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [old] }] };
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      rows[0].text = "Edited instructions " + save;
      wire = toDosageDetails(rows);
      expect(wire.renderedInstruction).toBe("Edited instructions " + save);
      const retained = JSON.stringify(wire);
      expect(retained).toContain("old-history-child");
      expect(retained).toContain("authored-history-envelope");
      expect(retained).toContain("Earlier authored instructions");
    }
  });

  it("retains the exact authored history envelope while flattening its already retained children", () => {
    const old = { url: "urn:test:old-source", valueString: "Old text" };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
      { url: "renderedInstruction", valueString: "Previous text" },
      { id: "field-id", url: "extension", extension: [{ id: "history-id", url: DOSAGE_RECONCILIATION_SOURCE_URL,
        extension: [old] }] },
    ] }] };
    const retained = sourceWithoutNestedHistory(marker);
    expect(retained.extension![0].extension).toEqual([
      { url: "renderedInstruction", valueString: "Previous text" },
      { id: "field-id", url: "extension", extension: [{ id: "history-id", url: DOSAGE_RECONCILIATION_SOURCE_URL }] },
    ]);
    expect(sourceWithoutNestedHistory(retained)).toEqual(retained);
  });
});


describe("round36 external policy ownership and current source replay", () => {
  const daily = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
  const component = () => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: persist(daily) });
  const cap = (value: number, text: string) => ({ scope: "lifetime" as const, valueQuantity: q(value), text });

  it.each(["keep", "delete", "replace", "duplicate"] as const)(
    "keeps an unchanged induction ceiling scoped after a course edit (%s)", edit => {
      const wire = r6Save({ safety: { doseLimit: [cap(4, "course cap")] }, step: [{
        id: "induction", safety: { doseLimit: [cap(2, "induction cap")] }, component: [component()]
      }] });
      wire.step!.push({ id: "maintenance", component: [component()] });
      wire.safety!.doseLimit!.find(limit => limit.valueQuantity?.value === 4)!.valueQuantity!.value = 5;
      if (edit === "delete") wire.safety!.doseLimit = wire.safety!.doseLimit!.filter(limit => limit.valueQuantity?.value !== 2);
      if (edit === "replace") wire.step![0].id = "replacement";
      if (edit === "duplicate") wire.step![1].id = "induction";
      const native = importCanonicalCourse(persist(wire));
      expect(native.safety?.limits?.map(limit => limit.amount?.value)).toEqual([5]);
      expect(native.stages[1].safety?.limits).toBeUndefined();
      // Independent effective ceiling oracle: induction is constrained by
      // its own surviving 2-tablet limit and the edited 5-tablet course limit;
      // maintenance is constrained only by the current course limit.
      const effectiveCeilings = native.stages.map(stage => Math.min(
        ...(native.safety?.limits ?? []).map(limit => limit.amount!.value!),
        ...(stage.safety?.limits ?? []).map(limit => limit.amount!.value!)
      ));
      expect(effectiveCeilings).toEqual(edit === "keep" ? [2, 5] : [5, 5]);
      if (edit === "keep") expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value)).toEqual([2]);
      else expect(native.stages[0].safety?.limits).toBeUndefined();
      expect(JSON.stringify(projectCanonicalCourse(native).fhirNext)).toContain("induction cap");
    });

  it.each([
    { annotated: true, edit: "amount" }, { annotated: false, edit: "amount" },
    { annotated: true, edit: "period" },
  ])("matches period-limit annotations before mutable $edit edits (annotated=$annotated)", ({ annotated, edit }) => {
    const input = course({ safety: { doseLimit: [4, 8].map((value, index) => ({
      scope: "period" as const, valueQuantity: q(value), period: { value: edit === "period" ? index + 1 : 1, unit: "d" }, text: "limit " + index,
      ...(annotated ? { extension: [{ url: "urn:limit-note", valueString: "tag " + index }] } : {})
    })) } });
    const rows = persist(toFhirR5Dosages(input));
    if (edit === "amount") {
      rows[0].maxDosePerPeriod![0].numerator!.value = 8;
      rows[0].maxDosePerPeriod![1].numerator!.value = 10;
    } else {
      rows[0].maxDosePerPeriod![0].denominator!.value = 2;
      rows[0].maxDosePerPeriod![1].denominator!.value = 3;
    }
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass <= 3; pass++) {
      const limits = saved.step![0].component[0].safety!.doseLimit!;
      expect(limits.map(limit => limit.valueQuantity?.value)).toEqual(edit === "amount" ? [8, 10] : [4, 8]);
      expect(limits.map(limit => limit.period?.value)).toEqual(edit === "period" ? [2, 3] : [1, 1]);
      expect(limits.map(limit => limit.text)).toEqual(annotated ? ["limit 0", "limit 1"] : [undefined, undefined]);
      if (annotated) expect(limits.map(limit => limit.extension?.[0].valueString)).toEqual(["tag 0", "tag 1"]);
      expect(JSON.stringify(saved)).toContain("limit 0");
      expect(JSON.stringify(saved)).toContain("limit 1");
      if (pass < 3) saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it("detaches lifted Ratio annotations from both original and safety baseline", () => {
    const input: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], maxDosePerPeriod: [{
      numerator: q(4), denominator: { value: 1, unit: "d" },
      extension: [{ url: "urn:limit-note", extension: [{ url: "note", valueString: "original" }] }]
    }] };
    const row = toEzDosages([input])[0];
    row.safety!.doseLimit![0].extension![0].extension![0].valueString = "safety edit";
    row.maxDosePerPeriod![0].numerator!.value = 3;
    expect(input.maxDosePerPeriod![0].extension![0].extension![0].valueString).toBe("original");
    for (const edited of [row, persist(row)]) {
      const limit = importCanonicalCourse([edited]).stages[0].administrations[0].limits![0];
      expect(limit.amount?.value).toBe(4);
      expect(limit.provenance?.extension).toEqual([{ url: "urn:limit-note", extension: [{ url: "note", valueString: "safety edit" }] }]);
    }
  });

  it.each(["r5", "r6"] as const)("preserves and edits qualified occurrence-duration endpoints through %s saves", target => {
    const marker: FhirExtension = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, id: "duration-range",
      valueRange: {
        low: simpleQuantityForR5({ value: 1, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: ">=" })!,
        high: { value: 2, unit: "h", code: "h", system: "http://unitsofmeasure.org",
          extension: [{ url: "urn:test:duration-high", valueString: "prescriber upper bound" }] },
      } };
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [marker] } } };
    let current: FhirDosage[] | FhirR6DosageInstruction = target === "r5" ? [row] : course(row);
    const firstRow = () => Array.isArray(current) ? current[0] : current.step![0].component[0];
    const liveMarker = () => firstRow().timing!.repeat!.extension!.find(item => item.url === marker.url)!;
    for (const max of [2, 3]) {
      if (max === 3) {
        // The application independently submits its next edit at either boundary.
        current = persist(current);
        liveMarker().valueRange!.high!.value = 3;
      }
      for (let save = 0; save <= 3; save++) {
        const native = importCanonicalCourse(current);
        expect(native.stages[0].administrations[0].schedule?.recurrence).toMatchObject({
          occurrenceDurationRange: {
            low: { value: 1, unit: "h", code: "h", system: "http://unitsofmeasure.org", comparator: ">=" },
            high: { value: max, unit: "h", code: "h", system: "http://unitsofmeasure.org" },
          },
        });
        const active = liveMarker();
        expect(getQuantityComparator(active.valueRange!.low)).toBe(">=");
        expect(active.valueRange!.low).toMatchObject({ value: 1, unit: "h" });
        expect(active.valueRange!.high).toMatchObject({ value: max, unit: "h",
          extension: [{ url: "urn:test:duration-high", valueString: "prescriber upper bound" }] });
        expect(firstRow().timing!.repeat!.duration).toBeUndefined();
        expect(firstRow().timing!.repeat!.durationMax).toBeUndefined();
        if (save < 3) {
          const projected = projectCanonicalCourse(native);
          current = persist(target === "r5" ? projected.fhir : projected.fhirNext);
        }
      }
    }
    // The current core upper bound supersedes the marker's former high endpoint.
    // Its displaced annotated Range stays available as inactive source.
    let wire = projectCanonicalCourse(importCanonicalCourse(current)).fhirNext;
    const prior = persist(wire.step![0].component[0].timing!.repeat!.extension!.find(item => item.url === marker.url)!);
    wire.step![0].component[0].timing!.repeat!.durationMax = 4;
    for (let save = 0; save < 3; save++) {
      wire = r6Save(wire);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence).toMatchObject({
        occurrenceDurationRange: { low: { value: 1, comparator: ">=" }, high: { value: 4 } },
      });
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.durationMax).toBeUndefined();
      expect(repeat.extension!.find(item => item.url === marker.url)!.valueRange!.high!.value).toBe(4);
      expect(JSON.stringify(wire)).toContain(JSON.stringify(prior));
    }
  });

  it("uses a current site restriction while preserving its coherent authored source", () => {
    const source = "Apply 1 g to skin where skin is itchy daily max 2 g/day";
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      const original = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale: "en", realizationMode });
        expect(text).toContain("itchy");
        expect(text).not.toContain("skin is red");
      }
      const row = projectCanonicalCourse(importCanonicalCourse(input)).fhir[0];
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "g" });
      expect(row.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(row.maxDosePerPeriod).toContainEqual(expect.objectContaining({
        numerator: expect.objectContaining({ value: 2, unit: "g" }),
        denominator: expect.objectContaining({ value: 1, unit: "d" })
      }));
      expect(JSON.stringify(input)).toBe(original);
    }
    expect(parsed.fhir[0].text).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each(["dose", "rate"] as const)("uses newly submitted %s expressions instead of former scalar source text", dimension => {
    let row = persist(parseSig("Take 1 tablet daily").fhir[0]) as EzDosage;
    let item = row.doseAndRate![0];
    if (dimension === "dose") delete item.doseQuantity;
    item[dimension === "dose" ? "doseExpression" : "rateExpression"] = {
      language: "text/fhirpath", expression: "weight-based current " + dimension
    };
    const source = JSON.stringify(row);
    for (const mode of ["roundtrip", "normalized"] as const) {
      const options = { locale: "en", realizationMode: mode };
      const direct = formatSig(row, "long", options);
      const imported = fromFhirDosage(row, options).longText;
      for (const text of [direct, imported]) {
        expect(text).toContain("weight-based current " + dimension);
        if (dimension === "dose") expect(text).not.toMatch(/\b1 tablet\b/);
      }
    }
    row = persist(row);
    item = row.doseAndRate![0];
    item[dimension === "dose" ? "doseExpression" : "rateExpression"]!.expression = "second current " + dimension;
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toContain("second current " + dimension);
    expect(source).toContain("weight-based current " + dimension);
  });

  it.each([false, true])("retains an intervening draft after an append only while original owners stay unique (duplicate=%s)", duplicate => {
    const wire = r6Save({ step: [
      { id: "first", component: [component()] },
      { id: "draft", start: {
        contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
        offsetDuration: { value: 2, unit: "d" },
      }, component: [] },
      { id: "second", component: [component()] },
    ] });
    wire.step!.push({ id: duplicate ? "first" : "third", component: [component()] });
    const native = importCanonicalCourse(persist(wire));
    const ids = native.stages.map(stage => stage.provenance?.id);
    expect(ids).toEqual(duplicate ? ["first", "second", "first"] : ["first", "draft", "second", "third"]);
    expect(JSON.stringify(projectCanonicalCourse(native).fhirNext)).toContain("draft");
  });

  it("retains nonclinical carrier annotations without inventing a treatment phase", () => {
    const rows = toFhirR5Dosages({ renderedInstruction: "Consult clinician" });
    rows[0].id = "source-carrier";
    rows[0].extension = [{ url: "urn:carrier-note", valueString: "only a source record" }];
    let saved = toDosageDetails(persist(rows));
    for (let pass = 0; pass < 3; pass++) {
      expect(saved.step ?? []).toHaveLength(0);
      expect(saved.renderedInstruction).toBe("Consult clinician");
      expect(JSON.stringify(saved)).toContain("source-carrier");
      expect(JSON.stringify(saved)).toContain("only a source record");
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
    const clinical = persist(rows);
    clinical[0].doseAndRate = [{ doseQuantity: q(2) }];
    expect(importCanonicalCourse(clinical).stages[0].administrations[0].amounts![0].quantity?.value).toBe(2);
  });

  it.each(["weekday", "date", "offset"] as const)("keeps a live %s restriction on an annotated source carrier", kind => {
    let rows = toFhirR5Dosages({ renderedInstruction: "Consult clinician" });
    rows[0].id = "clinical-carrier";
    rows[0].extension = [{ url: "urn:carrier-note", valueString: "preserve this annotation" }];
    if (kind === "weekday") setDosageExcludedWeekdays(rows[0], [FhirDayOfWeek.Monday]);
    else if (kind === "date") setDosageExcludedDates(rows[0], ["2026-12-01"]);
    else rows[0].modifierExtension!.push({ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: 30, unit: "min", code: "min", system: "http://unitsofmeasure.org" } });
    const original = JSON.stringify(rows);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages).toHaveLength(1);
      expect(native.stages[0].administrations).toHaveLength(1);
      const administration = native.stages[0].administrations[0];
      if (kind === "weekday") expect(administration.excludedWeekdays).toEqual(["mon"]);
      else if (kind === "date") expect(administration.excludedDates).toEqual(["2026-12-01"]);
      else expect(administration.delayMinutes).toBe(30);
      expect(administration.amounts ?? []).toEqual([]);
      const projected = projectCanonicalCourse(native);
      expect(JSON.stringify(projected.fhirNext)).toContain("clinical-carrier");
      expect(JSON.stringify(projected.fhirNext)).toContain("preserve this annotation");
      if (save === 0) expect(JSON.stringify(rows)).toBe(original);
      if (save < 3) rows = persist(toFhirR5Dosages(projected.fhirNext));
    }
  });

  it("translates the supported R5 PRN alias into self-importable current R6", () => {
    const row = { doseAndRate: [{ doseQuantity: q(1) }], asNeededBoolean: true,
      extension: [{ url: "urn:prn-note", valueString: "retained" }] } as FhirDosage;
    const wire = toDosageDetails([row]);
    expect(wire.step![0].component[0].asNeeded).toBe(true);
    expect(wire.step![0].component[0]).not.toHaveProperty("asNeededBoolean");
    expect(fromFhir(persist(wire)).longText).toMatch(/as needed|when needed/i);
    expect(JSON.stringify(wire)).toContain("retained");
    expect(row).toHaveProperty("asNeededBoolean", true);
  });

  it("keeps a superseded unannotated EMA Coding under approximation source", () => {
    const old = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" };
    const input = { value: 5, unit: "mL", comparator: "~" as const,
      extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: old }] };
    const projected = quantityForR5(input)!;
    expect(getQuantityComparator(projected)).toBe("~");
    expect(projected.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)?.valueCoding?.code)
      .toBe("100000000055");
    expect(projected.extension!.some(item => item.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL &&
      item.valueCoding?.system === old.system && item.valueCoding?.code === old.code)).toBe(true);
    expect(input.extension[0].valueCoding).toEqual(old);
  });

  it("preserves displaced alternative-choice wrapper annotations through repeated saves", () => {
    const marker = (id: string): FhirExtension => ({ id, url: DOSAGE_ALTERNATIVE_CHOICE_URL,
      extension: [{ url: "groupId", valueString: "g" }, { url: "branchId", valueString: "a" },
        { url: "selectionBehavior", valueCode: "exactly-one" },
        { url: "urn:choice-note", valueString: "note " + id }] });
    let saved = r6Save(course({ ...component(), modifierExtension: [marker("first"), marker("second")] }));
    for (let pass = 0; pass < 3; pass++) {
      const live = saved.step![0].component[0].modifierExtension!.filter(item => item.url === DOSAGE_ALTERNATIVE_CHOICE_URL);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe("first");
      expect(JSON.stringify(saved)).toContain("second");
      expect(JSON.stringify(saved)).toContain("note second");
      saved = r6Save(persist(saved));
    }
  });
});


describe("round37 interchange phase, limit and source ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const member = (value = 1, repeat: NonNullable<FhirR6Timing["repeat"]> = {}): FhirR6Dosage => ({
    doseAndRate: [{ doseQuantity: q(value) }], timing: { repeat: { ...daily, ...repeat } },
  });
  const options = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 10 };

  it.each([
    { edited: false, compact: false }, { edited: false, compact: true }, { edited: true, compact: true },
  ])("keeps a historical header carrier separate from mixed live rows (clinical edit=$edited, compact=$compact)", ({ edited, compact }) => {
    const carrier = toFhirR5Dosages({ renderedInstruction: "Consult clinician" })[0];
    carrier.id = "original-source-carrier";
    carrier.extension = [{ url: "urn:source-note", valueString: "Retain this source" }];
    if (edited) carrier.doseAndRate = [{ doseQuantity: q(3) }];
    const live = toFhirR5Dosages({ step: [{ ...(compact ? { id: "active-dose-phase" } : {}), component: [
      { ...member(2), safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] } },
    ] }] })[0];
    let rows = persist([carrier, live]);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      const administrations = native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []);
      expect(administrations.map(value => value.amounts?.[0]?.quantity?.value)).toEqual(edited ? [3, 2] : [2]);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Consult clinician");
      expect(JSON.stringify(output.fhirNext)).toContain("original-source-carrier");
      expect(JSON.stringify(output.fhirNext)).toContain("Retain this source");
      if (save < 3) rows = persist(output.fhir);
    }
  });

  it.each([false, true])("aligns historical real members around a source carrier (carrier first=%s)", carrierFirst => {
    const carrier = toFhirR5Dosages({ renderedInstruction: "Historical header only" })[0];
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(5) }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
        encodeR6SourceMetadata("step", { component: [member(5)] }, "step"),
      ] }] }],
    };
    const compact = toFhirR5Dosages({ step: [{ id: "current-phase", component: [member(2)] }] })[0];
    let rows = persist([...(carrierFirst ? [carrier, historical] : [historical, carrier]), compact]);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), [])
        .map(value => value.amounts?.[0]?.quantity?.value)).toEqual([5, 2]);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Historical header only");
      if (save < 3) rows = persist(output.fhir);
    }
  });

  it.each([true, false])("keeps an absolute component start independent after predecessor deletion (absolute=%s)", absolute => {
    const input: FhirR6DosageInstruction = { step: [
      { id: "loading", component: [member(1, { count: 1 })] },
      { component: [member(2, { count: 2, ...(absolute ? { boundsPeriod: { start: "2026-11-24T00:00:00Z" } } : {}) })] },
    ] };
    let rows = persist(toFhirR5Dosages(input).slice(1));
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      const active = native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []);
      expect(active.map(value => value.amounts?.[0]?.quantity?.value)).toEqual([2]);
      if (absolute) {
        expect(native.contextIssue).toBeUndefined();
        expect(nextDueDoses(rows, options)).toEqual([
          "2026-11-24T08:00:00+00:00", "2026-11-25T08:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ ...options, dosage: rows, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
      } else {
        expect(native.contextIssue).toBe("missing-course-context");
        expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      }
      if (save < 3) rows = persist(projectCanonicalCourse(native).fhir);
    }
  });

  it("retains implicit successor membership without inventing a new treatment origin", () => {
    const input: FhirR6DosageInstruction = { step: [
      { component: [member(1, { count: 1 })] }, { component: [member(2, { count: 3 })] },
    ] };
    const full = persist(toFhirR5Dosages(input));
    expect(nextDueDoses(full, options)).toEqual([
      "2026-11-21T08:00:00+00:00", "2026-11-22T08:00:00+00:00",
      "2026-11-23T08:00:00+00:00", "2026-11-24T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: full, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    let rows = full.slice(1);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(rows);
      expect(native.stages.map(stage => stage.administrations).reduce((all, members) => all.concat(members), []).map(value => value.amounts?.[0]?.quantity?.value)).toEqual([2]);
      expect(native.contextIssue).toBe("missing-course-context");
      expect(() => nextDueDoses(rows, options)).toThrow(/complete dosage array/i);
      if (save < 3) rows = persist(projectCanonicalCourse(native).fhir);
    }
  });

  it.each(["administration", "lifetime"] as const)("projects the stricter equal %s ceiling", scope => {
    const inclusive = { value: 2, unit: "tab", id: "inclusive" };
    const strict: FhirR6Quantity = { value: 2, unit: "tab", comparator: "<", id: "strict" };
    for (const amounts of [[inclusive, strict], [strict, inclusive]]) {
      const limits = amounts.map(valueQuantity => ({ scope, valueQuantity }));
      const input = course({ safety: { doseLimit: limits } });
      const before = JSON.stringify(input);
      const rows = toFhirR5Dosages(input);
      const selected = scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime;
      expect(selected).toMatchObject({ value: 2, unit: "tab", id: "strict" });
      expect(getQuantityComparator(selected)).toBe("<");
      expect(selected?.comparator).toBeUndefined();
      expect(toDosageDetails(rows).step![0].component[0].safety?.doseLimit).toEqual(limits);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["administration", "lifetime"] as const)("keeps the strict %s ceiling across equivalent converted units", scope => {
    for (const pair of [[{ value: 700, unit: "ug" }, { value: 0.7, unit: "mg" }],
      [{ value: 700, unit: "mg" }, { value: 0.7, unit: "g" }]]) {
      for (const strictIndex of [0, 1]) {
        const quantities: FhirR6Quantity[] = pair.map((quantity, index) => ({ ...quantity,
          comparator: index === strictIndex ? "<" : "<=", id: index === strictIndex ? "strict" : "inclusive" }));
        for (const amounts of [quantities, [...quantities].reverse()]) {
          const input = course({ safety: { doseLimit: amounts.map(valueQuantity => ({ scope, valueQuantity })) } });
          const before = JSON.stringify(input), rows = toFhirR5Dosages(input);
          const selected = scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime;
          expect(selected).toMatchObject({ ...pair[strictIndex], id: "strict" });
          expect(getQuantityComparator(selected)).toBe("<");
          expect(selected?.comparator).toBeUndefined();
          expect(JSON.stringify(input)).toBe(before);
        }
      }
    }
  });

  it("retains the smaller distinct converted ceiling before comparator strictness", () => {
    const tight: FhirR6Quantity = { value: 0.699, unit: "g", comparator: "<=", id: "tighter" };
    const loose: FhirR6Quantity = { value: 700, unit: "mg", comparator: "<", id: "looser" };
    for (const amounts of [[tight, loose], [loose, tight]]) {
      const input = course({ safety: { doseLimit: amounts.map(valueQuantity => ({ scope: "administration", valueQuantity })) } });
      const selected = toFhirR5Dosages(input)[0].maxDosePerAdministration;
      expect(selected).toMatchObject({ value: 0.699, unit: "g", id: "tighter" });
      expect(getQuantityComparator(selected)).toBe("<=");
    }
  });

  it.each(["administration", "lifetime"] as const)("projects the smaller physical %s ceiling in its authored unit", scope => {
    const tight = { value: 500, unit: "mg", id: "half-gram" };
    const loose = { value: 1, unit: "g", id: "one-gram" };
    const independent = { value: 2, unit: "mL", id: "volume" };
    for (const amounts of [[tight, loose], [loose, tight], [tight, independent, loose]]) {
      const limits = amounts.map(valueQuantity => ({ scope, valueQuantity }));
      const input = course({ safety: { doseLimit: limits } });
      const before = JSON.stringify(input);
      const rows = toFhirR5Dosages(input);
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime).toEqual(tight);
      expect(toDosageDetails(rows).step![0].component[0].safety?.doseLimit).toEqual(limits);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("compares equivalent plain maximum labels while retaining the authored winner", () => {
    const tight = { value: 2, unit: "tab" }, loose = { value: 3, unit: "tablet" };
    for (const amounts of [[tight, loose], [loose, tight]]) {
      const limits = amounts.map(valueQuantity => ({ scope: "administration" as const, valueQuantity }));
      const input = course({ safety: { doseLimit: limits } });
      const before = JSON.stringify(input);
      const rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(tight);
      expect(toDosageDetails(rows).step![0].component[0].safety?.doseLimit).toEqual(limits);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("keeps the tighter physical maximum while retaining the coded group minimum", () => {
    const coded = { value: 2, system: "urn:clinic:a", code: "x", unit: "mg" };
    const amounts = [coded, { value: 1, system: "http://unitsofmeasure.org", code: "mg", unit: "mg" },
      { value: 3, system: "urn:clinic:a", code: "x" }];
    const limits = amounts.map(valueQuantity => ({ scope: "administration" as const, valueQuantity }));
    const input = course({ safety: { doseLimit: limits } });
    const before = JSON.stringify(input);
    const rows = toFhirR5Dosages(input);
    expect(rows[0].maxDosePerAdministration).toEqual(amounts[1]);
    expect(toDosageDetails(rows).step![0].component[0].safety?.doseLimit).toEqual(limits);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    { scope: "administration" as const, values: [2, 4] }, { scope: "administration" as const, values: [4, 2] },
    { scope: "lifetime" as const, values: [2, 4] }, { scope: "lifetime" as const, values: [4, 2] },
  ])("projects the tighter exact $scope cap independently of order $values", ({ scope, values }) => {
    const limits = values.map(value => ({ scope, valueQuantity: q(value), text: value + "-tablet authored cap" }));
    let wire = course({ ...member(), safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime).toEqual(q(2));
      const reopened = toDosageDetails(rows);
      expect(reopened.step![0].component[0].safety?.doseLimit).toEqual(limits);
      if (save < 3) wire = persist(reopened);
    }
  });

  it.each([
    { saved: "compact", edit: "change" }, { saved: "compact", edit: "delete" },
    { saved: "full", edit: "change" }, { saved: "full", edit: "delete" },
    { saved: "current", edit: "change" }, { saved: "current", edit: "delete" },
  ])("edits the actual shown maximum from $saved R5 storage ($edit)", ({ saved, edit }) => {
    const amount = (value: number, id: string) => ({ value, unit: "tab", id,
      extension: [{ url: "urn:quantity-note", valueString: id }] });
    const limits = [
      { id: "first-cap", scope: "administration" as const, valueQuantity: amount(2, "first-quantity"), text: "First cap" },
      { id: "volume-cap", scope: "administration" as const, valueQuantity: { value: 4, unit: "mL", id: "volume-quantity" }, text: "Independent volume cap" },
      { id: "last-cap", scope: "administration" as const, valueQuantity: amount(4, "last-quantity"), text: "Last cap" },
      { id: "period-cap", scope: "period" as const, valueQuantity: q(8), period: { value: 1, unit: "d" },
        extension: [{ url: "urn:period-note", valueString: "Keep period annotation" }] },
    ];
    const component = { doseAndRate: [{ doseQuantity: q(1) }], safety: { doseLimit: limits } };
    // Captured from the public writer at 6c0e3cd: the shown cap was 4,
    // with its exact annotated projected-safety fingerprint. This fixture
    // does not derive its expected original ownership from today's writer.
    const historical: FhirDosage = { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }],
      maxDosePerAdministration: amount(4, "last-quantity"),
      maxDosePerPeriod: [{ id: "period-cap", numerator: q(8), denominator: { value: 1, unit: "d" },
        extension: [{ url: "urn:period-note", valueString: "Keep period annotation" }] }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: saved === "full"
        ? [{ url: "dosageDetails", extension: [encodeR6SourceMetadata("step", { component: [component] }, "step")] }]
        : encodeR5RetainedFields({ rowIndex: 0, sequence: 1, stepCount: 1, countScope: "step",
          component: { safety: { doseLimit: limits } }, baseline: { safety: "ced94fe0a80e7663" } }),
      }],
    };
    let rows = persist(saved === "current" ? toFhirR5Dosages(course(component)) : [historical]);
    expect(rows[0].maxDosePerAdministration!.value).toBe(saved === "current" ? 2 : 4);
    if (edit === "delete") delete rows[0].maxDosePerAdministration;
    else rows[0].maxDosePerAdministration!.value = 3;
    const shownId = saved === "current" ? "first-cap" : "last-cap";
    const expected = limits.filter(limit => edit !== "delete" || limit.id !== shownId).map(limit =>
      edit === "change" && limit.id === shownId ? { ...limit, valueQuantity: { ...limit.valueQuantity, value: 3 } } : limit);
    for (let save = 0; save <= 3; save++) {
      const wire = toDosageDetails(rows);
      const actual = wire.step![0].component[0].safety!.doseLimit!;
      expect(actual).toHaveLength(expected.length);
      for (const limit of expected) expect(actual.find(value => value.id === limit.id)).toEqual(limit);
      expect(JSON.stringify(wire)).toContain("first-quantity");
      expect(JSON.stringify(wire)).toContain("last-quantity");
      if (save < 3) rows = persist(toFhirR5Dosages(wire));
    }
  });

  it.each([
    { amounts: [{ value: 2, unit: "tab" }, { value: 4, unit: "mL" }, { value: 4, unit: "tab" }], owner: 0 },
    { amounts: [{ value: 4, unit: "tab" }, { value: 4, unit: "mL" }, { value: 2, unit: "tab" }], owner: 2 },
    { amounts: [{ value: 2, unit: "mL" }, { value: 4, unit: "tab" }, { value: 4, unit: "mL" }], owner: 1 },
    { amounts: [{ value: 4, unit: "mL" }, { value: 2, unit: "tab" }, { value: 4, unit: "tab" }, { value: 2, unit: "mL" }], owner: 1 },
  ])("keeps the tighter annotated maximum within the dose-compatible interleaved unit (owner=$owner)", ({ amounts, owner }) => {
    const limits = amounts.map((amount, index) => ({ id: "cap-" + index, scope: "administration" as const,
      valueQuantity: { ...amount, id: "quantity-" + index }, text: "Authored cap " + index }));
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].maxDosePerAdministration).toEqual({ ...amounts[owner], id: "quantity-" + owner });
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it.each(["~", "<"] as const)("retains the applicable minimum around an authored %s maximum", comparator => {
    const limits = [
      { id: "exact-tight", scope: "administration" as const, valueQuantity: { ...q(2), id: "exact-quantity" } },
      { id: "qualified", scope: "administration" as const, valueQuantity: { ...q(1), comparator, id: "qualified-quantity" } },
      { id: "exact-later", scope: "administration" as const, valueQuantity: q(4) },
    ];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      if (comparator === "~") expect(rows[0].maxDosePerAdministration).toEqual({ ...q(2), id: "exact-quantity" });
      else {
        expect(rows[0].maxDosePerAdministration).toMatchObject({ ...q(1), id: "qualified-quantity" });
        expect(getQuantityComparator(rows[0].maxDosePerAdministration)).toBe("<");
      }
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it("keeps the edited annotated cap as the shown owner when its value reaches an equal sibling", () => {
    const limits = [
      { id: "edited-cap", scope: "administration" as const, valueQuantity: { ...q(4), id: "edited-quantity" }, text: "Edited owner" },
      { id: "hidden-cap", scope: "administration" as const, valueQuantity: { ...q(6), id: "hidden-quantity" }, text: "Independent sibling" },
    ];
    let rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    for (const value of [6, 5]) {
      expect(rows[0].maxDosePerAdministration!.id).toBe("edited-quantity");
      rows[0].maxDosePerAdministration!.value = value;
      for (let save = 0; save <= 3; save++) {
        const output = toDosageDetails(rows);
        const actual = output.step![0].component[0].safety!.doseLimit!;
        expect(actual.find(limit => limit.id === "edited-cap")).toEqual({
          ...limits[0], valueQuantity: { ...q(value), id: "edited-quantity" },
        });
        expect(actual.find(limit => limit.id === "hidden-cap")).toEqual(limits[1]);
        rows = persist(toFhirR5Dosages(output));
        expect(rows[0].maxDosePerAdministration).toEqual({ ...q(value), id: "edited-quantity" });
      }
    }
  });

  it.each(["unit", "comparator"] as const)("retains incomparable %s caps without converting authored quantities", difference => {
    const last: FhirR6Quantity = difference === "unit" ? { value: 4, unit: "mL" } : { ...q(4), comparator: "<" };
    const limits = [{ scope: "administration" as const, valueQuantity: q(2) }, { scope: "administration" as const, valueQuantity: last }];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(quantityFromR5(rows[0].maxDosePerAdministration)).toEqual(q(2));
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
  });

  it.each(["keep", "delete", "replace", "duplicate"] as const)("separates a course action edit from unchanged phase cap ownership (%s)", edit => {
    let wire = r6Save({ safety: { ifExceeded: "Original course action" }, step: [{
      id: "induction", safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2), text: "Induction only" }] },
      component: [member()],
    }] });
    wire.step!.push({ id: "maintenance", component: [member(3)] });
    wire.safety!.ifExceeded = "Contact clinician";
    if (edit === "delete") wire.safety!.doseLimit = [];
    if (edit === "replace") wire.step![0].id = "replacement";
    if (edit === "duplicate") wire.step![1].id = "induction";
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.safety?.ifExceeded).toBe("Contact clinician");
      expect(native.safety?.limits ?? []).toEqual([]);
      expect(native.stages[1].safety?.limits).toBeUndefined();
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "keep" ? [2] : []);
      expect(native.stages[1].administrations[0].amounts![0].quantity?.value).toBe(3);
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("Induction only");
      if (save < 3) wire = persist(save === 1 ? toDosageDetails(output.fhir) : output.fhirNext);
    }
  });

  it.each([false, true])("keeps incomplete annotated period maxima source-only through editable saves (valid sibling=%s)", valid => {
    const incomplete: FhirRatio = { id: "incomplete-limit", numerator: q(1), denominator: {
      unit: "d", extension: [{ url: "urn:period-note", valueString: "Period value was not authored" }],
    } };
    const complete: FhirRatio = { id: "complete-limit", numerator: q(1), denominator: { value: 2, unit: "d" } };
    let rows = toEzDosages([{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily },
      maxDosePerPeriod: [incomplete, ...(valid ? [complete] : [])] }]);
    // Retained partials are editable, but do not acquire a numeric period.
    expect(rows[0].safety?.doseLimit?.map(limit => limit.id) ?? []).toEqual(["incomplete-limit", ...(valid ? ["complete-limit"] : [])]);
    for (let save = 0; save <= 3; save++) {
      const native = importCanonicalCourse(persist(rows));
      const limits = native.stages[0].administrations[0].limits ?? [];
      expect(limits.map(limit => ({ amount: limit.amount?.value, period: limit.period?.value })))
        .toEqual([{ amount: 1, period: undefined }, ...(valid ? [{ amount: 1, period: 2 }] : [])]);
      expect(limits.filter(limit => limit.amount?.value !== undefined && limit.period?.value !== undefined)
        .map(limit => ({ amount: limit.amount?.value, period: limit.period?.value })))
        .toEqual(valid ? [{ amount: 1, period: 2 }] : []);
      expect(calculateTotalUnits({ dosage: rows, orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC",
        durationValue: 2, durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: valid ? 1 : 2, unit: "tab" });
      const output = projectCanonicalCourse(native);
      expect(output.fhir[0].maxDosePerPeriod).toEqual([incomplete, ...(valid ? [complete] : [])]);
      expect(JSON.stringify(output.fhirNext)).toContain("Period value was not authored");
      expect(JSON.stringify(output.fhirNext)).toContain("incomplete-limit");
      if (save < 3) rows = toEzDosages(persist(output.fhir));
    }
  });

  it("retains a fresh current target count with its dose, clock, limit and authored directions", () => {
    const countUrl = "urn:ezmedicationinput:body-site-administration-target-count";
    const source = "Apply 1 g to each of 3 lesions daily max 2 g/day";
    const input: FhirDosage = {
      text: source, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }], timing: { repeat: daily },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "g" }, denominator: { value: 1, unit: "d" } }],
      site: { text: "lesions", extension: [{ url: countUrl, id: "authored-count", valueInteger: 3 }] },
    };
    const before = persist(input), native = importCanonicalCourse(input);
    const output = projectCanonicalCourse(native);
    const r6 = output.fhirNext, returned = toFhirR5Dosages(r6)[0];
    expect(native.stages[0].administrations[0].targetCount).toBe(3);
    for (const row of [input, output.fhir[0], returned]) {
      expect(row.doseAndRate).toEqual(input.doseAndRate);
      expect(row.timing).toEqual(input.timing);
      expect(row.site).toEqual(input.site);
      expect(row.text).toBe(source);
    }
    expect(r6.step![0].component[0].site?.concept).toEqual(input.site);
    for (const value of [input, native, r6, returned]) {
      const text = formatSig(value, "long", { locale: "en", realizationMode: "roundtrip" });
      expect(text).toContain("1 g");
      expect(text).toContain("8:00 am");
      expect(text).toContain("across 3 sites");
      expect(text).toContain("max per period: 2 g / 1 d");
      expect(text).toContain(source);
    }
    expect(input).toEqual(before);
  });

  it.each([false, true])("shows a source-less ordinary R5 rate Ratio in both previews (dose=%s)", dose => {
    let row: FhirDosage = { doseAndRate: [{ ...(dose ? { doseQuantity: q(1) } : {}),
      rateRatio: { numerator: { value: 100, unit: "mL" }, denominator: { value: 2, unit: "h" } },
    }] };
    for (const displayed of [formatSig(row, "long"), fromFhirDosage(row).longText]) {
      expect(displayed).toContain("100 mL / 2 h");
      if (dose) expect(displayed).toMatch(/1 (?:tab|tablet)/);
    }
    row = persist(row);
    row.text = "Authored infusion instructions";
    expect(formatSig(row, "long", { realizationMode: "roundtrip" }).split("; original directions: "))
      .toEqual([`Current: ${dose ? "Use 1 tablet" : "Use"}; Rate: 100 mL / 2 h`, "Authored infusion instructions"]);
    for (const displayed of [formatSig(row, "long"), fromFhirDosage(row).longText]) {
      expect(displayed).toContain("100 mL / 2 h");
      if (dose) expect(displayed).toMatch(/1 (?:tab|tablet)/);
    }
    expect(row.text).toBe("Authored infusion instructions");
  });
});


describe("round38 external safety, identity, and source ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const predicate = (value: number) => ({ kind: "measurement" as const, name: "SBP",
    operation: "gt" as const, value, unit: "mmHg", text: "SBP > " + value });
  const component = { id: "dose", doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily } };

  it.each(["keep", "delete", "change"] as const)("keeps a surviving lifted phase cap scoped beside an independent header modifier (%s)", edit => {
    let wire = r6Save({ step: [{ id: "induction", component: [component], safety: {
      doseLimit: [{ id: "phase-limit", scope: "administration", valueQuantity: q(2) }],
    } }] });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    wire.safety!.modifierExtension = [{ url: "urn:test:header-policy", valueString: "independent" }];
    if (edit === "delete") wire.safety!.doseLimit = [];
    if (edit === "change") wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "keep" ? [2] : []);
      expect(native.stages[1].safety?.limits ?? []).toEqual([]);
      expect(native.safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "change" ? [3] : []);
      const output = projectCanonicalCourse(native).fhirNext;
      expect(output.safety?.modifierExtension).toContainEqual({ url: "urn:test:header-policy", valueString: "independent" });
      wire = persist(output);
    }
  });


  it.each([
    { coursePolicy: false, edit: "append" }, { coursePolicy: false, edit: "replace" }, { coursePolicy: false, edit: "remove" },
    { coursePolicy: true, edit: "append" }, { coursePolicy: true, edit: "replace" }, { coursePolicy: true, edit: "remove" },
  ])("keeps existing scoped modifiers with their live owners ($edit, course=$coursePolicy)", ({ coursePolicy, edit }) => {
    const phase = { id: "phase-qualifier", url: "urn:test:phase-policy", valueString: "induction only" };
    const header = { id: "course-qualifier", url: "urn:test:course-policy", valueString: "whole course" };
    const added = { url: "urn:test:independent-header-policy", valueString: "new whole-course qualifier" };
    let wire = r6Save({
      ...(coursePolicy ? { safety: { modifierExtension: [header],
        doseLimit: [{ id: "course-cap", scope: "lifetime", valueQuantity: q(20) }] } } : {}),
      step: [{ id: "induction", component: [component], safety: {
        doseLimit: [{ id: "phase-cap", scope: "administration", valueQuantity: q(2) }], modifierExtension: [phase],
      } }],
    });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    wire.safety!.modifierExtension = edit === "append" ? [...wire.safety!.modifierExtension!, added] :
      edit === "replace" ? [added] : [];
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.limits?.map(limit => limit.amount?.value)).toEqual([2]);
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].safety?.modifierExtension ?? []).toEqual(edit === "append" ? [phase] : []);
      expect(wire.safety?.modifierExtension ?? []).toEqual(edit === "remove" ? [] :
        edit === "append" && coursePolicy ? [header, added] : [added]);
      expect(wire.step![1].safety).toBeUndefined();
      expect(JSON.stringify(wire)).toContain("induction only");
    }
  });

  it.each(["change", "delete"] as const)("retains an induction-only action when its independent course limit is %s", edit => {
    let wire = r6Save({ safety: { doseLimit: [{ id: "course-limit", scope: "administration", valueQuantity: q(4) }] },
      step: [{ id: "induction", component: [component], safety: { ifExceeded: "Review induction" } }] });
    wire.step!.push({ id: "maintenance", component: [{ ...component, id: "maintenance-dose" }] });
    if (edit === "delete") wire.safety!.doseLimit = [];
    else wire.safety!.doseLimit![0].valueQuantity!.value = 3;
    for (let save = 0; save <= 2; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].safety?.ifExceeded).toBe("Review induction");
      expect(native.stages[1].safety).toBeUndefined();
      expect(native.safety?.ifExceeded).toBeUndefined();
      expect(native.safety?.limits?.map(limit => limit.amount?.value) ?? []).toEqual(edit === "delete" ? [] : [3]);
      wire = persist(projectCanonicalCourse(native).fhirNext);
    }
  });

  it.each(["administration", "lifetime"] as const)("keeps the exact %s ceiling ahead of a later approximate sibling", scope => {
    const limits = [
      { id: "tight", scope, valueQuantity: q(3) },
      { id: "loose", scope, valueQuantity: q(5) },
      { id: "approximate", scope, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    let wire = course({ safety: { doseLimit: limits } });
    for (let save = 0; save <= 2; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      const active = scope === "administration" ? rows[0].maxDosePerAdministration : rows[0].maxDosePerLifetime;
      expect(active).toEqual(q(3));
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].safety?.doseLimit).toEqual(limits);
    }
    const rows = persist(toFhirR5Dosages(wire));
    const active = scope === "administration" ? rows[0].maxDosePerAdministration! : rows[0].maxDosePerLifetime!;
    active.value = 2;
    const edited = toDosageDetails(rows).step![0].component[0].safety!.doseLimit!;
    expect(edited.find(limit => limit.id === "tight")?.valueQuantity).toEqual(q(2));
    expect(edited.find(limit => limit.id === "approximate")?.valueQuantity).toEqual({ ...q(8), comparator: "~" });
  });


  it.each(["change", "delete"] as const)("edits the actually shown approximate cap in a reviewed saved R5 row (%s)", edit => {
    const limits = [
      { id: "tight", scope: "administration" as const, valueQuantity: q(3) },
      { id: "loose", scope: "administration" as const, valueQuantity: q(5) },
      { id: "approximate", scope: "administration" as const, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    // Actual a6ed242 writer: approximate 8 was exposed in the singular field.
    // The fingerprint and shown owner are captured independently of this writer.
    let rows: FhirDosage[] = [{ ...component, sequence: 1,
      maxDosePerAdministration: simpleQuantityForR5({ ...q(8), comparator: "~" })!,
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: encodeR5RetainedFields({
        rowIndex: 0, sequence: 1, stepCount: 1, countScope: "step",
        component: { safety: { doseLimit: limits } }, baseline: { safety: "9557b781cdbb15cc" },
      }) }],
    }];
    if (edit === "delete") delete rows[0].maxDosePerAdministration;
    else rows[0].maxDosePerAdministration!.value = 9;
    for (let save = 0; save <= 3; save++) {
      const wire = toDosageDetails(persist(rows));
      const active = wire.step![0].component[0].safety!.doseLimit!;
      expect(active.find(limit => limit.id === "tight")).toEqual(limits[0]);
      expect(active.find(limit => limit.id === "loose")).toEqual(limits[1]);
      expect(active.find(limit => limit.id === "approximate")).toEqual(edit === "delete" ? undefined :
        { ...limits[2], valueQuantity: { ...q(9), comparator: "~" } });
      expect(JSON.stringify(wire)).toContain("approximate");
      rows = toFhirR5Dosages(wire);
      expect(rows[0].maxDosePerAdministration).toEqual(q(3));
    }
  });

  it("keeps a definite strict ceiling ahead of an approximate maximum", () => {
    const limits = [
      { scope: "administration" as const, valueQuantity: { ...q(3), comparator: "<" as const } },
      { scope: "administration" as const, valueQuantity: { ...q(8), comparator: "~" as const } },
    ];
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    expect(quantityFromR5(rows[0].maxDosePerAdministration)).toEqual({ ...q(3), comparator: "<" });
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit).toEqual(limits);
  });

  it.each(["administration", "lifetime", "period"] as const)("keeps the external editable %s safety baseline detached before JSON save", scope => {
    const source = course({ safety: { doseLimit: [{ scope, valueQuantity: q(2),
      ...(scope === "period" ? { period: { value: 1, unit: "d" } } : {}) }] } });
    const editable = structuredClone(fromDosageDetails(source));
    const row = editable.dosages[0];
    row.safety!.doseLimit![0].valueQuantity!.value = 3;
    const flat = scope === "administration" ? row.maxDosePerAdministration! :
      scope === "lifetime" ? row.maxDosePerLifetime! : row.maxDosePerPeriod![0].numerator!;
    flat.value = 4;
    expect(toDosageDetails(editable.dosages, undefined, editable.course).step![0].component[0].safety!.doseLimit![0].valueQuantity!.value).toBe(3);
  });

  it.each([false, true])("does not lend a historical offset to a replacement explicit component ID (site=%s)", withSite => {
    const old: FhirR6Dosage = { ...component, id: "A", timing: { repeat: {
      frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, startOffset: { value: 2, unit: "h" },
    } }, ...(withSite ? { site: { concept: { text: "right eye" } } } : {}) };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", { component: [old] }, "step")] }] };
    for (const id of ["A", "B"]) {
      let rows: FhirDosage[] = [{ ...component, id, sequence: 1,
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
        ...(withSite ? { site: { text: "right eye" } } : {}), modifierExtension: [marker] }];
      for (let save = 0; save <= 2; save++) {
        const wire = toDosageDetails(persist(rows));
        expect(wire.step![0].component[0].id).toBe(id);
        expect(wire.step![0].component[0].timing?.repeat?.startOffset).toEqual(id === "A" ? { value: 2, unit: "h" } : undefined);
        expect(JSON.stringify(wire)).toContain('"value":2,"unit":"h"');
        rows = toFhirR5Dosages(wire);
      }
    }
  });

  it.each(["change", "clear"] as const)("retains every displaced condition modifier on %s", edit => {
    const row: FhirDosage = { ...component };
    setDosageCondition(row, predicate(160));
    const first = { ...row.modifierExtension![0], id: "first-condition" };
    const second = { ...persist(first), id: "second-condition",
      extension: [...first.extension!, { url: "urn:test:condition-note", valueString: "second annotation" }] };
    row.modifierExtension = [first, second];
    setDosageCondition(row, edit === "change" ? predicate(180) : undefined);
    expect(getDosageCondition(row)).toEqual(edit === "change" ? predicate(180) : undefined);
    expect(row.modifierExtension?.filter(value => value.url === DOSAGE_CONDITION_R5_URL).length ?? 0).toBe(edit === "change" ? 1 : 0);
    const history = JSON.stringify(row.extension);
    expect(history).toContain("first-condition");
    expect(history).toContain("second-condition");
    expect(history).toContain("second annotation");
  });

  it.each([false, true])("uses an explicitly cleared condition in a new capped R5 submission (submitted directly=%s)", warm => {
    const raw: FhirDosage = { ...component, text: "Take 1 tablet daily if SBP > 160, maximum 2 tablets per administration",
      maxDosePerAdministration: q(2) };
    setDosageCondition(raw, predicate(160));
    let row = persist(toFhirR5Dosages([raw])[0]) as EzDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("SBP");
    row = persist(row);
    row.condition = [];
    const edited = warm ? row : persist(row);
    expect(getDosageCondition(edited)).toBeUndefined();
    expect(formatSig(edited, "long", options)).not.toContain("SBP");
    expect(formatSig(edited, "long", options)).toContain("1 tablet");
  });

  it.each(["replace", "clear", "same"] as const)("keeps superseded dose-rate policy children as inactive source on %s", edit => {
    const prior = { url: "urn:test:old-rate-policy", valueString: "old restriction" };
    const wrapper = { id: "rate-wrapper", url: R5_RATE_MODIFIERS_R6_URL, extension: [prior] };
    let rows = persist(toFhirR5Dosages(course({ doseAndRate: [{
      rateQuantity: { value: 5, unit: "mL/h" }, extension: [wrapper],
    }] })));
    const replacement = { url: "urn:test:new-rate-policy", valueString: "new restriction" };
    rows[0].doseAndRate![0].modifierExtension = edit === "replace" ? [replacement] : edit === "clear" ? [] : [prior];
    for (let save = 0; save <= 2; save++) {
      const wire = toDosageDetails(rows);
      const rate = wire.step![0].component[0].doseAndRate![0];
      const active = rate.extension?.filter(item => item.url === R5_RATE_MODIFIERS_R6_URL) ?? [];
      expect(active.length).toBe(edit === "clear" ? 0 : 1);
      if (edit !== "clear") expect(active[0]).toEqual({ ...wrapper, extension: edit === "same" ? [prior] : [replacement] });
      expect(JSON.stringify(rate.extension)).toContain("old restriction");
      if (edit === "same") expect(rate.extension).toEqual([wrapper]);
      rows = persist(toFhirR5Dosages(wire));
    }
  });


  it.each([false, true])("uses a newly submitted PRN spatial target after a capped-row preview (submitted directly=%s)", warm => {
    const location: FhirExtension = { url: "urn:ezmedicationinput:body-site-spatial-relation", extension: [
      { url: "relationText", valueString: "in" },
      { url: "target", valueCodeableConcept: { text: "right eye" } },
    ] };
    const raw: FhirDosage = { ...component, text: "Take 1 tablet daily as needed for headache in right eye, maximum 2 tablets per administration",
      asNeeded: true, asNeededFor: [{ coding: [{ system: "http://snomed.info/sct", code: "25064002", display: "Headache" }], extension: [location] }],
      maxDosePerAdministration: q(2) };
    let row = persist(toFhirR5Dosages([raw])[0]);
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("right eye");
    row = persist(row);
    row.asNeededFor![0].extension![0].extension![1].valueCodeableConcept!.text = "left eye";
    const preview = formatSig(warm ? row : persist(row), "long", options);
    expect(preview).toContain("left eye");
    expect(preview).not.toContain("right eye");
  });

  it.each(["less than or equal to", "equal to", "local exact wording"])("reconciles EMA equality with supplied display %s", display => {
    const old = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display };
    const source = { value: 2, unit: "mg", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: old }] };
    const wire = toDosageDetails([{ doseAndRate: [{ doseQuantity: source }] }]);
    const dose = wire.step![0].component[0].doseAndRate![0].doseQuantity!;
    const active = dose.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
    expect(active.valueCoding).toEqual({ ...old, display: display === "less than or equal to" ? "equal to" : display });
    if (display === "less than or equal to") expect(JSON.stringify(dose.extension)).toContain('"display":"less than or equal to"');
    else expect(dose.extension).toHaveLength(1);
  });

  it("restores the newest comparator primitive while retaining an older same-operator marker", () => {
    let wire = simpleQuantityForR5({ ...q(2), comparator: "~", _comparator: { id: "A" } })!;
    wire.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!.code = "100000000052";
    const edited = quantityFromR5(wire)!;
    edited.comparator = "~";
    edited._comparator = { id: "B" };
    wire = simpleQuantityForR5(edited)!;
    for (let save = 0; save <= 2; save++) {
      const reopened = quantityFromR5(persist(wire))!;
      expect(reopened._comparator).toEqual({ id: "B" });
      expect(JSON.stringify(reopened.extension)).toContain('"id":"A"');
      wire = simpleQuantityForR5(reopened)!;
    }
  });
});


describe("round39 external interchange ownership and positional primitives", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const member = (): FhirR6Dosage => ({ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily } } });

  it.each(["r5", "r6"] as const)("retires a replaced scalar duration before a later clear (%s origin)", origin => {
    const marker: FhirExtension = { id: "approximate-hour", url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueQuantity: simpleQuantityForR5({ value: 60, unit: "min", comparator: "~" }),
      extension: [{ url: "urn:test:duration-note", valueString: "Original infusion duration" }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { extension: [marker] } } };
    const input = () => origin === "r5" ? persist(row) : course(persist(row));
    const control = importCanonicalCourse(input()).stages[0].administrations[0].schedule!.recurrence!;
    expect(control).toMatchObject({ occurrenceDuration: 60, occurrenceDurationUnit: "min", occurrenceDurationComparator: "~" });
    expect(projectCanonicalCourse(importCanonicalCourse(input())).fhirNext.step![0].component[0].timing!.repeat!.extension)
      .toContainEqual(marker);
    row.timing!.repeat!.duration = 45;
    row.timing!.repeat!.durationUnit = FhirPeriodUnit.Minute;
    const projection = projectCanonicalCourse(importCanonicalCourse(input()));
    for (const output of [projection.fhir[0], projection.fhirNext.step![0].component[0]]) {
      expect(output.timing!.repeat).toMatchObject({ duration: 45, durationUnit: "min" });
      expect(output.timing!.repeat!.extension?.some(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)).not.toBe(true);
      expect(JSON.stringify(output.extension)).toContain("approximate-hour");
      expect(JSON.stringify(output.extension)).toContain("Original infusion duration");
    }
    let wire = persist(projection.fhirNext);
    delete wire.step![0].component[0].timing!.repeat!.duration;
    delete wire.step![0].component[0].timing!.repeat!.durationUnit;
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(wire);
      expect(native.stages[0].administrations[0].schedule!.recurrence!.occurrenceDuration).toBeUndefined();
      const output = projectCanonicalCourse(native);
      expect(JSON.stringify(output.fhirNext)).toContain("approximate-hour");
      wire = persist(save === 1 ? toDosageDetails(output.fhir) : output.fhirNext);
    }
  });

  it.each([false, true])("gives an anonymous safety phase its own identity before a component move (move=%s)", move => {
    let wire = r6Save({ step: [{ component: [{ ...member(), id: "identified-member" }, member()],
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2) }] } }] });
    const phaseId = wire.step![0].id;
    expect(phaseId).toBeTruthy();
    if (move) wire.step!.push({ component: [wire.step![0].component.shift()!] });
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.safety).toBeUndefined();
      expect(native.stages[0].safety!.limits![0].amount).toEqual(q(2));
      if (move) {
        expect(native.stages[0].administrations).toHaveLength(1);
        expect(native.stages[1].safety).toBeUndefined();
        expect((native.stages[1].administrations[0].provenance!.data as FhirDosage).id).toBe("identified-member");
      }
      wire = persist(projectCanonicalCourse(native).fhirNext);
      expect(wire.step![0].id).toBe(phaseId);
    }
  });

  it.each(["code", "system", "version", "text", "delete"] as const)("checks newly submitted dose/rate role %s values against the saved baseline", field => {
    const role = { text: "Prescribed", coding: [{ system: "urn:dose-role", code: "ordered", version: "1" }] };
    let row = persist(withDosageEditProvenance([{
      text: "Take one tablet daily", doseAndRate: [{ type: role, doseQuantity: q(1) }], timing: { repeat: daily },
    }], "Take one tablet daily")[0]);
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    row = persist(row);
    if (field === "delete") delete (row.doseAndRate![0] as { type?: typeof role }).type;
    else if (field === "text") row.doseAndRate![0].type!.text = "Calculated";
    else row.doseAndRate![0].type!.coding![0][field] = "calculated";
    // A version-only annotation is outside the persisted clinical fingerprint;
    // independently submitted values keep that existing equivalence policy.
    const expected = field === "version";
    expect(dosageMatchesSavedProjection(row)).toBe(expected);
    expect(dosageMatchesSavedProjection(persist(row))).toBe(expected);
    expect(toDosageDetails([row]).step![0].component[0].doseAndRate![0].type).toEqual(row.doseAndRate![0].type);
    expect(row.doseAndRate![0].doseQuantity).toEqual(q(1));
    expect(row.text).toBe("Take one tablet daily");
  });

  it.each(["administration", "period", "lifetime"] as const)("shows a newly submitted %s safety limit", scope => {
    const row = persist(parseSig("take one tablet daily").fhir[0]) as EzDosage;
    const originalText = row.text;
    row.safety = { doseLimit: [{ scope, valueQuantity: q(2),
      ...(scope === "period" ? { period: { value: 1, unit: "d" } } : {}) }] };
    const preview = formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    expect(preview).toMatch(/\b1 tablet\b/);
    expect(preview).toContain("once daily");
    expect(preview).toContain("2 tab");
    expect(preview).toContain(scope === "administration" ? "max per administration" :
      scope === "lifetime" ? "max lifetime" : "max per period");
    expect(row.text).toBe(originalText);
    expect(importCanonicalCourse(row).stages[0].administrations[0].limits![0].amount).toEqual(q(2));
  });

  it.each([0, 1, 2])("keeps event primitive positions while scheduling only the authored timestamps (null slot %s)", emptyIndex => {
    const timestamps: Array<string | null> = ["2026-12-01T08:00:00Z", "2026-12-02T08:00:00Z"];
    timestamps.splice(emptyIndex, 0, null);
    const metadata: NonNullable<FhirR6Timing["_event"]> = [null, null, null];
    metadata[emptyIndex] = { id: "metadata-only-event", extension: [{ url: "urn:test:event", valueString: "Unspecified event" }] };
    let wire = course({ ...member(), timing: { event: timestamps, _event: metadata } });
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages[0].administrations[0].schedule!.explicitEvents)
        .toEqual(["2026-12-01T08:00:00Z", "2026-12-02T08:00:00Z"]);
      const output = projectCanonicalCourse(native);
      expect(output.fhirNext.step![0].component[0].timing).toEqual({ event: timestamps, _event: metadata });
      expect(output.fhir[0].timing).toEqual({ event: timestamps, _event: metadata });
      const options = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z",
        until: "2026-12-03T00:00:00Z", limit: 3, timeZone: "UTC" };
      expect(nextDueDoses(wire, options)).toEqual(["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
      expect(nextDueDoses(output.fhir, options)).toEqual(["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
      wire = persist(save === 1 ? toDosageDetails(output.fhir) : output.fhirNext);
    }
  });

  it.each(["r5", "r6"] as const)("merges a live lower duration into its existing independently authored range (%s)", origin => {
    const high = { id: "upper", value: 2, unit: "hours", code: "h", system: "http://unitsofmeasure.org",
      extension: [{ url: "urn:test:upper", valueString: "Do not convert" }] };
    const marker: FhirExtension = { id: "duration-range", url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL,
      valueRange: { high } };
    const row: FhirDosage = { doseAndRate: [{ rateQuantity: { value: 10, unit: "mL/h" } }],
      timing: { repeat: { duration: 90, durationUnit: FhirPeriodUnit.Minute, extension: [marker] } } };
    let input: FhirDosage | FhirR6DosageInstruction = origin === "r5" ? row : course(row);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(input));
      const duration = native.stages[0].administrations[0].schedule!.recurrence!;
      expect(duration.occurrenceDuration).toBeUndefined();
      expect(duration.occurrenceDurationRange).toEqual({ low: { value: 90, unit: "min",
        code: "min", system: "http://unitsofmeasure.org" }, high });
      const output = projectCanonicalCourse(native);
      for (const current of [output.fhir[0], output.fhirNext.step![0].component[0]]) {
        const active = current.timing!.repeat!.extension!.find(item => item.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)!;
        expect(active.id).toBe("duration-range");
        expect(active.valueRange!.low).toMatchObject({ value: 90, unit: "min" });
        expect(active.valueRange!.high).toEqual(high);
        expect(current.timing!.repeat!.duration).toBeUndefined();
      }
      input = save === 1 ? output.fhir[0] : output.fhirNext;
    }
  });

  it.each([false, true])("keeps live coding fields and an unchanged historical R6-only offset (edit=%s)", edit => {
    const old: FhirR6Dosage = { ...member(), id: "historical-member", route: { coding: [{ code: "oral" }] },
      timing: { repeat: { ...daily, startOffset: { value: 2, unit: "h" } } } };
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails",
      extension: [encodeR6SourceMetadata("step", { component: [old] }, "step")] }] };
    const coding = { code: "oral", ...(edit ? { system: "urn:clinical-routes", version: "2026" } : {}) };
    let rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: q(1) }], id: old.id, sequence: 1,
      timing: { repeat: daily }, route: { coding: [coding] }, modifierExtension: [marker] }];
    for (let save = 0; save < 3; save++) {
      const wire = toDosageDetails(persist(rows));
      expect(wire.step![0].component[0].route).toEqual({ coding: [coding] });
      expect(wire.step![0].component[0].timing!.repeat!.startOffset).toEqual({ value: 2, unit: "h" });
      rows = toFhirR5Dosages(wire);
    }
  });

  it("clears a course count through the supported external course header while retaining its source annotation", () => {
    const marker: FhirExtension = { id: "three-cycles", url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3,
      extension: [{ url: "urn:test:count", valueString: "Authored cycle count" }] };
    const editable = fromDosageDetails({ ...course(member()), repeatCycle: { value: 1, unit: "wk" },
      modifierExtension: [marker] });
    editable.course.modifierExtension = [];
    let wire = toDosageDetails(editable.dosages, undefined, editable.course);
    for (let save = 0; save < 3; save++) {
      expect(getCourseCycleCount(wire)).toBeUndefined();
      expect(JSON.stringify(wire)).toContain("three-cycles");
      expect(JSON.stringify(wire)).toContain("Authored cycle count");
      wire = persist(toDosageDetails(toFhirR5Dosages(wire)));
    }
  });

  it.each(["100000000051", "100000000049", "remove"] as const)("keeps a retired comparator primitive inactive after < then %s then < edits", interim => {
    const source = { ...q(2), comparator: "<" as const, _comparator: { id: "original-operator" } };
    let rows = persist(toFhirR5Dosages(course({ ...member(),
      safety: { doseLimit: [{ scope: "administration", valueQuantity: source }] } })));
    const setOperator = (code: string) => {
      const quantity = rows[0].maxDosePerAdministration!;
      if (code === "remove") {
        quantity.extension = quantity.extension!.filter(item => item.url !== EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
        return;
      }
      const operator = quantity.extension?.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
      if (operator) operator.valueCoding!.code = code;
      else (quantity.extension ??= []).push({ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } });
    };
    expect(toDosageDetails(rows).step![0].component[0].safety!.doseLimit![0].valueQuantity!._comparator)
      .toEqual({ id: "original-operator" });
    setOperator(interim);
    rows = persist(toFhirR5Dosages(toDosageDetails(rows)));
    setOperator("100000000050");
    for (let save = 0; save < 3; save++) {
      const wire = toDosageDetails(rows);
      const active = wire.step![0].component[0].safety!.doseLimit![0].valueQuantity!;
      expect(active).toMatchObject({ value: 2, unit: "tab", comparator: "<" });
      expect(active._comparator).toBeUndefined();
      expect(JSON.stringify(active.extension)).toContain("original-operator");
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it("uses only current external cycle-day children and preserves their independent annotations", () => {
    const marker: FhirExtension = { id: "cycle-rule", url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { id: "first-day", url: "day", valueInteger: 1 },
      { id: "third-day", url: "day", valueInteger: 3 },
      { url: "urn:test:cycle-note", valueString: "Independent annotation" },
    ] };
    const input = course({ ...member(), modifierExtension: [marker] });
    marker.extension!.splice(1, 1);
    const native = importCanonicalCourse(persist(input));
    expect(native.stages[0].administrations[0].cycleDays!.days).toEqual([1]);
    expect(projectCanonicalCourse(native).fhirNext.step![0].component[0].modifierExtension).toEqual([marker]);
  });

  it.each(["first", "last", "only"] as const)("restores a metadata-only clock's active primitive position (%s)", position => {
    const valued: FhirExtension = { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      valueTime: "08:00:00", _valueTime: { id: "morning" } };
    const empty: FhirExtension = { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, _valueTime: { id: "clock-metadata" } };
    const markers = position === "only" ? [empty] : position === "first" ? [empty, valued] : [valued, empty];
    const clocks = position === "only" ? [null] : position === "first" ? [null, "08:00:00"] : ["08:00:00", null];
    const annotations = position === "only" ? [empty._valueTime!] : position === "first"
      ? [empty._valueTime!, valued._valueTime!] : [valued._valueTime!, empty._valueTime!];
    let wire = course({ ...member(), timing: { repeat: { ...daily, when: [EventTiming.Morning], extension: markers } } });
    delete wire.step![0].component[0].timing!.repeat!.when;
    const first = projectCanonicalCourse(importCanonicalCourse(persist(wire)));
    expect(first.fhir[0].timing!.repeat!.timeOfDay).toBeUndefined();
    expect(first.fhir[0].timing!.repeat!.extension).toEqual(markers);
    expect(first.fhirNext.step![0].component[0].timing!.repeat!.timeOfDay).toEqual(clocks);
    expect(first.fhirNext.step![0].component[0].timing!.repeat!._timeOfDay).toEqual(annotations);
    wire = persist(first.fhirNext);
    // Once supplied as core arrays, both writers retain those authored positions.
    for (let save = 0; save < 3; save++) {
      const output = projectCanonicalCourse(importCanonicalCourse(persist(wire)));
      for (const current of [output.fhir[0], output.fhirNext.step![0].component[0]]) {
        expect(current.timing!.repeat!.timeOfDay).toEqual(clocks);
        expect(current.timing!.repeat!._timeOfDay).toEqual(annotations);
      }
      wire = persist(save === 1 ? toDosageDetails(output.fhir) : output.fhirNext);
    }
  });

  it.each(["first", "last", "only"] as const)("keeps an unchanged R5 clock bridge active across cold saves (%s)", position => {
    const empty: FhirExtension = { id: "pending-clock", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      _valueTime: { id: "clock-metadata" } };
    const valued: FhirExtension = { id: "known-clock", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      valueTime: "08:00:00", _valueTime: { id: "morning" } };
    const markers = position === "only" ? [empty] : position === "first" ? [empty, valued] : [valued, empty];
    const independent = [{ id: "authored-repeat-primitive" }];
    let rows: FhirDosage[] = [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { ...daily, extension: markers, _timeOfDay: independent } } }];
    for (let save = 0; save < 3; save++) {
      rows = persist(toFhirR5Dosages(rows));
      const repeat = rows[0].timing!.repeat!;
      expect(repeat.timeOfDay).toBeUndefined();
      expect(repeat._timeOfDay).toEqual(independent);
      expect(repeat.extension).toEqual(markers);
      expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.clocks)
        .toEqual(position === "only" ? [] : ["08:00:00"]);
    }
  });

  it("preserves fresh boolean and integer extension annotations through R6 and R5", () => {
    const extensions: FhirR6Extension[] = [
      { url: "urn:clinic:reviewed", valueBoolean: false,
        _valueBoolean: { id: "review-status", extension: [
          { url: "urn:clinic:note", valueString: "Retain review annotation" }
        ] } },
      { url: "urn:clinic:sequence", valueInteger: 7,
        _valueInteger: { id: "sequence-id", extension: [
          { url: "urn:clinic:note", valueString: "Retain integer annotation" }
        ] } }
    ];
    const input: FhirR6DosageInstruction = {
      renderedInstruction: "Take 2 tablets daily.",
      step: [{ component: [{ text: "Take 2 tablets daily.", extension: extensions,
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
      }] }]
    };
    const before = persist(input), r5 = toFhirR5Dosages(input), r5Before = persist(r5);
    const returned = toDosageDetails(persist(r5));
    const imported = fromFhir(input).fhirNext;
    for (const extension of extensions)
      for (const current of [r5[0], returned.step![0].component[0], imported.step![0].component[0]])
        expect(current.extension).toContainEqual(extension);
    expect(r5[0].extension?.find(item => item.url === extensions[0].url)?._valueBoolean)
      .toEqual(extensions[0]._valueBoolean);
    expect(r5[0].extension?.find(item => item.url === extensions[1].url)?._valueInteger)
      .toEqual(extensions[1]._valueInteger);
    expect(r5[0].text).toBe(input.renderedInstruction);
    expect(returned.renderedInstruction).toBe(input.renderedInstruction);
    expect(returned.step![0].component[0]).toMatchObject({
      text: "Take 2 tablets daily.",
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
    });
    const expected = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
    for (const current of [r5, returned])
      expect(formatSig(current, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected);
    expect(input).toEqual(before);
    expect(r5).toEqual(r5Before);
  });

  it("keeps optional condition choices exclusive without requiring a value or inventing runtime validation", () => {
    const noValue: FhirR6DosageCondition = { code: { text: "if needed" } };
    const primitive: FhirR6DosageCondition = { code: { text: "temperature" }, valueDecimal: 38,
      _valueDecimal: { id: "threshold" } };
    const metadataOnly: FhirR6DosageCondition = { code: { text: "temperature" }, _valueDecimal: { id: "pending-threshold" } };
    const quantity: FhirR6DosageCondition = { code: { text: "temperature" }, valueQuantity: { value: 38, unit: "Cel" } };
    const period: FhirR6DosageCondition = { code: { text: "while taking" }, valuePeriod: { start: "2026-12-01" } };
    // @ts-expect-error DosageCondition.value[x] permits at most one typed choice.
    const conflicting: FhirR6DosageCondition = { code: { text: "condition" }, valueQuantity: q(1), valuePeriod: { start: "2026-12-01" } };
    // @ts-expect-error Primitive metadata belongs to its own selected choice.
    const mismatched: FhirR6DosageCondition = { code: { text: "condition" }, valueQuantity: q(1), _valueBoolean: { id: "other-choice" } };
    expect([noValue, primitive, metadataOnly, quantity, period]).toHaveLength(5);
    expect(conflicting.valuePeriod).toEqual({ start: "2026-12-01" });
    expect(mismatched._valueBoolean).toEqual({ id: "other-choice" });
  });

  it("uses the documented dedicated R6 path for a metadata-only header without reclassifying R5 metadata", () => {
    const input = { id: "metadata-header", extension: [{ url: "urn:test:header", valueString: "Header note" }] };
    const result = fromFhir(persist(input));
    expect(result.meta.canonical.course!.stages).toEqual([]);
    expect(result.fhirNext).toEqual(input);
    expect(projectCanonicalCourse(importCanonicalCourse(result.fhir)).fhirNext).toEqual(input);
    const r5 = importCanonicalCourse(persist(input));
    expect((r5.stages[0].administrations[0].provenance!.data as FhirDosage).id).toBe("metadata-header");
    expect(projectCanonicalCourse(r5).fhirNext.step![0].component[0].extension).toEqual(input.extension);
  });
});


describe("round40 interchange live fields and retained source ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const relative = (days: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value: days, unit: "d" },
  });
  const following = { contextCode: { coding: [{
    system: "urn:ezmedicationinput:CodeSystem:course-phase-event", code: "previous-phase-next-day",
  }] } };
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 4 };
  const translation = (text: string, locale = "th") => ({ extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/translation",
    extension: [{ url: "lang", valueCode: locale }, { url: "content", valueString: text }],
  }] });

  it("keeps an editable R5 condition clear authoritative beside retained safety", () => {
    const predicate = { kind: "measurement" as const, name: "systolic blood pressure", operation: "gt" as const,
      value: 140, unit: "mmHg", text: "systolic blood pressure above 140 mmHg" };
    const row: EzDosage = { doseAndRate: [{ doseQuantity: q(1) }],
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(4) }] } };
    setDosageCondition(row, predicate);
    const input = toDosageDetails([row]);
    // A strict R5 row has no native condition field; its current bridge remains active.
    const strict = persist(toFhirR5Dosages(input));
    expect(strict[0]).not.toHaveProperty("condition");
    expect(importCanonicalCourse(strict).stages[0].administrations[0].predicate).toEqual(predicate);
    const editable = persist(fromDosageDetails(input));
    editable.dosages[0].condition = [];
    const before = JSON.stringify(editable);
    let current = toDosageDetails(editable.dosages, undefined, editable.course);
    for (let pass = 0; pass < 3; pass++) {
      const member = current.step![0].component[0];
      expect(importCanonicalCourse(current).stages[0].administrations[0].predicate).toBeUndefined();
      expect(member.modifierExtension?.some(marker => marker.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
      expect(member.safety?.doseLimit).toEqual([{ scope: "administration", valueQuantity: q(4) }]);
      expect(JSON.stringify(member.extension)).toContain("systolic blood pressure above 140 mmHg");
      current = pass === 1 ? toDosageDetails(persist(toFhirR5Dosages(current))) : r6Save(current);
    }
    expect(JSON.stringify(editable)).toBe(before);
  });

  it("preserves historical carrier annotations independently of the active compact header", () => {
    const carrier = toFhirR5Dosages({ renderedInstruction: "Consult clinician" })[0];
    carrier.id = "historical-carrier";
    carrier.extension = [{ url: "urn:test:historical-note", valueString: "authored carrier annotation" }];
    const header = { url: "urn:test:active-header", valueString: "current course annotation" };
    const compact = toFhirR5Dosages({ extension: [header], step: [{ id: "current-phase", component: [{
      doseAndRate: [{ doseQuantity: q(2) }],
    }] }] })[0];
    let rows = persist([carrier, compact]);
    const before = JSON.stringify(rows);
    for (let pass = 0; pass < 3; pass++) {
      const native = importCanonicalCourse(rows), projected = projectCanonicalCourse(native);
      expect(native.stages.map(stage => stage.administrations.length)).toEqual([1]);
      expect(projected.fhirNext.extension).toContainEqual(header);
      const sources = projected.fhirNext.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
      expect(JSON.stringify(sources)).toContain("historical-carrier");
      expect(JSON.stringify(sources)).toContain("authored carrier annotation");
      if (!pass) expect(JSON.stringify(rows)).toBe(before);
      rows = persist(projected.fhir);
    }
  });

  it.each([false, true])("keeps annotated narrative carriers inactive until a clinical edit (dose %s)", clinical => {
    const rows = toFhirR5Dosages({ renderedInstruction: "Consult clinician" });
    rows[0]._text = { id: "narrative-primitive", ...translation("ปรึกษาแพทย์") };
    if (clinical) rows[0].doseAndRate = [{ doseQuantity: q(2) }];
    const before = JSON.stringify(rows);
    let output = toDosageDetails(persist(rows));
    for (let pass = 0; pass < 3; pass++) {
      expect(output.step?.length ?? 0).toBe(clinical ? 1 : 0);
      if (clinical) expect(output.step![0].component[0].doseAndRate![0].doseQuantity?.value).toBe(2);
      else expect(output.renderedInstruction).toBe("Consult clinician");
      expect(JSON.stringify(output)).toContain("narrative-primitive");
      expect(JSON.stringify(output)).toContain("ปรึกษาแพทย์");
      output = toDosageDetails(persist(toFhirR5Dosages(output)));
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([false, true])("keeps only surviving induction modifiers scoped to induction (retain %s)", keepInduction => {
    const induction = { id: "induction-policy", url: "urn:test:induction", valueBoolean: true };
    const header = { id: "course-policy", url: "urn:test:course", valueBoolean: true };
    let wire = toDosageDetails([{ doseAndRate: [{ doseQuantity: q(1) }] }], undefined, {
      step: [{ sequence: 1, id: "induction", safety: { modifierExtension: [induction] } }],
    });
    wire.step!.push({ id: "maintenance", component: [{ doseAndRate: [{ doseQuantity: q(2) }] }] });
    wire.safety!.modifierExtension = [...(keepInduction ? [induction] : []), header];
    const before = JSON.stringify(wire);
    for (let pass = 0; pass < 3; pass++) {
      const native = importCanonicalCourse(wire);
      const scope = native.stages[0].provenance;
      expect((scope?.safety as FhirR6DosageSafety | undefined)?.modifierExtension ?? []).toEqual(keepInduction ? [induction] : []);
      expect((native.provenance?.data as FhirR6DosageInstruction).safety?.modifierExtension).toEqual([header]);
      expect(native.stages[1].provenance?.safety).toBeUndefined();
      if (!pass) expect(JSON.stringify(wire)).toBe(before);
      wire = pass === 1 ? toDosageDetails(persist(toFhirR5Dosages(wire))) : r6Save(wire);
    }
  });

  it.each(["timing-id", "timing-extension", "event-annotation", "repeat-id", "clock-annotation"] as const)(
    "preserves count-based pause ownership after %s changes", annotation => {
      let wire = toDosageDetails([
        { sequence: 1, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 2 } } },
        { sequence: 3, doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily, count: 2 } } },
      ], undefined, { step: [
        { sequence: 1, id: "induction" }, { sequence: 2, id: "pause", end: relative(5) },
        { sequence: 3, id: "maintenance", start: following },
      ] });
      const timing = wire.step![0].component[0].timing!;
      if (annotation === "timing-id") timing.id = "timing-note";
      else if (annotation === "timing-extension") timing.extension = [{ url: "urn:test:timing-note", valueString: "annotation" }];
      else if (annotation === "event-annotation") timing._event = [{ id: "event-note" }];
      else if (annotation === "repeat-id") timing.repeat!.id = "repeat-note";
      else timing.repeat!._timeOfDay = [{ id: "clock-note" }];
      const before = JSON.stringify(wire);
      for (let pass = 0; pass < 2; pass++) {
        expect(importCanonicalCourse(wire).stages.map(stage => stage.administrations.length)).toEqual([1, 0, 1]);
        expect(nextDueDoses(wire, options)).toEqual([
          "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
          "2026-01-06T08:00:00+00:00", "2026-01-07T08:00:00+00:00",
        ]);
        if (!pass) expect(JSON.stringify(wire)).toBe(before);
        wire = r6Save(wire);
      }
      wire.step![0].component[0].timing!.repeat!.count = 3;
      expect(importCanonicalCourse(wire).stages.map(stage => stage.administrations.length)).toEqual([1, 1]);
    });

  it("preserves independent R5 primitive metadata when an unchanged clock bridge gains an event anchor", () => {
    const bridge: FhirExtension[] = [
      { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, valueTime: "09:00:00", _valueTime: { id: "bridge-clock" } },
      { url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL, _valueTime: { id: "bridge-metadata" } },
    ];
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, extension: bridge,
      _timeOfDay: [{ id: "independent-primitive" }],
    } } };
    const unchanged = toFhirR5Dosages([row])[0];
    expect(unchanged.timing!.repeat!._timeOfDay).toEqual([{ id: "independent-primitive" }]);
    expect(unchanged.timing!.repeat!.extension).toEqual(bridge);
    const changed = persist(row);
    changed.timing!.repeat!.when = [EventTiming.Morning];
    const before = persist(changed);
    const mixed = toFhirR5Dosages([changed])[0].timing!.repeat!;
    expect(mixed.timeOfDay).toBeUndefined();
    expect(mixed._timeOfDay).toBeUndefined();
    expect(mixed.when).toEqual([EventTiming.Morning]);
    expect(mixed.extension).toEqual([...bridge, { url: DOSAGE_RECONCILIATION_SOURCE_URL,
      extension: [retainField("_timeOfDay", [{ id: "independent-primitive" }])] }]);
    expect(getTimingClocks(mixed)).toEqual(["09:00:00"]);
    expect(changed).toEqual(before);
  });

  it("preserves authored graph quantity operator Coding and primitive metadata", () => {
    const graph: CanonicalInstructionGraph = { actions: [{ force: AdviceForce.Instruction,
      predicate: { lemma: "rinse" },
      args: [{ role: AdviceArgumentRole.Amount, text: "at most 5 mL", quantity: { value: 5, unit: "mL", comparator: "<=" } }],
      span: { start: 0, end: 10 }, sourceText: "rinse 5 mL" }], sourceText: "rinse 5 mL" };
    let extension = buildInstructionGraphExtension(graph)!;
    const quantity = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
      .extension!.find(item => item.url === "argument")!.extension!.find(item => item.url === "quantity")!;
    const marker = quantity(extension).extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
    marker.id = "operator-extension";
    marker.valueCoding!.id = "operator-coding";
    marker.valueCoding!._code = { id: "operator-primitive" };
    const authored = persist(marker), before = JSON.stringify(extension);
    for (let pass = 0; pass < 3; pass++) {
      const reopened = parseInstructionGraphExtension([extension])!;
      expect(reopened.actions[0].args[0].quantity).toMatchObject({ value: 5, unit: "mL", comparator: "<=" });
      const next = buildInstructionGraphExtension(reopened)!;
      expect(quantity(next).extension).toContainEqual(authored);
      if (!pass) expect(JSON.stringify(extension)).toBe(before);
      extension = persist(next);
    }
    const fresh = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(fresh.actions[0].args[0].quantity).toEqual(graph.actions[0].args[0].quantity);
    const edited = quantity(extension).extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!;
    edited.valueCoding!.code = "100000000053";
    expect(parseInstructionGraphExtension([extension])!.actions[0].args[0].quantity?.comparator).toBe(">=");
  });
});

describe("round41 interop current wire ownership", () => {
  const daily = (): FhirR6Dosage => ({ id: "dose", doseAndRate: [{ doseQuantity: q(1) }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } });
  const afterDays = (value: number) => ({
    contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
    offsetDuration: { value, unit: "d" },
  });

  it("preserves a newly authored live safety policy beside retained reference-only site", () => {
    const site = { reference: { reference: "BodyStructure/left-arm", display: "left arm" } };
    const rows = persist(toFhirR5Dosages(course({ site }))) as EzDosage[];
    const safety = { ifExceeded: "Call the clinic", modifierExtension: [
      { url: "urn:test:policy", valueCode: "hold" },
    ] };
    rows[0].safety = safety;
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass < 3; pass++) {
      expect(saved.step![0].component[0].site).toEqual(site);
      expect(saved.step![0].component[0].safety).toEqual(safety);
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it("keeps phase scope after a limit annotation edit and appended maintenance", () => {
    const limit: FhirR6DoseLimit = { id: "phase-cap", scope: "administration", valueQuantity: q(2) };
    let wire = r6Save({ step: [{ id: "loading", component: [daily()], safety: { doseLimit: [limit] } }] });
    wire.step!.push({ id: "maintenance", component: [{ ...daily(), id: "maintenance-dose" }] });
    wire.safety!.doseLimit![0].valueQuantity!.id = "current-quantity";
    for (let pass = 0; pass < 3; pass++) {
      wire = r6Save(persist(wire));
      expect(wire.step![0].safety?.doseLimit).toEqual([{ ...limit, valueQuantity: { ...q(2), id: "current-quantity" } }]);
      expect(wire.safety?.doseLimit).toBeUndefined();
      expect(wire.step![1].safety).toBeUndefined();
    }
  });

  it("restores an opening draft after its successor cadence changes", () => {
    const wire = r6Save({ step: [
      { id: "pause", end: afterDays(2), component: [] },
      { id: "active", component: [daily()] },
    ] });
    wire.step![0].component[0].timing!.repeat!.frequency = 2;
    let saved = r6Save(persist(wire));
    for (let pass = 0; pass < 3; pass++) {
      const native = importCanonicalCourse(persist(saved));
      expect(native.stages.map(stage => stage.provenance?.id)).toEqual(["pause", "active"]);
      expect(native.stages[0].end?.displacement).toMatchObject({ value: 2, unit: "d" });
      expect(native.stages[1].administrations[0].schedule?.recurrence?.frequency).toBe(2);
      saved = projectCanonicalCourse(native).fhirNext;
    }
    wire.step![0].start = afterDays(4);
    expect(importCanonicalCourse(persist(wire)).stages).toHaveLength(1);
  });

  it("recognizes a course-count-only R6 header through generic formatting", () => {
    const header = { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] };
    expect(importCanonicalCourse(header).stages).toEqual([]);
    expect(importCanonicalCourse(header).cycleCount).toBe(3);
    expect(formatSig(header, "long", { locale: "en" })).toBe(fromFhir(header, { locale: "en" }).longText);
    expect(formatSig(header, "long", { locale: "en" })).toContain("3");
    expect(importCanonicalCourse({ ...header, text: "ordinary R5" }).stages).toHaveLength(1);
  });

  it("retains exact unchanged anonymous limit text before reconciling an edited neighbor", () => {
    const limits: FhirR6DoseLimit[] = [5, 10].map(value => ({ scope: "period",
      valueQuantity: { value, unit: "mg" }, period: { value: 1, unit: "d" }, text: value + " mg policy" }));
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: limits } })));
    rows[0].maxDosePerPeriod![0].numerator!.value = 6;
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass < 3; pass++) {
      expect(saved.step![0].component[0].safety!.doseLimit).toEqual([
        { ...limits[0], valueQuantity: { value: 6, unit: "mg" } }, limits[1],
      ]);
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it("keeps a deleted Ratio annotation cleared while retaining its R6-only text", () => {
    const annotation = { url: "urn:test:ratio-policy", valueString: "previous" };
    const rows = persist(toFhirR5Dosages(course({ safety: { doseLimit: [{
      id: "cap", scope: "period", valueQuantity: q(5), period: { value: 1, unit: "d" },
      text: "still current", extension: [annotation],
    }] } })));
    delete rows[0].maxDosePerPeriod![0].extension;
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass < 3; pass++) {
      const cap = saved.step![0].component[0].safety!.doseLimit![0];
      expect(cap).toEqual({ id: "cap", scope: "period", valueQuantity: q(5),
        period: { value: 1, unit: "d" }, text: "still current" });
      expect(JSON.stringify(saved)).toContain("urn:test:ratio-policy");
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it.each(["r5", "r6"] as const)("retires an exact-offset carrier superseded by a live core offset from %s", boundary => {
    const old = { url: TIMING_OFFSET_EXACT_EXTENSION_URL, id: "original-offset", valueDecimal: 15.5 };
    const component = { doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { when: [EventTiming["Before Meal"]], extension: [old], offset: 30 } } };
    let wire = boundary === "r5" ? toDosageDetails(persist([component])) : r6Save(course(persist(component)));
    expect(wire.step![0].component[0].timing!.repeat!.offset).toBe(30);
    expect(wire.step![0].component[0].timing!.repeat!.extension?.some(item => item.url === old.url)).toBeFalsy();
    expect(JSON.stringify(wire)).toContain("original-offset");
    delete wire.step![0].component[0].timing!.repeat!.offset;
    expect(importCanonicalCourse(persist(wire)).stages[0].administrations[0].schedule?.recurrence?.offset).toBeUndefined();
    const extensionOnly = r6Save(course({ timing: { repeat: { when: [EventTiming["Before Meal"]], extension: [old] } } }));
    expect(importCanonicalCourse(extensionOnly).stages[0].administrations[0].schedule?.recurrence?.offset).toBe(15.5);
  });

  it.each(["dose", "rate"] as const)("renders a source-less standalone %s expression", dimension => {
    const row: EzDosage = { doseAndRate: [{ [dimension + "Expression"]: expression("current_" + dimension) }] };
    for (const text of [formatSig(row, "long", { locale: "en" }), fromFhirDosage(row, { locale: "en" }).longText])
      expect(text).toContain("%current_" + dimension);
  });

  it("shows retained draft-only policy beside rendered source", () => {
    const wire = r6Save({ renderedInstruction: "Await assessment",
      step: [{ id: "pause", component: [], safety: { ifExceeded: "Call the clinic" } }] });
    expect(formatSig(wire, "long", { locale: "en" })).toContain("Call the clinic");
    expect(formatSig(wire, "long", { locale: "en" })).toBe(fromFhir(wire, { locale: "en" }).longText);
  });

  it("keeps a trailing draft policy in the imported batch formatter", () => {
    const wire = r6Save({ step: [
      { id: "active", component: [daily()] },
      { id: "pause", component: [], safety: { ifExceeded: "Call the clinic" } },
    ] });
    const batch = fromFhir(persist(wire), { locale: "en" });
    expect(batch.longText).toContain("Call the clinic");
    expect(formatParseBatch(batch, "long")).toBe(batch.longText);
  });

  it.each(["equal to", "less than or equal to", "local equality wording"])("reads R6 equality code with %s display consistently", display => {
    const marker = { url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: {
      system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000049", display,
      _code: { id: "operator-code" },
    } };
    let wire = course({ doseAndRate: [{ doseQuantity: { value: 5, unit: "mg", extension: [marker] } }] });
    for (let pass = 0; pass < 3; pass++) {
      wire = r6Save(persist(wire));
      const quantity = wire.step![0].component[0].doseAndRate![0].doseQuantity!;
      expect(quantity.value).toBe(5);
      expect(quantity.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!.display)
        .toBe(display === "less than or equal to" ? "equal to" : display);
      if (display === "less than or equal to") expect(JSON.stringify(quantity)).toContain(display);
    }
  });

  it("keeps active comparator primitive metadata through graph wire saves", () => {
    const graph: CanonicalInstructionGraph = { actions: [{ force: AdviceForce.Instruction,
      predicate: { lemma: "rinse" },
      args: [{ role: AdviceArgumentRole.Amount, text: "at most 5 mL", quantity: { value: 5, unit: "mL", comparator: "<=" } }],
      span: { start: 0, end: 10 }, sourceText: "rinse 5 mL" }], sourceText: "rinse 5 mL" };
    const quantity = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
      .extension!.find(item => item.url === "argument")!.extension!.find(item => item.url === "quantity")!;
    let wire = buildInstructionGraphExtension(graph)!;
    const marker: FhirExtension = { url: QUANTITY_OPERATOR_SOURCE_URL, valueCode: "<=",
      _valueCode: { id: "active-operator", extension: [{ url: "urn:test:primitive", valueString: "retain" }] } };
    quantity(wire).extension!.push(marker);
    for (let pass = 0; pass < 3; pass++) {
      const reopened = parseInstructionGraphExtension([persist(wire)])!;
      expect(reopened.actions[0].args[0].quantity).toMatchObject({ comparator: "<=",
        comparatorElement: marker._valueCode });
      wire = buildInstructionGraphExtension(reopened)!;
      expect(quantity(wire).extension).toContainEqual(marker);
    }
  });
});

describe("round42 interop current public contracts", () => {
  it("keeps dose-rate policy in its legal Element extension on strict R5 export", () => {
    const policy = { url: "urn:test:slot-policy", valueCode: "retain", _valueCode: { id: "policy-code" } };
    const wrapper = { id: "slot-wrapper", url: R5_RATE_MODIFIERS_R6_URL, extension: [policy] };
    const note = { url: "urn:test:slot-note", valueString: "authored note" };
    let wire = course({ doseAndRate: [{ doseQuantity: q(2), extension: [wrapper, note] }] });
    for (let pass = 0; pass < 3; pass++) {
      const rows = persist(toFhirR5Dosages(wire));
      expect(rows[0].doseAndRate![0]).toEqual({ doseQuantity: q(2), extension: [wrapper, note] });
      expect(rows[0].doseAndRate![0]).not.toHaveProperty("modifierExtension");
      wire = toDosageDetails(rows);
      expect(wire.step![0].component[0].doseAndRate![0]).toEqual({ doseQuantity: q(2), extension: [wrapper, note] });
    }
  });

  it("keeps an identified opening pause when its successor gains a concurrent dose", () => {
    const end = { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] },
      offsetDuration: { value: 2, unit: "d" } };
    const first = { id: "first-dose", doseAndRate: [{ doseQuantity: q(1) }] };
    const second = { id: "second-dose", doseAndRate: [{ doseQuantity: q(2) }] };
    let wire = r6Save({ step: [{ id: "pause", end, component: [] }, { id: "active", component: [first] }] });
    wire.step![0].component.push(second);
    for (let pass = 0; pass < 3; pass++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages.map(stage => stage.provenance?.id)).toEqual(["pause", "active"]);
      expect(native.stages[0].end?.displacement).toMatchObject({ value: 2, unit: "d" });
      expect(native.stages[1].administrations.map(a => a.amounts?.[0].quantity?.value)).toEqual([1, 2]);
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].component).toEqual([first, second]);
      if (pass === 1) wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each([0, -1])("preserves normalized R5 sequence %s through persisted R6 and later live edits", sequence => {
    const note = { url: "urn:test:sequence-note", valueString: "keep" };
    let wire = toDosageDetails([{ sequence, doseAndRate: [{ doseQuantity: q(1) }], extension: [note] }]);
    for (let pass = 0; pass < 3; pass++) {
      const rows = persist(toFhirR5Dosages(persist(wire)));
      expect(rows[0].sequence).toBe(sequence);
      expect(rows[0].extension).toContainEqual(note);
      expect(rows[0].doseAndRate).toEqual([{ doseQuantity: q(1) }]);
      wire = toDosageDetails(rows);
    }
    const changed = persist(toFhirR5Dosages(wire));
    changed[0].sequence = 1;
    const saved = toDosageDetails(changed);
    expect(toFhirR5Dosages(persist(saved))[0].sequence).toBe(1);
    expect(saved.step![0].component[0].extension?.some(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toBeFalsy();
    expect(JSON.stringify(saved)).toContain(DOSAGE_RETAINED_R5_SEQUENCE_URL);
    const ordinary = toDosageDetails([{ sequence: 1, doseAndRate: [{ doseQuantity: q(1) }] }]);
    expect(ordinary.step![0].component[0].extension?.some(item => item.url === DOSAGE_RETAINED_R5_SEQUENCE_URL)).toBeFalsy();
  });

  it("preserves authored rate directions and an independent cap in fresh R5 roundtrip callbacks", () => {
    const text = "Infuse 5 mL/h, maximum 10 mL per administration";
    const row: FhirDosage = { text, maxDosePerAdministration: { value: 10, unit: "mL" } };
    const before = persist(row);
    const seen: string[] = [];
    const options: FormatOptions = { locale: "en", realizationMode: "roundtrip", i18n: {
      formatShort(context) { seen.push(context.realizationMode); return context.defaultText; },
      formatLong(context) { seen.push(context.realizationMode); return context.defaultText; },
    } };
    const imported = fromFhirDosage(row, options);
    const direct = formatSig(row, "long", options);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["roundtrip"]));
    expect(imported.longText).toBe(direct);
    for (const preview of [imported.shortText, imported.longText, direct]) {
      expect(preview).toContain(text);
      expect(preview).toContain("max per administration: 10 mL");
    }
    const r6 = toDosageDetails([row]), returned = toFhirR5Dosages(r6)[0];
    expect(importCanonicalCourse(row).stages[0].administrations[0].amounts).toBeUndefined();
    expect(r6.step![0].component[0].doseAndRate).toBeUndefined();
    expect(returned.doseAndRate).toBeUndefined();
    expect(returned.maxDosePerAdministration).toEqual(row.maxDosePerAdministration);
    expect(returned.text).toBe(text);
    expect(row).toEqual(before);
  });

  it("keeps metadata-only clock bridge outside core clocks beside a when anchor", () => {
    const marker = { id: "clock-source", url: TIMING_ADDITIONAL_CLOCK_EXTENSION_URL,
      _valueTime: { id: "clock-primitive", extension: [{ url: "urn:test:clock-note", valueString: "unknown time" }] } };
    let wire = course({ timing: { repeat: { when: [EventTiming.Morning], extension: [marker] } } });
    for (let pass = 0; pass < 3; pass++) {
      wire = r6Save(persist(wire));
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.when).toEqual([EventTiming.Morning]);
      expect(repeat.timeOfDay).toBeUndefined();
      expect(repeat._timeOfDay).toBeUndefined();
      expect(repeat.extension).toEqual([marker]);
      const strict = persist(toFhirR5Dosages(wire));
      expect(strict[0].timing!.repeat!.extension).toEqual([marker]);
      expect(strict[0].timing!.repeat!.timeOfDay).toBeUndefined();
      wire = toDosageDetails(strict);
    }
    const clock = r6Save(course({ timing: { repeat: { extension: [{ ...marker, valueTime: "08:00:00" }] } } }))
      .step![0].component[0].timing!.repeat!;
    expect(clock.timeOfDay).toEqual(["08:00:00"]);
    expect(clock._timeOfDay).toEqual([marker._valueTime]);
  });

  it("retains local quantity annotations beside the active graph comparator", () => {
    const graph: CanonicalInstructionGraph = { actions: [{ force: AdviceForce.Instruction,
      predicate: { lemma: "take" },
      args: [{ role: AdviceArgumentRole.Amount, text: "at most 2 tablets", quantity: { value: 2, unit: "tab", comparator: "<=" } }],
      span: { start: 0, end: 20 }, sourceText: "take at most 2 tablets" }], sourceText: "take at most 2 tablets" };
    const quantity = (wire: FhirExtension) => wire.extension!.find(item => item.url === "action")!
      .extension!.find(item => item.url === "argument")!.extension!.find(item => item.url === "quantity")!;
    const note = { url: "urn:test:local-quantity", id: "local-note",
      extension: [{ url: "author", valueString: "clinic" }, { url: "tag", valueCoding: { system: "urn:test:tags", code: "reviewed" } }] };
    let wire = buildInstructionGraphExtension(graph)!;
    quantity(wire).extension!.push(note);
    for (let pass = 0; pass < 3; pass++) {
      const before = JSON.stringify(wire);
      const restored = parseInstructionGraphExtension([wire])!;
      expect(restored.actions[0].args[0].quantity).toMatchObject({ value: 2, unit: "tab", comparator: "<=" });
      const saved = buildInstructionGraphExtension(restored)!;
      expect(quantity(saved).extension).toContainEqual(note);
      expect(JSON.stringify(wire)).toBe(before);
      wire = persist(saved);
    }
  });
});


describe("round42 public compatibility output and explicit source clears", () => {
  it.each([
    "and from day 10 take 3 tablets at 15:00",
    "and 3 tablets from day 10 at 15:00",
  ])("retains an independent day-10 member in parser R5 rows: %s", ending => {
    const parsed = parseSig("Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day " + ending);
    const expected = [
      "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
      "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T06:00:00+00:00",
      "2026-11-30T15:00:00+00:00", "2026-12-01T15:00:00+00:00",
    ];
    const saved = persist(parsed.fhir);
    for (const input of [parsed, parsed.fhirNext, saved, toDosageDetails(saved),
      persist(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(nextDueDoses(input, { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z",
        timeZone: "UTC", limit: 8 })).toEqual(expected);
    }
    expect(saved.map(row => row.doseAndRate?.[0].doseQuantity?.value)).toEqual([1, 2, 3]);
    expect(saved.map(row => row.sequence)).toEqual([1, 2, 2]);
    expect(parsed.input).toContain(ending);
  });

  it.each(["fresh", "persisted"] as const)("keeps roundtrip callbacks after a newly submitted text clear (original %s)", kind => {
    const parsed = parseSig("Swallow 1 tablet whole at bedtime per the agreed plan.");
    let row = kind === "fresh" ? structuredClone(parsed.fhir[0]) : persist(parsed.fhir[0]);
    const seen: string[] = [];
    const options: FormatOptions = { locale: "en", realizationMode: "roundtrip", i18n: {
      formatLong(context) { seen.push(context.realizationMode); return context.defaultText; },
    } };
    row.text = "Swallow 1 tablet whole at bedtime after discussion with the clinician.";
    expect(fromFhirDosage(row, options).longText).toBe(row.text);
    row = persist(row);
    row.text = "";
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).not.toContain("per the agreed plan");
      expect(text).not.toContain("discussion with the clinician");
      expect(text).toContain("1 tablet");
      expect(text).toMatch(/bedtime|on sleep/u);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["roundtrip"]));
    expect(row.text).toBe("");
  });
});


describe("round43 live editable exclusions and safety metadata", () => {
  const marker: FhirExtension = { id: "date-source", url: DOSAGE_EXCLUDED_DATES_R5_URL,
    extension: [{ url: "date", valueDate: "2026-11-23", id: "date-child" },
      { url: "urn:test:exclusion-note", valueString: "keep original date annotation" }] };
  const daily: FhirR6Dosage = { text: "Take 1 tablet daily.", doseAndRate: [{ doseQuantity: q(1) }],
    timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }, modifierExtension: [marker] };

  it("clears an excluded date despite a separately retained site wrapper", () => {
    const site = { id: "site-wrapper", concept: { text: "left arm" },
      extension: [{ url: "urn:test:site-note", valueString: "keep site annotation" }] };
    const source = course({ ...daily, site });
    const original = JSON.stringify(source);
    const edited = fromDosageDetails(persist(source));
    expect(edited.dosages[0].excludedDates).toEqual(["2026-11-23"]);
    const unchanged = toDosageDetails(persist(edited.dosages), undefined, edited.course);
    expect(unchanged.step![0].component[0].modifierExtension).toContainEqual(marker);
    edited.dosages[0].excludedDates = [];
    let wire = toDosageDetails(edited.dosages, undefined, edited.course);
    for (let pass = 0; pass < 3; pass++) {
      const component = wire.step![0].component[0];
      expect(getDosageExcludedDates({ modifierExtension: component.modifierExtension })).toEqual([]);
      expect(component.site).toEqual(site);
      expect(JSON.stringify(component.extension)).toContain("date-source");
      expect(nextDueDoses(wire, { orderedAt: "2026-11-22T00:00:00Z", from: "2026-11-22T00:00:00Z",
        timeZone: "UTC", limit: 3 })).toEqual([
        "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00", "2026-11-24T09:00:00+00:00",
      ]);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each([false, true])("lifts editable dates independently of unrelated step metadata (%s)", annotated => {
    const source = course(persist(daily));
    if (annotated) source.step![0].extension = [{ url: "urn:test:step-note", valueString: "keep" }];
    const edited = fromDosageDetails(source);
    const imported = fromFhir(source);
    expect(edited.dosages[0].excludedDates).toEqual(["2026-11-23"]);
    expect(imported.fhir[0].excludedDates).toEqual(["2026-11-23"]);
    expect(imported.items[0].fhir).not.toHaveProperty("excludedDates");
    expect(imported.items[0].fhir.modifierExtension).toContainEqual(marker);
    expect(toEzDosages([persist(daily) as FhirDosage])[0].excludedDates).toEqual(["2026-11-23"]);
    const strict = toFhirR5Dosages(source)[0];
    expect(strict).not.toHaveProperty("excludedDates");
    expect(strict.modifierExtension).toContainEqual(marker);
  });

  it("shows a lifted safety-only cap in normalized standalone R5 previews", () => {
    const row: EzDosage = { text: "Take 1 tablet daily.", doseAndRate: [{ doseQuantity: q(1) }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      safety: { doseLimit: [{ scope: "administration", valueQuantity: q(2) }],
        extension: [{ url: "urn:test:safety-note", valueString: "keep" }] } };
    const before = JSON.stringify(row);
    const options: FormatOptions = { locale: "en", realizationMode: "normalized" };
    const imported = fromFhirDosage(row, options);
    for (const text of [formatSig(row, "short", options), formatSig(row, "long", options),
      imported.shortText, imported.longText]) {
      expect(text).toContain("max per administration: 2 tab");
      expect(text).toMatch(/1 tab(?:let)?/u);
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" }).split("; original directions: "))
      .toEqual(["Current: Use 1 tablet once daily; max per administration: 2 tab", row.text]);
  });

  it.each([false, true])("keeps period text at its own Ratio-list position (reordered %s)", reordered => {
    const wire = course({ doseAndRate: [{ doseQuantity: q(1) }], safety: { doseLimit: [
      { scope: "administration", valueQuantity: q(3), text: "each dose" },
      { scope: "period", valueQuantity: q(4), period: { value: 1, unit: "d" }, text: "first daily ceiling" },
      { scope: "period", valueQuantity: q(8), period: { value: 1, unit: "d" }, text: "second daily ceiling" },
    ] } });
    const rows = persist(toFhirR5Dosages(wire));
    rows[0].maxDosePerAdministration!.value = 5;
    if (reordered) rows[0].maxDosePerPeriod!.reverse();
    let saved = toDosageDetails(rows);
    for (let pass = 0; pass < 3; pass++) {
      const limits = saved.step![0].component[0].safety!.doseLimit!;
      const periods = limits.filter(limit => limit.scope === "period");
      expect(periods.map(limit => limit.valueQuantity!.value)).toEqual(reordered ? [8, 4] : [4, 8]);
      expect(periods.map(limit => limit.text)).toEqual(reordered ? [undefined, undefined]
        : ["first daily ceiling", "second daily ceiling"]);
      expect(JSON.stringify(saved)).toContain("first daily ceiling");
      expect(JSON.stringify(saved)).toContain("second daily ceiling");
      expect(limits.find(limit => limit.scope === "administration")).toMatchObject({
        text: "each dose", valueQuantity: q(5),
      });
      saved = toDosageDetails(persist(toFhirR5Dosages(saved)));
    }
  });

  it("preserves a foreign-coded duration endpoint through public import/export", () => {
    const range = { low: { value: 30, unit: "minutes", system: "http://unitsofmeasure.org", code: "min", id: "lower" },
      high: { value: 2, unit: "half-hour blocks", system: "urn:test:duration-units", code: "half-hour-block", id: "upper",
        extension: [{ url: "urn:test:duration-note", valueString: "keep authored coding" }] } };
    const source: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { boundsRange: { low: range.low } } },
      modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
        { url: "low", valueQuantity: range.low }, { url: "high", valueQuantity: range.high },
      ] }] };
    const before = JSON.stringify(source);
    let wire = toDosageDetails([persist(source)]);
    for (let pass = 0; pass < 3; pass++) {
      const strict = persist(toFhirR5Dosages(wire));
      expectActiveMixedDuration(strict[0], range);
      expectActiveMixedDuration(fromFhir(wire).fhir[0], range);
      expectActiveMixedDuration(fromFhirDosage(strict[0]).fhir, range);
      wire = toDosageDetails(strict);
      expectActiveMixedDuration(wire.step![0].component[0], range);
      expect(importCanonicalCourse(wire).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange).toEqual(range);
    }
    expect(JSON.stringify(source)).toBe(before);
  });
});


describe("round44 interop ownership", () => {
  const ucum = "http://unitsofmeasure.org";
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const amount = (value: number, unit: string) => ({ value, unit, code: unit, system: ucum });
  const afterDays = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d", code: "d" } });
  const carrierUrl = "urn:ezmedicationinput:StructureDefinition:medication-infusion-carrier-material";

  it.each([false, true])("keeps exclusions wire-only in strict R5 after an editable clear=%s", clear => {
    const note = { url: "urn:test:exclusion-note", valueString: "keep this annotation" };
    const row: EzDosage = { timing: { repeat: daily }, doseAndRate: [{ doseQuantity: q(1) }], extension: [note] };
    setDosageExcludedDates(row, ["2026-11-23"]);
    row.excludedDates = clear ? [] : ["2026-11-23"];
    const original = persist(row);
    let strict = persist(toFhirR5Dosages([row]));
    for (let save = 0; save < 3; save++) {
      expect(strict[0]).not.toHaveProperty("excludedDates");
      expect(getDosageExcludedDates(strict[0])).toEqual(clear ? [] : ["2026-11-23"]);
      expect(strict[0].extension).toContainEqual(note);
      const wire = toDosageDetails(strict);
      const editable = fromDosageDetails(wire).dosages[0];
      expect(editable.excludedDates ?? []).toEqual(clear ? [] : ["2026-11-23"]);
      strict = persist(toFhirR5Dosages(wire));
    }
    expect(row).toEqual(original);
  });

  it.each(["dose", "cadence"] as const)("retains an opening pause across a later anonymous %s edit", edit => {
    let wire = r6Save({ step: [
      { id: "pause", end: afterDays(2), component: [] },
      { component: [{ timing: { repeat: { ...daily, boundsDuration: { value: 3, unit: "d" } } }, doseAndRate: [{ doseQuantity: q(1) }] }] },
      { component: [{ timing: { repeat: daily }, doseAndRate: [{ doseQuantity: q(2) }] }] },
    ] });
    if (edit === "dose") wire.step![1].component[0].doseAndRate![0].doseQuantity!.value = 3;
    else wire.step![1].component[0].timing!.repeat!.frequency = 2;
    const currentBoundary = persist(wire.step![0].start);
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages).toHaveLength(3);
      expect(native.stages[0].provenance?.id).toBe("pause");
      expect(native.stages[0].administrations).toEqual([]);
      expect(native.stages[0].end?.displacement).toMatchObject({ value: 2, unit: "d" });
      expect(native.stages[1].administrations[0].amounts![0].quantity!.value).toBe(1);
      expect(native.stages[2].administrations[0].amounts![0].quantity!.value).toBe(edit === "dose" ? 3 : 2);
      expect(native.stages[2].administrations[0].schedule?.recurrence?.frequency).toBe(edit === "cadence" ? 2 : 1);
      wire = projectCanonicalCourse(native).fhirNext;
      expect(wire.step![0].start).toEqual(currentBoundary);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
    wire.step![0].start = afterDays(4);
    expect(importCanonicalCourse(persist(wire)).stages).toHaveLength(2);
  });

  it("keeps the opening pause when an independent finite tail phase is removed", () => {
    let wire = r6Save({ step: [
      { id: "pause", end: afterDays(2), component: [] },
      { component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
        ...daily, boundsDuration: { value: 3, unit: "d" },
      } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: {
        ...daily, boundsDuration: { value: 2, unit: "d" },
      } } }] },
    ] });
    wire.step!.pop();
    for (let save = 0; save < 3; save++) {
      const native = importCanonicalCourse(persist(wire));
      expect(native.stages).toHaveLength(2);
      expect(native.stages[0].provenance?.id).toBe("pause");
      expect(native.stages[0].administrations).toEqual([]);
      expect(native.stages[0].end?.displacement).toMatchObject({ value: 2, unit: "d" });
      expect(native.stages[1].administrations[0].amounts![0].quantity!.value).toBe(1);
      expect(native.stages[1].administrations[0].schedule!.recurrence!.courseLength).toMatchObject({ value: 3, unit: "d" });
      wire = toDosageDetails(persist(projectCanonicalCourse(native).fhir));
    }
    wire.step![0].start = afterDays(4);
    expect(importCanonicalCourse(persist(wire)).stages).toHaveLength(1);
  });

  it.each([["fresh", false], ["fresh", true], ["persisted", true]] as const)(
    "uses a newly submitted carrier on a %s row (original previewed=%s)", (kind, warm) => {
    const parsed = parseSig("Infuse 20 mg in 100 mL saline over 2 hours, max 100 mg per day");
    let row = kind === "fresh" ? parsed.fhir[0] : persist(parsed.fhir[0]);
    if (warm) expect(formatSig(row, "long")).toContain("saline");
    row = persist(row);
    const marker = row.extension!.find(e => e.url === carrierUrl)!;
    marker.extension!.find(e => e.url === "material")!.valueString = "dextrose";
    const current = persist(row);
    const directSaves = [persist(toFhirR5Dosages([row]))[0], persist(toFhirR5Dosages([persist(row)]))[0]];
    expect(formatSig(row, "long")).not.toContain("saline");
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const options = { locale: "en", realizationMode };
      for (const text of [formatSig(row, "long", options), formatSig(persist(row), "long", options),
        fromFhirDosage(row, options).longText, formatSig(toDosageDetails([row]), "long", options),
        ...directSaves.map(saved => formatSig(saved, "long", options))]) {
        expect(text).not.toContain("saline");
        expect(text).toContain("dextrose");
        expect(text).toContain("20 mg");
        expect(text).toContain("100 mL");
      }
    }
    expect(row).toEqual(current);
    for (const saved of directSaves) {
      // A saved row may retain stale wording in provenance instead of active text.
      expect(JSON.stringify(saved)).toContain(JSON.stringify(current.text));
      expect(saved.extension!.find(e => e.url === carrierUrl)).toEqual(marker);
      expect(saved.doseAndRate).toEqual(current.doseAndRate);
    }
    const saved = persist(toFhirR5Dosages(toDosageDetails([row])))[0];
    expect(saved.extension!.find(e => e.url === carrierUrl)).toEqual(marker);
    expect(saved.doseAndRate).toEqual(current.doseAndRate);
  });

  it.each(["fresh", "persisted"] as const)("retains explicit clinician text on a newly submitted %s carrier row", kind => {
    const parsed = parseSig("Infuse 20 mg in 100 mL saline over 2 hours, max 100 mg per day");
    const row = kind === "fresh" ? structuredClone(parsed.fhir[0]) : persist(parsed.fhir[0]);
    row.extension!.find(e => e.url === carrierUrl)!.extension!.find(e => e.url === "material")!.valueString = "dextrose";
    row.text = "Use the dextrose carrier per the agreed infusion plan";
    const authored = persist(row);
    expect(dosageMatchesSavedProjection(row)).toBe(false);
    const expected = "Infuse 20 mg once over 2 hours; max per period: 100 mg / 1 d; Rate: 100 mL dextrose / 2 h";
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const preview = "Current: " + expected + "; original directions: " + row.text;
      expect(formatSig(row, "long", { locale: "en", realizationMode })).toBe(preview);
      const imported = fromFhirDosage(row, { locale: "en", realizationMode });
      expect(imported.longText).toBe(preview);
      expect(imported.fhir).toEqual(authored);
      expect(imported.meta.canonical.clauses[0].rawText).toBe(row.text);
    }
    const saved = persist(toFhirR5Dosages([row]))[0];
    const savedSnapshot = persist(saved);
    expect(saved.text).toBe(row.text);
    expect(saved.extension!.find(e => e.url === carrierUrl))
      .toEqual(authored.extension!.find(e => e.url === carrierUrl));
    expect(saved.doseAndRate).toEqual(authored.doseAndRate);
    expect(saved.timing).toEqual(authored.timing);
    expect(saved.maxDosePerPeriod).toEqual(authored.maxDosePerPeriod);
    // The saved row has a new baseline matching its current clinical fields.
    // Verified roundtrip can replay it; normalized still states every live fact.
    expect(dosageMatchesSavedProjection(saved)).toBe(true);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const preview = realizationMode === "roundtrip" ? row.text : expected;
      expect(formatSig(saved, "long", { locale: "en", realizationMode })).toBe(preview);
      const imported = fromFhirDosage(saved, { locale: "en", realizationMode });
      expect(imported.longText).toBe(preview);
      expect(imported.fhir).toEqual(savedSnapshot);
      expect(imported.meta.canonical.clauses[0].rawText).toBe(row.text);
    }
    expect(saved).toEqual(savedSnapshot);
    expect(row).toEqual(authored);
  });

  it.each(["unresolved", "recognized", "missing"] as const)("keeps the explicit %s duration owner ahead of a ratio fallback", kind => {
    const duration = kind === "unresolved"
      ? { value: 3, unit: "half-hour blocks", system: "urn:clinic:duration-units", code: "h", id: "authored-duration" }
      : { value: 2, unit: "hours", system: ucum, code: "h", id: "authored-duration" };
    const marker = { url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueQuantity: duration };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...(kind !== "missing" ? { timing: { repeat: { extension: [persist(marker)] } } } : {}),
      doseAndRate: [{ doseQuantity: amount(500, "mL"), rateRatio: {
        numerator: amount(500, "mL"), denominator: simpleQuantityForR5({ ...amount(2, "h"), comparator: "~" })!,
      } }],
    }] }] };
    const original = persist(raw);
    const rows = persist(toFhirR5Dosages(raw));
    for (const input of [raw, rows[0]]) {
      const native = importCanonicalCourse(input).stages[0].administrations[0];
      const recurrence = native.schedule?.recurrence;
      expect(recurrence?.occurrenceDuration).toBe(kind === "unresolved" ? 3 : 2);
      expect(recurrence?.occurrenceDurationUnit).toBe(kind === "unresolved" ? undefined : "h");
      expect(recurrence?.occurrenceDurationComparator).toBe(kind === "missing" ? "~" : undefined);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      if (kind === "unresolved") expect(text).not.toContain("over approximately 2 hours");
      else expect(text).toContain(kind === "missing" ? "over approximately 2 hours" : "over 2 hours");
      expect(text).toContain("500 mL");
    }
    expect(raw).toEqual(original);
    const saved = toDosageDetails(rows).step![0].component[0];
    if (kind !== "missing") expect(saved.timing!.repeat!.extension).toContainEqual(marker);
    expect(saved.doseAndRate![0].rateRatio!.numerator).toEqual(amount(500, "mL"));
    expect(saved.doseAndRate![0].rateRatio!.denominator).toMatchObject({ value: 2, unit: "h", code: "h", system: ucum });
  });
});


describe("round45 public interop preservation", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  // Same frozen former-writer wire as the established migration oracle above.
  // It is not regenerated by the current writer or changed to create a conflict.
  const formerWriterRow = {
  "timing": {
    "repeat": {
      "frequency": 1,
      "boundsDuration": {
        "value": 7,
        "unit": "days",
        "system": "http://unitsofmeasure.org",
        "code": "d"
      },
      "period": 1,
      "periodUnit": "d"
    }
  },
  "text": "Use 1 tablet once daily for 7 days.",
  "sequence": 1,
  "doseAndRate": [
    {
      "doseQuantity": {
        "value": 1,
        "unit": "tab",
        "system": "http://standardterms.edqm.eu",
        "code": "15054000"
      }
    }
  ],
  "modifierExtension": [
    {
      "url": "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      "extension": [
        {
          "url": "rowIndex",
          "valueInteger": 0
        },
        {
          "url": "sequence",
          "valueInteger": 1
        },
        {
          "url": "stepCount",
          "valueInteger": 1
        },
        {
          "url": "step",
          "extension": [
            {
              "url": "count",
              "valueInteger": 3
            }
          ]
        },
        {
          "url": "context",
          "valueString": "72f2f03d1f8289c5"
        },
        {
          "url": "contextRequired",
          "valueBoolean": true
        },
        {
          "url": "course",
          "extension": [
            {
              "url": "repeatCycle",
              "valueQuantity": {
                "value": 14,
                "unit": "d",
                "code": "d",
                "system": "http://unitsofmeasure.org"
              }
            }
          ]
        }
      ]
    }
  ],
  "extension": [
    {
      "url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction",
      "extension": [
        {
          "url": "instruction",
          "valueString": "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles"
        },
        {
          "url": "row",
          "extension": [
            {
              "url": "projectionFingerprint",
              "valueString": "4346df4e5678f52b"
            },
            {
              "url": "textFingerprint",
              "valueString": "dab22a241c7d0f4f"
            }
          ]
        }
      ]
    }
  ]
} as FhirDosage;

  it.each([false, true])("retains both first-phase count owners across different contexts (reversed=%s)", reverse => {
    const current = persist(toFhirR5Dosages({ step: [{ count: 3, component: [{
      doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: { ...daily, boundsDuration: { value: 7, unit: "d" } } },
    }] }] }))[0];
    const currentMarker = persist(current.modifierExtension!.find(e => e.url === DOSAGE_DETAILS_R5_URL)!);
    let rows = persist(reverse ? [current, formerWriterRow] : [formerWriterRow, current]);
    const options = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 50 };
    for (let save = 0; save < 3; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      expect(wire.step![0].count).toBe(3);
      expect(getCourseCycleCount(wire)).toBeUndefined();
      expect(() => nextDueDoses(rows, options)).toThrow(/conflicting|resolve|complete dosage array/i);
      expect(() => calculateTotalUnits({ ...options, dosage: rows, durationValue: 42, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/conflicting|resolve|complete dosage array/i);
      expect(JSON.stringify(wire)).toContain(JSON.stringify(formerWriterRow.modifierExtension![0]));
      expect(JSON.stringify(wire)).toContain(JSON.stringify(currentMarker));
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
    const oldOnly = toDosageDetails([persist(formerWriterRow)]);
    expect(getCourseCycleCount(oldOnly)).toBe(3);
    expect(oldOnly.step![0].count).toBeUndefined();
    const currentOnly = toDosageDetails([current]);
    expect(currentOnly.step![0].count).toBe(3);
    expect(getCourseCycleCount(currentOnly)).toBeUndefined();
  });

  it.each(["unchanged", "dose", "replacement"] as const)("applies the outer text decision to a mixed historical %s row", edit => {
    const historical: FhirDosage = { id: "historical", sequence: 1, text: "Take 1 tablet daily",
      _text: { id: "historical-text", extension: [
        { url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
          { url: "lang", valueCode: "th" }, { url: "content", valueString: "รับประทานครั้งละ 1 เม็ด" }
        ] }, { url: "urn:clinic:text-note", valueString: "retain-text-note" }
      ] },
      doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: daily }, modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [{ url: "step", extension: [{
          url: "component", extension: [
            { url: "id", valueString: "historical" }, { url: "text", valueString: "Take 1 tablet daily" },
            { url: "site", valueCodeableReference: { reference: { reference: "BodyStructure/independent-site" } } },
            { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(1) }] },
            { url: "timing", valueTiming: { repeat: daily } },
          ],
        }] }] }],
      }] };
    const compact = toFhirR5Dosages({ step: [{ id: "compact-stage", component: [{ id: "compact",
      text: "Take 3 tablets daily", doseAndRate: [{ doseQuantity: q(3) }], timing: { repeat: daily },
    }] }] })[0];
    let rows = persist(withDosageEditProvenance([compact, historical], "Take 3 tablets and take 1 tablet daily"));
    if (edit !== "unchanged") rows[1].doseAndRate![0].doseQuantity!.value = 2;
    const replacementPrimitive = persist(historical._text!);
    replacementPrimitive.extension![0].extension![1].valueString = "รับประทานครั้งละ 2 เม็ดตามแผนที่ปรับปรุง";
    if (edit === "replacement") {
      rows[1].text = "Take 2 tablets per the updated plan";
      // This fresh replacement supplies its own current translation. The
      // text fingerprint alone cannot prove a companion was inherited.
      rows[1]._text = replacementPrimitive;
    }
    const expectedText = edit === "unchanged" ? "Take 1 tablet daily"
      : edit === "replacement" ? "Take 2 tablets per the updated plan" : undefined;
    for (let save = 0; save < 3; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      const member = wire.step![0].component.find(item => item.id === "historical")!;
      expect(member.text).toBe(expectedText);
      expect(member._text).toEqual(edit === "unchanged" ? historical._text
        : edit === "replacement" ? replacementPrimitive : {
          id: "historical-text", extension: [{ url: "urn:clinic:text-note", valueString: "retain-text-note" }]
        });
      if (edit === "dose") {
        const retained: Array<Partial<FhirR6Dosage>> = [];
        for (const source of wire.extension ?? []) {
          if (source.url !== DOSAGE_RECONCILIATION_SOURCE_URL) continue;
          for (const marker of source.extension ?? []) {
            if (marker.url !== DOSAGE_DETAILS_R5_URL) continue;
            const component = decodeR5RetainedFields(marker).component;
            if (component) retained.push(component);
          }
        }
        expect(retained).toContainEqual({ text: "Take 1 tablet daily", _text: historical._text });
      }
      expect(member.doseAndRate).toEqual([{ doseQuantity: q(edit === "unchanged" ? 1 : 2) }]);
      expect(member.site?.reference).toEqual({ reference: "BodyStructure/independent-site" });
      expect(JSON.stringify(wire)).toContain("Take 1 tablet daily");
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  const spatialUrl = "urn:ezmedicationinput:body-site-spatial-relation";
  const ear = { text: "ear", coding: [{ system: "http://snomed.info/sct", code: "117590005", display: "Ear-related structure" }] };
  it.each(["en", "th"] as const)("retains a fresh coherent above-ear site through R5/R6 %s previews", locale => {
    const source: FhirDosage = { text: "Apply 1 g above the ear daily, max 2 g per day",
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }], timing: { repeat: daily },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "g" }, denominator: { value: 1, unit: "d" } }],
      site: { ...persist(ear), extension: [{ url: spatialUrl, id: "spatial-marker", extension: [
        { url: "relationText", valueString: "above", id: "relation-text" },
        { url: "target", valueCodeableConcept: persist(ear) },
      ] }] },
    };
    const before = persist(source), native = importCanonicalCourse(source);
    const r6 = toDosageDetails([source]), returned = toFhirR5Dosages(r6)[0];
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const options = { locale, realizationMode };
      for (const value of [source, native, r6, returned]) {
        const text = formatSig(value, "long", options);
        expect(text).toContain(locale === "en" ? "above the ear" : "เหนือหู");
        expect(text).not.toContain(locale === "en" ? "below" : "ใต้หู");
        expect(text).toContain("1 g");
        expect(text).toContain(locale === "en" ? "8:00 am" : "08:00");
        expect(text).toContain("max per period: 2 g / 1 d");
        expect(text).toContain(source.text!);
      }
    }
    expect(source).toEqual(before);
    expect(r6.step![0].component[0].site?.concept).toEqual(source.site);
    expect(returned.site).toEqual(source.site);
    expect(returned.timing).toEqual(source.timing);
    expect(returned.doseAndRate).toEqual(source.doseAndRate);
    expect(returned.text).toBe(source.text);
  });

  it("keeps a complete authored spatial site label", () => {
    const parsed = parseSig("Apply 1 g below the ear daily, max 2 g per day");
    const before = persist(parsed.fhir);
    expect(formatSig(parsed.fhirNext, "long", { locale: "en", realizationMode: "normalized" })).toContain("below the ear");
    expect(formatSig(parsed.fhirNext, "long", { locale: "th", realizationMode: "normalized" })).toContain("ใต้หู");
    expect(parsed.fhir).toEqual(before);
  });

  it.each([false, true])("retains an annotated zero-minimum marker as active or retired source (edited=%s)", edited => {
    const marker = { url: TIMING_FREQUENCY_MIN_EXTENSION_URL, id: "authored-minimum",
      valueInteger: 0, _valueInteger: { id: "minimum-value" } };
    const note: FhirExtension = { url: "urn:test:frequency-note", valueString: "keep" };
    let wire: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: {
      frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day, extension: [persist(marker), note],
      ...(edited ? { frequency: 2 } : {}),
    } } }] }] };
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), rows = persist(toFhirR5Dosages(wire));
      expect(wire).toEqual(before);
      wire = toDosageDetails(rows);
      const repeat = wire.step![0].component[0].timing!.repeat!;
      expect(repeat.frequency).toBe(edited ? 2 : undefined);
      expect(repeat.frequencyMax).toBe(2);
      expect(repeat.extension?.filter(item => item.url === TIMING_FREQUENCY_MIN_EXTENSION_URL) ?? [])
        .toEqual(edited ? [] : [marker]);
      expect(repeat.extension).toContainEqual(note);
      expect(JSON.stringify(wire)).toContain(JSON.stringify(marker));
      expect(JSON.stringify(rows)).toContain(JSON.stringify(marker));
    }
  });

  it.each(["unchanged", "id", "duration"] as const)("keeps draft pause ownership across a completion %s edit", edit => {
    let wire = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, boundsDuration: { value: 7, unit: "d" } } } }] },
      { id: "pause", end: boundary(14), component: [] },
      { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily } }] },
    ] });
    const duration = wire.step![0].component[0].timing!.repeat!.boundsDuration!;
    if (edit === "id") duration.id = "authored-duration";
    if (edit === "duration") duration.value = 10;
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(edit === "duration"
        ? ["induction", "resume"] : ["induction", "pause", "resume"]);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].timing!.repeat!.boundsDuration)
        .toEqual({ value: edit === "duration" ? 10 : 7, unit: "d", ...(edit === "id" ? { id: "authored-duration" } : {}) });
    }
  });
});


describe("round46 public display and pause ownership", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] };
  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  const member = (id: string, value: number, repeat: NonNullable<FhirR6Timing["repeat"]> = daily): FhirR6Dosage => ({
    id, doseAndRate: [{ doseQuantity: q(value) }], timing: { repeat: persist(repeat) },
  });



  it.each(["unchanged", "last-start", "first-duration", "middle-duration"] as const)("retains independently owned pauses after a %s edit", edit => {
    const note = { url: "urn:test:pause-note", id: "authored-pause-note", valueString: "second planned pause" };
    let wire = r6Save({ step: [
      { id: "induction", component: [member("initial", 1, { ...daily, boundsDuration: { value: 7, unit: "d" } })] },
      { id: "pause-a", end: boundary(14), component: [] },
      { id: "resume-a", component: [member("middle", 2, { ...daily, boundsDuration: { value: 7, unit: "d" } })] },
      { id: "pause-b", end: boundary(28), extension: [note], component: [] },
      { id: "resume-b", component: [member("last", 3)] },
    ] });
    if (edit === "last-start") wire.step!.find(step => step.id === "resume-b")!.start = boundary(30);
    if (edit === "first-duration") wire.step![0].component[0].timing!.repeat!.boundsDuration!.value = 10;
    if (edit === "middle-duration") wire.step![1].component[0].timing!.repeat!.boundsDuration!.value = 8;
    const expectedIds = edit === "last-start" || edit === "middle-duration" ? ["induction", "pause-a", "resume-a", "resume-b"]
      : edit === "first-duration" ? ["induction", "resume-a", "pause-b", "resume-b"]
      : ["induction", "pause-a", "resume-a", "pause-b", "resume-b"];
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(expectedIds);
      expect(importCanonicalCourse(wire).stages.map(step => step.provenance?.id)).toEqual(expectedIds);
      expect(view.course.step?.find(step => step.id === "resume-a")?.start)
        .toEqual(edit === "first-duration" ? boundary(14) : undefined);
      expect(view.course.step?.find(step => step.id === "resume-b")?.start)
        .toEqual(edit === "last-start" ? boundary(30) : edit === "middle-duration" ? boundary(28) : undefined);
      if (edit === "middle-duration")
        expect(wire.step![1].component[0].timing!.repeat!.boundsDuration!.value).toBe(8);
      expect(wire.step!.map(step => step.component[0].doseAndRate![0].doseQuantity!.value)).toEqual([1, 2, 3]);
      expect(JSON.stringify(wire)).toContain("second planned pause");
      expect(JSON.stringify(wire)).toContain("authored-pause-note");
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
    }
  });

  it.each(["unchanged", "id", "end", "_start", "_end"] as const)("keeps a fixed-period pause across a Period %s edit", edit => {
    const period = { start: "2026-11-21", end: "2026-11-27" };
    let wire = persist(r6Save({ step: [
      { id: "induction", component: [member("initial", 1, { ...daily, boundsPeriod: period })] },
      { id: "pause", end: boundary(14), component: [] },
      { id: "resume", component: [member("later", 2)] },
    ] }));
    const current = wire.step![0].component[0].timing!.repeat!.boundsPeriod!;
    if (edit === "id") current.id = "authored-period";
    if (edit === "end") current.end = "2026-11-30";
    if (edit === "_start" || edit === "_end") current[edit] = { id: "date-annotation",
      extension: [{ url: "urn:clinic:date-note", valueString: "retain-date-note" }] };
    const expectedPeriod = persist(current);
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(edit === "end"
        ? ["induction", "resume"] : ["induction", "pause", "resume"]);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      expect(wire.step![0].component[0].timing!.repeat!.boundsPeriod).toEqual(expectedPeriod);
    }
  });

  it.each(["unchanged", "version", "dose"] as const)("preserves historical instruction agreement after a %s edit", edit => {
    const text = "Take 1 tablet orally daily per the agreed plan.";
    const route = { id: "authored-route", coding: [{ system: "http://snomed.info/sct", code: "26643006",
      display: "Oral route", id: "route-coding", _code: { id: "route-code" },
      extension: [{ url: "urn:test:route-note", valueString: "keep route annotation" }],
    }] };
    const timing = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };
    const row: FhirDosage = { id: "historical", sequence: 1, text: "Take 1 tablet orally daily.", route: persist(route),
      doseAndRate: [{ doseQuantity: q(1) }], timing, modifierExtension: [{
        url: DOSAGE_DETAILS_R5_URL, extension: [{ url: "dosageDetails", extension: [
          { url: "renderedInstruction", valueString: text }, { url: "step", extension: [{ url: "component", extension: [
            { url: "id", valueString: "historical" }, { url: "text", valueString: "Take 1 tablet orally daily." },
            { url: "route", valueCodeableConcept: persist(route) },
            { url: "doseAndRate", extension: [{ url: "doseQuantity", valueQuantity: q(1) }] },
            { url: "timing", valueTiming: timing },
          ] }] },
        ] }],
      }] };
    if (edit !== "unchanged") row.route!.coding![0].version = "2026-11";
    if (edit === "dose") row.doseAndRate![0].doseQuantity!.value = 2;
    const expectedRoute = persist(row.route);
    let rows = persist([row]);
    for (let save = 0; save < 3; save++) {
      const before = persist(rows), wire = toDosageDetails(rows);
      expect(wire.renderedInstruction).toBe(edit === "dose" ? undefined : text);
      expect(wire.step![0].component[0].route).toEqual(expectedRoute);
      expect(wire.step![0].component[0].doseAndRate).toEqual([{ doseQuantity: q(edit === "dose" ? 2 : 1) }]);
      expect(JSON.stringify(wire)).toContain(text);
      expect(rows).toEqual(before);
      rows = persist(toFhirR5Dosages(wire));
    }
  });

  it.each([undefined, 3])("retains an authored spatial application count (%s)", count => {
    const ear = { text: "ear", coding: [{ system: "http://snomed.info/sct", code: "117590005", display: "Ear-related structure" }] };
    const countMarker = { url: "urn:ezmedicationinput:body-site-administration-target-count", id: "authored-count",
      valueInteger: count, _valueInteger: { id: "count-value" } };
    const source: FhirDosage = { method: { text: "Apply" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      timing: { repeat: daily }, site: { ...persist(ear), extension: [{
        url: "urn:ezmedicationinput:body-site-spatial-relation", extension: [
          { url: "relationText", valueString: "below" }, { url: "target", valueCodeableConcept: persist(ear) },
        ],
      }, ...(count === undefined ? [] : [countMarker])] },
    };
    const before = persist(source), wire = toDosageDetails([source]), rows = persist(toFhirR5Dosages(wire));
    for (const input of [source, wire, rows]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain(count === undefined ? "below the ear." : "below the ear (across 3 sites).");
      expect(text.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*g\b/g)).toEqual(["1 g"]);
      if (count === undefined) expect(text).not.toContain("across");
    }
    expect(wire.step![0].component[0].site?.concept).toEqual(source.site);
    expect(rows[0].site).toEqual(source.site);
    if (count !== undefined) {
      rows[0].site!.extension!.find(item => item.url === countMarker.url)!.valueInteger = 4;
      const edited = toDosageDetails(rows), saved = persist(toFhirR5Dosages(edited));
      expect(edited.step![0].component[0].site?.concept?.extension)
        .toContainEqual({ ...countMarker, valueInteger: 4 });
      expect(saved[0].site?.extension).toContainEqual({ ...countMarker, valueInteger: 4 });
      expect(formatSig(edited, "long", { locale: "en" })).toContain("below the ear (across 4 sites).");
    }
    expect(source).toEqual(before);
  });
});


describe("round46 standalone administration source ownership", () => {
  const parseOptions = { assumeSingleDiscreteDose: true, context: { dosageForm: "tablet" } };
  const display = { locale: "en", realizationMode: "roundtrip" as const };

  it.each([
    "Swallow whole daily", "Swallow whole twice daily", "Swallow whole every morning",
    "Swallow whole daily at 08:00", "Swallow whole before breakfast daily",
    "Swallow whole daily, do not chew", "Swallow 2 tablets whole daily",
  ])("retains the complete owned source without duplicated timing: %s", source => {
    const parsed = parseSig(source, parseOptions), course = parsed.meta.canonical.course!;
    const member = course.stages[0].administrations[0], before = persist(course);
    expect(member.amounts?.[0].quantity).toMatchObject({ value: source.includes("2 tablets") ? 2 : 1, unit: "tab" });
    expect(formatCanonicalAdministration(member, "long", display)).toBe(source);
    expect(formatCanonicalCourse(course, "long", display)).toBe(source);
    expect(persist(course)).toEqual(before);
  });

  it.each(["Swallow whole", "Swallow 1 tablet whole"])("keeps a staged %s source separate from the numeric successor", first => {
    const source = first + " daily for 7 days then take 2 tablets twice daily";
    const parsed = parseSig(source, parseOptions), course = parsed.meta.canonical.course!;
    expect(course.stages).toHaveLength(2);
    const firstText = formatCanonicalAdministration(course.stages[0].administrations[0], "long", display);
    const secondText = formatCanonicalAdministration(course.stages[1].administrations[0], "long", display);
    expect(firstText).toBe(first + " daily for 7 days");
    expect(firstText).not.toContain("2 tablets");
    expect(secondText).toBe("Take 2 tablets orally twice daily.");
    expect(secondText).not.toContain("7 days");
    expect(formatCanonicalCourse(course, "long", display)).toBe(source);
  });

  it("keeps each parallel administration's amount and event separate", () => {
    const source = "Swallow 1 tablet whole in the morning and 2 tablets whole in the evening";
    const course = parseSig(source, parseOptions).meta.canonical.course!;
    expect(course.stages[0].administrations).toHaveLength(2);
    const texts = course.stages[0].administrations.map(member => formatCanonicalAdministration(member, "long", display));
    expect(texts[0]).toBe("Swallow 1 tablet whole in the morning");
    expect(texts[1]).toContain("2 tablets");
    expect(texts[1]).toContain("in the evening");
    expect(texts[0]).not.toContain("evening");
    expect(texts[1]).not.toContain("morning");
    expect(formatCanonicalCourse(course, "long", display)).toBe(source);
  });

  it("keeps a current external numeric edit ahead of inferred-dose source", () => {
    const parsed = parseSig("Swallow whole daily", parseOptions);
    const wire = persist(parsed.fhirNext);
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    const before = persist(wire), saved = persist(toFhirR5Dosages(wire));
    for (const input of [wire, saved]) {
      const member = importCanonicalCourse(input).stages[0].administrations[0];
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 3, unit: "tab" });
      expect(formatCanonicalAdministration(member, "long", display))
        .toBe("Swallow 3 tablets whole orally once daily.");
    }
    expect(wire).toEqual(before);
  });
});


describe("round47 public retained-field preservation", () => {
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const reference = { id: "reference-annotation", reference: "BodyStructure/lesion-1",
    _reference: { id: "reference-value" } };
  // Frozen strict R5 output from pinned master 7d62823, not regenerated by the current writer.
  const legacySiteRows: FhirDosage[] = [{"timing": {"repeat": {"frequency": 1, "period": 1, "periodUnit": FhirPeriodUnit.Day}}, "sequence": 1, "site": {"text": "left lesion"}, "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab"}}], "modifierExtension": [{"url": "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details", "extension": [{"url": "rowIndex", "valueInteger": 0}, {"url": "sequence", "valueInteger": 1}, {"url": "stepCount", "valueInteger": 1}, {"url": "component", "extension": [{"url": "site", "valueCodeableReference": {"reference": {"id": "reference-annotation", "reference": "BodyStructure/lesion-1", "_reference": {"id": "reference-value"}}}}]}, {"url": "baseline", "extension": [{"url": "site", "valueString": "113848ffcc118b85"}]}]}]}];

  it.each(["legacy", "current"] as const)("retains the unchanged %s site reference and respects explicit edits", producer => {
    for (const edit of ["unchanged", "concept", "clear"] as const) {
      const rows: EzDosage[] = producer === "legacy" ? persist(legacySiteRows) : persist(toFhirR5Dosages(course({
        timing: { repeat: daily }, site: { concept: { text: "left lesion" }, reference: persist(reference) },
      })));
      if (edit === "concept") rows[0].site = { text: "right lesion" };
      if (edit === "clear") rows[0].siteReference = undefined;
      const before = persist(rows), hadReferenceField = Object.prototype.hasOwnProperty.call(rows[0], "siteReference");
      let wire = toDosageDetails(rows);
      expect(rows).toEqual(before);
      expect(Object.prototype.hasOwnProperty.call(rows[0], "siteReference")).toBe(hadReferenceField);
      for (let save = 0; save < 3; save++) {
        const site = wire.step![0].component[0].site!;
        expect(site.concept).toEqual({ text: edit === "concept" ? "right lesion" : "left lesion" });
        expect(site.reference).toEqual(edit === "unchanged" ? reference : undefined);
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    }
  });

  it.each(["unchanged", "identified-rate", "anonymous-rate"] as const)(
    "keeps residual expression ownership after an %s edit", edit => {
      const first = expression("planA"), second = expression("planB");
      const rows = persist(toFhirR5Dosages(course({ timing: { repeat: daily }, doseAndRate: [
        { doseExpression: first, rateQuantity: { value: 5, unit: "mL/h" } },
        { doseExpression: second, rateQuantity: { value: 5, unit: "mL/h" } },
        { id: "identified-rate", rateQuantity: { value: 10, unit: "mL/h" } },
      ] })));
      if (edit === "identified-rate") rows[0].doseAndRate![2].rateQuantity!.value = 12;
      if (edit === "anonymous-rate") rows[0].doseAndRate![0].rateQuantity!.value = 6;
      const before = persist(rows);
      let wire = toDosageDetails(rows);
      expect(rows).toEqual(before);
      for (let save = 0; save < 3; save++) {
        const amounts = wire.step![0].component[0].doseAndRate!;
        expect(amounts.map(value => value.doseExpression)).toEqual(
          edit === "anonymous-rate" ? [undefined, undefined, undefined] : [first, second, undefined]);
        expect(amounts.map(value => value.rateQuantity)).toEqual([
          { value: edit === "anonymous-rate" ? 6 : 5, unit: "mL/h" },
          { value: 5, unit: "mL/h" },
          { value: edit === "identified-rate" ? 12 : 10, unit: "mL/h" },
        ]);
        expect(amounts[2].id).toBe("identified-rate");
        if (edit === "anonymous-rate") {
          expect(JSON.stringify(wire)).toContain(JSON.stringify(first));
          expect(JSON.stringify(wire)).toContain(JSON.stringify(second));
        }
        wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      }
    });

  const retiredTextMarker: FhirExtension = {"url": "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", "extension": [{"url": "instruction", "valueString": "Take one tablet daily"}, {"url": "sourceAgreement", "valueBoolean": false}, {"url": "textFingerprint", "valueString": "ff7c0b4d5e542e16"}, {"url": "row", "extension": [{"url": "projectionFingerprint", "valueString": "dfcac6a1c81a3c36"}, {"url": "textFingerprint", "valueString": "ff7c0b4d5e542e16"}, {"url": "sourceAgreement", "valueBoolean": false}]}]};
  it.each(["clean", "id", "child"] as const)("retires a %s component text marker without losing annotations", annotation => {
    const marker = persist(retiredTextMarker);
    if (annotation === "id") marker.id = "authored-marker";
    if (annotation === "child") marker.extension!.push({
      url: "urn:clinic:marker-note", valueString: "retain authored annotation",
    });
    let wire = course({ doseAndRate: [{ doseQuantity: q(2) }], timing: { repeat: daily }, extension: [marker] });
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), rows = persist(toFhirR5Dosages(wire));
      expect(wire).toEqual(before);
      const activeMarkers = rows[0].extension?.filter(item => item.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL) ?? [];
      expect(activeMarkers).not.toContainEqual(marker);
      if (annotation === "clean") expect(JSON.stringify(rows)).not.toContain(JSON.stringify(marker));
      else expect(rows[0].extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)
        .some(item => item.extension?.some(source => JSON.stringify(source) === JSON.stringify(marker)))).toBe(true);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(rows, "long", { locale: "en", realizationMode });
        expect(text).toMatch(/\b2 tablets?\b/u);
        expect(text).not.toContain("Take one tablet daily");
      }
      wire = toDosageDetails(rows);
    }
  });

  const boundary = (value: number) => ({ contextCode: { coding: [{
    system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start",
  }] }, offsetDuration: { value, unit: "d" } });
  it.each(["unchanged", "annotation", "count"] as const)("keeps pause ownership for a timing-count %s edit", edit => {
    let wire = r6Save({ step: [
      { id: "induction", component: [{ id: "initial", doseAndRate: [{ doseQuantity: q(1) }],
        timing: { repeat: { ...daily, count: 7 } } }] },
      { id: "pause", end: boundary(14), component: [] },
      { id: "resume", component: [{ id: "later", doseAndRate: [{ doseQuantity: q(2) }],
        timing: { repeat: daily } }] },
    ] });
    const repeat = wire.step![0].component[0].timing!.repeat! as NonNullable<FhirR6Timing["repeat"]> & { _count?: FhirElement };
    if (edit === "annotation") repeat._count = { id: "induction-count" };
    if (edit === "count") repeat.count = 10;
    for (let save = 0; save < 3; save++) {
      const before = persist(wire), view = fromDosageDetails(wire);
      expect(view.course.step?.map(step => step.id)).toEqual(
        edit === "count" ? ["induction", "resume"] : ["induction", "pause", "resume"]);
      expect(wire).toEqual(before);
      wire = toDosageDetails(persist(toFhirR5Dosages(wire)));
      const current = wire.step![0].component[0].timing!.repeat! as NonNullable<FhirR6Timing["repeat"]> & { _count?: FhirElement };
      expect(current.count).toBe(edit === "count" ? 10 : 7);
      expect(current._count).toEqual(edit === "annotation" ? { id: "induction-count" } : undefined);
    }
  });

  it.each([
    { producer: "proposal", directDose: true },
    { producer: "proposal", directDose: false },
    { producer: "lexical", directDose: true },
    { producer: "legacy-profile", directDose: undefined },
  ] as const)("preserves configured graph locale fields for $producer / $directDose", ({ producer, directDose }) => {
    const source = producer === "lexical" ? "Agitate bottle for 10 seconds" : "Agitate bottle ten seconds";
    const profile = {
      fallbackObject: "the preparation", implicitMedicationObject: false, directSiteObject: false,
      suppressActivityConcepts: ["sleep"], suppressSiteConcepts: ["skin"],
      ...(directDose !== undefined ? { directDose, routePhrases: { PO: "by the configured oral route" },
        administrationDurationPrefix: "during" } : {}),
    };
    const options: ParseOptions = {
      unitMap: { s: "s" },
      instructionActionMap: {
        "clinic-agitation": { ...getMedicationInstructionAction("shake")!, code: "clinic-agitation",
          display: "Agitate", aliases: producer === "lexical" ? ["agitate"] : [],
          realizerConfig: { locales: { en: profile } } },
      },
      instructionSemanticResolvers: producer === "lexical" ? undefined : request => request.sourceText === source
        ? { actions: [{ action: "clinic-agitation", range: { start: 0, end: source.length }, args: [
          { role: AdviceArgumentRole.Container, range: { start: 8, end: 14 }, concept: "bottle" },
          { role: AdviceArgumentRole.Duration, range: { start: 15, end: 26 }, quantity: { value: 10, unit: "s" } },
        ] }] } : undefined,
    };
    const parsed = parseSig(source, options), graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const before = persist(graph);
    expect(persist(graph.actions[0].predicate.realizerConfig!.locales!.en)).toEqual(profile);
    const marker = buildInstructionGraphExtension(graph)!;
    expect(persist(parseInstructionGraphExtension([persist(marker)])!.actions[0].predicate.realizerConfig!.locales!.en))
      .toEqual(profile);
    expect(graph).toEqual(before);
    let wire = toDosageDetails(parsed.fhir);
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      const restored = parseInstructionGraphExtension(rows[0].extension)!;
      expect(persist(restored.actions[0].predicate.realizerConfig!.locales!.en)).toEqual(profile);
      wire = toDosageDetails(rows);
    }
  });

  const known = { id: "known-endpoint", value: 7, unit: "days", system: "http://unitsofmeasure.org",
    code: "d", _value: { id: "authored-seven" } };
  const local = { id: "foreign-endpoint", value: 2, unit: "half-hour-block",
    system: "https://pharmacy.example/units", code: "block", _unit: { id: "authored-unit" },
    extension: [{ url: "urn:clinic:endpoint-note", valueString: "retain" }] };
  it.each([
    { name: "local scalar", bound: { boundsDuration: { ...known, system: "https://pharmacy.example/units" } } },
    { name: "known scalar", bound: { boundsDuration: known } },
    { name: "local upper endpoint", bound: { boundsRange: { id: "course-range", low: known, high: local } } },
    { name: "local lower endpoint", bound: { boundsRange: { id: "course-range", low: local, high: known } } },
  ])("preserves $name through public interchange without endpoint unit borrowing", ({ bound }) => {
    const range = bound.boundsRange;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: q(1) }], timing: { repeat: { ...daily,
      ...(range ? { boundsRange: { id: range.id, low: range.low } } : persist(bound)),
    } }, ...(range ? { modifierExtension: [{ url: ANCHORED_COURSE_DURATION_EXTENSION_URL, extension: [
      { url: "low", valueQuantity: range.low }, { url: "high", valueQuantity: range.high },
      retainField("rangeMetadata", { id: range.id }),
    ] }] } : {}) };
    const before = persist(row);
    const expectBound = (rows: readonly FhirDosage[]) => {
      expect(rows[0].timing!.repeat!.boundsDuration).toEqual(bound.boundsDuration);
      if (range) {
        expectActiveMixedDuration(rows[0], range);
        expect(importCanonicalCourse(rows).stages[0].administrations[0].schedule?.recurrence?.courseLengthRange).toEqual(range);
      } else expect(rows[0].timing!.repeat!.boundsRange).toBeUndefined();
    };
    expectBound(toFhirR5Dosages([row]));
    let wire = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      const rows = persist(toFhirR5Dosages(wire));
      expectBound(rows);
      wire = toDosageDetails(rows);
    }
    expect(row).toEqual(before);
  });
});
}


describe("whole-clause polarity during instruction fragment recovery", () => {
  const administration = "Take 1 tablet orally once daily. ";
  const thaiAdministration = "รับประทานครั้งละ 1 เม็ด วันละครั้ง. ";
  it.each([
    { source: "Take 1 tablet daily, do not crush or chew.", verbs: ["crush", "chew"], negative: true,
      en: administration + "Do not crush. Do not chew.", th: thaiAdministration + "ห้ามบด. ห้ามเคี้ยว." },
    { source: "Take 1 tablet daily, do not chew or crush.", verbs: ["chew", "crush"], negative: true,
      en: administration + "Do not chew. Do not crush.", th: thaiAdministration + "ห้ามเคี้ยว. ห้ามบด." },
    { source: "Take 1 tablet daily. Do not crush or chew.", verbs: ["crush", "chew"], negative: true,
      en: administration + "Do not crush. Do not chew.", th: thaiAdministration + "ห้ามบด. ห้ามเคี้ยว." },
    { source: "Take 1 tablet daily; do not crush or chew.", verbs: ["crush", "chew"], negative: true,
      en: administration + "Do not crush. Do not chew.", th: thaiAdministration + "ห้ามบด. ห้ามเคี้ยว." },
    { source: "Take 1 tablet daily, do not crush.", verbs: ["crush"], negative: true,
      en: administration + "Do not crush.", th: thaiAdministration + "ห้ามบด." },
    { source: "Crush the tablet.", verbs: ["crush"], negative: false, en: "Crush tablet.", th: "บดยาเม็ด." },
  ])("retains selected scope and emits each action once: $source", ({ source, verbs, negative, en, th }) => {
    const parsed = parsePublicSig(source), parsedBefore = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const actions: AdviceFrame[] = [];
      for (const stage of importCanonicalCourse(input).stages) {
        for (const member of stage.administrations) {
          actions.push(...(member.syntax?.instructionGraph?.actions ?? []));
        }
      }
      for (const verb of verbs) {
        const selected = actions.filter(action => action.predicate.lemma === verb);
        expect(selected).toHaveLength(1);
        expect(selected[0].polarity ?? AdvicePolarity.Affirm)
          .toBe(negative ? AdvicePolarity.Negate : AdvicePolarity.Affirm);
      }
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(en);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(th);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(parsed)).toBe(parsedBefore);
  });
});


describe("whole-swallow coding retains its declared clinical facts", () => {
  it.each([
    { source: "Swallow whole daily, do not chew", crush: false },
    { source: "Swallow 1 tablet whole daily. Do not chew", crush: false },
    { source: "Swallow 1 tablet whole daily. Do not crush. Do not chew", crush: true },
  ])("does not add a crushing prohibition from the whole-swallow code: $source", ({ source, crush }) => {
    const parsed = parsePublicSig(source), before = JSON.stringify(parsed);
    for (const output of [parsed.fhir[0], parsed.fhirNext.step![0].component[0]]) {
      const coded = output.additionalInstruction?.find(row => row.coding?.some(coding => coding.code === "418693002"));
      expect(coded?.text).toBe("Swallow whole; do not chew");
      expect(JSON.stringify(coded)).not.toMatch(/crush|บด/iu);
      const independent: AdviceFrame[] = [];
      for (const row of output.additionalInstruction ?? []) {
        for (const frame of parseInstructionGraphExtension(row.extension)?.actions ?? []) {
          if (frame.predicate.lemma === "crush") independent.push(frame);
        }
      }
      expect(independent).toHaveLength(crush ? 1 : 0);
      if (crush) expect(independent![0].polarity).toBe(AdvicePolarity.Negate);
    }
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.toLowerCase().split(locale === "en" ? "crush" : "บด")).toHaveLength(crush ? 2 : 1);
      }
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });

  for (const form of ["r5", "r6"] as const) {
    it.each([false, true])(`preserves supplied ${form} whole-swallow advice without inventing crush (authored text %s)`, withText => {
      const advice = { id: "whole-swallow", ...(withText ? { text: "Swallow whole, do not chew" } : {}),
        coding: [{ system: "http://snomed.info/sct", code: "418693002" }],
        extension: [{ url: "urn:clinic:advice-note", valueString: "retain this note" }] };
      const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }, additionalInstruction: [advice] };
      const input = form === "r5" ? [row] : { step: [{ component: [row] }] };
      const before = JSON.stringify(input);
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("Swallow whole");
      expect(english.toLowerCase()).toContain("do not chew");
      expect(english.toLowerCase()).not.toContain("crush");
      expect(thai).toContain("กลืนทั้งเม็ด");
      expect(thai).toContain("ห้ามเคี้ยว");
      expect(thai).not.toContain("บด");
      const projected = projectCanonicalCourse(importCanonicalCourse(input));
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toEqual([advice]);
        expect(output.doseAndRate).toEqual(row.doseAndRate);
        expect(output.timing?.repeat).toEqual(row.timing.repeat);
      }
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});


describe("alcohol advice action and polarity in current projections", () => {
  it.each([
    { source: "Avoid alcohol", avoidance: true },
    { source: "No alcohol", avoidance: true },
    { source: "Do not drink alcohol", avoidance: true },
    { source: "Do not take with alcohol", avoidance: true },
    { source: "Drink alcohol", avoidance: false },
    { source: "Take with alcohol", avoidance: false }
  ])("preserves authored alcohol polarity in standard rows and previews: $source", ({ source, avoidance }) => {
    const parsed = parsePublicSig(source), parsedBefore = JSON.stringify(parsed);
    const r6Rows: FhirR6Dosage[] = [];
    for (const step of parsed.fhirNext.step!) r6Rows.push(...step.component);
    const outputs = [parsed.fhir, r6Rows];
    for (const rows of outputs) {
      const advice: Array<NonNullable<FhirDosage["additionalInstruction"]>[number] |
        NonNullable<FhirR6Dosage["additionalInstruction"]>[number]> = [];
      for (const row of rows) advice.push(...(row.additionalInstruction ?? []));
      const selected = advice.filter(row => row.coding?.some(coding => coding.code === "419822006"));
      expect(selected).toHaveLength(avoidance ? 1 : 0);
      if (avoidance) expect(selected[0].text).toBe("Avoid alcoholic drinks");
      expect(advice.some(row => row.coding?.some(coding => coding.code === "418914006"))).toBe(false);
    }
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.toLowerCase()).toContain("alcohol");
      expect(th).toContain("แอลกอฮอล์");
      if (avoidance) {
        expect(en).toMatch(/avoid alcohol|do not drink alcohol/iu);
        expect(th).toMatch(/งด|หลีกเลี่ยง|ห้าม/u);
      } else {
        expect(en).not.toMatch(/avoid alcohol|do not drink alcohol/iu);
        expect(th).not.toMatch(/งด|หลีกเลี่ยง|ห้าม/u);
      }
      if (source === "Drink alcohol") {
        expect(en).toBe("Drink alcohol.");
        expect(th).toBe("ดื่มแอลกอฮอล์.");
      } else if (source === "Take with alcohol") {
        expect(en).toMatch(/(?:^|[.;]\s+)Take with alcohol\.(?:$|\s)/u);
        expect(en).not.toMatch(/do not take with alcohol/iu);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(parsed)).toBe(parsedBefore);
  });

  it.each(["take with alcohol", "mix with alcohol"])("does not invent avoidance beside the drowsiness warning: %s", ending => {
    const source = `May cause drowsiness; do not drive if affected; ${ending}`;
    const parsed = parsePublicSig(source), parsedBefore = JSON.stringify(parsed);
    const r6Rows: FhirR6Dosage[] = [];
    for (const step of parsed.fhirNext.step!) r6Rows.push(...step.component);
    for (const rows of [parsed.fhir, r6Rows]) {
      const codes: Array<string | undefined> = [];
      for (const row of rows) {
        for (const advice of row.additionalInstruction ?? []) {
          for (const coding of advice.coding ?? []) codes.push(coding.code);
        }
      }
      expect(codes).not.toContain("418914006");
      expect(codes).not.toContain("419822006");
    }
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.toLowerCase()).toContain("drowsiness");
      expect(en.toLowerCase()).toContain(ending);
      expect(en).not.toMatch(/avoid alcohol/iu);
      expect(th).toContain("ง่วงซึม");
      expect(th).toContain("แอลกอฮอล์");
      expect(th).not.toMatch(/งด|หลีกเลี่ยง/u);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(parsed)).toBe(parsedBefore);
  });
});




describe("fresh structured quantity and annotation ownership", () => {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const daily = { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day };
  const ucum = "http://unitsofmeasure.org";

  it("uses a coded group's established unit to select the tighter compatible maximum", () => {
    const coded = { system: "urn:clinic:dose-unit", code: "tablet" };
    const amounts = [{ ...coded, value: 2, id: "coded-minimum" },
      { ...coded, value: 4, unit: "tablet", id: "unit-owner" },
      { value: 1, unit: "tablet", id: "tightest", _value: { id: "limit-note" } }];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const limits = order.map(index => ({ scope: "administration" as const, valueQuantity: amounts[index] }));
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { ...coded, value: 1 } }],
        timing: { repeat: daily }, safety: { doseLimit: limits },
      }] }] };
      const before = copy(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(amounts[2]);
      expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
      expect(input).toEqual(before);
    }
    expect(convertQuantityValue(2, { ...coded }, { ...coded })).toBe(2);
    expect(convertQuantityValue(2, { ...coded }, { system: coded.system, code: "other" })).toBeNull();
  });

  it("keeps explicit UCUM identities separate from authored shorthand aliases", () => {
    const enzyme = { system: ucum, code: "U", unit: "enzyme unit" };
    const international = { system: ucum, code: "[iU]", unit: "international unit" };
    expect(convertQuantityValue(2, enzyme, international)).toBeNull();
    expect(convertQuantityValue(2, enzyme, { ...enzyme, unit: "U" })).toBe(2);
    expect(convertQuantityValue(2, { unit: "U" }, international)).toBe(2);
    expect(convertQuantityValue(1, { system: ucum, code: "g" }, { system: ucum, code: "mg" })).toBe(1000);
    expect(convertQuantityValue(1, { system: ucum, code: "l" }, { system: ucum, code: "mL" })).toBe(1000);
    expect(convertQuantityValue(1, { system: ucum, code: "ml" }, { system: ucum, code: "mL" })).toBe(1);
    expect(convertQuantityValue(1, { system: ucum, code: "ML" }, { system: ucum, code: "mL" })).toBeNull();
    expect(convertQuantityValue(1, { system: ucum, code: "5.mL" }, { system: ucum, code: "mL" })).toBe(5);
    expect(convertQuantityValue(1, { system: ucum, code: "[tsp_m]" }, { system: ucum, code: "mL" })).toBe(5);
    expect(convertQuantityValue(1, { system: ucum, code: "[tbs_m]" }, { system: ucum, code: "mL" })).toBe(15);
    expect(convertQuantityValue(1, { system: ucum, code: "[tsp_us]", unit: "teaspoon" }, { system: ucum, code: "mL" })).toBeNull();
    const limits = [{ scope: "administration" as const, valueQuantity: { ...enzyme, value: 20 } },
      { scope: "administration" as const, valueQuantity: { ...international, value: 1 } }];
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { ...enzyme, value: 10 } }], safety: { doseLimit: limits },
    }] }] };
    const before = copy(input), rows = toFhirR5Dosages(input);
    expect(rows[0].maxDosePerAdministration).toEqual(limits[0].valueQuantity);
    expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
    expect(input).toEqual(before);
  });

  it.each([
    { code: "ml", value: 100, tighterCode: "L", tighterValue: 0.05 },
    { code: "l", value: 0.1, tighterCode: "mL", tighterValue: 50 },
  ])("compares the UCUM litre symbol $code without folding prefix case", ({ code, value, tighterCode, tighterValue }) => {
    const first = { system: ucum, code, value, id: "larger-volume", _value: { id: "authored-volume" } };
    const tight = { system: ucum, code: tighterCode, value: tighterValue, id: "smaller-volume" };
    for (const quantities of [[first, tight], [tight, first]]) {
      const limits = quantities.map(valueQuantity => ({ scope: "administration" as const, valueQuantity }));
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { system: ucum, code, value: value / 10 } }], safety: { doseLimit: limits },
      }] }] };
      const before = copy(input), rows = toFhirR5Dosages(input);
      expect(rows[0].maxDosePerAdministration).toEqual(tight);
      expect(toDosageDetails(copy(rows)).step![0].component[0].safety!.doseLimit).toEqual(limits);
      expect(input).toEqual(before);
    }
  });

  it.each([undefined, 1])("preserves a two-hour upper administration duration with lower %s", lower => {
    const missing = { id: "lower-duration", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    }] };
    const row: FhirDosage = { text: "Infuse up to two hours", doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }],
      timing: { repeat: { ...daily, ...(lower === undefined ? { _duration: missing } : { duration: lower }),
        durationMax: 2, durationUnit: FhirPeriodUnit.Hour } } };
    const before = copy(row), canonical = canonicalFromFhir(row);
    expect(canonical.schedule?.administrationDuration).toBe(lower);
    expect(canonical.schedule?.administrationDurationMax).toBe(2);
    const written = canonicalToFhir(canonical);
    expect(written.timing!.repeat).toMatchObject({ durationMax: 2, durationUnit: FhirPeriodUnit.Hour });
    expect(written.timing!.repeat!.duration).toBe(lower);
    const wire = toDosageDetails([row]);
    for (const current of [toFhirR5Dosages(wire)[0], wire.step![0].component[0]]) {
      expect(current.timing!.repeat).toMatchObject({ durationMax: 2, durationUnit: FhirPeriodUnit.Hour });
      expect(current.timing!.repeat!.duration).toBe(lower);
      if (lower === undefined) expect(current.timing!.repeat!._duration).toEqual(missing);
    }
    expect(row).toEqual(before);
  });

  it("projects quantities nested in an extension primitive companion", () => {
    const quantity: FhirR6Quantity = { value: 1, unit: "tablet", _unit: { id: "unit-note", extension: [{
      id: "annotation", url: "urn:clinic:annotation", valueString: "Authored label",
      _valueString: { id: "label-note", extension: [{ url: "urn:clinic:estimate",
        valueQuantity: { value: 2, unit: "mg", comparator: "~" } }] },
    }] } };
    const before = copy(quantity), projected = quantityForR5(quantity)!;
    const annotation = projected._unit!.extension![0];
    expect(annotation).toMatchObject({ id: "annotation", url: "urn:clinic:annotation", valueString: "Authored label",
      _valueString: { id: "label-note" } });
    const estimate = annotation._valueString!.extension![0].valueQuantity!;
    expect(estimate.comparator).toBeUndefined();
    expect(getQuantityComparator(estimate)).toBe("~");
    expect(quantityFromR5(copy(projected))).toEqual(quantity);
    expect(quantity).toEqual(before);
  });

  it.each([true, false])("preserves method primitive IDs and boolean annotation %s", reviewed => {
    const annotation = { id: "review-marker", url: "urn:clinic:reviewed", valueBoolean: reviewed };
    const method = { text: "Infuse", _text: { id: "method-note", extension: [annotation] } };
    const row: FhirDosage = { text: "Infuse 100 mL daily", method,
      doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }], timing: { repeat: daily } };
    const before = copy(row), native = fromFhirDosage(row), r6 = toDosageDetails([row]);
    for (const current of [native.fhir, r6.step![0].component[0], toFhirR5Dosages(r6)[0]])
      expect(current.method?._text).toEqual(method._text);
    expect(row).toEqual(before);
  });

  it("accepts and retains current repeat and condition primitive annotations without casts", () => {
    const note = { id: "typed-note", extension: [{ url: "urn:clinic:estimate",
      valueQuantity: { value: 2, unit: "mg", comparator: "~" as const } }] };
    const repeat: NonNullable<FhirR6Timing["repeat"]> = { ...daily, count: 2, countMax: 3,
      _countMax: note, duration: 1, durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
      _durationMax: note, _durationUnit: note, periodMax: 2, _periodMax: note, _periodUnit: note };
    const condition: FhirR6DosageCondition = { code: { text: "if needed" }, text: "If needed",
      _text: { id: "condition-text", extension: [{ url: "urn:clinic:reviewed", valueBoolean: false }] } };
    const input: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat }, condition: [condition],
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }] };
    const before = copy(input), rows = toFhirR5Dosages(input), restored = toDosageDetails(copy(rows));
    const current = restored.step![0].component[0];
    for (const key of ["_countMax", "_durationMax", "_durationUnit", "_periodMax", "_periodUnit"] as const)
      expect(current.timing!.repeat![key]).toEqual(note);
    expect(current.condition![0]._text).toEqual(condition._text);
    expect(input).toEqual(before);
  });

  it("retains relation, repeated Coding, and argument span wrapper annotations by occurrence", () => {
    const relation = { system: "http://snomed.info/sct", code: "421463005", display: "With - dosing instruction fragment" };
    const coding = { system: "urn:clinic:actions", code: "rinse" };
    const argument: FhirExtension = { url: "argument", extension: [
      { url: "role", valueCode: "object" }, { url: "text", valueString: "mouth" },
      { id: "argument-relation", url: "relationCoding", valueCoding: relation },
      { url: "argumentCoding", valueCoding: coding }, { id: "second-argument-code", url: "argumentCoding", valueCoding: coding },
      { id: "argument-start", url: "spanStart", valueInteger: 6, _valueInteger: { id: "start-note" } },
      { id: "argument-end", url: "spanEnd", valueInteger: 11 },
    ] };
    const action: FhirExtension = { url: "action", extension: [
      { url: "force", valueCode: AdviceForce.Instruction }, { url: "predicateLemma", valueString: "rinse" },
      { url: "sourceText", valueString: "Rinse mouth" },
      { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 11 },
      { id: "action-relation", url: "relationCoding", valueCoding: relation },
      { url: "predicateCoding", valueCoding: coding }, { id: "second-predicate-code", url: "predicateCoding", valueCoding: coding }, argument,
    ] };
    const marker: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL,
      extension: [{ url: "sourceText", valueString: "Rinse mouth" }, action] };
    const before = copy(marker), graph = parseInstructionGraphExtension([marker])!;
    expect(graph.actions).toHaveLength(1);
    expect(graph.actions[0].args[0].span).toEqual({ start: 6, end: 11 });
    const output = buildInstructionGraphExtension(graph)!;
    const current = output.extension!.find(field => field.url === "action")!.extension!;
    const currentArgument = current.find(field => field.url === "argument")!.extension!;
    for (const [fields, relationId, codingName, codingId] of [
      [current, "action-relation", "predicateCoding", "second-predicate-code"],
      [currentArgument, "argument-relation", "argumentCoding", "second-argument-code"],
    ] as const) {
      const relations = fields.filter(field => field.url === "relationCoding");
      expect(relations).toHaveLength(1);
      expect(relations[0]).toEqual({ id: relationId, url: "relationCoding", valueCoding: relation });
      const codes = fields.filter(field => field.url === codingName);
      expect(codes).toHaveLength(2);
      expect(codes[0]).toEqual({ url: codingName, valueCoding: coding });
      expect(codes[1]).toEqual({ id: codingId, url: codingName, valueCoding: coding });
    }
    for (const field of argument.extension!.filter(field => field.url === "spanStart" || field.url === "spanEnd"))
      expect(currentArgument).toContainEqual(field);
    expect(marker).toEqual(before);
  });
});



describe("current instruction occurrence projection stability", () => {
  const prefix = "Instill 1 drop in the right eye at 08:00 and 1 drop in the left eye at 20:00 daily for 7 days. ";
  const leftHold = "Skip the drops in the left eye on Mondays";
  const rightHold = "Skip the drops in the right eye on Fridays";
  const drive = "Do not drive";
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  type CurrentWire = FhirDosage[] | FhirR6DosageInstruction;

  function leftR5(rows: FhirDosage[]): FhirDosage {
    const row = rows.find(item => item.site?.coding?.some(coding => coding.code === "1290031003"));
    expect(row).toBeDefined();
    return row!;
  }

  function leftR6(details: FhirR6DosageInstruction): FhirR6Dosage {
    for (const step of details.step ?? []) for (const row of step.component) {
      if (row.site?.concept?.coding?.some(coding => coding.code === "1290031003")) return row;
    }
    throw new Error("Expected the independently dosed left-eye component");
  }

  it.each([
    { warning: "May cause drowsiness", thaiWarning: "อาจทำให้ง่วงซึม" },
    { warning: "Do not drive", thaiWarning: "ห้ามขับรถ" },
  ])("keeps $warning between independent holds without inventing a temporal sequence", ({ warning, thaiWarning }) => {
    const parsed = parsePublicSig(`${prefix}${leftHold}. ${warning}. ${rightHold}.`);
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      const before = fresh(input);
      for (const locale of ["en", "th"] as const) {
        const output = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
        const left = "the drops in the left eye on monday";
        const middle = (locale === "en" ? warning : thaiWarning).toLowerCase();
        const right = "the drops in the right eye on friday";
        for (const phrase of [left, middle, right]) expect(output.split(phrase)).toHaveLength(2);
        expect(output.indexOf(left)).toBeLessThan(output.indexOf(middle));
        expect(output.indexOf(middle)).toBeLessThan(output.indexOf(right));
        expect(output).not.toMatch(/\bthen\b|จากนั้น/u);
      }
      expect(input).toEqual(before);
    }
  });

  for (const form of ["r5", "r6"] as const) {
    it.each(["element", "display", "userSelected", "i18n"] as const)(`keeps Coding %s annotations separate from clinical instruction identity in fresh ${form}`, variant => {
      const parsed = parsePublicSig("Take 1 tablet daily. Do not drive.");
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const row = Array.isArray(wire) ? wire[0] : wire.step![0].component[0];
      const baseline = ["en", "th"].map(locale => formatSig(wire, "long", { locale, realizationMode: "normalized" }));
      const baselineProjection = projectCanonicalCourse(importCanonicalCourse(wire));
      const originalRows = [baselineProjection.fhir[0], baselineProjection.fhirNext.step![0].component[0]];
      expect(baseline[0]).toBe("Take 1 tablet orally once daily. Do not drive.");
      expect(row.additionalInstruction).toHaveLength(1);
      const marker = row.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const action = marker.extension!.find(item => item.url === "action")!;
      const coding = action.extension!.find(item => item.url === "predicateCoding")!.valueCoding!;
      expect(coding.code).toBeDefined();
      const note = { url: "urn:clinic:instruction-code-note", valueString: "retain without changing the instruction" };
      if (variant === "element") {
        coding.id = "authored-driving-code";
        coding._code = { ...coding._code, id: "authored-driving-code-value", extension: [...(coding._code?.extension ?? []), note] };
        coding.extension = [...(coding.extension ?? []), note];
      } else if (variant === "display") coding.display = "Driving warning selected by clinician";
      else if (variant === "userSelected") coding.userSelected = !coding.userSelected;
      else coding.i18n = { ...coding.i18n, en: "Driving warning", th: "คำเตือนเรื่องการขับรถ" };
      const annotatedCoding = fresh(coding);

      for (let cycle = 0; cycle < 3; cycle++) {
        const before = fresh(wire);
        for (const [index, locale] of ["en", "th"].entries())
          expect(formatSig(wire, "long", { locale, realizationMode: "normalized" })).toBe(baseline[index]);
        const projected = projectCanonicalCourse(importCanonicalCourse(wire));
        for (const [index, output] of [projected.fhir[0], projected.fhirNext.step![0].component[0]].entries()) {
          const original = originalRows[index];
          expect(output.additionalInstruction).toHaveLength(1);
          const retained = output.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
          const current = retained.extension!.find(item => item.url === "action")!;
          expect(current.extension!.find(item => item.url === "predicateCoding")!.valueCoding).toEqual(annotatedCoding);
          expect(parseInstructionGraphExtension(output.extension)!.sourceText)
            .toBe("Take 1 tablet daily. Do not drive.");
          expect(output.patientInstruction).toBe(original.patientInstruction);
          expect(output.doseAndRate).toEqual(original.doseAndRate);
          expect(output.timing?.repeat).toEqual(original.timing?.repeat);
        }
        expect(wire).toEqual(before);
        wire = fresh(form === "r5" ? projected.fhir : projected.fhirNext);
      }
    });


    it.each(["code", "system", "version"] as const)(`keeps distinct selected Coding %s facts in fresh ${form}`, field => {
      const parsed = parsePublicSig("Take 1 tablet daily. Do not drive.");
      const wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const row = Array.isArray(wire) ? wire[0] : wire.step![0].component[0];
      const marker = row.additionalInstruction![0].extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const selected = marker.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "predicateCoding")!.valueCoding!;
      const graphMarker = row.extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
      const graphCoding = graphMarker.extension!.find(item => item.url === "action")!.extension!
        .find(item => item.url === "predicateCoding")!.valueCoding!;
      if (field === "version") graphCoding.version = "20260101";
      const originalCoding = fresh(graphCoding);
      selected[field] = field === "code" ? "clinic-driving-prohibition"
        : field === "system" ? "urn:clinic:instruction-codes" : "20261101";
      const selectedCoding = fresh(selected), before = fresh(wire);
      expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" }).match(/do not drive/giu)).toHaveLength(2);
      const projected = projectCanonicalCourse(importCanonicalCourse(wire));
      for (const output of [projected.fhir[0], projected.fhirNext.step![0].component[0]]) {
        expect(output.additionalInstruction).toHaveLength(2);
        const codings: Array<FhirCoding | FhirR6Coding> = [];
        for (const instruction of output.additionalInstruction!) {
          const graph = instruction.extension!.find(item => item.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL)!;
          const action = graph.extension!.find(item => item.url === "action")!;
          for (const field of action.extension ?? [])
            if (field.url === "predicateCoding" && field.valueCoding) codings.push(field.valueCoding);
        }
        expect(codings).toContainEqual(selectedCoding);
        expect(codings).toContainEqual(originalCoding);
        expect(output.doseAndRate).toEqual(row.doseAndRate);
        expect(output.timing?.repeat).toEqual(row.timing?.repeat);
        expect(parseInstructionGraphExtension(output.extension)!.sourceText)
          .toBe("Take 1 tablet daily. Do not drive.");
      }
      expect(wire).toEqual(before);
    });
  }

  for (const form of ["r5", "r6"] as const) {
    it.each([
      { name: "ordinary negative warning", instructions: [leftHold, rightHold, drive] },
      { name: "negative warning and independent opaque advice", instructions: [leftHold, rightHold, drive, "Arrange a ride home"] },
    ])(`keeps $name rows stable through repeated current ${form} projections`, ({ instructions }) => {
      const patientInstruction = instructions.join(". ");
      const source = `${prefix}${patientInstruction}.`;
      const parsed = parsePublicSig(source);
      const parsedBefore = fresh(parsed);
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const original = form === "r5" ? leftR5(parsed.fhir) : leftR6(parsed.fhirNext);
      expect(original.additionalInstruction?.map(row => row.text)).toEqual(instructions);
      expect(original.patientInstruction).toBe(patientInstruction);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const before = fresh(wire);
        const output = projectCanonicalCourse(importCanonicalCourse(wire));
        expect(wire).toEqual(before);
        for (const row of [leftR5(output.fhir), leftR6(output.fhirNext)]) {
          expect.soft(row.additionalInstruction?.map(instruction => instruction.text)).toEqual(instructions);
          expect.soft(row.additionalInstruction?.filter(instruction => instruction.text === drive)).toHaveLength(1);
          expect(row.patientInstruction).toBe(patientInstruction);
          expect(row._patientInstruction).toEqual(original._patientInstruction);
          expect(row.text).toBe(original.text);
        }
        wire = fresh(form === "r5" ? output.fhir : output.fhirNext);
      }
      expect(parsed).toEqual(parsedBefore);
    });

    it(`keeps identical authored holds and their own annotations separate through current ${form} projections`, () => {
      const instructions = [leftHold, leftHold, drive];
      const patientInstruction = instructions.join(". ");
      const parsed = parsePublicSig(`${prefix}${patientInstruction}.`);
      const parsedBefore = fresh(parsed);
      let wire: CurrentWire = fresh(form === "r5" ? parsed.fhir : parsed.fhirNext);
      const left = Array.isArray(wire) ? leftR5(wire) : leftR6(wire);
      expect(left.additionalInstruction?.map(row => row.text)).toEqual(instructions);
      const occurrences = left.additionalInstruction!.slice(0, 2).map(row => {
        const frame = parseInstructionGraphExtension(row.extension)?.actions[0];
        expect(frame).toBeDefined();
        return { sequenceIndex: frame!.sequenceIndex, span: frame!.span };
      });
      expect(occurrences.map(frame => frame.sequenceIndex)).toEqual([0, 1]);
      expect(occurrences[0].span).not.toEqual(occurrences[1].span);

      // This is fresh current wire input: only the first occurrence owns these
      // annotations. Equal wording must not copy them onto the second hold.
      const rowNote = { url: "urn:clinic:first-hold-note", valueString: "first authored occurrence" };
      const textElement = { id: "first-hold-text", extension: [rowNote] };
      const patientElement = { id: "current-patient-instruction", extension: [
        { url: "urn:clinic:patient-note", valueString: "retain the complete current passage" },
      ] };
      left.additionalInstruction![0].id = "first-authored-hold";
      left.additionalInstruction![0]._text = textElement;
      left.additionalInstruction![0].extension = [...(left.additionalInstruction![0].extension ?? []), rowNote];
      left._patientInstruction = patientElement;

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const before = fresh(wire);
        const output = projectCanonicalCourse(importCanonicalCourse(wire));
        expect(wire).toEqual(before);
        for (const row of [leftR5(output.fhir), leftR6(output.fhirNext)]) {
          expect.soft(row.additionalInstruction?.map(instruction => instruction.text)).toEqual(instructions);
          expect(row.patientInstruction).toBe(patientInstruction);
          expect(row._patientInstruction).toEqual(patientElement);
          expect(row.additionalInstruction!.slice(0, 2).map(instruction => {
            const frame = parseInstructionGraphExtension(instruction.extension)?.actions[0];
            return { sequenceIndex: frame?.sequenceIndex, span: frame?.span };
          })).toEqual(occurrences);
          const [first, second] = row.additionalInstruction!;
          expect(first.id).toBe("first-authored-hold");
          expect(first._text).toEqual(textElement);
          expect(first.extension).toContainEqual(rowNote);
          expect(second.id).toBeUndefined();
          expect(second._text).toBeUndefined();
          expect(second.extension).not.toContainEqual(rowNote);
        }
        wire = fresh(form === "r5" ? output.fhir : output.fhirNext);
      }
      expect(parsed).toEqual(parsedBefore);
    });
  }
});

describe("typed markdown source annotations", () => {
  it("retains an inline markdown extension and its primitive metadata without creating advice", () => {
    const input: FhirR6DosageInstruction = {
      extension: [{ url: "urn:clinic:handover", valueMarkdown: "**Reviewed** with the patient.",
        _valueMarkdown: { id: "handover-note", extension: [
          { url: "urn:clinic:author", valueString: "Prescribing clinician" },
        ] } }],
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      }] }],
    };
    const before = JSON.parse(JSON.stringify(input));
    const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(input)));
    const rebuilt = toDosageDetails(rows);
    expect(rebuilt.extension).toEqual(before.extension);
    expect(rebuilt.step).toHaveLength(1);
    expect(rebuilt.step![0].component[0].patientInstruction).toBeUndefined();
    expect(formatSig(rebuilt, "long", { locale: "en" })).not.toContain("Reviewed");
    expect(input).toEqual(before);
  });
});


describe("current opaque components and UCUM identity", () => {
  it("keeps annotation-only argument components separate from literal siblings", () => {
    const opaque: FhirExtension = { id: "unavailable-qualifier", url: "component", extension: [
      { url: "role", valueCode: "qualifier" }, { url: "text", _valueString: { id: "missing-text", extension: [
        { url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }
      ] } }, { url: "urn:clinic:component-source", valueString: "retain" }
    ] };
    const literal: FhirExtension = { id: "current-qualifier", url: "component", extension: [
      { url: "role", valueCode: "qualifier" }, { url: "text", valueString: "cold" }
    ] };
    const argument: FhirExtension = { url: "argument", extension: [
      { url: "role", valueCode: "object" }, { url: "text", valueString: "water" }, opaque, literal
    ] };
    const marker: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: [
      { url: "sourceText", valueString: "Mix with water" }, { url: "action", extension: [
        { url: "force", valueCode: AdviceForce.Instruction }, { url: "predicateLemma", valueString: "mix" },
        { url: "sourceText", valueString: "Mix with water" },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 14 }, argument
      ] }
    ] };
    const before = JSON.stringify(marker);
    let current = marker;
    for (let cycle = 0; cycle < 2; cycle++) {
      const graph = parseInstructionGraphExtension([JSON.parse(JSON.stringify(current))])!;
      expect(graph.actions[0].args[0].components).toEqual([{ role: "qualifier", text: "cold", sourceId: "current-qualifier" }]);
      current = buildInstructionGraphExtension(graph)!;
      const fields = current.extension!.find(field => field.url === "action")!.extension!
        .find(field => field.url === "argument")!.extension!;
      expect(fields.filter(field => field.url === "component")).toHaveLength(2);
      expect(fields).toContainEqual(opaque);
      expect(fields).toContainEqual(literal);
    }
    expect(JSON.stringify(marker)).toBe(before);
  });

  it.each([
    ["[drp]", "[drp]{ophthalmic}", 1], ["mg{drug}", "mg", 1],
    ["U{lipase}", "U", 1], ["U", "u", null], ["[drp]", "[IU]", null], ["{left}", "{right}", null]
  ] as const)("compares coded UCUM %s and %s without altering either", (leftCode, rightCode, expected) => {
    const left = { system: "http://unitsofmeasure.org", code: leftCode };
    const right = { system: "http://unitsofmeasure.org", code: rightCode };
    const before = JSON.stringify([left, right]);
    expect(convertQuantityValue(1, left, right)).toBe(expected);
    expect(JSON.stringify([left, right])).toBe(before);
  });
});


describe("supported quantity-bearing annotation choices", () => {
  const unknown: FhirR6Extension = { url: "urn:clinic:retain-note", valueString: "Keep the authored annotation" };
  const nested = (quantity: FhirR6Quantity) => ({
    id: "annotated-primitive", extension: [unknown, { url: "urn:clinic:estimate", valueQuantity: quantity }]
  });
  const choices: Array<{ name: keyof FhirR6Extension; wrap: (quantity: FhirR6Quantity) => Partial<FhirR6Extension> }> = [
    { name: "valueQuantity", wrap: quantity => ({ valueQuantity: quantity }) },
    { name: "valueDuration", wrap: quantity => ({ valueDuration: quantity }) },
    { name: "valueRatio", wrap: quantity => ({ valueRatio: {
      numerator: quantity, denominator: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d", _value: nested(quantity) }, extension: [unknown]
    } }) },
    { name: "valueRange", wrap: quantity => ({ valueRange: {
      low: { value: 1, unit: "min", _value: nested(quantity) }, high: { value: 5, unit: "min", _value: nested(quantity) }, extension: [unknown]
    } }) },
    { name: "valuePeriod", wrap: quantity => ({ valuePeriod: {
      start: "2027-01-01", end: "2027-01-03", _end: nested(quantity), extension: [unknown]
    } }) },
    { name: "valueReference", wrap: quantity => ({ valueReference: {
      reference: "Observation/clinic-review", display: "Clinic review", _display: nested(quantity), extension: [unknown]
    } }) },
    { name: "valueCodeableReference", wrap: quantity => ({ valueCodeableReference: {
      reference: { reference: "Observation/clinic-review", display: "Clinic review", _display: nested(quantity) },
      concept: { text: "Review window", _text: nested(quantity) }, extension: [unknown]
    } }) },
    { name: "valueCoding", wrap: quantity => ({ valueCoding: {
      system: "urn:clinic:annotation", code: "review-window", display: "Review window", _display: nested(quantity), extension: [unknown]
    } }) },
    { name: "valueCodeableConcept", wrap: quantity => ({ valueCodeableConcept: {
      text: "Review window", _text: nested(quantity), extension: [unknown],
      coding: [{ system: "urn:clinic:annotation", code: "review-window", _code: nested(quantity) }]
    } }) },
    { name: "_valueCode", wrap: quantity => ({ valueCode: "review", _valueCode: nested(quantity) }) },
    { name: "_valueString", wrap: quantity => ({ valueString: "Review window", _valueString: nested(quantity) }) },
    { name: "_valueMarkdown", wrap: quantity => ({ valueMarkdown: "Review **window**", _valueMarkdown: nested(quantity) }) },
    { name: "_valueDecimal", wrap: quantity => ({ valueDecimal: 2.5, _valueDecimal: nested(quantity) }) },
    { name: "_valueTime", wrap: quantity => ({ valueTime: "08:00:00", _valueTime: nested(quantity) }) },
    { name: "_valueInteger", wrap: quantity => ({ valueInteger: 2, _valueInteger: nested(quantity) }) },
    { name: "_valueBoolean", wrap: quantity => ({ valueBoolean: true, _valueBoolean: nested(quantity) }) }
  ];
  for (const comparator of [undefined, "~"] as const) {
    it.each(choices)("retains " + (comparator ? "approximate" : "exact") + " $name annotations through native and fresh FHIR", ({ name, wrap }) => {
      // Independent wire expectations, without calling the codec under test.
      const ema: FhirR6Extension = { url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000055" } };
      const inner: FhirR6Quantity = { value: 3, unit: "min", system: "http://unitsofmeasure.org", code: "min",
        _value: { id: "nested-authored-value" }, extension: [unknown], ...(comparator ? { comparator } : {}) };
      const innerWire: FhirR6Quantity = { value: 3, unit: "min", system: "http://unitsofmeasure.org", code: "min",
        _value: { id: "nested-authored-value" }, extension: comparator ? [unknown, ema] : [unknown] };
      const quantity: FhirR6Quantity = { value: 2.5, unit: "min", system: "http://unitsofmeasure.org", code: "min",
        _value: nested(inner), extension: [unknown], ...(comparator ? { comparator } : {}) };
      const quantityWire: FhirR6Quantity = { value: 2.5, unit: "min", system: "http://unitsofmeasure.org", code: "min",
        _value: nested(innerWire), extension: comparator ? [unknown, ema] : [unknown] };
      const annotation: FhirR6Extension = { url: "urn:clinic:choice:" + name, id: "authored-choice", ...wrap(quantity) };
      const expectedWire: FhirR6Extension = { url: annotation.url, id: "authored-choice", ...wrap(quantityWire) };
      const opaque: FhirR6Extension = { url: "urn:clinic:opaque-review-timing", valueTiming: {
        code: { text: "Clinic-owned annotation" }, repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Hour }
      } };
      const sourceText = "Take 2 tablets daily";
      const input: FhirR6DosageInstruction = { renderedInstruction: sourceText, step: [{ component: [{
        text: sourceText, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab",
          _value: { id: "authored-dose", extension: [annotation, unknown, opaque] }
        } }], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
      }] }] };
      const before = JSON.parse(JSON.stringify(input));
      const native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
      for (const view of [native, JSON.parse(JSON.stringify(projected.fhir)), JSON.parse(JSON.stringify(projected.fhirNext))]) {
        const viewBefore = JSON.parse(JSON.stringify(view));
        const current = projectCanonicalCourse(importCanonicalCourse(view));
        const row = current.fhir![0], component = current.fhirNext!.step![0].component![0];
        expect(row.doseAndRate![0].doseQuantity!._value).toEqual({ id: "authored-dose", extension: [expectedWire, unknown, opaque] });
        expect(component.doseAndRate![0].doseQuantity!._value).toEqual({ id: "authored-dose", extension: [annotation, unknown, opaque] });
        expect(row.doseAndRate![0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
        expect(component.doseAndRate![0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
        expect(row.text).toBe(sourceText);
        expect(component.text).toBe(sourceText);
        expect(component.timing!.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day });
        expect(component.timing!.repeat!.duration).toBeUndefined();
        expect(component.timing!.repeat!.boundsDuration).toBeUndefined();
        expect(calculateTotalUnits({ dosage: view, orderedAt: "2027-01-01T08:00:00Z", from: "2027-01-01T08:00:00Z",
          timeZone: "UTC", durationValue: 3, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(6);
        expect(view).toEqual(viewBefore);
      }
      expect(input).toEqual(before);
    });
  }
});
