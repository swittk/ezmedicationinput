# ezmedicationinput

`ezmedicationinput` parses concise clinician shorthand medication instructions and produces [FHIR R5 Dosage](https://hl7.org/fhir/dosage.html) JSON. It is designed for use in lightweight medication-entry experiences and ships with batteries-included normalization for common Thai/English sig abbreviations.

## Features

- Converts shorthand strings (e.g. `1x3 po pc`, `500 mg po q6h prn pain`) into FHIR-compliant dosage JSON.
- Emits timing abbreviations (`timing.code`) and repeat structures simultaneously where possible.
- Maps meal/time blocks to the correct `Timing.repeat.when` **EventTiming** codes and can auto-expand AC/PC/C into specific meals.
- Outputs SNOMED CT route codings (while providing friendly text) and round-trips known SNOMED routes back into the parser.
- Understands ocular and intravitreal shorthand (OD/OS/OU, LE/RE/BE, IVT*, VOD/VOS, etc.) and warns when intravitreal instructions omit an eye side.
- Parses fractional/ minute-based intervals (`q0.5h`, `q30 min`, `q1/4hr`) plus dose and timing ranges.
- Supports extensible dictionaries for routes, units, frequency shorthands, and event timing tokens.
- Applies medication context to infer default units when they are omitted.
- Surfaces warnings when discouraged tokens (`QD`, `QOD`, `BLD`) are used and optionally rejects them.
- Generates upcoming administration timestamps from FHIR dosage data via `nextDueDoses` using configurable clinic clocks.

## Installation

```bash
npm install ezmedicationinput
```

## Usage

```ts
import { parseSig } from "ezmedicationinput";

const result = parseSig("1x3 po pc", { context: { dosageForm: "tab" } });
console.log(result.fhir);
```

Example output:

```json
{
  "text": "1 tablet by mouth three times daily after meals",
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
```

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

You can specify the number of times (total count) the medication is supposed to be used by ending with `for {number} times`, `x {number} doses`, or simply `x {number}`

### Advanced parsing options

`parseSig` accepts a `ParseOptions` object. Highlights:

- `context`: optional medication context (dosage form, strength, container
  metadata) used to infer default units when a sig omits explicit units. Pass
  `null` to explicitly disable context-based inference.
- `smartMealExpansion`: when `true`, generic AC/PC/C tokens expand into specific EventTiming combinations (e.g. `1x2 po ac` → `ACM` + `ACV`).
- `twoPerDayPair`: controls whether 2× AC/PC/C doses expand to breakfast+dinner (default) or breakfast+lunch.
- `eventClock`: optional map of `EventTiming` codes to HH:mm strings that drives chronological ordering of parsed `when` values.
- `allowHouseholdVolumeUnits`: defaults to `true`; set to `false` to ignore
  teaspoon/tablespoon units during parsing and suggestions.
- Custom `routeMap`, `unitMap`, `freqMap`, and `whenMap` let you augment the built-in dictionaries without mutating them.

### Next due dose generation

`nextDueDoses` produces upcoming administration timestamps from an existing FHIR `Dosage`. Supply the evaluation window (`from`), optionally the order start (`orderedAt`), and clinic clock details such as a time zone and event timing anchors.

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
