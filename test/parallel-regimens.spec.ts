import { describe, expect, it } from "vitest";
import {
  parseSig, parseSigAsync, lintSig, nextDueDoses, calculateTotalUnits,
  toDosageDetails, toFhirR5Dosages, fromFhir, fromFhirDosage, getDosageCondition
} from "../src";
import { createBoundaryPlan } from "../src/regimen/planner";
import { shiftCanonicalSigClauses } from "../src/ir";
import { parseClauseState } from "../src/parser";
import {
  buildCanonicalParallelRegimen
} from "../src/regimen/parallel-course";
import {
  buildRegimenGraph, scopeSequentialPhaseSemantics, expandRegimenAdjustmentPhases
} from "../src/regimen/regimen";

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
    expect(regimen.stages.flatMap(stage => stage.components)
      .every(component => component.clause.schedule?.duration === undefined)).toBe(true);
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
      boundsEnd: "2026-10-31",
      duration: 7,
      durationUnit: "d"
    });
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
