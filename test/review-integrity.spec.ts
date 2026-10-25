import { cloneStructuredValue } from "../src/stable-structure";
import { parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  parseSig, parseSigAsync, lintSig, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages,
  calculateTotalUnits, nextDueDoses, formatSig, getDosageCondition,
  getDosageAlternativeChoice,
  type FhirDosage, type FhirR6DosageDetails, type EzDosage, type FhirExtension
} from "../src";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_CONDITION_R6_LOGIC_URL,
  DOSAGE_DETAILS_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_RECONCILIATION_WARNING_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL
} from "../src/dosage-course";
import { recognizeCycles } from "../src/hpsg/rules/timing-rules";
import { parseClauseState } from "../src/parser";
import {
  buildCanonicalParallelRegimen, projectParallelRegimen
} from "../src/regimen/parallel-course";
import { buildRegimenGraph } from "../src/regimen/regimen";
import type { BoundaryPlan } from "../src/hpsg/signature";
import type { HpsgSigSegment } from "../src/hpsg/segmenter";
import { BODY_SITE_RESTRICTION_EXTENSION_URL } from "../src/fhir";

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
    expect(displayExtension?.extension?.filter(child => child.url === "row")).toHaveLength(1);
    expect(displayExtension?.extension?.some(child => child.url === "projection")).toBe(false);
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
      [{ url: "kind", valueCode: "all" }],
      [{ url: "kind", valueCode: "any" }, { url: "emptyArray", valueCode: "conditions" }],
      [{ url: "kind", valueCode: "measurement" }, { url: "name", valueString: "bp" },
        { url: "operation", valueCode: "gt" }, { url: "value", valueString: "abc" }],
      [{ url: "unrecognized", valueBoolean: true }]
    ]) {
      const copy = cloneStructuredValue(component) as EzDosage;
      const condition = copy.condition?.[0];
      condition!.extension = [{ url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [{ url: "predicate", extension: invalid }] }];
      // Ignore malformed extension meaning, not the real structured BP constraint.
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
    expect(modifier?.extension?.[0]?.extension).toContainEqual({ url: "value", valueDecimal: 160 });
    expect(getDosageCondition(dosage)).toMatchObject({ value: 160 });
    const predicateFields = modifier!.extension![0].extension!;
    predicateFields.find(field => field.url === "value")!.valueDecimal = 170;
    predicateFields.find(field => field.url === "text")!.valueString = "BP > 170";
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

  it("uses native R6 conditions and reserves the separate R6 logic extension for Boolean trees", () => {
    const details = parseSig("1 tab PO BID only if BP >160, otherwise hold").fhirNext;
    const condition = details.step[0].component[0].condition?.[0];
    expect(condition).toMatchObject({ operation: "gt", valueQuantity: { value: 160 } });
    expect(condition?.extension?.some(ext => ext.url === DOSAGE_CONDITION_R6_LOGIC_URL)).not.toBe(true);
    expect(condition?.extension?.some(ext => ext.url === DOSAGE_CONDITION_R5_URL)).not.toBe(true);
    const strict = toFhirR5Dosages(details);
    const predicate = strict[0].modifierExtension?.find(ext => ext.url === DOSAGE_CONDITION_R5_URL)
      ?.extension?.find(child => child.url === "predicate");
    expect(predicate?.extension).toContainEqual({ url: "kind", valueCode: "measurement" });
    expect(predicate?.extension).toContainEqual({ url: "value", valueDecimal: 160 });
    expect(predicate?.valueString).toBeUndefined();
    expect(toDosageDetails(strict)).toEqual(details);
    const compound = parseSig("1 tab PO BID only if BP > 160 and pulse > 60").fhirNext;
    const logical = compound.step[0].component[0].condition?.[0].extension?.find(ext => ext.url === DOSAGE_CONDITION_R6_LOGIC_URL);
    expect(logical?.extension?.[0].extension).toContainEqual({ url: "kind", valueCode: "all" });
    expect(logical?.extension?.[0].extension?.filter(child => child.url === "conditions")).toHaveLength(2);
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

  it.each([
    "apply 1 mL to scalp where affected",
    "apply 1 mL to scalp where there is hair loss",
    "1 tab PO BID",
    "1 drop OU BID",
    "1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID"
  ])("keeps exact source for an unchanged primary editable projection: %s", (source) => {
    const parsed = parseSig(source);
    const marker = parsed.fhir[0].extension?.find(extension =>
      extension.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    expect(marker?.extension?.find(child => child.url === "instruction")?.valueString)
      .toBe(source);
    const rows = marker?.extension?.filter(child => child.url === "row") ?? [];
    const projectionIdentities = rows.map(row => row.extension?.find(child => child.url === "projectionFingerprint")?.valueString);
    const textIdentities = rows.map(row => row.extension?.find(child => child.url === "textFingerprint")?.valueString);
    expect(projectionIdentities).toHaveLength(parsed.fhir.length);
    expect(textIdentities).toHaveLength(parsed.fhir.length);
    expect(projectionIdentities).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{16}$/)])
    );
    expect(textIdentities).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{16}$/)])
    );
    // The extended public path retains only compact identities, not another
    // complete JSON dosage snapshot on every ordinary parse.
    expect(marker?.extension?.some(child => child.url === "projection")).not.toBe(true);

    const unchanged = toDosageDetails(
      JSON.parse(JSON.stringify(parsed.fhir)) as FhirDosage[]
    );
    expect(unchanged.renderedInstruction).toBe(source);
    expect(formatSig(unchanged, "long")).toBe(source);
  });

  it.each([
    [
      "apply 1 mL to scalp where affected",
      "Apply 2 mL to the scalp where affected.",
      "where affected"
    ],
    [
      "apply 1 mL to scalp where there is hair loss",
      "Apply 2 mL to the scalp where there is hair loss.",
      "where there is hair loss"
    ]
  ])("reconciles a primary dose edit and retains its typed site restriction: %s",
    (source, expected, restrictionText) => {
      const parsed = parseSig(source);
      const edited = JSON.parse(JSON.stringify(parsed.fhir)) as FhirDosage[];
      edited[0].doseAndRate![0].doseQuantity!.value = 2;
      edited[0].extension = [
        ...(edited[0].extension ?? []),
        { url: "urn:test:unfamiliar-edit-metadata", valueString: "retain exactly" }
      ];

      const details = toDosageDetails(edited);
      const component = details.step[0].component[0];
      expect(component.doseAndRate?.[0].doseQuantity?.value).toBe(2);
      expect(component.text).toBeUndefined();
      expect(details.renderedInstruction).toBeUndefined();
      expect(formatSig(details, "long")).toBe(expected);
      expect(component.site?.concept?.coding?.[0]?.code).toBe("41695006");
      expect(component.site?.concept?.extension).toContainEqual(expect.objectContaining({
        url: BODY_SITE_RESTRICTION_EXTENSION_URL,
        extension: expect.arrayContaining([
          expect.objectContaining({ url: "sourceText", valueString: restrictionText })
        ])
      }));
      expect(component.extension).toContainEqual({
        url: "urn:test:unfamiliar-edit-metadata", valueString: "retain exactly"
      });
      const sourceMarker = details.extension?.find(extension =>
        extension.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL);
      expect(sourceMarker?.extension?.find(child =>
        child.url === "instruction")?.valueString).toBe(source);
    }
  );

  it("uses explicitly edited text while retaining the previous source separately", () => {
    const source = "1 tab PO BID";
    const edited = JSON.parse(JSON.stringify(parseSig(source).fhir)) as FhirDosage[];
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    edited[0].text = "Take two tablets by mouth twice daily";
    const details = toDosageDetails(edited);
    expect(details.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(details.step[0].component[0].text).toBe(edited[0].text);
    expect(details.renderedInstruction).toBe(edited[0].text);
    expect(formatSig(details, "long")).toBe(edited[0].text);
    expect(details.extension?.find(extension =>
      extension.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)?.extension?.find(child =>
      child.url === "instruction")?.valueString).toBe(source);
  });

  it.each([
    "apply 1 mL to scalp where affected",
    "apply 1 mL to scalp where there is hair loss"
  ])("drops an obsolete site restriction only when the editable site is replaced: %s",
    (source) => {
      const parsed = parseSig(source);
      const edited = JSON.parse(JSON.stringify(parsed.fhir)) as FhirDosage[];
      edited[0].site = {
        text: "right arm",
        coding: [{
          system: "http://snomed.info/sct",
          code: "368209003",
          display: "Right upper arm"
        }]
      };

      const details = toDosageDetails(edited);
      const component = details.step[0].component[0];
      expect(component.site?.concept).toEqual(edited[0].site);
      expect(component.site?.concept?.extension?.some(extension =>
        extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL)).not.toBe(true);
      expect(component.condition).toBeUndefined();
      expect(component.timing).toBeUndefined();
      expect(details.renderedInstruction).toBeUndefined();
      expect(formatSig(details, "long")).toBe("Apply 1 mL to the right arm.");
      expect(details.extension?.find(extension =>
        extension.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)?.extension?.find(child =>
        child.url === "instruction")?.valueString).toBe(source);
    }
  );

  it.each([
    ["1 tab PO BID", "Take 1 tablet orally three times daily."],
    ["1 drop OU BID", "Instill 1 drop three times daily in both eyes."]
  ])("uses an edited primary cadence instead of its old literal text: %s",
    (source, expected) => {
      const edited = JSON.parse(JSON.stringify(parseSig(source).fhir)) as FhirDosage[];
      edited[0].timing!.repeat!.frequency = 3;
      const details = toDosageDetails(edited);
      expect(details.step[0].component[0].timing?.repeat?.frequency).toBe(3);
      expect(details.step[0].component[0].text).toBeUndefined();
      expect(details.renderedInstruction).toBeUndefined();
      expect(formatSig(details, "long")).toBe(expected);
    }
  );

  it("reconciles one edited eye-taper dose without changing its other typed stages", () => {
    const source = "1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID";
    const parsed = parseSig(source);
    const edited = JSON.parse(JSON.stringify(parsed.fhir)) as FhirDosage[];
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    const details = toDosageDetails(edited);
    expect(details.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(details.step.map(step => step.end)).toEqual(
      parsed.fhirNext.step.map(step => step.end)
    );
    expect(details.step.flatMap(step => step.component).map(component =>
      component.site?.concept?.coding?.[0]?.code)).toEqual(
      parsed.fhirNext.step.flatMap(step => step.component).map(component =>
        component.site?.concept?.coding?.[0]?.code)
    );
    const displayed = formatSig(details, "long");
    expect(displayed).toContain("2 drops");
    expect(displayed).not.toBe(source);
    expect(details.renderedInstruction).toBeUndefined();
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

  it("retains superseded R6 dose expressions only as inert provenance after a numeric R5 edit", () => {
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
    // The clinician's explicit 2 mg now owns the executable dose.
    // An earlier weight formula must not reappear as a second active dosage.
    expect(reconciled.step[0].component[0].doseAndRate).toEqual([
      expect.objectContaining({ doseQuantity: { value: 2, unit: "mg" } })
    ]);
    expect(reconciled.step[0].component[0].doseAndRate?.some(value =>
      value.doseExpression !== undefined)).toBe(false);
    expect(reconciled.renderedInstruction).toBeUndefined();
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL,
      valueString: expect.stringMatching(/expressions.*edited R5 dose/i)
    }));
    // Old expression remains inspectable as typed, inert source ancestry.
    const source = reconciled.extension?.find(extension =>
      extension.url.endsWith("medication-course-reconciliation-source"));
    expect(source).toBeDefined();
    const containsOriginalExpression = (extension: FhirExtension): boolean =>
      extension.valueExpression?.expression === "%patient.weight * 0.5" ||
      extension.extension?.some(containsOriginalExpression) === true;
    expect(containsOriginalExpression(source!)).toBe(true);
    // Save/reload through strict R5 must never reactivate the old expression.
    const reloaded = toDosageDetails(toFhirR5Dosages(reconciled));
    expect(reloaded.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(reloaded.step[0].component[0].doseAndRate?.some(value =>
      value.doseExpression !== undefined)).toBe(false);
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

  it("keeps invalid explicit cycle source editable without fabricating a cycle", () => {
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
      expect(parsed.meta.canonical.clauses[0].rawText).toBe(input);
      // An invalid, unanchored cycle is not an executable dosing grammar.
      // Keep the full prescriber source and useful independent clock/route;
      // do not impose a special parser guard or chart dose override to fix it.
      // The malformed cycle is still editable through authoritative input
      // and typed rawText; exact leftover tokenization is not a contract.
      expect(parsed.fhir).toHaveLength(1);
      // Source-local dose identity is stronger than a superficially valid
      // chart cover: ordinal cycle-day 0/1/8/15 is NEVER a new drug amount.
      expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity)
        .toMatchObject({ value: 0.5, unit: "tab" });
      expect(parsed.meta.canonical.clauses[0].evidence.find(evidence =>
        evidence.rule === "hpsg.lex.dose.numeric")?.spans.map(span => span.text))
        .toContain(".5 tab");
      // A rejected cycle may retain the independently specified 08:00 clock,
      // but cannot acquire a bogus every-28-days executable recurrence.
      expect(parsed.fhir[0].timing?.repeat?.period).toBeUndefined();
      expect(lintSig(input).issues.some(issue =>
        /Unrecognized text|Unresolved schedule/iu.test(issue.message))).toBe(true);
      expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
      expect(parsed.fhir[0].route?.text).toBe("by mouth");
      expect(parsed.fhirNext.repeatCycle).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0].evidence.some(evidence =>
        evidence.rule === "hpsg.lex.schedule.finiteCycle"
      )).toBe(false);
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
    const make = (source: string) => parseClauseState(source);
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
        lexicalPasses: 0, dateScans: 0, actionScans: 0, clauseProbes: 0, siteCoordinationProbes: 0,
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
    const graph = buildRegimenGraph(plan, expanded);
    const regimen = buildCanonicalParallelRegimen(values.map(state => state.primaryClause), expanded, plan, graph);
    const projection = projectParallelRegimen(
      regimen,
      values.map(value => value.primaryClause.rawText),
      "multiple independent plans"
    );
    expect(projection.kind).toBe("resolved");
    if (projection.kind === "resolved") {
      expect(projection.details.step[0].component).toHaveLength(4);
      expect(projection.details.step.map(step => step.end?.offsetDuration?.value))
        .toEqual([7, 1, undefined]);
    }
  });
});


describe("native editable fields invalidate stale source realization", () => {
  it.each([
    { name: "condition", mutate(d: EzDosage) {
      d.condition = [{ code: { text: "BP" }, operation: "gt", valueQuantity: { value: 160 } }];
    }, field: "condition" as const },
    { name: "lifetime safety", mutate(d: EzDosage) {
      d.safety = { ifExceeded: "Review before another application", doseLimit: [{
        scope: "lifetime", valueQuantity: { value: 40, unit: "mL" }
      }] };
    }, field: "safety" as const },
    { name: "dose expression", mutate(d: EzDosage) {
      d.doseAndRate = [{ doseExpression: { language: "text/fhirpath", expression: "%weight * 0.5" } }];
    }, field: "doseAndRate" as const }
  ])("retains $name edits and original source without reusing the stale complete SIG", ({ mutate, field }) => {
    const input = "apply 1 mL to scalp where affected";
    const parsed = parseSig(input);
    const originalStructured = JSON.parse(JSON.stringify(parsed.fhir)) as EzDosage[];
    const edited = JSON.parse(JSON.stringify(parsed.fhir)) as EzDosage[];
    mutate(edited[0]);
    const r6 = toDosageDetails(edited);
    expect(r6.renderedInstruction).toBeUndefined();
    expect(r6.step[0].component[0][field]).toEqual(edited[0][field]);
    expect(r6.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RENDERED_INSTRUCTION_R5_URL,
      extension: expect.arrayContaining([{ url: "instruction", valueString: input }])
    }));
    expect(r6.step[0].component[0].site?.concept?.coding?.[0]?.code).toBe("41695006");
    expect(r6.step[0].component[0].site?.concept?.extension).toContainEqual(
      expect.objectContaining({ url: BODY_SITE_RESTRICTION_EXTENSION_URL })
    );
    // Dosage.text is the normal-form display; the original input remains in
    // source provenance. Editing a clone must mutate neither representation.
    expect(parsed.fhir).toEqual(originalStructured);
    expect(parsed.input).toBe(input);
  });
});


describe("FHIR projection structural comparison hygiene", () => {
  it("preserves a parallel eye course after a consumer reorders object properties", () => {
    const expected = parseSig(parallel).fhirNext;
    const exported = toFhirR5Dosages(expected);
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (!value || typeof value !== "object") return value;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        result[key] = reorder((value as Record<string, unknown>)[key]);
      }
      return result;
    };
    const reordered = reorder(exported) as FhirDosage[];
    expect(toDosageDetails(reordered)).toEqual(expected);
  });

  it("keeps unknown nested FHIR content isolated without JSON cloning", () => {
    const shared: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
      extension: [{ url: "urn:test:unknown", extension: [{ url: "detail", valueString: "retain" }] }]
    };
    const input: FhirR6DosageDetails = { step: [{ component: [shared, shared] }] };
    const output = toFhirR5Dosages(input);
    output[0].doseAndRate![0].doseQuantity!.value = 2;
    output[0].extension![0].extension![0].valueString = "edited";
    expect(output[1].doseAndRate![0].doseQuantity!.value).toBe(1);
    expect(output[1].extension![0].extension![0].valueString).toBe("retain");
    expect(shared.doseAndRate![0].doseQuantity!.value).toBe(1);
    expect(shared.extension![0].extension![0].valueString).toBe("retain");
  });

  it("preserves dose edits and original text when optional empty metadata is omitted", () => {
    const parsed = parseSig("apply 1 mL to scalp where affected twice daily");
    const edited = cloneStructuredValue(parsed.fhir);
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    edited[0].site!.coding = edited[0].site!.coding?.map(coding => ({ ...coding, extension: [] }));
    const rebuilt = toDosageDetails(edited);
    expect(rebuilt.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(2);
    expect(formatSig(rebuilt, "long")).toContain("2 mL");
    expect(formatSig(rebuilt, "long")).toContain("affected");
    expect(edited[0].extension).toEqual(parsed.fhir[0].extension);
  });
});


it("contains no JSON serialization in library source, including exports and unknown-data retention", () => {
  const allowed = new Set<string>();
  const unexpected: string[] = [];
  const walk = (directory: URL, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) { walk(url, relative + "/"); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const source = readFileSync(url, "utf8");
      if (!/JSON\.(?:stringify|parse)/u.test(source)) continue;
      const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.expression.getText(file) === "JSON" && ["stringify", "parse"].includes(node.expression.name.text)) {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !(ts.isFunctionDeclaration(parent) && parent.name)) parent = parent.parent;
          const owner = parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined;
          const key = relative + ":" + (owner ?? "<module>");
          if (!allowed.has(key)) unexpected.push(key);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  };
  walk(new URL("../src/", import.meta.url));
  expect(unexpected).toEqual([]);
});


describe("structured FHIR extensions without serialization", () => {
  const inspectExtensions = (value: unknown): FhirExtension[] => {
    if (Array.isArray(value)) return value.flatMap(inspectExtensions);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return [...(typeof record.url === "string" ? [record as unknown as FhirExtension] : []),
      ...Object.values(record).flatMap(inspectExtensions)];
  };

  it("stores native typed course fields and respects Extension's value-versus-children rule", () => {
    const details = parseSig(parallel).fhirNext;
    const rows = toFhirR5Dosages(details);
    const marker = rows[0].modifierExtension?.find(ext => ext.url === DOSAGE_DETAILS_R5_URL);
    const course = marker?.extension?.find(child => child.url === "dosageDetails");
    expect(course?.valueString).toBeUndefined();
    const steps = course?.extension?.filter(child => child.url === "step");
    expect(steps).toHaveLength(details.step.length);
    expect(steps![0].extension?.filter(child => child.url === "component"))
      .toHaveLength(details.step[0].component.length);
    expect(inspectExtensions(rows)).toContainEqual(expect.objectContaining({
      url: "doseQuantity", valueQuantity: expect.objectContaining({ value: 1, unit: "drop" })
    }));
    for (const extension of inspectExtensions(rows)) {
      const values = Object.keys(extension).filter(key => key.startsWith("value") &&
        (extension as unknown as Record<string, unknown>)[key] !== undefined);
      expect(values.length <= 1).toBe(true);
      expect(Boolean(extension.extension?.length)).toBe(values.length === 0);
    }
    expect(toDosageDetails(rows)).toEqual(details);
  });

  it("preserves unfamiliar native fields and native extensions without flattening them into strings", () => {
    const source = {
      renderedInstruction: "External course",
      extension: [{ url: "urn:test:unknown-course", valueBoolean: false }],
      step: [{
        start: { offsetDuration: { value: 1, unit: "d" } },
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
          extension: [{ url: "urn:test:unknown-dosage", valueCodeableConcept: {
            coding: [{ system: "urn:test", code: "known-to-other-system" }]
          } }],
          safety: { ifExceeded: "review", doseLimit: [{ scope: "administration" as const,
            valueQuantity: { value: 2, comparator: "~" as const, unit: "mL" } }],
            futureMetadata: { flags: [false, true], zero: 0, label: "opaque source", nullable: null }
          }
        }]
      }]
    };
    const rows = toFhirR5Dosages(source);
    const restored = toDosageDetails(rows);
    expect(restored).toEqual(source);
    const preserved = inspectExtensions(rows).find(ext => ext.url === "urn:test:unknown-dosage");
    expect(preserved).toEqual(source.step[0].component[0].extension[0]);
    expect(inspectExtensions(rows).some(ext => ext.url === "retainedField" && ext.extension?.length)).toBe(true);
    expect(inspectExtensions(rows).some(ext => ext.url === "comparator" && ext.valueCode === "~")).toBe(true);
    expect(source.step[0].component[0].safety.futureMetadata.zero).toBe(0);
  });

  it("parses, exports, imports, edits and formats with JSON.parse/stringify disabled", () => {
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("unexpected serialization"); });
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new Error("unexpected JSON parsing"); });
    let course: FhirR6DosageDetails;
    let formatted: string;
    try {
      const parsed = parseSig("apply 1 mL to scalp where affected twice daily only if BP > 160");
      const strict = toFhirR5Dosages(parsed.fhirNext);
      strict[0].doseAndRate![0].doseQuantity!.value = 2;
      course = toDosageDetails(strict);
      formatted = formatSig(course, "long");
      const repeated = toDosageDetails(toFhirR5Dosages(course));
      // Access values here; assertions run after restoring the test framework's JSON functions.
      if (repeated.step[0].component[0].doseAndRate?.[0].doseQuantity?.value !== 2) throw new Error("lost dose");
    } finally {
      stringify.mockRestore(); parse.mockRestore();
    }
    expect(course!.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(formatted!).toContain("2 mL");
    expect(formatted!).toContain("affected");
    expect(course!.step[0].component[0].condition?.[0].valueQuantity?.value).toBe(160);
  });

  it.each([
    "1 tab PO BID",
    parallel,
    "apply 1 mL to scalp where affected and face where there is acne twice daily",
    "1 tab BID only if BP > 160 and pulse > 60"
  ])("keeps sync and async orchestration identical: %s", async input => {
    expect(await parseSigAsync(input)).toEqual(parseSig(input));
  });
});


it("retains unfamiliar children on recognized course and edit markers even without clinical edits", () => {
  const rows = toFhirR5Dosages(parseSig(parallel).fhirNext);
  const course = rows[0].modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
  course.extension!.push({ url: "externalAudit", valueBoolean: false });
  const display = rows[0].extension!.find(value => value.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL)!;
  display.extension!.push({ url: "externalSigner", valueString: "retained author" });
  const restored = toDosageDetails(rows);
  const source = restored.extension?.find(value => value.url.endsWith("medication-course-reconciliation-source"));
  expect(source?.extension).toContainEqual(course);
  const savedDisplay = restored.extension?.find(value => value.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL);
  expect(savedDisplay?.extension).toContainEqual({ url: "externalSigner", valueString: "retained author" });
  expect(restored.step).toEqual(parseSig(parallel).fhirNext.step);
});


it("keeps independent editable course markers on every projected row", () => {
  const source = parseSig(parallel).fhirNext;
  const rows = toFhirR5Dosages(source);
  const marker = (index: number) => rows[index].modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
  const beforeSecond = cloneStructuredValue(marker(1));
  marker(0).extension![0].extension!.find(value => value.url === "renderedInstruction")!.valueString = "edited first row";
  expect(marker(1)).toEqual(beforeSecond);
  expect(source.renderedInstruction).toBe(parallel);
});

// Cross-layer clinical entailment controls from the October 2026 bilingual
// counseling cases. These require the SAME typed action meaning before and
// after a strict R5/R6 save/reload, rather than merely recognizing all words.
describe("independent counseling entailment conservation in R5/R6", () => {
  const conserved = (source: string) => {
    const original = parseSig(source);
    const rows = toFhirR5Dosages(original.fhirNext);
    const fromStrictR5 = fromFhirDosage(rows[0]);
    const fromRoundtripR6 = fromFhir(toDosageDetails(rows));
    return { original, rows, fromStrictR5, fromRoundtripR6 };
  };
  const actions = (result: ReturnType<typeof parseSig>) =>
    result.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
  const canonicalActions = (result: ReturnType<typeof fromFhir> | ReturnType<typeof fromFhirDosage>) =>
    result.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
  const adviceCodes = (dosage: FhirDosage) =>
    dosage.additionalInstruction?.flatMap(value =>
      value.coding?.map(coding => coding.code) ?? []) ?? [];

  it.each([
    "Drink plenty of water",
    "Drink lots of water",
    "ดื่มน้ำตามมากๆ",
    "ดื่มน้ำตามมาก ๆ",
    "ดื่มน้ำเยอะๆ"
  ])("keeps affirmative water counseling, rather than fabricating a medication administration: %s", source => {
    const { original, rows, fromStrictR5, fromRoundtripR6 } = conserved(source);
    expect(original.fhir).toHaveLength(1);
    expect(original.fhir[0].doseAndRate).toBeUndefined();
    expect(original.fhir[0].method).toBeUndefined();
    expect(original.fhir[0].route).toBeUndefined();
    expect(original.fhir[0].timing?.repeat).toBeUndefined();
    expect(original.meta.leftoverText).toBeUndefined();
    expect(adviceCodes(original.fhir[0])).toContain("419303009");
    const frame = expect.objectContaining({
      predicate: expect.objectContaining({ lemma: "drink" }),
      args: expect.arrayContaining([
        expect.objectContaining({ role: "substance", conceptId: "plenty-of-water" })
      ])
    });
    expect(actions(original)).toEqual(expect.arrayContaining([frame]));
    for (const [roundtripped, dosage] of [
      [fromStrictR5, fromStrictR5.fhir],
      [fromRoundtripR6, fromRoundtripR6.fhir[0]]
    ] as const) {
      expect(dosage.doseAndRate).toBeUndefined();
      expect(dosage.method).toBeUndefined();
      expect(dosage.route).toBeUndefined();
      expect(dosage.timing?.repeat).toBeUndefined();
      expect(canonicalActions(roundtripped)).toEqual(expect.arrayContaining([frame]));
      expect(adviceCodes(dosage)).toContain("419303009");
    }
    const en = formatSig(toDosageDetails(rows), "long", { locale: "en" });
    const th = formatSig(toDosageDetails(rows), "long", { locale: "th" });
    expect(en).toMatch(/drink.*water/iu);
    expect(en).not.toMatch(/(?:take|use) the medication/iu);
    expect(th).toContain("ดื่ม");
    expect(th).not.toMatch(/[A-Za-z]/u);
  });

  it.each([
    "Do not drink water for 30 minutes",
    "Do not drink water",
    "Avoid drinking water",
    "ห้ามดื่มน้ำ",
    "Take 1 tablet without water"
  ])("does not emit affirmative hydration SNOMED against source polarity: %s", source => {
    const { original, rows, fromStrictR5, fromRoundtripR6 } = conserved(source);
    for (const dosage of [original.fhir[0], rows[0],
      fromStrictR5.fhir, fromRoundtripR6.fhir[0]]) {
      expect(adviceCodes(dosage)).not.toContain("419303009");
    }
    if (source.toLowerCase().includes("drink") || source.includes("ดื่ม")) {
      expect(actions(original)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          predicate: expect.objectContaining({ lemma: "drink" }),
          polarity: "negate"
        })
      ]));
      expect(canonicalActions(fromRoundtripR6)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          predicate: expect.objectContaining({ lemma: "drink" }),
          polarity: "negate"
        })
      ]));
    }
    expect(rows[0].text).toBeTruthy();
  });

  it.each([
    "Take 1 tablet with water",
    "Drink water",
    "Drink water then take 1 tablet"
  ])("does not upgrade ordinary water to an invented plentiful quantity: %s", source => {
    const { original, rows, fromRoundtripR6 } = conserved(source);
    expect(adviceCodes(original.fhir[0])).not.toContain("419303009");
    expect(adviceCodes(rows[0])).not.toContain("419303009");
    expect(adviceCodes(fromRoundtripR6.fhir[0])).not.toContain("419303009");
    expect(rows[0].text).toBeTruthy();
  });

  it("preserves a positive plenty-of-water adjunct without duplicating the executable dose", () => {
    const { original, rows, fromStrictR5, fromRoundtripR6 } =
      conserved("Take 1 tablet with plenty of water twice daily");
    for (const dosage of [
      original.fhir[0], rows[0], fromStrictR5.fhir, fromRoundtripR6.fhir[0]
    ]) {
      expect(dosage.doseAndRate?.[0].doseQuantity).toMatchObject({
        value: 1, unit: "tab"
      });
      expect(dosage.timing?.repeat).toMatchObject({
        frequency: 2, period: 1, periodUnit: "d"
      });
      expect(adviceCodes(dosage)).toContain("419303009");
    }
    expect(fromRoundtripR6.fhirNext.step[0].component).toHaveLength(1);
    expect(formatSig(toDosageDetails(rows), "long", { locale: "en" }))
      .toMatch(/water/iu);
  });

  it("keeps a prescribed oral liquid dose distinct from supplemental drinking advice", () => {
    const { original, rows, fromRoundtripR6 } =
      conserved("Drink 5 mL oral solution twice daily");
    for (const dosage of [original.fhir[0], rows[0], fromRoundtripR6.fhir[0]]) {
      expect(dosage.doseAndRate?.[0].doseQuantity).toMatchObject({
        value: 5, unit: "mL"
      });
      expect(dosage.timing?.repeat).toMatchObject({
        frequency: 2, period: 1, periodUnit: "d"
      });
      expect(adviceCodes(dosage)).not.toContain("419303009");
    }
  });

  it.each([
    "Should not lie down immediately after taking medication",
    "ไม่ควรนอนราบทันทีหลังกินยา"
  ])("keeps the procedure-local immediacy and AFTER relation out of dosage timing: %s", source => {
    const { original, rows, fromStrictR5, fromRoundtripR6 } = conserved(source);
    for (const dosage of [
      original.fhir[0], rows[0], fromStrictR5.fhir, fromRoundtripR6.fhir[0]
    ]) {
      expect(dosage.timing?.repeat?.when ?? []).not.toContain("IMD");
      expect(dosage.doseAndRate).toBeUndefined();
    }
    const clause = original.meta.canonical.clauses[0];
    const target = expect.objectContaining({
      predicate: expect.objectContaining({ lemma: "lie-down" }),
      polarity: "negate",
      modality: "should",
      relation: "after",
      args: expect.arrayContaining([
        expect.objectContaining({ role: "time", conceptId: "immediacy" }),
        expect.objectContaining({
          role: "activity", conceptId: "medication-administration"
        })
      ])
    });
    expect(clause.instructionGraph?.actions).toEqual(expect.arrayContaining([target]));
    expect(canonicalActions(fromStrictR5)).toEqual(expect.arrayContaining([target]));
    expect(canonicalActions(fromRoundtripR6)).toEqual(expect.arrayContaining([target]));
    expect(original.meta.leftoverText).toBeUndefined();
    expect(formatSig(fromRoundtripR6.fhirNext, "long", { locale: "en" }))
      .toMatch(/not lie down.*after taking medication/iu);
  });

  it.each([
    "Continue taking medication until finished",
    "กินต่อเนื่องจนหมด",
    "รับประทานยาต่อเนื่องจนหมด"
  ])("keeps continuing medication until supply exhaustion as a condition, not a finite duration: %s", source => {
    const { original, rows, fromStrictR5, fromRoundtripR6 } = conserved(source);
    const expected = expect.objectContaining({
      predicate: expect.objectContaining({ lemma: "continue-treatment" }),
      relation: "until",
      args: expect.arrayContaining([
        expect.objectContaining({ role: "result", conceptId: "supply-exhausted" })
      ])
    });
    expect(actions(original)).toEqual(expect.arrayContaining([expected]));
    expect(canonicalActions(fromStrictR5)).toEqual(expect.arrayContaining([expected]));
    expect(canonicalActions(fromRoundtripR6)).toEqual(expect.arrayContaining([expected]));
    expect(original.meta.leftoverText).toBeUndefined();
    for (const dosage of [
      original.fhir[0], rows[0], fromStrictR5.fhir, fromRoundtripR6.fhir[0]
    ]) {
      expect(dosage.doseAndRate).toBeUndefined();
      expect(dosage.timing?.repeat?.duration).toBeUndefined();
      expect(dosage.timing?.repeat?.count).toBeUndefined();
    }
  });

  it("does not confuse procedure-local immediacy with the explicit main STAT dose", () => {
    const { original, rows, fromRoundtripR6 } = conserved("Take 1 tablet immediately");
    for (const dosage of [original.fhir[0], rows[0], fromRoundtripR6.fhir[0]]) {
      expect(dosage.doseAndRate?.[0].doseQuantity?.value).toBe(1);
      expect(dosage.timing?.repeat?.when).toContain("IMD");
    }
  });
});


// A positive "mix with water before taking" instruction is not entailed by
// negated mixing, WITHOUT-water mixing, or an unspecified preparation time.
// Coding must follow the complete typed predicate with its material/time scope.
describe("reconstitution counseling polarity and material scope survive strict R5/R6", () => {
  const code = "417995008";
  const hydrate = (text: string) => {
    const parsed = parseSig(text);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const imported = fromFhir(toDosageDetails(strict));
    return { parsed, strict, imported };
  };
  const hasCode = (dose: FhirDosage) =>
    dose.additionalInstruction?.some(instruction =>
      instruction.coding?.some(item => item.code === code)) ?? false;
  const frames = (result: ReturnType<typeof parseSig> | ReturnType<typeof fromFhir>) =>
    result.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
  const expects = (source: string, shouldCode: boolean) => {
    const { parsed, strict, imported } = hydrate(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(strict).toHaveLength(1);
    for (const dosage of [parsed.fhir[0], strict[0], imported.fhir[0]]) {
      expect(hasCode(dosage)).toBe(shouldCode);
    }
    expect(parsed.fhir[0].text).toBeTruthy();
    expect(imported.fhirNext.step[0].component).toHaveLength(1);
    return { parsed, strict, imported };
  };

  it.each([
    "Do not mix powder with water before taking",
    "Do not dissolve tablet in water before taking",
    "ห้ามผสมผงยากับน้ำก่อนรับประทาน"
  ])("never adds affirmative reconstitution SNOMED to negated instructions: %s", source => {
    const { parsed, imported } = expects(source, false);
    expect(frames(parsed)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: expect.objectContaining({ lemma: expect.stringMatching(/^(?:mix|dissolve)$/u) }),
        polarity: "negate"
      })
    ]));
    expect(frames(imported)).toEqual(expect.arrayContaining([
      expect.objectContaining({ polarity: "negate" })
    ]));
  });

  it("distinguishes WITH water from explicitly WITHOUT water in source and realized instruction", () => {
    const { parsed, imported } = expects("Mix powder without water", false);
    const withAbsent = expect.objectContaining({
      predicate: expect.objectContaining({ lemma: "mix" }),
      relation: "without"
    });
    expect(frames(parsed)).toEqual(expect.arrayContaining([withAbsent]));
    expect(frames(imported)).toEqual(expect.arrayContaining([withAbsent]));
    expect(formatSig(imported.fhirNext, "long", { locale: "en" }))
      .toMatch(/without water/iu);
  });

  it.each([
    "Mix powder with water",
    "Mix powder with water after taking",
    "Dissolve tablet in water"
  ])("does not silently invent a BEFORE-taking instruction from water alone: %s", source => {
    const { parsed, imported } = expects(source, false);
    expect(frames(parsed)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: expect.objectContaining({ lemma: expect.stringMatching(/^(?:mix|dissolve)$/u) })
      })
    ]));
    expect(imported.fhir[0].text).toBeTruthy();
  });

  it.each([
    "Mix powder with water before taking",
    "Dissolve tablet in water before taking",
    "ผสมผงยากับน้ำก่อนรับประทาน"
  ])("retains the positive coded preparation when source really says before taking: %s", source => {
    const { parsed, imported } = expects(source, true);
    expect(frames(parsed)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: expect.objectContaining({ lemma: expect.stringMatching(/^(?:mix|dissolve)$/u) })
      })
    ]));
    expect(frames(parsed).some(a =>
      /^(?:mix|dissolve)$/u.test(a.predicate.lemma) && a.polarity === "negate"
    )).toBe(false);
    expect(imported.fhir[0].additionalInstruction?.some(a =>
      a.coding?.some(c => c.code === code))).toBe(true);
  });
});


/**
 * Small reusable clinical-code contrast matrix.
 * Add a semantic signature and a few deliberately changed feature axes when
 * adding new terminology rules. A code is licensed by composed meaning,
 * not by encountering one remembered word. Source, strict R5 and R6 imports
 * must agree even when an otherwise familiar constituent is negated or absent.
 */
describe("typed clinical terminology entailment contrast properties", () => {
  type Contrast = {
    family: string;
    axis: string;
    source: string;
    code: string;
    entailed: boolean;
  };
  const hydrating = [
    { axis: "plentiful", negated: false, quantity: "plenty of ", entailed: true },
    { axis: "unquantified", negated: false, quantity: "", entailed: false },
    { axis: "negated plenty", negated: true, quantity: "plenty of ", entailed: false },
    { axis: "negated plain", negated: true, quantity: "", entailed: false }
  ].map((v): Contrast => ({
    family: "affirmative quantified hydration",
    axis: v.axis,
    source: (v.negated ? "Do not " : "") + "Drink " + v.quantity + "water",
    code: "419303009",
    entailed: v.entailed
  }));
  const thinness = [
    { axis: "thin film", verb: "Apply", width: "thin", negated: false, entailed: true },
    { axis: "thick film", verb: "Apply", width: "thick", negated: false, entailed: false },
    { axis: "negated thin", verb: "Apply", width: "thin", negated: true, entailed: false },
    { axis: "spread thin", verb: "Spread", width: "thin", negated: false, entailed: true }
  ].map((v): Contrast => ({
    family: "topical thin-layer manner",
    axis: v.axis,
    source: (v.negated ? "Do not " : "") + v.verb + " a " + v.width + " film of cream",
    code: "420162004",
    entailed: v.entailed
  }));
  const preparation = [
    { verb: "Mix", object: "powder", relation: "with", material: "water" },
    { verb: "Dissolve", object: "tablet", relation: "in", material: "water" }
  ].flatMap((v): Contrast[] => {
    const subject = v.verb + " " + v.object + " " + v.relation + " " + v.material;
    return [
      { family: "reconstitution before administration", axis: v.verb + " before",
        source: subject + " before taking", code: "417995008", entailed: true },
      { family: "reconstitution before administration", axis: v.verb + " negated",
        source: "Do not " + v.verb.toLowerCase() + " " + v.object + " " +
          v.relation + " " + v.material + " before taking",
        code: "417995008", entailed: false },
      { family: "reconstitution before administration", axis: v.verb + " timing absent",
        source: subject, code: "417995008", entailed: false },
      { family: "reconstitution before administration", axis: v.verb + " after instead",
        source: subject + " after taking", code: "417995008", entailed: false }
    ];
  });
  const extraPreparation: Contrast[] = [
    { family: "reconstitution material", axis: "without water",
      source: "Mix powder without water before taking",
      code: "417995008", entailed: false },
    { family: "reconstitution material", axis: "different material",
      source: "Mix powder with juice before taking",
      code: "417995008", entailed: false }
  ];
  const all = [...hydrating, ...thinness, ...preparation, ...extraPreparation];
  const emitted = (dosage: FhirDosage, code: string): boolean =>
    dosage.additionalInstruction?.some(instruction =>
      instruction.coding?.some(coding => coding.code === code)) === true;

  it.each(all)("$family — $axis: $source", ({ source, code, entailed }) => {
    const parsed = parseSig(source);
    expect(parsed.fhir).toHaveLength(1);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(strict).toHaveLength(1);
    const loaded = fromFhir(toDosageDetails(strict));
    expect(loaded.fhir).toHaveLength(1);
    for (const dosage of [parsed.fhir[0], strict[0], loaded.fhir[0]]) {
      expect(emitted(dosage, code), "Unlicensed clinical code " + code + " for " + source)
        .toBe(entailed);
    }
    expect(strict[0].text).toBeTruthy();
  });

  it.each([
    "กินยา 1 เม็ด ทุกวัน",
    "รับประทานยา 1 เม็ด ทุกวัน",
    "กิน 1 เม็ด ทุกวัน",
    "กินยา 1 เม็ด ทุกวันยกเว้นวันอาทิตย์"
  ])("does not let a newly added Thai activity NOUN shadow executable medication verbs: %s", source => {
    const parsed = parseSig(source);
    const dose = parsed.fhir[0];
    expect(dose.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(dose.method?.text).toBe("Take");
    expect(dose.route?.text).toBe("by mouth");
    expect(dose.timing?.repeat?.frequency).toBe(1);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(fromFhir(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).fhir[0]
      .doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
  });

  it("preserves a nominal medicine-taking activity after a NEGATED positional action", () => {
    const parsed = parseSig("ไม่ควรนอนราบทันทีหลังกินยา");
    const frames = parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions ?? []);
    expect(frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: expect.objectContaining({ lemma: "lie-down" }),
        polarity: "negate",
        relation: "after",
        args: expect.arrayContaining([
          expect.objectContaining({
            role: "activity", conceptId: "medication-administration"
          })
        ])
      })
    ]));
    expect(parsed.fhir[0].doseAndRate).toBeUndefined();
    expect(parsed.fhir[0].timing?.repeat?.when ?? []).not.toContain("IMD");
  });
});


/**
 * An action with WATER + BEFORE has two independent semantic relations:
 * material accompaniment and relative medication activity. Tests the typed
 * valence directly, including native graph serialization, not just a code
 * accidentally emitted from adjacent words or source spelling.
 */
describe("orthogonal material and clinical event valence survives strict FHIR", () => {
  const signatures = [
    { source: "Mix powder with water before taking",
      verb: "mix", material: "with", event: "before", entailed: true },
    { source: "Dissolve tablet in water before taking",
      verb: "dissolve", material: "in", event: "before", entailed: true },
    { source: "ผสมผงยากับน้ำก่อนรับประทาน",
      verb: "mix", material: "with", event: "before", entailed: true },
    { source: "Mix powder with water after taking",
      verb: "mix", material: "with", event: "after", entailed: false },
    { source: "Mix powder with water",
      verb: "mix", material: "with", event: undefined, entailed: false },
    { source: "Mix powder without water before taking",
      verb: "mix", material: "without", event: "before", entailed: false }
  ] as const;
  const code = "417995008";
  const specified = (dosage: FhirDosage): boolean =>
    dosage.additionalInstruction?.some(value =>
      value.coding?.some(coding => coding.code === code)) === true;

  it.each(signatures)("$source", ({ source, verb, material, event, entailed }) => {
    const parsed = parseSig(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const imported = fromFhir(toDosageDetails(strict));
    for (const sourceVersion of [parsed, imported]) {
      const action = sourceVersion.meta.canonical.clauses.flatMap(clause =>
        clause.instructionGraph?.actions ?? []).find(frame =>
        frame.predicate.lemma === verb);
      expect(action).toBeDefined();
      const fluid = action?.args.find(argument =>
        argument.role === "substance" && argument.conceptId === "water");
      expect(fluid).toBeDefined();
      // Either the head relation or an explicitly scoped argument relation
      // may own a material complement. Both are typed evidence; temporal
      // BEFORE is a separate activity daughter and MUST NOT replace material.
      expect(fluid?.relation ?? action?.relation).toBe(material);
      const events = action?.args.filter(argument =>
        argument.role === "activity" &&
        argument.conceptId === "medication-administration") ?? [];
      if (event) {
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ relation: event })
        ]));
      } else {
        expect(events).toHaveLength(0);
      }
    }
    for (const dosage of [parsed.fhir[0], strict[0], imported.fhir[0]]) {
      expect(specified(dosage)).toBe(entailed);
    }
    expect(strict[0].text).toBeTruthy();
  });
});


/**
 * Nonce substances are deliberately absent from the material terminology.
 * Typed valence is licensed by a WITH/IN complement, not by knowing "water".
 * Unknown material must remain editable and the independent event-relative
 * BEFORE must not vanish from patient-facing EN/TH realization.
 */
describe("unseen clinical materials preserve typed valence and event scope", () => {
  const examples = [
    { source: "Mix powder with zorvex liquid before taking", action: "mix",
      material: "zorvex liquid", relation: "with", locale: "en" },
    { source: "Dissolve tablet in asterwax solution before taking", action: "dissolve",
      material: "asterwax solution", relation: "in", locale: "en" },
    { source: "ผสมผงยากับสารละลายชนิดใหม่ก่อนรับประทาน", action: "mix",
      material: "สารละลายชนิดใหม่", relation: "with", locale: "th" }
  ] as const;
  it.each(examples)("$source", ({ source, action, material, relation, locale }) => {
    const parsed = parseSig(source);
    const rows = toFhirR5Dosages(parsed.fhirNext);
    const reloaded = fromFhir(toDosageDetails(rows));
    for (const version of [parsed, reloaded]) {
      const frame = version.meta.canonical.clauses.flatMap(clause =>
        clause.instructionGraph?.actions ?? []).find(value =>
        value.predicate.lemma === action);
      expect(frame).toBeDefined();
      const fluid = frame?.args.find(argument =>
        argument.role === "material" && argument.text === material);
      expect(fluid).toBeDefined();
      expect(fluid?.relation ?? frame?.relation).toBe(relation);
      expect(frame?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "activity", conceptId: "medication-administration",
          relation: "before"
        })
      ]));
    }
    for (const dosage of [parsed.fhir[0], rows[0], reloaded.fhir[0]]) {
      expect(dosage.additionalInstruction?.some(value =>
        value.coding?.some(coding => coding.code === "417995008"))).not.toBe(true);
    }
    const shown = formatSig(reloaded.fhirNext, "long", { locale });
    expect(shown).toContain(material);
    expect(shown).toMatch(/before|ก่อน/iu);
  });

  it("does not turn an unknown WITHOUT solvent into a positive WITH instruction", () => {
    const original = parseSig("Mix powder without zorvex liquid");
    const loaded = fromFhir(toDosageDetails(toFhirR5Dosages(original.fhirNext)));
    for (const version of [original, loaded]) {
      const frame = version.meta.canonical.clauses.flatMap(clause =>
        clause.instructionGraph?.actions ?? []).find(action =>
        action.predicate.lemma === "mix");
      const missingFluid = frame?.args.find(argument =>
        argument.role === "material" && argument.text === "zorvex liquid");
      expect(missingFluid).toBeDefined();
      expect(missingFluid?.relation ?? frame?.relation).toBe("without");
      expect(frame?.args.some(argument =>
        argument.role === "substance" && argument.conceptId === "water")).not.toBe(true);
    }
    expect(formatSig(loaded.fhirNext, "long", { locale: "en" }))
      .toMatch(/without zorvex liquid/iu);
  });
});


/**
 * Thai may elide the repeated meal head: "หลังอาหารเช้าหรือเย็น" is
 * after [meal breakfast OR meal dinner], not after breakfast OR at evening.
 * The bare "เช้าหรือเย็น" lacks that head and must remain time-of-day.
 * This exercises coordination ownership, not a dictionary substitution
 * for the word "เย็น".
 */
describe("Thai coordinated meal-head ellipsis preserves event type and scoped offset", () => {
  const cases = [
    { source: "กินยา 1 เม็ด ทันทีหลังอาหารเช้าหรือเย็น",
      when: [["PCM"], ["PCV"]], offsets: [0, 0],
      display: "หลังอาหารเย็น" },
    { source: "กินยา 1 เม็ด 15 นาทีก่อนอาหารเช้าหรือเย็น",
      when: [["ACM"], ["ACV"]], offsets: [15, 15],
      display: "ก่อนอาหารเย็น" },
    { source: "กินยา 1 เม็ด เช้าหรือเย็น",
      when: [["MORN"], ["EVE"]], offsets: [undefined, undefined],
      display: "ตอนเย็น" }
  ] as const;
  it.each(cases)("$source", ({ source, when, offsets, display }) => {
    const parsed = parseSig(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const fromRows = fromFhir(toDosageDetails(strict));
    for (const version of [parsed, fromRows]) {
      expect(version.fhir).toHaveLength(2);
      expect(version.fhir.map(row => row.timing?.repeat?.when)).toEqual(when);
      expect(version.fhir.map(row => row.timing?.repeat?.offset)).toEqual(offsets);
      expect(version.fhir.map(row =>
        row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([1, 1]);
      const choices = version.fhir.map(row => getDosageAlternativeChoice(row));
      expect(choices[0]?.selectionBehavior).toBe("exactly-one");
      expect(choices[0]?.groupId).toBe(choices[1]?.groupId);
      expect(choices[0]?.branchId).not.toBe(choices[1]?.branchId);
    }
    expect(strict).toHaveLength(2);
    const shown = formatSig(fromRows.fhirNext, "long", { locale: "th" });
    expect(shown).toContain(display);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


/**
 * A discourse adjunct explaining an already typed choice cannot retroactively
 * turn OR into AND, share offsets, or invent a course duration. The grammar
 * should retain an unresolved suffix as source-backed counseling if its exact
 * semantics are not otherwise modeled.
 */
describe("trailing choice-disambiguating language does not mutate executable alternatives", () => {
  const examples = [
    { base: "Inject 5 units 15 minutes before meals OR immediately after meals",
      suffix: ", whichever is possible" },
    { base: "Inject 5 units 15 minutes before meals OR immediately after meals",
      suffix: ", whichever works" },
    { base: "Inject 5 units 15 minutes before meals OR immediately after meals",
      suffix: ", not both" },
    { base: "Take 1 tablet 15 minutes before breakfast OR immediately after dinner",
      suffix: ", whichever is possible" }
  ] as const;
  const semanticCore = (rows: readonly FhirDosage[]) => rows.map(row => ({
    when: row.timing?.repeat?.when,
    offset: row.timing?.repeat?.offset,
    dose: row.doseAndRate?.[0]?.doseQuantity,
    selectionBehavior: getDosageAlternativeChoice(row)?.selectionBehavior,
    boundsDuration: row.timing?.repeat?.boundsDuration
  }));

  it.each(examples)("$base + $suffix", ({ base, suffix }) => {
    const reference = parseSig(base);
    const extended = parseSig(base + suffix);
    expect(reference.fhir).toHaveLength(2);
    expect(reference.fhir.map(row =>
      getDosageAlternativeChoice(row)?.selectionBehavior)).toEqual([
      "exactly-one", "exactly-one"
    ]);
    const referenceFacts = semanticCore(reference.fhir);
    expect(referenceFacts.map(row => row.offset)).toEqual([15, 0]);
    expect(referenceFacts.map(row => row.boundsDuration)).toEqual([undefined, undefined]);
    // No discourse adjunct may reinterpret either executable choice branch.
    expect(semanticCore(extended.fhir)).toEqual(referenceFacts);
    const strict = toFhirR5Dosages(extended.fhirNext);
    expect(semanticCore(strict)).toEqual(referenceFacts);
    const loaded = fromFhir(toDosageDetails(strict));
    expect(semanticCore(loaded.fhir)).toEqual(referenceFacts);
    expect(loaded.fhirNext.renderedInstruction).toBe(base + suffix);
  });
});


/**
 * Cross-unit source-provenance regression: day ordinals inside a recognized
 * but INVALID calendar cycle must remain calendar constituents, not unitless
 * administration doses. This checks source -> strict R5 -> R6 persistence.
 */
describe("unresolved calendar-cycle ordinal numbers never replace an explicit drug dose", () => {
  const quantities = [
    { surface: "0.5 tab", value: 0.5, unit: "tab" },
    { surface: "2 tabs", value: 2, unit: "tab" },
    { surface: "0.5 mL", value: 0.5, unit: "mL" },
    { surface: "3 mg", value: 3, unit: "mg" }
  ] as const;
  const invalidCycles = [
    { descriptor: "day outside 28-day cycle",
      source: "on days 1,29 every 28 days starting 28/9/2026 for 2 cycles",
      error: "day-outside-cycle" },
    { descriptor: "day zero in cycle",
      source: "on days 0,8 every 28 days starting 28/9/2026 for 2 cycles",
      error: "invalid-cycle-day-range" }
  ] as const;
  const scenarios = quantities.flatMap(quantity =>
    invalidCycles.map(cycle => ({ ...quantity, ...cycle }))
  );
  it.each(scenarios)("$surface, $descriptor", ({ surface, value, unit, source, error }) => {
    const input = "Take " + surface + " at 08:00 " + source;
    const parsed = parseSig(input);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const restored = fromFhir(toDosageDetails(strict));
    for (const version of [parsed, restored]) {
      expect(version.fhir).toHaveLength(1);
      const row = version.fhir[0];
      expect(row.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value, unit });
      expect(row.timing?.repeat?.period).toBeUndefined();
      expect(row.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
      // Sentence capitalization during realization does not change the
      // original clinical cycle wording or its editable source span.
      expect(row.text?.toLowerCase()).toContain(source.toLowerCase());
    }
    // A strict R5 import preserves the typed dose and source text, but its
    // canonical provenance is not a freshly parsed lexical evidence chart.
    const originalDose = parsed.meta.canonical.clauses[0]?.evidence.find(
      evidence => evidence.rule === "hpsg.lex.dose.numeric"
    );
    expect(originalDose?.spans.map(span => span.text)).toContain(surface);
    expect(strict[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value, unit });
    expect(parsed.warnings?.some(warning => warning.includes(error))).toBe(true);
    expect(lintSig(input).issues.some(issue =>
      issue.message.includes("Unresolved schedule"))).toBe(true);
  });
});


describe("shared HPSG active/rest duration daughters", () => {
  const start = "2026-11-02T00:00:00Z";
  const expected = [0, 14, 28].reduce<string[]>((dates, cycle) => dates.concat(
    Array.from({ length: 7 }, (_, day) =>
      new Date(Date.parse(start) + (cycle + day) * 86400000 + 8 * 3600000).toISOString())
  ), []);
  it.each([
    "Take 1 tablet at 08:00 for 7 days then stop for 7 days repeat for 3 cycles",
    "Take 1 tablet at 08:00 for a week; afterwards stop for seven days; and repeat for three cycles.",
    "Take 1 tablet at 08:00 for 1 week then discontinue for 7 days then repeat for 3 cycles.",
    "Take 1 tablet at 08:00 for seven days, after that stop for a week and repeat for three cycles.",
    "รับประทาน 1 เม็ด เวลา 08:00 เป็นเวลา 7 วัน จากนั้นหยุด 7 วัน แล้วทำซ้ำ 3 รอบ"
  ])("composes ordinary duration and action variants with exact dates: %s", source => {
    const cycles = recognizeCycles(source);
    expect(cycles).toHaveLength(1);
    const sign = cycles[0].sign!;
    expect(sign.type).toBe("recurring-course-phrase");
    expect(sign.construction).toMatchObject({
      operation: "repeat-course", headSide: "left",
      leftType: "schedule-sign", rightType: "schedule-sign"
    });
    expect(sign.fs.features.HEAD_DTR).toBe(sign.fs.features.LEFT_DTR);
    expect(sign.fs.features.NON_HEAD_DTR).toBe(sign.fs.features.RIGHT_DTR);
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.repeatCycle).toMatchObject({ value: 14, code: "d" });
    for (const dosage of [parsed.fhirNext, parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, {
        from: start, orderedAt: start, timeZone: "UTC", limit: 60
      }).map(date => new Date(date).toISOString())).toEqual(expected);
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 56, durationUnit: "d"
      })).toMatchObject({ totalUnits: 21, unit: "tab" });
    }
  });

  it("uses the shared cardinal and singular duration grammar for a longer course", () => {
    const source = "Take 1 tablet at 08:00 for two weeks then off for a week and repeat for two cycles.";
    const parsed = parseSig(source);
    const dates = [0, 21].reduce<string[]>((values, cycle) => values.concat(
      Array.from({ length: 14 }, (_, day) =>
        new Date(Date.parse(start) + (cycle + day) * 86400000 + 8 * 3600000).toISOString())
    ), []);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, {
        from: start, orderedAt: start, timeZone: "UTC", limit: 60
      }).map(date => new Date(date).toISOString())).toEqual(dates);
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 56, durationUnit: "d"
      }).totalUnits).toBe(28);
    }
  });

  it("keeps a single stop/restart gap distinct from repeated treatment", () => {
    const source = "Take 1 tablet at 08:00 for 7 days then stop for 7 days and resume 1 tablet at 08:00 for 7 days.";
    expect(recognizeCycles(source)).toEqual([]);
    const parsed = parseSig(source);
    const dates = nextDueDoses(parsed.fhirNext, {
      from: start, orderedAt: start, timeZone: "UTC", limit: 60
    }).map(date => new Date(date).toISOString());
    expect(dates).toEqual(expected.slice(0, 14));
    expect(calculateTotalUnits({
      dosage: parsed.fhirNext, from: start, orderedAt: start, timeZone: "UTC",
      durationValue: 56, durationUnit: "d"
    }).totalUnits).toBe(14);
  });
});


describe("HPSG modified duration nominals", () => {
  const start = "2026-11-02T00:00:00Z";
  const expectedDates = Array.from({ length: 14 }, (_, day) => day)
    .reduce<string[]>((dates, day) => dates.concat((day < 7 ? [8, 20] : [8]).map(hour =>
      new Date(Date.parse(start) + day * 86400000 + hour * 3600000).toISOString()
    )), []);
  const prefix = "Take 1 tablet at 08:00 and 20:00 for 7 days, then take 1 tablet at 08:00 ";
  it.each([
    [prefix + "for another 7 days.", 7, "d"],
    [prefix + "for another seven days.", 7, "d"],
    [prefix + "only for another 7 days.", 7, "d"],
    [prefix + "for another week.", 1, "wk"],
    [prefix + "for an additional week.", 1, "wk"],
    [prefix + "for 7 more days.", 7, "d"],
    ["รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 เป็นเวลา 7 วัน จากนั้นรับประทาน 1 เม็ด เวลา 08:00 เป็นเวลาอีก 7 วัน", 7, "d"]
  ] as const)("retains two scheduled finite phases for %s", (source, duration, durationUnit) => {
    const parsed = parseSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(clause => Boolean(clause.prn?.enabled))).toEqual([false, false]);
    expect(clauses.map(clause => clause.dose)).toMatchObject([
      { value: 1, unit: "tab" }, { value: 1, unit: "tab" }
    ]);
    expect(clauses[0].schedule).toMatchObject({ duration: 7, durationUnit: "d", timeOfDay: ["08:00:00", "20:00:00"] });
    expect(clauses[1].schedule).toMatchObject({ duration, durationUnit, timeOfDay: ["08:00:00"] });
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, {
        from: start, orderedAt: start, timeZone: "UTC", limit: 40
      }).map(date => new Date(date).toISOString())).toEqual(expectedDates);
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 21, durationUnit: "d"
      })).toMatchObject({ totalUnits: 21, unit: "tab" });
    }
  });

  it("keeps a genuine PRN successor separate from a quantified duration", () => {
    const source = prefix + "as needed for pain.";
    const parsed = parseSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses.map(clause => Boolean(clause.prn?.enabled))).toEqual([false, true]);
    expect(clauses[0].schedule).toMatchObject({ duration: 7, durationUnit: "d" });
    expect(clauses[1].schedule?.duration).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("HPSG calendar clock ellipsis", () => {
  const start = "2026-11-02T00:00:00Z";
  const options = { from: start, orderedAt: start, timeZone: "UTC" };
  const dates = Array.from({ length: 7 }, (_, day) =>
    new Date(Date.parse(start) + day * 86400000 + 8 * 3600000).toISOString());
  function evaluateDay(condition: import("../src").MedicationCondition, at: string): boolean {
    if (condition.kind === "not") return !evaluateDay(condition.condition, at);
    if (condition.kind === "all") return condition.conditions.every(part => evaluateDay(part, at));
    if (condition.kind === "any") return condition.conditions.some(part => evaluateDay(part, at));
    return [1, 3, 5].includes(new Date(at).getUTCDay());
  }
  it.each([
    ["Take 1 tablet at 08:00 on Mondays, Wednesdays, Fridays; half a tablet on other days.", 5],
    ["Take 1 tablet at 08:00 on weekdays and half a tablet on weekends.", 6],
    ["รับประทาน 1 เม็ด เวลา 08:00 วันจันทร์ พุธ ศุกร์ และครึ่งเม็ด วันอื่น", 5],
    ["Take 1 tablet at 08:00 on dialysis days and half a tablet on other days.", 5],
    ["Take 1 tablet at 08:00 on Monday Wednesday Friday and 2 tablets at 08:00 on Tuesdays and half a tablet on other days.", 6.5]
  ] as const)("inherits the shared clock across calendar alternatives: %s", (source, total) => {
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses.every(clause =>
      JSON.stringify(clause.schedule?.timeOfDay) === JSON.stringify(["08:00:00"]))).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: evaluateDay, limit: 7 })
        .map(date => new Date(date).toISOString())).toEqual(dates);
      expect(calculateTotalUnits({ dosage, ...options, evaluateCondition: evaluateDay,
        durationValue: 7, durationUnit: "d" }).totalUnits).toBe(total);
    }
  });

  it("preserves an explicit contrasting clock on the recipient", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 on Monday Wednesday Friday and half a tablet at 20:00 on other days.");
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.timeOfDay))
      .toEqual([["08:00:00"], ["20:00:00"]]);
    const expected = Array.from({ length: 7 }, (_, day) =>
      new Date(Date.parse(start) + day * 86400000 + ([0, 2, 4].includes(day) ? 8 : 20) * 3600000).toISOString());
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...options, limit: 7 }).map(date => new Date(date).toISOString()))
        .toEqual(expected);
    }
  });

  it("does not choose between conflicting antecedent clocks", () => {
    const source = "Take 1 tablet at 08:00 on Monday Wednesday Friday and 2 tablets at 20:00 on Tuesdays and half a tablet on other days.";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.timeOfDay))
      .toEqual([["08:00:00"], ["20:00:00"], undefined]);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("preserves an explicit clock in a successor phase", () => {
    const parsed = parseSig("Take 1 tablet at 08:00 on weekdays for 7 days, then take half a tablet at 20:00 on weekends.");
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.meta.canonical.clauses[1].schedule?.timeOfDay).toEqual(["20:00:00"]);
  });
});


describe("HPSG day-domain predicate typing", () => {
  it.each([
    ["Take 1 tablet at 08:00 daily if it is a dialysis day.", "text"],
    ["Take 1 tablet at 08:00 daily only if it is a dialysis day and it is a treatment day.", "all"],
    ["Take 1 tablet at 08:00 daily only if it is a dialysis day or it is a treatment day.", "any"],
    ["Take 1 tablet at 08:00 daily unless it is a dialysis day.", "not"],
    ["Take 1 tablet at 08:00 daily only if not a dialysis day.", "not"],
    ["รับประทาน 1 เม็ด เวลา 08:00 เมื่อเป็นวันฟอกไต", "text"],
    ["Take 1 tablet at 08:00 daily; hold the morning dose if it is a dialysis day.", "not"]
  ] as const)("retains day-domain meaning through predicate composition: %s", (source, kind) => {
    const parsed = parseSig(source);
    const clinical = parsed.meta.canonical.clauses.find(clause => clause.clinicalAdjuncts?.condition)?.clinicalAdjuncts;
    expect(clinical?.condition?.kind).toBe(kind);
    expect(clinical?.calendarDayCondition).toEqual(clinical?.condition);
    expect(clinical?.calendarDayCondition).toBeDefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    ["Take 1 tablet at 08:00 daily only if it is a dialysis day and heart rate is above 50.", "all"],
    ["Take 1 tablet at 08:00 daily only if dizzy or it is a dialysis day.", "any"],
    ["Take 1 tablet at 08:00 daily only if weight increases by 2 kg over 3 days.", "text"]
  ] as const)("keeps changing predicates outside the whole-day domain: %s", (source, kind) => {
    const parsed = parseSig(source);
    const clinical = parsed.meta.canonical.clauses.find(clause => clause.clinicalAdjuncts?.condition)?.clinicalAdjuncts;
    expect(clinical?.condition?.kind).toBe(kind);
    expect(clinical?.calendarDayCondition).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});


describe("clinical finite withholding courses", () => {
  const start = "2026-11-02T00:00:00Z";
  const day = 86400000;
  const expected = [0, 14].reduce<string[]>((dates, phase) => dates.concat(
    Array.from({ length: 7 }, (_, offset) => offset).reduce<string[]>((phaseDates, offset) =>
      phaseDates.concat([8, 20].map(hour =>
        new Date(Date.parse(start) + (phase + offset) * day + hour * 3600000).toISOString()
      )), [])
  ), []);
  it.each([
    "STOP for 7 days", "HOLD for 7 days", "STOP x7d", "HOLD x7d", "HOLD x1wk"
  ])("retains the actual seven-day gap through every public representation: %s", pause => {
    const source = `1 tab PO at 08:00 and 20:00 x7d, then ${pause}, then 1 tab PO at 08:00 and 20:00 x7d`;
    const parsed = parseSig(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.treatmentPause?.durationDays).toBe(7);
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBe(14);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, {
        from: start, orderedAt: start, timeZone: "UTC", limit: 80
      }).map(value => new Date(value).toISOString())).toEqual(expected);
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 28, durationUnit: "d" }).totalUnits).toBe(28);
    }
  });
  it.each(["hold your breath for 7 seconds", "do not hold for 7 days"])(
    "keeps a physical or negative directive out of medication-pause valence: %s", directive => {
      const parsed = parseSig(`1 tab PO at 08:00 and 20:00 x7d, then ${directive}, then 1 tab PO at 08:00 and 20:00 x7d`);
      expect(parsed.meta.canonical.clauses.some(clause => clause.clinicalAdjuncts?.treatmentPause)).toBe(false);
      const contiguous = Array.from({ length: 14 }, (_, offset) => offset).reduce<string[]>((dates, offset) =>
        dates.concat([8, 20].map(hour => new Date(Date.parse(start) + offset * day + hour * 3600000).toISOString())), []);
      for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
        expect(nextDueDoses(dosage, { from: start, orderedAt: start, timeZone: "UTC", limit: 80 })
          .map(value => new Date(value).toISOString())).toEqual(contiguous);
      }
    }
  );
});

describe("clinical weekday abbreviation constituents", () => {
  const start = "2026-11-02T00:00:00Z";
  it.each(["MWF", "mwf", "M/W/F"])("keeps the named and remaining day domains disjoint: %s", weekdays => {
    const source = `1 tab PO ${weekdays} 08:00; 0.5 tab PO other days 08:00`;
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.dayOfWeek)).toEqual([
      ["mon", "wed", "fri"], ["tue", "thu", "sat", "sun"]
    ]);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const expected = Array.from({ length: 28 }, (_, day) =>
      new Date(Date.parse(start) + day * 86400000 + 8 * 3600000).toISOString());
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, { from: start, orderedAt: start, timeZone: "UTC", limit: 28 })
        .map(value => new Date(value).toISOString())).toEqual(expected);
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 28, durationUnit: "d" }).totalUnits).toBe(20);
    }
  });
});


describe("Thai clock suffix ownership", () => {
  const start = "2026-11-02T00:00:00Z";
  it.each([
    "รับประทาน 1 เม็ด เวลา 08:00, 20:00 น. x7d",
    "รับประทาน 1 เม็ด เวลา 08:00 และ 20:00 น. นาน 7 วัน",
    "รับประทาน 1 เม็ด เวลา 08:00 น. และ 20:00 น. เป็นเวลา 7 วัน"
  ])("keeps the finite course after a clock abbreviation: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      timeOfDay: ["08:00:00", "20:00:00"], duration: 7, durationUnit: "d"
    });
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const expected = Array.from({ length: 7 }, (_, offset) => offset).reduce<string[]>((dates, offset) =>
      dates.concat([8, 20].map(hour => new Date(Date.parse(start) + offset * 86400000 + hour * 3600000).toISOString())), []);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, { from: start, orderedAt: start, timeZone: "UTC", limit: 60 })
        .map(value => new Date(value).toISOString())).toEqual(expected);
      expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 28, durationUnit: "d" }).totalUnits).toBe(14);
    }
  });
});


describe("PRN and typed guard constituent ownership", () => {
  const start = "2026-11-02T00:00:00Z";
  const iso = (day: number, hour: number) =>
    new Date(Date.parse(start) + day * 86400000 + hour * 3600000).toISOString();
  it.each(["PRN if", "as needed if", "PRN only if"])(
    "keeps the clinical guard separate from the PRN reason for %s", lead => {
      const source = `1 tab PO at 08:00 x14d; 0.5 tab PO at 20:00 ${lead} SBP >160`;
      const parsed = parseSig(source);
      const clauses = parsed.meta.canonical.clauses;
      expect(clauses).toHaveLength(2);
      expect(clauses[0].clinicalAdjuncts?.condition).toBeUndefined();
      expect(clauses[1].clinicalAdjuncts?.condition).toMatchObject({
        kind: "measurement", name: "sbp", operation: "gt", value: 160
      });
      expect(clauses[1].prn).toMatchObject({ enabled: true });
      expect(clauses[1].prn?.reason).toBeUndefined();
      expect(clauses.map(clause => clause.dose?.value)).toEqual([1, 0.5]);
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      const strict = toFhirR5Dosages(parsed.fhirNext);
      for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
        for (const permission of [false, true]) {
          const expected = permission ? [iso(0, 8), iso(0, 20), iso(1, 8), iso(1, 20)] :
            [iso(0, 8), iso(1, 8), iso(2, 8), iso(3, 8)];
          expect(nextDueDoses(dosage, { from: start, orderedAt: start, timeZone: "UTC",
            evaluateCondition: () => permission, limit: 4 }).map(value => new Date(value).toISOString()))
            .toEqual(expected);
        }
      }
    }
  );
  it("retains an ordinary symptom PRN reason", () => {
    const parsed = parseSig("0.5 tab PO at 20:00 PRN if pain");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.prn).toMatchObject({ enabled: true, reason: { text: "pain" } });
    expect(clause.clinicalAdjuncts?.condition).toBeUndefined();
    expect(parsed.fhir[0].asNeeded).toBe(true);
  });
});


describe("clinical Thai directive polarity", () => {
  const start = "2026-11-02T00:00:00Z";
  const cases = [
    {
      source: "Take 1 tablet orally twice daily after breakfast and dinner. กินหลังอาหารทันที ดื่มน้ำตามมากๆ ไม่ควรจะนอนราบทันทีหลังกินยา กินต่อเนื่องจนหมด.",
      fragment: "ไม่ควรจะนอนราบ", lemma: "lie-down", modality: "should",
      english: "Should not lie down", supply: 56
    },
    {
      source: "1 tab PO BID x7d; อย่านอนราบทันทีหลังกินยา",
      fragment: "อย่านอนราบ", lemma: "lie-down", modality: undefined,
      english: "Do not lie down", supply: 14
    },
    {
      source: "5 mL PO TID pc x5d; เขย่าขวดก่อนใช้ ตวงยาด้วยไซริงค์ อย่าใช้ช้อนกินข้าว",
      fragment: "อย่าใช้ช้อนกินข้าว", lemma: "use", modality: undefined,
      english: "Do not use household spoon", supply: 75
    },
    {
      source: "ทาบางๆ บริเวณผื่น วันละ 2 ครั้ง x7วัน; ล้างมือหลังทา อย่าทาเข้าตา",
      fragment: "อย่าทาเข้าตา", lemma: "apply", modality: undefined,
      english: "Do not apply into the eye", supply: undefined
    },
    {
      source: "หยอดตาขวา 1 หยด วันละ 4 ครั้ง x7วัน; ระวังอย่าให้ปลายขวดสัมผัสตา ปิดฝาหลังหยอด",
      fragment: "ระวังอย่าให้ปลายขวดสัมผัสตา", lemma: "touch", modality: undefined,
      english: "Do not touch bottle tip to the eye", supply: 28
    },
    {
      source: "1 drop OD QID x7d; ห้ามให้ปลายหลอดสัมผัสดวงตา",
      fragment: "ห้ามให้ปลายหลอดสัมผัสดวงตา", lemma: "touch", modality: undefined,
      english: "Do not touch tube tip to ดวงตา", supply: 28
    }
  ];
  it.each(cases)("preserves negative advice, its participants and the medication: $fragment", entry => {
    const parsed = parseSig(entry.source);
    const actions = parsed.meta.canonical.clauses.flatMap(clause => clause.instructionGraph?.actions ?? []);
    const action = actions.find(value => value.sourceText.includes(entry.fragment));
    expect(action).toMatchObject({ predicate: { lemma: entry.lemma }, polarity: "negate" });
    expect(action?.modality).toBe(entry.modality);
    expect(parsed.input).toBe(entry.source);
    expect(parsed.fhirNext.renderedInstruction).toBe(entry.source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : dosage.step.flatMap(step => step.component);
      const copiedActions = rows.flatMap(row => parseInstructionGraphExtension(row.extension)?.actions ?? []);
      const copied = copiedActions.find(value => value.sourceText.includes(entry.fragment));
      expect(copied).toMatchObject({ predicate: { lemma: entry.lemma }, polarity: "negate" });
      expect(copied?.modality).toBe(entry.modality);
      expect(copied?.args).toMatchObject(action?.args ?? []);
      expect(rows.every(row => row.asNeeded !== true && !getDosageCondition(row))).toBe(true);
      if (entry.supply !== undefined) {
        expect(calculateTotalUnits({ dosage, from: start, orderedAt: start, timeZone: "UTC",
          durationValue: 28, durationUnit: "d" }).totalUnits).toBe(entry.supply);
      } else {
        expect(rows).toHaveLength(1);
        expect(rows[0].doseAndRate).toBeUndefined();
        const site = Array.isArray(dosage) ? dosage[0].site : dosage.step[0].component[0].site?.concept;
        expect(site?.text).toBe("rash");
        expect(rows[0].route?.coding?.[0].code).toBe("6064005");
        expect(rows[0].timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d",
          boundsDuration: { value: 7, code: "d" } });
      }
      if (entry.lemma === "touch") {
        const site = Array.isArray(dosage) ? dosage[0].site : dosage.step[0].component[0].site?.concept;
        expect(site?.coding?.[0].code).toBe("1290032005");
      }
      expect(rows.map(row => formatSig(row, "long", { locale: "en" })).join(" ")).toContain(entry.english);
      expect(rows.map(row => formatSig(row, "long", { locale: "th" })).join(" ")).toContain(entry.fragment);
    }
    if (entry.lemma === "touch") {
      expect(action?.args[0]).toMatchObject({ role: "theme" });
      expect(action?.args[1].text).toMatch(/ตา/u);
      expect(actions.some(value => value.predicate.lemma === "give")).toBe(false);
      expect(actions.filter(value => value.predicate.lemma === "touch"))
        .toEqual([action]);
    }
    if (entry.source.includes("ปิดฝาหลังหยอด")) {
      const recap = actions.find(value => value.predicate.lemma === "recap");
      expect(recap).toBeDefined();
      expect(recap?.polarity).not.toBe("negate");
    }
    if (entry.fragment.includes("ช้อนกินข้าว")) {
      expect(action?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "object", conceptId: "household-spoon", text: "ช้อนกินข้าว" })
      ]));
      expect(actions.some(value => value.sourceText === "กินข้าว")).toBe(false);
    }
  });

  it.each(["ไม่ควรจะนอนราบหลังรับประทานยา", "อย่าทาเข้าตา"])(
    "does not spread the negative directive to the next action: %s", warning => {
      const medication = warning.includes("ทา") ? "ทาบางๆ บริเวณผื่น วันละ 2 ครั้ง x7วัน" : "1 tab PO BID x7d";
      const parsed = parseSig(medication + "; " + warning + "; ล้างมือ");
      const actions = parsed.meta.canonical.clauses.flatMap(clause => clause.instructionGraph?.actions ?? []);
      expect(actions.find(action => action.sourceText.includes(warning))?.polarity).toBe("negate");
      const wash = actions.find(action => action.predicate.lemma === "wash");
      expect(wash).toBeDefined();
      expect(wash?.polarity).not.toBe("negate");
      expect(parsed.fhir[0].timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    }
  );

  it("keeps an affirmative positional instruction affirmative", () => {
    const parsed = parseSig("1 tab PO BID x7d; นอนราบหลังรับประทานยา");
    const actions = parsed.meta.canonical.clauses.flatMap(clause => clause.instructionGraph?.actions ?? []);
    const position = actions.find(action => action.predicate.lemma === "lie-down");
    expect(position).toBeDefined();
    expect(position?.polarity).not.toBe("negate");
    expect(calculateTotalUnits({ dosage: parsed.fhirNext, from: start, orderedAt: start, timeZone: "UTC",
      durationValue: 28, durationUnit: "d" }).totalUnits).toBe(14);
  });
});


describe("registered clinical notification advice", () => {
  it("keeps a conditional notification out of the medication administration", () => {
    const source = "1 tab PO at 07:00,12:00,18:00 x7d; รับประทานก่อนอาหาร หากคลื่นไส้ให้แจ้งแพทย์";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : dosage.step.flatMap(step => step.component);
      expect(rows).toHaveLength(1);
      expect(rows[0].asNeeded).not.toBe(true);
      expect(getDosageCondition(rows[0])).toBeUndefined();
      expect(rows[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
      expect(rows[0].timing?.repeat?.timeOfDay).toEqual(["07:00:00", "12:00:00", "18:00:00"]);
      const graph = parseInstructionGraphExtension(rows[0].extension);
      const actions = graph?.actions ?? [];
      expect(actions.some(action => action.predicate.lemma === "give")).toBe(false);
      const notify = actions.find(action => action.predicate.lemma === "notify");
      expect(notify).toBeDefined();
      expect(graph?.relations?.filter(relation => relation.kind === "if")).toEqual([
        expect.objectContaining({ toActionIndex: actions.indexOf(notify!) })
      ]);
      expect(notify?.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "object", conceptId: "doctor", text: "แพทย์" })
      ]));
      const english = formatSig(rows[0], "long", { locale: "en" }).toLowerCase();
      expect(english).toContain("notify doctor");
      expect(english).toContain("nausea");
      expect(english).not.toContain("give");
      expect(formatSig(rows[0], "long", { locale: "th" })).toContain("หากคลื่นไส้ให้แจ้งแพทย์");
    }
  });
});


describe("full review HPSG ownership corrections", () => {
  it("does not turn ordinary missed-dose advice into a condition on the standing daily dose", () => {
    const source = "Take 1 tablet daily. If you miss a dose, take it as soon as you remember.";
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.condition).toBeUndefined();
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionScopes).toHaveLength(1);
    expect(clause.instructionScopes![0].target.start).toBe(source.indexOf("take it"));
    const graph = clause.instructionGraph!;
    const condition = graph.relations.find(relation => relation.kind === "if")!;
    expect(condition.text).toMatch(/^If you miss a dose,?$/u);
    expect(graph.actions[condition.toActionIndex!].predicate.lemma).toBe("take");
    expect(graph.actions.some(action => action.predicate.lemma === "miss" ||
      action.predicate.lemma === "withhold-administration" && action.sourceText?.startsWith("miss")))
      .toBe(false);
    for (const dosage of [parsed.fhirNext, parsed.fhir,
      toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      const rows = Array.isArray(dosage) ? dosage : toFhirR5Dosages(dosage);
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
      expect(getDosageCondition(rows[0])).toBeUndefined();
      expect(calculateTotalUnits({ dosage, ...supply, durationValue: 7 }).totalUnits).toBe(7);
    }
  });

  it.each(["omit", "skip", "withhold"])("keeps a genuine %s instruction attached to the stated BP condition", action => {
    const parsed = parseSig(`1 tab PO QD; ${action} if SBP <100`);
    const condition = getDosageCondition(parsed.fhir[0]);
    expect(condition).toMatchObject({ kind: "not", condition: {
      kind: "measurement", name: "sbp", operation: "lt", value: 100
    } });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhir[0].timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });

  it.each([
    "1 drop OD QID; 2 drops OS BID",
    "1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID"
  ])("keeps explicit eye-site ranges absolute across later segments: %s", source => {
    const parsed = parseSig(source);
    const explicitSites = parsed.meta.canonical.clauses.filter(clause => clause.site?.range);
    expect(explicitSites).toHaveLength(2);
    for (const [index, token] of ["OD", "OS"].entries()) {
      const range = explicitSites[index].site!.range!;
      expect(range).toEqual({ start: source.indexOf(token), end: source.indexOf(token) + token.length });
      expect(source.slice(range.start, range.end)).toBe(token);
    }
    expect(explicitSites.map(clause => clause.site?.text)).toEqual(["right eye", "left eye"]);
    expect(explicitSites.map(clause => clause.dose?.value)).toEqual(source.includes("2 drops") ? [1, 2] : [1, 1]);
  });
});


describe("equivalent written half-tablet doses", () => {
  it.each(["½", "1/2", "0.5"])("keeps %s as the prescribed half tablet", fraction => {
    const source = `${fraction} tab PO BID x7d`;
    const parsed = parseSig(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : toFhirR5Dosages(dosage);
      expect(rows).toHaveLength(1);
      expect(rows[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 0.5, unit: "tab" });
      expect(rows[0].timing?.repeat).toMatchObject({ frequency: 2,
        boundsDuration: { value: 7, code: "d" } });
      expect(calculateTotalUnits({ dosage, ...supply, durationValue: 28 }).totalUnits).toBe(7);
    }
  });
});
