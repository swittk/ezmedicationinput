import { resolveBodySitePhrase } from "./body-site-grammar";
import { lexInput } from "./lexer/lex";
import { normalizeUnit } from "./unit-lexicon";
import { EVENT_TIMING_TOKENS, PRODUCT_FORM_HINTS } from "./maps";
import { resolveEventTimingExpression } from "./event-timing-expression";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_DIRECTIVE_PREFIXES,
  ACTION_RELATION_BY_TOKEN,
  ACTION_SEQUENCE_MARKERS,
  ACTION_SEQUENCE_RELATION_TOKENS,
  AS_NEEDED_LEAD_PHRASES,
  DURATION_LEAD_TOKENS,
  INSTRUCTION_DURATION_APPROXIMATION_LEADS,
  INSTRUCTION_DURATION_UNITS,
  INSTRUCTION_QUANTITY_UNIT_LABELS,
  MEAL_TIMING_BY_RELATION,
  RANGE_CONNECTORS,
  THAI_METHOD_AUXILIARY_VERBS
} from "./hpsg/lexical-classes";
import {
  medicationInstructionConceptCodings,
  resolveMedicationInstructionConcept
} from "./instruction-concept-terminology";
import {
  getMedicationInstructionAction,
  medicationInstructionActionCodings,
  normalizeActionSurface,
  resolveMedicationInstructionAction,
  resolveMedicationInstructionSeparableAction
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
  CanonicalSourceSpan,
  EventTiming,
  FhirCoding,
  MedicationInstructionActionArgumentParser,
  MedicationInstructionActionDefinition,
  MedicationInstructionActionRealizer,
  ParseOptions,
  TextRange
} from "./types";

type ActionDefinition = MedicationInstructionActionDefinition;
type Lexeme = ReturnType<typeof lexInput>[number];
const SNOMED_SYSTEM = "http://snomed.info/sct";

function key(part: Lexeme | undefined): string {
  return part ? (part.canonical ?? part.lower).replace(/^\.+|\.+$/g, "") : "";
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
  const slice = parts.slice(index, index + length);
  if (slice.length !== length) return [];
  const canonical = slice.map((part) => key(part)).filter(Boolean);
  if (canonical.length !== length) return [];
  const candidates = new Set<string>();
  candidates.add(canonical.join(" "));
  candidates.add(slice.map((part) => part.original).join(" "));
  let contiguous = true;
  for (let offset = 1; offset < slice.length; offset += 1) {
    if (slice[offset - 1].sourceEnd !== slice[offset].sourceStart) {
      contiguous = false;
      break;
    }
  }
  if (contiguous) candidates.add(slice.map((part) => part.original).join(""));
  return Array.from(candidates).filter((candidate) => candidate.trim().length > 0);
}

function actionMatchAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): ActionMatch | undefined {
  const current = parts[index];
  const next = parts[index + 1];
  if (
    current && next &&
    AS_NEEDED_LEAD_PHRASES.has(`${key(current)} ${key(next)}`) &&
    !actionAtIsGovernedByDirective(parts, index)
  ) {
    return undefined;
  }
  const previous = parts.slice(index - 1, index)[0];
  if (previous && ACTION_RELATION_BY_TOKEN.has(key(previous))) return undefined;
  const maxSpan = Math.min(4, parts.length - index);
  for (let length = maxSpan; length >= 1; length -= 1) {
    for (const candidate of actionPhraseCandidates(parts, index, length)) {
      const definition = resolveMedicationInstructionAction(candidate, options);
      if (definition) {
        const first = parts[index];
        if (THAI_METHOD_AUXILIARY_VERBS.has(definition.code) && first && /[\u0E00-\u0E7F]/.test(first.original)) {
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
  const lookupText = text
    .replace(/^\s*บริเวณ\s*/u, "")
    .replace(/^\s*(?:the|a|an)\s+/i, "")
    .trim() || text;
  const resolved = resolveBodySitePhrase(lookupText, options?.siteCodeMap, {
    bodySiteContext: options?.context?.bodySiteContext
  });
  if (!resolved || (!resolved.coding && !resolved.definition)) return undefined;
  return {
    role: AdviceArgumentRole.Site,
    text,
    normalized: resolved.canonical,
    conceptId: resolved.canonical,
    coding: resolved.coding,
    codings: resolved.coding ? [resolved.coding] : undefined,
    i18n: {
      en: resolved.englishObjectText,
      ...(resolved.definition?.i18n ?? {}),
      ...(/[\u0E00-\u0E7F]/.test(text) ? { th: text } : {})
    }
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
  const preferredCoding = definition.coding
    ? codings[0]
    : definition.externalCodings?.length
      ? codings[1]
      : codings[0];
  return {
    role: definition.role,
    text: sourceText,
    normalized: definition.display,
    conceptId: definition.code,
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

function timeArgumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string
): AdviceArgument | undefined {
  const canonicalParts = parts.slice(start, endExclusive).map((part) => key(part));
  let event: EventTiming | undefined;
  for (let index = 0; index < canonicalParts.length; index += 1) {
    const candidate = resolveEventTimingExpression(canonicalParts, index);
    if (candidate) {
      event = candidate.timing;
      break;
    }
  }
  if (!event) return undefined;
  const text = trimSemanticText(sourceFor(parts, start, endExclusive, input));
  if (!text) return undefined;
  return {
    role: AdviceArgumentRole.Time,
    text,
    normalized: event
  };
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
  for (let index = start; index < endExclusive; index += 1) {
    const currentKey = key(parts.slice(index, index + 1)[0]);
    if (currentKey) canonicalParts.push(currentKey);
  }
  const canonical = canonicalParts.join(" ");
  const direct = internalArgument(canonical, text, options);
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
  const allPartsCanonical = parts
    .slice(start, endExclusive)
    .every((part) => Boolean(part.canonical));
  return {
    role: preferredRole ?? AdviceArgumentRole.Object,
    text,
    normalized: allPartsCanonical && canonical ? canonical : text.toLowerCase()
  };
}

function pushArgument(args: AdviceArgument[], argument: AdviceArgument | undefined): void {
  if (!argument) return;
  if (!args.some((candidate) =>
    candidate.role === argument.role && candidate.text === argument.text && candidate.conceptId === argument.conceptId
  )) args.push(argument);
}

function relationIndex(parts: Lexeme[], start: number, endExclusive: number): number {
  for (let index = start; index < endExclusive; index += 1) {
    if (ACTION_RELATION_BY_TOKEN.has(key(parts.slice(index, index + 1)[0]))) return index;
  }
  return -1;
}

const INSTRUCTION_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

function parseQuantityArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number,
  options?: ParseOptions
): AdviceArgument | undefined {
  for (let index = start; index + 1 < endExclusive; index += 1) {
    const valueToken = parts[index];
    const unitToken = parts[index + 1];
    if (!valueToken || !unitToken) continue;
    const unit = normalizeUnit(key(unitToken), options);
    if (!unit) continue;
    const wordValue = INSTRUCTION_NUMBER_WORDS[key(valueToken)];
    if ((valueToken.kind === "NUMBER" && valueToken.value !== undefined) || wordValue !== undefined) {
      const value = valueToken.kind === "NUMBER" ? valueToken.value : wordValue;
      return {
        role: AdviceArgumentRole.Amount,
        text: sourceFor(parts, index, index + 2, input),
        normalized: unit,
        quantity: { value, unit },
        span: { start: offset + valueToken.sourceStart, end: offset + unitToken.sourceEnd }
      };
    }
    if (valueToken.kind === "NUMBER_RANGE") {
      const match = valueToken.original.match(/^([0-9]+(?:\.[0-9]+)?)[-–—]([0-9]+(?:\.[0-9]+)?)$/);
      if (!match) continue;
      return {
        role: AdviceArgumentRole.Amount,
        text: sourceFor(parts, index, index + 2, input),
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
  let cursor = start;
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
  const unitToken = parts[cursor + 1];
  if (!unitToken || cursor + 1 >= endExclusive) return undefined;
  const unit = durationUnitFromKey(key(unitToken));
  if (!unit) return undefined;

  let quantity: AdviceArgument["quantity"] | undefined;
  if (valueToken.kind === "NUMBER" && valueToken.value !== undefined) {
    quantity = { value: valueToken.value, unit };
  } else if (valueToken.kind === "NUMBER_RANGE") {
    const range = valueToken.original.match(/^([0-9]+(?:\.[0-9]+)?)[-–—]([0-9]+(?:\.[0-9]+)?)$/);
    if (range) {
      quantity = { range: { low: Number(range[1]), high: Number(range[2]) }, unit };
    }
  }
  if (!quantity) return undefined;
  return {
    role: AdviceArgumentRole.Duration,
    text: sourceFor(parts, start, cursor + 2, input),
    normalized: valueToken.kind === "NUMBER_RANGE"
      ? `${valueToken.original} ${unit}`
      : `${valueToken.value} ${unit}`,
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

function parseBareDurationArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number
): AdviceArgument | undefined {
  return durationArgumentAt(parts, start, endExclusive, input, offset);
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
  return relation === AdviceRelation.In ||
    relation === AdviceRelation.On ||
    relation === AdviceRelation.Before ||
    relation === AdviceRelation.After
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
  amount?: AdviceArgument;
  duration?: AdviceArgument;
  separableParticleIndex?: number;
}
interface ParsedActionArguments { args: AdviceArgument[]; semanticEnd?: number; }
type ActionArgumentParser = (context: ActionArgumentParseContext) => ParsedActionArguments;
function parsedArgs(...values: Array<AdviceArgument | undefined>): AdviceArgument[] {
  const args: AdviceArgument[] = [];
  for (const value of values) pushArgument(args, value);
  return args;
}
const DEFAULT_ACTION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, options, relation, relIndex,
    relationTargetEnd, conditionalTail, duration, separableParticleIndex } = c;
  const objectEnd = separableParticleIndex !== undefined
    ? separableParticleIndex
    : relIndex >= 0 ? relIndex : segmentEnd;
  const args = parsedArgs(argumentFromParts(
    parts, argumentStart, objectEnd, input, undefined, options
  ));
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
  else if (relation === AdviceRelation.For && duration) pushArgument(args, duration);
  else if (relIndex >= 0 && !conditionalTail) {
    const time = (relation === AdviceRelation.In || relation === AdviceRelation.On ||
      relation === AdviceRelation.Before || relation === AdviceRelation.After ||
      relation === AdviceRelation.With)
      ? timeArgumentFromParts(parts, relIndex + 1, relationTargetEnd, input) : undefined;
    const fallbackRole = relation === AdviceRelation.Before || relation === AdviceRelation.After
      ? AdviceArgumentRole.Activity : undefined;
    pushArgument(args, time ?? argumentFromParts(
      parts, relIndex + 1, relationTargetEnd, input, fallbackRole, options
    ));
  }
  return { args };
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
  const tailStart = amountIndex !== undefined ? Math.min(segmentEnd, amountIndex + 2)
    : relIndex >= 0 ? relIndex + 1 : segmentEnd;
  if (tailStart < segmentEnd) {
    const tail = argumentFromParts(parts, tailStart, segmentEnd, input, AdviceArgumentRole.Material, options);
    if (relation === AdviceRelation.With || tail?.conceptId) pushArgument(args, tail);
  }
  return { args };
};
const AMOUNT_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => ({
  args: parsedArgs(c.amount, c.duration)
});
const OBJECT_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { parts, argumentStart, segmentEnd, input, offset, options, relIndex, duration } = c;
  const durationIndex = duration?.span ? partIndexForAbsoluteSourceStart(parts, duration.span.start, offset) : undefined;
  let objectEnd = durationIndex !== undefined ? durationIndex : segmentEnd;
  if (relIndex >= argumentStart && relIndex < objectEnd) objectEnd = relIndex;
  return { args: parsedArgs(
    objectEnd > argumentStart
      ? argumentFromParts(parts, argumentStart, objectEnd, input, AdviceArgumentRole.Object, options)
      : undefined,
    duration
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
  options?: ParseOptions
): AdviceArgument | undefined {
  if (end <= start) return undefined;
  const quantity = parseQuantityArgument(parts, start, end, input, offset, options);
  let entity: AdviceArgument | undefined;
  if (quantity?.span) {
    const quantityStart = partIndexForAbsoluteSourceStart(parts, quantity.span.start, offset);
    const quantityEnd = quantityStart !== undefined ? quantityStart + 2 : undefined;
    if (quantityStart !== undefined && quantityStart > start) {
      entity = argumentFromParts(parts, start, quantityStart, input, role, options);
    }
    if (!entity && quantityEnd !== undefined && quantityEnd < end) {
      entity = argumentFromParts(parts, quantityEnd, end, input, role, options);
    }
  } else {
    entity = argumentFromParts(parts, start, end, input, role, options);
  }
  const text = trimSemanticText(sourceFor(parts, start, end, input));
  if (!entity && !quantity) return undefined;
  const sourceEntityText = entity?.text;
  const result: AdviceArgument = entity ? { ...entity } : {
    role,
    text,
    normalized: quantity?.quantity?.unit ?? text.toLowerCase()
  };
  if (sourceEntityText && /[\u0E00-\u0E7F]/u.test(sourceEntityText)) {
    result.i18n = { ...(result.i18n ?? {}), th: sourceEntityText };
  }
  result.role = role;
  result.text = text;
  if (quantity?.quantity) result.quantity = quantity.quantity;
  const first = parts[start];
  const last = parts[end - 1];
  if (first && last) result.span = { start: offset + first.sourceStart, end: offset + last.sourceEnd };
  return result;
}

function trailingTimeArgument(
  parts: Lexeme[],
  start: number,
  end: number,
  input: string,
  options?: ParseOptions
): { start: number; argument: AdviceArgument } | undefined {
  for (let index = start; index < end; index += 1) {
    const canonical = parts.slice(index, end).map((part) => key(part));
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
  const objectEnd = time?.start ?? c.segmentEnd;
  return { args: parsedArgs(
    objectEnd > c.argumentStart
      ? argumentFromParts(c.parts, c.argumentStart, objectEnd, c.input, AdviceArgumentRole.Object, c.options)
      : undefined,
    time?.argument
  ) };
};

const MIX_SUBSTANCE_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { definition, parts, argumentStart, segmentEnd, input, offset, options, relIndex } = c;
  const absolutePrimary = configuredConceptIndex(
    parts, argumentStart, segmentEnd, definition.argumentParserConfig?.primaryConcepts);
  if (absolutePrimary < 0) return {
    args: parsedArgs(argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options))
  };

  const args: AdviceArgument[] = [];
  const split = relIndex >= argumentStart && relIndex < absolutePrimary ? relIndex : absolutePrimary;
  if (split > argumentStart) {
    pushArgument(args, quantifiedEntityArgument(
      parts, argumentStart, split, input, offset, AdviceArgumentRole.Theme, options));
  }

  const substanceStart = relIndex >= 0 && relIndex < absolutePrimary ? relIndex + 1 : absolutePrimary;
  const substance = quantifiedEntityArgument(
    parts, substanceStart, segmentEnd, input, offset, AdviceArgumentRole.Substance, options);
  if (substance?.conceptId === undefined) {
    const primary = argumentFromParts(
      parts, absolutePrimary, absolutePrimary + 1, input, AdviceArgumentRole.Substance, options);
    if (primary) {
      primary.text = substance?.text ?? primary.text;
      primary.quantity = substance?.quantity;
      primary.span = substance?.span ?? primary.span;
      pushArgument(args, primary);
    } else pushArgument(args, substance);
  } else pushArgument(args, substance);

  const secondaryIndex = configuredConceptIndex(
    parts, argumentStart, segmentEnd, definition.argumentParserConfig?.secondaryConcepts);
  if (secondaryIndex >= 0) {
    const part = parts[secondaryIndex];
    pushArgument(args, internalArgument(key(part), part.sourceText ?? part.original, options));
  }
  return { args };
};
const RESULT_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const { definition, parts, argumentStart, segmentEnd, input, options } = c;
  const resultIndex = configuredConceptIndex(
    parts, argumentStart, segmentEnd, definition.argumentParserConfig?.primaryConcepts);
  if (resultIndex < 0) return {
    args: parsedArgs(argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options))
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
  if (relIndex >= 0 && relIndex < semanticEnd) pushArgument(args, argumentFromParts(
    parts, relIndex + 1, semanticEnd, input, preferredRinseRole(relation), options));
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
const BARE_DURATION_ARGUMENT_PARSER: ActionArgumentParser = (c) => {
  const parsed = parseBareDurationArgument(c.parts, c.argumentStart, c.segmentEnd, c.input, c.offset) ?? c.duration;
  return { args: parsedArgs(parsed, parsed ? undefined : argumentFromParts(
    c.parts, c.argumentStart, c.segmentEnd, c.input, undefined, c.options
  )) };
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
  "amount-duration": AMOUNT_DURATION_ARGUMENT_PARSER,
  "object-duration": OBJECT_DURATION_ARGUMENT_PARSER,
  "object-time": OBJECT_TIME_ARGUMENT_PARSER,
  "mix-substance": MIX_SUBSTANCE_ARGUMENT_PARSER,
  result: RESULT_ARGUMENT_PARSER,
  site: SITE_ARGUMENT_PARSER,
  "site-relation": SITE_RELATION_ARGUMENT_PARSER,
  duration: DURATION_ARGUMENT_PARSER,
  "bare-duration": BARE_DURATION_ARGUMENT_PARSER,
  activity: ACTIVITY_ARGUMENT_PARSER
};
function contextualActionCodings(definition: ActionDefinition, args: readonly AdviceArgument[]): FhirCoding[] {
  const codings: FhirCoding[] = [];
  for (const rule of definition.contextualCodings ?? []) {
    const expected = rule.whenArgument;
    const matched = args.some((arg) =>
      (expected.role === undefined || arg.role === expected.role) &&
      (expected.conceptId === undefined || arg.conceptId === expected.conceptId) &&
      (expected.codingCode === undefined || arg.coding?.code === expected.codingCode) &&
      (expected.normalized === undefined || arg.normalized === expected.normalized));
    if (!matched || codings.some((coding) =>
      coding.code === rule.coding.code && coding.system === rule.coding.system)) continue;
    codings.push({ ...rule.coding });
  }
  return codings;
}

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
    ? ACTION_RELATION_BY_TOKEN.get(key(parts.slice(relIndex, relIndex + 1)[0]))
    : undefined;
  const nextRelationIndex = relIndex >= 0 ? relationIndex(parts, relIndex + 1, segmentEnd) : -1;
  const relationTargetEnd = nextRelationIndex >= 0 ? nextRelationIndex : segmentEnd;
  const conditionalTail = rawRelation === AdviceRelation.If ||
    rawRelation === AdviceRelation.Unless ||
    rawRelation === AdviceRelation.When;
  const relation = conditionalTail ? undefined : rawRelation;
  const amount = definition.acceptsAmount
    ? parseQuantityArgument(parts, argumentStart, segmentEnd, input, offset, options)
    : undefined;
  const duration = parseAnyDurationArgument(parts, argumentStart, segmentEnd, input, offset);
  let semanticEnd = conditionalTail && relIndex >= 0 ? relIndex : segmentEnd;

  const argumentParser = ACTION_ARGUMENT_PARSERS[definition.argumentParser ?? "default"] ??
    DEFAULT_ACTION_ARGUMENT_PARSER;
  const parsed = argumentParser({
    definition, parts, actionIndex, argumentStart, segmentEnd, input, offset, options,
    relation, relIndex, relationTargetEnd, conditionalTail, amount, duration,
    separableParticleIndex: actionMatch.separableParticleIndex
  });
  const args = parsed.args;
  if (parsed.semanticEnd !== undefined) semanticEnd = parsed.semanticEnd;
  pushArgument(args, amount);

  const codings = [
    ...medicationInstructionActionCodings(definition),
    ...contextualActionCodings(definition, args)
  ];
  const span = trimActionRange(input, rangeFor(parts, segmentStart, semanticEnd, offset), offset);
  return {
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
      realizerConfig: definition.realizerConfig ? {
        ...definition.realizerConfig,
        thaiSuppressActivityConcepts: definition.realizerConfig.thaiSuppressActivityConcepts
          ? [...definition.realizerConfig.thaiSuppressActivityConcepts]
          : undefined
      } : undefined,
      codings
    },
    relation,
    args,
    span,
    sourceText: input.slice(span.start - offset, span.end - offset),
    sequenceIndex
  };
}

interface PrefixedActionMatch {
  actionIndex: number;
  match: ActionMatch;
  polarity?: AdvicePolarity;
  modality?: AdviceModality;
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
    const actionIndex = index + prefix.parts.length;
    const match = actionMatchAt(parts, actionIndex, options);
    if (match) {
      return {
        actionIndex,
        match,
        polarity: prefix.polarity,
        modality: prefix.modality
      };
    }
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
  options?: ParseOptions
): boolean {
  if (!current) return false;
  const candidateSurface = key(parts[index]);
  const candidateDefinition = resolveMedicationInstructionAction(candidateSurface, options);
  const candidateCode = candidateDefinition?.code ?? candidateSurface;
  const previous = key(parts[index - 1]);
  const previousKind = parts[index - 1]?.kind;
  const next = key(parts[index + 1]);

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

const PREPOSED_ACTION_RELATIONS = new Set<AdviceRelation>([
  AdviceRelation.Before,
  AdviceRelation.After,
  AdviceRelation.During,
  AdviceRelation.Until
]);

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
  const relation = ACTION_RELATION_BY_TOKEN.get(key(parts[cursor]));
  if (!relation || !PREPOSED_ACTION_RELATIONS.has(relation)) return undefined;
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
  const time = timeArgumentFromParts(
    parts,
    attachment.targetStart,
    attachment.targetEnd,
    sourceText
  );
  const fallbackRole = attachment.relation === AdviceRelation.Before ||
    attachment.relation === AdviceRelation.After
    ? AdviceArgumentRole.Activity
    : undefined;
  pushArgument(
    frame.args,
    time ?? argumentFromParts(
      parts,
      attachment.targetStart,
      attachment.targetEnd,
      sourceText,
      fallbackRole,
      options
    )
  );
  const first = parts[attachment.relationIndex];
  if (!first) return;
  frame.span.start = baseOffset + first.sourceStart;
  frame.sourceText = sourceText.slice(first.sourceStart, frame.span.end - baseOffset);
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
      if (actionMatchAt(parts, index, options) && !actionCandidateIsDoseUnit(parts, index, options)) {
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
      if (ACTION_SEQUENCE_MARKERS.has(currentKey)) {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = ACTION_COORDINATION_CONNECTORS.has(previousKey) ? index - 1 : index;
        break;
      }
      if (
        ACTION_DIRECTIVE_BOUNDARIES.has(currentKey) &&
        !prefixedActionAt(parts, index, options) &&
        !resultativeLeadAt(parts, index, options)
      ) {
        end = index;
        break;
      }
      if (prefixedActionAt(parts, index, options)) {
        end = index;
        break;
      }
      const nextActionMatch = actionMatchAt(parts, index, options);
      if (
        nextActionMatch &&
        !actionCandidateIsDoseUnit(parts, index, options) &&
        !actionCandidateBelongsToCurrentFrame(parts, index, startingMatch?.definition, options)
      ) {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = ACTION_COORDINATION_CONNECTORS.has(previousKey) ? index - 1 : index;
        break;
      }
    }

    const frame = buildActionFrame(parts, start, end, sourceText, baseOffset, sequenceIndex, options);
    if (frame) {
      const preposed = preposedActionRelation(parts, cursor, start);
      if (preposed) {
        attachPreposedActionRelation(frame, preposed, parts, sourceText, baseOffset, options);
      }
      frames.push(frame);
      sequenceIndex += 1;
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

function frameActionDefinition(
  frame: AdviceFrame,
  options?: ParseOptions
): ActionDefinition | undefined {
  return resolveMedicationInstructionAction(frame.predicate.lemma, options) ??
    getMedicationInstructionAction(frame.predicate.lemma);
}

function frameIsProcedural(frame: AdviceFrame, options?: ParseOptions): boolean {
  return frameActionDefinition(frame, options)?.procedural ?? false;
}

function definitionCanRepresentPrimaryAdministration(
  definition: ActionDefinition | undefined
): boolean {
  return Boolean(definition && (!definition.procedural || definition.primaryAdministrationHead));
}

function frameOverlapsPrimaryMethod(frame: AdviceFrame, clause: CanonicalSigClause): boolean {
  for (const evidence of clause.evidence) {
    if (evidence.rule !== "hpsg.lex.method") continue;
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
    (frame.modality !== undefined || actionAddsPrimaryObjectMeaning(frame, options))
  );
}


function semanticSourceSpans(clause: CanonicalSigClause): SemanticSourceSpan[] {
  const ranges: SemanticSourceSpan[] = [];
  for (const evidence of clause.evidence) {
    const kind: SemanticSourceKind | undefined =
      evidence.rule === "hpsg.lex.patientInstruction.workflow"
        ? "workflow"
        : evidence.rule === "hpsg.lex.instruction" || evidence.rule === "hpsg.lex.conditionalAdvice"
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

function trimOpaqueSpan(input: string, start: number, end: number): CanonicalSourceSpan | undefined {
  while (start < end && /[\s,;:.()]/.test(input[start] ?? "")) start += 1;
  while (end > start && /[\s,;:.()]/.test(input[end - 1] ?? "")) end -= 1;
  if (end <= start) return undefined;
  const leading = input.slice(start, end).match(/^(?:(?:and|or|then)\b\s*|(?:และ|หรือ|จากนั้น|แล้ว)\s*)/iu);
  if (leading?.[0]) {
    start += leading[0].length;
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
  return `${dose.value ?? ""} ${dose.unit ?? ""}`.trim();
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
      unit: clause.dose.unit
    },
    span: range
  });
  best.span.end = range.end;
  best.sourceText = input.slice(best.span.start, best.span.end);
}

const CONDITION_RELATIONS = new Set<AdviceRelation>([
  AdviceRelation.If,
  AdviceRelation.Unless,
  AdviceRelation.When,
  AdviceRelation.While,
  AdviceRelation.Before,
  AdviceRelation.After,
  AdviceRelation.Until
]);

function relationFromSourceText(text: string): AdviceRelation | undefined {
  const keys = lexInput(text).map((token) => key(token)).filter(Boolean);
  for (const candidate of keys) {
    const relation = ACTION_RELATION_BY_TOKEN.get(candidate);
    if (relation === AdviceRelation.Before ||
      relation === AdviceRelation.After ||
      relation === AdviceRelation.During ||
      relation === AdviceRelation.While ||
      relation === AdviceRelation.Until ||
      relation === AdviceRelation.If ||
      relation === AdviceRelation.Unless ||
      relation === AdviceRelation.When) {
      return relation;
    }
    if (ACTION_SEQUENCE_RELATION_TOKENS.has(candidate)) return AdviceRelation.Then;
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
    if (explicitRelation && CONDITION_RELATIONS.has(explicitRelation)) {
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
      kind: explicitRelation ?? AdviceRelation.Then,
      fromActionIndex: index - 1,
      toActionIndex: index,
      text: trimmed || undefined,
      span: gapEnd > gapStart ? { start: gapStart, end: gapEnd } : undefined
    });
  }

  for (const opaque of opaqueSpans) {
    const kind = relationFromSourceText(opaque.text);
    if (!kind || !CONDITION_RELATIONS.has(kind)) continue;
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
      if (evidence.rule !== "hpsg.lex.method") continue;
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
      if (evidence.rule !== "hpsg.lex.patientInstruction.workflow") continue;
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
    const existingScore = actionSemanticScore(existing);
    const nextScore = actionSemanticScore(frame);
    if (nextScore > existingScore) target[existingIndex] = frame;
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

function conditionRelationsFromHpsgEvidence(
  clause: CanonicalSigClause,
  input: string,
  actions: AdviceFrame[]
): CanonicalInstructionRelation[] {
  const result: CanonicalInstructionRelation[] = [];
  for (const evidence of clause.evidence) {
    if (evidence.rule !== "hpsg.lex.condition") continue;
    for (const span of evidence.spans) {
      const conditionText = input.slice(span.start, span.end).trim();
      const kind = relationFromSourceText(conditionText);
      if (!kind || !CONDITION_RELATIONS.has(kind)) continue;
      let target = -1;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        const current = action.span.start >= span.end
          ? action.span.start - span.end
          : action.span.end <= span.start
            ? span.start - action.span.end
            : 0;
        if (current < distance) {
          distance = current;
          target = index;
        }
      }
      if (target < 0) continue;
      result.push({
        kind,
        toActionIndex: target,
        text: conditionText,
        span: { start: span.start, end: span.end }
      });
    }
  }
  return result;
}

export function refreshInstructionGraphDerivedState(
  graph: CanonicalInstructionGraph
): void {
  graph.actions.sort((left, right) =>
    left.span.start - right.span.start || left.span.end - right.span.end
  );
  for (let index = 0; index < graph.actions.length; index += 1) {
    graph.actions[index].sequenceIndex = index;
  }
  const opaqueSpans = graph.opaqueSpans ?? [];
  opaqueSpans.sort((left, right) => left.start - right.start || left.end - right.end);
  graph.opaqueSpans = opaqueSpans.length ? opaqueSpans : undefined;
  const derived = buildInstructionRelations(graph.sourceText, graph.actions, opaqueSpans);
  const preserved = (graph.relations ?? []).filter((relation) =>
    CONDITION_RELATIONS.has(relation.kind) && relation.fromActionIndex === undefined
  );
  const relations = derived.slice();
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
  const candidates = actions
    .filter((action) => resolveMedicationInstructionAction(action.predicate.lemma, options)?.definesDose)
    .map((action) => action.args.find((arg) => arg.role === AdviceArgumentRole.Amount && arg.quantity)?.quantity)
    .filter((quantity): quantity is NonNullable<AdviceArgument["quantity"]> => Boolean(quantity));
  if (!candidates.length) return;
  const first = candidates[0];
  const same = candidates.every((candidate) =>
    candidate.value === first.value &&
    candidate.unit === first.unit &&
    candidate.range?.low === first.range?.low &&
    candidate.range?.high === first.range?.high
  );
  if (!same) return;
  clause.dose = {
    value: first.value,
    range: first.range ? { ...first.range } : undefined,
    unit: first.unit
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
  if (semantic) return { start: semantic.span.start, end: semantic.span.end };
  const spans: TextRange[] = [];
  for (const evidence of clause.evidence) {
    if (evidence.rule !== "hpsg.lex.method") continue;
    for (const span of evidence.spans) spans.push({ start: span.start, end: span.end });
  }
  if (!spans.length) return undefined;
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  return spans[0];
}

export function buildInstructionGraph(
  input: string,
  clause: CanonicalSigClause,
  options?: ParseOptions
): CanonicalInstructionGraph | undefined {
  const actions: AdviceFrame[] = [];
  const opaqueSpans: CanonicalSourceSpan[] = [];
  const fullInputFrames = parseInstructionActions(input, 0, options);
  const primaryAdministrationSpan = canonicalPrimaryAdministrationSpan(clause, fullInputFrames);
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
    if (
      frameIsProcedural(frame, options) ||
      frameIsSecondaryAdministration(frame, clause, options) ||
      frameIsPrimaryAdministrationWithExtraMeaning(frame, clause, options)
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
      redundantCanonicalAdministration ||
      actionContainedInCanonicalSite(actions[index], clause) ||
      actionDominatedByCanonicalMethod(actions[index], clause, options, primaryAdministrationSpan)
    ) {
      actions.splice(index, 1);
    }
  }
  if (!actions.length && !opaqueSpans.length) return undefined;
  promoteDoseFromDefiningAction(clause, actions, options);
  attachDoseToNearestAction(actions, clause, input, options);
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
    sourceLocale: /[\u0E00-\u0E7F]/.test(input) ? "th" : "en"
  };
  const hpsgConditionRelations = conditionRelationsFromHpsgEvidence(clause, input, actions);
  graph.relations = hpsgConditionRelations.length ? hpsgConditionRelations : undefined;
  refreshInstructionGraphDerivedState(graph);
  return graph;
}

function translatedQuantity(
  quantity: NonNullable<AdviceArgument["quantity"]>,
  locale: string
): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  const singular = quantity.value === 1 && !quantity.range;
  const labels = quantity.unit ? INSTRUCTION_QUANTITY_UNIT_LABELS.get(quantity.unit) : undefined;
  const unit = labels
    ? (language === "th" ? labels.th : singular ? labels.enOne : labels.enOther)
    : (quantity.unit ?? "");
  if (quantity.range) {
    return `${quantity.range.low ?? ""}-${quantity.range.high ?? ""} ${unit}`.trim();
  }
  return `${quantity.value ?? ""} ${unit}`.trim();
}

const GRAPH_TIME_ARGUMENT_I18N: Partial<Record<EventTiming, { en: string; th: string }>> = {
  [EventTiming.Meal]: { en: "food", th: "อาหาร" },
  [EventTiming.Breakfast]: { en: "breakfast", th: "อาหารเช้า" },
  [EventTiming.Lunch]: { en: "lunch", th: "อาหารกลางวัน" },
  [EventTiming.Dinner]: { en: "dinner", th: "อาหารเย็น" },
  [EventTiming["Before Sleep"]]: { en: "sleep", th: "นอน" },
  [EventTiming.Wake]: { en: "waking", th: "ตื่นนอน" },
  [EventTiming.Morning]: { en: "the morning", th: "ตอนเช้า" },
  [EventTiming.Noon]: { en: "noon", th: "ตอนเที่ยง" },
  [EventTiming.Afternoon]: { en: "the afternoon", th: "ตอนบ่าย" },
  [EventTiming.Evening]: { en: "the evening", th: "ตอนเย็น" },
  [EventTiming.Night]: { en: "night", th: "ตอนกลางคืน" },
  [EventTiming.Immediate]: { en: "immediately", th: "ทันที" }
};

function translatedArgument(arg: AdviceArgument, locale: string): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  if (arg.quantity) return translatedQuantity(arg.quantity, locale);
  if (arg.role === AdviceArgumentRole.Time && arg.normalized) {
    const localized = GRAPH_TIME_ARGUMENT_I18N[arg.normalized as EventTiming];
    if (localized) return localized[language];
  }
  return arg.i18n?.[language] ?? arg.normalized ?? arg.text;
}

function translatedArgumentConcept(arg: AdviceArgument, locale: string): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  return arg.i18n?.[language] ?? arg.normalized ?? arg.text;
}

function actionLabel(frame: AdviceFrame, locale: string, roundtripSafe = false): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  const definition = getMedicationInstructionAction(frame.predicate.lemma);
  return (roundtripSafe ? definition?.roundtripI18n?.[language] : undefined) ??
    frame.predicate.i18n?.[language] ??
    (language === "en" ? frame.predicate.display : undefined) ??
    definition?.i18n?.[language] ??
    definition?.display ??
    frame.predicate.display ??
    frame.predicate.lemma;
}

interface ActionRealizationContext {
  frame: AdviceFrame;
  locale: string;
  thai: boolean;
  label: string;
  amount?: string;
  theme?: string;
  container?: string;
  destination?: string;
  site?: string;
  substance?: string;
  result?: string;
  activity?: string;
  time?: string;
  duration?: string;
  material?: string;
  realizerConfig?: MedicationInstructionActionDefinition["realizerConfig"];
  definition?: ActionDefinition;
}
type ActionRealizer = (context: ActionRealizationContext) => string;
const DEFAULT_ACTION_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.site ?? c.substance;
  return c.thai
    ? `${c.label}${object ?? ""}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` ${c.duration}` : ""}`
    : `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` for ${c.duration}` : ""}`;
};
const SOURCE_FAITHFUL_REALIZER: ActionRealizer = (c) => {
  const sourceIsThai = /[\u0E00-\u0E7F]/.test(c.frame.sourceText);
  if (c.thai === sourceIsThai) {
    const text = c.frame.sourceText.trim();
    return c.thai ? text : (text ? text.charAt(0).toUpperCase() + text.slice(1) : c.label);
  }
  return c.thai ? "ปรับการใช้ตามอาการ" : "Adjust use according to symptoms";
};
const CONTAINER_ACTIVITY_REALIZER: ActionRealizer = (c) => {
  const container = c.container ?? c.theme;
  return c.thai
    ? `${c.label}${container ?? ""}${c.activity ? `ก่อน${c.activity}` : ""}`
    : `${c.label}${container ? ` ${container}` : ""}${c.activity ? ` before ${c.activity}` : ""}`;
};
const THEME_DESTINATION_AMOUNT_REALIZER: ActionRealizer = (c) => c.thai
  ? `${c.label}${c.theme ?? ""}${c.destination ? `ลง${c.destination}` : ""}${c.amount ? ` ${c.amount}` : ""}`
  : `${c.label}${c.theme ? ` ${c.theme}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.destination ? ` into ${c.destination}` : ""}`;
const MIX_SUBSTANCE_REALIZER: ActionRealizer = (c) => {
  const themeArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Theme);
  const substanceArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Substance);
  const theme = themeArg ? translatedArgumentConcept(themeArg, c.locale) : undefined;
  const substance = substanceArg ? translatedArgumentConcept(substanceArg, c.locale) : c.substance;
  const themeAmount = themeArg?.quantity ? translatedQuantity(themeArg.quantity, c.locale) : undefined;
  const amountArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Amount);
  const substanceAmount = substanceArg?.quantity
    ? translatedQuantity(substanceArg.quantity, c.locale)
    : c.amount;
  if (c.thai) {
    const themeText = theme ? `${theme}${themeAmount ? ` ${themeAmount}` : ""}` : "";
    const amountSeparator = substanceArg?.quantity ? " " : amountArg?.conceptId ? "" : " ";
    const substanceText = substance
      ? `${themeText ? "กับ" : ""}${substance}${substanceAmount ? `${amountSeparator}${substanceAmount}` : ""}`
      : "";
    return `${c.label}${themeText}${substanceText}`;
  }
  const themeText = theme
    ? ` ${themeAmount ? `${themeAmount} of ` : ""}${theme}`
    : "";
  const substanceAmountText = substanceAmount
    ? `${substanceAmount}${amountArg?.conceptId && !substanceArg?.quantity ? " of " : " "}`
    : "";
  const substanceText = substance
    ? ` with ${substanceAmountText}${substance}`
    : "";
  return `${c.label}${themeText}${substanceText}`;
};
const RESULT_REALIZER: ActionRealizer = (c) => c.thai
  ? `${c.label}${c.result ? `ให้เกิด${c.result}` : ""}`
  : `${c.label}${c.result ? ` to form ${c.result}` : ""}`;
const SITE_RELATION_REALIZER: ActionRealizer = (c) => {
  const relationTarget = c.time ?? c.activity;
  if (relationTarget) {
    const target = c.site ? (c.thai ? c.site : ` ${c.site}`) : "";
    const relationText = c.frame.relation === AdviceRelation.Before ? (c.thai ? "ก่อน" : "before")
      : c.frame.relation === AdviceRelation.After ? (c.thai ? "หลัง" : "after")
      : c.frame.relation === AdviceRelation.On ? (c.thai ? "เมื่อ" : "on")
      : (c.thai ? "ใน" : "in");
    return c.thai
      ? `${c.label}${target}${relationText}${relationTarget}`
      : `${c.label}${target} ${relationText} ${relationTarget}`;
  }
  const resultSuffix = c.result
    ? (c.thai ? `ให้${c.result}` : ` until ${c.result}`)
    : "";
  if (c.site) return c.thai
    ? `${c.label}${c.site}${c.substance ? `ด้วย${c.substance}` : ""}${resultSuffix}`
    : `${c.label} ${c.site}${c.substance ? ` with ${c.substance}` : ""}${resultSuffix}`;
  return c.thai
    ? `${c.label}${c.substance ? `ด้วย${c.substance}` : ""}${resultSuffix}`
    : `${c.label}${c.substance ? ` with ${c.substance}` : ""}${resultSuffix}`;
};
const OBJECT_AMOUNT_MATERIAL_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.container;
  return c.thai
    ? `${c.label}${object ?? ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? `ด้วย${c.material}` : ""}`
    : `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` with ${c.material}` : ""}`;
};
const PRIME_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.container;
  const fallback = c.realizerConfig?.thaiFallbackObject ?? "";
  return c.thai
    ? `${c.label}${object ?? fallback}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`
    : `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` with ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`;
};
const AMOUNT_DURATION_REALIZER: ActionRealizer = (c) => c.thai
  ? `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` นาน ${c.duration}` : ""}`
  : `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` for ${c.duration}` : ""}`;
const OBJECT_DURATION_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.site;
  return c.thai
    ? `${c.label}${object ?? ""}${c.duration ? ` ${c.duration}` : ""}`
    : `${c.label}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""}`;
};
const OBJECT_TIME_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.site;
  if (c.thai) return `${c.label}${object ?? ""}${c.time ?? ""}`;
  return `${c.label}${object ? ` ${object}` : ""}${c.time ? ` in ${c.time}` : ""}`;
};
const SEPARABLE_OBJECT_RELATION_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.site;
  const alias = c.definition?.separableAliases?.find((candidate) =>
    c.thai ? /[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle) : !/[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle)
  );
  if (!alias) return RELATION_DURATION_REALIZER(c);
  const target = c.duration ?? c.time ?? c.activity;
  const relationText = c.frame.relation === AdviceRelation.Before
    ? (c.thai ? "ก่อน" : " before ")
    : c.frame.relation === AdviceRelation.After
      ? (c.thai ? "หลัง" : " after ")
      : "";
  return c.thai
    ? `${alias.lead}${object ?? ""}${alias.particle}${target ? `${relationText}${target}` : ""}`
    : `${alias.lead}${object ? ` ${object}` : ""} ${alias.particle}${target ? `${relationText}${target}` : ""}`;
};
const RELATION_DURATION_REALIZER: ActionRealizer = (c) => {
  const object = c.theme ?? c.site;
  const target = c.duration ?? c.time ?? c.activity;
  if (target && c.frame.relation === AdviceRelation.After) return c.thai
    ? `${c.label}${object ?? ""}หลัง${target}`
    : `${c.label}${object ? ` ${object}` : ""} after ${target}`;
  if (target && c.frame.relation === AdviceRelation.Before) return c.thai
    ? `${c.label}${object ?? ""}ก่อน${target}`
    : `${c.label}${object ? ` ${object}` : ""} before ${target}`;
  return c.thai ? `${c.label}${object ?? ""}` : `${c.label}${object ? ` ${object}` : ""}`;
};
const LEAVE_DURATION_REALIZER: ActionRealizer = (c) => c.thai
  ? `${c.label}${c.duration ? ` ${c.duration}` : ""}`
  : `${c.label} on${c.duration ? ` for ${c.duration}` : ""}`;
const DURATION_REALIZER: ActionRealizer = (c) => `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
const ACTIVITY_REALIZER: ActionRealizer = (c) => {
  const activityArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Activity);
  const suppressThaiActivity = Boolean(
    c.thai && activityArg?.conceptId &&
    c.realizerConfig?.thaiSuppressActivityConcepts?.indexOf(activityArg.conceptId) !== -1
  );
  if (c.thai) return suppressThaiActivity || !c.activity ? c.label : `${c.label}${c.activity}`;
  return `${c.label}${c.activity ? ` ${c.activity}` : ""}`;
};
const THAI_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "ไม่ควร",
  [AdviceModality.Must]: "ห้าม"
};
const ENGLISH_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "Should not ",
  [AdviceModality.Must]: "Must not "
};

function negatedActionPrefix(frame: AdviceFrame, thai: boolean): string {
  if (thai) return (frame.modality && THAI_NEGATED_MODALITY_PREFIX[frame.modality]) ?? "ห้าม";
  return (frame.modality && ENGLISH_NEGATED_MODALITY_PREFIX[frame.modality]) ?? "Do not ";
}

const THAI_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "อาจ",
  [AdviceModality.Can]: "สามารถ",
  [AdviceModality.Might]: "อาจ",
  [AdviceModality.Could]: "อาจ",
  [AdviceModality.Should]: "ควร",
  [AdviceModality.Must]: "ต้อง"
};
const ENGLISH_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "May ",
  [AdviceModality.Can]: "Can ",
  [AdviceModality.Might]: "Might ",
  [AdviceModality.Could]: "Could ",
  [AdviceModality.Should]: "Should ",
  [AdviceModality.Must]: "Must "
};

function applyPositiveActionModality(text: string, frame: AdviceFrame, thai: boolean): string {
  if (!frame.modality) return text;
  const prefix = thai
    ? THAI_POSITIVE_MODALITY_PREFIX[frame.modality]
    : ENGLISH_POSITIVE_MODALITY_PREFIX[frame.modality];
  if (!prefix) return text;
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (text.trim().toLowerCase().startsWith(normalizedPrefix)) return text;
  return `${prefix}${thai ? text : text.charAt(0).toLowerCase() + text.slice(1)}`;
}

const ACTION_REALIZERS: Record<MedicationInstructionActionRealizer, ActionRealizer> = {
  default: DEFAULT_ACTION_REALIZER,
  "source-faithful": SOURCE_FAITHFUL_REALIZER,
  "container-activity": CONTAINER_ACTIVITY_REALIZER,
  "theme-destination-amount": THEME_DESTINATION_AMOUNT_REALIZER,
  "mix-substance": MIX_SUBSTANCE_REALIZER,
  result: RESULT_REALIZER,
  "site-relation": SITE_RELATION_REALIZER,
  "object-amount-material": OBJECT_AMOUNT_MATERIAL_REALIZER,
  prime: PRIME_REALIZER,
  "amount-duration": AMOUNT_DURATION_REALIZER,
  "object-duration": OBJECT_DURATION_REALIZER,
  "object-time": OBJECT_TIME_REALIZER,
  "separable-object-relation": SEPARABLE_OBJECT_RELATION_REALIZER,
  "relation-duration": RELATION_DURATION_REALIZER,
  "leave-duration": LEAVE_DURATION_REALIZER,
  duration: DURATION_REALIZER,
  activity: ACTIVITY_REALIZER
};

function realizeAction(frame: AdviceFrame, locale: string, roundtripSafe = false): string {
  const thai = locale.toLowerCase().startsWith("th");
  const first = (role: AdviceArgumentRole): string | undefined => {
    const arg = frame.args.filter((candidate) => candidate.role === role).slice(0, 1)[0];
    return arg ? translatedArgument(arg, locale) : undefined;
  };
  const label = actionLabel(frame, locale, roundtripSafe);
  const amount = first(AdviceArgumentRole.Amount);
  const theme = first(AdviceArgumentRole.Theme) ?? first(AdviceArgumentRole.Object);
  const container = first(AdviceArgumentRole.Container);
  const destination = first(AdviceArgumentRole.Destination);
  const site = first(AdviceArgumentRole.Site);
  const substance = first(AdviceArgumentRole.Substance);
  const result = first(AdviceArgumentRole.Result);
  const activity = first(AdviceArgumentRole.Activity);
  const timeArg = frame.args.find((arg) => arg.role === AdviceArgumentRole.Time);
  const time = timeArg
    ? (thai && /[\u0E00-\u0E7F]/u.test(timeArg.text) ? timeArg.text : translatedArgument(timeArg, locale))
    : undefined;
  const duration = first(AdviceArgumentRole.Duration);
  const material = first(AdviceArgumentRole.Material);

  if (frame.polarity === AdvicePolarity.Negate) {
    const object = site ?? theme ?? substance ?? material;
    const relationTarget = activity ?? time;
    const prefix = negatedActionPrefix(frame, thai);
    if (relationTarget && (
      frame.relation === AdviceRelation.Before ||
      frame.relation === AdviceRelation.After ||
      frame.relation === AdviceRelation.With
    )) {
      const relationText = frame.relation === AdviceRelation.Before
        ? (thai ? "ก่อน" : "before")
        : frame.relation === AdviceRelation.After
          ? (thai ? "หลัง" : "after")
          : (thai ? "พร้อม" : "with");
      return thai
        ? `${prefix}${label}${object ?? ""}${relationText}${relationTarget}`
        : `${prefix}${label.toLowerCase()}${object ? ` ${object}` : ""} ${relationText} ${relationTarget}`;
    }
    const fallbackObject = object ?? relationTarget;
    return thai
      ? `${prefix}${label}${fallbackObject ?? ""}`
      : `${prefix}${label.toLowerCase()}${fallbackObject ? ` ${fallbackObject}` : ""}`;
  }

  const definition = getMedicationInstructionAction(frame.predicate.lemma);
  const realizerKey = frame.predicate.realizer ?? definition?.realizer ?? "default";
  const realizer = ACTION_REALIZERS[realizerKey] ?? DEFAULT_ACTION_REALIZER;
  const realized = realizer({
    frame, locale, thai, label, amount, theme, container, destination, site,
    substance, result, activity, time, duration, material,
    realizerConfig: frame.predicate.realizerConfig ?? definition?.realizerConfig,
    definition
  });
  return applyPositiveActionModality(realized, frame, thai);
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
    arg.quantity.unit === dose.unit;
}

function siteArgumentCoveredByClause(arg: AdviceArgument, clause: CanonicalSigClause): boolean {
  if (arg.role !== AdviceArgumentRole.Site || !clause.site) return false;
  if (codingEquivalent(arg.coding, clause.site.coding)) return true;
  const left = normalizeActionSurface(arg.normalized ?? arg.text);
  const right = normalizeActionSurface(clause.site.text ?? "");
  return Boolean(left && right && left === right);
}

function actionMatchesCanonicalMethod(frame: AdviceFrame, clause: CanonicalSigClause): boolean {
  const method = clause.method;
  if (!method) return false;
  if (method.coding?.code && frame.predicate.codings?.some((coding) => codingEquivalent(coding, method.coding))) {
    return true;
  }
  const methodText = normalizeActionSurface(method.text ?? "");
  if (!methodText) return false;
  const definition = getMedicationInstructionAction(frame.predicate.lemma);
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

function timeArgumentCoveredBySchedule(
  frame: AdviceFrame,
  arg: AdviceArgument,
  clause: CanonicalSigClause
): boolean {
  if (arg.role !== AdviceArgumentRole.Time || !arg.normalized || !clause.schedule?.when?.length) {
    return false;
  }
  const timing = arg.normalized as EventTiming;
  if (clause.schedule.when.indexOf(timing) >= 0) return true;
  const relation = frame.relation === AdviceRelation.Before ? "before"
    : frame.relation === AdviceRelation.After ? "after"
    : frame.relation === AdviceRelation.With ? "with"
    : undefined;
  const related = relation ? MEAL_TIMING_BY_RELATION.get(relation)?.get(timing) : undefined;
  return Boolean(related && clause.schedule.when.indexOf(related) >= 0);
}

function primaryActionCoveredByCanonicalClause(
  frame: AdviceFrame,
  actions: readonly AdviceFrame[],
  clause: CanonicalSigClause
): boolean {
  if (!actionMatchesCanonicalMethod(frame, clause)) return false;
  const matching = actions
    .filter((candidate) => candidate.polarity !== AdvicePolarity.Negate && actionMatchesCanonicalMethod(candidate, clause))
    .slice()
    .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  if (!matching.length || matching[0] !== frame) return false;
  return frame.args.every((arg) =>
    (arg.role === AdviceArgumentRole.Site && siteArgumentCoveredByClause(arg, clause)) ||
    (arg.role === AdviceArgumentRole.Amount && quantityCoveredByDose(arg, clause.dose)) ||
    timeArgumentCoveredBySchedule(frame, arg, clause) ||
    argumentCoveredByCanonicalText(arg, clause) ||
    freeArgumentCoveredByCanonicalAdministration(arg, clause)
  );
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

export function realizeInstructionGraph(
  graph: CanonicalInstructionGraph,
  locale = graph.sourceLocale ?? "en",
  options?: {
    includeWarnings?: boolean;
    onlyWarnings?: boolean;
    omitCanonicalAdministration?: CanonicalSigClause;
    /** Prefer each understood action's exact source wording when source and target locales match. */
    preferSourceText?: boolean;
    /** Source phrases already rendered through another semantic channel. */
    omitSourceTexts?: readonly string[];
    /** Restrict realization around the canonical primary administration source span. */
    position?: "all" | "pre" | "post";
    /** Prefer deliberately unambiguous lexical labels when generating parse-safe text. */
    roundtripSafe?: boolean;
  }
): string | undefined {
  const omittedSources = (options?.omitSourceTexts ?? [])
    .map(normalizedInstructionSurface)
    .filter(Boolean);
  const position = options?.position ?? "all";
  const primary = graph.primaryAdministrationSpan;
  const inRequestedPosition = (start: number, end: number): boolean => {
    if (!primary || position === "all") return true;
    if (position === "pre") return end <= primary.start;
    return start >= primary.start;
  };
  const frames = graph.actions.filter((frame) => {
    if (!inRequestedPosition(frame.span.start, frame.span.end)) return false;
    const frameSource = normalizedInstructionSurface(frame.sourceText);
    if (frameSource && omittedSources.some((candidate) =>
      candidate === frameSource || candidate.includes(frameSource) || frameSource.includes(candidate)
    )) return false;
    if (options?.omitCanonicalAdministration &&
      primaryActionCoveredByCanonicalClause(frame, graph.actions, options.omitCanonicalAdministration)) {
      return false;
    }
    const warning = frame.polarity === AdvicePolarity.Negate;
    if (options?.onlyWarnings) return warning;
    return options?.includeWarnings !== false || !warning;
  });
  const thai = locale.toLowerCase().startsWith("th");
  const nodes: Array<{
    start: number;
    end: number;
    text: string;
    understood: boolean;
    actionIndex?: number;
    conditionTargetActionIndex?: number;
    warning?: boolean;
  }> = [];
  const targetLanguage = locale.toLowerCase().startsWith("th") ? "th" : "en";
  const sourceLanguage = (graph.sourceLocale ?? "en").toLowerCase().startsWith("th") ? "th" : "en";
  for (const frame of frames) {
    const definition = getMedicationInstructionAction(frame.predicate.lemma);
    const secondaryAdministration = Boolean(
      definition?.administrationMethod?.code &&
      graph.primaryAdministrationSpan &&
      (frame.span.end <= graph.primaryAdministrationSpan.start ||
       frame.span.start >= graph.primaryAdministrationSpan.end)
    );
    const sourceFaithful = (
      options?.preferSourceText || secondaryAdministration ||
      frame.polarity === AdvicePolarity.Negate
    ) && targetLanguage === sourceLanguage && sourceTextCoversFrameMeaning(frame)
      ? trimSemanticText(frame.sourceText)
      : undefined;
    const text = sourceFaithful || realizeAction(frame, locale, options?.roundtripSafe === true);
    if (text) {
      nodes.push({
        start: frame.span.start,
        end: frame.span.end,
        text,
        understood: true,
        actionIndex: frame.sequenceIndex,
        warning: frame.force === AdviceForce.Warning || frame.force === AdviceForce.Caution ||
          frame.polarity === AdvicePolarity.Negate
      });
    }
  }
  const selectedActionIndices = new Set(frames.map((frame) => frame.sequenceIndex));
  for (const relation of graph.relations ?? []) {
    if (relation.fromActionIndex !== undefined || relation.toActionIndex === undefined) continue;
    if (!selectedActionIndices.has(relation.toActionIndex)) continue;
    if (!relation.text || !relation.span || !inRequestedPosition(relation.span.start, relation.span.end)) continue;
    const target = frames.find((frame) => frame.sequenceIndex === relation.toActionIndex);
    if (!target) continue;
    const normalizedRelation = normalizedInstructionSurface(relation.text);
    const representedByTarget = target.args.some((arg) => {
      const argSurface = normalizedInstructionSurface(arg.text ?? arg.normalized ?? "");
      return Boolean(
        normalizedRelation && argSurface &&
        (normalizedRelation.includes(argSurface) || argSurface.includes(normalizedRelation))
      );
    });
    if (representedByTarget) continue;
    const relationText = trimSemanticText(relation.text);
    if (relationText) {
      nodes.push({
        start: relation.span.start,
        end: relation.span.end,
        text: relationText,
        understood: false,
        conditionTargetActionIndex: relation.toActionIndex
      });
    }
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
      if (thai) {
        const target = frames.find((frame) => frame.sequenceIndex === node.actionIndex);
        const imperativeLink = target && !target.modality && target.polarity !== AdvicePolarity.Negate
          ? "ให้"
          : "";
        output += `${imperativeLink}${node.text}`;
      } else {
        const lowered = node.text.charAt(0).toLowerCase() + node.text.slice(1);
        output += `, ${lowered}`;
      }
      continue;
    }
    const postposedConditional = Boolean(
      previous?.understood &&
      !node.understood &&
      node.conditionTargetActionIndex === previous.actionIndex
    );
    if (postposedConditional) {
      output += thai ? node.text : ` ${node.text}`;
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
    output += previous?.understood && node.understood && explicitRelation?.kind === AdviceRelation.Then
      ? (thai ? " จากนั้น" : "; then ")
      : "; ";
    output += node.text;
  }
  return output;
}
