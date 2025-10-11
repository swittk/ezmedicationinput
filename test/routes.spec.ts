import { describe, expect, it } from "vitest";
import { fromFhirDosage, parseSig } from "../src/index";
import {
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_NORMALIZED_FORM,
  DEFAULT_UNIT_SYNONYMS,
  KNOWN_DOSAGE_FORMS_TO_DOSE,
  KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE,
  ROUTE_BY_SNOMED,
  ROUTE_SNOMED,
  ROUTE_TEXT
} from "../src/maps";
import { toFhir } from "../src/fhir";
import { normalizeDosageForm, inferUnitFromContext } from "../src/context";
import { ParsedSigInternal } from "../src/parser";
import {
  RouteCode,
  SNOMEDCTRouteCodes
} from "../src/types";

const SNOMED_SYSTEM = "http://snomed.info/sct";
const INTRAVITREAL_WARNING =
  "Intravitreal administrations require an eye site (e.g., OD/OS/OU).";

describe("SNOMED route coverage", () => {
  it("exposes metadata for every RouteCode", () => {
    const allCodes = Object.values(RouteCode);
    expect(allCodes.length).toBeGreaterThan(0);
    for (const code of allCodes) {
      const routeCode = code as RouteCode;
      const meta = ROUTE_SNOMED[routeCode];
      expect(meta, `missing metadata for ${code}`).toBeDefined();
      expect(meta.code).toBe(routeCode);
      expect(meta.display.length).toBeGreaterThan(0);
      const text = ROUTE_TEXT[routeCode];
      expect(text.length).toBeGreaterThan(0);
      expect(ROUTE_BY_SNOMED[meta.code]).toBe(routeCode);
    }
  });

  it("round-trips every SNOMED coding through FHIR helpers", () => {
    for (const code of Object.values(SNOMEDCTRouteCodes)) {
      const routeCode = code as RouteCode;
      const internal: ParsedSigInternal = {
        input: "",
        tokens: [],
        consumed: new Set<number>(),
        dayOfWeek: [],
        when: [],
        warnings: [],
        routeCode,
        routeText: ROUTE_TEXT[routeCode]
      };
      const fhir = toFhir(internal);
      const coding = fhir.route?.coding?.[0];
      expect(coding).toEqual({
        system: SNOMED_SYSTEM,
        code,
        display: ROUTE_SNOMED[routeCode].display
      });
      const parsed = fromFhirDosage(fhir);
      expect(parsed.meta.normalized.route).toBe(routeCode);
    }
  });

  it("interprets FHIR routes without accompanying text", () => {
    for (const code of Object.values(SNOMEDCTRouteCodes)) {
      const dosage = {
        route: {
          coding: [
            {
              system: SNOMED_SYSTEM,
              code
            }
          ]
        }
      };
      const parsed = fromFhirDosage(dosage);
      expect(parsed.meta.normalized.route).toBe(code);
    }
  });

  it("parses every default route synonym without conflicting tokens", () => {
    const entries = Object.entries(DEFAULT_ROUTE_SYNONYMS);
    expect(entries.length).toBeGreaterThan(0);

    const warningExpectations: Partial<Record<RouteCode, string[]>> = {
      [RouteCode["Intravitreal route (qualifier value)"]]: [INTRAVITREAL_WARNING]
    };

    for (const [phrase, synonym] of entries) {
      const sig = `1 tab ${phrase} q12h`;
      const result = parseSig(sig, {
        context: { defaultUnit: "tab" }
      });

      const { fhir } = result;
      const dose = fhir.doseAndRate?.[0]?.doseQuantity;
      expect(dose?.value).toBe(1);
      expect(dose?.unit).toBe("tab");

      const coding = fhir.route?.coding?.[0];
      expect(coding, `missing SNOMED coding for "${phrase}"`).toBeDefined();
      expect(coding?.system).toBe(SNOMED_SYSTEM);
      expect(coding?.code).toBe(synonym.code);
      expect(coding?.display).toBe(ROUTE_SNOMED[synonym.code].display);
      expect(fhir.route?.text).toBe(ROUTE_TEXT[synonym.code]);

      const timing = fhir.timing;
      expect(timing?.code?.coding?.[0].code).toBe("Q12H");
      expect(timing?.repeat?.period).toBe(12);
      expect(timing?.repeat?.periodUnit).toBe("h");

      const expectedWarnings = warningExpectations[synonym.code] ?? [];
      expect(result.warnings).toEqual(expectedWarnings);
      expect(result.fhir.site?.text ?? undefined).toBeUndefined();

      expect(result.meta.normalized.route).toBe(synonym.code);
      expect(result.meta.normalized.unit).toBe("tab");
      // Ensure route phrases are fully consumed so no stray tokens masquerade
      // as body-site hints (e.g., OS/OD) in downstream parsing.
      expect(
        result.meta.leftoverText,
        `unexpected leftover for "${phrase}": ${result.meta.leftoverText}`
      ).toBeUndefined();
    }
  });

  it("parses SNOMED display phrases for every route code", () => {
    const warningExpectations: Partial<Record<RouteCode, string[]>> = {
      [RouteCode["Intravitreal route (qualifier value)"]]: [INTRAVITREAL_WARNING]
    };

    for (const routeCode of Object.values(RouteCode)) {
      const display = ROUTE_SNOMED[routeCode].display.toLowerCase();
      const result = parseSig(`1 tab ${display} q12h`, {
        context: { defaultUnit: "tab" }
      });

      const coding = result.fhir.route?.coding?.[0];
      expect(coding?.system).toBe(SNOMED_SYSTEM);
      expect(coding?.code).toBe(routeCode);
      expect(coding?.display).toBe(ROUTE_SNOMED[routeCode].display);
      expect(result.fhir.route?.text).toBe(ROUTE_TEXT[routeCode]);
      expect(result.meta.normalized.route).toBe(routeCode);

      const dose = result.fhir.doseAndRate?.[0]?.doseQuantity;
      expect(dose?.value).toBe(1);
      expect(dose?.unit).toBe("tab");

      expect(result.meta.leftoverText).toBeUndefined();
      const expectedWarnings = warningExpectations[routeCode] ?? [];
      expect(result.warnings).toEqual(expectedWarnings);
    }
  });

  it("consumes every route synonym when followed by every route code text", () => {
    const entries = Object.entries(DEFAULT_ROUTE_SYNONYMS);
    const unitEntries = Object.entries(DEFAULT_UNIT_SYNONYMS);
    const warningExpectations: Partial<Record<RouteCode, string[]>> = {
      [RouteCode["Intravitreal route (qualifier value)"]]: [INTRAVITREAL_WARNING]
    };

    for (const routeCode of Object.values(RouteCode)) {
      const baseText = ROUTE_TEXT[routeCode];
      const [baselineUnitPhrase, baselineCanonicalUnit] = unitEntries[0];
      const baseline = parseSig(`1 ${baselineUnitPhrase} ${baseText} q12h`, {
        context: { defaultUnit: baselineCanonicalUnit }
      });
      const expectedRoute = baseline.meta.normalized.route;
      const expectedWarnings = warningExpectations[expectedRoute] ?? [];

      for (const [phrase] of entries) {
        for (const [unitPhrase, canonicalUnit] of unitEntries) {
          const sig = `1 ${unitPhrase} ${phrase} ${baseText} q12h`;
          const result = parseSig(sig, {
            context: { defaultUnit: canonicalUnit }
          });

          const expectedCoding = result.fhir.route?.coding?.[0];
          expect(expectedCoding?.system).toBe(SNOMED_SYSTEM);
          expect(expectedCoding?.code).toBe(expectedRoute);
          expect(expectedCoding?.display).toBe(
            ROUTE_SNOMED[expectedRoute].display
          );
          expect(result.fhir.route?.text).toBe(ROUTE_TEXT[expectedRoute]);
          expect(result.meta.normalized.route).toBe(expectedRoute);

          const dose = result.fhir.doseAndRate?.[0]?.doseQuantity;
          expect(dose?.value).toBe(1);
          expect(dose?.unit).toBe(canonicalUnit);

          expect(result.warnings).toEqual(expectedWarnings);
          expect(result.meta.leftoverText).toBeUndefined();
        }
      }
    }
  });
});

describe("dosage form normalization coverage", () => {
  it("normalizes every known dosage form and infers default units", () => {
    const entries = Object.entries(KNOWN_DOSAGE_FORMS_TO_DOSE);
    expect(entries.length).toBeGreaterThan(0);

    for (const [rawForm, normalizedForm] of entries) {
      const normalized = normalizeDosageForm(rawForm);
      expect(normalized).toBe(normalizedForm);

      const inferredUnit = inferUnitFromContext({ dosageForm: rawForm });
      const expectedUnit = DEFAULT_UNIT_BY_NORMALIZED_FORM[normalizedForm];
      expect(inferredUnit).toBe(expectedUnit);
    }
  });

  it("maps every known dosage form to a SNOMED route", () => {
    for (const rawForm of Object.keys(KNOWN_DOSAGE_FORMS_TO_DOSE)) {
      const routeCode = KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE[rawForm];
      expect(routeCode, `missing SNOMED route for ${rawForm}`).toBeDefined();
    }
  });
});
