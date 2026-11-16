/**
 * Public medication execution boundary.
 *
 * Accept the established R5/R6/batch inputs and normalize them ONCE to the
 * canonical course. All calendar, phase, occurrence and supply semantics are
 * implemented in execution/engine, which has no import/export dependency.
 * Canonical callers bypass interchange completely.
 */
import type { FhirDosage, FhirR6DosageInstruction, ParseBatchResult,
  NextDueDoseOptions, TotalUnitsOptions, TotalUnitsResult } from "./types";
import type { CanonicalScheduleInput, CanonicalSupplyOptions } from "./canonical/course";
import { inputToCanonical } from "./adapters/canonical-course";
import { nextDueDoses as executeDue, calculateTotalUnits as executeSupply,
  MedicationQuantityCalculationError } from "./execution/engine";
export { MedicationQuantityCalculationError };

export function nextDueDoses(
  input: FhirDosage | readonly FhirDosage[] | FhirR6DosageInstruction |
    ParseBatchResult | CanonicalScheduleInput,
  options: NextDueDoseOptions
): string[] {
  return executeDue(inputToCanonical(input), options);
}
export function calculateTotalUnits(options: TotalUnitsOptions | CanonicalSupplyOptions): TotalUnitsResult {
  if (!options || !options.dosage)
    throw new MedicationQuantityCalculationError("missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation.");
  return executeSupply({ ...options, dosage: inputToCanonical(options.dosage) });
}
