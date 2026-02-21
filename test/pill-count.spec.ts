import { describe, expect, it } from "vitest";
import { calculateTotalUnits } from "../src/index";
import { FhirDosage, FhirPeriodUnit } from "../src/types";

describe("calculateTotalUnits", () => {
    const BASE_OPTIONS = {
        timeZone: "UTC",
        from: "2024-01-01T00:00:00Z"
    };

    it("calculates simple daily dose for a week", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: {
                repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(7);
    });

    it("calculates BID dose for a week", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: {
                repeat: { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(14);
    });

    it("calculates dose with 12h interval for 2 days", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: {
                repeat: { period: 12, periodUnit: FhirPeriodUnit.Hour }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        // 0:00, 12:00, 0:00 (next day), 12:00 (next day) -> 4 doses
        expect(result.totalUnits).toBe(4);
    });

    it("rounds up to specified multiple", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: {
                repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        // 10 days = 30 tabs. Round to multiple of 14 (e.g. 2 weeks of blister packs)
        const result = calculateTotalUnits({
            dosage,
            durationValue: 10,
            durationUnit: FhirPeriodUnit.Day,
            roundToMultiple: 14,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(42); // 14 * 3
    });

    it("calculates containers for fluids", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 10, unit: "mL" } }],
            timing: {
                repeat: { frequency: 3, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        // 10 days = 30 doses * 10 mL = 300 mL.
        // Container is 120 mL.
        const result = calculateTotalUnits({
            dosage,
            durationValue: 10,
            durationUnit: FhirPeriodUnit.Day,
            context: { containerValue: 120 },
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(300);
        expect(result.totalContainers).toBe(3); // 300 / 120 = 2.5 -> 3
    });

    it("handles unit conversion for containers", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1000, unit: "mg" } }],
            timing: {
                repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        // 10 days = 10,000 mg = 10 g.
        // Container is 5 g.
        const result = calculateTotalUnits({
            dosage,
            durationValue: 10,
            durationUnit: FhirPeriodUnit.Day,
            context: { containerValue: 5, containerUnit: "g" },
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(10000);
        expect(result.totalContainers).toBe(2);
    });

    it("handles complex unit conversion via strengthRatio (mass to volume)", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 100, unit: "mg" } }],
            timing: {
                repeat: { frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day }
            }
        };
        // 10 days = 1000 mg.
        // Strength: 100 mg / 1 dL  (= 100 mg / 100 mL = 1 mg/mL)
        // Container: 120 mL.
        // 1000 mg @ 1mg/mL = 1000 mL.
        // 1000 / 120 = 8.33 -> 9 containers.
        const result = calculateTotalUnits({
            dosage,
            durationValue: 10,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                containerValue: 120,
                containerUnit: "mL",
                strengthRatio: {
                    numerator: { value: 100, unit: "mg" },
                    denominator: { value: 1, unit: "dL" }
                }
            },
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(1000); // 100mg * 10
        expect(result.totalContainers).toBe(9);
    });

    it("handles timeOfDay schedules", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
            timing: {
                repeat: { timeOfDay: ["08:00:00", "20:00:00"] }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(4);
    });
});
