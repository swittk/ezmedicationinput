export function normalizeCandidateModulePath(filename: string, pathApi?: { resolve(...paths: string[]): string }): string;
export function candidateTransform(source: string, filename: string): string | undefined;
export function candidatePlugin(): import('vite').Plugin;
