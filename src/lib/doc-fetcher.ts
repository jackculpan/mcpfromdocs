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

const MAX_SPEC_SIZE = 10_000_000; // 10MB for OpenAPI specs
const MAX_HTML_SIZE = 80_000;
const MAX_TEXT_SIZE = 500_000;

/** Try to fetch an OpenAPI spec from a URL */
async function tryFetchSpec(specUrl: string, originHost?: string): Promise<FetchedDoc | null> {
  try {
    const res = await fetch(specUrl, {
      headers: { Accept: "application/json, text/yaml, */*" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_SPEC_SIZE) return null;

    // Try JSON parse
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
          const base = new URL(specUrl);
          base.searchParams.set("api", id);
          return tryFetchSpec(base.toString(), originHost);
        }
        if (mainApi.url) {
          const fullUrl = mainApi.url.startsWith("http") ? mainApi.url : new URL(mainApi.url, specUrl).toString();
          return tryFetchSpec(fullUrl, originHost);
        }
        return null;
      }

      if (spec.openapi || spec.swagger || spec.paths) {
        if (originHost && !isRelevantSpec(spec, originHost)) return null;
        return { contentType: "openapi-json", rawText: text };
      }
    } catch {
      // Not JSON — check YAML
      if (text.includes("openapi:") || text.includes("paths:")) {
        return { contentType: "openapi-yaml", rawText: text };
      }
    }
  } catch {}
  return null;
}

/** Check if a spec's metadata plausibly relates to the origin domain */
function isRelevantSpec(spec: Record<string, unknown>, originHost: string): boolean {
  // Extract core domain name (e.g., "coingecko" from "docs.coingecko.com")
  const parts = originHost.replace(/^(www|docs|api|developer|developers)\./, "").split(".");
  const domain = parts[0]?.toLowerCase();
  if (!domain || domain.length < 3) return true; // too short to match reliably

  const info = (spec.info as Record<string, string>) || {};
  const title = (info.title || "").toLowerCase();
  const servers = (spec.servers as Array<{ url: string }>) || [];
  const serverUrls = servers.map((s) => s.url || "").join(" ").toLowerCase();
  const host = ((spec.host as string) || "").toLowerCase();

  // If spec mentions the domain anywhere, it's relevant
  if (title.includes(domain) || serverUrls.includes(domain) || host.includes(domain)) return true;

  // If server URLs point to sandbox/example/localhost, it's a platform default spec
  const allUrls = `${serverUrls} ${host}`;
  if (allUrls.includes("sandbox.") || allUrls.includes("example.com") || allUrls.includes("plant")) return false;

  // No server info — give benefit of doubt
  if (!servers.length && !host) return true;

  return true;
}

/** Try to find spec URLs referenced in HTML content */
function extractSpecUrlsFromHtml(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const origin = new URL(baseUrl).origin;

  // Look for links to OpenAPI/Swagger spec files
  const patterns = [
    /href=["']([^"']*openapi[^"']*\.(?:json|yaml|yml)[^"']*)["']/gi,
    /href=["']([^"']*swagger[^"']*\.(?:json|yaml|yml)[^"']*)["']/gi,
    /["'](\/[^"']*openapi[^"']*\.(?:json|yaml|yml))["']/gi,
    /["'](\/[^"']*swagger[^"']*\.(?:json|yaml|yml))["']/gi,
    /["'](https?:\/\/[^"']*openapi[^"']*\.(?:json|yaml|yml))["']/gi,
    /["'](https?:\/\/[^"']*swagger[^"']*\.(?:json|yaml|yml))["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      if (url.startsWith("http")) {
        urls.push(url);
      } else if (url.startsWith("/")) {
        urls.push(`${origin}${url}`);
      }
    }
  }

  return [...new Set(urls)];
}

export async function fetchDoc(url: string): Promise<FetchedDoc> {
  const parsed = new URL(url);
  const originHost = parsed.hostname;

  // Try common OpenAPI spec paths first
  const specPaths = [
    `${parsed.origin}/openapi.json`,
    `${parsed.origin}/api-reference/openapi.json`,
    `${parsed.origin}/swagger.json`,
    `${parsed.origin}/openapi.yaml`,
    `${parsed.origin}/api/openapi.json`,
    `${parsed.origin}/docs/openapi.json`,
    `${parsed.origin}/api-docs`,
    `${parsed.origin}/swagger/v1/swagger.json`,
    `${parsed.origin}/.well-known/openapi.json`,
    `${parsed.origin}/v2/openapi.json`,
    `${parsed.origin}/v3/api-docs`,
  ];
  for (const specUrl of specPaths) {
    if (specUrl === url) continue;
    const result = await tryFetchSpec(specUrl, originHost);
    if (result) return result;
  }

  // Fetch the original URL
  const res = await fetch(url, {
    headers: { "User-Agent": "MCPFromDocs/1.0", Accept: "application/json, text/yaml, text/html, */*" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);

  const ct = res.headers.get("content-type") || "";
  const text = await res.text();

  // Try to detect OpenAPI spec from content regardless of content-type
  // This handles raw.githubusercontent.com (text/plain) and similar
  if (looksLikeJson(text)) {
    try {
      const spec = JSON.parse(text);
      // Handle Mintlify API list response
      const apiList = Array.isArray(spec) ? spec : spec.apis;
      if (Array.isArray(apiList) && apiList.length > 0) {
        const mainApi = apiList.find((a: Record<string, string>) =>
          a.title?.toLowerCase().includes("api reference") || a.slug?.includes("api-reference")
        ) || apiList[0];
        const id = mainApi.id || mainApi.slug;
        if (id) {
          const base = new URL(url);
          base.searchParams.set("api", id);
          const result = await tryFetchSpec(base.toString(), originHost);
          if (result) return result;
        }
      }
      if (spec.openapi || spec.swagger || spec.paths) {
        if (text.length > MAX_SPEC_SIZE) {
          throw new Error(`OpenAPI spec is ${(text.length / 1_000_000).toFixed(1)}MB. Try a smaller subset or individual API group.`);
        }
        return { contentType: "openapi-json", rawText: text };
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("OpenAPI spec is")) throw e;
      // Not valid JSON or not an OpenAPI spec — continue to other checks
    }
  }

  // Check for YAML OpenAPI spec
  if (looksLikeYaml(text) && text.length <= MAX_SPEC_SIZE) {
    return { contentType: "openapi-yaml", rawText: text };
  }

  // HTML content — strip and extract
  if (ct.includes("html") || text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html")) {
    // Before stripping, try to find spec URLs in the raw HTML
    const specUrls = extractSpecUrlsFromHtml(text, url);
    for (const specUrl of specUrls) {
      const result = await tryFetchSpec(specUrl, originHost);
      if (result) return result;
    }

    const stripped = stripHtml(text);
    if (stripped.length < 200) throw new Error("Page content too minimal — this may be a JavaScript-rendered page. Try pasting the OpenAPI spec URL directly.");
    return { contentType: "html", rawText: stripped };
  }

  // Plain text fallback
  if (text.length > MAX_TEXT_SIZE) {
    throw new Error("Document too large. Try pasting the OpenAPI spec URL directly.");
  }
  return { contentType: "text", rawText: text };
}

/** Quick check if text starts like JSON (avoids parsing huge non-JSON) */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** Quick check if text looks like an OpenAPI YAML spec */
function looksLikeYaml(text: string): boolean {
  return text.startsWith("openapi:") || text.startsWith("swagger:") || text.includes("\npaths:\n");
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

  return text.slice(0, MAX_HTML_SIZE);
}
