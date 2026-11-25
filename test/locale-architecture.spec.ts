import { runInNewContext } from "node:vm";
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
  parseSig,
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
  it("replaces locale detectors in stable priority order and updates their ordering when priority changes",()=>{
    const test=(input:string)=>input==="locale-registry-priority-fixture";
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test});
    registerMedicationLocaleDetector({locale:"priorityb",priority:1000,test});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test:()=>false});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("priorityb");
    registerMedicationLocaleDetector({locale:"prioritya",priority:1000,test});
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
    const changed={locale:"priorityb",priority:1001,test};
    registerMedicationLocaleDetector(changed);
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("priorityb");
    registerMedicationLocaleDetector({ ...changed, priority: 999 });
    expect(inferMedicationLocale("locale-registry-priority-fixture")).toBe("prioritya");
  });

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

    const originalPack = getMedicationLexerLocalePack("xy")!;
    const regionalApply: typeof originalPack.apply = tokens => tokens.map((token, index) => ({ ...token, index }));
    const regionalPack = { ...originalPack, locale: " xY_Clinic ", apply: regionalApply };
    registerMedicationLexerLocalePack(regionalPack);
    expect(regionalPack.locale).toBe(" xY_Clinic ");
    expect(getMedicationLexerLocalePack("XY-Other")?.locale).toBe("xy");
    expect(getMedicationLexerLocalePack("XY-Other")?.apply).toBe(regionalApply);
    expect(getMedicationLexerLocalePack("xy")?.apply).toBe(regionalApply);
    expect(listMedicationLocaleLexemes("xy-XY")).toContainEqual({ surface: "xy-dose", canonical: "dose" });

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

describe("round54 descriptor-owned surface segmenter callbacks", () => {
  it.each(["g", "y", ""])("uses the normalized script receiver for a plain descriptor (%s)", flags => {
    // Plain descriptors use their registered configuration through `this`;
    // class callbacks instead retain their original receiver and private state.
    const provider = {
      locale: "round54-own-script-" + (flags || "plain"),
      script: new RegExp("[ⴰⴱ]", flags + "u"),
      segment(input: string) {
        const segments: Array<{ segment: string; index: number }> = [];
        for (let index = 0; index < input.length; index++)
          if (this.script.test(input[index])) segments.push({ segment: input[index], index });
        return segments;
      }
    };
    registerMedicationSurfaceSegmenter(provider);
    const registered = listMedicationSurfaceSegmenters().find(value => value.locale === provider.locale)!;
    const expected = [{ segment: "ⴰ", index: 0 }, { segment: "ⴱ", index: 1 }];
    expect([...registered.segment("ⴰⴱ")]).toEqual(expected);
    expect([...registered.segment("ⴰⴱ")]).toEqual(expected);
    expect(registered.script.global).toBe(false);
    expect(registered.script.sticky).toBe(false);
    expect(provider.script.global).toBe(flags === "g");
    expect(provider.script.sticky).toBe(flags === "y");
  });
});


describe("round64 declared locale descriptor fields", () => {
  it("reads a declared non-enumerable detector priority", () => {
    const marker = "__round64_priority__ไทย";
    const detector = { locale: "round64priority", test: (text: string) => text === marker };
    Object.defineProperty(detector, "priority", { value: 200 });
    registerMedicationLocaleDetector(detector);
    expect(inferMedicationLocale(marker)).toBe("round64priority");
  });
});


describe("shared timing article roles", () => {
  it("accepts a registered Spanish article alias through existing timing constructions", () => {
    registerMedicationLocaleDetector({ locale: "es", priority: 1000, test: text => /\bel\b/u.test(text) });
    registerMedicationLexerLocalePack({
      locale: "es",
      apply: tokens => tokens.map((token, index) => ({ ...token, index,
        ...(token.lower === "el" ? { canonical: "the" } : {}) })),
      listLexemes: () => [{ surface: "el", canonical: "the" }],
    });
    const durationCases = [
      { suffix: "for el next week", value: 1, code: "wk" },
      { suffix: "for el next 3 days", value: 3, code: "d" },
      { suffix: "for el 3 days", value: 3, code: "d" },
    ];
    for (const { suffix, value, code } of durationCases) for (const wording of [suffix, suffix.replace("el", "the")]) {
      const parsed = parseSig("Take 1 tablet daily " + wording);
      expect(parsed.fhir[0].doseAndRate![0].doseQuantity!.value).toBe(1);
      expect(parsed.fhir[0].timing!.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d",
        boundsDuration: { value, code } });
    }
    for (const article of ["el", "the"]) {
      const counted = parseSig(`Take 1 tablet daily for ${article} 3 doses`);
      expect(counted.fhir[0].timing!.repeat).toMatchObject({ count: 3, frequency: 1, period: 1, periodUnit: "d" });
      const monthly = parseSig(`Take 1 tablet on ${article} first Monday of every month`);
      expect(monthly.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "mo", dayOfWeek: ["mon"], weekdayOrdinal: 1 });
      const ended = parseSig(`Take 1 tablet daily until ${article} next morning`);
      const schedule = ended.meta.canonical.clauses[0].schedule!;
      expect(schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
      expect(schedule.when).toBeUndefined();
      expect(schedule.treatmentStartOffsetDays).toBeUndefined();
      expect(ended.fhir[0].timing!.repeat!.boundsPeriod).toBeUndefined();
      expect(ended.meta.canonical.course!.stages[0].administrations[0].phaseEnd)
        .toMatchObject({ anchor: "unresolved", description: `until ${article} next morning` });
      expect(JSON.stringify(ended.fhir[0])).toContain(`until ${article} next morning`);
    }
    // The indefinite quantity determiner has different semantics: it supplies one.
    expect(parseSig("Take 1 tablet daily for a week").fhir[0].timing!.repeat!.boundsDuration)
      .toMatchObject({ value: 1, code: "wk" });
  });
});

describe("round79 locale detector receiver", () => {
  it("normalizes a cross-realm plain descriptor while preserving a class receiver", () => {
    const plain = runInNewContext("({ locale: 'fr-CA', priority: 900, test(text) { return this.locale === 'fr' && text === '__round79_fr__'; } })");
    registerMedicationLocaleDetector(plain);
    expect(inferMedicationLocale("__round79_fr__")).toBe("fr");
    expect(plain.locale).toBe("fr-CA");
    class Detector {
      locale = "de-AT";
      priority = 900;
      #text = "__round79_de__";
      test(text: string) { return this.locale === "de-AT" && text === this.#text; }
    }
    registerMedicationLocaleDetector(new Detector());
    expect(inferMedicationLocale("__round79_de__")).toBe("de");
  });
});
