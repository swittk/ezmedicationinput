import { describe, expect, it } from "vitest";
import cases from "./generation-roundtrip-cases.json";
import thaiCases from "./generation-roundtrip-thai-cases.json";
import crossLanguageCases from "./generation-cross-language-cases.json";
import { formatSig, parseSig } from "../src/index";
import type { AdviceArgument, AdviceFrame, CanonicalSigClause } from "../src/types";

type Result = ReturnType<typeof parseSig>;

const text = (v: unknown) => String(v ?? "").toLowerCase().replace(/[\s,;:.()]+/g, " ").trim();
const key = (concept: any) => {
  const coding = concept?.coding?.[0];
  return coding?.code ? `${coding.system ?? ""}|${coding.code}` : text(concept?.text);
};
const q = (value: any) => value ? { value: value.value, unit: value.unit } : undefined;

function dose(result: Result): unknown {
  const entry = result.fhir.doseAndRate?.[0];
  if (entry?.doseQuantity) return { quantity: q(entry.doseQuantity) };
  if (entry?.doseRange) return { range: { low: q(entry.doseRange.low), high: q(entry.doseRange.high) } };
  return undefined;
}

function schedule(clause: CanonicalSigClause | undefined): unknown {
  const s = clause?.schedule;
  if (!s) return undefined;
  const value = {
    count: s.count, duration: s.duration, durationMax: s.durationMax, durationUnit: s.durationUnit,
    frequency: s.frequency, frequencyMax: s.frequencyMax, period: s.period, periodMax: s.periodMax,
    periodUnit: s.periodUnit, dayOfWeek: [...(s.dayOfWeek ?? [])].sort(),
    when: [...(s.when ?? [])].sort(), timeOfDay: [...(s.timeOfDay ?? [])].sort()
  };
  return Object.values(value).some((x) => Array.isArray(x) ? x.length : x !== undefined) ? value : undefined;
}

function methodMatches(action: AdviceFrame, result: Result): boolean {
  const coding = result.fhir.method?.coding?.[0];
  if (coding?.code && action.predicate.codings?.some((candidate) =>
    candidate.code === coding.code &&
    (candidate.system ?? "http://snomed.info/sct") === (coding.system ?? "http://snomed.info/sct")
  )) return true;
  const method = text(result.fhir.method?.text);
  return Boolean(method && [action.predicate.lemma, action.predicate.display].map(text).filter(Boolean)
    .some((candidate) => candidate === method || method.includes(candidate) || candidate.includes(method)));
}

function amountCovered(arg: AdviceArgument, result: Result): boolean {
  if (!arg.quantity) return false;
  const entry = result.fhir.doseAndRate?.[0];
  if (entry?.doseQuantity) return arg.quantity.value === entry.doseQuantity.value && arg.quantity.unit === entry.doseQuantity.unit;
  if (entry?.doseRange) return arg.quantity.range?.low === entry.doseRange.low?.value &&
    arg.quantity.range?.high === entry.doseRange.high?.value && arg.quantity.unit === entry.doseRange.low?.unit;
  return false;
}

function siteCovered(arg: AdviceArgument, result: Result): boolean {
  const coding = result.fhir.site?.coding?.[0];
  if (coding?.code && arg.coding?.code === coding.code &&
      (arg.coding.system ?? "http://snomed.info/sct") === (coding.system ?? "http://snomed.info/sct")) return true;
  return Boolean(text(arg.normalized ?? arg.text) && text(arg.normalized ?? arg.text) === text(result.fhir.site?.text));
}

const FILLER = new Set("a an the medication medicine drug via route oral orally ophthalmic otic nasal intravitreal inhalation topical topically transdermal transdermally subcutaneous subcutaneously intramuscular intramuscularly intravenous intravenously rectal rectally vaginal vaginally once twice daily day per times".split(" "));
function freeCovered(arg: AdviceArgument, result: Result): boolean {
  if (arg.role !== "object" && arg.role !== "theme") return false;
  const words = text(arg.text).split(/\s+/).filter(Boolean);
  const timed = Boolean(result.meta.canonical.clauses[0]?.schedule);
  return words.length > 0 && words.every((word) => FILLER.has(word) || (timed && /^[0-9]+(?:\.[0-9]+)?$/.test(word)));
}

function fullyCanonical(action: AdviceFrame, result: Result): boolean {
  return action.polarity !== "negate" && methodMatches(action, result) && action.args.every((arg) =>
    (arg.role === "site" && siteCovered(arg, result)) ||
    (arg.role === "amount" && amountCovered(arg, result)) || freeCovered(arg, result)
  );
}

function argFingerprint(arg: AdviceArgument): unknown {
  const coding = arg.coding?.code ? `${arg.coding.system ?? ""}|${arg.coding.code}` : arg.conceptId;
  return {
    role: arg.role,
    coding,
    quantity: arg.quantity ? { value: arg.quantity.value, range: arg.quantity.range, unit: arg.quantity.unit } : undefined,
    text: !coding && !arg.quantity ? text(arg.normalized ?? arg.text) : undefined
  };
}

function graph(result: Result): unknown {
  const g = result.meta.canonical.clauses[0]?.instructionGraph;
  if (!g) return { actions: [], relations: [], opaque: [] };
  const actions = g.actions ?? [];
  let primary = -1;
  for (let i = 0; i < actions.length; i += 1) {
    if (methodMatches(actions[i], result)) {
      if (fullyCanonical(actions[i], result)) primary = i;
      break;
    }
  }
  const map = new Map<number, number>();
  const kept: unknown[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    if (i === primary) continue;
    map.set(i, kept.length);
    const a = actions[i];
    kept.push({
      predicate: a.predicate.lemma,
      polarity: a.polarity,
      modality: a.modality,
      relation: a.relation,
      args: a.args.map(argFingerprint)
    });
  }
  const relations = (g.relations ?? [])
    .filter((r) =>
      (r.fromActionIndex === undefined || map.has(r.fromActionIndex)) &&
      (r.toActionIndex === undefined || map.has(r.toActionIndex))
    )
    .map((r) => ({
      kind: r.kind,
      from: r.fromActionIndex === undefined ? undefined : map.get(r.fromActionIndex),
      to: r.toActionIndex === undefined ? undefined : map.get(r.toActionIndex),
      condition: r.fromActionIndex === undefined ? text(r.text) : undefined
    }));
  return {
    actions: kept,
    relations,
    opaque: (g.opaqueSpans ?? []).map((span) => text(span.text)).filter(Boolean)
  };
}

function graphRepresents(clause: CanonicalSigClause | undefined, value: string): boolean {
  const normalized = text(value);
  return Boolean(normalized && clause?.instructionGraph?.actions.some((action) => {
    const source = text(action.sourceText);
    return source && (source === normalized || source.includes(normalized) || normalized.includes(source));
  }));
}

function additional(result: Result): string[] {
  const clause = result.meta.canonical.clauses[0];
  return (result.fhir.additionalInstruction ?? [])
    .map((instruction) => {
      const coding = instruction.coding?.[0];
      if (coding?.code) return `${coding.system ?? ""}|${coding.code}`;
      const value = instruction.text ?? "";
      return graphRepresents(clause, value) ? undefined : text(value);
    })
    .filter((value): value is string => Boolean(value))
    .sort();
}

function fingerprint(result: Result): unknown {
  const clause = result.meta.canonical.clauses[0];
  return {
    method: key(result.fhir.method),
    route: key(result.fhir.route),
    site: key(result.fhir.site),
    dose: dose(result),
    schedule: schedule(clause),
    prn: result.fhir.asNeededBoolean === true,
    reasons: (result.fhir.asNeededFor ?? []).map(key).sort(),
    additional: additional(result),
    graph: graph(result)
  };
}

describe("50-case human realization semantic round trip", () => {
  for (const [index, source] of cases.entries()) {
    it(`${index + 1}: ${source}`, () => {
      const parsed = parseSig(source);
      const realized = formatSig(parsed.fhir, "long", {
        locale: "en",
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: "en" });
      expect(fingerprint(reparsed)).toEqual(fingerprint(parsed));
    });
  }
});


describe("25-case Thai human realization semantic round trip", () => {
  for (const [index, source] of thaiCases.entries()) {
    it(`${index + 1}: ${source}`, () => {
      const parsed = parseSig(source, { locale: "th" });
      const realized = formatSig(parsed.fhir, "long", {
        locale: "th",
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: "th" });
      expect(fingerprint(reparsed)).toEqual(fingerprint(parsed));
    });
  }
});


const CROSS_SCOPE_RELATIONS = new Set([
  "before", "after", "during", "until", "if", "unless", "when", "while"
]);

function crossGraph(result: Result): unknown {
  const g = result.meta.canonical.clauses[0]?.instructionGraph;
  if (!g) return { actions: [], relations: [], opaqueCount: 0 };
  const actions = g.actions ?? [];
  let primary = -1;
  for (let index = 0; index < actions.length; index += 1) {
    if (!methodMatches(actions[index], result)) continue;
    if (fullyCanonical(actions[index], result)) primary = index;
    break;
  }
  const indexMap = new Map<number, number>();
  const kept: unknown[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    if (index === primary) continue;
    indexMap.set(index, kept.length);
    const action = actions[index];
    kept.push({
      predicate: action.predicate.lemma,
      polarity: action.polarity,
      modality: action.modality,
      relation: action.relation && CROSS_SCOPE_RELATIONS.has(action.relation)
        ? action.relation
        : undefined,
      args: action.args.map(argFingerprint)
    });
  }
  const relations = (g.relations ?? [])
    .filter((relation) =>
      (relation.fromActionIndex === undefined || indexMap.has(relation.fromActionIndex)) &&
      (relation.toActionIndex === undefined || indexMap.has(relation.toActionIndex))
    )
    .map((relation) => ({
      kind: relation.kind,
      from: relation.fromActionIndex === undefined ? undefined : indexMap.get(relation.fromActionIndex),
      to: relation.toActionIndex === undefined ? undefined : indexMap.get(relation.toActionIndex)
    }));
  return {
    actions: kept,
    relations,
    opaqueCount: g.opaqueSpans?.length ?? 0
  };
}

function crossFingerprint(result: Result): unknown {
  const clause = result.meta.canonical.clauses[0];
  return {
    method: key(result.fhir.method),
    route: key(result.fhir.route),
    site: key(result.fhir.site),
    dose: dose(result),
    schedule: schedule(clause),
    prn: result.fhir.asNeededBoolean === true,
    reasons: (result.fhir.asNeededFor ?? []).map(key).sort(),
    additional: additional(result),
    graph: crossGraph(result)
  };
}

describe("12-case cross-language semantic realization", () => {
  for (const [index, value] of crossLanguageCases.entries()) {
    it(`${index + 1}: ${value.from}->${value.to}: ${value.source}`, () => {
      const parsed = parseSig(value.source, { locale: value.from });
      const realized = formatSig(parsed.fhir, "long", {
        locale: value.to,
        realizationMode: "roundtrip"
      });
      const reparsed = parseSig(realized, { locale: value.to });
      expect(crossFingerprint(reparsed)).toEqual(crossFingerprint(parsed));
    });
  }
});
