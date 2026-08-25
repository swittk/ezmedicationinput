import { baseLanguageTag } from "./localization";
import {
  AdviceFrame,
  AdviceModality,
  AdvicePolarity
} from "./types";

export interface AdviceLocaleRealizationInput {
  frame: AdviceFrame;
  predicate: string;
  realizerProfile: string;
  argText?: string;
  modalityText?: string;
  relationText?: string;
}

export interface AdviceLocaleAdapter {
  locale: string;
  realizeModality(modality: AdviceModality | undefined): string | undefined;
  siteArgument(text: string): string;
  joinArguments(texts: string[]): string | undefined;
  realize(input: AdviceLocaleRealizationInput): string;
  finalize(text: string): string;
}

const ADAPTERS = new Map<string, AdviceLocaleAdapter>();

export function registerAdviceLocaleAdapter(adapter: AdviceLocaleAdapter): void {
  ADAPTERS.set(baseLanguageTag(adapter.locale) ?? adapter.locale.toLowerCase(), adapter);
}

export function getAdviceLocaleAdapter(locale: string): AdviceLocaleAdapter {
  const key = baseLanguageTag(locale) ?? locale.toLowerCase();
  return ADAPTERS.get(key) ?? ADAPTERS.get("en")!;
}

function capitalizeSentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

const EN_MODALITY: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "May",
  [AdviceModality.Can]: "Can",
  [AdviceModality.Might]: "Might",
  [AdviceModality.Could]: "Could",
  [AdviceModality.Should]: "Should",
  [AdviceModality.Must]: "Must"
};

const EN_ADAPTER: AdviceLocaleAdapter = {
  locale: "en",
  realizeModality(modality) { return modality ? EN_MODALITY[modality] ?? capitalizeSentence(modality) : undefined; },
  siteArgument(text) { return text; },
  joinArguments(texts) {
    if (!texts.length) return undefined;
    let text = "";
    for (let index = 0; index < texts.length; index += 1) {
      if (index > 0) text += index === 1 ? " and " : ", ";
      text += texts[index];
    }
    return text;
  },
  realize({ frame, predicate, realizerProfile, argText, modalityText, relationText }) {
    if (frame.polarity === AdvicePolarity.Negate) {
      let text = `${frame.modality === AdviceModality.Must ? "Must not" : "Do not"} ${predicate}`;
      if (relationText) text += ` ${relationText}`;
      if (argText) text += ` ${argText}`;
      return text;
    }
    if (realizerProfile === "effect") {
      const effectiveModality = modalityText ?? "May";
      return `${effectiveModality} ${predicate}${argText ? ` ${argText}` : ""}`;
    }
    let text = modalityText ? `${modalityText} ${predicate}` : capitalizeSentence(predicate);
    if (realizerProfile !== "avoidance" && relationText) text += ` ${relationText}`;
    if (argText) text += ` ${argText}`;
    return text;
  },
  finalize(text) { return capitalizeSentence(text); }
};

const TH_MODALITY: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "อาจ",
  [AdviceModality.Can]: "สามารถ",
  [AdviceModality.Might]: "อาจ",
  [AdviceModality.Could]: "อาจ",
  [AdviceModality.Should]: "ควร",
  [AdviceModality.Must]: "ต้อง"
};

const TH_ADAPTER: AdviceLocaleAdapter = {
  locale: "th",
  realizeModality(modality) { return modality ? TH_MODALITY[modality] ?? modality : undefined; },
  siteArgument(text) { return /^บริเวณ/u.test(text) ? text : `บริเวณ${text}`; },
  joinArguments(texts) {
    if (!texts.length) return undefined;
    if (texts.length === 1) return texts[0];
    if (texts.length === 2) return `${texts[0]} และ ${texts[1]}`;
    return `${texts.slice(0, -1).join(", ")} และ ${texts[texts.length - 1]}`;
  },
  realize({ frame, predicate, realizerProfile, argText, modalityText, relationText }) {
    if (frame.polarity === AdvicePolarity.Negate) {
      let text = `ห้าม${predicate}`;
      if (relationText) text += ` ${relationText}`;
      if (argText) text += ` ${argText}`;
      return text;
    }
    if (realizerProfile === "effect") {
      const effectiveModality = modalityText ?? "อาจ";
      return `${effectiveModality}${predicate}${argText ? argText : ""}`;
    }
    if (realizerProfile === "avoidance") {
      const head = modalityText ? `${modalityText}${predicate}` : predicate;
      return argText ? `${head}${argText}` : head;
    }
    let text = modalityText ? `${modalityText} ${predicate}` : predicate;
    if (relationText) text += ` ${relationText}`;
    if (argText) text += ` ${argText}`;
    return text;
  },
  finalize(text) { return text; }
};

registerAdviceLocaleAdapter(EN_ADAPTER);
registerAdviceLocaleAdapter(TH_ADAPTER);
