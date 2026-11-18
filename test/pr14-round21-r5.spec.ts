import retainedCourseProfile from "../fhir/r5/medication-r6-course-details.json";
import { describe, expect, it } from "vitest";
import {
  fromDosageDetails, nextDueDoses, toDosageDetails, toEzDosages, toFhirR5Dosages,
  FhirPeriodUnit, type EzDosage, type FhirDosage, type FhirExtension,
  type FhirR6DosageInstruction, type FhirR6Quantity,
} from "../src/index";
import {
  DOSAGE_DETAILS_R5_URL, DOSAGE_RECONCILIATION_SOURCE_URL, R5_EXPRESSION_SLOT_SOURCE_URL,
  decodeR5RetainedFields, encodeR5RetainedFields, encodeR6SourceMetadata, decodeR6SourceMetadata,
  dosageMatchesSavedProjection, withDosageEditProvenance, fromR6Dosage,
} from "../src/dosage-course";
import {
  EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM,
  getQuantityComparator, quantityForR5, simpleQuantityForR5,
} from "../src/fhir-quantity-operator";
import { COURSE_CYCLE_COUNT_EXTENSION_URL, getCourseCycleCount } from "../src/fhir-course-cycle-count";
import { administrationFromR5, courseFromR6 } from "../src/adapters/canonical-course";

const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const rowDose = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
const componentSafety = (course: FhirR6DosageInstruction) => course.step[0].component[0].safety;
function historicalRows(extra: FhirExtension[] = []): EzDosage[] {
  const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL, extension: [{
    url: "dosageDetails", extension: [
      { url: "renderedInstruction", valueString: "Take one tablet, two repeats." },
      ...extra,
      { url: "step", extension: [
        { url: "count", valueInteger: 2 },
        { url: "component", extension: [
          { url: "text", valueString: "Take one tablet, two repeats." },
          { url: "doseAndRate", extension: [{
            url: "doseQuantity", valueQuantity: { value: 1, unit: "tab" },
          }] },
        ] },
      ] },
    ],
  }] };
  return withDosageEditProvenance([{
    ...persist(rowDose), sequence: 1, text: "Take one tablet, two repeats.", modifierExtension: [marker],
  }], "Take one tablet, two repeats.");
}

describe("review round 21: persisted R5 ownership and retention", () => {
  it("writes free-text safety actions as strings and reads the historical code spelling", () => {
    const action = "Stop the dose.\nContact the prescriber.";
    const actions = retainedCourseProfile.differential.element.filter(item => item.id.endsWith(":ifExceeded.value[x]"));
    expect(actions).toHaveLength(4);
    for (const field of actions) expect(field).toMatchObject({ type: [{ code: "string" }] });
    const marker: FhirExtension = { url: DOSAGE_DETAILS_R5_URL,
      extension: encodeR5RetainedFields({ component: { safety: { ifExceeded: action } } }) };
    const safety = marker.extension![0].extension!.find(child => child.url === "safety")!;
    expect(safety.extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe(action);
    const single = encodeR6SourceMetadata("urn:example:single-step", { course: { ifExceeded: action } }, "safety");
    expect(single.extension![0].extension).toEqual([{ url: "ifExceeded", valueString: action }]);
    expect(decodeR6SourceMetadata(persist(single), "safety")).toEqual({ course: { ifExceeded: action } });
    safety.extension = [{ url: "ifExceeded", valueCode: "hold" }];
    expect(decodeR5RetainedFields(persist(marker)).component?.safety?.ifExceeded).toBe("hold");
  });

  it.each(["timing", "repeat"] as const)("invalidates a saved replay proof when %s extensions are replaced", owner => {
    const row = withDosageEditProvenance<FhirDosage>([{
      ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }], "Take one tablet daily.")[0];
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    const annotation = [{ url: "urn:example:clinical-timing", valueInteger: 2 }];
    if (owner === "timing") row.timing!.extension = annotation;
    else row.timing!.repeat!.extension = annotation;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it("clears the final R5 maximum from its lifted safety mirror after persistence", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    expect(rows[0].safety?.doseLimit?.[0].valueQuantity?.value).toBe(2);
    delete rows[0].maxDosePerAdministration;
    const changed = toDosageDetails(rows);
    expect(componentSafety(changed)).toBeUndefined();
    const sources = changed.extension?.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL);
    expect(sources?.length).toBeGreaterThan(0);
    const source = sources!.flatMap(item => item.extension ?? []).find(item =>
      decodeR5RetainedFields(item).component?.safety?.doseLimit?.[0].valueQuantity?.value === 2);
    expect(source).toBeDefined();
    expect(componentSafety(toDosageDetails(persist(toFhirR5Dosages(changed))))).toBeUndefined();
    expect(componentSafety(toDosageDetails(persist(fromDosageDetails(original).dosages))))
      .toEqual(original.step[0].component[0].safety);
  });

  it("keeps independent R6 safety after deleting the only projected quantity limit", () => {
    const original: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose),
      safety: { ifExceeded: "Hold and call.", doseLimit: [
        { scope: "administration", valueQuantity: { value: 2, unit: "tab" } },
        { id: "independent", scope: "lifetime", valueInteger: 20 },
      ] },
    }] }] };
    const rows = persist(fromDosageDetails(original).dosages);
    delete rows[0].maxDosePerAdministration;
    const active = componentSafety(toDosageDetails(rows));
    expect(active).toEqual({ ifExceeded: "Hold and call.", doseLimit: [
      { id: "independent", scope: "lifetime", valueInteger: 20 },
    ] });
  });

  it("retires baseline wording after historical step or header edits and accepts explicit replacement wording", () => {
    const rows = persist(historicalRows());
    expect(toDosageDetails(rows).renderedInstruction).toBe("Take one tablet, two repeats.");
    const changed = toDosageDetails(rows, undefined, { renderedInstruction: "Take one tablet, two repeats.",
      step: [{ sequence: 1, count: 3 }] });
    expect(changed.step[0].count).toBe(3);
    expect(changed.renderedInstruction).toBeUndefined();
    expect(changed.extension?.some(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toBe(true);
    expect(toDosageDetails(rows, undefined, { id: "revised-course" }).renderedInstruction).toBeUndefined();
    expect(toDosageDetails(rows, "Take one tablet, three repeats.", { step: [{ sequence: 1, count: 3 }] })
      .renderedInstruction).toBe("Take one tablet, three repeats.");
  });

  it("retains flat historical sources when active course annotations are replaced", () => {
    const previous = { url: "urn:example:older-source", valueString: "earlier independent annotation" };
    const history = { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [previous] };
    const replacement = { url: "urn:example:current-note", valueString: "current annotation" };
    let current = toDosageDetails(persist(historicalRows([
      { url: "extension", extension: [history] },
    ])), undefined, { extension: [replacement] });
    expect(current.extension).toContainEqual(replacement);
    expect(current.extension).toContainEqual(history);
    const sourceCount = current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL).length;
    expect(sourceCount).toBe(2);
    for (let i = 0; i < 3; i++) {
      current = toDosageDetails(persist(toFhirR5Dosages(current)));
      expect(current.extension).toContainEqual(history);
      expect(current.extension!.filter(item => item.url === DOSAGE_RECONCILIATION_SOURCE_URL)).toHaveLength(sourceCount);
    }
  });

  it("emits valid expression-only R5 slots and restores their original associations", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [
      { doseExpression: { language: "text/fhirpath", expression: "%weight * 2" } },
      { doseQuantity: { value: 5, unit: "mg" } },
      { rateExpression: { language: "text/fhirpath", expression: "%rate" } },
    ] }] }] };
    const rows = persist(toFhirR5Dosages(source));
    expect(rows[0].doseAndRate).toHaveLength(3);
    for (const index of [0, 2]) {
      const slot = rows[0].doseAndRate![index];
      expect(slot.doseQuantity).toBeUndefined();
      expect(slot.rateQuantity).toBeUndefined();
      expect(slot.extension?.[0].url).toBe(R5_EXPRESSION_SLOT_SOURCE_URL);
      expect(slot.extension?.[0].extension?.[0].valueExpression?.expression).toBe(index === 0 ? "%weight * 2" : "%rate");
    }
    const restored = toDosageDetails(rows);
    expect(restored.step[0].component[0].doseAndRate).toEqual(source.step[0].component[0].doseAndRate);
    expect(toDosageDetails(persist(toFhirR5Dosages(restored))).step[0].component[0].doseAndRate)
      .toEqual(source.step[0].component[0].doseAndRate);
    const scalar = fromR6Dosage(source.step[0].component[0], 1);
    expect(scalar.doseAndRate?.[0].extension?.[0].extension?.[0].valueExpression)
      .toEqual(source.step[0].component[0].doseAndRate![0].doseExpression);
    rows[0].doseAndRate![0].doseQuantity = { value: 7, unit: "mg" };
    const replaced = toDosageDetails(rows).step[0].component[0].doseAndRate![0];
    expect(replaced.doseQuantity).toEqual({ value: 7, unit: "mg" });
    expect(replaced.doseExpression).toBeUndefined();
  });

  it("keeps site wrapper metadata over repeated persisted R5 saves and respects a live concept clear", () => {
    const site = { id: "site-wrapper", extension: [{ url: "urn:example:site-note", valueString: "source note" }],
      concept: { text: "right eye" } };
    let source: FhirR6DosageInstruction = { step: [{ component: [{ ...persist(rowDose), site }] }] };
    for (let i = 0; i < 3; i++) {
      source = toDosageDetails(persist(toFhirR5Dosages(source)));
      expect(source.step[0].component[0].site).toEqual(site);
    }
    const rows = persist(toFhirR5Dosages(source));
    delete rows[0].site;
    const cleared = toDosageDetails(rows);
    expect(cleared.step[0].component[0].site?.concept).toBeUndefined();
    expect(toDosageDetails(persist(toFhirR5Dosages(cleared))).step[0].component[0].site?.concept).toBeUndefined();
  });

  it.each(["simple", "general"] as const)("removes stale active operator translations in %s quantities and retains their original coding", kind => {
    const originalCoding = { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000055", display: "Approximately",
      _display: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "ประมาณ" },
      ] }] }, i18n: { th: "ประมาณ" } };
    const quantity: FhirR6Quantity = { value: 5, unit: "mg", comparator: "<", extension: [{
      url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL, valueCoding: originalCoding,
    }] };
    const write = kind === "simple" ? simpleQuantityForR5 : quantityForR5;
    const changed = write(quantity)!;
    const active = changed.extension!.find(item => item.url === EMA_QUANTITY_COMPARATOR_EXTENSION_URL)!.valueCoding!;
    expect(active.code).toBe("100000000050");
    expect(active._display).toBeUndefined();
    expect(active.i18n).toBeUndefined();
    expect(getQuantityComparator(changed)).toBe("<");
    expect(changed.extension).toContainEqual({
      url: "urn:ezmedicationinput:StructureDefinition:quantity-operator-source", valueCoding: originalCoding,
    });
    expect(write(persist(changed))!.extension).toEqual(changed.extension);
    expect(write({ ...quantity, comparator: "~" })!.extension?.[0].valueCoding).toEqual(originalCoding);
  });

  it("uses persisted live R5 maximum edits for scalar scheduling and retains explicit safety edits", () => {
    const initial: FhirDosage = { ...persist(rowDose),
      timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
    };
    const row = persist(toEzDosages([initial])[0]);
    row.maxDosePerPeriod![0].numerator!.value = 1;
    expect(administrationFromR5(row).limits?.[0].amount?.value).toBe(1);
    const dates = nextDueDoses(row, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z",
      timeZone: "UTC", limit: 2 }).map(value => new Date(value).toISOString());
    expect(dates).toEqual(["2026-11-18T08:00:00.000Z", "2026-11-19T08:00:00.000Z"]);
    const explicit = persist(toEzDosages([initial])[0]);
    explicit.safety!.doseLimit![0].valueQuantity!.value = 3;
    expect(administrationFromR5(explicit).limits?.[0].amount?.value).toBe(3);
    const cleared = persist(toEzDosages([initial])[0]);
    delete cleared.maxDosePerPeriod;
    expect(administrationFromR5(cleared).limits).toBeUndefined();
    expect(administrationFromR5(cleared).safety).toBeUndefined();
  });

  it("migrates the actual previous-writer R5 course count without reinterpreting current step counts", () => {
    // Serialized origin/master output for a seven-day active/rest course,
    // copied as a wire fixture rather than produced by the current writer.
    const saved: FhirDosage[] = [{
      timing: { repeat: { frequency: 1, boundsDuration: { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" }, period: 1, periodUnit: FhirPeriodUnit.Day } },
      text: "Use 1 tablet once daily for 7 days.", sequence: 1,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" } }],
      modifierExtension: [{ url: DOSAGE_DETAILS_R5_URL, extension: [
        { url: "rowIndex", valueInteger: 0 }, { url: "sequence", valueInteger: 1 }, { url: "stepCount", valueInteger: 1 },
        { url: "step", extension: [{ url: "count", valueInteger: 3 }] },
        { url: "context", valueString: "72f2f03d1f8289c5" }, { url: "contextRequired", valueBoolean: true },
        { url: "course", extension: [{ url: "repeatCycle", valueQuantity: { value: 14, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }] },
      ] }], extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction", extension: [
        { url: "instruction", valueString: "1 tablet daily for 7 days then stop for 7 days, repeat for 3 cycles" },
        { url: "row", extension: [{ url: "projectionFingerprint", valueString: "4346df4e5678f52b" }, { url: "textFingerprint", valueString: "dab22a241c7d0f4f" }] },
      ] }],
    }];
    const migrated = toDosageDetails(persist(saved));
    expect(getCourseCycleCount(migrated)).toBe(3);
    expect(migrated.step[0].count).toBeUndefined();
    expect(migrated.extension).toContainEqual({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [saved[0].modifierExtension![0]] });
    const dates = nextDueDoses(migrated, { from: "2026-11-18T08:00:00Z", orderedAt: "2026-11-18T08:00:00Z", timeZone: "UTC", limit: 30 });
    expect(dates).toHaveLength(21);
    expect(new Date(dates[20]).toISOString().slice(0, 10)).toBe("2026-12-22");
    expect(getCourseCycleCount(toDosageDetails(persist(toFhirR5Dosages(migrated))))).toBe(3);
    const current: FhirR6DosageInstruction = { repeatCycle: { value: 14, unit: "d", code: "d" },
      step: [{ count: 2, component: [{ ...persist(rowDose), timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsDuration: { value: 1, unit: "d", code: "d" } } } }] }] };
    expect(courseFromR6(current).cycleCount).toBeUndefined();
    for (const bounded of [false, true]) {
      const source = { ...current, ...(bounded ? { modifierExtension: [{ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: 3 }] } : {}) };
      const rows = persist(toFhirR5Dosages(source));
      expect(rows[0].modifierExtension?.find(item => item.url === DOSAGE_DETAILS_R5_URL)?.extension)
        .toContainEqual({ url: "countScope", valueCode: "step" });
      const restored = toDosageDetails(rows);
      expect(restored.step[0].count).toBe(2);
      expect(getCourseCycleCount(restored)).toBe(bounded ? 3 : undefined);
    }
  });
});
