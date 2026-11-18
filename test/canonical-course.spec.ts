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
  it("R5 import/export are independent native adapters, never complete R6 intermediate workflows",()=>{
    const writer=readFileSync(new URL("../src/adapters/r5-course.ts",import.meta.url),"utf8");
    const reader=readFileSync(new URL("../src/adapters/r5-import.ts",import.meta.url),"utf8");
    for(const source of [writer,reader])
      expect(source).not.toMatch(/\b(?:courseToR6|projectCourseToR6|courseFromR6|administrationToR6|fromR6Dosage|toDosageDetails)\s*\(/u);
    expect(writer).toMatch(/administrationToR5\s*\(/u);
    expect(reader).toMatch(/administrationFromR5\s*\(/u);
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

describe("native course and sibling projections", () => {
  it("preserves external element/coding metadata exactly on untouched R6 import/export", () => {
    const native = courseFromR6(source, true);
    expect(courseToR6(native)).toEqual(source);
    expect(fromFhir(source).meta.canonical.course?.kind).toBe("course");
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

describe("typed external boundary anchors", () => {
  it("retains resource/event/path anchors as understood references but never guesses treatment-start execution", () => {
    const forms = [
      { contextReference: { reference: "Observation/anchor" }, anchor: "resource-reference" },
      { contextDefinition: "https://example.org/StructureDefinition/visit", anchor: "definition" },
      { contextReference: { reference: "Patient/anchor" }, contextPath: "startDate", anchor: "resource-reference" },
      { contextCode: { coding: [{ system: "urn:events", code: "trigger" }] }, anchor: "coded-event" }
    ] as const;
    for (const form of forms) {
      const { anchor, ...relative } = form;
      const input: FhirR6DosageInstruction = {
        step: [{ start: { ...relative, offsetDuration: { value: 2, unit: "d", code: "d" } },
          component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } } }] }]
      };
      const native = courseFromR6(input);
      expect(native.stages[0].start?.anchor).toBe(anchor);
      expect(courseToR6(native)).toEqual(input);
      expect(() => nextDueDoses(native, options)).toThrow();
    }
  });
});

describe("typed native safety and coding ownership", () => {
  it("retains parsed clinical period maxima while FHIR R5/R6 projections add complete standardized unit coding", () => {
    const parsed = parseSig("Take 2 tabs QID max 2 tabs/day");
    const native = parsed.meta.canonical.course!;
    const administration = native.stages[0].administrations[0];
    expect(administration.safety?.maximaDeclared).toBe(true);
    expect(administration.limits).toEqual([{
      scope: "period",
      amount: { value: 2, unit: "tab" },
      period: { value: 1, unit: "d" }
    }]);
    const r6 = projectCanonicalCourse(native).fhirNext.step[0].component[0].safety!;
    expect(r6.doseLimit?.[0].valueQuantity).toMatchObject({
      value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000"
    });
    expect(r6.doseLimit?.[0].period).toMatchObject({
      value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d"
    });
  });
});


describe("November 17 review: live native clinical facts own projection and realization", () => {
  it("removing a native administration limit clears it from R6 without dropping unrelated safety annotations", () => {
    const raw: FhirR6DosageInstruction = {
      step: [
        {
          component: [
            {
              safety: {
                id: "policy",
                ifExceeded: "contact prescriber",
                extension: [{ url: "urn:external:safety", valueString: "retain" }],
                doseLimit: [{ scope: "administration", valueQuantity: { value: 2, unit: "tab" } }],
              },
              doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            },
          ],
        },
      ],
    };
    const native = courseFromR6(raw, true);
    expect(native.stages[0].administrations[0].limits).toHaveLength(1);
    native.stages[0].administrations[0].limits = undefined;
    const exported = courseToR6(native).step[0].component[0].safety!;
    expect(exported.doseLimit).toBeUndefined();
    expect(exported.id).toBe("policy");
    expect(exported.ifExceeded).toBe("contact prescriber");
    expect(exported.extension).toEqual(raw.step[0].component[0].safety?.extension);
  });

  it("R5 retained site metadata cannot restore explicitly cleared native concept/reference", () => {
    const native = courseFromR6(source, true);
    const a = native.stages[0].administrations[0];
    a.siteReference = undefined;
    let rows = courseToR5(native);
    let reopened = inputToCanonical(rows);
    expect("stages" in reopened && reopened.stages[0].administrations[0].siteReference).toBeUndefined();
    expect("stages" in reopened && reopened.stages[0].administrations[0].target?.text).toBe("left eye");
    a.target = undefined;
    rows = courseToR5(native);
    reopened = inputToCanonical(rows);
    if (!("stages" in reopened)) throw new Error("R5 course metadata lost");
    expect(reopened.stages[0].administrations[0].target).toBeUndefined();
    expect(reopened.stages[0].administrations[0].siteReference).toBeUndefined();
  });
});

describe("November 17 review: typed course ownership without inferred exact bounds", () => {
  it("does not create an exact stage cutover from two approximate seven-day components", async () => {
    const { courseFromAdministrations } = await import("../src/canonical/compile");
    const length = { value: 7, unit: "d", code: "d", comparator: "~" as const };
    const administration = (clock: string) => ({
      kind: "administration" as const,
      stageOrdinal: 1,
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: {
        recurrence: {
          frequency: 1,
          period: 1,
          periodUnit: "d" as const,
          clocks: [clock],
          courseLength: length,
        },
      },
    });
    const course = courseFromAdministrations(
      [administration("08:00:00"), administration("20:00:00")],
      "Take twice daily for approximately one week"
    );
    expect(course.stages).toHaveLength(1);
    expect(course.stages[0].end).toBeUndefined();
    expect(course.stages[0].administrations).toHaveLength(2);
    expect(
      course.stages[0].administrations.every((a) => a.schedule?.recurrence?.courseLength?.comparator === "~")
    ).toBe(true);
  });

  it("intersects compatible administration maxima without replacing a contradictory stated dose", async () => {
    const { numericAdministrationLimits } = await import("../src/canonical/course");
    const native = {
      kind: "administration" as const,
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: "d" as const, clocks: ["08:00:00"] } },
      limits: [
        { scope: "administration" as const, amount: { value: 2, unit: "tab" } },
        { scope: "administration" as const, amount: { value: 0.5, unit: "tab" } },
      ],
    };
    for (const limits of [native.limits, native.limits.slice().reverse()]) {
      const variant = { ...native, limits };
      expect(numericAdministrationLimits(variant)).toMatchObject({
        multiple: false,
        administration: { value: 0.5, unit: "tab" },
      });
      const calculated = calculateTotalUnits({ ...options, dosage: variant });
      expect(calculated.totalUnits).toBe(3);
      expect(calculated.quantityKind).toBe("maximum");
      expect(calculated.explanation).toContain("could not be applied");
    }
  });
});
