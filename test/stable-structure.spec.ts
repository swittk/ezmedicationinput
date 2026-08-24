import { describe, expect, it } from "vitest";
import { stableStructureKey } from "../src/stable-structure";

describe("stable structured dedupe keys", () => {
  it("ignores object property insertion order recursively", () => {
    const left = { relation: "before", activity: { text: "exercise", coding: { code: "x", system: "s" } }, offset: 15 };
    const right = { offset: 15, activity: { coding: { system: "s", code: "x" }, text: "exercise" }, relation: "before" };
    expect(stableStructureKey(left)).toBe(stableStructureKey(right));
  });

  it("preserves array order", () => {
    expect(stableStructureKey({ values: [1, 2] })).not.toBe(stableStructureKey({ values: [2, 1] }));
  });
});
