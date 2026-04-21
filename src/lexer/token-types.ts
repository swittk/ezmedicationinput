export enum SurfaceTokenKind {
  Text = "TEXT",
  Separator = "SEPARATOR",
  Punctuation = "PUNCTUATION"
}

export enum LexKind {
  Word = "WORD",
  Number = "NUMBER",
  NumberRange = "NUMBER_RANGE",
  Ordinal = "ORDINAL",
  TimeLike = "TIME_LIKE",
  Separator = "SEPARATOR",
  Punctuation = "PUNCTUATION"
}

export interface SurfaceToken {
  original: string;
  lower: string;
  index: number;
  kind: SurfaceTokenKind;
  start: number;
  end: number;
}

export interface LexToken {
  original: string;
  lower: string;
  index: number;
  kind: LexKind;
  value?: number;
  low?: number;
  high?: number;
  sourceStart: number;
  sourceEnd: number;
  surfaceIndices: number[];
  sourceText?: string;
  derived?: true;
}
