import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "wholesale.db");

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS deals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    address         TEXT NOT NULL,
    city            TEXT DEFAULT '',
    state           TEXT DEFAULT '',
    zip             TEXT DEFAULT '',
    beds            INTEGER DEFAULT 0,
    baths           REAL DEFAULT 0,
    sqft            INTEGER DEFAULT 0,
    list_price      REAL DEFAULT 0,
    arv             REAL DEFAULT 0,
    repair_cost     REAL DEFAULT 0,
    offer_price     REAL DEFAULT 0,
    contract_price  REAL DEFAULT 0,
    assignment_fee  REAL DEFAULT 0,
    status          TEXT DEFAULT 'new',
    agent_name      TEXT DEFAULT '',
    agent_contact   TEXT DEFAULT '',
    notes           TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    direction   TEXT NOT NULL CHECK (direction IN ('in', 'out', 'system')),
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS buyers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    markets     TEXT DEFAULT '',
    max_price   REAL DEFAULT 0,
    notes       TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

export const DEAL_STATUSES = [
  "new",
  "analyzing",
  "offer_sent",
  "negotiating",
  "under_contract",
  "assigned",
  "closed",
  "dead",
];

const DEFAULT_SETTINGS = {
  agent_name: "Remi",
  company_name: "WholesaleOS Investments",
  max_arv_pct: "70",
  min_assignment_fee: "10000",
  default_close_days: "14",
  markets: "Atlanta GA, Tampa FL",
};

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

export function saveSettings(updates) {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(updates)) {
    if (key in DEFAULT_SETTINGS) stmt.run(key, String(value));
  }
  return getSettings();
}

// MAO (maximum allowable offer): ARV * maxPct - repairs - your assignment fee
export function analyzeDeal(deal, settings) {
  const maxPct = Number(settings.max_arv_pct) / 100;
  const minFee = Number(settings.min_assignment_fee);
  const mao = Math.max(0, Math.round(deal.arv * maxPct - deal.repair_cost - minFee));
  const basis = deal.contract_price || deal.offer_price || deal.list_price;
  const discountToArv = deal.arv > 0 && basis > 0 ? Math.round((1 - basis / deal.arv) * 100) : null;
  const spread = basis > 0 ? Math.round(deal.arv * maxPct - deal.repair_cost - basis) : null;
  return { mao, discount_to_arv: discountToArv, projected_spread: spread };
}

export function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM deals").get().n;
  if (count > 0) return;

  const insertDeal = db.prepare(`
    INSERT INTO deals (address, city, state, zip, beds, baths, sqft, list_price, arv,
      repair_cost, offer_price, contract_price, assignment_fee, status, agent_name, agent_contact, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMsg = db.prepare(
    "INSERT INTO messages (deal_id, direction, content) VALUES (?, ?, ?)"
  );
  const insertBuyer = db.prepare(
    "INSERT INTO buyers (name, email, phone, markets, max_price, notes) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const d1 = insertDeal.run(
    "412 Maple Ave", "Marietta", "GA", "30060", 3, 2, 1480,
    205000, 335000, 24000, 185000, 193000, 14000, "under_contract",
    "Dana Whitfield", "dana@northsiderealty.com",
    "Roof needs replacing per listing photos. Seller motivated — relocating."
  ).lastInsertRowid;
  insertMsg.run(d1, "out", "Hi Dana, I represent a cash buyer interested in 412 Maple Ave. We can offer $185,000 — cash, as-is, no inspection contingency, 14-day close. Happy to send proof of funds.");
  insertMsg.run(d1, "in", "My seller saw your offer. $185k is too low, they're firm at $205k.");
  insertMsg.run(d1, "out", "Understood. Based on comps within 0.5mi (3 sold under $195k in the last 60 days) and the roof condition noted in the listing, we can come up to $191,500 — same terms.");
  insertMsg.run(d1, "in", "They'll do $193k if you can close in 10 days.");
  insertMsg.run(d1, "out", "Done at $193,000 with a 10-day close. Sending the updated contract now.");
  insertMsg.run(d1, "system", "Deal moved to Under Contract — projected assignment fee: $14,000");

  insertDeal.run(
    "88 Birchwood Ln", "Tampa", "FL", "33604", 4, 2, 1820,
    260000, 340000, 38000, 0, 0, 0, "analyzing",
    "Marcus Lee", "mlee@suncoasthomes.com",
    "Estate sale. 90+ days on market. Strong rental comps nearby."
  );

  insertDeal.run(
    "1571 Dover Ct", "Atlanta", "GA", "30311", 3, 1, 1210,
    175000, 240000, 30000, 152000, 0, 0, "negotiating",
    "Priya Shah", "priya@beltline-re.com",
    "Foundation crack flagged in disclosure. Seller already rejected one retail offer."
  );

  insertBuyer.run("BlueDoor Capital", "acq@bluedoorcap.com", "404-555-0182", "Atlanta GA", 350000, "Buys 3/2+ SFR, prefers light rehab. Closes in 7 days.");
  insertBuyer.run("Summit Equity Group", "deals@summitequity.com", "813-555-0144", "Tampa FL, Orlando FL", 500000, "Heavy rehab OK. Wants 25%+ discount to ARV.");
  insertBuyer.run("J. Alvarez Holdings", "jalvarez@jah-invest.com", "678-555-0167", "Atlanta GA, Marietta GA", 275000, "Buy-and-hold rentals. Slower close (21 days) but reliable.");
}
