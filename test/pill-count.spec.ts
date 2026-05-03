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
