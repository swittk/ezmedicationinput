/** Declarative surface vocabulary for calendar-date relations in the experiment. */
export const TEMPORAL_DATE_RELATION_SOURCES = {
  startInclusive: String.raw`(?:\bfrom\b\s+|\bsince\b\s+|\bas\s+(?:of|from)\b\s+|\b(?:starting|beginning)(?:\s+(?:on|from))?\b\s+|(?:ตั้งแต่|นับ\s*(?:ตั้งแต่|จาก|แต่)|เริ่ม(?:\s*ตั้งแต่)?)(?:\s*วันที่)?\s*)`,
  startExclusive: String.raw`(?:\bafter\b\s+|หลัง(?:\s*จาก)?(?:\s*วันที่)?\s*)`,
  endInclusive: String.raw`(?:\b(?:until|through|till)\b\s+|(?:จน\s*)?ถึง(?:\s*วันที่)?\s*)`,
  endExclusive: String.raw`(?:\bbefore\b\s+|\bprior\s+to\b\s+|ก่อน(?:\s*ถึง)?(?:\s*วันที่)?\s*)`
} as const;

export const TEMPORAL_RELATION_LEAD_WORDS = new Set([
  'from','since','as','starting','beginning','after','before','until','through','till',
  'ตั้งแต่','นับ','นับตั้งแต่','นับจาก','เริ่ม','หลัง','ก่อน','ถึง','จน','จนถึง'
]);

export const OPEN_ENDED_WORDS = new Set(['onward','onwards','ต่อไป']);
