import type { Env, ServerConfig, ParsedEndpoint, ChatMessage } from "../types";
import { executeToolCall } from "./tool-executor";

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export async function chatWithTools(
  config: ServerConfig,
  messages: ChatMessage[],
  userMessage: string,
  env: Env,
): Promise<{ response: string; toolCalls: Array<{ tool: string; result: unknown }> }> {
  const toolDescriptions = config.endpoints.map((ep) => {
    const params = ep.parameters.map((p) =>
      `${p.name}(${p.type}${p.required ? ",req" : ""})${p.location === "path" ? "[path]" : ""}`
    ).join(", ");
    return `- ${ep.id}: ${ep.method} ${ep.path} — ${ep.description}${params ? `\n  Params: ${params}` : ""}`;
  }).join("\n");

  const systemPrompt = `You are a helpful assistant for the ${config.name} API.

Tools:
${toolDescriptions}

When you need to call a tool, respond with ONLY a JSON block like this:
\`\`\`tool
{"tool": "tool_name", "args": {"param1": "value1"}}
\`\`\`

After receiving a tool result, summarize it helpfully for the user. Do NOT call a tool unless the user's request requires it.`;

  // Build conversation for LLM
  const llmMessages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add recent history (last 10 messages to stay within context)
  // The current user message is already in `messages` (added by chat.ts), so don't add it again
  const recent = messages.slice(-10);
  for (const msg of recent) {
    if (msg.role === "user" || msg.role === "assistant") {
      llmMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const toolCalls: Array<{ tool: string; result: unknown }> = [];
  let rounds = 0;
  const maxRounds = 3;

  while (rounds < maxRounds) {
    rounds++;
    const llmResponse = await callWorkersAI(llmMessages, env);

    // Check if response contains a tool call (```tool or ```json with tool/args keys)
    const toolMatch = llmResponse.match(/```(?:tool|json)\s*\n?([\s\S]*?)\n?```/);
    if (!toolMatch) {
      // Also try bare JSON with "tool" key
      const bareMatch = llmResponse.match(/\{[^{}]*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}[^}]*\}/);
      if (bareMatch) {
        try {
          const call = JSON.parse(bareMatch[0]) as ToolCall;
          const endpoint = config.endpoints.find((ep) => ep.id === call.tool);
          if (endpoint) {
            let result: unknown;
            try {
              result = await executeToolCall(config, endpoint, call.args || {});
            } catch (e) {
              result = { error: e instanceof Error ? e.message : "Tool execution failed" };
            }
            toolCalls.push({ tool: call.tool, result });
            llmMessages.push({ role: "assistant", content: llmResponse });
            llmMessages.push({ role: "user", content: `Tool result for ${call.tool}:\n${JSON.stringify(result, null, 2).slice(0, 4000)}` });
            continue;
          }
        } catch {}
      }
    }
    if (!toolMatch) {
      return { response: llmResponse, toolCalls };
    }

    // Parse and execute tool call
    let call: ToolCall;
    try {
      call = JSON.parse(toolMatch[1].trim());
    } catch {
      return { response: llmResponse, toolCalls };
    }

    const endpoint = config.endpoints.find((ep) => ep.id === call.tool);
    if (!endpoint) {
      llmMessages.push({ role: "assistant", content: llmResponse });
      llmMessages.push({ role: "user", content: `Tool "${call.tool}" not found. Available tools: ${config.endpoints.map((e) => e.id).join(", ")}` });
      continue;
    }

    let result: unknown;
    try {
      result = await executeToolCall(config, endpoint, call.args || {});
    } catch (e) {
      result = { error: e instanceof Error ? e.message : "Tool execution failed" };
    }
    toolCalls.push({ tool: call.tool, result });

    llmMessages.push({ role: "assistant", content: llmResponse });
    llmMessages.push({
      role: "user",
      content: `Tool result for ${call.tool}:\n${JSON.stringify(result, null, 2).slice(0, 4000)}`,
    });
  }

  // Final response after tool calls
  const finalResponse = await callWorkersAI(llmMessages, env);
  return { response: finalResponse, toolCalls };
}

async function callWorkersAI(messages: Array<{ role: string; content: string }>, env: Env): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (env.AI as any).run("@cf/meta/llama-3.1-70b-instruct", {
    messages,
    max_tokens: 2000,
  });
  return typeof result === "string" ? result : result?.response || "";
}
