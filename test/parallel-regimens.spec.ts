import { describe, expect, it } from "vitest";
import {
  parseSig, parseSigAsync, lintSig, nextDueDoses, calculateTotalUnits,
  toDosageDetails, toFhirR5Dosages, fromFhir, getDosageCondition
} from "../src";
import { createBoundaryPlan } from "../src/regimen/candidate-adapter";
import { projectParallelRegimen } from "../src/regimen/parallel-course";

const twoSites =
  "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
const orderedAt = "2026-10-19T08:00:00+07:00";
const options = (from: string, limit = 8) => ({
  from, orderedAt, timeZone: "Asia/Bangkok", limit
});

describe("concurrent independent treatment sequences", () => {
  it("separates two independently dosed semicolon clauses without leaking site inheritance", () => {
    const parsed = parseSig(twoSites);
    expect(parsed.count).toBe(4);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.sequence)).toEqual([1, 2, 1, 2]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(lintSig(twoSites).issues).toEqual([]);
  });

  it("forms global steps with both concurrent sites, never a falsely global four-step taper", () => {
    const parsed = parseSig(twoSites);
    expect(parsed.fhir).toHaveLength(6);
    expect(parsed.fhir.map(dosage => dosage.sequence)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(parsed.fhir.map(dosage => dosage.site?.text)).toEqual([
      "right eye", "left eye", "right eye", "left eye", "right eye", "left eye"
    ]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2, 2]);
    expect(parsed.fhirNext.step.map(step => step.end?.offsetDuration?.value))
      .toEqual([7, 1, undefined]);
    expect(parsed.fhirNext.step.map(step => step.end?.offsetDuration?.code))
      .toEqual(["d", "mo", undefined]);
    expect(parsed.fhirNext.step[1].start?.contextCode?.coding?.[0]?.code)
      .toBe("treatment-start");
    expect(parsed.fhirNext.step[2].start?.offsetDuration?.code).toBe("mo");
    expect(parsed.fhirNext.step[0].component[0].timing?.repeat?.boundsDuration)
      .toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(twoSites);
  });

  it("preserves relative stage boundaries through the standalone flat object and strict R5 conversion", () => {
    const parsed = parseSig(twoSites);
    expect(toDosageDetails(parsed.fhir)).toEqual(parsed.fhirNext);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhir))).toEqual(parsed.fhirNext);
    const restored = fromFhir(JSON.parse(JSON.stringify(parsed.fhirNext)));
    expect(restored.fhirNext).toEqual(parsed.fhirNext);
    expect(restored.course?.step?.map(step => step.sequence)).toEqual([1, 2, 3]);
    expect(toDosageDetails(restored.fhir)).toEqual(parsed.fhirNext);
  });

  it("schedules the overlapping administrations before and after the first transition", () => {
    const parsed = parseSig(twoSites);
    expect(nextDueDoses(parsed, options(orderedAt))).toEqual([
      "2026-10-19T08:00:00+07:00", "2026-10-19T08:00:00+07:00",
      "2026-10-19T10:00:00+07:00",
      "2026-10-19T12:00:00+07:00", "2026-10-19T12:00:00+07:00",
      "2026-10-19T14:00:00+07:00",
      "2026-10-19T16:00:00+07:00", "2026-10-19T16:00:00+07:00"
    ]);
    expect(nextDueDoses(parsed, options("2026-10-26T06:00:00+07:00", 3))).toEqual([
      "2026-10-26T06:00:00+07:00",
      "2026-10-26T08:00:00+07:00", "2026-10-26T08:00:00+07:00"
    ]);
    expect(nextDueDoses(parsed, options("2026-10-26T08:00:00+07:00", 4))).toEqual([
      "2026-10-26T08:00:00+07:00", "2026-10-26T08:00:00+07:00",
      "2026-10-26T12:00:00+07:00", "2026-10-26T12:00:00+07:00"
    ]);
  });

  it("switches only the second site at the calendar-month boundary", () => {
    const parsed = parseSig(twoSites);
    expect(nextDueDoses(parsed, options("2026-11-18T20:00:00+07:00", 6))).toEqual([
      "2026-11-18T20:00:00+07:00", "2026-11-18T20:00:00+07:00",
      "2026-11-19T08:00:00+07:00", "2026-11-19T08:00:00+07:00",
      "2026-11-19T12:00:00+07:00",
      "2026-11-19T16:00:00+07:00"
    ]);
    expect(nextDueDoses(parsed, options("2026-11-19T12:00:00+07:00", 4))).toEqual([
      "2026-11-19T12:00:00+07:00",
      "2026-11-19T16:00:00+07:00",
      "2026-11-19T20:00:00+07:00", "2026-11-19T20:00:00+07:00"
    ]);
    for (const from of [orderedAt, "2026-10-26T08:00:00+07:00", "2026-11-19T12:00:00+07:00"]) {
      const expected = nextDueDoses(parsed, options(from));
      expect(nextDueDoses(parsed.fhir, options(from))).toEqual(expected);
      expect(nextDueDoses(parsed.fhirNext, options(from))).toEqual(expected);
      expect(nextDueDoses(toFhirR5Dosages(parsed.fhirNext), options(from))).toEqual(expected);
    }
  });

  it("does not conflate one calendar month with four weeks at month-end", () => {
    const parsed = parseSig(twoSites);
    const start = "2027-01-31T08:00:00+07:00";
    const request = (from: string) => ({
      from, orderedAt: start, timeZone: "Asia/Bangkok", limit: 4
    });
    expect(nextDueDoses(parsed, request("2027-02-27T20:00:00+07:00"))).toEqual([
      "2027-02-27T20:00:00+07:00", "2027-02-27T20:00:00+07:00",
      "2027-02-28T08:00:00+07:00", "2027-02-28T08:00:00+07:00"
    ]);
    expect(nextDueDoses(parsed, request("2027-02-28T12:00:00+07:00"))).toEqual([
      "2027-02-28T12:00:00+07:00", "2027-02-28T16:00:00+07:00",
      "2027-02-28T20:00:00+07:00", "2027-02-28T20:00:00+07:00"
    ]);
  });

  it("works for different routes and independent positions, not just eye labels", () => {
    const input =
      "1 tab PO BID x1wk then QD; 2 tabs PO TID x2wk then BID";
    const parsed = parseSig(input);
    expect(parsed.warnings).toContainEqual(expect.stringContaining("QD"));
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2, 2]);
    expect(parsed.fhirNext.step.map(step => step.end?.offsetDuration?.value))
      .toEqual([7, 14, undefined]);
    expect(parsed.fhir.map(item => item.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 2, 1, 2, 1, 2]);
  });

  it("handles coincident transition times without creating redundant global stages", () => {
    const parsed = parseSig(
      "1 drop OD QID x7d then BID; 1 drop OS QID x1wk then BID"
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhir.map(item => item.sequence)).toEqual([1, 1, 2, 2]);
    expect(parsed.fhirNext.step[0].end?.offsetDuration?.value).toBe(7);
  });

  it("is independent of the order in which the tracks are written", () => {
    const alternate =
      "1 drop OS qid x1mo then bid; 1 drop OD q2h x1wk then qid";
    const parsed = parseSig(alternate);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhirNext.step).toHaveLength(3);
    expect(parsed.fhirNext.step[0].end?.offsetDuration?.value).toBe(7);
    expect(parsed.fhirNext.step[1].end?.offsetDuration?.code).toBe("mo");
    expect(nextDueDoses(parsed, options("2026-11-19T12:00:00+07:00", 4)))
      .toEqual(nextDueDoses(parseSig(twoSites), options("2026-11-19T12:00:00+07:00", 4)));
  });

  it("intersects absolute start/end dates with relative track steps in every wire format", () => {
    const cases = [
      {
        text: "1 drop OD QID x7d then BID; 1 drop OS QID until 2026-11-01",
        count: 130, bounds: { end: "2026-11-01" }
      },
      {
        text: "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 until 2026-11-01",
        count: 106, bounds: { start: "2026-10-25", end: "2026-11-01" }
      },
      {
        text: "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 for 7 days",
        count: 102, bounds: { start: "2026-10-25", end: "2026-10-31" }
      }
    ];
    const onlyRelative = parseSig("1 drop OD QID x7d then BID");
    for (const { text, count, bounds } of cases) {
      const parsed = parseSig(text);
      expect(parsed.count).toBe(3);
      expect(parsed.warnings).toEqual([]);
      expect(lintSig(text).issues).toEqual([]);
      expect(parsed.fhirNext.step).toHaveLength(2);
      expect(parsed.fhirNext.step[0].end?.offsetDuration?.value).toBe(7);
      // The SAME independently dated left-eye component survives each cut.
      for (const step of parsed.fhirNext.step) {
        const left = step.component.find(dosage => dosage.site?.concept?.text === "left eye");
        expect(left?.timing?.repeat?.boundsPeriod).toEqual(bounds);
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(toDosageDetails(strict)).toEqual(parsed.fhirNext);
      expect(toDosageDetails(parsed.fhir)).toEqual(parsed.fhirNext);
      expect(fromFhir(JSON.parse(JSON.stringify(parsed.fhirNext))).fhirNext)
        .toEqual(parsed.fhirNext);
      for (const dosage of [parsed, parsed.fhir, parsed.fhirNext, strict]) {
        const supply = calculateTotalUnits({
          dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
          durationValue: 30, durationUnit: "d"
        });
        expect(supply.totalUnits).toBe(count);
        const after = nextDueDoses(dosage, options("2026-11-02T08:00:00+07:00", 12));
        expect(after).toEqual(nextDueDoses(
          onlyRelative, options("2026-11-02T08:00:00+07:00", 12)
        ));
      }
    }
  });

  it("honors a calendar track starting before the relative treatment anchor", () => {
    const source =
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-15 until 2026-10-25";
    const parsed = parseSig(source);
    expect(parsed.warnings).toEqual([]);
    const start = "2026-10-15T08:00:00+07:00";
    const expectedFirst = [
      "2026-10-15T08:00:00+07:00",
      "2026-10-15T12:00:00+07:00",
      "2026-10-15T16:00:00+07:00",
      "2026-10-15T20:00:00+07:00"
    ];
    const formats = [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)];
    for (const dosage of formats) {
      expect(nextDueDoses(dosage, {
        from: start, orderedAt, timeZone: "Asia/Bangkok", limit: 4
      })).toEqual(expectedFirst);
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 30, durationUnit: "d"
      }).totalUnits).toBe(110);
    }
  });

  it("rejects inverted absolute bounds on imported R6 and strict R5 courses", () => {
    const parsed = parseSig(
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 until 2026-11-01"
    );
    const invalid = JSON.parse(JSON.stringify(parsed.fhirNext)) as typeof parsed.fhirNext;
    for (const step of invalid.step) {
      const left = step.component.find(c => c.site?.concept?.text === "left eye")!;
      left.timing!.repeat!.boundsPeriod = {
        start: "2026-11-05", end: "2026-11-01"
      };
    }
    for (const dosage of [invalid, toFhirR5Dosages(invalid)]) {
      expect(() => nextDueDoses(dosage, options(orderedAt)))
        .toThrow(/calendar component end precedes its start/i);
      expect(() => calculateTotalUnits({
        dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 30, durationUnit: "d"
      })).toThrow(/ends before its stated start date/i);
    }
  });

  it("keeps exact-dated calendar phases sequential across an independent taper", () => {
    const inputVariants = [
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 until 2026-10-31 then BID from 2026-11-01",
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 then BID from 2026-11-01"
    ];
    for (const input of inputVariants) {
      const parsed = parseSig(input);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.fhirNext.step).toHaveLength(2);
      for (const step of parsed.fhirNext.step) {
        const left = step.component.filter(d => d.site?.concept?.text === "left eye");
        expect(left).toHaveLength(2);
        expect(left[0].timing?.repeat?.boundsPeriod)
          .toEqual({ start: "2026-10-25", end: "2026-10-31" });
        expect(left[1].timing?.repeat?.boundsPeriod)
          .toEqual({ start: "2026-11-01" });
      }
      const strict = toFhirR5Dosages(parsed.fhirNext);
      expect(toDosageDetails(strict)).toEqual(parsed.fhirNext);
      for (const dosage of [parsed, parsed.fhir, parsed.fhirNext, strict]) {
        expect(calculateTotalUnits({
          dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
          durationValue: 30, durationUnit: "d"
        }).totalUnits).toBe(136);
      }
    }
  });

  it("derives successive calendar phase dates from an anchored duration", () => {
    const text =
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 for 7 days then BID x7d";
    const parsed = parseSig(text);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhirNext.step).toHaveLength(2);
    for (const step of parsed.fhirNext.step) {
      const left = step.component.filter(c => c.site?.concept?.text === "left eye");
      expect(left).toHaveLength(2);
      expect(left[0].timing?.repeat?.boundsPeriod)
        .toEqual({ start: "2026-10-25", end: "2026-10-31" });
      expect(left[1].timing?.repeat?.boundsPeriod)
        .toEqual({ start: "2026-11-01", end: "2026-11-07" });
    }
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)]) {
      const result = calculateTotalUnits({
        dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 30, durationUnit: "d"
      });
      expect(result.totalUnits).toBe(116);
      const due = nextDueDoses(dosage, options("2026-11-08T08:00:00+07:00", 8));
      expect(due).toEqual(nextDueDoses(
        parseSig("1 drop OD QID x7d then BID"),
        options("2026-11-08T08:00:00+07:00", 8)
      ));
    }
  });

  it("keeps an interval-cadence origin across relative step boundaries", () => {
    const parsed = parseSig(
      "1 drop OD QID x7d then BID; 1 drop OS QID from 2026-10-25 until 2026-11-05"
    );
    expect(parsed.warnings).toEqual([]);
    // Model an exact every-second-day 08:00 schedule in both global steps.
    for (const step of parsed.fhirNext.step) {
      const left = step.component.find(d => d.site?.concept?.text === "left eye")!;
      const repeat = left.timing!.repeat!;
      repeat.frequency = 1;
      repeat.period = 2;
      repeat.periodUnit = "d";
      repeat.timeOfDay = ["08:00:00"];
      delete left.timing!.code;
    }
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const request = options("2026-10-26T08:00:00+07:00", 10);
    const expected = [
      "2026-10-26T08:00:00+07:00", "2026-10-26T20:00:00+07:00",
      "2026-10-27T08:00:00+07:00", "2026-10-27T08:00:00+07:00",
      "2026-10-27T20:00:00+07:00",
      "2026-10-28T08:00:00+07:00", "2026-10-28T20:00:00+07:00",
      "2026-10-29T08:00:00+07:00", "2026-10-29T08:00:00+07:00",
      "2026-10-29T20:00:00+07:00"
    ];
    expect(nextDueDoses(parsed.fhirNext, request)).toEqual(expected);
    expect(nextDueDoses(strict, request)).toEqual(expected);
    expect(calculateTotalUnits({
      dosage: parsed.fhirNext, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
      durationValue: 30, durationUnit: "d"
    }).totalUnits).toBe(80);
    expect(calculateTotalUnits({
      dosage: strict, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
      durationValue: 30, durationUnit: "d"
    }).totalUnits).toBe(80);
  });

  it("keeps a total countMax cap across unrelated parallel step boundaries", () => {
    const parsed = parseSig(
      "1 drop OD QID x7d then BID x7d then QD; 1 drop OS QID x7d then q5min max 3 doses"
    );
    expect(parsed.warnings).toContainEqual(expect.stringContaining("QD"));
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const forms = [parsed, parsed.fhir, parsed.fhirNext, strict];
    const expected = [
      "2026-11-01T20:00:00+07:00",
      "2026-11-02T09:00:00+07:00",
      "2026-11-03T09:00:00+07:00",
      "2026-11-04T09:00:00+07:00",
      "2026-11-05T09:00:00+07:00",
      "2026-11-06T09:00:00+07:00"
    ];
    for (const dosage of forms) {
      expect(nextDueDoses(dosage,
        options("2026-11-01T20:00:00+07:00", 6))).toEqual(expected);
      expect(calculateTotalUnits({
        dosage, from: orderedAt, orderedAt, timeZone: "Asia/Bangkok",
        durationValue: 21, durationUnit: "d"
      }).totalUnits).toBe(80);
    }
  });

  it("preserves calendar-month clamping alongside an independent dated track", () => {
    const start = "2027-01-31T08:00:00+07:00";
    const input = "1 drop OD QID x1mo then BID; 1 drop OS QID from 2027-02-14 until 2027-03-08";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhirNext.step[0].end?.offsetDuration)
      .toMatchObject({ value: 1, code: "mo" });
    const forms = [parsed, parsed.fhir, parsed.fhirNext,
      toFhirR5Dosages(parsed.fhirNext)];
    for (const dosage of forms) {
      const mid = nextDueDoses(dosage, {
        from: "2027-02-28T08:00:00+07:00", orderedAt: start,
        timeZone: "Asia/Bangkok", limit: 8
      });
      expect(mid).toContain("2027-02-28T08:00:00+07:00");
      expect(calculateTotalUnits({
        dosage, from: start, orderedAt: start, timeZone: "Asia/Bangkok",
        durationValue: 45, durationUnit: "d"
      }).totalUnits).toBe(238);
    }
  });

  it("stops an entirely finite parallel course without creating an empty phantom stage", () => {
    const parsed = parseSig(
      "1 drop OD QID x7d then BID x7d; 1 drop OS QID x14d"
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fhirNext.step).toHaveLength(2);
    expect(parsed.fhirNext.step.map(step => step.end?.offsetDuration?.value))
      .toEqual([7, 14]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2]);
    expect(nextDueDoses(parsed, options("2026-11-02T08:00:00+07:00")))
      .toEqual([]);
  });

  it("keeps both finite tracks when their month and week transitions do not coincide", () => {
    const input = "1 drop OD q2h x4wk then QID; 1 drop OS QID x1mo then BID";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1, 1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.code?.text))
      .toEqual(["Q2H", "QID", "QID", "BID"]);
    expect(parsed.items[0].fhir.timing?.repeat?.boundsDuration)
      .toMatchObject({ value: 4, code: "wk" });
    expect(parsed.items[2].fhir.timing?.repeat?.boundsDuration)
      .toMatchObject({ value: 1, code: "mo" });
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2]);
    expect(lintSig(input).issues).toEqual([]);
  });

  it("preserves an unbounded transition for editing and schedules only the known prefix", () => {
    const input = "1 drop OD q2h then QID; 1 drop OS QID x1mo then BID";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.timing?.code?.text))
      .toEqual(["Q2H", "QID", "QID", "BID"]);
    expect(lintSig(input).issues).toEqual([]);
    expect(nextDueDoses(parsed, options(orderedAt))).toEqual([
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T08:00:00+07:00",
      "2026-10-19T10:00:00+07:00",
      "2026-10-19T12:00:00+07:00",
      "2026-10-19T12:00:00+07:00",
      "2026-10-19T14:00:00+07:00",
      "2026-10-19T16:00:00+07:00",
      "2026-10-19T16:00:00+07:00"
    ]);
  });

  it("parses a conditional later phase in an independent eye taper", () => {
    const input =
      "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid only if BP >160";
    const parsed = parseSig(input);
    expect(parsed.count).toBe(4);
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.doseAndRate?.[0]?.doseQuantity?.value))
      .toEqual([1, 1, 1, 1]);
    expect(parsed.items.map(item => item.fhir.timing?.code?.text))
      .toEqual(["Q2H", "QID", "QID", "BID"]);
    expect(getDosageCondition(parsed.items[3].fhir)).toMatchObject({
      kind: "measurement", name: "bp", operation: "gt", value: 160
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    const leftBidComponent = parsed.fhirNext.step
      .flatMap(step => step.component)
      .find(component =>
        component.site?.concept?.text === "left eye" &&
        component.timing?.code?.text === "BID");
    expect(leftBidComponent?.condition?.[0]).toMatchObject({
      operation: "gt", valueQuantity: { value: 160 }
    });
    expect(lintSig(input).issues).toEqual([]);
  });

  it("uses the query start as a provisional anchor when the original treatment start is unavailable", () => {
    const parsed = parseSig(twoSites);
    expect(nextDueDoses(parsed, {
      from: "2026-11-19T08:00:00+07:00", timeZone: "Asia/Bangkok", limit: 6
    })).toEqual([
      "2026-11-19T08:00:00+07:00",
      "2026-11-19T08:00:00+07:00",
      "2026-11-19T10:00:00+07:00",
      "2026-11-19T12:00:00+07:00",
      "2026-11-19T12:00:00+07:00",
      "2026-11-19T14:00:00+07:00"
    ]);
  });

  it("does not split procedural instructions or ordinary concurrent dosing into invented steps", () => {
    expect(parseSig("1 tab PO BID; 2 tabs PO HS").fhirNext.step).toHaveLength(1);
    const procedural = parseSig("gargle 10 mL then spit; do not swallow");
    expect(procedural.fhirNext.step).toHaveLength(1);
    expect(procedural.warnings.some(message =>
      message.includes("parallel-regimen")
    )).toBe(false);
  });

  it("gives the same course and dosage semantics via the asynchronous entry point", async () => {
    const normal = parseSig(twoSites);
    const asyncResult = await parseSigAsync(twoSites);
    expect(asyncResult.fhir).toEqual(normal.fhir);
    expect(asyncResult.fhirNext).toEqual(normal.fhirNext);
    expect(asyncResult.course).toEqual(normal.course);
    expect(asyncResult.warnings).toEqual(normal.warnings);
  });
});
