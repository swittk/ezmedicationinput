import { objectValues } from "./utils/object";
import { courseContinuationDurationAt, doseComparatorNumberAt, DOSE_COMPARATOR_PREFIXES } from "./hpsg/lexical-classes";
import { composeCoordinatedActionDirective, composePreposedContactTheme, licensesPreposedContactTheme } from "./hpsg/constructions";
import {
  resolveAdviceMannerModifier,
  matchComposedAdviceCodings,
  adviceCodingNeedsComposedScope
} from "./advice";
import {
  formBodySiteRestriction,
  realizeBodySiteRestriction,
  resolveBodySitePhrase,
  resolveBodySiteRestrictionPredicate
} from "./body-site-grammar";
import {
  BODY_SITE_SOURCE_LEAD_PREFIXES,
  stripBodySiteSourceLead
} from "./body-site-context-terminology";
import { lexInput } from "./lexer/lex";
import { normalizeUnit } from "./unit-lexicon";
import { EVENT_TIMING_TOKENS, PRODUCT_FORM_HINTS, TIMING_ABBREVIATIONS, WORD_FREQUENCIES } from "./maps";
import { resolveEventTimingExpression } from "./event-timing-expression";
import { maximumDosePerPeriodAt, parseClockToken } from "./hpsg/rule-context";
import { resolveSymptomDefinition } from "./symptom-terminology";
import { baseLanguageTag, composeLocalizedRecords, localizedConfig, localizedValue, quantityComparatorText } from "./localization";
import { inferMedicationLocale, shouldJoinAdjacentSourceTokens, withMedicationSourceI18n } from "./locale-detection";
import {
  getInstructionActionLocaleAdapter,
  instructionArgumentNeedsAuthoredDirections,
  instructionSiteRelation,
  instructionFrameSiteRelation,
  instructionFrameRelationOwnsTemporalArgument,
  instructionActionDefinitionForRealization,
  quantityOnlyInstructionArgument,
  realizeTimeArgument,
  InstructionActionRealizationInput
} from "./instruction-action-locale-adapter";
import { joinLocalizedTokens, localeRealizationProfile, localizedTimeArgument, renderLocaleTemplate } from "./locale-realization";
import {
  BODY_SITE_LOCATIVE_RELATION_PHRASES,
  getUniqueAdviceRelationByGrammarFeature,
  getAdviceRelationDefinition,
  getAdviceRelationSurfaceForms,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass,
  resolveActionRelationSurface,
  resolveAdviceRelationSurface,
  resolveActionRelationSurfaceByGrammarFeature
} from "./relation-terminology";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_DISCOURSE_CONNECTORS,
  coordinationConnectorKind,
  ACTION_COORDINATION_CONNECTOR_I18N,
  ACTION_DIRECTIVE_PREFIXES,
  ACTION_SEQUENCE_MARKERS,
  ACTION_SEQUENCE_RELATION_TOKENS,
  BODY_SITE_ATTRIBUTIVE_MODIFIERS,
  AS_NEEDED_LEAD_PHRASES,
  COMPOUND_DOSE_UNITS,
  DOSE_NUMBER_WORDS, DOSE_UNIT_CONNECTORS,
  DOSE_TARGET_EVENT_MEMBERS, DOSE_TARGET_MERIDIEM_CLOCK_RANGES,
  SUPPLEMENTAL_DOSE_MODIFIERS,
  DURATION_LEAD_TOKENS,
  compactDurationParts,
  EVENT_ARTICLE_TOKENS,
  EVENT_OFFSET_ARTICLES,
  EVENT_OFFSET_FRACTIONS,
  INSTRUCTION_DURATION_APPROXIMATION_LEADS,
  INSTRUCTION_START_WORDS,
  INSTRUCTION_DURATION_UNITS,
  INSTRUCTION_QUANTITY_UNIT_LABELS,
  MEAL_TIMING_BY_RELATION,
  PRN_LEADS,
  RANGE_CONNECTORS,
  ROUTE_SITE_PREPOSITIONS,
  SITE_ANCHORS,
  SITE_RELATIVE_MARKERS,
  methodAuxiliaryVerbsForLocale
} from "./hpsg/lexical-classes";
import { EVERY_INTERVAL_TOKENS, FREQUENCY_NUMBER_WORDS, FREQUENCY_SIMPLE_WORDS } from "./hpsg/timing-lexicon";
import {
  cloneMedicationInstructionConceptComponents,
  medicationInstructionConceptCodings,
  resolveMedicationInstructionConcept,
  getMedicationInstructionConcept
} from "./instruction-concept-terminology";
import {
  cloneMedicationInstructionActionRealizerConfig,
  medicationInstructionActionSemanticComponentsForArgs,
  medicationInstructionActionContextualCodings,
  getMedicationInstructionAction,
  medicationInstructionActionCodings,
  medicationInstructionActionLocaleRealizerConfig,
  normalizeActionSurface,
  resolveMedicationInstructionAction,
  resolveMedicationInstructionActionByMethod,
  resolveMedicationInstructionActionForMethod,
  resolveMedicationInstructionSequenceAction,
  resolveMedicationInstructionSeparableAction,
  medicationInstructionActionSpanLimit
} from "./instruction-action-terminology";
import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdviceModality,
  AdvicePolarity,
  AdviceRelation,
  CanonicalDoseExpr,
  CanonicalInstructionCoverage,
  CanonicalInstructionGraph,
  CanonicalInstructionRelation,
  CanonicalSigClause,
  CanonicalAdditionalInstructionExpr,
  CanonicalSourceSpan,
  EventTiming,
  FhirCoding,
  MedicationCondition,
  MedicationInstructionActionArgumentParser,
  MedicationInstructionActionDefinition,
  MedicationInstructionActionRealizer,
  ParseOptions,
  TextRange
} from "./types";

type ActionDefinition = MedicationInstructionActionDefinition;
type Lexeme = ReturnType<typeof lexInput>[number];
const SNOMED_SYSTEM = "http://snomed.info/sct";
const ACTION_ROUTE_TAIL_SURFACES = new Set([
  "sl", "sublingual", "sublingually",
  "buccal", "buccally",
  "po", "orally",
  "im", "intramuscularly",
  "iv", "intravenously",
  "sc", "sq", "subq", "subcutaneously",
  "topically", "transdermally",
  "rectally", "vaginally",
  "intranasally", "ophthalmically", "otically"
]);

function key(part: Lexeme | undefined): string {
  if (!part) return "";
  const lower = part.canonical ?? part.lower;
  let start = 0, end = lower.length;
  while (lower.charCodeAt(start) === 46) start++;
  while (end > start && lower.charCodeAt(end - 1) === 46) end--;
  return start === 0 && end === lower.length ? lower : lower.slice(start, end);
}

interface ActionMatch {
  definition: ActionDefinition;
  length: number;
  separableParticleIndex?: number;
}

function resultativeLeadAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): boolean {
  if (key(parts[index]) !== "do") return false;
  const next = parts[index + 1];
  if (!next) return false;
  return resolveMedicationInstructionConcept(key(next), options)?.role === AdviceArgumentRole.Result;
}

function actionAtIsGovernedByDirective(parts: Lexeme[], index: number): boolean {
  return ACTION_DIRECTIVE_PREFIXES.some((prefix) => {
    const start = index - prefix.parts.length;
    if (start < 0) return false;
    return prefix.parts.every((part, offset) => key(parts[start + offset]) === part);
  });
}

function actionPhraseCandidates(parts: Lexeme[], index: number, length: number): string[] {
  if (index + length > parts.length) return [];
  let canonical = "", spaced = "", contiguousText = "";
  let contiguous = true;
  for (let offset = 0; offset < length; offset += 1) {
    const part = parts[index + offset];
    const normalized = key(part);
    if (!normalized) return [];
    const separator = offset ? " " : "";
    canonical += separator + normalized;
    spaced += separator + part.original;
    if (offset && parts[index + offset - 1].sourceEnd !== part.sourceStart) contiguous = false;
    if (contiguous) contiguousText += part.original;
  }
  const candidates: string[] = [];
  if (canonical.trim()) candidates.push(canonical);
  if (spaced !== canonical && spaced.trim()) candidates.push(spaced);
  if (contiguous && contiguousText !== canonical && contiguousText !== spaced && contiguousText.trim())
    candidates.push(contiguousText);
  return candidates;
}

function actionCandidateIsAnchoredSiteModifier(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): boolean {
  if (!BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(key(parts[index]))) return false;
  let modifierStart = index;
  while (
    modifierStart > 0 &&
    BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(key(parts[modifierStart - 1]))
  ) modifierStart -= 1;
  const anchorIndex = modifierStart - 1;
  if (
    anchorIndex < 0 ||
    (!SITE_ANCHORS.has(key(parts[anchorIndex])) && !ROUTE_SITE_PREPOSITIONS.has(key(parts[anchorIndex])))
  ) return false;
  const maxEnd = Math.min(parts.length, index + 5);
  for (let end = index + 2; end <= maxEnd; end += 1) {
    const candidateText = parts
      .slice(modifierStart, end)
      .map((part) => part.original)
      .join(" ");
    const resolved = resolveBodySitePhrase(candidateText, options?.siteCodeMap, {
      bodySiteContext: options?.context?.bodySiteContext,
      allowTerminalModifierInheritance: true
    });
    if (resolved?.coding || resolved?.definition) return true;
  }
  return false;
}

function actionCandidateIsPerPeriodGrammar(parts: Lexeme[], index: number): boolean {
  const current = parts[index];
  const next = parts[index + 1];
  const previous = parts.slice(index - 1, index)[0];
  return Boolean(
    current && next && previous &&
    key(current) === "attach" && key(next) === "day" && key(previous) === "times"
  );
}

export function actionMatchAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): ActionMatch | undefined {
  const current = parts[index];
  const next = parts[index + 1];
  if (actionCandidateIsPerPeriodGrammar(parts, index) || courseContinuationDurationAt(parts, index)) return undefined;
  if (
    current && next &&
    AS_NEEDED_LEAD_PHRASES.has(`${key(current)} ${key(next)}`) &&
    !actionAtIsGovernedByDirective(parts, index)
  ) {
    return undefined;
  }
  const previous = parts[index - 1];
  const governingRelation = previous ? resolveActionRelationSurface(key(previous)) : undefined;
  const maxSpan = Math.min(medicationInstructionActionSpanLimit(key(current), options), parts.length - index);
  for (let length = maxSpan; length >= 1; length -= 1) {
    for (const candidate of actionPhraseCandidates(parts, index, length)) {
      const definition = previous && ACTION_SEQUENCE_MARKERS.has(key(previous))
        ? resolveMedicationInstructionSequenceAction(candidate, options) ??
          resolveMedicationInstructionAction(candidate, options)
        : resolveMedicationInstructionAction(candidate, options);
      if (definition) {
        if ((definition.directiveOnlyAliases?.indexOf(normalizeActionSurface(candidate)) ?? -1) >= 0 && previous &&
            !/^[,;.!?:]$/u.test(key(previous)) &&
            !ACTION_SEQUENCE_MARKERS.has(key(previous)) &&
            !ACTION_COORDINATION_CONNECTORS.has(key(previous)) &&
            !actionAtIsGovernedByDirective(parts, index)) continue;
        // A recognized nominal owns its modifier, even when the modifier is
        // also a verb: "contact lenses" is an object, "open wounds" a site,
        // and "double vision" is diplopia, not an instruction to double a dose.
        // Prefer the existing typed terminology over a bare action candidate;
        // "contact your doctor" and "double the dose" remain valid actions.
        if (length === 1 && next) {
          const phrase = key(current) + " " + key(next);
          const nominal = resolveMedicationInstructionConcept(phrase, options);
          if (nominal?.role === AdviceArgumentRole.Object ||
              nominal?.role === AdviceArgumentRole.Site ||
              resolveSymptomDefinition(phrase, options?.prnReasonMap, options?.symptomMap)) continue;
        }
        if (governingRelation) {
          const argument = parts[index + length];
          const unit = parts[index + length + 1];
          const explicitAdministration = !definition.procedural && definition.acceptsAmount &&
            argument && (argument.kind === "NUMBER" || argument.kind === "NUMBER_RANGE") &&
            unit && normalizeUnit(key(unit), options);
          // A bare activity remains a relational argument. A medication
          // head with its own amount is an event daughter with local valence.
          if (!explicitAdministration) continue;
        }
        const first = parts[index];
        const actionLocale = first
          ? baseLanguageTag(options?.locale) ?? inferMedicationLocale(first.original, "en")
          : "en";
        if (first && methodAuxiliaryVerbsForLocale(actionLocale).has(definition.code)) {
          const next = parts[index + length];
          const nextDefinition = next
            ? resolveMedicationInstructionAction(key(next), options)
            : undefined;
          const nextConcept = next
            ? resolveMedicationInstructionConcept(key(next), options)
            : undefined;
          if (nextDefinition || (definition.code === "give" && nextConcept?.role === AdviceArgumentRole.Result)) {
            continue;
          }
        }
        return { definition, length };
      }
    }
  }
  const lead = key(current);
  for (let particleIndex = index + 1; particleIndex < Math.min(parts.length, index + 9); particleIndex += 1) {
    const particle = parts[particleIndex];
    if (!particle || ACTION_SEQUENCE_MARKERS.has(key(particle))) break;
    const definition = resolveMedicationInstructionSeparableAction(lead, key(particle), options);
    if (definition) return { definition, length: 1, separableParticleIndex: particleIndex };
  }
  return undefined;
}
function sourceFor(parts: Lexeme[], start: number, endExclusive: number, input: string): string {
  const first = parts.slice(start, start + 1)[0];
  const last = parts.slice(endExclusive - 1, endExclusive)[0];
  return first && last ? input.slice(first.sourceStart, last.sourceEnd) : "";
}
function rangeFor(parts: Lexeme[], start: number, endExclusive: number, offset: number): TextRange {
  const first = parts.slice(start, start + 1)[0];
  const last = parts.slice(endExclusive - 1, endExclusive)[0];
  return { start: offset + (first?.sourceStart ?? 0), end: offset + (last?.sourceEnd ?? first?.sourceEnd ?? 0) };
}

function codingFromSite(text: string, options?: ParseOptions): AdviceArgument | undefined {
  const lookupText = stripBodySiteSourceLead(text) || text;
  const resolved = resolveBodySitePhrase(lookupText, options?.siteCodeMap, {
    bodySiteContext: options?.context?.bodySiteContext,
    allowTerminalModifierInheritance: true
  });
  if (!resolved || (!resolved.coding && !resolved.definition && !resolved.siteI18n)) return undefined;
  return {
    role: AdviceArgumentRole.Site,
    text,
    normalized: resolved.canonical,
    conceptId: resolved.canonical,
    coding: resolved.coding,
    codings: resolved.coding ? [resolved.coding] : undefined,
    i18n: withMedicationSourceI18n(text, {
      en: resolved.englishObjectText,
      ...(resolved.definition?.i18n ?? {}),
      ...(resolved.siteI18n ?? {})
    })
  };
}

function internalArgument(
  canonical: string,
  sourceText: string,
  options?: ParseOptions
): AdviceArgument | undefined {
  const definition = resolveMedicationInstructionConcept(canonical, options);
  if (!definition) return undefined;
  const codings = medicationInstructionConceptCodings(definition);
  const preferredCoding = codings[0];
  return {
    role: definition.role,
    text: sourceText,
    normalized: definition.display,
    conceptId: definition.code,
    ...(definition.components?.length ? { components: cloneMedicationInstructionConceptComponents(definition.components) } : {}),
    coding: preferredCoding,
    codings,
    i18n: { en: definition.display, ...(definition.i18n ?? {}) }
  };
}

function semanticArgumentBounds(
  parts: Lexeme[],
  start: number,
  endExclusive: number
): { start: number; endExclusive: number } {
  let first = start;
  let end = endExclusive;
  const punctuation = /^[,.;:!?()[\]{}]+$/;
  while (first < end && punctuation.test(parts[first]?.original ?? "")) first += 1;
  while (end > first && punctuation.test(parts[end - 1]?.original ?? "")) end -= 1;
  return { start: first, endExclusive: end };
}

function trimSemanticText(value: string): string {
  return value
    .replace(/^[\s([{]+/u, "")
    .replace(/[\s)\]}.!,;:]+$/u, "")
    .trim();
}

function trimActionRange(input: string, range: TextRange, offset: number): TextRange {
  let start = range.start;
  let end = range.end;
  while (start < end && /[\s([{]/u.test(input[start - offset] ?? "")) start += 1;
  while (end > start && /[\s)\]}.!,;:]/u.test(input[end - offset - 1] ?? "")) end -= 1;
  return { start, end };
}

function clockArgumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string
): AdviceArgument | undefined {
  // The same bounded clock grammar supplies HPSG schedules and a complete
  // temporal action daughter. Do not turn a clock into an opaque Object.
  ({ start, endExclusive } = semanticArgumentBounds(parts, start, endExclusive));
  if (start < endExclusive && endExclusive - start <= 2) {
    const clock = parseClockToken(parts[start], start + 1 < endExclusive ? parts[start + 1] : undefined);
    if (clock && clock.tokens.length === endExclusive - start) return {
      role: AdviceArgumentRole.Time,
      text: trimSemanticText(sourceFor(parts, start, endExclusive, input)),
      normalized: clock.value
    };
  }
  return undefined;
}

function timeArgumentFromParts(
  parts: Lexeme[], start: number, endExclusive: number, input: string, complete = false, options?: ParseOptions,
  nominalComplement = false
): AdviceArgument | undefined {
  ({ start, endExclusive } = semanticArgumentBounds(parts, start, endExclusive));
  const clock = clockArgumentFromParts(parts, start, endExclusive, input);
  if (clock) return clock;
  const canonicalParts = parts.slice(start, endExclusive).map((part) => key(part));
  // A coordinated nominal must consume its complete daughter; the bounded
  // single-complement path retains its existing event search.
  let first = 0;
  while (EVENT_ARTICLE_TOKENS.has(canonicalParts[first])) first++;
  let event: EventTiming | undefined;
  for (let index = first; index < canonicalParts.length; index += 1) {
    const candidate = resolveEventTimingExpression(canonicalParts, index);
    if (candidate && (!complete || index + candidate.length === canonicalParts.length)) {
      event = candidate.timing;
      break;
    }
    if (complete) break;
  }
  if (!event) return undefined;
  const text = trimSemanticText(sourceFor(parts, start, endExclusive, input));
  if (!text) return undefined;
  // Site-relation valence keeps its existing single nominal complement;
  // event adjuncts and coordinated daughters retain canonical EventTiming.
  if (nominalComplement) {
    const nominal = internalArgument(canonicalParts.slice(first).join(" "), text, options);
    if (nominal?.role === AdviceArgumentRole.Time) return nominal;
  }
  return {
    role: AdviceArgumentRole.Time,
    text,
    normalized: event
  };
}

function siteRelativeMarkerAt(part: Lexeme | undefined): boolean {
  return Boolean(part && (
    SITE_RELATIVE_MARKERS.has(part.lower) || SITE_RELATIVE_MARKERS.has(key(part))
  ));
}

/**
 * Composes a site head with its source-backed relative predicate before the
 * generic action-relation parser can split the two daughters. This is the
 * instruction-valence view of the same BodySiteRestriction used by HPSG site
 * phrases; it never grants the qualified site its head's anatomical coding.
 */
function qualifiedSiteArgumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  options?: ParseOptions,
  outerRelationIndex = -1
): AdviceArgument | undefined {
  for (let markerIndex = start + 1; markerIndex + 1 < endExclusive; markerIndex += 1) {
    if (!siteRelativeMarkerAt(parts[markerIndex])) continue;
    const baseStart = outerRelationIndex >= start && outerRelationIndex < markerIndex &&
      !siteRelativeMarkerAt(parts[outerRelationIndex])
      ? outerRelationIndex + 1
      : start;
    let nominalStart = baseStart;
    while (nominalStart < markerIndex && EVENT_ARTICLE_TOKENS.has(key(parts[nominalStart]))) {
      nominalStart += 1;
    }
    if (nominalStart >= markerIndex) continue;
    const baseText = trimSemanticText(sourceFor(parts, baseStart, markerIndex, input));
    const baseCanonical = parts.slice(nominalStart, markerIndex).map(key).filter(Boolean).join(" ");
    const genericAreaHead = BODY_SITE_SOURCE_LEAD_PREFIXES.some((prefix) =>
      normalizeActionSurface(prefix) === normalizeActionSurface(baseText)
    ) ? internalArgument("area", baseText, options) : undefined;
    const base = internalArgument(baseText, baseText, options) ??
      internalArgument(baseCanonical, baseText, options) ??
      genericAreaHead ??
      codingFromSite(baseText, options);
    if (base?.role !== AdviceArgumentRole.Site) continue;

    const predicateText = trimSemanticText(sourceFor(parts, markerIndex + 1, endExclusive, input));
    const text = trimSemanticText(sourceFor(parts, baseStart, endExclusive, input));
    if (!predicateText || !text) continue;
    const predicate = resolveBodySiteRestrictionPredicate(predicateText);
    const restriction = formBodySiteRestriction(
      predicate,
      undefined,
      trimSemanticText(sourceFor(parts, markerIndex, endExclusive, input))
    );
    if (!predicate.lemma) {
      const sourceLocale = baseLanguageTag(inferMedicationLocale(text, "en")) ?? "en";
      return {
        role: AdviceArgumentRole.Site,
        text,
        normalized: text,
        i18n: { [sourceLocale]: text }
      };
    }

    const relativeEn = realizeBodySiteRestriction(restriction, "en");
    const relativeTh = realizeBodySiteRestriction(restriction, "th");
    const baseEn = localizedValue(base.i18n, "en") ?? base.normalized ?? base.text;
    const baseTh = localizedValue(base.i18n, "th") ?? base.text;
    const en = relativeEn ? joinLocalizedTokens("en", [baseEn, relativeEn]) : undefined;
    const th = relativeTh ? joinLocalizedTokens("th", [baseTh, relativeTh]) : undefined;
    return {
      role: AdviceArgumentRole.Site,
      text,
      normalized: en ?? text,
      i18n: {
        ...(en ? { en } : {}),
        ...(th ? { th } : {})
      }
    };
  }
  return undefined;
}

function argumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  preferredRole: AdviceArgumentRole | undefined,
  options?: ParseOptions
): AdviceArgument | undefined {
  if (endExclusive <= start) return undefined;
  const bounds = semanticArgumentBounds(parts, start, endExclusive);
  start = bounds.start;
  endExclusive = bounds.endExclusive;
  if (endExclusive <= start) return undefined;
  const text = trimSemanticText(sourceFor(parts, start, endExclusive, input));
  if (!text) return undefined;
  const canonicalParts: string[] = [];
  let nominalStart = start;
  while (nominalStart < endExclusive && EVENT_ARTICLE_TOKENS.has(key(parts[nominalStart]))) {
    nominalStart += 1;
  }
  for (let index = nominalStart; index < endExclusive; index += 1) {
    const currentKey = key(parts.slice(index, index + 1)[0]);
    if (currentKey) canonicalParts.push(currentKey);
  }
  const canonical = canonicalParts.join(" ");
  const qualifiedSite = qualifiedSiteArgumentFromParts(
    parts, start, endExclusive, input, options
  );
  if (qualifiedSite) return qualifiedSite;
  const direct = text === canonical
    ? internalArgument(canonical, text, options)
    : internalArgument(text, text, options) ?? internalArgument(canonical, text, options);
  if (direct) {
    // A terminology entry's typed role is stronger evidence than a
    // constructional fallback. The fallback is only for opaque/free text.
    return direct;
  }
  const resolvedSite = codingFromSite(text, options);
  if (resolvedSite) {
    if (preferredRole === AdviceArgumentRole.Destination) resolvedSite.role = AdviceArgumentRole.Destination;
    return resolvedSite;
  }
  const coordinated = coordinatedTypedArgumentFromParts(parts, start, endExclusive, input, options);
  if (coordinated) return coordinated;
  const allPartsCanonical = parts
    .slice(start, endExclusive)
    .every((part) => Boolean(part.canonical));
  return {
    role: preferredRole ?? AdviceArgumentRole.Object,
    text,
    normalized: allPartsCanonical && canonical ? canonical : text.toLowerCase()
  };
}

function argumentCoordinationMembers(parts: Lexeme[], start: number, endExclusive: number):
  Array<{ start: number; end: number; connector: string }> {
  const members: Array<{ start: number; end: number; connector: string }> = [];
  let memberStart = start, connector = "";
  for (let index = start; index < endExclusive; index++) {
    const token = key(parts[index]);
    if (token !== "," && token !== "and" && token !== "or") continue;
    if (index > memberStart) members.push({ start: memberStart, end: index, connector });
    connector = token;
    memberStart = index + 1;
  }
  if (memberStart < endExclusive) members.push({ start: memberStart, end: endExclusive, connector });
  return members;
}

function timeArgumentsFromParts(
  parts: Lexeme[], start: number, endExclusive: number, input: string,
  offset: number, relation: AdviceRelation | undefined, singleEnd = endExclusive, options?: ParseOptions,
  nominalComplement = false
): AdviceArgument[] | undefined {
  const members = argumentCoordinationMembers(parts, start, endExclusive);
  // A choice is not a list of conjunctive event obligations. Preserve its
  // complete source complement through the existing opaque argument owner.
  if (members.some(member => member.connector === "or")) return undefined;
  if (members.length > 1) {
    const times: AdviceArgument[] = [];
    let inheritedRelation = relation;
    for (const member of members) {
      let begin = member.start;
      const overt = resolveActionRelationSurfaceByGrammarFeature(key(parts[begin]), "timeComplement");
      if (overt) { inheritedRelation = overt; begin++; }
      const bounds = semanticArgumentBounds(parts, begin, member.end);
      const time = timeArgumentFromParts(parts, bounds.start, bounds.endExclusive, input, true, options);
      if (!time) {
        // A later independently marked complement belongs to the caller's
        // next relation, not to this already complete temporal conjunction.
        return member.start >= singleEnd && times.length ? times : undefined;
      }
      times.push({ ...time, relation: inheritedRelation,
        span: { start: offset + parts[bounds.start].sourceStart,
          end: offset + parts[bounds.endExclusive - 1].sourceEnd } });
    }
    // Every daughter in this relation scope was consumed completely.
    return times;
  }
  const member = members[0];
  if (!member) return undefined;
  const bounds = semanticArgumentBounds(parts, member.start, Math.min(member.end, singleEnd));
  const single = timeArgumentFromParts(parts, bounds.start, bounds.endExclusive,
    input, false, options, nominalComplement);
  return single ? [{ ...single, span: {
    start: offset + parts[bounds.start].sourceStart,
    end: offset + parts[bounds.endExclusive - 1].sourceEnd
  } }] : undefined;
}

function coordinatedTypedArgumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  options?: ParseOptions
): AdviceArgument | undefined {
  // A typed coordination is a list of nominal daughters, not a series of
  // new imperatives. Commas and the final and/or preserve their own scope.
  const members = argumentCoordinationMembers(parts, start, endExclusive);
  // Thai may juxtapose two complete substance nouns without a conjunction.
  // License that construction only with adjacent source characters AND typed
  // substance atoms; arbitrary Thai compounds must stay opaque.
  if (members.length < 2 && endExclusive - start > 1) {
    const contiguousSubstances = parts.slice(start, endExclusive).every((part, offset) =>
      resolveMedicationInstructionConcept(key(part), options)?.role === AdviceArgumentRole.Substance &&
      (offset === 0 || (
        parts[start + offset - 1].sourceEnd === part.sourceStart &&
        shouldJoinAdjacentSourceTokens(parts[start + offset - 1].original, part.original)
      ))
    );
    if (contiguousSubstances) {
      members.length = 0;
      for (let index = start; index < endExclusive; index += 1) {
        members.push({ start: index, end: index + 1, connector: index === start ? "" : "and" });
      }
    }
  }
  if (members.length < 2) return undefined;
  const daughters = members.map((member) => {
    const text = trimSemanticText(sourceFor(parts, member.start, member.end, input));
    const canonical = parts.slice(member.start, member.end).map(key).join(" ");
    return internalArgument(canonical, text, options) ?? codingFromSite(text, options);
  });
  const first = daughters[0];
  if (!first?.role || [
    AdviceArgumentRole.Activity, AdviceArgumentRole.Substance, AdviceArgumentRole.Object,
    AdviceArgumentRole.Material, AdviceArgumentRole.Site
  ].indexOf(first.role) < 0) return undefined;
  if (!daughters.every((daughter) =>
    daughter?.role === first.role && Boolean(daughter.conceptId || daughter.coding?.code)
  )) return undefined;
  const i18n = composeLocalizedRecords(
    daughters.map((daughter) => daughter?.i18n),
    (values, locale) => {
      let result = values[0];
      for (let index = 1; index < values.length; index += 1) {
        const joining = members[index].connector;
        if (joining === ",") {
          result += `, ${values[index]}`;
        } else {
          const translated = localizedValue(ACTION_COORDINATION_CONNECTOR_I18N[joining], locale) ?? joining;
          result = joinLocalizedTokens(locale, [result, translated, values[index]]);
        }
      }
      return result;
    }
  );
  const text = trimSemanticText(sourceFor(parts, start, endExclusive, input));
  return {
    role: first.role,
    text,
    normalized: i18n?.en ?? text.toLowerCase(),
    i18n
  };
}

function pushArgument(args: AdviceArgument[], argument: AdviceArgument | undefined): void {
  if (!argument) return;
  if (!args.some((candidate) =>
    candidate.role === argument.role && candidate.text === argument.text && candidate.conceptId === argument.conceptId &&
    candidate.relation === argument.relation
  )) args.push(argument);
}

const BODY_SITE_LOCATIVE_RELATION_TOKEN_PARTS = Array.from(
  BODY_SITE_LOCATIVE_RELATION_PHRASES.keys(),
  (phrase) => phrase.split(/\s+/u).filter(Boolean)
);

function tokenBelongsToBodySiteRelationPhrase(
  parts: Lexeme[],
  index: number,
  start: number,
  endExclusive: number
): boolean {
  const tokenKey = key(parts.slice(index, index + 1)[0]);
  for (const phraseParts of BODY_SITE_LOCATIVE_RELATION_TOKEN_PARTS) {
    for (let position = 0; position < phraseParts.length; position += 1) {
      if (phraseParts[position] !== tokenKey) continue;
      const phraseStart = index - position;
      if (phraseStart < start || phraseStart + phraseParts.length > endExclusive) continue;
      if (phraseParts.every((part, offset) =>
        key(parts.slice(phraseStart + offset, phraseStart + offset + 1)[0]) === part
      )) return true;
    }
  }
  return false;
}

function actionArgumentRelation(
  surface: string,
  preferredSemanticClasses?: readonly string[]
): AdviceRelation | undefined {
  const action = resolveActionRelationSurface(surface, preferredSemanticClasses);
  if (action) return action;
  // The shared relation vocabulary also declares material negation such as
  // WITHOUT for advice. Reuse that constituent instead of interpreting its
  // object as positive WITH material.
  const advice = resolveAdviceRelationSurface(surface);
  return relationHasSemanticClass(advice, "accompaniment") ? advice : undefined;
}

function relationIndex(parts: Lexeme[], start: number, endExclusive: number): number {
  for (let index = start; index < endExclusive; index += 1) {
    const lower = key(parts[index]);
    // AT in "at most 2 tablets" belongs to the amount, not the location.
    // Reuse the bounded quantity lexeme inside this existing relation walk.
    const quantity = DOSE_COMPARATOR_PREFIXES.has(lower)
      ? doseComparatorNumberAt(parts, index, endExclusive, lower) : undefined;
    if (quantity) { index = quantity.numericIndex; continue; }
    if (
      Boolean(actionArgumentRelation(lower)) &&
      !tokenBelongsToBodySiteRelationPhrase(parts, index, start, endExclusive)
    ) return index;
  }
  return -1;
}

const INSTRUCTION_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

interface InstructionQuantityUnitMatch { unit: string; endExclusive: number; }

function instructionQuantityHasProductContext(
  parts: Lexeme[],
  start: number,
  endExclusive: number
): boolean {
  let cursor = start;
  while (cursor < endExclusive) {
    const current = key(parts[cursor]);
    if (!current) return false;
    if (current === "of" || current === "a" || current === "an" || current === "the") {
      cursor += 1;
      continue;
    }
    return Boolean(PRODUCT_FORM_HINTS[current]);
  }
  return false;
}

function instructionQuantityHasResolvedSiteContext(
  parts: Lexeme[],
  endExclusive: number,
  options?: ParseOptions
): boolean {
  const contextualSite = options?.context?.bodySiteContext?.trim();
  if (contextualSite) {
    const resolvedContext = resolveBodySitePhrase(contextualSite, options?.siteCodeMap, {
      bodySiteContext: contextualSite,
      allowTerminalModifierInheritance: true
    });
    if (resolvedContext?.coding || resolvedContext?.definition) return true;
  }

  const searchEnd = Math.min(parts.length, endExclusive);
  for (let anchorIndex = 0; anchorIndex < searchEnd; anchorIndex += 1) {
    const anchor = key(parts[anchorIndex]);
    if (!SITE_ANCHORS.has(anchor) && !ROUTE_SITE_PREPOSITIONS.has(anchor)) continue;
    const maxSiteEnd = Math.min(searchEnd, anchorIndex + 6);
    for (let siteEnd = anchorIndex + 2; siteEnd <= maxSiteEnd; siteEnd += 1) {
      const siteText = parts
        .slice(anchorIndex + 1, siteEnd)
        .map((part) => part.original)
        .join(" ")
        .trim();
      if (!siteText) continue;
      const resolved = resolveBodySitePhrase(siteText, options?.siteCodeMap, {
        bodySiteContext: options?.context?.bodySiteContext,
        allowTerminalModifierInheritance: true
      });
      if (resolved?.coding || resolved?.definition) return true;
    }
  }
  return false;
}

function instructionQuantityUnitAt(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  options?: ParseOptions
): InstructionQuantityUnitMatch | undefined {
  const maxSpan = Math.min(3, endExclusive - start);
  for (let span = maxSpan; span >= 1; span -= 1) {
    const candidate = parts.slice(start, start + span).map((part) => key(part)).join(" ");
    const unit = normalizeUnit(candidate, options);
    if (unit) return { unit, endExclusive: start + span };
  }
  const head = key(parts[start]);
  for (const compound of COMPOUND_DOSE_UNITS) {
    if (compound.head !== head || !compound.requiresProductContext || compound.tails.length) continue;
    const hasProductContext = instructionQuantityHasProductContext(parts, start + 1, endExclusive);
    const hasRequiredSiteContext = !compound.requiresSiteContext ||
      instructionQuantityHasResolvedSiteContext(parts, endExclusive, options);
    if (hasProductContext && hasRequiredSiteContext) {
      return { unit: compound.unit, endExclusive: start + 1 };
    }
  }
  return undefined;
}

function parseQuantityArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number,
  options?: ParseOptions,
  numberEndExclusive = endExclusive
): AdviceArgument | undefined {
  for (let index = start; index < numberEndExclusive; index += 1) {
    const valueToken = parts[index];
    if (!valueToken) continue;
    // Reuse the same bounded qualifier lexeme as scalar/infusion HPSG.
    // The graph keeps the original source span, not an exact-dose rewrite.
    const qualified = valueToken.kind === "NUMBER" ? undefined :
      doseComparatorNumberAt(parts, index, numberEndExclusive, key(valueToken));
    const numberIndex = qualified?.numericIndex ?? index;
    const modifier = parts[numberIndex + 1];
    let unitStart = modifier && SUPPLEMENTAL_DOSE_MODIFIERS.has(key(modifier))
      ? numberIndex + 2 : numberIndex + 1;
    // Qualified fractions own their bounded partitive/article before the unit.
    if (qualified) for (let count = 0; count < 2 && unitStart < numberEndExclusive &&
        DOSE_UNIT_CONNECTORS.has(key(parts[unitStart])); count++) unitStart++;
    const compactUnit = qualified?.rawUnit ? normalizeUnit(qualified.rawUnit, options) : undefined;
    const unitMatch = qualified?.rawUnit
      ? compactUnit ? { unit: compactUnit, endExclusive: numberIndex + 1 } : undefined
      : instructionQuantityUnitAt(parts, unitStart, endExclusive, options);
    if (!unitMatch || unitMatch.endExclusive > numberEndExclusive) continue;
    const unitToken = parts[unitMatch.endExclusive - 1];
    if (!unitToken) continue;
    const unit = unitMatch.unit;
    const wordValue = INSTRUCTION_NUMBER_WORDS[key(valueToken)];
    if (qualified || (valueToken.kind === "NUMBER" && valueToken.value !== undefined) || wordValue !== undefined) {
      const value = qualified?.value ?? (valueToken.kind === "NUMBER" ? valueToken.value : wordValue);
      return {
        role: AdviceArgumentRole.Amount,
        text: sourceFor(parts, index, unitMatch.endExclusive, input),
        normalized: unit,
        quantity: { value, unit, ...(qualified ? { comparator: qualified.comparator } : {}) },
        span: { start: offset + valueToken.sourceStart, end: offset + unitToken.sourceEnd }
      };
    }
    if (valueToken.kind === "NUMBER_RANGE") {
      const match = valueToken.original.match(/^([0-9]+(?:\.[0-9]+)?)[-–—]([0-9]+(?:\.[0-9]+)?)$/);
      if (!match) continue;
      return {
        role: AdviceArgumentRole.Amount,
        text: sourceFor(parts, index, unitMatch.endExclusive, input),
        normalized: unit,
        quantity: { range: { low: Number(match[1]), high: Number(match[2]) }, unit },
        span: { start: offset + valueToken.sourceStart, end: offset + unitToken.sourceEnd }
      };
    }
  }
  return undefined;
}

function durationUnitFromKey(unitKey: string): string | undefined {
  return INSTRUCTION_DURATION_UNITS.get(unitKey);
}

function durationArgumentAt(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number
): AdviceArgument | undefined {
  const compactToken = parts[start];
  const compact = compactToken ? compactDurationParts(key(compactToken)) : undefined;
  const compactUnit = compact ? durationUnitFromKey(compact.unitSurface) : undefined;
  if (compact && compactToken && compactUnit) return {
    role: AdviceArgumentRole.Duration,
    text: sourceFor(parts, start, start + 1, input),
    normalized: `${compact.value} ${compactUnit}`,
    quantity: { value: compact.value, unit: compactUnit },
    span: { start: offset + compactToken.sourceStart, end: offset + compactToken.sourceEnd }
  };
  let cursor = start;
  // A licensed duration lead belongs to the same source-backed constituent
  // as its numeric daughter. Keeping `for` with article, word-number, and
  // numeric quantities prevents regimen timing from reclaiming only part of
  // a procedural duration.
  const durationLead = parts[cursor];
  if (durationLead && DURATION_LEAD_TOKENS.has(key(durationLead))) {
    cursor += 1;
  }
  const lead = parts[cursor];
  if (lead && INSTRUCTION_DURATION_APPROXIMATION_LEADS.has(key(lead))) {
    cursor += 1;
  }
  const valueToken = parts[cursor];
  if (!valueToken) return undefined;
  const rangeConnector = parts[cursor + 1];
  const rangeHigh = parts[cursor + 2];
  const rangeUnitToken = parts[cursor + 3];
  const separatedRange =
    valueToken.kind === "NUMBER" && valueToken.value !== undefined &&
    rangeConnector && RANGE_CONNECTORS.has(key(rangeConnector)) &&
    rangeHigh?.kind === "NUMBER" && rangeHigh.value !== undefined &&
    rangeUnitToken && durationUnitFromKey(key(rangeUnitToken));
  if (separatedRange) {
    const unit = durationUnitFromKey(key(rangeUnitToken)) as string;
    return {
      role: AdviceArgumentRole.Duration,
      text: sourceFor(parts, start, cursor + 4, input),
      normalized: `${valueToken.value}-${rangeHigh.value} ${unit}`,
      quantity: { range: { low: valueToken.value, high: rangeHigh.value }, unit },
      span: { start: offset + parts[start].sourceStart, end: offset + rangeUnitToken.sourceEnd }
    };
  }
  let unitIndex = cursor + 1;
  const possibleArticle = parts[unitIndex];
  if (possibleArticle && EVENT_OFFSET_ARTICLES.has(key(possibleArticle))) {
    unitIndex += 1;
  }
  const unitToken = parts[unitIndex];
  if (!unitToken || unitIndex >= endExclusive) return undefined;
  const unit = durationUnitFromKey(key(unitToken));
  if (!unit) return undefined;

  let quantity: AdviceArgument["quantity"] | undefined;
  let normalizedValue: string | number | undefined;
  if (valueToken.kind === "NUMBER" && valueToken.value !== undefined) {
    quantity = { value: valueToken.value, unit };
    normalizedValue = valueToken.value;
  } else if (valueToken.kind === "NUMBER_RANGE") {
    const range = valueToken.original.match(/^([0-9]+(?:\.[0-9]+)?)[-–—]([0-9]+(?:\.[0-9]+)?)$/);
    if (range) {
      quantity = { range: { low: Number(range[1]), high: Number(range[2]) }, unit };
      normalizedValue = valueToken.original;
    }
  } else {
    const fraction = EVENT_OFFSET_FRACTIONS.get(key(valueToken)) ??
      DOSE_NUMBER_WORDS.get(key(valueToken)) ??
      FREQUENCY_NUMBER_WORDS[key(valueToken)];
    if (fraction !== undefined) {
      quantity = { value: fraction, unit };
      normalizedValue = fraction;
    }
  }
  if (!quantity || normalizedValue === undefined) return undefined;
  return {
    role: AdviceArgumentRole.Duration,
    text: sourceFor(parts, start, unitIndex + 1, input),
    normalized: `${normalizedValue} ${unit}`,
    quantity,
    span: { start: offset + parts[start].sourceStart, end: offset + unitToken.sourceEnd }
  };
}

function parseAnyDurationArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number
): AdviceArgument | undefined {
  for (let index = start; index < endExclusive; index += 1) {
    const parsed = durationArgumentAt(parts, index, endExclusive, input, offset);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseDurationArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number
): AdviceArgument | undefined {
  for (let index = start; index + 1 < endExclusive; index += 1) {
    if (!DURATION_LEAD_TOKENS.has(key(parts[index]))) continue;
    const parsed = durationArgumentAt(parts, index + 1, endExclusive, input, offset);
    if (parsed) return parsed;
  }
  return undefined;
}

function partIndexAfterAbsoluteSourceEnd(
  parts: Lexeme[],
  sourceEnd: number,
  offset: number
): number | undefined {
  const relative = sourceEnd - offset;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].sourceEnd === relative) return index + 1;
  }
  return undefined;
}

function partIndexForAbsoluteSourceStart(
  parts: Lexeme[],
  sourceStart: number,
  offset: number
): number | undefined {
  const relative = sourceStart - offset;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].sourceStart === relative) return index;
  }
  return undefined;
}

function preferredRinseRole(relation: AdviceRelation | undefined): AdviceArgumentRole | undefined {
  if (relation === undefined) return undefined;
  return relationHasGrammarFeature(relation, "rinseTimeComplement")
    ? AdviceArgumentRole.Time
    : AdviceArgumentRole.Substance;
}

interface ActionArgumentParseContext {
  definition: ActionDefinition;
  parts: Lexeme[];
  actionIndex: number;
  argumentStart: number;
  segmentEnd: number;
  input: string;
  offset: number;
  options?: ParseOptions;
  relation?: AdviceRelation;
  relIndex: number;
  relationTargetEnd: number;
  conditionalTail: boolean;
  relationTimes?: AdviceArgument[];
  accompaniment?: AdviceArgument;
  amount?: AdviceArgument;
  duration?: AdviceArgument;
  separableParticleIndex?: number;
}
interface ParsedActionArguments { args: AdviceArgument[]; semanticEnd?: number; tailRelationIndex?: number; }
type ActionArgumentParser = (context: ActionArgumentParseContext) => ParsedActionArguments;
function parsedArgs(...values: Array<AdviceArgument | undefined>): AdviceArgument[] {
  const args: AdviceArgument[] = [];
  for (const value of values) pushArgument(args, value);
  return args;
}
const DEFAULT_ACTION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relation, relIndex,
    relationTargetEnd, conditionalTail, duration, separableParticleIndex } = c;
  const qualifiedSite = qualifiedSiteArgumentFromParts(
    parts, argumentStart, segmentEnd, input, options, relIndex
  );
  if (qualifiedSite) return { args: [qualifiedSite] };
  // This valence owns one nominal complement. An unparsed negative tail must
  // remain source-backed rather than inherit the recognized action's coverage.
  const semanticEnd = relationTargetEnd < segmentEnd &&
    actionArgumentRelation(key(parts[relationTargetEnd])) === AdviceRelation.Without
      ? relationTargetEnd : undefined;
  let objectEnd = separableParticleIndex !== undefined
    ? separableParticleIndex
    : relIndex >= 0 ? relIndex : segmentEnd;
  let finalManner: AdviceArgument | undefined;
  // A language may tokenize a single clinical manner as multiple words
  // (Thai "ทั้งเม็ด"). Bounded longest-suffix selection reuses the same typed
  // lexical/argument feature instead of guessing a dose or reparsing a clause.
  for (let start = Math.max(argumentStart, objectEnd - 3); start < objectEnd; start += 1) {
    const surface = trimSemanticText(sourceFor(parts, start, objectEnd, input));
    const canonical = parts.slice(start, objectEnd).map(key).join(" ");
    const declared = internalArgument(surface, surface, options) ??
      internalArgument(canonical, surface, options);
    if (declared?.role === AdviceArgumentRole.Manner) {
      finalManner = declared;
      objectEnd = start;
      break;
    }
    const modifier = resolveAdviceMannerModifier(canonical) ??
      resolveAdviceMannerModifier(surface);
    if (!modifier) continue;
    finalManner = {
      role: AdviceArgumentRole.Manner,
      text: surface,
      normalized: modifier.lemma,
      conceptId: modifier.lemma,
      i18n: { en: modifier.lemma, ...(modifier.i18n ?? {}) }
    };
    objectEnd = start;
    break;
  }
  const object = argumentFromParts(parts, argumentStart, objectEnd, input, undefined, options);
  // The typed Amount already owns its exact source phrase and span. A second
  // untyped copy must not turn a recognized qualified quantity into opaque text.
  const amountOnly = object?.role === AdviceArgumentRole.Object && c.amount?.quantity &&
    object.text === c.amount.text;
  const args = parsedArgs(amountOnly ? undefined : object, finalManner);
  let typedLocalTime: AdviceArgument | undefined;
  for (let index = argumentStart; index < objectEnd; index += 1) {
    const candidate = internalArgument(key(parts[index]), parts[index].sourceText ?? parts[index].original, options);
    if (candidate?.role === AdviceArgumentRole.Time) {
      typedLocalTime = candidate;
      pushArgument(args, candidate);
      break;
    }
  }
  if (typedLocalTime && duration) pushArgument(args, duration);
  else if (relationHasGrammarFeature(relation, "includeDuration") && duration) pushArgument(args, duration);
  else if (relIndex >= 0 && !conditionalTail) {
    const times = c.relationTimes;
    if (times) {
      for (const time of times) pushArgument(args, time);
      return { args, semanticEnd };
    }
    const relationDuration = relationHasGrammarFeature(relation, "durationComplement")
      ? parseAnyDurationArgument(parts, relIndex + 1, relationTargetEnd, input, offset)
      : undefined;
    const fallbackRole = relationHasGrammarFeature(relation, "activityFallback")
      ? AdviceArgumentRole.Activity : undefined;
    const complement = relationDuration ?? argumentFromParts(
      parts, relIndex + 1, relationTargetEnd, input, fallbackRole, options
    );
    const accompaniment = relationHasGrammarFeature(relation, "accompanimentComplement");
    const accompanyingQuantity = !relationDuration && accompaniment
      ? quantifiedEntityArgument(parts, relIndex + 1, relationTargetEnd, input, offset,
          AdviceArgumentRole.Substance, options) : undefined;
    const argument = accompanyingQuantity?.quantity ? accompanyingQuantity : complement;
    if (argument && accompaniment) argument.relation = relation;
    pushArgument(args, argument);
  }
  return { args, semanticEnd };
};
const CONTAINER_ACTIVITY_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, options, relIndex } = c;
  const args = parsedArgs(argumentFromParts(parts, argumentStart,
    relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Container, options));
  let semanticEnd: number | undefined;
  if (relIndex >= 0) {
    let activityEnd = segmentEnd;
    for (let index = relIndex + 1; index < segmentEnd; index += 1) {
      const current = key(parts[index]);
      if (ACTION_COORDINATION_CONNECTORS.has(current) && index > relIndex + 1) {
        activityEnd = index; semanticEnd = index; break;
      }
    }
    pushArgument(args, argumentFromParts(
      parts, relIndex + 1, activityEnd, input, AdviceArgumentRole.Activity, options));
  }
  return { args, semanticEnd };
};
const THEME_DESTINATION_AMOUNT_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relIndex, amount } = c;
  const args = parsedArgs(argumentFromParts(parts, argumentStart,
    relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Theme, options));
  const amountIndex = amount?.span ? partIndexForAbsoluteSourceStart(parts, amount.span.start, offset) : undefined;
  if (relIndex >= 0) pushArgument(args, argumentFromParts(parts, relIndex + 1,
    amountIndex !== undefined && amountIndex > relIndex ? amountIndex : segmentEnd,
    input, AdviceArgumentRole.Destination, options));
  pushArgument(args, amount);
  return { args };
};
const OBJECT_AMOUNT_MATERIAL_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relIndex, relation, amount } = c;
  const args = parsedArgs(amount);
  const amountIndex = amount?.span ? partIndexForAbsoluteSourceStart(parts, amount.span.start, offset) : undefined;
  if (argumentStart < segmentEnd) {
    let objectEnd = amountIndex !== undefined ? amountIndex : segmentEnd;
    if (relIndex >= argumentStart && relIndex < objectEnd) objectEnd = relIndex;
    if (objectEnd > argumentStart) pushArgument(args,
      argumentFromParts(parts, argumentStart, objectEnd, input, AdviceArgumentRole.Object, options));
  }
  const amountEnd = amount?.span
    ? partIndexAfterAbsoluteSourceEnd(parts, amount.span.end, offset)
    : undefined;
  const tailStart = amountEnd !== undefined
    ? Math.min(segmentEnd, relIndex >= amountEnd ? relIndex + 1 : amountEnd)
    : relIndex >= 0 ? relIndex + 1 : segmentEnd;
  if (tailStart < segmentEnd) {
    const tail = argumentFromParts(parts, tailStart, segmentEnd, input, AdviceArgumentRole.Material, options);
    if (relationHasGrammarFeature(relation, "accompanimentComplement") || tail?.conceptId) pushArgument(args, tail);
  }
  return { args };
};
const AMOUNT_MATERIAL_DESTINATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relIndex, relation, relationTargetEnd, amount } = c;
  const args = parsedArgs(amount);
  const amountEnd = amount?.span
    ? partIndexAfterAbsoluteSourceEnd(parts, amount.span.end, offset)
    : undefined;
  let materialStart = amountEnd ?? argumentStart;
  while (materialStart < segmentEnd) {
    const lower = key(parts[materialStart]);
    if (lower === "of" || lower === "a" || lower === "an" || lower === "the") materialStart += 1;
    else break;
  }
  const materialEnd = relIndex >= materialStart ? relIndex : segmentEnd;
  if (materialStart < materialEnd) pushArgument(args, argumentFromParts(
    parts, materialStart, materialEnd, input, AdviceArgumentRole.Material, options
  ));
  let targetIndex = c.conditionalTail ? -1 : relIndex;
  let targetEnd = relationTargetEnd;
  let targetRelation = relation;
  let tailRelationIndex: number | undefined;
  while (targetIndex >= 0 && targetIndex + 1 < targetEnd) {
    const temporal = relationHasSemanticClass(targetRelation, "temporal");
    const times = relationHasGrammarFeature(targetRelation, "timeComplement")
      ? timeArgumentsFromParts(parts, targetIndex + 1, targetEnd, input, offset, targetRelation, targetEnd, options) : undefined;
    if (temporal) tailRelationIndex = -1;
    if (times) {
      // Each bounded clock or event remains with this action while later
      // complements retain their independent relation and quantity.
      const bounds = semanticArgumentBounds(parts, targetIndex + 1, targetEnd);
      const first = parts[bounds.start], last = parts[bounds.endExclusive - 1];
      for (const time of times) pushArgument(args, { ...time, relation: time.relation ?? targetRelation,
        span: time.span ?? (first && last ? { start: offset + first.sourceStart, end: offset + last.sourceEnd } : undefined) });
    } else {
      const role = !temporal ? AdviceArgumentRole.Destination
        : targetRelation === AdviceRelation.Until ? AdviceArgumentRole.Result
        : relationHasGrammarFeature(targetRelation, "activityFallback") ? AdviceArgumentRole.Activity : AdviceArgumentRole.Time;
      const nominal = argumentFromParts(
        parts, targetIndex + 1, targetEnd, input, role, options
      );
      const quantified = quantifiedEntityArgument(parts, targetIndex + 1, targetEnd, input, offset,
        nominal?.role ?? AdviceArgumentRole.Destination, options);
      const target = quantified?.quantity ? quantified : nominal;
      // Each local complement owns its relation, independently of noun role:
      // saline WITH water TO 100 mL retains both targets.
      if (target) target.relation = targetRelation;
      pushArgument(args, target);
    }
    if (targetEnd >= segmentEnd) break;
    targetIndex = targetEnd;
    targetRelation = actionArgumentRelation(key(parts[targetIndex]));
    // Conditions still hand off immediately. A temporal daughter first gets
    // its own relation-bounded clock probe at the top of this loop.
    if (!targetRelation || relationHasGrammarFeature(targetRelation, "conditionalTail")) {
      tailRelationIndex = targetIndex;
      break;
    }
    const next = relationIndex(parts, targetIndex + 1, segmentEnd);
    targetEnd = next >= 0 ? next : segmentEnd;
  }
  return { args, tailRelationIndex };
};
const AMOUNT_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const activity = !c.relationTimes && c.relIndex >= 0 && relationHasGrammarFeature(c.relation, "activityFallback")
      ? argumentFromParts(
          c.parts, c.relIndex + 1, c.relationTargetEnd, c.input, AdviceArgumentRole.Activity, c.options
        )
      : undefined;
  return { args: parsedArgs(c.amount, c.duration, c.accompaniment, activity, ...(c.relationTimes ?? [])) };
};
const OBJECT_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relIndex, duration } = c;
  const durationIndex = duration?.span ? partIndexForAbsoluteSourceStart(parts, duration.span.start, offset) : undefined;
  let objectEnd = durationIndex !== undefined ? durationIndex : segmentEnd;
  if (relIndex >= argumentStart && relIndex < objectEnd) objectEnd = relIndex;
  // Temporal relation daughters belong to the same action. When an opaque
  // day/calendar qualifier is not executable, keep it as an editable Time
  // argument rather than rendering an unconditional withholding directive.
  const localTime = relIndex >= argumentStart && relIndex + 1 < segmentEnd &&
    !duration && !c.conditionalTail &&
    relationHasGrammarFeature(c.relation, "timeComplement")
      ? argumentFromParts(parts, relIndex + 1, segmentEnd, input, AdviceArgumentRole.Time, options)
      : undefined;
  return { args: parsedArgs(
    objectEnd > argumentStart
      ? argumentFromParts(parts, argumentStart, objectEnd, input,
        c.definition.argumentParser === "bare-duration" ? undefined : AdviceArgumentRole.Object, options)
      : undefined,
    duration,
    localTime
  ) };
};
function configuredConceptIndex(parts: Lexeme[], start: number, end: number,
  concepts: readonly string[] | undefined): number {
  if (!concepts?.length) return -1;
  for (let index = start; index < end; index += 1) {
    if (concepts.indexOf(key(parts[index])) >= 0) return index;
  }
  return -1;
}
function quantifiedEntityArgument(
  parts: Lexeme[],
  start: number,
  end: number,
  input: string,
  offset: number,
  role: AdviceArgumentRole,
  options?: ParseOptions,
  selectedNominal?: AdviceArgument
): AdviceArgument | undefined {
  if (end <= start) return undefined;
  const quantity = parseQuantityArgument(parts, start, end, input, offset, options);
  let entity: AdviceArgument | undefined;
  if (quantity?.span) {
    const quantityStart = partIndexForAbsoluteSourceStart(parts, quantity.span.start, offset);
    const quantityEnd = partIndexAfterAbsoluteSourceEnd(parts, quantity.span.end, offset);
    if (quantityStart !== undefined && quantityStart > start) {
      const prefix = quantityStart === start + 1 ? key(parts[start]) : undefined;
      const determinerOnly = prefix === "a" || prefix === "an" || prefix === "the";
      if (!determinerOnly) entity = argumentFromParts(parts, start, quantityStart, input, role, options);
    }
    if (!entity && quantityEnd !== undefined && quantityEnd < end) {
      entity = argumentFromParts(parts, quantityEnd, end, input, role, options);
    }
  } else {
    entity = selectedNominal ?? argumentFromParts(parts, start, end, input, role, options);
  }
  const text = trimSemanticText(sourceFor(parts, start, end, input));
  if (!entity && !quantity) return undefined;
  const sourceEntityText = entity?.text;
  const result: AdviceArgument = entity ? { ...entity } : {
    role,
    text,
    normalized: quantity?.quantity?.unit ?? text.toLowerCase()
  };
  if (sourceEntityText) {
    const i18n = withMedicationSourceI18n(sourceEntityText, result.i18n);
    if (i18n !== result.i18n) result.i18n = i18n;
  }
  result.role = role;
  result.text = text;
  if (quantity?.quantity) result.quantity = quantity.quantity;
  const first = parts[start];
  const last = parts[end - 1];
  if (first && last) result.span = { start: offset + first.sourceStart, end: offset + last.sourceEnd };
  return result;
}

/** A measured nominal owns its quantity; a bare quantity remains the head Amount. */
function nominalAccompanimentArgument(
  parts: Lexeme[], start: number, end: number, input: string, offset: number,
  relation: AdviceRelation | undefined, options?: ParseOptions
): AdviceArgument | undefined {
  if (!relationHasSemanticClass(relation, "accompaniment")) return undefined;
  const nominal = argumentFromParts(parts, start, end, input, AdviceArgumentRole.Substance, options);
  const companion = quantifiedEntityArgument(parts, start, end, input, offset,
    nominal?.role ?? AdviceArgumentRole.Substance, options, nominal);
  if (!companion || quantityOnlyInstructionArgument(companion)) return undefined;
  companion.relation = relation;
  return companion;
}

function trailingTimeArgument(
  parts: Lexeme[],
  start: number,
  end: number,
  input: string,
  options?: ParseOptions
): { start: number; argument: AdviceArgument } | undefined {
  const bounds = semanticArgumentBounds(parts, start, end);
  start = bounds.start;
  end = bounds.endExclusive;
  for (let index = start; index < end; index += 1) {
    const canonical = parts.slice(index, end).map((part) => key(part));
    const declared = internalArgument(
      canonical.join(" "), trimSemanticText(sourceFor(parts, index, end, input)), options
    );
    if (declared?.role === AdviceArgumentRole.Time) {
      return { start: index, argument: declared };
    }
    const event = resolveEventTimingExpression(canonical, 0);
    if (!event || event.length !== canonical.length) continue;
    const resolved = argumentFromParts(parts, index, end, input, AdviceArgumentRole.Time, options);
    if (resolved?.conceptId) return { start: index, argument: resolved };
    return {
      start: index,
      argument: {
        role: AdviceArgumentRole.Time,
        text: trimSemanticText(sourceFor(parts, index, end, input)),
        normalized: event.timing
      }
    };
  }
  return undefined;
}

const OBJECT_TIME_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const time = trailingTimeArgument(c.parts, c.argumentStart, c.segmentEnd, c.input, c.options);
  const timeRelation = time && c.relIndex >= c.argumentStart && c.relIndex < time.start &&
    relationHasGrammarFeature(c.relation, "timeComplement") &&
    c.parts.slice(c.relIndex + 1, time.start).every(part => EVENT_ARTICLE_TOKENS.has(key(part)));
  const objectEnd = timeRelation ? c.relIndex : time?.start ?? c.segmentEnd;
  return { args: parsedArgs(
    objectEnd > c.argumentStart
      ? argumentFromParts(c.parts, c.argumentStart, objectEnd, c.input, AdviceArgumentRole.Object, c.options)
      : undefined,
    time?.argument
  ) };
};

const MIX_SUBSTANCE_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { definition, parts, argumentStart, segmentEnd, input, offset, options, relIndex } = c;
  const tailRelation = c.relationTargetEnd < segmentEnd
    ? actionArgumentRelation(key(parts[c.relationTargetEnd])) : undefined;
  const materialEnd = c.relationTargetEnd < segmentEnd &&
    (relationHasSemanticClass(tailRelation, "temporal") ||
      relationHasGrammarFeature(tailRelation, "timeComplement") &&
        clockArgumentFromParts(parts, c.relationTargetEnd + 1, segmentEnd, input))
    ? c.relationTargetEnd : segmentEnd;
  const absolutePrimary = configuredConceptIndex(
    parts, argumentStart, materialEnd, definition.argumentParserConfig?.primaryConcepts);
  if (absolutePrimary < 0) {
    // A syntactically licensed WITH complement does not require a known food
    // or vehicle concept. Keep an uncoded material noun fully source-backed;
    // a recognized instrument/object retains its own role, not a fabricated
    // Substance identity. The renderer receives this explicit valence too.
    if (relIndex >= argumentStart && relIndex + 1 < materialEnd &&
        (relationHasGrammarFeature(c.relation, "accompanimentComplement") ||
          relationHasSemanticClass(c.relation, "accompaniment") ||
          relationHasSemanticClass(c.relation, "locative"))) {
      const args: AdviceArgument[] = [];
      if (relIndex > argumentStart) {
        const typed = argumentFromParts(
          parts, argumentStart, relIndex, input, AdviceArgumentRole.Theme, options
        );
        pushArgument(args, quantifiedEntityArgument(
          parts, argumentStart, relIndex, input, offset,
          typed?.conceptId ? typed.role : AdviceArgumentRole.Theme, options
        ));
      }
      const nominal = argumentFromParts(parts, relIndex + 1, materialEnd, input, undefined, options);
      const role = nominal?.conceptId ? nominal.role : AdviceArgumentRole.Material;
      const companion = quantifiedEntityArgument(
        parts, relIndex + 1, materialEnd, input, offset, role, options);
      if (companion) companion.relation = c.relation;
      pushArgument(args, companion);
      return { args };
    }
    return { args: parsedArgs(argumentFromParts(
      parts, argumentStart, materialEnd, input, undefined, options)) };
  }

  const args: AdviceArgument[] = [];
  const split = relIndex >= argumentStart && relIndex < absolutePrimary ? relIndex : absolutePrimary;
  if (split > argumentStart) {
    const typed = argumentFromParts(
      parts, argumentStart, split, input, AdviceArgumentRole.Theme, options
    );
    pushArgument(args, quantifiedEntityArgument(
      parts, argumentStart, split, input, offset,
      typed?.conceptId ? typed.role : AdviceArgumentRole.Theme, options
    ));
  }

  const substanceStart = relIndex >= 0 && relIndex < absolutePrimary ? relIndex + 1 : absolutePrimary;
  const substance = quantifiedEntityArgument(
    parts, substanceStart, materialEnd, input, offset, AdviceArgumentRole.Substance, options);
  if (substance && relIndex >= argumentStart) substance.relation = c.relation;
  if (substance?.conceptId === undefined) {
    const primary = argumentFromParts(
      parts, absolutePrimary, absolutePrimary + 1, input, AdviceArgumentRole.Substance, options);
    if (primary) {
      primary.text = substance?.text ?? primary.text;
      primary.quantity = substance?.quantity;
      primary.span = substance?.span ?? primary.span;
      primary.relation = substance?.relation;
      pushArgument(args, primary);
    } else pushArgument(args, substance);
  } else pushArgument(args, substance);

  const secondaryIndex = configuredConceptIndex(
    parts, argumentStart, materialEnd, definition.argumentParserConfig?.secondaryConcepts);
  if (secondaryIndex >= 0) {
    const part = parts[secondaryIndex];
    pushArgument(args, internalArgument(key(part), part.sourceText ?? part.original, options));
  }
  return { args };
};
const RESULT_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { definition, parts, argumentStart, segmentEnd, input, options } = c;
  // A temporal result boundary is its own typed daughter. "Until finished"
  // must not become an opaque Object containing the word "until".
  const resultStart = c.relIndex >= argumentStart && c.relation === AdviceRelation.Until
    ? c.relIndex + 1 : argumentStart;
  const resultIndex = configuredConceptIndex(
    parts, resultStart, segmentEnd, definition.argumentParserConfig?.primaryConcepts);
  if (resultIndex < 0 && definition.applicationVerb) {
    // A licensed application predicate can select a Manner and Site instead
    // of a Result. The same action family still selects an explicit Result
    // ("rub to form foam") through its result complement above.
    let siteStart = resultStart;
    const args: AdviceArgument[] = [];
    const modifierPart = parts[siteStart];
    if (modifierPart) {
      const surface = key(modifierPart);
      const original = modifierPart.sourceText ?? modifierPart.original;
      const declared = internalArgument(surface, original, options);
      if (declared?.role === AdviceArgumentRole.Manner) {
        pushArgument(args, declared);
        siteStart += 1;
      } else {
        const manner = resolveAdviceMannerModifier(surface);
        if (manner) {
          pushArgument(args, {
            role: AdviceArgumentRole.Manner,
            text: original,
            normalized: surface,
            conceptId: manner.lemma.replace(/\s+/g, "_"),
            i18n: { en: surface, ...(manner.i18n ?? {}) },
            span: {
              start: c.offset + modifierPart.sourceStart,
              end: c.offset + modifierPart.sourceEnd
            }
          });
          siteStart += 1;
        }
      }
    }
    const locative = c.relIndex >= siteStart && c.relIndex < segmentEnd &&
      relationHasSemanticClass(c.relation, "locative");
    if (args.length || locative) {
      const locationStart = locative ? c.relIndex + 1 : siteStart;
      if (locationStart < segmentEnd) {
        pushArgument(args, argumentFromParts(
          parts, locationStart, segmentEnd, input, AdviceArgumentRole.Site, options
        ));
      }
      return { args };
    }
  }
  if (resultIndex < 0) return {
    // A source-backed quantified duration is a different valence daughter
    // from the outcome/result of a procedure. Do not relabel its elapsed
    // time as an opaque "result", nor lose an already-composed duration.
    args: c.duration?.quantity
      ? [c.duration]
      : parsedArgs(argumentFromParts(
        parts, resultStart, segmentEnd, input, AdviceArgumentRole.Result, options
      ))
  };
  const part = parts[resultIndex];
  return { args: parsedArgs(internalArgument(key(part), part.sourceText ?? part.original, options)) };
};
const SITE_ARGUMENT_PARSER: ActionArgumentParser = (c) => ({
  args: parsedArgs(argumentFromParts(
    c.parts, c.argumentStart, c.segmentEnd, c.input, AdviceArgumentRole.Site, c.options
  ))
});
function resultativeTail(
  parts: Lexeme[], start: number, end: number, input: string, options?: ParseOptions
): { lead: number; argument: AdviceArgument } | undefined {
  for (let index = start; index + 1 < end; index += 1) {
    if (key(parts[index]) !== "do") continue;
    const argument = argumentFromParts(
      parts, index + 1, end, input, AdviceArgumentRole.Result, options
    );
    if (argument?.role === AdviceArgumentRole.Result && argument.conceptId) {
      return { lead: index, argument };
    }
  }
  return undefined;
}

const SITE_RELATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, options, relIndex, relation } = c;
  const args: AdviceArgument[] = [];
  const resultTail = resultativeTail(parts, argumentStart, segmentEnd, input, options);
  const semanticEnd = resultTail?.lead ?? segmentEnd;
  if (relIndex > argumentStart && relIndex < semanticEnd) {
    const localTarget = argumentFromParts(
      parts, argumentStart, relIndex, input, AdviceArgumentRole.Site, options);
    if (localTarget?.coding?.code || localTarget?.conceptId) pushArgument(args, localTarget);
    else pushArgument(args, argumentFromParts(parts, argumentStart, relIndex, input, undefined, options));
  }
  // An explicit temporal FOR complement has a typed elapsed-duration value,
  // not the material used for rinsing. Reuse the same source-backed duration
  // daughter as wait/infusion rather than turning "one minute" into a substance.
  const elapsed = relIndex >= 0 && relIndex < semanticEnd &&
    DURATION_LEAD_TOKENS.has(key(parts[relIndex]))
      ? durationArgumentAt(parts, relIndex, semanticEnd, input, c.offset)
      : undefined;
  if (elapsed) pushArgument(args, elapsed);
  else if (c.accompaniment) pushArgument(args, c.accompaniment);
  else if (c.relationTimes) for (const time of c.relationTimes) pushArgument(args, time);
  else if (relIndex >= 0 && relIndex < semanticEnd) {
    const target = argumentFromParts(parts, relIndex + 1, Math.min(c.relationTargetEnd, semanticEnd),
      input, preferredRinseRole(relation), options);
    if (target?.role === AdviceArgumentRole.Site && relationHasSemanticClass(relation, "locative"))
      target.relation = relation;
    pushArgument(args, target);
  }
  else pushArgument(args, argumentFromParts(
    parts, argumentStart, semanticEnd, input, preferredRinseRole(relation), options));
  pushArgument(args, resultTail?.argument);
  return { args };
};
const DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const parsed = parseDurationArgument(c.parts, c.argumentStart, c.segmentEnd, c.input, c.offset) ?? c.duration;
  return { args: parsedArgs(parsed, parsed ? undefined : argumentFromParts(
    c.parts, c.argumentStart, c.segmentEnd, c.input, undefined, c.options
  )) };
};
const DURATION_ACTIVITY_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const duration = c.duration;
  let localTime: AdviceArgument | undefined;
  const adjunctEnd = c.relIndex >= c.argumentStart ? c.relIndex : c.segmentEnd;
  for (let index = c.argumentStart; index < adjunctEnd; index += 1) {
    const part = c.parts[index];
    const declared = internalArgument(key(part), part?.sourceText ?? part?.original ?? "", c.options);
    if (declared?.role !== AdviceArgumentRole.Time) continue;
    localTime = declared;
    break;
  }
  const durationTailStart = duration?.span
    ? partIndexAfterAbsoluteSourceEnd(c.parts, duration.span.end, c.offset)
    : undefined;
  const activityStart = relationHasGrammarFeature(c.relation, "includeDuration") && duration
    ? undefined
    : c.relIndex >= 0
      ? c.relIndex + 1
      : durationTailStart ?? c.argumentStart;
  let activity = activityStart !== undefined && activityStart < c.segmentEnd
    ? argumentFromParts(c.parts, activityStart, c.segmentEnd, c.input, AdviceArgumentRole.Activity, c.options)
    : undefined;
  if (activity && activityStart !== undefined) {
    const bounds = semanticArgumentBounds(c.parts, activityStart, c.segmentEnd);
    activity = {
      ...activity,
      span: {
        start: c.offset + c.parts[bounds.start].sourceStart,
        end: c.offset + c.parts[bounds.endExclusive - 1].sourceEnd
      }
    };
  }
  if (!activity) {
    const configured = c.definition.argumentParserConfig;
    const implicitConcept = configured?.implicitMatchedConcept;
    const matchedSurface = sourceFor(c.parts, c.actionIndex, c.argumentStart, c.input);
    if (implicitConcept && normalizeActionSurface(matchedSurface).indexOf(implicitConcept) >= 0) {
      activity = internalArgument(implicitConcept, matchedSurface, c.options);
      if (activity) activity.role = configured?.implicitMatchedRole ?? AdviceArgumentRole.Activity;
    }
  }
  return { args: parsedArgs(duration, localTime, activity) };
};
const PREPOSED_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const action = c.parts[c.actionIndex];
  if (!action) return { args: [] };
  for (let start = Math.max(0, c.actionIndex - 4); start < c.actionIndex; start += 1) {
    const duration = durationArgumentAt(c.parts, start, c.actionIndex, c.input, c.offset);
    if (!duration?.span) continue;
    const gap = c.input.slice(duration.span.end - c.offset, action.sourceStart);
    if (!gap.trim()) return { args: [duration] };
  }
  return { args: [] };
};

const ACTIVITY_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const configured = c.definition.argumentParserConfig;
  const matchedSurface = sourceFor(c.parts, c.actionIndex, c.argumentStart, c.input);
  const implicitConcept = configured?.implicitMatchedConcept;
  const implicitRole = configured?.implicitMatchedRole ?? AdviceArgumentRole.Activity;
  const implicit = implicitConcept && normalizeActionSurface(matchedSurface).indexOf(implicitConcept) >= 0
    ? internalArgument(implicitConcept, matchedSurface, c.options) : undefined;
  if (implicit) implicit.role = implicitRole;
  return { args: parsedArgs(implicit ?? argumentFromParts(
    c.parts, c.argumentStart, c.segmentEnd, c.input, AdviceArgumentRole.Activity, c.options
  )) };
};
const ACTION_ARGUMENT_PARSERS: Record<MedicationInstructionActionArgumentParser, ActionArgumentParser> = {
  default: DEFAULT_ACTION_ARGUMENT_PARSER,
  "container-activity": CONTAINER_ACTIVITY_ARGUMENT_PARSER,
  "theme-destination-amount": THEME_DESTINATION_AMOUNT_ARGUMENT_PARSER,
  "object-amount-material": OBJECT_AMOUNT_MATERIAL_ARGUMENT_PARSER,
  "amount-material-destination": AMOUNT_MATERIAL_DESTINATION_ARGUMENT_PARSER,
  "amount-duration": AMOUNT_DURATION_ARGUMENT_PARSER,
  "object-duration": OBJECT_DURATION_ARGUMENT_PARSER,
  "object-time": OBJECT_TIME_ARGUMENT_PARSER,
  "mix-substance": MIX_SUBSTANCE_ARGUMENT_PARSER,
  result: RESULT_ARGUMENT_PARSER,
  site: SITE_ARGUMENT_PARSER,
  "site-relation": SITE_RELATION_ARGUMENT_PARSER,
  duration: DURATION_ARGUMENT_PARSER,
  // A bare duration still retains its preceding typed target and local Time.
  "bare-duration": OBJECT_DURATION_ARGUMENT_PARSER,
  "preposed-duration": PREPOSED_DURATION_ARGUMENT_PARSER,
  "duration-activity": DURATION_ACTIVITY_ARGUMENT_PARSER,
  activity: ACTIVITY_ARGUMENT_PARSER
};
function buildActionFrame(
  parts: Lexeme[],
  segmentStart: number,
  segmentEnd: number,
  input: string,
  offset: number,
  sequenceIndex: number,
  options?: ParseOptions
): AdviceFrame | undefined {
  let actionIndex = segmentStart;
  const prefixed = prefixedActionAt(parts, segmentStart, options);
  const polarity = prefixed?.polarity;
  const modality = prefixed?.modality;
  if (prefixed) actionIndex = prefixed.actionIndex;
  const actionMatch = prefixed?.match ?? actionMatchAt(parts, actionIndex, options);
  if (!actionMatch) return undefined;
  const definition = actionMatch.definition;
  const argumentStart = actionIndex + actionMatch.length;
  const relIndex = relationIndex(parts, argumentStart, segmentEnd);
  const rawRelation = relIndex >= 0
    ? actionArgumentRelation(
        key(parts.slice(relIndex, relIndex + 1)[0]),
        definition.preferredRelationSemanticClasses
      )
    : undefined;
  const conditionalTail = relationHasGrammarFeature(rawRelation, "conditionalTail");
  // A conditional daughter starts a different constituent. Its later
  // temporal relations cannot become arguments of the preceding action.
  const nextRelationIndex = relIndex >= 0 && !conditionalTail
    ? relationIndex(parts, relIndex + 1, segmentEnd) : -1;
  const nextRelation = nextRelationIndex >= 0
    ? actionArgumentRelation(
        key(parts[nextRelationIndex]),
        definition.preferredRelationSemanticClasses
      )
    : undefined;
  const relationTargetEnd = nextRelationIndex >= 0 ? nextRelationIndex : segmentEnd;
  const secondaryConditionalTail = relationHasGrammarFeature(nextRelation, "conditionalTail");
  // A clock after a material complement ends before its conditional daughter.
  // Reuse the existing relation grammar, only on this time-complement path.
  const clockTailIndex = nextRelationIndex >= 0 && relationHasGrammarFeature(nextRelation, "timeComplement")
    ? relationIndex(parts, nextRelationIndex + 1, segmentEnd) : -1;
  const clockConditionalTail = clockTailIndex >= 0 && relationHasGrammarFeature(
    actionArgumentRelation(key(parts[clockTailIndex])), "conditionalTail");
  const relation = conditionalTail ? undefined : rawRelation;
  const secondaryActivityTarget = nextRelationIndex >= 0
    ? resolveMedicationInstructionAction(key(parts[nextRelationIndex + 1]), options)
    : undefined;
  const secondaryActivityRelation = nextRelationIndex >= 0 &&
    secondaryActivityTarget &&
    relationHasGrammarFeature(nextRelation, "activityFallback")
      ? nextRelation
      : undefined;
  let semanticEnd = conditionalTail && relIndex >= 0
    ? relIndex
    : secondaryConditionalTail && nextRelationIndex >= 0
      ? nextRelationIndex
      : clockConditionalTail ? clockTailIndex : segmentEnd;
  // A conditional daughter owns its own measurements and observation window.
  // They are not the preceding administration's amount or course duration.
  // Material/destination complements own their quantities independently of
  // the head Amount. Temporal adjuncts permit a later medication amount in
  // flexible word order; other valences may license postdestination amounts
  // too, e.g. Pour into a cup 5 mL.
  const directObjectValence = !definition.argumentParser || definition.argumentParser === "default";
  // Resolve the typed event daughter once, before deciding which complement
  // owns a quantity. WITH breakfast is temporal; WITH 200 mL water owns its
  // own amount. The default argument parser reuses this same daughter.
  const nominalAccompanimentValence = definition.argumentParser === "amount-duration" ||
    definition.argumentParser === "site-relation";
  const relationTimes = (directObjectValence || nominalAccompanimentValence) &&
    relIndex >= 0 && !conditionalTail && relationHasGrammarFeature(relation, "timeComplement")
    ? timeArgumentsFromParts(parts, relIndex + 1, semanticEnd, input, offset, relation, relationTargetEnd, options,
        definition.argumentParser === "site-relation") : undefined;
  const accompaniment = nominalAccompanimentValence && !relationTimes && relIndex >= 0
    ? nominalAccompanimentArgument(parts, relIndex + 1, relationTargetEnd, input, offset, relation, options)
    : undefined;
  const headOwnsAmount = accompaniment !== undefined || directObjectValence && !relationTimes &&
      relationHasGrammarFeature(relation, "accompanimentComplement") ||
    (definition.argumentParser === "amount-material-destination" || definition.argumentParser === "mix-substance") &&
      !relationHasSemanticClass(relation, "temporal");
  let amountEnd = headOwnsAmount && relIndex >= argumentStart ? Math.min(relIndex, semanticEnd) : semanticEnd;
  let laterAccompaniment: AdviceArgument | undefined;
  // A leading temporal adjunct does not transfer ownership of a later
  // material/destination quantity to the head. Follow the same typed valence
  // through later relations while retaining post-temporal head amounts.
  if (!headOwnsAmount && (definition.acceptsAmount || nominalAccompanimentValence) && relIndex >= argumentStart &&
      (relationTimes || relationHasSemanticClass(relation, "temporal"))) {
    let index = nextRelationIndex, current = nextRelation;
    while (index >= 0 && index < semanticEnd) {
      const following = relationIndex(parts, index + 1, semanticEnd);
      const complementEnd = following < 0 ? semanticEnd : following;
      const nominal = nominalAccompanimentValence
        ? nominalAccompanimentArgument(parts, index + 1, complementEnd, input, offset, current, options)
        : undefined;
      const ownsQuantity = nominal !== undefined || (directObjectValence
        ? relationHasGrammarFeature(current, "accompanimentComplement") &&
          !timeArgumentFromParts(parts, index + 1, complementEnd, input, false, options)
        : (definition.argumentParser === "amount-material-destination" || definition.argumentParser === "mix-substance") &&
          !relationHasSemanticClass(current, "temporal"));
      if (ownsQuantity) {
        amountEnd = index;
        if (nominal) laterAccompaniment = nominal;
        else if (directObjectValence) {
          laterAccompaniment = quantifiedEntityArgument(parts, index + 1,
            complementEnd, input, offset, AdviceArgumentRole.Substance, options);
          if (laterAccompaniment) laterAccompaniment.relation = current;
        }
        break;
      }
      index = following;
      current = index >= 0 ? actionArgumentRelation(key(parts[index]),
        definition.preferredRelationSemanticClasses) : undefined;
    }
  }
  // Unit meaning can depend on the full typed action context (a measured
  // topical line and its destination), while its numeric head stays local.
  const amount = definition.acceptsAmount
    ? parseQuantityArgument(parts, argumentStart, semanticEnd, input, offset, options, amountEnd)
    : undefined;
  const duration = parseAnyDurationArgument(parts, argumentStart, semanticEnd, input, offset);

  const argumentParser = ACTION_ARGUMENT_PARSERS[definition.argumentParser ?? "default"] ??
    DEFAULT_ACTION_ARGUMENT_PARSER;
  const parsed = argumentParser({
    definition, parts, actionIndex, argumentStart,
    segmentEnd: definition.argumentParser === "mix-substance" ? semanticEnd : segmentEnd,
    input, offset, options,
    relation, relIndex, relationTargetEnd, conditionalTail, relationTimes, accompaniment, amount, duration,
    separableParticleIndex: actionMatch.separableParticleIndex
  });
  const args = parsed.args;
  pushArgument(args, laterAccompaniment);
  // Orthogonal temporal-event daughters are arguments of the SAME composed
  // action, not a second medication administration. A material WITH/IN
  // relation remains the head's relation while BEFORE/AFTER is owned by the
  // event argument.
  // Not every temporal/conditional connector licenses an Activity.
  // PRN WHEN is a condition daughter, never a "when symptoms" executable
  // activity that can duplicate medication dose and schedule realization.
  const temporalIndex = parsed.tailRelationIndex ?? nextRelationIndex;
  const temporalRelation = temporalIndex === nextRelationIndex ? nextRelation
    : actionArgumentRelation(key(parts[temporalIndex]), definition.preferredRelationSemanticClasses);
  // A multi-complement valence can discover a condition after its second
  // destination. End the action at that boundary so the existing graph
  // relation owner keeps the condition and its complete source span.
  if (temporalIndex >= 0 && relationHasGrammarFeature(temporalRelation, "conditionalTail"))
    semanticEnd = Math.min(semanticEnd, temporalIndex);
  const nextTemporal = temporalIndex >= 0 &&
    relationHasSemanticClass(temporalRelation, "temporal") &&
    relationHasGrammarFeature(temporalRelation, "activityFallback")
      ? temporalRelation : undefined;
  // The shared time grammar licenses clock and event daughters after an
  // earlier complement, including a material amount or procedure duration.
  const nextTimes = relationTimes && relationTimes.length > 1 ? relationTimes
    : temporalIndex >= 0 && relationHasGrammarFeature(temporalRelation, "timeComplement")
      ? timeArgumentsFromParts(parts, temporalIndex + 1, semanticEnd, input, offset, temporalRelation, semanticEnd, options) : undefined;
  if (nextTimes) {
    const bounds = semanticArgumentBounds(parts, temporalIndex + 1, semanticEnd);
    const first = parts[bounds.start], last = parts[bounds.endExclusive - 1];
    for (const time of nextTimes) pushArgument(args, { ...time, relation: time.relation ?? temporalRelation,
      span: time.span ?? (first && last ? { start: offset + first.sourceStart, end: offset + last.sourceEnd } : undefined)
    });
  } else if (temporalIndex >= 0 && temporalRelation === AdviceRelation.Until) {
    const result = argumentFromParts(parts, temporalIndex + 1, segmentEnd, input, AdviceArgumentRole.Result, options);
    if (result) {
      result.relation = temporalRelation;
      pushArgument(args, result);
    }
  } else if (nextTemporal && temporalIndex >= 0) {
    const eventStart = temporalIndex + 1;
    const sourceEvent = trimSemanticText(sourceFor(parts, eventStart, segmentEnd, input));
    let event = argumentFromParts(
      parts, eventStart, segmentEnd, input, AdviceArgumentRole.Activity, options
    );
    if ((event?.role !== AdviceArgumentRole.Activity && event?.role !== AdviceArgumentRole.Time) ||
        !event.conceptId) {
      const target = resolveMedicationInstructionAction(key(parts[eventStart]), options);
      // Only an EXPLICIT declared event-activity concept licenses semantic
      // normalization. A method-coded verb is insufficient evidence:
      // "placing the tablet under the tongue" is NOT interchangeable with
      // "taking medication". Unknown activity daughters stay source-backed.
      const implicit = target?.argumentParserConfig?.implicitMatchedConcept;
      const declared = implicit
        ? internalArgument(implicit, sourceEvent, options) : undefined;
      if (declared?.role === AdviceArgumentRole.Activity) {
        event = declared;
      } else if (event?.role !== AdviceArgumentRole.Activity && event?.role !== AdviceArgumentRole.Time) {
        event = undefined;
      }
    }
    if (event) {
      const first = parts[eventStart];
      const last = parts[segmentEnd - 1];
      pushArgument(args, {
        ...event,
        relation: nextTemporal,
        ...(first && last ? {span:{
          start:offset+first.sourceStart,end:offset+last.sourceEnd
        }}:{})
      });
    }
  } else if (secondaryActivityRelation && nextRelationIndex >= 0) {
    pushArgument(args, argumentFromParts(
      parts, nextRelationIndex + 1, segmentEnd, input, AdviceArgumentRole.Activity, options
    ));
  }
  const materialAttached = args.some((arg) =>
    arg.role === AdviceArgumentRole.Substance || arg.role === AdviceArgumentRole.Material
  );
  const frameRelation = relation && materialAttached ? relation : secondaryActivityRelation ?? relation;
  if (definition.argumentParser === "preposed-duration" &&
      !args.some((arg) => arg.role === AdviceArgumentRole.Duration)) {
    return undefined;
  }
  if (parsed.semanticEnd !== undefined) semanticEnd = parsed.semanticEnd;
  pushArgument(args, amount);
  // A registered relational compound can entail a second typed daughter
  // even when a language realizes both meanings as ONE lexical constituent.
  // Compose its declared semantics once, rather than requiring a duplicated
  // "before ..." phrase to survive multilingual text reparse.
  for (const owner of [...args]) {
    const implication = owner.conceptId
      ? getMedicationInstructionConcept(owner.conceptId)?.impliedArgument : undefined;
    if (!implication || args.some((item) =>
      item.role === implication.role &&
      item.conceptId === implication.conceptId &&
      item.relation === implication.relation
    )) continue;
    const inferred = internalArgument(implication.conceptId,
      getMedicationInstructionConcept(implication.conceptId)?.display ?? owner.text, options);
    if (!inferred || inferred.role !== implication.role) continue;
    pushArgument(args, {
      ...inferred,
      relation: implication.relation,
      span: owner.span ? { ...owner.span } : undefined
    });
  }

  const codings = [
    ...medicationInstructionActionCodings(definition),
    ...medicationInstructionActionContextualCodings(definition, args)
  ];
  let span = trimActionRange(input, rangeFor(parts, segmentStart, semanticEnd, offset), offset);
  const earliestArgumentStart = args.reduce((minimum, arg) =>
    arg.span ? Math.min(minimum, arg.span.start) : minimum, span.start);
  if (earliestArgumentStart < span.start) {
    span = trimActionRange(input, { start: earliestArgumentStart, end: span.end }, offset);
  }
  const frame: AdviceFrame = {
    force: polarity === AdvicePolarity.Negate
      ? AdviceForce.Warning
      : modality === AdviceModality.Should
        ? AdviceForce.Instruction
        : AdviceForce.Sequence,
    polarity,
    modality,
    predicate: {
      lemma: definition.code,
      semanticClass: definition.semanticClass,
      display: definition.display,
      i18n: definition.i18n ? { ...definition.i18n } : undefined,
      realizer: definition.realizer,
      realizerConfig: cloneMedicationInstructionActionRealizerConfig(definition.realizerConfig),
      codings,
      semanticComponents: medicationInstructionActionSemanticComponentsForArgs(definition, args)
    },
    relation: frameRelation,
    args,
    span,
    sourceText: input.slice(span.start - offset, span.end - offset),
    sequenceIndex
  };
  if (prefixed?.preposedTheme) {
    const bounds = prefixed.preposedTheme;
    const theme = argumentFromParts(parts, bounds.start, bounds.end, input, undefined, options);
    if (theme) return composePreposedContactTheme(frame, {
      ...theme, span: rangeFor(parts, bounds.start, bounds.end, offset)
    });
  }
  return frame;
}

interface PrefixedActionMatch {
  actionIndex: number;
  match: ActionMatch;
  polarity?: AdvicePolarity;
  modality?: AdviceModality;
  preposedTheme?: { start: number; end: number };
}

function directivePrefixMatches(parts: Lexeme[], index: number, prefix: (typeof ACTION_DIRECTIVE_PREFIXES)[number]): boolean {
  return prefix.parts.every((part, offset) => key(parts[index + offset]) === part);
}

function prefixedActionAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): PrefixedActionMatch | undefined {
  for (const prefix of ACTION_DIRECTIVE_PREFIXES) {
    if (!directivePrefixMatches(parts, index, prefix)) continue;
    const complementStart = index + prefix.parts.length;
    const actionIndex = prefix.complement === "contact-clause"
      ? complementStart + 1 : complementStart;
    const match = actionMatchAt(parts, actionIndex, options);
    if (!match) continue;
    if (prefix.complement === "contact-clause") {
      // The locale lexicon supplies one complete nominal constituent. Do not
      // search across unknown prose or a separate action for a contact head.
      const theme = resolveMedicationInstructionConcept(key(parts[complementStart]), options);
      if (!theme || !licensesPreposedContactTheme(theme.role, match.definition.semanticClass)) continue;
    }
    return {
      actionIndex,
      match,
      polarity: prefix.polarity,
      modality: prefix.modality,
      ...(prefix.complement === "contact-clause"
        ? { preposedTheme: { start: complementStart, end: actionIndex } } : {})
    };
  }
  return undefined;
}

function negatedActionAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): PrefixedActionMatch | undefined {
  const match = prefixedActionAt(parts, index, options);
  return match?.polarity === AdvicePolarity.Negate ? match : undefined;
}

function actionCandidateIsDoseUnit(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): boolean {
  const current = parts[index];
  const previous = parts[index - 1];
  if (!current || !previous) return false;
  if (previous.kind !== "NUMBER" && previous.kind !== "NUMBER_RANGE") return false;
  return Boolean(normalizeUnit(key(current), options));
}

function actionCandidateBelongsToCurrentFrame(
  parts: Lexeme[],
  index: number,
  current: ActionDefinition | undefined,
  input: string,
  options?: ParseOptions
): boolean {
  if (!current) return false;
  const candidateSurface = key(parts[index]);
  const candidateDefinition = resolveMedicationInstructionAction(candidateSurface, options);
  const candidateCode = candidateDefinition?.code ?? candidateSurface;
  const previous = key(parts[index - 1]);
  const previousKind = parts[index - 1]?.kind;
  const next = key(parts[index + 1]);

  // A declared temporal noun phrase remains the complement of its relation
  // even when its event noun is homographic with a command (e.g. "each use").
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = key(parts[cursor]);
    if (/^[,;:.]$/u.test(token) || ACTION_SEQUENCE_MARKERS.has(token)) break;
    const relation = resolveActionRelationSurface(token);
    if (!relationHasGrammarFeature(relation, "timeComplement")) continue;
    const complement = parts.slice(cursor + 1, index + 1).map(key).join(" ");
    if (resolveMedicationInstructionConcept(complement, options)?.role === AdviceArgumentRole.Time) {
      return true;
    }
    break;
  }

  // An avoidance predicate selects a nominal complement. Only a typed
  // administration amount, not a numeric duration, licenses a new command.
  const nominal = resolveMedicationInstructionConcept(candidateSurface, options);
  const value = parts[index + 1];
  const startsAmount = Boolean(
    value && (value.kind === "NUMBER" || value.kind === "NUMBER_RANGE" ||
      INSTRUCTION_NUMBER_WORDS[key(value)] !== undefined) &&
    instructionQuantityUnitAt(parts, index + 2, parts.length, options) &&
    !durationArgumentAt(parts, index + 1, parts.length, input, 0)
  );
  if (
    current.semanticClass === "avoidance" &&
    ACTION_COORDINATION_CONNECTORS.has(previous) &&
    nominal?.role === AdviceArgumentRole.Substance && !startsAmount
  ) return true;
  // A temporal/prepositional predicate can select a coordinated LIST of
  // substances. An ambiguous noun/verb such as "drink" is not a fresh
  // imperative after "wait ... before food, drink, or other medicines".
  // Reuse typed nominal roles and the existing relation vocabulary;
  // a fresh "drink 10 mL" remains an independent action.
  if (nominal?.role === AdviceArgumentRole.Substance && !startsAmount &&
      (ACTION_COORDINATION_CONNECTORS.has(previous) || /^[,]$/u.test(previous))) {
    let previousNominal: AdviceArgumentRole | undefined;
    let relationOwnsComplement = current.semanticClass === "avoidance";
    for (let cursor = index - 2; cursor >= Math.max(0, index - 7); cursor -= 1) {
      const before = key(parts[cursor]);
      if (/^[;.!?]$/u.test(before)) break;
      const relation = resolveActionRelationSurface(before);
      if (relation && (
        relationHasGrammarFeature(relation, "timeComplement") ||
        relationHasGrammarFeature(relation, "activityFallback") ||
        relationHasGrammarFeature(relation, "accompanimentComplement")
      )) relationOwnsComplement = true;
      if (!previousNominal) {
        const priorConcept = resolveMedicationInstructionConcept(before, options);
        if (priorConcept?.role === AdviceArgumentRole.Substance) {
          previousNominal = priorConcept.role;
        }
      }
    }
    if (relationOwnsComplement && previousNominal === nominal.role) return true;
  }

  for (const license of current.continuationLicenses ?? []) {
    if (license.candidateAction !== candidateCode) continue;
    const previousLicensed = !license.previousConcepts?.length && !license.previousKinds?.length ||
      Boolean(license.previousConcepts?.indexOf(previous) !== -1) ||
      Boolean(previousKind && license.previousKinds?.indexOf(previousKind as "NUMBER" | "NUMBER_RANGE") !== -1);
    const nextLicensed = !license.nextConcepts?.length || license.nextConcepts.indexOf(next) !== -1;
    if (previousLicensed && nextLicensed) return true;
  }

  const relationLicenses = candidateDefinition?.continuationAfterRelations;
  if (relationLicenses?.length) {
    for (let cursor = Math.max(0, index - 3); cursor < index; cursor += 1) {
      if (relationLicenses.indexOf(key(parts[cursor])) !== -1) return true;
    }
  }
  return false;
}

const ACTION_DIRECTIVE_BOUNDARIES = new Set(
  ACTION_DIRECTIVE_PREFIXES.map((prefix) => prefix.parts[0])
);

interface PreposedActionRelation {
  relation: AdviceRelation;
  relationIndex: number;
  targetStart: number;
  targetEnd: number;
}

function preposedActionRelation(
  parts: Lexeme[],
  cursor: number,
  actionStart: number
): PreposedActionRelation | undefined {
  if (cursor >= actionStart) return undefined;
  const relation = resolveActionRelationSurfaceByGrammarFeature(
    key(parts[cursor]),
    "preposedAction"
  );
  if (!relation) return undefined;
  const targetStart = cursor + 1;
  if (targetStart >= actionStart) return undefined;
  return { relation, relationIndex: cursor, targetStart, targetEnd: actionStart };
}

function attachPreposedActionRelation(
  frame: AdviceFrame,
  attachment: PreposedActionRelation,
  parts: Lexeme[],
  sourceText: string,
  baseOffset: number,
  options?: ParseOptions
): void {
  if (frame.relation !== undefined) return;
  frame.relation = attachment.relation;
  const times = timeArgumentsFromParts(parts, attachment.targetStart, attachment.targetEnd,
    sourceText, baseOffset, attachment.relation, attachment.targetEnd, options);
  const fallbackRole = relationHasGrammarFeature(attachment.relation, "activityFallback")
    ? AdviceArgumentRole.Activity
    : undefined;
  if (times) for (const time of times) pushArgument(frame.args, time);
  else pushArgument(frame.args, argumentFromParts(parts, attachment.targetStart,
    attachment.targetEnd, sourceText, fallbackRole, options));
  const first = parts[attachment.relationIndex];
  if (!first) return;
  frame.span.start = baseOffset + first.sourceStart;
  frame.sourceText = sourceText.slice(first.sourceStart, frame.span.end - baseOffset);
}

const ACTION_TAIL_PHRASE_TOKEN_CACHE = new WeakMap<object, string[][]>();

function actionTailPhraseTokens(phrases: ReadonlySet<string>): string[][] {
  const key = phrases as unknown as object;
  const cached = ACTION_TAIL_PHRASE_TOKEN_CACHE.get(key);
  if (cached) return cached;
  const tokens = Array.from(phrases, (phrase) => phrase.split(/\s+/).filter(Boolean));
  ACTION_TAIL_PHRASE_TOKEN_CACHE.set(key, tokens);
  return tokens;
}

function actionTailStartsPhrase(parts: Lexeme[], index: number, phrases: ReadonlySet<string>): boolean {
  for (const words of actionTailPhraseTokens(phrases)) {
    if (!words.length || index + words.length > parts.length) continue;
    if (words.every((word, offset) => key(parts[index + offset]) === word)) return true;
  }
  return false;
}

function actionHasLocalRelationBefore(parts: Lexeme[], actionStart: number, index: number): boolean {
  for (let cursor = actionStart + 1; cursor < index; cursor += 1) {
    if (Boolean(actionArgumentRelation(key(parts[cursor])))) return true;
  }
  return false;
}

function actionHasResolvedLocativeSiteBefore(
  parts: Lexeme[],
  actionStart: number,
  index: number,
  options?: ParseOptions
): boolean {
  for (let cursor = index - 1; cursor > actionStart; cursor -= 1) {
    const relation = resolveActionRelationSurface(key(parts[cursor]));
    if (!relation || !relationHasSemanticClass(relation, "locative")) continue;
    const siteText = parts
      .slice(cursor + 1, index)
      .map((part) => part.original)
      .join(" ")
      .trim();
    if (!siteText) continue;
    const resolved = resolveBodySitePhrase(siteText, options?.siteCodeMap, {
      bodySiteContext: options?.context?.bodySiteContext,
      allowTerminalModifierInheritance: true
    });
    if (resolved?.coding || resolved?.definition) return true;
  }
  return false;
}

function actionTailIsRegimenModifier(
  parts: Lexeme[],
  actionStart: number,
  index: number,
  definition: ActionDefinition | undefined,
  input: string,
  options?: ParseOptions,
  negatedAction = false
): boolean {
  const token = key(parts[index]);
  if (!token) return false;
  // A withholding verb can select an elliptical temporal DOSE nominal. That
  // argument is not an additional global administration timing modifier.
  if (definition?.argumentParserConfig?.medicationConditionEffect &&
      (DOSE_TARGET_EVENT_MEMBERS.has(EVENT_TIMING_TOKENS[token]) ||
       DOSE_TARGET_MERIDIEM_CLOCK_RANGES.has(token))) return false;
  // A procedural action's declared Time daughter has local scope; it cannot
  // become a second global medication administration event.
  if (definition?.argumentParser === "duration-activity" &&
      resolveMedicationInstructionConcept(token, options)?.role === AdviceArgumentRole.Time) {
    return false;
  }
  // A negated procedural directive may take a meal/event lexeme as its
  // OBJECT, not schedule an unrelated medication. "Do not skip meals"
  // therefore keeps the complete source-backed counseling action instead
  // of creating medication timing WITH MEALS.
  if (negatedAction && definition && EVENT_TIMING_TOKENS[token]) {
    // Negation scopes this action even when its positive lexical use is an
    // administration or regimen adjustment. Its object/event cannot become
    // an unrelated positive medication schedule ("never add a bedtime dose").
    return false;
  }
  // A time-like adjective can modify an explicitly typed presentation noun
  // selected by a PROCEDURAL action: "hold only the evening dose" is not a
  // second administration scheduled for the evening. This composes the
  // existing counted-presentation lexicon with the action's object valence;
  // a naked "take at evening" still belongs to the dosage timing grammar.
  const next = parts[index + 1];
  if (definition?.procedural && !definition.primaryAdministrationHead &&
      EVENT_TIMING_TOKENS[token] && next &&
      normalizeUnit(key(next), options)) return false;
  // A lexical avoidance predicate selects its own object and temporal
  // adjuncts; its complement does not schedule the medication administration.
  if (definition?.semanticClass === "avoidance") return false;
  if (PRN_LEADS.has(token) || actionTailStartsPhrase(parts, index, AS_NEEDED_LEAD_PHRASES)) {
    return true;
  }
  if (ACTION_ROUTE_TAIL_SURFACES.has(token)) return true;
  const previous = parts[index - 1];
  const previousValue = previous
    ? previous.kind === "NUMBER" || previous.kind === "NUMBER_RANGE" ||
      INSTRUCTION_NUMBER_WORDS[key(previous)] !== undefined
    : false;
  const localAmountUnit = definition?.acceptsAmount && previousValue
    ? instructionQuantityUnitAt(parts, index, parts.length, options)
    : undefined;
  // The complete typed maximum is a regimen adjunct after the preparation.
  // A comparator without a period still belongs to its own amount/material.
  if (!negatedAction && definition?.definesDose && previous &&
      /^[,;:]$/u.test(previous.original.trim()) &&
      maximumDosePerPeriodAt({ tokens: parts, options }, index)) return true;
  const timing = !localAmountUnit && Boolean(
    TIMING_ABBREVIATIONS[token] ||
    WORD_FREQUENCIES[token] ||
    EVENT_TIMING_TOKENS[token] ||
    EVERY_INTERVAL_TOKENS.has(token) ||
    FREQUENCY_SIMPLE_WORDS[token] !== undefined
  );
  if (!timing) {
    if (!previous || !/^[,;:]$/u.test(previous.original.trim())) return false;
    const relation = resolveActionRelationSurface(token);
    if (!relation) return false;
    const eventTail = parts.slice(index + 1, Math.min(parts.length, index + 4));
    if (!eventTail.some((part) => Boolean(EVENT_TIMING_TOKENS[key(part)]))) return false;
  }
  if (definition?.argumentParser === "object-time") return false;
  if (!actionHasLocalRelationBefore(parts, actionStart, index)) return true;
  // A recognized material/object complement is complete before the next
  // cadence; do not consume the cadence inside the material argument. Other
  // uses of "with" (notably negated food safety) retain their own scope.
  if (definition?.argumentParser === "object-amount-material") return true;
  // A completed typed WITH-material constituent cannot consume a following
  // regimen cadence. This is the same argument unifier used to build the
  // action; a mere preceding preposition without a typed complement does
  // not license this boundary.
  for (let cursor = actionStart + 1; cursor < index - 1; cursor += 1) {
    const relation = resolveActionRelationSurface(key(parts[cursor]));
    // A complete clock daughter also ends before a separate regimen cadence.
    // Reuse the shared clock reader within this existing local-valence walk.
    if (!negatedAction && relationHasGrammarFeature(relation, "timeComplement") &&
        index - cursor <= 3) {
      const clock = parseClockToken(parts[cursor + 1], cursor + 2 < index ? parts[cursor + 2] : undefined);
      if (clock && clock.tokens.length === index - cursor - 1) return true;
    }
    if (!relationHasGrammarFeature(relation, "accompanimentComplement")) continue;
    const complement = argumentFromParts(parts, cursor + 1, index, input, undefined, options);
    if (complement?.role === AdviceArgumentRole.Substance && complement.conceptId) {
      return true;
    }
  }
  return actionHasResolvedLocativeSiteBefore(parts, actionStart, index, options);
}

/**
 * A comma can separate coordinated imperatives, but cannot by itself extend
 * a preceding prohibition. An explicit later and/or followed by a licensed
 * action supplies the list construction; a semicolon, full stop or "then"
 * begins an independent scope.
 */
function actionListCoordination(
  parts: Lexeme[],
  bridgeStart: number,
  actionStart: number,
  options?: ParseOptions
): "conjunction" | "disjunction" | "unknown" {
  const bridge = parts.slice(bridgeStart, actionStart).map(key);
  if (bridge.some((token) =>
    token !== "," && !ACTION_COORDINATION_CONNECTORS.has(token)
  )) return "unknown";
  const explicit = bridge.filter((token) => ACTION_COORDINATION_CONNECTORS.has(token));
  if (explicit.length) return coordinationConnectorKind(explicit[explicit.length - 1]);
  // English and Thai permit bare adjacent imperative daughters in a
  // coordinated list whose final daughter carries the explicit "and/or".
  // Without such a final coordination license, juxtaposition alone is NOT
  // sufficient to inherit the previous prohibition.
  if (bridge.length && bridge.indexOf(",") < 0) return "unknown";

  // Bounded lookahead inside the local coordination clause, not a new
  // sentence-level string parser. Each prospective daughter must be a typed
  // verb/action lexeme, rather than a list of object nouns.
  const end = Math.min(parts.length, actionStart + 24);
  for (let cursor = actionStart + 1; cursor < end; cursor += 1) {
    const token = key(parts[cursor]);
    if (/^[;.!?]$/u.test(token) || ACTION_SEQUENCE_MARKERS.has(token)) break;
    if (!ACTION_COORDINATION_CONNECTORS.has(token)) continue;
    let daughter = cursor + 1;
    while (daughter < end && key(parts[daughter]) === ",") daughter += 1;
    if (daughter >= end || prefixedActionAt(parts, daughter, options)) continue;
    if (actionMatchAt(parts, daughter, options)) {
      return coordinationConnectorKind(token);
    }
  }
  return "unknown";
}

/**
 * A coordinated prohibition cannot inherit across a completed directive.
 * The source tokens already carry punctuation/sequence boundaries, so keep
 * the local typed construction's scope instead of looking ahead beyond its
 * clause and merging unrelated positive actions.
 */
function withinActionDirectiveScope(
  parts: readonly Lexeme[],
  previousEnd: number,
  currentStart: number,
  baseOffset: number
): boolean {
  for (const part of parts) {
    const start = baseOffset + part.sourceStart;
    const end = baseOffset + part.sourceEnd;
    if (start < previousEnd || end > currentStart) continue;
    const surface = part.original.trim();
    if (/^[;.!?:]$/u.test(surface) || ACTION_SEQUENCE_MARKERS.has(key(part))) return false;
  }
  return true;
}

export function parseInstructionActions(
  sourceText: string,
  baseOffset = 0,
  options?: ParseOptions
): AdviceFrame[] {
  const parts = lexInput(sourceText);
  const frames: AdviceFrame[] = [];
  let cursor = 0;
  let sequenceIndex = 0;

  while (cursor < parts.length) {
    let start = -1;
    let negative = false;
    for (let index = cursor; index < parts.length; index += 1) {
      const prefixed = prefixedActionAt(parts, index, options);
      if (prefixed) {
        start = index;
        negative = prefixed.polarity === AdvicePolarity.Negate;
        break;
      }
      if (
        actionMatchAt(parts, index, options) &&
        !actionCandidateIsDoseUnit(parts, index, options) &&
        !actionCandidateIsAnchoredSiteModifier(parts, index, options)
      ) {
        start = index;
        break;
      }
    }
    if (start < 0) break;

    const prefixed = prefixedActionAt(parts, start, options);
    const actionStart = prefixed?.actionIndex ?? start;
    const startingMatch = prefixed?.match ?? actionMatchAt(parts, actionStart, options);
    let end = parts.length;
    for (let index = actionStart + (startingMatch?.length ?? 1); index < parts.length; index += 1) {
      const currentKey = key(parts.slice(index, index + 1)[0]);
      if (actionTailIsRegimenModifier(
        parts, actionStart, index, startingMatch?.definition, sourceText, options, negative
      )) {
        end = index;
        break;
      }
      if (ACTION_SEQUENCE_MARKERS.has(currentKey)) {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = ACTION_COORDINATION_CONNECTORS.has(previousKey) ? index - 1 : index;
        break;
      }
      if (
        /^[,;:]$/u.test(currentKey) &&
        INSTRUCTION_START_WORDS.has(key(parts[index + 1])) &&
        !(currentKey === "," && actionCandidateBelongsToCurrentFrame(
          parts, index + 1, startingMatch?.definition, sourceText, options
        ))
      ) {
        end = index;
        break;
      }
      if (
        ACTION_DIRECTIVE_BOUNDARIES.has(currentKey) &&
        !prefixedActionAt(parts, index, options) &&
        !actionMatchAt(parts, index, options) &&
        !resultativeLeadAt(parts, index, options)
      ) {
        end = index;
        break;
      }
      if (prefixedActionAt(parts, index, options)) {
        const previousKey = key(parts[index - 1]);
        end = ACTION_COORDINATION_CONNECTORS.has(previousKey) ? index - 1 : index;
        break;
      }
      const nextActionMatch = actionMatchAt(parts, index, options);
      if (
        nextActionMatch &&
        !actionCandidateIsDoseUnit(parts, index, options) &&
        !actionCandidateIsAnchoredSiteModifier(parts, index, options) &&
        !actionCandidateBelongsToCurrentFrame(parts, index, startingMatch?.definition, sourceText, options)
      ) {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = ACTION_COORDINATION_CONNECTORS.has(previousKey) ||
          previousKey === "," || resolveActionRelationSurface(previousKey) ||
          resolveAdviceRelationSurface(previousKey) === AdviceRelation.Without
          ? index - 1 : index;
        break;
      }
    }

    let frame = buildActionFrame(parts, start, end, sourceText, baseOffset, sequenceIndex, options);
    if (frame) {
      const left = frames[frames.length - 1];
      const connector = parts.slice(cursor, start);
      const complementRelation = connector.length === 1
        ? resolveAdviceRelationSurface(key(connector[0]))
        : undefined;
      // Under a negated head, "without [gerund]" is a condition of the
      // prohibition, NOT a new positive command to perform that gerund.
      // Keep it as a typed activity complement on the governing action.
      if (left && complementRelation === AdviceRelation.Without &&
          left.polarity === AdvicePolarity.Negate && !prefixed) {
        const activity: AdviceArgument = {
          role: AdviceArgumentRole.Activity,
          text: frame.sourceText,
          normalized: frame.predicate.lemma,
          span: { ...frame.span }
        };
        const joined = {
          ...left,
          relation: left.relation ?? AdviceRelation.Without,
          args: [...left.args, activity],
          span: { ...left.span, end: frame.span.end },
          sourceText: sourceText.slice(left.span.start - baseOffset, frame.span.end - baseOffset)
        };
        frames[frames.length - 1] = joined;
        cursor = end;
        if (ACTION_SEQUENCE_MARKERS.has(key(parts[cursor]))) cursor += 1;
        if (cursor <= start) cursor = start + 1;
        continue;
      }
      if (left && complementRelation === AdviceRelation.Without &&
          left.polarity !== AdvicePolarity.Negate && !prefixed) {
        // A positive action with a negated gerund complement supplies
        // explicit polarity to the subordinate action; the medication dose
        // and manner remain owned by the positive administration.
        const lead = connector[0];
        frame = {
          ...frame,
          force: AdviceForce.Warning,
          polarity: AdvicePolarity.Negate,
          polaritySource: "shared",
          span: { ...frame.span, start: baseOffset + lead.sourceStart },
          sourceText: sourceText.slice(lead.sourceStart, frame.span.end - baseOffset)
        };
      }
      if (left &&
          withinActionDirectiveScope(parts, left.span.end, frame.span.start, baseOffset) &&
          (connector.length || left.polarity === AdvicePolarity.Negate)) {
        const coordination = left.polarity === AdvicePolarity.Negate
          ? actionListCoordination(parts, cursor, start, options)
          : connector.length === 1
            ? coordinationConnectorKind(key(connector[0]))
            : "unknown";
        const composed = composeCoordinatedActionDirective(
          left, frame, coordination,
          Boolean(prefixed) || startingMatch?.definition.semanticClass === "avoidance"
        );
        frames[frames.length - 1] = composed[0];
        frame = composed[1];
      }
      const preposed = preposedActionRelation(parts, cursor, start);
      if (preposed) {
        attachPreposedActionRelation(frame, preposed, parts, sourceText, baseOffset, options);
      }
      // Nonvolitional event predicates can have a prohibitive directive sense.
      // Apply the lexical license after shared negation has composed, so a
      // positive antecedent predicate is not emitted as a commanded action.
      const requiredPolarity = startingMatch?.definition.argumentParserConfig?.requiredDirectivePolarity;
      if (!requiredPolarity || (frame.polarity ?? AdvicePolarity.Affirm) === requiredPolarity) {
        frames.push(frame);
        sequenceIndex += 1;
      }
    }
    cursor = end;
    if (ACTION_SEQUENCE_MARKERS.has(key(parts.slice(cursor, cursor + 1)[0]))) cursor += 1;
    if (cursor <= start) cursor = start + 1;
  }

  return frames;
}

type SemanticSourceKind = "workflow" | "instruction";

interface SemanticSourceSpan extends TextRange {
  kind: SemanticSourceKind;
}

export function frameActionDefinition(
  frame: AdviceFrame,
  options?: ParseOptions
): ActionDefinition | undefined {
  const definition = getMedicationInstructionAction(frame.predicate.lemma, options);
  if (!options?.instructionActionMap) return definition;
  // A stored code can collide with a different configured lexical surface.
  // The frame's selected wording distinguishes definitions sharing that code.
  const named = frame.predicate.display
    ? resolveMedicationInstructionAction(frame.predicate.display, options) : undefined;
  if (named?.code === frame.predicate.lemma) return named;
  const selected = resolveMedicationInstructionActionForMethod({
    text: frame.predicate.display, coding: frame.predicate.codings?.[0]
  }, options);
  return selected?.code === frame.predicate.lemma ? selected : definition;
}

/** A water-consumption counseling frame with a typed fluid substance is
 * supplemental advice, not an independent administered medication. A numeric
 * medicine drink (e.g. 5 mL solution BID) has a separate Amount/medication
 * entity and remains an ordinary drug administration.
 */
const HYDRATION_SUBSTANCE_CONCEPTS = new Set([
  "water", "clean_water", "plenty-of-water"
]);
export function isSupplementalHydrationInstruction(frame: AdviceFrame): boolean {
  return frame.predicate.lemma === "drink" &&
    !frame.args.some(arg => arg.role === AdviceArgumentRole.Amount && arg.quantity) &&
    frame.args.some(arg => arg.role === AdviceArgumentRole.Substance &&
      arg.conceptId !== undefined && HYDRATION_SUBSTANCE_CONCEPTS.has(arg.conceptId));
}

function frameIsProcedural(frame: AdviceFrame, options?: ParseOptions): boolean {
  return isSupplementalHydrationInstruction(frame) ||
    (frameActionDefinition(frame, options)?.procedural ?? false);
}

function definitionCanRepresentPrimaryAdministration(
  definition: ActionDefinition | undefined
): boolean {
  return Boolean(definition && (!definition.procedural || definition.primaryAdministrationHead));
}

function frameOverlapsPrimaryMethod(frame: AdviceFrame, clause: CanonicalSigClause): boolean {
  for (const evidence of clause.evidence) {
    if (evidence.lexicalCategory !== "method") continue;
    for (const span of evidence.spans) {
      if (frame.span.start < span.end && span.start < frame.span.end) return true;
    }
  }
  return false;
}

function frameIsSecondaryAdministration(
  frame: AdviceFrame,
  clause: CanonicalSigClause,
  options?: ParseOptions
): boolean {
  if (frame.polarity === AdvicePolarity.Negate) return true;
  const definition = frameActionDefinition(frame, options);
  if (!definitionCanRepresentPrimaryAdministration(definition)) return false;
  if (!clause.method) return true;
  return !frameOverlapsPrimaryMethod(frame, clause);
}

/**
 * A coded qualitative application adjunct already owns its own typed
 * clinical manner. Do not promote the same primary verb into a second
 * graphical administration merely because its local manner is rich.
 * Compare typed argument roles and source ownership, never rendered text.
 */
function mannerAlreadyOwnedByCodedAdvice(
  frame: AdviceFrame,
  clause: CanonicalSigClause
): boolean {
  if (!frame.args.some((arg) => arg.role === AdviceArgumentRole.Manner)) return false;
  const locallyCoded = clause.additionalInstructions?.some((instruction) =>
    instruction.coding?.code && instruction.frames?.some((coded) =>
      coded.span.start >= frame.span.start &&
      coded.span.end <= frame.span.end &&
      coded.args.some((arg) =>
        arg.role === AdviceArgumentRole.Amount ||
        arg.role === AdviceArgumentRole.Free ||
        arg.role === AdviceArgumentRole.Manner
      )
    )
  );
  if (locallyCoded) return true;
  // A FHIR round-trip may reconstruct its standardized CodeableConcept
  // WITHOUT source spans or advice frames. The single existing structural
  // advice matcher proves whether the typed Manner itself entails that code.
  const matched = matchComposedAdviceCodings([frame]);
  return matched.some((definition) =>
    clause.additionalInstructions?.some((instruction) =>
      codingEquivalent(instruction.coding, definition.coding)
    )
  );
}

function frameIsPrimaryAdministrationWithExtraMeaning(
  frame: AdviceFrame,
  clause: CanonicalSigClause,
  options?: ParseOptions
): boolean {
  if (frame.polarity === AdvicePolarity.Negate || !clause.method) return false;
  const definition = frameActionDefinition(frame, options);
  return Boolean(
    definitionCanRepresentPrimaryAdministration(definition) &&
    frameOverlapsPrimaryMethod(frame, clause) &&
    (frame.modality !== undefined ||
      actionAddsPrimaryObjectMeaning(frame, options) ||
      // A clinical manner belongs to the SAME medication administration
      // whose dose the HPSG chart already projected.
      (frame.args.some((arg) => arg.role === AdviceArgumentRole.Manner) &&
       !mannerAlreadyOwnedByCodedAdvice(frame, clause)))
  );
}


function semanticSourceSpans(clause: CanonicalSigClause): SemanticSourceSpan[] {
  const ranges: SemanticSourceSpan[] = [];
  for (const evidence of clause.evidence) {
    const kind: SemanticSourceKind | undefined =
      evidence.lexicalCategory === "workflow"
        ? "workflow"
        : evidence.lexicalCategory === "instruction"
          ? "instruction"
          : undefined;
    if (!kind) continue;
    for (const span of evidence.spans) {
      const existing = ranges.find((candidate) => candidate.start === span.start && candidate.end === span.end);
      if (!existing) {
        ranges.push({ start: span.start, end: span.end, kind });
      } else if (existing.kind === "instruction" && kind === "workflow") {
        existing.kind = "workflow";
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  return ranges;
}

const REDUNDANT_OPAQUE_TOKENS = new Set([
  "dose",
  "doses",
  "application",
  "applications",
  "time",
  "times"
]);

function opaqueTextIsMeaningful(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const structural = trimmed
    .toLowerCase()
    .replace(/[(),.;:\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!structural) return false;
  const tokens = lexInput(trimmed).map((token) => key(token)).filter(Boolean);
  if (tokens.length && tokens.every((token) =>
    ACTION_SEQUENCE_RELATION_TOKENS.has(token)
  )) {
    return false;
  }
  return !tokens.length || !tokens.every((token) => REDUNDANT_OPAQUE_TOKENS.has(token));
}

function leadingStructuralConnectorLength(text: string): number {
  let consumed = 0;
  for (const token of lexInput(text)) {
    if (token.sourceStart > consumed && text.slice(consumed, token.sourceStart).trim()) break;
    const canonical = key(token);
    if (!(
      ACTION_SEQUENCE_MARKERS.has(canonical) ||
      ACTION_SEQUENCE_RELATION_TOKENS.has(canonical) ||
      ACTION_COORDINATION_CONNECTORS.has(canonical)
    )) break;
    consumed = token.sourceEnd;
  }
  return consumed;
}

function trimOpaqueSpan(input: string, start: number, end: number): CanonicalSourceSpan | undefined {
  while (start < end && /[\s,;:.()]/.test(input[start] ?? "")) start += 1;
  while (end > start && /[\s,;:.()]/.test(input[end - 1] ?? "")) end -= 1;
  if (end <= start) return undefined;
  const leadingLength = leadingStructuralConnectorLength(input.slice(start, end));
  if (leadingLength > 0) {
    start += leadingLength;
    while (start < end && /[\s,;:.()]/.test(input[start] ?? "")) start += 1;
  }
  if (end <= start) return undefined;
  const text = input.slice(start, end);
  if (!opaqueTextIsMeaningful(text)) return undefined;
  return { start, end, text };
}

function workflowOpaqueGaps(
  input: string,
  range: SemanticSourceSpan,
  frames: AdviceFrame[]
): CanonicalSourceSpan[] {
  if (range.kind !== "workflow") return [];
  const within = frames
    .filter((frame) => frame.span.end > range.start && frame.span.start < range.end)
    .slice()
    .sort((left, right) => left.span.start - right.span.start);
  const opaque: CanonicalSourceSpan[] = [];
  let cursor = range.start;
  for (const frame of within) {
    if (frame.span.start > cursor) {
      const gap = trimOpaqueSpan(input, cursor, frame.span.start);
      if (gap) opaque.push(gap);
    }
    cursor = Math.max(cursor, frame.span.end);
  }
  if (cursor < range.end) {
    const gap = trimOpaqueSpan(input, cursor, range.end);
    if (gap) opaque.push(gap);
  }
  return opaque;
}

function pushOpaqueSpan(target: CanonicalSourceSpan[], span: CanonicalSourceSpan): void {
  if (target.some((candidate) => candidate.start === span.start && candidate.end === span.end)) return;
  target.push({ ...span, tokenIndices: span.tokenIndices?.slice() });
}

function trailingDiscourseConnectorSpan(
  input: string,
  start: number,
  end: number
): CanonicalSourceSpan | undefined {
  if (end <= start) return undefined;
  const source = input.slice(start, end);
  const parts = lexInput(source);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!ACTION_DISCOURSE_CONNECTORS.has(key(part))) continue;
    if (!/^[\s,()\-]*$/u.test(source.slice(part.sourceEnd))) return undefined;
    return {
      start: start + part.sourceStart,
      end: start + part.sourceEnd,
      text: input.slice(start + part.sourceStart, start + part.sourceEnd)
    };
  }
  return undefined;
}

function doseSourceRange(clause: CanonicalSigClause): TextRange | undefined {
  for (const evidence of clause.evidence) {
    if (!evidence.rule.startsWith("hpsg.lex.dose")) continue;
    const span = evidence.spans.slice(0, 1)[0];
    if (span) return { start: span.start, end: span.end };
  }
  return undefined;
}

function amountText(dose: CanonicalDoseExpr, source: string): string {
  if (source.trim()) return source.trim();
  if (dose.range) return `${dose.range.low ?? ""}-${dose.range.high ?? ""} ${dose.unit ?? ""}`.trim();
  return `${dose.comparator ?? ""}${dose.value ?? ""} ${dose.unit ?? ""}`.trim();
}

function attachDoseToNearestAction(
  actions: AdviceFrame[],
  clause: CanonicalSigClause,
  input: string,
  options?: ParseOptions
): void {
  if (!clause.dose) return;
  const range = doseSourceRange(clause);
  if (!range) return;
  let best: AdviceFrame | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const definition = frameActionDefinition(action, options);
    if (!definition?.acceptsAmount || action.span.end > range.start) continue;
    const gap = input.slice(action.span.end, range.start);
    if (gap.trim() || gap.length > 8) continue;
    const distance = range.start - action.span.end;
    if (distance < bestDistance) {
      best = action;
      bestDistance = distance;
    }
  }
  if (!best) return;
  best.args.push({
    role: AdviceArgumentRole.Amount,
    text: amountText(clause.dose, input.slice(range.start, range.end)),
    normalized: clause.dose.unit,
    quantity: {
      value: clause.dose.value,
      range: clause.dose.range ? { ...clause.dose.range } : undefined,
      unit: clause.dose.unit,
      ...(clause.dose.comparator ? { comparator: clause.dose.comparator } : {})
    },
    span: range
  });
  best.span.end = range.end;
  best.sourceText = input.slice(best.span.start, best.span.end);
}

function relationFromSourceText(text: string): AdviceRelation | undefined {
  const keys = lexInput(text).map((token) => key(token)).filter(Boolean);
  for (const candidate of keys) {
    const relation = resolveActionRelationSurfaceByGrammarFeature(candidate, "detectInActionGap");
    if (relation) return relation;
    if (ACTION_SEQUENCE_RELATION_TOKENS.has(candidate)) {
      return getUniqueAdviceRelationByGrammarFeature("defaultSequenceRelation");
    }
  }
  return undefined;
}

function buildInstructionRelations(
  input: string,
  actions: AdviceFrame[],
  opaqueSpans: CanonicalSourceSpan[]
): CanonicalInstructionRelation[] {
  const relations: CanonicalInstructionRelation[] = [];
  for (let index = 1; index < actions.length; index += 1) {
    const previous = actions[index - 1];
    const current = actions[index];
    const gapStart = previous.span.end;
    const gapEnd = current.span.start;
    const source = gapEnd > gapStart ? input.slice(gapStart, gapEnd) : "";
    const trimmed = source.trim();
    const explicitRelation = relationFromSourceText(source);
    const onlyStructuralGap = !trimmed || /^[,;:.()\-]+$/.test(trimmed);
    if (!explicitRelation && !onlyStructuralGap) continue;
    // Whitespace/punctuation can license an implicit procedural sequence, but it
    // must not turn a following safety statement into a temporal "then".
    // Warnings/cautions need an explicit sequence marker to acquire that edge.
    if (
      !explicitRelation &&
      (current.force === AdviceForce.Warning || current.force === AdviceForce.Caution)
    ) continue;
    const directEventLink = explicitRelation && relationHasSemanticClass(explicitRelation, "temporal") &&
      resolveActionRelationSurface(trimmed.replace(/^[,;:.()\-\s]+|[,;:.()\-\s]+$/gu, "")) === explicitRelation;
    if (explicitRelation && relationHasGrammarFeature(explicitRelation, "conditionScope") &&
        !directEventLink) {
      const conditionTargetsCurrent = /^[,;:.()\-]/.test(trimmed);
      relations.push({
        kind: explicitRelation,
        toActionIndex: conditionTargetsCurrent ? index : index - 1,
        text: trimmed || undefined,
        span: gapEnd > gapStart ? { start: gapStart, end: gapEnd } : undefined
      });
      continue;
    }
    relations.push({
      kind: explicitRelation ??
        getUniqueAdviceRelationByGrammarFeature("defaultSequenceRelation") ??
        (() => { throw new Error("Missing declarative default sequence relation"); })(),
      fromActionIndex: index - 1,
      toActionIndex: index,
      text: trimmed || undefined,
      span: gapEnd > gapStart ? { start: gapStart, end: gapEnd } : undefined
    });
  }

  for (const opaque of opaqueSpans) {
    const kind = relationFromSourceText(opaque.text);
    if (!kind || !relationHasGrammarFeature(kind, "conditionScope")) continue;
    const after = actions.findIndex((action) => action.span.start >= opaque.end);
    let before = -1;
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      if (actions[index].span.end <= opaque.start) { before = index; break; }
    }
    let target = after;
    if (before >= 0 && after >= 0) {
      const beforeDistance = opaque.start - actions[before].span.end;
      const afterDistance = actions[after].span.start - opaque.end;
      if (beforeDistance <= afterDistance) target = before;
    } else if (before >= 0) target = before;
    if (target < 0) continue;
    if (relations.some((relation) =>
      relation.kind === kind &&
      relation.toActionIndex === target &&
      relation.fromActionIndex === undefined &&
      relation.span?.start === opaque.start &&
      relation.span?.end === opaque.end
    )) continue;
    relations.push({
      kind,
      toActionIndex: target,
      text: opaque.text,
      span: { start: opaque.start, end: opaque.end }
    });
  }

  return relations;
}

function mergedSpanLength(spans: TextRange[]): number {
  if (!spans.length) return 0;
  const ordered = spans
    .filter((span) => span.end > span.start)
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!ordered.length) return 0;
  let total = 0;
  let start = ordered[0].start;
  let end = ordered[0].end;
  for (let index = 1; index < ordered.length; index += 1) {
    const span = ordered[index];
    if (span.start <= end) {
      end = Math.max(end, span.end);
      continue;
    }
    total += end - start;
    start = span.start;
    end = span.end;
  }
  return total + end - start;
}

function buildInstructionCoverage(
  actions: AdviceFrame[],
  relations: CanonicalInstructionRelation[],
  opaqueSpans: CanonicalSourceSpan[]
): CanonicalInstructionCoverage {
  const relationSpans: TextRange[] = [];
  for (const relation of relations) {
    if (relation.span) relationSpans.push(relation.span);
  }
  const allUnderstoodSpans = [...actions.map((action) => action.span), ...relationSpans];
  const effectiveUnderstoodCharacters = mergedSpanLength(allUnderstoodSpans);
  const opaqueCharacters = mergedSpanLength(opaqueSpans.map((span) => ({ start: span.start, end: span.end })));
  const total = effectiveUnderstoodCharacters + opaqueCharacters;
  return {
    understoodCharacters: effectiveUnderstoodCharacters,
    opaqueCharacters,
    ratio: total > 0 ? Math.round((effectiveUnderstoodCharacters / total) * 10000) / 10000 : 0,
    complete: opaqueCharacters === 0
  };
}

function actionSemanticScore(frame: AdviceFrame): number {
  let score = frame.predicate.codings?.length ? 2 : 0;
  for (const arg of frame.args) {
    if (arg.quantity) score += 6;
    if (arg.coding?.code) score += 4;
    if (arg.codings?.length) score += 2;
    if (arg.conceptId) score += 3;
    if (arg.role !== AdviceArgumentRole.Object && arg.role !== AdviceArgumentRole.Free) score += 1;
  }
  return score;
}

function sameArgumentQuantity(left: AdviceArgument, right: AdviceArgument): boolean {
  return left.quantity?.value === right.quantity?.value &&
    left.quantity?.unit === right.quantity?.unit &&
    left.quantity?.comparator === right.quantity?.comparator &&
    left.quantity?.range?.low === right.quantity?.range?.low &&
    left.quantity?.range?.high === right.quantity?.range?.high;
}

function sourceBackedTimeExtension(
  existing: AdviceFrame,
  candidate: AdviceFrame
): boolean {
  if (
    existing.span.start !== candidate.span.start ||
    candidate.span.end <= existing.span.end ||
    existing.relation !== candidate.relation ||
    !candidate.sourceText.startsWith(existing.sourceText)
  ) return false;
  const existingTime = existing.args.find((arg) => arg.role === AdviceArgumentRole.Time);
  const candidateTime = candidate.args.find((arg) => arg.role === AdviceArgumentRole.Time);
  if (!existingTime || !candidateTime) return false;
  const existingSurface = normalizedInstructionSurface(existingTime.text ?? existingTime.normalized ?? "");
  const candidateSurface = normalizedInstructionSurface(candidateTime.text ?? candidateTime.normalized ?? "");
  if (!existingSurface || !candidateSurface.startsWith(`${existingSurface} `)) return false;
  return existing.args.every((arg) => {
    if (arg === existingTime) return true;
    const surface = normalizedInstructionSurface(arg.text ?? arg.normalized ?? "");
    return candidate.args.some((next) =>
      next.role === arg.role &&
      normalizedInstructionSurface(next.text ?? next.normalized ?? "") === surface &&
      sameArgumentQuantity(next, arg)
    );
  });
}

function actionAddsStructuredMeaning(frame: AdviceFrame): boolean {
  return frame.args.some((arg) =>
    Boolean(
      arg.quantity ||
      arg.coding?.code ||
      arg.codings?.length ||
      arg.conceptId ||
      (arg.role !== AdviceArgumentRole.Object && arg.role !== AdviceArgumentRole.Free)
    )
  );
}

function actionAddsPrimaryObjectMeaning(frame: AdviceFrame, options?: ParseOptions): boolean {
  return frame.args.some((arg) => {
    if (arg.role !== AdviceArgumentRole.Object && arg.role !== AdviceArgumentRole.Theme) return false;
    const normalized = normalizeActionSurface(arg.normalized ?? arg.text);
    const words = normalized.split(/\s+/).filter(Boolean);
    const hasReplacementModifier = words.some((word) =>
      ["new", "replacement", "another", "fresh"].indexOf(word) >= 0
    );
    if (!hasReplacementModifier) return false;
    return words.some((word) =>
      Boolean(normalizeUnit(word, options) || PRODUCT_FORM_HINTS[word]?.routeHint)
    );
  });
}

function actionContainedInCanonicalSite(
  frame: AdviceFrame,
  clause: CanonicalSigClause
): boolean {
  for (const evidence of clause.evidence) {
    if (!evidence.rule.startsWith("hpsg.lex.site")) continue;
    for (const span of evidence.spans) {
      if (span.start <= frame.span.start && frame.span.end <= span.end) return true;
    }
  }
  return false;
}

function actionDominatedByCanonicalMethod(
  frame: AdviceFrame,
  clause: CanonicalSigClause,
  options?: ParseOptions,
  primaryAdministrationSpan?: TextRange
): boolean {
  const method = clause.method;
  const definition = frameActionDefinition(frame, options);
  if (!definitionCanRepresentPrimaryAdministration(definition)) return false;
  if (frame.modality !== undefined) return false;
  if (!method || actionAddsStructuredMeaning(frame) || actionAddsPrimaryObjectMeaning(frame, options)) return false;

  const methodText = normalizeActionSurface(method.text ?? "");
  const candidates = [
    frame.predicate.lemma,
    frame.predicate.display ?? "",
    definition?.display ?? "",
    ...(definition?.aliases ?? [])
  ]
    .map(normalizeActionSurface)
    .filter((candidate) => candidate.length > 0);
  const textMatch = candidates.some((candidate) =>
    methodText === candidate ||
    methodText.startsWith(`${candidate} `) ||
    methodText.endsWith(` ${candidate}`) ||
    methodText.includes(` ${candidate} `)
  );

  const methodSpans: TextRange[] = primaryAdministrationSpan
    ? [primaryAdministrationSpan]
    : [];
  if (!methodSpans.length) {
    for (const evidence of clause.evidence) {
      if (evidence.lexicalCategory !== "method") continue;
      for (const span of evidence.spans) methodSpans.push({ start: span.start, end: span.end });
    }
  }
  if (methodSpans.length) {
    const overlapsPrimaryMethod = methodSpans.some((span) =>
      frame.span.start < span.end && span.start < frame.span.end
    );
    if (!overlapsPrimaryMethod) {
      // Product methods such as "Use shampoo" are composed from a primary
      // USE head plus a product sign. The action is already represented when
      // the composite method text names it; an exact later RINSE/WASH action
      // is not dominated merely because it shares the method coding.
      const exactMethodText = candidates.some((candidate) => methodText === candidate);
      return Boolean(textMatch && !exactMethodText);
    }
  } else {
    const workflowStarts: number[] = [];
    for (const evidence of clause.evidence) {
      if (evidence.lexicalCategory !== "workflow") continue;
      for (const span of evidence.spans) workflowStarts.push(span.start);
    }
    if (workflowStarts.length) {
      const primaryWorkflowStart = Math.min(...workflowStarts);
      if (frame.span.start !== primaryWorkflowStart) return false;
    }
  }

  if (method.coding?.code && frame.predicate.codings?.some((coding) =>
    coding.code === method.coding?.code &&
    (coding.system ?? "http://snomed.info/sct") ===
      (method.coding?.system ?? "http://snomed.info/sct")
  )) {
    return true;
  }
  return textMatch;
}

function pushActionIfUnique(
  target: AdviceFrame[],
  frame: AdviceFrame
): boolean {
  const existingIndex = target.findIndex((candidate) =>
    candidate.predicate.lemma === frame.predicate.lemma &&
    candidate.span.start < frame.span.end &&
    frame.span.start < candidate.span.end
  );
  if (existingIndex >= 0) {
    const existing = target[existingIndex];
    // Source-local fragments can omit an earlier coordinated negator.
    // When a complete composed action owns the very same source range,
    // its explicit or inherited polarity wins over an unscoped fragment.
    // This cannot reach across two distinct source events.
    const sameSourceAction = existing.span.start === frame.span.start &&
      existing.span.end === frame.span.end;
    if (sameSourceAction && existing.polarity !== AdvicePolarity.Negate &&
        frame.polarity === AdvicePolarity.Negate) {
      target[existingIndex] = frame;
      return false;
    }
    const existingScore = actionSemanticScore(existing);
    const nextScore = actionSemanticScore(frame);
    if (
      nextScore > existingScore ||
      nextScore === existingScore && sourceBackedTimeExtension(existing, frame)
    ) target[existingIndex] = frame;
    return false;
  }
  target.push(frame);
  return true;
}

function proceduralFramesFromSpan(
  input: string,
  span: CanonicalSourceSpan,
  options?: ParseOptions
): AdviceFrame[] {
  return parseInstructionActions(input.slice(span.start, span.end), span.start, options)
    .filter((frame) => frameIsProcedural(frame, options));
}

function reconcileOpaqueWithActionCoverage(
  input: string,
  opaqueSpans: CanonicalSourceSpan[],
  actions: AdviceFrame[]
): CanonicalSourceSpan[] {
  const result: CanonicalSourceSpan[] = [];
  for (const opaque of opaqueSpans) {
    let fragments: TextRange[] = [{ start: opaque.start, end: opaque.end }];
    for (const action of actions) {
      const next: TextRange[] = [];
      for (const fragment of fragments) {
        if (action.span.end <= fragment.start || action.span.start >= fragment.end) {
          next.push(fragment);
          continue;
        }
        if (action.span.start > fragment.start) {
          next.push({ start: fragment.start, end: action.span.start });
        }
        if (action.span.end < fragment.end) {
          next.push({ start: action.span.end, end: fragment.end });
        }
      }
      fragments = next;
      if (!fragments.length) break;
    }
    for (const fragment of fragments) {
      const trimmed = trimOpaqueSpan(input, fragment.start, fragment.end);
      if (trimmed) pushOpaqueSpan(result, trimmed);
    }
  }
  return result;
}

/** Project the action selected by the closed HPSG condition constituent. */
function conditionRelationsFromHpsgScopes(
  clause: CanonicalSigClause,
  input: string,
  actions: AdviceFrame[]
): CanonicalInstructionRelation[] {
  const result: CanonicalInstructionRelation[] = [];
  for (const scope of clause.instructionScopes ?? []) {
    const target = actions.findIndex(action => scope.target.start <= action.span.start &&
      action.span.end <= scope.target.end);
    if (target < 0) continue;
    result.push({
      kind: scope.kind,
      toActionIndex: target,
      text: input.slice(scope.span.start, scope.span.end).trim(),
      span: { ...scope.span }
    });
  }
  return result;
}

export function refreshInstructionGraphDerivedState(
  graph: CanonicalInstructionGraph
): void {
  const previousActions = graph.relations?.length || graph.primaryOwnership ? graph.actions.slice() : undefined;
  graph.actions.sort((left, right) =>
    left.span.start - right.span.start || left.span.end - right.span.end
  );
  for (let index = 0; index < graph.actions.length; index += 1) {
    graph.actions[index].sequenceIndex = index;
  }
  if (previousActions) {
    const indices = new Map(graph.actions.map((action, index) => [action, index] as const));
    const ownership = graph.primaryOwnership;
    if (ownership?.administrationActionIndex !== undefined)
      ownership.administrationActionIndex = indices.get(previousActions[ownership.administrationActionIndex]);
    if (ownership?.dose) {
      const actionIndex = indices.get(previousActions[ownership.dose.actionIndex]);
      if (actionIndex !== undefined) ownership.dose.actionIndex = actionIndex;
      else delete ownership.dose;
    }
    for (const relation of graph.relations ?? []) {
      const target = indices.get(previousActions[relation.toActionIndex]);
      if (target !== undefined) relation.toActionIndex = target;
      if (relation.fromActionIndex !== undefined) {
        const source = indices.get(previousActions[relation.fromActionIndex]);
        if (source !== undefined) relation.fromActionIndex = source;
      }
    }
  }
  const opaqueSpans = graph.opaqueSpans ?? [];
  opaqueSpans.sort((left, right) => left.start - right.start || left.end - right.end);
  graph.opaqueSpans = opaqueSpans.length ? opaqueSpans : undefined;
  const derived = buildInstructionRelations(graph.sourceText, graph.actions, opaqueSpans);
  const preserved = (graph.relations ?? []).filter((relation) =>
    relationHasGrammarFeature(relation.kind, "conditionScope") && relation.fromActionIndex === undefined
  );
  // An existing grammatical or imported condition retains its action owner.
  // Gap/opaque-span fallback must not attach the same source to a nearer sibling.
  const relations = derived.filter(candidate => !preserved.some(relation =>
    candidate.kind === relation.kind && candidate.fromActionIndex === undefined &&
    candidate.span && relation.span && candidate.span.start < relation.span.end &&
    relation.span.start < candidate.span.end
  ));
  for (const relation of preserved) {
    const relationText = normalizedInstructionSurface(relation.text ?? "");
    if (!relations.some((candidate) => {
      if (candidate.kind !== relation.kind || candidate.toActionIndex !== relation.toActionIndex) return false;
      const candidateText = normalizedInstructionSurface(candidate.text ?? "");
      if (relationText && candidateText) {
        return relationText === candidateText ||
          relationText.includes(candidateText) ||
          candidateText.includes(relationText);
      }
      return candidate.span?.start === relation.span?.start && candidate.span?.end === relation.span?.end;
    })) relations.push(relation);
  }
  graph.relations = relations.length ? relations : undefined;
  const relationOwnedOpaque = (span: CanonicalSourceSpan): boolean => relations.some((relation) =>
    Boolean(relation.span && relation.span.start <= span.start && span.end <= relation.span.end)
  );
  const remainingOpaqueSpans = opaqueSpans.filter((span) => !relationOwnedOpaque(span));
  graph.opaqueSpans = remainingOpaqueSpans.length ? remainingOpaqueSpans : undefined;
  graph.coverage = buildInstructionCoverage(graph.actions, relations, remainingOpaqueSpans);
}

function promoteDoseFromDefiningAction(
  clause: CanonicalSigClause,
  actions: AdviceFrame[],
  options?: ParseOptions
): void {
  if (clause.dose?.value !== undefined || clause.dose?.range) return;
  let first: AdviceArgument["quantity"];
  for (const action of actions) {
    if (action.polarity === AdvicePolarity.Negate ||
        !frameActionDefinition(action, options)?.definesDose) continue;
    const quantity = action.args.find(arg =>
      arg.role === AdviceArgumentRole.Amount && arg.quantity)?.quantity;
    if (!quantity) continue;
    if (!first) first = quantity;
    else if (quantity.value !== first.value || quantity.unit !== first.unit ||
        quantity.comparator !== first.comparator ||
        quantity.range?.low !== first.range?.low || quantity.range?.high !== first.range?.high) return;
  }
  if (!first) return;
  clause.dose = {
    value: first.value,
    range: first.range ? { ...first.range } : undefined,
    unit: first.unit,
    ...(first.comparator ? { comparator: first.comparator } : {})
  };
}

function canonicalPrimaryAdministrationSpan(
  clause: CanonicalSigClause,
  frames: readonly AdviceFrame[]
): TextRange | undefined {
  const semantic = frames
    .filter((frame) => frame.polarity !== AdvicePolarity.Negate && actionMatchesCanonicalMethod(frame, clause))
    .slice()
    .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)[0];
  if (semantic) {
    let best: TextRange | undefined;
    for (const evidence of clause.evidence) {
      if (evidence.lexicalCategory !== "method") continue;
      for (const span of evidence.spans) {
        if (span.start < semantic.span.start || semantic.span.end < span.end) continue;
        const candidate = { start: span.start, end: span.end };
        if (!best ||
            candidate.end - candidate.start < best.end - best.start ||
            candidate.end - candidate.start === best.end - best.start && candidate.start < best.start) {
          best = candidate;
        }
      }
    }
    return best ?? { start: semantic.span.start, end: semantic.span.end };
  }
  for (const evidence of clause.evidence) {
    if (evidence.lexicalCategory !== "method") continue;
    const span = evidence.spans[0];
    if (span) return { start: span.start, end: span.end };
  }
  return undefined;
}

/** Record the owner after HPSG/action promotion established the live dose. */
function doseDefiningPrimarySpan(
  clause: CanonicalSigClause,
  frames: readonly AdviceFrame[],
  options?: Pick<ParseOptions, "instructionActionMap">
): TextRange | undefined {
  // A standalone dose-defining preparation can supply the HPSG dose without
  // a method head. Record that existing owner while the live dose proves
  // the relationship; imported spanless graphs must not infer a deletion.
  if (!clause.dose) return undefined;
  let doseOwner: AdviceFrame | undefined;
  for (const frame of frames) {
    if (frame.polarity === AdvicePolarity.Negate ||
        !frameActionDefinition(frame, options)?.definesDose ||
        !frame.args.some(arg => arg.role === AdviceArgumentRole.Amount && quantityCoveredByDose(arg, clause.dose))) continue;
    if (doseOwner) return undefined;
    doseOwner = frame;
  }
  return doseOwner ? { start: doseOwner.span.start, end: doseOwner.span.end } : undefined;
}

/**
 * HPSG-composed instruction meaning is the source of truth for structurally
 * scoped advice coding. Preliminary phrase-level coding can carry an
 * incomplete directive (notably the positive half of a negative coordination).
 * Reconcile it BEFORE the FHIR projection, using the single advice matcher.
 */
function reconcileComposedAdviceCoding(
  clause: CanonicalSigClause,
  actionProgram: readonly AdviceFrame[]
): void {
  if (!actionProgram.length) return;
  const proven = matchComposedAdviceCodings(actionProgram);
  const provenCodes = new Set(proven.map((definition) =>
    `${definition.coding?.system ?? SNOMED_SYSTEM}|${definition.coding?.code ?? ""}`
  ));
  const reconciled = (clause.additionalInstructions ?? []).map((instruction) => {
    const coding = instruction.coding;
    // Some provisional advice frames rephrase a subordinate negative gerund
    // as a positive administration (e.g. "Take without chewing"). A matching
    // source-local, scoped negative action owns that ENTIRE original fragment,
    // so the provisional positive paraphrase is not an independent directive.
    // Preserve the original source and the composed negative graph action.
    const supersededLocalParaphrase = !coding?.code && Boolean(
      instruction.frames?.length && instruction.frames.every((provisional) =>
        provisional.polarity !== AdvicePolarity.Negate &&
        actionProgram.some((semantic) =>
          semantic.polarity === AdvicePolarity.Negate &&
          semantic.span.start === provisional.span.start &&
          semantic.span.end === provisional.span.end &&
          semantic.predicate.lemma !== provisional.predicate.lemma
        )
      )
    );
    if (supersededLocalParaphrase) return undefined;
    if (!coding?.code || !adviceCodingNeedsComposedScope(coding.system ?? SNOMED_SYSTEM, coding.code)) {
      return instruction;
    }
    if (provenCodes.has(`${coding.system ?? SNOMED_SYSTEM}|${coding.code}`)) return instruction;

    // Preserve source and the correctly scoped predicate rather than retaining
    // the preliminary parser's misleading positive-coded paraphrase.
    const semantic = actionProgram.find((frame) =>
      instruction.frames?.some((candidate) =>
        frame.span.start < candidate.span.end &&
        candidate.span.start < frame.span.end &&
        frame.predicate.lemma === candidate.predicate.lemma
      )
    );
    // A locally parsed clinical qualifier may have a complete typed
    // AdviceFrame even when it is NOT a standalone procedural graph action
    // (slowly, empty-stomach, drowsiness). Absence from the procedural graph
    // is not evidence that its original, structurally parsed coding was false.
    // Only a real overlapping composed action can supersede that candidate.
    if (!semantic) return instruction;
    // An opaque nominal in a larger action cannot disprove the same local
    // constituent's typed lexical coding. Only a changed/scoped meaning may
    // replace it with the whole action and its independent medication amount.
    const retainsTypedNominal = instruction.frames?.some(provisional => {
      const argument = provisional.args.length === 1 ? provisional.args[0] : undefined;
      return argument?.conceptId && argument.normalized && provisional.polarity === semantic.polarity &&
        provisional.modality === semantic.modality && provisional.relation === semantic.relation &&
        semantic.span.start <= provisional.span.start && provisional.span.end <= semantic.span.end &&
        semantic.args.some(candidate => candidate.role === AdviceArgumentRole.Object &&
          !candidate.conceptId && candidate.normalized === argument.normalized);
    });
    if (retainsTypedNominal) return instruction;
    return {
      ...instruction,
      text: realizeInstructionAction(semantic, "en"),
      i18n: { ...(instruction.i18n ?? {}), th: realizeInstructionAction(semantic, "th") },
      coding: undefined,
      frames: [semantic]
    };
  }).filter((instruction): instruction is CanonicalAdditionalInstructionExpr => Boolean(instruction));
  for (const definition of proven) {
    const coding = definition.coding;
    if (!coding?.code) continue;
    if (reconciled.some((instruction) =>
      instruction.coding?.code === coding.code &&
      (instruction.coding?.system ?? SNOMED_SYSTEM) === (coding.system ?? SNOMED_SYSTEM)
    )) continue;
    reconciled.push({
      text: definition.text,
      i18n: definition.i18n ? { ...definition.i18n } : undefined,
      coding: {
        ...definition.coding,
        i18n: definition.i18n ? { ...definition.i18n } : undefined
      }
    });
  }
  // Empty reconciliation is still a semantic change: the only preliminary
  // "Take without chewing" frame may have been superseded by a true negated
  // subordinate action. Do not preserve that invalid positive instruction.
  if (reconciled.length || clause.additionalInstructions?.length) {
    clause.additionalInstructions = reconciled;
  }
}

export function buildInstructionGraph(
  input: string,
  clause: CanonicalSigClause,
  options?: ParseOptions,
  semanticOwnershipRanges?: readonly TextRange[],
  proceduralFrames?: readonly AdviceFrame[]
): CanonicalInstructionGraph | undefined {
  // Finalization owns the fields it extends and reorders; HPSG retains its frames.
  const fullInputFrames = proceduralFrames
    ? proceduralFrames.map(frame => ({ ...frame, args: frame.args.slice(), span: { ...frame.span } }))
    : parseInstructionActions(input, 0, options);
  const actions: AdviceFrame[] = [];
  const opaqueSpans: CanonicalSourceSpan[] = [];
  reconcileComposedAdviceCoding(clause, fullInputFrames);
  let primaryAdministrationSpan = canonicalPrimaryAdministrationSpan(clause, fullInputFrames);
  // A source noun between the typed administration head and its matching
  // amount belongs to that primary action's object slot. It is still retained
  // verbatim by clause.rawText and graph.sourceText, but must not be promoted
  // into an independent later instruction merely because medication identity
  // is outside Dosage semantics.
  const primaryObjectGap = (() => {
    if (!primaryAdministrationSpan || !clause.dose) return undefined;
    let owner: AdviceFrame | undefined;
    let amount: AdviceArgument | undefined;
    for (const frame of fullInputFrames) {
      if (frame.polarity === AdvicePolarity.Negate ||
          !actionMatchesCanonicalMethod(frame, clause) ||
          frame.span.start > primaryAdministrationSpan.start ||
          primaryAdministrationSpan.end > frame.span.end) continue;
      const candidateAmount = frame.args.find((arg) =>
        arg.span && quantityCoveredByDose(arg, clause.dose)
      );
      if (!candidateAmount) continue;
      if (!owner || frame.span.start < owner.span.start ||
          frame.span.start === owner.span.start && frame.span.end < owner.span.end) {
        owner = frame;
        amount = candidateAmount;
      }
    }
    if (!owner || !amount?.span || amount.span.start < primaryAdministrationSpan.end) return undefined;
    return {
      start: primaryAdministrationSpan.end,
      end: amount.span.start,
      owner
    };
  })();
  const temporalEndpoints = new Set<AdviceFrame>();
  for (const relation of buildInstructionRelations(input, fullInputFrames, [])) {
    if (relation.fromActionIndex === undefined || !relationHasSemanticClass(relation.kind, "temporal")) continue;
    temporalEndpoints.add(fullInputFrames[relation.fromActionIndex]);
    temporalEndpoints.add(fullInputFrames[relation.toActionIndex]);
  }
  const ownsTemporalEdge = (frame: AdviceFrame): boolean => {
    for (const endpoint of temporalEndpoints) {
      if (endpoint && endpoint.predicate.lemma === frame.predicate.lemma &&
          endpoint.span.start < frame.span.end && frame.span.start < endpoint.span.end) return true;
    }
    return false;
  };
  for (const range of semanticSourceSpans(clause)) {
    const parsed = parseInstructionActions(input.slice(range.start, range.end), range.start, options);
    const accepted: AdviceFrame[] = [];
    for (const frame of parsed) {
      if (range.kind === "instruction" && !frameIsProcedural(frame, options)) {
        continue;
      }
      if (pushActionIfUnique(actions, frame)) accepted.push(frame);
    }
    for (const opaque of workflowOpaqueGaps(input, range, accepted)) {
      pushOpaqueSpan(opaqueSpans, opaque);
    }
    if (
      range.kind === "instruction" &&
      accepted.length === 0 &&
      actions.some((action) => action.span.start < range.end && range.start < action.span.end)
    ) {
      const opaque = trimOpaqueSpan(input, range.start, range.end);
      if (opaque) pushOpaqueSpan(opaqueSpans, opaque);
    }
  }
  for (const span of clause.leftovers) {
    if (primaryObjectGap &&
        primaryObjectGap.start <= span.start && span.end <= primaryObjectGap.end &&
        primaryObjectGap.owner.span.start <= span.start && span.end <= primaryObjectGap.owner.span.end) {
      continue;
    }
    const accepted: AdviceFrame[] = [];
    for (const frame of proceduralFramesFromSpan(input, span, options)) {
      if (pushActionIfUnique(actions, frame)) accepted.push(frame);
    }
    if (accepted.length) {
      const synthetic: SemanticSourceSpan = {
        start: span.start,
        end: span.end,
        kind: "workflow"
      };
      for (const opaque of workflowOpaqueGaps(input, synthetic, accepted)) {
        pushOpaqueSpan(opaqueSpans, opaque);
      }
    } else if (opaqueTextIsMeaningful(span.text)) {
      pushOpaqueSpan(opaqueSpans, span);
    }
  }
  for (const frame of fullInputFrames) {
    if (semanticOwnershipRanges?.some((range) =>
      range.start <= frame.span.start && frame.span.end <= range.end
    )) continue;
    if (
      frameIsProcedural(frame, options) ||
      frameIsSecondaryAdministration(frame, clause, options) ||
      frameIsPrimaryAdministrationWithExtraMeaning(frame, clause, options) ||
      ownsTemporalEdge(frame)
    ) {
      pushActionIfUnique(actions, frame);
    }
  }
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const definition = frameActionDefinition(actions[index], options);
    const participatesInProcedureSequence = Boolean(
      definition?.procedural &&
      actions.some((candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.polarity !== AdvicePolarity.Negate &&
        frameActionDefinition(candidate, options)?.procedural
      )
    );
    const redundantCanonicalAdministration = Boolean(
      definitionCanRepresentPrimaryAdministration(definition) &&
      actions[index].modality === undefined &&
      !participatesInProcedureSequence &&
      primaryActionCoveredByCanonicalClause(actions[index], actions, clause)
    );
    if (
      !ownsTemporalEdge(actions[index]) && (
        redundantCanonicalAdministration ||
        actionContainedInCanonicalSite(actions[index], clause) ||
        // A procedural step remains part of a multi-action workflow even
        // when its verb also supplies the canonical administration method.
        // Removing it would turn "crush, mix, swallow" into a program that
        // never administers its prepared medicine.
        (!participatesInProcedureSequence &&
          actionDominatedByCanonicalMethod(actions[index], clause, options, primaryAdministrationSpan))
      )
    ) {
      actions.splice(index, 1);
    }
  }
  if (!actions.length && !opaqueSpans.length) return undefined;
  promoteDoseFromDefiningAction(clause, actions, options);
  attachDoseToNearestAction(actions, clause, input, options);
  primaryAdministrationSpan ??= doseDefiningPrimarySpan(clause, actions, options);
  // HPSG evidence can own the entire ", but <instruction>" span while the
  // action frame correctly begins at the verb. Retain the closed-class
  // discourse daughter separately so graph realization does not turn
  // contrast into temporal sequence. This bounded scan runs only when a
  // surviving post-administration action exists.
  if (primaryAdministrationSpan) {
    const ordered = actions.slice().sort((left, right) => left.span.start - right.span.start);
    let floor = primaryAdministrationSpan.end;
    for (const action of ordered) {
      if (action.span.start < primaryAdministrationSpan.end) {
        floor = Math.max(floor, action.span.end);
        continue;
      }
      const connector = trailingDiscourseConnectorSpan(input, floor, action.span.start);
      if (connector) pushOpaqueSpan(opaqueSpans, connector);
      floor = Math.max(floor, action.span.end);
    }
  }
  const reconciledOpaque = reconcileOpaqueWithActionCoverage(input, opaqueSpans, actions);
  if (!clause.method && actions.length) {
    const firstStart = Math.min(...actions.map((action) => action.span.start));
    const lastEnd = Math.max(...actions.map((action) => action.span.end));
    const exactProcedureText = input.slice(firstStart, lastEnd).trim();
    if (exactProcedureText) clause.patientInstruction = exactProcedureText;
  }
  const graph: CanonicalInstructionGraph = {
    actions,
    primaryAdministrationSpan,
    opaqueSpans: reconciledOpaque.length ? reconciledOpaque : undefined,
    sourceText: input,
    sourceLocale: baseLanguageTag(options?.locale) ?? inferMedicationLocale(input, "en")
  };
  const hpsgConditionRelations = conditionRelationsFromHpsgScopes(clause, input, actions);
  graph.relations = hpsgConditionRelations.length ? hpsgConditionRelations : undefined;
  refreshInstructionGraphDerivedState(graph);
  graph.primaryOwnership = inferPrimaryOwnership(graph, clause, options);
  return graph;
}

function translatedQuantity(
  quantity: NonNullable<AdviceArgument["quantity"]>,
  locale: string
): string {
  // Amounts without any numeric bound remain editable facts, not an
  // administration quantity. Realizers must fall back to source argument
  // text, rather than producing 'at most mg' without a number.
  if (quantity.value === undefined && quantity.range?.low === undefined &&
      quantity.range?.high === undefined) return "";
  const singular = quantity.range
    ? quantity.range.low === undefined && quantity.range.high === 1 ||
      quantity.range.high === undefined && quantity.range.low === 1
    : quantity.value === 1;
  const labels = quantity.unit ? INSTRUCTION_QUANTITY_UNIT_LABELS.get(quantity.unit) : undefined;
  const localizedLabels = labels ? localizedConfig(labels.locales, locale, "en") : undefined;
  const unit = localizedLabels
    ? (singular ? localizedLabels.one : localizedLabels.other)
    : (quantity.unit ?? "");
  const qualifier = quantityComparatorText(quantity.comparator, locale);
  if (quantity.range) {
    const { low, high } = quantity.range;
    if (low === undefined || high === undefined) {
      const bound = quantityComparatorText(low === undefined ? "<=" : ">=", locale);
      return `${qualifier}${bound}${low ?? high} ${unit}`.trim();
    }
    return `${qualifier}${low}-${high} ${unit}`.trim();
  }
  return `${qualifier}${quantity.value ?? ""} ${unit}`.trim();
}

function translatedArgument(arg: AdviceArgument, locale: string): string {
  // A comparator alone does not identify a numeric administration amount.
  // Keep the original source argument for review instead of displaying
  // a fabricated valueless "at most mg" quantity.
  if (arg.quantity) {
    if (arg.quantity.value !== undefined || arg.quantity.range?.low !== undefined ||
        arg.quantity.range?.high !== undefined) {
      const amount = translatedQuantity(arg.quantity, locale);
      // A measured nominal keeps its entity; a bare quantity's normalized
      // unit is already part of the amount realization.
      const nominal = arg.normalized ?? localizedValue(arg.i18n, locale);
      const entity = arg.role === AdviceArgumentRole.Destination || arg.role === AdviceArgumentRole.Substance ||
        arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme ||
        arg.role === AdviceArgumentRole.Material;
      return entity && nominal && nominal !== arg.quantity.unit && !normalizeUnit(nominal)
        ? joinLocalizedTokens(locale, [amount, translatedArgumentConcept(arg, locale)])
        : amount;
    }
    return arg.text || arg.normalized || "";
  }
  const looseQuantity = (arg.text ?? arg.normalized ?? "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+(.+)$/u);
  if (looseQuantity) {
    const unit = normalizeUnit(looseQuantity[2]);
    if (unit) return translatedQuantity({ value: Number(looseQuantity[1]), unit }, locale);
  }
  if (arg.role === AdviceArgumentRole.Time && arg.normalized) {
    const localized = localizedTimeArgument(arg.normalized, locale);
    if (localized) return localized;
  }
  const direct = localizedValue(arg.i18n, locale);
  if (direct) return direct;
  if (arg.role === AdviceArgumentRole.Activity && arg.normalized) {
    const action = resolveMedicationInstructionAction(arg.normalized);
    if (action) {
      const sourceLocale = inferMedicationLocale(arg.text, "en");
      const targetLocale = baseLanguageTag(locale) ?? locale.toLowerCase();
      if (sourceLocale === targetLocale) return arg.text;
      const localizedAction = localizedValue(action.i18n, locale);
      if (localizedAction) return localizedAction;
      const display = action.display.trim();
      return display ? display.charAt(0).toLowerCase() + display.slice(1) : arg.text;
    }
  }
  return arg.normalized ?? arg.text;
}

function translatedArgumentConcept(arg: AdviceArgument, locale: string): string {
  return localizedValue(arg.i18n, locale) ?? arg.normalized ?? arg.text;
}

/**
 * A partly understood complement cannot be rendered as if all of its
 * constituents were localized. Preserve the entire editable source action
 * instead of combining a translated verb with untranslated opaque fragments.
 * Only the Thai cross-locale case needs this check; English source and
 * recognized argument translations keep the normal fast realization.
 */
function hasUntranslatedThaiArgument(frame: AdviceFrame, locale: string): boolean {
  if (baseLanguageTag(locale) !== "th") return false;
  return frame.args.some((arg) => {
    // Only an opaque nominal complement requires atomic source fallback.
    // Typed manner/time/activity arguments can be realized compositionally
    // by their existing specialized realizer even without per-argument i18n.
    if (arg.role !== AdviceArgumentRole.Object &&
        arg.role !== AdviceArgumentRole.Theme) return false;
    if (arg.quantity || localizedValue(arg.i18n, locale)) return false;
    const source = (arg.text ?? arg.normalized ?? "").trim();
    if (!source || !/[A-Za-z]/u.test(source) ||
        inferMedicationLocale(source, "en") === "th") return false;
    // The existing quantity grammar can localize "2 tablets" from an
    // unannotated object; it is not an unresolved English complement.
    const realized = translatedArgument(arg, locale);
    return realized === (arg.normalized ?? arg.text);
  });
}

function actionLabel(
  frame: AdviceFrame, locale: string, definition: ActionDefinition | undefined, roundtripSafe = false
): string {
  const selectedLabel = localizedValue(frame.predicate.i18n, locale);
  // Stock roundtrip wording may refine its normal label, but cannot replace
  // a different translation already selected and retained in the frame.
  return (roundtripSafe &&
    (selectedLabel === undefined || selectedLabel === localizedValue(definition?.i18n, locale))
    ? localizedValue(definition?.roundtripI18n, locale) : undefined) ??
    selectedLabel ??
    localizedValue(definition?.i18n, locale) ??
    frame.predicate.display ??
    definition?.display ??
    frame.predicate.lemma;
}

type ActionRealizationContext = InstructionActionRealizationInput;

type ActionRealizer = (context: ActionRealizationContext) => string;
function defaultActionArguments(frame: AdviceFrame) {
  let explicitAccompaniment: AdviceArgument | undefined, unmarkedSubstances = 0;
  let additionalAccompaniments: AdviceArgument[] | undefined;
  for (const arg of frame.args) {
    if (arg.role === AdviceArgumentRole.Substance && !arg.relation) unmarkedSubstances++;
    if ((arg.role === AdviceArgumentRole.Theme || arg.role === AdviceArgumentRole.Object ||
        arg.role === AdviceArgumentRole.Site || arg.role === AdviceArgumentRole.Substance ||
        arg.role === AdviceArgumentRole.Material) &&
        relationHasSemanticClass(arg.relation, "accompaniment")) {
      if (explicitAccompaniment) (additionalAccompaniments ??= []).push(arg);
      else explicitAccompaniment = arg;
    }
  }
  let objectArg: AdviceArgument | undefined;
  let relationTargetArg = explicitAccompaniment;
  let amountArg: AdviceArgument | undefined;
  for (const arg of frame.args) {
    if (arg.role === AdviceArgumentRole.Amount) amountArg ??= arg;
    else if (arg.role === AdviceArgumentRole.Theme || arg.role === AdviceArgumentRole.Object ||
        arg.role === AdviceArgumentRole.Site || arg.role === AdviceArgumentRole.Substance ||
        arg.role === AdviceArgumentRole.Material && relationHasSemanticClass(arg.relation, "accompaniment")) {
      // A WITH daughter remains an accompaniment when the medication object
      // is implicit. A bare substance without that relation can be the object.
      if (arg.relation && relationHasSemanticClass(arg.relation, "accompaniment") ||
          !explicitAccompaniment && arg.role === AdviceArgumentRole.Substance &&
            relationHasSemanticClass(frame.relation, "accompaniment") &&
            (unmarkedSubstances < 2 || objectArg !== undefined))
        relationTargetArg ??= arg;
      else if (!objectArg || objectArg.role === AdviceArgumentRole.Site &&
          relationHasSemanticClass(objectArg.relation ?? frame.relation, "locative") &&
          (arg.role === AdviceArgumentRole.Theme || arg.role === AdviceArgumentRole.Object)) objectArg = arg;
      else relationTargetArg ??= arg;
    }
  }
  return { objectArg, relationTargetArg, amountArg, additionalAccompaniments };
}

function defaultActionAccompaniment(c: ActionRealizationContext, arg: AdviceArgument | undefined): string | undefined {
  if (!arg) return undefined;
  const relation = arg.relation ?? c.frame.relation;
  const materialArgument = arg.role === AdviceArgumentRole.Substance ||
    arg.role === AdviceArgumentRole.Material ||
    // The explicit relation owns a nominal accompaniment independently of
    // the medication object, including typed Object and Theme arguments.
    ((arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme ||
      arg.role === AdviceArgumentRole.Site) && relationHasSemanticClass(relation, "accompaniment"));
  if (!materialArgument || !relation ||
      !(relationHasSemanticClass(relation, "accompaniment") || relationHasSemanticClass(relation, "locative")))
    return undefined;
  const target = translatedArgument(arg, c.locale);
  if (!target) return undefined;
  const localized = localizeAdviceRelation(relation, c.locale, "complement") ?? relation;
  return joinLocalizedTokens(c.locale, [localized, target]);
}

const DEFAULT_ACTION_REALIZER = (
  c: ActionRealizationContext, selected = defaultActionArguments(c.frame)
): string => {
  const { objectArg, relationTargetArg, amountArg } = selected;
  const object = !objectArg ? undefined : objectArg.role === AdviceArgumentRole.Site ? c.site
    : objectArg.role === AdviceArgumentRole.Substance ? c.substance : c.theme;
  const amount = c.amount;
  const profile = localeRealizationProfile(c.locale);
  const appendLocale = (base: string, value: string | undefined): string =>
    value ? `${base}${base ? profile.tokenSeparator : ""}${value}` : base;
  const appendQuantity = (base: string, value: string | undefined): string =>
    value ? `${base}${base ? profile.quantitySeparator : ""}${value}` : base;
  const appendDuration = (base: string, value: string | undefined): string => {
    if (!value) return base;
    const phrase = joinLocalizedTokens(c.locale, [profile.durationPrefix || undefined, value]);
    return `${base}${base ? profile.quantitySeparator : ""}${phrase}`;
  };

  const activityRelation = c.activity &&
    (relationHasGrammarFeature(c.frame.relation, "activityFallback") ||
      relationHasSemanticClass(c.frame.relation, "accompaniment"))
    ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation
    : undefined;
  const activityPhrase = activityRelation && c.activity
    ? joinLocalizedTokens(c.locale, [activityRelation, c.activity])
    : undefined;
  const siteArgument = objectArg?.role === AdviceArgumentRole.Site ? objectArg
    : c.site ? c.frame.args.find(arg => arg.role === AdviceArgumentRole.Site) : undefined;
  const locativeRelation = c.site ? instructionSiteRelation(c, siteArgument) : undefined;
  const resultRelation = c.result && c.frame.relation
    ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation
    : undefined;
  const resultPhrase = c.result && resultRelation
    ? joinLocalizedTokens(c.locale, [resultRelation, c.result])
    : undefined;

  let text = appendLocale(c.label, object);
  text = appendQuantity(text, amount);
  text = appendLocale(text, c.manner);

  if (locativeRelation && c.site) {
    // Rebuild only when the selected object is the site itself. A separate
    // medication Theme/Object keeps its quantity and name before the site.
    if (objectArg?.role === AdviceArgumentRole.Site) {
      text = appendQuantity(c.label, amount);
      text = appendLocale(text, c.manner);
    }
    text = appendLocale(text, joinLocalizedTokens(c.locale, [locativeRelation, c.site]));
  }

  text = appendDuration(text, c.duration);
  text = appendLocale(text, realizeTimeArgument(c));
  text = appendLocale(text, defaultActionAccompaniment(c, relationTargetArg));
  if (selected.additionalAccompaniments) for (const arg of selected.additionalAccompaniments)
    text = appendLocale(text, defaultActionAccompaniment(c, arg));
  text = appendLocale(text, activityPhrase);
  text = appendLocale(text, resultPhrase);
  return text;
};
const RESULT_REALIZER: ActionRealizer = (c) => {
  const profile = localeRealizationProfile(c.locale);
  const head = c.amount ? c.label + profile.quantitySeparator + c.amount : c.label;
  let text = joinLocalizedTokens(c.locale, [head, c.manner]);
  if (c.site) {
    const sourceSiteAlreadyHasLocative = stripBodySiteSourceLead(c.site) !== c.site;
    if (sourceSiteAlreadyHasLocative) {
      // Existing registered site-leading lexemes already express a locative.
      // Do not insert a second ON/AT relation during locale realization.
      text = joinLocalizedTokens(c.locale, [text, c.site]);
    } else {
      const locative = c.frame.relation &&
        relationHasSemanticClass(c.frame.relation, "locative")
        ? c.frame.relation : AdviceRelation.On;
      const connector = localizeAdviceRelation(locative, c.locale) ?? locative;
      text = joinLocalizedTokens(c.locale, [
        text, joinLocalizedTokens(c.locale, [connector, c.site])
      ]);
    }
  }
  if (c.result) {
    // Temporal-result relations and physical formation are different
    // constructions: "continue until finished" must never become
    // "continue to form finished".
    const lead = c.frame.relation === AdviceRelation.Until
      ? localizeAdviceRelation(AdviceRelation.Until, c.locale) ?? AdviceRelation.Until
      : profile.resultFormationPrefix;
    text = joinLocalizedTokens(c.locale, [
      text, joinLocalizedTokens(c.locale, [lead, c.result])
    ]);
  }
  if (c.duration) {
    text = joinLocalizedTokens(c.locale, [
      text,
      joinLocalizedTokens(c.locale, [profile.durationPrefix || undefined, c.duration])
    ]);
  }
  return joinLocalizedTokens(c.locale, [text, realizeTimeArgument(c)]);
};

const AMOUNT_MATERIAL_DESTINATION_REALIZER: ActionRealizer = (c) => {
  const profile = localeRealizationProfile(c.locale);
  let targetArgument: AdviceArgument | undefined;
  let materialArgument: AdviceArgument | undefined, nextMaterialArgument: AdviceArgument | undefined;
  let unmarkedMaterial: AdviceArgument | undefined, unmarkedSubstance: AdviceArgument | undefined;
  let unmarkedDestination: AdviceArgument | undefined;
  for (const arg of c.frame.args) {
    if (arg.role === AdviceArgumentRole.Time) continue;
    if (arg.relation && arg.relation === c.frame.relation) {
      targetArgument ??= arg;
    } else if (!arg.relation && arg.role !== AdviceArgumentRole.Amount &&
        arg.role !== AdviceArgumentRole.Duration &&
        arg.role !== AdviceArgumentRole.Activity && arg.role !== AdviceArgumentRole.Manner) {
      if (!materialArgument) materialArgument = arg;
      else nextMaterialArgument ??= arg;
      if (arg.role === AdviceArgumentRole.Material) unmarkedMaterial ??= arg;
      else if (arg.role === AdviceArgumentRole.Substance) unmarkedSubstance ??= arg;
      else if (arg.role === AdviceArgumentRole.Destination) unmarkedDestination ??= arg;
    }
  }
  // Older dilution frames kept TO on the head and its final volume as an
  // unmarked Object. That complement is the destination, not the material.
  if (!targetArgument && c.frame.relation === AdviceRelation.To &&
      !c.destination && !c.substance && materialArgument?.role === AdviceArgumentRole.Object) {
    targetArgument = materialArgument;
    materialArgument = undefined;
  }
  // A legacy frame-level relation can own only an unmarked daughter. A
  // destination already attached by TO cannot also become the WITH vehicle.
  if (!targetArgument && c.frame.relation) {
    targetArgument = unmarkedDestination ?? unmarkedSubstance;
    if (targetArgument === materialArgument) materialArgument = nextMaterialArgument;
  }
  const relationTarget = targetArgument ? translatedArgument(targetArgument, c.locale) : undefined;
  const relation = relationTarget && c.frame.relation
    ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation
    : undefined;
  const destinations: string[] = [];
  if (relation && relationTarget) destinations.push(
    joinLocalizedTokens(c.locale, [relation, relationTarget]));
  for (const arg of c.frame.args) {
    if (arg === targetArgument || arg.role === AdviceArgumentRole.Time || !arg.relation ||
        relationHasSemanticClass(arg.relation, "temporal") ||
        relationHasGrammarFeature(arg.relation, "conditionalTail")) continue;
    const text = translatedArgument(arg, c.locale);
    if (text) destinations.push(joinLocalizedTokens(c.locale, [
      localizeAdviceRelation(arg.relation, c.locale) ?? arg.relation, text
    ]));
  }
  const destination = joinLocalizedTokens(c.locale, destinations);
  // Explicitly related arguments were rendered as complements above. Only
  // unmarked material can also occupy the dilution material slot.
  const materialSource = targetArgument ? materialArgument : unmarkedMaterial ??
    ((!relation || c.destination) ? unmarkedSubstance : undefined) ?? materialArgument;
  const materialValue = materialSource && translatedArgument(materialSource, c.locale);
  const material = materialValue
    ? joinLocalizedTokens(c.locale, [c.amount ? profile.materialPrefix || undefined : undefined, materialValue])
    : undefined;
  let text = renderLocaleTemplate(profile.amountMaterialDestinationTemplate, {
    label: c.label,
    amount: c.amount,
    material,
    destination: destination ? `${profile.tokenSeparator}${destination}` : undefined
  });
  if (c.duration) {
    const duration = joinLocalizedTokens(c.locale, [profile.durationPrefix || undefined, c.duration]);
    text = `${text}${text ? profile.quantitySeparator : ""}${duration}`;
  }
  // The selected Time has its locale phrase, independently of the destinations.
  if (c.timeWasRendered !== undefined && c.time) c.timeWasRendered = true;
  return c.time ? joinLocalizedTokens(c.locale, [text, c.time]) : text;
};

const ACTION_REALIZERS: Partial<Record<MedicationInstructionActionRealizer, ActionRealizer>> = {
  default: DEFAULT_ACTION_REALIZER,
  result: RESULT_REALIZER,
  "amount-material-destination": AMOUNT_MATERIAL_DESTINATION_REALIZER
};

function sameTimeConstraint(left: AdviceArgument, right: AdviceArgument, inherited: AdviceRelation | undefined): boolean {
  return left.role === AdviceArgumentRole.Time &&
    (left.relation ?? inherited) === (right.relation ?? inherited) &&
    (left.normalized ?? left.conceptId ?? left.text) === (right.normalized ?? right.conceptId ?? right.text) &&
    sameArgumentQuantity(left, right);
}

function realizeAction(
  frame: AdviceFrame, locale: string, roundtripSafe = false,
  coverage?: { singleScheduledEvent: boolean }, clause?: CanonicalSigClause
): string {
  // Never discard inherited prohibition or modality: its governing words may
  // occur outside this frame's exact source span.
  if (frame.sourceText && !frame.modality &&
      frame.polarity !== AdvicePolarity.Negate && frame.polaritySource !== "shared" &&
      hasUntranslatedThaiArgument(frame, locale)) {
    return trimSemanticText(frame.sourceText);
  }
  const firstArguments: Partial<Record<AdviceArgumentRole, AdviceArgument>> = {};
  let temporalAdjuncts: AdviceArgument[] | undefined;
  let retainedMeasuredSource: string | undefined;
  const independentTemporal = !frame.relation || !relationHasSemanticClass(frame.relation, "temporal");
  // A frame relation can govern its Time only when that registered relation
  // admits a temporal complement. Duration/purpose relations keep their owner.
  const inheritedTimeRelation = relationHasGrammarFeature(frame.relation, "timeComplement") ? frame.relation : undefined;
  for (const arg of frame.args) {
    if (instructionArgumentNeedsAuthoredDirections(arg, locale) && arg.text)
      retainedMeasuredSource = retainedMeasuredSource ? retainedMeasuredSource + "; " + arg.text : arg.text;
    const firstTime = firstArguments[AdviceArgumentRole.Time];
    const additionalTime = arg.role === AdviceArgumentRole.Time && firstTime !== undefined;
    if (arg.role === AdviceArgumentRole.Time) {
      let duplicate = firstTime !== undefined && sameTimeConstraint(firstTime, arg, inheritedTimeRelation);
      if (!duplicate) for (const prior of temporalAdjuncts ?? [])
        if (sameTimeConstraint(prior, arg, inheritedTimeRelation)) { duplicate = true; break; }
      if (duplicate) continue;
    }
    const temporalRelation = arg.relation ?? (additionalTime ? inheritedTimeRelation : undefined);
    const additionalPointTime = additionalTime && !temporalRelation;
    if (additionalPointTime || (independentTemporal || additionalTime || (arg.role === AdviceArgumentRole.Result || arg.role === AdviceArgumentRole.Time ||
        arg.role === AdviceArgumentRole.Activity) && arg.relation !== frame.relation) &&
        temporalRelation &&
        (arg.role === AdviceArgumentRole.Activity || arg.role === AdviceArgumentRole.Time ||
          arg.role === AdviceArgumentRole.Result) &&
        (relationHasSemanticClass(temporalRelation, "temporal") ||
          arg.role === AdviceArgumentRole.Time &&
          (additionalTime || arg.relation !== undefined && arg.relation !== frame.relation) &&
          relationHasGrammarFeature(temporalRelation, "timeComplement"))) {
      (temporalAdjuncts ??= []).push(arg.relation || !temporalRelation ? arg : { ...arg, relation: temporalRelation });
    } else firstArguments[arg.role] ??= arg;
  }
  const first = (role: AdviceArgumentRole): string | undefined => {
    const arg = firstArguments[role];
    return arg ? translatedArgument(arg, locale) : undefined;
  };
  const definition = instructionActionDefinitionForRealization(frame);
  const label = actionLabel(frame, locale, definition, roundtripSafe);
  let amount = first(AdviceArgumentRole.Amount);
  const realizerKey = frame.predicate.realizer ?? definition?.realizer ?? "default";
  const defaultArguments = realizerKey === "default" ? defaultActionArguments(frame) : undefined;
  const objectArg = defaultArguments?.objectArg ?? (realizerKey === "relation-duration"
    ? firstArguments[AdviceArgumentRole.Theme] ?? firstArguments[AdviceArgumentRole.Object] : undefined);
  if (objectArg) {
    const objectSource = normalizedInstructionSurface(objectArg.text);
    const amountArg = defaultArguments?.amountArg ?? firstArguments[AdviceArgumentRole.Amount];
    const amountSource = normalizedInstructionSurface(amountArg?.text ?? "");
    if (objectSource && amountSource && objectSource.includes(amountSource)) amount = undefined;
  }
  const theme = objectArg && (objectArg.role === AdviceArgumentRole.Theme || objectArg.role === AdviceArgumentRole.Object)
    ? translatedArgument(objectArg, locale) : first(AdviceArgumentRole.Theme) ?? first(AdviceArgumentRole.Object);
  const container = first(AdviceArgumentRole.Container);
  const destination = first(AdviceArgumentRole.Destination);
  const site = objectArg?.role === AdviceArgumentRole.Site ? translatedArgument(objectArg, locale) : first(AdviceArgumentRole.Site);
  const substance = objectArg?.role === AdviceArgumentRole.Substance ? translatedArgument(objectArg, locale) : first(AdviceArgumentRole.Substance);
  const result = first(AdviceArgumentRole.Result);
  const activity = first(AdviceArgumentRole.Activity);
  const timeArg = firstArguments[AdviceArgumentRole.Time];
  const time = timeArg ? translatedArgument(timeArg, locale) : undefined;
  const duration = first(AdviceArgumentRole.Duration);
  const material = first(AdviceArgumentRole.Material);
  const manner = first(AdviceArgumentRole.Manner);
  let input: InstructionActionRealizationInput = {
    frame, locale, label, amount, theme, container, destination, site,
    substance, result, activity, time, timeRelation: timeArg ? timeArg.relation ?? inheritedTimeRelation : undefined, duration, material, manner,
    realizerConfig: frame.predicate.realizerConfig ?? definition?.realizerConfig,
    definition,
    timeWasRendered: coverage || frame.polarity === AdvicePolarity.Negate ? false : undefined,
    translateArgumentConcept: (arg) => translatedArgumentConcept(arg, locale),
    translateQuantity: (quantity) => translatedQuantity(quantity, locale)
  };
  const adapter = getInstructionActionLocaleAdapter(locale);
  input = adapter.selectLexicalRealization?.(input) ?? input;
  const negated = frame.polarity === AdvicePolarity.Negate;
  const genericRealizer = ACTION_REALIZERS[realizerKey];
  const genericText = genericRealizer && (!negated ||
      realizerKey === "amount-material-destination" ||
      realizerKey === "default" && defaultArguments?.relationTargetArg &&
        relationHasSemanticClass(defaultArguments.relationTargetArg.relation ?? frame.relation, "accompaniment") ||
      (realizerKey === "default" || realizerKey === "result") && firstArguments[AdviceArgumentRole.Amount]?.quantity)
    ? genericRealizer === DEFAULT_ACTION_REALIZER
      ? DEFAULT_ACTION_REALIZER(input, input.frame === frame ? defaultArguments : undefined)
      : genericRealizer(input)
    : undefined;
  const realized = negated ? adapter.renderNegated(input, genericText ??
      (realizerKey === "mix-substance" || realizerKey === "amount-duration" || realizerKey === "site-relation" ||
        realizerKey === "relation-duration" && firstArguments[AdviceArgumentRole.Amount]?.quantity
          ? adapter.render(realizerKey, input) : undefined))
    : genericText ?? adapter.render(realizerKey, input) ?? DEFAULT_ACTION_REALIZER(input);
  // Independent typed event adjuncts compose AFTER their head action's
  // material/site valence. Never infer a temporal relation from display text.
  let complete = realized;
  if (negated && input.time && !input.timeWasRendered)
    complete = joinLocalizedTokens(locale, [complete, realizeTimeArgument(input)]);
  if (coverage && clause) coverage.singleScheduledEvent = Boolean(
    input.timeWasRendered && timeArg && timeArgumentCoversSingleScheduledEvent(frame, timeArg, clause)
  );
  if (temporalAdjuncts) {
    // One compound lookup pass serves every independent adjunct. Ordinary
    // actions without a temporal daughter pay no lookup or set allocation.
    let entailed: Set<string> | undefined;
    for (const arg of frame.args) {
      const implication = arg.conceptId
        ? getMedicationInstructionConcept(arg.conceptId)?.impliedArgument : undefined;
      if (implication) (entailed ??= new Set()).add(
        implication.role + "\0" + implication.conceptId + "\0" + implication.relation);
    }
    for (const adjunct of temporalAdjuncts) {
      if (entailed?.has(adjunct.role + "\0" + adjunct.conceptId + "\0" + adjunct.relation)) continue;
      const value = translatedArgument(adjunct, locale);
      const direct = adjunct.role === AdviceArgumentRole.Time &&
        (!adjunct.relation || relationHasGrammarFeature(adjunct.relation, "directTimeRealization"));
      const temporalPhrase = (direct && adapter.directTime?.(value)) || joinLocalizedTokens(locale, [
        localizeAdviceRelation(adjunct.relation!, locale) ?? adjunct.relation, value
      ]);
      if (!temporalPhrase) continue;
      complete = joinLocalizedTokens(locale, [complete, temporalPhrase]);
      if (coverage && clause && timeArgumentCoversSingleScheduledEvent(frame, adjunct, clause))
        coverage.singleScheduledEvent = true;
    }
  }
  if (!negated) complete = adapter.applyPositiveModality(complete, frame);
  return retainedMeasuredSource
    ? (adapter.withAuthoredDirections ?? getInstructionActionLocaleAdapter("en").withAuthoredDirections!)(complete, retainedMeasuredSource)
    : complete;
}

/** Realize one selected action with its existing external graph scope, when supplied. */
export function realizeInstructionAction(
  frame: AdviceFrame, locale = "en", graph?: CanonicalInstructionGraph
): string {
  const text = realizeAction(frame, locale);
  if (!graph?.relations?.length) return text;
  const actionIndex = graph.actions.findIndex(action => action.span.start === frame.span.start &&
    action.span.end === frame.span.end && action.predicate.lemma === frame.predicate.lemma);
  const conditions: InstructionGraphPrimaryCondition[] = [];
  for (const relation of graph.relations) {
    if (relation.fromActionIndex !== undefined || relation.toActionIndex !== actionIndex) continue;
    const condition = instructionGraphCondition(relation, frame, graph.sourceLocale ?? "en", locale);
    if (condition) conditions.push(condition);
  }
  return attachInstructionGraphPrimaryConditions(text, conditions, locale);
}

/** A rich source action can carry its own Manner/Time but no Amount because a
 * preceding preparatory verb supplied the original quantity. When the
 * clinician edits the canonical dose, never let that amountless rich action
 * replace the numeric administration text without the CURRENT dose.
 * This is a display-only frame copy, not an edit of source graph/provenance. */
export function realizeRichPrimaryWithCanonicalDose(
  frame: AdviceFrame, clause: CanonicalSigClause, locale: string,
  options?: Pick<ParseOptions, "instructionActionMap" | "realizationMode">,
  coverage?: { singleScheduledEvent: boolean }
): string {
  const sourceFrame = frame;
  const owner = clause.instructionGraph ? primaryDoseAmountOwner(clause.instructionGraph, clause, options) : undefined;
  const sourceAmount = owner?.action === sourceFrame ? owner.argument : undefined;
  frame = frameWithCanonicalPrimaryContext(frame, clause);
  const conflictingAmount = primaryAmountConflicts(sourceAmount, clause.dose,
    !clause.dose && clause.sourceProjectionVerified === false);
  // Generated realization composes an owned Amount from its typed facts,
  // independently of an opaque nominal remainder or the requested parse locale.
  // Verified roundtrip source replay remains separate from this display copy.
  const realizer = frame.predicate.realizer ?? frameActionDefinition(frame, options)?.realizer ?? "default";
  const normalizeAmount = Boolean(sourceAmount && clause.dose &&
    (options?.realizationMode !== "roundtrip" || !frame.sourceText) &&
    frame.args.some(arg => arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme) &&
    (realizer === "default" || realizer === "relation-duration"));
  if (sourceAmount && (conflictingAmount || normalizeAmount))
    frame = frameWithReconciledAmount(frame, sourceAmount, clause.dose, true);
  if (clause.method && !actionMatchesCanonicalMethod(frame, clause, options)) {
    const method = clause.method;
    const definition = resolveMedicationInstructionActionForMethod(method, options);
    const sourceDefinition = frameActionDefinition(frame, options);
    const sourceRealizer = frame.predicate.realizer ?? sourceDefinition?.realizer ?? "default";
    // The edited head keeps the source frame's typed argument realization,
    // including both the live amount and any independent physical result.
    const realizer = sourceRealizer;
    const methodBoundManners = sourceDefinition?.methodBoundMannerConcepts;
    // Independent material, manner and event daughters stay with the edited
    // action. Only the source method's declared bound qualifiers are superseded.
    frame = { ...frame, sourceText: "",
      args: methodBoundManners?.length ? frame.args.filter(arg =>
        arg.role !== AdviceArgumentRole.Manner || !arg.conceptId ||
        methodBoundManners.indexOf(arg.conceptId) < 0) : frame.args,
      predicate: definition ? {
      lemma: definition.code, display: definition.display, i18n: definition.i18n,
      semanticClass: definition.semanticClass, realizer,
      realizerConfig: frame.predicate.realizerConfig, codings: medicationInstructionActionCodings(definition)
    } : { lemma: method.text ?? method.coding?.display ?? method.coding?.code ?? "",
      display: method.text ?? method.coding?.display, realizer,
      realizerConfig: frame.predicate.realizerConfig,
      codings: method.coding ? [method.coding] : undefined } };
  }
  const dose = clause.dose;
  if (!dose || frame.args.some(arg =>
    arg.role === AdviceArgumentRole.Amount && arg.quantity) ||
    (dose.value === undefined && !dose.range)) return realizeAction(frame, locale, false, coverage, clause);
  // A preceding preparation already supplies the unchanged amount. Add the
  // live dose only when no independently rendered owner still supplies it.
  if (owner && owner.action !== sourceFrame)
    return realizeAction(frame, locale, false, coverage, clause);
  const { value, range, unit, comparator } = dose;
  return realizeAction({
    ...frame, sourceText: "",
    args: [{
      role: AdviceArgumentRole.Amount,
      text: "", quantity: { value, range, unit, comparator }
    }, ...frame.args.filter(arg => arg.role !== AdviceArgumentRole.Amount)]
  }, locale, false, coverage, clause);
}

function normalizedInstructionSurface(value: string): string {
  return value.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
}

export function instructionGraphRepresentsText(
  graph: CanonicalInstructionGraph,
  text: string
): boolean {
  const normalized = normalizedInstructionSurface(text);
  if (!normalized) return false;
  const compact = (value: string): string => value.replace(/\s+/gu, "");
  const pieces: Array<{ start: number; end: number; text: string }> = [];
  for (const action of graph.actions) {
    if (action.sourceText?.trim()) {
      pieces.push({ start: action.span.start, end: action.span.end, text: action.sourceText });
    }
  }
  for (const relation of graph.relations ?? []) {
    if (relation.text?.trim() && relation.span) {
      pieces.push({ start: relation.span.start, end: relation.span.end, text: relation.text });
    }
  }
  for (const opaque of graph.opaqueSpans ?? []) {
    if (opaque.text?.trim()) {
      pieces.push({ start: opaque.start, end: opaque.end, text: opaque.text });
    }
  }
  pieces.sort((left, right) => left.start - right.start || left.end - right.end);
  const represented = normalizedInstructionSurface(pieces.map((piece) => piece.text).join(" "));
  if (represented && compact(represented).includes(compact(normalized))) {
    return true;
  }
  return graph.actions.some((action) => {
    const candidate = normalizedInstructionSurface(action.sourceText);
    return Boolean(candidate && (candidate === normalized || candidate.includes(normalized)));
  });
}

export function instructionGraphTextParticipatesInRelation(
  graph: CanonicalInstructionGraph,
  text: string
): boolean {
  const normalized = normalizedInstructionSurface(text);
  if (!normalized) return false;
  const compact = (value: string): string => value.replace(/\s+/gu, "");
  const matchingIndices: number[] = [];
  for (let index = 0; index < graph.actions.length; index += 1) {
    const source = normalizedInstructionSurface(graph.actions[index]?.sourceText ?? "");
    if (!source) continue;
    if (source === normalized || compact(source).includes(compact(normalized)) || compact(normalized).includes(compact(source))) {
      matchingIndices.push(index);
    }
  }
  return matchingIndices.some((index) =>
    graph.relations?.some((relation) =>
      relation.fromActionIndex === index || relation.toActionIndex === index
    ) ?? false
  );
}

export function instructionGraphSingleActionRepresentsText(
  graph: CanonicalInstructionGraph,
  text: string
): boolean {
  const normalized = normalizedInstructionSurface(text);
  if (!normalized) return false;
  const compact = (value: string): string => value.replace(/\s+/gu, "");
  return graph.actions.some((action) => {
    const candidate = normalizedInstructionSurface(action.sourceText);
    return Boolean(candidate && compact(candidate) === compact(normalized));
  });
}


/**
 * Non-coded advice is redundant only when the grammar already owns every
 * negative predicate in the same source interval. Free text alone cannot
 * justify deleting a distinct clinical prohibition.
 */
export function instructionGraphCoversTypedWarnings(
  graph: CanonicalInstructionGraph,
  frames: readonly AdviceFrame[] | undefined
): boolean {
  if (!frames?.length) return false;
  return frames.every((expected) => {
    if (expected.polarity !== AdvicePolarity.Negate) return false;
    const expectedCode = getMedicationInstructionAction(expected.predicate.lemma)?.code ??
      expected.predicate.lemma;
    return graph.actions.some((actual) => {
      if (actual.polarity !== AdvicePolarity.Negate) return false;
      const actualCode = getMedicationInstructionAction(actual.predicate.lemma)?.code ??
        actual.predicate.lemma;
      if (actualCode !== expectedCode ||
          actual.span.end <= expected.span.start ||
          expected.span.end <= actual.span.start) return false;
      return expected.args.filter((arg) => arg.quantity || arg.conceptId).every((arg) =>
        actual.args.some((candidate) =>
          candidate.role === arg.role &&
          (arg.conceptId === undefined || arg.conceptId === candidate.conceptId) &&
          (!arg.quantity || Boolean(candidate.quantity &&
            arg.quantity.value === candidate.quantity.value &&
            arg.quantity.unit === candidate.quantity.unit &&
            arg.quantity.comparator === candidate.quantity.comparator &&
            arg.quantity.range?.low === candidate.quantity.range?.low &&
            arg.quantity.range?.high === candidate.quantity.range?.high))
        )
      );
    });
  });
}

/** A coded qualifier already entailed by the displayed action graph needs no
 * second patient-visible sentence, but keeps its exact FHIR coding. */
export function instructionGraphEntailsAdviceCoding(
  graph: CanonicalInstructionGraph,
  coding: FhirCoding | undefined
): boolean {
  if (!coding?.code) return false;
  return matchComposedAdviceCodings(graph.actions).some((definition) => {
    const candidate = definition.coding;
    return candidate?.code === coding.code &&
      (candidate?.system ?? SNOMED_SYSTEM) === (coding.system ?? SNOMED_SYSTEM);
  });
}

/**
 * Give a complete source-preserved free-text instruction ownership of the
 * graph actions whose exact source ranges it contains. This prevents duplicate
 * rendering without reinterpreting the instruction or dropping its remaining
 * unparsed clinical content.
 */
export function instructionGraphSourceOwnedByAdvice(
  graph: CanonicalInstructionGraph,
  instruction: CanonicalAdditionalInstructionExpr
): string[] {
  if (!instruction.text?.trim() || instruction.coding?.code || instruction.frames?.length) {
    return [];
  }
  const source = graph.sourceText.toLocaleLowerCase("en");
  const phrase = instruction.text.trim().toLocaleLowerCase("en");
  const start = source.indexOf(phrase);
  if (start < 0 || source.indexOf(phrase, start + 1) !== -1) return [];
  const end = start + phrase.length;
  return graph.actions
    .filter((action) =>
      action.span.start >= start && action.span.end <= end &&
      Boolean(action.sourceText.trim())
    )
    .map((action) => action.sourceText);
}

/**
 * A source-backed additional fragment is fully represented when every
 * lexical constituent belongs to a composed action or its licensed
 * coordination connector. A partial match cannot delete unresolved advice.
 */
export function instructionGraphFullyOwnsAdvice(
  graph: CanonicalInstructionGraph,
  instruction: CanonicalAdditionalInstructionExpr
): boolean {
  if (!instruction.text?.trim() || instruction.coding?.code || instruction.frames?.length) return false;
  const source = graph.sourceText.toLocaleLowerCase("en");
  const phrase = instruction.text.trim().toLocaleLowerCase("en");
  const start = source.indexOf(phrase);
  if (start < 0 || source.indexOf(phrase, start + 1) !== -1) return false;
  const end = start + phrase.length;
  const actions = graph.actions.filter((action) =>
    action.span.start < end && start < action.span.end
  );
  if (!actions.length) return false;
  return lexInput(graph.sourceText.slice(start, end)).every((token) => {
    const localStart = start + token.sourceStart;
    const localEnd = start + token.sourceEnd;
    if (actions.some((action) =>
      action.span.start <= localStart && localEnd <= action.span.end
    )) return true;
    const normalized = key(token);
    return normalized === "," ||
      ACTION_COORDINATION_CONNECTORS.has(normalized) ||
      ACTION_DISCOURSE_CONNECTORS.has(normalized);
  });
}

/** Exact source-backed discourse connector that introduces the first action
 * after the canonical administration. This lets realization preserve contrast
 * without pretending that it is the temporal THEN relation. */
export function instructionGraphPostAdministrationDiscourseConnector(
  graph: CanonicalInstructionGraph
): CanonicalSourceSpan | undefined {
  const primary = graph.primaryAdministrationSpan;
  if (!primary) return undefined;
  const firstPostAction = graph.actions
    .filter((action) => action.span.start >= primary.end)
    .slice()
    .sort((left, right) => left.span.start - right.span.start)[0];
  if (!firstPostAction) return undefined;
  return graph.opaqueSpans?.find((span) =>
    span.start >= primary.end && span.end <= firstPostAction.span.start &&
    ACTION_DISCOURSE_CONNECTORS.has(normalizedInstructionSurface(span.text)) &&
    !graph.sourceText.slice(span.end, firstPostAction.span.start).trim()
  );
}

/** Use complete realized negative actions to recognize otherwise untyped FHIR text. */
export function instructionGraphRealizesWarningText(
  graph: CanonicalInstructionGraph,
  text: string
): boolean {
  const normalized = normalizedInstructionSurface(text);
  if (!normalized) return false;
  return graph.actions.some((frame) =>
    frame.polarity === AdvicePolarity.Negate &&
    ["en", "th"].some((locale) =>
      normalizedInstructionSurface(realizeInstructionAction(frame, locale)) === normalized
    )
  );
}

function codingEquivalent(
  left: { system?: string; code?: string } | undefined,
  right: { system?: string; code?: string } | undefined
): boolean {
  if (!left?.code || !right?.code) return false;
  return left.code === right.code &&
    (left.system ?? SNOMED_SYSTEM) === (right.system ?? SNOMED_SYSTEM);
}

function quantityCoveredByDose(arg: AdviceArgument, dose: CanonicalDoseExpr | undefined): boolean {
  if (!arg.quantity || !dose) return false;
  return arg.quantity.value === dose.value &&
    arg.quantity.range?.low === dose.range?.low &&
    arg.quantity.range?.high === dose.range?.high &&
    arg.quantity.unit === dose.unit &&
    arg.quantity.comparator === dose.comparator;
}

function siteArgumentCoveredByClause(arg: AdviceArgument, clause: CanonicalSigClause): boolean {
  if (arg.role !== AdviceArgumentRole.Site || !clause.site) return false;
  if (codingEquivalent(arg.coding, clause.site.coding)) return true;
  const left = normalizeActionSurface(arg.normalized ?? arg.text);
  const right = normalizeActionSurface(clause.site.text ?? "");
  return Boolean(left && right && left === right);
}

function actionMatchesCanonicalMethod(
  frame: AdviceFrame, clause: Pick<CanonicalSigClause, "method">,
  options?: Pick<ParseOptions, "instructionActionMap">
): boolean {
  const method = clause.method;
  if (!method) return false;
  const definition = frameActionDefinition(frame, options);
  // Distinct authored actions may share an administration code (Apply/Reapply).
  // Compare declared identities; an unknown custom source cannot be treated as
  // a different default action merely because its local lemma is unfamiliar.
  if (definition && method.text?.trim()) {
    const current = resolveMedicationInstructionActionForMethod(method, options, true);
    if (current) return current.code === definition.code && current.display === definition.display;
  }
  if (method.coding?.code) {
    if (frame.predicate.codings?.some((coding) => codingEquivalent(coding, method.coding))) return true;
    const declared = definition?.administrationMethod;
    if (declared && codingEquivalent(declared, method.coding)) return true;
    if (resolveMedicationInstructionActionByMethod(method.coding, options)) return false;
  }
  const methodText = normalizeActionSurface(method.text ?? "");
  if (!methodText) return false;
  const candidates = [
    frame.predicate.lemma,
    frame.predicate.display ?? "",
    definition?.display ?? "",
    ...(definition?.aliases ?? [])
  ].map(normalizeActionSurface).filter(Boolean);
  return candidates.some((candidate) =>
    methodText === candidate || methodText.includes(candidate) || candidate.includes(methodText)
  );
}

const CANONICAL_ADMIN_FILLER_WORDS = new Set([
  "a", "an", "the", "medication", "medicine", "drug",
  "via", "route", "oral", "orally", "ophthalmic", "otic", "nasal",
  "intravitreal", "inhalation", "topical", "topically", "transdermal",
  "transdermally", "subcutaneous", "subcutaneously", "intramuscular",
  "intramuscularly", "intravenous", "intravenously", "rectal", "rectally",
  "vaginal", "vaginally", "once", "twice", "daily", "day", "per", "times",
  "every", "hour", "hours", "week", "weeks", "month", "months",
  "tab", "tablet", "tablets", "cap", "capsule", "capsules", "drop", "drops",
  "puff", "puffs", "spray", "sprays", "patch", "patches", "ml", "mg", "mcg", "g", "u"
]);

function freeArgumentCoveredByCanonicalAdministration(
  arg: AdviceArgument,
  clause: CanonicalSigClause
): boolean {
  if (arg.role !== AdviceArgumentRole.Object && arg.role !== AdviceArgumentRole.Theme) return false;
  const words = normalizeActionSurface(arg.text).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((word) =>
    CANONICAL_ADMIN_FILLER_WORDS.has(word) ||
    /^[0-9]+(?:\.[0-9]+)?(?:-[0-9]+(?:\.[0-9]+)?)?$/.test(word)
  );
}

function argumentCoveredByCanonicalText(
  arg: AdviceArgument,
  clause: CanonicalSigClause
): boolean {
  if (arg.role !== AdviceArgumentRole.Object && arg.role !== AdviceArgumentRole.Theme && arg.role !== AdviceArgumentRole.Free) {
    return false;
  }
  const argument = normalizeActionSurface(arg.normalized ?? arg.text);
  if (!argument) return true;
  const representedTexts = [
    clause.method?.text ?? "",
    ...(clause.additionalInstructions ?? []).map((instruction) => instruction.text ?? "")
  ].map(normalizeActionSurface).filter(Boolean);
  return representedTexts.some((text) =>
    text === argument || text.includes(` ${argument}`) || text.startsWith(`${argument} `) || text.endsWith(` ${argument}`)
  );
}

function argumentEventTiming(arg: AdviceArgument): EventTiming | undefined {
  if (arg.role !== AdviceArgumentRole.Time || !arg.normalized) return undefined;
  return KNOWN_EVENT_TIMINGS.has(arg.normalized) ? arg.normalized as EventTiming :
    EVENT_TIMING_TOKENS[normalizeActionSurface(arg.normalized)];
}

function timeArgumentCoveredBySchedule(
  frame: AdviceFrame,
  arg: AdviceArgument,
  clause: CanonicalSigClause,
  // Lexical event identity can reconcile a changed live event, but does not
  // prove the canonical phrase preserves a rich action's relation or locale
  // realization. General action coverage retains canonical-code evidence.
  timing = arg.role === AdviceArgumentRole.Time && arg.normalized &&
    KNOWN_EVENT_TIMINGS.has(arg.normalized) ? arg.normalized as EventTiming : undefined
): boolean {
  if (!timing || !clause.schedule?.when?.length) return false;
  const relation = arg.relation ?? frame.relation;
  const relationMapping = relation
    ? MEAL_TIMING_BY_RELATION.get(relation as "before" | "after" | "with")
    : undefined;
  // HS already encodes before sleep, so retain that authored qualifier.
  // Declared direct-time heads (IN/ON) preserve the event point. Other
  // unmapped relations, such as UNTIL or AFTER sleep, do not claim it.
  const related = relation === "before" && timing === EventTiming["Before Sleep"]
    ? timing : relationMapping ? relationMapping.get(timing)
    : !relation || relationHasGrammarFeature(relation, "directTimeRealization") ? timing : undefined;
  return related !== undefined && clause.schedule.when.indexOf(related) >= 0;
}

const KNOWN_EVENT_TIMINGS = new Set<string>(objectValues(EventTiming));

/** Counted or qualified sites use the canonical site's complete dose scope. */
export function canonicalSiteOwnsPrimaryPhrase(clause: CanonicalSigClause): boolean {
  const site = clause.site;
  return Boolean(site?.spatialRelation || site?.restrictions?.length ||
    site?.administrationTargetCount !== undefined && site.administrationTargetCount > 1);
}

/** Apply the selected primary's live schedule/site in one display-only pass.
 * A source graph clock is independent unless the wire source established
 * structured clock ownership. Source arguments and other actions stay intact. */
function frameWithCanonicalPrimaryContext(frame: AdviceFrame, clause: CanonicalSigClause): AdviceFrame {
  const schedule = clause.schedule;
  const hasOffset = schedule?.offset !== undefined || schedule?.offsetMin !== undefined ||
    schedule?.offsetMax !== undefined;
  const hasClocks = Boolean(schedule?.timeOfDay?.length);
  const ownsClocks = clause.sourceHasStructuredClocks === true;
  // A saved false means the graph event was independent. Native clauses
  // without source evidence keep their existing schedule-owned interpretation.
  const ownsEvents = clause.sourceHasStructuredEvents === true ||
    clause.sourceHasStructuredEvents !== false && (hasOffset || Boolean(schedule?.when?.length));
  const site = clause.site;
  const ownsSite = Boolean(site) || clause.sourceHasStructuredSite === true;
  // Both callers have already selected the source primary. A simultaneous
  // method edit cannot revoke its current schedule/site ownership.
  if (clause.sourceProjectionVerified !== false && !ownsEvents && !ownsClocks && !hasClocks && !ownsSite) return frame;
  const args: AdviceArgument[] = [];
  let changed = false, removedFrameTime = false, retainedFrameTime = false;
  for (const arg of frame.args) {
    if (arg.role === AdviceArgumentRole.Time && arg.normalized) {
      const clock = /^[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?$/.test(arg.normalized);
      const event = ownsEvents ? argumentEventTiming(arg) : undefined;
      // A newly added structured clock does not take ownership of an
      // independent graph time. Identical clocks need only one display.
      const clockRelation = arg.relation ?? frame.relation;
      const directClock = clock && (!clockRelation || relationHasGrammarFeature(clockRelation, "directTimeRealization"));
      const mirrorsClock = directClock && hasClocks && schedule!.timeOfDay!.some(time =>
        (time.length === 5 ? time + ":00" : time.replace(/\.0+$/u, "")) ===
        (arg.normalized!.length === 5 ? arg.normalized + ":00" : arg.normalized!.replace(/\.0+$/u, "")));
      // A positively owned multi-event schedule renders its complete current
      // list once. Other Time kinds and independently scoped actions remain.
      if (directClock && (ownsClocks || mirrorsClock) || event &&
          (hasOffset || (schedule?.when?.length ?? 0) > 1 || !timeArgumentCoveredBySchedule(frame, arg, clause, event))) {
        changed = true;
        if (instructionFrameRelationOwnsTemporalArgument(frame, arg)) removedFrameTime = true;
        continue;
      }
      if (instructionFrameRelationOwnsTemporalArgument(frame, arg)) retainedFrameTime = true;
    }
    // The graph's plain Site argument cannot express live spatial relations
    // or restrictions. The canonical site phrase owns this primary display;
    // other actions and the saved graph keep their authored sites.
    if (arg.role === AdviceArgumentRole.Site &&
        (canonicalSiteOwnsPrimaryPhrase(clause) || !site && clause.sourceHasStructuredSite === true)) {
      changed = true;
      continue;
    }
    if (arg.role === AdviceArgumentRole.Site && site) {
      const text = site.text ?? site.coding?.display ?? site.coding?.code ?? "";
      const currentTranslations = site.i18n ?? site.coding?.i18n;
      if (arg.text !== site.text || arg.coding?.code !== site.coding?.code ||
          arg.coding?.system !== site.coding?.system) {
        changed = true;
        args.push({ ...arg, text, normalized: text, conceptId: undefined,
          coding: site.coding, codings: site.coding ? [site.coding] : undefined,
          i18n: currentTranslations ?? codingFromSite(text)?.i18n });
        continue;
      }
      // A translation edit does not change the argument's lexical identity.
      // Supplied locales own their current wording; independent graph locales
      // retain their lexical realization (for example English "the hair").
      let i18n = arg.i18n;
      if (currentTranslations) {
        for (const locale of Object.keys(currentTranslations)) if (i18n?.[locale] !== currentTranslations[locale]) {
          i18n = { ...i18n, ...currentTranslations };
          break;
        }
      } else if (i18n) {
        const defaults = codingFromSite(text)?.i18n;
        for (const locale of Object.keys(i18n)) if (i18n[locale] !== defaults?.[locale]) {
          if (i18n === arg.i18n) i18n = { ...i18n };
          if (defaults?.[locale] !== undefined) i18n[locale] = defaults[locale];
          else delete i18n[locale];
        }
      }
      if (i18n !== arg.i18n) {
        changed = true;
        args.push({ ...arg, i18n });
        continue;
      }
    }
    args.push(arg);
  }
  // A failed proof forbids old raw wording, even when a graph-only clock
  // survives as an independent typed argument.
  if (!changed && clause.sourceProjectionVerified !== false && !ownsEvents && !ownsClocks) return frame;
  // A consumed Time must not donate its owned frame relation to an unmarked
  // Site in this display copy. Explicit Site attachments remain on the child.
  const relation = removedFrameTime && !retainedFrameTime &&
    relationHasSemanticClass(frame.relation, "locative") ? undefined : frame.relation;
  return { ...frame, relation, sourceText: "", args: changed ? args : frame.args };
}

/**
 * A rich administration frame and its canonical HPSG schedule can refer to
 * the same meal event using different typed relations: CM + before = ACM.
 * Both localizers share this compositional check instead of reparsing the
 * displayed text independently.
 */
function timeArgumentCoversSingleScheduledEvent(
  frame: AdviceFrame,
  arg: AdviceArgument,
  clause: CanonicalSigClause
): boolean {
  if (arg.role !== AdviceArgumentRole.Time || clause.schedule?.when?.length !== 1 ||
      clause.schedule.offset !== undefined || clause.schedule.offsetMin !== undefined ||
      clause.schedule.offsetMax !== undefined) return false;
  if (timeArgumentCoveredBySchedule(frame, arg, clause)) return true;
  if (arg.normalized && KNOWN_EVENT_TIMINGS.has(arg.normalized)) return false;
  const words = normalizeActionSurface(arg.normalized ?? arg.text)
    .split(/\s+/u).filter((word) => word.length > 0 && !EVENT_ARTICLE_TOKENS.has(word));
  const expression = resolveEventTimingExpression(words, 0);
  return Boolean(expression && expression.length === words.length &&
    timeArgumentCoveredBySchedule(frame, arg, clause, expression.timing));
}

function primaryActionCoveredByCanonicalClause(
  frame: AdviceFrame,
  actions: readonly AdviceFrame[],
  clause: CanonicalSigClause,
  selectedOwner?: AdviceFrame | null,
  sourceFrame: AdviceFrame = frame
): boolean {
  if (selectedOwner === null || !actionMatchesCanonicalMethod(frame, clause)) return false;
  if (selectedOwner) {
    // An explicit primary source span owns the canonical dose, even when a
    // different earlier administration happens to use the same verb.
    if (sourceFrame !== selectedOwner) return false;
  } else {
    // Without a selected source owner, retain the historical first-matching
    // method behavior. A single scan avoids sorting/cloning the actions.
    let first: AdviceFrame | undefined;
    for (const candidate of actions) {
      if (candidate.polarity === AdvicePolarity.Negate ||
          !actionMatchesCanonicalMethod(candidate, clause)) continue;
      if (!first || candidate.span.start < first.span.start ||
          (candidate.span.start === first.span.start && candidate.span.end < first.span.end)) {
        first = candidate;
      }
    }
    if (first !== sourceFrame) return false;
  }
  // Site and schedule equality do not represent this valence's direct
  // object beside its temporal complement. Keep their composition together.
  const realizer = frame.predicate.realizer ?? instructionActionDefinitionForRealization(frame)?.realizer;
  if (realizer === "site-relation" && frame.args.some(arg => arg.role === AdviceArgumentRole.Site) &&
      frame.args.some(arg => instructionFrameRelationOwnsTemporalArgument(frame, arg))) return false;
  return frame.args.every((arg) =>
    (arg.role === AdviceArgumentRole.Site && siteArgumentCoveredByClause(arg, clause)) ||
    (arg.role === AdviceArgumentRole.Amount && quantityCoveredByDose(arg, clause.dose)) ||
    timeArgumentCoveredBySchedule(frame, arg, clause) ||
    argumentCoveredByCanonicalText(arg, clause) ||
    freeArgumentCoveredByCanonicalAdministration(arg, clause)
  );
}

/** The normalized and source-preserving primary selectors must honor the
 * same current dose, while leaving superseded graph/source data untouched. */
function primaryAmountConflicts(
  amount: AdviceArgument | undefined, dose: CanonicalDoseExpr | undefined, removed = false
): boolean {
  return Boolean(amount?.quantity && (dose || removed) && (!dose || !quantityCoveredByDose(amount, dose)));
}

/** Locate an existing Amount label within its source nominal. */
function sourceAmountLabelOffset(text: string, label: string): number {
  const at = label ? text.toLowerCase().indexOf(label.toLowerCase()) : -1;
  return at >= 0 &&
    (at === 0 || !/[a-z0-9]/i.test(text[at - 1])) &&
    (at + label.length === text.length || !/[a-z0-9]/i.test(text[at + label.length])) ? at : -1;
}

/** Realize the current Amount without rewriting its saved graph.
 * Its source label may also be embedded in a larger Object ('1 tablet of
 * amoxicillin'); remove only the owned amount, keeping the drug name and the
 * action's independent material/target. Numeric edits and forced localized
 * display use the same typed ownership. */
function frameWithReconciledAmount(
  frame: AdviceFrame, sourceAmount: AdviceArgument,
  currentDose: CanonicalDoseExpr | undefined, replaceAtOwner = false
): AdviceFrame {
  const replacement = replaceAtOwner && currentDose &&
    (currentDose.value !== undefined || currentDose.range) ? {
      value: currentDose.value, range: currentDose.range,
      unit: currentDose.unit, comparator: currentDose.comparator
    } : undefined;
  const args: AdviceArgument[] = [];
  for (const arg of frame.args) {
    // Only the dose-bearing Amount belongs to the canonical dose. An
    // independent 100 mL mixing Substance or 5-minute Duration must never
    // disappear because the tablet amount changed.
    if (arg === sourceAmount) {
      if (replacement) args.push({ ...arg, quantity: replacement, i18n: undefined });
      continue;
    }
    if (arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme) {
      const text = arg.text ?? "";
      const labelOffset = sourceAmountLabelOffset(text, sourceAmount.text ?? "");
      // Disjoint source spans identify independent quantities even when
      // their values and units happen to match.
      const ownsSource = arg.span && sourceAmount.span
        ? arg.span.start <= sourceAmount.span.start && arg.span.end >= sourceAmount.span.end
        : !arg.relation && labelOffset >= 0;
      if (ownsSource) {
        const remaining = labelOffset >= 0
          ? (text.slice(0, labelOffset) + " " +
              text.slice(labelOffset + sourceAmount.text.length)).replace(/^\s*of\s+/i, "").trim()
          : text;
        const quantity = sourceAmount.quantity;
        const sharesSourceQuantity = quantity && arg.quantity &&
          quantity.value === arg.quantity.value && quantity.unit === arg.quantity.unit &&
          quantity.comparator === arg.quantity.comparator &&
          quantity.range?.low === arg.quantity.range?.low &&
          quantity.range?.high === arg.quantity.range?.high;
        if (!remaining && (!arg.quantity || sharesSourceQuantity)) continue;
        // Amount owns the current dose. This Object keeps its remaining drug
        // description and any independent quantity, never a second dose copy.
        args.push({ ...arg,
          ...(sharesSourceQuantity ? { quantity: undefined } : {}),
          text: remaining, normalized: remaining || undefined, i18n: undefined });
        continue;
      }
    }
    args.push(arg);
  }
  return { ...frame, sourceText: "", args };
}

type PrimaryInstructionOwnership = NonNullable<CanonicalInstructionGraph["primaryOwnership"]>;

/** Resolve the selected source head and Amount once while HPSG/action facts
 * and the original vocabulary are available. Older saved graphs reuse this
 * conservative inference; an explicit binding never depends on edited values. */
function inferPrimaryOwnership(
  graph: CanonicalInstructionGraph,
  clause: Pick<CanonicalSigClause, "dose" | "method" | "sourceProjectionVerified">,
  options?: Pick<ParseOptions, "instructionActionMap">
): PrimaryInstructionOwnership {
  const primary = graph.primaryAdministrationSpan;
  const canOwnDose = Boolean(clause.dose || clause.sourceProjectionVerified === false && primary);
  let administrationActionIndex: number | undefined, overlap: number | undefined,
    overlapArgument = -1, earliest: number | undefined, earliestArgument = -1,
    earlier: number | undefined, earlierArgument = -1, earlierCount = 0;
  for (let index = 0; index < graph.actions.length; index++) {
    const action = graph.actions[index];
    if (action.polarity === AdvicePolarity.Negate) continue;
    const overlaps = Boolean(primary && action.span.start < primary.end && primary.start < action.span.end);
    if (overlaps && administrationActionIndex === undefined) administrationActionIndex = index;
    if (!canOwnDose) continue;
    let amountIndex = -1, theme: AdviceArgument | undefined;
    for (let argumentIndex = 0; argumentIndex < action.args.length; argumentIndex++) {
      const argument = action.args[argumentIndex];
      if (amountIndex < 0 && argument.role === AdviceArgumentRole.Amount && argument.quantity) amountIndex = argumentIndex;
      if (!theme && (argument.role === AdviceArgumentRole.Theme || argument.role === AdviceArgumentRole.Object)) theme = argument;
    }
    if (amountIndex < 0) continue;
    if (overlaps && overlap === undefined) { overlap = index; overlapArgument = amountIndex; }
    if (primary && action.span.end > primary.start) continue;
    const amount = action.args[amountIndex];
    const ownsAmount = !theme || (theme.span && amount.span
      ? theme.span.start <= amount.span.start && amount.span.end <= theme.span.end
      : quantityCoveredByDose(theme, amount.quantity) || !theme.relation &&
        sourceAmountLabelOffset(theme.text ?? "", amount.text ?? "") >= 0);
    if (!ownsAmount) continue;
    const definition = frameActionDefinition(action, options);
    if ((!definition || definition.definesDose || definition.primaryAdministrationHead || definition.administrationMethod) &&
        (earliest === undefined || action.span.start < graph.actions[earliest].span.start)) {
      earliest = index; earliestArgument = amountIndex;
    }
    if (definition?.definesDose) { earlierCount++; earlier = index; earlierArgument = amountIndex; }
  }
  const doseAction = overlap ?? (earlierCount === 1 ? earlier : primary ? undefined : earliest);
  const doseArgument = overlap !== undefined ? overlapArgument : earlierCount === 1 ? earlierArgument : earliestArgument;
  // A saved graph with no selected head can supply a missing administration
  // only from the same matching dose owner, never a later coincidental amount.
  if (!primary && !clause.method && doseAction !== undefined &&
      quantityCoveredByDose(graph.actions[doseAction].args[doseArgument], clause.dose))
    administrationActionIndex = doseAction;
  return {
    ...(administrationActionIndex !== undefined ? { administrationActionIndex } : {}),
    ...(doseAction !== undefined ? { dose: { actionIndex: doseAction, argumentIndex: doseArgument } } : {})
  };
}

function primaryInstructionOwnership(
  graph: CanonicalInstructionGraph,
  clause: Pick<CanonicalSigClause, "dose" | "method" | "sourceProjectionVerified">,
  options?: Pick<ParseOptions, "instructionActionMap">
): PrimaryInstructionOwnership {
  return graph.primaryOwnership ?? inferPrimaryOwnership(graph, clause, options);
}

function primaryDoseAmountOwner(
  graph: CanonicalInstructionGraph,
  clause: Pick<CanonicalSigClause, "dose" | "method" | "sourceProjectionVerified">,
  options?: Pick<ParseOptions, "instructionActionMap">
): { action: AdviceFrame; argument: AdviceArgument } | undefined {
  if (!clause.dose && clause.sourceProjectionVerified !== false) return undefined;
  const owner = primaryInstructionOwnership(graph, clause, options).dose;
  if (!owner) return undefined;
  const action = graph.actions[owner.actionIndex];
  return { action, argument: action.args[owner.argumentIndex] };
}

/** A sole typed preparation owns the amount before a later administration.
 * Ordinary primary-only graphs return before the ownership walk. */
export function instructionGraphPreparationOwnsDose(
  clause: CanonicalSigClause, options?: Pick<ParseOptions, "instructionActionMap">
): boolean {
  const graph = clause.instructionGraph;
  const primary = graph?.primaryAdministrationSpan;
  if (!clause.dose || !graph || !primary || !graph.actions.length ||
      graph.actions[0].span.start >= primary.start) return false;
  const owner = primaryDoseAmountOwner(graph, clause, options);
  return Boolean(owner && owner.action.span.end <= primary.start);
}

/** Whole-source replay and action realization have the same amount owner.
 * Unrelated later-stage Amounts are not evidence the canonical dose changed. */
export function instructionGraphSourceConflictsWithDose(
  clause: CanonicalSigClause, options?: Pick<ParseOptions, "instructionActionMap">
): boolean {
  const graph = clause.instructionGraph;
  const dose = clause.dose;
  if (!graph) return false;
  if (clause.sourceProjectionVerified === false) return true;
  if (!dose || (dose.value === undefined && !dose.range)) return false;
  // A failed live timing/dose proof takes precedence over source ownership.
  if (dose.sourceDoseVerified === false) return true;
  // The single-dose default is precisely one discrete unit. Changing that
  // amount does not inherit permission to replay the old amountless wording.
  if (dose.defaulted && dose.value === 1 && dose.unit === dose.defaultedUnit &&
      !dose.range && !dose.comparator) return false;
  const owner = primaryDoseAmountOwner(graph, clause, options);
  if (!owner) {
    // HPSG primary-dose facts need not be repeated in auxiliary actions.
    // Failed live-source proof was handled above; an Amount owner below
    // remains independent evidence and is compared with the live dose.
    if (dose.sourceDoseVerified) return false;
    for (const evidence of clause.evidence ?? [])
      if (evidence.lexicalCategory === "dose") return false;
    return true;
  }
  return primaryAmountConflicts(owner.argument, dose);
}

export function instructionGraphRichPrimaryAction(
  clause: CanonicalSigClause
): AdviceFrame | undefined {
  const graph = clause.instructionGraph;
  if (!graph?.actions.length) return undefined;
  const index = primaryInstructionOwnership(graph, clause).administrationActionIndex;
  const action = index === undefined ? undefined : graph.actions[index];
  if (!action || action.polarity === AdvicePolarity.Negate) return undefined;
  const hasCanonicalAdministration = Boolean(
    clause.method || clause.route || clause.dose || clause.site ||
    clause.schedule && (
      clause.schedule.timingCode || clause.schedule.frequency !== undefined ||
      clause.schedule.period !== undefined || clause.schedule.when?.length ||
      clause.schedule.dayOfWeek?.length || clause.schedule.timeOfDay?.length ||
      clause.schedule.activityTiming?.length
    )
  );
  if (!hasCanonicalAdministration || primaryActionCoveredByCanonicalClause(action, graph.actions, clause, action)) return undefined;
  const rich = action.relation || action.args.some(arg => [
    AdviceArgumentRole.Duration, AdviceArgumentRole.Time, AdviceArgumentRole.Activity,
    AdviceArgumentRole.Material, AdviceArgumentRole.Result, AdviceArgumentRole.Destination,
    AdviceArgumentRole.Substance, AdviceArgumentRole.Manner,
    AdviceArgumentRole.Object, AdviceArgumentRole.Theme
  ].indexOf(arg.role) >= 0);
  const suppliesMissingHead = !clause.method && clause.dose && action.args.some(arg =>
    arg.role === AdviceArgumentRole.Amount && quantityCoveredByDose(arg, clause.dose));
  return rich || suppliesMissingHead ? action : undefined;
}

export function instructionGraphRoundTripPrimaryAction(
  clause: CanonicalSigClause
): AdviceFrame | undefined {
  const graph = clause.instructionGraph;
  if (!graph) return undefined;
  const ownership = primaryInstructionOwnership(graph, clause);
  const index = ownership.administrationActionIndex;
  const action = index === undefined ? undefined : graph.actions[index];
  if (!action) return undefined;
  const hasLocalRelation = relationHasGrammarFeature(action.relation, "roundtripRichRelation");
  const hasRichArgument = action.args.some((arg) =>
    [
      AdviceArgumentRole.Time, AdviceArgumentRole.Duration, AdviceArgumentRole.Material,
      AdviceArgumentRole.Activity, AdviceArgumentRole.Result, AdviceArgumentRole.Destination,
      AdviceArgumentRole.Substance, AdviceArgumentRole.Manner
    ].indexOf(arg.role) >= 0 ||
    ((arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme) &&
      /\b(?:new|replacement|another|fresh)\b/i.test(arg.text))
  );
  // Compare the original bound argument, before any temporary display view
  // filters/replaces its neighbors. Other amounts keep their separate meaning.
  const amount = ownership.dose && ownership.dose.actionIndex === index ? action.args[ownership.dose.argumentIndex] : undefined;
  const conflictingAmount = primaryAmountConflicts(amount, clause.dose,
    !clause.dose && clause.sourceProjectionVerified === false);
  return !conflictingAmount && (!clause.method || actionMatchesCanonicalMethod(action, clause)) &&
    (hasLocalRelation || hasRichArgument) ? action : undefined;
}

export function instructionGraphPrimarySiteRelation(
  clause: CanonicalSigClause
): AdviceRelation | undefined {
  const graph = clause.instructionGraph;
  const primary = graph?.primaryAdministrationSpan;
  if (!graph || !primary || !clause.site) return undefined;
  let selected: AdviceFrame | undefined, selectedRelation: AdviceRelation | undefined;
  for (const action of graph.actions) {
    if (action.polarity === AdvicePolarity.Negate || action.span.start >= primary.end ||
        primary.start >= action.span.end || !actionMatchesCanonicalMethod(action, clause)) continue;
    for (const arg of action.args) {
      if (arg.role !== AdviceArgumentRole.Site || !siteArgumentCoveredByClause(arg, clause)) continue;
      const relation = instructionFrameSiteRelation(action, arg);
      if (relation && (!selected || action.span.start < selected.span.start ||
          action.span.start === selected.span.start && action.span.end < selected.span.end)) {
        selected = action;
        selectedRelation = relation;
      }
      break;
    }
  }
  return selectedRelation;
}

export function instructionGraphPrimaryAdministrationModality(
  clause: CanonicalSigClause
): AdviceModality | undefined {
  const graph = clause.instructionGraph;
  const primary = graph?.primaryAdministrationSpan;
  if (!graph || !primary) return undefined;
  return graph.actions
    .filter((action) =>
      action.polarity !== AdvicePolarity.Negate &&
      action.modality !== undefined &&
      action.span.start < primary.end && primary.start < action.span.end &&
      actionMatchesCanonicalMethod(action, clause)
    )
    .sort((left, right) =>
      left.span.start - right.span.start || left.span.end - right.span.end
    )[0]?.modality;
}

export function instructionGraphHasNovelNonWarningContent(
  graph: CanonicalInstructionGraph,
  representedTexts: readonly string[]
): boolean {
  const represented = representedTexts.map(normalizedInstructionSurface).filter(Boolean);
  const isRepresented = (text: string): boolean => {
    const normalized = normalizedInstructionSurface(text);
    return Boolean(normalized && represented.some((candidate) => candidate.includes(normalized)));
  };
  for (const action of graph.actions) {
    if (action.polarity !== AdvicePolarity.Negate && !isRepresented(action.sourceText)) return true;
  }
  for (const opaque of graph.opaqueSpans ?? []) {
    if (!isRepresented(opaque.text)) return true;
  }
  return false;
}

function sourceTextCoversFrameMeaning(frame: AdviceFrame): boolean {
  const source = normalizedInstructionSurface(frame.sourceText);
  if (!source) return false;
  return frame.args.every((arg) => {
    const surface = normalizedInstructionSurface(arg.text ?? arg.normalized ?? "");
    if (!surface) return true;
    return source.includes(surface) || surface.includes(source);
  });
}

function conditionRelationBody(text: string, kind: AdviceRelation): string | undefined {
  const trimmed = trimSemanticText(text);
  if (!trimmed) return undefined;
  let body = trimmed;
  if (!relationHasGrammarFeature(kind, "conditionScope")) return undefined;
  for (const surface of getAdviceRelationSurfaceForms(kind)) {
    const normalizedSurface = surface.trim();
    if (!normalizedSurface) continue;
    const source = body.toLowerCase();
    const candidate = normalizedSurface.toLowerCase();
    if (!source.startsWith(candidate)) continue;
    const remainder = body.slice(normalizedSurface.length);
    const asciiWordSurface = /^[\x00-\x7F]+$/u.test(normalizedSurface) && /[A-Za-z0-9]$/u.test(normalizedSurface);
    if (asciiWordSurface && remainder && !/^[\s,;:()]/u.test(remainder)) continue;
    body = remainder.trim();
    break;
  }
  return body || undefined;
}

/** A live guard subsumes retained graph wording only when every permitted
 * alternative still requires that condition; no graph reparse is needed. */
function primaryConditionOwnsSource(
  condition: MedicationCondition, source: string, negative: boolean, negated = false
): boolean {
  if (condition.kind === "not")
    return primaryConditionOwnsSource(condition.condition, source, negative, !negated);
  if ("conditions" in condition) {
    if (!condition.conditions.length) return false;
    const owns = (child: MedicationCondition) => primaryConditionOwnsSource(child, source, negative, negated);
    const conjunction = (condition.kind === "all") !== negated;
    return conjunction ? condition.conditions.some(owns) : condition.conditions.every(owns);
  }
  const negativeLeaf = negated !== (condition.kind === "state" && !condition.expected);
  return negative === negativeLeaf && normalizedInstructionSurface(condition.text) === source;
}

function localizeConditionRelationText(
  relation: CanonicalInstructionRelation,
  sourceLocale: string,
  targetLocale: string
): string | undefined {
  const text = trimSemanticText(relation.text ?? "");
  if (!text) return undefined;
  const sourceLanguage = baseLanguageTag(sourceLocale) ?? sourceLocale.toLowerCase();
  const targetLanguage = baseLanguageTag(targetLocale) ?? targetLocale.toLowerCase();
  if (sourceLanguage === targetLanguage) return text;
  const rawBody = conditionRelationBody(text, relation.kind);
  if (!rawBody) return text;
  const sourceAdapter = getInstructionActionLocaleAdapter(sourceLocale);
  const targetAdapter = getInstructionActionLocaleAdapter(targetLocale);
  const parsed = sourceAdapter.parseConditionPersistence(rawBody);
  const definition = resolveSymptomDefinition(parsed.body);
  let body: string | undefined;
  if (definition) {
    const symptom = localizedValue(definition.i18n, targetLocale) ??
      definition.text ?? definition.coding?.display;
    if (!symptom) return text;
    const conditionForm = localizedValue(definition.conditionI18n, targetLocale);
    body = targetAdapter.renderConditionBody(symptom, conditionForm, parsed.persists);
  } else {
    const concept = resolveMedicationInstructionConcept(parsed.body);
    const action = concept ? undefined : resolveMedicationInstructionAction(parsed.body);
    if (!concept && !action) return text;
    body = localizedValue(concept?.i18n, targetLocale) ??
      localizedValue(action?.i18n, targetLocale) ??
      concept?.display ?? action?.display;
  }
  if (!body) return text;
  const lead = localizeAdviceRelation(relation.kind, targetLocale) ?? relation.kind;
  return targetAdapter.joinConditionLead(lead, body);
}

/** A graph condition whose primary action is rendered by the clause formatter. */
export interface InstructionGraphPrimaryCondition {
  text: string;
  position: "pre" | "post";
  start: number;
  imperative: boolean;
}

/** Resolve the same typed external relation for complete graph or scoped
 * instruction realization. Unknown condition wording stays source-preserved. */
function instructionGraphCondition(
  relation: CanonicalInstructionRelation, target: AdviceFrame,
  sourceLocale: string, targetLocale: string
): InstructionGraphPrimaryCondition | undefined {
  if (!relation.text) return undefined;
  const normalizedRelation = normalizedInstructionSurface(relation.text);
  const representedByTarget = target.relation === relation.kind && target.args.some((arg) => {
    const argSurface = normalizedInstructionSurface(arg.text ?? arg.normalized ?? "");
    return Boolean(normalizedRelation && argSurface &&
      (normalizedRelation.includes(argSurface) || argSurface.includes(normalizedRelation)));
  });
  if (representedByTarget) return undefined;
  const text = localizeConditionRelationText(relation, sourceLocale, targetLocale);
  return text ? {
    text,
    position: relation.span && relation.span.end <= target.span.start ? "pre" : "post",
    start: relation.span?.start ?? target.span.end,
    imperative: !target.modality && target.polarity !== AdvicePolarity.Negate
  } : undefined;
}

/** Attach only conditions owned by that primary, before independent graph
 * actions/advice are composed. Ordinary clauses do not allocate this report. */
export function attachInstructionGraphPrimaryConditions(
  text: string,
  conditions: InstructionGraphPrimaryCondition[] | undefined,
  locale: string,
  guardedPrimary = false
): string {
  if (!text || !conditions?.length) return text;
  const adapter = getInstructionActionLocaleAdapter(locale);
  const ending = text.match(/[.!?]+$/u)?.[0] ?? "";
  let body = ending ? text.slice(0, -ending.length) : text;
  if (conditions.length > 1) conditions.sort((a, b) => a.start - b.start);
  for (const condition of conditions) if (condition.position === "post" && !guardedPrimary) {
    const continuation = adapter.postposedCondition(condition.text);
    body += /^\s/u.test(continuation) ? continuation : " " + continuation;
  }
  for (let index = conditions.length - 1; index >= 0; index -= 1) {
    const condition = conditions[index];
    if (condition.position === "pre" || guardedPrimary) {
      const continuation = adapter.conditionalContinuation(body, condition.imperative);
      body = condition.text + (/^[\s,;:]/u.test(continuation) ? "" : " ") + continuation;
    }
  }
  return body.charAt(0).toUpperCase() + body.slice(1) + ending;
}

export function realizeInstructionGraph(
  graph: CanonicalInstructionGraph,
  locale = graph.sourceLocale ?? "en",
  options?: {
    includeWarnings?: boolean;
    onlyWarnings?: boolean;
    omitCanonicalAdministration?: CanonicalSigClause;
    /** The selected primary action already realized with its full arguments.
     * Identity remains valid even when imported source wording is absent. */
    omitRenderedAction?: AdviceFrame;
    /** Report conditions attached to the covered primary during this walk. */
    primaryConditions?: InstructionGraphPrimaryCondition[];
    /** Prefer each understood action's exact source wording when source and target locales match. */
    preferSourceText?: boolean;
    /** Source phrases already rendered through another semantic channel. */
    omitSourceTexts?: readonly string[];
    /** Restrict realization around the canonical primary administration source span. */
    position?: "all" | "pre" | "post";
    /** Prefer deliberately unambiguous lexical labels when generating parse-safe text. */
    roundtripSafe?: boolean;
    instructionActionMap?: ParseOptions["instructionActionMap"];
  }
): string | undefined {
  const omittedSources = (options?.omitSourceTexts ?? [])
    .map(normalizedInstructionSurface)
    .filter(Boolean);
  const position = options?.position ?? "all";
  const primary = graph.primaryAdministrationSpan;
  const doseOwner = options?.omitCanonicalAdministration
    ? primaryDoseAmountOwner(graph, options.omitCanonicalAdministration, options) : undefined;
  const amountOwner = doseOwner?.action;
  const primaryAction = graph.primaryOwnership
    ? graph.primaryOwnership.administrationActionIndex ?? -1
    : primary ? graph.actions.findIndex(frame =>
      frame.span.start <= primary.start && primary.end <= frame.span.end) : -1;
  const temporalEdges = new Map<number, number[]>();
  for (const relation of graph.relations ?? []) {
    if (relation.fromActionIndex === undefined) continue;
    const from = relation.kind === AdviceRelation.After ? relation.toActionIndex : relation.fromActionIndex;
    const to = relation.kind === AdviceRelation.After ? relation.fromActionIndex : relation.toActionIndex;
    if (relation.kind !== AdviceRelation.After && relation.kind !== AdviceRelation.Before &&
        relation.kind !== AdviceRelation.Then) continue;
    const targets = temporalEdges.get(from) ?? [];
    targets.push(to); temporalEdges.set(from, targets);
  }
  const precedes = (from: number, to: number): boolean => {
    const pending = [...(temporalEdges.get(from) ?? [])];
    const visited = new Set<number>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === to) return true;
      if (visited.has(next)) continue;
      visited.add(next); pending.push(...(temporalEdges.get(next) ?? []));
    }
    return false;
  };
  const inRequestedPosition = (start: number, end: number, actionIndex?: number): boolean => {
    if (!primary || position === "all") return true;
    if (primaryAction >= 0 && actionIndex !== undefined && actionIndex !== primaryAction) {
      const before = precedes(actionIndex, primaryAction);
      const after = precedes(primaryAction, actionIndex);
      if (before !== after) return position === "pre" ? before : after;
    }
    if (position === "pre") return end <= primary.start;
    return start >= primary.start;
  };
  const frames: number[] = [];
  const conditionTargets = new Map<number | undefined, AdviceFrame>();
  let coveredPrimaryAction: number | undefined;
  let displayedAmountOwner = amountOwner;
  for (let actionIndex = 0; actionIndex < graph.actions.length; actionIndex += 1) {
    const sourceFrame = graph.actions[actionIndex];
    if (sourceFrame === options?.omitRenderedAction) {
      if (!options?.onlyWarnings) {
        conditionTargets.set(actionIndex, sourceFrame);
        if (actionIndex === primaryAction) coveredPrimaryAction = actionIndex;
      }
      continue;
    }
    const ownsPrimary = primaryAction >= 0
      ? actionIndex === primaryAction : !graph.primaryOwnership && sourceFrame === amountOwner;
    const frame = ownsPrimary && options?.omitCanonicalAdministration
      ? frameWithCanonicalPrimaryContext(sourceFrame, options.omitCanonicalAdministration) : sourceFrame;
    if (sourceFrame === amountOwner) displayedAmountOwner = frame;
    const inPosition = inRequestedPosition(frame.span.start, frame.span.end, actionIndex);
    // A preposed condition can precede its canonically rendered primary
    // action. Resolve that one target even when the action is outside PRE.
    if (!inPosition && !(position === "pre" && primaryAction >= 0 &&
        sourceFrame === graph.actions[primaryAction] && options?.omitCanonicalAdministration)) continue;
    const frameSource = normalizedInstructionSurface(sourceFrame.sourceText);
    // A partial text overlap is not evidence that an independent action was
    // rendered. In particular, it cannot erase one half of a prohibition.
    if (frameSource && omittedSources.indexOf(frameSource) >= 0) continue;
    const hasAmount = options?.omitCanonicalAdministration &&
      frame.args.some(arg => arg.role === AdviceArgumentRole.Amount && arg.quantity);
    if (options?.omitCanonicalAdministration &&
      // A later, independent action may now happen to match the clinician's
      // EDITED method and dose. Only the source-backed amount owner may be
      // removed as the canonical administration; other quantified actions
      // keep their separate meaning and original temporal relationship.
      // An amountless action instead follows the explicit primary span,
      // including when an independent preparation supplied the dose.
      (!hasAmount || amountOwner === sourceFrame) &&
      primaryActionCoveredByCanonicalClause(frame, graph.actions, options.omitCanonicalAdministration,
        graph.primaryOwnership ? primaryAction >= 0 ? graph.actions[primaryAction] : null
          : primary ? !hasAmount && primaryAction >= 0 ? graph.actions[primaryAction] : amountOwner : undefined,
        sourceFrame)) {
      // The administration sentence covers this action, not its graph-only
      // conditional relation. Keep the target without emitting the action twice.
      if (!options?.onlyWarnings &&
          !(options?.includeWarnings === false && frame.polarity === AdvicePolarity.Negate)) {
        conditionTargets.set(actionIndex, frame);
        if (ownsPrimary) coveredPrimaryAction = actionIndex;
      }
      continue;
    }
    if (!inPosition) continue;
    const definition = getMedicationInstructionAction(frame.predicate.lemma);
    if (
      options?.omitCanonicalAdministration &&
      definition?.supportVerb &&
      frame.polarity !== AdvicePolarity.Negate &&
      frame.modality === undefined &&
      frame.args.length === 0 &&
      primary &&
      frame.span.end <= primary.start &&
      primary.start - frame.span.end <= 1
    ) {
      continue;
    }
    const warning = frame.polarity === AdvicePolarity.Negate;
    if (options?.onlyWarnings ? !warning : options?.includeWarnings === false && warning) continue;
    frames.push(actionIndex);
    conditionTargets.set(actionIndex, frame);
  }
  const localeAdapter = getInstructionActionLocaleAdapter(locale);
  const nodes: Array<{
    start: number;
    end: number;
    text: string;
    understood: boolean;
    actionIndex?: number;
    conditionTargetActionIndex?: number;
    warning?: boolean;
  }> = [];
  const targetLanguage = baseLanguageTag(locale) ?? locale.toLowerCase();
  const sourceLocale = graph.sourceLocale ?? "en";
  const sourceLanguage = baseLanguageTag(sourceLocale) ?? sourceLocale.toLowerCase();
  for (const actionIndex of frames) {
    const sourceFrame = conditionTargets.get(actionIndex)!;
    const currentDose = options?.omitCanonicalAdministration?.dose;
    const editedPrimary = Boolean(displayedAmountOwner === sourceFrame &&
      primaryAmountConflicts(doseOwner?.argument, currentDose,
        !currentDose && options?.omitCanonicalAdministration?.sourceProjectionVerified === false));
    // The source dose owner keeps its role after an external amount edit.
    // A sole preparation before the primary action supplies the live amount
    // there; the later rich administration does not repeat or inherit it.
    const frame = editedPrimary
      ? frameWithReconciledAmount(sourceFrame, doseOwner!.argument, currentDose,
          Boolean(primary && amountOwner && amountOwner.span.end <= primary.start))
      : sourceFrame;
    if (editedPrimary && frame.args.length === 0 && options?.omitCanonicalAdministration &&
        primaryActionCoveredByCanonicalClause(frame, graph.actions,
          options.omitCanonicalAdministration, sourceFrame, sourceFrame)) {
      // A removed stale Amount can leave only the administration already
      // rendered from current facts. Its index still owns graph conditions.
      conditionTargets.set(actionIndex, frame);
      coveredPrimaryAction = actionIndex;
      continue;
    }
    const definition = getMedicationInstructionAction(frame.predicate.lemma);
    const secondaryAdministration = Boolean(
      definition?.administrationMethod?.code &&
      graph.primaryAdministrationSpan &&
      (frame.span.end <= graph.primaryAdministrationSpan.start ||
       frame.span.start >= graph.primaryAdministrationSpan.end)
    );
    const sourceFaithful = !editedPrimary && (
      options?.preferSourceText || secondaryAdministration ||
      frame.polarity === AdvicePolarity.Negate
    ) && frame.polaritySource !== "shared" &&
      targetLanguage === sourceLanguage && sourceTextCoversFrameMeaning(frame)
      ? trimSemanticText(frame.sourceText)
      : undefined;
    const text = sourceFaithful || realizeAction(frame, locale, options?.roundtripSafe === true);
    if (text) {
      nodes.push({
        start: frame.span.start,
        end: frame.span.end,
        text,
        understood: true,
        actionIndex,
        warning: frame.force === AdviceForce.Warning || frame.force === AdviceForce.Caution ||
          frame.polarity === AdvicePolarity.Negate
      });
    }
  }
  for (const relation of graph.relations ?? []) {
    if (relation.fromActionIndex !== undefined || relation.toActionIndex === undefined) continue;
    const target = conditionTargets.get(relation.toActionIndex);
    if (!target || !relation.text || relation.span &&
        !inRequestedPosition(relation.span.start, relation.span.end, relation.toActionIndex)) continue;
    const condition = instructionGraphCondition(relation, target, graph.sourceLocale ?? "en", locale);
    if (!condition) continue;
    const currentCondition = options?.omitCanonicalAdministration?.clinicalAdjuncts?.condition;
    if (currentCondition && relation.toActionIndex === coveredPrimaryAction &&
        relationHasSemanticClass(relation.kind, "conditional")) {
      const sourceBody = conditionRelationBody(relation.text, relation.kind);
      if (sourceBody && primaryConditionOwnsSource(currentCondition,
          normalizedInstructionSurface(sourceBody), relation.kind === AdviceRelation.Unless)) continue;
    }
    if (options?.primaryConditions && relation.toActionIndex === coveredPrimaryAction &&
        relationHasGrammarFeature(relation.kind, "conditionScope")) {
      if (!relation.span && position === "pre") continue;
      options.primaryConditions.push({
        ...condition,
        position: relation.span && relation.span.end <= (primary?.start ?? target.span.start) ? "pre" : "post"
      });
      continue;
    }
    if (!relation.span) {
      const targetNode = nodes.find(node => node.actionIndex === relation.toActionIndex);
      if (targetNode) targetNode.text += localeAdapter.postposedCondition(condition.text);
      continue;
    }
    nodes.push({
      start: relation.span.start,
      end: relation.span.end,
      text: condition.text,
      understood: false,
      conditionTargetActionIndex: relation.toActionIndex
    });
  }
  if (!options?.onlyWarnings) {
    for (const opaque of graph.opaqueSpans ?? []) {
      if (!inRequestedPosition(opaque.start, opaque.end)) continue;
      const text = opaque.text.trim();
      if (text) nodes.push({ start: opaque.start, end: opaque.end, text, understood: false });
    }
  }
  if (!nodes.length) return undefined;
  nodes.sort((left, right) => left.start - right.start);
  let output = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!output) {
      output = node.text;
      continue;
    }
    const previous = nodes[index - 1];
    const conditional = !previous?.understood && node.understood
      ? graph.relations?.find((relation) =>
        relation.fromActionIndex === undefined &&
        relation.toActionIndex === node.actionIndex &&
        relation.span?.start === previous.start &&
        relation.span?.end === previous.end
      )
      : undefined;
    if (conditional) {
      const target = conditionTargets.get(node.actionIndex);
      const imperative = Boolean(target && !target.modality && target.polarity !== AdvicePolarity.Negate);
      output += localeAdapter.conditionalContinuation(node.text, imperative);
      continue;
    }
    const postposedConditional = Boolean(
      previous?.understood &&
      !node.understood &&
      node.conditionTargetActionIndex === previous.actionIndex
    );
    if (postposedConditional) {
      output += localeAdapter.postposedCondition(node.text);
      continue;
    }
    const discourseConnector = !previous?.understood && node.understood &&
      ACTION_DISCOURSE_CONNECTORS.has(normalizedInstructionSurface(previous?.text ?? "")) &&
      !graph.sourceText.slice(previous.end, node.start).trim();
    if (discourseConnector) {
      output += " " + localeAdapter.continuationText(node.text, true);
      continue;
    }
    const explicitRelation = previous?.understood && node.understood
      ? graph.relations?.find((relation) =>
          relation.fromActionIndex === previous.actionIndex &&
          relation.toActionIndex === node.actionIndex
        )
      : undefined;
    if (previous?.understood && node.understood && node.warning && !explicitRelation) {
      output += `. ${node.text}`;
      continue;
    }
    output += previous?.understood && node.understood && relationHasSemanticClass(explicitRelation?.kind, "sequence")
      ? localeAdapter.sequenceSeparator()
      : "; ";
    output += localeAdapter.continuationText(node.text, node.understood);
  }
  return output;
}
