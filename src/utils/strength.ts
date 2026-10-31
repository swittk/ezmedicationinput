import { FhirRatio, FhirQuantity, MedicationContext } from "../types";
import { DEFAULT_UNIT_BY_NORMALIZED_FORM, KNOWN_DOSAGE_FORMS_TO_DOSE } from "../maps";
import { arrayIncludes } from "./array";

/**
 * High-level strength parser that returns the most appropriate FHIR representation.
 */
export function parseStrength(
    strength: string, context?: MedicationContext
): { strengthQuantity?: FhirQuantity; strengthRatio?: FhirRatio;
     strengthComponents?: Array<{ strengthQuantity?: FhirQuantity; strengthRatio?: FhirRatio }> } {
    if (strength.includes("+")) {
        const strengthComponents = parseStrengthComponents(strength, context);
        return strengthComponents ? { strengthComponents } : {};
    }
    const ratio = parseStrengthIntoRatio(strength, context);
    if (!ratio) return {};

    if (ratio.denominator?.value === 1 && (ratio.denominator?.unit === "unit" || !ratio.denominator?.unit)) {
        return { strengthQuantity: ratio.numerator };
    }

    return { strengthRatio: ratio };
}

/**
 * Retain each ingredient's strength separately. The names of the ingredients
 * must come from the medication/product record, not from unnamed SIG numbers.
 *
 * Use this when parsing combination products: summing 875 mg + 125 mg as one
 * active-ingredient strength would be clinically misleading.
 * Returns null if any component cannot be parsed, not a partial ingredient set.
 */
export function parseStrengthComponents(
    strength: string,
    context?: MedicationContext
): Array<{ strengthQuantity?: FhirQuantity; strengthRatio?: FhirRatio }> | null {
    const parts = strength.split("+").map(part => part.trim());
    if (parts.some(part => part.length === 0)) return null;
    const result: Array<{ strengthQuantity?: FhirQuantity; strengthRatio?: FhirRatio }> = [];
    for (const part of parts) {
        const ratio = parseSingleStrengthPart(part, context);
        if (!ratio || !ratio.numerator || !Number.isFinite(ratio.numerator.value) ||
            !ratio.numerator.value || ratio.numerator.value <= 0) return null;
        if (ratio.denominator?.value === 1 &&
            (ratio.denominator.unit === "unit" || !ratio.denominator.unit)) {
            result.push({ strengthQuantity: ratio.numerator });
        } else {
            result.push({ strengthRatio: ratio });
        }
    }
    return result.length ? result : null;
}

/**
 * Internal helper to parse a strength string into a FHIR Ratio.
 */
export function parseStrengthIntoRatio(strength: string, context?: MedicationContext): FhirRatio | null {
    // A single Ratio must describe ONE ingredient. A multi-ingredient
    // strength belongs in the structured components API, never a summed ratio.
    if (strength.includes("+")) return null;
    return parseSingleStrengthPart(strength, context);
}

function isSolidDosageForm(form: string): boolean {
    const normalized = form.toLowerCase().trim();

    // 1. Get the default unit for this form
    let unit = DEFAULT_UNIT_BY_NORMALIZED_FORM[normalized];
    if (!unit) {
        const mapped = KNOWN_DOSAGE_FORMS_TO_DOSE[normalized];
        if (mapped) {
            unit = DEFAULT_UNIT_BY_NORMALIZED_FORM[mapped];
        }
    }

    // 2. Identify if it's explicitly a liquid/gas unit
    const liquidUnits = ["ml", "spray", "puff", "drop"];
    if (unit) {
        const u = unit.toLowerCase();
        if (arrayIncludes(liquidUnits, u)) return false;
        // Any other mapped unit (g, tab, cap, etc.) is considered solid for % purpose
        return true;
    }

    // 3. Keyword-based heuristics as fallback
    const solidKeywords = [
        "tablet", "capsule", "patch", "cream", "ointment", "gel", "paste",
        "suppositor", "powder", "lozenge", "patch", "stick", "implant",
        "piece", "granule", "lozenge", "pessary"
    ];
    for (let i = 0; i < solidKeywords.length; i++) {
        if (normalized.indexOf(solidKeywords[i]) !== -1) return true;
    }

    return false;
}

function parseSingleStrengthPart(part: string, context?: MedicationContext): FhirRatio | null {
    const p = part.trim();

    // 1. Percentage
    const percentMatch = p.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (percentMatch) {
        const isSolid = context?.dosageForm && isSolidDosageForm(context.dosageForm);
        return {
            numerator: { value: parseFloat(percentMatch[1]), unit: "g" },
            denominator: { value: 100, unit: isSolid ? "g" : "mL" }
        };
    }

    // 2. Ratio
    const ratioMatch = p.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z0-9%]+)?\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-zA-Z0-9%]+)$/);
    if (ratioMatch) {
        return {
            numerator: {
                value: parseFloat(ratioMatch[1]),
                unit: ratioMatch[2]?.trim() || "mg"
            },
            denominator: {
                value: ratioMatch[3] ? parseFloat(ratioMatch[3]) : 1,
                unit: ratioMatch[4]?.trim()
            }
        };
    }

    // 3. Simple Quantity
    const quantityMatch = p.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z0-9%]+)$/);
    if (quantityMatch) {
        return {
            numerator: { value: parseFloat(quantityMatch[1]), unit: quantityMatch[2].trim() },
            denominator: { value: 1, unit: "unit" }
        };
    }

    return null;
}
