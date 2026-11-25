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
import { getQuantityComparator } from "../src/fhir-quantity-operator";
import { resolveSigLocalization } from "../src/i18n";
import { buildMedicationInstructionActionCodeSystem, buildMedicationInstructionConceptCodeSystem, formatSig, fromFhirDosage, getMedicationInstructionAction, getMedicationInstructionConcept, listMedicationInstructionActions, listMedicationInstructionConcepts, resolveMedicationInstructionAction as resolvePublicAction, resolveMedicationInstructionSequenceAction, resolveMedicationInstructionConcept as resolvePublicConcept, parseInstructionActions, realizeInstructionGraph, getDosageCondition, toDosageDetails, toFhirR5Dosages } from "../src/index";
import { medicationInstructionActionCodings, resolveMedicationInstructionAction, resolveMedicationInstructionActionForMethod, resolveMedicationInstructionActionByMethod } from "../src/instruction-action-terminology";
import { medicationInstructionConceptCodings, getMedicationInstructionConcept as getInternalInstructionConcept } from "../src/instruction-concept-terminology";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseSig as parsePublicSig, nextDueDoses, calculateTotalUnits, importCanonicalCourse, projectCanonicalCourse } from "../src/index";

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
    expect(restored?.relations).toEqual(graph?.relations);
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
    expect(publicValue).not.toBe(first);
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
    expect(parseInstructionGraphExtension([extension])?.relations).toEqual(graph.relations);

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
      const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
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
    }
  );

  it("does not drop a known qualifier when an amount has a partial unit but no value", () => {
    const graph = parsePublicSig("Dissolve 2 tablets in water, then drink")
      .meta.canonical.clauses[0].instructionGraph!;
    const amount = graph.actions[0].args.find(arg => arg.role === AdviceArgumentRole.Amount)!;
    amount.quantity = { unit: "mg", comparator: "~" };
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    expect(restored.actions[0].args.find(arg =>
      arg.role === AdviceArgumentRole.Amount)?.quantity).toEqual({
        unit: "mg", comparator: "~"
      });
    expect(restored.sourceText).toBe(graph.sourceText);
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
      const frame = graph.find(a => a.predicate.lemma === "dissolve")!;
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
  it("retains an original HPSG-owned Thai dose without replaying a changed dose", () => {
    const source = "ล้างมือก่อนหยอดตา หยอดตาขวา 1 หยด แล้วหลับตา";
    const parsed = parsePublicSig(source, { locale: "th" });
    const row = parsed.items[0].fhir;
    expect(formatSig(row, "long", { locale: "th", realizationMode: "roundtrip" }))
      .toBe(source);
    const entry = row.doseAndRate![0];
    if (!entry.doseQuantity) throw new Error("Expected authored HPSG dose");
    const changed = {
      ...row,
      doseAndRate: [{ ...entry, doseQuantity: { ...entry.doseQuantity, value: 2 } }]
    };
    const text = formatSig(changed, "long", { locale: "th", realizationMode: "roundtrip" });
    expect(text).toMatch(/(?:2|สอง)\s*หยด/u);
    expect(text).not.toMatch(/(?:1|หนึ่ง)\s*หยด/u);
    expect(text).not.toBe(source);
    expect(entry.doseQuantity.value).toBe(1);
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
    expect(en).toMatch(/^Do not mix.*milk before each dose$/u);
    expect(th).toContain("ห้ามผสม");
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
    const frame = parseInstructionActions("Mix with 100 mL water")[0];
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
      const graph = parseInstructionGraphExtension(input.extension)!;
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

describe("round33 current rich-primary ownership", () => {
  it.each(["Apply", "Apply gently", "Reapply", "Reapply gently", "coding-only", "metadata"])("honors shared-code method identity %s", edit => {
    const source = "Reapply 1 g to the skin gently";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } }
    ];
    const graph = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 7 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== graph.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(graph);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    if (edit === "coding-only") delete saved.method.text;
    else if (edit === "metadata") { saved.method.id = "annotation"; saved.method.coding[0].id = "coding-annotation"; }
    else saved.method.text = edit;
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(edit.startsWith("Reapply") || edit === "metadata" ? /^Reapply\b/u : /^Apply\b/u);
      expect(text).toContain("1 g");
      expect(text).toContain("gently");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
  it.each([
    [false, "dose", true, false],
    [false, "explicit-false", true, false],
    [false, "add-delete", true, false],
    [true, "dose", true, false],
    [true, "metadata", true, false],
    [true, "replace", false, true],
    [true, "delete", false, false]
  ] as const)("keeps only current primary Site (structured %s, edit %s)", (structured, edit, right, left) => {
    const source = "Instill 1 drop into right eye";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args.push({ role: AdviceArgumentRole.Manner, text: "gently",
      normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } });
    const warning = parseInstructionActions("Do not touch right eye")[0];
    warning.span = { start: source.length + 2, end: source.length + 24 };
    warning.sequenceIndex = 1;
    const graph = buildInstructionGraphExtension({
      sourceText: source + "; Do not touch right eye", sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 7 }, actions: [primary, warning]
    })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== graph.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(graph);
    if (!structured) delete row.site;
    let saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source, true,
      edit === "explicit-false" ? [{ sourceAgreement: true, sourceHasStructuredSite: false }] : undefined)[0]));
    expect(getDosageSourceOwnership(saved)?.site).toBe(structured);
    if (edit !== "metadata") saved.doseAndRate[0].doseQuantity.value = 2;
    if (edit === "metadata") { saved.site.id = "site-annotation"; saved.site.coding[0].id = "coding-annotation"; }
    if (edit === "replace") saved.site = parsePublicSig("Instill 1 drop into left eye").fhir[0].site;
    if (edit === "delete") delete saved.site;
    if (edit === "add-delete") {
      saved.site = parsePublicSig("Instill 1 drop into left eye").fhir[0].site;
      // Saving an independent graph site alongside a later structured site
      // must not invent original structured ownership of that graph argument.
      saved = JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails([saved]))[0]));
      delete saved.site;
    }
    const before = JSON.stringify(saved), r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? edit === "metadata" ? "1 drop" : "2 drops" : edit === "metadata" ? "1 หยด" : "2 หยด");
        if (edit !== "metadata") expect(text).not.toMatch(locale === "en" ? /1 drop/u : /1 หยด/u);
        expect(text).toContain(locale === "en" ? "gently" : "เบาๆ");
        const primaryText = text.split(locale === "en" ? "Do not touch" : "ห้ามสัมผัส")[0];
        expect(primaryText.includes(locale === "en" ? "right eye" : "ตาขวา")).toBe(right);
        expect(primaryText.includes(locale === "en" ? "left eye" : "ตาซ้าย")).toBe(left);
        expect(text).toMatch(locale === "en" ? /Do not touch (?:the )?right eye/u : /ห้ามสัมผัสตาขวา/u);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});


describe("round33 declared method identity", () => {
  it.each(["unchanged", "metadata", "edited"])("keeps custom bound manner only for its current method (%s)", edit => {
    const source = "Swallow 1 tablet whole";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.actions[0].predicate.lemma = "local-swallow";
    const marker = buildInstructionGraphExtension(graph)!;
    row.extension = row.extension.filter((e: { url: string }) =>
      e.url !== marker.url && e.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    const options = { instructionActionMap: { swallow: {
      code: "local-swallow", display: "Swallow", semanticClass: "ingest",
      primaryAdministrationHead: true, methodBoundMannerConcepts: ["whole"],
      administrationMethod: { system: "http://snomed.info/sct", code: "738995006", display: "Swallow" }
    } } };
    if (edit === "metadata") saved.method.id = "annotation";
    if (edit === "edited") saved.method.coding[0] = {
      system: "http://snomed.info/sct", code: "738992009", display: "Chew"
    };
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
      expect(text).toContain("1 tablet");
      expect(text).toMatch(edit === "edited" ? /^Chew/u : /^Swallow/u);
      expect(text.includes("whole")).toBe(edit !== "edited");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });
});

describe("round33 joined-script method vocabulary bounds", () => {
  const swallow = { system: "http://snomed.info/sct", code: "738995006", display: "Swallow" };
  const chew = { system: "http://snomed.info/sct", code: "738992009", display: "Chew" };
  it("keeps an unfamiliar joined-script method source intact", () => {
    const source = "คำไม่รู้จัก".repeat(100);
    expect(resolveMedicationInstructionActionForMethod({ text: source, coding: swallow })).toBeUndefined();
  });
  it("honors long registered locale aliases and the longest matching lexical head", () => {
    const alias = "คำวิธีที่ลงทะเบียน".repeat(8);
    const options = { instructionActionMap: {
      "custom-swallow": { code: "custom-swallow", display: "Custom swallow",
        administrationMethod: swallow, localeAliases: { th: [alias] } },
      "custom-chew": { code: "custom-chew", display: "Custom chew",
        administrationMethod: chew, localeAliases: { th: [alias + "เพิ่ม"] } }
    } };
    // Compatible qualified source keeps its qualifiers, including aliases
    // longer than any default action. A conflicting current code still wins.
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "ช้า", coding: swallow }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "ช้า", coding: chew }, options)?.code).toBe("custom-chew");
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "เพิ่มช้า", coding: chew }, options)).toBeUndefined();
    expect(resolveMedicationInstructionActionForMethod({ text: alias + "เพิ่มช้า", coding: swallow }, options)?.code).toBe("custom-swallow");
  });
});


describe("round34 live method realization", () => {
  it.each(["Apply", "Rub"] as const)("keeps the live dose and compatible adjuncts for %s", method => {
    const source = "Rub 1 g into the skin gently to form foam";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to the skin gently").fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { en: "foam", th: "ฟอง" } }
    ];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 3 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    row.method = { text: "Rub", coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    if (method === "Apply") saved.method = { text: "Apply",
      coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) {
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(method === "Apply" ? /^Apply\b/u : /^Rub\b/u);
      expect(text.match(/(?:^|[^\d.+/-])\+?1(?:\.0+)?\s+g\b/gu)).toHaveLength(1);
      expect(text).toContain("skin");
      expect(text).toContain("gently");
      expect(text).toContain("foam");
    }
    expect(JSON.stringify(saved)).toBe(before);
  });

  it.each([undefined, "Custom apply", "old display"])("resolves a declared custom method by exact code (%s)", display => {
    const options = { instructionActionMap: {
      "custom-apply": { code: "custom-apply", display: "Custom apply", primaryAdministrationHead: true,
        semanticClass: "apply", administrationMethod: { system: "urn:clinic:method", code: "apply-local" } }
    } };
    const method = { text: "Swallow", coding: { system: "urn:clinic:method", code: "apply-local", ...(display ? { display } : {}) } };
    const before = JSON.stringify(method);
    expect(resolveMedicationInstructionActionForMethod(method, options)?.code).toBe("custom-apply");
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }],
      method: { text: method.text, coding: [method.coding] } };
    const text = formatSig(row, "long", { ...options, locale: "en", realizationMode: "normalized" });
    expect(text).toContain("Custom apply");
    expect(text).toContain("1 g");
    expect(text).not.toContain("Swallow");
    expect(JSON.stringify(method)).toBe(before);
    expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
      coding: { system: "urn:another:method", code: "apply-local" } }, options)?.code).toBe("swallow");
  });
});


it("round34: keeps display-selected custom method identity among equal coded definitions", () => {
  const coding = { system: "urn:clinic:method", code: "skin-application" };
  const options = { instructionActionMap: {
    "local-apply": { code: "local-apply", display: "Local apply", administrationMethod: coding },
    "local-rub": { code: "local-rub", display: "Local rub", administrationMethod: coding }
  } };
  expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
    coding: { ...coding, display: "local-rub" } }, options)?.code).toBe("local-rub");
  expect(resolveMedicationInstructionActionForMethod({ text: "Swallow",
    coding }, options)?.code).toBe("local-apply");
});


describe("round35 action realization ownership", () => {
  it("carries the resolved institution method into each locale without changing the source", () => {
    const options = { instructionActionMap: {
      "chew-slowly": { code: "chew-slowly", display: "Masticate", i18n: { th: "เคี้ยวช้าๆ" },
        primaryAdministrationHead: true,
        administrationMethod: { system: "urn:clinic:method", code: "chew-slowly" } }
    } };
    const row = { route: { text: "oral" }, method: { coding: [{ system: "urn:clinic:method", code: "chew-slowly" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    const saved = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row])]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const english = formatSig(input, "long", { ...options, locale: "en", realizationMode });
      expect(english).toContain("Masticate");
      expect(english.match(/1 tablet/gu)).toHaveLength(1);
      const thai = formatSig(input, "long", { ...options, locale: "th", realizationMode });
      expect(thai).toContain("เคี้ยวช้าๆ");
      expect(thai.match(/1 เม็ด/gu)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(saved);
    expect(formatSig({ ...row, method: { coding: [{ system: "urn:other", code: "chew-slowly" }] } },
      "long", { ...options, locale: "th" })).toContain("รับประทาน");
  });

  it("keeps amount, result, manner and site together for a result-producing action", () => {
    const frame = parseInstructionActions("Rub 1 g onto the skin gently to form foam")[0];
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", i18n: { th: "ผิวหนัง" } },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { th: "ฟอง" } }
    ];
    const saved = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionAction(frame, locale);
      expect(text.match(/(?:^|[^\d.+/-])\+?1(?:\.0+)?\s+g\b/gu)).toHaveLength(1);
      for (const word of locale === "en" ? ["Rub", "skin", "gently", "foam"] : ["ถู", "ผิวหนัง", "เบาๆ", "ฟอง"])
        expect(text).toContain(word);
    }
    expect(JSON.stringify(frame)).toBe(saved);
  });

  it("uses event names for independent temporal arguments beside a material complement", () => {
    const frame = parseInstructionActions("Dilute 1 mL with 10 mL saline before each dose")[0];
    frame.args = frame.args.filter(arg => arg.role !== AdviceArgumentRole.Activity && arg.role !== AdviceArgumentRole.Time);
    frame.args.push({ role: AdviceArgumentRole.Time, text: "breakfast", normalized: "CM", relation: AdviceRelation.Before });
    const saved = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionAction(frame, locale);
      expect(text).toContain("saline");
      expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(text).not.toContain("CM");
      expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
      expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
    }
    expect(JSON.stringify(frame)).toBe(saved);
  });
});

describe("round36 configured identity and active cadence", () => {
  it.each([1, 2])("keeps the current %s-day period authoritative in both locales", period => {
    const r6 = { step: [{ component: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QOD" }] },
        repeat: { period, periodUnit: "d" as const } } }] }] };
    const before = JSON.stringify(r6);
    for (const locale of ["en", "th"]) for (const style of ["short", "long"] as const) {
      const text = formatSig(r6, style, { locale, realizationMode: "normalized" });
      if (period === 1) {
        expect(text).not.toMatch(/other day|QOD|วันเว้นวัน/u);
        expect(text).toContain(locale === "th" ? "ทุกวัน" : style === "short" ? "Q1D" : "daily");
        expect(text).not.toMatch(/once daily|วันละครั้ง/u);
      } else expect(text).toContain(locale === "th" ? "วันเว้นวัน" : style === "short" ? "QOD" : "every other day");
    }
    expect(JSON.stringify(r6)).toBe(before);
  });

  it("selects a custom method's configured display without making that display a parser alias", () => {
    const coding = { system: "urn:clinic:method", code: "shared-preparation" };
    const options = { instructionActionMap: {
      first: { code: "first", display: "First preparation", i18n: { th: "เตรียมแรก" }, primaryAdministrationHead: true, administrationMethod: coding },
      bedside: { code: "bedside", display: "Bedside preparation", i18n: { th: "เตรียมข้างเตียง" }, primaryAdministrationHead: true, administrationMethod: coding },
    } };
    const method = { coding: { ...coding, display: "Bedside preparation" } };
    expect(resolveMedicationInstructionActionForMethod(method, options)?.code).toBe("bedside");
    expect(resolveMedicationInstructionActionForMethod({ coding }, options)?.code).toBe("first");
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], method: { coding: [method.coding] } };
    for (const input of [row, toDosageDetails([row])])
      expect(formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" })).toContain("เตรียมข้างเตียง");
  });

  it("preserves authored Coding metadata supplied by the concept vocabulary", () => {
    const coding = { system: "urn:clinic:activity", code: "physio", userSelected: false,
      _code: { id: "code-note" }, _userSelected: { id: "selected-note" },
      extension: [{ url: "urn:activity:note", valueString: "preserve" }] };
    const options = { instructionConceptMap: { physiotherapy: {
      role: AdviceArgumentRole.Activity, display: "physiotherapy", coding
    } } };
    const before = JSON.stringify(options);
    const parsed = parsePublicSig("Take 1 tablet before physiotherapy", options);
    expect(parsed.meta.canonical.clauses[0].schedule?.activityTiming?.[0].activity.coding).toMatchObject(coding);
    for (const rows of [parsed.fhir, toFhirR5Dosages(parsed.fhirNext)]) {
      const reopened = toDosageDetails(JSON.parse(JSON.stringify(rows)));
      const current = courseFromR6(reopened).stages[0].administrations[0]
        .schedule?.recurrence?.activityTiming?.[0].activity.coding;
      expect(current).toEqual(coding);
    }
    expect(JSON.stringify(options)).toBe(before);
  });

  it("uses the authored in relation for the mix action's time complement", () => {
    const frame = parseInstructionActions("Mix in the morning")[0];
    const before = JSON.stringify(frame);
    expect(realizeInstructionAction(frame, "en")).toBe("Mix in the morning");
    const thai = realizeInstructionAction(frame, "th");
    expect(thai).toContain("ผสม");
    expect(thai).toContain("ตอนเช้า");
    expect(thai).not.toContain("เวลา");
    expect(JSON.stringify(frame)).toBe(before);
  });
});


describe("round36 rich primary rendered argument ownership", () => {
  it.each(["result", "default"] as const)("keeps the edited dose and exactly one morning instruction with the %s realizer", realizer => {
    const source = "Rub 1 g into the skin gently to form foam in the morning";
    const row = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to the skin in the morning").fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.predicate.realizer = realizer;
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } },
      { role: AdviceArgumentRole.Result, text: "foam", normalized: "foam", i18n: { en: "foam", th: "ฟอง" } },
      { role: AdviceArgumentRole.Time, text: "the morning", normalized: EventTiming.Morning, i18n: { en: "the morning", th: "ตอนเช้า" } }
    ];
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 3 }, actions: [primary] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    row.method = { text: "Rub", coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] };
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    saved.doseAndRate[0].doseQuantity.value = 2;
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) for (const locale of ["en", "th"]) {
      const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
      expect(text.match(locale === "en" ? /morning/gu : /เช้า/gu)).toHaveLength(1);
      expect(text).toContain(locale === "en" ? "foam" : "ฟอง");
      expect(text).toContain(locale === "en" ? "gently" : "เบาๆ");
      expect(text.match(/(?:^|[^0-9.,+-])2 g\b/gu)).toHaveLength(1);
      expect(text).not.toMatch(/(?:^|[^0-9.,+-])1 (?:g|กรัม)(?![\p{L}\p{N}])/u);
    }
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("shows the current restricted primary site once while retaining an independent action site and saved wording", () => {
    const source = "Apply 1 g to the skin gently";
    const row = JSON.parse(JSON.stringify(parsePublicSig(source).fhir[0]));
    const primary = parseInstructionActions(source)[0];
    primary.args = [
      { role: AdviceArgumentRole.Amount, text: "1 g", normalized: "g", quantity: { value: 1, unit: "g" } },
      { role: AdviceArgumentRole.Site, text: "skin", normalized: "skin", coding: row.site.coding[0] },
      { role: AdviceArgumentRole.Manner, text: "gently", normalized: "gently", i18n: { en: "gently", th: "เบาๆ" } }
    ];
    const warning = parseInstructionActions("Do not touch right eye")[0];
    warning.span = { start: source.length + 2, end: source.length + 24 };
    warning.sequenceIndex = 1;
    const marker = buildInstructionGraphExtension({ sourceText: source + "; Do not touch right eye", sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 5 }, actions: [primary, warning] })!;
    row.extension = row.extension.filter((x: { url: string }) => x.url !== marker.url && x.url !== DOSAGE_RENDERED_INSTRUCTION_R5_URL);
    row.extension.push(marker);
    const saved = JSON.parse(JSON.stringify(withDosageEditProvenance([row], source)[0]));
    saved.site = JSON.parse(JSON.stringify(parsePublicSig("Apply 1 g to skin where skin is red").fhir[0].site));
    saved.site.extension[0].extension.find((x: { url: string }) => x.url === "predicateText").valueString = "skin is itchy";
    const before = JSON.stringify(saved);
    for (const input of [saved, toDosageDetails([saved])]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en.match(/to the skin where skin is itchy/gu)).toHaveLength(1);
      expect(en.match(/skin is itchy/gu)).toHaveLength(1);
      expect(en).toContain("gently");
      expect(en).toMatch(/Do not touch (?:the )?right eye/u);
      expect(en.match(/right eye/gu)).toHaveLength(1);
      expect(th.match(/ผิวหนัง/gu)).toHaveLength(1);
      expect(th.match(/skin is itchy/gu)).toHaveLength(1);
      expect(th).toContain("เบาๆ");
      expect(th).toContain("ห้ามสัมผัสตาขวา");
      expect(en + th).not.toContain("skin is red");
    }
    expect(JSON.stringify(saved)).toBe(before);
    expect(before).toContain("where skin is red");
    expect(parseInstructionGraphExtension(saved.extension)?.sourceText).toBe(source + "; Do not touch right eye");
  });

  it("omits only the covered amountless primary when preparation owns the amount", () => {
    const source = "Dissolve 2 tablets in water, then drink";
    const clause = parsePublicSig(source).meta.canonical.clauses[0];
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      ...clause.instructionGraph!, actions: parseInstructionActions(source)
    })!])!;
    expect(graph.actions.map(action => action.predicate.lemma)).toEqual(["dissolve", "drink"]);
    const before = JSON.stringify(graph);
    for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(graph, locale, { omitCanonicalAdministration: clause })!;
      if (locale === "en") expect(text).toBe("Dissolve 2 tablets in water");
      else expect(text).toMatch(/^ละลาย\s?2 เม็ดในน้ำ$/u);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("retains an amountless primary's independent manner when canonical administration does not cover it", () => {
    const source = "Dissolve 2 tablets in water, then drink slowly";
    const clause = parsePublicSig("Dissolve 2 tablets in water, then drink").meta.canonical.clauses[0];
    const actions = parseInstructionActions(source);
    const graph = { sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...actions[1].span } };
    const text = realizeInstructionGraph(graph, "en", { omitCanonicalAdministration: clause })!;
    expect(text).toContain("Dissolve 2 tablets in water");
    expect(text).toMatch(/drink slowly/iu);
  });
});


describe("round36 selected Time output evidence", () => {
  it.each([
    ["Remove patch before breakfast", "before breakfast", /before breakfast/gu, /ก่อนอาหารเช้า/gu],
    ["Hold the eyelid in the morning", "in the morning", /morning/gu, /เช้า/gu]
  ] as const)("reports the selected locale realizer's emitted event: %s", (source, scheduleText, english, thai) => {
    const frame = parseInstructionActions(source)[0];
    const clause = parsePublicSig(scheduleText).meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text.match(locale === "en" ? english : thai)).toHaveLength(1);
      expect(coverage.singleScheduledEvent).toBe(true);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });

  it("does not report an unrendered Time when a relation realizer selects Duration", () => {
    const frame = parseInstructionActions("Remove patch after 8 hours")[0];
    frame.args.push({ role: AdviceArgumentRole.Time, text: "the morning", normalized: EventTiming.Morning,
      i18n: { en: "the morning", th: "ตอนเช้า" } });
    const clause = parsePublicSig("in the morning").meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text).toContain(locale === "en" ? "8 hours" : "8 ชั่วโมง");
      expect(text).not.toMatch(/morning|เช้า/u);
      expect(coverage.singleScheduledEvent).toBe(false);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });

  it("reports an independent event adjunct appended after a material realizer", () => {
    const frame = parseInstructionActions("Dilute 1 mL with 10 mL saline before each dose")[0];
    frame.args = frame.args.filter(arg => arg.role !== AdviceArgumentRole.Activity && arg.role !== AdviceArgumentRole.Time);
    frame.args.push({ role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast, relation: AdviceRelation.Before });
    const clause = parsePublicSig("before breakfast").meta.canonical.clauses[0];
    const before = JSON.stringify(frame);
    for (const locale of ["en", "th"]) {
      const coverage = { singleScheduledEvent: false };
      const text = realizeRichPrimaryWithCanonicalDose(frame, clause, locale, undefined, coverage);
      expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
      expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
      expect(coverage.singleScheduledEvent).toBe(true);
    }
    expect(JSON.stringify(frame)).toBe(before);
  });
});


describe("round36 live predicate and explicit amountless primary controls", () => {
  it("uses the current predicate from fresh submitted wire restrictions in both locales", () => {
    const source = "Apply 1 g to skin where skin is red daily max 2 g/day";
    const row = structuredClone(parsePublicSig(source).fhir[0]);
    for (const locale of ["en", "th"])
      formatSig(structuredClone(row), "long", { locale, realizationMode: "roundtrip" });
    const restriction = row.site!.extension!.find(item => item.url.endsWith("medication-body-site-restriction"))!;
    restriction.extension!.find(item => item.url === "predicateText")!.valueString = "skin is itchy";
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails(JSON.parse(JSON.stringify([row])))])
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/skin is itchy/gu)).toHaveLength(1);
        expect(text).not.toContain("skin is red");
        expect(text).toMatch(locale === "en" ? /to the skin where skin is itchy/u : /ผิวหนัง.*skin is itchy/u);
        expect(text).toMatch(locale === "en" ? /1 g/u : /1 (?:g|กรัม)/u);
      }
    expect(row.text).toBe(source);
    expect(restriction.extension!.find(item => item.url === "sourceText")!.valueString).toBe("where skin is red");
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["Drink, then dissolve 2 tablets in water, then drink", "Dissolve 2 tablets in water, then drink", /2 tablets in water/u],
    ["Drink, then wait 1 hour, then drink", "Drink", /1 hour/u]
  ] as const)("retains the independent earlier amountless action: %s", (source, primaryText, retainedStep) => {
    const actions = parseInstructionActions(source);
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", actions,
      primaryAdministrationSpan: { ...actions[actions.length - 1].span }
    })!])!;
    const clause = parsePublicSig(primaryText).meta.canonical.clauses[0];
    const before = JSON.stringify(graph);
    const text = realizeInstructionGraph(graph, "en", { omitCanonicalAdministration: clause })!;
    expect(text.match(/drink/giu)).toHaveLength(1);
    expect(text).toMatch(/^Drink[;,]/u);
    expect(text).toMatch(retainedStep);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("round37 action participant and method ownership", () => {
  it.each([AdviceRelation.With, undefined])("keeps spanless participant quantities only when independently related (%s)", relation => {
    const source = "Take 1 tablet with 1 tablet of folic acid";
    const frame = parseInstructionActions("Take 1 tablet with water")[0];
    frame.sourceText = source;
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", normalized: "tab", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Object, text: "1 tablet of folic acid", normalized: "folic acid",
        relation, quantity: { value: 1, unit: "tab" } }
    ];
    const graph = { sourceText: source, sourceLocale: "en", actions: [frame], primaryAdministrationSpan: frame.span };
    const row = { doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      method: { text: "Take" }, extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
        expect(text).toContain("folic acid");
        if (relation) expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
        else expect(text).not.toMatch(/1 (?:tablets?|เม็ด)(?![\p{L}\p{N}])/u);
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(parseInstructionGraphExtension(row.extension)?.actions[0].args[1].quantity).toEqual({ value: 1, unit: "tab" });
  });

  it.each([false, true])("retains a saved Mix Theme's quantity wording (complete %s)", complete => {
    const frame = parseInstructionActions("Mix powder with water")[0];
    frame.sourceText = "";
    frame.args.unshift({ role: AdviceArgumentRole.Theme,
      text: complete ? "2 g of powder" : "up to the prescribed amount of powder",
      normalized: "powder", quantity: complete ? { value: 2, unit: "g" } : { comparator: "<=", unit: "g" } });
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const before = JSON.stringify(graph);
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, recovered]) for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(candidate, locale)!;
      expect(text).toContain(complete ? "2" : "up to the prescribed amount of powder");
      expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      if (complete) expect(text).toContain("powder");
    }
    const row = { extension: [buildInstructionGraphExtension(graph)!] };
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(complete ? "2" : "up to the prescribed amount of powder");
        expect(text).toContain(locale === "en" ? "water" : "น้ำ");
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("uses the selected Time's before relation when the Mix frame says after", () => {
    const frame = parseInstructionActions("Mix powder after breakfast")[0];
    frame.sourceText = "";
    frame.relation = AdviceRelation.After;
    frame.args = [
      { role: AdviceArgumentRole.Theme, text: "powder", normalized: "powder" },
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming["Before Breakfast"],
        relation: AdviceRelation.Before, i18n: { en: "breakfast", th: "อาหารเช้า" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
    const before = JSON.stringify(graph);
    const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, recovered]) for (const locale of ["en", "th"]) {
      const text = realizeInstructionGraph(candidate, locale)!;
      expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
      expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
    }
    const row = { extension: [buildInstructionGraphExtension(graph)!] };
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(locale === "en" ? /before breakfast/gu : /ก่อนอาหารเช้า/gu)).toHaveLength(1);
        expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
      }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("selects a request's custom method before a recognized default through public imports", () => {
    const coding = { system: "urn:clinic:method", code: "chew-slowly" };
    const options = { realizationMode: "normalized" as const, instructionActionMap: {
      "chew-slowly": { code: "chew-slowly", display: "Chew slowly", i18n: { th: "เคี้ยวช้าๆ" },
        primaryAdministrationHead: true, administrationMethod: coding }
    } };
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      method: { coding: [coding, { system: "http://snomed.info/sct", code: "738992009", display: "Chew" }] } };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { ...options, locale });
        expect(text).toContain(locale === "en" ? "Chew slowly" : "เคี้ยวช้าๆ");
        expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
      }
      expect(fromFhirDosage(row, { ...options, locale: "en" }).longText).toContain("Chew slowly");
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(formatSig(row, "long", { locale: "en", realizationMode: "normalized" })).toContain("Chew 1 tablet");
  });
});

describe("round37 rendered primary action identity", () => {
  it.each([false, true])("renders an imported Mix primary once and retains an independent Drink (structured amount %s)", structured => {
    const frame = parseInstructionActions("Mix powder with water")[0];
    frame.sourceText = "";
    const theme = { role: AdviceArgumentRole.Theme,
      text: structured ? "2 g of powder" : "up to the prescribed amount of powder",
      normalized: "powder", quantity: structured ? { value: 2, unit: "g" } : { comparator: "<=" as const, unit: "g" } };
    frame.args.unshift(theme);
    if (structured) frame.args.push({ role: AdviceArgumentRole.Amount, text: "2 g", normalized: "g",
      quantity: { value: 2, unit: "g" } });
    const independent = parseInstructionActions("Drink 5 mL")[0];
    independent.span = { start: frame.span.end + 7, end: frame.span.end + 17 };
    independent.sequenceIndex = 1;
    const graph = { sourceText: "Mix the prescribed powder with water, then drink 5 mL", sourceLocale: "en",
      primaryAdministrationSpan: frame.span, actions: [frame, independent] };
    const row = { method: { text: "Mix" }, extension: [buildInstructionGraphExtension(graph)!],
      ...(structured ? { doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }] } : {}) };
    const before = JSON.stringify(row);
    let saved = toDosageDetails([row]);
    for (let save = 0; save < 3; save++) {
      for (const input of [row, saved, toFhirR5Dosages(saved)]) for (const locale of ["en", "th"])
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(locale === "en" ? /mix/giu : /ผสม/gu)).toHaveLength(1);
          expect(text.match(locale === "en" ? /drink/giu : /ดื่ม/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "5 mL" : "5 มิลลิลิตร");
          expect(text.match(/up to the prescribed amount of powder/gu)?.length ?? 0).toBe(structured ? 0 : 1);
          if (structured) expect(text.match(/(?:^|\D)2 g/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "with water" : "กับน้ำ");
        }
      saved = toDosageDetails(JSON.parse(JSON.stringify(toFhirR5Dosages(saved))));
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("round38 live dose and action participant ownership", () => {
  it.each([10, 2.5])("uses a freshly submitted scalar weight dose of %s without replaying the old amount", value => {
    const source = "Take 5 mg/kg once daily";
    const parsed = parsePublicSig(source);
    const fresh = structuredClone(parsed.fhir[0]!);
    expect(formatSig(structuredClone(fresh), "long")).toBe(source);
    fresh.doseAndRate![0].doseQuantity!.value = value;
    for (const input of [fresh, JSON.parse(JSON.stringify(toFhirR5Dosages([fresh])))]) {
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale });
        expect(text).toContain(value + " mg/kg");
        expect(text).not.toMatch(/(?:^|[^0-9.])5 mg\/kg/u);
      }
    }
    expect(fresh.text).toBe(source);
  });

  it.each([false, true])("keeps the medication dose with powder and its separate water quantity (%s)", measuredWater => {
    const frame = parseInstructionActions("Mix powder with " + (measuredWater ? "100 mL water" : "water"))[0];
    frame.sourceText = "";
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const row = { method: { text: "Mix" }, doseAndRate: [{ doseQuantity: { value: 2, unit: "g" } }],
      extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    const course = toDosageDetails([row]);
    for (const input of [row, course, JSON.parse(JSON.stringify(toFhirR5Dosages(course)))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain("2 g of powder");
      expect(english).toContain(measuredWater ? "with 100 mL water" : "with water");
      expect(english.match(/2 g/gu)).toHaveLength(1);
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain("powder 2 g");
      expect(thai).toContain(measuredWater ? "กับน้ำ 100 มิลลิลิตร" : "กับน้ำ");
      expect(thai.match(/2 g/gu)).toHaveLength(1);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([AdviceRelation.Before, AdviceRelation.After])("uses the selected Time relation in the default realizer (%s)", relation => {
    const frame = parseInstructionActions("Swallow 1 tablet after breakfast")[0];
    frame.sourceText = "";
    frame.relation = relation === AdviceRelation.Before ? AdviceRelation.After : AdviceRelation.Before;
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" },
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming["Breakfast"],
        relation, i18n: { en: "breakfast", th: "อาหารเช้า" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const event = relation === AdviceRelation.Before ? EventTiming["Before Breakfast"] : EventTiming["After Breakfast"];
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [event] } }, extension: [buildInstructionGraphExtension(graph)!] };
    const before = JSON.stringify(row);
    for (const input of [row, toDosageDetails([row]), JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(english).toContain(relation + " breakfast");
      expect(english).not.toContain(frame.relation + " breakfast");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toContain(relation === AdviceRelation.Before ? "ก่อนอาหารเช้า" : "หลังอาหารเช้า");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("does not hide a live with-lunch event behind a saved after-lunch relation", () => {
    const frame = parseInstructionActions("Swallow 1 tablet after lunch")[0];
    frame.sourceText = "";
    frame.args = [
      { role: AdviceArgumentRole.Amount, text: "1 tablet", quantity: { value: 1, unit: "tab" } },
      { role: AdviceArgumentRole.Manner, text: "slowly", normalized: "slowly" },
      { role: AdviceArgumentRole.Time, text: "lunch", normalized: "lunch",
        relation: AdviceRelation.After, i18n: { en: "lunch", th: "อาหารกลางวัน" } }
    ];
    const graph = { sourceText: "", sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame] };
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { when: [EventTiming["Lunch"]] } }, extension: [buildInstructionGraphExtension(graph)!] };
    for (const input of [row, toDosageDetails([row]), JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const english = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(english).toContain("with lunch");
      expect(english).not.toContain("after lunch");
      expect(thai).toContain("พร้อมอาหารกลางวัน");
      expect(thai).not.toContain("หลังอาหารกลางวัน");
    }
    expect(parseInstructionGraphExtension(row.extension)!.actions[0].args[2].relation).toBe(AdviceRelation.After);
  });
});

describe("round38 configured terminology retains authored identity", () => {
  const translation = (text: string) => ({ extension: [{
    url: "http://hl7.org/fhir/StructureDefinition/translation",
    extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: text }]
  }] });

  it("preserves a wire method translation with an empty or unrelated action map", () => {
    const row = { method: { text: "Chew", _text: translation("เคี้ยวให้ละเอียด") },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }] };
    for (const instructionActionMap of [undefined, {}, { local: { code: "local", display: "Local" } }]) {
      for (const input of [row, toDosageDetails([row]), toFhirR5Dosages([row])])
        expect(formatSig(input, "long", { locale: "th", instructionActionMap })).toContain("เคี้ยวให้ละเอียด");
    }
    expect(formatSig(row, "long", { locale: "th", instructionActionMap: {
      chew: { code: "local-chew", display: "Chew", i18n: { th: "เคี้ยวช้าๆ" } }
    } })).toContain("เคี้ยวช้าๆ");
  });

  it("keeps an authored method alias and its annotations for the same custom identity", () => {
    const coding = { system: "urn:clinic:method", code: "apply" };
    const method = { text: "dab on", _text: { id: "authored-alias", ...translation("แต้มให้ทั่ว") }, coding: [coding] };
    const options = { instructionActionMap: {
      apply: { code: "local-apply", display: "Apply", aliases: ["dab on"], administrationMethod: coding }
    } };
    const clause = deserializeCanonicalContext({ method }, options);
    expect(clause.method?.text).toBe("dab on");
    expect(clause.method?._text).toEqual(method._text);
    const imported = fromFhirDosage({ method }, options);
    expect(imported.meta.normalized.method?.text).toBe("dab on");
    expect(imported.fhir.method?._text).toEqual(method._text);
    const changed = deserializeCanonicalContext({ method: { ...method,
      coding: [{ system: "http://snomed.info/sct", code: "738992009", display: "Chew" }] } }, options);
    expect(changed.method?.text).toBe("Chew");
    expect(changed.method?._text).toBeUndefined();
  });

  it.each([false, true])("keeps custom coding identity and annotations from plain or getter-backed inputs (%s)", getters => {
    class Coding {
      id = "saline-annotation";
      version = "v2";
      get system() { return "urn:clinic:fluid"; }
      get code() { return "saline"; }
      get display() { return "Custom saline"; }
    }
    const coding = getters ? new Coding() : { id: "saline-annotation", version: "v2",
      system: "urn:clinic:fluid", code: "saline", display: "Custom saline" };
    const actions = parseInstructionActions("Mix powder with saline", 0, {
      instructionConceptMap: { saline: { code: "clinic-saline", role: AdviceArgumentRole.Substance,
        display: "saline", coding } }
    });
    const graph = { sourceText: "Mix powder with saline", sourceLocale: "en", actions };
    const saved = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
    for (const candidate of [graph, saved]) {
      expect(candidate.actions[0].args.find(arg => arg.conceptId === "clinic-saline")?.coding).toMatchObject({
        system: "urn:clinic:fluid", code: "saline", display: "Custom saline", id: "saline-annotation", version: "v2"
      });
    }
  });
});

describe("round38 upper daily frequency short preview", () => {
  it.each([undefined, 1])("retains an upper-only daily frequency with period %s", period => {
    const row = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      timing: { repeat: { frequencyMax: 2, periodUnit: "d", ...(period === undefined ? {} : { period }) } } };
    for (const input of [row, toDosageDetails([row]), toFhirR5Dosages([row])]) {
      expect(formatSig(input, "short")).toContain(period === undefined ? "<=2x/d" : "<=2x/1d");
      expect(formatSig(input, "long")).toContain("up to 2 times daily");
    }
  });
  it.each([{ frequency: 2, expected: "2x/d" }, { frequency: 1, frequencyMax: 2, expected: "1-2x/d" }])("keeps exact and ranged daily counts", repeat => {
    const row = { timing: { repeat: { frequency: repeat.frequency, frequencyMax: repeat.frequencyMax, periodUnit: "d" } } };
    expect(formatSig(row, "short")).toBe(repeat.expected);
  });
});

describe("round38 selected-Time relation across action realizers", () => {
  it.each([
    "Chew 1 tablet after breakfast",
    "Rinse skin after breakfast",
    "Keep dressing after breakfast",
    "Remove patch after breakfast"
  ])("keeps the selected relation through saved graph realization: %s", source => {
    const original = parseInstructionActions(source)[0];
    for (const polarity of [AdvicePolarity.Affirm, AdvicePolarity.Negate]) {
      const frame = { ...original, sourceText: "", relation: AdviceRelation.After, polarity,
        args: [...original.args.filter(arg => arg.role !== AdviceArgumentRole.Time), {
          role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
          relation: AdviceRelation.Before, i18n: { en: "breakfast", th: "อาหารเช้า" }
        }] };
      const graph = { sourceText: "", sourceLocale: "en", actions: [frame] };
      const marker = buildInstructionGraphExtension(graph)!;
      const recovered = parseInstructionGraphExtension([marker])!;
      for (const input of [graph, recovered]) for (const locale of ["en", "th"]) {
        const text = realizeInstructionGraph(input, locale)!;
        expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
        expect(text).not.toContain(locale === "en" ? "after breakfast" : "หลังอาหารเช้า");
        expect(locale === "en" ? /^Do not /iu.test(text) : text.startsWith("ห้าม"))
          .toBe(polarity === AdvicePolarity.Negate);
      }
      for (const locale of ["en", "th"]) {
        const text = formatSig({ extension: [marker] }, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "before breakfast" : "ก่อนอาหารเช้า");
        expect(locale === "en" ? /^Do not /iu.test(text) : text.startsWith("ห้าม"))
          .toBe(polarity === AdvicePolarity.Negate);
      }
    }
  });
});

describe("round38 configured source surfaces and stored action codes", () => {
  it.each([false, true])("keeps colliding lexical and code namespaces independent of map order (%s)", reversed => {
    const chew = getMedicationInstructionAction("chew")!;
    const ordinary = { ...chew, code: "masticate", aliases: [], display: "Chew",
      i18n: { th: "เคี้ยว" } };
    const slowly = { ...chew, code: "chew-slowly", aliases: [], display: "Chew slowly",
      i18n: { th: "เคี้ยวช้าๆ" } };
    const options = { instructionActionMap: reversed
      ? { masticate: slowly, chew: ordinary } : { chew: ordinary, masticate: slowly } };
    for (const [surface, code, english, thai] of [
      ["Chew", "masticate", "Chew 1 tablet", "เคี้ยว"],
      ["Masticate", "chew-slowly", "Chew slowly 1 tablet", "เคี้ยวช้าๆ"]
    ]) {
      const actions = parseInstructionActions(surface + " 1 tablet", 0, options);
      expect(actions).toHaveLength(1);
      expect(actions[0].predicate.lemma).toBe(code);
      expect(getMedicationInstructionAction(code, options)?.code).toBe(code);
      const graph = { sourceText: "", sourceLocale: "en", actions };
      const recovered = parseInstructionGraphExtension([buildInstructionGraphExtension(graph)!])!;
      expect(recovered.actions[0].predicate.lemma).toBe(code);
      expect(realizeInstructionGraph(recovered, "en")).toContain(english);
      const savedThai = realizeInstructionGraph(recovered, "th");
      expect(savedThai).toContain(thai);
      if (code === "masticate") expect(savedThai).not.toContain("เคี้ยวช้าๆ");
      const parsed = parsePublicSig(surface + " 1 tablet daily", options);
      expect(parsed.longText).toContain(english);
      for (const input of [parsed.fhirNext, parsed.fhir,
        JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhir)))]) {
        const englishText = formatSig(input, "long", { ...options, locale: "en", realizationMode: "normalized" });
        expect(englishText).toContain(english);
        const thaiText = formatSig(input, "long", { ...options, locale: "th", realizationMode: "normalized" });
        expect(thaiText).toContain(thai);
        if (code === "masticate") expect(thaiText).not.toContain("เคี้ยวช้าๆ");
      }
    }
    expect(resolveMedicationInstructionAction("chew-slowly", options)).toBeUndefined();
    expect(resolveMedicationInstructionAction("chew-slowly", options, true)?.code).toBe("chew-slowly");
  });
});

describe("round38 procedural Object owns its authored amount", () => {
  it.each(["tab", "tablet"])("keeps one authored %s dose and retires it after a wire edit", unit => {
    const parsed = parsePublicSig("dissolve 1 " + unit + " under tongue prn chest pain");
    expect(parsed.longText).toBe("Dissolve 1 " + unit + " under tongue as needed for chest pain.");
    expect(parsed.longText.match(/\b1 tab(?:let)?\b/gu)).toHaveLength(1);
    const row = JSON.parse(JSON.stringify(parsed.fhir[0]));
    row.doseAndRate[0].doseQuantity.value = 2;
    for (const input of [row, JSON.parse(JSON.stringify(toFhirR5Dosages([row])))]) {
      const text = formatSig(input, "long", { locale: "en" });
      expect(text).toContain("2 tablets");
      expect(text).toContain("under tongue");
      expect(text).not.toMatch(/\b1 tab(?:let)?\b/u);
      expect(text.match(/2 tablets/gu)).toHaveLength(1);
    }
  });
});


describe("round39 independent graph arguments and current conditions", () => {
  it.each([[false, false], [true, false], [true, true]])(
    "renders every independent dilution adjunct once (endpoint %s, schedule %s)", (endpoint, scheduled) => {
    const frame = parseInstructionActions("Dilute 1 mL with saline to 10 mL before each dose")[0];
    frame.sourceText = "";
    frame.args[frame.args.length - 1] = {
      role: AdviceArgumentRole.Activity, text: "each dose", normalized: "each dose",
      relation: AdviceRelation.Before, i18n: { en: "each dose", th: "แต่ละครั้ง" }
    };
    if (endpoint) frame.args.push({
      role: AdviceArgumentRole.Result, text: "clear", normalized: "clear",
      relation: AdviceRelation.Until, i18n: { en: "clear", th: "ใส" }
    });
    const row = {
      ...(scheduled ? { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" as const } } } : {}),
      extension: [buildInstructionGraphExtension({
        sourceText: "", sourceLocale: "en", actions: [frame]
      })!]
    };
    const original = JSON.stringify(row);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Dilute 1 mL with saline to 10 mL");
      expect(en.match(/before each dose/gu)).toHaveLength(1);
      expect(en.match(/until clear/gu) ?? []).toHaveLength(endpoint ? 1 : 0);
      expect(th.match(/ก่อนแต่ละครั้ง/gu)).toHaveLength(1);
      expect(th.match(/จนกว่าใส/gu) ?? []).toHaveLength(endpoint ? 1 : 0);
      expect(en.includes("once daily")).toBe(scheduled);
      expect(th.includes("วันละครั้ง")).toBe(scheduled);
      if (endpoint) {
        expect(en.indexOf("before each dose")).toBeLessThan(en.indexOf("until clear"));
        expect(th.indexOf("ก่อนแต่ละครั้ง")).toBeLessThan(th.indexOf("จนกว่าใส"));
      }
    }
    expect(JSON.stringify(row)).toBe(original);
    expect(parseInstructionGraphExtension(row.extension)!.actions[0].args)
      .toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Activity, relation: AdviceRelation.Before }));
  });

  it.each([false, true])("keeps a rich primary's graph-only condition once (postposed %s)", postposed => {
    const source = "Swallow 1 tablet whole with 200 mL water";
    const condition = "if able to swallow";
    const frame = parseInstructionActions(source)[0];
    const offset = postposed ? 0 : condition.length + 2;
    frame.sourceText = "";
    frame.span = { start: offset, end: offset + source.length };
    const conditionStart = postposed ? source.length + 1 : 0;
    const graph = {
      sourceText: postposed ? source + " " + condition : condition + ", " + source,
      sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: condition,
        span: { start: conditionStart, end: conditionStart + condition.length } }]
    };
    const row = { method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [buildInstructionGraphExtension(graph)!] };
    const original = JSON.stringify(row);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/if able to swallow/giu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /swallow 1 tablet/giu : /กลืน 1 เม็ด/gu)).toHaveLength(1);
        if (locale === "en") expect(text).toMatch(postposed
          ? /^Swallow 1 tablet[^.!?]* if able to swallow\.$/u
          : /^If able to swallow, swallow 1 tablet/u);
        expect(text).toContain(locale === "en" ? "200 mL water" : "200 มิลลิลิตรน้ำ");
      }
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([
    ["Mix the tablet with water", "Mix tablet with water", "ผสมยาเม็ดกับน้ำ"],
    ["Mix the tablet with 100 mL water", "Mix tablet with 100 mL water", "ผสมยาเม็ดกับน้ำ 100 มิลลิลิตร"],
    ["Mix the tablet with milk", "Mix tablet with milk", "ผสมยาเม็ดกับmilk"],
    ["Mix with the tablet", "Mix with tablet", "ผสมด้วยยาเม็ด"],
    ["Dissolve 1 tablet in water", "Dissolve 1 tablet in water", "ละลาย1 เม็ดในน้ำ"]
  ])("keeps the head object and its companion distinct: %s", (source, english, thai) => {
    const parsed = parsePublicSig(source);
    const original = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(english + ".");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai + ".");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(original);
    const graph = parsed.meta.canonical.clauses[0].instructionGraph!;
    if (source.startsWith("Mix the tablet")) {
      expect(graph.actions[0].args).toContainEqual(expect.objectContaining({
        role: AdviceArgumentRole.Object, conceptId: "medication-tablet"
      }));
      expect(graph.actions[0].args.find(arg => arg.conceptId === "medication-tablet")!.relation).toBeUndefined();
      const vehicle = graph.actions[0].args.find(arg => source.endsWith("milk")
        ? arg.text === "milk" : arg.conceptId === "water");
      expect(vehicle?.relation).toBe(AdviceRelation.With);
      if (source.endsWith("milk")) expect(vehicle!.conceptId).toBeUndefined();
    }
  });
});

describe("round39 semantic resolver surface precedence", () => {
  const flush = { code: "rinse", display: "Flush", procedural: true,
    coding: { system: "urn:clinic:actions", code: "flush" } };
  const localRinse = { code: "local-rinse", display: "Local rinse", procedural: true,
    aliases: ["rinse"], coding: { system: "urn:clinic:actions", code: "local-rinse" } };
  it.each([false, true])("prefers a custom alias over a colliding code independent of map order (%s)", reverse => {
    const instructionActionMap = reverse ? { local: localRinse, flush } : { flush, local: localRinse };
    const parsed = parsePublicSig("local procedure", {
      instructionActionMap,
      instructionSemanticResolvers: request => ({ actions: [{
        action: "rinse", range: { start: 0, end: request.sourceText.length }
      }] })
    });
    const actions = parsed.meta.canonical.clauses[0].instructionGraph!.actions;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.predicate.lemma).toBe("local-rinse");
      expect(action.predicate.display).toBe("Local rinse");
      expect(action.predicate.codings).toContainEqual({ system: "urn:clinic:actions", code: "local-rinse" });
    }
  });
  it("keeps a built-in surface ahead of a custom code but accepts an unambiguous custom code", () => {
    for (const [proposal, map, expectedDisplay, expectedCode] of [
      ["rinse", { flush }, "Rinse", "782155003"],
      ["clinic-flush", { flush: { ...flush, code: "clinic-flush" } }, "Flush", "flush"]
    ] as const) {
      const parsed = parsePublicSig("local procedure", {
        instructionActionMap: map,
        instructionSemanticResolvers: request => ({ actions: [{
          action: proposal, range: { start: 0, end: request.sourceText.length }
        }] })
      });
      const actions = parsed.meta.canonical.clauses[0].instructionGraph!.actions;
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.predicate.display).toBe(expectedDisplay);
        expect(action.predicate.codings).toContainEqual(expect.objectContaining({ code: expectedCode }));
      }
    }
  });
});


it("does not revive an externally cleared primary dose while retaining its saved graph", () => {
  const raw = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole").fhirNext));
  const component = raw.step[0].component[0];
  delete component.doseAndRate;
  delete component.method;
  delete component.route;
  const savedGraph = JSON.stringify(parseInstructionGraphExtension(component.extension));
  for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))])
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
    const english = formatSig(input, "long", { locale: "en", realizationMode });
    const thai = formatSig(input, "long", { locale: "th", realizationMode });
    expect(english).toContain("Swallow whole");
    expect(english).not.toContain("1 tablet");
    expect(thai).toContain("กลืน");
    expect(thai).not.toContain("1 เม็ด");
  }
  expect(JSON.stringify(parseInstructionGraphExtension(component.extension))).toBe(savedGraph);
  expect(parseInstructionGraphExtension(component.extension)!.actions[0].args)
    .toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" } }));
});


describe("round40 public graph amount preservation", () => {
  it.each(["Take with breakfast 1 tablet", "Take 1 tablet with breakfast"])(
    "keeps medication quantity independent of the temporal WITH daughter: %s", source => {
    const frame = parseInstructionActions(source)[0];
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" }
    }));
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Time, normalized: EventTiming.Breakfast
    }));
    const graph = parseInstructionGraphExtension([buildInstructionGraphExtension({ sourceText: source, actions: [frame] })!])!;
    expect(graph.actions[0].args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Amount, quantity: { value: 1, unit: "tab" }
    }));
    expect(parsePublicSig(source).longText).toContain("1 tablet orally with breakfast");
  });

  it("keeps the measured accompaniment out of the medication Amount", () => {
    const frame = parseInstructionActions("Take with 200 mL water")[0];
    expect(frame.args.some(arg => arg.role === AdviceArgumentRole.Amount)).toBe(false);
    expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Substance, relation: AdviceRelation.With,
      quantity: { value: 200, unit: "mL" }
    }));
  });
});


describe("round41 supported graph and clinical preview facts", () => {
  it.each(["Substance", "Material"] as const)(
    "uses explicit vehicle attachment before an unmarked %s theme", role => {
    const options: ParseOptions = {
      instructionConceptMap: { syrup: {
        code: "clinic-syrup", role: AdviceArgumentRole[role], display: "syrup", i18n: { th: "น้ำเชื่อม" }
      } }
    };
    const parsed = parsePublicSig("Mix the syrup with 100 mL water", options);
    const frame = parseInstructionActions("Mix the syrup with 100 mL water", 0, options)[0];
    expect(frame.args[0]).toMatchObject({ role: AdviceArgumentRole[role], conceptId: "clinic-syrup" });
    expect(frame.args[1]).toMatchObject({ relation: AdviceRelation.With, quantity: { value: 100, unit: "mL" } });
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Mix syrup with 100 mL water.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ผสมน้ำเชื่อมกับน้ำ 100 มิลลิลิตร.");
    }
    // A single material remains the historical material-only construction.
    const single = parseInstructionActions("Mix syrup", 0, options)[0];
    expect(realizeInstructionAction(single, "en")).toContain("syrup");
  });

  it.each([
    ["Mix 5 mL with 100 mL water", "Mix 5 mL with 100 mL water.", "ผสม5 มิลลิลิตรกับน้ำ 100 มิลลิลิตร."],
    ["Mix 5 mL syrup with 100 mL water", "Mix 5 mL of syrup with 100 mL water.", undefined],
    ["Mix the powder with 100 mL", "Mix the powder with 100 mL.", undefined],
    ["Mix tablet with 100 mL", "Mix tablet with 100 mL.", "ผสมยาเม็ดกับ100 มิลลิลิตร."],
    ["Mix powder with 100 mL water", "Mix powder with 100 mL water.", undefined]
  ])("renders quantity-only themes without inventing an ingredient noun: %s", (source, english, thai) => {
    const parsed = parsePublicSig(source!);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(parsed.fhir))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toBe(english);
      expect(en).not.toContain("of mL");
      if (thai) expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(thai);
    }
  });

  it("renders an event-window-only schedule in both locales without creating a dose", () => {
    const row: FhirDosage = { timing: { repeat: { extension: [{
      url: TIMING_EVENT_WINDOW_EXTENSION_URL,
      extension: [{ url: "start", valueCode: EventTiming.Wake }, { url: "end", valueCode: EventTiming["Before Sleep"] }]
    }] } } };
    const raw: FhirR6DosageInstruction = { step: [{ component: [row] }] };
    const original = JSON.stringify(raw);
    for (const input of [row, raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("between after waking and bedtime");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("ระหว่างหลังตื่นนอนถึงก่อนนอน");
      for (const locale of ["en", "th"])
        expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
          .not.toMatch(/\d|\b(?:tablets?|capsules?|mL|mg|sprays?)\b|เม็ด|แคปซูล|มิลลิลิตร|มิลลิกรัม/u);
    }
    expect(courseFromR6(raw).stages[0].administrations[0].amounts).toBeUndefined();
    expect(formatSig({}, "long", { locale: "en" })).toBe("Use.");
    expect(JSON.stringify(raw)).toBe(original);
  });

  it.each([undefined, 3])("renders only authored target multiplicity for a locative site: %s", count => {
    const row: FhirDosage = {
      route: { text: "topical" }, site: { text: "below ear",
        ...(count ? { extension: [{ url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL, valueInteger: count }] } : {}) },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "g" } }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 g below the ear");
      expect(en).not.toMatch(/1 g.*(?:each|per administration target)/u);
      expect(en.includes("across 3 sites")).toBe(count === 3);
      expect(th.includes("รวม 3 จุด")).toBe(count === 3);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([false, true])("retains a covered plain administration's condition once (postposed %s)", postposed => {
    const source = "Swallow 1 tablet", condition = "if able to swallow";
    const frame = parseInstructionActions(source)[0];
    const offset = postposed ? 0 : condition.length + 2;
    frame.sourceText = "";
    frame.span = { start: offset, end: offset + source.length };
    const conditionStart = postposed ? source.length + 1 : 0;
    const graph = {
      sourceText: postposed ? source + " " + condition : condition + ", " + source,
      sourceLocale: "en", primaryAdministrationSpan: frame.span, actions: [frame],
      relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: condition,
        span: { start: conditionStart, end: conditionStart + condition.length } }]
    };
    const row: FhirDosage = {
      method: { text: "Swallow" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
      extension: [buildInstructionGraphExtension(graph)!]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/if able to swallow/giu)).toHaveLength(1);
        expect(text.match(locale === "en" ? /swallow 1 tablet/giu : /1 เม็ด/gu)).toHaveLength(1);
        if (locale === "en") expect(text).toMatch(postposed
          ? /^Swallow 1 tablet[^.!?]* if able to swallow\.$/u
          : /^If able to swallow, swallow 1 tablet/u);
      }
    expect(realizeInstructionGraph(graph, "en", { onlyWarnings: true })).toBeUndefined();
    expect(JSON.stringify(row)).toBe(original);
  });

  it.each([
    [{ duration: 1, durationUnit: "h" }, "over 1 hour", "1 ชั่วโมง"],
    [{ duration: 1, durationMax: 2, durationUnit: "h" }, "over 1 to 2 hour", "1 ถึง 2 ชั่วโมง"],
    [undefined, undefined, undefined]
  ] as const)("keeps graph-only administration duration facts: %j", (repeat, english, thai) => {
    const frame = parseInstructionActions("Wash hands")[0];
    frame.sourceText = "";
    const row: FhirDosage = {
      ...(repeat ? { timing: { repeat } } : {}),
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("Wash the hand");
      expect(th).toContain("ล้างมือ");
      if (english) { expect(en).toContain(english); expect(th).toContain(thai); }
      else { expect(en).toBe("Wash the hand."); expect(th).toBe("ล้างมือ."); }
    }
  });
});


describe("round41 graph duration endpoints", () => {
  it("preserves independent duration range endpoints beside a graph-only action", () => {
    const frame = parseInstructionActions("Wash hands")[0];
    frame.sourceText = "";
    const range = { low: { value: 30, unit: "min", code: "min" }, high: { value: 1, unit: "h", code: "h" } };
    const row: FhirDosage = {
      timing: { repeat: { extension: [{ url: TIMING_ADMINISTRATION_DURATION_EXTENSION_URL, valueRange: range }] } },
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const repeat of [r6.step[0].component[0].timing?.repeat, saved[0].timing?.repeat]) {
      expect(repeat?.extension?.find((entry: { url: string }) =>
        entry.url === TIMING_ADMINISTRATION_DURATION_EXTENSION_URL)?.valueRange).toEqual(range);
    }
    for (const input of [row, r6, saved])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "30 minutes to 1 hour" : "30 นาที ถึง 1 ชั่วโมง");
        expect(text).toContain(locale === "en" ? "Wash the hand" : "ล้างมือ");
      }
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round41 live quantity, cadence and indication previews", () => {
  it.each(["mL", "spray"])("keeps total and per-target nasal doses distinct (%s)", unit => {
    const row: FhirDosage = {
      route: { text: "nasal" }, site: { text: "both nostrils" },
      doseAndRate: [{ doseQuantity: { value: 1, unit } }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "short", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain(unit === "mL" ? "both nostrils" : "each nostril");
      expect(en.includes("each nostril")).toBe(unit === "spray");
      expect(th.includes("ข้างละ")).toBe(unit === "spray");
      expect(en).toMatch(unit === "mL" ? /^1 mL /u : /^1 spray /u);
      expect(th).toMatch(unit === "mL" ? /^1 มล\. /u : /^1 พ่น /u);
      expect(r6.step[0].component[0].doseAndRate?.[0].doseQuantity?.value).toBe(1);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  it("shows typed recurrence instead of an unrecognized stale Timing.code label", () => {
    const row: FhirDosage = {
      doseAndRate: [{ rateQuantity: { value: 2, unit: "mL/h" } }],
      timing: { code: { text: "twice daily" }, repeat: { frequency: 1, period: 1, periodUnit: "d" } }
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const text = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
      expect(text).toMatch(/(?:^|\s)1x\/d(?:\s|;|$)/u);
      expect(text).not.toContain("twice daily");
      expect(formatSig(input, "short", { locale: "th", realizationMode: "normalized" })).toContain("วันละครั้ง");
    }
    expect(JSON.stringify(row)).toBe(original);
    expect(formatSig({ timing: { code: { text: "BID" }, repeat: { frequency: 2, period: 1, periodUnit: "d" } } }, "short"))
      .toBe("BID");
  });

  it.each([
    ["มีไข้", "มีอาการไมเกรน"],
    ["ไมเกรน", "มีอาการไมเกรน"],
    ["มีอาการเตือนเฉพาะผู้ป่วย", "มีอาการเตือนเฉพาะผู้ป่วย"]
  ])("uses a live coded PRN indication without discarding authored translation %s", (translation, expected) => {
    const row: FhirDosage = {
      doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }], asNeeded: true,
      asNeededFor: [{
        text: "Migraine", coding: [{ system: "http://snomed.info/sct", code: "37796009", display: "Migraine" }],
        _text: { extension: [{
          url: "http://hl7.org/fhir/StructureDefinition/translation",
          extension: [{ url: "lang", valueCode: "th" }, { url: "content", valueString: translation }]
        }] }
      }]
    };
    const original = JSON.stringify(row), r6 = toDosageDetails([row]);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      const text = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(text).toContain(expected);
      if (translation === "มีไข้") expect(text).not.toContain("มีไข้");
    }
    expect(cold[0].asNeededFor[0]._text).toEqual(row.asNeededFor![0]._text);
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round42 graph participant and preparation ownership", () => {
  it("keeps the authored INTO vehicle and its volume across public formats", () => {
    const parsed = parsePublicSig("Mix the tablet into 100 mL juice");
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Mix tablet into 100 mL juice.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("ผสมยาเม็ดเข้าไปในjuice 100 มิลลิลิตร.");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });

  it("gives the explicit WITH vehicle priority over an unmarked substance object", () => {
    const options: ParseOptions = { instructionConceptMap: { syrup: {
      code: "clinic-syrup", role: AdviceArgumentRole.Substance, display: "syrup", i18n: { th: "น้ำเชื่อม" }
    } } };
    const frame = parseInstructionActions("Swallow syrup with water", 0, options)[0];
    frame.sourceText = "";
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: "", sourceLocale: "en", actions: [frame]
    })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Swallow syrup with water.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("กลืนน้ำเชื่อมร่วมกับน้ำ.");
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(realizeInstructionAction(parseInstructionActions("Swallow with water")[0], "en"))
      .toBe("Swallow with water");
  });

  it.each([false, true])("renders the selected object independently of argument order (%s)", reversed => {
    const frame = parseInstructionActions("Swallow the tablet with applesauce")[0];
    frame.sourceText = "";
    if (reversed) frame.args.reverse();
    const row: FhirDosage = { extension: [buildInstructionGraphExtension({
      sourceText: "", sourceLocale: "en", actions: [frame]
    })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Swallow tablet with applesauce.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("กลืนยาเม็ดร่วมกับapplesauce.");
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("retains independent priming counts when the imported graph has no primary span", () => {
    const frame = parseInstructionActions("Prime with 2 sprays")[0];
    frame.sourceText = "";
    const row: FhirDosage = {
      method: { text: "Spray" }, doseAndRate: [{ doseQuantity: { value: 1, unit: "spray" } }],
      extension: [buildInstructionGraphExtension({ sourceText: "", sourceLocale: "en", actions: [frame] })!]
    };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Spray 1 spray. Prime with 2 sprays.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("พ่นครั้งละ 1 พ่น. เตรียมอุปกรณ์พ่น 2 พ่น.");
    }
    expect(JSON.stringify(row)).toBe(before);
  });
});


it("round42: keeps BEFORE in a public imported rich patch preview", () => {
  const source = "Apply a new patch before breakfast";
  const frame = parseInstructionActions("Apply patch before breakfast")[0];
  frame.predicate.display = "Apply";
  frame.sourceText = source;
  frame.span = { start: 0, end: source.length };
  frame.args = [
    { role: AdviceArgumentRole.Object, text: "a new patch", normalized: "a new patch", i18n: { th: "แผ่นแปะใหม่" } },
    { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
      relation: AdviceRelation.Before, i18n: { th: "อาหารเช้า" } }
  ];
  const raw: FhirR6DosageInstruction = { step: [{ component: [{
    method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
    route: { coding: [{ system: "http://snomed.info/sct", code: "45890007", display: "Transdermal route" }] },
    timing: { repeat: { when: ["ACM" as EventTiming] } },
    extension: [buildInstructionGraphExtension({
      sourceText: source, sourceLocale: "en", primaryAdministrationSpan: { start: 0, end: 5 }, actions: [frame]
    })!]
  }] }] };
  const before = JSON.stringify(raw);
  for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))])
    for (const realizationMode of ["normalized", "roundtrip"] as const) {
      const en = formatSig(input, "long", { locale: "en", realizationMode });
      const th = formatSig(input, "long", { locale: "th", realizationMode });
      expect(en.match(/before breakfast/gu)).toHaveLength(1);
      expect(en).not.toContain("in breakfast");
      expect(th.match(/ก่อนอาหารเช้า/gu)).toHaveLength(1);
      expect(en).toContain("a new patch");
      expect(th).toContain("แผ่นแปะใหม่");
    }
  expect(JSON.stringify(raw)).toBe(before);
});


it.each([
  ["Mix 5 mL with 100 mL water at 08:00", "Mix 5 mL with 100 mL water at 08:00:00"],
  ["Dissolve 2 tablets in water at 08:00", "Dissolve 2 tablets in water at 08:00:00"]
])("round42: preserves a recognized clock after the material complement: %s", (source, expected) => {
  const frame = parseInstructionActions(source)[0];
  expect(frame.args).toContainEqual(expect.objectContaining({
    role: AdviceArgumentRole.Time, normalized: "08:00:00"
  }));
  const before = JSON.stringify(frame);
  expect(realizeInstructionAction(frame, "en")).toBe(expected);
  const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
  const row: FhirDosage = { extension: [extension] }, r6 = toDosageDetails([row]);
  for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
    const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
    const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
    expect(en).toMatch(/water at 08:00:00\.$/u);
    expect(th).toMatch(/น้ำ(?: 100 มิลลิลิตร)? เวลา 08:00:00\.$/u);
    expect(en.match(/08:00/gu)).toHaveLength(1);
    expect(th.match(/08:00/gu)).toHaveLength(1);
    if (source.startsWith("Dissolve")) {
      expect(en).toContain("2 tablets");
      expect(th).toContain("2 เม็ด");
      expect(r6.step[0].component[0].doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    }
  }
  expect(JSON.stringify(frame)).toBe(before);
});

describe("round43 dilution clock ownership", () => {
  it.each([
    ["Dilute 1 mL at 08:00", false, false],
    ["Dilute 1 mL with saline at 08:00", false, true],
    ["Dilute 1 mL with saline to 10 mL at 08:00", true, true]
  ] as const)("keeps the complete clock out of destination arguments: %s", (source, withVolume, withSaline) => {
    const frame = parseInstructionActions(source)[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toHaveLength(1);
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Destination && /08:00/u.test(arg.text))).toEqual([]);
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity)
      .toMatchObject({ value: 1, unit: "mL" });
    if (withVolume) expect(frame.args).toContainEqual(expect.objectContaining({
      role: AdviceArgumentRole.Destination, relation: AdviceRelation.To,
      quantity: expect.objectContaining({ value: 10, unit: "mL" })
    }));
    const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const row: FhirDosage = { extension: [marker] }, r6 = toDosageDetails([row]);
    const before = JSON.stringify(row);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text.match(/08:00/gu)).toHaveLength(1);
        expect(text).toMatch(locale === "en" ? / at 08:00:00\.$/u : / เวลา 08:00:00\.$/u);
        if (withSaline) {
          expect(text).toContain("saline");
          expect(text.indexOf("08:00")).toBeGreaterThan(text.indexOf("saline"));
        }
        expect(text).toContain(locale === "en" ? "1 mL" : "1 มิลลิลิตร");
        if (withVolume) expect(text).toContain(locale === "en" ? "10 mL" : "10 มิลลิลิตร");
      }
    expect(JSON.stringify(row)).toBe(before);
  });
});

it("round43: still clears a dose owned by the public source primary span", () => {
  const source = "Dissolve 2 tablets in water at 08:00";
  const edited = JSON.parse(JSON.stringify(parsePublicSig(source).fhirNext));
  const sourceGraph = parseInstructionGraphExtension(edited.step[0].component[0].extension)!;
  expect(sourceGraph.primaryAdministrationSpan).toEqual(sourceGraph.actions[0].span);
  delete edited.step[0].component[0].doseAndRate;
  const before = JSON.stringify(edited);
  for (const input of [edited, JSON.parse(JSON.stringify(toFhirR5Dosages(edited)))]) {
    const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
    const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
    expect(en).not.toContain("2 tablets");
    expect(th).not.toContain("2 เม็ด");
    expect(en).toContain("water");
    expect(th).toContain("น้ำ");
    expect(en).toMatch(/(?:08:00|8:00 am)/u);
    expect(th).toContain("08:00");
  }
  expect(JSON.stringify(edited)).toBe(before);
});


it("round43: preserves graph-only amounts through ordinary source-text saves without inventing a dose", () => {
  const source = "Dissolve 2 tablets in water at 08:00";
  const frame = parseInstructionActions(source)[0];
  const marker = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
  let rows: FhirDosage[] = [{ text: source, extension: [marker] }];
  const graphBefore = JSON.stringify(parseInstructionGraphExtension(rows[0].extension));
  for (let save = 0; save < 3; save++) {
    const r6 = JSON.parse(JSON.stringify(toDosageDetails(rows)));
    expect(r6.step[0].component[0].doseAndRate).toBeUndefined();
    expect(formatSig(r6, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(formatSig(r6, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
    rows = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    expect(rows[0].doseAndRate).toBeUndefined();
    expect(JSON.stringify(parseInstructionGraphExtension(rows[0].extension))).toBe(graphBefore);
    expect(formatSig(rows, "long", { locale: "en", realizationMode: "normalized" })).toContain("2 tablets");
    expect(formatSig(rows, "long", { locale: "th", realizationMode: "normalized" })).toContain("2 เม็ด");
  }
});


it("round43: keeps an exactly verified cleared dose absent in an older saved R5 parser row", () => {
  // Frozen wire from reviewed 92b64d6; do not regenerate with the new producer.
  const row: FhirDosage = JSON.parse("{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Swish 10 mL for 30 seconds, then spit\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"86495002\",\"display\":\"For\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swish\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swish\"},{\"url\":\"semanticClass\",\"valueString\":\"cleanse\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลั้วปาก\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"amount-duration\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421805007\",\"display\":\"Swish - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"sourceText\",\"valueString\":\"Swish 10 mL for 30 seconds\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"10 mL\"},{\"url\":\"normalized\",\"valueString\":\"mL\"},{\"url\":\"spanStart\",\"valueInteger\":6},{\"url\":\"spanEnd\",\"valueInteger\":11},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":10},{\"url\":\"unit\",\"valueString\":\"mL\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"duration\"},{\"url\":\"text\",\"valueString\":\"for 30 seconds\"},{\"url\":\"normalized\",\"valueString\":\"30 s\"},{\"url\":\"spanStart\",\"valueInteger\":12},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":30},{\"url\":\"unit\",\"valueString\":\"s\"}]}]}]},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":1},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"spit\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Spit out\"},{\"url\":\"semanticClass\",\"valueString\":\"expel\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"บ้วนทิ้ง\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-action\",\"code\":\"spit\",\"display\":\"Spit out\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"บ้วนทิ้ง\"}]}]}}},{\"url\":\"predicateComponent\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"activity\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"12405001\",\"display\":\"Spitting\"}}]},{\"url\":\"spanStart\",\"valueInteger\":33},{\"url\":\"spanEnd\",\"valueInteger\":37},{\"url\":\"sourceText\",\"valueString\":\"spit\"}]},{\"url\":\"graphRelation\",\"extension\":[{\"url\":\"kindCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421067001\",\"display\":\"Then - dosing instruction fragment\"}},{\"url\":\"fromActionIndex\",\"valueInteger\":0},{\"url\":\"toActionIndex\",\"valueInteger\":1},{\"url\":\"text\",\"valueString\":\", then\"},{\"url\":\"spanStart\",\"valueInteger\":26},{\"url\":\"spanEnd\",\"valueInteger\":33}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":37},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Swish 10 mL for 30 seconds, then spit\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"04945e91102ea208\"},{\"url\":\"textFingerprint\",\"valueString\":\"5e3a3c0b00177305\"},{\"url\":\"sourceHasStructuredClocks\",\"valueBoolean\":false},{\"url\":\"sourceHasStructuredEvents\",\"valueBoolean\":false},{\"url\":\"sourceHasStructuredSite\",\"valueBoolean\":false}]}]}],\"route\":{\"text\":\"swish and spit, oromucosal\",\"coding\":[{\"system\":\"http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration\",\"code\":\"SWISHSPIT\",\"display\":\"Swish and spit out, oromucosal\"},{\"system\":\"http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl\",\"code\":\"C38302\",\"display\":\"Swish and Spit Route of Administration\"}]},\"patientInstruction\":\"Swish 10 mL for 30 seconds, then spit\",\"text\":\"Swish 10 mL for 30 seconds. Then spit out.\"}");
  const before = JSON.stringify(row);
  expect(parseInstructionGraphExtension(row.extension)?.primaryAdministrationSpan).toBeUndefined();
  for (const realizationMode of ["normalized", "roundtrip"] as const) {
    const text = formatSig(row, "long", { locale: "en", realizationMode });
    expect(text).not.toMatch(/10\s*mL/iu);
    expect(text).toContain("30 seconds");
    expect(text).toContain("spit");
  }
  expect(fromFhirDosage(row, { locale: "en", realizationMode: "normalized" }).longText).not.toMatch(/10\s*mL/iu);
  expect(JSON.stringify(row)).toBe(before);
  expect(parseInstructionGraphExtension(row.extension)?.primaryAdministrationSpan).toBeUndefined();
  const exported = toFhirR5Dosages([row]);
  expect(JSON.stringify(parseInstructionGraphExtension(exported[0].extension)))
    .toBe(JSON.stringify(parseInstructionGraphExtension(row.extension)));
});


it.each(["Dissolve 2 tablets in 100 mL solvent", "Dissolve 2 tablets in water at 08:00"])(
  "round43: retains the current amount at its declared preparation owner: %s", source => {
    const edited = JSON.parse(JSON.stringify(parsePublicSig(source).fhirNext));
    edited.step[0].component[0].doseAndRate[0].doseQuantity.value = 3;
    const before = JSON.stringify(edited);
    for (const input of [edited, JSON.parse(JSON.stringify(toFhirR5Dosages(edited)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const)
        for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(locale === "en" ? /3 tablets/gu : /3 เม็ด/gu)).toHaveLength(1);
          expect(text).toMatch(locale === "en" ? /^Dissolve 3 tablets /u : /^ละลาย\s*3 เม็ด/u);
          expect(text).not.toContain(locale === "en" ? "2 tablets" : "2 เม็ด");
          if (source.includes("100 mL")) {
            expect(text).toContain(locale === "en" ? "100 mL" : "100 มิลลิลิตร");
            expect(text).toContain("solvent");
          } else {
            expect(text).toContain(locale === "en" ? "water" : "น้ำ");
            expect(text).toMatch(/(?:08:00|8:00 am)/u);
          }
        }
    expect(JSON.stringify(edited)).toBe(before);
  }
);


describe("round46 authored concept metadata and terminal action clocks", () => {
  it("detaches custom Coding primitive annotations without dropping authored metadata", () => {
    const options: ParseOptions = { instructionConceptMap: { juice: {
      code: "clinic-juice", role: AdviceArgumentRole.Substance, display: "juice",
      coding: { system: "https://example.org/clinic", code: "juice",
        _code: { id: "clinic-note", extension: [{ url: "https://example.org/note", valueString: "keep" }] },
        _userSelected: { id: "selection-note" },
        extension: [{ url: "https://example.org/outer", extension: [{ url: "inner", valueBoolean: false }] }] }
    } } };
    const before = JSON.stringify(options), result = resolvePublicConcept("juice", options)!;
    expect(result.coding).toEqual(options.instructionConceptMap!.juice.coding);
    result.coding!._code!.id = "Local note";
    result.coding!._code!.extension![0].valueString = "Local annotation";
    result.coding!._userSelected!.id = "Local selection";
    result.coding!.extension![0].extension![0].valueBoolean = true;
    expect(JSON.stringify(options)).toBe(before);
    expect(resolvePublicConcept("juice", options)!.coding).toEqual(options.instructionConceptMap!.juice.coding);
  });

  it.each(["", ".", "!"])("retains a complete clock before terminal punctuation %s", punctuation => {
    const source = "Dilute 1 mL at 08:00" + punctuation;
    const parsed = parsePublicSig(source);
    const time = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0].args
      .find(argument => argument.role === AdviceArgumentRole.Time)!;
    expect(time).toMatchObject({ text: "08:00", normalized: "08:00:00",
      span: { start: 15, end: 20 } });
    expect(source.slice(time.span!.start, time.span!.end)).toBe("08:00");
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL at 08:00:00.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("เจือจาง 1 มิลลิลิตร เวลา 08:00:00.");
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });
});

describe("round44 public vocabulary and parsed frame isolation", () => {
  it.each(["list", "get", "resolve", "sequence"] as const)("detaches the public action %s value", lookup => {
    const entry = lookup === "list" ? listMedicationInstructionActions().find(value => value.code === "swallow")!
      : lookup === "get" ? getMedicationInstructionAction("swallow")!
      : lookup === "resolve" ? resolvePublicAction("swallow")! : resolveMedicationInstructionSequenceAction("off")!;
    const display = entry.display, thai = entry.i18n?.th;
    try {
      entry.display = "Local picker label";
      if (entry.i18n) entry.i18n.th = "Local picker translation";
      const parsed = parseInstructionActions(lookup === "sequence" ? "Stop medication" : "Swallow 1 tablet")[0];
      expect(parsed.predicate.display).toBe(lookup === "sequence" ? "Stop" : "Swallow");
      expect(parsed.predicate.i18n?.th).toBe(thai);
    } finally {
      entry.display = display;
      if (entry.i18n) entry.i18n.th = thai!;
    }
  });

  it.each(["list", "get", "resolve"] as const)("detaches the public concept %s value", lookup => {
    const entry = lookup === "list" ? listMedicationInstructionConcepts().find(value => value.code === "occlusive_dressing")!
      : lookup === "get" ? getMedicationInstructionConcept("occlusive_dressing")! : resolvePublicConcept("occlusive dressing")!;
    const display = entry.display;
    try {
      entry.display = "Local dressing label";
      expect(parseInstructionActions("Cover with an occlusive dressing")[0].args
        .find(arg => arg.conceptId === "occlusive_dressing")?.normalized).toBe("an occlusive dressing");
    } finally { entry.display = display; }
  });

  it.each([false, true])("isolates a compound argument from subsequent parses (resolver %s)", semanticResolver => {
    const makeGraph = () => semanticResolver ? parsePublicSig("local procedure", {
        instructionSemanticResolvers: request => ({ actions: [{ action: "cover",
          range: { start: 0, end: request.sourceText.length }, args: [{
            role: AdviceArgumentRole.Object, range: { start: 0, end: request.sourceText.length },
            concept: "occlusive dressing"
          }] }] })
      }).meta.canonical.clauses[0].instructionGraph!
        : { sourceText: "Cover with an occlusive dressing", sourceLocale: "en",
          actions: parseInstructionActions("Cover with an occlusive dressing") };
    const graph = makeGraph();
    const before = JSON.stringify(graph);
    const expected = [
      { role: "head", text: "dressing", coding: expect.objectContaining({
        system: "http://snomed.info/sct", code: "333453004", display: "Medical dressing (physical object)"
      }) },
      { role: "qualifier", text: "occlusive" }
    ];
    const row: FhirDosage = { extension: [buildInstructionGraphExtension(graph)!] };
    const reopened = parseInstructionGraphExtension(toFhirR5Dosages(toDosageDetails([row]))[0].extension)!;
    for (const current of [graph, makeGraph(), reopened]) {
      expect(current.actions.find(frame => frame.predicate.lemma === "cover")!.args
        .find(arg => arg.conceptId === "occlusive_dressing")!.components).toEqual(expected);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("round44 existing temporal ownership", () => {
  it("keeps the first dilution volume as a destination", () => {
    const frame = parseInstructionActions("Dilute to 10 mL")[0];
    expect(frame.args).toContainEqual(expect.objectContaining({ role: AdviceArgumentRole.Destination,
      relation: AdviceRelation.To, quantity: { value: 10, unit: "mL" } }));
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Time)).toEqual([]);
    expect(realizeInstructionAction(frame, "en")).toBe("Dilute to 10 mL");
  });

  it("keeps a spaced nightly maximum complete and non-executable", () => {
    const source = "Take 1 tablet as needed, max 2 tablets / 1 night";
    const parsed = parsePublicSig(source);
    expect(parsed.meta.canonical.clauses).toHaveLength(1);
    const clause = parsed.meta.canonical.clauses[0];
    expect(clause.dose).toMatchObject({ value: 1, unit: "tab" });
    expect(clause.additionalInstructions).toContainEqual({ text: "max 2 tablets / 1 night" });
    expect(clause.schedule?.maxDosePerPeriod).toBeUndefined();
    expect(clause.schedule?.when).toBeUndefined();
    expect(clause.schedule?.duration).toBeUndefined();
    expect(parsed.fhir[0].maxDosePerPeriod).toBeUndefined();
    expect(parsed.fhirNext.renderedInstruction).toBe(source);
  });

  it("preserves an elapsed slash cap and separate slash administrations", () => {
    const capped = parsePublicSig("Take 1 tablet as needed, max 2 tablets / 8 hours");
    expect(capped.meta.canonical.clauses).toHaveLength(1);
    expect(capped.meta.canonical.clauses[0].schedule?.maxDosePerPeriod)
      .toEqual([{ amount: 2, unit: "tab", period: 8, periodUnit: "h" }]);
    const split = parsePublicSig("Take 1 tablet morning / 2 tablets evening");
    expect(split.meta.canonical.clauses.map(clause => ({ dose: clause.dose, when: clause.schedule?.when })))
      .toEqual([{ dose: { value: 1, unit: "tab" }, when: [EventTiming.Morning] },
        { dose: { value: 2, unit: "tab" }, when: [EventTiming.Evening] }]);
  });

  it.each([false, true])("retains a directional graph time beside an equal structured clock (%s)", directional => {
    const row = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole").fhir[0]));
    const graph = parseInstructionGraphExtension(row.extension)!;
    graph.actions[0].args.push({ role: AdviceArgumentRole.Time, text: "08:00", normalized: "08:00:00",
      ...(directional ? { relation: AdviceRelation.Before } : {}) });
    const marker = buildInstructionGraphExtension(graph)!;
    row.extension = row.extension.filter((entry: { url: string }) => entry.url !== marker.url);
    row.extension.push(marker);
    row.timing = { repeat: { timeOfDay: ["08:00:00"] } };
    const r6 = toDosageDetails([row]), before = JSON.stringify(row);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        expect(text).toContain(locale === "en" ? "1 tablet" : "1 เม็ด");
        if (directional) {
          expect(text).toContain(locale === "en" ? "before 08:00:00" : "ก่อน08:00:00");
          expect(text).toMatch(locale === "en" ? /\bat\s+0?8:00\s*am\b/u : /เวลา\s*0?8:00/u);
          expect(text.match(/0?8:00(?::00)?/gu)).toHaveLength(2);
        } else expect(text.match(/0?8:00(?::00)?/gu)).toHaveLength(1);
      }
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([["Do not eat", "ห้ามรับประทานอาหาร"], ["Do not swallow", "ห้ามกลืน"]])(
    "localizes the registered advice lemma: %s", (text, predicate) => {
      const row = { additionalInstruction: [{ text }] }, before = JSON.stringify(row);
      expect(formatSig(row, "long", { locale: "th", realizationMode: "normalized" })).toBe(predicate + ".");
      expect(JSON.stringify(row)).toBe(before);
    }
  );
});


describe("round45 saved instruction meaning", () => {
  // Exact public R5 rows emitted by pinned master 7d628239. These retain the
  // old frame-level WITH and its unmarked Object/Container argument.
  const frozenMixCases: Array<[string, string, FhirDosage[]]> = [["Mix powder with household spoon","household spoon",[{"extension":[{"url":"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph","extension":[{"url":"sourceText","valueString":"Mix powder with household spoon"},{"url":"sourceLocale","valueCode":"en"},{"url":"action","extension":[{"url":"sequenceIndex","valueInteger":0},{"url":"force","valueCode":"sequence"},{"url":"relationCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421463005","display":"With - dosing instruction fragment"}},{"url":"predicateLemma","valueString":"mix"},{"url":"predicateDisplay","valueString":"Mix"},{"url":"semanticClass","valueString":"prepare"},{"url":"predicateTranslation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ผสม"}]},{"url":"predicateRealizer","valueCode":"mix-substance"},{"url":"predicateCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421826007","display":"Mix"}},{"url":"spanStart","valueInteger":0},{"url":"spanEnd","valueInteger":31},{"url":"sourceText","valueString":"Mix powder with household spoon"},{"url":"argument","extension":[{"url":"role","valueCode":"theme"},{"url":"text","valueString":"powder"},{"url":"normalized","valueString":"powder"},{"url":"spanStart","valueInteger":4},{"url":"spanEnd","valueInteger":10}]},{"url":"argument","extension":[{"url":"role","valueCode":"object"},{"url":"text","valueString":"household spoon"},{"url":"normalized","valueString":"household spoon"},{"url":"conceptId","valueString":"household-spoon"},{"url":"coding","valueCoding":{"system":"http://snomed.info/sct","code":"303514007","display":"Spoon"}},{"url":"argumentCoding","valueCoding":{"system":"http://snomed.info/sct","code":"303514007","display":"Spoon"}},{"url":"spanStart","valueInteger":16},{"url":"spanEnd","valueInteger":31},{"url":"translation","extension":[{"url":"locale","valueCode":"en"},{"url":"text","valueString":"household spoon"}]},{"url":"translation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ช้อนกินข้าว"}]}]}]},{"url":"coverage","extension":[{"url":"understoodCharacters","valueInteger":31},{"url":"opaqueCharacters","valueInteger":0},{"url":"ratio","valueDecimal":1},{"url":"complete","valueBoolean":true}]}]},{"url":"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction","extension":[{"url":"instruction","valueString":"Mix powder with household spoon"},{"url":"row","extension":[{"url":"projectionFingerprint","valueString":"477013de929e05d2"},{"url":"textFingerprint","valueString":"64f761b522a80a10"}]}]}],"text":"Mix powder with household spoon.","patientInstruction":"Mix powder with household spoon"}]],["Mix powder with bottle","bottle",[{"extension":[{"url":"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph","extension":[{"url":"sourceText","valueString":"Mix powder with bottle"},{"url":"sourceLocale","valueCode":"en"},{"url":"action","extension":[{"url":"sequenceIndex","valueInteger":0},{"url":"force","valueCode":"sequence"},{"url":"relationCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421463005","display":"With - dosing instruction fragment"}},{"url":"predicateLemma","valueString":"mix"},{"url":"predicateDisplay","valueString":"Mix"},{"url":"semanticClass","valueString":"prepare"},{"url":"predicateTranslation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ผสม"}]},{"url":"predicateRealizer","valueCode":"mix-substance"},{"url":"predicateCoding","valueCoding":{"system":"http://snomed.info/sct","code":"421826007","display":"Mix"}},{"url":"spanStart","valueInteger":0},{"url":"spanEnd","valueInteger":22},{"url":"sourceText","valueString":"Mix powder with bottle"},{"url":"argument","extension":[{"url":"role","valueCode":"theme"},{"url":"text","valueString":"powder"},{"url":"normalized","valueString":"powder"},{"url":"spanStart","valueInteger":4},{"url":"spanEnd","valueInteger":10}]},{"url":"argument","extension":[{"url":"role","valueCode":"container"},{"url":"text","valueString":"bottle"},{"url":"normalized","valueString":"bottle"},{"url":"conceptId","valueString":"bottle"},{"url":"coding","valueCoding":{"system":"http://snomed.info/sct","code":"68276009","display":"Bottle"}},{"url":"argumentCoding","valueCoding":{"system":"http://snomed.info/sct","code":"68276009","display":"Bottle"}},{"url":"argumentCoding","valueCoding":{"system":"http://standardterms.edqm.eu","code":"30008000","display":"Bottle"}},{"url":"spanStart","valueInteger":16},{"url":"spanEnd","valueInteger":22},{"url":"translation","extension":[{"url":"locale","valueCode":"en"},{"url":"text","valueString":"bottle"}]},{"url":"translation","extension":[{"url":"locale","valueCode":"th"},{"url":"text","valueString":"ขวด"}]}]}]},{"url":"coverage","extension":[{"url":"understoodCharacters","valueInteger":22},{"url":"opaqueCharacters","valueInteger":0},{"url":"ratio","valueDecimal":1},{"url":"complete","valueBoolean":true}]}]},{"url":"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction","extension":[{"url":"instruction","valueString":"Mix powder with bottle"},{"url":"row","extension":[{"url":"projectionFingerprint","valueString":"6be054d159f634a0"},{"url":"textFingerprint","valueString":"f8e0341b9f5fd3d4"}]}]}],"text":"Mix powder with bottle.","patientInstruction":"Mix powder with bottle"}]]];

  it.each(frozenMixCases)("retains the old nominal companion in %s", (source, companion, frozen) => {
    const rows = JSON.parse(JSON.stringify(frozen)) as FhirDosage[];
    const before = JSON.stringify(rows), r6 = toDosageDetails(rows);
    for (const input of [rows, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(en).toContain("powder");
      expect(en).toContain("with " + companion);
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(th).toMatch(companion === "bottle" ? /bottle|ขวด/u : /household spoon|ช้อนกินข้าว/u);
    }
    expect(JSON.stringify(rows)).toBe(before);
    expect(parsePublicSig(source).longText).toContain(companion);
  });

  it("keeps the accepted duration and container with a configured procedural realizer", () => {
    const source = "Agitate bottle ten seconds", requests: string[] = [];
    const options: ParseOptions = {
      unitMap: { s: "s" },
      instructionActionMap: {
        "clinic-agitation": { code: "clinic-agitation", semanticClass: "prepare",
          display: "Agitate", i18n: { th: "เขย่า" }, procedural: true, realizer: "container-activity" }
      },
      instructionSemanticResolvers: request => {
        requests.push(request.sourceText);
        if (request.sourceText !== source) return undefined;
        return { actions: [{ action: "clinic-agitation", range: { start: 0, end: source.length }, args: [
          { role: AdviceArgumentRole.Container, range: { start: 8, end: 14 }, concept: "bottle" },
          { role: AdviceArgumentRole.Duration, range: { start: 15, end: 26 }, quantity: { value: 10, unit: "s" } }
        ] }] };
      }
    };
    const parsed = parsePublicSig(source, options);
    expect(requests).toContain(source);
    const action = parsed.meta.canonical.clauses[0].instructionGraph!.actions[0];
    expect(action.predicate.realizer).toBe("container-activity");
    expect(action.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: AdviceArgumentRole.Container, conceptId: "bottle" }),
      expect.objectContaining({ role: AdviceArgumentRole.Duration, quantity: { value: 10, unit: "s" } })
    ]));
    const r6 = toDosageDetails(parsed.fhir), before = JSON.stringify(parsed.fhir);
    for (const input of [parsed.fhir, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toContain("Agitate bottle for 10 seconds");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toContain("เขย่าขวดเป็นเวลา 10 วินาที");
    }
    expect(JSON.stringify(parsed.fhir)).toBe(before);
  });

  it.each(["PHS", "HS"])("uses current %s rather than an unmapped after-sleep graph argument", event => {
    const original = JSON.parse(JSON.stringify(parsePublicSig("Swallow 1 tablet whole after sleep").fhir[0])) as FhirDosage;
    original.timing!.repeat!.when = [EventTiming["After Sleep"]];
    const saved = JSON.parse(JSON.stringify(toFhirR5Dosages(toDosageDetails([original]))[0])) as FhirDosage;
    saved.timing!.repeat!.when = [event as EventTiming];
    const before = JSON.stringify(saved), r6 = toDosageDetails([saved]);
    for (const input of [saved, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const en = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(en).toContain("1 tablet");
      expect(en).toContain("whole");
      expect(th).toContain("1 เม็ด");
      expect(th).toContain("ทั้งเม็ด");
      if (event === "PHS") {
        expect(en.match(/after sleep/gu)).toHaveLength(1);
        expect(th).toContain("หลังจากนอน");
      } else {
        expect(en).toContain("at bedtime");
        expect(en).not.toContain("after sleep");
        expect(th).toContain("ก่อนนอน");
        expect(th).not.toMatch(/หลัง(?:จาก)?นอน/u);
      }
    }
    expect(JSON.stringify(saved)).toBe(before);
    expect(parseInstructionGraphExtension(saved.extension)!.sourceText).toBe("Swallow 1 tablet whole after sleep");
  });
});


describe("round47 public saved graph conditions and partial quantities", () => {
  // Frozen public R5 rows retain the graph array target independently of optional action labels.
  const conditionFixtures: { postposed: boolean; wire: FhirDosage }[] = [
    {
      "postposed": false,
      "wire": {
        "method": {"text": "Swallow"},
        "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab"}}],
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": "if able to swallow, Swallow 1 tablet"},
              {"url": "sourceLocale", "valueCode": "en"},
              {"url": "primaryAdministrationStart", "valueInteger": 20},
              {"url": "primaryAdministrationEnd", "valueInteger": 36},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {"url": "predicateLemma", "valueString": "swallow"},
                  {"url": "predicateDisplay", "valueString": "Swallow"},
                  {"url": "semanticClass", "valueString": "ingest"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}},
                  {
                    "url": "predicateCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421521009", "display": "Swallow - dosing instruction imperative"}
                  },
                  {"url": "spanStart", "valueInteger": 20},
                  {"url": "spanEnd", "valueInteger": 36},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "amount"},
                      {"url": "text", "valueString": "1 tablet"},
                      {"url": "normalized", "valueString": "tab"},
                      {"url": "spanStart", "valueInteger": 8},
                      {"url": "spanEnd", "valueInteger": 16},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 1}, {"url": "unit", "valueString": "tab"}]}
                    ]
                  }
                ]
              },
              {
                "url": "graphRelation",
                "extension": [
                  {"url": "kindCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421803000", "display": "If - dosing instruction fragment"}},
                  {"url": "toActionIndex", "valueInteger": 0},
                  {"url": "text", "valueString": "if able to swallow"},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 18}
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "postposed": true,
      "wire": {
        "method": {"text": "Swallow"},
        "doseAndRate": [{"doseQuantity": {"value": 1, "unit": "tab"}}],
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": "Swallow 1 tablet if able to swallow"},
              {"url": "sourceLocale", "valueCode": "en"},
              {"url": "primaryAdministrationStart", "valueInteger": 0},
              {"url": "primaryAdministrationEnd", "valueInteger": 16},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {"url": "predicateLemma", "valueString": "swallow"},
                  {"url": "predicateDisplay", "valueString": "Swallow"},
                  {"url": "semanticClass", "valueString": "ingest"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "กลืน"}]},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "738995006", "display": "Swallow"}},
                  {
                    "url": "predicateCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421521009", "display": "Swallow - dosing instruction imperative"}
                  },
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 16},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "amount"},
                      {"url": "text", "valueString": "1 tablet"},
                      {"url": "normalized", "valueString": "tab"},
                      {"url": "spanStart", "valueInteger": 8},
                      {"url": "spanEnd", "valueInteger": 16},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 1}, {"url": "unit", "valueString": "tab"}]}
                    ]
                  }
                ]
              },
              {
                "url": "graphRelation",
                "extension": [
                  {"url": "kindCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421803000", "display": "If - dosing instruction fragment"}},
                  {"url": "toActionIndex", "valueInteger": 0},
                  {"url": "text", "valueString": "if able to swallow"},
                  {"url": "spanStart", "valueInteger": 17},
                  {"url": "spanEnd", "valueInteger": 35}
                ]
              }
            ]
          }
        ]
      }
    }
  ];

  it.each(conditionFixtures.flatMap(fixture => ["present", "absent", "other"].map(indexMode => ({
    ...fixture, indexMode
  }))))("retains a saved graph condition for action position zero ($postposed, $indexMode)", ({ postposed, wire, indexMode }) => {
    const row: FhirDosage = JSON.parse(JSON.stringify(wire));
    const action = row.extension![0].extension!.find(field => field.url === "action")!;
    const index = action.extension!.find(field => field.url === "sequenceIndex")!;
    if (indexMode === "absent") action.extension = action.extension!.filter(field => field !== index);
    else index.valueInteger = indexMode === "other" ? 9 : 0;
    const original = JSON.stringify(row);
    const decoded = parseInstructionGraphExtension(row.extension)!;
    expect(decoded.actions).toHaveLength(1);
    expect(decoded.actions[0].sequenceIndex).toBe(indexMode === "absent" ? undefined : indexMode === "other" ? 9 : 0);
    expect(decoded.relations).toContainEqual(expect.objectContaining({
      kind: AdviceRelation.If, toActionIndex: 0, text: "if able to swallow"
    }));
    const direct = postposed ? "Swallow 1 tablet if able to swallow" : "if able to swallow, swallow 1 tablet";
    for (const graph of [decoded, parseInstructionGraphExtension([buildInstructionGraphExtension(decoded)!])!])
      expect(realizeInstructionGraph(graph, "en")).toBe(direct);
    const r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const english = formatSig(input, "long", { locale: "en", realizationMode });
        const thai = formatSig(input, "long", { locale: "th", realizationMode });
        expect(english).toBe(postposed ? "Swallow 1 tablet if able to swallow." : "If able to swallow, swallow 1 tablet.");
        const administration = realizationMode === "roundtrip" ? "รับประทาน 1 เม็ด" : "รับประทานครั้งละ 1 เม็ด";
        expect(thai).toBe(postposed ? `${administration} if able to swallow.` : `If able to swallow ให้${administration}.`);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });

  // The saved input is fixed independently of the current parser and encoder.
  const mixingFixtures: { side: string; status: string; wire: FhirDosage; expected: { en: string; th: string } }[] = [
    {
      "side": "companion",
      "status": "complete",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 22},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "object"},
                      {"url": "text", "valueString": "tablet"},
                      {"url": "normalized", "valueString": "tablet"},
                      {"url": "conceptId", "valueString": "medication-tablet"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://standardterms.edqm.eu", "code": "15054000", "display": "Tablet"}},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 10},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "tablet"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ยาเม็ด"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "material"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "100 mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "spanStart", "valueInteger": 16},
                      {"url": "spanEnd", "valueInteger": 22},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 100}, {"url": "unit", "valueString": "mL"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix tablet with 100 mL.", "th": "ผสมยาเม็ดกับ100 มิลลิลิตร."}
    },
    {
      "side": "companion",
      "status": "partial",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 22},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "object"},
                      {"url": "text", "valueString": "tablet"},
                      {"url": "normalized", "valueString": "tablet"},
                      {"url": "conceptId", "valueString": "medication-tablet"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "732936001", "display": "Tablet"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://standardterms.edqm.eu", "code": "15054000", "display": "Tablet"}},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 10},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "tablet"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ยาเม็ด"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "material"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "quantity", "extension": [{"url": "unit", "valueString": "mL"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix tablet with mL.", "th": "ผสมยาเม็ดกับmL."}
    },
    {
      "side": "theme",
      "status": "complete",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 19},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "theme"},
                      {"url": "text", "valueString": "5 mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "spanStart", "valueInteger": 4},
                      {"url": "spanEnd", "valueInteger": 8},
                      {"url": "quantity", "extension": [{"url": "value", "valueDecimal": 5}, {"url": "unit", "valueString": "mL"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "substance"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "water"},
                      {"url": "normalized", "valueString": "water"},
                      {"url": "conceptId", "valueString": "water"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "spanStart", "valueInteger": 14},
                      {"url": "spanEnd", "valueInteger": 19},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix 5 mL with water.", "th": "ผสม5 มิลลิลิตรกับน้ำ."}
    },
    {
      "side": "theme",
      "status": "partial",
      "wire": {
        "extension": [
          {
            "url": "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph",
            "extension": [
              {"url": "sourceText", "valueString": ""},
              {"url": "sourceLocale", "valueCode": "en"},
              {
                "url": "action",
                "extension": [
                  {"url": "sequenceIndex", "valueInteger": 0},
                  {"url": "force", "valueCode": "sequence"},
                  {
                    "url": "relationCoding",
                    "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                  },
                  {"url": "predicateLemma", "valueString": "mix"},
                  {"url": "predicateDisplay", "valueString": "Mix"},
                  {"url": "semanticClass", "valueString": "prepare"},
                  {"url": "predicateTranslation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "ผสม"}]},
                  {"url": "predicateRealizer", "valueCode": "mix-substance"},
                  {"url": "predicateCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "421826007", "display": "Mix"}},
                  {"url": "spanStart", "valueInteger": 0},
                  {"url": "spanEnd", "valueInteger": 19},
                  {"url": "sourceText", "valueString": ""},
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "theme"},
                      {"url": "text", "valueString": "mL"},
                      {"url": "normalized", "valueString": "mL"},
                      {"url": "quantity", "extension": [{"url": "unit", "valueString": "mL"}]}
                    ]
                  },
                  {
                    "url": "argument",
                    "extension": [
                      {"url": "role", "valueCode": "substance"},
                      {
                        "url": "relationCoding",
                        "valueCoding": {"system": "http://snomed.info/sct", "code": "421463005", "display": "With - dosing instruction fragment"}
                      },
                      {"url": "text", "valueString": "water"},
                      {"url": "normalized", "valueString": "water"},
                      {"url": "conceptId", "valueString": "water"},
                      {"url": "coding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "argumentCoding", "valueCoding": {"system": "http://snomed.info/sct", "code": "11713004", "display": "Water"}},
                      {"url": "spanStart", "valueInteger": 14},
                      {"url": "spanEnd", "valueInteger": 19},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "en"}, {"url": "text", "valueString": "water"}]},
                      {"url": "translation", "extension": [{"url": "locale", "valueCode": "th"}, {"url": "text", "valueString": "น้ำ"}]}
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      "expected": {"en": "Mix mL with water.", "th": "ผสมmLกับน้ำ."}
    }
  ];

  it.each(mixingFixtures)("retains the saved $status quantity-only $side without inventing a value", ({ side, status, wire, expected }) => {
    const row: FhirDosage = JSON.parse(JSON.stringify(wire));
    const original = JSON.stringify(row), decoded = parseInstructionGraphExtension(row.extension)!;
    const quantityArgument = decoded.actions[0].args.find(argument => argument.quantity?.unit === "mL")!;
    expect(quantityArgument.normalized).toBe("mL");
    expect(quantityArgument.text).toBe(status === "partial" ? "mL" : side === "theme" ? "5 mL" : "100 mL");
    expect(quantityArgument.quantity?.value).toBe(status === "partial" ? undefined : side === "theme" ? 5 : 100);
    expect(quantityArgument.quantity?.unit).toBe("mL");
    const companion = side === "companion" ? quantityArgument : decoded.actions[0].args.find(argument => argument.normalized === "water")!;
    expect(companion.relation).toBe(AdviceRelation.With);
    const r6 = toDosageDetails([row]);
    const cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toBe(expected.en);
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" })).toBe(expected.th);
    }
    const restored = parseInstructionGraphExtension(cold[0].extension)!;
    expect(restored.actions[0].args.find(argument => argument.quantity?.unit === "mL")?.quantity)
      .toEqual(quantityArgument.quantity);
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round48 saved preparation quantities", () => {
  it.each([false, true])("keeps a live medication amount separate from a saved With vehicle (%s)", measured => {
    const source = "Mix with " + (measured ? "100 mL water" : "water");
    const frame = parseInstructionActions(source)[0];
    const row: FhirDosage = { method: { text: "Mix" },
      doseAndRate: [{ doseQuantity: { value: 2, unit: "tab" } }],
      extension: [buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame] })!] };
    const before = JSON.stringify(row), r6 = toDosageDetails([row]);
    for (const input of [row, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe("Mix 2 tablets with " + (measured ? "100 mL water." : "water."));
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe("ผสม2 เม็ดกับน้ำ" + (measured ? " 100 มิลลิลิตร." : "."));
      }
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("keeps the object quantity from a pinned-master saved dilution graph", () => {
    // Exact ordinary parser row from 7d62823, with no saved predicate realizer.
    const legacy: FhirDosage = JSON.parse("{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"dilute\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Dilute\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"เจือจาง\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421399004\",\"display\":\"Dilute - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":11},{\"url\":\"sourceText\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"object\"},{\"url\":\"text\",\"valueString\":\"1 mL\"},{\"url\":\"normalized\",\"valueString\":\"1 ml\"}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":11},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Dilute 1 mL\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"aad6e640fa986e9e\"},{\"url\":\"textFingerprint\",\"valueString\":\"2911d1f74ead3591\"}]}]}],\"text\":\"Dilute 1 mL.\",\"patientInstruction\":\"Dilute 1 mL\"}");
    const before = JSON.stringify(legacy), r6 = toDosageDetails([legacy]);
    for (const input of [legacy, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL.");
      const thai = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
      expect(thai).toBe("เจือจาง1 มิลลิลิตร.");
    }
    const current = parsePublicSig("Dilute 1 mL to 10 mL");
    for (const input of [current.fhirNext, JSON.parse(JSON.stringify(current.fhir))]) {
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Dilute 1 mL to 10 mL.");
    }
    expect(JSON.stringify(legacy)).toBe(before);
  });
});


describe("round 49 saved instruction ownership", () => {
  // Complete saved inputs are frozen independently of the current parser.
  const mixing: { source: string; wire: FhirDosage[]; thai: string }[] = JSON.parse("[{\"source\":\"Mix with a household spoon\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":26},{\"url\":\"sourceText\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"material\"},{\"url\":\"text\",\"valueString\":\"a household spoon\"},{\"url\":\"normalized\",\"valueString\":\"a household spoon\"},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":26}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":26},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with a household spoon\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"755ab910a97fa391\"},{\"url\":\"textFingerprint\",\"valueString\":\"637eec5945f4701d\"}]}]}],\"text\":\"Mix with a household spoon.\",\"patientInstruction\":\"Mix with a household spoon\"}],\"thai\":\"ผสมด้วยa household spoon.\"},{\"source\":\"Mix with household spoon\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"sourceText\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"object\"},{\"url\":\"text\",\"valueString\":\"household spoon\"},{\"url\":\"normalized\",\"valueString\":\"household spoon\"},{\"url\":\"conceptId\",\"valueString\":\"household-spoon\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"303514007\",\"display\":\"Spoon\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"303514007\",\"display\":\"Spoon\"}},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"household spoon\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ช้อนกินข้าว\"}]}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":24},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with household spoon\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"804ea8f8c2800b4f\"},{\"url\":\"textFingerprint\",\"valueString\":\"6c1690c82d30fb50\"}]}]}],\"text\":\"Mix with household spoon.\",\"patientInstruction\":\"Mix with household spoon\"}],\"thai\":\"ผสมด้วยช้อนกินข้าว.\"},{\"source\":\"Mix with bottle\",\"wire\":[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Mix with bottle\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"mix\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Mix\"},{\"url\":\"semanticClass\",\"valueString\":\"prepare\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผสม\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"mix-substance\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421826007\",\"display\":\"Mix\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":15},{\"url\":\"sourceText\",\"valueString\":\"Mix with bottle\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"container\"},{\"url\":\"text\",\"valueString\":\"bottle\"},{\"url\":\"normalized\",\"valueString\":\"bottle\"},{\"url\":\"conceptId\",\"valueString\":\"bottle\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"68276009\",\"display\":\"Bottle\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"68276009\",\"display\":\"Bottle\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://standardterms.edqm.eu\",\"code\":\"30008000\",\"display\":\"Bottle\"}},{\"url\":\"spanStart\",\"valueInteger\":9},{\"url\":\"spanEnd\",\"valueInteger\":15},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"bottle\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ขวด\"}]}]}]},{\"url\":\"coverage\",\"extension\":[{\"url\":\"understoodCharacters\",\"valueInteger\":15},{\"url\":\"opaqueCharacters\",\"valueInteger\":0},{\"url\":\"ratio\",\"valueDecimal\":1},{\"url\":\"complete\",\"valueBoolean\":true}]}]},{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-rendered-instruction\",\"extension\":[{\"url\":\"instruction\",\"valueString\":\"Mix with bottle\"},{\"url\":\"row\",\"extension\":[{\"url\":\"projectionFingerprint\",\"valueString\":\"adfd6b811a8bf2d1\"},{\"url\":\"textFingerprint\",\"valueString\":\"45c8fff0ebd7df19\"}]}]}],\"text\":\"Mix with bottle.\",\"patientInstruction\":\"Mix with bottle\"}],\"thai\":\"ผสมด้วยขวด.\"}]");
  it.each(mixing)("retains the vehicle relation in saved $source", ({ source, wire, thai }) => {
    const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
    for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }).replace(/\.$/u, "")).toBe(source);
        expect(formatSig(input, "long", { locale: "th", realizationMode })).toBe(thai);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(wire)).toBe(original);
  });

  const savedWarning: FhirDosage[] = JSON.parse("[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Do not apply 1 g hydrocortisone cream to broken skin\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"warning\"},{\"url\":\"polarity\",\"valueCode\":\"negate\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421035004\",\"display\":\"To - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"apply\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Apply\"},{\"url\":\"semanticClass\",\"valueString\":\"administration\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ทา\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738991002\",\"display\":\"Apply\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"417924000\",\"display\":\"Apply - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":52},{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"theme\"},{\"url\":\"text\",\"valueString\":\"hydrocortisone cream\"},{\"url\":\"normalized\",\"valueString\":\"hydrocortisone cream\"},{\"url\":\"spanStart\",\"valueInteger\":17},{\"url\":\"spanEnd\",\"valueInteger\":37}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"site\"},{\"url\":\"text\",\"valueString\":\"broken skin\"},{\"url\":\"normalized\",\"valueString\":\"broken skin\"},{\"url\":\"conceptId\",\"valueString\":\"broken-skin\"},{\"url\":\"component\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"head\"},{\"url\":\"text\",\"valueString\":\"broken skin\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"247442005\",\"display\":\"Broken skin (disorder)\"}}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"broken skin\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ผิวหนังที่มีแผล\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"1 g\"},{\"url\":\"normalized\",\"valueString\":\"g\"},{\"url\":\"spanStart\",\"valueInteger\":13},{\"url\":\"spanEnd\",\"valueInteger\":16},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":1},{\"url\":\"unit\",\"valueString\":\"g\"}]}]}]}]}]}]");
  it.each([true, false].flatMap(negated => [true, false].map(quantified => ({ negated, quantified }))))(
    "retains medication Theme and Site together (negated=$negated, quantified=$quantified)",
    ({ negated, quantified }) => {
      let wire: FhirDosage[] = JSON.parse(JSON.stringify(savedWarning));
      if (!negated || !quantified) {
        const source = `${negated ? "Do not apply" : "Apply"} ${quantified ? "1 g " : ""}hydrocortisone cream to broken skin`;
        const frame = parseInstructionActions(source)[0];
        const object = frame.args.find(arg => arg.role === AdviceArgumentRole.Object)!;
        frame.args[frame.args.indexOf(object)] = { role: AdviceArgumentRole.Theme,
          text: "hydrocortisone cream", normalized: "hydrocortisone cream",
          span: { start: source.indexOf("hydrocortisone"), end: source.indexOf(" to ") } };
        frame.sourceText = "";
        wire = [{ extension: [buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!] }];
      }
      const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
      for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
        const before = JSON.stringify(input);
        for (const realizationMode of ["normalized", "roundtrip"] as const) for (const locale of ["en", "th"]) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text).toContain("hydrocortisone cream");
          expect(text.match(/hydrocortisone cream/gu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "to broken skin" : "ผิวหนังที่มีแผล");
          expect(text.includes("1 g")).toBe(quantified);
          expect(locale === "en" ? /^Do not /u.test(text) : /^ห้าม/u.test(text)).toBe(negated);
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(wire)).toBe(original);
    }
  );

  const savedPreparation: FhirDosage[] = JSON.parse("[{\"method\":{\"text\":\"Swallow\"},\"doseAndRate\":[{\"doseQuantity\":{\"value\":1,\"unit\":\"tab\"}}],\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"Measure 100 mL of water; swallow whole\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"primaryAdministrationStart\",\"valueInteger\":25},{\"url\":\"primaryAdministrationEnd\",\"valueInteger\":38},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"measure\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Measure\"},{\"url\":\"semanticClass\",\"valueString\":\"measure\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ตวง\"}]},{\"url\":\"predicateRealizer\",\"valueCode\":\"object-amount-material\"},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"129266000\",\"display\":\"Measurement - action\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":23},{\"url\":\"sourceText\",\"valueString\":\"Measure 100 mL of water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"theme\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"spanStart\",\"valueInteger\":18},{\"url\":\"spanEnd\",\"valueInteger\":23},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"amount\"},{\"url\":\"text\",\"valueString\":\"100 mL\"},{\"url\":\"normalized\",\"valueString\":\"mL\"},{\"url\":\"spanStart\",\"valueInteger\":8},{\"url\":\"spanEnd\",\"valueInteger\":14},{\"url\":\"quantity\",\"extension\":[{\"url\":\"value\",\"valueDecimal\":100},{\"url\":\"unit\",\"valueString\":\"mL\"}]}]}]},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":1},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":25},{\"url\":\"spanEnd\",\"valueInteger\":38},{\"url\":\"sourceText\",\"valueString\":\"swallow whole\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"manner\"},{\"url\":\"text\",\"valueString\":\"whole\"},{\"url\":\"normalized\",\"valueString\":\"whole\"},{\"url\":\"conceptId\",\"valueString\":\"whole\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"whole\",\"display\":\"whole\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"ทั้งเม็ด\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"whole\",\"display\":\"whole\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"ทั้งเม็ด\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"255503000\",\"display\":\"Entire (qualifier value)\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"whole\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"ทั้งเม็ด\"}]}]}]}]}]}]");
  it.each([1, 2])("keeps independent water quantity before Swallow %s tablets", value => {
    const wire: FhirDosage[] = JSON.parse(JSON.stringify(savedPreparation));
    wire[0].doseAndRate![0].doseQuantity!.value = value;
    const original = JSON.stringify(wire), r6 = toDosageDetails(wire);
    for (const input of [wire, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe(`${realizationMode === "roundtrip" ? "Measure 100 mL of water" : "Measure water 100 mL"}. Swallow ${value} tablet${value === 1 ? "" : "s"} whole.`);
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe(`ตวงน้ำ 100 มิลลิลิตร. กลืน ${value} เม็ดทั้งเม็ด.`);
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(wire)).toBe(original);
  });

  it.each([
    "Dissolve 2 tablets in water, then drink slowly",
    "Disperse 2 tablets in water, then swallow slowly with water",
    "Measure 5 mL of medication; swallow",
    "Draw up 2 mL, then inject"
  ].flatMap(source => ["tab", "mg"].map(unit => ({ source, unit })) ))(
    "keeps an actual preparation dose owner after an external edit: $source / $unit",
    ({ source, unit }) => {
      // Disperse is the existing institution-configured procedure control.
      const options: ParseOptions = source.startsWith("Disperse") ? { instructionActionMap: {
        disperse: { code: "disperse", display: "Disperse", semanticClass: "procedure", procedural: true,
          acceptsAmount: true, definesDose: true, argumentParser: "amount-material-destination",
          realizer: "amount-material-destination" }
      } } : {};
      const r6 = JSON.parse(JSON.stringify(parsePublicSig(source, options).fhirNext)) as FhirR6DosageInstruction;
      expect(r6.step).toHaveLength(1);
      expect(r6.step![0].component).toHaveLength(1);
      r6.step![0].component[0].doseAndRate![0].doseQuantity!.value = 3;
      r6.step![0].component[0].doseAndRate![0].doseQuantity!.unit = unit;
      const original = JSON.stringify(r6), r5 = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
      for (const input of [r6, r5, toDosageDetails(r5)]) {
        const before = JSON.stringify(input);
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { ...options, locale: "en", realizationMode });
          expect(text.match(unit === "tab" ? /3 tablets/gu : /3 mg/gu)).toHaveLength(1);
          expect(text).toMatch(new RegExp("^" + source.split(" ")[0]));
          const amount = unit === "tab" ? "3 tablets" : "3 mg";
          const preparation = text.split(/[.;]/u)[0];
          const administration = text.slice(preparation.length);
          const action = source.startsWith("Dissolve") ? /\bdrink\b/iu
            : source.startsWith("Draw up") ? /\binject\b/iu : /\bswallow\b/iu;
          expect(preparation).toContain(amount);
          expect(administration).toMatch(action);
          expect(administration).not.toContain(amount);
          expect(text).not.toMatch(/(?:^|[^0-9.])2 tablets?(?![a-z])/u);
          if (source.startsWith("Measure")) {
            expect(text).not.toMatch(/(?:^|[^0-9.])5 mL(?![a-z])/iu);
          }
          if (source.startsWith("Draw up")) {
            expect(text).not.toMatch(/(?:^|[^0-9.])2 mL(?![a-z])/iu);
          }
        }
        expect(JSON.stringify(input)).toBe(before);
      }
      expect(JSON.stringify(r6)).toBe(original);
    }
  );
});


describe("round50 configured safety action identity", () => {
  it.each(["defer", "clinic-defer"])("retains conditional advice under saved code %s", code => {
    const options: ParseOptions = { instructionActionMap: { defer: {
      code, display: "Defer", semanticClass: "procedure", procedural: true, safetyScopeTarget: true
    } } };
    const source = "Defer if BP >160";
    const parsed = parsePublicSig(source, options);
    expect(parsed.input).toBe(source);
    const advice = parsed.meta.canonical.clauses[0].additionalInstructions!;
    expect(advice).toHaveLength(1);
    expect(advice[0].text).toBe(source);
    expect(advice[0].frames).toHaveLength(1);
    expect(advice[0].frames![0].predicate.lemma).toBe(code);
    const before = JSON.stringify(parsed.fhirNext);
    for (const input of [parsed.fhir, parsed.fhirNext, JSON.parse(JSON.stringify(toFhirR5Dosages(parsed.fhirNext)))]) {
      const extensions = Array.isArray(input) ? input[0].extension : input.step[0].component[0].extension;
      const savedGraph = parseInstructionGraphExtension(extensions);
      expect(savedGraph?.actions.map(action => action.predicate.lemma)).toEqual([code]);
      expect(savedGraph?.actions[0].predicate.codings).toContainEqual({
        system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action", code, display: "Defer"
      });
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { ...options, locale: "en", realizationMode });
        expect(text).toMatch(/Defer if BP >\s*160(?![0-9]|[.][0-9])/u);
      }
    }
    expect(JSON.stringify(parsed.fhirNext)).toBe(before);
  });
});


describe("round50 saved frame-level accompaniment ownership", () => {
  // Exact R5 graph fixtures produced by pinned master 7d628239.
  const savedRows: FhirDosage[][] = JSON.parse("[[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":24},{\"url\":\"sourceText\",\"valueString\":\"Swallow syrup with water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"syrup\"},{\"url\":\"normalized\",\"valueString\":\"syrup\"},{\"url\":\"conceptId\",\"valueString\":\"clinic-syrup\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"clinic-syrup\",\"display\":\"syrup\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"น้ำเชื่อม\"}]}]}}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"urn:ezmedicationinput:CodeSystem:medication-instruction-concept\",\"code\":\"clinic-syrup\",\"display\":\"syrup\",\"_display\":{\"extension\":[{\"url\":\"http://hl7.org/fhir/StructureDefinition/translation\",\"extension\":[{\"url\":\"lang\",\"valueCode\":\"th\"},{\"url\":\"content\",\"valueString\":\"น้ำเชื่อม\"}]}]}}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"syrup\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำเชื่อม\"}]}]},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]}]}]}]}],[{\"extension\":[{\"url\":\"urn:ezmedicationinput:StructureDefinition:medication-instruction-graph\",\"extension\":[{\"url\":\"sourceText\",\"valueString\":\"\"},{\"url\":\"sourceLocale\",\"valueCode\":\"en\"},{\"url\":\"action\",\"extension\":[{\"url\":\"sequenceIndex\",\"valueInteger\":0},{\"url\":\"force\",\"valueCode\":\"sequence\"},{\"url\":\"relationCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421463005\",\"display\":\"With - dosing instruction fragment\"}},{\"url\":\"predicateLemma\",\"valueString\":\"swallow\"},{\"url\":\"predicateDisplay\",\"valueString\":\"Swallow\"},{\"url\":\"semanticClass\",\"valueString\":\"ingest\"},{\"url\":\"predicateTranslation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"กลืน\"}]},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"738995006\",\"display\":\"Swallow\"}},{\"url\":\"predicateCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"421521009\",\"display\":\"Swallow - dosing instruction imperative\"}},{\"url\":\"spanStart\",\"valueInteger\":0},{\"url\":\"spanEnd\",\"valueInteger\":18},{\"url\":\"sourceText\",\"valueString\":\"Swallow with water\"},{\"url\":\"argument\",\"extension\":[{\"url\":\"role\",\"valueCode\":\"substance\"},{\"url\":\"text\",\"valueString\":\"water\"},{\"url\":\"normalized\",\"valueString\":\"water\"},{\"url\":\"conceptId\",\"valueString\":\"water\"},{\"url\":\"coding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"argumentCoding\",\"valueCoding\":{\"system\":\"http://snomed.info/sct\",\"code\":\"11713004\",\"display\":\"Water\"}},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"en\"},{\"url\":\"text\",\"valueString\":\"water\"}]},{\"url\":\"translation\",\"extension\":[{\"url\":\"locale\",\"valueCode\":\"th\"},{\"url\":\"text\",\"valueString\":\"น้ำ\"}]}]}]}]}]}]]");
  it.each([0, 1])("keeps the saved object and accompaniment distinct (fixture %s)", index => {
    const row = savedRows[index], original = JSON.stringify(row);
    const r6 = toDosageDetails(row), cold = JSON.parse(JSON.stringify(toFhirR5Dosages(r6)));
    for (const input of [row, r6, cold]) {
      const before = JSON.stringify(input);
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        expect(formatSig(input, "long", { locale: "en", realizationMode }))
          .toBe(index === 0 ? "Swallow syrup with water." : "Swallow with water.");
        expect(formatSig(input, "long", { locale: "th", realizationMode }))
          .toBe(index === 0 ? "กลืนน้ำเชื่อมร่วมกับน้ำ." : "กลืนร่วมกับน้ำ.");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(JSON.stringify(row)).toBe(original);
  });
});


describe("round51 saved dilution and patch facts", () => {
  it.each([
    [true, AdviceRelation.To, 10, "Do not dilute to 10 mL"],
    [false, AdviceRelation.To, 10, "Dilute to 10 mL"],
    [false, undefined, 1, "Dilute 1 mL"]
  ] as const)("retains the legacy head relation on its unmarked volume: %s / %s", (negated, relation, value, source) => {
    // Actual legacy shape: the relation is on the frame and the volume is Object.
    const frame = {
      force: negated ? AdviceForce.Warning : AdviceForce.Sequence,
      ...(negated ? { polarity: AdvicePolarity.Negate } : {}),
      predicate: { lemma: "dilute", semanticClass: "prepare", display: "Dilute",
        i18n: { th: "เจือจาง" }, codings: [{ system: "http://snomed.info/sct",
          code: "421399004", display: "Dilute - dosing instruction imperative" }] },
      relation, args: [{ role: AdviceArgumentRole.Object, text: value + " mL", normalized: value + " ml" }],
      span: { start: 0, end: source.length }, sourceText: source, sequenceIndex: 0
    };
    const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en", actions: [frame] })!;
    const raw: FhirDosage = { extension: [extension] };
    const before = JSON.stringify(raw), r6 = toDosageDetails([raw]);
    expect(realizeInstructionAction(frame, "en")).toBe(source);
    for (const input of [raw, r6, JSON.parse(JSON.stringify(toFhirR5Dosages(r6)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toContain(source);
        expect(th).toContain(value + " มิลลิลิตร");
        if (relation) expect(th).toContain("ไปยัง");
        else expect(th).not.toContain("ไปยัง");
        if (negated) expect(th).toContain("ห้าม");
      }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(r6)[0].extension?.find(e => e.url === extension.url)).toEqual(extension);
  });

  it.each([
    [undefined, undefined], [undefined, "right forearm"],
    [2, undefined], [2, "right forearm"]
  ] as const)("renders current patch quantity and site once while retaining the saved frame: %s / %s", (dose, site) => {
    const source = "Apply a new patch before breakfast";
    const frame = parseInstructionActions("Apply patch before breakfast")[0];
    frame.predicate.display = "Apply"; frame.sourceText = source;
    frame.span = { start: 0, end: source.length };
    frame.args = [
      { role: AdviceArgumentRole.Object, text: "a new patch", normalized: "a new patch", i18n: { th: "แผ่นแปะใหม่" } },
      ...(dose === undefined ? [] : [{ role: AdviceArgumentRole.Amount, text: "1 patch", quantity: { value: 1, unit: "patch" } }]),
      ...(site === undefined ? [] : [{ role: AdviceArgumentRole.Site, text: "left forearm", normalized: "left forearm" }]),
      { role: AdviceArgumentRole.Time, text: "breakfast", normalized: EventTiming.Breakfast,
        relation: AdviceRelation.Before, i18n: { th: "อาหารเช้า" } }
    ];
    const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
      primaryAdministrationSpan: { start: 0, end: 5 }, actions: [frame] })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
      route: { coding: [{ system: "http://snomed.info/sct", code: "45890007", display: "Transdermal route" }] },
      timing: { repeat: { when: [EventTiming["Before Breakfast"]] } },
      ...(dose === undefined ? {} : { doseAndRate: [{ doseQuantity: { value: dose, unit: "patch" } }] }),
      ...(site === undefined ? {} : { site: { concept: { text: site } } }),
      extension: [extension]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, JSON.parse(JSON.stringify(toFhirR5Dosages(raw)))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const en = formatSig(input, "long", { locale: "en", realizationMode });
        const th = formatSig(input, "long", { locale: "th", realizationMode });
        expect(en).toContain("a new patch"); expect(th).toContain("แผ่นแปะใหม่");
        expect(en.match(/before breakfast/gu)).toHaveLength(1);
        expect(th.match(/ก่อนอาหารเช้า/gu)).toHaveLength(1);
        if (dose !== undefined) {
          expect(en.match(/(?:^|[^0-9.])2 patch(?:es)?(?=[^a-z]|$)/gu)).toHaveLength(1);
          expect(th.match(/(?:^|[^0-9.])2 patch(?=[^a-z]|$)/gu)).toHaveLength(1);
          expect(en).not.toMatch(/(?:^|[^0-9.])1 patch/u);
          expect(th).not.toMatch(/(?:^|[^0-9.])1 patch/u);
        } else {
          expect(en).not.toMatch(/(?:^|[^0-9.])[12] patch/u);
          expect(th).not.toMatch(/(?:^|[^0-9.])[12] patch/u);
        }
        if (site) {
          expect(en.match(/right forearm/gu)).toHaveLength(1);
          expect(th.match(/ปลายแขนขวา/gu)).toHaveLength(1);
          expect(en).not.toContain("left forearm");
          expect(th).not.toContain("ปลายแขนซ้าย");
        }
      }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].extension?.find(e => e.url === extension.url)).toEqual(extension);
  });
});


describe("round55: current clinical facts and independent graph meaning", () => {
  const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const views = (row: FhirDosage) => {
    const r6 = toDosageDetails(persisted([row]));
    return [row, r6, persisted(toFhirR5Dosages(r6))];
  };

  it.each(["clock", "code-only", "bedtime"] as const)(
    "uses live timing without reintroducing a QHS anchor: %s", variant => {
      const row: FhirDosage = {
        doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        timing: { code: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QHS" }] },
          ...(variant === "code-only" ? {} : { repeat: { frequency: 1, period: 1, periodUnit: "d" as const,
            ...(variant === "clock" ? { timeOfDay: ["08:00:00"] } : { when: [EventTiming["Before Sleep"]] }) } }) }
      };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        const preview = formatSig(input, "short", { locale: "en", realizationMode: "normalized" });
        if (variant === "clock") {
          expect(preview).toContain("08:00");
          expect(preview).not.toMatch(/QHS|bedtime/iu);
        } else expect(preview).toMatch(/QHS|bedtime/iu);
      }
      expect(row.timing?.code?.coding).toEqual([{ system: "http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation", code: "QHS" }]);
      expect(JSON.stringify(row)).toBe(before);
    });

  it.each([false, true])("keeps a dilution condition separate from material complements: %s", withDestination => {
    const source = withDestination
      ? "Dilute 1 mL with saline to 10 mL if the solution is too thick"
      : "Dilute 1 mL if the solution is too thick";
    const parsed = parsePublicSig(source);
    const frame = parseInstructionActions(source)[0];
    expect(frame.args.filter(arg => arg.role === AdviceArgumentRole.Destination).map(arg => arg.text))
      .toEqual(withDestination ? ["saline", "10 mL"] : []);
    expect(frame.args.find(arg => arg.role === AdviceArgumentRole.Amount)?.quantity).toMatchObject({ value: 1, unit: "mL" });
    for (const input of [parsed.fhirNext, persisted(toFhirR5Dosages(parsed.fhirNext))]) {
      const before = JSON.stringify(input);
      for (const locale of ["en", "th"]) for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/if the solution is too thick/gu)).toHaveLength(1);
        if (locale === "en") expect(text).toBe(source + ".");
      }
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it.each([false, true].flatMap(negated => [false, true].map(temporal => ({ negated, temporal }))))(
    "retains a Mix vehicle and independent event: $negated / $temporal", ({ negated, temporal }) => {
      const frame = persisted(parseInstructionActions(negated ? "Do not mix with milk" : "Mix with milk")[0]);
      frame.polarity = negated ? AdvicePolarity.Negate : AdvicePolarity.Affirm;
      delete frame.relation;
      frame.args = [{ role: AdviceArgumentRole.Substance, text: "milk", normalized: "milk",
        relation: AdviceRelation.With, i18n: { th: "นม" } },
        ...(temporal ? [{ role: AdviceArgumentRole.Activity, text: "each dose", normalized: "each dose",
          relation: AdviceRelation.Before, i18n: { th: "ยาแต่ละครั้ง" } }] : [])];
      const graph = { sourceText: (negated ? "Do not mix" : "Mix") + " with milk" + (temporal ? " before each dose" : ""),
        sourceLocale: "en", actions: [frame] };
      const extension = buildInstructionGraphExtension(graph)!;
      const row: FhirDosage = { extension: [extension] };
      const before = JSON.stringify(row);
      for (const input of views(row)) {
        const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
        expect(text).toMatch(negated ? /^Do not mix with milk/u : /^Mix with milk/u);
        expect(text.match(/with milk/gu)).toHaveLength(1);
        expect(text.match(/before each dose/gu) ?? []).toHaveLength(temporal ? 1 : 0);
        const th = formatSig(input, "long", { locale: "th", realizationMode: "normalized" });
        expect(th).toContain("ด้วยนม");
        if (negated) expect(th).toContain("ห้าม");
        expect(th.match(/ก่อนยาแต่ละครั้ง/gu) ?? []).toHaveLength(temporal ? 1 : 0);
      }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.actions[0].args).toMatchObject(frame.args);
      expect(parseInstructionGraphExtension(row.extension)?.actions[0].args).toHaveLength(frame.args.length);
    });

  it.each([false, true].flatMap(guard => [false, true].map(preposed => ({ guard, preposed }))))(
    "keeps an independent primary condition beside a current guard: $guard / $preposed", ({ guard, preposed }) => {
      const actionText = "Swallow 1 tablet", conditionText = "if able to swallow";
      const frame = persisted(parseInstructionActions(actionText)[0]);
      const start = preposed ? conditionText.length + 2 : 0;
      frame.span = { start, end: start + actionText.length };
      const source = preposed ? conditionText + ", " + actionText : actionText + " " + conditionText;
      const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame],
        relations: [{ kind: AdviceRelation.If, toActionIndex: 0, text: conditionText,
          span: preposed ? { start: 0, end: conditionText.length } : { start: actionText.length + 1, end: source.length } }] })!;
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        method: { coding: [{ system: "http://snomed.info/sct", code: "421521009", display: "Swallow" }] }, extension: [extension] };
      if (guard) setDosageCondition(row, { kind: "measurement", name: "systolic BP", operation: "gt", value: 160,
        text: "systolic BP > 160" });
      const before = JSON.stringify(row);
      for (const input of views(row)) for (const locale of ["en", "th"])
        for (const realizationMode of ["normalized", "roundtrip"] as const) {
          const text = formatSig(input, "long", { locale, realizationMode });
          expect(text.match(/if able to swallow/giu)).toHaveLength(1);
          expect(text.match(/systolic BP > 160/gu) ?? []).toHaveLength(guard ? 1 : 0);
        }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.relations?.[0].text).toBe(conditionText);
    });

  it.each(["all", "any", "not", "opposite unless", "negative state"] as const)(
    "distinguishes a retained condition owner from an independent constraint: %s", variant => {
      const atom: MedicationCondition = { kind: "measurement", name: "systolic BP", operation: "gt",
        value: 140, text: "systolic BP > 160" };
      const awake: MedicationCondition = { kind: "state", name: "awake", expected: true, text: "awake" };
      const negative = variant === "not" || variant === "opposite unless" || variant === "negative state";
      const relationText = variant === "negative state" ? "unless nausea"
        : (negative ? "unless " : "if ") + "systolic BP > 160";
      const frame = persisted(parseInstructionActions("Swallow 1 tablet")[0]);
      const source = frame.sourceText + " " + relationText;
      const extension = buildInstructionGraphExtension({ sourceText: source, sourceLocale: "en",
        primaryAdministrationSpan: frame.span, actions: [frame], relations: [{
          kind: negative ? AdviceRelation.Unless : AdviceRelation.If, toActionIndex: 0, text: relationText,
          span: { start: frame.sourceText.length + 1, end: source.length }
        }] })!;
      const row: FhirDosage = { doseAndRate: [{ doseQuantity: { value: 1, unit: "tab" } }],
        method: { coding: [{ system: "http://snomed.info/sct", code: "421521009", display: "Swallow" }] },
        extension: [extension] };
      const condition: MedicationCondition = variant === "all" || variant === "any"
        ? { kind: variant, conditions: [atom, awake] } : variant === "not"
        ? { kind: "not", condition: atom } : variant === "negative state"
        ? { kind: "state", name: "nausea", text: "nausea", expected: false } : atom;
      setDosageCondition(row, condition);
      const before = JSON.stringify(row);
      for (const input of views(row)) for (const locale of ["en", "th"]) {
        const text = formatSig(input, "long", { locale, realizationMode: "normalized" });
        if (variant === "negative state") {
          expect(text.match(/nausea/giu)).toHaveLength(1);
          expect(text).toContain(locale === "en" ? "only if not nausea" : "เฉพาะเมื่อ ไม่ nausea");
          expect(text).not.toMatch(locale === "en" ? /only if\s+nausea/iu : /เฉพาะเมื่อ\s*nausea/u);
        } else {
          expect(text.match(/140/gu)).toHaveLength(1);
          expect(text.match(/160/gu) ?? []).toHaveLength(variant === "opposite unless" ? 1 : 0);
          if (variant === "not") {
            expect(text).toContain(locale === "en" ? "unless" : "เว้นแต่");
            expect(text).not.toContain(locale === "en" ? "only if" : "เฉพาะเมื่อ");
          } else if (variant === "all" || variant === "any") {
            const conjunction = locale === "en" ? (variant === "all" ? "and" : "or")
              : (variant === "all" ? "และ" : "หรือ");
            expect(text).toMatch(new RegExp("systolic BP > 140\\s+" + conjunction + "\\s+awake", "u"));
          }
        }
      }
      expect(JSON.stringify(row)).toBe(before);
      expect(parseInstructionGraphExtension(row.extension)?.relations?.[0].text).toBe(relationText);
    });

  it.each(["existential", "state"] as const)("uses current restriction text over a retained inferred lemma: %s", form => {
    const row = persisted(parsePublicSig("Apply 1 g to skin where there is rash daily").fhir[0]);
    const marker = row.site!.extension!.find(item => item.url.endsWith("medication-body-site-restriction"))!;
    marker.extension!.find(item => item.url === "predicateText")!.valueString = "skin is itchy";
    marker.extension!.find(item => item.url === "predicateForm")!.valueCode = form;
    marker.extension!.push({ url: "urn:round55:restriction-note", valueString: "retain source annotation" });
    const original = persisted(marker), before = JSON.stringify(row);
    for (const input of views(row)) for (const locale of ["en", "th"])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const text = formatSig(input, "long", { locale, realizationMode });
        expect(text.match(/skin is itchy/gu)).toHaveLength(1);
        expect(text).not.toMatch(/rash|ผื่น/u);
      }
    expect(JSON.stringify(row)).toBe(before);
    expect(toFhirR5Dosages(toDosageDetails(persisted([row])))[0].site?.extension).toContainEqual(original);
  });

  it.each(["system", "version", "both"] as const)("preserves graph Coding primitive companions: %s", variant => {
    const coding = { system: "urn:round55:vehicle", version: "edition-1", code: "milk",
      ...(variant !== "version" ? { _system: { id: "system-source", extension: [{ url: "urn:round55:note", valueString: "system" }] } } : {}),
      ...(variant !== "system" ? { _version: { id: "edition-source" } } : {}),
      _code: { id: "code-source" } };
    const frame = persisted(parseInstructionActions("Mix with milk")[0]);
    frame.args = [{ role: AdviceArgumentRole.Substance, text: "milk", relation: AdviceRelation.With,
      coding, codings: [coding], i18n: { th: "นม" } }];
    const graph = { sourceText: "Mix with milk", sourceLocale: "en", actions: [frame] };
    const extension = buildInstructionGraphExtension(graph)!;
    const row: FhirDosage = { extension: [extension] };
    const before = JSON.stringify(graph);
    const decoded = parseInstructionGraphExtension(row.extension)!;
    expect(decoded.actions[0].args[0].coding).toEqual(coding);
    expect(decoded.actions[0].args[0].codings).toEqual([coding]);
    for (const input of views(row)) {
      const r5 = Array.isArray(input) ? input : "step" in input ? toFhirR5Dosages(input) : [input];
      const restored = parseInstructionGraphExtension(r5[0].extension)!;
      expect(restored.actions[0].args[0].coding).toEqual(coding);
      expect(restored.actions[0].args[0].codings).toEqual([coding]);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it.each([undefined, AdviceRelation.To])("renders an unmarked object-time daughter once: %s", relation => {
    const frame = persisted(parseInstructionActions("Apply patch in the morning")[0]);
    frame.relation = relation;
    frame.args = [
      { role: AdviceArgumentRole.Object, text: "patch", normalized: "patch", i18n: { th: "แผ่นแปะ" } },
      { role: AdviceArgumentRole.Time, text: "morning", normalized: "MORN", i18n: { th: "ตอนเช้า" } }
    ];
    const extension = buildInstructionGraphExtension({ sourceText: "Apply patch in the morning", sourceLocale: "en",
      primaryAdministrationSpan: frame.span, actions: [frame] })!;
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      method: { coding: [{ system: "http://snomed.info/sct", code: "738991002", display: "Apply" }] },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "patch" } }],
      timing: { repeat: { when: [EventTiming.Morning] } }, extension: [extension]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))])
      for (const realizationMode of ["normalized", "roundtrip"] as const) {
        const english = formatSig(input, "long", { locale: "en", realizationMode });
        const thai = formatSig(input, "long", { locale: "th", realizationMode });
        expect(english.match(/morning/gu)).toHaveLength(1);
        expect(thai.match(/(?:ตอน)?เช้า/gu)).toHaveLength(1);
        // The primary object and its explicit numeric-dose annotation are distinct spans.
        expect(english.match(/\(1 patch\)/gu)).toHaveLength(1);
        expect(english.replace("(1 patch)", "").match(/\bpatch\b/gu)).toHaveLength(1);
        expect(thai.match(/\b1 patch\b/gu)).toHaveLength(1);
        expect(thai.replace("1 patch", "").match(/แผ่นแปะ/gu)).toHaveLength(1);
      }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([
    { name: "right coding", code: "1290032005", text: "both eyes", count: undefined, expected: 1 },
    { name: "matching bilateral", code: undefined, text: "both eyes", count: undefined, expected: 2 },
    { name: "independent count", code: "1290032005", text: "both eyes", count: 2, expected: 2 },
    { name: "unknown code", code: "clinic-eyes", text: "both eyes", count: undefined, expected: 2 }
  ])("uses the resolved site for inferred discrete supply: $name", ({ code, text, count, expected }) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text, ...(code ? { coding: [{ system: code === "clinic-eyes" ? "urn:clinic:site" : "http://snomed.info/sct", code }] } : {}),
        ...(count ? { extension: [{ url: BODY_SITE_ADMINISTRATION_TARGET_COUNT_EXTENSION_URL, valueInteger: count }] } : {}) } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: "d" } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z",
        durationValue: 1, durationUnit: "d", timeZone: "UTC" }).totalUnits).toBe(expected);
      const text = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      if (code === "1290032005") {
        expect(text).toContain("right eye");
        expect(text).not.toContain("both eyes");
      }
      if (expected === 1) expect(text).not.toContain("across 2 sites");
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.text).toBe(text);
  });

  it.each([
    { text: "upper outer right arm", code: "302538001" },
    { text: "right arm where irritated", code: "368209003" }
  ])("preserves a qualified site with a coarser coding: $text", ({ text, code }) => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text, coding: [{ system: "http://snomed.info/sct", code }] } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "patch" } }]
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))])
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" })).toContain(text);
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.text).toBe(text);
  });

  it("prefers the same known clinical site with an independent coding first", () => {
    const codings = [{ system: "urn:round55:clinic-site", code: "local-eye" },
      { system: "http://snomed.info/sct", code: "1290032005" }];
    const raw: FhirR6DosageInstruction = { step: [{ component: [{
      site: { concept: { text: "both eyes", coding: codings } },
      doseAndRate: [{ doseQuantity: { value: 1, unit: "drop" } }],
      timing: { repeat: { count: 1, frequency: 1, period: 1, periodUnit: "d" } }
    }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      const preview = formatSig(input, "long", { locale: "en", realizationMode: "normalized" });
      expect(preview).toContain("right eye");
      expect(preview).not.toContain("both eyes");
      expect(calculateTotalUnits({ dosage: input, orderedAt: "2026-01-01T08:00:00Z", from: "2026-01-01T08:00:00Z",
        durationValue: 1, durationUnit: "d", timeZone: "UTC" }).totalUnits).toBe(1);
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].site?.coding).toEqual(codings);
  });

  it.each(["en", "th"] as const)("renders a maximum-only administration in the long %s preview", locale => {
    const raw: FhirR6DosageInstruction = { step: [{ component: [{ timing: { repeat: { countMax: 3 } } }] }] };
    const before = JSON.stringify(raw);
    for (const input of [raw, persisted(toFhirR5Dosages(raw))]) {
      expect(formatSig(input, "long", { locale, realizationMode: "normalized" }))
        .toBe(locale === "en" ? "Use the medication for up to 3 doses." : "ใช้ยา ไม่เกิน 3 ครั้ง.");
    }
    expect(JSON.stringify(raw)).toBe(before);
    expect(toFhirR5Dosages(raw)[0].timing?.repeat?.count).toBeUndefined();
  });
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
          expect(text.match(/systolic BP > 160/gu)).toHaveLength(1);
          const condition = locale === "en" ? "only if systolic BP > 160" : "เฉพาะเมื่อ systolic BP > 160";
          if (!structured) expect(text).toContain("Swallow 1 tablet whole " + condition + ".");
          else expect(text).toMatch(locale === "en"
            ? /(?:^|\.\s*)Use 2 tablets only if systolic BP > 160\.(?=\s|$)/u
            : /(?:^|\.\s*)ใช้(?:ครั้งละ)? 2 เม็ด เฉพาะเมื่อ systolic BP > 160\.(?=\s|$)/u);
          if (hold) {
            expect(text).toContain("Otherwise hold.");
            expect(text).not.toContain("Otherwise hold " + condition);
          } else expect(text).not.toContain("Otherwise hold");
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
      expect(formatSig(input, "long", { locale: "en", realizationMode: "normalized" }))
        .toBe("Use 2 sprays via nasal route. Prime with 2 sprays.");
      expect(formatSig(input, "long", { locale: "th", realizationMode: "normalized" }))
        .toBe("พ่นครั้งละ 2 พ่น ทางจมูก. เตรียมอุปกรณ์พ่น 2 พ่น.");
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
    expect(graphChild([rebuilt]).extension!.find(child => child.url === unknown.url)).toBe(unknown);
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
    expect(waterArgument(rebuilt).extension!.find(entry => entry.url === opaque.url)).toBe(opaque);
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
      }
      expect(JSON.stringify(graph)).toBe(before);
    });
});
