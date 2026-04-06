/**
 * Appends Rhombus federated-token query parameters without breaking existing query strings.
 */
export function appendFederatedAuthQueryParams(url: string, federatedToken: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const base =
      typeof globalThis !== "undefined" && "location" in globalThis && globalThis.location?.origin
        ? globalThis.location.origin
        : "https://local.invalid";
    parsed = new URL(url, base);
  }
  parsed.searchParams.set("x-auth-scheme", "federated-token");
  parsed.searchParams.set("x-auth-ft", federatedToken);
  return parsed.toString();
}

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
