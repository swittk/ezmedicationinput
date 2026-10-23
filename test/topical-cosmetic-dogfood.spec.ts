import { describe, expect, it } from "vitest";
import {
  formatSig, fromFhir, fromFhirDosage, parseInstructionActions,
  toDosageDetails, toFhirR5Dosages
} from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { resolveBodySitePhrase } from "../src/body-site-grammar";
import type { BodySiteRestriction } from "../src/types";
import { BODY_SITE_RESTRICTION_EXTENSION_URL } from "../src/fhir";

interface RelativeSiteCase {
  input: string;
  dose: 1 | 2;
  site: string;
  siteCode: string;
  restrictionSource: string;
  predicate: string;
}

function siteRestrictions(site: unknown): BodySiteRestriction[] | undefined {
  return (site as { restrictions?: BodySiteRestriction[] } | undefined)?.restrictions;
}

function expectTypedSiteRestriction(
  site: unknown,
  input: string,
  restrictionSource: string,
  predicateText: string
): void {
  const restrictions = siteRestrictions(site);
  expect(restrictions, `${input}: missing typed site-local restrictions`).toHaveLength(1);
  const restriction = restrictions?.[0];
  expect(restriction?.relation, `${input}: restriction relation`).toBe("where");
  expect(restriction?.sourceText, `${input}: restriction source`).toBe(restrictionSource);
  expect(restriction?.predicate.text.toLowerCase(), `${input}: predicate meaning`)
    .toContain(predicateText.toLowerCase());
  const start = input.indexOf(restrictionSource);
  expect(restriction?.range, `${input}: restriction source range`).toEqual({
    start,
    end: start + restrictionSource.length
  });
  expect(restriction?.markerRange, `${input}: relative marker range`).toEqual({
    start,
    end: start + "where".length
  });
  const predicateStart = start + "where ".length;
  expect(restriction?.predicate.range, `${input}: predicate range`).toEqual({
    start: predicateStart,
    end: start + restrictionSource.length
  });
  const expectedForm = restrictionSource.startsWith("where there ") ? "existential" :
    ["affected", "irritated"].includes(restriction?.predicate.text.toLowerCase() ?? "")
      ? "state"
      : "raw";
  expect(restriction?.predicate.form).toBe(expectedForm);
  if (restriction.predicate.form === "existential") {
    expect(restriction.predicate.focusText?.toLowerCase()).toContain(predicateText.toLowerCase());
  }
}

const RELATIVE_SITE_CASES: readonly RelativeSiteCase[] = [
  {
    input: "apply 1 mL to scalp where there is hair loss", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where there is hair loss", predicate: "hair loss"
  },
  {
    input: "apply 1 mL to scalp where affected", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 2 mL to scalp where there is hair loss", dose: 2,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where there is hair loss", predicate: "hair loss"
  },
  {
    input: "apply 2 mL to scalp where affected", dose: 2,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 1 mL to scalp where irritated", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where irritated", predicate: "irritat"
  },
  {
    input: "apply 1 mL to scalp where there is irritation", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where there is irritation", predicate: "irritation"
  },
  {
    input: "apply 1 mL to skin where affected", dose: 1,
    site: "skin", siteCode: "181469002",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 1 mL to skin where there is rash", dose: 1,
    site: "skin", siteCode: "181469002",
    restrictionSource: "where there is rash", predicate: "rash"
  },
  {
    input: "apply 1 mL to face where affected", dose: 1,
    site: "face", siteCode: "89545001",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 1 mL to face where there is acne", dose: 1,
    site: "face", siteCode: "89545001",
    restrictionSource: "where there is acne", predicate: "acne"
  },
  {
    input: "apply 1 mL to left arm where affected", dose: 1,
    site: "left arm", siteCode: "368208006",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 1 mL to right arm where irritated", dose: 1,
    site: "right arm", siteCode: "368209003",
    restrictionSource: "where irritated", predicate: "irritat"
  },
  {
    input: "apply 1 mL to left forearm where itchy", dose: 1,
    site: "left forearm", siteCode: "66480008",
    restrictionSource: "where itchy", predicate: "itch"
  },
  {
    input: "apply 1 mL to right forearm where there is irritation", dose: 1,
    site: "right forearm", siteCode: "64262003",
    restrictionSource: "where there is irritation", predicate: "irritation"
  },
  {
    input: "apply 1 mL to left elbow where painful", dose: 1,
    site: "left elbow", siteCode: "368148009",
    restrictionSource: "where painful", predicate: "pain"
  },
  {
    input: "apply 1 mL to right elbow where there is rash", dose: 1,
    site: "right elbow", siteCode: "368149001",
    restrictionSource: "where there is rash", predicate: "rash"
  },
  {
    input: "apply 1 mL to left knee where affected", dose: 1,
    site: "left knee", siteCode: "82169009",
    restrictionSource: "where affected", predicate: "affected"
  },
  {
    input: "apply 1 mL to right knee where inflamed", dose: 1,
    site: "right knee", siteCode: "6757004",
    restrictionSource: "where inflamed", predicate: "inflam"
  },
  {
    input: "apply 1 mL to neck where dry", dose: 1,
    site: "neck", siteCode: "45048000",
    restrictionSource: "where dry", predicate: "dry"
  },
  {
    input: "apply 1 mL to back where there is psoriasis", dose: 1,
    site: "back", siteCode: "77568009",
    restrictionSource: "where there is psoriasis", predicate: "psoriasis"
  },
  {
    input: "apply 1 mL to chest where there is eczema", dose: 1,
    site: "chest", siteCode: "51185008",
    restrictionSource: "where there is eczema", predicate: "eczema"
  },
  {
    input: "apply 1 mL to scalp where red", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where red", predicate: "red"
  },
  {
    input: "apply 1 mL to skin where there is burning", dose: 1,
    site: "skin", siteCode: "181469002",
    restrictionSource: "where there is burning", predicate: "burning"
  },
  {
    input: "apply 2 mL to face where dry", dose: 2,
    site: "face", siteCode: "89545001",
    restrictionSource: "where dry", predicate: "dry"
  },
  {
    input: "apply 1 mL to scalp where dry and itchy", dose: 1,
    site: "scalp", siteCode: "41695006",
    restrictionSource: "where dry and itchy", predicate: "dry and itchy"
  }
];

const TIMED_RELATIVE_SITE_CASES = [
  {
    input: "apply 1 mL to scalp where affected BID",
    restrictionSource: "where affected", predicate: "affected",
    schedule: { timingCode: "BID", frequency: 2, period: 1, periodUnit: "d" },
    longText: "Apply 1 mL twice daily to the scalp where affected."
  },
  {
    input: "apply 2 mL to scalp where there is hair loss twice daily",
    restrictionSource: "where there is hair loss", predicate: "hair loss",
    schedule: { timingCode: "BID", frequency: 2, period: 1, periodUnit: "d" },
    longText: "Apply 2 mL twice daily to the scalp where there is hair loss."
  },
  {
    input: "apply 1 mL to skin where there is rash once daily",
    restrictionSource: "where there is rash", predicate: "rash",
    schedule: { timingCode: "QD", frequency: 1, period: 1, periodUnit: "d" },
    longText: "Apply 1 mL once daily to the skin where there is rash."
  },
  {
    input: "apply 1 mL to face where affected in the morning",
    restrictionSource: "where affected", predicate: "affected",
    schedule: { when: ["MORN"] },
    longText: "Apply 1 mL in the morning to the face where affected."
  },
  {
    input: "apply 1 mL to left forearm where irritated at bedtime",
    restrictionSource: "where irritated", predicate: "irritat",
    schedule: { when: ["HS"] },
    longText: "Apply 1 mL at bedtime to the left forearm where irritated."
  },
  {
    input: "apply 2 mL to right arm where affected morning and evening",
    restrictionSource: "where affected", predicate: "affected",
    schedule: { when: ["MORN", "EVE"] },
    longText: "Apply 2 mL in the morning and in the evening to the right arm where affected."
  },
  {
    input: "apply 1 mL to neck where there is eczema nightly",
    restrictionSource: "where there is eczema", predicate: "eczema",
    schedule: { when: ["NIGHT"] },
    longText: "Apply 1 mL at night to the neck where there is eczema."
  },
  {
    input: "apply 1 mL to scalp where affected twice daily for 7 days",
    restrictionSource: "where affected", predicate: "affected",
    schedule: {
      timingCode: "BID", frequency: 2, period: 1, periodUnit: "d",
      duration: 7, durationUnit: "d"
    },
    longText: "Apply 1 mL twice daily for 7 days to the scalp where affected."
  }
] as const;

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

  it("parses dab application sites and morning schedules without intranasal ambiguity", () => {
    const wart = parseSig("dab on wart in the morning");
    expect(wart.meta.canonical.clauses[0]).toMatchObject({
      method: { text: "Dab" },
      route: { text: "topical" },
      site: { text: "wart" },
      schedule: { when: ["MORN"] },
      leftovers: []
    });
    expect(wart.longText).toBe("Dab the medication in the morning on the wart.");
    expect(formatSig(wart.fhir, "long")).toBe("Dab the medication in the morning on the wart.");

    const finger = parseSig("dab on finger once daily in the morning");
    expect(finger.meta.canonical.clauses[0]).toMatchObject({
      method: { text: "Dab" },
      route: { text: "topical" },
      site: { text: "finger" },
      schedule: {
        timingCode: "QD",
        frequency: 1,
        period: 1,
        periodUnit: "d",
        when: ["MORN"]
      },
      leftovers: []
    });
    expect(finger.longText).toBe("Dab the medication once daily in the morning on the finger.");
    expect(formatSig(finger.fhir, "long")).toBe(
      "Dab the medication once daily in the morning on the finger."
    );
    expect(formatSig(finger.fhir, "long", { locale: "th" })).toContain("นิ้วมือ");

    const intranasal = parseSig("1 spray IN bid");
    expect(intranasal.meta.canonical.clauses[0]?.route?.text).toBe("intranasal");
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

  it.each(RELATIVE_SITE_CASES)(
    "keeps $site coding and a site-local predicate for: $input",
    ({ input, dose, site, siteCode, restrictionSource, predicate }) => {
      const parsed = parseSig(input);
      const clause = parsed.meta.canonical.clauses[0];

      expect(parsed.items).toHaveLength(1);
      expect(clause?.rawText).toBe(input);
      expect(clause?.dose).toEqual({ value: dose, unit: "mL" });
      expect(clause?.method?.coding?.code).toBe("738991002");
      expect(clause?.route).toMatchObject({ code: "6064005", text: "topical" });
      expect(clause?.site).toMatchObject({
        coding: { system: "http://snomed.info/sct", code: siteCode },
        range: expect.any(Object)
      });
      expect(clause?.site?.text?.toLowerCase()).toContain(site);
      expectTypedSiteRestriction(clause?.site, input, restrictionSource, predicate);
      expect(clause?.schedule, `${input}: no cadence was prescribed`).toBeUndefined();
      expect(clause?.prn, `${input}: site predicate is not PRN`).toBeUndefined();
      expect(clause?.clinicalAdjuncts?.condition,
        `${input}: site predicate is not a global medication condition`).toBeUndefined();
      expect(clause?.leftovers).toEqual([]);

      expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: dose, unit: "mL" });
      expect(parsed.fhir.site?.coding?.[0]).toMatchObject({
        system: "http://snomed.info/sct", code: siteCode
      });
      expect(parsed.fhir.asNeeded, `${input}: FHIR must not invent PRN`).not.toBe(true);
      expect(parsed.fhir.asNeededFor, `${input}: predicate is not a medication indication`)
        .toBeUndefined();
      expect(parsed.fhir.timing, `${input}: FHIR must not invent timing`).toBeUndefined();
      const r6Component = parsed.dosageDetails.step[0]?.component[0];
      expect(r6Component?.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: dose, unit: "mL" });
      expect(r6Component?.asNeeded, `${input}: R6 must not invent PRN`).not.toBe(true);
      expect(r6Component?.condition, `${input}: restriction is not a global condition`)
        .toBeUndefined();
      expect(r6Component?.timing, `${input}: R6 must not invent timing`).toBeUndefined();
    }
  );

  it.each(TIMED_RELATIVE_SITE_CASES)(
    "keeps an explicit cadence/daypart independent from the site restriction: $input",
    ({ input, restrictionSource, predicate, schedule, longText }) => {
      const parsed = parseSig(input);
      const clause = parsed.meta.canonical.clauses[0];

      expect(clause?.dose).toEqual({
        value: input.includes("apply 2 mL") ? 2 : 1,
        unit: "mL"
      });
      expect(clause?.site?.coding?.code).toBe(
        input.includes("skin") ? "181469002" :
          input.includes("face") ? "89545001" :
            input.includes("left forearm") ? "66480008" :
              input.includes("right arm") ? "368209003" :
                input.includes("neck") ? "45048000" : "41695006"
      );
      expectTypedSiteRestriction(clause?.site, input, restrictionSource, predicate);
      expect(clause?.schedule).toMatchObject(schedule);
      expect(clause?.prn).toBeUndefined();
      expect(clause?.clinicalAdjuncts?.condition).toBeUndefined();
      expect(clause?.leftovers).toEqual([]);
      expect(parsed.longText).toBe(longText);
      expect(formatSig(parsed.fhir, "long")).toBe(longText);
    }
  );

  it.each([
    [
      "apply 1 mL to scalp where there is hair loss",
      "where there is hair loss",
      "hair loss",
      "Apply 1 mL to the scalp where there is hair loss."
    ],
    [
      "apply 1 mL to scalp where affected",
      "where affected",
      "affected",
      "Apply 1 mL to the scalp where affected."
    ]
  ] as const)("preserves source and normal realization through R5/R6 for: %s", (
    input, restrictionSource, predicate, normal
  ) => {
    const parsed = parseSig(input);
    const r5 = JSON.parse(JSON.stringify(parsed.fhir)) as typeof parsed.fhir;
    const r6 = JSON.parse(JSON.stringify(parsed.dosageDetails)) as typeof parsed.dosageDetails;

    expect(parsed.longText).toBe(normal);
    expect(formatSig(r5, "long")).toBe(normal);
    expect(r6.renderedInstruction).toBe(input);
    expect(formatSig(r6, "long")).toBe(input);
    expect(r5.site?.coding?.[0]?.code).toBe("41695006");
    const predicateStart = input.indexOf(restrictionSource) + "where ".length;
    const restrictionExtension = {
      url: BODY_SITE_RESTRICTION_EXTENSION_URL,
      extension: [
        { url: "relation", valueCode: "where" },
        { url: "sourceText", valueString: restrictionSource },
        {
          url: "predicateText",
          valueString: restrictionSource.slice("where ".length)
        },
        {
          url: "predicateForm",
          valueCode: restrictionSource.startsWith("where there ") ? "existential" : "state"
        },
        ...(restrictionSource.startsWith("where there ")
          ? [{ url: "predicateFocusText", valueString: predicate }]
          : [{ url: "predicateLemma", valueString: predicate }]),
        { url: "sourceStart", valueInteger: input.indexOf(restrictionSource) },
        {
          url: "sourceEnd",
          valueInteger: input.indexOf(restrictionSource) + restrictionSource.length
        },
        { url: "markerStart", valueInteger: input.indexOf(restrictionSource) },
        { url: "markerEnd", valueInteger: input.indexOf(restrictionSource) + "where".length },
        { url: "predicateStart", valueInteger: predicateStart },
        {
          url: "predicateEnd",
          valueInteger: input.indexOf(restrictionSource) + restrictionSource.length
        }
      ]
    };
    expect(r5.site?.extension?.find(extension =>
      extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL
    )).toEqual(restrictionExtension);
    expect(r6.step[0]?.component[0]?.site?.concept?.coding?.[0]?.code).toBe("41695006");
    expect(r6.step[0]?.component[0]?.site?.concept?.extension?.find(extension =>
      extension.url === BODY_SITE_RESTRICTION_EXTENSION_URL
    )).toEqual(restrictionExtension);

    const importedR5 = fromFhirDosage(r5);
    expectTypedSiteRestriction(
      importedR5.meta.canonical.clauses[0]?.site,
      input,
      restrictionSource,
      predicate
    );
    const importedR6 = fromFhir(r6);
    expectTypedSiteRestriction(
      importedR6.meta.canonical.clauses[0]?.site,
      input,
      restrictionSource,
      predicate
    );

    const strictR5 = toFhirR5Dosages(r6);
    expect(strictR5).toHaveLength(1);
    expect(strictR5[0]?.site?.coding?.[0]?.code).toBe("41695006");
    expect(toDosageDetails(strictR5).step[0]?.component[0]?.site?.concept?.coding?.[0]?.code)
      .toBe("41695006");

    const generatedR6 = JSON.parse(JSON.stringify(r6)) as typeof r6;
    delete generatedR6.renderedInstruction;
    expect(formatSig(generatedR6, "long")).toBe(normal);
  });

});
