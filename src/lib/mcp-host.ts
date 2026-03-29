import type { Env, ServerConfig, EndpointParam } from "../types";
import { getServer } from "./db";

export async function handleMcpRequest(
  request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const config = await getServer(env.DB, env.MCP_CONFIGS, serverId);
  if (!config) {
    return Response.json({ error: "Server not found" }, { status: 404 });
  }
  if (config.expiresAt && Date.now() > config.expiresAt) {
    return Response.json({ error: "Server expired" }, { status: 410 });
  }

  // Use get() to cache the Dynamic Worker per serverId — the callback only
  // runs when the worker isn't already loaded, avoiding repeated code generation.
  const worker = env.LOADER.get(serverId, () => ({
    compatibilityDate: "2025-03-10",
    mainModule: "src/index.js",
    modules: {
      "src/index.js": generateMcpWorkerCode(config),
    },
  }));

  return worker.getEntrypoint().fetch(request);
}

// ---------------------------------------------------------------------------
// Generate self-contained JavaScript for a Dynamic Worker that implements
// both MCP Streamable HTTP (/mcp) and legacy SSE (/sse) transports.
// ---------------------------------------------------------------------------
function generateMcpWorkerCode(config: ServerConfig): string {
  const tools = config.endpoints.map((ep) => ({
    name: ep.id,
    description: ep.description.slice(0, 200),
    inputSchema: buildJsonSchema(ep.parameters),
  }));

  // All config is embedded as constants — the dynamic worker is fully self-contained.
  return `
const SERVER_NAME = ${JSON.stringify(config.name)};
const SERVER_ID = ${JSON.stringify(config.id)};
const BASE_URL = ${JSON.stringify(config.baseUrl)};
const AUTH_SCHEME = ${JSON.stringify(config.authScheme)};
const API_KEY = ${JSON.stringify(config.userApiKey || "")};
const ENDPOINTS = ${JSON.stringify(config.endpoints)};
const TOOLS = ${JSON.stringify(tools)};

// SSE session management — keyed by internal session counter
const sseSessions = new Map();
let sessionCounter = 0;
const encoder = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // SSE connect: GET /sse/{serverId}
    if (request.method === "GET" && url.pathname.match(/^\\/sse\\//)) {
      return handleSseConnect(url);
    }

    // SSE message: POST /sse/message?sessionId={serverId}
    if (request.method === "POST" && url.pathname === "/sse/message") {
      return handleSseMessage(request);
    }

    // Streamable HTTP: POST /mcp/{serverId}
    if (request.method === "POST" && url.pathname.match(/^\\/mcp\\//)) {
      return handleStreamableHttp(request);
    }

    return new Response(SERVER_NAME + " MCP Server — connect via /sse or /mcp", {
      headers: { ...CORS, "content-type": "text/plain" },
    });
  },
};

// ---- SSE transport ----------------------------------------------------------

function handleSseConnect(url) {
  const sessId = "s" + (++sessionCounter);
  const origin = url.origin;

  const stream = new ReadableStream({
    start(controller) {
      sseSessions.set(sessId, controller);
      const endpointUrl = origin + "/sse/message?sessionId=" + SERVER_ID;
      controller.enqueue(encoder.encode("event: endpoint\\ndata: " + endpointUrl + "\\n\\n"));
    },
    cancel() {
      sseSessions.delete(sessId);
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

async function handleSseMessage(request) {
  // Route to the most-recent active SSE controller
  let controller = null;
  for (const [, c] of sseSessions) controller = c;
  if (!controller) {
    return new Response(JSON.stringify({ error: "No active SSE session" }), {
      status: 404,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const body = await request.json();
  const response = await processJsonRpc(body);

  if (response) {
    const data = JSON.stringify(response);
    controller.enqueue(encoder.encode("event: message\\ndata: " + data + "\\n\\n"));
  }

  return new Response("accepted", { status: 202, headers: CORS });
}

// ---- Streamable HTTP transport (/mcp) --------------------------------------

async function handleStreamableHttp(request) {
  const body = await request.json();
  const isBatch = Array.isArray(body);
  const reqs = isBatch ? body : [body];
  const responses = [];

  for (const r of reqs) {
    const res = await processJsonRpc(r);
    if (res) responses.push(res);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS });
  }

  return new Response(JSON.stringify(isBatch ? responses : responses[0]), {
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// ---- JSON-RPC handler -------------------------------------------------------

async function processJsonRpc(req) {
  const { method, params, id } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: "1.0.0" },
      },
      id,
    };
  }

  // Notifications — no response expected
  if (method === "notifications/initialized") return null;

  if (method === "ping") {
    return { jsonrpc: "2.0", result: {}, id };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", result: { tools: TOOLS }, id };
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const endpoint = ENDPOINTS.find(function (ep) { return ep.id === name; });
    if (!endpoint) {
      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: "Unknown tool: " + name },
        id,
      };
    }

    try {
      const result = await executeToolCall(endpoint, args || {});
      return {
        jsonrpc: "2.0",
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
        id,
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        result: {
          content: [{ type: "text", text: "Error: " + err.message }],
          isError: true,
        },
        id,
      };
    }
  }

  return {
    jsonrpc: "2.0",
    error: { code: -32601, message: "Method not found: " + method },
    id,
  };
}

// ---- Tool execution (API calls) ---------------------------------------------

async function executeToolCall(endpoint, params) {
  let path = endpoint.path;
  for (const p of endpoint.parameters.filter(function (p) { return p.location === "path"; })) {
    const val = params[p.name];
    if (val !== undefined && val !== "") {
      path = path.replace("{" + p.name + "}", encodeURIComponent(String(val)));
    } else if (p.required) {
      return { error: "Missing required path parameter: " + p.name };
    }
  }

  const url = new URL(path, BASE_URL);

  for (const p of endpoint.parameters.filter(function (p) { return p.location === "query"; })) {
    const val = params[p.name];
    if (val !== undefined && val !== "") url.searchParams.set(p.name, String(val));
  }

  const bodyParams = endpoint.parameters.filter(function (p) { return p.location === "body"; });
  let body = undefined;
  if (bodyParams.length > 0 && endpoint.method !== "GET") {
    const bodyObj = {};
    for (const p of bodyParams) {
      if (params[p.name] !== undefined) bodyObj[p.name] = params[p.name];
    }
    body = JSON.stringify(bodyObj);
  }

  const headers = { "Content-Type": "application/json" };
  if (API_KEY) {
    if (AUTH_SCHEME.type === "bearer") {
      headers["Authorization"] = "Bearer " + API_KEY;
    } else if (AUTH_SCHEME.type === "api_key_header") {
      headers[AUTH_SCHEME.headerName || "X-API-Key"] = API_KEY;
    } else if (AUTH_SCHEME.type === "api_key_query") {
      url.searchParams.set(AUTH_SCHEME.queryParam || "api_key", API_KEY);
    } else if (AUTH_SCHEME.type === "basic") {
      headers["Authorization"] = "Basic " + btoa(API_KEY);
    }
  }

  const res = await fetch(url.toString(), {
    method: endpoint.method,
    headers: headers,
    body: body,
  });

  if (!res.ok) {
    const error = await res.text();
    return { error: "API returned " + res.status + ": " + error.slice(0, 500) };
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return { text: await res.text() };
}
`;
}

// ---------------------------------------------------------------------------
// Convert EndpointParam[] → JSON Schema (for MCP tool inputSchema)
// ---------------------------------------------------------------------------
function buildJsonSchema(params: EndpointParam[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of params) {
    const prop: Record<string, unknown> = {};
    if (p.enumValues?.length) {
      prop.type = "string";
      prop.enum = p.enumValues;
    } else {
      const typeMap: Record<string, string> = {
        string: "string",
        number: "number",
        boolean: "boolean",
        array: "array",
        object: "object",
      };
      prop.type = typeMap[p.type] || "string";
      if (p.type === "array") prop.items = { type: "string" };
    }
    if (p.description) prop.description = p.description.slice(0, 150);
    if (p.default !== undefined) prop.default = p.default;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
