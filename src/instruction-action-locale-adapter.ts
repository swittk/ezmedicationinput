import { medicationInstructionActionLocaleRealizerConfig } from "./instruction-action-terminology";
import {
  getAdviceRelationDefinition,
  getUniqueAdviceRelationByGrammarFeature,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass
} from "./relation-terminology";
import { baseLanguageTag } from "./localization";
import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceFrame,
  AdviceModality,
  AdviceRelation,
  MedicationInstructionActionDefinition,
  MedicationInstructionActionRealizer
} from "./types";

export interface InstructionActionRealizationInput {
  frame: AdviceFrame;
  locale: string;
  label: string;
  amount?: string;
  theme?: string;
  container?: string;
  destination?: string;
  site?: string;
  substance?: string;
  result?: string;
  activity?: string;
  time?: string;
  duration?: string;
  material?: string;
  manner?: string;
  realizerConfig?: MedicationInstructionActionDefinition["realizerConfig"];
  definition?: MedicationInstructionActionDefinition;
  translateArgumentConcept: (arg: AdviceArgument) => string;
  translateQuantity: (quantity: NonNullable<AdviceArgument["quantity"]>) => string;
}

export interface InstructionActionLocaleAdapter {
  locale: string;
  render(realizer: MedicationInstructionActionRealizer, input: InstructionActionRealizationInput): string | undefined;
  renderNegated(input: InstructionActionRealizationInput): string;
  applyPositiveModality(text: string, frame: AdviceFrame): string;
  parseConditionPersistence(body: string): { body: string; persists: boolean };
  renderConditionBody(base: string, conditionForm: string | undefined, persists: boolean): string;
  joinConditionLead(lead: string, body: string): string;
  conditionalContinuation(text: string, imperative: boolean): string;
  postposedCondition(text: string): string;
  sequenceSeparator(): string;
  continuationText(text: string, understood: boolean): string;
}

const ADAPTERS = new Map<string, InstructionActionLocaleAdapter>();

export function registerInstructionActionLocaleAdapter(adapter: InstructionActionLocaleAdapter): void {
  ADAPTERS.set(baseLanguageTag(adapter.locale) ?? adapter.locale.toLowerCase(), adapter);
}

export function getInstructionActionLocaleAdapter(locale: string): InstructionActionLocaleAdapter {
  const key = baseLanguageTag(locale) ?? locale.toLowerCase();
  return ADAPTERS.get(key) ?? ADAPTERS.get("en")!;
}

function lowerInitial(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function suppressSite(input: InstructionActionRealizationInput): boolean {
  const arg = input.frame.args.find((candidate) => candidate.role === AdviceArgumentRole.Site);
  return Boolean(arg?.conceptId &&
    (medicationInstructionActionLocaleRealizerConfig(input.realizerConfig, input.locale)
      ?.suppressSiteConcepts?.indexOf(arg.conceptId) ?? -1) !== -1);
}

function suppressActivity(input: InstructionActionRealizationInput): boolean {
  const arg = input.frame.args.find((candidate) => candidate.role === AdviceArgumentRole.Activity);
  return Boolean(arg?.conceptId &&
    (medicationInstructionActionLocaleRealizerConfig(input.realizerConfig, input.locale)
      ?.suppressActivityConcepts?.indexOf(arg.conceptId) ?? -1) !== -1);
}

function relationForSite(input: InstructionActionRealizationInput): AdviceRelation {
  return input.frame.relation ?? getUniqueAdviceRelationByGrammarFeature("defaultSiteRelation") ??
    (() => { throw new Error("Missing declarative default site relation"); })();
}

const EN_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "Should not ", [AdviceModality.Must]: "Must not "
};
const EN_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "May ", [AdviceModality.Can]: "Can ",
  [AdviceModality.Might]: "Might ", [AdviceModality.Could]: "Could ",
  [AdviceModality.Should]: "Should ", [AdviceModality.Must]: "Must "
};

function renderEnglishRelationDuration(c: InstructionActionRealizationInput): string {
  const object = c.amount ?? c.theme ?? c.site;
  const target = c.duration ?? c.time ?? c.activity;
  if (target && relationHasGrammarFeature(c.frame.relation, "activityFallback")) {
    const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
    return `${c.label}${object ? ` ${object}` : ""} ${relation} ${target}`;
  }
  return `${c.label}${object ? ` ${object}` : ""}`;
}

function renderEnglish(realizer: MedicationInstructionActionRealizer, c: InstructionActionRealizationInput): string | undefined {
  switch (realizer) {
    case "source-faithful": {
      if (!/[\u0E00-\u0E7F]/u.test(c.frame.sourceText)) {
        const text = c.frame.sourceText.trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : c.label;
      }
      return "Adjust use according to symptoms";
    }
    case "container-activity": {
      const container = c.container ?? c.theme;
      return `${c.label}${container ? ` ${container}` : ""}${c.activity ? ` before ${c.activity}` : ""}`;
    }
    case "theme-destination-amount":
      return `${c.label}${c.theme ? ` ${c.theme}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.destination ? ` into ${c.destination}` : ""}`;
    case "mix-substance": {
      const themeArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Theme);
      const substanceArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Substance);
      const theme = themeArg ? c.translateArgumentConcept(themeArg) : undefined;
      const substance = substanceArg ? c.translateArgumentConcept(substanceArg) : c.substance;
      const themeAmount = themeArg?.quantity ? c.translateQuantity(themeArg.quantity) : undefined;
      const amountArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Amount);
      const substanceAmount = substanceArg?.quantity ? c.translateQuantity(substanceArg.quantity) : c.amount;
      const themeText = theme ? ` ${themeAmount ? `${themeAmount} of ` : ""}${theme}` : "";
      const amountText = substanceAmount ? `${substanceAmount}${amountArg?.conceptId && !substanceArg?.quantity ? " of " : " "}` : "";
      return `${c.label}${themeText}${substance ? ` with ${amountText}${substance}` : ""}`;
    }
    case "site-relation": {
      const relationTarget = c.time ?? c.activity;
      const manner = c.manner ? ` ${c.manner}` : "";
      if (relationTarget) {
        const target = c.site && !suppressSite(c) ? ` ${c.site}` : "";
        if (c.time && relationHasGrammarFeature(c.frame.relation, "directTimeRealization")) {
          const lower = c.time.toLowerCase();
          const timePhrase = lower === "night" ? "at night"
            : lower === "bed" || lower === "bedtime" || lower === "sleep" ? "at bedtime"
              : /^(?:the )?(?:morning|afternoon|evening)$/.test(lower)
                ? `in ${lower.startsWith("the ") ? lower : `the ${lower}`}`
                : `at ${c.time}`;
          return `${c.label}${target}${manner} ${timePhrase}`;
        }
        const semanticRelation = relationForSite(c);
        const profile = getAdviceRelationDefinition(semanticRelation)?.grammar.timeRealizationProfile ?? "default";
        const relation = localizeAdviceRelation(semanticRelation, c.locale, profile) ?? semanticRelation;
        return `${c.label}${target}${manner} ${relation} ${relationTarget}`;
      }
      const result = c.result ? ` until ${c.result}` : "";
      if (c.site) return `${c.label} ${c.site}${manner}${c.substance ? ` with ${c.substance}` : ""}${result}`;
      return `${c.label}${manner}${c.substance ? ` with ${c.substance}` : ""}${result}`;
    }
    case "object-amount-material": {
      const object = c.theme ?? c.container;
      return `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` with ${c.material}` : ""}`;
    }
    case "prime": {
      const object = c.theme ?? c.container;
      return `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` with ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`;
    }
    case "amount-duration": {
      const relationTarget = c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) : undefined;
      const base = `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` for ${c.duration}` : ""}`;
      return relation && relationTarget ? `${base} ${relation} ${relationTarget}` : base;
    }
    case "object-duration": {
      const object = c.theme ?? c.site;
      return `${c.label}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""}`;
    }
    case "object-time": {
      const object = c.theme ?? c.site;
      return `${c.label}${object ? ` ${object}` : ""}${c.time ? ` in ${c.time}` : ""}`;
    }
    case "separable-object-relation": {
      const object = c.theme ?? c.site;
      const alias = c.definition?.separableAliases?.find((candidate) =>
        !/[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle));
      if (!alias) return renderEnglishRelationDuration(c);
      const target = c.duration ?? c.time ?? c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) ?? "" : "";
      return `${alias.lead}${object ? ` ${object}` : ""} ${alias.particle}${target ? ` ${relation} ${target}` : ""}`;
    }
    case "relation-duration": return renderEnglishRelationDuration(c);
    case "leave-duration": {
      const durationArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Duration);
      if (durationArg?.conceptId === "overnight" && c.duration) return `${c.label} on ${c.duration}`;
      return `${c.label} on${c.duration ? ` for ${c.duration}` : ""}`;
    }
    case "duration": return `${c.label}${c.duration ? ` for ${c.duration}` : ""}`;
    case "duration-activity": {
      const target = c.activity ?? c.result;
      if (!target) return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
      if (c.frame.relation) {
        const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
        return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${relation} ${target}`;
      }
      return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${target}`;
    }
    case "activity": {
      const base = `${c.label}${c.activity ? ` ${c.activity}` : ""}`;
      return c.duration ? `${base} for ${c.duration}` : base;
    }
    default: return undefined;
  }
}

const TH_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "ไม่ควร", [AdviceModality.Must]: "ห้าม"
};
const TH_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "อาจ", [AdviceModality.Can]: "สามารถ",
  [AdviceModality.Might]: "อาจ", [AdviceModality.Could]: "อาจ",
  [AdviceModality.Should]: "ควร", [AdviceModality.Must]: "ต้อง"
};

function thaiAsciiSeparated(value: string | undefined): string {
  return value && /^[0-9A-Za-z]/u.test(value) ? ` ${value}` : value ?? "";
}

function renderThaiRelationDuration(c: InstructionActionRealizationInput): string {
  const object = c.amount ?? c.theme ?? c.site;
  const target = c.duration ?? c.time ?? c.activity;
  const objectText = thaiAsciiSeparated(object);
  const targetText = thaiAsciiSeparated(target);
  if (target && relationHasGrammarFeature(c.frame.relation, "activityFallback")) {
    const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
    return `${c.label}${objectText}${relation}${targetText}`;
  }
  return `${c.label}${objectText}`;
}

function renderThai(realizer: MedicationInstructionActionRealizer, c: InstructionActionRealizationInput): string | undefined {
  switch (realizer) {
    case "source-faithful":
      return /[\u0E00-\u0E7F]/u.test(c.frame.sourceText) ? c.frame.sourceText.trim() : "ปรับการใช้ตามอาการ";
    case "container-activity": {
      const container = c.container ?? c.theme;
      return `${c.label}${container ?? ""}${c.activity ? `ก่อน${c.activity}` : ""}`;
    }
    case "theme-destination-amount":
      return `${c.label}${c.theme ?? ""}${c.destination ? `ลง${c.destination}` : ""}${c.amount ? ` ${c.amount}` : ""}`;
    case "mix-substance": {
      const themeArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Theme);
      const substanceArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Substance);
      const theme = themeArg ? c.translateArgumentConcept(themeArg) : undefined;
      const substance = substanceArg ? c.translateArgumentConcept(substanceArg) : c.substance;
      const themeAmount = themeArg?.quantity ? c.translateQuantity(themeArg.quantity) : undefined;
      const amountArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Amount);
      const substanceAmount = substanceArg?.quantity ? c.translateQuantity(substanceArg.quantity) : c.amount;
      const themeText = theme ? `${theme}${themeAmount ? ` ${themeAmount}` : ""}` : "";
      const amountSeparator = substanceArg?.quantity ? " " : amountArg?.conceptId ? "" : " ";
      const substanceText = substance
        ? `${themeText ? "กับ" : ""}${substance}${substanceAmount ? `${amountSeparator}${substanceAmount}` : ""}` : "";
      return `${c.label}${themeText}${substanceText}`;
    }
    case "site-relation": {
      const relationTarget = c.time ?? c.activity;
      const manner = c.manner ?? "";
      if (relationTarget) {
        const target = c.site && !suppressSite(c) ? c.site : "";
        if (c.time && relationHasGrammarFeature(c.frame.relation, "directTimeRealization")) {
          const timePhrase = c.time === "กลางคืน" ? "ตอนกลางคืน"
            : c.time === "นอน" || c.time === "bedtime" ? "ก่อนนอน" : c.time;
          return `${c.label}${target}${manner}${timePhrase}`;
        }
        const semanticRelation = relationForSite(c);
        const profile = getAdviceRelationDefinition(semanticRelation)?.grammar.timeRealizationProfile ?? "default";
        const relation = localizeAdviceRelation(semanticRelation, c.locale, profile) ?? semanticRelation;
        return `${c.label}${target}${manner}${relation}${relationTarget}`;
      }
      const result = c.result ? `ให้${c.result}` : "";
      if (c.site) return `${c.label}${c.site}${manner}${c.substance ? `ด้วย${c.substance}` : ""}${result}`;
      return `${c.label}${manner}${c.substance ? `ด้วย${c.substance}` : ""}${result}`;
    }
    case "object-amount-material": {
      const object = c.theme ?? c.container;
      return `${c.label}${object ?? ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? `ด้วย${c.material}` : ""}`;
    }
    case "prime": {
      const object = c.theme ?? c.container;
      const fallback = medicationInstructionActionLocaleRealizerConfig(c.realizerConfig, c.locale)?.fallbackObject ?? "";
      return `${c.label}${object ?? fallback}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`;
    }
    case "amount-duration": {
      const relationTarget = c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) : undefined;
      const base = `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` นาน ${c.duration}` : ""}`;
      return relation && relationTarget ? `${base}${relation}${relationTarget}` : base;
    }
    case "object-duration": {
      const object = c.theme ?? c.site;
      return `${c.label}${object ?? ""}${c.duration ? ` ${c.duration}` : ""}`;
    }
    case "object-time": {
      const object = c.theme ?? c.site;
      return `${c.label}${object ?? ""}${c.time ?? ""}`;
    }
    case "separable-object-relation": {
      const object = c.theme ?? c.site;
      const alias = c.definition?.separableAliases?.find((candidate) =>
        /[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle));
      if (!alias) return renderThaiRelationDuration(c);
      const target = c.duration ?? c.time ?? c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) ?? "" : "";
      return `${alias.lead}${object ?? ""}${alias.particle}${target ? `${relation}${target}` : ""}`;
    }
    case "relation-duration": return renderThaiRelationDuration(c);
    case "leave-duration": {
      const durationArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Duration);
      if (durationArg?.conceptId === "overnight" && c.duration) return `${c.label}${c.duration}`;
      return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
    }
    case "duration": return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
    case "duration-activity": {
      const target = c.activity ?? c.result;
      if (!target) return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
      if (c.frame.relation) {
        const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
        return relationHasSemanticClass(c.frame.relation, "interval")
          ? `${c.label}${c.duration ? ` ${c.duration}` : ""} ${relation}${target}`
          : `${c.label}${c.duration ? ` ${c.duration}` : ""}${relation}${target}`;
      }
      return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${target}`;
    }
    case "activity": {
      const base = suppressActivity(c) || !c.activity ? c.label : `${c.label}${c.activity}`;
      return c.duration ? `${base}เป็นเวลา ${c.duration}` : base;
    }
    default: return undefined;
  }
}

const EN_ADAPTER: InstructionActionLocaleAdapter = {
  locale: "en",
  render: renderEnglish,
  renderNegated(c) {
    const object = c.site ?? c.theme ?? c.substance ?? c.material;
    const relationTarget = c.activity ?? c.time;
    const prefix = (c.frame.modality && EN_NEGATED_MODALITY_PREFIX[c.frame.modality]) ?? "Do not ";
    if (object && relationHasGrammarFeature(c.frame.relation, "negatedObjectAttachment")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      return `${prefix}${c.label.toLowerCase()} ${relation} ${object}`;
    }
    if (relationTarget && relationHasGrammarFeature(c.frame.relation, "negatedRelationTarget")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      return `${prefix}${c.label.toLowerCase()}${object ? ` ${object}` : ""} ${relation} ${relationTarget}`;
    }
    if (c.duration) return `${prefix}${c.label.toLowerCase()}${object ? ` ${object}` : ""} for ${c.duration}`;
    const fallback = object ?? relationTarget;
    return `${prefix}${c.label.toLowerCase()}${fallback ? ` ${fallback}` : ""}`;
  },
  applyPositiveModality(text, frame) {
    if (!frame.modality) return text;
    const prefix = EN_POSITIVE_MODALITY_PREFIX[frame.modality];
    if (!prefix || text.trim().toLowerCase().startsWith(prefix.trim().toLowerCase())) return text;
    return `${prefix}${lowerInitial(text)}`;
  },
  parseConditionPersistence(body) {
    const match = body.match(/^(.+?)\s+(?:persists?|continues?|remains?)$/iu);
    return match ? { body: match[1].trim(), persists: true } : { body, persists: false };
  },
  renderConditionBody(base, _conditionForm, persists) {
    const normalized = lowerInitial(base);
    return persists ? `${normalized} persists` : normalized;
  },
  joinConditionLead(lead, body) { return `${lead} ${body}`.trim(); },
  conditionalContinuation(text) {
    const lowered = lowerInitial(text);
    const scoped = /^(?:should|must|may|might|can|could)\b/i.test(lowered) ? `you ${lowered}` : lowered;
    return `, ${scoped}`;
  },
  postposedCondition(text) { return ` ${text}`; },
  sequenceSeparator() { return "; then "; },
  continuationText(text, understood) { return understood ? lowerInitial(text) : text; }
};

const TH_ADAPTER: InstructionActionLocaleAdapter = {
  locale: "th",
  render: renderThai,
  renderNegated(c) {
    const object = c.site ?? c.theme ?? c.substance ?? c.material;
    const relationTarget = c.activity ?? c.time;
    const prefix = (c.frame.modality && TH_NEGATED_MODALITY_PREFIX[c.frame.modality]) ?? "ห้าม";
    if (object && relationHasGrammarFeature(c.frame.relation, "negatedObjectAttachment")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      return `${prefix}${c.label}${relation}${object}`;
    }
    if (relationTarget && relationHasGrammarFeature(c.frame.relation, "negatedRelationTarget")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      return `${prefix}${c.label}${object ?? ""}${relation}${relationTarget}`;
    }
    if (c.duration) return `${prefix}${c.label}${object ?? ""}เป็นเวลา ${c.duration}`;
    return `${prefix}${c.label}${object ?? relationTarget ?? ""}`;
  },
  applyPositiveModality(text, frame) {
    if (!frame.modality) return text;
    const prefix = TH_POSITIVE_MODALITY_PREFIX[frame.modality];
    if (!prefix || text.trim().toLowerCase().startsWith(prefix.trim().toLowerCase())) return text;
    return `${prefix}${text}`;
  },
  parseConditionPersistence(body) {
    return /^ยัง/u.test(body)
      ? { body: body.replace(/^ยัง/u, "").trim(), persists: true }
      : { body, persists: false };
  },
  renderConditionBody(base, conditionForm, persists) {
    const body = conditionForm ?? base;
    return persists ? `ยัง${body}` : body;
  },
  joinConditionLead(lead, body) { return `${lead}${body}`.trim(); },
  conditionalContinuation(text, imperative) { return `${imperative ? "ให้" : ""}${text}`; },
  postposedCondition(text) { return text; },
  sequenceSeparator() { return " จากนั้น"; },
  continuationText(text) { return text; }
};

registerInstructionActionLocaleAdapter(EN_ADAPTER);
registerInstructionActionLocaleAdapter(TH_ADAPTER);
