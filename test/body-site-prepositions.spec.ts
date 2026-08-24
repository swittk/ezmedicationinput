import { describe, expect, it } from "vitest";
import { formatSig, parseSig } from "../src";

const SNOMED = "http://snomed.info/sct";
const EXTERNAL_GENITALIA = "362207005";
const VULVA = "45292006";

describe("body-site preposition grammar", () => {
  it.each([
    "wash at external genital area",
    "wash at the external genital area",
    "wash on external genitals",
    "wash over genital area",
    "wash in genital region",
    "wash external genitalia",
    "wash genitals"
  ])("treats neutral target marker in %s as the coded site itself", (source) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.site?.coding?.[0]).toMatchObject({
      system: SNOMED,
      code: EXTERNAL_GENITALIA,
      display: "Entire external genitalia"
    });
    expect(parsed.meta.canonical.clauses[0]?.site?.spatialRelation).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.route?.code).toBe("6064005");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it.each([
    ["wash around external genital area", "around"],
    ["wash outside external genitalia", "outside"],
    ["wash inside external genitalia", "inside"],
    ["wash within external genitalia", "inside"],
    ["wash underneath external genitalia", "under"],
    ["wash next to external genital area", "near"],
    ["wash adjacent to external genital area", "near"],
    ["wash surrounding external genital area", "around"]
  ] as const)("preserves spatial relation in %s", (source, relation) => {
    const parsed = parseSig(source);
    const spatial = parsed.meta.canonical.clauses[0]?.site?.spatialRelation;
    expect(spatial).toMatchObject({
      relationText: relation,
      targetCoding: {
        system: SNOMED,
        code: EXTERNAL_GENITALIA
      }
    });
    expect(parsed.longText.split(/\.\s*/u).filter(Boolean)).toHaveLength(1);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("codes vulva specifically rather than broadening it to all external genitalia", () => {
    for (const source of ["wash vulva", "wash vulvar area", "wash vulval region"]) {
      const parsed = parseSig(source);
      expect(parsed.fhir.site?.coding?.[0]).toMatchObject({
        system: SNOMED,
        code: VULVA,
        display: "Vulval structure"
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
  });

  it("supports multiword and adjectival spatial variants generically", () => {
    const next = parseSig("apply next to lesion");
    expect(next.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "near",
      targetCoding: { system: SNOMED, code: "95324001" }
    });

    const surrounding = parseSig("apply to area surrounding lesion");
    expect(surrounding.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "around",
      targetCoding: { system: SNOMED, code: "95324001" }
    });

    const along = parseSig("apply along lesion");
    expect(along.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "along",
      targetCoding: { system: SNOMED, code: "95324001" }
    });
    expect(next.meta.leftoverText).toBeUndefined();
    expect(surrounding.meta.leftoverText).toBeUndefined();
    expect(along.meta.leftoverText).toBeUndefined();
  });

  it.each([
    ["wash at external genital area", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash at the external genital area", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash on external genitals", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash over genital area", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash in genital region", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash external genitalia", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash genitals", "ล้างบริเวณอวัยวะเพศภายนอก."],
    ["wash around external genital area", "ล้างรอบบริเวณอวัยวะเพศภายนอก."],
    ["wash outside external genitalia", "ล้างด้านนอกบริเวณอวัยวะเพศภายนอก."],
    ["wash inside external genitalia", "ล้างในบริเวณอวัยวะเพศภายนอก."],
    ["wash within external genitalia", "ล้างในบริเวณอวัยวะเพศภายนอก."],
    ["wash underneath external genitalia", "ล้างใต้บริเวณอวัยวะเพศภายนอก."],
    ["wash next to external genital area", "ล้างใกล้บริเวณอวัยวะเพศภายนอก."],
    ["wash adjacent to external genital area", "ล้างใกล้บริเวณอวัยวะเพศภายนอก."],
    ["wash surrounding external genital area", "ล้างรอบบริเวณอวัยวะเพศภายนอก."],
    ["wash adjacent to vulva", "ล้างใกล้อวัยวะเพศหญิงภายนอก."],
    ["wash vulva", "ล้างบริเวณอวัยวะเพศหญิงภายนอก."],
    ["wash vulvar area", "ล้างบริเวณอวัยวะเพศหญิงภายนอก."],
    ["apply next to lesion", "ทาใกล้รอยโรค."],
    ["apply adjacent to lesion", "ทาใกล้รอยโรค."],
    ["apply surrounding lesion", "ทาบริเวณรอบรอยโรค."],
    ["apply to area adjacent to lesion", "ทาใกล้รอยโรค."],
    ["apply to area surrounding lesion", "ทาบริเวณรอบรอยโรค."],
    ["apply along lesion", "ทาตามแนวรอยโรค."],
    ["do not wash into vagina", "ห้ามล้างเข้าไปในช่องคลอด."]
  ] as const)("preserves pure Thai realization for %s", (source, expectedThai) => {
    const parsed = parseSig(source);
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(thai).toBe(expectedThai);
    expect(thai).not.toMatch(/[A-Za-z]/u);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("does not collapse directional into into a generic inside site relation", () => {
    const parsed = parseSig("do not wash into vagina");
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action).toMatchObject({
      predicate: { lemma: "wash" },
      polarity: "negate",
      relation: "into"
    });
    expect(action?.args).toContainEqual(expect.objectContaining({
      role: "site",
      coding: expect.objectContaining({ system: SNOMED, code: "76784001" })
    }));
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});
