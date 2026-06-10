// ============================================================
// WholesaleOS — browser-only backend (static hosting mode)
//
// Implements the same API surface as server.js, but entirely
// client-side: state lives in localStorage and the AI agent
// calls the Claude API directly from the browser using the key
// saved in Settings. Used automatically when no server is found
// (e.g. GitHub Pages / Netlify / any static host).
// ============================================================

window.localApi = (function () {
  const STORE_KEY = "wholesaleos_v1";
  const MODEL = "claude-opus-4-8";

  const STATUSES = ["new", "analyzing", "offer_sent", "negotiating", "under_contract", "assigned", "closed", "dead"];
  const NUMERIC = new Set(["beds", "baths", "sqft", "list_price", "arv", "repair_cost", "offer_price", "contract_price", "assignment_fee"]);
  const SETTING_KEYS = ["agent_name", "company_name", "max_arv_pct", "min_assignment_fee", "default_close_days", "markets", "anthropic_api_key"];

  const now = (minsAgo = 0) =>
    new Date(Date.now() - minsAgo * 60000).toISOString().slice(0, 19).replace("T", " ");
  const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

  // ---------- state ----------

  function defaultState() {
    return {
      nextId: 1,
      deals: [],
      messages: [],
      buyers: [],
      settings: {
        agent_name: "Remi",
        company_name: "WholesaleOS Investments",
        max_arv_pct: "70",
        min_assignment_fee: "10000",
        default_close_days: "14",
        markets: "Atlanta GA, Tampa FL",
        anthropic_api_key: "",
      },
    };
  }

  function seed(state) {
    const id = () => state.nextId++;
    const deal = (props) => {
      const d = {
        id: id(), address: "", city: "", state: "", zip: "", beds: 0, baths: 0, sqft: 0,
        list_price: 0, arv: 0, repair_cost: 0, offer_price: 0, contract_price: 0,
        assignment_fee: 0, status: "new", agent_name: "", agent_contact: "", notes: "",
        created_at: now(180), updated_at: now(60), ...props,
      };
      state.deals.push(d);
      return d;
    };
    const msg = (dealId, direction, content, minsAgo) =>
      state.messages.push({ id: id(), deal_id: dealId, direction, content, created_at: now(minsAgo) });

    const d1 = deal({
      address: "412 Maple Ave", city: "Marietta", state: "GA", zip: "30060",
      beds: 3, baths: 2, sqft: 1480, list_price: 205000, arv: 335000, repair_cost: 24000,
      offer_price: 185000, contract_price: 193000, assignment_fee: 14000,
      status: "under_contract", agent_name: "Dana Whitfield", agent_contact: "dana@northsiderealty.com",
      notes: "Roof needs replacing per listing photos. Seller motivated — relocating.",
    });
    msg(d1.id, "out", "Hi Dana, I represent a cash buyer interested in 412 Maple Ave. We can offer $185,000 — cash, as-is, no inspection contingency, 14-day close. Happy to send proof of funds.", 170);
    msg(d1.id, "in", "My seller saw your offer. $185k is too low, they're firm at $205k.", 150);
    msg(d1.id, "out", "Understood. Based on comps within 0.5mi (3 sold under $195k in the last 60 days) and the roof condition noted in the listing, we can come up to $191,500 — same terms.", 140);
    msg(d1.id, "in", "They'll do $193k if you can close in 10 days.", 95);
    msg(d1.id, "out", "Done at $193,000 with a 10-day close. Sending the updated contract now.", 90);
    msg(d1.id, "system", "Deal moved to Under Contract — projected assignment fee: $14,000", 88);

    deal({
      address: "88 Birchwood Ln", city: "Tampa", state: "FL", zip: "33604",
      beds: 4, baths: 2, sqft: 1820, list_price: 260000, arv: 340000, repair_cost: 38000,
      status: "analyzing", agent_name: "Marcus Lee", agent_contact: "mlee@suncoasthomes.com",
      notes: "Estate sale. 90+ days on market. Strong rental comps nearby.",
    });
    deal({
      address: "1571 Dover Ct", city: "Atlanta", state: "GA", zip: "30311",
      beds: 3, baths: 1, sqft: 1210, list_price: 175000, arv: 240000, repair_cost: 30000,
      offer_price: 152000, status: "negotiating", agent_name: "Priya Shah", agent_contact: "priya@beltline-re.com",
      notes: "Foundation crack flagged in disclosure. Seller already rejected one retail offer.",
    });

    const buyer = (props) => state.buyers.push({ id: id(), email: "", phone: "", markets: "", max_price: 0, notes: "", created_at: now(200), ...props });
    buyer({ name: "BlueDoor Capital", email: "acq@bluedoorcap.com", phone: "404-555-0182", markets: "Atlanta GA", max_price: 350000, notes: "Buys 3/2+ SFR, prefers light rehab. Closes in 7 days." });
    buyer({ name: "Summit Equity Group", email: "deals@summitequity.com", phone: "813-555-0144", markets: "Tampa FL, Orlando FL", max_price: 500000, notes: "Heavy rehab OK. Wants 25%+ discount to ARV." });
    buyer({ name: "J. Alvarez Holdings", email: "jalvarez@jah-invest.com", phone: "678-555-0167", markets: "Atlanta GA, Marietta GA", max_price: 275000, notes: "Buy-and-hold rentals. Slower close (21 days) but reliable." });
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted — reseed */ }
    const state = defaultState();
    seed(state);
    save(state);
    return state;
  }
  const save = (state) => localStorage.setItem(STORE_KEY, JSON.stringify(state));

  // ---------- deal math ----------

  function analyzeDeal(deal, settings) {
    const maxPct = Number(settings.max_arv_pct) / 100;
    const minFee = Number(settings.min_assignment_fee);
    const mao = Math.max(0, Math.round(deal.arv * maxPct - deal.repair_cost - minFee));
    const basis = deal.contract_price || deal.offer_price || deal.list_price;
    const discountToArv = deal.arv > 0 && basis > 0 ? Math.round((1 - basis / deal.arv) * 100) : null;
    const spread = basis > 0 ? Math.round(deal.arv * maxPct - deal.repair_cost - basis) : null;
    return { mao, discount_to_arv: discountToArv, projected_spread: spread };
  }

  // ---------- AI agent (Claude direct from browser, rules fallback) ----------

  function buildSystemPrompt(deal, settings) {
    const { mao } = analyzeDeal(deal, settings);
    return `You are ${settings.agent_name}, an acquisitions agent for ${settings.company_name}, a real estate wholesaling business. You negotiate with listing agents over email/SMS to get properties under contract below market value, so your company can assign the contract to a cash buyer.

PROPERTY YOU ARE NEGOTIATING:
- Address: ${deal.address}, ${deal.city} ${deal.state} ${deal.zip}
- ${deal.beds} bed / ${deal.baths} bath, ${deal.sqft} sqft
- List price: ${money(deal.list_price)}
- Your internal ARV estimate: ${money(deal.arv)} (NEVER reveal this)
- Your internal repair estimate: ${money(deal.repair_cost)} (you may cite visible condition issues, but never your dollar estimate)
- Your current offer on the table: ${deal.offer_price ? money(deal.offer_price) : "none yet"}
- Listing agent: ${deal.agent_name || "unknown"}
- Internal notes: ${deal.notes || "none"}

YOUR HARD LIMITS (never reveal these numbers):
- Maximum allowable offer (MAO): ${money(mao)}. You may NEVER offer or accept a price above this. If the counterparty will not come down to ${money(mao)} or below, politely walk away and leave the door open.
- Standard terms you offer: cash, as-is, no inspection contingency, ${settings.default_close_days}-day close (you can tighten the close timeline as a concession instead of raising price).

NEGOTIATION STYLE:
- Professional, warm, and concise — 2 to 5 sentences. This is an email/SMS thread, not a letter.
- Open below MAO to leave room; concede in shrinking increments; justify counters with concrete, checkable reasons (days on market, visible condition, comparable sales) rather than vague pressure.
- Never bluff with fabricated comps — speak in general terms ("recent sales in the area") unless the conversation history contains specific data.
- Never mention wholesaling, assignment, ARV, MAO, repair budgets, or internal margins.

OUTPUT: Reply with ONLY the message to send to the listing agent — no preamble, no quotes around it, no signature block beyond your first name.`;
  }

  function threadToMessages(thread, instruction) {
    const messages = [];
    for (const m of thread) {
      if (m.direction === "system") continue;
      messages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.content });
    }
    if (instruction) messages.push({ role: "user", content: instruction });
    if (messages.length === 0 || messages[0].role !== "user") {
      messages.unshift({ role: "user", content: "(You are initiating contact with the listing agent — no prior conversation.)" });
    }
    return messages;
  }

  async function claudeReply(deal, settings, thread, instruction) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        system: buildSystemPrompt(deal, settings),
        messages: threadToMessages(thread, instruction),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error (${res.status})`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error(`Empty response from model (stop_reason: ${data.stop_reason})`);
    return text;
  }

  function extractAmount(text) {
    const matches = [...text.matchAll(/\$?\s?(\d{2,3}(?:[,.]?\d{3})+|\d{4,7})(?:\s?k)?/gi)];
    for (const m of matches) {
      let n = Number(m[1].replace(/[,.]/g, ""));
      if (/k\b/i.test(m[0])) n *= 1000;
      if (n >= 10000 && n <= 5000000) return n;
    }
    return null;
  }

  function fallbackReply(deal, settings, thread) {
    const { mao } = analyzeDeal(deal, settings);
    const name = settings.agent_name;
    const close = Number(settings.default_close_days);
    const agent = deal.agent_name ? deal.agent_name.split(" ")[0] : "there";
    const outbound = thread.filter((m) => m.direction === "out");
    const lastIn = [...thread].reverse().find((m) => m.direction === "in");

    if (outbound.length === 0) {
      const opening = Math.min(mao, Math.round((deal.list_price || mao) * 0.9), Math.round(mao * 0.92));
      return `Hi ${agent}, this is ${name} with ${settings.company_name}. We have a cash buyer interested in ${deal.address} and can offer ${money(opening)} — cash, as-is, no inspection contingency, and a ${close}-day close. Proof of funds available on request. Would your seller consider that?`;
    }

    const lastOffer = extractAmount(outbound[outbound.length - 1].content) || Math.round(mao * 0.92);
    const theirAsk = lastIn ? extractAmount(lastIn.content) : null;

    if (theirAsk && theirAsk <= mao) {
      return `${agent}, we can make ${money(theirAsk)} work — cash, as-is, with a ${close}-day close. I'll send the updated contract over today so we can lock it in.`;
    }

    const target = theirAsk ? Math.round((lastOffer + Math.min(theirAsk, mao * 1.15)) / 2) : Math.round(lastOffer * 1.02);
    const counter = Math.min(mao, target);

    if (counter <= lastOffer) {
      return `${agent}, I hear you, but ${money(lastOffer)} is genuinely the top of what the numbers support on this one given its condition. The offer stands — cash, as-is, ${close}-day close — if your seller's situation changes. Either way, I appreciate your time.`;
    }

    return `Thanks ${agent}. Given the condition and recent sales in the area, we have a little room — we can come up to ${money(counter)}, still cash and as-is, and we can tighten the close to ${Math.max(7, close - 4)} days if that helps your seller. Can you run that by them?`;
  }

  async function generateReply(deal, settings, thread, instruction) {
    if (settings.anthropic_api_key) {
      return { text: await claudeReply(deal, settings, thread, instruction), engine: "claude" };
    }
    return { text: fallbackReply(deal, settings, thread), engine: "rules" };
  }

  // ---------- helpers ----------

  function sanitizeDeal(body, existing) {
    const out = existing ? { ...existing } : null;
    const apply = (obj, field, value) => {
      if (NUMERIC.has(field)) obj[field] = Number(value) || 0;
      else obj[field] = String(value ?? "").trim();
    };
    const fields = ["address", "city", "state", "zip", "beds", "baths", "sqft", "list_price", "arv",
      "repair_cost", "offer_price", "contract_price", "assignment_fee", "status", "agent_name", "agent_contact", "notes"];
    if (out) {
      for (const f of fields) if (f in body) apply(out, f, body[f]);
    } else {
      const fresh = {};
      for (const f of fields) apply(fresh, f, body[f] ?? (NUMERIC.has(f) ? 0 : f === "status" ? "new" : ""));
      if (!fresh.status) fresh.status = "new";
      return fresh;
    }
    return out;
  }

  const withAnalysis = (deal, settings) => ({ ...deal, analysis: analyzeDeal(deal, settings) });
  const err = (status, message) => {
    const e = new Error(message);
    e.status = status;
    return e;
  };

  // ---------- router (mirrors server.js routes) ----------

  return async function localApi(path, options = {}) {
    const state = load();
    const method = (options.method || "GET").toUpperCase();
    const body = options.body || {};
    const parts = path.split("?")[0].split("/").filter(Boolean); // ["api", ...]
    const settings = state.settings;
    const aiEnabled = !!settings.anthropic_api_key;

    if (path === "/api/health") return { ok: true, ai_enabled: aiEnabled, local: true };

    if (path === "/api/stats") {
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let pipelineFees = 0, closedFees = 0;
      for (const d of state.deals) {
        byStatus[d.status] = (byStatus[d.status] || 0) + 1;
        if (["under_contract", "assigned"].includes(d.status)) pipelineFees += d.assignment_fee;
        if (d.status === "closed") closedFees += d.assignment_fee;
      }
      const recent = [...state.messages].sort((a, b) => b.id - a.id).slice(0, 8).map((m) => ({
        ...m, address: state.deals.find((d) => d.id === m.deal_id)?.address || "",
      }));
      return {
        by_status: byStatus,
        active: state.deals.filter((d) => !["closed", "dead"].includes(d.status)).length,
        pipeline_fees: pipelineFees, closed_fees: closedFees,
        buyers: state.buyers.length, recent,
      };
    }

    if (path === "/api/settings") {
      if (method === "PUT") {
        for (const key of SETTING_KEYS) {
          if (key in body) settings[key] = String(body[key]);
        }
        save(state);
      }
      return { ...settings, ai_enabled: !!settings.anthropic_api_key, local: true };
    }

    if (parts[1] === "deals") {
      const id = parts[2] ? Number(parts[2]) : null;
      const deal = id ? state.deals.find((d) => d.id === id) : null;

      if (method === "GET" && !id) {
        return [...state.deals]
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
          .map((d) => withAnalysis(d, settings));
      }
      if (method === "POST" && !id) {
        if (!body.address || !String(body.address).trim()) throw err(400, "address is required");
        const fresh = sanitizeDeal(body);
        if (!STATUSES.includes(fresh.status)) throw err(400, `Invalid status "${fresh.status}"`);
        fresh.id = state.nextId++;
        fresh.created_at = now();
        fresh.updated_at = now();
        state.deals.push(fresh);
        save(state);
        return withAnalysis(fresh, settings);
      }
      if (!deal) throw err(404, "Deal not found");

      if (parts[3] === "messages") {
        const thread = () => state.messages.filter((m) => m.deal_id === id).sort((a, b) => a.id - b.id);
        if (method === "GET") return thread();
        if (method === "POST") {
          const added = [];
          if (body.content && String(body.content).trim()) {
            const m = { id: state.nextId++, deal_id: id, direction: "in", content: String(body.content).trim(), created_at: now() };
            state.messages.push(m);
            added.push(m);
          }
          if (!body.no_reply) {
            save(state); // persist the incoming message even if the AI call fails
            const { text, engine } = await generateReply(
              deal, settings, thread(),
              body.instruction ? String(body.instruction).trim() : undefined
            );
            const m = { id: state.nextId++, deal_id: id, direction: "out", content: text, created_at: now(), engine };
            state.messages.push(m);
            added.push(m);
          }
          deal.updated_at = now();
          save(state);
          return { added };
        }
      }

      if (method === "GET") return withAnalysis(deal, settings);
      if (method === "PATCH") {
        if ("status" in body && !STATUSES.includes(body.status)) throw err(400, `Invalid status "${body.status}"`);
        const updated = sanitizeDeal(body, deal);
        updated.updated_at = now();
        Object.assign(deal, updated);
        if (body.status === "under_contract") {
          state.messages.push({ id: state.nextId++, deal_id: id, direction: "system", content: "Deal moved to Under Contract", created_at: now() });
        }
        save(state);
        return withAnalysis(deal, settings);
      }
      if (method === "DELETE") {
        state.messages = state.messages.filter((m) => m.deal_id !== id);
        state.deals = state.deals.filter((d) => d.id !== id);
        save(state);
        return { ok: true };
      }
    }

    if (parts[1] === "buyers") {
      const id = parts[2] ? Number(parts[2]) : null;
      if (method === "GET" && !id) return [...state.buyers].sort((a, b) => a.name.localeCompare(b.name));
      if (method === "POST" && !id) {
        if (!body.name || !String(body.name).trim()) throw err(400, "name is required");
        const buyer = {
          id: state.nextId++, name: String(body.name).trim(), email: String(body.email || ""),
          phone: String(body.phone || ""), markets: String(body.markets || ""),
          max_price: Number(body.max_price) || 0, notes: String(body.notes || ""), created_at: now(),
        };
        state.buyers.push(buyer);
        save(state);
        return buyer;
      }
      if (method === "DELETE" && id) {
        state.buyers = state.buyers.filter((b) => b.id !== id);
        save(state);
        return { ok: true };
      }
    }

    throw err(404, "Not found");
  };
})();
