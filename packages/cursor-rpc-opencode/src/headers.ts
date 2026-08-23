const SENSITIVE_HEADER = /api-?key|token|secret|authorization/i;

export function sanitizeProviderHeaders(
  headers: Headers | Record<string, string> | undefined,
): Headers | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const input = new Headers(headers);
  const output = new Headers();
  for (const [name, value] of input.entries()) {
    if (name === "cookie" || SENSITIVE_HEADER.test(name)) {
      continue;
    }
    output.set(name, value);
  }
  return output;
}
