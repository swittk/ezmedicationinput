import { describe, expect, it } from "vitest";
import {
  formatSig, formatParseBatch, fromFhir, fromFhirDosage, parseSig, nextDueDoses, toFhirR5Dosages,
  parseInstructionActions, formatCanonicalCourse, projectCanonicalCourse, importCanonicalCourse,
} from "../src/index";
import { encodeR6SourceMetadata, PARALLEL_COMPONENT_PHASE_ORIGIN_URL, withDosageEditProvenance } from "../src/dosage-course";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { formatCanonicalClause } from "../src/format";
import { canonicalFromFhir, CYCLE_DAY_ELIGIBILITY_EXTENSION_URL } from "../src/fhir";
import { registerSigLocalization, resolveSigLocalization } from "../src/i18n";
import { ENGLISH_COURSE } from "../src/locales/course/en";
import { THAI_COURSE } from "../src/locales/course/th";
import { simpleQuantityForR5, getQuantityComparator } from "../src/fhir-quantity-operator";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { realizeInstructionAction } from "../src/instruction-graph";
import { AdviceArgumentRole, EventTiming, FhirPeriodUnit, RouteCode } from "../src/types";
import type { FhirDosage, FhirR6Dosage, FhirR6DosageInstruction } from "../src/types";

const tabletQuantity = { value: 1, unit: "tab" };
const tablet: FhirR6Dosage = {
  doseAndRate: [{ doseQuantity: tabletQuantity }],
  timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
};
const cap = { doseLimit: [{ scope: "period" as const,
  valueQuantity: { value: 8, unit: "tab" }, period: { value: 1, unit: "d" } }] };
const normalized = { locale: "en", realizationMode: "normalized" as const };

describe("review 21 current structured course preview", () => {

  it("retains independently structured directions beside a live cap without replaying its opaque stale header", () => {
    const raw: FhirR6DosageInstruction = {
      renderedInstruction: "Take 1 tablet twice daily, maximum 3 tablets per day",
      safety: { doseLimit: [{ scope: "period", valueQuantity: { value: 4, unit: "tab" },
        period: { value: 1, unit: "d" } }] },
      step: [{ component: [{ doseAndRate: tablet.doseAndRate,
        timing: { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } } }] }]
    };
    const saved = JSON.stringify(raw);
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("1 tablet twice daily");
    expect(text).toContain("4 tab / 1 d");
    expect(text).not.toContain("maximum 3");
    expect(JSON.stringify(raw)).toBe(saved);
  });

  it("keeps the shared course cap in batch preview and an ordinary custom separator", () => {
    const batch = fromFhir({ safety: cap, step: [{ component: [tablet] }] }, normalized);
    for (const style of ["short", "long"] as const) {
      const text = formatParseBatch(batch, style, " | ");
      expect(text).toContain("Across this course: max per period: 8 tab / 1 d");
      expect(text.match(/8 tab/g)).toHaveLength(1);
    }
    const twoTablets: FhirR6Dosage = {
      ...tablet, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }]
    };
    const ordinary = fromFhir({ step: [{ component: [tablet, twoTablets] }] }, normalized);
    expect(ordinary.items).toHaveLength(2);
    expect(ordinary.items[0].longText).toContain("1 tablet");
    expect(ordinary.items[1].longText).toContain("2 tablets");
    const joined = formatParseBatch(ordinary, "long", " | ");
    expect(joined.split(" | ")).toHaveLength(2);
    expect(joined).toBe(ordinary.items.map(item => item.longText).join(" | "));
  });

  it("uses the live R6 cadence and dose in normalized preview while retaining the authored source", () => {
    const source = "Take 1 tablet twice daily";
    const raw = JSON.parse(JSON.stringify(parseSig(source).fhirNext)) as FhirR6DosageInstruction;
    raw.safety = cap;
    raw.step[0].component[0].timing!.repeat!.frequency = 3;
    raw.step[0].component[0].doseAndRate![0].doseQuantity!.value = 2;
    const saved = JSON.stringify(raw);
    for (const text of [
      formatSig(raw, "long", normalized),
      fromFhir(raw, normalized).longText,
      formatCanonicalCourse(courseFromR6(raw), "long", normalized),
    ]) {
      expect(text).toMatch(/2 tablets/i);
      expect(text).toMatch(/three times daily/i);
      expect(text).toContain("8 tab / 1 d");
      expect(text).not.toContain("twice daily");
    }
    expect(JSON.stringify(raw)).toBe(saved);
    expect(raw.renderedInstruction).toBe(source);
    expect(formatSig({ renderedInstruction: source }, "long", normalized)).toBe(source);
  });

  it.each(["2026-11-20T15:00:00Z", "2026-11-20T15:30:00+07:00"])(
    "preserves every authored event clock and offset: %s", event => {
      const raw: FhirR6DosageInstruction = { step: [{ component: [{
        doseAndRate: tablet.doseAndRate, timing: { event: [event] },
      }] }] };
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const text = formatSig(raw, style, { locale, realizationMode: "normalized" });
        expect(text).toContain(event);
      }
      expect(fromFhir(raw).meta.canonical.course!.stages[0].administrations[0].schedule?.explicitEvents)
        .toEqual([event]);
      expect(nextDueDoses(raw, { from: event, orderedAt: event, timeZone: "UTC", limit: 1 })
        .map(Date.parse)).toEqual([Date.parse(event)]);
    }
  );

  it("keeps date-only events date-only", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: tablet.doseAndRate, timing: { event: ["2026-11-20"] },
    }] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toMatch(/20 Nov 2026/);
    expect(text).not.toMatch(/T00:00|00:00|Z/);
  });

  it.each(["component", "stage", "course"] as const)(
    "retains a %s ifExceeded instruction with and without a numeric limit", scope => {
      const action = "Hold the next dose and call the clinic";
      for (const numeric of [false, true]) {
        const safety = { ...(numeric ? cap : {}), ifExceeded: action };
        const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet }] }] };
        if (scope === "component") {
          raw.step[0].component[0].safety = safety;
          raw.step[0].component.push({ ...tablet,
            doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] });
        }
        else if (scope === "stage") {
          raw.step[0].safety = safety;
          raw.step.push({ component: [tablet] });
        }
        else raw.safety = safety;
        const text = fromFhir(raw, normalized).longText;
        expect(text).toContain("If the limit is exceeded: " + action);
        expect(text.split(action)).toHaveLength(2);
        if (numeric) expect(text).toContain("8 tab / 1 d");
        if (scope === "component") {
          expect(text).not.toContain("Across this course:");
          expect(text).not.toContain("Within this stage:");
          const [firstComponent, secondComponent] = text.split("2 tablets");
          expect(firstComponent).toContain("1 tablet");
          expect(firstComponent).toContain(action);
          if (numeric) expect(firstComponent).toContain("8 tab / 1 d");
          expect(secondComponent).toBeDefined();
          expect(secondComponent).not.toContain(action);
          expect(secondComponent).not.toContain("8 tab / 1 d");
        }
        const thai = fromFhir(raw, { ...normalized, locale: "th" }).longText;
        expect(thai).toContain("หากเกินขีดจำกัด: " + action);
        expect(thai.split(action)).toHaveLength(2);
        if (scope === "stage") {
          const stageSection = text.split("Within this stage: ")[1]?.split(" then ")[0];
          expect(stageSection).toContain(action);
          if (numeric) expect(stageSection).toContain("8 tab / 1 d");
          expect(text).not.toContain("Across this course:");
          expect(text.split(" then ")[0]).toContain(action);
          expect(text.split(" then ").slice(1).join(" then ")).not.toContain(action);
        }
        if (scope === "course") expect(text).toContain("Across this course:");
      }
    }
  );

  it("recognizes a safety-only R6 header in both public entry points", () => {
    const raw = { safety: { ...cap, ifExceeded: "Call the clinic" } };
    expect(formatSig(raw, "long", normalized)).toBe(fromFhir(raw, normalized).longText);
    expect(formatSig(raw, "long", normalized)).toContain("8 tab / 1 d");
    expect(formatSig({ safety: { ifExceeded: "Call the clinic" } }, "long", normalized))
      .toContain("Across this course: If the limit is exceeded: Call the clinic");
  });

  it("renders a later ordinary dose after a rate-only entry without duplicating a first dose", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      timing: tablet.timing,
      doseAndRate: [{ rateQuantity: { value: 5, unit: "mL/h" } },
        { doseQuantity: { value: 10, unit: "mL" } },
        { doseQuantity: { value: 2, unit: "mg" } }],
    }] }] };
    const text = formatSig(raw, "long", normalized);
    for (const amount of ["5 mL/h", "10 mL", "2 mg"]) expect(text.split(amount)).toHaveLength(2);
    const single = formatSig({ step: [{ component: [tablet] }] }, "long", normalized);
    expect(single.match(/1 tablet/g)).toHaveLength(1);
  });

  it("does not let component text hide a structured blood-pressure condition", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, text: "Take 1 tablet daily",
      condition: [{ code: { text: "SBP" }, operation: "gt",
        valueQuantity: { value: 160, unit: "mmHg" } }],
    }] }] };
    const text = fromFhir(raw, normalized).longText;
    expect(text).toMatch(/1 tablet/i);
    expect(text).toContain("only if SBP > 160 mmHg");
    expect(raw.step[0].component[0].text).toBe("Take 1 tablet daily");
  });

  it.each([
    [{ low: { unit: "mg" }, high: { value: 1, unit: "g" } }, /(?:up to|<=|≤) ?1 g/, "1 mg"],
    [{ low: { value: 2, unit: "mg" }, high: { unit: "g" } }, /(?:at least|>=|≥) ?2 mg/, "2 g"],
  ] as const)("takes the unit from a valued one-sided range endpoint", (doseRange, expected, wrong) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange }], timing: tablet.timing,
    }] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toMatch(expected);
    expect(text).not.toContain(wrong);
  });

  it("shows distinct two-sided range units and both endpoint qualifiers", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseRange: { low: simpleQuantityForR5({ value: 500, unit: "mg", comparator: ">=" }),
        high: simpleQuantityForR5({ value: 1, unit: "g", comparator: "<=" }) } }],
    }] }] };
    expect(formatSig(raw, "long", normalized)).toContain(">=500 mg – <=1 g");
  });
});

describe("review 21 R5 quantity and indication import", () => {
  it("uses a coded quantity unit for a qualified scalar and respects its authored display unit", () => {
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: simpleQuantityForR5({
      value: 500, code: "mg", system: "http://unitsofmeasure.org", comparator: "~",
    }) }] };
    expect(canonicalFromFhir(row).dose).toMatchObject({ value: 500, unit: "mg", comparator: "~" });
    expect(formatSig(row, "long", normalized)).toMatch(/approximately 500 mg/i);
    row.doseAndRate![0].doseQuantity!.unit = "milligrams";
    expect(canonicalFromFhir(row).dose?.unit).toBe("milligrams");
  });

  it.each([false, true])("retains every PRN reason independently of array order (%s)", reverse => {
    const translated = { _text: { extension: [{
      url: "http://hl7.org/fhir/StructureDefinition/translation",
      extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: "คลื่นไส้" }],
    }] } };
    const pain = { text: "pain" };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: tabletQuantity }],
      asNeededFor: reverse ? [pain, translated] : [translated, pain] };
    const clause = canonicalFromFhir(row);
    expect(clause.prn?.enabled).toBe(true);
    expect(clause.prn?.reasons).toHaveLength(2);
    expect(clause.prn?.reasons?.some(reason => reason.text === "pain")).toBe(true);
    expect(clause.prn?.reasons?.some(reason => reason.i18n?.th === "คลื่นไส้")).toBe(true);
    expect(formatSig(row, "long", normalized)).toMatch(/as needed.*pain/i);
    expect(formatSig(row, "long", { locale: "th", realizationMode: "normalized" })).toContain("คลื่นไส้");
    expect(canonicalFromFhir({ doseAndRate: [{ doseQuantity: tabletQuantity }] }).prn).toBeUndefined();
  });
});

describe("review 21 source graph amount ownership", () => {
  it("renders the unchanged preparation amount once beside an amountless rich drink action", () => {
    const source = "Dissolve 2 tablets in water, then drink slowly";
    const actions = parseInstructionActions(source);
    const drink = actions.find(action => action.predicate.lemma === "drink")!;
    drink.args = [{ role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" }];
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...drink.span } };
    const clause = canonicalFromFhir(parseSig("Drink 2 tablets").fhir[0]);
    clause.instructionGraph = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!]);
    const saved = JSON.stringify(clause.instructionGraph);
    for (const locale of ["en", "th"]) {
      const text = formatCanonicalClause(clause, "long", resolveSigLocalization(locale), normalized);
      expect(text.match(locale === "en" ? /2 tablets/g : /2 เม็ด/g)).toHaveLength(1);
      expect(text.toLowerCase()).toContain(locale === "en" ? "dissolve" : "ละลาย");
      expect(text.toLowerCase()).toContain(locale === "en" ? "drink" : "ดื่ม");
    }
    expect(JSON.stringify(clause.instructionGraph)).toBe(saved);
  });

  it.each(["fresh", "persisted"] as const)(
    "does not revive a removed %s dose but retains duration and the independent spit action", kind => {
      const source = "Swish 10 mL for 30 seconds, then spit";
      const parsed = parseSig(source);
      const row = kind === "fresh" ? parsed.items[0].fhir
        : JSON.parse(JSON.stringify(parsed.fhir[0])) as FhirDosage;
      const savedGraph = canonicalFromFhir(row).instructionGraph;
      delete row.doseAndRate;
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(row, "long", { locale: "en", realizationMode });
        expect(text).not.toMatch(/10\s*mL/i);
        expect(text.toLowerCase()).toContain("30 seconds");
        expect(text.toLowerCase()).toContain("spit");
      }
      expect(canonicalFromFhir(row).instructionGraph).toEqual(savedGraph);
    }
  );

  it("uses preserved partial quantity text instead of a unit-only normalized token", () => {
    const actions = parseInstructionActions("Dissolve 2 tablets in water");
    const action = actions[0];
    const amount = action.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    amount.text = "up to the prescribed amount";
    amount.normalized = "mg";
    amount.quantity = { unit: "mg", comparator: "<=" };
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: "Dissolve up to the prescribed amount in water", actions,
    })!])!;
    for (const locale of ["en", "th"]) {
      expect(realizeInstructionAction(graph.actions[0], locale)).toContain("up to the prescribed amount");
    }
    expect(graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toEqual({ unit: "mg", comparator: "<=" });
  });
});

describe("review 21 dimensional quantity grammar", () => {
  it.each([
    ["about .5m units", 500000, "U", "~"], ["~.5m units", 500000, "U", "~"],
    ["about .5 mg", 0.5, "mg", "~"], [".5m units", 500000, "U", undefined],
    [".5M IU", 500000, "IU", undefined], ["≤.5m IU", 500000, "IU", "<="],
  ] as const)("keeps the numeric multiplier and comparator together in %s", (source, value, unit, comparator) => {
    const parsed = parseSig(source);
    const quantity = parsed.fhir[0].doseAndRate![0].doseQuantity!;
    expect(quantity).toMatchObject({ value, unit });
    expect(getQuantityComparator(quantity)).toBe(comparator);
    expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value, unit });
    expect(parsed.meta.canonical.clauses[0].dose?.comparator).toBe(comparator);
  });

  it.each([
    ["5 mL/h IV for 2 hours", 5, "mL/h", undefined, 2],
    ["5 mL per hour intravenously for 2 hours", 5, "mL/h", undefined, 2],
    ["IV @100mL/hr", 100, "mL/h", undefined, undefined],
    ["IV @ 100 mL/hr", 100, "mL/h", undefined, undefined],
    ["IV @~100mL/hr", 100, "mL/h", "~", undefined],
    ["Infuse heparin IV at approximately 1000 units / hr", 1000, "[iU]/h", "~", undefined],
    ["Infuse heparin IV at ~1000units/hr", 1000, "[iU]/h", "~", undefined],
  ] as const)("retains the licensed rate in %s", (source, value, unit, comparator, duration) => {
    const parsed = parseSig(source);
    const component = parsed.fhirNext.step[0].component[0];
    const amount = component.doseAndRate![0];
    expect(amount.rateQuantity).toMatchObject({ value, unit });
    expect(getQuantityComparator(amount.rateQuantity)).toBe(comparator);
    for (const step of parsed.fhirNext.step) for (const item of step.component)
      for (const dose of item.doseAndRate ?? []) expect(dose.doseQuantity).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].route?.code).toBe(RouteCode["Intravenous route"]);
    if (duration !== undefined) expect(component.timing?.repeat)
      .toMatchObject({ duration, durationUnit: FhirPeriodUnit.Hour });
  });

  it.each(["100 mL/hr", "100 units/hr", "approximately 100 units / hr"])(
    "does not detach a scalar dose from an unlicensed per-time amount: %s", source => {
      const parsed = parseSig(source);
      for (const step of parsed.fhirNext.step) for (const component of step.component)
        for (const amount of component.doseAndRate ?? []) {
          expect(amount.doseQuantity).toBeUndefined();
          expect(amount.rateQuantity).toBeUndefined();
        }
      expect(parsed.input).toBe(source);
      const displayedSource = [parsed.fhirNext.renderedInstruction,
        ...(parsed.fhirNext.step ?? []).flatMap(step => step.component.map(component => component.text))];
      expect(displayedSource).toContain(source);
    }
  );

  it("keeps a biologic-activity scalar distinct from a rate and @ clocks distinct from rate markers", () => {
    const scalar = parseSig("Inject approximately 1000 units once").fhirNext.step[0].component[0].doseAndRate![0];
    expect(scalar.doseQuantity).toMatchObject({ value: 1000, unit: "U" });
    expect(getQuantityComparator(scalar.doseQuantity)).toBe("~");
    expect(scalar.rateQuantity).toBeUndefined();
    const clock = parseSig("Take 1 tablet @08:00").fhirNext.step[0].component[0];
    expect(clock.timing?.repeat?.timeOfDay).toEqual(["08:00:00"]);
    expect(clock.doseAndRate![0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
  });

  it.each(["at approximately", "@ approximately", "at most", "at least"])(
    "keeps the weight-rate marker out of an anatomical site: %s", marker => {
      const parsed = parseSig("Infuse IV " + marker + " 0.1 mcg/kg/min");
      const component = parsed.fhirNext.step[0].component[0];
      expect(component.site).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0].site).toBeUndefined();
      expect(parsed.meta.leftoverText).toBeUndefined();
      expect(component.doseAndRate![0].rateQuantity).toMatchObject({ value: 0.1, unit: "ug/kg/min" });
      expect(getQuantityComparator(component.doseAndRate![0].rateQuantity))
        .toBe(marker === "at most" ? "<=" : marker === "at least" ? ">=" : "~");
    }
  );

  it("keeps a 24-hour delay elapsed across the spring DST transition", () => {
    const parsed = parseSig("Take 1 tablet once in 24 hours");
    const course = parsed.meta.canonical.course!;
    expect(course.stages[0].start?.displacement)
      .toMatchObject({ value: 24, unit: "h" });
    const options = { from: "2026-03-07T12:00:00-05:00", orderedAt: "2026-03-07T12:00:00-05:00",
      timeZone: "America/New_York", limit: 1 };
    for (const input of [parsed.fhirNext, parsed.fhir, course]) {
      expect(nextDueDoses(input, options)).toEqual(["2026-03-08T13:00:00-04:00"]);
    }
  });
});

describe("review 21 locale facets and grammar number", () => {
  it("inherits missing clause facets from a regional registration's base language", () => {
    registerSigLocalization({ locale: "th-TH", course: THAI_COURSE });
    const regional = resolveSigLocalization("th-TH")!;
    const base = resolveSigLocalization("th")!;
    const dose = { step: [{ component: [tablet] }] };
    for (const style of ["short", "long"] as const)
      expect(formatSig(dose, style, { locale: regional.locale }))
        .toBe(formatSig(dose, style, { locale: base.locale }));
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-TH" })).toContain("เม็ด");
  });

  it("refreshes a partial region after re-registering its base without scanning on ordinary lookup", () => {
    const before = ({ defaultText }: { defaultText: string }) => "Before " + defaultText;
    const after = ({ defaultText }: { defaultText: string }) => "After " + defaultText;
    const regionalShort = ({ defaultText }: { defaultText: string }) => "Short " + defaultText;
    registerSigLocalization({
      locale: "zz",
      formatShort: before,
      formatLong: before,
      course: ENGLISH_COURSE,
    });
    registerSigLocalization({ locale: "zz-ZZ", formatShort: regionalShort });
    const initial = resolveSigLocalization("zz-ZZ")!;
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "zz-ZZ" }))
      .toContain("Before ");
    expect(formatSig({ step: [{ component: [tablet] }] }, "short", { locale: "zz-ZZ" }))
      .toContain("Short ");
    expect(initial.course).toBe(ENGLISH_COURSE);
    registerSigLocalization({
      locale: "zz",
      formatShort: after,
      formatLong: after,
      course: ENGLISH_COURSE,
    });
    const updated = resolveSigLocalization("zz-ZZ")!;
    expect(updated).not.toBe(initial);
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "zz-ZZ" }))
      .toContain("After ");
    expect(formatSig({ step: [{ component: [tablet] }] }, "short", { locale: "zz-ZZ" }))
      .toContain("Short ");
    expect(updated.course).toBe(ENGLISH_COURSE);
  });

  it("inherits a missing regional course facet while preserving exact clause callbacks", () => {
    const formatLong = () => "LOCAL DOSE.";
    registerSigLocalization({ locale: "th-extra", formatLong });
    const localization = resolveSigLocalization("th-extra")!;
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toBe("LOCAL DOSE.");
    expect(localization.course).toBe(THAI_COURSE);
    expect(formatSig({ safety: cap, step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toContain("ตลอดแผนการใช้ยานี้:");
    registerSigLocalization({ locale: "th-extra", course: ENGLISH_COURSE });
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th-extra" }))
      .toBe(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "th" }));
  });

  it("uses singular administration for one and plural wording for multiple/ranged/limited counts", () => {
    expect(ENGLISH_COURSE.administrations("1", "day")).toBe("1 administration per day");
    expect(ENGLISH_COURSE.administrations("2", "day")).toBe("2 administrations per day");
    expect(ENGLISH_COURSE.administrations("1–2", "day")).toBe("1–2 administrations per day");
    const raw = { safety: { doseLimit: [{ scope: "lifetime" as const, valueInteger: 1 }] } };
    expect(formatSig(raw, "long", normalized)).toContain("1 administration");
    expect(formatSig(raw, "long", normalized)).not.toContain("1 administrations");
  });
});


describe("round27 current boundary and metadata-only previews", () => {
  it.each(["stage", "member"] as const)("uses the current structured %s start while retaining old descriptive text", scope => {
    const start = { text: "2 days after follow-up", contextCode: { text: "follow-up" },
      offsetDuration: { value: 2, unit: "d", code: "d" } };
    start.offsetDuration.value = 5;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet }] }] };
    if (scope === "stage") raw.step![0].start = start;
    else raw.step![0].component[0].modifierExtension = [
      encodeR6SourceMetadata(PARALLEL_COMPONENT_PHASE_ORIGIN_URL, { start }, "step"),
    ];
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("5 days after follow-up");
    expect(text).not.toContain("2 days after follow-up");
    expect(JSON.stringify(projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext)).toContain("2 days after follow-up");
  });

  it("formats an event-relative end as the upper bound of the first stage window", () => {
    const raw: FhirR6DosageInstruction = { step: [{ end: { contextCode: { text: "follow-up" },
      offsetDuration: { value: 2, unit: "d", code: "d" } }, component: [tablet] }] };
    const text = formatSig(raw, "long", normalized);
    expect(text).toContain("Timing requires review: From treatment start until 2 days after follow-up");
    expect(text).not.toContain("onward");
  });

  it("keeps text-only external instructions visible beside nonclinical safety annotations", () => {
    const instruction = "Use the patient's separately supplied administration plan.";
    const annotation = { url: "https://example.org/safety-source", valueString: "external note" };
    const raw: FhirR6DosageInstruction = { renderedInstruction: instruction, safety: { extension: [annotation] } };
    for (const realizationMode of ["roundtrip", "normalized"] as const)
      expect(formatSig(raw, "long", { locale: "en", realizationMode })).toBe(instruction);
    expect(formatSig(raw, "long", { locale: "en" })).toBe(instruction);
    expect(projectCanonicalCourse(importCanonicalCourse(raw)).fhirNext.safety?.extension).toEqual([annotation]);
  });
});

describe("round32 retained clinical labels and incomplete amounts", () => {
  it("uses the first nonblank event coding display without inventing a date", () => {
    const raw: FhirR6DosageInstruction = { step: [{
      start: { contextCode: { coding: [
        { system: "urn:test:event", code: "123", display: " " },
        { system: "urn:test:alternate", code: "visit", display: "Follow-up visit" }
      ] }, offsetDuration: { value: 2, unit: "d" } }, component: [tablet]
    }] };
    const before = JSON.stringify(raw);
    for (const locale of ["en", "th"]) {
      const text = formatSig(raw, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain("Follow-up visit");
      expect(text).toContain(locale === "en" ? "2 days" : "2 วัน");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["quantity", "range"] as const)("keeps authored component text when %s carries no value", kind => {
    const amount = kind === "quantity" ? { doseQuantity: { unit: "tab" } }
      : { doseRange: { low: { unit: "tab" }, high: { unit: "tab" } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      text: "Take one tablet daily", doseAndRate: [amount]
    }] }] };
    const before = JSON.stringify(raw);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      expect(formatSig(raw, style, { locale, realizationMode: "normalized" })).toBe("Take one tablet daily");
    }
    expect(JSON.stringify(raw)).toBe(before);
    const live = JSON.parse(before) as FhirR6DosageInstruction;
    live.step![0].component![0].timing = { repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day } };
    const text = formatSig(live, "long", normalized);
    expect(text).toContain("twice daily");
    expect(text).not.toContain("one tablet daily");
  });

  it("retains a live R6 site qualifier beyond its recognized body-site code", () => {
    const site = { text: "left eye, lower conjunctival sac", coding: [
      { system: "http://snomed.info/sct", code: "1290031003", display: "Structure of left eye proper" }
    ] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, site: { concept: site }
    }] }] };
    const before = JSON.stringify(raw);
    const imported = fromFhir(raw, normalized);
    expect(imported.meta.canonical.clauses[0].site?.text).toBe(site.text);
    const preview = formatSig(raw, "long", normalized);
    expect(preview).toContain("left eye, lower conjunctival sac");
    expect(preview).not.toContain("right eye");
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("round32 live cycle qualifier", () => {
  it.each([
    { advice: false, days: [1, 15], label: "1, 15" },
    { advice: true, days: [1, 15], label: "1, 15" },
    { advice: false, days: [1, 2, 3, 8, 15, 16], label: "1-3, 8, 15-16" },
    { advice: true, days: [1, 2, 3, 8, 15, 16], label: "1-3, 8, 15-16" },
  ])("uses edited cycle days $label beside retained source wording (advice $advice)", ({ advice, days, label }) => {
    const qualifier = "on days 1 and 8 of each cycle";
    const modifier = { url: CYCLE_DAY_ELIGIBILITY_EXTENSION_URL, extension: [
      { url: "day", valueInteger: 1 }, { url: "day", valueInteger: 8 },
      { url: "periodDays", valueInteger: 21 },
      { url: "reason", valueCode: "unresolved-cycle-eligibility" },
      { url: "source", valueString: qualifier }
    ] };
    const text = "Take 1 tablet " + qualifier + ", maximum 2 tablets daily.";
    const row: FhirDosage = withDosageEditProvenance([{
      text, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } },
      maxDosePerPeriod: [{ numerator: { value: 2, unit: "tab" }, denominator: { value: 1, unit: "d" } }],
      modifierExtension: [modifier],
      ...(advice ? { additionalInstruction: [{ text: qualifier }] } : {})
    }], text)[0];
    formatSig(row, "long", { locale: "en", realizationMode: "roundtrip" });
    modifier.extension.splice(0, 2, ...days.map(day => ({ url: "day", valueInteger: day })));
    const before = JSON.stringify(row);
    for (const input of [row, JSON.parse(before)]) for (const locale of ["en", "th"]) {
      const current = formatSig(input, "long", { locale, realizationMode: "roundtrip" });
      expect(current).toContain((locale === "en" ? "cycle days " : "วันที่ในรอบ ") + label);
      expect(current).toContain(locale === "en" ? "21-day cycle" : "รอบละ 21 วัน");
      expect(current).not.toContain(qualifier);
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

it("round32: a code-only site edit supersedes its exact contradictory old label", () => {
  const raw: FhirR6DosageInstruction = { step: [{ component: [{
    ...tablet, site: { concept: { text: "right eye", coding: [
      { system: "http://snomed.info/sct", code: "1290031003", display: "Structure of left eye proper" }
    ] } }
  }] }] };
  const before = JSON.stringify(raw);
  const imported = fromFhir(raw, normalized);
  expect(imported.meta.canonical.clauses[0].site?.text).toBe("left eye");
  expect(formatSig(raw, "long", normalized)).toContain("left eye");
  expect(formatSig(raw, "long", normalized)).not.toContain("right eye");
  expect(JSON.stringify(raw)).toBe(before);
});

describe("round33 complete native amount and cadence previews", () => {
  const wire = (repeat: NonNullable<FhirR6Dosage["timing"]>["repeat"]): FhirR6DosageInstruction =>
    ({ step: [{ component: [{ doseAndRate: tablet.doseAndRate, timing: { repeat } }] }] });
  it.each([EventTiming.Night, EventTiming.Morning])("keeps both period endpoints for alternate %s", when => {
    for (const maximum of [undefined, 2, 3]) {
      const raw = wire({ period: 2, periodMax: maximum, periodUnit: FhirPeriodUnit.Day, when: [when] });
      for (const locale of ["en", "th"]) {
        const text = formatSig(raw, "long", { locale });
        if (maximum === 3) {
          expect(text).toContain(locale === "en" ? "2 to 3 days" : "2 ถึง 3 วัน");
          expect(text).toContain(locale === "en" ? when === EventTiming.Night ? "night" : "morning"
            : when === EventTiming.Night ? "กลางคืน" : "เช้า");
          expect(text).not.toMatch(/every other|วันเว้นคืน|เช้าเว้นเช้า/u);
        } else expect(text).toContain(locale === "en" ? when === EventTiming.Night ? "every other night" : "every other morning"
          : when === EventTiming.Night ? "วันเว้นคืน" : "เช้าเว้นเช้า");
      }
    }
  });
  it.each([
    [FhirPeriodUnit.Minute, 30, "minutes", "นาที"],
    [FhirPeriodUnit.Hour, 8, "hours", "ชั่วโมง"],
    [FhirPeriodUnit.Day, 2, "days", "วัน"],
    [FhirPeriodUnit.Week, 2, "weeks", "สัปดาห์"],
    [FhirPeriodUnit.Month, 2, "months", "เดือน"],
    [FhirPeriodUnit.Year, 2, "years", "ปี"],
  ] as const)("keeps two administrations per fixed %s period", (periodUnit, period, en, th) => {
    const raw = wire({ frequency: 2, period, periodUnit });
    const before = JSON.stringify(raw);
    expect(formatSig(raw, "long", { locale: "en" })).toContain("twice every " + period + " " + en);
    for (const style of ["short", "long"] as const)
      expect(formatSig(raw, style, { locale: "th" })).toContain("2 ครั้ง ทุก " + period + " " + th);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("keeps one administration's simple fixed interval wording", () => {
    const raw = wire({ frequency: 1, period: 8, periodUnit: FhirPeriodUnit.Hour });
    expect(formatSig(raw, "long", { locale: "en" })).toContain("every 8 hours");
    expect(formatSig(raw, "long", { locale: "en" })).not.toContain("twice");
    expect(formatSig(raw, "long", { locale: "th" })).toContain("ทุก 8 ชั่วโมง");
  });
  it.each([
    [{ frequency: 1, frequencyMax: 2 }, "1 to 2 times every 8 hours", "1 ถึง 2 ครั้ง ทุก 8 ชั่วโมง"],
    [{ frequencyMax: 2 }, "up to 2 times every 8 hours", "ไม่เกิน 2 ครั้ง ทุก 8 ชั่วโมง"]
  ])("keeps fixed-period frequency bounds %j", (frequency, en, th) => {
    const raw = wire({ ...frequency, period: 8, periodUnit: FhirPeriodUnit.Hour });
    expect(formatSig(raw, "long", { locale: "en" })).toContain(en);
    expect(formatSig(raw, "long", { locale: "th" })).toContain(th);
  });
  it.each([
    [FhirPeriodUnit.Day, "daily", "วัน"],
    [FhirPeriodUnit.Week, "weekly", "สัปดาห์"],
    [FhirPeriodUnit.Month, "monthly", "เดือน"],
    [FhirPeriodUnit.Year, "yearly", "ปี"],
  ] as const)("keeps an upper-only administration count at one %s period", (periodUnit, en, th) => {
    const raw = wire({ frequencyMax: 2, period: 1, periodUnit });
    expect(formatSig(raw, "long", { locale: "en" })).toContain("up to 2 times " + en);
    for (const style of ["short", "long"] as const)
      expect(formatSig(raw, style, { locale: "th" })).toContain(th + "ละไม่เกิน 2 ครั้ง");
  });
  it("keeps an offset weekly window distinct from an inferred daily summary", () => {
    const raw = wire({ frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Week,
      timeOfDay: ["08:00:00", "20:00:00"], startOffset: { value: 1, unit: "d" } });
    for (const locale of ["en", "th"]) {
      const text = formatSig(raw, "long", { locale, includeTimesPerDaySummary: true });
      expect(text).toContain(locale === "en" ? "2 administrations per 1 week" : "ให้ยา 2 ครั้งต่อช่วง 1 สัปดาห์");
      expect(text).toContain(locale === "en" ? "8:00 am" : "08:00");
      expect(text).toContain(locale === "en" ? "8:00 pm" : "20:00");
      expect(text).not.toMatch(/twice daily|วันละ 2 ครั้ง/u);
    }
  });
  const dose = (code: string, value: number) => ({
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/dose-rate-type", code }] },
    doseQuantity: { value, unit: "mg" }
  });
  it.each([false, true])("labels ordered and calculated amounts independently of order (%s)", reverse => {
    const amounts = [dose("calculated", 2), dose("ordered", 3)];
    if (reverse) amounts.reverse();
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, doseAndRate: amounts
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, toFhirR5Dosages(raw)]) for (const style of ["short", "long"] as const) {
      const en = formatSig(input, style, { locale: "en" });
      const th = formatSig(input, style, { locale: "th" });
      expect(en).toContain("Calculated dose: 2 mg");
      expect(en).toContain("Ordered dose: 3 mg");
      expect(en).not.toMatch(/(?:Use|Take) (?:2|3) mg/u);
      expect(th).toContain("ขนาดยาที่คำนวณ: 2 mg");
      expect(th).toContain("ขนาดยาที่สั่ง: 3 mg");
      expect(th).not.toMatch(/ใช้ครั้งละ (?:2|3) /u);
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(fromFhirDosage(toFhirR5Dosages(raw)[0]).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([false, true])("retains each-target scope on role-labelled amounts in either order (%s)", reverse => {
    const amounts = [
      { type: dose("ordered", 1).type, doseQuantity: simpleQuantityForR5({ value: 1, unit: "spray", comparator: "~" })! },
      { type: dose("calculated", 2).type, doseQuantity: { value: 2, unit: "mg" } }
    ];
    if (reverse) amounts.reverse();
    const raw: FhirR6DosageInstruction = { renderedInstruction: "Use approximately 1 spray in each nostril",
      step: [{ component: [{ route: { text: "intranasal" },
        site: { concept: { text: "both nostrils" } }, doseAndRate: amounts }] }] };
    const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
    for (const locale of ["en", "th"]) {
      const tag = locale + "-x-round33-dose-scope";
      // A course-only regional pack inherits the same dose grammar as its
      // clause callbacks; quantity wording remains a language-pack facet.
      registerSigLocalization({ locale: tag, course: locale === "en" ? ENGLISH_COURSE : THAI_COURSE });
      for (const input of [raw, rows]) {
        const text = formatSig(input, "long", { locale: tag, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "Ordered dose: approximately 1 spray (each nostril)"
          : "ขนาดยาที่สั่ง: รูจมูกข้างละ ประมาณ 1 ครั้ง");
        expect(text).toContain(locale === "en" ? "Calculated dose: 2 mg (each nostril)"
          : "ขนาดยาที่คำนวณ: รูจมูกข้างละ 2 มิลลิกรัม");
        expect(text.match(locale === "en" ? /each nostril/gu : /ข้างละ/gu)).toHaveLength(2);
      }
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(fromFhirDosage(rows[0]).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([true, false])("retains code-only equal units on a scoped role-labelled range (known low unit %s)", knownLow => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      route: { text: "intranasal" }, site: { concept: { text: "both nostrils" } },
      doseAndRate: [{ type: dose("ordered", 1).type, doseRange: {
        low: knownLow ? { value: 1, system: "http://unitsofmeasure.org", code: "mg" } : { value: 1 },
        high: { value: 2, system: "http://unitsofmeasure.org", code: "mg" }
      } }]
    }] }] };
    const before = JSON.stringify(raw);
    // A single known endpoint supplies the compact range's unit without
    // filling in or changing the retained source endpoint.
    for (const input of [raw, toFhirR5Dosages(raw)]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("Ordered dose: 1 to 2 mg (each nostril)");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("ขนาดยาที่สั่ง: รูจมูกข้างละ 1 ถึง 2 มิลลิกรัม");
    }
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("labels a single calculated dose and leaves the simple untyped dose unchanged", () => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet, doseAndRate: [dose("calculated", 2)] }] }] };
    expect(formatSig(raw, "long", { locale: "en" })).toContain("Calculated dose: 2 mg");
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
    expect(formatSig({ step: [{ component: [tablet] }] }, "long", { locale: "en" })).toContain("1 tablet once daily");
  });
  it("keeps annotation-only amount types on the ordinary untyped dose path", () => {
    const amount = { doseQuantity: { value: 1, unit: "tab" }, type: {
      id: "type-annotation", extension: [{ url: "urn:example:annotation", valueString: "kept" }],
      coding: [{ id: "coding-annotation", extension: [{ url: "urn:example:coding", valueBoolean: true }] }]
    } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ ...tablet, doseAndRate: [amount] }] }] };
    const before = JSON.stringify(raw), rows = toFhirR5Dosages(raw);
    for (const input of [raw, rows]) {
      const result = Array.isArray(input) ? fromFhirDosage(input[0]) : fromFhir(input);
      expect(result.meta.canonical.clauses[0].dose).toMatchObject({ value: 1, unit: "tab" });
      expect(formatSig(input, "long", { locale: "en" })).toContain("1 tablet once daily");
      expect(formatSig(input, "long", { locale: "en" })).not.toContain("unspecified");
    }
    expect(rows[0].doseAndRate?.[0].type).toEqual(amount.type);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([
    [{ type: dose("calculated", 2).type, doseRange: { low: { value: 2, unit: "mg" }, high: { value: 4, unit: "mg" } } },
      "Calculated dose: 2–4 mg"],
    [{ type: dose("ordered", 0).type, doseQuantity: { value: 0, unit: "mg" } }, "Ordered dose: 0 mg"],
    [{ type: { text: "locally adjusted", coding: [{ system: "urn:example:role", code: "ordered" }] },
      doseQuantity: { value: 3, unit: "mg" } }, "Dose (locally adjusted): 3 mg"],
    [{ type: dose("calculated", 2).type, doseQuantity: { unit: "mg" } }, "Calculated dose: unspecified mg"],
    [{ type: dose("calculated", 2).type, rateQuantity: { value: 2, unit: "mg/h" } }, "Calculated rate: 2 mg/h"],
  ] as const)("keeps the role on each native dose or rate choice %j", (amount, expected) => {
    const raw = { step: [{ component: [{ ...tablet, doseAndRate: [amount] }] }] } as FhirR6DosageInstruction;
    expect(formatSig(raw, "long", { locale: "en" })).toContain(expected);
    expect(fromFhir(raw).meta.canonical.clauses[0].dose).toBeUndefined();
  });
  it.each(["en", "th"])("uses the registered %s event-window facet through inherited clause formatting", locale => {
    const tag = locale + "-x-round33-window";
    registerSigLocalization({ locale: tag, course: {
      ...(locale === "en" ? ENGLISH_COURSE : THAI_COURSE),
      eventWindow: (start, end) => "REGISTERED WINDOW " + start + " -> " + end
    } });
    const parsed = parseSig("take 1 tablet from breakfast to dinner");
    const clause = { ...parsed.meta.canonical.clauses[0], schedule: {
      eventWindow: { start: EventTiming.Breakfast, end: EventTiming.Dinner }
    } };
    for (const style of ["short", "long"] as const) {
      const text = formatCanonicalClause(clause, style, resolveSigLocalization(tag));
      expect(text).toContain("REGISTERED WINDOW");
      expect(text).toContain(locale === "en" ? "breakfast" : "อาหารเช้า");
      expect(text).toContain(locale === "en" ? "dinner" : "อาหารเย็น");
    }
  });
});


describe("round34 typed recurrence and locale previews", () => {
  const code = (value: string) => ({ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: value }] });
  it.each([
    [{ frequencyMax: 2 }, "<=2x/1d", "up to 2 times daily"],
    [{ frequency: 2 }, "BID", "twice daily"],
    [{ frequency: 1, frequencyMax: 2 }, "1-2x/d", "one to two times daily"]
  ])("does not promote a frequency bound to fixed shorthand (%j)", (frequency, short, long) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, timing: { code: code("BID"), repeat: { ...frequency, period: 1, periodUnit: FhirPeriodUnit.Day } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      expect(formatSig(input, "short", normalized)).toContain(short);
      expect(formatSig(input, "long", normalized)).toContain(long);
      if (!("frequency" in frequency) || frequency.frequency !== 2)
        expect(formatSig(input, "short", normalized)).not.toContain("BID");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([
    [{ period: 8, periodUnit: FhirPeriodUnit.Hour }, false, "8 hours"],
    [{ period: 6, periodUnit: FhirPeriodUnit.Hour }, true, "6 hours"],
    [{ period: 6, periodMax: 8, periodUnit: FhirPeriodUnit.Hour }, false, "6"],
    [{ period: 6, periodUnit: FhirPeriodUnit.Day }, false, "6 days"],
    [{ frequency: 1, period: 6, periodUnit: FhirPeriodUnit.Hour }, false, "6 hours"]
  ] as const)("checks a timing code against its original offset period (%j)", (repeat, keepCode, period) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...tablet, timing: { code: code("Q6H"), repeat: { ...repeat, startOffset: { value: 1, unit: "h" } } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      const text = formatSig(input, "short", normalized);
      expect(text.includes("Q6H")).toBe(keepCode);
      expect(text).toContain(period);
      expect(text).toContain("1 hour");
      expect(text).toContain("1 tab");
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["step", "member"] as const)("shows signed %s starts without making negative day ranges", where => {
    for (const value of [-30, 30]) {
      const boundary = { anchor: "treatment-start" as const, displacement: { value, unit: "min" } };
      const native = { kind: "course" as const, stages: [{
        ...(where === "step" ? { start: boundary } : {}),
        administrations: [{ kind: "administration" as const,
          ...(where === "member" ? { phaseStart: boundary } : {}),
          amounts: [{ quantity: { value: 1, unit: "tab" } }] }]
      }] };
      const before = JSON.stringify(native);
      const r6 = projectCanonicalCourse(native).fhirNext;
      for (const input of [native, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        for (const style of ["short", "long"] as const) {
          const english = formatSig(input, style, normalized);
          const thai = formatSig(input, style, { locale: "th", realizationMode: "normalized" });
          expect(english).toContain("30 minutes " + (value < 0 ? "before" : "after") + " treatment start");
          expect(thai).toContain("30 นาที");
          expect(thai).toContain(value < 0 ? "ก่อน" : "หลัง");
          expect(english).not.toMatch(/No dose|Review timing|Days? -/u);
        }
      }
      expect(JSON.stringify(native)).toBe(before);
    }
  });

  it("uses the effective inherited and custom course facets for regenerated cycle details", () => {
    const clause = canonicalFromFhir({
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day } }
    });
    clause.schedule!.cycleDayConstraint = {
      days: [1, 2, 3, 8], periodDays: 21, cycles: 4, anchor: "2026-11-21",
      sourceText: "", reason: "unresolved-cycle-eligibility"
    };
    const inherited = resolveSigLocalization("en", { locale: "en", inherit: "th" });
    for (const style of ["short", "long"] as const) {
      const text = formatCanonicalClause(clause, style, inherited);
      expect(text).toContain("ยังระบุเวลาในรอบไม่ได้");
      expect(text).toContain("วันที่ในรอบ 1-3, 8");
      expect(text).toContain("รอบละ 21 วัน");
      expect(text).toContain("4 รอบ");
      expect(text).toContain("วันเริ่มรอบ 2026-11-21");
      expect(text).not.toContain("cycle days");
    }
    const calls: unknown[][] = [];
    const custom = resolveSigLocalization("round34-cycle", {
      locale: "round34-cycle", inherit: "en",
      course: { ...ENGLISH_COURSE, unresolvedCycleTiming: (days, periodDays, cycles, anchor) => {
        calls.push([days, periodDays, cycles, anchor]);
        return "Local cycle " + days + " | " + periodDays + " | " + cycles + " | " + anchor;
      } }
    });
    expect(formatCanonicalClause(clause, "long", custom)).toContain("Local cycle 1-3, 8 | 21 | 4 | 2026-11-21");
    expect(calls).toEqual([["1-3, 8", 21, 4, "2026-11-21"]]);
  });
});
