import { describe, expect, it } from "vitest";
import { parseStrengthIntoRatio, parseStrength } from "../src/utils/strength";

describe("parseStrength", () => {
    it("returns strengthQuantity for simple amounts", () => {
        const res = parseStrength("500 mg");
        expect(res.strengthQuantity?.value).toBe(500);
        expect(res.strengthQuantity?.unit).toBe("mg");
        expect(res.strengthRatio).toBeUndefined();
    });

    it("returns strengthRatio for ratio amounts", () => {
        const res = parseStrength("100 mg / 5 mL");
        expect(res.strengthRatio?.numerator?.value).toBe(100);
        expect(res.strengthRatio?.denominator?.value).toBe(5);
        expect(res.strengthQuantity).toBeUndefined();
    });
});

describe("parseStrengthIntoRatio", () => {
    it("parses simple mass quantity", () => {
        const res = parseStrengthIntoRatio("500 mg");
        expect(res?.numerator?.value).toBe(500);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("unit");
    });

    it("parses percentage as g/100mL by default", () => {
        const res = parseStrengthIntoRatio("2%");
        expect(res?.numerator?.value).toBe(2);
        expect(res?.denominator?.value).toBe(100);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("parses percentage as g/100g for solid/semi-solid forms", () => {
        const res = parseStrengthIntoRatio("2%", { dosageForm: "cream" });
        expect(res?.numerator?.value).toBe(2);
        expect(res?.denominator?.value).toBe(100);
        expect(res?.denominator?.unit).toBe("g");

        expect(parseStrengthIntoRatio("1%", { dosageForm: "ointment" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("1%", { dosageForm: "gel" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("1%", { dosageForm: "paste" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("5%", { dosageForm: "tablet" })?.denominator?.unit).toBe("g");
    });

    it("detects complex solid forms from maps.ts", () => {
        expect(parseStrengthIntoRatio("1%", { dosageForm: "eye ointment" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("1%", { dosageForm: "transdermal patch" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("1%", { dosageForm: "cutaneous stick" })?.denominator?.unit).toBe("g");
        expect(parseStrengthIntoRatio("1%", { dosageForm: "suppository" })?.denominator?.unit).toBe("g");
    });

    it("detects liquid forms from maps.ts", () => {
        expect(parseStrengthIntoRatio("5%", { dosageForm: "oral solution" })?.denominator?.unit).toBe("mL");
        expect(parseStrengthIntoRatio("5%", { dosageForm: "oral suspension" })?.denominator?.unit).toBe("mL");
        expect(parseStrengthIntoRatio("5%", { dosageForm: "eye drops" })?.denominator?.unit).toBe("mL");
        expect(parseStrengthIntoRatio("5%", { dosageForm: "nasal spray" })?.denominator?.unit).toBe("mL");
    });

    it("parses ratio strength", () => {
        const res = parseStrengthIntoRatio("262 mg/15 mL");
        expect(res?.numerator?.value).toBe(262);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(15);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("parses ratio with implicit unit numerator", () => {
        const res = parseStrengthIntoRatio("200 / 2 mL");
        expect(res?.numerator?.value).toBe(200);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(2);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("parses complex composite strengths (addition)", () => {
        const res = parseStrengthIntoRatio("400 mg + 80 mg");
        expect(res?.numerator?.value).toBe(480);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("unit");
    });

    it("parses composite ratio strengths with same denominator", () => {
        const res = parseStrengthIntoRatio("400 mg/5mL + 80 mg/5mL");
        expect(res?.numerator?.value).toBe(96);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("normalizes composite ratio strengths with different denominators", () => {
        const res = parseStrengthIntoRatio("100 mg / 5 mL + 10 mg / 1 mL");
        expect(res?.numerator?.value).toBe(30);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("handles various mass units", () => {
        expect(parseStrengthIntoRatio("1 g")?.numerator?.value).toBe(1);
        expect(parseStrengthIntoRatio("1000 mcg")?.numerator?.value).toBe(1000);
        expect(parseStrengthIntoRatio("500 ng")?.numerator?.value).toBeCloseTo(500);
    });

    it("handles various volume units", () => {
        const res = parseStrengthIntoRatio("100 mg / 1 dL");
        expect(res?.numerator?.value).toBe(100);
        expect(res?.denominator?.unit).toBe("dL");
        expect(res?.denominator?.value).toBe(1);
    });

    it("handles household units", () => {
        const res = parseStrengthIntoRatio("5 mg / tsp");
        expect(res?.numerator?.value).toBe(5);
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("tsp");
    });

    it("handles space between values and units", () => {
        const res = parseStrengthIntoRatio(" 500   mg ");
        expect(res?.numerator?.value).toBe(500);
    });

    it("returns null for invalid strings", () => {
        expect(parseStrengthIntoRatio("invalid")).toBeNull();
        expect(parseStrengthIntoRatio("")).toBeNull();
        expect(parseStrengthIntoRatio("+++")).toBeNull();
    });

    it("handles decimal values", () => {
        const res = parseStrengthIntoRatio("0.5 mg");
        expect(res?.numerator?.value).toBe(0.5);
    });

    it("handles very small concentrations", () => {
        const res = parseStrengthIntoRatio("1 mcg / mL");
        expect(res?.numerator?.value).toBe(1);
        expect(res?.denominator?.value).toBe(1);
    });

    it("handles leading/trailing whitespace in composite parts", () => {
        const res = parseStrengthIntoRatio(" 400 mg / 5 mL + 80 mg / 5 mL ");
        expect(res?.numerator?.value).toBe(96);
        expect(res?.denominator?.value).toBe(1);
    });

    it("handles mixed types (percentage + ratio) - theoretical", () => {
        const res = parseStrengthIntoRatio("2% + 5 mg/mL");
        expect(res?.numerator?.value).toBe(25);
        expect(res?.numerator?.unit).toBe("mg");
        expect(res?.denominator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("mL");
    });

    it("handles mg/dL specifically", () => {
        const res = parseStrengthIntoRatio("1 mg/dL");
        expect(res?.numerator?.value).toBe(1);
        expect(res?.denominator?.unit).toBe("dL");
        expect(res?.denominator?.value).toBe(1);
    });

    it("handles g/100g", () => {
        const res = parseStrengthIntoRatio("5 g / 100 g");
        expect(res?.numerator?.value).toBe(5);
        expect(res?.denominator?.value).toBe(100);
        expect(res?.denominator?.unit).toBe("g");
    });

    it("handles micrograms variants", () => {
        expect(parseStrengthIntoRatio("100 mcg")?.numerator?.unit).toBe("mcg");
        expect(parseStrengthIntoRatio("100 ug")?.numerator?.unit).toBe("ug");
        expect(parseStrengthIntoRatio("100 microg")?.numerator?.unit).toBe("microg");
    });

    it("handles cm3 as mL", () => {
        const res = parseStrengthIntoRatio("10 mg / cm3");
        expect(res?.numerator?.value).toBe(10);
        expect(res?.denominator?.unit).toBe("cm3");
        expect(res?.denominator?.value).toBe(1);
    });
});
