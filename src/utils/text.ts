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

export function normalizeLoosePhraseKey(value: string): string {
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

  return normalized.trim();
}
