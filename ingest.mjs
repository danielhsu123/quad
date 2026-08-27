// scripts/ingest.mjs
// Scrapes Time Out LA's weekend page, normalizes to Quad's event schema,
// merges with the hand-seeded Anderson events, writes data/events.json.
//
// Run locally:  ANTHROPIC_API_KEY=sk-... node scripts/ingest.mjs
// Node 18+ required (uses built-in fetch). No npm dependencies.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const SOURCE_URL =
  "https://www.timeout.com/los-angeles/things-to-do/things-to-do-in-la-this-weekend";
const OUT = "data/events.json";
const SEED = "data/anderson-seed.json"; // your hand-curated Anderson events

// Quad's category enum -> palette slot (matches CATS in the app)
const CAT_SLOT = {
  social: 0, professional: 3, networking: 2, recruiting: 1,
  sports: 5, food: 4, arts: 3, outdoors: 5,
};
const CAT_EMOJI = {
  social: "🍻", professional: "💼", networking: "💃", recruiting: "📊",
  sports: "⚽", food: "🌮", arts: "🎨", outdoors: "🥾",
};

/* ---------- 1. fetch ---------- */
async function getPage(url) {
  const res = await fetch(url, {
    headers: {
      // A bare fetch often gets a 403 from Cloudflare. This helps, but is not magic.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/* ---------- 2a. try structured data first (free, exact) ---------- */
function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [].concat(parsed["@graph"] ?? parsed);
    for (const n of nodes) {
      if (!n || n["@type"] !== "Event" || !n.startDate) continue;
      out.push({
        title: n.name,
        startDate: n.startDate,
        venue: n.location?.name ?? n.location?.address?.streetAddress ?? "Los Angeles",
        description: (n.description ?? "").slice(0, 240),
        url: n.url ?? SOURCE_URL,
        category: null, // filled in below
      });
    }
  }
  return out;
}

/* ---------- 2b. fall back to Claude reading the prose ---------- */
function toPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);
}

async function fromClaude(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Below is the text of a Time Out Los Angeles page listing things to do this weekend.

Extract every event that has a specific date. Return ONLY a JSON array, no prose, no markdown fences. Each element:
{"title":string,"startDate":"YYYY-MM-DDTHH:MM" or "YYYY-MM-DD" if no time,"venue":string,"description":string (max 200 chars),"category":one of ["social","food","arts","sports","outdoors","networking","professional"],"url":string or null}

Rules:
- Skip anything with no specific date ("ongoing", "all year", evergreen recommendations).
- If a date range is given, use the first day.
- If you cannot determine the year, assume the next occurrence after today.
- Return [] if you find nothing. Never invent events.

PAGE TEXT:
${text}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(raw);
}

/* ---------- 3. normalize into Quad's shape ---------- */
function mondayOf(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function normalize(raw, i) {
  if (!raw.title || !raw.startDate) return null;
  const when = new Date(raw.startDate);
  if (isNaN(when)) return null;

  const cat = CAT_SLOT[raw.category] !== undefined ? raw.category : "social";
  const dayIdx = Math.round((mondayOf(when).getTime() === mondayOf(new Date()).getTime()
    ? (when - mondayOf(when)) / 86400000
    : (when - mondayOf(when)) / 86400000));

  const hasTime = raw.startDate.includes("T");
  return {
    id: "to" + when.toISOString().slice(0, 10) + "-" + i,
    t: raw.title.slice(0, 60),
    gl: CAT_EMOJI[cat],
    p: CAT_SLOT[cat],
    cat,
    date: when.toISOString(),          // keep the real date for later
    d: Math.max(0, Math.min(6, dayIdx)), // Quad's 0–6 week index
    s: hasTime ? raw.startDate.slice(11, 16) : "19:00",
    loc: (raw.venue || "Los Angeles").slice(0, 60),
    host: "Time Out LA",
    hostId: null,
    desc: (raw.description || "").slice(0, 220) || "Details on Time Out.",
    tags: [],
    going: [],
    source: "timeout",
    url: raw.url || SOURCE_URL,
  };
}

const key = (e) =>
  e.t.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + (e.date || "").slice(0, 10);

/* ---------- 4. run ---------- */
async function main() {
  const html = await getPage(SOURCE_URL);

  let raw = fromJsonLd(html);
  if (raw.length) {
    console.log(`JSON-LD: found ${raw.length} events`);
    raw = raw.map((r) => ({ ...r, category: r.category ?? "social" }));
  } else {
    console.log("No JSON-LD. Falling back to Claude extraction…");
    raw = await fromClaude(toPlainText(html));
    console.log(`Claude: extracted ${raw.length} events`);
  }

  const scraped = raw.map(normalize).filter(Boolean);
  if (!scraped.length) {
    // Do NOT overwrite good data with an empty scrape.
    throw new Error("Scrape produced 0 usable events — leaving events.json alone.");
  }

  const seed = existsSync(SEED) ? JSON.parse(await readFile(SEED, "utf8")) : [];

  const seen = new Set();
  const merged = [...seed, ...scraped].filter((e) => {
    const k = key(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(merged, null, 2));
  console.log(`Wrote ${merged.length} events (${seed.length} seeded, ${scraped.length} scraped).`);
}

main().catch((err) => {
  console.error("Ingest failed:", err.message);
  process.exit(1); // workflow fails loudly; events.json stays as it was
});
