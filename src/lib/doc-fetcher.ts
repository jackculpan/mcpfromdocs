export interface FetchedDoc {
  contentType: "openapi-json" | "openapi-yaml" | "html" | "text";
  rawText: string;
}

export function detectInputType(input: string): "url" | "openapi-json" | "openapi-yaml" | "text" {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return "url";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.openapi || parsed.swagger || parsed.paths) return "openapi-json";
  } catch {}
  if (trimmed.startsWith("openapi:") || trimmed.startsWith("swagger:") || trimmed.includes("\npaths:\n")) {
    return "openapi-yaml";
  }
  return "text";
}

// Try to fetch an OpenAPI spec from common paths
async function tryFetchSpec(specUrl: string): Promise<FetchedDoc | null> {
  try {
    const res = await fetch(specUrl, {
      headers: { Accept: "application/json, text/yaml" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const spec = JSON.parse(text);
      // Mintlify returns { apis: [...] } or an array at /openapi.json
      const apiList = Array.isArray(spec) ? spec : spec.apis;
      if (Array.isArray(apiList) && apiList.length > 0) {
        // Pick the largest/main API (usually "API Reference") or first one
        const mainApi = apiList.find((a: Record<string, string>) =>
          a.title?.toLowerCase().includes("api reference") || a.slug?.includes("api-reference")
        ) || apiList[0];
        const id = mainApi.id || mainApi.slug;
        if (id) {
          const base = new URL(specUrl);
          base.searchParams.set("api", id);
          return tryFetchSpec(base.toString());
        }
        if (mainApi.url) {
          const fullUrl = mainApi.url.startsWith("http") ? mainApi.url : new URL(mainApi.url, specUrl).toString();
          return tryFetchSpec(fullUrl);
        }
        return null;
      }
      if (spec.openapi || spec.swagger || spec.paths) return { contentType: "openapi-json", rawText: text };
    } catch {
      if (text.includes("openapi:") || text.includes("paths:")) return { contentType: "openapi-yaml", rawText: text };
    }
  } catch {}
  return null;
}

export async function fetchDoc(url: string): Promise<FetchedDoc> {
  const parsed = new URL(url);

  // Try common OpenAPI spec paths first
  const specPaths = [
    `${parsed.origin}/openapi.json`,
    `${parsed.origin}/api-reference/openapi.json`,
    `${parsed.origin}/swagger.json`,
    `${parsed.origin}/openapi.yaml`,
  ];
  for (const specUrl of specPaths) {
    if (specUrl === url) continue;
    const result = await tryFetchSpec(specUrl);
    if (result) return result;
  }

  // Fall back to fetching the original URL
  const res = await fetch(url, {
    headers: { "User-Agent": "MCPFromDocs/1.0", Accept: "application/json, text/yaml, text/html, */*" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);

  const text = await res.text();

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    try {
      const spec = JSON.parse(text);
      // Handle Mintlify API list response { apis: [...] } or array
      const apiList = Array.isArray(spec) ? spec : spec.apis;
      if (Array.isArray(apiList) && apiList.length > 0) {
        const mainApi = apiList.find((a: Record<string, string>) =>
          a.title?.toLowerCase().includes("api reference") || a.slug?.includes("api-reference")
        ) || apiList[0];
        const id = mainApi.id || mainApi.slug;
        if (id) {
          const base = new URL(url);
          base.searchParams.set("api", id);
          const result = await tryFetchSpec(base.toString());
          if (result) return result;
        }
      }
      if (spec.openapi || spec.swagger || spec.paths) return { contentType: "openapi-json", rawText: text };
    } catch {}
  }
  if (ct.includes("yaml") || ct.includes("yml")) return { contentType: "openapi-yaml", rawText: text };
  if (ct.includes("html")) {
    const stripped = stripHtml(text);
    if (stripped.length > 80_000) throw new Error("Document too large after stripping HTML. Try pasting the OpenAPI spec URL directly.");
    return { contentType: "html", rawText: stripped };
  }
  if (text.length > 500_000) throw new Error("Document too large. Try pasting the OpenAPI spec URL directly.");
  return { contentType: "text", rawText: text };
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");

  // Extract main content if available
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mainMatch) text = mainMatch[1];

  // Strip remaining tags, decode entities, collapse whitespace
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, 80_000);
}
