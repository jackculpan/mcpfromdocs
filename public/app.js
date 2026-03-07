// Shared state
const state = {
  parsedApi: null,
  generatedFiles: null,
  generatedZip: null,
  serverId: null,
  sessionId: null,
  expiresAt: null,
  timerInterval: null,
  currentStep: null,
  stepHistory: [],
};

// --- Step navigation ---
function goToStep(stepId) {
  const overlay = document.getElementById("modal-overlay");
  const landing = document.getElementById("landing");

  // Track history for back button
  if (state.currentStep && state.currentStep !== stepId) {
    state.stepHistory.push(state.currentStep);
  }

  // Hide all steps
  document.querySelectorAll(".step").forEach(s => s.hidden = true);

  // Show target step
  const target = document.getElementById(stepId);
  if (target) target.hidden = false;

  // Show modal, hide landing
  overlay.hidden = false;
  landing.hidden = true;
  state.currentStep = stepId;

  // Update progress bar
  const steps = ["step-input", "step-select", "step-chat"];
  const curIdx = steps.indexOf(stepId);
  const fill = document.getElementById("progress-fill");
  if (fill) {
    const pct = curIdx >= 0 ? ((curIdx + 1) / steps.length) * 100 : 33;
    fill.style.width = pct + "%";
  }
  document.querySelectorAll(".progress-label").forEach(l => {
    const idx = steps.indexOf(l.dataset.step);
    l.classList.toggle("active", l.dataset.step === stepId);
    l.classList.toggle("done", idx < curIdx && idx >= 0);
  });

  // Auto-focus
  if (stepId === "step-input") {
    setTimeout(() => document.getElementById("doc-input")?.focus(), 200);
  } else if (stepId === "step-chat") {
    setTimeout(() => document.getElementById("chat-input")?.focus(), 200);
  }
}

function goBack() {
  if (state.stepHistory.length > 0) {
    const prev = state.stepHistory.pop();
    // Don't push current to history (goToStep would do it)
    state.currentStep = null;
    goToStep(prev);
    // Remove the duplicate history entry goToStep just pushed
    state.stepHistory.pop();
  } else {
    goToLanding();
  }
}

function goToLanding() {
  document.getElementById("modal-overlay").hidden = true;
  document.getElementById("landing").hidden = false;
  document.querySelectorAll(".step").forEach(s => s.hidden = true);
  state.currentStep = null;
  state.stepHistory = [];
}

function startOver() {
  Object.assign(state, {
    parsedApi: null, generatedFiles: null, generatedZip: null,
    serverId: null, sessionId: null, stepHistory: [],
  });
  if (state.timerInterval) clearInterval(state.timerInterval);
  document.getElementById("doc-input").value = "";
  document.getElementById("chat-messages").innerHTML = "";
  goToLanding();
}

// --- Parse ---
async function handleParse() {
  const input = document.getElementById("doc-input").value.trim();
  if (!input) return;
  const btn = document.getElementById("parse-btn");
  const error = document.getElementById("parse-error");
  setLoading(btn, true);
  error.hidden = true;
  try {
    const res = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Parse failed");
    state.parsedApi = data;
    renderEndpoints(data);
    goToStep("step-select");
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

function renderEndpoints(api) {
  document.getElementById("api-info").innerHTML = `
    <div><span>API:</span> <strong>${esc(api.name)}</strong></div>
    <div><span>Base URL:</span> <strong>${esc(api.baseUrl)}</strong></div>
    <div><span>Auth:</span> <strong>${esc(api.authScheme.type)}</strong></div>
    <div><span>Endpoints:</span> <strong>${api.endpoints.length}</strong></div>`;
  const name = api.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "") + "-mcp";
  document.getElementById("server-name").value = name;
  document.getElementById("auth-env-var").value = "API_KEY";
  const list = document.getElementById("endpoints-list");
  list.innerHTML = api.endpoints.map((ep, i) => {
    const sel = i < MAX_DEMO_ENDPOINTS;
    return `
    <div class="endpoint${sel ? ' selected' : ''}" onclick="toggleEndpoint(this)" data-id="${esc(ep.id)}">
      <div class="endpoint-header">
        <input type="checkbox" ${sel ? 'checked' : ''} onclick="event.stopPropagation(); toggleEndpoint(this.closest('.endpoint'))">
        <span class="method-badge method-${ep.method}">${ep.method}</span>
        <span class="endpoint-path">${esc(ep.path)}</span>
        <span class="endpoint-name">${esc(ep.name)}</span>
      </div>
      ${ep.parameters.length ? `<div class="endpoint-details">
        <div style="margin-bottom:6px;color:var(--text)">${esc(ep.description)}</div>
        ${ep.parameters.map(p => `<div class="param-row">
          <span class="param-name">${esc(p.name)}</span>
          <span class="param-type">${esc(p.type)}</span>
          <span class="${p.required ? 'param-required' : 'param-optional'}">${p.required ? 'req' : 'opt'}</span>
        </div>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
  updateCount();
}

const MAX_DEMO_ENDPOINTS = 10;

function toggleEndpoint(el) {
  const isSelected = el.classList.contains("selected");
  if (!isSelected) {
    const count = document.querySelectorAll(".endpoint.selected").length;
    if (count >= MAX_DEMO_ENDPOINTS) {
      el.classList.add("shake");
      setTimeout(() => el.classList.remove("shake"), 400);
      return;
    }
  }
  el.classList.toggle("selected");
  el.querySelector('input[type="checkbox"]').checked = el.classList.contains("selected");
  el.classList.toggle("expanded");
  updateCount();
}

function toggleAll(select) {
  let count = 0;
  document.querySelectorAll(".endpoint").forEach(el => {
    if (select && count >= MAX_DEMO_ENDPOINTS) {
      el.classList.remove("selected");
      el.querySelector('input[type="checkbox"]').checked = false;
      return;
    }
    if (select) { el.classList.add("selected"); count++; }
    else { el.classList.remove("selected"); }
    el.querySelector('input[type="checkbox"]').checked = select;
  });
  updateCount();
}

function updateCount() {
  const count = document.querySelectorAll(".endpoint.selected").length;
  document.getElementById("selected-count").textContent = `${count}/${MAX_DEMO_ENDPOINTS} selected`;
  document.getElementById("deploy-btn").disabled = count === 0;
  document.getElementById("generate-btn").disabled = count === 0;
}

// --- Generate (download) ---
async function handleGenerate() {
  const selectedIds = [...document.querySelectorAll(".endpoint.selected")].map(el => el.dataset.id);
  if (!selectedIds.length) return;
  const btn = document.getElementById("generate-btn");
  setLoading(btn, true);
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: state.parsedApi,
        selectedEndpointIds: selectedIds,
        serverName: document.getElementById("server-name").value,
        authEnvVar: document.getElementById("auth-env-var").value || "API_KEY",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Generation failed");
    state.generatedFiles = data.files;
    state.generatedZip = data.zip;
    renderPreview(data.files);
    goToStep("step-preview");
  } catch (err) { alert(err.message); }
  finally { setLoading(btn, false); }
}

function renderPreview(files) {
  const tabs = document.getElementById("file-tabs");
  tabs.innerHTML = Object.keys(files).map((name, i) => `
    <div class="file-tab ${i === 0 ? 'active' : ''}" onclick="showFile('${esc(name)}')" data-file="${esc(name)}">${esc(name)}</div>`).join("");
  showFile(Object.keys(files).find(f => f.includes("index.ts")) || Object.keys(files)[0]);
}

function showFile(name) {
  const code = document.getElementById("code-preview");
  const lang = name.endsWith(".ts") ? "typescript" : name.endsWith(".json") || name.endsWith(".jsonc") ? "json" : "markdown";
  code.className = `language-${lang}`;
  code.textContent = state.generatedFiles[name];
  if (typeof hljs !== "undefined") hljs.highlightElement(code);
  document.querySelectorAll(".file-tab").forEach(t => t.classList.toggle("active", t.dataset.file === name));
}

function downloadZip() {
  if (!state.generatedZip) return;
  const bytes = Uint8Array.from(atob(state.generatedZip), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById("server-name").value || "mcp-server") + ".zip";
  a.click();
}

// --- Demo loader ---
function loadDemo() {
  document.getElementById("doc-input").value = "https://petstore3.swagger.io/api/v3/openapi.json";
  handleParse();
}

// --- Connect modal ---
function getMcpUrlText() {
  return document.getElementById("mcp-url").textContent || "";
}

function showConnect(platform) {
  const url = getMcpUrlText();
  const modal = document.getElementById("connect-modal");
  const title = document.getElementById("connect-modal-title");
  const body = document.getElementById("connect-modal-body");

  const instructions = {
    claude: {
      title: "Connect to Claude Desktop",
      steps: [
        { text: `Open your Claude Desktop config file:`, code: "~/.claude/claude_desktop_config.json" },
        { text: "Add this MCP server entry:", code: `{
  "mcpServers": {
    "${state.parsedApi?.name || 'my-api'}": {
      "url": "${url}"
    }
  }
}` },
        { text: "Restart Claude Desktop. Your MCP tools will appear in the tools menu." },
      ],
    },
    cursor: {
      title: "Connect to Cursor",
      steps: [
        { text: "Open Cursor Settings (Cmd+, or Ctrl+,) and go to the MCP tab." },
        { text: "Click \"Add new MCP server\" and enter:", code: `Name: ${state.parsedApi?.name || 'my-api'}
Type: SSE
URL: ${url}` },
        { text: "Click Save. The server will connect automatically." },
      ],
    },
    windsurf: {
      title: "Connect to Windsurf",
      steps: [
        { text: "Open your Windsurf MCP config file:", code: "~/.codeium/windsurf/mcp_config.json" },
        { text: "Add this server entry:", code: `{
  "mcpServers": {
    "${state.parsedApi?.name || 'my-api'}": {
      "serverUrl": "${url}"
    }
  }
}` },
        { text: "Restart Windsurf. Your tools will be available in Cascade." },
      ],
    },
    chatgpt: {
      title: "Connect to ChatGPT",
      steps: [
        { text: "Go to ChatGPT Settings > Beta features and enable \"MCP Connectors\"." },
        { text: "Open any chat, click the plug icon, then \"Add MCP connector\"." },
        { text: "Enter the SSE URL:", code: url },
        { text: "Click Connect. Your API tools will appear as available actions." },
      ],
    },
  };

  const info = instructions[platform];
  title.textContent = info.title;
  body.innerHTML = info.steps.map((s, i) => `
    <div class="connect-step">
      <div class="connect-step-num">Step ${i + 1}</div>
      <p>${esc(s.text)}</p>
      ${s.code ? `<div class="connect-code"><button class="connect-copy-btn" onclick="copyConnectCode(this)">Copy</button>${esc(s.code)}</div>` : ""}
    </div>
  `).join("");

  modal.hidden = false;
}

function hideConnect() {
  document.getElementById("connect-modal").hidden = true;
}

function copyConnectCode(btn) {
  const code = btn.parentElement.textContent.replace("Copy", "").trim();
  navigator.clipboard.writeText(code);
  btn.textContent = "Copied!";
  setTimeout(() => btn.textContent = "Copy", 2000);
}

// Close connect modal on backdrop click
document.addEventListener("click", (e) => {
  const modal = document.getElementById("connect-modal");
  if (e.target === modal) modal.hidden = true;
});

// --- Helpers ---
function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector(".btn-text").hidden = loading;
  btn.querySelector(".btn-loading").hidden = !loading;
}

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
