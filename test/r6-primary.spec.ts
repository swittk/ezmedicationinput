import { equalStructuredValues } from "../src/stable-structure";
import { describe, expect, it } from "vitest";
import {
  parseSig, parseSigAsync, fromFhir, formatSig, nextDueDoses,
  toDosageDetails, toFhirR5Dosages, toEzDosages, fromDosageDetails,
  evaluateMedicationCondition,
  type FhirR6DosageDetails
} from "../src/index";
import { canonicalFromFhir, parserStateFromFhir } from "../src/fhir";

describe("EZMED extended R5 dosage and R6 projection", () => {
  it("returns flat extended R5-ish dosages and a separate native R6 course", () => {
    const result = parseSig("1 tab po bid");
    expect(result.fhir).toHaveLength(1);
    expect(result.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({value:1,unit:"tab"});
    expect(result.fhirNext).toMatchObject({
      renderedInstruction: "1 tab po bid",
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }] }]
    });
    expect(result.fhirNext.step[0].component[0]).not.toHaveProperty("sequence");
    expect(result.fhirNext.step[0].component[0]).not.toHaveProperty("asNeededBoolean");
  });

  it("distinguishes sequential taper stages from concurrent components", () => {
    const result = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk");
    expect(result.fhirNext.step.map(step => step.component.length)).toEqual([1, 1, 1]);
    expect(result.fhirNext.step[0].component[0].site?.concept?.text).toBe("right eye");
    const r5 = toFhirR5Dosages(result.fhirNext);
    expect(r5.map(dosage => dosage.sequence)).toEqual([1, 2, 3]);
    expect(toDosageDetails(r5)).toEqual(result.fhirNext);
  });

  it("imports R6 as structured data rather than reparsing generated text", () => {
    const original = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk").fhirNext;
    const imported = fromFhir(JSON.parse(JSON.stringify(original)));
    expect(imported.fhirNext).toEqual(original);
    expect(imported.fhir.map(v => v.sequence)).toEqual([1, 2, 3]);
    expect(imported.count).toBe(3);
    expect(formatSig(imported.fhirNext)).toBe(original.renderedInstruction);
  });

  it("retains R6 conditional semantics and R5 modifier bridge", () => {
    const result = parseSig("Take 1 tablet BID only if BP >160, otherwise hold");
    expect(result.fhirNext.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt", valueQuantity: { value: 160 }
    });
    const r5 = toFhirR5Dosages(result.fhirNext);
    expect(r5).toHaveLength(1);
    expect(r5[0].modifierExtension?.length).toBeGreaterThan(0);
    expect(toDosageDetails(r5)).toEqual(result.fhirNext);
    const options = {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    };
    expect(nextDueDoses(result, options)).toEqual([
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T20:00:00+07:00"
    ]);
    expect(nextDueDoses(result, {
      ...options,
      evaluateCondition: condition => evaluateMedicationCondition(condition, { bp: 160 })
    })).toEqual([]);
  });

  it("uses the same full-course scheduler for R6 and R5 conversions", () => {
    const result = parseSig("1 drop OD q2h x1wk then qid x1wk then bid x1wk");
    const options = {
      from: "2026-11-02T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 2
    };
    const nextR6 = nextDueDoses(result, options);
    expect(nextR6).toEqual([
      "2026-11-02T08:00:00+07:00",
      "2026-11-02T20:00:00+07:00"
    ]);
    // A caller that understands the local R5 course modifier can schedule
    // this finite taper with the same semantics as native R6.
    expect(nextDueDoses(toFhirR5Dosages(result.fhirNext), options)).toEqual(nextR6);
  });

  it("preserves and best-effort schedules an R6 whole-course repeat cycle", () => {
    const base = parseSig("1 tab daily").fhirNext;
    const course = { ...base, repeatCycle: { value: 28, unit: "d" } };
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
    expect(nextDueDoses(course, {
      from: "2026-10-19T08:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 4
    })).toEqual([
      "2026-10-19T09:00:00+07:00",
      "2026-10-20T09:00:00+07:00",
      "2026-10-21T09:00:00+07:00",
      "2026-10-22T09:00:00+07:00"
    ]);
  });

  it("recovers retained R6 meaning while preserving malformed and conflicting provenance", () => {
    const expected = parseSig(
      "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid"
    ).fhirNext;
    const semantics = (course: FhirR6DosageDetails) => course.step.map(step => ({
      start: step.start?.offsetDuration,
      end: step.end?.offsetDuration,
      component: step.component.map(component => ({
        site: component.site?.concept?.text,
        timingCode: component.timing?.code?.text,
        dose: component.doseAndRate?.[0]?.doseQuantity
      }))
    }));
    const r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(expected))) as
      ReturnType<typeof toFhirR5Dosages>;
    expect(r5).toHaveLength(6);
    const first = r5[0].modifierExtension?.find(ext => ext.url.includes("course-details"));
    first!.extension![0].valueString = "{bad";
    const recovered = toDosageDetails(r5);
    expect(recovered.renderedInstruction).toBe(expected.renderedInstruction);
    expect(semantics(recovered)).toEqual(semantics(expected));
    expect(recovered.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("Malformed retained R6 course metadata")
    }));
    const recoveredSources = recovered.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")
    ) ?? [];
    expect(recoveredSources).toHaveLength(2);
    expect(recoveredSources.some(extension => extension.extension?.[0].extension?.[0].valueString === "{bad")).toBe(true);

    const conflicting = JSON.parse(JSON.stringify(toFhirR5Dosages(expected))) as
      ReturnType<typeof toFhirR5Dosages>;
    const second = conflicting[1].modifierExtension?.find(ext => ext.url.includes("course-details"));
    const structured = second!.extension!.find(child => child.url === "dosageDetails")!;
    const firstStep = structured.extension!.find(child => child.url === "step")!;
    const end = firstStep.extension!.find(child => child.url === "end")!;
    end.extension!.find(child => child.url === "offsetDuration")!.valueQuantity!.value = 8;
    const reconciled = toDosageDetails(conflicting);
    expect(semantics(reconciled)).toEqual(semantics(expected));
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-course-reconciliation-warning"),
      valueString: expect.stringContaining("snapshots differ")
    }));
    const conflictingSources = reconciled.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")
    ) ?? [];
    expect(conflictingSources).toHaveLength(2);
    expect(equalStructuredValues(conflictingSources[0], conflictingSources[1])).toBe(false);
    expect(conflictingSources.every(extension => extension.extension?.length && extension.valueString === undefined)).toBe(true);
  });

  it("keeps optional real R6 semantics on normal EZMED dosages", () => {
    const course: FhirR6DosageDetails = {
      renderedInstruction: "Dose guided by weight",
      step: [{
        component: [{
          condition: [{ code: { text: "Only if tolerated" }, text: "Only if tolerated" }],
          safety: { doseLimit: [{
            scope: "administration", valueQuantity: { value: 5, unit: "mg" }
          }] },
          doseAndRate: [{
            doseExpression: { language: "text/fhirpath", expression: "%patient.weight * 0.5" }
          }],
          site: { reference: { reference: "BodyStructure/123" } }
        }]
      }]
    };
    const imported = fromDosageDetails(course);
    expect(imported.dosages).toMatchObject([{
      condition: [{ text: "Only if tolerated" }],
      safety: { doseLimit: [{ scope: "administration" }] },
      doseAndRate: [{
        doseExpression: { expression: "%patient.weight * 0.5" }
      }],
      siteReference: { reference: "BodyStructure/123" }
    }]);
    expect(toDosageDetails(imported.dosages, undefined, imported.course)).toEqual(course);
    const r5 = toFhirR5Dosages(imported.dosages, imported.course);
    expect(r5[0]).not.toHaveProperty("condition");
    expect(r5[0]).not.toHaveProperty("safety");
    expect(r5[0]).not.toHaveProperty("siteReference");
    expect(r5[0].doseAndRate?.[0]).not.toHaveProperty("doseExpression");
    expect(toDosageDetails(r5)).toEqual(course);
  });

  it("lifts missing R5 safety independently of existing R6 site metadata", () => {
    const input = {
      siteReference: { reference: "BodyStructure/example" },
      maxDosePerAdministration: { value: 2, unit: "tab" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const lifted = toEzDosages([input])[0];
    expect(lifted.siteReference).toEqual(input.siteReference);
    expect(lifted.safety?.doseLimit?.[0]).toMatchObject({
      scope: "administration", valueQuantity: { value: 2, unit: "tab" }
    });
  });

  it("retains R6-only approximate safety without illegally lowering it to R5 SimpleQuantity", () => {
    const original: FhirR6DosageDetails = {
      renderedInstruction: "Maximum is approximate and requires review",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }],
        safety: { doseLimit: [
          { scope: "administration", valueQuantity: {
            value: 5, unit: "mg", comparator: "~"
          }},
          { scope: "period", valueQuantity: {
            value: 15, unit: "mg", comparator: "ad"
          }, period: { value: 1, unit: "d" } }
        ] }
      }] }]
    };
    const r5 = toFhirR5Dosages(original);
    expect(r5).toHaveLength(1);
    expect(r5[0].maxDosePerAdministration).toBeUndefined();
    expect(r5[0].maxDosePerPeriod?.[0]?.numerator.comparator).toBe("ad");
    expect(toDosageDetails(r5)).toEqual(original);
    // R5 representation retains non-representable R6 semantics as a
    // modifier, not as falsely precise maxima.
    expect(r5[0].modifierExtension).toContainEqual(expect.objectContaining({
      url: expect.stringContaining("medication-r6-course-details")
    }));
  });

  it("composes independent site tapers into concurrent, bounded global steps", () => {
    const input = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhir.map(dose => dose.sequence)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2, 2]);
    expect(parsed.fhirNext.step[0].end?.offsetDuration?.value).toBe(7);
    expect(parsed.fhirNext.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(nextDueDoses(parsed, {
      from: "2026-11-19T12:00:00+07:00",
      orderedAt: "2026-10-19T08:00:00+07:00",
      timeZone: "Asia/Bangkok",
      limit: 4
    })).toEqual([
      "2026-11-19T12:00:00+07:00", "2026-11-19T16:00:00+07:00",
      "2026-11-19T20:00:00+07:00", "2026-11-19T20:00:00+07:00"
    ]);
  });

  it("has the same R6 result shape through the asynchronous entry point", async () => {
    const a = parseSig("1 drop OS qid");
    const b = await parseSigAsync("1 drop OS qid");
    expect(b.fhir).toEqual(a.fhir);
    expect(b.fhirNext).toEqual(a.fhirNext);
  });
});

const timingFamilyOptions = {
  from: "2026-10-21T00:00:00+07:00",
  orderedAt: "2026-10-21T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8
};

describe("FHIR R5 Timing invariant and clinical scheduling safety", () => {
  it("preserves event timing and exact clocks together for clinician review", () => {
    const text = "1 tab po before breakfast and at 08:00";
    const parsed = parseSig(text);
    const repeat = parsed.fhir[0].timing?.repeat;
    expect(repeat?.when).toEqual(["ACM"]);
    expect(repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.warnings).toEqual([]);
    expect(nextDueDoses(parsed.fhir, timingFamilyOptions).length).toBeGreaterThan(0);
  });

  it("keeps a daily cadence plus two explicit clocks instead of erasing timing", () => {
    const text = "1 tab po daily at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d",
      timeOfDay: ["08:00:00", "20:00:00"]
    });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
  });

  it("permits two explicit BID clocks without inventing an extra dose", () => {
    const text = "1 tab po BID at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.warnings.some(w => w.includes("frequency-clock-count-conflict")))
      .toBe(false);
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay)
      .toEqual(["08:00:00", "20:00:00"]);
    expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(2);
  });

  it("identifies standard HL7 timing abbreviations with the official coding system", () => {
    const parsed = parseSig("1 tab po BID");
    expect(parsed.fhir[0].timing?.code?.coding?.[0]).toMatchObject({
      system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
      code: "BID"
    });
  });

  it("round-trips local text-only Q12H without inventing a coded terminology identity", () => {
    const dosage = parseSig("1 tab PO Q12H").fhir[0];
    expect(dosage.timing?.code?.coding).toBeUndefined();
    expect(canonicalFromFhir(dosage).schedule?.timingCode).toBe("Q12H");
    expect(parserStateFromFhir(dosage).timingCode).toBe("Q12H");
  });

  it("does not promote arbitrary FHIR timing prose to a lexical timing code", () => {
    const dosage = { timing: { code: { text: "before breakfast when awake" } } };
    expect(canonicalFromFhir(dosage).schedule?.timingCode).toBeUndefined();
    expect(parserStateFromFhir(dosage).timingCode).toBeUndefined();
  });

  it("does not misrepresent local Q12H as a standard GTS abbreviation", () => {
    const parsed = parseSig("1 tab po Q12H");
    const code = parsed.fhir[0].timing?.code;
    expect(code?.coding?.some(entry =>
      entry.system === "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation")).not.toBe(true);
    expect(code?.text).toBe("Q12H");
  });
});
