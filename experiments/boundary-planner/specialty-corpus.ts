import type { GoldenCase, GoldenItem } from './corpus';
const options = { datePolicy: { referenceDate: '2026-09-27' } };
/** Independent UTC-calendar arithmetic for synthetic test expectations, NOT a dosing recommendation. */
export function calendarDays(start: string, end: string, step = 1): string[] {
  const result: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += step * 86400000)
    result.push(new Date(t).toISOString().slice(0, 10));
  return result;
}
export function expectedTimes(days: string[], clocks: string[]): string[] {
  return days.flatMap(d => clocks.map(t => `${d}T${t}:00+07:00`)).sort();
}
function weekdayDates(days: string[], weekdays: number[]): string[] {
  return days.filter(d => weekdays.indexOf(new Date(`${d}T00:00:00Z`).getUTCDay()) >= 0);
}
function item(dose: number, start: string, end: string, clocks: string[], days: string[], extra: GoldenItem = {}): GoldenItem {
  return { dose, start, end, clocks: clocks.map(t => `${t}:00`), due: expectedTimes(days, clocks),
    totalUnits: dose * days.length * clocks.length, ...extra };
}
function fixture(id: string, specialty: string, input: string, items: GoldenItem[], extra: Partial<GoldenCase> = {}): GoldenCase {
  return { id, specialty, input, items, options, history: [], family: specialty, partition: 'specialty',
    scheduleOptions: { limit: 300 }, ...extra };
}
const fortnight = calendarDays('2026-09-28','2026-10-11');
const firstThree = calendarDays('2026-09-28','2026-09-30');
const sundays = calendarDays('2026-10-11','2026-11-29',7);

/** Specialty-inspired syntax. Values are synthetic fixtures, not clinical protocols or drug defaults. */
export const SPECIALTY_SEEDS: GoldenCase[] = [
  fixture('variable-weekday-half-tablet', 'anticoagulation',
    '1/2 tab mon wed fri at 18:00 from 28/9 until 11/10 and 1 tab tue thu sat sun at 18:00 from 28/9 until 11/10',
    [item(.5,'2026-09-28','2026-10-11',['18:00'],weekdayDates(fortnight,[1,3,5])),
      item(1,'2026-09-28','2026-10-11',['18:00'],weekdayDates(fortnight,[2,4,6,0]))]),
  fixture('weekly-not-daily', 'rheumatology',
    'take 3 tab every Monday at 08:00 from 28/9 until 26/10',
    [item(3,'2026-09-28','2026-10-26',['08:00'],calendarDays('2026-09-28','2026-10-26',7))]),
  fixture('alternate-day-explicit-clock','endocrinology',
    'take .5 tab every other day at 08:00 from 28/9 until 6/10',
    [item(.5,'2026-09-28','2026-10-06',['08:00'],calendarDays('2026-09-28','2026-10-06',2))]),
  fixture('fortnightly-explicit-clock','gastroenterology',
    'take 1 tab every 2 weeks at 08:00 from 28/9 until 9/11',
    [item(1,'2026-09-28','2026-11-09',['08:00'],calendarDays('2026-09-28','2026-11-09',14))]),
  fixture('bounded-three-stage-taper','respiratory',
    'take 4 tab daily at 08:00 from 28/9 until 30/9 then 2 tab daily at 08:00 until 3/10 then 1 tab daily at 08:00 until 6/10',
    [item(4,'2026-09-28','2026-09-30',['08:00'],firstThree),
      item(2,'2026-10-01','2026-10-03',['08:00'],calendarDays('2026-10-01','2026-10-03')),
      item(1,'2026-10-04','2026-10-06',['08:00'],calendarDays('2026-10-04','2026-10-06'))]),
  fixture('duration-three-stage-taper','rheumatology',
    'take 4 tab daily at 08:00 from 28/9 for 3 days then 2 tab daily at 08:00 for 3 days then 1 tab daily at 08:00 for 3 days',
    [{dose:4,start:'2026-09-28',end:'2026-09-30',duration:3,due:expectedTimes(firstThree,['08:00']),totalUnits:12},
      {dose:2,start:'2026-10-01',end:'2026-10-03',duration:3,due:expectedTimes(calendarDays('2026-10-01','2026-10-03'),['08:00']),totalUnits:6},
      {dose:1,start:'2026-10-04',end:'2026-10-06',duration:3,due:expectedTimes(calendarDays('2026-10-04','2026-10-06'),['08:00']),totalUnits:3}]),
  fixture('clock-specific-neurology','movement-disorders',
    '1 tab at 06:00,10:00,14:00 from 28/9 until 30/9 and 1/2 tab at 18:00,22:00 from 28/9 until 30/9',
    [item(1,'2026-09-28','2026-09-30',['06:00','10:00','14:00'],firstThree),
      item(.5,'2026-09-28','2026-09-30',['18:00','22:00'],firstThree)]),
  fixture('renal-fixed-weekdays','renal',
    'take 1 tab on Monday Wednesday Friday at 18:00 from 28/9 until 9/10',
    [item(1,'2026-09-28','2026-10-09',['18:00'],weekdayDates(calendarDays('2026-09-28','2026-10-09'),[1,3,5]))]),
  fixture('left-eye-clock-taper','ophthalmology',
    'instill 1 drop left eye at 08:00,12:00,16:00,20:00 from 28/9 until 30/9 then 1 drop left eye at 08:00,20:00 until 7/10',
    [item(1,'2026-09-28','2026-09-30',['08:00','12:00','16:00','20:00'],firstThree,{unit:'drop'}),
      item(1,'2026-10-01','2026-10-07',['08:00','20:00'],calendarDays('2026-10-01','2026-10-07'),{unit:'drop'})]),
  fixture('cyclic-day-list','oncology',
    'take 1 tab at 08:00 on days 1,8,15 every 28 days starting 28/9/2026 for 2 cycles',
    [{dose:1,clocks:['08:00:00'],dates:['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],
      due:expectedTimes(['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],['08:00']),totalUnits:6}]),
  fixture('cyclic-day-range','reproductive-endocrinology',
    'take 1 tab at 20:00 on days 5-9 starting 28/9/2026',
    [{dose:1,clocks:['20:00:00'],dates:calendarDays('2026-10-02','2026-10-06'),
      due:expectedTimes(calendarDays('2026-10-02','2026-10-06'),['20:00']),totalUnits:5}]),
  fixture('cross-midnight-distinct-dates','infectious-diseases',
    'take 1 tab at 23:30 on 28/9 and at 00:30 on 29/9 then every Monday at 23:30 until 12/10',
    [{dose:1,dates:['2026-09-28'],clocks:['23:30:00'],due:expectedTimes(['2026-09-28'],['23:30']),totalUnits:1},
      {dose:1,dates:['2026-09-29'],clocks:['00:30:00'],due:expectedTimes(['2026-09-29'],['00:30']),totalUnits:1},
      {dose:1,start:'2026-09-30',end:'2026-10-12',weekdays:['mon'],clocks:['23:30:00'],due:expectedTimes(['2026-10-05','2026-10-12'],['23:30']),totalUnits:2}]),
  fixture('loading-phase-later-clock-overrides-meal','cardiology',
    'take 1 tab after breakfast on 4/10 and 28/9 then every Sunday at 20:00 until 30/11',
    [{dose:1,dates:['2026-10-04','2026-09-28'],when:['PCM'],due:expectedTimes(['2026-09-28','2026-10-04'],['08:30']),totalUnits:2},
      {dose:1,start:'2026-10-05',end:'2026-11-30',clocks:['20:00:00'],due:expectedTimes(sundays,['20:00']),totalUnits:8}]),
  fixture('thai-clock-specific-neurology','movement-disorders',
    '1 เม็ด เวลา 06:00,10:00,14:00 ตั้งแต่วันที่ 28/9/69 ถึงวันที่ 30/9/69 และ 1/2 เม็ด เวลา 18:00,22:00 ตั้งแต่วันที่ 28/9/69 ถึงวันที่ 30/9/69',
    [item(1,'2026-09-28','2026-09-30',['06:00','10:00','14:00'],firstThree),item(.5,'2026-09-28','2026-09-30',['18:00','22:00'],firstThree)]),
  fixture('thyroid-weekend-distinct-dose','endocrinology',
    'take 1 tab Monday to Friday at 07:00 from 28/9 until 11/10 and .5tab Saturday and Sunday at 07:00 from 28/9 until 11/10',
    [item(1,'2026-09-28','2026-10-11',['07:00'],weekdayDates(fortnight,[1,2,3,4,5])),
      item(.5,'2026-09-28','2026-10-11',['07:00'],weekdayDates(fortnight,[6,0]))])
];

SPECIALTY_SEEDS.push(
  fixture('every-three-days-two-clocks','transplant',
    'take .5 tab every 3 days at 08:00 and 20:00 from 28/9 until 10/10',
    [item(.5,'2026-09-28','2026-10-10',['08:00','20:00'],calendarDays('2026-09-28','2026-10-10',3),{frequency:2})]),
  fixture('alternate-day-resumed-query','endocrinology',
    'take .5 tab every other day at 08:00 from 28/9 until 6/10',
    [item(.5,'2026-09-28','2026-10-06',['08:00'],['2026-10-02','2026-10-04','2026-10-06'])],
    {scheduleOptions:{from:'2026-10-01T09:00:00+07:00',limit:300}}),
  fixture('three-week-interval-multiple-weekdays','hematology',
    'take 1 tab every 3 weeks Monday and Thursday at 09:00 from 28/9 until 19/11',
    [item(1,'2026-09-28','2026-11-19',['09:00'],['2026-09-28','2026-10-01','2026-10-19','2026-10-22','2026-11-09','2026-11-12'])]),
  fixture('cycle-abbreviation','hematology',
    'take .5 tab at 08:00 on D1,8,15 q28d starting 28/9/2026 x2 cycles',
    [{dose:.5,dates:['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],clocks:['08:00:00'],
      due:expectedTimes(['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],['08:00']),totalUnits:3}]),
  fixture('monthly-end-of-month','endocrinology',
    'take 1 tab every month at 08:00 from 31/1/2028 until 30/4/2028',
    [item(1,'2028-01-31','2028-04-30',['08:00'],['2028-01-31','2028-02-29','2028-03-31','2028-04-30'])],
    {scheduleOptions:{from:'2028-01-31T00:00:00+07:00',limit:300},totalDays:100}),
  fixture('explicit-leap-day-pair','pediatrics',
    'take .25 tab at 08:00 on 28/2/2028 and 29/2/2028 then every Friday at 08:00 until 10/3/2028',
    [{dose:.25,dates:['2028-02-28','2028-02-29'],clocks:['08:00:00'],due:expectedTimes(['2028-02-28','2028-02-29'],['08:00']),totalUnits:.5},
      {dose:.25,start:'2028-03-01',end:'2028-03-10',clocks:['08:00:00'],weekdays:['fri'],due:expectedTimes(['2028-03-03','2028-03-10'],['08:00']),totalUnits:.5}],
    {scheduleOptions:{from:'2028-02-27T00:00:00+07:00',limit:300},totalDays:14}),
  fixture('two-successor-members-inherit-whole-phase','neurology',
    'take 1 tab at 08:00 on 4/10 and 2 tabs at 20:00 on 28/9 then 1 tab every Monday at 08:00 until 19/10 and 2 tabs every Thursday at 20:00 until 19/10',
    [{dose:1,dates:['2026-10-04'],clocks:['08:00:00'],due:expectedTimes(['2026-10-04'],['08:00']),totalUnits:1},
      {dose:2,dates:['2026-09-28'],clocks:['20:00:00'],due:expectedTimes(['2026-09-28'],['20:00']),totalUnits:2},
      {dose:1,start:'2026-10-05',end:'2026-10-19',clocks:['08:00:00'],due:expectedTimes(['2026-10-05','2026-10-12','2026-10-19'],['08:00']),totalUnits:3},
      {dose:2,start:'2026-10-05',end:'2026-10-19',clocks:['20:00:00'],due:expectedTimes(['2026-10-08','2026-10-15'],['20:00']),totalUnits:4}]),
  fixture('two-clock-weekday-weekly-total','renal',
    'take .5 tab every Monday and Thursday at 09:30 and 20:30 from 28/9 until 12/10',
    [item(.5,'2026-09-28','2026-10-12',['09:30','20:30'],['2026-09-28','2026-10-01','2026-10-05','2026-10-08','2026-10-12'])])
);

SPECIALTY_SEEDS.push(
  fixture('two-weeks-on-one-week-off','oncology',
    'take 1 tab at 08:00 and 20:00 on days 1-14 every 21 days starting 28/9/2026 for 2 cycles',
    [{dose:1,dates:[...calendarDays('2026-09-28','2026-10-11'),...calendarDays('2026-10-19','2026-11-01')],
      clocks:['08:00:00','20:00:00'],due:expectedTimes([...calendarDays('2026-09-28','2026-10-11'),...calendarDays('2026-10-19','2026-11-01')],['08:00','20:00']),totalUnits:56}]),
  fixture('full-thai-finite-cycle','hematology',
    'รับประทาน .5 เม็ด เวลา 08:00 วันที่ของรอบ 1,8,15 ทุก 28 วัน เริ่มวันที่ 28/9/69 จำนวน 2 รอบ',
    [{dose:.5,dates:['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],clocks:['08:00:00'],
      due:expectedTimes(['2026-09-28','2026-10-05','2026-10-12','2026-10-26','2026-11-02','2026-11-09'],['08:00']),totalUnits:3}]),
  fixture('quarter-tablet-finite-course','pediatrics',
    'take 1/4 tab at 08:00 and 20:00 from 28/9 until 30/9',
    [item(.25,'2026-09-28','2026-09-30',['08:00','20:00'],firstThree)]),
  fixture('fractional-liquid-finite-course','pediatrics',
    'take 2.5 mL at 08:00 and 20:00 from 28/9 until 30/9',
    [item(2.5,'2026-09-28','2026-09-30',['08:00','20:00'],firstThree,{unit:'mL'})]),
  fixture('eight-hour-interval','infectious-diseases',
    'take 1 tab every 8 hours from 28/9 until 30/9',
    [{dose:1,start:'2026-09-28',end:'2026-09-30',period:8,periodUnit:'h',
      due:expectedTimes(firstThree,['00:00','08:00','16:00']),totalUnits:9}]),
  fixture('three-nights-per-week','dermatology',
    'apply 1 fingertip unit every Monday Wednesday Friday at 22:00 from 28/9 until 9/10',
    [item(1,'2026-09-28','2026-10-09',['22:00'],weekdayDates(calendarDays('2026-09-28','2026-10-09'),[1,3,5]))])
);

SPECIALTY_SEEDS.push(fixture('explicit-phase-end-outweighs-last-dose','cardiology',
  'take 1 tab at 08:00 on 28/9 and 1/10 until 4/10 then every Sunday at 08:00 until 18/10',
  [{dose:1,dates:['2026-09-28','2026-10-01'],end:'2026-10-04',clocks:['08:00:00'],due:expectedTimes(['2026-09-28','2026-10-01'],['08:00']),totalUnits:2},
    {dose:1,start:'2026-10-05',end:'2026-10-18',clocks:['08:00:00'],due:expectedTimes(['2026-10-11','2026-10-18'],['08:00']),totalUnits:2}]));

SPECIALTY_SEEDS.push(fixture('cycle-named-month-anchor','oncology',
  'take 1 tab at 08:00 on days 1,8 every 28 days starting Oct 5, 2026 for 2 cycles',
  [{dose:1,dates:['2026-10-05','2026-10-12','2026-11-02','2026-11-09'],clocks:['08:00:00'],
    due:expectedTimes(['2026-10-05','2026-10-12','2026-11-02','2026-11-09'],['08:00']),totalUnits:4}]));

/** Equivalent surface variants carry the same independently authored expectations. */
function bilingualVariants(): GoldenCase[] {
  const translated: GoldenCase[] = [];
  const substitutions: Array<[RegExp,string]> = [
    [/\btake\b/gi,'รับประทาน'],[/\btab(?:let)?s?\b/gi,'เม็ด'],[/\bat\b/gi,'เวลา'],
    [/\bthen\b/gi,'จากนั้น'],[/\band\b/gi,'และ'],[/\buntil\b/gi,'ถึงวันที่'],[/\bfrom\b/gi,'ตั้งแต่วันที่'],
    [/\bevery other day\b/gi,'วันเว้นวัน'],[/\bdaily\b/gi,'วันละครั้ง'],
    [/\bevery Monday\b/gi,'ทุกวันจันทร์'],[/\bevery Sunday\b/gi,'ทุกวันอาทิตย์']
  ];
  for (const base of SPECIALTY_SEEDS) {
    if (!/\btake\b|\btab\b/.test(base.input)) continue;
    for (const mode of ['code-switch','thai-lexemes','lazy-spacing'] as const) {
      let input = base.input;
      if (mode === 'code-switch') {
        for (const [pattern,value] of substitutions.slice(0,6)) input=input.replace(pattern,value);
      } else if (mode === 'thai-lexemes') {
        for (const [pattern,value] of substitutions) input=input.replace(pattern,value);
      } else input=input.replace(/,\s*/g,', ').replace(/\b0\.5\b/g,'.5').replace(/\s+/g,'  ');
      if (input === base.input) continue;
      translated.push({...base,id:`${base.id}-${mode}`,input});
    }
  }
  return translated;
}
export const SPECIALTY_CASES = [...SPECIALTY_SEEDS,...bilingualVariants()];
