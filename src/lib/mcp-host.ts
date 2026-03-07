import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import type { Env, ServerConfig, ParsedEndpoint, EndpointParam } from "../types";
import { getServer } from "./db";
import { executeToolCall } from "./tool-executor";

export class McpHostDO extends McpAgent<Env> {
  server = new McpServer({ name: "mcpfromdocs", version: "1.0.0" });
  private config: ServerConfig | null = null;

  async init() {
    // Server ID is stored in DO storage (set on first request via proxy)
    const serverId = (await this.ctx.storage.get("serverId")) as string | undefined;
    if (!serverId) return;

    const config = await getServer(this.env.DB, this.env.MCP_CONFIGS, serverId);
    if (!config) return;

    if (config.expiresAt && Date.now() > config.expiresAt) return;

    this.config = config;
    this.server = new McpServer({ name: config.name, version: "1.0.0" });

    for (const ep of config.endpoints) {
      const schema = buildZodSchema(ep.parameters);
      this.server.tool(
        ep.id,
        ep.description.slice(0, 200),
        schema,
        async (params) => {
          const result = await executeToolCall(this.config!, ep, params as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      );
    }
  }

  // Override fetch to store serverId before MCP connection
  async fetch(request: Request): Promise<Response> {
    const serverId = request.headers.get("X-Server-Id");
    if (serverId) {
      const stored = await this.ctx.storage.get("serverId");
      if (!stored) await this.ctx.storage.put("serverId", serverId);
    }
    return super.fetch(request);
  }
}

function buildZodSchema(params: EndpointParam[]): Record<string, ZodTypeAny> {
  const schema: Record<string, ZodTypeAny> = {};
  for (const p of params) {
    let field: ZodTypeAny;
    if (p.enumValues?.length) {
      field = z.enum(p.enumValues as [string, ...string[]]);
    } else {
      const typeMap: Record<string, ZodTypeAny> = {
        string: z.string(),
        number: z.number(),
        boolean: z.boolean(),
        array: z.array(z.string()),
        object: z.record(z.unknown()),
      };
      field = typeMap[p.type] || z.string();
    }
    if (p.description) field = field.describe(p.description.slice(0, 150));
    if (!p.required) field = field.optional();
    schema[p.name] = field;
  }
  return schema;
}

// Pre-built route handlers using agents framework
const sseHandler = McpHostDO.serveSSE("/sse", { binding: "MCP_HOST" });
const mcpHandler = McpHostDO.serve("/mcp", { binding: "MCP_HOST" });

export function proxyToMcpHost(request: Request, env: Env, serverId: string, protocol: "sse" | "mcp"): Response {
  // Rewrite URL: /sse/{serverId}/* → /sse/* with serverId as sessionId param
  // For /sse/message (no serverId in path), leave the path as-is
  const url = new URL(request.url);
  const prefix = `/${protocol}/${serverId}`;
  if (url.pathname.startsWith(prefix)) {
    const subPath = url.pathname.slice(prefix.length) || "";
    url.pathname = `/${protocol}${subPath}`;
  }

  // Use serverId as sessionId so each server gets its own DO instance
  if (!url.searchParams.has("sessionId")) {
    url.searchParams.set("sessionId", serverId);
  }

  const headers = new Headers(request.headers);
  headers.set("X-Server-Id", serverId);

  const rewritten = new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.body,
  });

  const handler = protocol === "sse" ? sseHandler : mcpHandler;
  return handler.fetch(rewritten, env, {} as ExecutionContext) as unknown as Response;
}
