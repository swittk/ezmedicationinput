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
});
