import Anthropic from "@anthropic-ai/sdk";
import { analyzeDeal } from "./db.js";

const MODEL = process.env.REMI_MODEL || "claude-opus-4-8";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function aiEnabled() {
  return client !== null;
}

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

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

// Map the stored thread to API turns: incoming = user, our replies = assistant.
function threadToMessages(thread, instruction) {
  const messages = [];
  for (const msg of thread) {
    if (msg.direction === "system") continue;
    messages.push({
      role: msg.direction === "in" ? "user" : "assistant",
      content: msg.content,
    });
  }
  if (instruction) {
    messages.push({ role: "user", content: instruction });
  }
  // The API requires the first message to be from the user.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({
      role: "user",
      content: "(You are initiating contact with the listing agent — no prior conversation.)",
    });
  }
  return messages;
}

async function claudeReply(deal, settings, thread, instruction) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: buildSystemPrompt(deal, settings),
    messages: threadToMessages(thread, instruction),
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`Empty response from model (stop_reason: ${response.stop_reason})`);
  return text;
}

// ---------------------------------------------------------------------------
// Fallback negotiator — keeps the app fully usable with no API key set.
// Rule-based: opens at ~92% of MAO, then concedes half the remaining gap on
// each round, never exceeding MAO.
// ---------------------------------------------------------------------------

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
  const close = settings.default_close_days;
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

/**
 * Generate the agent's next message in a deal thread.
 * @param {object} deal      deal row
 * @param {object} settings  settings map
 * @param {Array}  thread    prior messages [{direction, content}]
 * @param {string} [instruction] optional steering instruction from the operator
 * @returns {Promise<{text: string, engine: "claude"|"rules"}>}
 */
export async function generateReply(deal, settings, thread, instruction) {
  if (client) {
    const text = await claudeReply(deal, settings, thread, instruction);
    return { text, engine: "claude" };
  }
  return { text: fallbackReply(deal, settings, thread), engine: "rules" };
}
