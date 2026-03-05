import type { ServerConfig, ChatMessage } from "../types";

function nanoid(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

export async function createServer(
  db: D1Database,
  kv: KVNamespace,
  config: Omit<ServerConfig, "id" | "status" | "expiresAt">,
): Promise<ServerConfig> {
  const id = nanoid();
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000; // 1 hour demo

  const server: ServerConfig = { ...config, id, status: "demo", expiresAt };
  const configJson = JSON.stringify({
    baseUrl: config.baseUrl,
    authScheme: config.authScheme,
    endpoints: config.endpoints,
    authEnvVar: config.authEnvVar,
  });

  await db
    .prepare("INSERT INTO servers (id, name, config, user_api_key, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, config.name, configJson, config.userApiKey || null, "demo", expiresAt, now)
    .run();

  // Cache in KV with 1-hour TTL
  await kv.put(`server:${id}`, JSON.stringify(server), { expirationTtl: 3600 });

  return server;
}

export async function getServer(db: D1Database, kv: KVNamespace, id: string): Promise<ServerConfig | null> {
  // Try KV first
  const cached = await kv.get(`server:${id}`, "json");
  if (cached) return cached as ServerConfig;

  // Fallback to D1
  const row = await db.prepare("SELECT * FROM servers WHERE id = ?").bind(id).first();
  if (!row) return null;

  const config = JSON.parse(row.config as string);
  const server: ServerConfig = {
    id: row.id as string,
    name: row.name as string,
    baseUrl: config.baseUrl,
    authScheme: config.authScheme,
    endpoints: config.endpoints,
    authEnvVar: config.authEnvVar,
    userApiKey: row.user_api_key as string | undefined,
    status: row.status as ServerConfig["status"],
    expiresAt: row.expires_at as number | undefined,
  };

  return server;
}

export async function activateServer(db: D1Database, kv: KVNamespace, id: string, stripeSubId: string): Promise<void> {
  await db
    .prepare("UPDATE servers SET status = 'active', expires_at = NULL, stripe_subscription_id = ? WHERE id = ?")
    .bind(stripeSubId, id)
    .run();

  const server = await getServer(db, kv, id);
  if (server) {
    server.status = "active";
    server.expiresAt = undefined;
    await kv.put(`server:${id}`, JSON.stringify(server)); // no TTL for paid
  }
}

export async function expireServer(db: D1Database, kv: KVNamespace, id: string): Promise<void> {
  await db.prepare("UPDATE servers SET status = 'expired' WHERE id = ?").bind(id).run();
  await kv.delete(`server:${id}`);
}

export async function createSession(db: D1Database, serverId: string): Promise<string> {
  const id = nanoid();
  await db
    .prepare("INSERT INTO sessions (id, server_id, messages, created_at) VALUES (?, ?, '[]', ?)")
    .bind(id, serverId, Date.now())
    .run();
  return id;
}

export async function getSessionMessages(db: D1Database, sessionId: string): Promise<ChatMessage[]> {
  const row = await db.prepare("SELECT messages FROM sessions WHERE id = ?").bind(sessionId).first();
  if (!row) return [];
  return JSON.parse(row.messages as string);
}

export async function saveSessionMessages(db: D1Database, sessionId: string, messages: ChatMessage[]): Promise<void> {
  await db
    .prepare("UPDATE sessions SET messages = ? WHERE id = ?")
    .bind(JSON.stringify(messages), sessionId)
    .run();
}
