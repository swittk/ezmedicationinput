import { equalStructuredValues } from "./stable-structure";
import { DOSAGE_RECONCILIATION_SOURCE_URL } from "./dosage-course";
import { getEmaQuantityComparator, QUANTITY_OPERATOR_SOURCE_URL, quantityFromWire, simpleQuantityForR5 } from "./fhir-quantity-operator";
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
  FhirExtension,
  FhirR6Extension
} from "./types";
import {
  getPrimitiveTranslations,
  mergeTranslationPrimitiveElement
} from "./fhir-translations";
import relationTerms from "./relation-terminology.json";

/** Reuse declarative relation terminology, compiling only its exact codings
 * once for FHIR graph projection/import. Grammar uses the same JSON lexicon.
 */
const RELATION_CODE_BY_KIND = new Map<AdviceRelation, FhirCoding>();
const RELATION_KIND_BY_CODE = new Map<string, AdviceRelation>();
for (const value of relationTerms.adviceRelations as Array<{ relation: string; coding?: FhirCoding }>) {
  const coding = value.coding;
  if (coding?.system && coding.code) {
    const kind = value.relation as AdviceRelation;
    RELATION_CODE_BY_KIND.set(kind, coding);
    RELATION_KIND_BY_CODE.set(`${coding.system}|${coding.code}`, kind);
  }
}

function getAdviceRelationCoding(relation: AdviceRelation): FhirCoding | undefined {
  return RELATION_CODE_BY_KIND.get(relation);
}
function getAdviceRelationByCoding(coding: FhirCoding | undefined): AdviceRelation | undefined {
  return coding?.system && coding.code
    ? RELATION_KIND_BY_CODE.get(`${coding.system}|${coding.code}`)
    : undefined;
}
function getGraphRelationByCoding(coding: FhirCoding | undefined): AdviceRelation | undefined {
  return coding?.system === "http://hl7.org/fhir/action-relationship-type" &&
    (coding.code === "before" || coding.code === "after")
    ? coding.code as AdviceRelation : getAdviceRelationByCoding(coding);
}

export const MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-instruction-graph";

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
/** FHIR Coding has no i18n member. Preserve internal translations as the
 * standard _display translation primitive, and omit optional undefined
 * members: strict nested Extension unions validate the in-memory FHIR shape.
 */
function wireCoding(value: FhirCoding): FhirCoding {
  let displayPrimitive = value._display;
  if (value.i18n) displayPrimitive = mergeTranslationPrimitiveElement(displayPrimitive, value.i18n);
  // Keep supplied Coding fields, including unknown wire annotations, while
  // the translated display primitive remains the only rewritten field.
  const source = value as FhirCoding & Record<string, unknown>;
  const result: FhirCoding & Record<string, unknown> = {};
  for (const key in source) {
    if (key === "i18n" || key === "_display" || (key === "extension" && !value.extension?.length)) continue;
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (displayPrimitive) result._display = displayPrimitive;
  return result;
}

function readCoding(value: FhirCoding | undefined): FhirCoding | undefined {
  if (!value) return undefined;
  const translations = getPrimitiveTranslations(value._display);
  return translations
    ? { ...value, i18n: { ...(value.i18n ?? {}), ...translations } }
    : value;
}

function valueCoding(url: string, value: FhirCoding | undefined): FhirExtension | undefined {
  return value ? { url, valueCoding: wireCoding(value) } : undefined;
}

/** Keep the graph's role-specific relation while emitting standard SNOMED
 * dosing-fragment codes instead of proprietary identifiers when exact.
 * @param extensions Destination within the existing instruction graph.
 * @param name Relation child name (relation or kind).
 * @param relation Resolved typed relation, not a free-text guess.
 */
function addRelation(
  extensions: FhirExtension[], name: string, relation: AdviceRelation | undefined,
  sourceCoding?: FhirCoding
): FhirExtension | undefined {
  const currentCoding = sourceCoding && relation !== undefined &&
    getAdviceRelationByCoding(sourceCoding) === relation;
  if (relation) {
    const coding = currentCoding ? sourceCoding : getAdviceRelationCoding(relation);
    if (coding) add(extensions, valueCoding(`${name}Coding`, coding));
    else add(extensions, valueCode(name, relation));
  }
  return sourceCoding && !currentCoding ? valueCoding("sourceRelationCoding", sourceCoding) : undefined;
}

/** Merge annotations on component fields while current typed values stay active. */
function addFieldSources(parts: FhirExtension[], sources: FhirExtension[] | undefined): void {
  for (const source of sources ?? []) {
    let index = -1;
    if (source.url === "role" || source.url === "text" || source.url === "coding" || source.url === "normalized") {
      for (let i = 0; i < parts.length; i++) if (parts[i].url === source.url) { index = i; break; }
    }
    if (source.url === "coding" && source.valueCoding) {
      const current = index >= 0 ? parts[index].valueCoding : undefined, old = source.valueCoding;
      // A replacement may retain code identity while changing its display or
      // primitive metadata. Preserve the full displaced Coding as inactive source.
      if (!current || !equalStructuredValues(current, old)) {
        parts.push({ ...source, url: "sourceCoding" });
        continue;
      }
    }
    if (index >= 0) parts[index] = { ...source, ...parts[index] };
    else if (source.url === "normalized")
      parts.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [source] });
    else parts.push(source);
  }
}

function buildArgumentExtension(argument: AdviceArgument): FhirExtension {
  const nested: FhirExtension[] = [];
  add(nested, valueCode("role", argument.role));
  const sourceRelation = addRelation(nested, "relation", argument.relation, argument.sourceRelationCoding);
  add(nested, valueString("text", argument.text));
  add(nested, valueString("normalized", argument.normalized));
  add(nested, valueString("conceptId", argument.conceptId));
  add(nested, valueCoding("coding", argument.coding));
  for (const coding of argument.codings ?? []) {
    nested.push({ url: "argumentCoding", valueCoding: wireCoding(coding) });
  }
  for (const component of argument.components ?? []) {
    const parts: FhirExtension[] = [
      { url: "role", valueCode: component.role },
      { url: "text", valueString: component.text }
    ];
    add(parts, valueCoding("coding", component.coding));
    addFieldSources(parts, component.sourceExtensions);
    nested.push({ ...(component.sourceId ? { id: component.sourceId } : {}), url: "component", extension: parts });
  }
  if (argument.span) {
    add(nested, valueInteger("spanStart", argument.span.start));
    add(nested, valueInteger("spanEnd", argument.span.end));
  }
  if (argument.quantity) {
    const quantity: FhirExtension[] = [];
    let displacedFields: FhirExtension[] | undefined;
    if (argument.quantity.fieldMetadata) {
      for (const [name, value] of [
        ["value", argument.quantity.value], ["low", argument.quantity.range?.low],
        ["high", argument.quantity.range?.high], ["unit", argument.quantity.unit]
      ] as const) {
        const metadata = argument.quantity.fieldMetadata[name];
        if (value === undefined) {
          if (metadata) {
            const { _valueDecimal, _valueString, extension, ...annotations } = metadata;
            const primitive = name === "unit" ? _valueString : _valueDecimal;
            // A cleared active field cannot be an id-only Extension. Retain
            // its annotations on a valid, inert source field identifier.
            (displacedFields ??= []).push({ ...annotations, url: "sourceQuantityField", extension: [
              { url: "field", valueCode: name, ...(primitive ? { _valueCode: primitive } : {}) },
              ...(extension ?? [])
            ] });
          }
          continue;
        }
        const field: FhirExtension = { ...metadata, url: name };
        if (name === "unit") field.valueString = value;
        else field.valueDecimal = value;
        quantity.push(field);
      }
    } else {
      add(quantity, valueDecimal("value", argument.quantity.value));
      add(quantity, valueDecimal("low", argument.quantity.range?.low));
      add(quantity, valueDecimal("high", argument.quantity.range?.high));
      add(quantity, valueString("unit", argument.quantity.unit));
    }
    if (displacedFields) quantity.push(...displacedFields);
    // Use the published EMA Coding for an operator, not a private graph code.
    // Exact graph quantities keep their existing wire shape.
    if (argument.quantity.comparator || argument.quantity.comparatorElement || argument.quantity.comparatorExtensions?.length) {
      // The public graph quantity owns its current comparator. A cleared
      // comparator must not reactivate an annotated carrier retained at import.
      const extensions = argument.quantity.comparator ? argument.quantity.comparatorExtensions :
        argument.quantity.comparatorExtensions?.map(extension =>
          getEmaQuantityComparator({ extension: [extension] })
            ? { url: QUANTITY_OPERATOR_SOURCE_URL, extension: [extension] } : extension);
      quantity.push(...(simpleQuantityForR5({ comparator: argument.quantity.comparator,
        _comparator: argument.quantity.comparatorElement, extension: extensions })?.extension ?? []));
    }
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
  add(nested, sourceRelation);
  if (argument.sourceExtensions) addFieldSources(nested, argument.sourceExtensions);
  const result: FhirExtension = { url: "argument", extension: nested };
  if (argument.sourceId !== undefined) result.id = argument.sourceId;
  return result;
}

function buildActionExtension(frame: AdviceFrame): FhirExtension {
  const nested: FhirExtension[] = [];
  add(nested, valueInteger("sequenceIndex", frame.sequenceIndex));
  add(nested, valueCode("origin", frame.origin));
  add(nested, valueDecimal("confidence", frame.confidence));
  add(nested, valueCode("force", frame.force));
  add(nested, valueCode("polarity", frame.polarity));
  add(nested, valueCode("polaritySource", frame.polaritySource));
  add(nested, valueCode("modality", frame.modality));
  const sourceRelation = addRelation(nested, "relation", frame.relation, frame.sourceRelationCoding);
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
  for (const locale of Object.keys(frame.predicate.realizerConfig?.locales ?? {})) {
    const config = frame.predicate.realizerConfig?.locales?.[locale];
    if (!config) continue;
    const localized: FhirExtension[] = [{ url: "locale", valueCode: locale }];
    add(localized, valueString("fallbackObject", config.fallbackObject));
    add(localized, valueBoolean("implicitMedicationObject", config.implicitMedicationObject));
    add(localized, valueBoolean("directSiteObject", config.directSiteObject));
    add(localized, valueBoolean("directDose", config.directDose));
    add(localized, valueString("administrationDurationPrefix", config.administrationDurationPrefix));
    if (config.routePhrases) for (const route of Object.keys(config.routePhrases)) {
      localized.push({ url: "routePhrase", extension: [
        { url: "route", valueCode: route },
        { url: "text", valueString: config.routePhrases[route] }
      ] });
    }
    for (const conceptId of config.suppressActivityConcepts ?? []) {
      add(localized, valueString("suppressActivityConcept", conceptId));
    }
    for (const conceptId of config.suppressSiteConcepts ?? []) {
      add(localized, valueString("suppressSiteConcept", conceptId));
    }
    nested.push({ url: "predicateRealizerLocale", extension: localized });
  }
  for (const coding of frame.predicate.codings ?? []) nested.push({ url: "predicateCoding", valueCoding: wireCoding(coding) });
  for (const part of frame.predicate.semanticComponents ?? []) {
    const parts: FhirExtension[] = [
      { url: "role", valueCode: part.role },
      { url: "coding", valueCoding: wireCoding(part.coding) }
    ];
    addFieldSources(parts, part.sourceExtensions);
    nested.push({ ...(part.sourceId ? { id: part.sourceId } : {}), url: "predicateComponent", extension: parts });
  }
  add(nested, valueInteger("spanStart", frame.span.start));
  add(nested, valueInteger("spanEnd", frame.span.end));
  const sourceTextIndex = nested.length;
  add(nested, valueString("sourceText", frame.sourceText));
  for (const argument of frame.args) nested.push(buildArgumentExtension(argument));
  add(nested, sourceRelation);
  if (frame.sourceExtensions) for (const field of frame.sourceExtensions) {
    if (field.url === "sourceText") {
      const { valueString: _sourceText, ...annotations } = field;
      nested[sourceTextIndex] = { ...annotations, ...(frame.sourceText ? { valueString: frame.sourceText } : {}) };
    } else nested.push(field);
  }
  const result: FhirExtension = { url: "action", extension: nested };
  if (frame.sourceId !== undefined) result.id = frame.sourceId;
  return result;
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
  if (graph.primaryOwnership) {
    const ownership: FhirExtension[] = [{ url: "resolved", valueBoolean: true }];
    add(ownership, valueInteger("administrationActionIndex", graph.primaryOwnership.administrationActionIndex));
    add(ownership, valueInteger("doseActionIndex", graph.primaryOwnership.dose?.actionIndex));
    add(ownership, valueInteger("doseArgumentIndex", graph.primaryOwnership.dose?.argumentIndex));
    const activeFields = ownership.length;
    for (const field of graph.primaryOwnership.sourceExtensions ?? []) {
      let index = -1;
      for (let i = 0; i < activeFields; i++) if (ownership[i].url === field.url) { index = i; break; }
      if (index >= 0) ownership[index] = { ...field, ...ownership[index] };
      else if (field.url === "resolved" || field.url === "administrationActionIndex" ||
          field.url === "doseActionIndex" || field.url === "doseArgumentIndex")
        ownership.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: [field] });
      else ownership.push(field);
    }
    const marker: FhirExtension = { url: "primaryOwnership", extension: ownership };
    if (graph.primaryOwnership.sourceId !== undefined) marker.id = graph.primaryOwnership.sourceId;
    nested.push(marker);
  }
  for (const action of graph.actions) nested.push(buildActionExtension(action));
  for (const relation of graph.relations ?? []) {
    const relationNested: FhirExtension[] = [];
    const sourceCoding = relation.sourceKindCoding;
    const linkedActions = (relation.kind === AdviceRelation.Before || relation.kind === AdviceRelation.After) &&
      relation.fromActionIndex !== undefined;
    const currentCoding = sourceCoding && getGraphRelationByCoding(sourceCoding) === relation.kind &&
      (sourceCoding.system === "http://hl7.org/fhir/action-relationship-type") === linkedActions;
    // Formal before/after codes apply to explicitly linked actions, not
    // "before food", "after a symptom", or other unlinked textual adjuncts.
    if (currentCoding) add(relationNested, valueCoding("kindCoding", sourceCoding));
    else if (linkedActions) {
      add(relationNested, valueCoding("kindCoding", {
        system: "http://hl7.org/fhir/action-relationship-type",
        code: relation.kind,
        display: relation.kind === AdviceRelation.Before ? "Before" : "After"
      }));
    } else {
      addRelation(relationNested, "kind", relation.kind);
    }
    add(relationNested, valueInteger("fromActionIndex", relation.fromActionIndex));
    add(relationNested, valueInteger("toActionIndex", relation.toActionIndex));
    add(relationNested, valueString("text", relation.text));
    if (relation.span) {
      add(relationNested, valueInteger("spanStart", relation.span.start));
      add(relationNested, valueInteger("spanEnd", relation.span.end));
    }
    if (sourceCoding && !currentCoding) add(relationNested, valueCoding("sourceKindCoding", sourceCoding));
    if (relation.sourceExtensions) relationNested.push(...relation.sourceExtensions);
    nested.push({ url: "graphRelation", ...(relation.sourceId !== undefined ? { id: relation.sourceId } : {}),
      extension: relationNested });
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
  if (graph.sourceExtensions) for (const field of graph.sourceExtensions) nested.push(field);
  const result: FhirExtension = { url: MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL, extension: nested };
  if (graph.sourceId !== undefined) result.id = graph.sourceId;
  return result;
}

function firstRelation(coding:FhirCoding|undefined,raw:string|undefined):AdviceRelation|undefined {
  return getAdviceRelationByCoding(coding)??raw as AdviceRelation|undefined;
}
function parseTranslationNode(extension:FhirExtension):{locale?:string;text?:string} {
  let locale:FhirExtension|undefined,text:FhirExtension|undefined;
  for(const node of extension.extension??[])switch(node.url){
    case "locale":if(!locale)locale=node;break;
    case "text":if(!text)text=node;break;
  }
  return {locale:locale?.valueCode,text:text?.valueString};
}
function hasFieldMetadata(field: FhirExtension, valueKey: string): boolean {
  for (const key in field) if (key !== "url" && key !== valueKey) return true;
  return false;
}

function hasCodingMetadata(coding: FhirCoding | undefined): boolean {
  if (!coding) return false;
  for (const key in coding) {
    switch (key) {
      case "system": case "version": case "code": case "display": case "userSelected": case "i18n": break;
      default: return true;
    }
  }
  return false;
}

/** Keep only recognized-field metadata; the typed quantity owns its value. */
function quantityFieldMetadata(field: FhirExtension | undefined, valueKey: "valueDecimal" | "valueString") {
  if (!field || !hasFieldMetadata(field, valueKey)) return undefined;
  const { url: _url, valueDecimal: _decimal, valueString: _string, ...metadata } = field;
  return metadata;
}

function parseArgumentExtension(extension:FhirExtension):AdviceArgument|undefined {
  let role:FhirExtension|undefined,text:FhirExtension|undefined,relation:FhirExtension|undefined,
    relationCoding:FhirExtension|undefined,normalized:FhirExtension|undefined,concept:FhirExtension|undefined,
    coding:FhirExtension|undefined,spanStart:FhirExtension|undefined,spanEnd:FhirExtension|undefined,
    quantity:FhirExtension|undefined;
  const codings:FhirCoding[]=[],components:NonNullable<AdviceArgument["components"]>=[];
  let i18n:Record<string,string>|undefined,sourceExtensions:FhirExtension[]|undefined;
  for(const entry of extension.extension??[])switch(entry.url){
    case "role":
      if(!role)role=entry;
      if(hasFieldMetadata(entry,"valueCode"))(sourceExtensions??=[]).push(entry);
      break;
    case "text":
      if(!text)text=entry;
      if(hasFieldMetadata(entry,"valueString"))(sourceExtensions??=[]).push(entry);
      break;
    case "relation":if(!relation)relation=entry;break;
    case "relationCoding":if(!relationCoding)relationCoding=entry;break;
    case "normalized":
      if(!normalized)normalized=entry;
      if(hasFieldMetadata(entry,"valueString"))(sourceExtensions??=[]).push(entry);
      break;
    case "conceptId":if(!concept)concept=entry;break;
    case "coding":if(!coding)coding=entry;break;
    case "spanStart":if(!spanStart)spanStart=entry;break;
    case "spanEnd":if(!spanEnd)spanEnd=entry;break;
    case "quantity":if(!quantity)quantity=entry;break;
    case "argumentCoding":{const value=readCoding(entry.valueCoding);if(value)codings.push(value);break;}
    case "translation":{const value=parseTranslationNode(entry);if(value.locale&&value.text)(i18n??={})[value.locale]=value.text;break;}
    case "component":{
      let componentRole:FhirExtension|undefined,componentText:FhirExtension|undefined,componentCoding:FhirExtension|undefined;
      let componentSource:FhirExtension[]|undefined;
      for(const part of entry.extension??[])switch(part.url){
        case "role":
          if (!componentRole) componentRole = part;
          if (hasFieldMetadata(part, "valueCode")) (componentSource ??= []).push(part);
          break;
        case "text":
          if (!componentText) componentText = part;
          if (hasFieldMetadata(part, "valueString")) (componentSource ??= []).push(part);
          break;
        case "coding":
          if (!componentCoding) componentCoding = part;
          if (hasFieldMetadata(part, "valueCoding") || hasCodingMetadata(part.valueCoding)) (componentSource ??= []).push(part);
          break;
        default:(componentSource??=[]).push(part);break;
      }
      const value=componentRole?.valueCode,body=componentText?.valueString;
      if((value==="head"||value==="qualifier"||value==="amount")&&body!==undefined){
        const term=readCoding(componentCoding?.valueCoding);
        components.push({role:value,text:body,...(term?{coding:term}:{}),
          ...(entry.id?{sourceId:entry.id}:{}),...(componentSource?{sourceExtensions:componentSource}:{})});
      }
      break;
    }
    default:(sourceExtensions??=[]).push(entry);break;
  }
  if(!role?.valueCode||text?.valueString===undefined)return undefined;
  const result:AdviceArgument={role:role.valueCode as AdviceArgumentRole,text:text.valueString,
    relation:firstRelation(relationCoding?.valueCoding,relation?.valueCode),
    normalized:normalized?.valueString,conceptId:concept?.valueString,
    coding:readCoding(coding?.valueCoding),codings};
  if(extension.id!==undefined)result.sourceId=extension.id;
  if(relationCoding?.valueCoding)result.sourceRelationCoding=readCoding(relationCoding.valueCoding);
  if(components.length)result.components=components;
  if(sourceExtensions)result.sourceExtensions=sourceExtensions;
  if(spanStart?.valueInteger!==undefined&&spanEnd?.valueInteger!==undefined)
    result.span={start:spanStart.valueInteger,end:spanEnd.valueInteger};
  if(quantity){
    let value:FhirExtension|undefined,low:FhirExtension|undefined,high:FhirExtension|undefined,unit:FhirExtension|undefined;
    let comparatorExtensions:FhirR6Extension[]|undefined;
    for(const field of quantity.extension??[])switch(field.url){
      case "value":if(!value)value=field;break;case "low":if(!low)low=field;break;
      case "high":if(!high)high=field;break;case "unit":if(!unit)unit=field;break;
      default:
        // The quantity decoder owns operators; unfamiliar annotations remain
        // retained data beside them and must survive a graph rebuild.
        (comparatorExtensions??=[]).push(field);break;
    }
    const amount=value?.valueDecimal,lower=low?.valueDecimal,upper=high?.valueDecimal,units=unit?.valueString;
    const valueMetadata=quantityFieldMetadata(value,"valueDecimal"),lowMetadata=quantityFieldMetadata(low,"valueDecimal"),
      highMetadata=quantityFieldMetadata(high,"valueDecimal"),unitMetadata=quantityFieldMetadata(unit,"valueString");
    const fieldMetadata=valueMetadata||lowMetadata||highMetadata||unitMetadata ? {
      ...(valueMetadata?{value:valueMetadata}:{}),...(lowMetadata?{low:lowMetadata}:{}),
      ...(highMetadata?{high:highMetadata}:{}),...(unitMetadata?{unit:unitMetadata}:{})
    } : undefined;
    const current=comparatorExtensions?quantityFromWire({extension:comparatorExtensions}):undefined;
    const comparator=current?.comparator,comparatorElement=current?._comparator;
    comparatorExtensions=current?.extension;
    if(amount!==undefined||lower!==undefined||upper!==undefined||units!==undefined||comparator!==undefined||comparatorElement||comparatorExtensions?.length||fieldMetadata)
      result.quantity={value:amount,range:lower!==undefined||upper!==undefined?{low:lower,high:upper}:undefined,
        unit:units,...(comparator?{comparator}:{}),...(comparatorElement?{comparatorElement}:{}),
        ...(comparatorExtensions?{comparatorExtensions}:{}),...(fieldMetadata?{fieldMetadata}:{})};
  }
  if(i18n)result.i18n=i18n;
  return result;
}

/** Decode a locale-specific realizer configuration as a data-only facet.
 * No language-specific licensing occurs in this interchange reader. */
function parseRealizerLocale(extension:FhirExtension):{
  locale:string;config:NonNullable<NonNullable<AdviceFrame["predicate"]["realizerConfig"]>["locales"]>[string]
}|undefined {
  let locale:FhirExtension|undefined,fallback:FhirExtension|undefined,
    implicit:FhirExtension|undefined,direct:FhirExtension|undefined,
    directDose:FhirExtension|undefined,durationPrefix:FhirExtension|undefined;
  let routePhrases:Record<string,string>|undefined;
  const activities:string[]=[],sites:string[]=[];
  for(const field of extension.extension??[])switch(field.url){
    case "locale":if(!locale)locale=field;break;
    case "fallbackObject":if(!fallback)fallback=field;break;
    case "implicitMedicationObject":if(!implicit)implicit=field;break;
    case "directSiteObject":if(!direct)direct=field;break;
    case "directDose":if(!directDose)directDose=field;break;
    case "administrationDurationPrefix":if(!durationPrefix)durationPrefix=field;break;
    case "routePhrase": {
      const route=field.extension?.find(part=>part.url==="route")?.valueCode;
      const text=field.extension?.find(part=>part.url==="text")?.valueString;
      if(route!==undefined&&text!==undefined)(routePhrases??={})[route]=text;
      break;
    }
    case "suppressActivityConcept":if(field.valueString)activities.push(field.valueString);break;
    case "suppressSiteConcept":if(field.valueString)sites.push(field.valueString);break;
  }
  if(!locale?.valueCode)return undefined;
  return {locale:locale.valueCode,config:{fallbackObject:fallback?.valueString,
    implicitMedicationObject:implicit?.valueBoolean,directSiteObject:direct?.valueBoolean,
    directDose:directDose?.valueBoolean,routePhrases,administrationDurationPrefix:durationPrefix?.valueString,
    suppressActivityConcepts:activities.length?activities:undefined,suppressSiteConcepts:sites.length?sites:undefined}};
}
function parseActionExtension(extension:FhirExtension):AdviceFrame|undefined {
  let lemma:FhirExtension|undefined,start:FhirExtension|undefined,end:FhirExtension|undefined,
    source:FhirExtension|undefined,force:FhirExtension|undefined,origin:FhirExtension|undefined,
    confidence:FhirExtension|undefined,polarity:FhirExtension|undefined,polaritySource:FhirExtension|undefined,
    modality:FhirExtension|undefined,relation:FhirExtension|undefined,relationCoding:FhirExtension|undefined,
    display:FhirExtension|undefined,semanticClass:FhirExtension|undefined,realizer:FhirExtension|undefined,
    sequence:FhirExtension|undefined,legacyFallback:FhirExtension|undefined;
  const args:AdviceArgument[]=[],codings:FhirCoding[]=[],legacyActivities:string[]=[];
  const semanticComponents:NonNullable<AdviceFrame["predicate"]["semanticComponents"]>=[];
  let translations:Record<string,string>|undefined;
  let locales:NonNullable<AdviceFrame["predicate"]["realizerConfig"]>["locales"]|undefined;
  let sourceExtensions:FhirExtension[]|undefined;
  for(const field of extension.extension??[])switch(field.url){
    case "predicateLemma":if(!lemma)lemma=field;break;
    case "spanStart":if(!start)start=field;break;case "spanEnd":if(!end)end=field;break;
    case "sourceText":
      if (!source) {
        source = field;
        if (hasFieldMetadata(field, "valueString")) (sourceExtensions ??= []).push(field);
      }
      break;
    case "force":if(!force)force=field;break;
    case "origin":if(!origin)origin=field;break;case "confidence":if(!confidence)confidence=field;break;
    case "polarity":if(!polarity)polarity=field;break;case "polaritySource":if(!polaritySource)polaritySource=field;break;
    case "modality":if(!modality)modality=field;break;
    case "relation":if(!relation)relation=field;break;case "relationCoding":if(!relationCoding)relationCoding=field;break;
    case "predicateDisplay":if(!display)display=field;break;case "semanticClass":if(!semanticClass)semanticClass=field;break;
    case "predicateRealizer":if(!realizer)realizer=field;break;case "sequenceIndex":if(!sequence)sequence=field;break;
    case "argument":{const value=parseArgumentExtension(field);if(value)args.push(value);break;}
    case "predicateCoding":{const value=readCoding(field.valueCoding);if(value)codings.push(value);break;}
    case "predicateTranslation":{const value=parseTranslationNode(field);if(value.locale&&value.text)(translations??={})[value.locale]=value.text;break;}
    case "predicateRealizerLocale":{const value=parseRealizerLocale(field);if(value)(locales??={})[value.locale]=value.config;break;}
    // Actual historically persisted locale annotations, not new grammar rules.
    case "predicateRealizerThaiFallbackObject":if(!legacyFallback)legacyFallback=field;break;
    case "predicateRealizerThaiSuppressActivityConcept":if(field.valueString)legacyActivities.push(field.valueString);break;
    case "predicateComponent":{
      let role:FhirExtension|undefined,coding:FhirExtension|undefined,componentSource:FhirExtension[]|undefined;
      for(const part of field.extension??[])switch(part.url){
        case "role":
          if(!role)role=part;
          if(hasFieldMetadata(part,"valueCode"))(componentSource??=[]).push(part);
          break;
        case "coding":
          if(!coding)coding=part;
          if(hasFieldMetadata(part,"valueCoding")||hasCodingMetadata(part.valueCoding))(componentSource??=[]).push(part);
          break;
        default:(componentSource??=[]).push(part);break;
      }
      const value=role?.valueCode,code=readCoding(coding?.valueCoding);
      if((value==="activity"||value==="technique"||value==="target-state"||value==="target-site"||
        value==="target-object"||value==="operation"||value==="orientation"||value==="mechanism"||value==="situation")&&code?.system&&code.code)
        semanticComponents.push({role:value,coding:code,...(field.id?{sourceId:field.id}:{}),
          ...(componentSource?{sourceExtensions:componentSource}:{})});
      break;
    }
    default:(sourceExtensions??=[]).push(field);break;
  }
  if(!lemma?.valueString||start?.valueInteger===undefined||end?.valueInteger===undefined||(!source||(source.valueString===undefined&&source._valueString===undefined))||!force?.valueCode)return undefined;
  if(legacyFallback?.valueString||legacyActivities.length){
    locales??={};locales.th={...locales.th,fallbackObject:legacyFallback?.valueString??locales.th?.fallbackObject,
      suppressActivityConcepts:legacyActivities.length?legacyActivities:locales.th?.suppressActivityConcepts};
  }
  const frame:AdviceFrame = {force:force.valueCode as AdviceForce,origin:origin?.valueCode as AdviceFrame["origin"],
    confidence:confidence?.valueDecimal,polarity:polarity?.valueCode as AdvicePolarity,
    polaritySource:polaritySource?.valueCode==="shared"?"shared":undefined,
    modality:modality?.valueCode as AdviceModality,relation:firstRelation(relationCoding?.valueCoding,relation?.valueCode),
    predicate:{lemma:lemma.valueString,display:display?.valueString,i18n:translations,
      semanticClass:semanticClass?.valueString,realizer:realizer?.valueCode as AdviceFrame["predicate"]["realizer"],
      realizerConfig:locales?{locales}:undefined,codings,...(semanticComponents.length?{semanticComponents}:{})},
    args,span:{start:start.valueInteger,end:end.valueInteger},sourceText:source.valueString??"",sequenceIndex:sequence?.valueInteger};
  if(extension.id!==undefined)frame.sourceId=extension.id;
  if(relationCoding?.valueCoding)frame.sourceRelationCoding=readCoding(relationCoding.valueCoding);
  if(sourceExtensions)frame.sourceExtensions=sourceExtensions;
  return frame;
}

function parseGraphRelation(extension:FhirExtension):CanonicalInstructionRelation|undefined {
  let coding:FhirExtension|undefined,kind:FhirExtension|undefined,to:FhirExtension|undefined,from:FhirExtension|undefined,
    start:FhirExtension|undefined,end:FhirExtension|undefined,text:FhirExtension|undefined;
  let sourceExtensions:FhirExtension[]|undefined;
  for(const field of extension.extension??[])switch(field.url){
    case "kindCoding":if(!coding)coding=field;break;case "kind":if(!kind)kind=field;break;
    case "toActionIndex":if(!to)to=field;break;case "fromActionIndex":if(!from)from=field;break;
    case "spanStart":if(!start)start=field;break;case "spanEnd":if(!end)end=field;break;
    case "text":if(!text)text=field;break;
    default:(sourceExtensions??=[]).push(field);break;
  }
  const value=coding?.valueCoding;
  const relation=getGraphRelationByCoding(value)??firstRelation(undefined,kind?.valueCode);
  if(!relation||to?.valueInteger===undefined)return undefined;
  return {kind:relation,...(value ? {sourceKindCoding:readCoding(value)} : {}),fromActionIndex:from?.valueInteger,toActionIndex:to.valueInteger,text:text?.valueString,
    ...(extension.id !== undefined ? {sourceId:extension.id} : {}),
    ...(sourceExtensions ? {sourceExtensions} : {}),
    span:start?.valueInteger!==undefined&&end?.valueInteger!==undefined?{start:start.valueInteger,end:end.valueInteger}:undefined};
}
function parseOpaqueSpan(extension:FhirExtension):CanonicalSourceSpan|undefined {
  let start:FhirExtension|undefined,end:FhirExtension|undefined,text:FhirExtension|undefined;
  const tokens:number[]=[];
  for(const field of extension.extension??[])switch(field.url){
    case "start":if(!start)start=field;break;case "end":if(!end)end=field;break;case "text":if(!text)text=field;break;
    case "tokenIndex":if(field.valueInteger!==undefined)tokens.push(field.valueInteger);break;
  }
  return start?.valueInteger!==undefined&&end?.valueInteger!==undefined&&text?.valueString!==undefined
    ?{start:start.valueInteger,end:end.valueInteger,text:text.valueString,...(tokens.length?{tokenIndices:tokens}:{})}:undefined;
}
function parseGraphCoverage(extension:FhirExtension):CanonicalInstructionCoverage|undefined {
  let known:FhirExtension|undefined,opaque:FhirExtension|undefined,ratio:FhirExtension|undefined,complete:FhirExtension|undefined;
  for(const field of extension.extension??[])switch(field.url){
    case "understoodCharacters":if(!known)known=field;break;case "opaqueCharacters":if(!opaque)opaque=field;break;
    case "ratio":if(!ratio)ratio=field;break;case "complete":if(!complete)complete=field;break;
  }
  return known?.valueInteger!==undefined&&opaque?.valueInteger!==undefined&&ratio?.valueDecimal!==undefined&&complete?.valueBoolean!==undefined
    ?{understoodCharacters:known.valueInteger,opaqueCharacters:opaque.valueInteger,ratio:ratio.valueDecimal,complete:complete.valueBoolean}:undefined;
}

function parsePrimaryOwnership(extension: FhirExtension): CanonicalInstructionGraph["primaryOwnership"] {
  let resolved: FhirExtension | undefined, administration: FhirExtension | undefined,
    doseAction: FhirExtension | undefined, doseArgument: FhirExtension | undefined;
  let sourceExtensions: FhirExtension[] | undefined;
  for (const field of extension.extension ?? []) switch (field.url) {
    case "resolved":
      if (!resolved) resolved = field;
      if (hasFieldMetadata(field, "valueBoolean")) (sourceExtensions ??= []).push(field);
      break;
    case "administrationActionIndex":
      if (!administration) administration = field;
      if (hasFieldMetadata(field, "valueInteger")) (sourceExtensions ??= []).push(field);
      break;
    case "doseActionIndex":
      if (!doseAction) doseAction = field;
      if (hasFieldMetadata(field, "valueInteger")) (sourceExtensions ??= []).push(field);
      break;
    case "doseArgumentIndex":
      if (!doseArgument) doseArgument = field;
      if (hasFieldMetadata(field, "valueInteger")) (sourceExtensions ??= []).push(field);
      break;
    default: (sourceExtensions ??= []).push(field); break;
  }
  if (resolved?.valueBoolean !== true) return undefined;
  return {
    ...(extension.id !== undefined ? { sourceId: extension.id } : {}),
    ...(sourceExtensions ? { sourceExtensions } : {}),
    ...(administration?.valueInteger !== undefined ? { administrationActionIndex: administration.valueInteger } : {}),
    ...(doseAction?.valueInteger !== undefined && doseArgument?.valueInteger !== undefined
      ? { dose: { actionIndex: doseAction.valueInteger, argumentIndex: doseArgument.valueInteger } } : {})
  };
}

/** One traversal per known graph/action/argument node. Repeated children retain
 * order, first scalar fields retain ownership, and unknown metadata remains
 * outside interpreted clinical meaning. No indexed heap copies or cached
 * input identities are needed to read the same mutable external input again. */
export function parseInstructionGraphExtension<T extends Pick<FhirExtension,"url">>(extensions:readonly T[]|undefined):CanonicalInstructionGraph|undefined {
  let graph:FhirExtension|undefined;
  for(const item of extensions??[])if(item.url===MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL){graph=item as FhirExtension;break;}
  if(!graph)return undefined;
  const actions:AdviceFrame[]=[],relations:CanonicalInstructionRelation[]=[],opaque:CanonicalSourceSpan[]=[];
  let coverage:FhirExtension|undefined,start:FhirExtension|undefined,end:FhirExtension|undefined,
    ownership:FhirExtension|undefined,
    source:FhirExtension|undefined,locale:FhirExtension|undefined,sourceExtensions:FhirExtension[]|undefined;
  for(const field of graph.extension??[])switch(field.url){
    case "action":{const action=parseActionExtension(field);if(action)actions.push(action);break;}
    case "graphRelation":{const relation=parseGraphRelation(field);if(relation)relations.push(relation);break;}
    case "opaque":{const span=parseOpaqueSpan(field);if(span)opaque.push(span);break;}
    case "coverage":if(!coverage)coverage=field;break;
    case "primaryAdministrationStart":if(!start)start=field;break;
    case "primaryAdministrationEnd":if(!end)end=field;break;
    case "primaryOwnership":if(!ownership)ownership=field;break;
    case "sourceText":if(!source)source=field;break;case "sourceLocale":if(!locale)locale=field;break;
    default:(sourceExtensions??=[]).push(field);
  }
  if(!actions.length&&!opaque.length)return undefined;
  const result:CanonicalInstructionGraph={actions,...(sourceExtensions ? {sourceExtensions} : {}),
    ...(ownership ? {primaryOwnership:parsePrimaryOwnership(ownership)} : {}),
    primaryAdministrationSpan:start?.valueInteger!==undefined&&end?.valueInteger!==undefined
    ?{start:start.valueInteger,end:end.valueInteger}:undefined,
    relations:relations.length?relations:undefined,opaqueSpans:opaque.length?opaque:undefined,
    coverage:coverage?parseGraphCoverage(coverage):undefined,sourceText:source?.valueString??"",sourceLocale:locale?.valueCode};
  if(graph.id!==undefined)result.sourceId=graph.id;
  return result;
}
