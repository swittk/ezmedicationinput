import { resolveBodySitePhrase } from "./body-site-grammar";
import { lexInput } from "./lexer/lex";
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
      if (definition) return { definition, length };
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
  const resolved = resolveBodySitePhrase(text, options?.siteCodeMap, {
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

function argumentFromParts(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  preferredRole: AdviceArgumentRole | undefined,
  options?: ParseOptions
): AdviceArgument | undefined {
  if (endExclusive <= start) return undefined;
  const text = sourceFor(parts, start, endExclusive, input).trim();
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

function parseDurationArgument(
  parts: Lexeme[],
  start: number,
  endExclusive: number,
  input: string,
  offset: number
): AdviceArgument | undefined {
  for (let index = start; index + 2 < endExclusive; index += 1) {
    if (key(parts.slice(index, index + 1)[0]) !== "for") continue;
    const valueToken = parts.slice(index + 1, index + 2)[0];
    const unitToken = parts.slice(index + 2, index + 3)[0];
    if (!valueToken || !unitToken || valueToken.kind !== "NUMBER" || valueToken.value === undefined) continue;
    const unitKey = key(unitToken);
    const unit = unitKey === "minute" || unitKey === "minutes"
      ? "min"
      : unitKey === "hour" || unitKey === "hours"
        ? "h"
        : unitKey === "day" || unitKey === "days"
          ? "d"
          : undefined;
    if (!unit) continue;
    return {
      role: AdviceArgumentRole.Duration,
      text: sourceFor(parts, index + 1, index + 3, input),
      normalized: `${valueToken.value} ${unit}`,
      quantity: { value: valueToken.value, unit },
      span: { start: offset + valueToken.sourceStart, end: offset + unitToken.sourceEnd }
    };
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
  const valueToken = parts.slice(start, start + 1)[0];
  const unitToken = parts.slice(start + 1, start + 2)[0];
  if (!valueToken || !unitToken || start + 1 >= endExclusive || valueToken.kind !== "NUMBER" || valueToken.value === undefined) {
    return undefined;
  }
  const unitKey = key(unitToken);
  const unit = unitKey === "minute" || unitKey === "minutes"
    ? "min"
    : unitKey === "hour" || unitKey === "hours"
      ? "h"
      : unitKey === "day" || unitKey === "days"
        ? "d"
        : undefined;
  if (!unit) return undefined;
  return {
    role: AdviceArgumentRole.Duration,
    text: sourceFor(parts, start, start + 2, input),
    normalized: `${valueToken.value} ${unit}`,
    quantity: { value: valueToken.value, unit },
    span: { start: offset + valueToken.sourceStart, end: offset + unitToken.sourceEnd }
  };
}

function preferredRinseRole(relation: AdviceRelation | undefined): AdviceArgumentRole {
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
  let polarity: AdvicePolarity | undefined;
  const negated = negatedActionAt(parts, segmentStart, options);
  if (negated) {
    polarity = AdvicePolarity.Negate;
    actionIndex = negated.actionIndex;
  }
  const actionMatch = negated?.match ?? actionMatchAt(parts, actionIndex, options);
  if (!actionMatch) return undefined;
  const definition = actionMatch.definition;
  const args: AdviceArgument[] = [];
  const argumentStart = actionIndex + actionMatch.length;
  const relIndex = relationIndex(parts, argumentStart, segmentEnd);
  const relation = relIndex >= 0 ? RELATIONS[key(parts.slice(relIndex, relIndex + 1)[0])] : undefined;

  switch (definition.code) {
    case "shake":
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Container, options));
      if (relIndex >= 0) pushArgument(args, argumentFromParts(parts, relIndex + 1, segmentEnd, input, AdviceArgumentRole.Activity, options));
      break;
    case "pour":
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, AdviceArgumentRole.Theme, options));
      if (relIndex >= 0) pushArgument(args, argumentFromParts(parts, relIndex + 1, segmentEnd, input, AdviceArgumentRole.Destination, options));
      break;
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
      const duration = parseDurationArgument(parts, argumentStart, segmentEnd, input, offset);
      pushArgument(args, duration);
      if (!duration) {
        pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      }
      break;
    }
    case "wait": {
      const duration = parseBareDurationArgument(parts, argumentStart, segmentEnd, input, offset);
      pushArgument(args, duration);
      if (!duration) {
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

  const codings = medicationInstructionActionCodings(definition);
  if (definition.code === "douche" && args.some((arg) => arg.coding?.code === "76784001" || arg.normalized === "vagina")) {
    codings.push({ system: SNOMED_SYSTEM, code: "21397001", display: "Douche of vagina" });
  }
  const span = rangeFor(parts, segmentStart, segmentEnd, offset);
  return {
    force: polarity === AdvicePolarity.Negate ? AdviceForce.Warning : AdviceForce.Sequence,
    polarity,
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

interface NegatedActionMatch {
  actionIndex: number;
  match: ActionMatch;
}

function negatedActionAt(
  parts: Lexeme[],
  index: number,
  options?: ParseOptions
): NegatedActionMatch | undefined {
  const current = key(parts.slice(index, index + 1)[0]);
  const candidates: number[] = [];
  if (current === "avoid") candidates.push(index + 1);
  if (current === "do" && key(parts.slice(index + 1, index + 2)[0]) === "not") candidates.push(index + 2);
  if (current === "don't" || current === "dont") candidates.push(index + 1);
  for (const actionIndex of candidates) {
    const match = actionMatchAt(parts, actionIndex, options);
    if (match) return { actionIndex, match };
  }
  return undefined;
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
      if (negatedActionAt(parts, index, options)) {
        start = index;
        negative = true;
        break;
      }
      if (actionMatchAt(parts, index, options)) {
        start = index;
        break;
      }
    }
    if (start < 0) break;

    const negated = negative ? negatedActionAt(parts, start, options) : undefined;
    const actionStart = negated?.actionIndex ?? start;
    const startingMatch = negated?.match ?? actionMatchAt(parts, actionStart, options);
    let end = parts.length;
    for (let index = actionStart + (startingMatch?.length ?? 1); index < parts.length; index += 1) {
      const currentKey = key(parts.slice(index, index + 1)[0]);
      if (currentKey === "then") {
        const previousKey = key(parts.slice(index - 1, index)[0]);
        end = previousKey === "and" ? index - 1 : index;
        break;
      }
      if (negatedActionAt(parts, index, options)) {
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
        : evidence.rule === "hpsg.lex.instruction"
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
    relations.push({
      kind: relationFromSourceText(source) ?? AdviceRelation.Then,
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
  if (method.coding?.code && frame.predicate.codings?.some((coding) =>
    coding.code === method.coding?.code &&
    (coding.system ?? "http://snomed.info/sct") ===
      (method.coding?.system ?? "http://snomed.info/sct")
  )) {
    return true;
  }
  const methodText = normalizeActionSurface(method.text ?? "");
  if (!methodText) return false;
  const definition = frameActionDefinition(frame, options);
  const candidates = [
    frame.predicate.lemma,
    frame.predicate.display ?? "",
    definition?.display ?? "",
    ...(definition?.aliases ?? [])
  ]
    .map(normalizeActionSurface)
    .filter((candidate) => candidate.length > 0);
  return candidates.some((candidate) =>
    methodText === candidate ||
    methodText.startsWith(`${candidate} `) ||
    methodText.endsWith(` ${candidate}`) ||
    methodText.includes(` ${candidate} `)
  );
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
  actions.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  for (let index = 0; index < actions.length; index += 1) {
    actions[index].sequenceIndex = index;
  }
  opaqueSpans.sort((left, right) => left.start - right.start || left.end - right.end);
  if (!actions.length && !opaqueSpans.length) return undefined;
  attachDoseToNearestAction(actions, clause, input, options);
  const relations = buildInstructionRelations(input, actions, opaqueSpans);
  return {
    actions,
    relations: relations.length ? relations : undefined,
    opaqueSpans: opaqueSpans.length ? opaqueSpans : undefined,
    coverage: buildInstructionCoverage(actions, opaqueSpans),
    sourceText: input,
    sourceLocale: /[\u0E00-\u0E7F]/.test(input) ? "th" : "en"
  };
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
