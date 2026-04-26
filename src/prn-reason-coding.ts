import { collectParsedBodySiteCandidates } from "./body-site-resolution";
import { cloneExtensions } from "./fhir-translations";
import {
  buildSnomedFindingSiteCoding,
  hasSnomedFindingSitePostcoordination
} from "./snomed-postcoordination";
import {
  DEFAULT_PRN_REASON_DEFINITIONS,
  DEFAULT_PRN_REASON_ENTRIES,
  normalizePrnReasonKey
} from "./maps";
import { ParserState } from "./parser-state";
import {
  FhirCoding,
  ParseOptions,
  PrnReasonDefinition,
  PrnReasonLookupRequest,
  PrnReasonSelection,
  PrnReasonSuggestion,
  PrnReasonSuggestionsResult,
  RouteCode
} from "./types";
import { arrayIncludes } from "./utils/array";
import { objectEntries } from "./utils/object";

const SNOMED_SYSTEM = "http://snomed.info/sct";

const GENERIC_ITCH_REASON_TERMS = new Set([
  "itch",
  "itching",
  "itchiness",
  "itchy",
  "คัน"
]);

const OPHTHALMIC_ROUTE_CODES = new Set<RouteCode>([
  RouteCode["Ophthalmic route"],
  RouteCode["Ocular route (qualifier value)"],
  RouteCode["Intravitreal route (qualifier value)"]
]);

/**
 * Resolves parsed PRN reason text against SNOMED dictionaries and synchronous
 * callbacks, applying the best match to the in-progress parse result.
 */
export function applyPrnReasonCoding(
  internal: ParserState,
  options?: ParseOptions
): void {
  runPrnReasonResolutionSync(internal, options);
}

export async function applyPrnReasonCodingAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  await runPrnReasonResolutionAsync(internal, options);
}

function buildCombinedPrnReasonCanonical(
  request: PrnReasonLookupRequest
): string | undefined {
  if (!request.locativeSiteCanonical || !request.headCanonical) {
    return undefined;
  }
  return normalizePrnReasonKey(`${request.locativeSiteCanonical} ${request.headCanonical}`);
}

function collectPrnReasonLookupCanonicals(request: PrnReasonLookupRequest): string[] {
  const canonicals: string[] = [];
  const seen = new Set<string>();
  const pushCanonical = (value: string | undefined) => {
    const normalized = normalizePrnReasonKey(value ?? "");
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    canonicals.push(normalized);
  };

  pushCanonical(request.canonical);
  pushCanonical(buildCombinedPrnReasonCanonical(request));
  pushCanonical(request.headCanonical);

  return canonicals;
}

function buildPostcoordinatedPrnReasonDefinition(
  request: PrnReasonLookupRequest,
  definition: PrnReasonDefinition | undefined,
  hasExactCombinedDefinition: boolean
): PrnReasonDefinition | undefined {
  if (
    hasExactCombinedDefinition ||
    !definition?.coding?.code ||
    hasSnomedFindingSitePostcoordination(definition.coding.code) ||
    !request.headCanonical ||
    !request.locativeSiteCoding?.code
  ) {
    return definition;
  }

  const coding = buildSnomedFindingSiteCoding({
    focusCoding: definition.coding,
    siteCoding: request.locativeSiteCoding,
    display: request.text,
    spatialRelation: request.locativeSiteSpatialRelation
  });
  if (!coding) {
    return definition;
  }

  return {
    ...definition,
    coding
  };
}

function lookupPrnReasonDefinition(
  map: Record<string, PrnReasonDefinition> | undefined,
  canonical: string | string[]
): PrnReasonDefinition | undefined {
  if (!map) {
    return undefined;
  }
  const canonicals = Array.isArray(canonical)
    ? canonical.map((value) => normalizePrnReasonKey(value)).filter(Boolean) as string[]
    : [normalizePrnReasonKey(canonical)].filter(Boolean) as string[];
  for (const key of canonicals) {
    const direct = map[key];
    if (direct) {
      return direct;
    }
  }
  for (const [key, definition] of objectEntries(map)) {
    const normalizedKey = normalizePrnReasonKey(key);
    if (arrayIncludes(canonicals, normalizedKey)) {
      return definition;
    }
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        if (arrayIncludes(canonicals, normalizePrnReasonKey(alias))) {
          return definition;
        }
      }
    }
  }
  return undefined;
}

function lookupDefaultPrnReasonDefinition(
  canonical: string | string[]
): PrnReasonDefinition | undefined {
  const canonicals = Array.isArray(canonical)
    ? canonical.map((value) => normalizePrnReasonKey(value)).filter(Boolean) as string[]
    : [normalizePrnReasonKey(canonical)].filter(Boolean) as string[];
  for (const normalized of canonicals) {
    const definition = DEFAULT_PRN_REASON_DEFINITIONS[normalized];
    if (definition) {
      return definition;
    }
  }
  return undefined;
}

function inferSiteSpecificPrnReasonDefinition(
  internal: ParserState,
  request: PrnReasonLookupRequest
): PrnReasonDefinition | undefined {
  const normalizedRequest = normalizePrnReasonKey(request.text);
  if (!normalizedRequest || !GENERIC_ITCH_REASON_TERMS.has(normalizedRequest)) {
    return undefined;
  }

  const siteCandidates = collectParsedBodySiteCandidates(internal);
  const isOcularSite =
    (internal.routeCode !== undefined && OPHTHALMIC_ROUTE_CODES.has(internal.routeCode)) ||
    siteCandidates.normalizedSiteText.includes("eye") ||
    siteCandidates.normalizedSiteCodingDisplay.includes("eye");
  if (isOcularSite) {
    return lookupDefaultPrnReasonDefinition("eye itch");
  }

  const isLesionSite =
    siteCandidates.normalizedSiteText.includes("lesion") ||
    siteCandidates.normalizedSiteCodingDisplay.includes("lesion");
  if (isLesionSite) {
    return lookupDefaultPrnReasonDefinition("lesion itch");
  }

  for (const siteCanonical of siteCandidates.canonicals) {
    const exactDefinition = lookupDefaultPrnReasonDefinition(`${siteCanonical} itch`);
    if (exactDefinition) {
      return exactDefinition;
    }
  }

  const siteCoding = siteCandidates.codings[0];
  if (!siteCoding?.code) {
    return undefined;
  }
  const syntheticRequest: PrnReasonLookupRequest = {
    ...request,
    headCanonical: normalizePrnReasonKey("itch"),
    locativeSiteCanonical: siteCandidates.canonicals[0],
    locativeSiteCoding: siteCoding
  };
  return buildPostcoordinatedPrnReasonDefinition(
    syntheticRequest,
    lookupDefaultPrnReasonDefinition("itch"),
    false
  );
}

function pickPrnReasonSelection(
  selections: PrnReasonSelection | PrnReasonSelection[] | undefined,
  request: PrnReasonLookupRequest
): PrnReasonDefinition | undefined {
  if (!selections) {
    return undefined;
  }
  const canonicals = collectPrnReasonLookupCanonicals(request);
  const normalizedText = normalizePrnReasonKey(request.text);
  const requestRange = request.range;
  for (const selection of toArray(selections)) {
    if (!selection) {
      continue;
    }
    let matched = false;
    if (selection.range) {
      if (!requestRange) {
        continue;
      }
      if (
        selection.range.start !== requestRange.start ||
        selection.range.end !== requestRange.end
      ) {
        continue;
      }
      matched = true;
    }
    if (selection.canonical) {
      if (!arrayIncludes(canonicals, normalizePrnReasonKey(selection.canonical))) {
        continue;
      }
      matched = true;
    } else if (selection.text) {
      const normalizedSelection = normalizePrnReasonKey(selection.text);
      if (!arrayIncludes(canonicals, normalizedSelection) && normalizedSelection !== normalizedText) {
        continue;
      }
      matched = true;
    }
    if (!selection.range && !selection.canonical && !selection.text) {
      continue;
    }
    if (matched) {
      return selection.resolution;
    }
  }
  return undefined;
}

function applyPrnReasonDefinition(
  internal: ParserState,
  definition: PrnReasonDefinition
) {
  const coding = definition.coding;
  internal.asNeededReasonCoding = coding?.code
    ? {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM,
      extension: cloneExtensions(coding.extension),
      i18n: definition?.i18n
    }
    : undefined;
  if (definition.text && !internal.asNeededReason) {
    internal.asNeededReason = definition.text;
  }
}

function createPrnReasonLookupRequestFromText(
  internal: ParserState,
  text: string
): PrnReasonLookupRequest {
  const normalized = text.toLowerCase();
  const canonical = normalizePrnReasonKey(text);
  return {
    originalText: text,
    text,
    normalized,
    canonical: canonical ?? "",
    headCanonical: undefined,
    locativeSiteCanonical: undefined,
    locativeSiteCoding: undefined,
    isProbe: false,
    inputText: internal.input,
    sourceText: text,
    range: undefined
  };
}

function resolvePrnReasonDefinitionSyncForRequest(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  options?: ParseOptions
): PrnReasonDefinition | undefined {
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  if (selection) {
    return selection;
  }
  const canonicals = collectPrnReasonLookupCanonicals(request);
  const exactCustomDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical);
  const exactDefaultDefinition = lookupDefaultPrnReasonDefinition(request.canonical);
  const combinedCanonical = buildCombinedPrnReasonCanonical(request);
  const hasExactCombinedDefinition = Boolean(
    exactCustomDefinition ||
    exactDefaultDefinition ||
    (combinedCanonical && (
      lookupPrnReasonDefinition(options?.prnReasonMap, combinedCanonical) ||
      lookupDefaultPrnReasonDefinition(combinedCanonical)
    ))
  );
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonicals);
  if (customDefinition) {
    return buildPostcoordinatedPrnReasonDefinition(
      request,
      customDefinition,
      hasExactCombinedDefinition
    );
  }
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  if (inferredDefinition) {
    return inferredDefinition;
  }
  for (const resolver of toArray(options?.prnReasonResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "PRN reason resolver returned a Promise; use parseSigAsync for asynchronous PRN reason resolution."
      );
    }
    if (result) {
      return result;
    }
  }
  return buildPostcoordinatedPrnReasonDefinition(
    request,
    lookupDefaultPrnReasonDefinition(canonicals),
    hasExactCombinedDefinition
  );
}

async function resolvePrnReasonDefinitionAsyncForRequest(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  options?: ParseOptions
): Promise<PrnReasonDefinition | undefined> {
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  if (selection) {
    return selection;
  }
  const canonicals = collectPrnReasonLookupCanonicals(request);
  const exactCustomDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical);
  const exactDefaultDefinition = lookupDefaultPrnReasonDefinition(request.canonical);
  const combinedCanonical = buildCombinedPrnReasonCanonical(request);
  const hasExactCombinedDefinition = Boolean(
    exactCustomDefinition ||
    exactDefaultDefinition ||
    (combinedCanonical && (
      lookupPrnReasonDefinition(options?.prnReasonMap, combinedCanonical) ||
      lookupDefaultPrnReasonDefinition(combinedCanonical)
    ))
  );
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonicals);
  if (customDefinition) {
    return buildPostcoordinatedPrnReasonDefinition(
      request,
      customDefinition,
      hasExactCombinedDefinition
    );
  }
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  if (inferredDefinition) {
    return inferredDefinition;
  }
  for (const resolver of toArray(options?.prnReasonResolvers)) {
    const result = await resolver(request);
    if (result) {
      return result;
    }
  }
  return buildPostcoordinatedPrnReasonDefinition(
    request,
    lookupDefaultPrnReasonDefinition(canonicals),
    hasExactCombinedDefinition
  );
}

function splitCoordinatedPrnReasonText(text: string): string[] | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  const patterns = [
    /\s+and\/or\s+/i,
    /\s+หรือ\s+/,
    /\s+or\s+/i,
    /\s+และ\s+/,
    /\s+and\s+/i,
    /\s*\/\s*/,
    /\s*,\s*/
  ];
  for (const pattern of patterns) {
    const parts = trimmed.split(pattern).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts;
    }
  }
  return undefined;
}

function maybeApplyCoordinatedPrnReasonsSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  const text = internal.asNeededReason;
  if (!text || internal.asNeededReasonCoding) {
    return;
  }
  const parts = splitCoordinatedPrnReasonText(text);
  if (!parts || parts.length < 2) {
    return;
  }
  const reasons = [];
  for (const part of parts) {
    const request = createPrnReasonLookupRequestFromText(internal, part);
    const definition = resolvePrnReasonDefinitionSyncForRequest(internal, request, options);
    reasons.push({
      text: part,
      coding: definition?.coding?.code
        ? {
          code: definition.coding.code,
          display: definition.coding.display,
          system: definition.coding.system ?? SNOMED_SYSTEM,
          extension: cloneExtensions(definition.coding.extension),
          i18n: definition.i18n
        }
        : undefined
    });
  }
  internal.asNeededReasons = reasons;
}

async function maybeApplyCoordinatedPrnReasonsAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  const text = internal.asNeededReason;
  if (!text || internal.asNeededReasonCoding) {
    return;
  }
  const parts = splitCoordinatedPrnReasonText(text);
  if (!parts || parts.length < 2) {
    return;
  }
  const reasons = [];
  for (const part of parts) {
    const request = createPrnReasonLookupRequestFromText(internal, part);
    const definition = await resolvePrnReasonDefinitionAsyncForRequest(internal, request, options);
    reasons.push({
      text: part,
      coding: definition?.coding?.code
        ? {
          code: definition.coding.code,
          display: definition.coding.display,
          system: definition.coding.system ?? SNOMED_SYSTEM,
          extension: cloneExtensions(definition.coding.extension),
          i18n: definition.i18n
        }
        : undefined
    });
  }
  internal.asNeededReasons = reasons;
}

function uniquePrnReasonRequests(
  requests: PrnReasonLookupRequest[] | undefined
): PrnReasonLookupRequest[] {
  const result: PrnReasonLookupRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests ?? []) {
    const key = `${request.range?.start ?? ""}:${request.range?.end ?? ""}:${request.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(request);
  }
  return result;
}

function codingFromPrnDefinition(
  definition: PrnReasonDefinition | undefined
): (FhirCoding & { i18n?: Record<string, string> }) | undefined {
  const coding = definition?.coding;
  return coding?.code
    ? {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM,
      extension: cloneExtensions(coding.extension),
      i18n: definition?.i18n
    }
    : undefined;
}

function joinPrnReasonTexts(reasons: Array<{ text?: string }>): string | undefined {
  const texts = reasons
    .map((reason) => reason.text?.trim())
    .filter((text): text is string => Boolean(text));
  switch (texts.length) {
    case 0:
      return undefined;
    case 1:
      return texts[0];
    case 2:
      return `${texts[0]} or ${texts[1]}`;
    default:
      return `${texts.slice(0, -1).join(", ")} or ${texts[texts.length - 1]}`;
  }
}

function collectSuggestionsForRequestSync(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  resolution: PrnReasonDefinition | undefined,
  options?: ParseOptions
): void {
  if (!request.isProbe && resolution) {
    return;
  }
  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (resolution) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(resolution));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }
  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "PRN reason suggestion resolver returned a Promise; use parseSigAsync for asynchronous PRN reason suggestions."
      );
    }
    collectReasonSuggestionResult(suggestionMap, result);
  }
  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

async function collectSuggestionsForRequestAsync(
  internal: ParserState,
  request: PrnReasonLookupRequest,
  resolution: PrnReasonDefinition | undefined,
  options?: ParseOptions
): Promise<void> {
  if (!request.isProbe && resolution) {
    return;
  }
  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (resolution) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(resolution));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }
  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = await resolver(request);
    collectReasonSuggestionResult(suggestionMap, result);
  }
  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

function runMultiplePrnReasonResolutionSync(
  internal: ParserState,
  requests: PrnReasonLookupRequest[],
  options?: ParseOptions
): void {
  internal.prnReasonLookups = [];
  internal.asNeeded = true;
  const reasons = [];
  for (const request of requests) {
    const definition = resolvePrnReasonDefinitionSyncForRequest(internal, request, options);
    reasons.push({
      text: request.text,
      spatialRelation: request.locativeSiteSpatialRelation,
      coding: codingFromPrnDefinition(definition)
    });
    collectSuggestionsForRequestSync(internal, request, definition, options);
  }
  internal.asNeededReasons = reasons;
  internal.asNeededReason = joinPrnReasonTexts(reasons);
  if (reasons.length === 1) {
    internal.asNeededReasonCoding = reasons[0]?.coding;
  } else {
    internal.asNeededReasonCoding = undefined;
  }
}

async function runMultiplePrnReasonResolutionAsync(
  internal: ParserState,
  requests: PrnReasonLookupRequest[],
  options?: ParseOptions
): Promise<void> {
  internal.prnReasonLookups = [];
  internal.asNeeded = true;
  const reasons = [];
  for (const request of requests) {
    const definition = await resolvePrnReasonDefinitionAsyncForRequest(internal, request, options);
    reasons.push({
      text: request.text,
      spatialRelation: request.locativeSiteSpatialRelation,
      coding: codingFromPrnDefinition(definition)
    });
    await collectSuggestionsForRequestAsync(internal, request, definition, options);
  }
  internal.asNeededReasons = reasons;
  internal.asNeededReason = joinPrnReasonTexts(reasons);
  if (reasons.length === 1) {
    internal.asNeededReasonCoding = reasons[0]?.coding;
  } else {
    internal.asNeededReasonCoding = undefined;
  }
}

function definitionToPrnSuggestion(
  definition: PrnReasonDefinition
): PrnReasonSuggestion {
  return {
    coding: definition.coding?.code
      ? {
        code: definition.coding.code,
        display: definition.coding.display,
        system: definition.coding.system ?? SNOMED_SYSTEM,
        extension: cloneExtensions(definition.coding.extension)
      }
      : undefined,
    text: definition.text ?? definition.coding?.display
  };
}

function addReasonSuggestionToMap(
  map: Map<string, PrnReasonSuggestion>,
  suggestion: PrnReasonSuggestion | undefined
) {
  if (!suggestion) {
    return;
  }
  const coding = suggestion.coding;
  const key = coding?.code
    ? `${coding.system ?? SNOMED_SYSTEM}|${coding.code}`
    : suggestion.text
      ? `text:${suggestion.text.toLowerCase()}`
      : undefined;
  if (!key || map.has(key)) {
    return;
  }
  map.set(key, suggestion);
}

function collectReasonSuggestionResult(
  map: Map<string, PrnReasonSuggestion>,
  result:
    | PrnReasonSuggestionsResult
    | PrnReasonSuggestion[]
    | PrnReasonSuggestion
    | null
    | undefined
) {
  if (!result) {
    return;
  }
  const suggestions = Array.isArray(result)
    ? result
    : typeof result === "object" && "suggestions" in result
      ? (result as PrnReasonSuggestionsResult).suggestions
      : [result];
  for (const suggestion of suggestions) {
    addReasonSuggestionToMap(map, suggestion);
  }
}

function collectDefaultPrnReasonDefinitions(
  request: PrnReasonLookupRequest
): PrnReasonDefinition[] {
  const canonicals = collectPrnReasonLookupCanonicals(request);
  const normalized = request.normalized;
  const seen = new Set<PrnReasonDefinition>();
  for (const entry of DEFAULT_PRN_REASON_ENTRIES) {
    if (!entry.canonical) {
      continue;
    }
    if (
      arrayIncludes(canonicals, entry.canonical) ||
      canonicals.some((canonical) =>
        entry.canonical.includes(canonical) || canonical.includes(entry.canonical)
      )
    ) {
      seen.add(entry.definition);
      continue;
    }
    for (const term of entry.terms) {
      const normalizedTerm = normalizePrnReasonKey(term);
      if (!normalizedTerm) {
        continue;
      }
      if (canonicals.some((canonical) => canonical.includes(normalizedTerm))) {
        seen.add(entry.definition);
        break;
      }
      if (normalized.includes(normalizedTerm)) {
        seen.add(entry.definition);
        break;
      }
    }
  }
  if (!seen.size) {
    for (const entry of DEFAULT_PRN_REASON_ENTRIES) {
      seen.add(entry.definition);
    }
  }
  return Array.from(seen);
}

function runPrnReasonResolutionSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  const requests = uniquePrnReasonRequests(internal.prnReasonLookupRequests);
  if (requests.length) {
    runMultiplePrnReasonResolutionSync(internal, requests, options);
    return;
  }

  internal.prnReasonLookups = [];
  const request = internal.prnReasonLookupRequest;
  if (!request) {
    return;
  }

  const canonicals = collectPrnReasonLookupCanonicals(request);
  const combinedCanonical = buildCombinedPrnReasonCanonical(request);
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  const exactCustomDefinition =
    lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical) ??
    lookupPrnReasonDefinition(options?.prnReasonMap, combinedCanonical ?? "");
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonicals);
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.prnReasonResolvers)) {
      const result = resolver(request);
      if (isPromise(result)) {
        throw new Error(
          "PRN reason resolver returned a Promise; use parseSigAsync for asynchronous PRN reason resolution."
        );
      }
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const exactDefaultDefinition =
    lookupDefaultPrnReasonDefinition(request.canonical) ??
    lookupDefaultPrnReasonDefinition(combinedCanonical ?? "");
  const hasExactCombinedDefinition = Boolean(exactCustomDefinition || exactDefaultDefinition);
  const defaultDefinition = buildPostcoordinatedPrnReasonDefinition(
    request,
    lookupDefaultPrnReasonDefinition(canonicals),
    hasExactCombinedDefinition
  );
  if (!resolution && inferredDefinition) {
    resolution = inferredDefinition;
  }
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }
  resolution = buildPostcoordinatedPrnReasonDefinition(
    request,
    resolution,
    hasExactCombinedDefinition
  );

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
    if (request.locativeSiteSpatialRelation && internal.primaryClause.prn?.reason) {
      internal.primaryClause.prn.reason.spatialRelation = request.locativeSiteSpatialRelation;
    }
  } else {
    internal.asNeededReasonCoding = undefined;
  }
  maybeApplyCoordinatedPrnReasonsSync(internal, options);

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (selection) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(selection));
  }
  if (customDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(customDefinition));
  }
  if (inferredDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(inferredDefinition));
  }
  if (defaultDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(defaultDefinition));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }

  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "PRN reason suggestion resolver returned a Promise; use parseSigAsync for asynchronous PRN reason suggestions."
      );
    }
    collectReasonSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

async function runPrnReasonResolutionAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  const requests = uniquePrnReasonRequests(internal.prnReasonLookupRequests);
  if (requests.length) {
    await runMultiplePrnReasonResolutionAsync(internal, requests, options);
    return;
  }

  internal.prnReasonLookups = [];
  const request = internal.prnReasonLookupRequest;
  if (!request) {
    return;
  }

  const canonicals = collectPrnReasonLookupCanonicals(request);
  const combinedCanonical = buildCombinedPrnReasonCanonical(request);
  const selection = pickPrnReasonSelection(options?.prnReasonSelections, request);
  const exactCustomDefinition =
    lookupPrnReasonDefinition(options?.prnReasonMap, request.canonical) ??
    lookupPrnReasonDefinition(options?.prnReasonMap, combinedCanonical ?? "");
  const customDefinition = lookupPrnReasonDefinition(options?.prnReasonMap, canonicals);
  const inferredDefinition = inferSiteSpecificPrnReasonDefinition(internal, request);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.prnReasonResolvers)) {
      const result = await resolver(request);
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const exactDefaultDefinition =
    lookupDefaultPrnReasonDefinition(request.canonical) ??
    lookupDefaultPrnReasonDefinition(combinedCanonical ?? "");
  const hasExactCombinedDefinition = Boolean(exactCustomDefinition || exactDefaultDefinition);
  const defaultDefinition = buildPostcoordinatedPrnReasonDefinition(
    request,
    lookupDefaultPrnReasonDefinition(canonicals),
    hasExactCombinedDefinition
  );
  if (!resolution && inferredDefinition) {
    resolution = inferredDefinition;
  }
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }
  resolution = buildPostcoordinatedPrnReasonDefinition(
    request,
    resolution,
    hasExactCombinedDefinition
  );

  if (resolution) {
    applyPrnReasonDefinition(internal, resolution);
    if (request.locativeSiteSpatialRelation && internal.primaryClause.prn?.reason) {
      internal.primaryClause.prn.reason.spatialRelation = request.locativeSiteSpatialRelation;
    }
  } else {
    internal.asNeededReasonCoding = undefined;
  }
  await maybeApplyCoordinatedPrnReasonsAsync(internal, options);

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, PrnReasonSuggestion>();
  if (selection) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(selection));
  }
  if (customDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(customDefinition));
  }
  if (inferredDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(inferredDefinition));
  }
  if (defaultDefinition) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(defaultDefinition));
  }
  for (const definition of collectDefaultPrnReasonDefinitions(request)) {
    addReasonSuggestionToMap(suggestionMap, definitionToPrnSuggestion(definition));
  }

  for (const resolver of toArray(options?.prnReasonSuggestionResolvers)) {
    const result = await resolver(request);
    collectReasonSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.prnReasonLookups.push({ request, suggestions });
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}
