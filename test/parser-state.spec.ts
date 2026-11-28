import { convertQuantityValue } from "../src/utils/units";
import { MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL } from "../src/instruction-graph-fhir";
import { formatSig, importCanonicalCourse, projectCanonicalCourse, toDosageDetails, toFhirR5Dosages, type FhirDosage, type FhirExtension, FhirPeriodUnit, EventTiming, RouteCode, calculateTotalUnits, nextDueDoses, buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/index";
import { describe, expect, it } from "vitest";
import { BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL } from "../src/body-site-target";
import { canonicalFromFhir, canonicalToFhir, parserStateFromFhir, TIMING_OFFSET_EXACT_EXTENSION_URL, getExactTimingOffsetMinutes } from "../src/fhir";
import { ParserState } from "../src/parser-state";
import { applySiteCoding } from "../src/site-coding";
import { applyPrnReasonCoding } from "../src/prn-reason-coding";

const FHIR_TRANSLATION_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/translation";

function translationPrimitive(locale: string, value: string) {
  return {
    extension: [
      {
        url: FHIR_TRANSLATION_EXTENSION_URL,
        extension: [
          { url: "lang", valueCode: locale },
          { url: "content", valueString: value }
        ]
      }
    ]
  };
}

function expectTranslation(
  element: { extension?: Array<{ url: string; extension?: Array<{ url: string; valueCode?: string; valueString?: string }> }> } | undefined,
  locale: string,
  value: string
): void {
  expect(element?.extension).toContainEqual(
    expect.objectContaining({
      url: FHIR_TRANSLATION_EXTENSION_URL,
      extension: expect.arrayContaining([
        expect.objectContaining({ url: "lang", valueCode: locale }),
        expect.objectContaining({ url: "content", valueString: value })
      ])
    })
  );
}

describe("ParserState setters", () => {
  it("preserves PRN tri-state semantics and localized PRN coding metadata", () => {
    const state = new ParserState("", []);

    state.asNeeded = undefined;
    expect(state.primaryClause.prn).toBeUndefined();

    state.asNeededReasonCoding = {
      system: "http://example.org/reason",
      code: "itch",
      display: "Itch",
      i18n: { th: "คัน" }
    };
    expect(state.primaryClause.prn).toEqual({
      enabled: true,
      reason: {
        coding: {
          system: "http://example.org/reason",
          code: "itch",
          display: "Itch",
          i18n: { th: "คัน" }
        }
      }
    });

    state.asNeededReasonCoding = undefined;
    expect(state.primaryClause.prn).toEqual({ enabled: true });
  });

  it("preserves site state that contains only translations", () => {
    const state = new ParserState("", []);
    state.siteI18n = { th: "บริเวณตา" };
    expect(state.primaryClause.site).toEqual({ i18n: { th: "บริเวณตา" } });
  });

  it("preserves localized site coding metadata without creating empty site state", () => {
    const state = new ParserState("", []);

    state.siteCoding = undefined;
    expect(state.primaryClause.site).toBeUndefined();

    state.siteCoding = {
      system: "http://example.org/site",
      code: "eye",
      display: "Eye",
      i18n: { th: "ตา" }
    };
    expect(state.primaryClause.site?.coding).toEqual({
      system: "http://example.org/site",
      code: "eye",
      display: "Eye",
      i18n: { th: "ตา" }
    });
  });
});

describe("FHIR parser-state import", () => {
  it("preserves non-SNOMED site codings on import", () => {
    const state = parserStateFromFhir({
      site: {
        coding: [
          {
            system: "http://example.org/site",
            code: "custom-site",
            display: "Custom site"
          }
        ]
      }
    });

    expect(state.siteCoding).toEqual({
      system: "http://example.org/site",
      code: "custom-site",
      display: "Custom site"
    });
    expect(state.siteSource).toBe("text");
  });

  it("ignores uncoded site entries and keeps the first coded site entry", () => {
    const state = parserStateFromFhir({
      site: {
        coding: [
          {
            system: "http://snomed.info/sct",
            display: "Missing code"
          },
          {
            system: "http://example.org/site",
            code: "coded-site",
            display: "Coded site"
          }
        ]
      }
    });

    expect(state.siteCoding).toEqual({
      system: "http://example.org/site",
      code: "coded-site",
      display: "Coded site"
    });
  });

  it("imports site and PRN translation primitive metadata into i18n", () => {
    const state = parserStateFromFhir({
      site: {
        text: "ocular surface",
        _text: translationPrimitive("th", "ผิวตา"),
        coding: [
          {
            system: "http://example.org/site",
            code: "ocular-surface",
            display: "Ocular surface",
            i18n: { en: "Ocular surface" },
            _display: translationPrimitive("th", "พื้นผิวตา")
          }
        ]
      },
      asNeeded: true,
      asNeededFor: [
        {
          text: "dryness",
          _text: translationPrimitive("th", "แห้ง"),
          coding: [
            {
              system: "http://example.org/reason",
              code: "dryness",
              display: "Dryness",
              i18n: { en: "Dryness" },
              _display: translationPrimitive("th", "อาการแห้ง")
            }
          ]
        }
      ]
    });

    expect(state.siteCoding).toEqual({
      system: "http://example.org/site",
      code: "ocular-surface",
      display: "Ocular surface",
      i18n: {
        en: "Ocular surface",
        th: "พื้นผิวตา"
      }
    });
    expect(state.primaryClause.site?.i18n).toEqual({
      th: "ผิวตา"
    });
    expect(state.asNeededReasons[0]?.coding?.i18n).toEqual({
      en: "Dryness",
      th: "อาการแห้ง"
    });
    expect(state.asNeededReasons[0]?.i18n).toEqual({
      th: "แห้ง"
    });
    expect(state.asNeededReasonCoding?.i18n).toEqual({
      en: "Dryness",
      th: "อาการแห้ง"
    });
    expect(state.primaryClause.prn?.reason?.i18n).toEqual({
      th: "แห้ง"
    });
  });

  it("infers administration target count from coded bilateral sites without requiring an extension", () => {
    const state = parserStateFromFhir({
      site: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "40638003",
            display: "Structure of both eyes"
          }
        ]
      }
    });

    expect(state.siteText).toBe("both eyes");
    expect(state.siteAdministrationTargetCount).toBe(2);
  });

  it("exports administration target count as a private extension only when coding/text cannot carry it", () => {
    const dosage = canonicalToFhir({
      kind: "administration",
      rawText: "",
      raw: { start: 0, end: 0, text: "" },
      leftovers: [],
      evidence: [],
      confidence: 1,
      site: {
        text: "custom paired site",
        administrationTargetCount: 2,
        coding: {
          system: "http://example.org/site",
          code: "custom-paired-site",
          display: "Custom paired site"
        }
      }
    });

    expect(dosage.site?.extension).toContainEqual({
      url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
      valueInteger: 2
    });
  });

  it("preserves timestamp-valued Timing.event through canonical and parser-state conversion", () => {
    const input = {
      timing: {
        event: ["2026-09-28T14:30:00Z"]
      }
    };

    const clause = canonicalFromFhir(input);
    expect(clause.schedule?.calendarEvents?.[0]).toMatchObject({
      isoDate: "2026-09-28",
      fhirDateTime: "2026-09-28T14:30:00Z"
    });
    expect(canonicalToFhir(clause).timing?.event).toEqual(["2026-09-28T14:30:00Z"]);

    const state = parserStateFromFhir(input);
    expect(state.primaryClause.schedule?.calendarEvents?.[0]).toMatchObject({
      isoDate: "2026-09-28",
      fhirDateTime: "2026-09-28T14:30:00Z"
    });
  });

  it("preserves extension-only administration target counts when importing canonical site state", () => {
    const clause = canonicalFromFhir({
      site: {
        extension: [
          {
            url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL,
            valueInteger: 2
          }
        ]
      }
    });

    expect(clause.site).toEqual({
      text: undefined,
      i18n: undefined,
      spatialRelation: undefined,
      administrationTargetCount: 2,
      coding: undefined,
      source: "text"
    });
  });

  it("keeps an existing administration target count when site coding resolution finds a definition without one", () => {
    const state = new ParserState("", []);
    state.siteText = "eye";
    state.siteAdministrationTargetCount = 2;
    state.siteLookupRequest = {
      text: "eye",
      canonical: "eye"
    };

    applySiteCoding(state);

    expect(state.siteCoding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "81745001"
    });
    expect(state.siteAdministrationTargetCount).toBe(2);
  });

  it("adds coding i18n translations without dropping existing display primitive extensions", () => {
    const dosage = canonicalToFhir(
      {
        kind: "administration",
        rawText: "",
        raw: { start: 0, end: 0, text: "" },
        leftovers: [],
        evidence: [],
        confidence: 1,
        prn: {
          enabled: true,
          reason: {
            text: "dryness",
            coding: {
              system: "http://example.org/reason",
              code: "dryness",
              display: "Dryness",
              i18n: { th: "อาการแห้ง" },
              _display: translationPrimitive("en", "Dryness")
            }
          },
          reasons: [
            {
              text: "dryness",
              coding: {
                system: "http://example.org/reason",
                code: "dryness",
                display: "Dryness",
                i18n: { th: "อาการแห้ง" },
                _display: translationPrimitive("en", "Dryness")
              }
            }
          ]
        }
      },
      undefined,
      { includeTranslationExtensions: true }
    );

    const displayElement = dosage.asNeededFor?.[0]?.coding?.[0]?._display;
    expectTranslation(displayElement, "en", "Dryness");
    expectTranslation(displayElement, "th", "อาการแห้ง");
  });

  it("does not let empty base translation content block a valid coding i18n addition", () => {
    const dosage = canonicalToFhir(
      {
        kind: "administration",
        rawText: "",
        raw: { start: 0, end: 0, text: "" },
        leftovers: [],
        evidence: [],
        confidence: 1,
        prn: {
          enabled: true,
          reason: {
            text: "dryness",
            coding: {
              system: "http://example.org/reason",
              code: "dryness",
              display: "Dryness",
              i18n: { th: "อาการแห้ง" },
              _display: {
                extension: [
                  {
                    url: "http://hl7.org/fhir/StructureDefinition/translation",
                    extension: [
                      { url: "lang", valueCode: "th" },
                      { url: "content", valueString: "   " }
                    ]
                  }
                ]
              }
            }
          }
        }
      },
      undefined,
      { includeTranslationExtensions: true }
    );

    const displayElement = dosage.asNeededFor?.[0]?.coding?.[0]?._display;
    expectTranslation(displayElement, "th", "อาการแห้ง");
  });

  it("selects the first coded PRN and additional-instruction entries when uncoded entries lead", () => {
    const state = parserStateFromFhir({
      asNeeded: true,
      asNeededFor: [
        {
          text: "itch",
          coding: [
            {
              system: "http://example.org/reason",
              display: "No code first"
            },
            {
              system: "http://snomed.info/sct",
              code: "418363000",
              display: "Itching of skin"
            }
          ]
        }
      ],
      additionalInstruction: [
        {
          text: "Swallow whole; do not crush or chew",
          coding: [
            {
              system: "http://example.org/instruction",
              display: "No code first"
            },
            {
              system: "http://snomed.info/sct",
              code: "418693002",
              display: "Swallowed whole, not chewed (qualifier value)"
            }
          ]
        }
      ]
    });

    expect(state.asNeededReasonCoding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "418363000",
      display: "Itching of skin"
    });
    expect(state.primaryClause.prn?.reason?.i18n).toEqual({
      th: "คัน"
    });
    expect(state.additionalInstructions[0]?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "418693002",
      display: "Swallowed whole, not chewed (qualifier value)",
      i18n: { th: "กลืนทั้งเม็ด; ห้ามเคี้ยว" }
    });
  });

  it("preserves partial dose ranges and flags mismatched range units", () => {
    const state = parserStateFromFhir({
      doseAndRate: [
        {
          doseRange: {
            low: { value: 1, unit: "tab" },
            high: { value: 2, unit: "mL" }
          }
        }
      ]
    });

    expect(state.primaryClause.dose).toEqual({
      range: { low: 1, high: 2 },
      unit: "tab"
    });
    expect(state.warnings).toContain(
      "FHIR doseRange low/high units differ (tab vs mL); preserved numeric bounds using tab."
    );
  });

  it("preserves one-sided dose ranges from FHIR", () => {
    const state = parserStateFromFhir({
      doseAndRate: [
        {
          doseRange: {
            high: { value: 2, unit: "tab" }
          }
        }
      ]
    });

    expect(state.primaryClause.dose).toEqual({
      range: { high: 2 },
      unit: "tab"
    });
  });

  it("imports regimen bounds from boundsDuration", () => {
    const state = parserStateFromFhir({
      timing: {
        repeat: {
          boundsDuration: {
            value: 7,
            unit: "days",
            system: "http://unitsofmeasure.org",
            code: "d"
          }
        }
      }
    });

    expect(state.primaryClause.schedule).toMatchObject({
      duration: 7,
      durationUnit: "d"
    });
  });

  it("imports ranged regimen bounds from boundsRange", () => {
    const state = parserStateFromFhir({
      timing: {
        repeat: {
          boundsRange: {
            low: {
              value: 5,
              unit: "days",
              system: "http://unitsofmeasure.org",
              code: "d"
            },
            high: {
              value: 7,
              unit: "days",
              system: "http://unitsofmeasure.org",
              code: "d"
            }
          }
        }
      }
    });

    expect(state.primaryClause.schedule).toMatchObject({
      duration: 5,
      durationMax: 7,
      durationUnit: "d"
    });
  });

  it("clears an undefined PRN trigger phase without creating PRN state", () => {
    const empty = new ParserState("", []);
    empty.asNeededReasonTriggerPhase = undefined;
    expect(empty.primaryClause.prn).toBeUndefined();

    const state = new ParserState("", []);
    state.asNeededReason = "pain";
    state.asNeededReasonTriggerPhase = "onset";
    state.asNeededReasonTriggerPhase = undefined;
    expect(state.primaryClause.prn?.reason?.text).toBe("pain");
    expect(state.primaryClause.prn?.reason?.triggerPhase).toBeUndefined();
  });

  it("preserves PRN trigger phases by reason identity rather than request order", () => {
    const state = new ParserState("", []);
    state.asNeeded = true;
    state.asNeededReasons = [
      { text: "migraine", triggerPhase: "onset" },
      { text: "headache" }
    ];
    state.prnReasonLookupRequests = [
      { originalText: "headache", text: "headache", normalized: "headache", canonical: "headache", isProbe: false, inputText: "" },
      { originalText: "migraine", text: "migraine", normalized: "migraine", canonical: "migraine", isProbe: false, inputText: "" }
    ];
    applyPrnReasonCoding(state);
    expect(state.asNeededReasons?.map((reason) => [reason.text, reason.triggerPhase])).toEqual([
      ["headache", undefined],
      ["migraine", "onset"]
    ]);
  });

  it("applies an aggregate PRN trigger phase across multiple lookup requests", () => {
    const state = new ParserState("", []);
    state.asNeeded = true;
    state.asNeededReasonTriggerPhase = "onset";
    state.prnReasonLookupRequests = [
      { originalText: "headache", text: "headache", normalized: "headache", canonical: "headache", isProbe: false, inputText: "" },
      { originalText: "migraine", text: "migraine", normalized: "migraine", canonical: "migraine", isProbe: false, inputText: "" }
    ];
    applyPrnReasonCoding(state);
    expect(state.asNeededReasons?.map((reason) => reason.triggerPhase)).toEqual(["onset", "onset"]);
    expect(state.asNeededReasonTriggerPhase).toBe("onset");
  });

});


describe("review814 authored coded advice in Thai", () => {
  it("keeps the complete authored prohibition beyond a narrower code label", () => {
    const source = "Swallow whole; do not crush or chew";
    const row: FhirDosage = { additionalInstruction: [{ text: source,
      coding: [{ system: "http://snomed.info/sct", code: "418693002", display: "Swallowed whole, not chewed (qualifier value)" }],
      extension: [{ url: "urn:clinic:advice-note", valueString: "whole source required" }]
    }] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [importCanonicalCourse([row]), JSON.parse(JSON.stringify([row])), JSON.parse(JSON.stringify(r6))]) {
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(source + ".");
      const advice = projectCanonicalCourse(importCanonicalCourse(input)).fhir[0].additionalInstruction![0];
      expect(advice.text).toBe(source);
      expect(advice.coding).toEqual(row.additionalInstruction![0].coding);
      expect(advice.extension).toContainEqual(row.additionalInstruction![0].extension![0]);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("retains code-only Thai wording and an independently supplied complete Thai translation", () => {
    const coding = [{ system: "http://snomed.info/sct", code: "418693002" }];
    const stock: FhirDosage = { additionalInstruction: [{ coding }] };
    const selected: FhirDosage = { additionalInstruction: [{ coding,
      text: "Swallow whole; do not crush or chew",
      _text: translationPrimitive("th", "กลืนทั้งเม็ด ห้ามบดหรือเคี้ยว")
    }] };
    for (const [row, expected] of [[stock, "กลืนทั้งเม็ด; ห้ามเคี้ยว."], [selected, "กลืนทั้งเม็ด ห้ามบดหรือเคี้ยว."]] as const) {
      const before = JSON.stringify(row), r6 = toDosageDetails([row]);
      for (const input of [row, JSON.parse(JSON.stringify(r6)), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
        expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(expected);
      expect(JSON.stringify(row)).toBe(before);
    }
  });
});

describe("current FHIR timing, route, quantity and coverage ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const ucum = "http://unitsofmeasure.org";

  it.each([false, true])("prefers the explicit route terminology in either coding order (%s)", reversed => {
    const legacy = { code: "26643006", display: "Legacy route", id: "legacy-coding" };
    const explicit = { system: "http://snomed.info/sct", code: "54485002", id: "explicit-ophthalmic" };
    const route = { coding: reversed ? [explicit, legacy] : [legacy, explicit],
      extension: [{ url: "urn:clinic:route-note", valueString: "Keep both codings" }] };
    const row: FhirDosage = { text: "Instill one drop by the supplied ophthalmic route.", route,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }] };
    const before = fresh(row);
    expect(canonicalFromFhir(row).route?.code).toBe(RouteCode["Ophthalmic route"]);
    expect(parserStateFromFhir(row).primaryClause.route?.code).toBe(RouteCode["Ophthalmic route"]);
    const native = importCanonicalCourse(row), projected = projectCanonicalCourse(native);
    for (const input of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      const current = projectCanonicalCourse(importCanonicalCourse(input));
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("ophthalmic");
      expect(current.fhir[0].route).toEqual(route);
      expect(current.fhirNext.step[0].component[0].route).toEqual(route);
    }
    expect(canonicalFromFhir({ route: { coding: [legacy] } }).route?.code).toBe(RouteCode["Oral route"]);
    expect(row).toEqual(before);
  });

  it.each([EventTiming.Meal, EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner])(
    "keeps a thirty-minute %s offset in the typed extension when R5 forbids the core slot", event => {
      const clause = { ...canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }),
        schedule: { when: [event], offset: 30 } };
      const before = fresh(clause), row = canonicalToFhir(clause);
      expect(row.timing?.repeat?.when).toEqual([event]);
      expect(row.timing?.repeat?.offset).toBeUndefined();
      expect(row.timing?.repeat?.extension).toContainEqual({ url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueInteger: 30 });
      expect(getExactTimingOffsetMinutes(row.timing?.repeat)).toBe(30);
      expect(canonicalFromFhir(fresh(row)).schedule).toMatchObject({ when: [event], offset: 30 });
      expect(clause).toEqual(before);
    }
  );

  it("keeps a permitted before-breakfast offset in the core slot", () => {
    const clause = { ...canonicalFromFhir({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }),
      schedule: { when: [EventTiming["Before Breakfast"]], offset: 30 } };
    const row = canonicalToFhir(clause);
    expect(row.timing?.repeat).toMatchObject({ when: [EventTiming["Before Breakfast"]], offset: 30 });
    expect(row.timing?.repeat?.extension?.some(value => value.url === TIMING_OFFSET_EXACT_EXTENSION_URL)).not.toBe(true);
  });

  it.each([undefined, 20])("retains a thirty-minute upper duration with lower value %s", duration => {
    const absent = { id: "unknown-lower-duration", extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    }] };
    const repeat = { durationMax: 30, durationUnit: FhirPeriodUnit.Minute,
      ...(duration === undefined ? { _duration: absent } : { duration }) };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }], timing: { repeat } };
    const before = fresh(row);
    for (const clause of [canonicalFromFhir(row)]) {
      expect(clause.schedule?.administrationDuration).toBe(duration);
      expect(clause.schedule?.administrationDurationMax).toBe(30);
      expect(clause.schedule?.administrationDurationUnit).toBe(FhirPeriodUnit.Minute);
    }
    const projected = projectCanonicalCourse(importCanonicalCourse(row));
    expect(projected.fhir[0].timing?.repeat).toEqual(repeat);
    expect(projected.fhirNext.step[0].component[0].timing?.repeat).toEqual(repeat);
    expect(row).toEqual(before);
  });

  it("applies a tablet ceiling to an annotation-only UCUM presentation", () => {
    const dose = { value: 1, unit: "tablet", system: ucum, code: "{tbl}", _code: { id: "authored-tablet-code" } };
    const cap = { numerator: { value: 2, unit: "tablets", id: "authored-ceiling" },
      denominator: { value: 48, unit: "h", system: ucum, code: "h" } };
    const input: FhirDosage = { text: "Take one tablet at 08:00 and 20:00, maximum two tablets in 48 hours.",
      doseAndRate: [{ doseQuantity: dose }], maxDosePerPeriod: [cap],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "20:00:00"] } } };
    const before = fresh(input), native = importCanonicalCourse(input), projected = projectCanonicalCourse(native);
    const query = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC" };
    for (const value of [native, fresh(projected.fhir), fresh(projected.fhirNext)]) {
      expect(nextDueDoses(value, { ...query, limit: 3 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00", "2026-01-03T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: value, ...query, durationValue: 2, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab" });
      const current = projectCanonicalCourse(importCanonicalCourse(value));
      expect(current.fhir[0].doseAndRate![0].doseQuantity).toEqual(dose);
      expect(current.fhir[0].maxDosePerPeriod).toEqual([cap]);
      expect(current.fhirNext.step[0].component[0].doseAndRate![0].doseQuantity).toEqual(dose);
    }
    expect(input).toEqual(before);
  });

  it("keeps substantive UCUM identity and unlabeled count annotations separate from presentation labels", () => {
    const substantive = { value: 1, unit: "mL", system: ucum, code: "ML{solution}" };
    const unlabeled = { value: 1, system: ucum, code: "{tbl}" };
    const before = fresh([substantive, unlabeled]);
    expect(convertQuantityValue(1, substantive, { unit: "mL" })).toBeNull();
    expect(convertQuantityValue(1, unlabeled, { unit: "tablets" })).toBeNull();
    expect([substantive, unlabeled]).toEqual(before);
  });

  it.each([undefined, 0])("retains supplied coverage with ratio %s without inventing a value", ratio => {
    const source = "Follow the supplied plan.";
    const coverage: FhirExtension = { url: "coverage", id: "coverage-source", extension: [
      { url: "understoodCharacters", valueInteger: 0 },
      { url: "opaqueCharacters", valueInteger: source.length },
      { url: "ratio", ...(ratio === undefined ? {} : { valueDecimal: ratio }),
        _valueDecimal: { id: "ratio-note", extension: [{ url: "urn:clinic:coverage-note", valueString: "Retain" }] } },
      { url: "complete", valueBoolean: false }
    ] };
    const input: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: [
      { url: "sourceText", valueString: source },
      { url: "opaque", extension: [
        { url: "start", valueInteger: 0 }, { url: "end", valueInteger: source.length },
        { url: "text", valueString: source }
      ] },
      coverage
    ] };
    const before = fresh(input), graph = parseInstructionGraphExtension([input])!;
    expect(graph.sourceText).toBe(source);
    expect(graph.opaqueSpans).toEqual([{ start: 0, end: source.length, text: source }]);
    if (ratio === undefined) expect(graph.coverage).toBeUndefined();
    else expect(graph.coverage).toMatchObject({ ratio: 0, complete: false, understoodCharacters: 0, opaqueCharacters: source.length });
    const output = buildInstructionGraphExtension(graph)!;
    expect(output.extension?.filter(value => value.url === "coverage")).toEqual([coverage]);
    expect(input).toEqual(before);
  });
});
