import {
  FhirDayOfWeek, FhirDosage, FhirExtension, FhirQuantity, FhirR6Dosage, FhirR6DosageCondition,
  FhirR6DosageDetails, FhirR6DosageSafety, MedicationCondition,
  EzDosage, EzCourseMetadata
} from "./types";

/** Modifier extensions: ignoring either can change whether a dose may be given. */
export const DOSAGE_CONDITION_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-conditional-dose";
export const DOSAGE_EXCLUDED_DATES_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-excluded-calendar-dates";
export const DOSAGE_DETAILS_R5_URL =
  "https://github.com/swittk/ezmedicationinput/fhir/StructureDefinition/medication-r6-course-details";
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
      extension: [{ url: DOSAGE_CONDITION_R5_URL, valueString: JSON.stringify(condition) }]
    };
  }
  if (condition.kind === "state") {
    return {
      code: { coding: [{ system: CONDITION_CODE_SYSTEM, code: "problem-presents", display: "Problem Presents" }] },
      details: { text: condition.name },
      operation: "eq",
      valueBoolean: condition.expected,
      text: condition.text,
      extension: [{ url: DOSAGE_CONDITION_R5_URL, valueString: JSON.stringify(condition) }]
    };
  }
  // FHIR R6 condition[] is OR. A whole Boolean expression must stay ONE
  // condition, with the logical tree retained in a declared extension.
  return {
    code: { coding: [{ system: INTERNAL_CONDITION_CODE_SYSTEM, code: "expression", display: "Medication conditional expression" }] },
    text: describe(condition),
    extension: [{ url: DOSAGE_CONDITION_R5_URL, valueString: JSON.stringify(condition) }]
  };
}

function conditionFromR6(value: FhirR6DosageCondition): MedicationCondition {
  const raw = value.extension?.find(extension => extension.url === DOSAGE_CONDITION_R5_URL)?.valueString;
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
    // Common BID/TID instructions need no new properties. Reuse the already
    // parsed R5-shaped dosage object rather than allocating a duplicate.
    // Advanced fields are added only when a real R6 semantic exists.
    const input = dosage as EzDosage;
    if (input.condition || input.safety || input.siteReference ||
        input.excludedDates || input.doseAndRate?.some(value =>
          value.doseExpression || value.rateExpression)) {
      return input;
    }
    if (!dosage.maxDosePerPeriod?.length && !dosage.maxDosePerAdministration &&
        !dosage.maxDosePerLifetime &&
        !dosage.modifierExtension?.some(value =>
          value.url === DOSAGE_CONDITION_R5_URL ||
          value.url === DOSAGE_EXCLUDED_DATES_R5_URL)) {
      return input;
    }
    const predicate = getDosageCondition(dosage);
    const safety = input.safety ?? toR6Safety(dosage);
    const dates = getDosageExcludedDates(dosage);
    return {
      ...dosage,
      ...(predicate ? { condition: [conditionToR6(predicate)] } : {}),
      ...(safety ? { safety } : {}),
      ...(dates.length ? { excludedDates: dates } : {})
    };
  });
}

/** Project one EZMED dosage into a native R6 dosage component. */
function toR6Dosage(dosage: FhirDosage | EzDosage): FhirR6Dosage {
  const {
    sequence: _sequence, site, maxDosePerPeriod: _maxPeriod,
    maxDosePerAdministration: _maxAdministration, maxDosePerLifetime: _maxLifetime,
    condition: ownConditions, safety: ownSafety,
    siteReference, excludedDates: _excludedDates,
    modifierExtension, ...rest
  } = dosage as EzDosage;
  const predicate = ownConditions?.length ? undefined : getDosageCondition(dosage);
  const safety = ownSafety ?? toR6Safety(dosage);
  const r6Modifiers = modifierExtension?.filter(value =>
    value.url !== DOSAGE_CONDITION_R5_URL);
  return {
    ...rest,
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
    if (limit.scope === "period" && limit.valueQuantity && limit.period) {
      output.maxDosePerPeriod = [...(output.maxDosePerPeriod ?? []), {
        numerator: { ...limit.valueQuantity },
        denominator: { ...limit.period }
      }];
    }
    if (limit.scope === "administration" && limit.valueQuantity) {
      output.maxDosePerAdministration = { ...limit.valueQuantity };
    }
    if (limit.scope === "lifetime" && limit.valueQuantity) {
      output.maxDosePerLifetime = { ...limit.valueQuantity };
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
  const original = dosages[0]?.modifierExtension?.find(value => value.url === DOSAGE_DETAILS_R5_URL)
    ?.extension?.find(value => value.url === "dosageDetails")?.valueString;
  if (original) {
    try {
      const retained = JSON.parse(original) as FhirR6DosageDetails;
      if (Array.isArray(retained.step)) return retained;
    } catch { /* Reconstruct using explicit R5 information. */ }
  }
  const groups = new Map<number, (FhirDosage | EzDosage)[]>();
  for (const dosage of dosages) {
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
        : dosages.length === 1 && dosages[0].text
          ? { renderedInstruction: dosages[0].text } : {}),
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
  // R5 cannot express the whole R6 course instruction, condition trees,
  // step timing, safety limits with expressions, or site references in core
  // fields. Preserve the original R6 representation when lowering would lose
  // any such information. Such a
  // modifier must be understood for execution; downstream schedulers refuse
  // to ignore it rather than fabricate a schedule.
  const hasR6OnlyFields = Boolean(
    details.repeatCycle || details.safety ||
    (details.renderedInstruction !== undefined &&
      (details.step.length !== 1 ||
        details.step[0].component.length !== 1 ||
        details.renderedInstruction !== details.step[0].component[0].text)) ||
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
    result[0].modifierExtension = [
      ...(result[0].modifierExtension ?? []),
      {
        url: DOSAGE_DETAILS_R5_URL,
        extension: [{ url: "dosageDetails", valueString: JSON.stringify(details) }]
      }
    ];
  }
  return result;
}
