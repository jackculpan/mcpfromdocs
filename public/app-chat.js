// --- Deploy + Chat ---
async function handleDeploy() {
  const selectedIds = [...document.querySelectorAll(".endpoint.selected")].map(el => el.dataset.id);
  if (!selectedIds.length) return;
  const btn = document.getElementById("deploy-btn");
  setLoading(btn, true);
  try {
    const res = await fetch("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: state.parsedApi,
        selectedEndpointIds: selectedIds,
        serverName: document.getElementById("server-name").value,
        authEnvVar: document.getElementById("auth-env-var").value || "API_KEY",
        userApiKey: document.getElementById("user-api-key").value || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Deploy failed");

    state.serverId = data.serverId;
    state.expiresAt = data.expiresAt;
    state.sessionId = null;

    document.getElementById("mcp-url").textContent = data.sseUrl;
    startTimer();

    const msgs = document.getElementById("chat-messages");
    msgs.innerHTML = "";
    addMessage("assistant", `Your MCP server is live! I have access to ${selectedIds.length} API tools. Try asking me something about the API.`);

    goToStep("step-chat");
  } catch (err) { alert(err.message); }
  finally { setLoading(btn, false); }
}

async function handleChat() {
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message || !state.serverId) return;

  input.value = "";
  addMessage("user", message);

  const sendBtn = document.getElementById("chat-send-btn");
  sendBtn.disabled = true;

  const typing = document.createElement("div");
  typing.className = "message assistant typing";
  typing.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
  document.getElementById("chat-messages").appendChild(typing);
  typing.scrollIntoView({ behavior: "smooth" });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: state.serverId,
        sessionId: state.sessionId,
        message,
      }),
    });
    const data = await res.json();
    typing.remove();

    if (!res.ok) throw new Error(data.error || "Chat failed");

    state.sessionId = data.sessionId;

    if (data.toolCalls?.length) {
      for (const tc of data.toolCalls) {
        addToolCall(tc.tool, tc.result);
      }
    }

    addMessage("assistant", data.response);
  } catch (err) {
    typing.remove();
    addMessage("assistant", `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function addMessage(role, content) {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  msgs.appendChild(div);
  div.scrollIntoView({ behavior: "smooth" });
}

function addToolCall(toolName, result) {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "message tool-call";
  const preview = JSON.stringify(result, null, 2).slice(0, 300);
  div.innerHTML = `<div class="tool-header"><span class="tool-icon">&#9881;</span> Called <strong>${esc(toolName)}</strong></div><pre class="tool-result">${esc(preview)}${preview.length >= 300 ? '...' : ''}</pre>`;
  msgs.appendChild(div);
}

function copyMcpUrl() {
  const url = document.getElementById("mcp-url").textContent;
  navigator.clipboard.writeText(url);
  const btn = document.querySelector(".btn-copy");
  btn.textContent = "Copied!";
  setTimeout(() => btn.textContent = "copy", 2000);
}

function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  const timerEl = document.getElementById("timer");
  const statusDot = document.querySelector(".live-pip");

  function update() {
    if (!state.expiresAt) {
      timerEl.textContent = "Permanent";
      if (statusDot) statusDot.classList.add("permanent");
      return;
    }
    const remaining = state.expiresAt - Date.now();
    if (remaining <= 0) {
      timerEl.textContent = "Expired";
      if (statusDot) statusDot.classList.add("expired");
      clearInterval(state.timerInterval);
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}m ${secs}s remaining`;
    if (remaining < 300000 && statusDot) statusDot.classList.add("warning");
  }

  update();
  state.timerInterval = setInterval(update, 1000);
}
