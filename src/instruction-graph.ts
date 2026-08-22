import { resolveBodySitePhrase } from "./body-site-grammar";
import { lexInput } from "./lexer/lex";
import { normalizeUnit } from "./unit-lexicon";
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
  const lookupText = text.replace(/^\s*บริเวณ\s*/u, "").trim() || text;
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
    if (preferredRole) direct.role = preferredRole;
    return direct;
  }
  const resolvedSite = codingFromSite(text, options);
  if (resolvedSite) {
    if (preferredRole === AdviceArgumentRole.Destination) resolvedSite.role = AdviceArgumentRole.Destination;
    return resolvedSite;
  }
  for (const currentKey of canonicalParts) {
    const contained = internalArgument(currentKey, text, options);
    if (contained && (
      contained.role === AdviceArgumentRole.Substance ||
      contained.role === AdviceArgumentRole.Result ||
      contained.role === AdviceArgumentRole.Site
    )) {
      if (preferredRole) contained.role = preferredRole;
      return contained;
    }
  }
  return { role: preferredRole ?? AdviceArgumentRole.Object, text, normalized: canonical || text.toLowerCase() };
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
  const relation = relIndex >= 0 ? RELATIONS[key(parts.slice(relIndex, relIndex + 1)[0])] : undefined;
  const amount = definition.acceptsAmount
    ? parseQuantityArgument(parts, argumentStart, segmentEnd, input, offset, options)
    : undefined;
  const duration = parseAnyDurationArgument(parts, argumentStart, segmentEnd, input, offset);
  let semanticEnd = segmentEnd;

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
        const objectEnd = amountIndex !== undefined ? amountIndex : segmentEnd;
        if (objectEnd > argumentStart) {
          pushArgument(args, argumentFromParts(parts, argumentStart, objectEnd, input, AdviceArgumentRole.Object, options));
        }
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
      pushArgument(args, duration);
      if (!duration) {
        pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, AdviceArgumentRole.Object, options));
      }
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
        const afterWater = parts.slice(absoluteWater + 1, segmentEnd).find((part) => key(part) === "small");
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
    case "wash":
      pushArgument(args, argumentFromParts(
        parts,
        relIndex >= 0 ? relIndex + 1 : argumentStart,
        segmentEnd,
        input,
        preferredRinseRole(relation),
        options
      ));
      break;
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
      if (relIndex >= 0) pushArgument(args, argumentFromParts(parts, relIndex + 1, segmentEnd, input, undefined, options));
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

function prefixedActionAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): PrefixedActionMatch | undefined {
  const current = key(parts[index]);
  const next = key(parts[index + 1]);
  const afterNext = key(parts[index + 2]);
  let actionIndex: number | undefined;
  let polarity: AdvicePolarity | undefined;
  let modality: AdviceModality | undefined;

  if (current === "avoid") {
    actionIndex = index + 1;
    polarity = AdvicePolarity.Negate;
  } else if (current === "do" && next === "not") {
    actionIndex = index + 2;
    polarity = AdvicePolarity.Negate;
  } else if (current === "don't" || current === "dont") {
    actionIndex = index + 1;
    polarity = AdvicePolarity.Negate;
  } else if (current === "should-not") {
    actionIndex = index + 1;
    polarity = AdvicePolarity.Negate;
    modality = AdviceModality.Should;
  } else if (current === "should" && next === "not") {
    actionIndex = index + 2;
    polarity = AdvicePolarity.Negate;
    modality = AdviceModality.Should;
  } else if (current === "must" && next === "not") {
    actionIndex = index + 2;
    polarity = AdvicePolarity.Negate;
    modality = AdviceModality.Must;
  } else if (current === "should") {
    actionIndex = index + 1;
    modality = AdviceModality.Should;
  } else if (current === "must" && afterNext !== "not") {
    actionIndex = index + 1;
    modality = AdviceModality.Must;
  }
  if (actionIndex === undefined) return undefined;
  const match = actionMatchAt(parts, actionIndex, options);
  return match ? { actionIndex, match, polarity, modality } : undefined;
}

function negatedActionAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): PrefixedActionMatch | undefined {
  const match = prefixedActionAt(parts, index, options);
  return match?.polarity === AdvicePolarity.Negate ? match : undefined;
}

const ACTION_DIRECTIVE_BOUNDARIES = new Set([
  "avoid", "should-not", "should", "must", "not", "do", "don't", "dont"
]);

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
      if (actionMatchAt(parts, index, options)) {
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
      if (actionMatchAt(parts, index, options)) {
        end = index;
        break;
      }
    }

    const frame = buildActionFrame(parts, start, end, sourceText, baseOffset, sequenceIndex, options);
    if (frame) {
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
    const target = actions.findIndex((action) => action.span.start >= opaque.end);
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

function actionDominatedByCanonicalMethod(
  frame: AdviceFrame,
  clause: CanonicalSigClause,
  options?: ParseOptions
): boolean {
  const method = clause.method;
  if (!method || actionAddsStructuredMeaning(frame)) return false;

  const methodText = normalizeActionSurface(method.text ?? "");
  const definition = frameActionDefinition(frame, options);
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

  const methodSpans: CanonicalSourceSpan[] = [];
  for (const evidence of clause.evidence) {
    if (evidence.rule !== "hpsg.lex.method") continue;
    for (const span of evidence.spans) methodSpans.push(span);
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
  const relations = buildInstructionRelations(graph.sourceText, graph.actions, opaqueSpans);
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

export function buildInstructionGraph(
  input: string,
  clause: CanonicalSigClause,
  options?: ParseOptions
): CanonicalInstructionGraph | undefined {
  const actions: AdviceFrame[] = [];
  const opaqueSpans: CanonicalSourceSpan[] = [];
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
  for (const frame of parseInstructionActions(input, 0, options)) {
    if (frameIsProcedural(frame, options)) pushActionIfUnique(actions, frame);
  }
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actionDominatedByCanonicalMethod(actions[index], clause, options)) {
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
    opaqueSpans: reconciledOpaque.length ? reconciledOpaque : undefined,
    sourceText: input,
    sourceLocale: /[\u0E00-\u0E7F]/.test(input) ? "th" : "en"
  };
  refreshInstructionGraphDerivedState(graph);
  return graph;
}

function translatedArgument(arg: AdviceArgument, locale: string): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  if (arg.quantity) {
    const unit = arg.quantity.unit === "mL"
      ? (language === "th" ? "มิลลิลิตร" : "mL")
      : arg.quantity.unit === "min"
        ? (language === "th" ? "นาที" : "minutes")
        : arg.quantity.unit === "h"
          ? (language === "th" ? "ชั่วโมง" : "hours")
          : arg.quantity.unit === "d"
            ? (language === "th" ? "วัน" : "days")
            : (arg.quantity.unit ?? "");
    if (arg.quantity.range) {
      return `${arg.quantity.range.low ?? ""}-${arg.quantity.range.high ?? ""} ${unit}`.trim();
    }
    return `${arg.quantity.value ?? ""} ${unit}`.trim();
  }
  return arg.i18n?.[language] ?? arg.normalized ?? arg.text;
}

function actionLabel(frame: AdviceFrame, locale: string): string {
  const language = locale.toLowerCase().startsWith("th") ? "th" : "en";
  const definition = getMedicationInstructionAction(frame.predicate.lemma);
  return frame.predicate.i18n?.[language] ??
    (language === "en" ? frame.predicate.display : undefined) ??
    definition?.i18n?.[language] ??
    definition?.display ??
    frame.predicate.display ??
    frame.predicate.lemma;
}

function realizeAction(frame: AdviceFrame, locale: string): string {
  const thai = locale.toLowerCase().startsWith("th");
  const first = (role: AdviceArgumentRole): string | undefined => {
    const arg = frame.args.filter((candidate) => candidate.role === role).slice(0, 1)[0];
    return arg ? translatedArgument(arg, locale) : undefined;
  };
  const label = actionLabel(frame, locale);
  const amount = first(AdviceArgumentRole.Amount);
  const theme = first(AdviceArgumentRole.Theme) ?? first(AdviceArgumentRole.Object);
  const container = first(AdviceArgumentRole.Container);
  const destination = first(AdviceArgumentRole.Destination);
  const site = first(AdviceArgumentRole.Site);
  const substance = first(AdviceArgumentRole.Substance);
  const result = first(AdviceArgumentRole.Result);
  const activity = first(AdviceArgumentRole.Activity);

  if (frame.polarity === AdvicePolarity.Negate) {
    const object = site ?? theme;
    return thai
      ? `ห้าม${label}${object ?? ""}`
      : `Do not ${label.toLowerCase()}${object ? ` ${object}` : ""}`;
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
      const time = first(AdviceArgumentRole.Time);
      if (time) {
        if (thai) return `${label}${time}`;
        const preposition = frame.relation === AdviceRelation.On ? "on" : "in";
        return `${label} ${preposition} ${time}`;
      }
      if (site) {
        if (thai) return `${label}${site}${substance ? `ด้วย${substance}` : ""}`;
        return `${label} ${site}${substance ? ` with ${substance}` : ""}`;
      }
      return thai ? `${label}${substance ? `ด้วย${substance}` : ""}` : `${label}${substance ? ` with ${substance}` : ""}`;
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
      const object = theme ?? site ?? substance;
      return thai ? `${label}${object ?? ""}` : `${label}${object ? ` ${object}` : ""}`;
    }
  }
}

function normalizedInstructionSurface(value: string): string {
  return value.toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
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

export function realizeInstructionGraph(
  graph: CanonicalInstructionGraph,
  locale = graph.sourceLocale ?? "en",
  options?: { includeWarnings?: boolean; onlyWarnings?: boolean }
): string | undefined {
  const frames = graph.actions.filter((frame) => {
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
  for (const frame of frames) {
    const text = realizeAction(frame, locale);
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
  if (!options?.onlyWarnings) {
    for (const opaque of graph.opaqueSpans ?? []) {
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
    output += previous?.understood && node.understood
      ? (thai ? " จากนั้น" : "; then ")
      : "; ";
    output += node.text;
  }
  return output;
}
