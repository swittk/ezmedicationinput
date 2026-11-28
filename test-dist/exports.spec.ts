import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const TAB_CONTEXT_LITERAL =
  "{ dosageForm: 'tablet' }";

function runNode(args: string[], code: string): {
  parseSigType: string;
  formatSigType: string;
  parseInstructionActionsType?: string;
  realizeInstructionGraphType?: string;
  listMedicationInstructionActionsType?: string;
  buildMedicationInstructionActionCodeSystemType?: string;
  listMedicationInstructionConceptsType?: string;
  buildMedicationInstructionConceptCodeSystemType?: string;
  listSymptomDefinitionsType?: string;
  resolveSymptomDefinitionType?: string;
  findSymptomDefinitionByCodingType?: string;
  symptomCount?: number;
  listAdviceRelationDefinitionsType?: string;
  localizeAdviceRelationType?: string;
  resolveActionRelationSurfaceType?: string;
  listBodySiteRelationDefinitionsType?: string;
  adviceRelationCount?: number;
  thaiBeforeRelation?: string;
  nearRelationThai?: string;
  timingFrequencyMinExtensionUrl?: string;
  timingActivityWindowExtensionUrl?: string;
  timingOccurrenceCapExtensionUrl?: string;
  prnTriggerPhaseExtensionUrl?: string;
  getTimingOccurrenceCapType?: string;
  occurrenceCapMax?: number;
  roundTripText?: string;
  currentText?: string;
  naturalText?: string;
  naturalRoundTripText?: string;
  originalComponentText?: string;
  roundTripDoseCount?: number;
  roundTripAdministrationCount?: number;
  roundTripSiteCode?: string;
  roundTripFrequency?: number;
  roundTripAnchors?: string[];
  originalInstruction?: string;
  longText: string;
} {
  const output = execFileSync(process.execPath, [...args, "-e", code], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  }).trim();
  return JSON.parse(output);
}

describe("published package entrypoints", () => {
  it("supports CommonJS require through the package exports map", () => {
    const result = runNode(
      [],
      `
        const mod = require("ezmedicationinput");
        const parsed = mod.parseSig("1 tab po daily", { context: ${TAB_CONTEXT_LITERAL} });
        process.stdout.write(JSON.stringify({
          parseSigType: typeof mod.parseSig,
          formatSigType: typeof mod.formatSig,
          longText: parsed.longText
        }));
      `
    );

    expect(result).toEqual({
      parseSigType: "function",
      formatSigType: "function",
      longText: "Take 1 tablet orally once daily."
    });
  });

  it("supports ESM import through the package exports map", () => {
    const result = runNode(
      ["--input-type=module"],
      `
        const mod = await import("ezmedicationinput");
        const parsed = mod.parseSig("1 tab po daily", { context: ${TAB_CONTEXT_LITERAL} });
        process.stdout.write(JSON.stringify({
          parseSigType: typeof mod.parseSig,
          formatSigType: typeof mod.formatSig,
          longText: parsed.longText
        }));
      `
    );

    expect(result).toEqual({
      parseSigType: "function",
      formatSigType: "function",
      longText: "Take 1 tablet orally once daily."
    });
  });

  it("publishes procedural graph parsing, realization, and terminology APIs", () => {
    const result = runNode(
      ["--input-type=module"],
      `
        const mod = await import("ezmedicationinput");
        const actions = mod.parseInstructionActions("shake bottle then rinse");
        process.stdout.write(JSON.stringify({
          parseSigType: typeof mod.parseSig,
          formatSigType: typeof mod.formatSig,
          parseInstructionActionsType: typeof mod.parseInstructionActions,
          realizeInstructionGraphType: typeof mod.realizeInstructionGraph,
          listMedicationInstructionActionsType: typeof mod.listMedicationInstructionActions,
          buildMedicationInstructionActionCodeSystemType: typeof mod.buildMedicationInstructionActionCodeSystem,
          listMedicationInstructionConceptsType: typeof mod.listMedicationInstructionConcepts,
          buildMedicationInstructionConceptCodeSystemType: typeof mod.buildMedicationInstructionConceptCodeSystem,
          listSymptomDefinitionsType: typeof mod.listSymptomDefinitions,
          resolveSymptomDefinitionType: typeof mod.resolveSymptomDefinition,
          findSymptomDefinitionByCodingType: typeof mod.findSymptomDefinitionByCoding,
          symptomCount: mod.listSymptomDefinitions().length,
          listAdviceRelationDefinitionsType: typeof mod.listAdviceRelationDefinitions,
          localizeAdviceRelationType: typeof mod.localizeAdviceRelation,
          resolveActionRelationSurfaceType: typeof mod.resolveActionRelationSurface,
          listBodySiteRelationDefinitionsType: typeof mod.listBodySiteRelationDefinitions,
          adviceRelationCount: mod.listAdviceRelationDefinitions().length,
          thaiBeforeRelation: mod.localizeAdviceRelation("before", "th"),
          nearRelationThai: mod.getBodySiteRelationRealization("near", "th")?.surface,
          timingFrequencyMinExtensionUrl: mod.TIMING_FREQUENCY_MIN_EXTENSION_URL,
          timingActivityWindowExtensionUrl: mod.TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
          timingOccurrenceCapExtensionUrl: mod.TIMING_OCCURRENCE_CAP_EXTENSION_URL,
          prnTriggerPhaseExtensionUrl: mod.PRN_TRIGGER_PHASE_EXTENSION_URL,
          getTimingOccurrenceCapType: typeof mod.getTimingOccurrenceCap,
          occurrenceCapMax: mod.getTimingOccurrenceCap(
            mod.parseSig("1 tab po q4h prn pain max 3 doses daily").fhirNext.step[0]?.component[0]?.timing?.repeat
          )?.max,
          longText: actions.map((action) => action.predicate.lemma).join(",")
        }));
      `
    );

    expect(result).toEqual({
      parseSigType: "function",
      formatSigType: "function",
      parseInstructionActionsType: "function",
      realizeInstructionGraphType: "function",
      listMedicationInstructionActionsType: "function",
      buildMedicationInstructionActionCodeSystemType: "function",
      listMedicationInstructionConceptsType: "function",
      buildMedicationInstructionConceptCodeSystemType: "function",
      listSymptomDefinitionsType: "function",
      resolveSymptomDefinitionType: "function",
      findSymptomDefinitionByCodingType: "function",
      symptomCount: 100,
      listAdviceRelationDefinitionsType: "function",
      localizeAdviceRelationType: "function",
      resolveActionRelationSurfaceType: "function",
      listBodySiteRelationDefinitionsType: "function",
      adviceRelationCount: 17,
      thaiBeforeRelation: "ก่อน",
      nearRelationThai: "ใกล้",
      timingFrequencyMinExtensionUrl: "urn:ezmedicationinput:StructureDefinition:medication-timing-frequency-min",
      timingActivityWindowExtensionUrl: "urn:ezmedicationinput:StructureDefinition:medication-timing-activity-window",
      timingOccurrenceCapExtensionUrl: "urn:ezmedicationinput:StructureDefinition:medication-timing-occurrence-cap",
      prnTriggerPhaseExtensionUrl: "urn:ezmedicationinput:StructureDefinition:medication-prn-trigger-phase",
      getTimingOccurrenceCapType: "function",
      occurrenceCapMax: 3,
      longText: "shake,rinse"
    });
  });

  it("publishes current TH/EN previews and retains source wording through the built entrypoint", () => {
    const result = runNode(
      ["--input-type=module"],
      `
        const mod = await import("ezmedicationinput");
        const source = "หยอดตาขวาวันละ 4 ครั้ง เช้า กลางวัน เย็น ก่อนนอน";
        const parsed = mod.parseSig(source, { locale: "th" });
        const roundTripText = mod.formatSig(parsed.fhirNext, "long", {
          locale: "th",
          realizationMode: "roundtrip"
        });
        // Reparse the independently rendered clinical facts while the original
        // authored fields remain available on the parser output above.
        const naturalRoundTripText = mod.formatSig(parsed.fhirNext, "long", {
          locale: "th", realizationMode: "roundtrip", sitePlacement: "natural"
        });
        const current = JSON.parse(JSON.stringify(parsed.fhirNext));
        delete current.renderedInstruction;
        for (const step of current.step ?? [])
          for (const component of step.component ?? []) delete component.text;
        const currentText = mod.formatSig(current, "long", {
          locale: "th",
          realizationMode: "roundtrip"
        });
        const naturalText = mod.formatSig(current, "long", {
          locale: "th", realizationMode: "roundtrip", sitePlacement: "natural"
        });
        const reparsed = mod.parseSig(currentText, { locale: "th" });
        process.stdout.write(JSON.stringify({
          parseSigType: typeof mod.parseSig,
          formatSigType: typeof mod.formatSig,
          roundTripText,
          currentText,
          naturalText,
          naturalRoundTripText,
          originalInstruction: parsed.fhirNext.renderedInstruction,
          originalComponentText: parsed.fhirNext.step[0]?.component[0]?.text,
          roundTripAdministrationCount: reparsed.fhirNext.step.reduce((count, step) => count + (step.component?.length ?? 0), 0),
          roundTripDoseCount: reparsed.fhirNext.step[0]?.component[0]?.doseAndRate?.length ?? 0,
          roundTripSiteCode: reparsed.fhirNext.step[0]?.component[0]?.site?.concept?.coding?.[0]?.code,
          roundTripFrequency: reparsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.frequency,
          roundTripPeriod: reparsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.period,
          roundTripPeriodUnit: reparsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.periodUnit,
          roundTripAnchors: reparsed.fhirNext.step[0]?.component[0]?.timing?.repeat?.when,
          longText: reparsed.longText
        }));
      `
    );
    expect(result.currentText).toBe("หยอดวันละ 4 ครั้ง เช้า, เที่ยง, เย็น และ ก่อนนอน ที่ตาขวา.");
    expect(result.naturalText).toBe("หยอดตาขวา วันละ 4 ครั้ง เช้า, เที่ยง, เย็น และ ก่อนนอน.");
    expect(result.roundTripText).toBe("ปัจจุบัน: หยอดวันละ 4 ครั้ง เช้า, เที่ยง, เย็น และ ก่อนนอน ที่ตาขวา; ข้อความเดิม: หยอดตาขวา วันละ 4 ครั้ง เช้า, เที่ยง, เย็น และ ก่อนนอน.");
    expect(result.naturalRoundTripText).toBe(result.naturalText);
    expect(result.originalInstruction).toBe("หยอดตาขวาวันละ 4 ครั้ง เช้า กลางวัน เย็น ก่อนนอน");
    expect(result.originalComponentText).toBe("หยอดตาขวา วันละ 4 ครั้ง ตอนเช้า, ตอนเที่ยง, ตอนเย็น และ ก่อนนอน.");
    expect(result.roundTripAdministrationCount).toBe(1);
    expect(result.roundTripDoseCount).toBe(0);
    expect(result.roundTripSiteCode).toBe("1290032005");
    expect(result).toMatchObject({ roundTripFrequency: 4, roundTripPeriod: 1, roundTripPeriodUnit: "d" });
    expect(result.roundTripAnchors).toEqual(["MORN", "NOON", "EVE", "HS"]);
    expect(result.longText).toBe("หยอดตาขวา วันละ 4 ครั้ง ตอนเช้า, ตอนเที่ยง, ตอนเย็น และ ก่อนนอน.");
  });

});


it("accepts typed current duration annotations and literal weekday codes from the distribution", () => {
  const directory = mkdtempSync(join(ROOT_DIR, ".declaration-consumer-"));
  try {
    const entry = join(directory, "consumer.ts");
    writeFileSync(entry, `
      import { FhirDayOfWeek, type FhirDosage, type FhirR6DosageInstruction, type FhirExtension,
        type FhirR6Extension, type FhirTimingRepeat } from "ezmedicationinput";
      const annotation: FhirR6Extension = { url: "urn:clinic:duration", valueDuration: {
        value: 30, comparator: "~", system: "http://unitsofmeasure.org", code: "min"
      } };
      const current: FhirR6DosageInstruction = { step: [{ component: [{
        timing: { repeat: { dayOfWeek: ["mon", "wed", "fri", FhirDayOfWeek.Sunday, null],
          _dayOfWeek: [null, null, null, null, { id: "unspecified-day" }] } },
        doseAndRate: [{ doseQuantity: { value: 1, _value: { extension: [annotation] } } }]
      }] }] };
      const r5: FhirDosage = { timing: { repeat: { dayOfWeek: ["mon", "wed", "fri"] } },
        extension: [{ url: "urn:clinic:duration", valueDuration: { value: 30, comparator: ">", code: "min" } }] };
      const invalidWeekday: FhirTimingRepeat = {
        // @ts-expect-error weekday vocabulary remains bounded
        dayOfWeek: ["holiday"]
      };
      const invalidR5: FhirExtension = { url: "urn:clinic:duration", valueDuration: {
        // @ts-expect-error native approximate comparators are R6 only
        comparator: "~"
      } };
      const r5Date: FhirExtension = { url: "urn:clinic:review-date", valueDate: "2026-12-15",
        _valueDate: { id: "r5-review-date", extension: [{ url: "urn:clinic:note", valueString: "Review in clinic" }] } };
      const r6Date: FhirR6Extension = { url: "urn:clinic:review-date", valueDate: "2026-12-15",
        _valueDate: { id: "r6-review-date", extension: [annotation] } };
      const r5PrimitiveAnnotations: FhirExtension[] = [
        { url: "urn:clinic:Uri", valueUri: "urn:clinic:review", _valueUri: r5Date._valueDate },
        { url: "urn:clinic:Canonical", valueCanonical: "https://clinic.example/PlanDefinition/review", _valueCanonical: r5Date._valueDate },
        { url: "urn:clinic:DateTime", valueDateTime: "2026-12-15T08:00:00Z", _valueDateTime: r5Date._valueDate },
        { url: "urn:clinic:PositiveInt", valuePositiveInt: 2, _valuePositiveInt: r5Date._valueDate },
        { url: "urn:clinic:UnsignedInt", valueUnsignedInt: 0, _valueUnsignedInt: r5Date._valueDate },
      ];
      const r6PrimitiveAnnotations: FhirR6Extension[] = [
        { url: "urn:clinic:Uri", valueUri: "urn:clinic:review", _valueUri: r6Date._valueDate },
        { url: "urn:clinic:Canonical", valueCanonical: "https://clinic.example/PlanDefinition/review", _valueCanonical: r6Date._valueDate },
        { url: "urn:clinic:DateTime", valueDateTime: "2026-12-15T08:00:00Z", _valueDateTime: r6Date._valueDate },
        { url: "urn:clinic:PositiveInt", valuePositiveInt: 2, _valuePositiveInt: r6Date._valueDate },
        { url: "urn:clinic:UnsignedInt", valueUnsignedInt: 0, _valueUnsignedInt: r6Date._valueDate },
      ];
      void [current, r5, invalidWeekday, invalidR5, r5Date, r6Date, r5PrimitiveAnnotations, r6PrimitiveAnnotations];
    `);
    execFileSync(process.execPath, [join(ROOT_DIR, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
      "--skipLibCheck", "false", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", entry],
      { cwd: ROOT_DIR, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
