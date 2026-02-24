import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HISTORY_PATH = path.resolve("data/text_history.json");
const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const STYLE_EXAMPLES = [
  "I saw a behavioral study tracking emotional meltdowns for months. One name was way above everyone else: Jason Marks. Then the chart went public.",
  "Researchers measured unread notifications versus real productivity. One profile had the widest gap: Oliver Grant. The chart looked fake.",
  "A decision study tested confidence under pressure for six months. One participant overestimated everything: Mason Blake. Even the judges laughed."
];

function canonicalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeHook(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksValidHook(text) {
  if (text.length < 85 || text.length > 260) return false;
  if (!text.includes(":")) return false;
  if (!/\./.test(text)) return false;
  return true;
}

function parseArrayFromModel(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text;

  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.hooks)) return parsed.hooks;
  } catch {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      try {
        const parsed = JSON.parse(slice);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [];
      }
    }
  }

  return [];
}

async function loadHistorySet() {
  try {
    const raw = await readFile(HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.usedTexts) ? parsed.usedTexts : [];
    return new Set(list.map(canonicalize));
  } catch {
    return new Set();
  }
}

async function saveHistorySet(historySet) {
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  const usedTexts = [...historySet.values()].sort();
  await writeFile(HISTORY_PATH, JSON.stringify({ usedTexts }, null, 2));
}

async function requestHooksFromOpenAI({ count, blockedCanonicals }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. LLM hook generation requires OpenAI API access.");
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const blockedSample = blockedCanonicals.slice(-80);

  const system = [
    "You write short-form viral hook lines for talking-head lip-sync videos.",
    "Tone: provocative, data-flavored, playful, punchy. No slurs, no sexual content, no illegal advice.",
    "Each hook must be exactly 2-3 short sentences and include a full name in the second sentence.",
    "Structure target: fake study/setup -> named reveal with colon -> punch ending.",
    "Output ONLY JSON array of strings. No markdown, no commentary."
  ].join(" ");

  const user = [
    `Generate ${count} hooks in English.`,
    "Do not repeat phrasing patterns too tightly across lines.",
    "Avoid any hook that canonicalizes to one of these blocked texts:",
    JSON.stringify(blockedSample),
    "Style examples:",
    JSON.stringify(STYLE_EXAMPLES)
  ].join("\n\n");

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] }
      ],
      max_output_tokens: 1600
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content =
    data?.output_text ||
    data?.output
      ?.flatMap((item) => item?.content || [])
      ?.map((part) => part?.text)
      ?.filter(Boolean)
      ?.join("\n");
  const hooks = parseArrayFromModel(content);
  return hooks.map(normalizeHook).filter(Boolean);
}

export async function generateUniqueHooks(count) {
  const historySet = await loadHistorySet();
  const seen = new Set(historySet);
  const result = [];

  let rounds = 0;
  while (result.length < count && rounds < 6) {
    rounds += 1;
    const needed = count - result.length;
    const requestCount = Math.max(needed * 3, 12);

    const candidates = await requestHooksFromOpenAI({
      count: requestCount,
      blockedCanonicals: [...seen]
    });

    for (const text of candidates) {
      const cleaned = normalizeHook(text);
      if (!looksValidHook(cleaned)) continue;

      const key = canonicalize(cleaned);
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(cleaned);
      if (result.length >= count) break;
    }
  }

  if (result.length < count) {
    throw new Error(`LLM generated only ${result.length}/${count} unique hooks. Retry batch.`);
  }

  for (const text of result) {
    historySet.add(canonicalize(text));
  }
  await saveHistorySet(historySet);

  return result;
}
