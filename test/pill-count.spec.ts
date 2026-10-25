import { describe, expect, it } from "vitest";
import { parserStateFromFhir } from "../src/fhir";
import { calculateTotalUnits, formatSig, getDosageCondition, parseSig as parseBatch, nextDueDoses, toDosageDetails, toFhirR5Dosages, TIMING_OCCURRENCE_CAP_EXTENSION_URL } from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { EventTiming, FhirDosage, FhirPeriodUnit, FhirDayOfWeek } from "../src/types";

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

    it("caps external duration by parsed dosage duration when present", () => {
        const parsed = parseSig("1 tab po od for 7 days", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 30,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(7);
    });

    it("caps external duration by parsed hour-based course duration", () => {
        const parsed = parseSig("1 tab po q12h for 36 hours", { context: { dosageForm: "tab" } });
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 10,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(result.totalUnits).toBe(3);
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

    it("multiplies bilateral eye drops and derives bottle counts", () => {
        const parsed = parseSig("1 drop ou q2h");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 20,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                dosageForm: "eye drops, solution",
                containerValue: 5,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(480);
        expect(result.totalApproximateQuantity?.value).toBe(24);
        expect(result.totalApproximateQuantity?.unit).toBe("mL");
        expect(result.totalContainers).toBe(5);
    });

    it("calculates fractional topical package units from parsed sigs", () => {
        const fixtures = [
            ["apply half tube twice daily", 7, 7],
            ["apply two fifths of bottle once daily", 2.8, 3],
            ["apply three quarters tube q12h", 10.5, 11],
            ["apply 1/4 container daily", 1.75, 2]
        ] as const;

        for (const [sig, totalUnits, totalContainers] of fixtures) {
            const parsed = parseSig(sig);
            const result = calculateTotalUnits({
                dosage: parsed.fhir,
                durationValue: 7,
                durationUnit: FhirPeriodUnit.Day,
                context: { containerValue: 1 },
                ...BASE_OPTIONS
            });

            expect(result.totalUnits).toBe(totalUnits);
            expect(result.totalContainers).toBe(totalContainers);
        }
    });

    it("calculates one-time fractional topical package units when explicitly marked once", () => {
        const parsed = parseSig("apply 1/4 tube once");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            context: { containerValue: 1 },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(0.25);
        expect(result.totalContainers).toBe(1);
    });

    it("bridges fractional package-unit doses to inner container quantity when packageUnit is supplied", () => {
        const parsed = parseSig("apply half bottle once");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                packageUnit: "bottle",
                containerValue: 120,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(0.5);
        expect(result.totalContainerQuantity).toEqual({ value: 60, unit: "mL" });
        expect(result.totalContainers).toBe(1);
    });

    it("bridges repeated fractional package-unit doses to inner container quantity", () => {
        const parsed = parseSig("apply half bottle twice daily");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 1,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                packageUnit: "bottle",
                containerValue: 120,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(1);
        expect(result.totalContainerQuantity).toEqual({ value: 120, unit: "mL" });
        expect(result.totalContainers).toBe(1);
    });

    it("counts package-unit doses as packages rather than dividing by inner amount", () => {
        const parsed = parseSig("apply 3 bottles once");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                packageUnit: "bottle",
                containerValue: 120,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(3);
        expect(result.totalContainerQuantity).toEqual({ value: 360, unit: "mL" });
        expect(result.totalContainers).toBe(3);
    });

    it("aggregates total container quantity across dosage arrays when units match", () => {
        const first = parseSig("apply 1 pea-sized amount once daily to face").fhir;
        const second = parseSig("apply 1 pea-sized amount once daily to arm").fhir;
        const result = calculateTotalUnits({
            dosage: [first, second],
            durationValue: 20,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                containerValue: 5,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(40);
        expect(result.totalApproximateQuantity).toMatchObject({ value: 10, unit: "mL" });
        expect(result.totalContainerQuantity).toEqual({ value: 10, unit: "mL" });
        expect(result.totalContainers).toBe(2);
    });

    it("counts patch and ring presentation units as discrete administrations", () => {
        const patch = parseSig("apply 1 patch every 3 days for 9 days");
        const patchResult = calculateTotalUnits({
            dosage: patch.fhir,
            durationValue: 30,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(patchResult.totalUnits).toBe(3);

        const ring = parseSig("insert 1 ring pv monthly");
        const ringResult = calculateTotalUnits({
            dosage: ring.fhir,
            durationValue: 90,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(ringResult.totalUnits).toBe(3);
    });

    it("estimates usage for natural product-specific amount units", () => {
        const parsed = parseSig("apply 2 FTU to face twice daily");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(28);
        expect(result.totalApproximateQuantity).toMatchObject({
            value: 14,
            unit: "g",
            confidence: "approximate"
        });
    });

    it("estimates ophthalmic drop volume from unit terminology", () => {
        const parsed = parseSig("1 eyedrop right eye qid");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(28);
        expect(result.totalApproximateQuantity).toMatchObject({
            value: 1.4,
            unit: "mL",
            confidence: "approximate"
        });
    });

    it("estimates size-proxy topical amounts in volume units", () => {
        const peaSized = calculateTotalUnits({
            dosage: parseSig("apply pea-sized amount to face daily").fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(peaSized.totalUnits).toBe(7);
        expect(peaSized.totalApproximateQuantity).toMatchObject({
            value: 1.75,
            unit: "mL",
            confidence: "approximate"
        });

        const shotGlass = calculateTotalUnits({
            dosage: parseSig("apply 1 shot glass of sunscreen daily").fhir,
            durationValue: 2,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(shotGlass.totalUnits).toBe(2);
        expect(shotGlass.totalApproximateQuantity?.value).toBeCloseTo(59.147);
        expect(shotGlass.totalApproximateQuantity).toMatchObject({
            unit: "mL",
            confidence: "approximate"
        });
    });

    it("uses approximate natural volume and strength to estimate ingredient amount", () => {
        const fixtures = [
            "apply 1 pea-sized amount once daily to face",
            "apply 1 เม็ดถั่ว once daily to face",
            "apply 1 เม็ดถั่วเขียว once daily to face",
            "apply 1 เมล็ดถั่ว once daily to face"
        ];

        for (const sig of fixtures) {
            const result = calculateTotalUnits({
                dosage: parseSig(sig).fhir,
                durationValue: 1,
                durationUnit: FhirPeriodUnit.Day,
                context: {
                    strength: "500 mcg / 100 mL",
                    containerValue: 5,
                    containerUnit: "mL"
                },
                ...BASE_OPTIONS
            });

            expect(result.totalUnits).toBe(1);
            expect(result.totalApproximateQuantity).toMatchObject({
                value: 0.25,
                unit: "mL",
                confidence: "approximate"
            });
            expect(result.totalApproximateIngredientQuantity).toMatchObject({
                value: 1.25,
                unit: "mcg",
                confidence: "approximate"
            });
            expect(result.totalContainers).toBe(1);
        }
    });

    it("bridges semisolid topical size proxies into gram-dispensed container math", () => {
        const result = calculateTotalUnits({
            dosage: parseSig("apply 2 pea-sized amount once daily to skin").fhir,
            durationValue: 20,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                dosageForm: "cream",
                strength: "20 mg/100 g",
                containerValue: 30,
                containerUnit: "g"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(40);
        expect(result.totalApproximateQuantity).toMatchObject({
            value: 10,
            unit: "g",
            confidence: "approximate"
        });
        expect(result.totalApproximateIngredientQuantity).toMatchObject({
            value: 2,
            unit: "mg",
            confidence: "approximate"
        });
        expect(result.totalContainerQuantity).toEqual({ value: 10, unit: "g" });
        expect(result.totalContainers).toBe(1);
    });

    it("does not apply the semisolid 1 mL≈1 g bridge outside whitelisted dosage forms", () => {
        const result = calculateTotalUnits({
            dosage: parseSig("apply 1 pea-sized amount once daily to face").fhir,
            durationValue: 20,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                dosageForm: "powder for oral suspension",
                strength: "500 mcg / 100 mL",
                containerValue: 30,
                containerUnit: "g"
            },
            ...BASE_OPTIONS
        });

        expect(result.totalApproximateQuantity).toMatchObject({
            value: 5,
            unit: "mL",
            confidence: "approximate"
        });
        expect(result.totalContainerQuantity).toBeUndefined();
    });

    it("uses approximate natural volume for container counts", () => {
        const twentyDays = calculateTotalUnits({
            dosage: parseSig("apply 1 pea-sized amount once daily to face").fhir,
            durationValue: 20,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                strength: "500 mcg / 100 mL",
                containerValue: 5,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(twentyDays.totalUnits).toBe(20);
        expect(twentyDays.totalApproximateQuantity).toMatchObject({
            value: 5,
            unit: "mL"
        });
        expect(twentyDays.totalApproximateIngredientQuantity).toMatchObject({
            value: 25,
            unit: "mcg"
        });
        expect(twentyDays.totalContainerQuantity).toEqual({ value: 5, unit: "mL" });
        expect(twentyDays.totalContainers).toBe(1);

        const twentyOneDays = calculateTotalUnits({
            dosage: parseSig("apply 1 pea-sized amount once daily to face").fhir,
            durationValue: 21,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                strength: "500 mcg / 100 mL",
                containerValue: 5,
                containerUnit: "mL"
            },
            ...BASE_OPTIONS
        });

        expect(twentyOneDays.totalApproximateQuantity).toMatchObject({
            value: 5.25,
            unit: "mL"
        });
        expect(twentyOneDays.totalContainers).toBe(2);
    });

    it("allows generic context overrides for product-specific amount approximations", () => {
        const parsed = parseSig("apply 2 FTU to face twice daily");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                unitApproximationMap: {
                    FTU: {
                        value: 0.4,
                        unit: "g",
                        confidence: "approximate",
                        basis: "site-specific product override"
                    }
                }
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(28);
        expect(result.totalApproximateQuantity).toEqual({
            value: 11.2,
            unit: "g",
            confidence: "approximate",
            basis: "site-specific product override",
            source: undefined
        });
    });

    it("allows generic context overrides for drop approximations", () => {
        const parsed = parseSig("1 drop right eye qid");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            context: {
                unitApproximationMap: {
                    drop: {
                        value: 0.03,
                        unit: "mL",
                        confidence: "product_specific",
                        basis: "label-specific drop size"
                    }
                }
            },
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(28);
        expect(result.totalApproximateQuantity).toEqual({
            value: 0.84,
            unit: "mL",
            confidence: "product_specific",
            basis: "label-specific drop size",
            source: undefined
        });
    });

    it("keeps non-convertible natural device units counted without invented estimates", () => {
        const parsed = parseSig("inhale 2 puffs twice daily");
        const result = calculateTotalUnits({
            dosage: parsed.fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });

        expect(result.totalUnits).toBe(28);
        expect(result.totalApproximateQuantity).toBeUndefined();
    });

    it("keeps body-area proxies counted without invented estimates", () => {
        const areaProxy = calculateTotalUnits({
            dosage: parseSig("apply 1 handprint to burn daily").fhir,
            durationValue: 7,
            durationUnit: FhirPeriodUnit.Day,
            ...BASE_OPTIONS
        });
        expect(areaProxy.totalUnits).toBe(7);
        expect(areaProxy.totalApproximateQuantity).toBeUndefined();
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

describe("maximum supply from a typed occurrence cap without fixed dose times", () => {
  const start = "2026-11-02T00:00:00+07:00";
  const options = { from: start, orderedAt: start, timeZone: "Asia/Bangkok" };
  /** An occurrence cap is capacity, not an instruction to invent administration clocks. */
  function capped(max: number, periodUnit = FhirPeriodUnit.Day): FhirDosage {
    return {
      asNeeded: true,
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { extension: [{
        url: TIMING_OCCURRENCE_CAP_EXTENSION_URL,
        extension: [
          { url: "max", valueInteger: max },
          { url: "period", valueQuantity: { value: 1, code: periodUnit, unit: periodUnit } }
        ]
      }] } }
    };
  }

  it("counts maximum PRN supply in scalar, array, native R6 and strict R5 without creating scheduled times", () => {
    const parsed = parseBatch("Take 1 tablet as needed up to 2 times daily.");
    for (const dosage of [parsed.fhir[0], parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }))
        .toMatchObject({ totalUnits: 14, quantityKind: "maximum" });
      expect(nextDueDoses(dosage, { ...options, limit: 2 })).toEqual([]);
    }
  });

  it("uses calendar weekly and monthly caps rather than inventing one occurrence per period", () => {
    expect(calculateTotalUnits({ dosage: capped(3, FhirPeriodUnit.Week), ...options,
      durationValue: 14, durationUnit: FhirPeriodUnit.Day
    })).toMatchObject({ totalUnits: 6, quantityKind: "maximum" });
    expect(calculateTotalUnits({ dosage: capped(4, FhirPeriodUnit.Month), ...options,
      from: "2026-11-01T00:00:00+07:00", orderedAt: "2026-11-01T00:00:00+07:00",
      durationValue: 30, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(4);
  });

  it("counts only intersecting cap periods and subtracts known prior administrations in each", () => {
    const dosage = capped(2);
    expect(calculateTotalUnits({ dosage, ...options,
      from: "2026-11-02T12:00:00+07:00", durationValue: 1, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(4);
    expect(calculateTotalUnits({ dosage, ...options,
      from: "2026-11-02T12:00:00+07:00", durationValue: 1, durationUnit: FhirPeriodUnit.Day,
      priorDoseTimes: ["2026-11-02T09:00:00+07:00"]
    }).totalUnits).toBe(3);
    expect(calculateTotalUnits({ dosage, ...options,
      from: "2026-11-02T12:00:00+07:00", durationValue: 12, durationUnit: FhirPeriodUnit.Hour
    }).totalUnits).toBe(2);
  });

  it("respects a finite course end and permitted weekdays", () => {
    const finite = capped(2);
    finite.timing!.repeat!.boundsDuration = { value: 3, code: "d", unit: "d" };
    expect(calculateTotalUnits({ dosage: finite, ...options,
      from: "2026-11-03T12:00:00+07:00", durationValue: 14, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(4);
    const weekdays = capped(2);
    weekdays.timing!.repeat!.dayOfWeek = [FhirDayOfWeek.Monday, FhirDayOfWeek.Wednesday, FhirDayOfWeek.Friday];
    expect(calculateTotalUnits({ dosage: weekdays, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(6);
  });

  it("preserves tighter lifetime count and per-period quantity limits", () => {
    const count = capped(2);
    count.timing!.repeat!.countMax = 3;
    expect(calculateTotalUnits({ dosage: count, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(3);
    const quantity = capped(2);
    quantity.maxDosePerPeriod = [{
      numerator: { value: 1, unit: "tab" }, denominator: { value: 1, unit: "d", code: "d" }
    }];
    expect(calculateTotalUnits({ dosage: quantity, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(7);
  });

  it("does not count supply before treatment onset", () => {
    expect(calculateTotalUnits({ dosage: capped(2), ...options,
      orderedAt: "2026-11-02T12:00:00+07:00", durationValue: 6, durationUnit: FhirPeriodUnit.Hour
    }).totalUnits).toBe(0);
  });

  it("multiplies allowed occurrences by dose size and supports subdaily periods", () => {
    const half = capped(2);
    half.doseAndRate![0].doseQuantity!.value = 0.5;
    expect(calculateTotalUnits({ dosage: half, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(7);
    expect(calculateTotalUnits({ dosage: capped(2, FhirPeriodUnit.Hour), ...options,
      durationValue: 30, durationUnit: FhirPeriodUnit.Minute
    }).totalUnits).toBe(2);
    const weekdays = parseBatch("Take 1 tablet as needed up to 2 times daily except Sunday.");
    expect(nextDueDoses(weekdays.fhirNext, { ...options, limit: 2 })).toEqual([]);
    expect(nextDueDoses(toFhirR5Dosages(weekdays.fhirNext), { ...options, limit: 2 })).toEqual([]);
    expect(calculateTotalUnits({ dosage: weekdays.fhirNext, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(12);
  });

  it("does not reset a rolling quantity limit at calendar midnight", () => {
    const dosage = capped(2);
    dosage.maxDosePerPeriod = [{ numerator: { value: 1, unit: "tab" },
      denominator: { value: 1, unit: "d", code: "d" } }];
    expect(calculateTotalUnits({ dosage, ...options,
      from: "2026-11-02T12:00:00+07:00", durationValue: 1, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(1);
    expect(calculateTotalUnits({ dosage, ...options,
      from: "2026-11-02T12:00:00+07:00", durationValue: 36, durationUnit: FhirPeriodUnit.Hour,
      priorDoseTimes: ["2026-11-02T10:00:00+07:00"]
    }).totalUnits).toBe(1);
  });

  it("combines rolling quantity limits with allowed weekdays rather than separate loose bounds", () => {
    const dosage = capped(2);
    dosage.timing!.repeat!.dayOfWeek = [FhirDayOfWeek.Monday, FhirDayOfWeek.Friday];
    dosage.maxDosePerPeriod = [{ numerator: { value: 1, unit: "tab" },
      denominator: { value: 7, unit: "d", code: "d" } }];
    expect(calculateTotalUnits({ dosage, ...options,
      durationValue: 14, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(2);
    const course = toDosageDetails([dosage]);
    expect(calculateTotalUnits({ dosage: toFhirR5Dosages(course), ...options,
      durationValue: 14, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(2);
  });

  it("uses certified whole-day conditions without inventing event times", () => {
    const parsed = parseBatch("Take 1 tablet as needed up to 2 times daily only on dialysis days.");
    for (const dosage of [parsed.fhir[0], parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext), toDosageDetails(toFhirR5Dosages(parsed.fhirNext))]) {
      const base = { dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day };
      expect(calculateTotalUnits({ ...base, evaluateCondition: () => false }).totalUnits).toBe(0);
      expect(calculateTotalUnits({ ...base, evaluateCondition: () => true }).totalUnits).toBe(14);
      expect(calculateTotalUnits({ ...base, evaluateCondition: (_condition, at) =>
        [2, 4, 6].includes(Number(at.slice(8, 10)))
      }).totalUnits).toBe(6);
      expect(calculateTotalUnits(base)).toMatchObject({ totalUnits: 14, quantityKind: "maximum" });
    }
  });

  it("does not treat time-varying measurement conditions as constant throughout a cap period", () => {
    const parsed = parseBatch("Take 1 tablet as needed up to 2 times daily if blood pressure is above 160.");
    let sampled = 0;
    const result = calculateTotalUnits({ dosage: parsed.fhirNext, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day,
      evaluateCondition: () => { sampled++; return false; }
    });
    expect(sampled).toBe(0);
    expect(result).toMatchObject({ totalUnits: 14, quantityKind: "maximum" });
    expect(result.explanation).toContain("administration times are unspecified");
  });

  it("does not replace actual cadence or assign a maximum to uncapped PRN", () => {
    const scheduled = capped(3);
    scheduled.asNeeded = false;
    Object.assign(scheduled.timing!.repeat!, { frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Day });
    expect(calculateTotalUnits({ dosage: scheduled, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(14);
    const unbounded = parseBatch("Take 1 tablet as needed.");
    expect(() => calculateTotalUnits({ dosage: unbounded.fhirNext, ...options,
      durationValue: 7, durationUnit: FhirPeriodUnit.Day
    })).toThrow(/no executable frequency|timing/i);
  });
});

describe("fixed administration clocks with attached meal counseling", () => {
  const orderedAt = "2026-11-02T00:00:00+07:00";
  const options = {
    orderedAt, from: orderedAt, timeZone: "Asia/Bangkok",
    eventClock: {
      [EventTiming.Breakfast]: "08:00",
      [EventTiming.Lunch]: "12:30",
      [EventTiming.Dinner]: "18:30"
    },
    mealOffsets: { [EventTiming["Before Meal"]]: -30 }
  };

  it.each([
    "1 tab PO at 07:00,12:00,18:00 x7d",
    "1 tab PO at 07:00,12:00,18:00 x7d; รับประทานก่อนอาหาร หากคลื่นไส้ให้รับประทานพร้อมอาหาร",
    "1 tab PO at 07:00,12:00,18:00 x7d; รับประทานก่อนอาหาร หากคลื่นไส้ให้แจ้งแพทย์"
  ])("does not add extra administrations from instructions attached to the same fixed doses: %s", source => {
    const parsed = parseBatch(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      expect(nextDueDoses(dosage, { ...options, limit: 6 })).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T12:00:00+07:00", "2026-11-02T18:00:00+07:00",
        "2026-11-03T07:00:00+07:00", "2026-11-03T12:00:00+07:00", "2026-11-03T18:00:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(21);
    }
    expect(parsed.fhir.every(dosage => !dosage.asNeeded)).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("preserves separately prescribed clock and meal-relative administrations", () => {
    const source = "Take 1 tablet at 07:00 for 7 days and half a tablet before breakfast for 7 days.";
    const parsed = parseBatch(source);
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...options, limit: 4 })).toEqual([
        "2026-11-02T07:00:00+07:00", "2026-11-02T07:30:00+07:00",
        "2026-11-03T07:00:00+07:00", "2026-11-03T07:30:00+07:00"
      ]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day })
        .totalUnits).toBe(10.5);
    }
  });
});

describe("cycle-day eligibility is not an unrestricted bedtime schedule", () => {
  const orderedAt = "2026-11-01T00:00:00Z";
  const base = { orderedAt, from: orderedAt, timeZone: "UTC", eventClock: { [EventTiming["Before Sleep"]]: "22:00" } };

  it.each([
    "1 cap PV HS on cycle days 16-25 for 3 cycles",
    "1 cap PV HS days 16-25 of menstrual cycle",
    "1 cap PV HS on cycle days 16-25 of every 28-day cycle",
    "1 cap PV HS x10d starting on cycle day 16"
  ])("retains the dose and editable source but requires the missing cycle information: %s", source => {
    const parsed = parseBatch(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "cap" });
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseRange).toBeUndefined();
    expect(parsed.fhir[0].site?.coding?.[0]?.code).toBe("76784001");
    expect(parsed.fhir[0].timing?.repeat?.when).toContain(EventTiming["Before Sleep"]);
    for (const dosage of [parsed.fhir[0], parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      expect(() => nextDueDoses(dosage, { ...base, limit: 84 })).toThrow(/cycle/i);
      expect(() => calculateTotalUnits({ dosage, ...base, durationValue: 84, durationUnit: FhirPeriodUnit.Day }))
        .toThrow(/cycle/i);
    }
  });

  it("keeps fully anchored finite cycle dates executable without losing dose or route", () => {
    const parsed = parseBatch("1 cap PV HS on days 16-25 of every 28-day cycle starting 2026-11-01 for 3 cycles");
    for (const dosage of [parsed.fhir[0], parsed.fhir, parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(calculateTotalUnits({ dosage, ...base, durationValue: 84, durationUnit: FhirPeriodUnit.Day }).totalUnits)
        .toBe(30);
      const times = nextDueDoses(dosage, { ...base, limit: 100 });
      expect(times).toHaveLength(30);
      expect(times[0]).toContain("2026-11-16T22:00:00");
      expect(times[times.length - 1]).toContain("2027-01-20T22:00:00");
    }
  });

  it("does not turn an absent cycle count into an authored one-cycle limit", () => {
    const unresolved = parseBatch("1 cap PV HS on cycle days 16-25 of every 28-day cycle");
    expect(unresolved.meta.canonical.clauses[0].schedule?.cycleDayConstraint?.cycles).toBeUndefined();
    for (const count of [1, 3]) {
      const explicit = parseBatch(`1 cap PV HS on cycle days 16-25 for ${count} cycles`);
      expect(explicit.meta.canonical.clauses[0].schedule?.cycleDayConstraint?.cycles).toBe(count);
    }
  });

  it("keeps the typed cycle qualifier visible when optional narrative text is absent", () => {
    const parsed = parseBatch("1 cap PV HS on cycle days 16-25 for 3 cycles");
    const original = parsed.fhir[0];
    const structured: FhirDosage = {
      doseAndRate: original.doseAndRate, route: original.route, site: original.site,
      timing: original.timing, modifierExtension: original.modifierExtension
    };
    expect(formatSig(structured, "long", { locale: "en" }).toLowerCase()).toContain("cycle days 16-25");
    const reopened = toDosageDetails([structured]);
    expect(formatSig(reopened, "long", { locale: "en" }).toLowerCase()).toContain("cycle days 16-25");
    expect(() => calculateTotalUnits({ dosage: reopened, ...base, durationValue: 84, durationUnit: FhirPeriodUnit.Day }))
      .toThrow(/cycle/i);
  });

  it("leaves ordinary bedtime courses executable and preserves unrelated extensions", () => {
    const parsed = parseBatch("1 cap PV HS x10d");
    parsed.fhir[0].modifierExtension = [{ url: "https://example.test/retained-note", valueString: "editable" }];
    expect(calculateTotalUnits({ dosage: parsed.fhir[0], ...base, durationValue: 84, durationUnit: FhirPeriodUnit.Day })
      .totalUnits).toBe(10);
    expect(parsed.fhir[0].modifierExtension[0].valueString).toBe("editable");
  });
});

describe("missed-dose counseling does not change the standing regimen", () => {
  const orderedAt = "2026-11-01T00:00:00Z";
  const options = { orderedAt, from: orderedAt, timeZone: "UTC", limit: 20 };
  const expectedDates = Array.from({ length: 7 }, (_, index) => `2026-11-0${index + 1}`);

  it.each([
    "1 tab PO QD x7d; if a dose is missed, do not double the next dose.",
    "1 tab PO QD x7d; If you miss a dose, skip it and take the next dose at the usual time.",
    "1 tab PO QD x7d; do not take an extra dose if you forget one.",
    "1 tab PO QD x7d; do not take an additional dose if you forget one."
  ])("keeps daily medication independent of counseling conditions: %s", source => {
    const parsed = parseBatch(source);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir[0].asNeeded).not.toBe(true);
    expect(getDosageCondition(parsed.fhir[0])).toBeUndefined();
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      for (const truth of [false, true]) {
        const evaluateCondition = () => truth;
        const dates = nextDueDoses(dosage, { ...options, evaluateCondition }).map(value => value.slice(0, 10));
        expect(dates).toEqual(expectedDates);
        const supply = calculateTotalUnits({ dosage, ...options, evaluateCondition,
          durationValue: 28, durationUnit: FhirPeriodUnit.Day });
        expect(supply.totalUnits).toBe(7);
        expect(supply.quantityKind).not.toBe("maximum");
      }
    }
  });

  it("retains a genuine conditional prohibition on the scheduled dose", () => {
    const parsed = parseBatch("1 tab PO at 08:00 x7d; do not take the dose if SBP <100");
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject({ kind: "not" });
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: () => false })).toEqual([]);
      expect(nextDueDoses(dosage, { ...options, evaluateCondition: () => true })
        .map(value => value.slice(0, 10))).toEqual(expectedDates);
    }
  });
});

describe("fixed clock administrations with same-clause meal qualification", () => {
  const orderedAt = "2026-11-01T00:00:00Z";
  const options = { orderedAt, from: orderedAt, timeZone: "UTC",
    eventClock: { [EventTiming.Breakfast]: "08:00", [EventTiming.Lunch]: "12:30", [EventTiming.Dinner]: "18:30" },
    mealOffsets: { [EventTiming["Before Meal"]]: -30, [EventTiming["After Meal"]]: 30 }
  };
  it.each([
    "1 tab PO at 07:00, 12:00 and 18:00 before meals x7d",
    "1 tab PO 07:00, 12:00, 18:00 ac x7d",
    "1 tab PO at 07:00,12:00,18:00 pc x7d",
    "Take 1 tablet at 07:00,12:00 and 18:00 for 7 days before meals",
    "Take 1 tablet at 07:00,12:00 and 18:00 for 7 days; before meals"
  ])("keeps the prescribed fixed administration count: %s", source => {
    const parsed = parseBatch(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    for (const dosage of [parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      const times = nextDueDoses(dosage, { ...options, limit: 6 });
      expect(times.map(value => value.slice(11, 16))).toEqual(["07:00", "12:00", "18:00", "07:00", "12:00", "18:00"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(21);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
    const afterMeals = source.includes(" pc ");
    expect(parsed.longText.toLowerCase()).toMatch(afterMeals ? /after (?:food|meals)/ : /before (?:food|meals)/);
    expect(formatSig(parsed.fhirNext, "long", { locale: "th" }))
      .toContain(afterMeals ? "หลังอาหาร" : "ก่อนอาหาร");
  });

  it("preserves an explicitly coordinated extra meal occasion", () => {
    const parsed = parseBatch("1 tab PO at 07:00 and before breakfast x7d");
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      expect(nextDueDoses(dosage, { ...options, limit: 2 }).map(value => value.slice(11, 16)))
        .toEqual(["07:00", "07:30"]);
      expect(calculateTotalUnits({ dosage, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits).toBe(14);
    }
  });

  it("leaves independent quantities and imported structured union schedules unchanged", () => {
    const source = parseBatch("Take 1 tablet at 07:00 for 7 days and half a tablet before breakfast for 7 days.");
    expect(calculateTotalUnits({ dosage: source.fhirNext, ...options, durationValue: 7, durationUnit: FhirPeriodUnit.Day }).totalUnits)
      .toBe(10.5);
    const imported: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { timeOfDay: ["07:00:00"], when: [EventTiming["Before Breakfast"]] } } };
    expect(nextDueDoses(imported, { ...options, limit: 2 }).map(value => value.slice(11, 16)))
      .toEqual(["07:00", "07:30"]);
  });
});


describe("anchored course duration preservation", () => {
  it.each([
    { source: "1 tab PO QD from 2027-01-31 for 1 month", start: "2027-01-31", end: "2027-02-27",
      stop: "2027-02-28T00:00:00Z", value: 1, unit: "mo", total: 28, horizon: 40 },
    { source: "1 tab PO QD from 2028-01-31 for 1 month", start: "2028-01-31", end: "2028-02-28",
      stop: "2028-02-29T00:00:00Z", value: 1, unit: "mo", total: 29, horizon: 40 },
    { source: "1 tab PO QD from 2027-08-31 for 1 month", start: "2027-08-31", end: "2027-09-29",
      stop: "2027-09-30T00:00:00Z", value: 1, unit: "mo", total: 30, horizon: 40 },
    { source: "1 tab PO QD from 2028-02-29 for 1 year", start: "2028-02-29", end: "2029-02-27",
      stop: "2029-02-28T00:00:00Z", value: 1, unit: "a", total: 365, horizon: 400 },
    { source: "1 tab PO BID from 2026-11-02 for 1.5 weeks", start: "2026-11-02", end: undefined,
      stop: "2026-11-12T12:00:00Z", value: 1.5, unit: "wk", total: 21, horizon: 20 },
    { source: "1 tab PO q12h from 2026-11-02 for 36 hours", start: "2026-11-02", end: undefined,
      stop: "2026-11-03T12:00:00Z", value: 36, unit: "h", total: 3, horizon: 10 },
    { source: "1 tab PO QD from 2026-11-02 for 5-7 days", start: "2026-11-02", end: undefined,
      stop: "2026-11-09T00:00:00Z", value: 5, max: 7, unit: "d", total: 7, horizon: 20 },
    { source: "1 tab PO QD from 2026-11-02 until 2026-11-30 for 7 days", start: "2026-11-02", end: "2026-11-30",
      stop: "2026-11-09T00:00:00Z", value: 7, unit: "d", total: 7, horizon: 40 }
  ])("keeps a finite executable course and original duration: $source", entry => {
    const parsed = parseBatch(entry.source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    expect(parsed.fhirNext.renderedInstruction).toBe(entry.source);
    expect(parsed.meta.canonical.clauses[0].schedule).toMatchObject({
      duration: entry.value, durationUnit: entry.unit, boundsStart: entry.start
    });
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      const rows = Array.isArray(dosage) ? dosage : "fhirNext" in dosage
        ? toFhirR5Dosages(dosage.fhirNext) : toFhirR5Dosages(dosage);
      expect(rows).toHaveLength(1);
      const repeat = rows[0].timing!.repeat!;
      expect(repeat.boundsPeriod?.start).toBe(entry.start);
      if (entry.end) expect(repeat.boundsPeriod?.end).toBe(entry.end);
      expect([repeat.boundsPeriod, repeat.boundsDuration, repeat.boundsRange].filter(Boolean)).toHaveLength(1);
      const restored = parserStateFromFhir(rows[0]).primaryClause.schedule!;
      expect(restored.duration).toBe(entry.value);
      expect(restored.durationMax).toBe(entry.max);
      expect(restored.durationUnit).toBe(entry.unit);
      const anchor = entry.start + "T00:00:00Z";
      expect(calculateTotalUnits({ dosage, from: anchor, orderedAt: anchor,
        timeZone: "UTC", durationValue: entry.horizon, durationUnit: "d" }).totalUnits).toBe(entry.total);
      expect(nextDueDoses(dosage, { from: entry.stop, orderedAt: anchor,
        timeZone: "UTC", limit: 2 })).toEqual([]);
    }
  });
  it("starts the next anchored phase after the clamped calendar month", () => {
    const source = "1 tab PO QD from 2027-01-31 for 1 month then 2 tabs PO QD for 7 days";
    const parsed = parseBatch(source);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    const anchor = "2027-01-31T00:00:00Z";
    const dates = ["2027-02-28", "2027-03-01", "2027-03-02", "2027-03-03",
      "2027-03-04", "2027-03-05", "2027-03-06"];
    for (const dosage of [parsed, parsed.fhir, parsed.fhirNext, strict, toDosageDetails(strict)]) {
      expect(calculateTotalUnits({ dosage, from: anchor, orderedAt: anchor, timeZone: "UTC",
        durationValue: 45, durationUnit: "d" }).totalUnits).toBe(42);
      expect(nextDueDoses(dosage, { from: "2027-02-28T00:00:00Z", orderedAt: anchor,
        timeZone: "UTC", limit: 10 }).map(value => new Date(value).toISOString()))
        .toEqual(dates.map(date => date + "T09:00:00.000Z"));
      expect(nextDueDoses(dosage, { from: "2027-03-07T00:00:00Z", orderedAt: anchor,
        timeZone: "UTC", limit: 2 })).toEqual([]);
    }
  });
});

describe("weekly clock frequency and exact calendar supply", () => {
  const options = {
    timeZone: "Asia/Bangkok",
    from: "2026-11-01T00:00:00+07:00",
    orderedAt: "2026-11-01T00:00:00+07:00",
    eventClock: { HS: "22:00", CM: "08:00" },
    mealOffsets: { PCM: 30 }
  };
  const twiceWeeklyDays = [1, 4, 8, 11, 15, 18, 22, 25];
  const stamp = (day: number, clock: string) =>
    `2026-11-${String(day).padStart(2, "0")}T${clock}:00+07:00`;
  const forms = (input: string) => {
    const parsed = parseBatch(input);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    return [parsed.fhir, parsed.fhirNext, strict,
      toDosageDetails(JSON.parse(JSON.stringify(strict)))];
  };

  it.each([
    ["1 tab PV HS twice weekly x28d", "22:00", twiceWeeklyDays],
    ["1 tab PO twice weekly at 22:00 x28d", "22:00", twiceWeeklyDays],
    ["1 tab PO twice weekly after breakfast x28d", "08:30", twiceWeeklyDays],
    ["1 tab PO three times weekly HS x28d", "22:00", [1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26]]
  ] as const)("keeps the full frequency with a clock: %s", (input, clock, days) => {
    const expected = days.map(day => stamp(day, clock));
    for (const dosage of forms(input)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 40 })).toEqual(expected);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(days.length);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });

  it("keeps loading plus twice-weekly bedtime maintenance at eighteen tablets", () => {
    const input = "1 tab PV HS daily x14d then 1 tab PV HS twice weekly";
    const expected = [
      ...Array.from({ length: 14 }, (_, i) => stamp(i + 1, "22:00")),
      ...[15, 18, 22, 25].map(day => stamp(day, "22:00"))
    ];
    for (const dosage of forms(input)) {
      expect(nextDueDoses(dosage, { ...options, limit: 40 })
        .filter(value => Date.parse(value) < Date.parse("2026-11-29T00:00:00+07:00")))
        .toEqual(expected);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(18);
    }
  });

  it("preserves explicit weekdays and a once-weekly clock", () => {
    for (const [input, days] of [
      ["1 tab PV HS Mon Thu x28d", [2, 5, 9, 12, 16, 19, 23, 26]],
      ["1 tab PV HS weekly x28d", [1, 8, 15, 22]]
    ] as const) {
      for (const dosage of forms(input)) {
        expect(nextDueDoses(dosage, { ...options, limit: 40 }))
          .toEqual(days.map(day => stamp(day, "22:00")));
        expect(calculateTotalUnits({
          ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
        }).totalUnits).toBe(days.length);
      }
    }
  });

  it("uses the whole multiweek period and preserves an already-passed clock", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 2, period: 2, periodUnit: FhirPeriodUnit.Week, timeOfDay: ["22:00:00"]
      } }
    };
    const late = { ...options, from: "2026-11-01T23:00:00+07:00", orderedAt: "2026-11-01T23:00:00+07:00" };
    const expected = [8, 15, 22, 29].map(day => stamp(day, "22:00"));
    expect(nextDueDoses(dosage, { ...late, limit: 4 })).toEqual(expected);
    expect(calculateTotalUnits({
      ...late, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(4);
  });

  it("keeps weekly meal offsets that cross the previous midnight", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Week,
        when: ["ACM" as EventTiming], offset: 120
      } }
    };
    const earlyMeal = { ...options, eventClock: { CM: "01:00" } };
    expect(nextDueDoses(dosage, { ...earlyMeal, limit: 8 }))
      .toEqual([3, 7, 10, 14, 17, 21, 24, 28].map(day => stamp(day, "23:00")));
    expect(calculateTotalUnits({
      ...earlyMeal, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(8);
    dosage.timing!.repeat!.count = 5;
    const later = { ...earlyMeal, from: "2026-11-08T00:00:00+07:00" };
    expect(nextDueDoses(dosage, { ...later, limit: 10 }))
      .toEqual([10, 14, 17].map(day => stamp(day, "23:00")));
    expect(calculateTotalUnits({
      ...later, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(3);
  });

  it("derives the remaining occurrence cap from the same weekly clock cadence", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        count: 5, frequency: 2, period: 1, periodUnit: FhirPeriodUnit.Week,
        when: [EventTiming["Before Sleep"]]
      } }
    };
    const later = { ...options, from: "2026-11-08T00:00:00+07:00" };
    expect(nextDueDoses(dosage, { ...later, limit: 10 }))
      .toEqual([8, 11, 15].map(day => stamp(day, "22:00")));
    expect(calculateTotalUnits({
      ...later, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
    }).totalUnits).toBe(3);
  });

  it.each([
    "1 tab PO on days 3-7 of each 28-day cycle starting 2026-11-01 for 1 cycle",
    "1 tab PO QD on days 3-7 of each 28-day cycle starting 2026-11-01 for 1 cycle"
  ])("counts an explicit finite calendar without demanding another frequency: %s", input => {
    for (const dosage of forms(input)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 20 }).map(value => value.slice(0, 10)))
        .toEqual([3, 4, 5, 6, 7].map(day => stamp(day, "00:00").slice(0, 10)));
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(5);
      expect(calculateTotalUnits({
        ...options, from: "2026-11-05T00:00:00+07:00",
        dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(3);
      expect(JSON.stringify(dosage)).toBe(before);
    }
  });
});

describe("monthly day membership supply", () => {
  const options = {
    timeZone: "Asia/Bangkok",
    from: "2026-11-01T00:00:00+07:00",
    orderedAt: "2026-11-01T00:00:00+07:00",
    eventClock: { HS: "22:00" }
  };
  const forms = (input: string) => {
    const parsed = parseBatch(input);
    const strict = toFhirR5Dosages(parsed.fhirNext);
    return [parsed.fhir, parsed.fhirNext, strict,
      toDosageDetails(JSON.parse(JSON.stringify(strict)))];
  };
  const dates = (month: string, days: readonly number[], clock = "09:00") =>
    days.map(day => `${month}-${String(day).padStart(2, "0")}T${clock}:00+07:00`);
  const firstFourteen = Array.from({ length: 14 }, (_, i) => i + 1);

  it.each([
    "1 tab PO QD on days 1-14 of each month",
    "1 tab PO QD days 1 through 14 each month",
    "1 tab PO on days 1-14 of each month QD",
    "รับประทาน 1 เม็ด วันละครั้ง วันที่ 1-14 ของทุกเดือน"
  ])("executes calendar membership without inflating the dose: %s", input => {
    const expected = [
      ...dates("2026-11", firstFourteen), ...dates("2026-12", firstFourteen)
    ];
    for (const dosage of forms(input)) {
      const before = JSON.stringify(dosage);
      expect(nextDueDoses(dosage, { ...options, limit: 28 })).toEqual(expected);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 61, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(28);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(14);
      expect(JSON.stringify(dosage)).toBe(before);
      expect(before).toContain(input);
    }
  });

  it("keeps month membership anchored when the supply query starts later", () => {
    const later = { ...options, from: "2026-11-10T00:00:00+07:00" };
    const expected = [
      ...dates("2026-11", [10, 11, 12, 13, 14]),
      ...dates("2026-12", [1, 2, 3, 4, 5, 6, 7])
    ];
    for (const dosage of forms("1 tab PO QD on days 1-14 of each month")) {
      expect(nextDueDoses(dosage, { ...later, limit: 12 })).toEqual(expected);
      expect(calculateTotalUnits({
        ...later, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(12);
    }
  });

  it.each([
    ["2027", 59, ["2027-03-29", "2027-03-30", "2027-03-31"]],
    ["2028", 60, ["2028-02-29", "2028-03-29", "2028-03-30", "2028-03-31"]]
  ] as const)("omits nonexistent month days instead of clamping them in %s", (year, duration, expectedDates) => {
    const start = `${year}-02-01T00:00:00+07:00`;
    const calendar = { ...options, from: start, orderedAt: start };
    for (const dosage of forms("1 tab PO QD on days 29-31 of each month")) {
      expect(nextDueDoses(dosage, { ...calendar, limit: expectedDates.length }))
        .toEqual(expectedDates.map(day => day + "T09:00:00+07:00"));
      expect(calculateTotalUnits({
        ...calendar, dosage, durationValue: duration, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(expectedDates.length);
    }
  });

  it("intersects explicit weekdays and bedtime with monthly day membership", () => {
    for (const dosage of forms("1 tab PO HS Mon Thu on days 1-14 of each month")) {
      expect(nextDueDoses(dosage, { ...options, limit: 5 })).toEqual([
        ...dates("2026-11", [2, 5, 9, 12], "22:00"),
        ...dates("2026-12", [3], "22:00")
      ]);
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(4);
    }
  });

  it("applies month membership to elapsed intervals without changing their clock", () => {
    const interval = {
      ...options, from: "2026-11-01T08:00:00+07:00",
      orderedAt: "2026-11-01T08:00:00+07:00"
    };
    const expected: string[] = [];
    for (const day of firstFourteen) {
      expected.push(...dates("2026-11", [day], "08:00"), ...dates("2026-11", [day], "20:00"));
    }
    for (const dosage of forms("1 tab PO q12h on days 1-14 of each month x28d")) {
      expect(nextDueDoses(dosage, { ...interval, limit: 50 })).toEqual(expected);
      expect(calculateTotalUnits({
        ...interval, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(28);
    }
  });

  it("counts only eligible month days toward an interval occurrence cap", () => {
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        count: 30, frequency: 1, period: 12, periodUnit: FhirPeriodUnit.Hour,
        extension: firstFourteen.map(day => ({
          url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: day
        }))
      } }
    };
    const native = toDosageDetails([dosage]);
    const strict = toFhirR5Dosages(native);
    const later = { ...options, orderedAt: "2026-11-01T08:00:00+07:00",
      from: "2026-12-01T08:00:00+07:00" };
    for (const value of [dosage, native, strict, toDosageDetails(JSON.parse(JSON.stringify(strict)))]) {
      expect(nextDueDoses(value, { ...later, limit: 10 })).toEqual([
        ...dates("2026-12", [1], "08:00"), ...dates("2026-12", [1], "20:00")
      ]);
      expect(calculateTotalUnits({
        ...later, dosage: value, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(2);
    }
  });

  it("keeps exact calendar dates authoritative instead of inferring a weekday ordinal", () => {
    for (const restrictMonthDays of [false, true]) {
      const dosage: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { event: ["2026-11-02", "2026-11-09", "2026-11-16"], repeat: {
          frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Month,
          dayOfWeek: ["mon" as FhirDayOfWeek],
          extension: restrictMonthDays ? firstFourteen.map(day => ({
            url: "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth", valuePositiveInt: day
          })) : undefined
        } }
      };
      const days = restrictMonthDays ? [2, 9] : [2, 9, 16];
      expect(nextDueDoses(dosage, { ...options, limit: 10 }))
        .toEqual(dates("2026-11", days, "00:00"));
      expect(calculateTotalUnits({
        ...options, dosage, durationValue: 28, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(days.length);
    }
  });

  it("executes imported standard month-day extensions and preserves unrelated metadata", () => {
    const url = "http://hl7.org/fhir/StructureDefinition/timing-dayOfMonth";
    const note = { url: "https://example.org/clinical-note", valueString: "retain" };
    const dosage: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: {
        frequency: 1, period: 1, periodUnit: FhirPeriodUnit.Day,
        extension: [{ url, valuePositiveInt: 1 }, { url, valuePositiveInt: 15 }, note]
      } }
    };
    const native = toDosageDetails([dosage]);
    const strict = toFhirR5Dosages(native);
    const reopened = toDosageDetails(JSON.parse(JSON.stringify(strict)));
    for (const value of [dosage, native, strict, reopened]) {
      const before = JSON.stringify(value);
      expect(nextDueDoses(value, { ...options, limit: 4 })).toEqual([
        ...dates("2026-11", [1, 15]), ...dates("2026-12", [1, 15])
      ]);
      expect(calculateTotalUnits({
        ...options, dosage: value, durationValue: 61, durationUnit: FhirPeriodUnit.Day
      }).totalUnits).toBe(4);
      expect(JSON.stringify(value)).toBe(before);
    }
    expect(toFhirR5Dosages(reopened)[0].timing?.repeat?.extension).toContainEqual(note);
  });
});
