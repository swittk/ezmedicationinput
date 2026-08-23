import source from "./symptom-terminology.json";
import { FhirCoding, SymptomDefinition } from "./types";
import { normalizeLoosePhraseKey } from "./utils/text";

interface SymptomSource {
  names: string[];
  definition: SymptomDefinition;
}

export interface SymptomDictionaryEntry {
  canonical: string;
  definition: SymptomDefinition;
  terms: string[];
}

const DEFAULT_SYMPTOM_SOURCE = source.symptoms as SymptomSource[];

export function normalizeSymptomKey(value: string): string {
  return normalizeLoosePhraseKey(value);
}

function cloneCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  return coding ? {
    ...coding,
    extension: coding.extension?.map((extension) => ({ ...extension })),
    _display: coding._display ? { ...coding._display } : undefined,
    i18n: coding.i18n ? { ...coding.i18n } : undefined
  } : undefined;
}

function cloneDefinition(definition: SymptomDefinition): SymptomDefinition {
  return {
    coding: cloneCoding(definition.coding),
    text: definition.text,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
    i18n: definition.i18n ? { ...definition.i18n } : undefined,
    conditionI18n: definition.conditionI18n ? { ...definition.conditionI18n } : undefined
  };
}

export const DEFAULT_SYMPTOM_ENTRIES: SymptomDictionaryEntry[] =
  DEFAULT_SYMPTOM_SOURCE.map((symptom) => {
    const canonicalTerm =
      symptom.definition.text ?? symptom.definition.coding?.display ?? symptom.names[0];
    const terms: string[] = [];
    const seen = new Set<string>();
    const pushTerm = (value: string | undefined): void => {
      if (!value) return;
      const key = normalizeSymptomKey(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      terms.push(value);
    };

    for (const name of symptom.names) pushTerm(name);
    for (const alias of symptom.definition.aliases ?? []) pushTerm(alias);
    for (const locale in symptom.definition.i18n ?? {}) {
      if (Object.prototype.hasOwnProperty.call(symptom.definition.i18n, locale)) {
        pushTerm(symptom.definition.i18n?.[locale]);
      }
    }
    for (const locale in symptom.definition.conditionI18n ?? {}) {
      if (Object.prototype.hasOwnProperty.call(symptom.definition.conditionI18n, locale)) {
        pushTerm(symptom.definition.conditionI18n?.[locale]);
      }
    }

    return {
      canonical: normalizeSymptomKey(canonicalTerm ?? ""),
      definition: symptom.definition,
      terms
    };
  });

export const DEFAULT_SYMPTOM_DEFINITIONS: Record<string, SymptomDefinition> = (() => {
  const definitions: Record<string, SymptomDefinition> = {};
  for (const entry of DEFAULT_SYMPTOM_ENTRIES) {
    for (const term of entry.terms) {
      const key = normalizeSymptomKey(term);
      if (key) definitions[key] = entry.definition;
    }
  }
  return definitions;
})();

function resolveSymptomDefinitionFromMap(
  surface: string,
  map: Record<string, SymptomDefinition> | undefined
): SymptomDefinition | undefined {
  if (!map) return undefined;
  const target = normalizeSymptomKey(surface);
  for (const configuredSurface in map) {
    if (!Object.prototype.hasOwnProperty.call(map, configuredSurface)) continue;
    const definition = map[configuredSurface];
    const surfaces = [
      configuredSurface,
      definition.text,
      ...(definition.aliases ?? []),
      ...Object.keys(definition.i18n ?? {}).map((locale) => definition.i18n?.[locale]),
      ...Object.keys(definition.conditionI18n ?? {}).map((locale) => definition.conditionI18n?.[locale])
    ];
    if (surfaces.some((candidate) => candidate && normalizeSymptomKey(candidate) === target)) {
      return cloneDefinition(definition);
    }
  }
  return undefined;
}

export function resolveSymptomDefinition(
  surface: string,
  ...customMaps: Array<Record<string, SymptomDefinition> | undefined>
): SymptomDefinition | undefined {
  for (const map of customMaps) {
    const custom = resolveSymptomDefinitionFromMap(surface, map);
    if (custom) return custom;
  }
  const definition = DEFAULT_SYMPTOM_DEFINITIONS[normalizeSymptomKey(surface)];
  return definition ? cloneDefinition(definition) : undefined;
}

export function findSymptomDefinitionByCoding(
  system: string,
  code: string
): SymptomDefinition | undefined {
  const definition = DEFAULT_SYMPTOM_SOURCE.find((symptom) =>
    symptom.definition.coding?.system === system && symptom.definition.coding?.code === code
  )?.definition;
  return definition ? cloneDefinition(definition) : undefined;
}

export function listSymptomDefinitions(): SymptomDefinition[] {
  return DEFAULT_SYMPTOM_SOURCE.map((symptom) => cloneDefinition(symptom.definition));
}
