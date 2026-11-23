import { describe, expect, it } from "vitest";
import cases from "./generation-roundtrip-cases.json";
import thaiCases from "./generation-roundtrip-thai-cases.json";
import crossLanguageCases from "./generation-cross-language-cases.json";
import {
  formatSig, formatSigBatch, fromFhirDosage, toDosageDetails, toFhirR5Dosages,
  nextDueDoses, calculateTotalUnits, FhirPeriodUnit
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import type { AdviceArgument, AdviceFrame, CanonicalSigClause } from "../src/types";

type Result = ReturnType<typeof parseSig>;

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
  return Object.values(value).some((x) => Array.isArray(x) ? x.length : x !== undefined) ? value : undefined;
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
    expect(course.step.map(stage => stage.component.map(component =>
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
    }, short: ["; Dose: 1 mg – 1 g", "; ขนาดยาต่อครั้ง: 1 mg – 1 g"],
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
    const r6 = toDosageDetails([row]);
    expect(r6.step![0].component[0].doseAndRate?.[0].doseRange).toEqual(range);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    expect(cold[0].doseAndRate[0].doseRange).toEqual(range);
    expect(JSON.stringify(row)).toBe(saved);
  });

  it.each(["en", "th"] as const)("normalizes the verified condition in %s while retaining roundtrip source", locale => {
    const source = "Take 1 tablet BID only if BP >160, otherwise hold";
    const row = parseSig(source).fhir;
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
      const imported = fromFhirDosage(dosage, options);
      expect(imported.shortText).toBe(short);
      expect(imported.longText).toContain(dose);
      expect(imported.longText).toMatch(new RegExp(condition + "(?![0-9]|[.][0-9])", "u"));
      expect(dosage.text).toBe(source);
    }
    // Only the verified original row owns exact source replay. The strict cold
    // form already uses structured realization when its source proof differs.
    for (const style of ["short", "long"] as const)
      expect(formatSig(row, style, { locale, realizationMode: "roundtrip" })).toBe(source);
    expect(fromFhirDosage(row, { locale, realizationMode: "roundtrip" }).longText).toBe(source);
    expect(JSON.stringify(row)).toBe(saved);
  });
});
