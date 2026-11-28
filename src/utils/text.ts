export function isWhitespaceChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    code <= 0x20 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function isAsciiPunctuationCode(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

export function isLoosePhraseSeparatorChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    isWhitespaceChar(char) ||
    isAsciiPunctuationCode(code) ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x2e00 && code <= 0x2e7f) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

/** Short lexical keys are pure string facts shared across grammar, site,
 * symptom and suggestion lookups. Avoid normalizing the same token repeatedly
 * in one parse. This bounded string cache never retains a parsed object or
 * changes behavior when custom dictionaries/locale packs are registered. */
const loosePhraseKeys=new Map<string,string>();
const LOOSE_KEY_CACHE_LIMIT=4096;
export function normalizeLoosePhraseKey(value: string): string {
  const retain=value.length<=128;
  if(retain){const cached=loosePhraseKeys.get(value);if(cached!==undefined)return cached;}
  const lowered = value.trim().toLowerCase();
  let normalized = "";
  let pendingSpace = false;

  for (const char of lowered) {
    if (isLoosePhraseSeparatorChar(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }

    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }

    normalized += char;
  }

  const result=normalized.trim();
  if(retain){
    if(loosePhraseKeys.size>=LOOSE_KEY_CACHE_LIMIT)loosePhraseKeys.delete(loosePhraseKeys.keys().next().value!);
    loosePhraseKeys.set(value,result);
  }
  return result;
}

/** Single-pass list join with historical comma/conjunction placement.
 * No slice() plus join() array allocation. */
export function joinLocalizedList(parts: readonly string[], conjunction: string): string {
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  let text = parts[0];
  for (let index = 1; index < parts.length - 1; index++) text += ", " + parts[index];
  return text + " " + conjunction + " " + parts[parts.length - 1];
}
