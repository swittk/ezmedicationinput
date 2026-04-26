# ezmedicationinput

`ezmedicationinput` parses concise clinician shorthand medication instructions and produces [FHIR R5 Dosage](https://hl7.org/fhir/dosage.html) JSON. It is designed for use in lightweight medication-entry experiences and ships with batteries-included normalization for common Thai/English sig abbreviations.

## Features

- Converts shorthand strings (e.g. `1x3 po pc`, `500 mg po q6h prn pain`) into FHIR-compliant dosage JSON.
- Parses multi-clause sigs into multiple dosage items (e.g. `OD ... , OS ...`) while preserving a first-item compatibility shape for legacy single-dose consumers.
- Emits timing abbreviations (`timing.code`) and repeat structures simultaneously where possible.
- Maps meal/time blocks to the correct `Timing.repeat.when` **EventTiming** codes and can auto-expand AC/PC/C into specific meals.
- Outputs SNOMED CT route codings (while providing friendly text) and round-trips known SNOMED routes back into the parser.
- Auto-codes common PRN (as-needed) reasons and additional dosage instructions while keeping the raw text when no coding is available.
- Understands ocular and intravitreal shorthand (OD/OS/OU, LE/RE/BE, IVT*, VOD/VOS, etc.) and warns when intravitreal instructions omit an eye side.
- Parses fractional/ minute-based intervals (`q0.5h`, `q30 min`, `q1/4hr`) plus dose and timing ranges.
- Supports extensible dictionaries for routes, units, frequency shorthands, and event timing tokens.
- Applies medication context to infer default units when they are omitted.
- Surfaces warnings when discouraged tokens (`QD`, `QOD`, `BLD`) are used and optionally rejects them.
- Generates upcoming administration timestamps from FHIR dosage data via `nextDueDoses` using configurable clinic clocks.
- Auto-codes common body-site phrases (e.g. "left arm", "right eye") with SNOMED CT anatomy concepts and supports interactive lookup flows for ambiguous sites.
- Represents spatial body-site phrases such as `below ear`, `right side of abdomen`, `between fingers`, and Thai forms like `ระหว่างนิ้วมือ` through structured site metadata.
- Exposes body-site lookup/suggestion/listing helpers and SNOMED postcoordination helpers for UI search and terminology workflows.

## Parser architecture

The parser is built around an HPSG-style lexical/sign grammar: tokens become typed signs, signs unify into clause-level structures, and the final projection emits FHIR `Dosage`. It is **not** a pure academic HPSG implementation; deterministic projection is still required for FHIR shape, terminology lookup, formatting, and compatibility behavior.

## Installation

```bash
npm install ezmedicationinput
```

## Usage

```ts
import { parseSig } from "ezmedicationinput";

const batch = parseSig("1x3 po pc", { context: { dosageForm: "tab" } });

// New API
console.log(batch.count);      // 1
console.log(batch.items[0].fhir);

// Legacy compatibility (first parsed item)
console.log(batch.fhir);
```

Example output:

```json
{
  "count": 1,
  "items": [
    {
      "fhir": {
        "text": "Take 1 tablet by mouth three times daily after meals.",
        "timing": {
          "code": { "coding": [{ "code": "TID" }], "text": "TID" },
          "repeat": {
            "frequency": 3,
            "period": 1,
            "periodUnit": "d",
            "when": ["PC"]
          }
        },
        "route": { "text": "by mouth" },
        "doseAndRate": [{ "doseQuantity": { "value": 1, "unit": "tab" } }]
      }
    }
  ],
  "fhir": { "...": "same as items[0].fhir for compatibility" }
}
```

### Multi-clause parsing and legacy compatibility

`parseSig` / `parseSigAsync` return a **batch** object:

- `count`: number of parsed dosage clauses
- `items`: array of full parse results (one per clause)
- `meta.segments`: source ranges for each clause

For single-dose integrations that haven't migrated yet, the batch also keeps legacy first-item fields:

- `fhir`, `shortText`, `longText`, `warnings`, `meta`, and for linting `result`/`issues`

So existing code that expects one result can continue using first-item compatibility while newer code uses `items[]`.

### PRN reasons & additional instructions

`parseSig` identifies PRN (as-needed) clauses and trailing instructions, then
codes them with SNOMED CT whenever possible.

```ts
const result = parseSig("1 tab po q4h prn headache; do not exceed 6 tabs/day");

result.fhir.asNeededFor;
// → [{
//      text: "headache",
//      coding: [{
//        system: "http://snomed.info/sct",
//        code: "25064002",
//        display: "Headache"
//      }]
//    }]

result.fhir.additionalInstruction;
// → [{ text: "Do not exceed 6 tablets daily" }]
```

Customize the dictionaries and lookups through `ParseOptions`:

```ts
parseSig(input, {
  prnReasonMap: {
    migraine: {
      text: "Migraine",
      coding: {
        system: "http://snomed.info/sct",
        code: "37796009",
        display: "Migraine"
      }
    }
  },
  prnReasonResolvers: async (request) => terminologyService.lookup(request),
  prnReasonSuggestionResolvers: async (request) => terminologyService.suggest(request),
});
```

Use `{reason}` in the sig string (e.g. `prn {migraine}`) to force a lookup even
when a direct match exists. Additional instructions are sourced from a built-in
set of SNOMED CT concepts under *419492006 – Additional dosage instructions* and
fall back to plain text when no coding is available. Parsed instructions are
also echoed in `ParseResult.meta.normalized.additionalInstructions` for quick UI
rendering.

When a PRN reason cannot be auto-resolved, any registered suggestion resolvers
are invoked and their responses are surfaced through
`ParseBatchResult.items[n].meta.prnReasonLookups` so client applications can prompt the user
to choose a coded concept.

### Formatting multi-item results back to sig text

Use either helper depending on your source:

- `formatParseBatch(batch, style?, separator?)` when you already have `parseSig` output.
- `formatSigBatch(dosages, style?, { separator })` when you have an array of FHIR `Dosage` entries.
- `formatSig(dosage, style?, options?)` / `fromFhirDosage(dosage, options?)` when you want
  locale-aware long-text rendering controls for a single dosage.

```ts
import { formatParseBatch, formatSigBatch, parseSig } from "ezmedicationinput";

const batch = parseSig("1 tab po @ 8:00, 2 tabs po with lunch, 1 tab before dinner, 4 tabs po hs");

const shortSig = formatParseBatch(batch, "short");
// => "1 tab PO 08:00, 2 tab PO CD, 1 tab PO ACV, 4 tab PO HS"

const shortFromFhir = formatSigBatch(batch.items.map((item) => item.fhir), "short");
// => same combined short sig text
```

Formatting options:

- `locale`: selects the registered localization, such as `"en"` or `"th"`.
- `i18n`: overrides or augments the registered localization callbacks.
- `groupMealTimingsByRelation`: compacts repeated meal relation phrases when all
  meal anchors share the same relation.
  Example EN: `after breakfast, lunch and dinner`
  Example TH: `หลังอาหารเช้า กลางวัน และเย็น`
- `includeTimesPerDaySummary`: prepends a daily count when the formatter can
  safely infer one from explicit daily anchors and no cadence already exists.
  Example EN: `three times daily after breakfast, lunch and dinner`
  Example TH: `วันละ 3 ครั้ง หลังอาหารเช้า กลางวัน และเย็น`

Notes:

- `groupMealTimingsByRelation` only applies to homogeneous specific meal anchors
  (`before breakfast/lunch/dinner`, `after breakfast/lunch/dinner`, or `with breakfast/lunch/dinner`).
  When additional non-meal daily anchors exist, the formatter groups the meal
  subset and leaves the extra anchors explicit.
  Example EN: `before breakfast, lunch and dinner and at bedtime`
  Example TH: `ก่อนอาหารเช้า กลางวัน และเย็น และก่อนนอน`
- `includeTimesPerDaySummary` is independent from meal grouping. It counts
  explicit daily anchors only when no `frequency`, `timingCode`, interval, or
  day-of-week cadence is already present.

### Sig (directions) suggestions

Use `suggestSig` to drive autocomplete experiences while the clinician is
typing shorthand medication directions (sig = directions). It returns an array
of canonical direction strings and accepts the same `ParseOptions` context plus
a `limit` and custom PRN reasons.

```ts
import { suggestSig } from "ezmedicationinput";

const suggestions = suggestSig("1 drop to od q2h", {
  limit: 5,
  context: { dosageForm: "ophthalmic solution" },
});

// → ["1 drop oph q2h", "1 drop oph q2h prn pain", ...]
```

Highlights:

- Recognizes plural units and their singular counterparts (`tab`/`tabs`,
  `puff`/`puffs`, `mL`/`millilitres`, etc.) and normalizes spelled-out metric,
  SI-prefixed masses/volumes (`micrograms`, `microliters`, `nanograms`,
  `liters`, `kilograms`, etc.) alongside household measures like `teaspoon`
  and `tablespoons` (set `allowHouseholdVolumeUnits: false` to omit them).
- Keeps matching even when intermediary words such as `to`, `in`, or ocular
  site shorthand (`od`, `os`, `ou`) appear in the prefix.
- Emits dynamic interval suggestions, including arbitrary `q<number>h` cadences
  and common range patterns like `q4-6h`.
- Supports multiple timing tokens in sequence (e.g. `1 tab po morn hs`).
- Surfaces PRN reasons from built-ins or custom `prnReasons` entries while
  preserving numeric doses pulled from the typed prefix.
- When `enableMealDashSyntax` is enabled, suggests dash-based meal patterns
  (e.g. `1-0-1`, `1-0-0-1 ac`) only when dash syntax is being typed.

## Dictionaries

The library exposes default dictionaries in `maps.ts` for routes, units, frequencies (Timing abbreviations + repeat defaults), and event timing tokens. You can extend or override them via the `ParseOptions` argument.

Key EventTiming mappings include:

| Token(s)        | EventTiming |
|-----------------|-------------|
| `ac`            | `AC`
| `pc`            | `PC`
| `wm`, `with meals` | `C`
| `pc breakfast`  | `PCM`
| `pc lunch`      | `PCD`
| `pc dinner`     | `PCV`
| `breakfast`, `bfast`, `brkfst`, `brk` | `CM`
| `lunch`, `lunchtime` | `CD`
| `dinner`, `dinnertime`, `supper`, `suppertime` | `CV`
| `am`, `morning` | `MORN`
| `noon`, `midday`, `mid-day` | `NOON`
| `afternoon`, `aft` | `AFT`
| `pm`, `evening` | `EVE`
| `night`         | `NIGHT`
| `hs`, `bedtime` | `HS`

When `when` is populated, `timeOfDay` is intentionally omitted to stay within HL7 constraints.

Routes always include SNOMED CT codings. Every code from the SNOMED Route of Administration value set is represented so you can confidently pass parsed results into downstream FHIR services that expect coded routes.

### SNOMED body-site coding & interactive probes

Spelled-out application sites are automatically coded when the phrase is known to the bundled SNOMED CT anatomy dictionary. The normalized site text is also surfaced in `Dosage.site.text` and in the `ParseResult.meta.normalized.site` object.

```ts
import { parseSig } from "ezmedicationinput";

const result = parseSig("apply cream to left arm twice daily");

result.fhir.site?.coding?.[0];
// → { system: "http://snomed.info/sct", code: "368208006", display: "Left upper arm structure" }
```

Spatial site phrases are preserved as structured metadata on `Dosage.site.extension`
and in `ParseResult.meta.normalized.site.spatialRelation`.

```ts
const result = parseSig("apply to area between fingers");

result.fhir.site?.text;
// → "area between fingers"

result.meta.normalized.site?.spatialRelation;
// → {
//      relationText: "between",
//      targetText: "fingers",
//      targetCoding: {
//        system: "http://snomed.info/sct",
//        code: "7569003",
//        display: "Finger structure"
//      }
//    }
```

Only relations that exist in the FHIR BodyStructure relative-location ValueSet
receive `spatialRelation.relationCoding` (for example `Above`, `Beneath`,
`Posterior`, `Upper`, `Lower`, and `Lateral`). Other useful spatial language,
such as `between`, `around`, `near`, and `inside`, is preserved as
`relationText` without pretending there is an official code for it.

Thai and mixed-language site phrases resolve through the same site grammar:

```ts
parseSig("apply ระหว่างนิ้วมือ", { locale: "th" }).longText;
// → "ทา บริเวณระหว่างนิ้วมือ."

parseSig("apply ระหว่างนิ้วเท้า", { locale: "th" }).longText;
// → "ทา บริเวณระหว่างนิ้วเท้า."

parseSig("apply ระหว่างนิ้ว", {
  locale: "th",
  context: { bodySiteContext: "feet" }
}).longText;
// → "ทา บริเวณระหว่างนิ้วเท้า."
```

When the parser encounters an unfamiliar site, it leaves the text untouched and records nothing in `meta.siteLookups`. Wrapping the phrase in braces (e.g. `apply to {mole on scalp}`) preserves the same parsing behavior but flags the entry as a **probe** so `meta.siteLookups` always contains the request. This allows UIs to display lookup widgets even before a matching code exists. Braces are optional when the site is already recognized—they simply make the clinician's intent explicit.

Unknown body sites still populate `Dosage.site.text` and `ParseResult.meta.normalized.site.text`, allowing UIs to echo the verbatim phrase while terminology lookups run asynchronously.

For typeahead/search UI, use the exported body-site helpers directly:

```ts
import {
  getBodySiteCode,
  getBodySiteCodeAsync,
  getBodySiteText,
  getBodySiteTextAsync,
  listSupportedBodySiteGrammar,
  listSupportedBodySiteText,
  lookupBodySite,
  suggestBodySiteText,
  suggestBodySites
} from "ezmedicationinput";

getBodySiteCode("left ass");
// → { system: "http://snomed.info/sct", code: "723979003", display: "Structure of left buttock" }

getBodySiteText("723979003");
// → "left buttock"

getBodySiteText("22253000:363698007=723979003");
// → "left buttock"

getBodySiteCode("top of head");
// → { system: "http://snomed.info/sct", code: "69536005:106233006=261183002", display: "top of head" }

getBodySiteCode("top of head", { postcoordination: false });
// → undefined

getBodySiteText("69536005:106233006=261183002");
// → "top of head"

getBodySiteCode("right big toe");
// → { system: "http://snomed.info/sct", code: "78883009:272741003=24028007", display: "right great toe" }

getBodySiteText("78883009:272741003=24028007");
// → "right great toe"

getBodySiteText("22253000:363698007=723979003", {
  parsePostcoordination: false
});
// → undefined

lookupBodySite("ระหว่างนิ้ว", { bodySiteContext: "feet" });
// → { text: "between toes", spatialRelation: { relationText: "between", ... }, ... }

suggestBodySites("หนัง", { limit: 5 });
// → [{ text: "scalp", coding: { code: "41695006", ... }, ... }]

suggestBodySiteText("นิ้วโป้ง", { limit: 5 });
// → ["thumb", "great toe", ...]

listSupportedBodySiteText({ limit: 10 });
// → ["abdomen", "affected area", ...]

listSupportedBodySiteGrammar().siteAnchors;
// → ["above", "around", "at", "beneath", "below", "between", ...]
```

`getBodySiteCode` and `getBodySiteText` are convenience wrappers for the common
phrase-to-code and code-to-label cases. `getBodySiteCode` returns direct
pre-coordinated body-site codings when available; otherwise it can build a
SNOMED topographical-modifier expression for coded spatial phrases such as
`top of head` or `below ear`, and SNOMED laterality expressions for digit sites
such as `right big toe`. Parsed medication orders use the same behavior for
`Dosage.site.coding` by default and still preserve the structured spatial
extension; pass `bodySitePostcoordination: false` to `parseSig` when a consumer
only accepts literal body-site codes. `getBodySiteText` resolves finding-site,
topographical-modifier, and laterality postcoordination by default. Pass
`postcoordination: false` or `parsePostcoordination: false` to require literal
body-site codes only.

`lookupBodySite` returns the full resolved metadata, including spatial relation
details. `suggestBodySites` returns ranked bundled/custom candidates for
autocomplete, while `suggestBodySiteText` returns only display labels.
`listSupportedBodySiteText` exposes the bundled/custom label inventory for UI
preloading, and `listSupportedBodySiteGrammar` exposes the supported site
anchors/prepositions, locative relations, partitive heads/modifiers, and
SNOMED-coded spatial relation metadata. Lookup helpers accept `siteCodeMap`;
phrase-based helpers also accept `bodySiteContext`, used only for genuinely
ambiguous shorthand such as Thai `ระหว่างนิ้ว`.

Standalone lookup helpers can also call sync or async terminology hooks:

```ts
getBodySiteCode("clinic site", {
  siteCodeMap: {
    "clinic site": {
      coding: {
        system: "http://example.org/sites",
        code: "CLINIC-SITE",
        display: "Clinic site"
      },
      text: "clinic site"
    }
  }
});

await getBodySiteCodeAsync("remote site", {
  siteCodeResolvers: async (request) => {
    if (request.canonical !== "remote site") return undefined;
    return {
      coding: {
        system: "http://example.org/sites",
        code: "REMOTE-SITE",
        display: "Remote site"
      },
      text: "remote site"
    };
  }
});

await getBodySiteTextAsync(
  { system: "http://example.org/sites", code: "REMOTE-SITE" },
  {
    siteTextResolvers: async (request) =>
      request.originalCoding.code === "REMOTE-SITE" ? "remote site" : undefined
  }
);
```

You can extend or replace the built-in codings via `ParseOptions`:

```ts
import { parseSigAsync } from "ezmedicationinput";

const result = await parseSigAsync("apply to {left temple} nightly", {
  siteCodeMap: {
    "left temple": {
      coding: {
        system: "http://example.org/custom",
        code: "LTEMP",
        display: "Left temple"
      },
      aliases: ["temporal region, left"],
      text: "Left temple"
    }
  },
  // any overrides that the user explicitly selected
  siteCodeSelections: [
    {
      canonical: "scalp",
      resolution: {
        coding: {
          system: "http://snomed.info/sct",
          code: "39937001",
          display: "Scalp structure"
        },
        text: "Scalp"
      }
    }
  ],
  siteCodeResolvers: async (request) => {
    if (request.canonical === "mole on scalp") {
      return {
        coding: { system: "http://snomed.info/sct", code: "39937001", display: "Scalp structure" },
        text: request.text
      };
    }
    return undefined;
  },
  siteCodeSuggestionResolvers: async (request) => {
    if (request.isProbe) {
      return [
        {
          coding: { system: "http://snomed.info/sct", code: "39937001", display: "Scalp structure" },
          text: "Scalp"
        },
        {
          coding: { system: "http://snomed.info/sct", code: "450721000", display: "Temple region structure" },
          text: "Temple"
        }
      ];
    }
    return undefined;
  }
});

result.meta.siteLookups;
// → [{ request: { text: "left temple", isProbe: true, ... }, suggestions: [...] }]
```

  - `siteCodeMap` lets you supply deterministic overrides for normalized site phrases.
  - Entries accept an `aliases` array so punctuation-heavy variants (e.g., "first bicuspid, left") can resolve to the same coding.
  - `siteCodeResolvers` (sync or async) can call external services to resolve sites on demand.
  - `siteCodeSuggestionResolvers` return candidate codes; their results populate `meta.siteLookups[0].suggestions`.
  - `siteCodeSelections` let callers override the automatic match for a detected phrase or range—helpful when a clinician chooses a bundled SNOMED option over a custom override.
  - Each resolver receives the full `SiteCodeLookupRequest`, including the original input, the cleaned site text, and a `{ start, end }` range you can use to highlight the substring in UI workflows.
  - `parseSigAsync` behaves like `parseSig` but awaits asynchronous resolvers and suggestion providers.

#### Site resolver signatures

```ts
export interface SiteCodeLookupRequest {
  originalText: string; // Sanitized phrase before brace/whitespace cleanup
  text: string;         // Brace-free, whitespace-collapsed site text
  normalized: string;   // Lower-case variant of `text`
  canonical: string;    // Normalized key for dictionary lookups
  spatialRelation?: BodySiteSpatialRelation; // Parsed relation + target, when present
  isProbe: boolean;     // True when the sig used `{placeholder}` syntax
  inputText: string;    // Full sig string the parser received
  sourceText?: string;  // Substring extracted from `inputText`
  range?: { start: number; end: number }; // Character range of `sourceText`
}

export type SiteCodeResolver = (
  request: SiteCodeLookupRequest
) => SiteCodeResolution | null | undefined | Promise<SiteCodeResolution | null | undefined>;

export type SiteCodeSuggestionResolver = (
  request: SiteCodeLookupRequest
) =>
  | SiteCodeSuggestionsResult
  | SiteCodeSuggestion[]
  | SiteCodeSuggestion
  | null
  | undefined
  | Promise<SiteCodeSuggestionsResult | SiteCodeSuggestion[] | SiteCodeSuggestion | null | undefined>;
```

`SiteCodeResolution`, `SiteCodeSuggestion`, and `SiteCodeSuggestionsResult` mirror the values shown in the example above. Resolvers can use `request.range` (start inclusive, end exclusive) together with `request.sourceText` to paint highlights or replace the detected phrase in client applications.

Consumers that only need synchronous resolution can continue calling `parseSig`. If any synchronous resolver accidentally returns a Promise, an error is thrown with guidance to switch to `parseSigAsync`.

#### Standalone body-site helper resolver signatures

The standalone helper callbacks are intentionally smaller than parser callbacks
because they only resolve one phrase or one code at a time.

```ts
export interface BodySiteLookupRequest {
  originalText: string;
  text: string;
  normalized: string;
  canonical: string;
  bodySiteContext?: string;
  spatialRelation?: BodySiteSpatialRelation;
}

export type BodySiteResolver = (
  request: BodySiteLookupRequest
) => BodySiteDefinition | null | undefined | Promise<BodySiteDefinition | null | undefined>;

export interface BodySiteTextLookupRequest {
  coding: BodySiteCode;         // decoded literal site when postcoordination is enabled
  originalCoding: BodySiteCode; // original input coding/code
  parsedPostcoordination?: {
    type: "topographicalModifier" | "laterality" | "findingSite";
    siteCode: string;
    modifierCode?: string;
    lateralityCode?: string;
    focusCode?: string;
  };
}

export type BodySiteTextResolver = (
  request: BodySiteTextLookupRequest
) => string | null | undefined | Promise<string | null | undefined>;
```

#### SNOMED finding-site postcoordination helpers

When a PRN reason has a symptom plus site (for example `pain at abdomen`), the
library can represent the coded symptom with a SNOMED finding-site expression.
The helpers are exported for callers that need the same representation outside
the parser.

This is separate from body-site postcoordination. PRN findings use
`363698007 | Finding site |`; spatial body-site phrases use
`106233006 | Topographical modifier |`; laterality on body sites uses
`272741003 | Laterality |`.

```ts
import {
  buildSnomedBodySiteLateralityPostcoordinationCode,
  buildSnomedFindingSiteCoding,
  buildSnomedFindingSitePostcoordinationCode,
  hasSnomedFindingSitePostcoordination
} from "ezmedicationinput";

buildSnomedBodySiteLateralityPostcoordinationCode("78883009", "24028007");
// → "78883009:272741003=24028007"

buildSnomedFindingSitePostcoordinationCode("22253000", "85562004");
// → "22253000:363698007=85562004"

hasSnomedFindingSitePostcoordination("22253000:363698007=85562004");
// → true

buildSnomedFindingSiteCoding({
  focusCoding: {
    system: "http://snomed.info/sct",
    code: "22253000",
    display: "Pain"
  },
  siteCoding: {
    system: "http://snomed.info/sct",
    code: "85562004",
    display: "Hand"
  },
  display: "Pain at hand"
});
```

The spatial site extension helpers are also exported:
`buildBodySiteSpatialRelationExtension`,
`buildBodySiteSpatialRelationExtensions`,
`parseBodySiteSpatialRelationExtension`,
`cloneBodySiteSpatialRelation`, and
`BODY_SITE_SPATIAL_RELATION_EXTENSION_URL`.

You can specify the number of times (total count) the medication is supposed to be used by ending with `for {number} times`, `x {number} doses`, or simply `x {number}`

### Advanced parsing options

`parseSig` accepts a `ParseOptions` object. Highlights:

- `context`: optional medication context (dosage form, strength, container
  metadata, and optional `bodySiteContext`) used to infer defaults and
  disambiguate shorthand body-site phrases. Pass `null` to explicitly disable
  context-based inference.
- `context.bodySiteContext`: optional anatomical context for ambiguous site
  shorthand. Example: Thai `ระหว่างนิ้ว` defaults to fingers, but resolves to
  toes when `bodySiteContext` is `"feet"`, `"foot"`, or another foot/toe phrase.
- `smartMealExpansion`: when `true`, generic AC/PC/C meal abbreviations and
  cadence-only instructions expand into concrete with-meal EventTiming
  combinations (e.g. `1x3` → breakfast/lunch/dinner). This also respects
  `context.mealRelation` when provided and only applies to schedules with four
  or fewer daily doses.
- `smartMealExpansionScope`: optional include/exclude overrides for route codes
  and dosage forms. When omitted, smart meal expansion uses the built-in
  default heuristic. Exclusions take precedence over includes.
- `enableMealDashSyntax`: when `true`, enables shorthand meal-dose patterns
  such as `1-0-1`, `1-0-1 pc`, `10-12-0 ac`, and `1-0-0-1 ac`. The parser
  expands them into multiple dosage clauses aligned to breakfast/lunch/dinner
  (plus bedtime for a 4th slot).
- `twoPerDayPair`: controls whether 2× AC/PC/C doses expand to breakfast+dinner (default) or breakfast+lunch.
- `assumeSingleDiscreteDose`: when `true`, missing discrete doses (such as
  tablets or capsules) default to a single unit when the parser can infer a
  countable unit from context.
- `eventClock`: optional map of `EventTiming` codes to HH:mm strings that drives chronological ordering of parsed `when` values.
- `allowHouseholdVolumeUnits`: defaults to `true`; set to `false` to ignore
  teaspoon/tablespoon units during parsing and suggestions.
- Custom `routeMap`, `unitMap`, `freqMap`, and `whenMap` let you augment the built-in dictionaries without mutating them.
- `siteCodeSelections` override automatic site resolution for matching phrases or ranges so user-picked suggestions stick when re-parsing a sig.

### Next due dose generation

`nextDueDoses` produces upcoming administration timestamps from an existing FHIR `Dosage`. Supply the evaluation window (`from`), optionally the order start (`orderedAt`), and clinic clock details such as a time zone and event timing anchors. When a `Timing.repeat.count` cap exists and prior occurrences have already been administered, pass `priorCount` to indicate how many doses were consumed before the `from` timestamp so remaining administrations are calculated correctly without re-traversing the timeline.

```ts
import { EventTiming, nextDueDoses, parseSig } from "ezmedicationinput";

const { fhir } = parseSig("1x3 po pc", { context: { dosageForm: "tab" } });

const schedule = nextDueDoses(fhir, {
  orderedAt: "2024-01-01T08:15:00Z",
  from: "2024-01-01T09:00:00Z",
  limit: 5,
  timeZone: "Asia/Bangkok",
  eventClock: {
    [EventTiming.Morning]: "08:00",
    [EventTiming.Noon]: "12:00",
    [EventTiming.Evening]: "18:00",
    [EventTiming["Before Sleep"]]: "22:00",
    [EventTiming.Breakfast]: "08:00",
    [EventTiming.Lunch]: "12:30",
    [EventTiming.Dinner]: "18:30"
  },
  mealOffsets: {
    [EventTiming["Before Meal"]]: -30,
    [EventTiming["After Meal"]]: 30
  },
  frequencyDefaults: {
    byCode: { BID: ["08:00", "20:00"] }
  }
});

// → ["2024-01-01T12:30:00+07:00", "2024-01-01T18:30:00+07:00", ...]
```

Key rules:

- `when` values map to the clinic `eventClock`. Generic meal codes (`AC`, `PC`, `C`) use `mealOffsets` against breakfast/lunch/dinner anchors.
- Interval-based schedules (`repeat.period` + `periodUnit`) step forward from `orderedAt`, respecting `dayOfWeek` filters.
- Pure frequency schedules (`BID`, `TID`, etc.) fall back to clinic-defined institution times.
- All timestamps are emitted as ISO strings that include the clinic time-zone offset.

`from` is required and marks the evaluation window. `orderedAt` is optional—when supplied it acts as the baseline for interval calculations; otherwise the `from` timestamp is reused. The options bag also accepts `timeZone`, `eventClock`, `mealOffsets`, and `frequencyDefaults` at the top level (mirroring the legacy `config` object). `limit` defaults to 10 when omitted.

### Medication amount calculation

`calculateTotalUnits` computes the total amount of medication (and optionally the number of containers) required for a specific duration. It accounts for complex schedules, dose ranges (using the high value), and unit conversions between doses and containers.

```ts
import { calculateTotalUnits, parseSig } from "ezmedicationinput";

const { fhir } = parseSig("1x3 po pc");

const result = calculateTotalUnits({
  dosage: fhir,
  from: "2024-01-01T08:00:00Z",
  durationValue: 7,
  durationUnit: "d",
  timeZone: "Asia/Bangkok",
  context: {
    containerValue: 30, // 30 tabs per bottle
    containerUnit: "tab"
  }
});

// → { totalUnits: 21, totalContainers: 1 }
```

It can also handle strength-based conversions (e.g. calculating how many 100mL bottles are needed for a 500mg TID dose of a 250mg/5mL suspension).

### Strength parsing

Use `parseStrength` to normalize medication strength strings into FHIR-compliant **Quantity** or **Ratio** structures. It understands percentages, ratios, and composite strengths.

```ts
import { parseStrength } from "ezmedicationinput";

// Percentage (infers g/100mL for liquids or g/100g for solids)
parseStrength("1%", { dosageForm: "cream" }); 
// → { strengthRatio: { numerator: { value: 1, unit: "g" }, denominator: { value: 100, unit: "g" } } }

// Ratios
parseStrength("250mg/5mL");
// → { strengthRatio: { numerator: { value: 250, unit: "mg" }, denominator: { value: 5, unit: "mL" } } }

// Composite (sums components into a single ratio)
parseStrength("875mg + 125mg");
// → { strengthQuantity: { value: 1000, unit: "mg" } }

// Simple Quantity
parseStrength("500mg");
// → { strengthQuantity: { value: 500, unit: "mg" } }
```

`parseStrengthIntoRatio` is also available if you specifically need a FHIR Ratio object regardless of the denominator.

### Ocular & intravitreal shortcuts

The parser recognizes ophthalmic shorthands such as `OD`, `OS`, `OU`, `LE`, `RE`, and `BE`, as well as intravitreal-specific tokens including `IVT`, `IVTOD`, `IVTOS`, `IVTLE`, `IVTBE`, `VOD`, and `VOS`. Intravitreal sigs require an eye side; the parser surfaces a warning if one is missing so downstream workflows can prompt the clinician for clarification.

## Discouraged Tokens

- `QD` (daily)
- `QOD` (every other day)
- `BLD` / `B-L-D` (with meals)

By default these are accepted with a warning via `ParseResult.warnings`. Set `allowDiscouraged: false` in `ParseOptions` to reject inputs containing them.

## Testing

Run the Vitest test suite:

```bash
npm test
```

## License

MIT
