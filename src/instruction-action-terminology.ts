import source from "./instruction-action-terminology.json";
import {
  FhirCoding,
  MedicationInstructionActionDefinition,
  MedicationInstructionActionInput,
  ParseOptions
} from "./types";

export const MEDICATION_INSTRUCTION_ACTION_SYSTEM = source.system;

export interface MedicationInstructionActionCodeSystem {
  resourceType: "CodeSystem";
  url: string;
  name: string;
  title: string;
  status: "active";
  experimental: boolean;
  caseSensitive: boolean;
  content: "complete";
  concept: Array<{
    code: string;
    display: string;
    designation?: Array<{ language: string; value: string }>;
  }>;
}

interface ActionSource {
  code: string;
  semanticClass: string;
  display: string;
  i18n?: Record<string, string>;
  aliases?: string[];
  procedural?: boolean;
  acceptsAmount?: boolean;
  definesDose?: boolean;
  externalCodings?: FhirCoding[];
}

const DEFAULT_ACTIONS = (source.actions as ActionSource[]).map(normalizeDefinition);
const DEFAULT_BY_CODE = new Map<string, MedicationInstructionActionDefinition>();
const DEFAULT_BY_ALIAS = new Map<string, MedicationInstructionActionDefinition>();

for (const definition of DEFAULT_ACTIONS) {
  DEFAULT_BY_CODE.set(definition.code, definition);
  const aliases = [definition.code, definition.display, ...(definition.aliases ?? [])];
  for (const alias of aliases) {
    const normalized = normalizeActionSurface(alias);
    if (normalized && !DEFAULT_BY_ALIAS.has(normalized)) {
      DEFAULT_BY_ALIAS.set(normalized, definition);
    }
  }
}

export function normalizeActionSurface(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  return coding
    ? {
      system: coding.system,
      code: coding.code,
      display: coding.display,
      extension: coding.extension?.map((extension) => ({ ...extension })),
      _display: coding._display ? { ...coding._display } : undefined,
      i18n: coding.i18n ? { ...coding.i18n } : undefined
    }
    : undefined;
}

function cloneDefinition(
  definition: MedicationInstructionActionDefinition
): MedicationInstructionActionDefinition {
  return {
    code: definition.code,
    semanticClass: definition.semanticClass,
    display: definition.display,
    i18n: definition.i18n ? { ...definition.i18n } : undefined,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
    procedural: definition.procedural,
    acceptsAmount: definition.acceptsAmount,
    definesDose: definition.definesDose,
    coding: cloneCoding(definition.coding),
    externalCodings: definition.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function normalizeDefinition(sourceDefinition: ActionSource): MedicationInstructionActionDefinition {
  return {
    code: sourceDefinition.code,
    semanticClass: sourceDefinition.semanticClass,
    display: sourceDefinition.display,
    i18n: sourceDefinition.i18n ? { ...sourceDefinition.i18n } : undefined,
    aliases: sourceDefinition.aliases ? [...sourceDefinition.aliases] : undefined,
    procedural: sourceDefinition.procedural,
    acceptsAmount: sourceDefinition.acceptsAmount,
    definesDose: sourceDefinition.definesDose,
    externalCodings: sourceDefinition.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function normalizeCustomDefinition(
  surface: string,
  input: MedicationInstructionActionInput
): MedicationInstructionActionDefinition {
  const normalizedSurface = normalizeActionSurface(surface);
  const code = input.code?.trim() || normalizedSurface.replace(/\s+/g, "-");
  return {
    code,
    semanticClass: input.semanticClass?.trim() || "procedure",
    display: input.display?.trim() || surface.trim() || code,
    i18n: input.i18n ? { ...input.i18n } : undefined,
    aliases: Array.from(new Set([surface, ...(input.aliases ?? [])])),
    procedural: input.procedural ?? true,
    acceptsAmount: input.acceptsAmount,
    definesDose: input.definesDose,
    coding: cloneCoding(input.coding),
    externalCodings: input.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function customDefinitionForSurface(
  surface: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const map = options?.instructionActionMap;
  if (!map) return undefined;
  const target = normalizeActionSurface(surface);
  for (const configuredSurface of Object.keys(map)) {
    const input = map[configuredSurface];
    const candidates = [configuredSurface, input.code ?? "", ...(input.aliases ?? [])];
    if (candidates.some((candidate) => normalizeActionSurface(candidate) === target)) {
      return normalizeCustomDefinition(configuredSurface, input);
    }
  }
  return undefined;
}

export function resolveMedicationInstructionAction(
  surface: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const custom = customDefinitionForSurface(surface, options);
  if (custom) return custom;
  const definition = DEFAULT_BY_ALIAS.get(normalizeActionSurface(surface));
  return definition ? cloneDefinition(definition) : undefined;
}

export function getMedicationInstructionAction(
  code: string
): MedicationInstructionActionDefinition | undefined {
  const definition = DEFAULT_BY_CODE.get(code);
  return definition ? cloneDefinition(definition) : undefined;
}

export function listMedicationInstructionActions(): MedicationInstructionActionDefinition[] {
  return DEFAULT_ACTIONS.map(cloneDefinition);
}

export function buildMedicationInstructionActionCodeSystem(): MedicationInstructionActionCodeSystem {
  return {
    resourceType: "CodeSystem",
    url: MEDICATION_INSTRUCTION_ACTION_SYSTEM,
    name: "MedicationInstructionAction",
    title: "SolubleLabs Medication Instruction Action",
    status: "active",
    experimental: false,
    caseSensitive: true,
    content: "complete",
    concept: DEFAULT_ACTIONS.map((definition) => ({
      code: definition.code,
      display: definition.display,
      designation: Object.keys(definition.i18n ?? {}).map((language) => ({
        language,
        value: definition.i18n?.[language] ?? ""
      })).filter((designation) => designation.value.length > 0)
    }))
  };
}

export function medicationInstructionActionCoding(
  definition: MedicationInstructionActionDefinition
): FhirCoding {
  return definition.coding
    ? cloneCoding(definition.coding)!
    : {
      system: MEDICATION_INSTRUCTION_ACTION_SYSTEM,
      code: definition.code,
      display: definition.display,
      i18n: definition.i18n ? { ...definition.i18n } : undefined
    };
}

export function medicationInstructionActionCodings(
  definition: MedicationInstructionActionDefinition
): FhirCoding[] {
  return [
    medicationInstructionActionCoding(definition),
    ...(definition.externalCodings ?? []).map((coding) => cloneCoding(coding)!)
  ];
}
