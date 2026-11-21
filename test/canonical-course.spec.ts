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
  fromFhirDosage,
  formatSig,

  projectCanonicalCourse,
  toFhirR5Dosages,
  toDosageDetails,
} from "../src/index";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { clauseForAdministration, courseFromAdministrations } from "../src/canonical/compile";
import {
  TIMING_DAY_OF_MONTH_EXTENSION_URL,
  TIMING_WEEKDAY_ORDINAL_EXTENSION_URL,
  TIMING_CLOCK_WINDOW_EXTENSION_URL,
  TIMING_OCCURRENCE_CAP_EXTENSION_URL,
  TIMING_OFFSET_EXACT_EXTENSION_URL,
  ADMINISTRATION_OFFSET_EXTENSION_URL,
  projectCourseDurationRange, getAnchoredCourseDuration,
} from "../src/fhir";
import { cloneStructuredValue } from "../src/stable-structure";
import { dosageMatchesSavedProjection, withDosageEditProvenance } from "../src/dosage-course";
import { registerMedicationLocaleDetector, inferMedicationLocale } from "../src/locale-detection";
import { registerSigLocalization, resolveSigLocalization } from "../src/i18n";
import { EMA_QUANTITY_COMPARATOR_EXTENSION_URL, EMA_QUANTITY_OPERATOR_SYSTEM } from "../src/fhir-quantity-operator";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { EventTiming, FhirDayOfWeek, FhirPeriodUnit, type FhirDosage, type FhirR6Dosage, type FhirR6DosageInstruction, type FhirR6DoseLimit } from "../src/types";
import type { CanonicalAdministration, CanonicalCourse, CanonicalScheduleInput } from "../src/canonical/course";

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
    expect(out.step[0].component[0].timing?.repeat?.extension?.filter(
      marker => marker.url === TIMING_OFFSET_EXACT_EXTENSION_URL
    )).toEqual([{ url: TIMING_OFFSET_EXACT_EXTENSION_URL, valueDecimal: 1.5 }]);
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
      expect(() => nextDueDoses(native, options)).toThrow("Unsupported R6 step RelativeTime: requires a treatment-start offset");
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
    const projected = projectCanonicalCourse(native);
    const r5 = projected.fhir[0].maxDosePerPeriod![0];
    expect(r5.numerator).toMatchObject({
      value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000"
    });
    expect(r5.denominator).toMatchObject({
      value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d"
    });
    const r6 = projected.fhirNext.step[0].component[0].safety!;
    expect(r6.doseLimit).toEqual([{
      scope: "period",
      valueQuantity: { value: 2, unit: "tab", system: "http://standardterms.edqm.eu", code: "15054000" },
      period: { value: 1, unit: "d", system: "http://unitsofmeasure.org", code: "d" },
    }]);
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


describe("round 24: live projection and course boundaries", () => {
  it("shows reference-only site display without inventing a coding or replacing the Reference", () => {
    const reference = {
      id: "external-site", reference: "BodyStructure/left", display: "left eye",
      extension: [{ url: "urn:test:reference-detail", valueString: "preserved" }],
    };
    const wire: FhirR6DosageInstruction = {
      renderedInstruction: "Instill one drop in the right eye twice daily.",
      step: [{ component: [{
        site: { reference },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "drop", code: "[drp]",
          system: "http://unitsofmeasure.org" } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } },
      }] }],
    };
    const course = courseFromR6(wire);
    const member = course.stages[0].administrations[0];
    expect(member.target).toBeUndefined();
    expect(member.siteReference).toEqual(reference);
    expect(clauseForAdministration(member).site).toEqual({
      text: "left eye", administrationTargetCount: undefined,
    });
    for (const preview of [
      formatSig(wire, "long", { locale: "en" }),
      fromFhir(wire, { locale: "en" }).longText,
      formatCanonicalCourse(course, "long", { locale: "en" }),
    ]) {
      expect(preview).toContain("1 drop");
      expect(preview).toContain("left eye");
      expect(preview).not.toContain("right eye");
    }
    const saved = courseToR6(inputToCanonical(JSON.parse(JSON.stringify(courseToR5(course)))));
    expect(saved.step[0].component![0].site?.reference).toEqual(reference);
    expect(saved.step[0].component![0].site?.concept).toBeUndefined();

    const conceptBacked = structuredClone(wire);
    conceptBacked.step[0].component![0].site!.concept = { text: "left lower eyelid" };
    expect(formatSig(conceptBacked, "long", { locale: "en" })).toContain("left lower eyelid");
  });

  it.each([
    [1.5, [
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      "2026-01-02T08:00:00+00:00",
    ], 4],
    [2, [
      "2026-01-01T08:00:00+00:00", "2026-01-01T20:00:00+00:00",
      "2026-01-02T08:00:00+00:00", "2026-01-02T20:00:00+00:00",
    ], 6],
  ] as const)("keeps a %s-day component course executable without an unsupported shared boundary", (days, due, total) => {
    const parsed = parseSig(
      "Take 1 tab at 08:00 for " + days + " days; take 2 tabs at 20:00 for " + days + " days",
    );
    const course = inputToCanonical(parsed);
    expect(course.stages).toHaveLength(1);
    expect(course.stages[0].administrations).toHaveLength(2);
    if (days === 1.5) expect(course.stages[0].end).toBeUndefined();
    else expect(course.stages[0].end?.displacement?.value).toBe(2);
    for (const administration of course.stages[0].administrations)
      expect(administration.schedule?.recurrence?.courseLength?.value).toBe(days);
    const query = {
      orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-01T00:00:00Z",
      timeZone: "UTC", limit: 10,
    };
    for (const input of [parsed, parsed.fhir, parsed.fhirNext]) {
      expect(nextDueDoses(input, query)).toEqual(due);
      expect(calculateTotalUnits({
        ...query, dosage: input, durationValue: 3, durationUnit: "d",
      }).totalUnits).toBe(total);
    }
  });

  it.each([undefined, []])("shows a live zero-step cap instead of stale header wording (steps=%s)", step => {
    const wire = {
      renderedInstruction: "maximum 3 administrations", step,
      safety: { doseLimit: [{ scope: "dosage" as const, valueInteger: 2 }] },
    };
    for (const preview of [
      formatSig(wire, "long", { locale: "en" }),
      fromFhir(wire, { locale: "en" }).longText,
    ]) {
      expect(preview).toContain("max per dosage: 2");
      expect(preview).not.toContain("3 administrations");
    }
    const saved = courseToR6(inputToCanonical(wire));
    expect(saved.renderedInstruction).toBe("maximum 3 administrations");
    expect(saved.safety?.doseLimit).toEqual([{ scope: "dosage", valueInteger: 2 }]);
    expect(saved.step).toBeUndefined();
  });

  it("keeps a genuine text-only R6 header literal", () => {
    const wire = { renderedInstruction: "Follow the supplied instructions." };
    expect(formatSig(wire, "long", { locale: "en" })).toBe(wire.renderedInstruction);
    expect(fromFhir(wire, { locale: "en" }).longText).toBe(wire.renderedInstruction);
  });

  it("captures fresh timing ownership for a dose-less graph and retains its source after an external clock edit", () => {
    const row = parseSig("Swallow slowly with water at 08:00").fhir[0];
    const original = JSON.stringify(row.extension);
    const authoredText = row.text;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(row.doseAndRate).toBeUndefined();
    expect(formatSig(row, "long", options)).toContain("08:00");
    row.timing!.repeat!.timeOfDay = ["10:00:00"];
    const preview = formatSig(row, "long", options);
    expect(preview).toContain("10:00");
    expect(preview).not.toContain("08:00");
    expect(preview).toContain("slowly");
    expect(preview).toContain("water");
    expect(row.text).toBe(authoredText);
    expect(JSON.stringify(row.extension)).toBe(original);
  });
});

// Consolidated from pr14-native-edit-family.spec.ts; all eight clinical cases retained.
{
const asCourse = (input: CanonicalScheduleInput): CanonicalCourse => {
  if ("kind" in input) return input.kind === "course"
    ? input : { kind: "course", stages: [{ administrations: [input] }] };
  return { kind: "course", stages: [{ administrations: [...input] }] };
};
const member = (input: CanonicalScheduleInput) => asCourse(input).stages[0].administrations[0];

describe("compiled clinical facts and source units survive projection", () => {

  it("keeps seven days of dosing after a shared two-day stage delay", () => {
    const dose = (value: number): CanonicalAdministration => ({ kind: "administration",
      delayMinutes: 2 * 1440, amounts: [{ quantity: { value, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const after = courseFromAdministrations([dose(1), dose(2)], "");
    expect(after.stages[0].start!.displacement).toMatchObject({ value: 48, unit: "h" });
    expect(after.stages[0].end).toBeUndefined();
    const options = { from: "2026-01-01T00:00:00Z", orderedAt: "2026-01-01T00:00:00Z",
      timeZone: "UTC", durationValue: 14, durationUnit: FhirPeriodUnit.Day };
    for (const input of [after, courseToR6(after), courseToR5(after)]) {
      const supply = "kind" in input
        ? calculateTotalUnits({ ...options, dosage: input })
        : calculateTotalUnits({ ...options, dosage: input });
      expect(supply.totalUnits).toBe(21);
      const due = nextDueDoses(input, { ...options, limit: 20 });
      expect(due).toHaveLength(14);
      expect(due.map(instant => instant.slice(0, 10))).toEqual(
        Array.from({ length: 7 }, (_, day) => `2026-01-${String(day + 3).padStart(2, "0")}`)
          .flatMap(day => [day, day])
      );
    }
  });

  it("retains the derived unshifted stage end and avoids one for a qualified duration", () => {
    const dose = (): CanonicalAdministration => ({ kind: "administration",
      amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        courseLength: { value: 7, unit: "d" } } } });
    const first = dose(), second = dose();
    expect(courseFromAdministrations([first, second], "").stages[0].end!.displacement).toMatchObject({ value: 7, unit: "d" });
    first.schedule!.recurrence!.courseLength!.comparator = "~";
    second.schedule!.recurrence!.courseLength!.comparator = "~";
    expect(courseFromAdministrations([first, second], "").stages[0].end).toBeUndefined();
  });

  it.each([
    [{ value: 500, system: "http://unitsofmeasure.org", code: "mg" }, "mg", "500 mg"],
    [{ value: 2, system: "http://standardterms.edqm.eu", code: "15054000" }, "tab", "2 tablets"],
    [{ value: 1, system: "urn:test:units", code: "custom-unit" }, "custom-unit", "custom-unit"],
  ] as const)("retains a code-only scalar dose unit in generated wording", (quantity, expectedUnit, wording) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ doseAndRate: [{ doseQuantity: quantity }] }] }] };
    const course = courseFromR6(raw, true);
    expect(clauseForAdministration(member(course)).dose!.unit).toBe(expectedUnit);
    expect(formatSig(course, "long", { locale: "en" })).toContain(wording);
    expect(courseToR6(course).step![0].component[0].doseAndRate![0].doseQuantity).toEqual(quantity);
  });

  it.each(["coded", "authored"] as const)("preserves independent %s units on a mixed-unit dose range", kind => {
    const range = kind === "coded" ? {
      low: { value: 500, system: "http://unitsofmeasure.org", code: "mg" },
      high: { value: 1, system: "http://unitsofmeasure.org", code: "g" },
    } : { low: { value: 500, unit: "mg" }, high: { value: 1, unit: "g" } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: range }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }] };
    const course = courseFromR6(raw, true);
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain("500 mg – 1 g");
    expect(rendered).not.toMatch(/500[–-]1 mg/);
    expect(rendered).toContain("once daily");
    expect(courseToR6(course).step![0].component[0].doseAndRate![0].doseRange).toEqual(range);
  });

  it("retains independent endpoint comparators without duplicating the range across stages", () => {
    const course: CanonicalCourse = { kind: "course", stages: [{ administrations: [{
      kind: "administration", amounts: [{ range: {
        low: { value: 500, unit: "mg", comparator: ">=" },
        high: { value: 1000, unit: "mg", comparator: "<=" },
      } }], schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
    }] }, { administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 250, unit: "mg" } }],
    }] }] };
    const rendered = formatSig(course, "long", { locale: "en" });
    expect(rendered).toContain(">=500–<=1000 mg");
    expect(rendered).toContain("250 mg");
    expect(rendered.split(">=500–<=1000 mg")).toHaveLength(2);
    expect(rendered).not.toMatch(/(?<!>=)500[–-]1000 mg/);
    expect(member(course).amounts![0].range!.high!.comparator).toBe("<=");
  });

});

}


describe("display and replay family boundaries", () => {

const tablet: FhirR6Dosage = {
  doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
  timing: { repeat: { frequency: 4, period: 1, periodUnit: FhirPeriodUnit.Day } },
};
const daily = { value: 1, unit: "d" };

describe("source-less limit wording retains value and ownership", () => {
  it("shows an integer period cap alongside the four-times-daily instruction", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
    }] }] };
    const course = courseFromR6(raw);
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("four times daily");
    expect(text).toContain("max per period: 2 administrations / 1 d");
    expect(course.stages[0].administrations[0].limits?.[0].count).toBe(2);
    expect(fromFhir(raw, { locale: "en" }).longText)
      .toContain("max per period: 2 administrations / 1 d");
  });

  it.each(["period", "administration", "dosage", "lifetime"] as const)(
    "retains the %s scope for quantity, integer and unevaluated expression limits",
    (scope) => {
      const limits: FhirR6DoseLimit[] = [
        { scope, valueQuantity: { value: 8, unit: "tab" }, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueInteger: 2, ...(scope === "period" ? { period: daily } : {}) },
        { scope, valueExpression: { language: "text/fhirpath", expression: "weight * 2" },
          ...(scope === "period" ? { period: daily } : {}) },
      ];
      const course = courseFromR6({ step: [{ component: [{ ...tablet, safety: { doseLimit: limits } }] }] });
      const text = formatCanonicalCourse(course, "long", { locale: "en" });
      const label = scope === "period" ? "max per period:" :
        scope === "administration" ? "max per administration:" :
        scope === "dosage" ? "max per dosage:" : "max lifetime:";
      expect(text).toContain(label + " 8 tab");
      expect(text).toContain(label + " 2 administrations");
      expect(text).toContain(label + " unevaluated dose expression: weight * 2");
    },
  );

  it("shows a course-wide quantity cap exactly once for a simple course", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 8, unit: "tab" }, period: daily }] },
      step: [{ component: [tablet] }],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Across this course: max per period: 8 tab / 1 d");
    expect(text.split("8 tab").length - 1).toBe(1);
    expect(course.stages[0].administrations[0].limits).toBeUndefined();
  });

  it("keeps course and stage caps outside member wording in a multi-stage plan", () => {
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "lifetime", valueInteger: 12 }] },
      step: [
        { component: [tablet, tablet], safety: {
          doseLimit: [{ scope: "period", valueInteger: 2, period: daily }],
        } },
        { component: [tablet] },
      ],
    });
    const text = formatCanonicalCourse(course, "long", { locale: "en" });
    expect(text).toContain("Within this stage: max per period: 2 administrations / 1 d");
    expect(text).toContain("Across this course: max lifetime: 12 administrations");
    expect(text.split("max per period:").length - 1).toBe(1);
    expect(text.split("max lifetime:").length - 1).toBe(1);
  });

  it("keeps the new scope labels and counts behind the existing locale facet", () => {
    registerSigLocalization({
      locale: "limit-family",
      formatLong: () => "Dose locale.",
      course: { ...ENGLISH_COURSE,
        courseLimitsLabel: "Cours: ", stageLimitsLabel: "Étape: ",
        maxPeriodLabel: "Plafond: ", administrations: (value) => value + " prises",
      },
    });
    const course = courseFromR6({
      safety: { doseLimit: [{ scope: "period", valueInteger: 2, period: daily }] },
      step: [{ component: [tablet] }],
    });
    expect(formatCanonicalCourse(course, "long", { locale: "limit-family" }))
      .toContain("Cours: Plafond: 2 prises / 1 d");
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain("ตลอดแผนการใช้ยานี้: max per period: ให้ยา 2 ครั้ง / 1 d");
  });
});

describe("partial explicit calendar events remain visible", () => {
  it("retains year/month precision without fabricating a full date", () => {
    const course = courseFromR6({ step: [{ component: [{
      doseAndRate: tablet.doseAndRate,
      timing: { event: ["2026", "2026-11", "2026-11-20"] },
    }] }] });
    expect(formatCanonicalCourse(course, "long", { locale: "en" }))
      .toContain("Scheduled events: 2026, 2026-11");
    expect(formatCanonicalCourse(course, "long", { locale: "th" }))
      .toContain("วันที่กำหนด: 2026 และ 2026-11");
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalCourse(course, "long", { locale });
      expect(text).not.toMatch(/2026-00|2026-11-00|2026-00-00/u);
      expect(text).not.toContain("NaN");
    }
    expect(course.stages[0].administrations[0].schedule?.explicitEvents)
      .toEqual(["2026", "2026-11", "2026-11-20"]);
  });
});

function savedRow(): FhirDosage {
  const row: FhirDosage = {
    doseAndRate: [{ doseQuantity: { value: 1, unit: "tab", code: "tab", system: "urn:unit" } }],
    timing: {
      event: ["2026-11-20T08:00:00Z", "2026-11-21T08:00:00Z"],
      code: { text: "BID", coding: [{ code: "BID", system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation" }] },
      repeat: {
        frequency: 1, frequencyMax: 2, period: 1, periodMax: 2,
        periodUnit: FhirPeriodUnit.Day, count: 3, countMax: 4,
        duration: 1, durationMax: 2, durationUnit: FhirPeriodUnit.Hour,
        dayOfWeek: [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday], timeOfDay: ["08:00:00", "20:00:00"],
        when: [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]], offset: 15,
        boundsDuration: { value: 7, unit: "d" },
      },
    },
  };
  return withDosageEditProvenance([row], "Original source")[0];
}
describe("saved R5 source replay observes all live timing values", () => {
  const edits: Array<[string, (row: FhirDosage) => void]> = [
    ["later clock", row => { row.timing!.repeat!.timeOfDay![1] = "22:00:00"; }],
    ["later weekday", row => { row.timing!.repeat!.dayOfWeek![1] = FhirDayOfWeek.Friday; }],
    ["later event", row => { row.timing!.event![1] = "2026-11-22T08:00:00Z"; }],
    ["later meal anchor", row => { row.timing!.repeat!.when![1] = EventTiming["After Dinner"]; }],
    ["timing abbreviation", row => { row.timing!.code!.coding![0].code = "TID"; }],
    ["timing description", row => { row.timing!.code!.text = "three times daily"; }],
    ["frequency maximum", row => { row.timing!.repeat!.frequencyMax = 3; }],
    ["period maximum", row => { row.timing!.repeat!.periodMax = 3; }],
    ["period unit", row => { row.timing!.repeat!.periodUnit = FhirPeriodUnit.Week; }],
    ["count maximum", row => { row.timing!.repeat!.countMax = 5; }],
    ["duration", row => { row.timing!.repeat!.duration = 2; }],
    ["duration maximum", row => { row.timing!.repeat!.durationMax = 3; }],
    ["duration unit", row => { row.timing!.repeat!.durationUnit = FhirPeriodUnit.Minute; }],
    ["meal offset", row => { row.timing!.repeat!.offset = 30; }],
    ["course length", row => { row.timing!.repeat!.boundsDuration!.value = 14; }],
    ["dose unit system", row => { row.doseAndRate![0].doseQuantity!.system = "urn:other-unit"; }],
  ];
  it.each(edits)("invalidates replay after changing the %s in place", (_, edit) => {
    const row = savedRow();
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    edit(row);
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it.each(["fresh", "persisted"] as const)(
    "invalidates the %s authored Thai source after editing its second clock", (kind) => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด เวลา 08:00 และ 20:00 แล้วหลับตา";
    const parsed = parseSig(source, { locale: "th" });
    const row = kind === "fresh" ? parsed.items[0].fhir
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(source);
    row.timing!.repeat!.timeOfDay![1] = "22:00:00";
    const edited = formatSig(row, "long", options);
    expect(edited).toContain("22:00");
    expect(edited).not.toContain("20:00");
    expect(edited).toContain("1 หยด");
    row.timing!.repeat!.timeOfDay![1] = "20:00:00";
    expect(formatSig(row, "long", options)).toBe(source);
  });

  it("does not replay BID source after a code-only R5 schedule is edited to TID", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด bid แล้วหลับตา";
    const parsed = structuredClone(parseSig(source, { locale: "th" }).fhir[0]);
    // A code-only Timing is valid R5. Keep this fixture free of an intentionally
    // contradictory old numeric frequency so the expected new cadence is clear.
    delete parsed.timing!.repeat;
    const row = withDosageEditProvenance([parsed], source)[0];
    const options = { locale: "th", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(source);
    row.timing!.code!.coding![0].code = "TID";
    row.timing!.code!.text = "TID";
    const edited = formatSig(row, "long", options);
    expect(edited).not.toBe(source);
    expect(edited).toContain("3 ครั้ง");
    expect(edited).not.toContain("bid");
  });

  it("shows the changed second clock through the public formatter and allows restoration", () => {
    const row = JSON.parse(JSON.stringify(parseSig("Take 1 tablet at 08:00 and 20:00").items[0].fhir));
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    const original = formatSig(row, "long", options);
    row.timing.repeat.timeOfDay[1] = "22:00:00";
    expect(formatSig(row, "long", options)).toContain("10:00 pm");
    expect(formatSig(row, "long", options)).not.toContain("8:00 pm");
    row.timing.repeat.timeOfDay[1] = "20:00:00";
    expect(formatSig(row, "long", options)).toBe(original);
  });
});

describe("locale detector registration has stable provider identity", () => {
  it("retains the registered snapshot while allowing an explicit replacement", () => {
    const detector = { locale: "aa", priority: 10, test: (value: string) => value === "__locale_aa__" };
    registerMedicationLocaleDetector(detector);
    detector.locale = "bb";
    detector.test = value => value === "__locale_changed__";
    expect(inferMedicationLocale("__locale_aa__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
    registerMedicationLocaleDetector({ locale: "cc", priority: 20, test: value => value === "__locale_cc__" });
    registerMedicationLocaleDetector({ locale: "aa", priority: 30, test: value => value === "__locale_aa_new__" });
    expect(inferMedicationLocale("__locale_cc__")).toBe("cc");
    expect(inferMedicationLocale("__locale_aa_new__")).toBe("aa");
    expect(inferMedicationLocale("__locale_changed__", "fallback")).toBe("fallback");
  });
});
});


describe("review 26 external display ownership", () => {
  it.each(["fresh", "persisted"] as const)("uses the edited weekday ordinal in a %s graph-backed row", kind => {
    const source = "Swallow 1 tablet whole on the first Monday of each month";
    const parsed = parseSig(source);
    const row = kind === "fresh" ? parsed.items[0].fhir
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("first Monday");
    const ordinal = row.timing!.repeat!.extension!.find(x => x.url === TIMING_WEEKDAY_ORDINAL_EXTENSION_URL)!;
    expect(ordinal.valueInteger).toBe(1);
    ordinal.valueInteger = 2;
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).toMatch(/second Monday|2nd Monday/iu);
      expect(text).not.toContain("first Monday");
      expect(text).toContain("1 tablet");
    }
    ordinal.valueInteger = 1;
    expect(formatSig(row, "long", options)).toContain("first Monday");
  });

  it("uses current clock-window endpoints on a second preview of a persisted infusion", () => {
    const source = "Infuse 5 mL/h between 08:00 and 18:00";
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([{
      text: source, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      timing: { repeat: { frequency: 1, period: 2, periodUnit: FhirPeriodUnit.Hour,
        extension: [{ url: TIMING_CLOCK_WINDOW_EXTENSION_URL, extension: [
          { url: "start", valueTime: "08:00:00" }, { url: "end", valueTime: "18:00:00" },
          { url: "endInclusive", valueBoolean: true }
        ] }] } }
    }], source)[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toBe(source);
    expect(formatSig(row, "long", options)).toBe(source);
    const window = row.timing!.repeat!.extension![0].extension!;
    window[0].valueTime = "09:00:00";
    const text = formatSig(row, "long", options);
    expect(text).toMatch(/09:00|9:00 am/u);
    expect(text).toMatch(/18:00|6:00 pm/u);
    expect(text).not.toMatch(/08:00|8:00 am/u);
    expect(text).toContain("5 mL/h");
    window[1].valueTime = "17:00:00";
    expect(formatSig(row, "long", options)).toMatch(/17:00|5:00 pm/u);
    expect(formatSig(row, "long", options)).not.toMatch(/18:00|6:00 pm/u);
    window[0].valueTime = "08:00:00";
    window[1].valueTime = "18:00:00";
    expect(dosageMatchesSavedProjection(row)).toBe(true);
    window[2].valueBoolean = false;
    expect(dosageMatchesSavedProjection(row)).toBe(false);
  });

  it("does not replay a removed persisted rate beside an unchanged maximum", () => {
    const source = "Infuse 5 mL/h, maximum 10 mL per administration";
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([{
      text: source, doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } }],
      maxDosePerAdministration: { value: 10, unit: "mL" }
    }], source)[0])) as FhirDosage;
    expect(formatSig(row, "long")).toBe(source);
    delete row.doseAndRate![0].rateQuantity;
    for (const text of [formatSig(row, "long"), fromFhirDosage(row).longText]) {
      expect(text).not.toContain("5 mL/h");
      expect(text).toContain("10 mL");
    }
    row.text = "Clinician replacement instruction: maximum 10 mL";
    expect(formatSig(row, "long")).toBe(row.text);
  });

  it.each(["en", "th"])("keeps a strict high dose endpoint in both %s public previews", locale => {
    const row: FhirDosage = { doseAndRate: [{ doseRange: {
      low: { value: 2, unit: "mg" }, high: { value: 5, unit: "mg", extension: [{
        url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" }
      }] }
    } }] };
    const text = formatSig(row, "long", { locale });
    expect(text).toContain("<5");
    const reopened = fromFhirDosage(row, { locale });
    expect(reopened.longText).toBe(text);
    expect(reopened.shortText).toContain("<5");
    expect(reopened.fhir.doseAndRate).toEqual(row.doseAndRate);
  });

  it("binds partial regional callbacks to the registration that owns their private state", () => {
    class BasePack {
      readonly locale = "rx";
      readonly course = ENGLISH_COURSE;
      #long = "Base long";
      formatLong() { return this.#long; }
      formatShort() { return "Base short"; }
    }
    class RegionalPack {
      readonly locale = "rx-XX";
      #short = "Regional short";
      formatShort() { return this.#short; }
    }
    const base = new BasePack();
    registerSigLocalization(base);
    registerSigLocalization(new RegionalPack());
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    expect(formatSig(row, "long", { locale: "rx-XX" })).toBe("Base long");
    expect(formatSig(row, "short", { locale: "rx-XX" })).toBe("Regional short");
    const first = resolveSigLocalization("rx-XX");
    expect(resolveSigLocalization("rx-XX")).toBe(first);
    expect(resolveSigLocalization("rx")).toBe(base);
    class ReplacementPack extends BasePack {
      #replacement = "Replacement long";
      formatLong() { return this.#replacement; }
    }
    registerSigLocalization(new ReplacementPack());
    expect(formatSig(row, "long", { locale: "rx-XX" })).toBe("Replacement long");
    expect(formatSig(row, "short", { locale: "rx-XX" })).toBe("Regional short");
  });
});


describe("review 26 independent partial phase boundaries", () => {
  it("keeps the other eye's exact transition beside a missing cutover", () => {
    const source = "1 drop OS QID then BID; 1 drop OD BID for 7 days then QID";
    const parsed = parseSig(source);
    const native = parsed.meta.canonical.course!;
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)));
    for (const course of [native, courseFromR6(parsed.fhirNext), courseFromR6(toDosageDetails(saved))]) {
      expect(course.stages).toHaveLength(1);
      const right = course.stages[0].administrations.filter(a => a.target?.text === "right eye");
      const left = course.stages[0].administrations.filter(a => a.target?.text === "left eye");
      expect(right).toHaveLength(2);
      expect(left).toHaveLength(2);
      expect(right[0].phaseOrigin).toMatchObject({ value: 0, code: "d" });
      const length = right[0].schedule?.recurrence?.courseLength;
      expect(length?.value).toBe(7);
      expect(length?.code ?? length?.unit).toBe("d");
      expect(right[1].phaseOrigin).toMatchObject({ value: 7, code: "d" });
      expect(right[1].schedule?.recurrence?.frequency).toBe(4);
      expect(left[1].phaseOrigin).toBeUndefined();
      expect(left[1].phaseStart?.anchor).toBe("unresolved");
    }
    const options = { orderedAt: "2026-01-01T00:00:00Z", from: "2026-01-08T00:00:00Z",
      timeZone: "UTC", limit: 4 };
    expect(() => nextDueDoses(parsed.fhirNext, options)).toThrow(/relative|resolv|anchor/iu);
    // A clinician can still use the independently complete right-eye track.
    const rightOnly = { ...parsed.fhirNext, step: parsed.fhirNext.step!.map(step => ({ ...step,
      component: step.component.filter(a => a.site?.concept?.text === "right eye") })) };
    expect(nextDueDoses(rightOnly, options)).toHaveLength(4);
    expect(calculateTotalUnits({ dosage: rightOnly, ...options,
      durationValue: 1, durationUnit: FhirPeriodUnit.Day })).toMatchObject({ totalUnits: 4, unit: "drop" });
    for (const view of [native, parsed.fhirNext, saved]) {
      const preview = formatSig(view, "long", { locale: "en", realizationMode: "normalized" });
      expect(preview).toContain("7 days after treatment start");
      expect(preview).toContain("Stage timing requires review");
      expect(preview).toContain("right eye");
      expect(preview).toContain("left eye");
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.longText).toMatch(/right eye|OD/u);
    expect(parsed.longText).toMatch(/left eye|OS/u);
  });
});


it.each(["fresh", "persisted"] as const)("keeps %s clinician text edits and honors an explicit text clear", kind => {
  const parsed = parseSig("Swallow 1 tablet whole at bedtime per the agreed plan.");
  const row = kind === "fresh" ? parsed.items[0].fhir
    : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
  const options = { locale: "en", realizationMode: "roundtrip" as const };
  const replacement = "Swallow 1 tablet whole at bedtime after discussion with the clinician.";
  row.text = replacement;
  expect(formatSig(row, "long", options)).toBe(replacement);
  expect(fromFhirDosage(row, options).longText).toBe(replacement);
  const normalized = formatSig(row, "long", { ...options, realizationMode: "normalized" });
  expect(normalized).toContain("1 tablet");
  expect(normalized).toMatch(/bedtime|on sleep/u);
  expect(normalized).not.toContain("discussion with the clinician");
  row.text = "";
  for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
    expect(text).not.toContain("per the agreed plan");
    expect(text).not.toContain("discussion with the clinician");
    expect(text).toContain("1 tablet");
    expect(text).toMatch(/bedtime|on sleep/u);
  }
});


it("keeps replacement text authoritative on a qualified range while preserving rich structured metadata", () => {
  const row = withDosageEditProvenance([{
    text: "Use 2 mg to less than 5 mg",
    doseAndRate: [{ doseRange: { low: { value: 2, unit: "mg" }, high: {
      value: 5, unit: "mg", extension: [{ url: EMA_QUANTITY_COMPARATOR_EXTENSION_URL,
        valueCoding: { system: EMA_QUANTITY_OPERATOR_SYSTEM, code: "100000000050" } }]
    } } }]
  }], "Use 2 mg to less than 5 mg")[0];
  const persisted = JSON.parse(JSON.stringify(row)) as FhirDosage;
  persisted.text = "Use 2 mg to less than 5 mg after discussing the plan with the clinician.";
  const options = { locale: "en", realizationMode: "roundtrip" as const };
  expect(formatSig(persisted, "long", options)).toBe(persisted.text);
  const imported = fromFhirDosage(persisted, options);
  expect(imported.longText).toBe(persisted.text);
  expect(imported.shortText).toBe(persisted.text);
  expect(imported.meta.canonical.administration?.amounts?.[0].range?.high)
    .toMatchObject({ value: 5, unit: "mg", comparator: "<" });
  expect(fromFhirDosage(persisted, { ...options, realizationMode: "normalized" }).longText).toContain("<5");
});


describe("review 27 live clinical source proofs and language receivers", () => {
  it.each(["fresh", "persisted"] as const)("invalidates a %s occurrence-cap proof after each nested edit", kind => {
    const source = "Dissolve 1 tablet in water as needed, maximum 3 doses per day";
    const parsed = parseSig(source);
    const row = kind === "fresh" ? parsed.items[0].fhir
      : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    const originalRowText = row.text;
    expect(formatSig(row, "long", options)).toContain("3 doses per day");
    const cap = row.timing!.repeat!.extension!.find(e => e.url === TIMING_OCCURRENCE_CAP_EXTENSION_URL)!;
    cap.extension!.find(e => e.url === "max")!.valueInteger = 2;
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).toContain("maximum 2 doses per day");
      expect(text).not.toContain("3 doses");
    }
    cap.extension!.find(e => e.url === "period")!.valueQuantity!.value = 2;
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).toContain("maximum 2 doses per 2 days");
      expect(text).not.toContain("3 doses");
    }
    expect(row.text).toBe(originalRowText);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["period", "administration", "lifetime"] as const)("invalidates a warm saved %s maximum proof", scope => {
    const suffix = scope === "period" ? "per day" : "per " + scope;
    const text = "Take 1 tablet as needed, max 4 tablets " + suffix;
    const raw: FhirDosage = { text, asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      ...(scope === "period" ? { maxDosePerPeriod: [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }] }
        : scope === "administration" ? { maxDosePerAdministration: { value: 4, unit: "tab" } }
        : { maxDosePerLifetime: { value: 4, unit: "tab" } }) };
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([raw], text)[0])) as FhirDosage;
    const options = { locale: "en", realizationMode: "roundtrip" as const };
    expect(formatSig(row, "long", options)).toContain("4 tablets");
    const quantity = scope === "period" ? row.maxDosePerPeriod![0].numerator!
      : scope === "administration" ? row.maxDosePerAdministration! : row.maxDosePerLifetime!;
    quantity.value = 2;
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).toMatch(/(?<![\d.])2 tab(?:lets?)?\b/u);
      expect(text).not.toMatch(/(?<![\d.])4 tab(?:lets?)?\b/u);
      expect(text).toMatch(/as needed|when needed/iu);
    }
    if (scope === "period") {
      row.maxDosePerPeriod![0].denominator!.value = 2;
      for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText])
        expect(text).toMatch(/(?<![\d.])2 (?:tablets per 2 days|tab \/ 2 d)\b/u);
    }
  });

  it("binds per-call base, inherited and override callbacks to their owning objects", () => {
    class BasePack {
      readonly locale = "r27";
      readonly course = ENGLISH_COURSE;
      #short = "Base short";
      #long = "Base long";
      formatShort() { return this.#short; }
      formatLong() { return this.#long; }
    }
    class InheritedPack {
      readonly locale = "r27-inherited";
      #long = "Inherited long";
      formatLong() { return this.#long; }
    }
    class CallConfig {
      readonly locale = "r27-CA";
      readonly inherit = "r27-inherited";
      #short = "Per-call short";
      formatShort() { return this.#short; }
    }
    const base = new BasePack();
    registerSigLocalization(base);
    registerSigLocalization(new InheritedPack());
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    expect(resolveSigLocalization("r27")).toBe(base);
    expect(resolveSigLocalization("r27-CA")).toBe(base);
    expect(formatSig(row, "long", { i18n: { locale: "r27-CA" } })).toBe("Base long");
    expect(formatSig(row, "short", { i18n: { locale: "r27-CA" } })).toBe("Base short");
    const localization = new CallConfig();
    expect(formatSig(row, "long", { i18n: localization })).toBe("Inherited long");
    expect(formatSig(row, "short", { i18n: localization })).toBe("Per-call short");
  });
});

it.each(["Take 1 tablet", "Dissolve 1 tablet in water"])("keeps a fresh item maximum edit live for %s", head => {
  const batch = parseSig(head + " as needed, max 4 tablets per day");
  const row = batch.items[0].fhir;
  const originalText = row.text;
  expect(row).not.toBe(batch.fhir[0]);
  expect(formatSig(row, "long", { realizationMode: "roundtrip" })).toContain("4 tablets");
  row.maxDosePerPeriod![0].numerator!.value = 2;
  for (const realizationMode of ["roundtrip", "normalized"] as const) {
    const options = { locale: "en", realizationMode };
    for (const text of [formatSig(row, "long", options), fromFhirDosage(row, options).longText]) {
      expect(text).toMatch(/(?<![\d.])2 tab(?:lets?)?\b/u);
      expect(text).not.toMatch(/(?<![\d.])4 tab(?:lets?)?\b/u);
    }
  }
  expect(row.text).toBe(originalText);
});

it("keeps inserted and removed maxima live on direct parser items", () => {
  const row = parseSig("Take 1 tablet daily").items[0].fhir;
  const sourceText = row.text;
  expect(formatSig(row, "long")).not.toMatch(/max|limit/iu);
  row.maxDosePerPeriod = [{ numerator: { value: 4, unit: "tab" }, denominator: { value: 1, unit: "d" } }];
  for (const realizationMode of ["roundtrip", "normalized"] as const)
    for (const text of [formatSig(row, "long", { realizationMode }),
      fromFhirDosage(row, { realizationMode }).longText])
      expect(text).toMatch(/(?<![\d.])4 (?:tablets per day|tab \/ 1 d)\b/u);
  delete row.maxDosePerPeriod;
  for (const realizationMode of ["roundtrip", "normalized"] as const)
    for (const text of [formatSig(row, "long", { realizationMode }),
      fromFhirDosage(row, { realizationMode }).longText]) {
      expect(text).toContain("1 tablet");
      expect(text).not.toMatch(/max|limit|4 tab/iu);
    }
  expect(row.text).toBe(sourceText);
});

it.each([
  ["en", "the day after the previous phase"],
  ["th", "วันถัดจากวันสุดท้ายของขั้นตอนก่อนหน้า"],
] as const)("localizes the completion-relative next-day boundary in %s", (locale, expected) => {
  const course: CanonicalCourse = { kind: "course", stages: [
    { administrations: [{ kind: "administration", amounts: [{ quantity: { value: 1, unit: "tab" } }],
      schedule: { recurrence: { count: 5, frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["09:00:00"] } } }] },
    { start: { anchor: "previous-phase-next-day" }, administrations: [{
      kind: "administration", amounts: [{ quantity: { value: 2, unit: "tab" } }],
      schedule: { recurrence: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day, clocks: ["15:00:00"] } }
    }] }
  ] };
  const text = formatCanonicalCourse(course, "long", { locale });
  expect(text).toContain(expected);
  expect(text).not.toMatch(/day 2|วันที่ 2|requires review|ต้องตรวจสอบช่วงเวลา/iu);
});

it("retains an independent member onset beside a completion-relative member over three external saves", () => {
  const source = "Take 1 tablet daily for 5 doses then take 2 tablets at 06:00 the next day and from day 10 take 3 tablets at 15:00";
  let wire = parseSig(source).fhirNext;
  for (let save = 0; save < 3; save++) {
    const native = courseFromR6(wire);
    expect(native.stages).toHaveLength(2);
    const members = native.stages[1].administrations;
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ phaseStart: { anchor: "previous-phase-next-day" },
      amounts: [{ quantity: { value: 2, unit: "tab" } }] });
    expect(members[1]).toMatchObject({ phaseStart: { anchor: "treatment-day-start", displacement: { value: 9, unit: "d" } },
      amounts: [{ quantity: { value: 3, unit: "tab" } }] });
    wire = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(wire))));
  }
});


describe("round 28 live capped source concepts", () => {
  for (const saved of [false, true]) {
    it.each(["replace", "nested-code"] as const)(
      "uses the live eye in both previews after a %s edit (saved=" + saved + ")",
      edit => {
        const batch = parseSig("1 drop OD BID max 2 drops/day");
        const row = saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage
          : batch.items[0].fhir;
        const source = row.text;
        expect(row.maxDosePerPeriod?.[0].numerator?.value).toBe(2);
        expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" }))
          .toMatch(/right eye|\bOD\b/iu);
        if (edit === "replace")
          row.site = { text: "left eye", coding: [{
            system: "http://snomed.info/sct", code: "1290031003",
            display: "Structure of left eye proper"
          }] };
        else row.site!.coding![0].code = "1290031003";
        for (const mode of ["roundtrip", "normalized"] as const) {
          const options = { locale: "en", realizationMode: mode };
          const imported = fromFhirDosage(row, options);
          for (const text of [formatSig(row, "short", options), formatSig(row, "long", options),
            imported.shortText, imported.longText]) {
            expect(text).toMatch(/left eye|\bOS\b/iu);
            expect(text).not.toMatch(/right eye|\bOD\b/iu);
          }
        }
        expect(row.text).toBe(source);
        expect(row.site?.coding?.[0].code).toBe("1290031003");
      }
    );
    it.each(["route", "method", "prn"] as const)(
      "invalidates the capped source for a live %s edit (saved=" + saved + ")",
      field => {
        const batch = parseSig("Take 1 tablet PO daily max 2 tablets/day");
        const row = saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage
          : batch.items[0].fhir;
        const source = row.text;
        expect(row.maxDosePerPeriod?.[0].numerator?.value).toBe(2);
        formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
        if (field === "prn") row.asNeeded = true;
        else if (field === "route") {
          row.route!.text = "sublingual";
          Object.assign(row.route!.coding![0], { code: "37839007", display: "Sublingual route" });
        } else {
          row.method!.text = "Chew";
          Object.assign(row.method!.coding![0], { code: "738992009", display: "Chew" });
        }
        const options = { locale: "en", realizationMode: "roundtrip" as const };
        const imported = fromFhirDosage(row, options);
        for (const text of [formatSig(row, "long", options), imported.longText]) {
          if (field === "route") {
            expect(text).toMatch(/sublingual|\bSL\b/iu);
            expect(text).not.toMatch(/by mouth|\bPO\b/iu);
          } else if (field === "method") expect(text).toMatch(/\bchew\b/iu);
          else expect(text).toMatch(/as needed|when needed|\bPRN\b/iu);
        }
        expect(row.text).toBe(source);
      }
    );
  }
});


describe("round 28 live source concept lists", () => {
  for (const saved of [false, true]) {
    it.each(["replace", "nested", "coding", "remove"] as const)(
      "updates a capped PRN reason after %s (saved=" + saved + ")", edit => {
        const batch = parseSig("Take 1 tablet PO daily as needed for pain max 2 tablets/day");
        const row = saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage : batch.items[0].fhir;
        const source = row.text;
        expect(row.asNeeded).toBe(true);
        expect(row.asNeededFor?.[0].text).toBe("pain");
        expect(formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" })).toMatch(/pain/i);
        if (edit === "replace") row.asNeededFor = [{ text: "nausea" }];
        else if (edit === "nested") {
          row.asNeededFor![0].text = "nausea";
          row.asNeededFor![0].coding = undefined;
        } else if (edit === "coding") row.asNeededFor![0].coding![0].code = "422587007";
        else row.asNeededFor = [];
        const edited = JSON.stringify(row);
        for (const realizationMode of ["roundtrip", "normalized"] as const) {
          const options = { locale: "en", realizationMode };
          const imported = fromFhirDosage(row, options);
          for (const text of [formatSig(row, "long", options), imported.longText]) {
            expect(text).toMatch(/as needed|when needed/iu);
            expect(text).not.toMatch(/\bpain\b/iu);
            if (edit !== "remove") expect(text).toMatch(/\bnausea\b/iu);
          }
        }
        expect(JSON.stringify(row)).toBe(edited);
        expect(row.text).toBe(source);
      }
    );

    it("shows newly supplied advice beside the current cap (saved=" + saved + ")", () => {
      const batch = parseSig("Take 1 tablet PO daily max 2 tablets/day");
      const row = saved ? JSON.parse(JSON.stringify(batch.fhir[0])) as FhirDosage : batch.items[0].fhir;
      const source = row.text;
      formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
      row.additionalInstruction = [{ text: "Avoid grapefruit" }];
      const edited = JSON.stringify(row);
      for (const text of [
        formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" }),
        fromFhirDosage(row, { locale: "en", realizationMode: "roundtrip" }).longText
      ]) expect(text).toContain("Avoid grapefruit");
      expect(JSON.stringify(row)).toBe(edited);
      expect(row.text).toBe(source);
    });
  }
});

describe("round30 current cadence and duration metadata", () => {
  it.each([
    [2, undefined, "wk", "2x/1wk"],
    [1, 2, "wk", "1-2x/1wk"],
    [2, undefined, "mo", "2x/1mo"]
  ])("shows current frequency %s-%s per %s in short form", (frequency, frequencyMax, unit, expected) => {
    const input = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: unit === "wk" ? "WK" : "MO" }] },
        repeat: { frequency: frequency as number, frequencyMax: frequencyMax as number | undefined,
          period: 1, periodUnit: unit as FhirPeriodUnit } }
    }] }] };
    const before = JSON.stringify(input);
    expect(formatSig(input, "short", { locale: "en" }).toLowerCase()).toContain(expected as string);
    expect(JSON.stringify(input)).toBe(before);
    input.step[0].component[0].timing.repeat.frequency = 1;
    input.step[0].component[0].timing.repeat.frequencyMax = undefined;
    expect(formatSig(input, "short", { locale: "en" })).toContain(unit === "wk" ? "WK" : "MO");
  });

  it.each([
    [2, 3, FhirPeriodUnit.Day, "2-3x/1-2d"],
    [2, undefined, FhirPeriodUnit.Month, "2x/1-2mo"]
  ] as const)("keeps frequency and period ranges together in short form", (frequency, frequencyMax, periodUnit, expected) => {
    const input = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency, frequencyMax, period: 1, periodMax: 2, periodUnit } } };
    expect(formatSig(input, "short", { locale: "en" }).toLowerCase()).toContain(expected);
  });

  it("keeps deletion of a projected duration annotation while retaining unprojected source-unit metadata", () => {
    const source = {
      low: { value: 48, unit: "hours", code: "h", system: "http://unitsofmeasure.org",
        _value: { id: "number" }, _unit: { id: "authored-hour" }, _code: { id: "hour-code" } },
      high: { value: 3, unit: "days", code: "d", system: "http://unitsofmeasure.org" }
    };
    const sourceBefore = JSON.stringify(source);
    const projected = projectCourseDurationRange(source);
    delete projected.range.low!._value;
    const input = { modifierExtension: [projected.source!], timing: { repeat: { boundsRange: projected.range } } };
    const before = JSON.stringify(input);
    const restored = getAnchoredCourseDuration(input)!.valueRange!.low!;
    expect(restored).toMatchObject({ value: 48, unit: "hours", code: "h",
      _unit: { id: "authored-hour" }, _code: { id: "hour-code" } });
    expect(restored._value).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(source)).toBe(sourceBefore);
  });
});
