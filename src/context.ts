import {
  DEFAULT_UNIT_BY_NORMALIZED_FORM,
  KNOWN_DOSAGE_FORMS_TO_DOSE
} from "./maps";
import { MedicationContext } from "./types";

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
