import { describe, expect, it } from "vitest";
import { formatSig, fromFhirDosage, nextDueDoses, parseSig, RouteCode } from "../src";

describe("OPD clinician dogfood grammar", () => {
  it.each([
    ["2 drops affected ear bid x5d", "affected ear", RouteCode["Otic route"]],
    ["1 drop affected eye qid", "affected eye", RouteCode["Ophthalmic route"]]
  ] as const)("preserves pathological site modifiers without over-coding: %s", (source, site, route) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe(site);
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(route);
  });

  it("realizes affected eye/ear naturally in Thai without inventing anatomy coding", () => {
    expect(formatSig(parseSig("2 drops affected ear bid").fhir, "long", { locale: "th" }))
      .toContain("หูข้างที่มีอาการ");
    expect(formatSig(parseSig("1 drop affected eye qid").fhir, "long", { locale: "th" }))
      .toContain("ตาข้างที่มีอาการ");
  });

  it("models maximum dose counts without contaminating the PRN reason", () => {
    const parsed = parseSig("1 tab sl q5min prn chest pain max 3 doses");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("chest pain");
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({ count: 1, countMax: 3 });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3 });
    expect(parsed.longText).toContain("for up to 3 doses");
    expect(fromFhirDosage(parsed.fhir).meta.canonical.clauses[0]?.schedule).toMatchObject({
      count: 1,
      countMax: 3
    });
  });

  it("uses countMax as the operational schedule cap", () => {
    const dosage = parseSig("1 tab q5min max 3 doses").fhir;
    expect(nextDueDoses(dosage, {
      timeZone: "UTC",
      orderedAt: "2024-01-01T08:00:00Z",
      from: "2024-01-01T08:00:00Z",
      limit: 10
    })).toEqual([
      "2024-01-01T08:00:00+00:00",
      "2024-01-01T08:05:00+00:00",
      "2024-01-01T08:10:00+00:00"
    ]);
  });

  it.each([
    ["1 drop od q2h while awake", "while awake", "ขณะตื่น"],
    ["1 drop od q2h while awake only", "while awake only", "เฉพาะขณะตื่น"],
    ["1 drop od q2h ขณะตื่น", "while awake", "ขณะตื่น"],
    ["1 drop od q2h เฉพาะขณะตื่น", "while awake only", "เฉพาะขณะตื่น"]
  ] as const)("preserves awake-window qualifiers without pretending they are WAKE events: %s", (source, text, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.additionalInstructions).toContainEqual(
      expect.objectContaining({ text })
    );
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
  });

  it("keeps trailing cadence outside procedural action arguments", () => {
    const parsed = parseSig("gargle 10 mL then spit tid");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({
      frequency: 3,
      period: 1,
      periodUnit: "d"
    });
    const spit = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "spit"
    );
    expect(spit?.args ?? []).toEqual([]);
  });

  it.each([
    ["wait 5 minutes between eye drops", "Wait 5 minutes between eye drops.", "รอ 5 นาที ระหว่างการหยอดตา."],
    ["รอ 5 นาที ระหว่างยาหยอดตา", "Wait 5 minutes between eye drops.", "รอ 5 นาที ระหว่างการหยอดตา."]
  ] as const)("types between-dose waiting intervals: %s", (source, english, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const wait = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "wait"
    );
    expect(wait?.relation).toBe("between");
    expect(wait?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "duration", quantity: { value: 5, unit: "min" } }),
      expect.objectContaining({ role: "activity", conceptId: "eye_drop_administration" })
    ]));
    expect(parsed.longText).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
  });

  it.each([
    ["chew 1 tab before swallowing", "Chew 1 tablet before swallowing.", "เคี้ยว 1 เม็ดก่อนกลืน."],
    ["เคี้ยว 1 เม็ด ก่อนกลืน", "Chew 1 tablet before swallow.", "เคี้ยว 1 เม็ดก่อนกลืน."]
  ] as const)("preserves chew-before-swallow workflow semantics: %s", (source, english, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const chew = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "chew"
    );
    expect(chew?.relation).toBe("before");
    expect(chew?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "activity" })
    ]));
    expect(parsed.longText).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(thai);
  });

  it.each([
    ["inhale 2 puffs before exercise", "ก่อนออกกำลังกาย"],
    ["สูด 2 พัฟ ก่อนออกกำลังกาย", "ก่อนออกกำลังกาย"]
  ] as const)("preserves pre-exercise inhaler windows without inventing a FHIR event: %s", (source, thai) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Respiratory tract route (qualifier value)"]);
    expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.additionalInstructions).toContainEqual(
      expect.objectContaining({ text: "before exercise" })
    );
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
  });

  it("keeps mouth-rinse amount, contact time, and trailing cadence in their own semantic slots", () => {
    const parsed = parseSig("rinse mouth with 10 mL for 30 seconds then spit, bid");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 10, unit: "mL" });
    expect(parsed.meta.canonical.clauses[0]?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    const rinse = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "rinse_mouth"
    );
    expect(rinse?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "amount", quantity: { value: 10, unit: "mL" } }),
      expect.objectContaining({ role: "duration", quantity: { value: 30, unit: "s" } })
    ]));
    const spit = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "spit"
    );
    expect(spit?.args ?? []).toEqual([]);
  });

  it("recognizes now as immediate event timing", () => {
    const parsed = parseSig("take 1 tab now");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).toEqual(["IMD"]);
  });

  it.each([
    [
      "take 1 tab now then repeat 1 tab after 2 hours if migraine persists",
      "Take 1 tablet orally immediately. Repeat 1 tablet after 2 hours if migraine persists.",
      "ถ้ายังมีอาการไมเกรน"
    ],
    [
      "กิน 1 เม็ดทันที แล้วกินซ้ำหลัง 2 ชั่วโมงถ้ายังปวดไมเกรน",
      "Take 1 tablet orally immediately. Repeat after 2 hours if migraine persists.",
      "ถ้ายังปวดไมเกรน"
    ]
  ] as const)("models dependent repeat timing and condition separately: %s", (source, english, thaiCondition) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.schedule?.when).toEqual(["IMD"]);
    const repeat = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.find(
      (action) => action.predicate.lemma === "repeat"
    );
    expect(repeat?.relation).toBe("after");
    expect(repeat?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "duration", quantity: { value: 2, unit: "h" } })
    ]));
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.relations).toContainEqual(
      expect.objectContaining({
        kind: "if",
        toActionIndex: repeat?.sequenceIndex
      })
    );
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toBe(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thaiCondition);
  });

  it("does not duplicate an amount already contained in a procedural object", () => {
    const parsed = parseSig("dissolve 1 tab under tongue prn chest pain");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.text).toBe("chest pain");
    expect(parsed.longText).toBe("Dissolve 1 tab under tongue.");
    expect(parsed.longText.match(/\b1 tab(?:let)?\b/gi)).toHaveLength(1);
  });

  it.each([
    ["remain upright 30 minutes", 30, "min"],
    ["stay upright half an hour", 0.5, "h"],
    ["sit upright half a day", 0.5, "d"],
    ["นั่งตัวตรงครึ่งชั่วโมง", 0.5, "h"]
  ] as const)("types upright-duration advice compositionally: %s", (source, value, unit) => {
    const parsed = parseSig(source);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions?.[0];
    expect(action?.predicate.lemma).toBe("remain-upright");
    expect(action?.args?.find((arg) => arg.role === "duration")?.quantity).toEqual({ value, unit });
  });
});
