import {
  DAY_OF_WEEK_TOKENS,
  DEFAULT_BODY_SITE_SNOMED,
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_SYNONYMS,
  EVENT_TIMING_TOKENS,
  TIMING_ABBREVIATIONS
} from "../maps";
import { DEFAULT_SYMPTOM_DEFINITIONS } from "../symptom-terminology";
import {
  getRelationLocaleLexemeAliases,
  getRelationLocalePhrases,
  getRelationSplitPrefixes
} from "../relation-terminology";
import unitTerminologySource from "../unit-terminology.json";
import instructionActionSource from "../instruction-action-terminology.json";
import instructionConceptSource from "../instruction-concept-terminology.json";
import adviceRulesSource from "../advice-rules.json";
import { LexKind, LexToken } from "./token-types";

/**
 * Locale-aware lexical normalization belongs between surface segmentation and
 * the grammar. The grammar consumes canonical medication-language lexemes,
 * while `original`/source offsets always retain the clinician's exact text.
 *
 * This deliberately is not a general translator. Only words/phrases whose
 * medication semantics are stable enough to feed deterministic grammar rules
 * belong here. Unknown prose remains untouched and can still be preserved as
 * patient instructions.
 */
const NON_RELATION_THAI_LEXEME_ALIASES: Readonly<Record<string, string>> = {
  // administration / workflow
  "เขย่า": "shake",
  "เท": "pour",
  "ผลิตภัณฑ์": "product",
  "ขวด": "bottle",
  "ใช้": "use",
  "รับประทาน": "take",
  "กิน": "take",
  "ทา": "apply",
  "หยอด": "instill",
  "พ่น": "spray",
  "สูด": "inhale",
  "ฉีด": "inject",
  "สอด": "insert",
  "ผสม": "mix",
  "ล้าง": "wash",
  "ถู": "rub",
  "ฝ่ามือ": "palm",
  "ช่องคลอด": "vagina",

  // grammar / relations
  "ทุก": "every",
  "และ": "and",
  "หรือ": "or",
  "บางๆ": "thinly",
  "ห้าม": "avoid",
  "ควร": "should",
  "ต้อง": "must",
  "ให้": "do",
  "ปรึกษา": "consult",
  "แพทย์": "doctor",
  "ประมาณ": "about",
  "ปรับ": "adjust",
  "ตาม": "depending",
  "แปะ": "apply_patch",
  "ตื่น": "awake",
  "เฉพาะ": "only",
  "เริ่ม": "start",
  "จำเป็น": "needed",
  "ออกกำลังกาย": "exercise",
  "การออกกำลังกาย": "exercise",
  "วันเว้นวัน": "qod",
  "สัปดาห์ละครั้ง": "weekly",

  // cadence / event timing
  "ครั้ง": "times",
  "จำนวน": "total",
  "เช้า": "morning",
  "เที่ยง": "noon",
  "กลางวัน": "noon",
  "บ่าย": "afternoon",
  "เย็น": "evening",
  "กลางคืน": "night",
  "นอน": "sleep",
  "อาหาร": "meal",
  "น้ำ": "water",
  "ฟอง": "foam",
  "วินาที": "second",
  "คืน": "night",
  "ทันที": "immediate",
  "นาที": "minute",
  "ชั่วโมง": "hour",
  "วัน": "day",
  "สัปดาห์": "week",
  "เดือน": "month",

  // dose units
  "มิลลิลิตร": "ml",
  "มล": "ml",
  "มล.": "ml",
  "มิลลิกรัม": "mg",
  "ไมโครกรัม": "mcg",
  "กรัม": "g",
  "เม็ด": "tab",
  "แคปซูล": "cap",
  "หยด": "drop",
  "พัฟ": "puff"
};

const THAI_LEXEME_ALIASES: Record<string, string> = { ...NON_RELATION_THAI_LEXEME_ALIASES };
for (const [surface, canonical] of getRelationLocaleLexemeAliases("th")) {
  THAI_LEXEME_ALIASES[surface] = canonical;
}

interface DeclarativeTerminologySource {
  actions?: Array<{ code?: string; aliases?: string[]; i18n?: Record<string, string> }>;
  concepts?: Array<{ code?: string; aliases?: string[]; i18n?: Record<string, string> }>;
}

const DECLARATIVE_THAI_CANONICAL: Record<string, string> = {};
function registerDeclarativeThaiAliases(
  entries: Array<{ code?: string; aliases?: string[]; i18n?: Record<string, string> }> | undefined
): void {
  for (const entry of entries ?? []) {
    if (!entry.code) continue;
    const candidates = entry.aliases ?? [];
    for (const candidate of candidates) {
      const normalized = candidate.trim().toLowerCase();
      if (
        normalized && /[\u0E00-\u0E7F]/.test(normalized) &&
        DECLARATIVE_THAI_CANONICAL[normalized] === undefined
      ) {
        DECLARATIVE_THAI_CANONICAL[normalized] = entry.code;
      }
    }
  }
}
registerDeclarativeThaiAliases((instructionActionSource as DeclarativeTerminologySource).actions);
registerDeclarativeThaiAliases((instructionConceptSource as DeclarativeTerminologySource).concepts);

interface AdviceStyleLexiconSource {
  rules?: Array<{
    definition?: { thaiVerbSuffix?: string };
    matcher?: { normalizedTexts?: string[] };
  }>;
}

function registerDeclarativeAdviceStyleAliases(): void {
  const rules = (adviceRulesSource as AdviceStyleLexiconSource).rules ?? [];
  for (const rule of rules) {
    const suffix = rule.definition?.thaiVerbSuffix?.trim().toLowerCase();
    if (!suffix) continue;
    const canonical = rule.matcher?.normalizedTexts?.find((candidate) =>
      /^[a-z][a-z-]*$/i.test(candidate.trim())
    )?.trim().toLowerCase();
    if (!canonical) continue;
    DECLARATIVE_THAI_CANONICAL[suffix] = canonical;
  }
}
registerDeclarativeAdviceStyleAliases();

function canonicalThaiLexeme(value: string): string | undefined {
  return THAI_LEXEME_ALIASES[value] ?? DECLARATIVE_THAI_CANONICAL[value];
}

interface LocalePhrase {
  parts: readonly string[];
  canonical: string;
}

interface UnitTerminologySource {
  terms?: Array<{ unit?: string; aliases?: string[]; parseAsDose?: boolean }>;
}

const DOSE_UNIT_CANONICALS = new Set(
  ((unitTerminologySource as UnitTerminologySource).terms ?? [])
    .filter((term) => term.parseAsDose !== false && term.unit)
    .map((term) => term.unit!.toLowerCase())
);

const LEGACY_THAI_GROUP_TERMS = [
  "วันธรรมดา",
  "วันทำงาน",
  "วันหยุด",
  "วันเสาร์อาทิตย์",
  "สุดสัปดาห์",
  "เสาร์อาทิตย์",
  "จันทร์ถึงศุกร์"
] as const;

const KNOWN_THAI_DOMAIN_TERMS = new Set<string>();

function registerKnownThaiTerms(values: Iterable<string>): void {
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized && /[\u0E00-\u0E7F]/.test(normalized) && !/\s/.test(normalized)) {
      KNOWN_THAI_DOMAIN_TERMS.add(normalized);
    }
  }
}

for (const daySurface of Object.keys(DAY_OF_WEEK_TOKENS)) {
  if (/[\u0E00-\u0E7F]/u.test(daySurface) && !daySurface.startsWith("วัน")) {
    const prefixed = `วัน${daySurface}`;
    if (DECLARATIVE_THAI_CANONICAL[prefixed] === undefined) {
      DECLARATIVE_THAI_CANONICAL[prefixed] = daySurface;
    }
  }
}

registerKnownThaiTerms(Object.keys(THAI_LEXEME_ALIASES));
registerKnownThaiTerms(Object.keys(DEFAULT_BODY_SITE_SNOMED));
registerKnownThaiTerms(Object.keys(DEFAULT_SYMPTOM_DEFINITIONS));
registerKnownThaiTerms(Object.keys(DEFAULT_ROUTE_SYNONYMS));
registerKnownThaiTerms(Object.keys(DEFAULT_UNIT_SYNONYMS));
registerKnownThaiTerms(Object.keys(DAY_OF_WEEK_TOKENS));
registerKnownThaiTerms(Object.keys(EVENT_TIMING_TOKENS));
registerKnownThaiTerms(Object.keys(TIMING_ABBREVIATIONS));
registerKnownThaiTerms(LEGACY_THAI_GROUP_TERMS);
for (const term of (unitTerminologySource as UnitTerminologySource).terms ?? []) {
  registerKnownThaiTerms([term.unit ?? "", ...(term.aliases ?? [])]);
}
registerKnownThaiTerms(Object.keys(DECLARATIVE_THAI_CANONICAL));

function isKnownThaiDomainTerm(value: string): boolean {
  const normalized = value.toLowerCase();
  if (KNOWN_THAI_DOMAIN_TERMS.has(normalized)) {
    return true;
  }
  const range = normalized.match(/^(.+?)(?:ถึง|จนถึง)(.+)$/u);
  return Boolean(
    range &&
    DAY_OF_WEEK_TOKENS[range[1]] &&
    DAY_OF_WEEK_TOKENS[range[2]]
  );
}

// Longest phrases first. ICU segments Thai compounds into linguistic words;
// this layer recomposes medication-specific multiword lexemes where the grammar
// benefits from a single canonical item.
const THAI_PHRASES: readonly LocalePhrase[] = [
  ...getRelationLocalePhrases("th"),
  { parts: ["หลัง", "ตื่น", "นอน"], canonical: "wake" },
  { parts: ["ตื่น", "นอน"], canonical: "wake" },
  { parts: ["ยา", "พ่น"], canonical: "inhaler" },
  { parts: ["ยา", "เหน็บ"], canonical: "suppository" },
  { parts: ["แผ่น", "แปะ"], canonical: "patch" },
  { parts: ["ครั้ง", "ละ"], canonical: "per-dose" },
  { parts: ["ไม่", "ควร"], canonical: "should-not" },
  { parts: ["กลาง", "วัน"], canonical: "noon" },
  { parts: ["ให้", "แห้ง"], canonical: "dry" },
  { parts: ["บริเวณ", "ภายนอก", "จุด", "ซ่อน", "เร้น"], canonical: "external-intimate-area" },
  { parts: ["ให้", "เกิด", "ฟอง"], canonical: "foam-result" },
  { parts: ["น้ำ", "สะอาด"], canonical: "clean-water" },
  { parts: ["เล็ก", "น้อย"], canonical: "small" },
  { parts: ["รับ", "ประทาน"], canonical: "take" },
  { parts: ["วัน", "ละ", "ครั้ง"], canonical: "daily" },
  { parts: ["ทำความ", "สะอาด"], canonical: "clean" },
  { parts: ["ทุก", "สัปดาห์"], canonical: "weekly" },
  { parts: ["ทุก", "เดือน"], canonical: "monthly" },
  { parts: ["ทุก", "วัน"], canonical: "daily" },
  { parts: ["สวน", "ล้าง"], canonical: "douche" },
  { parts: ["ชั่วโมง", "ละ"], canonical: "hourly" },
  { parts: ["สัปดาห์", "ละ"], canonical: "weekly" },
  { parts: ["เดือน", "ละ"], canonical: "monthly" },
  { parts: ["วัน", "ละ"], canonical: "daily" }
];

function mergeSourceSpan(
  tokens: readonly LexToken[],
  start: number,
  endInclusive: number,
  input: string,
  canonical?: string
): LexToken {
  const parts = tokens.slice(start, endInclusive + 1);
  const first = parts[0];
  const last = parts[parts.length - 1];
  const sourceStart = first.sourceStart;
  const sourceEnd = last.sourceEnd;
  const sourceText = input.slice(sourceStart, sourceEnd);
  const surfaceIndices: number[] = [];
  for (const part of parts) {
    for (const surfaceIndex of part.surfaceIndices) {
      if (surfaceIndices.indexOf(surfaceIndex) === -1) {
        surfaceIndices.push(surfaceIndex);
      }
    }
  }
  return {
    original: sourceText,
    lower: sourceText.toLowerCase(),
    canonical,
    index: -1,
    kind: LexKind.Word,
    sourceStart,
    sourceEnd,
    surfaceIndices,
    sourceText,
    derived: true
  };
}

const THAI_GRAMMAR_PREFIXES = getRelationSplitPrefixes("th");

function splitThaiGrammarPrefixTokens(tokens: readonly LexToken[]): LexToken[] {
  const result: LexToken[] = [];
  for (const token of tokens) {
    if (token.kind !== LexKind.Word || isKnownThaiDomainTerm(token.lower)) {
      result.push({ ...token });
      continue;
    }
    const prefix = THAI_GRAMMAR_PREFIXES.find((candidate) =>
      token.lower.startsWith(candidate) && token.lower.length > candidate.length
    );
    if (!prefix) {
      result.push({ ...token });
      continue;
    }
    const remainder = token.lower.slice(prefix.length);
    const remainderCanonical = canonicalThaiLexeme(remainder);
    if (!isKnownThaiDomainTerm(remainder) && !remainderCanonical) {
      result.push({ ...token });
      continue;
    }
    const splitAt = token.sourceStart + prefix.length;
    result.push({
      ...token,
      surfaceIndices: [...token.surfaceIndices],
      original: token.original.slice(0, prefix.length),
      lower: prefix,
      canonical: canonicalThaiLexeme(prefix),
      sourceEnd: splitAt,
      sourceText: token.original.slice(0, prefix.length),
      derived: true
    });
    result.push({
      ...token,
      surfaceIndices: [...token.surfaceIndices],
      original: token.original.slice(prefix.length),
      lower: remainder,
      canonical: remainderCanonical,
      sourceStart: splitAt,
      sourceText: token.original.slice(prefix.length),
      derived: true
    });
  }
  return result;
}

function splitThaiDistributiveUnitTokens(tokens: readonly LexToken[]): LexToken[] {
  const result: LexToken[] = [];
  for (const token of tokens) {
    if (token.kind !== LexKind.Word || !token.lower.startsWith("ละ") || token.lower.length <= 2) {
      result.push({ ...token });
      continue;
    }
    const unitSurface = token.lower.slice(2);
    const canonicalUnit = canonicalThaiLexeme(unitSurface);
    if (!canonicalUnit || !DOSE_UNIT_CANONICALS.has(canonicalUnit.toLowerCase())) {
      result.push({ ...token });
      continue;
    }
    const splitAt = token.sourceStart + 2;
    result.push({
      ...token,
      surfaceIndices: [...token.surfaceIndices],
      original: token.original.slice(0, 2),
      lower: "ละ",
      canonical: undefined,
      sourceEnd: splitAt,
      sourceText: token.original.slice(0, 2),
      derived: true
    });
    result.push({
      ...token,
      surfaceIndices: [...token.surfaceIndices],
      original: token.original.slice(2),
      lower: unitSurface,
      canonical: canonicalUnit,
      sourceStart: splitAt,
      sourceText: token.original.slice(2),
      derived: true
    });
  }
  return result;
}

function knownDomainCompoundAt(
  tokens: readonly LexToken[],
  start: number,
  input: string
): { token: LexToken; length: number } | undefined {
  const first = tokens[start];
  if (!first || first.kind !== LexKind.Word || !/[\u0E00-\u0E7F]/.test(first.original)) {
    return undefined;
  }
  let bestEnd = -1;
  const maxEnd = Math.min(tokens.length - 1, start + 7);
  for (let end = start + 1; end <= maxEnd; end += 1) {
    const previous = tokens[end - 1];
    const current = tokens[end];
    if (
      !current ||
      current.kind !== LexKind.Word ||
      previous.sourceEnd !== current.sourceStart
    ) {
      break;
    }
    const sourceText = input.slice(first.sourceStart, current.sourceEnd);
    if (isKnownThaiDomainTerm(sourceText)) {
      bestEnd = end;
    }
  }
  if (bestEnd < 0) {
    return undefined;
  }
  const sourceText = input.slice(first.sourceStart, tokens[bestEnd].sourceEnd).toLowerCase();
  return {
    token: mergeSourceSpan(
      tokens,
      start,
      bestEnd,
      input,
      canonicalThaiLexeme(sourceText)
    ),
    length: bestEnd - start + 1
  };
}

function phraseMatches(tokens: readonly LexToken[], start: number, phrase: LocalePhrase): boolean {
  if (start + phrase.parts.length > tokens.length) {
    return false;
  }
  for (let offset = 0; offset < phrase.parts.length; offset += 1) {
    const token = tokens[start + offset];
    if (!token || token.kind !== LexKind.Word || token.lower !== phrase.parts[offset]) {
      return false;
    }
  }
  return true;
}

function mergePhrase(
  tokens: readonly LexToken[],
  start: number,
  phrase: LocalePhrase,
  input: string
): LexToken {
  return mergeSourceSpan(
    tokens,
    start,
    start + phrase.parts.length - 1,
    input,
    phrase.canonical
  );
}

export interface MedicationLocaleLexeme {
  surface: string;
  canonical: string;
}

/** Parser-owned locale lexemes for bounded autocomplete/discovery surfaces. */
export function listMedicationLocaleLexemes(locale: string): MedicationLocaleLexeme[] {
  if (!locale.toLowerCase().startsWith("th")) return [];
  const result: MedicationLocaleLexeme[] = [];
  const seen = new Set<string>();
  const add = (surface: string, canonical: string | undefined) => {
    const clean = surface.trim();
    if (!clean || !canonical || seen.has(clean)) return;
    seen.add(clean);
    result.push({ surface: clean, canonical });
  };
  for (const surface in THAI_LEXEME_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(THAI_LEXEME_ALIASES, surface)) {
      add(surface, THAI_LEXEME_ALIASES[surface]);
    }
  }
  for (const surface in DECLARATIVE_THAI_CANONICAL) {
    if (Object.prototype.hasOwnProperty.call(DECLARATIVE_THAI_CANONICAL, surface)) {
      add(surface, DECLARATIVE_THAI_CANONICAL[surface]);
    }
  }
  for (const phrase of THAI_PHRASES) {
    add(phrase.parts.join(""), phrase.canonical);
  }
  return result;
}

export function applyLocaleLexicon(tokens: readonly LexToken[], input: string): LexToken[] {
  const prepared = splitThaiGrammarPrefixTokens(splitThaiDistributiveUnitTokens(tokens));
  const normalized: LexToken[] = [];
  let cursor = 0;

  while (cursor < prepared.length) {
    const knownCompound = knownDomainCompoundAt(prepared, cursor, input);
    if (knownCompound) {
      normalized.push(knownCompound.token);
      cursor += knownCompound.length;
      continue;
    }

    let matchedPhrase: LocalePhrase | undefined;
    for (const phrase of THAI_PHRASES) {
      if (phraseMatches(prepared, cursor, phrase)) {
        matchedPhrase = phrase;
        break;
      }
    }
    if (matchedPhrase) {
      normalized.push(mergePhrase(prepared, cursor, matchedPhrase, input));
      cursor += matchedPhrase.parts.length;
      continue;
    }

    const token = prepared[cursor];
    const canonical = canonicalThaiLexeme(token.lower);
    normalized.push(canonical ? { ...token, canonical } : { ...token });
    cursor += 1;
  }

  for (let index = 0; index < normalized.length; index += 1) {
    normalized[index].index = index;
  }
  return normalized;
}
