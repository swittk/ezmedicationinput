import { describe, expect, it } from "vitest";
import { resolveSigLocalization } from "../src/i18n";
import {
  localizedConfig,
  localizedValue
} from "../src/localization";
import {
  medicationInstructionActionLocaleRealizerConfig,
  resolveMedicationInstructionAction
} from "../src/instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../src/instruction-concept-terminology";
import { AdviceArgumentRole, AdviceRelation, RouteCode } from "../src/types";
import { suggestSig } from "../src/suggest";
import { localizeAdviceRelation } from "../src/relation-terminology";
import { shouldJoinAdjacentSourceTokens } from "../src/locale-detection";
import {
  getAdviceLocaleAdapter,
  getInstructionActionLocaleAdapter,
  getMedicationLexerLocalePack,
  getSuggestLocaleAdapter,
  inferMedicationLocale,
  listMedicationLocaleLexemes,
  listMedicationSurfaceSegmenters,
  registerAdviceLocaleAdapter,
  registerInstructionActionLocaleAdapter,
  registerMedicationLexerLocalePack,
  registerMedicationLocaleDetector,
  registerMedicationSurfaceSegmenter,
  registerSuggestLocaleAdapter
} from "../src/index";

describe("locale-extensible language architecture", () => {
  it("uses arbitrary BCP-47-ish locale keys with base-language fallback", () => {
    expect(localizedValue({ ja: "日本語", lo: "ລາວ" }, "ja-JP")).toBe("日本語");
    expect(localizedValue({ ja: "日本語", lo: "ລາວ" }, "lo-LA")).toBe("ລາວ");
    expect(localizedConfig({ ja: { directSiteObject: true } }, "ja-JP")).toEqual({
      directSiteObject: true
    });
    expect(localizedValue({ "JA_jP": "case-insensitive" }, "ja-JP")).toBe("case-insensitive");
    expect(localizedValue({ "JA_jP": "", ja: "base-fallback" }, "ja-JP")).toBe("base-fallback");
    expect(localizedConfig({ "LO_la": { directSiteObject: true } }, "lo-LA")).toEqual({
      directSiteObject: true
    });
    expect(localizedValue({ "ja-JP-x": "compatible" }, "ja-JP")).toBe("compatible");
  });

  it("keeps display translation separate from parser lexical licensing", () => {
    const options = {
      instructionConceptMap: {
        material: {
          code: "material",
          role: AdviceArgumentRole.Material,
          display: "material",
          i18n: { ja: "表示だけ" },
          localeAliases: { ja: ["解析語"] }
        }
      }
    };
    expect(resolveMedicationInstructionConcept("解析語", options)?.code).toBe("material");
    expect(resolveMedicationInstructionConcept("表示だけ", options)).toBeUndefined();
  });

  it("resolves action parser aliases and realizer behavior without language-specific fields", () => {
    const options = {
      instructionActionMap: {
        apply: {
          code: "custom-apply",
          semanticClass: "administration",
          display: "Apply",
          i18n: { ja: "塗る" },
          localeAliases: { ja: ["塗布"] },
          realizerConfig: {
            locales: {
              ja: { directSiteObject: true },
              lo: { implicitMedicationObject: true }
            }
          }
        }
      }
    };
    const action = resolveMedicationInstructionAction("塗布", options);
    expect(action?.code).toBe("custom-apply");
    expect(medicationInstructionActionLocaleRealizerConfig(action?.realizerConfig, "ja-JP"))
      .toEqual({ directSiteObject: true });
    expect(medicationInstructionActionLocaleRealizerConfig(action?.realizerConfig, "lo-LA"))
      .toEqual({ implicitMedicationObject: true });
  });

  it("accepts arbitrary formatter locales while relation realization safely falls back", () => {
    const localization = resolveSigLocalization("ja-JP", {
      locale: "ja-JP",
      formatLong: () => "custom-ja"
    });
    expect(localization?.locale).toBe("ja-JP");
    expect(localizeAdviceRelation(AdviceRelation.After, "ja-JP")).toBe("after");
  });
  it("offers locale-specific action aliases through the generic suggester path", () => {
    const suggestions = suggestSig("塗", {
      locale: "ja-JP",
      instructionActionMap: {
        apply: {
          code: "custom-apply",
          semanticClass: "administration",
          display: "Apply",
          localeAliases: { ja: ["塗布"] }
        }
      },
      limit: 5
    });
    expect(suggestions).toContain("塗布");
  });

  it("exposes locale detection and realization adapters as public extension seams", () => {
    registerMedicationLocaleDetector({
      locale: "zz",
      priority: 1000,
      test: (text) => text.includes("¤zz¤")
    });
    expect(inferMedicationLocale("dose ¤zz¤ text")).toBe("zz");

    const englishAction = getInstructionActionLocaleAdapter("en");
    registerInstructionActionLocaleAdapter({
      ...englishAction,
      locale: "zz",
      render(realizer, input) {
        if (realizer === "default") return `ZZ:${input.label}`;
        return englishAction.render(realizer, input);
      }
    });
    expect(getInstructionActionLocaleAdapter("zz-ZZ").render("default", {
      frame: {
        force: "instruction" as any,
        predicate: { lemma: "apply" },
        args: [],
        span: { start: 0, end: 5 },
        sourceText: "apply",
        sequenceIndex: 0
      },
      locale: "zz-ZZ",
      label: "Apply",
      translateArgumentConcept: (arg) => arg.text,
      translateQuantity: () => ""
    })).toBe("ZZ:Apply");

    const englishAdvice = getAdviceLocaleAdapter("en");
    registerAdviceLocaleAdapter({
      ...englishAdvice,
      locale: "zx",
      finalize: (text) => `ZX:${text}`
    });
    expect(getAdviceLocaleAdapter("zx-ZX").finalize("warning")).toBe("ZX:warning");
  });

  it("exposes lexer, surface segmentation, and suggester locale packs", () => {
    registerMedicationLexerLocalePack({
      locale: "xy",
      apply: (tokens) => tokens.map((token, index) => ({ ...token, index })),
      listLexemes: () => [{ surface: "xy-dose", canonical: "dose" }]
    });
    expect(getMedicationLexerLocalePack("xy-XY")?.locale).toBe("xy");
    expect(listMedicationLocaleLexemes("xy-XY")).toContainEqual({
      surface: "xy-dose",
      canonical: "dose"
    });

    registerMedicationSurfaceSegmenter({
      locale: "xy",
      script: /\u2603/u,
      segment: (input) => [{ segment: input, index: 0 }]
    });
    expect(listMedicationSurfaceSegmenters().some((segmenter) => segmenter.locale === "xy")).toBe(true);

    const fallbackSuggest = getSuggestLocaleAdapter("unknown-locale");
    registerSuggestLocaleAdapter({ ...fallbackSuggest, locale: "xy" });
    expect(getSuggestLocaleAdapter("xy-XY").locale).toBe("xy");
  });

  it("joins adjacent source tokens only inside the same no-space locale script", () => {
    expect(shouldJoinAdjacentSourceTokens("ผิว", "หนัง")).toBe(true);
    expect(shouldJoinAdjacentSourceTokens("ผิว", "dry")).toBe(false);
    expect(shouldJoinAdjacentSourceTokens("1", "เม็ด")).toBe(false);
  });

  it("invalidates suggestion lexeme caches when locale packs are replaced", () => {
    expect(suggestSig("qx-fr", { locale: "qx", limit: 5 })).not.toContain("qx-fresh");
    registerMedicationLexerLocalePack({
      locale: "qx",
      apply: (tokens) => tokens.map((token, index) => ({ ...token, index })),
      listLexemes: () => [{ surface: "qx-fresh", canonical: "fresh" }]
    });
    expect(suggestSig("qx-fr", { locale: "qx", limit: 5 })).toContain("qx-fresh");
  });

  it("uses the active locale when building affected-area suggestion trajectories", () => {
    const englishSuggest = getSuggestLocaleAdapter("en");
    registerSuggestLocaleAdapter({ ...englishSuggest, locale: "qv" });
    const suggestions = suggestSig("paint", {
      locale: "qv",
      limit: 10,
      instructionActionMap: {
        paint: {
          code: "paint",
          semanticClass: "administration",
          display: "Paint",
          aliases: ["paint"],
          procedural: false,
          argumentParser: "site-relation",
          realizer: "site-relation",
          administrationMethod: {
            system: "http://snomed.info/sct",
            code: "738991002",
            display: "Apply"
          },
          verbRouteHint: RouteCode["Topical route"],
          applicationVerb: true,
          realizerConfig: {
            locales: {
              en: { directSiteObject: false },
              qv: { directSiteObject: true }
            }
          }
        }
      }
    });
    expect(suggestions).toContain("paint affected area");
    expect(suggestions).not.toContain("paint to affected area");
  });

});
