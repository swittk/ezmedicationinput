import { MedicationCondition } from "./types";
import lexicalSource from "./hpsg/lexical-classes.json";

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
const OPERATOR = String.raw`(?:>=|<=|>|<|==|=|\b(?:greater\s+than|at\s+least|no\s+less\s+than|above|over|less\s+than|at\s+most|below|under|no\s+more\s+than|equal\s+to|equals?)\b|มากกว่า|สูงกว่า|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า|ต่ำกว่า|น้อยกว่า|ไม่เกิน|เท่ากับ)`;
// The guard lead and its measurement daughter share one comparison grammar.
// Otherwise a valid operator (e.g. "under") can be consumed as mere advice.
const NUMERIC_IF_GUARD = new RegExp(
  String.raw`(?:\bif\b\s+|หาก\s*|ถ้า\s*|เมื่อ\s*)(?=[^,;]*?${OPERATOR}\s*${NUMBER})`, "iu"
);
const MEASUREMENT_UNIT = String.raw`(?:%|mmhg|mg/dl|mmol/l|bpm|kg|lbs?|°c|c|องศา)`;
const MEASUREMENT = new RegExp(`^(.+?)\\s*(${OPERATOR})\\s*(${NUMBER})\\s*(${MEASUREMENT_UNIT})?$`, "iu");
const HEADLESS_MEASUREMENT = new RegExp(`^(${OPERATOR})\\s*(${NUMBER})\\s*(${MEASUREMENT_UNIT})?$`, "iu");
const SEPARATOR_OR = /\s+or\s+|\s*หรือ\s*/iu;
const SEPARATOR_AND = /\s+and\s+|\s*และ\s*/iu;
const ALTERNATE_CUE = /(?:[,;]\s*|\s+)\b(?:otherwise|else)\b|(?:มิฉะนั้น|ไม่เช่นนั้น)/iu;

function canonicalOperator(value: string): "gt" | "ge" | "lt" | "le" | "eq" {
  const term = value.toLowerCase().replace(/\s+/gu, " ").trim();
  if (/^(?:>=|at least|no less than|ตั้งแต่|อย่างน้อย|ไม่ต่ำกว่า)$/iu.test(term)) return "ge";
  if (/^(?:<=|at most|no more than|ไม่เกิน)$/iu.test(term)) return "le";
  if (/^(?:>|above|over|greater than|มากกว่า|สูงกว่า)$/iu.test(term)) return "gt";
  if (/^(?:<|below|under|less than|ต่ำกว่า|น้อยกว่า)$/iu.test(term)) return "lt";
  return "eq";
}

function stateName(value: string): string {
  return value.trim()
    .replace(/^(?:the\s+)?(?:patient\s+)?(?:has|have|is|experiences|develops)\s+/iu, "")
    .replace(/^(?:มีอาการ|มี)\s*/u, "")
    .replace(/[\s,.;]+$/gu, "").trim();
}

interface MeasurementHead {
  name: string;
  unit?: string;
}

function parseAtom(input: string, inheritedHead?: MeasurementHead): MedicationCondition {
  const text = input.trim();
  const numeric = text.match(MEASUREMENT);
  if (numeric && numeric[1].trim() && Number.isFinite(Number(numeric[3]))) {
    const rawName = numeric[1].trim().replace(/\s+(?:is|are)$/iu, "").replace(/\s+/gu, " ").toLowerCase();
    return {
      kind: "measurement",
      name: MEASUREMENT_NAME_ALIASES.get(rawName) ?? rawName,
      operation: canonicalOperator(numeric[2]),
      value: Number(numeric[3]),
      ...(numeric[4] ? { unit: numeric[4] } : {}),
      text
    };
  }
  const headless = inheritedHead ? text.match(HEADLESS_MEASUREMENT) : undefined;
  if (headless && inheritedHead && Number.isFinite(Number(headless[2]))) {
    return {
      kind: "measurement",
      name: inheritedHead.name,
      operation: canonicalOperator(headless[1]),
      value: Number(headless[2]),
      ...(headless[3] || inheritedHead.unit
        ? { unit: headless[3] ?? inheritedHead.unit }
        : {}),
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

function lastMeasurementHead(condition: MedicationCondition): MeasurementHead | undefined {
  const last = condition.kind === "all" || condition.kind === "any"
    ? condition.conditions[condition.conditions.length - 1]
    : condition;
  if (!last) return undefined;
  if (last.kind === "measurement") {
    return { name: last.name, ...(last.unit ? { unit: last.unit } : {}) };
  }
  return last.kind === "all" || last.kind === "any"
    ? lastMeasurementHead(last) : undefined;
}

function hasTypedMeasurement(condition: MedicationCondition): boolean {
  if (condition.kind === "measurement") return true;
  if (condition.kind === "all" || condition.kind === "any") {
    return condition.conditions.some(hasTypedMeasurement);
  }
  if (condition.kind === "not") return hasTypedMeasurement(condition.condition);
  return false;
}

function parseAnd(text: string, inheritedHead?: MeasurementHead): MedicationCondition {
  const parts = text.split(SEPARATOR_AND).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return parseAtom(text, inheritedHead);
  const conditions: MedicationCondition[] = [];
  let sharedHead = inheritedHead;
  for (const part of parts) {
    const condition = parseAtom(part, sharedHead);
    conditions.push(condition);
    sharedHead = lastMeasurementHead(condition);
  }
  return { kind: "all", conditions };
}

function parseExpression(text: string): MedicationCondition {
  const parts = text.split(SEPARATOR_OR).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return parseAnd(text);
  const conditions: MedicationCondition[] = [];
  let sharedHead: MeasurementHead | undefined;
  for (const part of parts) {
    const condition = parseAnd(part, sharedHead);
    conditions.push(condition);
    // An omitted head in the next alternative is licensed by an adjacent
    // typed measurement constituent, not arbitrary text or a new parse pass.
    sharedHead = lastMeasurementHead(condition);
  }
  return { kind: "any", conditions };
}

function trailingClauseBoundary(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "," || ch === ";") return index;
    if (ch === "!" || ch === "?") return index;
    if (ch === ".") {
      const previousDigit = index > 0 && /\d/u.test(text[index - 1]);
      const nextDigit = index + 1 < text.length && /\d/u.test(text[index + 1]);
      if (!previousDigit || !nextDigit) return index;
    }
  }
  return text.length;
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
  /** Source span of the generic ELSE branch marker, independent of payload. */
  alternative?: { start: number; end: number };
}

/**
 * Generic Boolean conditional grammar independent of disease names:
 * - a measurement compared with a number
 * - a symptom / observed state
 * - all/any conjunctions, not, and free-text dependent observations
 * A free-text guard is NOT ignored: scheduling requires a caller evaluator.
 */
export function parseMedicationGuard(source: string): ParsedMedicationGuard | undefined {
  const explicitLead = GUARD_LEAD.exec(source);
  const lead = explicitLead ?? NUMERIC_IF_GUARD.exec(source);
  if (!lead) return undefined;
  const negated = /^(?:unless|เว้นแต่|ยกเว้นกรณี)/iu.test(lead[0]);
  const tailStart = lead.index + lead[0].length;
  let tail = source.slice(tailStart);
  let end = source.length;
  let otherwise: { start: number; end: number } | undefined;
  let otherwiseHold = false;
  const alternateCue = ALTERNATE_CUE.exec(tail);
  const alternative = alternateCue
    ? {
        start: tailStart + alternateCue.index,
        end: tailStart + alternateCue.index + alternateCue[0].length
      }
    : undefined;
  const elseMatch = OTHERWISE_HOLD.exec(tail);
  if (elseMatch) {
    otherwiseHold = true;
    end = tailStart + elseMatch.index;
    otherwise = { start: end, end: end + elseMatch[0].length };
    tail = tail.slice(0, elseMatch.index);
  } else {
    if (alternateCue) {
      // A different alternate dose is not a withholding action, but it does
      // not erase the typed guard on the first administration. End this
      // constituent before ELSE and leave the alternate branch unconsumed for
      // regimen coordination.
      end = tailStart + alternateCue.index;
      tail = tail.slice(0, alternateCue.index);
    }
  }
  // Prefixed guards end before the administration. Suffixed guards end at
  // the next clause boundary so trailing maxima/advice remain independently
  // parseable rather than becoming part of the Boolean condition.
  if (lead.index === source.search(/\S/u)) {
    const comma = tail.search(/[,;:]/u);
    const action = ACTION_LEAD.exec(tail);
    const cut = [comma >= 0 ? comma : tail.length, action?.index ?? tail.length]
      .reduce((a, b) => Math.min(a, b), tail.length);
    if (cut < tail.length) {
      end = Math.min(end, lead.index + lead[0].length + cut);
      tail = tail.slice(0, cut);
    }
  } else {
    const cut = trailingClauseBoundary(tail);
    if (cut < tail.length) {
      end = Math.min(end, lead.index + lead[0].length + cut);
      tail = tail.slice(0, cut);
    }
  }
  const phrase = tail.trim().replace(/[.!?;,]+$/gu, "").trim();
  if (!phrase) return undefined;
  const expression = parseExpression(phrase);
  // A numeric-looking IF/WHEN is not a medication guard merely because
  // a later maximum-dose adjunct mentions a number (Thai symptom PRN +
  // "no more than 3/day"). Only the typed measurement daughter licenses it.
  if (!explicitLead && !hasTypedMeasurement(expression)) return undefined;
  const condition: MedicationCondition = negated
    ? { kind: "not", condition: expression }
    : expression;
  return {
    condition, start: lead.index, end,
    text: source.slice(lead.index, end),
    otherwiseHold,
    ...(otherwise ? { otherwise } : {}),
    ...(alternative ? { alternative } : {})
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
