import { describe, expect, it } from "vitest";
import { parseSig, suggestSig } from "../src";
import { RouteCode } from "../src/types";

const TAB_CONTEXT = { context: { dosageForm: "tablet" } } as const;

describe("suggestSig", () => {
  it("returns default suggestions when input empty", () => {
    const suggestions = suggestSig("", { limit: 5 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toBe("1 tab po qd");
  });

  it("suggests completions for 1x shorthand", () => {
    const suggestions = suggestSig("1x");
    expect(suggestions).toContain("1x3 po pc");
    expect(suggestions).toContain("1x2 po bid");
  });

  it("extends existing tokens", () => {
    const suggestions = suggestSig("1 tab po q");
    expect(suggestions).toContain("1 tab po qd");
  });

  it("adapts to inferred units from context", () => {
    const suggestions = suggestSig("", { ...TAB_CONTEXT, limit: 3 });
    expect(suggestions).toContain("1 tab po qd");
    expect(suggestions[0]).toBe("1 tab po qd");
  });

  it("propagates numeric dose values from the prefix", () => {
    const suggestions = suggestSig("5 m", { limit: 10 });
    expect(suggestions).toContain("5 mL po qd");
    expect(suggestions[0]).toBe("5 mL po qd");
  });

  it("handles fractional doses without losing defaults", () => {
    const suggestions = suggestSig("0.5 tab", { limit: 10 });
    expect(suggestions).toContain("0.5 tab po qd");
    expect(suggestions[0]).toBe("0.5 tab po qd");
  });

  it("expands PRN suggestions with richer reasons", () => {
    const suggestions = suggestSig("1 tab po prn a", { limit: 10 });
    expect(suggestions).toContain("1 tab po prn anxiety");
  });

  it("accepts custom PRN reasons while keeping defaults", () => {
    const suggestions = suggestSig("1 tab po prn", {
      limit: 15,
      prnReasons: ["agitation", " Pain  "],
    });
    expect(suggestions).toContain("1 tab po prn agitation");
    expect(suggestions).toContain("1 tab po prn pain");
  });

  it("supports multi-token timing cues", () => {
    const suggestions = suggestSig("1 tab po morn hs", { limit: 20 });
    expect(suggestions).toContain("1 tab po morn hs");
  });

  it("supports compact oral meal timing shortcuts", () => {
    expect(suggestSig("1 poc", { limit: 10 })).toContain("1 po c");
    expect(suggestSig("1 popc", { limit: 10 })).toContain("1 po pc");
    expect(suggestSig("1 poac", { limit: 10 })).toContain("1 po ac");
    expect(suggestSig("1 po c", { limit: 10 })).toContain("1 po c");
  });

  it("only emits meal-dash suggestions when dash syntax is actively typed", () => {
    const noDash = suggestSig("1", { limit: 10, enableMealDashSyntax: true });
    expect(noDash.some((value) => value.includes("-"))).toBe(false);

    const dash = suggestSig("1-", { limit: 10, enableMealDashSyntax: true });
    expect(dash.some((value) => value.startsWith("1-0-1"))).toBe(true);
  });

  it("keeps matching when connectors and eye tokens are present", () => {
    const suggestions = suggestSig("1 drop to od q2h", { limit: 20 });
    expect(
      suggestions.some((value) => value.startsWith("1 drop") && value.includes("q2h")),
    ).toBe(true);
  });

  it("suggests interval ranges with PRN reasons", () => {
    const suggestions = suggestSig("500 mg po q4-6h prn pain", { limit: 20 });
    expect(suggestions).toContain("500 mg po q4-6h prn pain");
  });

  it("honors pluralized dose units", () => {
    const suggestions = suggestSig("5 tabs", { limit: 20 });
    expect(suggestions.some((value) => value.startsWith("5 tabs"))).toBe(true);
  });

  it("offers spelled metric unit suggestions", () => {
    const suggestions = suggestSig("500 millig", { limit: 25 });
    expect(suggestions).toContain("500 milligrams po qd");
  });

  it("suggests SI-prefixed mass and volume units", () => {
    const micrograms = suggestSig("50 microg", { limit: 30 });
    expect(micrograms).toContain("50 micrograms po qd");

    const microliters = suggestSig("10 mcl", { limit: 30 });
    expect(microliters).toContain("10 mcL po qd");

    const nanograms = suggestSig("2 ng", { limit: 30 });
    expect(nanograms).toContain("2 ng po qd");

    const liters = suggestSig("1 L", { limit: 30 });
    expect(liters).toContain("1 L po qd");

    const kilograms = suggestSig("0.5 kilogram", { limit: 30 });
    expect(kilograms.some((value) => value.startsWith("0.5 kg") || value.startsWith("0.5 kilograms"))).toBe(true);
  });

  it("suggests household measure units", () => {
    const teaspoons = suggestSig("1 teasp", { limit: 25 });
    expect(teaspoons.some((value) => value.startsWith("1 teaspoon"))).toBe(true);

    const tablespoons = suggestSig("2 tbsp", { limit: 25 });
    expect(tablespoons).toContain("2 tbsp po qd");
  });

  it("disables household measure suggestions when requested", () => {
    const suggestions = suggestSig("1 teasp", {
      limit: 25,
      allowHouseholdVolumeUnits: false,
    });
    expect(suggestions.some((value) => value.includes("teaspoon") || value.includes("tsp"))).toBe(
      false,
    );
  });

  it("uses Thai defaults when the requested locale is Thai", () => {
    const suggestions = suggestSig("", { locale: "th", limit: 5 });
    expect(suggestions[0]).toBe("รับประทาน 1 เม็ด วันละครั้ง");
    expect(suggestions.some((value) => value.includes("tab po"))).toBe(false);
  });

  it("matches mixed-case unit canonicals against Thai locale lexemes", () => {
    const suggestions = suggestSig("", {
      locale: "th",
      limit: 3,
      context: { dosageForm: "oral solution" }
    });
    expect(suggestions[0]).toBe("รับประทาน 1 มล วันละครั้ง");
    expect(suggestions.some((value) => value.includes("mL"))).toBe(false);
  });

  it("completes Thai PRN symptom tails from parser PRN terminology", () => {
    const suggestions = suggestSig("รับประทาน 1 เม็ด เมื่อมีอาการปว", { locale: "th", limit: 5 });
    expect(suggestions).toContain("รับประทาน 1 เม็ด เมื่อมีอาการปวด");
    expect(suggestions.some((value) => value.includes("tab po"))).toBe(false);
  });

  it("completes Thai dose-unit tails from the parser locale lexicon", () => {
    expect(suggestSig("รับประทาน 1 เม", { locale: "th", limit: 5 }))
      .toContain("รับประทาน 1 เม็ด");
  });

  it("prefers complete Thai schedule surfaces over parser-only abbreviated aliases", () => {
    const suggestions = suggestSig("รับประทาน 1 เม็ด ว", { locale: "th", limit: 10 });
    expect(suggestions[0]).toBe("รับประทาน 1 เม็ด วันละครั้ง");
    expect(suggestions).toContain("รับประทาน 1 เม็ด วันเสาร์");
    expect(suggestions).not.toContain("รับประทาน 1 เม็ด วันส");
  });

  it("uses multiword body-site prefixes and ocular abbreviations", () => {
    expect(suggestSig("apply to right e", { limit: 10 })).toContain("apply to right eye");
    const ocular = suggestSig("1 drop to o", { limit: 10 });
    expect(ocular).toEqual(expect.arrayContaining(["1 drop to od", "1 drop to os", "1 drop to ou"]));
  });

  it("keeps into intact as a body-site preposition", () => {
    const suggestions = suggestSig("instill into r", { limit: 10 });
    expect(suggestions).toContain("instill into rectum");
    expect(suggestions.some((value) => value.startsWith("instill in to"))).toBe(false);
  });

  it("completes natural before/after event tails through parser grammar vocabularies", () => {
    expect(suggestSig("รับประทาน 1 เม็ด ก่อนอ", { locale: "th", limit: 8 }))
      .toContain("รับประทาน 1 เม็ด ก่อนอาหาร");
    expect(suggestSig("รับประทาน 1 เม็ด หลังอ", { locale: "th", limit: 8 }))
      .toContain("รับประทาน 1 เม็ด หลังอาหาร");

    const before = suggestSig("take 1 tab bef", { limit: 8 });
    expect(before).toContain("take 1 tab before breakfast");
    const after = suggestSig("take 1 tab after b", { limit: 8 });
    expect(after).toContain("take 1 tab after breakfast");
    expect(after.some((value) => value.includes(" bid"))).toBe(false);
  });

  it("completes Thai body-site aliases from the canonical site terminology", () => {
    expect(suggestSig("ทาบริเวณผ", { locale: "th", limit: 8 }))
      .toContain("ทาบริเวณผิวหนัง");
  });

  it("does not suggest a second route when the parsed prefix already has one", () => {
    const suggestions = suggestSig("1 tab po b", { limit: 10 });
    expect(suggestions[0]).toBe("1 tab po bid");
    expect(suggestions).not.toContain("1 tab po by mouth");
    expect(suggestSig("wash ex", { limit: 10 })).toEqual([]);
  });

  it("exposes distinct semantic trajectories from action-only prefixes", () => {
    const thaiTake = suggestSig("กิน", { locale: "th", limit: 10 });
    expect(thaiTake).toEqual(expect.arrayContaining([
      "กิน 1 เม็ด",
      "กิน 1 เม็ด วันละครั้ง",
      "กิน วันละ 2 ครั้ง",
      "กิน ก่อนอาหาร",
      "กิน หลังอาหาร",
      "กิน ก่อนนอน",
      "กินเมื่อมีอาการปวด",
    ]));

    const thaiApply = suggestSig("ทา", { locale: "th", limit: 10 });
    expect(thaiApply).toEqual(expect.arrayContaining([
      "ทาบริเวณที่มีอาการ",
      "ทา วันละ 2 ครั้ง",
      "ทา ก่อนนอน",
      "ทาเมื่อมีอาการคัน",
    ]));
    expect(thaiApply.some((value) => value.includes("ก่อนอาหาร") || value.includes("หลังอาหาร"))).toBe(false);

    const englishTake = suggestSig("take", { limit: 10 });
    expect(englishTake).toEqual(expect.arrayContaining([
      "take 1 tab",
      "take 1 tab once daily",
      "take twice daily",
      "take before meals",
      "take after meals",
      "take at bedtime",
      "take as needed for pain",
    ]));

    const englishApply = suggestSig("apply", { limit: 10 });
    expect(englishApply).toEqual(expect.arrayContaining([
      "apply to affected area",
      "apply twice daily",
      "apply at bedtime",
      "apply as needed for itching",
    ]));
    expect(englishApply.some((value) => value.includes("before meals") || value.includes("after meals"))).toBe(false);

    for (const [candidate, locale] of [
      ...thaiTake.map((candidate) => [candidate, "th"] as const),
      ...thaiApply.map((candidate) => [candidate, "th"] as const),
      ...englishTake.map((candidate) => [candidate, "en"] as const),
      ...englishApply.map((candidate) => [candidate, "en"] as const),
    ]) {
      expect(parseSig(candidate, { locale }).meta.leftoverText).toBeUndefined();
    }
  });

  it("continues complete dose and classic sig states along semantic trajectories", () => {
    const naturalDose = suggestSig("take 1 tab", { limit: 10 });
    expect(naturalDose).toEqual(expect.arrayContaining([
      "take 1 tab twice daily",
      "take 1 tab before meals",
      "take 1 tab at bedtime",
      "take 1 tab as needed for pain",
    ]));

    const takeBeforeMeals = suggestSig("take before meals", { limit: 10 });
    expect(takeBeforeMeals).toContain("take before meals 1 tab");
    const applyAffectedArea = suggestSig("apply to affected area", { limit: 10 });
    expect(applyAffectedArea).toContain("apply to affected area 1 g");

    const compact = suggestSig("1 tab po", { limit: 10 });
    expect(compact).toEqual(expect.arrayContaining([
      "1 tab po twice daily",
      "1 tab po before meals",
      "1 tab po at bedtime",
      "1 tab po as needed for pain",
    ]));
    for (const candidate of [...naturalDose, ...compact, ...takeBeforeMeals, ...applyAffectedArea]) {
      expect(parseSig(candidate).meta.leftoverText).toBeUndefined();
    }
  });

  it("does not invent oral-tablet trajectories for route-ambiguous specialty verbs", () => {
    expect(suggestSig("inhale", { limit: 10 })).toEqual(expect.arrayContaining([
      "inhale 1 puff",
      "inhale once daily"
    ]));
    for (const action of ["instill", "spray", "inject", "insert"]) {
      const suggestions = suggestSig(action, { limit: 10 });
      expect(suggestions.some((value) => /\b(?:tab|tablet)\b/i.test(value))).toBe(false);
      expect(suggestions.some((value) => value.includes("before meals") || value.includes("after meals"))).toBe(false);
    }
  });

  it("continues lexical completions into the next semantic slot", () => {
    const suggestions = suggestSig("กิน ครั้งล", { locale: "th", limit: 10 });
    expect(suggestions[0]).toBe("กิน ครั้งละ");
    expect(suggestions).toContain("กิน ครั้งละ 1 เม็ด");
    expect(suggestions).toContain("กิน ครั้งละ 1 เม็ด วันละครั้ง");
  });

  it("uses the parser-owned Thai locale lexicon for partial grammar words", () => {
    const suggestions = suggestSig("คว", { locale: "th", limit: 5 });
    expect(suggestions).toContain("ควร");
    expect(suggestions.some((value) => value.includes("tab po"))).toBe(false);
  });

  it("keeps representative suggestions inside the parser language", () => {
    const cases = [
      { prefix: "", options: {} },
      { prefix: "1x", options: {} },
      { prefix: "1 tab po q", options: {} },
      { prefix: "1 tab po prn a", options: {} },
      { prefix: "at 14:3", options: {} },
      { prefix: "ทา", options: { locale: "th" } },
      { prefix: "รับประทาน 1 เม็ด เมื่อมีอาการปว", options: { locale: "th" } },
      { prefix: "รับประทาน 1 เม", options: { locale: "th" } },
      { prefix: "รับประทาน 1 เม็ด ว", options: { locale: "th" } },
      { prefix: "apply to right e", options: {} },
      { prefix: "1 drop to o", options: {} },
      { prefix: "1 tab po b", options: {} },
      { prefix: "รับประทาน 1 เม็ด ก่อนอ", options: { locale: "th" } },
      { prefix: "รับประทาน 1 เม็ด หลังอ", options: { locale: "th" } },
      { prefix: "take 1 tab bef", options: {} },
      { prefix: "take 1 tab after b", options: {} },
      { prefix: "ทาบริเวณผ", options: { locale: "th" } }
    ] as const;
    for (const { prefix, options } of cases) {
      const suggestions = suggestSig(prefix, { ...options, limit: 5 });
      expect(suggestions.length).toBeGreaterThan(0);
      for (const suggestion of suggestions) {
        expect(parseSig(suggestion, options).meta.leftoverText).toBeUndefined();
      }
    }
  });

  it("returns cheaply bounded no-match results instead of default noise", () => {
    expect(suggestSig("zzzz", { limit: 20 })).toEqual([]);
  });

  it("suggests from Thai action terminology instead of falling back to English defaults", () => {
    const suggestions = suggestSig("ทา", { locale: "th", limit: 5 });
    expect(suggestions[0]).toBe("ทา");
    expect(suggestions).toContain("ทา วันละครั้ง");
    expect(suggestions.some((value) => value.includes("tab po"))).toBe(false);
  });

  it("suggests complete administration actions understood by the HPSG parser", () => {
    expect(suggestSig("wash", { limit: 5 })).toContain("wash");
    expect(suggestSig("apply", { limit: 5 })).toContain("apply");
  });

  it("surfaces PRN reasons from the parser terminology rather than a suggester-only shortlist", () => {
    expect(suggestSig("1 tab po prn mig", { limit: 10 })).toContain("1 tab po prn migraine");
  });

  it("surfaces runtime PRN terminology", () => {
    expect(suggestSig("1 tab po prn restp", {
      limit: 10,
      prnReasonMap: { restpainz: { text: "Rest pain Z" } }
    })).toContain("1 tab po prn restpainz");
  });

  it("surfaces runtime route aliases from ParseOptions", () => {
    expect(suggestSig("1 tab cust", {
      limit: 10,
      routeMap: { customoral: RouteCode["Oral route"] }
    })).toContain("1 tab customoral");
  });

  it("surfaces runtime body-site vocabulary", () => {
    expect(suggestSig("apply to spec", {
      limit: 10,
      siteCodeMap: {
        "special spot": { text: "special spot" }
      }
    })).toContain("apply to special spot");
  });

  it("ranks built-in English body sites before matching runtime sites", () => {
    expect(suggestSig("apply to ar", {
      limit: 10,
      siteCodeMap: {
        "arm custom": { text: "arm custom" }
      }
    }).slice(0, 2)).toEqual(["apply to arm", "apply to arm custom"]);
  });

  it("surfaces runtime unit aliases without adding a suggester branch", () => {
    expect(suggestSig("5 sco", {
      limit: 10,
      unitMap: { scoop: "tab" }
    })).toContain("5 scoop po qd");
  });

  it("surfaces runtime custom action terminology without hard-coded suggester branches", () => {
    const suggestions = suggestSig("pai", {
      limit: 5,
      instructionActionMap: {
        paint: {
          code: "paint",
          display: "Paint",
          aliases: ["paint", "painting"]
        }
      }
    });
    expect(suggestions).toContain("paint");
    expect(suggestions).toContain("painting");
  });

  it("short-circuits already complete semantic directions", () => {
    const source = "500 mg po q4-6h prn pain";
    expect(suggestSig(source, { limit: 20 })[0]).toBe(source);
  });

  it("supports time-based suggestions", () => {
    const suggestions = suggestSig("at 9");
    // Should suggest 9:00 am and 9:00 pm at least
    expect(suggestions.some(s => s.includes("at 9:00 am"))).toBe(true);
    expect(suggestions.some(s => s.includes("at 9:00 pm"))).toBe(true);
  });

  it("completes partial times", () => {
    const suggestions = suggestSig("at 14:3");
    expect(suggestions.some(s => s.includes("at 14:30"))).toBe(true);
  });

  it("validates semantic trajectories against caller vocabulary", () => {
    const options = {
      limit: 10,
      context: { dosageForm: "tablet" },
      unitMap: { scoop: "tab" },
      prnReasonMap: { restpainz: { text: "Rest pain Z" } }
    };
    const suggestions = suggestSig("take", options);
    expect(suggestions.length).toBeGreaterThan(1);
    for (const candidate of suggestions) {
      expect(parseSig(candidate, options).meta.leftoverText).toBeUndefined();
    }
  });

  it("does not offer preposed-duration markers as standalone actions", () => {
    expect(suggestSig("of", { limit: 10 })).not.toContain("off");
    expect(suggestSig("pau", { limit: 10 })).not.toContain("pause use");
    expect(parseSig("take 1 tab daily x21d then 7 days off").meta.leftoverText).toBeUndefined();
  });

});
