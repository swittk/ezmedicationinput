import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdviceModality,
  AdvicePolarity,
  AdviceRelation,
  CanonicalInstructionCoverage,
  CanonicalInstructionGraph,
  CanonicalInstructionRelation,
  CanonicalSourceSpan,
  FhirCoding,
  FhirExtension
} from "./types";

export const MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL =
  "https://solublelabs.com/fhir/StructureDefinition/medication-instruction-graph";

function child(extension: FhirExtension, url: string): FhirExtension | undefined {
  return extension.extension?.find((entry) => entry.url === url);
}
function children(extension: FhirExtension, url: string): FhirExtension[] {
  return extension.extension?.filter((entry) => entry.url === url) ?? [];
}
function add(target: FhirExtension[], value: FhirExtension | undefined): void {
  if (value) target.push(value);
}
function valueString(url: string, value: string | undefined): FhirExtension | undefined {
  return value === undefined ? undefined : { url, valueString: value };
}
function valueCode(url: string, value: string | undefined): FhirExtension | undefined {
  return value === undefined ? undefined : { url, valueCode: value };
}
function valueInteger(url: string, value: number | undefined): FhirExtension | undefined {
  return value === undefined ? undefined : { url, valueInteger: value };
}
function valueDecimal(url: string, value: number | undefined): FhirExtension | undefined {
  return value === undefined ? undefined : { url, valueDecimal: value };
}
function valueBoolean(url: string, value: boolean | undefined): FhirExtension | undefined {
  return value === undefined ? undefined : { url, valueBoolean: value };
}
function valueCoding(url: string, value: FhirCoding | undefined): FhirExtension | undefined {
  if (!value) return undefined;
  return {
    url,
    valueCoding: {
      system: value.system,
      code: value.code,
      display: value.display,
      extension: value.extension,
      _display: value._display,
      i18n: value.i18n
    }
  };
}

function buildArgumentExtension(argument: AdviceArgument): FhirExtension {
  const nested: FhirExtension[] = [];
  add(nested, valueCode("role", argument.role));
  add(nested, valueString("text", argument.text));
  add(nested, valueString("normalized", argument.normalized));
  add(nested, valueString("conceptId", argument.conceptId));
  add(nested, valueCoding("coding", argument.coding));
  for (const coding of argument.codings ?? []) {
    nested.push({ url: "argumentCoding", valueCoding: { ...coding } });
  }
  if (argument.span) {
    add(nested, valueInteger("spanStart", argument.span.start));
    add(nested, valueInteger("spanEnd", argument.span.end));
  }
  if (argument.quantity) {
    const quantity: FhirExtension[] = [];
    add(quantity, valueDecimal("value", argument.quantity.value));
    add(quantity, valueDecimal("low", argument.quantity.range?.low));
    add(quantity, valueDecimal("high", argument.quantity.range?.high));
    add(quantity, valueString("unit", argument.quantity.unit));
    nested.push({ url: "quantity", extension: quantity });
  }
  for (const locale of Object.keys(argument.i18n ?? {})) {
    const translated = argument.i18n?.[locale];
    if (!translated) continue;
    nested.push({
      url: "translation",
      extension: [
        { url: "locale", valueCode: locale },
        { url: "text", valueString: translated }
      ]
    });
  }
  return { url: "argument", extension: nested };
}

function buildActionExtension(frame: AdviceFrame): FhirExtension {
  const nested: FhirExtension[] = [];
  add(nested, valueInteger("sequenceIndex", frame.sequenceIndex));
  add(nested, valueCode("origin", frame.origin));
  add(nested, valueDecimal("confidence", frame.confidence));
  add(nested, valueCode("force", frame.force));
  add(nested, valueCode("polarity", frame.polarity));
  add(nested, valueCode("modality", frame.modality));
  add(nested, valueCode("relation", frame.relation));
  add(nested, valueString("predicateLemma", frame.predicate.lemma));
  add(nested, valueString("predicateDisplay", frame.predicate.display));
  add(nested, valueString("semanticClass", frame.predicate.semanticClass));
  for (const locale of Object.keys(frame.predicate.i18n ?? {})) {
    const text = frame.predicate.i18n?.[locale];
    if (!text) continue;
    nested.push({
      url: "predicateTranslation",
      extension: [
        { url: "locale", valueCode: locale },
        { url: "text", valueString: text }
      ]
    });
  }
  add(nested, valueCode("predicateRealizer", frame.predicate.realizer));
  add(nested, valueString("predicateRealizerThaiFallbackObject", frame.predicate.realizerConfig?.thaiFallbackObject));
  for (const conceptId of frame.predicate.realizerConfig?.thaiSuppressActivityConcepts ?? []) {
    add(nested, valueString("predicateRealizerThaiSuppressActivityConcept", conceptId));
  }
  for (const coding of frame.predicate.codings ?? []) nested.push({ url: "predicateCoding", valueCoding: { ...coding } });
  add(nested, valueInteger("spanStart", frame.span.start));
  add(nested, valueInteger("spanEnd", frame.span.end));
  add(nested, valueString("sourceText", frame.sourceText));
  for (const argument of frame.args) nested.push(buildArgumentExtension(argument));
  return { url: "action", extension: nested };
}

export function buildInstructionGraphExtension(
  graph: CanonicalInstructionGraph | undefined
): FhirExtension | undefined {
  if (!graph || (!graph.actions.length && !graph.opaqueSpans?.length)) return undefined;
  const nested: FhirExtension[] = [];
  add(nested, valueString("sourceText", graph.sourceText));
  add(nested, valueCode("sourceLocale", graph.sourceLocale));
  add(nested, valueInteger("primaryAdministrationStart", graph.primaryAdministrationSpan?.start));
  add(nested, valueInteger("primaryAdministrationEnd", graph.primaryAdministrationSpan?.end));
  for (const action of graph.actions) nested.push(buildActionExtension(action));
  for (const relation of graph.relations ?? []) {
    const relationNested: FhirExtension[] = [];
    add(relationNested, valueCode("kind", relation.kind));
    add(relationNested, valueInteger("fromActionIndex", relation.fromActionIndex));
    add(relationNested, valueInteger("toActionIndex", relation.toActionIndex));
    add(relationNested, valueString("text", relation.text));
    if (relation.span) {
      add(relationNested, valueInteger("spanStart", relation.span.start));
      add(relationNested, valueInteger("spanEnd", relation.span.end));
    }
    nested.push({ url: "graphRelation", extension: relationNested });
  }
  if (graph.coverage) {
    const coverage: FhirExtension[] = [];
    add(coverage, valueInteger("understoodCharacters", graph.coverage.understoodCharacters));
    add(coverage, valueInteger("opaqueCharacters", graph.coverage.opaqueCharacters));
    add(coverage, valueDecimal("ratio", graph.coverage.ratio));
    add(coverage, valueBoolean("complete", graph.coverage.complete));
    nested.push({ url: "coverage", extension: coverage });
  }
  for (const opaque of graph.opaqueSpans ?? []) {
    const opaqueNested: FhirExtension[] = [
      { url: "start", valueInteger: opaque.start },
      { url: "end", valueInteger: opaque.end },
      { url: "text", valueString: opaque.text }
    ];
    for (const tokenIndex of opaque.tokenIndices ?? []) {
      opaqueNested.push({ url: "tokenIndex", valueInteger: tokenIndex });
    }
    nested.push({ url: "opaque", extension: opaqueNested });
  }
  return { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: nested };
}

function parseArgumentExtension(extension: FhirExtension): AdviceArgument | undefined {
  const role = child(extension, "role")?.valueCode as AdviceArgumentRole | undefined;
  const text = child(extension, "text")?.valueString;
  if (!role || text === undefined) return undefined;
  const argument: AdviceArgument = {
    role,
    text,
    normalized: child(extension, "normalized")?.valueString,
    conceptId: child(extension, "conceptId")?.valueString,
    coding: child(extension, "coding")?.valueCoding,
    codings: children(extension, "argumentCoding")
      .map((entry) => entry.valueCoding)
      .filter((entry): entry is FhirCoding => Boolean(entry))
  };
  const spanStart = child(extension, "spanStart")?.valueInteger;
  const spanEnd = child(extension, "spanEnd")?.valueInteger;
  if (spanStart !== undefined && spanEnd !== undefined) argument.span = { start: spanStart, end: spanEnd };
  const quantityExtension = child(extension, "quantity");
  if (quantityExtension) {
    const value = child(quantityExtension, "value")?.valueDecimal;
    const low = child(quantityExtension, "low")?.valueDecimal;
    const high = child(quantityExtension, "high")?.valueDecimal;
    const unit = child(quantityExtension, "unit")?.valueString;
    if (value !== undefined || low !== undefined || high !== undefined || unit !== undefined) {
      argument.quantity = {
        value,
        range: low !== undefined || high !== undefined ? { low, high } : undefined,
        unit
      };
    }
  }
  const i18n: Record<string, string> = {};
  for (const translation of children(extension, "translation")) {
    const locale = child(translation, "locale")?.valueCode;
    const translated = child(translation, "text")?.valueString;
    if (locale && translated) i18n[locale] = translated;
  }
  if (Object.keys(i18n).length) argument.i18n = i18n;
  return argument;
}

function parseActionExtension(extension: FhirExtension): AdviceFrame | undefined {
  const lemma = child(extension, "predicateLemma")?.valueString;
  const spanStart = child(extension, "spanStart")?.valueInteger;
  const spanEnd = child(extension, "spanEnd")?.valueInteger;
  const sourceText = child(extension, "sourceText")?.valueString;
  const force = child(extension, "force")?.valueCode as AdviceForce | undefined;
  if (!lemma || spanStart === undefined || spanEnd === undefined || sourceText === undefined || !force) return undefined;
  const args: AdviceArgument[] = [];
  for (const argumentExtension of children(extension, "argument")) {
    const argument = parseArgumentExtension(argumentExtension);
    if (argument) args.push(argument);
  }
  const thaiSuppressActivityConcepts = children(
    extension,
    "predicateRealizerThaiSuppressActivityConcept"
  ).map((entry) => entry.valueString).filter((value): value is string => Boolean(value));
  const predicateI18n: Record<string, string> = {};
  for (const translation of children(extension, "predicateTranslation")) {
    const locale = child(translation, "locale")?.valueCode;
    const translated = child(translation, "text")?.valueString;
    if (locale && translated) predicateI18n[locale] = translated;
  }
  return {
    force,
    origin: child(extension, "origin")?.valueCode as AdviceFrame["origin"] | undefined,
    confidence: child(extension, "confidence")?.valueDecimal,
    polarity: child(extension, "polarity")?.valueCode as AdvicePolarity | undefined,
    modality: child(extension, "modality")?.valueCode as AdviceModality | undefined,
    relation: child(extension, "relation")?.valueCode as AdviceRelation | undefined,
    predicate: {
      lemma,
      display: child(extension, "predicateDisplay")?.valueString,
      i18n: Object.keys(predicateI18n).length ? predicateI18n : undefined,
      semanticClass: child(extension, "semanticClass")?.valueString,
      realizer: child(extension, "predicateRealizer")?.valueCode as AdviceFrame["predicate"]["realizer"] | undefined,
      realizerConfig: child(extension, "predicateRealizerThaiFallbackObject")?.valueString ||
        thaiSuppressActivityConcepts.length
        ? {
            thaiFallbackObject: child(extension, "predicateRealizerThaiFallbackObject")?.valueString,
            thaiSuppressActivityConcepts: thaiSuppressActivityConcepts.length
              ? thaiSuppressActivityConcepts
              : undefined
          }
        : undefined,
      codings: children(extension, "predicateCoding")
        .map((entry) => entry.valueCoding)
        .filter((entry): entry is FhirCoding => Boolean(entry))
    },
    args,
    span: { start: spanStart, end: spanEnd },
    sourceText,
    sequenceIndex: child(extension, "sequenceIndex")?.valueInteger
  };
}

export function parseInstructionGraphExtension(
  extensions: FhirExtension[] | undefined
): CanonicalInstructionGraph | undefined {
  const extension = extensions?.find((entry) => entry.url === MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL);
  if (!extension) return undefined;
  const actions: AdviceFrame[] = [];
  for (const actionExtension of children(extension, "action")) {
    const action = parseActionExtension(actionExtension);
    if (action) actions.push(action);
  }
  const relations: CanonicalInstructionRelation[] = [];
  for (const entry of children(extension, "graphRelation")) {
    const kind = child(entry, "kind")?.valueCode as AdviceRelation | undefined;
    const toActionIndex = child(entry, "toActionIndex")?.valueInteger;
    if (!kind || toActionIndex === undefined) continue;
    const spanStart = child(entry, "spanStart")?.valueInteger;
    const spanEnd = child(entry, "spanEnd")?.valueInteger;
    relations.push({
      kind,
      fromActionIndex: child(entry, "fromActionIndex")?.valueInteger,
      toActionIndex,
      text: child(entry, "text")?.valueString,
      span: spanStart !== undefined && spanEnd !== undefined
        ? { start: spanStart, end: spanEnd }
        : undefined
    });
  }
  const coverageExtension = child(extension, "coverage");
  let coverage: CanonicalInstructionCoverage | undefined;
  if (coverageExtension) {
    const understoodCharacters = child(coverageExtension, "understoodCharacters")?.valueInteger;
    const opaqueCharacters = child(coverageExtension, "opaqueCharacters")?.valueInteger;
    const ratio = child(coverageExtension, "ratio")?.valueDecimal;
    const complete = child(coverageExtension, "complete")?.valueBoolean;
    if (
      understoodCharacters !== undefined &&
      opaqueCharacters !== undefined &&
      ratio !== undefined &&
      complete !== undefined
    ) {
      coverage = { understoodCharacters, opaqueCharacters, ratio, complete };
    }
  }
  const opaqueSpans: CanonicalSourceSpan[] = [];
  for (const entry of children(extension, "opaque")) {
    const start = child(entry, "start")?.valueInteger;
    const end = child(entry, "end")?.valueInteger;
    const text = child(entry, "text")?.valueString;
    if (start === undefined || end === undefined || text === undefined) continue;
    const tokenIndices = children(entry, "tokenIndex")
      .map((token) => token.valueInteger)
      .filter((value): value is number => value !== undefined);
    opaqueSpans.push({
      start,
      end,
      text,
      ...(tokenIndices.length ? { tokenIndices } : {})
    });
  }
  if (!actions.length && !opaqueSpans.length) return undefined;
  const primaryAdministrationStart = child(extension, "primaryAdministrationStart")?.valueInteger;
  const primaryAdministrationEnd = child(extension, "primaryAdministrationEnd")?.valueInteger;
  return {
    actions,
    primaryAdministrationSpan:
      primaryAdministrationStart !== undefined && primaryAdministrationEnd !== undefined
        ? { start: primaryAdministrationStart, end: primaryAdministrationEnd }
        : undefined,
    relations: relations.length ? relations : undefined,
    opaqueSpans: opaqueSpans.length ? opaqueSpans : undefined,
    coverage,
    sourceText: child(extension, "sourceText")?.valueString ?? "",
    sourceLocale: child(extension, "sourceLocale")?.valueCode
  };
}
