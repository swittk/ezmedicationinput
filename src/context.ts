import {
  DEFAULT_ROUTE_SYNONYMS,
  DEFAULT_UNIT_BY_NORMALIZED_FORM,
  KNOWN_DOSAGE_FORMS_TO_DOSE,
  KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE,
  ROUTE_BY_SNOMED
} from "./maps";
import { MedicationContext, RouteCode } from "./types";

export function normalizeDosageForm(
  form: string | undefined
): string | undefined {
  if (!form) {
    return undefined;
  }
  const key = form.trim().toLowerCase();
  return KNOWN_DOSAGE_FORMS_TO_DOSE[key] ?? key;
}

export function inferUnitFromContext(ctx: MedicationContext | undefined): string | undefined {
  if (!ctx) {
    return undefined;
  }
  if (ctx.defaultUnit) {
    return ctx.defaultUnit;
  }
  if (ctx.dosageForm) {
    const normalized = normalizeDosageForm(ctx.dosageForm);
    if (normalized) {
      const unit = DEFAULT_UNIT_BY_NORMALIZED_FORM[normalized];
      if (unit) {
        return unit;
      }
    }
  }
  if (ctx.containerUnit) {
    return ctx.containerUnit;
  }
  return undefined;
}

export function inferRouteFromContext(
  ctx: MedicationContext | undefined
): RouteCode | undefined {
  if (!ctx?.dosageForm) {
    return undefined;
  }
  const normalized = normalizeDosageForm(ctx.dosageForm);
  if (!normalized) {
    return undefined;
  }
  const snomed = KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE[normalized];
  if (!snomed) {
    return DEFAULT_ROUTE_SYNONYMS[normalized]?.code;
  }
  return ROUTE_BY_SNOMED[snomed];
}
