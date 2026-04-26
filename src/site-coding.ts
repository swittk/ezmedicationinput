import { DEFAULT_BODY_SITE_SNOMED, normalizeBodySiteKey } from "./maps";
import { ParserState } from "./parser-state";
import {
  BodySiteDefinition,
  ParseOptions,
  SiteCodeLookupRequest,
  SiteCodeSelection,
  SiteCodeSuggestion,
  SiteCodeSuggestionsResult
} from "./types";
import { objectEntries } from "./utils/object";

const SNOMED_SYSTEM = "http://snomed.info/sct";

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

export function applySiteCoding(
  internal: ParserState,
  options?: ParseOptions
): void {
  runSiteCodingResolutionSync(internal, options);
}

export async function applySiteCodingAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  await runSiteCodingResolutionAsync(internal, options);
}

function runSiteCodingResolutionSync(
  internal: ParserState,
  options?: ParseOptions
): void {
  internal.siteLookups = [];
  const request = internal.siteLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickSiteSelection(options?.siteCodeSelections, request);
  const customDefinition = lookupBodySiteDefinition(options?.siteCodeMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.siteCodeResolvers)) {
      const result = resolver(request);
      if (isPromise(result)) {
        throw new Error(
          "Site code resolver returned a Promise; use parseSigAsync for asynchronous site resolution."
        );
      }
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_BODY_SITE_SNOMED[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applySiteDefinition(internal, resolution);
  } else {
    internal.siteCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, SiteCodeSuggestion>();
  if (selection) {
    addSuggestionToMap(
      suggestionMap,
      definitionToSuggestion(selection, selection === defaultDefinition)
    );
  }
  if (customDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(defaultDefinition, true));
  }

  for (const resolver of toArray(options?.siteCodeSuggestionResolvers)) {
    const result = resolver(request);
    if (isPromise(result)) {
      throw new Error(
        "Site code suggestion resolver returned a Promise; use parseSigAsync for asynchronous site suggestions."
      );
    }
    collectSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.siteLookups.push({ request, suggestions });
  }
}

async function runSiteCodingResolutionAsync(
  internal: ParserState,
  options?: ParseOptions
): Promise<void> {
  internal.siteLookups = [];
  const request = internal.siteLookupRequest;
  if (!request) {
    return;
  }

  const canonical = request.canonical;
  const selection = pickSiteSelection(options?.siteCodeSelections, request);
  const customDefinition = lookupBodySiteDefinition(options?.siteCodeMap, canonical);
  let resolution = selection ?? customDefinition;

  if (!resolution) {
    for (const resolver of toArray(options?.siteCodeResolvers)) {
      const result = await resolver(request);
      if (result) {
        resolution = result;
        break;
      }
    }
  }

  const defaultDefinition = canonical ? DEFAULT_BODY_SITE_SNOMED[canonical] : undefined;
  if (!resolution && defaultDefinition) {
    resolution = defaultDefinition;
  }

  if (resolution) {
    applySiteDefinition(internal, resolution);
  } else {
    internal.siteCoding = undefined;
  }

  const needsSuggestions = request.isProbe || !resolution;
  if (!needsSuggestions) {
    return;
  }

  const suggestionMap = new Map<string, SiteCodeSuggestion>();
  if (selection) {
    addSuggestionToMap(
      suggestionMap,
      definitionToSuggestion(selection, selection === defaultDefinition)
    );
  }
  if (customDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(customDefinition));
  }
  if (defaultDefinition) {
    addSuggestionToMap(suggestionMap, definitionToSuggestion(defaultDefinition, true));
  }

  for (const resolver of toArray(options?.siteCodeSuggestionResolvers)) {
    const result = await resolver(request);
    collectSuggestionResult(suggestionMap, result);
  }

  const suggestions = Array.from(suggestionMap.values());
  if (suggestions.length || request.isProbe) {
    internal.siteLookups.push({ request, suggestions });
  }
}

export function lookupBodySiteDefinition(
  map: Record<string, BodySiteDefinition> | undefined,
  canonical: string
): BodySiteDefinition | undefined {
  if (!map) {
    return undefined;
  }
  const direct = map[canonical];
  if (direct) {
    return direct;
  }
  for (const [key, definition] of objectEntries(map)) {
    if (normalizeBodySiteKey(key) === canonical) {
      return definition;
    }
    if (definition.aliases) {
      for (const alias of definition.aliases) {
        if (normalizeBodySiteKey(alias) === canonical) {
          return definition;
        }
      }
    }
  }
  return undefined;
}

function pickSiteSelection(
  selections: SiteCodeSelection | SiteCodeSelection[] | undefined,
  request: SiteCodeLookupRequest
): BodySiteDefinition | undefined {
  if (!selections) {
    return undefined;
  }
  const canonical = request.canonical;
  const normalizedText = normalizeBodySiteKey(request.text);
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
      if (normalizeBodySiteKey(selection.canonical) !== canonical) {
        continue;
      }
      matched = true;
    } else if (selection.text) {
      const normalizedSelection = normalizeBodySiteKey(selection.text);
      if (normalizedSelection !== canonical && normalizedSelection !== normalizedText) {
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

function applySiteDefinition(internal: ParserState, definition: BodySiteDefinition): void {
  const coding = definition.coding;
  internal.siteCoding = coding?.code
    ? {
        code: coding.code,
        display: coding.display,
        system: coding.system ?? SNOMED_SYSTEM
      }
    : undefined;
  if (definition.text) {
    internal.siteText = definition.text;
  } else if (internal.siteLookupRequest?.text) {
    internal.siteText = internal.siteLookupRequest.text;
  }
  if (definition.spatialRelation) {
    internal.siteSpatialRelation = definition.spatialRelation;
  } else if (internal.siteLookupRequest?.spatialRelation) {
    internal.siteSpatialRelation = internal.siteLookupRequest.spatialRelation;
  }
}

function definitionToSuggestion(
  definition: BodySiteDefinition,
  omitRedundantText = false
): SiteCodeSuggestion | undefined {
  const coding = definition.coding;
  if (!coding?.code) {
    return undefined;
  }
  const text =
    omitRedundantText &&
    definition.text &&
    definition.text.trim().toLowerCase() !== coding.display?.trim().toLowerCase()
      ? definition.text
      : omitRedundantText
        ? undefined
        : definition.text;
  return {
    coding: {
      code: coding.code,
      display: coding.display,
      system: coding.system ?? SNOMED_SYSTEM
    },
    text
  };
}

function addSuggestionToMap(
  map: Map<string, SiteCodeSuggestion>,
  suggestion: SiteCodeSuggestion | undefined
): void {
  if (!suggestion) {
    return;
  }
  const coding = suggestion.coding;
  if (!coding?.code) {
    return;
  }
  const key = `${coding.system ?? SNOMED_SYSTEM}|${coding.code}`;
  if (!map.has(key)) {
    map.set(key, {
      coding: {
        code: coding.code,
        display: coding.display,
        system: coding.system ?? SNOMED_SYSTEM
      },
      text: suggestion.text
    });
  }
}

function collectSuggestionResult(
  map: Map<string, SiteCodeSuggestion>,
  result:
    | SiteCodeSuggestionsResult
    | SiteCodeSuggestion[]
    | SiteCodeSuggestion
    | null
    | undefined
): void {
  if (!result) {
    return;
  }
  const suggestions = Array.isArray(result)
    ? result
    : typeof result === "object" && "suggestions" in result
      ? (result as SiteCodeSuggestionsResult).suggestions
      : [result];
  for (const suggestion of suggestions) {
    addSuggestionToMap(map, suggestion);
  }
}
