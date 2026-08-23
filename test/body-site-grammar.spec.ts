import { describe, expect, it } from "vitest";
import { resolveBodySitePhrase } from "../src/body-site-grammar";

describe("body-site terminal inheritance", () => {
  it("does not erase clinically meaningful modifiers into an exact base-site code", () => {
    for (const phrase of [
      "affected knee",
      "broken knee",
      "painful knee",
      "external knee",
      "irritated knee",
      "inflamed knee"
    ]) {
      const resolved = resolveBodySitePhrase(phrase, undefined, { allowTerminalModifierInheritance: true });
      expect(resolved?.coding, phrase).toBeUndefined();
    }
  });

  it("retains terminal inheritance for non-pathological administration qualifiers", () => {
    const resolved = resolveBodySitePhrase("dry knee", undefined, { allowTerminalModifierInheritance: true });
    expect(resolved?.coding?.code).toBe("72696002");
    expect(resolved?.displayText).toBe("dry knee");
  });
});
