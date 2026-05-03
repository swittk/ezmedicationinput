import {
  DEFAULT_UNIT_BY_NORMALIZED_FORM,
  DEFAULT_UNIT_SYNONYMS,
  HOUSEHOLD_VOLUME_UNITS,
  KNOWN_DOSAGE_FORMS_TO_DOSE
} from "./maps";
import unitTerminologySource from "./unit-terminology.json";
import type {
  DoseUnitApproximation,
  DoseUnitKind,
  DoseUnitSemantics,
  DoseUnitTerminologyEntry,
  MedicationContext,
  ParseOptions
} from "./types";
import { MASS_UNITS, VOLUME_UNITS, getUnitCategory } from "./utils/units";

const HOUSEHOLD_VOLUME_UNIT_SET = new Set(
  HOUSEHOLD_VOLUME_UNITS.map((unit) => unit.toLowerCase())
);

const DOSE_UNIT_TERMINOLOGY = unitTerminologySource.terms as DoseUnitTerminologyEntry[];

const DOSE_UNIT_TERMINOLOGY_BY_KEY = new Map<string, DoseUnitTerminologyEntry>();
const DISCRETE_UNIT_KINDS = new Set<DoseUnitKind>([
  "biologic_unit",
  "counted_presentation",
  "device_actuation",
  "product_specific_amount",
  "length_of_product"
]);

for (const entry of DOSE_UNIT_TERMINOLOGY) {
  const keys = [entry.unit, ...(entry.aliases ?? [])];
  for (const key of keys) {
    const normalized = normalizeUnitKey(key);
    if (normalized) {
      DOSE_UNIT_TERMINOLOGY_BY_KEY.set(normalized, entry);
    }
  }
}

export function normalizeUnit(token: string, options?: ParseOptions): string | undefined {
  const key = token.trim().toLowerCase();
  const override = enforceHouseholdUnitPolicy(options?.unitMap?.[key], options);
  if (override) {
    return override;
  }
  const defaultUnit = enforceHouseholdUnitPolicy(
    DEFAULT_UNIT_SYNONYMS[key],
    options
  );
  if (defaultUnit) {
    return defaultUnit;
  }
  const terminologyEntry = getDoseUnitTerminologyEntry(token);
  const terminologyUnit = terminologyEntry?.parseAsDose === false
    ? undefined
    : terminologyEntry?.unit;
  const policyCheckedTerminologyUnit = enforceHouseholdUnitPolicy(terminologyUnit, options);
  if (policyCheckedTerminologyUnit) {
    return policyCheckedTerminologyUnit;
  }
  return undefined;
}

function normalizeUnitKey(unit: string | undefined): string | undefined {
  const normalized = unit?.trim();
  return normalized ? normalized.toLowerCase() : undefined;
}

function unitApproximationOverride(
  unit: string,
  context?: MedicationContext | null
): DoseUnitApproximation | undefined {
  const entries = context?.unitApproximationMap;
  if (!entries) {
    return undefined;
  }
  const unitKey = normalizeUnitKey(unit);
  for (const candidateUnit in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, candidateUnit)) {
      continue;
    }
    const approximation = entries[candidateUnit];
    if (normalizeUnitKey(candidateUnit) === unitKey) {
      return approximation;
    }
  }
  return undefined;
}

function normalizeDosageFormKey(form: string | undefined): string | undefined {
  const normalized = form?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return KNOWN_DOSAGE_FORMS_TO_DOSE[normalized] ?? normalized;
}

function getPreferredMassApproximationUnit(
  context?: MedicationContext | null
): string | undefined {
  const containerUnit = context?.containerUnit?.trim();
  if (containerUnit && getUnitCategory(containerUnit) === "mass") {
    return containerUnit;
  }

  const normalizedDosageForm = normalizeDosageFormKey(context?.dosageForm);
  const defaultUnit = normalizedDosageForm
    ? DEFAULT_UNIT_BY_NORMALIZED_FORM[normalizedDosageForm]
    : undefined;
  return defaultUnit && getUnitCategory(defaultUnit) === "mass" ? defaultUnit : undefined;
}

function bridgeApproximationToMassDispensedTopical(
  approximation: DoseUnitApproximation,
  context?: MedicationContext | null
): DoseUnitApproximation {
  const preferredMassUnit = getPreferredMassApproximationUnit(context);
  if (!preferredMassUnit || getUnitCategory(approximation.unit) !== "volume") {
    return approximation;
  }

  const sourceVolumeFactor = VOLUME_UNITS[approximation.unit.toLowerCase()];
  const targetMassFactor = MASS_UNITS[preferredMassUnit.toLowerCase()];
  if (!sourceVolumeFactor || !targetMassFactor) {
    return approximation;
  }

  const valueMl = approximation.value * sourceVolumeFactor;
  const valueG = valueMl;
  const convertedValue = (valueG * MASS_UNITS.g) / targetMassFactor;
  const bridgeBasis =
    "Mass-dispensed semisolid topical default bridge assumes 1 mL approximately equals 1 g unless a product-specific override is provided";

  return {
    ...approximation,
    value: convertedValue,
    unit: preferredMassUnit,
    basis: approximation.basis
      ? `${approximation.basis}; ${bridgeBasis}`
      : bridgeBasis
  };
}

function getDoseUnitTerminologyEntry(unit: string | undefined): DoseUnitTerminologyEntry | undefined {
  if (!unit) {
    return undefined;
  }
  return DOSE_UNIT_TERMINOLOGY_BY_KEY.get(normalizeUnitKey(unit) ?? "");
}

export function getDoseUnitKind(unit: string | undefined): DoseUnitKind | undefined {
  return getDoseUnitTerminologyEntry(unit)?.kind;
}

export function getDoseUnitApproximation(
  unit: string | undefined,
  context?: MedicationContext | null
): DoseUnitApproximation | undefined {
  if (!unit) {
    return undefined;
  }
  const terminologyEntry = getDoseUnitTerminologyEntry(unit);
  const override = unitApproximationOverride(unit, context) ??
    unitApproximationOverride(terminologyEntry?.unit ?? "", context);
  if (override) {
    return override;
  }
  const approximation = terminologyEntry?.approximateQuantity;
  if (!approximation) {
    return undefined;
  }
  return bridgeApproximationToMassDispensedTopical(approximation, context);
}

export function getDoseUnitSemantics(
  unit: string | undefined,
  context?: MedicationContext | null
): DoseUnitSemantics | undefined {
  if (!unit) {
    return undefined;
  }
  const terminologyEntry = getDoseUnitTerminologyEntry(unit);
  if (!terminologyEntry) {
    return undefined;
  }
  return {
    unit: terminologyEntry.unit,
    kind: terminologyEntry.kind,
    parseAsDose: terminologyEntry.parseAsDose,
    approximateQuantity: getDoseUnitApproximation(unit, context)
  };
}

export function listDoseUnitTerminology(): DoseUnitTerminologyEntry[] {
  return DOSE_UNIT_TERMINOLOGY.map((entry) => ({
    ...entry,
    aliases: entry.aliases ? [...entry.aliases] : undefined,
    parseAsDose: entry.parseAsDose,
    approximateQuantity: entry.approximateQuantity
      ? { ...entry.approximateQuantity }
      : undefined
  }));
}

export function enforceHouseholdUnitPolicy(
  unit: string | undefined,
  options?: ParseOptions
): string | undefined {
  if (
    unit &&
    options?.allowHouseholdVolumeUnits === false &&
    HOUSEHOLD_VOLUME_UNIT_SET.has(unit.toLowerCase())
  ) {
    return undefined;
  }
  return unit;
}

export function isDiscreteUnit(unit: string): boolean {
  if (!unit) {
    return false;
  }
  const semantics = getDoseUnitSemantics(unit);
  return Boolean(semantics && DISCRETE_UNIT_KINDS.has(semantics.kind));
}
