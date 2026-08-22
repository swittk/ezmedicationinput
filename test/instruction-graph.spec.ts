import { describe, expect, it } from "vitest";
import {
  buildMedicationInstructionActionCodeSystem,
  buildMedicationInstructionConceptCodeSystem,
  fromFhirDosage,
  getMedicationInstructionAction,
  getMedicationInstructionConcept,
  listMedicationInstructionActions,
  listMedicationInstructionConcepts,
  parseInstructionActions,
  parseSig,
  parseSigAsync,
  realizeInstructionGraph
} from "../src/index";

describe("procedural instruction graph", () => {
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

  it("models workflow duration and time arguments without contaminating medication timing", () => {
    const leave = parseSig("leave on for 10 minutes then rinse");
    const leaveGraph = leave.meta.canonical.clauses[0]?.instructionGraph;
    expect(leaveGraph?.actions.map((action) => action.predicate.lemma)).toEqual(["leave", "rinse"]);
    expect(leaveGraph?.actions[0]?.args[0]).toMatchObject({
      role: "duration",
      quantity: { value: 10, unit: "min" }
    });
    expect(realizeInstructionGraph(leaveGraph!, "en")).toBe("Leave on for 10 minutes; then Rinse");

    const rinse = parseSig("rinse in the morning");
    const rinseAction = rinse.meta.canonical.clauses[0]?.instructionGraph?.actions[0];
    expect(rinseAction).toMatchObject({
      predicate: { lemma: "rinse" },
      relation: "in"
    });
    expect(rinseAction?.args[0]).toMatchObject({ role: "time", normalized: "the morning" });
  });

  it("exposes the package-owned action CodeSystem vocabulary and exact external mappings", () => {
    const actions = listMedicationInstructionActions();
    expect(actions.length).toBeGreaterThan(10);
    expect(getMedicationInstructionAction("pour")).toMatchObject({
      code: "pour",
      semanticClass: "transfer",
      display: "Pour"
    });
    expect(getMedicationInstructionAction("pour")?.externalCodings).toBeUndefined();
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
      "Wipe the lesion; then Wait 5 minutes; then Rinse"
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
        system: "https://solublelabs.com/fhir/CodeSystem/medication-instruction-concept",
        code: "water"
      })
    );
    expect(realizeInstructionGraph(graph!, "th")).toBe(
      "เช็ดรอยโรค จากนั้นรอ 5 นาที จากนั้นล้างด้วยน้ำ"
    );
    expect(realizeInstructionGraph(graph!, "en")).toBe(
      "Wipe the lesion; then Wait 5 minutes; then Rinse with water"
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
    expect(codeSystem.concept).toContainEqual(
      expect.objectContaining({ code: "water", display: "water" })
    );
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
      understoodCharacters: 8,
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
    expect(parsed.fhir.asNeededBoolean).toBe(true);
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
        expect(request.range).toEqual({ start: 28, end: 40 });
        expect(request.existingGraph.opaqueSpans?.[0]?.text).toBe("croon a song");
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

});
