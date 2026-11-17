/** Thai course wording. Keep locale realization separate from shared
 * interval/count/condition semantics; this is a facet of SigLocalization. */
import type { CourseLanguage } from "./types";
import { DAY_NAMES_THAI, joinWithAndThai } from "../../i18n";
const UNITS: Readonly<Record<string, string>> = {
  s: "วินาที",
  min: "นาที",
  h: "ชั่วโมง",
  d: "วัน",
  wk: "สัปดาห์",
  mo: "เดือน",
  a: "ปี",
};
export const THAI_COURSE: CourseLanguage = {
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
  rateLabel: "อัตราการให้ยา: ",
  rateRangeLabel: "ช่วงอัตราการให้ยา: ",
  unspecified: "ไม่ระบุค่า",
  treatmentStart: "เริ่มการรักษา",
  incompleteInterpretation: "ข้อมูลบางส่วนเท่านั้น — ต้องตรวจสอบข้อจำกัดการใช้ยา",
  retainedStructure: "Structured FHIR data is retained",
  // Preserve the established output surface. These technical fallback labels
  // can later be translated here without touching clinical interpretation.
  maxAdministrationLabel: "max per administration: ",
  maxLifetimeLabel: "max lifetime: ",
  maxPeriodLabel: "max per period: ",
  weekdayName: (day) => DAY_NAMES_THAI[day] ?? day,
  joinList: (items) => joinWithAndThai(items as string[]),
  timeUnit: (unit) => UNITS[unit],
  expression: (kind, detail) => `unevaluated ${kind} expression${detail ? ": " + detail : ""}`,
  upTo: (value) => "ไม่เกิน " + value,
  administrations: (frequency, period) => `ให้ยา ${frequency} ครั้ง${period ? "ต่อช่วง " + period : ""}`,
  dosingPeriod: (period) => `ช่วงเวลาการให้ยา ${period}`,
  periodContext: (period) => ` (รอบละ ${period})`,
  startsWithinPeriod: (offset, context) => `เริ่มให้ยาหลังเริ่มรอบ ${offset}${context}`,
  endsWithinPeriod: (offset, context) => `งดยาในช่วง ${offset}สุดท้ายของแต่ละรอบ${context}`,
  afterTreatmentStart: (offset) => `${offset}หลังเริ่มการรักษา`,
  calendarWindow: (start, end) =>
    start && end
      ? `ตั้งแต่${start}จนถึง${end}`
      : start
      ? `ตั้งแต่${start}เป็นต้นไป`
      : end
      ? `จนถึง${end}`
      : "",
  reviewTiming: (source) => (source ? `ต้องตรวจสอบช่วงเวลา: ${source}` : "ต้องตรวจสอบช่วงเวลาการใช้ยา"),
  dayRange: (first, last) => `วันที่ ${first}–${last}`,
  fromDay: (first) => `ตั้งแต่วันที่ ${first} เป็นต้นไป`,
  throughDay: (last) => `ถึงวันที่ ${last}`,
  noDoseDays: (first, last) => `งดยาในวันที่ ${first}–${last}.`,
  repeatCount: (count) => `จำนวน ${count} รอบ`,
  repeatCycle: (interval, exact, count) => {
    const iterations = count === undefined ? "" : ` จำนวน ${count} รอบ`;
    return exact
      ? `ทำซ้ำแผนการใช้ยานี้ทุก ${interval}${iterations} (นับวันที่ใหม่ในแต่ละรอบ).`
      : `ระยะรอบการใช้ยา: ${interval}${iterations}.`;
  },
};
