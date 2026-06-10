import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, DEAL_STATUSES, getSettings, saveSettings, analyzeDeal, seedIfEmpty } from "./lib/db.js";
import { generateReply, aiEnabled } from "./lib/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;

if (process.env.SEED_DEMO !== "0") seedIfEmpty();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });

const DEAL_FIELDS = [
  "address", "city", "state", "zip", "beds", "baths", "sqft",
  "list_price", "arv", "repair_cost", "offer_price", "contract_price",
  "assignment_fee", "status", "agent_name", "agent_contact", "notes",
];
const NUMERIC_DEAL_FIELDS = new Set([
  "beds", "baths", "sqft", "list_price", "arv", "repair_cost",
  "offer_price", "contract_price", "assignment_fee",
]);

function sanitizeDeal(body, { partial = false } = {}) {
  const out = {};
  for (const field of DEAL_FIELDS) {
    if (!(field in body)) {
      if (partial) continue;
      out[field] = NUMERIC_DEAL_FIELDS.has(field) ? 0 : field === "status" ? "new" : "";
      continue;
    }
    let value = body[field];
    if (NUMERIC_DEAL_FIELDS.has(field)) {
      value = Number(value) || 0;
    } else {
      value = String(value ?? "").trim();
    }
    if (field === "status" && !DEAL_STATUSES.includes(value)) {
      throw new Error(`Invalid status "${value}"`);
    }
    out[field] = value;
  }
  return out;
}

function dealWithAnalysis(deal, settings) {
  return { ...deal, analysis: analyzeDeal(deal, settings) };
}

function getDeal(id) {
  return db.prepare("SELECT * FROM deals WHERE id = ?").get(id);
}

function getThread(dealId) {
  return db
    .prepare("SELECT * FROM messages WHERE deal_id = ? ORDER BY id ASC")
    .all(dealId);
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const settings = getSettings();

  // GET /api/health
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, ai_enabled: aiEnabled() });
  }

  // GET /api/stats
  if (req.method === "GET" && url.pathname === "/api/stats") {
    const deals = db.prepare("SELECT * FROM deals").all();
    const byStatus = Object.fromEntries(DEAL_STATUSES.map((s) => [s, 0]));
    let pipelineFees = 0;
    let closedFees = 0;
    for (const deal of deals) {
      byStatus[deal.status] = (byStatus[deal.status] || 0) + 1;
      if (["under_contract", "assigned"].includes(deal.status)) pipelineFees += deal.assignment_fee;
      if (deal.status === "closed") closedFees += deal.assignment_fee;
    }
    const buyers = db.prepare("SELECT COUNT(*) AS n FROM buyers").get().n;
    const recent = db.prepare(`
      SELECT m.*, d.address FROM messages m JOIN deals d ON d.id = m.deal_id
      ORDER BY m.id DESC LIMIT 8
    `).all();
    return json(res, 200, {
      by_status: byStatus,
      active: deals.filter((d) => !["closed", "dead"].includes(d.status)).length,
      pipeline_fees: pipelineFees,
      closed_fees: closedFees,
      buyers,
      recent,
    });
  }

  // /api/settings
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") return json(res, 200, { ...settings, ai_enabled: aiEnabled() });
    if (req.method === "PUT") {
      const body = await readBody(req);
      return json(res, 200, { ...saveSettings(body), ai_enabled: aiEnabled() });
    }
  }

  // /api/deals and /api/deals/:id[/messages]
  if (parts[1] === "deals") {
    const id = parts[2] ? Number(parts[2]) : null;

    if (req.method === "GET" && !id) {
      const deals = db.prepare("SELECT * FROM deals ORDER BY updated_at DESC").all();
      return json(res, 200, deals.map((d) => dealWithAnalysis(d, settings)));
    }

    if (req.method === "POST" && !id) {
      const body = await readBody(req);
      if (!body.address || !String(body.address).trim()) {
        return json(res, 400, { error: "address is required" });
      }
      const deal = sanitizeDeal(body);
      const result = db.prepare(`
        INSERT INTO deals (${DEAL_FIELDS.join(", ")})
        VALUES (${DEAL_FIELDS.map(() => "?").join(", ")})
      `).run(...DEAL_FIELDS.map((f) => deal[f]));
      return json(res, 201, dealWithAnalysis(getDeal(result.lastInsertRowid), settings));
    }

    if (!id || !getDeal(id)) return json(res, 404, { error: "Deal not found" });

    if (parts[3] === "messages") {
      if (req.method === "GET") return json(res, 200, getThread(id));

      // POST /api/deals/:id/messages
      // { content }              → log incoming message, agent replies
      // { content, no_reply }    → log incoming message only
      // { instruction }          → agent acts on operator instruction (e.g. draft opening offer)
      if (req.method === "POST") {
        const body = await readBody(req);
        const deal = getDeal(id);
        const insertMsg = db.prepare(
          "INSERT INTO messages (deal_id, direction, content) VALUES (?, ?, ?)"
        );
        const added = [];

        if (body.content && String(body.content).trim()) {
          const r = insertMsg.run(id, "in", String(body.content).trim());
          added.push(db.prepare("SELECT * FROM messages WHERE id = ?").get(r.lastInsertRowid));
        }
        if (!body.no_reply) {
          try {
            const { text, engine } = await generateReply(
              deal, settings, getThread(id),
              body.instruction ? String(body.instruction).trim() : undefined
            );
            const r = insertMsg.run(id, "out", text);
            const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(r.lastInsertRowid);
            added.push({ ...row, engine });
          } catch (err) {
            console.error("Agent error:", err);
            return json(res, 502, { error: `Agent failed: ${err.message}`, added });
          }
        }
        db.prepare("UPDATE deals SET updated_at = datetime('now') WHERE id = ?").run(id);
        return json(res, 200, { added });
      }
    }

    if (req.method === "GET") {
      return json(res, 200, dealWithAnalysis(getDeal(id), settings));
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const updates = sanitizeDeal(body, { partial: true });
      const keys = Object.keys(updates);
      if (keys.length > 0) {
        db.prepare(`
          UPDATE deals SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')
          WHERE id = ?
        `).run(...keys.map((k) => updates[k]), id);
        if (updates.status === "under_contract") {
          db.prepare("INSERT INTO messages (deal_id, direction, content) VALUES (?, 'system', ?)")
            .run(id, "Deal moved to Under Contract");
        }
      }
      return json(res, 200, dealWithAnalysis(getDeal(id), settings));
    }

    if (req.method === "DELETE") {
      db.prepare("DELETE FROM messages WHERE deal_id = ?").run(id);
      db.prepare("DELETE FROM deals WHERE id = ?").run(id);
      return json(res, 200, { ok: true });
    }
  }

  // /api/buyers and /api/buyers/:id
  if (parts[1] === "buyers") {
    const id = parts[2] ? Number(parts[2]) : null;

    if (req.method === "GET" && !id) {
      return json(res, 200, db.prepare("SELECT * FROM buyers ORDER BY name").all());
    }
    if (req.method === "POST" && !id) {
      const body = await readBody(req);
      if (!body.name || !String(body.name).trim()) {
        return json(res, 400, { error: "name is required" });
      }
      const r = db.prepare(
        "INSERT INTO buyers (name, email, phone, markets, max_price, notes) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        String(body.name).trim(), String(body.email || ""), String(body.phone || ""),
        String(body.markets || ""), Number(body.max_price) || 0, String(body.notes || "")
      );
      return json(res, 201, db.prepare("SELECT * FROM buyers WHERE id = ?").get(r.lastInsertRowid));
    }
    if (req.method === "DELETE" && id) {
      db.prepare("DELETE FROM buyers WHERE id = ?").run(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/app" || pathname === "/app/") pathname = "/app/index.html";
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`WholesaleOS running:`);
  console.log(`  Landing page  → http://localhost:${PORT}/`);
  console.log(`  App           → http://localhost:${PORT}/app`);
  console.log(`  AI agent      → ${aiEnabled() ? "Claude (live)" : "rule-based fallback (set ANTHROPIC_API_KEY for Claude)"}`);
});
