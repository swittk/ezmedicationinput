import { describe, expect, it } from "vitest";
import { formatSig, listMedicationInstructionActions, parseSig } from "../src/index";
import { findAdditionalInstructionDefinitionByCoding } from "../src/advice";
import { RouteCode } from "../src/types";

const SNOMED = "http://snomed.info/sct";

// FHIR R5 SNOMEDCTAdministrationMethodCodes exemplar expansion, excluding
// the abstract/root concept 736665006 itself. The library may support more
// methods, but it should never regress below this published baseline.
const FHIR_R5_ADMINISTRATION_METHOD_CODES = [
  "738990001", "738991002", "738992009", "738993004", "738994005",
  "738995006", "738996007", "740666001", "740685003", "764498003",
  "764794000", "782155003", "782168006", "785900008", "823034001",
  "827107003", "1010690008", "1231460007", "58841000052102"
] as const;

const FHIR_R5_ADDITIONAL_INSTRUCTION_CODES = [
  "311501008", "311504000", "417929005", "417980006", "417995008",
  "418071006", "418194009", "418281004", "418443006", "418521000",
  "418577003", "418637003", "418639000", "418693002", "418849000",
  "418850000", "418914006", "418954008", "418991002", "419111009",
  "419115000", "419303009", "419437002", "419439004", "419444006",
  "419473009", "419529008", "419822006", "419974005", "420003005",
  "420082003", "420110001", "420162004", "420652005", "421484000",
  "421769005", "421984009", "422327006", "428579001", "717154004"
] as const;

describe("vendored administration-method terminology coverage", () => {
  it("covers every selectable method in the FHIR R5 exemplar expansion", () => {
    const covered = new Set(
      listMedicationInstructionActions()
        .map((definition) => definition.administrationMethod)
        .filter((coding) => coding?.system === SNOMED && coding.code)
        .map((coding) => coding!.code!)
    );
    for (const code of FHIR_R5_ADMINISTRATION_METHOD_CODES) {
      expect(covered, `missing FHIR R5 administration method ${code}`).toContain(code);
    }
  });

  it.each([
    ["administer 5 mL orally daily", "738990001"],
    ["suck 1 lozenge every 4 hours", "764498003"],
    ["orodisperse 1 tablet daily", "823034001"],
    ["implant 1 implant subcutaneously", "827107003"],
    ["insufflate 1 dose intranasally daily", "1010690008"],
    ["dialysis daily", "1231460007"],
    ["bathe affected area daily", "58841000052102"]
  ])("parses %s as exact coded method %s", (source, code) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({ system: SNOMED, code });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("realizes newly covered Thai method terminology instead of a generic route verb", () => {
    expect(parseSig("อม 1 เม็ด วันละ 3 ครั้ง", { locale: "th" }).longText)
      .toBe("อมครั้งละ 1 เม็ด วันละ 3 ครั้ง.");
    expect(parseSig("ปล่อยให้ละลายในปาก 1 เม็ด วันละครั้ง", { locale: "th" }).longText)
      .toBe("ปล่อยให้ละลายในปากครั้งละ 1 เม็ด วันละครั้ง.");
    expect(parseSig("ฝัง 1 implant ใต้ผิวหนัง", { locale: "th" }).longText)
      .toBe("ฝังครั้งละ 1 ชิ้น เข้าใต้ผิวหนัง.");
  });

  it("lets a caller add a true administration method declaratively", () => {
    const parsed = parseSig("atomize 2 sprays daily", {
      instructionActionMap: {
        atomize: {
          code: "atomize",
          semanticClass: "administration",
          display: "Atomize",
          procedural: false,
          acceptsAmount: true,
          definesDose: true,
          administrationMethod: {
            system: "https://example.test/CodeSystem/method",
            code: "atomize",
            display: "Atomize"
          },
          verbRouteHint: RouteCode["Nasal route"]
        }
      }
    });
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({
      system: "https://example.test/CodeSystem/method",
      code: "atomize"
    });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Nasal route"]);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "spray" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("vendored FHIR additional-instruction terminology coverage", () => {
  it("covers every selectable concept in the FHIR R5 exemplar expansion", () => {
    for (const code of FHIR_R5_ADDITIONAL_INSTRUCTION_CODES) {
      expect(
        findAdditionalInstructionDefinitionByCoding(SNOMED, code),
        `missing FHIR R5 additional instruction ${code}`
      ).toBeDefined();
    }
  });

  it.each([
    ["419444006", "ห้ามหยุดยา เว้นแต่แพทย์แนะนำ"],
    ["419974005", "ยานี้อาจทำให้ปัสสาวะเปลี่ยนสี"],
    ["421769005", "ใช้ตามคำแนะนำ"],
    ["420652005", "ใช้จนหมด"]
  ])("localizes coded FHIR additional instruction %s into Thai", (code, thai) => {
    const text = formatSig({
      additionalInstruction: [{ coding: [{ system: SNOMED, code }] }]
    }, "long", { locale: "th" });
    expect(text).toContain(thai);
  });
});
