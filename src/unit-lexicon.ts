import {
  DEFAULT_UNIT_SYNONYMS,
  HOUSEHOLD_VOLUME_UNITS
} from "./maps";
import { ParseOptions } from "./types";

const HOUSEHOLD_VOLUME_UNIT_SET = new Set(
  HOUSEHOLD_VOLUME_UNITS.map((unit) => unit.toLowerCase())
);

const DISCRETE_UNIT_SET = new Set([
  "tab",
  "tabs",
  "tablet",
  "tablets",
  "cap",
  "caps",
  "capsule",
  "capsules",
  "puff",
  "puffs",
  "spray",
  "sprays",
  "drop",
  "drops",
  "patch",
  "patches",
  "suppository",
  "suppositories",
  "implant",
  "implants",
  "piece",
  "pieces",
  "stick",
  "sticks",
  "pump",
  "pumps",
  "squeeze",
  "squeezes",
  "applicatorful",
  "applicatorfuls",
  "capful",
  "capfuls",
  "scoop",
  "scoops",
  "application",
  "applications",
  "ribbon",
  "pessary",
  "pessaries",
  "lozenge",
  "lozenges"
]);

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
  return undefined;
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
  return DISCRETE_UNIT_SET.has(unit.trim().toLowerCase());
}
