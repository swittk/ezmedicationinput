/** Explicit temporal construction vocabulary; no medication or specialty-specific dispatch. */
export const CYCLE_WORDS = {
  dayLead: String.raw`(?:\bon\s+days?\s+|\bdays?\s+|\bD(?=\d)|วันที่ของรอบ\s*)`,
  dayPart: String.raw`\d{1,3}(?:\s*[-–]\s*\d{1,3})?`,
  listSeparator: String.raw`\s*(?:,\s*(?:and\s+|และ\s*)?|and\s+|และ\s*)`,
  periodLead: String.raw`(?:every\s+|q\s*|ทุก\s*)`,
  periodUnit: String.raw`(?:days?\b|d\b|วัน)`,
  startLead: String.raw`(?:starting(?:\s+on)?|from|เริ่ม(?:วันที่)?|ตั้งแต่วันที่)`,
  repeatCount: String.raw`(?:for\s+|x\s*|จำนวน\s*)(\d{1,3})\s*(?:cycles?\b|รอบ)`
};
