import type { Env, ChatMessage } from "../types";
import { getServer, createSession, getSessionMessages, saveSessionMessages } from "../lib/db";
import { chatWithTools } from "../lib/llm-client";

interface ChatRequest {
  serverId: string;
  sessionId?: string;
  message: string;
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as ChatRequest;
    if (!body.serverId || !body.message?.trim()) {
      return Response.json({ error: "serverId and message are required" }, { status: 400 });
    }

    const config = await getServer(env.DB, env.MCP_CONFIGS, body.serverId);
    if (!config) return Response.json({ error: "Server not found" }, { status: 404 });

    if (config.expiresAt && Date.now() > config.expiresAt) {
      return Response.json({ error: "Server expired" }, { status: 410 });
    }

    // Get or create session
    let sessionId = body.sessionId;
    let messages: ChatMessage[] = [];
    if (sessionId) {
      messages = await getSessionMessages(env.DB, sessionId);
    } else {
      sessionId = await createSession(env.DB, body.serverId);
    }

    // Add user message
    const userMsg: ChatMessage = { role: "user", content: body.message.trim(), timestamp: Date.now() };
    messages.push(userMsg);

    // Chat with LLM + tools
    const { response, toolCalls } = await chatWithTools(config, messages, body.message.trim(), env);

    // Add tool calls and assistant response to history
    for (const tc of toolCalls) {
      messages.push({ role: "tool_call", content: JSON.stringify(tc.result), toolName: tc.tool, timestamp: Date.now() });
    }
    messages.push({ role: "assistant", content: response, timestamp: Date.now() });

    // Save session (keep last 30 messages)
    await saveSessionMessages(env.DB, sessionId, messages.slice(-30));

    return Response.json({ sessionId, response, toolCalls });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return Response.json({ error: message }, { status: 500 });
  }
}
