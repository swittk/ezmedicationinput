import { BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL } from "../src/body-site-target";
import { deserializeCanonicalContext, TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, TIMING_EVENT_WINDOW_EXTENSION_URL } from "../src/fhir";
import { courseFromR6 } from "../src/adapters/canonical-course";
import { AdviceArgumentRole, AdviceForce, AdvicePolarity, AdviceRelation, EventTiming, type AdviceFrame, type FhirExtension, type MedicationCondition, type FhirDosage, type FhirR6DosageInstruction, type ParseOptions } from "../src/types";
import { describe, expect, it } from "vitest";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import adviceRulesSource from "../src/advice-rules.json";
import { setDosageCondition, withDosageEditProvenance, getDosageSourceOwnership, DOSAGE_RENDERED_INSTRUCTION_R5_URL } from "../src/dosage-course";
import { realizeInstructionAction, instructionGraphRichPrimaryAction,
  instructionGraphRoundTripPrimaryAction, instructionGraphSourceConflictsWithDose, realizeRichPrimaryWithCanonicalDose
} from "../src/instruction-graph";
import { formatCanonicalClause } from "../src/format";
import { formatCanonicalCourse } from "../src/canonical/format-course";
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { resolveSigLocalization } from "../src/i18n";
import { buildMedicationInstructionActionCodeSystem, buildMedicationInstructionConceptCodeSystem, formatSig, fromFhirDosage, getMedicationInstructionAction, getMedicationInstructionConcept, listMedicationInstructionActions, listMedicationInstructionConcepts, resolveMedicationInstructionAction as resolvePublicAction, resolveMedicationInstructionSequenceAction, resolveMedicationInstructionConcept as resolvePublicConcept, parseInstructionActions, realizeInstructionGraph, getDosageCondition, toDosageDetails, toFhirR5Dosages } from "../src/index";
import { medicationInstructionActionCodings, resolveMedicationInstructionAction, resolveMedicationInstructionActionForMethod, resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import { medicationInstructionConceptCodings, getMedicationInstructionConcept as getInternalInstructionConcept } from "../src/instruction-concept-terminology";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseSig as parsePublicSig, nextDueDoses, calculateTotalUnits, importCanonicalCourse, projectCanonicalCourse, TIMING_OFFSET_MIN_EXTENSION_URL, TIMING_OFFSET_MAX_EXTENSION_URL } from "../src/index";

describe("procedural instruction graph", () => {
  it.each([
    ["If you experience blurred or double vision, stop use and consult a doctor", ["stop", "consult"]],
    ["If you experience double vision, stop using the medicine and consult a doctor", ["stop", "consult"]],
    ["Double vision", []]
  ])("never interprets a recognized diplopia noun phrase as a doubled-dose action: %s", (source, expected) => {
    const actions = parseInstructionActions(source);
    expect(actions.map(action => action.predicate.lemma)).toEqual(expected);
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses.flatMap(clause =>
      clause.instructionGraph?.actions.map(action => action.predicate.lemma) ?? []
    )).not.toContain("double");
    if (expected.length) {
      expect(parsed.longText.toLowerCase()).toContain("double vision");
      expect(parsed.longText.toLowerCase()).toContain("stop");
      expect(parsed.longText.toLowerCase()).toContain("consult");
    }
  });

  it.each([
    ["Double the dose", "affirm"],
    ["Double the number of drops", "affirm"],
    ["Do not double the dose", "negate"],
    ["Do not double your next dose", "negate"]
  ])("keeps deliberate positive and negative dose-doubling directives: %s", (source, polarity) => {
    const actions = parseInstructionActions(source);
    expect(actions).toHaveLength(1);
    expect(actions[0].predicate.lemma).toBe("double");
    expect(actions[0].polarity ?? "affirm").toBe(polarity);
    expect(actions[0].sourceText).toMatch(/double/iu);
    const extension = buildInstructionGraphExtension({ sourceText: source, actions })!;
    expect(parseInstructionGraphExtension([extension])?.actions[0].predicate.lemma).toBe("double");
  });

  it("retains the typed amount in a negated administration instruction", () => {
    const source = "Do not chew 1 tablet";
    const action = parseInstructionActions(source)[0];
    expect(action.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" }
    }));
    expect(realizeInstructionAction(action, "en")).toBe("Do not chew 1 tablet");
    expect(realizeInstructionAction(action, "th")).toBe("ห้ามเคี้ยว 1 เม็ด");
    const input = "Swallow 1 tablet whole; do not chew 1 tablet";
    const parsed = parsePublicSig(input);
    expect(parsed.fhir).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate).toHaveLength(1);
    expect(parsed.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain("ห้ามเคี้ยว 1 เม็ด");
    expect(parsed.fhirNext.renderedInstruction).toBe(input);
  });

  it.each(["Chew gum", "Do not chew tablets"])("does not invent an amount for %s", source => {
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses.every(clause => clause.dose === undefined)).toBe(true);
    expect(parsed.fhir.every(row => !row.doseAndRate?.length)).toBe(true);
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each([
    ["Do not rub eyes", "Do not rub the eye"],
    ["Do not dab skin", "Do not dab the skin"],
    ["Do not massage scalp", "Do not massage the scalp"],
    ["Do not lather scalp", "Do not lather the scalp"],
    ["Do not apply skin", "Do not apply to the skin"],
    ["Do not reapply skin", "Do not reapply to the skin"]
  ])("realizes reconstructed site prohibitions with the verb's actual attachment: %s", (source, expected) => {
    const action = parseInstructionActions(source)[0]!;
    expect(action.polarity).toBe("negate");
    expect(action.relation).toBeUndefined();
    expect(action.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Site }));
    // Unlike graph realization with an unchanged English source, generating
    // one action from structured data calls the locale adapter directly.
    expect(realizeInstructionAction(action, "en")).toBe(expected);
    const extension = buildInstructionGraphExtension({ sourceText: source, actions: [action] })!;
    const recovered = parseInstructionGraphExtension([extension])!.actions[0];
    expect(realizeInstructionAction(recovered, "en")).toBe(expected);
  });

  it("preserves graph action order, relation indices, and coding translations through FHIR", () => {
    const parsed = parseSig("wash hands then wait 5 minutes");
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions).toHaveLength(2);
    expect(graph?.relations?.[0]).toMatchObject({ fromActionIndex: 0, toActionIndex: 1 });
    graph!.actions[0].sequenceIndex = 9;
    graph!.actions[1].sequenceIndex = 1;
    graph!.actions[0].args[0].coding = {
      system: "https://example.test/site",
      code: "hands",
      display: "Hands",
      i18n: { th: "มือ" }
    };

    const extension = buildInstructionGraphExtension(graph)!;
    const argumentCoding = extension.extension?.find(item => item.url === "action")
      ?.extension?.find(item => item.url === "argument")
      ?.extension?.find(item => item.url === "coding")?.valueCoding;
    expect(argumentCoding?.i18n).toBeUndefined();
    expect(argumentCoding?._display?.extension).toContainEqual(
      expect.objectContaining({
        url: "http://hl7.org/fhir/StructureDefinition/translation"
      })
    );
    expect(Object.entries(argumentCoding ?? {}).every(([, value]) => value !== undefined)).toBe(true);
    const restored = parseInstructionGraphExtension([extension])!;
    expect(restored.actions.map((action) => action.predicate.lemma)).toEqual(["wash", "wait"]);
    expect(restored.relations?.[0]).toMatchObject({ fromActionIndex: 0, toActionIndex: 1 });
    expect(restored.actions[0].args[0].coding?.i18n).toEqual({ th: "มือ" });
  });

  it.each([
    "Wait five minutes between eye drops",
    "Take 1 tab each evening; do not crush",
    "Gargle 10 mL for 30 seconds then spit twice daily"
  ])("emits nested FHIR-standard Coding with no undefined or inline i18n fields: %s", source => {
    const graph = parseSig(source).meta.canonical.clauses[0]?.instructionGraph;
    const extension = buildInstructionGraphExtension(graph);
    expect(extension).toBeDefined();
    let observedCodings = 0;
    const visit = (part: NonNullable<typeof extension>): void => {
      const coding = part.valueCoding;
      if (coding) {
        observedCodings += 1;
        expect(coding.i18n).toBeUndefined();
        expect(Object.values(coding).some(value => value === undefined)).toBe(false);
      }
      for (const child of part.extension ?? []) visit(child);
    };
    visit(extension!);
    expect(observedCodings).toBeGreaterThan(0);
  });

  it("rebases primary administration spans with the rest of a later batch segment", () => {
    const input = "1 tab po daily | wash hands before instill 1 drop od";
    const parsed = parseSig(input);
    const graph = parsed.items[1]?.meta.canonical.clauses[0]?.instructionGraph;
    const start = input.indexOf("instill");
    expect(graph?.primaryAdministrationSpan).toEqual({ start, end: start + "instill".length });
    expect(graph?.actions.every((action) => action.span.start >= parsed.meta.segments[1].range.start)).toBe(true);
  });

  it("retains administration duration when rich graph realization owns the English sentence", () => {
    const parsed = parseSig("squeeze 1 cm ribbon cream onto each spot");
    const dosage = {
      ...parsed.fhir,
      timing: {
        repeat: {
          duration: 30,
          durationUnit: "min" as const
        }
      }
    };
    expect(formatSig(dosage, "long", { locale: "en" })).toContain("over 30 minutes");
  });

  it("preserves opaque text next to understood actions through FHIR", () => {
    const parsed = parseSig("shake bottle before use and sing a song");
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;

    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["shake"]);
    expect(graph?.opaqueSpans?.map((span) => span.text)).toEqual(["sing a song"]);
    expect(realizeInstructionGraph(graph!, "en")).toBe("Shake bottle before use; sing a song");
    expect(parsed.longText).toContain("Shake bottle before use; sing a song.");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.opaqueSpans?.map((span) => span.text)).toEqual(["sing a song"]);
  });

  it.each([
    ["Take 1 tablet twice daily but skip morning dose on dialysis days.", "on dialysis days"],
    ["Take 1 tablet daily; hold dose on dialysis days.", "on dialysis days"],
    ["Take 1 tablet twice daily; skip the evening dose only on dialysis days.", "on dialysis days"],
    ["Use one drop twice daily; wipe excess with clean tissue after instillation.", "with clean tissue after instillation"]
  ])("keeps complete source-backed clinical qualifiers visible: %s", (source, advice) => {
    const parsed = parseSig(source);
    const rendered = parsed.longText.toLowerCase();
    expect(rendered).toContain(advice);
    expect(rendered).not.toContain("then but");
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    const restored = fromFhirDosage(parsed.fhir).meta.normalized;
    expect(restored.instructionGraph?.sourceText).toBe(source);
  });

  it.each([
    ["Take 1 tablet daily; hold dose if nausea develops.", "if nausea develops"],
    ["Use one drop in both eyes twice daily; do not touch dropper tip to eye.", "do not touch dropper tip to eye"]
  ])("keeps already-correct conditional or prohibition advice exactly once: %s", (source, advice) => {
    const rendered = parseSig(source).longText.toLowerCase();
    expect(rendered.split(advice)).toHaveLength(2);
  });

  it("does not turn negated dietary advice into a medication meal schedule", () => {
    const parsed = parseSig("Take 1 tablet daily. Do not skip meals during therapy.");
    const rendered = parsed.longText.toLowerCase();
    expect(parsed.fhir.timing?.repeat?.when ?? []).not.toContain("C");
    expect(rendered).toContain("do not skip meals");
    expect(rendered).toContain("during therapy");

    const explicitMeal = parseSig("Take 1 tablet daily with meals. Do not skip meals.");
    expect(explicitMeal.fhir.timing?.repeat?.when ?? []).toContain("C");
    expect(explicitMeal.longText.toLowerCase()).toContain("do not skip meals");
  });

  it("keeps a fasting-day hold qualifier attached to the hold instruction", () => {
    const parsed = parseSig("Take 1 tablet daily, but hold on fasting days.");
    const rendered = parsed.longText.toLowerCase();
    expect(rendered).toContain("hold on fasting days");
    expect(rendered.match(/hold on fasting days/gu) ?? []).toHaveLength(1);
    expect(rendered).not.toContain("then days");
    expect(rendered).not.toMatch(/hold on fasting[.;]/u);
    const hold = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions
      .find((action) => action.predicate.lemma === "hold");
    expect(hold?.sourceText).toBe("hold on fasting days");
    expect(hold?.args).toContainEqual(expect.objectContaining({
      role: "time",
      text: "fasting days"
    }));
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans ?? [])
      .not.toContainEqual(expect.objectContaining({ text: "days" }));
    expect(parsed.fhir.timing?.repeat).toMatchObject({
      frequency: 1,
      period: 1,
      periodUnit: "d"
    });
    expect(fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph?.sourceText)
      .toBe(parsed.input);

    const independentException = parseSig("Take 1 tablet twice daily, except on dialysis days.");
    expect(independentException.longText.toLowerCase()).toContain("except on dialysis days");
  });

  it.each([
    "Take 1 tablet twice daily but skip morning dose on dialysis days.",
    "Take 1 tablet daily, but hold on fasting days."
  ])("keeps adversative withholding distinct from a temporal sequence: %s", (source) => {
    const parsed = parseSig(source);
    const rendered = parsed.longText.toLowerCase();
    expect(rendered).toMatch(/\bbut\b.*(?:skip|hold|withhold).*on (?:dialysis|fasting) days/u);
    expect(rendered).not.toMatch(/\bthen\b.*(?:skip|hold|withhold).*on (?:dialysis|fasting) days/u);
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.opaqueSpans)
      .toContainEqual(expect.objectContaining({ text: "but" }));
    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.opaqueSpans).toContainEqual(expect.objectContaining({ text: "but" }));
    expect(realizeInstructionGraph(restored!, "en", { position: "post" })?.toLowerCase())
      .toMatch(/^but (?:skip|hold|withhold).*on (?:dialysis|fasting) days$/u);
  });

  it("keeps Thai press and pump surfaces semantically distinct", () => {
    const press = parseSig("กด 10 วินาที", { locale: "th" });
    expect(press.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.predicate.lemma).toBe("press");

    const pump = parseSig("กดหัวปั๊ม 1 ครั้ง", { locale: "th" });
    expect(pump.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.predicate.lemma).toBe("pump");
    expect(pump.meta.canonical.clauses[0]?.instructionGraph?.coverage).toMatchObject({
      complete: true, opaqueCharacters: 0, ratio: 1
    });
  });

  it("advances argument parsing past complete multi-token quantity units", () => {
    const measured = parseInstructionActions("measure 1 cm ribbon cream")[0];
    expect(measured?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "amount",
        quantity: { value: 1, unit: "cm ribbon" }
      }),
      expect.objectContaining({ role: "material", conceptId: "cream", text: "cream" })
    ]));

    const mixed = parseInstructionActions("mix 1 fingertip unit ointment water")[0];
    expect(mixed?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "theme",
        conceptId: "ointment",
        quantity: { value: 1, unit: "FTU" }
      }),
      expect.objectContaining({ role: "substance", conceptId: "water" })
    ]));
  });

  it("models workflow duration and time arguments without contaminating medication timing", () => {
    const leave = parseSig("leave on for 10 minutes then rinse");
    const leaveGraph = leave.meta.canonical.clauses[0]?.instructionGraph;
    expect(leaveGraph?.actions.map((action) => action.predicate.lemma)).toEqual(["leave", "rinse"]);
    expect(leaveGraph?.actions[0]?.args[0]).toMatchObject({
      role: "duration",
      quantity: { value: 10, unit: "min" }
    });
    expect(realizeInstructionGraph(leaveGraph!, "en")).toBe("Leave on for 10 minutes; then rinse");

    const rinse = parseSig("rinse in the morning");
    const rinseAction = rinse.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(rinseAction).toMatchObject({
      predicate: { lemma: "rinse" },
      relation: "in"
    });
    expect(rinseAction?.args[0]).toMatchObject({ role: "time", normalized: "the morning" });
  });

  it.each([
    ["a minute", "for a minute", { start: 26, end: 38 }],
    ["one minute", "for one minute", { start: 26, end: 40 }],
    ["1 minute", "for 1 minute", { start: 26, end: 38 }]
  ] as const)("keeps wait-for %s as a one-minute procedural duration", (duration, sourceText, span) => {
    const source = `Take 1 tablet daily; wait for ${duration} before drinking`;
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    const graph = clause?.instructionGraph;
    const wait = graph?.actions.find((action) => action.predicate.lemma === "wait");
    const proceduralDuration = wait?.args.find((arg) => arg.role === "duration");

    expect(parsed.items).toHaveLength(1);
    expect(clause?.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause?.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause?.schedule?.duration).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(wait?.sourceText).toBe(`wait for ${duration} before drinking`);
    expect(proceduralDuration).toMatchObject({
      role: "duration",
      text: sourceText,
      quantity: { value: 1, unit: "min" },
      span
    });
    expect(wait?.args.some((arg) => arg.role === "amount")).toBe(false);
    expect(realizeInstructionGraph(graph!, "en")).toBe("Wait 1 minute before drinking");
    expect(parsed.longText).toContain("Wait 1 minute before drinking.");
    expect(parsed.longText).not.toContain("Wait for.");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized;
    const restoredWait = restored.instructionGraph?.actions.find(
      (action) => action.predicate.lemma === "wait"
    );
    expect(restored.schedule?.duration).toBeUndefined();
    expect(restoredWait?.args).toContainEqual(expect.objectContaining({
      role: "duration",
      quantity: { value: 1, unit: "min" },
      span
    }));
  });

  it("exposes the package-owned action CodeSystem vocabulary and exact external mappings", () => {
    const actions = listMedicationInstructionActions();
    expect(actions.length).toBeGreaterThan(10);
    expect(getMedicationInstructionAction("pour")).toMatchObject({
      code: "pour",
      semanticClass: "transfer",
      display: "Pour"
    });
    expect(getMedicationInstructionAction("pour")?.externalCodings).toContainEqual(
      expect.objectContaining({
        system: "https://en-word.net/", version: "2025", code: "oewn-02073479-v"
      })
    );
    expect(getMedicationInstructionAction("rinse")?.externalCodings).toContainEqual(
      expect.objectContaining({ system: "http://snomed.info/sct", code: "782155003" })
    );

    const codeSystem = buildMedicationInstructionActionCodeSystem();
    expect(codeSystem).toMatchObject({
      resourceType: "CodeSystem",
      status: "active",
      content: "complete"
    });
    expect(codeSystem.concept).toContainEqual(
      expect.objectContaining({ code: "pour", display: "Pour" })
    );
  });

  it("recognizes declarative multiword/default actions even when HPSG left them opaque", () => {
    const parsed = parseSig("wipe lesion then wait 5 minutes then rinse");
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual([
      "wipe",
      "wait",
      "rinse"
    ]);
    expect(graph?.actions[0]?.args[0]).toMatchObject({
      role: "site",
      coding: { system: "http://snomed.info/sct", code: "95324001" }
    });
    expect(graph?.actions[1]?.args[0]).toMatchObject({
      role: "duration",
      quantity: { value: 5, unit: "min" }
    });
    expect(graph?.opaqueSpans).toBeUndefined();
    expect(realizeInstructionGraph(graph!, "en")).toBe(
      "Wipe the lesion; then wait 5 minutes; then rinse"
    );
  });

  it("recognizes longer caller-configured action surfaces and aliases before generic verbs", () => {
    const options = {
      instructionActionMap: {
        "apply a thin layer of ointment": {
          code: "coat-thin",
          semanticClass: "procedure",
          display: "Apply thin coating",
          procedural: true,
          aliases: ["spread a thin layer of ointment"],
          localeAliases: { en: ["apply an even coating of ointment"] }
        }
      }
    };
    for (const phrase of [
      "apply a thin layer of ointment",
      "spread a thin layer of ointment",
      "apply an even coating of ointment"
    ]) {
      const frames = parseInstructionActions(phrase, 0, options);
      expect(frames[0]?.predicate.lemma).toBe("coat-thin");
      expect(frames[0]?.span).toMatchObject({ start: 0, end: phrase.length });
      const parsed = parseSig(phrase, options);
      expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0]?.predicate.lemma)
        .toBe("coat-thin");
      const wire = buildInstructionGraphExtension({
        sourceText: phrase, actions: frames
      })!;
      expect(parseInstructionGraphExtension([wire])?.actions[0]?.predicate.lemma)
        .toBe("coat-thin");
    }
    expect(parseInstructionActions("apply", 0, options)[0]?.predicate.lemma).toBe("apply");
  });

  it("supports caller-owned procedural actions and preserves their coding and labels through FHIR", () => {
    const options = {
      instructionActionMap: {
        zap: {
          code: "phototreat",
          semanticClass: "procedure",
          display: "Phototreat",
          i18n: { th: "ฉายแสง" },
          coding: {
            system: "http://example.org/action",
            code: "P1",
            display: "Phototreat"
          },
          procedural: true
        }
      }
    };
    const parsed = parseSig("zap lesion then rinse", options);
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual([
      "phototreat",
      "rinse"
    ]);
    expect(graph?.actions[0]?.predicate).toMatchObject({
      display: "Phototreat",
      i18n: { th: "ฉายแสง" }
    });
    expect(graph?.actions[0]?.predicate.codings).toEqual([
      expect.objectContaining({
        system: "http://example.org/action",
        code: "P1",
        display: "Phototreat"
      })
    ]);

    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.actions[0]?.predicate).toMatchObject({
      lemma: "phototreat",
      display: "Phototreat",
      i18n: { th: "ฉายแสง" },
      codings: [
        expect.objectContaining({
          system: "http://example.org/action",
          code: "P1"
        })
      ]
    });
    expect(realizeInstructionGraph(restored!, "en")).toContain("Phototreat the lesion");
    expect(realizeInstructionGraph(restored!, "th")).toContain("ฉายแสงรอยโรค");
  });

  it("uses longest action aliases from the declarative terminology", () => {
    const frames = parseInstructionActions("shake well bottle then rinse off with water");
    expect(frames.map((frame) => frame.predicate.lemma)).toEqual(["shake", "rinse"]);
    expect(frames[0]?.args[0]).toMatchObject({ role: "container", normalized: "bottle" });
  });

  it("parses colloquial Thai sequencing into coded actions without opaque glue", () => {
    const parsed = parseSig("เช็ดรอยโรคแล้วรอ 5 นาทีแล้วล้างด้วยน้ำ", { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual([
      "wipe",
      "wait",
      "rinse"
    ]);
    expect(graph?.opaqueSpans).toBeUndefined();
    expect(graph?.actions[0]?.args[0]).toMatchObject({
      role: "site",
      coding: { system: "http://snomed.info/sct", code: "95324001" }
    });
    expect(graph?.actions[1]?.args[0]).toMatchObject({
      role: "duration",
      quantity: { value: 5, unit: "min" }
    });
    expect(graph?.actions[2]?.args[0]).toMatchObject({
      role: "substance",
      coding: { system: "http://snomed.info/sct", code: "11713004" }
    });
    expect(graph?.actions[2]?.args[0]?.codings).toContainEqual(
      expect.objectContaining({
        system: "http://snomed.info/sct",
        code: "11713004"
      })
    );
    expect(realizeInstructionGraph(graph!, "th")).toBe(
      "เช็ดรอยโรค จากนั้นรอ 5 นาที จากนั้นล้างด้วยน้ำ"
    );
    expect(realizeInstructionGraph(graph!, "en")).toBe(
      "Wipe the lesion; then wait 5 minutes; then rinse with water"
    );
  });

  it("supports caller-owned argument concepts and preserves them through FHIR", () => {
    const parsed = parseSig("zap magicgel then rinse", {
      instructionActionMap: {
        zap: {
          code: "phototreat",
          semanticClass: "procedure",
          display: "Phototreat",
          i18n: { th: "ฉายแสง" },
          coding: { system: "http://example.org/action", code: "P1", display: "Phototreat" }
        }
      },
      instructionConceptMap: {
        magicgel: {
          code: "magic-gel",
          role: "substance",
          display: "magic gel",
          i18n: { th: "เจลวิเศษ" },
          coding: { system: "http://example.org/concept", code: "MG", display: "Magic gel" }
        }
      }
    });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions[0]?.args[0]).toMatchObject({
      role: "substance",
      conceptId: "magic-gel",
      coding: { system: "http://example.org/concept", code: "MG" },
      i18n: { en: "magic gel", th: "เจลวิเศษ" }
    });
    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.actions[0]?.args[0]).toMatchObject({
      conceptId: "magic-gel",
      coding: { system: "http://example.org/concept", code: "MG" },
      i18n: { en: "magic gel", th: "เจลวิเศษ" }
    });
    expect(realizeInstructionGraph(restored!, "en")).toContain("Phototreat magic gel");
    expect(realizeInstructionGraph(restored!, "th")).toContain("ฉายแสงเจลวิเศษ");
  });

  it("publishes the package-owned concept terminology as a FHIR CodeSystem", () => {
    expect(listMedicationInstructionConcepts().length).toBeGreaterThan(10);
    expect(getMedicationInstructionConcept("water")).toMatchObject({
      code: "water",
      role: "substance",
      display: "water"
    });
    expect(getMedicationInstructionConcept("water")?.externalCodings).toContainEqual(
      expect.objectContaining({ system: "http://snomed.info/sct", code: "11713004" })
    );
    const codeSystem = buildMedicationInstructionConceptCodeSystem();
    expect(codeSystem).toMatchObject({
      resourceType: "CodeSystem",
      status: "active",
      content: "complete"
    });
    // Mapped SNOMED CT concepts are not duplicated in the fallback CodeSystem.
    expect(codeSystem.concept.some((concept) => concept.code === "water")).toBe(false);
    expect(codeSystem.concept.some((concept) => concept.code === "57368009")).toBe(false);
    expect(getMedicationInstructionConcept("57368009")?.coding).toMatchObject({
      system: "http://snomed.info/sct", code: "57368009"
    });
    for (const [name, code] of [
      ["syringe", "61968008"], ["needle", "79068005"],
      ["bottle", "68276009"], ["food", "255620007"]
    ]) {
      expect(getMedicationInstructionConcept(name)?.coding).toMatchObject({
        system: "http://snomed.info/sct", code
      });
      expect(codeSystem.concept.some((concept) => concept.code === name)).toBe(false);
    }
    expect(parseInstructionActions("shake bottle")[0]?.args[0]?.coding).toMatchObject({
      system: "http://snomed.info/sct", code: "68276009"
    });
  });


  it("distinguishes clause-leading procedural conditions from PRN and round-trips relation coverage", () => {
    const parsed = parseSig("if irritation occurs stop use");
    expect(parsed.fhir.asNeededFor).toBeUndefined();
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions).toHaveLength(1);
    expect(graph?.actions[0]).toMatchObject({
      predicate: { lemma: "stop" },
      args: [expect.objectContaining({ role: "activity", conceptId: "use" })]
    });
    expect(graph?.relations).toEqual([
      expect.objectContaining({
        kind: "if",
        toActionIndex: 0,
        text: "if irritation occurs"
      })
    ]);
    expect(graph?.coverage).toMatchObject({
      understoodCharacters: 28,
      opaqueCharacters: 0,
      complete: true
    });
    expect(graph?.coverage?.ratio).toBe(1);
    expect(realizeInstructionGraph(graph!, "en")).toBe("if irritation occurs, stop use");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.relations).toEqual(graph?.relations?.map(relation => ({ ...relation,
      sourceKindCoding: { system: "http://snomed.info/sct", code: "421803000", display: "If - dosing instruction fragment" }
    })));
    expect(restored?.coverage).toEqual(graph?.coverage);
  });

  it("keeps classic medication conditional shorthand as PRN", () => {
    const parsed = parseSig("1 tab po if pain", { context: { dosageForm: "tablet" } });
    expect(parsed.fhir.asNeeded).toBe(true);
    expect(parsed.fhir.asNeededFor?.[0]?.coding?.[0]?.code).toBe("22253000");
  });

  it("tracks complete semantic coverage for colloquial Thai action sequences", () => {
    const parsed = parseSig("เช็ดรอยโรคแล้วรอ 5 นาทีแล้วล้างด้วยน้ำ", { locale: "th" });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.coverage).toMatchObject({ opaqueCharacters: 0, complete: true, ratio: 1 });
    expect(graph?.relations?.map((relation) => relation.kind)).toEqual(["then", "then"]);
  });


  it("accepts only terminology-valid semantic resolver proposals for opaque spans", () => {
    const requests: string[] = [];
    let observedRange: { start: number; end: number } | undefined;
    let observedOpaque: string | undefined;
    const parsed = parseSig("shake bottle before use and croon a song", {
      instructionActionMap: {
        sing: {
          code: "sing",
          semanticClass: "activity",
          display: "Sing",
          i18n: { th: "ร้องเพลง" },
          procedural: true
        }
      },
      instructionConceptMap: {
        "a song": {
          code: "song",
          role: "object",
          display: "a song",
          i18n: { th: "เพลง" }
        }
      },
      instructionSemanticResolvers: (request) => {
        requests.push(request.sourceText);
        observedRange = { ...request.range };
        observedOpaque = request.existingGraph.opaqueSpans?.[0]?.text;
        return {
          actions: [
            {
              action: "sing",
              range: { start: 0, end: 12 },
              confidence: 0.91,
              args: [
                {
                  role: "object",
                  range: { start: 6, end: 12 },
                  concept: "a song"
                }
              ]
            }
          ]
        };
      }
    });

    expect(requests).toEqual(["croon a song"]);
    expect(observedRange).toEqual({ start: 28, end: 40 });
    expect(observedOpaque).toBe("croon a song");
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["shake", "sing"]);
    expect(graph?.opaqueSpans).toBeUndefined();
    expect(graph?.coverage).toMatchObject({
      opaqueCharacters: 0,
      ratio: 1,
      complete: true
    });
    expect(graph?.actions[1]).toMatchObject({
      origin: "semantic-resolver",
      confidence: 0.91,
      predicate: { lemma: "sing", display: "Sing", i18n: { th: "ร้องเพลง" } },
      args: [expect.objectContaining({ conceptId: "song", normalized: "a song" })]
    });

    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.actions[1]).toMatchObject({
      origin: "semantic-resolver",
      confidence: 0.91,
      predicate: { lemma: "sing", display: "Sing" }
    });
  });

  it("rejects unregistered or out-of-bounds semantic proposals without hiding opaque text", () => {
    const unregistered = parseSig("croon a song", {
      instructionSemanticResolvers: () => ({
        actions: [{ action: "invented-action", range: { start: 0, end: 12 } }]
      })
    });
    expect(unregistered.meta.canonical.clauses[0]?.instructionGraph?.actions).toEqual([]);
    expect(unregistered.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans?.[0]?.text).toBe("croon a song");

    const outOfBounds = parseSig("croon a song", {
      instructionActionMap: {
        sing: { code: "sing", semanticClass: "activity", display: "Sing", procedural: true }
      },
      instructionSemanticResolvers: () => ({
        actions: [{ action: "sing", range: { start: 0, end: 100 } }]
      })
    });
    expect(outOfBounds.meta.canonical.clauses[0]?.instructionGraph?.actions).toEqual([]);
    expect(outOfBounds.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans?.[0]?.text).toBe("croon a song");
  });

  it("supports asynchronous model-backed semantic resolvers without changing parseSig sync safety", async () => {
    const options = {
      instructionActionMap: {
        hum: { code: "hum", semanticClass: "activity", display: "Hum", procedural: true }
      },
      instructionSemanticResolvers: async (request: any) => ({
        actions: [{ action: "hum", range: { start: 0, end: request.sourceText.length }, confidence: 0.8 }]
      })
    };

    expect(() => parseSig("murmur quietly", options)).toThrow(/parseSigAsync/);
    const parsed = await parseSigAsync("murmur quietly", options);
    const action = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(action).toMatchObject({
      origin: "semantic-resolver",
      confidence: 0.8,
      predicate: { lemma: "hum" }
    });
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.coverage).toMatchObject({
      opaqueCharacters: 0,
      complete: true,
      ratio: 1
    });
  });

  it("does not mistake resolver-thrown message text for the local async-resolver sentinel", () => {
    const parsed = parseSig("murmur quietly", {
      instructionSemanticResolvers: () => {
        throw new Error("resolver says use parseSigAsync for a different reason");
      }
    });
    expect(parsed.warnings).toContain(
      "Instruction semantic resolver failed; opaque clinician text was preserved."
    );
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans?.[0]?.text).toBe("murmur quietly");
  });

  it("lets caller-owned actions select declarative argument and realization families", () => {
    const parsed = parseSig("twirl bottle before use", {
      instructionActionMap: {
        twirl: {
          code: "twirl-device",
          semanticClass: "prepare_device",
          display: "Twirl",
          procedural: true,
          argumentParser: "container-activity",
          realizer: "container-activity"
        }
      }
    });
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions[0]).toMatchObject({
      predicate: { lemma: "twirl-device" },
      args: [
        expect.objectContaining({ role: "container", conceptId: "bottle" }),
        expect.objectContaining({ role: "activity", conceptId: "use" })
      ]
    });
    expect(realizeInstructionGraph(graph!, "en")).toBe("Twirl bottle before use");
    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.actions[0]?.predicate.realizer).toBe("container-activity");
    expect(realizeInstructionGraph(restored!, "en")).toBe("Twirl bottle before use");
  });

  it("models Thai separable patch replacement as a scoped procedural program rather than PRN", () => {
    const parsed = parseSig(
      "หากฝันชัดเจนให้เอาแผ่นแปะออกก่อนนอนแล้วแปะแผ่นใหม่ตอนเช้า",
      { locale: "th" }
    );
    const clause = parsed.meta.canonical.clauses[0];
    const graph = clause?.instructionGraph;
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(graph?.actions.map((action) => action.predicate.lemma)).toEqual(["remove", "apply_patch"]);
    expect(graph?.actions[0]).toMatchObject({
      relation: "before",
      args: [
        expect.objectContaining({ conceptId: "patch" }),
        expect.objectContaining({ role: "time", normalized: "HS" })
      ]
    });
    expect(graph?.actions[1]?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ conceptId: "new_patch" }),
      expect.objectContaining({ role: "time", conceptId: "morning" })
    ]));
    expect(graph?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "then", fromActionIndex: 0, toActionIndex: 1 }),
      expect.objectContaining({ kind: "if", toActionIndex: 0, text: "หากฝันชัดเจน" })
    ]));
    expect(graph?.coverage).toMatchObject({ opaqueCharacters: 0, complete: true, ratio: 1 });
    expect(parsed.longText).toBe(
      "หากฝันชัดเจนให้เอาแผ่นแปะออกก่อนนอน จากนั้นแปะแผ่นใหม่ตอนเช้า."
    );
  });

  it("keeps reconstitution quantities local to MIX instead of promoting them to the swallowed dose", () => {
    const parsed = parseSig("ผสมยา 1 ซองกับน้ำ 120 มิลลิลิตร แล้วดื่มทันที", { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    const mix = clause?.instructionGraph?.actions.find((action) => action.predicate.lemma === "mix");
    expect(clause?.dose).toBeUndefined();
    expect(mix?.args).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "theme", conceptId: "product", quantity: { value: 1, unit: "sachet" }
      }),
      expect.objectContaining({
        role: "substance", conceptId: "water", quantity: { value: 120, unit: "mL" }
      })
    ]));
    expect(clause?.schedule?.when).toEqual(["IMD"]);
    expect(parsed.meta.leftoverText).toBeUndefined();
    expect(parsed.longText).toBe("ผสมยา 1 ซองกับน้ำ 120 มิลลิลิตร จากนั้นดื่มทันที.");
  });

  it("fails open to preserved opaque text when an async semantic resolver throws", async () => {
    const parsed = await parseSigAsync("sing a song", {
      instructionSemanticResolvers: async () => {
        throw new Error("model unavailable");
      }
    });
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.opaqueSpans?.[0]?.text).toBe("sing a song");
    expect(parsed.warnings).toContain(
      "Instruction semantic resolver failed; opaque clinician text was preserved."
    );
  });

  it("keeps a Thai bruised-site injection prohibition complete and bilingual through R5", () => {
    const source = "ฉีดอินซูลิน 5 ยูนิตใต้ผิวหนังที่หน้าท้องหรือต้นขา สลับตำแหน่งทุกครั้ง ห้ามฉีดบริเวณที่ช้ำ";
    const parsed = parseSig(source, { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    const graph = clause?.instructionGraph;
    const prohibition = graph?.actions.find((action) =>
      action.predicate.lemma === "inject" && action.polarity === "negate"
    );

    expect(clause?.dose).toEqual({ value: 5, unit: "U" });
    expect(clause?.route?.code).toBe("34206005");
    expect(clause?.administrationTargetGroup).toMatchObject({
      coordination: "disjunction",
      targets: [
        { coding: { code: "302553009" } },
        { coding: { code: "68367000" } }
      ]
    });
    expect(prohibition).toMatchObject({
      sourceText: "ห้ามฉีดบริเวณที่ช้ำ",
      args: [{
        role: "site",
        text: "บริเวณที่ช้ำ",
        i18n: {
          en: "the area where there is bruising",
          th: "บริเวณที่ช้ำ"
        }
      }]
    });
    expect(realizeInstructionGraph(graph!, "en")).toContain(
      "Do not inject on the area where there is bruising"
    );
    expect(realizeInstructionGraph(graph!, "th")).toContain("ห้ามฉีดบริเวณที่ช้ำ");
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(
      "Do not inject on the area where there is bruising"
    );
    expect(parsed.fhir.text).toContain("ห้ามฉีดบริเวณที่ช้ำ");
    expect(parsed.fhir.text).not.toContain("จากนั้นอินซูลิน");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized;
    const restoredProhibition = restored.instructionGraph?.actions.find((action) =>
      action.predicate.lemma === "inject" && action.polarity === "negate"
    );
    expect(restoredProhibition).toMatchObject({
      args: [{
        role: "site",
        text: "บริเวณที่ช้ำ",
        i18n: {
          en: "the area where there is bruising",
          th: "บริเวณที่ช้ำ"
        }
      }]
    });
    expect(restored.instructionGraph?.sourceText).toBe(source);
  });

  it("keeps an ordinary Thai open-wound topical prohibition typed and localized", () => {
    const source = "ทาครีมบางๆ ที่ผื่น วันละ 2 ครั้ง ห้ามทาบริเวณแผลเปิด";
    const parsed = parseSig(source, { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];
    const prohibition = clause?.instructionGraph?.actions.find((action) =>
      action.predicate.lemma === "apply" && action.polarity === "negate"
    );

    expect(clause?.route?.code).toBe("6064005");
    expect(clause?.site).toMatchObject({ text: "rash" });
    expect(clause?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(prohibition).toMatchObject({
      sourceText: "ห้ามทาบริเวณแผลเปิด",
      args: [{
        role: "site",
        text: "บริเวณแผลเปิด",
        conceptId: "open-wound",
        i18n: { en: "open wounds", th: "แผลเปิด" }
      }]
    });
    expect(realizeInstructionGraph(clause!.instructionGraph!, "en")).toBe(
      "Do not apply to open wounds"
    );
    expect(realizeInstructionGraph(clause!.instructionGraph!, "th")).toBe("ห้ามทาบริเวณแผลเปิด");
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain("Do not apply to open wounds");
    expect(parsed.fhir.text).toContain("ห้ามทาบริเวณแผลเปิด");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph;
    expect(restored?.actions[0]?.args[0]).toMatchObject({
      role: "site",
      text: "บริเวณแผลเปิด",
      conceptId: "open-wound",
      i18n: { en: "open wounds", th: "แผลเปิด" }
    });
  });

  it("uses the typed site-relative construction for a nearby Thai bruised-site phrase", () => {
    const source = "ทาครีมบางๆ ที่ต้นขาที่ช้ำ วันละ 2 ครั้ง";
    const parsed = parseSig(source, { locale: "th" });
    const clause = parsed.meta.canonical.clauses[0];

    expect(clause?.route?.code).toBe("6064005");
    expect(clause?.schedule).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
    expect(clause?.site).toMatchObject({
      text: "thigh",
      coding: { code: "68367000" },
      restrictions: [{
        relation: "where",
        sourceText: "ที่ช้ำ",
        predicate: { text: "ช้ำ", lemma: "bruised", form: "state" }
      }]
    });
    expect(parsed.fhir.site?.extension).toEqual(expect.arrayContaining([
      expect.objectContaining({
        extension: expect.arrayContaining([
          expect.objectContaining({ url: "predicateLemma", valueString: "bruised" })
        ])
      })
    ]));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(
      "the thigh where there is bruising"
    );
    expect(parsed.fhir.text).toContain("ต้นขาที่ช้ำ");

    const restored = fromFhirDosage(parsed.fhir).meta.normalized;
    expect(restored.site?.restrictions?.[0]).toMatchObject({
      sourceText: "ที่ช้ำ",
      predicate: { text: "ช้ำ", lemma: "bruised", form: "state" }
    });
  });

  it("preserves an unknown qualified prohibition site as one complete editable argument", () => {
    const source = "ฉีด 5 ยูนิตใต้ผิวหนัง ห้ามฉีดบริเวณที่มีรอยสักใหม่";
    const parsed = parseSig(source, { locale: "th" });
    const prohibition = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.find((action) =>
      action.predicate.lemma === "inject" && action.polarity === "negate"
    );

    expect(prohibition?.sourceText).toBe("ห้ามฉีดบริเวณที่มีรอยสักใหม่");
    expect(prohibition?.args).toEqual([
      expect.objectContaining({
        role: "site",
        text: "บริเวณที่มีรอยสักใหม่",
        normalized: "บริเวณที่มีรอยสักใหม่"
      })
    ]);
    expect(realizeInstructionGraph(parsed.meta.canonical.clauses[0].instructionGraph!, "en"))
      .toContain("บริเวณที่มีรอยสักใหม่");
    expect(parsed.fhir.text).toContain("ห้ามฉีดบริเวณที่มีรอยสักใหม่");
    expect(fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph?.sourceText).toBe(source);
  });

});


it("preserves a complete opaque complement instead of producing hybrid Thai action text", () => {
  const source = "Apply 0.5 g to either arm or leg, not both; rotate which site each night.";
  const parsed = parseSig(source);
  const th = formatSig(parsed.fhir, "long", { locale: "th" });
  expect(th).toContain("Rotate which site each night");
  expect(th).not.toContain("สลับwhich");
  const fromR5 = fromFhirDosage(parsed.fhir).meta.normalized;
  expect(fromR5.instructionGraph?.actions[0]?.sourceText).toBe("rotate which site each night");
  expect(formatSig(parsed.fhirNext, "long", { locale: "th" }))
    .toContain("Rotate which site each night");

  // Fully typed instructions continue to translate, rather than suddenly
  // falling back to English as a response to an unrelated opaque object.
  const translated = parseSig("Shake bottle before use, then rinse with water.");
  expect(formatSig(translated.fhir, "long", { locale: "th" }))
    .toContain("เขย่าขวดก่อนใช้");
  expect(formatSig(translated.fhir, "long", { locale: "th" }))
    .toContain("ล้างด้วยน้ำ");
});


describe("nominal medication-slot omission valence", () => {
  it.each([
    ["งดมื้อเย็น", [false, true]],
    ["งดมื้อเช้า", [true, false]],
    ["งดยามื้อเย็น", [false, true]],
    ["avoid the evening dose", [false, true]]
  ] as const)("binds a selected medication-slot reference to only its matching dose: %s", (action, target) => {
    const input = "ฉีดอินซูลิน 5 ยูนิตก่อนอาหารเช้า และ 8 ยูนิตก่อนอาหารเย็น " + action + " หากน้ำตาลต่ำกว่า 70";
    const parsed = parseSig(input);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 8]);
    expect(rows.map(row => row.timing?.repeat?.when)).toEqual([["ACM"], ["ACV"]]);
    expect(rows.map(row => Boolean(getDosageCondition(row)))).toEqual([...target]);
    rows.forEach((row, index) => {
      if (target[index]) expect(getDosageCondition(row)).toMatchObject({
        kind: "not", condition: { kind: "measurement", name: "glucose", operation: "lt", value: 70 }
      });
    });
    expect(toFhirR5Dosages(toDosageDetails(rows)).map(getDosageCondition))
      .toEqual(rows.map(getDosageCondition));
    expect(parsed.meta.canonical.clauses.map(clause => clause.rawText).join(" "))
      .toContain(action);
  });

  it.each([
    "งดอาหารเย็น", "งดอาหารมื้อเย็น", "งดน้ำ", "avoid dinner", "hold your breath"
  ])("does not reinterpret a non-medication avoidance object as withholding: %s", action => {
    const input = "Inject 5 units before breakfast and 8 units before dinner; " + action + " if glucose below 70";
    const parsed = parseSig(input);
    const rows = parsed.items.map(item => item.fhir);
    expect(rows).toHaveLength(2);
    expect(rows.map(getDosageCondition)).toEqual([undefined, undefined]);
    expect(rows.map(row => row.doseAndRate?.[0]?.doseQuantity?.value)).toEqual([5, 8]);
  });
});


describe("qualified non-executable counseling remains source-faithful", () => {
  it.each([
    "Take 1 tablet twice daily but skip morning dose on dialysis days",
    "Take 1 tablet twice daily; hold the morning dose on dialysis days"
  ])("does not present an unqualified withholding directive: %s", source => {
    const parsed = parseSig(source);
    const instruction = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions
      .find(action => action.predicate.semanticClass === "withhold-administration" ||
        action.predicate.lemma === "hold");
    expect(instruction?.sourceText).toContain("dialysis days");
    expect(instruction?.args.some(arg => arg.role === "time" &&
      arg.text?.includes("dialysis days"))).toBe(true);
    const en = formatSig(parsed.fhir, "long", { locale: "en" });
    expect(en).toContain("dialysis days");
    expect(en).not.toMatch(/withhold administration (?:the )?morning dose\.(?!.*dialysis days)/i);
    expect(fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph?.sourceText)
      .toBe(source);
  });
});

describe("unresolved procedural adjuncts remain conditional in patient text", () => {
  it.each([
    "Take 1 tablet twice daily; skip morning dose on dialysis days.",
    "Take 1 tablet twice daily but skip morning dose on dialysis days.",
    "Take 1 tablet twice daily; hold morning dose on dialysis days."
  ])("keeps the complete non-executable schedule qualifier: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.frequency).toBe(2);
    expect(parsed.meta.canonical.clauses[0]?.patientInstruction).toContain("on dialysis days");
    const display = formatSig(parsed.fhir, "long", { locale: "en" });
    expect(display).toMatch(/(?:skip|hold|withhold(?: administration)?)(?: the)? morning dose on dialysis days/i);
    const directives = display.split(/[.!?]/u).filter(sentence =>
      /(?:skip|hold|withhold(?: administration)?)(?: the)? morning dose/iu.test(sentence));
    expect(directives.length).toBeGreaterThan(0);
    expect(directives.every(sentence => /on dialysis days/iu.test(sentence))).toBe(true);
    expect(parsed.input).toBe(source);
  });
});

describe("source-backed duration valence for procedural rinsing", () => {
  it.each([
    ["one minute", 1],
    ["a minute", 1],
    ["1 minute", 1],
    ["two minutes", 2]
  ] as const)("resolves quantified rinse duration as a procedural argument: %s", (phrase, duration) => {
    const source = `Take 1 tablet daily; rinse for ${phrase} then spit`;
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    const rinse = clause.instructionGraph?.actions.find(action => action.predicate.lemma === "rinse");
    const quantity = rinse?.args.find(arg => arg.role === "duration");

    expect(clause.dose).toEqual({ value: 1, unit: "tab" });
    expect(clause.schedule).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(clause.schedule?.duration).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(clause.prn).toBeUndefined();
    expect(quantity).toMatchObject({
      role: "duration",
      text: `for ${phrase}`,
      quantity: { value: duration, unit: "min" }
    });
    expect(clause.additionalInstructions?.some(instruction =>
      /^rinse for\.?$/i.test(instruction.text ?? "")
    )).not.toBe(true);
    const english = formatSig(parsed.fhir, "long", { locale: "en" });
    expect(english).toMatch(new RegExp(`Rinse(?: the mouth)? for (?:${duration} (?:min|minute)|${phrase})`, "i"));
    expect(english).toMatch(/then spit/i);
    expect(english).not.toMatch(/Rinse for\. Rinse/i);
    const restored = fromFhirDosage(parsed.fhir).meta.normalized;
    expect(restored.instructionGraph?.actions.find(a => a.predicate.lemma === "rinse")
      ?.args.some(a => a.role === "duration" && a.quantity?.value === duration))
      .toBe(true);
  });

  it("keeps rinse-with substance separate from quantified duration", () => {
    const parsed = parseSig("Take 1 tablet daily; rinse with water then spit");
    const rinse = parsed.meta.canonical.clauses[0]?.instructionGraph?.actions
      .find(action => action.predicate.lemma === "rinse");
    expect(rinse?.args.some(arg => arg.role === "duration")).toBe(false);
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toMatch(/rinse with water/i);
  });

  it.each([
    ["Rinse for one minute then spit", "rinse", "Rinse for 1 minute", "ล้างเป็นเวลา 1 นาที"],
    ["Rinse mouth for one minute then spit", "rinse_mouth", "Rinse mouth for 1 minute", "บ้วนปาก นาน 1 นาที"]
  ] as const)("keeps separate non-dosed rinse and mouth-rinse duration: %s", (source, lemma, english, thai) => {
    const parsed = parseSig(source);
    const clause = parsed.meta.canonical.clauses[0];
    const action = clause.instructionGraph?.actions.find(frame => frame.predicate.lemma === lemma);
    expect(clause.rawText).toBe(source);
    expect(parsed.fhir.doseAndRate).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.boundsDuration).toBeUndefined();
    expect(parsed.fhir.asNeeded).not.toBe(true);
    expect(action?.args).toContainEqual(expect.objectContaining({
      role: "duration",
      text: "for one minute",
      quantity: { value: 1, unit: "min" }
    }));
    expect(formatSig(parsed.fhir, "long", { locale: "en" })).toContain(english);
    expect(formatSig(parsed.fhir, "long", { locale: "th" })).toContain(thai);
    expect(fromFhirDosage(parsed.fhir).meta.normalized.instructionGraph?.actions
      .find(frame => frame.predicate.lemma === lemma)?.args.some(arg =>
        arg.role === "duration" && arg.quantity?.value === 1)).toBe(true);
  });
});


describe("qualified medication withholding remains source-faithful", () => {
  it.each([
    "Take 1 tablet twice daily; skip morning dose on dialysis days",
    "Take 1 tablet twice daily but skip morning dose on dialysis days"
  ])("preserves unresolved post-action qualifier rather than inventing unconditional withhold: %s", source => {
    const parsed = parseSig(source);
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph;
    expect(graph?.actions.some(a => a.sourceText.includes("on dialysis days"))).toBe(true);
    const displayed = formatSig(parsed.fhir, "long", { locale: "en" });
    expect(displayed).toContain("on dialysis days");
    expect(displayed).not.toMatch(/withhold administration morning dose\.$/i);
    expect(parsed.input).toBe(source);
  });
});


describe("negated dietary advice cannot schedule the medication", () => {
  it.each([
    ["Take 1 tablet daily. Do not miss meals.", "miss meals"],
    ["Take 1 tablet daily. Never miss meals.", "miss meals"],
    ["Take 1 tablet daily. Never skip meals.", "skip meals"],
    ["Take 1 tablet daily. Do not miss breakfast.", "miss breakfast"],
    ["Take 1 tablet daily. Do not miss any meals.", "miss any meals"],
    ["Take 1 tablet daily. Never miss a meal.", "miss a meal"]
  ] as const)("retains negated meal advice without inventing medication timing: %s", (source, advice) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.timing?.repeat?.when).toBeUndefined();
    expect(parsed.fhir.timing?.repeat?.frequency).toBe(1);
    expect(parsed.meta.canonical.clauses[0]?.rawText).toBe(source);
    expect(parsed.longText.toLowerCase()).toContain(advice.toLowerCase());
    const strict = toFhirR5Dosages(toDosageDetails([parsed.fhir]))[0];
    expect(strict.timing?.repeat?.when).toBeUndefined();
    expect(strict.timing?.repeat?.frequency).toBe(1);
  });

  it("retains positive administration meal timing, independent of dietary negative advice", () => {
    const meal = parseSig("Take one tablet with meals");
    expect(meal.fhir.timing?.repeat?.when).toContain("C");
    const breakfast = parseSig("Take one tablet after breakfast");
    expect(breakfast.fhir.timing?.repeat?.when).toContain("PCM");
    const alreadyCovered = parseSig("Take 1 tablet daily. Do not skip meals");
    expect(alreadyCovered.fhir.timing?.repeat?.when).toBeUndefined();
  });
});

// Authoritative procedure codes: HL7 Vulcan RWD ExampleDialysisProcedureCodes
// (SNOMED International 2023-01-31), and HL7 AU Core Procedure-dialysis.
// These are procedure EVENTS, not SCT 1231460007 (administration method).
describe("coded procedural timing rather than administration-method homographs", () => {
  const SNOMED = "http://snomed.info/sct";
  it.each([
    ["Take 1 tablet after dialysis.", "108241001", "after"],
    ["Take 1 tablet before dialysis.", "108241001", "before"],
    ["Take 1 tablet after hemodialysis.", "302497006", "after"],
    ["Take 1 tablet after haemodialysis.", "302497006", "after"],
    ["Take 1 tablet before peritoneal dialysis.", "71192002", "before"],
    ["รับประทาน 1 เม็ดหลังฟอกไต", "108241001", "after"],
    ["รับประทาน 1 เม็ดก่อนฟอกเลือด", "302497006", "before"],
    ["รับประทาน 1 เม็ดหลังล้างไตทางช่องท้อง", "71192002", "after"]
  ])("preserves procedure %s and its relative timing through native/strict FHIR", (source, code, relation) => {
    const parsed = parseSig(source);
    const expected = { relation, activity: { coding: { system: SNOMED, code } } };
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toContainEqual(expect.objectContaining({
      relation,
      activity: expect.objectContaining({ coding: expect.objectContaining({ system: SNOMED, code }) })
    }));
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 1, unit: "tab" });
    expect(parsed.fhir.method?.coding?.some(c => c.code === "1231460007")).toBeFalsy();
    for (const row of [parsed.fhir, ...toFhirR5Dosages(toDosageDetails([parsed.fhir]))]) {
      const restored = fromFhirDosage(row).meta.canonical.clauses[0]?.schedule?.activityTiming;
      expect(restored?.[0]).toMatchObject(expected);
    }
  });

  it.each([
    "Take 1 tablet after the dialysis session.",
    "Take 1 tablet after dialysis sessions."
  ])("uses the same noun construction with determiners and inflection: %s", source => {
    const parsed = parseSig(source);
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]).toMatchObject({
      relation: "after", activity: { coding: { system: SNOMED, code: "108241001" } }
    });
  });

  it("keeps a separate procedural warning from changing the medication schedule", () => {
    const parsed = parseSig("Take 1 tablet daily. Do not drive after dialysis.");
    expect(parsed.fhir.timing?.repeat).toMatchObject({ frequency: 1, period: 1, periodUnit: "d" });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("dialysis");
    expect(parsed.longText.toLowerCase()).toMatch(/(?:not|avoid).*driv/);
  });

  it("does not turn a negated administration into a positive procedure-relative schedule", () => {
    const parsed = parseSig("Do not take after dialysis.");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toBeUndefined();
    expect(parsed.longText.toLowerCase()).toContain("not");
  });

  it("composes a caller-registered activity without a built-in dialysis phrase rule", () => {
    const parsed = parseSig("Take 1 tablet before physiotherapy.", {
      instructionConceptMap: {
        physiotherapy: {
          role: AdviceArgumentRole.Activity,
          display: "physiotherapy",
          coding: { system: "https://example.test/procedures", code: "physiotherapy" }
        }
      }
    });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming?.[0]).toMatchObject({
      relation: "before",
      activity: { coding: { system: "https://example.test/procedures", code: "physiotherapy" } }
    });
  });

  it("keeps dialysis as a true administration method when it is the directive head", () => {
    const parsed = parseSig("dialysis daily");
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({ system: SNOMED, code: "1231460007" });
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toBeUndefined();
  });

  it("does not map a dialysis-day qualifier to an invented procedure occurrence", () => {
    const parsed = parseSig("Take 1 tablet on dialysis days.");
    expect(parsed.longText.toLowerCase()).toContain("dialysis");
    expect(parsed.meta.canonical.clauses[0]?.schedule?.activityTiming).toBeUndefined();
    expect(parsed.fhir.method?.coding?.some(c => c.code === "108241001" || c.code === "302497006")).toBeFalsy();
  });
});


describe("registered activity-day adjunct membership and exclusion", () => {
  it.each([
    ["on dialysis days", false], ["only on dialysis days", false],
    ["on hemodialysis days", false], ["except on dialysis days", true],
    ["except dialysis days", true], ["เฉพาะวันฟอกไต", false],
    ["ในวันฟอกไต", false], ["ยกเว้นวันฟอกไต", true]
  ] as const)("uses caller day membership rather than an invented calendar: %s", (adjunct, excluded) => {
    const source = "Take 1 tablet at 08:00 for 7 days " + adjunct + ".";
    const parsed = parsePublicSig(source);
    expect(parsed.fhir).toHaveLength(1);
    const condition = getDosageCondition(parsed.fhir[0]);
    expect(condition).toMatchObject(excluded ? { kind: "not", condition: { kind: "text" } } : { kind: "text" });
    expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming).toBeUndefined();
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const base = { orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok", limit: 2 };
      // The public callback evaluates the complete predicate, not just its
      // leaf. Supply day membership and honor the retained NOT explicitly.
      const evaluates = (member: boolean) => (predicate: MedicationCondition) =>
        predicate.kind === "not" ? !member : member;
      const enabled = nextDueDoses(dosage, { ...base, evaluateCondition: evaluates(!excluded) });
      const disabled = nextDueDoses(dosage, { ...base, evaluateCondition: evaluates(excluded) });
      expect(enabled[0]).toBe("2026-11-02T08:00:00+07:00");
      expect(disabled).toEqual([]);
    }
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("composes a caller-registered activity with the same day-noun construction", () => {
    const parsed = parsePublicSig("Take 1 tablet at 08:00 on physiotherapy days.", {
      instructionConceptMap: { physiotherapy: {
        role: AdviceArgumentRole.Activity, display: "physiotherapy",
        coding: { system: "https://example.test/procedures", code: "physiotherapy" }
      } }
    });
    expect(getDosageCondition(parsed.fhir[0])).toMatchObject({ kind: "text" });
    expect(parsed.fhir[0].timing?.repeat?.dayOfWeek).toBeUndefined();
    expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming).toBeUndefined();
  });

  it("does not change ordinary weekdays, procedure-relative timing, or unrelated warnings", () => {
    const weekday = parsePublicSig("Take 1 tablet on Monday.");
    expect(weekday.fhir[0].timing?.repeat?.dayOfWeek).toEqual(["mon"]);
    expect(getDosageCondition(weekday.fhir[0])).toBeUndefined();
    const after = parsePublicSig("Take 1 tablet after dialysis.");
    expect(after.meta.canonical.clauses[0].schedule?.activityTiming?.[0].relation).toBe("after");
    expect(getDosageCondition(after.fhir[0])).toBeUndefined();
    const warning = parsePublicSig("Take 1 tablet daily. Do not drive on dialysis days.");
    expect(getDosageCondition(warning.fhir[0])).toBeUndefined();
    expect(warning.fhir[0].timing?.repeat?.frequency).toBe(1);
  });

  it("keeps the day condition on the independently specified evening dose", () => {
    const source = "Take 1 tablet at 08:00 for 7 days. Take half a tablet at 20:00 for 7 days only on dialysis days.";
    const parsed = parsePublicSig(source);
    expect(parsed.fhir).toHaveLength(2);
    expect(getDosageCondition(parsed.fhir[0])).toBeUndefined();
    expect(getDosageCondition(parsed.fhir[1])).toMatchObject({ kind: "text" });
    for (const dosage of [parsed.fhirNext, toFhirR5Dosages(parsed.fhirNext)]) {
      const on = (value: boolean) => nextDueDoses(dosage, {
        orderedAt: "2026-11-02T00:00:00+07:00", from: "2026-11-02T00:00:00+07:00",
        timeZone: "Asia/Bangkok", evaluateCondition: () => value, limit: 4
      }).filter(stamp => stamp.startsWith("2026-11-02")).map(stamp => stamp.slice(11,16));
      expect(on(false)).toEqual(["08:00"]);
      expect(on(true)).toEqual(["08:00", "20:00"]);
    }
  });
});


describe("standard instruction terminology", () => {
  it.each([
    ["doctor", "158965000"], ["household-spoon", "303514007"],
    ["applicator", "408101000"], ["inhaler", "334980009"], ["spacer", "464036000"],
    ["medication-tablet", "732936001"], ["medication-capsule", "732937005"],
    ["cream", "385099005"], ["ointment", "385101003"], ["gel", "385100002"],
    ["patch", "733005001"], ["open-wound", "59091005"],
    ["drinking-activity", "30953006"], ["exercise", "256235009"],
    ["swimming", "20461001"], ["bathing", "129002005"], ["sweating", "415691001"],
    ["intercourse", "364316005"], ["morning", "73775008"], ["noon", "71997007"],
    ["afternoon", "422133006"], ["evening", "3157002"], ["night", "2546009"],
    ["bedtime", "21029003"], ["gently", "418449005"], ["immediacy", "88694003"],
    ["transdermal-patch", "466056002"], ["small_amount", "769398002"],
    ["overnight", "255270004"], ["application", "129425003"],
    ["medication-administration", "18629005"], ["drink-product", "226465004"],
    ["alcoholic-beverage", "53527002"], ["ethanol", "419442005"]
  ])("uses the standard concept without a duplicate local coding: %s", (name, code) => {
    const concept = getMedicationInstructionConcept(name)!;
    expect(concept.code).toBe(name);
    expect(getMedicationInstructionConcept(code, "http://snomed.info/sct")?.code).toBe(name);
    expect(getMedicationInstructionConcept(code, "http://example.test/unrelated")).toBeUndefined();
    const codings = medicationInstructionConceptCodings(concept);
    expect(codings).toContainEqual(
      expect.objectContaining({ system: "http://snomed.info/sct", code })
    );
    expect(codings.every(value => value.system !== "urn:ezmedicationinput:CodeSystem:medication-instruction-concept")).toBe(true);
    expect(buildMedicationInstructionConceptCodeSystem().concept
      .some(value => value.code === name)).toBe(false);
  });

  it.each([
    ["administer", "418283001"], ["use", "419385000"], ["place", "421066005"],
    ["shampoo", "420606003"], ["sprinkle", "422219000"], ["stop", "421286000"],
    ["complete-course", "420604000"], ["remove", "129303008"], ["replace", "282089006"],
    ["measure", "129266000"], ["cut", "360314001"], ["nebulize", "56251003"],
    ["rinse_mouth", "59611000087105"], ["call", "420942008"],
    ["soak", "42691000"],
    ["consult", "129430004"]
  ])("uses the standard action without changing the grammar identity: %s", (name, code) => {
    const action = getMedicationInstructionAction(name)!;
    expect(action.code).toBe(name);
    expect(medicationInstructionActionCodings(action)).toEqual([
      expect.objectContaining({ system: "http://snomed.info/sct", code })
    ]);
    expect(buildMedicationInstructionActionCodeSystem().concept
      .some(value => value.code === name)).toBe(false);
  });


  it("keeps the local withhold-administration predicate while retaining the SNOMED hold fragment", () => {
    const definition = getMedicationInstructionAction("withhold-administration")!;
    expect(medicationInstructionActionCodings(definition)).toEqual([
      expect.objectContaining({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action",
        code: "withhold-administration"
      })
    ]);
    expect(definition.semanticComponents).toContainEqual(expect.objectContaining({
      role: "operation",
      coding: expect.objectContaining({ system: "http://snomed.info/sct", code: "421139008" })
    }));
    expect(buildMedicationInstructionActionCodeSystem().concept.some(
      item => item.code === "withhold-administration"
    )).toBe(true);
  });

  it("uses mapped external action codes directly while retaining caller-supplied additional codes", () => {
    const apply = getMedicationInstructionAction("apply")!;
    expect(medicationInstructionActionCodings(apply))
      .toEqual(apply.externalCodings);
    expect(buildMedicationInstructionActionCodeSystem().concept
      .some(value => value.code === "apply")).toBe(false);
    const first = { system: "http://snomed.info/sct", code: "417924000" };
    const second = { system: "http://snomed.info/sct", code: "738991002" };
    expect(medicationInstructionActionCodings({
      ...apply, coding: first, externalCodings: [second]
    })).toEqual([expect.objectContaining(first), expect.objectContaining(second)]);
  });

  it("uses the standard open-wound site and nebulization method in ordinary dosage output", () => {
    const topical = parsePublicSig("Apply 1 g cream to open wounds BID");
    expect(topical.fhir[0].site?.coding).toContainEqual(expect.objectContaining({
      system: "http://snomed.info/sct", code: "59091005"
    }));
    const nebulized = parsePublicSig("Nebulize 2 mL BID");
    expect(nebulized.fhir[0].method?.coding).toContainEqual(expect.objectContaining({
      system: "http://snomed.info/sct", code: "56251003"
    }));
    expect(nebulized.fhir[0].doseAndRate?.[0].doseQuantity).toMatchObject({ value: 2, unit: "mL" });
    expect(nebulized.fhir[0].timing?.repeat).toMatchObject({ frequency: 2, period: 1, periodUnit: "d" });
  });

  it("codes a generic patch as a presentation unit, and explicitly transdermal patches as devices", () => {
    const generic = parseInstructionActions("Remove patch")[0];
    const specialized = parseInstructionActions("Remove transdermal patch")[0];
    expect(generic.args.find(arg => arg.conceptId === "patch")?.coding).toMatchObject({
      system: "http://snomed.info/sct", code: "733005001"
    });
    expect(specialized.args.find(arg => arg.conceptId === "transdermal-patch")?.coding)
      .toMatchObject({ system: "http://snomed.info/sct", code: "466056002" });
    expect(getMedicationInstructionConcept("patch")?.aliases).not.toContain("transdermal patch");
    expect(generic.args.some(arg => arg.coding?.code === "466056002")).toBe(false);
    const restored = parseInstructionGraphExtension([
      buildInstructionGraphExtension({
        sourceText: "Remove transdermal patch", actions: [specialized]
      })!
    ])!;
    expect(restored.actions[0].args.find(arg => arg.conceptId === "transdermal-patch")?.coding)
      .toMatchObject({ system: "http://snomed.info/sct", code: "466056002" });
  });

  it("does not conflate explicitly named ethanol and alcoholic beverages with ambiguous alcohol", () => {
    const beverage = parseInstructionActions("Avoid alcoholic beverages")[0];
    const ethanol = parseInstructionActions("Use ethanol")[0];
    expect(beverage?.args.find(arg => arg.conceptId === "alcoholic-beverage")?.coding)
      .toMatchObject({ system: "http://snomed.info/sct", code: "53527002" });
    expect(ethanol?.args.find(arg => arg.conceptId === "ethanol")?.coding)
      .toMatchObject({ system: "http://snomed.info/sct", code: "419442005" });
    expect(getMedicationInstructionConcept("alcohol")?.coding).toBeUndefined();
  });

  it("does not replace a general hold action with a medication-withholding code", () => {
    const frame = parseInstructionActions("Hold breath for 10 seconds")[0];
    expect(frame.predicate.lemma).toBe("hold");
    expect(frame.predicate.codings?.some(coding => coding.code === "421139008")).toBe(false);
    expect(getMedicationInstructionConcept("patch")?.coding?.code).not.toBe("385114002");
  });

  it.each([
    ["Remove the applicator", "remove", "129303008", "applicator", "408101000"],
    ["Call doctor", "call", "420942008", "doctor", "158965000"],
    ["Measure 1 cm ribbon cream", "measure", "129266000", "cream", "385099005"],
    ["Replace the patch", "replace", "282089006", "patch", "733005001"]
  ])("retains standard action and object codings through the graph wire format: %s",
      (source, verb, actionCode, noun, objectCode) => {
    const graph = parseSig(source).meta.canonical.clauses[0].instructionGraph!;
    const reloaded = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, reloaded]) {
      const action = candidate.actions.find(value => value.predicate.lemma === verb)!;
      expect(action.predicate.codings).toContainEqual(expect.objectContaining({
        system: "http://snomed.info/sct", code: actionCode
      }));
      expect(action.args.find(arg => arg.conceptId === noun)?.coding).toMatchObject({
        system: "http://snomed.info/sct", code: objectCode
      });
    }
    expect(realizeInstructionGraph(reloaded, "en")).toBe(realizeInstructionGraph(graph, "en"));
    expect(realizeInstructionGraph(reloaded, "th")).toBe(realizeInstructionGraph(graph, "th"));
  });
});


describe("continuation directive ownership", () => {
  it.each([
    "If symptoms continue, consult doctor",
    "If symptoms CONTINUE, consult doctor",
    "Consult doctor if symptoms continue",
    "1 tab PO QD; if symptoms continue, consult doctor"
  ])("keeps symptom persistence out of medication actions: %s", source => {
    const frames = parseInstructionActions(source);
    expect(frames.some(frame => frame.predicate.lemma === "continue-treatment")).toBe(false);
    expect(frames.some(frame => frame.predicate.lemma === "consult")).toBe(true);
    const parsed = parsePublicSig(source);
    expect(parsed.longText).not.toContain("continue taking medication");
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it.each(["Continue", "Continue treatment", "Take 1 tab daily; then continue", "Do not continue"])(
    "retains a continuation directive: %s", source => {
      expect(parseInstructionActions(source).some(frame =>
        frame.predicate.lemma === "continue-treatment")).toBe(true);
    }
  );
});


describe("composed instruction concepts", () => {
  it.each([
    ["Drink plenty of water", "plenty-of-water", "11713004", "plenty"],
    ["Replace new patch", "new_patch", "733005001", "new"],
    ["Rinse with clean water", "clean_water", "11713004", "clean"],
    ["Avoid other medications", "other-medications", "763158003", "other"]
  ])("preserves independently coded constituents of %s", (source, concept, headCode, qualifier) => {
    const parsed = parsePublicSig(source);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const arg = graph.actions.flatMap(frame => frame.args).find(value => value.conceptId === concept)!;
    expect(arg).toBeDefined();
    expect(arg.coding).toBeUndefined();
    expect(arg.codings ?? []).toEqual([]);
    expect(arg.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "head", coding: expect.objectContaining({
        system: "http://snomed.info/sct", code: headCode
      }) }),
      expect.objectContaining({ text: qualifier })
    ]));
    expect(buildMedicationInstructionConceptCodeSystem().concept.some(value => value.code === concept)).toBe(false);
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      const restored = parseInstructionGraphExtension(dosage.extension)!;
      const copy = restored.actions.flatMap(frame => frame.args).find(value => value.conceptId === concept)!;
      expect(copy.components).toEqual(JSON.parse(JSON.stringify(arg.components)));
      expect(copy.text).toBe(arg.text);
      expect(realizeInstructionGraph(restored, "en")).toBe(realizeInstructionGraph(graph, "en"));
      expect(realizeInstructionGraph(restored, "th")).toBe(realizeInstructionGraph(graph, "th"));
    }
    if (concept === "plenty-of-water") {
      expect(arg.quantity?.value).toBeUndefined();
      expect(arg.components?.find(value => value.role === "amount")?.coding).toBeUndefined();
    }
  });

  it("reuses internal constituent definitions and preserves an explicitly supplied expression as one coding", () => {
    const first = getInternalInstructionConcept("new_patch")!;
    expect(getInternalInstructionConcept("new_patch")).toBe(first);
    const publicValue = getMedicationInstructionConcept("new_patch");
    expect(publicValue).toEqual(first);
    expect(Object.isFrozen(first)).toBe(false);
    expect(getMedicationInstructionConcept("new_patch")?.components?.[0].coding?.code).toBe("733005001");
    const expression = "22253000:363698007=(78883009:272741003=24028007)";
    const frames = parseInstructionActions("Avoid toe discomfort", 0, {
      instructionConceptMap: {
        "toe discomfort": { code: "toe-discomfort", role: AdviceArgumentRole.Object,
          coding: { system: "http://snomed.info/sct", code: expression },
          components: [{ role: "head", text: "pain", coding: { system: "http://snomed.info/sct", code: "22253000" } }]
        }
      }
    });
    const graph = { sourceText: "Avoid toe discomfort", actions: frames };
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(restored.actions[0].args[0].coding?.code).toBe(expression);
    expect(restored.actions[0].args[0].components?.[0].coding?.code).toBe("22253000");
  });
});


describe("field-matched international medication terminology", () => {
  const edqm = "http://standardterms.edqm.eu";
  it.each([
    ["medication-tablet", "15054000"],
    ["medication-capsule", "15012000"],
    ["patch", "15036000"],
    ["bottle", "30008000"],
    ["applicator", "30002000"],
    ["inhaler", "30026500"]
  ])("preserves standard EDQM equivalence alongside existing SNOMED: %s", (name, code) => {
    const concept = getMedicationInstructionConcept(name)!;
    const codings = medicationInstructionConceptCodings(concept);
    expect(codings[0]?.system).toBe("http://snomed.info/sct");
    expect(codings).toContainEqual(expect.objectContaining({ system: edqm, code }));
    expect(getMedicationInstructionConcept(code, edqm)?.code).toBe(name);
    codings[1]!.code = "edited";
    expect(medicationInstructionConceptCodings(getMedicationInstructionConcept(name)!)[1]?.code).toBe(code);
    expect(buildMedicationInstructionConceptCodeSystem().concept.some(value => value.code === name)).toBe(false);
  });

  it.each([
    ["Use the applicator", "applicator", "30002000"],
    ["Shake the bottle before use", "bottle", "30008000"],
    ["Clean the inhaler", "inhaler", "30026500"],
    ["Replace patch", "patch", "15036000"]
  ])("retains correctly typed EDQM device/unit coding across R5 storage: %s", (source, conceptId, code) => {
    const parsed = parsePublicSig(source);
    const graph = parsed.meta.canonical.clauses[0]?.instructionGraph!;
    const arg = graph.actions.flatMap(action => action.args).find(value => value.conceptId === conceptId);
    expect(arg?.codings).toContainEqual(expect.objectContaining({ system: edqm, code }));
    const reopened = parseInstructionGraphExtension(toFhirR5Dosages(parsed.fhirNext)[0].extension)!;
    const copied = reopened.actions.flatMap(action => action.args).find(value => value.conceptId === conceptId);
    expect(copied?.codings).toContainEqual(expect.objectContaining({ system: edqm, code }));
  });

  it("maps exact eye-drop administration activity as a procedure, not an eye-drop container", () => {
    const concept = getMedicationInstructionConcept("eye_drop_administration")!;
    expect(medicationInstructionConceptCodings(concept)).toEqual([
      expect.objectContaining({ system: "http://snomed.info/sct", code: "225698005" })
    ]);
    expect(concept.role).toBe(AdviceArgumentRole.Activity);
  });
});


describe("HL7 entity handling as exact composed instructions", () => {
  const system = "http://terminology.hl7.org/CodeSystem/v3-EntityHandling";
  it.each([
    "Shake before use",
    "Shake well before use",
    "Shake the bottle before use",
    "เขย่าก่อนใช้"
  ])("codes the actual preparation instruction, not just its verb: %s", source => {
    const parsed = parsePublicSig(source);
    const code = { system, code: "SBU" };
    const dosage = parsed.fhir[0];
    expect(dosage.additionalInstruction).toContainEqual(expect.objectContaining({
      coding: expect.arrayContaining([expect.objectContaining(code)])
    }));
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions.some(action => action.predicate.lemma === "shake" &&
      action.relation === "before" && action.args.some(arg => arg.conceptId === "use"))).toBe(true);
    const saved = toFhirR5Dosages(parsed.fhirNext)[0];
    expect(saved.additionalInstruction).toContainEqual(expect.objectContaining({
      coding: expect.arrayContaining([expect.objectContaining(code)])
    }));
    expect(fromFhirDosage(saved).meta.canonical.clauses[0].additionalInstructions)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ coding: expect.objectContaining(code) })
      ]));
  });
  it("keeps the actual shake timing relation in both output languages", () => {
    const result = parsePublicSig("Shake after use");
    expect(result.meta.canonical.clauses[0].instructionGraph?.actions[0]?.relation).toBe("after");
    expect(result.longText).toContain("Shake after use");
    expect(formatSig(result.fhir[0], "long", { locale: "th" })).toContain("หลังใช้");
  });

  it.each([
    "Shake",
    "Shake after use",
    "Shake before first use",
    "Do not shake",
    "Do not shake before use",
    "Remain upright for 30 minutes",
    "Keep bottle upright"
  ])("does not invent the entity-handling instruction for %s", source => {
    const parsed = parsePublicSig(source);
    expect(parsed.fhir.flatMap(dosage => dosage.additionalInstruction?.flatMap(
      entry => entry.coding ?? []) ?? []).some(coding =>
      coding.system === system && coding.code === "SBU")).toBe(false);
  });
});


describe("HL7 product handling instructions", () => {
  it.each([
    ["protect-from-light", "Protect from light", "PRTL", "Protect from Light", "เก็บให้พ้นแสง"],
    ["store-dry", "Store in a dry place", "DRY", "dry", "เก็บในที่แห้ง"],
    ["store-upright", "Store upright", "UPR", "upright", "เก็บภาชนะในแนวตั้ง"],
    ["refrigerate-4-8", "Refrigerate at 4-8°C", "REF", "Refrigerated temperature", "เก็บที่อุณหภูมิ 4-8 องศาเซลเซียส"]
  ] as const)("keeps HL7 coding.display distinct from the clinician-facing %s action", (
    actionCode, source, code, display, thai
  ) => {
    const definition = getMedicationInstructionAction(actionCode)!;
    expect(definition.display).toBe(source);
    expect(definition.i18n?.th).toBe(thai);
    expect(definition.coding).toMatchObject({
      system: "http://terminology.hl7.org/CodeSystem/v3-EntityHandling", code, display
    });
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses[0]?.instructionGraph?.actions.some(frame =>
      frame.predicate.lemma === actionCode &&
      frame.predicate.codings?.some(coding => coding.system === definition.coding?.system &&
        coding.code === code && coding.display === display)
    )).toBe(true);
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.additionalInstruction?.flatMap(value => value.coding ?? []))
        .toContainEqual(expect.objectContaining({
          system: definition.coding?.system, code, display
        }));
      expect(row.text?.toLowerCase()).toContain(source.toLowerCase());
    }
  });

  it.each([
    ["Do not shake", "PSA", "do not shake", "Do not shake", "ห้ามเขย่า"],
    ["Protect from light", "PRTL", "Protect from Light", "Protect from light", "เก็บให้พ้นแสง"],
    ["Keep in a dry environment", "DRY", "dry", "Store in a dry place", "เก็บในที่แห้ง"],
    ["Keep bottle upright", "UPR", "upright", "Store upright", "เก็บภาชนะในแนวตั้ง"],
    ["Refrigerate at 4-8°C", "REF", "Refrigerated temperature", "Refrigerate at 4-8°C", "เก็บที่อุณหภูมิ 4-8 องศาเซลเซียส"]
  ])("matches the authoritative HL7 EntityHandling Coding.display for %s", (source, code, display, original, thai) => {
    const dosages = parsePublicSig(source).fhir;
    const relevant = dosages.flatMap(row => row.additionalInstruction ?? [])
      .find(instruction => instruction.coding?.some(coding =>
        coding.system === "http://terminology.hl7.org/CodeSystem/v3-EntityHandling" && coding.code === code
      ));
    expect(relevant).toBeDefined();
    expect(relevant?.coding).toContainEqual(expect.objectContaining({ code, display }));
    expect(relevant?.text).toBe(original);
    const definition = adviceRulesSource.rules.find(rule => rule.definition.code === code)?.definition;
    expect(definition?.thai).toBe(thai);
    expect(definition?.text).toBe(original);
  });

  it.each([
    ["Do not shake", "PSA"],
    ["Protect from light", "PRTL"],
    ["Keep in a dry environment", "DRY"],
    ["Keep bottle upright", "UPR"],
    ["Refrigerate at 4-8°C", "REF"]
  ])("preserves the exact handling meaning of %s", (source, code) => {
    const parsed = parsePublicSig(source);
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.additionalInstruction?.some(instruction => instruction.coding?.some(coding =>
        coding.system === "http://terminology.hl7.org/CodeSystem/v3-EntityHandling" && coding.code === code
      ))).toBe(true);
    }
  });

  it("does not turn patient positioning, site care, or a different temperature into product-handling codes", () => {
    for (const source of ["Remain upright after taking", "Keep ear dry", "Refrigerate at 2-8°C", "Shake before use"]) {
      const codes = parsePublicSig(source).fhir.flatMap(row =>
        row.additionalInstruction?.flatMap(instruction => instruction.coding?.map(coding => coding.code) ?? []) ?? []);
      expect(codes.some(code => ["UPR", "DRY", "REF", "PSA"].includes(code ?? ""))).toBe(false);
    }
  });
});


describe("standards-first instruction relationships and event referents", () => {
  it.each([
    [AdviceRelation.With, "421463005"],
    [AdviceRelation.Before, "421718005"],
    [AdviceRelation.During, "421994004"],
    [AdviceRelation.Then, "421067001"],
    [AdviceRelation.Until, "421548005"],
    [AdviceRelation.If, "421803000"],
    [AdviceRelation.When, "420974001"],
    [AdviceRelation.To, "421035004"]
  ])("encodes %s with its exact SNOMED dosing-fragment coding", (kind, code) => {
    const graph = {
      sourceText: "use",
      actions: [{
        force: AdviceForce.Instruction, relation: kind,
        predicate: { lemma: "use" },
        args: [{ role: AdviceArgumentRole.Activity, relation: kind, text: "use" }],
        span: { start: 0, end: 3 }, sourceText: "use"
      }],
      relations: [{ kind, toActionIndex: 0 }]
    };
    const extension = buildInstructionGraphExtension(graph)!;
    const action = extension.extension?.find(child => child.url === "action")!;
    const argument = action.extension?.find(child => child.url === "argument")!;
    const edge = extension.extension?.find(child => child.url === "graphRelation")!;
    for (const [entry, field] of [[action, "relation"], [argument, "relation"], [edge, "kind"]] as const) {
      expect(entry.extension?.find(part => part.url === field + "Coding")?.valueCoding)
        .toMatchObject({ system: "http://snomed.info/sct", code });
      expect(entry.extension?.some(part => part.url === field)).not.toBe(true);
    }
    const reopened = parseInstructionGraphExtension([extension])!;
    expect(reopened.actions[0]?.relation).toBe(kind);
    expect(reopened.actions[0]?.args[0]?.relation).toBe(kind);
    expect(reopened.relations?.[0]?.kind).toBe(kind);
  });

  it("codes broken-skin as a clinical finding component, not an anatomical site structure", () => {
    const concept = getMedicationInstructionConcept("broken-skin")!;
    expect(concept.components?.[0]?.coding).toMatchObject({
      system: "http://snomed.info/sct",
      code: "247442005", display: "Broken skin (disorder)"
    });
    expect(concept.coding).toBeUndefined();
    expect(medicationInstructionConceptCodings(concept)).toEqual([]);
  });

  it.each([AdviceRelation.Before, AdviceRelation.After])(
    "uses HL7 %s only for actual linked actions", (relation) => {
    const action = {
      force: AdviceForce.Instruction, predicate: { lemma: "use" },
      args: [], span: { start: 0, end: 3 }, sourceText: "use"
    };
    const graph = {
      actions: [action, { ...action, span: { start: 10, end: 13 } }],
      relations: [{ kind: relation, fromActionIndex: 0, toActionIndex: 1 }]
    };
    const extension = buildInstructionGraphExtension(graph)!;
    const kind = extension.extension?.find(entry => entry.url === "graphRelation")
      ?.extension?.find(entry => entry.url === "kindCoding")?.valueCoding;
    expect(kind).toMatchObject({
      system: "http://hl7.org/fhir/action-relationship-type", code: relation
    });
    expect(parseInstructionGraphExtension([extension])?.relations).toEqual(
      graph.relations.map(entry => ({ ...entry, sourceKindCoding: kind }))
    );

    const independent = buildInstructionGraphExtension({
      actions: [{ ...action, relation }]
    })!;
    const embedded = independent.extension?.find(entry => entry.url === "action");
    if (relation === AdviceRelation.Before) {
      expect(embedded?.extension?.find(entry => entry.url === "relationCoding")?.valueCoding)
        .toMatchObject({ system: "http://snomed.info/sct", code: "421718005" });
    } else {
      expect(embedded?.extension?.find(entry => entry.url === "relationCoding")?.valueCoding)
        .toMatchObject({ system: "http://snomed.info/sct", code: "255234002" });
    }
  });

  it("keeps non-equivalent English relations as typed local structures", () => {
    const extension = buildInstructionGraphExtension({
      actions: [{ force: AdviceForce.Instruction, relation: AdviceRelation.Unless,
        predicate: { lemma: "hold" }, args: [], span: { start: 0, end: 4 }, sourceText: "hold" }]
    })!;
    const relation = extension.extension?.find(child => child.url === "action")
      ?.extension?.find(child => child.url === "relation");
    expect(relation?.valueCode).toBe("unless");
    expect(parseInstructionGraphExtension([extension])?.actions[0]?.relation)
      .toBe(AdviceRelation.Unless);
  });

  it.each([
    ["each-dose", 2], ["each-injection", 2], ["each-use", 2],
    ["each-administration", 2], ["first-use", 2],
    ["after-first-administration", 2], ["before_first_use", 3]
  ] as const)(
    "persists compositional SNOMED qualifiers instead of a made-up whole-phrase coding for %s",
    (conceptId, componentCount) => {
      const concept = getMedicationInstructionConcept(conceptId)!;
      expect(concept.components?.length).toBe(componentCount);
      expect(concept.components?.every(part => part.coding?.system === "http://snomed.info/sct"))
        .toBe(true);
      expect(medicationInstructionConceptCodings(concept)).toEqual([]);
      const graph = {
        actions: [{
          force: AdviceForce.Instruction, predicate: { lemma: "use" },
          args: [{ role: AdviceArgumentRole.Activity, text: concept.display,
            conceptId, components: concept.components }],
          span: { start: 0, end: 3 }, sourceText: "use"
        }]
      };
      const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
      expect(restored.actions[0]?.args[0]?.components).toEqual(concept.components);
    }
  );
});


describe("preserve complete local codes alongside standard constituents", () => {
  it("keeps a full bottle-tip coding and its standard-coded head through strict R5", () => {
    const parsed = parsePublicSig("Wipe bottle tip after each use");
    const original = parsed.items[0].meta.canonical.clauses[0]?.instructionGraph?.actions[0]!;
    const restored = fromFhirDosage(toFhirR5Dosages(parsed.fhirNext)[0])
      .meta.normalized.instructionGraph?.actions[0]!;
    for (const action of [original, restored]) {
      expect(action.predicate.codings).toContainEqual(expect.objectContaining({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action",
        code: "wipe"
      }));
      const tip = action.args.find(arg => arg.conceptId === "bottle-tip")!;
      expect(tip.coding).toMatchObject({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-concept",
        code: "bottle-tip"
      });
      expect(tip.components?.[0].coding).toMatchObject({
        system: "http://snomed.info/sct", code: "68276009"
      });
    }
    expect(buildMedicationInstructionConceptCodeSystem().concept)
      .toContainEqual(expect.objectContaining({ code: "bottle-tip" }));
  });

  it("keeps the coded swallowed-whole instruction even with accompanying water", () => {
    const parsed = parsePublicSig("Do not chew the capsule. Swallow whole with water.");
    for (const dosage of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(dosage.additionalInstruction?.flatMap(row => row.coding?.map(c => c.code) ?? []))
        .toContain("418693002");
    }
  });
});


describe("authoritative occlusive topical route and complete technique", () => {
  it("adds the whole technique while retaining route, method, dressing, and local action codings", () => {
    const parsed = parsePublicSig("Apply ointment then cover with occlusive dressing");
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.route?.coding).toEqual(expect.arrayContaining([
        expect.objectContaining({ system: "http://snomed.info/sct", code: "6064005" }),
        expect.objectContaining({ system: "http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration",
          code: "OCDRESTA" })
      ]));
      expect(row.method?.coding).toEqual(expect.arrayContaining([
        expect.objectContaining({ system: "http://snomed.info/sct", code: "738991002" }),
        expect.objectContaining({ system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl",
          code: "C38286" }),
        expect.objectContaining({ system: "http://snomed.info/sct",
          code: "447056002" })
      ]));
      const action = fromFhirDosage(row).meta.normalized.instructionGraph?.actions
        .find(item => item.predicate.lemma === "cover");
      expect(action?.predicate.codings).toContainEqual(expect.objectContaining({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action", code: "cover"
      }));
      const dressing = action?.args.find(arg => arg.conceptId === "occlusive_dressing");
      expect(dressing?.codings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          system: "urn:ezmedicationinput:CodeSystem:medication-instruction-concept",
          code: "occlusive_dressing"
        }),
        expect.objectContaining({ system: "https://www.nlm.nih.gov/mesh", code: "D009779" })
      ]));
      expect(dressing?.components?.[0]?.coding?.code).toBe("333453004");
    }
    for (const source of [
      "Do not cover ointment with occlusive dressing",
      "Take 1 tablet and cover with occlusive dressing"
    ]) {
      const dosage = parsePublicSig(source).fhir[0];
      expect(dosage.route?.coding?.some(c => c.code === "OCDRESTA")).not.toBe(true);
      expect(dosage.method?.coding?.some(c => c.code === "C38286")).not.toBe(true);
    }
  });
});

describe("standard coded oromucosal swish-and-swallow technique", () => {
  it("adds the complete liquid technique without changing the original swallow method", () => {
    const parsed = parsePublicSig("Swish 10 mL nystatin then swallow");
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.route?.coding).toEqual(expect.arrayContaining([
        expect.objectContaining({ system: "http://snomed.info/sct", code: "26643006" }),
        expect.objectContaining({
          system: "http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration",
          code: "SWISHSWAL"
        }),
        expect.objectContaining({
          system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl",
          code: "C38303"
        })
      ]));
      expect(row.method?.coding).toContainEqual(
        expect.objectContaining({ system: "http://snomed.info/sct", code: "738995006" })
      );
      expect(row.doseAndRate?.[0]?.doseQuantity?.value).toBe(10);
      expect(fromFhirDosage(row).meta.normalized.instructionGraph?.actions
        .map(action => action.predicate.lemma)).toEqual(["swish", "swallow"]);
    }
    for (const source of [
      "Swish 5mL and swallow the tablet",
      "Take 1 tablet then swish 5mL and swallow",
      "Swish 5mL then spit and swallow",
      "Swish 5mL then spit"
    ]) {
      expect(parsePublicSig(source).fhir[0]?.route?.coding
        ?.some(coding => coding.code === "SWISHSWAL")).not.toBe(true);
    }
  });
});

describe("standard coded oromucosal swish-and-spit technique", () => {
  it("preserves both technique codes and the typed local instructions, excluding swallow or negated actions", () => {
    const parsed = parsePublicSig("Swish 10 mL for 30 seconds and spit out");
    for (const row of [parsed.fhir[0], toFhirR5Dosages(parsed.fhirNext)[0]]) {
      expect(row.route?.coding).toEqual(expect.arrayContaining([
        expect.objectContaining({
          system: "http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration",
          code: "SWISHSPIT"
        }),
        expect.objectContaining({
          system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl",
          code: "C38302"
        })
      ]));
      const actions = fromFhirDosage(row).meta.normalized.instructionGraph?.actions;
      expect(actions?.map(action => action.predicate.lemma)).toEqual(["swish", "spit"]);
      expect(actions?.find(action => action.predicate.lemma === "spit")
        ?.predicate.codings).toContainEqual(expect.objectContaining({
          system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action",
          code: "spit"
        }));
    }
    for (const source of ["swish 10mL then swallow", "Gargle 10 mL then spit",
      "Do not swish and spit",
      "Take 1 tablet and swish 5 mL mouthwash then spit",
      "Apply 5 mL lotion then swish and spit"]) {
      const route = parsePublicSig(source).fhir[0]?.route;
      expect(route?.coding?.some(coding => coding.code === "SWISHSPIT")).not.toBe(true);
    }
  });
});


describe("qualified quantities keep their meaning in action graph realization", () => {
  it.each([
    ["approximately ", "~", "approximately ", "ประมาณ "],
    ["at least ", ">=", "at least ", "อย่างน้อย "],
    ["at most ", "<=", "at most ", "ไม่เกิน "],
    ["more than ", ">", "more than ", "มากกว่า "],
    ["less than ", "<", "less than ", "น้อยกว่า "],
    ["~", "~", "approximately ", "ประมาณ "],
    [">=", ">=", "at least ", "อย่างน้อย "],
    ["<=", "<=", "at most ", "ไม่เกิน "]
  ] as const)("retains %s on the primary rich amount through source, graph and FHIR", (prefix, comparator, en, th) => {
    const source = `squeeze ${prefix}1 cm ribbon cream onto each spot`;
    for (const [locale, expected] of [["en", en], ["th", th]] as const) {
      const parsed = parsePublicSig(source, { locale });
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toMatchObject({ value: 1, unit: "cm ribbon", comparator });
      const graph = clause.instructionGraph!;
      const action = graph.actions.find(value => value.predicate.lemma === "squeeze")!;
      const quantity = action.args.find(value => value.role === AdviceArgumentRole.Amount)?.quantity;
      expect(quantity).toMatchObject({ value: 1, unit: "cm ribbon", comparator });
      const qualifiedAmount = expected + (locale === "th" ? "1 ซม." : "1 cm ribbon");
      expect(parsed.longText).toContain(qualifiedAmount);
      expect(parsed.longText).toContain(locale === "th" ? "ครีม" : "cream");
      expect(parsed.longText).toContain(locale === "th" ? "จุดที่มีอาการ" : "spot");
      expect(clause.rawText).toBe(source);
      const extension = buildInstructionGraphExtension(graph)!;
      expect(JSON.stringify(extension)).toContain("http://ema.europa.eu/fhir/extension/comparator");
      const restored = parseInstructionGraphExtension([JSON.parse(JSON.stringify(extension))])!;
      expect(restored.actions.find(value => value.predicate.lemma === "squeeze")?.args
        .find(value => value.role === AdviceArgumentRole.Amount)?.quantity?.comparator).toBe(comparator);
      expect(realizeInstructionAction(restored.actions.find(value => value.predicate.lemma === "squeeze")!, locale))
        .toContain(qualifiedAmount);
      expect(fromFhirDosage(parsed.fhir[0], { locale }).longText).toContain(qualifiedAmount);
    }
  });

  it("retains qualifiers on dose-defining action arguments and does not confuse AT MOST with a location", () => {
    for (const [prefix, comparator, expected] of [
      ["approximately ", "~", "ประมาณ "],
      ["at most ", "<=", "ไม่เกิน "],
      [">=", ">=", "อย่างน้อย "]
    ] as const) {
      const source = `Dissolve ${prefix}2 tablets in water`;
      const parsed = parsePublicSig(source, { locale: "th" });
      expect(parsed.meta.canonical.clauses[0].dose).toMatchObject({ value: 2, unit: "tab", comparator });
      expect(parsed.longText).toContain(`${expected}2`);
      expect(parsed.longText).toContain("น้ำ");
      expect(getQuantityComparator(parsed.fhirNext.step[0].component[0].doseAndRate?.[0].doseQuantity)).toBe(comparator);
    }
  });

  it.each([
    { comparator: "~" as const }, { comparator: "<=" as const },
    { value: 2 }, { unit: "g" }, { range: { low: 1, high: 2 } }
  ])("does not replay a stale graph quantity over the canonical edit %j", (edit) => {
    const parsed = parsePublicSig("squeeze 1 cm ribbon cream onto each spot");
    const clause = structuredClone(parsed.meta.canonical.clauses[0]);
    const graph = clause.instructionGraph!;
    // A structured saved graph may declare its primary span. Both selectors
    // must honor canonical editing, regardless of which display mode is used.
    graph.primaryAdministrationSpan = { ...graph.actions[0].span };
    expect(instructionGraphRichPrimaryAction(clause)).toBeDefined();
    expect(instructionGraphRoundTripPrimaryAction(clause)).toBeDefined();
    const source = JSON.stringify(graph);
    const edited = { ...clause, dose: { ...clause.dose!, ...edit } };
    // Raw source replay is disallowed, but the selected rich event still owns
    // its material and target when its display copy uses the edited quantity.
    const rich = instructionGraphRichPrimaryAction(edited)!;
    expect(rich).toBe(graph.actions[0]);
    expect(instructionGraphRoundTripPrimaryAction(edited)).toBeUndefined();
    const current = realizeRichPrimaryWithCanonicalDose(rich, edited, "en");
    expect(current).toContain("cream");
    expect(current).toContain("each spot");
    if ("value" in edit) expect(current).toMatch(/^Squeeze 2 cm /u);
    if ("unit" in edit) expect(current).toMatch(/^Squeeze 1 g /u);
    if ("range" in edit) expect(current).toMatch(/^Squeeze 1-2 cm /u);
    expect(JSON.stringify(graph)).toBe(source);
    if ("comparator" in edit) {
      const roundtrip = formatCanonicalClause(edited, "long", { locale: "en" }, {
        realizationMode: "roundtrip"
      });
      expect(roundtrip).toContain(edit.comparator === "~" ? "approximately 1" : "at most 1");
      expect(roundtrip).toContain("cream");
      expect(roundtrip).toContain("each spot");
      expect(roundtrip).not.toContain("Squeeze 1 cm ribbon");
      const thai = formatCanonicalClause(edited, "long", resolveSigLocalization("th"), {
        realizationMode: "roundtrip"
      });
      expect(thai).toContain(edit.comparator === "~" ? "ประมาณ 1" : "ไม่เกิน 1");
      expect(thai).toContain("ครีม");
      expect(thai).not.toContain("บีบครีม 1 ซม.");
      expect(JSON.stringify(graph)).toBe(source);
    }
    // The retained graph still owns its original source dose.
    expect(graph.actions[0].args.find(value =>
      value.role === AdviceArgumentRole.Amount)?.quantity?.value).toBe(1);
  });
});


describe("source-owned action amounts remain editable across the whole graph", () => {
  it.each([
    ["Dissolve 2 tablets in water and drink 5 mL", 3, ["water", "drink 5 mL"], ["2 tablets"]],
    ["Take 1 tablet of amoxicillin, drink 5 mL", 2, ["amoxicillin", "drink 5 mL"], ["1 tablet"]],
    ["Take 1 tablet, then take 2 tablets", 2, ["take 2 tablets"], ["Take 1 tablet"]],
    ["Dissolve 2 tablets in water, stir, then drink", 3, ["water", "stir", "drink"], ["2 tablets"]]
  ] as const)(
    "replaces only the primary dose without erasing independent actions: %s",
    (source, editedDose, retained, removed) => {
      const graph = { sourceText: source, sourceLocale: "en",
        actions: parseInstructionActions(source) };
      expect(graph.actions.length).toBeGreaterThan(1);
      const clause = structuredClone(parsePublicSig("Take 1 tablet").meta.canonical.clauses[0]);
      clause.dose = { value: editedDose, unit: "tab" };
      const snapshot = JSON.stringify(graph);
      expect(instructionGraphSourceConflictsWithDose({ ...clause, instructionGraph: graph })).toBe(true);
      for (const locale of ["en", "th"]) for (const mode of [false, true]) {
        const text = realizeInstructionGraph(graph, locale, {
          omitCanonicalAdministration: clause,
          preferSourceText: mode, roundtripSafe: mode
        })!;
        for (const phrase of retained) {
          if (locale === "en") expect(text.toLowerCase()).toContain(phrase.toLowerCase());
          else {
            const expected: Record<string, RegExp> = {
              water: /น้ำ/, "drink 5 mL": /ดื่ม\s*5\s*มิลลิลิตร/,
              amoxicillin: /amoxicillin/, "take 2 tablets": /รับประทาน\s*2\s*เม็ด/,
              stir: /คน/, drink: /ดื่ม/
            };
            expect(text).toMatch(expected[phrase]);
          }
        }
        if (source.startsWith("Dissolve"))
          expect(text.toLowerCase()).toContain(locale === "en" ? "dissolve" : "ละลาย");
        for (const phrase of removed) {
          expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
          const oldDose = /\b(\d+) tablets?\b/iu.exec(phrase)?.[1];
          if (locale === "th" && oldDose)
            expect(text).not.toMatch(new RegExp("(?:^|[^0-9.,+-])" + oldDose + "\\s*เม็ด", "u"));
        }
      }
      expect(JSON.stringify(graph)).toBe(snapshot);
      // The later, independently authored amount remains in its source graph.
      if (source.includes("5 mL")) expect(graph.actions.at(-1)?.args.some(arg =>
        arg.role === AdviceArgumentRole.Amount && arg.quantity?.value === 5)).toBe(true);
    }
  );

  it("does not confuse a later identical-unit amount with an edited primary amount", () => {
    const source = "Take 1 tablet, then take 2 tablets";
    const actions = parseInstructionActions(source);
    const clause = { ...parsePublicSig("Take 2 tablets").meta.canonical.clauses[0] };
    clause.dose = { value: 2, unit: "tab" };
    const graph = { sourceText: source, sourceLocale: "en", actions };
    const text = realizeInstructionGraph(graph, "en", {
      omitCanonicalAdministration: clause, preferSourceText: true
    })!;
    expect(text).not.toContain("Take 1 tablet");
    expect(text).toContain("take 2 tablets");
    expect(instructionGraphSourceConflictsWithDose({
      ...clause, instructionGraph: graph
    })).toBe(true);
    // An explicit primary span may instead identify the later action.
    const last = actions[1];
    graph.actions = actions;
    const targeted = { ...graph, primaryAdministrationSpan: { ...last.span } };
    const editedClause = { ...clause, dose: { value: 3, unit: "tab" } };
    const selected = realizeInstructionGraph(targeted, "en", {
      omitCanonicalAdministration: editedClause
    })!;
    expect(selected).toContain("Take 1 tablet");
    expect(selected).not.toMatch(/take 2 tablets/iu);
  });

  it("does not treat a later independent dose as a mismatch when the primary is unchanged", () => {
    const source = "Take 1 tablet, then drink 5 mL";
    const graph = { sourceText: source, sourceLocale: "en",
      actions: parseInstructionActions(source) };
    const clause = parsePublicSig("Take 1 tablet").meta.canonical.clauses[0];
    expect(instructionGraphSourceConflictsWithDose({
      ...clause, instructionGraph: graph
    })).toBe(false);
    const text = realizeInstructionGraph(graph, "en", {
      omitCanonicalAdministration: clause, preferSourceText: true
    })!;
    expect(text).toContain("drink 5 mL");
  });

  it("retains an untranslated drug name without reviving a superseded dose in Thai", () => {
    const source = "Take 1 tablet of amoxicillin, drink 5 mL";
    const graph = { sourceText: source, sourceLocale: "en",
      actions: parseInstructionActions(source) };
    const clause = parsePublicSig("Take 2 tablets").meta.canonical.clauses[0];
    const original = JSON.stringify(graph);
    const text = realizeInstructionGraph(graph, "th", {
      omitCanonicalAdministration: clause, preferSourceText: true
    })!;
    expect(text).toContain("amoxicillin");
    expect(text).not.toContain("1 tablet");
    expect(text).toContain("5");
    expect(JSON.stringify(graph)).toBe(original);
  });
});

describe("adversarial independent graph quantity and dose-owner edits", () => {
  it.each([
    ["Dissolve 2 tablets in 100 mL water, wait 5 minutes, then drink",
      3, "tab", ["100 mL", "5 minutes", "water"], ["2 tablets"]],
    ["Dissolve 2 tablets in 100 mL solvent",
      3, "tab", ["100 mL", "solvent"], ["2 tablets"]],
    ["Swish 10 mL for 5 minutes",
      11, "mL", ["5 minutes"], ["10 mL"]],
    ["Take 1 tablet, then drink 5 mL",
      3, "mL", ["drink 5 mL"], ["1 tablet"]],
    ["Take 1 tablet, then take 2 tablets",
      3, "tab", ["take 2 tablets"], ["Take 1 tablet"]]
  ] as const)("preserves separately quantified arguments after editing the primary amount: %s",
    (source, amount, unit, retained, removed) => {
      const parsed = parsePublicSig(source);
      const clause = { ...parsed.meta.canonical.clauses[0] };
      const graph = clause.instructionGraph?.actions.length
        ? clause.instructionGraph
        : { sourceText: source, sourceLocale: "en",
          actions: parseInstructionActions(source) };
      const saved = JSON.stringify(graph);
      clause.dose = { value: amount, unit };
      const editedPublic = source.startsWith("Dissolve") ? JSON.parse(JSON.stringify(parsed.fhirNext)) : undefined;
      if (editedPublic) editedPublic.step[0].component[0].doseAndRate[0].doseQuantity.value = amount;
      for (const locale of ["en", "th"] as const) {
        const rendered = realizeInstructionGraph(graph, locale, {
          omitCanonicalAdministration: clause, preferSourceText: true
        }) ?? "";
        const long = formatCanonicalClause({ ...clause, instructionGraph: graph },
          "long", resolveSigLocalization(locale), {
            realizationMode: "roundtrip"
          });
        for (const remove of removed) {
          expect(rendered.toLowerCase()).not.toContain(remove.toLowerCase());
          expect(long.toLowerCase()).not.toContain(remove.toLowerCase());
        }
        for (const item of retained) if (locale === "en") {
          expect(rendered.toLowerCase()).toContain(item.toLowerCase());
          expect(long.toLowerCase()).toContain(item.toLowerCase());
        }
        if (locale === "th") {
          if (source.includes("100 mL water")) {
            expect(rendered).toContain("100 มิลลิลิตร");
            expect(long).toContain("100 มิลลิลิตร");
          } else if (source.includes("100 mL")) {
            expect(rendered).toMatch(/100 (?:mL|มิลลิลิตร)/u);
            expect(long).toMatch(/100 (?:mL|มิลลิลิตร)/u);
          }
          if (source.includes("5 minutes")) {
            expect(rendered).toContain("5 นาที");
            expect(long).toContain("5 นาที");
          }
        }
        if (source.startsWith("Dissolve")) {
          expect(long).toContain(locale === "en" ? "Dissolve 3 tablets" : "ละลาย3 เม็ด");
          const expected = source.includes("water")
            ? locale === "en"
              ? "Dissolve 3 tablets in 100 mL water; then wait 5 minutes. Drink the medication orally."
              : "ละลาย3 เม็ดในน้ำ 100 มิลลิลิตร จากนั้นรอ 5 นาที. ดื่ม."
            : locale === "en" ? "Dissolve 3 tablets in 100 mL solvent." : "ละลาย3 เม็ดในsolvent 100 มิลลิลิตร.";
          const originalPublic = JSON.stringify(editedPublic);
          expect(formatSig(editedPublic, "long", { locale, realizationMode: "roundtrip" })).toBe(expected);
          expect(JSON.stringify(editedPublic)).toBe(originalPublic);
        } else expect(long).toContain(String(amount));
        if (source === "Take 1 tablet, then drink 5 mL") {
          expect(long).toMatch(locale === "en" ? /Take 3 mL/u : /(?:รับประทาน|ใช้ยา) 3 มิลลิลิตร/u);
          expect(long).toContain(locale === "en" ? "5 mL" : "5 มิลลิลิตร");
        }
      }
      expect(JSON.stringify(graph)).toBe(saved);
      // An independent mixing Substance/Duration never inherits the
      // changed tablet dose or loses its original numeric quantity.
      if (source.includes("100 mL")) expect(graph.actions.some(action =>
        action.args.some(arg => arg.quantity?.value === 100))).toBe(true);
      if (source.includes("5 minutes")) expect(graph.actions.some(action =>
        action.args.some(arg => arg.quantity?.value === 5 &&
          arg.role === AdviceArgumentRole.Duration))).toBe(true);
    }
  );

  it("preserves the dose-defining preparation when the primary administration span is a later verb", () => {
    const source = "Dissolve 2 tablets in 100 mL water, wait 5 minutes, then drink";
    const parsed = parsePublicSig(source);
    const clause = structuredClone(parsed.meta.canonical.clauses[0]);
    const graph = clause.instructionGraph!;
    expect(graph.primaryAdministrationSpan).toMatchObject({ start: 57, end: 62 });
    const original = JSON.stringify(graph);
    clause.dose = { value: 3, unit: "tab" };
    for (const locale of ["en", "th"] as const) {
      const display = formatCanonicalClause(clause, "long",
        resolveSigLocalization(locale), { realizationMode: "roundtrip" });
      expect(display).toContain(locale === "en" ? "Dissolve 3 tablets" : "ละลาย3 เม็ด");
      expect(display).not.toContain("2 tablets");
      expect(display).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
      expect(display).toContain(locale === "en" ? "5 minutes" : "5 นาที");
    }
    expect(JSON.stringify(graph)).toBe(original);
  });

  it("does not assign an edited unit to a later independent matching-unit action", () => {
    const source = "Take 1 tablet, then drink 5 mL";
    const graph = { sourceText: source, sourceLocale: "en",
      actions: parseInstructionActions(source) };
    const clause = { ...parsePublicSig("Take 3 mL").meta.canonical.clauses[0] };
    clause.dose = { value: 3, unit: "mL" };
    const unchanged = JSON.stringify(graph);
    const text = realizeInstructionGraph(graph, "en", {
      omitCanonicalAdministration: clause, preferSourceText: true
    });
    expect(text).not.toContain("1 tablet");
    expect(text).toContain("drink 5 mL");
    expect(JSON.stringify(graph)).toBe(unchanged);
  });
});

describe("review 17: original action ownership and source quantity mirrors", () => {
  it("removes a superseded Theme quantity, not its medication name or independent mixing volume", () => {
    const source = "Dissolve 2 tablets of amoxicillin in 100 mL water";
    const parsed = parsePublicSig(source);
    const clause = { ...parsed.meta.canonical.clauses[0] };
    const graph = clause.instructionGraph!;
    const sourceGraph = JSON.stringify(graph);
    const original = graph.actions[0];
    expect(original.args.some(arg => arg.role === AdviceArgumentRole.Theme &&
      arg.quantity?.value === 2 && arg.text?.includes("amoxicillin"))).toBe(true);
    expect(original.args.some(arg => arg.role === AdviceArgumentRole.Substance &&
      arg.quantity?.value === 100)).toBe(true);
    clause.dose = { value: 3, unit: "tab" };
    for (const locale of ["en", "th"]) {
      const realized = realizeInstructionGraph(graph, locale, {
        omitCanonicalAdministration: clause, preferSourceText: true
      })!;
      expect(realized).toContain("amoxicillin");
      expect(realized).not.toContain("2 tablets");
      expect(realized).not.toContain("2 เม็ด");
      expect(realized).toContain("100");
      const formatted = formatCanonicalClause(clause, "long",
        resolveSigLocalization(locale), { realizationMode: "roundtrip" });
      expect(formatted).toContain("3");
      expect(formatted).not.toContain("2 tablets");
      expect(formatted).toContain("amoxicillin");
      expect(formatted).toContain("100");
    }
    expect(JSON.stringify(graph)).toBe(sourceGraph);
  });

  it("retains the original dose action when both method and unit are edited on a spanless graph", () => {
    const source = "Take 1 tablet, then drink 100 mL water";
    const graph = { sourceText: source, sourceLocale: "en",
      actions: parseInstructionActions(source) };
    expect(graph.actions).toHaveLength(2);
    const saved = JSON.stringify(graph);
    const clause = { ...parsePublicSig("Take 1 tablet").meta.canonical.clauses[0] };
    const changed = parsePublicSig("Drink 5 mL").meta.canonical.clauses[0];
    clause.dose = changed.dose;
    clause.method = changed.method;
    for (const locale of ["en", "th"]) {
      const display = realizeInstructionGraph(graph, locale, {
        omitCanonicalAdministration: clause, preferSourceText: true
      })!;
      expect(display).not.toContain("1 tablet");
      expect(display).toContain("100");
      const complete = formatCanonicalClause({
        ...clause, instructionGraph: graph
      }, "long", resolveSigLocalization(locale), {
        realizationMode: "roundtrip"
      });
      expect(complete).not.toContain("1 tablet");
      expect(complete).toContain("5");
      expect(complete).toContain("100");
    }
    expect(JSON.stringify(graph)).toBe(saved);
    expect(graph.actions[1].args.some(arg =>
      arg.role === AdviceArgumentRole.Amount && arg.quantity?.value === 100)).toBe(true);
  });
});


describe("review 18: comparator-only graph quantities remain editable", () => {
  it.each(["~", "<", "<=", ">", ">="] as const)(
    "round-trips a partial source-backed %s Quantity without inventing a number",
    comparator => {
      const parsed = parsePublicSig("Dissolve 2 tablets in water, then drink");
      const sourceGraph = parsed.meta.canonical.clauses[0].instructionGraph!;
      const before = JSON.stringify(sourceGraph);
      const graph = JSON.parse(before) as typeof sourceGraph;
      const action = graph.actions.find(value => value.predicate.lemma === "dissolve")!;
      const amount = action.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
      const sourceText = graph.sourceText;
      const text = amount.text;
      amount.quantity = { comparator };
      const encoded = buildInstructionGraphExtension(graph)!;
      const reimported = parseInstructionGraphExtension([encoded])!;
      const restored = reimported.actions.find(value =>
        value.predicate.lemma === "dissolve")!.args.find(arg =>
        arg.role === AdviceArgumentRole.Amount)!;
      expect(restored.quantity).toEqual({ comparator });
      expect(restored.quantity?.value).toBeUndefined();
      expect(restored.text).toBe(text);
      expect(reimported.sourceText).toBe(sourceText);
      expect(parseInstructionGraphExtension([JSON.parse(JSON.stringify(encoded))])
        ?.actions.find(value => value.predicate.lemma === "dissolve")
        ?.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
        .toEqual({ comparator });
      expect(JSON.stringify(sourceGraph)).toBe(before);
    }
  );

  it("does not drop a known qualifier when an amount has a partial unit but no value", () => {
    const sourceGraph = parsePublicSig("Dissolve 2 tablets in water, then drink")
      .meta.canonical.clauses[0].instructionGraph!;
    const before = JSON.stringify(sourceGraph);
    const graph = JSON.parse(before) as typeof sourceGraph;
    const amount = graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    amount.quantity = { unit: "mg", comparator: "~" };
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(restored.actions[0].args.find(arg =>
      arg.role === AdviceArgumentRole.Amount)?.quantity).toEqual({
        unit: "mg", comparator: "~"
      });
    expect(restored.sourceText).toBe(graph.sourceText);
    expect(JSON.stringify(sourceGraph)).toBe(before);
  });
});

describe("review 20: edited canonical administration cannot steal an independent action", () => {
  it("retains a later source-backed Drink 5 mL when a prior Take 1 tablet is edited to Drink 5 mL", () => {
    const original = "Take 1 tablet, then drink 5 mL";
    const graph = { sourceText: original, sourceLocale: "en",
      actions: parseInstructionActions(original) };
    const unchanged = JSON.stringify(graph);
    const edited = parsePublicSig("Drink 5 mL").meta.canonical.clauses[0];
    expect(edited.dose).toMatchObject({ value: 5, unit: "mL" });
    for (const locale of ["en", "th"]) {
      const display = realizeInstructionGraph(graph, locale, {
        omitCanonicalAdministration: edited, preferSourceText: true
      })!;
      expect(display).toContain("5");
      if (locale === "en") expect(display).toContain("drink 5 mL");
      else expect(display).toContain("ดื่ม");
      expect(display).not.toContain("1 tablet");
      const whole = formatCanonicalClause({
        ...edited, instructionGraph: graph
      }, "long", resolveSigLocalization(locale), {
        realizationMode: "roundtrip"
      });
      const administrations = locale === "en"
        ? whole.match(/drink\s*5\s*mL/giu)
        : whole.match(/ดื่ม\s*5\s*มิลลิลิตร/gu);
      expect(administrations).toHaveLength(2);
      expect(whole).not.toContain("1 tablet");
    }
    expect(JSON.stringify(graph)).toBe(unchanged);
    expect(graph.actions[1].args.some(arg => arg.role === AdviceArgumentRole.Amount &&
      arg.quantity?.value === 5 && arg.quantity?.unit === "mL")).toBe(true);
  });

  it("still omits the true original canonical primary, not an unrelated later dose", () => {
    const original = "Take 1 tablet, then drink 5 mL";
    const graph = { sourceText: original, sourceLocale: "en",
      actions: parseInstructionActions(original) };
    const clause = parsePublicSig("Take 1 tablet").meta.canonical.clauses[0];
    const text = realizeInstructionGraph(graph, "en", {
      omitCanonicalAdministration: clause, preferSourceText: true
    })!;
    expect(text).not.toContain("Take 1 tablet");
    expect(text).toContain("drink 5 mL");

    // An explicit source primary span can identify that the Drink action
    // really was the canonical administration. In that case, only THAT
    // source-backed action is eligible for omission.
    const targeted = {
      ...graph, primaryAdministrationSpan: { ...graph.actions[1].span }
    };
    const drink = parsePublicSig("Drink 5 mL").meta.canonical.clauses[0];
    const realized = realizeInstructionGraph(targeted, "en", {
      omitCanonicalAdministration: drink, preferSourceText: true
    })!;
    expect(realized).toContain("Take 1 tablet");
    expect(realized).not.toContain("drink 5 mL");
    expect(JSON.stringify(graph)).toContain("drink 5 mL");
  });
});


describe("November 16 explicit primary action owner", () => {
  it("omits the selected second administration with unchanged canonical dose", () => {
    const source = "Take 1 tablet, then take 2 tablets";
    const actions = parseInstructionActions(source);
    const clause = parsePublicSig("Take 2 tablets").meta.canonical.clauses[0];
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...actions[1].span } };
    const snapshot = JSON.stringify(graph);
    for (const preferSourceText of [false, true]) {
      const text = realizeInstructionGraph(graph, "en", {
        omitCanonicalAdministration: clause, preferSourceText
      }) ?? "";
      expect(text).toContain("Take 1 tablet");
      expect(text.toLowerCase()).not.toContain("take 2 tablets");
    }
    const whole = formatCanonicalClause({ ...clause, instructionGraph: graph },
      "long", resolveSigLocalization("en"), { realizationMode: "roundtrip" });
    expect(whole.toLowerCase().match(/take 2 tablets/g)).toHaveLength(1);
    expect(whole.toLowerCase()).toContain("take 1 tablet");
    expect(JSON.stringify(graph)).toBe(snapshot);
  });
});


describe("November 16 rich amountless primary remains dose-editable", () => {
  it("retains an edited canonical dose beside an amountless rich Drink action in EN/TH", () => {
    const source = "Dissolve 2 tablets in water, then drink slowly";
    const actions = parseInstructionActions(source);
    const drink = actions.find(action => action.predicate.lemma === "drink")!;
    drink.args = [{ role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" }];
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...drink.span } };
    const clause = { ...parsePublicSig("Drink 2 tablets").meta.canonical.clauses[0] };
    clause.dose = { value: 3, unit: "tab" };
    clause.instructionGraph = graph;
    expect(instructionGraphRichPrimaryAction(clause)).toBeDefined();
    const original = JSON.stringify(graph);
    for (const locale of ["en", "th"] as const) {
      const text = formatCanonicalClause(clause, "long", resolveSigLocalization(locale));
      expect(text).toContain("3");
      if (locale === "en") expect(text.toLowerCase()).toContain("slowly");
      else expect(text).toContain("เม็ด");
      expect(text).not.toContain("2 tablets");
    }
    expect(JSON.stringify(graph)).toBe(original);
  });
});


describe("review 2026-11-16 19h: incomplete graph quantities do not invent amounts", () => {
  it.each(["en", "th"] as const)(
    "uses recognizable source argument text for a comparator-only quantity in %s", locale => {
      const graph = parseInstructionActions("Dissolve 2 tablets in water, then drink slowly");
      const frame = structuredClone(graph.find(a => a.predicate.lemma === "dissolve")!);
      const amount = frame.args.find(a => a.role === AdviceArgumentRole.Amount)!;
      amount.quantity = { comparator: "<=", unit: "mg" };
      const original = JSON.stringify(frame);
      const realized = realizeInstructionAction(frame, locale);
      expect(realized).not.toMatch(/(?:<=|≤)\s*mg/u);
      // An incomplete edited quantity uses the intact authored argument;
      // retaining its tablet unit is essential even in a Thai realization.
      expect(realized).toContain("2 tablets");
      expect(JSON.stringify(frame)).toBe(original);
    }
  );
});


describe("indexed instruction metadata import",()=>{
  it("keeps first-value ownership, repeated children and externally edited input visible",()=>{
    const source="Dissolve 2 tablets in water, then drink slowly";
    const actions=parseInstructionActions(source);
    const wire=buildInstructionGraphExtension({sourceText:source,sourceLocale:"en",actions})!;
    const first=wire.extension!.find(item=>item.url==="action")!;
    const lemma=first.extension!.find(item=>item.url==="predicateLemma")!;
    const original=lemma.valueString;
    const originalArguments = actions[0].args;
    const authored = [
      { role: AdviceArgumentRole.Theme, text: "2 tablets", quantity: { value: 2, unit: "tab" } },
      { role: AdviceArgumentRole.Substance, text: "water", conceptId: "water",
        coding: { system: "http://snomed.info/sct", code: "11713004" } },
      { role: AdviceArgumentRole.Amount, text: "2 tablets", quantity: { value: 2, unit: "tab" } }
    ];
    expect(originalArguments).toMatchObject(authored);
    expect(parseInstructionGraphExtension([wire])!.actions[0].args).toMatchObject(authored);
    const duplicateWire=structuredClone(wire);
    const duplicateFirst=duplicateWire.extension!.find(item=>item.url==="action")!;
    duplicateFirst.extension!.push({url:"predicateLemma",valueString:"not-the-owner"});
    duplicateFirst.extension!.push({url:"__proto__",valueString:"ordinary unknown metadata"});
    expect(parseInstructionGraphExtension([duplicateWire])?.actions.map(action=>action.predicate.lemma))
      .toEqual(actions.map(action=>action.predicate.lemma));
    // Each external edit is an independent submitted value.
    const editedWire=structuredClone(duplicateWire);
    const editedFirst=editedWire.extension!.find(item=>item.url==="action")!;
    editedFirst.extension!.find(item=>item.url==="predicateLemma")!.valueString="edited-source-action";
    expect(parseInstructionGraphExtension([editedWire])?.actions[0].predicate.lemma).toBe("edited-source-action");
    expect(original).toBe("dissolve");
    expect(parseInstructionGraphExtension([editedWire])?.actions[0].args).toMatchObject(authored);
  });
});


describe("November 17 review: institution dose action owns prior quantitative instruction", () => {
  const options = {
    instructionActionMap: {
      disperse: {
        code: "disperse",
        display: "Disperse",
        semanticClass: "procedure",
        procedural: true,
        acceptsAmount: true,
        definesDose: true,
        argumentParser: "amount-material-destination" as const,
        realizer: "amount-material-destination" as const,
      },
    },
  };
  it("detects the custom earlier amount owner when the final drink action owns the administration", () => {
    const source = "Disperse 2 tablets in water, then drink slowly";
    const parsed = parsePublicSig(source, options);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.actions[0]?.predicate.lemma).toBe("disperse");
    expect(clause.instructionGraph?.primaryAdministrationSpan).toEqual({
      start: source.indexOf("drink"), end: source.indexOf("drink") + "drink".length
    });
    const changed = { ...clause, dose: { ...clause.dose!, value: 3 } };
    expect(instructionGraphSourceConflictsWithDose(changed, options)).toBe(true);
    const unchanged = { ...clause, dose: { ...clause.dose!, value: 2 } };
    expect(instructionGraphSourceConflictsWithDose(unchanged, options)).toBe(false);
    for (const locale of ["en", "th"]) {
      const rendered = formatCanonicalClause(changed, "long", resolveSigLocalization(locale), options);
      expect(rendered).not.toContain("Disperse 2 tablets in water, then drink slowly");
      expect(rendered).not.toContain("2 tablets");
      expect(rendered).toContain(locale === "en" ? "3 tablets" : "3 เม็ด");
      expect(rendered).toContain(locale === "en" ? "water" : "น้ำ");
      expect(rendered.toLowerCase()).toContain(locale === "en" ? "drink" : "ดื่ม");
    }
  });
});


describe("PR14 new review: R5 roundtrip source-dose provenance", () => {
  it("retains original HPSG-owned Thai wording for an unchanged parser item", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    const parsed = parsePublicSig(source, { locale: "th" });
    const row = parsed.items[0].fhir;
    expect(formatSig(row, "long", { locale: "th", realizationMode: "roundtrip" }))
      .toBe(source);
    expect(row.doseAndRate?.[0]?.doseQuantity?.value).toBe(1);
  });
  it("checks each freshly submitted external R5 dose against its source", () => {
    const source="ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    // The authoritative persisted top-level R5 row owns the saved edit
    // fingerprint; per-item parser previews intentionally do not.
    const row=structuredClone(parsePublicSig(source,{locale:"th"}).fhir[0]);
    const show=()=>formatSig(structuredClone(row),"long",{locale:"th",realizationMode:"roundtrip"});
    expect(show()).toBe(source);
    const dose=row.doseAndRate?.[0]?.doseQuantity;
    if(!dose)throw new Error("authored dose missing");
    dose.value=2;
    const changed=show();
    expect(changed).not.toBe(source);
    expect(changed).toMatch(/(?:2|สอง)\s*หยด/u);
    expect(changed).not.toMatch(/(?:1|หนึ่ง)\s*หยด/u);
    dose.value=1;
    expect(show()).toBe(source);
  });

  it("displays a newly introduced dose in an imported amountless Thai R5 row", () => {
    const source = "ผสมน้ำแล้วดื่ม";
    const row = parsePublicSig(source, { locale: "th" }).items[0].fhir;
    const changed = { ...row, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] };
    const text = formatSig(changed, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(text).toMatch(/(?:2|สอง)/u);
    expect(text).toMatch(/(?:เม็ด|tablet)/u);
    expect(text).not.toBe(source);
  });
});

describe("PR14 new review: amountless authored source with a later canonical dose",()=>{
  for(const [source,locale] of [
    ["Mix with water then swallow","en"],
    ["ผสมน้ำแล้วดื่ม","th"]
  ] as const){
    it("retains a canonical quantity added to amountless "+locale+" source",()=>{
      const parsed=parsePublicSig(source);
      const clause=parsed.meta.canonical.clauses[0];
      expect(clause.instructionGraph?.actions.length).toBeGreaterThan(0);
      expect(clause.dose?.value).toBeUndefined();
      const edited={...clause,dose:{value:1,unit:"tab"}};
      const output=formatCanonicalClause(edited,"long",resolveSigLocalization(locale),
        {realizationMode:"roundtrip",locale});
      expect(output).not.toBe(source);
      expect(output).toMatch(/(?:1|one|หนึ่ง)/ui);
      expect(output).toMatch(/(?:tablet|tab|เม็ด)/ui);
      expect(instructionGraphSourceConflictsWithDose(edited)).toBe(true);
    });
  }
  it("does not treat an empty dose object as an authored administered quantity",()=>{
    const clause=parsePublicSig("Mix with water then swallow").meta.canonical.clauses[0];
    expect(instructionGraphSourceConflictsWithDose({...clause,dose:{}})).toBe(false);
  });
});


describe("round 27: action heads and complements keep separate quantities", () => {
  it("composes the typed event adjunct after a negated action in both locales", () => {
    const frame = parseInstructionActions("Do not mix with milk before each dose")[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Time)).toMatchObject({
      conceptId: "each-dose", relation: AdviceRelation.Before
    });
    const en = realizeInstructionAction(frame, "en");
    const th = realizeInstructionAction(frame, "th");
    expect(en).toBe("Do not mix with milk before each dose");
    expect(th).toMatch(/ห้ามผสม(?:ด้วย|กับ)(?:milk|นม)ก่อนการให้ยาแต่ละครั้ง/u);
    expect(th).toContain("ก่อนการให้ยาแต่ละครั้ง");
    expect(en.match(/before each dose/gu)).toHaveLength(1);
    expect(th.match(/ก่อนการให้ยาแต่ละครั้ง/gu)).toHaveLength(1);
  });
  it.each(["Swallow whole with 200 mL water", "Take with 200 mL water", "Drink with 200 mL water"])(
    "retains accompaniment quantity without promoting it to a medication dose: %s", source => {
      const frame = parseInstructionActions(source)[0];
      expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Amount)).toEqual([]);
      expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Substance)).toMatchObject({
        text: "200 mL water", quantity: { value: 200, unit: "mL" }
      });
      const parsed = parsePublicSig(source);
      expect(parsed.meta.canonical.clauses[0].dose?.value).toBeUndefined();
      expect(parsed.fhirNext.step[0].component[0].doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    });
  it("keeps destination quantity separate while retaining licensed leading and postdestination amounts", () => {
    const onlyDestination = parseInstructionActions("Dilute to 10 mL")[0];
    expect(onlyDestination.args.filter(arg => arg.role === AdviceArgumentRole.Amount)).toEqual([]);
    expect(realizeInstructionAction(onlyDestination, "en")).toBe("Dilute to 10 mL");
    const diluted = parseInstructionActions("Dilute 1 mL to 10 mL")[0];
    expect(diluted.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 1, unit: "mL" });
    expect(realizeInstructionAction(diluted, "en")).toBe("Dilute 1 mL to 10 mL");
    const swallowed = parseInstructionActions("Swallow 1 tablet with 200 mL water")[0];
    expect(swallowed.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 1, unit: "tab" });
    const poured = parseInstructionActions("Pour into the cup 5 mL")[0];
    expect(poured.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 5, unit: "mL" });
    expect(realizeInstructionAction(poured, "en")).toBe("Pour 5 mL into the cup");
  });
});


describe("round29 action scope and external graph preservation", () => {
  it.each(["Swallow whole with 200 mL water", "Swallow 1 tablet whole with 200 mL water"])(
    "keeps the quantified accompaniment separate from the direct object: %s", source => {
      const frame = parseInstructionActions(source)[0];
      expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Substance)).toMatchObject({
        relation: AdviceRelation.With, quantity: { value: 200, unit: "mL" }
      });
      const expected = source.includes("1 tablet") ? "Swallow 1 tablet whole with 200 mL water"
        : "Swallow whole with 200 mL water";
      expect(realizeInstructionAction(frame, "en")).toBe(expected);
      expect(realizeInstructionAction(frame, "th")).toMatch(/^กลืน.*ทั้งเม็ดร่วมกับ200 มิลลิลิตรน้ำ$/u);
      const graph = { sourceText: source, actions: [frame] };
      const reopened = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
      expect(realizeInstructionAction(reopened.actions[0], "en")).toBe(expected);
      const withoutRelation = { ...reopened.actions[0] };
      delete withoutRelation.relation;
      expect(realizeInstructionAction(withoutRelation, "en")).toBe(expected);
    });

  it("keeps a partial mixing amount as source text in both locale realizers", () => {
    const frame = structuredClone(parseInstructionActions("Mix with 100 mL water")[0]);
    const substance = frame.args.find(arg => arg.role === AdviceArgumentRole.Substance)!;
    substance.text = "about 100 mL water";
    substance.quantity = { comparator: "~", unit: "mL" };
    const saved = buildInstructionGraphExtension({ sourceText: frame.sourceText, actions: [frame] })!;
    const restored = parseInstructionGraphExtension([saved])!.actions[0];
    const before = JSON.stringify(restored);
    for (const locale of ["en", "th"]) {
      expect(realizeInstructionAction(restored, locale)).toContain("about 100 mL water");
    }
    expect(JSON.stringify(restored)).toBe(before);
    const complete = parseInstructionActions("Mix with 100 mL water")[0];
    expect(realizeInstructionAction(complete, "en")).toBe("Mix with 100 mL water");
    expect(realizeInstructionAction(complete, "th")).toContain("น้ำ 100 มิลลิลิตร");
  });

  it("negation governs the complete qualified dilution target", () => {
    const frame = parseInstructionActions("Do not dilute to more than 10 mL before each dose")[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Destination)).toMatchObject({
      relation: AdviceRelation.To, quantity: { value: 10, unit: "mL", comparator: ">" }
    });
    expect(realizeInstructionAction(frame, "en")).toBe("Do not dilute to more than 10 mL before each dose");
    const th = realizeInstructionAction(frame, "th");
    expect(th).toMatch(/^ห้ามเจือจาง.*มากกว่า 10 มิลลิลิตร.*ก่อนการให้ยาแต่ละครั้ง$/u);
    expect(th.match(/ก่อนการให้ยาแต่ละครั้ง/gu)).toHaveLength(1);
    expect(realizeInstructionAction(parseInstructionActions("Dilute to 10 mL")[0], "en")).toBe("Dilute to 10 mL");
  });

  it("retains an independent stopping result after material and destination complements", () => {
    const frame = parseInstructionActions("Dilute with water to 10 mL until clear")[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Result)).toMatchObject({
      relation: AdviceRelation.Until, text: "clear"
    });
    expect(realizeInstructionAction(frame, "en")).toBe("Dilute with water to 10 mL until clear");
    expect(realizeInstructionAction(frame, "th")).toMatch(/จนกว่า.*clear$/u);
    const saved = buildInstructionGraphExtension({ sourceText: frame.sourceText, actions: [frame] })!;
    expect(realizeInstructionAction(parseInstructionGraphExtension([saved])!.actions[0], "en"))
      .toBe("Dilute with water to 10 mL until clear");
    const beforeDose = parseInstructionActions("Dilute with water to 10 mL before each dose")[0];
    expect(realizeInstructionAction(beforeDose, "en")).toBe("Dilute with water to 10 mL before each dose");
  });

  it("uses the externally edited method without losing the dose or water accompaniment", () => {
    const source = parsePublicSig("Swallow 1 tablet with 200 mL water").fhir[0];
    const replacement = parsePublicSig("Chew 1 tablet").fhir[0].method;
    const saved = JSON.parse(JSON.stringify(source));
    saved.method = replacement;
    const before = JSON.stringify(saved);
    const codeOnlyEdit = JSON.parse(JSON.stringify(source));
    codeOnlyEdit.method.coding = [{ system: "http://snomed.info/sct", code: "738992009" }];
    const codeOnlyMethod = JSON.parse(JSON.stringify(codeOnlyEdit));
    codeOnlyMethod.method = { coding: codeOnlyEdit.method.coding };
    for (const input of [saved, JSON.parse(JSON.stringify(saved)), codeOnlyEdit, codeOnlyMethod]) {
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toMatch(/^Chew (?:1|one) tablet with 200 mL water\b/iu);
        expect(en).not.toMatch(/\bswallow\b/iu);
        expect(th).toMatch(/^เคี้ยว.*1 เม็ด.*200 มิลลิลิตรน้ำ/u);
        expect(th).not.toContain("กลืน");
      }
      expect(fromFhirDosage(input).longText).toMatch(/^Chew (?:1|one) tablet with 200 mL water\b/iu);
    }
    expect(JSON.stringify(saved)).toBe(before);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "roundtrip" })).toContain("Swallow 1 tablet");
  });

  it.each([false, true])("uses a known method coding beside a local translation (standard first %s)", standardFirst => {
    const source = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet with 200 mL water").fhir[0]));
    const standard = { system: "http://snomed.info/sct", code: "738992009" };
    const local = { system: "urn:clinic:method", code: "local-translation" };
    source.method.coding = standardFirst ? [standard, local] : [local, standard];
    const before = JSON.stringify(source);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      expect(formatSig(source, "long", { locale: "en", realizationMode }))
        .toMatch(/^Chew (?:1|one) tablet with 200 mL water\b/iu);
    }
    expect(fromFhirDosage(source, { locale: "th" }).longText).toMatch(/^เคี้ยว.*1 เม็ด.*200 มิลลิลิตรน้ำ/u);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("renders a coded method without a saved graph and keeps compatible or qualified source verbs", () => {
    const coding = { system: "http://snomed.info/sct", code: "738992009" };
    const source = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      method: { text: "Swallow", coding: [coding] } };
    const before = JSON.stringify(source);
    expect(formatSig(source, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/^Chew 1 tablet/u);
    expect(fromFhirDosage(source, { locale: "th" }).longText).toMatch(/^เคี้ยว.*1 เม็ด/u);
    expect(JSON.stringify(source)).toBe(before);
    const compatible = { ...source, method: { text: "Drink",
      coding: [{ system: "http://snomed.info/sct", code: "738995006" }] } };
    expect(formatSig(compatible, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/^Drink 1 tablet/u);
    const qualified = { ...source, method: { text: "Swallow whole", coding: compatible.method.coding } };
    expect(formatSig(qualified, "long", { locale: "en", realizationMode: "normalized" })).toMatch(/^Swallow whole 1 tablet/u);
  });

  it("preserves declared coding annotations through graph import and projection", () => {
    const frame = structuredClone(parseInstructionActions("Swallow 1 tablet")[0]);
    const coding = frame.predicate.codings![0];
    coding.userSelected = true;
    coding._userSelected = { id: "chosen" };
    coding._code = { id: "code-annotation" };
    const graph = { sourceText: frame.sourceText, actions: [frame] };
    const reopened = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(reopened.actions[0].predicate.codings![0]).toMatchObject({
      code: coding.code, system: coding.system, userSelected: true,
      _userSelected: { id: "chosen" }, _code: { id: "code-annotation" }
    });
  });
});

describe("round30 method and current timing ownership", () => {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const method = (text: string, code: string) => ({
    text, coding: [{ system: "http://snomed.info/sct", code }]
  });

  it("replaces a conflicting known method head while retaining compatible and unfamiliar authored phrases", () => {
    const base = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    for (const [text, code, expected] of [
      ["Swallow whole", "738992009", "Chew"],
      ["Swallow whole", "738995006", "Swallow whole"],
      ["กลืนทั้งเม็ด", "738992009", "Chew"],
      ["กลืนทั้งเม็ด", "738995006", "กลืนทั้งเม็ด"],
      ["Swallowing whole", "738992009", "Chew"],
      ["Swallowtail whole", "738992009", "Swallowtail whole"],
      ["Unfamiliar authored technique", "738992009", "Unfamiliar authored technique"]
    ]) {
      const input = { ...base, method: method(text, code) };
      const before = JSON.stringify(input);
      const rendered = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(rendered).toMatch(new RegExp("^" + expected + " 1 tablet"));
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  function primaryWithTime(value: string, when?: EventTiming) {
    // Parse the complete source so its structured-clock ownership is real;
    // adding a graph clock to a clockless source would instead be independent.
    return copy(parsePublicSig("Swallow 1 tablet with 200 mL water " +
      (when ? "at bedtime" : "at " + value)).fhir[0]);
  }

  it("applies a current event when both method and timing change on the selected primary", () => {
    const input = primaryWithTime("HS", EventTiming["Before Sleep"]);
    input.method = method("Chew", "738992009");
    input.timing!.repeat!.when = [EventTiming.Morning];
    const before = JSON.stringify(input);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en).toMatch(/^Chew (?:1|one) tablet with 200 mL water/iu);
      expect(en).toMatch(/morning/iu);
      expect(en).not.toMatch(/bedtime|\bHS\b/iu);
      expect(th).toContain("เคี้ยว");
      expect(th).toContain("เช้า");
      expect(th).not.toContain("ก่อนนอน");
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([false, true])("uses the current clock set once with an event also present %s", withEvent => {
    const input = primaryWithTime("08:00");
    input.timing!.repeat!.timeOfDay = ["09:00:00", "17:00:00"];
    if (withEvent) {
      input.timing!.repeat!.when = [EventTiming.Morning];
      const graph = copy(parseInstructionGraphExtension(input.extension)!);
      graph.actions[0].args.push({ role: AdviceArgumentRole.Time, text: "morning", normalized: EventTiming.Morning });
      const marker = buildInstructionGraphExtension(graph)!;
      input.extension = input.extension!.map(item => item.url === marker.url ? marker : item);
    }
    const before = JSON.stringify(input);
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en).not.toMatch(/08:00|8:00 am/u);
      expect(en.match(/9:00 am/gu)).toHaveLength(1);
      expect(en.match(/5:00 pm/gu)).toHaveLength(1);
      expect(th).not.toContain("08:00");
      expect(th.match(/09:00/gu)).toHaveLength(1);
      expect(th.match(/17:00/gu)).toHaveLength(1);
      expect(/morning/iu.test(en)).toBe(withEvent);
      expect(th.includes("เช้า")).toBe(withEvent);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("realizes a qualified amount from its typed daughter without losing manner or accompaniment", () => {
    const frame = parseInstructionActions("Swallow at most 1 tablet whole with 200 mL water")[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)).toMatchObject({
      text: "at most 1 tablet", quantity: { value: 1, unit: "tab", comparator: "<=" }
    });
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Substance)).toMatchObject({
      relation: AdviceRelation.With, quantity: { value: 200, unit: "mL" }
    });
    const th = realizeInstructionAction(frame, "th");
    expect(th).toMatch(/^กลืน.*ไม่เกิน 1 เม็ด.*ทั้งเม็ด.*200 มิลลิลิตรน้ำ/u);
    expect(th).not.toContain("Swallow");
    expect(realizeInstructionAction(frame, "en")).toBe("Swallow at most 1 tablet whole with 200 mL water");
    const reopened = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: frame.sourceText, actions: [frame]
    })!])!;
    expect(realizeInstructionAction(reopened.actions[0], "th")).toBe(th);
  });
});

describe("round31 edited action ownership", () => {
  it.each([
    ["Do not swallow more than 1 tablet", "Do not swallow more than 1 tablet", "มากกว่า 1 เม็ด"],
    ["Do not swallow 2 tablets", "Do not swallow 2 tablets", "2 เม็ด"]
  ])("retains the typed amount in %s", (source, expected, thaiAmount) => {
    const action = parseInstructionActions(source)[0];
    const before = JSON.stringify(action);
    expect(realizeInstructionAction(action, "en")).toBe(expected);
    expect(realizeInstructionAction(action, "th")).toContain(thaiAmount);
    expect(realizeInstructionAction(action, "th")).toMatch(/^ห้ามกลืน/u);
    expect(JSON.stringify(action)).toBe(before);
  });

  it.each([false, true])("moves the water accompaniment to the edited method (dose edited %s)", editDose => {
    const original = parsePublicSig("Swallow 1 tablet whole with 200 mL water").fhir[0];
    const row = JSON.parse(JSON.stringify(original));
    row.method = parsePublicSig("Chew 1 tablet").fhir[0].method;
    if (editDose) row.doseAndRate[0].doseQuantity.value = 2;
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row])]) {
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toMatch(editDose ? /^Chew 2 tablets?/u : /^Chew (?:1|one) tablet/u);
        expect(en).toContain("with 200 mL water");
        expect(en.match(/200 mL/gu)).toHaveLength(1);
        expect(en).not.toMatch(/\bswallow\b|\bwhole\b/iu);
        expect(en.match(/\bChew\b/giu)).toHaveLength(1);
        expect(th.match(/เคี้ยว/gu)).toHaveLength(1);
        expect(th).toContain(editDose ? "2 เม็ด" : "1 เม็ด");
        expect(th).toContain("200 มิลลิลิตรน้ำ");
        expect(th).not.toMatch(/กลืน|ทั้งเม็ด/u);
      }
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(formatSig(original, "long", { locale: "en", realizationMode: "normalized" }))
      .toMatch(/Swallow.*whole/u);
  });

  it("preserves a preparation clock when the separate primary clock changes", () => {
    const source = "Dissolve 2 tablets in water at 08:00 then drink at 09:00";
    const actions = parseInstructionActions(source);
    const drink = actions.find(action => action.predicate.lemma === "drink")!;
    const graph = { sourceText: source, sourceLocale: "en", actions, primaryAdministrationSpan: drink.span };
    const initial: FhirDosage = {
      text: source, method: { text: "Drink" }, doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      timing: { repeat: { timeOfDay: ["09:00:00"] } },
      extension: [buildInstructionGraphExtension(graph)!]
    };
    const row = JSON.parse(JSON.stringify(withDosageEditProvenance([initial], source)[0]));
    expect(getDosageSourceOwnership(row)?.clocks).toBe(true);
    row.timing.repeat.timeOfDay = ["10:00:00"];
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Dissolve 2 tablets");
      expect(en).toContain("08:00");
      expect(en).toContain("10:00");
      expect(en).not.toMatch(/0?9:00/u);
      expect(th).toContain("08:00");
      expect(th).toContain("10:00");
      expect(th).not.toContain("09:00");
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("round31 method-bound manner control", () => {
  it("keeps an independent manner when a typed source method qualifier is superseded", () => {
    const clause = structuredClone(parsePublicSig("Swallow 1 tablet whole with 200 mL water").meta.canonical.clauses[0]);
    const graph = clause.instructionGraph!, frame = graph.actions[0];
    frame.args.push({ role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" });
    clause.method = parsePublicSig("Chew 1 tablet").meta.canonical.clauses[0].method;
    const before = JSON.stringify(graph);
    const current = realizeRichPrimaryWithCanonicalDose(frame, clause, "en");
    expect(current).toMatch(/^Chew 1 tablet slowly with 200 mL water$/u);
    expect(current).not.toContain("whole");
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("round32 action meaning combinations", () => {
  it("keeps prohibition, amount and Without activity together in both locales", () => {
    const source = "Do not swallow 1 tablet without chewing";
    const frame = parseInstructionActions(source)[0];
    expect(frame).toMatchObject({ polarity: "negate", relation: AdviceRelation.Without });
    expect(frame.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Activity, normalized: "chew" })
    ]));
    const before = JSON.stringify(frame);
    const saved = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: [frame]
    })!])!;
    for (const action of [frame, saved.actions[0]]) {
      expect(realizeInstructionAction(action, "en")).toBe("Do not swallow 1 tablet without chewing");
      expect(realizeInstructionAction(action, "th")).toMatch(/^ห้ามกลืน 1 เม็ด.*โดยไม่เคี้ยว$/u);
    }
    expect(realizeInstructionAction(parseInstructionActions("Do not swallow 1 tablet")[0], "en"))
      .toBe("Do not swallow 1 tablet");
    expect(JSON.stringify(frame)).toBe(before);
  });

  it.each(["if", "unless"])("retains a dilution's %s condition after all material complements", connector => {
    const source = "Dilute 1 mL with saline to 10 mL " + connector + " given by nebulizer";
    const parsed = parsePublicSig(source);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const tail = connector + " given by nebulizer";
    expect(graph.actions[0].sourceText).toBe("Dilute 1 mL with saline to 10 mL");
    expect(graph.relations).toContainEqual(expect.objectContaining({
      kind: connector, toActionIndex: 0, text: expect.stringContaining(tail),
      span: expect.objectContaining({ end: source.length })
    }));
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, recovered]) for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(candidate, locale)!;
      expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
      expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
      expect(text).toContain(tail);
      expect(text.match(new RegExp(connector + " given by nebulizer", "g"))).toHaveLength(1);
    }
  });

  it.each([
    [AdviceRelation.Before, "before breakfast", "ก่อนอาหารเช้า"],
    [AdviceRelation.After, "after breakfast", "หลังอาหารเช้า"],
    [undefined, "at 08:00", "เวลา 08:00"]
  ] as const)("preserves a Mix Time relation %s", (relation, english, thai) => {
    const frame = parseInstructionActions("Mix")[0];
    frame.relation = relation;
    frame.sourceText = "";
    frame.args = [relation ? { role: AdviceArgumentRole.Time, text: "breakfast",
      normalized: "breakfast", i18n: { en: "breakfast", th: "อาหารเช้า" } }
      : { role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00" }];
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension({ actions: [frame] })!])!;
    for (const action of [frame, recovered.actions[0]]) {
      expect(realizeInstructionAction(action, "en")).toBe("Mix " + english);
      expect(realizeInstructionAction(action, "th")).toContain(thai);
    }
  });

  it("composes independent material and temporal daughters once", () => {
    const frame = parseInstructionActions("Mix with water before breakfast")[0];
    expect(realizeInstructionAction(frame, "en")).toBe("Mix with water before breakfast");
    const dilution = parseInstructionActions("Dilute 1 mL with saline to 10 mL before use")[0];
    expect(realizeInstructionAction(dilution, "en")).toMatch(/1 mL.*saline.*10 mL.*before use/u);
    expect(realizeInstructionAction(dilution, "en").match(/before/gu)).toHaveLength(1);
  });

  it("uses an externally edited site on a rich primary while keeping an independent action site", () => {
    const source = "Instill 1 drop into right eye";
    const original = parsePublicSig(source).fhir[0];
    const primary = parseInstructionActions(source)[0];
    primary.args.push({ role: AdviceArgumentRole.Manner, text: "gently",
      normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } });
    const warning = parseInstructionActions("Do not touch right eye")[0];
    warning.span = { start: source.length + 2, end: source.length + 24 };
    warning.sequenceIndex = 1;
    const extension = buildInstructionGraphExtension({
      sourceText: source + "; Do not touch right eye", sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 7 }, actions: [primary, warning]
    })!;
    const row = JSON.parse(JSON.stringify(original));
    row.extension = row.extension.filter((item: { url: string }) => item.url !== extension.url);
    row.extension.push(extension);
    row.site = parsePublicSig("Instill 1 drop into left eye").fhir[0].site;
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row])]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en).toMatch(/^Instill.*gently.*left eye/u);
      expect(en).toMatch(/Do not touch (?:the )?right eye/u);
      expect(en.match(/right eye/gu)).toHaveLength(1);
      expect(th).toMatch(/^หยอด.*เบาๆ.*ตาซ้าย/u);
      expect(th).toContain("ห้ามสัมผัสตาขวา");
      expect(th.match(/ตาขวา/gu)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("round32 source clock ownership", () => {
  it.each([
    [false, "dose", true, false],
    [false, "add", true, true],
    [false, "mirror", true, false],
    [true, "dose", true, false],
    [true, "replace", false, true],
    [true, "delete", false, false]
  ] as const)("retains only clocks still owned after external edit (structured %s, edit %s)",
    (structured, edit, eight, ten) => {
    const source = "Swallow 1 tablet whole at 08:00";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole").fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.sourceText = source;
    graph.actions[0].sourceText = source;
    graph.actions[0].span.end = source.length;
    graph.actions[0].args.push({ role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00" });
    const graphUrl = buildInstructionGraphExtension(graph)!.url;
    // This fixture authors a new complete source, not an edit of the helper
    // parser's clockless source. Establish its initial wire baseline once.
    row.extension = row.extension.filter((item: { url: string }) =>
      item.url !== graphUrl && item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(buildInstructionGraphExtension(graph)!);
    if (structured) row.timing = { repeat: { timeOfDay: ["08:00:00"] } };
    row.text = source;
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    expect(getDosageSourceOwnership(saved)?.clocks).toBe(structured);
    saved.doseAndRate[0].doseQuantity.value = 2;
    if (edit === "add" || edit === "mirror")
      saved.timing = { repeat: { timeOfDay: [edit === "mirror" ? "08:00:00" : "10:00:00"] } };
    if (edit === "replace") saved.timing.repeat.timeOfDay = ["10:00:00"];
    if (edit === "delete") delete saved.timing.repeat.timeOfDay;
    const before = JSON.stringify(saved);
    const r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(/(?:^|[^0-9:])0?8:00(?::00)?(?:\s*a\.?m\.?(?![\p{L}\p{N}])|(?![0-9:]|\s*[ap]\.?m\.?))/iu.test(text), locale + " " + realizationMode + " " +
          (input === saved ? "R5" : input === r6 ? "R6" : "R5-from-R6") + ": " + text).toBe(eight);
        expect(/(?:^|[^0-9:])10:00(?::00)?(?:\s*a\.?m\.?(?![\p{L}\p{N}])|(?![0-9:]|\s*[ap]\.?m\.?))/iu.test(text)).toBe(ten);
        if (edit === "mirror") expect(text.match(/(?:^|[^0-9:])0?8:00(?::00)?(?![0-9:])/gu)).toHaveLength(1);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});

describe("round32 source event ownership", () => {
  it.each([
    [false, "dose", true, false],
    [false, "add", true, true],
    [true, "dose", true, false],
    [true, "replace", false, true],
    [true, "delete", false, false]
  ] as const)("retains independent graph events after external edit (structured %s, edit %s)",
    (structured, edit, morning, evening) => {
    const source = "Swallow 1 tablet whole in the morning";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole").fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.sourceText = source;
    graph.actions[0].sourceText = source;
    graph.actions[0].span.end = source.length;
    graph.actions[0].args.push({ role: AdviceArgumentRole.Time, text: "morning", normalized: EventTiming.Morning });
    const extension = buildInstructionGraphExtension(graph)!;
    row.extension = row.extension.filter((item: { url: string }) =>
      item.url !== extension.url && item.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(extension);
    if (structured) row.timing = { repeat: { when: [EventTiming.Morning] } };
    row.text = source;
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    expect(getDosageSourceOwnership(saved)?.events).toBe(structured);
    saved.doseAndRate[0].doseQuantity.value = 2;
    if (edit === "add") saved.timing = { repeat: { when: [EventTiming.Evening] } };
    if (edit === "replace") saved.timing.repeat.when = [EventTiming.Evening];
    if (edit === "delete") delete saved.timing.repeat.when;
    const before = JSON.stringify(saved), r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(text.includes(locale === "en" ? "morning" : "เช้า"), locale + " " + realizationMode + " " +
          (input === saved ? "R5" : input === r6 ? "R6" : "R5-from-R6") + ": " + text).toBe(morning);
        expect(text.includes(locale === "en" ? "evening" : "เย็น")).toBe(evening);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});

describe("round32 natural clock daughters", () => {
  it.each(["08:00", "8 am"])("types the complete %s daughter using the shared clock grammar", clock => {
    const source = "Swallow 1 tablet whole at " + clock;
    const parsed = parsePublicSig(source);
    const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(action.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Time, text: clock, normalized: "08:00:00"
    }));
    expect(action.args.filter(arg => arg.role === AdviceArgumentRole.Object)).toEqual([]);
    const initial = formatSig(parsed.fhirNext, "long", { locale: "en", realizationMode: "normalized" });
    expect(initial.match(/(?:^|[^0-9:])0?8:00(?::00)?(?![0-9:])/gu)).toHaveLength(1);
  });

  it.each(["delete", "replace"] as const)("honors a %s edit on freshly parsed R6 rich clock source", edit => {
    const raw = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole at 08:00").fhirNext));
    const component = raw.step[0].component[0];
    component.doseAndRate[0].doseQuantity.value = 2;
    if (edit === "delete") delete component.timing.repeat.timeOfDay;
    else component.timing.repeat.timeOfDay = ["10:00:00"];
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(text).not.toMatch(/(?:^|[^0-9:])0?8:00(?::00)?(?![0-9:])/u);
        expect(text.includes("10:00")).toBe(edit === "replace");
      }
    }
    expect(JSON.stringify(raw)).toBe(before);
  });
});

it("round32: later-stage saved R5 rows retain their own source clock ownership", () => {
  const parsed = parsePublicSig("Swallow 1 tablet whole at 08:00 daily for 2 days then swallow 2 tablets whole at 09:00 daily");
  expect(parsed.fhir).toHaveLength(2);
  const rows = JSON.parse(JSON.stringify(parsed.fhir));
  expect(getDosageSourceOwnership(rows[1])?.clocks).toBe(true);
  rows[1].doseAndRate[0].doseQuantity.value = 3;
  delete rows[1].timing.repeat.timeOfDay;
  const before = JSON.stringify(rows);
  for (const locale of ["en", "th"]) {
    const local = formatSig(rows[1], "long", { locale, realizationMode: "normalized" });
    expect(local).toContain(locale === "en" ? "3 tablets" : "3 เม็ด");
    expect(local).not.toMatch(/(?:^|[^0-9:])0?9:00(?::00)?(?![0-9:])/u);
    const whole = formatSig(toDosageDetails(rows), "long", { locale, realizationMode: "normalized" });
    expect(whole).toMatch(/(?:^|[^0-9:])0?8:00(?::00)?(?![0-9:])/u);
    expect(whole).not.toMatch(/(?:^|[^0-9:])0?9:00(?::00)?(?![0-9:])/u);
    expect(whole).toContain(locale === "en" ? "3 tablets" : "3 เม็ด");
    const stages = whole.split(locale === "en" ? ". then " : ". จากนั้น ");
    expect(stages).toHaveLength(2);
    const [firstStage, secondStage] = stages;
    expect(firstStage).toMatch(locale === "en" ? /1 tablet[^.]*8:00 am/u : /1 เม็ด[^.]*08:00/u);
    expect(secondStage).toContain(locale === "en" ? "3 tablets" : "3 เม็ด");
    expect(secondStage).not.toMatch(/(?:^|[^0-9:])0?[89]:00(?::00)?(?![0-9:])/u);
  }
  expect(JSON.stringify(rows)).toBe(before);
});


describe("round56: authored administration and independent advice", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const marker = { url: "urn:round56:authored-note", valueString: "keep this annotation" };

  it.each([
    ["both eyes", "81745001", "both eyes", 2],
    ["ตาทั้งสองข้าง", "81745001", "both eyes", 2],
    ["left eye", "81745001", "left eye", 1],
    ["both eyes", "1290032005", "right eye", 1]
  ] as const)("keeps compatible site detail and correct multiplicity: %s / %s", (text, code, expected, total) => {
    const site = { text, coding: [{ system: "http://snomed.info/sct", code }], extension: [marker] };
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: fresh(site) }, doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: "d" } }
    }] }] };
    for (const input of [raw, fresh(toFhirR5Dosages(raw))]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain(expected);
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z",
        durationValue: 1, durationUnit: "d", timeZone: "UTC" }).totalUnits).toBe(total);
      expect(toFhirR5Dosages(input)[0].site).toEqual(site);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["authored-and-hold", "authored-only", "structured-and-hold"] as const)(
    "attaches the live guard to its administration: %s", variant => {
      const structured = variant === "structured-and-hold", hold = variant !== "authored-only";
      const row: FhirDosage = { text: "Swallow 1 tablet whole", extension: [fresh(marker)],
        ...(hold ? { additionalInstruction: [{ text: "Otherwise hold" }] } : {}),
        ...(structured ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] } : {}) };
      setDosageCondition(row, { kind: "measurement", name: "systolic BP", operation: "gt", value: 160, text: "SBP > 160" });
      const r6: FhirR6DosageInstruction = { step: [{ component: [{
        text: row.text, extension: [fresh(marker)],
        ...(hold ? { additionalInstruction: [{ text: "Otherwise hold" }] } : {}),
        ...(structured ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }] } : {}),
        condition: [{ code: { coding: [{ system: "urn:ezmedicationinput:CodeSystem:medication-condition",
          code: "measurement", display: "systolic BP" }], text: "systolic BP" },
          operation: "gt", valueQuantity: { value: 160 } }]
      }] }] };
      for (const input of [[row], r6, fresh(toFhirR5Dosages(r6))]) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          const separator = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
          const [current, original] = text.split(separator);
          const active = current.replace(locale === "en" ? /^Current: /u : /^ปัจจุบัน: /u, "");
          if (original !== undefined) expect(original).toBe(row.text);
          expect(active.match(/systolic BP > 160/gu)).toHaveLength(1);
          const condition = locale === "en" ? "only if systolic BP > 160" : "เฉพาะเมื่อ systolic BP > 160";
          if (!structured) expect(active).toContain("Swallow 1 tablet whole " + condition + ".");
          else expect(active).toMatch(locale === "en"
            ? /(?:^|\.\s*)Use 2 tablets only if systolic BP > 160\.(?=\s|$)/u
            : /(?:^|\.\s*)ใช้(?:ครั้งละ)? 2 เม็ด เฉพาะเมื่อ systolic BP > 160\.(?=\s|$)/u);
          if (hold) {
            expect(active).toMatch(/(?:^|\.\s*)Otherwise hold\.?$/u);
            expect(active).not.toContain("Otherwise hold " + condition);
          } else expect(active).not.toContain("Otherwise hold");
        }
        expect(toFhirR5Dosages(input)[0].extension).toContainEqual(marker);
        expect(JSON.stringify(input)).toBe(before);
      }
    });

  it.each([false, true])("keeps explicit dates beside graph warnings: %s", dated => {
    const extension = buildInstructionGraphExtension({ sourceText: "Do not crush", sourceLocale: "en",
      actions: fresh(parseInstructionActions("Do not crush")) })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      ...(dated ? { timing: { event: ["2026-12-05T09:00:00-05:00"] } } : {}), extension: [extension, fresh(marker)]
    }] }] };
    for (const input of [raw, fresh(toFhirR5Dosages(raw))]) {
      const before = JSON.stringify(input);
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Do not crush."); expect(th).toContain("ห้ามบด.");
      if (dated) {
        expect(en).toContain("2026-12-05T09:00:00-05:00");
        expect(th).toContain("5/12/2569 เวลา 09:00:00-05:00");
      } else { expect(en).toBe("Do not crush."); expect(th).toBe("ห้ามบด."); }
      expect(toFhirR5Dosages(input)[0].extension).toContainEqual(extension);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["upper", "lower", "both"] as const)("renders the live %s range with its whole qualifier", kind => {
    const row = fresh(parsePublicSig("Swallow 1 tablet whole").fhir[0]);
    const range = { ...(kind !== "upper" ? { low: { value: 1, unit: "tab", extension: [fresh(marker)] } } : {}),
      ...(kind !== "lower" ? { high: { value: 2, unit: "tab", extension: [fresh(marker)] } } : {}) };
    row.doseAndRate = [{ doseRange: range }];
    const raw = fresh(parsePublicSig("Swallow 1 tablet whole").fhirNext);
    raw.step[0].component[0].doseAndRate = [{ doseRange: fresh(range) }];
    for (const input of [[row], raw, fresh(toFhirR5Dosages(raw))]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(kind === "upper" ? "Swallow at most 2 tablets whole." : kind === "lower"
          ? "Swallow at least 1 tablet whole." : "Swallow 1-2 tablets whole.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe(kind === "upper" ? "กลืน ไม่เกิน 2 เม็ดทั้งเม็ด." : kind === "lower"
          ? "กลืน อย่างน้อย 1 เม็ดทั้งเม็ด." : "กลืน 1-2 เม็ดทั้งเม็ด.");
      expect(toFhirR5Dosages(input)[0].doseAndRate?.[0].doseRange).toEqual(range);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([AdviceRelation.Before, AdviceRelation.After])("keeps a distinct second temporal relation: %s", relation => {
    const source = "Apply a new patch after breakfast and " +
      (relation === AdviceRelation.Before ? "before 10:00" : "after breakfast");
    const frame = fresh(parseInstructionActions("Apply a new patch")[0]);
    frame.sourceText = source; frame.relation = AdviceRelation.After;
    frame.args[0].i18n = { th: "แผ่นแปะใหม่" };
    frame.args.push({ role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
      relation: AdviceRelation.After, i18n: { th: "อาหารเช้า" } },
      relation === AdviceRelation.Before
        ? { role: AdviceArgumentRole.Time, text: "10:00", relation, i18n: { th: "10:00" } }
        : { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast, relation,
          i18n: { th: "อาหารเช้า" } });
    const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const row: FhirDosage = { extension: [extension, fresh(marker)] };
    for (const input of [[row], toDosageDetails(fresh([row]))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
        if (relation === AdviceRelation.Before) expect(text).toContain(locale === "en" ? "before 10:00" : "ก่อน10:00");
        else expect(text.match(locale === "en" ? /after breakfast/gu : /หลังอาหารเช้า/gu)).toHaveLength(1);
      }
      expect(toFhirR5Dosages(input)[0].extension).toContainEqual(extension);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("round57 independent graph and calendar meaning", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [row, r6, fresh(toFhirR5Dosages(r6))];
  };
  it.each([
    { name: "none", bounds: undefined, en: "Do not crush.", th: "ห้ามบด." },
    { name: "end", bounds: { end: "2026-12-10" }, en: "Use the medication through 10 Dec 2026. Do not crush.", th: "ใช้ยา ถึงวันที่ 10/12/2569. ห้ามบด." },
    { name: "start", bounds: { start: "2026-12-03" }, en: "Use the medication starting 3 Dec 2026. Do not crush.", th: "ใช้ยา ตั้งแต่วันที่ 3/12/2569. ห้ามบด." },
    { name: "both", bounds: { start: "2026-12-03", end: "2026-12-10" }, en: "Use the medication from 3 Dec 2026 through 10 Dec 2026. Do not crush.", th: "ใช้ยา ตั้งแต่วันที่ 3/12/2569 ถึงวันที่ 10/12/2569. ห้ามบด." }
  ])("keeps $name calendar bounds beside independent graph advice", ({ bounds, en, th }) => {
    const source: FhirR6DosageInstruction = { step: [{ component: [{
      ...(bounds ? { timing: { repeat: { boundsPeriod: bounds } } } : {}),
      extension: [buildInstructionGraphExtension({ sourceText: "Do not crush", sourceLocale: "en",
        actions: parseInstructionActions("Do not crush") })!]
    }] }] };
    const before = fresh(source), rows = fresh(toFhirR5Dosages(source));
    for (const input of [source, rows]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(en);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(th);
    }
    expect(toDosageDetails(rows).step[0].component[0].timing?.repeat?.boundsPeriod).toEqual(bounds);
    expect(source).toEqual(before);
  });

  it.each(["Dilute 1 mL at 08:00", "Dilute 1 mL at 08:00 if the solution is too thick",
    "Dilute 1 mL with water at 08:00 if the solution is too thick"])("keeps the bounded clock daughter: %s", text => {
    const parsed = parsePublicSig(text), before = fresh(parsed.fhirNext);
    const conditional = text.includes(" if ");
    for (const rows of [fresh(parsed.fhir), fresh(toFhirR5Dosages(parsed.fhirNext))]) {
      const graph = parseInstructionGraphExtension(rows[0].extension)!;
      const frame = graph.actions[0], time = frame.args.find(arg => arg.role === AdviceArgumentRole.Time);
      expect(time).toMatchObject({ text: "08:00", normalized: "08:00:00" });
      expect(frame.args.some(arg => arg.role === AdviceArgumentRole.Destination && arg.text === "08:00")).toBe(false);
      expect(text.slice(time!.span!.start, time!.span!.end)).toBe("08:00");
      if (conditional) {
        expect(graph.relations).toContainEqual(expect.objectContaining({ kind: "if", text: "if the solution is too thick" }));
        expect(frame.span.end).toBeLessThan(text.indexOf("if the solution"));
      }
    }
    expect(parsed.longText).toContain("at 08:00:00");
    if (conditional) expect(parsed.longText).toContain("if the solution is too thick");
    expect(parsed.fhirNext).toEqual(before);
  });
  it("keeps a dilution quantity as a destination beside its condition", () => {
    const text = "Dilute 1 mL to 10 mL if the solution is too thick";
    const frame = parseInstructionActions(text)[0];
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Destination)?.quantity).toMatchObject({ value: 10, unit: "mL" });
    expect(frame.args.some(arg => arg.role === AdviceArgumentRole.Time)).toBe(false);
    expect(parsePublicSig(text).longText).toBe(text + ".");
  });

  it.each([AdviceRelation.After, AdviceRelation.Before])("retains an Activity's own relation: %s", relation => {
    const frame = fresh(parseInstructionActions("Swallow before bedtime")[0]);
    frame.sourceText = ""; frame.relation = AdviceRelation.Before;
    frame.args = [
      { role: AdviceArgumentRole.Time, text: "bedtime", normalized: "HS", relation: AdviceRelation.Before, i18n: { th: "ก่อนนอน" } },
      { role: AdviceArgumentRole.Activity, text: "eating", normalized: "eating", relation, i18n: { th: "รับประทานอาหาร" } }
    ];
    const before = fresh(frame), marker = buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!;
    const reopened = parseInstructionGraphExtension([fresh(marker)])!.actions[0];
    for (const input of [frame, reopened]) {
      expect(realizeInstructionAction(input, "en")).toBe("Swallow before sleep " + (relation === AdviceRelation.After ? "after" : "before") + " eating");
      expect(realizeInstructionAction(input, "th")).toBe("กลืนก่อนนอน" + (relation === AdviceRelation.After ? "หลัง" : "ก่อน") + "รับประทานอาหาร");
    }
    expect(frame).toEqual(before);
  });

  it.each([false, true])("keeps the edited patch dose on Amount with independentObject=%s", independent => {
    const text = "Apply 1 patch of estradiol at bedtime";
    const frame = fresh(parseInstructionActions("Apply patch at bedtime")[0]);
    frame.sourceText = text; frame.span = { start: 0, end: text.length };
    frame.args = [
      { role: AdviceArgumentRole.Object, text: independent ? "estradiol" : "1 patch of estradiol",
        normalized: independent ? "estradiol" : "1 patch of estradiol",
        quantity: independent ? { value: 20, unit: "mg" } : { value: 1, unit: "patch" },
        span: { start: 6, end: text.indexOf(" at ") } },
      { role: AdviceArgumentRole.Amount, text: "1 patch", quantity: { value: 1, unit: "patch" }, span: { start: 6, end: 13 } },
      { role: AdviceArgumentRole.Time, text: "bedtime", normalized: "HS", relation: AdviceRelation.On, i18n: { th: "ก่อนนอน" } }
    ];
    const row: FhirDosage = { method: { text: "Apply" }, doseAndRate: [{ doseQuantity: { value: 2, unit: "patch" } }],
      extension: [buildInstructionGraphExtension({ sourceText: text, sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] })!] };
    const before = fresh(row);
    for (const input of views(row)) for (const locale of ["en", "th"]) {
      const preview = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(preview.match(/\b2 patch\b/gu)).toHaveLength(1);
      expect(preview).not.toMatch(/\b1 patch\b/u);
      expect(preview).toContain("estradiol");
      if (independent) expect(preview).toContain("20 mg");
    }
    expect(row).toEqual(before);
    expect(parseInstructionGraphExtension(row.extension)?.actions[0]).toMatchObject(frame);
  });

  it("keeps equal priming and administration amounts as separate events", () => {
    const frame = fresh(parseInstructionActions("Prime with 2 sprays")[0]); frame.sourceText = "";
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "spray" } }], route: { text: "intranasal" },
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
    const before = fresh(row);
    for (const input of views(row)) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en.split(/\.\s*/u).filter(Boolean).sort())
        .toEqual(["Prime with 2 sprays", "Use 2 sprays via nasal route"]);
      expect(th.split(/\.\s*/u).filter(Boolean).sort())
        .toEqual(["พ่นครั้งละ 2 พ่น ทางจมูก", "เตรียมอุปกรณ์พ่น 2 พ่น"].sort());
    }
    expect(row).toEqual(before);
  });
  it("still selects a dose-defining missing head from a spanless graph", () => {
    const frame = fresh(parseInstructionActions("Swallow 2 tablets before bedtime")[0]); frame.sourceText = "";
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
    const result = fromFhirDosage(fresh(row), { locale: "en", realizationMode: "normalized" });
    expect(instructionGraphRichPrimaryAction(result.meta.canonical.clauses[0])?.predicate.lemma).toBe("swallow");
    expect(result.longText).toMatch(/^Swallow\b/u);
    expect(result.longText).not.toContain("Use");
  });

  it.each(["where the surface feels rough", ""])("retains an untranslated authored site restriction: %s", sourceText => {
    const row: FhirDosage = { method: { text: "Apply" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      site: { text: "skin", extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-body-site-restriction", extension: [
        { url: "relation", valueCode: "where" }, { url: "sourceText", valueString: sourceText },
        { url: "predicateText", valueString: "rough" }, { url: "predicateForm", valueCode: "state" }
      ] }] } };
    const before = fresh(row);
    for (const input of views(row)) expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
      .toBe("ทาครั้งละ 1 g ที่ผิวหนัง (" + (sourceText || "where rough") + ").");
    expect(row).toEqual(before);
  });
});


describe("round58 graph fidelity and current typed arguments", () => {
  const fresh = <T>(input: T): T => JSON.parse(JSON.stringify(input));
  const marker = (frame: AdviceFrame) => buildInstructionGraphExtension({
    sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame]
  })!;
  const graphChild = (extensions: FhirExtension[] | undefined) => extensions!
    .find(item => item.url.endsWith("medication-instruction-graph"))!
    .extension!.find(item => item.url === "action")!;
  const views = (row: FhirDosage) => {
    const r6 = toDosageDetails([row]);
    return [[row], r6, fresh(toFhirR5Dosages(r6))] as const;
  };
  const preparation = (): AdviceFrame => ({
    ...fresh(parseInstructionActions("Dilute with water")[0]), sourceText: ""
  });
  const material = () => ({
    role: AdviceArgumentRole.Material, relation: AdviceRelation.With,
    text: "100 mL sterile water", normalized: "sterile water",
    i18n: { th: "น้ำปราศจากเชื้อ" }, quantity: { value: 100, unit: "mL" }
  });

  it.each(["r5", "r6"] as const)("retains opaque action children through the public graph codec and fresh %s projections", kind => {
    const action = fresh(parseInstructionActions("Swallow 1 tablet before bedtime")[0]);
    const known = marker(action);
    const unknown: FhirExtension = { url: "urn:round58:opaque-action", id: "kept-child", extension: [
      { url: "note", valueString: "preserve supplied action note" },
      { url: "nested", extension: [{ url: "zero", valueInteger: 0 }, { url: "flag", valueBoolean: false }] }
    ] };
    const supplied = fresh(known);
    graphChild([supplied]).extension!.push(unknown);
    const row = { method: { text: "Swallow" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], extension: [supplied] } satisfies FhirDosage;
    const input = kind === "r5" ? [row] : { step: [{ component: [row] }] };
    const before = JSON.stringify(input);
    const parsed = parseInstructionGraphExtension(row.extension)!;
    const rebuilt = buildInstructionGraphExtension(parsed)!;
    expect(graphChild([rebuilt]).extension).toContainEqual(unknown);
    expect(graphChild([rebuilt]).extension!.filter(child => child.url !== unknown.url))
      .toEqual(graphChild([known]).extension);
    expect(buildInstructionGraphExtension(parseInstructionGraphExtension([known]))).toEqual(known);
    const rebuiltRow = { ...row, extension: [rebuilt] };
    const rebuiltInput = kind === "r5" ? [rebuiltRow] : { step: [{ component: [rebuiltRow] }] };
    for (const submitted of [input, rebuiltInput]) {
      const projected = projectCanonicalCourse(importCanonicalCourse(submitted));
      const savedR5 = fresh(toFhirR5Dosages(fresh(projected.fhirNext)));
      for (const extensions of [projected.fhir[0].extension,
        projected.fhirNext.step![0].component[0].extension, savedR5[0].extension]) {
        expect(graphChild(extensions).extension).toContainEqual(unknown);
      }
      for (const wire of [projected.fhir, projected.fhirNext, savedR5]) {
        expect(formatSig(wire, "long", { locale: "en", realizationMode: "normalized" }))
          .toContain("1 tablet before sleep");
        expect(formatSig(wire, "long", { locale: "th", realizationMode: "normalized" }))
          .toContain("1 เม็ดก่อนนอน");
      }
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(["measured material", "unit-only destination"] as const)(
    "retains the preparation target without duplicating its quantity: %s", variant => {
      const frame: AdviceFrame = { ...preparation(),
        relation: variant === "measured material" ? AdviceRelation.With : AdviceRelation.To,
        args: variant === "measured material" ? [material()] : [{
          role: AdviceArgumentRole.Destination, relation: AdviceRelation.To,
          text: "100 mL", normalized: "mL", quantity: { value: 100, unit: "mL" }
        }] };
      const row: FhirDosage = { extension: [marker(frame)] };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(en).toBe(variant === "measured material"
          ? "Dilute with 100 mL sterile water." : "Dilute to 100 mL.");
        expect(th).toContain("100 มิลลิลิตร");
        if (variant === "measured material") expect(th).toContain("น้ำปราศจากเชื้อ");
        expect(en.match(/100 mL/gu)).toHaveLength(1);
        expect(th.match(/100 มิลลิลิตร/gu)).toHaveLength(1);
      }
      expect(JSON.stringify(row)).toBe(before);
    });

  it.each([
    [AdviceRelation.Before, true], [AdviceRelation.Before, false],
    [AdviceRelation.After, true], [AdviceRelation.After, false]
  ] as const)("retains the temporal relation once for %s 08:00 (inline=%s)", (relation, inline) => {
    const frame: AdviceFrame = { ...preparation(), relation: inline ? relation : undefined,
      args: [{ ...material(), text: "sterile water", quantity: undefined },
        { role: AdviceArgumentRole.Time, relation, text: "08:00", normalized: "08:00" }] };
    const row: FhirDosage = { extension: [marker(frame)] };
    const before = JSON.stringify(row);
    const enExpected = "Dilute with sterile water " + relation + " 08:00";
    const thRelation = relation === AdviceRelation.Before ? "ก่อน" : "หลัง";
    expect(realizeInstructionAction(frame, "en")).toBe(enExpected);
    expect(realizeInstructionAction(frame, "th")).toContain(thRelation + "08:00");
    for (const input of views(row)) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(enExpected + ".");
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th).toContain("น้ำปราศจากเชื้อ");
      expect(th.match(new RegExp(thRelation + "08:00", "gu"))).toHaveLength(1);
      expect(th.match(new RegExp(thRelation, "gu"))).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["external only", undefined, false], ["external matching display", "Sip gently", false],
    ["explicit method priority", undefined, true], ["explicit method despite external display", "Sip gently", true]
  ] as const)("resolves a code-only configured action while preserving method precedence: %s", (_name, display, explicit) => {
    const coding = { system: "http://snomed.info/sct", code: "421521009", ...(display ? { display } : {}) };
    const instructionActionMap: NonNullable<ParseOptions["instructionActionMap"]> = {
      "sip gently": { code: "sip-gently", display: "Sip gently", i18n: { th: "จิบเบา ๆ" },
        externalCodings: [{ system: coding.system, code: coding.code }] },
      ...(explicit ? { "swallow carefully": { code: "swallow-carefully", display: "Swallow carefully",
        i18n: { th: "กลืนอย่างระมัดระวัง" }, administrationMethod: { system: coding.system, code: coding.code } } } : {})
    };
    const options = { instructionActionMap };
    const row: FhirDosage = { method: { coding: [coding] }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const before = JSON.stringify(row);
    expect(resolveMedicationInstructionActionByMethod(coding, options)?.code)
      .toBe(explicit ? "swallow-carefully" : "sip-gently");
    expect(fromFhirDosage(row, { ...options, locale: "en", realizationMode: "normalized" }).longText)
      .toBe((explicit ? "Swallow carefully" : "Sip gently") + " 1 tablet.");
    expect(fromFhirDosage(row, { ...options, locale: "th", realizationMode: "normalized" }).longText)
      .toContain(explicit ? "กลืนอย่างระมัดระวัง" : "จิบเบา ๆ");
    expect(projectCanonicalCourse(importCanonicalCourse(row)).fhir[0].method?.coding).toEqual([coding]);
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each(["changed", "unchanged", "removed"] as const)(
    "uses the current Site translation in a fresh rich primary: %s", variant => {
      const siteCoding = { system: "http://snomed.info/sct", code: "39937001", display: "Skin" };
      const frame: AdviceFrame = { ...fresh(parseInstructionActions("Apply 1 g thinly to skin")[0]),
        sourceText: "" };
      frame.args = frame.args.map(arg => arg.role === AdviceArgumentRole.Site ? {
        ...arg, text: "skin", normalized: "skin", coding: siteCoding, codings: [siteCoding],
        i18n: { th: "ผิวหนังเดิม" }
      } : arg);
      const text = variant === "changed" ? "ผิวหนังใหม่" : "ผิวหนังเดิม";
      const row: FhirDosage = { method: { text: "Apply" },
        doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
        site: { text: "skin", coding: [siteCoding], ...(variant !== "removed" ? {
          _text: { extension: [{ url: "http://hl7.org/fhir/StructureDefinition/translation", extension: [
            { url: "lang", valueCode: "th" }, { url: "content", valueString: text }
          ] }] }
        } : {}) }, extension: [marker(frame)] };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
          .toBe("Apply 1 g thinly to skin.");
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(th).toContain("1 g");
        expect(th).toContain("บางๆ");
        expect(th).toContain(variant === "removed" ? "ผิวหนัง" : text);
        if (variant !== "unchanged") expect(th).not.toContain("ผิวหนังเดิม");
        expect(parseInstructionGraphExtension(toFhirR5Dosages(input)[0].extension)!
          .actions[0].args.find(arg => arg.role === AdviceArgumentRole.Site)?.i18n?.th).toBe("ผิวหนังเดิม");
      }
      expect(JSON.stringify(row)).toBe(before);
    });
});


describe("round58 cadence prose ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["three times daily", 1], ["twice daily", 2], ["Twice Daily", 1]
  ] as const)("keeps cadence prose %s subordinate to the current %s-per-day facts", (text, frequency) => {
    const code = { id: "authored-cadence-label", text,
      extension: [{ url: "https://example.test/timing-label-note", valueString: "retain authored label" }] };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code, repeat: { frequency, period: 1, periodUnit: "d" } } };
    const native: FhirR6DosageInstruction = { step: [{ component: [fresh(row)] }] };
    const before = fresh({ row, native });
    const saved = fresh(toFhirR5Dosages(native));
    const reopened = fresh(toDosageDetails(saved));
    for (const input of [row, native, saved, reopened]) {
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
        const rendered = formatSig(input, style, { locale, realizationMode: "normalized" });
        const cadence = locale === "th" ? frequency === 1 ? "วันละครั้ง" : "วันละ 2 ครั้ง"
          : style === "short" ? `${frequency}x/d` : frequency === 1 ? "once daily" : "twice daily";
        expect(rendered.split(cadence)).toHaveLength(2);
        if (locale === "en" && style === "long" && frequency === 2)
          expect(rendered.match(/twice daily/gu)).toHaveLength(1);
        else expect(rendered.toLowerCase()).not.toContain(text.toLowerCase());
      }
    }
    expect(saved[0].timing?.code).toEqual(code);
    expect(reopened.step![0].component[0].timing?.code).toEqual(code);
    expect(toDosageDetails([fresh(row)]).step![0].component[0].timing?.code).toEqual(code);
    expect({ row, native }).toEqual(before);
  });

  it("retains recognized cadence prose when there is no typed recurrence to replace it", () => {
    const code = { text: "twice daily", id: "label-without-repeat" };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { code } };
    const native: FhirR6DosageInstruction = { step: [{ component: [fresh(row)] }] };
    const before = fresh({ row, native });
    const saved = fresh(toFhirR5Dosages(native));
    const reopened = fresh(toDosageDetails(saved));
    for (const input of [row, native, saved, reopened]) {
      for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const)
        expect(formatSig(input, style, { locale, realizationMode: "normalized" }).match(/twice daily/gu)).toHaveLength(1);
    }
    expect(saved[0].timing).toEqual({ code });
    expect(reopened.step![0].component[0].timing).toEqual({ code });
    expect(toDosageDetails([fresh(row)]).step![0].component[0].timing).toEqual({ code });
    expect({ row, native }).toEqual(before);
  });
});


describe("round59 graph argument fidelity and current action coverage", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const actionChild = (marker: FhirExtension) => marker.extension!.find(entry => entry.url === "action")!;
  const waterArgument = (marker: FhirExtension) => actionChild(marker).extension!
    .find(entry => entry.url === "argument" && entry.extension?.some(child =>
      child.url === "text" && child.valueString === "water"))!;

  it.each(["r5", "r6"] as const)("retains opaque argument children through the public codec and fresh %s projections", kind => {
    const frame = fresh(parseInstructionActions("Mix with water")[0]);
    const water = frame.args.find(arg => arg.text === "water")!;
    water.quantity = { value: 100, unit: "mL" };
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const known = buildInstructionGraphExtension(graph)!;
    const supplied = fresh(known);
    const opaque: FhirExtension = { url: "https://example.test/clinic-argument-provenance", id: "water-note",
      extension: [{ url: "source", valueString: "authored water provenance" },
        { url: "flag", valueBoolean: false }, { url: "zero", valueInteger: 0 },
        { url: "nested", extension: [{ url: "value", valueString: "retain this complete child" }] }] };
    waterArgument(supplied).extension!.push(opaque);
    const row: FhirDosage = { extension: [supplied] };
    const input = kind === "r5" ? [row] : { step: [{ component: [row] }] };
    const before = fresh(input);
    const decoded = parseInstructionGraphExtension(row.extension)!;
    const rebuilt = buildInstructionGraphExtension(decoded)!;
    expect(waterArgument(rebuilt).extension).toContainEqual(opaque);
    expect(waterArgument(rebuilt).extension!.filter(entry => entry.url !== opaque.url))
      .toEqual(waterArgument(known).extension);
    expect(buildInstructionGraphExtension(parseInstructionGraphExtension([known]))).toEqual(known);
    expect(decoded.actions[0].args.find(arg => arg.text === "water")).toMatchObject({
      relation: AdviceRelation.With, quantity: { value: 100, unit: "mL" }
    });
    for (const submitted of [input, kind === "r5" ? [{ extension: [rebuilt] }] :
      { step: [{ component: [{ extension: [rebuilt] }] }] }]) {
      const projected = projectCanonicalCourse(importCanonicalCourse(submitted));
      const saved = fresh(toFhirR5Dosages(fresh(projected.fhirNext)));
      for (const extensions of [projected.fhir[0].extension,
        projected.fhirNext.step![0].component[0].extension, saved[0].extension]) {
        const marker = extensions!.find(entry => entry.url.endsWith("medication-instruction-graph"))!;
        expect(waterArgument(marker).extension).toContainEqual(opaque);
      }
      for (const wire of [projected.fhir, projected.fhirNext, saved]) {
        const rendered = formatSig(wire, "long", { locale: "en", realizationMode: "normalized" });
        expect(rendered).toContain("water");
        expect(rendered).toContain("100 mL");
      }
    }
    expect(input).toEqual(before);
  });

  it.each([
    ["more than half a tablet", 0.5, ">"],
    ["more than half of a tablet", 0.5, ">"],
    ["more than 0.5 tablet", 0.5, ">"],
    ["at most a quarter of a tablet", 0.25, "<="]
  ] as const)("keeps the prohibited qualified amount and source span: %s", (amount, value, comparator) => {
    const source = "Do not swallow " + amount;
    const frame = parseInstructionActions(source)[0];
    expect(frame.polarity).toBe(AdvicePolarity.Negate);
    const argument = frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    expect(argument?.quantity).toEqual({ value, unit: "tab", comparator });
    expect(argument.text).toBe(amount);
    expect(source.slice(argument.span!.start, argument.span!.end)).toBe(amount);
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const reopened = parseInstructionGraphExtension([fresh(marker)])!.actions[0];
    expect(reopened.polarity).toBe(AdvicePolarity.Negate);
    expect(reopened.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toMatchObject({ value, unit: "tab", comparator });
    for (const graph of [{ sourceText: source, sourceLocale: "en", actions: [frame] },
      parseInstructionGraphExtension([fresh(marker)])!]) {
      expect(realizeInstructionGraph(graph, "en")).toBe(source);
      expect(realizeInstructionGraph(graph, "th")).toBe(comparator === ">"
        ? "ห้ามกลืน มากกว่า 0.5 เม็ด"
        : "ห้ามกลืน ไม่เกิน 0.25 เม็ด");
    }
  });

  it.each(["Take 1 tablet", "Take 1 tablet slowly", "Take 1 tablet if SBP > 160"])(
    "omits only a covered bare primary after a fresh dose edit: %s", source => {
      const parsed = parsePublicSig(source);
      const original = fresh(toFhirR5Dosages(parsed.fhir)[0]);
      const conditionAt = source.indexOf(" if");
      const graph = { sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: { start: 0, end: conditionAt >= 0 ? conditionAt : source.length },
        actions: fresh(parseInstructionActions(source)),
        coverage: { complete: true, ratio: 1, understoodCharacters: source.length, opaqueCharacters: 0 } };
      const marker = buildInstructionGraphExtension(graph)!;
      original.extension = (original.extension ?? []).filter(entry => !entry.url.endsWith("medication-instruction-graph"));
      original.extension.push(marker);
      const edited = fresh(original);
      edited.doseAndRate![0].doseQuantity!.value = 2;
      const before = fresh(edited);
      for (const input of [[edited], toDosageDetails([fresh(edited)]),
        fresh(toFhirR5Dosages(toDosageDetails([fresh(edited)])))]) {
        for (const locale of ["en", "th"]) {
          const rendered = formatSig(input, "long", { locale, realizationMode: "normalized" });
          expect(rendered).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
          expect(rendered.match(locale === "en"
            ? /(?:^|[^0-9.])2 tablets(?![A-Za-z0-9])/gu
            : /(?:^|[^0-9.])2 เม็ด/gu)).toHaveLength(1);
          expect(rendered).not.toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
          expect(rendered).not.toMatch(locale === "en" ? /[.]\s*Take[.]/u : /[.]\s*รับประทาน[.]/u);
          if (source.includes("slowly")) expect(rendered).toContain("slowly");
          if (conditionAt >= 0) expect(rendered.match(/SBP > 160/gu)).toHaveLength(1);
        }
      }
      expect(edited).toEqual(before);
      expect(edited.extension).toContainEqual(marker);
      expect(formatSig([original], "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("1 tablet");
    });
});


describe("round62 selected action ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([["mix", false], ["mix", true], ["clinic-mix", false], ["clinic-mix", true]] as const)(
    "retains the selected procedure dose with shared code %s (selected first %s)", (code, selectedFirst) => {
    const selected = { code, display: "Disperse", semanticClass: "procedure",
      procedural: true, acceptsAmount: true, definesDose: true,
      argumentParser: "amount-material-destination" as const, realizer: "amount-material-destination" as const };
    const other = { ...getMedicationInstructionAction("mix")!, code, display: "Blend",
      aliases: [], definesDose: false };
    const options: ParseOptions = { instructionActionMap: selectedFirst
      ? { disperse: selected, blend: other } : { blend: other, disperse: selected } };
    const beforeOptions = JSON.stringify(options);
    const parsed = parsePublicSig("Disperse 2 tablets in water", options);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 2, unit: "tab" });
    expect(clause.instructionGraph!.actions).toHaveLength(1);
    const action = clause.instructionGraph!.actions[0];
    expect(action.predicate).toMatchObject({ lemma: code, display: "Disperse", semanticClass: "procedure" });
    if (code === "clinic-mix") expect(clause.evidence.some(item => item.rule === "hpsg.lex.patientInstruction.procedure")).toBe(true);
    expect(action.args.filter(arg => arg.role === AdviceArgumentRole.Amount).map(arg => arg.quantity))
      .toEqual([{ value: 2, unit: "tab" }]);
    const values = [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext),
      fresh(toDosageDetails(fresh(parsed.fhir)))];
    for (const input of values) {
      const before = JSON.stringify(input), course = importCanonicalCourse(input);
      expect(course.stages).toHaveLength(1);
      expect(course.stages[0].administrations).toHaveLength(1);
      expect(course.stages[0].administrations[0].amounts).toMatchObject([
        { quantity: { value: 2, unit: "tab" } },
      ]);
      expect(JSON.stringify(input)).toBe(before);
    }
    for (const row of [parsed.fhir[0], parsed.fhirNext.step![0].component[0]])
      expect(row.doseAndRate).toMatchObject([{ doseQuantity: { value: 2, unit: "tab" } }]);
    expect(parsed.longText).toBe("Disperse 2 tablets in water.");
    const edited = fresh(parsed.fhir);
    edited[0].doseAndRate![0].doseQuantity!.value = 3;
    const beforeEdit = JSON.stringify(edited), r6 = toDosageDetails(edited);
    for (const input of [edited, fresh(r6), fresh(toFhirR5Dosages(r6))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { ...options, locale: "en", realizationMode }))
          .toBe("Disperse 3 tablets in water.");
        // This selected head has no declared Thai label. Its shared code
        // cannot borrow the unrelated built-in Mix translation.
        expect(formatSig(input, "long", { ...options, locale: "th", realizationMode }))
          .toBe("Disperse 3 เม็ดในน้ำ.");
      }
    expect(JSON.stringify(edited)).toBe(beforeEdit);
    expect(JSON.stringify(options)).toBe(beforeOptions);
  });

  it.each([false, true])("retains the selected Thai action label through saved roundtrip display (custom %s)", custom => {
    const options: ParseOptions | undefined = custom ? { instructionActionMap: {
      rinse: { ...getMedicationInstructionAction("rinse")!, i18n: { th: "ชะล้าง" }, roundtripI18n: undefined }
    } } : undefined;
    const beforeOptions = JSON.stringify(options);
    const parsed = parsePublicSig("Take 1 tablet daily; rinse with water", options);
    expect(parsed.meta.canonical.clauses[0].instructionGraph!.actions.find(action => action.predicate.lemma === "rinse")?.predicate)
      .toMatchObject({ display: "Rinse", i18n: { th: custom ? "ชะล้าง" : "ล้าง" } });
    const edited = fresh(parsed.fhir);
    edited[0].doseAndRate![0].doseQuantity!.value = 2;
    const r6 = toDosageDetails(edited);
    for (const input of [edited, fresh(r6), fresh(toFhirR5Dosages(r6))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const label = custom ? "ชะล้าง" : realizationMode === "roundtrip" ? "ล้างออก" : "ล้าง";
        const take = realizationMode === "normalized" ? "รับประทานครั้งละ" : "รับประทาน";
        // The saved frame owns its translation without the original parse options.
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe(`${take} 2 เม็ด วันละครั้ง. ${label}ด้วยน้ำ.`);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(options)).toBe(beforeOptions);
  });

  it.each((["none", "minimal", "procedure"] as const).flatMap(kind => [
    { kind, source: "Take 1 tablet at onset of pain, call your doctor" },
    { kind, source: "Take 1 tablet when pain begins then call your doctor" }
  ]))(
    "keeps the built-in dose's pain onset beside an independent call ($kind collision): $source", ({ kind, source }) => {
      const options: ParseOptions | undefined = kind === "none" ? undefined : { instructionActionMap: {
        "custom-mix": kind === "minimal"
          ? { code: "take", display: "Custom mix", procedural: true, definesDose: false }
          : { ...getMedicationInstructionAction("mix")!, code: "take", display: "Custom mix",
            aliases: [], procedural: true, definesDose: false,
            primaryAdministrationHead: false, administrationMethod: undefined },
      } };
      const beforeOptions = JSON.stringify(options);
      const parsed = parsePublicSig(source, options);
      expect(parsed.meta.canonical.clauses).toHaveLength(1);
      const clause = parsed.meta.canonical.clauses[0];
      expect(clause.dose).toEqual({ value: 1, unit: "tab" });
      expect(clause.prn).toMatchObject({ enabled: true, reason: {
        text: "pain", triggerPhase: "onset",
        coding: { system: "http://snomed.info/sct", code: "22253000", display: "Pain" },
      } });
      expect(clause.instructionGraph!.actions).toHaveLength(1);
      const call = clause.instructionGraph!.actions[0];
      expect(call.predicate.lemma).toBe("call");
      expect(call.relation).toBeUndefined();
      expect(call.args).toEqual([{ role: AdviceArgumentRole.Object, text: "your doctor", normalized: "your doctor" }]);
      const values = [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext),
        fresh(toDosageDetails(fresh(parsed.fhir)))];
      for (const input of values) {
        const before = JSON.stringify(input), course = importCanonicalCourse(input);
        expect(course.stages).toHaveLength(1);
        expect(course.stages[0].administrations).toHaveLength(1);
        expect(course.stages[0].administrations[0]).toMatchObject({
          amounts: [{ quantity: { value: 1, unit: "tab" } }], asNeeded: true,
        });
        expect(JSON.stringify(input)).toBe(before);
      }
      for (const row of [parsed.fhir[0], parsed.fhirNext.step![0].component[0]]) {
        expect(row.doseAndRate).toMatchObject([{ doseQuantity: { value: 1, unit: "tab" } }]);
        expect(row.asNeeded).toBe(true);
        expect(row.asNeededFor).toMatchObject([{ text: "pain",
          coding: [{ system: "http://snomed.info/sct", code: "22253000", display: "Pain" }],
          extension: [{ url: "urn:ezmedicationinput:StructureDefinition:medication-prn-trigger-phase", valueCode: "onset" }],
        }]);
      }
      expect(parsed.longText).toBe("Take 1 tablet orally at onset of pain; then call your doctor.");
      expect(JSON.stringify(options)).toBe(beforeOptions);
    });
});

describe("round59 stored action codes keep their selected lexical meaning", () => {
  const configured = { ...getMedicationInstructionAction("mix")!, code: "take", aliases: [],
    display: "Custom mix", procedural: true, definesDose: false };
  it.each([false, true])("keeps both dosage alternatives with a distinct configured code collision (%s)", custom => {
    const options: ParseOptions | undefined = custom ? { instructionActionMap: { "custom-mix": configured } } : undefined;
    const source = "Take 1 tablet in the morning or take 2 tablets at bedtime";
    const result = parsePublicSig(source, options);
    expect(result.meta.canonical.clauses).toHaveLength(2);
    const administrations = result.meta.canonical.course.stages[0].administrations;
    expect(administrations).toHaveLength(2);
    expect(administrations.map(item => item.amounts![0].quantity?.value)).toEqual([1, 2]);
    expect(administrations.map(item => item.schedule?.recurrence?.anchors)).toEqual([["MORN"], ["HS"]]);
    expect(administrations.map(item => item.choice)).toEqual([
      { groupId: "choice-1", branchId: "branch-1" }, { groupId: "choice-1", branchId: "branch-2" }
    ]);
    expect(result.longText).toContain("Choose one:");
    expect(result.longText).toContain("1 tablet orally in the morning");
    expect(result.longText).toContain("2 tablets orally at bedtime");
    expect(result.longText).not.toContain("Custom mix");
  });
  it.each(["custom-mix", "take"])("retains the configured procedural meaning of its authored surface: %s", surface => {
    const options: ParseOptions = { instructionActionMap: { [surface]: configured } };
    const source = surface + " with water";
    const frame = parseInstructionActions(source, 0, options)[0];
    expect(frame.predicate).toMatchObject({ lemma: "take", semanticClass: "prepare", display: "Custom mix" });
    expect(frame.args).toContainEqual(expect.objectContaining({ text: "water", relation: AdviceRelation.With }));
    const result = parsePublicSig(source, options);
    expect(result.longText.toLowerCase()).toContain("custom mix with water");
    expect(result.meta.canonical.course.stages[0].administrations[0].amounts).toBeUndefined();
    const savedGraph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: "", sourceLocale: "en", actions: [frame]
    })!])!;
    expect(realizeInstructionGraph(savedGraph, "en")).toContain("Custom mix with water");
  });
});


describe("round61 independent Time relation coverage", () => {
  it.each([AdviceRelation.Until, AdviceRelation.During, AdviceRelation.In, AdviceRelation.On, undefined])(
    "retains the scheduled morning beside an independent %s relation", relation => {
      const original = parseInstructionActions("Hold the eyelid")[0];
      const frame = { ...original, args: [...original.args, {
        role: AdviceArgumentRole.Time, text: "morning", normalized: EventTiming.Morning,
        relation, i18n: { en: "morning", th: "ตอนเช้า" }
      }] };
      const graph = { sourceText: "", sourceLocale: "en", actions: [frame], primaryAdministrationSpan: frame.span };
      const clause = { ...parsePublicSig("in the morning").meta.canonical.clauses[0],
        sourceHasStructuredEvents: false, instructionGraph: graph };
      const before = JSON.stringify(graph);
      const coversPoint = relation === undefined || relation === AdviceRelation.In || relation === AdviceRelation.On;
      for (const locale of ["en", "th"]) {
        const coverage = { singleScheduledEvent: false };
        const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
        expect(text).toContain(locale === "en" ? "morning" : "เช้า");
        expect(coverage.singleScheduledEvent).toBe(coversPoint);
        const preview = formatCanonicalClause(clause, "long", resolveSigLocalization(locale), { realizationMode: "normalized" });
        expect(preview.match(locale === "en" ? /morning/gu : /เช้า/gu)).toHaveLength(coversPoint ? 1 : 2);
        if (relation === AdviceRelation.Until) expect(text).toContain(locale === "en" ? "until" : "จนกว่า");
        if (relation === AdviceRelation.During) expect(text).toContain(locale === "en" ? "during" : "ระหว่าง");
        if (!coversPoint) {
          const directional = relation === AdviceRelation.Until
            ? locale === "en" ? "until the morning" : "จนกว่าตอนเช้า"
            : locale === "en" ? "during the morning" : "ระหว่างตอนเช้า";
          expect(preview.split(directional)).toHaveLength(2);
          const scheduled = preview.replace(directional, "");
          expect(scheduled.match(locale === "en" ? /in the morning/gu : /ตอนเช้า/gu)).toHaveLength(1);
        }
      }
      expect(JSON.stringify(graph)).toBe(before);
    });
});


describe("round62 review: instruction argument ownership", () => {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (row: FhirDosage) => {
    const r6 = fresh(toDosageDetails([fresh(row)]));
    return [fresh(row), r6, fresh(toFhirR5Dosages(r6))];
  };

  it.each(["Dilute 1 mL at 08:00 with saline to 10 mL", "Dilute 1 mL with saline to 10 mL at 08:00"])(
    "keeps material and destination complements on either side of a clock: %s", source => {
      const frame = parseInstructionActions(source)[0];
      expect(frame.args).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: expect.objectContaining({ value: 1, unit: "mL" }) }),
        expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: "08:00:00" }),
        expect.objectContaining({ relation: AdviceRelation.With }),
        expect.objectContaining({ relation: AdviceRelation.To, quantity: expect.objectContaining({ value: 10, unit: "mL" }) })
      ]));
      const graph = { sourceText: "", sourceLocale: "en", actions: [{ ...fresh(frame), sourceText: "" }] };
      const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
      for (const value of views(row)) for (const locale of ["en", "th"]) {
        const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
        expect(text.match(locale === "en" ? /(?:^|[^0-9])1 mL/gu : /(?:^|[^0-9])1 มิลลิลิตร/gu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /10 mL/gu : /10 มิลลิลิตร/gu)).toHaveLength(1);
        expect(text.match(/08:00/gu)).toHaveLength(1);
        expect(text.match(/saline/gu)).toHaveLength(1);
      }
    });

  it.each([false, true])("selects exact case-sensitive saved proposal codes independently of map order: %s", reverse => {
    const lower = { code: "clinic-rinse", display: "Rinse gently", semanticClass: "prepare", procedural: true };
    const upper = { code: "CLINIC-RINSE", display: "Rinse thoroughly", semanticClass: "prepare", procedural: true };
    const source = "Agitate bottle";
    for (const [code, display] of [["clinic-rinse", "Rinse gently"], ["CLINIC-RINSE", "Rinse thoroughly"]]) {
      const options: ParseOptions = {
        instructionActionMap: reverse ? { thorough: upper, gentle: lower } : { gentle: lower, thorough: upper },
        instructionSemanticResolvers: request => request.sourceText === source ? { actions: [{
          action: code, range: { start: 0, end: source.length },
          args: [{ role: AdviceArgumentRole.Container, range: { start: 8, end: 14 }, concept: "bottle" }]
        }] } : undefined
      };
      const parsed = parsePublicSig(source, options);
      const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
      expect(action.predicate).toMatchObject({ lemma: code, display });
      expect(action.predicate.codings).toContainEqual(expect.objectContaining({ code }));
      const saved = parseInstructionGraphExtension([buildInstructionGraphExtension({
        sourceText: "", sourceLocale: "en", actions: [fresh(action)]
      })!])!;
      expect(saved.actions[0].predicate.lemma).toBe(code);
      expect(realizeInstructionGraph(saved, "en")).toContain(display);
    }
  });

  it.each(["at 10:00", "daily"])("localizes an unchanged typed amount independently of opaque manner: %s", timing => {
    const source = "Swallow 1 tablet slowly with water " + timing;
    const options = { locale: "th", realizationMode: "normalized" as const };
    for (const parseOptions of [undefined, options]) {
      const parsed = parsePublicSig(source, parseOptions), before = fresh(parsed.fhir);
      const primary = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
      expect(primary.args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" },
        span: { start: 8, end: 16 }
      }));
      if (parseOptions) {
        expect(parsed.longText).toContain("1 เม็ด");
        expect(parsed.longText).not.toContain("tablet");
      }
      for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir[0]),
        fresh(parsed.fhir), fresh(parsed.fhirNext)]) {
        const original = fresh(input);
        const text = formatSig(input, "long", options);
        expect(text.match(/\b1 เม็ด/gu)).toHaveLength(1);
        expect(text).not.toContain("tablet");
        expect(text).toContain("กลืน");
        expect(text).toContain("slowly");
        expect(text).toContain("น้ำ");
        expect(text).toContain(timing === "daily" ? "วันละครั้ง" : "10:00");
        expect(input).toEqual(original);
      }
      expect(formatSig(parsed.meta.canonical.course!, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(source);
      const roundtrip = { locale: "en", realizationMode: "roundtrip" as const };
      if (!parseOptions) expect(formatSig(fresh(parsed.fhir), "long", roundtrip)).toBe(source);
      else {
        const previews = [formatSig(fresh(parsed.fhir[0]), "long", roundtrip),
          formatSig(fresh(parsed.fhir), "long", roundtrip),
          formatSig(fresh(parsed.fhirNext), "long", roundtrip),
          fromFhirDosage(fresh(parsed.fhir[0]), roundtrip).longText];
        for (const text of previews) {
          expect(text.match(/\b1 tablet\b/gu)).toHaveLength(1);
          expect(text).toContain("slowly");
          expect(text).toContain(timing === "daily" ? "once daily" : "10:00");
        }
      }
      expect(parsed.fhir).toEqual(before);
    }
  });

  it("retires a neutral edited clock while preserving a directional clock constraint", () => {
    const source = "Swallow 1 tablet slowly with water at 10:00";
    const parsed = parsePublicSig(source), original = fresh(parsed.fhir[0]);
    const graph = fresh(parsed.meta.canonical.clauses[0].instructionGraph!);
    const primary = graph.actions.find(action => action.predicate.lemma === "swallow")!;
    expect(primary.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: "10:00:00" }));
    primary.args.push({ role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00", relation: AdviceRelation.After });
    const marker = buildInstructionGraphExtension(graph)!;
    original.extension = [...(original.extension ?? []).filter(extension => extension.url !== marker.url), marker];
    const saved = fresh(withDosageEditProvenance([original], source)[0]);
    saved.timing!.repeat!.timeOfDay = ["11:00:00"];
    const before = fresh(saved);
    for (const value of views(saved)) for (const locale of ["en", "th"]) {
      const text = formatSig(value, "long", { locale, realizationMode: "normalized" });
      expect(text.match(locale === "en" ? /after 08:00/gu : /หลัง08:00/gu)).toHaveLength(1);
      expect(text.match(/11:00/gu)).toHaveLength(1);
      expect(text).not.toContain("10:00");
      expect(importCanonicalCourse(value).stages[0].administrations[0].amounts![0].quantity)
        .toMatchObject({ value: 1, unit: "tab" });
      expect(text).toContain(locale === "en" ? "Swallow" : "กลืน");
      // The owned Amount localizes independently; the uncoded manner stays verbatim.
      expect(text).toContain(locale === "en" ? "slowly 1 tablet" : "slowly 1 เม็ด");
      if (locale === "th") expect(text).not.toContain("tablet");
    }
    expect(saved).toEqual(before);
    expect(saved.extension).toContainEqual(marker);
  });
});

describe("round63 instruction complement and saved coding ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["Dilute before 08:00 to 10 mL", undefined, undefined],
    ["Dilute 1 mL before 08:00 to 10 mL", 1, undefined],
    ["Dilute before 08:00 with 100 mL saline to 10 mL", undefined, 100]
  ] as const)("keeps complement quantities outside the head Amount: %s", (source, expected, vehicle) => {
    const frame = parseInstructionActions(source)[0];
    const amounts = frame.args.filter(arg => arg.role === AdviceArgumentRole.Amount);
    expect(amounts.map(arg => arg.quantity?.value)).toEqual(expected === undefined ? [] : [expected]);
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Destination, quantity: expect.objectContaining({ value: 10, unit: "mL" })
    }));
    const beforeTime = frame.args.filter(arg => arg.role === AdviceArgumentRole.Time && arg.relation === AdviceRelation.Before);
    expect(beforeTime).toHaveLength(1);
    expect(beforeTime[0].text).toBe("08:00");
    const rendered = realizeInstructionAction({ ...frame, sourceText: "" }, "en");
    expect(rendered.match(/10 mL/gu)).toHaveLength(1);
    expect(rendered.match(/before 08:00/gu)).toHaveLength(1);
    if (vehicle !== undefined) {
      expect(frame.args).toContainEqual(expect.objectContaining({ relation: AdviceRelation.With,
        quantity: expect.objectContaining({ value: vehicle, unit: "mL" }) }));
      expect(rendered.match(/100 mL/gu)).toHaveLength(1);
    }
    if (expected !== undefined) expect(rendered.match(/(?:^|[^0-9])1 mL/gu)).toHaveLength(1);
  });

  it("keeps an administration amount following a temporal adjunct", () => {
    const frame = parseInstructionActions("Take before meals 5 mL")[0];
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: expect.objectContaining({ value: 5, unit: "mL" })
    }));
  });

  it.each([false, true])("reconciles the selected preparation before an amountless drink (selected first %s)", selectedFirst => {
    const selected = { code: "clinic-mix", display: "Disperse", semanticClass: "procedure",
      procedural: true, acceptsAmount: true, definesDose: true,
      argumentParser: "amount-material-destination" as const, realizer: "amount-material-destination" as const };
    const other = { ...getMedicationInstructionAction("mix")!, code: "clinic-mix", display: "Blend",
      aliases: [], definesDose: false };
    const options: ParseOptions = { instructionActionMap: selectedFirst
      ? { disperse: selected, blend: other } : { blend: other, disperse: selected } };
    const source = "Disperse 2 tablets in water, then drink slowly";
    const parsed = parsePublicSig(source, options);
    const wire = fresh(parsed.fhirNext);
    wire.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    const before = fresh(wire);
    for (const input of [wire, fresh(toFhirR5Dosages(wire))]) {
      const text = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/Disperse 3 tablets in water/u);
      expect(text).toMatch(/drink slowly/iu);
      expect(text).not.toMatch(/2 tablets|drink 3 tablets/iu);
      expect(text.match(/3 tablets/gu)).toHaveLength(1);
    }
    expect(wire).toEqual(before);
  });

  it.each([false, true].flatMap(translated => [false, true].map(opaque => ({ translated, opaque }))))(
    "retains saved Coding display metadata (translations $translated, opaque $opaque)", ({ translated, opaque }) => {
    const frame = fresh(parseInstructionActions("Swallow 1 tablet")[0]);
    frame.predicate.codings = [{ system: "urn:test:action", code: "swallow", display: "Swallow",
      _display: { id: "clinic-label", ...(opaque ? { extension: [{ url: "urn:test:display", valueInteger: 7 }] } : {}) },
      ...(translated ? { i18n: { th: "กลืน" } } : {}) }];
    const source = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const before = fresh(source);
    const first = buildInstructionGraphExtension(source)!;
    const rebuilt = buildInstructionGraphExtension(parseInstructionGraphExtension([first])!)!;
    for (const value of [first, rebuilt]) {
      const action = value.extension!.find(item => item.url === "action")!;
      const coding = action.extension!.find(item => item.url === "predicateCoding")!.valueCoding!;
      expect(coding._display?.id).toBe("clinic-label");
      if (opaque) expect(coding._display?.extension).toContainEqual({ url: "urn:test:display", valueInteger: 7 });
      const translation = coding._display?.extension?.find(item => item.url === "http://hl7.org/fhir/StructureDefinition/translation");
      if (translated) expect(translation?.extension).toEqual(expect.arrayContaining([
        { url: "lang", valueCode: "th" }, { url: "content", valueString: "กลืน" }
      ]));
      else expect(translation).toBeUndefined();
    }
    expect(source).toEqual(before);
  });

  it("does not create display metadata when the coding has none", () => {
    const frame = fresh(parseInstructionActions("Swallow 1 tablet")[0]);
    frame.predicate.codings = [{ system: "urn:test:action", code: "swallow", display: "Swallow" }];
    const value = buildInstructionGraphExtension({ sourceText: "", actions: [frame] })!;
    const action = value.extension!.find(item => item.url === "action")!;
    expect(action.extension!.find(item => item.url === "predicateCoding")!.valueCoding!._display).toBeUndefined();
  });
});


describe("round65 structured cadence and action ownership", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([undefined, 90])("retains frequency and authored seconds in both locale previews (%s)", periodMax => {
    const repeat = { frequency: 2, period: 60, ...(periodMax ? { periodMax } : {}), periodUnit: "s" as const };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "mL" } }], timing: { repeat } };
    const r6 = toDosageDetails([row]);
    for (const input of [row, fresh(r6), importCanonicalCourse(row)]) {
      const before = fresh(input);
      expect(formatSig(input, "long", { locale: "en" }))
        .toContain(periodMax ? "twice every 60 to 90 seconds" : "twice every 60 seconds");
      for (const style of ["short", "long"] as const)
        expect(formatSig(input, style, { locale: "th" }))
          .toContain(periodMax ? "2 ครั้ง ทุก 60 ถึง 90 วินาที" : "2 ครั้ง ทุก 60 วินาที");
      expect(input).toEqual(before);
    }
    expect(row.timing!.repeat).toEqual(repeat);
    expect(r6.step![0].component[0].timing!.repeat).toEqual(repeat);
  });

  it.each([false, true])("keeps a mixing vehicle and container in either saved argument order (%s)", reverse => {
    const frame = fresh(parseInstructionActions("Mix powder with water")[0]);
    frame.sourceText = "";
    frame.args = [
      { role: AdviceArgumentRole.Theme, text: "powder", normalized: "powder", i18n: { en: "the powder", th: "ผงยา" } },
      { role: AdviceArgumentRole.Substance, text: "water", normalized: "water", i18n: { en: "water", th: "น้ำ" },
        relation: AdviceRelation.With, quantity: { value: 100, unit: "mL" } },
      { role: AdviceArgumentRole.Container, text: "cup", normalized: "cup", i18n: { en: "a cup", th: "ถ้วย" }, relation: AdviceRelation.In }
    ];
    if (reverse) [frame.args[1], frame.args[2]] = [frame.args[2], frame.args[1]];
    const marker = buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!;
    const before = fresh(marker), reopened = parseInstructionGraphExtension([fresh(marker)])!.actions[0];
    const en = realizeInstructionAction(reopened, "en"), th = realizeInstructionAction(reopened, "th");
    expect(en).toContain("the powder");
    expect(en.match(/with 100 mL water/gu)).toHaveLength(1);
    expect(en.match(/in a cup/gu)).toHaveLength(1);
    expect(th).toContain("ผงยา");
    expect(th).toContain("น้ำ 100 มิลลิลิตร");
    expect(th).toContain("ในถ้วย");
    expect(marker).toEqual(before);
  });

  it.each([false, true])("keeps a selected site's relation beside an independent application instrument (site first=%s)", siteFirst => {
    const frame = fresh(parseInstructionActions("Apply cream")[0]);
    frame.sourceText = ""; frame.relation = AdviceRelation.With; frame.predicate.realizer = "default";
    frame.args = [
      { role: AdviceArgumentRole.Theme, text: "cream", normalized: "cream", i18n: { en: "the cream", th: "ครีม" } },
      { role: AdviceArgumentRole.Site, text: "rash", normalized: "rash", i18n: { en: "the rash", th: "ผื่น" }, relation: AdviceRelation.To },
      { role: AdviceArgumentRole.Material, text: "cotton swab", normalized: "cotton swab", i18n: { en: "a cotton swab", th: "สำลี" }, relation: AdviceRelation.With }
    ];
    if (siteFirst) [frame.args[0], frame.args[1]] = [frame.args[1], frame.args[0]];
    const marker = buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!;
    const before = fresh(marker), reopened = parseInstructionGraphExtension([fresh(marker)])!.actions[0];
    const en = realizeInstructionAction(reopened, "en"), th = realizeInstructionAction(reopened, "th");
    expect(en).toContain("the cream"); expect(en).toContain("to the rash"); expect(en).toContain("with a cotton swab");
    expect(th).toContain("ครีม"); expect(th).toContain("ผื่น"); expect(th).toContain("สำลี");
    expect(marker).toEqual(before);
  });

  it("does not replace an explicit primary with a later equal-valued independent action", () => {
    const source = "Take 1 tablet, then drink 5 mL with water";
    const actions = parseInstructionActions(source);
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: actions[0].span, actions })!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 5, unit: "mL" } }], extension: [marker] };
    const before = fresh(row), imported = fromFhirDosage(row);
    expect(instructionGraphRichPrimaryAction(imported.meta.canonical.clauses[0])).toBeUndefined();
    for (const input of [row, fresh(toDosageDetails([row]))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text.match(/5 mL/gu)).toHaveLength(2);
      expect(text.toLowerCase()).toContain("drink 5 ml with water");
      expect(text).not.toContain("1 tablet");
    }
    expect(row).toEqual(before);
  });
});

describe("round65 composed meal-state ownership", () => {
  it("uses registered water wording while retaining an opaque qualification", () => {
    const plain = parseSig("Take 1 tablet with water");
    expect(formatSig(plain.meta.canonical.course!, "long", { locale: "th" })).toContain("น้ำ");
    const qualified = parseSig("Take 1 tablet with cool water");
    expect(formatSig(qualified.meta.canonical.course!, "long", { locale: "th" })).toContain("cool water");
  });
  it.each(["empty stomach", "an empty stomach"])("retains coded %s and its independent water adjunct once", nominal => {
    const source = "Take 1 tablet on " + nominal + " with water; wait 30 minutes before food, drink, or other meds";
    const parsed = parseSig(source), clause = parsed.meta.canonical.clauses[0];
    expect(clause.additionalInstructions?.some(instruction => instruction.coding?.code === "717154004")).toBe(true);
    expect(clause.additionalInstructions?.flatMap(instruction => instruction.frames ?? []).flatMap(frame => frame.args))
      .toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Substance, conceptId: "water" }));
    const original = JSON.stringify([parsed.fhir, parsed.fhirNext]);
    for (const value of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)), JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const en = formatSig(value, "long", { locale: "en" });
      expect(en.match(/1 tablet/giu)).toHaveLength(1);
      expect(en).toContain("empty stomach");
      expect(en).toContain("water");
      expect(en).toMatch(/wait 30 minutes before food, drink or other medicines/iu);
      const th = formatSig(value, "long", { locale: "th" });
      expect(th.match(/1 เม็ด/gu)).toHaveLength(1);
      expect(th).toContain("ท้องว่าง");
      expect(th).toContain("น้ำ");
      expect(th).not.toMatch(/Take|tablet|stomach|water/iu);
      expect(th).toContain("30 นาที");
    }
    expect(JSON.stringify([parsed.fhir, parsed.fhirNext])).toBe(original);
  });
});

describe("round66 persisted primary action and amount ownership", () => {
  const options: ParseOptions = { instructionActionMap: { disperse: {
    code: "disperse", display: "Disperse", semanticClass: "prepare",
    i18n: { th: "กระจายยา" }, procedural: true, acceptsAmount: true, definesDose: true,
    argumentParser: "amount-material-destination", realizer: "amount-material-destination"
  } } };
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each(["drink slowly", "swallow slowly with water at 10:00"])(
    "retains the original quantity owner when reopening a configured preparation before %s", ending => {
      const parsed = parsePublicSig("Disperse 2 tablets in 100 mL water, then " + ending, options);
      const binding = { ...(ending.startsWith("swallow") ? { administrationActionIndex: 1 } : {}),
        dose: { actionIndex: 0, argumentIndex: 0 } };
      expect(parsed.meta.canonical.clauses[0].instructionGraph?.primaryOwnership).toEqual(binding);
      for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)])
        expect(parseInstructionGraphExtension(rows[0].extension)?.primaryOwnership).toEqual(binding);
      const rows = fresh(parsed.fhir), r6 = fresh(parsed.fhirNext);
      rows[0].doseAndRate![0].doseQuantity!.value = 3;
      r6.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
      for (const input of [rows, r6]) {
        const before = JSON.stringify(input);
        for (const locale of ["en", "th"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
          expect(text).toMatch(locale === "en" ? /^Disperse 3 tablets/u : /^กระจายยา\s*3 เม็ด/u);
          expect(text.match(locale === "en" ? /3 tablets/gu : /3 เม็ด/gu)).toHaveLength(1);
          expect(text).not.toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
          expect(text).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
          const swallow = ending.startsWith("swallow");
          const administrationStart = text.search(locale === "en"
            ? (swallow ? /\bswallow\b/iu : /\bdrink\b/iu)
            : (swallow ? /กลืน/u : /ดื่ม/u));
          expect(administrationStart).toBeGreaterThan(0);
          if (swallow) {
            expect(text.slice(administrationStart)).toMatch(/(?:^|[^\d:])10:00(?::00)?(?: am)?(?![\d:])/u);
            expect(text.slice(0, administrationStart)).not.toMatch(/(?:^|[^\d:])10:00(?::00)?(?: am)?(?![\d:])/u);
          }
        }
        expect(JSON.stringify(input)).toBe(before);
      }
    });

  it("retains separate owners and unknown graph metadata through reordered marker fields and a fresh edit", () => {
    const source = "Disperse 2 tablets in 100 mL water, then swallow slowly with water at 10:00";
    const rows = fresh(parsePublicSig(source, options).fhir);
    const marker = rows[0].extension!.find(field => field.extension?.some(child => child.url === "primaryOwnership"))!;
    const ownership = marker.extension!.find(field => field.url === "primaryOwnership")!;
    ownership.id = "retained-source-owner";
    ownership.extension!.push({ url: "https://example.org/owner-note", valueString: "original source binding" });
    ownership.extension!.reverse();
    marker.extension!.push({ url: "https://example.org/graph-note", valueString: "keep this metadata" });
    // Scalar child order is independent of the repeated action/argument order.
    marker.extension = marker.extension!.filter(field => field !== ownership).concat(ownership);
    const savedMarker = fresh(marker);
    rows[0].doseAndRate![0].doseQuantity!.value = 3;
    const before = fresh(rows), r6 = fresh(toDosageDetails(rows));
    const reopened = fresh(toFhirR5Dosages(r6));
    for (const current of [rows, reopened]) {
      expect(current[0].extension!.find(field => field.url === marker.url)).toEqual(savedMarker);
      const graph = parseInstructionGraphExtension(current[0].extension)!;
      expect(graph.primaryOwnership).toMatchObject({ administrationActionIndex: 1, dose: { actionIndex: 0, argumentIndex: 0 } });
      expect(graph.actions[1].predicate.lemma).toBe("swallow");
      expect(graph.actions[0].args[0].quantity).toMatchObject({ value: 2, unit: "tab" });
      const rebuilt = buildInstructionGraphExtension(graph)!.extension!.filter(field => field.url === "primaryOwnership");
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0].id).toBe("retained-source-owner");
      expect(rebuilt[0].extension).toContainEqual({ url: "https://example.org/owner-note", valueString: "original source binding" });
      const text = formatSig(current, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/^Disperse 3 tablets in 100 mL water/u);
      expect(text.match(/3 tablets/gu)).toHaveLength(1);
      expect(text).toContain("10:00");
    }
    expect(rows).toEqual(before);
  });

  it("remaps the same owners when an existing semantic resolver inserts an earlier action", () => {
    const source = "local procedure; Disperse 2 tablets in 100 mL water, then swallow slowly with water at 10:00";
    const parsed = parsePublicSig(source, { ...options, instructionSemanticResolvers: request => ({
      actions: [{ action: "cover", range: { start: 0, end: request.sourceText.length }, args: [{
        role: AdviceArgumentRole.Object, range: { start: 0, end: request.sourceText.length }, concept: "occlusive dressing"
      }] }]
    }) });
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["cover", "disperse", "swallow"]);
    expect(graph.primaryOwnership).toEqual({ administrationActionIndex: 2, dose: { actionIndex: 1, argumentIndex: 0 } });
    const rows = fresh(parsed.fhir);
    rows[0].doseAndRate![0].doseQuantity!.value = 3;
    for (const input of [rows, fresh(toDosageDetails(rows))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/disperse 3 tablets in 100 mL water/iu);
      expect(text.match(/3 tablets/gu)).toHaveLength(1);
      expect(text.toLowerCase()).toContain("swallow slowly with water");
      expect(text).toContain("10:00");
    }
  });

  it("keeps resolved absence distinct from an older graph with no binding record", () => {
    const graph = parsePublicSig("Do not dissolve 2 tablets in 100 mL water").meta.canonical.clauses[0].instructionGraph!;
    expect(graph.primaryOwnership).toEqual({});
    const marker = buildInstructionGraphExtension(graph)!;
    expect(marker.extension!.find(field => field.url === "primaryOwnership")).toEqual({
      url: "primaryOwnership", extension: [{ url: "resolved", valueBoolean: true }]
    });
    expect(parseInstructionGraphExtension([fresh(marker)])?.primaryOwnership).toEqual({});
    const legacy = fresh(marker);
    legacy.extension = legacy.extension!.filter(field => field.url !== "primaryOwnership");
    const reopened = parseInstructionGraphExtension([legacy])!;
    expect(reopened.primaryOwnership).toBeUndefined();
    expect(realizeInstructionGraph(reopened, "en")).toBe("Do not dissolve 2 tablets in 100 mL water");
  });

  it.each(["Dissolve", "Disperse"])("keeps an independent preparation clock when the %s amount owner is not the administration head", verb => {
    const parsed = parsePublicSig(verb + " 2 tablets in 100 mL water at 08:00, then drink at 10:00", options);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.schedule?.timeOfDay).toEqual(["10:00:00"]);
    expect(clause.instructionGraph?.primaryOwnership?.administrationActionIndex).toBeUndefined();
    expect(clause.instructionGraph?.primaryOwnership?.dose).toBeDefined();
    expect(clause.instructionGraph?.actions[0].args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Time, normalized: "08:00:00"
    }));
    for (const input of [parsed.meta.canonical.course!, fresh(parsed.fhir), fresh(parsed.fhirNext)])
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        const administrationStart = text.search(locale === "en" ? /\bdrink\b/iu : /ดื่ม/u);
        expect(administrationStart).toBeGreaterThan(0);
        const preparation = text.slice(0, administrationStart), administration = text.slice(administrationStart);
        const preparationClock = /(?:^|[^\d:])0?8:00(?::00)?(?: am\b|(?!\s*[ap]m\b))(?![\d:])/giu;
        const administrationClock = /(?:^|[^\d:])10:00(?::00)?(?: am\b|(?!\s*[ap]m\b))(?![\d:])/giu;
        expect(preparation.match(preparationClock)).toHaveLength(1);
        expect(preparation).not.toMatch(administrationClock);
        expect(administration.match(administrationClock)).toHaveLength(1);
        expect(administration).not.toMatch(preparationClock);
        expect(preparation).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
      }
  });
});


describe("round67 review timing and graph preservation", () => {
  const fresh = <T>(input: T): T => JSON.parse(JSON.stringify(input));
  const graphMarker = (frame: AdviceFrame) => buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!;
  const savedViews = (row: FhirDosage) => [fresh([row]), fresh(toDosageDetails([row]))];

  it.each([EventTiming.Morning, EventTiming.Night])("keeps the offset range beside alternate %s cadence", when => {
    const input: FhirR6DosageInstruction = { step: [{ component: [{
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], timing: { repeat: {
        period: 2, periodUnit: "d", when: [when], extension: [
          { url: TIMING_OFFSET_MIN_EXTENSION_URL, valueDecimal: 15 },
          { url: TIMING_OFFSET_MAX_EXTENSION_URL, valueDecimal: 30 }
        ]
      } }
    }] }] };
    const before = fresh(input);
    for (const wire of [input, fresh(toFhirR5Dosages(input))]) {
      const en = formatSig(wire, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("every other day"); expect(en).toContain("15–30 minutes");
      expect(en).toContain(when === EventTiming.Morning ? "morning" : "night");
      expect(th).toContain("วันเว้นวัน"); expect(th).toContain("15–30 นาที");
      expect(th).toContain(when === EventTiming.Morning ? "เช้า" : "กลางคืน");
    }
    expect(input).toEqual(before);
  });

  it.each([AdviceRelation.Before, AdviceRelation.After])("keeps a complete %s clock before a dilution destination", relation => {
    const source = "Dilute 1 mL with saline " + relation + " 08:00 to 10 mL";
    const frame = parseInstructionActions(source)[0];
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, relation, normalized: "08:00:00" }));
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Destination, relation: AdviceRelation.To,
      quantity: { value: 10, unit: "mL" } }));
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Amount)).toEqual([
      expect.objectContaining({ quantity: { value: 1, unit: "mL" } })
    ]);
    const marker = graphMarker(frame), before = fresh(marker);
    for (const wire of savedViews({ extension: [marker] })) {
      const text = formatSig(wire, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toContain("to 10 mL"); expect(text).toContain(relation + " 08:00");
      expect(text.match(/08:00/gu)).toHaveLength(1);
    }
    expect(marker).toEqual(before);
  });

  it.each([false, true])("retains an explicit material translation without normalized (named=%s)", named => {
    const frame: AdviceFrame = { ...fresh(parseInstructionActions("Dilute with water")[0]), sourceText: "",
      relation: named ? AdviceRelation.With : AdviceRelation.To, args: [{
        role: named ? AdviceArgumentRole.Material : AdviceArgumentRole.Destination,
        relation: named ? AdviceRelation.With : AdviceRelation.To,
        text: named ? "100 mL sterile water" : "100 mL", quantity: { value: 100, unit: "mL" },
        ...(named ? { i18n: { th: "น้ำปราศจากเชื้อ" } } : {})
      }] };
    const row: FhirDosage = { extension: [graphMarker(frame)] }, before = fresh(row);
    for (const wire of savedViews(row)) {
      const th = formatSig(wire, "long", { locale: "th", realizationMode: "normalized" });
      expect(th.match(/100 มิลลิลิตร/gu)).toHaveLength(1);
      if (named) expect(th).toContain("น้ำปราศจากเชื้อ");
      else expect(th).not.toContain("น้ำ");
    }
    expect(row).toEqual(before);
  });

  it.each(["quantity", "named", "partial"] as const)("renders an additional mixing material once: %s", variant => {
    const frame = fresh(parseInstructionActions("Mix the medication with water")[0]);
    frame.sourceText = "";
    frame.args.push({ role: AdviceArgumentRole.Material, relation: AdviceRelation.With,
      text: variant === "quantity" ? "5 mL" : variant === "named" ? "5 mL syrup" : "some syrup",
      quantity: { unit: "mL", ...(variant === "partial" ? {} : { value: 5 }) },
      ...(variant === "named" ? { normalized: "syrup", i18n: { th: "น้ำเชื่อม" } } : {})
    });
    for (const wire of savedViews({ extension: [graphMarker(frame)] })) for (const locale of ["en", "th"] as const) {
      const text = formatSig(wire, "long", { locale, realizationMode: "normalized" });
      if (variant === "partial") expect(text).toContain("some syrup");
      else {
        expect(text.match(locale === "en" ? /5 mL/gu : /5 มิลลิลิตร/gu)).toHaveLength(1);
        if (locale === "th") expect(text).not.toContain("5 mL");
        if (variant === "named") expect(text).toContain(locale === "en" ? "syrup" : "น้ำเชื่อม");
      }
    }
  });

  it("retains an annotated relation Coding through the public graph codec", () => {
    const actions = parseInstructionActions("Wash hands then apply cream");
    const marker = buildInstructionGraphExtension({ sourceText: "", actions, relations: [{
      kind: AdviceRelation.Before, fromActionIndex: 0, toActionIndex: 1
    }] })!;
    const relation = marker.extension!.find(field => field.url === "graphRelation")!;
    const coding = relation.extension!.find(field => field.url === "kindCoding")!.valueCoding!;
    coding.id = "ordered-relation";
    coding.extension = [{ url: "https://example.org/relation-note", valueString: "retain note" }];
    const before = fresh(marker), decoded = parseInstructionGraphExtension([marker])!;
    const rebuilt = buildInstructionGraphExtension(decoded)!;
    expect(rebuilt).toEqual(before);
    const changed = fresh(decoded);
    changed.relations![0].kind = AdviceRelation.After;
    const replacement = buildInstructionGraphExtension(changed)!;
    const saved = replacement.extension!.find(field => field.url === "graphRelation")!.extension!;
    expect(saved.find(field => field.url === "kindCoding")!.valueCoding?.code).toBe("after");
    expect(saved.find(field => field.url === "sourceKindCoding")!.valueCoding).toEqual(coding);
    expect(parseInstructionGraphExtension([replacement])!.relations![0].kind).toBe(AdviceRelation.After);
    expect(marker).toEqual(before);
  });

  it("keeps a cleared annotated graph quantity valid without restoring its old value", () => {
    const marker = graphMarker(parseInstructionActions("Swallow 2 tablets whole")[0]);
    const amount = marker.extension!.find(field => field.url === "action")!.extension!
      .find(field => field.url === "argument" && field.extension!.some(child => child.url === "role" && child.valueCode === "amount"))!;
    const quantity = amount.extension!.find(field => field.url === "quantity")!;
    const value = quantity.extension!.find(field => field.url === "value")!;
    value.id = "measured-amount";
    value._valueDecimal = { extension: [{ url: "https://example.org/decimal-note", valueString: "retain decimal note" }] };
    quantity.extension!.push({ url: "https://example.org/quantity-note", valueString: "retain quantity note" });
    const original = fresh(marker), decoded = parseInstructionGraphExtension([marker])!;
    expect(buildInstructionGraphExtension(decoded)).toEqual(original);
    const changed = fresh(decoded);
    changed.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)!.quantity!.value = undefined;
    const rebuilt = buildInstructionGraphExtension(changed)!;
    const rebuiltQuantity = rebuilt.extension!.find(field => field.url === "action")!.extension!
      .find(field => field.url === "argument" && field.extension!.some(child => child.url === "role" && child.valueCode === "amount"))!
      .extension!.find(field => field.url === "quantity")!;
    expect(rebuiltQuantity.extension!.some(field => field.url === "value")).toBe(false);
    expect(rebuiltQuantity.extension).toContainEqual({ url: "sourceQuantityField", id: "measured-amount", extension: [
      { url: "field", valueCode: "value", _valueCode: value._valueDecimal }
    ] });
    expect(rebuiltQuantity.extension).toContainEqual({ url: "https://example.org/quantity-note", valueString: "retain quantity note" });
    const pending = [rebuilt];
    while (pending.length) {
      const field = pending.pop()!;
      const hasValue = Object.keys(field).some(key => key.startsWith("value") && field[key as keyof FhirExtension] !== undefined);
      const hasChildren = Boolean(field.extension?.length);
      expect(hasValue !== hasChildren).toBe(true);
      if (field.extension) pending.push(...field.extension);
    }
    const reopened = parseInstructionGraphExtension([rebuilt])!;
    expect(reopened.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)!.quantity?.value).toBeUndefined();
    expect(buildInstructionGraphExtension(reopened)).toEqual(rebuilt);
    expect(marker).toEqual(original);
  });
});


describe("round67 relation Coding follows current action linkage", () => {
  it.each([
    [AdviceRelation.Before, true], [AdviceRelation.After, true],
    [AdviceRelation.Before, false], [AdviceRelation.After, false]
  ] as const)("reselects %s Coding when the saved linked state %s changes", (kind, linked) => {
    const actions = parseInstructionActions("Wash hands then apply cream");
    const marker = buildInstructionGraphExtension({ sourceText: "", actions, relations: [{ kind,
      ...(linked ? { fromActionIndex: 0 } : {}), toActionIndex: 1,
      text: linked ? kind + " applying cream" : kind + " meals"
    }] })!;
    const fields = marker.extension!.find(field => field.url === "graphRelation")!.extension!;
    const sourceCoding = fields.find(field => field.url === "kindCoding")?.valueCoding;
    if (sourceCoding) {
      sourceCoding.id = "authored-relation";
      sourceCoding.extension = [{ url: "https://example.org/source-note", valueString: "retain source annotation" }];
    }
    const before = JSON.parse(JSON.stringify(marker));
    const decoded = parseInstructionGraphExtension([marker])!;
    const changed = JSON.parse(JSON.stringify(decoded)) as typeof decoded;
    if (linked) delete changed.relations![0].fromActionIndex;
    else changed.relations![0].fromActionIndex = 0;
    changed.relations![0].text = linked ? kind + " meals" : kind + " applying cream";
    const rebuilt = buildInstructionGraphExtension(changed)!;
    const actual = rebuilt.extension!.find(field => field.url === "graphRelation")!.extension!;
    const activeCoding = actual.find(field => field.url === "kindCoding")?.valueCoding;
    if (!linked) expect(activeCoding).toEqual({ system: "http://hl7.org/fhir/action-relationship-type",
      code: kind, display: kind === AdviceRelation.Before ? "Before" : "After" });
    else expect(activeCoding).toEqual({ system: "http://snomed.info/sct",
      code: kind === AdviceRelation.Before ? "421718005" : "255234002",
      display: kind === AdviceRelation.Before ? "Before - dosing instruction fragment" : "After" });
    if (sourceCoding) expect(actual.find(field => field.url === "sourceKindCoding")?.valueCoding).toEqual(sourceCoding);
    const reopened = parseInstructionGraphExtension([rebuilt])!.relations![0];
    expect(reopened.kind).toBe(kind);
    expect(reopened.fromActionIndex).toBe(linked ? undefined : 0);
    expect(marker).toEqual(before);
  });
});


describe("round68 preparation quantities beside independent clinical limits", () => {
  it.each([
    ...["maximum", "max"].map(lead => ({
      source: "Dissolve 2 tablets in 100 mL water, " + lead +
        " 4 tablets per day, then drink daily only if systolic BP > 160",
      materialText: "100 mL water", condition: true
    })),
    { source: "ละลาย2เม็ดในน้ำ100มล., ไม่เกิน4เม็ด/วัน, แล้วดื่มวันละครั้ง",
      materialText: "น้ำ100มล", condition: false }
  ])("keeps the delimited maximum outside the material on fresh dose edits: $source", ({ source, materialText, condition }) => {
    const parsed = parsePublicSig(source, { context: { dosageForm: "effervescent tablet" } });
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 2, unit: "tab" });
    expect(clause.schedule?.maxDosePerPeriod).toEqual([{ amount: 4, unit: "tab", period: 1, periodUnit: "d" }]);
    const graph = clause.instructionGraph!, owner = graph.primaryOwnership!.dose!;
    expect(graph.actions[owner.actionIndex].args[owner.argumentIndex].quantity).toMatchObject({ value: 2, unit: "tab" });
    expect(graph.actions[owner.actionIndex].args.find(arg => arg.role === AdviceArgumentRole.Substance))
      .toMatchObject({ text: materialText, quantity: { value: 100, unit: "mL" } });
    const original = JSON.stringify([parsed.fhir, parsed.fhirNext]);
    const rows: FhirDosage[] = JSON.parse(JSON.stringify(parsed.fhir));
    const r6: FhirR6DosageInstruction = JSON.parse(JSON.stringify(parsed.fhirNext));
    rows[0].doseAndRate![0].doseQuantity!.value = 3;
    r6.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
    for (const input of [rows, r6]) {
      const before = JSON.stringify(input);
      const current = Array.isArray(input) ? input : toFhirR5Dosages(input);
      expect(current[0].maxDosePerPeriod).toEqual([expect.objectContaining({
        numerator: expect.objectContaining({ value: 4, unit: "tab" }),
        denominator: expect.objectContaining({ value: 1, unit: "d" })
      })]);
      if (condition) expect(getDosageCondition(current[0])).toMatchObject({ kind: "measurement", value: 160 });
      else expect(getDosageCondition(current[0])).toBeUndefined();
      for (const realizationMode of ["normalized", "roundtrip"] as const)
        for (const locale of ["en", "th"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(locale === "en" ? /(?:^|[^0-9.])3 tablets?(?![a-z])/gu : /(?:^|[^0-9.])3 เม็ด/gu)).toHaveLength(1);
          expect(text).not.toMatch(locale === "en" ? /(?:^|[^0-9.])2 tablets?(?![a-z])/u : /(?:^|[^0-9.])2 เม็ด/u);
          expect(text.match(locale === "en" ? /100 mL/gu : /100 มิลลิลิตร/gu)).toHaveLength(1);
          if (condition) {
            expect(text.match(/160/gu)).toHaveLength(1);
            const drink = text.search(locale === "en" ? /\bdrink\b/iu : /ดื่ม/u);
            expect(drink).toBeGreaterThan(0);
            expect(text.slice(0, drink)).not.toContain("160");
            expect(text.slice(drink).split(/[.;]/u)[0]).toMatch(/>\s*160/u);
          }
          expect(text).toContain("4 tab / 1 d");
        }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify([parsed.fhir, parsed.fhirNext])).toBe(original);
  });

  it.each([
    ["Dissolve at most 2 tablets in 100 mL water, then drink daily", "<=", undefined],
    ["Dissolve 2 tablets in water, up to 100 mL, then drink daily", undefined, "<="]
  ] as const)("keeps comparator quantities on their owned dose or material: %s", (source, doseComparator, materialComparator) => {
    const parsed = parsePublicSig(source), clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toEqual({ value: 2, unit: "tab", ...(doseComparator ? { comparator: doseComparator } : {}) });
    expect(clause.schedule?.maxDosePerPeriod).toBeUndefined();
    const material = clause.instructionGraph!.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Substance)!;
    expect(material.quantity).toEqual({ value: 100, unit: "mL", ...(materialComparator ? { comparator: materialComparator } : {}) });
    const text = formatSig(parsed.meta.canonical.course, "long", { locale: "en", realizationMode: "normalized" });
    expect(text).toContain(doseComparator ? "Dissolve at most 2 tablets in 100 mL" : "Dissolve 2 tablets in at most 100 mL");
    if (materialComparator) expect(text).not.toContain("at most 2 tablets");
    if (doseComparator) expect(text).not.toContain("at most 100 mL");
  });
});


describe("round68 graph relation metadata and precise realization", () => {
  const fresh = <T>(input: T): T => JSON.parse(JSON.stringify(input));
  const marker = (frame: AdviceFrame) => buildInstructionGraphExtension({
    sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame]
  })!;
  const selectedNode = (graph: FhirExtension, slot: "frame" | "argument") => {
    const action = graph.extension!.find(field => field.url === "action")!;
    return slot === "frame" ? action : action.extension!.find(field => field.url === "argument")!;
  };

  it.each(["frame", "argument"] as const)("retains annotated %s relation Coding on unchanged and changed public codec values", slot => {
    const frame = parseInstructionActions("Mix with water")[0];
    frame.relation = AdviceRelation.With;
    frame.args[0].relation = AdviceRelation.With;
    const supplied = marker(frame), node = selectedNode(supplied, slot);
    const relation = node.extension!.find(field => field.url === "relationCoding")!;
    relation.valueCoding = { ...relation.valueCoding!, id: "supplied-relation", version: "authored-version",
      _code: { id: "supplied-code", extension: [{ url: "https://example.org/relation-note", valueBoolean: false }] },
      extension: [{ url: "https://example.org/relation-source", valueString: "retain this original annotation" }] };
    const originalCoding = fresh(relation.valueCoding), before = fresh(supplied);
    const decoded = parseInstructionGraphExtension([supplied])!;
    const rebuilt = buildInstructionGraphExtension(decoded)!;
    expect(selectedNode(rebuilt, slot).extension!.find(field => field.url === "relationCoding")?.valueCoding)
      .toEqual(originalCoding);
    for (const next of [AdviceRelation.Before, undefined]) {
      const edited = fresh(decoded), owner = slot === "frame" ? edited.actions[0] : edited.actions[0].args[0];
      owner.relation = next;
      const changed = buildInstructionGraphExtension(edited)!, fields = selectedNode(changed, slot).extension!;
      expect(fields.find(field => field.url === "relationCoding")?.valueCoding?.code)
        .toBe(next ? "421718005" : undefined);
      expect(fields.filter(field => field.url === "sourceRelationCoding")).toEqual([
        { url: "sourceRelationCoding", valueCoding: originalCoding }
      ]);
      expect(buildInstructionGraphExtension(parseInstructionGraphExtension([fresh(changed)]))).toEqual(changed);
    }
    expect(supplied).toEqual(before);
  });

  it.each(["early morning", "morning"])("covers only the complete graph event expression: %s", expression => {
    const frame = parseInstructionActions("Swallow 1 tablet whole")[0];
    frame.args.push({ role: AdviceArgumentRole.Time, text: expression, normalized: expression });
    const row: FhirDosage = { method: { text: "Swallow" },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming.Morning] } }, extension: [marker(frame)] };
    for (const input of [fresh([row]), fresh(toDosageDetails([row]))]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text.match(/\bmorning\b/gu)).toHaveLength(expression === "early morning" ? 2 : 1);
      if (expression === "early morning") {
        expect(text).toContain("early morning");
        expect(text).toContain("in the morning");
      }
    }
  });

  it.each([false, true])("renders the first mixing companion quantity once with a named material=%s", named => {
    const frame = parseInstructionActions("Mix powder with water")[0];
    frame.sourceText = "";
    frame.args = [{ role: AdviceArgumentRole.Theme, text: "powder", normalized: "powder" }, {
      role: AdviceArgumentRole.Material, relation: AdviceRelation.With,
      text: named ? "sterile water" : "100 mL", quantity: { value: 100, unit: "mL" },
      ...(named ? { normalized: "sterile water", i18n: { th: "น้ำปราศจากเชื้อ" } } : {})
    }];
    const row: FhirDosage = { extension: [marker(frame)] };
    for (const input of [fresh([row]), fresh(toDosageDetails([row]))])
      for (const locale of ["en", "th"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/100\s*(?:mL|มิลลิลิตร)/gu)).toHaveLength(1);
        if (named) expect(text).toContain(locale === "en" ? "sterile water" : "น้ำปราศจากเชื้อ");
      }
  });
});


describe("round68 fresh graph cadence authority", () => {
  const fresh = <T>(input: T): T => JSON.parse(JSON.stringify(input));
  it.each([
    "Swallow 1 tablet whole twice daily; do not crush",
    "Dissolve 2 tablets in 100 mL water, then drink twice daily"
  ])("keeps live cadence over unverified graph wording while preserving verified source: %s", source => {
    const parsed = parsePublicSig(source), clause = parsed.meta.canonical.clauses[0];
    expect(clause.instructionGraph?.primaryOwnership?.dose).toBeDefined();
    for (const frequency of [1, 2]) {
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: clause.dose!.value, unit: clause.dose!.unit } }],
        timing: { repeat: { frequency, period: 1, periodUnit: "d" } },
        // Plain Drink is carried by method; its redundant action is absent
        // from the auxiliary graph. Preserve that submitted clinical head.
        ...(source.startsWith("Dissolve") ? { method: fresh(parsed.fhir[0].method) } : {}),
        extension: [buildInstructionGraphExtension(clause.instructionGraph)!] };
      if (source.startsWith("Dissolve")) expect(row.method).toMatchObject({ text: "Drink" });
      const before = JSON.stringify(row), native = importCanonicalCourse(row), r6 = toDosageDetails([row]);
      for (const input of [row, native, r6, fresh(toFhirR5Dosages(r6))]) {
        const preview = formatSig(input, "long", { locale: "en", realizationMode: "roundtrip" });
        expect(preview).toContain(frequency === 1 ? "once daily" : "twice daily");
        if (frequency === 1) expect(preview).not.toContain("twice daily");
        if (source.startsWith("Swallow")) {
          expect(preview).toContain("Swallow 1 tablet whole");
          expect(preview.toLowerCase()).toContain("do not crush");
        } else {
          const drinkIndex = preview.search(/\bDrink\b/iu);
          expect(drinkIndex).toBeGreaterThan(0);
          const preparation = preview.slice(0, drinkIndex), administration = preview.slice(drinkIndex);
          expect(preparation).toContain("Dissolve 2 tablets");
          expect(preparation).toContain("100 mL water");
          expect(preparation).not.toMatch(/once daily|twice daily/u);
          expect(administration).toContain(frequency === 1 ? "once daily" : "twice daily");
        }
      }
      expect(JSON.stringify(row)).toBe(before);
      expect(JSON.stringify(r6)).toContain(source);
    }
    // Positive fingerprints retain the existing roundtrip preview: exact
    // Swallow source or the preparation's explicit administration wording.
    const verifiedPreview = source.startsWith("Swallow") ? source
      : "Dissolve 2 tablets in 100 mL water. Drink the medication orally twice daily.";
    for (const verified of [parsed.fhir, fresh(parsed.fhir)])
      expect(formatSig(verified, "long", { locale: "en", realizationMode: "roundtrip" })).toBe(verifiedPreview);
  });
});


describe("round70 quantified vehicle nominal ownership", () => {
  it.each([
    { source: "Dilute 1 mL with a 100 mL bag of saline", nominal: "bag of saline", amount: 100 },
    { source: "Dilute 1 mL with saline 100 mL", nominal: "saline", amount: 100 },
    { source: "Dilute 1 mL to 10 mL", nominal: "mL", amount: 10 }
  ])("keeps the complete vehicle beside its independent volume: $source", ({ source, nominal, amount }) => {
    const parsed = parsePublicSig(source), graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    const vehicle = graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Destination)!;
    expect(vehicle.normalized).toBe(nominal);
    expect(vehicle.relation).toBe(nominal === "mL" ? AdviceRelation.To : AdviceRelation.With);
    expect(vehicle.quantity).toEqual({ value: amount, unit: "mL" });
    expect(source).toContain(vehicle.text);
    expect(graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toEqual({ value: 1, unit: "mL" });
    for (const input of [parsed.meta.canonical.course!, JSON.parse(JSON.stringify(parsed.fhir)),
      JSON.parse(JSON.stringify(parsed.fhirNext))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Dilute 1 mL");
      expect(en).toContain(amount + " mL");
      expect(th).toContain("เจือจาง 1 มิลลิลิตร");
      expect(th).toContain(amount + " มิลลิลิตร");
      if (nominal !== "mL") {
        expect(en).toContain(`with ${amount} mL ${nominal}`);
        expect(th).toContain(`พร้อม${amount} มิลลิลิตร${nominal}`);
      } else {
        expect(en).toBe("Dilute 1 mL to 10 mL.");
        expect(th).toBe("เจือจาง 1 มิลลิลิตรไปยัง10 มิลลิลิตร.");
      }
    }
  });
});


describe("round71 current method identity across shared action codes", () => {
  it.each([false, true])("honors a fresh Chew method and its selected bound manners (reversed %s)", reversed => {
    const swallow = { ...getMedicationInstructionAction("swallow")!, code: "clinic-ingest", aliases: [],
      methodBoundMannerConcepts: ["whole"] };
    const chew = { ...getMedicationInstructionAction("chew")!, code: "clinic-ingest", aliases: [] };
    const options: ParseOptions = { instructionActionMap: reversed ? { chew, swallow } : { swallow, chew } };
    const source = "Swallow 1 tablet whole", parsed = parsePublicSig(source, options);
    const original = JSON.stringify(parsed.fhir);
    const row = JSON.parse(original)[0] as FhirDosage;
    row.method = JSON.parse(JSON.stringify(parsePublicSig("Chew 1 tablet", options).fhir[0].method));
    expect(row.method?.coding?.[0].code).toBe("738992009");
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(r6))) as FhirDosage[];
    for (const input of [row, r6, saved])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { ...options, locale: "en", realizationMode }))
          .toBe("Chew 1 tablet orally.");
        expect(formatSig(input, "long", { ...options, locale: "th", realizationMode }))
          .toBe("เคี้ยว 1 เม็ด.");
      }
    expect(JSON.stringify(row)).toBe(before);
    expect(saved[0].method).toEqual(row.method);
    expect(JSON.stringify(saved)).toContain(source);
    expect(JSON.stringify(parsed.fhir)).toBe(original);
    expect(formatSig(parsed.fhir, "long", { ...options, locale: "en", realizationMode: "normalized" }))
      .toBe("Swallow 1 tablet whole.");
  });
});


describe("round72 scoped graph quantity warnings", () => {
  it("keeps a saved typed Rub amount under negation", () => {
    const source = "Do not rub more than 1 g";
    const frame = { ...parseInstructionActions(source)[0], args: [{ role: AdviceArgumentRole.Amount,
      text: "more than 1 g", quantity: { value: 1, unit: "g", comparator: ">" as const },
      span: { start: 11, end: source.length } }] };
    expect(frame.predicate.realizer).toBe("result");
    expect(frame.polarity).toBe(AdvicePolarity.Negate);
    expect(realizeInstructionAction(frame, "en")).toBe("Do not rub more than 1 g");
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions: [frame]
    })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    expect(parseInstructionGraphExtension(row.extension)?.actions[0].args[0].quantity)
      .toEqual({ value: 1, unit: "g", comparator: ">" });
    for (const input of [row, JSON.parse(JSON.stringify(r6)), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Do not rub more than 1 g.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ห้ามถู มากกว่า 1 g.");
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});


it("round72 keeps authored priming before the freshly edited administration", () => {
  const source = "Prime with 2 sprays, then spray 1 spray";
  const parsed = parsePublicSig(source), row: FhirDosage = JSON.parse(JSON.stringify(parsed.fhir[0]));
  row.doseAndRate![0].doseQuantity!.value = 3;
  const before = JSON.stringify(row), r6 = toDosageDetails([row]);
  for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
    expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
      .toBe("Prime with 2 sprays; then spray 3 sprays.");
    expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
      .toBe("เตรียมอุปกรณ์พ่น 2 พ่น จากนั้นพ่นครั้งละ 3 พ่น.");
  }
  expect(JSON.stringify(row)).toBe(before);
  expect(JSON.stringify(r6)).toContain(source);
});


describe("round73 selected negated site attachment", () => {
  it.each(["clinic-wash", "apply"])("keeps Wash attachment when its registered code is %s", code => {
    const definition = { ...getMedicationInstructionAction("wash")!, code };
    const options: ParseOptions = { instructionActionMap: { wash: definition }, locale: "th" };
    const source = "ห้ามล้างผิวหนัง", parsed = parsePublicSig(source, options);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions[0].predicate).toMatchObject({ display: "Wash", semanticClass: "cleanse",
      realizer: "site-relation", realizerConfig: { locales: { en: { directSiteObject: true } } } });
    expect(graph.actions[0].args[0].coding?.code).toBe("181469002");
    const before = JSON.stringify(parsed.fhir);
    const r6 = toDosageDetails(parsed.fhir), saved = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [parsed.fhir, r6, saved]) {
      expect(formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" }))
        .toMatch(/^Do not wash the /u);
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" }))
        .toBe("ห้ามล้างผิวหนัง.");
    }
    expect(JSON.stringify(parsed.fhir)).toBe(before);
    expect(JSON.stringify(saved)).toContain(source);
  });
});

describe("round73 registered Time beside an oral procedure duration", () => {
  it.each([false, true])("keeps the built-in mouth-rinsing amount, duration and accepted Time (%s)", timed => {
    const source = "Mouthwash fifteen millilitres thirty seconds" + (timed ? " lights-out" : "");
    const requests: string[] = [];
    const parsed = parsePublicSig(source, { unitMap: { s: "s" }, instructionSemanticResolvers: request => {
      requests.push(request.sourceText);
      if (request.sourceText !== source) return undefined;
      return { actions: [{ action: "rinse_mouth", range: { start: 0, end: source.length }, args: [
        { role: AdviceArgumentRole.Amount, range: { start: 10, end: 29 }, quantity: { value: 15, unit: "mL" } },
        { role: AdviceArgumentRole.Duration, range: { start: 30, end: 44 }, quantity: { value: 30, unit: "s" } },
        ...(timed ? [{ role: AdviceArgumentRole.Time, range: { start: 45, end: source.length }, concept: "bedtime" }] : [])
      ] }] };
    } });
    expect(requests).toContain(source);
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.predicate.realizer).toBe("amount-duration");
    for (const [role, phrase] of [[AdviceArgumentRole.Amount, "fifteen millilitres"],
      [AdviceArgumentRole.Duration, "thirty seconds"], ...(timed ? [[AdviceArgumentRole.Time, "lights-out"]] : [])]) {
      const range = frame.args.find(arg => arg.role === role)!.span!;
      expect(source.slice(range.start, range.end)).toBe(phrase);
    }
    expect(frame.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 15, unit: "mL" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "s" } })
    ]));
    if (timed) expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, conceptId: "bedtime" }));
    const before = JSON.stringify(parsed.fhir), r6 = toDosageDetails(parsed.fhir);
    for (const input of [JSON.parse(before), JSON.parse(JSON.stringify(r6)), JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Rinse mouth 15 mL for 30 seconds" + (timed ? " at bedtime." : "."));
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("บ้วนปาก 15 มิลลิลิตร นาน 30 วินาที" + (timed ? "ก่อนนอน." : "."));
    }
    expect(JSON.stringify(parsed.fhir)).toBe(before);
  });
});

it("round73 retains the schedule-owned bedtime beside a gargling duration", () => {
  const parsed = parsePublicSig("Gargle 10 mL for 30 seconds at bedtime");
  expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual([EventTiming["Before Sleep"]]);
  expect(formatSig(parsed.fhir, "long", { locale: "en", realizationMode: "normalized" }))
    .toBe("Gargle 10 mL for 30 seconds at bedtime.");
  expect(formatSig(parsed.fhir, "long", { locale: "th", realizationMode: "normalized" }))
    .toBe("กลั้วคอ 10 มิลลิลิตร นาน 30 วินาทีก่อนนอน.");
});
describe("round74 independent material and time owners", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (frame: AdviceFrame) => {
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
    const r6 = toDosageDetails([row]);
    return [[row], r6, fresh(toFhirR5Dosages(r6))] as const;
  };

  it.each(["Dilute", "Mix"])("separates opaque measured material from current quantities for %s", action => {
    const frame: AdviceFrame = { ...fresh(parseInstructionActions(action + " with water")[0]), sourceText: "",
      args: [{ role: AdviceArgumentRole.Material, relation: AdviceRelation.With,
        text: "100 mL sterile water", quantity: { value: 100, unit: "mL" } }] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
    for (const value of [100, 50, 1100]) {
      const submitted = fresh(row);
      const savedArgument = submitted.extension![0].extension!.find(item => item.url === "action")!
        .extension!.find(item => item.url === "argument")!;
      savedArgument.extension!.find(item => item.url === "quantity")!.extension!
        .find(item => item.url === "value")!.valueDecimal = value;
      const before = JSON.stringify(submitted), r6 = toDosageDetails([submitted]);
      for (const input of [[submitted], r6, fresh(toFhirR5Dosages(r6))]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        const separator = locale === "en" ? "; original directions: " : "; ข้อความเดิม: ";
        const [current, original] = text.split(separator);
        expect(original).toBe("100 mL sterile water.");
        expect(current).toContain(locale === "en" ? value + " mL" : value + " มิลลิลิตร");
        expect(current.match(/[0-9]+/gu)).toEqual([String(value)]);
        if (locale === "en") expect(current).toBe("Current: " + action + " with " + value + " mL");
      }
      expect(JSON.stringify(submitted)).toBe(before);
      expect(parseInstructionGraphExtension(toFhirR5Dosages(r6)[0].extension)?.actions[0].args[0])
        .toMatchObject({ text: "100 mL sterile water", quantity: { value, unit: "mL" } });
    }
  });

  it("retains opaque mixing companions under their original-directions label", () => {
    const frame: AdviceFrame = { ...fresh(parseInstructionActions("Mix with water")[0]), sourceText: "",
      args: [
        { role: AdviceArgumentRole.Substance, relation: AdviceRelation.With, text: "100 mL sterile water",
          quantity: { value: 100, unit: "mL" } },
        { role: AdviceArgumentRole.Material, relation: AdviceRelation.With, text: "50 mL saline",
          quantity: { value: 50, unit: "mL" } }
      ] };
    for (const input of views(frame)) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      const [current, original] = text.split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ");
      expect(original).toBe("100 mL sterile water; 50 mL saline.");
      expect(current.match(/[0-9]+/gu)).toEqual(["100", "50"]);
    }
  });

  it.each(["bare quantity", "separate label"])("localizes the measured material with %s", kind => {
    const frame: AdviceFrame = { ...fresh(parseInstructionActions("Dilute with water")[0]), sourceText: "",
      args: [{ role: AdviceArgumentRole.Material, relation: AdviceRelation.With,
        text: kind === "bare quantity" ? "100 mL" : "100 mL sterile water",
        ...(kind === "separate label" ? { normalized: "sterile water", i18n: { th: "น้ำปราศจากเชื้อ" } } : {}),
        quantity: { value: 100, unit: "mL" } }] };
    for (const input of views(frame)) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe(kind === "bare quantity" ? "Dilute with 100 mL." : "Dilute with 100 mL sterile water.");
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th.match(/100 มิลลิลิตร/gu)).toHaveLength(1);
      if (kind === "separate label") expect(th).toContain("น้ำปราศจากเชื้อ");
    }
  });

  it("retains distinct times that share the frame relation and deduplicates the same time", () => {
    const time = (text: string, thai: string) => ({ role: AdviceArgumentRole.Time, relation: AdviceRelation.Before,
      text, normalized: text, i18n: { th: thai } });
    const frame: AdviceFrame = { ...fresh(parseInstructionActions("Swallow 1 tablet before breakfast")[0]), sourceText: "",
      relation: AdviceRelation.Before, args: [
        { role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } },
        time("breakfast", "อาหารเช้า"), time("dinner", "อาหารเย็น"), time("breakfast", "อาหารเช้า")
      ] };
    for (const input of views(frame)) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(text.match(locale === "en" ? /before dinner/gu : /ก่อนอาหารเย็น/gu)).toHaveLength(1);
      expect(text.match(locale === "en" ? /1 tablet/gu : /1 เม็ด/gu)).toHaveLength(1);
    }
  });

  it("keeps a later water quantity off the medication head after WITH breakfast", () => {
    const source = "Take with breakfast and with 200 mL water", actions = parseInstructionActions(source);
    expect(actions).toHaveLength(1);
    expect(actions[0].args.some(arg => arg.role === AdviceArgumentRole.Amount)).toBe(false);
    expect(actions[0].args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Substance,
      relation: AdviceRelation.With, normalized: "water", quantity: { value: 200, unit: "mL" } }));
    for (const input of views(actions[0])) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "with 200 mL water" : "200 มิลลิลิตรน้ำ");
      expect(text).toContain(locale === "en" ? "breakfast" : "อาหารเช้า");
    }
    expect(parsePublicSig(source).meta.canonical.clauses[0].dose).toBeUndefined();
    const positive = parseInstructionActions("Take with breakfast 1 tablet")[0];
    expect(positive.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Amount,
      quantity: { value: 1, unit: "tab" } }));
  });
});


it("round74 retains distinct saved Time quantities with the same normalized unit", () => {
  const source = parseInstructionActions("Rinse eyes after breakfast")[0];
  const frame: AdviceFrame = { ...source, sourceText: "", relation: AdviceRelation.After,
    args: [...source.args.filter(arg => arg.role !== AdviceArgumentRole.Time), ...[1, 2, 1].map(value => ({
      role: AdviceArgumentRole.Time, relation: AdviceRelation.After, text: value + " hours", normalized: "h",
      quantity: { value, unit: "h" } }))] };
  const row: FhirDosage = { extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
  const before = JSON.stringify(row), r6 = toDosageDetails([row]);
  for (const input of [[row], r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) for (const locale of ["en", "th"]) {
    const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
    for (const phrase of locale === "en" ? ["after 1 hour", "after 2 hours"] : ["หลัง1 ชั่วโมง", "หลัง2 ชั่วโมง"])
      expect(text.split(phrase)).toHaveLength(2);
    expect(text.match(/[0-9]+/gu)).toEqual(["1", "2"]);
  }
  expect(JSON.stringify(row)).toBe(before);
  expect(parseInstructionGraphExtension(toFhirR5Dosages(r6)[0].extension)?.actions[0].args.filter(arg => arg.role === AdviceArgumentRole.Time).map(arg => arg.quantity))
    .toEqual([{ value: 1, unit: "h" }, { value: 2, unit: "h" }, { value: 1, unit: "h" }]);
});


describe("round74 event daughters beside an oral procedure duration", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    ["Rinse mouth 15 mL for 30 seconds after meals", "en", "C", AdviceRelation.After, "after food", "หลังอาหาร"],
    ["Rinse mouth 15 mL for 30 seconds before meals", "en", "C", AdviceRelation.Before, "before food", "ก่อนอาหาร"],
    ["Rinse mouth 15 mL for 30 seconds at bedtime", "en", "HS", AdviceRelation.On, "at bedtime", "ก่อนนอน"],
    ["บ้วนปาก 15 มล. นาน 30 วินาที หลังอาหาร", "th", "C", AdviceRelation.After, "after food", "หลังอาหาร"],
    ["บ้วนปาก 15 มล. นาน 30 วินาที ก่อนอาหาร", "th", "C", AdviceRelation.Before, "before food", "ก่อนอาหาร"],
    ["บ้วนปาก 15 มล. นาน 30 วินาที ก่อนนอน", "th", "HS", AdviceRelation.Before, "before sleep", "ก่อนนอน"]
  ] as const)("retains the typed amount, duration and local event: %s", (source, sourceLocale, event, relation, english, thai) => {
    const parsed = parsePublicSig(source, { locale: sourceLocale }), native = parsed.meta.canonical.course!;
    const frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(frame.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 15, unit: "mL" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 30, unit: "s" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: event, relation })
    ]));
    expect(native.stages[0].administrations[0].amounts?.[0].quantity).toMatchObject({ value: 15, unit: "mL" });
    expect(native.stages[0].administrations[0].schedule?.recurrence?.courseLength).toBeUndefined();
    const note = { url: "urn:round74:oral-procedure-note", valueString: "retain the original clinical annotation" };
    const rows = fresh(parsed.fhir);
    (rows[0].extension ??= []).push(note);
    const before = JSON.stringify(rows), r6 = fresh(toDosageDetails(rows)), saved = fresh(toFhirR5Dosages(r6));
    for (const locale of ["en", "th"]) {
      const options = { locale, realizationMode: "normalized" as const };
      for (const text of [formatCanonicalCourse(native, "long", options),
        ...[rows, fresh(parsed.fhirNext), r6, saved].map(input => formatSig(input, "long", options))]) {
        expect(text).toBe(locale === "en"
          ? "Rinse mouth 15 mL for 30 seconds " + english + "."
          : "บ้วนปาก 15 มิลลิลิตร นาน 30 วินาที" + thai + ".");
      }
    }
    expect(formatSig(parsed.fhir, "long", { locale: sourceLocale, realizationMode: "roundtrip" })).toBe(source);
    expect(parseInstructionGraphExtension(saved[0].extension)?.sourceText).toBe(source);
    expect(saved[0].extension).toContainEqual(note);
    expect(JSON.stringify(rows)).toBe(before);
    const changed = fresh(saved);
    changed[0].doseAndRate![0].doseQuantity!.value = 10;
    for (const input of [changed, fresh(toDosageDetails(changed)), fresh(toFhirR5Dosages(toDosageDetails(changed)))])
      for (const locale of ["en", "th"]) {
        const current = formatSig(input, "long", { locale, realizationMode: "normalized" })
          .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
        expect(current).toContain(locale === "en" ? "10 mL for 30 seconds " + english : "10 มิลลิลิตร นาน 30 วินาที" + thai);
        expect(current).not.toContain(locale === "en" ? "15 mL" : "15 มิลลิลิตร");
      }
  });

  it("keeps a current schedule-owned meal event authoritative beside the procedure duration", () => {
    const parsed = parsePublicSig("Gargle 15 mL for 30 seconds after meals");
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual([EventTiming["After Meal"]]);
    const changed = fresh(parsed.fhir);
    changed[0].timing!.repeat!.when = [EventTiming["Before Meal"]];
    for (const input of [changed, fresh(toDosageDetails(changed)), fresh(toFhirR5Dosages(toDosageDetails(changed)))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" }).split("; original directions: ")[0];
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" }).split("; ข้อความเดิม: ")[0];
      expect(english).toContain("15 mL for 30 seconds before meals");
      expect(english).not.toMatch(/after (?:meals|food)/u);
      expect(thai).toContain("15 มิลลิลิตร นาน 30 วินาที ก่อนอาหาร");
      expect(thai).not.toContain("หลังอาหาร");
    }
  });
});


describe("round75 coordinated Time daughters", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const afterBreakfast = ["CM", AdviceRelation.After, "after breakfast", "หลังอาหารเช้า"] as const;
  const afterDinner = ["CV", AdviceRelation.After, "after dinner", "หลังอาหารเย็น"] as const;
  const bedtime = ["HS", AdviceRelation.On, "at bedtime", "ก่อนนอน"] as const;
  it.each([
    ["Rinse mouth 15 mL for 30 seconds after breakfast and after dinner", "en", 15, 30, [afterBreakfast, afterDinner]],
    ["Rinse mouth 15 mL for 30 seconds after breakfast and at bedtime", "en", 15, 30, [afterBreakfast, bedtime]],
    ["บ้วนปาก 15 มล. นาน 30 วินาที หลังอาหารเช้า และ ก่อนนอน", "th", 15, 30,
      [afterBreakfast, ["HS", AdviceRelation.Before, "before sleep", "ก่อนนอน"]]],
    ["Swish 10 mL for 30 seconds after breakfast and dinner", "en", 10, 30, [afterBreakfast, afterDinner]],
    ["Rinse mouth 15 mL for 30 seconds before breakfast, after lunch and dinner", "en", 15, 30,
      [["CM", AdviceRelation.Before, "before breakfast", "ก่อนอาหารเช้า"],
        ["CD", AdviceRelation.After, "after lunch", "หลังอาหารกลางวัน"], afterDinner]],
    ["Rinse mouth 15 mL after breakfast and after dinner", "en", 15, undefined, [afterBreakfast, afterDinner]],
    ["Rinse mouth 15 mL for 30 seconds at 08:00 and 20:00", "en", 15, 30,
      [["08:00:00", AdviceRelation.On, "at 08:00:00", "เวลา 08:00:00"],
        ["20:00:00", AdviceRelation.On, "at 20:00:00", "เวลา 20:00:00"]]],
    ["Rinse mouth 15 mL for 30 seconds after breakfast", "en", 15, 30, [afterBreakfast]]
  ] as const)("keeps each typed Time and its nearest relation: %s", (source, sourceLocale, amount, duration, expected) => {
    const parsed = parsePublicSig(source, { locale: sourceLocale });
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions).toHaveLength(1);
    const frame = graph.actions[0], times = frame.args.filter(arg => arg.role === AdviceArgumentRole.Time);
    expect(times.map(arg => [arg.normalized, arg.relation])).toEqual(expected.map(([event, relation]) => [event, relation]));
    for (const time of times) expect(source.slice(time.span!.start, time.span!.end)).toBe(time.text);
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toEqual({ value: amount, unit: "mL" });
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Duration)?.quantity)
      .toEqual(duration === undefined ? undefined : { value: duration, unit: "s" });
    const note = { url: "urn:round75:time-annotation", valueString: "retain each clinical time" };
    const rows = fresh(parsed.fhir);
    (rows[0].extension ??= []).push(note);
    const before = JSON.stringify(rows), r6 = fresh(toDosageDetails(rows)), saved = fresh(toFhirR5Dosages(r6));
    for (const input of [rows, parsed.meta.canonical.course!, fresh(parsed.fhirNext), r6, saved]) {
      for (const locale of ["en", "th"]) {
        const current = formatSig(input, "long", { locale, realizationMode: "normalized" })
          .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
        for (const [, , english, thai] of expected)
          expect(current.split(locale === "en" ? english : thai), current).toHaveLength(2);
        expect(current).toContain(locale === "en" ? amount + " mL" : amount + " มิลลิลิตร");
        if (duration !== undefined) expect(current).toContain(locale === "en" ? "30 seconds" : "30 วินาที");
      }
    }
    expect(formatSig(parsed.fhir, "long", { locale: sourceLocale, realizationMode: "roundtrip" })).toBe(source);
    const reopened = parseInstructionGraphExtension(saved[0].extension)!;
    expect(reopened.sourceText).toBe(source);
    expect(reopened.actions[0].args.filter(arg => arg.role === AdviceArgumentRole.Time)
      .map(arg => [arg.normalized, arg.relation])).toEqual(expected.map(([event, relation]) => [event, relation]));
    expect(saved[0].extension).toContainEqual(note);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("projects the complete current primary event list once after a fresh structured edit", () => {
    const source = "Gargle 15 mL for 30 seconds after breakfast and after dinner";
    const parsed = parsePublicSig(source), changed = fresh(parsed.fhir);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toEqual([EventTiming["After Breakfast"], EventTiming["After Dinner"]]);
    expect(parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args
      .filter(arg => arg.role === AdviceArgumentRole.Time).map(arg => arg.normalized)).toEqual(["CM", "CV"]);
    for (const rows of [parsed.fhir, changed]) {
      const edited = rows === changed;
      if (edited) rows[0].timing!.repeat!.when = [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]];
      const before = JSON.stringify(rows), r6 = fresh(toDosageDetails(rows)), saved = fresh(toFhirR5Dosages(r6));
      for (const input of [rows, importCanonicalCourse(rows), r6, saved]) for (const locale of ["en", "th"]) {
        const current = formatSig(input, "long", { locale, realizationMode: "normalized" })
          .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
        for (const meal of locale === "en" ? ["breakfast", "dinner"] : ["อาหารเช้า", "อาหารเย็น"])
          expect(current.split((locale === "en" ? edited ? "before " : "after " : edited ? "ก่อน" : "หลัง") + meal)).toHaveLength(2);
        expect(current).toContain(locale === "en" ? "15 mL for 30 seconds" : "15 มิลลิลิตร นาน 30 วินาที");
        if (edited) expect(current).not.toMatch(locale === "en" ? /after breakfast|after dinner/u : /หลังอาหารเช้า|หลังอาหารเย็น/u);
      }
      expect(parseInstructionGraphExtension(saved[0].extension)?.sourceText).toBe(source);
      expect(JSON.stringify(rows)).toBe(before);
    }
  });

  it("keeps a separately owned preparation clock and both material quantities during an event-list edit", () => {
    const source = "Dilute 15 mL with 100 mL water at 08:00 then Gargle for 30 seconds after breakfast and after dinner";
    const parsed = parsePublicSig(source), changed = fresh(parsed.fhir);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    expect(graph.actions.map(frame => frame.predicate.lemma)).toEqual(["dilute", "gargle"]);
    expect(graph.actions[0].args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 15, unit: "mL" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Destination, quantity: { value: 100, unit: "mL" } }),
      expect.objectContaining({ role: AdviceArgumentRole.Time, normalized: "08:00:00" })
    ]));
    changed[0].timing!.repeat!.when = [EventTiming["Before Breakfast"], EventTiming["Before Dinner"]];
    const before = JSON.stringify(changed), r6 = fresh(toDosageDetails(changed)), saved = fresh(toFhirR5Dosages(r6));
    for (const input of [changed, importCanonicalCourse(changed), r6, saved]) for (const locale of ["en", "th"]) {
      const current = formatSig(input, "long", { locale, realizationMode: "normalized" })
        .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
      expect(current.split("08:00")).toHaveLength(2);
      expect(current).toContain(locale === "en" ? "15 mL" : "15 มิลลิลิตร");
      expect(current).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
      expect(current).toContain(locale === "en" ? "30 seconds" : "30 วินาที");
      for (const event of locale === "en" ? ["before breakfast", "before dinner"] : ["ก่อนอาหารเช้า", "ก่อนอาหารเย็น"])
        expect(current.split(event)).toHaveLength(2);
      expect(current).not.toMatch(locale === "en" ? /after breakfast|after dinner/u : /หลังอาหารเช้า|หลังอาหารเย็น/u);
    }
    expect(parseInstructionGraphExtension(saved[0].extension)?.sourceText).toBe(source);
    expect(JSON.stringify(changed)).toBe(before);
  });

  it("retains independently owned local Times when a fresh repeat adds multiple events", () => {
    const source = "Rinse mouth 15 mL for 30 seconds after breakfast and after dinner";
    const parsed = parsePublicSig(source), changed = fresh(parsed.fhir);
    expect(parsed.meta.canonical.clauses[0].schedule?.when).toBeUndefined();
    changed[0].timing = { repeat: { when: [EventTiming.Morning, EventTiming.Evening] } };
    const r6 = fresh(toDosageDetails(changed)), saved = fresh(toFhirR5Dosages(r6));
    for (const input of [changed, importCanonicalCourse(changed), r6, saved]) for (const locale of ["en", "th"]) {
      const current = formatSig(input, "long", { locale, realizationMode: "normalized" })
        .split(locale === "en" ? "; original directions: " : "; ข้อความเดิม: ")[0];
      for (const event of locale === "en" ? ["after breakfast", "after dinner", "morning", "evening"]
        : ["หลังอาหารเช้า", "หลังอาหารเย็น", "ตอนเช้า", "ตอนเย็น"])
        expect(current.split(event), current).toHaveLength(2);
    }
    expect(parseInstructionGraphExtension(saved[0].extension)?.sourceText).toBe(source);
  });

});


it.each([false, true])("round76 retains every saved point Time and its explicit direction (%s)", directional => {
  const original = parseInstructionActions("Apply 1 patch")[0];
  const frame: AdviceFrame = { ...original, sourceText: "", relation: undefined,
    args: [...original.args, ...["08:00", "20:00", "08:00"].map(time => ({
      role: AdviceArgumentRole.Time, text: time, normalized: time,
      ...(directional ? { relation: time === "08:00" ? AdviceRelation.Before : AdviceRelation.After } : {})
    }))] };
  const row: FhirDosage = { extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!] };
  const before = JSON.stringify(row), r6 = toDosageDetails([row]);
  for (const input of [[row], importCanonicalCourse(row), JSON.parse(JSON.stringify(r6)),
    JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) for (const locale of ["en", "th"]) {
    const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
    for (const [index, time] of ["08:00", "20:00"].entries()) {
      const relation = directional ? locale === "en" ? index === 0 ? "before " : "after "
        : index === 0 ? "ก่อน" : "หลัง" : locale === "en" ? "at " : "เวลา ";
      expect(text.split(relation + time), text).toHaveLength(2);
      expect(text.split(time)).toHaveLength(2);
    }
  }
  expect(parseInstructionGraphExtension(toFhirR5Dosages(r6)[0].extension)?.actions[0].args
    .filter(arg => arg.role === AdviceArgumentRole.Time).map(arg => [arg.normalized, arg.relation]))
    .toEqual(["08:00", "20:00", "08:00"].map(time => [time,
      directional ? time === "08:00" ? AdviceRelation.Before : AdviceRelation.After : undefined]));
  expect(JSON.stringify(row)).toBe(before);
});


describe("scoped action conditions and independent complements", () => {
  const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it.each([
    [AdviceRelation.On, "at 08:00", "เวลา 08:00"],
    [AdviceRelation.Before, "before 08:00", "ก่อน08:00"],
    [AdviceRelation.After, "after 08:00", "หลัง08:00"]
  ] as const)("retains the selected %s clock on a negated patch instruction", (relation, enTime, thTime) => {
    const frame: AdviceFrame = {
      force: AdviceForce.Warning, polarity: AdvicePolarity.Negate,
      predicate: { lemma: "apply_patch", display: "Apply", i18n: { th: "แปะ" }, realizer: "object-time" },
      args: [
        { role: AdviceArgumentRole.Object, text: "new patch", i18n: { en: "new patch", th: "แผ่นใหม่" } },
        { role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00", relation }
      ],
      sourceText: "", span: { start: 0, end: 0 }, sequenceIndex: 0
    };
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    const r6 = toDosageDetails([fresh(row)]);
    for (const [locale, clock, body] of [
      ["en", enTime, "Do not apply new patch"], ["th", thTime, "ห้ามแปะแผ่นใหม่"]
    ]) {
      for (const text of [
        realizeInstructionGraph(graph, locale),
        ...[fresh([row]), fresh(r6)].map(input => formatSig(input, "long", { locale, realizationMode: "normalized" }))
      ]) {
        expect(text).toContain(body);
        expect(text).toContain(clock);
        expect(text?.split("08:00")).toHaveLength(2);
      }
    }
  });

  it("renders the selected clock once when negated Mix already consumes it", () => {
    const frame = parseInstructionActions("Do not mix with milk at 08:00")[0];
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Time, relation: AdviceRelation.On, normalized: "08:00:00"
    }));
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionAction(frame, locale);
      expect(text.split("08:00")).toHaveLength(2);
      expect(text).toContain(locale === "en" ? "Do not mix with milk" : "ห้ามผสม");
    }
  });

  it.each([false, true])("keeps a saved target-indexed condition with source offsets=%s", withSpan => {
    const condition = "if able to swallow", source = condition + ", Swallow 1 tablet whole";
    const frame = parseInstructionActions("Swallow 1 tablet whole", condition.length + 2)[0];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame],
      primaryAdministrationSpan: frame.span,
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: condition,
        ...(withSpan ? { span: { start: 0, end: condition.length } } : {}) }] })!;
    const graph = parseInstructionGraphExtension([fresh(marker)])!;
    expect(graph.relations?.[0].span).toEqual(withSpan ? { start: 0, end: condition.length } : undefined);
    for (const locale of ["en", "th"])
      expect(realizeInstructionGraph(graph, locale)?.toLowerCase().split(condition)).toHaveLength(2);
    const row: FhirDosage = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [fresh(marker)] };
    const r6 = toDosageDetails([fresh(row)]);
    for (const input of [fresh([row]), fresh(r6), fresh(toFhirR5Dosages(fresh(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" }).toLowerCase();
        expect(text.split(condition), text).toHaveLength(2);
      }
  });

  it.each(["breakfast", "08:00"])("retains a dilution destination after the temporal complement %s", event => {
    const source = "Dilute 1 mL with saline before " + event + " to 10 mL";
    const parsed = parsePublicSig(source), frame = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    for (const action of [frame, parseInstructionGraphExtension([fresh(marker)])!.actions[0]]) {
      expect(action.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Amount,
        quantity: expect.objectContaining({ value: 1, unit: "mL" }) }));
      expect(action.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Destination,
        relation: AdviceRelation.To, quantity: expect.objectContaining({ value: 10, unit: "mL" }) }));
      expect(action.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Time, relation: AdviceRelation.Before }));
      expect(realizeInstructionAction(action, "en")).toContain("10 mL");
    }
    expect(parsed.longText).toContain("10 mL");
  });
});


describe("complete action time realization", () => {
  it.each(["morning of surgery", "the morning", "MORN"])(
    "retains a daily Morning anchor unless the complete Time matches it (%s)", time => {
      const action = parseInstructionActions("Take 1 tablet")[0];
      const frame: AdviceFrame = { ...action, sourceText: "", args: [
        ...action.args, { role: AdviceArgumentRole.Time, text: time, normalized: time }
      ] };
      const graph = { sourceText: "", sourceLocale: "en", actions: [frame], primaryAdministrationSpan: frame.span };
      const row: FhirDosage = { method: { text: "Take" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", when: [EventTiming.Morning] } },
        extension: [buildInstructionGraphExtension(graph)!] };
      const details = toDosageDetails([row]);
      for (const input of [[row], importCanonicalCourse(row), details, toFhirR5Dosages(details)]) {
        const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(en).toContain("1 tablet");
        expect(en).toContain("once daily");
        expect(en.match(/in the morning/gu)).toHaveLength(1);
        if (time === "morning of surgery") {
          expect(en).toContain(time);
          const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
          expect(th).toContain(time);
          expect(th).toContain("ตอนเช้า");
        }
        expect(importCanonicalCourse(input).stages[0].administrations[0].schedule?.recurrence)
          .toMatchObject({ frequency: 1, period: 1, periodUnit: "d", anchors: [EventTiming.Morning] });
      }
    });

  it.each([
    ["08:00", undefined, "at 08:00"],
    ["the morning", undefined, "in the morning"],
    ["08:00", AdviceRelation.Before, "before 08:00"]
  ] as const)("uses the selected point or daypart relation for a new patch (%s, %s)", (time, relation, expected) => {
    const frame: AdviceFrame = {
      ...parseInstructionActions("Apply new patch")[0], sourceText: "", span: { start: 0, end: 0 },
      predicate: { lemma: "apply_patch", display: "Apply", i18n: { th: "แปะ" }, realizer: "object-time" },
      args: [
        { role: AdviceArgumentRole.Object, text: "new patch", i18n: { en: "new patch", th: "แผ่นใหม่" } },
        { role: AdviceArgumentRole.Time, text: time, normalized: time, relation }
      ]
    };
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    for (const text of [realizeInstructionGraph(graph, "en"),
      ...[[row], toDosageDetails([row])].map(input =>
        formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))]) {
      expect(text).toContain("Apply new patch " + expected);
    }
  });
});


describe("required graph conditions beside independent Boolean guards", () => {
  const sbp: MedicationCondition = { kind: "measurement", name: "SBP", operation: "gt", value: 160, text: "SBP > 160" };
  const pulse: MedicationCondition = { kind: "measurement", name: "pulse", operation: "gt", value: 100, text: "pulse > 100" };
  it.each([
    ["standalone", sbp, "Take 1 tablet orally only if SBP > 160."],
    ["conjunction", { kind: "all", conditions: [sbp, pulse] }, "Take 1 tablet orally only if SBP > 160 and pulse > 100."],
    ["disjunction", { kind: "any", conditions: [sbp, pulse] }, "If SBP > 160, take 1 tablet orally only if SBP > 160 or pulse > 100."],
    ["negated disjunction", { kind: "not", condition: { kind: "any", conditions: [
      { kind: "not", condition: sbp }, { kind: "not", condition: pulse }
    ] } }, "Take 1 tablet orally unless not (SBP > 160) or not (pulse > 100)."],
  ] as const)("retains the separately required condition with a %s", (_name, condition, expected) => {
    const source = "Take 1 tablet if SBP > 160";
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      actions: parseInstructionActions("Take 1 tablet"),
      primaryAdministrationSpan: { start: 0, end: 13 },
      primaryOwnership: { administrationActionIndex: 0, dose: { actionIndex: 0, argumentIndex: 0 } },
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: "if SBP > 160" }],
      coverage: { complete: true, ratio: 1, understoodCharacters: source.length, opaqueCharacters: 0 }
    })!;
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      route: { coding: [{ system: "http://snomed.info/sct", code: "26643006" }] }, extension: [marker] };
    setDosageCondition(row, JSON.parse(JSON.stringify(condition)) as MedicationCondition);
    for (const input of [[row], toDosageDetails([row]), importCanonicalCourse([row])]) {
      const before = JSON.stringify(input);
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});


describe("independent primary graph rendering owners", () => {
  it.each(["clock", "event", "duration only", "clock only"] as const)("retains Rinse duration and %s independently", kind => {
    const source = "Rinse the mouth for 1 minute at 08:00";
    const frame: AdviceFrame = { ...parseInstructionActions("Rinse mouth")[0], sourceText: "", args: [
      { role: AdviceArgumentRole.Site, text: "mouth", normalized: "mouth", i18n: { th: "ปาก" } },
      ...(kind === "clock only" ? [] : [{ role: AdviceArgumentRole.Duration, text: "1 minute", quantity: { value: 1, unit: "min" } }]),
      ...(kind === "duration only" ? [] : [{ role: AdviceArgumentRole.Time,
        text: kind === "event" ? "breakfast" : "08:00", normalized: kind === "event" ? EventTiming.Breakfast : "08:00",
        relation: kind === "event" ? AdviceRelation.Before : AdviceRelation.At }])
    ] };
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!] };
    for (const input of [[row], toDosageDetails([row])]) for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text).toContain(locale === "en" ? "Rinse mouth" : "บ้วนปาก");
      if (kind !== "clock only") expect(text).toContain(locale === "en" ? "for 1 minute" : "นาน 1 นาที");
      if (kind === "event") expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
      else if (kind !== "duration only") expect(text).toMatch(/0?8[:.]00/u);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true])("attaches an unpositioned primary guard once with independent advice %s", independent => {
    const action = parseInstructionActions("Swallow 1 tablet whole")[0];
    const call = { ...parseInstructionActions("Call the clinic")[0], span: { start: 40, end: 55 } };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en",
        actions: independent ? [action, call] : [action],
        primaryOwnership: { administrationActionIndex: 0, dose: { actionIndex: 0,
          argumentIndex: action.args.findIndex(arg => arg.role === AdviceArgumentRole.Amount) } },
        relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: "if SBP > 160" },
          ...(independent ? [{ kind: AdviceRelation.If, toActionIndex: 1, text: "if dizzy" }] : [])]
      })!] };
    for (const input of [[row], toDosageDetails([row])]) for (const locale of ["en", "th"]) {
      const before = JSON.stringify(input), text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(/SBP > 160/gu)).toHaveLength(1);
      expect(text).toMatch(locale === "en" ? /Swallow 1 tablet whole if SBP > 160/u : /กลืน.*1 เม็ด.*SBP > 160/u);
      if (independent) {
        expect(text).toMatch(locale === "en" ? /Call the clinic if dizzy/iu : /Call the clinicถ้าเวียนศีรษะ/u);
        expect(text.indexOf("160")).toBeLessThan(text.indexOf("Call"));
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each(["spray", "mL"])("keeps the proper paired-site scope of a rich %s amount", unit => {
    const action = parseInstructionActions("Spray 1 spray into both nostrils gently")[0];
    const amount = action.args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    const frame: AdviceFrame = { ...action, sourceText: "", args: action.args.map(arg => arg === amount
      ? { ...arg, text: "1 " + unit, normalized: unit, quantity: { value: 1, unit } } : arg) };
    const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit } }], method: { text: "Spray" },
      site: { text: "both nostrils" }, extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en",
        actions: [frame], primaryAdministrationSpan: frame.span })!] };
    for (const input of [[row], toDosageDetails([row])]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      if (unit === "spray") {
        expect(en).toContain("each nostril"); expect(en).not.toContain("across 2 sites");
        expect(th).toContain("ข้างละ");
      } else {
        expect(en).toContain("both nostrils"); expect(en).not.toContain("each nostril");
        expect(th).not.toContain("ข้างละ");
      }
      expect(en).toContain("1 " + (unit === "spray" ? "spray" : "mL"));
      expect(en.toLowerCase()).toContain("gently");
    }
  });
});
