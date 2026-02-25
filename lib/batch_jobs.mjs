import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { generateUniqueHooks } from "./hook_generator.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const RUNS_DIR = path.resolve("runs");
const SCRIPT_PATH = path.resolve("generate_lipsync.mjs");
const jobs = new Map();
const RESTARTED_ERROR = "This task was interrupted by a service restart. Please create a new batch.";

let queue = Promise.resolve();

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "clip";
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    total: job.total,
    error: job.error,
    items: Array.isArray(job.items) ? job.items.map((item) => ({ ...item })) : [],
    manifestUrl: job.manifestUrl
  };
}

function jobDir(id) {
  return path.join(RUNS_DIR, id);
}

function jobStatePath(id) {
  return path.join(jobDir(id), "job.json");
}

function hydrateJob(jobLike) {
  return {
    id: jobLike.id,
    status: jobLike.status || "queued",
    createdAt: jobLike.createdAt || new Date().toISOString(),
    startedAt: jobLike.startedAt ?? null,
    finishedAt: jobLike.finishedAt ?? null,
    progress: Number.isFinite(jobLike.progress) ? jobLike.progress : 0,
    total: Number.isFinite(jobLike.total) ? jobLike.total : 10,
    error: jobLike.error ?? null,
    items: Array.isArray(jobLike.items) ? jobLike.items.map((item) => ({ ...item })) : [],
    manifestUrl: jobLike.manifestUrl ?? null
  };
}

async function persistJob(job) {
  const snapshot = publicJob(job);
  await mkdir(jobDir(snapshot.id), { recursive: true });
  await writeFile(jobStatePath(snapshot.id), JSON.stringify(snapshot, null, 2));
}

async function readPersistedJob(id) {
  try {
    const raw = await readFile(jobStatePath(id), "utf-8");
    return hydrateJob(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function listPersistedJobs() {
  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const loaded = await Promise.all(ids.map((id) => readPersistedJob(id)));
    return loaded.filter(Boolean);
  } catch {
    return [];
  }
}

async function runOne({ text, outputPath, videoPath, fishModelId }) {
  await execFileAsync(
    "node",
    [
      SCRIPT_PATH,
      "--captions=true",
      `--fishModelId=${fishModelId}`,
      `--video=${videoPath}`,
      `--text=${text}`,
      `--out=${outputPath}`
    ],
    {
      cwd: ROOT,
      env: process.env,
      maxBuffer: 1024 * 1024 * 10
    }
  );
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await persistJob(job);

  const replicateToken = (process.env.REPLICATE_API_TOKEN || "").trim();
  const fishApiKey = (process.env.FISH_API_KEY || "").trim();
  if (!replicateToken || !fishApiKey) {
    throw new Error("Missing REPLICATE_API_TOKEN or FISH_API_KEY environment variable.");
  }

  const videoPath = process.env.BASE_VIDEO_PATH || "original_1920.mp4";
  const fishModelId = process.env.FISH_MODEL_ID || "734a9b543ce2453ea3e0e4212f5fd7f9";

  const runDir = path.join(RUNS_DIR, job.id);
  await mkdir(runDir, { recursive: true });

  const texts = await generateUniqueHooks(job.total);
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i];
    const idx = String(i + 1).padStart(2, "0");
    const filename = `${idx}_${slugify(text)}.mp4`;
    const absOutput = path.join(runDir, filename);

    job.items[i] = {
      index: i + 1,
      status: "running",
      text,
      file: `/runs/${job.id}/${filename}`
    };
    await persistJob(job);

    try {
      await runOne({
        text,
        outputPath: absOutput,
        videoPath,
        fishModelId
      });
    } catch (error) {
      job.items[i] = {
        ...job.items[i],
        status: "failed"
      };
      await persistJob(job);
      throw error;
    }

    job.items[i] = {
      ...job.items[i],
      status: "done"
    };
    job.progress = i + 1;
    await persistJob(job);
  }

  const manifest = {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: new Date().toISOString(),
    total: job.total,
    items: job.items
  };

  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  job.status = "completed";
  job.finishedAt = manifest.finishedAt;
  job.manifestUrl = `/runs/${job.id}/manifest.json`;
  await persistJob(job);
}

function buildNotFoundFallbackJob(id) {
  const now = new Date().toISOString();
  return {
    id,
    status: "failed",
    createdAt: now,
    startedAt: null,
    finishedAt: now,
    progress: 0,
    total: 10,
    error: RESTARTED_ERROR,
    items: Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      status: "failed",
      text: null,
      file: null
    })),
    manifestUrl: null
  };
}

export async function createBatchJob({ total = 10 } = {}) {
  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: 0,
    total,
    error: null,
    items: Array.from({ length: total }, (_, i) => ({
      index: i + 1,
      status: "queued",
      text: null,
      file: null
    })),
    manifestUrl: null
  };

  jobs.set(id, job);
  await persistJob(job);

  queue = queue
    .then(() => processJob(job))
    .catch(async (error) => {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      await persistJob(job);
    });

  return publicJob(job);
}

export async function getBatchJob(id) {
  const job = jobs.get(id);
  if (job) return publicJob(job);

  const persisted = await readPersistedJob(id);
  if (!persisted) {
    return buildNotFoundFallbackJob(id);
  }

  if (persisted.status === "queued" || persisted.status === "running") {
    persisted.status = "failed";
    persisted.finishedAt = new Date().toISOString();
    persisted.error = persisted.error || RESTARTED_ERROR;
    await persistJob(persisted);
  }

  jobs.set(id, hydrateJob(persisted));
  return publicJob(persisted);
}

export async function listBatchJobs() {
  const merged = new Map();

  for (const job of jobs.values()) {
    merged.set(job.id, publicJob(job));
  }

  const persisted = await listPersistedJobs();
  for (const job of persisted) {
    if (!merged.has(job.id)) {
      merged.set(job.id, publicJob(job));
    }
  }

  return [...merged.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
