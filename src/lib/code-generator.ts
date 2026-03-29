import type { ParsedAPI, ParsedEndpoint, EndpointParam, GenerateRequest } from "../types";

export function generateFiles(req: GenerateRequest): Record<string, string> {
  const { api, selectedEndpointIds, serverName, authEnvVar } = req;
  const selected = api.endpoints.filter((e) => selectedEndpointIds.includes(e.id));
  const files: Record<string, string> = {};

  files["package.json"] = genPackageJson(serverName);
  files["wrangler.jsonc"] = genWrangler(serverName, authEnvVar);
  files["tsconfig.json"] = genTsconfig();
  files["src/index.ts"] = genServerCode(api, selected, serverName, authEnvVar);
  files["README.md"] = genReadme(serverName, api, selected);

  return files;
}

function genPackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.26.0",
      zod: "^3.24.0",
    },
    devDependencies: {
      "@cloudflare/workers-types": "^4.20260301.0",
      typescript: "^5.7.3",
      wrangler: "^4.0.0",
    },
  }, null, 2);
}

function genWrangler(name: string, authEnvVar: string): string {
  return JSON.stringify({
    name,
    main: "src/index.ts",
    compatibility_date: "2025-03-10",
    compatibility_flags: ["nodejs_compat"],
    vars: { [authEnvVar]: "YOUR_API_KEY_HERE" },
    worker_loaders: [{ binding: "LOADER" }],
  }, null, 2);
}

function genTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "bundler",
      lib: ["ES2022"],
      types: ["@cloudflare/workers-types"],
      strict: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noEmit: true,
      isolatedModules: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2);
}

function genServerCode(api: ParsedAPI, endpoints: ParsedEndpoint[], serverName: string, authEnvVar: string): string {
  const toolRegistrations = endpoints.map((ep) => genToolDef(ep)).join(",\n");
  const endpointConsts = endpoints.map((ep) => genEndpointConst(ep)).join(",\n");

  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  LOADER: {
    load(opts: unknown): { getEntrypoint(): { fetch(req: Request): Promise<Response> } };
    get(id: string, cb: () => unknown): { getEntrypoint(): { fetch(req: Request): Promise<Response> } };
  };
  ${authEnvVar}: string;
};

// ---- Tool & endpoint definitions -------------------------------------------

const TOOLS = [
${toolRegistrations}
];

const ENDPOINTS: Array<{
  id: string; method: string; path: string;
  parameters: Array<{ name: string; type: string; required: boolean; location: string; description: string }>;
}> = [
${endpointConsts}
];

// ---- Dynamic Worker code template ------------------------------------------

function buildMcpWorkerCode(apiKey: string): string {
  return \`
const SERVER_NAME = ${JSON.stringify(JSON.stringify(api.name))};
const BASE_URL = ${JSON.stringify(JSON.stringify(api.baseUrl))};
const AUTH_SCHEME = ${JSON.stringify(JSON.stringify(api.authScheme))};
const ENDPOINTS = \${JSON.stringify(ENDPOINTS)};
const TOOLS = \${JSON.stringify(TOOLS)};
const API_KEY = \${JSON.stringify(apiKey)};

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
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (request.method === "GET" && url.pathname === "/sse")
      return handleSseConnect(url);
    if (request.method === "POST" && url.pathname === "/sse/message")
      return handleSseMessage(request);
    if (request.method === "POST" && url.pathname === "/mcp")
      return handleMcp(request);

    return new Response(SERVER_NAME + " MCP Server — connect via /sse or /mcp", {
      headers: { ...CORS, "content-type": "text/plain" },
    });
  },
};

function handleSseConnect(url) {
  const sessId = "s" + (++sessionCounter);
  const stream = new ReadableStream({
    start(controller) {
      sseSessions.set(sessId, controller);
      const endpoint = url.origin + "/sse/message?sessionId=" + sessId;
      controller.enqueue(encoder.encode("event: endpoint\\\\ndata: " + endpoint + "\\\\n\\\\n"));
    },
    cancel() { sseSessions.delete(sessId); },
  });
  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function handleSseMessage(request) {
  const url = new URL(request.url);
  const sessId = url.searchParams.get("sessionId");
  const controller = sseSessions.get(sessId);
  if (!controller) return new Response("Session not found", { status: 404, headers: CORS });
  const body = await request.json();
  const response = await processJsonRpc(body);
  if (response) {
    controller.enqueue(encoder.encode("event: message\\\\ndata: " + JSON.stringify(response) + "\\\\n\\\\n"));
  }
  return new Response("accepted", { status: 202, headers: CORS });
}

async function handleMcp(request) {
  const body = await request.json();
  const isBatch = Array.isArray(body);
  const reqs = isBatch ? body : [body];
  const responses = [];
  for (const r of reqs) { const res = await processJsonRpc(r); if (res) responses.push(res); }
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
  return new Response(JSON.stringify(isBatch ? responses : responses[0]), {
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function processJsonRpc(req) {
  const { method, params, id } = req;
  if (method === "initialize") {
    return { jsonrpc: "2.0", result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: "1.0.0" } }, id };
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", result: {}, id };
  if (method === "tools/list") return { jsonrpc: "2.0", result: { tools: TOOLS }, id };
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const endpoint = ENDPOINTS.find(function (ep) { return ep.id === name; });
    if (!endpoint) return { jsonrpc: "2.0", error: { code: -32601, message: "Unknown tool: " + name }, id };
    try {
      const result = await executeToolCall(endpoint, args || {});
      return { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }, id };
    } catch (err) {
      return { jsonrpc: "2.0", result: { content: [{ type: "text", text: "Error: " + err.message }], isError: true }, id };
    }
  }
  return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id };
}

async function executeToolCall(endpoint, params) {
  let path = endpoint.path;
  for (const p of endpoint.parameters.filter(function (p) { return p.location === "path"; })) {
    const val = params[p.name];
    if (val !== undefined && val !== "") path = path.replace("{" + p.name + "}", encodeURIComponent(String(val)));
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
    for (const p of bodyParams) { if (params[p.name] !== undefined) bodyObj[p.name] = params[p.name]; }
    body = JSON.stringify(bodyObj);
  }
  const headers = { "Content-Type": "application/json" };
${genDynamicAuthBlock(api, authEnvVar)}
  const res = await fetch(url.toString(), { method: endpoint.method, headers: headers, body: body });
  if (!res.ok) { const error = await res.text(); return { error: "API returned " + res.status + ": " + error.slice(0, 500) }; }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return { text: await res.text() };
}
\`;
}

// ---- Main Worker (loads MCP Dynamic Worker on each request) ----------------

const MCP_WORKER_ID = "${serverName}-mcp";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Both /sse and /mcp transports are handled by the Dynamic Worker
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/") || url.pathname === "/mcp") {
      const worker = env.LOADER.get(MCP_WORKER_ID, () => ({
        compatibilityDate: "2025-03-10",
        mainModule: "src/index.js",
        modules: {
          "src/index.js": buildMcpWorkerCode(env.${authEnvVar}),
        },
      }));
      return worker.getEntrypoint().fetch(request);
    }

    return new Response("${api.name} MCP Server. Connect via /sse or /mcp", {
      headers: { "content-type": "text/plain" },
    });
  },
};
`;
}

function genDynamicAuthBlock(api: ParsedAPI, _authEnvVar: string): string {
  const { authScheme } = api;
  if (authScheme.type === "bearer") {
    return `  if (API_KEY) headers["Authorization"] = "Bearer " + API_KEY;`;
  }
  if (authScheme.type === "api_key_header") {
    return `  if (API_KEY) headers["${authScheme.headerName || "X-API-Key"}"] = API_KEY;`;
  }
  if (authScheme.type === "api_key_query") {
    return `  if (API_KEY) url.searchParams.set("${authScheme.queryParam || "api_key"}", API_KEY);`;
  }
  if (authScheme.type === "basic") {
    return `  if (API_KEY) headers["Authorization"] = "Basic " + btoa(API_KEY);`;
  }
  return `  // No auth configured`;
}

function genToolDef(ep: ParsedEndpoint): string {
  const schema = buildJsonSchemaForGen(ep.parameters);
  return `  {
    name: ${JSON.stringify(ep.id)},
    description: ${JSON.stringify(ep.description.slice(0, 200))},
    inputSchema: ${JSON.stringify(schema)}
  }`;
}

function genEndpointConst(ep: ParsedEndpoint): string {
  return `  ${JSON.stringify({
    id: ep.id,
    method: ep.method,
    path: ep.path,
    parameters: ep.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      location: p.location,
      description: p.description,
    })),
  })}`;
}

function buildJsonSchemaForGen(params: EndpointParam[]): Record<string, unknown> {
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

function genReadme(name: string, api: ParsedAPI, endpoints: ParsedEndpoint[]): string {
  const toolList = endpoints.map((ep) => `- **${ep.id}** - ${ep.method} ${ep.path} - ${ep.description}`).join("\n");
  return `# ${name}

MCP server for ${api.name}, generated by [mcpfromdocs.com](https://mcpfromdocs.com).

Powered by [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) — each MCP
server runs as a lightweight, sandboxed Dynamic Worker that spins up in milliseconds.

## Setup

\`\`\`bash
npm install
\`\`\`

Edit \`wrangler.jsonc\` and set your API key, then deploy:

\`\`\`bash
npx wrangler deploy
\`\`\`

## Tools

${toolList}

## Connect

- SSE: \`https://your-worker.workers.dev/sse\`
- Streamable HTTP: \`https://your-worker.workers.dev/mcp\`
`;
}
