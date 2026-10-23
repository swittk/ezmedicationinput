import { describe, expect, it, vi } from "vitest";
import { cloneStructuredValue, equalStructuredValues, hashStructuredValue } from "../src/stable-structure";

describe("structured comparison, cloning and candidate hashing", () => {
  it("ignores object property insertion order recursively", () => {
    const left = { relation: "before", activity: { text: "exercise", coding: { code: "x", system: "s" } }, offset: 15 };
    const right = { offset: 15, activity: { coding: { system: "s", code: "x" }, text: "exercise" }, relation: "before" };
    expect(equalStructuredValues(left, right)).toBe(true);
    expect(hashStructuredValue(left)).toBe(hashStructuredValue(right));
  });

  it("preserves array order and scalar types", () => {
    expect(equalStructuredValues({ values: [1, 2] }, { values: [2, 1] })).toBe(false);
    expect(equalStructuredValues({ value: 1 }, { value: "1" })).toBe(false);
    expect(equalStructuredValues({ value: 1 }, { value: 2 })).toBe(false);
    expect(equalStructuredValues(null, {})).toBe(false);
    expect(equalStructuredValues([], {})).toBe(false);
  });

  it("treats optional undefined fields symmetrically without ignoring a real edit", () => {
    const absent = { value: 1 };
    const optional = { value: 1, unit: undefined };
    const defined = { value: 1, unit: "mL" };
    expect(equalStructuredValues(absent, optional)).toBe(true);
    expect(equalStructuredValues(optional, absent)).toBe(true);
    expect(hashStructuredValue(absent)).toBe(hashStructuredValue(optional));
    expect(equalStructuredValues(optional, defined)).toBe(false);
    expect(equalStructuredValues(defined, optional)).toBe(false);
    expect(equalStructuredValues(absent, defined)).toBe(false);
    expect(equalStructuredValues(defined, absent)).toBe(false);
  });

  it("does not alias independently editable nested metadata", () => {
    const source = { dose: { value: 1, unit: "mL" }, extensions: [
      { url: "urn:test:unknown", nested: { retained: "yes" } }
    ], optional: undefined };
    const first = cloneStructuredValue(source);
    const second = cloneStructuredValue(source);
    first.dose.value = 2;
    first.extensions[0].nested.retained = "edited";
    expect(source.dose.value).toBe(1);
    expect(second.dose.value).toBe(1);
    expect(second.extensions[0].nested.retained).toBe("yes");
    expect(Object.prototype.hasOwnProperty.call(first, "optional")).toBe(true);
  });

  it("never uses JSON or invokes toJSON during equality, cloning or hashing", () => {
    const source = { dose: { value: 1, unit: "mL" }, toJSON: vi.fn(() => ({ corrupt: true })) };
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("not a transport boundary"); });
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new Error("not a transport boundary"); });
    let copy: typeof source;
    let equal: boolean;
    let hashesEqual: boolean;
    try {
      copy = cloneStructuredValue(source);
      equal = equalStructuredValues(source, copy);
      hashesEqual = hashStructuredValue(source) === hashStructuredValue(copy);
    } finally {
      stringify.mockRestore();
      parse.mockRestore();
    }
    expect(copy!.dose).toEqual({ value: 1, unit: "mL" });
    expect(equal!).toBe(true);
    expect(hashesEqual!).toBe(true);
    expect(source.toJSON).not.toHaveBeenCalled();
  });
});
