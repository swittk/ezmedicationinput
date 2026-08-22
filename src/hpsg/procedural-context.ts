import { parseInstructionActions } from "../instruction-graph";
import type { AdviceFrame } from "../types";
import type { HpsgClauseContext } from "./rule-context";

const PROCEDURAL_FRAME_CACHE = new WeakMap<object, AdviceFrame[]>();

/**
 * Parse procedural semantics once per ParserState and share the result across
 * HPSG lexical constructions. Keeping this cache at the HPSG context layer
 * avoids each rule family independently running the instruction parser.
 */
export function getProceduralFrames(context: HpsgClauseContext): AdviceFrame[] {
  const cached = PROCEDURAL_FRAME_CACHE.get(context.state);
  if (cached) return cached;
  const frames = parseInstructionActions(context.state.input, 0, context.options);
  PROCEDURAL_FRAME_CACHE.set(context.state, frames);
  return frames;
}
