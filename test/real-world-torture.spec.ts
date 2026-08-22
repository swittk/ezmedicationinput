import { describe, expect, it } from "vitest";
import cases from "./real-world-torture-cases.json";
import { parseSig, type ParseBatchResult } from "../src/index";

type DoseTuple = [number, string | null];
type RangeTuple = [number, number, string | null];
interface TortureCase {
  name: string;
  input: string;
  locale?: string;
  dose?: DoseTuple;
  doseRange?: RangeTuple;
  route?: string;
  timing?: string;
  site?: string;
  siteCode?: string;
  method?: string;
  actions?: string[];
  forbiddenDose?: DoseTuple;
  forbiddenRoute?: string;
}

function items(result: ParseBatchResult) {
  return result.items;
}

function actions(result: ParseBatchResult): string[] {
  return result.meta.canonical.clauses.reduce<string[]>((all, clause) => {
    for (const action of clause.instructionGraph?.actions ?? []) all.push(action.predicate.lemma);
    return all;
  }, []);
}

function hasDose(result: ParseBatchResult, expected: DoseTuple): boolean {
  return items(result).some((item) =>
    item.fhir.doseAndRate?.some((entry) => {
      const dose = entry.doseQuantity;
      return dose?.value === expected[0] && (expected[1] === null || dose.unit === expected[1]);
    })
  );
}

function hasRange(result: ParseBatchResult, expected: RangeTuple): boolean {
  return items(result).some((item) =>
    item.fhir.doseAndRate?.some((entry) => {
      const range = entry.doseRange;
      return range?.low?.value === expected[0] &&
        range.high?.value === expected[1] &&
        (expected[2] === null || (range.low?.unit === expected[2] && range.high?.unit === expected[2]));
    })
  );
}

function field(result: ParseBatchResult, kind: "route" | "site" | "method", expected: string): boolean {
  const needle = expected.toLowerCase();
  return items(result).some((item) => {
    const concept = kind === "route" ? item.fhir.route : kind === "site" ? item.fhir.site : item.fhir.method;
    const texts = [
      concept?.text,
      ...(concept?.coding ?? []).flatMap((coding) => [
        coding.display,
        ...Object.values(coding.i18n ?? {})
      ])
    ].filter((text): text is string => Boolean(text));
    return texts.some((text) => text.toLowerCase().includes(needle));
  });
}

function hasSiteCode(result: ParseBatchResult, code: string): boolean {
  return items(result).some((item) =>
    item.fhir.site?.coding?.some((coding) => coding.code === code) ?? false
  );
}

function timing(result: ParseBatchResult, expected: string): boolean {
  return items(result).some((item) => item.fhir.timing?.code?.text === expected);
}

describe("50-case real-world medication instruction torture corpus", () => {
  for (const value of cases as TortureCase[]) {
    it(value.name, () => {
      const result = parseSig(value.input, { locale: value.locale });
      expect(result.count).toBeGreaterThan(0);
      expect(result.longText.trim().length).toBeGreaterThan(0);
      if (value.dose) expect(hasDose(result, value.dose), "expected dose").toBe(true);
      if (value.doseRange) expect(hasRange(result, value.doseRange), "expected dose range").toBe(true);
      if (value.route) expect(field(result, "route", value.route), "expected route").toBe(true);
      if (value.site) expect(field(result, "site", value.site), "expected site").toBe(true);
      if (value.siteCode) expect(hasSiteCode(result, value.siteCode), "expected site code").toBe(true);
      if (value.method) expect(field(result, "method", value.method), "expected method").toBe(true);
      if (value.timing) expect(timing(result, value.timing), "expected timing").toBe(true);
      const parsedActions = actions(result);
      for (const action of value.actions ?? []) {
        expect(parsedActions, `expected action ${action}`).toContain(action);
      }
      if (value.forbiddenDose) expect(hasDose(result, value.forbiddenDose), "forbidden dose").toBe(false);
      if (value.forbiddenRoute) expect(field(result, "route", value.forbiddenRoute), "forbidden route").toBe(false);
    });
  }
});
