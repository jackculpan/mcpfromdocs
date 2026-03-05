import type { ServerConfig, ParsedEndpoint } from "../types";

export async function executeToolCall(
  config: ServerConfig,
  endpoint: ParsedEndpoint,
  params: Record<string, unknown>,
): Promise<unknown> {
  // Build path with path params substituted
  let path = endpoint.path;
  for (const p of endpoint.parameters.filter((p) => p.location === "path")) {
    const val = params[p.name];
    if (val !== undefined && val !== "") {
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)));
    } else if (p.required) {
      return { error: `Missing required path parameter: ${p.name}` };
    }
  }
  // Fail if any unreplaced path params remain
  const unresolved = path.match(/\{[^}]+\}/);
  if (unresolved) {
    return { error: `Missing path parameter: ${unresolved[0]}` };
  }

  // Build URL
  const url = new URL(path, config.baseUrl);

  // Add query params
  for (const p of endpoint.parameters.filter((p) => p.location === "query")) {
    const val = params[p.name];
    if (val !== undefined && val !== "") url.searchParams.set(p.name, String(val));
  }

  // Build body from body params
  const bodyParams = endpoint.parameters.filter((p) => p.location === "body");
  let body: string | undefined;
  if (bodyParams.length > 0) {
    const bodyObj: Record<string, unknown> = {};
    for (const p of bodyParams) {
      if (params[p.name] !== undefined) bodyObj[p.name] = params[p.name];
    }
    body = JSON.stringify(bodyObj);
  }

  // Build headers with auth
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = config.userApiKey;

  if (apiKey) {
    const { authScheme } = config;
    if (authScheme.type === "bearer") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (authScheme.type === "api_key_header") {
      headers[authScheme.headerName || "X-API-Key"] = apiKey;
    } else if (authScheme.type === "api_key_query") {
      url.searchParams.set(authScheme.queryParam || "api_key", apiKey);
    } else if (authScheme.type === "basic") {
      headers["Authorization"] = `Basic ${btoa(apiKey)}`;
    }
  }

  const res = await fetch(url.toString(), {
    method: endpoint.method,
    headers,
    body: endpoint.method !== "GET" ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const error = await res.text();
    return { error: `API returned ${res.status}: ${error.slice(0, 500)}` };
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return { text: await res.text() };
}
