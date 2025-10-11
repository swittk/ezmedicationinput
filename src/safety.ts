import { DISCOURAGED_TOKENS } from "./maps";
import { ParseOptions } from "./types";

export interface DiscouragedCheckResult {
  warnings: string[];
}

export function checkDiscouraged(
  token: string,
  options?: ParseOptions
): { allowed: boolean; warning?: string } {
  const lower = token.toLowerCase();
  if (!(lower in DISCOURAGED_TOKENS)) {
    return { allowed: true };
  }
  const code = DISCOURAGED_TOKENS[lower];
  if (options && options.allowDiscouraged === false) {
    throw new Error(`Discouraged token '${token}' is not allowed`);
  }
  return { allowed: true, warning: `${code} is discouraged` };
}
