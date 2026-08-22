import source from "./instruction-concept-terminology.json";
import {
  AdviceArgumentRole,
  FhirCoding,
  MedicationInstructionConceptDefinition,
  MedicationInstructionConceptInput,
  ParseOptions
} from "./types";

export const MEDICATION_INSTRUCTION_CONCEPT_SYSTEM = source.system;

export interface MedicationInstructionConceptCodeSystem {
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

interface ConceptSource {
  code: string;
  role: AdviceArgumentRole;
  display: string;
  i18n?: Record<string, string>;
  aliases?: string[];
  externalCodings?: FhirCoding[];
}

const DEFAULT_CONCEPTS = (source.concepts as ConceptSource[]).map(normalizeDefinition);
const DEFAULT_BY_CODE = new Map<string, MedicationInstructionConceptDefinition>();
const DEFAULT_BY_ALIAS = new Map<string, MedicationInstructionConceptDefinition>();

for (const definition of DEFAULT_CONCEPTS) {
  DEFAULT_BY_CODE.set(definition.code, definition);
  for (const alias of [definition.code, definition.display, ...(definition.aliases ?? [])]) {
    const normalized = normalizeConceptSurface(alias);
    if (normalized && !DEFAULT_BY_ALIAS.has(normalized)) DEFAULT_BY_ALIAS.set(normalized, definition);
  }
}

export function normalizeConceptSurface(value: string): string {
  return value.trim().toLowerCase().replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
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
  definition: MedicationInstructionConceptDefinition
): MedicationInstructionConceptDefinition {
  return {
    code: definition.code,
    role: definition.role,
    display: definition.display,
    i18n: definition.i18n ? { ...definition.i18n } : undefined,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
    coding: cloneCoding(definition.coding),
    externalCodings: definition.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function normalizeDefinition(sourceDefinition: ConceptSource): MedicationInstructionConceptDefinition {
  return {
    code: sourceDefinition.code,
    role: sourceDefinition.role,
    display: sourceDefinition.display,
    i18n: sourceDefinition.i18n ? { ...sourceDefinition.i18n } : undefined,
    aliases: sourceDefinition.aliases ? [...sourceDefinition.aliases] : undefined,
    externalCodings: sourceDefinition.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function normalizeCustomDefinition(
  surface: string,
  input: MedicationInstructionConceptInput
): MedicationInstructionConceptDefinition {
  const normalizedSurface = normalizeConceptSurface(surface);
  return {
    code: input.code?.trim() || normalizedSurface.replace(/\s+/g, "-"),
    role: input.role ?? AdviceArgumentRole.Free,
    display: input.display?.trim() || surface.trim() || normalizedSurface,
    i18n: input.i18n ? { ...input.i18n } : undefined,
    aliases: Array.from(new Set([surface, ...(input.aliases ?? [])])),
    coding: cloneCoding(input.coding),
    externalCodings: input.externalCodings?.map((coding) => cloneCoding(coding)!)
  };
}

function customDefinitionForSurface(
  surface: string,
  options?: ParseOptions
): MedicationInstructionConceptDefinition | undefined {
  const map = options?.instructionConceptMap;
  if (!map) return undefined;
  const target = normalizeConceptSurface(surface);
  for (const configuredSurface of Object.keys(map)) {
    const input = map[configuredSurface];
    const candidates = [configuredSurface, input.code ?? "", ...(input.aliases ?? [])];
    if (candidates.some((candidate) => normalizeConceptSurface(candidate) === target)) {
      return normalizeCustomDefinition(configuredSurface, input);
    }
  }
  return undefined;
}

export function resolveMedicationInstructionConcept(
  surface: string,
  options?: ParseOptions
): MedicationInstructionConceptDefinition | undefined {
  const custom = customDefinitionForSurface(surface, options);
  if (custom) return custom;
  const definition = DEFAULT_BY_ALIAS.get(normalizeConceptSurface(surface));
  return definition ? cloneDefinition(definition) : undefined;
}

export function getMedicationInstructionConcept(
  code: string
): MedicationInstructionConceptDefinition | undefined {
  const definition = DEFAULT_BY_CODE.get(code);
  return definition ? cloneDefinition(definition) : undefined;
}

export function listMedicationInstructionConcepts(): MedicationInstructionConceptDefinition[] {
  return DEFAULT_CONCEPTS.map(cloneDefinition);
}

export function buildMedicationInstructionConceptCodeSystem(): MedicationInstructionConceptCodeSystem {
  return {
    resourceType: "CodeSystem",
    url: MEDICATION_INSTRUCTION_CONCEPT_SYSTEM,
    name: "MedicationInstructionConcept",
    title: "SolubleLabs Medication Instruction Concept",
    status: "active",
    experimental: false,
    caseSensitive: true,
    content: "complete",
    concept: DEFAULT_CONCEPTS.map((definition) => ({
      code: definition.code,
      display: definition.display,
      designation: Object.keys(definition.i18n ?? {}).map((language) => ({
        language,
        value: definition.i18n?.[language] ?? ""
      })).filter((designation) => designation.value.length > 0)
    }))
  };
}

export function medicationInstructionConceptCodings(
  definition: MedicationInstructionConceptDefinition
): FhirCoding[] {
  const primary = definition.coding
    ? cloneCoding(definition.coding)!
    : {
      system: MEDICATION_INSTRUCTION_CONCEPT_SYSTEM,
      code: definition.code,
      display: definition.display,
      i18n: definition.i18n ? { ...definition.i18n } : undefined
    };
  return [primary, ...(definition.externalCodings ?? []).map((coding) => cloneCoding(coding)!)];
}
