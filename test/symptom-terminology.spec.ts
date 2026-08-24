import { describe, expect, it } from "vitest";
import {
  listSymptomDefinitions,
  parseSig,
  resolveSymptomDefinition,
  suggestSig
} from "../src";
import { DEFAULT_SYMPTOM_ENTRIES, normalizeSymptomKey } from "../src/symptom-terminology";

const SNOMED = "http://snomed.info/sct";

const EXPANDED_SYMPTOMS = [
  ["84229001", "fatigue", "อ่อนเพลีย"],
  ["271594007", "syncope", "เป็นลม"],
  ["267038008", "edema", "บวม"],
  ["43724002", "chills", "หนาวสั่น"],
  ["79890006", "loss of appetite", "เบื่ออาหาร"],
  ["262285001", "weight loss", "น้ำหนักลด"],
  ["40917007", "confusion", "สับสน"],
  ["214264003", "lethargy", "ซึม"],
  ["34095006", "dehydration", "ขาดน้ำ"],
  ["66857006", "hemoptysis", "ไอเป็นเลือด"],
  ["40739000", "dysphagia", "กลืนลำบาก"],
  ["91019004", "paresthesia", "เหน็บชา"],
  ["44077006", "numbness", "ชา"],
  ["91175000", "seizure", "ชัก"],
  ["26079004", "tremor", "มือสั่น"],
  ["111516008", "blurred vision", "ตามัว"],
  ["409668002", "photophobia", "แพ้แสง"],
  ["24982008", "diplopia", "เห็นภาพซ้อน"],
  ["193982009", "epiphora", "น้ำตาไหล"],
  ["60862001", "tinnitus", "หูอื้อ"],
  ["15188001", "hearing loss", "หูตึง"],
  ["50219008", "hoarseness", "เสียงแหบ"],
  ["34436003", "hematuria", "ปัสสาวะเป็นเลือด"],
  ["267064002", "urinary retention", "ปัสสาวะไม่ออก"],
  ["165232002", "urinary incontinence", "กลั้นปัสสาวะไม่อยู่"],
  ["14302001", "amenorrhea", "ประจำเดือนไม่มา"],
  ["386692008", "menorrhagia", "ประจำเดือนออกมาก"],
  ["289530006", "vaginal bleeding", "เลือดออกทางช่องคลอด"]
] as const;

describe("shared symptom terminology", () => {
  it("publishes 100 unique coded default symptoms", () => {
    const definitions = listSymptomDefinitions();
    const codes = definitions
      .map((definition) => definition.coding?.code)
      .filter((code): code is string => Boolean(code));
    expect(definitions).toHaveLength(100);
    expect(codes).toHaveLength(100);
    expect(new Set(codes).size).toBe(100);
  });

  it("has no normalized surface collisions across different symptom concepts", () => {
    const ownerBySurface = new Map<string, string>();
    for (const entry of DEFAULT_SYMPTOM_ENTRIES) {
      const code = entry.definition.coding?.code;
      expect(code).toBeDefined();
      for (const term of entry.terms) {
        const key = normalizeSymptomKey(term);
        const existing = ownerBySurface.get(key);
        expect(existing === undefined || existing === code, `collision for ${term}`).toBe(true);
        ownerBySurface.set(key, code!);
      }
    }
    expect(ownerBySurface.size).toBeGreaterThan(500);
  });

  it.each(EXPANDED_SYMPTOMS)(
    "codes %s from English %s and Thai %s through the HPSG symptom slot",
    (code, english, thai) => {
      for (const [source, options] of [
        [`1 tab po prn ${english}`, {}],
        [`1 tab po prn ${thai}`, { locale: "th" }]
      ] as const) {
        const parsed = parseSig(source, options);
        expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
          system: SNOMED,
          code
        });
        expect(parsed.meta.leftoverText).toBeUndefined();
      }
      expect(resolveSymptomDefinition(english)?.coding?.code).toBe(code);
      expect(resolveSymptomDefinition(thai)?.coding?.code).toBe(code);
    }
  );

  it("lets runtime symptomMap vocabulary flow through parser coding and suggestions", () => {
    const options = {
      symptomMap: {
        "breakthrough symptom": {
          coding: {
            system: "https://example.test/CodeSystem/symptom",
            code: "BTS",
            display: "Breakthrough symptom"
          },
          text: "Breakthrough symptom",
          aliases: ["breakthrough"]
        }
      }
    } as const;
    for (const source of [
      "1 tab po prn breakthrough",
      "when breakthrough take 1 tab po"
    ]) {
      const parsed = parseSig(source, options);
      expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
        system: "https://example.test/CodeSystem/symptom",
        code: "BTS"
      });
      expect(parsed.meta.leftoverText).toBeUndefined();
    }
    expect(suggestSig("1 tab po prn break", { ...options, limit: 10 }))
      .toContain("1 tab po prn breakthrough symptom");
  });

  it("keeps prnReasonMap as the narrower override over symptomMap", () => {
    const parsed = parseSig("1 tab po prn breakthrough", {
      symptomMap: {
        breakthrough: {
          coding: { system: "https://example.test/symptom", code: "GEN", display: "Generic" },
          text: "Generic"
        }
      },
      prnReasonMap: {
        breakthrough: {
          coding: { system: "https://example.test/prn", code: "PRN", display: "PRN override" },
          text: "PRN override"
        }
      }
    });
    expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]).toMatchObject({
      system: "https://example.test/prn",
      code: "PRN"
    });
  });
});
