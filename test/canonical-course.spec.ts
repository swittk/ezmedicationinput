/** Independent architectural/clinical oracles for the native course boundary.
 * These cases exercise canonical edits, not only adapter self-roundtrips. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { courseFromR6, courseToR6, courseToR5, inputToCanonical } from "../src/adapters/canonical-course";
import { calculateTotalUnits as nativeSupply } from "../src/execution/engine";
import {
  nextDueDoses,
  calculateTotalUnits,
  parseSig,
  fromFhir,
  formatSig,
  editCanonicalCourse,
  projectCanonicalCourse,
} from "../src/index";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import {
  TIMING_DAY_OF_MONTH_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
} from "../src/fhir";
import { cloneStructuredValue } from "../src/stable-structure";
import type { FhirR6DosageInstruction } from "../src/types";

const source: FhirR6DosageInstruction = {
  id: "native-course",
  extension: [{ url: "urn:test:opaque-course", valueString: "retained" }],
  step: [
    {
      id: "s1",
      component: [
        {
          id: "dose-a",
          extension: [{ url: "urn:test:opaque-dose", valueString: "untouched" }],
          site: {
            id: "site-wrapper",
            concept: { text: "left eye", coding: [{ system: "urn:anatomy", code: "left", version: "7" }] },
            reference: { reference: "BodyStructure/left" },
            extension: [{ url: "urn:site:extra", valueString: "kept" }],
          },
          doseAndRate: [
            {
              id: "amount-a",
              doseQuantity: { value: 1, unit: "tab", system: "http://unitsofmeasure.org", code: "{tbl}" },
            },
          ],
          timing: {
            repeat: {
              frequency: 1,
              period: 1,
              periodUnit: "d",
              timeOfDay: ["08:00:00"],
              boundsDuration: { value: 3, unit: "d", code: "d" },
            },
          },
        },
      ],
    },
  ],
};
const options = {
  orderedAt: "2026-11-02T00:00:00+07:00",
  from: "2026-11-02T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8,
  durationValue: 3,
  durationUnit: "d" as const,
};

describe("canonical course architecture", () => {
  it("the execution kernel and clinical compiler do not import FHIR adapters or inspect wire markers", () => {
    for (const name of [
      "../src/execution/engine.ts",
      "../src/canonical/compile.ts",
      "../src/canonical/format-course.ts",
    ]) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*(?:dosage-course|adapters\/|\/fhir(?:["']|\.))/u);
      expect(text).not.toMatch(
        /\b(?:toFhirR5Dosages|fromR6Dosage|toDosageDetails|modifierExtension)\s*(?:\(|\?\.|\.)/u
      );
    }
  });
  it("the original public scheduling file is only an input adapter, not a second engine", () => {
    const text = readFileSync(new URL("../src/schedule.ts", import.meta.url), "utf8");
    expect(text).toContain("inputToCanonical");
    expect(text).toContain('from "./execution/engine"');
    expect(text).not.toMatch(/function (?:treatmentStepWindow|calculateCourseTotalUnits|scheduleRegimen)/u);
  });
  it("parser owns a native course before projecting either FHIR version", () => {
    const parsed = parseSig("2 tabs morning, 1 tab evening for 1 week, then 1 tab morning for 1 week");
    const native = parsed.meta.canonical.course!;
    expect(native.kind).toBe("course");
    expect(native.stages.map((s) => s.administrations.length)).toEqual([2, 1]);
    expect(native.stages[0].administrations.map((a) => a.amounts?.[0].quantity?.value)).toEqual([2, 1]);
    expect(inputToCanonical(parsed)).toBe(native);
    for (const input of [native, parsed, parsed.fhirNext, parsed.fhir]) {
      expect(nextDueDoses(input, { ...options, limit: 3 })).toEqual([
        "2026-11-02T08:00:00+07:00",
        "2026-11-02T19:00:00+07:00",
        "2026-11-03T08:00:00+07:00",
      ]);
    }
    expect(nativeSupply({ ...options, dosage: native }).totalUnits).toBe(9);
  });
});

describe("native editable course and sibling projections", () => {
  it("preserves external element/coding metadata exactly on untouched R6 import/export", () => {
    const native = courseFromR6(source, true);
    expect(courseToR6(native)).toEqual(source);
    expect(fromFhir(source).meta.canonical.course?.kind).toBe("course");
  });
  it("native numeric and recurrence edits are independent of the source and govern BOTH projections and execution", () => {
    const original = cloneStructuredValue(source);
    const native = courseFromR6(original, true);
    const a = native.stages[0].administrations[0];
    a.amounts![0].quantity!.value = 2;
    a.schedule!.recurrence!.clocks![0] = "09:00:00";
    expect(original).toEqual(source);
    const r6 = courseToR6(native),
      r5 = courseToR5(native);
    expect(r6.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(r5[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    for (const input of [native, r6, r5]) {
      expect(nextDueDoses(input, options)).toEqual([
        "2026-11-02T09:00:00+07:00",
        "2026-11-03T09:00:00+07:00",
        "2026-11-04T09:00:00+07:00",
      ]);
      expect(calculateTotalUnits({ ...options, dosage: input }).totalUnits).toBe(6);
    }
    expect(r6.extension).toEqual(source.extension);
    expect(r6.step[0].component[0].extension).toEqual(source.step[0].component[0].extension);
    expect(r6.step[0].component[0].site?.concept?.coding?.[0].version).toBe("7");
  });
  it("clearing one target side cannot resurrect it from the retained CodeableReference wrapper", () => {
    const native = courseFromR6(source, true);
    native.stages[0].administrations[0].siteReference = undefined;
    const a = courseToR6(native).step[0].component[0];
    expect(a.site?.concept?.text).toBe("left eye");
    expect(a.site).not.toHaveProperty("reference");
    expect(a.site?.id).toBe("site-wrapper");
    expect(a.site?.extension).toEqual(source.step[0].component[0].site?.extension);
  });
  it("known maximum edits and removals govern native export without dropping unknown safety siblings", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
              safety: {
                id: "safety-source",
                ifExceeded: "contact prescriber",
                doseLimit: [
                  { id: "limit-a", scope: "administration", valueQuantity: { value: 2, unit: "tab" } },
                  {
                    id: "limit-b",
                    scope: "lifetime",
                    valueExpression: { language: "text/fhirpath", expression: "%external.total" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const native = courseFromR6(raw, true),
      a = native.stages[0].administrations[0];
    a.limits![0].amount = { value: 3, unit: "tab" };
    let out = courseToR6(native).step[0].component[0];
    expect(out.safety?.doseLimit?.[0]).toMatchObject({ id: "limit-a", valueQuantity: { value: 3 } });
    expect(out.safety?.doseLimit?.[1]).toEqual(raw.step[0].component[0].safety?.doseLimit?.[1]);
    expect(out.safety?.ifExceeded).toBe("contact prescriber");
    a.limits!.splice(0, 1);
    out = courseToR6(native).step[0].component[0];
    expect(out.safety?.doseLimit).toHaveLength(1);
    expect(out.safety?.doseLimit?.[0].id).toBe("limit-b");
  });
  it("a changed native condition becomes the structured current predicate", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              condition: [{ text: "Original guard", code: { text: "Original guard" } }],
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const c = courseFromR6(raw, true);
    c.stages[0].administrations[0].predicate = {
      kind: "measurement",
      name: "SBP",
      operation: "gt",
      value: 160,
      text: "SBP >160",
    };
    const exported = courseToR6(c);
    expect(exported.step[0].component[0].condition?.[0]).toMatchObject({
      operation: "gt",
      valueQuantity: { value: 160 },
    });
    expect(raw.step[0].component[0].condition?.[0].text).toBe("Original guard");
    c.stages[0].administrations[0].predicate = undefined;
    expect(courseToR6(c).step[0].component[0]).not.toHaveProperty("condition");
  });
});

describe("native edit display ownership", () => {
  it("clears unchanged stale derived text after a clinical edit without mutating source or changing public export names", () => {
    const parsed = parseSig("Take 1 tablet every morning for 3 days");
    const before = parsed.meta.canonical.course!;
    const edited = editCanonicalCourse(before, (draft) => {
      draft.stages[0].administrations[0].amounts![0].quantity!.value = 2;
    });
    expect(before.stages[0].administrations[0].amounts?.[0].quantity?.value).toBe(1);
    expect(before.instruction).toBe("Take 1 tablet every morning for 3 days");
    expect(edited.instruction).toBeUndefined();
    expect(formatSig(edited, "long", { locale: "en" })).toContain("2 tablets");
    const exported = projectCanonicalCourse(edited);
    expect(exported.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(exported.fhir[0].doseAndRate?.[0].doseQuantity?.value).toBe(2);
    expect(calculateTotalUnits({ ...options, dosage: edited }).totalUnits).toBe(6);
    expect(edited.stages[0].administrations[0].syntax?.rawText).toContain("1 tablet");
  });
  it("moving draft members preserves their own source identity and invalidates only the whole-course ordering text", () => {
    const native = courseFromR6(source, true);
    native.stages[0].administrations.push({
      ...cloneStructuredValue(native.stages[0].administrations[0]),
      text: "Second independent dose",
      amounts: [{ quantity: { value: 2, unit: "tab" } }],
    });
    native.instruction = "First, second";
    const edited = editCanonicalCourse(native, (draft) => draft.stages[0].administrations.reverse());
    expect(edited.instruction).toBeUndefined();
    expect(edited.stages[0].administrations[0].text).toBe("Second independent dose");
    expect(native.stages[0].administrations[0].amounts?.[0].quantity?.value).toBe(1);
  });
});

describe("native ownership of source-encoded semantics", () => {
  it("exports edited month-day membership and clears a source delay without resurrecting annotations", () => {
    const external: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              modifierExtension: [
                {
                  url: ADMINISTRATION_OFFSET_EXTENSION_URL,
                  valueQuantity: { value: 5, unit: "min", code: "min" },
                },
              ],
              timing: {
                repeat: {
                  frequency: 1,
                  period: 1,
                  periodUnit: "d",
                  timeOfDay: ["08:00:00"],
                  extension: [
                    { url: TIMING_DAY_OF_MONTH_EXTENSION_URL, valuePositiveInt: 1 },
                    { url: "urn:test:unrecognized", valueString: "retained" },
                  ],
                },
              },
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const native = courseFromR6(external, true);
    const a = native.stages[0].administrations[0];
    a.schedule!.recurrence!.monthDays = [15];
    a.delayMinutes = undefined;
    const out = courseToR6(native);
    expect(out.step[0].component[0].timing?.repeat?.extension).toContainEqual({
      url: TIMING_DAY_OF_MONTH_EXTENSION_URL,
      valuePositiveInt: 15,
    });
    expect(out.step[0].component[0].timing?.repeat?.extension).toContainEqual({
      url: "urn:test:unrecognized",
      valueString: "retained",
    });
    expect(
      out.step[0].component[0].modifierExtension?.some((e) => e.url === ADMINISTRATION_OFFSET_EXTENSION_URL)
    ).not.toBe(true);
    const request = { ...options, limit: 2 };
    expect(nextDueDoses(native, request)).toEqual(["2026-11-15T08:00:00+07:00", "2026-12-15T08:00:00+07:00"]);
    expect(nextDueDoses(out, request)).toEqual(nextDueDoses(native, request));
    expect(nextDueDoses(courseToR5(native), request)).toEqual(nextDueDoses(native, request));
    expect(external.step[0].component[0].timing?.repeat?.extension?.[0].valuePositiveInt).toBe(1);
  });
  it("a fractional native offset is one clinical field and one correct wire encoding", () => {
    const native = courseFromR6(
      {
        step: [
          {
            component: [
              {
                timing: {
                  repeat: {
                    frequency: 1,
                    period: 1,
                    periodUnit: "d",
                    when: ["MORN"],
                    extension: [{ url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: 0.5 }],
                  },
                },
                doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
              },
            ],
          },
        ],
      },
      true
    );
    const r = native.stages[0].administrations[0].schedule!.recurrence!;
    expect(r.offset).toBe(0.5);
    r.offset = 1.5;
    const out = courseToR6(native);
    expect(out.step[0].component[0].timing?.repeat?.extension).toContainEqual({
      url: TIMING_OFFSET_EXACT_EXTENSION_URL,
      valueDecimal: 1.5,
    });
    expect(courseFromR6(out).stages[0].administrations[0].schedule?.recurrence?.offset).toBe(1.5);
  });
  it("exports native target multiplicity once while retaining the source site identity", () => {
    const native = courseFromR6(source, true);
    native.stages[0].administrations[0].targetCount = 2;
    const out = courseToR6(native);
    const a = courseFromR6(out).stages[0].administrations[0];
    expect(a.targetCount).toBe(2);
    expect(out.step[0].component[0].site?.id).toBe("site-wrapper");
    expect(calculateTotalUnits({ ...options, dosage: native }).totalUnits).toBe(6);
    expect(calculateTotalUnits({ ...options, dosage: out }).totalUnits).toBe(6);
  });
});

describe("native clinical concept edits", () => {
  it("a changed native laterality does not reuse the original site labels", () => {
    const left = parseSig("1 drop left eye every morning").meta.canonical.course!;
    const right = parseSig("1 drop right eye every morning").meta.canonical.course!;
    const edited = editCanonicalCourse(left, (draft) => {
      draft.stages[0].administrations[0].target = cloneStructuredValue(
        right.stages[0].administrations[0].target
      );
    });
    const expected = projectCanonicalCourse(right).fhirNext.step[0].component[0].site?.concept;
    const actual = projectCanonicalCourse(edited).fhirNext.step[0].component[0].site?.concept;
    expect(actual?.coding?.[0].code).toBe(expected?.coding?.[0].code);
    expect(formatCanonicalCourse(edited, "long", { locale: "en" }).toLowerCase()).toContain("right eye");
    expect(formatCanonicalCourse(edited, "long", { locale: "en" }).toLowerCase()).not.toContain("left eye");
  });
  it("current native route and method codes replace their original source-context coding", () => {
    const oral = parseSig("Take 1 mL PO daily").meta.canonical.course!;
    const injection = parseSig("Inject 1 mL IM daily").meta.canonical.course!;
    const replacement = injection.stages[0].administrations[0];
    const edited = editCanonicalCourse(oral, (draft) => {
      const a = draft.stages[0].administrations[0];
      a.route = cloneStructuredValue(replacement.route);
      a.method = cloneStructuredValue(replacement.method);
    });
    const expected = projectCanonicalCourse(injection).fhirNext.step[0].component[0];
    const actual = projectCanonicalCourse(edited).fhirNext.step[0].component[0];
    expect(actual.route?.coding).toEqual(expected.route?.coding);
    expect(actual.method?.coding).toEqual(expected.method?.coding);
    expect(actual.route?.coding?.[0]?.code).not.toBe(
      projectCanonicalCourse(oral).fhirNext.step[0].component[0].route?.coding?.[0]?.code
    );
  });
});
