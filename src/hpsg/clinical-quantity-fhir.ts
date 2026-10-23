import type { FhirDosage } from "../types";
import type { HpsgClinicalQuantityFeature } from "./signature";

const UCUM = "http://unitsofmeasure.org";

/**
 * Lower a resolved, typed HPSG quantity without consulting source text. This
 * is kept beside sign-to-canonical projection so the temporary call site in
 * the post-parser compatibility pass does not become a semantic parser.
 */
export function projectHpsgClinicalQuantityToFhir(
  dosage: FhirDosage,
  quantity: HpsgClinicalQuantityFeature
): void {
  if (quantity.status !== "resolved") {
    // Preserve a recognized daily total even when no per-administration split
    // was stated. It is a rate, not an invented dose, and remains editable.
    if (quantity.dailyTotal && quantity.denominators.some(term => term.dimension === "time")) {
      const unit = [quantity.numerator.unit, ...quantity.denominators.map(term => term.unit)].join("/");
      dosage.doseAndRate = [{
        rateQuantity: {
          value: quantity.numerator.value,
          unit,
          system: UCUM,
          code: unit
        }
      }];
    }
    return;
  }
  if (quantity.representation === "dose") {
    const dose = dosage.doseAndRate?.[0]?.doseQuantity;
    if (dose && quantity.projectedDose) {
      dose.system = UCUM;
      dose.code = quantity.projectedDose.unit;
    }
    return;
  }
  if (quantity.representation === "rate-quantity") {
    const unit = [quantity.numerator.unit, ...quantity.denominators.map((term) => term.unit)].join("/");
    dosage.doseAndRate = [{
      rateQuantity: {
        value: quantity.numerator.value,
        unit,
        system: UCUM,
        code: unit
      }
    }];
    return;
  }
  const duration = quantity.administrationDuration;
  const dose = quantity.projectedDose;
  if (!duration || !dose) return;
  const doseQuantity = {
    value: dose.value,
    unit: dose.unit,
    system: UCUM,
    code: dose.unit
  };
  const rate = quantity.rateNumerator ?? dose;
  const rateNumerator = {
    value: rate.value,
    unit: rate.unit,
    system: UCUM,
    code: rate.unit
  };
  dosage.doseAndRate = [{
    doseQuantity,
    rateRatio: {
      numerator: rateNumerator,
      denominator: {
        value: duration.value,
        unit: duration.unit,
        system: UCUM,
        code: duration.unit
      }
    }
  }];
}
