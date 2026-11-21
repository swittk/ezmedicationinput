import { getQuantityComparator, simpleQuantityForR5 } from "./fhir-quantity-operator";
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
  const displayPrimitive = mergeTranslationPrimitiveElement(value._display, value.i18n);
  // One typed wire value, not a chain of optional fragment objects and
  // transpiled spread-descriptor walks for every Coding in an action graph.
  const result:FhirCoding={};
  if(value.system!==undefined)result.system=value.system;
  if(value.version!==undefined)result.version=value.version;
  if(value.code!==undefined)result.code=value.code;
  if(value._code!==undefined)result._code=value._code;
  if(value.display!==undefined)result.display=value.display;
  if(value.userSelected!==undefined)result.userSelected=value.userSelected;
  if(value._userSelected!==undefined)result._userSelected=value._userSelected;
  if(value.extension?.length)result.extension=value.extension;
  if(displayPrimitive)result._display=displayPrimitive;
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
  extensions: FhirExtension[], name: string, relation: AdviceRelation | undefined
): void {
  if (!relation) return;
  const coding = getAdviceRelationCoding(relation);
  if (coding) add(extensions, valueCoding(`${name}Coding`, coding));
  else add(extensions, valueCode(name, relation));
}

function buildArgumentExtension(argument: AdviceArgument): FhirExtension {
  const nested: FhirExtension[] = [];
  add(nested, valueCode("role", argument.role));
  addRelation(nested, "relation", argument.relation);
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
    nested.push({ url: "component", extension: parts });
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
    // Use the published EMA Coding for an operator, not a private graph code.
    // Exact graph quantities keep their existing wire shape.
    if (argument.quantity.comparator) quantity.push(
      ...(simpleQuantityForR5({ comparator: argument.quantity.comparator })?.extension ?? [])
    );
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
  add(nested, valueCode("polaritySource", frame.polaritySource));
  add(nested, valueCode("modality", frame.modality));
  addRelation(nested, "relation", frame.relation);
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
    nested.push({ url: "predicateComponent", extension: [
      { url: "role", valueCode: part.role },
      { url: "coding", valueCoding: wireCoding(part.coding) }
    ] });
  }
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
    // Formal before/after codes apply to explicitly linked actions, not
    // "before food", "after a symptom", or other unlinked textual adjuncts.
    if ((relation.kind === AdviceRelation.Before || relation.kind === AdviceRelation.After) &&
        relation.fromActionIndex !== undefined) {
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
function parseArgumentExtension(extension:FhirExtension):AdviceArgument|undefined {
  let role:FhirExtension|undefined,text:FhirExtension|undefined,relation:FhirExtension|undefined,
    relationCoding:FhirExtension|undefined,normalized:FhirExtension|undefined,concept:FhirExtension|undefined,
    coding:FhirExtension|undefined,spanStart:FhirExtension|undefined,spanEnd:FhirExtension|undefined,
    quantity:FhirExtension|undefined;
  const codings:FhirCoding[]=[],components:NonNullable<AdviceArgument["components"]>=[];
  let i18n:Record<string,string>|undefined;
  for(const entry of extension.extension??[])switch(entry.url){
    case "role":if(!role)role=entry;break;
    case "text":if(!text)text=entry;break;
    case "relation":if(!relation)relation=entry;break;
    case "relationCoding":if(!relationCoding)relationCoding=entry;break;
    case "normalized":if(!normalized)normalized=entry;break;
    case "conceptId":if(!concept)concept=entry;break;
    case "coding":if(!coding)coding=entry;break;
    case "spanStart":if(!spanStart)spanStart=entry;break;
    case "spanEnd":if(!spanEnd)spanEnd=entry;break;
    case "quantity":if(!quantity)quantity=entry;break;
    case "argumentCoding":{const value=readCoding(entry.valueCoding);if(value)codings.push(value);break;}
    case "translation":{const value=parseTranslationNode(entry);if(value.locale&&value.text)(i18n??={})[value.locale]=value.text;break;}
    case "component":{
      let componentRole:FhirExtension|undefined,componentText:FhirExtension|undefined,componentCoding:FhirExtension|undefined;
      for(const part of entry.extension??[])switch(part.url){
        case "role":if(!componentRole)componentRole=part;break;
        case "text":if(!componentText)componentText=part;break;
        case "coding":if(!componentCoding)componentCoding=part;break;
      }
      const value=componentRole?.valueCode,body=componentText?.valueString;
      if((value==="head"||value==="qualifier"||value==="amount")&&body!==undefined){
        const term=readCoding(componentCoding?.valueCoding);
        components.push({role:value,text:body,...(term?{coding:term}:{})});
      }
      break;
    }
  }
  if(!role?.valueCode||text?.valueString===undefined)return undefined;
  const result:AdviceArgument={role:role.valueCode as AdviceArgumentRole,text:text.valueString,
    relation:firstRelation(relationCoding?.valueCoding,relation?.valueCode),
    normalized:normalized?.valueString,conceptId:concept?.valueString,
    coding:readCoding(coding?.valueCoding),codings};
  if(components.length)result.components=components;
  if(spanStart?.valueInteger!==undefined&&spanEnd?.valueInteger!==undefined)
    result.span={start:spanStart.valueInteger,end:spanEnd.valueInteger};
  if(quantity){
    let value:FhirExtension|undefined,low:FhirExtension|undefined,high:FhirExtension|undefined,unit:FhirExtension|undefined;
    for(const field of quantity.extension??[])switch(field.url){
      case "value":if(!value)value=field;break;case "low":if(!low)low=field;break;
      case "high":if(!high)high=field;break;case "unit":if(!unit)unit=field;break;
    }
    const amount=value?.valueDecimal,lower=low?.valueDecimal,upper=high?.valueDecimal,units=unit?.valueString;
    const comparator=getQuantityComparator(quantity);
    if(amount!==undefined||lower!==undefined||upper!==undefined||units!==undefined||comparator!==undefined)
      result.quantity={value:amount,range:lower!==undefined||upper!==undefined?{low:lower,high:upper}:undefined,
        unit:units,...(comparator?{comparator}:{})};
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
    implicit:FhirExtension|undefined,direct:FhirExtension|undefined;
  const activities:string[]=[],sites:string[]=[];
  for(const field of extension.extension??[])switch(field.url){
    case "locale":if(!locale)locale=field;break;
    case "fallbackObject":if(!fallback)fallback=field;break;
    case "implicitMedicationObject":if(!implicit)implicit=field;break;
    case "directSiteObject":if(!direct)direct=field;break;
    case "suppressActivityConcept":if(field.valueString)activities.push(field.valueString);break;
    case "suppressSiteConcept":if(field.valueString)sites.push(field.valueString);break;
  }
  if(!locale?.valueCode)return undefined;
  return {locale:locale.valueCode,config:{fallbackObject:fallback?.valueString,
    implicitMedicationObject:implicit?.valueBoolean,directSiteObject:direct?.valueBoolean,
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
  for(const field of extension.extension??[])switch(field.url){
    case "predicateLemma":if(!lemma)lemma=field;break;
    case "spanStart":if(!start)start=field;break;case "spanEnd":if(!end)end=field;break;
    case "sourceText":if(!source)source=field;break;case "force":if(!force)force=field;break;
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
      let role:FhirExtension|undefined,coding:FhirExtension|undefined;
      for(const part of field.extension??[])switch(part.url){case "role":if(!role)role=part;break;case "coding":if(!coding)coding=part;break;}
      const value=role?.valueCode,code=readCoding(coding?.valueCoding);
      if((value==="activity"||value==="technique"||value==="target-state"||value==="target-site"||
        value==="target-object"||value==="operation"||value==="orientation"||value==="mechanism"||value==="situation")&&code?.system&&code.code)
        semanticComponents.push({role:value,coding:code});
      break;
    }
  }
  if(!lemma?.valueString||start?.valueInteger===undefined||end?.valueInteger===undefined||source?.valueString===undefined||!force?.valueCode)return undefined;
  if(legacyFallback?.valueString||legacyActivities.length){
    locales??={};locales.th={...locales.th,fallbackObject:legacyFallback?.valueString??locales.th?.fallbackObject,
      suppressActivityConcepts:legacyActivities.length?legacyActivities:locales.th?.suppressActivityConcepts};
  }
  return {force:force.valueCode as AdviceForce,origin:origin?.valueCode as AdviceFrame["origin"],
    confidence:confidence?.valueDecimal,polarity:polarity?.valueCode as AdvicePolarity,
    polaritySource:polaritySource?.valueCode==="shared"?"shared":undefined,
    modality:modality?.valueCode as AdviceModality,relation:firstRelation(relationCoding?.valueCoding,relation?.valueCode),
    predicate:{lemma:lemma.valueString,display:display?.valueString,i18n:translations,
      semanticClass:semanticClass?.valueString,realizer:realizer?.valueCode as AdviceFrame["predicate"]["realizer"],
      realizerConfig:locales?{locales}:undefined,codings,...(semanticComponents.length?{semanticComponents}:{})},
    args,span:{start:start.valueInteger,end:end.valueInteger},sourceText:source.valueString,sequenceIndex:sequence?.valueInteger};
}

function parseGraphRelation(extension:FhirExtension):CanonicalInstructionRelation|undefined {
  let coding:FhirExtension|undefined,kind:FhirExtension|undefined,to:FhirExtension|undefined,from:FhirExtension|undefined,
    start:FhirExtension|undefined,end:FhirExtension|undefined,text:FhirExtension|undefined;
  for(const field of extension.extension??[])switch(field.url){
    case "kindCoding":if(!coding)coding=field;break;case "kind":if(!kind)kind=field;break;
    case "toActionIndex":if(!to)to=field;break;case "fromActionIndex":if(!from)from=field;break;
    case "spanStart":if(!start)start=field;break;case "spanEnd":if(!end)end=field;break;
    case "text":if(!text)text=field;break;
  }
  const value=coding?.valueCoding;
  const relation=value?.system==="http://hl7.org/fhir/action-relationship-type"&&(value.code==="before"||value.code==="after")
    ? value.code as AdviceRelation:firstRelation(value,kind?.valueCode);
  if(!relation||to?.valueInteger===undefined)return undefined;
  return {kind:relation,fromActionIndex:from?.valueInteger,toActionIndex:to.valueInteger,text:text?.valueString,
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

/** One traversal per known graph/action/argument node. Repeated children retain
 * order, first scalar fields retain ownership, and unknown metadata remains
 * outside interpreted clinical meaning. No indexed heap copies or cached
 * input identities are needed to read the same mutable external input again. */
export function parseInstructionGraphExtension(extensions:FhirExtension[]|undefined):CanonicalInstructionGraph|undefined {
  let graph:FhirExtension|undefined;
  for(const item of extensions??[])if(item.url===MEDICATION_INSTRUCTION_GRAPH_EXTENSION_URL){graph=item;break;}
  if(!graph)return undefined;
  const actions:AdviceFrame[]=[],relations:CanonicalInstructionRelation[]=[],opaque:CanonicalSourceSpan[]=[];
  let coverage:FhirExtension|undefined,start:FhirExtension|undefined,end:FhirExtension|undefined,
    source:FhirExtension|undefined,locale:FhirExtension|undefined;
  for(const field of graph.extension??[])switch(field.url){
    case "action":{const action=parseActionExtension(field);if(action)actions.push(action);break;}
    case "graphRelation":{const relation=parseGraphRelation(field);if(relation)relations.push(relation);break;}
    case "opaque":{const span=parseOpaqueSpan(field);if(span)opaque.push(span);break;}
    case "coverage":if(!coverage)coverage=field;break;
    case "primaryAdministrationStart":if(!start)start=field;break;
    case "primaryAdministrationEnd":if(!end)end=field;break;
    case "sourceText":if(!source)source=field;break;case "sourceLocale":if(!locale)locale=field;break;
  }
  if(!actions.length&&!opaque.length)return undefined;
  return {actions,primaryAdministrationSpan:start?.valueInteger!==undefined&&end?.valueInteger!==undefined
    ?{start:start.valueInteger,end:end.valueInteger}:undefined,
    relations:relations.length?relations:undefined,opaqueSpans:opaque.length?opaque:undefined,
    coverage:coverage?parseGraphCoverage(coverage):undefined,sourceText:source?.valueString??"",sourceLocale:locale?.valueCode};
}
