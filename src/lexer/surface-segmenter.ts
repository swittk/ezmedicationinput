export interface MedicationSurfaceSegment {
  segment: string;
  index: number;
}

export interface MedicationSurfaceSegmenter {
  locale: string;
  script: RegExp;
  segment(input: string): Iterable<MedicationSurfaceSegment>;
}

const SEGMENTERS: MedicationSurfaceSegmenter[] = [];

export function registerMedicationSurfaceSegmenter(segmenter: MedicationSurfaceSegmenter): void {
  const script = new RegExp(segmenter.script.source, segmenter.script.flags.replace(/[gy]/g, ""));
  const normalized = { ...segmenter, script };
  const existing = SEGMENTERS.findIndex((candidate) => candidate.locale === segmenter.locale);
  if (existing >= 0) SEGMENTERS.splice(existing, 1, normalized);
  else SEGMENTERS.push(normalized);
}

export function listMedicationSurfaceSegmenters(): MedicationSurfaceSegmenter[] {
  return SEGMENTERS.map((segmenter) => ({ ...segmenter }));
}

interface IntlWordSegment {
  segment: string;
  index: number;
}
interface IntlWordSegmenter {
  segment(input: string): Iterable<IntlWordSegment>;
}
type IntlWordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" }
) => IntlWordSegmenter;

export function registerIntlMedicationSurfaceSegmenter(locale: string, script: RegExp): void {
  const Segmenter = (Intl as unknown as { Segmenter?: IntlWordSegmenterConstructor }).Segmenter;
  if (!Segmenter) return;
  try {
    const segmenter = new Segmenter(locale, { granularity: "word" });
    registerMedicationSurfaceSegmenter({ locale, script, segment: (input) => segmenter.segment(input) });
  } catch {
    // Locale segmentation is optional; lexical parsing still has a non-segmented fallback.
  }
}

function segmenterForChar(char: string): MedicationSurfaceSegmenter | undefined {
  return SEGMENTERS.find((segmenter) => segmenter.script.test(char));
}

function scriptClass(char: string): string | undefined {
  const segmenter = segmenterForChar(char);
  if (segmenter) return `locale:${segmenter.locale}`;
  if (/[A-Za-z]/u.test(char)) return "latin";
  return undefined;
}

export function splitMedicationScriptRuns(value: string): Array<{
  text: string;
  offset: number;
  segmenter?: MedicationSurfaceSegmenter;
}> {
  if (!value) return [];
  const runs: Array<{ text: string; offset: number; segmenter?: MedicationSurfaceSegmenter }> = [];
  let start = 0;
  for (let index = 1; index < value.length; index += 1) {
    const previous = scriptClass(value[index - 1]);
    const current = scriptClass(value[index]);
    if (previous && current && previous !== current) {
      const text = value.slice(start, index);
      runs.push({ text, offset: start, segmenter: segmenterForChar(text[0] ?? "") });
      start = index;
    }
  }
  const text = value.slice(start);
  runs.push({ text, offset: start, segmenter: segmenterForChar(text[0] ?? "") });
  return runs;
}
