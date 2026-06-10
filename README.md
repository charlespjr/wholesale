# WholesaleOS

An AI-powered working application for real estate wholesalers: a deal-pipeline
CRM with an AI acquisitions agent (**Remi**) that negotiates with listing
agents, a deal analyzer, a cash-buyers list, and buy-box settings — plus a
marketing landing page.

## Quick start

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite` — no database to install).

```bash
npm install
npm start
# Landing page → http://localhost:3000/
# App          → http://localhost:3000/app
```

To power the negotiation agent with Claude:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Without a key the app stays fully functional — a deterministic rule-based
negotiator (opens below MAO, concedes in shrinking steps) stands in for Claude.

## What it does

- **Dashboard** — active deals, projected/collected assignment fees, pipeline by stage, recent activity feed.
- **Pipeline** — kanban board (New → Analyzing → Offer Sent → Negotiating → Under Contract → Assigned → Closed/Dead) with drag-and-drop stage changes.
- **Deal detail** — editable deal facts plus an auto-computed analyzer:
  - **MAO** (max allowable offer) = ARV × max% − repairs − min assignment fee
  - discount to ARV and projected spread
- **AI negotiation thread** — paste what the listing agent says; Remi writes the reply. Remi is told the buy box and hard-capped at MAO, opens below it, justifies counters, and never reveals internal numbers. "Draft opening offer" generates the first outreach.
- **Buyers** — your dispo list with markets, max price, and notes.
- **Settings** — buy box (max % of ARV, min fee, close timeline), markets, agent/company identity.

## Architecture

```
server.js          Node http server: REST API + static files (no framework)
lib/db.js          node:sqlite schema, settings, deal math (MAO/spread), demo seed
lib/agent.js       AI agent: Claude API via @anthropic-ai/sdk (claude-opus-4-8,
                   adaptive thinking) with a rule-based fallback when no key is set
public/            Landing page (static)
public/app/        The SPA (vanilla JS, hash router)
wholesale.db       SQLite database (created on first run, git-ignored)
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stats` | dashboard numbers + recent activity |
| GET/POST | `/api/deals` | list / create deals (list includes analysis) |
| GET/PATCH/DELETE | `/api/deals/:id` | read / update / delete a deal |
| GET | `/api/deals/:id/messages` | conversation thread |
| POST | `/api/deals/:id/messages` | `{content}` log + AI reply · `{instruction}` AI acts (e.g. draft offer) · `{content, no_reply}` log only |
| GET/POST | `/api/buyers`, DELETE `/api/buyers/:id` | buyers list |
| GET/PUT | `/api/settings` | buy box + agent identity |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | — | enables the Claude-powered agent |
| `REMI_MODEL` | `claude-opus-4-8` | Claude model for the agent |
| `DB_PATH` | `./wholesale.db` | SQLite file location |
| `SEED_DEMO` | `1` | set `0` to skip demo data on an empty DB |

## Notes

- The app is single-tenant with no authentication — run it locally or behind
  your own auth proxy before exposing it to the internet.
- Demo data (3 deals, 3 buyers, one seeded negotiation) loads on first run so
  the app isn't empty; delete it from the UI or start with `SEED_DEMO=0`.
