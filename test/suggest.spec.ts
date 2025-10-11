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
});
