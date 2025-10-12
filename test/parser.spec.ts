import { describe, expect, it } from "vitest";
import { fromFhirDosage, formatSig, parseSig } from "../src/index";
import { DEFAULT_UNIT_SYNONYMS, EVENT_TIMING_TOKENS, ROUTE_TEXT } from "../src/maps";
import { EventTiming, RouteCode, SNOMEDCTRouteCodes } from "../src/types";
import { normalizeDosageForm } from "../src/context";

const TAB_CONTEXT = { dosageForm: "tab" } as const;

describe("parseSig core scenarios", () => {
  it("parses 1x3 po pc", () => {
    const result = parseSig("1x3 po pc", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d",
      when: ["PC"]
    });
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Oral route"],
      display: "Oral route"
    });
    expect(result.longText).toBe("Take 1 tablet by mouth three times daily after meals.");
  });

  it("infers ophthalmic units from medication context", () => {
    const result = parseSig("1x3 OD", {
      context: { dosageForm: "eye drops, solution" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("defaults ophthalmic units when only site hints are supplied", () => {
    const result = parseSig("1x3 OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.site?.text).toBe("right eye");
  });

  it("interprets OD as once daily when systemic cues are present", () => {
    const result = parseSig("1 tab OD", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("preserves ophthalmic interpretation of OD when eye context exists", () => {
    const result = parseSig("1 drop OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.timing?.code).toBeUndefined();
  });

  it("interprets ophthalmic double OD as right eye once daily", () => {
    const result = parseSig("1 drop OD OD");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("infers ophthalmic route from spelled eye site", () => {
    const result = parseSig("1 drop right eye once daily");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
  });

  it("treats OD as once daily when no other frequency cues exist", () => {
    const result = parseSig("Take medication OD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("interprets OS followed by OD as left eye once daily", () => {
    const result = parseSig("1 drop OS OD");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("interprets to OS OD as left eye once daily", () => {
    const result = parseSig("1 drop to OS OD");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Ophthalmic route"]);
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats trailing OD as once daily when the eye site is already spelled out", () => {
    const result = parseSig("1 drop to left eye od");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats spelled non-ophthalmic sites before OD as once daily cadence", () => {
    const result = parseSig("1 drop to forehead od");
    expect(result.fhir.site?.text).toBe("forehead");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("treats spelled sites after OD as once daily cadence cues", () => {
    const result = parseSig("1 drop od to left eye");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps non-ophthalmic routes when OD precedes a spelled body site", () => {
    const result = parseSig("1 drop od to skin");
    expect(result.fhir.site?.text).toBe("skin");
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("recognizes uncommon spelled sites after OD", () => {
    const result = parseSig("1 drop od to hair");
    expect(result.fhir.site?.text).toBe("hair");
    expect(result.fhir.route?.coding?.[0]?.code).not.toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("strips connector words from spelled site phrases", () => {
    const result = parseSig("1 drop bid to face");
    expect(result.fhir.site?.text).toBe("face");
    expect(result.longText).toBe("Apply 1 drop twice daily to the face.");
  });

  it("interprets repeated OD as right eye once daily", () => {
    const result = parseSig("OD OD");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Ophthalmic route"]
    );
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("prefers non-ophthalmic route matches over OD eye interpretation", () => {
    const result = parseSig("1 drop td od");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Transdermal route"]
    );
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps subcutaneous routes when OD supplies cadence", () => {
    const result = parseSig("1 drop sc od");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Subcutaneous route"]
    );
    expect(result.fhir.site).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.warnings).toEqual([]);
  });

  it("interprets dotted O.D. as once daily when paired with oral route", () => {
    const result = parseSig("500 mg po O.D.");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 500, unit: "mg" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
    expect(result.fhir.site).toBeUndefined();
  });

  it("parses numeric per-day cadence shorthand", () => {
    const result = parseSig("1 tab 3/day", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric per-day shorthand with capital D", () => {
    const result = parseSig("1 tab 1/D", { context: TAB_CONTEXT });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QD");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses numeric per-week cadence", () => {
    const result = parseSig("2 puffs 2/week");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "puff" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "wk"
    });
  });

  it("parses numeric per-month cadence", () => {
    const result = parseSig("Apply 1 patch 1/month");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "mo"
    });
  });

  it("infers inhalation units from respiratory route hints", () => {
    const result = parseSig("2 inh q4h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "puff" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Respiratory tract route (qualifier value)"]
    );
  });

  it("infers per vagina route from spelled site text", () => {
    const result = parseSig("Apply cream to vagina once daily");
    expect(result.fhir.site?.text).toBe("vagina");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per vagina"]);
  });

  it("captures nasal site phrases without leaving stray text", () => {
    const result = parseSig("Spray once daily to nostril");
    expect(result.fhir.site?.text).toBe("nostril");
    expect(result.meta.leftoverText).toBeUndefined();
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Nasal route"]);
  });

  it("infers patch units for transdermal routes", () => {
    const result = parseSig("1 td daily");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Transdermal route"]);
  });

  it("infers suppository units for rectal routes", () => {
    const result = parseSig("1 pr q12h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({
      value: 1,
      unit: "suppository"
    });
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Per rectum"]);
  });

  it("formats oral bedtime instructions", () => {
    const result = parseSig("1 mg po hs");
    expect(result.longText).toBe("Take 1 mg by mouth at bedtime.");
  });

  it("parses dose ranges with frequency code", () => {
    const result = parseSig("1-2 tabs po prn pain tid", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseRange).toEqual({
      low: { value: 1, unit: "tab" },
      high: { value: 2, unit: "tab" }
    });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.longText).toContain("1 to 2 tablets by mouth");
    expect(result.longText).toContain("as needed for pain");
  });

  it("parses po qid pc", () => {
    const result = parseSig("po qid pc");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d",
      when: ["PC"]
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
  });

  it("parses 1*3 po ac", () => {
    const result = parseSig("1*3 po ac", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("TID");
    expect(result.fhir.timing?.repeat?.when).toEqual(["AC"]);
  });

  it("parses daily without code", () => {
    const result = parseSig("500 mg po daily");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 500, unit: "mg" });
    expect(result.fhir.timing?.code).toBeUndefined();
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
  });

  it("parses q6h prn", () => {
    const result = parseSig("2 tab po q6h prn pain");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q6H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(result.fhir.asNeededBoolean).toBe(true);
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("pain");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Oral route"]);
  });

  it("parses period ranges with prn reasons", () => {
    const result = parseSig("2 supp q 6-8 h prn constipation");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "suppository" });
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodMax: 8,
      periodUnit: "h"
    });
    expect(result.fhir.asNeededBoolean).toBe(true);
    expect(result.fhir.asNeededFor?.[0]?.text).toBe("constipation");
    expect(result.longText).toContain("every 6 to 8 hours");
  });

  it("parses 1x2 subcutaneous", () => {
    const result = parseSig("1x2 subcutaneous");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1 });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("BID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 2,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.route?.text).toBe("subcutaneous");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Subcutaneous route"],
      display: "Subcutaneous route"
    });
  });

  it("parses q12h", () => {
    const result = parseSig("q12h");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q12H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 12, periodUnit: "h" });
  });

  it("parses q6-8h interval shorthand", () => {
    const result = parseSig("q6-8h");
    expect(result.fhir.timing?.repeat).toMatchObject({
      period: 6,
      periodMax: 8,
      periodUnit: "h"
    });
  });

  it("parses separated q 2 wk", () => {
    const result = parseSig("q 2 wk");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "wk" });
  });

  it("parses q wk", () => {
    const result = parseSig("q wk");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
  });

  it("parses q 2 d", () => {
    const result = parseSig("q 2 d");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
  });

  it("parses weekly friday", () => {
    const result = parseSig("weekly friday");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["fri"] });
  });

  it("parses 1xweekly tuesday", () => {
    const result = parseSig("1xweekly tuesday", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["tue"] });
  });

  it("parses 1*weekly wednesday", () => {
    const result = parseSig("1*weekly wednesday", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk", dayOfWeek: ["wed"] });
    expect(result.longText).toContain("once weekly on Wednesday");
  });

  it("parses q1mo", () => {
    const result = parseSig("q1mo");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "mo" });
  });

  it("parses separated q 2 mo", () => {
    const result = parseSig("q 2 mo");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "mo" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q2MO");
  });

  it("parses monthly token", () => {
    const result = parseSig("monthly");
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "mo" });
  });

  it("maps AM to EventTiming", () => {
    const result = parseSig("1 po am", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("AM");
    expect(result.fhir.timing?.repeat?.when).toEqual(["MORN"]);
  });

  it("maps NOON", () => {
    const result = parseSig("1 po noon", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["NOON"]);
  });

  it("maps PM", () => {
    const result = parseSig("1 po pm", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("PM");
    expect(result.fhir.timing?.repeat?.when).toEqual(["EVE"]);
  });

  it("maps HS", () => {
    const result = parseSig("1xHS", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual(["HS"]);
  });

  it("maps STAT to immediate timing", () => {
    const result = parseSig("1 tab po stat", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
  });

  it("maps early morning combo", () => {
    const result = parseSig("1 tab early morning", { context: TAB_CONTEXT });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Early Morning"]]);
  });

  it("maps upon waking", () => {
    const result = parseSig("upon waking");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Wake]);
  });

  it("parses q1w via compact token", () => {
    const result = parseSig("q1w");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 1, periodUnit: "wk" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("WK");
  });

  it("maps WM", () => {
    const result = parseSig("wm");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
  });

  it("maps pc breakfast", () => {
    const result = parseSig("pc breakfast");
    expect(result.fhir.timing?.repeat?.when).toEqual(["PCM"]);
  });

  it("maps ac dinner", () => {
    const result = parseSig("ac dinner");
    expect(result.fhir.timing?.repeat?.when).toEqual(["ACV"]);
  });

  it("warns for qd", () => {
    const result = parseSig("1 po qd");
    expect(result.warnings[0]).toContain("QD");
  });

  it("warns for qod", () => {
    const result = parseSig("1 po qod");
    expect(result.warnings[0]).toContain("QOD");
  });

  it("warns for bld", () => {
    const result = parseSig("1 po bld");
    expect(result.warnings[0]).toContain("BLD");
    expect(result.fhir.timing?.repeat?.when).toEqual(["C"]);
  });

  it("warns for ad alternate days", () => {
    const result = parseSig("1 po ad");
    expect(result.warnings[0]).toContain("AD");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d" });
  });

  it("infers unit from context", () => {
    const result = parseSig("1", { context: { dosageForm: "tab" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "tab" });
  });

  it("uses container unit from context", () => {
    const result = parseSig("2", {
      context: { dosageForm: "sol", containerUnit: "mL" }
    });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "mL" });
  });

  it("normalizes complex dosage forms from context", () => {
    const result = parseSig("1", { context: { dosageForm: "capsule, soft" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "cap" });
  });

  it("normalizes transdermal dosage forms", () => {
    const result = parseSig("1", { context: { dosageForm: "transdermal patch" } });
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "patch" });
  });

  it("parses patch td daily", () => {
    const result = parseSig("1 patch td daily");
    expect(result.fhir.route?.text).toBe("transdermal");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Transdermal route"]
    );
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity?.unit).toBe("patch");
    expect(result.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
  });

  it("recognizes per rectum phrasing", () => {
    const result = parseSig("per rectum qd");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Per rectum"]
    );
    expect(result.fhir.route?.text).toBe(
      ROUTE_TEXT[SNOMEDCTRouteCodes["Per rectum"] as RouteCode]
    );
  });

  it("recognizes intravenous route text", () => {
    const result = parseSig("intravenous route q6h");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravenous route"]
    );
  });

  it("recognizes iv bolus synonyms", () => {
    const result = parseSig("iv bolus stat");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravenous route"]
    );
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
  });

  it("captures site text", () => {
    const result = parseSig("1 mL IM left arm");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "mL" });
    expect(result.fhir.site?.text).toBe("left arm");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intramuscular route"]
    );
  });

  it("short text round trip", () => {
    const sig = "2 tab po q6h prn pain";
    const parsed = parseSig(sig);
    const shortText = formatSig(parsed.fhir, "short");
    expect(shortText).toContain("Q6H");
  });

  it("fromFhirDosage falls back to text", () => {
    const sig = "1x3 po pc";
    const parsed = parseSig(sig, { context: TAB_CONTEXT });
    const again = fromFhirDosage(parsed.fhir);
    expect(again.longText).toBe(parsed.longText);
  });
});

describe("unit normalization", () => {
  it("normalizes every default unit synonym", () => {
    for (const [input, canonical] of Object.entries(DEFAULT_UNIT_SYNONYMS)) {
      const result = parseSig(`1 ${input}`);
      const dose = result.fhir.doseAndRate?.[0]?.doseQuantity;
      if (!dose) {
        throw new Error(`Expected dose quantity for unit ${input}`);
      }
      expect(dose.unit).toBe(canonical);
      expect(dose.value).toBe(1);
    }
  });

  it("normalizes dosage form strings", () => {
    expect(normalizeDosageForm("Nasal Spray, Suspension")).toBe("nasal spray");
    expect(normalizeDosageForm("capsule, soft")).toBe("capsule");
    expect(normalizeDosageForm(undefined)).toBeUndefined();
  });
});

describe("ocular and injection scenarios", () => {
  it("parses right eye drops with QID", () => {
    const result = parseSig("1 drop OD QID");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("QID");
    expect(result.fhir.timing?.repeat).toMatchObject({
      frequency: 4,
      period: 1,
      periodUnit: "d"
    });
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Ophthalmic route"],
      display: "Ophthalmic route"
    });
    expect(result.longText).toBe("Instill 1 drop four times daily in the right eye.");
  });

  it("parses left eye drops every 2 hours", () => {
    const result = parseSig("1 drop OS Q2H");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q2H");
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "h" });
    expect(result.fhir.site?.text).toBe("left eye");
  });

  it("parses both eyes every hour", () => {
    const result = parseSig("1 drop OU Q1H");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("Q1H");
    expect(result.fhir.site?.text).toBe("both eyes");
    expect(result.longText).toBe("Instill 1 drop every 1 hour in both eyes.");
  });

  it("formats combined qid and bedtime ocular dosing", () => {
    const result = parseSig("1 drop OU QID hs");
    expect(result.longText).toBe(
      "Instill 1 drop four times daily and at bedtime in both eyes."
    );
  });

  it("parses intramuscular injections", () => {
    const result = parseSig("1 mL IM q6h");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "mL" });
    expect(result.fhir.timing?.repeat).toMatchObject({ period: 6, periodUnit: "h" });
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intramuscular route"],
      display: "Intramuscular route"
    });
  });

  it("parses intravenous stat dosing", () => {
    const result = parseSig("1 mL IV stat");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming.Immediate]);
    expect(result.fhir.route?.coding?.[0]?.code).toBe(SNOMEDCTRouteCodes["Intravenous route"]);
  });

  it("parses spaced IVT shorthand with eye side", () => {
    const result = parseSig("0.05 mL IVT OS q1mo");
    expect(result.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 0.05, unit: "mL" });
    expect(result.fhir.timing?.code?.coding?.[0]?.code).toBe("MO");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"],
      display: "Intravitreal route (qualifier value)"
    });
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.warnings).toHaveLength(0);
  });

  it("parses combined IVT shorthand tokens", () => {
    const result = parseSig("0.05 mL IVTOD q1mo");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"]
    );
  });

  it("parses VOD shorthand as intravitreal right eye", () => {
    const result = parseSig("0.05 mL VOD q1mo");
    expect(result.fhir.site?.text).toBe("right eye");
    expect(result.fhir.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"],
      display: "Intravitreal route (qualifier value)"
    });
    expect(result.warnings).toHaveLength(0);
  });

  it("parses VOS shorthand as intravitreal left eye", () => {
    const result = parseSig("0.05 mL VOS q1mo");
    expect(result.fhir.site?.text).toBe("left eye");
    expect(result.fhir.route?.coding?.[0]?.code).toBe(
      SNOMEDCTRouteCodes["Intravitreal route (qualifier value)"]
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when intravitreal lacks an eye side", () => {
    const result = parseSig("0.05 mL intravitreal q1mo");
    expect(result.warnings).toContain(
      "Intravitreal administrations require an eye site (e.g., OD/OS/OU)."
    );
  });
});

describe("minute and fractional interval parsing", () => {
  const cases: Array<{ input: string; period: number; unit: string }> = [
    { input: "q30min", period: 30, unit: "min" },
    { input: "q15min", period: 15, unit: "min" },
    { input: "q0.5h", period: 30, unit: "min" },
    { input: "q1/2hr", period: 30, unit: "min" },
    { input: "q0.25h", period: 15, unit: "min" },
    { input: "q1/4hr", period: 15, unit: "min" },
    { input: "q 0.5 h", period: 30, unit: "min" },
    { input: "q 30 minutes", period: 30, unit: "min" },
    { input: "q 15 minutes", period: 15, unit: "min" },
    { input: "q30 m", period: 30, unit: "min" }
  ];

  for (const { input, period, unit } of cases) {
    it(`parses ${input} as every ${period} ${unit}`, () => {
      const result = parseSig(input);
      expect(result.fhir.timing?.repeat).toMatchObject({ period, periodUnit: unit });
    });
  }
});

describe("smart meal expansion", () => {
  it("keeps generic tokens when expansion disabled", () => {
    const result = parseSig("1x2 po ac");
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
  });

  it("expands before-meal tokens when enabled", () => {
    const result = parseSig("1x2 po ac", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Dinner"]
    ]);
  });

  it("supports alternate meal pairing", () => {
    const result = parseSig("1x2 po pc", {
      smartMealExpansion: true,
      twoPerDayPair: "breakfast+lunch"
    });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"]
    ]);
  });

  it("adds bedtime for four with-meal doses", () => {
    const result = parseSig("1x4 po wm", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([
      EventTiming.Breakfast,
      EventTiming.Lunch,
      EventTiming.Dinner,
      EventTiming["Before Sleep"]
    ]);
  });

  it("avoids expanding when only interval cadence present", () => {
    const result = parseSig("po ac q6h", { smartMealExpansion: true });
    expect(result.fhir.timing?.repeat?.when).toEqual([EventTiming["Before Meal"]]);
  });
});

describe("event timing token coverage", () => {
  for (const [token, expected] of Object.entries(EVENT_TIMING_TOKENS)) {
    it(`maps ${token} to ${expected}`, () => {
      const result = parseSig(token);
      expect(result.fhir.timing?.repeat?.when).toEqual([expected]);
    });
  }
});
