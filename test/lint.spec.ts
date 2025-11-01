import { describe, expect, it } from "vitest";
import { lintSig } from "../src/index";

const TAB_CONTEXT = { dosageForm: "tab" } as const;

describe("lintSig", () => {
  it("returns no issues for fully parsed sigs", () => {
    const linted = lintSig("1 tab po bid", { context: TAB_CONTEXT });
    expect(linted.issues).toHaveLength(0);
    expect(linted.result.meta.leftoverText).toBeUndefined();
  });

  it("captures trailing unparsed text", () => {
    const input = "1 tab po bid ???";
    const linted = lintSig(input, { context: TAB_CONTEXT });
    expect(linted.issues).toHaveLength(1);
    const [issue] = linted.issues;
    expect(issue.message).toBe("Unrecognized text");
    expect(issue.text).toBe("???");
    expect(issue.tokens).toEqual(["???"]);
    expect(issue.range).toEqual({ start: input.indexOf("???"), end: input.length });
  });

  it("separates disjoint unparsed segments", () => {
    const input = "??? 1 tab po bid ???";
    const linted = lintSig(input, { context: TAB_CONTEXT });
    expect(linted.issues).toHaveLength(2);
    const [leading, trailing] = linted.issues;
    expect(leading.text).toBe("???");
    expect(leading.range).toEqual({ start: 0, end: 3 });
    expect(trailing.text).toBe("???");
    expect(trailing.range).toEqual({
      start: input.lastIndexOf("???"),
      end: input.lastIndexOf("???") + 3
    });
  });
});
