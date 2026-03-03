import { describe, expect, it } from "vitest";
import { calculateTotalUnits, parseSig } from "../src/index";
import { EventTiming, FhirDosage, FhirPeriodUnit } from "../src/types";

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

    it("falls back to frequency defaults when when anchors are present but clinic clocks are not provided", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 4, unit: "cap" } }],
            timing: {
                code: {
                    coding: [{ code: "BID" }],
                    text: "BID"
                },
                repeat: {
                    frequency: 2,
                    period: 1,
                    periodUnit: FhirPeriodUnit.Day,
                    when: [EventTiming["After Breakfast"], EventTiming["After Dinner"]]
                }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            from: "2024-01-01T00:00:00Z",
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "utc"
        });
        expect(result.totalUnits).toBe(56);
    });

    it("falls back to frequency defaults for generic PC anchors when clinic clocks are not provided", () => {
        const dosage: FhirDosage = {
            doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
            timing: {
                repeat: {
                    frequency: 2,
                    period: 1,
                    periodUnit: FhirPeriodUnit.Day,
                    when: [EventTiming["After Meal"]]
                }
            }
        };
        const result = calculateTotalUnits({
            dosage,
            from: "2024-01-01T00:00:00Z",
            durationValue: 3,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "utc"
        });
        expect(result.totalUnits).toBe(12);
    });

    it("infers nightly fallback timing for when-only HS schedules", () => {
        const parsed = parseSig("1 tab po hs", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            from: "2024-01-01T00:00:00Z",
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC"
        });
        expect(result.totalUnits).toBe(7);
    });

    it("infers meal-based fallback timing for when-only AC schedules", () => {
        const parsed = parseSig("1 cap po ac", { context: { dosageForm: "cap" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC"
        });
        expect(result.totalUnits).toBe(6);
    });

    it("calculates totals from parsed sig: 1x5 pc", () => {
        const parsed = parseSig("1x5 pc", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            from: "2024-01-01T00:00:00Z",
            durationValue: 3,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC"
        });
        expect(result.totalUnits).toBe(15);
    });

    it("calculates totals from parsed sig: 1 tab po morning, hs", () => {
        const parsed = parseSig("1 tab po morning, hs", { context: { dosageForm: "tab" } });
        const totalUnits = parsed.items.reduce((sum, item) => {
            const res = calculateTotalUnits({
                dosage: item.fhir,
                from: "2024-01-01T00:00:00Z",
                durationValue: 2,
                durationUnit: FhirPeriodUnit.Day,
                timeZone: "UTC",
                eventClock: {
                    [EventTiming.Morning]: "08:00",
                    [EventTiming["Before Sleep"]]: "22:00"
                }
            });
            return sum + res.totalUnits;
        }, 0);
        expect(totalUnits).toBe(4);
    });

    it("calculates totals from parsed multi-clause sig: 2 tabs po @ 8:00, 1 tab hs", () => {
        const parsed = parseSig("2 tabs po @ 8:00, 1 tab hs", { context: { dosageForm: "tab" } });
        const totalUnits = parsed.items.reduce((sum, item) => {
            const res = calculateTotalUnits({
                dosage: item.fhir,
                from: "2024-01-01T00:00:00Z",
                durationValue: 1,
                durationUnit: FhirPeriodUnit.Day,
                timeZone: "UTC",
                eventClock: {
                    [EventTiming["Before Sleep"]]: "22:00"
                }
            });
            return sum + res.totalUnits;
        }, 0);
        expect(totalUnits).toBe(3);
    });

    it("calculates totals directly from dosage arrays", () => {
        const parsed = parseSig("2 tabs po @ 8:00, 1 tab hs", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.items.map((item) => item.fhir),
            from: "2024-01-01T00:00:00Z",
            durationValue: 1,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC",
            eventClock: {
                [EventTiming["Before Sleep"]]: "22:00"
            }
        });
        expect(result.totalUnits).toBe(3);
    });

    it("calculates totals from parsed multi-clause sig in a single dosage[] call: 1 tab po morning, hs", () => {
        const parsed = parseSig("1 tab po morning, hs", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.items.map((item) => item.fhir),
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC",
            eventClock: {
                [EventTiming.Morning]: "08:00",
                [EventTiming["Before Sleep"]]: "22:00"
            }
        });
        expect(result.totalUnits).toBe(4);
    });

    it("calculates totals from parsed mixed inferred+anchored multi-clause sig: 1x5 pc, 1 tab hs", () => {
        const parsed = parseSig("1x5 pc, 1 tab hs", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.items.map((item) => item.fhir),
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            timeZone: "UTC",
            eventClock: {
                [EventTiming["Before Sleep"]]: "22:00"
            }
        });
        expect(result.totalUnits).toBe(12);
    });

    it("calculates totals from compact @time with weekend filters", () => {
        const parsed = parseSig("1 tab po @12:00 sat/sun", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Week,
            timeZone: "UTC"
        });
        expect(result.totalUnits).toBe(4);
    });

    it("calculates split weekday/weekend regimen totals from weekdays nomenclature", () => {
        const parsed = parseSig(
            "1 tab po once daily weekdays, 1.5 tabs po once daily weekends",
            { context: { dosageForm: "tab" } }
        );
        const result = calculateTotalUnits({
            dosage: parsed.items.map((item) => item.fhir),
            from: "2024-01-01T00:00:00Z",
            durationValue: 4,
            durationUnit: FhirPeriodUnit.Week,
            timeZone: "UTC"
        });
        // 4 weeks from Monday: 20 weekdays * 1 + 8 weekend days * 1.5 = 32 tabs
        expect(result.totalUnits).toBe(32);
    });

    it("calculates split weekday/weekend regimen totals from Thai nomenclature", () => {
        const parsed = parseSig(
            "1 tab po once daily วันธรรมดา, 1.5 tabs po once daily สุดสัปดาห์",
            { context: { dosageForm: "tab" } }
        );
        const result = calculateTotalUnits({
            dosage: parsed.items.map((item) => item.fhir),
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Week,
            timeZone: "UTC"
        });
        // 2 weeks from Monday: 10 weekdays * 1 + 4 weekend days * 1.5 = 16 tabs
        expect(result.totalUnits).toBe(16);
    });

    it("calculates totals for wrap-around day ranges", () => {
        const parsed = parseSig("1 tab po once daily fri to mon", {
            context: { dosageForm: "tab" }
        });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            from: "2024-01-01T00:00:00Z",
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Week,
            timeZone: "UTC"
        });
        // 2 weeks include Fri/Sat/Sun/Mon twice = 8 doses
        expect(result.totalUnits).toBe(8);
    });
});
