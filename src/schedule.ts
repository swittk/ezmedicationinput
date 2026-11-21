/**
 * Public medication execution boundary.
 *
 * Accept the established R5/R6/batch inputs and normalize them ONCE to the
 * canonical course. All calendar, phase, occurrence and supply semantics are
 * implemented in execution/engine, which has no import/export dependency.
 * Canonical callers bypass interchange completely.
 */
import type { FhirDosage, FhirR6DosageInstructionInput, ParseBatchResult,
  NextDueDoseOptions, TotalUnitsOptions, TotalUnitsResult } from "./types";
import type { CanonicalScheduleInput, CanonicalSupplyOptions } from "./canonical/course";
import { inputToCanonical } from "./adapters/canonical-course";
import { nextDueDoses as executeDue, calculateTotalUnits as executeSupply,
  MedicationQuantityCalculationError } from "./execution/engine";
export { MedicationQuantityCalculationError };

export function nextDueDoses(
  input: FhirDosage | readonly FhirDosage[] | FhirR6DosageInstructionInput |
    ParseBatchResult | CanonicalScheduleInput,
  options: NextDueDoseOptions
): string[] {
  if (options.limit !== undefined && options.limit <= 0) return [];
  // Capture declared options once; recursive capped scheduling must keep
  // prototype-backed getters as well as ordinary own properties.
  return executeDue(inputToCanonical(input), {
    from: options.from, orderedAt: options.orderedAt, limit: options.limit,
    priorCount: options.priorCount, priorDoseTimes: options.priorDoseTimes,
    timeZone: options.timeZone, config: options.config,
    alternativeChoices: options.alternativeChoices, evaluateCondition: options.evaluateCondition?.bind(options),
    eventClock: options.eventClock, mealOffsets: options.mealOffsets,
    frequencyDefaults: options.frequencyDefaults,
  });
}
export function calculateTotalUnits(options: TotalUnitsOptions | CanonicalSupplyOptions): TotalUnitsResult {
  if (!options || !options.dosage)
    throw new MedicationQuantityCalculationError("missing-regimen",
      "A medication dosage or complete treatment course is required for supply calculation.");
  // Read the declared options directly, including prototype-backed getters.
  // This boundary already needs one normalized object; a fixed typed snapshot
  // preserves that public input contract without an enumeration/spread pass.
  return executeSupply({
    dosage: inputToCanonical(options.dosage),
    from: options.from, orderedAt: options.orderedAt,
    timeZone: options.timeZone, config: options.config,
    durationValue: options.durationValue, durationUnit: options.durationUnit,
    context: options.context, patientWeightKg: options.patientWeightKg,
    roundToMultiple: options.roundToMultiple, limit: options.limit,
    priorCount: options.priorCount, priorDoseTimes: options.priorDoseTimes,
    alternativeChoices: options.alternativeChoices, evaluateCondition: options.evaluateCondition?.bind(options),
    eventClock: options.eventClock, mealOffsets: options.mealOffsets,
    frequencyDefaults: options.frequencyDefaults,
  });
}
