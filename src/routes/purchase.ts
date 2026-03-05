import type { Env } from "../types";
import { getServer, activateServer, expireServer } from "../lib/db";

export async function handleCreateCheckout(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Payments not configured" }, { status: 503 });
  }

  const { serverId } = (await request.json()) as { serverId: string };
  if (!serverId) return Response.json({ error: "serverId required" }, { status: 400 });

  const server = await getServer(env.DB, env.MCP_CONFIGS, serverId);
  if (!server) return Response.json({ error: "Server not found" }, { status: 404 });

  const origin = new URL(request.url).origin;

  const params = new URLSearchParams({
    "payment_method_types[0]": "card",
    mode: "subscription",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "1500",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": `MCP Server: ${server.name}`,
    "line_items[0][price_data][product_data][description]": `Live MCP server with ${server.endpoints.length} tools`,
    success_url: `${origin}/?server=${serverId}&purchased=true`,
    cancel_url: `${origin}/?server=${serverId}`,
    "metadata[server_id]": serverId,
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const session = (await res.json()) as { url: string; id: string };
  if (!res.ok) return Response.json({ error: "Failed to create checkout" }, { status: 500 });

  return Response.json({ checkoutUrl: session.url });
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Not configured", { status: 503 });
  }

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  // Simple signature verification (timestamp + payload)
  const parts = sig.split(",").reduce((acc, part) => {
    const [key, val] = part.split("=");
    acc[key.trim()] = val;
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts["t"];
  const signedPayload = `${timestamp}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected !== parts["v1"]) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(body) as { type: string; data: { object: Record<string, unknown> } };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const serverId = (session.metadata as Record<string, string>)?.server_id;
    const subscriptionId = session.subscription as string;
    if (serverId && subscriptionId) {
      await activateServer(env.DB, env.MCP_CONFIGS, serverId, subscriptionId);
    }
  }

  if (event.type === "invoice.payment_failed" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const serverId = (sub.metadata as Record<string, string>)?.server_id;
    if (serverId) {
      await expireServer(env.DB, env.MCP_CONFIGS, serverId);
    }
  }

  return new Response("ok");
}
