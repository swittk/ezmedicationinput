import adviceTerminologySource from "./advice-terminology.json";
import { lexInput } from "./lexer/lex";
import {
  AdditionalInstructionDefinition,
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
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
}

interface AdviceConceptEntry {
  surface: string;
  lemma: string;
  semanticClass: string;
  conceptId: string;
}

interface AdviceTerminologySource {
  lexemes: AdviceLexemeEntry[];
  concepts: AdviceConceptEntry[];
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

interface AdviceCodingRule {
  id: string;
  definition: AdditionalInstructionDefinition;
  frames: AdviceFrameTemplate[];
  matches: (frames: AdviceFrame[]) => boolean;
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

interface AdviceTermMatch<T> {
  entry: T;
  start: number;
  end: number;
}

interface AdviceSegment {
  text: string;
  range: TextRange;
}

const ADVICE_TERMINOLOGY: AdviceTerminologySource = adviceTerminologySource;

const DEFAULT_INSTRUCTION_CONTEXT: AdviceParseContext = {
  defaultPredicate: "take",
  defaultForce: AdviceForce.Instruction,
  allowFreeTextFallback: false
};

const LEADING_NOISE_WORDS = new Set(["and", "please"]);
const ADMINISTRATION_PREDICATES = new Set(["apply", "take", "use"]);
const NEGATOR_WORDS = new Set(["not", "no", "dont", "don't"]);
const VERB_CONNECTOR_WORDS = new Set(["and", "or"]);
const SIMPLE_TIME_WORDS = new Set(["morning", "evening", "night", "bedtime"]);
const DURATION_UNIT_WORDS = new Set([
  "second",
  "seconds",
  "sec",
  "secs",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "hr",
  "hrs",
  "day",
  "days"
]);

const LEXEMES_BY_SURFACE: Record<string, AdviceLexemeEntry[]> = Object.create(null);
const CONCEPTS_BY_SURFACE: Record<string, AdviceConceptEntry[]> = Object.create(null);
const LEXEME_LIST: AdviceLexemeEntry[] = [];
const CONCEPT_LIST: AdviceConceptEntry[] = [];
let MAX_LEXEME_WORDS = 1;
let MAX_CONCEPT_WORDS = 1;

function normalizeAdditionalInstructionKey(value: string): string {
  return normalizeLoosePhraseKey(value);
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

function createDefinition(
  code: string,
  display: string,
  text: string,
  thai: string
): AdditionalInstructionDefinition {
  return {
    coding: {
      system: SNOMED_SYSTEM,
      code,
      display
    },
    text,
    i18n: { th: thai }
  };
}

function hasArgConcept(
  frame: AdviceFrame,
  conceptId: string,
  role?: AdviceArgumentRole
): boolean {
  for (const arg of frame.args) {
    if (arg.conceptId !== conceptId) {
      continue;
    }
    if (role && arg.role !== role) {
      continue;
    }
    return true;
  }
  return false;
}

function hasArgConceptAnywhere(frames: AdviceFrame[], conceptId: string, role?: AdviceArgumentRole): boolean {
  for (const frame of frames) {
    if (hasArgConcept(frame, conceptId, role)) {
      return true;
    }
  }
  return false;
}

function hasPredicate(
  frames: AdviceFrame[],
  lemma: string,
  polarity?: AdvicePolarity
): boolean {
  for (const frame of frames) {
    if (frame.predicate.lemma !== lemma) {
      continue;
    }
    if (polarity && frame.polarity !== polarity) {
      continue;
    }
    return true;
  }
  return false;
}

function hasDrowsinessFrame(frames: AdviceFrame[]): boolean {
  for (const frame of frames) {
    if (frame.predicate.lemma !== "cause") {
      continue;
    }
    if (hasArgConcept(frame, "drowsiness")) {
      return true;
    }
  }
  return false;
}

const ADDITIONAL_INSTRUCTION_RULES: AdviceCodingRule[] = [
  {
    id: "with-after-food",
    definition: createDefinition(
      "311504000",
      "With or after food",
      "Take with or after food",
      "รับประทานพร้อมหรือหลังอาหาร"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.With,
        args: [{ role: AdviceArgumentRole.MealState, text: "food", conceptId: "food" }]
      }
    ],
    matches: (frames) => {
      for (const frame of frames) {
        if (frame.relation !== AdviceRelation.With && frame.relation !== AdviceRelation.After) {
          continue;
        }
        if (
          hasArgConcept(frame, "food", AdviceArgumentRole.MealState) ||
          hasArgConcept(frame, "meal", AdviceArgumentRole.MealState)
        ) {
          return true;
        }
      }
      return false;
    }
  },
  {
    id: "before-food",
    definition: createDefinition(
      "311501008",
      "Half to one hour before food",
      "Take before food",
      "รับประทานก่อนอาหาร"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.Before,
        args: [{ role: AdviceArgumentRole.MealState, text: "food", conceptId: "food" }]
      }
    ],
    matches: (frames) => {
      for (const frame of frames) {
        if (frame.relation !== AdviceRelation.Before) {
          continue;
        }
        if (
          hasArgConcept(frame, "food", AdviceArgumentRole.MealState) ||
          hasArgConcept(frame, "meal", AdviceArgumentRole.MealState)
        ) {
          return true;
        }
      }
      return false;
    }
  },
  {
    id: "empty-stomach",
    definition: createDefinition(
      "717154004",
      "Take on an empty stomach (qualifier value)",
      "Take on an empty stomach",
      "รับประทานขณะท้องว่าง"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.On,
        args: [{ role: AdviceArgumentRole.MealState, text: "empty stomach", conceptId: "empty_stomach" }]
      }
    ],
    matches: (frames) => hasArgConceptAnywhere(frames, "empty_stomach", AdviceArgumentRole.MealState)
  },
  {
    id: "with-water",
    definition: createDefinition(
      "419303009",
      "With plenty of water",
      "Take with plenty of water",
      "รับประทานพร้อมน้ำดื่มจำนวนมาก"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.With,
        args: [{ role: AdviceArgumentRole.Substance, text: "water", conceptId: "water" }]
      }
    ],
    matches: (frames) => {
      for (const frame of frames) {
        if (frame.relation !== AdviceRelation.With && frame.predicate.lemma !== "drink") {
          continue;
        }
        if (hasArgConcept(frame, "water", AdviceArgumentRole.Substance)) {
          return true;
        }
      }
      return false;
    }
  },
  {
    id: "dissolve-with-water",
    definition: createDefinition(
      "417995008",
      "Dissolve or mix with water before taking",
      "Dissolve or mix with water before taking",
      "ละลายหรือผสมน้ำก่อนรับประทาน"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "dissolve", semanticClass: "prepare" },
        relation: AdviceRelation.With,
        args: [{ role: AdviceArgumentRole.Substance, text: "water", conceptId: "water" }]
      }
    ],
    matches: (frames) => {
      for (const frame of frames) {
        if (frame.predicate.lemma !== "dissolve" && frame.predicate.lemma !== "mix") {
          continue;
        }
        if (hasArgConcept(frame, "water", AdviceArgumentRole.Substance)) {
          return true;
        }
      }
      return false;
    }
  },
  {
    id: "avoid-alcohol",
    definition: createDefinition(
      "419822006",
      "Warning. Avoid alcoholic drink (qualifier value)",
      "Avoid alcoholic drinks",
      "หลีกเลี่ยงเครื่องดื่มแอลกอฮอล์"
    ),
    frames: [
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "avoid", semanticClass: "avoidance" },
        args: [{ role: AdviceArgumentRole.Substance, text: "alcohol", conceptId: "alcohol" }]
      }
    ],
    matches: (frames) => {
      for (const frame of frames) {
        if (
          frame.predicate.lemma === "avoid" ||
          frame.predicate.lemma === "drink"
        ) {
          if (hasArgConcept(frame, "alcohol", AdviceArgumentRole.Substance)) {
            return true;
          }
        }
      }
      return false;
    }
  },
  {
    id: "drowsiness-drive",
    definition: createDefinition(
      "418954008",
      "Warning. May cause drowsiness. If affected do not drive or operate machinery (qualifier value)",
      "May cause drowsiness; do not drive if affected",
      "อาจทำให้ง่วงซึม; ห้ามขับขี่ยานพาหนะหรือทำงานกับเครื่องจักรหากมีอาการ"
    ),
    frames: [
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "cause", semanticClass: "effect" },
        args: [{ role: AdviceArgumentRole.Object, text: "drowsiness", conceptId: "drowsiness" }]
      },
      {
        force: AdviceForce.Warning,
        polarity: AdvicePolarity.Negate,
        predicate: { lemma: "drive", semanticClass: "activity" },
        args: []
      }
    ],
    matches: (frames) => hasDrowsinessFrame(frames) && hasPredicate(frames, "drive", AdvicePolarity.Negate)
  },
  {
    id: "drowsiness-drive-alcohol",
    definition: createDefinition(
      "418914006",
      "Warning. May cause drowsiness. If affected do not drive or operate machinery. Avoid alcoholic drink (qualifier value)",
      "May cause drowsiness; avoid driving or alcohol",
      "อาจทำให้ง่วงซึม; หลีกเลี่ยงการขับขี่ยานพาหนะหรือดื่มแอลกอฮอล์"
    ),
    frames: [
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "cause", semanticClass: "effect" },
        args: [{ role: AdviceArgumentRole.Object, text: "drowsiness", conceptId: "drowsiness" }]
      },
      {
        force: AdviceForce.Warning,
        polarity: AdvicePolarity.Negate,
        predicate: { lemma: "drive", semanticClass: "activity" },
        args: []
      },
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "avoid", semanticClass: "avoidance" },
        args: [{ role: AdviceArgumentRole.Substance, text: "alcohol", conceptId: "alcohol" }]
      }
    ],
    matches: (frames) =>
      hasDrowsinessFrame(frames) &&
      hasPredicate(frames, "drive", AdvicePolarity.Negate) &&
      hasArgConceptAnywhere(frames, "alcohol", AdviceArgumentRole.Substance)
  },
  {
    id: "next-day-drowsiness",
    definition: createDefinition(
      "418071006",
      "Warning. Causes drowsiness which may continue the next day. If affected do not drive or operate machinery. Avoid alcoholic drink (qualifier value)",
      "May cause next-day drowsiness; avoid driving or alcohol",
      "อาจทำให้ง่วงซึมในวันถัดมา; หลีกเลี่ยงการขับขี่ยานพาหนะหรือดื่มแอลกอฮอล์"
    ),
    frames: [
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "cause", semanticClass: "effect" },
        args: [
          { role: AdviceArgumentRole.Object, text: "drowsiness", conceptId: "drowsiness" },
          { role: AdviceArgumentRole.Time, text: "next day", conceptId: "next_day" }
        ]
      }
    ],
    matches: (frames) =>
      hasDrowsinessFrame(frames) &&
      hasArgConceptAnywhere(frames, "next_day", AdviceArgumentRole.Time) &&
      hasArgConceptAnywhere(frames, "alcohol", AdviceArgumentRole.Substance)
  },
  {
    id: "avoid-sunlight",
    definition: createDefinition(
      "418521000",
      "Avoid exposure of skin to direct sunlight or sun lamps (qualifier value)",
      "Avoid sunlight or sun lamps",
      "หลีกเลี่ยงแสงแดดหรือหลอดไฟแสงยูวี"
    ),
    frames: [
      {
        force: AdviceForce.Warning,
        predicate: { lemma: "avoid", semanticClass: "avoidance" },
        args: [{ role: AdviceArgumentRole.Object, text: "sunlight", conceptId: "sunlight" }]
      }
    ],
    matches: (frames) =>
      hasArgConceptAnywhere(frames, "sunlight") || hasArgConceptAnywhere(frames, "sun_lamps")
  },
  {
    id: "swallow-whole",
    definition: createDefinition(
      "418693002",
      "Swallowed whole, not chewed (qualifier value)",
      "Swallow whole; do not crush or chew",
      "กลืนทั้งเม็ด; ห้ามเคี้ยวหรือบด"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        polarity: AdvicePolarity.Negate,
        predicate: { lemma: "crush", semanticClass: "manipulate" },
        args: []
      },
      {
        force: AdviceForce.Instruction,
        polarity: AdvicePolarity.Negate,
        predicate: { lemma: "chew", semanticClass: "manipulate" },
        args: []
      }
    ],
    matches: (frames) =>
      hasPredicate(frames, "crush", AdvicePolarity.Negate) ||
      hasPredicate(frames, "chew", AdvicePolarity.Negate)
  },
  {
    id: "chew",
    definition: createDefinition(
      "418991002",
      "Sucked or chewed (qualifier value)",
      "Suck or chew before swallowing",
      "เคี้ยวหรืออมให้ละลายก่อนกลืน"
    ),
    frames: [
      {
        force: AdviceForce.Instruction,
        predicate: { lemma: "chew", semanticClass: "manipulate" },
        args: []
      }
    ],
    matches: (frames) =>
      hasPredicate(frames, "chew") && !hasPredicate(frames, "chew", AdvicePolarity.Negate)
  }
];

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
  polarity?: AdvicePolarity
): AdviceFrame {
  return {
    force,
    polarity,
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

function mapSemanticClassToRole(semanticClass: string | undefined): AdviceArgumentRole {
  switch (semanticClass) {
    case "meal_state":
      return AdviceArgumentRole.MealState;
    case "activity":
      return AdviceArgumentRole.Activity;
    case "material":
      return AdviceArgumentRole.Material;
    case "site":
      return AdviceArgumentRole.Site;
    case "amount_style":
      return AdviceArgumentRole.Amount;
    case "duration":
      return AdviceArgumentRole.Duration;
    case "time":
      return AdviceArgumentRole.Time;
    case "substance":
      return AdviceArgumentRole.Substance;
    default:
      return AdviceArgumentRole.Object;
  }
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
    if (normalizeAdditionalInstructionKey(token.original) !== "then") {
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
  if (!entry) {
    return undefined;
  }
  switch (entry.lemma) {
    case "with":
      return AdviceRelation.With;
    case "without":
      return AdviceRelation.Without;
    case "before":
      return AdviceRelation.Before;
    case "after":
      return AdviceRelation.After;
    case "during":
      return AdviceRelation.During;
    case "then":
      return AdviceRelation.Then;
    case "until":
      return AdviceRelation.Until;
    case "for":
      return AdviceRelation.For;
    case "in":
      return AdviceRelation.In;
    case "on":
      return AdviceRelation.On;
    default:
      return undefined;
  }
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

function parseEmbeddedAvoidanceFrames(
  normalized: string,
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] {
  const frames: AdviceFrame[] = [];
  const force = sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning;

  if (normalized.includes("avoid alcohol") || normalized.includes("no alcohol") || normalized.includes("no alc")) {
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

  if (
    normalized.includes("avoid driving") ||
    normalized.includes("do not drive") ||
    normalized.includes("no driving") ||
    normalized.includes("no drive")
  ) {
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

function tryParseDrowsinessInstruction(
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const normalized = normalizeAdditionalInstructionKey(sourceText);
  if (!normalized) {
    return undefined;
  }
  if (!normalized.includes("drowsiness") && !normalized.includes("drowsy")) {
    return undefined;
  }
  const args = [createArgument(AdviceArgumentRole.Object, "drowsiness", "drowsiness", "drowsiness")];
  if (normalized.includes("next day")) {
    args.push(createArgument(AdviceArgumentRole.Time, "next day", "next day", "next_day"));
  }
  const frames = [
    createFrame(
      sourceText,
      span,
      sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
      "cause",
      "effect",
      args,
      sequenceIndex
    )
  ];
  const embedded = parseEmbeddedAvoidanceFrames(normalized, sourceText, span, sequenceIndex, sequenceCount);
  for (const frame of embedded) {
    frames.push(frame);
  }
  return frames;
}

function tryParseAvoidInstruction(
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (!words.length) {
    return undefined;
  }
  const cursor = skipLeadingNoise(words);
  if (cursor >= words.length || words[cursor] !== "avoid") {
    return undefined;
  }
  const objectText = words.slice(cursor + 1).join(" ");
  if (!objectText) {
    return undefined;
  }
  return [
    createFrame(
      sourceText,
      span,
      sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
      "avoid",
      "avoidance",
      [classifyArgument(objectText)],
      sequenceIndex
    )
  ];
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
  if (cursor >= words.length || words[cursor] !== "no") {
    return undefined;
  }
  const objectText = words.slice(cursor + 1).join(" ");
  const argument = classifyArgument(objectText);
  if (argument.conceptId === "alcohol") {
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
  if (objectText === "drive" || objectText === "driving") {
    return [
      createFrame(
        sourceText,
        span,
        sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
        "drive",
        "activity",
        [],
        sequenceIndex,
        undefined,
        AdvicePolarity.Negate
      )
    ];
  }
  return undefined;
}

function tryParseNegatedVerbInstruction(
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (words.length < 3) {
    return undefined;
  }
  let cursor = skipLeadingNoise(words);
  if (cursor >= words.length) {
    return undefined;
  }
  if (words[cursor] === "do" && cursor + 1 < words.length && words[cursor + 1] === "not") {
    cursor += 2;
  } else if (NEGATOR_WORDS.has(words[cursor])) {
    cursor += 1;
  } else {
    return undefined;
  }
  if (cursor >= words.length || !isKnownVerb(words[cursor])) {
    return undefined;
  }

  const verbWords: string[] = [];
  let remainderStart = cursor;
  while (remainderStart < words.length) {
    const word = words[remainderStart];
    if (isKnownVerb(word)) {
      verbWords.push(word);
      remainderStart += 1;
      continue;
    }
    if (
      VERB_CONNECTOR_WORDS.has(word) &&
      remainderStart + 1 < words.length &&
      isKnownVerb(words[remainderStart + 1])
    ) {
      remainderStart += 1;
      continue;
    }
    break;
  }

  if (!verbWords.length) {
    return undefined;
  }

  const remainderWords = words.slice(remainderStart);
  const relation = remainderWords.length ? isRelationWord(remainderWords[0]) : undefined;
  const objectText = remainderWords.length
    ? remainderWords.slice(relation ? 1 : 0).join(" ")
    : "";

  const frames: AdviceFrame[] = [];
  for (const verb of verbWords) {
    const args: AdviceArgument[] = [];
    if (objectText) {
      args.push(classifyArgument(objectText));
    }
    frames.push(
      createFrame(
        sourceText,
        span,
        sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
        verb,
        findNormalizedLexeme(verb, "verb")?.semanticClass,
        args,
        sequenceIndex,
        relation,
        AdvicePolarity.Negate
      )
    );
  }

  return frames;
}

function tryParseMayCauseInstruction(
  sourceText: string,
  span: TextRange,
  sequenceIndex: number,
  sequenceCount: number
): AdviceFrame[] | undefined {
  const words = normalizeWords(sourceText);
  if (words.length < 2) {
    return undefined;
  }
  let cursor = skipLeadingNoise(words);
  if (cursor < words.length && words[cursor] === "may") {
    cursor += 1;
  }
  if (cursor >= words.length) {
    return undefined;
  }
  if (words[cursor] !== "cause" && words[cursor] !== "causes") {
    return undefined;
  }
  const objectText = words.slice(cursor + 1).join(" ");
  if (!objectText) {
    return undefined;
  }
  return [
    createFrame(
      sourceText,
      span,
      sequenceCount > 1 ? AdviceForce.Sequence : AdviceForce.Warning,
      "cause",
      "effect",
      [classifyArgument(objectText)],
      sequenceIndex
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
  if (!lexeme || lexeme.semanticClass !== "amount_style") {
    return undefined;
  }
  return [
    createFrame(
      sourceText,
      span,
      createDefaultForce(sequenceCount, sequenceIndex, context),
      context.defaultPredicate,
      "administration",
      [createArgument(AdviceArgumentRole.Amount, styleText, styleText)],
      sequenceIndex
    )
  ];
}

function tryParseVerbInstruction(
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
  if (cursor >= words.length) {
    return undefined;
  }

  if (
    cursor + 2 < words.length &&
    isKnownVerb(words[cursor]) &&
    words[cursor + 1] === "and" &&
    isKnownVerb(words[cursor + 2])
  ) {
    const objectText = words.slice(cursor + 3).join(" ");
    if (!objectText) {
      return undefined;
    }
    const firstVerb = words[cursor];
    const secondVerb = words[cursor + 2];
    const sharedArgument = classifyArgument(objectText);
    return [
      createFrame(
        sourceText,
        span,
        createDefaultForce(sequenceCount, sequenceIndex, context),
        firstVerb,
        findNormalizedLexeme(firstVerb, "verb")?.semanticClass,
        [sharedArgument],
        sequenceIndex
      ),
      createFrame(
        sourceText,
        span,
        createDefaultForce(sequenceCount, sequenceIndex, context),
        secondVerb,
        findNormalizedLexeme(secondVerb, "verb")?.semanticClass,
        [sharedArgument],
        sequenceIndex
      )
    ];
  }

  let verb = words[cursor];
  if (isAdministrationWord(verb) && cursor + 1 < words.length) {
    const relation = isRelationWord(words[cursor + 1]);
    if (relation) {
      return tryParseRelationInstruction(sourceText, span, context, sequenceIndex, sequenceCount);
    }
    cursor += 1;
    verb = cursor < words.length ? words[cursor] : "";
  }

  if (!verb || !isKnownVerb(verb) || isAdministrationWord(verb)) {
    return undefined;
  }

  const force = createDefaultForce(sequenceCount, sequenceIndex, context);
  const remainderWords = words.slice(cursor + 1);
  const args: AdviceArgument[] = [];
  let relation: AdviceRelation | undefined;

  if (verb === "leave" && remainderWords[0] === "on") {
    args.push(createArgument(AdviceArgumentRole.Theme, "on", "on"));
    if (remainderWords.length > 1) {
      const nextRelation = isRelationWord(remainderWords[1]);
      if (nextRelation) {
        relation = nextRelation;
        const afterRelation = remainderWords.slice(2).join(" ");
        if (afterRelation) {
          args.push(classifyArgument(afterRelation));
        }
      } else {
        const tail = remainderWords.slice(1).join(" ");
        if (tail) {
          args.push(classifyArgument(tail));
        }
      }
    }
  } else if (remainderWords.length > 0) {
    relation = isRelationWord(remainderWords[0]);
    const objectText = remainderWords.slice(relation ? 1 : 0).join(" ");
    if (objectText) {
      args.push(classifyArgument(objectText));
    }
  }

  if (!args.length && (verb === "apply" || verb === "take" || verb === "use")) {
    return undefined;
  }

  return [
    createFrame(
      sourceText,
      span,
      force,
      verb,
      findNormalizedLexeme(verb, "verb")?.semanticClass,
      args,
      sequenceIndex,
      relation
    )
  ];
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
      tryParseDrowsinessInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseNegatedVerbInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseNoObjectInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseAvoidInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseMayCauseInstruction(segment.text, segment.range, index, sequenceSegments.length) ??
      tryParseRelationInstruction(segment.text, segment.range, context, index, sequenceSegments.length) ??
      tryParseStyleInstruction(segment.text, segment.range, context, index, sequenceSegments.length) ??
      tryParseVerbInstruction(segment.text, segment.range, context, index, sequenceSegments.length);
    if (!parsed) {
      return [];
    }
    for (const frame of parsed) {
      frames.push(frame);
    }
  }
  return frames;
}

function matchAdviceCodingRule(frames: AdviceFrame[]): AdviceCodingRule | undefined {
  for (const rule of ADDITIONAL_INSTRUCTION_RULES) {
    if (rule.matches(frames)) {
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
    const frames = parseSequenceFrames(cleanedText, segment.range, effectiveContext);
    if (frames.length) {
      const rule = matchAdviceCodingRule(frames);
      instructions.push({
        text: rule?.definition.text ?? cleanedText,
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
