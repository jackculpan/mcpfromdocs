import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import type { Env, ServerConfig, ParsedEndpoint, EndpointParam } from "../types";
import { getServer } from "./db";
import { executeToolCall } from "./tool-executor";

type HostProps = { serverId?: string };

export class McpHostSqliteDO extends McpAgent<Env, unknown, HostProps> {
  server = new McpServer({ name: "mcpfromdocs", version: "1.0.0" });
  private config: ServerConfig | null = null;

  async init() {
    const serverId = this.props?.serverId;
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

}

// Legacy non-SQLite class. Kept exported so the existing migration history stays valid. Not bound.
export class McpHostDO extends McpHostSqliteDO {}

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
        object: z.record(z.string(), z.unknown()),
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
const sseHandler = McpHostSqliteDO.serveSSE("/sse", { binding: "MCP_HOST" });
const mcpHandler = McpHostSqliteDO.serve("/mcp", { binding: "MCP_HOST" });

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

  const rewritten = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  const ctx = { props: { serverId } } as unknown as ExecutionContext;
  const handler = protocol === "sse" ? sseHandler : mcpHandler;
  return handler.fetch(rewritten, env, ctx) as unknown as Response;
}
