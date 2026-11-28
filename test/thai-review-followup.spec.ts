import { getCourseCycleCount, setCourseCycleCount } from "../src/dosage-course";
import { toDosageDetails, toFhirR5Dosages, parseSig as reviewParseSig, parseSig as parsePublicSig, parseInstructionActions, importCanonicalCourse, projectCanonicalCourse, type CanonicalCourse, type FhirExtension, type FhirR6DosageInstruction, buildInstructionGraphExtension, parseInstructionGraphExtension, AdviceForce, AdviceArgumentRole, AdviceRelation, type CanonicalInstructionGraph } from "../src/index";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { getPrimitiveTranslation, buildTranslationPrimitiveElement } from "../src/fhir-translations";
import { type ParseOptions } from "../src/types";
import { describe, expect, it } from "vitest";
import { formatSig } from "../src/index";
import { getPrimitiveTranslations } from "../src/fhir-translations";
import { parseSig } from "./helpers/r5-parser";
import { FhirDayOfWeek, FhirPeriodUnit, type FhirDosage } from "../src/types";

const SNOMED = "http://snomed.info/sct";

describe("Thai formatter human-review follow-up", () => {
  it("keeps mixed WHEN + negated IF safety scope out of PRN", () => {
    const parsed = parseSig("เมื่อนอนไม่หลับ ไม่ควรรับประทานหากมีอาการป่วย", { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(parsed.fhir.asNeeded).not.toBe(true);
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

  it("keeps patch-cut prohibition negated with its standard action coding", () => {
    const parsed = parseSig("ห้ามตัดแผ่นแปะ", { locale: "th" });
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action).toMatchObject({ predicate: { lemma: "cut" }, polarity: "negate" });
    expect(action?.predicate.codings).toEqual([
      expect.objectContaining({ system: SNOMED, code: "360314001" })
    ]);
    expect(action?.predicate.codings?.some((coding) => coding.system?.startsWith("urn:ezmedicationinput:"))).toBe(false);
    expect(parsed.fhir.additionalInstruction).toHaveLength(1);
    const instruction = parsed.fhir.additionalInstruction![0];
    expect(instruction.text).toBe("ห้ามตัดแผ่นแปะ");
    expect(instruction.coding).toBeUndefined();
    expect(getPrimitiveTranslations(instruction._text)).toEqual({
      en: "Do not cut patch", th: "ห้ามตัดแผ่นแปะ"
    });
    expect(parsed.longText).toBe("ห้ามตัดแผ่นแปะ.");
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

  it("applies explicit spatial relations to curated base-site translations", () => {
    const parsed = parseSig("apply to right side of abdomen bid");
    const dosage: FhirDosage = {
      ...parsed.fhir,
      site: {
        ...parsed.fhir.site,
        text: "abdomen"
      }
    };
    expect(formatSig(dosage, "long", { locale: "th" }))
      .toBe("ทาบริเวณท้องด้านขวา วันละ 2 ครั้ง.");
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
      asNeeded: true,
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

// Preserved public-contract regressions in their subject suite.
{
const parseSig = reviewParseSig;


const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));


// Retained boundary and strict-type suite from test/pr14-round21-boundaries.spec.ts.
{

describe("round34 qualified Thai fractions", () => {
  it.each([
    ["≤๑ / ๒ เม็ด วันละครั้ง", "<="],
    ["≥๑ / ๒ เม็ด วันละครั้ง", ">="],
    [">=๑ / ๒ เม็ด วันละครั้ง", ">="],
    ["~๑ / ๒ เม็ด วันละครั้ง", "~"],
    ["≤๑/๒เม็ด วันละครั้ง", "<="],
  ] as const)("preserves the half tablet and qualifier in %s", (source, comparator) => {
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 0.5, unit: "tab", comparator });
    for (const wire of [parsed.fhir, parsed.fhirNext]) {
      const native = importCanonicalCourse(wire);
      expect(native.stages).toHaveLength(1);
      expect(native.stages[0].administrations).toHaveLength(1);
      expect(native.stages[0].administrations[0].amounts![0].quantity).toMatchObject({ value: 0.5, comparator });
    }
    expect(getQuantityComparator(parsed.fhir[0].doseAndRate![0].doseQuantity)).toBe(comparator);
    expect(getQuantityComparator(parsed.fhirNext.step![0].component[0].doseAndRate![0].doseQuantity)).toBe(comparator);
  });
});

// END PRESERVED round39_boundaries
}


describe("round78 scoped additional-instruction translations", () => {
  it.each([
    { source: "If skin irritation occurs, do not apply the patch",
      en: "If skin irritation occurs, do not apply patch", th: "If skin irritation occurs ห้ามแปะแผ่นแปะ" },
    { source: "Do not apply the patch if skin irritation occurs",
      en: "Do not apply patch if skin irritation occurs", th: "ห้ามแปะแผ่นแปะ if skin irritation occurs" },
    { source: "หากมีอาการระคายเคือง ห้ามตัดแผ่นแปะ",
      en: "หากมีอาการระคายเคือง, do not cut patch", th: "หากมีอาการระคายเคือง ห้ามตัดแผ่นแปะ" }
  ])("keeps the complete condition and negation: $source", fixture => {
    const parsed = parsePublicSig(fixture.source, { locale: "th" });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.relations).toContainEqual(expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: 0 }));
    expect(graph.actions[0].polarity).toBe("negate");
    for (const instruction of [parsed.fhir[0].additionalInstruction![0], parsed.fhirNext.step![0].component[0].additionalInstruction![0],
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction![0]]) {
      expect(instruction.text).toBe(fixture.source);
      expect(instruction.coding).toBeUndefined();
      for (const locale of ["en", "th"] as const)
        expect(getPrimitiveTranslation(instruction._text, locale)).toBe(fixture[locale]);
    }
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)])
      expect(importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!.sourceText).toBe(fixture.source);
  });

  it("keeps a second warning independent from the first warning's condition", () => {
    const parsed = parsePublicSig("If skin irritation occurs, do not apply the patch; do not lie down immediately", { locale: "th" });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.relations).toEqual([expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: 0 })]);
    for (const instructions of [parsed.fhir[0].additionalInstruction!, parsed.fhirNext.step![0].component[0].additionalInstruction!,
      toFhirR5Dosages(persist(parsed.fhirNext))[0].additionalInstruction!]) {
      expect(instructions).toHaveLength(2);
      expect(getPrimitiveTranslation(instructions[0]._text, "en")).toBe("If skin irritation occurs, do not apply patch");
      expect(getPrimitiveTranslation(instructions[0]._text, "th")).toBe("If skin irritation occurs ห้ามแปะแผ่นแปะ");
      expect(instructions[1].text).toBe("do not lie down immediately");
      expect(getPrimitiveTranslation(instructions[1]._text, "en")).toBe("Do not lie down immediately");
      expect(getPrimitiveTranslation(instructions[1]._text, "th")).toBe("ห้ามนอนราบทันที");
    }
  });
});


describe("round78 saved action and cycle locale ownership", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  it.each([AdviceRelation.On, AdviceRelation.Before, undefined])("realizes the saved patch Time with its relation %s", relation => {
    const frame = parseInstructionActions("Apply patch in the morning")[0];
    const clocked = relation !== undefined;
    const sourceText = relation === AdviceRelation.On ? "Apply patch at 08:00" : relation === AdviceRelation.Before
      ? "Apply patch before 08:00" : "Apply patch in the morning";
    const graph: CanonicalInstructionGraph = { sourceText,
      sourceLocale: "en", actions: [{ ...frame, sourceText, span: { start: 0, end: sourceText.length }, relation, args: [{
        role: AdviceArgumentRole.Time, text: clocked ? "08:00" : "morning", normalized: clocked ? "08:00" : "MORN",
        ...(clocked ? { relation } : { i18n: { en: "the morning", th: "ตอนเช้า" } })
      }] }] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    const r6 = toDosageDetails([persist(row)]);
    for (const input of [[row], persist(r6), persist(toFhirR5Dosages(r6))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "Apply patch at 08:00." : relation === AdviceRelation.Before
          ? "Apply patch before 08:00." : "Apply patch in the morning.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "แปะ เวลา 08:00." : relation === AdviceRelation.Before
          ? "แปะก่อน08:00." : "แปะตอนเช้า.");
      expect(parseInstructionGraphExtension(toFhirR5Dosages(input)[0].extension)?.actions[0].args[0])
        .toMatchObject({ role: AdviceArgumentRole.Time, text: clocked ? "08:00" : "morning" });
    }
  });

  it.each([AdviceRelation.On, AdviceRelation.Before, undefined])("retains the typed patch object with saved Time relation %s", relation => {
    const frame = parseInstructionActions("Apply the patch in the morning")[0];
    const object = frame.args.find(argument => argument.role === AdviceArgumentRole.Object)!;
    expect(object).toMatchObject({ normalized: "patch", i18n: { en: "patch", th: "แผ่นแปะ" } });
    const clocked = relation !== undefined;
    const sourceText = relation === AdviceRelation.On ? "Apply the patch at 08:00" : relation === AdviceRelation.Before
      ? "Apply the patch before 08:00" : "Apply the patch in the morning";
    const graph: CanonicalInstructionGraph = { sourceText, sourceLocale: "en", actions: [{
      ...frame, sourceText, span: { start: 0, end: sourceText.length }, relation,
      args: [object, { role: AdviceArgumentRole.Time, text: clocked ? "08:00" : "morning",
        normalized: clocked ? "08:00" : "MORN",
        ...(clocked ? { relation } : { i18n: { en: "the morning", th: "ตอนเช้า" } }) }]
    }] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    const r6 = toDosageDetails([persist(row)]);
    for (const input of [[row], persist(r6), persist(toFhirR5Dosages(r6))]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "Apply patch at 08:00." : relation === AdviceRelation.Before
          ? "Apply patch before 08:00." : "Apply patch in the morning.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe(relation === AdviceRelation.On ? "แปะแผ่นแปะ เวลา 08:00." : relation === AdviceRelation.Before
          ? "แปะแผ่นแปะก่อน08:00." : "แปะแผ่นแปะตอนเช้า.");
      const args = parseInstructionGraphExtension(toFhirR5Dosages(input)[0].extension)?.actions[0].args;
      expect(args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Object,
        normalized: "patch", i18n: { en: "patch", th: "แผ่นแปะ" } }));
      expect(args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time,
        text: clocked ? "08:00" : "morning" }));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("matches an imported method to the configured primary action Coding", () => {
    const coding = { system: "urn:clinic:action", code: "coat-lightly", id: "authored-action",
      extension: [{ url: "urn:clinic:note", valueString: "retain" }] };
    const options: ParseOptions = { instructionActionMap: { "coat lightly": {
      code: "coat-lightly", display: "Coat lightly", semanticClass: "administration", coding,
      administrationMethod: { system: "urn:clinic:method", code: "coat" }, i18n: { en: "Coat lightly", th: "ทาบาง ๆ" }
    } } };
    const row: FhirDosage = { method: { coding: [coding] }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }] };
    const r6 = toDosageDetails([persist(row)]);
    for (const input of [[row], persist(r6), persist(toFhirR5Dosages(r6))]) {
      expect(formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" })).toBe("Coat lightly 1 g.");
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" })).toBe("ทาบาง ๆครั้งละ 1 g.");
      expect(toFhirR5Dosages(input)[0].method?.coding).toEqual([coding]);
    }
  });

  it.each([1, 2, undefined])("states the complete course count without an extra repetition: %s", count => {
    const course: FhirR6DosageInstruction = { repeatCycle: { value: 28, unit: "d", code: "d" },
      step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, boundsDuration: { value: 7, unit: "d" } } } }] }] };
    if (count !== undefined) setCourseCycleCount(course, count);
    for (const input of [course, persist(toFhirR5Dosages(course))]) {
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      if (count === 1) {
        expect(th).toContain("ใช้แผนการใช้ยานี้รวม 1 รอบ (ระยะรอบการใช้ยา: 28 วัน).");
        expect(th).not.toContain("ทำซ้ำ");
        expect(th).not.toContain("ทุก 28 วัน");
      } else {
        expect(th).toContain("ทำซ้ำแผนการใช้ยานี้ทุก 28 วัน");
        expect(th.includes("จำนวน 2 รอบ")).toBe(count === 2);
      }
      expect(getCourseCycleCount(Array.isArray(input) ? toDosageDetails(input) : input)).toBe(count);
    }
  });
});

describe("independent graph locale annotations", () => {
  it.each([false, true])("retains metadata on a direct-dose locale value of %s", directDose => {
    const locale: FhirExtension = { id: "locale-profile", url: "predicateRealizerLocale", extension: [
      { url: "locale", valueCode: "th" },
      { id: "direct-dose-setting", url: "directDose", valueBoolean: directDose },
      { url: "routePhrase", id: "oral-phrase", extension: [
        { id: "oral-code", url: "route", valueCode: "PO" },
        { id: "oral-text", url: "text", valueString: "ทางปาก" },
      ] },
      { url: "urn:clinic:profile-note", valueString: "retain" },
    ] };
    const input: FhirExtension = { url: "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
      extension: [{ url: "action", extension: [
        { url: "predicateLemma", valueString: "chew" },
        { url: "sourceText", valueString: "Chew 1 tablet" },
        { url: "force", valueCode: AdviceForce.Sequence },
        { url: "spanStart", valueInteger: 0 }, { url: "spanEnd", valueInteger: 13 }, locale,
      ] }]
    };
    const before = persist(input), graph = parseInstructionGraphExtension([input])!;
    expect(graph.actions[0].predicate.realizerConfig?.locales?.th.directDose).toBe(directDose);
    expect(graph.actions[0].predicate.realizerConfig?.locales?.th.routePhrases).toEqual({ PO: "ทางปาก" });
    const rebuilt = buildInstructionGraphExtension(graph)!;
    const action = rebuilt.extension!.find(item => item.url === "action")!;
    expect(action.extension!.filter(item => item.url === "predicateRealizerLocale")).toEqual([locale]);
    expect(input).toEqual(before);
  });
});
}


describe("review814 quantified patch wording across conditional orders", () => {
  it.each([
    { source: "If skin irritation occurs, do not apply more than 1 patch before 08:00",
      value: 1, comparator: ">" as const, relation: AdviceRelation.Before, condition: "If skin irritation occurs,",
      thai: "If skin irritation occursห้ามแปะ มากกว่า 1 patchก่อน08:00:00." },
    { source: "Do not apply more than 1 patch before 08:00 if skin irritation occurs",
      value: 1, comparator: ">" as const, relation: AdviceRelation.Before, condition: "if skin irritation occurs",
      thai: "ห้ามแปะ มากกว่า 1 patchก่อน08:00:00 if skin irritation occurs." },
    { source: "If dizzy, do not apply 2 patches at 08:00",
      value: 2, comparator: undefined, relation: AdviceRelation.On, condition: "If dizzy,",
      thai: "ถ้าเวียนศีรษะห้ามแปะ 2 patch เวลา 08:00:00." },
    { source: "Do not apply 2 patches at 08:00 if dizzy",
      value: 2, comparator: undefined, relation: AdviceRelation.On, condition: "if dizzy",
      thai: "ห้ามแปะ 2 patch เวลา 08:00:00ถ้าเวียนศีรษะ." }
  ])("keeps the selected patch amount, clock and condition in $source", fixture => {
    const parsed = parsePublicSig(fixture.source), before = JSON.stringify(parsed);
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const inputBefore = JSON.stringify(input);
      const graph = importCanonicalCourse(input).stages[0].administrations[0].syntax!.instructionGraph!;
      expect(graph.actions).toHaveLength(1);
      expect(graph.actions[0]).toMatchObject({ predicate: { lemma: "apply" }, polarity: "negate" });
      expect(graph.actions[0].args.some(argument => argument.role === AdviceArgumentRole.Object)).toBe(false);
      expect(graph.actions[0].args.find(argument => argument.role === AdviceArgumentRole.Amount)?.quantity)
        .toEqual({ value: fixture.value, unit: "patch", ...(fixture.comparator ? { comparator: fixture.comparator } : {}) });
      expect(graph.actions[0].args.find(argument => argument.role === AdviceArgumentRole.Time))
        .toMatchObject({ normalized: "08:00:00", relation: fixture.relation });
      expect(graph.relations).toEqual([expect.objectContaining({ kind: AdviceRelation.If, toActionIndex: 0, text: fixture.condition })]);
      expect(graph.sourceText).toBe(fixture.source);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(fixture.source + ".");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(fixture.thai);
      expect(JSON.stringify(input)).toBe(inputBefore);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(fixture.source);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("current coded patch Apply wording", () => {
  const edqm = "http://standardterms.edqm.eu";
  const currentViews = (row: FhirDosage): Array<CanonicalCourse | FhirDosage[] | FhirR6DosageInstruction> => {
    const native = importCanonicalCourse([row]);
    const projected = projectCanonicalCourse(native);
    return [native, JSON.parse(JSON.stringify(projected.fhir)), JSON.parse(JSON.stringify(projected.fhirNext))];
  };

  it.each([
    { name: "code-only patch", quantity: { value: 1, system: edqm, code: "15036000" },
      english: "Apply 1 patch once daily.", thai: "แปะครั้งละ 1 แผ่นแปะ วันละครั้ง." },
    { name: "displayed patch", quantity: { value: 1, unit: "patch", system: edqm, code: "15036000" },
      english: "Apply 1 patch once daily.", thai: "แปะครั้งละ 1 แผ่นแปะ วันละครั้ง." },
    { name: "code-only volume", quantity: { value: 1, system: "http://unitsofmeasure.org", code: "mL" },
      english: "Apply 1 mL once daily.", thai: "ทาครั้งละ 1 มิลลิลิตร วันละครั้ง." }
  ])("uses the typed $name without changing its quantity or cadence", fixture => {
    const row: FhirDosage = { method: { text: "Apply" },
      doseAndRate: [{ doseQuantity: fixture.quantity }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const original = structuredClone(row);
    for (const input of currentViews(row)) {
      const before = structuredClone(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(fixture.english);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(fixture.thai);
      const current = importCanonicalCourse(input).stages[0].administrations[0];
      expect(current.amounts?.[0].quantity).toEqual(fixture.quantity);
      expect(current.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day });
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhir[0].doseAndRate?.[0].doseQuantity).toEqual(fixture.quantity);
      expect(input).toEqual(before);
    }
    expect(row).toEqual(original);
  });

  it.each(["text", "display", "configured"] as const)("preserves selected Thai Apply wording from %s", selected => {
    const translation = buildTranslationPrimitiveElement({ th: "ติด" })!;
    const method: NonNullable<FhirDosage["method"]> = selected === "display"
      ? { coding: [{ system: SNOMED, code: "738991002", display: "Apply", _display: translation }] }
      : { text: "Apply", ...(selected === "text" ? { _text: translation } : {}) };
    const row: FhirDosage = { method, doseAndRate: [{ doseQuantity: { value: 1, system: edqm, code: "15036000" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    const options: ParseOptions = selected === "configured" ? { instructionActionMap: { apply: {
      code: "apply", display: "Apply", semanticClass: "administration", i18n: { th: "ติด" }
    } } } : {};
    const original = structuredClone(row);
    for (const input of currentViews(row)) {
      const before = structuredClone(input);
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" }))
        .toBe("ติดครั้งละ 1 แผ่นแปะ วันละครั้ง.");
      expect(projectCanonicalCourse(importCanonicalCourse(input)).fhir[0].method).toEqual(method);
      expect(input).toEqual(before);
    }
    expect(row).toEqual(original);
  });
});
