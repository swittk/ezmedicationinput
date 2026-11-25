import { projectCanonicalCourse } from "../src/index";
import { describe, expect, it } from "vitest";
import {
  parseSig, parseSigAsync, lintSig, nextDueDoses, calculateTotalUnits, formatSig,
  toDosageDetails, toFhirR5Dosages, fromFhir, fromFhirDosage, getDosageCondition, importCanonicalCourse, FhirPeriodUnit
} from "../src";
import { createBoundaryPlan } from "../src/regimen/planner";
import { PARALLEL_COMPONENT_PHASE_ORIGIN_URL } from "../src/dosage-course";
import { shiftCanonicalSigClauses } from "../src/ir";
import { administrationFromClause, courseFromAdministrations, courseFromPartialParallel } from "../src/canonical/compile";
import { parseClauseState } from "../src/parser";
import {
  buildCanonicalParallelRegimen
} from "../src/regimen/parallel-course";
import {
  buildRegimenGraph, scopeSequentialPhaseSemantics, expandRegimenAdjustmentPhases
} from "../src/regimen/regimen";
import { normalizeClock } from "../src/execution/calendar";
import { lexInput } from "../src/lexer/lex";
import { anchoredScheduleDurationEnd } from "../src/regimen/regimen";
import { projectParallelRegimen } from "../src/regimen/parallel-course";
import { clauseForAdministration } from "../src/canonical/compile";
import { courseToR5 } from "../src/adapters/canonical-course";
import { courseToR6 } from "../src/adapters/canonical-course";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { toEzDosages } from "../src/index";
import { TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src/index";
import type { CanonicalAdministration } from "../src/canonical/course";
import type { CanonicalCourse } from "../src/canonical/course";
import type { CanonicalBoundary } from "../src/canonical/course";
import { EventTiming } from "../src/types";
import { FhirDayOfWeek } from "../src/types";
import { FhirPeriodUnit as Unit } from "../src/types";
import type { FhirDosage } from "../src/types";
import type { FhirR6DosageInstruction } from "../src/types";
import { describe as round38_execution20_describe } from "vitest";
import { expect as round38_execution20_expect } from "vitest";
import { it as round38_execution20_it } from "vitest";
import { calculateTotalUnits as round38_execution20_calculateTotalUnits } from "../src/index";
import { nextDueDoses as round38_execution20_nextDueDoses } from "../src/index";
import { parseSig as round38_execution20_parseSig } from "../src/index";
import { toFhirR5Dosages as round38_execution20_toFhirR5Dosages } from "../src/index";
import type { CanonicalAdministration as round38_execution20_CanonicalAdministration } from "../src/canonical/course";
import type { CanonicalCourse as round38_execution20_CanonicalCourse } from "../src/canonical/course";
import { FhirPeriodUnit as round38_execution20_FhirPeriodUnit } from "../src/types";
import type { FhirDosage as round38_execution20_FhirDosage } from "../src/types";
import type { FhirR6DosageInstruction as round38_execution20_FhirR6DosageInstruction } from "../src/types";
import { addCalendarDaysAtClock as round38_execution20_addCalendarDaysAtClock } from "../src/execution/calendar";
import { addCalendarMonths as round38_execution20_addCalendarMonths } from "../src/execution/calendar";
import { getTimeParts as round38_execution20_getTimeParts } from "../src/execution/calendar";
import { parseSig as parsePublicSig } from "../src/index";

const twoSites =
  "1 drop OD q2h x1wk then qid; 1 drop OS qid x1mo then bid";
const orderedAt = "2026-10-19T08:00:00+07:00";
const options = (from: string, limit = 8) => ({
  from, orderedAt, timeZone: "Asia/Bangkok", limit
});

describe("concurrent independent treatment sequences", () => {

  it.each([
    "Apply 1 drop right eye at 08:00, wait 5 minutes, then left eye",
    "Instill 1 drop right eye at 08:00, wait 5 minutes, then 2 drops left eye"
  ])("keeps delayed target's inherited clock evidence at its original full-source span: %s", input => {
    const result = parseSig(input);
    expect(result.meta.canonical.clauses).toHaveLength(2);
    const donor = result.meta.canonical.clauses[0];
    const recipient = result.meta.canonical.clauses[1];
    const expectedStart = input.indexOf("08:00");
    const original = donor.schedule?.evidence?.find(e => e.rule === "hpsg.lex.schedule.timeOfDay");
    const inherited = recipient.schedule?.evidence?.find(e => e.rule === "hpsg.lex.schedule.timeOfDay");
    expect(original?.spans[0]).toMatchObject({ start: expectedStart, text: "08:00," });
    expect(inherited?.spans[0]).toMatchObject({ start: expectedStart, text: "08:00," });
    for (const span of inherited?.spans ?? []) {
      expect(input.slice(span.start, span.end)).toBe(span.text);
    }
  });



  it("preserves predecessor dose, method, route and site provenance across a PRN successor", () => {
    const source = "Instill 1 drop right eye at 08:00 for 7 days then as needed for pain";
    const plan = createBoundaryPlan(source);
    expect(plan.segments).toHaveLength(2);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const donor = states[0].primaryClause;
    const recipient = states[1].primaryClause;
    const graph = buildRegimenGraph(plan, plan.segments, states);
    expect(graph.sequences).toHaveLength(1);
    graph.sequences[0].relation.semanticLicense = "dose-continuation";
    expect(recipient.prn?.enabled).toBe(true);
    const evidence = (fragment: string) => {
      const start = plan.segments[0].text.indexOf(fragment);
      expect(start).toBeGreaterThanOrEqual(0);
      return [{ rule: "test.inherited-source", spans: [
        { start, end: start + fragment.length, text: fragment }
      ] }];
    };
    expect(donor.dose).toBeDefined();
    expect(donor.method).toBeDefined();
    expect(donor.route).toBeDefined();
    expect(donor.site).toBeDefined();
    donor.dose!.evidence = evidence("1 drop");
    donor.method!.evidence = evidence("Instill");
    donor.route!.evidence = evidence("Instill");
    donor.site!.evidence = evidence("right eye");
    const siteStart = plan.segments[0].text.indexOf("right eye");
    donor.site!.range = { start: siteStart, end: siteStart + "right eye".length };
    const originals = [donor.dose, donor.method, donor.route, donor.site]
      .map(value => value!.evidence![0].spans[0].start);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
    for (const field of ["dose", "method", "route", "site"] as const) {
      const value = recipient[field];
      expect(value?.evidence, field).toHaveLength(1);
      const span = value!.evidence![0].spans[0];
      const fullStart = span.start + plan.segments[1].start;
      expect(source.slice(fullStart, fullStart + span.text.length), field).toBe(span.text);
    }
    shiftCanonicalSigClauses([recipient], plan.segments[1].start);
    expect(source.slice(recipient.site!.range!.start, recipient.site!.range!.end)).toBe("right eye");
    for (const field of ["dose", "method", "route", "site"] as const) {
      const span = recipient[field]!.evidence![0].spans[0];
      expect(source.slice(span.start, span.end), field).toBe(span.text);
    }
    expect([donor.dose, donor.method, donor.route, donor.site]
      .map(value => value!.evidence![0].spans[0].start)).toEqual(originals);
  });

  it("rebases inherited ADD-phase dose evidence to the original donor text", () => {
    const input = "Take 1 tablet daily for 7 days then add a noon dose";
    const plan = createBoundaryPlan(input);
    expect(plan.segments).toHaveLength(2);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments, states);
    const original = states[0].primaryClause;
    const target = states[1].primaryClause;
    expect(original.dose).toBeDefined();
    const phrase = "1 tablet";
    const offset = plan.segments[0].text.indexOf(phrase);
    expect(offset).toBeGreaterThanOrEqual(0);
    original.dose!.evidence = [{
      rule: "test.add-dose-owner",
      spans: [{ start: offset, end: offset + phrase.length, text: phrase }]
    }];
    target.regimenAdjustment = "add";
    delete target.dose;
    expandRegimenAdjustmentPhases(states, [...plan.segments], graph);
    expect(target.dose?.evidence?.[0].spans[0].start).toBe(
      input.indexOf(phrase) - plan.segments[1].start
    );
    shiftCanonicalSigClauses([target], plan.segments[1].start);
    expect(target.dose?.evidence?.[0].spans[0]).toMatchObject({
      start: input.indexOf(phrase), text: phrase
    });
    expect(original.dose!.evidence![0].spans[0].start).toBe(offset);
  });

  it("inherits previous recurrence even when anaphoric ParserState setter keys exist as undefined", () => {
    const input = "Take 1 tablet QD at 09:00 for 7 days; increase to 2 tablets at the same times thereafter.";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    const donor = states[0].primaryClause.schedule!;
    const target = states[1].primaryClause.schedule!;
    expect(donor).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d", timingCode: "QD",
      timeOfDay: ["09:00:00"]
    });
    expect(target.timingReference).toBe("previous");
    // Ordinary ParserState setters can leave keys present but undefined.
    states[1].frequency = undefined;
    states[1].period = undefined;
    states[1].periodUnit = undefined;
    states[1].timingCode = undefined;
    states[1].timeOfDay = undefined;
    expect(Object.hasOwn(target, "frequency")).toBe(true);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, input);
    expect(target).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d", timingCode: "QD",
      timeOfDay: ["09:00:00"]
    });
    expect(target.timingReference).toBeUndefined();
    expect(target.duration).toBeUndefined();
    expect(target.boundsStart).toBeUndefined();
    expect(target.boundsEnd).toBeUndefined();
    // The successor is independent; mutating a donor anchor after inheritance
    // must not retroactively change the successor's schedule.
    donor.timeOfDay![0] = "08:00:00";
    expect(target.timeOfDay).toEqual(["09:00:00"]);
  });

  it("serializes later parallel-stage instruction-graph spans relative to their own source", () => {
    const input =
      "1 drop OD QID x7d then BID; " +
      "1 drop OS QID x1mo then BID, do not touch dropper tip";
    const parsed = parseSig(input);
    expect(parsed.fhirNext.step).toHaveLength(3);
    const absolute = parsed.items[3].meta.canonical.clauses[0]?.instructionGraph;
    expect(absolute?.actions[0]?.span.start).toBe(input.indexOf("do not touch"));
    const projected = [
      parsed.fhir[parsed.fhir.length - 1],
      parsed.fhirNext.step[2].component[1],
      toFhirR5Dosages(parsed.fhirNext)[5]
    ];
    for (const dosage of projected) {
      const graph = fromFhirDosage(dosage).meta.normalized.instructionGraph;
      expect(graph?.sourceText).toBe("BID, do not touch dropper tip");
      const action = graph?.actions.find(candidate => candidate.predicate.lemma === "touch");
      expect(action?.sourceText).toBe("do not touch dropper tip");
      expect(action?.span).toEqual({ start: 5, end: 29 });
      expect(graph?.sourceText.slice(action!.span.start, action!.span.end))
        .toBe(action?.sourceText);
    }
  });

  it("owns independent windows and dosage stages in the raw typed regimen graph", () => {
    const input =
      "1 drop OD q2h x1wk then 1 drop OD qid only if BP >160; " +
      "1 drop OS qid x1mo then 1 drop OS bid";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, input);
    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);

    expect(regimen.kind).toBe("resolved");
    if (regimen.kind !== "resolved") return;
    expect(regimen.tracks.map(track => track.phases.map(phase => ({
      start: phase.start,
      end: phase.end,
      sites: phase.members.map(member => member.clause.site?.text)
    })))).toEqual([
      [
        { start: { unit: "d", value: 0 }, end: { unit: "d", value: 7 }, sites: ["right eye"] },
        { start: { unit: "d", value: 7 }, end: undefined, sites: ["right eye"] }
      ],
      [
        { start: { unit: "d", value: 0 }, end: { unit: "mo", value: 1 }, sites: ["left eye"] },
        { start: { unit: "mo", value: 1 }, end: undefined, sites: ["left eye"] }
      ]
    ]);
    expect(regimen.stages.map(stage => stage.end)).toEqual([
      { unit: "d", value: 7 },
      { unit: "mo", value: 1 },
      undefined
    ]);
    expect(regimen.tracks[0].phases[0].members[0].clause.schedule)
      .toMatchObject({ duration: 1, durationUnit: "wk" });
    expect(regimen.tracks[0].phases[1].members[0].clause.clinicalAdjuncts?.condition)
      .toMatchObject({ kind: "measurement", operation: "gt", value: 160 });
    expect(regimen.stages.map(stage => stage.components.map(component => [
      component.clause.schedule?.duration, component.clause.schedule?.durationUnit
    ]))).toEqual([
      [[1, "wk"], [1, "mo"]],
      [[undefined, undefined], [1, "mo"]],
      [[undefined, undefined], [undefined, undefined]]
    ]);
  });

  it("owns inferred calendar phase ends before any FHIR projection", () => {
    const input =
      "1 drop OD QID x7d then 1 drop OD BID; " +
      "1 drop OS QID from 2026-10-25 then 1 drop OS BID from 2026-11-01";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, input);
    expect(states[2].primaryClause.schedule?.boundsEnd).toBeUndefined();

    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
    expect(regimen.kind).toBe("resolved");
    if (regimen.kind !== "resolved") return;
    expect(regimen.tracks[1].phases[0].members[0].clause.schedule)
      .toMatchObject({ boundsStart: "2026-10-25" });
    expect(regimen.tracks[1].phases[0].members[0].clause.schedule?.boundsEnd)
      .toBeUndefined();
    expect(regimen.tracks[1].phases[0].members[0]).toMatchObject({
      effectiveBoundsEnd: "2026-10-31",
      boundsEndBasis: "next-phase-start"
    });
    expect(regimen.tracks[1].phases[0].members[0].clause.rawText)
      .toContain("from 2026-10-25");
  });

  it("retains a clinician end bound when an anchored duration cuts execution earlier", () => {
    const input =
      "1 drop OD QID x7d then 1 drop OD BID; " +
      "1 drop OS QID from 2026-10-25 for 7 days until 2026-11-15 " +
      "then 1 drop OS BID from 2026-11-16";
    const plan = createBoundaryPlan(input);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, input);
    const sourceSchedule = states[2].primaryClause.schedule;
    expect(sourceSchedule).toMatchObject({
      boundsStart: "2026-10-25",
      boundsEnd: "2026-11-15",
      duration: 7,
      durationUnit: "d"
    });

    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
    expect(regimen.kind).toBe("resolved");
    if (regimen.kind !== "resolved") return;
    const sourceComponent = regimen.tracks[1].phases[0].members[0];
    expect(sourceComponent.clause.schedule?.boundsEnd).toBe("2026-11-15");
    expect(sourceComponent).toMatchObject({
      effectiveBoundsEnd: "2026-10-31",
      boundsEndBasis: "anchored-duration"
    });
    const projectedComponent = regimen.stages[0].components.find(component =>
      component.clause.site?.text === "left eye");
    expect(projectedComponent?.clause.schedule).toMatchObject({
      boundsEnd: "2026-11-15",
      duration: 7,
      durationUnit: "d"
    });
    expect(projectedComponent?.effectiveBoundsEnd).toBe("2026-10-31");
    const partialSource = input.replace("OD QID x7d", "OD QID");
    const partial = parseSig(partialSource);
    const partialLeft = partial.meta.canonical.course!.stages[0].administrations
      .find(member => member.target?.text === "left eye")!;
    expect(partialLeft.syntax?.schedule?.boundsEnd).toBe("2026-11-15");
    expect(partialLeft.schedule?.recurrence?.calendarWindow?.end).toBe("2026-10-31");
    expect(partial.fhirNext.renderedInstruction).toBe(partialSource);
  });

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
      .toMatchObject({ value: 1, code: "wk" });
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

  it("keeps a conditional oral phase independent from an inhaled taper", () => {
    const input =
      "1 tablet PO BID x7d then 1 tablet PO QD only if BP >160; " +
      "inhale 2 puffs TID x14d then inhale 2 puffs BID";
    const parsed = parseSig(input);
    expect(parsed.count).toBe(4);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.fhirNext.step.map(step => step.end?.offsetDuration?.value))
      .toEqual([7, 14, undefined]);
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([2, 2, 2]);
    const conditionalOral = parsed.fhirNext.step.flatMap(step => step.component)
      .filter(component =>
        component.route?.text === "by mouth" && component.timing?.code?.text === "QD");
    expect(conditionalOral).toHaveLength(2);
    for (const component of conditionalOral) {
      expect(component.condition?.[0]).toMatchObject({
        operation: "gt", valueQuantity: { value: 160 }
      });
    }
    expect(toDosageDetails(toFhirR5Dosages(parsed.fhirNext))).toEqual(parsed.fhirNext);
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

  it.each([false, true])("retains a dated track's inferred end beside an unknown cutover (dated first %s)", datedFirst => {
    const unknown = "1 drop OD QID then BID";
    const dated = "1 drop OS QID from 2026-10-25 then BID from 2026-11-01";
    const source = (datedFirst ? [dated, unknown] : [unknown, dated]).join("; ");
    const parsed = parseSig(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.input).toBe(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const authoredLeft = parsed.meta.canonical.course!.stages[0].administrations
      .find(member => member.target?.text === "left eye")!;
    expect(authoredLeft.syntax?.schedule?.boundsEnd).toBeUndefined();
    const courses = [parsed.meta.canonical.course!, importCanonicalCourse(parsed.fhirNext),
      importCanonicalCourse(JSON.parse(JSON.stringify(parsed.fhir))),
      importCanonicalCourse(JSON.parse(JSON.stringify(strict)))];
    for (const course of courses) {
      expect(course.instruction).toBe(source);
      const members = course.stages.flatMap(stage => stage.administrations);
      expect(members).toHaveLength(4);
      const right = members.filter(member => member.target?.text === "right eye");
      const left = members.filter(member => member.target?.text === "left eye");
      expect(right).toHaveLength(2); expect(left).toHaveLength(2);
      expect(right[1].phaseStart?.anchor).toBe("unresolved");
      expect(left[0].schedule?.recurrence?.calendarWindow).toEqual({ start: "2026-10-25", end: "2026-10-31" });
      expect(left[1].schedule?.recurrence?.calendarWindow).toEqual({ start: "2026-11-01" });
      expect(() => nextDueDoses(course, options("2026-11-01T00:00:00+07:00", 4)))
        .toThrow(/treatment-start offset/);
      const complete = { kind: "course" as const, stages: [{ administrations: left }] };
      expect(nextDueDoses(complete, options("2026-11-01T00:00:00+07:00", 4))).toEqual([
        "2026-11-01T08:00:00+07:00", "2026-11-01T20:00:00+07:00",
        "2026-11-02T08:00:00+07:00", "2026-11-02T20:00:00+07:00",
      ]);
      expect(nextDueDoses(complete, options("2026-10-31T00:00:00+07:00", 6))).toEqual([
        "2026-10-31T08:00:00+07:00", "2026-10-31T12:00:00+07:00",
        "2026-10-31T16:00:00+07:00", "2026-10-31T20:00:00+07:00",
        "2026-11-01T08:00:00+07:00", "2026-11-01T20:00:00+07:00",
      ]);
      expect(calculateTotalUnits({ ...options("2026-11-01T00:00:00+07:00"), dosage: complete,
        durationValue: 2, durationUnit: "d" }).totalUnits).toBe(4);
      expect(calculateTotalUnits({ ...options("2026-10-25T00:00:00+07:00"), dosage: complete,
        durationValue: 9, durationUnit: "d" }).totalUnits).toBe(32);
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
    expect(parsed.fhirNext.step.map(step => step.component.length)).toEqual([4]);
    const origins = parsed.meta.canonical.course!.stages[0].administrations.map(member => member.phaseOrigin);
    expect(origins).toEqual([
      expect.objectContaining({ value: 0, code: "d" }), expect.objectContaining({ value: 28, code: "d" }),
      expect.objectContaining({ value: 0, code: "d" }), expect.objectContaining({ value: 1, code: "mo" })
    ]);
    expect(lintSig(input).issues).toEqual([]);
  });

  it("preserves an unresolved transition and independently schedules the complete other track", () => {
    const input = "1 drop OD q2h then QID; 1 drop OS QID x1mo then BID";
    const parsed = parseSig(input);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.items.map(item => item.fhir.site?.text))
      .toEqual(["right eye", "right eye", "left eye", "left eye"]);
    expect(parsed.items.map(item => item.fhir.timing?.code?.text))
      .toEqual(["Q2H", "QID", "QID", "BID"]);
    expect(lintSig(input).issues).toEqual([]);
    expect(parsed.meta.canonical.course!.stages[0].administrations[1].phaseStart?.anchor).toBe("unresolved");
    expect(() => nextDueDoses(parsed, options(orderedAt))).toThrow(/treatment-start offset/u);
    const knownTrack = { ...parsed.fhirNext, step: parsed.fhirNext.step.map(step => ({ ...step,
      component: step.component.filter(member => member.site?.concept?.text === "left eye") })) };
    expect(nextDueDoses(knownTrack, options(orderedAt))).toEqual([
      "2026-10-19T08:00:00+07:00", "2026-10-19T12:00:00+07:00",
      "2026-10-19T16:00:00+07:00", "2026-10-19T20:00:00+07:00",
      "2026-10-20T08:00:00+07:00", "2026-10-20T12:00:00+07:00",
      "2026-10-20T16:00:00+07:00", "2026-10-20T20:00:00+07:00"
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


describe("round 27: partial parallel authored onset", () => {
  it("uses an explicit day-35 onset and derives its own end from that onset", () => {
    const source = "1 drop OD QID x4wk then 1 drop OD BID x1wk; 1 drop OS QID then 1 drop OS BID";
    const plan = createBoundaryPlan(source);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    // Typed construction fixture: the right-eye second phase carries an
    // authored treatment-relative onset; the other track has no cutover.
    states[1].primaryClause.schedule!.treatmentStartOffsetDays = 35;
    scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
    expect(regimen.kind).toBe("unresolved");
    if (regimen.kind !== "unresolved") throw new Error("Expected partial independent tracks");
    const phases = regimen.tracks![0].phases;
    expect(phases[0].start).toEqual({ unit: "d", value: 0 });
    expect(phases[0].end).toEqual({ unit: "d", value: 28 });
    expect(phases[1].start).toEqual({ unit: "d", value: 35 });
    expect(phases[1].end).toEqual({ unit: "d", value: 42 });
    expect(phases[1].members[0].clause.schedule?.treatmentStartOffsetDays).toBe(35);
    const course = courseFromPartialParallel(regimen, plan.segments.map(segment => segment.text), source);
    const right = course.stages[0].administrations.filter(member => member.target?.text === "right eye");
    expect(right[1].phaseOrigin).toMatchObject({ value: 35, code: "d" });
    const track = { kind: "course" as const, stages: [{ administrations: right }] };
    const late = { ...options("2026-11-16T00:00:00+07:00", 2) };
    expect(nextDueDoses(track, late)).toEqual([
      "2026-11-23T08:00:00+07:00", "2026-11-23T20:00:00+07:00"
    ]);
    expect(calculateTotalUnits({ ...late, dosage: track, durationValue: 7, durationUnit: "d" }).totalUnits).toBe(0);
  });
});


it("round 27: resolves next-day onset against a typed nonzero phase origin", () => {
  const source = "Take 1 tablet at 22:00 then 2 tablets at 06:00 the next morning then 3 tablets at 07:00 the following morning";
  const plan = createBoundaryPlan(source);
  const states = plan.segments.map(segment => parseClauseState(segment.text));
  const graph = buildRegimenGraph(plan, plan.segments);
  states[0].primaryClause.schedule!.treatmentStartOffsetDays = 4;
  scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
  expect(states.map(state => state.primaryClause.schedule?.treatmentStartOffsetDays)).toEqual([4, undefined, undefined]);
  expect(states.slice(1).map(state => state.primaryClause.schedule?.phaseStartReference))
    .toEqual(["previous-phase-next-day", "previous-phase-next-day"]);
  expect(states.map(state => state.primaryClause.schedule?.timeOfDay)).toEqual([
    ["22:00:00"], ["06:00:00"], ["07:00:00"]
  ]);
  const course = courseFromAdministrations(states.map((state, index) =>
    administrationFromClause(state.primaryClause, plan.segments[index].text, index + 1)), source);
  expect(nextDueDoses(course, { orderedAt: "2026-11-21T00:00:00Z",
    from: "2026-11-21T00:00:00Z", timeZone: "UTC", limit: 3 })).toEqual([
    "2026-11-25T22:00:00+00:00", "2026-11-26T06:00:00+00:00", "2026-11-27T07:00:00+00:00"
  ]);
  expect(nextDueDoses(course, { orderedAt: "2026-11-21T23:00:00Z",
    from: "2026-11-21T23:00:00Z", timeZone: "UTC", limit: 3 })).toEqual([
    "2026-11-26T22:00:00+00:00", "2026-11-27T06:00:00+00:00", "2026-11-28T07:00:00+00:00"
  ]);
});


describe("round34 partial same-track cadence cutoffs", () => {
  it.each([
    [false, false], [false, true], [true, false], [true, true]
  ] as const)("ends the old right-eye cadence at its own successor (duration %s, civil origin %s)", (duration, dayStart) => {
    const source = "1 drop OD QID" + (duration ? " x4wk" : "") +
      " then 2 drops OD BID x1wk; 3 drops OS QID then 3 drops OS BID";
    const plan = createBoundaryPlan(source);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    states[1].primaryClause.schedule!.treatmentStartOffsetDays = 35;
    if (dayStart) states[1].primaryClause.schedule!.phaseStartReference = "treatment-day-start";
    scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
    const regimen = buildCanonicalParallelRegimen(states.map(state => state.primaryClause), plan.segments, plan, graph);
    if (regimen.kind !== "unresolved") throw new Error("Expected partial independent tracks");
    expect(regimen.tracks![0].phases[0].end).toEqual(duration ? { value: 28, unit: "d" } : undefined);
    const native = courseFromPartialParallel(regimen, plan.segments.map(segment => segment.text), source);
    const right = native.stages[0].administrations.filter(member => member.target?.text === "right eye");
    const left = native.stages[0].administrations.filter(member => member.target?.text === "left eye");
    expect(right.map(member => member.amounts?.[0].quantity?.value)).toEqual([1, 2]);
    const rightTrack = { kind: "course" as const, stages: [{ administrations: right }] };
    const late = options("2026-11-23T08:00:00+07:00", 4);
    const wire = projectCanonicalCourse(rightTrack);
    for (const input of [rightTrack, wire.fhirNext, JSON.parse(JSON.stringify(wire.fhir))]) {
      expect(nextDueDoses(input, late)).toEqual([
        "2026-11-23T08:00:00+07:00", "2026-11-23T20:00:00+07:00",
        "2026-11-24T08:00:00+07:00", "2026-11-24T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ ...late, dosage: input, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
    }
    expect(right[0].phaseEnd).toMatchObject({
      anchor: dayStart ? "treatment-day-start" : "treatment-start", displacement: { value: 35, code: "d" }
    });
    // An order at noon separates elapsed day 35 from the civil-midnight
    // cutover. The 08:00 amount must still belong to the old phase only in
    // the unbounded elapsed branch; timestamps alone cannot prove ownership.
    const shifted = { ...options("2026-11-23T00:00:00+07:00", 10),
      orderedAt: "2026-10-19T12:00:00+07:00" };
    for (const input of [rightTrack, wire.fhirNext, JSON.parse(JSON.stringify(wire.fhir))]) {
      const firstDay = nextDueDoses(input, shifted).filter(stamp =>
        Date.parse(stamp) < Date.parse("2026-11-24T00:00:00+07:00"));
      expect(firstDay).toEqual([
        ...(dayStart || !duration ? ["2026-11-23T08:00:00+07:00"] : []),
        "2026-11-23T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ ...shifted, dosage: input,
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(dayStart ? 4 : duration ? 2 : 3);
      expect(calculateTotalUnits({ ...shifted, dosage: input,
        durationValue: 12, durationUnit: "h" }).totalUnits).toBe(dayStart ? 2 : duration ? 0 : 1);
      expect(calculateTotalUnits({ ...shifted, dosage: input, from: "2026-11-23T12:00:00+07:00",
        durationValue: 12, durationUnit: "h" }).totalUnits).toBe(2);
    }

    expect(left[0].phaseEnd).toBeUndefined();
    const leftTrack = { kind: "course" as const, stages: [{ administrations: [left[0]] }] };
    expect(calculateTotalUnits({ ...late, dosage: leftTrack, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(12);
    if (duration) expect(calculateTotalUnits({ ...options("2026-11-16T08:00:00+07:00"), dosage: rightTrack,
      durationValue: 7, durationUnit: "d" }).totalUnits).toBe(0);
    else for (const input of [rightTrack, wire.fhirNext, JSON.parse(JSON.stringify(wire.fhir))]) {
      const between = options("2026-11-18T00:00:00+07:00", 4);
      expect(nextDueDoses(input, between)).toEqual([
        "2026-11-18T08:00:00+07:00", "2026-11-18T12:00:00+07:00",
        "2026-11-18T16:00:00+07:00", "2026-11-18T20:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ ...between, dosage: input, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
    }
  });
});


it("round34: public parsing closes the known eye track and retains the unresolved other eye", () => {
  const source = "1 drop OD QID then from day 36 2 drops OD BID x1wk; 3 drops OS QID then 3 drops OS BID";
  const parsed = parseSig(source);
  const members = parsed.meta.canonical.course!.stages[0].administrations;
  expect(members.map(member => [member.target?.text, member.amounts?.[0].quantity?.value]))
    .toEqual([["right eye", 1], ["right eye", 2], ["left eye", 3], ["left eye", 3]]);
  expect(members[0].phaseEnd).toMatchObject({
    anchor: "treatment-day-start", displacement: { value: 35, code: "d" }
  });
  expect(members[3].phaseStart).toMatchObject({ anchor: "unresolved" });
  const rightRows = parsed.fhir.filter(row => row.site?.text === "right eye");
  const before = JSON.stringify(parsed);
  expect(nextDueDoses(rightRows, options("2026-11-23T08:00:00+07:00", 4))).toEqual([
    "2026-11-23T08:00:00+07:00", "2026-11-23T20:00:00+07:00",
    "2026-11-24T08:00:00+07:00", "2026-11-24T20:00:00+07:00"
  ]);
  expect(calculateTotalUnits({ ...options("2026-11-23T08:00:00+07:00"), dosage: rightRows,
    durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
  expect(JSON.stringify(parsed)).toBe(before);
});

describe("round35 independent phase-origin ownership", () => {
  const options = { orderedAt: "2026-11-21T08:00:00Z", from: "2026-11-21T08:00:00Z",
    timeZone: "UTC", limit: 10 };
  it.each([
    ["Take 1 tablet starting 2026-12-01 once in 2 hours", ["2026-12-01T02:00:00+00:00"]],
    ["Take 1 tablet once in 2 hours", ["2026-11-21T10:00:00+00:00"]],
    ["Take 1 tablet daily for 7 days, then take 2 tablets once in 2 hours", [
      "2026-11-21T09:00:00+00:00", "2026-11-22T09:00:00+00:00", "2026-11-23T09:00:00+00:00",
      "2026-11-24T09:00:00+00:00", "2026-11-25T09:00:00+00:00", "2026-11-26T09:00:00+00:00",
      "2026-11-27T09:00:00+00:00", "2026-11-28T10:00:00+00:00"
    ]]
  ])("applies an elapsed delay to its own calendar or phase origin: %s", (source, expected) => {
    const parsed = parseSig(source as string);
    const before = JSON.stringify(parsed);
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir))])
      expect(nextDueDoses(input, options)).toEqual(expected);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses[parsed.meta.canonical.clauses.length - 1].schedule?.administrationOffsetMinutes).toBe(120);
  });

  it.each(["", "From day 1 "])("retains an unanchored parallel member at its own track start (%s)", prefix => {
    const source = prefix + "1 drop OD at 08:00 daily for 5 days and from day 4 2 drops OD at 20:00 daily for 3 days" +
      " then 3 drops OD at 06:00 the next morning; 1 drop OS at 12:00 daily for 7 days then 2 drops OS at 12:00 daily";
    const parsed = parseSig(source);
    const first = parsed.meta.canonical.course!.stages[0].administrations[0];
    expect(first.phaseStart?.displacement?.value ?? first.phaseOrigin?.value).toBe(0);
    const expected = [
      "2026-11-21T08:00:00+00:00", "2026-11-21T12:00:00+00:00",
      "2026-11-22T08:00:00+00:00", "2026-11-22T12:00:00+00:00",
      "2026-11-23T08:00:00+00:00", "2026-11-23T12:00:00+00:00",
      "2026-11-24T08:00:00+00:00", "2026-11-24T12:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T12:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T12:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T06:00:00+00:00", "2026-11-27T12:00:00+00:00"
    ];
    const before = JSON.stringify(parsed);
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir))])
      expect(nextDueDoses(input, { ...options, limit: expected.length })).toEqual(expected);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(parsed.meta.canonical.clauses[0].schedule?.duration).toBe(5);
    expect(parsed.meta.canonical.clauses[1].schedule?.duration).toBe(3);
  });

  it("uses the dated start for the following morning without inventing completion", () => {
    const source = "Take 1 tablet starting 2026-12-01 at 22:00, then take 2 tablets at 06:00 the next morning";
    const parsed = parseSig(source);
    const prior = parsed.meta.canonical.clauses[0].schedule!;
    expect(prior.boundsStart).toBe("2026-12-01");
    expect(prior.boundsEnd).toBeUndefined();
    expect(prior.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule?.boundsStart).toBe("2026-12-02");
    expect(parsed.meta.canonical.clauses[1].schedule?.count).toBe(1);
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    const before = JSON.stringify(parsed);
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir))])
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-12-01T22:00:00+00:00", "2026-12-02T06:00:00+00:00"
      ]);
    expect(JSON.stringify(parsed)).toBe(before);
  });
});

it("round35 retains a shared authored onset for all coordinated parallel members", () => {
  const parsed = parseSig("From day 4 1 drop OD at 08:00 daily for 5 days and from day 4 2 drops OD at 20:00 daily for 3 days" +
    " then 3 drops OD at 06:00 the next morning; 1 drop OS at 12:00 daily for 7 days then 2 drops OS at 12:00 daily");
  const members = parsed.meta.canonical.course!.stages[0].administrations;
  expect(members.slice(0, 2).map(member => member.phaseStart)).toMatchObject([
    { anchor: "treatment-day-start", displacement: { value: 3, unit: "d" } },
    { anchor: "treatment-day-start", displacement: { value: 3, unit: "d" } },
  ]);
  const rows = parsed.fhir.filter(row => row.site?.text === "right eye");
  expect(nextDueDoses(rows, { orderedAt: "2026-11-21T17:00:00Z", from: "2026-11-21T17:00:00Z",
    timeZone: "UTC", limit: 9 })).toEqual([
      "2026-11-24T08:00:00+00:00", "2026-11-24T20:00:00+00:00",
      "2026-11-25T08:00:00+00:00", "2026-11-25T20:00:00+00:00",
      "2026-11-26T08:00:00+00:00", "2026-11-26T20:00:00+00:00",
      "2026-11-27T08:00:00+00:00", "2026-11-28T08:00:00+00:00",
      "2026-11-29T06:00:00+00:00"
    ]);
});

describe("round40 dated parallel cutoff", () => {
  it.each(["", " for 2 days"])("ends only the replaced eye cadence at a known calendar successor: %s", duration => {
    const text = "Instill 1 drop OD QID" + duration +
      ", then starting 2026-12-05 instill 2 drops OD BID; instill 1 drop OS BID";
    const parsed = parseSig(text, { datePolicy: { referenceDate: "2026-12-01" } });
    const before = JSON.stringify(parsed);
    const members = parsed.meta.canonical.course!.stages[0].administrations;
    expect(members[0].schedule?.recurrence?.calendarWindow).toEqual({ end: "2026-12-04" });
    expect(members[0].schedule?.recurrence?.courseLength).toBeUndefined();
    expect(members[0].anchoredLength?.quantity).toEqual(duration ? { value: 2, unit: "d" } : undefined);
    expect(parsed.meta.canonical.clauses[0].schedule?.duration).toBe(duration ? 2 : undefined);
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.timing?.repeat?.boundsPeriod).toEqual({ end: "2026-12-04" });
      expect(row.timing?.repeat?.boundsDuration).toBeUndefined();
      expect(row.timing?.repeat?.boundsRange).toBeUndefined();
    }
    expect(parsed.meta.canonical.clauses[0].schedule?.boundsEnd).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.timingCode).toBe("QID");
    expect(members[2].schedule?.recurrence?.calendarWindow).toBeUndefined();
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-05T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(6);
      expect(calculateTotalUnits({ ...query, from: "2026-12-04T00:00:00Z", dosage,
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(duration ? 2 : 6);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


it("preserves THEN between a clock and an event anchor without inventing its event time", () => {
  const parsed = parseSig("Take 1 tablet at 22:00, then 2 in the morning");
  expect(parsed.meta.canonical.course!.stages).toHaveLength(2);
  expect(parsed.fhir.map(row => row.sequence)).toEqual([1, 2]);
  expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
  expect(parsed.fhir[1].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
  expect(parsed.fhir[1].timing?.repeat?.when).toEqual(["MORN"]);
  expect(parsed.fhir[1].timing?.repeat?.timeOfDay).toBeUndefined();
  const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC",
    eventClock: { MORN: "08:00" }, limit: 4 };
  for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
    expect(nextDueDoses(input, query)).toEqual([
      "2026-12-01T22:00:00+00:00", "2026-12-02T08:00:00+00:00",
      "2026-12-03T08:00:00+00:00", "2026-12-04T08:00:00+00:00"
    ]);
    expect(nextDueDoses(input, { ...query, eventClock: { MORN: "10:00" }, limit: 2 })).toEqual([
      "2026-12-01T22:00:00+00:00", "2026-12-02T10:00:00+00:00"
    ]);
    expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: "d" }))
      .toMatchObject({ totalUnits: 5, unit: "tab" });
  }
  expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
  const recurring = parseSig("Take 1 tablet daily at 22:00, then 2 in the morning");
  expect(recurring.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
  for (const input of [recurring, recurring.meta.canonical.course!, recurring.fhirNext,
    JSON.parse(JSON.stringify(recurring.fhir))]) {
    expect(nextDueDoses(input, query)).toEqual([
      "2026-12-01T22:00:00+00:00", "2026-12-02T22:00:00+00:00",
      "2026-12-03T22:00:00+00:00", "2026-12-04T22:00:00+00:00"
    ]);
  }
  const orderedClocks = parseSig("Take 1 tablet at 08:00, then 2 at 22:00");
  expect(orderedClocks.meta.canonical.course!.stages).toHaveLength(1);
  expect(nextDueDoses(orderedClocks, query)).toEqual([
    "2026-12-01T08:00:00+00:00", "2026-12-01T22:00:00+00:00",
    "2026-12-02T08:00:00+00:00", "2026-12-02T22:00:00+00:00"
  ]);
});


describe("round42 relative points and inherited cadence origins", () => {
  it.each([false, true])("keeps the next morning finite unless a daily course is stated (%s)", recurring => {
    const parsed = parseSig(recurring ? "Take 1 tablet daily for 3 days starting the next morning"
      : "Take 1 tablet the next morning");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(recurring ? undefined : 1);
    const query = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC",
      eventClock: { MORN: "08:00" }, limit: 4 };
    const expected = recurring ? ["2026-11-22T08:00:00+00:00", "2026-11-23T08:00:00+00:00", "2026-11-24T08:00:00+00:00"]
      : ["2026-11-22T08:00:00+00:00"];
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual(expected);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: "d" }).totalUnits)
        .toBe(recurring ? 3 : 1);
    }
  });

  it.each([false, true])("retains explicit EVERY cadence beside a NEXT onset (%s)", recurring => {
    const parsed = parseSig(recurring ? "Take 1 tablet every morning starting the next day"
      : "Take 1 tablet in the morning the next day");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(recurring ? undefined : 1);
    if (recurring) expect(parsed.meta.canonical.clauses[0].schedule)
      .toMatchObject({ when: ["MORN"], period: 1, periodUnit: "d" });
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC",
      eventClock: { MORN: "08:00" }, limit: 5 };
    const expected = recurring ? ["2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]
      : ["2026-12-02"];
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual(expected.map(day => day + "T08:00:00+00:00"));
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: "d" }).totalUnits)
        .toBe(recurring ? 4 : 1);
    }
  });

  it.each([
    ["the next morning and at 09:00", ["08:00", "09:00"]],
    ["the next morning and again at 18:00", ["08:00", "18:00"]],
    ["at 07:00 the next morning and before breakfast", ["06:00", "07:00"]],
    ["the next morning at 07:00 before breakfast", ["07:00"]],
    ["at 08:00 in the morning the next day", ["08:00"]],
    ["in the morning and at 09:00 the next day", ["08:00", "09:00"]]
  ] as const)("keeps exactly the composed NEXT-day positions: %s", (timing, clocks) => {
    const parsed = parseSig("Take 1 tablet " + timing);
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(clocks.length);
    const query = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC",
      eventClock: { MORN: "08:00", ACM: "06:00" }, limit: 5 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual(clocks.map(clock => "2026-11-22T" + clock + ":00+00:00"));
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: "d" }).totalUnits).toBe(clocks.length);
    }
  });

  it.each(["at 08:00 in the morning the next day", "the next morning at 08:00"])(
    "uses the authored NEXT clock when its daypart has a different configured clock: %s", timing => {
    const parsed = parseSig("Take 1 tablet " + timing);
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
    const query = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC",
      eventClock: { MORN: "06:00" }, limit: 3 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2026-11-22T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: "d" }).totalUnits).toBe(1);
    }
  });

  it("inherits the same-time clock window and retains an unresolved reference without an anchor", () => {
    const parsed = parseSig("Take 1 tablet daily between 18:00 and 20:00 for 7 days, then take 2 tablets at the same time");
    const window = { start: "18:00:00", end: "20:00:00", endInclusive: true };
    const successor = parsed.meta.canonical.clauses[1];
    expect(successor.dose).toMatchObject({ value: 2, unit: "tab" });
    expect(successor.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d", clockWindow: window });
    expect(successor.schedule?.timingReference).toBeUndefined();
    expect(successor.additionalInstructions).toBeUndefined();
    for (const wire of [parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))])
      expect(importCanonicalCourse(wire).stages[1].administrations[0].schedule?.recurrence?.clockWindow).toEqual(window);
    const unresolved = parseSig("Take 1 tablet daily for 7 days, then take 2 tablets at the same time");
    expect(unresolved.meta.canonical.clauses[1].schedule).toMatchObject({ timingReference: "previous", frequency: 1 });
    expect(unresolved.meta.canonical.clauses[1].schedule?.timeOfDay).toBeUndefined();
    expect(unresolved.meta.canonical.clauses[1].schedule?.clockWindow).toBeUndefined();
    expect(unresolved.longText.toLowerCase()).toContain("at the same time");
  });

  it.each([false, true])("keeps an authored onset as the inherited cadence origin (legacy offset %s)", legacy => {
    const source = "Take 1 tablet every 2 days at 08:00 through 2026-12-05, then from day 11 take 2 tablets";
    const plan = createBoundaryPlan(source);
    const states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments, states);
    expect(graph.sequences[0].relation.rule).toBe("regimen.treatment-relative-phase-onset");
    // Existing offset-only schedules (including master parser output) already
    // count from treatment start. The new optional reference is not required.
    if (legacy) {
      const clause = states[1].primaryClause;
      delete clause.schedule!.phaseStartReference;
      for (const evidence of [...(clause.schedule!.evidence ?? []), ...clause.evidence])
        evidence.scheduleFields = evidence.scheduleFields?.filter(field => field !== "phaseStartReference");
    }
    scopeSequentialPhaseSemantics(states, plan.segments, graph, source);
    expect(states[1].primaryClause.schedule).toMatchObject({ treatmentStartOffsetDays: 10,
      period: 2, periodUnit: "d", timeOfDay: ["08:00:00"] });
    expect(states[1].primaryClause.schedule?.boundsStart).toBeUndefined();
    expect(states[1].primaryClause.schedule?.boundsEnd).toBeUndefined();
    const course = courseFromAdministrations(states.map((state, index) =>
      administrationFromClause(state.primaryClause, plan.segments[index].text, index + 1)), source);
    const wire = projectCanonicalCourse(course);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-11T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const dosage of [course, wire.fhirNext, JSON.parse(JSON.stringify(wire.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-12-11T08:00:00+00:00", "2026-12-13T08:00:00+00:00", "2026-12-15T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 5, durationUnit: "d" }).totalUnits).toBe(6);
    }
  });

  it.each(["from day 11 take 2 tablets", "2 tablets from day 11"])(
    "keeps the existing onset continuation with either source order: %s", continuation => {
    const parsed = parseSig("Take 1 tablet QD at 08:00 for 7 days then " + continuation);
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose?.value)).toEqual([1, 2]);
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({ treatmentStartOffsetDays: 10,
      frequency: 1, period: 1, periodUnit: "d", timeOfDay: ["08:00:00"] });
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-11T00:00:00Z",
        timeZone: "UTC", limit: 2 })).toEqual(["2026-12-11T08:00:00+00:00", "2026-12-12T08:00:00+00:00"]);
    }
  });
});


describe("round43 inherited activity timing", () => {
  it.each([
    ["2 tablets from day 8", 30],
    ["from day 8 take 2 tablets", 30],
    ["2 tablets 45 minutes before exercise from day 8", 45]
  ] as const)("preserves recognized activity timing in the continuation: %s", (continuation, offset) => {
    const source = "1 tablet daily 30 minutes before exercise, then " + continuation;
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose)).toEqual([
      { value: 1, unit: "tab" }, { value: 2, unit: "tab" }
    ]);
    const expected = [{ relation: "before", offset, activity: {
      text: "exercise", coding: { system: "http://snomed.info/sct", code: "256235009" }
    } }];
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      treatmentStartOffsetDays: 7, frequency: 1, period: 1, periodUnit: "d", activityTiming: expected
    });
    expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming?.[0].offset).toBe(30);
    for (const course of [parsed.meta.canonical.course!, importCanonicalCourse(parsed.fhirNext),
      importCanonicalCourse(JSON.parse(JSON.stringify(parsed.fhir)))]) {
      const successor = course.stages[1].administrations[0];
      expect(successor.amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      expect(successor.schedule?.recurrence?.activityTiming).toMatchObject(expected);
      expect(successor.schedule?.recurrence).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    }
    expect(parsed.input).toBe(source);
  });
});


describe("round43 ordered clock continuation", () => {
  it.each(["2", "2 tablets"])("uses actual first-clock completion after a late order: %s", dose => {
    const parsed = parseSig("Take 1 tablet at 22:00 then " + dose + " at 06:00");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
    expect(parsed.meta.canonical.clauses[1].schedule?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBeUndefined();
    const query = { orderedAt: "2024-01-01T23:00:00Z", from: "2024-01-01T23:00:00Z", timeZone: "UTC", limit: 2 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2024-01-02T22:00:00+00:00", "2024-01-03T06:00:00+00:00"]);
    }
  });

  it("keeps an independently stated daily course as the predecessor's completion", () => {
    const parsed = parseSig("Take 1 tablet daily at 22:00 for 2 days then 2 tablets at 06:00");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      frequency: 1, period: 1, periodUnit: "d", duration: 2, durationUnit: "d"
    });
    const query = { orderedAt: "2024-01-01T00:00:00Z", from: "2024-01-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2024-01-01T22:00:00+00:00", "2024-01-02T22:00:00+00:00", "2024-01-03T06:00:00+00:00"
      ]);
    }
    const recurring = parseSig("Take 1 tablet daily at 22:00 then 2 tablets daily at 06:00");
    expect(recurring.meta.canonical.clauses.map(clause => clause.schedule?.count)).toEqual([undefined, undefined]);
    expect(recurring.meta.canonical.clauses.map(clause => clause.schedule?.frequency)).toEqual([1, 1]);
  });
});


describe("round45 explicit onset and parallel successor ownership", () => {
  it.each([
    "Take 1 tablet starting the next day as needed for pain",
    "Starting the next day take 1 tablet as needed for pain"
  ])("keeps a PRN onset without inventing a lifetime count: %s", input => {
    const parsed = parseSig(input);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.prn).toMatchObject({ enabled: true, reason: { text: "pain" } });
    expect(clause.schedule).toMatchObject({ treatmentStartOffsetDays: 1, phaseStartReference: "treatment-day-start" });
    expect(clause.schedule?.count).toBeUndefined();
    const strict = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const dosage of [parsed, parsed.fhirNext, strict]) {
      const native = importCanonicalCourse(dosage);
      expect(native.stages[0].start).toMatchObject({
        anchor: "treatment-day-start", displacement: { value: 1, unit: "d" }
      });
      const administration = native.stages[0].administrations[0];
      expect(administration.asNeeded).toBe(true);
      expect(administration.amounts?.[0].quantity).toMatchObject({ value: 1, unit: "tab" });
      expect(administration.schedule?.recurrence?.count).toBeUndefined();
    }
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0], strict[0]]) {
      expect(row.asNeeded).toBe(true);
      expect(row.timing?.repeat?.count).toBeUndefined();
    }
  });

  it.each([
    ["on 2026-12-05", ["2026-12-05"]],
    ["on 2026-12-07 and 2026-12-05", ["2026-12-07", "2026-12-05"]]
  ] as const)("ends only the replaced eye cadence at its first explicit successor date: %s", (dates, events) => {
    const input = "Instill 1 drop OD QID, then instill 2 drops OD " + dates +
      " at 08:00; instill 1 drop OS BID";
    const parsed = parseSig(input, { datePolicy: { referenceDate: "2026-12-01" } });
    expect(parsed.meta.canonical.clauses).toHaveLength(3);
    expect(parsed.meta.canonical.clauses[0].schedule?.boundsEnd).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule?.calendarEvents?.map(event => event.isoDate)).toEqual(events);
    const strict = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const row of [parsed.fhir[0], parsed.fhirNext.step[0].component[0], strict[0]])
      expect(row.timing?.repeat?.boundsPeriod).toEqual({ end: "2026-12-04" });
    for (const row of [parsed.fhir[1], parsed.fhirNext.step[0].component[1], strict[1]]) {
      expect(row.timing?.event).toEqual(events);
      expect(row.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
      expect(row.doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "drop" });
    }
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [parsed, parsed.fhirNext, strict]) {
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-06T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
      expect(calculateTotalUnits({ ...query, from: "2026-12-06T00:00:00Z", dosage,
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(2);
      const lastDay = { ...query, from: "2026-12-07T00:00:00Z", limit: events.length > 1 ? 3 : 2 };
      expect(nextDueDoses(dosage, lastDay)).toEqual(events.length > 1 ? [
        "2026-12-07T08:00:00+00:00", "2026-12-07T08:00:00+00:00", "2026-12-07T20:00:00+00:00"
      ] : ["2026-12-07T08:00:00+00:00", "2026-12-07T20:00:00+00:00"]);
      expect(calculateTotalUnits({ ...lastDay, dosage, durationValue: 1, durationUnit: "d" }).totalUnits)
        .toBe(events.length > 1 ? 4 : 2);
    }
  });
});


describe("round46 source-owned continuation timing", () => {
  it.each([
    ["between 18:00 and 20:00", "18:00", true],
    ["at 18:00", "18:00", false],
    ["", "08:00", false]
  ] as const)("keeps a successor's own clock window while inheriting cadence: %s", (timing, clock, window) => {
    const parsed = parseSig("Take 1 tablet daily at 08:00 for 7 days, then from day 11 take 2 tablets " + timing);
    const successor = parsed.meta.canonical.clauses[1];
    expect(successor.schedule?.treatmentStartOffsetDays).toBe(10);
    if (window || !timing) expect(successor.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    else expect(successor.schedule?.frequency).toBeUndefined();
    if (window) {
      expect(successor.schedule?.clockWindow).toEqual({ start: "18:00:00", end: "20:00:00", endInclusive: true });
      expect(successor.schedule?.timeOfDay).toBeUndefined();
    } else expect(successor.schedule?.timeOfDay).toEqual([clock + ":00"]);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-11T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, query)).toEqual([11, 12, 13].map(day => `2026-12-${day}T${clock}:00+00:00`));
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(6);
    }
  });

  it.each(["and again", "and  again", ", and  again", "and", "then"])("keeps the first clock before a distinct NEXT-day administration: %s", connector => {
    const source = `Take 1 tablet at 18:00 ${connector} the next morning`;
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(2);
    expect(parsed.meta.canonical.clauses.map(clause => clause.schedule?.count)).toEqual([1, 1]);
    expect(parsed.meta.canonical.clauses.map(clause => clause.dose)).toEqual([
      { value: 1, unit: "tab" }, { value: 1, unit: "tab" }
    ]);
    expect(parsed.meta.canonical.clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({ when: ["MORN"], phaseStartReference: "previous-phase-next-day" });
    const query = { orderedAt: "2026-11-21T00:00:00Z", from: "2026-11-21T00:00:00Z", timeZone: "UTC",
      eventClock: { MORN: "08:00" }, limit: 5 };
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, query)).toEqual(["2026-11-21T18:00:00+00:00", "2026-11-22T08:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 5, durationUnit: "d" }).totalUnits).toBe(2);
    }
  });
});


describe("round47 authored timing ownership", () => {
  it.each([false, true])("preserves an authored unresolved end before a dated successor (relative end %s)", relativeEnd => {
    const source = "Instill 1 drop OD Q6H" + (relativeEnd ? " until the next morning" : "") +
      ", then from day 4 instill 2 drops OD BID; instill 1 drop OS BID";
    const parsed = parseSig(source, { datePolicy: { referenceDate: "2026-12-01" } });
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-01T00:00:00Z", timeZone: "UTC", limit: 3 };
    const strict = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const dosage of [parsed, parsed.fhirNext, strict]) {
      const native = importCanonicalCourse(dosage), members = native.stages[0].administrations;
      expect(members[0].phaseEnd).toMatchObject(relativeEnd
        ? { anchor: "unresolved", description: "until the next morning" }
        : { anchor: "treatment-day-start", displacement: { value: 3, unit: "d", code: "d", system: "http://unitsofmeasure.org" } });
      expect(members[1].phaseStart).toMatchObject({
        anchor: "treatment-day-start", displacement: { value: 3, unit: "d" }
      });
      expect(members[2].phaseStart).toBeUndefined();
      expect(members[2].phaseEnd).toBeUndefined();
      expect(members.map(member => ({ value: member.amounts?.[0].quantity?.value, unit: member.amounts?.[0].quantity?.unit }))).toEqual([
        { value: 1, unit: "drop" }, { value: 2, unit: "drop" }, { value: 1, unit: "drop" }
      ]);
      if (relativeEnd) {
        const message = "Unsupported R6 step RelativeTime: requires a treatment-start offset";
        expect(() => nextDueDoses(dosage, query)).toThrow(message);
        expect(() => calculateTotalUnits({ ...query, dosage, durationValue: 3, durationUnit: "d" })).toThrow(message);
      } else {
        expect(nextDueDoses(dosage, query)).toEqual([
          "2026-12-01T00:00:00+00:00", "2026-12-01T06:00:00+00:00", "2026-12-01T08:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ ...query, dosage, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(18);
      }
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it("retains both explicitly dated doses on the same day in an independent eye track", () => {
    const source = "Instill 1 drop OD on 2026-12-05 at 08:00, then instill 2 drops OD on 2026-12-05 at 20:00; instill 1 drop OS BID";
    const parsed = parseSig(source, { datePolicy: { referenceDate: "2026-12-01" } });
    const strict = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 6 };
    for (const dosage of [parsed, parsed.fhirNext, strict]) {
      const members = importCanonicalCourse(dosage).stages[0].administrations;
      expect(members[0].schedule?.explicitEvents).toEqual(["2026-12-05"]);
      expect(members[0].schedule?.recurrence?.calendarWindow?.end).toBeUndefined();
      expect(members[1].schedule?.explicitEvents).toEqual(["2026-12-05"]);
      expect(members.map(member => ({
        eye: member.target?.coding?.find(code => code.system === "http://snomed.info/sct")?.code,
        dose: { value: member.amounts?.[0].quantity?.value, unit: member.amounts?.[0].quantity?.unit },
        clocks: member.schedule?.recurrence?.clocks,
        frequency: member.schedule?.recurrence?.frequency,
      }))).toEqual([
        { eye: "1290032005", dose: { value: 1, unit: "drop" }, clocks: ["08:00:00"], frequency: undefined },
        { eye: "1290032005", dose: { value: 2, unit: "drop" }, clocks: ["20:00:00"], frequency: undefined },
        { eye: "1290031003", dose: { value: 1, unit: "drop" }, clocks: undefined, frequency: 2 },
      ]);
      expect(nextDueDoses(dosage, query)).toEqual([
        "2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-05T20:00:00+00:00",
        "2026-12-06T08:00:00+00:00", "2026-12-06T20:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(5);
      expect(calculateTotalUnits({ ...query, from: "2026-12-06T00:00:00Z", dosage,
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(2);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it.each([
    ["after breakfast", "", "08:00", "PCM", undefined],
    ["after breakfast", "between 18:00 and 20:00", "18:00", undefined, undefined],
    ["30 minutes before breakfast", "", "07:30", "ACM", 30],
    ["30 minutes before breakfast", "between 18:00 and 20:00", "18:00", undefined, undefined]
  ] as const)("keeps local window ownership after %s: %s", (prior, local, clock, event, offset) => {
    const source = `Take 1 tablet daily ${prior} for 7 days, then from day 11 take 2 tablets ${local}`;
    const parsed = parseSig(source), successor = parsed.meta.canonical.clauses[1];
    expect(successor.schedule).toMatchObject({ treatmentStartOffsetDays: 10, frequency: 1, period: 1, periodUnit: "d" });
    expect(successor.schedule?.when).toEqual(event ? [event] : undefined);
    expect(successor.schedule?.offset).toBe(offset);
    if (local) expect(successor.schedule?.clockWindow).toEqual({ start: "18:00:00", end: "20:00:00", endInclusive: true });
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-11T00:00:00Z", timeZone: "UTC",
      eventClock: { PCM: "08:00", ACM: "08:00" }, limit: 3 };
    for (const dosage of [parsed, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(dosage, query)).toEqual([11, 12, 13].map(day => `2026-12-${day}T${clock}:00+00:00`));
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 3, durationUnit: "d" }).totalUnits).toBe(6);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });
});


describe("round48 authored parallel course lengths", () => {
  it.each([["1wk", 1, "wk"], ["7d", 7, "d"]] as const)(
    "keeps x%s active without restarting it at another eye's stage cut", (duration, value, unit) => {
      const input = `1 drop OD q2h x${duration} then QID; 1 drop OS QID x1mo then BID`;
      const parsed = parseSig(input);
      const stages = parsed.meta.canonical.course!.stages;
      expect(stages).toHaveLength(3);
      expect(stages[0].end?.displacement).toMatchObject({ value: 7, unit: "d" });
      expect(stages[1].end?.displacement).toMatchObject({ value: 1, unit: "mo" });
      expect(stages[0].administrations[0].schedule?.recurrence?.courseLength).toMatchObject({ value, unit });
      for (const stage of stages.slice(0, 2)) {
        expect(stage.administrations[1].schedule?.recurrence?.courseLength).toMatchObject({ value: 1, unit: "mo" });
        expect(stage.administrations[1].phaseOrigin).toMatchObject({ value: 0, unit: "d" });
      }
      const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
      const components = parsed.fhirNext.step.map(step => step.component).reduce((all, part) => all.concat(part));
      for (const rows of [parsed.fhir, components, cold]) {
        expect(rows[0].timing?.repeat?.boundsDuration).toMatchObject({ value, code: unit });
        expect(rows[1].timing?.repeat?.boundsDuration).toMatchObject({ value: 1, code: "mo" });
        expect(rows[3].timing?.repeat?.boundsDuration).toMatchObject({ value: 1, code: "mo" });
        expect(rows[2].timing?.repeat?.boundsDuration).toBeUndefined();
        expect(rows[5].timing?.repeat?.boundsDuration).toBeUndefined();
      }
      for (const dosage of [parsed, parsed.fhirNext, cold]) {
        const weekQuery = options("2026-10-26T08:00:00+07:00", 4);
        expect(nextDueDoses(dosage, weekQuery)).toEqual([
          "2026-10-26T08:00:00+07:00", "2026-10-26T08:00:00+07:00",
          "2026-10-26T12:00:00+07:00", "2026-10-26T12:00:00+07:00"
        ]);
        expect(calculateTotalUnits({ ...weekQuery, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(8);
        const monthQuery = options("2026-11-19T08:00:00+07:00", 4);
        expect(nextDueDoses(dosage, monthQuery)).toEqual([
          "2026-11-19T08:00:00+07:00", "2026-11-19T08:00:00+07:00",
          "2026-11-19T12:00:00+07:00", "2026-11-19T16:00:00+07:00"
        ]);
        expect(calculateTotalUnits({ ...monthQuery, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(6);
      }
    });
});


describe("round48 parallel duration display boundaries", () => {
  it.each(["7d", "1wk"])("does not restart x%s beneath a copied stage heading", duration => {
    const parsed = parseSig(`1 drop OD q2h x${duration} then QID; 1 drop OS QID x1mo then BID`);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    const firstDuration = duration === "1wk" ? " for 1 week" : "";
    const expected = "From treatment start until 7 days after treatment start: " +
      "Instill 1 drop every 2 hours" + firstDuration + " in the right eye; " +
      "Instill 1 drop four times daily for 1 month in the left eye. " +
      "From 7 days after treatment start until 1 month after treatment start: " +
      "Instill 1 drop four times daily in the right eye; Instill 1 drop four times daily in the left eye. " +
      "From 1 month after treatment start onward: " +
      "Instill 1 drop four times daily in the right eye; Instill 1 drop twice daily in the left eye.";
    for (const input of [parsed.meta.canonical.course!, parsed.fhirNext, cold]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([
    ["shorter", "for 2 days", 0, 0],
    ["longer", "for 9 days", 0, 0],
    ["range", "for 1 to 9 days", 0, 0],
    ["qualified", "for <8 days", 0, 0],
    ["calendar", "for 30 days", 1, 1]
  ] as const)("keeps a current %s course length visible beside the global window", (kind, expected, stage, member) => {
    const current = JSON.parse(JSON.stringify(parseSig(twoSites).fhirNext));
    const repeat = current.step[stage].component[member].timing.repeat;
    const quantity = (value: number) => ({ value, unit: "d", code: "d", system: "http://unitsofmeasure.org" });
    if (kind === "range") {
      delete repeat.boundsDuration;
      repeat.boundsRange = { low: quantity(1), high: quantity(9) };
    } else repeat.boundsDuration = { ...quantity(kind === "shorter" ? 2 : kind === "longer" ? 9 : kind === "qualified" ? 8 : 30),
      ...(kind === "qualified" ? { comparator: "<" } : {}) };
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(current)));
    for (const input of [importCanonicalCourse(current), current, cold]) {
      const before = JSON.stringify(input);
      if (kind === "longer") expect(importCanonicalCourse(input).stages[stage].administrations[member].phaseOrigin)
        .toMatchObject({ value: 0, unit: "d" });
      const preview = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const stages = preview.trim().split(/ (?=From )/u);
      expect(stages).toHaveLength(3);
      const heading = stage === 0
        ? "From treatment start until 7 days after treatment start"
        : "From 7 days after treatment start until 1 month after treatment start";
      expect(stages[stage].startsWith(heading + ": ")).toBe(true);
      const instructions = stages[stage].slice(heading.length + 2).replace(/\.$/u, "").split("; ");
      const cadence = stage === 0 && member === 0 ? "every 2 hours" : "four times daily";
      expect(instructions[member]).toBe("Instill 1 drop " + cadence + " " + expected +
        " in the " + (member === 0 ? "right" : "left") + " eye");
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round49 qualified clocks and partial parallel members", () => {
  it.each([
    ["every morning at 10 AM starting the next day", false, true],
    ["in the morning at 10 AM", false, false],
    ["every morning at 10 AM and in the evening starting the next day", true, true]
  ] as const)("executes the qualified morning clock once and preserves an independent evening: %s",
    (timing, evening, onset) => {
    const source = "Take 1 tablet " + timing;
    const parsed = parseSig(source);
    const schedule = parsed.meta.canonical.clauses[0].schedule;
    expect(schedule?.when).toEqual(evening ? ["EVE"] : undefined);
    expect(schedule?.timeOfDay).toEqual(["10:00:00"]);
    expect(schedule?.count).toBeUndefined();
    expect(schedule?.treatmentStartOffsetDays).toBe(onset ? 1 : undefined);
    if (onset) expect(schedule).toMatchObject({ period: 1, periodUnit: "d" });
    const query = { orderedAt: "2026-12-01T00:00:00Z",
      from: onset ? "2026-12-01T00:00:00Z" : "2026-12-02T00:00:00Z",
      timeZone: "UTC", eventClock: { MORN: "08:00", EVE: "18:00" }, limit: 4 };
    const expected = evening ? [
      "2026-12-02T10:00:00+00:00", "2026-12-02T18:00:00+00:00",
      "2026-12-03T10:00:00+00:00", "2026-12-03T18:00:00+00:00"
    ] : [
      "2026-12-02T10:00:00+00:00", "2026-12-03T10:00:00+00:00",
      "2026-12-04T10:00:00+00:00", "2026-12-05T10:00:00+00:00"
    ];
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ ...query, from: "2026-12-02T00:00:00Z",
        dosage: input, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(evening ? 2 : 1);
      if (onset) expect(calculateTotalUnits({ ...query, dosage: input,
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(0);
    }
  });

  it.each([false, true])("retains a partial eye track without requiring a schedule on every member (%s)", scheduled => {
    const source = "Instill 1 drop OD" + (scheduled ? " daily" : "") +
      ", then instill 2 drops OD from 2026-12-05; instill 1 drop OS BID";
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(3);
    const native = parsed.meta.canonical.course!;
    const members = native.stages[0].administrations;
    expect(members.map(member => member.amounts?.[0].quantity?.value)).toEqual([1, 2, 1]);
    expect(members.map(member => member.target?.text)).toEqual(["right eye", "right eye", "left eye"]);
    if (scheduled) expect(members[0].schedule?.recurrence?.calendarWindow?.end).toBe("2026-12-04");
    else {
      expect(members[0].schedule).toBeUndefined();
      expect(members[0].phaseEnd).toBeUndefined();
    }
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const rows of [parsed.fhir, cold]) {
      expect(rows).toHaveLength(3);
      expect(rows.map(row => row.doseAndRate?.[0].doseQuantity?.value)).toEqual([1, 2, 1]);
      expect(rows[1].timing?.repeat?.boundsPeriod?.start).toBe("2026-12-05");
      expect(rows[2].timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
      if (!scheduled) expect(rows[0].timing).toBeUndefined();
    }
    expect(parsed.fhirNext.step[0].component).toHaveLength(3);
    const preview = formatSig(native, "long", { locale: "en", realizationMode: "normalized" });
    expect(preview).toContain("Instill 1 drop" +
      (scheduled ? " once daily through 4 Dec 2026" : "") + " in the right eye;");
    expect(preview).toContain("Instill 1 drop twice daily in the left eye.");
  });
});


describe("round50 counted implicit successors in independent tracks", () => {
  const context = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z", timeZone: "UTC" };
  it.each([false, true])("keeps the right-eye counted cutover independent of track order (%s)", reversed => {
    const right = "1 drop OD daily at 08:00 for 3 doses, then 2 drops OD daily at 08:00";
    const left = "1 drop OS BID";
    const source = reversed ? left + "; " + right : right + "; " + left;
    const parsed = parseSig(source);
    expect(parsed.input).toBe(source);
    const members = parsed.meta.canonical.course!.stages[0].administrations;
    const rightMembers = members.filter(member => member.target?.text === "right eye");
    const leftMember = members.find(member => member.target?.text === "left eye")!;
    expect(rightMembers.map(member => member.amounts![0].quantity!.value)).toEqual([1, 2]);
    expect(rightMembers[0].schedule?.recurrence?.count).toBe(3);
    expect(rightMembers[0].phasePredecessors).toEqual([]);
    expect(rightMembers[1].phasePredecessors).toEqual([rightMembers[0].sourceMember]);
    expect(rightMembers[1].phaseStart).toBeUndefined();
    expect(leftMember.phasePredecessors).toBeUndefined();
    for (const rows of [parsed.fhir, parsed.fhirNext.step[0].component]) {
      let participants = 0;
      for (const row of rows) for (const marker of row.modifierExtension ?? []) {
        if (marker.url !== PARALLEL_COMPONENT_PHASE_ORIGIN_URL ||
            !marker.extension?.some(child => child.url === "sourceMember")) continue;
        participants++;
        // The real storage converter rejects value[x] together with children.
        // Both the origin and dependency identity use the existing envelope.
        expect(marker.valueQuantity).toBeUndefined();
        expect(Object.keys(marker).filter(key => /^value[A-Z]/.test(key))).toEqual([]);
      }
      expect(participants).toBe(2);
    }
    const expected: string[] = [];
    for (let day = 1; day <= 5; day++) {
      const date = "2026-01-0" + day;
      expected.push(date + "T08:00:00+00:00", date + "T08:00:00+00:00", date + "T20:00:00+00:00");
    }
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...context, limit: 15 })).toEqual(expected);
      // Three 1-drop then two 2-drop right-eye doses, plus ten left-eye doses.
      expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 5, durationUnit: "d" }).totalUnits).toBe(17);
      expect(calculateTotalUnits({ dosage: input, ...context, from: "2026-01-04T00:00:00Z",
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(formatSig(parsed.fhirNext, "long", { locale: "en", realizationMode: "normalized" }))
      .toContain("After the previous phase: Instill 2 drops");
  });

  it("starts an elapsed successor from the final accepted point without a millisecond drift", () => {
    const parsed = parseSig("1 drop OD q12h for 3 doses, then 2 drops OD q12h; 1 drop OS BID");
    const expected = [
      "2026-01-01T00:00:00+00:00", "2026-01-01T08:00:00+00:00",
      "2026-01-01T12:00:00+00:00", "2026-01-01T20:00:00+00:00",
      "2026-01-02T00:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-02T12:00:00+00:00", "2026-01-02T20:00:00+00:00"
    ];
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...context, limit: 8 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 2, durationUnit: "d" }).totalUnits).toBe(9);
      expect(calculateTotalUnits({ dosage: input, ...context, from: "2026-01-02T00:00:00Z",
        durationValue: 12, durationUnit: "h" }).totalUnits).toBe(2);
      expect(calculateTotalUnits({ dosage: input, ...context, from: "2026-01-02T12:00:00Z",
        durationValue: 12, durationUnit: "h" }).totalUnits).toBe(3);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("waits for both finite members of the preceding right-eye phase", () => {
    const parsed = parseSig("1 drop OD daily at 08:00 for 3 doses and 1 drop OD daily at 20:00 for 4 doses, then 2 drops OD daily at 08:00; 1 drop OS BID");
    const members = parsed.meta.canonical.course!.stages[0].administrations;
    expect(members[2].phasePredecessors).toEqual([members[0].sourceMember, members[1].sourceMember]);
    expect(members[3].phasePredecessors).toBeUndefined();
    for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...context, from: "2026-01-04T00:00:00Z", limit: 5 })).toEqual([
        "2026-01-04T08:00:00+00:00",
        "2026-01-04T20:00:00+00:00", "2026-01-04T20:00:00+00:00",
        "2026-01-05T08:00:00+00:00", "2026-01-05T08:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 6, durationUnit: "d" }).totalUnits).toBe(23);
      expect(calculateTotalUnits({ dosage: input, ...context, from: "2026-01-04T00:00:00Z",
        durationValue: 1, durationUnit: "d" }).totalUnits).toBe(3);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round56: explicit NEXT daughter with its own dose", () => {
  it.each(["and take 2 tablets", "then take 2 tablets", "and"])(
    "owns the next civil day after the predecessor occurrence: %s", daughter => {
      const parsed = parseSig("Take 1 tablet at 22:00 " + daughter + " the next morning");
      const secondDose = daughter === "and" ? 1 : 2;
      expect(parsed.meta.canonical.clauses.map(c => c.dose?.value)).toEqual([1, secondDose]);
      expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
      expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBe("previous-phase-next-day");
      for (const input of [parsed, parsed.meta.canonical.course!, parsed.fhirNext,
        JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
        const before = JSON.stringify(input);
        const context = { orderedAt: "2026-12-01T23:00:00Z", from: "2026-12-01T23:00:00Z",
          timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 5 };
        expect(nextDueDoses(input, context)).toEqual([
          "2026-12-02T22:00:00+00:00", "2026-12-03T08:00:00+00:00"
        ]);
        expect(calculateTotalUnits({ dosage: input, ...context, durationValue: 3, durationUnit: "d" }).totalUnits)
          .toBe(1 + secondDose);
        expect(JSON.stringify(input)).toBe(before);
      }
  });

  it("keeps ordinary coordination without typed NEXT on its own daily schedule", () => {
    const parsed = parseSig("Take 1 tablet at 22:00 and take 2 tablets in the morning");
    expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).toBeUndefined();
    expect(nextDueDoses(parsed, { orderedAt: "2026-12-01T23:00:00Z", from: "2026-12-01T23:00:00Z",
      timeZone: "UTC", eventClock: { MORN: "08:00" }, limit: 3 })).toEqual([
      "2026-12-02T08:00:00+00:00", "2026-12-02T22:00:00+00:00", "2026-12-03T08:00:00+00:00"
    ]);
  });
});


describe("round72 dated replacement keeps its authored predecessor length", () => {
  it.each([[false, 2], [false, 7], [true, 2], [true, 7]] as const)("cuts the same-eye recurrence before a dated replacement (independent track %s, duration %s)", (independent, duration) => {
    const source = `Instill 1 drop OD QID starting 2026-12-01 for ${duration} days, then starting 2026-12-05 instill 2 drops OD BID` +
      (independent ? "; instill 1 drop OS BID" : "");
    const parsed = parseSig(source), native = parsed.meta.canonical.course!;
    const before = JSON.stringify(parsed);
    const predecessor = native.stages.flatMap(stage => stage.administrations)
      .find(member => member.target?.text === "right eye" && member.amounts?.[0].quantity?.value === 1)!;
    expect(predecessor.schedule?.recurrence?.calendarWindow).toEqual({ start: "2026-12-01", end: duration === 7 ? "2026-12-04" : "2026-12-02" });
    expect(predecessor.anchoredLength?.quantity).toEqual({ value: duration, unit: "d" });
    expect(parsed.meta.canonical.clauses[0].schedule?.duration).toBe(duration);
    const query = { orderedAt: "2026-12-01T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC",
      limit: independent ? 4 : 2 };
    for (const dosage of [parsed, native, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(nextDueDoses(dosage, query)).toEqual(independent ? [
        "2026-12-05T08:00:00+00:00", "2026-12-05T08:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-05T20:00:00+00:00"
      ] : ["2026-12-05T08:00:00+00:00", "2026-12-05T20:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(independent ? 6 : 4);
      expect(calculateTotalUnits({ ...query, from: "2026-12-04T00:00:00Z", dosage, durationValue: 1, durationUnit: "d" })
        .totalUnits).toBe((duration === 7 ? 4 : 0) + (independent ? 2 : 0));
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("round74 same-day dated clock replacement", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const source = "Instill 1 drop OD at 08:00 and 20:00 daily starting 2026-12-05, then starting 2026-12-05 at 18:00 instill 2 drops OD daily";

  it.each([[false, "UTC", "+00:00"], [true, "UTC", "+00:00"],
    [false, "Asia/Bangkok", "+07:00"], [true, "Asia/Bangkok", "+07:00"]] as const)(
    "keeps the morning predecessor and replaces its evening dose (independent=%s, zone=%s)", (independent, timeZone, offset) => {
      const parsed = parseSig(source + (independent ? "; instill 1 drop OS daily at 10:00 starting 2026-12-05" : ""));
      const native = parsed.meta.canonical.course!, before = JSON.stringify(parsed);
      const expected = (independent
        ? ["2026-12-05T08:00:00", "2026-12-05T10:00:00", "2026-12-05T18:00:00", "2026-12-06T10:00:00", "2026-12-06T18:00:00"]
        : ["2026-12-05T08:00:00", "2026-12-05T18:00:00", "2026-12-06T18:00:00", "2026-12-07T18:00:00", "2026-12-08T18:00:00"]
      ).map(time => time + offset);
      const query = { orderedAt: "2026-12-05T00:00:00" + offset, from: "2026-12-05T00:00:00" + offset, timeZone, limit: 5 };
      for (const dosage of [parsed, native, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 3, durationUnit: "d" }).totalUnits)
          .toBe(independent ? 10 : 7);
      }
      expect(JSON.stringify(parsed)).toBe(before);
    });

  it("keeps independently submitted same-day parallel clocks active without a replacement link", () => {
    const component = (dose: number, clocks: string[]) => ({
      method: { text: "Instill" }, site: { concept: { text: "right eye" } },
      doseAndRate: [{ doseQuantity: { value: dose, unit: "drop" } }],
      timing: { repeat: { boundsPeriod: { start: "2026-12-05" }, frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: clocks } }
    });
    const input = { step: [{ component: [component(1, ["08:00:00", "20:00:00"]), component(2, ["18:00:00"])] }] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    const query = { orderedAt: "2026-12-05T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [input, rows, fresh(toDosageDetails(rows))]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-06T08:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(4);
    }
    expect(input).toEqual(before);
  });

  it("preserves an independently supplied earlier predecessor end", () => {
    const input = { step: [
      { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
        timing: { repeat: { boundsPeriod: { start: "2026-12-05", end: "2026-12-05T12:00:00Z" },
          frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "14:00:00", "20:00:00"] } } }] },
      { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
        timing: { repeat: { boundsPeriod: { start: "2026-12-05" },
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, timeOfDay: ["18:00:00"] } } }] }
    ] };
    const before = fresh(input), rows = fresh(toFhirR5Dosages(input));
    const query = { orderedAt: "2026-12-05T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 3 };
    for (const dosage of [input, rows, fresh(toDosageDetails(rows))]) {
      expect(nextDueDoses(dosage, query)).toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00", "2026-12-06T18:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(3);
    }
    expect(input).toEqual(before);
    expect(toDosageDetails(rows).step![0].component[0].timing?.repeat?.boundsPeriod).toEqual(input.step[0].component[0].timing.repeat.boundsPeriod);
  });
});


it("round74 explicit successor timestamp remains the replacement boundary", () => {
  const input = { step: [
    { component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { boundsPeriod: { start: "2026-12-05" }, frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["08:00:00", "14:00:00", "20:00:00"] } } }] },
    { component: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "drop" } }],
      timing: { repeat: { boundsPeriod: { start: "2026-12-05T12:00:00Z" }, frequency: 1, period: 1,
        periodUnit: FhirPeriodUnit.Day, timeOfDay: ["18:00:00"] } } }] }
  ] };
  const rows = JSON.parse(JSON.stringify(toFhirR5Dosages(input)));
  const query = { orderedAt: "2026-12-05T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 3 };
  for (const dosage of [input, rows, toDosageDetails(rows)]) {
    expect(nextDueDoses(dosage, query)).toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00", "2026-12-06T18:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(3);
  }
});


it("round74 same-day replacement caps a longer authored duration without rewriting it", () => {
  const parsed = parseSig("Instill 1 drop OD at 08:00 and 20:00 daily for 1 day starting 2026-12-05, then starting 2026-12-05 at 18:00 instill 2 drops OD daily");
  const before = JSON.stringify(parsed), query = { orderedAt: "2026-12-05T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 3 };
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  for (const dosage of [parsed, parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
    expect(nextDueDoses(dosage, query)).toEqual(["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00", "2026-12-06T18:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(3);
  }
  expect(parsed.meta.canonical.course!.stages[0].administrations[0].anchoredLength?.quantity).toEqual({ value: 1, unit: "d" });
  expect(JSON.stringify(parsed)).toBe(before);
});

it("round74 a late absolute query retains the dated replacement opening without an order date", () => {
  const source = "Instill 1 drop OD at 08:00 and 20:00 daily starting 2026-12-05, then starting 2026-12-05 at 18:00 instill 2 drops OD daily";
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  for (const independent of [false, true]) {
    const parsed = parseSig(source + (independent ? "; instill 1 drop OS daily at 10:00 starting 2026-12-05" : ""));
    const query = { from: "2026-12-06T00:00:00Z", timeZone: "UTC", limit: 2 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(nextDueDoses(dosage, query)).toEqual(independent
        ? ["2026-12-06T10:00:00+00:00", "2026-12-06T18:00:00+00:00"]
        : ["2026-12-06T18:00:00+00:00", "2026-12-07T18:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }).totalUnits).toBe(independent ? 3 : 2);
    }
  }
});


{

const parseSig = parsePublicSig;


const freshExecutionInput = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const origin = "2026-01-01T00:00:00Z";
const options = { from: origin, orderedAt: origin, timeZone: "UTC" };
const dose = (value = 1): CanonicalAdministration => ({
  kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
  schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"] } },
});
const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
  calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: Unit.Day, ...extra });
const relative = (value: number, unit = "d") => ({
  anchor: "treatment-start" as const, displacement: { value, unit },
});
const capacity = (count = 2): CanonicalAdministration => ({
  ...dose(), asNeeded: true,
  amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
  schedule: { recurrence: { countMax: count,
    occurrenceCap: { max: 2, period: 1, periodUnit: Unit.Day } } },
  limits: [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }],
});



describe("round36 execution admission and actual-clock ownership", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (member: CanonicalAdministration | CanonicalCourse, version: typeof versions[number]) => {
    const course: CanonicalCourse = member.kind === "course" ? member : { kind: "course", stages: [{ administrations: [member] }] };
    return version === "native" ? member : version === "R5"
      ? JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[] : JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction;
  };
  const periodCap = (value = 100, hours = 24, unit = "tab"): NonNullable<CanonicalAdministration["limits"]> =>
    [{ scope: "period", amount: { value, unit }, period: { value: hours, unit: "h" } }];
  const untimed = (): CanonicalAdministration => JSON.parse(JSON.stringify(
    parseSig("Take 1 tablet as needed at most once daily.").meta!.canonical!.course!.stages[0].administrations[0]));

  it.each(versions)("keeps unrecorded untimed PRN capacity after a midday query (%s)", version => {
    for (const ranged of [false, true]) for (const repetition of ["stage", "course"] as const) {
      const member = untimed();
      if (ranged) member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
      member.limits = periodCap(1, 48);
      const course: CanonicalCourse = { kind: "course",
        ...(repetition === "course" ? { cycleInterval: { value: 1, unit: "d" }, cycleCount: 2 } : {}),
        stages: [{ ...(repetition === "stage" ? { count: 2 } : {}),
          start: relative(0), end: relative(1), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const query = { ...options, dosage: input, from: "2026-01-01T12:00:00Z", durationValue: 1, durationUnit: Unit.Day };
      expect(calculateTotalUnits(query).totalUnits).toBe(1);
      expect(calculateTotalUnits({ ...query, priorDoseTimes: ["2026-01-01T08:00:00Z"] }).totalUnits).toBe(0);
      expect(nextDueDoses(input, { ...query, limit: 2 })).toEqual([]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("spends a finite PRN allowance only on admitted opportunities (%s)", version => {
    for (const bound of ["count", "countMax"] as const) for (const restriction of ["condition", "date", "weekday"] as const) {
      const member = dose(); member.asNeeded = true; member.schedule!.recurrence![bound] = 2;
      if (restriction === "condition") member.predicate = { kind: "state", name: "pain", text: "pain", expected: true };
      if (restriction === "date") member.excludedDates = ["2026-01-01"];
      if (restriction === "weekday") member.excludedWeekdays = [FhirDayOfWeek.Thursday];
      const input = wire(member, version), before = JSON.stringify(input);
      const query = { ...options, limit: 4, evaluateCondition: (_condition: unknown, at: string) => !at.startsWith("2026-01-01") };
      expect(nextDueDoses(input, query)).toEqual(["2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00"]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(nextDueDoses(input, { ...query, priorCount: 1 })).toEqual(["2026-01-02T09:00:00+00:00"]);
      expect(nextDueDoses(input, { ...query, priorCount: 2 })).toEqual([]);
      expect(calculateTotalUnits({ ...query, dosage: input, priorCount: 2, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(0);
      const late = { ...query, from: "2026-01-03T00:00:00Z" };
      expect(nextDueDoses(input, late)).toEqual(["2026-01-03T09:00:00+00:00", "2026-01-04T09:00:00+00:00"]);
      expect(nextDueDoses(input, { ...late, priorDoseTimes: ["2026-01-02T10:00:00Z"] }))
        .toEqual(["2026-01-03T09:00:00+00:00"]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("retains a conditional PRN one-shot identity and explicit consumed count (%s)", version => {
    const member = dose(); member.asNeeded = true; member.schedule!.recurrence = { count: 1 };
    member.predicate = { kind: "state", name: "pain", text: "pain", expected: true };
    const input = wire(member, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => true, limit: 2 }))
      .toEqual(["2026-01-01T00:00:00+00:00"]);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => false, limit: 2 })).toEqual([]);
    expect(nextDueDoses(input, { ...options, evaluateCondition: () => true, priorCount: 1, limit: 2 })).toEqual([]);
    expect(nextDueDoses(input, { ...options, from: "2026-01-02T00:00:00Z", evaluateCondition: () => true, limit: 2 })).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("charges delayed administrations to their actual civil occurrence buckets (%s)", version => {
    for (const ranged of [false, true]) {
      const member = untimed(); member.asNeeded = false; member.delayMinutes = 120;
      if (ranged) {
        member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
        member.limits = periodCap();
      }
      member.schedule!.recurrence = { ...member.schedule!.recurrence, frequency: 2, period: 1, periodUnit: Unit.Day,
        clocks: ["00:30:00", "22:30:00"] };
      const input = wire(member, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-01-01T02:30:00+00:00", "2026-01-02T00:30:00+00:00", "2026-01-03T00:30:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 26, durationUnit: Unit.Hour }).totalUnits)
        .toBe(ranged ? 4 : 2);
      expect(nextDueDoses(input, { ...options, from: "2026-01-01T03:00:00Z",
        priorDoseTimes: ["2026-01-01T02:30:00Z"], limit: 2 })).toEqual([
        "2026-01-02T00:30:00+00:00", "2026-01-03T00:30:00+00:00",
      ]);
      expect(JSON.stringify(input)).toBe(before);
      const durationBound = freshExecutionInput(member);
      durationBound.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      expect(calculateTotalUnits({ ...options, dosage: wire(durationBound, version),
        durationValue: 26, durationUnit: Unit.Hour }).totalUnits).toBe(ranged ? 4 : 2);
      const calendarBound = freshExecutionInput(durationBound);
      calendarBound.schedule!.recurrence!.calendarWindow = { end: "2026-01-01T22:00:00Z" };
      expect(calculateTotalUnits({ ...options, dosage: wire(calendarBound, version),
        durationValue: 26, durationUnit: Unit.Hour }).totalUnits).toBe(ranged ? 2 : 1);
      const undelayed = freshExecutionInput(member);
      undelayed.delayMinutes = 0;
      expect(nextDueDoses(wire(undelayed, version), { ...options, limit: 2 })).toEqual([
        "2026-01-01T00:30:00+00:00", "2026-01-02T00:30:00+00:00",
      ]);
    }
  });

  it.each(versions)("charges the range's bilateral drop amount to its rolling cap (%s)", version => {
    const member = structuredClone(parseSig("Instill 1-2 drops in each eye at 08:00 and 20:00")
      .meta!.canonical!.course!.stages[0].administrations[0]);
    member.limits = periodCap(3, 24, "drop");
    const input = wire(member, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    // One target may admit both minimum amounts within the same cap.
    const singleTarget = { ...member, targetCount: 1 };
    expect(nextDueDoses(singleTarget, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
    // Metric quantities already describe the total and must not multiply by target count.
    const metric: CanonicalAdministration = { ...member, targetCount: 2,
      amounts: [{ range: { low: { value: 1, unit: "mg" }, high: { value: 2, unit: "mg" } } }],
      limits: periodCap(3, 24, "mg") };
    expect(nextDueDoses(metric, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
  });

  it.each(versions)("keeps shifted candidates inside the actual exclusive stage end (%s)", version => {
    for (const delayMinutes of [-120, 0, 120]) {
      const member = dose(); member.delayMinutes = delayMinutes; member.limits = periodCap();
      const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 1,
        stages: [{ start: relative(0), end: relative(8, "h"), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 }))
        .toEqual(delayMinutes < 0 ? ["2026-01-01T07:00:00+00:00"] : []);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(delayMinutes < 0 ? 1 : 0);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("charges actual history to a counted phase without moving its authored end (%s)", version => {
    const loading = dose(); loading.schedule!.recurrence!.clocks = ["07:00:00"];
    loading.schedule!.recurrence!.count = 2; loading.limits = periodCap();
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(0), end: relative(4), administrations: [loading] }, { administrations: [dose(2)] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { ...options, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-02T00:00:00Z", limit: 3 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-02T07:00:00+00:00", "2026-01-03T07:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    const recorded = { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z"] };
    expect(nextDueDoses(input, recorded)).toEqual([
      "2026-01-02T07:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ ...recorded, dosage: input, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"] })[0])
      .toBe("2026-01-05T09:00:00+00:00");
    expect(nextDueDoses(input, { ...query, priorDoseTimes: ["2026-01-01T07:00:00Z"] })).toEqual(nextDueDoses(input, query));
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("round37 finite-phase history and eligibility ownership", () => {
  const versions = ["native", "R5", "R6"] as const;
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "R5"
      ? JSON.parse(JSON.stringify(courseToR5(course))) as FhirDosage[]
      : JSON.parse(JSON.stringify(courseToR6(course))) as FhirR6DosageInstruction;
  const counted = (count: number): CanonicalAdministration => ({
    ...dose(),
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["08:00:00"], count } },
    limits: [{ scope: "period", amount: { value: 100, unit: "tab" }, period: { value: 24, unit: "h" } }],
  });

  it.each(versions)("uses actual finite-phase history before replay without shifting its end or another cycle (%s)", version => {
    const maintenance = dose(2); maintenance.schedule!.recurrence!.count = 1;
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 2,
      stages: [{ start: relative(0), end: relative(4), administrations: [counted(2)] },
        { administrations: [maintenance] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const query = { ...options, from: "2026-01-02T00:00:00Z", limit: 8 };
    const remaining = [
      "2026-01-02T08:00:00+00:00", "2026-01-05T09:00:00+00:00",
      "2026-01-08T08:00:00+00:00", "2026-01-09T08:00:00+00:00", "2026-01-12T09:00:00+00:00",
    ];
    for (const priorDoseTimes of [undefined, ["2026-01-01T08:00:00Z"], ["2026-01-01T10:00:00Z"]]) {
      const history = { ...query, priorDoseTimes };
      expect(nextDueDoses(input, history)).toEqual(remaining);
      expect(calculateTotalUnits({ dosage: input, ...history, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(calculateTotalUnits({ dosage: input, ...history, durationValue: 11, durationUnit: Unit.Day }).totalUnits).toBe(7);
    }
    const later = { ...query, from: "2026-01-03T00:00:00Z", priorDoseTimes: ["2026-01-01T10:00:00Z"] };
    expect(nextDueDoses(input, later)).toEqual(["2026-01-03T08:00:00+00:00", ...remaining.slice(1)]);
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    const completed = { ...query, priorDoseTimes: ["2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"] };
    expect(nextDueDoses(input, completed)).toEqual(remaining.slice(1));
    expect(calculateTotalUnits({ dosage: input, ...completed, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    // A record outside this phase does not replace its inferred daily history.
    expect(nextDueDoses(input, { ...query, from: "2026-01-03T00:00:00Z",
      priorDoseTimes: ["2025-12-31T10:00:00Z"] })).toEqual(remaining.slice(1));
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["exact", "range", "maximum"].map(quota => [version, quota] as const)))
    ("starts finite count at eligibility while retaining an earlier recurrence origin (%s, %s)", (version, quota) => {
    for (const period of [1, 2]) for (const stageStart of [0, 3]) {
      const member = counted(quota === "range" ? 1 : 2); member.limits = undefined;
      if (quota !== "exact") member.schedule!.recurrence!.countMax = 2;
      if (quota === "maximum") delete member.schedule!.recurrence!.count;
      member.phaseStart = relative(0);
      member.schedule!.recurrence!.period = period;
      member.schedule!.recurrence!.clocks = ["09:00:00"];
      const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(stageStart), administrations: [member] }] };
      const input = wire(course, version), before = JSON.stringify(input);
      const days = stageStart === 0 ? (period === 1 ? [1, 2] : [1, 3])
        : period === 1 ? [4, 5] : [5, 7];
      const expected = days.map(day => "2026-01-0" + day + "T09:00:00+00:00");
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 8, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(nextDueDoses(input, { ...options, from: "2026-01-06T00:00:00Z", limit: 4 }))
        .toEqual(stageStart === 3 && period === 2 ? [expected[1]] : []);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("keeps actual-history ownership within staggered member eligibility (%s)", version => {
    const first = counted(3), second = counted(2);
    first.phaseStart = relative(0);
    second.phaseStart = relative(2);
    second.schedule!.recurrence!.clocks = ["20:00:00"];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(1), end: relative(5), administrations: [first, second] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    for (const hasEligibleActual of [false, true]) {
      // The Jan 1 record is before the stage. Jan 2 belongs only to the first
      // member; the second retains its inferred Jan 3 20:00 administration.
      const priorDoseTimes = ["2026-01-01T10:00:00Z",
        ...(hasEligibleActual ? ["2026-01-02T10:00:00Z"] : [])];
      const query = { ...options, from: "2026-01-04T00:00:00Z", priorDoseTimes, limit: 8 };
      const expected = ["2026-01-04T08:00:00+00:00", "2026-01-04T20:00:00+00:00",
        ...(hasEligibleActual ? ["2026-01-05T08:00:00+00:00"] : [])];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits)
        .toBe(hasEligibleActual ? 3 : 2);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("uses the same remaining finite allowance for ranged due doses and maximum supply (%s)", version => {
    const member = counted(3);
    member.schedule!.recurrence!.frequency = 2;
    member.schedule!.recurrence!.clocks = ["08:00:00", "20:00:00"];
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" }, cycleCount: 1,
      stages: [{ start: relative(0), end: relative(4), administrations: [member] }] };
    const input = wire(course, version), before = JSON.stringify(input);
    const expected = ["2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00"];
    for (const priorDoseTimes of [
      ["2026-01-01T20:00:00Z"],
      ["2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"],
      ["2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z", "2026-01-01T20:00:00Z"],
    ]) {
      const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes, limit: 4 };
      const remaining = 3 - priorDoseTimes.length;
      expect(nextDueDoses(input, query)).toEqual(expected.slice(0, remaining));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(remaining * 2);
    }
    // The two remaining uses must also fit the authored rolling quantity
    // ceiling: 2 actual tablets at Jan 1 20:00 leave 1 at Jan 2 08:00, then
    // that old record expires and permits 2 at Jan 2 20:00. Total: 3.
    const cappedMember = { ...member, limits: [{ scope: "period" as const,
      amount: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }] };
    const cappedCourse: CanonicalCourse = { ...course,
      stages: [{ ...course.stages[0], administrations: [cappedMember] }] };
    const cappedInput = wire(cappedCourse, version), cappedBefore = JSON.stringify(cappedInput);
    const cappedQuery = { ...options, from: "2026-01-02T00:00:00Z",
      priorDoseTimes: ["2026-01-01T20:00:00Z"], limit: 4 };
    expect(nextDueDoses(cappedInput, cappedQuery)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: cappedInput, ...cappedQuery, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(JSON.stringify(cappedInput)).toBe(cappedBefore);
    // Without actual history, the two Jan 1 clocks consume two of three uses.
    const inferred = { ...options, from: "2026-01-02T00:00:00Z", limit: 4 };
    expect(nextDueDoses(input, inferred)).toEqual([expected[0]]);
    expect(calculateTotalUnits({ dosage: input, ...inferred, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });
});
{
  const describe = round38_execution20_describe;
  const expect = round38_execution20_expect;
  const it = round38_execution20_it;
  const calculateTotalUnits = round38_execution20_calculateTotalUnits;
  const nextDueDoses = round38_execution20_nextDueDoses;
  const parseSig = round38_execution20_parseSig;
  const toFhirR5Dosages = round38_execution20_toFhirR5Dosages;
  type CanonicalAdministration = round38_execution20_CanonicalAdministration;
  type CanonicalCourse = round38_execution20_CanonicalCourse;
  const FhirPeriodUnit = round38_execution20_FhirPeriodUnit;
  type FhirPeriodUnit = round38_execution20_FhirPeriodUnit;
  type FhirDosage = round38_execution20_FhirDosage;
  type FhirR6DosageInstruction = round38_execution20_FhirR6DosageInstruction;
  const addCalendarDaysAtClock = round38_execution20_addCalendarDaysAtClock;
  const addCalendarMonths = round38_execution20_addCalendarMonths;
  const getTimeParts = round38_execution20_getTimeParts;
// BEGIN PRESERVED execution20
/** Independent execution oracles for the complete November 18 review families. */






const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" };
const dose = (value = 1): CanonicalAdministration => ({
  kind: "administration",
  amounts: [{ quantity: { value, unit: "tab" } }],
  schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["08:00:00"] } },
});
const supply = (dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) =>
  calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: FhirPeriodUnit.Day, ...extra });
const relative = (value: number, unit = "d") => ({
  anchor: "treatment-start" as const, displacement: { value, unit },
});

describe("day boundaries and exact recurrence precision", () => {
  it("uses the local day when midnight is skipped but the prescribed clock exists", () => {
    const input: CanonicalAdministration = dose();
    input.schedule!.recurrence!.calendarWindow = { start: "2026-09-06", end: "2026-09-06" };
    const config = { from: "2026-09-06T00:00:00-04:00", orderedAt: "2026-09-06T00:00:00-04:00",
      timeZone: "America/Santiago" };
    expect(nextDueDoses(input, { ...config, limit: 3 })).toEqual(["2026-09-06T08:00:00-03:00"]);
    expect(calculateTotalUnits({ ...config, dosage: input, durationValue: 1,
      durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(1);
  });

  it("resolves a date-only event before applying its exact authored clock", () => {
    const input: CanonicalAdministration = dose();
    input.schedule!.explicitEvents = ["2026-09-06"];
    expect(nextDueDoses(input, {
      from: "2026-09-06T00:00:00-04:00", timeZone: "America/Santiago", limit: 3,
    })).toEqual(["2026-09-06T08:00:00-03:00"]);
  });

  it.each([FhirPeriodUnit.Day, FhirPeriodUnit.Month])(
    "retains fractional seconds on civil %s stepping and a query exactly on the next instant", unit => {
      const input: CanonicalAdministration = {
        ...dose(),
        schedule: { recurrence: { frequency: 1, period: 2, periodUnit: unit } },
      };
      const anchor = "2026-01-01T00:00:00.500Z";
      const next = unit === FhirPeriodUnit.Day ? "2026-01-03T00:00:00.500+00:00" : "2026-03-01T00:00:00.500+00:00";
      expect(nextDueDoses(input, { from: anchor, orderedAt: anchor, timeZone: "UTC", limit: 2 }))
        .toEqual(["2026-01-01T00:00:00.500+00:00", next]);
      expect(nextDueDoses(input, { from: next, orderedAt: anchor, timeZone: "UTC", limit: 1 })).toEqual([next]);
    }
  );

  it("keeps a civil fraction through both sides of a DST change", () => {
    const anchor = new Date("2026-03-07T08:00:00.500-05:00");
    const clock = getTimeParts(anchor, "America/New_York");
    expect(addCalendarDaysAtClock(anchor, 2, "America/New_York", clock)!.toISOString())
      .toBe("2026-03-09T12:00:00.500Z");
    expect(addCalendarMonths(anchor, 1, "America/New_York", clock).toISOString())
      .toBe("2026-04-07T12:00:00.500Z");
  });

  it("returns no requested events before requiring a timezone or importing rows", () => {
    const rows: FhirDosage[] = [{ sequence: 1 }, { sequence: 2 }];
    expect(nextDueDoses(rows, { from, limit: 0 })).toEqual([]);
  });
});

describe("quantity accounting retains the meaning of the supplied constraints", () => {
  it("measures a code-only UCUM rate with its supplied infusion duration", () => {
    const input: CanonicalAdministration = {
      ...dose(), amounts: [{ rate: { value: 10, system: "http://unitsofmeasure.org", code: "mL/h" } }],
      schedule: { recurrence: { count: 1, clocks: ["08:00:00"], occurrenceDuration: 1,
        occurrenceDurationUnit: FhirPeriodUnit.Hour } },
    };
    expect(supply(input, 1)).toMatchObject({ totalUnits: 10, unit: "mL" });
    const capped = freshExecutionInput(input);
    capped.limits = [{ scope: "period", amount: { value: 10, unit: "mL" }, period: { value: 24, unit: "h" } }];
    expect(supply(capped, 1).totalUnits).toBe(10);
    const extended = freshExecutionInput(capped);
    extended.schedule!.recurrence!.occurrenceDuration = 2;
    extended.limits![0].amount.value = 30;
    expect(supply(extended, 1)).toMatchObject({ totalUnits: 20, unit: "mL" });
  });

  it.each([[10, 20], [20, 10], [10, 20, 30]])(
    "uses the tightest compatible lifetime bound (%s, %s)", (...values) => {
      const input = dose();
      input.limits = values.map(value => ({ scope: "lifetime", amount: { value, unit: "tab" } }));
      const result = supply(input, 30);
      expect(result.totalUnits).toBe(10);
      expect(result.quantityKind).toBe("maximum");
      expect(result.explanation).not.toContain("could not be applied");
    }
  );
  it("still evaluates one lifetime bound", () => {
    const input = dose();
    input.limits = [{ scope: "lifetime", amount: { value: 10, unit: "tab" } }];
    expect(supply(input, 30).totalUnits).toBe(10);
  });
  it.each([">", ">="] as const)("does not report a %s dose as an exact required supply", comparator => {
    const input = dose(500);
    input.amounts![0].quantity = { value: 500, unit: "mL", comparator };
    expect(() => supply(input, 1)).toThrow(/lower bound/);
    expect(nextDueDoses(input, { ...options, limit: 1 })).toEqual(["2026-01-01T08:00:00+00:00"]);
    expect(input.amounts![0].quantity.comparator).toBe(comparator);
  });
  it("continues to measure an approximate nominal dose", () => {
    const input = dose();
    input.amounts![0].quantity!.comparator = "~";
    expect(supply(input, 3).totalUnits).toBe(3);
  });
});

describe("step and cap planning", () => {
  it("repeats a one-day step three times without a course repeat cycle", () => {
    const course: CanonicalCourse = {
      kind: "course", stages: [{
        count: 3, start: relative(0), end: relative(1), administrations: [dose()],
      }],
    };
    expect(nextDueDoses(course, { ...options, limit: 10 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
    ]);
    expect(supply(course, 3).totalUnits).toBe(3);
  });

  it("opens maintenance only after the capped loading dose is actually admitted", () => {
    const load = dose(2);
    load.schedule!.recurrence!.count = 1;
    load.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const maintenance = dose();
    maintenance.schedule!.recurrence!.clocks = ["09:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 10, unit: "d" };
    maintenance.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 7, unit: "d" },
      stages: [{ administrations: [load] }, { administrations: [maintenance] }] };
    expect(nextDueDoses(course, { ...options, limit: 6 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00",
      "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
      "2026-01-04T09:00:00+00:00", "2026-01-05T09:00:00+00:00",
    ]);
    expect(supply(course, 5).totalUnits).toBe(7);
  });

  it.each([false, true])("defers capped loading before opening maintenance (repeated=%s)", repeated => {
    const load = dose(2); load.schedule!.recurrence!.count = 1;
    load.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 24, unit: "h" } }];
    const maintenance = dose(); maintenance.schedule!.recurrence!.clocks = ["09:00:00"];
    maintenance.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    const course: CanonicalCourse = { kind: "course",
      ...(repeated ? { cycleInterval: { value: 7, unit: "d" }, cycleCount: 1 } : {}),
      stages: [{ administrations: [load] }, { administrations: [maintenance] }] };
    // This record is before the loading phase. It blocks Jan 1's rolling cap,
    // but cannot satisfy that phase's one required loading administration.
    const priorDoseTimes = ["2025-12-31T20:00:00Z"];
    expect(nextDueDoses(course, { ...options, priorDoseTimes, limit: 3 })).toEqual([
      "2026-01-02T08:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
  });

  it("retains accepted monthly-cap history that a later clamped cutoff includes again", () => {
    const member = dose();
    member.schedule = { explicitEvents: [
      "2026-02-28T07:30:00Z", "2026-03-30T08:00:00Z", "2026-03-30T09:00:00Z", "2026-03-31T07:00:00Z",
    ] };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "mo" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "a" },
      stages: [{ administrations: [member] }] };
    // Two independently authored March 30 events share this member's cap.
    // The February dose re-enters the month window on March 31 at 07:00
    // and blocks a fourth tablet.
    const actual = calculateTotalUnits({
      dosage: course, from: "2026-02-28T00:00:00Z", orderedAt: "2025-03-01T00:00:00Z",
      timeZone: "UTC", durationValue: 33, durationUnit: FhirPeriodUnit.Day,
    });
    expect(actual.totalUnits).toBe(3);
    for (const [from, expected] of [["2026-02-28", 1], ["2026-03-30", 2], ["2026-03-31", 0]] as const) {
      expect(calculateTotalUnits({ dosage: course, from: from + "T00:00:00Z", orderedAt: "2025-03-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(expected);
    }
  });
});

describe("range amounts and rolling ceilings share one quantity ledger", () => {
  const ranged = (ceiling: number, hours = 24): CanonicalAdministration => ({
    kind: "administration",
    amounts: [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
    schedule: { recurrence: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day,
      clocks: ["08:00:00", "20:00:00"] } },
    limits: [{ scope: "period", amount: { value: ceiling, unit: "tab" }, period: { value: hours, unit: "h" } }],
  });
  it.each([[1, 1], [1.5, 1.5], [2, 2], [3, 3], [4, 4]])(
    "measures the feasible maximum under a %s-tablet/day cap", (cap, expected) => {
      const member = ranged(cap), saved = structuredClone(member);
      expect(supply(member, 1)).toMatchObject({ totalUnits: expected, quantityKind: "maximum" });
      expect(member).toEqual(saved);
    }
  );
  it.each([1, 2])("carries admitted amounts through %s-day overlapping/nonoverlapping cycles", length => {
    const member = ranged(3);
    member.schedule!.recurrence!.courseLength = { value: length, unit: "d" };
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    expect(supply(course, 3).totalUnits).toBe(9);
    expect(supply(course, 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(3);
  });
  it("selects a feasible finite per-administration maximum from the same range", () => {
    const member = ranged(4);
    member.limits = [{ scope: "administration", amount: { value: 1, unit: "tab" } }];
    expect(supply(member, 1)).toMatchObject({ totalUnits: 2, quantityKind: "maximum" });
    expect(member.amounts![0].range!.high!.value).toBe(2);
  });
  it("keeps a low-only range unresolved unless a compatible administration maximum supplies its ceiling", () => {
    const member = ranged(4);
    member.amounts![0].range = { low: { value: 1, unit: "tab" } };
    member.limits = undefined;
    expect(() => supply(member, 1)).toThrow(/no finite upper bound/);
    expect(nextDueDoses(member, { ...options, limit: 2 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
    ]);
    member.limits = [{ scope: "administration", amount: { value: 2, unit: "tab" } }];
    expect(supply(member, 1)).toMatchObject({ totalUnits: 4, quantityKind: "maximum" });
    expect(member.amounts![0].range!.high).toBeUndefined();
  });
  it("accounts for both targets in the same cap unit", () => {
    const member = ranged(3);
    member.targetCount = 2;
    member.amounts![0].range = { low: { value: 1, unit: "drop" }, high: { value: 2, unit: "drop" } };
    member.limits![0].amount = { value: 3, unit: "drop" };
    expect(supply(member, 1).totalUnits).toBe(3);
  });
  it("normalizes different range endpoint and limit units without editing the source", () => {
    const member = ranged(3);
    member.amounts![0].range = { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    member.limits![0].amount = { value: 1500, unit: "mg" };
    expect(supply(member, 1)).toMatchObject({ totalUnits: 1.5, unit: "g" });
  });
  const capacity = (ceiling: number, hours = 24) => {
    const member = ranged(ceiling, hours);
    member.schedule = { recurrence: { occurrenceCap: { max: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } };
    return member;
  };
  it("allocates three tablets over at most two untimed administrations", () => {
    expect(supply(capacity(3), 1).totalUnits).toBe(3);
  });
  it("does not fit two strictly-greater-than-1.5 doses into a three-tablet ceiling", () => {
    const member = capacity(3);
    member.amounts![0].range!.low = { value: 1.5, unit: "tab", comparator: ">" };
    expect(supply(member, 1).totalUnits).toBe(2);
  });
  it("keeps an administration slot for a second short-window allowance later that day", () => {
    expect(supply(capacity(2, 12), 1).totalUnits).toBe(4);
  });
  it("carries the actual capacity allocation quantity into later cycles", () => {
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [capacity(3, 48)] }] };
    expect(supply(course, 2).totalUnits).toBe(3);
    expect(supply(course, 3).totalUnits).toBe(6);
    expect(supply(course, 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(0);
  });
});

describe("local step repetitions retain their own phases in every cycle", () => {
  it("repeats a two-day active step within each three-day course cycle", () => {
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 3, unit: "d" },
      stages: [{ count: 2, start: relative(0), end: relative(1), administrations: [dose()] }] };
    expect(nextDueDoses(course, { ...options, limit: 6 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
      "2026-01-07T08:00:00+00:00", "2026-01-08T08:00:00+00:00",
    ]);
    expect(supply(course, 9).totalUnits).toBe(6);
  });
  it("shares caps between local finite-count step repetitions and opens the successor after acceptance", () => {
    const member = dose();
    member.schedule!.recurrence!.count = 1;
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 48, unit: "h" } }];
    const next = dose(2);
    next.schedule!.recurrence!.count = 1;
    next.schedule!.recurrence!.clocks = ["09:00:00"];
    const course: CanonicalCourse = { kind: "course", stages: [
      { count: 2, administrations: [member] }, { administrations: [next] },
    ] };
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(supply(course, 5).totalUnits).toBe(4);
  });
  it("keeps civil one-day repetitions aligned across a shortened DST day", () => {
    const course: CanonicalCourse = { kind: "course", stages: [
      { count: 3, start: relative(0), end: relative(1), administrations: [dose()] },
    ] };
    const config = { from: "2026-03-07T00:00:00-05:00", orderedAt: "2026-03-07T00:00:00-05:00",
      timeZone: "America/New_York", limit: 4 };
    expect(nextDueDoses(course, config)).toEqual([
      "2026-03-07T08:00:00-05:00", "2026-03-08T08:00:00-04:00", "2026-03-09T08:00:00-04:00",
    ]);
    expect(calculateTotalUnits({ ...config, dosage: course, durationValue: 3, durationUnit: FhirPeriodUnit.Day })
      .totalUnits).toBe(3);
  });
});

describe("calendar quantity limits retain reversible membership and find the first release", () => {
  const cappedCapacity = (): CanonicalAdministration => ({
    ...dose(),
    schedule: { recurrence: { occurrenceCap: { max: 1, period: 1, periodUnit: FhirPeriodUnit.Day } } },
    limits: [{ scope: "period", amount: { value: 1, unit: "tab" }, period: { value: 1, unit: "mo" } }],
  });
  it("does not skip a March 30 release by searching across the backward March 31 cutoff", () => {
    const result = calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-03-30T07:00:00Z", orderedAt: "2026-03-30T07:00:00Z",
      timeZone: "UTC", durationValue: 745, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-02-28T07:30:00Z"],
    });
    // Available March 30 at07:30, then April30 at07:30; both are before
    // April30 at08:00. Choosing March31 first would incorrectly yield one.
    expect(result.totalUnits).toBe(2);
  });
  it("finds a month-cap release before the source clock falls back", () => {
    expect(calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-11-01T01:00:00-04:00", orderedAt: "2026-11-01T01:00:00-04:00",
      timeZone: "America/New_York", durationValue: 1.25, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-10-01T01:30:00-04:00"],
    }).totalUnits).toBe(1);
  });
  it("finds a release in the target month's shifted gap before its cutoff retreats", () => {
    expect(calculateTotalUnits({
      dosage: cappedCapacity(), from: "2026-04-08T01:45:00-04:00", orderedAt: "2026-04-08T01:45:00-04:00",
      timeZone: "America/New_York", durationValue: 1.5, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-03-08T03:30:00-04:00"],
    }).totalUnits).toBe(1);
  });
  it("retains clamped-day history across nonoverlapping daily course cycles", () => {
    const member = dose();
    member.schedule!.recurrence!.frequency = 4;
    member.schedule!.recurrence!.clocks = ["07:00:00", "07:30:00", "08:00:00", "09:00:00"];
    member.predicate = { kind: "text", text: "if pain" };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "mo" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [member] }] };
    const symptomatic = new Set(["2026-02-28T07:30:00+00:00", "2026-03-30T08:00:00+00:00",
      "2026-03-30T09:00:00+00:00", "2026-03-31T07:00:00+00:00"]);
    expect(calculateTotalUnits({
      dosage: course, from: "2026-02-27T08:00:00Z", orderedAt: "2026-02-27T08:00:00Z",
      timeZone: "UTC", durationValue: 33, durationUnit: FhirPeriodUnit.Day,
      evaluateCondition: (_condition, at) => symptomatic.has(at),
    }).totalUnits).toBe(3);
  });
  it("keeps yearly cap history when February29 clamps back to February28", () => {
    const member = dose();
    member.schedule = { explicitEvents: [
      "2027-02-28T07:30:00Z", "2028-02-28T08:00:00Z", "2028-02-28T09:00:00Z", "2028-02-29T07:00:00Z",
    ] };
    member.limits = [{ scope: "period", amount: { value: 3, unit: "tab" }, period: { value: 1, unit: "a" } }];
    const course: CanonicalCourse = { kind: "course", cycleInterval: { value: 1, unit: "a" },
      stages: [{ administrations: [member] }] };
    expect(calculateTotalUnits({
      dosage: course, from: "2027-02-28T00:00:00Z", orderedAt: "2026-03-01T00:00:00Z",
      timeZone: "UTC", durationValue: 368, durationUnit: FhirPeriodUnit.Day,
    }).totalUnits).toBe(3);
    for (const [from, expected] of [["2027-02-28", 1], ["2028-02-28", 2], ["2028-02-29", 0]] as const) {
      expect(calculateTotalUnits({ dosage: course, from: from + "T00:00:00Z", orderedAt: "2026-03-01T00:00:00Z",
        timeZone: "UTC", durationValue: 1, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(expected);
    }
  });
});


describe("finite whole-course cycles remain distinct from local step repetitions", () => {
  it("runs two local one-day repetitions in each of exactly three complete courses", () => {
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 3, unit: "d" }, cycleCount: 3,
      stages: [{ count: 2, start: relative(0), end: relative(1), administrations: [dose()] }],
    };
    expect(nextDueDoses(course, { ...options, limit: 12 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00",
      "2026-01-07T08:00:00+00:00", "2026-01-08T08:00:00+00:00",
    ]);
    expect(supply(course, 12).totalUnits).toBe(6);
    expect(nextDueDoses(course, { ...options, from: "2026-01-08T00:00:00Z", limit: 3 }))
      .toEqual(["2026-01-08T08:00:00+00:00"]);
  });

  it("does not seek beyond a finite course when a distant query has no overlapping tail", () => {
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 3,
      stages: [{ administrations: [dose()] }],
    };
    expect(nextDueDoses(course, { ...options, from: "2030-01-01T00:00:00Z", limit: 1 })).toEqual([]);
    expect(supply(course, 30).totalUnits).toBe(3);
    expect(supply(course, 2, { from: "2026-01-03T00:00:00Z" }).totalUnits).toBe(1);
  });

  it("retains the final capped cycle's tail and history without creating a fourth cycle", () => {
    const member = dose();
    member.schedule!.recurrence!.courseLength = { value: 3, unit: "d" };
    member.limits = [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 24, unit: "h" } }];
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" }, cycleCount: 3,
      stages: [{ administrations: [member] }],
    };
    // Three three-day windows start Jan1, Jan2 and Jan3. Their union is
    // Jan1–5; the shared one-tablet daily cap admits five administrations.
    expect(nextDueDoses(course, { ...options, limit: 10 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
      "2026-01-05T08:00:00+00:00",
    ]);
    expect(supply(course, 10).totalUnits).toBe(5);
    expect(nextDueDoses(course, { ...options, from: "2026-01-04T00:00:00Z", limit: 10 }))
      .toEqual(["2026-01-04T08:00:00+00:00", "2026-01-05T08:00:00+00:00"]);
    expect(supply(course, 10, { from: "2026-01-04T00:00:00Z" }).totalUnits).toBe(2);
    expect(nextDueDoses(course, { ...options, from: "2026-01-06T00:00:00Z", limit: 1 })).toEqual([]);
  });
});

// Consolidated accepted-cap oracles; the lexical block retains their original fixture scope.
{
/**
 * Caps consume accepted administrations, not opportunities rejected by another
 * constraint. These dates and amounts are independent clinical accounting oracles.
 */

const from = "2026-01-01T00:00:00Z";
const options = { from, orderedAt: from, timeZone: "UTC" };
const day = FhirPeriodUnit.Day;

function tablet(): CanonicalAdministration {
  return {
    kind: "administration",
    amounts: [{ quantity: { value: 1, unit: "tab" } }],
    schedule: { recurrence: {
      frequency: 2, period: 1, periodUnit: day, clocks: ["08:00:00", "20:00:00"],
      occurrenceCap: { max: 1, period: 1, periodUnit: day },
    } },
    limits: [{ scope: "period", amount: { value: 1, unit: "tab" },
      period: { value: 1, unit: "d" } }],
  };
}
function dailyCourse(member: CanonicalAdministration): CanonicalCourse {
  return { kind: "course", cycleInterval: { value: 1, unit: "d" },
    stages: [{ administrations: [member] }] };
}
function supply(dosage: CanonicalAdministration | CanonicalCourse, days: number, extra = {}) {
  return calculateTotalUnits({ ...options, dosage, durationValue: days, durationUnit: day, ...extra });
}

describe("joint cap acceptance", () => {
  const history = { priorDoseTimes: ["2025-12-31T20:00:00Z"] };
  it("does not spend the daily occurrence allowance on a rolling-quantity rejection", () => {
    const member = tablet();
    expect(nextDueDoses(member, { ...options, ...history, limit: 2 }))
      .toEqual(["2026-01-01T20:00:00+00:00", "2026-01-02T20:00:00+00:00"]);
    expect(supply(member, 1, history).totalUnits).toBe(1);
  });
  it.each(["count", "countMax"] as const)("counts accepted %s doses after the same joint caps", (field) => {
    const member = tablet();
    member.schedule!.recurrence![field] = 2;
    expect(nextDueDoses(member, { ...options, ...history, limit: 3 }))
      .toEqual(["2026-01-01T20:00:00+00:00", "2026-01-02T20:00:00+00:00"]);
    expect(supply(member, 3, history).totalUnits).toBe(2);
  });
  it("uses the same atomic acceptance after a condition has allowed the candidate", () => {
    const member = tablet();
    member.predicate = { kind: "text", text: "if pain" };
    expect(nextDueDoses(member, { ...options, ...history, evaluateCondition: () => true, limit: 1 }))
      .toEqual(["2026-01-01T20:00:00+00:00"]);
    expect(supply(member, 1, { ...history, evaluateCondition: () => true }).totalUnits).toBe(1);
  });
});

describe("repeated supply accepted history", () => {
  it("keeps the lifetime maximum across all repeat cycles", () => {
    const member = tablet();
    member.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(supply(course, 14, { priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(2);
  });
  it("carries the accepted frequency maximum rather than its concrete single clock", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(2);
    expect(nextDueDoses(course, { ...options, limit: 3 }))
      .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]);
  });
});


describe("accepted-count and lifetime related families", () => {
  it("retains the accepted finite count across a late query and explicit priorCount", () => {
    const member = tablet();
    member.schedule!.recurrence!.count = 2;
    const later = { ...options, from: "2026-01-02T12:00:00Z", limit: 3,
      priorDoseTimes: ["2025-12-31T20:00:00Z"] };
    expect(nextDueDoses(member, later)).toEqual(["2026-01-02T20:00:00+00:00"]);
    expect(nextDueDoses(member, { ...later, priorCount: 1,
      priorDoseTimes: ["2026-01-01T20:00:00Z"] }))
      .toEqual(["2026-01-02T20:00:00+00:00"]);
  });

  it("uses actual PRN history for the remaining total allowance", () => {
    const member = tablet();
    member.asNeeded = true;
    member.schedule!.recurrence!.countMax = 2;
    expect(nextDueDoses(member, { ...options, from: "2026-01-02T00:00:00Z", limit: 3,
      priorDoseTimes: ["2026-01-01T20:00:00Z"] }))
      .toEqual(["2026-01-02T20:00:00+00:00"]);
    expect(nextDueDoses(member, { ...options, from: "2026-01-02T00:00:00Z", limit: 3 }))
      .toEqual(["2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"]);
  });

  it("applies the same accepted-count rule to an occurrence-only cap", () => {
    const member = tablet();
    member.limits = undefined;
    member.schedule!.recurrence!.count = 2;
    expect(nextDueDoses(member, { ...options, limit: 4 }))
      .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00"]);
  });

  it("does not invent prior lifetime use from historical scheduled opportunities", () => {
    const member = tablet();
    member.schedule!.recurrence!.occurrenceCap = undefined;
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    const late = { from: "2026-01-03T12:00:00Z" };
    expect(supply(course, 7, late).totalUnits).toBe(3);
    const known = supply(course, 7, { ...late,
      priorDoseTimes: ["2026-01-02T20:00:00Z", "2026-01-03T08:00:00Z"] });
    expect(known.totalUnits).toBe(1);
    expect(known.explanation).toContain("supplied prior administrations");
  });

  it("does not subtract generated rolling history twice from the lifetime ceiling", () => {
    const member = tablet();
    member.schedule!.recurrence!.occurrenceCap = undefined;
    member.limits = [
      { scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } },
      { scope: "lifetime", amount: { value: 5, unit: "tab" } },
    ];
    const result = supply(dailyCourse(member), 7);
    expect(result.totalUnits).toBe(5);
    expect(result.explanation).toContain("accepted earlier cycle supply");
    expect(result.explanation).not.toContain("reduced by supplied prior administrations");
    expect(supply(dailyCourse(member), 7, {
      priorDoseTimes: ["2025-12-31T20:00:00Z"] }).totalUnits).toBe(4);
  });

  it("keeps the existing fractional lifetime quantity ceiling and concrete schedule", () => {
    const member = tablet();
    member.amounts![0].quantity!.value = 2;
    member.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(member, 14).totalUnits).toBe(3);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(nextDueDoses(course, { ...options, limit: 5 })).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
      "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00",
      "2026-01-05T08:00:00+00:00",
    ]);
  });

  it("keeps per-target quantity and known concentration in the lifetime ledger's units", () => {
    const drops = tablet();
    drops.amounts = [{ quantity: { value: 1, unit: "drop" } }];
    drops.targetCount = 2;
    drops.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    drops.limits = [{ scope: "lifetime", amount: { value: 5, unit: "drop" } }];
    expect(supply(dailyCourse(drops), 14).totalUnits).toBe(5);
    expect(supply(dailyCourse(drops), 14, {
      priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(3);

    const liquid = { ...drops, targetCount: undefined,
      amounts: [{ quantity: { value: 2, unit: "mL" } }],
      limits: [{ scope: "lifetime" as const, amount: { value: 30, unit: "mg" } }] };
    const context = { strengthRatio: {
      numerator: { value: 5, unit: "mg" }, denominator: { value: 1, unit: "mL" }
    } };
    expect(supply(dailyCourse(liquid), 14, { context }).totalUnits).toBe(6);
    expect(supply(dailyCourse(liquid), 14, { context,
      priorDoseTimes: ["2025-12-31T08:00:00Z"] }).totalUnits).toBe(4);
  });

  it("preserves cap-only capacity without creating clocks for lifetime accounting", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      occurrenceCap: { max: 2, period: 1, periodUnit: day },
    } };
    member.limits = [{ scope: "lifetime", amount: { value: 3, unit: "tab" } }];
    const course = dailyCourse(member);
    expect(supply(course, 14).totalUnits).toBe(3);
    expect(supply(course, 14).quantityKind).toBe("maximum");
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
  });

  it("keeps component lifetime limits independent and course-wide safety at its own scope", () => {
    const first = tablet();
    first.schedule = { recurrence: { frequency: 1, period: 1, periodUnit: day, clocks: ["08:00:00"] } };
    first.limits = [{ scope: "lifetime", amount: { value: 2, unit: "tab" } }];
    const second = { ...first, limits: [{ scope: "lifetime" as const, amount: { value: 5, unit: "tab" } }] };
    const course: CanonicalCourse = {
      kind: "course", cycleInterval: { value: 1, unit: "d" },
      stages: [{ administrations: [first, second] }],
      safety: { limits: [{ scope: "lifetime", amount: { value: 100, unit: "tab" } }] },
    };
    const before = JSON.stringify(course);
    const result = supply(course, 14);
    expect(result.totalUnits).toBe(7);
    expect(result.quantityKind).toBe("maximum");
    expect(result.explanation).toContain("retained but not evaluated");
    expect(JSON.stringify(course)).toBe(before);
  });

  it("applies lifetime quantity across repeated components imported from R6 safety", () => {
    const source: FhirR6DosageInstruction = {
      repeatCycle: { value: 1, unit: "d", code: "d" },
      step: [{ component: [{
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: day, timeOfDay: ["08:00:00"] } },
        safety: { doseLimit: [{ scope: "lifetime", valueQuantity: { value: 3, unit: "tab" } }] },
      }] }],
    };
    expect(calculateTotalUnits({ ...options, dosage: source,
      durationValue: 14, durationUnit: day }).totalUnits).toBe(3);
  });

  it("keeps maximum range and rate histories consistent with the accepted supply quantity", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.limits = [
      { scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } },
      { scope: "lifetime", amount: { value: 6, unit: "tab" } },
    ];
    const source = JSON.stringify(member);
    expect(supply(dailyCourse(member), 2).totalUnits).toBe(4);
    expect(supply(dailyCourse(member), 4).totalUnits).toBe(6);
    const withPrior = supply(dailyCourse(member), 4, { priorDoseTimes: ["2025-12-31T08:00:00Z"] });
    expect(withPrior.totalUnits).toBe(4);
    expect(withPrior.explanation).toContain("each recorded prior ranged administration was assumed to use the upper dose bound (2 tab)");
    expect(JSON.stringify(member)).toBe(source);

    const infusion: CanonicalAdministration = { ...member,
      amounts: [{ rate: { value: 10, unit: "mL/h" } }],
      schedule: { recurrence: { ...member.schedule!.recurrence,
        occurrenceDuration: 1, occurrenceDurationUnit: FhirPeriodUnit.Hour } },
      limits: [
        { scope: "period", amount: { value: 20, unit: "mL" }, period: { value: 2, unit: "d" } },
        { scope: "lifetime", amount: { value: 25, unit: "mL" } },
      ],
    };
    expect(supply(dailyCourse(infusion), 2).totalUnits).toBe(20);
    expect(supply(dailyCourse(infusion), 4).totalUnits).toBe(25);
  });
});


describe("repeated maximum-capacity history", () => {
  it("carries two-day rolling capacity across daily cycles without generating due times", () => {
    const member = tablet();
    member.schedule = { recurrence: { occurrenceCap: { max: 2, period: 1, periodUnit: day } } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(2);
    expect(supply(course, 4).totalUnits).toBe(4);
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
  });

  it("retains ranged capacity and a count maximum while sharing the rolling allowance", () => {
    const member = tablet();
    member.amounts = [{ range: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }];
    member.schedule = { recurrence: {
      occurrenceCap: { max: 2, period: 1, periodUnit: day }, countMax: 3,
    } };
    member.limits = [{ scope: "period", amount: { value: 4, unit: "tab" }, period: { value: 2, unit: "d" } }];
    const course = dailyCourse(member);
    expect(supply(course, 2).totalUnits).toBe(4);
    expect(supply(course, 4).totalUnits).toBe(8);
    const withRecordedRange = supply(course, 1, { priorDoseTimes: ["2025-12-31T08:00:00Z"] });
    expect(withRecordedRange.totalUnits).toBe(2);
    expect(withRecordedRange.explanation)
      .toContain("each recorded prior ranged administration was assumed to use the upper dose bound (2 tab)");
    expect(nextDueDoses(course, { ...options, limit: 3 })).toEqual([]);
    const oneUse = freshExecutionInput(course);
    oneUse.stages[0].administrations[0].schedule!.recurrence!.countMax = 1;
    expect(supply(oneUse, 1).totalUnits).toBe(2);
  });

  it("carries the same maximum plan into a later rolling-cap query", () => {
    const member = tablet();
    member.schedule = { recurrence: {
      frequency: 1, frequencyMax: 2, period: 1, periodUnit: day, clocks: ["08:00:00"]
    } };
    member.limits = [{ scope: "period", amount: { value: 2, unit: "tab" }, period: { value: 2, unit: "d" } }];
    expect(supply(dailyCourse(member), 1, { from: "2026-01-02T00:00:00Z" }).totalUnits).toBe(0);
    expect(supply(dailyCourse(member), 1, { from: "2026-01-03T00:00:00Z" }).totalUnits).toBe(2);
  });
});
}

// END PRESERVED execution20
}


describe("round44 supported temporal precision", () => {
  const contextCode = { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event", code: "treatment-start" }] };
  const at = (value: number, unit: string) => ({ contextCode, offsetDuration: { value, unit } });
  const between = (low: number, lowUnit: string, high: number, highUnit: string) => ({
    contextCode, offsetRange: { low: { value: low, unit: lowUnit }, high: { value: high, unit: highUnit } }
  });
  const forms = (raw: FhirR6DosageInstruction) => [
    raw, importCanonicalCourse(raw), JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[]
  ];

  it.each([
    ["scalar civil", at(0, "d"), at(1, "d"), [8, 9, 10]],
    ["range start", between(0, "d", 0, "d"), at(1, "d"), [8, 9, 10]],
    ["range end", at(0, "d"), between(1, "d", 1, "d"), [8, 9, 10]],
    ["both ranges", between(0, "d", 0, "wk"), between(1, "d", 1, "d"), [8, 9, 10]],
    ["equivalent week endpoints", at(0, "d"), between(1, "wk", 7, "d"), Array.from({ length: 21 }, (_, i) => i + 8)],
    ["scalar elapsed", at(0, "h"), at(23, "h"), [8, 9]],
    ["range elapsed", between(0, "h", 0, "h"), between(23, "h", 23, "h"), [8, 9]]
  ] as const)("keeps local repetition on the authored span: %s", (_name, start, end, days) => {
    const raw: FhirR6DosageInstruction = { step: [{ count: 3, start, end, component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:30:00"] } }
    }] }] };
    const query = { orderedAt: "2026-03-07T09:00:00-05:00", from: "2026-03-07T09:00:00-05:00",
      timeZone: "America/New_York", limit: 24 };
    // A civil day keeps its 09:00 boundary after the 23-hour spring day.
    // Three genuinely 23-hour windows end before the March10 dose instead.
    for (const dosage of forms(raw)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(days.map(day =>
        "2026-03-" + String(day).padStart(2, "0") + "T08:30:00-04:00"));
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 22, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: days.length, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(courseToR6(courseFromR6(raw)).step![0]).toMatchObject({ start, end });
  });

  it.each(["unknown", "known empty", "known active"])("distinguishes ranged supply with %s timing", state => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { repeat: state === "unknown" ? {} : {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"]
      } },
      maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" }, denominator: { value: 24, unit: "h" } }]
    };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: row.doseAndRate, timing: row.timing,
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 3, unit: "tab" }, period: { value: 24, unit: "h" } }] }
    }] }] };
    const query = { ...options, ...(state === "known empty" ? { from: "2026-01-01T09:00:00Z" } : {}),
      durationValue: state === "known empty" ? 1 : 24, durationUnit: Unit.Hour };
    for (const dosage of [row, ...forms(raw)]) {
      const before = JSON.stringify(dosage);
      if (state === "unknown")
        expect(() => calculateTotalUnits({ dosage, ...query })).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculateTotalUnits({ dosage, ...query }).totalUnits).toBe(state === "known empty" ? 0 : 2);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([
    ["mixed", ["2026", "2026-11", "2026-11-20T08:00:00Z"], "2026-11-01T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["mixed late", ["2026", "2026-11", "2026-11-20T08:00:00Z"], "2026-11-10T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["known past", ["2026-11", "2026-11-20T08:00:00Z"], "2026-11-21T00:00:00Z", [], 0, undefined],
    ["complete only", ["2026-11-20T08:00:00Z"], "2026-11-01T00:00:00Z", ["2026-11-20T08:00:00+00:00"], 1, undefined],
    ["partial only", ["2026", "2026-11"], "2026-11-01T00:00:00Z", [], undefined, undefined],
    ["partial exhausted", ["2026", "2026-11"], "2026-11-01T00:00:00Z", [], 0, 1]
  ] as const)("retains partial event precision without spending an exact count: %s", (_name, event, from, expected, total, priorCount) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { event: [...event], repeat: { count: 1 } }
    }] }] };
    const query = { from, orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 3,
      ...(priorCount === undefined ? {} : { priorCount }) };
    for (const dosage of forms(raw)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(expected);
      const calculate = () => calculateTotalUnits({ dosage, ...query, durationValue: 30, durationUnit: Unit.Day });
      if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate().totalUnits).toBe(total);
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(courseToR6(courseFromR6(raw)).step![0].component[0].timing?.event).toEqual(event);
    const persisted = JSON.parse(JSON.stringify(toFhirR5Dosages(raw))) as FhirDosage[];
    expect(toDosageDetails(persisted).step![0].component[0].timing?.event).toEqual(event);
  });
});


describe("round45 finite history and ranged occurrence bounds", () => {
  const oncePerDay = { url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
    { url: "max", valueInteger: 1 },
    { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } }
  ] };
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const rangedDose = { doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } };
  const periodCap = (maximum: number) => [{ numerator: { value: maximum, unit: "tab" }, denominator: { value: 24, unit: "h" } }];

  it.each([
    ["daily allowance", true, origin, undefined, 56],
    ["both clocks", false, origin, undefined, 112],
    ["partial first and last days", true, "2026-01-01T12:00:00Z", undefined, 58],
    ["recorded first-day allowance", true, "2026-01-01T12:00:00Z", "2026-01-01T08:00:00Z", 56]
  ] as const)("proves an attainable ranged maximum from %s", (_name, occurrence, from, record, expected) => {
    const row: FhirDosage = { asNeeded: true, doseAndRate: [rangedDose],
      timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00", "20:00:00"],
        ...(occurrence ? { extension: [oncePerDay] } : {}) } }, maxDosePerPeriod: periodCap(4) };
    // Two tablets at the first free clock of each civil bucket attain this
    // bound. A noon-to-noon horizon touches 29 buckets; its actual first-day
    // dose spends that day's allowance, leaving 28 buckets for new supply.
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(calculateTotalUnits({ dosage, ...options, from, durationValue: 28, durationUnit: Unit.Day,
        ...(record ? { priorDoseTimes: [record] } : {}) })).toMatchObject({ totalUnits: expected, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it.each([["2026-01-02T00:00:00Z", 4], ["2026-01-10T00:00:00Z", 0]] as const)(
    "bounds future ranged supply by the finite allowance remaining at %s", (from, expected) => {
    const row: FhirDosage = { doseAndRate: [rangedDose], timing: { repeat: { count: 3, frequency: 1,
      period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"], extension: [oncePerDay] } }, maxDosePerPeriod: periodCap(4) };
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, from, limit: 5 })).toEqual(expected ? [
        "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00"
      ] : []);
      expect(calculateTotalUnits({ dosage, ...options, from, durationValue: 28, durationUnit: Unit.Day }).totalUnits).toBe(expected);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  describe.each([false, true])("actual finite-count ownership with ranged dose %s", ranged => {
    it.each(["shifted", "on-time", "none", "pre-order", "late-tight"])("retains eligible remaining doses with %s history", history => {
      const row: FhirDosage = { doseAndRate: [ranged ? rangedDose : { doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { count: 3, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } },
        maxDosePerPeriod: periodCap((ranged ? 2 : 1) * (history === "late-tight" ? 1 : 2)) };
      const priorDoseTimes = history === "none" ? undefined : [history === "pre-order" ? "2025-12-31T09:00:00Z"
        : history === "on-time" ? "2026-01-01T08:00:00Z" : history === "late-tight" ? "2026-01-01T23:00:00Z"
          : "2026-01-01T09:00:00Z"];
      const query = { ...options, from: "2026-01-02T00:00:00Z", priorDoseTimes, limit: 5 };
      // One eligible recorded dose leaves two. Its actual 23:00 timestamp
      // blocks the next 08:00 under a one-dose rolling ceiling, but consumes
      // no extra lifetime slot. With no eligible record, replay January 1.
      const days = history === "late-tight" ? [3, 4] : [2, 3];
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(days.map(day => `2026-01-0${day}T08:00:00+00:00`));
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(ranged ? 4 : 2);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
  });
});


describe("round46 supported execution boundaries", () => {
  const ucum = "http://unitsofmeasure.org";
  const annotated = {
    id: "round46-administration",
    extension: [{ url: "urn:test:round46:source", valueString: "retained" }],
  };
  const amount = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r5Forms = (rows: FhirDosage | FhirDosage[]) => {
    const r6 = toDosageDetails(Array.isArray(rows) ? rows : [rows]);
    return [rows, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const r6Forms = (raw: FhirR6DosageInstruction) => {
    const rows = toFhirR5Dosages(raw);
    return [raw, rows, JSON.parse(JSON.stringify(rows)) as FhirDosage[]];
  };

  it.each(["immediate", "ordinary clock", "later authored start"] as const)(
    "keeps the established successor boundary for %s", variant => {
      const loading: FhirDosage = { ...amount(), sequence: 1, timing: { repeat: {
        count: 1, frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"]
      } } };
      const successor: FhirDosage = { ...annotated, ...amount(2), sequence: 2, timing: { repeat:
        variant === "ordinary clock"
          ? { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] }
          : { when: [EventTiming.Immediate], ...(variant === "later authored start"
            ? { boundsPeriod: { start: "2026-01-02T12:00:00Z" } } : {}) }
      } };
      const expected = variant === "immediate"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T08:00:00+00:00"]
        : variant === "later authored start"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-02T12:00:00+00:00"]
        : ["2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
          "2026-01-03T08:00:00+00:00", "2026-01-04T08:00:00+00:00"];
      for (const dosage of r5Forms([loading, successor])) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...options,
          durationValue: variant === "later authored start" ? 3 : 1, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: variant === "ordinary clock" ? 1 : 3, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["explicit one", "explicit zero", "nominal history", "actual history", "before eligibility", "alternate days"] as const)(
    "spends finite allowance once with %s", variant => {
      const alternate = variant === "alternate days";
      const raw: FhirR6DosageInstruction = { step: [{
        start: { contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
          code: "treatment-start" }] }, offsetDuration: { value: 3, unit: "d", system: ucum, code: "d" } },
        component: [{ ...annotated, ...amount(), timing: { repeat: {
          countMax: 3, frequency: 1, period: alternate ? 2 : 1, periodUnit: Unit.Day,
          timeOfDay: ["09:00:00"], boundsPeriod: { start: origin }
        } } }]
      }] };
      const query = { ...options, limit: 8,
        from: alternate ? "2026-01-06T00:00:00Z"
          : variant === "before eligibility" ? "2026-01-02T00:00:00Z" : "2026-01-05T00:00:00Z",
        priorCount: variant === "explicit one" || alternate ? 1
          : variant === "explicit zero" || variant === "before eligibility" ? 0 : undefined,
        priorDoseTimes: variant === "actual history" ? ["2026-01-04T09:00:00Z"] : undefined,
      };
      const days = alternate ? [7, 9] : variant === "before eligibility" ? [4, 5, 6]
        : variant === "explicit zero" ? [5, 6, 7] : [5, 6];
      for (const dosage of r6Forms(raw)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query))
          .toEqual(days.map(day => "2026-01-0" + day + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 7, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: days.length, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["Q4H range", "Q4H exact", "BID range"] as const)(
    "retains the admitted coded cadence for %s", variant => {
      const daily = variant === "BID range";
      const ranged = variant !== "Q4H exact";
      const row: FhirDosage = { ...annotated, ...amount(), timing: {
        code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
          code: daily ? "BID" : "Q4H" }] },
        repeat: { frequency: daily ? 1 : ranged ? 4 : 6,
          ...(ranged ? { frequencyMax: daily ? 3 : 8 } : {}),
          period: 1, periodUnit: Unit.Day,
          boundsDuration: { value: 1, unit: "d", code: "d", system: ucum } }
      } };
      const query = { ...options, from: "2026-01-01T01:00:00Z",
        orderedAt: "2026-01-01T01:00:00Z", limit: 12 };
      const clocks = daily ? ["08:00:00", "20:00:00"]
        : ["01:00:00", "05:00:00", "09:00:00", "13:00:00", "17:00:00", "21:00:00"];
      for (const dosage of r5Forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(clocks.map(clock => "2026-01-01T" + clock + "+00:00"));
        // The explicit range still owns the existing maximum-supply endpoint.
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
          .toBe(daily ? 3 : ranged ? 8 : 6);
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["missing", "known", "local", "independent end", "qualified known"] as const)(
    "retains authored duration presence before dependent completion (%s)", variant => {
      const duration = variant === "known" || variant === "qualified known"
        ? { value: 2, unit: "hours", system: ucum, code: "h", id: "authored-duration",
          ...(variant === "qualified known" ? { comparator: ">=" as const } : {}) }
        : { value: 3, unit: "half-hour blocks", system: "urn:clinic:duration-units",
          code: "half-hour-block", id: "authored-duration" };
      const marker = { url: "urn:ezmedicationinput:StructureDefinition:timing-administration-duration",
        valueQuantity: duration };
      const raw: FhirR6DosageInstruction = { step: [{
        ...(variant === "independent end" ? { end: {
          contextCode: { coding: [{ system: "http://hl7.org/fhir/evidence-variable-event",
            code: "treatment-start" }] },
          offsetDuration: { value: 2, unit: "d", code: "d", system: ucum }
        } } : {}),
        component: [{ ...annotated, timing: { repeat: { count: 1, timeOfDay: ["23:30:00"],
          ...(variant === "missing" ? {} : { extension: [marker] }) } },
          doseAndRate: [{ doseQuantity: { value: 100, unit: "mL" } }] }]
      }, {
        start: { contextCode: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:course-phase-event",
          code: "previous-phase-next-day" }] } },
        component: [{ timing: { repeat: { frequency: 1, period: 1,
          periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } },
          doseAndRate: [{ doseQuantity: { value: 20, unit: "mL" } }] }]
      }] };
      const query = { from: "2026-12-01T00:00:00Z", orderedAt: "2026-12-01T00:00:00Z",
        timeZone: "UTC", limit: 4 };
      const unresolved = variant === "local" || variant === "qualified known";
      const days = unresolved ? [] : variant === "missing" ? [2, 3, 4] : [3, 4, 5];
      for (const dosage of r6Forms(raw)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(["2026-12-01T23:30:00+00:00",
          ...days.map(day => "2026-12-0" + day + "T08:00:00+00:00")]);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 4, durationUnit: Unit.Day }))
          .toMatchObject({ totalUnits: unresolved ? 100 : variant === "missing" ? 160 : 140, unit: "mL" });
        const projected = projectCanonicalCourse(importCanonicalCourse(dosage));
        if (variant === "local" || variant === "independent end") {
          for (const repeat of [projected.fhir[0].timing!.repeat!,
            projected.fhirNext.step![0].component[0].timing!.repeat!]) {
            expect(repeat.extension).toContainEqual(marker);
            expect(repeat.duration).toBeUndefined();
            expect(repeat.durationUnit).toBeUndefined();
          }
        }
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
});


describe("round47 calendar quantity and month-day ownership", () => {
  const ucum = "http://unitsofmeasure.org";
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };

  it.each(["monthly delayed", "monthly undisplaced", "elapsed thirty days", "yearly delayed"] as const)(
    "admits the actual administration under %s limits", variant => {
      const yearly = variant === "yearly delayed", elapsed = variant === "elapsed thirty days";
      const delayed = variant !== "monthly undisplaced";
      const from = yearly ? "2025-03-01T00:00:00Z" : "2026-03-31T00:00:00Z";
      const orderedAt = yearly ? "2024-01-01T00:00:00Z" : "2026-01-01T00:00:00Z";
      const end = yearly ? "2025-03-01T02:00:00Z" : "2026-03-31T02:00:00Z";
      const row: FhirDosage = {
        id: "r47-delayed-dose",
        extension: [{ url: "urn:test:r47:authored", valueString: "retain" }],
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        ...(delayed ? { modifierExtension: [{
          url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
          valueQuantity: { value: 120, unit: "min", code: "min", system: ucum }
        }] } : {}),
        timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
          timeOfDay: [delayed ? "23:00:00" : "01:00:00"], boundsPeriod: { start: orderedAt, end } } },
        maxDosePerPeriod: [{ numerator: { value: 1, unit: "tab" }, denominator: {
          value: elapsed ? 30 : 1, unit: elapsed ? "d" : yearly ? "a" : "mo",
          code: elapsed ? "d" : yearly ? "a" : "mo", system: ucum
        } }]
      };
      const query = { from, orderedAt, timeZone: "UTC", limit: 2,
        priorDoseTimes: [yearly ? "2024-03-01T00:30:00Z" : "2026-03-01T00:30:00Z"] };
      // At March31 01:00 the monthly cutoff is February28 01:00,
      // so March1 00:30 still consumes the allowance. The 30-day cutoff
      // is March1 01:00 instead. Across the leap year, the actual yearly
      // cutoff is March1 01:00; shifting to February28 changes that date.
      const accepted = elapsed || yearly;
      const expected = accepted ? [yearly ? "2025-03-01T01:00:00+00:00" : "2026-03-31T01:00:00+00:00"] : [];
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 2, durationUnit: Unit.Hour }))
          .toMatchObject({ totalUnits: accepted ? 1 : 0, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each(["fifteenth", "every two months", "aligned fifteenth", "order-day clamp"] as const)(
    "uses the prescribed date within eligible months (%s)", variant => {
      const explicit = variant !== "order-day clamp";
      const period = variant === "every two months" ? 2 : 1;
      const from = variant === "aligned fifteenth" ? "2026-01-15T00:00:00Z"
        : explicit ? "2026-01-01T00:00:00Z" : "2026-01-31T00:00:00Z";
      const row: FhirDosage = { id: "r47-month-day",
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period, periodUnit: Unit.Month,
          timeOfDay: ["09:00:00"], ...(explicit ? { extension: [{
            url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15
          }] } : {}) } }
      };
      const dates = variant === "every two months"
        ? ["2026-01-15", "2026-03-15", "2026-05-15"]
        : explicit ? ["2026-01-15", "2026-02-15", "2026-03-15"]
        : ["2026-01-31", "2026-02-28", "2026-03-31"];
      const query = { from, orderedAt: from, timeZone: "UTC", limit: 3 };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual(dates.map(date => date + "T09:00:00+00:00"));
        expect(calculateTotalUnits({ dosage, ...query,
          durationValue: period === 2 ? 5 : 3, durationUnit: Unit.Month }))
          .toMatchObject({ totalUnits: 3, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });
});


describe("round48 inferred slots and unresolved events", () => {
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };
  const quantity = { doseQuantity: { value: 1, unit: "tab" } };

  it.each([
    [1.5, Unit.Day, 36, "2026-01-03T06:00:00Z", [
      "2026-01-01T00:00:00", "2026-01-01T18:00:00", "2026-01-02T12:00:00",
      "2026-01-03T06:00:00", "2026-01-04T00:00:00", "2026-01-04T18:00:00"
    ]],
    [0.5, Unit.Week, 84, "2026-01-06T06:00:00Z", [
      "2026-01-01T00:00:00", "2026-01-02T18:00:00", "2026-01-04T12:00:00",
      "2026-01-06T06:00:00", "2026-01-08T00:00:00", "2026-01-09T18:00:00"
    ]]
  ] as const)("distributes two doses in %s %s using elapsed slots", (period, periodUnit, hours, from, dates) => {
    for (const repeat of [{ frequency: 2, period, periodUnit },
      { frequency: 2, period: hours, periodUnit: Unit.Hour }]) {
      const row: FhirDosage = { doseAndRate: [quantity], timing: { repeat } };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, { ...options, limit: 6 }))
          .toEqual(dates.map(date => date + "+00:00"));
        expect(calculateTotalUnits({ dosage, ...options, from,
          durationValue: 1, durationUnit: Unit.Hour })).toMatchObject({ totalUnits: 1, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(before);
      }
    }
  });

  it.each(["coded", "explicit interval"] as const)(
    "seeks %s history without spending the final occurrence", variant => {
      const row: FhirDosage = { doseAndRate: [quantity], timing: {
        ...(variant === "coded" ? { code: { coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "Q4H"
        }] } } : {}),
        repeat: { frequency: variant === "coded" ? 6 : 1,
          period: variant === "coded" ? 1 : 4,
          periodUnit: variant === "coded" ? Unit.Day : Unit.Hour, count: 1080 }
      } };
      for (const dosage of forms(row)) {
        const before = JSON.stringify(dosage);
        for (const [from, expected] of [
          ["2026-06-30T00:00:00Z", "2026-06-30T00:00:00+00:00"],
          ["2026-06-30T02:00:00Z", "2026-06-30T04:00:00+00:00"]
        ]) {
          const query = { ...options, from, priorCount: 1079, limit: 2 };
          expect(nextDueDoses(dosage, query)).toEqual([expected]);
          expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: Unit.Day }))
            .toMatchObject({ totalUnits: 1, unit: "tab" });
          expect(nextDueDoses(dosage, { ...query, priorCount: 1080 })).toEqual([]);
          expect(calculateTotalUnits({ dosage, ...query, priorCount: 1080,
            durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
        }
        expect(JSON.stringify(dosage)).toBe(before);
      }
    });

  it.each([
    ["history remaining", 2, undefined, false, undefined],
    ["explicit remaining", 2, 1, false, undefined],
    ["history exhausted", 1, undefined, false, 0],
    ["explicit exhausted", 2, 2, false, 0],
    ["known future", 2, undefined, true, 1],
    ["uncapped remaining", undefined, undefined, false, undefined]
  ] as const)("keeps partial events unresolved after exact filtering (%s)", (_name, count, priorCount, future, total) => {
    const event = ["2026-11", "2026-11-20T08:00:00Z",
      ...(future ? ["2026-11-22T08:00:00Z"] : [])];
    const row: FhirDosage = { id: "round48-partial-event", doseAndRate: [quantity],
      timing: { event, ...(count === undefined ? {} : { repeat: { count } }) } };
    const query = { from: "2026-11-21T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z",
      timeZone: "UTC", limit: 3, ...(priorCount === undefined ? {} : { priorCount }) };
    for (const dosage of forms(row)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, query)).toEqual(future ? ["2026-11-22T08:00:00+00:00"] : []);
      const calculate = () => calculateTotalUnits({ dosage, ...query,
        durationValue: 2, durationUnit: Unit.Day });
      if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      else expect(calculate()).toMatchObject({ totalUnits: total, unit: "tab" });
      expect(JSON.stringify(dosage)).toBe(before);
    }
    expect(toDosageDetails([row]).step![0].component[0].timing?.event).toEqual(event);
  });
});

describe("round49 partial-event supply windows and external inputs", () => {
  const forms = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[]];
  };

  it.each([
    ["past month", "2026-11", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["overlapping month", "2026-11", "2026-11-21T00:00:00Z", 2, Unit.Day, "UTC", undefined],
    ["future month", "2026-12", "2026-11-21T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["past year", "2026", "2027-01-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["overlapping year", "2026", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", undefined],
    ["future year", "2027", "2026-12-01T00:00:00Z", 2, Unit.Day, "UTC", 0],
    ["exclusive month boundary", "2026-12", "2026-11-30T00:00:00Z", 1, Unit.Day, "UTC", 0],
    ["crossed month boundary", "2026-12", "2026-11-30T12:00:00Z", 1, Unit.Day, "UTC", undefined],
    ["past local month", "2026-11", "2026-11-30T17:00:00Z", 2, Unit.Day, "Asia/Bangkok", 0],
    ["overlapping local month", "2026-11", "2026-11-30T16:00:00Z", 1, Unit.Hour, "Asia/Bangkok", undefined],
    ["order at month end", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", 0, "2026-12-01T00:00:00Z"],
    ["order inside month", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", undefined, "2026-11-30T12:00:00Z"],
    ["order after query", "2026-11", "2026-11-30T00:00:00Z", 2, Unit.Day, "UTC", 0, "2026-12-03T00:00:00Z"]
  ] as const)("distinguishes a disjoint %s from unknown administration time",
    (_name, partial, from, durationValue, durationUnit, timeZone, total, orderedAt?: string) => {
      const event = [partial, "2026-11-20T08:00:00Z"];
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { event } };
      const query = { from, orderedAt: orderedAt ?? origin, timeZone,
        durationValue, durationUnit, limit: 3 };
      for (const dosage of forms(row)) {
        const saved = JSON.stringify(dosage);
        expect(nextDueDoses(dosage, query)).toEqual([]);
        const calculate = () => calculateTotalUnits({ dosage, ...query });
        if (total === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits: total, unit: "tab" });
        expect(JSON.stringify(dosage)).toBe(saved);
      }
      expect(toDosageDetails([row]).step![0].component[0].timing?.event).toEqual(event);
    });

  it("imports current external R6 edits while retaining the original parsed batch", () => {
    const batch = parseSig("Take 1 tablet daily at 08:00");
    const original = JSON.stringify(batch);
    const query = { from: "2026-11-23T00:00:00Z", orderedAt: "2026-11-23T00:00:00Z",
      timeZone: "UTC", limit: 1, durationValue: 1, durationUnit: Unit.Day };
    for (const [clock, quantity] of [["10:00:00", 2], ["11:00:00", 3]] as const) {
      const external = JSON.parse(JSON.stringify(batch.fhirNext)) as FhirR6DosageInstruction;
      const component = external.step![0].component[0];
      component.timing!.repeat!.timeOfDay = [clock];
      component.doseAndRate![0].doseQuantity!.value = quantity;
      const saved = JSON.stringify(external);
      for (const dosage of [external, fromFhir(external)]) {
        expect(nextDueDoses(dosage, query)).toEqual(["2026-11-23T" + clock + "+00:00"]);
        expect(calculateTotalUnits({ dosage, ...query })).toMatchObject({ totalUnits: quantity, unit: "tab" });
      }
      expect(JSON.stringify(external)).toBe(saved);
    }
    expect(nextDueDoses(batch, query)).toEqual(["2026-11-23T08:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: batch, ...query })).toMatchObject({ totalUnits: 1, unit: "tab" });
    expect(JSON.stringify(batch)).toBe(original);
  });
});


describe("round53 supported execution and grammar regressions", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const forms = (course: CanonicalCourse) => [course, persist(courseToR5(course)), persist(courseToR6(course))];

  it.each([
    [2, Unit.Day, ["2026-01-01T08:00:00+00:00", "2026-01-03T08:00:00+00:00", "2026-01-05T08:00:00+00:00"], 3, 2],
    [1, Unit.Week, ["2026-01-01T08:00:00+00:00", "2026-01-08T08:00:00+00:00", "2026-01-15T08:00:00+00:00"], 14, 2],
  ] as const)("opens clock windows only on eligible calendar dates (%s %s)", (period, periodUnit, expected, days, units) => {
    const parsed = parseSig(`Take 1 tablet every ${period} ${periodUnit === Unit.Week ? "week" : "days"} between 08:00 and 10:00`);
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual(expected);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: days, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: units, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("restarts a subday interval in each daily clock window", () => {
    const parsed = parseSig("Take 1 tablet every 2 hours between 08:00 and 10:00");
    for (const input of [parsed.meta.canonical.course!, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T10:00:00+00:00",
        "2026-01-02T08:00:00+00:00", "2026-01-02T10:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
    }
  });

  it.each([
    [120, 82, 5, "2026-01-04T10:00:00Z", "2026-01-04T11:00:00+00:00", "2026-01-05T11:00:00+00:00", false],
    [-120, 80, 6, "2026-01-04T08:00:00Z", "2026-01-05T07:00:00+00:00", "2026-01-06T07:00:00+00:00", false],
    [120, 82, 5, "2026-01-04T10:00:00Z", "2026-01-04T11:00:00+00:00", "2026-01-05T11:00:00+00:00", true],
    [-120, 80, 6, "2026-01-04T08:00:00Z", "2026-01-05T07:00:00+00:00", "2026-01-06T07:00:00+00:00", true],
  ] as const)("counts eligible delayed doses on the same grid as scheduling (%s minutes, start %s, end %s, %s, %s, %s, cap %s)",
    (delayMinutes, startHours, endDays, from, first, second, civilCap) => {
      const member = dose();
      member.delayMinutes = delayMinutes;
      member.phaseStart = relative(0);
      member.schedule!.recurrence!.count = 2;
      if (civilCap) member.schedule!.recurrence!.occurrenceCap = { max: 1, period: 1, periodUnit: Unit.Day };
      const course: CanonicalCourse = { kind: "course", stages: [{ start: relative(startHours, "h"),
        end: relative(endDays), administrations: [member] }] };
      const query = { ...options, from, limit: 4 };
      for (const input of forms(course)) {
        const before = JSON.stringify(input);
        expect(nextDueDoses(input, query)).toEqual([first, second]);
        expect(calculateTotalUnits({ ...query, dosage: input, durationValue: endDays * 24 - startHours, durationUnit: Unit.Hour }))
          .toMatchObject({ totalUnits: 2, unit: "tab" });
        expect(JSON.stringify(input)).toBe(before);
      }
    });

  it.each([
    ["2026-12", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-30T23:00:00Z", undefined],
    ["2026-11", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-01T00:00:00Z", undefined],
    ["2027", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-12-31T23:00:00Z", undefined],
    ["2026-12", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-29T23:00:00Z", 0],
    ["2026-11", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-02T00:00:00Z", 0],
  ] as const)("keeps shifted partial events unresolved only when their possible dates overlap (%s %s %j %s)",
    (event, when, eventClock, from, units) => {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { event: [event], repeat: { when: [when], offset: 60 } },
        extension: [{ url: "urn:round53:partial-source", valueString: "authored partial date" }] };
      const r6 = toDosageDetails([row]);
      const query = { ...options, from, eventClock, limit: 2, durationValue: 1, durationUnit: Unit.Hour };
      for (const input of [row, persist(r6), persist(toFhirR5Dosages(r6))]) {
        const before = JSON.stringify(input);
        expect(nextDueDoses(input, query)).toEqual([]);
        const calculate = () => calculateTotalUnits({ ...query, dosage: input });
        if (units === undefined) expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
        else expect(calculate()).toMatchObject({ totalUnits: 0, unit: "tab" });
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(r6.step![0].component[0].timing?.event).toEqual([event]);
      expect(toFhirR5Dosages(r6)[0].extension).toContainEqual(row.extension![0]);
    });

  it.each([
    ["2026-12-01", EventTiming["Before Sleep"], { HS: "00:30" }, "2026-11-30T23:00:00Z", "2026-11-30T23:30:00+00:00"],
    ["2026-11-30", EventTiming["After Dinner"], { CV: "23:30" }, "2026-12-01T00:00:00Z", "2026-12-01T00:30:00+00:00"],
  ] as const)("retains exact shifted date occurrences (%s)", (event, when, eventClock, from, expected) => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { event: [event], repeat: { when: [when], offset: 60 } } };
    const query = { ...options, from, eventClock, limit: 2, durationValue: 1, durationUnit: Unit.Hour };
    expect(nextDueDoses(row, query)).toEqual([expected]);
    expect(calculateTotalUnits({ ...query, dosage: row })).toMatchObject({ totalUnits: 1, unit: "tab" });
  });

  it("returns an empty schedule for an empty dosage list without a time zone", () => {
    expect(nextDueDoses([], { from: origin })).toEqual([]);
    expect(() => nextDueDoses({ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day } } }, { from: origin })).toThrow(/timeZone/);
  });

  it.each([
    ["30", "60", false], ["30", "30", true],
    ["at least 30", "at least 60", false], ["at least 30", "at least 30", true],
    ["at most 30", "at most 60", false], ["at most 30", "at most 30", true],
  ] as const)("resolves same-time references only when predecessor offsets agree (%s and %s)", (left, right, shared) => {
    const source = `Take 1 tablet ${left} minutes before breakfast and 2 tablets ${right} minutes before breakfast for 2 days then take 3 tablets at the same time`;
    const parsed = parseSig(source);
    const clauses = parsed.meta.canonical.clauses;
    expect(clauses).toHaveLength(3);
    const schedule = clauses[2].schedule;
    expect(clauses[2].dose).toMatchObject({ value: 3, unit: "tab" });
    if (shared) {
      expect(schedule?.timingReference).toBeUndefined();
      expect(schedule?.when).toEqual([EventTiming["Before Breakfast"]]);
      const field = left.startsWith("at least") ? "offsetMin" : left.startsWith("at most") ? "offsetMax" : "offset";
      expect(schedule?.[field]).toBe(30);
      expect(parsed.fhir[2].additionalInstruction).toBeUndefined();
      expect(parsed.fhirNext.step![1].component[0].additionalInstruction).toBeUndefined();
    } else {
      expect(schedule?.timingReference).toBe("previous");
      expect(schedule?.when).toBeUndefined();
      expect(schedule?.timeOfDay).toBeUndefined();
      expect(schedule?.offset).toBeUndefined();
      expect(schedule?.offsetMin).toBeUndefined();
      expect(schedule?.offsetMax).toBeUndefined();
      expect(clauses[2].additionalInstructions?.some(item => item.text === "at the same time")).toBe(true);
    }
    expect(parsed.meta.canonical.course?.instruction).toBe(source);
  });

  it("keeps a successor waking interval independent of the predecessor clock", () => {
    const source = "Take 1 tablet daily at 09:00 for 2 days then take 2 tablets every 4 hours while awake";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[1].schedule).toMatchObject({
      period: 4, periodUnit: Unit.Hour, eventWindow: { start: "WAKE", end: "HS" } });
    expect(parsed.meta.canonical.clauses[1].schedule?.timeOfDay).toBeUndefined();
    const query = { ...options, from: "2026-01-03T00:00:00Z", eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 3 };
    for (const input of [parsed, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-03T08:00:00+00:00", "2026-01-03T12:00:00+00:00", "2026-01-03T16:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 6, unit: "tab" });
    }
  });

  it.each(["16:00", "09:00"])("qualifies an authored morning clock without adding an administration (%s second clock)", second => {
    const source = `Take 1 tablet every morning at 08:00 and ${second}`;
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
    const query = { ...options, eventClock: { MORN: "07:00" }, limit: 4 };
    for (const input of [parsed, persist(parsed.fhir), persist(parsed.fhirNext)]) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", `2026-01-01T${second}:00+00:00`,
        "2026-01-02T08:00:00+00:00", `2026-01-02T${second}:00+00:00`,
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(4);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(parsed.fhir[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
    expect(parsed.fhirNext.step![0].component[0].timing?.repeat?.timeOfDay).toEqual(["08:00:00", second + ":00"]);
  });

  it.each(["8am", "8 AM", "8pm", "8 PM"])("already preserves a qualified successor dose before a compact or spaced clock (%s)", clock => {
    const parsed = parseSig(`Take 1 tablet daily for 2 days then about 2 at ${clock}`);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    const expectedClock = clock.toLowerCase().includes("pm") ? "20:00:00" : "08:00:00";
    for (const row of [parsed.fhir[1], parsed.fhirNext.step![1].component[0], toFhirR5Dosages(parsed.fhirNext)[1]]) {
      expect(row.timing?.repeat?.timeOfDay).toEqual([expectedClock]);
      expect(row.doseAndRate![0].doseQuantity).toMatchObject({ value: 2, unit: "tab" });
      expect(row.doseAndRate![0].doseQuantity?.extension).toContainEqual({
        url: "http://ema.europa.eu/fhir/extension/comparator",
        valueCoding: { system: "http://spor.ema.europa.eu/v1/lists/100000000008", code: "100000000055" },
      });
    }
  });
});

describe("round 54 supported execution boundaries", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const start = "2026-11-02T00:00:00Z";
  const query = { from: start, orderedAt: start, timeZone: "UTC", limit: 6 };
  const wireForms = (rows: FhirDosage[]) => {
    const r6 = toDosageDetails(persist(rows));
    return [persist(rows), persist(r6), persist(toFhirR5Dosages(r6))];
  };
  const quantity = () => [{ doseQuantity: { value: 1, unit: "tab" } }];
  const lead = (minutes: number) => [{
    url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
    valueQuantity: { value: minutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" },
  }];

  it.each([-120, 0, 120])("compares partial month events in nominal time for a %s minute displacement", minutes => {
    const row: FhirDosage = {
      doseAndRate: [{ doseRange: { low: { value: 1, unit: "tab" }, high: { value: 2, unit: "tab" } } }],
      timing: { event: ["2026-11"] }, modifierExtension: lead(minutes),
      maxDosePerPeriod: [{ numerator: { value: 3, unit: "tab" },
        denominator: { value: 1, unit: "mo", code: "mo", system: "http://unitsofmeasure.org" } }],
      extension: [{ url: "urn:round54:partial-month-source", valueString: "retain unknown source" }],
    };
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      const local = { ...query, from: "2026-11-30T22:30:00Z" };
      expect(nextDueDoses(input, local)).toEqual([]);
      const calculate = () => calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Hour });
      if (minutes === -120) expect(calculate()).toMatchObject({ totalUnits: 0, unit: "tab" });
      else expect(calculate).toThrow(expect.objectContaining({ code: "timing-required" }));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("filters inferred elapsed slots before spending count (%s weekdays)", filtered => {
    const row: FhirDosage = { doseAndRate: quantity(), timing: { repeat: {
      frequency: 2, period: 24, periodUnit: Unit.Hour,
      ...(filtered ? { dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday] } : {}),
    } } };
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...query, limit: 4 })).toEqual(filtered ? [
        "2026-11-02T00:00:00+00:00", "2026-11-02T12:00:00+00:00",
        "2026-11-05T00:00:00+00:00", "2026-11-05T12:00:00+00:00",
      ] : [
        "2026-11-02T00:00:00+00:00", "2026-11-02T12:00:00+00:00",
        "2026-11-03T00:00:00+00:00", "2026-11-03T12:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...query, dosage: input, durationValue: 4, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: filtered ? 4 : 8, unit: "tab" });
      expect(calculateTotalUnits({ ...query, from: "2026-11-03T00:00:00Z", dosage: input,
        durationValue: 1, durationUnit: Unit.Day })).toMatchObject({ totalUnits: filtered ? 0 : 2, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("does not spend a counted weekday allowance on excluded inferred slots", () => {
    const row: FhirDosage = { doseAndRate: quantity(), timing: { repeat: {
      count: 4, frequency: 2, period: 24, periodUnit: Unit.Hour,
      dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Thursday],
    } } };
    for (const input of wireForms([row])) {
      const local = { ...query, from: "2026-11-05T00:00:00Z" };
      expect(nextDueDoses(input, local)).toEqual(["2026-11-05T00:00:00+00:00", "2026-11-05T12:00:00+00:00"]);
      expect(calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 2, unit: "tab" });
    }
  });

  it.each([-120, 0, 120])("keeps an inferred maximum supply slot inside its actual query (%s minute displacement)", minutes => {
    const row: FhirDosage = { doseAndRate: quantity(), modifierExtension: lead(minutes),
      timing: { repeat: { frequency: 1, frequencyMax: 2, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 2 }, { url: "period", valueQuantity: { value: 1, unit: "d",
            code: "d", system: "http://unitsofmeasure.org" } },
        ] }] } } };
    const from = minutes === -120 ? "2026-11-02T17:30:00Z" : minutes === 0
      ? "2026-11-02T19:30:00Z" : "2026-11-02T21:30:00Z";
    for (const input of wireForms([row])) {
      const before = JSON.stringify(input);
      expect(calculateTotalUnits({ ...query, from, dosage: input, durationValue: 1, durationUnit: Unit.Hour }))
        .toMatchObject({ totalUnits: 1, unit: "tab", quantityKind: "maximum" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["clock", "event", "none"] as const)("retains the first successor opportunity for a %s window", kind => {
    const extension = kind === "clock" ? [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-clock-window",
      extension: [{ url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "20:00:00" },
        { url: "endInclusive", valueBoolean: false }],
    }] : kind === "event" ? [{
      url: "urn:ezmedicationinput:StructureDefinition:medication-timing-event-window",
      extension: [{ url: "start", valueCode: "WAKE" }, { url: "end", valueCode: "HS" }],
    }] : undefined;
    const rows: FhirDosage[] = [
      { sequence: 1, doseAndRate: quantity(), timing: { repeat: { count: 1, timeOfDay: ["07:00:00"] } } },
      { sequence: 2, doseAndRate: quantity(), timing: { repeat: { period: 4, periodUnit: Unit.Hour, extension } } },
    ];
    for (const input of wireForms(rows)) {
      const before = JSON.stringify(input);
      const local = { ...query, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 4 };
      expect(nextDueDoses(input, local)).toEqual(kind === "none" ? [
        "2026-11-02T07:00:00+00:00", "2026-11-02T11:00:00+00:00",
        "2026-11-02T15:00:00+00:00", "2026-11-02T19:00:00+00:00",
      ] : [
        "2026-11-02T07:00:00+00:00", "2026-11-02T08:00:00+00:00",
        "2026-11-02T12:00:00+00:00", "2026-11-02T16:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ ...local, dosage: input, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: kind === "none" ? 5 : 4, unit: "tab" });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["as needed for pain", "", "once as needed for pain"])("does not invent a PRN predecessor count before NEXT (%s)", modifier => {
    const source = `Take 1 tablet at 22:00 ${modifier}, then 2 tablets the next morning`;
    const parsed = parseSig(source);
    const explicit = modifier.startsWith("once"), prn = modifier.includes("needed");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(prn && !explicit ? undefined : 1);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].schedule?.when).toEqual([EventTiming.Morning]);
    if (prn && !explicit) {
      expect(parsed.meta.canonical.clauses[0].evidence.some(e => e.rule === "hpsg.regimen.single-clock-before-next-day")).toBe(false);
      expect(parsed.meta.canonical.clauses[1].schedule?.phaseStartReference).not.toBe("previous-phase-next-day");
    }
    for (const input of [parsed, ...wireForms(parsed.fhir)]) {
      const before = JSON.stringify(input);
      if (!prn || explicit) expect(nextDueDoses(input, query)).toEqual([
        "2026-11-02T22:00:00+00:00", "2026-11-03T08:00:00+00:00",
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["at most once", "once"])("keeps an authored count ceiling separate from exact completion (%s)", count => {
    const source = `1 drop OD daily ${count} then 2 drops OD daily; 1 drop OS daily`;
    const parsed = parseSig(source);
    const maximum = count === "at most once";
    const schedule = parsed.meta.canonical.clauses[0].schedule!;
    expect(schedule.count).toBe(maximum ? undefined : 1);
    expect(schedule.countMax).toBe(maximum ? 1 : undefined);
    const successor = parsed.meta.canonical.course!.stages[0].administrations.find(a => a.sourceMember === 1)!;
    if (maximum) {
      expect(successor.phasePredecessors).toBeUndefined();
      expect(successor.phaseStart).toEqual({ anchor: "unresolved" });
    } else expect(successor.phasePredecessors).toEqual([0]);
    for (const rows of [parsed.fhir, toFhirR5Dosages(persist(parsed.fhirNext))]) {
      expect(rows[0].timing?.repeat?.count).toBe(maximum ? undefined : 1);
      expect(rows[0].timing?.repeat?.countMax).toBe(maximum ? 1 : undefined);
    }
  });

  it("retains explicit equal FHIR count endpoints as definite completion", () => {
    const rows: FhirDosage[] = [
      { sequence: 1, doseAndRate: quantity(), timing: { repeat: { count: 1, countMax: 1, timeOfDay: ["07:00:00"] } } },
      { sequence: 2, doseAndRate: quantity(), timing: { repeat: { period: 4, periodUnit: Unit.Hour } } },
    ];
    for (const input of wireForms(rows)) expect(nextDueDoses(input, { ...query, limit: 2 }))
      .toEqual(["2026-11-02T07:00:00+00:00", "2026-11-02T11:00:00+00:00"]);
  });

  it("already gives a dated same-track successor its established calendar start", () => {
    const source = "1 drop OD on 2026-11-02 then 2 drops OD daily; 1 drop OS daily";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.calendarEvents?.map(event => event.isoDate)).toEqual(["2026-11-02"]);
    expect(parsed.meta.canonical.clauses[1].schedule?.boundsStart).toBe("2026-11-03");
    const successor = parsed.meta.canonical.course!.stages[0].administrations.find(a => a.sourceMember === 1)!;
    expect(successor.phaseStart).toBeUndefined();
    expect(successor.schedule?.recurrence?.calendarWindow?.start).toBe("2026-11-03");
    for (const input of [parsed, ...wireForms(parsed.fhir)]) expect(nextDueDoses(input, { ...query, limit: 4 }))
      .toEqual(["2026-11-02T00:00:00+00:00", "2026-11-02T09:00:00+00:00",
        "2026-11-03T09:00:00+00:00", "2026-11-03T09:00:00+00:00"]);
  });

  it("retains the authored calendar end separately from a resolved parallel execution cut", () => {
    const source = "1 drop OD QID x7d then 1 drop OD BID; " +
      "1 drop OS QID from 2026-10-25 for 7 days until 2026-11-15 then 1 drop OS BID from 2026-11-16";
    const parsed = parseSig(source);
    const members = parsed.meta.canonical.course!.stages.reduce<CanonicalAdministration[]>((all, stage) => all.concat(stage.administrations), [])
      .filter(member => member.sourceMember === 2);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member.syntax?.schedule?.boundsEnd).toBe("2026-11-15");
      expect(member.schedule?.recurrence?.calendarWindow).toEqual({ start: "2026-10-25", end: "2026-10-31" });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.meta.canonical.clauses[2].schedule).toMatchObject({ boundsEnd: "2026-11-15", duration: 7, durationUnit: "d" });
  });
});



describe("round55 execution preserves authored calendar and terminology meaning", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const wire = (source: FhirR6DosageInstruction, version: "r5" | "r6") =>
    version === "r6" ? persist(source) : persist(toFhirR5Dosages(source));
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const note = { url: "urn:clinic:round55-execution-note", valueString: "retain independently authored details" };
  const eventWindow = { url: "urn:ezmedicationinput:StructureDefinition:medication-timing-event-window",
    extension: [{ url: "start", valueCode: "WAKE" }, { url: "end", valueCode: "HS" }] };
  const monthDay = { url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: 15 };
  const marker = "urn:ezmedicationinput:StructureDefinition:timing-administration-duration";
  const componentOf = (input: FhirR6DosageInstruction | FhirDosage[]) =>
    toDosageDetails(toFhirR5Dosages(input)).step![0].component[0];

  it.each(["r5", "r6"] as const)("retains BID after a metadata-only Coding (%s)", version => {
    const coding = [
      { id: "local-annotation", extension: [note] },
      { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID", _code: { id: "coded-cadence" } },
    ];
    for (const entries of [coding, [coding[1], coding[0]]]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: { coding: entries } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Use 1 tablet twice daily.");
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(componentOf(input).timing?.code?.coding).toEqual(entries);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps the explicit waking window for equivalent elapsed cadences (%s)", version => {
    for (const [period, periodUnit] of [[0.5, Unit.Day], [12, Unit.Hour], [1 / 14, Unit.Week]] as const) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
        timing: { repeat: { period, periodUnit, extension: [eventWindow, note] } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      const query = { ...options, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 3 };
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00", "2026-01-03T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 1, unit: "tab" });
      expect(componentOf(input).timing?.repeat).toMatchObject({ period, periodUnit, extension: [eventWindow, note] });
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps punctual WAKE, explicit windows, and unwindowed calendar controls distinct (%s)", version => {
    const punctual: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, when: [EventTiming.Wake], extension: [note] } } }] }] };
    const calendar: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { period: 1, periodUnit: Unit.Day, extension: [eventWindow, note] } } }] }] };
    const unwindowed: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
      timing: { repeat: { period: 1, periodUnit: Unit.Day, extension: [note] } } }] }] };
    const query = { ...options, eventClock: { WAKE: "08:00", HS: "20:00" }, limit: 2 };
    expect(nextDueDoses(wire(punctual, version), query)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(calendar, version), query)).toEqual([
      "2026-01-01T08:00:00+00:00", "2026-01-02T08:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(unwindowed, version), query)).toEqual([
      "2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00",
    ]);
  });

  it.each(["r5", "r6"] as const)("uses the origin clock for a clockless month-day and counts earlier opportunities (%s)", version => {
    for (const period of [1, 2]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(),
        timing: { repeat: { count: 3, frequency: 1, period, periodUnit: Unit.Month, extension: [monthDay, note] } } }] }] };
      const input = wire(source, version), before = JSON.stringify(input);
      const query = { from: "2026-01-01T10:15:00Z", orderedAt: "2026-01-01T10:15:00Z", timeZone: "UTC", limit: 3 };
      const dates = period === 1 ? ["2026-01-15", "2026-02-15", "2026-03-15"] : ["2026-01-15", "2026-03-15", "2026-05-15"];
      expect(nextDueDoses(input, query)).toEqual(dates.map(day => day + "T10:15:00+00:00"));
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 6, durationUnit: Unit.Month }).totalUnits).toBe(3);
      const later = { ...query, from: "2026-02-01T00:00:00Z" };
      expect(nextDueDoses(input, later)).toEqual(dates.slice(1).map(day => day + "T10:15:00+00:00"));
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 5, durationUnit: Unit.Month }).totalUnits).toBe(2);
      expect(componentOf(input).timing?.repeat).toMatchObject({ count: 3, period, periodUnit: Unit.Month, extension: [monthDay, note] });
      expect(componentOf(input).timing?.repeat?.timeOfDay).toBeUndefined();
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("retains authored month-day clocks and unselected month-end clamping (%s)", version => {
    const source = (selected: boolean): FhirR6DosageInstruction => ({ step: [{ component: [{ ...quantity(),
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Month,
        ...(selected ? { timeOfDay: ["08:00:00"], extension: [monthDay, note] } : { extension: [note] }) } } }] }] });
    const query = { from: "2026-01-31T10:15:00Z", orderedAt: "2026-01-31T10:15:00Z", timeZone: "UTC", limit: 3 };
    expect(nextDueDoses(wire(source(false), version), query)).toEqual([
      "2026-01-31T10:15:00+00:00", "2026-02-28T10:15:00+00:00", "2026-03-28T10:15:00+00:00",
    ]);
    expect(nextDueDoses(wire(source(true), version), query)).toEqual([
      "2026-02-15T08:00:00+00:00", "2026-03-15T08:00:00+00:00", "2026-04-15T08:00:00+00:00",
    ]);
  });

  it.each(["r5", "r6"] as const)("validates the selected branch against the complete submitted course (%s)", version => {
    const choice = { url: "urn:ezmedicationinput:StructureDefinition:medication-alternative-choice", extension: [
      { url: "groupId", valueString: "regimen" }, { url: "branchId", valueString: "B" },
      { url: "selectionBehavior", valueCode: "exactly-one" },
    ] };
    const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(2), modifierExtension: [choice],
      extension: [note], timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } } }] }] };
    const input = wire(source, version), before = JSON.stringify(input);
    const selectedA = { ...options, alternativeChoices: { regimen: "A" } };
    expect(() => nextDueDoses(input, { ...selectedA, limit: 2 }))
      .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    expect(() => calculateTotalUnits({ dosage: input, ...selectedA, durationValue: 1, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    const selectedB = { ...options, alternativeChoices: { regimen: "B" }, limit: 2 };
    expect(nextDueDoses(input, selectedB)).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...selectedB, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
    const standalone = persist(toFhirR5Dosages(source)[0]);
    expect(nextDueDoses(standalone, selectedA)).toEqual([]);
    expect(calculateTotalUnits({ dosage: standalone, ...selectedA, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(componentOf(input).modifierExtension).toEqual([choice]);
    expect(componentOf(input).extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("retains explicit successor events while keeping an unanchored interval floor (%s)", version => {
    for (const explicit of [true, false]) {
      const source: FhirR6DosageInstruction = { step: [
        { component: [{ ...quantity(), timing: { event: ["2026-01-01T08:00:00Z"] }, extension: [note] }] },
        { component: [{ ...quantity(2), timing: {
          ...(explicit ? { event: ["2026-01-01T07:00:00Z", "2026-01-01T09:00:00Z", "2026-01-01T13:00:00Z"] } : {}),
          repeat: { period: 4, periodUnit: Unit.Hour } } }] },
      ] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(explicit ? [
        "2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T13:00:00+00:00",
      ] : [
        "2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00", "2026-01-01T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(explicit ? 5 : 7);
      const restored = toDosageDetails(toFhirR5Dosages(input));
      expect(restored.step![1].component[0].timing?.event).toEqual(source.step![1].component[0].timing?.event);
      expect(restored.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("does not reinterpret explicit UCUM conductance as a duration (%s)", version => {
    for (const variant of ["S", "s", "s{infusion}", "systemless S", "uncoded SECONDS"]) {
      const seconds = variant !== "S";
      const endpoint = { value: 60, ...(variant === "uncoded SECONDS" ? { unit: "SECONDS" }
        : { unit: seconds ? "seconds" : "siemens", code: variant === "systemless S" ? "S" : variant,
          ...(variant === "systemless S" ? {} : { system: "http://unitsofmeasure.org" }) }),
        _value: { id: "authored-duration-value" }, extension: [note] };
      const range = { id: "authored-duration-range", low: { ...endpoint }, high: { ...endpoint } };
      const source: FhirR6DosageInstruction = { step: [
        { component: [{ ...quantity(), timing: { repeat: { count: 1, extension: [{ url: marker, valueRange: range }] } } }] },
        { component: [{ ...quantity(2), timing: { repeat: { count: 1 } } }] },
      ] };
      const input = wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual(seconds ? [
        "2026-01-01T00:00:00+00:00", "2026-01-01T00:01:00+00:00",
      ] : ["2026-01-01T00:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits)
        .toBe(seconds ? 3 : 1);
      expect(componentOf(input).timing?.repeat?.extension?.find(value => value.url === marker)?.valueRange).toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["08:00", "at 08:00", "8 AM"])("keeps the authored %s clock inside a relative ending", clock => {
    const ending = "until the next morning " + clock;
    const source = "Take 1 tablet every 6 hours " + ending;
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ timingCode: "Q6H", period: 6, periodUnit: Unit.Hour });
    expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].additionalInstructions).toContainEqual({ text: ending });
    for (const input of [persist(parsed.fhirNext), persist(toFhirR5Dosages(parsed.fhirNext))]) {
      const component = componentOf(input);
      expect(component.timing?.repeat?.timeOfDay).toBeUndefined();
      expect(component.additionalInstruction).toContainEqual({ text: ending });
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(JSON.stringify(parsed)).toBe(before);
  });


  it.each([1.5, 2])("preserves a terminal two-day pause after an authored %s-day course", duration => {
    const source = `1 tab PO at 08:00 and 20:00 for ${duration} days, then HOLD for 2 days, then 2 tabs PO at 08:00 and 20:00 for 2 days`;
    const parsed = parseSig(source), before = JSON.stringify(parsed);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({ duration, durationUnit: Unit.Day });
    expect(parsed.meta.canonical.clauses[0].clinicalAdjuncts?.treatmentPause?.durationDays).toBe(2);
    expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab" });
    expect(parsed.meta.canonical.clauses[1].schedule?.treatmentStartOffsetDays).toBe(duration + 2);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    for (const version of ["r5", "r6"] as const) {
      const input = wire(parsed.fhirNext, version), saved = JSON.stringify(input);
      if (duration === 1.5) {
        // This existing representation cannot combine an elapsed fractional
        // phase with a later civil-day pause. Do not round or silently omit it.
        expect(() => nextDueDoses(input, { ...options, limit: 12 }))
          .toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
        expect(() => calculateTotalUnits({ dosage: input, ...options, durationValue: 6, durationUnit: Unit.Day }))
          .toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
      } else {
        expect(nextDueDoses(input, { ...options, limit: 12 })).toEqual([
          "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
          "2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00",
          "2026-01-05T08:00:00+00:00", "2026-01-05T20:00:00+00:00",
          "2026-01-06T08:00:00+00:00", "2026-01-06T20:00:00+00:00",
        ]);
        expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(12);
      }
      const restored = toDosageDetails(toFhirR5Dosages(input));
      expect(restored.renderedInstruction).toBe(source);
      expect(restored.step![0].component[0].timing?.repeat?.boundsDuration).toMatchObject({ value: duration, unit: "days", code: "d", system: "http://unitsofmeasure.org" });
      expect(JSON.stringify(input)).toBe(saved);
    }
    expect(JSON.stringify(parsed)).toBe(before);
  });
});


describe("round56 execution respects retained public facts", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const note = { url: "urn:clinic:round56-execution-note", valueString: "keep independently authored data" };
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r6Wire = (source: FhirR6DosageInstruction, version: "r5" | "r6") =>
    version === "r6" ? persist(source) : persist(toFhirR5Dosages(source));
  const r5Wire = (source: FhirDosage, version: "r5" | "r6") =>
    version === "r5" ? persist(source) : persist(toDosageDetails([persist(source)]));
  const reopened = (input: FhirDosage | FhirDosage[] | FhirR6DosageInstruction) =>
    toDosageDetails(persist(toFhirR5Dosages(Array.isArray(input) ? input : "step" in input
      ? input as FhirR6DosageInstruction : [input as FhirDosage])));
  const offset = (minutes: number) => ({
    url: "urn:ezmedicationinput:StructureDefinition:medication-administration-offset",
    valueQuantity: { value: minutes, unit: "min", code: "min", system: "http://unitsofmeasure.org" },
  });

  it.each(["r5", "r6"] as const)("prefers recognized BID beside a coded local translation (%s)", version => {
    const entries = [{ system: "urn:clinic:cadence", code: "TWICE", display: "clinic twice daily", extension: [note] },
      { system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "BID", _code: { id: "authored-cadence" } }];
    for (const coding of [entries, [entries[1], entries[0]]]) {
      const source: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: { coding } }, extension: [note] }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe("Use 1 tablet twice daily.");
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      expect(reopened(input).step![0].component[0].timing?.code?.coding).toEqual(coding);
      expect(reopened(input).step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
    const local: FhirR6DosageInstruction = { step: [{ component: [{ ...quantity(), timing: { code: {
      coding: [entries[0]], text: "Clinic schedule remains authored" } } }] }] };
    const input = r6Wire(local, version), before = JSON.stringify(input);
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).not.toContain("twice daily");
    expect(reopened(input).step![0].component[0].timing?.code).toEqual(local.step![0].component[0].timing!.code);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("includes every matching date in month and year period ends (%s)", version => {
    for (const zone of ["UTC", "America/New_York"]) for (const end of ["2026-11", "2026"]) {
      const last = end === "2026-11" ? "2026-11-30" : "2026-12-31";
      const next = end === "2026-11" ? "2026-12-01" : "2027-01-01";
      const suffix = zone === "UTC" ? "+00:00" : "-05:00";
      const row: FhirDosage = { ...quantity(), timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["09:00:00"],
        boundsPeriod: { end, _end: { id: "authored-end-precision" }, extension: [note] },
      } }, extension: [note] };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { from: last + "T00:00:00" + suffix, orderedAt: "2026-11-01T00:00:00" + suffix, timeZone: zone, limit: 2 };
      expect(nextDueDoses(input, query)).toEqual([last + "T09:00:00" + suffix]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(input, { ...query, from: next + "T00:00:00" + suffix })).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...query, from: next + "T00:00:00" + suffix,
        durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod).toEqual(row.timing!.repeat!.boundsPeriod);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("keeps inclusive full-date and exact-timestamp end controls (%s)", version => {
    for (const end of ["2026-11-30", "2026-11-30T09:00:00Z", "2026-11-30T08:59:59.999Z"]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1,
        periodUnit: Unit.Day, timeOfDay: ["09:00:00"], boundsPeriod: { end } } }, extension: [note] };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { from: "2026-11-30T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 2 };
      const expected = end.endsWith("08:59:59.999Z") ? [] : ["2026-11-30T09:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(expected.length);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.end).toBe(end);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("gives an absolute event one weekly-cycle owner with and without a cap (%s)", version => {
    for (const capped of [false, true]) {
      const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
        step: [{ component: [{ ...quantity(), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note],
          ...(capped ? { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: { value: 10, unit: "tab" },
            period: { value: 1, code: "d", unit: "d", system: "http://unitsofmeasure.org" } }] } } : {}) }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(nextDueDoses(input, { ...options, from: "2026-01-11T00:00:00Z", limit: 2 })).toEqual([]);
      const saved = reopened(input);
      expect(saved.repeatCycle).toEqual(source.repeatCycle);
      expect(saved.step![0].component[0].timing?.event).toEqual(["2026-01-10T09:00:00Z"]);
      expect(saved.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("retains an absolute event after the final finite cycle's nominal end (%s)", version => {
    for (const cycles of [1, 2]) for (const capped of [false, true]) {
      const event = cycles === 1 ? "2026-01-10T09:00:00Z" : "2026-01-17T09:00:00Z";
      const count = { url: "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count", valueInteger: cycles };
      const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
        modifierExtension: [count], step: [{ component: [{ ...quantity(), timing: { event: [event] }, extension: [note],
          ...(capped ? { safety: { doseLimit: [{ scope: "period" as const, valueQuantity: { value: 10, unit: "tab" },
            period: { value: 1, code: "d", unit: "d", system: "http://unitsofmeasure.org" } }] } } : {}) }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([event.replace("Z", "+00:00")]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 21, durationUnit: Unit.Day }).totalUnits).toBe(1);
      const saved = reopened(input);
      expect(saved.modifierExtension).toContainEqual(count);
      expect(saved.step![0].component[0].timing?.event).toEqual([event]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("does not complete an earlier-cycle predecessor from a later absolute event (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" }, step: [
      { component: [{ ...quantity(), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note] }] },
      { component: [{ ...quantity(2), timing: { event: ["2026-01-11T09:00:00Z"] }, extension: [note] }] },
    ] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00", "2026-01-11T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step!.map(step => step.component[0].timing?.event)).toEqual([
      ["2026-01-10T09:00:00Z"], ["2026-01-11T09:00:00Z"],
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("retains two independent administrations at the same absolute event (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
      step: [{ component: [1, 2].map(value => ({ ...quantity(value), timing: { event: ["2026-01-10T09:00:00Z"] }, extension: [note] })) }] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual(["2026-01-10T09:00:00+00:00", "2026-01-10T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step![0].component.map(component => component.doseAndRate?.[0].doseQuantity?.value)).toEqual([1, 2]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("keeps independently prescribed relative-cycle doses at the same instant (%s)", version => {
    const source: FhirR6DosageInstruction = { repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
      step: [{ component: [{ ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], boundsDuration: { value: 10, unit: "d", code: "d", system: "http://unitsofmeasure.org" } } }, extension: [note] }] }] };
    const input = r6Wire(source, version), before = JSON.stringify(input);
    const expected = Array.from({ length: 14 }, (_, index) => "2026-01-" + String(index + 1).padStart(2, "0") + "T09:00:00+00:00");
    expected.push("2026-01-08T09:00:00+00:00", "2026-01-09T09:00:00+00:00", "2026-01-10T09:00:00+00:00");
    expected.sort();
    expect(nextDueDoses(input, { ...options, limit: 17 })).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(17);
    expect(reopened(input).step![0].component[0].timing?.repeat?.boundsDuration).toEqual(source.step![0].component[0].timing!.repeat!.boundsDuration);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([3, 12])("resolves a standalone choice before its %s-hour phase origin", hours => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{ ...dose(2),
      choice: { groupId: "regimen", branchId: "B", selectionBehavior: "exactly-one" }, phaseOrigin: { value: hours, unit: "h" } }] }] };
    const row = persist(courseToR5(course)[0]), before = JSON.stringify(row);
    const selectedA = { ...options, alternativeChoices: { regimen: "A" }, limit: 1 };
    const selectedB = { ...options, alternativeChoices: { regimen: "B" }, limit: 1 };
    expect(nextDueDoses(row, selectedA)).toEqual([]);
    expect(calculateTotalUnits({ dosage: row, ...selectedA, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(nextDueDoses(row, selectedB)).toEqual([hours === 3 ? "2026-01-01T09:00:00+00:00" : "2026-01-02T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: row, ...selectedB, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(hours === 3 ? 2 : 0);
    for (const complete of [persist(courseToR5(course)), persist(courseToR6(course))]) {
      expect(() => nextDueDoses(complete, selectedA)).toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
      expect(() => calculateTotalUnits({ dosage: complete, ...selectedA, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "unknown-alternative-branch" }));
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("uses a measured drop endpoint for the complete two-eye maximum (%s)", version => {
    for (const kind of ["absent", "annotation", "measured"] as const) {
      const high = kind === "absent" ? undefined : { id: "authored-upper", extension: [note],
        ...(kind === "measured" ? { value: 3, unit: "drop" } : {}) };
      const range = { low: { value: 1, unit: "drop", _value: { id: "authored-low" } }, ...(high ? { high } : {}) };
      const source: FhirR6DosageInstruction = { step: [{ component: [{ site: { concept: { text: "both eyes" } },
        doseAndRate: [{ doseRange: range }], timing: { repeat: { count: 1 } },
        safety: { doseLimit: [{ scope: "administration", valueQuantity: { value: 4, unit: "drop" } }] }, extension: [note] }] }] };
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T00:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }))
        .toMatchObject({ totalUnits: 4, unit: "drop", quantityKind: "maximum" });
      const saved = reopened(input).step![0].component[0];
      expect(saved.site?.concept?.text).toBe("both eyes");
      expect(saved.doseAndRate?.[0].doseRange).toEqual(range);
      expect(saved.extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("counts displaced admissions under occurrence and calendar quantity ceilings (%s)", version => {
    for (const cap of ["occurrence", "month", "year", "none"]) for (const minutes of [-60, 0, 60]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["00:30:00"], boundsPeriod: { start: "2026-01-02T00:00:00Z" },
        ...(cap === "occurrence" ? { extension: [{ url: TIMING_OCCURRENCE_CAP_EXTENSION_URL, extension: [
          { url: "max", valueInteger: 1 }, { url: "period", valueQuantity: { value: 1, unit: "d", code: "d", system: "http://unitsofmeasure.org" } },
        ] }] } : {}) } }, modifierExtension: [offset(minutes)], extension: [note],
        ...(["month", "year"].includes(cap) ? { maxDosePerPeriod: [{ numerator: { value: 10, unit: "tab" },
          denominator: { value: 1, code: cap === "month" ? "mo" : "a", unit: cap === "month" ? "mo" : "a", system: "http://unitsofmeasure.org" } }] } : {}) };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const from = minutes < 0 ? "2026-01-01T23:00:00Z" : minutes === 0 ? "2026-01-02T00:00:00Z" : "2026-01-02T01:00:00Z";
      const due = minutes < 0 ? "2026-01-01T23:30:00+00:00" : minutes === 0 ? "2026-01-02T00:30:00+00:00" : "2026-01-02T01:30:00+00:00";
      const query = { ...options, from, limit: 1 };
      expect(nextDueDoses(input, query)).toEqual([due]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].modifierExtension).toContainEqual(offset(minutes));
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.start).toBe("2026-01-02T00:00:00Z");
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["r5", "r6"] as const)("spends an exhausted non-PRN count from actual bounded records without inventing partial dates (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { event: ["2026-11"], _event: [{ id: "month-precision" }], repeat: { count: 2 } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { from: "2026-11-03T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 2 };
    const records = ["2026-11-01T09:00:00Z", "2026-11-02T09:00:00Z"];
    expect(nextDueDoses(input, { ...query, priorDoseTimes: records })).toEqual([]);
    expect(calculateTotalUnits({ dosage: input, ...query, priorDoseTimes: records, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    expect(calculateTotalUnits({ dosage: input, ...query, priorCount: 2, priorDoseTimes: records,
      durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(0);
    for (const partial of [{ priorDoseTimes: records.slice(0, 1) }, { priorCount: 1, priorDoseTimes: records },
      { priorDoseTimes: ["2026-10-31T09:00:00Z", "2026-11-04T09:00:00Z"] }])
      expect(() => calculateTotalUnits({ dosage: input, ...query, ...partial, durationValue: 1, durationUnit: Unit.Day }))
        .toThrow(expect.objectContaining({ code: "timing-required" }));
    const saved = reopened(input).step![0].component[0];
    expect(saved.timing?.event).toEqual(["2026-11"]);
    expect(saved.timing?._event).toEqual([{ id: "month-precision" }]);
    expect(saved.timing?.repeat?.count).toBe(2);
    expect(saved.extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["r5", "r6"] as const)("keeps ordinary inferred history and explicit priorCount precedence (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { repeat: { count: 3, frequency: 1, period: 1,
      periodUnit: Unit.Day, timeOfDay: ["09:00:00"] } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { from: "2026-11-03T00:00:00Z", orderedAt: "2026-11-01T00:00:00Z", timeZone: "UTC", limit: 3,
      priorDoseTimes: ["2026-11-01T09:00:00Z"] };
    expect(nextDueDoses(input, query)).toEqual(["2026-11-03T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...query, priorCount: 1 })).toEqual(["2026-11-03T09:00:00+00:00", "2026-11-04T09:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...query, priorCount: 1, durationValue: 3, durationUnit: Unit.Day }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe("round57 typed timing and civil boundaries", () => {
  const persist = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const versions = ["r5", "r6"] as const;
  const note = { url: "urn:clinic:round57-execution-note", valueString: "keep authored data" };
  const quantity = (value = 1) => ({ doseAndRate: [{ doseQuantity: { value, unit: "tab" } }] });
  const r5Wire = (row: FhirDosage, version: typeof versions[number]) =>
    version === "r5" ? persist([row]) : persist(toDosageDetails([row]));
  const r6Wire = (instruction: FhirR6DosageInstruction, version: typeof versions[number]) =>
    version === "r6" ? persist(instruction) : persist(toFhirR5Dosages(instruction));
  const reopened = (input: FhirDosage[] | FhirR6DosageInstruction) =>
    persist(toDosageDetails(persist(toFhirR5Dosages(input))));

  it.each(versions)("keeps a unitless delayed approximate dose beside its inherited unit (%s)", version => {
    for (const explicitUnit of ["", " tablets"]) {
      const text = "Take 1 tablet once, then about 2" + explicitUnit + " in 6 hours";
      const parsed = parseSig(text);
      expect(parsed.meta.canonical.clauses[1].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
      expect(parsed.meta.canonical.clauses[1].schedule?.administrationOffsetMinutes).toBe(360);
      const input = r6Wire(parsed.fhirNext, version), before = JSON.stringify(input);
      expect(importCanonicalCourse(input).stages[1].administrations[0].amounts![0].quantity)
        .toMatchObject({ value: 2, unit: "tab", comparator: "~" });
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-01-01T00:00:00+00:00", "2026-01-01T06:00:00+00:00",
      ]);
      expect(reopened(input).renderedInstruction).toBe(text);
      expect(JSON.stringify(input)).toBe(before);
    }
    const unknown = parseSig("Take 1 tablet once, then about 2 in 6 cups");
    expect(unknown.meta.canonical.clauses.every(clause => clause.schedule?.administrationOffsetMinutes === undefined)).toBe(true);
    expect(JSON.stringify(unknown.fhirNext)).toContain("about 2 in 6 cups");
  });

  it.each(versions)("keeps comparative meridiem phrases as clocks without inventing a dose (%s)", version => {
    for (const [text, clock] of [["Take around 2 pm", "14:00:00"], ["Take approximately 2 am", "02:00:00"]]) {
      const parsed = parseSig(text);
      expect(parsed.meta.canonical.clauses[0].dose?.value).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0].schedule?.timeOfDay).toEqual([clock]);
      const input = r6Wire(parsed.fhirNext, version), before = JSON.stringify(input);
      const rows = toFhirR5Dosages(input);
      expect(rows[0].doseAndRate?.[0].doseQuantity?.value).toBeUndefined();
      expect(rows[0].timing?.repeat?.timeOfDay).toEqual([clock]);
      expect(reopened(input).renderedInstruction).toBe(text);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions)("keeps a qualified amount separate from an actual around-site phrase (%s)", version => {
    const approximate = parseSig("Take around 2 tablets daily");
    expect(approximate.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    expect(approximate.meta.canonical.clauses[0].site).toBeUndefined();
    const input = r6Wire(approximate.fhirNext, version), before = JSON.stringify(input);
    expect(importCanonicalCourse(input).stages[0].administrations[0].amounts![0].quantity)
      .toMatchObject({ value: 2, unit: "tab", comparator: "~" });
    const spatialInput = r6Wire(parseSig("Apply 1 g around the left eye daily").fhirNext, version);
    expect(formatSig(spatialInput, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/around.*left eye/u);
    expect(toFhirR5Dosages(spatialInput)[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "g" });
    expect(reopened(input).renderedInstruction).toBe("Take around 2 tablets daily");
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains a next-morning deadline without turning it into an onset (%s)", version => {
    const text = "Take 1 tablet once by the next morning";
    const deadline = parseSig(text), onset = parseSig("Take 1 tablet once the next morning");
    expect(deadline.meta.canonical.clauses[0].schedule?.treatmentStartOffsetDays).toBeUndefined();
    expect(deadline.meta.canonical.clauses[0].schedule?.phaseStartReference).toBeUndefined();
    expect(deadline.meta.canonical.clauses[0].schedule?.when ?? []).not.toContain(EventTiming.Morning);
    expect(deadline.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
    expect(onset.meta.canonical.clauses[0].schedule).toMatchObject({
      count: 1, treatmentStartOffsetDays: 1, phaseStartReference: "treatment-day-start", when: [EventTiming.Morning],
    });
    const input = r6Wire(deadline.fhirNext, version), before = JSON.stringify(input);
    expect(reopened(input).renderedInstruction).toBe(text);
    expect(JSON.stringify(reopened(input))).toContain("by the next morning");
    const savedDeadline = reopened(input);
    const savedMember = importCanonicalCourse(savedDeadline).stages[0].administrations[0];
    expect(savedMember.phaseStart).toBeUndefined();
    expect(savedMember.phaseOrigin).toBeUndefined();
    expect(savedMember.phaseEnd).toMatchObject({ anchor: "unresolved", description: "by the next morning" });
    expect(savedMember.schedule!.recurrence!.anchors ?? []).not.toContain(EventTiming.Morning);
    expect(savedDeadline.step![0].component[0].timing?.repeat).toMatchObject({ count: 1 });
    expect(formatSig(savedDeadline, "long", { locale: "en", realizationMode: "normalized" })).toContain("by the next morning");
    const savedBefore = JSON.stringify(savedDeadline);
    expect(() => nextDueDoses(savedDeadline, { ...options, limit: 2 }))
      .toThrow(/Unsupported R6 step RelativeTime: requires a treatment-start offset/u);
    expect(JSON.stringify(savedDeadline)).toBe(savedBefore);
    const positive = r6Wire(onset.fhirNext, version);
    expect(nextDueDoses(positive, { ...options, limit: 2 })).toEqual(["2026-01-02T08:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  const midnightGaps = [
    { zone: "America/Havana", end: "2012-04", after: "2012-05-01", last: "2012-04-30", offset: "-04:00", order: "2012-04-01T12:00:00-04:00" },
    { zone: "Asia/Amman", end: "2011-04", after: "2011-05-01", last: "2011-04-30", offset: "+03:00", order: "2011-04-01T12:00:00+03:00" },
    { zone: "America/Danmarkshavn", end: "1996", after: "1997-01-01", last: "1996-12-31", offset: "+00:00", order: "1996-01-01T12:00:00Z" },
  ];
  it.each(versions.flatMap(version => midnightGaps.map(gap => ({ version, ...gap }))))(
    "closes $end at the next local midnight independently of its opening gap ($zone/$version)", data => {
      const boundsPeriod = { end: data.end, _end: { id: "authored-end" }, extension: [note] };
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["00:30:00"], boundsPeriod,
      } } };
      const input = r5Wire(row, data.version), before = JSON.stringify(input);
      const after = { from: data.after + "T00:00:00" + data.offset, orderedAt: data.order, timeZone: data.zone, limit: 1 };
      expect(nextDueDoses(input, after)).toEqual([]);
      expect(calculateTotalUnits({ dosage: input, ...after, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(0);
      const inside = { ...after, from: data.last + "T00:00:00" + data.offset };
      expect(nextDueDoses(input, inside)).toEqual([data.last + "T00:30:00" + data.offset]);
      expect(calculateTotalUnits({ dosage: input, ...inside, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      const saved = reopened(input).step![0].component[0];
      expect(saved.timing?.repeat?.boundsPeriod).toEqual(boundsPeriod);
      expect(saved.extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("keeps inclusive full-date and exact-timestamp end behavior (%s)", version => {
    for (const end of ["2026-01-01", "2026-01-01T09:00:00Z"]) {
      const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day,
        timeOfDay: ["09:00:00"], boundsPeriod: { end } } } };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual(["2026-01-01T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod?.end).toBe(end);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions.flatMap(version => [
    { version, zone: "Asia/Bangkok", offset: "+07:00" }, { version, zone: "America/New_York", offset: "-05:00" },
    { version, zone: "UTC", offset: "+00:00" },
  ]))("starts month and year precision at local midnight ($zone/$version)", data => {
    for (const [start, day] of [["2026-11", "2026-11-01"], ["2026", "2026-01-01"]]) {
      const boundsPeriod = { start, _start: { id: "authored-start" }, extension: [note] };
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["02:00:00"], boundsPeriod,
      } } };
      // November's first day is still daylight time at midnight in New York.
      const dayOffset = data.zone === "America/New_York" && start === "2026-11" ? "-04:00" : data.offset;
      const precedingDay = start === "2026-11" ? "2026-10-31" : "2025-12-31";
      const query = { from: precedingDay + "T00:00:00" + dayOffset, orderedAt: precedingDay + "T00:00:00" + dayOffset, timeZone: data.zone, limit: 1 };
      const input = r5Wire(row, data.version), before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual([day + "T02:00:00" + data.offset]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 2, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.boundsPeriod).toEqual(boundsPeriod);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(versions.flatMap(version => [1, 2].map(period => ({ version, period }))))(
    "uses both explicit month days for an aggregate cadence of $period months ($version)", ({ version, period }) => {
      const selected = [1, 15].map(valuePositiveInt => ({
        url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt,
      }));
      const row: FhirDosage = { ...quantity(), extension: [note], timing: { repeat: {
        frequency: 2, period, periodUnit: Unit.Month, count: 4, extension: [...selected, note],
      } } };
      const input = r5Wire(row, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-01T09:00:00Z", orderedAt: "2026-01-01T09:00:00Z", limit: 5 };
      const nextMonth = period === 1 ? "02" : "03";
      expect(nextDueDoses(input, query)).toEqual([
        "2026-01-01T09:00:00+00:00", "2026-01-15T09:00:00+00:00",
        "2026-" + nextMonth + "-01T09:00:00+00:00", "2026-" + nextMonth + "-15T09:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: period, durationUnit: Unit.Month }).totalUnits).toBe(2);
      const middle = { ...query, from: "2026-01-15T00:00:00Z", limit: 1 };
      expect(nextDueDoses(input, middle)).toEqual(["2026-01-15T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...middle, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
      expect(reopened(input).step![0].component[0].timing?.repeat?.extension).toEqual([...selected, note]);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("retains ordinary aggregate distribution when no month day is authored (%s)", version => {
    const row: FhirDosage = { ...quantity(), timing: { repeat: { frequency: 2, period: 1, periodUnit: Unit.Month } }, extension: [note] };
    const input = r5Wire(row, version), before = JSON.stringify(input);
    const query = { ...options, from: "2026-01-01T09:00:00Z", orderedAt: "2026-01-01T09:00:00Z", limit: 4 };
    expect(nextDueDoses(input, query)).toEqual([
      "2026-01-01T09:00:00+00:00", "2026-01-16T09:00:00+00:00",
      "2026-02-01T09:00:00+00:00", "2026-02-15T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Month }).totalUnits).toBe(2);
    expect(JSON.stringify(input)).toBe(before);
  });

  const cycleCases = [
    { name: "one event per cycle", events: ["2026-01-02T09:00:00Z", "2026-01-09T09:00:00Z"], expected: [
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-09T09:00:00+00:00", "2026-01-09T09:00:00+00:00",
    ], total: 6 },
    { name: "no earlier owned event", events: ["2026-01-09T09:00:00Z"], expected: [
      "2026-01-09T09:00:00+00:00", "2026-01-09T09:00:00+00:00",
    ], total: 3 },
    { name: "final finite tail", events: ["2026-01-02T09:00:00Z", "2026-01-16T09:00:00Z"], expected: [
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-16T09:00:00+00:00", "2026-01-16T09:00:00+00:00",
    ], total: 6 },
  ];
  const cycleInstruction = (events: string[]): FhirR6DosageInstruction => ({
    repeatCycle: { value: 1, unit: "week", code: "wk", system: "http://unitsofmeasure.org" },
    modifierExtension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count", valueInteger: 2 }],
    step: [{ component: [{ ...quantity(), extension: [note], timing: { event: events } }] },
      { component: [{ ...quantity(2), extension: [note], timing: { repeat: { count: 1, when: [EventTiming.Immediate] } } }] }],
  });
  it.each(versions.flatMap(version => cycleCases.map(data => ({ version, ...data }))))(
    "completes explicit events within the owning cycle: $name ($version)", data => {
      const input = r6Wire(cycleInstruction(data.events), data.version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 8 })).toEqual(data.expected);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 21, durationUnit: Unit.Day }).totalUnits).toBe(data.total);
      const saved = reopened(input);
      expect(saved.step![0].component[0].timing?.event).toEqual(data.events);
      expect(saved.step![0].component[0].extension).toContainEqual(note);
      expect(saved.step![1].component[0].doseAndRate![0].doseQuantity?.value).toBe(2);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("does not borrow a future partial event to block a completed earlier cycle (%s)", version => {
    const input = r6Wire(cycleInstruction(["2026-01-02T09:00:00Z", "2026-02"]), version), before = JSON.stringify(input);
    expect(nextDueDoses(input, { ...options, limit: 2 })).toEqual([
      "2026-01-02T09:00:00+00:00", "2026-01-02T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(3);
    expect(reopened(input).step![0].component[0].timing?.event).toEqual(["2026-01-02T09:00:00Z", "2026-02"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("keeps the predecessor-end floor when a dependent track gains only an end bound (%s)", version => {
    for (const bounded of [false, true]) {
      const source = persist(parseSig("1 drop OD daily at 08:00 for 3 doses, then 2 drops OD daily at 08:00; 1 drop OS BID").fhirNext);
      const rows = source.step![0].component;
      delete rows[0].timing!.repeat!.count;
      rows[0].timing!.repeat!.boundsPeriod = { end: "2026-01-01" };
      if (bounded) rows[1].timing!.repeat!.boundsPeriod = { end: "2026-01-03" };
      for (const row of rows) row.extension = [...(row.extension ?? []), note];
      const input = r6Wire(source, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, { ...options, limit: 4 })).toEqual([
        "2026-01-01T08:00:00+00:00", "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00", "2026-01-02T08:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(3);
      const after = { ...options, from: "2026-01-04T00:00:00Z" };
      expect(calculateTotalUnits({ dosage: input, ...after, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(bounded ? 2 : 4);
      const saved = reopened(input).step![0].component;
      expect(saved[0].timing?.repeat?.boundsPeriod).toEqual({ end: "2026-01-01" });
      expect(saved[1].timing?.repeat?.boundsPeriod).toEqual(bounded ? { end: "2026-01-03" } : undefined);
      expect(saved.every(row => row.extension?.some(entry => entry.url === note.url && entry.valueString === note.valueString))).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});

describe("round58 execution phase ownership and local clocks", () => {
  const versions = ["native", "r5", "r6"] as const;
  const persist = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const wire = (course: CanonicalCourse, version: typeof versions[number]) =>
    version === "native" ? course : version === "r5" ? persist(courseToR5(course)) : persist(courseToR6(course));
  const note = { url: "urn:clinic:round58-execution-note", valueString: "retain the independent source annotation" };
  const freshWire = (course: CanonicalCourse, version: typeof versions[number]) => {
    const input = wire(course, version);
    if (version !== "native") {
      const rows = Array.isArray(input) ? input : (input as FhirR6DosageInstruction).step!.flatMap(step => step.component);
      rows[0].extension = [...(rows[0].extension ?? []), note];
    }
    return input;
  };
  const allMembers = (input: Parameters<typeof importCanonicalCourse>[0]) =>
    importCanonicalCourse(input).stages.flatMap(stage => stage.administrations);
  const save = (input: ReturnType<typeof wire>) => persist(toDosageDetails(persist(
    Array.isArray(input) ? input : "kind" in input ? courseToR5(input) : toFhirR5Dosages(input)
  )));
  const immediateOptions = { from: "2026-01-01T12:00:00Z", orderedAt: "2026-01-01T12:00:00Z",
    timeZone: "UTC", eventClock: { NIGHT: "22:00" }, limit: 12 };

  it.each(versions)("keeps a recurring nightly phase after its immediate administration (%s)", version => {
    const text = "Take 1 tablet now and nightly for 3 days then take 2 tablets nightly for 2 days";
    const parsed = parseSig(text);
    const input = freshWire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
      "2026-01-03T22:00:00+00:00", "2026-01-04T22:00:00+00:00", "2026-01-05T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(8);
    expect(allMembers(input)[0].schedule!.recurrence).toMatchObject({
      anchors: [EventTiming.Immediate, EventTiming.Night],
      courseLength: { value: 3, ...(version === "native" ? { unit: "d" } : { unit: "days", code: "d" }) },
    });
    const reopened = save(input);
    expect(allMembers(reopened)[0].schedule!.recurrence!.anchors).toEqual([EventTiming.Immediate, EventTiming.Night]);
    if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("does not infer one completion from an immediate anchor beside an explicit clock (%s)", version => {
    const first = dose();
    first.schedule!.recurrence = { anchors: [EventTiming.Immediate], clocks: ["22:00:00"],
      courseLength: { value: 3, unit: "d" } };
    const second = dose(2);
    second.schedule!.recurrence = { anchors: [EventTiming.Night], courseLength: { value: 2, unit: "d" } };
    const input = freshWire({ kind: "course", stages: [{ administrations: [first] }, { administrations: [second] }] }, version);
    const before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
      "2026-01-03T22:00:00+00:00", "2026-01-04T22:00:00+00:00", "2026-01-05T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(8);
    expect(allMembers(save(input))[0].schedule!.recurrence!.clocks).toEqual(["22:00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains immediate-only and explicitly counted phase completion (%s)", version => {
    const immediate = freshWire(parseSig("Take 1 tablet now then take 2 tablets nightly for 2 days").meta.canonical.course!, version);
    expect(nextDueDoses(immediate, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T22:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: immediate, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(5);
    const first = dose();
    first.schedule!.recurrence = { count: 2, anchors: [EventTiming.Immediate, EventTiming.Night],
      courseLength: { value: 3, unit: "d" } };
    const second = dose(2);
    second.schedule!.recurrence = { clocks: ["09:00:00"], courseLength: { value: 2, unit: "d" } };
    const counted = freshWire({ kind: "course", stages: [{ administrations: [first] }, { administrations: [second] }] }, version);
    const before = JSON.stringify(counted);
    expect(nextDueDoses(counted, immediateOptions)).toEqual([
      "2026-01-01T12:00:00+00:00", "2026-01-01T22:00:00+00:00", "2026-01-02T09:00:00+00:00", "2026-01-03T09:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage: counted, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(6);
    expect(allMembers(save(counted))[0].schedule!.recurrence!.count).toBe(2);
    expect(JSON.stringify(counted)).toBe(before);
  });

  const parallelAt = (onset: number) => {
    // Existing typed compiler input: parse fresh clauses, then construct a new
    // independent elapsed-onset value before its first compiler submission.
    const text = "1 drop OD QID for 28 days then 1 drop OD BID for 7 days; 1 drop OS QID for 28 days";
    const plan = createBoundaryPlan(text), states = plan.segments.map(segment => parseClauseState(segment.text));
    const graph = buildRegimenGraph(plan, plan.segments);
    scopeSequentialPhaseSemantics(states, plan.segments, graph, text);
    const clauses = persist(states.map(state => state.primaryClause));
    clauses[1].schedule!.treatmentStartOffsetDays = onset;
    const parallel = buildCanonicalParallelRegimen(clauses, plan.segments, plan, graph);
    const projected = projectParallelRegimen(parallel, plan.segments.map(segment => segment.text), text);
    const course = projected.kind === "resolved" ? projected.canonical
      : parallel.kind === "unresolved" ? courseFromPartialParallel(parallel, plan.segments.map(segment => segment.text), text)
        : undefined;
    if (!course) throw new Error("Expected the independent typed parallel tracks");
    return { parallel, course };
  };
  it("retains both phases as partial when same-track onsets cannot establish a forward replacement", () => {
    const { parallel, course } = parallelAt(0);
    expect(parallel.kind).toBe("unresolved");
    const rows = course.stages.flatMap(stage => stage.administrations);
    expect(rows.filter(member => member.target?.text === "right eye").map(member => ({
      frequency: member.schedule?.recurrence?.frequency,
      duration: member.schedule?.recurrence?.courseLength?.value,
    }))).toEqual([{ frequency: 4, duration: 28 }, { frequency: 2, duration: 7 }]);
    expect(courseToR6(course).step!.flatMap(step => step.component).filter(component =>
      component.site?.concept?.text === "right eye")).toHaveLength(2);
  });

  it.each(versions.flatMap(version => [14, 35].map(onset => ({ version, onset }))))(
    "retains the same-track successor at day $onset with the other eye independent ($version)", ({ version, onset }) => {
      const { parallel, course } = parallelAt(onset);
      if (onset === 14) expect(parallel.kind).toBe("resolved");
      const input = freshWire(course, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-15T00:00:00Z", limit: 6 };
      if (onset === 14) expect(nextDueDoses(input, query)).toEqual([
        "2026-01-15T08:00:00+00:00", "2026-01-15T08:00:00+00:00", "2026-01-15T12:00:00+00:00",
        "2026-01-15T16:00:00+00:00", "2026-01-15T20:00:00+00:00", "2026-01-15T20:00:00+00:00",
      ]);
      else expect(nextDueDoses(input, { ...query, from: "2026-01-29T00:00:00Z", limit: 2 })).toEqual([
        "2026-02-05T08:00:00+00:00", "2026-02-05T20:00:00+00:00",
      ]);
      expect(calculateTotalUnits({ dosage: input, ...options, durationValue: 42, durationUnit: Unit.Day }).totalUnits)
        .toBe(onset === 14 ? 182 : 238);
      if (onset === 35)
        expect(calculateTotalUnits({ dosage: input, ...options, from: "2026-01-29T00:00:00Z",
          durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(0);
      const members = allMembers(save(input));
      const old = members.find(member => member.target?.text === "right eye" && member.schedule?.recurrence?.frequency === 4);
      const successor = members.find(member => member.target?.text === "right eye" && member.schedule?.recurrence?.frequency === 2);
      expect(old?.schedule?.recurrence?.courseLength).toMatchObject({ value: 28, code: "d" });
      expect(successor?.schedule?.recurrence?.courseLength).toMatchObject({ value: 7, code: "d" });
      expect(successor?.phaseOrigin).toMatchObject({ value: onset, unit: "d" });
      expect(JSON.stringify(input)).toBe(before);
    });

  const clockCases = ["calendar-end", "elapsed-origin", "elapsed-end", "day-start"] as const;
  it.each(versions.flatMap(version => clockCases.map(kind => ({ version, kind }))))(
    "uses the logical or elapsed phase clock across a spring gap ($kind/$version)", ({ version, kind }) => {
      const first = dose(); first.schedule!.recurrence!.clocks = ["12:00:00"];
      first.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      const second = dose(2); second.schedule!.recurrence = {
        frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["01:00:00", "03:00:00"], courseLength: { value: 1, unit: "d" },
      };
      const course: CanonicalCourse = { kind: "course", stages: [
        { ...(kind === "elapsed-origin" ? { start: relative(2, "h") }
          : { end: kind === "day-start" ? { anchor: "treatment-day-start" as const, displacement: { value: 1, unit: "d" } }
            : relative(kind === "elapsed-end" ? 24 : 1, kind === "elapsed-end" ? "h" : "d") }),
          administrations: [first] },
        { administrations: [second] },
      ] };
      const anchor = kind === "elapsed-origin" ? "2026-03-07T00:30:00-05:00" : "2026-03-07T02:30:00-05:00";
      const query = { from: anchor, orderedAt: anchor, timeZone: "America/New_York", limit: 12 };
      const input = freshWire(course, version), before = JSON.stringify(input);
      const expected = kind === "day-start" ? [
        "2026-03-07T12:00:00-05:00", "2026-03-08T01:00:00-05:00", "2026-03-08T03:00:00-04:00",
      ] : kind === "elapsed-end" ? [
        "2026-03-07T12:00:00-05:00", "2026-03-09T01:00:00-04:00", "2026-03-09T03:00:00-04:00",
      ] : ["2026-03-07T12:00:00-05:00", "2026-03-09T01:00:00-04:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 3, durationUnit: Unit.Day }).totalUnits)
        .toBe(kind === "day-start" || kind === "elapsed-end" ? 5 : 3);
      expect(nextDueDoses(save(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions.flatMap(version => ["clock", "meal-offset"].map(anchor => ({ version, anchor }))))(
    "inherits cadence without another phase's anchor inside a local event window ($anchor/$version)", ({ version, anchor }) => {
      const timing = anchor === "clock" ? "daily at 16:00" : "daily 30 minutes before breakfast";
      const text = `Take 1 tablet ${timing} for 2 days then take 2 tablets from day 4 while awake`;
      const parsed = parseSig(text), schedule = parsed.meta.canonical.clauses[1].schedule!;
      expect(schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: Unit.Day,
        treatmentStartOffsetDays: 3, eventWindow: { start: "WAKE", end: "HS" } });
      expect(schedule.timeOfDay).toBeUndefined(); expect(schedule.when).toBeUndefined();
      expect(schedule.offset).toBeUndefined(); expect(schedule.offsetMin).toBeUndefined(); expect(schedule.offsetMax).toBeUndefined();
      const input = freshWire(parsed.meta.canonical.course!, version), before = JSON.stringify(input);
      const query = { ...options, from: "2026-01-04T00:00:00Z", eventClock: { WAKE: "08:00", HS: "20:00", CM: "09:30" }, limit: 1 };
      expect(nextDueDoses(input, query)).toEqual(["2026-01-04T09:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(2);
      const reopened = allMembers(save(input))[1].schedule!.recurrence!;
      expect(reopened.eventWindow).toEqual({ start: "WAKE", end: "HS" });
      expect(reopened.clocks).toBeUndefined(); expect(reopened.anchors).toBeUndefined(); expect(reopened.offset).toBeUndefined();
      const noLocalWindow = parseSig(`Take 1 tablet ${timing} for 2 days then take 2 tablets from day 4`);
      const inherited = noLocalWindow.meta.canonical.clauses[1].schedule!;
      if (anchor === "clock") expect(inherited.timeOfDay).toEqual(["16:00:00"]);
      else expect(inherited).toMatchObject({ when: [EventTiming["Before Breakfast"]], offset: 30 });
      expect(JSON.stringify(input)).toBe(before);
    });

  it("reports unavailable Intl wall-clock parts instead of returning a wrong-zone dose", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: Unit.Day, timeOfDay: ["08:00:00"] } }, extension: [note] };
    const before = JSON.stringify(row), descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "formatToParts")!;
    Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", { ...descriptor, value: undefined });
    try {
      expect(() => nextDueDoses([row], { from: "2044-02-06T00:00:00Z", orderedAt: "2044-02-06T00:00:00Z",
        timeZone: "Asia/Bangkok", limit: 1 })).toThrow(/Intl.DateTimeFormat.*formatToParts/u);
      expect(() => calculateTotalUnits({ dosage: [row], from: "2044-02-07T00:00:00Z", orderedAt: "2044-02-07T00:00:00Z",
        timeZone: "Asia/Bangkok", durationValue: 1, durationUnit: Unit.Day })).toThrow(/Intl.DateTimeFormat.*formatToParts/u);
    } finally {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", descriptor);
    }
    expect(nextDueDoses([row], { from: "2044-02-08T00:00:00Z", orderedAt: "2044-02-08T00:00:00Z",
      timeZone: "Asia/Bangkok", limit: 1 })).toEqual(["2044-02-08T08:00:00+07:00"]);
    expect(JSON.stringify(row)).toBe(before);
  });

  const intervalDue = [
    "2026-01-01T12:00:00+00:00", "2026-01-01T20:00:00+00:00",
    "2026-01-02T04:00:00+00:00", "2026-01-02T12:00:00+00:00", "2026-01-02T20:00:00+00:00",
    "2026-01-03T04:00:00+00:00", "2026-01-03T12:00:00+00:00", "2026-01-03T20:00:00+00:00",
    "2026-01-04T04:00:00+00:00",
  ];
  it.each(versions)("executes an immediate start on the existing eight-hour cadence without double counting (%s)", version => {
    const input = freshWire(parseSig("Take 1 tablet now and every 8 hours for 3 days").meta.canonical.course!, version);
    const before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    const later = { ...immediateOptions, from: "2026-01-02T00:00:00Z" };
    expect(nextDueDoses(input, later)).toEqual(intervalDue.slice(2));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(6);
    expect(allMembers(input)[0].schedule!.recurrence).toMatchObject({
      anchors: [EventTiming.Immediate], period: 8, periodUnit: Unit.Hour,
    });
    const reopened = save(input);
    expect(nextDueDoses(reopened, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: reopened, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(6);
    if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
    const ordinary = freshWire(parseSig("Take 1 tablet every 8 hours for 3 days").meta.canonical.course!, version);
    expect(nextDueDoses(ordinary, immediateOptions)).toEqual(intervalDue);
    expect(calculateTotalUnits({ dosage: ordinary, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("counts prior interval administrations before a bounded immediate cadence (%s)", version => {
    const first = dose();
    first.schedule!.recurrence = { anchors: [EventTiming.Immediate], period: 8, periodUnit: Unit.Hour,
      count: 4, courseLength: { value: 3, unit: "d" } };
    const input = freshWire({ kind: "course", stages: [{ administrations: [first] }] }, version), before = JSON.stringify(input);
    expect(nextDueDoses(input, immediateOptions)).toEqual(intervalDue.slice(0, 4));
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(4);
    const later = { ...immediateOptions, from: "2026-01-02T00:00:00Z" };
    expect(nextDueDoses(input, later)).toEqual(intervalDue.slice(2, 4));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(2);
    const exhausted = { ...immediateOptions, from: "2026-01-02T13:00:00Z" };
    expect(nextDueDoses(input, exhausted)).toEqual([]);
    expect(calculateTotalUnits({ dosage: input, ...exhausted, durationValue: 48, durationUnit: Unit.Hour }).totalUnits).toBe(0);
    const reopened = save(input);
    expect(allMembers(reopened)[0].schedule!.recurrence!.count).toBe(4);
    expect(nextDueDoses(reopened, later)).toEqual(intervalDue.slice(2, 4));
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains the authored following phase after an immediate interval course (%s)", version => {
    const text = "Take 1 tablet now and every 8 hours for 3 days then take 2 tablets daily for 2 days";
    const input = freshWire(parseSig(text).meta.canonical.course!, version), before = JSON.stringify(input);
    const expected = [...intervalDue, "2026-01-05T09:00:00+00:00", "2026-01-06T09:00:00+00:00"];
    expect(nextDueDoses(input, immediateOptions)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 72, durationUnit: Unit.Hour }).totalUnits).toBe(9);
    expect(calculateTotalUnits({ dosage: input, ...immediateOptions, durationValue: 6, durationUnit: Unit.Day }).totalUnits).toBe(13);
    expect(nextDueDoses(save(input), immediateOptions)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => ["start", "predecessor-end"].map(kind => ({ version, kind }))))(
    "uses an explicit treatment calendar boundary after an elapsed predecessor ($kind/$version)", ({ version, kind }) => {
      const first = dose(); first.schedule!.recurrence!.clocks = ["12:00:00"];
      first.schedule!.recurrence!.courseLength = { value: 1, unit: "d" };
      const second = dose(2); second.schedule!.recurrence = {
        frequency: 2, period: 1, periodUnit: Unit.Day, clocks: ["01:00:00", "03:00:00"], courseLength: { value: 1, unit: "d" },
      };
      const course: CanonicalCourse = { kind: "course", stages: [
        { start: relative(2, "h"), ...(kind === "predecessor-end" ? { end: relative(2) } : {}), administrations: [first] },
        { ...(kind === "start" ? { start: relative(2) } : {}), administrations: [second] },
      ] };
      const query = { from: "2026-03-07T02:30:00-05:00", orderedAt: "2026-03-07T02:30:00-05:00",
        timeZone: "America/New_York", limit: 12 };
      const expected = ["2026-03-07T12:00:00-05:00", "2026-03-09T03:00:00-04:00", "2026-03-10T01:00:00-04:00"];
      const input = freshWire(course, version), before = JSON.stringify(input);
      expect(nextDueDoses(input, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: input, ...query, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(5);
      const reopened = save(input);
      expect(nextDueDoses(reopened, query)).toEqual(expected);
      expect(calculateTotalUnits({ dosage: reopened, ...query, durationValue: 4, durationUnit: Unit.Day }).totalUnits).toBe(5);
      if (version !== "native") expect(reopened.step![0].component[0].extension).toContainEqual(note);
      expect(JSON.stringify(input)).toBe(before);
    });
});


describe("round59 execution clinic clocks and predecessor ownership", () => {
  const versions = ["native", "r5", "r6"] as const;
  const persist = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const gts = "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation";
  const note = { url: "urn:clinic:round59-execution-note", valueString: "retain independent source data" };
  const wardRows = (frequency = 2): FhirDosage[] => [{
    extension: [note],
    timing: { code: { coding: [
      { system: "urn:clinic:timing", code: "WARD", version: "clinic-1" },
      { system: gts, code: "BID" },
    ] }, repeat: { frequency, period: 1, periodUnit: Unit.Day } },
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  }];
  const wardInput = (version: typeof versions[number], frequency = 2) => {
    const rows = wardRows(frequency);
    return version === "r5" ? rows : version === "r6" ? persist(toDosageDetails(rows)) : importCanonicalCourse(rows);
  };
  const member = (value = 1): CanonicalAdministration => ({
    kind: "administration", amounts: [{ quantity: { value, unit: "tab" } }],
    schedule: { recurrence: { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"] } },
  });
  const qodCourse = (frequency: number, bounded = false): CanonicalCourse => ({
    kind: "course", stages: [{
      ...(bounded ? { end: { anchor: "treatment-day-start" as const, displacement: { value: 28, unit: "d" } } } : {}),
      administrations: [{
        ...member(), schedule: { code: { coding: [{ system: gts, code: "QOD" }] },
          recurrence: { frequency, period: frequency * 2, periodUnit: Unit.Day } },
      }],
    }],
  });
  const predecessorCourse = (kind: "duration" | "point" | "global"): CanonicalCourse => {
    const global = member(); global.schedule!.recurrence = { count: 1, clocks: ["08:00:00"] };
    const loading = member();
    loading.sourceMember = 0; loading.phasePredecessors = []; loading.phaseOrigin = { value: 9, unit: "h" };
    loading.schedule!.recurrence = kind === "point" ? { count: 1, clocks: ["09:00:00"] }
      : { frequency: 1, period: 1, periodUnit: Unit.Day, clocks: ["09:00:00"], courseLength: { value: 2, unit: "h" } };
    const next = member(2); next.schedule!.recurrence = { frequency: 1, period: 4, periodUnit: Unit.Hour, count: 2 };
    if (kind !== "global") { next.sourceMember = 1; next.phasePredecessors = [0]; }
    return { kind: "course", stages: [{ administrations: [global] },
      { administrations: kind === "global" ? [next] : [loading, next] }] };
  };
  const weekdayCourse = (explicit = false): CanonicalCourse => ({
    kind: "course", stages: [{ administrations: [{ ...member(), schedule: { recurrence: {
      dayOfWeek: [FhirDayOfWeek.Monday], frequency: 1, period: 1, periodUnit: Unit.Week, count: 2,
      ...(explicit ? { clocks: ["09:00:00"] } : {}),
    } } }] }],
  });
  const wire = (course: CanonicalCourse, version: typeof versions[number]) => {
    if (version === "native") return course;
    const input = persist(version === "r5" ? courseToR5(course) : courseToR6(course));
    const rows = Array.isArray(input) ? input : input.step!.flatMap(step => step.component);
    rows[0].extension = [...(rows[0].extension ?? []), note];
    return input;
  };
  const save = (input: Parameters<typeof importCanonicalCourse>[0]) => persist(toDosageDetails(
    persist(toFhirR5Dosages(input))
  ));
  const query = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z", timeZone: "UTC", limit: 4 };
  const qodQuery = { ...query, from: "2026-01-01T12:00:00Z", orderedAt: "2026-01-01T12:00:00Z",
    limit: 16, frequencyDefaults: { byCode: { QOD: ["09:00"] } } };
  const qodDue = [
    "2026-01-03T09:00:00+00:00", "2026-01-05T09:00:00+00:00", "2026-01-07T09:00:00+00:00",
    "2026-01-09T09:00:00+00:00", "2026-01-11T09:00:00+00:00", "2026-01-13T09:00:00+00:00",
    "2026-01-15T09:00:00+00:00", "2026-01-17T09:00:00+00:00", "2026-01-19T09:00:00+00:00",
    "2026-01-21T09:00:00+00:00", "2026-01-23T09:00:00+00:00", "2026-01-25T09:00:00+00:00",
    "2026-01-27T09:00:00+00:00", "2026-01-29T09:00:00+00:00", "2026-01-31T09:00:00+00:00",
    "2026-02-02T09:00:00+00:00",
  ];

  it.each(versions)("uses compatible local clinic clocks while the standard coding owns cadence (%s)", version => {
    const input = wardInput(version), before = JSON.stringify(input);
    const local = { ...query, limit: 2, frequencyDefaults: { byCode: { WARD: ["07:00", "19:00"] } } };
    expect(nextDueDoses(input, local)).toEqual(["2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00"]);
    expect(calculateTotalUnits({ dosage: input, ...local, durationValue: 7.5, durationUnit: Unit.Hour }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...local, frequencyDefaults: { byCode: {
      WARD: ["07:00", "19:00"], BID: ["07:30", "19:30"],
    } } })).toEqual(["2026-01-01T07:30:00+00:00", "2026-01-01T19:30:00+00:00"]);
    for (const frequencyDefaults of [{}, { byCode: { WARD: ["07:00"] } }])
      expect(nextDueDoses(input, { ...query, limit: 2, frequencyDefaults }))
        .toEqual(["2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00"]);
    const reopened = save(input);
    expect(importCanonicalCourse(reopened).stages[0].administrations[0].schedule!.code!.coding)
      .toEqual(wardRows()[0].timing!.code!.coding);
    expect(nextDueDoses(reopened, local)).toEqual(["2026-01-01T07:00:00+00:00", "2026-01-01T19:00:00+00:00"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions)("retains the existing explicit cadence conflict beside a local clock mapping (%s)", version => {
    const input = wardInput(version, 3), before = JSON.stringify(input);
    const live = { ...query, limit: 3, frequencyDefaults: { byCode: { WARD: ["07:00", "19:00"] } } };
    expect(() => nextDueDoses(input, live)).toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    expect(() => calculateTotalUnits({ dosage: input, ...live, durationValue: 1, durationUnit: Unit.Day }))
      .toThrow(expect.objectContaining({ code: "timing-code-repeat-conflict" }));
    const current = importCanonicalCourse(save(input)).stages[0].administrations[0].schedule!;
    expect(current.recurrence).toMatchObject({ frequency: 3, period: 1, periodUnit: Unit.Day });
    expect(current.code!.coding).toEqual(wardRows()[0].timing!.code!.coding);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => [7, 14].map(frequency => ({ version, frequency }))))(
    "keeps every later alternate-day clinic slot in an aggregate QOD repeat ($frequency/$version)", ({ version, frequency }) => {
      const input = wire(qodCourse(frequency), version), before = JSON.stringify(input);
      expect(nextDueDoses(input, qodQuery)).toEqual(qodDue);
      const later = { ...qodQuery, from: "2026-01-15T00:00:00Z" };
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 14, durationUnit: Unit.Day }).totalUnits).toBe(7);
      expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 10, durationUnit: Unit.Hour }).totalUnits).toBe(1);
      expect(nextDueDoses(wire(qodCourse(1), version), qodQuery)).toEqual(qodDue);
      const reopened = save(input), recurrence = importCanonicalCourse(reopened).stages[0].administrations[0].schedule!.recurrence!;
      expect(recurrence).toMatchObject({ frequency, period: frequency * 2, periodUnit: Unit.Day });
      expect(nextDueDoses(reopened, qodQuery)).toEqual(qodDue);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("retains the exclusive course end and post-order lower bound for aggregate QOD (%s)", version => {
    const input = wire(qodCourse(7, true), version), before = JSON.stringify(input);
    expect(nextDueDoses(input, qodQuery)).toEqual(qodDue.slice(0, 13));
    expect(calculateTotalUnits({ dosage: input, ...qodQuery, durationValue: 40, durationUnit: Unit.Day }).totalUnits).toBe(13);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(versions.flatMap(version => (["duration", "point", "global"] as const).map(kind => ({ version, kind }))))(
    "uses the owned predecessor boundary before the global point ($kind/$version)", ({ version, kind }) => {
      const input = wire(predecessorCourse(kind), version), before = JSON.stringify(input);
      const expected = kind === "duration"
        ? ["2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T11:00:00+00:00", "2026-01-01T15:00:00+00:00"]
        : kind === "point"
          ? ["2026-01-01T08:00:00+00:00", "2026-01-01T09:00:00+00:00", "2026-01-01T13:00:00+00:00", "2026-01-01T17:00:00+00:00"]
          : ["2026-01-01T08:00:00+00:00", "2026-01-01T12:00:00+00:00", "2026-01-01T16:00:00+00:00"];
      expect(nextDueDoses(input, query)).toEqual(expected);
      const from = kind === "duration" ? "2026-01-01T11:00:00Z" : kind === "point" ? "2026-01-01T13:00:00Z" : "2026-01-01T12:00:00Z";
      expect(calculateTotalUnits({ dosage: input, ...query, from, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(2);
      expect(nextDueDoses(save(input), query)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(before);
    });

  it.each(versions)("keeps order milliseconds through clockless weekday schedule, supply and historical counting (%s)", version => {
    const input = wire(weekdayCourse(), version), before = JSON.stringify(input);
    const order = { ...query, from: "2026-01-05T09:00:00.500Z", orderedAt: "2026-01-05T09:00:00.500Z" };
    const expected = ["2026-01-05T09:00:00.500+00:00", "2026-01-12T09:00:00.500+00:00"];
    expect(nextDueDoses(input, order)).toEqual(expected);
    expect(calculateTotalUnits({ dosage: input, ...order, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    const later = { ...order, from: "2026-01-12T09:00:00.500Z" };
    expect(nextDueDoses(input, later)).toEqual(expected.slice(1));
    expect(calculateTotalUnits({ dosage: input, ...later, durationValue: 1, durationUnit: Unit.Day }).totalUnits).toBe(1);
    expect(nextDueDoses(input, { ...later, priorDoseTimes: [expected[0]] })).toEqual(expected.slice(1));
    expect(nextDueDoses(input, { ...order, from: "2026-01-19T09:00:00.500Z" })).toEqual([]);
    const whole = { ...order, from: "2026-01-05T09:00:00Z", orderedAt: "2026-01-05T09:00:00Z" };
    expect(nextDueDoses(wire(weekdayCourse(), version), whole)).toEqual([
      "2026-01-05T09:00:00+00:00", "2026-01-12T09:00:00+00:00",
    ]);
    expect(nextDueDoses(wire(weekdayCourse(true), version), order)).toEqual([
      "2026-01-12T09:00:00+00:00", "2026-01-19T09:00:00+00:00",
    ]);
    expect(nextDueDoses(save(input), order)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });
});
}

describe("round79 dated clock replacement retains earlier-starting doses", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([[false, "UTC", "+00:00"], [true, "UTC", "+00:00"],
    [false, "Asia/Bangkok", "+07:00"], [true, "Asia/Bangkok", "+07:00"]] as const)(
    "uses the authored replacement clock after an earlier start (independent=%s, zone=%s)",
    (independent, timeZone, offset) => {
      const parsed = parseSig("Instill 1 drop OD at 08:00 and 20:00 daily starting 2026-12-04, then starting 2026-12-05 at 18:00 instill 2 drops OD daily" +
        (independent ? "; instill 1 drop OS daily at 10:00 starting 2026-12-05" : ""));
      const before = JSON.stringify(parsed);
      const query = { orderedAt: "2026-12-04T00:00:00" + offset,
        from: "2026-12-05T00:00:00" + offset, timeZone, limit: 3 };
      const expected = (independent
        ? ["2026-12-05T08:00:00", "2026-12-05T10:00:00", "2026-12-05T18:00:00"]
        : ["2026-12-05T08:00:00", "2026-12-05T18:00:00", "2026-12-06T18:00:00"])
        .map(time => time + offset);
      for (const dosage of [parsed, parsed.meta.canonical.course!, fresh(parsed.fhir),
        fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
        expect(nextDueDoses(dosage, query)).toEqual(expected);
        const priorDay = { ...query, from: "2026-12-04T00:00:00" + offset, limit: 2 };
        expect(nextDueDoses(dosage, priorDay)).toEqual([
          "2026-12-04T08:00:00" + offset, "2026-12-04T20:00:00" + offset,
        ]);
        expect(calculateTotalUnits({ dosage, ...priorDay, durationValue: 1, durationUnit: "d" }))
          .toMatchObject({ totalUnits: 2, unit: "drop" });
        for (const [clock, amount] of [["08:00:00", 1], ["18:00:00", 2]] as const)
          expect(calculateTotalUnits({ dosage, ...query, from: "2026-12-05T" + clock + offset,
            durationValue: 1, durationUnit: "h" })).toMatchObject({ totalUnits: amount, unit: "drop" });
        expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }))
          .toMatchObject({ totalUnits: independent ? 4 : 3, unit: "drop" });
      }
      expect(JSON.stringify(parsed)).toBe(before);
    });
});


it.each([false, true])("round79 dated clock replacement retains an undated predecessor's actual origin (independent=%s)", independent => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const parsed = parseSig("Instill 1 drop OD at 08:00 and 20:00 daily, then starting 2026-12-05 at 18:00 instill 2 drops OD daily" +
    (independent ? "; instill 1 drop OS daily at 10:00 starting 2026-12-05" : ""));
  const before = JSON.stringify(parsed);
  const query = { orderedAt: "2026-12-04T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 4 };
  const expected = independent
    ? ["2026-12-05T08:00:00+00:00", "2026-12-05T10:00:00+00:00", "2026-12-05T18:00:00+00:00", "2026-12-06T10:00:00+00:00"]
    : ["2026-12-05T08:00:00+00:00", "2026-12-05T18:00:00+00:00", "2026-12-06T18:00:00+00:00", "2026-12-07T18:00:00+00:00"];
  for (const dosage of [parsed, parsed.meta.canonical.course!, fresh(parsed.fhir),
    fresh(parsed.fhirNext), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
    expect(nextDueDoses(dosage, query)).toEqual(expected);
    const priorDay = { ...query, from: "2026-12-04T00:00:00Z", limit: 2 };
    expect(nextDueDoses(dosage, priorDay)).toEqual([
      "2026-12-04T08:00:00+00:00", "2026-12-04T20:00:00+00:00",
    ]);
    expect(calculateTotalUnits({ dosage, ...priorDay, durationValue: 1, durationUnit: "d" }))
      .toMatchObject({ totalUnits: 2, unit: "drop" });
    for (const [clock, amount] of [["08:00:00", 1], ["18:00:00", 2]] as const)
      expect(calculateTotalUnits({ dosage, ...query, from: "2026-12-05T" + clock + "Z",
        durationValue: 1, durationUnit: "h" })).toMatchObject({ totalUnits: amount, unit: "drop" });
    expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }))
      .toMatchObject({ totalUnits: independent ? 4 : 3, unit: "drop" });
  }
  expect(parsed.meta.canonical.course!.stages[0].administrations[0].schedule?.recurrence?.calendarWindow?.start)
    .toBeUndefined();
  expect(JSON.stringify(parsed)).toBe(before);
});


describe("dated replacement with several target members", () => {
  it.each([false, true])("keeps the morning predecessor before the evening replacement (%s)", independent => {
    const parsed = parseSig("From 4 December 2026, instill 1 drop in both eyes daily at 08:00, then from 5 December 2026 instill 2 drops in the right eye and 1 drop in the left eye daily at 20:00" + (independent ? "; instill 1 drop OS daily at 10:00 starting 2026-12-05" : ""));
    const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
    const query = { orderedAt: "2026-12-04T00:00:00Z", from: "2026-12-05T00:00:00Z", timeZone: "UTC", limit: 4 };
    for (const dosage of [parsed, parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, query)).toEqual(independent ? [
        "2026-12-05T08:00:00+00:00", "2026-12-05T10:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-05T20:00:00+00:00"] : [
        "2026-12-05T08:00:00+00:00", "2026-12-05T20:00:00+00:00",
        "2026-12-05T20:00:00+00:00", "2026-12-06T20:00:00+00:00"]);
      expect(calculateTotalUnits({ dosage, ...query, durationValue: 1, durationUnit: "d" }))
        .toMatchObject({ totalUnits: independent ? 6 : 5, unit: "drop" });
    }
  });
});


describe("ordinary authored phase continuation ownership", () => {
  const options = { orderedAt: "2027-01-01T00:00:00Z", from: "2027-01-01T00:00:00Z", timeZone: "UTC" };
  const forms = (parsed: ReturnType<typeof parseSig>) => [parsed, parsed.meta.canonical.course!,
    parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext))) as FhirDosage[]];

  it("keeps a delayed parallel phase open for its complete authored duration", () => {
    const source = "Instill 1 drop OD in 6 hours every 6 hours for 1 day, then instill 2 drops OD every 6 hours; instill 1 drop OS daily at 09:00";
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0].schedule?.administrationOffsetMinutes).toBe(360);
    for (const dosage of forms(parsed)) {
      expect(nextDueDoses(dosage, { ...options, limit: 5 })).toEqual([
        "2027-01-01T06:00:00+00:00", "2027-01-01T09:00:00+00:00",
        "2027-01-01T12:00:00+00:00", "2027-01-01T18:00:00+00:00", "2027-01-02T00:00:00+00:00"
      ]);
      // The delayed one-day phase still owns midnight; its two-drop successor opens at 06:00.
      for (const [from, total] of [["2027-01-02T00:00:00Z", 1], ["2027-01-02T06:00:00Z", 2]] as const)
        expect(calculateTotalUnits({ dosage, ...options, from, durationValue: 1, durationUnit: Unit.Hour }).totalUnits).toBe(total);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("completes an initial single clock before a recurring earlier-clock successor", () => {
    const parsed = parseSig("Take 1 tablet at 22:00, then 2 tablets daily at 06:00 for 5 days");
    expect(parsed.meta.canonical.clauses[0].schedule?.count).toBe(1);
    for (const dosage of forms(parsed)) {
      expect(nextDueDoses(dosage, { ...options, limit: 8 })).toEqual([
        "2027-01-01T22:00:00+00:00", "2027-01-02T06:00:00+00:00", "2027-01-03T06:00:00+00:00",
        "2027-01-04T06:00:00+00:00", "2027-01-05T06:00:00+00:00", "2027-01-06T06:00:00+00:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: Unit.Day }).totalUnits).toBe(11);
    }
    const recurring = parseSig("Take 1 tablet daily at 22:00, then 2 tablets daily at 06:00 for 5 days");
    expect(recurring.meta.canonical.clauses[0].schedule?.count).toBeUndefined();
    expect(nextDueDoses(recurring, { ...options, limit: 2 })).toEqual([
      "2027-01-01T22:00:00+00:00", "2027-01-02T22:00:00+00:00"
    ]);
  });

  it("inherits an activity-qualified schedule at an explicit later course day", () => {
    const parsed = parseSig("Take 1 tablet 30 minutes before exercise for 7 days, then 2 tablets from day 8");
    const first = parsed.meta.canonical.clauses[0].schedule!;
    const next = parsed.meta.canonical.clauses[1].schedule!;
    expect(next.activityTiming).toEqual(first.activityTiming);
    expect(next.activityTiming?.[0]).toMatchObject({ relation: "before", offset: 30, activity: { text: "exercise" } });
    expect(next.treatmentStartOffsetDays).toBe(7);
    expect(next.duration).toBeUndefined();
    for (const input of [parsed.meta.canonical.course!, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const member = importCanonicalCourse(input).stages[1].administrations[0];
      expect(member.schedule?.recurrence?.activityTiming).toMatchObject([{ relation: "before", offset: 30,
        activity: { text: "exercise", coding: { code: "256235009" } } }]);
      expect(member.amounts?.[0].quantity).toMatchObject({ value: 2, unit: "tab" });
    }
  });
});
