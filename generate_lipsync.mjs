import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Replicate from "replicate";

const execFileAsync = promisify(execFile);
const DEFAULT_TEXT = `Stop scrolling. New York is split over one father's decision, and the last detail flips the whole story. Watch till the end before you pick a side.`;
let drawtextSupportPromise = null;
const PY_CAPTION_SCRIPT = path.resolve("scripts/render_caption_overlay.py");

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length);
}

async function generateFishAudio({ apiKey, modelId, text, outputPath, fishEndpoint }) {
  const endpoints = fishEndpoint
    ? [fishEndpoint]
    : ["https://api.fish.audio/v1/tts"];
  const basePayload = {
    text,
    reference_id: modelId,
    format: "mp3",
    prosody: {
      speed: 1.03,
      volume: 0
    },
    latency: "balanced",
    chunk_length: 200,
    normalize: true
  };
  const attempts = [
    {
      name: "Authorization Bearer",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model: "s1" },
      body: basePayload
    }
  ];

  const errors = [];
  for (const endpoint of endpoints) {
    for (const attempt of attempts) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: attempt.headers,
          body: JSON.stringify(attempt.body)
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          errors.push(`${endpoint} via ${attempt.name} failed (${response.status}): ${errText}`);
          continue;
        }
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        await writeFile(outputPath, audioBuffer);
        return audioBuffer;
      } catch (error) {
        errors.push(`${endpoint} via ${attempt.name} failed: ${String(error)}`);
      }
    }
  }

  throw new Error(
    `Fish Audio request failed. Verify FISH_API_KEY is valid and has balance. Details: ${errors.join(" | ")}`
  );
}

function splitWords(text, wordsPerLine = 5) {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(" "));
  }
  return lines;
}

function buildCaptionSegments(text, durationSeconds) {
  const lines = splitWords(text, 5);
  const unit = durationSeconds / Math.max(lines.length, 1);
  return lines.map((line, i) => ({
    line,
    start: i * unit,
    end: (i + 1) * unit
  }));
}

async function getVideoDurationSeconds(videoPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Unable to parse video duration from ffprobe output: ${stdout}`);
  }
  return duration;
}

function escapeDrawText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

async function addStylishCaptions({
  inputVideo,
  outputVideo,
  text,
  targetSeconds
}) {
  const inDuration = await getVideoDurationSeconds(inputVideo);
  const finalDuration = targetSeconds > 0 ? targetSeconds : inDuration;
  const padDuration = Math.max(0, finalDuration - inDuration);
  const segments = buildCaptionSegments(text, finalDuration);
  const fontPath = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

  const filters = [];
  if (padDuration > 0) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${padDuration.toFixed(3)}`);
  }

  for (const seg of segments) {
    const enable = `between(t,${seg.start.toFixed(3)},${seg.end.toFixed(3)})`;
    filters.push(
      `drawbox=x=(w-980)/2:y=h-240:w=980:h=120:color=black@0.45:t=fill:enable='${enable}'`
    );
    filters.push(
      `drawtext=fontfile='${fontPath}':text='${escapeDrawText(seg.line)}':fontcolor=white:fontsize=62:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-165:enable='${enable}'`
    );
  }

  const args = ["-y", "-i", inputVideo, "-vf", filters.join(",")];
  if (padDuration > 0) {
    args.push("-af", `apad=pad_dur=${padDuration.toFixed(3)}`);
  }
  args.push(
    "-t",
    finalDuration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputVideo
  );

  await execFileAsync("ffmpeg", args);
}

async function ffmpegSupportsDrawtext() {
  if (!drawtextSupportPromise) {
    drawtextSupportPromise = execFileAsync("ffmpeg", ["-hide_banner", "-filters"])
      .then(({ stdout, stderr }) => /drawtext/.test(`${stdout}\n${stderr}`))
      .catch(() => false);
  }
  return drawtextSupportPromise;
}

async function renderCaptionsWithPythonOverlay({
  inputVideo,
  outputVideo,
  text,
  targetSeconds
}) {
  try {
    await execFileAsync("python3", [
      PY_CAPTION_SCRIPT,
      "--input",
      inputVideo,
      "--output",
      outputVideo,
      "--text",
      text,
      "--target-seconds",
      String(targetSeconds)
    ]);
  } catch (error) {
    const message =
      error instanceof Error && "message" in error ? String(error.message) : String(error);
    throw new Error(
      `Caption rendering fallback failed. Ensure python3 + Pillow are installed. Details: ${message}`
    );
  }
}

async function run() {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  const FISH_API_KEY = process.env.FISH_API_KEY;
  const audioFile = getArg("audioFile", "");
  const audioUrl = getArg("audioUrl", "");

  if (!REPLICATE_API_TOKEN) {
    throw new Error("Missing REPLICATE_API_TOKEN in environment.");
  }
  if (!FISH_API_KEY && !audioFile && !audioUrl) {
    throw new Error("Missing FISH_API_KEY in environment.");
  }

  const fishModelId = getArg("fishModelId", "734a9b543ce2453ea3e0e4212f5fd7f9");
  const fishEndpoint = getArg("fishEndpoint", "");
  const videoPath = getArg("video", "original.MP4");
  const text = getArg("text", DEFAULT_TEXT);
  const audioPath = getArg("audioOut", "fish_audio.mp3");
  const captionArg = getArg("captions", "true").toLowerCase();
  const enableCaptions = captionArg !== "0" && captionArg !== "false" && captionArg !== "off";
  const targetSeconds = Number.parseFloat(getArg("targetSeconds", "10")) || 10;
  const outputPath = getArg("out", "joe_rogan_lipsync.mp4");

  const absVideoPath = path.resolve(videoPath);
  const absAudioPath = path.resolve(audioPath);
  const absOutputPath = path.resolve(outputPath);

  let fishAudioBuffer = null;
  let remoteAudioUrl = "";
  if (audioUrl) {
    console.log("[1/3] Using provided audio URL...");
    remoteAudioUrl = audioUrl;
  } else if (audioFile) {
    console.log("[1/3] Using provided local audio file...");
    fishAudioBuffer = await readFile(path.resolve(audioFile));
  } else {
    console.log("[1/3] Generating voice with Fish Audio...");
    fishAudioBuffer = await generateFishAudio({
      apiKey: FISH_API_KEY,
      modelId: fishModelId,
      text,
      outputPath: absAudioPath,
      fishEndpoint
    });
  }

  console.log(`[2/3] Running lipsync model on Replicate using ${path.basename(absVideoPath)} ...`);
  const videoBuffer = await readFile(absVideoPath);
  const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

  const output = await replicate.run("pixverse/lipsync", {
    input: {
      audio: remoteAudioUrl || fishAudioBuffer,
      video: videoBuffer
    }
  });

  console.log("[3/4] Saving raw output video...");
  const rawOutputPath = enableCaptions
    ? absOutputPath.replace(/\.mp4$/i, ".raw.mp4")
    : absOutputPath;
  if (output && typeof output.url === "function") {
    const url = output.url();
    const download = await fetch(url);
    if (!download.ok) {
      throw new Error(`Failed to download output: ${download.status}`);
    }
    const data = Buffer.from(await download.arrayBuffer());
    await writeFile(rawOutputPath, data);
    if (enableCaptions) {
      const supportsDrawtext = await ffmpegSupportsDrawtext();
      if (supportsDrawtext) {
        console.log("[4/4] Rendering stylish captions...");
        await addStylishCaptions({
          inputVideo: rawOutputPath,
          outputVideo: absOutputPath,
          text,
          targetSeconds
        });
      } else {
        console.log("[4/4] drawtext unavailable. Rendering captions with Python overlay fallback...");
        await renderCaptionsWithPythonOverlay({
          inputVideo: rawOutputPath,
          outputVideo: absOutputPath,
          text,
          targetSeconds
        });
      }
    }
    console.log(`Done. Saved to ${absOutputPath}`);
    console.log(`Remote URL: ${url}`);
    return;
  }

  if (typeof output === "string") {
    const download = await fetch(output);
    if (!download.ok) {
      throw new Error(`Failed to download output URL: ${download.status}`);
    }
    const data = Buffer.from(await download.arrayBuffer());
    await writeFile(rawOutputPath, data);
    if (enableCaptions) {
      const supportsDrawtext = await ffmpegSupportsDrawtext();
      if (supportsDrawtext) {
        console.log("[4/4] Rendering stylish captions...");
        await addStylishCaptions({
          inputVideo: rawOutputPath,
          outputVideo: absOutputPath,
          text,
          targetSeconds
        });
      } else {
        console.log("[4/4] drawtext unavailable. Rendering captions with Python overlay fallback...");
        await renderCaptionsWithPythonOverlay({
          inputVideo: rawOutputPath,
          outputVideo: absOutputPath,
          text,
          targetSeconds
        });
      }
    }
    console.log(`Done. Saved to ${absOutputPath}`);
    console.log(`Remote URL: ${output}`);
    return;
  }

  // Fallback: some clients return binary-like object directly.
  await writeFile(rawOutputPath, output);
  if (enableCaptions) {
    const supportsDrawtext = await ffmpegSupportsDrawtext();
    if (supportsDrawtext) {
      console.log("[4/4] Rendering stylish captions...");
      await addStylishCaptions({
        inputVideo: rawOutputPath,
        outputVideo: absOutputPath,
        text,
        targetSeconds
      });
    } else {
      console.log("[4/4] drawtext unavailable. Rendering captions with Python overlay fallback...");
      await renderCaptionsWithPythonOverlay({
        inputVideo: rawOutputPath,
        outputVideo: absOutputPath,
        text,
        targetSeconds
      });
    }
  }
  console.log(`Done. Saved to ${absOutputPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
