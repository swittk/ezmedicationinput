import { buildTranslationPrimitiveElement, clonePrimitiveElement } from "../fhir-translations";
import { FhirCoding } from "../types";

const SNOMED_SYSTEM = "http://snomed.info/sct";

export enum MethodAction {
  Administer = "administer",
  Apply = "apply",
  Insert = "insert",
  Instill = "instill",
  Spray = "spray",
  Swallow = "swallow",
  Wash = "wash"
}

export const METHOD_ACTION_BY_VERB: Record<string, MethodAction> = {
  apply: MethodAction.Apply,
  dab: MethodAction.Apply,
  drink: MethodAction.Swallow,
  insert: MethodAction.Insert,
  instill: MethodAction.Instill,
  lather: MethodAction.Wash,
  massage: MethodAction.Apply,
  reapply: MethodAction.Apply,
  rub: MethodAction.Apply,
  shampoo: MethodAction.Wash,
  spray: MethodAction.Spray,
  spread: MethodAction.Apply,
  swallow: MethodAction.Swallow,
  take: MethodAction.Administer,
  use: MethodAction.Administer,
  wash: MethodAction.Wash
};

export const METHOD_CODING_BY_ACTION: Record<MethodAction, FhirCoding> = {
  [MethodAction.Administer]: {
    system: SNOMED_SYSTEM,
    code: "738990001",
    display: "Administer"
  },
  [MethodAction.Apply]: {
    system: SNOMED_SYSTEM,
    code: "738991002",
    display: "Apply",
    _display: buildTranslationPrimitiveElement({ th: "ทา" })
  },
  [MethodAction.Insert]: {
    system: SNOMED_SYSTEM,
    code: "738993004",
    display: "Insert",
    _display: buildTranslationPrimitiveElement({ th: "สอด" })
  },
  [MethodAction.Instill]: {
    system: SNOMED_SYSTEM,
    code: "738994005",
    display: "Instill",
    _display: buildTranslationPrimitiveElement({ th: "หยอด" })
  },
  [MethodAction.Spray]: {
    system: SNOMED_SYSTEM,
    code: "738996007",
    display: "Spray",
    _display: buildTranslationPrimitiveElement({ th: "พ่น" })
  },
  [MethodAction.Swallow]: {
    system: SNOMED_SYSTEM,
    code: "738995006",
    display: "Swallow",
    _display: buildTranslationPrimitiveElement({ th: "รับประทาน" })
  },
  [MethodAction.Wash]: {
    system: SNOMED_SYSTEM,
    code: "785900008",
    display: "Rinse or wash",
    _display: buildTranslationPrimitiveElement({ th: "ล้าง" })
  }
};

export function cloneMethodCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  if (!coding?.code) {
    return undefined;
  }
  return {
    system: coding.system,
    code: coding.code,
    display: coding.display,
    _display: clonePrimitiveElement(coding._display)
  };
}
