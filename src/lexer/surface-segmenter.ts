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
const SEGMENTER_INDEX=new Map<string,number>();

export function registerMedicationSurfaceSegmenter(segmenter: MedicationSurfaceSegmenter): void {
  // Stateless script tests can safely reuse the registered expression.
  // Only /g or /y must lose their mutation-prone lastIndex behavior.
  const normalized = Object.assign({}, segmenter);
  if (segmenter.script.global || segmenter.script.sticky)
    normalized.script = new RegExp(segmenter.script.source, segmenter.script.flags.replace(/[gy]/g, ""));
  const existing=SEGMENTER_INDEX.get(segmenter.locale);
  if(existing!==undefined)SEGMENTERS[existing]=normalized;
  else{SEGMENTER_INDEX.set(segmenter.locale,SEGMENTERS.length);SEGMENTERS.push(normalized);}
}

export function listMedicationSurfaceSegmenters(): MedicationSurfaceSegmenter[] {
  // The list is a registry snapshot; its entries are immutable-by-contract
  // providers. Recopying every provider object adds no clinical meaning.
  return SEGMENTERS.slice();
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

/** ICU segmenters are pure per-locale services. Re-registering a known
 * locale should replace its script association, not rebuild the expensive
 * ICU service. Constructor identity also handles runtime polyfill replacement. */
let intlConstructor:IntlWordSegmenterConstructor|undefined;
const intlSegmenters=new Map<string,IntlWordSegmenter>();
export function registerIntlMedicationSurfaceSegmenter(locale: string, script: RegExp): void {
  const Segmenter = (Intl as unknown as { Segmenter?: IntlWordSegmenterConstructor }).Segmenter;
  if (!Segmenter) return;
  try {
    if(intlConstructor!==Segmenter){intlConstructor=Segmenter;intlSegmenters.clear();}
    let segmenter=intlSegmenters.get(locale);
    if(!segmenter){segmenter=new Segmenter(locale,{granularity:"word"});intlSegmenters.set(locale,segmenter);}
    const resolved=segmenter;
    registerMedicationSurfaceSegmenter({locale,script,segment:(input)=>resolved.segment(input)});
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
