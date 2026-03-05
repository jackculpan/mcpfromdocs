import type { GenerateRequest, GenerateResponse } from "../types";
import { generateFiles } from "../lib/code-generator";
import { buildZip, uint8ToBase64 } from "../lib/zip-builder";

export async function handleGenerate(request: Request): Promise<Response> {
  const body = (await request.json()) as GenerateRequest;

  if (!body.api || !body.selectedEndpointIds?.length) {
    return Response.json({ error: "API data and selected endpoints are required" }, { status: 400 });
  }

  const serverName = (body.serverName || body.api.name || "my-mcp-server")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const authEnvVar = body.authEnvVar || "API_KEY";

  try {
    const files = generateFiles({ ...body, serverName, authEnvVar });
    const zipBytes = buildZip(files);
    const zip = uint8ToBase64(zipBytes);

    const response: GenerateResponse = { files, zip };
    return Response.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate server";
    return Response.json({ error: msg }, { status: 500 });
  }
}
