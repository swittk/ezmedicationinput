import { describe, expect, it } from "vitest";
import { parseSig } from "../src/index";
import type { AdviceFrame, ParseOptions } from "../src/types";

type Result = ReturnType<typeof parseSig>;

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length < 2) return [Array.from(values)];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((tail) => [value, ...tail])
  );
}

function permutationSurfaces(parts: readonly string[]): string[] {
  return permutations(parts).map((parts) => parts.join(" "));
}

function codeable(concept: any): string | undefined {
  const coding = concept?.coding?.[0];
  if (coding?.code) return `${coding.system ?? ""}|${coding.code}`;
  return concept?.text?.toLowerCase();
}

function quantity(value: any): unknown {
  return value ? { value: value.value, unit: value.unit } : undefined;
}

function canonicalFingerprint(result: Result): unknown {
  const repeat = result.fhir.timing?.repeat;
  const dose = result.fhir.doseAndRate?.[0];
  return {
    count: result.count,
    method: codeable(result.fhir.method),
    route: codeable(result.fhir.route),
    site: codeable(result.fhir.site),
    dose: dose?.doseQuantity
      ? { quantity: quantity(dose.doseQuantity) }
      : dose?.doseRange
        ? { range: { low: quantity(dose.doseRange.low), high: quantity(dose.doseRange.high) } }
        : undefined,
    timing: repeat ? {
      frequency: repeat.frequency,
      frequencyMax: repeat.frequencyMax,
      period: repeat.period,
      periodMax: repeat.periodMax,
      periodUnit: repeat.periodUnit,
      when: [...(repeat.when ?? [])].sort(),
      dayOfWeek: [...(repeat.dayOfWeek ?? [])].sort(),
      timeOfDay: [...(repeat.timeOfDay ?? [])].sort()
    } : undefined,
    prn: result.fhir.asNeededBoolean === true,
    reasons: [...(result.fhir.asNeededFor ?? [])].map(codeable).sort(),
    leftover: result.meta.leftoverText
  };
}

function action(result: Result, predicate: string): AdviceFrame | undefined {
  return result.meta.canonical.clauses
    .flatMap((clause) => clause.instructionGraph?.actions ?? [])
    .find((frame) => frame.predicate.lemma === predicate);
}

function semanticArgument(frame: AdviceFrame | undefined, role: string): unknown {
  const arg = frame?.args.find((candidate) => candidate.role === role);
  if (!arg) return undefined;
  return {
    role: arg.role,
    coding: arg.coding?.code ? `${arg.coding.system ?? ""}|${arg.coding.code}` : arg.conceptId,
    normalized: arg.coding?.code || arg.conceptId ? undefined : arg.normalized ?? arg.text
  };
}

function warningFingerprint(result: Result): unknown {
  const frame = action(result, "take");
  const graph = result.meta.canonical.clauses[0]?.instructionGraph;
  return {
    predicate: frame?.predicate.lemma,
    polarity: frame?.polarity,
    modality: frame?.modality,
    relation: frame?.relation,
    activity: semanticArgument(frame, "activity"),
    opaque: graph?.opaqueSpans?.length ?? 0,
    complete: graph?.coverage?.complete
  };
}

function procedureFingerprint(result: Result): unknown {
  const frame = action(result, "wash");
  return {
    globalMethod: codeable(result.fhir.method),
    globalSite: codeable(result.fhir.site),
    predicate: frame?.predicate.lemma,
    relation: frame?.relation,
    site: semanticArgument(frame, "site"),
    activity: semanticArgument(frame, "activity")
  };
}

function parseAll(surfaces: readonly string[], options?: ParseOptions): Result[] {
  return surfaces.map((value) => parseSig(value, options));
}

function expectCanonicalInvariant(results: readonly Result[]): void {
  const expected = canonicalFingerprint(results[0]);
  for (const result of results.slice(1)) expect(canonicalFingerprint(result)).toEqual(expected);
}

describe("HPSG permutation invariance", () => {
  it("keeps every site/schedule ordering invariant around an Apply head", () => {
    const variants = permutationSurfaces(["apply", "to lesion", "twice daily"]);
    expect(variants).toHaveLength(6);
    expectCanonicalInvariant(parseAll(variants));
  });

  it("keeps every event-timing/site ordering invariant around an Instill head", () => {
    const variants = permutationSurfaces(["instill", "right eye", "at bedtime"]);
    expect(variants).toHaveLength(6);
    expectCanonicalInvariant(parseAll(variants));
  });

  it("keeps all 24 head/dose/schedule/PRN orders invariant", () => {
    const variants = permutationSurfaces([
      "take", "1 tab", "every 6 hours", "as needed for pain"
    ]);
    expect(variants).toHaveLength(24);
    expectCanonicalInvariant(parseAll(variants, { context: { dosageForm: "tablet" } }));
  });

  it("keeps all 24 code-switched ocular head/site/dose/qHS orders invariant", () => {
    const variants = permutationSurfaces(["หยอด", "OU", "1 drop", "qhs"]);
    expect(variants).toHaveLength(24);
    expectCanonicalInvariant(parseAll(variants, { locale: "th" }));
  });

  it("keeps every plain Thai prohibition/BEFORE order invariant", () => {
    const surfaces = permutationSurfaces(["ห้ามรับประทาน", "ก่อนว่ายน้ำ"]);
    expect(surfaces).toHaveLength(2);
    const variants = parseAll(surfaces, { locale: "th" });
    expect(warningFingerprint(variants[1])).toEqual(warningFingerprint(variants[0]));
    expect(warningFingerprint(variants[0])).toMatchObject({
      predicate: "take",
      polarity: "negate",
      relation: "before",
      activity: { role: "activity", normalized: "ว่ายน้ำ" },
      opaque: 0,
      complete: true
    });
  });

  it("keeps every procedure-local WASH/AFTER-use order invariant", () => {
    const surfaces = permutationSurfaces(["wash hands", "after use"]);
    expect(surfaces).toHaveLength(2);
    const variants = parseAll(surfaces);
    expect(procedureFingerprint(variants[1])).toEqual(procedureFingerprint(variants[0]));
    expect(procedureFingerprint(variants[0])).toMatchObject({
      globalMethod: undefined,
      globalSite: undefined,
      predicate: "wash",
      relation: "after",
      activity: { role: "activity" }
    });
  });

  it("keeps all 24 clinician Thai modal/timing/PRN/dose orders invariant", () => {
    const surfaces = permutationSurfaces([
      "ควรกิน", "ก่อนอาหารเย็น", "เมื่อมีอาการ", "วันละ 1 เม็ด"
    ]);
    expect(surfaces).toHaveLength(24);
    const variants = parseAll(surfaces, { locale: "th" });
    expectCanonicalInvariant(variants);
    for (const result of variants) {
      const take = action(result, "take");
      expect(take).toMatchObject({ modality: "should" });
      expect(result.fhir.timing?.repeat?.when).toEqual(["ACV"]);
      expect(result.meta.canonical.clauses[0]?.instructionGraph?.coverage?.complete).toBe(true);
    }
    const original = parseSig(
      "ควรกินก่อนอาหารเย็นเมื่อมีอาการ วันละ 1 เม็ด",
      { locale: "th" }
    );
    const take = action(original, "take");
    expect(take).toMatchObject({ modality: "should", relation: "before" });
    expect(take?.args.find((arg) => arg.role === "time")?.normalized).toBe("CV");
    expect(original.longText).toBe(
      "ควรรับประทานครั้งละ 1 เม็ด วันละครั้ง ก่อนอาหารเย็น ใช้เมื่อมีอาการ."
    );
  });

  it("does not collapse genuinely sequence-changing permutations", () => {
    const forward = parseSig("wash hands then wait 5 minutes");
    const reverse = parseSig("wait 5 minutes then wash hands");
    const order = (result: Result) => result.meta.canonical.clauses
      .flatMap((clause) => clause.instructionGraph?.actions ?? [])
      .map((frame) => frame.predicate.lemma);
    expect(order(forward)).toEqual(["wash", "wait"]);
    expect(order(reverse)).toEqual(["wait", "wash"]);
    expect(order(forward)).not.toEqual(order(reverse));
  });
});
