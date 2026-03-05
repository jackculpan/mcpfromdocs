import type { Env, ParsedAPI } from "../types";
import { detectInputType, fetchDoc } from "../lib/doc-fetcher";
import { parseOpenApiJson, parseOpenApiYaml, parseWithAI } from "../lib/ai-parser";

export async function handleParse(request: Request, env: Env): Promise<Response> {
  const { input } = (await request.json()) as { input: string };
  if (!input?.trim()) return jsonError("Input is required", 400);

  try {
    const inputType = detectInputType(input.trim());
    let parsed: ParsedAPI;

    if (inputType === "openapi-json") {
      parsed = parseOpenApiJson(input);
    } else if (inputType === "openapi-yaml") {
      parsed = parseOpenApiYaml(input);
    } else if (inputType === "url") {
      const doc = await fetchDoc(input.trim());
      if (doc.contentType === "openapi-json") {
        parsed = parseOpenApiJson(doc.rawText);
      } else if (doc.contentType === "openapi-yaml") {
        parsed = parseOpenApiYaml(doc.rawText);
      } else {
        parsed = await parseWithAI(doc.rawText, env);
      }
    } else {
      parsed = await parseWithAI(input, env);
    }

    if (!parsed.endpoints?.length) {
      return jsonError("No endpoints found in the documentation", 422);
    }

    return Response.json(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to parse documentation";
    return jsonError(msg, 500);
  }
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
