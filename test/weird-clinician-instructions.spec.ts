import { describe, expect, it } from "vitest";
import cases from "./weird-clinician-cases.json";
import {
  TIMING_FREQUENCY_MIN_EXTENSION_URL,
  formatSig,
  fromFhirDosage,
  parseSig,
  AdviceArgumentRole,
  type AdviceFrame,
  type ParseBatchResult
} from "../src/index";

interface WeirdCase {
  name: string;
  input: string;
  locale?: string;
  method?: string;
  route?: string;
  siteCode?: string;
  frequency?: number;
  frequencyMax?: number;
  when?: string[];
  noPrn?: boolean;
  prnReason?: string;
  warningContains?: string;
  actions?: string[];
  durationRange?: [number, number];
  forbidDose?: boolean;
  noLeftover?: boolean;
}

function primaryClause(result: ParseBatchResult) {
  return result.meta.canonical.clauses[0];
}

function graphActions(result: ParseBatchResult): AdviceFrame[] {
  return result.meta.canonical.clauses.reduce<AdviceFrame[]>((all, clause) => {
    all.push(...(clause.instructionGraph?.actions ?? []));
    return all;
  }, []);
}

function conceptContains(
  result: ParseBatchResult,
  kind: "method" | "route",
  expected: string
): boolean {
  const needle = expected.toLowerCase();
  return result.items.some((item) => {
    const concept = kind === "method" ? item.fhir.method : item.fhir.route;
    return [concept?.text, ...(concept?.coding ?? []).map((coding) => coding.display)]
      .filter((text): text is string => Boolean(text))
      .some((text) => text.toLowerCase().includes(needle));
  });
}

function hasSiteCode(result: ParseBatchResult, code: string): boolean {
  return result.items.some((item) =>
    item.fhir.site?.coding?.some((coding) => coding.code === code) ?? false
  );
}

function additionalText(result: ParseBatchResult): string {
  return result.items
    .flatMap((item) => item.fhir.additionalInstruction?.map((instruction) => instruction.text ?? "") ?? [])
    .join(" | ");
}

function prnText(result: ParseBatchResult): string {
  return result.items
    .flatMap((item) => item.fhir.asNeededFor?.map((reason) => reason.text ?? "") ?? [])
    .join(" | ");
}

function hasDurationRange(result: ParseBatchResult, low: number, high: number): boolean {
  return graphActions(result).some((action) =>
    action.args.some((arg) =>
      arg.role === AdviceArgumentRole.Duration &&
      arg.quantity?.range?.low === low &&
      arg.quantity?.range?.high === high
    )
  );
}

describe("weird TH/EN clinician instructions", () => {
  for (const value of cases as WeirdCase[]) {
    it(value.name, () => {
      const result = parseSig(value.input, { locale: value.locale });
      const clause = primaryClause(result);
      expect(result.count).toBeGreaterThan(0);
      expect(result.longText.trim().length).toBeGreaterThan(0);

      if (value.method) expect(conceptContains(result, "method", value.method), "expected method").toBe(true);
      if (value.route) expect(conceptContains(result, "route", value.route), "expected route").toBe(true);
      if (value.siteCode) expect(hasSiteCode(result, value.siteCode), "expected site code").toBe(true);
      if (value.frequency !== undefined) expect(clause?.schedule?.frequency, "frequency").toBe(value.frequency);
      if (value.frequencyMax !== undefined) expect(clause?.schedule?.frequencyMax, "frequencyMax").toBe(value.frequencyMax);
      if (value.when) expect(clause?.schedule?.when, "event timing").toEqual(value.when);
      if (value.noPrn) expect(result.fhir.asNeededBoolean, "must not become PRN").not.toBe(true);
      if (value.prnReason) expect(prnText(result).toLowerCase(), "PRN reason").toContain(value.prnReason.toLowerCase());
      if (value.warningContains) expect(additionalText(result).toLowerCase(), "warning text").toContain(value.warningContains.toLowerCase());
      if (value.forbidDose) expect(result.fhir.doseAndRate, "frequency range must not become a dose").toBeUndefined();
      if (value.noLeftover) expect((result.meta.leftoverText ?? "").trim(), "unexpected leftovers").toBe("");

      const actions = graphActions(result).map((action) => action.predicate.lemma);
      for (const expected of value.actions ?? []) {
        expect(actions, `expected action ${expected}`).toContain(expected);
      }
      if (value.durationRange) {
        expect(hasDurationRange(result, value.durationRange[0], value.durationRange[1]), "duration range").toBe(true);
      }
    });
  }


  it("preserves the explicit zero lower frequency bound through FHIR", () => {
    const parsed = parseSig(
      "หยอดตาทั้งสองข้าง วันละ 0-2 ครั้ง ปรับตามช่วงที่มีอาการคันตา",
      { locale: "th" }
    );
    const repeat = parsed.fhir.timing?.repeat;
    expect(repeat?.frequency).toBeUndefined();
    expect(repeat?.frequencyMax).toBe(2);
    expect(repeat?.extension?.find((extension) =>
      extension.url === TIMING_FREQUENCY_MIN_EXTENSION_URL
    )?.valueInteger).toBe(0);

    const dosage = JSON.parse(JSON.stringify(parsed.fhir));
    const restored = fromFhirDosage(dosage, { locale: "th" });
    expect(restored.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 0,
      frequencyMax: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(formatSig(dosage, "long", { locale: "th" })).toContain("0 ถึง 2");
  });

  it("keeps safety conditions separate from PRN across FHIR round-trip", () => {
    const parsed = parseSig(
      "หยอดสองตาวันละครั้งก่อนนอน หากมีอาการเคืองตาควรปรึกษาแพทย์",
      { locale: "th" }
    );
    expect(parsed.fhir.asNeededBoolean).not.toBe(true);
    expect(parsed.fhir.additionalInstruction?.map((item) => item.text)).toContain(
      "หากมีอาการเคืองตาควรปรึกษาแพทย์"
    );
    const restored = fromFhirDosage(JSON.parse(JSON.stringify(parsed.fhir)), { locale: "th" });
    expect(restored.fhir.asNeededBoolean).not.toBe(true);
    expect(restored.longText).toContain("ปรึกษาแพทย์");
  });
});
