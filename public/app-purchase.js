// --- Purchase ---
async function handlePurchase() {
  if (!state.serverId) return;
  try {
    const res = await fetch("/api/purchase/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: state.serverId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create checkout");
    window.location.href = data.checkoutUrl;
  } catch (err) {
    alert(err.message);
  }
}

// Check URL params on load for post-purchase state
(function checkPurchaseReturn() {
  const params = new URLSearchParams(window.location.search);
  const serverId = params.get("server");
  const purchased = params.get("purchased");

  if (serverId && purchased === "true") {
    document.getElementById("chat-messages").innerHTML = "";
    state.serverId = serverId;
    state.expiresAt = null;

    fetch(`/api/server/${serverId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) return;
        const origin = window.location.origin;
        document.getElementById("mcp-url").textContent = `${origin}/sse/${serverId}`;
        document.getElementById("status-text").textContent = "Active";
        goToStep("step-chat");
        addMessage("assistant", `Your MCP server "${data.name}" is now permanently active! Connect to it from Claude Desktop or any MCP client using the URL above.`);
        startTimer();
      });

    window.history.replaceState({}, "", "/");
  }
})();
