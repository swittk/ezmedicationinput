import { describe, expect, it } from "vitest";
import { formatSig, parseSig } from "../src/index";
import { FhirDayOfWeek, FhirPeriodUnit, type FhirDosage } from "../src/types";

const SNOMED = "http://snomed.info/sct";
const LOCAL_ACTION = "https://solublelabs.com/fhir/CodeSystem/medication-instruction-action";

describe("Thai formatter human-review follow-up", () => {
  it("keeps mixed WHEN + negated IF safety scope out of PRN", () => {
    const parsed = parseSig("เมื่อนอนไม่หลับ ไม่ควรรับประทานหากมีอาการป่วย", { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(parsed.fhir.asNeededBoolean).not.toBe(true);
    expect(graph?.actions[0]).toMatchObject({ predicate: { lemma: "take" }, polarity: "negate", modality: "should" });
    expect(graph?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "when", text: "เมื่อนอนไม่หลับ" }),
      expect.objectContaining({ kind: "if", text: "หากมีอาการป่วย" })
    ]));
    expect(graph?.coverage).toMatchObject({ complete: true, ratio: 1, opaqueCharacters: 0 });
  });

  it.each([
    ["ควรรับประทานหลังอาหาร", "ควรรับประทานหลังอาหาร."],
    ["ต้องรับประทานหลังอาหาร", "ต้องรับประทานหลังอาหาร."]
  ])("omits a synthetic generic ยา for bare oral %s", (source, expected) => {
    const parsed = parseSig(source, { locale: "th" });
    expect(parsed.longText).toBe(expected);
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("supports weekly frequency together with วัน-prefixed weekday anchors", () => {
    const once = parseSig("รับประทาน 1 เม็ด สัปดาห์ละ 1 ครั้ง วันอังคาร", { locale: "th" });
    expect(once.longText).toBe("รับประทานครั้งละ 1 เม็ด สัปดาห์ละ 1 ครั้ง ในวันอังคาร.");
    expect(once.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "wk", dayOfWeek: ["tue"] });
    expect(once.meta.leftoverText).toBeUndefined();

    const twice = parseSig("รับประทาน 1 เม็ด สัปดาห์ละ 2 ครั้ง วันอังคาร และ วันพฤหัสบดี", { locale: "th" });
    expect(twice.longText).toBe("รับประทานครั้งละ 1 เม็ด สัปดาห์ละ 2 ครั้ง ในวันอังคาร และ วันพฤหัสบดี.");
    expect(twice.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "wk", dayOfWeek: ["tue", "thu"] });
    expect(twice.meta.leftoverText).toBeUndefined();
  });

  it("uses natural Thai eye-site placement by default and exposes legacy trailing placement", () => {
    const parsed = parseSig("หยอดตาทั้งสองข้าง 1 หยด วันละ 2 ครั้ง เช้าเย็น", { locale: "th" });
    expect(parsed.longText).toBe("หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละ 2 ครั้ง ตอนเช้า และ ตอนเย็น.");
    expect(formatSig(parsed.fhir, "long", { locale: "th", sitePlacement: "trailing" }))
      .toBe("หยอดครั้งละ 1 หยด วันละ 2 ครั้ง ตอนเช้า และ ตอนเย็น ที่ตาทั้งสองข้าง.");
  });

  it("preserves sequence across canonical eye administration and accepts an optional close-eye duration", () => {
    const noDuration = parseSig("ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา", { locale: "th" });
    expect(noDuration.longText).toBe("ล้างมือก่อนหยอดตา จากนั้นหยอดตาขวา ครั้งละ 1 หยด จากนั้นหลับตา.");
    const timed = parseSig("หยอดตาขวา 1 หยด แล้วหลับตา 1 นาที", { locale: "th" });
    expect(timed.longText).toBe("หยอดตาขวา ครั้งละ 1 หยด จากนั้นหลับตา 1 นาที.");
    expect(timed.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.args)
      .toContainEqual(expect.objectContaining({ role: "duration", quantity: { value: 1, unit: "min" } }));
  });

  it("keeps inhaler and shampoo procedural sequence explicit in normalized Thai", () => {
    expect(parseSig("เขย่ายาพ่น สูด 1 พัฟ แล้วกลั้นหายใจ 10 วินาที", { locale: "th" }).longText)
      .toBe("เขย่ายาสูดพ่น จากนั้นสูดครั้งละ 1 พัฟ จากนั้นกลั้นหายใจ 10 วินาที.");
    expect(parseSig("สระผม ทิ้งไว้ 5 นาที แล้วล้างออก", { locale: "th" }).longText)
      .toBe("สระผม จากนั้นทิ้งไว้ 5 นาที จากนั้นล้างออก.");
  });

  it("treats ล้าง...ให้สะอาด as one resultative rinse action", () => {
    const parsed = parseSig("เช็ดรอยโรคแล้วรอ 5 นาทีแล้วล้างด้วยน้ำให้สะอาด", { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(parsed.longText).toBe("เช็ดรอยโรค จากนั้นรอ 5 นาที จากนั้นล้างด้วยน้ำให้สะอาด.");
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["wipe", "wait", "rinse"]);
    expect(graph?.actions[2]?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "substance", conceptId: "water" }),
      expect.objectContaining({ role: "result", conceptId: "clean-result" })
    ]));
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("does not mis-promote a secondary relative delay into the primary Dosage schedule", () => {
    const parsed = parseSig("ทาน 2 เม็ด หลังจากนั้นทานอีก 1 เม็ดหลังครั้งแรกอย่างน้อย 1 สัปดาห์", { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause?.dose).toEqual({ value: 2, unit: "tab" });
    expect(clause?.schedule?.duration).toBeUndefined();
    const secondary = clause?.instructionGraph?.actions.find((action) => action.predicate.lemma === "take");
    expect(secondary?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "amount", quantity: { value: 1, unit: "tab" } }),
      expect.objectContaining({ role: "time", conceptId: "after-first-administration" })
    ]));
    expect(parsed.longText).toBe("รับประทานครั้งละ 2 เม็ด จากนั้นทานอีก 1 เม็ดหลังครั้งแรกอย่างน้อย 1 สัปดาห์.");
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("supports total count together with concrete event timings", () => {
    const parsed = parseSig("รับประทาน 1 เม็ด วันละ 2 ครั้ง เช้าเย็น จำนวน 10 ครั้ง", { locale: "th" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d", count: 10 });
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["MORN", "EVE"]);
    expect(parsed.longText).toBe("รับประทานครั้งละ 1 เม็ด วันละ 2 ครั้ง ตอนเช้า และ ตอนเย็น จำนวน 10 ครั้ง.");
  });

  it("keeps patch-cut prohibition internally typed without inventing an external SNOMED mapping", () => {
    const parsed = parseSig("ห้ามตัดแผ่นแปะ", { locale: "th" });
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action).toMatchObject({ predicate: { lemma: "cut" }, polarity: "negate" });
    expect(action?.predicate.codings).toEqual([
      expect.objectContaining({ system: LOCAL_ACTION, code: "cut" })
    ]);
    expect(action?.predicate.codings?.some((coding) => coding.system === SNOMED)).toBe(false);
    expect(parsed.fhir.additionalInstruction).toEqual([{ text: "ห้ามตัดแผ่นแปะ" }]);
  });

  it("parses external genital wash with an internal-vaginal prohibition as typed site semantics", () => {
    const parsed = parseSig(
      "ใช้ล้างภายนอกบริเวณอวัยวะเพศ ห้ามล้างเข้าไปภายในบริเวณช่องคลอด",
      { locale: "th" }
    );
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    const warning = graph?.actions.find((action) => action.polarity === "negate");
    expect(parsed.fhir.route?.coding?.[0]).toMatchObject({ system: SNOMED, code: "6064005", display: "Topical route" });
    expect(parsed.fhir.site?.coding?.[0]).toMatchObject({ system: SNOMED, code: "362207005", display: "Entire external genitalia" });
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({ system: SNOMED, code: "785900008", display: "Rinse or wash" });
    expect(warning).toMatchObject({
      predicate: { lemma: "wash" },
      polarity: "negate",
      relation: "into"
    });
    expect(warning?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "site",
        conceptId: "vagina",
        coding: expect.objectContaining({ system: SNOMED, code: "76784001", display: "Vagina" })
      })
    ]));
    expect(graph?.coverage).toMatchObject({ complete: true, ratio: 1, opaqueCharacters: 0 });
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.longText).toBe("ล้างบริเวณอวัยวะเพศภายนอก. ห้ามล้างเข้าไปภายในบริเวณช่องคลอด.");
    expect(formatSig(parsed.fhir, "long", { locale: "en" }))
      .toBe("Wash the external genitalia. Do not wash into the vagina.");
  });

  it("formats a code-only external genitalia site in Thai from the site definition", () => {
    const parsed = parseSig("ใช้ล้างภายนอกบริเวณอวัยวะเพศ", { locale: "th" });
    const codeOnlySite = {
      ...parsed.fhir,
      site: {
        coding: [{ system: SNOMED, code: "362207005", display: "Entire external genitalia" }]
      }
    };
    const formatted = formatSig(codeOnlySite, "long", { locale: "th" });
    expect(formatted).toContain("บริเวณอวัยวะเพศภายนอก");
    expect(formatted).not.toContain("Entire external genitalia");
  });

  it("prefers coded Thai body-site translations over name fallbacks", () => {
    const dosage: FhirDosage = {
      route: { coding: [{ system: SNOMED, code: "6064005", display: "Topical route" }] },
      site: {
        text: "rectum",
        coding: [{ system: SNOMED, code: "34402009", display: "Rectum" }]
      }
    };
    expect(formatSig(dosage, "long", { locale: "th" })).toBe("ทาบริเวณทวารหนัก.");
  });

  it("preserves weekly frequency ranges when weekday anchors are present", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: SNOMED, code: "26643006", display: "Oral route" }] },
      timing: {
        repeat: {
          frequency: 1,
          frequencyMax: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Week,
          dayOfWeek: [FhirDayOfWeek.Tuesday]
        }
      }
    };
    expect(formatSig(dosage, "long", { locale: "th" }))
      .toBe("รับประทานครั้งละ 1 เม็ด สัปดาห์ละ 1 ถึง 2 ครั้ง ในวันอังคาร.");
  });

  it("preserves weekly frequency ranges without weekday anchors", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: SNOMED, code: "26643006", display: "Oral route" }] },
      timing: {
        repeat: {
          frequency: 1,
          frequencyMax: 2,
          period: 1,
          periodUnit: FhirPeriodUnit.Week
        }
      }
    };
    expect(formatSig(dosage, "long", { locale: "th" }))
      .toBe("รับประทานครั้งละ 1 เม็ด สัปดาห์ละ 1 ถึง 2 ครั้ง.");
  });

  it("preserves Thai PRN source wording even when an exact coding is present", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: SNOMED, code: "26643006", display: "Oral route" }] },
      asNeededBoolean: true,
      asNeededFor: [{
        text: "ไข้สูง",
        coding: [{ system: SNOMED, code: "386661006", display: "Fever" }]
      }]
    };
    expect(formatSig(dosage, "long", { locale: "th" }))
      .toBe("รับประทานครั้งละ 1 เม็ด ใช้เมื่อไข้สูง.");
  });

  it("places intravitreal eye sites early like the other early-site routes", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 0.05, unit: "mL" } }],
      route: {
        coding: [{
          system: SNOMED,
          code: "418401004",
          display: "Intravitreal route (qualifier value)"
        }]
      },
      site: {
        text: "right eye",
        coding: [{ system: SNOMED, code: "1290032005", display: "Structure of right eye proper" }]
      }
    };
    expect(formatSig(dosage, "long", { locale: "th" }))
      .toBe("ฉีดตาขวา ครั้งละ 0.05 มิลลิลิตร.");
  });

  it("does not let a standalone instruction graph hide administration timing or duration", () => {
    const warning = parseSig("do not take with food").fhir;
    const withTimingCode: FhirDosage = {
      ...warning,
      timing: { code: { coding: [{ code: "BID" }], text: "BID" } }
    };
    expect(formatSig(withTimingCode, "long", { locale: "th" }))
      .toBe("ใช้ยา วันละ 2 ครั้ง. ห้ามรับประทานพร้อมอาหาร.");

    const withDuration: FhirDosage = {
      ...warning,
      timing: {
        repeat: {
          boundsDuration: {
            value: 5,
            unit: "days",
            system: "http://unitsofmeasure.org",
            code: "d"
          }
        }
      }
    };
    expect(formatSig(withDuration, "long", { locale: "th" }))
      .toBe("ใช้ยา เป็นเวลา 5 วัน. ห้ามรับประทานพร้อมอาหาร.");
  });

  it("maps Implant to exact SNOMED method and subcutaneous route codes", () => {
    const parsed = parseSig("ฝัง 1 implant ใต้ผิวหนัง", { locale: "th" });
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({ system: SNOMED, code: "827107003", display: "Implant" });
    expect(parsed.fhir.route?.coding?.[0]).toMatchObject({ system: SNOMED, code: "34206005", display: "Subcutaneous route" });
  });
});
