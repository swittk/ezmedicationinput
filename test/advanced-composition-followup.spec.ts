import { describe, expect, it } from "vitest";
import {
  AdviceArgumentRole,
  AdviceRelation,
  EventTiming,
  formatSig,
  fromFhirDosage,
  parseSig
} from "../src/index";
import { resolveBodySitePhrase } from "../src/body-site-grammar";

const CASES = [
  [
    "1 drop to od q 30 min - 2h prn pain",
    "Instill 1 drop every 30 to 120 minutes as needed for pain in the right eye.",
    "หยอดตาขวา ครั้งละ 1 หยด ทุก 30 ถึง 120 นาที ใช้เมื่อปวด."
  ],
  [
    "apply to external genital area then wash off thoroughly",
    "Apply the medication to the external genitalia; then wash off thoroughly.",
    "ทาบริเวณอวัยวะเพศภายนอก จากนั้นล้างให้ทั่ว."
  ],
  [
    "apply to outside of vagina then wash off thoroughly",
    "Apply the medication outside the vagina; then wash off thoroughly.",
    "ทาบริเวณด้านนอกช่องคลอด จากนั้นล้างให้ทั่ว."
  ],
  [
    "insert under tongue then wait until dissolved",
    "Insert the medication under the tongue; then wait until dissolved.",
    "สอดที่ใต้ลิ้น จากนั้นรอจนกว่าละลายหมด."
  ],
  [
    "dissolve in water then drink, may cause vomiting",
    "Dissolve water; then drink the medication. May cause vomiting.",
    "ละลายน้ำ จากนั้นดื่ม. อาจทำให้เกิดอาเจียน."
  ],
  [
    "dissolve in water before drinking, may cause vomiting",
    "Dissolve water before drinking. May cause vomiting.",
    "ละลายน้ำก่อนดื่ม. อาจทำให้เกิดอาเจียน."
  ],
  [
    "apply to right armpit",
    "Apply the medication to the right armpit.",
    "ทาบริเวณรักแร้ด้านขวา."
  ],
  [
    "apply to left flank at lesion",
    "Apply the medication to the left flank at the lesion.",
    "ทาบริเวณสีข้างด้านซ้ายตรงรอยโรค."
  ],
  [
    "apply to below right knee where pain",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where painful",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where hurt",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below right knee where hurts",
    "Apply the medication below the right knee where painful.",
    "ทาบริเวณใต้เข่าขวาที่ปวด."
  ],
  [
    "apply to below left knee before sleep and when itchy",
    "Apply the medication at bedtime as needed for itch below the left knee.",
    "ทาบริเวณใต้เข่าซ้าย ก่อนนอน ใช้เมื่อคัน."
  ]
] as const;

describe("advanced compositional follow-up", () => {
  for (const [input, english, thai] of CASES) {
    it(`round-trips ${input}`, () => {
      const parsed = parseSig(input);
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(parsed.longText).toBe(english);
      expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
      expect(thai).not.toMatch(/[A-Za-z]/u);

      const dosage = JSON.parse(JSON.stringify(parsed.fhir));
      expect(fromFhirDosage(dosage, { locale: "th" }).longText).toBe(thai);
      expect(formatSig(dosage, "long", { locale: "th" })).toBe(thai);
    });
  }

  it("normalizes mixed-unit interval ranges instead of dropping the high bound", () => {
    const clause = parseSig("1 drop to od q 30 min - 2h prn pain").meta.canonical.clauses[0];
    expect(clause?.schedule).toMatchObject({ period: 30, periodMax: 120, periodUnit: "min" });
    expect(clause?.prn?.reasons?.[0]?.coding?.code).toBe("22253000");
  });

  it("keeps sequence markers outside body-site constituents", () => {
    const genital = parseSig("apply to external genital area then wash off thoroughly");
    expect(genital.fhir.site?.coding?.[0]?.code).toBe("362207005");
    expect(genital.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "rinse" },
      args: [expect.objectContaining({ role: AdviceArgumentRole.Manner, conceptId: "thoroughly" })]
    });

    const vaginal = parseSig("apply to outside of vagina then wash off thoroughly");
    expect(vaginal.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "outside",
      targetCoding: { code: "76784001" }
    });
  });

  it("models result-state and procedural activity relations explicitly", () => {
    const wait = parseSig("insert under tongue then wait until dissolved");
    expect(wait.meta.canonical.clauses[0]?.site?.spatialRelation).toMatchObject({
      relationText: "under",
      targetCoding: { code: "21974007" }
    });
    expect(wait.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "wait" },
      relation: AdviceRelation.Until,
      args: [expect.objectContaining({ role: AdviceArgumentRole.Result, conceptId: "dissolved" })]
    });

    const before = parseSig("dissolve in water before drinking, may cause vomiting");
    const graph = before.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["dissolve"]);
    expect(graph?.actions[0]).toMatchObject({
      relation: AdviceRelation.Before,
      args: expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }),
        expect.objectContaining({ role: AdviceArgumentRole.Activity, text: "drinking" })
      ])
    });
    expect(before.fhir.additionalInstruction?.[0]?.coding?.[0]?.code).toBeUndefined();
    expect(before.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.frames?.[0]?.args?.[0]?.coding?.code)
      .toBe("422400008");
  });

  it("composes laterality and typed site qualifiers over coded anatomy", () => {
    const armpit = parseSig("apply to right armpit").meta.canonical.clauses[0]?.site;
    expect(armpit?.spatialRelation).toMatchObject({
      relationText: "right side",
      relationCoding: { code: "49370004" },
      targetCoding: { code: "34797008" }
    });

    const flank = resolveBodySitePhrase("left flank at lesion");
    expect(flank?.features.qualifier).toMatchObject({
      kind: "site", relation: "at", targetCoding: { code: "95324001" }
    });
    const painful = resolveBodySitePhrase("below right knee where hurts");
    expect(painful?.features.qualifier).toMatchObject({
      kind: "symptom", relation: "where", coding: { code: "22253000" }
    });
  });

  it("preserves independent regimen timing and site-qualified PRN", () => {
    const parsed = parseSig("apply to below left knee before sleep and when itchy");
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause?.schedule?.when).toEqual([EventTiming["Before Sleep"]]);
    expect(clause?.site?.spatialRelation?.targetCoding?.code).toBe("82169009");
    expect(clause?.prn?.reasons?.[0]?.coding?.code).toContain("418363000:363698007=82169009");
  });
});
