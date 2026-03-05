import type { Env, ParsedAPI } from "../types";
import { createServer } from "../lib/db";

interface DeployRequest {
  api: ParsedAPI;
  selectedEndpointIds: string[];
  serverName: string;
  authEnvVar: string;
  userApiKey?: string;
}

export async function handleDeploy(request: Request, env: Env): Promise<Response> {
  let body: DeployRequest;
  try {
    body = (await request.json()) as DeployRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.api || !body.selectedEndpointIds?.length) {
    return Response.json({ error: "API data and selected endpoints are required" }, { status: 400 });
  }

  const MAX_DEMO_ENDPOINTS = 10;
  const selected = body.api.endpoints.filter((e) => body.selectedEndpointIds.includes(e.id));
  if (selected.length === 0) {
    return Response.json({
      error: `No matching endpoints found. IDs sent: ${body.selectedEndpointIds.slice(0, 3).join(", ")}; available: ${body.api.endpoints.slice(0, 3).map((e) => e.id).join(", ")}`,
    }, { status: 400 });
  }
  if (selected.length > MAX_DEMO_ENDPOINTS) {
    return Response.json({ error: `Demo limited to ${MAX_DEMO_ENDPOINTS} endpoints. You selected ${selected.length}.` }, { status: 400 });
  }
  const name = (body.serverName || body.api.name || "my-mcp-server")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  const server = await createServer(env.DB, env.MCP_CONFIGS, {
    name,
    baseUrl: body.api.baseUrl,
    authScheme: body.api.authScheme,
    endpoints: selected,
    authEnvVar: body.authEnvVar || "API_KEY",
    userApiKey: body.userApiKey,
  });

  const origin = new URL(request.url).origin;

  return Response.json({
    serverId: server.id,
    mcpUrl: `${origin}/mcp/${server.id}`,
    sseUrl: `${origin}/sse/${server.id}`,
    expiresAt: server.expiresAt,
    status: server.status,
  });
}
