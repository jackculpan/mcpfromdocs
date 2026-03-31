import YAML from "yaml";
import type { ParsedAPI, ParsedEndpoint, EndpointParam, Env, AuthScheme } from "../types";

export function parseOpenApiJson(raw: string): ParsedAPI {
  const spec = JSON.parse(raw);
  return extractFromSpec(spec);
}

export function parseOpenApiYaml(raw: string): ParsedAPI {
  const spec = YAML.parse(raw);
  return extractFromSpec(spec);
}

function extractFromSpec(spec: Record<string, unknown>): ParsedAPI {
  const info = (spec.info as Record<string, string>) || {};
  const servers = (spec.servers as Array<{ url: string }>) || [];
  const baseUrl = servers[0]?.url || "";

  const authScheme = extractAuthScheme(spec);
  const endpoints: ParsedEndpoint[] = [];
  const paths = (spec.paths as Record<string, Record<string, unknown>>) || {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const op = details as Record<string, unknown>;
      const id = (op.operationId as string) || `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const params = extractParams(op);

      endpoints.push({
        id: id.toLowerCase(),
        name: (op.summary as string) || id,
        description: (op.description as string) || (op.summary as string) || "",
        method: method.toUpperCase() as ParsedEndpoint["method"],
        path,
        parameters: params,
      });
    }
  }

  return { name: info.title || "API", baseUrl, version: info.version || "1.0.0", authScheme, endpoints };
}

function extractAuthScheme(spec: Record<string, unknown>): AuthScheme {
  const components = (spec.components as Record<string, unknown>) || {};
  const schemes = (components.securitySchemes as Record<string, Record<string, string>>) || {};
  for (const scheme of Object.values(schemes)) {
    if (scheme.type === "http" && scheme.scheme === "bearer") return { type: "bearer", headerName: "Authorization", prefix: "Bearer" };
    if (scheme.type === "apiKey" && scheme.in === "header") return { type: "api_key_header", headerName: scheme.name };
    if (scheme.type === "apiKey" && scheme.in === "query") return { type: "api_key_query", queryParam: scheme.name };
    if (scheme.type === "http" && scheme.scheme === "basic") return { type: "basic" };
  }
  // Check securityDefinitions (Swagger 2.0)
  const defs = (spec.securityDefinitions as Record<string, Record<string, string>>) || {};
  for (const def of Object.values(defs)) {
    if (def.type === "apiKey" && def.in === "header") return { type: "api_key_header", headerName: def.name };
    if (def.type === "apiKey" && def.in === "query") return { type: "api_key_query", queryParam: def.name };
  }
  return { type: "none" };
}

function extractParams(op: Record<string, unknown>): EndpointParam[] {
  const params: EndpointParam[] = [];
  const rawParams = (op.parameters as Array<Record<string, unknown>>) || [];

  for (const p of rawParams) {
    const schema = (p.schema as Record<string, unknown>) || {};
    params.push({
      name: p.name as string,
      type: mapSchemaType(schema.type as string),
      required: (p.required as boolean) || false,
      description: (p.description as string) || "",
      location: (p.in as EndpointParam["location"]) || "query",
      enumValues: schema.enum as string[] | undefined,
      default: schema.default,
    });
  }

  // Extract request body properties
  const body = op.requestBody as Record<string, unknown> | undefined;
  if (body) {
    const content = (body.content as Record<string, Record<string, unknown>>) || {};
    const jsonContent = content["application/json"] || Object.values(content)[0];
    if (jsonContent?.schema) {
      const schema = jsonContent.schema as Record<string, unknown>;
      const props = (schema.properties as Record<string, Record<string, unknown>>) || {};
      const required = (schema.required as string[]) || [];
      for (const [name, prop] of Object.entries(props)) {
        params.push({
          name,
          type: mapSchemaType(prop.type as string),
          required: required.includes(name),
          description: (prop.description as string) || "",
          location: "body",
          enumValues: prop.enum as string[] | undefined,
          default: prop.default,
        });
      }
    }
  }
  return params;
}

function mapSchemaType(type: string | undefined): EndpointParam["type"] {
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  if (type === "object") return "object";
  return "string";
}

const EXTRACTION_PROMPT = `You are an API documentation parser. Extract ONLY the API endpoints that are explicitly documented below. Do NOT invent, guess, or infer endpoints that are not clearly described in the documentation.

Return ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "name": "API Name",
  "baseUrl": "https://api.example.com",
  "version": "1.0.0",
  "authScheme": {
    "type": "bearer|api_key_header|api_key_query|basic|none",
    "headerName": "Authorization",
    "prefix": "Bearer"
  },
  "endpoints": [
    {
      "id": "snake_case_unique_id",
      "name": "Human Readable Name",
      "description": "What this endpoint does",
      "method": "GET|POST|PUT|PATCH|DELETE",
      "path": "/path/{param}",
      "parameters": [
        {
          "name": "param",
          "type": "string|number|boolean|array|object",
          "required": true,
          "description": "Description",
          "location": "path|query|body"
        }
      ]
    }
  ]
}

IMPORTANT: Only include endpoints with an explicit HTTP method and path shown in the documentation. Do not generate CRUD variations unless each one is explicitly documented.`;

export async function parseWithAI(text: string, env: Env): Promise<ParsedAPI> {
  const prompt = `${EXTRACTION_PROMPT}\n\n---\nDOCUMENTATION:\n${text.slice(0, 60_000)}`;

  if (env.ANTHROPIC_API_KEY) {
    return parseWithClaude(prompt, env.ANTHROPIC_API_KEY);
  }
  return parseWithWorkersAI(prompt, env.AI);
}

async function parseWithWorkersAI(prompt: string, ai: Ai): Promise<ParsedAPI> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await Promise.race([
    (ai as any).run("@cf/meta/llama-3.1-70b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8000,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("AI parsing timed out after 45s. Try pasting the OpenAPI spec URL directly.")), 45_000)),
  ]);
  const text = typeof result === "string" ? result : result?.response || "";
  return extractJson(text);
}

async function parseWithClaude(prompt: string, apiKey: string): Promise<ParsedAPI> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: Array<{ text: string }> };
  return extractJson(data.content[0].text);
}

function extractJson(text: string): ParsedAPI {
  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in AI response");
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.endpoints || !Array.isArray(parsed.endpoints)) throw new Error("Invalid response: missing endpoints array");
  return parsed as ParsedAPI;
}
