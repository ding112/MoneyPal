export function atLeastVersion(actual: string, minimum: string): boolean {
  return compareVersion(actual, minimum) >= 0;
}

export function compareVersion(left: string, right: string): number {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function versionParts(value: string): number[] {
  if (!/^\d+(?:\.\d+)*$/u.test(value)) throw new Error("invalid runtime version");
  return value.split(".").map(Number);
}
