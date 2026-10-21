import { describe, expect, it } from "vitest";
import { nextDueDoses, parseSig } from "../src";

const options = {
  from: "2026-10-21T00:00:00+07:00",
  orderedAt: "2026-10-21T00:00:00+07:00",
  timeZone: "Asia/Bangkok",
  limit: 8
};

describe("FHIR R5 Timing invariant and clinical scheduling safety", () => {
  it("never emits both when and timeOfDay in a single executable dosage", () => {
    const text = "1 tab po before breakfast and at 08:00";
    const parsed = parseSig(text);
    for (const dosage of parsed.fhir) {
      const repeat = dosage.timing?.repeat;
      expect(!(repeat?.when?.length && repeat.timeOfDay?.length)).toBe(true);
    }
    expect(parsed.warnings).toContainEqual(
      expect.stringContaining("incompatible-event-and-clock")
    );
    expect(parsed.fhir[0].text).toBe(text);
    expect(() => nextDueDoses(parsed.fhir, options)).toThrow(/unresolved/i);
  });

  it("rejects a frequency/clock contradiction instead of scheduling two 'daily' doses", () => {
    const text = "1 tab po daily at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.warnings).toContainEqual(
      expect.stringContaining("frequency-clock-count-conflict")
    );
    expect(parsed.fhir[0].timing).toBeUndefined();
    expect(parsed.fhir[0].text).toBe(text);
  });

  it("permits two explicit BID clocks without inventing an extra dose", () => {
    const text = "1 tab po BID at 08:00 and 20:00";
    const parsed = parseSig(text);
    expect(parsed.warnings.some(w => w.includes("frequency-clock-count-conflict")))
      .toBe(false);
    if (parsed.fhir[0].timing?.repeat?.timeOfDay?.length === 2) {
      expect(parsed.fhir[0].timing?.repeat?.frequency).toBe(2);
    }
  });

  it("identifies standard HL7 timing abbreviations with the official coding system", () => {
    const parsed = parseSig("1 tab po BID");
    expect(parsed.fhir[0].timing?.code?.coding?.[0]).toMatchObject({
      system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
      code: "BID"
    });
  });

  it("does not misrepresent local Q12H as a standard GTS abbreviation", () => {
    const parsed = parseSig("1 tab po Q12H");
    const code = parsed.fhir[0].timing?.code;
    expect(code?.coding?.some(entry =>
      entry.system === "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation")).not.toBe(true);
    expect(code?.text).toBe("Q12H");
  });
});
