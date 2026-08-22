import { resolveBodySitePhrase } from "./body-site-grammar";
import { lexInput } from "./lexer/lex";
import { normalizeUnit } from "./unit-lexicon";
import { EVENT_TIMING_TOKENS, PRODUCT_FORM_HINTS } from "./maps";
import { MEAL_TIMING_BY_RELATION } from "./hpsg/lexical-classes";
import {
  medicationInstructionConceptCodings,
  resolveMedicationInstructionConcept
} from "./instruction-concept-terminology";
import {
  getMedicationInstructionAction,
  medicationInstructionActionCodings,
  normalizeActionSurface,
  resolveMedicationInstructionAction
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
  MedicationInstructionActionDefinition,
  ParseOptions,
  TextRange
} from "./types";

type ActionDefinition = MedicationInstructionActionDefinition;
type Lexeme = ReturnType<typeof lexInput>[number];
const SNOMED_SYSTEM = "http://snomed.info/sct";

const RELATIONS: Readonly<Record<string, AdviceRelation>> = {
  before: AdviceRelation.Before,
  after: AdviceRelation.After,
  for: AdviceRelation.For,
  with: AdviceRelation.With,
  into: AdviceRelation.Into,
  in: AdviceRelation.In,
  on: AdviceRelation.On,
  at: AdviceRelation.On,
  to: AdviceRelation.To,
  if: AdviceRelation.If,
  unless: AdviceRelation.Unless,
  when: AdviceRelation.When,
  while: AdviceRelation.While,
  during: AdviceRelation.During,
  until: AdviceRelation.Until
};

function key(part: Lexeme | undefined): string {
  return part ? (part.canonical ?? part.lower).replace(/^\.+|\.+$/g, "") : "";
}

interface ActionMatch {
  definition: ActionDefinition;
  length: number;
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
  const previous = parts.slice(index - 1, index)[0];
  if (previous && RELATIONS[key(previous)]) return undefined;
  const maxSpan = Math.min(4, parts.length - index);
  for (let length = maxSpan; length >= 1; length -= 1) {
    for (const candidate of actionPhraseCandidates(parts, index, length)) {
      const definition = resolveMedicationInstructionAction(candidate, options);
      if (definition) {
        const first = parts[index];
        if (definition.code === "give" && first && /[\u0E00-\u0E7F]/.test(first.original)) {
          const next = parts[index + length];
          const nextDefinition = next
            ? resolveMedicationInstructionAction(key(next), options)
            : undefined;
          if (nextDefinition) continue;
        }
        return { definition, length };
      }
    }
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
  let event: string | undefined;
  for (let index = start; index < endExclusive; index += 1) {
    const candidate = EVENT_TIMING_TOKENS[key(parts[index])];
    if (candidate) {
      event = candidate;
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
    if (RELATIONS[key(parts.slice(index, index + 1)[0])]) return index;
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
  if (unitKey === "second" || unitKey === "seconds" || unitKey === "sec" || unitKey === "secs") return "s";
  if (unitKey === "minute" || unitKey === "minutes" || unitKey === "min" || unitKey === "mins") return "min";
  if (unitKey === "hour" || unitKey === "hours" || unitKey === "hr" || unitKey === "hrs") return "h";
  if (unitKey === "day" || unitKey === "days") return "d";
  return undefined;
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
  if (lead && ["about", "approximately", "approx", "around"].indexOf(key(lead)) >= 0) {
    cursor += 1;
  }
  const valueToken = parts[cursor];
  if (!valueToken) return undefined;
  const rangeConnector = parts[cursor + 1];
  const rangeHigh = parts[cursor + 2];
  const rangeUnitToken = parts[cursor + 3];
  const separatedRange =
    valueToken.kind === "NUMBER" && valueToken.value !== undefined &&
    rangeConnector && ["to", "through", "ถึง"].indexOf(key(rangeConnector)) >= 0 &&
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
    if (key(parts[index]) !== "for") continue;
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
  const args: AdviceArgument[] = [];
  const argumentStart = actionIndex + actionMatch.length;
  const relIndex = relationIndex(parts, argumentStart, segmentEnd);
  const rawRelation = relIndex >= 0 ? RELATIONS[key(parts.slice(relIndex, relIndex + 1)[0])] : undefined;
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

  switch (definition.code) {
    case "shake": {
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Container, options));
      if (relIndex >= 0) {
        let activityEnd = segmentEnd;
        for (let index = relIndex + 1; index < segmentEnd; index += 1) {
          const current = key(parts[index]);
          if ((current === "and" || current === "or") && index > relIndex + 1) {
            activityEnd = index;
            semanticEnd = index;
            break;
          }
        }
        pushArgument(args, argumentFromParts(parts, relIndex + 1, activityEnd, input, AdviceArgumentRole.Activity, options));
      }
      break;
    }
    case "pour": {
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Theme, options));
      const amountIndex = amount?.span
        ? partIndexForAbsoluteSourceStart(parts, amount.span.start, offset)
        : undefined;
      if (relIndex >= 0) {
        pushArgument(args, argumentFromParts(
          parts,
          relIndex + 1,
          amountIndex !== undefined && amountIndex > relIndex ? amountIndex : segmentEnd,
          input,
          AdviceArgumentRole.Destination,
          options
        ));
      }
      pushArgument(args, amount);
      break;
    }
    case "measure":
    case "draw_up":
    case "prime": {
      pushArgument(args, amount);
      const amountIndex = amount?.span
        ? partIndexForAbsoluteSourceStart(parts, amount.span.start, offset)
        : undefined;
      if (argumentStart < segmentEnd) {
        let objectEnd = amountIndex !== undefined ? amountIndex : segmentEnd;
        if (relIndex >= argumentStart && relIndex < objectEnd) objectEnd = relIndex;
        if (objectEnd > argumentStart) {
          pushArgument(args, argumentFromParts(parts, argumentStart, objectEnd, input, AdviceArgumentRole.Object, options));
        }
      }
      const tailStart = amountIndex !== undefined
        ? Math.min(segmentEnd, amountIndex + 2)
        : relIndex >= 0 ? relIndex + 1 : segmentEnd;
      if (tailStart < segmentEnd) {
        const tail = argumentFromParts(parts, tailStart, segmentEnd, input, AdviceArgumentRole.Material, options);
        if (relation === AdviceRelation.With || tail?.conceptId) pushArgument(args, tail);
      }
      break;
    }
    case "swish":
    case "gargle": {
      pushArgument(args, amount);
      pushArgument(args, duration);
      break;
    }
    case "hold":
    case "keep": {
      const durationIndex = duration?.span
        ? partIndexForAbsoluteSourceStart(parts, duration.span.start, offset)
        : undefined;
      let objectEnd = durationIndex !== undefined ? durationIndex : segmentEnd;
      if (relIndex >= argumentStart && relIndex < objectEnd) objectEnd = relIndex;
      if (objectEnd > argumentStart) {
        pushArgument(args, argumentFromParts(parts, argumentStart, objectEnd, input, AdviceArgumentRole.Object, options));
      }
      pushArgument(args, duration);
      break;
    }
    case "mix": {
      const waterIndex = parts.slice(argumentStart, segmentEnd).findIndex((part) => {
        const currentKey = key(part);
        return currentKey === "water" || currentKey === "clean-water";
      });
      if (waterIndex >= 0) {
        const absoluteWater = argumentStart + waterIndex;
        pushArgument(args, argumentFromParts(parts, absoluteWater, absoluteWater + 1, input, AdviceArgumentRole.Substance, options));
        const afterWater = parts.slice(absoluteWater + 1, segmentEnd).find((part) => {
          const currentKey = key(part);
          return currentKey === "small" || currentKey === "small_amount";
        });
        if (afterWater) pushArgument(args, internalArgument("small", afterWater.sourceText ?? afterWater.original, options));
      } else pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      break;
    }
    case "rub": {
      const resultPart = parts.slice(argumentStart, segmentEnd).find((part) => {
        const currentKey = key(part);
        return currentKey === "foam" || currentKey === "foam-result";
      });
      if (resultPart) pushArgument(args, internalArgument("foam-result", resultPart.sourceText ?? resultPart.original, options));
      else pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      break;
    }
    case "clean":
      pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, AdviceArgumentRole.Site, options));
      break;
    case "rinse":
    case "wash": {
      if (relIndex > argumentStart) {
        const localTarget = argumentFromParts(
          parts,
          argumentStart,
          relIndex,
          input,
          AdviceArgumentRole.Site,
          options
        );
        if (localTarget?.coding?.code || localTarget?.conceptId) pushArgument(args, localTarget);
        else pushArgument(args, argumentFromParts(parts, argumentStart, relIndex, input, undefined, options));
      }
      if (relIndex >= 0) {
        pushArgument(args, argumentFromParts(
          parts,
          relIndex + 1,
          segmentEnd,
          input,
          preferredRinseRole(relation),
          options
        ));
      } else {
        pushArgument(args, argumentFromParts(
          parts, argumentStart, segmentEnd, input, preferredRinseRole(relation), options
        ));
      }
      break;
    }
    case "leave": {
      const leaveDuration = parseDurationArgument(parts, argumentStart, segmentEnd, input, offset) ?? duration;
      pushArgument(args, leaveDuration);
      if (!leaveDuration) {
        pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      }
      break;
    }
    case "wait": {
      const waitDuration = parseBareDurationArgument(parts, argumentStart, segmentEnd, input, offset) ?? duration;
      pushArgument(args, waitDuration);
      if (!waitDuration) {
        pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      }
      break;
    }
    case "stop": {
      const matchedSurface = sourceFor(parts, actionIndex, argumentStart, input);
      if (/\buse\b/i.test(matchedSurface) || /ใช้/u.test(matchedSurface)) {
        pushArgument(args, internalArgument("use", matchedSurface, options));
      } else {
        pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, AdviceArgumentRole.Activity, options));
      }
      break;
    }
    case "douche":
      pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, AdviceArgumentRole.Site, options));
      break;
    default:
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, undefined, options));
      if (relation === AdviceRelation.For && duration) {
        pushArgument(args, duration);
      } else if (relIndex >= 0 && !conditionalTail) {
        const time = (
          relation === AdviceRelation.In ||
          relation === AdviceRelation.On ||
          relation === AdviceRelation.Before ||
          relation === AdviceRelation.After
        ) ? timeArgumentFromParts(parts, relIndex + 1, relationTargetEnd, input) : undefined;
        const fallbackRole = relation === AdviceRelation.Before || relation === AdviceRelation.After
          ? AdviceArgumentRole.Activity
          : undefined;
        pushArgument(
          args,
          time ?? argumentFromParts(
            parts,
            relIndex + 1,
            relationTargetEnd,
            input,
            fallbackRole,
            options
          )
        );
      }
      break;
  }

  pushArgument(args, amount);

  const codings = medicationInstructionActionCodings(definition);
  if (definition.code === "douche" && args.some((arg) => arg.coding?.code === "76784001" || arg.normalized === "vagina")) {
    codings.push({ system: SNOMED_SYSTEM, code: "21397001", display: "Douche of vagina" });
  }
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

interface ActionDirectivePrefix {
  parts: readonly string[];
  polarity?: AdvicePolarity;
  modality?: AdviceModality;
}

const ACTION_DIRECTIVE_PREFIXES: readonly ActionDirectivePrefix[] = [
  { parts: ["do", "not"], polarity: AdvicePolarity.Negate },
  { parts: ["should", "not"], polarity: AdvicePolarity.Negate, modality: AdviceModality.Should },
  { parts: ["must", "not"], polarity: AdvicePolarity.Negate, modality: AdviceModality.Must },
  { parts: ["should-not"], polarity: AdvicePolarity.Negate, modality: AdviceModality.Should },
  { parts: ["don't"], polarity: AdvicePolarity.Negate },
  { parts: ["dont"], polarity: AdvicePolarity.Negate },
  { parts: ["avoid"], polarity: AdvicePolarity.Negate },
  { parts: ["should"], modality: AdviceModality.Should },
  { parts: ["must"], modality: AdviceModality.Must }
];

function directivePrefixMatches(parts: Lexeme[], index: number, prefix: ActionDirectivePrefix): boolean {
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
  current: ActionDefinition | undefined
): boolean {
  if (!current) return false;
  const candidate = key(parts[index]);
  if (candidate === "spray") {
    if (current.code === "aim") return true;
    if (current.code === "prime") {
      const previous = key(parts[index - 1]);
      const previousPart = parts[index - 1];
      return previous === "nasal" || previous === "inhaler" || previous === "device" ||
        previousPart?.kind === "NUMBER" || previousPart?.kind === "NUMBER_RANGE";
    }
  }
  if (candidate === "use") {
    for (let cursor = Math.max(0, index - 3); cursor < index; cursor += 1) {
      const relation = key(parts[cursor]);
      if (relation === "before" || relation === "after") return true;
    }
  }
  if (candidate === "rinse" && current.code === "swallow" && key(parts[index + 1]) === "water") {
    return true;
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
  const relation = RELATIONS[key(parts[cursor])];
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
      if (currentKey === "then") {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = previousKey === "and" ? index - 1 : index;
        break;
      }
      if (ACTION_DIRECTIVE_BOUNDARIES.has(currentKey) && !prefixedActionAt(parts, index, options)) {
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
        !actionCandidateBelongsToCurrentFrame(parts, index, startingMatch?.definition)
      ) {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = previousKey === "and" || previousKey === "or" ? index - 1 : index;
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
    if (key(parts.slice(cursor, cursor + 1)[0]) === "then") cursor += 1;
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
  if (structural === "then" || structural === "and then" || structural === "and" || structural === "จากนั้น" || structural === "และ") {
    return false;
  }
  const tokens = lexInput(trimmed).map((token) => key(token)).filter(Boolean);
  if (tokens.length && tokens.every((token) => token === "then" || token === "and")) {
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
    const relation = RELATIONS[candidate];
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
    if (candidate === "then" || candidate === "and") return AdviceRelation.Then;
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
  opaqueSpans: CanonicalSourceSpan[]
): CanonicalInstructionCoverage {
  const understoodCharacters = mergedSpanLength(actions.map((action) => action.span));
  const opaqueCharacters = mergedSpanLength(opaqueSpans.map((span) => ({ start: span.start, end: span.end })));
  const total = understoodCharacters + opaqueCharacters;
  return {
    understoodCharacters,
    opaqueCharacters,
    ratio: total > 0 ? Math.round((understoodCharacters / total) * 10000) / 10000 : 0,
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
  graph.coverage = buildInstructionCoverage(graph.actions, opaqueSpans);
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

function translatedArgument(arg: AdviceArgument, locale: string): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  if (arg.quantity) {
    const singular = arg.quantity.value === 1 && !arg.quantity.range;
    const unit = arg.quantity.unit === "mL"
      ? (language === "th" ? "มิลลิลิตร" : "mL")
      : arg.quantity.unit === "min"
        ? (language === "th" ? "นาที" : (singular ? "minute" : "minutes"))
        : arg.quantity.unit === "s"
          ? (language === "th" ? "วินาที" : (singular ? "second" : "seconds"))
        : arg.quantity.unit === "h"
          ? (language === "th" ? "ชั่วโมง" : (singular ? "hour" : "hours"))
          : arg.quantity.unit === "d"
            ? (language === "th" ? "วัน" : (singular ? "day" : "days"))
            : arg.quantity.unit === "spray"
              ? (language === "th" ? "พ่น" : (singular ? "spray" : "sprays"))
              : (arg.quantity.unit ?? "");
    if (arg.quantity.range) {
      return `${arg.quantity.range.low ?? ""}-${arg.quantity.range.high ?? ""} ${unit}`.trim();
    }
    return `${arg.quantity.value ?? ""} ${unit}`.trim();
  }
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
  const time = first(AdviceArgumentRole.Time);
  const duration = first(AdviceArgumentRole.Duration);
  const material = first(AdviceArgumentRole.Material);

  if (frame.polarity === AdvicePolarity.Negate) {
    const object = site ?? theme ?? substance ?? material;
    const relationTarget = activity ?? time;
    if (relationTarget && (frame.relation === AdviceRelation.Before || frame.relation === AdviceRelation.After)) {
      const relationText = frame.relation === AdviceRelation.Before
        ? (thai ? "ก่อน" : "before")
        : (thai ? "หลัง" : "after");
      return thai
        ? `ห้าม${label}${object ?? ""}${relationText}${relationTarget}`
        : `Do not ${label.toLowerCase()}${object ? ` ${object}` : ""} ${relationText} ${relationTarget}`;
    }
    const fallbackObject = object ?? relationTarget;
    return thai
      ? `ห้าม${label}${fallbackObject ?? ""}`
      : `Do not ${label.toLowerCase()}${fallbackObject ? ` ${fallbackObject}` : ""}`;
  }

  switch (frame.predicate.lemma) {
    case "adjust": {
      const sourceIsThai = /[\u0E00-\u0E7F]/.test(frame.sourceText);
      if (thai && sourceIsThai) return frame.sourceText;
      if (!thai && !sourceIsThai) {
        const text = frame.sourceText.trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : label;
      }
      return thai ? "ปรับการใช้ตามอาการ" : "Adjust use according to symptoms";
    }
    case "shake":
      return thai
        ? `${label}${container ?? ""}${activity ? `ก่อน${activity}` : ""}`
        : `${label}${container ? ` ${container}` : ""}${activity ? ` before ${activity}` : ""}`;
    case "pour":
      return thai
        ? `${label}${theme ?? ""}${destination ? `ลง${destination}` : ""}${amount ? ` ${amount}` : ""}`
        : `${label}${theme ? ` ${theme}` : ""}${amount ? ` ${amount}` : ""}${destination ? ` into ${destination}` : ""}`;
    case "mix": {
      const mixAmount = first(AdviceArgumentRole.Amount);
      return thai
        ? `${label}${substance ?? theme ?? ""}${mixAmount ?? ""}`
        : `${label}${substance ? ` with ${mixAmount ? `${mixAmount} of ` : ""}${substance}` : theme ? ` ${theme}` : ""}`;
    }
    case "rub":
      return thai ? `${label}${result ? `ให้เกิด${result}` : ""}` : `${label}${result ? ` to form ${result}` : ""}`;
    case "clean":
      return thai ? `${label}${site ?? theme ?? ""}` : `${label}${site ? ` ${site}` : theme ? ` ${theme}` : ""}`;
    case "rinse":
    case "wash": {
      const relationTarget = time ?? activity;
      if (relationTarget) {
        const target = site ? (thai ? `${site}` : ` ${site}`) : "";
        const relationText = frame.relation === AdviceRelation.Before ? (thai ? "ก่อน" : "before")
          : frame.relation === AdviceRelation.After ? (thai ? "หลัง" : "after")
          : frame.relation === AdviceRelation.On ? (thai ? "เมื่อ" : "on")
          : (thai ? "ใน" : "in");
        return thai
          ? `${label}${target}${relationText}${relationTarget}`
          : `${label}${target} ${relationText} ${relationTarget}`;
      }
      if (site) {
        if (thai) return `${label}${site}${substance ? `ด้วย${substance}` : ""}`;
        return `${label} ${site}${substance ? ` with ${substance}` : ""}`;
      }
      return thai ? `${label}${substance ? `ด้วย${substance}` : ""}` : `${label}${substance ? ` with ${substance}` : ""}`;
    }
    case "measure":
    case "draw_up": {
      const object = theme ?? first(AdviceArgumentRole.Object) ?? container;
      if (thai) {
        return `${label}${object ?? ""}${amount ? ` ${amount}` : ""}${material ? `ด้วย${material}` : ""}`;
      }
      return `${label}${object ? ` ${object}` : ""}${amount ? ` ${amount}` : ""}${material ? ` with ${material}` : ""}`;
    }
    case "prime": {
      const object = theme ?? first(AdviceArgumentRole.Object) ?? container;
      if (thai) {
        return `${label}${object ?? "อุปกรณ์พ่น"}${amount ? ` ${amount}` : ""}${material ? ` ${material}` : ""}`;
      }
      return `${label}${object ? ` ${object}` : ""}${amount ? ` with ${amount}` : ""}${material ? ` ${material}` : ""}`;
    }
    case "swish":
    case "gargle":
      return thai
        ? `${label}${amount ? ` ${amount}` : ""}${duration ? ` นาน ${duration}` : ""}`
        : `${label}${amount ? ` ${amount}` : ""}${duration ? ` for ${duration}` : ""}`;
    case "hold":
    case "keep":
    case "press": {
      const object = theme ?? site ?? first(AdviceArgumentRole.Object);
      return thai
        ? `${label}${object ?? ""}${duration ? ` ${duration}` : ""}`
        : `${label}${object ? ` ${object}` : ""}${duration ? ` for ${duration}` : ""}`;
    }
    case "discard":
    case "remove": {
      const object = theme ?? site ?? first(AdviceArgumentRole.Object);
      if (duration && frame.relation === AdviceRelation.After) {
        return thai
          ? `${label}${object ?? ""}หลัง ${duration}`
          : `${label}${object ? ` ${object}` : ""} after ${duration}`;
      }
      if (duration && frame.relation === AdviceRelation.Before) {
        return thai
          ? `${label}${object ?? ""}ก่อน ${duration}`
          : `${label}${object ? ` ${object}` : ""} before ${duration}`;
      }
      return thai ? `${label}${object ?? ""}` : `${label}${object ? ` ${object}` : ""}`;
    }
    case "leave": {
      const duration = first(AdviceArgumentRole.Duration);
      if (thai) return `${label}${duration ? ` ${duration}` : ""}`;
      return `${label} on${duration ? ` for ${duration}` : ""}`;
    }
    case "wait": {
      const duration = first(AdviceArgumentRole.Duration);
      return `${label}${duration ? ` ${duration}` : ""}`;
    }
    case "stop": {
      const activity = first(AdviceArgumentRole.Activity);
      if (thai) return activity === "ใช้" || !activity ? label : `${label}${activity}`;
      return `${label}${activity ? ` ${activity}` : ""}`;
    }
    default: {
      const object = theme ?? site ?? substance ?? first(AdviceArgumentRole.Object);
      if (thai) {
        return `${label}${object ?? ""}${amount ? ` ${amount}` : ""}${duration ? ` ${duration}` : ""}`;
      }
      return `${label}${object ? ` ${object}` : ""}${amount ? ` ${amount}` : ""}${duration ? ` for ${duration}` : ""}`;
    }
  }
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
  return graph.actions.some((action) => {
    const candidate = normalizedInstructionSurface(action.sourceText);
    return Boolean(candidate && (
      candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate)
    ));
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
  }> = [];
  const targetLanguage = locale.toLowerCase().startsWith("th") ? "th" : "en";
  const sourceLanguage = (graph.sourceLocale ?? "en").toLowerCase().startsWith("th") ? "th" : "en";
  for (const frame of frames) {
    const sourceFaithful = options?.preferSourceText &&
      targetLanguage === sourceLanguage &&
      sourceTextCoversFrameMeaning(frame)
      ? trimSemanticText(frame.sourceText)
      : undefined;
    const text = sourceFaithful || realizeAction(frame, locale, options?.roundtripSafe === true);
    if (text) {
      nodes.push({
        start: frame.span.start,
        end: frame.span.end,
        text,
        understood: true,
        actionIndex: frame.sequenceIndex
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
        understood: false
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
        output += node.text;
      } else {
        const lowered = node.text.charAt(0).toLowerCase() + node.text.slice(1);
        output += `, ${lowered}`;
      }
      continue;
    }
    const explicitRelation = previous?.understood && node.understood
      ? graph.relations?.find((relation) =>
          relation.fromActionIndex === previous.actionIndex &&
          relation.toActionIndex === node.actionIndex
        )
      : undefined;
    output += previous?.understood && node.understood && explicitRelation?.kind === AdviceRelation.Then
      ? (thai ? " จากนั้น" : "; then ")
      : "; ";
    output += node.text;
  }
  return output;
}
