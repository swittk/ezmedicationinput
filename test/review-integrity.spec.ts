import { describe, expect, it } from "vitest";
import {
  parseSig, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages,
  calculateTotalUnits, nextDueDoses, formatSig,
  type FhirDosage, type FhirR6DosageDetails
} from "../src";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_CONDITION_R6_LOGIC_URL,
  DOSAGE_DETAILS_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_RENDERED_INSTRUCTION_R5_URL
} from "../src/dosage-course";
import { recognizeCycles } from "../src/regimen/cycles";
import { projectParallelRegimen } from "../src/regimen/parallel-course";
import type { BoundaryPlan } from "../src/regimen/types";
import type { HpsgSigSegment } from "../src/hpsg/segmenter";

const beginning = "2026-10-19T08:00:00+07:00";
const scheduler = {
  from: beginning, orderedAt: beginning, timeZone: "Asia/Bangkok", limit: 14
};
const supply = {
  ...scheduler, durationValue: 30, durationUnit: "d" as const
};
const parallel = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";

describe("external review: FHIR R5/R6 and medication correctness", () => {
  it("does not mark ordinary R5 SIGs with an R6 modifier merely to carry raw text", () => {
    const details = parseSig("1 tab PO BID").fhirNext;
    const strict = toFhirR5Dosages(details);
    expect(strict).toHaveLength(1);
    expect(strict[0].modifierExtension?.some(ext => ext.url === DOSAGE_DETAILS_R5_URL)).not.toBe(true);
    const displayExtension = strict[0].extension?.find(ext =>
      ext.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    expect(displayExtension?.extension?.find(child =>
      child.url === "instruction")?.valueString).toBe(details.renderedInstruction);
    expect(JSON.parse(displayExtension?.extension?.find(child =>
      child.url === "projection")?.valueString ?? "null")).toHaveLength(1);
    expect(toDosageDetails(strict)).toEqual(details);
  });

  it("never uses an outdated literal instruction after editing a strict R5 dose", () => {
    const details = parseSig("1 tab PO BID").fhirNext;
    const original = toFhirR5Dosages(details);
    const untouched = toDosageDetails(JSON.parse(JSON.stringify(original)));
    expect(untouched.renderedInstruction).toBe(details.renderedInstruction);

    const edited = JSON.parse(JSON.stringify(original)) as FhirDosage[];
    const previousText = edited[0].text;
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    // A structured dosage editor need not regenerate free text itself.
    expect(edited[0].text).toBe(previousText);
    const transformed = toDosageDetails(edited);
    expect(transformed.renderedInstruction).not.toBe(details.renderedInstruction);
    expect(transformed.step[0].component[0].text).not.toBe(previousText);
    expect(transformed.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    const reExported = toFhirR5Dosages(transformed);
    expect(reExported[0].extension?.some(value =>
      value.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)).not.toBe(true);
    expect(calculateTotalUnits({ ...supply, dosage: transformed }).totalUnits).toBe(120);

    edited[0].text = "2 tablets orally twice daily";
    const withUpdatedText = toDosageDetails(edited);
    expect(withUpdatedText.renderedInstruction).toBe("2 tablets orally twice daily");
    expect(withUpdatedText.step[0].component[0].text).toBe(edited[0].text);
  });

  it("preserves both R5 and R6 conditional extension contracts without reusing their URLs", () => {
    const details = parseSig("1 tab PO BID only if BP >160, otherwise hold").fhirNext;
    const condition = details.step[0].component[0].condition?.[0];
    expect(condition).toBeDefined();
    expect(condition?.extension?.[0].url).toBe(DOSAGE_CONDITION_R6_LOGIC_URL);
    expect(condition?.extension?.[0].extension?.[0].url).toBe("predicate");
    expect(condition?.extension?.[0].extension?.[0].valueString).toContain('"kind"');
    expect(condition?.extension?.some(ext => ext.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
    const strict = toFhirR5Dosages(details);
    expect(strict[0].modifierExtension?.some(ext => ext.url === DOSAGE_CONDITION_R5_URL)).toBe(true);
    expect(toDosageDetails(strict)).toEqual(details);
  });

  it("encodes edited direct excludedDates even without an original modifier", () => {
    const dosage: FhirDosage & { excludedDates?: string[] } = {
      ...parseSig("1 tab PO BID").fhir[0],
      excludedDates: ["2026-10-20"]
    };
    const r6 = toDosageDetails([dosage]);
    const modifiers = r6.step[0].component[0].modifierExtension;
    expect(modifiers?.some(ext => ext.url === DOSAGE_EXCLUDED_DATES_R5_URL)).toBe(true);
    const strict = toFhirR5Dosages(r6);
    expect(strict[0].modifierExtension?.some(ext => ext.url === DOSAGE_EXCLUDED_DATES_R5_URL)).toBe(true);
    const times = nextDueDoses(r6, { ...scheduler, limit: 10 });
    expect(times.every(time => !time.startsWith("2026-10-20"))).toBe(true);
    expect(times.some(time => time.startsWith("2026-10-21"))).toBe(true);
  });

  it("executes live dosage edits rather than a stale saved R6 snapshot", () => {
    const original = parseSig(parallel);
    const edited = JSON.parse(JSON.stringify(original.fhir)) as FhirDosage[];
    const initial = calculateTotalUnits({ ...supply, dosage: edited });
    expect(initial.totalUnits).toBe(296);
    edited[3].timing!.repeat!.frequency = 3;
    edited[3].text = "1 drop OS TID after day 7";
    const updated = toDosageDetails(edited);
    expect(updated.step[1].component[1].timing?.repeat?.frequency).toBe(3);
    expect(updated.step[0].end?.offsetDuration?.value).toBe(7);
    expect(updated.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(updated.renderedInstruction).toContain("TID after day 7");
    const count = calculateTotalUnits({ ...supply, dosage: edited });
    expect(count.totalUnits).toBe(319);
    expect(count.totalUnits).not.toBe(initial.totalUnits);
    const times = nextDueDoses(edited, { ...scheduler, from: "2026-10-27T08:00:00+07:00" });
    expect(times.length).toBeGreaterThan(0);
    expect(updated.step[1].component[1].text).toContain("TID");
  });

  it("retains clinician wording when R5 validators only add canonical coding metadata or empty defaults", () => {
    const parsed = parseSig(parallel);
    const saved = JSON.parse(JSON.stringify(parsed.fhir)) as FhirDosage[];
    for (const dose of saved) {
      dose.additionalInstruction = [];
      dose.timing!.event = [];
      dose.timing!.repeat!.timeOfDay = [];
      const coding = dose.route?.coding?.[0];
      if (coding) coding.version = "2023";
      const scheduleCode = dose.timing!.code?.coding?.[0];
      if (scheduleCode && !scheduleCode.system) {
        scheduleCode.system = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
        scheduleCode.version = "2.1.0";
      }
    }
    expect(toDosageDetails(saved)).toEqual(parsed.fhirNext);
    expect(calculateTotalUnits({ ...supply, dosage: saved }).totalUnits).toBe(296);
  });

  it("never displays or re-exports stale complete SIG wording after edits to an ordinary dosage", () => {
    const original = parseSig("1 tab PO BID").fhirNext;
    const plain = toFhirR5Dosages(original);
    const untouched = toDosageDetails(JSON.parse(JSON.stringify(plain)));
    expect(untouched.renderedInstruction).toBe(original.renderedInstruction);

    const updated = JSON.parse(JSON.stringify(plain)) as FhirDosage[];
    updated[0].doseAndRate![0].doseQuantity!.value = 2;
    updated[0].text = "2 tablets PO BID";
    const after = toDosageDetails(updated);
    expect(after.step[0].component[0].doseAndRate![0].doseQuantity?.value).toBe(2);
    expect(after.renderedInstruction).toBe("2 tablets PO BID");
    expect(formatSig(after)).toContain("2 tablets");
    const resaved = toFhirR5Dosages(updated);
    const liveInstruction = resaved[0].extension?.find(e =>
      e.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)?.extension
      ?.find(e => e.url === "instruction")?.valueString;
    expect(liveInstruction).not.toBe(original.renderedInstruction);
    expect(toDosageDetails(resaved).renderedInstruction).toBe("2 tablets PO BID");

    const staleText = JSON.parse(JSON.stringify(plain)) as FhirDosage[];
    staleText[0].doseAndRate![0].doseQuantity!.value = 2;
    const corrected = toDosageDetails(staleText);
    expect(corrected.renderedInstruction).not.toBe(original.renderedInstruction);
    expect(corrected.step[0].component[0].text).not.toBe(plain[0].text);
    expect(formatSig(corrected, "long").toLowerCase()).not.toContain("1 tablet");
    const resavedStale = toFhirR5Dosages(staleText);
    const staleMarker = resavedStale[0].extension?.find(e =>
      e.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)?.extension
      ?.find(e => e.url === "instruction")?.valueString;
    expect(staleMarker).not.toBe(original.renderedInstruction);
  });

  it("keeps later-stage components aligned when a prior stage loses a simple component", () => {
    const original = parseSig(parallel);
    const altered = JSON.parse(JSON.stringify(original.fhir)) as FhirDosage[];
    altered.splice(0, 1); // Remove one administration from global step one.
    const details = toDosageDetails(altered);
    expect(details.step.map(step => step.component.length)).toEqual([1, 2, 2]);
    expect(details.step[1].component.map(component =>
      component.site?.concept?.text)).toEqual(["right eye", "left eye"]);
    expect(details.step[1].component.map(component =>
      component.timing?.repeat?.frequency)).toEqual([4, 4]);
    expect(details.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(calculateTotalUnits({ ...supply, dosage: altered }).totalUnits).toBe(212);
    const scheduled = nextDueDoses(altered, scheduler);
    expect(scheduled[0]).toBe(beginning);
  });

  it("refuses ambiguous component removal when a stage contains R6-only dose expressions", () => {
    const original = parseSig(parallel).fhirNext;
    const edited: FhirR6DosageDetails = JSON.parse(JSON.stringify(original));
    edited.step[0].component[0].doseAndRate![0].doseExpression = {
      language: "text/fhirpath", expression: "%patient.weight * 0.5"
    };
    const exported = toFhirR5Dosages(edited);
    exported.splice(0, 1);
    expect(() => toDosageDetails(exported))
      .toThrow(/Update the R6 course component mapping/);
  });

  it("does not show an obsolete whole-course SIG when an R5 stage dose changes without editing its text", () => {
    const original = parseSig(parallel);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(original.fhirNext))) as FhirDosage[];
    const oldText = saved[3].text;
    const oldInstruction = original.fhirNext.renderedInstruction;
    saved[3].doseAndRate![0].doseQuantity!.value = 2;
    expect(saved[3].text).toBe(oldText);
    const updated = toDosageDetails(saved);
    expect(updated.renderedInstruction).not.toBe(oldInstruction);
    expect(updated.step[1].component[1].text).not.toBe(oldText);
    expect(updated.step[1].component[1].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(calculateTotalUnits({ ...supply, dosage: updated }).totalUnits).toBe(388);
  });

  it("rejects a changed number of relative stages with a precise action instead of using stale metadata", () => {
    const original = parseSig(parallel);
    const edited = JSON.parse(JSON.stringify(original.fhir)) as FhirDosage[];
    edited[0].sequence = 4;
    expect(() => toDosageDetails(edited)).toThrow(/Update the R6 step start\/end metadata/);
  });

  it("matches all unchanged components before positional edits when concurrent rows are swapped", () => {
    const original: FhirR6DosageDetails = {
      renderedInstruction: "One drop in each eye twice daily",
      step: [{ component: [
        {
          id: "right-eye",
          site: {
            concept: { text: "right eye" },
            reference: { reference: "BodyStructure/right-eye" }
          },
          timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
          doseAndRate: [{
            doseQuantity: { value: 1, unit: "drop" },
            doseExpression: { language: "text/fhirpath", expression: "one right-eye drop" }
          }]
        },
        {
          id: "left-eye",
          site: { concept: { text: "left eye" } },
          timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
        }
      ] }]
    };
    const exported = toFhirR5Dosages(original);
    // Swapping and editing B must not cause A's advanced semantics to move
    // onto B merely because B appears in A's previous array position.
    const edited = [
      JSON.parse(JSON.stringify(exported[1])) as FhirDosage,
      JSON.parse(JSON.stringify(exported[0])) as FhirDosage
    ];
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    edited[0].text = "two left-eye drops twice daily";
    const restored = toDosageDetails(edited);
    expect(restored.step[0].component).toHaveLength(2);
    const left = restored.step[0].component[0];
    const right = restored.step[0].component[1];
    expect(left.site?.concept?.text).toBe("left eye");
    expect(left.doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(left.doseAndRate?.[0].doseExpression).toBeUndefined();
    expect(left.site?.reference).toBeUndefined();
    expect(right.id).toBe("right-eye");
    expect(right.site?.reference?.reference).toBe("BodyStructure/right-eye");
    expect(right.doseAndRate?.[0].doseExpression?.expression).toBe("one right-eye drop");
    expect(right.doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(restored.renderedInstruction).not.toBe(original.renderedInstruction);
  });

  it("retains R6 dose expressions through unrelated R5 edits, but never silently replaces conflicting expressions", () => {
    const full: FhirR6DosageDetails = {
      renderedInstruction: "Weight-adjusted dose twice daily",
      step: [{ component: [{
        text: "Weight-adjusted dose twice daily",
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseExpression: {
          language: "text/fhirpath", expression: "%patient.weight * 0.5"
        } }]
      }] }]
    };
    const flat = JSON.parse(JSON.stringify(toFhirR5Dosages(full))) as FhirDosage[];
    flat[0].timing!.repeat!.frequency = 3;
    expect(toDosageDetails(flat).step[0].component[0].doseAndRate?.[0].doseExpression?.expression)
      .toBe("%patient.weight * 0.5");
    flat[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    expect(() => toDosageDetails(flat)).toThrow(/Update the R6 dose expression explicitly/);
  });

  it("does not invent a dose when only an unevaluated R6 expression exists", () => {
    const details: FhirR6DosageDetails = {
      step: [{ component: [{
        text: undefined,
        route: { text: "oral" },
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseExpression: {
          language: "text/fhirpath", expression: "%patient.weight * 0.5"
        } }]
      }] }]
    };
    expect(() => formatSig(details, "long")).toThrow(/Cannot safely generate text/);
    const imported = fromFhir(details);
    expect(imported.warnings).toContainEqual(expect.stringContaining(
      "Cannot render advanced R6 dosage"));
    expect(imported.longText).toBe("");
    expect(imported.fhirNext.step[0].component[0].doseAndRate?.[0].doseExpression?.expression)
      .toBe("%patient.weight * 0.5");
  });

  it("applies per-administration and lifetime safety checks for supply even without a filtered schedule", () => {
    const dosage = parseSig("2 tabs PO BID").fhir[0];
    const excessive: FhirDosage = {
      ...dosage,
      maxDosePerAdministration: { value: 1, unit: "tab" }
    };
    for (const candidate of [excessive, toDosageDetails([excessive])]) {
      expect(() => calculateTotalUnits({ ...supply, dosage: candidate }))
        .toThrow(/exceeds the specified maximum/);
    }
    const lifetime: FhirDosage = {
      ...dosage, maxDosePerLifetime: { value: 10, unit: "tab" }
    };
    expect(() => calculateTotalUnits({ ...supply, dosage: lifetime }))
      .toThrow(/complete prior administered-dose history/);
    expect(() => calculateTotalUnits({ ...supply, dosage: toDosageDetails([lifetime]) }))
      .toThrow(/lifetime|clinical evaluation/i);
  });

  it("retains the prescribed half-tablet dose in invalid explicit cycles, but does not schedule them", () => {
    const cases = [
      "on days 1,8,15 every 28 days for 2 cycles",
      "on days 1,8,15 every 28 days starting 28/9/2026",
      "on days 0,8 every 28 days starting 28/9/2026 for 2 cycles",
      "on days 1,29 every 28 days starting 28/9/2026 for 2 cycles"
    ];
    for (const suffix of cases) {
      const input = "take .5 tab at 08:00 " + suffix;
      const parsed = parseSig(input);
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(0.5);
      expect(parsed.warnings).toContainEqual(expect.stringContaining("Unresolved schedule"));
      expect(parsed.meta.leftoverText).toContain(suffix);
      expect(() => nextDueDoses(parsed, scheduler)).toThrow(/unresolved/i);
    }
  });

  it("retains legacy PRN without an indication on imported R5-compatibility data", () => {
    const source: FhirDosage & { asNeededBoolean?: boolean } = {
      text: "1 tablet as needed",
      asNeededBoolean: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 4, period: 1, periodUnit: "d" } }
    };
    const imported = fromFhirDosage(source);
    expect(imported.meta.canonical.clauses[0].prn?.enabled).toBe(true);
    expect(imported.longText.toLowerCase()).toContain("needed");
    const disabled: FhirDosage & { asNeededBoolean?: boolean } = {
      ...source, asNeeded: false
    };
    expect(fromFhirDosage(disabled).meta.canonical.clauses[0].prn?.enabled).toBeUndefined();
  });

  it("ordinary day offsets are not claimed and quarantined as malformed cycle schedules", () => {
    expect(recognizeCycles("take 1 tablet on day 3")).toEqual([]);
    expect(recognizeCycles("take 1 tablet on days 1-5")).toEqual([]);
    expect(recognizeCycles("take 1 tablet on days 1,8 every 28 days starting 28/9/2026 for 2 cycles")
      .some(c => !c.error)).toBe(true);
    expect(recognizeCycles("take 1 tablet on days 1,29 every 28 days starting 28/9/2026 for 2 cycles")
      .some(c => c.error === "day-outside-cycle")).toBe(true);
  });

  it("maps independent boundaries after source-span-based meal-dash expansion", () => {
    const make = (source: string) => parseSig(source).items[0];
    const raw: HpsgSigSegment[] = [
      { text: "morning/noon/night x7d", start: 0, end: 25 },
      { text: "then morning/noon/night", start: 26, end: 54 },
      { text: "separate BID x1mo", start: 55, end: 81 },
      { text: "then QID", start: 82, end: 92 }
    ];
    const expanded: HpsgSigSegment[] = [
      ...[0,1,2].map(() => ({ ...raw[0] })),
      raw[1], raw[2], raw[3]
    ];
    const plan: BoundaryPlan = {
      experimental: true,
      segments: raw,
      claims: [], decisions: [],
      relations: [
        { from: 0, to: 1, kind: "sequence", rule: "regimen.test.sequence", range: { start: 25, end: 26 } },
        { from: 1, to: 2, kind: "independent", rule: "regimen.test.independent", range: { start: 54, end: 55 } },
        { from: 2, to: 3, kind: "sequence", rule: "regimen.test.sequence", range: { start: 81, end: 82 } }
      ],
      metrics: {
        lexicalPasses: 0, dateScans: 0, actionScans: 0, clauseProbes: 0,
        probeCacheHits: 0, probedTokens: 0, candidates: 0, claimedCandidates: 0
      }
    };
    const values = [
      make("1 tab PO BID x7d"),
      make("1 tab PO BID x7d"),
      make("1 tab PO BID x7d"),
      make("1 tab PO QID"),
      make("1 tab PO BID x1mo"),
      make("1 tab PO QID")
    ];
    const projection = projectParallelRegimen(values, expanded, plan, "multiple independent plans");
    expect(projection.kind).toBe("resolved");
    if (projection.kind === "resolved") {
      expect(projection.details.step[0].component).toHaveLength(4);
      expect(projection.details.step.map(step => step.end?.offsetDuration?.value))
        .toEqual([7, 1, undefined]);
    }
  });
});
