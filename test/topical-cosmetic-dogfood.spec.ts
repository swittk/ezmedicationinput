import { describe, expect, it } from "vitest";
import { formatSig, parseInstructionActions, parseSig } from "../src/index";
import { resolveBodySitePhrase } from "../src/body-site-grammar";

function clause(input: string) {
  return parseSig(input).meta.canonical.clauses[0];
}

describe("topical and cosmetic clinician dogfood", () => {
  it("treats linear semisolid amounts as product lengths, not meal timing", () => {
    for (const [input, unit] of [
      ["apply 1 cm of ointment to lesion", "cm line"],
      ["apply 1 cm strip to lesion", "cm strip"],
      ["apply 1 cm ribbon to lesion", "cm ribbon"]
    ] as const) {
      const parsed = parseSig(input);
      expect(parsed.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 1, unit });
      expect(parsed.meta.canonical.clauses[0]?.schedule?.when).toBeUndefined();
      expect(parsed.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    }
  });

  it("requires site context for contextual semisolid extrusion lengths", () => {
    const withoutSite = parseInstructionActions("squeeze 1 cm of cream");
    const unanchoredAmount = withoutSite
      .find((action) => action.predicate.lemma === "squeeze")
      ?.args.find((arg) => arg.role === "amount");
    expect(unanchoredAmount?.quantity?.unit).not.toBe("cm line");

    const withResolvedSite = parseInstructionActions("squeeze 1 cm of cream onto fingertip");
    const anchoredAmount = withResolvedSite
      .find((action) => action.predicate.lemma === "squeeze")
      ?.args.find((arg) => arg.role === "amount");
    expect(anchoredAmount).toMatchObject({
      text: "1 cm",
      quantity: { value: 1, unit: "cm line" }
    });

    const withBodySiteContext = parseInstructionActions("squeeze 1 cm of cream", 0, {
      context: { bodySiteContext: "fingertip" }
    });
    const contextualAmount = withBodySiteContext
      .find((action) => action.predicate.lemma === "squeeze")
      ?.args.find((arg) => arg.role === "amount");
    expect(contextualAmount).toMatchObject({
      text: "1 cm",
      quantity: { value: 1, unit: "cm line" }
    });
  });

  it("composes squeeze amount, material, destination, then application", () => {
    const parsed = parseSig("squeeze 1 cm of cream onto fingertip, then apply to affected area");
    const current = parsed.meta.canonical.clauses[0];
    expect(current?.dose).toMatchObject({ value: 1, unit: "cm line" });
    expect(current?.leftovers).toEqual([]);
    expect(current?.schedule?.when).toBeUndefined();
    const squeeze = current?.instructionGraph?.actions.find((action) => action.predicate.lemma === "squeeze");
    expect(squeeze?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "amount", quantity: { value: 1, unit: "cm line" } }),
      expect.objectContaining({ role: "material", conceptId: "cream" }),
      expect.objectContaining({ role: "destination" })
    ]));
    const thai = formatSig(parsed.fhir, "long", { locale: "th" });
    expect(thai).toContain("ครีม");
    expect(thai).not.toMatch(/breakfast|cream|fingertip/i);
  });

  it("keeps standardized and qualitative topical amounts structured", () => {
    const ftu = parseSig("apply 1 fingertip unit to right forearm once daily");
    expect(ftu.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 1, unit: "FTU" });
    expect(ftu.meta.canonical.clauses[0]?.leftovers).toEqual([]);

    const pea = parseSig("apply a pea-sized amount to whole face at bedtime");
    expect(pea.meta.canonical.clauses[0]?.dose).toMatchObject({ value: 1, unit: "pea-sized amount" });
    expect(pea.meta.canonical.clauses[0]?.leftovers).toEqual([]);

    const small = parseSig("apply a small amount to each acne lesion twice daily");
    expect(small.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(small.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.frames?.[0]?.args?.[0]).toMatchObject({
      role: "amount", conceptId: "small_amount"
    });
    expect(formatSig(small.fhir, "long", { locale: "th" })).toContain("เล็กน้อย");
  });

  it("treats warts as localized topical targets without false anatomical coding", () => {
    const english = parseSig("apply to wart once daily");
    expect(english.meta.canonical.clauses[0]?.site).toMatchObject({
      text: "wart",
      i18n: { th: "หูด" },
      source: "text"
    });
    expect(english.fhir.site?.text).toBe("wart");
    expect(english.fhir.site?.coding).toBeUndefined();
    expect(formatSig(english.fhir, "long", { locale: "th" })).toBe("ทาบริเวณหูด วันละครั้ง.");

    const thai = parseSig("ทาหูดวันละครั้ง", { locale: "th" });
    expect(thai.meta.canonical.clauses[0]?.site?.text).toBe("wart");
    expect(thai.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(thai.longText).toBe("ทาบริเวณหูด วันละครั้ง.");
  });

  it("distinguishes site-state modifiers from imperative clean/dry actions", () => {
    const resolved = resolveBodySitePhrase("clean dry skin", undefined, { allowTerminalModifierInheritance: true });
    expect(resolved?.coding?.code).toBe("181469002");

    const topical = parseSig("apply to clean dry skin");
    expect(topical.meta.canonical.clauses[0]?.site?.text).toBe("clean dry skin");
    expect(topical.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(topical.meta.canonical.clauses[0]?.instructionGraph?.actions ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ predicate: expect.objectContaining({ lemma: "clean" }) })])
    );
    const thai = formatSig(topical.fhir, "long", { locale: "th" });
    expect(thai).toContain("สะอาด");
    expect(thai).toContain("แห้ง");

    const imperative = clause("clean affected area and dry thoroughly; apply thin layer twice daily");
    expect(imperative?.instructionGraph?.actions.map((action) => action.predicate.lemma)).toEqual(
      expect.arrayContaining(["clean", "dry"])
    );
  });

  it("represents manner plus absorption result compositionally", () => {
    const parsed = parseSig("massage gently until absorbed");
    expect(parsed.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "manner", conceptId: "gently" }),
      expect.objectContaining({ role: "result", conceptId: "absorbed" })
    ]));
    expect(parsed.longText).toBe("Massage gently until absorbed.");
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toBe("นวดเบาๆจนกว่าซึมหมด.");
  });

  it("models sunscreen pre-exposure timing and reapplication triggers", () => {
    const sunscreen = parseSig("apply sunscreen generously 15 minutes before going outdoors");
    expect(sunscreen.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]).toMatchObject({
      relation: "before",
      offset: 15,
      activity: { text: "going outdoors" }
    });
    expect(sunscreen.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(formatSig(sunscreen.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);

    for (const input of ["reapply after swimming", "reapply after sweating"]) {
      const parsed = parseSig(input);
      expect(parsed.meta.canonical.clauses[0]?.leftovers).toEqual([]);
      expect(formatSig(parsed.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);
    }
  });
  it("composes topical application actions, locative sites, and manners", () => {
    const rub = parseSig("apply a thin layer to affected areas and rub in gently");
    expect(rub.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(rub.meta.canonical.clauses[0]?.instructionGraph?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: expect.objectContaining({ lemma: "rub" }),
          args: expect.arrayContaining([expect.objectContaining({ role: "manner", conceptId: "gently" })])
        })
      ])
    );
    expect(formatSig(rub.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);

    const dab = parseSig("dab a small amount onto each spot");
    expect(dab.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(dab.meta.canonical.clauses[0]?.instructionGraph?.actions[0]).toMatchObject({
      predicate: { lemma: "dab" },
      relation: "on",
      args: expect.arrayContaining([
        expect.objectContaining({ role: "amount", conceptId: "small_amount" }),
        expect.objectContaining({ role: "site" })
      ])
    });
    expect(formatSig(dab.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);
  });

  it("keeps common topical safety sites structured across FHIR realization", () => {
    const avoid = parseSig("apply a pea-sized amount to face nightly, avoid eyes and lips");
    expect(avoid.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(formatSig(avoid.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);

    const excluded = parseSig("apply thin film around wound, not into wound, once daily");
    expect(excluded.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(excluded.meta.canonical.clauses[0]?.additionalInstructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          frames: expect.arrayContaining([
            expect.objectContaining({
              polarity: "negate",
              predicate: expect.objectContaining({ lemma: "apply" }),
              relation: "into"
            })
          ])
        })
      ])
    );
    expect(formatSig(excluded.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);
  });

  it("preserves topical site state and multiplicity through coding and localization", () => {
    for (const [input, site, thaiPart] of [
      ["apply to wet hair", "wet hair", "เปียก"],
      ["apply to dry scalp", "dry scalp", "แห้ง"],
      ["apply a small amount to each acne lesion twice daily", "each acne lesion", "แต่ละรอยโรคสิว"]
    ] as const) {
      const parsed = parseSig(input);
      expect(parsed.meta.canonical.clauses[0]?.site?.text).toBe(site);
      expect(parsed.meta.canonical.clauses[0]?.leftovers).toEqual([]);
      const thai = formatSig(parsed.fhir, "long", { locale: "th" });
      expect(thai).toContain(thaiPart);
      expect(thai).not.toMatch(/[A-Za-z]/);
    }
  });

  it("combines periodic reapplication with activity triggers and post-wash offsets", () => {
    const reapply = parseSig("reapply every 2 hours and after swimming or sweating");
    expect(reapply.meta.canonical.clauses[0]?.schedule).toMatchObject({ period: 2, periodUnit: "h" });
    expect(reapply.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(reapply.meta.canonical.clauses[0]?.additionalInstructions?.[0]?.i18n?.th).toBe(
      "หลังว่ายน้ำหรือเหงื่อออก"
    );
    expect(formatSig(reapply.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);

    const afterWash = parseSig("apply moisturizer 20 minutes after washing");
    expect(afterWash.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]).toMatchObject({
      relation: "after",
      offset: 20,
      activity: { text: "washing" }
    });
    expect(afterWash.meta.canonical.clauses[0]?.schedule?.duration).toBeUndefined();
    expect(afterWash.meta.canonical.clauses[0]?.leftovers).toEqual([]);
    expect(formatSig(afterWash.fhir, "long", { locale: "th" })).not.toMatch(/[A-Za-z]/);
  });

});
