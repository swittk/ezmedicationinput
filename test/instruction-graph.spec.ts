import { AdviceArgumentRole, AdviceForce, AdviceRelation, type MedicationCondition } from "../src/types";
import { describe, expect, it } from "vitest";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import adviceRulesSource from "../src/advice-rules.json";
import { realizeInstructionAction } from "../src/instruction-graph";
import { buildMedicationInstructionActionCodeSystem, buildMedicationInstructionConceptCodeSystem, formatSig, fromFhirDosage, getMedicationInstructionAction, getMedicationInstructionConcept, listMedicationInstructionActions, listMedicationInstructionConcepts, parseInstructionActions, realizeInstructionGraph, getDosageCondition, toDosageDetails, toFhirR5Dosages } from "../src/index";
import { medicationInstructionActionCodings } from "../src/instruction-action-terminology";
import { medicationInstructionConceptCodings } from "../src/instruction-concept-terminology";
import { parseSig, parseSigAsync } from "./helpers/r5-parser";
import { parseSig as parsePublicSig, nextDueDoses } from "../src/index";

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
    ["withhold-administration", "421139008"], ["soak", "42691000"],
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

  it("clones constituent codings and preserves an explicitly supplied expression as one coding", () => {
    const first = getMedicationInstructionConcept("new_patch")!;
    first.components![0].coding!.code = "changed";
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
