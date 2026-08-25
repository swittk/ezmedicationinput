import { describe, expect, it } from "vitest";
import {
  formatSig, fromFhirDosage, getTimingOccurrenceCap, nextDueDoses, parseSig,
  TIMING_ACTIVITY_WINDOW_EXTENSION_URL, TIMING_OCCURRENCE_CAP_EXTENSION_URL
} from "../src";

describe("OPD normalized realization and advanced schedule semantics", () => {
  it("keeps offsets scoped and carries ophthalmic state into step-down stages", () => {
    const mixed = parseSig("take 1 tab 30 min before meals and at bedtime");
    expect(mixed.count).toBe(2);
    expect(mixed.items[0].fhir.timing?.repeat).toMatchObject({ offset: 30, when: ["AC"] });
    expect(mixed.items[1].fhir.timing?.repeat).toMatchObject({ when: ["HS"] });
    expect(mixed.items[1].fhir.timing?.repeat?.offset).toBeUndefined();

    const eye = parseSig("1 drop od q1h while awake x2d then qid x5d");
    expect(eye.count).toBe(2);
    expect(eye.items.map((item) => item.fhir.site?.text)).toEqual(["right eye", "right eye"]);
    expect(eye.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 1, unit: "drop" });
    expect(eye.items[0].fhir.additionalInstruction?.map((item) => item.text)).toContain("while awake");
    expect(eye.items[1].fhir.additionalInstruction).toBeUndefined();
  });

  it("carries inherited administration through multi-stage schedule tapers", () => {
    const source =
      "1 drop ou q2h for 1 week, then q 4 h for 1 week, then qid for 1 week, " +
      "then tid for 1 week, then bid for 1 week, then once daily";
    const parsed = parseSig(source);

    expect(parsed.count).toBe(6);
    expect(parsed.meta.segments.map((segment) => segment.text)).toEqual([
      "1 drop ou q2h for 1 week",
      "q 4 h for 1 week",
      "qid for 1 week",
      "tid for 1 week",
      "bid for 1 week",
      "once daily"
    ]);
    expect(parsed.items.map((item) => item.meta.canonical.clauses[0]?.schedule?.timingCode)).toEqual([
      "Q2H", "Q4H", "QID", "TID", "BID", "QD"
    ]);
    expect(parsed.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity)).toEqual(
      Array.from({ length: 6 }, () => ({ value: 1, unit: "drop" }))
    );
    expect(parsed.items.map((item) => item.fhir.site?.text)).toEqual(
      Array.from({ length: 6 }, () => "both eyes")
    );
    expect(parsed.items.slice(0, 5).map((item) => item.fhir.timing?.repeat?.boundsDuration)).toEqual(
      Array.from({ length: 5 }, () => ({
        value: 1, unit: "week", system: "http://unitsofmeasure.org", code: "wk"
      }))
    );
    expect(parsed.items[5]?.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.items.every((item) => item.meta.canonical.clauses[0]?.leftovers.length === 0)).toBe(true);

    expect(parsed.items.map((item) => formatSig(item.fhir, "long", { locale: "th" }))).toEqual([
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด ทุก 2 ชั่วโมง เป็นเวลา 1 สัปดาห์.",
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด ทุก 4 ชั่วโมง เป็นเวลา 1 สัปดาห์.",
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละ 4 ครั้ง เป็นเวลา 1 สัปดาห์.",
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละ 3 ครั้ง เป็นเวลา 1 สัปดาห์.",
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละ 2 ครั้ง เป็นเวลา 1 สัปดาห์.",
      "หยอดตาทั้งสองข้าง ครั้งละ 1 หยด วันละครั้ง."
    ]);
  });

  it.each([
    ["inhale 2 puffs before exercise", undefined],
    ["inhale 2 puffs 15 minutes before exercise", 15],
    ["inhale 2 puffs half an hour before exercise", 30]
  ] as const)("models activity timing structurally: %s", (source, offset) => {
    const parsed = parseSig(source);
    const activity = parsed.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0];
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(activity).toMatchObject({ relation: "before", activity: { text: "exercise" } });
    expect(activity?.offset).toBe(offset);
    expect(parsed.fhir.timing?.repeat?.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: TIMING_ACTIVITY_WINDOW_EXTENSION_URL })
    ]));
    const activityExtension = parsed.fhir.timing?.repeat?.extension
      ?.find((extension) => extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL)
      ?.extension?.find((extension) => extension.url === "activity")?.valueCodeableConcept;
    expect(activityExtension?._text).toBeUndefined();
    const translated = parseSig(source, { locale: "th" });
    const translatedActivity = translated.fhir.timing?.repeat?.extension
      ?.find((extension) => extension.url === TIMING_ACTIVITY_WINDOW_EXTENSION_URL)
      ?.extension?.find((extension) => extension.url === "activity")?.valueCodeableConcept;
    expect(translatedActivity?._text?.extension?.length).toBeGreaterThan(0);
    expect(fromFhirDosage(parsed.fhir).meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]?.offset)
      .toBe(offset);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ก่อนออกกำลังกาย");
  });

  it("keeps post-intercourse timing separate from bare PRN", () => {
    const parsed = parseSig("take 1 tab after intercourse prn");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]).toMatchObject({
      relation: "after", activity: { text: "intercourse" }
    });
    expect(parsed.meta.canonical.clauses[0]?.prn).toEqual({ enabled: true });
    expect(parsed.longText).toContain("after intercourse as needed");
  });

  it.each([
    ["apply thin layer to affected area every other night x2w", "NIGHT", "every other night", "วันเว้นคืน"],
    ["รับประทาน 1 เม็ด เช้าเว้นเช้า", "MORN", "every other morning", "เช้าเว้นเช้า"]
  ] as const)("preserves alternate-event cadence: %s", (source, when, en, th) => {
    const parsed = parseSig(source, { locale: /[ก-๙]/.test(source) ? "th" : "en" });
    expect(parsed.fhir.timing?.repeat).toMatchObject({ period: 2, periodUnit: "d", when: [when] });
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(en);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(th);
  });

  it("distinguishes per-day occurrence caps from total countMax and round-trips them", () => {
    const perDay = parseSig("take 1 tab q4h prn pain max 3 doses daily");
    expect(perDay.meta.canonical.clauses[0]?.schedule?.occurrenceCap)
      .toEqual({ max: 3, period: 1, periodUnit: "d" });
    expect(perDay.fhir.timing?.repeat?.countMax).toBeUndefined();
    expect(perDay.fhir.timing?.repeat?.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL })
    ]));
    expect(fromFhirDosage(perDay.fhir).meta.canonical.clauses[0]?.schedule?.occurrenceCap)
      .toEqual({ max: 3, period: 1, periodUnit: "d" });

    const total = parseSig("take 1 tab q5min prn chest pain max 3 doses");
    expect(total.fhir.timing?.repeat).toMatchObject({ count: 1, countMax: 3, period: 5, periodUnit: "min" });
    expect(total.meta.canonical.clauses[0]?.schedule?.occurrenceCap).toBeUndefined();
  });

  it("round-trips second-based occurrence caps", () => {
    expect(getTimingOccurrenceCap({
      extension: [{
        url: TIMING_OCCURRENCE_CAP_EXTENSION_URL,
        extension: [
          { url: "max", valueInteger: 2 },
          { url: "period", valueQuantity: { value: 30, code: "s", unit: "s" } }
        ]
      }]
    })).toEqual({ max: 2, period: 30, periodUnit: "s" });
  });

  it("composes Thai PRN and a per-day cap without swallowing either", () => {
    const parsed = parseSig(
      "รับประทาน 1 เม็ด ทุก 8 ชั่วโมง เมื่อมีอาการปวด ไม่เกิน 3 ครั้งต่อวัน",
      { locale: "th" }
    );
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.prn?.reason?.coding?.code).toBe("22253000");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.occurrenceCap)
      .toEqual({ max: 3, period: 1, periodUnit: "d" });
    expect(formatSig(parsed.fhir, "long", { locale: "en" }))
      .toContain("maximum 3 doses per day as needed for pain");
  });

  it("enforces a per-day cap against prior administration timestamps", () => {
    const dosage = parseSig("take 1 tab q4h prn pain max 3 doses daily").fhir;
    expect(nextDueDoses(dosage, {
      from: "2026-08-24T08:00:00+07:00",
      orderedAt: "2026-08-24T00:00:00+07:00",
      limit: 6,
      timeZone: "Asia/Bangkok",
      priorDoseTimes: ["2026-08-24T00:00:00+07:00", "2026-08-24T04:00:00+07:00"]
    })).toEqual([
      "2026-08-24T08:00:00+07:00",
      "2026-08-25T00:00:00+07:00",
      "2026-08-25T04:00:00+07:00",
      "2026-08-25T08:00:00+07:00",
      "2026-08-26T00:00:00+07:00",
      "2026-08-26T04:00:00+07:00"
    ]);
  });

  it("enforces second-based occurrence caps in shared period buckets", () => {
    const dosage = {
      timing: {
        repeat: {
          frequency: 1,
          period: 10,
          periodUnit: "s" as const,
          extension: [{
            url: TIMING_OCCURRENCE_CAP_EXTENSION_URL,
            extension: [
              { url: "max", valueInteger: 1 },
              { url: "period", valueQuantity: { value: 30, code: "s", unit: "s" } }
            ]
          }]
        }
      }
    };

    expect(nextDueDoses(dosage, {
      from: "2026-08-24T00:00:00Z",
      orderedAt: "2026-08-24T00:00:00Z",
      timeZone: "UTC",
      limit: 4
    })).toEqual([
      "2026-08-24T00:00:00+00:00",
      "2026-08-24T00:00:30+00:00",
      "2026-08-24T00:01:00+00:00",
      "2026-08-24T00:01:30+00:00"
    ]);
  });

  it("round-trips the normalized Thai per-target nasal dose surface", () => {
    const first = parseSig("2 sprays each nostril daily", {
      context: { dosageForm: "nasal spray, solution" }
    });
    const thai = formatSig(first.fhir, "long", { locale: "th" });
    expect(thai).toBe("พ่นเข้ารูจมูกข้างละ 2 ครั้ง วันละครั้ง.");
    const reparsed = parseSig(thai, { locale: "th" });
    expect(reparsed.meta.leftoverText).toBeUndefined();
    expect(reparsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 2, unit: "spray" });
    expect(reparsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(reparsed.fhir.site?.text).toBe("both nostrils");
  });

  it("normalizes Thai insulin ยูนิต through the shared unit terminology", () => {
    const parsed = parseSig("ฉีด 10 ยูนิต ใต้ผิวหนัง ก่อนนอน", { locale: "th" });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toEqual({ value: 10, unit: "U" });
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("10 ยูนิต");
  });

  it("realizes weekly recurrence without lying about frequency", () => {
    expect(parseSig("take 1 tab weekly on Monday").longText).toContain("once weekly on Monday");
    expect(parseSig("take 2 tabs Monday Wednesday Friday").longText)
      .toBe("Take 2 tablets orally on Monday, Wednesday and Friday.");
    expect(parseSig("take 1 tab twice weekly").longText).toContain("twice weekly");
  });

  it("realizes canonical and graph procedure truth once and in source order", () => {
    const topical = parseSig("wash affected area then apply thin layer bid");
    expect(topical.longText)
      .toBe("Wash affected area; then apply a thin layer twice daily to the affected area.");
    expect(formatSig(topical.fhir, "long", { locale: "th" }))
      .toBe("ล้างบริเวณที่มีอาการ จากนั้นทาบางๆ บริเวณที่มีอาการ วันละ 2 ครั้ง.");

    const gargle = parseSig("gargle with 10 mL for 30 seconds then spit tid");
    expect(gargle.longText)
      .toBe("Gargle 10 mL for 30 seconds three times daily; then spit out.");
  });

  it("localizes uncoded typed advice through the shared grammar and site terminology", () => {
    const parsed = parseSig("apply pea-sized amount to face nightly avoid eyes");
    expect(formatSig(parsed.fhir, "long", { locale: "th" }))
      .toContain("หลีกเลี่ยงบริเวณตา");
  });

  it("keeps short course-completion shorthand typed without over-coding it", () => {
    const parsed = parseSig("take 1 cap bid x7d finish the course");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.additionalInstruction).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions)
      .toContainEqual(expect.objectContaining({ predicate: expect.objectContaining({ lemma: "complete-course" }) }));
    expect(parsed.longText).toContain("complete the course");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ใช้ยาให้ครบ");

  });

  it("preserves negated procedural durations across languages", () => {
    const lie = parseSig("do not lie down for 30 minutes");
    expect(lie.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.args)
      .toContainEqual(expect.objectContaining({ role: "duration", quantity: { value: 30, unit: "min" } }));
    expect(formatSig(lie.fhir, "long", { locale: "th" })).toContain("ห้ามนอนราบเป็นเวลา 30 นาที");

    const nose = parseSig("spray each nostril bid then do not blow nose for 10 minutes");
    expect(formatSig(nose.fhir, "long", { locale: "th" })).toContain("ห้ามสั่งน้ำมูกเป็นเวลา 10 นาที");
  });

  it("types common ear-drop aftercare instead of leaving prose opaque", () => {
    const upward = parseSig("3 drops affected ear then keep ear upward 5 minutes");
    expect(upward.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "keep-ear-upward" },
      args: [expect.objectContaining({ role: "duration", quantity: { value: 5, unit: "min" } })]
    });
    expect(formatSig(upward.fhir, "long", { locale: "th" })).toContain("ให้หูข้างที่หยอดอยู่ด้านบน 5 นาที");

    const dry = parseSig("3 drops affected ear tid x7d then keep ear dry");
    expect(dry.longText).toContain("Keep ear dry");
    expect(formatSig(dry.fhir, "long", { locale: "th" })).toContain("รักษาหูให้แห้ง");
  });

  it("codes the nasal septum while keeping aim-away technique procedural", () => {
    const parsed = parseSig("spray 2 sprays in each nostril daily aim away from septum");
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action?.predicate.lemma).toBe("aim-away-from");
    expect(action?.args).toContainEqual(expect.objectContaining({
      role: "site",
      coding: expect.objectContaining({ code: "68426009" })
    }));
    expect(parsed.longText).toContain("aim away from the nasal septum");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("เล็งออกจากผนังกั้นจมูก");
  });

  it("keeps multi-target topical text uncoded but bilingual instead of inventing one anatomy code", () => {
    const parsed = parseSig("apply thin layer to groin and axilla bid");
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(parsed.fhir.site?.text).toBe("groin and axilla");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ขาหนีบและรักแร้");

    const warning = parseSig("apply to rash avoid face and eyes");
    expect(formatSig(warning.fhir, "long", { locale: "th" }))
      .toContain("หลีกเลี่ยงบริเวณใบหน้าและดวงตา");
  });


  it.each([
    "take 1 tab at onset of migraine",
    "take 1 tab at migraine onset",
    "take 1 tab upon onset of migraine",
    "take 1 tab when migraine starts",
    "รับประทาน 1 เม็ดเมื่อเริ่มมีอาการไมเกรน",
    "รับประทาน 1 เม็ดเมื่อเริ่มปวดไมเกรน"
  ])("models symptom onset as coded PRN trigger truth: %s", (source) => {
    const parsed = parseSig(source, { locale: /[ก-๙]/.test(source) ? "th" : "en" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    const reason = parsed.meta.canonical.clauses[0]?.prn?.reason;
    expect(reason).toMatchObject({ triggerPhase: "onset", coding: { code: "37796009" } });
    expect(parsed.fhir.asNeededFor?.[0]?.extension).toContainEqual(expect.objectContaining({
      url: "https://solublelabs.com/fhir/StructureDefinition/medication-prn-trigger-phase",
      valueCode: "onset"
    }));
    expect(fromFhirDosage(parsed.fhir).meta.canonical.clauses[0]?.prn?.reason?.triggerPhase)
      .toBe("onset");
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("at onset of migraine");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("เมื่อเริ่มมีอาการไมเกรน");
  });

  it("composes onset trigger, compact repeat delay, condition and total max-dose cap", () => {
    const english = parseSig(
      "take 1 tab at onset of migraine repeat after 2h if needed max 2 doses"
    );
    expect(english.meta.leftoverText).toBeUndefined();
    expect(english.meta.canonical.clauses[0]?.schedule).toMatchObject({ count: 1, countMax: 2 });
    expect(english.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "repeat" },
      relation: "after",
      args: [expect.objectContaining({ role: "duration", quantity: { value: 2, unit: "h" } })]
    });
    expect(english.meta.canonical.clauses[0]?.instructionGraph?.relations).toContainEqual(
      expect.objectContaining({ kind: "if", text: "if needed" })
    );
    expect(formatSig(english.fhir, "long", { locale: "th" })).toContain("ถ้าจำเป็น");

    const thai = parseSig(
      "รับประทาน 1 เม็ดเมื่อเริ่มมีอาการไมเกรน กินซ้ำหลัง 2 ชั่วโมงถ้าจำเป็น ไม่เกิน 2 ครั้ง",
      { locale: "th" }
    );
    expect(thai.meta.canonical.clauses[0]?.prn?.reason).toMatchObject({
      triggerPhase: "onset", coding: { code: "37796009" }
    });
    expect(formatSig(thai.fhir, "long", { locale: "en" }))
      .toContain("repeat after 2 hours if needed");
  });

  it.each([
    ["apply 1 patch weekly x3w then 1 week off", "pause-use"],
    ["apply 1 patch weekly for 3 weeks then stop for 1 week", "stop"],
    ["take 1 tab daily x21d then 7 days off", "pause-use"],
    ["ใช้แผ่นแปะ 1 แผ่น สัปดาห์ละครั้ง 3 สัปดาห์ แล้วหยุด 1 สัปดาห์", "stop"]
  ] as const)("preserves a dependent off-period without inventing cyclic recurrence: %s", (source, action) => {
    const parsed = parseSig(source, { locale: /[ก-๙]/.test(source) ? "th" : "en" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    const pause = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.find(
      (candidate) => candidate.predicate.lemma === action
    );
    expect(pause?.args).toContainEqual(expect.objectContaining({
      role: "duration",
      quantity: expect.objectContaining({ value: expect.any(Number) })
    }));
    expect(parsed.meta.canonical.clauses[0]?.schedule?.periodUnit).toBeDefined();
  });


  it.each([
    ["shampoo at night, leave overnight", "NIGHT", "Shampoo at night; then leave on overnight.", "สระผมตอนกลางคืน จากนั้นทิ้งไว้ข้ามคืน."],
    ["สระผมตอนเย็น ทิ้งไว้ข้ามคืน", "EVE", "Shampoo in the evening; then leave on overnight.", "สระผมตอนเย็น จากนั้นทิ้งไว้ข้ามคืน."],
    ["สระผมก่อนนอน ทิ้งไว้ข้ามคืน", "HS", "Shampoo before bedtime; then leave on overnight.", "สระผมก่อนนอน จากนั้นทิ้งไว้ข้ามคืน."]
  ] as const)("keeps overnight retention procedural: %s", (source, when, en, th) => {
    const parsed = parseSig(source, { locale: /[ก-๙]/.test(source) ? "th" : "en" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).toEqual([when]);
    const leave = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.find(
      (action) => action.predicate.lemma === "leave"
    );
    expect(leave?.args).toContainEqual(expect.objectContaining({
      role: "duration", conceptId: "overnight", normalized: "overnight"
    }));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toBe(en);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(th);
  });

  it.each([
    ["shampoo hair at night and leave overnight, then wash in the morning",
      "Shampoo the hair at night; then leave on overnight; then wash in the morning.",
      "สระผมตอนกลางคืน จากนั้นทิ้งไว้ข้ามคืน จากนั้นล้างตอนเช้า."],
    ["สระผมตอนเย็น ทิ้งไว้ข้ามคืน แล้วสระออกตอนเช้า",
      "Shampoo in the evening; then leave on overnight; then wash out in the morning.",
      "สระผมตอนเย็น จากนั้นทิ้งไว้ข้ามคืน จากนั้นสระออกตอนเช้า."]
  ] as const)("keeps morning wash-out local to the follow-up procedure: %s", (source, en, th) => {
    const parsed = parseSig(source, { locale: /[ก-๙]/.test(source) ? "th" : "en" });
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.when).not.toContain("MORN");
    const cleanup = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.find((action) =>
      action.predicate.lemma === "wash-hair-out" ||
      (action.predicate.lemma === "wash" && action.args.some((arg) => arg.role === "time"))
    );
    expect(cleanup?.args).toContainEqual(expect.objectContaining({ role: "time", conceptId: "morning" }));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toBe(en);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe(th);
  });


  it("keeps interdigital regimen timing separate from a post-application caution", () => {
    const parsed = parseSig(
      "ทาระหว่างร่องนิ้ว วันละ 2 ครั้ง เช้า เย็น หลังทาไม่ควรทานอาหาร",
      { locale: "th" }
    );
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhir.site).toMatchObject({ text: "interdigital spaces" });
    expect(parsed.fhir.site?.coding).toBeUndefined();
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 2, period: 1, periodUnit: "d", when: ["MORN", "EVE"]
    });
    expect(parsed.fhir.timing?.repeat?.when).not.toContain("C");
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    const caution = graph?.actions.find((action) => action.predicate.lemma === "eat-food");
    expect(caution).toMatchObject({ polarity: "negate", modality: "should" });
    expect(graph?.relations).toContainEqual(expect.objectContaining({
      kind: "after", toActionIndex: caution?.sequenceIndex, text: "หลังทา"
    }));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("After application");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("หลังทา");
  });


  it.each(["sl", "sublingual"])("keeps explicit sublingual route outside procedural object: %s", (routeSurface) => {
    const parsed = parseSig(`dissolve 1 tab ${routeSurface} prn chest pain`);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.route?.code).toBe("37839007");
    expect(formatSig(parsed.fhir, "long", { locale: "en" }))
      .toBe("Dissolve 1 tablet sublingually as needed for chest pain.");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ใต้ลิ้น");
  });

  it("does not globally reinterpret anatomical under-tongue wording as sublingual route", () => {
    const parsed = parseSig("dissolve 1 tab under tongue prn chest pain");
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.route).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.sourceText)
      .toContain("under tongue");
  });

});
