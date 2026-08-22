import { resolveBodySitePhrase } from "./body-site-grammar";
import { lexInput } from "./lexer/lex";
import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdvicePolarity,
  AdviceRelation,
  CanonicalDoseExpr,
  CanonicalInstructionGraph,
  CanonicalSigClause,
  CanonicalSourceSpan,
  FhirCoding,
  ParseOptions,
  TextRange
} from "./types";

export const MEDICATION_INSTRUCTION_ACTION_SYSTEM =
  "https://solublelabs.com/fhir/CodeSystem/medication-instruction-action";
const SNOMED_SYSTEM = "http://snomed.info/sct";
type Lexeme = ReturnType<typeof lexInput>[number];

export interface MedicationInstructionActionDefinition {
  code: string;
  semanticClass: string;
  display: string;
  i18n: Record<string, string>;
  acceptsAmount?: boolean;
  externalCodings?: FhirCoding[];
}

interface ActionDefinition {
  lemma: string;
  semanticClass: string;
  en: string;
  th: string;
  acceptsAmount?: boolean;
  externalCodings?: FhirCoding[];
}

const ACTIONS: Readonly<Record<string, ActionDefinition>> = {
  shake: { lemma: "shake", semanticClass: "prepare", en: "Shake", th: "เขย่า" },
  pour: { lemma: "pour", semanticClass: "transfer", en: "Pour", th: "เท", acceptsAmount: true },
  mix: { lemma: "mix", semanticClass: "prepare", en: "Mix", th: "ผสม", externalCodings: [{ system: SNOMED_SYSTEM, code: "421826007", display: "Mix" }] },
  rub: { lemma: "rub", semanticClass: "apply", en: "Rub", th: "ถู" },
  lather: { lemma: "lather", semanticClass: "prepare", en: "Lather", th: "ถูให้เกิดฟอง" },
  clean: { lemma: "clean", semanticClass: "cleanse", en: "Clean", th: "ทำความสะอาด" },
  rinse: { lemma: "rinse", semanticClass: "cleanse", en: "Rinse", th: "ล้าง", externalCodings: [{ system: SNOMED_SYSTEM, code: "782155003", display: "Rinse" }] },
  wash: { lemma: "wash", semanticClass: "cleanse", en: "Wash", th: "ล้าง", externalCodings: [{ system: SNOMED_SYSTEM, code: "422152000", display: "Wash - dosing instruction imperative" }] },
  douche: { lemma: "douche", semanticClass: "cleanse", en: "Douche", th: "สวนล้าง" },
  dissolve: { lemma: "dissolve", semanticClass: "prepare", en: "Dissolve", th: "ละลาย" },
  dry: { lemma: "dry", semanticClass: "cleanse", en: "Dry", th: "ทำให้แห้ง" },
  cover: { lemma: "cover", semanticClass: "cover", en: "Cover", th: "ปิดคลุม" },
  leave: { lemma: "leave", semanticClass: "retain", en: "Leave", th: "ทิ้งไว้" },
  apply: { lemma: "apply", semanticClass: "administration", en: "Apply", th: "ทา" },
  use: { lemma: "use", semanticClass: "administration", en: "Use", th: "ใช้" },
  take: { lemma: "take", semanticClass: "administration", en: "Take", th: "รับประทาน" },
  drink: { lemma: "drink", semanticClass: "administration", en: "Drink", th: "ดื่ม" },
  instill: { lemma: "instill", semanticClass: "administration", en: "Instill", th: "หยอด" },
  spray: { lemma: "spray", semanticClass: "administration", en: "Spray", th: "พ่น" },
  inhale: { lemma: "inhale", semanticClass: "administration", en: "Inhale", th: "สูด" },
  inject: { lemma: "inject", semanticClass: "administration", en: "Inject", th: "ฉีด" },
  insert: { lemma: "insert", semanticClass: "administration", en: "Insert", th: "สอด" }
};

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

export function buildMedicationInstructionActionCodeSystem(): MedicationInstructionActionCodeSystem {
  return {
    resourceType: "CodeSystem",
    url: MEDICATION_INSTRUCTION_ACTION_SYSTEM,
    name: "MedicationInstructionAction",
    title: "SolubleLabs Medication Instruction Action",
    status: "active",
    experimental: false,
    caseSensitive: true,
    content: "complete",
    concept: Object.keys(ACTIONS).map((key) => {
      const definition = ACTIONS[key];
      return {
        code: definition.lemma,
        display: definition.en,
        designation: [{ language: "th", value: definition.th }]
      };
    })
  };
}

export function listMedicationInstructionActions(): MedicationInstructionActionDefinition[] {
  return Object.keys(ACTIONS).map((key) => {
    const definition = ACTIONS[key];
    return {
      code: definition.lemma,
      semanticClass: definition.semanticClass,
      display: definition.en,
      i18n: { th: definition.th },
      acceptsAmount: definition.acceptsAmount,
      externalCodings: definition.externalCodings?.map((coding) => ({ ...coding }))
    };
  });
}

export function getMedicationInstructionAction(
  code: string
): MedicationInstructionActionDefinition | undefined {
  let definition: ActionDefinition | undefined;
  for (const key of Object.keys(ACTIONS)) {
    const candidate = ACTIONS[key];
    if (candidate.lemma === code) {
      definition = candidate;
      break;
    }
  }
  if (!definition) return undefined;
  return {
    code: definition.lemma,
    semanticClass: definition.semanticClass,
    display: definition.en,
    i18n: { th: definition.th },
    acceptsAmount: definition.acceptsAmount,
    externalCodings: definition.externalCodings?.map((coding: FhirCoding) => ({ ...coding }))
  };
}

const RELATIONS: Readonly<Record<string, AdviceRelation>> = {
  before: AdviceRelation.Before,
  after: AdviceRelation.After,
  for: AdviceRelation.For,
  with: AdviceRelation.With,
  into: AdviceRelation.Into,
  in: AdviceRelation.In,
  on: AdviceRelation.On,
  to: AdviceRelation.To
};

const INTERNAL_ARGUMENTS: Readonly<Record<string, { role: AdviceArgumentRole; conceptId: string; en: string; th: string }>> = {
  product: { role: AdviceArgumentRole.Theme, conceptId: "product", en: "product", th: "ผลิตภัณฑ์" },
  bottle: { role: AdviceArgumentRole.Container, conceptId: "bottle", en: "bottle", th: "ขวด" },
  water: { role: AdviceArgumentRole.Substance, conceptId: "water", en: "water", th: "น้ำ" },
  "clean-water": { role: AdviceArgumentRole.Substance, conceptId: "clean_water", en: "clean water", th: "น้ำสะอาด" },
  small: { role: AdviceArgumentRole.Amount, conceptId: "small_amount", en: "a small amount", th: "เล็กน้อย" },
  foam: { role: AdviceArgumentRole.Result, conceptId: "foam", en: "foam", th: "ฟอง" },
  "foam-result": { role: AdviceArgumentRole.Result, conceptId: "foam", en: "foam", th: "ฟอง" },
  use: { role: AdviceArgumentRole.Activity, conceptId: "use", en: "use", th: "ใช้" },
  morning: { role: AdviceArgumentRole.Time, conceptId: "morning", en: "the morning", th: "ตอนเช้า" },
  noon: { role: AdviceArgumentRole.Time, conceptId: "noon", en: "noon", th: "ตอนเที่ยง" },
  afternoon: { role: AdviceArgumentRole.Time, conceptId: "afternoon", en: "the afternoon", th: "ตอนบ่าย" },
  evening: { role: AdviceArgumentRole.Time, conceptId: "evening", en: "the evening", th: "ตอนเย็น" },
  night: { role: AdviceArgumentRole.Time, conceptId: "night", en: "night", th: "กลางคืน" },
  "external-intimate-area": { role: AdviceArgumentRole.Site, conceptId: "external_intimate_area", en: "external intimate area", th: "บริเวณภายนอกจุดซ่อนเร้น" }
};

function key(part: Lexeme | undefined): string {
  return part ? (part.canonical ?? part.lower).replace(/^\.+|\.+$/g, "") : "";
}
function internalActionCoding(definition: ActionDefinition): FhirCoding {
  return { system: MEDICATION_INSTRUCTION_ACTION_SYSTEM, code: definition.lemma, display: definition.en, i18n: { th: definition.th } };
}
function actionCodings(definition: ActionDefinition): FhirCoding[] {
  return [internalActionCoding(definition), ...(definition.externalCodings ?? [])];
}
function actionDefinitionAt(parts: Lexeme[], index: number): ActionDefinition | undefined {
  const current = parts.slice(index, index + 1)[0];
  const definition = current ? ACTIONS[key(current)] : undefined;
  if (!definition) return undefined;
  const previous = parts.slice(index - 1, index)[0];
  return previous && RELATIONS[key(previous)] ? undefined : definition;
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
    i18n: {
      en: resolved.englishObjectText,
      ...(resolved.definition?.i18n ?? {}),
      ...(/[\u0E00-\u0E7F]/.test(text) ? { th: text } : {})
    }
  };
}

function internalArgument(canonical: string, sourceText: string): AdviceArgument | undefined {
  const definition = INTERNAL_ARGUMENTS[canonical];
  if (!definition) return undefined;
  return {
    role: definition.role,
    text: sourceText,
    normalized: definition.en,
    conceptId: definition.conceptId,
    i18n: { en: definition.en, th: definition.th }
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
  const direct = canonicalParts.length === 1 ? internalArgument(canonicalParts[0], text) : undefined;
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
    const contained = internalArgument(currentKey, text);
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
  const negatedIndex = negatedActionAt(parts, segmentStart);
  if (negatedIndex !== undefined) {
    polarity = AdvicePolarity.Negate;
    actionIndex = negatedIndex;
  }
  const definition = ACTIONS[key(parts.slice(actionIndex, actionIndex + 1)[0])];
  if (!definition) return undefined;
  const args: AdviceArgument[] = [];
  const argumentStart = actionIndex + 1;
  const relIndex = relationIndex(parts, argumentStart, segmentEnd);
  const relation = relIndex >= 0 ? RELATIONS[key(parts.slice(relIndex, relIndex + 1)[0])] : undefined;

  switch (definition.lemma) {
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
        if (afterWater) pushArgument(args, internalArgument("small", afterWater.sourceText ?? afterWater.original));
      } else pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, undefined, options));
      break;
    }
    case "rub": {
      const resultPart = parts.slice(argumentStart, segmentEnd).find((part) => {
        const currentKey = key(part);
        return currentKey === "foam" || currentKey === "foam-result";
      });
      if (resultPart) pushArgument(args, internalArgument("foam-result", resultPart.sourceText ?? resultPart.original));
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
    case "douche":
      pushArgument(args, argumentFromParts(parts, argumentStart, segmentEnd, input, AdviceArgumentRole.Site, options));
      break;
    default:
      pushArgument(args, argumentFromParts(parts, argumentStart, relIndex >= 0 ? relIndex : segmentEnd, input, undefined, options));
      if (relIndex >= 0) pushArgument(args, argumentFromParts(parts, relIndex + 1, segmentEnd, input, undefined, options));
      break;
  }

  const codings = actionCodings(definition);
  if (definition.lemma === "douche" && args.some((arg) => arg.coding?.code === "76784001" || arg.normalized === "vagina")) {
    codings.push({ system: SNOMED_SYSTEM, code: "21397001", display: "Douche of vagina" });
  }
  const span = rangeFor(parts, segmentStart, segmentEnd, offset);
  return {
    force: polarity === AdvicePolarity.Negate ? AdviceForce.Warning : AdviceForce.Sequence,
    polarity,
    predicate: { lemma: definition.lemma, semanticClass: definition.semanticClass, codings },
    relation,
    args,
    span,
    sourceText: input.slice(span.start - offset, span.end - offset),
    sequenceIndex
  };
}

function negatedActionAt(parts: Lexeme[], index: number): number | undefined {
  const current = key(parts.slice(index, index + 1)[0]);
  if (current === "avoid" && ACTIONS[key(parts.slice(index + 1, index + 2)[0])]) return index + 1;
  if (current === "do" && key(parts.slice(index + 1, index + 2)[0]) === "not" && ACTIONS[key(parts.slice(index + 2, index + 3)[0])]) return index + 2;
  if ((current === "don't" || current === "dont") && ACTIONS[key(parts.slice(index + 1, index + 2)[0])]) return index + 1;
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
      const currentKey = key(parts.slice(index, index + 1)[0]);
      if (negatedActionAt(parts, index) !== undefined) {
        start = index;
        negative = true;
        break;
      }
      if (actionDefinitionAt(parts, index)) {
        start = index;
        break;
      }
    }
    if (start < 0) break;

    const actionStart = negative ? (negatedActionAt(parts, start) ?? start) : start;
    let end = parts.length;
    for (let index = actionStart + 1; index < parts.length; index += 1) {
      const currentKey = key(parts.slice(index, index + 1)[0]);
      if (currentKey === "then") {
        end = index;
        break;
      }
      if (negatedActionAt(parts, index) !== undefined) {
        end = index;
        break;
      }
      if (actionDefinitionAt(parts, index)) {
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

const PROCEDURAL_INSTRUCTION_ACTIONS = new Set([
  "shake",
  "pour",
  "mix",
  "rub",
  "lather",
  "clean",
  "rinse",
  "wash",
  "douche",
  "dissolve",
  "dry",
  "cover",
  "leave"
]);

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

function attachDoseToNearestAction(actions: AdviceFrame[], clause: CanonicalSigClause, input: string): void {
  if (!clause.dose) return;
  const range = doseSourceRange(clause);
  if (!range) return;
  let best: AdviceFrame | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const definition = ACTIONS[action.predicate.lemma];
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
      if (range.kind === "instruction" && !PROCEDURAL_INSTRUCTION_ACTIONS.has(frame.predicate.lemma)) {
        continue;
      }
      frame.sequenceIndex = actions.length;
      actions.push(frame);
      accepted.push(frame);
    }
    for (const opaque of workflowOpaqueGaps(input, range, accepted)) {
      pushOpaqueSpan(opaqueSpans, opaque);
    }
  }
  for (const span of clause.leftovers) {
    if (opaqueTextIsMeaningful(span.text)) pushOpaqueSpan(opaqueSpans, span);
  }
  opaqueSpans.sort((left, right) => left.start - right.start || left.end - right.end);
  if (!actions.length && !opaqueSpans.length) return undefined;
  attachDoseToNearestAction(actions, clause, input);
  return {
    actions,
    opaqueSpans: opaqueSpans.length ? opaqueSpans : undefined,
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
  const definition = ACTIONS[frame.predicate.lemma];
  if (!definition) return frame.predicate.lemma;
  return locale.toLowerCase().startsWith("th") ? definition.th : definition.en;
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
  const nodes: Array<{ start: number; text: string; understood: boolean }> = [];
  for (const frame of frames) {
    const text = realizeAction(frame, locale);
    if (text) nodes.push({ start: frame.span.start, text, understood: true });
  }
  if (!options?.onlyWarnings) {
    for (const opaque of graph.opaqueSpans ?? []) {
      const text = opaque.text.trim();
      if (text) nodes.push({ start: opaque.start, text, understood: false });
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
    output += previous?.understood && node.understood
      ? (thai ? " จากนั้น" : "; then ")
      : "; ";
    output += node.text;
  }
  return output;
}
