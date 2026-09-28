/** Declarative surface vocabulary for calendar-date relations in the experiment. */
export const TEMPORAL_DATE_RELATION_SOURCES = {
  startInclusive: String.raw`(?:\bfrom\b\s+|\bsince\b\s+|\bas\s+(?:of|from)\b\s+|\beffective(?:\s+(?:from|as\s+of))?\b\s+|\b(?:starting|beginning|commencing|commence)(?:\s+(?:on|from))?\b\s+|(?:มี\s*ผล\s*ตั้งแต่|ตั้งแต่|นับ\s*(?:ตั้งแต่|จาก|แต่)|เริ่ม(?:\s*(?:ตั้งแต่|ใช้))?)(?:\s*วัน(?:ที่)?)?\s*)`,
  startExclusive: String.raw`(?:\bafter\b\s+|หลัง(?:\s*จาก)?(?:\s*วัน(?:ที่)?)?\s*)`,
  endInclusive: String.raw`(?:\b(?:until|through|till)\b\s+|(?:จน\s*)?ถึง(?:\s*วัน(?:ที่)?)?\s*)`,
  endExclusive: String.raw`(?:\bbefore\b\s+|\bprior(?:\s+to)?\b\s+|ก่อน(?:\s*ถึง)?(?:\s*วัน(?:ที่)?)?\s*)`
} as const;

export const TEMPORAL_RELATION_LEAD_WORDS = new Set([
  'from','since','as','effective','starting','beginning','commencing','commence','after','before','prior','until','through','till',
  'ตั้งแต่','นับ','นับตั้งแต่','นับจาก','เริ่ม','มี','หลัง','ก่อน','ถึง','จน','จนถึง'
]);

export const OPEN_ENDED_WORDS = new Set(['onward','onwards','forward','forwards','ต่อไป']);
