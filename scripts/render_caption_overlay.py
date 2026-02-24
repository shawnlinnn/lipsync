#!/usr/bin/env python3
import argparse
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def ffprobe_duration(video_path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(video_path),
        ],
        text=True,
    ).strip()
    return float(out)


def split_words(text: str, words_per_line: int = 5):
    words = text.replace("\n", " ").split()
    if not words:
        return ["..."]
    lines = []
    for i in range(0, len(words), words_per_line):
        lines.append(" ".join(words[i : i + words_per_line]))
    return lines


def pick_font(size: int):
    candidates = [
        os.environ.get("CAPTION_FONT_PATH", ""),
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                continue
    return ImageFont.load_default()


def fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int):
    for size in [62, 58, 54, 50, 46, 42, 38, 34]:
        font = pick_font(size)
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=3)
        text_w = bbox[2] - bbox[0]
        if text_w <= max_width:
            return font, bbox
    font = pick_font(30)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=3)
    return font, bbox


def render_caption_pngs(lines, folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    width, height = 980, 170

    for idx, line in enumerate(lines, start=1):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        draw.rounded_rectangle(
            (0, 14, width, height - 14),
            radius=24,
            fill=(0, 0, 0, 150),
        )

        font, bbox = fit_font(draw, line, max_width=width - 70)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        x = (width - text_w) // 2
        y = (height - text_h) // 2 - 4
        draw.text(
            (x, y),
            line,
            font=font,
            fill=(255, 255, 255, 255),
            stroke_width=3,
            stroke_fill=(10, 10, 10, 255),
        )

        img.save(folder / f"cap_{idx}.png")


def run(input_video: Path, output_video: Path, text: str, target_seconds: float):
    in_duration = ffprobe_duration(input_video)
    final_duration = target_seconds if target_seconds > 0 else in_duration
    pad_duration = max(0.0, final_duration - in_duration)

    lines = split_words(text, words_per_line=5)

    with tempfile.TemporaryDirectory(prefix="caption_overlay_") as temp_dir:
        png_dir = Path(temp_dir)
        render_caption_pngs(lines, png_dir)

        starts = []
        ends = []
        step = final_duration / max(len(lines), 1)
        cur = 0.0
        for _ in lines:
            starts.append(cur)
            cur += step
            ends.append(cur)
        ends[-1] = final_duration

        cmd = ["ffmpeg", "-y", "-i", str(input_video)]
        for i in range(1, len(lines) + 1):
            cmd += ["-loop", "1", "-t", f"{final_duration:.3f}", "-i", str(png_dir / f"cap_{i}.png")]

        chain = []
        if pad_duration > 0:
            chain.append(f"[0:v]tpad=stop_mode=clone:stop_duration={pad_duration:.3f}[vbase]")
            prev = "[vbase]"
        else:
            prev = "[0:v]"

        pos = "x=(W-w)/2:y=H-h-250"
        for i in range(1, len(lines) + 1):
            out = "[vout]" if i == len(lines) else f"[v{i}]"
            chain.append(
                f"{prev}[{i}:v]overlay={pos}:enable='between(t,{starts[i-1]:.3f},{ends[i-1]:.3f})'{out}"
            )
            prev = out

        cmd += [
            "-filter_complex",
            ";".join(chain),
            "-map",
            "[vout]",
            "-map",
            "0:a",
        ]

        if pad_duration > 0:
            cmd += ["-af", f"apad=pad_dur={pad_duration:.3f}"]

        cmd += [
            "-t",
            f"{final_duration:.3f}",
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
            str(output_video),
        ]

        subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser(description="Render caption overlays as PNG and burn into video")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--target-seconds", type=float, default=10.0)
    args = parser.parse_args()

    run(Path(args.input), Path(args.output), args.text, args.target_seconds)


if __name__ == "__main__":
    main()
