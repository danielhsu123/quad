// scripts/ingest.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const SOURCE_URL =
  "https://www.timeout.com/los-angeles/things-to-do/things-to-do-in-la-this-weekend";
const OUT = "data/events.json";
const SEED = "data/anderson-seed.json";

const CAT_SLOT = {
  social: 0, professional: 3, networking: 2, recruiting: 1,
  sports: 5, food: 4, arts: 3, outdoors: 5,
};
const CAT_EMOJI = {
  social: "🍻", professional: "💼", networking: "💃", recruiting: "📊",
  sports: "⚽", food: "🌮", arts: "🎨", outdoors: "🥾",
};

/* ---------- fetch ---------- */
async function getPage(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  console.log(`Fetched ${html.length} chars of HTML`);
  return html;
}

/* ---------- structured data ---------- */
function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of [].concat(parsed["@graph"] ?? parsed)) {
      if (!n || n["@type"] !== "Event" || !n.startDate) continue;
      out.push({
        title: n.name,
        startDate: n.startDate,
        venue: n.location?.name ?? "Los Angeles",
        description: (n.description ?? "").slice(0, 240),
        url: n.url ?? SOURCE_URL,
        category: "social",
      });
    }
  }
  return out;
}

/* ---------- text extraction ---------- */
function toPlainText(html) {
  const body = html.replace(/[\s\S]*?<body[^>]*>/i, "");
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40000);
}

/* ---------- pull the first [...] out of a response ---------- */
function extractArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/* ---------- Claude ---------- */
async function fromClaude(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  console.log(`Sending ${text.length} chars to Claude`);
  console.log(`--- first 400 chars of page text ---\n${text.slice(0, 400)}\n---`);

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Below is text scraped from a Time Out Los Angeles page listing things to do this weekend.

Extract up to 25 events that have a specific date. Return ONLY a JSON array. No prose, no markdown fences, no explanation. Each element:
{"title":string,"startDate":"YYYY-MM-DDTHH:MM" or "YYYY-MM-DD","venue":string,"description":string under 150 chars,"category":one of ["social","food","arts","sports","outdoors","networking","professional"],"url":string or null}

Rules:
- Skip anything without a specific date (ongoing, evergreen, "all year").
- For a date range, use the first day.
- Assume the next occurrence after today if the year is unclear.
- If you find no events, return exactly: []
- Never invent events.

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
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  console.log(`stop_reason: ${data.stop_reason}`);
  if (data.stop_reason === "max_tokens") {
    console.warn("Response hit the token cap and was cut off mid-JSON.");
  }

  const raw = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!raw) {
    console.error("Claude returned no text. Full response:");
    console.error(JSON.stringify(data, null, 2).slice(0, 2000));
    throw new Error("Empty response from Claude");
  }

  console.log(`--- Claude replied with ${raw.length} chars ---`);
  console.log(raw.slice(0, 600));
  console.log("---");

  const arr = extractArray(raw.replace(/```json|```/g, ""));
  if (!arr) throw new Error("Could not find a valid JSON array in the reply (see log above)");
  return arr;
}

/* ---------- normalize ---------- */
function mondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

function normalize(raw, i) {
  if (!raw?.title || !raw?.startDate) return null;
  const when = new Date(raw.startDate);
  if (isNaN(when)) return null;

  const cat = CAT_SLOT[raw.category] !== undefined ? raw.category : "social";
  const dayIdx = Math.floor((when - mondayOf(when)) / 86400000);
  const hasTime = String(raw.startDate).includes("T");

  return {
    id: "to-" + when.toISOString().slice(0, 10) + "-" + i,
    t: String(raw.title).slice(0, 60),
    gl: CAT_EMOJI[cat],
    p: CAT_SLOT[cat],
    cat,
    date: when.toISOString(),
    d: Math.max(0, Math.min(6, dayIdx)),
    s: hasTime ? String(raw.startDate).slice(11, 16) : "19:00",
    loc: String(raw.venue || "Los Angeles").slice(0, 60),
    host: "Time Out LA",
    hostId: null,
    desc: String(raw.description || "").slice(0, 220) || "Details on Time Out.",
    tags: [],
    going: [],
    source: "timeout",
    url: raw.url || SOURCE_URL,
  };
}

const key = (e) =>
  e.t.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + String(e.date || "").slice(0, 10);

/* ---------- run ---------- */
async function main() {
  const html = await getPage(SOURCE_URL);

  let raw = fromJsonLd(html);
  if (raw.length) {
    console.log(`JSON-LD: found ${raw.length} events`);
  } else {
    console.log("No JSON-LD. Falling back to Claude extraction…");
    raw = await fromClaude(toPlainText(html));
    console.log(`Claude: extracted ${raw.length} events`);
  }

  const scraped = raw.map(normalize).filter(Boolean);
  console.log(`${scraped.length} events survived normalization`);
  if (!scraped.length) throw new Error("0 usable events — leaving events.json alone.");

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
  process.exit(1);
});
