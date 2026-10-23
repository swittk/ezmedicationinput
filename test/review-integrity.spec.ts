import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSig, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages,
  calculateTotalUnits, nextDueDoses, formatSig, getDosageCondition,
  type FhirDosage, type FhirR6DosageDetails, type EzDosage
} from "../src";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_CONDITION_R6_LOGIC_URL,
  DOSAGE_DETAILS_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_RECONCILIATION_WARNING_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL
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
  it("declares the R6 predicate extension slice using a URL discriminator", () => {
    const profile = JSON.parse(readFileSync(
      new URL("../fhir/r6/medication-r6-condition-logic.json", import.meta.url), "utf8"
    ));
    const extension = profile.differential.element.find(
      (element: { id: string }) => element.id === "Extension.extension"
    );
    expect(extension.slicing).toEqual({
      discriminator: [{ type: "value", path: "url" }],
      ordered: false, rules: "open"
    });
    expect(extension.max).toBe("1");
  });

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

  it("preserves ordinary R5 component extensions without inventing a R6 course modifier", () => {
    const simple: FhirR6DosageDetails = {
      step: [{ component: [{
        extension: [{ url: "urn:test:ordinary-metadata", valueString: "keep" }],
        modifierExtension: [{ url: "urn:test:ordinary-modifier", valueBoolean: true }],
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    const r5 = toFhirR5Dosages(simple);
    expect(r5).toHaveLength(1);
    expect(r5[0].extension).toEqual(simple.step[0].component[0].extension);
    expect(r5[0].modifierExtension).toEqual(simple.step[0].component[0].modifierExtension);
    expect(r5[0].modifierExtension?.some(value => value.url === DOSAGE_DETAILS_R5_URL))
      .not.toBe(true);
    expect(toDosageDetails(r5).step[0].component[0].modifierExtension)
      .toEqual(simple.step[0].component[0].modifierExtension);
  });

  it("keeps unknown and malformed modifiers while using independent live dose data", () => {
    const base = parseSig("1 tab PO BID").fhir[0];
    const candidates: FhirDosage[] = [
      {
        ...base,
        modifierExtension: [{ url: "urn:test:do-not-administer", valueBoolean: true }]
      },
      {
        ...base,
        modifierExtension: [{
          url: DOSAGE_CONDITION_R5_URL,
          extension: [{ url: "predicate", valueString: "{truncated" }]
        }]
      },
      {
        ...base,
        modifierExtension: [{
          url: DOSAGE_EXCLUDED_DATES_R5_URL,
          extension: [{ url: "date", valueDate: "not-a-date" }]
        }]
      },
      {
        ...base,
        modifierExtension: [{
          url: DOSAGE_DETAILS_R5_URL,
          extension: [{ url: "dosageDetails", valueString: "{truncated" }]
        }]
      }
    ];
    for (const dosage of candidates) {
      const originalModifiers = JSON.parse(JSON.stringify(dosage.modifierExtension));
      expect(nextDueDoses(dosage, scheduler)).toHaveLength(14);
      expect(calculateTotalUnits({ ...supply, dosage })).toMatchObject({
        totalUnits: 60, unit: "tab"
      });
      expect(dosage.modifierExtension).toEqual(originalModifiers);
    }
  });

  it("validates imported R6 predicate trees before accepting their Boolean meaning", () => {
    const imported = parseSig("1 tab PO BID only if BP > 160").fhirNext;
    const component = imported.step[0].component[0];
    const original = component.condition?.[0];
    expect(original?.valueQuantity?.value).toBe(160);
    const valid = getDosageCondition(component as EzDosage);
    expect(valid).toMatchObject({ kind: "measurement", name: "bp", operation: "gt", value: 160 });
    for (const invalid of [
      '{"kind":"all"}',
      '{"kind":"any","conditions":[]}',
      '{"kind":"measurement","name":"bp","operation":"gt","value":"abc","text":"BP"}',
      '{broken-json'
    ]) {
      const copy = JSON.parse(JSON.stringify(component)) as EzDosage;
      const condition = copy.condition?.[0];
      expect(condition?.extension?.[0].extension?.[0].url).toBe("predicate");
      condition!.extension![0].extension![0].valueString = invalid;
      // Ignore the malformed JSON, not the real structured BP constraint.
      expect(getDosageCondition(copy)).toEqual(valid);
      const lowered = toFhirR5Dosages({ step: [{ component: [copy] }] });
      expect(getDosageCondition(lowered[0])).toEqual(valid);
      expect(nextDueDoses(lowered, scheduler)).toHaveLength(14);
      expect(nextDueDoses(lowered, {
        ...scheduler, evaluateCondition: () => false
      })).toEqual([]);
    }

    const expression = JSON.parse(JSON.stringify(component)) as EzDosage;
    expression.condition = [{
      text: "unresolved clinical predicate",
      extension: [{
        url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [{ url: "predicate", valueString: '{"kind":"all"}' }]
      }]
    }];
    expect(getDosageCondition(expression)).toEqual({
      kind: "text", text: "unresolved clinical predicate"
    });
    const lowered = toFhirR5Dosages({ step: [{ component: [expression] }] });
    expect(nextDueDoses(lowered, scheduler)).toHaveLength(14);
    expect(nextDueDoses(lowered, {
      ...scheduler, evaluateCondition: () => false
    })).toEqual([]);
  });

  it("keeps unfamiliar or malformed modifiers fully recoverable in read-only imports", () => {
    const dosage = parseSig("1 tablet twice daily").fhir[0];
    const text = "Take one tablet twice daily; external safety instruction requires review";
    const modifiers = [
      { url: "urn:example:external-hold", valueBoolean: true },
      { url: DOSAGE_CONDITION_R5_URL,
        extension: [{ url: "predicate", valueString: "{malformed" }] }
    ];
    for (const modifier of modifiers) {
      const original: FhirDosage = {
        ...dosage,
        text,
        modifierExtension: [modifier]
      };
      const unchanged = JSON.parse(JSON.stringify(original));
      const imported = fromFhirDosage(original);
      expect(original.modifierExtension).toEqual(unchanged.modifierExtension);
      expect(imported.fhir.doseAndRate).toEqual(original.doseAndRate);
      expect(imported.fhir.timing).toEqual(original.timing);
      expect(imported.fhir.modifierExtension).toEqual([modifier]);
      expect(imported.meta.canonical.clauses[0].rawText).toBe(text);
      expect(imported.longText).toContain("1 tablet");
      const course: FhirR6DosageDetails = {
        step: [{ component: [{ ...original }] }]
      };
      const preservedCourse = JSON.parse(JSON.stringify(course));
      const whole = fromFhir(course);
      expect(course).toEqual(preservedCourse);
      expect(whole.fhirNext.step[0].component[0].modifierExtension).toEqual([modifier]);
      expect(whole.fhirNext.step[0].component[0].doseAndRate).toEqual(original.doseAndRate);
      expect(whole.fhirNext.step[0].component[0].timing).toEqual(original.timing);
      expect(nextDueDoses(original, scheduler)).toHaveLength(14);
      expect(calculateTotalUnits({ ...supply, dosage: original })).toMatchObject({
        totalUnits: 60, unit: "tab"
      });
    }
  });

  it("revalidates edited R5 condition modifiers instead of caching stale predicates", () => {
    // Strict R5 has one predicate representation. A native EZ dosage may also
    // carry an independently authoritative R6 condition; do not conflate the
    // two editing contracts in this mutation/regression test.
    const { condition: _r6Condition, ...dosage } =
      parseSig("1 tablet twice daily only if BP > 160").fhir[0];
    const modifier = dosage.modifierExtension?.find(value =>
      value.url === DOSAGE_CONDITION_R5_URL);
    expect(modifier?.extension?.[0]?.valueString).toContain("160");
    expect(getDosageCondition(dosage)).toMatchObject({ value: 160 });
    modifier!.extension![0].valueString = JSON.stringify({
      kind: "measurement", name: "bp", operation: "gt",
      value: 170, text: "BP > 170"
    });
    expect(getDosageCondition(dosage)).toMatchObject({
      kind: "measurement", name: "bp", value: 170
    });
    modifier!.extension![0].valueString = "{bad";
    expect(getDosageCondition(dosage)).toBeUndefined();
    expect(dosage.doseAndRate?.[0].doseQuantity?.value).toBe(1);
    expect(dosage.timing?.repeat?.frequency).toBe(2);
    // Invalid edits remain present for correction; they are never deleted.
    expect(modifier!.extension![0].valueString).toBe("{bad");
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
    // The edited repeat is live data. The older QID code remains recoverable,
    // but must not contribute four institution clock entries.
    const reconciled = toDosageDetails(edited);
    expect(reconciled.step[1].component[1].timing?.repeat?.frequency).toBe(3);
    expect(reconciled.step[1].component[1].timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(reconciled.renderedInstruction).toBeUndefined();
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL
    }));
    expect(calculateTotalUnits({ ...supply, dosage: edited }).totalUnits).toBe(273);
    expect(nextDueDoses(edited, {
      ...scheduler, from: "2026-10-27T08:00:00+07:00"
    }).length).toBeGreaterThan(0);
    delete edited[3].timing!.code;
    edited[3].text = "1 drop OS TID after day 7";
    const updated = toDosageDetails(edited);
    expect(updated.step[1].component[1].timing?.repeat?.frequency).toBe(3);
    expect(updated.step[0].end?.offsetDuration?.value).toBe(7);
    expect(updated.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(updated.renderedInstruction).toBeUndefined();
    const count = calculateTotalUnits({ ...supply, dosage: edited });
    expect(count.totalUnits).toBe(273);
    expect(count.totalUnits).not.toBe(initial.totalUnits);
    const times = nextDueDoses(edited, { ...scheduler, from: "2026-10-27T08:00:00+07:00" });
    expect(times.length).toBeGreaterThan(0);
    expect(updated.step[1].component[1].text).toContain("TID");
  });

  it("does not union institution code clocks with structured frequency clocks", () => {
    const base = parseSig("1 tab PO QID").fhir[0];
    const options = {
      from: "2026-10-21T00:00:00+07:00",
      orderedAt: "2026-10-21T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 8
    };
    const source = nextDueDoses(base, options);
    expect(source).toHaveLength(8);
    // A facility can override both code and frequency clocks. When both
    // describe the same QID pattern, they are alternatives, not a union.
    const configured = nextDueDoses(base, {
      ...options, limit: 4,
      frequencyDefaults: {
        byCode: { QID: ["06:00", "10:00", "14:00", "18:00"] },
        byFrequency: { "freq:4/d": ["07:00", "11:00", "15:00", "19:00"] }
      }
    });
    expect(configured.map(v => v.slice(11, 19)))
      .toEqual(["06:00:00", "10:00:00", "14:00:00", "18:00:00"]);
    const edited = JSON.parse(JSON.stringify(base)) as FhirDosage;
    edited.timing!.repeat!.frequency = 3;
    const changedWithRetainedCode = nextDueDoses(edited, options);
    expect(changedWithRetainedCode).toHaveLength(8);
    expect(changedWithRetainedCode.slice(0, 3).map(v => v.slice(11, 19)))
      .toEqual(["08:00:00", "14:00:00", "20:00:00"]);
    expect(edited.timing?.code?.coding?.[0]?.code).toBe("QID");
    delete edited.timing!.code;
    const changed = nextDueDoses(edited, options);
    expect(changed).toHaveLength(8);
    expect(changed.slice(0, 3).map(v => v.slice(11, 19)))
      .toEqual(["08:00:00", "14:00:00", "20:00:00"]);
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

  it("removes the live component while retaining its R6-only expression as provenance", () => {
    const original = parseSig(parallel).fhirNext;
    const edited: FhirR6DosageDetails = JSON.parse(JSON.stringify(original));
    edited.step[0].component[0].doseAndRate![0].doseExpression = {
      language: "text/fhirpath", expression: "%patient.weight * 0.5"
    };
    const exported = toFhirR5Dosages(edited);
    exported.splice(0, 1);
    const restored = toDosageDetails(exported);
    expect(restored.step.map(step => step.component.length)).toEqual([1, 2, 2]);
    expect(restored.step.flatMap(step => step.component)
      .some(component => component.doseAndRate?.some(rate => rate.doseExpression)))
      .toBe(false);
    expect(JSON.stringify(restored)).toContain("%patient.weight * 0.5");
    expect(restored.renderedInstruction).toBeUndefined();
    expect(restored.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL
    }));
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

  it("projects a changed relative stage while retaining the old course as provenance", () => {
    const original = parseSig(parallel);
    const edited = JSON.parse(JSON.stringify(original.fhir)) as FhirDosage[];
    edited[0].sequence = 4;
    const restored = toDosageDetails(edited);
    expect(restored.step.map(step => step.component.length)).toEqual([1, 2, 2, 1]);
    expect(restored.step[3].component[0].site?.concept?.text).toBe("right eye");
    expect(restored.step[3].component[0].timing?.repeat?.period).toBe(2);
    expect(restored.renderedInstruction).toBeUndefined();
    expect(restored.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL
    }));
    expect(restored.extension?.some(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"))).toBe(true);
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

  it("retains R6 dose expressions as provenance beside conflicting live R5 doses", () => {
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
    const reconciled = toDosageDetails(flat);
    expect(reconciled.step[0].component[0].doseAndRate).toEqual([
      expect.objectContaining({ doseQuantity: { value: 2, unit: "mg" } }),
      expect.objectContaining({
        doseExpression: {
          language: "text/fhirpath", expression: "%patient.weight * 0.5"
        }
      })
    ]);
    expect(reconciled.renderedInstruction).toBeUndefined();
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL,
      valueString: expect.stringMatching(/expressions.*edited R5 dose/i)
    }));
  });

  it("preserves exact R6 safety and coded conditions through unrelated R5 edits", () => {
    const original: FhirR6DosageDetails = {
      step: [{ component: [{
        id: "component-id",
        route: { text: "oral" },
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        condition: [
          {
            id: "condition-a",
            code: { coding: [{
              system: "http://snomed.info/sct", code: "404684003",
              display: "Clinical finding"
            }], text: "Clinical finding A" },
            details: { coding: [{
              system: "http://snomed.info/sct", code: "64572001",
              display: "Disease"
            }] },
            text: "Only for exact condition A"
          },
          {
            id: "condition-b",
            code: { coding: [{
              system: "http://snomed.info/sct", code: "248152002",
              display: "Female"
            }], text: "Clinical finding B" },
            text: "Or exact condition B"
          }
        ],
        safety: {
          id: "safety-id",
          ifExceeded: "hold-and-contact-prescriber",
          doseLimit: [
            {
              id: "administration-limit-id",
              scope: "administration",
              valueQuantity: { value: 2, unit: "tab" }
            },
            {
              id: "lifetime-expression-id",
              scope: "lifetime",
              valueExpression: {
                language: "text/fhirpath",
                expression: "%resource.extension.where(url='urn:lifetime-total').value"
              }
            }
          ]
        }
      }] }]
    };
    const edited = JSON.parse(JSON.stringify(toFhirR5Dosages(original))) as FhirDosage[];
    edited[0].route = { text: "sublingual" };
    const restored = toDosageDetails(edited).step[0].component[0];
    expect(restored.route).toEqual({ text: "sublingual" });
    expect(restored.condition).toEqual(original.step[0].component[0].condition);
    expect(restored.safety).toEqual(original.step[0].component[0].safety);
  });

  it("reconciles edited R5 maxima without deleting R6-only safety semantics", () => {
    const original: FhirR6DosageDetails = {
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        safety: {
          id: "safety-id",
          ifExceeded: "hold-and-contact-prescriber",
          doseLimit: [
            {
              id: "administration-limit-id",
              extension: [{ url: "urn:test:limit-provenance", valueString: "preserve" }],
              scope: "administration",
              valueQuantity: { value: 2, unit: "tab" }
            },
            {
              id: "lifetime-expression-id",
              scope: "lifetime",
              valueExpression: {
                language: "text/fhirpath",
                expression: "%resource.extension.where(url='urn:lifetime-total').value"
              }
            }
          ]
        }
      }] }]
    };
    const edited = JSON.parse(JSON.stringify(toFhirR5Dosages(original))) as FhirDosage[];
    edited[0].maxDosePerAdministration = { value: 3, unit: "tab" };
    const safety = toDosageDetails(edited).step[0].component[0].safety;
    expect(safety?.id).toBe("safety-id");
    expect(safety?.ifExceeded).toBe("hold-and-contact-prescriber");
    expect(safety?.doseLimit).toContainEqual(expect.objectContaining({
      id: "administration-limit-id",
      extension: [{ url: "urn:test:limit-provenance", valueString: "preserve" }],
      scope: "administration",
      valueQuantity: { value: 3, unit: "tab" }
    }));
    expect(safety?.doseLimit).toContainEqual(expect.objectContaining({
      id: "lifetime-expression-id",
      scope: "lifetime",
      valueExpression: expect.objectContaining({
        language: "text/fhirpath",
        expression: "%resource.extension.where(url='urn:lifetime-total').value"
      })
    }));
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
    expect(formatSig(details, "long")).toBe(
      "Take the medication orally twice daily; unevaluated dose expression: %patient.weight * 0.5"
    );
    const imported = fromFhir(details);
    expect(imported.longText).toContain(
      "unevaluated dose expression: %patient.weight * 0.5"
    );
    expect(imported.longText).not.toContain("0.5 tablets");
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
      expect(calculateTotalUnits({ ...supply, dosage: candidate })).toMatchObject({
        unit: "tab",
        quantityKind: "maximum",
        explanation: expect.stringContaining("unevaluable maximum-dose constraint")
      });
    }
    const lifetime: FhirDosage = {
      ...dosage, maxDosePerLifetime: { value: 10, unit: "tab" }
    };
    expect(calculateTotalUnits({ ...supply, dosage: lifetime })).toMatchObject({
      totalUnits: 10, unit: "tab", quantityKind: "maximum",
      explanation: expect.stringMatching(/full lifetime maximum.*no prior administrations/i)
    });
    expect(calculateTotalUnits({
      ...supply, dosage: lifetime,
      priorDoseTimes: [
        "2026-10-18T08:00:00+07:00", "2026-10-18T20:00:00+07:00"
      ]
    })).toMatchObject({
      totalUnits: 6, unit: "tab", quantityKind: "maximum",
      explanation: expect.stringMatching(/reduced by.*prior administrations/i)
    });
    expect(calculateTotalUnits({
      ...supply, dosage: toDosageDetails([lifetime])
    })).toMatchObject({
      totalUnits: 10, unit: "tab", quantityKind: "maximum",
      explanation: expect.stringMatching(/R6 safety details.*retained/i)
    });
  });

  it("retains the prescribed half-tablet, clock, and source for invalid explicit cycles", () => {
    const cases = [
      "on days 1,8,15 every 28 days for 2 cycles",
      "on days 1,8,15 every 28 days starting 28/9/2026",
      "on days 0,8 every 28 days starting 28/9/2026 for 2 cycles",
      "on days 1,29 every 28 days starting 28/9/2026 for 2 cycles"
    ];
    for (const suffix of cases) {
      const input = "take .5 tab at 08:00 " + suffix;
      const parsed = parseSig(input);
      expect(parsed.input).toBe(input);
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(0.5);
      expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
      expect(parsed.fhir[0].route?.text).toBe("by mouth");
      expect(nextDueDoses(parsed, { ...scheduler, limit: 3 })).toEqual([
        "2026-10-19T08:00:00+07:00",
        "2026-10-20T08:00:00+07:00",
        "2026-10-21T08:00:00+07:00"
      ]);
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

  it("ordinary day offsets are not misclassified as malformed cycle schedules", () => {
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
