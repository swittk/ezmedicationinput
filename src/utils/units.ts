import { getDoseQuantityUnit } from "../maps";

export const MASS_UNITS: Record<string, number> = {
    kg: 1000000,
    g: 1000,
    mg: 1,
    mcg: 0.001,
    ug: 0.001,
    microg: 0.001,
    ng: 0.000001
};

export const VOLUME_UNITS: Record<string, number> = {
    l: 1000,
    dl: 100,
    ml: 1,
    ul: 0.001,
    microl: 0.001,
    cm3: 1,
    tsp: 5,
    tbsp: 15
};

export function getUnitCategory(unit?: string): "mass" | "volume" | "other" {
    if (!unit) return "other";
    const u = unit.toLowerCase();
    if (MASS_UNITS[u] !== undefined) return "mass";
    if (VOLUME_UNITS[u] !== undefined) return "volume";
    return "other";
}

export function getBaseUnitFactor(unit?: string): number {
    if (!unit) return 1;
    const u = unit.toLowerCase();
    return MASS_UNITS[u] ?? VOLUME_UNITS[u] ?? 1;
}

export function convertValue(
    value: number,
    fromUnit: string,
    toUnit: string,
    strength?: { numerator: { value: number, unit: string }, denominator: { value: number, unit: string } }
): number | null {
    const f = fromUnit.toLowerCase();
    const t = toUnit.toLowerCase();
    if (f === t) return value;

    const fCat = getUnitCategory(f);
    const tCat = getUnitCategory(t);

    // 1. Same category conversion
    if (fCat === tCat && fCat !== "other") {
        const fFactor = getBaseUnitFactor(f);
        const tFactor = getBaseUnitFactor(t);
        return (value * fFactor) / tFactor;
    }

    // The same supported weight denominator cancels before mass-prefix conversion.
    if (f.endsWith("/kg") && t.endsWith("/kg")) {
        const fromMass = f.slice(0, -3), toMass = t.slice(0, -3);
        if (MASS_UNITS[fromMass] !== undefined && MASS_UNITS[toMass] !== undefined)
            return convertValue(value, fromMass, toMass);
    }

    // 2. Cross-category conversion using strength
    if (strength && ((fCat === "mass" && tCat === "volume") || (fCat === "volume" && tCat === "mass"))) {
        const numUnit = strength.numerator.unit.toLowerCase();
        const denUnit = strength.denominator.unit.toLowerCase();
        const numCat = getUnitCategory(numUnit);
        const denCat = getUnitCategory(denUnit);

        if (numCat !== denCat && numCat !== "other" && denCat !== "other") {
            const massSide = numCat === "mass" ? strength.numerator : strength.denominator;
            const volSide = numCat === "volume" ? strength.numerator : strength.denominator;

            // Normalize bridge to base units (mg/mL)
            const bridgeDensity = (massSide.value * getBaseUnitFactor(massSide.unit)) / (volSide.value * getBaseUnitFactor(volSide.unit));

            if (fCat === "mass") {
                // Mass to Volume: value_mg / density_mg_per_ml
                const valueMg = value * getBaseUnitFactor(fromUnit);
                const valueMl = valueMg / bridgeDensity;
                return valueMl / getBaseUnitFactor(toUnit);
            } else {
                // Volume to Mass: value_ml * density_mg_per_ml
                const valueMl = value * getBaseUnitFactor(fromUnit);
                const valueMg = valueMl * bridgeDensity;
                return valueMg / getBaseUnitFactor(toUnit);
            }
        }
    }

    return null;
}

type QuantityUnit = { system?: string; code?: string; unit?: string };

/** Normalize equivalent count-unit labels before dimensional conversion. */
export function normalizeQuantityCapUnit(unit: string): string {
    const text = unit.trim().toLowerCase();
    switch (text) {
        case "tab": case "tabs": case "tablet": case "tablets": return "tab";
        case "cap": case "caps": case "capsule": case "capsules": return "cap";
        case "drop": case "drops": return "drop";
        case "nebule": case "nebules": case "respule": case "respules": return "nebule";
        default: return text;
    }
}

/** Exact coding compares quantities without assigning an opaque code a dimension. */
export function sameCodedQuantityUnit(left: QuantityUnit | undefined, right: QuantityUnit | undefined): boolean {
    return Boolean(left?.system && left.code && left.system === right?.system && left.code === right.code);
}

/** The calculation unit shared by numeric comparison and compatible-unit indexing. */
export function getQuantityComparisonUnit(quantity: QuantityUnit | undefined): string {
    return normalizeQuantityCapUnit(getDoseQuantityUnit(quantity, false));
}

/** Compare quantity identities before resolving their supported dimensional or
 * plain-label units. Missing labels never make distinct coded quantities equal. */
export function convertQuantityValue(
    value: number,
    from: QuantityUnit | undefined,
    to: QuantityUnit | undefined,
    strength?: Parameters<typeof convertValue>[3]
): number | null {
    if (sameCodedQuantityUnit(from, to)) return value;
    const fromUnit = getQuantityComparisonUnit(from);
    const toUnit = getQuantityComparisonUnit(to);
    if (!fromUnit && !toUnit && from && to && !from.code && !from.system && !to.code && !to.system) return value;
    if (!fromUnit || !toUnit) return null;
    return convertValue(value, fromUnit, toUnit, strength);
}
