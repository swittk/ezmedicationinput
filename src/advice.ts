import adviceTerminologySource from "./advice-terminology.json";
import adviceRulesSource from "./advice-rules.json";
import { lexInput } from "./lexer/lex";
import {
  AdditionalInstructionDefinition,
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdviceModality,
  AdvicePolarity,
  AdviceRelation,
  FhirCoding,
  TextRange
} from "./types";
import { normalizeLoosePhraseKey } from "./utils/text";

const SNOMED_SYSTEM = "http://snomed.info/sct";

interface AdviceLexemeEntry {
  surface: string;
  lemma: string;
  partOfSpeech: string;
  semanticClass?: string;
  parserProfile?: string;
  realizerProfile?: string;
}

interface AdviceConceptEntry {
  surface: string;
  lemma: string;
  semanticClass: string;
  conceptId: string;
  implicitRelation?: string;
}

interface AdviceGrammarSource {
  leadingNoiseWords: string[];
  administrationPredicates: string[];
  verbConnectorWords: string[];
  simpleTimeWords: string[];
  durationUnitWords: string[];
  negationPrefixes: Array<{ parts: string[]; modality?: string }>;
  warningPredicateSemanticClasses: string[];
  warningModalities: string[];
  cautionModalities: string[];
  semanticClassRoles: Record<string, string>;
  sequenceMarkers: string[];
  negativeNominalLeads: string[];
  ellipticalEffectSemanticClasses: string[];
  styleSemanticClasses: string[];
  embeddedAvoidanceTriggerConceptIds: string[];
}

interface AdviceTerminologySource {
  lexemes: AdviceLexemeEntry[];
  concepts: AdviceConceptEntry[];
  grammar: AdviceGrammarSource;
}

interface AdviceFrameTemplateArgument {
  role: AdviceArgumentRole;
  text: string;
  conceptId?: string;
}

interface AdviceFrameTemplate {
  force: AdviceForce;
  polarity?: AdvicePolarity;
  predicate: {
    lemma: string;
    semanticClass?: string;
  };
  relation?: AdviceRelation;
  args: AdviceFrameTemplateArgument[];
}

interface AdviceDefinitionSource {
  system?: string;
  code: string;
  display: string;
  text: string;
  thai: string;
  thaiVerbSuffix?: string;
}

interface AdviceFrameTemplateArgumentSource {
  role: string;
  text: string;
  conceptId?: string;
}

interface AdviceFrameTemplateSource {
  force: string;
  polarity?: string;
  predicate: {
    lemma: string;
    semanticClass?: string;
  };
  relation?: string;
  args: AdviceFrameTemplateArgumentSource[];
}

interface AdviceArgConceptMatcher {
  conceptIds: string[];
  role?: AdviceArgumentRole;
}

interface AdviceFrameMatcher {
  predicateLemmas?: string[];
  predicateSemanticClasses?: string[];
  relations?: AdviceRelation[];
  force?: AdviceForce;
  polarity?: AdvicePolarity;
  argConcepts?: AdviceArgConceptMatcher[];
}

interface AdviceFrameMatcherSource {
  predicateLemmas?: string[];
  predicateSemanticClasses?: string[];
  relations?: string[];
  force?: string;
  polarity?: string;
  argConcepts?: AdviceArgConceptMatcherSource[];
}

interface AdviceArgConceptMatcherSource {
  conceptIds: string[];
  role?: string;
}

interface AdviceMatcherAllOf {
  allOf: AdviceMatcher[];
}

interface AdviceMatcherAnyOf {
  anyOf: AdviceMatcher[];
}

interface AdviceMatcherNot {
  not: AdviceMatcher;
}

interface AdviceMatcherFrame {
  frame: AdviceFrameMatcher;
}

interface AdviceMatcherArgConcept {
  argConcept: AdviceArgConceptMatcher;
}

interface AdviceMatcherNormalizedText {
  normalizedTexts: string[];
}

type AdviceMatcher =
  | AdviceMatcherAllOf
  | AdviceMatcherAnyOf
  | AdviceMatcherNot
  | AdviceMatcherFrame
  | AdviceMatcherArgConcept
  | AdviceMatcherNormalizedText;

interface AdviceMatcherAllOfSource {
  allOf: AdviceMatcherSource[];
}

interface AdviceMatcherAnyOfSource {
  anyOf: AdviceMatcherSource[];
}

interface AdviceMatcherNotSource {
  not: AdviceMatcherSource;
}

interface AdviceMatcherFrameSource {
  frame: AdviceFrameMatcherSource;
}

interface AdviceMatcherArgConceptSource {
  argConcept: AdviceArgConceptMatcherSource;
}

interface AdviceMatcherNormalizedTextSource {
  normalizedTexts: string[];
}

type AdviceMatcherSource =
  | AdviceMatcherAllOfSource
  | AdviceMatcherAnyOfSource
  | AdviceMatcherNotSource
  | AdviceMatcherFrameSource
  | AdviceMatcherArgConceptSource
  | AdviceMatcherNormalizedTextSource;

interface AdviceCodingRuleSource {
  id: string;
  definition: AdviceDefinitionSource;
  frames: AdviceFrameTemplateSource[];
  matcher: AdviceMatcherSource;
}

interface AdviceCodingRule {
  id: string;
  definition: AdditionalInstructionDefinition;
  frames: AdviceFrameTemplate[];
  matcher: AdviceMatcher;
}

interface AdviceRulesSource {
  rules: AdviceCodingRuleSource[];
}

export interface ParsedAdditionalInstruction {
  text?: string;
  coding?: FhirCoding & { i18n?: Record<string, string> };
  frames: AdviceFrame[];
}

export interface AdviceParseContext {
  defaultPredicate: string;
  defaultForce?: AdviceForce;
  allowFreeTextFallback?: boolean;
}

interface AdviceSegment {
  text: string;
  range: TextRange;
}

interface AdviceClausePrefix {
  cursor: number;
  polarity?: AdvicePolarity;
  modality?: AdviceModality;
}

const ADVICE_TERMINOLOGY: AdviceTerminologySource = adviceTerminologySource;
const ADVICE_RULES: AdviceRulesSource = adviceRulesSource;

const DEFAULT_INSTRUCTION_CONTEXT: AdviceParseContext = {
  defaultPredicate: "take",
  defaultForce: AdviceForce.Instruction,
  allowFreeTextFallback: false
};

const LEADING_NOISE_WORDS = new Set(ADVICE_TERMINOLOGY.grammar.leadingNoiseWords);
const ADMINISTRATION_PREDICATES = new Set(ADVICE_TERMINOLOGY.grammar.administrationPredicates);
const VERB_CONNECTOR_WORDS = new Set(ADVICE_TERMINOLOGY.grammar.verbConnectorWords);
const SIMPLE_TIME_WORDS = new Set(ADVICE_TERMINOLOGY.grammar.simpleTimeWords);
const DURATION_UNIT_WORDS = new Set(ADVICE_TERMINOLOGY.grammar.durationUnitWords);
const WARNING_PREDICATE_SEMANTIC_CLASSES = new Set(
  ADVICE_TERMINOLOGY.grammar.warningPredicateSemanticClasses
);
const WARNING_MODALITIES = new Set(ADVICE_TERMINOLOGY.grammar.warningModalities);
const CAUTION_MODALITIES = new Set(ADVICE_TERMINOLOGY.grammar.cautionModalities);
const SEMANTIC_CLASS_ROLES = ADVICE_TERMINOLOGY.grammar.semanticClassRoles;
const SEQUENCE_MARKERS = new Set(ADVICE_TERMINOLOGY.grammar.sequenceMarkers);
const NEGATIVE_NOMINAL_LEADS = new Set(ADVICE_TERMINOLOGY.grammar.negativeNominalLeads);
const ELLIPTICAL_EFFECT_SEMANTIC_CLASSES = new Set(
  ADVICE_TERMINOLOGY.grammar.ellipticalEffectSemanticClasses
);
const STYLE_SEMANTIC_CLASSES = new Set(ADVICE_TERMINOLOGY.grammar.styleSemanticClasses);
const EMBEDDED_AVOIDANCE_TRIGGER_CONCEPT_IDS = new Set(
  ADVICE_TERMINOLOGY.grammar.embeddedAvoidanceTriggerConceptIds
);

const LEXEMES_BY_SURFACE: Record<string, AdviceLexemeEntry[]> = Object.create(null);
const CONCEPTS_BY_SURFACE: Record<string, AdviceConceptEntry[]> = Object.create(null);
const CONCEPT_KEYS_BY_ID: Record<string, string[]> = Object.create(null);
const LEXEME_LIST: AdviceLexemeEntry[] = [];
const CONCEPT_LIST: AdviceConceptEntry[] = [];
let MAX_LEXEME_WORDS = 1;
let MAX_CONCEPT_WORDS = 1;

function normalizeAdditionalInstructionKey(value: string): string {
  let prepared = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = index > 0 ? value[index - 1] : "";
    const next = index + 1 < value.length ? value[index + 1] : "";
    if (char === "." && /\d/.test(previous) && /\d/.test(next)) {
      prepared += "decimalpoint";
      continue;
    }
    prepared += char;
  }
  return normalizeLoosePhraseKey(prepared).replace(/decimalpoint/g, ".");
}

function countWords(value: string): number {
  if (!value) {
    return 0;
  }
  let count = 0;
  let inWord = false;
  for (const char of value) {
    if (char === " ") {
      if (inWord) {
        count += 1;
        inWord = false;
      }
      continue;
    }
    inWord = true;
  }
  if (inWord) {
    count += 1;
  }
  return count;
}

function pushLexeme(surfaceKey: string, entry: AdviceLexemeEntry): void {
  const bucket = LEXEMES_BY_SURFACE[surfaceKey];
  if (bucket) {
    bucket.push(entry);
    return;
  }
  LEXEMES_BY_SURFACE[surfaceKey] = [entry];
}

function pushConcept(surfaceKey: string, entry: AdviceConceptEntry): void {
  const bucket = CONCEPTS_BY_SURFACE[surfaceKey];
  if (bucket) {
    bucket.push(entry);
    return;
  }
  CONCEPTS_BY_SURFACE[surfaceKey] = [entry];
}

function pushConceptKeyById(conceptId: string, surfaceKey: string): void {
  const bucket = CONCEPT_KEYS_BY_ID[conceptId];
  if (bucket) {
    bucket.push(surfaceKey);
    return;
  }
  CONCEPT_KEYS_BY_ID[conceptId] = [surfaceKey];
}

for (const entry of ADVICE_TERMINOLOGY.lexemes) {
  const surfaceKey = normalizeAdditionalInstructionKey(entry.surface);
  if (!surfaceKey) {
    continue;
  }
  LEXEME_LIST.push(entry);
  pushLexeme(surfaceKey, entry);
  const wordCount = countWords(surfaceKey);
  if (wordCount > MAX_LEXEME_WORDS) {
    MAX_LEXEME_WORDS = wordCount;
  }
}

for (const entry of ADVICE_TERMINOLOGY.concepts) {
  const surfaceKey = normalizeAdditionalInstructionKey(entry.surface);
  if (!surfaceKey) {
    continue;
  }
  CONCEPT_LIST.push(entry);
  pushConcept(surfaceKey, entry);
  pushConceptKeyById(entry.conceptId, surfaceKey);
  const wordCount = countWords(surfaceKey);
  if (wordCount > MAX_CONCEPT_WORDS) {
    MAX_CONCEPT_WORDS = wordCount;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanFreeText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const char = value[start];
    if (/\s/.test(char) || char === "," || char === ";" || char === ":" || char === "-" || char === ".") {
      start += 1;
      continue;
    }
    break;
  }
  while (end > start) {
    const char = value[end - 1];
    if (/\s/.test(char) || char === "," || char === ";" || char === ":" || char === "-" || char === ".") {
      end -= 1;
      continue;
    }
    break;
  }
  return collapseWhitespace(value.slice(start, end));
}

function enumValue<T>(record: object, value: string | undefined): T | undefined {
  if (!value) return undefined;
  const values = record as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (values[key] === value) return values[key] as T;
  }
  return undefined;
}

function requiredEnumValue<T>(record: object, value: string, label: string): T {
  const parsed = enumValue<T>(record, value);
  if (parsed !== undefined) return parsed;
  throw new Error(`Unsupported ${label}: ${value}`);
}

function createDefinitionFromSource(source: AdviceDefinitionSource): AdditionalInstructionDefinition {
  const system = source.system?.trim() || SNOMED_SYSTEM;
  return {
    coding: {
      system,
      code: source.code,
      display: source.display
    },
    text: source.text,
    i18n: { th: source.thai },
    verbSuffixI18n: source.thaiVerbSuffix ? { th: source.thaiVerbSuffix } : undefined
  };
}

function mapAdviceForce(value: string): AdviceForce {
  return requiredEnumValue<AdviceForce>(AdviceForce, value, "advice force");
}

function mapAdvicePolarity(value: string | undefined): AdvicePolarity | undefined {
  if (!value) return undefined;
  return requiredEnumValue<AdvicePolarity>(AdvicePolarity, value, "advice polarity");
}

function mapAdviceRelation(value: string | undefined): AdviceRelation | undefined {
  if (!value) return undefined;
  return requiredEnumValue<AdviceRelation>(AdviceRelation, value, "advice relation");
}

function mapAdviceArgumentRole(value: string): AdviceArgumentRole {
  return requiredEnumValue<AdviceArgumentRole>(AdviceArgumentRole, value, "advice argument role");
}

function buildAdviceFrameTemplateArgument(
  source: AdviceFrameTemplateArgumentSource
): AdviceFrameTemplateArgument {
  return {
    role: mapAdviceArgumentRole(source.role),
    text: source.text,
    conceptId: source.conceptId
  };
}

function buildAdviceFrameTemplate(source: AdviceFrameTemplateSource): AdviceFrameTemplate {
  const args: AdviceFrameTemplateArgument[] = [];
  for (const arg of source.args) {
    args.push(buildAdviceFrameTemplateArgument(arg));
  }
  return {
    force: mapAdviceForce(source.force),
    polarity: mapAdvicePolarity(source.polarity),
    predicate: {
      lemma: source.predicate.lemma,
      semanticClass: source.predicate.semanticClass
    },
    relation: mapAdviceRelation(source.relation),
    args
  };
}

function buildAdviceArgConceptMatcher(source: AdviceArgConceptMatcherSource): AdviceArgConceptMatcher {
  return {
    conceptIds: source.conceptIds.slice(),
    role: source.role ? mapAdviceArgumentRole(source.role) : undefined
  };
}

function buildAdviceFrameMatcher(source: AdviceFrameMatcherSource): AdviceFrameMatcher {
  const argConcepts: AdviceArgConceptMatcher[] = [];
  if (source.argConcepts) {
    for (const argConcept of source.argConcepts) {
      argConcepts.push(buildAdviceArgConceptMatcher(argConcept));
    }
  }
  const relations: AdviceRelation[] = [];
  if (source.relations) {
    for (const relation of source.relations) {
      const mapped = mapAdviceRelation(relation);
      if (mapped) {
        relations.push(mapped);
      }
    }
  }
  return {
    predicateLemmas: source.predicateLemmas ? source.predicateLemmas.slice() : undefined,
    predicateSemanticClasses: source.predicateSemanticClasses
      ? source.predicateSemanticClasses.slice()
      : undefined,
    relations: relations.length ? relations : undefined,
    force: source.force ? mapAdviceForce(source.force) : undefined,
    polarity: mapAdvicePolarity(source.polarity),
    argConcepts: argConcepts.length ? argConcepts : undefined
  };
}

function buildAdviceMatcher(source: AdviceMatcherSource): AdviceMatcher {
  if ("allOf" in source) {
    const allOf: AdviceMatcher[] = [];
    for (const item of source.allOf) {
      allOf.push(buildAdviceMatcher(item));
    }
    return { allOf };
  }
  if ("anyOf" in source) {
    const anyOf: AdviceMatcher[] = [];
    for (const item of source.anyOf) {
      anyOf.push(buildAdviceMatcher(item));
    }
    return { anyOf };
  }
  if ("not" in source) {
    return { not: buildAdviceMatcher(source.not) };
  }
  if ("frame" in source) {
    return { frame: buildAdviceFrameMatcher(source.frame) };
  }
  if ("argConcept" in source) {
    return { argConcept: buildAdviceArgConceptMatcher(source.argConcept) };
  }
  const normalizedTexts: string[] = [];
  for (const value of source.normalizedTexts) {
    const normalized = normalizeAdditionalInstructionKey(value);
    if (normalized) {
      normalizedTexts.push(normalized);
    }
  }
  return { normalizedTexts };
}

function buildAdviceCodingRule(source: AdviceCodingRuleSource): AdviceCodingRule {
  const frames: AdviceFrameTemplate[] = [];
  for (const frame of source.frames) {
    frames.push(buildAdviceFrameTemplate(frame));
  }
  let matcher = buildAdviceMatcher(source.matcher);
  const thaiVerbSuffix = source.definition.thaiVerbSuffix?.trim();
  if (thaiVerbSuffix) {
    const normalized = normalizeAdditionalInstructionKey(thaiVerbSuffix);
    if (normalized) matcher = { anyOf: [matcher, { normalizedTexts: [normalized] }] };
  }
  return {
    id: source.id,
    definition: createDefinitionFromSource(source.definition),
    frames,
    matcher
  };
}

const ADDITIONAL_INSTRUCTION_RULES: AdviceCodingRule[] = [];

for (const sourceRule of ADVICE_RULES.rules) {
  ADDITIONAL_INSTRUCTION_RULES.push(buildAdviceCodingRule(sourceRule));
}

function frameHasArgConcept(frame: AdviceFrame, matcher: AdviceArgConceptMatcher): boolean {
  for (const arg of frame.args) {
    if (matcher.role && arg.role !== matcher.role) {
      continue;
    }
    for (const conceptId of matcher.conceptIds) {
      if (arg.conceptId === conceptId) {
        return true;
      }
    }
  }
  return false;
}

function frameMatches(frame: AdviceFrame, matcher: AdviceFrameMatcher): boolean {
  if (matcher.force && frame.force !== matcher.force) {
    return false;
  }
  if (matcher.polarity && frame.polarity !== matcher.polarity) {
    return false;
  }
  if (matcher.relations) {
    let relationMatched = false;
    for (const relation of matcher.relations) {
      if (frame.relation === relation) {
        relationMatched = true;
        break;
      }
    }
    if (!relationMatched) {
      return false;
    }
  }
  if (matcher.predicateLemmas) {
    let predicateMatched = false;
    for (const lemma of matcher.predicateLemmas) {
      if (frame.predicate.lemma === lemma) {
        predicateMatched = true;
        break;
      }
    }
    if (!predicateMatched) {
      return false;
    }
  }
  if (matcher.predicateSemanticClasses) {
    let semanticClassMatched = false;
    for (const semanticClass of matcher.predicateSemanticClasses) {
      if (frame.predicate.semanticClass === semanticClass) {
        semanticClassMatched = true;
        break;
      }
    }
    if (!semanticClassMatched) {
      return false;
    }
  }
  if (matcher.argConcepts) {
    for (const argConcept of matcher.argConcepts) {
      if (!frameHasArgConcept(frame, argConcept)) {
        return false;
      }
    }
  }
  return true;
}

function matchesAdviceMatcher(
  frames: AdviceFrame[],
  normalizedText: string,
  matcher: AdviceMatcher
): boolean {
  if ("allOf" in matcher) {
    for (const item of matcher.allOf) {
      if (!matchesAdviceMatcher(frames, normalizedText, item)) {
        return false;
      }
    }
    return true;
  }
  if ("anyOf" in matcher) {
    for (const item of matcher.anyOf) {
      if (matchesAdviceMatcher(frames, normalizedText, item)) {
        return true;
      }
    }
    return false;
  }
  if ("not" in matcher) {
    return !matchesAdviceMatcher(frames, normalizedText, matcher.not);
  }
  if ("frame" in matcher) {
    for (const frame of frames) {
      if (frameMatches(frame, matcher.frame)) {
        return true;
      }
    }
    return false;
  }
  if ("argConcept" in matcher) {
    for (const frame of frames) {
      if (frameHasArgConcept(frame, matcher.argConcept)) {
        return true;
      }
    }
    return false;
  }
  for (const value of matcher.normalizedTexts) {
    if (normalizedText === value) {
      return true;
    }
  }
  return false;
}

function findRuleByCoding(system: string, code: string): AdviceCodingRule | undefined {
  for (const rule of ADDITIONAL_INSTRUCTION_RULES) {
    if (rule.definition.coding?.system !== system) {
      continue;
    }
    if (rule.definition.coding?.code !== code) {
      continue;
    }
    return rule;
  }
  return undefined;
}

function createArgument(
  role: AdviceArgumentRole,
  text: string,
  normalized?: string,
  conceptId?: string
): AdviceArgument {
  return {
    role,
    text,
    normalized,
    conceptId
  };
}

function createFrame(
  sourceText: string,
  span: TextRange,
  force: AdviceForce,
  predicateLemma: string,
  predicateSemanticClass: string | undefined,
  args: AdviceArgument[],
  sequenceIndex: number,
  relation?: AdviceRelation,
  polarity?: AdvicePolarity,
  modality?: AdviceModality
): AdviceFrame {
  return {
    force,
    polarity,
    modality,
    predicate: {
      lemma: predicateLemma,
      semanticClass: predicateSemanticClass
    },
    relation,
    args,
    span,
    sourceText,
    sequenceIndex
  };
}

function instantiateTemplateFrames(
  templates: AdviceFrameTemplate[],
  sourceText: string,
  span: TextRange
): AdviceFrame[] {
  const frames: AdviceFrame[] = [];
  let index = 0;
  for (const template of templates) {
    const args: AdviceArgument[] = [];
    for (const templateArg of template.args) {
      args.push(
        createArgument(
          templateArg.role,
          templateArg.text,
          normalizeAdditionalInstructionKey(templateArg.text),
          templateArg.conceptId
        )
      );
    }
    frames.push(
      createFrame(
        sourceText,
        span,
        template.force,
        template.predicate.lemma,
        template.predicate.semanticClass,
        args,
        index,
        template.relation,
        template.polarity
      )
    );
    index += 1;
  }
  return frames;
}

function findNormalizedLexeme(surface: string, partOfSpeech?: string): AdviceLexemeEntry | undefined {
  const key = normalizeAdditionalInstructionKey(surface);
  const bucket = LEXEMES_BY_SURFACE[key];
  if (!bucket) {
    return undefined;
  }
  for (const entry of bucket) {
    if (partOfSpeech && entry.partOfSpeech !== partOfSpeech) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function findContainedConcept(normalized: string): AdviceConceptEntry | undefined {
  let best: AdviceConceptEntry | undefined;
  let bestLength = 0;
  for (const entry of CONCEPT_LIST) {
    const key = normalizeAdditionalInstructionKey(entry.surface);
    if (!key) {
      continue;
    }
    if (normalized !== key && !normalized.includes(key)) {
      continue;
    }
    if (key.length <= bestLength) {
      continue;
    }
    best = entry;
    bestLength = key.length;
  }
  return best;
}

function findExactConcept(normalized: string): AdviceConceptEntry | undefined {
  const bucket = CONCEPTS_BY_SURFACE[normalized];
  if (!bucket) {
    return undefined;
  }
  for (const entry of bucket) {
    return entry;
  }
  return undefined;
}

function findVerbLexeme(word: string): AdviceLexemeEntry | undefined {
  return findNormalizedLexeme(word, "verb");
}

function findVerbLemma(word: string): string | undefined {
  return findVerbLexeme(word)?.lemma;
}

function findModalLexeme(word: string): AdviceLexemeEntry | undefined {
  const entry = findNormalizedLexeme(word, "modifier");
  if (!entry || entry.semanticClass !== "modal") {
    return undefined;
  }
  return entry;
}

function mapModalLemmaToModality(lemma: string | undefined): AdviceModality | undefined {
  return enumValue<AdviceModality>(AdviceModality, lemma);
}

function containsConceptId(normalized: string, conceptId: string): boolean {
  const keys = CONCEPT_KEYS_BY_ID[conceptId];
  if (!keys) {
    return false;
  }
  for (const key of keys) {
    if (normalized === key || normalized.includes(key)) {
      return true;
    }
  }
  return false;
}

function containsVerbLemma(words: string[], lemma: string): boolean {
  for (const word of words) {
    if (findVerbLemma(word) === lemma) {
      return true;
    }
  }
  return false;
}

function containsVerbSequence(words: string[], leadLemma: string, targetLemma: string): boolean {
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (findVerbLemma(words[index]) !== leadLemma) {
      continue;
    }
    if (findVerbLemma(words[index + 1]) === targetLemma) {
      return true;
    }
  }
  return false;
}

interface AdviceNegationPrefixMatch {
  end: number;
  modality?: AdviceModality;
}

function consumeNegationPrefix(words: string[], start: number): AdviceNegationPrefixMatch | undefined {
  if (start >= words.length) return undefined;
  for (const prefix of ADVICE_TERMINOLOGY.grammar.negationPrefixes) {
    if (start + prefix.parts.length > words.length) continue;
    const matched = prefix.parts.every((part, offset) => words[start + offset] === part);
    if (!matched) continue;
    return {
      end: start + prefix.parts.length,
      modality: mapModalLemmaToModality(prefix.modality)
    };
  }
  return undefined;
}

function parseLeadingClauseFeatures(words: string[]): AdviceClausePrefix | undefined {
  let cursor = skipLeadingNoise(words);
  if (cursor >= words.length) return undefined;

  let modality: AdviceModality | undefined;
  const modalLexeme = findModalLexeme(words[cursor]);
  if (modalLexeme) {
    modality = mapModalLemmaToModality(modalLexeme.lemma);
    cursor += 1;
  }
  if (cursor >= words.length) return { cursor, modality };

  const negation = consumeNegationPrefix(words, cursor);
  if (!negation) return { cursor, modality };
  return {
    cursor: negation.end,
    modality: negation.modality ?? modality,
    polarity: AdvicePolarity.Negate
  };
}

function deriveClauseForce(
  sequenceCount: number,
  context: AdviceParseContext,
  _predicateLemma: string,
  predicateSemanticClass: string | undefined,
  polarity: AdvicePolarity | undefined,
  modality: AdviceModality | undefined
): AdviceForce {
  if (sequenceCount > 1) return AdviceForce.Sequence;
  if (predicateSemanticClass && WARNING_PREDICATE_SEMANTIC_CLASSES.has(predicateSemanticClass)) {
    return AdviceForce.Warning;
  }
  if (modality && WARNING_MODALITIES.has(modality)) return AdviceForce.Warning;
  if (modality && CAUTION_MODALITIES.has(modality)) return AdviceForce.Caution;
  if (polarity === AdvicePolarity.Negate) return AdviceForce.Warning;
  return context.defaultForce ?? AdviceForce.Instruction;
}

function containsNegatedVerb(words: string[], lemma: string): boolean {
  for (let index = 0; index < words.length; index += 1) {
    const negation = consumeNegationPrefix(words, index);
    if (negation && negation.end < words.length && findVerbLemma(words[negation.end]) === lemma) {
      return true;
    }
  }
  return false;
}

function mapSemanticClassToRole(semanticClass: string | undefined): AdviceArgumentRole {
  const configured = semanticClass ? SEMANTIC_CLASS_ROLES[semanticClass] : undefined;
  return enumValue<AdviceArgumentRole>(AdviceArgumentRole, configured) ?? AdviceArgumentRole.Object;
}

function classifyArgument(text: string): AdviceArgument {
  const cleaned = cleanFreeText(text);
  const normalized = normalizeAdditionalInstructionKey(cleaned);
  if (!normalized) {
    return createArgument(AdviceArgumentRole.Free, cleaned, normalized);
  }

  const concept = findContainedConcept(normalized);
  if (concept) {
    return createArgument(
      mapSemanticClassToRole(concept.semanticClass),
      cleaned,
      normalized,
      concept.conceptId
    );
  }

  const parts = normalized.split(" ");
  if (parts.length >= 2) {
    const first = parts[0];
    const second = parts[1];
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(first) && DURATION_UNIT_WORDS.has(second)) {
      return createArgument(AdviceArgumentRole.Duration, cleaned, normalized);
    }
  }

  if (SIMPLE_TIME_WORDS.has(normalized)) {
    return createArgument(AdviceArgumentRole.Time, cleaned, normalized, normalized);
  }

  return createArgument(AdviceArgumentRole.Object, cleaned, normalized);
}

function trimSegment(text: string, start: number, end: number): AdviceSegment | undefined {
  while (start < end) {
    const char = text[start];
    if (/\s/.test(char) || char === "," || char === ";" || char === ":" || char === "-" || char === ".") {
      start += 1;
      continue;
    }
    break;
  }
  while (end > start) {
    const char = text[end - 1];
    if (/\s/.test(char) || char === "," || char === ";" || char === ":" || char === "-" || char === ".") {
      end -= 1;
      continue;
    }
    break;
  }
  if (end <= start) {
    return undefined;
  }
  return {
    text: text.slice(start, end),
    range: { start, end }
  };
}

function splitInstructionSegments(sourceText: string, baseRange: TextRange): AdviceSegment[] {
  const segments: AdviceSegment[] = [];
  let segmentStart = 0;
  for (let index = 0; index < sourceText.length; index++) {
    const char = sourceText[index];
    if (char !== ";" && char !== "." && char !== "\n" && char !== "\r") {
      continue;
    }
    if (char === ".") {
      const previous = index > 0 ? sourceText[index - 1] : "";
      const next = index + 1 < sourceText.length ? sourceText[index + 1] : "";
      if (/\d/.test(previous) && /\d/.test(next)) {
        continue;
      }
    }
    const trimmed = trimSegment(sourceText, segmentStart, index);
    if (trimmed) {
      segments.push({
        text: trimmed.text,
        range: {
          start: baseRange.start + trimmed.range.start,
          end: baseRange.start + trimmed.range.end
        }
      });
    }
    segmentStart = index + 1;
  }
  const finalTrimmed = trimSegment(sourceText, segmentStart, sourceText.length);
  if (finalTrimmed) {
    segments.push({
      text: finalTrimmed.text,
      range: {
        start: baseRange.start + finalTrimmed.range.start,
        end: baseRange.start + finalTrimmed.range.end
      }
    });
  }
  if (segments.length) {
    return segments;
  }
  const single = trimSegment(sourceText, 0, sourceText.length);
  if (!single) {
    return [];
  }
  return [
    {
      text: single.text,
      range: {
        start: baseRange.start + single.range.start,
        end: baseRange.start + single.range.end
      }
    }
  ];
}

function splitSequenceSegments(sourceText: string, baseRange: TextRange): AdviceSegment[] {
  const tokens = lexInput(sourceText);
  if (!tokens.length) {
    return [];
  }
  const segments: AdviceSegment[] = [];
  let segmentStart = 0;
  for (const token of tokens) {
    if (!SEQUENCE_MARKERS.has(normalizeAdditionalInstructionKey(token.original))) {
      continue;
    }
    const trimmed = trimSegment(sourceText, segmentStart, token.sourceStart);
    if (trimmed) {
      segments.push({
        text: trimmed.text,
        range: {
          start: baseRange.start + trimmed.range.start,
          end: baseRange.start + trimmed.range.end
        }
      });
    }
    segmentStart = token.sourceEnd;
  }
  const finalTrimmed = trimSegment(sourceText, segmentStart, sourceText.length);
  if (finalTrimmed) {
    segments.push({
      text: finalTrimmed.text,
      range: {
        start: baseRange.start + finalTrimmed.range.start,
        end: baseRange.start + finalTrimmed.range.end
      }
    });
  }
  if (segments.length > 1) {
    return segments;
  }
  return [
    {
      text: sourceText,
      range: baseRange
    }
  ];
}

function isKnownVerb(word: string): boolean {
  const entry = findNormalizedLexeme(word, "verb");
  return Boolean(entry);
}

function isAdministrationWord(word: string): boolean {
  return ADMINISTRATION_PREDICATES.has(word);
}

function isRelationWord(word: string): AdviceRelation | undefined {
  const entry = findNormalizedLexeme(word, "relation");
  return entry ? enumValue<AdviceRelation>(AdviceRelation, entry.lemma) : undefined;
}

function parseAdviceRelation(value: string | undefined): AdviceRelation | undefined {
  return enumValue<AdviceRelation>(AdviceRelation, value);
}

function normalizeWords(text: string): string[] {
  const normalized = normalizeAdditionalInstructionKey(text);
  if (!normalized) {
    return [];
  }
  return normalized.split(" ");
}

function skipLeadingNoise(words: string[]): number {
  let cursor = 0;
  while (cursor < words.length && LEADING_NOISE_WORDS.has(words[cursor])) {
    cursor += 1;
  }
  if (
    cursor + 1 < words.length &&
    isAdministrationWord(words[cursor]) &&
    isRelationWord(words[cursor + 1])
  ) {
    cursor += 1;
  }
  if (
    cursor + 2 < words.length &&
    /^[0-9]+(?:\.[0-9]+)?$/.test(words[cursor]) &&
    DURATION_UNIT_WORDS.has(words[cursor + 1]) &&
    isRelationWord(words[cursor + 2])
  ) {
    cursor += 2;
  }
  return cursor;
}

function createDefaultForce(sequenceCount: number, sequenceIndex: number, context: AdviceParseContext): AdviceForce {
  if (sequenceCount > 1 || sequenceIndex > 0) {
    return AdviceForce.Sequence;
  }
  return context.defaultForce ?? AdviceForce.Instruction;
}

function tryParseRelationInstruction(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (!words.length) {
    return undefined;
  }
  let cursor = skipLeadingNoise(words);
  const relation = cursor < words.length ? isRelationWord(words[cursor]) : undefined;
  if (!relation) {
    return undefined;
  }
  cursor += 1;
  if (cursor >= words.length) {
    return undefined;
  }
  const objectText = words.slice(cursor).join(" ");
  if (!objectText) {
    return undefined;
  }
  const force = createDefaultForce(sequenceCount, sequenceIndex, context);
  const args = [classifyArgument(objectText)];
  return [
    createFrame(
      sourceText,
      span,
      force,
      context.defaultPredicate,
      "administration",
      args,
      sequenceIndex,
      relation
    )
  ];
}

function tryParseImplicitConceptInstruction(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (!words.length) {
    return undefined;
  }
  const cursor = skipLeadingNoise(words);
  if (cursor >= words.length) {
    return undefined;
  }
  if (isRelationWord(words[cursor]) || isKnownVerb(words[cursor])) {
    return undefined;
  }
  const conceptText = words.slice(cursor).join(" ");
  if (!conceptText) {
    return undefined;
  }
  const concept = findExactConcept(conceptText);
  if (!concept) {
    return undefined;
  }
  const relation = parseAdviceRelation(concept.implicitRelation);
  if (!relation) {
    return undefined;
  }
  return [
    createFrame(
      sourceText,
      span,
      createDefaultForce(sequenceCount, sequenceIndex, context),
      context.defaultPredicate,
      "administration",
      [
        createArgument(
          mapSemanticClassToRole(concept.semanticClass),
          conceptText,
          conceptText,
          concept.conceptId
        )
      ],
      sequenceIndex,
      relation
    )
  ];
}

function parseEmbeddedAvoidanceFrames(
  words: string[],
  normalized: string,
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] {
  const frames: AdviceFrame[] = [];
  const force = sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning;

  if (
    containsConceptId(normalized, "alcohol") &&
    (
      containsVerbLemma(words, "avoid") ||
      containsNegatedVerb(words, "drink") ||
      (words.length >= 2 && NEGATIVE_NOMINAL_LEADS.has(words[0]))
    )
  ) {
    frames.push(
      createFrame(
        sourceText,
        span,
        force,
        "avoid",
        "avoidance",
        [createArgument(AdviceArgumentRole.Substance, "alcohol", "alcohol", "alcohol")],
        sequenceIndex
      )
    );
  }

  if (containsVerbSequence(words, "avoid", "drive") || containsNegatedVerb(words, "drive")) {
    frames.push(
      createFrame(
        sourceText,
        span,
        force,
        "drive",
        "activity",
        [],
        sequenceIndex,
        undefined,
        AdvicePolarity.Negate
      )
    );
  }

  return frames;
}

function tryParseNoObjectInstruction(
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (words.length < 2) {
    return undefined;
  }
  const cursor = skipLeadingNoise(words);
  if (cursor >= words.length || !NEGATIVE_NOMINAL_LEADS.has(words[cursor])) {
    return undefined;
  }
  const objectText = words.slice(cursor + 1).join(" ");
  const argument = classifyArgument(objectText);
  if (argument.role === AdviceArgumentRole.Substance) {
    return [
      createFrame(
        sourceText,
        span,
        sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
        "drink",
        "ingest",
        [argument],
        sequenceIndex,
        undefined,
        AdvicePolarity.Negate
      )
    ];
  }
  const objectWords = normalizeWords(objectText);
  if (objectWords.length === 1) {
    const verbLexeme = findVerbLexeme(objectWords[0]);
    if (verbLexeme) {
      return [
        createFrame(
          sourceText,
          span,
          sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
          verbLexeme.lemma,
          verbLexeme.semanticClass,
          [],
          sequenceIndex,
          undefined,
          AdvicePolarity.Negate
        )
      ];
    }
  }
  return undefined;
}

function tryParseEllipticalEffectInstruction(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (!words.length) {
    return undefined;
  }

  const prefix = parseLeadingClauseFeatures(words);
  if (!prefix || prefix.cursor >= words.length || prefix.polarity) {
    return undefined;
  }

  if (!prefix.modality || !WARNING_MODALITIES.has(prefix.modality)) {
    return undefined;
  }

  if (isKnownVerb(words[prefix.cursor]) || isRelationWord(words[prefix.cursor])) {
    return undefined;
  }

  const objectText = words.slice(prefix.cursor).join(" ");
  if (!objectText) {
    return undefined;
  }
  const concept = findExactConcept(objectText);
  if (!concept || !ELLIPTICAL_EFFECT_SEMANTIC_CLASSES.has(concept.semanticClass)) {
    return undefined;
  }

  return [
    createFrame(
      sourceText,
      span,
      deriveClauseForce(
        sequenceCount,
        context,
        "cause",
        "effect",
        undefined,
        prefix.modality
      ),
      "cause",
      "effect",
      [
        createArgument(
          mapSemanticClassToRole(concept.semanticClass),
          objectText,
          objectText,
          concept.conceptId
        )
      ],
      sequenceIndex,
      undefined,
      undefined,
      prefix.modality
    )
  ];
}

function tryParseStyleInstruction(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const normalized = normalizeAdditionalInstructionKey(sourceText);
  if (!normalized) {
    return undefined;
  }
  let styleText = normalized;
  if (normalized.startsWith("apply ")) {
    styleText = normalized.slice("apply ".length);
  }
  const lexeme = findNormalizedLexeme(styleText);
  if (
    !lexeme ||
    !STYLE_SEMANTIC_CLASSES.has(lexeme.semanticClass ?? "")
  ) {
    return undefined;
  }
  const concept = findContainedConcept(styleText);
  return [
    createFrame(
      sourceText,
      span,
      createDefaultForce(sequenceCount, sequenceIndex, context),
      context.defaultPredicate,
      "administration",
      [
        createArgument(
          mapSemanticClassToRole(lexeme.semanticClass),
          styleText,
          styleText,
          concept?.conceptId
        )
      ],
      sequenceIndex
    )
  ];
}

interface AdviceVerbArgumentParse {
  relation?: AdviceRelation;
  args: AdviceArgument[];
}

type AdviceVerbArgumentParser = (words: string[]) => AdviceVerbArgumentParse;

const DEFAULT_ADVICE_VERB_ARGUMENT_PARSER: AdviceVerbArgumentParser = (remainderWords) => {
  const relation = remainderWords.length ? isRelationWord(remainderWords[0]) : undefined;
  const objectText = remainderWords.slice(relation ? 1 : 0).join(" ");
  return { relation, args: objectText ? [classifyArgument(objectText)] : [] };
};

const LEAVE_ON_ADVICE_VERB_ARGUMENT_PARSER: AdviceVerbArgumentParser = (remainderWords) => {
  if (isRelationWord(remainderWords[0]) !== AdviceRelation.On) {
    return DEFAULT_ADVICE_VERB_ARGUMENT_PARSER(remainderWords);
  }
  const args = [createArgument(AdviceArgumentRole.Theme, AdviceRelation.On, AdviceRelation.On)];
  let relation: AdviceRelation | undefined;
  if (remainderWords.length > 1) {
    const nextRelation = isRelationWord(remainderWords[1]);
    if (nextRelation) {
      relation = nextRelation;
      const tail = remainderWords.slice(2).join(" ");
      if (tail) args.push(classifyArgument(tail));
    } else {
      const tail = remainderWords.slice(1).join(" ");
      if (tail) args.push(classifyArgument(tail));
    }
  }
  return { relation, args };
};

const ADVICE_VERB_ARGUMENT_PARSERS: Record<string, AdviceVerbArgumentParser> = {
  default: DEFAULT_ADVICE_VERB_ARGUMENT_PARSER,
  "leave-on": LEAVE_ON_ADVICE_VERB_ARGUMENT_PARSER
};

function tryParseClauseInstruction(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (!words.length) {
    return undefined;
  }
  const prefix = parseLeadingClauseFeatures(words);
  if (!prefix || prefix.cursor >= words.length) {
    return undefined;
  }

  const verbEntries: AdviceLexemeEntry[] = [];
  let remainderStart = prefix.cursor;
  while (remainderStart < words.length) {
    const verbEntry = findVerbLexeme(words[remainderStart]);
    if (!verbEntry) {
      break;
    }
    verbEntries.push(verbEntry);
    remainderStart += 1;
    if (
      remainderStart < words.length &&
      VERB_CONNECTOR_WORDS.has(words[remainderStart]) &&
      remainderStart + 1 < words.length &&
      isKnownVerb(words[remainderStart + 1])
    ) {
      remainderStart += 1;
      continue;
    }
    break;
  }

  if (!verbEntries.length) {
    return undefined;
  }

  const remainderWords = words.slice(remainderStart);
  const primaryVerb = verbEntries[0];
  const argumentParser = ADVICE_VERB_ARGUMENT_PARSERS[primaryVerb.parserProfile ?? "default"] ??
    DEFAULT_ADVICE_VERB_ARGUMENT_PARSER;
  const parsedArguments = argumentParser(remainderWords);
  const relation = parsedArguments.relation;
  const args = parsedArguments.args;

  if (
    !args.length &&
    !relation &&
    ADMINISTRATION_PREDICATES.has(primaryVerb.lemma)
  ) {
    return undefined;
  }

  const frames: AdviceFrame[] = [];
  for (const verbEntry of verbEntries) {
    frames.push(
      createFrame(
        sourceText,
        span,
        deriveClauseForce(
          sequenceCount,
          context,
          verbEntry.lemma,
          verbEntry.semanticClass,
          prefix.polarity,
          prefix.modality
        ),
        verbEntry.lemma,
        verbEntry.semanticClass,
        args,
        sequenceIndex,
        relation,
        prefix.polarity,
        prefix.modality
      )
    );
  }

  if (
    frames.length === 1 &&
    frames[0].args.length === 1 &&
    Boolean(frames[0].args[0].conceptId &&
      EMBEDDED_AVOIDANCE_TRIGGER_CONCEPT_IDS.has(frames[0].args[0].conceptId as string))
  ) {
    const embedded = parseEmbeddedAvoidanceFrames(
      words,
      words.join(" "),
      sourceText,
      span,
      sequenceIndex,
      sequenceCount
    );
    if (embedded.length) {
      for (const frame of embedded) {
        frames.push(frame);
      }
    }
  }

  return frames;
}

function parseSequenceFrames(
  sourceText: string,
  span: TextRange,
  context: AdviceParseContext
): AdviceFrame[] {
  const sequenceSegments = splitSequenceSegments(sourceText, span);
  if (!sequenceSegments.length) {
    return [];
  }
  const frames: AdviceFrame[] = [];
  for (let index = 0; index < sequenceSegments.length; index++) {
    const segment = sequenceSegments[index];
    const parsed =
      tryParseRelationInstruction(segment.text, segment.range, context, index, sequenceSegments.length) ??
      tryParseImplicitConceptInstruction(segment.text, segment.range, context, index, sequenceSegments.length) ??
      tryParseStyleInstruction(segment.text, segment.range, context, index, sequenceSegments.length) ??
      tryParseNoObjectInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseEllipticalEffectInstruction(
        segment.text,
        segment.range,
        context,
        index,
        sequenceSegments.length
      ) ??
      tryParseClauseInstruction(segment.text, segment.range, context, index, sequenceSegments.length);
    if (!parsed) {
      return [];
    }
    for (const frame of parsed) {
      frames.push(frame);
    }
  }
  return frames;
}

function matchAdviceCodingRule(
  frames: AdviceFrame[],
  normalizedText: string
): AdviceCodingRule | undefined {
  for (const rule of ADDITIONAL_INSTRUCTION_RULES) {
    if (matchesAdviceMatcher(frames, normalizedText, rule.matcher)) {
      return rule;
    }
  }
  return undefined;
}

function cloneDefinitionCoding(
  coding: FhirCoding | undefined,
  i18n: Record<string, string> | undefined
): (FhirCoding & { i18n?: Record<string, string> }) | undefined {
  if (!coding?.code && !coding?.display && !coding?.system) {
    return undefined;
  }
  return {
    code: coding.code,
    display: coding.display,
    system: coding.system,
    i18n
  };
}

function shouldAllowFallbackText(sourceText: string, allowFreeTextFallback: boolean | undefined): boolean {
  return Boolean(allowFreeTextFallback && cleanFreeText(sourceText));
}

function capitalizeSentence(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function realizeAdviceModality(modality: AdviceModality | undefined): string | undefined {
  return modality ? capitalizeSentence(modality) : undefined;
}

function joinAdviceArgumentTexts(args: AdviceArgument[]): string | undefined {
  let text = "";
  let added = 0;
  for (const arg of args) {
    const trimmed = cleanFreeText(arg.text);
    if (!trimmed) {
      continue;
    }
    if (added > 0) {
      text += added === 1 ? " and " : ", ";
    }
    text += trimmed;
    added += 1;
  }
  return text || undefined;
}

interface AdviceRealizationContext {
  frame: AdviceFrame;
  argText?: string;
  modalityText?: string;
}

type AdvicePredicateRealizer = (context: AdviceRealizationContext) => string;

const DEFAULT_ADVICE_PREDICATE_REALIZER: AdvicePredicateRealizer = ({ frame, argText, modalityText }) => {
  let text = modalityText
    ? `${modalityText} ${frame.predicate.lemma}`
    : capitalizeSentence(frame.predicate.lemma);
  if (frame.relation) text += ` ${frame.relation}`;
  if (argText) text += ` ${argText}`;
  return text;
};

const AVOIDANCE_ADVICE_PREDICATE_REALIZER: AdvicePredicateRealizer = ({ frame, argText, modalityText }) => {
  const predicate = modalityText
    ? `${modalityText} ${frame.predicate.lemma}`
    : capitalizeSentence(frame.predicate.lemma);
  return argText ? `${predicate} ${argText}` : predicate;
};

const EFFECT_ADVICE_PREDICATE_REALIZER: AdvicePredicateRealizer = ({ frame, argText, modalityText }) => {
  const effectiveModality = modalityText ?? capitalizeSentence(AdviceModality.May);
  const predicate = `${effectiveModality} ${frame.predicate.lemma}`;
  return argText ? `${predicate} ${argText}` : predicate;
};

const ADVICE_PREDICATE_REALIZERS: Record<string, AdvicePredicateRealizer> = {
  default: DEFAULT_ADVICE_PREDICATE_REALIZER,
  avoidance: AVOIDANCE_ADVICE_PREDICATE_REALIZER,
  effect: EFFECT_ADVICE_PREDICATE_REALIZER
};

function realizeSingleAdviceFrame(frame: AdviceFrame): string | undefined {
  const argText = joinAdviceArgumentTexts(frame.args);
  const modalityText = realizeAdviceModality(frame.modality);
  if (frame.polarity === AdvicePolarity.Negate) {
    let text = `${frame.modality === AdviceModality.Must ? "Must not" : "Do not"} ${frame.predicate.lemma}`;
    if (frame.relation) text += ` ${frame.relation}`;
    if (argText) text += ` ${argText}`;
    return text;
  }

  const lexeme = findVerbLexeme(frame.predicate.lemma);
  const realizer = ADVICE_PREDICATE_REALIZERS[lexeme?.realizerProfile ?? "default"] ??
    DEFAULT_ADVICE_PREDICATE_REALIZER;
  return realizer({ frame, argText, modalityText });
}

function realizeAdviceFramesText(frames: AdviceFrame[]): string | undefined {
  if (frames.length !== 1) {
    return undefined;
  }
  const realized = realizeSingleAdviceFrame(frames[0]);
  return realized ? capitalizeSentence(realized) : undefined;
}

export function parseAdditionalInstructions(
  sourceText: string,
  span: TextRange,
  context?: AdviceParseContext
): ParsedAdditionalInstruction[] {
  const effectiveContext: AdviceParseContext = {
    defaultPredicate: context?.defaultPredicate ?? DEFAULT_INSTRUCTION_CONTEXT.defaultPredicate,
    defaultForce: context?.defaultForce ?? DEFAULT_INSTRUCTION_CONTEXT.defaultForce,
    allowFreeTextFallback:
      context?.allowFreeTextFallback ?? DEFAULT_INSTRUCTION_CONTEXT.allowFreeTextFallback
  };
  const instructions: ParsedAdditionalInstruction[] = [];
  const segments = splitInstructionSegments(sourceText, span);
  for (const segment of segments) {
    const cleanedText = cleanFreeText(segment.text);
    if (!cleanedText) {
      continue;
    }
    const normalizedText = normalizeAdditionalInstructionKey(cleanedText);
    const frames = parseSequenceFrames(cleanedText, segment.range, effectiveContext);
    const rule = normalizedText
      ? matchAdviceCodingRule(frames, normalizedText)
      : undefined;
    if (frames.length || rule) {
      const realizedText = rule ? undefined : realizeAdviceFramesText(frames);
      instructions.push({
        text: rule?.definition.text ?? realizedText ?? cleanedText,
        coding: cloneDefinitionCoding(rule?.definition.coding, rule?.definition.i18n),
        frames
      });
      continue;
    }
    if (!shouldAllowFallbackText(cleanedText, effectiveContext.allowFreeTextFallback)) {
      continue;
    }
    instructions.push({
      text: cleanedText,
      frames: []
    });
  }
  return instructions;
}

export function findAdditionalInstructionDefinitionByCoding(
  system: string,
  code: string
): AdditionalInstructionDefinition | undefined {
  return findRuleByCoding(system, code)?.definition;
}

export const __test__: {
  createDefinitionFromSource(source: {
    system?: string;
    code: string;
    display: string;
    text: string;
    thai: string;
  }): AdditionalInstructionDefinition;
} = {
  createDefinitionFromSource
};

export function buildAdditionalInstructionFramesFromCoding(
  system: string,
  code: string,
  sourceText?: string,
  span?: TextRange
): AdviceFrame[] | undefined {
  const rule = findRuleByCoding(system, code);
  if (!rule) {
    return undefined;
  }
  const resolvedText = sourceText ?? rule.definition.text ?? rule.definition.coding?.display ?? "";
  const resolvedSpan = span ?? { start: 0, end: resolvedText.length };
  return instantiateTemplateFrames(rule.frames, resolvedText, resolvedSpan);
}
