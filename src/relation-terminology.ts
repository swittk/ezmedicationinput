import source from "./relation-terminology.json";
import { AdviceRelation, FhirCoding } from "./types";

type SupportedLocale = "en" | "th";
const BODY_SITE_LOCATIVE_RELATION_VALUES = [
  "above", "around", "behind", "below", "beneath", "under",
  "inside", "near", "outside", "between", "along"
] as const;
export type BodySiteLocativeRelation = typeof BODY_SITE_LOCATIVE_RELATION_VALUES[number];
const BODY_SITE_LOCATIVE_RELATION_VALUE_SET: ReadonlySet<string> =
  new Set<string>(BODY_SITE_LOCATIVE_RELATION_VALUES);

function isBodySiteLocativeRelation(value: string): value is BodySiteLocativeRelation {
  return BODY_SITE_LOCATIVE_RELATION_VALUE_SET.has(value);
}
export type BodySiteRelationRenderStrategy = "prefix" | "partitive" | "suffix";

export interface RelationLocaleLexeme {
  surface: string;
  canonical: string;
  splitPrefix?: boolean;
  /** Preferred semantic relation when a locale surface is lexically ambiguous. */
  defaultForAmbiguousSurface?: boolean;
}


export interface AdviceRelationGrammarFeatures {
  preposedAction?: boolean;
  conditionScope?: boolean;
  conditionalTail?: boolean;
  detectInActionGap?: boolean;
  timeComplement?: boolean;
  rinseTimeComplement?: boolean;
  durationComplement?: boolean;
  activityFallback?: boolean;
  includeDuration?: boolean;
  negatedObjectAttachment?: boolean;
  negatedRelationTarget?: boolean;
  accompanimentComplement?: boolean;
  directTimeRealization?: boolean;
  timeRealizationProfile?: string;
  symptomOnsetPrnLead?: boolean;
  roundtripRichRelation?: boolean;
  mealStateComplement?: boolean;
  workflowStart?: boolean;
  workflowActionLead?: boolean;
  conditionalInstructionExclusive?: boolean;
  durationLead?: boolean;
  instructionStart?: boolean;
  freeTextDirectiveStart?: boolean;
  defaultSequenceRelation?: boolean;
  defaultSiteRelation?: boolean;
}

export interface AdviceRelationDefinition {
  relation: AdviceRelation;
  semanticClass: string;
  grammar: AdviceRelationGrammarFeatures;
  actionSurfaces: string[];
  adviceSurfaces: string[];
  sequenceMarkerSurfaces: string[];
  sequenceRelationSurfaces: string[];
  localeLexemes: Partial<Record<SupportedLocale, RelationLocaleLexeme[]>>;
  realization: Record<SupportedLocale, string>;
  realizationProfiles: Record<string, Partial<Record<SupportedLocale, string>>>;
}

export interface BodySiteRelationGrammarFeatures {
  externalSiteLocativePrefix?: boolean;
  qualifierTarget?: "symptom" | "site";
}

export interface BodySiteRelationRealization {
  surface: string;
  strategy: BodySiteRelationRenderStrategy;
  article?: "the" | "none";
  omitOuterSitePreposition?: boolean;
}

export interface BodySiteRelationDefinition {
  canonical: string;
  aliases: string[];
  locative: boolean;
  grammar: BodySiteRelationGrammarFeatures;
  localeLexemes: Partial<Record<SupportedLocale, RelationLocaleLexeme[]>>;
  coding?: FhirCoding;
  realization: Partial<Record<SupportedLocale, BodySiteRelationRealization>>;
}

interface SourceAdviceRelation {
  relation: string;
  semanticClass?: string;
  grammar?: AdviceRelationGrammarFeatures;
  actionSurfaces?: string[];
  adviceSurfaces?: string[];
  sequenceMarkerSurfaces?: string[];
  sequenceRelationSurfaces?: string[];
  localeLexemes?: Partial<Record<SupportedLocale, RelationLocaleLexeme[]>>;
  realization?: Partial<Record<SupportedLocale, string>>;
  realizationProfiles?: Record<string, Partial<Record<SupportedLocale, string>>>;
}

interface SourceBodySiteRelation {
  canonical: string;
  aliases?: string[];
  locative?: boolean;
  grammar?: BodySiteRelationGrammarFeatures;
  localeLexemes?: Partial<Record<SupportedLocale, RelationLocaleLexeme[]>>;
  coding?: FhirCoding;
  realization?: Partial<Record<SupportedLocale, BodySiteRelationRealization>>;
}

interface RelationTerminologySource {
  adviceRelations?: SourceAdviceRelation[];
  bodySiteRelations?: SourceBodySiteRelation[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function localeKey(locale: string): SupportedLocale {
  return locale.toLowerCase().startsWith("th") ? "th" : "en";
}

const ADVICE_RELATION_VALUES = new Set<string>();
for (const key in AdviceRelation) {
  if (Object.prototype.hasOwnProperty.call(AdviceRelation, key)) {
    ADVICE_RELATION_VALUES.add(AdviceRelation[key as keyof typeof AdviceRelation]);
  }
}
function asAdviceRelation(value: string): AdviceRelation {
  if (!ADVICE_RELATION_VALUES.has(value)) {
    throw new Error(`Invalid declarative AdviceRelation: ${value}`);
  }
  return value as AdviceRelation;
}

function cloneCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  return coding ? { ...coding, i18n: coding.i18n ? { ...coding.i18n } : undefined } : undefined;
}

function cloneRealizationProfiles(
  profiles: Record<string, Partial<Record<SupportedLocale, string>>> | undefined
): Record<string, Partial<Record<SupportedLocale, string>>> {
  const result: Record<string, Partial<Record<SupportedLocale, string>>> = {};
  for (const profile in profiles ?? {}) {
    if (Object.prototype.hasOwnProperty.call(profiles, profile)) {
      result[profile] = { ...(profiles?.[profile] ?? {}) };
    }
  }
  return result;
}

const rawSource = source as RelationTerminologySource;
const ADVICE_DEFINITIONS: AdviceRelationDefinition[] = (rawSource.adviceRelations ?? []).map((entry) => {
  const relation = asAdviceRelation(entry.relation);
  const en = entry.realization?.en ?? relation;
  const th = entry.realization?.th;
  if (!th) throw new Error(`Missing Thai realization for AdviceRelation ${relation}`);
  return {
    relation,
    semanticClass: entry.semanticClass?.trim() || "relation",
    grammar: { ...(entry.grammar ?? {}) },
    actionSurfaces: [...(entry.actionSurfaces ?? [])],
    adviceSurfaces: [...(entry.adviceSurfaces ?? [])],
    sequenceMarkerSurfaces: [...(entry.sequenceMarkerSurfaces ?? [])],
    sequenceRelationSurfaces: [...(entry.sequenceRelationSurfaces ?? [])],
    localeLexemes: {
      en: entry.localeLexemes?.en?.map((lexeme) => ({ ...lexeme })),
      th: entry.localeLexemes?.th?.map((lexeme) => ({ ...lexeme }))
    },
    realization: { en, th },
    realizationProfiles: cloneRealizationProfiles(entry.realizationProfiles)
  };
});

const ADVICE_BY_RELATION = new Map<AdviceRelation, AdviceRelationDefinition>();
const ACTION_RELATION_INDEX = new Map<string, AdviceRelation[]>();
const ADVICE_RELATION_BY_SURFACE = new Map<string, AdviceRelation>();
const ACTION_SEQUENCE_MARKERS_INTERNAL = new Set<string>();
const ACTION_SEQUENCE_RELATION_SURFACES_INTERNAL = new Set<string>();
const LOCALE_LEXEMES: Record<SupportedLocale, Map<string, RelationLocaleLexeme[]>> = {
  en: new Map(),
  th: new Map()
};

function pushRelationCandidate(
  index: Map<string, AdviceRelation[]>,
  surface: string,
  relation: AdviceRelation
): void {
  const key = normalize(surface);
  const existing = index.get(key);
  if (existing) {
    if (existing.indexOf(relation) === -1) existing.push(relation);
  } else {
    index.set(key, [relation]);
  }
}

function registerLocaleLexeme(
  locale: SupportedLocale,
  lexeme: RelationLocaleLexeme
): RelationLocaleLexeme {
  const key = normalize(lexeme.surface);
  const normalizedLexeme = {
    ...lexeme,
    surface: key,
    canonical: normalize(lexeme.canonical)
  };
  const existing = LOCALE_LEXEMES[locale].get(key);
  if (existing) {
    if (!existing.some((candidate) =>
      candidate.canonical === normalizedLexeme.canonical &&
      candidate.defaultForAmbiguousSurface === normalizedLexeme.defaultForAmbiguousSurface
    )) existing.push(normalizedLexeme);
  } else {
    LOCALE_LEXEMES[locale].set(key, [normalizedLexeme]);
  }
  return normalizedLexeme;
}

for (const definition of ADVICE_DEFINITIONS) {
  if (ADVICE_BY_RELATION.has(definition.relation)) throw new Error(`Duplicate AdviceRelation ${definition.relation}`);
  ADVICE_BY_RELATION.set(definition.relation, definition);
  for (const surface of definition.actionSurfaces) {
    pushRelationCandidate(ACTION_RELATION_INDEX, surface, definition.relation);
  }
  for (const surface of definition.adviceSurfaces) ADVICE_RELATION_BY_SURFACE.set(normalize(surface), definition.relation);
  for (const surface of definition.sequenceMarkerSurfaces) ACTION_SEQUENCE_MARKERS_INTERNAL.add(normalize(surface));
  for (const surface of definition.sequenceRelationSurfaces) ACTION_SEQUENCE_RELATION_SURFACES_INTERNAL.add(normalize(surface));
  for (const locale of ["en", "th"] as const) {
    for (const lexeme of definition.localeLexemes[locale] ?? []) {
      const normalizedLexeme = registerLocaleLexeme(locale, lexeme);
      if (definition.actionSurfaces.length) {
        pushRelationCandidate(ACTION_RELATION_INDEX, normalizedLexeme.surface, definition.relation);
      }
      if (definition.adviceSurfaces.length) {
        ADVICE_RELATION_BY_SURFACE.set(normalizedLexeme.surface, definition.relation);
      }
    }
  }
}

for (const relation of ADVICE_RELATION_VALUES) {
  if (!ADVICE_BY_RELATION.has(relation as AdviceRelation)) {
    throw new Error(`Missing declarative AdviceRelation ${relation}`);
  }
}

export const ACTION_SEQUENCE_MARKERS: ReadonlySet<string> = ACTION_SEQUENCE_MARKERS_INTERNAL;
export const ACTION_SEQUENCE_RELATION_SURFACES: ReadonlySet<string> =
  ACTION_SEQUENCE_RELATION_SURFACES_INTERNAL;

export function resolveActionRelationSurfaceCandidates(surface: string): readonly AdviceRelation[] {
  return ACTION_RELATION_INDEX.get(normalize(surface)) ?? [];
}

export function resolveActionRelationSurface(
  surface: string,
  preferredSemanticClasses?: readonly string[]
): AdviceRelation | undefined {
  const normalized = normalize(surface);
  const candidates = ACTION_RELATION_INDEX.get(normalized) ?? [];
  if (!candidates.length) return undefined;
  for (const semanticClass of preferredSemanticClasses ?? []) {
    const preferred = candidates.find((candidate) =>
      ADVICE_BY_RELATION.get(candidate)?.semanticClass === semanticClass
    );
    if (preferred) return preferred;
  }
  if (candidates.length === 1) return candidates[0];
  const localeCandidates = ["en", "th"]
    .map((locale) => LOCALE_LEXEMES[locale as SupportedLocale].get(normalized) ?? [])
    .reduce((all, values) => all.concat(values), [] as RelationLocaleLexeme[]);
  const preferredCanonical = localeCandidates.find((lexeme) => lexeme.defaultForAmbiguousSurface)?.canonical;
  if (preferredCanonical) {
    const preferred = candidates.find((candidate) => candidate === preferredCanonical);
    if (preferred) return preferred;
  }
  return candidates[0];
}

export function resolveActionRelationSurfaceByGrammarFeature(
  surface: string,
  feature: keyof AdviceRelationGrammarFeatures
): AdviceRelation | undefined {
  const candidates = ACTION_RELATION_INDEX.get(normalize(surface)) ?? [];
  return candidates.find((candidate) => relationHasGrammarFeature(candidate, feature));
}

export function resolveAdviceRelationSurface(surface: string): AdviceRelation | undefined {
  return ADVICE_RELATION_BY_SURFACE.get(normalize(surface));
}

export function getAdviceRelationDefinition(
  relation: AdviceRelation
): AdviceRelationDefinition | undefined {
  const definition = ADVICE_BY_RELATION.get(relation);
  if (!definition) return undefined;
  return {
    ...definition,
    grammar: { ...definition.grammar },
    actionSurfaces: [...definition.actionSurfaces],
    adviceSurfaces: [...definition.adviceSurfaces],
    sequenceMarkerSurfaces: [...definition.sequenceMarkerSurfaces],
    sequenceRelationSurfaces: [...definition.sequenceRelationSurfaces],
    localeLexemes: {
      en: definition.localeLexemes.en?.map((lexeme) => ({ ...lexeme })),
      th: definition.localeLexemes.th?.map((lexeme) => ({ ...lexeme }))
    },
    realization: { ...definition.realization },
    realizationProfiles: cloneRealizationProfiles(definition.realizationProfiles)
  };
}

export function relationHasGrammarFeature(
  relation: AdviceRelation | undefined,
  feature: keyof AdviceRelationGrammarFeatures
): boolean {
  return Boolean(relation && ADVICE_BY_RELATION.get(relation)?.grammar[feature]);
}

const UNIQUE_GRAMMAR_RELATION_CACHE = new Map<keyof AdviceRelationGrammarFeatures, AdviceRelation | null>();

export function getUniqueAdviceRelationByGrammarFeature(
  feature: keyof AdviceRelationGrammarFeatures
): AdviceRelation | undefined {
  const cached = UNIQUE_GRAMMAR_RELATION_CACHE.get(feature);
  if (cached !== undefined) return cached ?? undefined;
  let matched: AdviceRelation | undefined;
  for (const definition of ADVICE_DEFINITIONS) {
    if (!definition.grammar[feature]) continue;
    if (matched !== undefined) {
      throw new Error(`Multiple AdviceRelations declare unique grammar feature ${feature}`);
    }
    matched = definition.relation;
  }
  UNIQUE_GRAMMAR_RELATION_CACHE.set(feature, matched ?? null);
  return matched;
}

export function relationHasSemanticClass(
  relation: AdviceRelation | undefined,
  semanticClass: string
): boolean {
  return Boolean(relation && ADVICE_BY_RELATION.get(relation)?.semanticClass === semanticClass);
}

const ADVICE_RELATION_SURFACE_CACHE = new Map<AdviceRelation, readonly string[]>();

export function getAdviceRelationSurfaceForms(relation: AdviceRelation): readonly string[] {
  const cached = ADVICE_RELATION_SURFACE_CACHE.get(relation);
  if (cached) return cached;
  const definition = ADVICE_BY_RELATION.get(relation);
  if (!definition) return [];
  const values = new Set<string>();
  values.add(relation);
  for (const surface of definition.actionSurfaces) values.add(surface);
  for (const surface of definition.adviceSurfaces) values.add(surface);
  for (const surface of definition.sequenceMarkerSurfaces) values.add(surface);
  for (const surface of definition.sequenceRelationSurfaces) values.add(surface);
  for (const locale of ["en", "th"] as const) {
    values.add(definition.realization[locale]);
    for (const lexeme of definition.localeLexemes[locale] ?? []) values.add(lexeme.surface);
  }
  for (const profile in definition.realizationProfiles) {
    if (!Object.prototype.hasOwnProperty.call(definition.realizationProfiles, profile)) continue;
    const valuesByLocale = definition.realizationProfiles[profile];
    if (valuesByLocale.en) values.add(valuesByLocale.en);
    if (valuesByLocale.th) values.add(valuesByLocale.th);
  }
  const surfaces = Array.from(values)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  ADVICE_RELATION_SURFACE_CACHE.set(relation, surfaces);
  return surfaces;
}

export function localizeAdviceRelation(
  relation: AdviceRelation | undefined,
  locale: string,
  profile = "default"
): string | undefined {
  if (!relation) return undefined;
  const definition = ADVICE_BY_RELATION.get(relation);
  const language = localeKey(locale);
  return definition?.realizationProfiles[profile]?.[language] ??
    definition?.realization[language] ??
    relation;
}

export function listAdviceRelationDefinitions(): AdviceRelationDefinition[] {
  return ADVICE_DEFINITIONS.map((definition) => ({
    ...definition,
    grammar: { ...definition.grammar },
    actionSurfaces: [...definition.actionSurfaces],
    adviceSurfaces: [...definition.adviceSurfaces],
    sequenceMarkerSurfaces: [...definition.sequenceMarkerSurfaces],
    sequenceRelationSurfaces: [...definition.sequenceRelationSurfaces],
    localeLexemes: {
      en: definition.localeLexemes.en?.map((lexeme) => ({ ...lexeme })),
      th: definition.localeLexemes.th?.map((lexeme) => ({ ...lexeme }))
    },
    realization: { ...definition.realization },
    realizationProfiles: cloneRealizationProfiles(definition.realizationProfiles)
  }));
}

const BODY_SITE_DEFINITIONS: BodySiteRelationDefinition[] = (rawSource.bodySiteRelations ?? []).map((entry) => ({
  canonical: normalize(entry.canonical),
  aliases: Array.from(new Set([entry.canonical, ...(entry.aliases ?? [])].map(normalize))),
  locative: entry.locative === true,
  grammar: { ...(entry.grammar ?? {}) },
  localeLexemes: {
    en: entry.localeLexemes?.en?.map((lexeme) => ({ ...lexeme })),
    th: entry.localeLexemes?.th?.map((lexeme) => ({ ...lexeme }))
  },
  coding: cloneCoding(entry.coding),
  realization: {
    en: entry.realization?.en ? { ...entry.realization.en } : undefined,
    th: entry.realization?.th ? { ...entry.realization.th } : undefined
  }
}));

const BODY_SITE_BY_SURFACE = new Map<string, BodySiteRelationDefinition>();
const BODY_SITE_BY_CANONICAL = new Map<string, BodySiteRelationDefinition>();
const BODY_SITE_LOCATIVE_RELATIONS_INTERNAL = new Set<BodySiteLocativeRelation>();
const BODY_SITE_LOCATIVE_RELATION_ALIASES_INTERNAL = new Map<string, string>();
const BODY_SITE_LOCATIVE_RELATION_PHRASES_INTERNAL = new Map<string, string>();
const BODY_SITE_SPATIAL_RELATION_CODINGS_INTERNAL = new Map<string, FhirCoding>();
const BODY_SITE_LOCATIVE_LEAD_TOKENS_INTERNAL = new Set<string>();

for (const definition of BODY_SITE_DEFINITIONS) {
  if (BODY_SITE_BY_CANONICAL.has(definition.canonical)) throw new Error(`Duplicate body-site relation ${definition.canonical}`);
  BODY_SITE_BY_CANONICAL.set(definition.canonical, definition);
  if (definition.locative) {
    if (!isBodySiteLocativeRelation(definition.canonical)) {
      throw new Error(`Invalid locative body-site relation canonical: ${definition.canonical}`);
    }
    BODY_SITE_LOCATIVE_RELATIONS_INTERNAL.add(definition.canonical);
  }
  for (const alias of definition.aliases) {
    const existing = BODY_SITE_BY_SURFACE.get(alias);
    if (existing && existing.canonical !== definition.canonical) throw new Error(`Conflicting body-site relation alias ${alias}`);
    BODY_SITE_BY_SURFACE.set(alias, definition);
    if (definition.locative) {
      const parts = alias.split(/\s+/u);
      BODY_SITE_LOCATIVE_LEAD_TOKENS_INTERNAL.add(parts[0]);
      if (parts.length === 1) BODY_SITE_LOCATIVE_RELATION_ALIASES_INTERNAL.set(alias, definition.canonical);
      else BODY_SITE_LOCATIVE_RELATION_PHRASES_INTERNAL.set(alias, definition.canonical);
    }
    if (definition.coding) BODY_SITE_SPATIAL_RELATION_CODINGS_INTERNAL.set(alias, cloneCoding(definition.coding)!);
  }
  if (definition.coding) BODY_SITE_SPATIAL_RELATION_CODINGS_INTERNAL.set(definition.canonical, cloneCoding(definition.coding)!);
  for (const locale of ["en", "th"] as const) {
    for (const lexeme of definition.localeLexemes[locale] ?? []) {
      registerLocaleLexeme(locale, lexeme);
    }
  }
}

const ADVICE_GRAMMAR_CANONICAL_SET_CACHE = new Map<
  keyof AdviceRelationGrammarFeatures,
  ReadonlySet<string>
>();

export function getAdviceRelationCanonicalSetByGrammarFeature(
  feature: keyof AdviceRelationGrammarFeatures
): ReadonlySet<string> {
  const cached = ADVICE_GRAMMAR_CANONICAL_SET_CACHE.get(feature);
  if (cached) return cached;
  const result = new Set<string>();
  for (const definition of ADVICE_DEFINITIONS) {
    if (definition.grammar[feature]) result.add(definition.relation);
  }
  ADVICE_GRAMMAR_CANONICAL_SET_CACHE.set(feature, result);
  return result;
}

const BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES_INTERNAL = new Set<string>();
for (const definition of BODY_SITE_DEFINITIONS) {
  if (!definition.grammar.externalSiteLocativePrefix) continue;
  for (const alias of definition.aliases) BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES_INTERNAL.add(alias);
}

export const BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES: ReadonlySet<string> =
  BODY_SITE_EXTERNAL_LOCATIVE_PREFIXES_INTERNAL;
export const BODY_SITE_LOCATIVE_RELATIONS: ReadonlySet<BodySiteLocativeRelation> =
  BODY_SITE_LOCATIVE_RELATIONS_INTERNAL;
export const BODY_SITE_LOCATIVE_RELATION_ALIASES: ReadonlyMap<string, string> =
  BODY_SITE_LOCATIVE_RELATION_ALIASES_INTERNAL;
export const BODY_SITE_LOCATIVE_RELATION_PHRASES: ReadonlyMap<string, string> =
  BODY_SITE_LOCATIVE_RELATION_PHRASES_INTERNAL;
export const BODY_SITE_SPATIAL_RELATION_CODINGS: ReadonlyMap<string, FhirCoding> =
  BODY_SITE_SPATIAL_RELATION_CODINGS_INTERNAL;
export const BODY_SITE_LOCATIVE_LEAD_TOKENS: ReadonlySet<string> =
  BODY_SITE_LOCATIVE_LEAD_TOKENS_INTERNAL;

export function normalizeBodySiteRelation(value: string): string | undefined {
  return BODY_SITE_BY_SURFACE.get(normalize(value))?.canonical ?? BODY_SITE_BY_CANONICAL.get(normalize(value))?.canonical;
}

export function getBodySiteRelationDefinition(value: string): BodySiteRelationDefinition | undefined {
  const definition = BODY_SITE_BY_SURFACE.get(normalize(value)) ?? BODY_SITE_BY_CANONICAL.get(normalize(value));
  if (!definition) return undefined;
  return {
    ...definition,
    aliases: [...definition.aliases],
    grammar: { ...definition.grammar },
    coding: cloneCoding(definition.coding),
    localeLexemes: {
      en: definition.localeLexemes.en?.map((lexeme) => ({ ...lexeme })),
      th: definition.localeLexemes.th?.map((lexeme) => ({ ...lexeme }))
    },
    realization: {
      en: definition.realization.en ? { ...definition.realization.en } : undefined,
      th: definition.realization.th ? { ...definition.realization.th } : undefined
    }
  };
}

export function getBodySiteRelationRealization(value: string, locale: string): BodySiteRelationRealization | undefined {
  const definition = BODY_SITE_BY_SURFACE.get(normalize(value)) ?? BODY_SITE_BY_CANONICAL.get(normalize(value));
  const realization = definition?.realization[localeKey(locale)];
  return realization ? { ...realization } : undefined;
}

export function listBodySiteRelationDefinitions(): BodySiteRelationDefinition[] {
  return BODY_SITE_DEFINITIONS.map((definition) => getBodySiteRelationDefinition(definition.canonical)!);
}

export function getRelationLocaleLexemeAliases(locale: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [surface, candidates] of LOCALE_LEXEMES[localeKey(locale)]) {
    const canonicals = Array.from(new Set(candidates.map((candidate) => candidate.canonical)));
    if (canonicals.length === 1) result.set(surface, canonicals[0]);
  }
  return result;
}

export function getRelationLocaleSuggestionLexemes(locale: string): RelationLocaleLexeme[] {
  const result: RelationLocaleLexeme[] = [];
  for (const [surface, candidates] of LOCALE_LEXEMES[localeKey(locale)]) {
    const preferred = candidates.find((candidate) => candidate.defaultForAmbiguousSurface) ?? candidates[0];
    if (preferred) result.push({ ...preferred, surface });
  }
  return result;
}

export function getRelationLocalePhrases(locale: string): Array<{ parts: string[]; canonical: string }> {
  const phrases: Array<{ parts: string[]; canonical: string }> = [];
  for (const [surface, candidates] of LOCALE_LEXEMES[localeKey(locale)]) {
    if (!/\s/u.test(surface)) continue;
    const canonicals = Array.from(new Set(candidates.map((candidate) => candidate.canonical)));
    if (canonicals.length !== 1) continue;
    phrases.push({ parts: surface.split(/\s+/u), canonical: canonicals[0] });
  }
  return phrases.sort((left, right) => right.parts.length - left.parts.length);
}

export function getRelationSplitPrefixes(locale: string): string[] {
  const result = new Set<string>();
  for (const [surface, candidates] of LOCALE_LEXEMES[localeKey(locale)]) {
    if (!/\s/u.test(surface) && candidates.some((candidate) => candidate.splitPrefix)) {
      result.add(surface);
    }
  }
  return Array.from(result).sort((left, right) => right.length - left.length);
}
