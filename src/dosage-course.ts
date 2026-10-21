import {
  FhirDayOfWeek, FhirDosage, FhirExtension, FhirQuantity, FhirR6Dosage, FhirR6DosageCondition,
  FhirR6DosageDetails, FhirR6DosageSafety, MedicationCondition,
  EzDosage, EzCourseMetadata
} from "./types";

/** Modifier extensions: ignoring either can change whether a dose may be given. */
export const DOSAGE_CONDITION_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-conditional-dose";
/** Separate R6 DosageCondition-level extension: the R5 Dosage modifier has
 * a different context and nested child contract, so it cannot be reused. */
export const DOSAGE_CONDITION_R6_LOGIC_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-r6-condition-logic";
export const DOSAGE_EXCLUDED_DATES_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-excluded-calendar-dates";
export const DOSAGE_DETAILS_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-r6-course-details";
/** Non-modifier metadata: preserves the author's entire literal instruction
 * without forcing ordinary R5 consumers to implement R6 safety semantics. */
export const DOSAGE_RENDERED_INSTRUCTION_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-rendered-instruction";
export const DOSAGE_EXCLUDED_WEEKDAYS_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-excluded-weekdays";
export const DOSAGE_UNRESOLVED_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-unresolved-schedule";
const CONDITION_CODE_SYSTEM = "http://hl7.org/fhir/CodeSystem/dosage-condition-code";
const INTERNAL_CONDITION_CODE_SYSTEM = "https://github.com/swittk/ezmedicationinput/fhir/CodeSystem/medication-condition";

function replacementExtensions(
  dosage: FhirDosage, url: string, value: FhirExtension | undefined
): void {
  const existing = (dosage.modifierExtension ?? []).filter(extension => extension.url !== url);
  const result = value ? [...existing, value] : existing;
  dosage.modifierExtension = result.length ? result : undefined;
}

export function getDosageCondition(dosage: FhirDosage | EzDosage): MedicationCondition | undefined {
  const expanded = dosage as EzDosage;
  if (expanded.condition?.length === 1) return conditionFromR6(expanded.condition[0]);
  if (expanded.condition?.length) {
    return { kind: "any", conditions: expanded.condition.map(conditionFromR6) };
  }
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_CONDITION_R5_URL);
  const raw = extension?.extension?.find(value => value.url === "predicate")?.valueString;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as MedicationCondition;
    return value && typeof value === "object" && typeof value.kind === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setDosageCondition(dosage: FhirDosage, condition: MedicationCondition | undefined): void {
  replacementExtensions(dosage, DOSAGE_CONDITION_R5_URL, condition ? {
    url: DOSAGE_CONDITION_R5_URL,
    extension: [{ url: "predicate", valueString: JSON.stringify(condition) }]
  } : undefined);
}

export function getDosageExcludedDates(dosage: FhirDosage | EzDosage): string[] {
  if ((dosage as EzDosage).excludedDates) return [...(dosage as EzDosage).excludedDates!];
  const extension = dosage.modifierExtension?.find(value => value.url === DOSAGE_EXCLUDED_DATES_R5_URL);
  return [...new Set((extension?.extension ?? [])
    .filter(child => child.url === "date" && /^\d{4}-\d{2}-\d{2}$/.test(child.valueDate ?? ""))
    .map(child => child.valueDate!))].sort();
}

export function setDosageExcludedDates(dosage: FhirDosage, dates: string[]): void {
  const values = [...new Set(dates)].sort();
  replacementExtensions(dosage, DOSAGE_EXCLUDED_DATES_R5_URL, values.length ? {
    url: DOSAGE_EXCLUDED_DATES_R5_URL,
    extension: values.map(valueDate => ({ url: "date", valueDate }))
  } : undefined);
}

export function getDosageExcludedWeekdays(dosage: FhirDosage): FhirDayOfWeek[] {
  const extension = dosage.extension?.find(value => value.url === DOSAGE_EXCLUDED_WEEKDAYS_R5_URL);
  return (extension?.extension ?? [])
    .filter(child => child.url === "day" && typeof child.valueCode === "string")
    .map(child => child.valueCode as FhirDayOfWeek);
}

export function setDosageExcludedWeekdays(dosage: FhirDosage, days: FhirDayOfWeek[]): void {
  const remaining = (dosage.extension ?? []).filter(value => value.url !== DOSAGE_EXCLUDED_WEEKDAYS_R5_URL);
  dosage.extension = days.length
    ? [...remaining, { url: DOSAGE_EXCLUDED_WEEKDAYS_R5_URL,
      extension: days.map(valueCode => ({ url: "day", valueCode })) }]
    : remaining.length ? remaining : undefined;
}

export function getUnresolvedDosage(dosage: FhirDosage): string | undefined {
  return dosage.modifierExtension?.find(value => value.url === DOSAGE_UNRESOLVED_R5_URL)
    ?.extension?.find(value => value.url === "reason")?.valueString;
}

export function setUnresolvedDosage(dosage: FhirDosage, reason: string | undefined): void {
  replacementExtensions(dosage, DOSAGE_UNRESOLVED_R5_URL, reason ? {
    url: DOSAGE_UNRESOLVED_R5_URL,
    extension: [{ url: "reason", valueString: reason }]
  } : undefined);
}

function describe(condition: MedicationCondition): string {
  switch (condition.kind) {
    case "measurement":
      return `${condition.name} ${condition.operation} ${condition.value}${condition.unit ? " " + condition.unit : ""}`;
    case "state": return condition.expected ? condition.name : `not ${condition.name}`;
    case "text": return condition.text;
    case "not": return `not (${describe(condition.condition)})`;
    case "all": return condition.conditions.map(describe).join(" AND ");
    case "any": return condition.conditions.map(describe).join(" OR ");
  }
}

function conditionToR6(condition: MedicationCondition): FhirR6DosageCondition {
  if (condition.kind === "measurement") {
    return {
      code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "measurement", display: condition.name }], text: condition.name },
      operation: condition.operation,
      valueQuantity: {
        value: condition.value,
        ...(condition.unit ? { unit: condition.unit } : {})
      },
      text: condition.text,
      extension: [{ url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [{ url: "predicate", valueString: JSON.stringify(condition) }] }]
    };
  }
  if (condition.kind === "state") {
    return {
      code: { coding: [{ system: CONDITION_CODE_SYSTEM, code: "problem-presents", display: "Problem Presents" }] },
      details: { text: condition.name },
      operation: "eq",
      valueBoolean: condition.expected,
      text: condition.text,
      extension: [{ url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [{ url: "predicate", valueString: JSON.stringify(condition) }] }]
    };
  }
  // FHIR R6 condition[] is OR. A whole Boolean expression must stay ONE
  // condition, with the logical tree retained in a declared extension.
  return {
    code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "expression", display: "Medication conditional expression" }] },
    text: describe(condition),
    extension: [{ url: DOSAGE_CONDITION_R6_LOGIC_URL,
        extension: [{ url: "predicate", valueString: JSON.stringify(condition) }] }]
  };
}

function conditionFromR6(value: FhirR6DosageCondition): MedicationCondition {
  const raw = value.extension?.find(extension =>
    extension.url === DOSAGE_CONDITION_R6_LOGIC_URL)?.extension
    ?.find(child => child.url === "predicate")?.valueString ??
    // Previously emitted development data used the R5 URL with an invalid
    // R6 payload. Accept it on import only; never publish that form again.
    value.extension?.find(extension =>
      extension.url === DOSAGE_CONDITION_R5_URL)?.valueString;
  if (raw) {
    try { return JSON.parse(raw) as MedicationCondition; } catch { /* use faithful original text */ }
  }
  const name = value.details?.text ?? value.code?.text ?? value.code?.coding?.[0]?.display;
  if (value.code?.coding?.[0]?.code === "problem-presents" && name && value.valueBoolean !== undefined) {
    return { kind: "state", name, expected: value.valueBoolean, text: value.text ?? name };
  }
  if (value.valueQuantity?.value !== undefined && value.operation && name &&
    ["gt", "ge", "lt", "le", "eq", "ne"].indexOf(value.operation) >= 0) {
    return {
      kind: "measurement", name, operation: value.operation as "gt" | "ge" | "lt" | "le" | "eq" | "ne",
      value: value.valueQuantity.value, unit: value.valueQuantity.unit, text: value.text ?? name
    };
  }
  return { kind: "text", text: value.text ?? JSON.stringify(value) };
}

function toR6Safety(dosage: FhirDosage): FhirR6DosageSafety | undefined {
  const doseLimit: NonNullable<FhirR6DosageSafety["doseLimit"]> = [];
  for (const maximum of dosage.maxDosePerPeriod ?? []) {
    if (!maximum.numerator || !maximum.denominator) continue;
    doseLimit.push({
      scope: "period", valueQuantity: { ...maximum.numerator },
      period: { ...maximum.denominator }
    });
  }
  if (dosage.maxDosePerAdministration) {
    doseLimit.push({ scope: "administration", valueQuantity: { ...dosage.maxDosePerAdministration } });
  }
  if (dosage.maxDosePerLifetime) {
    doseLimit.push({ scope: "lifetime", valueQuantity: { ...dosage.maxDosePerLifetime } });
  }
  return doseLimit.length ? { doseLimit } : undefined;
}

/** Lift real R6 concepts once into the familiar flat R5 dosage shape. */
export function toEzDosages(dosages: readonly (FhirDosage | EzDosage)[]): EzDosage[] {
  return dosages.map(dosage => {
    const input = dosage as EzDosage;
    // Lift each missing field independently. A preexisting siteReference or
    // expression does not imply an unrelated R5 maximum/condition was lifted.
    const needsCondition = !input.condition?.length &&
      !!dosage.modifierExtension?.some(ext => ext.url === DOSAGE_CONDITION_R5_URL);
    const needsSafety = !input.safety &&
      (!!dosage.maxDosePerPeriod?.length ||
        !!dosage.maxDosePerAdministration || !!dosage.maxDosePerLifetime);
    const needsDates = input.excludedDates === undefined &&
      !!dosage.modifierExtension?.some(ext => ext.url === DOSAGE_EXCLUDED_DATES_R5_URL);
    if (!needsCondition && !needsSafety && !needsDates) return input;
    const predicate = needsCondition ? getDosageCondition(dosage) : undefined;
    const safety = needsSafety ? toR6Safety(dosage) : undefined;
    const dates = needsDates ? getDosageExcludedDates(dosage) : undefined;
    return {
      ...input,
      ...(predicate ? { condition: [conditionToR6(predicate)] } : {}),
      ...(safety ? { safety } : {}),
      ...(dates?.length ? { excludedDates: dates } : {})
    };
  });
}

/** Project one EZMED dosage into a native R6 dosage component. */
function toR6Dosage(dosage: FhirDosage | EzDosage): FhirR6Dosage {
  const {
    sequence: _sequence, site, maxDosePerPeriod: _maxPeriod,
    maxDosePerAdministration: _maxAdministration, maxDosePerLifetime: _maxLifetime,
    condition: ownConditions, safety: ownSafety,
    siteReference, excludedDates,
    modifierExtension, extension, ...rest
  } = dosage as EzDosage;
  const predicate = ownConditions?.length ? undefined : getDosageCondition(dosage);
  const safety = ownSafety ?? toR6Safety(dosage);
  // A caller may edit the public excludedDates field directly, without
  // updating the older R5 modifier. Rebuild that modifier from the live
  // field (including [] to remove exclusions) before projecting to R6.
  const encoded: FhirDosage = { modifierExtension };
  if (excludedDates !== undefined) setDosageExcludedDates(encoded, excludedDates);
  const r6Modifiers = encoded.modifierExtension?.filter(value =>
    value.url !== DOSAGE_CONDITION_R5_URL &&
    value.url !== DOSAGE_DETAILS_R5_URL);
  return {
    ...rest,
    ...(extension?.some(value => value.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) ? {
      extension: extension.filter(value =>
        value.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL)
    } : {}),
    ...(r6Modifiers?.length ? { modifierExtension: r6Modifiers } : {}),
    ...(site || siteReference ? { site: {
      ...(site ? { concept: site } : {}),
      ...(siteReference ? { reference: siteReference } : {})
    } } : {}),
    ...(ownConditions?.length ? { condition: ownConditions } :
      predicate ? { condition: [conditionToR6(predicate)] } : {}),
    ...(safety ? { safety } : {})
  };
}

function fromR6Dosage(dosage: FhirR6Dosage, sequence: number): FhirDosage {
  const { site, condition, safety, doseAndRate, ...rest } = dosage;
  const output: FhirDosage = {
    ...rest,
    sequence,
    ...(site?.concept ? { site: site.concept } : {}),
    ...(doseAndRate ? { doseAndRate: doseAndRate.map(({ doseExpression: _doseExpr,
      rateExpression: _rateExpr, ...entry }) => entry) } : {})
  };
  for (const limit of safety?.doseLimit ?? []) {
    // R5 maximum-dose fields are not as expressive as R6 safety limits.
    // If an R6-only comparator cannot be expressed in the corresponding
    // R5 Quantity/SimpleQuantity, leave it in the retained R6 modifier.
    const quantity = limit.valueQuantity;
    if (!quantity) continue;
    const { comparator, ...simple } = quantity;
    if (limit.scope === "period" && limit.period && comparator !== "~") {
      const { comparator: periodComparator, ...period } = limit.period;
      if (!periodComparator) {
        output.maxDosePerPeriod = [...(output.maxDosePerPeriod ?? []), {
          numerator: { ...simple, ...(comparator ? { comparator } : {}) },
          denominator: period
        }];
      }
    }
    // A general R6 Quantity comparator cannot be represented in R5 maxima.
    if (comparator) continue;
    if (limit.scope === "administration") {
      output.maxDosePerAdministration = simple;
    }
    if (limit.scope === "lifetime") {
      output.maxDosePerLifetime = simple;
    }
  }
  if (condition?.length === 1) {
    setDosageCondition(output, conditionFromR6(condition[0]));
  } else if (condition?.length) {
    // R6 multiple conditions are alternatives (OR).
    setDosageCondition(output, {
      kind: "any",
      conditions: condition.map(conditionFromR6)
    });
  }
  return output;
}

type ProjectionValue =
  | string | number | boolean | null
  | ProjectionValue[] | { [key: string]: ProjectionValue };

/** Compare actual dosage content after schema validation. FHIR validators may
 * add known Coding.system/version metadata where a code was already supplied,
 * and omit optional empty arrays. Neither is an edited medication instruction.
 * Existing system/version values and every clinical field remain significant.
 */
function comparableJson(value: object | undefined): ProjectionValue | undefined {
  // JSON-safe FHIR datatypes have no cyclic references; the clone provides
  // a typed, plain-object comparison shape without asserting an index signature.
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as ProjectionValue;
}

function equivalentProjection(
  original: ProjectionValue | undefined,
  current: ProjectionValue | undefined,
  context: "general" | "coding-list" | "coding-item" = "general"
): boolean {
  if (original === current) return true;
  if (Array.isArray(original) || Array.isArray(current)) {
    if (!Array.isArray(original) || !Array.isArray(current) ||
        original.length !== current.length) return false;
    const nextContext = context === "coding-list" ? "coding-item" : "general";
    return original.every((part, i) =>
      equivalentProjection(part, current[i], nextContext));
  }
  if (original === null || current === null ||
      typeof original !== "object" || typeof current !== "object")
    return false;
  const before = original as Record<string, ProjectionValue>;
  const after = current as Record<string, ProjectionValue>;
  for (const key of Object.keys(before)) {
    if (!(key in after)) return false;
    if (!equivalentProjection(before[key], after[key],
      key === "coding" ? "coding-list" : "general")) return false;
  }
  for (const key of Object.keys(after)) {
    if (key in before) continue;
    if (context === "coding-item" && (key === "system" || key === "version"))
      continue;
    return false;
  }
  return true;
}

/**
 * Inspect the live R5 projection independently of the embedded R6 snapshot.
 * Modifier metadata is deliberately excluded from the comparison: it can
 * describe a course but must never replace subsequently edited dosage values.
 */
function comparableLiveDosage(dosage: FhirDosage | EzDosage): string {
  const {
    condition: _condition, safety: _safety, siteReference: _siteReference,
    excludedDates: _excludedDates, doseAndRate, extension, modifierExtension,
    ...r5
  } = dosage as EzDosage;
  const clean = (value: object | number | boolean | string | null | undefined): object | number | boolean | string | null | undefined => {
    if (Array.isArray(value)) return value.length ? value.map(clean) : undefined;
    if (value === null || typeof value !== "object") return value;
    const next: Record<string, object | number | boolean | string | null | undefined> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = clean((value as Record<string, object | number | boolean | string | null | undefined>)[key]);
      if (entry !== undefined) next[key] = entry;
    }
    return next;
  };
  const base = {
    ...r5,
    ...(doseAndRate ? { doseAndRate: doseAndRate.map(entry => {
      const { doseExpression: _dose, rateExpression: _rate, ...r5Entry } = entry;
      return r5Entry;
    }) } : {}),
    ...(extension?.some(item => item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL)
      ? { extension: extension.filter(item =>
        item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL) } : {}),
    ...(modifierExtension?.some(item => item.url !== DOSAGE_DETAILS_R5_URL)
      ? { modifierExtension: modifierExtension.filter(item =>
        item.url !== DOSAGE_DETAILS_R5_URL) } : {})
  };
  return JSON.stringify(clean(base));
}

/**
 * A retained R6 course is authoritative only for fields R5 cannot express:
 * relative step windows, non-R5 expressions and full-course safety rules.
 * Never let the cached component values override edited live R5 dosages.
 */
function reconcileRetainedCourse(
  retained: FhirR6DosageDetails,
  dosages: readonly (FhirDosage | EzDosage)[],
  editedInstruction?: string
): FhirR6DosageDetails {
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of dosages) {
    const sequence = dosage.sequence ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1)
      throw new Error("Cannot reconcile R6 course: invalid edited Dosage.sequence");
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence)!.push(dosage);
  }
  const sequences = [...groups.keys()].sort((a, b) => a - b);
  if (sequences.length !== retained.step.length ||
      sequences.some((sequence, i) => sequence !== i + 1)) {
    throw new Error("Edited R5 dosage stages no longer match the retained relative R6 course. Update the R6 step start/end metadata when adding or removing stages.");
  }
  const originalCount = retained.step.reduce(
    (total, step) => total + step.component.length, 0);
  let unchanged = originalCount === dosages.length;
  const steps: FhirR6DosageDetails["step"] = [];
  for (let i = 0; i < retained.step.length; i++) {
    const step = retained.step[i];
    const live = groups.get(i + 1)!;
    const componentCountChanged = live.length !== step.component.length;
    if (componentCountChanged) {
      unchanged = false;
      // When a stage contains R6-only properties, removing or adding a row
      // makes the source-to-component association ambiguous. Requiring an
      // updated R6 course is necessary to avoid transplanting its advanced
      // details onto a different medication administration.
      if (step.component.some(component =>
        component.site?.reference ||
        component.doseAndRate?.some(rate =>
          rate.doseExpression || rate.rateExpression) ||
        component.safety?.ifExceeded ||
        component.safety?.doseLimit?.some(limit => limit.valueExpression))) {
        throw new Error("An R6 treatment stage gained or lost components with R6-only expression, site or safety metadata. Update the R6 course component mapping to preserve those fields correctly.");
      }
    }
    const components: FhirR6Dosage[] = [];
    // Match every unchanged R5 component BEFORE assigning an original
    // position to a changed row. A swapped-and-edited dosage must not claim
    // the original slot of an unedited dosage that appears later.
    const originalProjections = step.component.map(component =>
      JSON.parse(comparableLiveDosage(fromR6Dosage(component, i + 1))) as ProjectionValue);
    const assigned: number[] = live.map(() => -1);
    const usedOriginalIndices = new Set<number>();
    for (let j = 0; j < live.length; j++) {
      const current = JSON.parse(comparableLiveDosage(live[j])) as ProjectionValue;
      const exact = originalProjections.findIndex((projection, candidate) =>
        !usedOriginalIndices.has(candidate) &&
        equivalentProjection(projection, current));
      if (exact >= 0) {
        assigned[j] = exact;
        usedOriginalIndices.add(exact);
      }
    }
    if (!componentCountChanged) {
      // Same-shape edits can inherit advanced metadata from the remaining
      // unused source positions. This runs only after exact matches reserve
      // their true originals, avoiding R6 expression/site transplants.
      const unclaimed = step.component.map((_, index) => index)
        .filter(index => !usedOriginalIndices.has(index));
      for (let j = 0; j < live.length; j++) {
        if (assigned[j] >= 0) continue;
        const next = unclaimed.shift();
        if (next !== undefined) assigned[j] = next;
      }
    }
    for (let j = 0; j < live.length; j++) {
      const dosage = live[j];
      const oldIndex = assigned[j];
      const old = oldIndex >= 0 ? step.component[oldIndex] : undefined;
      const baseline = old ? fromR6Dosage(old, i + 1) : undefined;
      const rawEqual = old !== undefined && baseline !== undefined &&
        equivalentProjection(JSON.parse(comparableLiveDosage(baseline)),
          JSON.parse(comparableLiveDosage(dosage)));
      const expanded = dosage as EzDosage;
      const datesEqual = old !== undefined &&
        JSON.stringify(getDosageExcludedDates(dosage)) ===
        JSON.stringify(getDosageExcludedDates(fromR6Dosage(old, i + 1)));
      const conditionsEqual = expanded.condition === undefined || old !== undefined &&
        equivalentProjection(comparableJson(old.condition),
          comparableJson(expanded.condition));
      const safetyEqual = expanded.safety === undefined || old !== undefined &&
        equivalentProjection(comparableJson(old.safety),
          comparableJson(expanded.safety));
      const referenceEqual = expanded.siteReference === undefined || old !== undefined &&
        equivalentProjection(comparableJson(old.site?.reference),
          comparableJson(expanded.siteReference));
      if (!rawEqual || !datesEqual || !conditionsEqual || !safetyEqual || !referenceEqual)
        unchanged = false;
      if (old && rawEqual && datesEqual && conditionsEqual && safetyEqual && referenceEqual) {
        components.push(old);
        continue;
      }
      const fresh = toR6Dosage(dosage);
      if (old && baseline) {
        // Dose expressions, site references and some safety expressions
        // cannot be represented in strict R5. Preserve them across a change
        // to a DIFFERENT R5 field, provided their own R5 slots are unchanged.
        const doseEqual = equivalentProjection(
          JSON.parse(comparableLiveDosage({ doseAndRate: baseline.doseAndRate })),
          JSON.parse(comparableLiveDosage({ doseAndRate: dosage.doseAndRate })));
        const hasNonR5DoseExpression = old.doseAndRate?.some(entry =>
          entry.doseExpression || entry.rateExpression);
        if (!doseEqual && hasNonR5DoseExpression &&
            !expanded.doseAndRate?.some(entry =>
              entry.doseExpression || entry.rateExpression)) {
          throw new Error(
            "The R5 dosage amount/rate was edited but its retained R6 dose expression has no R5 equivalent. Update the R6 dose expression explicitly before reconciling this course.");
        }
        if (old.site?.reference && !expanded.siteReference &&
            equivalentProjection(JSON.parse(comparableLiveDosage({ site: baseline.site })),
              JSON.parse(comparableLiveDosage({ site: dosage.site })))) {
          fresh.site = { ...(fresh.site ?? {}), reference: old.site.reference };
        }
        if (doseEqual && old.doseAndRate?.length &&
            fresh.doseAndRate?.length === old.doseAndRate.length) {
          fresh.doseAndRate = fresh.doseAndRate.map((item, index) => ({
            ...item,
            ...(!item.doseExpression && old.doseAndRate?.[index]?.doseExpression
              ? { doseExpression: old.doseAndRate[index].doseExpression } : {}),
            ...(!item.rateExpression && old.doseAndRate?.[index]?.rateExpression
              ? { rateExpression: old.doseAndRate[index].rateExpression } : {})
          }));
        }
        const maximaUnchanged = equivalentProjection(
          JSON.parse(comparableLiveDosage({
            maxDosePerPeriod: baseline.maxDosePerPeriod,
            maxDosePerAdministration: baseline.maxDosePerAdministration,
            maxDosePerLifetime: baseline.maxDosePerLifetime
          })),
          JSON.parse(comparableLiveDosage({
            maxDosePerPeriod: dosage.maxDosePerPeriod,
            maxDosePerAdministration: dosage.maxDosePerAdministration,
            maxDosePerLifetime: dosage.maxDosePerLifetime
          })));
        if (maximaUnchanged && old.safety && !fresh.safety) fresh.safety = old.safety;
        if (old.condition?.length && !fresh.condition?.length &&
            JSON.stringify(getDosageCondition(dosage)) ===
            JSON.stringify(getDosageCondition(baseline)))
          fresh.condition = old.condition;
      }
      components.push(fresh);
    }
    steps.push({ ...step, component: components });
  }
  return {
    ...retained,
    // A stale clinician string must never be shown as the updated regimen.
    ...(!unchanged ? {
      renderedInstruction: editedInstruction !== undefined
        ? editedInstruction
        : dosages.every(d => d.text?.length)
          ? dosages.map(d => d.text).join("; ")
          : undefined
    } : editedInstruction !== undefined ? { renderedInstruction: editedInstruction } : {}),
    step: steps
  };
}

/**
 * Export the R5-style extended dose array as strict R6 DosageDetails.
 * The optional course.step rows use the official R6 step fields, grouped
 * by the existing global R5 sequence number.
 */
export function toDosageDetails(
  dosages: readonly (FhirDosage | EzDosage)[],
  renderedInstruction?: string,
  course?: EzCourseMetadata
): FhirR6DosageDetails {
  // Store the original course with every relative-stage dosage, not only
  // the first. Removing the first row must not erase the remaining phases'
  // essential start/end metadata from a persisted R5 dosage array.
  // Every R5 course component carries the original R6 data. One truncated
  // marker must not suppress a valid duplicate on the other component, and
  // conflicting valid markers must never be silently treated as equivalent.
  let original: string | undefined;
  let retained: FhirR6DosageDetails | undefined;
  let corrupt = false;
  for (const dosage of dosages) {
    const marker = dosage.modifierExtension?.find(value =>
      value.url === DOSAGE_DETAILS_R5_URL)?.extension
        ?.find(value => value.url === "dosageDetails")?.valueString;
    if (marker === undefined || marker === original) continue;
    let parsed: FhirR6DosageDetails | undefined;
    try {
      const value: unknown = JSON.parse(marker);
      if (!value || typeof value !== "object" ||
          !Array.isArray((value as FhirR6DosageDetails).step)) {
        corrupt = true;
        continue;
      }
      parsed = value as FhirR6DosageDetails;
    } catch {
      corrupt = true;
      continue;
    }
    if (retained) {
      // A different serialized R6 source can change phase boundaries.
      throw new Error("Conflicting retained R6 course metadata; review the course before scheduling.");
    }
    retained = parsed;
    original = marker;
  }
  if (corrupt && !retained)
    throw new Error("Retained R6 course JSON is malformed. Restore valid course metadata before using relative-stage scheduling; plain R5 fields cannot recover those boundaries.");
  const instructionMarker = dosages[0]?.extension?.find(value =>
    value.url === DOSAGE_RENDERED_INSTRUCTION_R5_URL);
  const savedInstruction = instructionMarker?.extension?.find(value =>
    value.url === "instruction")?.valueString;
  const savedProjection = instructionMarker?.extension?.find(value =>
    value.url === "projection")?.valueString;
  let originalProjected: ProjectionValue[] | undefined;
  if (savedProjection) {
    try {
      const parsed = JSON.parse(savedProjection) as ProjectionValue;
      if (Array.isArray(parsed)) originalProjected = parsed;
    } catch { /* Damaged display-only metadata is never authoritative. */ }
  }
  // Ordinary parseSig() calls have no persisted rendered-text fingerprint.
  // Do not allocate or JSON-normalize any dosage on that hot path.
  const instructionStillMatches = originalProjected !== undefined &&
    equivalentProjection(originalProjected, dosages.map(dosage =>
      JSON.parse(comparableLiveDosage(dosage)) as ProjectionValue));
  const preservedInstruction = instructionStillMatches ? savedInstruction : undefined;
  // If an editor changes a dosage but leaves its old generated text intact,
  // even Dosage.text is stale. Drop only that unchanged old text in the R6
  // projection; downstream formatters can regenerate it from current fields.
  const withoutText = (value: ProjectionValue | undefined): ProjectionValue | undefined => {
    if (!value || Array.isArray(value) || typeof value !== "object") return value;
    const { text: _ignored, ...rest } = value;
    return rest;
  };
  const effectiveDosages = originalProjected && !instructionStillMatches
    ? dosages.map((dosage, index) => {
      const previous = originalProjected[index];
      const prior = previous && !Array.isArray(previous) && typeof previous === "object"
        ? previous : undefined;
      const oldText = prior && "text" in prior ? prior.text : undefined;
      const after = JSON.parse(comparableLiveDosage(dosage)) as ProjectionValue;
      return oldText !== undefined && oldText === dosage.text &&
          !equivalentProjection(withoutText(prior), withoutText(after))
        ? { ...dosage, text: undefined }
        : dosage;
    }) : dosages;
  if (retained) {
    // Reconstruction errors MUST propagate. Swallowing them would turn
    // inconsistent relative stages into an executable but false regimen.
    return reconcileRetainedCourse(retained, effectiveDosages,
      course?.renderedInstruction ?? renderedInstruction);
  }
  // The common one-dose prescription needs neither a grouping Map nor
  // sequence sorting. Preserve identical R6 output with much less overhead.
  if (effectiveDosages.length === 1 && !course?.step?.length) {
    const dosage = effectiveDosages[0];
    const sequence = dosage.sequence ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1)
      throw new Error("Invalid Dosage.sequence");
    return {
      ...(course?.renderedInstruction !== undefined
        ? { renderedInstruction: course.renderedInstruction }
        : renderedInstruction !== undefined
          ? { renderedInstruction }
          : preservedInstruction !== undefined
          ? { renderedInstruction: preservedInstruction }
          : dosage.text ? { renderedInstruction: dosage.text } : {}),
      ...(course?.id ? { id: course.id } : {}),
      ...(course?.extension?.length ? { extension: course.extension } : {}),
      ...(course?.modifierExtension?.length ? { modifierExtension: course.modifierExtension } : {}),
      ...(course?.repeatCycle ? { repeatCycle: course.repeatCycle } : {}),
      ...(course?.safety ? { safety: course.safety } : {}),
      step: [{ component: [toR6Dosage(dosage)] }]
    };
  }
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of effectiveDosages) {
    const sequence = dosage.sequence ?? 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid Dosage.sequence");
    if (!groups.has(sequence)) groups.set(sequence, []);
    groups.get(sequence)!.push(dosage);
  }
  const stepMetadata = new Map(course?.step?.map(step => [step.sequence, step]) ?? []);
  for (const index of stepMetadata.keys()) {
    if (!groups.has(index)) throw new Error("Step metadata references a missing dosage sequence");
  }
  return {
    ...(course?.renderedInstruction !== undefined
      ? { renderedInstruction: course.renderedInstruction }
      : renderedInstruction !== undefined
        ? { renderedInstruction }
        : preservedInstruction !== undefined
          ? { renderedInstruction: preservedInstruction }
          : effectiveDosages.length === 1 && effectiveDosages[0].text
            ? { renderedInstruction: effectiveDosages[0].text } : {}),
    ...(course?.id ? { id: course.id } : {}),
    ...(course?.extension?.length ? { extension: course.extension } : {}),
    ...(course?.modifierExtension?.length ? { modifierExtension: course.modifierExtension } : {}),
    ...(course?.repeatCycle ? { repeatCycle: course.repeatCycle } : {}),
    ...(course?.safety ? { safety: course.safety } : {}),
    step: [...groups.keys()].sort((a, b) => a - b).map(sequence => {
      const step = stepMetadata.get(sequence);
      return {
        ...(step?.id ? { id: step.id } : {}),
        ...(step?.extension?.length ? { extension: step.extension } : {}),
        ...(step?.modifierExtension?.length ? { modifierExtension: step.modifierExtension } : {}),
        ...(step?.start ? { start: step.start } : {}),
        ...(step?.end ? { end: step.end } : {}),
        ...(step?.count !== undefined ? { count: step.count } : {}),
        ...(step?.safety ? { safety: step.safety } : {}),
        component: groups.get(sequence)!.map(toR6Dosage)
      };
    })
  };
}

/** Import a complete R6 course without replacing EZMED's flat dosage layout. */
export function fromDosageDetails(details: FhirR6DosageDetails): {
  dosages: EzDosage[];
  course: EzCourseMetadata;
} {
  const dosages: EzDosage[] = [];
  const metadata: NonNullable<EzCourseMetadata["step"]> = [];
  for (let index = 0; index < details.step.length; index++) {
    const step = details.step[index];
    const sequence = index + 1;
    if (step.id || step.extension?.length || step.modifierExtension?.length ||
        step.start || step.end || step.count !== undefined || step.safety) {
      metadata.push({
        sequence,
        ...(step.id ? { id: step.id } : {}),
        ...(step.extension?.length ? { extension: step.extension } : {}),
        ...(step.modifierExtension?.length ? { modifierExtension: step.modifierExtension } : {}),
        ...(step.start ? { start: step.start } : {}),
        ...(step.end ? { end: step.end } : {}),
        ...(step.count !== undefined ? { count: step.count } : {}),
        ...(step.safety ? { safety: step.safety } : {})
      });
    }
    for (const component of step.component) {
      const r5 = fromR6Dosage(component, sequence);
      const dates = getDosageExcludedDates(r5);
      dosages.push({
        ...r5,
        ...(component.doseAndRate ? { doseAndRate: component.doseAndRate } : {}),
        ...(component.condition?.length ? { condition: component.condition } : {}),
        ...(component.safety ? { safety: component.safety } : {}),
        ...(component.site?.reference ? { siteReference: component.site.reference } : {}),
        ...(dates.length ? { excludedDates: dates } : {})
      });
    }
  }
  // A consumer may persist just the flat .fhir array and not its optional
  // course metadata. Preserve the complete R6 step relationships on the
  // first item as a modifier extension whenever R5 fields alone are
  // insufficient. Strict R5 exporters already understand this same marker.
  const retainedCourse = toFhirR5Dosages(details)[0]?.modifierExtension?.find(
    extension => extension.url === DOSAGE_DETAILS_R5_URL
  );
  if (retainedCourse) {
    for (const dosage of dosages) {
      dosage.modifierExtension = [
        ...(dosage.modifierExtension ?? []).filter(extension =>
          extension.url !== DOSAGE_DETAILS_R5_URL),
        retainedCourse
      ];
    }
  }
  return {
    dosages,
    course: {
      ...(details.id ? { id: details.id } : {}),
      ...(details.extension?.length ? { extension: details.extension } : {}),
      ...(details.modifierExtension?.length ? { modifierExtension: details.modifierExtension } : {}),
      ...(details.renderedInstruction !== undefined
        ? { renderedInstruction: details.renderedInstruction } : {}),
      ...(details.repeatCycle ? { repeatCycle: details.repeatCycle } : {}),
      ...(details.safety ? { safety: details.safety } : {}),
      ...(metadata.length ? { step: metadata } : {})
    }
  };
}

/** Flatten R6 steps to R5 Dosage.sequence with explicit modifier extensions. */
export function toFhirR5Dosages(
  input: FhirR6DosageDetails | readonly (FhirDosage | EzDosage)[],
  course?: EzCourseMetadata
): FhirDosage[] {
  const details = Array.isArray(input)
    ? toDosageDetails(input, course?.renderedInstruction, course)
    : input as FhirR6DosageDetails;
  const result: FhirDosage[] = [];
  for (let index = 0; index < details.step.length; index++) {
    for (const component of details.step[index].component) {
      result.push(fromR6Dosage(component, index + 1));
    }
  }
  // The rendered whole-course instruction is display information, not
  // modifier semantics. Store it using a non-modifier extension; the core
  // R5 dosage text can remain a faithful per-dose realization.
  if (result.length && details.renderedInstruction !== undefined) {
    // Even when the original full instruction equals Dosage.text, editors
    // can update the structured dose without regenerating either string.
    // The fingerprint is needed to detect that stale text on re-import.
    result[0].extension = [
      ...(result[0].extension ?? []).filter(ext =>
        ext.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL),
      {
        url: DOSAGE_RENDERED_INSTRUCTION_R5_URL,
        extension: [
          { url: "instruction", valueString: details.renderedInstruction },
          // This is a display-text fingerprint only. When a clinician edits
          // the live dosage, the stored instruction must not override it.
          { url: "projection", valueString: JSON.stringify(result.map(dosage =>
            JSON.parse(comparableLiveDosage(dosage)))) }
        ]
      }
    ];
  }
  // R5 cannot express complete conditional trees, relative step timing,
  // safety expressions or site references in core fields.
  // Preserve the original R6 representation when lowering would lose
  // any such information. Such a
  // modifier must be understood for execution; downstream schedulers refuse
  // to ignore it rather than fabricate a schedule.
  const hasR6OnlyFields = Boolean(
    details.repeatCycle || details.safety ||
    // Human-readable renderedInstruction does not change administration
    // semantics and must not force an isModifier extension on plain R5 doses.
    details.extension?.length || details.modifierExtension?.length ||
    details.step.some(step =>
      step.start || step.end || step.count !== undefined || step.safety ||
      step.extension?.length || step.modifierExtension?.length ||
      step.component.some(component =>
        component.condition?.length || component.safety ||
        component.site?.reference || component.extension?.length ||
        component.modifierExtension?.length ||
        component.doseAndRate?.some(rate => rate.doseExpression || rate.rateExpression)))
  );
  if (hasR6OnlyFields && result.length) {
    const retainedCourse = {
      url: DOSAGE_DETAILS_R5_URL,
      extension: [{ url: "dosageDetails", valueString: JSON.stringify(details) }]
    };
    // Each R5 dosage is independently persistable/editable. Retain the
    // complete step relationships on every component so deletion of any
    // one row cannot silently turn a bounded course into an unbounded one.
    for (const dosage of result) {
      dosage.modifierExtension = [
        ...(dosage.modifierExtension ?? []).filter(extension =>
          extension.url !== DOSAGE_DETAILS_R5_URL),
        retainedCourse
      ];
    }
  }
  return result;
}
