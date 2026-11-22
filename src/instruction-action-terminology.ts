import source from "./instruction-action-terminology.json";
import { localizedConfig } from "./localization";
import { shouldJoinAdjacentSourceTokens } from "./locale-detection";
import { SNOMED_SYSTEM } from "./snomed";
import {
  AdviceArgument,
  CanonicalMethodExpr,
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
  roundtripI18n?: Record<string, string>;
  aliases?: string[];
  directiveOnlyAliases?: string[];
  sequenceAliases?: string[];
  localeAliases?: Record<string, string[]>;
  separableAliases?: Array<{ lead: string; particle: string }>;
  procedural?: boolean;
  argumentParser?: MedicationInstructionActionDefinition["argumentParser"];
  realizer?: MedicationInstructionActionDefinition["realizer"];
  argumentParserConfig?: MedicationInstructionActionDefinition["argumentParserConfig"];
  realizerConfig?: MedicationInstructionActionDefinition["realizerConfig"];
  methodBoundMannerConcepts?: string[];
  continuationLicenses?: MedicationInstructionActionDefinition["continuationLicenses"];
  continuationAfterRelations?: MedicationInstructionActionDefinition["continuationAfterRelations"];
  administrationDurationIntroducers?: MedicationInstructionActionDefinition["administrationDurationIntroducers"];
  preferredRelationSemanticClasses?: MedicationInstructionActionDefinition["preferredRelationSemanticClasses"];
  contextualCodings?: MedicationInstructionActionDefinition["contextualCodings"];
  contextualSemanticComponents?: MedicationInstructionActionDefinition["contextualSemanticComponents"];
  administrationMethod?: FhirCoding;
  verbRouteHint?: MedicationInstructionActionDefinition["verbRouteHint"];
  methodRouteOverride?: MedicationInstructionActionDefinition["methodRouteOverride"];
  suppressMethodRouteHint?: boolean;
  applicationVerb?: boolean;
  primaryAdministrationHead?: boolean;
  supportVerb?: boolean;
  safetyScopeTarget?: boolean;
  acceptsAmount?: boolean;
  definesDose?: boolean;
  coding?: FhirCoding;
  externalCodings?: FhirCoding[];
  semanticComponents?: MedicationInstructionActionDefinition["semanticComponents"];
}

const DEFAULT_ACTIONS = (source.actions as ActionSource[]).map(normalizeDefinition);
const DEFAULT_BY_CODE = new Map<string, MedicationInstructionActionDefinition>();
const DEFAULT_BY_ALIAS = new Map<string, MedicationInstructionActionDefinition>();
const DEFAULT_SPAN_BY_LEAD = new Map<string, number>();
const DEFAULT_BY_METHOD = new Map<string, Map<string, MedicationInstructionActionDefinition>>();

function sameMethodCoding(left: FhirCoding | undefined, right: FhirCoding): boolean {
  return Boolean(left?.code && left.code === right.code &&
    (left.system ?? SNOMED_SYSTEM) === (right.system ?? SNOMED_SYSTEM));
}

/** A shared generic method chooses its canonical action, not a specialized
 * action that merely uses that method (Apply rather than Reapply, for example).
 * Ranking runs only while the existing default vocabulary index is built. */
function methodActionRank(definition: MedicationInstructionActionDefinition, coding: FhirCoding): number {
  const exactName = definition.administrationMethod?.display?.toLowerCase() === definition.display.toLowerCase();
  const ownCoding = sameMethodCoding(definition.coding, coding) ||
    definition.externalCodings?.some(value => sameMethodCoding(value, coding));
  return (exactName ? 2 : 0) + (ownCoding ? 1 : 0);
}

function indexMethodCoding(coding: FhirCoding | undefined, definition: MedicationInstructionActionDefinition): void {
  if (!coding?.code) return;
  const system = coding.system ?? SNOMED_SYSTEM;
  let byCode = DEFAULT_BY_METHOD.get(system);
  if (!byCode) DEFAULT_BY_METHOD.set(system, (byCode = new Map()));
  const current = byCode.get(coding.code);
  if (!current || methodActionRank(definition, coding) > methodActionRank(current, coding))
    byCode.set(coding.code, definition);
}

let defaultActionSurfaceLength = 0;

for (const definition of DEFAULT_ACTIONS) {
  DEFAULT_BY_CODE.set(definition.code, definition);
  if (definition.administrationMethod) {
    indexMethodCoding(definition.administrationMethod, definition);
    indexMethodCoding(definition.coding, definition);
    for (const coding of definition.externalCodings ?? []) indexMethodCoding(coding, definition);
  }
  const aliases = [
    definition.code, definition.display, ...(definition.aliases ?? []),
    ...flattenLocaleAliases(definition.localeAliases)
  ];
  for (const alias of aliases) {
    const normalized = normalizeActionSurface(alias);
    defaultActionSurfaceLength = Math.max(defaultActionSurfaceLength, normalized.length);
    if (normalized && !DEFAULT_BY_ALIAS.has(normalized)) {
      DEFAULT_BY_ALIAS.set(normalized, definition);
      const words = normalized.split(" ");
      DEFAULT_SPAN_BY_LEAD.set(words[0], Math.max(
        DEFAULT_SPAN_BY_LEAD.get(words[0]) ?? 4, words.length
      ));
    }
  }
}

/** Bound phrase matching by the declared lexicon without widening unrelated scans.
 * @param lead Normalized first token of a possible instruction action.
 */
export function medicationInstructionActionSpanLimit(lead: string, options?: ParseOptions): number {
  let limit = DEFAULT_SPAN_BY_LEAD.get(lead) ?? 4;
  const customMap = options?.instructionActionMap;
  if (!customMap) return limit;
  for (const surface of Object.keys(customMap)) {
    const input = customMap[surface];
    for (const alias of [
      surface, input.code ?? "", ...(input.aliases ?? []),
      ...(input.sequenceAliases ?? []), ...flattenLocaleAliases(input.localeAliases)
    ]) {
      const normalized = normalizeActionSurface(alias);
      if (!normalized) continue;
      const words = normalized.split(" ");
      if (words[0] === lead) limit = Math.max(limit, words.length);
    }
  }
  return limit;
}

export function normalizeActionSurface(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneLocaleAliases(
  aliases: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!aliases) return undefined;
  const cloned: Record<string, string[]> = {};
  for (const locale of Object.keys(aliases)) {
    const values = aliases[locale];
    if (values?.length) cloned[locale] = [...values];
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function flattenLocaleAliases(aliases: Record<string, string[]> | undefined): string[] {
  const values: string[] = [];
  for (const locale of Object.keys(aliases ?? {})) values.push(...(aliases?.[locale] ?? []));
  return values;
}

function cloneCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  return coding
    ? {
      system: coding.system,
      version: coding.version,
      code: coding.code,
      display: coding.display,
      extension: coding.extension?.map((extension) => ({ ...extension })),
      _display: coding._display ? { ...coding._display } : undefined,
      i18n: coding.i18n ? { ...coding.i18n } : undefined
    }
    : undefined;
}

/** Preserve coded constituents separately from equivalent whole-action codings. */
export function cloneMedicationInstructionActionSemanticComponents(
  components: MedicationInstructionActionDefinition["semanticComponents"]
): MedicationInstructionActionDefinition["semanticComponents"] {
  return components?.map(part => ({ role: part.role, coding: cloneCoding(part.coding)! }));
}

export function cloneMedicationInstructionActionRealizerConfig(
  config: MedicationInstructionActionDefinition["realizerConfig"]
): MedicationInstructionActionDefinition["realizerConfig"] {
  if (!config) return undefined;
  const locales: NonNullable<MedicationInstructionActionDefinition["realizerConfig"]>["locales"] = {};
  for (const locale of Object.keys(config.locales ?? {})) {
    const value = config.locales?.[locale];
    if (!value) continue;
    locales![locale] = {
      ...value,
      suppressActivityConcepts: value.suppressActivityConcepts ? [...value.suppressActivityConcepts] : undefined,
      suppressSiteConcepts: value.suppressSiteConcepts ? [...value.suppressSiteConcepts] : undefined,
      routePhrases: value.routePhrases ? { ...value.routePhrases } : undefined
    };
  }
  return { locales: Object.keys(locales ?? {}).length ? locales : undefined };
}

export function medicationInstructionActionLocaleRealizerConfig(
  config: MedicationInstructionActionDefinition["realizerConfig"],
  locale: string
) {
  return localizedConfig(config?.locales, locale);
}

function cloneContextualCodings(
  rules: MedicationInstructionActionDefinition["contextualCodings"]
): MedicationInstructionActionDefinition["contextualCodings"] {
  return rules?.map((rule) => ({
    whenArgument: { ...rule.whenArgument },
    coding: cloneCoding(rule.coding)!
  }));
}

function cloneContextualSemanticComponents(
  rules: MedicationInstructionActionDefinition["contextualSemanticComponents"]
): MedicationInstructionActionDefinition["contextualSemanticComponents"] {
  return rules?.map(rule => ({
    whenArgument: { ...rule.whenArgument },
    component: { role: rule.component.role, coding: cloneCoding(rule.component.coding)! }
  }));
}

/** Shared typed-argument matcher for both equivalent context codings and
 * independent standards-coded constituents. No new language interpretation. */
export function matchesMedicationInstructionActionContextArgument(
  expected: NonNullable<MedicationInstructionActionDefinition["contextualCodings"]>[number]["whenArgument"],
  args: readonly AdviceArgument[]
): boolean {
  return args.some(arg =>
    (expected.role === undefined || arg.role === expected.role) &&
    (expected.conceptId === undefined || arg.conceptId === expected.conceptId) &&
    (expected.codingCode === undefined || arg.coding?.code === expected.codingCode) &&
    (expected.normalized === undefined || arg.normalized === expected.normalized)
  );
}

/** Resolve exact whole-action mappings licensed by typed argument semantics.
 * Shared by the primary HPSG graph and optional semantic-resolver graph. */
export function medicationInstructionActionContextualCodings(
  definition: MedicationInstructionActionDefinition,
  args: readonly AdviceArgument[]
): FhirCoding[] {
  const codings: FhirCoding[] = [];
  for (const rule of definition.contextualCodings ?? []) {
    if (!matchesMedicationInstructionActionContextArgument(rule.whenArgument, args) ||
        codings.some(coding =>
          coding.code === rule.coding.code && coding.system === rule.coding.system)) continue;
    codings.push(cloneCoding(rule.coding)!);
  }
  return codings;
}

/** Combine only constituents justified by this action's actual typed arguments.
 * Do not place fragment/finding/qualifier codes in whole-predicate Codings. */
export function medicationInstructionActionSemanticComponentsForArgs(
  definition: MedicationInstructionActionDefinition,
  args: readonly AdviceArgument[]
): MedicationInstructionActionDefinition["semanticComponents"] {
  const fixed = cloneMedicationInstructionActionSemanticComponents(definition.semanticComponents);
  if (!definition.contextualSemanticComponents?.length) return fixed;
  const combined = fixed ?? [];
  for (const rule of definition.contextualSemanticComponents) {
    if (!matchesMedicationInstructionActionContextArgument(rule.whenArgument, args)) continue;
    if (combined.some(part => part.role === rule.component.role &&
      part.coding.system === rule.component.coding.system &&
      part.coding.code === rule.component.coding.code)) continue;
    combined.push({
      role: rule.component.role, coding: cloneCoding(rule.component.coding)!
    });
  }
  return combined.length ? combined : undefined;
}

function cloneContinuationLicenses(
  rules: MedicationInstructionActionDefinition["continuationLicenses"]
): MedicationInstructionActionDefinition["continuationLicenses"] {
  return rules?.map((rule) => ({
    ...rule,
    previousConcepts: rule.previousConcepts ? [...rule.previousConcepts] : undefined,
    previousKinds: rule.previousKinds ? [...rule.previousKinds] : undefined,
    nextConcepts: rule.nextConcepts ? [...rule.nextConcepts] : undefined
  }));
}

export function cloneMedicationInstructionActionDefinition(
  definition: MedicationInstructionActionDefinition
): MedicationInstructionActionDefinition {
  return {
    code: definition.code,
    semanticClass: definition.semanticClass,
    display: definition.display,
    i18n: definition.i18n ? { ...definition.i18n } : undefined,
    roundtripI18n: definition.roundtripI18n ? { ...definition.roundtripI18n } : undefined,
    aliases: definition.aliases ? [...definition.aliases] : undefined,
    directiveOnlyAliases: definition.directiveOnlyAliases ? [...definition.directiveOnlyAliases] : undefined,
    sequenceAliases: definition.sequenceAliases ? [...definition.sequenceAliases] : undefined,
    localeAliases: cloneLocaleAliases(definition.localeAliases),
    separableAliases: definition.separableAliases?.map((alias) => ({ ...alias })),
    procedural: definition.procedural,
    argumentParser: definition.argumentParser,
    realizer: definition.realizer,
    argumentParserConfig: definition.argumentParserConfig ? {
      ...definition.argumentParserConfig,
      primaryConcepts: definition.argumentParserConfig.primaryConcepts ? [...definition.argumentParserConfig.primaryConcepts] : undefined,
      secondaryConcepts: definition.argumentParserConfig.secondaryConcepts ? [...definition.argumentParserConfig.secondaryConcepts] : undefined
    } : undefined,
    realizerConfig: cloneMedicationInstructionActionRealizerConfig(definition.realizerConfig),
    methodBoundMannerConcepts: definition.methodBoundMannerConcepts ? [...definition.methodBoundMannerConcepts] : undefined,
    continuationLicenses: cloneContinuationLicenses(definition.continuationLicenses),
    continuationAfterRelations: definition.continuationAfterRelations ? [...definition.continuationAfterRelations] : undefined,
    administrationDurationIntroducers: definition.administrationDurationIntroducers ? [...definition.administrationDurationIntroducers] : undefined,
    preferredRelationSemanticClasses: definition.preferredRelationSemanticClasses ? [...definition.preferredRelationSemanticClasses] : undefined,
    contextualCodings: cloneContextualCodings(definition.contextualCodings),
    contextualSemanticComponents: cloneContextualSemanticComponents(definition.contextualSemanticComponents),
    administrationMethod: cloneCoding(definition.administrationMethod),
    verbRouteHint: definition.verbRouteHint,
    methodRouteOverride: definition.methodRouteOverride,
    suppressMethodRouteHint: definition.suppressMethodRouteHint,
    applicationVerb: definition.applicationVerb,
    primaryAdministrationHead: definition.primaryAdministrationHead,
    supportVerb: definition.supportVerb,
    safetyScopeTarget: definition.safetyScopeTarget,
    acceptsAmount: definition.acceptsAmount,
    definesDose: definition.definesDose,
    coding: cloneCoding(definition.coding),
    externalCodings: definition.externalCodings?.map((coding) => cloneCoding(coding)!),
    semanticComponents: cloneMedicationInstructionActionSemanticComponents(definition.semanticComponents)
  };
}

function normalizeDefinition(sourceDefinition: ActionSource): MedicationInstructionActionDefinition {
  return {
    code: sourceDefinition.code,
    semanticClass: sourceDefinition.semanticClass,
    display: sourceDefinition.display,
    i18n: sourceDefinition.i18n ? { ...sourceDefinition.i18n } : undefined,
    roundtripI18n: sourceDefinition.roundtripI18n ? { ...sourceDefinition.roundtripI18n } : undefined,
    aliases: sourceDefinition.aliases ? [...sourceDefinition.aliases] : undefined,
    directiveOnlyAliases: sourceDefinition.directiveOnlyAliases ? [...sourceDefinition.directiveOnlyAliases] : undefined,
    sequenceAliases: sourceDefinition.sequenceAliases ? [...sourceDefinition.sequenceAliases] : undefined,
    localeAliases: cloneLocaleAliases(sourceDefinition.localeAliases),
    separableAliases: sourceDefinition.separableAliases?.map((alias) => ({ ...alias })),
    procedural: sourceDefinition.procedural,
    argumentParser: sourceDefinition.argumentParser,
    realizer: sourceDefinition.realizer,
    argumentParserConfig: sourceDefinition.argumentParserConfig ? {
      ...sourceDefinition.argumentParserConfig,
      primaryConcepts: sourceDefinition.argumentParserConfig.primaryConcepts ? [...sourceDefinition.argumentParserConfig.primaryConcepts] : undefined,
      secondaryConcepts: sourceDefinition.argumentParserConfig.secondaryConcepts ? [...sourceDefinition.argumentParserConfig.secondaryConcepts] : undefined
    } : undefined,
    realizerConfig: cloneMedicationInstructionActionRealizerConfig(sourceDefinition.realizerConfig),
    methodBoundMannerConcepts: sourceDefinition.methodBoundMannerConcepts ? [...sourceDefinition.methodBoundMannerConcepts] : undefined,
    continuationLicenses: cloneContinuationLicenses(sourceDefinition.continuationLicenses),
    continuationAfterRelations: sourceDefinition.continuationAfterRelations ? [...sourceDefinition.continuationAfterRelations] : undefined,
    administrationDurationIntroducers: sourceDefinition.administrationDurationIntroducers ? [...sourceDefinition.administrationDurationIntroducers] : undefined,
    preferredRelationSemanticClasses: sourceDefinition.preferredRelationSemanticClasses ? [...sourceDefinition.preferredRelationSemanticClasses] : undefined,
    contextualCodings: cloneContextualCodings(sourceDefinition.contextualCodings),
    contextualSemanticComponents: cloneContextualSemanticComponents(sourceDefinition.contextualSemanticComponents),
    administrationMethod: cloneCoding(sourceDefinition.administrationMethod),
    verbRouteHint: sourceDefinition.verbRouteHint,
    methodRouteOverride: sourceDefinition.methodRouteOverride,
    suppressMethodRouteHint: sourceDefinition.suppressMethodRouteHint,
    applicationVerb: sourceDefinition.applicationVerb,
    primaryAdministrationHead: sourceDefinition.primaryAdministrationHead,
    supportVerb: sourceDefinition.supportVerb,
    safetyScopeTarget: sourceDefinition.safetyScopeTarget,
    acceptsAmount: sourceDefinition.acceptsAmount,
    definesDose: sourceDefinition.definesDose,
    coding: cloneCoding(sourceDefinition.coding),
    externalCodings: sourceDefinition.externalCodings?.map((coding) => cloneCoding(coding)!),
    semanticComponents: cloneMedicationInstructionActionSemanticComponents(sourceDefinition.semanticComponents)
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
    roundtripI18n: input.roundtripI18n ? { ...input.roundtripI18n } : undefined,
    aliases: Array.from(new Set([surface, ...(input.aliases ?? [])])),
    directiveOnlyAliases: input.directiveOnlyAliases ? [...input.directiveOnlyAliases] : undefined,
    sequenceAliases: input.sequenceAliases ? [...input.sequenceAliases] : undefined,
    localeAliases: cloneLocaleAliases(input.localeAliases),
    separableAliases: input.separableAliases?.map((alias) => ({ ...alias })),
    procedural: input.procedural ?? true,
    argumentParser: input.argumentParser,
    realizer: input.realizer,
    argumentParserConfig: input.argumentParserConfig ? {
      ...input.argumentParserConfig,
      primaryConcepts: input.argumentParserConfig.primaryConcepts ? [...input.argumentParserConfig.primaryConcepts] : undefined,
      secondaryConcepts: input.argumentParserConfig.secondaryConcepts ? [...input.argumentParserConfig.secondaryConcepts] : undefined
    } : undefined,
    realizerConfig: cloneMedicationInstructionActionRealizerConfig(input.realizerConfig),
    methodBoundMannerConcepts: input.methodBoundMannerConcepts ? [...input.methodBoundMannerConcepts] : undefined,
    continuationLicenses: cloneContinuationLicenses(input.continuationLicenses),
    continuationAfterRelations: input.continuationAfterRelations ? [...input.continuationAfterRelations] : undefined,
    administrationDurationIntroducers: input.administrationDurationIntroducers ? [...input.administrationDurationIntroducers] : undefined,
    preferredRelationSemanticClasses: input.preferredRelationSemanticClasses ? [...input.preferredRelationSemanticClasses] : undefined,
    contextualCodings: cloneContextualCodings(input.contextualCodings),
    contextualSemanticComponents: cloneContextualSemanticComponents(input.contextualSemanticComponents),
    administrationMethod: cloneCoding(input.administrationMethod),
    verbRouteHint: input.verbRouteHint,
    methodRouteOverride: input.methodRouteOverride,
    suppressMethodRouteHint: input.suppressMethodRouteHint,
    applicationVerb: input.applicationVerb,
    primaryAdministrationHead: input.primaryAdministrationHead,
    supportVerb: input.supportVerb,
    safetyScopeTarget: input.safetyScopeTarget,
    acceptsAmount: input.acceptsAmount,
    definesDose: input.definesDose,
    coding: cloneCoding(input.coding),
    externalCodings: input.externalCodings?.map((coding) => cloneCoding(coding)!),
    semanticComponents: cloneMedicationInstructionActionSemanticComponents(input.semanticComponents)
  };
}

function customDefinitionMatchesSurface(
  surface: string, input: MedicationInstructionActionInput, normalized: string
): boolean {
  if (normalizeActionSurface(surface) === normalized) return true;
  for (const alias of input.aliases ?? [])
    if (normalizeActionSurface(alias) === normalized) return true;
  for (const locale of Object.keys(input.localeAliases ?? {}))
    for (const alias of input.localeAliases![locale])
      if (normalizeActionSurface(alias) === normalized) return true;
  return false;
}

export function resolveMedicationInstructionSequenceAction(
  surface: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const target = normalizeActionSurface(surface);
  const map = options?.instructionActionMap;
  if (map) {
    for (const configuredSurface of Object.keys(map)) {
      const input = map[configuredSurface];
      if ((input.sequenceAliases ?? []).some((alias) => normalizeActionSurface(alias) === target)) {
        return normalizeCustomDefinition(configuredSurface, input);
      }
    }
  }
  for (const definition of DEFAULT_ACTIONS) {
    if ((definition.sequenceAliases ?? []).some((alias) => normalizeActionSurface(alias) === target)) {
      return definition;
    }
  }
  return undefined;
}

export function resolveMedicationInstructionSeparableAction(
  lead: string,
  particle: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const normalizedLead = normalizeActionSurface(lead);
  const normalizedParticle = normalizeActionSurface(particle);
  const map = options?.instructionActionMap;
  if (map) {
    for (const surface of Object.keys(map)) {
      const definition = normalizeCustomDefinition(surface, map[surface]);
      if (definition.separableAliases?.some((alias) =>
        normalizeActionSurface(alias.lead) === normalizedLead &&
        normalizeActionSurface(alias.particle) === normalizedParticle
      )) return definition;
    }
  }
  for (const definition of DEFAULT_ACTIONS) {
    if (definition.separableAliases?.some((alias) =>
      normalizeActionSurface(alias.lead) === normalizedLead &&
      normalizeActionSurface(alias.particle) === normalizedParticle
    )) return definition;
  }
  return undefined;
}

export function medicationInstructionActionIsSafetyScopeTarget(
  surface: string,
  options?: ParseOptions
): boolean {
  return resolveMedicationInstructionAction(surface, options)?.safetyScopeTarget === true;
}

/* Dictionary definitions are immutable by caller contract. Lexical source
 * surfaces do not implicitly include saved predicate codes. The semantic
 * proposal boundary explicitly opts into its declared surface/code contract.
 * Explicit frame construction copies only the fields it later edits. */
export function resolveMedicationInstructionAction(
  surface: string,
  options?: ParseOptions,
  includeCode = false
): MedicationInstructionActionDefinition | undefined {
  const target = normalizeActionSurface(surface);
  const builtin = DEFAULT_BY_ALIAS.get(target);
  const map = options?.instructionActionMap;
  let codeFallback: string | undefined;
  if (map) {
    // A proposal may name either a surface or a saved code. Surfaces keep
    // their lexical meaning across the complete vocabulary; a code match
    // is only a fallback. Both custom candidates share this one map walk.
    for (const configuredSurface of Object.keys(map)) {
      const input = map[configuredSurface];
      if (customDefinitionMatchesSurface(configuredSurface, input, target))
        return normalizeCustomDefinition(configuredSurface, input);
      if (includeCode && !builtin && codeFallback === undefined) {
        const code = input.code?.trim() || normalizeActionSurface(configuredSurface).replace(/\s+/g, "-");
        if (normalizeActionSurface(code) === target) codeFallback = configuredSurface;
      }
    }
  }
  return builtin ?? (codeFallback !== undefined ? normalizeCustomDefinition(codeFallback, map![codeFallback]) : undefined);
}

/** The package lookup accepts saved codes as well as registered surfaces.
 * Internal lexical callers retain the surface-only default above. */
export function resolveMedicationInstructionActionWithCodeFallback(
  surface: string,
  options?: ParseOptions,
  includeCode = true
): MedicationInstructionActionDefinition | undefined {
  const definition = resolveMedicationInstructionAction(surface, options, includeCode);
  return definition ? cloneMedicationInstructionActionDefinition(definition) : undefined;
}

/** Resolve a declared administration method by exact code identity. Known
 * codings own the verb even when an external edit leaves stale display text.
 * Unknown identities return undefined for the caller's existing text fallback. */
export function resolveMedicationInstructionActionByMethod(
  coding: FhirCoding | undefined,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  if (!coding?.code) return undefined;
  const customMap = options?.instructionActionMap;
  if (customMap) {
    const display = coding.display ? normalizeActionSurface(coding.display) : undefined;
    let fallback: string | undefined;
    // Prefer the existing matching display among equal identities, then the
    // first exact code match. One configured-vocabulary walk serves both.
    for (const surface of Object.keys(customMap)) {
      const input = customMap[surface];
      if (!sameMethodCoding(input.administrationMethod, coding)) continue;
      if (!display || input.display && normalizeActionSurface(input.display) === display ||
          customDefinitionMatchesSurface(surface, input, display))
        return normalizeCustomDefinition(surface, input);
      fallback ??= surface;
    }
    if (fallback !== undefined) return normalizeCustomDefinition(fallback, customMap[fallback]);
  }
  return DEFAULT_BY_METHOD.get(coding.system ?? SNOMED_SYSTEM)?.get(coding.code);
}

/** A translated coding can precede the known method in a CodeableConcept.
 * Select its recognized identity in one pass and retain the first code as
 * the fallback for wholly unfamiliar concepts. The source array is untouched. */
export function selectMedicationInstructionMethodCoding(
  codings: readonly FhirCoding[] | undefined,
  options?: ParseOptions
): FhirCoding | undefined {
  if (!codings?.length) return undefined;
  if (codings.length === 1) return codings[0].code ? codings[0] : undefined;
  let fallback: FhirCoding | undefined;
  for (const coding of codings) {
    if (!coding.code) continue;
    if (!fallback) fallback = coding;
    if (resolveMedicationInstructionActionByMethod(coding, options)) return coding;
  }
  return fallback;
}

/** Keep compatible authored verbs (Drink and Swallow share a method), while
 * a recognized edited code replaces an incompatible retained verb. */
export function resolveMedicationInstructionActionForMethod(
  method: CanonicalMethodExpr | undefined,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  if (!method) return undefined;
  let authored = method.text ? resolveMedicationInstructionAction(method.text, options) : undefined;
  const coding = method.coding;
  let coded: MedicationInstructionActionDefinition | undefined;
  let qualified = false;
  if (!authored && method.text?.trim() && method.text.trim() !== coding?.code) {
    coded = resolveMedicationInstructionActionByMethod(coding, options);
    if (!coded) return undefined;
    // Resolve only a declared lexical head, bounded by the existing vocabulary.
    // Compatible qualified text remains whole; unfamiliar text stays source.
    const surface = normalizeActionSurface(method.text);
    // An exact configured display is a coded label, not a qualified phrase or
    // a new parser alias. Keep its selected identity for locale realization.
    if (surface === normalizeActionSurface(coded.display)) return coded;
    let end = surface.indexOf(" ");
    // Joined scripts use the registered locale boundary policy and the same
    // declared aliases. No language literals or second action vocabulary.
    if (shouldJoinAdjacentSourceTokens(surface, surface)) {
      let surfaceLimit = defaultActionSurfaceLength;
      const custom = options?.instructionActionMap;
      if (custom) for (const key of Object.keys(custom)) {
        const input = custom[key];
        for (const alias of [key, input.code ?? "", ...(input.aliases ?? []),
          ...flattenLocaleAliases(input.localeAliases)])
          surfaceLimit = Math.max(surfaceLimit, normalizeActionSurface(alias).length);
      }
      // A suffix cannot introduce a longer lexical action than the declared
      // vocabulary. Bound prefix lookups even for arbitrarily long source text.
      const wordEnd = Math.min((end < 0 ? surface.length : end) - 1, surfaceLimit);
      for (let boundary = 1; boundary <= wordEnd; boundary++) {
        const prefix = surface.slice(0, boundary);
        const head = resolveMedicationInstructionAction(prefix, options);
        if (head && shouldJoinAdjacentSourceTokens(prefix, surface.slice(boundary))) authored = head;
      }
    }
    const limit = medicationInstructionActionSpanLimit(surface.slice(0, end < 0 ? surface.length : end), options);
    for (let count = 0; count < limit && end >= 0; count++) {
      const head = resolveMedicationInstructionAction(surface.slice(0, end), options);
      if (head) authored = head;
      end = surface.indexOf(" ", end + 1);
    }
    if (!authored) return undefined;
    qualified = true;
  }
  if (authored && (!coding?.code || sameMethodCoding(authored.administrationMethod, coding) ||
      sameMethodCoding(authored.coding, coding) ||
      authored.externalCodings?.some(value => sameMethodCoding(value, coding)))) return qualified ? undefined : authored;
  return coded ?? resolveMedicationInstructionActionByMethod(coding, options) ?? (qualified ? undefined : authored);
}

export function getMedicationInstructionAction(
  code: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const map = options?.instructionActionMap;
  if (map) for (const surface of Object.keys(map)) {
    const input = map[surface];
    const identity = input.code?.trim() || normalizeActionSurface(surface).replace(/\s+/g, "-");
    if (identity === code) return normalizeCustomDefinition(surface, input);
  }
  return DEFAULT_BY_CODE.get(code);
}

export function listMedicationInstructionActions(): MedicationInstructionActionDefinition[] {
  return DEFAULT_ACTIONS;
}

/** Package vocabulary values can be customized without changing parser indexes.
 * Internal lexical lookups above keep their shared, allocation-free entries. */
export function getMedicationInstructionActionCopy(
  code: string, options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const definition = getMedicationInstructionAction(code, options);
  return definition ? cloneMedicationInstructionActionDefinition(definition) : undefined;
}

export function listMedicationInstructionActionCopies(): MedicationInstructionActionDefinition[] {
  return DEFAULT_ACTIONS.map(cloneMedicationInstructionActionDefinition);
}

export function resolveMedicationInstructionSequenceActionCopy(
  surface: string, options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const definition = resolveMedicationInstructionSequenceAction(surface, options);
  return definition ? cloneMedicationInstructionActionDefinition(definition) : undefined;
}

/** A CodeSystem snapshot is a public value, not mutable global schema.
 * Build it with one definition walk and one language-key walk per published
 * action; avoid filter→map and map→filter pipelines on every public call. */
export function buildMedicationInstructionActionCodeSystem(): MedicationInstructionActionCodeSystem {
  const concepts: MedicationInstructionActionCodeSystem["concept"] = [];
  for (const definition of DEFAULT_ACTIONS) {
    // A local action remains part of the published CodeSystem even when
    // extra NLM/HL7/SNOMED codings are provided for the same instruction.
    if (definition.coding?.system !== MEDICATION_INSTRUCTION_ACTION_SYSTEM &&
        (definition.coding || definition.externalCodings?.length)) continue;
    const designations: NonNullable<MedicationInstructionActionCodeSystem["concept"]>[number]["designation"] = [];
    const translations = definition.i18n;
    if (translations) for (const language in translations) {
      if (!Object.prototype.hasOwnProperty.call(translations, language)) continue;
      const value = translations[language];
      if (value) designations.push({ language, value });
    }
    concepts.push({ code: definition.code, display: definition.display, designation: designations });
  }
  return {
    resourceType: "CodeSystem",
    url: MEDICATION_INSTRUCTION_ACTION_SYSTEM,
    name: "MedicationInstructionAction",
    title: "Medication Instruction Action",
    status: "active",
    experimental: false,
    caseSensitive: true,
    content: "complete",
    concept: concepts
  };
}

export function medicationInstructionActionCoding(
  definition: MedicationInstructionActionDefinition
): FhirCoding {
  const coding = definition.coding ?? definition.externalCodings?.[0];
  return coding
    ? cloneCoding(coding)!
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
  if (definition.coding) return [
    cloneCoding(definition.coding)!,
    ...(definition.externalCodings ?? []).map((coding) => cloneCoding(coding)!)
  ];
  if (definition.externalCodings?.length) {
    return definition.externalCodings.map((coding) => cloneCoding(coding)!);
  }
  return [medicationInstructionActionCoding(definition)];
}
