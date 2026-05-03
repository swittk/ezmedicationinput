import {
  DEFAULT_UNIT_SYNONYMS,
  HOUSEHOLD_VOLUME_UNITS
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
  const terminologyUnit = getDoseUnitTerminologyEntry(token)?.unit;
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
  return terminologyEntry?.approximateQuantity;
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
    approximateQuantity: getDoseUnitApproximation(unit, context)
  };
}

export function listDoseUnitTerminology(): DoseUnitTerminologyEntry[] {
  return DOSE_UNIT_TERMINOLOGY.map((entry) => ({
    ...entry,
    aliases: entry.aliases ? [...entry.aliases] : undefined,
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
