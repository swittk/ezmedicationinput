import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const TAB_CONTEXT_LITERAL =
  "{ tab: { singular: 'tablet', plural: 'tablets' } }";

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
  timingFrequencyMinExtensionUrl?: string;
  timingActivityWindowExtensionUrl?: string;
  timingOccurrenceCapExtensionUrl?: string;
  prnTriggerPhaseExtensionUrl?: string;
  getTimingOccurrenceCapType?: string;
  occurrenceCapMax?: number;
  roundTripText?: string;
  roundTripSiteCode?: string;
  roundTripFrequency?: number;
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
          timingFrequencyMinExtensionUrl: mod.TIMING_FREQUENCY_MIN_EXTENSION_URL,
          timingActivityWindowExtensionUrl: mod.TIMING_ACTIVITY_WINDOW_EXTENSION_URL,
          timingOccurrenceCapExtensionUrl: mod.TIMING_OCCURRENCE_CAP_EXTENSION_URL,
          prnTriggerPhaseExtensionUrl: mod.PRN_TRIGGER_PHASE_EXTENSION_URL,
          getTimingOccurrenceCapType: typeof mod.getTimingOccurrenceCap,
          occurrenceCapMax: mod.getTimingOccurrenceCap(
            mod.parseSig("1 tab po q4h prn pain max 3 doses daily").fhir.timing?.repeat
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
      timingFrequencyMinExtensionUrl: "https://solublelabs.com/fhir/StructureDefinition/medication-timing-frequency-min",
      timingActivityWindowExtensionUrl: "https://solublelabs.com/fhir/StructureDefinition/medication-timing-activity-window",
      timingOccurrenceCapExtensionUrl: "https://solublelabs.com/fhir/StructureDefinition/medication-timing-occurrence-cap",
      prnTriggerPhaseExtensionUrl: "https://solublelabs.com/fhir/StructureDefinition/medication-prn-trigger-phase",
      getTimingOccurrenceCapType: "function",
      occurrenceCapMax: 3,
      longText: "shake,rinse"
    });
  });

  it("publishes roundtrip-safe TH/EN realization through the built entrypoint", () => {
    const result = runNode(
      ["--input-type=module"],
      `
        const mod = await import("ezmedicationinput");
        const source = "หยอดตาขวาวันละ 4 ครั้ง เช้า กลางวัน เย็น ก่อนนอน";
        const parsed = mod.parseSig(source, { locale: "th" });
        const roundTripText = mod.formatSig(parsed.fhir, "long", {
          locale: "th",
          realizationMode: "roundtrip"
        });
        const reparsed = mod.parseSig(roundTripText, { locale: "th" });
        process.stdout.write(JSON.stringify({
          parseSigType: typeof mod.parseSig,
          formatSigType: typeof mod.formatSig,
          roundTripText,
          roundTripSiteCode: reparsed.fhir.site?.coding?.[0]?.code,
          roundTripFrequency: reparsed.fhir.timing?.repeat?.frequency,
          longText: reparsed.longText
        }));
      `
    );
    expect(result.roundTripText).toBe("หยอดวันละ 4 ครั้ง เช้า, เที่ยง, เย็น และ ก่อนนอน ที่ตาขวา.");
    expect(result.roundTripSiteCode).toBe("1290032005");
    expect(result.roundTripFrequency).toBe(4);
  });

});
