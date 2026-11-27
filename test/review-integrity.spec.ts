import r6SnapshotContract from "../fhir/r6/official-snapshot1-20261113-contract.json";
import {
  EventTiming,
  formatParseBatch,
  fromDosageDetails,
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
  EMA_QUANTITY_OPERATOR_SYSTEM,
  getEmaQuantityComparator,
  setDosageCondition,
  type FhirR6Dosage,
  registerMedicationLocaleDetector,
  inferMedicationLocale,
  registerInstructionActionLocaleAdapter,
  getInstructionActionLocaleAdapter,
  registerMedicationLexerLocalePack,
  getMedicationLexerLocalePack,
  listMedicationLocaleLexemes,
  registerMedicationSurfaceSegmenter,
  listMedicationSurfaceSegmenters,
  getSuggestLocaleAdapter,
  registerSuggestLocaleAdapter,
  type CourseLanguage
} from "../src/index";
import {
  getTimingClocks,
  canonicalFromFhir,
  canonicalToFhir,
  TIMING_OCCURRENCE_CAP_EXTENSION_URL,
  cycleDayConstraintExtension,
  TIMING_CLOCK_WINDOW_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL
} from "../src/fhir";
import {
  decodeR5RetainedFields
} from "../src/dosage-course";
import {
  AdviceArgumentRole,
  type FormatOptions,
  AdviceRelation,
  type CanonicalSigClause,
  AdviceForce
} from "../src/types";
import {
  realizeInstructionAction
} from "../src/instruction-graph";
import {
  resolveSigLocalization,
  registerSigLocalization
} from "../src/i18n";
import {
  formatCanonicalClause
} from "../src/format";
import { numericAdministrationLimits } from "../src/canonical/course";
import { simpleQuantityForR5, getQuantityComparator } from "../src/fhir-quantity-operator";
import { cloneStructuredValue } from "../src/stable-structure";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  parseSig, parseSigAsync, lintSig, fromFhir, fromFhirDosage, toDosageDetails, toFhirR5Dosages,
  calculateTotalUnits, nextDueDoses, formatSig, getDosageCondition, FhirPeriodUnit, evaluateMedicationCondition,
  getDosageAlternativeChoice, importCanonicalCourse, projectCanonicalCourse, parseInstructionActions,
  type FhirDosage, type FhirR6DosageInstruction, type EzDosage, type FhirExtension
} from "../src";
import {
  DOSAGE_CONDITION_R5_URL, DOSAGE_CONDITION_R6_LOGIC_URL,
  DOSAGE_DETAILS_R5_URL, DOSAGE_EXCLUDED_DATES_R5_URL,
  DOSAGE_RECONCILIATION_SOURCE_URL, DOSAGE_RECONCILIATION_WARNING_URL, DOSAGE_RENDERED_INSTRUCTION_R5_URL
} from "../src/dosage-course";
import { recognizeCycles } from "../src/hpsg/rules/timing-rules";
import { parseClauseState } from "../src/parser";
import {
  buildCanonicalParallelRegimen
} from "../src/regimen/parallel-course";
import { buildRegimenGraph } from "../src/regimen/regimen";
import { courseFromParallel } from "../src/canonical/compile";
import type { BoundaryPlan } from "../src/hpsg/signature";
import type { HpsgSigSegment } from "../src/hpsg/segmenter";
import { BODY_SITE_RESTRICTION_EXTENSION_URL } from "../src/fhir";
import { BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL } from "../src/body-site-target";

const beginning = "2026-10-19T08:00:00+07:00";
const scheduler = {
  from: beginning, orderedAt: beginning, timeZone: "Asia/Bangkok", limit: 14
};
const supply = {
  ...scheduler, durationValue: 30, durationUnit: "d" as const
};
const parallel = "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";

describe("external review: FHIR R5/R6 and medication correctness", () => {
  it("checks the public R5 and current R6 contracts with strict TypeScript", () => {
    const program = ts.createProgram([
      "./generation-roundtrip.spec.ts", "./opd-dogfood.spec.ts", "./parser.spec.ts",
      "./terminology-coverage.spec.ts", "./thai-review-followup.spec.ts",
      "./date-interpretation.spec.ts",
    ]
      .map(name => fileURLToPath(new URL(name, import.meta.url))), {
      noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2015,
      module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true, resolveJsonModule: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: name => name, getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => "\n",
    })).toBe("");
  }, 30000);

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
    const simple: FhirR6DosageInstruction = {
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
      const imported = fromFhirDosage(original, { realizationMode: "roundtrip" });
      expect(original).toEqual(unchanged);
      expect(imported.fhir).toEqual(unchanged);
      expect(imported.fhir.doseAndRate).toMatchObject([{
        doseQuantity: { value: 1, unit: "tab" }
      }]);
      expect(imported.fhir.timing?.repeat).toMatchObject({
        frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day
      });
      expect(imported.fhir.doseAndRate).toEqual(original.doseAndRate);
      expect(imported.fhir.timing).toEqual(original.timing);
      expect(imported.fhir.modifierExtension).toEqual([modifier]);
      expect(imported.meta.canonical.clauses[0].rawText).toBe(text);
      // The modifier changes the clinical projection, so even roundtrip
      // renders structured facts while preserving the complete source.
      expect(imported.longText).toBe("Current: Use 1 tablet twice daily; original directions: " + text);
      for (const value of [1, 2]) {
        const current = JSON.parse(JSON.stringify(original)) as FhirDosage;
        current.doseAndRate![0].doseQuantity!.value = value;
        const expected = JSON.parse(JSON.stringify(current));
        for (const mode of [undefined, "normalized", "roundtrip"] as const) {
          const submitted = JSON.parse(JSON.stringify(current)) as FhirDosage;
          const normalized = fromFhirDosage(submitted,
            mode === undefined ? undefined : { realizationMode: mode });
          const currentText = value === 1 ? "Use 1 tablet twice daily" : "Use 2 tablets twice daily";
          expect(normalized.longText).toBe("Current: " + currentText + "; original directions: " + text);
          expect(submitted).toEqual(expected);
          expect(normalized.fhir).toEqual(expected);
          expect(normalized.meta.canonical.clauses[0].rawText).toBe(text);
        }
      }
      const course: FhirR6DosageInstruction = {
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
    let edited = JSON.parse(JSON.stringify(original.fhir)) as FhirDosage[];
    const initial = calculateTotalUnits({ ...supply, dosage: edited });
    expect(initial.totalUnits).toBe(296);
    edited = structuredClone(edited);
    edited[3].timing!.repeat!.frequency = 3;
    // Both external facts remain recoverable, but QID and a live TID repeat
    // conflict. Execution requires resolving that contradiction explicitly.
    const reconciled = toDosageDetails(edited);
    expect(reconciled.step[1].component[1].timing?.repeat?.frequency).toBe(3);
    expect(reconciled.step[1].component[1].timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(reconciled.renderedInstruction).toBeUndefined();
    expect(reconciled.extension).toContainEqual(expect.objectContaining({
      url: DOSAGE_RECONCILIATION_WARNING_URL
    }));
    expect(() => calculateTotalUnits({ ...supply, dosage: edited }))
      .toThrow("The timing code conflicts with the complete repeat recurrence");
    expect(() => nextDueDoses(edited, {
      ...scheduler, from: "2026-10-27T08:00:00+07:00"
    })).toThrow("The timing code conflicts with the complete repeat recurrence");
    edited = structuredClone(edited);
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
    let edited = JSON.parse(JSON.stringify(base)) as FhirDosage;
    edited.timing!.repeat!.frequency = 3;
    expect(() => nextDueDoses(edited, options))
      .toThrow("The timing code conflicts with the complete repeat recurrence");
    expect(edited.timing?.code?.coding?.[0]?.code).toBe("QID");
    edited = structuredClone(edited);
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
    const restored = toDosageDetails(saved);
    expect(restored).toMatchObject(JSON.parse(JSON.stringify(parsed.fhirNext)));
    expect(restored.renderedInstruction).toBe(parsed.fhirNext.renderedInstruction);
    expect(restored.step[0].component[0].route?.coding?.[0]?.version).toBe("2023");
    expect(restored.extension?.some(extension => extension.url === DOSAGE_RECONCILIATION_WARNING_URL)).not.toBe(true);
    expect(calculateTotalUnits({ ...supply, dosage: saved }).totalUnits).toBe(296);
  });

  it("preserves source wording through unchanged ordinary dosage conversion", () => {
    const original = parseSig("1 tab PO BID").fhirNext;
    const plain = toFhirR5Dosages(original);
    const untouched = toDosageDetails(JSON.parse(JSON.stringify(plain)));
    expect(untouched.renderedInstruction).toBe(original.renderedInstruction);
  });

  it.each([
    ["apply 1 mL to scalp where affected", ["Apply 1 mL to the scalp where affected."]],
    ["apply 1 mL to scalp where there is hair loss", ["Apply 1 mL to the scalp where there is hair loss."]],
    ["1 tab PO BID", ["Take 1 tablet orally twice daily."]],
    ["1 drop OU BID", ["Instill 1 drop twice daily in both eyes."]],
    ["1 drop OD q2h x7d then QID; 1 drop OS QID x1mo then BID", [
      "From treatment start until 7 days after treatment start", "Instill 1 drop every 2 hours in the right eye", "Instill 1 drop four times daily for 1 month in the left eye",
      "From 7 days after treatment start until 1 month after treatment start",
      "Instill 1 drop four times daily in the right eye", "Instill 1 drop four times daily in the left eye",
      "From 1 month after treatment start onward",
      "Instill 1 drop four times daily in the right eye", "Instill 1 drop twice daily in the left eye",
    ]],
  ] as const)("retains exact source and previews current fields for an unchanged projection: %s", (source, expected) => {
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
    for (const identity of projectionIdentities) {
      expect(identity).toMatch(/^clinical-v2:[0-9a-f]{16}$/);
    }
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
    const preview = formatSig(unchanged, "long");
    const complete = expected.length === 1 ? expected[0] :
      expected[0] + ": " + expected[1] + "; " + expected[2] + ". " +
      expected[3] + ": " + expected[4] + "; " + expected[5] + ". " +
      expected[6] + ": " + expected[7] + "; " + expected[8] + ".";
    expect(preview).toBe(complete);
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

  it("deletes a component and its local expression without resurrecting either from other rows", () => {
    const original = parseSig(parallel).fhirNext;
    const edited: FhirR6DosageInstruction = JSON.parse(JSON.stringify(original));
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
    expect(restored.renderedInstruction).toBeUndefined();
    expect(edited.step[0].component[0].doseAndRate![0].doseExpression?.expression).toBe("%patient.weight * 0.5");
    expect(toDosageDetails(toFhirR5Dosages(restored)).step).toEqual(restored.step);
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
    const original: FhirR6DosageInstruction = {
      renderedInstruction: "One drop in each eye twice daily",
      step: [{ component: [
        {
          id: "right-eye",
          site: {
            concept: { text: "right eye" },
            reference: { reference: "BodyStructure/right-eye" }
          },
          timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
          // An expression-only choice is valid R6 and requires retained R5 semantics.
          doseAndRate: [{
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
    expect(right.doseAndRate?.[0].doseQuantity).toBeUndefined();
    const imported = fromFhir(restored);
    const currentRight = imported.meta.canonical.course!.stages[0].administrations.find(
      administration => administration.siteReference?.reference === "BodyStructure/right-eye")!;
    expect(currentRight.amounts![0].expression?.expression).toBe("one right-eye drop");
    expect(currentRight.amounts![0].quantity).toBeUndefined();
    expect(restored.renderedInstruction).not.toBe(original.renderedInstruction);
  });

  it("retains superseded R6 dose expressions only as inert provenance after a numeric R5 edit", () => {
    const full: FhirR6DosageInstruction = {
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
    const original: FhirR6DosageInstruction = {
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
    const original: FhirR6DosageInstruction = {
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
    const details: FhirR6DosageInstruction = {
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
      explanation: expect.stringMatching(/full lifetime maximum.*no prior administrations/i)
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
    expect(regimen.kind).toBe("resolved");
    if (regimen.kind === "resolved") {
      const canonical = courseFromParallel(regimen, values.map(value => value.primaryClause.rawText),
        "multiple independent plans");
      const projection = projectCanonicalCourse(canonical).fhirNext;
      expect(projection.step[0].component).toHaveLength(4);
      expect(projection.step.map(step => step.end?.offsetDuration?.value))
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

  it("preserves unknown nested FHIR content with immutable-by-contract zero-copy outputs", () => {
    const shared: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }],
      extension: [{ url: "urn:test:unknown", extension: [{ url: "detail", valueString: "retain" }] }]
    };
    const input: FhirR6DosageInstruction = { step: [{ component: [shared, shared] }] };
    const output = toFhirR5Dosages(input);
    // Public outputs are immutable by caller contract. Protecting callers
    // who mutate returned nested values would require the defensive cloning
    // explicitly rejected by the API owner. Conversion itself changes none.
    expect(output[0].doseAndRate![0].doseQuantity).toBe(shared.doseAndRate![0].doseQuantity);
    expect(output[1].doseAndRate![0].doseQuantity!.value).toBe(1);
    expect(output[0].extension![0]).toBe(shared.extension![0]);
    expect(output[1].extension![0].extension![0].valueString).toBe("retain");
    expect(shared.doseAndRate![0].doseQuantity!.value).toBe(1);
    expect(shared.extension![0].extension![0].valueString).toBe("retain");
    expect(Object.isFrozen(output)).toBe(false);
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
    const phase = marker?.extension?.find(child => child.url === "step");
    expect(phase?.valueString).toBeUndefined();
    expect(phase?.extension?.find(child => child.url === "end")?.extension)
      .toContainEqual(expect.objectContaining({
        url: "offsetDuration", valueQuantity: expect.objectContaining({ value: 7, code: "d" })
      }));
    expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "drop" });
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(12_000);
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
    expect(rows[0].maxDosePerAdministration).toMatchObject({ value: 2, unit: "mL" });
    expect(rows[0].maxDosePerAdministration?.comparator).toBeUndefined();
    expect(rows[0].maxDosePerAdministration?.extension).toContainEqual({
      url: "http://ema.europa.eu/fhir/extension/comparator",
      valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000055" },
    });
    expect(inspectExtensions(rows).some(ext =>
      ext.url === "comparator" && ext.valueCode === "~")).toBe(false);
    expect(source.step[0].component[0].safety.futureMetadata.zero).toBe(0);
  });

  it("parses, exports, imports, edits and formats with JSON.parse/stringify disabled", () => {
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("unexpected serialization"); });
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new Error("unexpected JSON parsing"); });
    let course: FhirR6DosageInstruction;
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
  const expectedSteps = structuredClone(parseSig(parallel).fhirNext.step);
  expectedSteps[0].component[0].extension = [{
    url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [display]
  }, ...(expectedSteps[0].component[0].extension ?? [])];
  expect(restored.step).toEqual(expectedSteps);
});


it("keeps independent editable course markers on every projected row", () => {
  const source = parseSig(parallel).fhirNext;
  const rows = toFhirR5Dosages(source);
  const marker = (index: number) => rows[index].modifierExtension!.find(value => value.url === DOSAGE_DETAILS_R5_URL)!;
  const beforeSecond = cloneStructuredValue(marker(1));
  const phase = marker(0).extension!.find(value => value.url === "step")!;
  phase.extension!.find(value => value.url === "end")!.extension!
    .find(value => value.url === "offsetDuration")!.valueQuantity!.value = 9;
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
    "Take 1 tablet if needed every day",
    "Take 1 tablet if needed each day",
    "Take 1 tablet if pain every day"
  ])("does not reinterpret PRN daily cadence as a named day-domain condition: %s", source => {
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.clinicalAdjuncts?.calendarDayCondition).toBeUndefined();
    expect(clause.clinicalAdjuncts?.condition).toBeUndefined();
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.prn?.enabled).toBe(true);
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });


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
      expect(copied?.args).toMatchObject(JSON.parse(JSON.stringify(action?.args ?? [])));
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


describe("rebased HPSG instruction scopes", () => {
  it.each([
    { source: "1 tab PO QAM x7d; 2 tabs PO HS x7d. If you miss a dose, take it as soon as you remember.",
      doses: [1, 2], days: 7 },
    { source: "1 tab PO BID x7d then Take 1 tablet daily. If you miss a dose, take it as soon as you remember.",
      doses: [1, 1], days: 14 }
  ])("keeps later conditional advice in full-input coordinates: $source", ({ source, doses, days }) => {
    const parsed = parseSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(2);
    expect(clauses[0].instructionScopes).toBeUndefined();
    expect(clauses[1].instructionScopes).toHaveLength(1);
    const scope = clauses[1].instructionScopes![0];
    const antecedent = "If you miss a dose,";
    const consequent = "take it as soon as you remember";
    expect(scope).toEqual({
      kind: "if",
      span: { start: source.indexOf(antecedent), end: source.indexOf(antecedent) + antecedent.length },
      target: { start: source.indexOf(consequent), end: source.indexOf(consequent) + consequent.length }
    });
    expect(source.slice(scope.span.start, scope.span.end)).toBe(antecedent);
    expect(source.slice(scope.target.start, scope.target.end)).toBe(consequent);
    const graph = clauses[1].instructionGraph!;
    const relation = graph.relations.find(value => value.kind === "if")!;
    expect(relation.span).toEqual(scope.span);
    expect(graph.actions[relation.toActionIndex].span).toEqual(scope.target);
    expect(graph.actions[relation.toActionIndex].predicate.lemma).toBe("take");
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhirNext, parsed.fhir, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : toFhirR5Dosages(dosage);
      expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual(doses);
      expect(rows.every(row => row.asNeeded !== true && !getDosageCondition(row))).toBe(true);
      expect(calculateTotalUnits({ dosage, from: "2026-11-02T00:00:00Z",
        orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC", durationValue: days,
        durationUnit: "d" }).totalUnits).toBe(21);
    }
  });
});


describe("round 32 known cadence and repeat range intersection", () => {
  const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC" };
  it.each([
    { code: "BID", frequency: 1, frequencyMax: 3, clocks: ["08:00:00", "20:00:00"] },
    { code: "TID", frequency: 2, frequencyMax: 4, clocks: ["08:00:00", "14:00:00", "20:00:00"] },
    { code: "QID", frequency: 3, frequencyMax: 4, clocks: ["08:00:00", "12:00:00", "16:00:00", "20:00:00"] },
    { code: "QID", frequency: 3, frequencyMax: 5, clocks: ["08:00:00", "12:00:00", "16:00:00", "20:00:00"] },
    { code: "QID", frequency: 4, frequencyMax: 4, clocks: ["08:00:00", "12:00:00", "16:00:00", "20:00:00"] },
  ])("uses the recognized $code cadence inside its authored range", ({ code, frequency, frequencyMax, clocks }) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code }] },
        repeat: { frequency, frequencyMax, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: row.doseAndRate, timing: row.timing }] }] };
    for (const dosage of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]]) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: clocks.length })).toEqual(
        clocks.map(clock => "2026-01-01T" + clock + "+00:00"));
      expect(nextDueDoses(dosage, { ...options, limit: clocks.length + 1 })[clocks.length]).toBe("2026-01-02T08:00:00+00:00");
      expect(calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(frequencyMax);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });
  it.each([
    { code: "QID", repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
    { code: "QID", repeat: { frequency: 5, frequencyMax: 6, period: 1, periodUnit: FhirPeriodUnit.Day } },
    { code: "QID", repeat: { frequency: 1, period: 8, periodMax: 12, periodUnit: FhirPeriodUnit.Hour } },
    { code: "Q4H", repeat: { frequency: 1, period: 30, periodMax: 120, periodUnit: FhirPeriodUnit.Minute } },
    { code: "Q4H", repeat: { frequency: 1, frequencyMax: 2, period: 12, periodMax: 24, periodUnit: FhirPeriodUnit.Hour } },
    { code: "Q4H", repeat: { frequency: 1, frequencyMax: 2, period: 5, periodMax: 7, periodUnit: FhirPeriodUnit.Hour } },
    { code: "Q4H", repeat: { frequency: 1, frequencyMax: 2, period: 300, periodMax: 420, periodUnit: FhirPeriodUnit.Minute } },

  ])("refuses disjoint code/repeat cadence from both public execution APIs: $code $repeat", ({ code, repeat }) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code }] }, repeat } };
    const r6: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: row.doseAndRate, timing: row.timing }] }] };
    for (const dosage of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]]) {
      const original = JSON.stringify(dosage);
      expect(() => nextDueDoses(dosage, { ...options, limit: 2 }))
        .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
      expect(() => calculateTotalUnits({ ...options, dosage, durationValue: 1, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
      expect(JSON.stringify(dosage)).toBe(original);
    }
  });
});


describe("review source and interchange ownership", () => {
  const saved = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const measure = (value: number, unit = "mg") => ({
    value, unit, system: "http://unitsofmeasure.org", code: unit,
  });
  const start = "2026-12-01T08:00:00Z";

  it.each([
    ["http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C111984", "pump"],
    ["http://snomed.info/sct", "421954001", "dropperful"],
  ])("applies a code-only %s presentation limit", (system, code, unit) => {
    const quantity = { value: 1, system, code };
    const input: FhirDosage = {
      timing: { repeat: { frequency: 1, period: 8, periodUnit: FhirPeriodUnit.Hour } },
      doseAndRate: [{ doseQuantity: quantity }],
      maxDosePerPeriod: [{ numerator: { ...quantity, value: 2 }, denominator: measure(24, "h") }],
    };
    const before = saved(input);
    expect(calculateTotalUnits({ dosage: [input], from: start, orderedAt: start,
      timeZone: "UTC", durationValue: 1, durationUnit: "d" })).toMatchObject({ totalUnits: 2, unit });
    expect(nextDueDoses([saved(input)], { from: start, orderedAt: start, timeZone: "UTC", limit: 3 }))
      .toEqual(["2026-12-01T08:00:00+00:00", "2026-12-01T16:00:00+00:00", "2026-12-02T08:00:00+00:00"]);
    expect(projectCanonicalCourse(importCanonicalCourse([saved(input)])).fhir[0].doseAndRate?.[0].doseQuantity)
      .toEqual(quantity);
    expect(input).toEqual(before);
  });

  it.each([false, true])("shows retained course limits in scalar previews (stage cap=%s)", withStage => {
    const input: FhirR6DosageInstruction = {
      safety: { doseLimit: [{ scope: "lifetime", valueQuantity: measure(30) }] },
      step: [{ ...(withStage ? { safety: { doseLimit: [{ scope: "administration" as const,
        valueQuantity: measure(8) }] } } : {}), component: (withStage ? [5, 7] : [5]).map(value => ({
        doseAndRate: [{ doseQuantity: measure(value) }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      })) }],
    };
    const rows = toFhirR5Dosages(input), row = saved(rows[0]);
    const opened = fromFhirDosage(row);
    for (const text of [formatSig(saved(row)), formatSig(saved(row), "long"),
      opened.shortText, opened.longText]) {
      expect(text).toContain("5 mg");
      expect(text).toContain("Across this course: max lifetime: 30 mg");
      expect(text).not.toContain("7 mg");
      if (withStage) expect(text).toContain("Within this stage: max per administration: 8 mg");
    }
    expect(importCanonicalCourse(saved(rows)).safety?.limits?.[0].amount?.value).toBe(30);
  });

  it.each([false, true])("retains the selected phase count in scalar previews (course cap=%s)", withCap => {
    const input: FhirR6DosageInstruction = {
      safety: withCap ? { doseLimit: [{ scope: "lifetime", valueQuantity: measure(30) }] } : undefined,
      step: [{ count: 2, component: [5, 7].map(value => ({
        doseAndRate: [{ doseQuantity: measure(value) }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          boundsDuration: { value: 7, unit: "d", code: "d" } } },
      })) }],
    };
    const row = saved(toFhirR5Dosages(input)[0]);
    const before = saved(row);
    const opened = fromFhirDosage(row);
    for (const text of [opened.shortText, opened.longText, formatSig(saved(row), "long")]) {
      expect(text).toContain("Perform this phase 2 times");
      expect(text).toContain("5 mg");
      expect(text).not.toContain("7 mg");
      if (withCap) expect(text).toContain("Across this course: max lifetime: 30 mg");
    }
    expect(row).toEqual(before);
  });

  it("retains bilateral nasal targets beside an entire-nose coding", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
      site: { text: "both nostrils", coding: [{ system: "http://snomed.info/sct", code: "181195007" }] },
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
    };
    const before = saved(row);
    const native = importCanonicalCourse(saved(row));
    const r6 = saved(toDosageDetails([saved(row)]));
    for (const input of [native, saved(row), r6]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain("into each nostril");
      expect(calculateTotalUnits({ dosage: input, from: start, orderedAt: start, timeZone: "UTC",
        durationValue: 3, durationUnit: "d" })).toMatchObject({ totalUnits: 6, unit: "spray" });
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhir[0].site).toEqual(row.site);
    }
    expect(row).toEqual(before);
    const opposite: FhirDosage = { ...saved(row), site: { text: "left nostril",
      coding: [{ system: "http://snomed.info/sct", code: "723609004" }] } };
    expect(formatSig(opposite, "long", { locale: "en", realizationMode: "normalized" })).toContain("right nostril");
    expect(calculateTotalUnits({ dosage: opposite, from: start, orderedAt: start, timeZone: "UTC",
      durationValue: 3, durationUnit: "d" })).toMatchObject({ totalUnits: 3, unit: "spray" });
  });

  it.each(["as directed by the infusion clinic", "BID"])("retains code-less timing display as literal text: %s", display => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: measure(1) }],
      timing: { code: { coding: [{ display, id: "authored-timing" }] },
        repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
    };
    const before = saved(row);
    for (const input of [saved(row), importCanonicalCourse(saved(row)), saved(toDosageDetails([saved(row)]))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain(display);
      expect(text).not.toContain("twice");
      expect(nextDueDoses(input, { from: start, orderedAt: start, timeZone: "UTC", limit: 3 }))
        .toEqual(["2026-12-01T08:00:00+00:00", "2026-12-02T08:00:00+00:00", "2026-12-03T08:00:00+00:00"]);
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhir[0].timing?.code).toEqual(row.timing!.code);
    }
    for (const text of [fromFhirDosage(saved(row)).shortText, fromFhirDosage(saved(row)).longText])
      expect(text).toContain(display);
    expect(row).toEqual(before);
  });

  it.each(["urn:clinic:pump-units", "http://unitsofmeasure.org"])
    ("infers carrier duration only for matching coded quantities (%s)", system => {
      const input: FhirDosage = { doseAndRate: [{
        doseQuantity: { value: 100, unit: "milliliter dose", system, code: "mL" },
        rateRatio: { numerator: measure(100, "mL"),
          denominator: simpleQuantityForR5({ ...measure(2, "h"), comparator: "~" }) },
      }] };
      const current = importCanonicalCourse([input]).stages[0].administrations[0];
      if (system === "http://unitsofmeasure.org") {
        expect(current.schedule?.recurrence).toMatchObject({
          occurrenceDuration: 2, occurrenceDurationUnit: "h", occurrenceDurationComparator: "~",
        });
        expect(fromFhirDosage(saved(input)).longText).toContain("over approximately 2 hours");
      } else {
        expect(current.schedule?.recurrence?.occurrenceDuration).toBeUndefined();
        expect(fromFhirDosage(saved(input)).longText).not.toContain("over approximately 2 hours");
      }
      expect(current.amounts?.[0].quantity).toEqual(input.doseAndRate![0].doseQuantity);
      expect(current.amounts?.[0].rateRatio?.numerator).toEqual(input.doseAndRate![0].rateRatio!.numerator);
      expect(current.amounts?.[0].rateRatio?.denominator).toMatchObject({ value: 2, comparator: "~" });
    });

  it("retains a supplied graph source annotation through public decode and rebuild", () => {
    const sourceText = "Cover with an occlusive dressing";
    const marker = saved(buildInstructionGraphExtension({ sourceText, sourceLocale: "en",
      actions: parseInstructionActions(sourceText) })!);
    const source = marker.extension!.find(field => field.url === "sourceText")!;
    source.id = "graph-source";
    source._valueString = { id: "authored-source", extension: [
      { url: "urn:clinic:provenance-note", valueString: "Retain this source annotation" },
    ] };
    const graph = parseInstructionGraphExtension([marker])!;
    const rebuilt = buildInstructionGraphExtension(graph)!;
    expect(rebuilt.extension!.filter(field => field.url === "sourceText")).toEqual([source]);
    expect(graph.sourceText).toBe(sourceText);
  });

  it("renders an independent limit note beside its four-tablet cap", () => {
    const amount = 4;
    const note = "Include tablets from other acetaminophen products in this total.";
    const input: FhirR6DosageInstruction = { safety: { doseLimit: [{
      scope: "period", valueQuantity: { value: amount, unit: "tab" }, period: measure(1, "d"), text: note,
    }] }, step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    for (const value of [input, toFhirR5Dosages(saved(input))]) {
      const text = formatSig(value);
      expect(text).toContain(`Across this course: max per period: ${amount} tab / 1 d`);
      expect(text).toContain(note);
      expect(text.split(note)).toHaveLength(2);
    }
  });

  it.each(["r5", "r6"] as const)("converts an independent %s range annotation using the target quantity codec", version => {
    const approximate = { value: 10, unit: "mL", comparator: "~" as const };
    const annotation = { url: "urn:clinic:independent-quantity", valueQuantity:
      version === "r5" ? simpleQuantityForR5(approximate)! : approximate };
    const doseAndRate = [{ doseRange: {
      low: { ...measure(1), _value: { id: "range-value", extension: [annotation] } }, high: measure(2),
    } }];
    const input = version === "r5" ? [{ doseAndRate }]
      : { step: [{ component: [{ doseAndRate }] }] };
    const output = projectCanonicalCourse(importCanonicalCourse(input));
    const r6 = output.fhirNext.step![0].component[0].doseAndRate![0].doseRange!;
    expect(r6.low?.value).toBe(1);
    expect(r6.low?._value).toEqual({ id: "range-value", extension: [
      { url: annotation.url, valueQuantity: approximate },
    ] });
    expect(r6.low?.comparator).toBeUndefined();
    const r5 = output.fhir[0].doseAndRate![0].doseRange!;
    const nested = r5.low?._value?.extension?.[0].valueQuantity;
    expect(nested?.comparator).toBeUndefined();
    expect(getQuantityComparator(nested)).toBe("~");
  });
});


describe("equivalent nebulizer presentation limits", () => {
  it.each([
    ["nebule", "C71204", 2], ["respule", "C71204", 2], ["nebule", "C111984", 3],
  ] as const)("counts %s against presentation code %s", (unit, capCode, expected) => {
    const system = "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl";
    const input: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit, system, code: "C71204" } }],
      timing: { repeat: { frequency: 1, period: 8, periodUnit: FhirPeriodUnit.Hour } },
      maxDosePerPeriod: [{ numerator: { value: 2, system, code: capCode }, denominator: {
        value: 24, unit: "h", system: "http://unitsofmeasure.org", code: "h",
      } }],
    };
    const from = "2026-12-01T08:00:00Z";
    expect(calculateTotalUnits({ dosage: [input], from, orderedAt: from, timeZone: "UTC",
      durationValue: 1, durationUnit: "d" })).toMatchObject({ totalUnits: expected, unit });
    expect(nextDueDoses([input], { from, orderedAt: from, timeZone: "UTC", limit: 3 })).toEqual([
      "2026-12-01T08:00:00+00:00", "2026-12-01T16:00:00+00:00",
      expected === 2 ? "2026-12-02T08:00:00+00:00" : "2026-12-02T00:00:00+00:00",
    ]);
    expect(projectCanonicalCourse(importCanonicalCourse([input])).fhir[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 1, unit, system, code: "C71204" });
  });
});


describe("independent clinical conditions and coded quantity meaning", () => {
  const quantity = (value: number, unit: string) => ({
    value, unit, system: "http://unitsofmeasure.org", code: unit,
  });
  const daily = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } };

  it("evaluates the coded problem rather than the generic condition-type label", () => {
    const input: FhirR6DosageInstruction = {
      step: [{ component: [{ timing: daily, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        condition: [{
          code: { text: "Problem Presents", coding: [{
            system: "http://hl7.org/fhir/CodeSystem/dosage-condition-code", code: "problem-presents",
          }] },
          details: { coding: [{ system: "http://snomed.info/sct", code: "422587007", display: "Nausea" }] },
          operation: "ne", valueBoolean: true, text: "Only if nausea is absent",
        }],
      }] }],
    };
    const course = importCanonicalCourse(input);
    const predicate = course.stages[0].administrations[0].predicate!;
    expect(predicate).toMatchObject({ kind: "state", name: "Nausea", expected: false });
    expect(evaluateMedicationCondition(predicate, { Nausea: false })).toBe(true);
    expect(evaluateMedicationCondition(predicate, { Nausea: true })).toBe(false);
    expect(formatSig(input)).toContain("only if not Nausea");
    expect(projectCanonicalCourse(course).fhirNext.step[0].component[0].condition)
      .toEqual(input.step[0].component[0].condition);
  });

  it.each([true, false])("uses the infusion ratio duration only without a separate upper duration (%s)", withUpper => {
    const input: FhirDosage = {
      ...(withUpper ? { timing: { repeat: { durationMax: 3, durationUnit: FhirPeriodUnit.Hour } } } : {}),
      doseAndRate: [{ doseQuantity: quantity(120, "mL"), rateRatio: {
        numerator: quantity(120, "mL"), denominator: simpleQuantityForR5({ ...quantity(2, "h"), comparator: "~" }),
      } }],
    };
    const recurrence = importCanonicalCourse([input]).stages[0].administrations[0].schedule?.recurrence;
    expect(recurrence?.occurrenceDuration).toBe(withUpper ? undefined : 2);
    expect(recurrence?.occurrenceDurationMax).toBe(withUpper ? 3 : undefined);
    const preview = fromFhirDosage(input).longText;
    expect(preview).toContain(withUpper ? "over up to 3 hours" : "over approximately 2 hours");
    expect(preview).not.toContain("2 to 3 hours");
    expect(projectCanonicalCourse(importCanonicalCourse([input])).fhir[0].doseAndRate?.[0].rateRatio)
      .toEqual(input.doseAndRate?.[0].rateRatio);
  });

  it.each([
    ["http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", "C111984", "Pumpenhub", "pump"],
    ["http://snomed.info/sct", "421954001", "dropper dose", "dropperful"],
  ])("uses known presentation code %s/%s for target multiplication", (system, code, unit, measuredUnit) => {
    const amount = { value: 1, system, code, unit };
    const input: FhirR6DosageInstruction = {
      step: [{ component: [{ timing: daily, doseAndRate: [{ doseQuantity: amount }], site: { concept: {
        text: "two treatment sites", extension: [{ url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL, valueInteger: 2 }],
      } } }] }],
    };
    const from = "2026-12-01T08:00:00Z";
    expect(calculateTotalUnits({ dosage: input, from, orderedAt: from, timeZone: "UTC",
      durationValue: 1, durationUnit: "d" })).toMatchObject({ totalUnits: 2, unit: measuredUnit });
    expect(projectCanonicalCourse(importCanonicalCourse(input)).fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual(amount);
  });

  it.each([
    ["high", "~", "<=~60 mL/h"], ["low", "~", ">=~60 mL/h"], ["high", "<", "<60 mL/h"],
  ] as const)("keeps the direction of a %s rate endpoint qualified by %s", (bound, comparator, expected) => {
    const input: FhirDosage = { doseAndRate: [{ rateRange: {
      [bound]: simpleQuantityForR5({ ...quantity(60, "mL/h"), comparator }),
    } }] };
    expect(formatSig([input])).toBe("Rate range: " + expected);
    expect(fromFhirDosage(input).longText).toContain("Rate range: " + expected);
  });
});


describe("coded presentation quantity identity", () => {
  const options = { orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T00:00:00Z", timeZone: "UTC" };

  it.each(["nebule", "respule"])("sums a labeled %s and the same standard code without a label", unit => {
    const rows: FhirDosage[] = [unit, undefined].map(label => ({ sequence: 1,
      doseAndRate: [{ doseQuantity: { value: 1, system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl",
        code: "C71204", ...(label ? { unit: label } : {}) } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00"] } } }));
    for (const dosage of [rows, toDosageDetails(rows), importCanonicalCourse(rows)]) {
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 2, unit });
      expect(projectCanonicalCourse(importCanonicalCourse(dosage)).fhir.map(row => row.doseAndRate?.[0].doseQuantity))
        .toEqual(rows.map(row => row.doseAndRate?.[0].doseQuantity));
    }
  });

  it("compares an identical local dose and cap code without assigning it a standard dimension", () => {
    for (const sameSystem of [true, false]) {
      const row: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, system: "urn:clinic:dose-unit", code: "tab" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00", "20:00:00"] } },
        maxDosePerPeriod: [{ numerator: { value: 1,
          system: sameSystem ? "urn:clinic:dose-unit" : "urn:other:dose-unit", code: "tab" },
          denominator: { value: 24, unit: "h", code: "h", system: "http://unitsofmeasure.org" } }],
      };
      for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
        expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([
          "2027-01-01T08:00:00+00:00", sameSystem ? "2027-01-02T08:00:00+00:00" : "2027-01-01T20:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits)
          .toBe(sameSystem ? 1 : 2);
        expect(importCanonicalCourse(dosage).stages[0].administrations[0].amounts?.[0].quantity)
          .toEqual(row.doseAndRate![0].doseQuantity);
      }
    }
  });

  it("applies an identically coded lifetime ceiling and recorded consumption", () => {
    const unit = { system: "urn:clinic:dose-unit", code: "tab" };
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerLifetime: { value: 2, ...unit },
    };
    const before = structuredClone(row);
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      const query = { dosage, ...options, from: "2027-01-02T00:00:00Z", durationValue: 2, durationUnit: "d" as const };
      expect(calculateTotalUnits(query).totalUnits).toBe(2);
      expect(calculateTotalUnits({ ...query, priorDoseTimes: ["2027-01-01T08:00:00Z"] }).totalUnits).toBe(1);
      expect(importCanonicalCourse(dosage).stages[0].administrations[0].limits?.[0].amount)
        .toEqual(row.maxDosePerLifetime);
    }
    expect(row).toEqual(before);
  });

  it.each(["system", "code"] as const)("keeps a lifetime ceiling with another %s unevaluated", field => {
    const unit = { system: "urn:clinic:dose-unit", code: "tab" };
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerLifetime: { value: 2, ...unit, [field]: field === "system" ? "urn:other:dose-unit" : "cap" },
    };
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      const member = importCanonicalCourse(dosage).stages[0].administrations[0];
      expect(numericAdministrationLimits(member)).toMatchObject({ lifetime: undefined, multiple: true });
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, durationUnit: "d" }))
        .toMatchObject({ totalUnits: 4, quantityKind: "maximum",
          explanation: expect.stringContaining("an unevaluable maximum-dose constraint") });
    }
  });

  it.each(["administration", "lifetime"] as const)("keeps the coded dose as the %s comparison basis", scope => {
    const unit = { system: "urn:clinic:dose-unit", code: "tab" };
    const compatible = { value: 2, ...unit };
    const incompatible = { value: 1, ...unit, system: "urn:other:dose-unit" };
    for (const amounts of [[incompatible, compatible], [compatible, incompatible]]) {
      const input: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00", "20:00:00"] } },
        safety: { doseLimit: amounts.map(valueQuantity => ({ scope, valueQuantity })) },
      }] }] };
      const before = structuredClone(input);
      for (const dosage of [input, toFhirR5Dosages(input), importCanonicalCourse(input)]) {
        const member = importCanonicalCourse(dosage).stages[0].administrations[0];
        expect(numericAdministrationLimits(member)).toMatchObject({ [scope]: compatible, multiple: true });
        expect(calculateTotalUnits({ dosage, ...options, durationValue: 2, durationUnit: "d" }).totalUnits)
          .toBe(scope === "lifetime" ? 2 : 4);
        expect(member.limits?.map(limit => limit.amount)).toEqual(amounts);
      }
      expect(input).toEqual(before);
    }
  });

  it.each([false, true])("applies a coded administration ceiling across optional range labels (upper endpoint: %s)", upper => {
    const unit = { system: "urn:clinic:dose-unit", code: "tab" };
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, ...unit },
        ...(upper ? { high: { value: 4, unit: "tablet", ...unit } } : {}) } }],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"] } },
      maxDosePerAdministration: { value: 2, ...(upper ? {} : { unit: "tablet" }), ...unit },
    };
    const before = structuredClone(row);
    for (const dosage of [row, toDosageDetails([row]), importCanonicalCourse([row])]) {
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
      expect(projectCanonicalCourse(importCanonicalCourse(dosage)).fhir[0].doseAndRate?.[0].doseRange)
        .toEqual(row.doseAndRate![0].doseRange);
    }
    expect(row).toEqual(before);
  });
});


// Locale registry and configured-realization contracts, preserved from locale-architecture.
describe("locale-extensible language architecture", () => {
  it("replaces locale detectors in stable priority order and updates their ordering when priority changes",()=>{
    const test=(input:string)=>input==="locale-registry-priority-fixture";
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test});
    registerMedicationLocaleDetector({locale:"priorityb",priority:1000,test});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test:()=>false});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("priorityb");
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
    const changed={locale:"priorityb",priority:1001,test};
    registerMedicationLocaleDetector(changed);
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("priorityb");
    registerMedicationLocaleDetector({ ...changed, priority: 999 });
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
  });

  it("keeps selected action labels and the locale adapter for a typed meal nominal", () => {
    const selected = parseInstructionActions("do not take on an empty stomach")[0];
    const config = { locales: { "meal-selected": { implicitMedicationObject: true } } };
    const frame = { ...selected, predicate: { ...selected.predicate,
      display: "Selected take", i18n: { en: "Selected take", "meal-selected": "Configured take" },
      realizerConfig: config
    } };
    expect(frame.args).toEqual([expect.objectContaining({
      role: AdviceArgumentRole.MealState, conceptId: "empty_stomach", text: "an empty stomach"
    })]);
    expect(realizeInstructionAction(frame, "en")).toBe("Do not selected take on an empty stomach");
    const calls: string[] = [];
    registerInstructionActionLocaleAdapter({
      ...getInstructionActionLocaleAdapter("en"), locale: "meal-selected",
      renderNegated(input, completeAction) {
        expect(input.frame).toBe(frame);
        expect(input.realizerConfig).toBe(config);
        expect(input.label).toBe("Configured take");
        calls.push(completeAction!);
        return `custom: ${completeAction}`;
      }
    });
    expect(realizeInstructionAction(frame, "meal-selected")).toBe("custom: Configured take on an empty stomach");
    expect(calls).toEqual(["Configured take on an empty stomach"]);
  });

  it("exposes lexer, surface segmentation, and suggester locale packs", () => {
    registerMedicationLexerLocalePack({
      locale: "xy",
      apply: (tokens) => tokens.map((token, index) => ({ ...token, index })),
      listLexemes: () => [{ surface: "xy-dose", canonical: "dose" }]
    });
    expect(getMedicationLexerLocalePack("xy-XY")?.locale).toBe("xy");
    expect(listMedicationLocaleLexemes("xy-XY")).toContainEqual({
      surface: "xy-dose",
      canonical: "dose"
    });

    const originalPack = getMedicationLexerLocalePack("xy")!;
    const regionalApply: typeof originalPack.apply = tokens => tokens.map((token, index) => ({ ...token, index }));
    const regionalPack = { ...originalPack, locale: " xY_Clinic ", apply: regionalApply };
    registerMedicationLexerLocalePack(regionalPack);
    expect(regionalPack.locale).toBe(" xY_Clinic ");
    expect(getMedicationLexerLocalePack("XY-Other")?.locale).toBe("xy");
    expect(getMedicationLexerLocalePack("XY-Other")?.apply).toBe(regionalApply);
    expect(getMedicationLexerLocalePack("xy")?.apply).toBe(regionalApply);
    expect(listMedicationLocaleLexemes("xy-XY")).toContainEqual({ surface: "xy-dose", canonical: "dose" });

    registerMedicationSurfaceSegmenter({
      locale: "xy",
      script: /\u2603/u,
      segment: (input) => [{ segment: input, index: 0 }]
    });
    expect(listMedicationSurfaceSegmenters().some((segmenter) => segmenter.locale === "xy")).toBe(true);

    const fallbackSuggest = getSuggestLocaleAdapter("unknown-locale");
    registerSuggestLocaleAdapter({ ...fallbackSuggest, locale: "xy" });
    expect(getSuggestLocaleAdapter("xy-XY").locale).toBe("xy");
  });
});



describe("round54 descriptor-owned surface segmenter callbacks", () => {
  it.each(["g", "y", ""])("uses the normalized script receiver for a plain descriptor (%s)", flags => {
    // Plain descriptors use their registered script configuration.
    const provider = {
      locale: "round54-own-script-" + (flags || "plain"),
      script: new RegExp("[ⴰⴱ]", flags + "u"),
      segment(input: string) {
        const segments: Array<{ segment: string; index: number }> = [];
        for (let index = 0; index < input.length; index++)
          if (this.script.test(input[index])) segments.push({ segment: input[index], index });
        return segments;
      }
    };
    registerMedicationSurfaceSegmenter(provider);
    const registered = listMedicationSurfaceSegmenters().find(value => value.locale === provider.locale)!;
    const expected = [{ segment: "ⴰ", index: 0 }, { segment: "ⴱ", index: 1 }];
    expect([...registered.segment("ⴰⴱ")]).toEqual(expected);
    expect([...registered.segment("ⴰⴱ")]).toEqual(expected);
    expect(registered.script.global).toBe(false);
    expect(registered.script.sticky).toBe(false);
    expect(provider.script.global).toBe(flags === "g");
    expect(provider.script.sticky).toBe(flags === "y");
  });
});


describe("registered source locale in shared warning clones", () => {
  it("retains the registered Spanish article surface through the existing negative-instruction owner", () => {
    registerMedicationLocaleDetector({ locale: "es", priority: 1000, test: text => /\bel\b/u.test(text) });
    registerMedicationLexerLocalePack({
      locale: "es",
      apply: tokens => tokens.map((token, index) => ({ ...token, index,
        ...(token.lower === "el" ? { canonical: "the" } : {}) })),
      listLexemes: () => [{ surface: "el", canonical: "the" }],
    });
    const source = "take 1 tab at 12:00, 2 tabs at 16:00; do not take with el food";
    const parsed = parseSig(source), clauses = parsed.meta.canonical.clauses;
    expect(parsed.count).toBe(2);
    expect(clauses.map(clause => clause.dose?.value)).toEqual([1, 2]);
    expect(clauses.map(clause => clause.schedule?.timeOfDay)).toEqual([["12:00:00"], ["16:00:00"]]);
    const inherited = clauses[0].additionalInstructions![0];
    expect(inherited).toMatchObject({ text: "Do not take with el food", i18n: { es: "Do not take with el food" } });
    expect(inherited.frames![0].polarity).toBe("negate");
    expect(inherited.frames![0].span).toEqual(clauses[1].additionalInstructions![0].frames![0].span);
    expect(parsed.input).toBe(source);
  });
});

describe("shared timing article roles", () => {
  it("accepts a registered Spanish article alias through existing timing constructions", () => {
    registerMedicationLocaleDetector({ locale: "es", priority: 1000, test: text => /\bel\b/u.test(text) });
    registerMedicationLexerLocalePack({
      locale: "es",
      apply: tokens => tokens.map((token, index) => ({ ...token, index,
        ...(token.lower === "el" ? { canonical: "the" } : {}) })),
      listLexemes: () => [{ surface: "el", canonical: "the" }],
    });
    const durationCases = [
      { suffix: "for el next week", value: 1, code: "wk" },
      { suffix: "for el next 3 days", value: 3, code: "d" },
      { suffix: "for el 3 days", value: 3, code: "d" },
    ];
    for (const { suffix, value, code } of durationCases) for (const wording of [suffix, suffix.replace("el", "the")]) {
      const parsed = parseSig("Take 1 tablet daily " + wording);
      expect(parsed.fhir[0].doseAndRate![0].doseQuantity!.value).toBe(1);
      expect(parsed.fhir[0].timing!.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d",
        boundsDuration: { value, code } });
    }
    for (const article of ["el", "the"]) {
      const counted = parseSig(`Take 1 tablet daily for ${article} 3 doses`);
      expect(counted.fhir[0].timing!.repeat).toMatchObject({ count: 3, frequency: 1, period: 1, periodUnit: "d" });
      const monthly = parseSig(`Take 1 tablet on ${article} first Monday of every month`);
      expect(monthly.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "mo", dayOfWeek: ["mon"], weekdayOrdinal: 1 });
      const ended = parseSig(`Take 1 tablet daily until ${article} next morning`);
      const schedule = ended.meta.canonical.clauses[0].schedule!;
      expect(schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(schedule.when).toBeUndefined();
      expect(schedule.treatmentStartOffsetDays).toBeUndefined();
      expect(ended.fhir[0].timing!.repeat!.boundsPeriod).toBeUndefined();
      expect(ended.meta.canonical.course!.stages[0].administrations[0].phaseEnd)
        .toMatchObject({ anchor: "unresolved", description: `until ${article} next morning` });
      expect(JSON.stringify(ended.fhir[0])).toContain(`until ${article} next morning`);
    }
    // The indefinite quantity determiner has different semantics: it supplies one.
    expect(parseSig("Take 1 tablet daily for a week").fhir[0].timing!.repeat!.boundsDuration)
      .toMatchObject({ value: 1, code: "wk" });
  });
});


describe("structured preview defaults", () => {
  it("keeps guarded whole-clause defaults and accepts a complete wording override", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      condition: [{ code: { coding: [{ system: "http://loinc.org", code: "8480-6",
        display: "Systolic blood pressure" }], text: "sbp" }, operation: "gt",
        valueQuantity: { value: 160 }, text: "SBP > 160" }],
      additionalInstruction: [{ text: "Otherwise hold" }]
    }] }] };
    const before = JSON.stringify(source);
    const expected = "Use 1 tablet only if SBP > 160. Otherwise hold.";
    const defaults: NonNullable<NonNullable<FormatOptions["i18n"]>["formatLong"]>[] = [
      context => context.defaultText,
      context => "Directions: " + context.defaultText,
      context => "Directions: " + context.formatDefault("long"),
    ];
    for (const [index, formatLong] of defaults.entries()) {
      expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: { formatLong } }))
        .toBe((index === 0 ? "" : "Directions: ") + expected);
    }
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized",
      i18n: { formatLong: () => "Take this dose." } })).toBe("Take this dose.");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("uses a display-only administration method without inventing a coding", () => {
    const component: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: "http://snomed.info/sct", code: "26643006" }] },
      method: { coding: [{ display: "Chew" }] }
    };
    const native: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: component.doseAndRate, route: component.route, method: component.method
    }] }] };
    for (const source of [component, native]) {
      const before = JSON.stringify(source);
      expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain("Chew 1 tablet");
      expect(formatSig(source, "long", { locale: "th", realizationMode: "normalized" })).toContain("เคี้ยว");
      expect(JSON.stringify(source)).toBe(before);
    }
    expect(fromFhirDosage(component).longText).toContain("Chew 1 tablet");
    const projected = toDosageDetails([component]);
    expect(projected.step[0].component[0].method).toEqual({ coding: [{ display: "Chew" }] });
    for (const source of [native, projected])
      expect(toFhirR5Dosages(source)[0].method).toEqual({ coding: [{ display: "Chew" }] });
  });

  it.each([0, 2])("displays both endpoints of a %s-to-four-hour PRN interval", period => {
    const source: FhirDosage = { asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period, periodMax: 4, periodUnit: FhirPeriodUnit.Hour } }
    };
    const before = JSON.stringify(source);
    expect(formatSig(source, "short", { locale: "en", realizationMode: "normalized" })).toContain(`Q${period}-4H`);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain(`every ${period} to 4 hours`);
    for (const style of ["short", "long"] as const)
      expect(formatSig(source, style, { locale: "th", realizationMode: "normalized" })).toContain(`${period} ถึง 4 ชั่วโมง`);
    expect(JSON.stringify(source)).toBe(before);
  });
});


describe("independent cadence and preview condition owners", () => {
  const guard = { code: { coding: [{ system: "http://loinc.org", code: "8480-6",
    display: "Systolic blood pressure" }], text: "sbp" }, operation: "gt" as const,
    valueQuantity: { value: 160 }, text: "SBP > 160" };
  const tablet = { doseQuantity: { value: 1, unit: "tab" } };

  it.each([
    ["en", "short", "1 tab Q2D HS"],
    ["en", "long", "Use 1 tablet every other day at bedtime."],
    ["th", "short", "1 เม็ด วันเว้นวัน ก่อนนอน"],
    ["th", "long", "ใช้ครั้งละ 1 เม็ด วันเว้นวัน ก่อนนอน."],
  ] as const)("keeps the BED anchor beside a typed cadence in %s %s", (locale, style, expected) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
        repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(source);
    expect(formatSig(source, style, { locale, realizationMode: "normalized" })).toBe(expected);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps explicit events and clocks authoritative over the BED fallback", () => {
    for (const explicit of [{ when: [EventTiming.Morning] }, { timeOfDay: ["09:00:00"] }]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
        timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
          repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Day, ...explicit } }
      }] }] };
      const text = formatSig(source, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain("every other day");
      expect(text).not.toContain("bedtime");
      expect(text).toMatch("when" in explicit ? /morning/u : /9:00\s*am/u);
    }
  });

  it("keeps a restyled default guard on the dose before independent advice", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      condition: [guard], additionalInstruction: [{ text: "Otherwise hold" }]
    }] }] };
    const before = JSON.stringify(source);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: {
      formatLong: context => context.defaultText.replace("Use", "Administer")
    } })).toBe("Administer 1 tablet only if SBP > 160. Otherwise hold.");
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: {
      formatLong: () => "Take this dose."
    } })).toBe("Take this dose.");
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(["en", "th"] as const)("preserves native guard ownership and exact whole-clause overrides in %s", locale => {
    const advice = locale === "en" ? "Recheck BP only if SBP > 160" : "Recheck BP เฉพาะเมื่อ SBP > 160";
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      condition: [guard], additionalInstruction: [{ text: advice }],
      extension: [{ url: "https://example.test/source-note", valueString: "Keep this source detail" }]
    }] }] };
    const before = JSON.stringify(source);
    const dose = "Administer 1 tablet";
    const guardText = locale === "en" ? "only if" : "เฉพาะเมื่อ";
    const nativeDose = locale === "en" ? "Use 1 tablet" : "ใช้ครั้งละ 1 เม็ด";
    expect(formatSig(source, "long", { locale, realizationMode: "normalized" }))
      .toBe(`${nativeDose} ${guardText} SBP > 160. ${advice}.`);
    const expectedDefault = `${nativeDose} ${guardText} SBP > 160. ${advice}.`;
    for (const prefix of ["", "Directions: "]) {
      let calls = 0;
      const text = formatSig(source, "long", { locale, realizationMode: "normalized", i18n: {
        formatLong: context => {
          calls++;
          expect(context.style).toBe("long");
          expect(context.defaultText).toBe(expectedDefault);
          expect(context.formatDefault("long")).toBe(expectedDefault);
          expect(context.clause.dose).toMatchObject({ value: 1, unit: "tab" });
          expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", operation: "gt", value: 160 });
          expect(context.clause.additionalInstructions).toEqual(expect.arrayContaining([expect.objectContaining({ text: advice })]));
          return prefix + context.defaultText.replace(`${nativeDose} ${guardText} SBP > 160.`, dose + ".");
        }
      } });
      expect(text).toBe(`${prefix}${dose}. ${advice}.`);
      expect(calls).toBe(1);
    }
    expect(formatSig(source, "long", { locale, realizationMode: "normalized", i18n: {
      formatLong: context => "Directions: " + context.formatDefault("long")
        .replace(`${nativeDose} ${guardText} SBP > 160.`, dose + ".")
        .replace("Recheck BP", "Repeat B.P.") + " Call clinic if needed."
    } })).toBe(`Directions: ${dose}. ${advice.replace("Recheck BP", "Repeat B.P.")}. Call clinic if needed.`);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(["en", "th"] as const)("guards current cadence and authored dose directions once each in %s", locale => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ text: "Swallow 1 tablet whole",
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }, condition: [guard]
    }] }] };
    const before = JSON.stringify(source);
    for (const style of ["short", "long"] as const) {
      const text = formatSig(source, style, { locale, realizationMode: "normalized" });
      expect(text).toContain("Swallow 1 tablet whole");
      const [current, authored] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
      expect(current.match(/SBP > 160/gu)).toHaveLength(1);
      expect(authored.match(/SBP > 160/gu)).toHaveLength(1);
      expect(authored).toBe("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160.");
      expect(text).toContain(locale === "en" ? style === "short" ? "1x/d" : "once daily" : "วันละครั้ง");
    }
    expect(JSON.stringify(source)).toBe(before);
  });
});


describe("complete native clause defaults", () => {
  const guard = { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }], text: "sbp" },
    operation: "gt" as const, valueQuantity: { value: 160 }, text: "SBP > 160" };
  const dose = { doseQuantity: { value: 1, unit: "tab" } };
  const note = { url: "https://example.test/preview-note", valueString: "Retain this note" };

  it.each(["quantity", "ratio", "range"] as const)("guards the current partial infusion %s before independent advice", kind => {
    const sourceText = "Infuse over 2 hours";
    const amount = kind === "quantity"
      ? { rateQuantity: { value: 5, unit: "mL/h", system: "http://unitsofmeasure.org", code: "mL/h" } }
      : kind === "ratio" ? { rateRatio: { numerator: { value: 10, unit: "mL" }, denominator: { value: 2, unit: "h" } } }
      : { rateRange: { low: { value: 5, unit: "mL/h" }, high: { value: 10, unit: "mL/h" } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ text: sourceText,
      doseAndRate: [amount], condition: [guard], extension: [note],
      additionalInstruction: [{ text: "Recheck BP only if SBP > 160" }, { text: "Otherwise hold" }]
    }] }] };
    const rows = toFhirR5Dosages(raw), native = importCanonicalCourse(raw);
    for (const input of [raw, rows, native]) for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), options = { locale, realizationMode: "normalized" as const };
      const long = formatSig(input, "long", options), short = formatSig(input, "short", options);
      const primary = (kind === "range"
        ? locale === "en" ? "Rate range: " : "ช่วงอัตราการให้ยา: "
        : locale === "en" ? "Rate: " : "อัตราการให้ยา: ") +
        (kind === "quantity" ? "5 mL/h" : kind === "ratio" ? "10 mL / 2 h" : "5–10 mL/h") +
        (locale === "en" ? " only if" : " เฉพาะเมื่อ") + " SBP > 160";
      for (const text of [long, short]) {
        const [current, source] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
        expect(current).toContain(primary);
        expect(source).toBe(sourceText);
        expect(current.indexOf(primary)).toBeLessThan(current.indexOf("Recheck") < 0 ? current.length : current.indexOf("Recheck"));
      }
      expect(long).toContain("Recheck BP only if SBP > 160");
      expect(long).toContain("Otherwise hold");
      expect(long.match(/SBP > 160/gu)).toHaveLength(2);
      let calls = 0;
      expect(formatSig(input, "long", { ...options, i18n: { formatLong: context => {
        calls++;
        expect(context.defaultText).toBe(long);
        expect(context.formatDefault("long")).toBe(long);
        expect(context.formatDefault("short")).toBe(short);
        expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", operation: "gt", value: 160 });
        expect(context.clause.additionalInstructions).toContainEqual(expect.objectContaining({ text: "Otherwise hold" }));
        return "Clinic wording, unchanged!";
      } } })).toBe("Clinic wording, unchanged!");
      expect(calls).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(raw.step[0].component[0].text).toBe(sourceText);
    expect(rows[0].text).toBe(sourceText);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
    const reopened = toDosageDetails(rows).step[0].component[0];
    expect(reopened.doseAndRate).toEqual([amount]);
    expect(reopened.extension).toContainEqual(note);
  });

  it.each(["en", "th"] as const)("keeps the guard on the complete authored primary in %s", locale => {
    for (const text of [locale === "en" ? "Use the medication once daily." : "ใช้ยา วันละครั้ง.",
      "Swallow 1 tablet whole"]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ text, condition: [guard],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        additionalInstruction: [{ text: "Call the clinic" }], extension: [note]
      }] }] };
      for (const input of [source, toFhirR5Dosages(source)]) {
        const before = JSON.stringify(input);
        const native = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(native).toContain(text.replace(/\.$/u, ""));
        expect(native).toContain(locale === "en" ? "once daily" : "วันละครั้ง");
        if (text.startsWith("Swallow")) {
          const [current, authored] = native.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
          expect(current).toContain("Call the clinic");
          expect(current.match(/SBP > 160/gu)).toHaveLength(1);
          expect(current).toContain((locale === "en" ? "once daily only if" : "วันละครั้ง เฉพาะเมื่อ") + " SBP > 160.");
          expect(current).not.toMatch(/Call the clinic\.? (?:only if|เฉพาะเมื่อ)/u);
          expect(authored).toBe("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160.");
          expect(authored).not.toContain("Call the clinic");
        } else {
          expect(native.match(/SBP > 160/gu)).toHaveLength(1);
          expect(native).toBe(text.replace(/\.$/u, "") +
            (locale === "en" ? " only if" : " เฉพาะเมื่อ") + " SBP > 160. Call the clinic.");
        }
        let calls = 0;
        expect(formatSig(input, "long", { locale, realizationMode: "normalized", i18n: {
          formatLong: context => {
            calls++;
            expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
            expect(context.clause.schedule?.frequency).toBe(1);
            expect(context.defaultText).toBe(native);
            expect(context.formatDefault("long")).toBe(native);
            expect(context.clause.additionalInstructions?.[0].text).toBe("Call the clinic");
            return "Clinic wording, unchanged!";
          }
        } })).toBe("Clinic wording, unchanged!");
        expect(calls).toBe(1);
        expect(JSON.stringify(input)).toBe(before);
        expect(toDosageDetails(Array.isArray(input) ? input : toFhirR5Dosages(input)).step![0].component[0].extension)
          .toContainEqual(note);
      }
    }
  });

  it.each(["en", "th"] as const)("lets a full-clause callback replace authored-only guarded wording in %s", locale => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{ text: "Swallow 1 tablet whole",
      condition: [guard], additionalInstruction: [{ text: "Otherwise hold" }] }] }] };
    const native = formatSig(input, "long", { locale, realizationMode: "normalized" });
    expect(native).toContain("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160");
    let calls = 0;
    const actual = formatSig(input, "long", { locale, realizationMode: "normalized", i18n: { formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(native);
      expect(context.formatDefault("long")).toBe(native);
      expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
      return "Clinic: " + context.formatDefault("long");
    } } });
    expect(actual).toBe("Clinic: " + native);
    expect(calls).toBe(1);
  });

  it.each(["en", "th"] as const)("keeps occurrence and tablet limits distinct in short %s directions", locale => {
    const guardText = (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160";
    const occurrenceText = locale === "en" ? "maximum 4 doses per day" : "ไม่เกิน 4 ครั้งต่อวัน";
    for (const kind of ["occurrence", "quantity"] as const) {
      const source = locale === "en"
        ? "Take 2 tablets q4h if SBP > 160, no more than " + (kind === "occurrence" ? "4 doses per day" : "4 tablets/day")
        : "รับประทาน 2 เม็ด ทุก 4 ชั่วโมง ถ้า SBP > 160, ไม่เกิน " + (kind === "occurrence" ? "4 ครั้งต่อวัน" : "4 เม็ดต่อวัน");
      const parsed = parseSig(source, { locale });
      const before = JSON.stringify(parsed);
      const administration = parsed.meta.canonical.course!.stages[0].administrations[0];
      expect(administration.amounts?.[0].quantity?.value).toBe(2);
      expect(administration.predicate).toMatchObject({ kind: "measurement", value: 160 });
      if (kind === "occurrence") expect(administration.schedule?.recurrence?.occurrenceCap)
        .toEqual({ max: 4, period: 1, periodUnit: FhirPeriodUnit.Day });
      else expect(administration.limits?.[0]).toMatchObject({ amount: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" } });
      for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        for (const style of ["short", "long"] as const) {
          const text = formatSig(input, style, { locale, realizationMode: "normalized" });
          expect(text).toMatch(locale === "en" ? /(?<!\d)2 (?:tab|tablets)(?![A-Za-z])/u : /(?<!\d)2 เม็ด/u);
          expect(text.match(/SBP > 160/gu)).toHaveLength(1);
          if (kind === "occurrence") {
            expect(text).toContain(occurrenceText + " " + guardText);
            expect(text).not.toContain("4 tab /");
          } else {
            expect(text).toContain(guardText);
            expect(text).toContain("4 tab / 1 d");
            expect(text).not.toContain(occurrenceText);
          }
        }
      }
      expect(parsed.input).toBe(source);
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(parsed)).toBe(before);
    }
  });

  it.each(["en", "th"] as const)("preserves occurrence caps and independent advice in complete %s defaults", locale => {
    const guardText = (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160";
    const occurrenceText = locale === "en" ? "maximum 4 doses per day" : "ไม่เกิน 4 ครั้งต่อวัน";
    for (const structuredDose of [true, false]) {
      const source = structuredDose ? "Take 2 tablets every 4 hours." : "Swallow 2 tablets whole";
      const input: FhirR6DosageInstruction = { step: [{ component: [{ text: source,
        ...(structuredDose ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] } : {}),
        timing: { repeat: {
          ...(structuredDose ? { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour } : {}),
          extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
            { url: "max", valueInteger: 4 },
            { url: "period", valueQuantity: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" } }
          ] }]
        } }, condition: [guard], additionalInstruction: [{ text: "Recheck BP only if SBP > 160" }], extension: [note]
      }] }] };
      const rows = toFhirR5Dosages(input), native = fromFhir(input).meta.canonical.course!;
      expect(rows[0].text).toBe(source);
      expect(rows[0].extension).toContainEqual(note);
      for (const value of [native, rows, input]) {
        const before = JSON.stringify(value), options = { locale, realizationMode: "normalized" as const };
        const short = formatSig(value, "short", options), long = formatSig(value, "long", options);
        for (const text of [short, long]) {
          expect(text).toContain(occurrenceText);
          if (structuredDose) {
            const primary = text.split("Recheck BP")[0].split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
            expect(primary).toContain(occurrenceText + " " + guardText);
            expect(primary).toMatch(locale === "en" ? /(?<!\d)2 (?:tab|tablets)(?![A-Za-z])/u : /(?<!\d)2 เม็ด/u);
          } else expect(text).toContain(source + " " + guardText);
          expect(text).toContain(source);
        }
        expect(long).toContain("Recheck BP only if SBP > 160");
        expect(long.match(/SBP > 160/gu)).toHaveLength(2);
        let calls = 0;
        const custom = formatSig(value, "long", { ...options, i18n: { formatLong: context => {
          calls++;
          expect(context.defaultText).toBe(long);
          expect(context.formatDefault("long")).toBe(long);
          expect(context.formatDefault("short")).toBe(short);
          expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
          expect(context.clause.schedule?.occurrenceCap).toEqual({ max: 4, period: 1, periodUnit: FhirPeriodUnit.Day });
          expect(context.clause.dose?.value).toBe(structuredDose ? 2 : undefined);
          return "  Clinic wording, unchanged!  ";
        } } });
        expect(calls).toBe(1);
        expect(custom).toBe("  Clinic wording, unchanged!  ");
        expect(JSON.stringify(value)).toBe(before);
      }
    }
  });

  it.each(["cycle", "clock window", "offset"] as const)("composes the complete %s before the callback", kind => {
    const component: NonNullable<FhirR6DosageInstruction["step"]>[number]["component"][number] = {
      doseAndRate: [dose], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00"] } }, extension: [note]
    };
    if (kind === "cycle") component.modifierExtension = [cycleDayConstraintExtension({
      days: [1, 2, 3, 4, 5], periodDays: 28, reason: "unresolved-cycle-eligibility", sourceText: ""
    })];
    if (kind === "clock window") component.timing!.repeat!.extension = [{
      url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [{ url: "start", valueTime: "08:00:00" },
        { url: "end", valueTime: "18:00:00" }, { url: "endInclusive", valueBoolean: false }]
    }];
    if (kind === "offset") component.modifierExtension = [{ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: 30, unit: "min", code: "min", system: "http://unitsofmeasure.org" } }];
    const input: FhirR6DosageInstruction = { step: [{ component: [component] }] };
    for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), native = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(native).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
      if (kind === "cycle") { expect(native).toContain("1-5"); expect(native).toContain("28"); }
      if (kind === "clock window") { expect(native).toContain("08:00"); expect(native).toContain("18:00"); }
      if (kind === "offset") expect(native).toContain(locale === "en" ? "9:30 am" : "09:30");
      for (const wrapper of [false, true]) {
        let calls = 0;
        const actual = formatSig(input, "long", { locale, realizationMode: "normalized", i18n: { formatLong: context => {
          calls++;
          const timing = context.clause.schedule!;
          if (kind === "cycle") expect(timing.cycleDayConstraint).toMatchObject({ days: [1, 2, 3, 4, 5], periodDays: 28 });
          if (kind === "clock window") expect(timing.clockWindow).toEqual({ start: "08:00:00", end: "18:00:00", endInclusive: false });
          if (kind === "offset") expect(timing.administrationOffsetMinutes).toBe(30);
          expect(context.defaultText).toBe(native);
          expect(context.formatDefault("long")).toBe(native);
          return wrapper ? "Clinic: " + context.formatDefault("long") : "Clinic wording, unchanged!";
        } } });
        expect(actual).toBe(wrapper ? "Clinic: " + native : "Clinic wording, unchanged!");
        expect(calls).toBe(1);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("preserves a native locale through ordinary copied providers and inheritance", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [dose], condition: [guard],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    const thai = resolveSigLocalization("th")!;
    const copied = { ...thai, locale: "clinic-th-copy" };
    const keys = Reflect.ownKeys(copied);
    registerSigLocalization(copied);
    const expected = "ใช้ครั้งละ 1 เม็ด วันละครั้ง เฉพาะเมื่อ SBP > 160.";
    for (const options of [{ locale: copied.locale }, { i18n: { ...thai, locale: "clinic-th-call" } },
      { locale: "en", i18n: { inherit: copied.locale } }, { locale: "en", i18n: { inherit: "th" } }])
      expect(formatSig(source, "long", options)).toBe(expected);
    expect(Reflect.ownKeys(copied)).toEqual(keys);
    let calls = 0;
    expect(formatSig(source, "long", { i18n: { ...thai, locale: "clinic-th-hook", formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(expected);
      expect(context.formatDefault("long")).toBe(expected);
      return "Clinic: " + context.defaultText;
    } } })).toBe("Clinic: " + expected);
    expect(calls).toBe(1);
  });
});


describe("native renderer inheritance", () => {
  it.each(["en", "th"])("keeps partial-count timing roles in the complete %s callback default", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { text: "once daily" }, repeat: { frequencyMax: 3 } } };
    const sourceLabel = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
    const expected = locale === "en"
      ? "Current: Use 1 tablet up to 3 times; original directions: once daily."
      : "ปัจจุบัน: ใช้ครั้งละ 1 เม็ด ไม่เกิน 3 ครั้ง; ข้อความเดิม: once daily.";
    for (const input of [row, toDosageDetails([row])]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale })).toBe(expected);
      const compact = formatSig(input, "short", { locale }).split(sourceLabel);
      expect(compact).toHaveLength(2);
      expect(compact[0]).not.toContain("once daily");
      expect(compact[1]).toBe("once daily.");
      let calls = 0;
      expect(formatSig(input, "long", { locale, i18n: { formatLong: context => {
        calls++;
        expect(context.clause.schedule?.frequencyMax).toBe(3);
        expect(context.clause.schedule?.timingText ?? context.clause.schedule?.timingCode).toBe("once daily");
        expect(context.defaultText).toBe(expected);
        expect(context.formatDefault("long")).toBe(expected);
        expect(context.formatDefault("short").split(sourceLabel)[1]).toBe("once daily.");
        return "Clinical wording, unchanged!";
      } } })).toBe("Clinical wording, unchanged!");
      expect(calls).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("keeps the target native default when the inherited provider supplies only a short callback", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(input);
    const provider = { locale: "clinic-short-no-native", formatShort: () => "Clinic short" };
    const keys = Reflect.ownKeys(provider);
    registerSigLocalization(provider);
    const i18n = { inherit: provider.locale };
    const expected = "ใช้ครั้งละ 1 เม็ด วันละครั้ง.";
    expect(formatSig(input, "long", { locale: "th", i18n })).toBe(expected);
    expect(formatSig(input, "short", { locale: "th", i18n })).toBe("Clinic short");
    expect(formatSig(input, "long", { locale: "unregistered-native", i18n })).toBe("Use 1 tablet once daily.");
    const shortDefault = formatSig(input, "short", { locale: "th" });
    let calls = 0;
    expect(formatSig(input, "long", { locale: "th", i18n: { ...i18n, formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(expected);
      expect(context.formatDefault("long")).toBe(expected);
      expect(context.formatDefault("short")).toBe(shortDefault);
      return "Clinical wording, unchanged!";
    } } })).toBe("Clinical wording, unchanged!");
    expect(calls).toBe(1);
    expect(Reflect.ownKeys(provider)).toEqual(keys);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("typed meal-state locale realization", () => {
  it("localizes an admitted negative food adjunct while retaining its dose and water", () => {
    const source = "Swallow 1 tablet with water without food";
    const parsed = parseSig(source), clause = parsed.meta.canonical.clauses[0];
    const frames = clause.additionalInstructions?.flatMap(instruction => instruction.frames ?? []);
    expect(frames).toContainEqual(expect.objectContaining({
      relation: AdviceRelation.Without,
      args: [expect.objectContaining({ role: AdviceArgumentRole.MealState,
        text: "food", normalized: "food", conceptId: "food" })]
    }));
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    const before = JSON.stringify([parsed.meta.canonical, parsed.fhir, parsed.fhirNext]);
    for (const input of [parsed.meta.canonical.course!,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" })
        .split("; original directions: ")[0];
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" })
        .split("; ข้อความเดิม: ")[0];
      expect(en).toContain("without food");
      expect(en).not.toContain("with food");
      expect(en).toContain("water");
      expect(en.match(/\b1 tablet\b/gu)).toHaveLength(1);
      expect(th).toMatch(/โดยไม่มี\s*อาหาร/u);
      expect(th).toContain("น้ำ");
      expect(th.match(/(?:^|[^\d.])1 เม็ด/gu)).toHaveLength(1);
      expect(th).not.toMatch(/food|water/iu);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify([parsed.meta.canonical, parsed.fhir, parsed.fhirNext])).toBe(before);
  });

  it.each([undefined, "อาหารที่จัดไว้"])("preserves typed identity and a supplied Thai nominal: %s", thai => {
    const source = "Take 1 tablet without food";
    const clause: CanonicalSigClause = {
      kind: "administration", rawText: source, raw: { start: 0, end: source.length, text: source },
      dose: { value: 1, unit: "tab" }, leftovers: [], evidence: [], confidence: 1,
      additionalInstructions: [{ text: "Take without food", frames: [{
        force: AdviceForce.Instruction, predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.Without, sequenceIndex: 0,
        sourceText: "without food", span: { start: 14, end: source.length },
        args: [{ role: AdviceArgumentRole.MealState, text: "food", normalized: "food", conceptId: "food",
          ...(thai ? { i18n: { th: thai } } : {}) }]
      }] }]
    };
    const before = JSON.stringify(clause);
    const en = formatCanonicalClause(clause, "long", resolveSigLocalization("en"));
    const th = formatCanonicalClause(clause, "long", resolveSigLocalization("th"));
    expect(en).toContain("without food");
    expect(th).toContain("โดยไม่มี " + (thai ?? "อาหาร"));
    expect(th).not.toContain("food");
    expect(JSON.stringify(clause)).toBe(before);
  });
});

describe("native timing realization uses selected language and event owners", () => {
  it.each(["en", "th"])("uses the selected %s interval unit for coded and structured timing", locale => {
    const i18n = { locale: "clinic-interval-" + locale, inherit: locale,
      course: { timeUnit: (unit: string) => unit === "h" ? "clinic-hour" : undefined } };
    for (const timing of [
      { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q6H" }] } },
      { repeat: { period: 6, periodUnit: FhirPeriodUnit.Hour } }
    ]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing };
      for (const input of [row, toDosageDetails([row])])
        expect(formatSig(input, "long", { locale, i18n, realizationMode: "normalized" }))
          .toContain(locale === "en" ? "every 6 clinic-hour" : "ทุก 6 clinic-hour");
    }
    for (const period of [1, 6]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { period, periodUnit: FhirPeriodUnit.Hour } } };
      expect(formatSig(row, "long", { locale })).toContain(locale === "en"
        ? `every ${period} ${period === 1 ? "hour" : "hours"}` : `ทุก ${period} ชั่วโมง`);
    }
  });

  it.each(["code", "event", "clock"] as const)("retains the %s event owner in a partial-period preview", owner => {
    const timing: NonNullable<FhirR6DosageInstruction["step"][number]["component"][number]["timing"]> = {
      code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "AM" }] },
      repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 1, unit: "h", system: "http://unitsofmeasure.org", code: "h" },
        ...(owner === "event" ? { when: [EventTiming.Evening] } : owner === "clock" ? { timeOfDay: ["20:00:00"] } : {}) }
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing
    }] }] };
    const before = JSON.stringify(raw);
    const converted = toFhirR5Dosages(raw);
    for (const input of [raw, converted]) for (const locale of ["en", "th"])
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale, realizationMode: "normalized" });
        if (owner === "code") expect(text).toContain(locale === "en" ? style === "short" ? "MORN" : "morning" : "เช้า");
        else {
          expect(text).not.toContain(locale === "en" ? style === "short" ? "MORN" : "morning" : "เช้า");
          if (owner === "event") expect(text).toContain(locale === "en" ? style === "short" ? "EVE" : "evening" : "เย็น");
          else expect(text).toContain(locale === "en" && style === "long" ? "8:00 pm" : "20:00");
        }
        expect(text).toContain(locale === "en"
          ? "No doses during the final 1 hour of each period" : "งดยาในช่วง 1 ชั่วโมงสุดท้ายของแต่ละรอบ");
      }
    expect(converted[0].timing?.code).toEqual(timing.code);
    expect(raw.step[0].component[0].timing?.code).toEqual(timing.code);
    expect(JSON.stringify(raw)).toBe(before);
  });
});


describe("published course providers with shared schedule limits", () => {
  it.each(["en", "th"])("inherits native %s shared wording with a plain customized count provider", inherit => {
    // An existing provider implements the published course facet, without a
    // newly required method for an internally introduced shared-schedule view.
    const { sharedAdministration: _unpublished, ...published } = resolveSigLocalization(inherit)!.course! as
      CourseLanguage & { sharedAdministration?: unknown };
    const course: CourseLanguage = { ...published, administrations: count => count + " clinic administrations" };
    const i18n = { locale: "x-clinic-" + inherit, inherit, course };
    const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. On Mondays, do not take the 1-tablet morning dose.";
    const parsed = parseSig(source), original = JSON.stringify(parsed);
    const localized = parseSig(source, { i18n });
    expect(localized.longText.match(/4 clinic administrations/gu)).toHaveLength(1);
    expect(localized.fhirNext.renderedInstruction).toBe(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const text = formatSig(input, "long", { i18n, realizationMode: "normalized" });
      expect(text.match(/4 clinic administrations/gu)).toHaveLength(1);
      expect(text).toContain(inherit === "en" ? "Schedule sharing its limits" : "ตารางให้ยาที่ใช้ข้อจำกัดร่วมกัน");
      expect(text).toMatch(inherit === "en" ? /8:00 am/u : /08:00/u);
      expect(text).toMatch(inherit === "en" ? /8:00 pm/u : /20:00/u);
      expect(text).toContain(inherit === "en" ? "except Monday" : "ยกเว้นวันจันทร์");
      expect(JSON.stringify(input)).toBe(before);
    }
    const ordinary = parseSig("Take 1 tablet at 08:00 daily.").meta.canonical.course!;
    expect(formatSig(ordinary, "long", { i18n })).toBe(formatSig(ordinary, "long", { locale: inherit }));
    expect(JSON.stringify(parsed)).toBe(original);
    expect(course.administrations("4")).toBe("4 clinic administrations");
    expect("sharedAdministration" in course).toBe(false);
  });
});


describe("scoped warning ownership with a registered course provider", () => {
  it("keeps conditional warnings and the customized shared total through native and wire views", () => {
    const locale = "x-clinic-warning";
    const course: CourseLanguage = {
      ...resolveSigLocalization("en")!.course!,
      administrations: count => count + " clinic administrations"
    };
    registerSigLocalization({ locale, inherit: "en", course });
    const warning = "If dizzy, do not take the 1-tablet morning dose";
    const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. " + warning + ".";
    const parsed = parseSig(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(/4 clinic administrations/gu)).toHaveLength(1);
      expect(text.split(warning)).toHaveLength(3);
      expect(text).not.toContain("Do not take the 1 tablet morning dose");
      expect(text).toContain("1 tablet orally at 8:00 am unless dizzy");
      const evening = text.match(/1 tablet orally at 8:00 pm[^;.]*[;.]?/u)?.[0];
      expect(evening).toBeDefined();
      expect(evening).not.toMatch(/\b(?:unless|only if)\b/u);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});

// Current R6 contract and projection checks, preserved as one complete group.
describe("current FHIR R6 DosageInstruction boundary (2026-11-13 Snapshot 1)", () => {
  it("matches the pinned HL7 element hierarchy and emitted R6 wire fieldsets", () => {
    const profiles = r6SnapshotContract.profiles;
    expect(r6SnapshotContract.target).toBe("FHIR R6 6.0.0-snapshot1");
    expect(profiles.Timing.constraints).toContainEqual({ path: "Timing.repeat", key: "tim-10",
      severity: "error", expression: "timeOfDay.empty() or when.empty()" });
    const field = (name: keyof typeof profiles, path: string) =>
      profiles[name].elements.find(entry => entry.path === path);
    expect(field("DosageInstruction", "DosageInstruction.step.component")).toMatchObject({
      min: 1, max: "*", types: ["Dosage"]
    });
    expect(field("DosageInstruction", "DosageInstruction.step")).toMatchObject({
      types: ["Element"]
    });
    expect(field("Dosage", "Dosage.doseAndRate")).toMatchObject({ types: ["Element"] });
    expect(field("Timing", "Timing.repeat.startOffset")).toMatchObject({ max: "1", types: ["Quantity"],
      typeProfiles: { Quantity: ["http://hl7.org/fhir/StructureDefinition/SimpleQuantity"] } });
    expect(field("Timing", "Timing.repeat.endOffset")).toMatchObject({ max: "1", types: ["Quantity"],
      typeProfiles: { Quantity: ["http://hl7.org/fhir/StructureDefinition/SimpleQuantity"] } });
    expect(field("Dosage", "Dosage.sequence")).toBeUndefined();

    // Exercise tim-10 on the emitted combination, not just the allowed keys.
    // One recurrence owns the event-relative opportunity and independent clock.
    const mixed = toDosageDetails([{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, count: 3,
        when: [EventTiming["Before Breakfast"]], offset: 30, timeOfDay: ["09:00:00"] } } }]);
    expect(mixed.step).toHaveLength(1);
    expect(mixed.step[0].component).toHaveLength(1);
    const mixedRepeat = mixed.step[0].component[0].timing!.repeat!;
    expect(Boolean(mixedRepeat.timeOfDay?.length && mixedRepeat.when?.length)).toBe(false);
    expect(mixedRepeat).toMatchObject({ count: 3, when: [EventTiming["Before Breakfast"]], offset: 30 });
    expect(getTimingClocks(mixedRepeat)).toEqual(["09:00:00"]);
    expect(mixedRepeat.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-additional-clock", valueTime: "09:00:00",
    });

    const primitiveTypes = new Set(["base64Binary", "boolean", "canonical", "code", "date", "dateTime",
      "decimal", "id", "instant", "integer", "integer64", "markdown", "oid", "positiveInt",
      "string", "time", "unsignedInt", "uri", "url", "uuid"]);
    const permitted = (name: keyof typeof profiles, parent: string) =>
      new Set(profiles[name].elements
        .filter(entry => entry.path.startsWith(parent + ".") &&
          !entry.path.slice(parent.length + 1).includes("."))
        .flatMap(entry => {
          const fieldName = entry.path.slice(parent.length + 1);
          return entry.types.flatMap(type => {
            const key = fieldName.endsWith("[x]")
              ? fieldName.slice(0, -3) + type[0].toUpperCase() + type.slice(1) : fieldName;
            return primitiveTypes.has(type) ? [key, "_" + key] : [key];
          });
        }));
    const assertWireKeys = (value: object, keys: Set<string>) => {
      for (const key of Object.keys(value)) {
        expect(keys.has(key), `R6 wire field ${key} is absent from the pinned profile`).toBe(true);
      }
    };
    assertWireKeys({ renderedInstruction: "Take one tablet", _renderedInstruction: { id: "authored-text" } },
      permitted("DosageInstruction", "DosageInstruction"));
    assertWireKeys({ valueInteger: 3, _valueInteger: { id: "authored-limit" } },
      permitted("DosageSafety", "DosageSafety.doseLimit"));
    expect(permitted("DosageSafety", "DosageSafety.doseLimit").has("valueinteger")).toBe(false);
    expect(permitted("Dosage", "Dosage.doseAndRate").has("_doseQuantity")).toBe(false);
    expect(permitted("DosageInstruction", "DosageInstruction").has("_unknownClinicalField")).toBe(false);
    const parsed = parseSig("1 drop OD q2h for 1 week then qid for 1 month");
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step[0].component).toHaveLength(1);
    expect(parsed.fhirNext.step[1].component).toHaveLength(1);
    expect(parsed.fhirNext.step[0].component[0].timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(parsed.fhirNext.step[1].component[0].timing?.repeat).toMatchObject({ frequency: 4, period: 1, periodUnit: "d" });
    for (const step of parsed.fhirNext.step) {
      expect(step.component[0].doseAndRate).toEqual([{ doseQuantity: expect.objectContaining({ value: 1, unit: "drop" }) }]);
      expect(step.component[0].site?.concept?.coding).toContainEqual(expect.objectContaining({
        system: "http://snomed.info/sct", code: "1290032005",
      }));
    }
    assertWireKeys(parsed.fhirNext, permitted("DosageInstruction", "DosageInstruction"));
    for (const step of parsed.fhirNext.step) {
      assertWireKeys(step, permitted("DosageInstruction", "DosageInstruction.step"));
      for (const component of step.component) {
        assertWireKeys(component, permitted("Dosage", "Dosage"));
        for (const rate of component.doseAndRate ?? []) {
          assertWireKeys(rate, permitted("Dosage", "Dosage.doseAndRate"));
          expect(["doseQuantity", "doseRange", "doseExpression"].filter(key =>
            Object.prototype.hasOwnProperty.call(rate, key))).toHaveLength(1);
          expect(["rateQuantity", "rateRange", "rateRatio", "rateExpression"].filter(key =>
            Object.prototype.hasOwnProperty.call(rate, key)).length).toBeLessThanOrEqual(1);
        }
        if (component.timing?.repeat)
          assertWireKeys(component.timing.repeat, permitted("Timing", "Timing.repeat"));
      }
    }
  });

  it("uses one DosageInstruction with concurrent components and no obsolete step/backbone fields", () => {
    const parsed = parseSig("2 tabs morning, 1 tab evening for 1 week, then 2 tabs morning for 1 month");
    const course = parsed.fhirNext;
    expect(course.step.map(step => step.component.length)).toEqual([2, 1]);
    for (const step of course.step) {
      expect(step).not.toHaveProperty("modifierExtension");
      for (const component of step.component) {
        expect(component).not.toHaveProperty("sequence");
        for (const entry of component.doseAndRate ?? []) expect(entry).not.toHaveProperty("modifierExtension");
      }
    }
    expect(fromFhir(JSON.parse(JSON.stringify(course))).fhirNext).toEqual(course);
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("imports R6-only period offsets and retains them through editable R5 without emitting R6 fields on R5", () => {
    const course: FhirR6DosageInstruction = {
      renderedInstruction: "One tablet daily starting day 3, for 21 days in each 28-day cycle.",
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ component: [{
        timing: { repeat: {
          frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
          startOffset: { value: 2, unit: "d", code: "d" },
          endOffset: { value: 5, unit: "d", code: "d" }
        } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    expect(fromFhir(course).fhirNext).toEqual(course);
    const rows = toFhirR5Dosages(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].timing?.repeat).not.toHaveProperty("startOffset");
    expect(rows[0].timing?.repeat).not.toHaveProperty("endOffset");
    const retained = JSON.stringify(rows[0].modifierExtension);
    expect(retained).toContain('"timingOffsets"');
    expect(retained).not.toContain('"valueTiming"');
    expect(retained).not.toContain('"startOffset":{"value"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    const edited = JSON.parse(JSON.stringify(rows)) as EzDosage[];
    edited[0].timing!.repeat!.frequency = 20;
    const adjusted = toDosageDetails(edited);
    expect(adjusted.step[0].component[0].timing?.repeat).toEqual({
      ...course.step[0].component[0].timing!.repeat, frequency: 20,
    });
    expect(adjusted.step[0].component[0].timing?.repeat).toMatchObject({
      period: 28, periodUnit: FhirPeriodUnit.Day,
      startOffset: { value: 2, code: "d" }, endOffset: { value: 5, code: "d" },
    });
  });

  it("keeps scalar qualifiers and CodeableReference metadata through both FHIR projections", () => {
    const course: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { id: "site-one", extension: [{ url: "https://example.org/site-meta", valueString: "retained" }],
          reference: { identifier: { system: "https://example.org/body", value: "left" },
            display: "original location" } },
        doseAndRate: [{
          doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })!,
          rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })!
        }]
      }] }]
    };
    expect(fromFhir(course).fhirNext).toEqual(course);
    const rows = toFhirR5Dosages(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      value: 1, unit: "tab", extension: [expect.objectContaining({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      })]
    });
    expect(rows[0].doseAndRate?.[0].rateQuantity).toMatchObject({
      value: 4, unit: "mL/h", extension: [expect.objectContaining({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000053" }
      })]
    });
    expect(JSON.stringify(rows)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(formatSig(course, "long", { locale: "en" })).toContain("approximately 1 tablet");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toContain("approximately 1 tablet");
    expect(formatSig(course, "long", { locale: "en" })).toContain("Rate: >=4 mL/h");
    expect(fromFhir(course, { locale: "th" }).longText).toContain("ประมาณ 1 เม็ด");
    expect(toDosageDetails(rows)).toEqual(course);
    const edited = cloneStructuredValue(rows);
    edited[0].doseAndRate![0].doseQuantity = { value: 2, unit: "tab" };
    const recomposed = toDosageDetails(edited);
    expect(recomposed.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "tab" });
    expect(getQuantityComparator(recomposed.step[0].component[0].doseAndRate?.[0].rateQuantity)).toBe(">=");
  });

  it("retains concept-only R6 site metadata independently of any cycle trigger", () => {
    const course: FhirR6DosageInstruction = {
      step: [{ component: [{
        site: { id: "site-concept", concept: { text: "left eye" },
          extension: [{ url: "https://example.org/site-provenance", valueString: "reviewed" }] },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
      }] }]
    };
    // Only site id/extension licenses compact R5 metadata in this first case.
    const siteOnly = toFhirR5Dosages(course);
    expect(siteOnly[0].site?.text).toBe("left eye");
    expect(siteOnly[0].modifierExtension?.length).toBeGreaterThan(0);
    expect(toDosageDetails(JSON.parse(JSON.stringify(siteOnly)))).toEqual(course);

    // Independently, R6's approximate cycle remains a typed R5 extension.
    const withCycle: FhirR6DosageInstruction = {
      ...course, repeatCycle: { value: 28, comparator: "~", code: "d", unit: "d" }
    };
    const projected = toFhirR5Dosages(withCycle);
    expect(JSON.stringify(projected)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(projected)).toContain('"100000000055"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(projected)))).toEqual(withCycle);
  });

  it("supersedes unchanged imported expressions when the clinician adds numeric dose and rate choices", () => {
    const imported: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        doseExpression: { language: "text/fhirpath", expression: "%patient.weight*2" },
        rateExpression: { language: "text/fhirpath", expression: "4*%patient.weight" }
      }]
    }] }] };
    const rows = JSON.parse(JSON.stringify(fromFhir(imported).fhir));
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "mg" };
    rows[0].doseAndRate![0].rateQuantity = { value: 4, unit: "mL/h" };
    const corrected = toDosageDetails(rows);
    expect(corrected.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: { value: 2, unit: "mg" },
      rateQuantity: { value: 4, unit: "mL/h" }
    }]);
    expect(fromFhir(corrected).fhirNext).toEqual(corrected);
    expect(corrected.extension).toContainEqual(expect.objectContaining({
      valueString: expect.stringContaining("superseded by edited R5 dose fields")
    }));

    // A different clinician-edited expression is not the old retained one.
    // Keep both authored choices available for manual correction, rather than
    // silently choosing between contradictory edits.
    const conflicting = JSON.parse(JSON.stringify(fromFhir(imported).fhir));
    conflicting[0].doseAndRate![0].doseExpression = { expression: "%patient.weight*3" };
    conflicting[0].doseAndRate![0].doseQuantity = { value: 3, unit: "mg" };
    const unresolved = toDosageDetails(conflicting);
    const unresolvedAmount = unresolved.step[0].component[0].doseAndRate![0];
    expect(unresolvedAmount.doseQuantity).toBeUndefined();
    expect(unresolvedAmount.doseExpression).toBeUndefined();
    expect(unresolvedAmount.extension).toContainEqual({
      url: "urn:ezmedicationinput:r6-unresolved-dose-source", extension: [
        { url: "doseQuantity", valueQuantity: { value: 3, unit: "mg" } },
        { url: "doseExpression", valueExpression: { expression: "%patient.weight*3" } },
      ],
    });
    expect(() => fromFhir(unresolved)).not.toThrow();
    expect(fromFhir(JSON.parse(JSON.stringify(unresolved))).fhirNext.step[0].component[0].doseAndRate![0])
      .toEqual(unresolvedAmount);
    expect(conflicting[0].doseAndRate![0]).toMatchObject({
      doseExpression: { expression: "%patient.weight*3" }, doseQuantity: { value: 3 },
    });
  });

  it("executes R6 21-in-28 active-window offsets without administering during the rest days", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" },
        endOffset: { value: 5, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const anchor = "2026-11-02T00:00:00+07:00";
    const opts = { from: anchor, orderedAt: anchor, timeZone: "Asia/Bangkok", limit: 22 };
    const expected = [
      "2026-11-04T00:00:00+07:00",
      "2026-11-05T00:00:00+07:00",
      "2026-11-06T00:00:00+07:00",
      "2026-11-07T00:00:00+07:00",
      "2026-11-08T00:00:00+07:00",
      "2026-11-09T00:00:00+07:00",
      "2026-11-10T00:00:00+07:00",
      "2026-11-11T00:00:00+07:00",
      "2026-11-12T00:00:00+07:00",
      "2026-11-13T00:00:00+07:00",
      "2026-11-14T00:00:00+07:00",
      "2026-11-15T00:00:00+07:00",
      "2026-11-16T00:00:00+07:00",
      "2026-11-17T00:00:00+07:00",
      "2026-11-18T00:00:00+07:00",
      "2026-11-19T00:00:00+07:00",
      "2026-11-20T00:00:00+07:00",
      "2026-11-21T00:00:00+07:00",
      "2026-11-22T00:00:00+07:00",
      "2026-11-23T00:00:00+07:00",
      "2026-11-24T00:00:00+07:00",
      "2026-12-02T00:00:00+07:00",
    ];
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const due = nextDueDoses(input, opts);
      expect(due).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...opts,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
      expect(calculateTotalUnits({ dosage: input, ...opts,
        durationValue: 56, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    }
    expect(fromFhir(course).fhirNext).toEqual(course);
    // Multiple interlaced tracks need their own proven shared scheduling
    // semantics, not a guessed single phase or silently ignored offsets.
    const multi: FhirR6DosageInstruction = { step: [{ component: [
      course.step[0].component[0], { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }
    ] }] };
    expect(fromFhir(multi).fhirNext).toEqual(multi);
    expect(() => nextDueDoses(multi, opts)).toThrow(/Interlaced R6 offsets/);
    expect(() => calculateTotalUnits({ dosage: multi, ...opts,
      durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/Interlaced R6 offsets/);
  });

  it("imports current R6 offset timing with incomplete tim-11/tim-12 as an editable warning", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        count: 6, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 8, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const imported = fromFhir(course);
    expect(imported.fhirNext).toEqual(course);
    expect(imported.fhir).toHaveLength(1);
    expect(imported.warnings).toEqual([expect.stringContaining("tim-11/tim-12")]);
    expect(imported.longText).toContain("Dosing starts 8 days");
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
    const execution = { from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok", limit: 5 };
    expect(() => nextDueDoses(imported, execution)).toThrow(/R6 period offsets need/);
    expect(() => calculateTotalUnits({ dosage: course, ...execution,
      durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/R6 period offsets need/);
    // Actual invalid SimpleQuantity values still fail the current-R6 type gate.
    const malformed: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 3, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, comparator: ">" } as never } }
    }] }] };
    expect(() => fromFhir(malformed)).toThrow(/SimpleQuantity/);
  });

  it("keeps superseded R6 source provenance on the edited row, without global warning scans", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [
      { doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })! }] },
      { doseAndRate: [{ doseQuantity: { value: 3, unit: "tab" } }] }
    ] }] };
    const rows = structuredClone(toFhirR5Dosages(course));
    rows[0].doseAndRate![0].doseQuantity = { value: 2, unit: "tab" };
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual({ value: 2, unit: "tab" });
    expect(restored.step[0].component[1]).toEqual(course.step[0].component[1]);
    const sources = restored.extension?.filter(entry =>
      entry.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(sources).toHaveLength(1);
    expect(JSON.stringify(sources[0])).toContain('"100000000055"');
    expect(JSON.stringify(sources[0])).toContain('"rowIndex","valueInteger":0');
    expect(JSON.stringify(sources[0])).not.toContain('"rowIndex","valueInteger":1');

    const withOffset: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const edited = structuredClone(toFhirR5Dosages(withOffset));
    edited[0].timing!.repeat!.period = 30;
    const changed = toDosageDetails(edited);
    expect(changed.step[0].component[0].timing?.repeat?.startOffset).toBeUndefined();
    const offsetSources = changed.extension?.filter(entry =>
      entry.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(offsetSources).toHaveLength(1);
    expect(JSON.stringify(offsetSources[0])).toContain('"startOffset"');
    expect(JSON.stringify(offsetSources[0])).toContain('"value":2');
    expect(changed.extension).toContainEqual(expect.objectContaining({
      valueString: expect.stringContaining("original R6 values remain available")
    }));
  });

  it("shows source-less R6 active-window offsets in EN/TH instead of false whole-period cadence", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" },
        endOffset: { value: 5, unit: "d", code: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const en = formatSig(course, "long", { locale: "en" });
    expect(en).toContain("21 administrations per 28 days");
    expect(en).toContain("Dosing starts 2 days after");
    expect(en).toContain("No doses during the final 5 days");
    expect(en).not.toContain("1 tablet every 28 days");
    const th = formatSig(course, "long", { locale: "th" });
    expect(th).toContain("ให้ยา 21 ครั้งต่อช่วง 28 วัน");
    expect(th).toContain("เริ่มให้ยาหลังเริ่มรอบ 2 วัน");
    expect(th).toContain("งดยาในช่วง 5 วันสุดท้าย");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toBe(en);
    expect(fromFhir(course, { locale: "th" }).items[0].longText).toBe(th);
    const authored = { ...course, renderedInstruction: "Take as directed by prescriber." };
    expect(formatSig(authored, "long")).toBe("Current: " + en + "; original directions: " + authored.renderedInstruction);
    expect(fromFhir(authored).fhirNext.renderedInstruction).toBe(authored.renderedInstruction);
  });

  it("does not restore approximate quantities over a clinician's new dose/rate expressions", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })!,
        rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })!
      }]
    }] }] };
    const edited = cloneStructuredValue(toFhirR5Dosages(course));
    edited[0].doseAndRate![0].doseExpression = {
      language: "text/fhirpath", expression: "%patient.weight"
    };
    edited[0].doseAndRate![0].rateExpression = {
      language: "text/fhirpath", expression: "%patient.weight / 2"
    };
    const restored = toDosageDetails(edited);
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      doseExpression: { language: "text/fhirpath", expression: "%patient.weight" },
      rateExpression: { language: "text/fhirpath", expression: "%patient.weight / 2" }
    }]);
    const retained = restored.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).toContain('"100000000055"');
    expect(JSON.stringify(retained)).toContain('"100000000053"');
    expect(fromFhir(restored).fhirNext).toEqual(restored);
  });

  it("renders R6-only component quantities even when the enclosing course has authored wording", () => {
    const course: FhirR6DosageInstruction = {
      renderedInstruction: "Follow the clinician's written taper.",
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, comparator: "~", unit: "tab" })! }]
      }] }]
    };
    const imported = fromFhir(course);
    expect(imported.longText).toContain("approximately 1 tablet");
    expect(imported.fhirNext.renderedInstruction).toBe(course.renderedInstruction);
    expect(imported.items[0].longText).toContain("approximately 1 tablet");
    expect(imported.items[0].shortText).toMatch(/~1\s*(?:tab|tablet)/u);
    // Component text remains source evidence while current quantity facts own the preview.
    const sourced: FhirR6DosageInstruction = {
      ...course, step: [{ component: [{
        ...course.step[0].component[0], text: "Approximately one tablet as directed."
      }] }]
    };
    expect(fromFhir(sourced).items[0].longText).toContain("approximately 1 tablet");
    expect(fromFhir(sourced).fhirNext.step[0].component[0].text).toBe("Approximately one tablet as directed.");
  });

  it("executes offset-trimmed weekly R6 schedules on the authored weekdays, not distributed intervening days", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week,
        dayOfWeek: ["mon", "wed", "fri"],
        endOffset: { value: 2, unit: "d", code: "d" }
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const from = "2026-11-02T08:00:00+07:00";
    const options = { from, orderedAt: from, timeZone: "Asia/Bangkok", limit: 6 };
    const expected = [
      "2026-11-02T08:00:00+07:00",
      "2026-11-04T08:00:00+07:00",
      "2026-11-06T08:00:00+07:00",
      "2026-11-09T08:00:00+07:00",
      "2026-11-11T08:00:00+07:00",
      "2026-11-13T08:00:00+07:00"
    ];
    for (const value of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(value, options)).toEqual(expected);
      expect(calculateTotalUnits({
        dosage: value, ...options, durationValue: 14, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(6);
    }
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("preserves R6 text-only wire input through its usable R5 output", () => {
    // HL7 Snapshot 1 DosageInstruction.step is 0..*: an instruction is
    // meaningful even without a structured administration component.
    const input = { renderedInstruction: "Take as directed" };
    const result = fromFhir(input);
    expect(result.count).toBe(1);
    expect(result.fhir).toHaveLength(1);
    expect(result.fhir[0].text).toBe(input.renderedInstruction);
    expect(result.fhir[0].doseAndRate).toBeUndefined();
    expect(result.fhirNext.step).toBeUndefined();
    expect(result.fhirNext.renderedInstruction).toBe(input.renderedInstruction);
    expect(result.longText).toBe(input.renderedInstruction);
    expect(toDosageDetails(result.fhir)).toEqual(result.fhirNext);
    expect(result.warnings).toEqual([]);
  });

  it("round-trips valid zero-step R6 course-only metadata without inventing an active dose", () => {
    const source: FhirR6DosageInstruction = {
      id: "course-note", renderedInstruction: "Call clinic for dose",
      extension: [{ url: "https://example.org/unknown-course", valueBoolean: false }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg", comparator: "~" } }] }
    };
    const previews: [FhirR6DosageInstruction, string][] = [
      [source, "Current: Across this course: max per administration: ~5 mg; original directions: Call clinic for dose"],
      [{ renderedInstruction: source.renderedInstruction }, "Call clinic for dose"],
      [{ safety: source.safety }, "Across this course: max per administration: ~5 mg"]
    ];
    for (const [header, expected] of previews) for (const emptySteps of [false, true]) {
      const input: FhirR6DosageInstruction = emptySteps ? { ...header, step: [] } : header;
      const before = JSON.stringify(input);
      const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(input))) as FhirDosage[];
      for (const locale of ["en", "th"]) {
        const localized = locale === "th" ? expected.replace("Across this course:", "ตลอดแผนการใช้ยานี้:")
          .replace("Current:", "ปัจจุบัน:").replace("original directions:", "ข้อความเดิม:") : expected;
        const imported = fromFhir(input, { locale, realizationMode: "normalized" });
        expect(imported.longText).toBe(localized);
        expect(imported.items.map(item => item.longText)).toEqual([localized]);
        expect(formatParseBatch(imported, "long")).toBe(localized);
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" })).toBe(localized);
        expect(formatSig(cold, "long", { locale, realizationMode: "normalized" })).toBe(localized);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    const rows = toFhirR5Dosages(source);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(source.renderedInstruction);
    expect(rows[0].doseAndRate).toBeUndefined();
    expect(rows[0].timing).toBeUndefined();
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(source);
    // Ordinary R5 persistence adapters often write empty arrays for
    // absent fields. They must not turn a course-only metadata carrier
    // into a phantom administration stage.
    const normalized = [{
      ...rows[0], doseAndRate: [], additionalInstruction: [],
      sequence: undefined, timing: undefined, asNeeded: undefined,
      safety: undefined, maxDosePerAdministration: undefined
    }];
    expect(toDosageDetails(normalized)).toEqual(source);
    // Once the clinician adds a real dose, it is an actual new stage,
    // not an empty metadata carrier. The former R6 source stays retained.
    const withNewDose = [{
      ...normalized[0], doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }];
    const afterAddingDose = toDosageDetails(withNewDose);
    expect(afterAddingDose.step[0].component[0].doseAndRate?.[0].doseQuantity?.value)
      .toBe(1);
    expect(JSON.stringify(afterAddingDose.extension)).toContain("Call clinic for dose");
    const batch = fromFhir(source);
    expect(batch.fhir).toHaveLength(1);
    expect(toDosageDetails(batch.fhir)).toEqual(source);
    const edited = JSON.parse(JSON.stringify(rows));
    edited[0].text = "Corrected directions";
    const afterEdit = toDosageDetails(edited);
    expect(afterEdit.renderedInstruction).toBe("Corrected directions");
    expect(afterEdit.step).toBeUndefined();
    expect(afterEdit.safety).toEqual(source.safety);
    expect(JSON.stringify(afterEdit.extension)).toContain("Call clinic for dose");
    expect(toFhirR5Dosages({ step: [] })).toEqual([]);
  });

  it("retains the original concept-only site wrapper when an R5 site is corrected", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      site: {
        id: "source-left", concept: { text: "left eye" },
        extension: [{ url: "https://example.org/site-source", valueString: "original" }]
      },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }]
    }] }] };
    const rows = structuredClone(toFhirR5Dosages(source));
    rows[0].site = { text: "right eye" };
    const rebuilt = toDosageDetails(rows);
    expect(rebuilt.step[0].component[0].site?.concept?.text).toBe("right eye");
    const retained = rebuilt.extension?.filter(extension =>
      extension.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).toContain("source-left");
    expect(JSON.stringify(retained)).toContain("left eye");
    expect(JSON.stringify(retained)).toContain("site-source");
    expect(fromFhir(rebuilt).fhirNext.step[0].component[0].site?.concept?.text).toBe("right eye");
  });

  it("honors explicitly authored twice-daily clocks for 42 doses/21 days in R5 and offset R6", () => {
    const base = "2026-11-02T00:00:00+07:00";
    const options = { from: base, orderedAt: base, timeZone: "Asia/Bangkok", limit: 44 };
    const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const repeat = {
      frequency: 42, period: 21, periodUnit: FhirPeriodUnit.Day,
      timeOfDay: ["08:00:00", "20:00:00"]
    };
    const expectedFirst = [
      "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00",
      "2026-11-03T08:00:00+07:00", "2026-11-03T20:00:00+07:00"
    ];
    const standalone: EzDosage = { ...dose, timing: { repeat } };
    expect(nextDueDoses(standalone, options).slice(0, 4)).toEqual(expectedFirst);

    const offsetCourse: FhirR6DosageInstruction = { step: [{ component: [{
      ...dose, timing: { repeat: {
        ...repeat, period: 28, endOffset: { value: 7, unit: "d", code: "d" }
      } }
    }] }] };
    for (const value of [offsetCourse, toFhirR5Dosages(offsetCourse), fromFhir(offsetCourse)]) {
      const due = nextDueDoses(value, options);
      expect(due.slice(0, 4)).toEqual(expectedFirst);
      expect(due[40]).toBe("2026-11-22T08:00:00+07:00");
      expect(due[41]).toBe("2026-11-22T20:00:00+07:00");
      expect(due.slice(42, 44)).toEqual([
        "2026-11-30T08:00:00+07:00", "2026-11-30T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({
        dosage: value, ...options, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(42);
    }
  });

  it("keeps R6 active-window offsets when an R5 clinician adds a clock without changing the period", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, code: "d", unit: "d" },
        endOffset: { value: 5, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const rows = structuredClone(toFhirR5Dosages(course));
    rows[0].timing!.repeat!.timeOfDay = ["08:00:00"];
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component[0].timing?.repeat).toEqual({
      ...course.step[0].component[0].timing!.repeat,
      timeOfDay: ["08:00:00"]
    });
    expect(restored.extension?.some(value =>
      value.url.includes("medication-course-reconciliation-warning"))).not.toBe(true);
    // Editing the cadence itself is different: stale offsets must not
    // silently become executable under a new period.
    const changedRows = structuredClone(rows);
    changedRows[0].timing!.repeat!.period = 21;
    const changedPeriod = toDosageDetails(changedRows);
    expect(changedPeriod.step[0].component[0].timing?.repeat?.startOffset).toBeUndefined();
    expect(changedPeriod.extension?.some(value =>
      value.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("displays native R6 offset frequency and period maxima as ranges, not exact counts", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 21, frequencyMax: 42,
        period: 28, periodMax: 30, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 7, code: "d", unit: "d" } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const en = formatSig(course, "long", { locale: "en" });
    const th = formatSig(course, "long", { locale: "th" });
    expect(en).toContain("21–42 administrations per 28–30 days");
    expect(en).toContain("No doses during the final 7 days");
    expect(en).not.toContain("21 administrations per 28 days");
    expect(th).toContain("21–42 ครั้งต่อช่วง 28–30 วัน");
    expect(fromFhir(course, { locale: "en" }).items[0].longText).toContain("21–42");
    expect(toDosageDetails(toFhirR5Dosages(course))).toEqual(course);
  });

  it("keeps authored 08:00/20:00 wall clocks through New York fall DST and later calendar cycles", () => {
    const from = "2026-10-26T00:00:00-04:00";
    const options = { from, orderedAt: from, timeZone: "America/New_York", limit: 56 };
    const component: EzDosage = {
      timing: { repeat: {
        frequency: 42, period: 21, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00", "20:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const regular = nextDueDoses(component, options);
    expect(regular.slice(0, 2)).toEqual([
      "2026-10-26T08:00:00-04:00", "2026-10-26T20:00:00-04:00"
    ]);
    expect(regular.slice(12, 14)).toEqual([
      "2026-11-01T08:00:00-05:00", "2026-11-01T20:00:00-05:00"
    ]);
    expect(regular.slice(40, 44)).toEqual([
      "2026-11-15T08:00:00-05:00", "2026-11-15T20:00:00-05:00",
      "2026-11-16T08:00:00-05:00", "2026-11-16T20:00:00-05:00"
    ]);
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      ...component,
      timing: { repeat: { ...component.timing!.repeat!,
        period: 28, endOffset: { value: 7, unit: "d", code: "d" }
      } }
    }] }] };
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const due = nextDueDoses(input, options);
      expect(due.slice(12, 14)).toEqual([
        "2026-11-01T08:00:00-05:00", "2026-11-01T20:00:00-05:00"
      ]);
      expect(due.slice(40, 44)).toEqual([
        "2026-11-15T08:00:00-05:00", "2026-11-15T20:00:00-05:00",
        "2026-11-23T08:00:00-05:00", "2026-11-23T20:00:00-05:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
    }
  });

  it("keeps R6 day-cycle administration and supply after a New York spring-forward gap", () => {
    // The 28-day calendar boundary on Mar 14 2027 is a nonexistent 02:30.
    // A calendar course must not stop; later cycles retain their original
    // 02:30 anchor rather than drift to 03:30 indefinitely.
    const start = "2027-02-14T02:30:00-05:00";
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event",
        code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d",
        system: "http://unitsofmeasure.org" }
    });
    const course: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{
        start: relative(0), end: relative(1),
        component: [{
          timing: { repeat: { frequency: 1, period: 1,
            periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }]
      }]
    };
    const options = { from: start, orderedAt: start,
      timeZone: "America/New_York", limit: 4 };
    const expected = [
      "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-11T08:00:00-04:00",
      "2027-05-09T08:00:00-04:00"
    ];
    for (const input of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      expect(nextDueDoses(input, options)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 85, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
    }
    const earlyClock = JSON.parse(JSON.stringify(course)) as FhirR6DosageInstruction;
    const repeat = earlyClock.step![0].component[0].timing!.repeat!;
    repeat.frequency = 2;
    repeat.timeOfDay = ["03:15:00", "08:00:00"];
    // 03:15 is before March's gap-adjusted 03:30 origin, but after April's
    // restored 02:30 origin. Permanent anchor drift would lose April's dose.
    const expectedEarly = [
      "2027-02-14T03:15:00-05:00", "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-11T03:15:00-04:00", "2027-04-11T08:00:00-04:00",
      "2027-05-09T03:15:00-04:00", "2027-05-09T08:00:00-04:00"
    ];
    for (const input of [earlyClock, toFhirR5Dosages(earlyClock), fromFhir(earlyClock)]) {
      expect(nextDueDoses(input, { ...options, limit: expectedEarly.length })).toEqual(expectedEarly);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 85, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    }
  });

  it("keeps calendar cycles past midnight DST gaps and distinguishes elapsed q24h", () => {
    // Santiago advances from 00:00 straight to 01:00 on Sep 6, 2026.
    const anchor = "2026-08-09T00:00:00-04:00";
    const options = { from: anchor, orderedAt: anchor,
      timeZone: "America/Santiago", limit: 58 };
    const dosage: EzDosage = {
      timing: { repeat: { frequency: 28, period: 28,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const due = nextDueDoses(dosage, options);
    expect(due).toHaveLength(58);
    expect(due[27]).toBe("2026-09-05T08:00:00-04:00");
    expect(due[28]).toBe("2026-09-06T08:00:00-03:00");
    expect(due[56]).toBe("2026-10-04T08:00:00-03:00");

    // FHIR timeOfDay is a wall-clock instruction. By contrast, every 24
    // elapsed hours is an interval whose local time shifts after spring DST.
    const newYork = { from: "2026-03-07T08:00:00-05:00",
      orderedAt: "2026-03-07T08:00:00-05:00",
      timeZone: "America/New_York", limit: 3 };
    expect(nextDueDoses({
      timing: { repeat: { frequency: 1, period: 24,
        periodUnit: FhirPeriodUnit.Hour } }
    }, newYork)).toEqual([
      "2026-03-07T08:00:00-05:00",
      "2026-03-08T09:00:00-04:00",
      "2026-03-09T09:00:00-04:00"
    ]);
    expect(nextDueDoses({
      timing: { repeat: { frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00"] } }
    }, newYork)).toEqual([
      "2026-03-07T08:00:00-05:00",
      "2026-03-08T08:00:00-04:00",
      "2026-03-09T08:00:00-04:00"
    ]);
  });

  it("matches R6-only dose choices by distinct entry identity across removal and reordering", () => {
    for (const identity of ["id", "type"] as const) {
      const entry = (name: string, amount: number) => ({
        ...(identity === "id" ? { id: name } :
          { type: { coding: [{ code: name }] } }),
        doseQuantity: simpleQuantityForR5({ value: amount, unit: "mg", comparator: "~" as const })!
      });
      const course: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [entry("calc", 10), entry("ordered", 5)]
      }] }] };
      const rows = structuredClone(toFhirR5Dosages(course));
      rows[0].doseAndRate!.shift();
      const restored = toDosageDetails(rows);
      expect(restored.step[0].component[0].doseAndRate).toEqual([entry("ordered", 5)]);
      expect(restored.extension?.some(ext =>
        ext.url.includes("medication-course-reconciliation-source"))).toBe(true);
      const reordered = structuredClone(toFhirR5Dosages(course));
      reordered[0].doseAndRate!.reverse();
      reordered[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
      const edited = toDosageDetails(reordered);
      expect(edited.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(7);
      expect(edited.step[0].component[0].doseAndRate?.[1]).toEqual(entry("calc", 10));
    }
    // The R5 projection carries the numeric amount even without IDs/types.
    // Deletion therefore leaves the surviving 5 mg dose identifiable.
    const anonymous: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 10, unit: "mg", comparator: "~" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }
      ]
    }] }] };
    const anonymousRows = cloneStructuredValue(toFhirR5Dosages(anonymous));
    expect(anonymousRows[0].doseAndRate?.map(entry => entry.doseQuantity?.value))
      .toEqual([10, 5]);
    anonymousRows[0].doseAndRate!.shift();
    expect(anonymousRows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      value: 5, unit: "mg", extension: [{
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      }]
    });
    const surviving = toDosageDetails(anonymousRows);
    expect(surviving.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })!
    }]);
    const provenance = surviving.extension?.filter(ext =>
      ext.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(provenance).toHaveLength(1);
    expect(JSON.stringify(provenance[0])).toContain('"value":10');
    expect(JSON.stringify(provenance[0])).toContain('"value":5');
  });

  it("projects every qualified R6 dose/rate as an active R5 number and retains its qualifier", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 10, comparator: "~", unit: "mg",
          code: "mg", system: "http://unitsofmeasure.org" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, comparator: "<=", unit: "mg" })! },
        { rateQuantity: simpleQuantityForR5({ value: 4, comparator: ">=", unit: "mL/h" })! },
        { rateQuantity: simpleQuantityForR5({ value: 2.5, comparator: "~", unit: "mL/h" })! }
      ]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].doseAndRate?.map(entry =>
      entry.doseQuantity?.value ?? entry.rateQuantity?.value)).toEqual([10, 5, 4, 2.5]);
    expect(rows[0].doseAndRate?.map(entry =>
      (entry.doseQuantity ?? entry.rateQuantity)?.extension?.[0]?.valueCoding?.code))
      .toEqual(["100000000055", "100000000052",
        "100000000053", "100000000055"]);
    expect(rows[0].doseAndRate?.[0].doseQuantity).toMatchObject({
      code: "mg", system: "http://unitsofmeasure.org"
    });
    for (const entry of rows[0].doseAndRate ?? [])
      expect(JSON.stringify(entry)).not.toContain('"comparator":');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    const reordered = cloneStructuredValue(toFhirR5Dosages(course));
    reordered[0].doseAndRate!.reverse();
    expect(toDosageDetails(reordered).step[0].component[0].doseAndRate).toEqual(
      [...course.step[0].component[0].doseAndRate!].reverse()
    );
    const edited = cloneStructuredValue(toFhirR5Dosages(course));
    edited[0].doseAndRate![0].doseQuantity!.value = 11;
    expect(course.step[0].component[0].doseAndRate![0].doseQuantity!.value).toBe(10);
    const corrected = toDosageDetails(edited);
    expect(corrected.step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual(simpleQuantityForR5({ value: 11, unit: "mg", code: "mg",
        system: "http://unitsofmeasure.org", comparator: "~" })!);
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[1].doseQuantity))
      .toBe("<=");
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[2].rateQuantity))
      .toBe(">=");
    expect(getQuantityComparator(corrected.step[0].component[0].doseAndRate?.[3].rateQuantity))
      .toBe("~");
    expect(corrected.extension?.some(ext =>
      ext.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("keeps the active R5 dose even when equally valued anonymous R6 qualifiers are ambiguous", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! },
        { doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })! }
      ]
    }] }] };
    const rows = cloneStructuredValue(toFhirR5Dosages(original));
    expect(rows[0].doseAndRate?.map(entry => entry.doseQuantity?.value))
      .toEqual([5, 5]);
    rows[0].doseAndRate!.shift();
    const restored = toDosageDetails(rows);
    // The published EMA operator coding keeps even identically valued
    // anonymous entries distinguishable; no guessed qualifier is needed.
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })!
    }]);
    const provenance = restored.extension?.filter(ext =>
      ext.url.includes("medication-course-reconciliation-source")) ?? [];
    expect(provenance).toHaveLength(1);
    expect(JSON.stringify(provenance)).toContain('"100000000055"');
    expect(JSON.stringify(provenance)).toContain('"100000000053"');
  });

  it("replaces edited step modifiers without stacking old wrappers or deleting other extensions", () => {
    const wrapUrl = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const modifier = (key: string) => ({ url: "https://example.org/step/" + key, valueString: key });
    const retained: FhirR6DosageInstruction = { step: [{
      extension: [
        { url: wrapUrl, extension: [modifier("A")] },
        { url: "https://example.org/independent", valueString: "keep" }
      ],
      component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
    }] };
    const rows = toFhirR5Dosages(retained);
    const course = fromDosageDetails(retained).course;
    course.step![0].modifierExtension = [modifier("B")];
    const edited = toDosageDetails(rows, undefined, course);
    expect(edited.step[0].extension?.filter(ext => ext.url === wrapUrl)).toEqual([
      { url: wrapUrl, extension: [modifier("B")] }
    ]);
    expect(edited.step[0].extension).toContainEqual({
      url: "https://example.org/independent", valueString: "keep"
    });
    expect(fromDosageDetails(edited).course.step![0].modifierExtension).toEqual([modifier("B")]);
    const clearedCourse = structuredClone(course);
    clearedCourse.step![0].modifierExtension = [];
    const cleared = toDosageDetails(rows, undefined, clearedCourse);
    expect(cleared.step[0].extension?.some(ext => ext.url === wrapUrl)).toBe(false);
    expect(cleared.step[0].extension).toContainEqual({
      url: "https://example.org/independent", valueString: "keep"
    });
  });

  it("preserves R6 approximate Ratio numerators through valid R5, including independent edits", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{
        rateRatio: {
          numerator: { value: 100, comparator: "~", unit: "mL" },
          denominator: { value: 90, unit: "min" }
        }
      }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].doseAndRate?.[0].rateRatio?.numerator).toMatchObject({
      value: 100, unit: "mL", extension: [{
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008",
          code: "100000000055" }
      }]
    });
    expect(JSON.stringify(rows)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(rows)).toContain('"100000000055"');
    expect(JSON.stringify(rows)).not.toContain('"valueRatio"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(course);
    expect(fromFhir(course).items[0].longText).toContain("Rate: ~100 mL / 90 min");

    const changed = structuredClone(toFhirR5Dosages(course));
    changed[0].doseAndRate![0].rateRatio!.numerator!.value = 120;
    const numeric = toDosageDetails(changed);
    expect(numeric.step[0].component[0].doseAndRate?.[0].rateRatio?.numerator).toEqual({
      value: 120, unit: "mL", comparator: "~"
    });
    expect(numeric.extension?.some(ext =>
      ext.url.includes("medication-course-reconciliation-source"))).toBe(true);

    const replaced = cloneStructuredValue(toFhirR5Dosages(course));
    replaced[0].doseAndRate![0].rateExpression = { expression: "%patient.weight" };
    const expression = toDosageDetails(replaced);
    expect(expression.step[0].component[0].doseAndRate).toEqual([{
      rateExpression: { expression: "%patient.weight" }
    }]);
    expect(fromFhir(expression).fhirNext).toEqual(expression);
  });

  it("resolves offset active/rest treatment boundaries through a DST gap without changing doses", () => {
    const anchor = "2027-02-21T02:30:00-05:00";
    const opts = { from: anchor, orderedAt: anchor,
      timeZone: "America/New_York", limit: 22 };
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 7, unit: "d", code: "d" },
        timeOfDay: ["08:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    for (const value of [course, toFhirR5Dosages(course), fromFhir(course)]) {
      const times = nextDueDoses(value, opts);
      expect(times[0]).toBe("2027-02-21T08:00:00-05:00");
      expect(times[20]).toBe("2027-03-13T08:00:00-05:00");
      expect(times[21]).toBe("2027-03-21T08:00:00-04:00");
      expect(calculateTotalUnits({ dosage: value, ...opts,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("keeps monthly and yearly treatment boundaries on the original calendar clock after DST gaps", () => {
    const anchor = "2027-02-14T02:30:00-05:00";
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, code: "d", unit: "d" }
    });
    const component = {
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const month: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "mo", code: "mo" },
      step: [{ start: relative(0), end: relative(1), component: [component] }]
    };
    const options = { from: anchor, orderedAt: anchor,
      timeZone: "America/New_York", limit: 3 };
    expect(nextDueDoses(month, options)).toEqual([
      "2027-02-14T08:00:00-05:00",
      "2027-03-14T08:00:00-04:00",
      "2027-04-14T08:00:00-04:00"
    ]);
    expect(calculateTotalUnits({ dosage: month, ...options,
      durationValue: 90, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(4);
  });

  it("retains approximate R6 Duration quantities in step boundaries and safety without leaking R5", () => {
    const relative = {
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: 2, comparator: "~" as const, unit: "d" }
    };
    const course: FhirR6DosageInstruction = {
      safety: { doseLimit: [{
        scope: "period", period: { value: 2, comparator: "~", unit: "d" },
        valueInteger: 4
      }] },
      step: [{
        start: relative,
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }]
    };
    const projected = toFhirR5Dosages(course);
    expect(JSON.stringify(projected)).not.toContain('"comparator":"~"');
    expect(JSON.stringify(projected)).toContain('"100000000055"');
    expect(toDosageDetails(JSON.parse(JSON.stringify(projected)))).toEqual(course);
    expect(fromFhir(course).fhirNext).toEqual(course);
    expect(() => nextDueDoses(course, { from: "2027-02-21T08:00:00-05:00",
      orderedAt: "2027-02-21T08:00:00-05:00", timeZone: "America/New_York" }))
      .toThrow(/Unsupported R6 step RelativeTime/);
  });

  it("does not reattach a deleted R6 expression under the old complete-course source marker", () => {
    // Read-only historical marker path: preserve source, but align live entries
    // by their distinct FHIR type rather than stale array position.
    const rate = (type: string, expression: string) => ({
      url: "doseAndRate", extension: [
        { url: "type", valueCodeableConcept: { text: type } },
        { url: "doseExpression", valueExpression: { expression } }
      ]
    });
    const legacyMarker: FhirExtension = {
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{
        url: "step", extension: [{ url: "component", extension: [
          rate("calc", "%calc"), rate("ordered", "%ordered")
        ] }]
      }] }]
    };
    const oldRow: EzDosage = {
      sequence: 1,
      doseAndRate: [{ type: { text: "ordered" } }],
      modifierExtension: [legacyMarker]
    };
    const restored = toDosageDetails([oldRow]);
    expect(restored.step[0].component[0].doseAndRate).toEqual([{
      type: { text: "ordered" }, doseExpression: { expression: "%ordered" }
    }]);
    expect(restored.extension?.some(x =>
      x.url.includes("medication-course-reconciliation-source"))).toBe(true);
  });

  it("converts historical retained-course edited step modifiers for existing and new stages", () => {
    const wrap = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const modifier = (name: string) => ({
      url: "https://example.org/step/" + name, valueString: name
    });
    const stepFields: FhirExtension[] = [
      { url: "extension", extension: [{ url: wrap, extension: [modifier("old")] }] },
      { url: "component", extension: [{
        url: "doseAndRate", extension: [{
          url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" }
        }]
      }] }
    ];
    const marker: FhirExtension = {
      url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
      extension: [{ url: "dosageDetails", extension: [{
        url: "step", extension: stepFields
      }] }]
    };
    const original: EzDosage = {
      sequence: 1, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      modifierExtension: [marker]
    };
    for (const [rows, edit, expected] of [
      [[original], { sequence: 1, modifierExtension: [modifier("new")] }, 1],
      [[original], { sequence: 1, modifierExtension: [] }, 0],
      [[original, { ...original, sequence: 2 }],
        { sequence: 2, modifierExtension: [modifier("new")] }, 1]
    ] as const) {
      const details = toDosageDetails(rows, undefined, { step: [edit] });
      const target = details.step[edit.sequence - 1];
      expect(target.modifierExtension).toBeUndefined();
      expect(target.extension?.filter(ext => ext.url === wrap).length ?? 0).toBe(expected);
      if (expected) expect(target.extension).toContainEqual({
        url: wrap, extension: [modifier("new")]
      });
      expect(fromFhir(details).fhirNext).toEqual(details);
    }
  });

  it.each([
    ["~5 mg PO QD", "~", "100000000055"],
    ["≈5 mg PO QD", "~", "100000000055"],
    ["about 5 mg PO QD", "~", "100000000055"],
    ["approximately 5 mg PO QD", "~", "100000000055"],
    ["ประมาณ 5 เม็ด PO QD", "~", "100000000055"],
    ["≥5 mg PO QD", ">=", "100000000053"],
    [">=5mg PO QD", ">=", "100000000053"],
    ["at least 5 mg PO QD", ">=", "100000000053"],
    ["อย่างน้อย 5 mg PO QD", ">=", "100000000053"],
    ["≤5 mg PO QD", "<=", "100000000052"],
    ["no more than 5 mg PO QD", "<=", "100000000052"],
    ["ไม่เกิน 5 เม็ด PO QD", "<=", "100000000052"],
    ["<5 mg PO QD", "<", "100000000050"],
    ["less than 5 mg PO QD", "<", "100000000050"],
    [">5 mg PO QD", ">", "100000000051"],
    ["more than 5 mg PO QD", ">", "100000000051"]
  ] as const)("parses %s into matching R5 and R6 SimpleQuantity operators %s", (input, comparator, code) => {
    const parsed = parseSig(input);
    const quantity = parsed.fhir[0].doseAndRate?.[0].doseQuantity;
    expect(quantity?.value).toBe(5);
    expect(quantity?.comparator).toBeUndefined();
    expect(quantity?.extension?.[0]).toMatchObject({
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    });
    expect(getEmaQuantityComparator(quantity)).toBe(comparator);
    const r6Quantity = parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity;
    expect(r6Quantity).not.toHaveProperty("comparator");
    expect(r6Quantity?.extension?.[0]).toMatchObject({
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    });
    expect(getQuantityComparator(r6Quantity)).toBe(comparator);
    expect(parsed.shortText).toContain(comparator + "5");
    expect(fromFhirDosage(parsed.fhir[0]).shortText).toContain(comparator + "5");
    expect(getQuantityComparator(toDosageDetails(toFhirR5Dosages(parsed.fhirNext)).step[0]
      .component[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
  });

  it("imports independently authored EMA Quantity Operators while retaining unfamiliar ones verbatim", () => {
    const dose = (code: string) => ({
      value: 5, unit: "mg",
      extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
      }]
    });
    const exact = {
      doseAndRate: [{ doseQuantity: dose("100000000055") }]
    };
    const imported = toDosageDetails([exact]);
    expect(imported.step[0].component[0].doseAndRate?.[0].doseQuantity).toEqual(simpleQuantityForR5({
      value: 5, unit: "mg", comparator: "~"
    })!);
    expect(fromFhirDosage(exact).longText).toContain("approximately 5 mg");
    const preserved = toFhirR5Dosages(imported)[0].doseAndRate?.[0].doseQuantity;
    expect(preserved?.extension?.[0]).toEqual(dose("100000000055").extension[0]);
    expect(preserved?.value).toBe(5);

    // Equivalent, average, range and other EMA concepts are NOT "~".
    for (const code of ["100000000054", "100000000056", "200000024024", "unknown"]) {
      const quantity = dose(code);
      expect(getEmaQuantityComparator(quantity)).toBeUndefined();
      const source = { doseAndRate: [{ doseQuantity: quantity }] };
      const next = toDosageDetails([source]);
      expect(next.step[0].component[0].doseAndRate?.[0].doseQuantity).toEqual(quantity);
      expect(toFhirR5Dosages(next)[0].doseAndRate?.[0].doseQuantity).toEqual(quantity);
    }
    expect(parseSig("approximately 3 weeks").fhir[0].doseAndRate?.[0]?.doseQuantity)
      .toBeUndefined();
    expect(parseSig("1 tab PO BID").fhir[0].doseAndRate?.[0]?.doseQuantity?.extension)
      .toBeUndefined();
  });

  it("preserves old local bridge-comparator children while emitting only the standard EMA coding", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }]
    }] }] };
    const rows = structuredClone(toFhirR5Dosages(course));
    const component = rows[0].modifierExtension?.[0].extension?.find(child =>
      child.url === "component");
    const amount = component?.extension?.find(child => child.url === "doseAndRate")
      ?.extension?.find(child => child.url === "doseQuantity");
    expect(amount?.valueQuantity?.extension?.[0].valueCoding?.code).toBe("100000000055");
    if (!amount) throw new Error("Expected retained R6 quantity");
    amount.valueQuantity = undefined;
    amount.extension = [
      { url: "quantity", valueQuantity: { value: 5, unit: "mg" } },
      { url: "comparator", valueCode: "~" }
    ];
    // Inspect the legacy codec result directly: the live R5 quantity still
    // has its EMA operator and must not mask a broken retained-field decoder.
    const legacy = decodeR5RetainedFields(rows[0].modifierExtension![0]);
    expect(legacy.component?.doseAndRate?.[0].doseQuantity)
      .toMatchObject({ value: 5, unit: "mg", comparator: "~" });
    expect(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseQuantity)
      .toEqual(simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })!);
  });

  it("keeps standard EMA operators active in R5 maximum-dose and period quantities", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [
        { scope: "administration", valueQuantity: {
          value: 5, unit: "mg", comparator: "~"
        } },
        { scope: "lifetime", valueQuantity: {
          value: 50, unit: "mg", comparator: "<="
        } },
        { scope: "period", valueQuantity: {
          value: 15, unit: "mg", comparator: "~"
        }, period: { value: 2, unit: "d", comparator: ">=" } }
      ] }
    }] }] };
    const rows = toFhirR5Dosages(source);
    expect(rows[0].maxDosePerAdministration).toMatchObject({
      value: 5, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000055" }
      }]
    });
    expect(rows[0].maxDosePerLifetime).toMatchObject({
      value: 50, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000052" }
      }]
    });
    expect(rows[0].maxDosePerPeriod?.[0]).toMatchObject({
      numerator: { value: 15, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000055" }
      }] },
      denominator: { value: 2, extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { code: "100000000053" }
      }] }
    });
    expect(toDosageDetails(JSON.parse(JSON.stringify(rows)))).toEqual(source);
    const changed = cloneStructuredValue(toFhirR5Dosages(source));
    changed[0].maxDosePerAdministration!.value = 6;
    expect(toDosageDetails(changed).step[0].component[0].safety?.doseLimit)
      .toContainEqual(expect.objectContaining({
        scope: "administration",
        valueQuantity: expect.objectContaining({ value: 6, comparator: "~" })
      }));
  });

  it("retains R6 approximate boundsDuration as EMA-coded R5 Quantity and a nominal course bound", () => {
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["08:00:00"], boundsDuration: {
          value: 7, code: "d", unit: "d", comparator: "~"
        } } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    const rows = toFhirR5Dosages(course);
    expect(rows[0].timing?.repeat?.boundsDuration).toMatchObject({
      value: 7, code: "d", unit: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
      }]
    });
    expect(rows[0].timing?.repeat?.boundsDuration?.comparator).toBeUndefined();
    expect(toDosageDetails(rows)).toEqual(course);
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 10 };
    for (const input of [course, rows, fromFhir(course)]) {
      const doses = nextDueDoses(input, opts);
      expect(doses).toHaveLength(7);
      expect(doses[0]).toBe("2026-11-01T08:00:00+07:00");
      expect(doses[6]).toBe("2026-11-07T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage: input, ...opts, durationValue: 20, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(7);
    }
  });

  it("uses the numeric center of an approximate repeatCycle rather than silently deleting recurrence", () => {
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d" }
    });
    const original: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, code: "d", unit: "d", comparator: "~" },
      step: [{ start: relative(0), end: relative(21), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }]
      }] }]
    };
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 25 };
    const rows = toFhirR5Dosages(original);
    expect(toDosageDetails(rows)).toEqual(original);
    for (const input of [original, rows, fromFhir(original)]) {
      const due = nextDueDoses(input, opts);
      expect(due[20]).toBe("2026-11-21T08:00:00+07:00");
      expect(due[21]).toBe("2026-11-29T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage: input, ...opts, durationValue: 56, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(210);
    }
    // This is an authored nominal value, not a fabricated exact dosage.
    expect(original.repeatCycle?.comparator).toBe("~");
  });

  it("does not silently turn an indeterminate cycle inequality into a one-off course", () => {
    const relative = (days: number) => ({
      contextCode: { coding: [{
        system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
      }] },
      offsetDuration: { value: days, unit: "d", code: "d" }
    });
    const original: FhirR6DosageInstruction = {
      repeatCycle: { value: 28, code: "d", unit: "d", comparator: ">=" },
      step: [{ start: relative(0), end: relative(21), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", limit: 25 };
    for (const input of [original, toFhirR5Dosages(original)]) {
      expect(() => nextDueDoses(input, opts)).toThrow(/repeatCycle/);
      expect(() => calculateTotalUnits({
        dosage: input, ...opts, durationValue: 56, durationUnit: FhirPeriodUnit.Day
      })).toThrow(/repeatCycle/);
    }
    expect(toDosageDetails(toFhirR5Dosages(original))).toEqual(original);
  });

  it("continues calculating nominal supply from approximate doses without rejecting or erasing amounts", () => {
    const parsed = parseSig("approximately 5 mg PO QD");
    const opts = { from: "2026-11-01T00:00:00+07:00",
      orderedAt: "2026-11-01T00:00:00+07:00",
      timeZone: "Asia/Bangkok", durationValue: 7,
      durationUnit: FhirPeriodUnit.Day };
    for (const input of [parsed, parsed.fhir, parsed.fhirNext]) {
      const result = calculateTotalUnits({ dosage: input, ...opts });
      expect(result.totalUnits).toBe(35);
      expect(result.unit).toBe("mg");
    }
    expect(getQuantityComparator(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity))
      .toBe("~");
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity?.extension?.[0].valueCoding?.code)
      .toBe("100000000055");
  });

  it("preserves an EMA-qualified infusion dose while canonicalizing its clinical rate structure", () => {
    const approximate = {
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055" }
    };
    const source: FhirDosage = { doseAndRate: [{
      doseQuantity: { value: 500, unit: "mL", extension: [approximate] },
      rateRatio: {
        numerator: { value: 500, unit: "mL" },
        denominator: { value: 2, unit: "h" }
      }
    }] };
    const canonical = canonicalFromFhir(source);
    expect(canonical.dose?.comparator).toBe("~");
    const rebuilt = canonicalToFhir(canonical);
    expect(rebuilt.doseAndRate?.[0]?.doseQuantity?.value).toBe(500);
    expect(getEmaQuantityComparator(rebuilt.doseAndRate?.[0]?.doseQuantity)).toBe("~");
    expect(rebuilt.doseAndRate?.[0]?.rateRatio?.numerator?.value).toBe(500);
    expect(rebuilt.doseAndRate?.[0]?.rateRatio?.denominator?.value).toBe(2);
    expect(canonicalToFhir(canonicalFromFhir({
      ...source, doseAndRate: [{ ...source.doseAndRate![0],
        doseQuantity: { value: 500, unit: "mL" } }]
    })).doseAndRate?.[0]?.doseQuantity?.extension).toBeUndefined();
  });

  it("preserves period-maximum numerator and denominator operators through canonical FHIR conversion", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const source: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "mg" } }],
      maxDosePerPeriod: [{
        numerator: { value: 15, unit: "mg", extension: coding("100000000055") },
        denominator: { value: 1, unit: "d", extension: coding("100000000053") }
      }]
    };
    const canonical = canonicalFromFhir(source);
    expect(canonical.schedule?.maxDosePerPeriod).toEqual([{
      amount: 15, unit: "mg", amountComparator: "~",
      period: 1, periodUnit: FhirPeriodUnit.Day, periodComparator: ">="
    }]);
    const rebuilt = canonicalToFhir(canonical);
    const limit = rebuilt.maxDosePerPeriod?.[0];
    expect(limit?.numerator?.value).toBe(15);
    expect(limit?.denominator?.value).toBe(1);
    expect(getEmaQuantityComparator(limit?.numerator)).toBe("~");
    expect(getEmaQuantityComparator(limit?.denominator)).toBe(">=");
  });

  it("inherits an approximate taper dose without turning it exact and clears it on explicit replacement", () => {
    const inherited = parseSig("approximately 5 mg PO BID then QD");
    expect(inherited.fhir).toHaveLength(2);
    for (const dose of inherited.fhir) {
      expect(dose.doseAndRate?.[0]?.doseQuantity?.value).toBe(5);
      expect(getEmaQuantityComparator(dose.doseAndRate?.[0]?.doseQuantity)).toBe("~");
    }
    for (const step of inherited.fhirNext.step) {
      expect(getQuantityComparator(step.component[0].doseAndRate?.[0]?.doseQuantity)).toBe("~");
    }
    const changed = parseSig("approximately 5 mg PO BID then 5 mg PO QD");
    expect(getQuantityComparator(changed.fhirNext.step[0].component[0].doseAndRate?.[0]?.doseQuantity)).toBe("~");
    const replacement = changed.fhirNext.step[1].component[0].doseAndRate?.[0]?.doseQuantity;
    expect(replacement).toMatchObject({ value: 5, unit: "mg" });
    expect(getQuantityComparator(replacement)).toBeUndefined();
    const three = parseSig("5 mg PO BID then approximately 7 mg PO QD then QD");
    expect(three.fhirNext.step.map(step =>
      getQuantityComparator(step.component[0].doseAndRate?.[0]?.doseQuantity))).toEqual([undefined, "~", "~"]);
  });

  it("displays EMA maximum operators, Thai comparators, and per-target doses without claiming exactness", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const source: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 5, unit: "drop",
        extension: coding("100000000055") } }],
      site: { text: "right eye" },
      maxDosePerAdministration: {
        value: 10, unit: "mg", extension: coding("100000000052")
      },
      maxDosePerPeriod: [{
        numerator: { value: 15, unit: "mg", extension: coding("100000000055") },
        denominator: { value: 1, unit: "d", extension: coding("100000000053") }
      }]
    };
    const en = fromFhirDosage(source, { locale: "en" });
    expect(en.longText).toContain("max per administration: <=10 mg");
    expect(en.longText).toContain("max per period: ~15 mg / >=1 d");
    const thai = fromFhirDosage(source, { locale: "th" });
    expect(thai.shortText).toContain("ประมาณ 5 หยด");
    expect(thai.longText).toContain("ประมาณ 5 หยด");
    expect(thai.longText).toContain("max per period: ~15 mg / >=1 d");
    const perNostril = fromFhirDosage({
      doseAndRate: [{ doseQuantity: {
        value: 5, unit: "spray", extension: coding("100000000055")
      } }], site: { text: "each nostril" }
    }, { locale: "th" });
    expect(perNostril.longText).toContain("ประมาณ 5 ครั้ง");
    expect(perNostril.longText).toContain("รูจมูกข้างละ");
    for (const [code, phrase] of [
      ["100000000053", "อย่างน้อย 5 หยด"],
      ["100000000052", "ไม่เกิน 5 หยด"],
      ["100000000050", "น้อยกว่า 5 หยด"],
      ["100000000051", "มากกว่า 5 หยด"]
    ] as const) {
      const dosage = { doseAndRate: [{ doseQuantity: {
        value: 5, unit: "drop", extension: coding(code)
      } }], site: { text: "right eye" } };
      expect(fromFhirDosage(dosage, { locale: "th" }).longText).toContain(phrase);
    }
    const native: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, unit: "tab", comparator: "~" })! }]
    }] }] };
    expect(fromFhir(native).items[0].longText).toContain("approximately 1 tablet");
  });

  it("keeps weekday-filtered weekly supply aligned to dates and R6 period offsets effective", () => {
    const anchor = "2026-11-02T00:00:00+07:00";
    const options = { from: anchor, orderedAt: anchor, timeZone: "Asia/Bangkok",
      limit: 16 };
    const weekday = { timing: { repeat: {
      frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Week,
      dayOfWeek: ["mon", "tue", "thu"] as const,
      timeOfDay: ["08:00:00"]
    } }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const weekly = weekday as FhirDosage;
    const expected = [
      "2026-11-02T08:00:00+07:00",
      "2026-11-03T08:00:00+07:00",
      "2026-11-05T08:00:00+07:00"
    ];
    expect(nextDueDoses(weekly, { ...options, limit: 3 })).toEqual(expected);
    for (const days of [2, 4, 7]) {
      expect(calculateTotalUnits({ dosage: weekly, ...options,
        durationValue: days, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(days === 2 ? 2 : 3);
    }
    const offset: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
        startOffset: { value: 2, unit: "d", code: "d" },
        endOffset: { value: 5, unit: "d", code: "d" },
        timeOfDay: ["08:00:00"]
      } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    }] }] };
    for (const input of [offset, toFhirR5Dosages(offset)]) {
      const due = nextDueDoses(input, options);
      expect(due[0]).toBe("2026-11-04T08:00:00+07:00");
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ dosage: input, ...options,
        durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
  });

  it("keeps zero-step course metadata edits active and retains their original source", () => {
    const old: FhirR6DosageInstruction = {
      id: "original", renderedInstruction: "Call for directions",
      extension: [{ url: "https://example.org/old-note", valueString: "retain" }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 5, unit: "mg" } }] }
    };
    const r5 = toFhirR5Dosages(old);
    const edited = toDosageDetails(r5, undefined, {
      id: "corrected",
      extension: [{ url: "https://example.org/new-note", valueString: "current" }],
      safety: { doseLimit: [{ scope: "administration",
        valueQuantity: { value: 8, unit: "mg" } }] }
    });
    expect(edited.step).toBeUndefined();
    expect(edited.id).toBe("corrected");
    expect(edited.safety?.doseLimit?.[0].valueQuantity?.value).toBe(8);
    expect(edited.extension).toContainEqual({
      url: "https://example.org/new-note", valueString: "current"
    });
    const source = JSON.stringify(edited.extension?.filter(item =>
      item.url.includes("reconciliation-source")));
    expect(source).toContain("old-note");
    expect(source).toContain('"value":5');
    expect(toDosageDetails(toFhirR5Dosages(edited)).safety).toEqual(edited.safety);
    expect(toDosageDetails(r5)).toEqual(old);
    const cleared = toDosageDetails(r5, undefined, { extension: [] });
    expect(cleared.extension?.some(item => item.url === "https://example.org/old-note"))
      .toBe(false);
    expect(JSON.stringify(cleared.extension)).toContain("old-note");
  });

  it("retains an unfamiliar original R6 condition after an R5 predicate replacement", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      condition: [{
        code: { text: "Pressure", extension: [{
          url: "https://example.org/code-detail", valueString: "original-coding"
        }] },
        operation: "gt", valueQuantity: { value: 160 }, text: "above 160",
        extension: [{ url: "https://example.org/condition-detail",
          valueString: "original-condition" }]
      }]
    }] }] };
    const row = structuredClone(toFhirR5Dosages(original)[0]);
    setDosageCondition(row, {
      kind: "measurement", name: "Pressure", operation: "lt",
      value: 120, text: "below 120"
    });
    const restored = toDosageDetails([row]);
    expect(restored.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "lt", valueQuantity: { value: 120 }
    });
    expect(JSON.stringify(restored.step[0].component[0].condition))
      .not.toContain("original-condition");
    const source = JSON.stringify(restored.extension?.filter(item =>
      item.url.includes("reconciliation-source")));
    expect(source).toContain("original-condition");
    expect(source).toContain("original-coding");
    expect(JSON.stringify(toDosageDetails(toFhirR5Dosages(restored)).extension))
      .toContain("original-condition");
  });

  it("preserves edited EMA scalar coding and reconciles native general-Quantity operators without duplicates", () => {
    const prior = {
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, id: "rich-ema",
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM,
        code: "100000000055", display: "approximately equal to",
        userSelected: true }
    };
    const course: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: simpleQuantityForR5({
        value: 5, unit: "mg", comparator: "~",
        extension: [prior, { url: "https://example.org/measurement", valueBoolean: false }]
      })! }]
    }] }] };
    const original = toFhirR5Dosages(course);
    expect(getEmaQuantityComparator(original[0].doseAndRate?.[0].doseQuantity)).toBe("~");
    // An external editor supplies the current legal SimpleQuantity coding.
    // The import/projection boundary owns preservation, not the editing UI.
    const editedCourse: FhirR6DosageInstruction = JSON.parse(JSON.stringify(course));
    editedCourse.step[0].component[0].doseAndRate![0].doseQuantity = {
      value: 5, unit: "mg", extension: [{
        ...prior, valueCoding: { ...prior.valueCoding, code: "100000000052",
          display: "less than or equal to" }
      }, { url: "https://example.org/measurement", valueBoolean: false }]
    };
    const rows = toFhirR5Dosages(editedCourse);
    const quantity = rows[0].doseAndRate?.[0].doseQuantity;
    const comparatorExtensions = quantity?.extension?.filter(item =>
      item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL);
    expect(comparatorExtensions).toHaveLength(1);
    expect(comparatorExtensions?.[0]).toEqual({
      ...prior,
      valueCoding: { ...prior.valueCoding, code: "100000000052",
        display: "less than or equal to" }
    });
    expect(quantity?.extension).toContainEqual({
      url: "https://example.org/measurement", valueBoolean: false
    });
    expect(getEmaQuantityComparator(quantity)).toBe("<=");
    expect(getQuantityComparator(toDosageDetails(rows).step[0].component[0].doseAndRate?.[0].doseQuantity))
      .toBe("<=");
    expect(getEmaQuantityComparator(toFhirR5Dosages(
      toDosageDetails(rows))[0].doseAndRate?.[0].doseQuantity)).toBe("<=");
    // The same Quantity adapter must reconcile enriched comparators inside
    // a Ratio numerator and Timing.boundsDuration, not just doseQuantity.
    const nested: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsDuration: { value: 7, unit: "d", code: "d",
          comparator: "<=", extension: [prior] }
      } },
      doseAndRate: [{ rateRatio: {
        numerator: { value: 100, unit: "mL", comparator: ">=",
          extension: [prior] },
        denominator: { value: 2, unit: "h" }
      } }]
    }] }] };
    const nestedR5 = toFhirR5Dosages(nested);
    const numerator = nestedR5[0].doseAndRate?.[0].rateRatio?.numerator;
    const bounds = nestedR5[0].timing?.repeat?.boundsDuration;
    expect(numerator?.comparator).toBe(">=");
    expect(getEmaQuantityComparator(numerator)).toBeUndefined();
    expect(numerator?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [prior],
    });
    expect(bounds?.comparator).toBe("<=");
    expect(getEmaQuantityComparator(bounds)).toBeUndefined();
    expect(bounds?.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", extension: [prior],
    });
    expect(toDosageDetails(nestedR5).step[0].component[0].doseAndRate?.[0]
      .rateRatio?.numerator?.comparator).toBe(">=");
  });

  it("renders exact R6 rate quantities and ratios in both course and item previews", () => {
    const one = (entry: NonNullable<FhirR6Dosage["doseAndRate"]>[number]) =>
      ({ step: [{ component: [{ doseAndRate: [entry] }] }] }) as FhirR6DosageInstruction;
    const exactRate = one({ rateQuantity: { value: 100, unit: "mL/h" } });
    const mixed = one({ doseQuantity: simpleQuantityForR5({ value: 500, unit: "mL", comparator: "~" })!,
      rateQuantity: { value: 100, unit: "mL/h" } });
    const ratio = one({ rateRatio: {
      numerator: { value: 500, unit: "mL" },
      denominator: { value: 2, unit: "h" }
    } });
    for (const [course, text] of [
      [exactRate, "Rate: 100 mL/h"],
      [mixed, "Rate: 100 mL/h"],
      [ratio, "Rate: 500 mL / 2 h"]
    ] as const) {
      expect(formatSig(course, "long", { locale: "en" })).toContain(text);
      expect(fromFhir(course).items[0].longText).toContain(text);
    }
    expect(formatSig(mixed, "long", { locale: "en" })).toContain("approximately 500 mL");
    expect(formatSig(mixed, "long", { locale: "en" })).not.toContain("undefined");
  });

  it("counts all explicit clocks on both sides of a non-midnight calendar cycle boundary", () => {
    const dosage: EzDosage = {
      timing: { repeat: { frequency: 42, period: 21,
        periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const clockConfig = { byFrequency: {
      "freq:42/per:21d": ["08:00", "20:00"]
    } };
    for (const [anchor, countFirst] of [
      ["2026-11-02T14:00:00Z", 42],
      ["2026-11-02T00:00:00Z", 42]
    ] as const) {
      const opts = { from: anchor, orderedAt: anchor,
        timeZone: "UTC", limit: 100,
        frequencyDefaults: clockConfig };
      const due = nextDueDoses(dosage, opts);
      const cycleEnd = Date.parse(anchor) + 21 * 86_400_000;
      expect(due.filter(value => Date.parse(value) < cycleEnd)).toHaveLength(countFirst);
      expect(calculateTotalUnits({ dosage, ...opts,
        durationValue: 21, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(42);
      const shifted = nextDueDoses(dosage, {
        ...opts, from: "2026-11-23T00:00:00Z", limit: 3
      });
      expect(shifted).toContain("2026-11-23T08:00:00+00:00");
      expect(shifted).toContain("2026-11-23T20:00:00+00:00");
    }
  });

  it("keeps native step extensions and modifiers independently editable in retained R5 stages", () => {
    const wrap = "urn:ezmedicationinput:StructureDefinition:r5-step-modifier-extensions";
    const native = { url: "https://example.org/native-step", valueString: "native" };
    const oldModifier = { url: "https://example.org/old-modifier", valueString: "old" };
    const replacement = { url: "https://example.org/new-modifier", valueString: "new" };
    for (const hasModifier of [false, true]) {
      const originalExtensions: FhirExtension[] = [native, ...(hasModifier
        ? [{ url: wrap, extension: [oldModifier] }] : [])];
      const original: FhirR6DosageInstruction = { step: [{
        id: "original-step", extension: originalExtensions,
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }] };
      // Historical storage uses one typed child per retained extension.
      const marker: FhirExtension = {
        url: "urn:ezmedicationinput:StructureDefinition:medication-r6-course-details",
        extension: [{ url: "dosageDetails", extension: [{ url: "step", extension: [
          { url: "id", valueString: "original-step" },
          ...originalExtensions.map(extension => ({ url: "extension", extension: [extension] })),
          { url: "component", extension: [{ url: "doseAndRate", extension: [{
            url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" }
          }] }] }
        ] }] }]
      };
      const historical: EzDosage[] = [{ sequence: 1,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], modifierExtension: [marker] }];
      expect(toDosageDetails(historical)).toEqual(original);
      for (const inputRows of [historical, toFhirR5Dosages(original)])
      for (const [edit, keepNative, expectedModifier] of [
        [{ sequence: 1, id: "edited-step" }, true, hasModifier ? oldModifier : undefined],
        [{ sequence: 1, extension: [] }, false, hasModifier ? oldModifier : undefined],
        [{ sequence: 1, modifierExtension: [replacement] }, true, replacement],
        [{ sequence: 1, modifierExtension: [] }, true, undefined],
        [{ sequence: 1, extension: [], modifierExtension: [] }, false, undefined]
      ] as const) {
        const edited = toDosageDetails(inputRows, undefined, { step: [edit] });
        const extensions = edited.step[0].extension ?? [];
        expect(extensions.some(value => value.url === native.url)).toBe(keepNative);
        expect(extensions.find(value => value.url === wrap)?.extension)
          .toEqual(expectedModifier ? [expectedModifier] : undefined);
        expect(edited.step[0].id).toBe("id" in edit ? edit.id : "original-step");
        // Clearing an already absent modifier is a no-op, not a reason
        // to create history. Actual edits retain the original source.
        if (hasModifier || "id" in edit || "extension" in edit || expectedModifier)
          expect(JSON.stringify(edited.extension)).toContain("native-step");
        const reopened = toDosageDetails(toFhirR5Dosages(edited));
        expect(reopened.step[0].extension ?? []).toEqual(extensions);
        expect(fromFhir(edited).fhirNext.step[0]).toEqual(edited.step[0]);
      }
    }
  });

  it("does not make independently qualified carrier rates inherit an equal-valued drug dose", () => {
    const operators = [undefined, "~", "<", "<=", ">", ">=", "ad"] as const;
    for (const doseComparator of operators) for (const rateComparator of operators) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{
        doseQuantity: simpleQuantityForR5({ value: 500, unit: "mL", ...(doseComparator ? { comparator: doseComparator } : {}) })!,
        rateRatio: { numerator: { value: 500, unit: "mL",
          ...(rateComparator ? { comparator: rateComparator } : {}) },
          denominator: { value: 2, unit: "h" } }
      }] }] }] };
      const row = toFhirR5Dosages(source)[0];
      const rebuilt = canonicalToFhir(canonicalFromFhir(row));
      const back = toDosageDetails([rebuilt]).step[0].component[0].doseAndRate![0];
      expect(back.doseQuantity).toMatchObject({ value: 500, unit: "mL" });
      expect(getQuantityComparator(back.doseQuantity)).toBe(doseComparator);
      expect(back.rateRatio?.numerator).toMatchObject({ value: 500, unit: "mL" });
      expect(back.rateRatio?.numerator?.comparator).toBe(rateComparator);
      expect(back.rateRatio?.denominator?.value).toBe(2);
    }
    // Equal labels do not make independently authored unit coding identical.
    const coded: FhirDosage = { doseAndRate: [{
      doseQuantity: { value: 500, unit: "mL", code: "mL", system: "urn:example:active" },
      rateRatio: { numerator: { value: 500, unit: "mL", code: "mL", system: "urn:example:carrier" },
        denominator: { value: 2, unit: "h" } }
    }] };
    const rebuilt = canonicalToFhir(canonicalFromFhir(coded));
    expect(rebuilt.doseAndRate?.[0].doseQuantity?.system).toBe("urn:example:active");
    expect(rebuilt.doseAndRate?.[0].rateRatio?.numerator?.system).toBe("urn:example:carrier");
  });

  it("shows EMA-only and native-edited R6 rate operators in both item and course previews", () => {
    const codes = [["~", "100000000055"], [">=", "100000000053"],
      ["<=", "100000000052"], [">", "100000000051"], ["<", "100000000050"]] as const;
    const qualifier = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    for (const [operator, code] of codes) for (const native of [false, true]) {
      const expectedOperator = native ? "<" : operator;
      const amount = { value: 100, unit: "mL/h", extension: qualifier(code),
        ...(native ? { comparator: "<" as const } : {}) };
      for (const [rate, expected] of [
        // A scalar rate is SimpleQuantity in R6: keep its qualifier in EMA.
        [{ rateQuantity: { value: 100, unit: "mL/h", extension: qualifier(code) } }, `${operator}100 mL/h`],
        [{ rateRatio: { numerator: { ...amount, unit: "mL" },
          denominator: { value: 2, unit: "h", extension: qualifier("100000000053") } } },
          `${expectedOperator}100 mL / >=2 h`]
      ] as const) {
        const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [rate] }] }] };
        for (const locale of ["en", "th"]) {
          expect(formatSig(source, "long", { locale })).toContain(expected);
          expect(fromFhir(source, { locale }).items[0].longText).toContain(expected);
        }
        expect(fromFhir(source).fhirNext).toEqual(source);
      }
    }
  });

  it.each([
    ["Take at most one tablet at bedtime", 1, "tab", "<=", "doseQuantity"],
    ["Take at least two tablets daily", 2, "tab", ">=", "doseQuantity"],
    ["Take approximately half a tablet daily", 0.5, "tab", "~", "doseQuantity"],
    ["Take no more than a quarter tablet daily", 0.25, "tab", "<=", "doseQuantity"],
    ["Infuse at least two mL/hr", 2, "mL/h", ">=", "rateQuantity"],
    ["approximately two mg/kg/day in two divided doses", 1, "mg/kg", "~", "doseQuantity"],
    ["Dissolve at most two tablets in water", 2, "tab", "<=", "doseQuantity"],
    ["squeeze at most one cm ribbon cream onto each spot", 1, "cm ribbon", "<=", "doseQuantity"]
  ] as const)("retains number-word quantity scope for %s", (input, value, unit, comparator, slot) => {
    const parsed = parseSig(input);
    const restored = toDosageDetails(JSON.parse(JSON.stringify(parsed.fhir)));
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0],
      restored.step[0].component[0]]) {
      expect(row.doseAndRate?.[0][slot]).toMatchObject({ value, unit });
      expect(getQuantityComparator(row.doseAndRate?.[0][slot])).toBe(comparator);
    }
    expect(parsed.input).toBe(input);
  });

  it("does not turn comparative durations or unknown nouns into number-word doses", () => {
    for (const input of ["approximately one week", "at most one symptom"]) {
      const parsed = parseSig(input);
      expect(parsed.fhir[0]?.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
      expect(parsed.input).toBe(input);
    }
    const ordinary = parseSig("Take one tablet daily").fhir[0].doseAndRate?.[0].doseQuantity;
    expect(ordinary?.value).toBe(1);
    expect(getQuantityComparator(ordinary)).toBeUndefined();
  });

  it("shows source-less dose and rate expressions in individual R6 items without evaluating them", () => {
    for (const choice of ["doseExpression", "rateExpression"] as const) {
      for (const expression of [
        { expression: "%patient.weight * 2", language: "text/fhirpath" },
        { reference: "Library/dosage-rule", description: "Weight-based dose" },
        { description: "Use the authored dosing formula" }
      ]) {
        const source: FhirR6DosageInstruction = {
          renderedInstruction: "Follow the written plan", step: [{ component: [{
            doseAndRate: [{ [choice]: expression }]
          }] }]
        };
        const expected = expression.expression ?? expression.reference ?? expression.description!;
        const imported = fromFhir(source);
        expect(imported.longText).toContain(expected);
        expect(imported.longText).toContain("unevaluated");
        expect(imported.fhirNext.renderedInstruction).toBe(source.renderedInstruction);
        expect(imported.items[0].shortText).toContain(expected);
        expect(imported.items[0].longText).toContain(expected);
        expect(imported.items[0].longText).toContain("unevaluated");
        expect(imported.fhir[0].doseAndRate?.[0].doseQuantity).toBeUndefined();
        expect(imported.fhir[0].doseAndRate?.[0].rateQuantity).toBeUndefined();
        expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
        const editedSource: FhirR6DosageInstruction = JSON.parse(JSON.stringify(source));
        editedSource.step[0].component[0].text = "Clinician's own component wording";
        expect(fromFhir(editedSource).items[0].longText).toContain(expected);
        expect(fromFhir(editedSource).fhirNext.step[0].component[0].text).toBe("Clinician's own component wording");
      }
    }
  });

  it("aligns integer day/week component caps with repeated calendar cycles across both DST transitions", () => {
    const dose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    for (const bounds of [
      { boundsDuration: { value: 28, unit: "d", code: "d" } },
      { boundsDuration: { value: 4, unit: "wk", code: "wk" } },
      { boundsRange: { low: { value: 21, unit: "d", code: "d" },
        high: { value: 28, unit: "d", code: "d" } } }
    ]) for (const scenario of [
      { anchor: "2027-02-15T00:00:00-05:00", from: "2027-03-15T00:00:00-04:00",
        clock: "00:30:00", expected: "2027-03-15T00:30:00-04:00" },
      { anchor: "2026-10-05T00:00:00-04:00", from: "2026-11-01T12:00:00-05:00",
        clock: "23:30:00", expected: "2026-11-01T23:30:00-05:00" }
    ]) {
      const source: FhirR6DosageInstruction = {
        repeatCycle: { value: 28, code: "d", unit: "d" },
        step: [{ component: [{ ...dose, timing: { repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: [scenario.clock], ...bounds
        } } }] }]
      };
      const options = { from: scenario.from, orderedAt: scenario.anchor,
        timeZone: "America/New_York", limit: 35 };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const due = nextDueDoses(input, options);
        expect(due[0]).toBe(scenario.expected);
        expect(new Set(due).size).toBe(due.length);
        expect(calculateTotalUnits({ dosage: input, ...options,
          durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  });

  it("keeps fractional duration caps and hourly intervals elapsed rather than calendar stepped", () => {
    const anchor = "2027-03-14T00:00:00-05:00";
    for (const quantity of [{ value: 1.5, code: "d" }, { value: 36, code: "h" }]) {
      const dosage: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["12:30:00"], boundsDuration: quantity } }
      };
      // 36 elapsed hours after spring-transition midnight ends at 13:00.
      const options = { orderedAt: anchor, from: "2027-03-15T12:00:00-04:00",
        timeZone: "America/New_York", limit: 3 };
      expect(nextDueDoses(dosage, options)).toEqual(["2027-03-15T12:30:00-04:00"]);
      expect(calculateTotalUnits({ dosage, ...options,
        durationValue: 2, durationUnit: FhirPeriodUnit.Hour }).totalUnits).toBe(1);
    }
    expect(nextDueDoses({ timing: { repeat: {
      frequency: 1, period: 24, periodUnit: FhirPeriodUnit.Hour
    } } }, { from: "2027-03-13T08:00:00-05:00", orderedAt: "2027-03-13T08:00:00-05:00",
      timeZone: "America/New_York", limit: 3 })).toEqual([
        "2027-03-13T08:00:00-05:00", "2027-03-14T09:00:00-04:00", "2027-03-15T09:00:00-04:00"
      ]);
  });

  it("retains EMA time operators without displaying exact course gaps or losing the known duration", () => {
    const coding = (code: string) => [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } }];
    const relative = (value: number) => ({ contextCode: { coding: [{
      system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start"
    }] }, offsetDuration: { value, unit: "d", code: "d" } });
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 7, unit: "d", code: "d", extension: coding("100000000053") },
      step: [{ end: relative(3), component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
      }] }]
    };
    for (const input of [source, toDosageDetails(toFhirR5Dosages(source))]) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain(">=7 days");
      expect(text).not.toContain("No doses from 3 days after each cycle start until 7 days after each cycle start");
      expect(text).not.toContain("every 7 days");
    }
    const editedStart: FhirR6DosageInstruction = JSON.parse(JSON.stringify(source));
    editedStart.step[0].start = { ...relative(2), offsetDuration: {
      ...relative(2).offsetDuration, extension: coding("100000000055")
    } };
    const text = formatSig(editedStart, "long", { locale: "en" });
    expect(text).toContain("~2 days after each cycle start");
    expect(text).not.toContain("From 2 days after each cycle start until 3 days after each cycle start");
    expect(text).not.toContain("No doses");
    expect(formatSig(editedStart, "long", { locale: "th" })).toContain("~2 วัน");
    expect(fromFhir(editedStart).fhirNext).toEqual(editedStart);
    // The current native edit wins over retained EMA metadata; a nominal
    // approximate repeat remains executable, just as a native ~ quantity.
    const editedRepeat: FhirR6DosageInstruction = JSON.parse(JSON.stringify(editedStart));
    editedRepeat.step[0].start = relative(0);
    editedRepeat.repeatCycle!.comparator = "~";
    expect(formatSig(editedRepeat, "long", { locale: "en" })).toContain("~7 days");
    const opts = { from: "2026-11-02T00:00:00+07:00",
      orderedAt: "2026-11-02T00:00:00+07:00", timeZone: "Asia/Bangkok",
      durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    expect(calculateTotalUnits({ dosage: editedRepeat, ...opts }).totalUnits).toBe(6);
    expect(calculateTotalUnits({ dosage: toFhirR5Dosages(editedRepeat), ...opts }).totalUnits).toBe(6);
  });

  it("shows known phase repeats with qualified, unknown-unit and exact course intervals", () => {
    const ema = (code: string) => [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code } }];
    for (const cycle of [
      { value: 28, unit: "d", code: "d", comparator: "~" as const },
      { value: 28, unit: "d", code: "d", extension: ema("100000000055") },
      { value: 28, unit: "d", code: "d", extension: ema("100000000053") },
      { value: 28, unit: "d", code: "d" }, { value: 2, unit: "custom-cycle" }
    ]) for (const count of [1, 6, undefined]) {
      const source: FhirR6DosageInstruction = { repeatCycle: cycle, step: [{
        ...(count !== undefined ? { count } : {}),
        component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] }]
      }] };
      for (const input of [source, toDosageDetails(toFhirR5Dosages(source))]) {
        const en = formatSig(input, "long", { locale: "en" });
        const th = formatSig(input, "long", { locale: "th" });
        if (count !== undefined) {
          expect(en).toContain(`Perform this phase ${count} ${count === 1 ? "time" : "times"}`);
          expect(th).toContain(`ทำซ้ำระยะนี้รวม ${count} ครั้ง`);
        } else {
          expect(en).not.toContain("Perform this phase");
          expect(th).not.toContain("ทำซ้ำระยะนี้");
        }
        const op = getQuantityComparator(cycle);
        if (op) expect(en).toContain(op + "28 days");
      }
      const restored = toDosageDetails(toFhirR5Dosages(source));
      expect(restored.step).toEqual(source.step);
      expect(restored.repeatCycle?.value).toBe(cycle.value);
      expect(restored.repeatCycle?.unit).toBe(cycle.unit);
      // A canonical EMA operator is normalized to the equivalent native
      // R6 comparator, not required to keep its older wire spelling.
      expect(getQuantityComparator(restored.repeatCycle)).toBe(getQuantityComparator(cycle));
      expect(fromFhir(source).fhirNext).toEqual(source);
    }
  });

  it("keeps native and EMA upper duration bounds as upper horizons, not unbounded courses", () => {
    const options = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", limit: 20 };
    for (const operator of ["<", "<=", "~"] as const) {
      const native = { value: 7, unit: "d", code: "d", comparator: operator };
      const code = operator === "<" ? "100000000050" : operator === "<=" ? "100000000052" : "100000000055";
      const ema = { value: 7, unit: "d", code: "d", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
      }] };
      for (const quantity of [native, ema]) {
        const source: FhirR6DosageInstruction = { step: [{ component: [{
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
          timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
            timeOfDay: ["08:00:00"], boundsDuration: quantity } }
        }] }] };
        for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
          const due = nextDueDoses(input, options);
          expect(due).toHaveLength(7);
          expect(due[6]).toBe("2026-11-08T08:00:00+00:00");
          expect(calculateTotalUnits({ dosage: input, ...options,
            durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
        }
        expect(getQuantityComparator(toDosageDetails(toFhirR5Dosages(source))
          .step[0].component[0].timing?.repeat?.boundsDuration)).toBe(operator);
      }
    }
    // Lower bounds never imply an upper treatment stop.
    const lower: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        boundsDuration: { value: 7, code: "d", comparator: ">=" } } }
    }] }] };
    expect(calculateTotalUnits({ dosage: lower, ...options,
      durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
  });

  it("retains upper caps through range endpoints and anchored-course modifiers", () => {
    const ema = { value: 7, unit: "d", code: "d", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000052" }
    }] };
    for (const bound of [
      { timing: { repeat: { boundsRange: { high: ema } } } },
      { modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueQuantity: ema }] },
      { modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-anchored-course-duration",
        valueRange: { high: ema } }] }
    ]) {
      const row: FhirDosage = { ...bound,
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"], ...bound.timing?.repeat } }
      };
      const options = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
        timeZone: "UTC", limit: 20 };
      expect(nextDueDoses(row, options)).toHaveLength(7);
      expect(calculateTotalUnits({ dosage: row, ...options,
        durationValue: 14, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(7);
    }
  });

  it("continues nominal approximate-limit arithmetic but does not invent a unique inequality window", () => {
    const opts = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", limit: 4, durationValue: 4, durationUnit: FhirPeriodUnit.Day };
    for (const doseOperator of [undefined, "~"] as const)
    for (const maxOperator of [undefined, "~"] as const)
    for (const periodOperator of [undefined, "~", ">="] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 1, unit: "tab",
          ...(doseOperator ? { comparator: doseOperator } : {}) })! }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
          timeOfDay: ["08:00:00"] } },
        safety: { doseLimit: [{ scope: "period",
          valueQuantity: { value: 1, unit: "tab", ...(maxOperator ? { comparator: maxOperator } : {}) },
          period: { value: 2, unit: "d", code: "d", ...(periodOperator ? { comparator: periodOperator } : {}) }
        }] }
      }] }] };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const total = calculateTotalUnits({ dosage: input, ...opts });
        expect(total.totalUnits).toBe(periodOperator === ">=" ? 4 : 2);
        if (periodOperator === ">=") {
          expect(() => nextDueDoses(input, opts)).toThrow(expect.objectContaining({ code: "unresolved-cap-period" }));
          expect(total.explanation).toContain("could not be applied");
        } else {
          expect(nextDueDoses(input, opts)).toEqual([
            "2026-11-02T08:00:00+00:00", "2026-11-04T08:00:00+00:00",
            "2026-11-06T08:00:00+00:00", "2026-11-08T08:00:00+00:00"
          ]);
        }
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
    // The existing source is never an excuse to blank a known numeric dose.
    const approximate = parseSig("approximately 5 mg PO QD");
    expect(calculateTotalUnits({ dosage: approximate, ...opts, durationValue: 7 }).totalUnits).toBe(35);
    expect(getQuantityComparator(approximate.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity)).toBe("~");
  });

  it("uses the same nominal and unevaluated-operator policy for lifetime and administration limits", () => {
    const opts = { from: "2026-11-02T00:00:00Z", orderedAt: "2026-11-02T00:00:00Z",
      timeZone: "UTC", durationValue: 4, durationUnit: FhirPeriodUnit.Day };
    for (const operator of [undefined, "~", ">="] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator: "~" })! }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        safety: { doseLimit: [
          { scope: "administration", valueQuantity: { value: 8, unit: "mg",
            ...(operator ? { comparator: operator } : {}) } },
          { scope: "lifetime", valueQuantity: { value: 15, unit: "mg",
            ...(operator ? { comparator: operator } : {}) } }
        ] }
      }] }] };
      for (const input of [source, toFhirR5Dosages(source), fromFhir(source)]) {
        const total = calculateTotalUnits({ dosage: input, ...opts });
        expect(total.totalUnits).toBe(operator === ">=" ? 20 : 15);
        if (operator === ">=") expect(total.explanation).toContain("could not be applied");
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
  });

  it.each(["administration", "lifetime", "period"] as const)(
    "retains superseded %s safety limits without restoring their deleted active value", scope => {
      const oldLimit = {
        scope,
        ...(scope === "period" ? { period: { value: 1, unit: "d", code: "d" } } : {}),
        valueQuantity: { value: 5, unit: "mg", comparator: "~" as const },
        extension: [{ url: "https://example.org/retained-limit", valueString: "original" }]
      };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        safety: { doseLimit: [oldLimit] }
      }] }] };
      const row = toFhirR5Dosages(source)[0];
      expect(toDosageDetails([row])).toEqual(source);
      const deletedRow = structuredClone(row);
      if (scope === "administration") delete deletedRow.maxDosePerAdministration;
      else if (scope === "lifetime") delete deletedRow.maxDosePerLifetime;
      else delete deletedRow.maxDosePerPeriod;
      const edited = toDosageDetails([deletedRow]);
      expect(edited.step[0].component[0].safety?.doseLimit
        ?.some(limit => limit.scope === scope)).not.toBe(true);
      expect(JSON.stringify(edited.extension)).toContain("retained-limit");
      expect(JSON.stringify(edited.extension)).toContain('"value":5');
      const reopened = toDosageDetails(toFhirR5Dosages(edited));
      expect(reopened.step[0].component[0].safety).toEqual(edited.step[0].component[0].safety);
      expect(JSON.stringify(reopened.extension)).toContain("retained-limit");

      // Explicit typed R6 safety replacement is another editing surface for
      // the same field: the new limit must be active; the old is source.
      const override: EzDosage = { ...toFhirR5Dosages(source)[0],
        safety: { doseLimit: [{ ...oldLimit, valueQuantity: {
          value: 8, unit: "mg"
        }, extension: undefined }] } };
      const current = toDosageDetails([override]);
      expect(current.step[0].component[0].safety?.doseLimit?.[0].valueQuantity?.value).toBe(8);
      expect(JSON.stringify(current.extension)).toContain("retained-limit");
    }
  );

  it("preserves non-representable safety siblings when a representable limit is deleted", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: {
        ifExceeded: "stop",
        doseLimit: [
          { scope: "administration", valueQuantity: { value: 5, unit: "mg", comparator: "~" },
            extension: [{ url: "https://example.org/deleted-limit", valueString: "old" }] },
          { scope: "administration", valueExpression: {
            expression: "%patient.weight * 2", language: "text/fhirpath"
          }, extension: [{ url: "https://example.org/expression-limit", valueBoolean: true }] }
        ]
      }
    }] }] };
    const row = cloneStructuredValue(toFhirR5Dosages(source))[0];
    delete row.maxDosePerAdministration;
    const edited = toDosageDetails([row]);
    const safety = edited.step[0].component[0].safety;
    expect(safety?.ifExceeded).toBe("stop");
    expect(safety?.doseLimit).toHaveLength(1);
    expect(safety?.doseLimit?.[0].valueExpression?.expression).toBe("%patient.weight * 2");
    expect(JSON.stringify(edited.extension)).toContain("deleted-limit");
    expect(toDosageDetails(toFhirR5Dosages(edited)).step[0].component[0].safety).toEqual(safety);
  });

  it("never transfers unknown safety-limit metadata to a different surviving period", () => {
    const limit = (value: number, days: number, tag: string) => ({
      scope: "period" as const,
      valueQuantity: { value, unit: "mg" },
      period: { value: days, unit: "d", code: "d" },
      extension: [{ url: "https://example.org/limit-" + tag, valueString: tag }]
    });
    const a = limit(5, 1, "A"), b = limit(10, 7, "B");
    const original: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [a, b] }
    }] }] };
    const r5 = toFhirR5Dosages(original);
    expect(r5[0].maxDosePerPeriod).toHaveLength(2);
    const sources = (result: FhirR6DosageInstruction) =>
      JSON.stringify(result.extension?.filter(ext => ext.url.includes("reconciliation-source")));
    const live = (rows: FhirDosage[]) =>
      toDosageDetails(rows).step[0].component[0].safety?.doseLimit ?? [];

    // Deletion: the 10 mg / 7 day limit must retain B, NEVER A.
    const deleted = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    deleted[0].maxDosePerPeriod!.shift();
    expect(live(deleted)).toEqual([b]);
    const afterDeletion = toDosageDetails(deleted);
    expect(sources(afterDeletion)).toContain("limit-A");
    expect(toDosageDetails(toFhirR5Dosages(afterDeletion))
      .step[0].component[0].safety?.doseLimit).toEqual([b]);

    // Reordering two same-scope limits does not exchange metadata owners.
    const reordered = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    reordered[0].maxDosePerPeriod!.reverse();
    expect(live(reordered)).toEqual([b, a]);

    // Editing one numeric maximum leaves the other limit's metadata alone.
    const edited = JSON.parse(JSON.stringify(r5)) as FhirDosage[];
    edited[0].maxDosePerPeriod![0].numerator.value = 6;
    expect(live(edited)).toEqual([{ ...a, valueQuantity: {
      value: 6, unit: "mg"
    } }, b]);

    // Two indistinguishable numeric limits: deleting one cannot determine
    // which unfamiliar extension belonged to the survivor. Keep BOTH old
    // meanings in source provenance, not on an arbitrarily chosen live limit.
    const twin: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      safety: { doseLimit: [a, { ...a, extension: b.extension }] }
    }] }] };
    // R5 Ratio Element metadata now survives projection. An explicitly
    // annotated live B remains B even when its numeric value matches A.
    const identified = cloneStructuredValue(toFhirR5Dosages(twin));
    identified[0].maxDosePerPeriod!.shift();
    expect(toDosageDetails(identified).step[0].component[0].safety?.doseLimit?.[0].extension)
      .toEqual(b.extension);
    // A consumer can return only the numeric R5 projection. With those
    // live annotations omitted, the retained twin sources are ambiguous.
    const ambiguous = cloneStructuredValue(toFhirR5Dosages(twin));
    for (const ratio of ambiguous[0].maxDosePerPeriod!) delete ratio.extension;
    ambiguous[0].maxDosePerPeriod!.shift();
    const survivor = toDosageDetails(ambiguous);
    const active = survivor.step[0].component[0].safety?.doseLimit?.[0];
    expect(active?.valueQuantity?.value).toBe(5);
    expect(active?.extension).toBeUndefined();
    expect(sources(survivor)).toContain("limit-A");
    expect(sources(survivor)).toContain("limit-B");
  });

  it.each(["<", "<=", "~", ">=", ">"] as const)(
    "keeps %s dose supply bounds consistent through all dosage representations", comparator => {
      const original: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        doseAndRate: [{ doseQuantity: simpleQuantityForR5({ value: 5, unit: "mg", comparator })! }]
      }] }] };
      const strict = toFhirR5Dosages(original);
      const options = { from: "2026-11-02T00:00:00Z",
        orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC",
        durationValue: 7, durationUnit: FhirPeriodUnit.Day };
      for (const dosage of [original, strict, strict[0], fromFhir(original)]) {
        if (comparator === ">" || comparator === ">=")
          expect(() => calculateTotalUnits({ dosage, ...options })).toThrow(/lower bound/i);
        else expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(35);
      }
      expect(toDosageDetails(strict)).toEqual(original);
      expect(getQuantityComparator(original.step[0].component[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
    }
  );

  it("distinguishes finite dose/rate/range estimates from unbounded lower limits", () => {
    const options = { from: "2026-11-02T00:00:00Z",
      orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC",
      durationValue: 7, durationUnit: FhirPeriodUnit.Day };
    const timing = { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
      duration: 2, durationUnit: FhirPeriodUnit.Hour } };
    for (const entry of [
      { rateQuantity: simpleQuantityForR5({ value: 10, unit: "mL/h", comparator: ">=" })! },
      { rateRatio: { numerator: { value: 10, unit: "mL", comparator: "<=" },
        denominator: { value: 1, unit: "h" } } }
    ] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing, doseAndRate: [entry]
      }] }] };
      for (const dosage of [source, toFhirR5Dosages(source)]) {
        if ("rateQuantity" in entry)
          expect(() => calculateTotalUnits({ dosage, ...options })).toThrow(/lower bound/i);
        else expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(140);
      }
      expect(toDosageDetails(toFhirR5Dosages(source))).toEqual(source);
    }
    const ranged: FhirR6DosageInstruction = { step: [{ component: [{
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      doseAndRate: [{ doseRange: {
        low: simpleQuantityForR5({ value: 5, unit: "mg", comparator: ">=" })!,
        high: simpleQuantityForR5({ value: 8, unit: "mg", comparator: "<=" })!
      } }]
    }] }] };
    for (const dosage of [ranged, toFhirR5Dosages(ranged)])
      expect(calculateTotalUnits({ dosage, ...options }).totalUnits).toBe(56);
    expect(toDosageDetails(toFhirR5Dosages(ranged))).toEqual(ranged);
  });

  it("executes current-profile EMA active/rest offsets consistently", () => {
    const coding = (code: string) => [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
      valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code }
    }];
    const options = { from: "2026-11-02T00:00:00Z",
      orderedAt: "2026-11-02T00:00:00Z", timeZone: "UTC", limit: 30 };
    for (const [code, native, allowed] of [
      ["100000000055", "~", true],
      ["100000000053", ">=", false],
      ["100000000052", "<=", false],
      ["100000000051", ">", false],
      ["100000000050", "<", false]
    ] as const) {
      const startOffset = { value: 2, unit: "d", code: "d", extension: coding(code) };
      for (const offset of [startOffset]) {
        const course: FhirR6DosageInstruction = { step: [{ component: [{
          timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
            startOffset: offset, endOffset: { value: 5, unit: "d", code: "d" } } },
          doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
        }] }] };
        const r5 = toFhirR5Dosages(course);
        expect(getQuantityComparator(toDosageDetails(r5).step[0]
          .component[0].timing?.repeat?.startOffset)).toBe(native);
        for (const dosage of [course, fromFhir(course), r5, toDosageDetails(r5)]) {
          if (allowed) {
            const due = nextDueDoses(dosage, options);
            expect(due[0]).toBe("2026-11-04T00:00:00+00:00");
            expect(calculateTotalUnits({ dosage, ...options,
              durationValue: 28, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
          } else {
            expect(() => nextDueDoses(dosage, options)).toThrow(/offset/);
            expect(() => calculateTotalUnits({ dosage, ...options,
              durationValue: 28, durationUnit: FhirPeriodUnit.Day })).toThrow(/offset/);
          }
        }
      }
    }
  });

  it.each(["~", ">=", "<=", ">", "<"] as const)(
    "keeps permissive offset comparator %s source separate from strict current-profile acceptance", comparator => {
      const startOffset = { value: 2, unit: "d", code: "d", comparator };
      const source: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { frequency: 21, period: 28, periodUnit: FhirPeriodUnit.Day,
          startOffset, endOffset: { value: 5, unit: "d", code: "d" } } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      }] }] };
      expect(() => fromFhir(source)).toThrow(/SimpleQuantity/);
      const restored = toDosageDetails(toFhirR5Dosages(source));
      expect(getQuantityComparator(restored.step[0].component[0].timing!.repeat!.startOffset)).toBe(comparator);
    }
  );

  it("imports only the current R6 shape and enforces the published Element and choice constraints", () => {
    const base = parseSig("1 tab PO qd").fhirNext;
    const invalid = [
      { ...base, resourceType: "DosageDetails" },
      { ...base, step: [{ component: [] }] },
      { ...base, step: [{ ...base.step[0], modifierExtension: [] }] },
      { ...base, step: [{ component: [{ ...base.step[0].component[0], sequence: 1 }] }] },
      { ...base, step: [{ component: [{ ...base.step[0].component[0], doseAndRate: [{ doseQuantity: { value: 1 }, doseExpression: { expression: "1" } }] }] }] },
      { ...base, step: [{ component: base.step[0].component, safety: { ifExceeded: "stop" } }] }
    ];
    for (const example of invalid) {
      expect(() => fromFhir(example as FhirR6DosageInstruction)).toThrow(/FHIR R6 DosageInstruction/);
    }
    expect(fromFhir({ renderedInstruction: "Directions supplied as text only.", step: [] }).fhir[0].text)
      .toBe("Directions supplied as text only.");
  });
});
