import { describe, expect, it } from "vitest";
import { formatSig, fromFhir, fromFhirDosage, getTimingOccurrenceCap, nextDueDoses, parseSig as parseCompleteSig, TIMING_ACTIVITY_WINDOW_EXTENSION_URL, TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src";
import type { FhirDosage, FhirR6DosageInstruction } from "../src";
import { parseSig } from "./helpers/r5-parser";
import { BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL } from "../src/body-site-target";
import { deserializeCanonicalContext } from "../src/fhir";
import { TIMING_ADMINISTRATION_DURATION_EXTENSION_URL } from "../src/fhir";
import { TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { AdviceArgumentRole } from "../src/types";
import { AdviceForce } from "../src/types";
import { AdvicePolarity } from "../src/types";
import { AdviceRelation } from "../src/types";
import { EventTiming } from "../src/types";
import type { AdviceFrame } from "../src/types";
import type { FhirExtension } from "../src/types";
import type { MedicationCondition } from "../src/types";
import type { ParseOptions } from "../src/types";
import { buildInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import adviceRulesSource from "../src/advice-rules.json";
import { setDosageCondition } from "../src/dosage-course";
import { withDosageEditProvenance } from "../src/dosage-course";
import { getDosageSourceOwnership } from "../src/dosage-course";
import { DOSAGE_RENDERED_INSTRUCTION_R5_URL } from "../src/dosage-course";
import { realizeInstructionAction } from "../src/instruction-graph";
import { instructionGraphRichPrimaryAction } from "../src/instruction-graph";
import { instructionGraphRoundTripPrimaryAction } from "../src/instruction-graph";
import { instructionGraphSourceConflictsWithDose } from "../src/instruction-graph";
import { realizeRichPrimaryWithCanonicalDose } from "../src/instruction-graph";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { resolveSigLocalization } from "../src/i18n";
import { buildMedicationInstructionActionCodeSystem } from "../src/index";
import { buildMedicationInstructionConceptCodeSystem } from "../src/index";
import { getMedicationInstructionAction } from "../src/index";
import { getMedicationInstructionConcept } from "../src/index";
import { resolveMedicationInstructionConcept as resolvePublicConcept } from "../src/index";
import { parseInstructionActions } from "../src/index";
import { realizeInstructionGraph } from "../src/index";
import { getDosageCondition } from "../src/index";
import { toDosageDetails } from "../src/index";
import { toFhirR5Dosages } from "../src/index";
import { medicationInstructionActionCodings } from "../src/instruction-action-terminology";
import { resolveMedicationInstructionAction } from "../src/instruction-action-terminology";
import { resolveMedicationInstructionActionForMethod } from "../src/instruction-action-terminology";
import { resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import { medicationInstructionConceptCodings } from "../src/instruction-concept-terminology";
import { getMedicationInstructionConcept as getInternalInstructionConcept } from "../src/instruction-concept-terminology";
import { parseSigAsync } from "./helpers/r5-parser";
import { parseSig as parsePublicSig } from "../src/index";
import { calculateTotalUnits } from "../src/index";
import { importCanonicalCourse } from "../src/index";
import { projectCanonicalCourse } from "../src/index";
import { TIMING_OFFSET_MIN_EXTENSION_URL } from "../src/index";
import { TIMING_OFFSET_MAX_EXTENSION_URL } from "../src/index";

describe("OPD normalized realization and advanced schedule semantics", () => {
  it("realizes an HPSG-owned up-to date as one inclusive calendar bound", () => {
    const parsed = parseSig("apply cream to wound daily up to 30 Sep 2026", {
      locale: "en-GB",
      datePolicy: { referenceDate: "2026-09-27" }
    });

    expect(parsed.longText)
      .toBe("Apply the medication once daily through 30 Sep 2026 to the wound.");
    expect(parsed.fhir.timing).toEqual({
      repeat: {
        boundsPeriod: { end: "2026-09-30" },
        frequency: 1,
        period: 1,
        periodUnit: "d"
      }
    });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.boundsEnd).toBe("2026-09-30");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.evidence).toContainEqual(
      expect.objectContaining({
        rule: "hpsg.lex.schedule.calendarDateList",
        scheduleFields: ["boundsEnd"],
        spans: [expect.objectContaining({ text: "up to 30 Sep 2026" })]
      })
    );
  });

  it("preserves maximum source text and synthesizes useful text when source is absent", () => {
    const base: FhirDosage = {
      timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }]
    };
    const cases: Array<{
      maximum: Partial<Pick<FhirDosage, "maxDosePerAdministration" | "maxDosePerLifetime">>;
      source: string;
    }> = [
      {
        maximum: { maxDosePerAdministration: { value: 1, unit: "tab" } },
        source: "Take 1 tablet twice daily; maximum 1 tablet per administration"
      },
      {
        maximum: { maxDosePerLifetime: { value: 10, unit: "tab" } },
        source: "Take 1 tablet twice daily; maximum 10 tablets over the lifetime course"
      }
    ];

    for (const { maximum, source } of cases) {
      const dosage: FhirDosage = { ...base, ...maximum, text: source };
      const maximumText = maximum.maxDosePerAdministration
        ? "max per administration: 1 tab" : "max lifetime: 10 tab";
      const imported = fromFhirDosage({ ...dosage }, { locale: "th", realizationMode: "roundtrip" });
      for (const text of [formatSig(dosage, "short", { locale: "th", realizationMode: "roundtrip" }), imported.shortText])
        expect(text.split("; ข้อความเดิม: ")).toEqual([`ปัจจุบัน: 1 เม็ด วันละ 2 ครั้ง; ${maximumText}`, source]);
      for (const text of [formatSig(dosage, "long", { locale: "th", realizationMode: "roundtrip" }), imported.longText])
        expect(text.split("; ข้อความเดิม: ")).toEqual([`ปัจจุบัน: ใช้ 1 เม็ด วันละ 2 ครั้ง; ${maximumText}`, source]);
      expect(imported.fhir.text).toBe(source);

      const withoutSource: FhirDosage = { ...base, ...maximum };
      const normalized = fromFhirDosage({ ...dosage });
      expect(normalized.shortText).toBe(`Current: 1 tab 2x/d; ${maximumText}; original directions: ${source}`);
      expect(normalized.longText).toBe(`Current: Use 1 tablet twice daily; ${maximumText}; original directions: ${source}`);
      expect(normalized.fhir.text).toBe(source);
      expect(formatSig(dosage, "long")).toBe(`Current: Use 1 tablet twice daily; ${maximumText}; original directions: ${source}`);
      expect(formatSig(withoutSource, "long")).toBe(
        `Use 1 tablet twice daily; ${maximumText}`
      );
      const partial = fromFhirDosage({ ...withoutSource });
      expect(partial.shortText).toContain(maximumText);
      expect(partial.longText).toBe(`Use 1 tablet twice daily; ${maximumText}`);
      expect(partial.warnings).toEqual([]);
      expect(partial.fhir.text).toBeUndefined();
    }
  });

  it("keeps a source-less R6 safety course data-preserving with useful display text", () => {
    const details: FhirR6DosageInstruction = {
      step: [{ component: [{
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        safety: { doseLimit: [{
          scope: "administration", valueQuantity: { value: 1, unit: "tab" }
        }] }
      }] }]
    };

    const imported = fromFhir(details);
    expect(imported.longText)
      .toBe("Use 1 tablet twice daily; max per administration: 1 tab");
    expect(imported.shortText).toBe("1 tab 2x/d; max per administration: 1 tab");
    expect(imported.items[0]?.longText)
      .toBe("Use 1 tablet twice daily; max per administration: 1 tab");
    expect(imported.items[0]?.fhir.text).toBeUndefined();
    expect(imported.warnings).toEqual([]);
    expect(imported.fhirNext).toEqual(details);
  });

  it("keeps offsets scoped and carries ophthalmic state into step-down stages", () => {
    const mixed = parseSig("take 1 tab 30 min before meals and at bedtime");
    expect(mixed.count).toBe(2);
    expect(mixed.items[0].fhir.timing?.repeat).toMatchObject({ offset: 30, when: ["AC"] });
    expect(mixed.items[1].fhir.timing?.repeat).toMatchObject({ when: ["HS"] });
    expect(mixed.items[1].fhir.timing?.repeat?.offset).toBeUndefined();

    const eye = parseSig("1 drop od q1h while awake x2d then qid x5d");
    expect(eye.count).toBe(2);
    expect(eye.items.map((item) => item.fhir.site?.text)).toEqual(["right eye", "right eye"]);
    expect(eye.items[1].fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "drop" });
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
    expect(parsed.items.map((item) => item.fhir.doseAndRate?.[0]?.doseQuantity)).toMatchObject(
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

  it("treats terminal then-off as a typed discontinue instruction", () => {
    const source =
      "1 drop to ou q2h for 1 week, then q4h for 1 month, then qid for 2 weeks, " +
      "then tid for 2 weeks, then once daily for 1 month, then off";
    const parsed = parseSig(source);
    expect(parsed.count).toBe(5);
    expect(parsed.items.map((item) => item.meta.canonical.clauses[0]?.schedule?.timingCode)).toEqual([
      "Q2H", "Q4H", "QID", "TID", "QD"
    ]);
    const final = parsed.items[4];
    expect(final.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(final.meta.canonical.clauses[0]?.instructionGraph?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: expect.objectContaining({ lemma: "stop" }) })
      ])
    );
    expect(formatSig(final.fhir, "long", { locale: "th" })).toContain("หยุดใช้");
    expect(formatSig(final.fhir, "long", { locale: "th" })).not.toContain("Off");

    const bareOff = parseSig("off");
    expect(bareOff.meta.leftoverText).toBe("off");

    const boundedPause = parseSig("take 1 tab daily x21d then 7 days off");
    expect(boundedPause.meta.leftoverText).toBeUndefined();
    expect(boundedPause.meta.canonical.clauses.some((clause) =>
      clause.instructionGraph?.actions.some((action) => action.predicate.lemma === "pause-use")
    )).toBe(true);
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
    expect(total.fhir.timing?.repeat?.count).toBeUndefined();
    expect(total.fhir.timing?.repeat).toMatchObject({ countMax: 3, period: 5, periodUnit: "min" });
    expect(total.fhir.timing?.repeat?._count).toEqual({ extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown",
    }] });
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
    expect(reparsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "spray" });
    expect(reparsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(reparsed.fhir.site?.text).toBe("both nostrils");
  });

  it("normalizes Thai insulin ยูนิต through the shared unit terminology", () => {
    const parsed = parseSig("ฉีด 10 ยูนิต ใต้ผิวหนัง ก่อนนอน", { locale: "th" });
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 10, unit: "U" });
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

  it("keeps explicitly coordinated topical sites as separate, coded doses while preserving bilingual instructions", () => {
    const parsed = parseCompleteSig("apply thin layer to groin and axilla bid");
    expect(parsed.fhir).toHaveLength(2);
    expect(parsed.fhir.map(dose => dose.site?.text)).toEqual(["groin", "axilla"]);
    expect(parsed.fhir.every(dose => Boolean(dose.site?.coding?.[0]?.code))).toBe(true);
    expect(parsed.fhir.map(dose => dose.timing?.repeat?.frequency)).toEqual([2, 2]);
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(thai).toContain("ขาหนีบ");
    expect(thai).toContain("รักแร้");

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
      url: "urn:ezmedicationinput:StructureDefinition:medication-prn-trigger-phase",
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
    expect(english.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(english.meta.canonical.clauses[0]?.schedule).toMatchObject({ countMax: 2 });
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
    expect(thai.meta.canonical.clauses[0]?.schedule?.count).toBeUndefined();
    expect(thai.meta.canonical.clauses[0]?.schedule).toMatchObject({ countMax: 2 });
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


describe("round33 current rich-primary ownership", () => {
  it.each(["Apply", "Apply gently", "Reapply", "Reapply gently", "coding-only", "metadata"])("honors shared-code method identity %s", edit => {
    const source = "Reapply 1 g to the skin gently";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } }
    ];
    const graph = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 7 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== graph.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(graph);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    if (edit === "coding-only") delete saved.method.text;
    else if (edit === "metadata") { saved.method.id = "annotation"; saved.method.coding[0].id = "coding-annotation"; }
    else saved.method.text = edit;
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(edit.startsWith("Reapply") || edit === "metadata" ? /^Reapply\b/u : /^Apply\b/u);
      expect(text).toContain("1 g");
      expect(text).toContain("gently");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
  it.each([
    [false, "dose", true, false],
    [false, "explicit-false", true, false],
    [false, "add-delete", true, false],
    [true, "dose", true, false],
    [true, "metadata", true, false],
    [true, "replace", false, true],
    [true, "delete", false, false]
  ] as const)("keeps only current primary Site (structured %s, edit %s)", (structured, edit, right, left) => {
    const source = "Instill 1 drop into right eye";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args.push({ role: AdviceArgumentRole.Manner, text: "gently",
      normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } });
    const warning = parseInstructionActions("Do not touch right eye")[0];
    warning.span = { start: source.length + 2, end: source.length + 24 };
    warning.sequenceIndex = 1;
    const graph = buildInstructionGraphExtension({
      sourceText: source + "; Do not touch right eye", sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 7 }, actions: [primary, warning]
    })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== graph.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(graph);
    if (!structured) delete row.site;
    let saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source, true,
      edit === "explicit-false" ? [{ sourceAgreement: true, sourceHasStructuredSite: false }] : undefined)[0]));
    expect(getDosageSourceOwnership(saved)?.site).toBe(structured);
    if (edit !== "metadata") saved.doseAndRate[0].doseQuantity.value = 2;
    if (edit === "metadata") { saved.site.id = "site-annotation"; saved.site.coding[0].id = "coding-annotation"; }
    if (edit === "replace") saved.site = parsePublicSig("Instill 1 drop into left eye").fhir[0].site;
    if (edit === "delete") delete saved.site;
    if (edit === "add-delete") {
      saved.site = parsePublicSig("Instill 1 drop into left eye").fhir[0].site;
      // Saving an independent graph site alongside a later structured site
      // must not invent original structured ownership of that graph argument.
      saved = JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails([saved]))[0]));
      delete saved.site;
    }
    const before = JSON.stringify(saved), r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? edit === "metadata" ? "1 drop" : "2 drops" : edit === "metadata" ? "1 หยด" : "2 หยด");
        if (edit !== "metadata") expect(text).not.toMatch(locale === "en" ? /1 drop/u : /1 หยด/u);
        expect(text).toContain(locale === "en" ? "gently" : "เบาๆ");
        const primaryText = text.split(locale === "en" ? "Do not touch" : "ห้ามสัมผัส")[0];
        expect(primaryText.includes(locale === "en" ? "right eye" : "ตาขวา")).toBe(right);
        expect(primaryText.includes(locale === "en" ? "left eye" : "ตาซ้าย")).toBe(left);
        expect(text).toMatch(locale === "en" ? /Do not touch (?:the )?right eye/u : /ห้ามสัมผัสตาขวา/u);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});


describe("round33 declared method identity", () => {
  it.each(["unchanged", "metadata", "edited"])("keeps custom bound manner only for its current method (%s)", edit => {
    const source = "Swallow 1 tablet whole";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.actions[0].predicate.lemma = "local-swallow";
    const marker = buildInstructionGraphExtension(graph)!;
    row.extension = row.extension.filter((e: { url: string }) =>
      e.url !== marker.url && e.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    const options = { instructionActionMap: { swallow: {
      code: "local-swallow", display: "Swallow", semanticClass: "ingest",
      primaryAdministrationHead: true, methodBoundMannerConcepts: ["whole"],
      administrationMethod: { system: "http://snomed.info/sct", code: "738995006", display: "Swallow" }
    } } };
    if (edit === "metadata") saved.method.id = "annotation";
    if (edit === "edited") saved.method.coding[0] = {
      system: "http://snomed.info/sct", code: "738992009", display: "Chew"
    };
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
      expect(text).toContain("1 tablet");
      expect(text).toMatch(edit === "edited" ? /^Chew/u : /^Swallow/u);
      expect(text.includes("whole")).toBe(edit !== "edited");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});

describe("round33 joined-script method vocabulary bounds", () => {
  const swallow = { system: "http://snomed.info/sct", code: "738995006", display: "Swallow" };
  const chew = { system: "http://snomed.info/sct", code: "738992009", display: "Chew" };
  it("keeps an unfamiliar joined-script method source intact", () => {
    const source = "คำไม่รู้จัก".repeat(100);
    expect(resolveMedicationInstructionActionForMethod({ text: source, coding: swallow })).toBeUndefined();
  });
  it("honors long registered locale aliases and the longest matching lexical head", () => {
    const alias = "คำวิธีที่ลงทะเบียน".repeat(8);
    const options = { instructionActionMap: {
      "custom-swallow": { code: "custom-swallow", display: "Custom swallow",
        administrationMethod: swallow, localeAliases: { th: [alias] } },
      "custom-chew": { code: "custom-chew", display: "Custom chew",
        administrationMethod: chew, localeAliases: { th: [alias + "เพิ่ม"] } }
    } };
    // Compatible qualified source keeps its qualifiers, including aliases
    // longer than any default action. A conflicting current code still wins.
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "ช้า", coding: swallow }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "ช้า", coding: chew }, options)?.code).toBe("custom-chew");
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "เพิ่มช้า", coding: chew }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "เพิ่มช้า", coding: swallow }, options)?.code).toBe("custom-swallow");
  });
});


describe("round34 live method realization", () => {
  it.each(["Apply", "Rub"] as const)("keeps the live dose and compatible adjuncts for %s", method => {
    const source = "Rub 1 g into the skin gently to form foam";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to the skin gently").fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { en: "foam", th: "ฟอง" } }
    ];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 3 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    row.method = { text: "Rub", coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    if (method === "Apply") saved.method = { text: "Apply",
      coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    saved.doseAndRate[0].doseQuantity.value = 2;
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(method === "Apply" ? /^Apply\b/u : /^Rub\b/u);
      expect(text.match(/(?:^|[^\d.+/-])\+?2(?:\.0+)?\s+g\b/gu)).toHaveLength(1);
      expect(text).not.toMatch(/(?:^|[^\d.+/-])\+?1(?:\.0+)?\s+g\b/u);
      expect(text).toContain("skin");
      expect(text).toContain("gently");
      expect(text).toContain("foam");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });

  it.each([undefined, "Custom apply", "old display"])("resolves a declared custom method by exact code (%s)", display => {
    const options = { instructionActionMap: {
      "custom-apply": { code: "custom-apply", display: "Custom apply", primaryAdministrationHead: true,
        semanticClass: "apply", administrationMethod: { system: "urn:clinic:method", code: "apply-local" } }
    } };
    const method = { text: "Swallow", coding: { system: "urn:clinic:method", code: "apply-local", ...(display ? { display } : {}) } };
    const before = JSON.stringify(method);
    expect(resolveMedicationInstructionActionForMethod(method, options)?.code).toBe("custom-apply");
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      method: { text: method.text, coding: [method.coding] } };
    const text = formatSig(row, "long", { ...options, locale: "en", realizationMode: "normalized" });
    expect(text).toContain("Custom apply");
    expect(text).toContain("1 g");
    expect(text).not.toContain("Swallow");
    expect(JSON.stringify(method)).toBe(before);
    expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
      coding: { system: "urn:another:method", code: "apply-local" } }, options)?.code).toBe("swallow");
  });
});


it("round34: keeps display-selected custom method identity among equal coded definitions", () => {
  const coding = { system: "urn:clinic:method", code: "skin-application" };
  const options = { instructionActionMap: {
    "local-apply": { code: "local-apply", display: "Local apply", administrationMethod: coding },
    "local-rub": { code: "local-rub", display: "Local rub", administrationMethod: coding }
  } };
  expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
    coding: { ...coding, display: "local-rub" } }, options)?.code).toBe("local-rub");
  expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
    coding }, options)?.code).toBe("local-apply");
});


describe("round35 action realization ownership", () => {
  it("carries the resolved institution method into each locale without changing the source", () => {
    const options = { instructionActionMap: {
      "chew-slowly": { code: "chew-slowly", display: "Masticate", i18n: { th: "เคี้ยวช้าๆ" },
        primaryAdministrationHead: true,
        administrationMethod: { system: "urn:clinic:method", code: "chew-slowly" } }
    } };
    const row = { route: { text: "oral" }, method: { coding: [{ system: "urn:clinic:method", code: "chew-slowly" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const saved = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row])]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const english = formatSig(input, "long", { ...options, locale: "en", realizationMode });
      expect(english).toContain("Masticate");
      expect(english.match(/1 tablet/gu)).toHaveLength(1);
      const thai = formatSig(input, "long", { ...options, locale: "th", realizationMode });
      expect(thai).toContain("เคี้ยวช้าๆ");
      expect(thai.match(/1 เม็ด/gu)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(saved);
    expect(formatSig({ ...row, method: { coding: [{ system: "urn:other", code: "chew-slowly" }] } },
      "long", { ...options, locale: "th" })).toContain("รับประทาน");
  });

  it("keeps amount, result, manner and site together for a result-producing action", () => {
    const frame = parseInstructionActions("Rub 1 g onto the skin gently to form foam")[0];
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", i18n: { th: "ผิวหนัง" } },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { th: "ฟอง" } }
    ];
    const saved = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionAction(frame, locale);
      expect(text.match(/(?:^|[^\d.+/-])\+?1(?:\.0+)?\s+g\b/gu)).toHaveLength(1);
      for (const word of locale === "en" ? ["Rub", "skin", "gently", "foam"] : ["ถู", "ผิวหนัง", "เบาๆ", "ฟอง"])
        expect(text).toContain(word);
    }
    expect(JSON.stringify(frame)).toBe(saved);
  });

  it("uses event names for independent temporal arguments beside a material complement", () => {
    const frame = parseInstructionActions("Dilute 1 mL with 10 mL saline before each dose")[0];
    frame.args = frame.args.filter(arg => arg.role !== AdviceArgumentRole.Activity && arg.role !== AdviceArgumentRole.Time);
    frame.args.push({ role: AdviceArgumentRole.Time, text: "breakfast", normalized: "CM", relation: AdviceRelation.Before });
    const saved = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionAction(frame, locale);
      expect(text).toContain("saline");
      expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(text).not.toContain("CM");
      expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
      expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
    }
    expect(JSON.stringify(frame)).toBe(saved);
  });
});

describe("round36 configured identity and active cadence", () => {
  it.each([1, 2])("keeps the current %s-day period authoritative in both locales", period => {
    const r6 = { step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QOD" }] },
        repeat: { period, periodUnit: "d" as const } } }] }] };
    const before = JSON.stringify(r6);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const text = formatSig(r6, style, { locale, realizationMode: "normalized" });
      if (period === 1) {
        expect(text).not.toMatch(/other day|QOD|วันเว้นวัน/u);
        expect(text).toContain(locale === "th" ? "ทุกวัน" : style === "short" ? "Q1D" : "daily");
        expect(text).not.toMatch(/once daily|วันละครั้ง/u);
      } else expect(text).toContain(locale === "th" ? "วันเว้นวัน" : style === "short" ? "QOD" : "every other day");
    }
    expect(JSON.stringify(r6)).toBe(before);
  });

  it("selects a custom method's configured display without making that display a parser alias", () => {
    const coding = { system: "urn:clinic:method", code: "shared-preparation" };
    const options = { instructionActionMap: {
      first: { code: "first", display: "First preparation", i18n: { th: "เตรียมแรก" }, primaryAdministrationHead: true, administrationMethod: coding },
      bedside: { code: "bedside", display: "Bedside preparation", i18n: { th: "เตรียมข้างเตียง" }, primaryAdministrationHead: true, administrationMethod: coding },
    } };
    const method = { coding: { ...coding, display: "Bedside preparation" } };
    expect(resolveMedicationInstructionActionForMethod(method, options)?.code).toBe("bedside");
    expect(resolveMedicationInstructionActionForMethod({ coding }, options)?.code).toBe("first");
    expect(resolveMedicationInstructionAction("Bedside preparation", options)).toBeUndefined();
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], method: { coding: [method.coding] } };
    for (const input of [row, toDosageDetails([row])])
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" })).toContain("เตรียมข้างเตียง");
  });

  it("preserves authored Coding metadata supplied by the concept vocabulary", () => {
    const coding = { system: "urn:clinic:activity", code: "physio", userSelected: false,
      _code: { id: "code-note" }, _userSelected: { id: "selected-note" },
      extension: [{ url: "urn:activity:note", valueString: "preserve" }] };
    const options = { instructionConceptMap: { physiotherapy: {
      role: AdviceArgumentRole.Activity, display: "physiotherapy", coding
    } } };
    const before = JSON.stringify(options);
    const parsed = parsePublicSig("Take 1 tablet before physiotherapy", options);
    expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming?.[0].activity.coding).toMatchObject(coding);
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(rows)));
      const current = courseFromR6(reopened).stages[0].administrations[0]
        .schedule?.recurrence?.activityTiming?.[0].activity.coding;
      expect(current).toEqual(coding);
    }
    expect(JSON.stringify(options)).toBe(before);
  });

  it("uses the authored in relation for the mix action's time complement", () => {
    const frame = parseInstructionActions("Mix in the morning")[0];
    const before = JSON.stringify(frame);
    expect(realizeInstructionAction(frame, "en")).toBe("Mix in the morning");
    const thai = realizeInstructionAction(frame, "th");
    expect(thai).toContain("ผสม");
    expect(thai).toContain("ตอนเช้า");
    expect(thai).not.toContain("เวลา");
    expect(JSON.stringify(frame)).toBe(before);
  });
});


describe("round36 rich primary rendered argument ownership", () => {
  it.each(["result", "default"] as const)("keeps the edited dose and exactly one morning instruction with the %s realizer", realizer => {
    const source = "Rub 1 g into the skin gently to form foam in the morning";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to the skin in the morning").fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.predicate.realizer = realizer;
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { en: "foam", th: "ฟอง" } },
      { role: AdviceArgumentRole.Time, text: "the morning", normalized: EventTiming.Morning, i18n: { en: "the morning", th: "ตอนเช้า" } }
    ];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 3 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    row.method = { text: "Rub", coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    saved.doseAndRate[0].doseQuantity.value = 2;
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(locale === "en" ? /morning/gu : /เช้า/gu)).toHaveLength(1);
      expect(text).toContain(locale === "en" ? "foam" : "ฟอง");
      expect(text).toContain(locale === "en" ? "gently" : "เบาๆ");
      expect(text.match(/(?:^|[^0-9.,+-])2 g\b/gu)).toHaveLength(1);
      expect(text).not.toMatch(/(?:^|[^0-9.,+-])1 (?:g|กรัม)(?![\p{L}\p{N}])/u);
    }
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("shows the current restricted primary site once while retaining an independent action site and saved wording", () => {
    const source = "Apply 1 g to the skin gently";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } }
    ];
    const warning = parseInstructionActions("Do not touch right eye")[0];
    warning.span = { start: source.length + 2, end: source.length + 24 };
    warning.sequenceIndex = 1;
    const marker = buildInstructionGraphExtension({ sourceText: source + "; Do not touch right eye", sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 5 }, actions: [primary, warning] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    saved.site = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to skin where skin is red").fhir[0].site));
    saved.site.extension[0].extension.find((x: { url: string }) => x.url === "predicateText").valueString = "skin is itchy";
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en.match(/to the skin where skin is itchy/gu)).toHaveLength(1);
      expect(en.match(/skin is itchy/gu)).toHaveLength(1);
      expect(en).toContain("gently");
      expect(en).toMatch(/Do not touch (?:the )?right eye/u);
      expect(en.match(/right eye/gu)).toHaveLength(1);
      expect(th.match(/ผิวหนัง/gu)).toHaveLength(1);
      expect(th.match(/skin is itchy/gu)).toHaveLength(1);
      expect(th).toContain("เบาๆ");
      expect(th).toContain("ห้ามสัมผัสตาขวา");
      expect(en + th).not.toContain("skin is red");
    }
    expect(JSON.stringify(saved)).toBe(before);
    expect(before).toContain("where skin is red");
    expect(parseInstructionGraphExtension(saved.extension)?.sourceText).toBe(source + "; Do not touch right eye");
  });

  it("omits only the covered amountless primary when preparation owns the amount", () => {
    const source = "Dissolve 2 tablets in water, then drink";
    const clause = parsePublicSig(source).meta.canonical.clauses[0];
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      // This saved span-only fixture retains the amountless head that the
      // parser can omit. Its action array has its own legacy ownership.
      ...clause.instructionGraph!, primaryOwnership: undefined, actions: parseInstructionActions(source)
    })!])!;
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["dissolve", "drink"]);
    const before = JSON.stringify(graph);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(graph, locale, { omitCanonicalAdministration: clause })!;
      if (locale === "en") expect(text).toBe("Dissolve 2 tablets in water");
      else expect(text).toMatch(/^ละลาย\s?2 เม็ดในน้ำ$/u);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("retains an amountless primary's independent manner when canonical administration does not cover it", () => {
    const source = "Dissolve 2 tablets in water, then drink slowly";
    const clause = parsePublicSig("Dissolve 2 tablets in water, then drink").meta.canonical.clauses[0];
    const actions = parseInstructionActions(source);
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...actions[1].span } };
    const text = realizeInstructionGraph(graph, "en", { omitCanonicalAdministration: clause })!;
    expect(text).toContain("Dissolve 2 tablets in water");
    expect(text).toMatch(/drink slowly/iu);
  });
});


describe("round36 selected Time output evidence", () => {
  it.each([
    ["Remove patch before breakfast", "before breakfast", /before breakfast/gu, /ก่อนอาหารเช้า/gu],
    ["Hold the eyelid in the morning", "in the morning", /morning/gu, /เช้า/gu]
  ] as const)("reports the selected locale realizer's emitted event: %s", (source, scheduleText, english, thai) => {
    const frame = parseInstructionActions(source)[0];
    const clause = parsePublicSig(scheduleText).meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text.match(locale === "en" ? english : thai)).toHaveLength(1);
      expect(coverage.singleScheduledEvent).toBe(true);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });

  it("does not report an unrendered Time when a relation realizer selects Duration", () => {
    const frame = parseInstructionActions("Remove patch after 8 hours")[0];
    frame.args.push({ role: AdviceArgumentRole.Time, text: "the morning", normalized: EventTiming.Morning,
      i18n: { en: "the morning", th: "ตอนเช้า" } });
    const clause = parsePublicSig("in the morning").meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text).toContain(locale === "en" ? "8 hours" : "8 ชั่วโมง");
      expect(text).not.toMatch(/morning|เช้า/u);
      expect(coverage.singleScheduledEvent).toBe(false);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });

  it("reports an independent event adjunct appended after a material realizer", () => {
    const frame = parseInstructionActions("Dilute 1 mL with 10 mL saline before each dose")[0];
    frame.args = frame.args.filter(arg => arg.role !== AdviceArgumentRole.Activity && arg.role !== AdviceArgumentRole.Time);
    frame.args.push({ role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast, relation: AdviceRelation.Before });
    const clause = parsePublicSig("before breakfast").meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
      expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
      expect(coverage.singleScheduledEvent).toBe(true);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });
});


describe("round36 live predicate and explicit amountless primary controls", () => {
  it("uses the current predicate from fresh submitted wire restrictions in both locales", () => {
    const source = "Apply 1 g to skin where skin is red daily max 2 g/day";
    const row = structuredClone(parsePublicSig(source).fhir[0]);
    for (const locale of ["en", "th"])
      formatSig(structuredClone(row), "long", { locale, realizationMode: "roundtrip" });
    const restriction = row.site!.extension!.find(item => item.url.endsWith("medication-body-site-restriction"))!;
    restriction.extension!.find(item => item.url === "predicateText")!.valueString = "skin is itchy";
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails(JSON.parse(JSON.stringify([row])))])
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/skin is itchy/gu)).toHaveLength(1);
        expect(text).not.toContain("skin is red");
        expect(text).toMatch(locale === "en" ? /to the skin where skin is itchy/u : /ผิวหนัง.*skin is itchy/u);
        expect(text).toMatch(locale === "en" ? /1 g/u : /1 (?:g|กรัม)/u);
      }
    expect(row.text).toBe(source);
    expect(restriction.extension!.find(item => item.url === "sourceText")!.valueString).toBe("where skin is red");
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["Drink, then dissolve 2 tablets in water, then drink", "Dissolve 2 tablets in water, then drink", /2 tablets in water/u],
    ["Drink, then wait 1 hour, then drink", "Drink", /1 hour/u]
  ] as const)("retains the independent earlier amountless action: %s", (source, primaryText, retainedStep) => {
    const actions = parseInstructionActions(source);
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...actions[actions.length - 1].span }
    })!])!;
    const clause = parsePublicSig(primaryText).meta.canonical.clauses[0];
    const before = JSON.stringify(graph);
    const text = realizeInstructionGraph(graph, "en", { omitCanonicalAdministration: clause })!;
    expect(text.match(/drink/giu)).toHaveLength(1);
    expect(text).toMatch(/^Drink[;,]/u);
    expect(text).toMatch(retainedStep);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("round37 action participant and method ownership", () => {
  it.each([AdviceRelation.With, undefined])("keeps spanless participant quantities only when independently related (%s)", relation => {
    const source = "Take 1 tablet with 1 tablet of folic acid";
    const frame = parseInstructionActions("Take 1 tablet with water")[0];
    frame.sourceText = source;
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", normalized: "tab", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Object, text: "1 tablet of folic acid", normalized: "folic acid",
        relation, quantity: { value: 1, unit: "tab" } }
    ];
    const graph = { sourceText: source, sourceLocale: "en", actions: [frame], primaryAdministrationSpan: frame.span };
    const row = { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      method: { text: "Take" }, extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(text).toContain("folic acid");
        if (relation) expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
        else expect(text).not.toMatch(/1 (?:tablets?|เม็ด)(?![\p{L}\p{N}])/u);
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(parseInstructionGraphExtension(row.extension)?.actions[0].args[1].quantity).toEqual({ value: 1, unit: "tab" });
  });

  it.each([false, true])("retains a saved Mix Theme's quantity wording (complete %s)", complete => {
    const frame = parseInstructionActions("Mix powder with water")[0];
    frame.sourceText = "";
    frame.args.unshift({ role: AdviceArgumentRole.Theme,
      text: complete ? "2 g of powder" : "up to the prescribed amount of powder",
      normalized: "powder", quantity: complete ? { value: 2, unit: "g" } : { comparator: "<=", unit: "g" } });
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const before = JSON.stringify(graph);
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, recovered]) for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(candidate, locale)!;
      expect(text).toContain(complete ? locale === "en" ? "2 g of powder" : "powder 2 g"
        : "up to the prescribed amount of powder");
      expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      if (complete) expect(text).toContain("powder");
    }
    const row = { extension: [buildInstructionGraphExtension(graph)!] };
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(complete ? locale === "en" ? "2 g of powder" : "powder 2 g"
        : "up to the prescribed amount of powder");
        expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("uses the selected Time's before relation when the Mix frame says after", () => {
    const frame = parseInstructionActions("Mix powder after breakfast")[0];
    frame.sourceText = "";
    frame.relation = AdviceRelation.After;
    frame.args = [
      { role: AdviceArgumentRole.Theme, text: "powder", normalized: "powder" },
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming["Before Breakfast"],
        relation: AdviceRelation.Before, i18n: { en: "breakfast", th: "อาหารเช้า" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const before = JSON.stringify(graph);
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, recovered]) for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(candidate, locale)!;
      expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
      expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
    }
    const row = { extension: [buildInstructionGraphExtension(graph)!] };
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
        expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("selects a request's custom method before a recognized default through public imports", () => {
    const coding = { system: "urn:clinic:method", code: "chew-slowly" };
    const options = { realizationMode: "normalized" as const, instructionActionMap: {
      "chew-slowly": { code: "chew-slowly", display: "Chew slowly", i18n: { th: "เคี้ยวช้าๆ" },
        primaryAdministrationHead: true, administrationMethod: coding }
    } };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      method: { coding: [coding, { system: "http://snomed.info/sct", code: "738992009", display: "Chew" }] } };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { ...options, locale });
        expect(text).toContain(locale === "en" ? "Chew slowly" : "เคี้ยวช้าๆ");
        expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
      }
      expect(fromFhirDosage(row, { ...options, locale: "en" }).longText).toContain("Chew slowly");
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(formatSig(row, "long", { locale: "en", realizationMode: "normalized" })).toContain("Chew 1 tablet");
  });
});

describe("round37 rendered primary action identity", () => {
  it.each([false, true])("renders an imported Mix primary once and retains an independent Drink (structured amount %s)", structured => {
    const frame = parseInstructionActions("Mix powder with water")[0];
    frame.sourceText = "";
    const theme = { role: AdviceArgumentRole.Theme,
      text: structured ? "2 g of powder" : "up to the prescribed amount of powder",
      normalized: "powder", quantity: structured ? { value: 2, unit: "g" } : { comparator: "<=" as const, unit: "g" } };
    frame.args.unshift(theme);
    if (structured) frame.args.push({ role: AdviceArgumentRole.Amount, text: "2 g", normalized: "g",
      quantity: { value: 2, unit: "g" } });
    const independent = parseInstructionActions("Drink 5 mL")[0];
    independent.span = { start: frame.span.end + 7, end: frame.span.end + 17 };
    independent.sequenceIndex = 1;
    const graph = { sourceText: "Mix the prescribed powder with water, then drink 5 mL", sourceLocale: "en",
      primaryAdministrationSpan: frame.span, actions: [frame, independent] };
    const row = { method: { text: "Mix" }, extension: [buildInstructionGraphExtension(graph)!],
      ...(structured ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }] } : {}) };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"])
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(locale === "en" ? /mix/giu : /ผสม/gu)).toHaveLength(1);
          expect(text.match(locale === "en" ? /drink/giu : /ดื่ม/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "5 mL" : "5 มิลลิลิตร");
          expect(text.match(/up to the prescribed amount of powder/gu)?.length ?? 0).toBe(structured ? 0 : 1);
          if (structured) expect(text.match(/(?:^|\D)2 g/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "with water" : "กับน้ำ");
        }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("round38 live dose and action participant ownership", () => {
  it.each([10, 2.5])("uses a freshly submitted scalar weight dose of %s without replaying the old amount", value => {
    const source = "Take 5 mg/kg once daily";
    const parsed = parsePublicSig(source);
    const fresh = structuredClone(parsed.fhir[0]!);
    expect(formatSig(structuredClone(fresh), "long")).toBe(source);
    fresh.doseAndRate![0].doseQuantity!.value = value;
    for (const input of [fresh, JSON.parse(JSON.stringify(toFhirR5Dosages([fresh])))]) {
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale });
        expect(text).toContain(value + " mg/kg");
        expect(text).not.toMatch(/(?:^|[^0-9.])5 mg\/kg/u);
      }
    }
    expect(fresh.text).toBe(source);
  });

  it.each([false, true])("keeps the medication dose with powder and its separate water quantity (%s)", measuredWater => {
    const frame = parseInstructionActions("Mix powder with " + (measuredWater ? "100 mL water" : "water"))[0];
    frame.sourceText = "";
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const row = { method: { text: "Mix" }, doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }],
      extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    const course = toDosageDetails([row]);
    for (const input of [row, course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain("2 g of powder");
      expect(english).toContain(measuredWater ? "with 100 mL water" : "with water");
      expect(english.match(/2 g/gu)).toHaveLength(1);
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("powder 2 g");
      expect(thai).toContain(measuredWater ? "กับน้ำ 100 มิลลิลิตร" : "กับน้ำ");
      expect(thai.match(/2 g/gu)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([AdviceRelation.Before, AdviceRelation.After])("uses the selected Time relation in the default realizer (%s)", relation => {
    const frame = parseInstructionActions("Swallow 1 tablet after breakfast")[0];
    frame.sourceText = "";
    frame.relation = relation === AdviceRelation.Before ? AdviceRelation.After : AdviceRelation.Before;
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" },
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming["Breakfast"],
        relation, i18n: { en: "breakfast", th: "อาหารเช้า" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const event = relation === AdviceRelation.Before ? EventTiming["Before Breakfast"] : EventTiming["After Breakfast"];
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [event] } }, extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row]), JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain(relation + " breakfast");
      expect(english).not.toContain(frame.relation + " breakfast");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain(relation === AdviceRelation.Before ? "ก่อนอาหารเช้า" : "หลังอาหารเช้า");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("does not hide a live with-lunch event behind a saved after-lunch relation", () => {
    const frame = parseInstructionActions("Swallow 1 tablet after lunch")[0];
    frame.sourceText = "";
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" },
      { role: AdviceArgumentRole.Time, text: "lunch", normalized: "lunch",
        relation: AdviceRelation.After, i18n: { en: "lunch", th: "อาหารกลางวัน" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming["Lunch"]] } }, extension: [buildInstructionGraphExtension(graph)!] };
    for (const input of [row, toDosageDetails([row]), JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("with lunch");
      expect(english).not.toContain("after lunch");
      expect(thai).toContain("พร้อมอาหารกลางวัน");
      expect(thai).not.toContain("หลังอาหารกลางวัน");
    }
    expect(parseInstructionGraphExtension(row.extension)!.actions[0].args[2].relation).toBe(AdviceRelation.After);
  });
});

describe("round38 configured terminology retains authored identity", () => {
  const translation = (text: string) => ({ extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/translation",
    extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: text }]
  }] });

  it("preserves a wire method translation with an empty or unrelated action map", () => {
    const row = { method: { text: "Chew", _text: translation("เคี้ยวให้ละเอียด") },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    for (const instructionActionMap of [undefined, {}, { local: { code: "local", display: "Local" } }]) {
      for (const input of [row, toDosageDetails([row]), toFhirR5Dosages([row])])
        expect(formatSig(input, "long", { locale: "th", instructionActionMap })).toContain("เคี้ยวให้ละเอียด");
    }
    expect(formatSig(row, "long", { locale: "th", instructionActionMap: {
      chew: { code: "local-chew", display: "Chew", i18n: { th: "เคี้ยวช้าๆ" } }
    } })).toContain("เคี้ยวช้าๆ");
  });

  it("keeps an authored method alias and its annotations for the same custom identity", () => {
    const coding = { system: "urn:clinic:method", code: "apply" };
    const method = { text: "dab on", _text: { id: "authored-alias", ...translation("แต้มให้ทั่ว") }, coding: [coding] };
    const options = { instructionActionMap: {
      apply: { code: "local-apply", display: "Apply", aliases: ["dab on"], administrationMethod: coding }
    } };
    const clause = deserializeCanonicalContext({ method }, options);
    expect(clause.method?.text).toBe("dab on");
    expect(clause.method?._text).toEqual(method._text);
    const imported = fromFhirDosage({ method }, options);
    expect(imported.meta.normalized.method?.text).toBe("dab on");
    expect(imported.fhir.method?._text).toEqual(method._text);
    const changed = deserializeCanonicalContext({ method: { ...method,
      coding: [{ system: "http://snomed.info/sct", code: "738992009", display: "Chew" }] } }, options);
    expect(changed.method?.text).toBe("Chew");
    expect(changed.method?._text).toBeUndefined();
  });

  it("keeps custom coding identity and annotations from plain inputs", () => {
    const coding = { id: "saline-annotation", version: "v2",
      system: "urn:clinic:fluid", code: "saline", display: "Custom saline" };
    const actions = parseInstructionActions("Mix powder with saline", 0, {
      instructionConceptMap: { saline: { code: "clinic-saline", role: AdviceArgumentRole.Substance,
        display: "saline", coding } }
    });
    const graph = { sourceText: "Mix powder with saline", sourceLocale: "en", actions };
    const saved = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, saved]) {
      expect(candidate.actions[0].args.find(arg => arg.conceptId === "clinic-saline")?.coding).toMatchObject({
        system: "urn:clinic:fluid", code: "saline", display: "Custom saline", id: "saline-annotation", version: "v2"
      });
    }
  });
});

describe("round38 upper daily frequency short preview", () => {
  it.each([undefined, 1])("retains an upper-only daily frequency with period %s", period => {
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequencyMax: 2, periodUnit: "d", ...(period === undefined ? {} : { period }) } } };
    for (const input of [row, toDosageDetails([row]), toFhirR5Dosages([row])]) {
      expect(formatSig(input, "short")).toContain(period === undefined ? "<=2x/d" : "<=2x/1d");
      expect(formatSig(input, "long")).toContain("up to 2 times daily");
    }
  });
  it.each([{ frequency: 2, expected: "2x/d" }, { frequency: 1, frequencyMax: 2, expected: "1-2x/d" }])("keeps exact and ranged daily counts", repeat => {
    const row = { timing: { repeat: { frequency: repeat.frequency, frequencyMax: repeat.frequencyMax, periodUnit: "d" } } };
    expect(formatSig(row, "short")).toBe(repeat.expected);
  });
});

describe("round38 selected-Time relation across action realizers", () => {
  it.each([
    "Chew 1 tablet after breakfast",
    "Rinse skin after breakfast",
    "Keep dressing after breakfast",
    "Remove patch after breakfast"
  ])("keeps the selected relation through saved graph realization: %s", source => {
    const original = parseInstructionActions(source)[0];
    for (const polarity of [AdvicePolarity.Affirm, AdvicePolarity.Negate]) {
      const frame = { ...original, sourceText: "", relation: AdviceRelation.After, polarity,
        args: [...original.args.filter(arg => arg.role !== AdviceArgumentRole.Time), {
          role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
          relation: AdviceRelation.Before, i18n: { en: "breakfast", th: "อาหารเช้า" }
        }] };
      const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
      const marker = buildInstructionGraphExtension(graph)!;
      const recovered = parseInstructionGraphExtension([marker])!;
      for (const input of [graph, recovered]) for (const locale of ["en", "th"]) {
        const text = realizeInstructionGraph(input, locale)!;
        expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
        expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
        expect(locale === "en" ? /^Do not /iu.test(text) : text.startsWith("ห้าม"))
          .toBe(polarity === AdvicePolarity.Negate);
      }
      for (const locale of ["en", "th"]) {
        const text = formatSig({ extension: [marker] }, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
        expect(locale === "en" ? /^Do not /iu.test(text) : text.startsWith("ห้าม"))
          .toBe(polarity === AdvicePolarity.Negate);
      }
    }
  });
});

describe("round38 configured source surfaces and stored action codes", () => {
  it.each([false, true])("keeps colliding lexical and code namespaces independent of map order (%s)", reversed => {
    const chew = getMedicationInstructionAction("chew")!;
    const ordinary = { ...chew, code: "masticate", aliases: [], display: "Chew",
      i18n: { th: "เคี้ยว" } };
    const slowly = { ...chew, code: "chew-slowly", aliases: [], display: "Chew slowly",
      i18n: { th: "เคี้ยวช้าๆ" } };
    const options = { instructionActionMap: reversed
      ? { masticate: slowly, chew: ordinary } : { chew: ordinary, masticate: slowly } };
    for (const [surface, code, english, thai] of [
      ["Chew", "masticate", "Chew 1 tablet", "เคี้ยว"],
      ["Masticate", "chew-slowly", "Chew slowly 1 tablet", "เคี้ยวช้าๆ"]
    ]) {
      const actions = parseInstructionActions(surface + " 1 tablet", 0, options);
      expect(actions).toHaveLength(1);
      expect(actions[0].predicate.lemma).toBe(code);
      expect(getMedicationInstructionAction(code, options)?.code).toBe(code);
      const graph = { sourceText: "", sourceLocale: "en", actions };
      const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
      expect(recovered.actions[0].predicate.lemma).toBe(code);
      expect(realizeInstructionGraph(recovered, "en")).toContain(english);
      const savedThai = realizeInstructionGraph(recovered, "th");
      expect(savedThai).toContain(thai);
      if (code === "masticate") expect(savedThai).not.toContain("เคี้ยวช้าๆ");
      const parsed = parsePublicSig(surface + " 1 tablet daily", options);
      expect(parsed.longText).toContain(english);
      for (const input of [parsed.fhirNext, parsed.fhir,
        JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhir)))]) {
        const englishText = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
        expect(englishText).toContain(english);
        const thaiText = formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" });
        expect(thaiText).toContain(thai);
        if (code === "masticate") expect(thaiText).not.toContain("เคี้ยวช้าๆ");
      }
    }
    expect(resolveMedicationInstructionAction("chew-slowly", options)).toBeUndefined();
    expect(resolveMedicationInstructionAction("chew-slowly", options, true)?.code).toBe("chew-slowly");
  });
});

describe("round38 procedural Object owns its authored amount", () => {
  it.each(["tab", "tablet"])("keeps one authored %s dose and retires it after a wire edit", unit => {
    const parsed = parsePublicSig("dissolve 1 " + unit + " under tongue prn chest pain");
    expect(parsed.longText).toBe("Dissolve 1 " + unit + " under tongue as needed for chest pain.");
    expect(parsed.longText.match(/\b1 tab(?:let)?\b/gu)).toHaveLength(1);
    const row = JSON.parse(JSON.stringify(parsed.fhir[0]));
    row.doseAndRate[0].doseQuantity.value = 2;
    for (const input of [row, JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain("2 tablets");
      expect(text).toContain("under tongue");
      expect(text).not.toMatch(/\b1 tab(?:let)?\b/u);
      expect(text.match(/2 tablets/gu)).toHaveLength(1);
    }
  });
});


describe("round39 independent graph arguments and current conditions", () => {
  it.each([[false, false], [true, false], [true, true]])(
    "renders every independent dilution adjunct once (endpoint %s, schedule %s)", (endpoint, scheduled) => {
    const frame = parseInstructionActions("Dilute 1 mL with saline to 10 mL before each dose")[0];
    frame.sourceText = "";
    frame.args[frame.args.length - 1] = {
      role: AdviceArgumentRole.Activity, text: "each dose", normalized: "each dose",
      relation: AdviceRelation.Before, i18n: { en: "each dose", th: "แต่ละครั้ง" }
    };
    if (endpoint) frame.args.push({
      role: AdviceArgumentRole.Result, text: "clear", normalized: "clear",
      relation: AdviceRelation.Until, i18n: { en: "clear", th: "ใส" }
    });
    const row = {
      ...(scheduled ? { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" as const } } } : {}),
      extension: [buildInstructionGraphExtension({
        sourceText: "", sourceLocale: "en", actions: [frame]
      })!]
    };
    const original = JSON.stringify(row);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Dilute 1 mL with saline to 10 mL");
      expect(en.match(/before each dose/gu)).toHaveLength(1);
      expect(en.match(/until clear/gu) ?? []).toHaveLength(endpoint ? 1 : 0);
      expect(th.match(/ก่อนแต่ละครั้ง/gu)).toHaveLength(1);
      expect(th.match(/จนกว่าใส/gu) ?? []).toHaveLength(endpoint ? 1 : 0);
      expect(en.includes("once daily")).toBe(scheduled);
      expect(th.includes("วันละครั้ง")).toBe(scheduled);
      if (endpoint) {
        expect(en.indexOf("before each dose")).toBeLessThan(en.indexOf("until clear"));
        expect(th.indexOf("ก่อนแต่ละครั้ง")).toBeLessThan(th.indexOf("จนกว่าใส"));
      }
    }
    expect(JSON.stringify(row)).toBe(original);
    expect(parseInstructionGraphExtension(row.extension)!.actions[0].args)
      .toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Activity, relation: AdviceRelation.Before }));
  });

  it.each([false, true])("keeps a rich primary's graph-only condition once (postposed %s)", postposed => {
    const source = "Swallow 1 tablet whole with 200 mL water";
    const condition = "if able to swallow";
    const frame = parseInstructionActions(source)[0];
    const offset = postposed ? 0 : condition.length + 2;
    frame.sourceText = "";
    frame.span = { start: offset, end: offset + source.length };
    const conditionStart = postposed ? source.length + 1 : 0;
    const graph = {
      sourceText: postposed ? source + " " + condition : condition + ", " + source,
      sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: condition,
        span: { start: conditionStart, end: conditionStart + condition.length } }]
    };
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [buildInstructionGraphExtension(graph)!] };
    const original = JSON.stringify(row);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/if able to swallow/giu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /swallow 1 tablet/giu : /กลืน 1 เม็ด/gu)).toHaveLength(1);
        if (locale === "en") expect(text).toMatch(postposed
          ? /^Swallow 1 tablet[^.!?]* if able to swallow\.$/u
          : /^If able to swallow, swallow 1 tablet/u);
        expect(text).toContain(locale === "en" ? "200 mL water" : "200 มิลลิลิตรน้ำ");
      }
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([
    ["Mix the tablet with water", "Mix tablet with water", "ผสมยาเม็ดกับน้ำ"],
    ["Mix the tablet with 100 mL water", "Mix tablet with 100 mL water", "ผสมยาเม็ดกับน้ำ 100 มิลลิลิตร"],
    ["Mix the tablet with milk", "Mix tablet with milk", "ผสมยาเม็ดกับmilk"],
    ["Mix with the tablet", "Mix with tablet", "ผสมด้วยยาเม็ด"],
    ["Dissolve 1 tablet in water", "Dissolve 1 tablet in water", "ละลาย1 เม็ดในน้ำ"]
  ])("keeps the head object and its companion distinct: %s", (source, english, thai) => {
    const parsed = parsePublicSig(source);
    const original = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(english + ".");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai + ".");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(original);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    if (source.startsWith("Mix the tablet")) {
      expect(graph.actions[0].args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Object, conceptId: "medication-tablet"
      }));
      expect(graph.actions[0].args.find(arg => arg.conceptId === "medication-tablet")!.relation).toBeUndefined();
      const vehicle = graph.actions[0].args.find(arg => source.endsWith("milk")
        ? arg.text === "milk" : arg.conceptId === "water");
      expect(vehicle?.relation).toBe(AdviceRelation.With);
      if (source.endsWith("milk")) expect(vehicle!.conceptId).toBeUndefined();
    }
  });
});

describe("round39 semantic resolver surface precedence", () => {
  const flush = { code: "rinse", display: "Flush", procedural: true,
    coding: { system: "urn:clinic:actions", code: "flush" } };
  const localRinse = { code: "local-rinse", display: "Local rinse", procedural: true,
    aliases: ["rinse"], coding: { system: "urn:clinic:actions", code: "local-rinse" } };
  it.each([false, true])("prefers a custom alias over a colliding code independent of map order (%s)", reverse => {
    const instructionActionMap = reverse ? { local: localRinse, flush } : { flush, local: localRinse };
    const parsed = parsePublicSig("local procedure", {
      instructionActionMap,
      instructionSemanticResolvers: request => ({ actions: [{
        action: "rinse", range: { start: 0, end: request.sourceText.length }
      }] })
    });
    const actions = parsed.meta.canonical.clauses[0].instructionGraph!.actions;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.predicate.lemma).toBe("local-rinse");
      expect(action.predicate.display).toBe("Local rinse");
      expect(action.predicate.codings).toContainEqual({ system: "urn:clinic:actions", code: "local-rinse" });
    }
  });
  it("keeps a built-in surface ahead of a custom code but accepts an unambiguous custom code", () => {
    for (const [proposal, map, expectedDisplay, expectedCode] of [
      ["rinse", { flush }, "Rinse", "782155003"],
      ["clinic-flush", { flush: { ...flush, code: "clinic-flush" } }, "Flush", "flush"]
    ] as const) {
      const parsed = parsePublicSig("local procedure", {
        instructionActionMap: map,
        instructionSemanticResolvers: request => ({ actions: [{
          action: proposal, range: { start: 0, end: request.sourceText.length }
        }] })
      });
      const actions = parsed.meta.canonical.clauses[0].instructionGraph!.actions;
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.predicate.display).toBe(expectedDisplay);
        expect(action.predicate.codings).toContainEqual(expect.objectContaining({ code: expectedCode }));
      }
    }
  });
});



describe("round40 public graph amount preservation", () => {
  it.each(["Take with breakfast 1 tablet", "Take 1 tablet with breakfast"])(
    "keeps medication quantity independent of the temporal WITH daughter: %s", source => {
    const frame = parseInstructionActions(source)[0];
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" }
    }));
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Time, normalized: EventTiming.Breakfast
    }));
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({ sourceText: source, actions: [frame] })!])!;
    expect(graph.actions[0].args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" }
    }));
    expect(parsePublicSig(source).longText).toContain("1 tablet orally with breakfast");
  });

  it("keeps the measured accompaniment out of the medication Amount", () => {
    const frame = parseInstructionActions("Take with 200 mL water")[0];
    expect(frame.args.some(arg => arg.role === AdviceArgumentRole.Amount)).toBe(false);
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Substance, relation: AdviceRelation.With,
      quantity: { value: 200, unit: "mL" }
    }));
  });
});


describe("round41 supported graph and clinical preview facts", () => {
  it.each(["Substance", "Material"] as const)(
    "uses explicit vehicle attachment before an unmarked %s theme", role => {
    const options: ParseOptions = {
      instructionConceptMap: { syrup: {
        code: "clinic-syrup", role: AdviceArgumentRole[role], display: "syrup", i18n: { th: "น้ำเชื่อม" }
      } }
    };
    const parsed = parsePublicSig("Mix the syrup with 100 mL water", options);
    const frame = parseInstructionActions("Mix the syrup with 100 mL water", 0, options)[0];
    expect(frame.args[0]).toMatchObject({ role: AdviceArgumentRole[role], conceptId: "clinic-syrup" });
    expect(frame.args[1]).toMatchObject({ relation: AdviceRelation.With, quantity: { value: 100, unit: "mL" } });
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Mix syrup with 100 mL water.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ผสมน้ำเชื่อมกับน้ำ 100 มิลลิลิตร.");
    }
    // A single material remains the historical material-only construction.
    const single = parseInstructionActions("Mix syrup", 0, options)[0];
    expect(realizeInstructionAction(single, "en")).toContain("syrup");
  });

  it.each([
    ["Mix 5 mL with 100 mL water", "Mix 5 mL with 100 mL water.", "ผสม5 มิลลิลิตรกับน้ำ 100 มิลลิลิตร."],
    ["Mix 5 mL syrup with 100 mL water", "Mix 5 mL of syrup with 100 mL water.", undefined],
    ["Mix the powder with 100 mL", "Mix the powder with 100 mL.", undefined],
    ["Mix tablet with 100 mL", "Mix tablet with 100 mL.", "ผสมยาเม็ดกับ100 มิลลิลิตร."],
    ["Mix powder with 100 mL water", "Mix powder with 100 mL water.", undefined]
  ])("renders quantity-only themes without inventing an ingredient noun: %s", (source, english, thai) => {
    const parsed = parsePublicSig(source!);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toBe(english);
      expect(en).not.toContain("of mL");
      if (thai) expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
    }
  });

  it("renders an event-window-only schedule in both locales without creating a dose", () => {
    const row: FhirDosage = { timing: { repeat: { extension: [{
      url: TIMING_EVENT_WINDOW_EXTENSION_URL,
      extension: [{ url: "start", valueCode: EventTiming.Wake }, { url: "end", valueCode: EventTiming["Before Sleep"] }]
    }] } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const original = JSON.stringify(raw);
    for (const input of [row, raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("between after waking and bedtime");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("ระหว่างหลังตื่นนอนถึงก่อนนอน");
      for (const locale of ["en", "th"])
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
          .not.toMatch(/\d|\b(?:tablets?|capsules?|mL|mg|sprays?)\b|เม็ด|แคปซูล|มิลลิลิตร|มิลลิกรัม/u);
    }
    expect(courseFromR6(raw).stages[0].administrations[0].amounts).toBeUndefined();
    expect(formatSig({}, "long", { locale: "en" })).toBe("Use.");
    expect(JSON.stringify(raw)).toBe(original);
  });

  it.each([undefined, 3])("renders only authored target multiplicity for a locative site: %s", count => {
    const row: FhirDosage = {
      route: { text: "topical" }, site: { text: "below ear",
        ...(count ? { extension: [{ url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL, valueInteger: count }] } : {}) },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 g below the ear");
      expect(en).not.toMatch(/1 g.*(?:each|per administration target)/u);
      expect(en.includes("across 3 sites")).toBe(count === 3);
      expect(th.includes("รวม 3 จุด")).toBe(count === 3);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([false, true])("retains a covered plain administration's condition once (postposed %s)", postposed => {
    const source = "Swallow 1 tablet", condition = "if able to swallow";
    const frame = parseInstructionActions(source)[0];
    const offset = postposed ? 0 : condition.length + 2;
    frame.sourceText = "";
    frame.span = { start: offset, end: offset + source.length };
    const conditionStart = postposed ? source.length + 1 : 0;
    const graph = {
      sourceText: postposed ? source + " " + condition : condition + ", " + source,
      sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: condition,
        span: { start: conditionStart, end: conditionStart + condition.length } }]
    };
    const row: FhirDosage = {
      method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [buildInstructionGraphExtension(graph)!]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/if able to swallow/giu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /swallow 1 tablet/giu : /1 เม็ด/gu)).toHaveLength(1);
        if (locale === "en") expect(text).toMatch(postposed
          ? /^Swallow 1 tablet[^.!?]* if able to swallow\.$/u
          : /^If able to swallow, swallow 1 tablet/u);
      }
    expect(realizeInstructionGraph(graph, "en", { onlyWarnings: true })).toBeUndefined();
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([
    [{ duration: 1, durationUnit: "h" }, "over 1 hour", "1 ชั่วโมง"],
    [{ duration: 1, durationMax: 2, durationUnit: "h" }, "over 1 to 2 hours", "1 ถึง 2 ชั่วโมง"],
    [undefined, undefined, undefined]
  ] as const)("keeps graph-only administration duration facts: %j", (repeat, english, thai) => {
    const frame = parseInstructionActions("Wash hands")[0];
    frame.sourceText = "";
    const row: FhirDosage = {
      ...(repeat ? { timing: { repeat } } : {}),
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Wash hands");
      expect(th).toContain("ล้างมือ");
      if (english) { expect(en).toContain(english); expect(th).toContain(thai); }
      else { expect(en).toBe("Wash hands."); expect(th).toBe("ล้างมือ."); }
    }
  });
});


describe("round41 graph duration endpoints", () => {
  it("preserves independent duration range endpoints beside a graph-only action", () => {
    const frame = parseInstructionActions("Wash hands")[0];
    frame.sourceText = "";
    const range = { low: { value: 30, unit: "min", code: "min" }, high: { value: 60, unit: "min", code: "min" } };
    const row: FhirDosage = {
      timing: { repeat: { extension: [{ url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueRange: range }] } },
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const repeat of [r6.step[0].component[0].timing?.repeat, saved[0].timing?.repeat]) {
      expect(repeat?.extension?.find((entry: { url: string }) =>
        entry.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)?.valueRange).toEqual(range);
    }
    for (const input of [row, r6, saved])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "30 minutes to 60 minutes" : "30 นาที ถึง 60 นาที");
        expect(text).toContain(locale === "en" ? "Wash hands" : "ล้างมือ");
      }
    const authored = { low: { value: 30, unit: "min", code: "min" }, high: { value: 1, unit: "h", code: "h" } };
    const native = importCanonicalCourse(row);
    native.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange = authored;
    for (const locale of ["en", "th"]) {
      const text = formatSig(native, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "30 minutes to 1 hour" : "30 นาที ถึง 1 ชั่วโมง");
      expect(text).toContain(locale === "en" ? "Wash hands" : "ล้างมือ");
    }
    expect(native.stages[0].administrations[0].schedule!.recurrence!.occurrenceDurationRange).toEqual(authored);
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round41 live quantity, cadence and indication previews", () => {
  it.each(["mL", "spray"])("keeps total and per-target nasal doses distinct (%s)", unit => {
    const row: FhirDosage = {
      route: { text: "nasal" }, site: { text: "both nostrils" },
      doseAndRate: [{ doseQuantity: { value: 1, unit } }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "short", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain(unit === "mL" ? "both nostrils" : "each nostril");
      expect(en.includes("each nostril")).toBe(unit === "spray");
      expect(th.includes("ข้างละ")).toBe(unit === "spray");
      expect(th).toContain(unit === "mL" ? "รูจมูกทั้งสองข้าง" : "รูจมูกข้างละ");
      expect(en).toMatch(unit === "mL" ? /^1 mL /u : /^1 spray /u);
      expect(th).toMatch(unit === "mL" ? /^1 มล\. /u : /^1 พ่น /u);
      expect(r6.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  it("shows typed recurrence instead of an unrecognized stale Timing.code label", () => {
    const row: FhirDosage = {
      doseAndRate: [{ rateQuantity: { value: 2, unit: "mL/h" } }],
      timing: { code: { text: "twice daily" }, repeat: { frequency: 1, period: 1, periodUnit: "d" } }
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const text = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/(?:^|\s)1x\/d(?:\s|;|$)/u);
      expect(text).not.toContain("twice daily");
      expect(formatSig(input, "short", { locale: "th", realizationMode: "normalized" })).toContain("วันละครั้ง");
    }
    expect(JSON.stringify(row)).toBe(original);
    expect(formatSig({ timing: { code: { text: "BID" }, repeat: { frequency: 2, period: 1, periodUnit: "d" } } }, "short"))
      .toBe("BID");
  });

  it.each([
    ["มีไข้", "มีอาการไมเกรน"],
    ["ไมเกรน", "มีอาการไมเกรน"],
    ["มีอาการเตือนเฉพาะผู้ป่วย", "มีอาการเตือนเฉพาะผู้ป่วย"]
  ])("uses a live coded PRN indication without discarding authored translation %s", (translation, expected) => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], asNeeded: true,
      asNeededFor: [{
        text: "Migraine", coding: [{ system: "http://snomed.info/sct", code: "37796009", display: "Migraine" }],
        _text: { extension: [{
          url: "http://hl7.org/fhir/StructureDefinition/translation",
          extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: translation }]
        }] }
      }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      const text = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(text).toContain(expected);
      if (translation === "มีไข้") expect(text).not.toContain("มีไข้");
    }
    expect(cold[0].asNeededFor[0]._text).toEqual(row.asNeededFor![0]._text);
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round42 graph participant and preparation ownership", () => {
  it("keeps the authored INTO vehicle and its volume across public formats", () => {
    const parsed = parsePublicSig("Mix the tablet into 100 mL juice");
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Mix tablet into 100 mL juice.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ผสมยาเม็ดเข้าไปในjuice 100 มิลลิลิตร.");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });

  it("gives the explicit WITH vehicle priority over an unmarked substance object", () => {
    const options: ParseOptions = { instructionConceptMap: { syrup: {
      code: "clinic-syrup", role: AdviceArgumentRole.Substance, display: "syrup", i18n: { th: "น้ำเชื่อม" }
    } } };
    const frame = parseInstructionActions("Swallow syrup with water", 0, options)[0];
    frame.sourceText = "";
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: "", sourceLocale: "en", actions: [frame]
    })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Swallow syrup with water.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("กลืนน้ำเชื่อมร่วมกับน้ำ.");
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(realizeInstructionAction(parseInstructionActions("Swallow with water")[0], "en"))
      .toBe("Swallow with water");
  });

  it.each([false, true])("renders the selected object independently of argument order (%s)", reversed => {
    const frame = parseInstructionActions("Swallow the tablet with applesauce")[0];
    frame.sourceText = "";
    if (reversed) frame.args.reverse();
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: "", sourceLocale: "en", actions: [frame]
    })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Swallow tablet with applesauce.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("กลืนยาเม็ดร่วมกับapplesauce.");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("retains independent priming counts when the imported graph has no primary span", () => {
    const frame = parseInstructionActions("Prime with 2 sprays")[0];
    frame.sourceText = "";
    const row: FhirDosage = {
      method: { text: "Spray" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      // This spanless input supplies two distinct amounts, but no relative order.
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.split(/\.\s*/u).filter(Boolean).sort()).toEqual(["Prime with 2 sprays", "Spray 1 spray"]);
      expect(th.split(/\.\s*/u).filter(Boolean).sort())
        .toEqual(["พ่นครั้งละ 1 พ่น", "เตรียมอุปกรณ์พ่น 2 พ่น"].sort());
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});


it("round42: keeps BEFORE in a public imported rich patch preview", () => {
  const source = "Apply a new patch before breakfast";
  const frame = parseInstructionActions("Apply patch before breakfast")[0];
  frame.predicate.display = "Apply";
  frame.sourceText = source;
  frame.span = { start: 0, end: source.length };
  frame.args = [
    { role: AdviceArgumentRole.Object, text: "a new patch", normalized: "a new patch", i18n: { th: "แผ่นแปะใหม่" } },
    { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
      relation: AdviceRelation.Before, i18n: { th: "อาหารเช้า" } }
  ];
  const raw: FhirR6DosageInstruction = { step: [{ component: [{
    method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
    route: { coding: [{ system: "http://snomed.info/sct", code: "45890007", display: "Transdermal route" }] },
    timing: { repeat: { when: ["ACM" as EventTiming] } },
    extension: [buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", primaryAdministrationSpan: { start: 0, end: 5 }, actions: [frame]
    })!]
  }] }] };
  const before = JSON.stringify(raw);
  for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))])
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en.match(/before breakfast/gu)).toHaveLength(1);
      expect(en).not.toContain("in breakfast");
      expect(th.match(/ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(en).toContain("a new patch");
      expect(th).toContain("แผ่นแปะใหม่");
    }
  expect(JSON.stringify(raw)).toBe(before);
});


it.each([
  ["Mix 5 mL with 100 mL water at 08:00", "Mix 5 mL with 100 mL water at 08:00:00"],
  ["Dissolve 2 tablets in water at 08:00", "Dissolve 2 tablets in water at 08:00:00"]
])("round42: preserves a recognized clock after the material complement: %s", (source, expected) => {
  const frame = parseInstructionActions(source)[0];
  expect(frame.args).toContainEqual(expect.objectContaining({
    role: AdviceArgumentRole.Time, normalized: "08:00:00"
  }));
  const before = JSON.stringify(frame);
  expect(realizeInstructionAction(frame, "en")).toBe(expected);
  const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
  const row: FhirDosage = { extension: [extension] }, r6 = toDosageDetails([row]);
  for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
    const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
    const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
    expect(en).toMatch(/water at 08:00:00\.$/u);
    expect(th).toMatch(/น้ำ(?: 100 มิลลิลิตร)? เวลา 08:00:00\.$/u);
    expect(en.match(/08:00/gu)).toHaveLength(1);
    expect(th.match(/08:00/gu)).toHaveLength(1);
    if (source.startsWith("Mix")) {
      expect(en).toContain("Mix 5 mL with 100 mL water");
      expect(th).toContain("ผสม5 มิลลิลิตรกับน้ำ 100 มิลลิลิตร");
    }
    if (source.startsWith("Dissolve")) {
      expect(en).toContain("2 tablets");
      expect(th).toContain("2 เม็ด");
      expect(r6.step[0].component[0].doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    }
  }
  expect(JSON.stringify(frame)).toBe(before);
});

describe("round43 dilution clock ownership", () => {
  it.each([
    ["Dilute 1 mL at 08:00", false, false],
    ["Dilute 1 mL with saline at 08:00", false, true],
    ["Dilute 1 mL with saline to 10 mL at 08:00", true, true]
  ] as const)("keeps the complete clock out of destination arguments: %s", (source, withVolume, withSaline) => {
    const frame = parseInstructionActions(source)[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toHaveLength(1);
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Destination && /08:00/u.test(arg.text))).toEqual([]);
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toMatchObject({ value: 1, unit: "mL" });
    if (withVolume) expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Destination, relation: AdviceRelation.To,
      quantity: expect.objectContaining({ value: 10, unit: "mL" })
    }));
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const row: FhirDosage = { extension: [marker] }, r6 = toDosageDetails([row]);
    const before = JSON.stringify(row);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/08:00/gu)).toHaveLength(1);
        expect(text).toMatch(locale === "en" ? / at 08:00:00\.$/u : / เวลา 08:00:00\.$/u);
        if (withSaline) {
          expect(text).toContain("saline");
          expect(text.indexOf("08:00")).toBeGreaterThan(text.indexOf("saline"));
        }
        expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
        if (withVolume) expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
      }
    expect(JSON.stringify(row)).toBe(before);
  });
});



it("round43: preserves graph-only amounts through ordinary source-text saves without inventing a dose", () => {
  const source = "Dissolve 2 tablets in water at 08:00";
  const frame = parseInstructionActions(source)[0];
  const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
  let rows: FhirDosage[] = [{ text: source, extension: [marker] }];
  const graphBefore = JSON.stringify(parseInstructionGraphExtension(rows[0].extension));
  for (let save = 0; save < 3; save++) {
    const r6 = JSON.parse(JSON.stringify(toDosageDetails(rows)));
    expect(r6.step[0].component[0].doseAndRate).toBeUndefined();
    expect(formatSig(r6, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(formatSig(r6, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
    rows = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    expect(rows[0].doseAndRate).toBeUndefined();
    expect(JSON.stringify(parseInstructionGraphExtension(rows[0].extension))).toBe(graphBefore);
    expect(formatSig(rows, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(formatSig(rows, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
  }
});


it("round43: keeps an exactly verified cleared dose absent in an older saved R5 parser row", () => {
  // Frozen wire from reviewed 92b64d6; do not regenerate with the new producer.
  const row: FhirDosage = JSON.parse("{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Swish 10 mL for 30 seconds, then spit\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"86495002\",\"display\":\"For\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swish\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swish\"},{\"url\":\"semanticClass\",\"valueString\":\"cleanse\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลั้วปาก\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"amount-duration\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421805007\",\"display\":\"Swish - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"sourceText\",\"valueString\":\"Swish 10 mL for 30 seconds\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"10 mL\"},{\"url\":\"normalized\",\"valueString\":\"mL\"},{\"url\":\"spanStart\",\"valueInteger\":6},{\"url\":\"spanEnd\",\"valueInteger\":11},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":10},{\"url\":\"unit\",\"valueString\":\"mL\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"duration\"},{\"url\":\"text\",\"valueString\":\"for 30 seconds\"},{\"url\":\"normalized\",\"valueString\":\"30 s\"},{\"url\":\"spanStart\",\"valueInteger\":12},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":30},{\"url\":\"unit\",\"valueString\":\"s\"}]}]}]},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":1},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"spit\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Spit out\"},{\"url\":\"semanticClass\",\"valueString\":\"expel\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"บ้วนทิ้ง\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-action\",\"code\":\"spit\",\"display\":\"Spit out\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"บ้วนทิ้ง\"}]}]}}},{\"url\":\"predicateComponent\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"activity\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"12405001\",\"display\":\"Spitting\"}}]},{\"url\":\"spanStart\",\"valueInteger\":33},{\"url\":\"spanEnd\",\"valueInteger\":37},{\"url\":\"sourceText\",\"valueString\":\"spit\"}]},{\"url\":\"graphRelation\",\"extension\":[{\"url\":\"kindCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421067001\",\"display\":\"Then - dosing instruction fragment\"}},{\"url\":\"fromActionIndex\",\"valueInteger\":0},{\"url\":\"toActionIndex\",\"valueInteger\":1},{\"url\":\"text\",\"valueString\":\", then\"},{\"url\":\"spanStart\",\"valueInteger\":26},{\"url\":\"spanEnd\",\"valueInteger\":33}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":37},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Swish 10 mL for 30 seconds, then spit\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"04945e91102ea208\"},{\"url\":\"textFingerprint\",\"valueString\":\"5e3a3c0b00177305\"},{\"url\":\"sourceHasStructuredClocks\",\"valueBoolean\":false},{\"url\":\"sourceHasStructuredEvents\",\"valueBoolean\":false},{\"url\":\"sourceHasStructuredSite\",\"valueBoolean\":false}]}]}],\"route\":{\"text\":\"swish and spit, oromucosal\",\"coding\":[{\"system\":\"http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration\",\"code\":\"SWISHSPIT\",\"display\":\"Swish and spit out, oromucosal\"},{\"system\":\"http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl\",\"code\":\"C38302\",\"display\":\"Swish and Spit Route of Administration\"}]},\"patientInstruction\":\"Swish 10 mL for 30 seconds, then spit\",\"text\":\"Swish 10 mL for 30 seconds. Then spit out.\"}");
  const before = JSON.stringify(row);
  expect(parseInstructionGraphExtension(row.extension)?.primaryAdministrationSpan).toBeUndefined();
  for (const realizationMode of ["normalized", "roundtrip"] as const) {
    const text = formatSig(row, "long", { locale: "en", realizationMode });
    expect(text).not.toMatch(/10\s*mL/iu);
    expect(text).toContain("30 seconds");
    expect(text).toContain("spit");
  }
  expect(fromFhirDosage(row, { locale: "en", realizationMode: "normalized" }).longText).not.toMatch(/10\s*mL/iu);
  expect(JSON.stringify(row)).toBe(before);
  expect(parseInstructionGraphExtension(row.extension)?.primaryAdministrationSpan).toBeUndefined();
  const exported = toFhirR5Dosages([row]);
  expect(JSON.stringify(parseInstructionGraphExtension(exported[0].extension)))
    .toBe(JSON.stringify(parseInstructionGraphExtension(row.extension)));
});


it.each(["Dissolve 2 tablets in 100 mL solvent", "Dissolve 2 tablets in water at 08:00"])(
  "round43: retains the current amount at its declared preparation owner: %s", source => {
    const edited = JSON.parse(JSON.stringify(parsePublicSig(source).fhirNext));
    edited.step[0].component[0].doseAndRate[0].doseQuantity.value = 3;
    const before = JSON.stringify(edited);
    for (const input of [edited, JSON.parse(JSON.stringify(toFhirR5Dosages(edited)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const)
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(locale === "en" ? /3 tablets/gu : /3 เม็ด/gu)).toHaveLength(1);
          expect(text).toMatch(locale === "en" ? /^Dissolve 3 tablets /u : /^ละลาย\s*3 เม็ด/u);
          expect(text).not.toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
          if (source.includes("100 mL")) {
            expect(text).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
            expect(text).toContain("solvent");
          } else {
            expect(text).toContain(locale === "en" ? "water" : "น้ำ");
            expect(text).toMatch(/(?:08:00|8:00 am)/u);
          }
        }
    expect(JSON.stringify(edited)).toBe(before);
  }
);


describe("round46 authored concept metadata and terminal action clocks", () => {
  it("preserves custom Coding primitive annotations without dropping authored metadata", () => {
    const options: ParseOptions = { instructionConceptMap: { juice: {
      code: "clinic-juice", role: AdviceArgumentRole.Substance, display: "juice",
      coding: { system: "https://example.org/clinic", code: "juice",
        _code: { id: "clinic-note", extension: [{ url: "https://example.org/note", valueString: "keep" }] },
        _userSelected: { id: "selection-note" },
        extension: [{ url: "https://example.org/outer", extension: [{ url: "inner", valueBoolean: false }] }] }
    } } };
    const result = resolvePublicConcept("juice", options)!;
    expect(result.coding).toEqual(options.instructionConceptMap!.juice.coding);
  });

  it.each(["", ".", "!"])("retains a complete clock before terminal punctuation %s", punctuation => {
    const source = "Dilute 1 mL at 08:00" + punctuation;
    const parsed = parsePublicSig(source);
    const time = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args
      .find(argument => argument.role === AdviceArgumentRole.Time)!;
    expect(time).toMatchObject({ text: "08:00", normalized: "08:00:00",
      span: { start: 15, end: 20 } });
    expect(source.slice(time.span!.start, time.span!.end)).toBe("08:00");
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL at 08:00:00.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("เจือจาง 1 มิลลิลิตร เวลา 08:00:00.");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });
});

describe("round44 fresh compound argument ownership", () => {
  it.each([false, true])("isolates a compound argument from subsequent parses (resolver %s)", semanticResolver => {
    const makeGraph = () => semanticResolver ? parsePublicSig("local procedure", {
        instructionSemanticResolvers: request => ({ actions: [{ action: "cover",
          range: { start: 0, end: request.sourceText.length }, args: [{
            role: AdviceArgumentRole.Object, range: { start: 0, end: request.sourceText.length },
            concept: "occlusive dressing"
          }] }] })
      }).meta.canonical.clauses[0].instructionGraph!
        : { sourceText: "Cover with an occlusive dressing", sourceLocale: "en",
          actions: parseInstructionActions("Cover with an occlusive dressing") };
    const graph = makeGraph();
    const before = JSON.stringify(graph);
    const expected = [
      { role: "head", text: "dressing", coding: expect.objectContaining({
        system: "http://snomed.info/sct", code: "333453004", display: "Medical dressing (physical object)"
      }) },
      { role: "qualifier", text: "occlusive" }
    ];
    const edited = JSON.parse(before) as typeof graph;
    const componentCoding = edited.actions.find(frame => frame.predicate.lemma === "cover")!.args
      .find(arg => arg.conceptId === "occlusive_dressing")!.components!.find(component => component.coding)!.coding!;
    componentCoding.code = "local-edited-code";
    componentCoding.display = "Local edited dressing";
    const editedExpected = [
      { role: "head", text: "dressing", coding: expect.objectContaining({
        system: "http://snomed.info/sct", code: "local-edited-code", display: "Local edited dressing"
      }) },
      { role: "qualifier", text: "occlusive" }
    ];
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(edited)!] };
    const reopened = parseInstructionGraphExtension(toFhirR5Dosages(toDosageDetails([row]))[0].extension)!;
    for (const current of [edited, reopened]) {
      expect(current.actions.find(frame => frame.predicate.lemma === "cover")!.args
        .find(arg => arg.conceptId === "occlusive_dressing")!.components).toEqual(editedExpected);
    }
    for (const current of [graph, makeGraph()]) {
      expect(current.actions.find(frame => frame.predicate.lemma === "cover")!.args
        .find(arg => arg.conceptId === "occlusive_dressing")!.components).toEqual(expected);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("round44 existing temporal ownership", () => {
  it("keeps the first dilution volume as a destination", () => {
    const frame = parseInstructionActions("Dilute to 10 mL")[0];
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Destination,
      relation: AdviceRelation.To, quantity: { value: 10, unit: "mL" } }));
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toEqual([]);
    expect(realizeInstructionAction(frame, "en")).toBe("Dilute to 10 mL");
  });

  it("keeps a spaced nightly maximum complete and non-executable", () => {
    const source = "Take 1 tablet as needed, max 2 tablets / 1 night";
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.additionalInstructions).toContainEqual({ text: "max 2 tablets / 1 night" });
    expect(clause.schedule?.maxDosePerPeriod).toBeUndefined();
    expect(clause.schedule?.when).toBeUndefined();
    expect(clause.schedule?.duration).toBeUndefined();
    expect(parsed.fhir[0].maxDosePerPeriod).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("preserves an elapsed slash cap and separate slash administrations", () => {
    const capped = parsePublicSig("Take 1 tablet as needed, max 2 tablets / 8 hours");
    expect(capped.meta.canonical.clauses).toHaveLength(1);
    expect(capped.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 2, unit: "tab", period: 8, periodUnit: "h" }]);
    const split = parsePublicSig("Take 1 tablet morning / 2 tablets evening");
    expect(split.meta.canonical.clauses.map(clause => ({ dose: clause.dose, when: clause.schedule?.when })))
      .toEqual([{ dose: { value: 1, unit: "tab" }, when: [EventTiming.Morning] },
        { dose: { value: 2, unit: "tab" }, when: [EventTiming.Evening] }]);
  });

  it.each([false, true])("retains a directional graph time beside an equal structured clock (%s)", directional => {
    const row = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole").fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.actions[0].args.push({ role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00:00",
      ...(directional ? { relation: AdviceRelation.Before } : {}) });
    const marker = buildInstructionGraphExtension(graph)!;
    row.extension = row.extension.filter((entry: { url: string }) => entry.url !== marker.url);
    row.extension.push(marker);
    row.timing = { repeat: { timeOfDay: ["08:00:00"] } };
    const r6 = toDosageDetails([row]), before = JSON.stringify(row);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
        if (directional) {
          expect(text).toContain(locale === "en" ? "before 08:00:00" : "ก่อน08:00:00");
          expect(text).toMatch(locale === "en" ? /\bat\s+0?8:00\s*am\b/u : /เวลา\s*0?8:00/u);
          expect(text.match(/0?8:00(?::00)?/gu)).toHaveLength(2);
        } else expect(text.match(/0?8:00(?::00)?/gu)).toHaveLength(1);
      }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([["Do not eat", "ห้ามรับประทานอาหาร"], ["Do not swallow", "ห้ามกลืน"]])(
    "localizes the registered advice lemma: %s", (text, predicate) => {
      const row = { additionalInstruction: [{ text }] }, before = JSON.stringify(row);
      expect(formatSig(row, "long", { locale: "th", realizationMode: "normalized" })).toBe(predicate + ".");
      expect(JSON.stringify(row)).toBe(before);
    }
  );
});


describe("round45 saved instruction meaning", () => {
  // Exact public R5 rows emitted by pinned master 7d628239. These retain the
  // old frame-level WITH and its unmarked Object/Container argument.
  const frozenMixCases: Array<[string, string, FhirDosage[]]> = [["Mix powder with household spoon","household spoon",[{"extension":[{"url":"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph","extension":[{"url":"sourceText","valueString":"Mix powder with household spoon"},{"url":"sourceLocale","valueCode":"en"},{"url":"action","extension":[{"url":"sequenceIndex","valueInteger":0},{"url":"force","valueCode":"sequence"},{"url":"relationCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421463005","display":"With - dosing instruction fragment"}},{"url":"predicateLemma","valueString":"mix"},{"url":"predicateDisplay","valueString":"Mix"},{"url":"semanticClass","valueString":"prepare"},{"url":"predicateTranslation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ผสม"}]},{"url":"predicateRealizer","valueCode":"mix-substance"},{"url":"predicateCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421826007","display":"Mix"}},{"url":"spanStart","valueInteger":0},{"url":"spanEnd","valueInteger":31},{"url":"sourceText","valueString":"Mix powder with household spoon"},{"url":"argument","extension":[{"url":"role","valueCode":"theme"},{"url":"text","valueString":"powder"},{"url":"normalized","valueString":"powder"},{"url":"spanStart","valueInteger":4},{"url":"spanEnd","valueInteger":10}]},{"url":"argument","extension":[{"url":"role","valueCode":"object"},{"url":"text","valueString":"household spoon"},{"url":"normalized","valueString":"household spoon"},{"url":"conceptId","valueString":"household-spoon"},{"url":"coding","valueCoding":{"system":"http://snomed.info/sct","code":"303514007","display":"Spoon"}},{"url":"argumentCoding","valueCoding":{"system":"http://snomed.info/sct","code":"303514007","display":"Spoon"}},{"url":"spanStart","valueInteger":16},{"url":"spanEnd","valueInteger":31},{"url":"translation","extension":[{"url":"locale","valueCode":"en"},{"url":"text","valueString":"household spoon"}]},{"url":"translation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ช้อนกินข้าว"}]}]}]},{"url":"coverage","extension":[{"url":"understoodCharacters","valueInteger":31},{"url":"opaqueCharacters","valueInteger":0},{"url":"ratio","valueDecimal":1},{"url":"complete","valueBoolean":true}]}]},{"url":"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction","extension":[{"url":"instruction","valueString":"Mix powder with household spoon"},{"url":"row","extension":[{"url":"projectionFingerprint","valueString":"477013de929e05d2"},{"url":"textFingerprint","valueString":"64f761b522a80a10"}]}]}],"text":"Mix powder with household spoon.","patientInstruction":"Mix powder with household spoon"}]],["Mix powder with bottle","bottle",[{"extension":[{"url":"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph","extension":[{"url":"sourceText","valueString":"Mix powder with bottle"},{"url":"sourceLocale","valueCode":"en"},{"url":"action","extension":[{"url":"sequenceIndex","valueInteger":0},{"url":"force","valueCode":"sequence"},{"url":"relationCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421463005","display":"With - dosing instruction fragment"}},{"url":"predicateLemma","valueString":"mix"},{"url":"predicateDisplay","valueString":"Mix"},{"url":"semanticClass","valueString":"prepare"},{"url":"predicateTranslation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ผสม"}]},{"url":"predicateRealizer","valueCode":"mix-substance"},{"url":"predicateCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421826007","display":"Mix"}},{"url":"spanStart","valueInteger":0},{"url":"spanEnd","valueInteger":22},{"url":"sourceText","valueString":"Mix powder with bottle"},{"url":"argument","extension":[{"url":"role","valueCode":"theme"},{"url":"text","valueString":"powder"},{"url":"normalized","valueString":"powder"},{"url":"spanStart","valueInteger":4},{"url":"spanEnd","valueInteger":10}]},{"url":"argument","extension":[{"url":"role","valueCode":"container"},{"url":"text","valueString":"bottle"},{"url":"normalized","valueString":"bottle"},{"url":"conceptId","valueString":"bottle"},{"url":"coding","valueCoding":{"system":"http://snomed.info/sct","code":"68276009","display":"Bottle"}},{"url":"argumentCoding","valueCoding":{"system":"http://snomed.info/sct","code":"68276009","display":"Bottle"}},{"url":"argumentCoding","valueCoding":{"system":"http://standardterms.edqm.eu","code":"30008000","display":"Bottle"}},{"url":"spanStart","valueInteger":16},{"url":"spanEnd","valueInteger":22},{"url":"translation","extension":[{"url":"locale","valueCode":"en"},{"url":"text","valueString":"bottle"}]},{"url":"translation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ขวด"}]}]}]},{"url":"coverage","extension":[{"url":"understoodCharacters","valueInteger":22},{"url":"opaqueCharacters","valueInteger":0},{"url":"ratio","valueDecimal":1},{"url":"complete","valueBoolean":true}]}]},{"url":"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction","extension":[{"url":"instruction","valueString":"Mix powder with bottle"},{"url":"row","extension":[{"url":"projectionFingerprint","valueString":"6be054d159f634a0"},{"url":"textFingerprint","valueString":"f8e0341b9f5fd3d4"}]}]}],"text":"Mix powder with bottle.","patientInstruction":"Mix powder with bottle"}]]];

  it.each(frozenMixCases)("retains the old nominal companion in %s", (source, companion, frozen) => {
    const rows = JSON.parse(JSON.stringify(frozen)) as FhirDosage[];
    const before = JSON.stringify(rows), r6 = toDosageDetails(rows);
    for (const input of [rows, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("powder");
      expect(en).toContain("with " + companion);
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th).toMatch(companion === "bottle" ? /bottle|ขวด/u : /household spoon|ช้อนกินข้าว/u);
    }
    expect(JSON.stringify(rows)).toBe(before);
    expect(parsePublicSig(source).longText).toContain(companion);
  });

  it.each([
    ["container-activity", false], ["container-activity", true],
    ["amount-material-destination", false], ["amount-material-destination", true]
  ] as const)(
    "keeps the accepted duration, container and Time with a configured procedural realizer: %s (%s)", (realizer, timed) => {
    const source = "Agitate bottle ten seconds" + (timed ? " lights-out" : ""), requests: string[] = [];
    const options: ParseOptions = {
      unitMap: { s: "s" },
      instructionActionMap: {
        "clinic-agitation": { code: "clinic-agitation", semanticClass: "prepare",
          display: "Agitate", i18n: { th: "เขย่า" }, procedural: true, realizer }
      },
      instructionSemanticResolvers: request => {
        requests.push(request.sourceText);
        if (request.sourceText !== source) return undefined;
        return { actions: [{ action: "clinic-agitation", range: { start: 0, end: source.length }, args: [
          { role: AdviceArgumentRole.Container, range: { start: 8, end: 14 }, concept: "bottle" },
          { role: AdviceArgumentRole.Duration, range: { start: 15, end: 26 }, quantity: { value: 10, unit: "s" } },
          ...(timed ? [{ role: AdviceArgumentRole.Time, range: { start: 27, end: 37 }, concept: "bedtime" }] : [])
        ] }] };
      }
    };
    const parsed = parsePublicSig(source, options);
    expect(requests).toContain(source);
    const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(action.predicate.realizer).toBe(realizer);
    expect(action.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Container, conceptId: "bottle" }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 10, unit: "s" } })
    ]));
    const r6 = toDosageDetails(parsed.fhir), before = JSON.stringify(parsed.fhir);
    for (const input of [parsed.fhir, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain("Agitate bottle for 10 seconds");
      expect(english.match(/10 seconds/gu)).toHaveLength(1);
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain(realizer === "container-activity" ? "เขย่าขวดเป็นเวลา 10 วินาที" : "เขย่าขวด 10 วินาที");
      expect(thai.match(/10 วินาที/gu)).toHaveLength(1);
      if (timed) {
        expect(action.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "bedtime" }));
        expect(english.match(/bedtime/gu)).toHaveLength(1);
        expect(thai.match(/นอน/gu)).toHaveLength(1);
      }
    }
    expect(JSON.stringify(parsed.fhir)).toBe(before);
  });

  it.each(["PHS", "HS"])("uses current %s rather than an unmapped after-sleep graph argument", event => {
    const original = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole after sleep").fhir[0])) as FhirDosage;
    original.timing!.repeat!.when = [EventTiming["After Sleep"]];
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails([original]))[0])) as FhirDosage;
    saved.timing!.repeat!.when = [event as EventTiming];
    const before = JSON.stringify(saved), r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 tablet");
      expect(en).toContain("whole");
      expect(th).toContain("1 เม็ด");
      expect(th).toContain("ทั้งเม็ด");
      if (event === "PHS") {
        expect(en.match(/after sleep/gu)).toHaveLength(1);
        expect(th).toContain("หลังจากนอน");
      } else {
        expect(en).toContain("at bedtime");
        expect(en).not.toContain("after sleep");
        expect(th).toContain("ก่อนนอน");
        expect(th).not.toMatch(/หลัง(?:จาก)?นอน/u);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
    expect(parseInstructionGraphExtension(saved.extension)!.sourceText).toBe("Swallow 1 tablet whole after sleep");
  });
});


describe("round47 public saved graph conditions and partial quantities", () => {
  // Frozen public R5 rows retain the graph array target independently of optional action labels.
  const conditionFixtures: { postposed: boolean; wire: FhirDosage }[] = [
    {
      "postposed": false,
      "wire": {
        "method": {"text": "Swallow"},
        "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab"}}],
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": "if able to swallow, Swallow 1 tablet"},
              {"url": "sourceLocale", "valueCode": "en"},
              {"url": "primaryAdministrationStart", "valueInteger": 20},
              {"url": "primaryAdministrationEnd", "valueInteger": 36},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {"url": "predicateLemma", "valueString": "swallow"},
                  {"url": "predicateDisplay", "valueString": "Swallow"},
                  {"url": "semanticClass", "valueString": "ingest"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}},
                  {
                    "url": "predicateCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421521009", "display": "Swallow - dosing instruction imperative"}
                  },
                  {"url": "spanStart", "valueInteger": 20},
                  {"url": "spanEnd", "valueInteger": 36},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "amount"},
                      {"url": "text", "valueString": "1 tablet"},
                      {"url": "normalized", "valueString": "tab"},
                      {"url": "spanStart", "valueInteger": 8},
                      {"url": "spanEnd", "valueInteger": 16},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 1}, {"url": "unit", "valueString": "tab"}]}
                    ]
                  }
                ]
              },
              {
                "url": "graphRelation",
                "extension": [
                  {"url": "kindCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421803000", "display": "If - dosing instruction fragment"}},
                  {"url": "toActionIndex", "valueInteger": 0},
                  {"url": "text", "valueString": "if able to swallow"},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 18}
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "postposed": true,
      "wire": {
        "method": {"text": "Swallow"},
        "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab"}}],
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": "Swallow 1 tablet if able to swallow"},
              {"url": "sourceLocale", "valueCode": "en"},
              {"url": "primaryAdministrationStart", "valueInteger": 0},
              {"url": "primaryAdministrationEnd", "valueInteger": 16},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {"url": "predicateLemma", "valueString": "swallow"},
                  {"url": "predicateDisplay", "valueString": "Swallow"},
                  {"url": "semanticClass", "valueString": "ingest"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}},
                  {
                    "url": "predicateCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421521009", "display": "Swallow - dosing instruction imperative"}
                  },
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 16},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "amount"},
                      {"url": "text", "valueString": "1 tablet"},
                      {"url": "normalized", "valueString": "tab"},
                      {"url": "spanStart", "valueInteger": 8},
                      {"url": "spanEnd", "valueInteger": 16},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 1}, {"url": "unit", "valueString": "tab"}]}
                    ]
                  }
                ]
              },
              {
                "url": "graphRelation",
                "extension": [
                  {"url": "kindCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421803000", "display": "If - dosing instruction fragment"}},
                  {"url": "toActionIndex", "valueInteger": 0},
                  {"url": "text", "valueString": "if able to swallow"},
                  {"url": "spanStart", "valueInteger": 17},
                  {"url": "spanEnd", "valueInteger": 35}
                ]
              }
            ]
          }
        ]
      }
    }
  ];

  it.each(conditionFixtures.flatMap(fixture => ["present", "absent", "other"].map(indexMode => ({
    ...fixture, indexMode
  }))))("retains a saved graph condition for action position zero ($postposed, $indexMode)", ({ postposed, wire, indexMode }) => {
    const row: FhirDosage = JSON.parse(JSON.stringify(wire));
    const action = row.extension![0].extension!.find(field => field.url === "action")!;
    const index = action.extension!.find(field => field.url === "sequenceIndex")!;
    if (indexMode === "absent") action.extension = action.extension!.filter(field => field !== index);
    else index.valueInteger = indexMode === "other" ? 9 : 0;
    const original = JSON.stringify(row);
    const decoded = parseInstructionGraphExtension(row.extension)!;
    expect(decoded.actions).toHaveLength(1);
    expect(decoded.actions[0].sequenceIndex).toBe(indexMode === "absent" ? undefined : indexMode === "other" ? 9 : 0);
    expect(decoded.relations).toContainEqual(expect.objectContaining({
      kind: AdviceRelation.If, toActionIndex: 0, text: "if able to swallow"
    }));
    const direct = postposed ? "Swallow 1 tablet if able to swallow" : "if able to swallow, swallow 1 tablet";
    for (const graph of [decoded, parseInstructionGraphExtension([buildInstructionGraphExtension(decoded)!])!])
      expect(realizeInstructionGraph(graph, "en")).toBe(direct);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const english = formatSig(input, "long", { locale: "en", realizationMode });
        const thai = formatSig(input, "long", { locale: "th", realizationMode });
        expect(english).toBe(postposed ? "Swallow 1 tablet if able to swallow." : "If able to swallow, swallow 1 tablet.");
        const administration = realizationMode === "roundtrip" ? "รับประทาน 1 เม็ด" : "รับประทานครั้งละ 1 เม็ด";
        expect(thai).toBe(postposed ? `${administration} if able to swallow.` : `If able to swallow ให้${administration}.`);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  // The saved input is fixed independently of the current parser and encoder.
  const mixingFixtures: { side: string; status: string; wire: FhirDosage; expected: { en: string; th: string } }[] = [
    {
      "side": "companion",
      "status": "complete",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 22},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "object"},
                      {"url": "text", "valueString": "tablet"},
                      {"url": "normalized", "valueString": "tablet"},
                      {"url": "conceptId", "valueString": "medication-tablet"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://standardterms.edqm.eu", "code": "15054000", "display": "Tablet"}},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 10},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "tablet"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ยาเม็ด"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "material"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "100 mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "spanStart", "valueInteger": 16},
                      {"url": "spanEnd", "valueInteger": 22},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 100}, {"url": "unit", "valueString": "mL"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix tablet with 100 mL.", "th": "ผสมยาเม็ดกับ100 มิลลิลิตร."}
    },
    {
      "side": "companion",
      "status": "partial",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 22},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "object"},
                      {"url": "text", "valueString": "tablet"},
                      {"url": "normalized", "valueString": "tablet"},
                      {"url": "conceptId", "valueString": "medication-tablet"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://standardterms.edqm.eu", "code": "15054000", "display": "Tablet"}},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 10},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "tablet"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ยาเม็ด"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "material"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "quantity", "extension": [{"url": "unit", "valueString": "mL"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix tablet with mL.", "th": "ผสมยาเม็ดกับmL."}
    },
    {
      "side": "theme",
      "status": "complete",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 19},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "theme"},
                      {"url": "text", "valueString": "5 mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 8},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 5}, {"url": "unit", "valueString": "mL"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "substance"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "water"},
                      {"url": "normalized", "valueString": "water"},
                      {"url": "conceptId", "valueString": "water"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "spanStart", "valueInteger": 14},
                      {"url": "spanEnd", "valueInteger": 19},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix 5 mL with water.", "th": "ผสม5 มิลลิลิตรกับน้ำ."}
    },
    {
      "side": "theme",
      "status": "partial",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 19},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "theme"},
                      {"url": "text", "valueString": "mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "quantity", "extension": [{"url": "unit", "valueString": "mL"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "substance"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "water"},
                      {"url": "normalized", "valueString": "water"},
                      {"url": "conceptId", "valueString": "water"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "spanStart", "valueInteger": 14},
                      {"url": "spanEnd", "valueInteger": 19},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix mL with water.", "th": "ผสมmLกับน้ำ."}
    }
  ];

  it.each(mixingFixtures)("retains the saved $status quantity-only $side without inventing a value", ({ side, status, wire, expected }) => {
    const row: FhirDosage = JSON.parse(JSON.stringify(wire));
    const original = JSON.stringify(row), decoded = parseInstructionGraphExtension(row.extension)!;
    const quantityArgument = decoded.actions[0].args.find(argument => argument.quantity?.unit === "mL")!;
    expect(quantityArgument.normalized).toBe("mL");
    expect(quantityArgument.text).toBe(status === "partial" ? "mL" : side === "theme" ? "5 mL" : "100 mL");
    expect(quantityArgument.quantity?.value).toBe(status === "partial" ? undefined : side === "theme" ? 5 : 100);
    expect(quantityArgument.quantity?.unit).toBe("mL");
    const companion = side === "companion" ? quantityArgument : decoded.actions[0].args.find(argument => argument.normalized === "water")!;
    expect(companion.relation).toBe(AdviceRelation.With);
    const r6 = toDosageDetails([row]);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected.en);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(expected.th);
    }
    const restored = parseInstructionGraphExtension(cold[0].extension)!;
    expect(restored.actions[0].args.find(argument => argument.quantity?.unit === "mL")?.quantity)
      .toEqual(quantityArgument.quantity);
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round48 saved preparation quantities", () => {
  it.each([false, true])("keeps a live medication amount separate from a saved With vehicle (%s)", measured => {
    const source = "Mix with " + (measured ? "100 mL water" : "water");
    const frame = parseInstructionActions(source)[0];
    const row: FhirDosage = { method: { text: "Mix" },
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      extension: [buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame] })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe("Mix 2 tablets with " + (measured ? "100 mL water." : "water."));
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe("ผสม2 เม็ดกับน้ำ" + (measured ? " 100 มิลลิลิตร." : "."));
      }
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("keeps the object quantity from a pinned-master saved dilution graph", () => {
    // Exact ordinary parser row from 7d62823, with no saved predicate realizer.
    const legacy: FhirDosage = JSON.parse("{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"dilute\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Dilute\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"เจือจาง\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421399004\",\"display\":\"Dilute - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":11},{\"url\":\"sourceText\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"object\"},{\"url\":\"text\",\"valueString\":\"1 mL\"},{\"url\":\"normalized\",\"valueString\":\"1 ml\"}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":11},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"aad6e640fa986e9e\"},{\"url\":\"textFingerprint\",\"valueString\":\"2911d1f74ead3591\"}]}]}],\"text\":\"Dilute 1 mL.\",\"patientInstruction\":\"Dilute 1 mL\"}");
    const before = JSON.stringify(legacy), r6 = toDosageDetails([legacy]);
    for (const input of [legacy, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL.");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toBe("เจือจาง1 มิลลิลิตร.");
    }
    const current = parsePublicSig("Dilute 1 mL to 10 mL");
    for (const input of [current.fhirNext, JSON.parse(JSON.stringify(current.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL to 10 mL.");
    }
    expect(JSON.stringify(legacy)).toBe(before);
  });
});


describe("round 49 saved instruction ownership", () => {
  // Complete saved inputs are frozen independently of the current parser.
  const mixing: { source: string; wire: FhirDosage[]; thai: string }[] = JSON.parse("[{\"source\":\"Mix with a household spoon\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"sourceText\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"material\"},{\"url\":\"text\",\"valueString\":\"a household spoon\"},{\"url\":\"normalized\",\"valueString\":\"a household spoon\"},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":26}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":26},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"755ab910a97fa391\"},{\"url\":\"textFingerprint\",\"valueString\":\"637eec5945f4701d\"}]}]}],\"text\":\"Mix with a household spoon.\",\"patientInstruction\":\"Mix with a household spoon\"}],\"thai\":\"ผสมด้วยa household spoon.\"},{\"source\":\"Mix with household spoon\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"sourceText\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"object\"},{\"url\":\"text\",\"valueString\":\"household spoon\"},{\"url\":\"normalized\",\"valueString\":\"household spoon\"},{\"url\":\"conceptId\",\"valueString\":\"household-spoon\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"303514007\",\"display\":\"Spoon\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"303514007\",\"display\":\"Spoon\"}},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"household spoon\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ช้อนกินข้าว\"}]}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":24},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"804ea8f8c2800b4f\"},{\"url\":\"textFingerprint\",\"valueString\":\"6c1690c82d30fb50\"}]}]}],\"text\":\"Mix with household spoon.\",\"patientInstruction\":\"Mix with household spoon\"}],\"thai\":\"ผสมด้วยช้อนกินข้าว.\"},{\"source\":\"Mix with bottle\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with bottle\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":15},{\"url\":\"sourceText\",\"valueString\":\"Mix with bottle\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"container\"},{\"url\":\"text\",\"valueString\":\"bottle\"},{\"url\":\"normalized\",\"valueString\":\"bottle\"},{\"url\":\"conceptId\",\"valueString\":\"bottle\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"68276009\",\"display\":\"Bottle\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"68276009\",\"display\":\"Bottle\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://standardterms.edqm.eu\",\"code\":\"30008000\",\"display\":\"Bottle\"}},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":15},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"bottle\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ขวด\"}]}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":15},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with bottle\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"adfd6b811a8bf2d1\"},{\"url\":\"textFingerprint\",\"valueString\":\"45c8fff0ebd7df19\"}]}]}],\"text\":\"Mix with bottle.\",\"patientInstruction\":\"Mix with bottle\"}],\"thai\":\"ผสมด้วยขวด.\"}]");
  it.each(mixing)("retains the vehicle relation in saved $source", ({ source, wire, thai }) => {
    const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
    for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }).replace(/\.$/u, "")).toBe(source);
        expect(formatSig(input, "long", { locale: "th", realizationMode })).toBe(thai);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(wire)).toBe(original);
  });

  const savedWarning: FhirDosage[] = JSON.parse("[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Do not apply 1 g hydrocortisone cream to broken skin\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"warning\"},{\"url\":\"polarity\",\"valueCode\":\"negate\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421035004\",\"display\":\"To - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"apply\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Apply\"},{\"url\":\"semanticClass\",\"valueString\":\"administration\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ทา\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738991002\",\"display\":\"Apply\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"417924000\",\"display\":\"Apply - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":52},{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"theme\"},{\"url\":\"text\",\"valueString\":\"hydrocortisone cream\"},{\"url\":\"normalized\",\"valueString\":\"hydrocortisone cream\"},{\"url\":\"spanStart\",\"valueInteger\":17},{\"url\":\"spanEnd\",\"valueInteger\":37}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"site\"},{\"url\":\"text\",\"valueString\":\"broken skin\"},{\"url\":\"normalized\",\"valueString\":\"broken skin\"},{\"url\":\"conceptId\",\"valueString\":\"broken-skin\"},{\"url\":\"component\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"head\"},{\"url\":\"text\",\"valueString\":\"broken skin\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"247442005\",\"display\":\"Broken skin (disorder)\"}}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"broken skin\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผิวหนังที่มีแผล\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"1 g\"},{\"url\":\"normalized\",\"valueString\":\"g\"},{\"url\":\"spanStart\",\"valueInteger\":13},{\"url\":\"spanEnd\",\"valueInteger\":16},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":1},{\"url\":\"unit\",\"valueString\":\"g\"}]}]}]}]}]}]");
  it.each([true, false].flatMap(negated => [true, false].map(quantified => ({ negated, quantified }))))(
    "retains medication Theme and Site together (negated=$negated, quantified=$quantified)",
    ({ negated, quantified }) => {
      let wire: FhirDosage[] = JSON.parse(JSON.stringify(savedWarning));
      if (!negated || !quantified) {
        const source = `${negated ? "Do not apply" : "Apply"} ${quantified ? "1 g " : ""}hydrocortisone cream to broken skin`;
        const frame = parseInstructionActions(source)[0];
        const object = frame.args.find(arg => arg.role === AdviceArgumentRole.Object)!;
        frame.args[frame.args.indexOf(object)] = { role: AdviceArgumentRole.Theme,
          text: "hydrocortisone cream", normalized: "hydrocortisone cream",
          span: { start: source.indexOf("hydrocortisone"), end: source.indexOf(" to ") } };
        frame.sourceText = "";
        wire = [{ extension: [buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!] }];
      }
      const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
      for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        const before = JSON.stringify(input);
        for (const realizationMode of ["normalized", "roundtrip"] as const) for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text).toContain("hydrocortisone cream");
          expect(text.match(/hydrocortisone cream/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "to broken skin" : "ผิวหนังที่มีแผล");
          expect(text.includes("1 g")).toBe(quantified);
          expect(locale === "en" ? /^Do not /u.test(text) : /^ห้าม/u.test(text)).toBe(negated);
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(wire)).toBe(original);
    }
  );

  const savedPreparation: FhirDosage[] = JSON.parse("[{\"method\":{\"text\":\"Swallow\"},\"doseAndRate\":[{\"doseQuantity\":{\"value\":1,\"unit\":\"tab\"}}],\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Measure 100 mL of water; swallow whole\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"primaryAdministrationStart\",\"valueInteger\":25},{\"url\":\"primaryAdministrationEnd\",\"valueInteger\":38},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"measure\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Measure\"},{\"url\":\"semanticClass\",\"valueString\":\"measure\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ตวง\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"object-amount-material\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"129266000\",\"display\":\"Measurement - action\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":23},{\"url\":\"sourceText\",\"valueString\":\"Measure 100 mL of water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"theme\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"spanStart\",\"valueInteger\":18},{\"url\":\"spanEnd\",\"valueInteger\":23},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"100 mL\"},{\"url\":\"normalized\",\"valueString\":\"mL\"},{\"url\":\"spanStart\",\"valueInteger\":8},{\"url\":\"spanEnd\",\"valueInteger\":14},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":100},{\"url\":\"unit\",\"valueString\":\"mL\"}]}]}]},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":1},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":25},{\"url\":\"spanEnd\",\"valueInteger\":38},{\"url\":\"sourceText\",\"valueString\":\"swallow whole\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"manner\"},{\"url\":\"text\",\"valueString\":\"whole\"},{\"url\":\"normalized\",\"valueString\":\"whole\"},{\"url\":\"conceptId\",\"valueString\":\"whole\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"whole\",\"display\":\"whole\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"ทั้งเม็ด\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"whole\",\"display\":\"whole\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"ทั้งเม็ด\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"255503000\",\"display\":\"Entire (qualifier value)\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"whole\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ทั้งเม็ด\"}]}]}]}]}]}]");
  it.each([1, 2])("keeps independent water quantity before Swallow %s tablets", value => {
    const wire: FhirDosage[] = JSON.parse(JSON.stringify(savedPreparation));
    wire[0].doseAndRate![0].doseQuantity!.value = value;
    const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
    for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe(`${realizationMode === "roundtrip" ? "Measure 100 mL of water" : "Measure water 100 mL"}. Swallow ${value} tablet${value === 1 ? "" : "s"} whole.`);
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe(`ตวงน้ำ 100 มิลลิลิตร. กลืน ${value} เม็ดทั้งเม็ด.`);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(wire)).toBe(original);
  });

  it.each([
    "Dissolve 2 tablets in water, then drink slowly",
    "Disperse 2 tablets in water, then swallow slowly with water",
    "Measure 5 mL of medication; swallow",
    "Draw up 2 mL, then inject"
  ].flatMap(source => (source.startsWith("Draw up") ? ["mL"] : ["tab", "mg"]).map(unit => ({ source, unit })) ))(
    "keeps an actual preparation dose owner after an external edit: $source / $unit",
    ({ source, unit }) => {
      // Disperse is the existing institution-configured procedure control.
      const options: ParseOptions = source.startsWith("Disperse") ? { instructionActionMap: {
        disperse: { code: "disperse", display: "Disperse", semanticClass: "procedure", procedural: true,
          acceptsAmount: true, definesDose: true, argumentParser: "amount-material-destination",
          realizer: "amount-material-destination" }
      } } : {};
      const r6 = JSON.parse(JSON.stringify(parsePublicSig(source, options).fhirNext)) as FhirR6DosageInstruction;
      expect(r6.step).toHaveLength(1);
      expect(r6.step![0].component).toHaveLength(1);
      r6.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
      r6.step![0].component[0].doseAndRate![0].doseQuantity!.unit = unit;
      const original = JSON.stringify(r6), r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
      for (const input of [r6, r5, toDosageDetails(r5)]) {
        const before = JSON.stringify(input);
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { ...options, locale: "en", realizationMode });
          const amountPattern = unit === "tab" ? /(?:^|[^0-9.,+-])3 tablets(?![\p{L}\p{N}])/gu
            : unit === "mg" ? /(?:^|[^0-9.,+-])3 mg(?![\p{L}\p{N}])/gu
              : /(?:^|[^0-9.,+-])3 mL(?![\p{L}\p{N}])/gu;
          expect(text.match(amountPattern)).toHaveLength(1);
          expect(text).toMatch(new RegExp("^" + source.split(" ")[0]));
          const amount = unit === "tab" ? "3 tablets" : "3 " + unit;
          const preparation = text.split(/[.;]/u)[0];
          const administration = text.slice(preparation.length);
          const action = source.startsWith("Dissolve") ? /\bdrink\b/iu
            : source.startsWith("Draw up") ? /\binject\b/iu : /\bswallow\b/iu;
          expect(preparation).toMatch(amountPattern);
          expect(administration).toMatch(action);
          expect(administration).not.toContain(amount);
          expect(text).not.toMatch(/(?:^|[^0-9.])2 tablets?(?![a-z])/u);
          if (source.startsWith("Measure")) {
            expect(text).not.toMatch(/(?:^|[^0-9.])5 mL(?![a-z])/iu);
          }
          if (source.startsWith("Draw up")) {
            expect(text).not.toMatch(/(?:^|[^0-9.])2 mL(?![a-z])/iu);
          }
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(r6)).toBe(original);
    }
  );
});


describe("round50 configured safety action identity", () => {
  it.each(["defer", "clinic-defer"])("retains conditional advice under saved code %s", code => {
    const options: ParseOptions = { instructionActionMap: { defer: {
      code, display: "Defer", semanticClass: "procedure", procedural: true, safetyScopeTarget: true
    } } };
    const source = "Defer if BP >160";
    const parsed = parsePublicSig(source, options);
    expect(parsed.input).toBe(source);
    const advice = parsed.meta.canonical.clauses[0].additionalInstructions!;
    expect(advice).toHaveLength(1);
    expect(advice[0].text).toBe(source);
    expect(advice[0].frames).toHaveLength(1);
    expect(advice[0].frames![0].predicate.lemma).toBe(code);
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const extensions = Array.isArray(input) ? input[0].extension : input.step[0].component[0].extension;
      const savedGraph = parseInstructionGraphExtension(extensions);
      expect(savedGraph?.actions.map(action => action.predicate.lemma)).toEqual([code]);
      expect(savedGraph?.actions[0].predicate.codings).toContainEqual({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action", code, display: "Defer"
      });
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { ...options, locale: "en", realizationMode });
        expect(text).toMatch(/Defer if BP >\s*160(?![0-9]|[.][0-9])/u);
      }
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });
});


describe("round50 saved frame-level accompaniment ownership", () => {
  // Exact R5 graph fixtures produced by pinned master 7d628239.
  const savedRows: FhirDosage[][] = JSON.parse("[[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"sourceText\",\"valueString\":\"Swallow syrup with water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"syrup\"},{\"url\":\"normalized\",\"valueString\":\"syrup\"},{\"url\":\"conceptId\",\"valueString\":\"clinic-syrup\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"clinic-syrup\",\"display\":\"syrup\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"น้ำเชื่อม\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"clinic-syrup\",\"display\":\"syrup\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"น้ำเชื่อม\"}]}]}}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"syrup\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำเชื่อม\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]}]}]}]}],[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":18},{\"url\":\"sourceText\",\"valueString\":\"Swallow with water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]}]}]}]}]]");
  it.each([0, 1])("keeps the saved object and accompaniment distinct (fixture %s)", index => {
    const row = savedRows[index], original = JSON.stringify(row);
    const r6 = toDosageDetails(row), cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe(index === 0 ? "Swallow syrup with water." : "Swallow with water.");
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe(index === 0 ? "กลืนน้ำเชื่อมร่วมกับน้ำ." : "กลืนร่วมกับน้ำ.");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round51 saved dilution and patch facts", () => {
  it.each([
    [true, AdviceRelation.To, 10, "Do not dilute to 10 mL"],
    [false, AdviceRelation.To, 10, "Dilute to 10 mL"],
    [false, undefined, 1, "Dilute 1 mL"]
  ] as const)("retains the legacy head relation on its unmarked volume: %s / %s", (negated, relation, value, source) => {
    // Actual legacy shape: the relation is on the frame and the volume is Object.
    const frame = {
      force: negated ? AdviceForce.Warning : AdviceForce.Sequence,
      ...(negated ? { polarity: AdvicePolarity.Negate } : {}),
      predicate: { lemma: "dilute", semanticClass: "prepare", display: "Dilute",
        i18n: { th: "เจือจาง" }, codings: [{ system: "http://snomed.info/sct",
          code: "421399004", display: "Dilute - dosing instruction imperative" }] },
      relation, args: [{ role: AdviceArgumentRole.Object, text: value + " mL", normalized: value + " ml" }],
      span: { start: 0, end: source.length }, sourceText: source, sequenceIndex: 0
    };
    const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const raw: FhirDosage = { extension: [extension] };
    const before = JSON.stringify(raw), r6 = toDosageDetails([raw]);
    expect(realizeInstructionAction(frame, "en")).toBe(source);
    for (const input of [raw, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toContain(source);
        expect(th).toContain(value + " มิลลิลิตร");
        if (relation) expect(th).toContain("ไปยัง");
        else expect(th).not.toContain("ไปยัง");
        if (negated) expect(th).toContain("ห้าม");
      }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(r6)[0].extension?.find(e => e.url === extension.url)).toEqual(extension);
  });

  it.each([
    [undefined, undefined], [undefined, "right forearm"],
    [2, undefined], [2, "right forearm"]
  ] as const)("renders current patch quantity and site once while retaining the saved frame: %s / %s", (dose, site) => {
    const source = "Apply a new patch before breakfast";
    const frame = parseInstructionActions("Apply patch before breakfast")[0];
    frame.predicate.display = "Apply"; frame.sourceText = source;
    frame.span = { start: 0, end: source.length };
    frame.args = [
      { role: AdviceArgumentRole.Object, text: "a new patch", normalized: "a new patch", i18n: { th: "แผ่นแปะใหม่" } },
      ...(dose === undefined ? [] : [{ role: AdviceArgumentRole.Amount, text: "1 patch", quantity: { value: 1, unit: "patch" } }]),
      ...(site === undefined ? [] : [{ role: AdviceArgumentRole.Site, text: "left forearm", normalized: "left forearm" }]),
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
        relation: AdviceRelation.Before, i18n: { th: "อาหารเช้า" } }
    ];
    const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 5 }, actions: [frame] })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
      route: { coding: [{ system: "http://snomed.info/sct", code: "45890007", display: "Transdermal route" }] },
      timing: { repeat: { when: [EventTiming["Before Breakfast"]] } },
      ...(dose === undefined ? {} : { doseAndRate: [{ doseQuantity: { value: dose, unit: "patch" } }] }),
      ...(site === undefined ? {} : { site: { concept: { text: site } } }),
      extension: [extension]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toContain("a new patch"); expect(th).toContain("แผ่นแปะใหม่");
        expect(en.match(/before breakfast/gu)).toHaveLength(1);
        expect(th.match(/ก่อนอาหารเช้า/gu)).toHaveLength(1);
        if (dose !== undefined) {
          expect(en.match(/(?:^|[^0-9.])2 patch(?:es)?(?=[^a-z]|$)/gu)).toHaveLength(1);
          expect(th.match(/(?:^|[^0-9.])2 patch(?=[^a-z]|$)/gu)).toHaveLength(1);
          expect(en).not.toMatch(/(?:^|[^0-9.])1 patch/u);
          expect(th).not.toMatch(/(?:^|[^0-9.])1 patch/u);
        } else {
          expect(en).not.toMatch(/(?:^|[^0-9.])[12] patch/u);
          expect(th).not.toMatch(/(?:^|[^0-9.])[12] patch/u);
        }
        if (site) {
          expect(en.match(/right forearm/gu)).toHaveLength(1);
          expect(th.match(/ปลายแขนขวา/gu)).toHaveLength(1);
          expect(en).not.toContain("left forearm");
          expect(th).not.toContain("ปลายแขนซ้าย");
        }
      }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].extension?.find(e => e.url === extension.url)).toEqual(extension);
  });
});


describe("round55: current clinical facts and independent graph meaning", () => {
  const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (row: FhirDosage) => {
    const r6 = toDosageDetails(persisted([row]));
    return [row, r6, persisted(toFhirR5Dosages(r6))];
  };

  it.each(["clock", "code-only", "bedtime"] as const)(
    "uses live timing without reintroducing a QHS anchor: %s", variant => {
      const row: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QHS" }] },
          ...(variant === "code-only" ? {} : { repeat: { frequency: 1, period: 1, periodUnit: "d" as const,
            ...(variant === "clock" ? { timeOfDay: ["08:00:00"] } : { when: [EventTiming["Before Sleep"]] }) } }) }
      };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        const preview = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
        if (variant === "clock") {
          expect(preview).toContain("08:00");
          expect(preview).not.toMatch(/QHS|bedtime/iu);
        } else expect(preview).toMatch(/QHS|bedtime/iu);
      }
      expect(row.timing?.code?.coding).toEqual([{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QHS" }]);
      expect(JSON.stringify(row)).toBe(before);
    });

  it.each([false, true])("keeps a dilution condition separate from material complements: %s", withDestination => {
    const source = withDestination
      ? "Dilute 1 mL with saline to 10 mL if the solution is too thick"
      : "Dilute 1 mL if the solution is too thick";
    const parsed = parsePublicSig(source);
    const frame = parseInstructionActions(source)[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Destination).map(arg => arg.text))
      .toEqual(withDestination ? ["saline", "10 mL"] : []);
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 1, unit: "mL" });
    for (const input of [parsed.fhirNext, persisted(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/if the solution is too thick/gu)).toHaveLength(1);
        if (locale === "en") {
          if (realizationMode === "roundtrip") expect([source, source + "."]).toContain(text);
          else expect(text).toBe(source + ".");
        }
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true].flatMap(negated => [false, true].map(temporal => ({ negated, temporal }))))(
    "retains a Mix vehicle and independent event: $negated / $temporal", ({ negated, temporal }) => {
      const frame = persisted(parseInstructionActions(negated ? "Do not mix with milk" : "Mix with milk")[0]);
      frame.polarity = negated ? AdvicePolarity.Negate : AdvicePolarity.Affirm;
      delete frame.relation;
      frame.args = [{ role: AdviceArgumentRole.Substance, text: "milk", normalized: "milk",
        relation: AdviceRelation.With, i18n: { th: "นม" } },
        ...(temporal ? [{ role: AdviceArgumentRole.Activity, text: "each dose", normalized: "each dose",
          relation: AdviceRelation.Before, i18n: { th: "ยาแต่ละครั้ง" } }] : [])];
      const graph = { sourceText: (negated ? "Do not mix" : "Mix") + " with milk" + (temporal ? " before each dose" : ""),
        sourceLocale: "en", actions: [frame] };
      const extension = buildInstructionGraphExtension(graph)!;
      const row: FhirDosage = { extension: [extension] };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(text).toMatch(negated ? /^Do not mix with milk/u : /^Mix with milk/u);
        expect(text.match(/with milk/gu)).toHaveLength(1);
        expect(text.match(/before each dose/gu) ?? []).toHaveLength(temporal ? 1 : 0);
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(th).toContain("ด้วยนม");
        expect(th.includes("ห้าม")).toBe(negated);
        expect(th.match(/ก่อนยาแต่ละครั้ง/gu) ?? []).toHaveLength(temporal ? 1 : 0);
      }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.actions[0].args).toMatchObject(frame.args);
      expect(parseInstructionGraphExtension(row.extension)?.actions[0].args).toHaveLength(frame.args.length);
    });

  it.each([false, true].flatMap(guard => [false, true].map(preposed => ({ guard, preposed }))))(
    "keeps an independent primary condition beside a current guard: $guard / $preposed", ({ guard, preposed }) => {
      const actionText = "Swallow 1 tablet", conditionText = "if able to swallow";
      const frame = persisted(parseInstructionActions(actionText)[0]);
      const start = preposed ? conditionText.length + 2 : 0;
      frame.span = { start, end: start + actionText.length };
      const source = preposed ? conditionText + ", " + actionText : actionText + " " + conditionText;
      const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame],
        relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: conditionText,
          span: preposed ? { start: 0, end: conditionText.length } : { start: actionText.length + 1, end: source.length } }] })!;
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        method: { coding: [{ system: "http://snomed.info/sct", code: "421521009", display: "Swallow" }] }, extension: [extension] };
      if (guard) setDosageCondition(row, { kind: "measurement", name: "systolic BP", operation: "gt", value: 160,
        text: "systolic BP > 160" });
      const before = JSON.stringify(row);
      for (const input of views(row)) for (const locale of ["en", "th"])
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(/if able to swallow/giu)).toHaveLength(1);
          expect(text.match(/systolic BP > 160/gu) ?? []).toHaveLength(guard ? 1 : 0);
        }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.relations?.[0].text).toBe(conditionText);
    });

  it.each(["all", "any", "not", "opposite unless", "negative state"] as const)(
    "distinguishes a retained condition owner from an independent constraint: %s", variant => {
      const atom: MedicationCondition = { kind: "measurement", name: "systolic BP", operation: "gt",
        value: 140, text: "systolic BP > 160" };
      const awake: MedicationCondition = { kind: "state", name: "awake", expected: true, text: "awake" };
      const negative = variant === "not" || variant === "opposite unless" || variant === "negative state";
      const relationText = variant === "negative state" ? "unless nausea"
        : (negative ? "unless " : "if ") + "systolic BP > 160";
      const frame = persisted(parseInstructionActions("Swallow 1 tablet")[0]);
      const source = frame.sourceText + " " + relationText;
      const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame], relations: [{
          kind: negative ? AdviceRelation.Unless : AdviceRelation.If, toActionIndex: 0, text: relationText,
          span: { start: frame.sourceText.length + 1, end: source.length }
        }] })!;
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        method: { coding: [{ system: "http://snomed.info/sct", code: "421521009", display: "Swallow" }] },
        extension: [extension] };
      const condition: MedicationCondition = variant === "all" || variant === "any"
        ? { kind: variant, conditions: [atom, awake] } : variant === "not"
        ? { kind: "not", condition: atom } : variant === "negative state"
        ? { kind: "state", name: "nausea", text: "nausea", expected: false } : atom;
      setDosageCondition(row, condition);
      const before = JSON.stringify(row);
      for (const input of views(row)) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        if (variant === "negative state") {
          expect(text.match(/nausea/giu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "only if not nausea" : "เฉพาะเมื่อ ไม่ nausea");
          expect(text).not.toMatch(locale === "en" ? /only if\s+nausea/iu : /เฉพาะเมื่อ\s*nausea/u);
        } else {
          expect(text.match(/140/gu)).toHaveLength(1);
          // One OR arm does not subsume the independently required graph condition.
          expect(text.match(/160/gu) ?? []).toHaveLength(variant === "any" || variant === "opposite unless" ? 1 : 0);
          if (variant === "opposite unless") {
            expect(text).toMatch(/(?:unless|เว้นแต่)\s*systolic BP > 160/iu);
            expect(text).toMatch(locale === "en" ? /only if\s+systolic BP > 140/u : /เฉพาะเมื่อ\s*systolic BP > 140/u);
          } else if (variant === "not") {
            expect(text).toContain(locale === "en" ? "unless" : "เว้นแต่");
            expect(text).not.toContain(locale === "en" ? "only if" : "เฉพาะเมื่อ");
          } else if (variant === "all" || variant === "any") {
            const conjunction = locale === "en" ? (variant === "all" ? "and" : "or")
              : (variant === "all" ? "และ" : "หรือ");
            expect(text).toMatch(new RegExp("systolic BP > 140\\s+" + conjunction + "\\s+awake", "u"));
          }
        }
      }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.relations?.[0].text).toBe(relationText);
    });

  it.each(["existential", "state"] as const)("uses current restriction text over a retained inferred lemma: %s", form => {
    const row = persisted(parsePublicSig("Apply 1 g to skin where there is rash daily").fhir[0]);
    const marker = row.site!.extension!.find(item => item.url.endsWith("medication-body-site-restriction"))!;
    marker.extension!.find(item => item.url === "predicateText")!.valueString = "skin is itchy";
    marker.extension!.find(item => item.url === "predicateForm")!.valueCode = form;
    marker.extension!.push({ url: "urn:round55:restriction-note", valueString: "retain source annotation" });
    const original = persisted(marker), before = JSON.stringify(row);
    for (const input of views(row)) for (const locale of ["en", "th"])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/skin is itchy/gu)).toHaveLength(1);
        expect(text).not.toMatch(/rash|ผื่น/u);
      }
    expect(JSON.stringify(row)).toBe(before);
    expect(toFhirR5Dosages(toDosageDetails(persisted([row])))[0].site?.extension).toContainEqual(original);
  });

  it.each(["system", "version", "both"] as const)("preserves graph Coding primitive companions: %s", variant => {
    const coding = { system: "urn:round55:vehicle", version: "edition-1", code: "milk",
      ...(variant !== "version" ? { _system: { id: "system-source", extension: [{ url: "urn:round55:note", valueString: "system" }] } } : {}),
      ...(variant !== "system" ? { _version: { id: "edition-source" } } : {}),
      _code: { id: "code-source" } };
    const frame = persisted(parseInstructionActions("Mix with milk")[0]);
    frame.args = [{ role: AdviceArgumentRole.Substance, text: "milk", relation: AdviceRelation.With,
      coding, codings: [coding], i18n: { th: "นม" } }];
    const graph = { sourceText: "Mix with milk", sourceLocale: "en", actions: [frame] };
    const extension = buildInstructionGraphExtension(graph)!;
    const row: FhirDosage = { extension: [extension] };
    const before = JSON.stringify(graph);
    const decoded = parseInstructionGraphExtension(row.extension)!;
    expect(decoded.actions[0].args[0].coding).toEqual(coding);
    expect(decoded.actions[0].args[0].codings).toEqual([coding]);
    for (const input of views(row)) {
      const r5 = Array.isArray(input) ? input : "step" in input ? toFhirR5Dosages(input) : [input];
      const restored = parseInstructionGraphExtension(r5[0].extension)!;
      expect(restored.actions[0].args[0].coding).toEqual(coding);
      expect(restored.actions[0].args[0].codings).toEqual([coding]);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it.each([undefined, AdviceRelation.To])("renders an unmarked object-time daughter once: %s", relation => {
    const frame = persisted(parseInstructionActions("Apply patch in the morning")[0]);
    frame.relation = relation;
    frame.args = [
      { role: AdviceArgumentRole.Object, text: "patch", normalized: "patch", i18n: { th: "แผ่นแปะ" } },
      { role: AdviceArgumentRole.Time, text: "morning", normalized: "MORN", i18n: { th: "ตอนเช้า" } }
    ];
    const extension = buildInstructionGraphExtension({ sourceText: "Apply patch in the morning", sourceLocale: "en",
      primaryAdministrationSpan: frame.span, actions: [frame] })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "patch" } }],
      timing: { repeat: { when: [EventTiming.Morning] } }, extension: [extension]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const english = formatSig(input, "long", { locale: "en", realizationMode });
        const thai = formatSig(input, "long", { locale: "th", realizationMode });
        expect(english.match(/morning/gu)).toHaveLength(1);
        expect(thai.match(/(?:ตอน)?เช้า/gu)).toHaveLength(1);
        // The primary object and its explicit numeric-dose annotation are distinct spans.
        expect(english.match(/\(1 patch\)/gu)).toHaveLength(1);
        expect(english.replace("(1 patch)", "").match(/\bpatch\b/gu)).toHaveLength(1);
        expect(thai.match(/\b1 patch\b/gu)).toHaveLength(1);
        expect(thai.replace("1 patch", "").match(/แผ่นแปะ/gu)).toHaveLength(1);
      }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([
    { name: "right coding", code: "1290032005", text: "both eyes", count: undefined, expected: 1 },
    { name: "matching bilateral", code: undefined, text: "both eyes", count: undefined, expected: 2 },
    { name: "independent count", code: "1290032005", text: "both eyes", count: 2, expected: 2 },
    { name: "unknown code", code: "clinic-eyes", text: "both eyes", count: undefined, expected: 2 }
  ])("uses the resolved site for inferred discrete supply: $name", ({ code, text, count, expected }) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text, ...(code ? { coding: [{ system: code === "clinic-eyes" ? "urn:clinic:site" : "http://snomed.info/sct", code }] } : {}),
        ...(count ? { extension: [{ url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL, valueInteger: count }] } : {}) } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: "d" } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z",
        durationValue: 1, durationUnit: "d", timeZone: "UTC" }).totalUnits).toBe(expected);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      if (code === "1290032005") {
        expect(text).toContain("right eye");
        expect(text).not.toContain("both eyes");
      }
      if (expected === 1) expect(text).not.toContain("across 2 sites");
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.text).toBe(text);
  });

  it.each([
    { text: "upper outer right arm", code: "302538001" },
    { text: "right arm where irritated", code: "368209003" }
  ])("preserves a qualified site with a coarser coding: $text", ({ text, code }) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text, coding: [{ system: "http://snomed.info/sct", code }] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "patch" } }]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))])
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain(text);
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.text).toBe(text);
  });

  it("prefers the same known clinical site with an independent coding first", () => {
    const codings = [{ system: "urn:round55:clinic-site", code: "local-eye" },
      { system: "http://snomed.info/sct", code: "1290032005" }];
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text: "both eyes", coding: codings } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: "d" } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      const preview = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(preview).toContain("right eye");
      expect(preview).not.toContain("both eyes");
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z",
        durationValue: 1, durationUnit: "d", timeZone: "UTC" }).totalUnits).toBe(1);
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.coding).toEqual(codings);
  });

  it.each(["en", "th"] as const)("renders a maximum-only administration in the long %s preview", locale => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat: { countMax: 3 } } }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
        .toBe(locale === "en" ? "Use the medication for up to 3 doses." : "ใช้ยา ไม่เกิน 3 ครั้ง.");
    }
    expect(JSON.stringify(raw)).toBe(before);
    const repeat = toFhirR5Dosages(raw)[0].timing?.repeat;
    expect(repeat?.countMax).toBe(3);
    expect(repeat?.count).toBeUndefined();
    expect(repeat?._count?.extension).toContainEqual({
      url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown"
    });
  });
});

describe("independent action accompaniments", () => {
  it("keeps independently related liquids on a timed site action", () => {
    const source = "Rinse mouth with water before breakfast";
    const frame: AdviceFrame = {
      force: AdviceForce.Sequence, predicate: parseInstructionActions("Rinse")[0].predicate,
      relation: AdviceRelation.Before, sequenceIndex: 0, sourceText: source,
      span: { start: 0, end: source.length },
      args: [
        { role: AdviceArgumentRole.Site, text: "mouth", normalized: "mouth", i18n: { th: "ปาก" } },
        { role: AdviceArgumentRole.Substance, text: "water", normalized: "water",
          relation: AdviceRelation.With, i18n: { th: "น้ำ" } },
        { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
          relation: AdviceRelation.Before, i18n: { th: "อาหารเช้า" } }
      ]
    };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: [frame]
    })!] };
    for (const input of [row, toDosageDetails([row])]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Rinse mouth with water before breakfast.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ล้างปากด้วยน้ำก่อนอาหารเช้า.");
    }
  });

  it.each([false, true])("keeps every explicit accompaniment and its relation (reverse %s)", reverse => {
    const source = "Swallow 1 tablet with water without food";
    const companions: AdviceFrame["args"] = [
      { role: AdviceArgumentRole.Substance, text: "water", normalized: "water",
        relation: AdviceRelation.With, i18n: { th: "น้ำ" } },
      { role: AdviceArgumentRole.Substance, text: "food", normalized: "food",
        relation: AdviceRelation.Without, i18n: { th: "อาหาร" } }
    ];
    const frame: AdviceFrame = {
      force: AdviceForce.Sequence, predicate: parseInstructionActions("Swallow")[0].predicate,
      relation: AdviceRelation.With, sequenceIndex: 0, sourceText: source,
      span: { start: 0, end: source.length },
      args: [
        { role: AdviceArgumentRole.Amount, text: "1 tablet", normalized: "tab", quantity: { value: 1, unit: "tab" } },
        ...(reverse ? companions.reverse() : companions)
      ]
    };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: [frame]
    })!] };
    for (const input of [row, toDosageDetails([row])]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(reverse ? "Swallow 1 tablet without food with water." : "Swallow 1 tablet with water without food.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe(reverse ? "กลืน 1 เม็ดโดยไม่มีอาหารร่วมกับน้ำ." : "กลืน 1 เม็ดร่วมกับน้ำโดยไม่มีอาหาร.");
    }
  });
});


describe("negative meal complements with articles", () => {
  it.each(["without a meal", "without the meal"])("retains %s without inventing a meal anchor", accompaniment => {
    const source = "Take 1 tablet daily " + accompaniment, parsed = parseCompleteSig(source);
    expect(parsed.meta.canonical.clauses[0].dose).toEqual({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toBeUndefined();
    for (const input of [parsed.fhir, parsed.fhirNext]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain(accompaniment);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .not.toContain("with meals");
    }
    expect(parsed.fhir[0].timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });
});
