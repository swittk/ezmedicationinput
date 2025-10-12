import { describe, expect, it } from "vitest";
import { suggestSig } from "../src";

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
});
