export interface ParsedAPI {
  name: string;
  baseUrl: string;
  version: string;
  authScheme: AuthScheme;
  endpoints: ParsedEndpoint[];
}

export interface AuthScheme {
  type: "bearer" | "api_key_header" | "api_key_query" | "basic" | "none";
  headerName?: string;
  prefix?: string;
  queryParam?: string;
}

export interface ParsedEndpoint {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  parameters: EndpointParam[];
  responseDescription?: string;
}

export interface EndpointParam {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  description: string;
  location: "path" | "query" | "body";
  default?: unknown;
  enumValues?: string[];
}

export interface GenerateRequest {
  api: ParsedAPI;
  selectedEndpointIds: string[];
  serverName: string;
  authEnvVar: string;
}

export interface GenerateResponse {
  files: Record<string, string>;
  zip: string; // base64
}

export interface ServerConfig {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: AuthScheme;
  endpoints: ParsedEndpoint[];
  authEnvVar: string;
  userApiKey?: string;
  status: "demo" | "active" | "expired";
  expiresAt?: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
  timestamp: number;
}

export interface Env {
  AI: Ai;
  ANTHROPIC_API_KEY?: string;
  DB: D1Database;
  MCP_CONFIGS: KVNamespace;
  MCP_HOST: DurableObjectNamespace;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
