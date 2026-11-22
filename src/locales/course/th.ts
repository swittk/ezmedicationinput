/** Thai course wording. Keep locale realization separate from shared
 * interval/count/condition semantics; this is a facet of SigLocalization. */
import type { CourseLanguage } from "./types";
import { THAI_DAY_NAMES, joinLocalizedList } from "./weekday-vocabulary";
const UNITS: Readonly<Record<string, string>> = {
  s: "วินาที",
  min: "นาที",
  h: "ชั่วโมง",
  d: "วัน",
  wk: "สัปดาห์",
  mo: "เดือน",
  a: "ปี",
};
const MEASUREMENT_NAMES: Readonly<Record<string, string>> = {
  bp: "BP", sbp: "SBP", dbp: "DBP", hr: "HR", spo2: "SpO2",
};
export const THAI_COURSE: CourseLanguage = {
  unresolvedCycleTiming: (days, periodDays, cycles, anchor) => {
    const details = [
      ...(days ? ["วันที่ในรอบ " + days] : []),
      ...(periodDays !== undefined ? ["รอบละ " + periodDays + " วัน"] : []),
      ...(cycles !== undefined ? [cycles + " รอบ"] : []),
      ...(anchor ? ["วันเริ่มรอบ " + anchor] : [])
    ];
    return "ยังระบุเวลาในรอบไม่ได้" + (details.length ? " (" + details.join("; ") + ")" : "");
  },
  notPrefix: "ไม่ ",
  allSeparator: " และ ",
  anySeparator: " หรือ ",
  onlyIf: "เฉพาะเมื่อ",
  unless: "เว้นแต่",
  exceptDates: "ยกเว้นวันที่",
  exceptWeekdays: "ยกเว้น",
  choicePrefix: "เลือกอย่างใดอย่างหนึ่ง: ",
  stageSeparator: " จากนั้น ",
  doseLabel: "ขนาดยาต่อครั้ง: ",
  applicationSites: (count) => "รวม " + count + " จุด",
  amountRoleLabel: (kind, role, sourceRole) => {
    const label = kind === "dose" ? "ขนาดยา" : kind === "rate" ? "อัตราการให้ยา" : "ช่วงอัตราการให้ยา";
    return label + (role === "ordered" ? "ที่สั่ง" : role === "calculated" ? "ที่คำนวณ" : " (" + sourceRole + ")") + ": ";
  },
  rateLabel: "อัตราการให้ยา: ",
  rateRangeLabel: "ช่วงอัตราการให้ยา: ",
  unspecified: "ไม่ระบุค่า",
  withAuthoredDirections: (current, source) => "ปัจจุบัน: " + current + "; ข้อความเดิม: " + source,
  treatmentStart: "เริ่มการรักษา",
  incompleteInterpretation: "ข้อมูลบางส่วนเท่านั้น — ต้องตรวจสอบข้อจำกัดการใช้ยา",
  retainedStructure: "Structured FHIR data is retained",
  // Preserve the established output surface. These technical fallback labels
  // can later be translated here without touching clinical interpretation.
  maxAdministrationLabel: "max per administration: ",
  maxLifetimeLabel: "max lifetime: ",
  maxPeriodLabel: "max per period: ",
  maxDosageLabel: "max per dosage: ",
  courseLimitsLabel: "ตลอดแผนการใช้ยานี้: ",
  stageLimitsLabel: "ในขั้นตอนนี้: ",
  ifLimitExceeded: (action) => "หากเกินขีดจำกัด: " + action,
  eventWindow: (start, end) => `ระหว่าง${start.replace(/^พร้อม/u, "")}ถึง${end.replace(/^พร้อม/u, "")}`,
  weekdayName: (day) => THAI_DAY_NAMES[day] ?? day,
  measurementName: (name) => MEASUREMENT_NAMES[name] ?? name,
  joinList: (items) => joinLocalizedList(items,"และ"),
  timeUnit: (unit) => UNITS[unit],
  expression: (kind, detail) => `unevaluated ${kind} expression${detail ? ": " + detail : ""}`,
  upTo: (value) => "ไม่เกิน " + value,
  administrations: (frequency, period) => `ให้ยา ${frequency} ครั้ง${period ? "ต่อช่วง " + period : ""}`,
  dosingPeriod: (period) => `ช่วงเวลาการให้ยา ${period}`,
  periodContext: (period) => ` (รอบละ ${period})`,
  startsWithinPeriod: (offset, context) => `เริ่มให้ยาหลังเริ่มรอบ ${offset}${context}`,
  endsWithinPeriod: (offset, context) => `งดยาในช่วง ${offset}สุดท้ายของแต่ละรอบ${context}`,
  treatmentDayStart: "ต้นวันแรกของการรักษา",
  afterPreviousPhase: "หลังขั้นตอนก่อนหน้า",
  nextDayAfterPreviousPhase: "วันถัดจากวันสุดท้ายของขั้นตอนก่อนหน้า",
  afterTreatmentStart: (offset) => `${offset}หลังเริ่มการรักษา`,
  relativeEvent: (offset, event, before) => `${offset}${before ? "ก่อน" : "หลัง"}${event ?? "เหตุการณ์"}`,
  calendarWindow: (start, end) =>
    start && end
      ? `ตั้งแต่${start}จนถึง${end}`
      : start
      ? `ตั้งแต่${start}เป็นต้นไป`
      : end
      ? `จนถึง${end}`
      : "",
  calendarEvents: (events) => "วันที่กำหนด: " + events.join(" และ "),
  reviewTiming: (source) => (source ? `ต้องตรวจสอบช่วงเวลา: ${source}` : "ต้องตรวจสอบช่วงเวลาการใช้ยา"),
  dayRange: (first, last) => `วันที่ ${first}–${last}`,
  fromDay: (first) => `ตั้งแต่วันที่ ${first} เป็นต้นไป`,
  throughDay: (last) => `ถึงวันที่ ${last}`,
  noDoseDays: (first, last) => `งดยาในวันที่ ${first}–${last}.`,
  noDoseWindow: (start, end) => `งดยาตั้งแต่${start}จนถึง${end}.`,
  phaseCount: (count) => `ทำซ้ำระยะนี้รวม ${count} ครั้ง`,
  repeatCount: (count) => `จำนวน ${count} รอบ`,
  repeatCycle: (interval, exact, count) => {
    const iterations = count === undefined ? "" : ` จำนวน ${count} รอบ`;
    return exact
      ? `ทำซ้ำแผนการใช้ยานี้ทุก ${interval}${iterations} (นับระยะเวลาจากจุดเริ่มต้นของแต่ละรอบ).`
      : `ระยะรอบการใช้ยา: ${interval}${iterations}.`;
  },
};
