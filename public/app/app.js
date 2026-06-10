// ============================================================
// WholesaleOS — single-page app
// ============================================================

const $main = document.getElementById("main");
const $modal = document.getElementById("modal");
const $backdrop = document.getElementById("modalBackdrop");
const $toast = document.getElementById("toast");

const STATUSES = [
  ["new", "New"],
  ["analyzing", "Analyzing"],
  ["offer_sent", "Offer Sent"],
  ["negotiating", "Negotiating"],
  ["under_contract", "Under Contract"],
  ["assigned", "Assigned"],
  ["closed", "Closed"],
  ["dead", "Dead"],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const timeAgo = (iso) => {
  const secs = (Date.now() - new Date(iso + "Z").getTime()) / 1000;
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};

// Hosting mode: "server" (Node backend) or "local" (static host — state in
// localStorage, Claude called directly from the browser). Detected at startup.
let LOCAL_MODE = false;

async function detectMode() {
  try {
    const res = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error();
    await res.json();
  } catch {
    LOCAL_MODE = true;
  }
}

async function api(path, options = {}) {
  if (LOCAL_MODE) {
    try {
      return await window.localApi(path, options);
    } catch (e) {
      throw new Error(e.message || "Request failed");
    }
  }
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.className = "toast" + (isError ? " error" : "");
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 3200);
}

function openModal(html) {
  $modal.innerHTML = html;
  $backdrop.hidden = false;
}
function closeModal() {
  $backdrop.hidden = true;
  $modal.innerHTML = "";
}
$backdrop.addEventListener("click", (e) => {
  if (e.target === $backdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$backdrop.hidden) closeModal();
});

// ---------- AI status badge ----------
let agentName = "Remi";
async function loadAiBadge() {
  try {
    const settings = await api("/api/settings");
    agentName = settings.agent_name || "Remi";
    const badge = document.getElementById("aiBadge");
    badge.classList.toggle("live", settings.ai_enabled);
    document.getElementById("aiBadgeText").textContent = settings.ai_enabled
      ? `${agentName} · Claude live`
      : `${agentName} · offline mode`;
    badge.title = settings.ai_enabled
      ? "AI agent is powered by the Claude API"
      : LOCAL_MODE
        ? "Add your Anthropic API key in Settings to enable the Claude-powered agent. A rule-based negotiator is active meanwhile."
        : "Set ANTHROPIC_API_KEY and restart to enable the Claude-powered agent. A rule-based negotiator is active meanwhile.";
  } catch { /* non-fatal */ }
}

// ============================================================
// Views
// ============================================================

async function renderDashboard() {
  const stats = await api("/api/stats");
  const lanes = STATUSES.filter(([k]) => !["closed", "dead"].includes(k));
  const maxCount = Math.max(1, ...lanes.map(([k]) => stats.by_status[k] || 0));

  $main.innerHTML = `
    <div class="view-head">
      <div><h1>Dashboard</h1><div class="sub">Your pipeline at a glance</div></div>
      <button class="btn btn-primary" id="newDealBtn">+ New deal</button>
    </div>
    <div class="cards">
      <div class="card"><div class="label">Active deals</div><div class="value">${stats.active}</div></div>
      <div class="card"><div class="label">Projected fees (in pipeline)</div><div class="value grad">${money(stats.pipeline_fees)}</div></div>
      <div class="card"><div class="label">Collected fees (closed)</div><div class="value grad">${money(stats.closed_fees)}</div></div>
      <div class="card"><div class="label">Cash buyers</div><div class="value">${stats.buyers}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:16px;align-items:start" class="dash-cols">
      <div class="panel">
        <h3>Pipeline by stage</h3>
        ${lanes.map(([key, label]) => {
          const n = stats.by_status[key] || 0;
          return `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
              <div style="width:120px;font-size:13px;color:var(--text-dim)">${label}</div>
              <div style="flex:1;background:var(--bg);border-radius:6px;height:10px;overflow:hidden">
                <div style="width:${(n / maxCount) * 100}%;height:100%;background:var(--grad);border-radius:6px"></div>
              </div>
              <div style="width:24px;text-align:right;font-weight:700;font-size:13px">${n}</div>
            </div>`;
        }).join("")}
      </div>
      <div class="panel">
        <h3>Recent activity</h3>
        <div class="activity">
          ${stats.recent.length === 0 ? `<div class="chat-empty">No activity yet.</div>` : stats.recent.map((m) => `
            <div class="activity-item">
              <div class="dot ${m.direction}"></div>
              <div>
                <div class="what"><b>${esc(m.address)}</b> — ${
                  m.direction === "out" ? `${esc(agentName)}: ` : m.direction === "in" ? "Agent replied: " : ""
                }${esc(m.content.length > 90 ? m.content.slice(0, 90) + "…" : m.content)}</div>
                <div class="when">${timeAgo(m.created_at)}</div>
              </div>
            </div>`).join("")}
        </div>
      </div>
    </div>`;

  document.getElementById("newDealBtn").addEventListener("click", () => dealFormModal());
}

// ---------- Pipeline (kanban) ----------
async function renderPipeline() {
  const deals = await api("/api/deals");

  $main.innerHTML = `
    <div class="view-head">
      <div><h1>Pipeline</h1><div class="sub">Drag deals between stages · click a deal to open it</div></div>
      <button class="btn btn-primary" id="newDealBtn">+ New deal</button>
    </div>
    <div class="board">
      ${STATUSES.map(([key, label]) => {
        const laneDeals = deals.filter((d) => d.status === key);
        return `
          <div class="lane" data-status="${key}">
            <div class="lane-head"><span>${label}</span><span class="lane-count">${laneDeals.length}</span></div>
            ${laneDeals.map((d) => `
              <div class="deal-card" draggable="true" data-id="${d.id}">
                <div class="addr">${esc(d.address)}</div>
                <div class="meta">${esc(d.city)}${d.city && d.state ? ", " : ""}${esc(d.state)} · ${d.beds}/${d.baths} · ${d.sqft.toLocaleString()} sqft</div>
                <div class="nums">
                  <span>MAO <b>${money(d.analysis.mao)}</b></span>
                  ${d.assignment_fee ? `<span>Fee <b>${money(d.assignment_fee)}</b></span>` : ""}
                </div>
              </div>`).join("")}
          </div>`;
      }).join("")}
    </div>`;

  document.getElementById("newDealBtn").addEventListener("click", () => dealFormModal());

  // Click to open
  $main.querySelectorAll(".deal-card").forEach((card) => {
    card.addEventListener("click", () => (location.hash = `#/deal/${card.dataset.id}`));
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  // Drag-drop between lanes
  $main.querySelectorAll(".lane").forEach((lane) => {
    lane.addEventListener("dragover", (e) => {
      e.preventDefault();
      lane.classList.add("drag-over");
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("drag-over"));
    lane.addEventListener("drop", async (e) => {
      e.preventDefault();
      lane.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      try {
        await api(`/api/deals/${id}`, { method: "PATCH", body: { status: lane.dataset.status } });
        toast(`Moved to ${STATUS_LABEL[lane.dataset.status]}`);
        renderPipeline();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// ---------- Deal detail ----------
async function renderDeal(id) {
  let deal, thread;
  try {
    [deal, thread] = await Promise.all([api(`/api/deals/${id}`), api(`/api/deals/${id}/messages`)]);
  } catch {
    $main.innerHTML = `<div class="view-head"><h1>Deal not found</h1></div><a class="btn btn-outline" href="#/pipeline">← Back to pipeline</a>`;
    return;
  }
  const a = deal.analysis;

  $main.innerHTML = `
    <div class="view-head">
      <div>
        <h1>${esc(deal.address)}</h1>
        <div class="sub">${esc(deal.city)}${deal.city && deal.state ? ", " : ""}${esc(deal.state)} ${esc(deal.zip)} ·
          ${deal.beds} bed / ${deal.baths} bath · ${deal.sqft.toLocaleString()} sqft</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="status-pill s-${deal.status}">${STATUS_LABEL[deal.status]}</span>
        <a class="btn btn-outline btn-sm" href="#/pipeline">← Pipeline</a>
      </div>
    </div>

    <div class="deal-grid">
      <div>
        <div class="analysis-strip">
          <div class="analysis-cell"><div class="label">Max offer (MAO)</div><div class="num good">${money(a.mao)}</div></div>
          <div class="analysis-cell"><div class="label">Discount to ARV</div><div class="num ${a.discount_to_arv == null ? "" : a.discount_to_arv >= 20 ? "good" : "bad"}">${a.discount_to_arv == null ? "—" : a.discount_to_arv + "%"}</div></div>
          <div class="analysis-cell"><div class="label">Projected spread</div><div class="num ${a.projected_spread == null ? "" : a.projected_spread >= 0 ? "good" : "bad"}">${a.projected_spread == null ? "—" : money(a.projected_spread)}</div></div>
        </div>

        <div class="panel">
          <h3>Deal facts</h3>
          <form id="dealForm">
            <div class="field-row">
              <div class="field"><label>List price</label><input name="list_price" type="number" value="${deal.list_price}"></div>
              <div class="field"><label>ARV</label><input name="arv" type="number" value="${deal.arv}"></div>
              <div class="field"><label>Repairs</label><input name="repair_cost" type="number" value="${deal.repair_cost}"></div>
            </div>
            <div class="field-row">
              <div class="field"><label>Current offer</label><input name="offer_price" type="number" value="${deal.offer_price}"></div>
              <div class="field"><label>Contract price</label><input name="contract_price" type="number" value="${deal.contract_price}"></div>
              <div class="field"><label>Assignment fee</label><input name="assignment_fee" type="number" value="${deal.assignment_fee}"></div>
            </div>
            <div class="field-row">
              <div class="field"><label>Status</label>
                <select name="status">${STATUSES.map(([k, l]) => `<option value="${k}" ${deal.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
              </div>
              <div class="field"><label>Listing agent</label><input name="agent_name" value="${esc(deal.agent_name)}"></div>
              <div class="field"><label>Agent contact</label><input name="agent_contact" value="${esc(deal.agent_contact)}"></div>
            </div>
            <div class="field"><label>Notes (the AI agent reads these)</label><textarea name="notes" rows="3">${esc(deal.notes)}</textarea></div>
            <div style="display:flex;gap:10px;justify-content:space-between">
              <button type="button" class="btn btn-danger btn-sm" id="deleteDeal">Delete deal</button>
              <button class="btn btn-primary btn-sm" type="submit">Save changes</button>
            </div>
          </form>
        </div>
      </div>

      <div class="panel chat-panel">
        <div class="chat-head">
          <div class="chat-avatar">${esc(agentName[0] || "R")}</div>
          <div class="who"><b>${esc(agentName)} · negotiation thread</b>
            <span>Paste what the listing agent says — ${esc(agentName)} writes the reply</span></div>
        </div>
        <div class="chat-body" id="chatBody">
          ${thread.length === 0 ? `<div class="chat-empty">No conversation yet.<br>Have ${esc(agentName)} draft the opening offer below.</div>` : ""}
          ${thread.map(bubbleHtml).join("")}
        </div>
        <div class="chat-compose">
          <textarea id="chatInput" placeholder="Paste the listing agent's reply here… e.g. “Seller is firm at $205k.”"></textarea>
          <div class="chat-actions">
            <button class="btn btn-primary btn-sm" id="sendBtn">Send → ${esc(agentName)} replies</button>
            <button class="btn btn-outline btn-sm" id="draftBtn">Draft opening offer</button>
            <button class="btn btn-outline btn-sm" id="logOnlyBtn">Log without reply</button>
          </div>
          <div class="chat-hint">${esc(agentName)} respects your buy box: it will never go above MAO (${money(a.mao)}).</div>
        </div>
      </div>
    </div>`;

  const chatBody = document.getElementById("chatBody");
  chatBody.scrollTop = chatBody.scrollHeight;

  // Save deal facts
  document.getElementById("dealForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api(`/api/deals/${id}`, { method: "PATCH", body });
      toast("Deal saved");
      renderDeal(id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("deleteDeal").addEventListener("click", async () => {
    if (!confirm(`Delete ${deal.address} and its conversation history?`)) return;
    await api(`/api/deals/${id}`, { method: "DELETE" });
    toast("Deal deleted");
    location.hash = "#/pipeline";
  });

  // Chat actions
  const input = document.getElementById("chatInput");
  const buttons = ["sendBtn", "draftBtn", "logOnlyBtn"].map((bid) => document.getElementById(bid));

  async function chatAction(body) {
    buttons.forEach((b) => (b.disabled = true));
    const typing = document.createElement("div");
    typing.className = "typing-row";
    typing.innerHTML = "<i></i><i></i><i></i>";
    if (!body.no_reply) {
      chatBody.appendChild(typing);
      chatBody.scrollTop = chatBody.scrollHeight;
    }
    try {
      const { added } = await api(`/api/deals/${id}/messages`, { method: "POST", body });
      typing.remove();
      const empty = chatBody.querySelector(".chat-empty");
      if (empty && added.length) empty.remove();
      for (const msg of added) chatBody.insertAdjacentHTML("beforeend", bubbleHtml(msg));
      chatBody.scrollTop = chatBody.scrollHeight;
      input.value = "";
    } catch (err) {
      typing.remove();
      toast(err.message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  document.getElementById("sendBtn").addEventListener("click", () => {
    if (!input.value.trim()) return toast("Paste the agent's message first", true);
    chatAction({ content: input.value });
  });
  document.getElementById("draftBtn").addEventListener("click", () =>
    chatAction({ instruction: "Draft the opening offer message to the listing agent for this property." })
  );
  document.getElementById("logOnlyBtn").addEventListener("click", () => {
    if (!input.value.trim()) return toast("Nothing to log", true);
    chatAction({ content: input.value, no_reply: true });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) document.getElementById("sendBtn").click();
  });
}

function bubbleHtml(msg) {
  return `<div class="bubble ${msg.direction}">${esc(msg.content)}<span class="stamp">${timeAgo(msg.created_at)}${msg.engine === "rules" ? " · offline draft" : ""}</span></div>`;
}

// ---------- Buyers ----------
async function renderBuyers() {
  const buyers = await api("/api/buyers");
  $main.innerHTML = `
    <div class="view-head">
      <div><h1>Cash buyers</h1><div class="sub">Your dispo list — who takes your contracts</div></div>
      <button class="btn btn-primary" id="addBuyerBtn">+ Add buyer</button>
    </div>
    <div class="panel" style="padding:8px 4px">
      <table>
        <thead><tr><th>Name</th><th>Markets</th><th>Max price</th><th>Contact</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${buyers.length === 0 ? `<tr><td colspan="6" class="chat-empty">No buyers yet.</td></tr>` : buyers.map((b) => `
            <tr>
              <td><b>${esc(b.name)}</b></td>
              <td>${esc(b.markets)}</td>
              <td>${b.max_price ? money(b.max_price) : "—"}</td>
              <td style="font-size:13px;color:var(--text-dim)">${esc(b.email)}${b.email && b.phone ? "<br>" : ""}${esc(b.phone)}</td>
              <td style="font-size:13px;color:var(--text-dim)">${esc(b.notes)}</td>
              <td><button class="btn btn-danger btn-sm" data-del="${b.id}">✕</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  document.getElementById("addBuyerBtn").addEventListener("click", () => {
    openModal(`
      <h2>Add buyer</h2>
      <form id="buyerForm">
        <div class="field"><label>Name *</label><input name="name" required></div>
        <div class="field-row">
          <div class="field"><label>Email</label><input name="email" type="email"></div>
          <div class="field"><label>Phone</label><input name="phone"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Markets</label><input name="markets" placeholder="Atlanta GA, Tampa FL"></div>
          <div class="field"><label>Max price</label><input name="max_price" type="number"></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
          <button class="btn btn-primary" type="submit">Add buyer</button>
        </div>
      </form>`);
    document.getElementById("cancelModal").addEventListener("click", closeModal);
    document.getElementById("buyerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/buyers", { method: "POST", body: Object.fromEntries(new FormData(e.target).entries()) });
        closeModal();
        toast("Buyer added");
        renderBuyers();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $main.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this buyer?")) return;
      await api(`/api/buyers/${btn.dataset.del}`, { method: "DELETE" });
      renderBuyers();
    })
  );
}

// ---------- Settings ----------
async function renderSettings() {
  const settings = await api("/api/settings");
  $main.innerHTML = `
    <div class="view-head">
      <div><h1>Settings</h1><div class="sub">Buy box and agent configuration — the AI agent obeys these limits</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start" class="dash-cols">
      <div class="panel">
        <h3>Buy box</h3>
        <form id="settingsForm">
          <div class="field-row">
            <div class="field"><label>Max % of ARV</label><input name="max_arv_pct" type="number" min="40" max="95" value="${esc(settings.max_arv_pct)}"></div>
            <div class="field"><label>Min assignment fee ($)</label><input name="min_assignment_fee" type="number" value="${esc(settings.min_assignment_fee)}"></div>
            <div class="field"><label>Default close (days)</label><input name="default_close_days" type="number" min="5" max="60" value="${esc(settings.default_close_days)}"></div>
          </div>
          <div class="field"><label>Markets</label><input name="markets" value="${esc(settings.markets)}"></div>
          <h3 style="margin-top:20px">Agent identity</h3>
          <div class="field-row">
            <div class="field"><label>Agent name</label><input name="agent_name" value="${esc(settings.agent_name)}"></div>
            <div class="field"><label>Company name</label><input name="company_name" value="${esc(settings.company_name)}"></div>
          </div>
          <button class="btn btn-primary" type="submit">Save settings</button>
        </form>
      </div>
      <div class="panel">
        <h3>AI engine</h3>
        <p style="font-size:14px;color:var(--text-dim);margin-bottom:12px">
          Status: <b style="color:${settings.ai_enabled ? "var(--accent)" : "var(--warn)"}">${settings.ai_enabled ? "Claude API connected" : "Offline (rule-based fallback)"}</b>
        </p>
        ${LOCAL_MODE ? `
        <form id="apiKeyForm">
          <div class="field">
            <label>Anthropic API key</label>
            <input name="anthropic_api_key" type="password" value="${esc(settings.anthropic_api_key || "")}" placeholder="sk-ant-…" autocomplete="off">
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-primary btn-sm" type="submit">Save key</button>
            ${settings.anthropic_api_key ? `<button class="btn btn-danger btn-sm" type="button" id="clearKey">Remove key</button>` : ""}
          </div>
        </form>
        <p style="font-size:13.5px;color:var(--text-dim);margin-top:12px">
          The key is stored only in <b>this browser</b> (localStorage) and sent only to
          <code style="color:var(--accent)">api.anthropic.com</code>. Get one at
          <a href="https://console.anthropic.com" target="_blank" rel="noopener" style="color:var(--accent)">console.anthropic.com</a>.
          Without a key, a deterministic rule-based negotiator keeps the app fully functional.
        </p>
        <p style="font-size:13.5px;color:var(--text-dim);margin-top:10px">
          ⚠ Your deals live in this browser too — clearing site data clears them.
        </p>` : `
        <p style="font-size:13.5px;color:var(--text-dim)">
          The negotiation agent uses the Claude API when an <code style="color:var(--accent)">ANTHROPIC_API_KEY</code>
          environment variable is set on the server. Without it, a deterministic rule-based negotiator keeps the app
          fully functional — it opens below MAO and concedes in shrinking steps, but it can't read nuance the way Claude can.
        </p>
        <p style="font-size:13.5px;color:var(--text-dim);margin-top:10px">
          To enable Claude: <code style="color:var(--accent)">export ANTHROPIC_API_KEY=sk-ant-…</code> then restart the server.
        </p>`}
      </div>
    </div>`;

  if (LOCAL_MODE) {
    document.getElementById("apiKeyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const key = new FormData(e.target).get("anthropic_api_key").trim();
      await api("/api/settings", { method: "PUT", body: { anthropic_api_key: key } });
      toast(key ? "API key saved — Claude agent enabled" : "Key removed");
      await loadAiBadge();
      renderSettings();
    });
    const clearBtn = document.getElementById("clearKey");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
      await api("/api/settings", { method: "PUT", body: { anthropic_api_key: "" } });
      toast("Key removed");
      await loadAiBadge();
      renderSettings();
    });
  }

  document.getElementById("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings", { method: "PUT", body: Object.fromEntries(new FormData(e.target).entries()) });
      toast("Settings saved");
      loadAiBadge();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- New deal modal ----------
function dealFormModal() {
  openModal(`
    <h2>New deal</h2>
    <form id="newDealForm">
      <div class="field"><label>Street address *</label><input name="address" required placeholder="412 Maple Ave"></div>
      <div class="field-row">
        <div class="field"><label>City</label><input name="city"></div>
        <div class="field"><label>State</label><input name="state" maxlength="2" placeholder="GA"></div>
        <div class="field"><label>ZIP</label><input name="zip"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Beds</label><input name="beds" type="number" value="3"></div>
        <div class="field"><label>Baths</label><input name="baths" type="number" step="0.5" value="2"></div>
        <div class="field"><label>Sqft</label><input name="sqft" type="number"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>List price</label><input name="list_price" type="number"></div>
        <div class="field"><label>ARV estimate</label><input name="arv" type="number"></div>
        <div class="field"><label>Repair estimate</label><input name="repair_cost" type="number"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Listing agent</label><input name="agent_name"></div>
        <div class="field"><label>Agent contact</label><input name="agent_contact"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2" placeholder="Condition issues, seller motivation, comps…"></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button class="btn btn-primary" type="submit">Create deal</button>
      </div>
    </form>`);
  document.getElementById("cancelModal").addEventListener("click", closeModal);
  document.getElementById("newDealForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const deal = await api("/api/deals", { method: "POST", body: Object.fromEntries(new FormData(e.target).entries()) });
      closeModal();
      toast("Deal created");
      location.hash = `#/deal/${deal.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ============================================================
// Router
// ============================================================

const routes = {
  dashboard: renderDashboard,
  pipeline: renderPipeline,
  buyers: renderBuyers,
  settings: renderSettings,
};

async function route() {
  const hash = location.hash || "#/dashboard";
  const [, view, param] = hash.split("/");

  document.querySelectorAll(".side-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view || (view === "deal" && a.dataset.view === "pipeline"));
  });

  try {
    if (view === "deal" && param) await renderDeal(Number(param));
    else if (routes[view]) await routes[view]();
    else await renderDashboard();
  } catch (err) {
    $main.innerHTML = `<div class="view-head"><h1>Something went wrong</h1></div><p style="color:var(--text-dim)">${esc(err.message)}</p>`;
  }
}

window.addEventListener("hashchange", route);
detectMode().then(loadAiBadge).then(route);
