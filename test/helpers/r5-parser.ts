/**
 * Historical source-suite adapter ONLY. The shipping API is extended R5-like flat dosages + strict R6.
 * These grammar fixtures still assert per-clause R5 lowerings. Keeping their
 * expectations independent of the new R6 wire-format tests preserves their
 * value without introducing a production compatibility API.
 */
import { parseSig as parseR6, parseSigAsync as parseR6Async } from "../../src/index";
import { withDosageEditProvenance } from "../../src/dosage-course";
import type { FhirDosage, FhirR6DosageInstruction, ParseBatchResult, ParseOptions } from "../../src/types";

export type R5ParserTestResult = Omit<ParseBatchResult, "fhir" | "course"> & {
  fhir: FhirDosage;
  dosageDetails: FhirR6DosageInstruction;
};

function forHistoricalAssertions(value: ParseBatchResult): R5ParserTestResult {
  const { fhir: _dosages, course: _course, ...rest } = value;
  const row = value.items[0]?.fhir;
  const fhir = row ? withDosageEditProvenance([row], row.text)[0] : {};
  const items = value.items.slice();
  if (items[0]) items[0] = { ...items[0], fhir };
  return {
    ...rest,
    // Historical fixtures intentionally expose only the FIRST clause here;
    // multi-clause tests must use items[] or the shipping .fhir array.
    // Keep that clause's parser-produced source agreement after a fresh save.
    fhir,
    items,
    dosageDetails: value.fhirNext
  };
}

export function parseSig(input: string, options?: ParseOptions): R5ParserTestResult {
  return forHistoricalAssertions(parseR6(input, options));
}

export async function parseSigAsync(input: string, options?: ParseOptions): Promise<R5ParserTestResult> {
  return forHistoricalAssertions(await parseR6Async(input, options));
}
