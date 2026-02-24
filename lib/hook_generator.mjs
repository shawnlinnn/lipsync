import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HISTORY_PATH = path.resolve("data/text_history.json");

const OPENERS = [
  "I saw a behavioral study tracking",
  "Researchers measured",
  "Scientists tracked",
  "A communication lab analyzed",
  "A workplace audit compared",
  "A focus experiment tracked",
  "A decision study tested",
  "A confidence report ranked",
  "A behavior model predicted",
  "A social experiment tracked"
];

const TOPICS = [
  "emotional meltdowns",
  "procrastination spikes",
  "late-night impulse shopping",
  "who says 'on my way' while still at home",
  "tab-switching every thirty seconds",
  "unread notifications versus real output",
  "excuses per missed deadline",
  "apology rates after conflict",
  "confidence under pressure",
  "who starts plans on Monday and quits by Tuesday",
  "voice notes instead of direct answers",
  "check-ins versus actual workout minutes",
  "who texts 'outside' before leaving home",
  "snack disappearance speed under stress",
  "meeting talk-time versus delivery"
];

const WINDOWS = [
  "for six months",
  "for ninety nights",
  "across one full quarter",
  "for twelve straight weeks",
  "across three departments",
  "for 180 days",
  "for an entire semester",
  "for four reporting cycles",
  "for eleven weeks",
  "over a full season"
];

const REVEALS = [
  "One name was way above everyone else",
  "One profile broke the chart",
  "The biggest outlier was clear",
  "One result dominated the entire dataset",
  "The highest score was not even close",
  "One account kept showing up at number one",
  "The chart leader shocked everyone",
  "One participant kept setting the worst record",
  "One bar was miles ahead of the rest",
  "One ranking stayed unchanged every week"
];

const ENDINGS = [
  "Then the report went public.",
  "The room went silent when they saw it.",
  "Even the reviewers said the pattern looked unreal.",
  "Nobody expected the final chart to look like that.",
  "The comments exploded as soon as it dropped.",
  "The final slide flipped the whole conversation.",
  "That last detail made everyone pick a side.",
  "After that screenshot leaked, nobody argued.",
  "The summary line was brutal.",
  "The numbers looked fake until they verified them twice."
];

const FIRST_NAMES = [
  "Jason",
  "Ethan",
  "Mark",
  "Rachel",
  "Tyler",
  "Kevin",
  "Brandon",
  "Jacob",
  "Lucas",
  "Andrew",
  "Nina",
  "Oliver",
  "Mason",
  "Chloe",
  "Aaron",
  "Sophia",
  "Dylan",
  "Megan",
  "Carter",
  "Zoe",
  "Logan",
  "Avery",
  "Noah",
  "Lily",
  "Caleb",
  "Isla",
  "Wyatt",
  "Elena",
  "Ryan",
  "Leah"
];

const LAST_NAMES = [
  "Marks",
  "Cole",
  "Rivera",
  "Thomas",
  "Gomez",
  "Liu",
  "Scott",
  "Parker",
  "Reed",
  "Chen",
  "Carter",
  "Grant",
  "Blake",
  "Bennett",
  "Mitchell",
  "Brooks",
  "Price",
  "Hayes",
  "Turner",
  "Wright",
  "Foster",
  "Sullivan",
  "Bailey",
  "Ward",
  "Diaz",
  "Hughes",
  "Morris",
  "Powell",
  "Long",
  "Kelly"
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function canonicalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function composeHook(name) {
  const opener = pickRandom(OPENERS);
  const topic = pickRandom(TOPICS);
  const window = pickRandom(WINDOWS);
  const reveal = pickRandom(REVEALS);
  const ending = pickRandom(ENDINGS);
  return `${opener} ${topic} ${window}. ${reveal}: ${name}. ${ending}`;
}

function buildUniqueName(usedNames) {
  for (let i = 0; i < 300; i += 1) {
    const name = `${pickRandom(FIRST_NAMES)} ${pickRandom(LAST_NAMES)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  const fallback = `Casey ${Date.now().toString().slice(-4)}`;
  usedNames.add(fallback);
  return fallback;
}

export async function generateUniqueHooks(count) {
  const historySet = await loadHistorySet();
  const result = [];
  const usedNow = new Set();
  const usedNames = new Set();

  let attempts = 0;
  while (result.length < count && attempts < 3000) {
    attempts += 1;
    const name = buildUniqueName(usedNames);
    const text = composeHook(name);
    const key = canonicalize(text);
    if (historySet.has(key) || usedNow.has(key)) {
      continue;
    }
    usedNow.add(key);
    result.push(text);
  }

  if (result.length < count) {
    throw new Error(`Could not generate ${count} unique hooks; generated ${result.length}.`);
  }

  for (const key of usedNow) {
    historySet.add(key);
  }
  await saveHistorySet(historySet);

  return result;
}
