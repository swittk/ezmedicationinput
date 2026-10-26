import { describe, expect, it } from "vitest";
import { formatSig, listMedicationInstructionActions, getMedicationInstructionAction, getMedicationInstructionConcept, parseInstructionActions, buildMedicationInstructionConceptCodeSystem, buildMedicationInstructionActionCodeSystem } from "../src/index";
import { parseSig } from "./helpers/r5-parser";
import { findAdditionalInstructionDefinitionByCoding } from "../src/advice";
import { RouteCode } from "../src/types";
import { buildInstructionGraphExtension, parseInstructionGraphExtension } from "../src/instruction-graph-fhir";
import { getDoseQuantityUnit, getStandardDoseUnitCoding } from "../src/maps";
import { medicationInstructionConceptCodings } from "../src/instruction-concept-terminology";

const SNOMED = "http://snomed.info/sct";

// FHIR R5 SNOMEDCTAdministrationMethodCodes exemplar expansion, excluding
// the abstract/root concept 736665006 itself. The library may support more
// methods, but it should never regress below this published baseline.
const FHIR_R5_ADMINISTRATION_METHOD_CODES = [
  "738990001", "738991002", "738992009", "738993004", "738994005",
  "738995006", "738996007", "740666001", "740685003", "764498003",
  "764794000", "782155003", "782168006", "785900008", "823034001",
  "827107003", "1010690008", "1231460007", "58841000052102"
] as const;

const FHIR_R5_ADDITIONAL_INSTRUCTION_CODES = [
  "311501008", "311504000", "417929005", "417980006", "417995008",
  "418071006", "418194009", "418281004", "418443006", "418521000",
  "418577003", "418637003", "418639000", "418693002", "418849000",
  "418850000", "418914006", "418954008", "418991002", "419111009",
  "419115000", "419303009", "419437002", "419439004", "419444006",
  "419473009", "419529008", "419822006", "419974005", "420003005",
  "420082003", "420110001", "420162004", "420652005", "421484000",
  "421769005", "421984009", "422327006", "428579001", "717154004"
] as const;

describe("vendored administration-method terminology coverage", () => {
  it("covers every selectable method in the FHIR R5 exemplar expansion", () => {
    const covered = new Set(
      listMedicationInstructionActions()
        .map((definition) => definition.administrationMethod)
        .filter((coding) => coding?.system === SNOMED && coding.code)
        .map((coding) => coding!.code!)
    );
    for (const code of FHIR_R5_ADMINISTRATION_METHOD_CODES) {
      expect(covered, `missing FHIR R5 administration method ${code}`).toContain(code);
    }
  });

  it.each([
    ["administer 5 mL orally daily", "738990001"],
    ["suck 1 lozenge every 4 hours", "764498003"],
    ["orodisperse 1 tablet daily", "823034001"],
    ["implant 1 implant subcutaneously", "827107003"],
    ["insufflate 1 dose intranasally daily", "1010690008"],
    ["dialysis daily", "1231460007"],
    ["bathe affected area daily", "58841000052102"]
  ])("parses %s as exact coded method %s", (source, code) => {
    const parsed = parseSig(source);
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({ system: SNOMED, code });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });

  it("realizes newly covered Thai method terminology instead of a generic route verb", () => {
    expect(parseSig("อม 1 เม็ด วันละ 3 ครั้ง", { locale: "th" }).longText)
      .toBe("อมครั้งละ 1 เม็ด วันละ 3 ครั้ง.");
    expect(parseSig("ปล่อยให้ละลายในปาก 1 เม็ด วันละครั้ง", { locale: "th" }).longText)
      .toBe("ปล่อยให้ละลายในปากครั้งละ 1 เม็ด วันละครั้ง.");
    expect(parseSig("ฝัง 1 implant ใต้ผิวหนัง", { locale: "th" }).longText)
      .toBe("ฝังครั้งละ 1 ชิ้น เข้าใต้ผิวหนัง.");
  });

  it("lets a caller add a true administration method declaratively", () => {
    const parsed = parseSig("atomize 2 sprays daily", {
      instructionActionMap: {
        atomize: {
          code: "atomize",
          semanticClass: "administration",
          display: "Atomize",
          procedural: false,
          acceptsAmount: true,
          definesDose: true,
          administrationMethod: {
            system: "https://example.test/CodeSystem/method",
            code: "atomize",
            display: "Atomize"
          },
          verbRouteHint: RouteCode["Nasal route"]
        }
      }
    });
    expect(parsed.fhir.method?.coding?.[0]).toMatchObject({
      system: "https://example.test/CodeSystem/method",
      code: "atomize"
    });
    expect(parsed.fhir.route?.coding?.[0]?.code).toBe(RouteCode["Nasal route"]);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toMatchObject({ value: 2, unit: "spray" });
    expect(parsed.meta.leftoverText).toBeUndefined();
  });
});


describe("vendored FHIR additional-instruction terminology coverage", () => {
  it("covers every selectable concept in the FHIR R5 exemplar expansion", () => {
    for (const code of FHIR_R5_ADDITIONAL_INSTRUCTION_CODES) {
      expect(
        findAdditionalInstructionDefinitionByCoding(SNOMED, code),
        `missing FHIR R5 additional instruction ${code}`
      ).toBeDefined();
    }
  });

  it.each([
    ["419444006", "ห้ามหยุดยา เว้นแต่แพทย์แนะนำ"],
    ["419974005", "ยานี้อาจทำให้ปัสสาวะเปลี่ยนสี"],
    ["421769005", "ใช้ตามคำแนะนำ"],
    ["420652005", "ใช้จนหมด"]
  ])("localizes coded FHIR additional instruction %s into Thai", (code, thai) => {
    const text = formatSig({
      additionalInstruction: [{ coding: [{ system: SNOMED, code }] }]
    }, "long", { locale: "th" });
    expect(text).toContain(thai);
  });
});

describe("non-equivalent standardized constituents of local instruction actions", () => {
  it.each([
    ["remain upright 5 minutes", "remain-upright", "target-state", "C86043"],
    ["lie down 5 minutes", "lie-down", "target-state", "102538003"],
    ["spit out", "spit", "activity", "12405001"],
    ["replace the cap", "recap", "target-object", "228254002"],
    ["swab", "swab", "technique", "C17627"],
    ["reapply", "reapply", "operation", "C47886"],
    ["blow nose", "blow-nose", "target-site", "C12756"],
    ["keep ear upward 5 minutes", "keep-ear-upward", "target-site", "C12394"],
    ["keep ear upward 5 minutes", "keep-ear-upward", "orientation", "353734004"],
    ["keep ear dry", "keep-ear-dry", "target-site", "C12394"],
    ["keep ear dry", "keep-ear-dry", "target-state", "13880007"],
    ["rub in", "rub", "mechanism", "263762005"],
    ["press", "press", "operation", "257893003"],
    ["squeeze", "squeeze", "operation", "263720003"],
    ["warm", "warm", "mechanism", "88999006"],
    ["pull", "pull", "operation", "129411004"],
    ["tilt", "tilt", "operation", "257912008"],
    ["moisten", "moisten", "target-state", "17461003"],
    ["part hair", "part", "target-site", "386045008"],
    ["wash hair out", "wash-hair-out", "technique", "C65120"],
    ["wash hair out", "wash-hair-out", "target-site", "386045008"],
    ["close eyes", "close", "target-state", "29179001"]
  ])("preserves local %s while carrying externally coded %s role", (source, actionCode, role, code) => {
    const definition = getMedicationInstructionAction(actionCode)!;
    expect(definition.semanticComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role, coding: expect.objectContaining({ code }) })
    ]));
    const frames = parseInstructionActions(source);
    const frame = frames.find(item => item.predicate.lemma === actionCode)!;
    expect(frame, source).toBeDefined();
    expect(frame.predicate.codings).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: "urn:ezmedicationinput:CodeSystem:medication-instruction-action",
        code: actionCode })
    ]));
    expect(frame.predicate.codings?.some(coding => coding.code === code)).toBe(false);
    const signature = (parts: typeof definition.semanticComponents) =>
      parts?.map(part => [part.role, part.coding.system, part.coding.code]);
    expect(signature(frame.predicate.semanticComponents)).toEqual(signature(definition.semanticComponents));
    const extension = buildInstructionGraphExtension({ sourceText: source, actions: [frame] })!;
    const restored = parseInstructionGraphExtension([extension])!.actions[0];
    expect(restored.predicate.codings?.map(coding => [coding.system, coding.code]))
      .toEqual(frame.predicate.codings?.map(coding => [coding.system, coding.code]));
    expect(signature(restored.predicate.semanticComponents)).toEqual(signature(definition.semanticComponents));
    expect(restored.predicate.lemma).toBe(actionCode);
  });

  it("adds an exact Opening-action qualifier without discarding the original local Open code", () => {
    const definition = getMedicationInstructionAction("open")!;
    const frames = parseInstructionActions("open the bottle");
    const frame = frames.find(item => item.predicate.lemma === "open")!;
    expect(frame).toBeDefined();
    expect(frame.predicate.codings?.map(coding => [coding.system, coding.code])).toEqual([
      ["urn:ezmedicationinput:CodeSystem:medication-instruction-action", "open"],
      ["http://snomed.info/sct", "312336005"]
    ]);
    const copy = parseInstructionGraphExtension([buildInstructionGraphExtension({
      actions: [frame], sourceText: "open the bottle"
    })!])!;
    expect(copy.actions[0].predicate.codings?.map(coding => [coding.system, coding.code]))
      .toEqual(frame.predicate.codings?.map(coding => [coding.system, coding.code]));
  });

  it.each([
    ["pause-use", "operation", "421139008"],
    ["miss", "situation", "1269470004"]
  ])("keeps registered conditional %s separate from entire predicate equivalence", (action, role, code) => {
    const definition = getMedicationInstructionAction(action)!;
    expect(definition.semanticComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role, coding: expect.objectContaining({ code, system: SNOMED }) })
    ]));
    const again = getMedicationInstructionAction(action)!;
    again.semanticComponents![0].coding.code = "changed";
    expect(getMedicationInstructionAction(action)?.semanticComponents?.[0]?.coding.code).toBe(code);
  });

  it("uses typed arguments for alternating injection sites versus physically rotating a bottle", () => {
    const scenarios = [
      ["rotate injection sites", "administration-site", "49572008"],
      ["rotate bottle", "bottle", "257912008"]
    ] as const;
    for (const [source, argumentConcept, standardCode] of scenarios) {
      const frame = parseInstructionActions(source).find(item => item.predicate.lemma === "rotate")!;
      expect(frame).toBeDefined();
      expect(frame.args.some(argument => argument.conceptId === argumentConcept)).toBe(true);
      expect(frame.predicate.codings?.map(coding => coding.code)).toEqual(["rotate"]);
      expect(frame.predicate.semanticComponents?.map(part => part.coding.code)).toEqual([standardCode]);
      const restored = parseInstructionGraphExtension([buildInstructionGraphExtension({
        sourceText: source, actions: [frame]
      })!])!;
      expect(restored.actions[0].predicate.semanticComponents?.map(part => part.coding.code))
        .toEqual([standardCode]);
    }
    const bare = getMedicationInstructionAction("rotate")!;
    expect(bare.semanticComponents).toBeUndefined();
    expect(bare.contextualSemanticComponents).toHaveLength(2);
    bare.contextualSemanticComponents![0].component.coding.code = "bad";
    expect(getMedicationInstructionAction("rotate")!.contextualSemanticComponents![0].component.coding.code)
      .toBe("49572008");
  });

  it("adds breath-holding terminology only when hold actually governs breath", () => {
    const breath = parseInstructionActions("hold breath for 10 seconds")[0]!;
    expect(breath.predicate.lemma).toBe("hold");
    expect(breath.predicate.codings?.map(coding => coding.code))
      .toEqual(["hold", "D062485", "C192566", "oewn-00004492-v"]);
    const other = parseInstructionActions("hold eye closed")[0]!;
    expect(other.predicate.codings?.map(coding => coding.code)).toEqual(["hold"]);
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: "hold breath for 10 seconds", actions: [breath]
    })!])!;
    expect(restored.actions[0].predicate.codings?.map(coding => coding.code))
      .toEqual(["hold", "D062485", "C192566", "oewn-00004492-v"]);
  });

  it("keeps repeat + apply as distinct parts of reapply, and avoids modifying registered definitions", () => {
    const definition = getMedicationInstructionAction("reapply")!;
    expect(definition.semanticComponents?.map(part => part.coding.code)).toEqual(["C47886", "738991002"]);
    definition.semanticComponents![0].coding.code = "bad";
    expect(getMedicationInstructionAction("reapply")?.semanticComponents?.[0].coding.code).toBe("C47886");
    expect(getMedicationInstructionAction("tilt")?.semanticComponents?.[0].coding.code).toBe("257912008");
  });
});

describe("gender-neutral external intimate anatomy code", () => {
  it("retains the original local whole-site code and adds exact SNOMED external genitalia", () => {
    const concept = getMedicationInstructionConcept("external_intimate_area")!;
    const codes = medicationInstructionConceptCodings(concept);
    expect(codes.map(coding => [coding.system, coding.code])).toEqual([
      ["urn:ezmedicationinput:CodeSystem:medication-instruction-concept", "external_intimate_area"],
      ["http://snomed.info/sct", "77142006"]
    ]);
    for (const source of [
      "Apply to external intimate area once daily",
      "Apply to external-intimate-area once daily"
    ]) {
      const parsed = parseSig(source);
      expect(parsed.fhir.site?.coding).toEqual(expect.arrayContaining([
        expect.objectContaining({ system: SNOMED, code: "77142006" })
      ]));
      expect(parsed.fhir.route?.coding?.[0]?.code).toBe("6064005");
      expect(parsed.longText).toContain("external intimate area");
    }
  });
});

describe("partial coded clinical concept constituents", () => {
  it.each([
    ["nasal_spray", "qualifier", "738948007"],
    ["absorbed", "head", "C71731"],
    ["dissolved", "head", "C64929"]
  ])("preserves the whole local %s and separately codes only its established constituent", (name, role, code) => {
    const concept = getMedicationInstructionConcept(name)!;
    const codings = medicationInstructionConceptCodings(concept);
    expect(codings.map(item => [item.system, item.code])).toEqual([
      ["urn:ezmedicationinput:CodeSystem:medication-instruction-concept", name]
    ]);
    expect(concept.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role, coding: expect.objectContaining({ code }) })
    ]));
    expect(buildMedicationInstructionConceptCodeSystem().concept.some(item => item.code === name)).toBe(true);
    concept.components![0].coding!.code = "mutated";
    expect(getMedicationInstructionConcept(name)?.components?.[0]?.coding?.code).toBe(code);
  });
});

describe("generic exact external action mappings without optional arguments", () => {
  it.each([
    ["attach", ["C61470"]],
    ["detach", ["C212037"]],
    ["adjust", ["129426002", "C49157"]]
  ])("retains local %s alongside exact generic external codes", (actionCode, standards) => {
    const definition = getMedicationInstructionAction(actionCode)!;
    const expectedCodes = [actionCode, ...standards];
    const localSystem = "urn:ezmedicationinput:CodeSystem:medication-instruction-action";
    expect(definition.coding).toMatchObject({ system: localSystem, code: actionCode });
    expect(buildMedicationInstructionActionCodeSystem().concept
      .some(item => item.code === actionCode)).toBe(true);
    for (const source of [actionCode, `${actionCode} device`]) {
      const frame = parseInstructionActions(source)
        .find(frame => frame.predicate.lemma === actionCode)!;
      expect(frame, source).toBeDefined();
      expect(frame.predicate.codings?.map(coding => coding.code)).toEqual(expectedCodes);
      expect(frame.predicate.codings?.[0]?.system).toBe(localSystem);
      const restored = parseInstructionGraphExtension([buildInstructionGraphExtension({
        actions: [frame], sourceText: source
      })!])!.actions[0];
      expect(restored.predicate.codings?.map(coding => [coding.system, coding.code]))
        .toEqual(frame.predicate.codings?.map(coding => [coding.system, coding.code]));
    }
  });

  it("keeps explicit medication-dose adjustment as an additive contextual specialization", () => {
    const generic = parseInstructionActions("adjust")[0]!;
    const dose = parseInstructionActions("adjust dose if dizzy")[0]!;
    expect(generic.predicate.codings?.map(coding => coding.code))
      .toEqual(["adjust", "129426002", "C49157"]);
    expect(dose.predicate.codings?.map(coding => coding.code))
      .toEqual(["adjust", "129426002", "C49157", "C82495"]);
    expect(dose.args.some(argument => argument.conceptId === "medication-dose")).toBe(true);
  });
});

describe("nebule-compatible respule unit", () => {
  it("codes the single-dose respule as an NCIt nebule, while retaining its quantity label", () => {
    const expected = { system: "http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl", code: "C71204" };
    expect(getStandardDoseUnitCoding("respule")).toEqual(expected);
    expect(getStandardDoseUnitCoding("nebule")).toEqual(expected);
    expect(getDoseQuantityUnit({ ...expected, unit: "respule" })).toBe("respule");
    expect(getDoseQuantityUnit({ ...expected, unit: "nebule" })).toBe("nebule");
    expect(getStandardDoseUnitCoding("click")).toBeUndefined();
  });
});

describe("Open English WordNet 2025 exact action sense codings", () => {
  const WORDNET = "https://en-word.net/";
  const LOCAL = "urn:ezmedicationinput:CodeSystem:medication-instruction-action";
  const exact = [
    ["pour", "oewn-02073479-v"],
    ["lather", "oewn-00513124-v"],
    ["leave", "oewn-00136799-v"],
    ["wait", "oewn-02647547-v"],
    ["fold", "oewn-01280538-v"],
    ["pinch", "oewn-01459400-v"],
    ["aim", "oewn-01153576-v"],
    ["touch", "oewn-01208838-v"]
  ] as const;
  it.each(exact)("keeps local %s first, and exports its exact versioned WordNet sense", (action, code) => {
    const definition = getMedicationInstructionAction(action)!;
    const frame = parseInstructionActions(action).find(item => item.predicate.lemma === action)!;
    const codings = frame.predicate.codings!;
    expect(codings[0]).toMatchObject({ system: LOCAL, code: action });
    expect(codings).toContainEqual(expect.objectContaining({
      system: WORDNET, version: "2025", code
    }));
    expect(definition.externalCodings?.[0]).toMatchObject({
      system: WORDNET, version: "2025", code
    });
    expect(buildMedicationInstructionActionCodeSystem().concept.some(item => item.code === action)).toBe(true);
    const wire = buildInstructionGraphExtension({ sourceText: action, actions: [frame] })!;
    const value = wire.extension?.find(item => item.url === "action")?.extension
      ?.filter(item => item.url === "predicateCoding")
      .map(item => item.valueCoding)
      .find(item => item?.system === WORDNET);
    expect(value).toMatchObject({ system: WORDNET, version: "2025", code });
    const restored = parseInstructionGraphExtension([wire])!.actions[0];
    expect(restored.predicate.codings).toContainEqual(expect.objectContaining({
      system: WORDNET, version: "2025", code
    }));
  });

  it("round-trips WordNet's version in a real parsed FHIR dosage", () => {
    const parsed = parseSig("pour 5 mL into a cup");
    const restored = parseInstructionGraphExtension(parsed.fhir.extension)!;
    const codes = restored.actions.flatMap(action => action.predicate.codings ?? []);
    expect(codes).toContainEqual(expect.objectContaining({
      system: WORDNET, version: "2025", code: "oewn-02073479-v"
    }));
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(5);
  });

  it.each([
    ["wipe", "oewn-01252288-v", "mechanism"],
    ["draw_up", "oewn-01858118-v", "operation"],
    ["pump", "oewn-01228248-v", "operation"],
    ["blow", "oewn-00007012-v", "operation"],
    ["blow-nose", "oewn-00034941-v", "operation"],
    ["aim-away-from", "oewn-01153576-v", "operation"]
  ])("keeps the partial WordNet sense of %s outside equivalent whole-action codes", (action, code, role) => {
    const frame = parseInstructionActions(action).find(value => value.predicate.lemma === action)!;
    expect(frame).toBeDefined();
    expect(frame.predicate.codings?.some(coding => coding.system === WORDNET)).toBe(false);
    expect(frame.predicate.semanticComponents).toContainEqual({
      role, coding: expect.objectContaining({ system: WORDNET, version: "2025", code })
    });
    const restored = parseInstructionGraphExtension([buildInstructionGraphExtension({
      sourceText: action, actions: [frame]
    })!])!.actions[0];
    expect(restored.predicate.semanticComponents).toContainEqual({
      role, coding: expect.objectContaining({ system: WORDNET, version: "2025", code })
    });
  });

  it("uses different WordNet senses for breath-holding and gripping, not medication withholding", () => {
    const cases = [
      ["hold breath", "oewn-00004492-v"],
      ["hold bottle", "oewn-01219234-v"],
      ["hold inhaler", "oewn-01219234-v"],
      ["hold syringe", "oewn-01219234-v"]
    ] as const;
    for (const [source, code] of cases) {
      const frame = parseInstructionActions(source)[0]!;
      expect(frame.predicate.codings).toContainEqual(expect.objectContaining({
        system: WORDNET, version: "2025", code
      }));
    }
    expect(parseInstructionActions("hold dose")[0]?.predicate.codings?.some(
      coding => coding.system === WORDNET
    )).toBe(false);
    expect(getMedicationInstructionAction("prime")?.externalCodings).toBeUndefined();
    expect(getMedicationInstructionAction("keep")?.externalCodings).toBeUndefined();
  });
});

describe("Open English WordNet 2025 exact nonclinical result senses", () => {
  it.each([
    ["foam", "oewn-09462117-n"],
    ["clean-result", "oewn-00418932-a"]
  ])("preserves the original %s meaning alongside its versioned external sense", (name, code) => {
    const concept = getMedicationInstructionConcept(name)!;
    expect(medicationInstructionConceptCodings(concept).map(coding => [
      coding.system, coding.version, coding.code
    ])).toEqual([
      ["urn:ezmedicationinput:CodeSystem:medication-instruction-concept", undefined, name],
      ["https://en-word.net/", "2025", code]
    ]);
    expect(buildMedicationInstructionConceptCodeSystem().concept.some(item => item.code === name)).toBe(true);
  });
});
