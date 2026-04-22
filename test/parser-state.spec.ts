import { describe, expect, it } from "vitest";
import { parserStateFromFhir } from "../src/fhir";
import { ParserState } from "../src/parser-state";

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

  it("selects the first coded PRN and additional-instruction entries when uncoded entries lead", () => {
    const state = parserStateFromFhir({
      asNeededBoolean: true,
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

    expect(state.asNeededReasonCoding).toEqual({
      system: "http://snomed.info/sct",
      code: "418363000",
      display: "Itching of skin",
      i18n: { th: "คัน" }
    });
    expect(state.additionalInstructions[0]?.coding).toEqual({
      system: "http://snomed.info/sct",
      code: "418693002",
      display: "Swallowed whole, not chewed (qualifier value)",
      i18n: { th: "กลืนทั้งเม็ด; ห้ามเคี้ยวหรือบด" }
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
});
