import { describe, expect, it } from 'vitest';
import { parseSig, parseSigAsync, lintSig, nextDueDoses, calculateTotalUnits, formatSig, FhirPeriodUnit } from '../../src/index';
import { canonicalFromFhir, canonicalToFhir } from '../../src/fhir';
import { ORIGINAL_CORPUS, SCHEDULE_OPTIONS } from './corpus';
import { SPECIALTY_CASES, SPECIALTY_SEEDS } from './specialty-corpus';
import type { GoldenCase } from './corpus';

const corpus = [...ORIGINAL_CORPUS, ...SPECIALTY_CASES];
function checkClinical(c: GoldenCase) {
  const parsed = parseSig(c.input, c.options), scheduleOptions = { ...SCHEDULE_OPTIONS, ...c.scheduleOptions };
  expect(parsed.items.length, c.id).toBe(c.items.length);
  c.items.forEach((wanted, index) => {
    const item = parsed.items[index], fhir = item.fhir, repeat = fhir.timing?.repeat;
    const due = nextDueDoses(fhir, scheduleOptions);
    const total = calculateTotalUnits({ dosage: fhir, from: scheduleOptions.from, timeZone: scheduleOptions.timeZone,
      durationValue: c.totalDays ?? 70, durationUnit: FhirPeriodUnit.Day, ...c.scheduleOptions }).totalUnits;
    const actual = { dose: fhir.doseAndRate?.[0]?.doseQuantity?.value, unit: fhir.doseAndRate?.[0]?.doseQuantity?.unit,
      dates: fhir.timing?.event, clocks: repeat?.timeOfDay, when: repeat?.when, weekdays: repeat?.dayOfWeek,
      start: repeat?.boundsPeriod?.start, end: repeat?.boundsPeriod?.end,
      duration: item.meta.canonical.clauses[0]?.schedule?.duration ?? repeat?.boundsDuration?.value,
      period: repeat?.period, periodUnit: repeat?.periodUnit, frequency: repeat?.frequency, due, totalUnits: total };
    for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
      if (key in wanted) expect(actual[key], `${c.id}:item${index}:${key}`).toEqual(wanted[key]);
    }
    if (wanted.noStart) expect(repeat?.boundsPeriod?.start).toBeUndefined();
    if (wanted.noDose) expect(fhir.doseAndRate).toBeUndefined();
    if (wanted.noDuration) expect(repeat?.boundsDuration).toBeUndefined();
    if (c.noLeftovers !== false) expect(item.meta.leftoverText ?? '').toBe('');
    // Structured round-trip must preserve executable timing, not only attractive display text.
    const restored = canonicalToFhir(canonicalFromFhir(JSON.parse(JSON.stringify(fhir))));
    expect(nextDueDoses(restored, scheduleOptions), `${c.id}:FHIR-occurrences`).toEqual(due);
    expect(restored.doseAndRate).toEqual(fhir.doseAndRate);
    if (c.partition === 'specialty') {
      expect([repeat?.boundsDuration,repeat?.boundsRange,repeat?.boundsPeriod].filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(Boolean(repeat?.when?.length && repeat?.timeOfDay?.length)).toBe(false);
    }
  });
  return parsed;
}

describe('independent clinical oracles, occurrence execution and FHIR round-trips', () => {
  it.each(corpus)('$id', c => { checkClinical(c); });
  it.each(SPECIALTY_SEEDS)('sync/async/lint retain the same regimen: $id', async c => {
    const sync = parseSig(c.input,c.options), asynchronous = await parseSigAsync(c.input,c.options), lint = lintSig(c.input,c.options);
    expect(asynchronous.items.map(i=>i.fhir)).toEqual(sync.items.map(i=>i.fhir));
    expect(lint.items.map(i=>i.result.fhir)).toEqual(sync.items.map(i=>i.fhir));
  });
  it.each(SPECIALTY_SEEDS.flatMap(c => ['en','th'].map(locale => ({...c,renderLocale:locale}))))('Realization $renderLocale reparses without schedule change: $id', c => {
    const parsed = parseSig(c.input,c.options), opts = { ...SCHEDULE_OPTIONS,...c.scheduleOptions };
    for (const item of parsed.items) {
      const text = formatSig(item.fhir,'long',{locale:c.renderLocale});
      const reparsed = parseSig(text,{...c.options,locale:c.renderLocale});
      expect(reparsed.items.flatMap(i=>nextDueDoses(i.fhir,opts)).sort(),text).toEqual(nextDueDoses(item.fhir,opts).sort());
      expect(reparsed.items.every(i=>!i.meta.leftoverText),text).toBe(true);
    }
  });
});

const invalidCycles = [
  'on days 1,8,15 every 28 days for 2 cycles',
  'on days 1,8,15 starting 28/9/2026 for 2 cycles',
  'on days 1,8,15 every 28 days starting 28/9/2026',
  'on days 0,8 every 28 days starting 28/9/2026 for 2 cycles',
  'on days 1,29 every 28 days starting 28/9/2026 for 2 cycles',
  'on days 9-5 starting 28/9/2026',
  'on days 1,8 every 28 days starting 31/2/2026 for 2 cycles',
  'on days 1,8 every 28 days starting 09/28/26 for 2 cycles'
];
describe('known-invalid input never becomes a fabricated executable regimen', () => {
  it.each(invalidCycles)('retains dose but refuses unsafe cycle: %s', text => {
    const input=`take .5 tab at 08:00 ${text}`, parsed=parseSig(input,{locale:'en-US',datePolicy:{referenceDate:'2026-09-27'}});
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity?.value).toBe(.5);
    expect(parsed.warnings.some(w=>w.indexOf('Unresolved schedule')>=0)).toBe(true);
    expect(nextDueDoses(parsed.fhir,SCHEDULE_OPTIONS)).toEqual([]);
    expect(parsed.longText).toContain(text);
  });
  it('refuses a contradictory explicit start without overwriting it to look valid', () => {
    const parsed=parseSig('take 1 tab at 08:00 on 4/10 then every Sunday at 09:00 from 28/9 until 30/11', {datePolicy:{referenceDate:'2026-09-27'}});
    expect(parsed.items).toHaveLength(2);
    expect(nextDueDoses(parsed.items[0].fhir,SCHEDULE_OPTIONS)).toEqual(['2026-10-04T08:00:00+07:00']);
    expect(nextDueDoses(parsed.items[1].fhir,SCHEDULE_OPTIONS)).toEqual([]);
    expect(parsed.items[1].warnings.join(' ')).toContain('phase-start-precedes-predecessor-end');
  });
  it('does not silently choose a clock from heterogeneous predecessors', () => {
    const parsed=parseSig('take 1 tab at 08:00 on 4/10 and at 20:00 on 28/9 then every Sunday until 30/11', {datePolicy:{referenceDate:'2026-09-27'}});
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[2].warnings.join(' ')).toContain('ambiguous-inherited-clock');
    expect(nextDueDoses(parsed.items[2].fhir,SCHEDULE_OPTIONS)).toEqual([]);
  });
  it('does not silently turn a range or PRN into a precise fixed dose', () => {
    const parsed=parseSig('take 1-2 tablets every 6 hours as needed for pain');
    expect(parsed.fhir.asNeededBoolean).toBe(true);
    expect(parsed.fhir.doseAndRate?.[0]?.doseQuantity).toBeUndefined();
    expect(parsed.fhir.doseAndRate?.[0]?.doseRange).toMatchObject({low:{value:1},high:{value:2}});
  });
});

describe('independent scheduler boundary controls', () => {
  it('keeps every-other-day wall clocks across daylight-saving change', () => {
    const dosage={doseAndRate:[{doseQuantity:{value:.5,unit:'tab'}}],timing:{repeat:{period:2,periodUnit:FhirPeriodUnit.Day,
      timeOfDay:['08:00:00'],boundsPeriod:{start:'2026-03-06',end:'2026-03-12'}}}};
    const options={from:'2026-03-06T00:00:00-05:00',timeZone:'America/New_York',limit:20};
    expect(nextDueDoses(dosage,options)).toEqual([
      '2026-03-06T08:00:00-05:00','2026-03-08T08:00:00-04:00','2026-03-10T08:00:00-04:00','2026-03-12T08:00:00-04:00']);
    expect(calculateTotalUnits({...options,dosage,durationValue:8,durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(2);
  });
  it('clamps month-end independently of the timezone offset and keeps the original anchor', () => {
    const dosage={doseAndRate:[{doseQuantity:{value:1,unit:'tab'}}],timing:{repeat:{period:1,periodUnit:FhirPeriodUnit.Month,
      timeOfDay:['08:00:00'],boundsPeriod:{start:'2026-01-31',end:'2026-04-30'}}}};
    const options={from:'2026-02-01T00:00:00-05:00',timeZone:'America/New_York',limit:20};
    expect(nextDueDoses(dosage,options)).toEqual([
      '2026-02-28T08:00:00-05:00','2026-03-31T08:00:00-04:00','2026-04-30T08:00:00-04:00']);
    expect(calculateTotalUnits({...options,dosage,durationValue:100,durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(3);
  });
  it('uses the same cadence when deriving historical count caps', () => {
    const dosage={doseAndRate:[{doseQuantity:{value:1,unit:'tab'}}],timing:{repeat:{period:2,periodUnit:FhirPeriodUnit.Day,
      count:3,timeOfDay:['08:00:00'],boundsPeriod:{start:'2026-09-28',end:'2026-10-10'}}}};
    const options={from:'2026-10-01T00:00:00+07:00',orderedAt:'2026-09-28T00:00:00+07:00',timeZone:'Asia/Bangkok',limit:20};
    expect(nextDueDoses(dosage,options)).toEqual(['2026-10-02T08:00:00+07:00']);
    expect(calculateTotalUnits({...options,dosage,durationValue:10,durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(1);
  });
  it('does not double-count duplicate date and clock entries', () => {
    const dosage={doseAndRate:[{doseQuantity:{value:.25,unit:'tab'}}],timing:{
      event:['2026-10-01','2026-09-28','2026-10-01'],repeat:{timeOfDay:['08:00:00','08:00:00','20:00:00']}}};
    const due=nextDueDoses(dosage,SCHEDULE_OPTIONS);
    expect(due).toEqual(['2026-09-28T08:00:00+07:00','2026-09-28T20:00:00+07:00','2026-10-01T08:00:00+07:00','2026-10-01T20:00:00+07:00']);
    expect(calculateTotalUnits({dosage,from:SCHEDULE_OPTIONS.from,timeZone:'Asia/Bangkok',durationValue:10,durationUnit:FhirPeriodUnit.Day}).totalUnits).toBe(1);
  });
});
