import { cycleDayConstraintExtension, TIMING_CLOCK_WINDOW_EXTENSION_URL, ADMINISTRATION_OFFSET_EXTENSION_URL, TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src/fhir";
import { fromFhir, importCanonicalCourse, toFhirR5Dosages, toDosageDetails, type CourseLanguage } from "../src/index";
import { describe, expect, it } from "vitest";
import { resolveSigLocalization, registerSigLocalization } from "../src/i18n";
import { formatCanonicalClause } from "../src/format";
import {
  localizedConfig,
  localizedValue
} from "../src/localization";
import {
  medicationInstructionActionLocaleRealizerConfig,
  resolveMedicationInstructionAction
} from "../src/instruction-action-terminology";
import { resolveMedicationInstructionConcept } from "../src/instruction-concept-terminology";
import { AdviceArgumentRole, AdviceForce, AdviceRelation, EventTiming, RouteCode, FhirPeriodUnit, type CanonicalSigClause, type FhirDosage, type FhirR6DosageInstruction, type FormatOptions } from "../src/types";
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
  formatSig,
  fromFhirDosage,
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
    // Plain descriptors use their registered script configuration.
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


describe("structured preview defaults", () => {
  it("keeps guarded whole-clause defaults and accepts a complete wording override", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      condition: [{ code: { coding: [{ system: "http://loinc.org", code: "8480-6",
        display: "Systolic blood pressure" }], text: "sbp" }, operation: "gt",
        valueQuantity: { value: 160 }, text: "SBP > 160" }],
      additionalInstruction: [{ text: "Otherwise hold" }]
    }] }] };
    const before = JSON.stringify(source);
    const expected = "Use 1 tablet only if SBP > 160. Otherwise hold.";
    const defaults: NonNullable<NonNullable<FormatOptions["i18n"]>["formatLong"]>[] = [
      context => context.defaultText,
      context => "Directions: " + context.defaultText,
      context => "Directions: " + context.formatDefault("long"),
    ];
    for (const [index, formatLong] of defaults.entries()) {
      expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: { formatLong } }))
        .toBe((index === 0 ? "" : "Directions: ") + expected);
    }
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized",
      i18n: { formatLong: () => "Take this dose." } })).toBe("Take this dose.");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("uses a display-only administration method without inventing a coding", () => {
    const component: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: "http://snomed.info/sct", code: "26643006" }] },
      method: { coding: [{ display: "Chew" }] }
    };
    const native: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: component.doseAndRate, route: component.route, method: component.method
    }] }] };
    for (const source of [component, native]) {
      const before = JSON.stringify(source);
      expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain("Chew 1 tablet");
      expect(formatSig(source, "long", { locale: "th", realizationMode: "normalized" })).toContain("เคี้ยว");
      expect(JSON.stringify(source)).toBe(before);
    }
    expect(fromFhirDosage(component).longText).toContain("Chew 1 tablet");
    const projected = toDosageDetails([component]);
    expect(projected.step[0].component[0].method).toEqual({ coding: [{ display: "Chew" }] });
    for (const source of [native, projected])
      expect(toFhirR5Dosages(source)[0].method).toEqual({ coding: [{ display: "Chew" }] });
  });

  it.each([0, 2])("displays both endpoints of a %s-to-four-hour PRN interval", period => {
    const source: FhirDosage = { asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period, periodMax: 4, periodUnit: FhirPeriodUnit.Hour } }
    };
    const before = JSON.stringify(source);
    expect(formatSig(source, "short", { locale: "en", realizationMode: "normalized" })).toContain(`Q${period}-4H`);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toContain(`every ${period} to 4 hours`);
    for (const style of ["short", "long"] as const)
      expect(formatSig(source, style, { locale: "th", realizationMode: "normalized" })).toContain(`${period} ถึง 4 ชั่วโมง`);
    expect(JSON.stringify(source)).toBe(before);
  });
});


describe("independent cadence and preview condition owners", () => {
  const guard = { code: { coding: [{ system: "http://loinc.org", code: "8480-6",
    display: "Systolic blood pressure" }], text: "sbp" }, operation: "gt" as const,
    valueQuantity: { value: 160 }, text: "SBP > 160" };
  const tablet = { doseQuantity: { value: 1, unit: "tab" } };

  it.each([
    ["en", "short", "1 tab Q2D HS"],
    ["en", "long", "Use 1 tablet every other day at bedtime."],
    ["th", "short", "1 เม็ด วันเว้นวัน ก่อนนอน"],
    ["th", "long", "ใช้ครั้งละ 1 เม็ด วันเว้นวัน ก่อนนอน."],
  ] as const)("keeps the BED anchor beside a typed cadence in %s %s", (locale, style, expected) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
        repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(source);
    expect(formatSig(source, style, { locale, realizationMode: "normalized" })).toBe(expected);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps explicit events and clocks authoritative over the BED fallback", () => {
    for (const explicit of [{ when: [EventTiming.Morning] }, { timeOfDay: ["09:00:00"] }]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
        timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BED" }] },
          repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Day, ...explicit } }
      }] }] };
      const text = formatSig(source, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain("every other day");
      expect(text).not.toContain("bedtime");
      expect(text).toMatch("when" in explicit ? /morning/u : /9:00\s*am/u);
    }
  });

  it("keeps a restyled default guard on the dose before independent advice", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      condition: [guard], additionalInstruction: [{ text: "Otherwise hold" }]
    }] }] };
    const before = JSON.stringify(source);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: {
      formatLong: context => context.defaultText.replace("Use", "Administer")
    } })).toBe("Administer 1 tablet only if SBP > 160. Otherwise hold.");
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized", i18n: {
      formatLong: () => "Take this dose."
    } })).toBe("Take this dose.");
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(["en", "th"] as const)("preserves native guard ownership and exact whole-clause overrides in %s", locale => {
    const advice = locale === "en" ? "Recheck BP only if SBP > 160" : "Recheck BP เฉพาะเมื่อ SBP > 160";
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [tablet],
      condition: [guard], additionalInstruction: [{ text: advice }],
      extension: [{ url: "https://example.test/source-note", valueString: "Keep this source detail" }]
    }] }] };
    const before = JSON.stringify(source);
    const dose = "Administer 1 tablet";
    const guardText = locale === "en" ? "only if" : "เฉพาะเมื่อ";
    const nativeDose = locale === "en" ? "Use 1 tablet" : "ใช้ครั้งละ 1 เม็ด";
    expect(formatSig(source, "long", { locale, realizationMode: "normalized" }))
      .toBe(`${nativeDose} ${guardText} SBP > 160. ${advice}.`);
    const expectedDefault = `${nativeDose} ${guardText} SBP > 160. ${advice}.`;
    for (const prefix of ["", "Directions: "]) {
      let calls = 0;
      const text = formatSig(source, "long", { locale, realizationMode: "normalized", i18n: {
        formatLong: context => {
          calls++;
          expect(context.style).toBe("long");
          expect(context.defaultText).toBe(expectedDefault);
          expect(context.formatDefault("long")).toBe(expectedDefault);
          expect(context.clause.dose).toMatchObject({ value: 1, unit: "tab" });
          expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", operation: "gt", value: 160 });
          expect(context.clause.additionalInstructions).toEqual(expect.arrayContaining([expect.objectContaining({ text: advice })]));
          return prefix + context.defaultText.replace(`${nativeDose} ${guardText} SBP > 160.`, dose + ".");
        }
      } });
      expect(text).toBe(`${prefix}${dose}. ${advice}.`);
      expect(calls).toBe(1);
    }
    expect(formatSig(source, "long", { locale, realizationMode: "normalized", i18n: {
      formatLong: context => "Directions: " + context.formatDefault("long")
        .replace(`${nativeDose} ${guardText} SBP > 160.`, dose + ".")
        .replace("Recheck BP", "Repeat B.P.") + " Call clinic if needed."
    } })).toBe(`Directions: ${dose}. ${advice.replace("Recheck BP", "Repeat B.P.")}. Call clinic if needed.`);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(["en", "th"] as const)("guards current cadence and authored dose directions once each in %s", locale => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ text: "Swallow 1 tablet whole",
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }, condition: [guard]
    }] }] };
    const before = JSON.stringify(source);
    for (const style of ["short", "long"] as const) {
      const text = formatSig(source, style, { locale, realizationMode: "normalized" });
      expect(text).toContain("Swallow 1 tablet whole");
      const [current, authored] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
      expect(current.match(/SBP > 160/gu)).toHaveLength(1);
      expect(authored.match(/SBP > 160/gu)).toHaveLength(1);
      expect(authored).toBe("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160.");
      expect(text).toContain(locale === "en" ? style === "short" ? "1x/d" : "once daily" : "วันละครั้ง");
    }
    expect(JSON.stringify(source)).toBe(before);
  });
});


describe("complete native clause defaults", () => {
  const guard = { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }], text: "sbp" },
    operation: "gt" as const, valueQuantity: { value: 160 }, text: "SBP > 160" };
  const dose = { doseQuantity: { value: 1, unit: "tab" } };
  const note = { url: "https://example.test/preview-note", valueString: "Retain this note" };

  it.each(["quantity", "ratio", "range"] as const)("guards the current partial infusion %s before independent advice", kind => {
    const sourceText = "Infuse over 2 hours";
    const amount = kind === "quantity"
      ? { rateQuantity: { value: 5, unit: "mL/h", system: "http://unitsofmeasure.org", code: "mL/h" } }
      : kind === "ratio" ? { rateRatio: { numerator: { value: 10, unit: "mL" }, denominator: { value: 2, unit: "h" } } }
      : { rateRange: { low: { value: 5, unit: "mL/h" }, high: { value: 10, unit: "mL/h" } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ text: sourceText,
      doseAndRate: [amount], condition: [guard], extension: [note],
      additionalInstruction: [{ text: "Recheck BP only if SBP > 160" }, { text: "Otherwise hold" }]
    }] }] };
    const rows = toFhirR5Dosages(raw), native = importCanonicalCourse(raw);
    for (const input of [raw, rows, native]) for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), options = { locale, realizationMode: "normalized" as const };
      const long = formatSig(input, "long", options), short = formatSig(input, "short", options);
      const primary = (kind === "range"
        ? locale === "en" ? "Rate range: " : "ช่วงอัตราการให้ยา: "
        : locale === "en" ? "Rate: " : "อัตราการให้ยา: ") +
        (kind === "quantity" ? "5 mL/h" : kind === "ratio" ? "10 mL / 2 h" : "5–10 mL/h") +
        (locale === "en" ? " only if" : " เฉพาะเมื่อ") + " SBP > 160";
      for (const text of [long, short]) {
        const [current, source] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
        expect(current).toContain(primary);
        expect(source).toBe(sourceText);
        expect(current.indexOf(primary)).toBeLessThan(current.indexOf("Recheck") < 0 ? current.length : current.indexOf("Recheck"));
      }
      expect(long).toContain("Recheck BP only if SBP > 160");
      expect(long).toContain("Otherwise hold");
      expect(long.match(/SBP > 160/gu)).toHaveLength(2);
      let calls = 0;
      expect(formatSig(input, "long", { ...options, i18n: { formatLong: context => {
        calls++;
        expect(context.defaultText).toBe(long);
        expect(context.formatDefault("long")).toBe(long);
        expect(context.formatDefault("short")).toBe(short);
        expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", operation: "gt", value: 160 });
        expect(context.clause.additionalInstructions).toContainEqual(expect.objectContaining({ text: "Otherwise hold" }));
        return "Clinic wording, unchanged!";
      } } })).toBe("Clinic wording, unchanged!");
      expect(calls).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(raw.step[0].component[0].text).toBe(sourceText);
    expect(rows[0].text).toBe(sourceText);
    expect(native.stages[0].administrations[0].schedule?.recurrence?.occurrenceDuration).toBeUndefined();
    const reopened = toDosageDetails(rows).step[0].component[0];
    expect(reopened.doseAndRate).toEqual([amount]);
    expect(reopened.extension).toContainEqual(note);
  });

  it.each(["en", "th"] as const)("keeps the guard on the complete authored primary in %s", locale => {
    for (const text of [locale === "en" ? "Use the medication once daily." : "ใช้ยา วันละครั้ง.",
      "Swallow 1 tablet whole"]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ text, condition: [guard],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
        additionalInstruction: [{ text: "Call the clinic" }], extension: [note]
      }] }] };
      for (const input of [source, toFhirR5Dosages(source)]) {
        const before = JSON.stringify(input);
        const native = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(native).toContain(text.replace(/\.$/u, ""));
        expect(native).toContain(locale === "en" ? "once daily" : "วันละครั้ง");
        if (text.startsWith("Swallow")) {
          const [current, authored] = native.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
          expect(current).toContain("Call the clinic");
          expect(current.match(/SBP > 160/gu)).toHaveLength(1);
          expect(current).toContain((locale === "en" ? "once daily only if" : "วันละครั้ง เฉพาะเมื่อ") + " SBP > 160.");
          expect(current).not.toMatch(/Call the clinic\.? (?:only if|เฉพาะเมื่อ)/u);
          expect(authored).toBe("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160.");
          expect(authored).not.toContain("Call the clinic");
        } else {
          expect(native.match(/SBP > 160/gu)).toHaveLength(1);
          expect(native).toBe(text.replace(/\.$/u, "") +
            (locale === "en" ? " only if" : " เฉพาะเมื่อ") + " SBP > 160. Call the clinic.");
        }
        let calls = 0;
        expect(formatSig(input, "long", { locale, realizationMode: "normalized", i18n: {
          formatLong: context => {
            calls++;
            expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
            expect(context.clause.schedule?.frequency).toBe(1);
            expect(context.defaultText).toBe(native);
            expect(context.formatDefault("long")).toBe(native);
            expect(context.clause.additionalInstructions?.[0].text).toBe("Call the clinic");
            return "Clinic wording, unchanged!";
          }
        } })).toBe("Clinic wording, unchanged!");
        expect(calls).toBe(1);
        expect(JSON.stringify(input)).toBe(before);
        expect(toDosageDetails(Array.isArray(input) ? input : toFhirR5Dosages(input)).step![0].component[0].extension)
          .toContainEqual(note);
      }
    }
  });

  it.each(["en", "th"] as const)("lets a full-clause callback replace authored-only guarded wording in %s", locale => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{ text: "Swallow 1 tablet whole",
      condition: [guard], additionalInstruction: [{ text: "Otherwise hold" }] }] }] };
    const native = formatSig(input, "long", { locale, realizationMode: "normalized" });
    expect(native).toContain("Swallow 1 tablet whole " + (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160");
    let calls = 0;
    const actual = formatSig(input, "long", { locale, realizationMode: "normalized", i18n: { formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(native);
      expect(context.formatDefault("long")).toBe(native);
      expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
      return "Clinic: " + context.formatDefault("long");
    } } });
    expect(actual).toBe("Clinic: " + native);
    expect(calls).toBe(1);
  });

  it.each(["en", "th"] as const)("keeps occurrence and tablet limits distinct in short %s directions", locale => {
    const guardText = (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160";
    const occurrenceText = locale === "en" ? "maximum 4 doses per day" : "ไม่เกิน 4 ครั้งต่อวัน";
    for (const kind of ["occurrence", "quantity"] as const) {
      const source = locale === "en"
        ? "Take 2 tablets q4h if SBP > 160, no more than " + (kind === "occurrence" ? "4 doses per day" : "4 tablets/day")
        : "รับประทาน 2 เม็ด ทุก 4 ชั่วโมง ถ้า SBP > 160, ไม่เกิน " + (kind === "occurrence" ? "4 ครั้งต่อวัน" : "4 เม็ดต่อวัน");
      const parsed = parseSig(source, { locale });
      const before = JSON.stringify(parsed);
      const administration = parsed.meta.canonical.course!.stages[0].administrations[0];
      expect(administration.amounts?.[0].quantity?.value).toBe(2);
      expect(administration.predicate).toMatchObject({ kind: "measurement", value: 160 });
      if (kind === "occurrence") expect(administration.schedule?.recurrence?.occurrenceCap)
        .toEqual({ max: 4, period: 1, periodUnit: FhirPeriodUnit.Day });
      else expect(administration.limits?.[0]).toMatchObject({ amount: { value: 4, unit: "tab" }, period: { value: 1, unit: "d" } });
      for (const input of [parsed.meta.canonical.course!, parsed.fhir, parsed.fhirNext]) {
        for (const style of ["short", "long"] as const) {
          const text = formatSig(input, style, { locale, realizationMode: "normalized" });
          expect(text).toMatch(locale === "en" ? /(?<!\d)2 (?:tab|tablets)(?![A-Za-z])/u : /(?<!\d)2 เม็ด/u);
          expect(text.match(/SBP > 160/gu)).toHaveLength(1);
          if (kind === "occurrence") {
            expect(text).toContain(occurrenceText + " " + guardText);
            expect(text).not.toContain("4 tab /");
          } else {
            expect(text).toContain(guardText);
            expect(text).toContain("4 tab / 1 d");
            expect(text).not.toContain(occurrenceText);
          }
        }
      }
      expect(parsed.input).toBe(source);
      expect(parsed.fhirNext.renderedInstruction).toBe(source);
      expect(JSON.stringify(parsed)).toBe(before);
    }
  });

  it.each(["en", "th"] as const)("preserves occurrence caps and independent advice in complete %s defaults", locale => {
    const guardText = (locale === "en" ? "only if" : "เฉพาะเมื่อ") + " SBP > 160";
    const occurrenceText = locale === "en" ? "maximum 4 doses per day" : "ไม่เกิน 4 ครั้งต่อวัน";
    for (const structuredDose of [true, false]) {
      const source = structuredDose ? "Take 2 tablets every 4 hours." : "Swallow 2 tablets whole";
      const input: FhirR6DosageInstruction = { step: [{ component: [{ text: source,
        ...(structuredDose ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] } : {}),
        timing: { repeat: {
          ...(structuredDose ? { frequency: 1, period: 4, periodUnit: FhirPeriodUnit.Hour } : {}),
          extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
            { url: "max", valueInteger: 4 },
            { url: "period", valueQuantity: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" } }
          ] }]
        } }, condition: [guard], additionalInstruction: [{ text: "Recheck BP only if SBP > 160" }], extension: [note]
      }] }] };
      const rows = toFhirR5Dosages(input), native = fromFhir(input).meta.canonical.course!;
      expect(rows[0].text).toBe(source);
      expect(rows[0].extension).toContainEqual(note);
      for (const value of [native, rows, input]) {
        const before = JSON.stringify(value), options = { locale, realizationMode: "normalized" as const };
        const short = formatSig(value, "short", options), long = formatSig(value, "long", options);
        for (const text of [short, long]) {
          expect(text).toContain(occurrenceText);
          if (structuredDose) {
            const primary = text.split("Recheck BP")[0].split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
            expect(primary).toContain(occurrenceText + " " + guardText);
            expect(primary).toMatch(locale === "en" ? /(?<!\d)2 (?:tab|tablets)(?![A-Za-z])/u : /(?<!\d)2 เม็ด/u);
          } else expect(text).toContain(source + " " + guardText);
          expect(text).toContain(source);
        }
        expect(long).toContain("Recheck BP only if SBP > 160");
        expect(long.match(/SBP > 160/gu)).toHaveLength(2);
        let calls = 0;
        const custom = formatSig(value, "long", { ...options, i18n: { formatLong: context => {
          calls++;
          expect(context.defaultText).toBe(long);
          expect(context.formatDefault("long")).toBe(long);
          expect(context.formatDefault("short")).toBe(short);
          expect(context.clause.clinicalAdjuncts?.condition).toMatchObject({ kind: "measurement", value: 160 });
          expect(context.clause.schedule?.occurrenceCap).toEqual({ max: 4, period: 1, periodUnit: FhirPeriodUnit.Day });
          expect(context.clause.dose?.value).toBe(structuredDose ? 2 : undefined);
          return "  Clinic wording, unchanged!  ";
        } } });
        expect(calls).toBe(1);
        expect(custom).toBe("  Clinic wording, unchanged!  ");
        expect(JSON.stringify(value)).toBe(before);
      }
    }
  });

  it.each(["cycle", "clock window", "offset"] as const)("composes the complete %s before the callback", kind => {
    const component: NonNullable<FhirR6DosageInstruction["step"]>[number]["component"][number] = {
      doseAndRate: [dose], timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        timeOfDay: ["09:00:00"] } }, extension: [note]
    };
    if (kind === "cycle") component.modifierExtension = [cycleDayConstraintExtension({
      days: [1, 2, 3, 4, 5], periodDays: 28, reason: "unresolved-cycle-eligibility", sourceText: ""
    })];
    if (kind === "clock window") component.timing!.repeat!.extension = [{
      url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [{ url: "start", valueTime: "08:00:00" },
        { url: "end", valueTime: "18:00:00" }, { url: "endInclusive", valueBoolean: false }]
    }];
    if (kind === "offset") component.modifierExtension = [{ url: ADMINISTRATION_OFFSET_EXTENSION_URL,
      valueQuantity: { value: 30, unit: "min", code: "min", system: "http://unitsofmeasure.org" } }];
    const input: FhirR6DosageInstruction = { step: [{ component: [component] }] };
    for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), native = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(native).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
      if (kind === "cycle") { expect(native).toContain("1-5"); expect(native).toContain("28"); }
      if (kind === "clock window") { expect(native).toContain("08:00"); expect(native).toContain("18:00"); }
      if (kind === "offset") expect(native).toContain(locale === "en" ? "9:30 am" : "09:30");
      for (const wrapper of [false, true]) {
        let calls = 0;
        const actual = formatSig(input, "long", { locale, realizationMode: "normalized", i18n: { formatLong: context => {
          calls++;
          const timing = context.clause.schedule!;
          if (kind === "cycle") expect(timing.cycleDayConstraint).toMatchObject({ days: [1, 2, 3, 4, 5], periodDays: 28 });
          if (kind === "clock window") expect(timing.clockWindow).toEqual({ start: "08:00:00", end: "18:00:00", endInclusive: false });
          if (kind === "offset") expect(timing.administrationOffsetMinutes).toBe(30);
          expect(context.defaultText).toBe(native);
          expect(context.formatDefault("long")).toBe(native);
          return wrapper ? "Clinic: " + context.formatDefault("long") : "Clinic wording, unchanged!";
        } } });
        expect(actual).toBe(wrapper ? "Clinic: " + native : "Clinic wording, unchanged!");
        expect(calls).toBe(1);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("preserves a native locale through ordinary copied providers and inheritance", () => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [dose], condition: [guard],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }] };
    const thai = resolveSigLocalization("th")!;
    const copied = { ...thai, locale: "clinic-th-copy" };
    const keys = Reflect.ownKeys(copied);
    registerSigLocalization(copied);
    const expected = "ใช้ครั้งละ 1 เม็ด วันละครั้ง เฉพาะเมื่อ SBP > 160.";
    for (const options of [{ locale: copied.locale }, { i18n: { ...thai, locale: "clinic-th-call" } },
      { locale: "en", i18n: { inherit: copied.locale } }, { locale: "en", i18n: { inherit: "th" } }])
      expect(formatSig(source, "long", options)).toBe(expected);
    expect(Reflect.ownKeys(copied)).toEqual(keys);
    let calls = 0;
    expect(formatSig(source, "long", { i18n: { ...thai, locale: "clinic-th-hook", formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(expected);
      expect(context.formatDefault("long")).toBe(expected);
      return "Clinic: " + context.defaultText;
    } } })).toBe("Clinic: " + expected);
    expect(calls).toBe(1);
  });
});


describe("native renderer inheritance", () => {
  it.each(["en", "th"])("keeps partial-count timing roles in the complete %s callback default", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { text: "once daily" }, repeat: { frequencyMax: 3 } } };
    const sourceLabel = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
    const expected = locale === "en"
      ? "Current: Use 1 tablet up to 3 times; original directions: once daily."
      : "ปัจจุบัน: ใช้ครั้งละ 1 เม็ด ไม่เกิน 3 ครั้ง; ข้อความเดิม: once daily.";
    for (const input of [row, toDosageDetails([row])]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale })).toBe(expected);
      const compact = formatSig(input, "short", { locale }).split(sourceLabel);
      expect(compact).toHaveLength(2);
      expect(compact[0]).not.toContain("once daily");
      expect(compact[1]).toBe("once daily.");
      let calls = 0;
      expect(formatSig(input, "long", { locale, i18n: { formatLong: context => {
        calls++;
        expect(context.clause.schedule?.frequencyMax).toBe(3);
        expect(context.clause.schedule?.timingText ?? context.clause.schedule?.timingCode).toBe("once daily");
        expect(context.defaultText).toBe(expected);
        expect(context.formatDefault("long")).toBe(expected);
        expect(context.formatDefault("short").split(sourceLabel)[1]).toBe("once daily.");
        return "Clinical wording, unchanged!";
      } } })).toBe("Clinical wording, unchanged!");
      expect(calls).toBe(1);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("keeps the target native default when the inherited provider supplies only a short callback", () => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(input);
    const provider = { locale: "clinic-short-no-native", formatShort: () => "Clinic short" };
    const keys = Reflect.ownKeys(provider);
    registerSigLocalization(provider);
    const i18n = { inherit: provider.locale };
    const expected = "ใช้ครั้งละ 1 เม็ด วันละครั้ง.";
    expect(formatSig(input, "long", { locale: "th", i18n })).toBe(expected);
    expect(formatSig(input, "short", { locale: "th", i18n })).toBe("Clinic short");
    expect(formatSig(input, "long", { locale: "unregistered-native", i18n })).toBe("Use 1 tablet once daily.");
    const shortDefault = formatSig(input, "short", { locale: "th" });
    let calls = 0;
    expect(formatSig(input, "long", { locale: "th", i18n: { ...i18n, formatLong: context => {
      calls++;
      expect(context.defaultText).toBe(expected);
      expect(context.formatDefault("long")).toBe(expected);
      expect(context.formatDefault("short")).toBe(shortDefault);
      return "Clinical wording, unchanged!";
    } } })).toBe("Clinical wording, unchanged!");
    expect(calls).toBe(1);
    expect(Reflect.ownKeys(provider)).toEqual(keys);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("typed meal-state locale realization", () => {
  it("localizes an admitted negative food adjunct while retaining its dose and water", () => {
    const source = "Swallow 1 tablet with water without food";
    const parsed = parseSig(source), clause = parsed.meta.canonical.clauses[0];
    const frames = clause.additionalInstructions?.flatMap(instruction => instruction.frames ?? []);
    expect(frames).toContainEqual(expect.objectContaining({
      relation: AdviceRelation.Without,
      args: [expect.objectContaining({ role: AdviceArgumentRole.MealState,
        text: "food", normalized: "food", conceptId: "food" })]
    }));
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    const before = JSON.stringify([parsed.meta.canonical, parsed.fhir, parsed.fhirNext]);
    for (const input of [parsed.meta.canonical.course!,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" })
        .split("; original directions: ")[0];
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" })
        .split("; ข้อความเดิม: ")[0];
      expect(en).toContain("without food");
      expect(en).not.toContain("with food");
      expect(en).toContain("water");
      expect(en.match(/\b1 tablet\b/gu)).toHaveLength(1);
      expect(th).toMatch(/โดยไม่มี\s*อาหาร/u);
      expect(th).toContain("น้ำ");
      expect(th.match(/(?:^|[^\d.])1 เม็ด/gu)).toHaveLength(1);
      expect(th).not.toMatch(/food|water/iu);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify([parsed.meta.canonical, parsed.fhir, parsed.fhirNext])).toBe(before);
  });

  it.each([undefined, "อาหารที่จัดไว้"])("preserves typed identity and a supplied Thai nominal: %s", thai => {
    const source = "Take 1 tablet without food";
    const clause: CanonicalSigClause = {
      kind: "administration", rawText: source, raw: { start: 0, end: source.length, text: source },
      dose: { value: 1, unit: "tab" }, leftovers: [], evidence: [], confidence: 1,
      additionalInstructions: [{ text: "Take without food", frames: [{
        force: AdviceForce.Instruction, predicate: { lemma: "take", semanticClass: "administration" },
        relation: AdviceRelation.Without, sequenceIndex: 0,
        sourceText: "without food", span: { start: 14, end: source.length },
        args: [{ role: AdviceArgumentRole.MealState, text: "food", normalized: "food", conceptId: "food",
          ...(thai ? { i18n: { th: thai } } : {}) }]
      }] }]
    };
    const before = JSON.stringify(clause);
    const en = formatCanonicalClause(clause, "long", resolveSigLocalization("en"));
    const th = formatCanonicalClause(clause, "long", resolveSigLocalization("th"));
    expect(en).toContain("without food");
    expect(th).toContain("โดยไม่มี " + (thai ?? "อาหาร"));
    expect(th).not.toContain("food");
    expect(JSON.stringify(clause)).toBe(before);
  });
});

describe("native timing realization uses selected language and event owners", () => {
  it.each(["en", "th"])("uses the selected %s interval unit for coded and structured timing", locale => {
    const i18n = { locale: "clinic-interval-" + locale, inherit: locale,
      course: { timeUnit: (unit: string) => unit === "h" ? "clinic-hour" : undefined } };
    for (const timing of [
      { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q6H" }] } },
      { repeat: { period: 6, periodUnit: FhirPeriodUnit.Hour } }
    ]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing };
      for (const input of [row, toDosageDetails([row])])
        expect(formatSig(input, "long", { locale, i18n, realizationMode: "normalized" }))
          .toContain(locale === "en" ? "every 6 clinic-hour" : "ทุก 6 clinic-hour");
    }
    for (const period of [1, 6]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { period, periodUnit: FhirPeriodUnit.Hour } } };
      expect(formatSig(row, "long", { locale })).toContain(locale === "en"
        ? `every ${period} ${period === 1 ? "hour" : "hours"}` : `ทุก ${period} ชั่วโมง`);
    }
  });

  it.each(["code", "event", "clock"] as const)("retains the %s event owner in a partial-period preview", owner => {
    const timing: NonNullable<FhirR6DosageInstruction["step"][number]["component"][number]["timing"]> = {
      code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "AM" }] },
      repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        endOffset: { value: 1, unit: "h", system: "http://unitsofmeasure.org", code: "h" },
        ...(owner === "event" ? { when: [EventTiming.Evening] } : owner === "clock" ? { timeOfDay: ["20:00:00"] } : {}) }
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing
    }] }] };
    const before = JSON.stringify(raw);
    const converted = toFhirR5Dosages(raw);
    for (const input of [raw, converted]) for (const locale of ["en", "th"])
      for (const style of ["short", "long"] as const) {
        const text = formatSig(input, style, { locale, realizationMode: "normalized" });
        if (owner === "code") expect(text).toContain(locale === "en" ? style === "short" ? "MORN" : "morning" : "เช้า");
        else {
          expect(text).not.toContain(locale === "en" ? style === "short" ? "MORN" : "morning" : "เช้า");
          if (owner === "event") expect(text).toContain(locale === "en" ? style === "short" ? "EVE" : "evening" : "เย็น");
          else expect(text).toContain(locale === "en" && style === "long" ? "8:00 pm" : "20:00");
        }
        expect(text).toContain(locale === "en"
          ? "No doses during the final 1 hour of each period" : "งดยาในช่วง 1 ชั่วโมงสุดท้ายของแต่ละรอบ");
      }
    expect(converted[0].timing?.code).toEqual(timing.code);
    expect(raw.step[0].component[0].timing?.code).toEqual(timing.code);
    expect(JSON.stringify(raw)).toBe(before);
  });
});


describe("published course providers with shared schedule limits", () => {
  it.each(["en", "th"])("inherits native %s shared wording with a plain customized count provider", inherit => {
    // An existing provider implements the published course facet, without a
    // newly required method for an internally introduced shared-schedule view.
    const { sharedAdministration: _unpublished, ...published } = resolveSigLocalization(inherit)!.course! as
      CourseLanguage & { sharedAdministration?: unknown };
    const course: CourseLanguage = { ...published, administrations: count => count + " clinic administrations" };
    const i18n = { locale: "x-clinic-" + inherit, inherit, course };
    const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. On Mondays, do not take the 1-tablet morning dose.";
    const parsed = parseSig(source), original = JSON.stringify(parsed);
    const localized = parseSig(source, { i18n });
    expect(localized.longText.match(/4 clinic administrations/gu)).toHaveLength(1);
    expect(localized.fhirNext.renderedInstruction).toBe(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const text = formatSig(input, "long", { i18n, realizationMode: "normalized" });
      expect(text.match(/4 clinic administrations/gu)).toHaveLength(1);
      expect(text).toContain(inherit === "en" ? "Schedule sharing its limits" : "ตารางให้ยาที่ใช้ข้อจำกัดร่วมกัน");
      expect(text).toMatch(inherit === "en" ? /8:00 am/u : /08:00/u);
      expect(text).toMatch(inherit === "en" ? /8:00 pm/u : /20:00/u);
      expect(text).toContain(inherit === "en" ? "except Monday" : "ยกเว้นวันจันทร์");
      expect(JSON.stringify(input)).toBe(before);
    }
    const ordinary = parseSig("Take 1 tablet at 08:00 daily.").meta.canonical.course!;
    expect(formatSig(ordinary, "long", { i18n })).toBe(formatSig(ordinary, "long", { locale: inherit }));
    expect(JSON.stringify(parsed)).toBe(original);
    expect(course.administrations("4")).toBe("4 clinic administrations");
    expect("sharedAdministration" in course).toBe(false);
  });
});


describe("scoped warning ownership with a registered course provider", () => {
  it("keeps conditional warnings and the customized shared total through native and wire views", () => {
    const locale = "x-clinic-warning";
    const course: CourseLanguage = {
      ...resolveSigLocalization("en")!.course!,
      administrations: count => count + " clinic administrations"
    };
    registerSigLocalization({ locale, inherit: "en", course });
    const warning = "If dizzy, do not take the 1-tablet morning dose";
    const source = "Take 1 tablet at 08:00 and 20:00 for 4 doses. " + warning + ".";
    const parsed = parseSig(source);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(/4 clinic administrations/gu)).toHaveLength(1);
      expect(text.split(warning)).toHaveLength(3);
      expect(text).not.toContain("Do not take the 1 tablet morning dose");
      expect(text).toContain("1 tablet orally at 8:00 am unless dizzy");
      expect(text).toContain("1 tablet orally at 8:00 pm");
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});
