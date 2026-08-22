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
  timingFrequencyMinExtensionUrl?: string;
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
          timingFrequencyMinExtensionUrl: mod.TIMING_FREQUENCY_MIN_EXTENSION_URL,
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
      timingFrequencyMinExtensionUrl: "https://solublelabs.com/fhir/StructureDefinition/medication-timing-frequency-min",
      longText: "shake,rinse"
    });
  });

});
