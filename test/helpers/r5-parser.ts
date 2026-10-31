/**
 * Historical source-suite adapter ONLY. The shipping API is extended R5-like flat dosages + strict R6.
 * These grammar fixtures still assert per-clause R5 lowerings. Keeping their
 * expectations independent of the new R6 wire-format tests preserves their
 * value without introducing a production compatibility API.
 */
import { parseSig as parseR6, parseSigAsync as parseR6Async } from "../../src/index";
import type { FhirDosage, FhirR6DosageDetails, ParseBatchResult, ParseOptions } from "../../src/types";

export type R5ParserTestResult = Omit<ParseBatchResult, "fhir" | "course"> & {
  fhir: FhirDosage;
  dosageDetails: FhirR6DosageDetails;
};

function forHistoricalAssertions(value: ParseBatchResult): R5ParserTestResult {
  const { fhir: _dosages, course: _course, ...rest } = value;
  return {
    ...rest,
    // Historical fixtures intentionally expose only the FIRST clause here;
    // multi-clause tests must use items[] or the shipping .fhir array.
    fhir: value.items[0]?.fhir ?? {},
    dosageDetails: value.fhirNext
  };
}

export function parseSig(input: string, options?: ParseOptions): R5ParserTestResult {
  return forHistoricalAssertions(parseR6(input, options));
}

export async function parseSigAsync(input: string, options?: ParseOptions): Promise<R5ParserTestResult> {
  return forHistoricalAssertions(await parseR6Async(input, options));
}
