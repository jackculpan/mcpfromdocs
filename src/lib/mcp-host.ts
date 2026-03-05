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

export function proxyToMcpHost(request: Request, env: Env, serverId: string, protocol: "sse" | "mcp"): Response {
  const id = env.MCP_HOST.idFromName(serverId);
  const stub = env.MCP_HOST.get(id);

  // Rewrite URL to the protocol path the DO expects
  const url = new URL(request.url);
  // Keep sub-paths like /sse/message
  const subPath = url.pathname.replace(`/${protocol}/${serverId}`, "") || "";
  url.pathname = `/${protocol}${subPath}`;

  const headers = new Headers(request.headers);
  headers.set("X-Server-Id", serverId);

  return stub.fetch(new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.body,
  })) as unknown as Response;
}
