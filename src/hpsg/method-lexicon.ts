import {
  listMedicationInstructionActions,
  normalizeActionSurface,
  resolveMedicationInstructionAction
} from "../instruction-action-terminology";
import {
  FhirCoding,
  MedicationInstructionActionDefinition,
  ParseOptions,
  RouteCode
} from "../types";
import { clonePrimitiveElement } from "../fhir-translations";

export type MethodAction = string;

function cloneMethodCoding(coding: FhirCoding | undefined): FhirCoding | undefined {
  if (!coding?.code) return undefined;
  return {
    system: coding.system,
    code: coding.code,
    display: coding.display,
    extension: coding.extension?.map((extension) => ({ ...extension })),
    _display: clonePrimitiveElement(coding._display),
    i18n: coding.i18n ? { ...coding.i18n } : undefined
  };
}

function methodSurfaces(definition: MedicationInstructionActionDefinition): string[] {
  const values = [definition.code, definition.display, ...(definition.aliases ?? [])];
  for (const language of Object.keys(definition.i18n ?? {})) {
    const value = definition.i18n?.[language];
    if (value) values.push(value);
  }
  return Array.from(new Set(values.map(normalizeActionSurface).filter(Boolean)));
}

/**
 * Compatibility indexes derived from the single declarative action terminology.
 * New methods must be added to instruction-action-terminology, not here.
 */
export const METHOD_ACTION_BY_VERB: Record<string, MethodAction> = {};
export const METHOD_CODING_BY_ACTION: Record<string, FhirCoding> = {};
export const METHOD_ACTIONS_WITHOUT_IMPLICIT_ROUTE = new Set<MethodAction>();
export const METHOD_ROUTE_OVERRIDE_BY_VERB: Partial<Record<string, RouteCode>> = {};

for (const definition of listMedicationInstructionActions()) {
  if (!definition.administrationMethod?.code) continue;
  METHOD_CODING_BY_ACTION[definition.code] = cloneMethodCoding(definition.administrationMethod)!;
  if (definition.suppressMethodRouteHint) {
    METHOD_ACTIONS_WITHOUT_IMPLICIT_ROUTE.add(definition.code);
  }
  for (const surface of methodSurfaces(definition)) {
    METHOD_ACTION_BY_VERB[surface] = definition.code;
    if (definition.methodRouteOverride) {
      METHOD_ROUTE_OVERRIDE_BY_VERB[surface] = definition.methodRouteOverride;
    }
  }
}

export function resolveMedicationAdministrationMethod(
  surface: string,
  options?: ParseOptions
): MedicationInstructionActionDefinition | undefined {
  const definition = resolveMedicationInstructionAction(surface, options);
  return definition?.administrationMethod?.code ? definition : undefined;
}

export function isMedicationAdministrationMethod(
  surface: string,
  options?: ParseOptions
): boolean {
  return Boolean(resolveMedicationAdministrationMethod(surface, options));
}

export function medicationAdministrationMethodCoding(
  surface: string,
  options?: ParseOptions
): FhirCoding | undefined {
  return cloneMethodCoding(resolveMedicationAdministrationMethod(surface, options)?.administrationMethod);
}

export { cloneMethodCoding };
