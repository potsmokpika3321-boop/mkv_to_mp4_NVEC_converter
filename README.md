# Converter (Electron + ffmpeg)

A small Electron-based video converter that wraps ffmpeg to remux or re-encode files. It prefers a system ffmpeg when available, detects GPU encoders (NVENC/QSV/AMF/VAAPI), attempts hardware decode/encode when appropriate, and falls back to software (`libx264`) on failure.

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [How encoders are chosen](#how-encoders-are-chosen)
- [Troubleshooting & tips for speed](#troubleshooting--tips-for-speed)
- [Advanced: tuning & parallelism](#advanced-tuning--parallelism)
- [Files of interest](#files-of-interest)
- [Example: enable NVENC](#example-enable-nvenc)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- Probes inputs with `ffprobe` to decide remux vs transcode
- Prefers system `ffmpeg` (PATH or `FFMPEG_BIN`) and falls back to the bundled installer if needed
- Detects available hardware encoders/decoders and will use them when applicable (NVENC, HEVC NVENC, QSV, AMF, VAAPI, CUVID)
- Attempts hardware decode (e.g. CUVID/NVDEC) for HEVC/10-bit inputs when supported
- Strips subtitles, chapters and metadata; maps video + first audio track by default
- Emits the exact ffmpeg command line and ffmpeg stderr to the UI for easier debugging
- Automatic fallback to `libx264` on encoder failures

## Quick start

Requirements

- Node.js (recommended >= 16)
- npm

Install and run (PowerShell):

```powershell
# from project root
npm install
npm start
```

The app will open an Electron window where you can add files/folders and start conversions.

## Usage

- Select files or folders in the UI.
- Each file is probed; if a remux is possible the file will be copied with streams remapped and metadata removed. Otherwise the file will be re-encoded according to detected capabilities.
- Progress, the ffmpeg command used, and ffmpeg stderr are shown in the UI to aid diagnosis.

## Configuration

Environment variables (optional):

- `FFMPEG_BIN` — Full path to an `ffmpeg.exe` to use (recommended if you installed a custom ffmpeg with NVENC/CUVID support).
- `FFPROBE_BIN` — Full path to `ffprobe.exe` (optional).

Set them in PowerShell for the current session:

```powershell
$env:FFMPEG_BIN = 'C:\path\to\ffmpeg.exe'
$env:FFPROBE_BIN = 'C:\path\to\ffprobe.exe'
npm start
```

If not set, the app will prefer `ffmpeg`/`ffprobe` on PATH and finally fall back to the bundled installers.

## How encoders are chosen

1. The input is probed for codec, pixel format, bit depth and stream layout.
2. If a suitable hardware encoder is present (for example, `hevc_nvenc` for 10-bit HEVC sources) the app will try the hardware path and enable hardware decode where helpful.
3. If the hardware path fails (ffmpeg error), the converter retries once using `libx264` (software) with a quality-oriented preset.

## Troubleshooting & tips for speed

1. ffmpeg build

	Not all ffmpeg builds include NVENC/CUVID/hevc_nvenc. If GPU acceleration fails or ffmpeg reports "encoder not found" or "10 bit encode not supported," download a modern ffmpeg build with NVENC support (Gyan or BtbN builds are common for Windows) and point `FFMPEG_BIN` to that binary.

2. Check encoders/decoders

	Run these in PowerShell to inspect your ffmpeg binary:

```powershell
# Encoders containing nvenc/hevc
& $env:FFMPEG_BIN -hide_banner -encoders | Select-String 'nvenc|hevc_nvenc|hevc'
# Decoders containing cuvid/nvdec
& $env:FFMPEG_BIN -hide_banner -decoders | Select-String 'cuvid|nvdec|hevc'
```

	If `$env:FFMPEG_BIN` is not set, replace `& $env:FFMPEG_BIN` with `& ffmpeg` or the full path to your binary.

3. GPU drivers

	Keep GPU drivers updated. NVENC feature availability varies by GPU model and driver version.

4. If NVENC reports "10 bit encode not supported"

	The app will fall back to software. To re-enable NVENC speed you may need:

	- A different ffmpeg build that exposes `hevc_nvenc` and `cuvid`/`nvdec` decoders.
	- A GPU that supports the requested encode profile (10-bit HEVC support differs across GPUs).

5. Software tuning

	For faster software transcodes (at the cost of quality), change libx264 presets. For example set `-preset veryfast` or `-preset superfast` (this is configurable in code if you want to expose it in the UI).

6. When asking for help

	Paste the ffmpeg command line and ffmpeg stderr shown in the UI, and include your GPU model and driver version.

## Advanced: tuning & parallelism

- The main process uses a worker queue sized by CPU cores. When a GPU encoder is detected, the converter reduces concurrent GPU jobs (defaults to a max of 2) to avoid oversubscription.
- Consider lowering concurrency or using faster libx264 presets for higher throughput on CPU-only systems.

## Files of interest

- `converter.js` — core conversion logic (probing, detection, invocation, fallback)
- `main.js` — Electron main process and worker queue orchestration
- `renderer.js` / `renderer.html` — UI and logging of ffmpeg output
- `preload.js` — IPC bridge for the renderer

## Example: enable NVENC (Windows)

1. Download a recent ffmpeg build that includes NVENC (Gyan/BtbN builds).
2. Place `ffmpeg.exe` somewhere (e.g., `C:\tools\ffmpeg\bin\ffmpeg.exe`).
3. Start the app using that binary:

```powershell
$env:FFMPEG_BIN = 'C:\tools\ffmpeg\bin\ffmpeg.exe'
npm start
```

4. Convert a file and watch the UI logs. If you see `hevc_nvenc` or `h264_nvenc` attempted, NVENC was detected. If errors appear, copy the ffmpeg stderr and open an issue.

## Contributing

Contributions welcome. Open issues or submit PRs to:

- improve hardware detection
- add encoder presets / UI controls
- add automated ffmpeg validation scripts

## License

Add your license of choice here (MIT, Apache-2.0, etc.).

