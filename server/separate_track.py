import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np


SUPPORTED_DIRECT_INPUTS = {".wav", ".wave", ".flac", ".aiff", ".aif"}
EXPECTED_STEMS = ["vocals", "drums", "bass", "other"]
OTHER_LAYER_PRESETS = [
    ("foundation", "Foundation", "20", "250"),
    ("groove", "Groove", "250", "1200"),
    ("detail", "Detail", "1200", "5000"),
    ("air", "Air", "5000", "16000"),
]
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="separate", choices=["separate", "expand-other"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default=os.environ.get("DEMUCS_MODEL", "mdx_q"))
    parser.add_argument("--segment", default=os.environ.get("DEMUCS_SEGMENT", ""))
    return parser.parse_args()


def require_demucs():
    try:
        __import__("demucs")
    except ImportError as error:
        raise RuntimeError(
            "Demucs is not installed. Run `python3 -m pip install demucs` in this project first."
        ) from error


def ensure_wave_input(input_path: Path, workspace: Path) -> Path:
    if input_path.suffix.lower() in SUPPORTED_DIRECT_INPUTS:
        return input_path

    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError(
            "Non-WAV input requires ffmpeg. Install ffmpeg or upload a WAV file."
        )

    converted_path = workspace / f"{input_path.stem}.wav"
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
        "-ar",
        "44100",
        "-ac",
        "2",
        str(converted_path),
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "FFmpeg conversion failed.")
    return converted_path


def run_demucs(source_path: Path, output_root: Path, model: str, segment: str):
    command = [
        sys.executable,
        "-m",
        "demucs.separate",
        "-n",
        model,
        "-o",
        str(output_root),
    ]
    if segment:
        command.extend(["--segment", str(segment)])
    command.append(str(source_path))
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Demucs separation failed.")


def analyze_track(source_path: Path):
    signal, sample_rate = librosa.load(str(source_path), sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=signal, sr=sample_rate)
    chroma = librosa.feature.chroma_cqt(y=signal, sr=sample_rate)
    chroma_mean = chroma.mean(axis=1)

    major_scores = [
        np.corrcoef(chroma_mean, np.roll(MAJOR_PROFILE, shift))[0, 1] for shift in range(12)
    ]
    minor_scores = [
        np.corrcoef(chroma_mean, np.roll(MINOR_PROFILE, shift))[0, 1] for shift in range(12)
    ]

    best_major_index = int(np.nanargmax(major_scores))
    best_minor_index = int(np.nanargmax(minor_scores))
    best_major_score = float(major_scores[best_major_index])
    best_minor_score = float(minor_scores[best_minor_index])

    if best_major_score >= best_minor_score:
        key_name = KEY_NAMES[best_major_index]
        scale = "major"
    else:
        key_name = KEY_NAMES[best_minor_index]
        scale = "minor"

    return {
        "bpm": round(float(np.asarray(tempo).item()), 1),
        "key": key_name,
        "scale": scale,
        "keyLabel": f"{key_name} {scale}",
    }


def collect_result(output_root: Path, source_path: Path, model: str):
    stem_folder = output_root / model / source_path.stem
    if not stem_folder.exists():
        raise RuntimeError("Demucs finished but no stem directory was created.")

    stems = []
    for stem_name in EXPECTED_STEMS:
        stem_file = stem_folder / f"{stem_name}.wav"
        if stem_file.exists():
            stems.append(
                {
                    "id": stem_name,
                    "name": stem_name.capitalize(),
                    "url": f"/stems/{stem_file.relative_to(output_root.parent).as_posix()}",
                }
            )

    if not stems:
        raise RuntimeError("No expected stem files were produced.")

    return {
        "model": model,
        "sourceName": source_path.name,
        "stems": stems,
    }


def expand_other_layers(source_path: Path, output_root: Path):
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("FFmpeg is required to expand the other stem into sublayers.")

    layers_root = output_root / "expanded-other"
    layers_root.mkdir(parents=True, exist_ok=True)
    layers = []

    for layer_id, layer_name, low_hz, high_hz in OTHER_LAYER_PRESETS:
      output_file = layers_root / f"{layer_id}.wav"
      command = [
          ffmpeg_path,
          "-y",
          "-i",
          str(source_path),
          "-af",
          f"highpass=f={low_hz},lowpass=f={high_hz}",
          str(output_file),
      ]
      result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
      if result.returncode != 0:
          raise RuntimeError(result.stderr.strip() or "Could not create expanded other layers.")

      layers.append(
          {
              "id": layer_id,
              "name": layer_name,
              "range": f"{low_hz}-{high_hz} Hz",
              "url": f"/stems/{output_file.relative_to(output_root.parent).as_posix()}",
          }
      )

    return {
        "sourceName": source_path.name,
        "layers": layers,
    }


def main():
    args = parse_args()
    input_path = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    if args.mode == "expand-other":
        prepared_source = ensure_wave_input(input_path, output_root)
        result = expand_other_layers(prepared_source, output_root)
    else:
        require_demucs()
        prepared_source = ensure_wave_input(input_path, output_root)
        analysis = analyze_track(prepared_source)
        run_demucs(prepared_source, output_root, args.model, args.segment)
        result = collect_result(output_root, prepared_source, args.model)
        result["analysis"] = analysis

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
