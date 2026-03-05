import type { Env } from "./types";
import { handleParse } from "./routes/parse";
import { handleGenerate } from "./routes/generate";
import { handleDeploy } from "./routes/deploy";
import { handleChat } from "./routes/chat";
import { handleCreateCheckout, handleWebhook } from "./routes/purchase";
import { getServer } from "./lib/db";
import { proxyToMcpHost } from "./lib/mcp-host";

export { McpHostDO } from "./lib/mcp-host";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function cors(response: Response | Promise<Response>): Promise<Response> {
  return Promise.resolve(response).then((res) => {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API routes
    if (request.method === "POST") {
      if (url.pathname === "/api/parse") return cors(handleParse(request, env));
      if (url.pathname === "/api/generate") return cors(handleGenerate(request));
      if (url.pathname === "/api/deploy") return cors(handleDeploy(request, env));
      if (url.pathname === "/api/chat") return cors(handleChat(request, env));
      if (url.pathname === "/api/purchase/checkout") return cors(handleCreateCheckout(request, env));
      if (url.pathname === "/api/purchase/webhook") return handleWebhook(request, env);
    }

    // Server info
    if (request.method === "GET" && url.pathname.startsWith("/api/server/")) {
      const serverId = url.pathname.split("/api/server/")[1];
      if (serverId) {
        const server = await getServer(env.DB, env.MCP_CONFIGS, serverId);
        if (!server) return cors(Response.json({ error: "Not found" }, { status: 404 }));
        return cors(Response.json({
          id: server.id,
          name: server.name,
          status: server.status,
          expiresAt: server.expiresAt,
          endpointCount: server.endpoints.length,
        }));
      }
    }

    // MCP proxy: /sse/{serverId} and /mcp/{serverId}
    const sseMatch = url.pathname.match(/^\/sse\/([a-z0-9]+)(\/.*)?$/);
    if (sseMatch) return proxyToMcpHost(request, env, sseMatch[1], "sse");

    const mcpMatch = url.pathname.match(/^\/mcp\/([a-z0-9]+)(\/.*)?$/);
    if (mcpMatch) return proxyToMcpHost(request, env, mcpMatch[1], "mcp");

    // Static assets handled by wrangler assets config
    return new Response("Not found", { status: 404 });
  },
};
