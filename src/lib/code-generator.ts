import type { ParsedAPI, ParsedEndpoint, EndpointParam, GenerateRequest } from "../types";

export function generateFiles(req: GenerateRequest): Record<string, string> {
  const { api, selectedEndpointIds, serverName, authEnvVar } = req;
  const selected = api.endpoints.filter((e) => selectedEndpointIds.includes(e.id));
  const raw = toPascalCase(serverName);
  const className = raw.endsWith("Mcp") ? raw : raw + "MCP";
  const files: Record<string, string> = {};

  files["package.json"] = genPackageJson(serverName);
  files["wrangler.jsonc"] = genWrangler(serverName, className, authEnvVar);
  files["tsconfig.json"] = genTsconfig();
  files["src/index.ts"] = genServerCode(api, selected, className, authEnvVar);
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
      agents: "^0.5.1",
      zod: "^3.24.0",
    },
    devDependencies: {
      "@cloudflare/workers-types": "^4.20250224.0",
      typescript: "^5.7.3",
      wrangler: "^4.0.0",
    },
  }, null, 2);
}

function genWrangler(name: string, className: string, authEnvVar: string): string {
  return JSON.stringify({
    name,
    main: "src/index.ts",
    compatibility_date: "2025-03-10",
    compatibility_flags: ["nodejs_compat"],
    vars: { [authEnvVar]: "YOUR_API_KEY_HERE" },
    durable_objects: {
      bindings: [{ name: "MCP_OBJECT", class_name: className }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: [className] }],
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

function genServerCode(api: ParsedAPI, endpoints: ParsedEndpoint[], className: string, authEnvVar: string): string {
  const toolRegistrations = endpoints.map((ep) => genToolRegistration(api, ep, authEnvVar)).join("\n\n");

  return `import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  MCP_OBJECT: DurableObjectNamespace;
  ${authEnvVar}: string;
};

export class ${className} extends McpAgent<Env> {
  server = new McpServer({
    name: "${api.name}",
    version: "${api.version}",
  });

  async init() {
${toolRegistrations}
  }
}

async function apiRequest(env: Env, method: string, path: string, query?: Record<string, string>, body?: unknown) {
  const url = new URL(path, "${api.baseUrl}");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
${genAuthBlock(api, authEnvVar)}
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(\`API error \${res.status}: \${error}\`);
  }
  return res.json();
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return ${className}.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return ${className}.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("${api.name} MCP Server. Connect via /sse or /mcp", {
      headers: { "content-type": "text/plain" },
    });
  },
};
`;
}

function genAuthBlock(api: ParsedAPI, authEnvVar: string): string {
  const { authScheme } = api;
  if (authScheme.type === "bearer") {
    return `  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": \`Bearer \${env.${authEnvVar}}\`,
  };`;
  }
  if (authScheme.type === "api_key_header") {
    return `  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "${authScheme.headerName || "X-API-Key"}": env.${authEnvVar},
  };`;
  }
  if (authScheme.type === "api_key_query") {
    return `  if (!query) query = {};
  query["${authScheme.queryParam || "api_key"}"] = env.${authEnvVar};
  const headers: Record<string, string> = { "Content-Type": "application/json" };`;
  }
  return `  const headers: Record<string, string> = { "Content-Type": "application/json" };`;
}

function genToolRegistration(api: ParsedAPI, ep: ParsedEndpoint, authEnvVar: string): string {
  const schemaLines = ep.parameters.map((p) => `        ${p.name}: ${genZodType(p)},`).join("\n");
  const schema = ep.parameters.length > 0 ? `{\n${schemaLines}\n      }` : "{}";

  const pathParams = ep.parameters.filter((p) => p.location === "path");
  const queryParams = ep.parameters.filter((p) => p.location === "query");
  const bodyParams = ep.parameters.filter((p) => p.location === "body");

  let pathExpr = `"${ep.path}"`;
  if (pathParams.length > 0) {
    pathExpr = "`" + ep.path.replace(/\{(\w+)\}/g, "${$1}") + "`";
  }

  const queryObj = queryParams.length > 0
    ? `{ ${queryParams.map((p) => `${p.name}: String(${p.name} ?? "")`).join(", ")} }`
    : "undefined";

  const bodyObj = bodyParams.length > 0
    ? `{ ${bodyParams.map((p) => p.name).join(", ")} }`
    : "undefined";

  const destructured = ep.parameters.map((p) => p.name).join(", ");
  const paramDestructure = destructured ? `{ ${destructured} }` : "";

  return `    this.server.tool(
      "${ep.id}",
      "${ep.description.replace(/"/g, '\\"').slice(0, 200)}",
      ${schema},
      async (${paramDestructure || "{}"}) => {
        const data = await apiRequest(this.env, "${ep.method}", ${pathExpr}, ${queryObj}, ${bodyObj});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );`;
}

function genZodType(p: EndpointParam): string {
  let base: string;
  if (p.enumValues?.length) {
    base = `z.enum([${p.enumValues.map((v) => `"${v}"`).join(", ")}])`;
  } else {
    const typeMap: Record<string, string> = { string: "z.string()", number: "z.number()", boolean: "z.boolean()", array: "z.array(z.string())", object: "z.record(z.unknown())" };
    base = typeMap[p.type] || "z.string()";
  }
  if (p.description) base += `.describe("${p.description.replace(/"/g, '\\"').slice(0, 150)}")`;
  if (p.default !== undefined) base += `.default(${JSON.stringify(p.default)})`;
  if (!p.required) base += ".optional()";
  return base;
}

function genReadme(name: string, api: ParsedAPI, endpoints: ParsedEndpoint[]): string {
  const toolList = endpoints.map((ep) => `- **${ep.id}** - ${ep.method} ${ep.path} - ${ep.description}`).join("\n");
  return `# ${name}

MCP server for ${api.name}, generated by [mcpfromdocs.com](https://mcpfromdocs.com).

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
- MCP: \`https://your-worker.workers.dev/mcp\`
`;
}

function toPascalCase(str: string): string {
  return str.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase());
}
