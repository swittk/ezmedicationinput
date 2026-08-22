import { describe, expect, it } from "vitest";
import { parseSig } from "../src/index";
import type { AdviceFrame, ParseOptions } from "../src/types";

type Result = ReturnType<typeof parseSig>;

type PartMap = Readonly<Record<string, string>>;

function surface(parts: PartMap, order: readonly string[], commaAfter?: string): string {
  return order.map((name) => `${parts[name]}${name === commaAfter ? "," : ""}`).join(" ");
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
  it("keeps site and schedule adjuncts invariant around an Apply head", () => {
    const parts = { head: "apply", schedule: "twice daily", site: "to lesion" };
    const variants = [
      surface(parts, ["head", "schedule", "site"]),
      surface(parts, ["head", "site", "schedule"]),
      surface(parts, ["schedule", "head", "site"])
    ];
    expectCanonicalInvariant(parseAll(variants));
  });

  it("keeps event timing and site invariant around an Instill head", () => {
    const variants = [
      "instill right eye at bedtime",
      "at bedtime instill right eye",
      "instill at bedtime in right eye"
    ];
    expectCanonicalInvariant(parseAll(variants));
  });

  it("keeps trailing, fronted, and infixed PRN adjuncts invariant", () => {
    const parts = { head: "take", dose: "1 tab", schedule: "every 6 hours", prn: "as needed for pain" };
    const variants = [
      surface(parts, ["head", "dose", "schedule", "prn"]),
      surface(parts, ["prn", "head", "dose", "schedule"], "prn"),
      surface(parts, ["head", "prn", "dose", "schedule"])
    ];
    expectCanonicalInvariant(parseAll(variants, { context: { dosageForm: "tablet" } }));
  });

  it("keeps code-switched site, dose, and qHS adjuncts invariant", () => {
    const variants = [
      "หยอด OU 1 drop qhs",
      "qhs หยอด OU 1 drop",
      "หยอด 1 drop OU qhs"
    ];
    expectCanonicalInvariant(parseAll(variants, { locale: "th" }));
  });

  it("keeps a plain Thai prohibition invariant when BEFORE moves", () => {
    const variants = parseAll([
      "ห้ามรับประทานก่อนว่ายน้ำ",
      "ก่อนว่ายน้ำห้ามรับประทาน"
    ], { locale: "th" });
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

  it("keeps procedure-local AFTER-use scope invariant when the adjunct moves", () => {
    const variants = parseAll([
      "wash hands after use",
      "after use wash hands"
    ]);
    expect(procedureFingerprint(variants[1])).toEqual(procedureFingerprint(variants[0]));
    expect(procedureFingerprint(variants[0])).toMatchObject({
      globalMethod: undefined,
      globalSite: undefined,
      predicate: "wash",
      relation: "after",
      activity: { role: "activity" }
    });
  });

  it("keeps the clinician Thai dose/schedule/PRN semantics invariant across licensed orders", () => {
    const variants = parseAll([
      "ควรกินก่อนอาหารเย็นเมื่อมีอาการ วันละ 1 เม็ด",
      "วันละ 1 เม็ด ควรกินก่อนอาหารเย็นเมื่อมีอาการ",
      "เมื่อมีอาการ ควรกินก่อนอาหารเย็น วันละ 1 เม็ด",
      "ควรกินวันละ 1 เม็ด ก่อนอาหารเย็นเมื่อมีอาการ"
    ], { locale: "th" });
    expectCanonicalInvariant(variants);
    for (const result of variants) {
      const take = action(result, "take");
      expect(take).toMatchObject({ modality: "should", relation: "before" });
      expect(result.meta.canonical.clauses[0]?.instructionGraph?.coverage?.complete).toBe(true);
    }
  });

  it("does not collapse genuinely sequence-changing permutations", () => {
    const forward = parseSig("wash hands then wait 5 minutes");
    const reverse = parseSig("wait 5 minutes then wash hands");
    const order = (result: Result) => result.meta.canonical.clauses
      .flatMap((clause) => clause.instructionGraph?.actions ?? [])
      .map((frame) => frame.predicate.lemma);
    expect(order(forward)).not.toEqual(order(reverse));
  });
});
