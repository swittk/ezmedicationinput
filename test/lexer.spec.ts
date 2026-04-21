import { describe, expect, it } from "vitest";
import { normalizeBodySiteKey } from "../src/maps";
import { lexInput } from "../src/lexer/lex";
import { scanSurfaceTokens } from "../src/lexer/surface";
import { LexKind, SurfaceTokenKind } from "../src/lexer/token-types";

describe("surface tokenization", () => {
  it("preserves exact source spans and separators", () => {
    const input = "OD q2h; apply to scalp";
    const tokens = scanSurfaceTokens(input);

    expect(tokens.map((token) => token.original)).toEqual([
      "OD",
      "q2h",
      ";",
      "apply",
      "to",
      "scalp"
    ]);
    expect(tokens[2]).toMatchObject({
      original: ";",
      kind: SurfaceTokenKind.Separator,
      start: 6,
      end: 7
    });
    expect(input.slice(tokens[5].start, tokens[5].end)).toBe("scalp");
  });
});

describe("lex normalization", () => {
  it("splits compact forms while retaining source provenance", () => {
    const input = "500mg poac @8:00";
    const tokens = lexInput(input);

    expect(tokens.map((token) => token.original)).toEqual([
      "500",
      "mg",
      "po",
      "ac",
      "@8:00"
    ]);
    expect(tokens[0]).toMatchObject({
      kind: LexKind.Number,
      sourceStart: 0,
      sourceEnd: 3
    });
    expect(tokens[1]).toMatchObject({
      kind: LexKind.Word,
      sourceStart: 3,
      sourceEnd: 5,
      derived: true
    });
    expect(tokens[2]).toMatchObject({
      original: "po",
      sourceStart: 6,
      sourceEnd: 8,
      derived: true
    });
    expect(tokens[4]).toMatchObject({
      kind: LexKind.TimeLike,
      sourceStart: 11,
      sourceEnd: 16
    });
  });

  it("normalizes day ranges from exact source tokens", () => {
    const input = "mon - fri";
    const tokens = lexInput(input);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      original: "mon-fri",
      kind: LexKind.Word,
      sourceStart: 0,
      sourceEnd: input.length,
      derived: true
    });
  });
});

describe("loose phrase normalization", () => {
  it("preserves thai text while stripping punctuation without unicode property regexes", () => {
    expect(normalizeBodySiteKey("  ศีรษะ/head  ")).toBe("ศีรษะ head");
    expect(normalizeBodySiteKey("บริเวณ-ที่เป็น")).toBe("บริเวณ ที่เป็น");
  });
});
