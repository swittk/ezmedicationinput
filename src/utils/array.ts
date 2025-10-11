export function arrayIncludes<T>(values: ReadonlyArray<T>, target: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) {
      return true;
    }
  }
  return false;
}
