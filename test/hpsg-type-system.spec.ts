import { describe, expect, it } from "vitest";
import {
  HPSG_TYPE_SYSTEM,
  HpsgTypeSystem,
  canonicalFeatureStructure,
  featureAtom,
  featureNode,
  unifyFeatureStructures,
  validateFeatureStructure
} from "../src/hpsg/type-system";
import { signFeatureStructure } from "../src/hpsg/feature-structure";

describe("formal HPSG typed feature structures", () => {
  it("uses a real subtype hierarchy for signs", () => {
    expect(HPSG_TYPE_SYSTEM.isSubtype("method-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("method-sign", "sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("clause-sign", "phrase-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("conditional-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("adjustment-sign", "word-sign")).toBe(true);
    expect(HPSG_TYPE_SYSTEM.isSubtype("clause-sign", "word-sign")).toBe(false);
  });

  it("supports multiple inheritance and computes a compatible subtype", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "left", parents: ["top"] },
      { name: "right", parents: ["top"] },
      { name: "both", parents: ["left", "right"] }
    ]);
    expect(types.isSubtype("both", "left")).toBe(true);
    expect(types.isSubtype("both", "right")).toBe(true);
    expect(types.mostSpecificCompatibleType("left", "right")).toBe("both");
  });

  it("enforces appropriateness constraints", () => {
    const malformed = featureNode("method-sign", {
      SYNSEM: featureNode("synsem", {
        HEAD: featureNode("head", { ILLEGAL: featureNode("method-feature") }),
        VALENCE: featureNode("valence"),
        CONT: featureNode("content")
      })
    });
    const issues = validateFeatureStructure(malformed, HPSG_TYPE_SYSTEM);
    expect(issues.some((issue) => issue.message.includes("not appropriate"))).toBe(true);
  });

  it("performs general feature unification and rejects atom conflicts", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "atom", parents: ["top"] },
      { name: "string", parents: ["atom"] },
      { name: "record", parents: ["top"], features: { NAME: { valueType: "string" } } }
    ]);
    const left = featureNode("record", { NAME: featureAtom("alpha") });
    const same = featureNode("record", { NAME: featureAtom("alpha") });
    const different = featureNode("record", { NAME: featureAtom("beta") });
    expect(unifyFeatureStructures(left, same, types).value).toBeDefined();
    expect(unifyFeatureStructures(left, different, types).value).toBeUndefined();
  });

  it("preserves reentrancy when a shared feature value is unified", () => {
    const types = new HpsgTypeSystem([
      { name: "top" },
      { name: "thing", parents: ["top"] },
      {
        name: "pair",
        parents: ["top"],
        features: { LEFT: { valueType: "thing" }, RIGHT: { valueType: "thing" } }
      }
    ]);
    const shared = featureNode("thing");
    const left = featureNode("pair", { LEFT: shared, RIGHT: shared });
    const right = featureNode("pair");
    const unified = unifyFeatureStructures(left, right, types).value;
    expect(unified?.kind).toBe("node");
    if (!unified || unified.kind !== "node") return;
    expect(unified.features.LEFT).toBe(unified.features.RIGHT);
    expect(canonicalFeatureStructure(unified)).toContain('"ref"');
  });

  it("materializes existing medication SYNSEM as an appropriate typed sign", () => {
    const fs = signFeatureStructure("method-sign", {
      head: { method: { verb: "apply" } },
      valence: {},
      cont: { clauseKind: "administration" }
    });
    expect(validateFeatureStructure(fs, HPSG_TYPE_SYSTEM)).toEqual([]);
    expect(fs.features.SYNSEM?.kind).toBe("node");
  });
});
