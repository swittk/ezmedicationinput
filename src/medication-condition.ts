import { MedicationCondition } from "./types";
import type { HpsgGuardExpression, HpsgGuardFeature } from "./hpsg/signature";
import lexicalSource from "./hpsg/lexical-classes.json";

// One public entry point, implemented by the HPSG constituent grammar. This
// module supplies lexical atoms and pure evaluation, never Boolean attachment.
export { parseMedicationGuard } from "./hpsg/constructions";
export type { ParsedMedicationGuard } from "./hpsg/constructions";

const MEASUREMENT_NAME_ALIASES = new Map<string, string>(
  Object.keys(lexicalSource.measurementNameAliases).map(name =>
    [name, (lexicalSource.measurementNameAliases as Record<string, string>)[name]])
);

// Bare "if" is a guard when its clause contains an explicit numeric
// measurement comparison. Bare "if pain" retains the existing PRN grammar.
const GUARD_LEAD = /\bonly\s+if\b|\bunless\b|เฉพาะ(?:เมื่อ|หาก)|เว้นแต่|ยกเว้นกรณี(?:ที่)?/iu;
// A no-dose consequent may be followed by another coordinated instruction.
// Only the hold/skip constituent belongs to the guard's source ownership;
// later advice remains available to the shared procedural grammar.
const OTHERWISE_HOLD = /(?:[,;]\s*|\s+)\b(?:otherwise|else)\s+(?:hold|do\s+not\s+take|skip)\b(?=\s*(?:$|[.,;!?])|\s+(?:and|then)\b)|(?:มิฉะนั้น|ไม่เช่นนั้น)\s*(?:งด|หยุด|ไม่ต้อง)(?:ยา|กิน|รับประทาน)?(?=\s*(?:$|[.,;!?]|และ|แล้ว|จากนั้น))/iu;
const ACTION_LEAD = /\b(?:take|give|administer|apply|instill|use|inject|infuse)\b|(?:รับประทาน|กิน|หยอด|ใช้|ทา|ฉีด|ให้ยา)/iu;
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const OPERATOR = String.raw`(?:>=|<=|>|<|==|=|\b(?:not\s+less\s+than|not\s+below|not\s+under|not\s+more\s+than|not\s+greater\s+than|not\s+above|not\s+over|greater\s+than|exceeds?|at\s+least|no\s+less\s+than|above|over|less\s+than|at\s+most|below|under|no\s+more\s+than|equal\s+to|equals?)\b|ไม่น้อยกว่า|ไม่มากกว่า|ไม่สูงกว่า|มากกว่า|สูงกว่า|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า|ต่ำกว่า|น้อยกว่า|ไม่เกิน|เท่ากับ)`;
// The guard lead and its measurement daughter share one comparison grammar.
// Otherwise a valid operator (e.g. "under") can be consumed as mere advice.
const NUMERIC_IF_GUARD = new RegExp(
  String.raw`(?:\bif\b\s+|หาก\s*|ถ้า\s*|เมื่อ\s*)(?=[^,;]*?(?:${OPERATOR}|\b(?:increases?|decreases?|rises?|falls?|gains?|drops?)\s+by)\s*${NUMBER})`, "iu"
);
// Qualified day membership (e.g. a named treatment/work day) is a
// context-dependent condition, not a recurrence or a symptom PRN phrase.
// The caller supplies membership; this lexical constituent invents no dates.
// Daily recurrence is not a named calendar-day condition. This applies
// regardless of whether a PRN reason precedes the cadence ("if pain each day").
const CONTEXT_DAY_IF_GUARD = /\bif\s+(?=(?:(?:it\s+is\s+)?(?:an?|the)\s+)?(?!(?:[\p{L}-]+\s+)?(?:every|each)\s+days?\b)(?:[\p{L}-]+\s+){1,2}days?\b\s*(?:[,;.!?]|$))|(?:หาก|ถ้า|เมื่อ)\s*(?=(?:เป็น)?วัน[^\d,;.!?]+(?:[,;.!?]|$))/iu;
const CONTEXT_DAY_NOMINAL = /^(?:(?:(?:it\s+is\s+)?(?:an?|the)\s+)?(?!(?:[\p{L}-]+\s+)?(?:every|each)\s+days?\b)(?:[\p{L}-]+\s+){1,2}days?|(?:เป็น)?วัน[^\d,;.!?]+)$/iu;
const MEASUREMENT_UNIT = String.raw`(?:%|mmhg|mg/dl|mmol/l|bpm|kg|lbs?|°c|c|องศา)`;
const MEASUREMENT = new RegExp(`^(.+?)\\s*(${OPERATOR})\\s*(${NUMBER})\\s*(${MEASUREMENT_UNIT})?$`, "iu");
const HEADLESS_MEASUREMENT = new RegExp(`^(${OPERATOR})\\s*(${NUMBER})\\s*(${MEASUREMENT_UNIT})?$`, "iu");
// A change observation and its lookback duration are one conditional
// constituent, not an administration amount followed by a treatment course.
const MEASUREMENT_CHANGE = new RegExp(
  String.raw`^(.+?)\s+(?:increases?|decreases?|rises?|falls?|gains?|drops?)\s+by\s*${NUMBER}\s*${MEASUREMENT_UNIT}$`, "iu"
);
const OBSERVATION_WINDOW = new RegExp(
  String.raw`^(.+?)\s+(?:in|over|within|during)\s+${NUMBER}\s*(?:hours?|hrs?|h|days?|d|weeks?|wk|minutes?|mins?|min)$`, "iu"
);
const ALTERNATE_CUE = /(?:[,;]\s*|\s+)\b(?:otherwise|else)\b|(?:มิฉะนั้น|ไม่เช่นนั้น)/iu;

function canonicalOperator(value: string): "gt" | "ge" | "lt" | "le" | "eq" {
  const term = value.toLowerCase().replace(/\s+/gu, " ").trim();
  if (/^(?:>=|at least|no less than|not less than|not below|not under|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า|ไม่น้อยกว่า)$/iu.test(term)) return "ge";
  if (/^(?:<=|at most|no more than|not more than|not greater than|not above|not over|ไม่เกิน|ไม่มากกว่า|ไม่สูงกว่า)$/iu.test(term)) return "le";
  if (/^(?:>|above|over|greater than|exceeds?|มากกว่า|สูงกว่า)$/iu.test(term)) return "gt";
  if (/^(?:<|below|under|less than|ต่ำกว่า|น้อยกว่า)$/iu.test(term)) return "lt";
  return "eq";
}

function stateName(value: string): string {
  return value.trim()
    .replace(/^(?:the\s+)?(?:patient\s+)?(?:has|have|is|experiences|develops)\s+/iu, "")
    .replace(/^(?:มีอาการ|มี)\s*/u, "")
    .replace(/[\s,.;]+$/gu, "").trim();
}


const CIRCUMSTANTIAL_GUARD_LEAD = new RegExp(
  "\\b(?:" + lexicalSource.circumstantialConditionLeads.map(parts => parts.join("\\s+")).join("|") + ")\\s+", "iu"
);
export const CIRCUMSTANTIAL_CONDITION_HEADS = new Set(
  lexicalSource.circumstantialConditionLeads.map(parts => parts[0])
);
const BARE_CONDITIONAL_LEAD = /\bif\s+|(?:หาก|ถ้า|เมื่อ)\s*/iu;

export interface MedicationGuardLeadLexeme {
  start: number;
  end: number;
  marker: "if" | "only-if" | "unless";
  circumstantial?: true;
}

/** Recognize a conditional marker's spelling, leaving its predicate licensing
 * and scope to the HPSG guard-head construction. */
export function medicationGuardLeadLexeme(source: string, licensedConsequent = false): MedicationGuardLeadLexeme | undefined {
  const explicit = GUARD_LEAD.exec(source);
  const numeric = explicit ? undefined : NUMERIC_IF_GUARD.exec(source);
  const day = explicit || numeric ? undefined : CONTEXT_DAY_IF_GUARD.exec(source);
  const circumstance = licensedConsequent ? CIRCUMSTANTIAL_GUARD_LEAD.exec(source) : undefined;
  const bare = licensedConsequent ? BARE_CONDITIONAL_LEAD.exec(source) : undefined;
  const lead = explicit ?? numeric ?? day ?? circumstance ?? bare;
  if (!lead) return undefined;
  return { start: lead.index, end: lead.index + lead[0].length,
    marker: /^(?:unless|เว้นแต่|ยกเว้นกรณี)/iu.test(lead[0]) ? "unless" : explicit ? "only-if" : "if",
    ...(lead === circumstance ? { circumstantial: true as const } : {}) };

}

/** Lexical boundary spellings shared with the typed guard phrase. No result
 * from these recognizers is itself a medication condition or administration. */
export const MEDICATION_GUARD_BOUNDARIES = {
  alternative: ALTERNATE_CUE,
  noDoseConsequent: OTHERWISE_HOLD,
  administrationHead: ACTION_LEAD
};

/** Recognize one predicate atom. Incomplete comparisons remain unsatisfied
 * head requirements, not measurements with a guessed variable name. */
export function medicationConditionAtomLexeme(input: string): HpsgGuardFeature {
  const text = input.trim();
  const observationWindow = text.match(OBSERVATION_WINDOW);
  const observationHead = observationWindow?.[1] ?? text;
  const dayInvariant = CONTEXT_DAY_NOMINAL.test(text);
  if (MEASUREMENT_CHANGE.test(observationHead) ||
      observationWindow && MEASUREMENT.test(observationHead) || dayInvariant) {
    return { expression: { kind: "predicate", value: { kind: "text", text },
      ...(dayInvariant ? { dayInvariant: true as const } : {}) }, licensesBareIf: true };
  }
  const numeric = text.match(MEASUREMENT);
  if (numeric && numeric[1].trim() && Number.isFinite(Number(numeric[3]))) {
    const rawName = numeric[1].trim().replace(/\s+(?:is|are)$/iu, "").replace(/\s+/gu, " ").toLowerCase();
    return { expression: { kind: "predicate", value: {
      kind: "measurement", name: MEASUREMENT_NAME_ALIASES.get(rawName) ?? rawName,
      operation: canonicalOperator(numeric[2]), value: Number(numeric[3]),
      ...(numeric[4] ? { unit: numeric[4] } : {}), text
    } }, licensesBareIf: true };
  }
  const headless = text.match(HEADLESS_MEASUREMENT);
  if (headless && Number.isFinite(Number(headless[2]))) {
    return { expression: { kind: "measurement-complement", operation: canonicalOperator(headless[1]),
      value: Number(headless[2]), ...(headless[3] ? { unit: headless[3] } : {}), text } };
  }
  const state = stateName(text);
  const predicate: MedicationCondition = state && !/^(?:the|and|or|then|only|when|if)$/iu.test(state) &&
      !/\b(?:approves?|decides?|allowed|requested|instructed|told|agrees?)\b|อนุญาต|สั่งโดย/u.test(state)
    ? { kind: "state", name: state.toLowerCase(), expected: true, text }
    : { kind: "text", text };
  return { expression: { kind: "predicate", value: predicate } };
}

/** Recognize a predicate negator, not the beginning of a comparison idiom.
 * @param source One predicate atom before Boolean coordination.
 */
export function conditionNegationPrefixLength(source: string): number | undefined {
  if (HEADLESS_MEASUREMENT.test(source)) return undefined;
  const negator = /^(?:not\s+|no\s+|ไม่มี|ไม่)/iu.exec(source);
  return negator && negator[0].length < source.length ? negator[0].length : undefined;
}

export interface ConditionSourceLexeme {
  start: number;
  end: number;
  operator?: "all" | "any";
}

/** Lexicalize Boolean connective surfaces without assigning a tree or scope. */
export function conditionSourceLexemes(source: string, start: number, end: number): ConditionSourceLexeme[] {
  const result: ConditionSourceLexeme[] = [];
  const text = source.slice(start, end);
  const connectors = /\s+or\s+|\s*หรือ\s*|\s+and\s+|\s*และ\s*/giu;
  let cursor = 0;
  const appendAtom = (from: number, to: number) => {
    while (from < to && /\s/u.test(text[from])) from++;
    while (to > from && /\s/u.test(text[to - 1])) to--;
    if (to > from) result.push({ start: start + from, end: start + to });
  };
  for (let match = connectors.exec(text); match; match = connectors.exec(text)) {
    appendAtom(cursor, match.index);
    result.push({ start: start + match.index, end: start + match.index + match[0].length,
      operator: /^(?:or|หรือ)$/iu.test(match[0].trim()) ? "any" : "all" });
    cursor = match.index + match[0].length;
  }
  appendAtom(cursor, text.length);
  return result;
}

/** Punctuation boundary excluding decimal points inside lexical quantities. */
export function medicationGuardClauseBoundary(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "," || ch === ";" || ch === "!" || ch === "?") return index;
    if (ch === ".") {
      const previousDigit = index > 0 && /\d/u.test(text[index - 1]);
      const nextDigit = index + 1 < text.length && /\d/u.test(text[index + 1]);
      if (!previousDigit || !nextDigit) return index;
    }
  }
  return text.length;
}

/**
 * Evaluate a typed Boolean tree if observation values were supplied by the caller.
 * Unknown measurements never evaluate to true and remain unevaluated.
 */
export function evaluateMedicationCondition(
  condition: MedicationCondition,
  observed: Record<string, number | boolean>
): boolean | undefined {
  switch (condition.kind) {
    case "measurement": {
      const value = observed[condition.name];
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      switch (condition.operation) {
        case "gt": return value > condition.value;
        case "ge": return value >= condition.value;
        case "lt": return value < condition.value;
        case "le": return value <= condition.value;
        case "eq": return value === condition.value;
        case "ne": return value !== condition.value;
      }
    }
    case "state": {
      const value = observed[condition.name];
      return typeof value === "boolean" ? value === condition.expected : undefined;
    }
    case "text": return undefined;
    case "not": {
      const value = evaluateMedicationCondition(condition.condition, observed);
      return value === undefined ? undefined : !value;
    }
    case "all": {
      let unresolved = false;
      for (const part of condition.conditions) {
        const value = evaluateMedicationCondition(part, observed);
        if (value === false) return false;
        if (value === undefined) unresolved = true;
      }
      return unresolved ? undefined : true;
    }
    case "any": {
      let unresolved = false;
      for (const part of condition.conditions) {
        const value = evaluateMedicationCondition(part, observed);
        if (value === true) return true;
        if (value === undefined) unresolved = true;
      }
      return unresolved ? undefined : false;
    }
  }
}
