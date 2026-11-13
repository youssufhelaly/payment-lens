export type Scalar = string | number | boolean | null;

/** Flattens nested data into dot paths ("outcome.network_status") so citations can name exact fields. */
export function flatten(value: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  walk(value, "", out);
  return out;
}

function walk(value: unknown, path: string, out: Record<string, Scalar>): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object") {
    if (path !== "") out[path] = value as Scalar;
    return;
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  for (const [key, child] of entries) walk(child, path === "" ? key : `${path}.${key}`, out);
}
