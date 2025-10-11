import { describe, expect, it } from "vitest";
import { fromFhirDosage } from "../src/index";
import { ROUTE_BY_SNOMED, ROUTE_SNOMED, ROUTE_TEXT } from "../src/maps";
import { toFhir } from "../src/fhir";
import {
  ParsedSigInternal
} from "../src/parser";
import {
  RouteCode,
  SNOMEDCTRouteCodes
} from "../src/types";

const SNOMED_SYSTEM = "http://snomed.info/sct";

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
});
