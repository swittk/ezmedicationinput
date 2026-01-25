import { FhirRatio, FhirQuantity, MedicationContext } from "../types";
import { getBaseUnitFactor, getUnitCategory } from "./units";
import { DEFAULT_UNIT_BY_NORMALIZED_FORM, KNOWN_DOSAGE_FORMS_TO_DOSE } from "../maps";
import { arrayIncludes } from "./array";

/**
 * High-level strength parser that returns the most appropriate FHIR representation.
 */
export function parseStrength(strength: string, context?: MedicationContext): { strengthQuantity?: FhirQuantity, strengthRatio?: FhirRatio } {
    const ratio = parseStrengthIntoRatio(strength, context);
    if (!ratio) return {};

    if (ratio.denominator?.value === 1 && (ratio.denominator?.unit === "unit" || !ratio.denominator?.unit)) {
        return { strengthQuantity: ratio.numerator };
    }

    return { strengthRatio: ratio };
}

/**
 * Internal helper to parse a strength string into a FHIR Ratio.
 */
export function parseStrengthIntoRatio(strength: string, context?: MedicationContext): FhirRatio | null {
    const parts = strength.split("+").map((p) => p.trim());
    let totalMgPerMlOrG = 0;
    let hasVolume = false;
    let hasWeightDenominator = false;

    let targetNumUnit: string | undefined;
    let targetDenUnit: string | undefined;
    let targetDenValue: number | undefined;

    for (const part of parts) {
        const ratio = parseSingleStrengthPart(part, context);
        if (!ratio || !ratio.numerator?.value || ratio.numerator.value === 0) continue;

        const nUnit = ratio.numerator.unit;
        const dUnit = ratio.denominator?.unit || "unit";
        const dCat = getUnitCategory(dUnit);

        // Save target units from the first part
        if (!targetNumUnit) targetNumUnit = nUnit;
        if (!targetDenUnit) targetDenUnit = dUnit;
        if (targetDenValue === undefined) targetDenValue = ratio.denominator?.value;

        const nValue = ratio.numerator.value;
        const dValue = ratio.denominator?.value ?? 1;

        const nFactor = getBaseUnitFactor(nUnit);
        const dFactor = (dCat === "volume" || dCat === "mass") ? getBaseUnitFactor(dUnit) : 1;

        totalMgPerMlOrG += (nValue * nFactor) / (dValue * dFactor);
        if (dCat === "volume") hasVolume = true;
        if (dCat === "mass") hasWeightDenominator = true;
    }

    if (totalMgPerMlOrG === 0) return null;

    const isComposite = parts.length > 1;
    const resultNumUnit = isComposite ? "mg" : (targetNumUnit || "mg");

    let resultDenUnit = targetDenUnit || "unit";
    if (isComposite) {
        if (hasVolume) resultDenUnit = "mL";
        else if (hasWeightDenominator) resultDenUnit = "g";
        else resultDenUnit = "unit";
    }

    const resultDenValue = isComposite ? 1 : (targetDenValue ?? 1);

    const denCat = getUnitCategory(resultDenUnit);
    const dBaseFactor = (denCat === "volume" || denCat === "mass")
        ? getBaseUnitFactor(resultDenUnit)
        : 1;
    const totalBaseDenominatorValue = resultDenValue * dBaseFactor;

    const totalNumeratorMg = totalMgPerMlOrG * totalBaseDenominatorValue;
    const finalNumValue = totalNumeratorMg / getBaseUnitFactor(resultNumUnit);

    return {
        numerator: { value: finalNumValue, unit: resultNumUnit },
        denominator: { value: resultDenValue, unit: resultDenUnit }
    };
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
