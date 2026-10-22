import { MedicationCondition } from "./types";

// Bare "if" is a guard when its clause contains an explicit numeric
// measurement comparison. Bare "if pain" retains the existing PRN grammar.
const NUMERIC_IF_GUARD = /\bif\b(?=\s+[^,;]*?(?:>=|<=|>|<|\b(?:above|below|greater\s+than|less\s+than|at\s+least|at\s+most)\b)\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+))/iu;
const GUARD_LEAD = /\bonly\s+if\b|\bunless\b|เฉพาะ(?:เมื่อ|หาก)|เว้นแต่|ยกเว้นกรณี(?:ที่)?/iu;
const TRAILING_ELSE = /(?:,\s*|\s+)\b(?:otherwise|else)\s+(hold|do\s+not\s+take|skip)\s*\.?$|(?:มิฉะนั้น|ไม่เช่นนั้น)\s*(?:งด|หยุด|ไม่ต้อง)(?:ยา|กิน|รับประทาน)?\s*$/iu;
const ACTION_LEAD = /\b(?:take|give|administer|apply|instill|use|inject|infuse)\b|(?:รับประทาน|กิน|หยอด|ใช้|ทา|ฉีด|ให้ยา)/iu;
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const OPERATOR = String.raw`(?:>=|<=|>|<|==|=|\b(?:greater\s+than|at\s+least|no\s+less\s+than|above|over|less\s+than|at\s+most|below|under|no\s+more\s+than|equal\s+to|equals?)\b|มากกว่า|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า|ต่ำกว่า|น้อยกว่า|ไม่เกิน|เท่ากับ)`;
const MEASUREMENT = new RegExp(`^(.+?)\\s*(${OPERATOR})\\s*(${NUMBER})\\s*(%|mmhg|mg/dl|mmol/l|bpm|°c|c|องศา)?$`, "iu");
const SEPARATOR_OR = /\s+or\s+|\s*หรือ\s*/iu;
const SEPARATOR_AND = /\s+and\s+|\s*และ\s*/iu;

function canonicalOperator(value: string): "gt" | "ge" | "lt" | "le" | "eq" {
  const term = value.toLowerCase().replace(/\s+/gu, " ").trim();
  if (/^(?:>=|at least|no less than|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า)$/iu.test(term)) return "ge";
  if (/^(?:<=|at most|no more than|ไม่เกิน)$/iu.test(term)) return "le";
  if (/^(?:>|above|over|greater than|มากกว่า)$/iu.test(term)) return "gt";
  if (/^(?:<|below|under|less than|ต่ำกว่า|น้อยกว่า)$/iu.test(term)) return "lt";
  return "eq";
}

function stateName(value: string): string {
  return value.trim()
    .replace(/^(?:the\s+)?(?:patient\s+)?(?:has|have|is|experiences|develops)\s+/iu, "")
    .replace(/^(?:มีอาการ|มี)\s*/u, "")
    .replace(/[\s,.;]+$/gu, "").trim();
}

function parseAtom(input: string): MedicationCondition {
  const text = input.trim();
  const numeric = text.match(MEASUREMENT);
  if (numeric && numeric[1].trim() && Number.isFinite(Number(numeric[3]))) {
    return {
      kind: "measurement",
      name: numeric[1].trim().replace(/\s+/gu, " ").toLowerCase(),
      operation: canonicalOperator(numeric[2]),
      value: Number(numeric[3]),
      ...(numeric[4] ? { unit: numeric[4] } : {}),
      text
    };
  }
  const state = stateName(text);
  if (state && !/^(?:the|and|or|then|only|when|if)$/iu.test(state)) {
    // English adverbs/other conditional clauses remain free-text decisions.
    if (/\b(?:approves?|decides?|allowed|requested|instructed|told|agrees?)\b|อนุญาต|สั่งโดย/u.test(state)) {
      return { kind: "text", text };
    }
    return { kind: "state", name: state.toLowerCase(), expected: true, text };
  }
  return { kind: "text", text };
}

function parseAnd(text: string): MedicationCondition {
  const parts = text.split(SEPARATOR_AND).map(part => part.trim()).filter(Boolean);
  return parts.length > 1
    ? { kind: "all", conditions: parts.map(parseAtom) }
    : parseAtom(text);
}

function parseExpression(text: string): MedicationCondition {
  const parts = text.split(SEPARATOR_OR).map(part => part.trim()).filter(Boolean);
  return parts.length > 1
    ? { kind: "any", conditions: parts.map(parseAnd) }
    : parseAnd(text);
}

export interface ParsedMedicationGuard {
  condition: MedicationCondition;
  start: number;
  end: number;
  text: string;
  /** The specified alternative action is a no-dose (hold/skip). */
  otherwiseHold: boolean;
  /** Distinct source span of an explicit otherwise-hold action. */
  otherwise?: { start: number; end: number };
}

/**
 * Generic Boolean conditional grammar independent of disease names:
 * - a measurement compared with a number
 * - a symptom / observed state
 * - all/any conjunctions, not, and free-text dependent observations
 * A free-text guard is NOT ignored: scheduling requires a caller evaluator.
 */
export function parseMedicationGuard(source: string): ParsedMedicationGuard | undefined {
  const lead = GUARD_LEAD.exec(source) ?? NUMERIC_IF_GUARD.exec(source);
  if (!lead) return undefined;
  const negated = /^(?:unless|เว้นแต่|ยกเว้นกรณี)/iu.test(lead[0]);
  let tail = source.slice(lead.index + lead[0].length);
  let end = source.length;
  let otherwise: { start: number; end: number } | undefined;
  let otherwiseHold = false;
  const elseMatch = TRAILING_ELSE.exec(tail);
  if (elseMatch) {
    otherwiseHold = true;
    end -= elseMatch[0].length;
    otherwise = { start: source.length - elseMatch[0].length, end: source.length };
    tail = tail.slice(0, elseMatch.index);
  } else if (/\b(?:otherwise|else)\b|มิฉะนั้น|ไม่เช่นนั้น/iu.test(tail)) {
    // A different alternate *dose* is not the same as withholding the dose.
    return undefined;
  }
  // Prefixed guards have an explicit boundary before the administration.
  if (lead.index === source.search(/\S/u)) {
    const comma = tail.search(/[,;:]/u);
    const action = ACTION_LEAD.exec(tail);
    const cut = [comma >= 0 ? comma : tail.length, action?.index ?? tail.length]
      .reduce((a, b) => Math.min(a, b), tail.length);
    if (cut < tail.length) { end = Math.min(end, lead.index + lead[0].length + cut); tail = tail.slice(0, cut); }
  }
  const phrase = tail.trim().replace(/[.!?;,]+$/gu, "").trim();
  if (!phrase) return undefined;
  const expression = parseExpression(phrase);
  const condition: MedicationCondition = negated
    ? { kind: "not", condition: expression }
    : expression;
  return {
    condition, start: lead.index, end,
    text: source.slice(lead.index, end),
    otherwiseHold,
    ...(otherwise ? { otherwise } : {})
  };
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
