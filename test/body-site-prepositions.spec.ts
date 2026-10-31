import { describe, expect, it } from "vitest";
import { formatSig, toDosageDetails, toFhirR5Dosages } from "../src";
import { parseSig } from "./helpers/r5-parser";

const SNOMED = "http://snomed.info/sct";
const EXTERNAL_GENITALIA = "362207005";
const VULVA = "45292006";

describe("body-site preposition grammar", () => {
  it.each([
    "Apply where it hurts BID",
    "Apply to where it hurts BID"
  ])("resolves an exact registered relative site alias without inventing anatomy: %s", source => {
    const result = parseSig(source);
    const clause = result.meta.canonical.clauses[0];
    expect(clause.site?.text).toBe("affected area");
    expect(clause.site?.coding).toBeUndefined();
    expect(result.items[0]?.fhir.site?.text).toBe("affected area");
    expect(result.items[0]?.fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d"
    });
    expect(result.meta.leftoverText).toBeUndefined();
  });

  it("does not treat unregistered relative phrases as anatomical sites", () => {
    expect(parseSig("Apply where you live BID").meta.canonical.clauses[0]?.site).toBeUndefined();
    const qualified = parseSig("Apply to skin where it hurts BID").meta.canonical.clauses[0]?.site;
    expect(qualified?.coding?.code).toBe("181469002");
    expect(qualified?.restrictions?.[0]?.sourceText).toBe("where it hurts");
  });

  it("keeps untranslated site restrictions visible in Thai after FHIR round trips", () => {
    const source = "apply 1 mL to skin where tender";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0]?.site?.restrictions?.[0])
      .toMatchObject({ sourceText: "where tender", predicate: { form: "raw", text: "tender" } });
    for (const dosage of [
      parsed.fhir,
      toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0]
    ]) {
      const thai = formatSig(dosage, "long", { locale: "th" });
      expect(thai).toContain("where tender");
      expect(thai).toContain("ผิวหนัง");
      expect(thai).toContain("1");
    }
    expect(formatSig(parsed.fhir, "long")).toContain("where tender");
  });

  it.each([
    [
      "apply 1 mL at 08:00 to arm where irritated",
      "302538001",
      "irritated",
      "state",
      undefined,
      "08:00:00"
    ],
    [
      "apply 1 mL to skin where there is redness at 20:00",
      "181469002",
      "there is redness",
      "existential",
      "redness",
      "20:00:00"
    ]
  ] as const)(
    "keeps leading or trailing timing outside a site restriction in %s",
    (source, siteCode, predicateText, form, focusText, timeOfDay) => {
      const parsed = parseSig(source);
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause?.site?.coding?.code).toBe(siteCode);
      expect(clause?.site?.restrictions).toMatchObject([{
        relation: "where",
        predicate: {
          text: predicateText,
          form,
          focusText
        }
      }]);
      expect(clause?.schedule?.timeOfDay).toEqual([timeOfDay]);
      expect(clause?.schedule?.frequency).toBeUndefined();
      expect(clause?.prn).toBeUndefined();
      expect(clause?.clinicalAdjuncts).toBeUndefined();
      expect(parsed.fhir.timing?.repeat?.timeOfDay).toEqual([timeOfDay]);
      expect(parsed.fhir.timing?.repeat?.frequency).toBeUndefined();
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.longText).not.toMatch(/\bat\s*\.$/iu);
    }
  );

  it("retains an unknown predicate as typed raw content on a custom coded site", () => {
    const parsed = parseSig("apply 1 mL to treatment zone where tender", {
      siteCodeMap: {
        "treatment zone": {
          text: "treatment zone",
          coding: {
            system: "urn:test:body-site",
            code: "zone-1",
            display: "Treatment zone"
          }
        }
      }
    });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause?.site).toMatchObject({
      text: "treatment zone",
      coding: { system: "urn:test:body-site", code: "zone-1" },
      restrictions: [{
        relation: "where",
        sourceText: "where tender",
        predicate: { text: "tender", form: "raw" }
      }]
    });
    expect(clause?.schedule).toBeUndefined();
    expect(clause?.prn).toBeUndefined();
    expect(clause?.clinicalAdjuncts).toBeUndefined();
    expect(parsed.fhir.site?.coding?.[0]).toMatchObject({
      system: "urn:test:body-site",
      code: "zone-1"
    });
    expect(parsed.longText.toLowerCase()).toContain("where tender");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

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
