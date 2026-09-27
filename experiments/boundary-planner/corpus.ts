import type { ParseOptions } from '../../src/types';

export interface GoldenItem {
  dose?: number;
  noDose?: boolean;
  totalUnits?: number;
  dates?: string[];
  clocks?: string[];
  when?: string[];
  weekdays?: string[];
  start?: string;
  end?: string;
  noStart?: boolean;
  duration?: number;
  noDuration?: boolean;
  due?: string[];
}
export interface GoldenCase {
  id: string; family: string; partition: 'historical' | 'metamorphic' | 'challenge';
  history: string[]; input: string; options?: ParseOptions; items: GoldenItem[];
  noLeftovers?: boolean;
}
export const REFERENCE_DATE = '2026-09-27';
export const SCHEDULE_OPTIONS = { from: '2026-09-27T00:00:00+07:00', timeZone: 'Asia/Bangkok', limit: 20 };
const th: ParseOptions = { locale: 'th', datePolicy: { referenceDate: REFERENCE_DATE } };
const en: ParseOptions = { locale: 'en-GB', datePolicy: { referenceDate: REFERENCE_DATE } };
const iso = (day: string, clock: string) => `${day}T${clock}:00+07:00`;
const days = ['2026-09-28', '2026-10-01', '2026-10-04'];
const sundayDays = ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];
const paired: GoldenItem[] = [{ dose: 1, totalUnits: 1, dates: ['2026-09-28'], clocks: ['08:00:00'], due: [iso('2026-09-28', '08:00')] },
  { dose: 1, totalUnits: 1, dates: ['2026-10-01'], clocks: ['20:00:00'], due: [iso('2026-10-01', '20:00')] }];

/** Expected meanings are authored independently; baseline output is NOT the golden oracle. */
export const historicalCases: GoldenCase[] = [
  { id: 'reported-thai-date-list', family: 'list-ownership', partition: 'historical', history: ['11b34f0'], options: th,
    input: 'รับประทานครั้งละ 1 เม็ด วันละครั้ง หลังอาหารเช้า. วันที่ 28/9/69, 1/10/69 และ 4/10/69 จากนั้น ทุกวันอาทิตย์',
    items: [{ dose: 1, dates: days, when: ['PCM'], due: days.map(d => iso(d, '08:30')) },
      { dose: 1, weekdays: ['sun'], start: '2026-10-05', when: ['PCM'] }] },
  { id: 'english-omitted-head', family: 'dose-continuation', partition: 'historical', history: ['5fca1fc', '1f23c87'],
    input: 'take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep',
    items: [{ dose: 1, clocks: ['12:00:00'] }, { dose: 2, clocks: ['16:00:00'] }, { dose: 1.5, when: ['HS'] }] },
  { id: 'thai-omitted-head', family: 'dose-continuation', partition: 'historical', history: ['5fca1fc'], options: th,
    input: 'รับประทาน 1 เม็ด เวลา 12:00 จากนั้น 2 เม็ด เวลา 16:00 และ 1.5 เม็ด ก่อนนอน',
    items: [{ dose: 1, clocks: ['12:00:00'] }, { dose: 2, clocks: ['16:00:00'] }, { dose: 1.5, when: ['HS'] }] },
  { id: 'thai-taper-duration', family: 'shared-modifier-scope', partition: 'historical', history: ['892e6fb', 'd03174f', '34f7bd1'],
    options: { ...th, context: { dosageForm: 'tablet' } },
    input: '1 เม็ดเช้า 2 เม็ดเย็นเป็นเวลา 2 สัปดาห์ หลังจากนั้นทาน 1 เม็ดเช้า 1 เม็ดเย็น',
    items: [{ dose: 1, when: ['MORN'], duration: 2 }, { dose: 2, when: ['EVE'], duration: 2 },
      { dose: 1, when: ['MORN', 'EVE'], noDuration: true }] },
  { id: 'duration-before-merge', family: 'shared-modifier-scope', partition: 'historical', history: ['d03174f', '34f7bd1'],
    input: '1 tab morning 1 tab evening for 2 weeks', options: { context: { dosageForm: 'tablet' } },
    items: [{ dose: 1, when: ['MORN', 'EVE'], duration: 2 }] },
  { id: 'independent-date-clock-pairs', family: 'pairing-versus-product', partition: 'historical', history: ['f7e5a2e'], options: en,
    input: 'take 1 tab at 08:00 on 28/9 and at 20:00 on 1/10', items: paired },
  { id: 'pairs-then-recurring', family: 'sequence-versus-union', partition: 'historical', history: ['f7e5a2e', 'd4b05b7'], options: en,
    input: 'take 1 tab at 08:00 on 28/9 and at 20:00 on 1/10 then every Sunday at 09:30 until 30/11',
    items: [...paired, { dose: 1, weekdays: ['sun'], clocks: ['09:30:00'], start: '2026-10-02', end: '2026-11-30',
      due: ['2026-10-04', ...sundayDays].map(d => iso(d, '09:30')) }] },
  { id: 'union-not-sequence', family: 'sequence-versus-union', partition: 'historical', history: ['f7e5a2e'], options: en,
    input: 'take 1 tab on 28/9 at 08:00 and every Sunday at 09:30 until 30/11',
    items: [paired[0], { dose: 1, weekdays: ['sun'], clocks: ['09:30:00'], end: '2026-11-30', noStart: true,
      due: ['2026-09-27', '2026-10-04', ...sundayDays].map(d => iso(d, '09:30')) }] },
  { id: 'shared-clocks-shared-dates', family: 'pairing-versus-product', partition: 'historical', history: ['f7e5a2e'], options: en,
    input: 'take 1 tab at 08:00 and 20:00 on 28/9 and 1,4/10',
    items: [{ dose: 1, dates: days, clocks: ['08:00:00', '20:00:00'], due: days.flatMap(d => [iso(d, '08:00'), iso(d, '20:00')]) }] },
  { id: 'fronted-date-comma', family: 'fronted-attachment', partition: 'historical', history: ['cb315c5', '40e63f3'], options: en,
    input: 'on 28/9, take 1 tab at 08:00', items: [paired[0]] },
  { id: 'bounded-fronted-schedule', family: 'fronted-attachment', partition: 'historical', history: ['cb315c5'], options: en,
    input: 'from 28/9 take 1 tab at 08:00 daily until 30/9',
    items: [{ dose: 1, clocks: ['08:00:00'], start: '2026-09-28', end: '2026-09-30',
      due: ['2026-09-28', '2026-09-29', '2026-09-30'].map(d => iso(d, '08:00')) }] },
  { id: 'fraction-not-date', family: 'dose-protection', partition: 'historical', history: ['676896c', '6123c65'], options: en,
    input: 'take 1/2 tablet after breakfast', items: [{ dose: 0.5, when: ['PCM'] }] },
  { id: 'leading-decimal', family: 'dose-protection', partition: 'historical', history: ['6123c65'],
    input: 'take .5tab daily', items: [{ dose: 0.5 }] },
  { id: 'procedural-not-administration-split', family: 'procedural-scope', partition: 'historical', history: ['245b697', '5fca1fc'],
    input: 'wash scalp and rinse', items: [{ noDose: true }] },
  { id: 'shared-safety', family: 'procedural-scope', partition: 'historical', history: ['5fca1fc', '1f23c87'],
    input: 'take 1 tab at 12:00, then 2 tabs at 16:00, and 1.5 tabs before sleep; do not take if low blood pressure',
    items: [{ dose: 1, clocks: ['12:00:00'] }, { dose: 2, clocks: ['16:00:00'] }, { dose: 1.5, when: ['HS'] }] }
];

/** Perturbations have known equivalent meanings; changing AND to THEN is tested separately. */
export function metamorphicCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const languages = [
    { id: 'en', options: en, head: 'take 1/2 tab daily after breakfast', lead: 'on', ds: ['28/9/2026', '1/10/2026', '4/10/2026'],
      recur: 'every Sunday', bound: 'until 30/11/2026' },
    { id: 'th', options: th, head: 'รับประทานครั้งละ 1/2 เม็ด วันละครั้ง หลังอาหารเช้า', lead: 'วันที่', ds: ['28/9/69', '1/10/69', '4/10/69'],
      recur: 'ทุกวันอาทิตย์', bound: 'ถึงวันที่ 30/11/69' },
    { id: 'mixed', options: en, head: 'รับประทานครั้งละ .5 เม็ด daily หลังอาหารเช้า', lead: 'on', ds: ['28/9/2026', '1/10/2026', '4/10/2026'],
      recur: 'every Sunday', bound: 'ถึงวันที่ 30/11/2026' }
  ];
  for (const lang of languages) for (const separator of [', ', ' and ', ' และ '])
    for (const transition of ['then', 'จากนั้น']) for (const stop of ['', ` ${lang.bound}`])
      for (const punctuation of [' ', '. ']) {
        const list = `${lang.lead} ${lang.ds.join(separator)}`;
        const input = `${lang.head}${punctuation}${list} ${transition} ${lang.recur}${stop}`;
        cases.push({ id: `list-${lang.id}-${cases.length}`, family: 'list-ownership', partition: 'metamorphic',
          history: ['11b34f0', 'f7e5a2e'], input, options: lang.options, items: [
            { dose: 0.5, totalUnits: 1.5, dates: days, when: ['PCM'], due: days.map(d => iso(d, '08:30')) },
            { dose: 0.5, weekdays: ['sun'], when: ['PCM'], start: '2026-10-05', ...(stop ? { totalUnits: 4, end: '2026-11-30', due: sundayDays.map(d => iso(d, '08:30')) } : {}) }
          ] });
      }
  for (const locale of ['en', 'en-US', 'en-GB', 'th']) for (const named of ['5 Oct 2026', 'Oct 5 2026', 'October 5, 2026']) {
    cases.push({ id: `month-${locale}-${named}`, family: 'date-policy', partition: 'metamorphic', history: ['5280d8a', 'cb4ce11', 'd618d1b'],
      options: { locale, datePolicy: { referenceDate: REFERENCE_DATE } },
      input: `take .5 tab on ${named} at 08:00`, items: [{ dose: 0.5, dates: ['2026-10-05'], clocks: ['08:00:00'], due: [iso('2026-10-05', '08:00')] }] });
  }
  return cases;
}

/** Challenge set is scored and reported even if both parsers fail; it never gets relabelled to match output. */
export const challengeCases: GoldenCase[] = [
  { id: 'oxford-date-list', family: 'list-ownership', partition: 'challenge', history: ['11b34f0'], options: en,
    input: 'take 1 tab at 08:00 on 28/9/2026, 1/10/2026, and 4/10/2026 then every Sunday until 30/11',
    items: [{ dose: 1, dates: days, clocks: ['08:00:00'], due: days.map(d => iso(d, '08:00')) },
      { dose: 1, weekdays: ['sun'], clocks: ['08:00:00'], start: '2026-10-05', end: '2026-11-30', due: sundayDays.map(d => iso(d, '08:00')) }] },
  { id: 'clock-pair-comma-date-lists', family: 'pairing-versus-product', partition: 'challenge', history: ['f7e5a2e'], options: en,
    input: 'take 1 tab at 08:00 on 28/9 and 1/10, at 20:00 on 4/10 and 5/10',
    items: [{ dose: 1, dates: days.slice(0, 2), clocks: ['08:00:00'], due: days.slice(0, 2).map(d => iso(d, '08:00')) },
      { dose: 1, dates: ['2026-10-04', '2026-10-05'], clocks: ['20:00:00'], due: ['2026-10-04', '2026-10-05'].map(d => iso(d, '20:00')) }] },
  { id: 'thai-union-no-explicit-clock', family: 'sequence-versus-union', partition: 'challenge', history: ['f7e5a2e'], options: th,
    input: 'รับประทาน 1 เม็ด วันที่ 28/9/69 และ ทุกวันอาทิตย์',
    items: [{ dose: 1, dates: ['2026-09-28'] }, { dose: 1, weekdays: ['sun'], noStart: true }] },
  { id: 'same-date-different-doses', family: 'dose-continuation', partition: 'challenge', history: ['5fca1fc', 'f7e5a2e'], options: en,
    input: 'take 1/2 tab at 08:00 on 28/9 and 2 tabs at 20:00 on 28/9',
    items: [{ dose: 0.5, dates: ['2026-09-28'], clocks: ['08:00:00'], due: [iso('2026-09-28', '08:00')] },
      { dose: 2, dates: ['2026-09-28'], clocks: ['20:00:00'], due: [iso('2026-09-28', '20:00')] }] },
  { id: 'reverse-ordered-exact-phase', family: 'shared-modifier-scope', partition: 'challenge', history: ['f7e5a2e'], options: en,
    input: 'take 1 tab at 08:00 on 4/10 and at 20:00 on 28/9 then every Sunday at 09:30 until 30/11',
    items: [{ dose: 1, dates: ['2026-10-04'], clocks: ['08:00:00'] }, { dose: 1, dates: ['2026-09-28'], clocks: ['20:00:00'] },
      { dose: 1, weekdays: ['sun'], clocks: ['09:30:00'], start: '2026-10-05', end: '2026-11-30', due: sundayDays.map(d => iso(d, '09:30')) }] }
];

export const CORPUS = [...historicalCases, ...metamorphicCases(), ...challengeCases];
