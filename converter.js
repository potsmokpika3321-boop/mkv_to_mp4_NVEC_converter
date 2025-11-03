const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const path = require('path');
const fs = require('fs');
const { execFile, spawnSync } = require('child_process');

// Allow overriding the ffmpeg/ffprobe binary via environment variables when you
// want to use a custom build (for example, one compiled with NVENC/QSV).
// Prefer an ffmpeg/ffprobe available on PATH if present, then env vars, then
// the bundled ffmpeg from @ffmpeg-installer.
const envFfmpeg = process.env.FFMPEG_BIN;
const envFfprobe = process.env.FFPROBE_BIN;
let ffmpegPath = envFfmpeg;
let ffprobePath = envFfprobe;

// Quick check: is 'ffmpeg' available on PATH? If so, prefer it unless an env var is set.
if (!ffmpegPath) {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    if (res && res.status === 0) ffmpegPath = 'ffmpeg';
  } catch (e) {
    // ignore
  }
}
if (!ffprobePath) {
  try {
    const res2 = spawnSync('ffprobe', ['-version'], { windowsHide: true });
    if (res2 && res2.status === 0) ffprobePath = 'ffprobe';
  } catch (e) {
    // ignore
  }
}

if (!ffmpegPath) ffmpegPath = ffmpegInstaller.path;
if (!ffprobePath) ffprobePath = ffprobeInstaller.path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Determine whether we can remux (copy streams) into mp4
 * We'll only copy if video is h264 and audio is aac (or audio absent).
 */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    });
  });
}

// Detect available hardware encoder (nvenc/qsv/amf/vaapi) and cache result
let _cachedHwEncoder = null;
function detectHardwareEncoder() {
  if (_cachedHwEncoder !== null) return Promise.resolve(_cachedHwEncoder);

  return new Promise((resolve) => {
    // If the user explicitly set FORCE_ENCODER, honor it (useful for testing)
    const forced = process.env.FORCE_ENCODER;
    if (forced) {
      _cachedHwEncoder = forced;
      return resolve(_cachedHwEncoder);
    }
    // query ffmpeg for available encoders
    execFile(ffmpegPath, ['-hide_banner', '-encoders'], (err, stdout) => {
      const out = String(stdout || '');
      // check for common hardware encoders
      if (/h264_nvenc/.test(out)) {
        _cachedHwEncoder = 'h264_nvenc';
      } else if (/h264_qsv/.test(out)) {
        _cachedHwEncoder = 'h264_qsv';
      } else if (/h264_amf/.test(out)) {
        _cachedHwEncoder = 'h264_amf';
      } else if (/h264_vaapi/.test(out)) {
        _cachedHwEncoder = 'h264_vaapi';
      } else {
        _cachedHwEncoder = 'libx264';
      }
      resolve(_cachedHwEncoder);
    });
  });
}

// Detect whether a particular decoder (eg. hevc_cuvid) is available
const _decoderCache = {};
function detectDecoder(decName) {
  if (_decoderCache[decName] !== undefined) return Promise.resolve(_decoderCache[decName]);
  return new Promise((res) => {
    execFile(ffmpegPath, ['-hide_banner', '-decoders'], (err, stdout) => {
      const out = String(stdout || '');
      const ok = new RegExp(`\\b${decName}\\b`).test(out);
      _decoderCache[decName] = ok;
      res(ok);
    });
  });
}

/**
 * Convert file with progress callback.
 * progressCb receives { percent, frames, currentFps, currentKbps, targetSize, timemark }
 * Returns a Promise that resolves with { outputPath, info } or rejects with Error.
 */
async function convertWithProgress(inputPath, progressCb) {
  const info = await probe(inputPath);
  const streamsAll = info.streams || [];
  const vstreamInfo = streamsAll.find(s => s.codec_type === 'video');
  const astreamInfo = streamsAll.find(s => s.codec_type === 'audio');
  const sourceVideoBitrate = parseInt(vstreamInfo?.bit_rate || info.format?.bit_rate || 0, 10) || 0;
  // determine output path
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  let outputPath = path.join(dir, base + '.mp4');

  // if file exists, append suffix
  let counter = 1;
  while (fs.existsSync(outputPath)) {
    outputPath = path.join(dir, `${base}(${counter}).mp4`);
    counter++;
  }

  // check codecs
  let canCopy = false;
  try {
    const streams = info.streams || [];
    const vstream = streams.find(s => s.codec_type === 'video');
    const astream = streams.find(s => s.codec_type === 'audio');

    const vcodec = vstream?.codec_name || '';
    const acodec = astream?.codec_name || '';

    // consider remux allowed when video is h264 and audio is aac or missing
    if (vcodec.toLowerCase().includes('h264') && (acodec === '' || acodec.toLowerCase().includes('aac') || acodec.toLowerCase().includes('mp3'))) {
      canCopy = true;
    }
  } catch (e) {
    // fallback to re-encode
    canCopy = false;
  }

  return new Promise((resolve, reject) => {
    // use explicit input so we can add inputOptions for hwaccel when needed
    let command = ffmpeg().input(inputPath).outputOptions('-movflags +faststart');

    if (canCopy) {
      // remux copy: map only video+audio, drop metadata and chapters
  command = command.outputOptions('-c copy')
  .outputOptions('-map', '0:v')
  .outputOptions('-map', '0:a:0?')
        .outputOptions('-map_metadata', '-1')
        .outputOptions('-map_chapters', '-1');
    } else {
      // transcode to H.264 + AAC. Prefer hardware encoder when available for much higher speed.
      // We detect encoders at runtime and adjust options accordingly.
      command = command.audioCodec('aac');
      detectHardwareEncoder().then((enc) => {
        // proceedWithCommand is declared as a function so it is available
        // when we call it from async branches (decoder detection).
        function proceedWithCommand() {
          let triedFallback = false;
          const startCommand = (cmd) => {
            cmd
              .on('start', (cmdline) => {
                // expose ffmpeg command line to caller via progressCb for debugging
                if (typeof progressCb === 'function') progressCb({ type: 'start', cmdline });
              })
              .on('progress', (progress) => {
                if (typeof progressCb === 'function') progressCb(progress);
              })
              .on('error', (err, stdout, stderr) => {
                // include stderr when available
                const stderrStr = String(stderr || '');
                // emit stderr to UI for diagnostics before attempting fallback
                if (typeof progressCb === 'function' && stderrStr) progressCb({ type: 'stderr', message: stderrStr });
                // If this was a hardware encoder run, try one software fallback automatically
                if (!triedFallback && enc !== 'libx264') {
                  triedFallback = true;
                  // notify about fallback
                  if (typeof progressCb === 'function') progressCb({ type: 'info', message: `Hardware encoder ${enc} failed, retrying with libx264 fallback...` });
                  // build fallback command
                  const fallback = ffmpeg(inputPath)
                    .audioCodec('aac')
                    .videoCodec('libx264')
                    .outputOptions('-preset', 'veryfast')
                    .outputOptions('-threads', '0')
                    .outputOptions('-thread_type', 'frame')
                    .outputOptions('-tune', 'fastdecode')
                    .outputOptions('-movflags', '+faststart')
                    .outputOptions('-max_muxing_queue_size', '9999')
                    .outputOptions('-map', '0:v')
                    .outputOptions('-map', '0:a:0?')
                    .outputOptions('-map_metadata', '-1')
                    .outputOptions('-map_chapters', '-1');
                  if (sourceVideoBitrate > 0) {
                    fallback.outputOptions('-b:v', `${Math.round(sourceVideoBitrate/1000)}k`);
                  } else {
                    fallback.outputOptions('-crf', '18');
                  }

                  // start fallback
                  startCommand(fallback.save(outputPath));
                  return;
                }

                const msg = stderrStr ? `Conversion failed: ${err?.message || 'ffmpeg error'}\n${stderrStr}` : `Conversion failed: ${err?.message || 'ffmpeg error'}`;
                reject(new Error(msg));
              })
              .on('end', () => {
                resolve({ outputPath, info });
              });
            // call save if cmd isn't already saved (fluent-ffmpeg returns the command chain, so caller may call save)
            try { cmd.save(outputPath); } catch (e) { /* ignore, save may have been called already */ }
          };

          startCommand(command);
        }
        if (enc === 'h264_nvenc') {
          // NVIDIA NVENC: very fast hardware encoding
          // Inspect the input stream to decide if we should use HEVC NVENC instead
          const vstream = (info.streams || []).find(s => s.codec_type === 'video') || {};
          const vcodec = vstream.codec_name || '';
          const isHevc = /hevc|x265/i.test(vcodec);
          // detect high bit-depth / 10-bit sources (bits_per_raw_sample or pix_fmt)
          const pix = (vstream.pix_fmt || '').toString();
          const bits = parseInt(vstream.bits_per_raw_sample || 0, 10) || 0;
          const isHighBit = bits >= 10 || /10/.test(pix);

          const setupNvencFor = (encName) => {
            command = command.videoCodec(encName)
              .outputOptions('-preset', 'p1') // fastest NVENC preset
              .outputOptions('-rc', 'vbr')
              .outputOptions('-cq', '19')
              .outputOptions('-max_muxing_queue_size', '9999')
              .outputOptions('-movflags', '+faststart')
              .outputOptions('-map', '0:v')
              .outputOptions('-map', '0:a:0?')
              .outputOptions('-map_metadata', '-1')
              .outputOptions('-map_chapters', '-1');
          };

          // For 10-bit HEVC sources: prefer HEVC NVENC (hevc_nvenc) which commonly
          // supports 10-bit. If hevc_nvenc isn't available, fall back to the
          // existing behavior (h264_nvenc then libx264 fallback).
          if (isHighBit && isHevc) {
            execFile(ffmpegPath, ['-hide_banner', '-encoders'], (err, stdout) => {
              const out = String(stdout || '');
              if (/hevc_nvenc/.test(out)) {
                if (typeof progressCb === 'function') progressCb({ type: 'info', message: 'Detected 10-bit HEVC source: trying hevc_nvenc to preserve bit depth and speed.' });
                // enable cuvid decode if available
                detectDecoder('hevc_cuvid').then((hasCuvid) => {
                  if (hasCuvid) {
                    command = command.inputOptions('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
                  }
                  setupNvencFor('hevc_nvenc');
                  proceedWithCommand();
                }).catch(() => {
                  setupNvencFor('hevc_nvenc');
                  proceedWithCommand();
                });
                return;
              }

              // hevc_nvenc not found — notify user and try h264_nvenc then fallback
              if (typeof progressCb === 'function') progressCb({ type: 'info', message: '10-bit HEVC source but hevc_nvenc not available in ffmpeg; will try h264_nvenc and then fallback to libx264 on failure.' });
              setupNvencFor('h264_nvenc');
              detectDecoder('hevc_cuvid').then((hasCuvid) => {
                if (hasCuvid) {
                  command = command.inputOptions('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
                }
                proceedWithCommand();
              }).catch(() => {
                proceedWithCommand();
              });
            });
            return; // async branch will call proceedWithCommand
          }

          // Non-10-bit or non-HEVC: continue with h264_nvenc as before
          setupNvencFor('h264_nvenc');
          if (isHevc) {
            detectDecoder('hevc_cuvid').then((hasCuvid) => {
              if (hasCuvid) {
                command = command.inputOptions('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
              }
              proceedWithCommand();
            }).catch(() => {
              proceedWithCommand();
            });
            return;
          }
        } else if (enc === 'h264_qsv') {
          // Intel QuickSync
          command = command.videoCodec('h264_qsv')
            .outputOptions('-global_quality', '23')
            .outputOptions('-max_muxing_queue_size', '9999')
            .outputOptions('-movflags', '+faststart')
            .outputOptions('-map', '0:v')
            .outputOptions('-map', '0:a:0?')
            .outputOptions('-map_metadata', '-1')
            .outputOptions('-map_chapters', '-1');
        } else if (enc === 'h264_amf' || enc === 'h264_vaapi') {
          // AMD AMF or VAAPI
          command = command.videoCodec(enc)
            .outputOptions('-b:v', '0')
            .outputOptions('-max_muxing_queue_size', '9999')
            .outputOptions('-movflags', '+faststart')
            .outputOptions('-map', '0:v')
            .outputOptions('-map', '0:a:0?')
            .outputOptions('-map_metadata', '-1')
            .outputOptions('-map_chapters', '-1');
        } else {
          // Software x264 fallback — tuned for speed but decent quality
          // If source bitrate is known, try to match it (preserve quality); otherwise use a good CRF
          command = command.videoCodec('libx264')
            .outputOptions('-preset', 'veryfast')
            .outputOptions('-threads', '0')
            .outputOptions('-thread_type', 'frame')
            .outputOptions('-tune', 'fastdecode')
            .outputOptions('-movflags', '+faststart')
            .outputOptions('-max_muxing_queue_size', '9999')
            .outputOptions('-map', '0:v')
            .outputOptions('-map', '0:a:0?')
            .outputOptions('-map_metadata', '-1')
            .outputOptions('-map_chapters', '-1');
          if (sourceVideoBitrate > 0) {
            command = command.outputOptions('-b:v', `${Math.round(sourceVideoBitrate/1000)}k`);
          } else {
            command = command.outputOptions('-crf', '18');
          }
        }
        // start processing for non-async branches
        proceedWithCommand();
      }).catch((err) => {
        reject(err);
      });

      // return here because promise will be resolved/rejected inside detectHardwareEncoder
      return;
    }
    // if we reach here, canCopy branch was taken and command is already configured
    command
      .on('start', (cmdline) => {
        // console.log('FFmpeg start:', cmdline);
      })
      .on('progress', (progress) => {
        if (typeof progressCb === 'function') progressCb(progress);
      })
      .on('error', (err, stdout, stderr) => {
        reject(new Error(`Conversion failed: ${err.message}`));
      })
      .on('end', () => {
        resolve({ outputPath, info });
      })
      .save(outputPath);
  });
}

module.exports = {
  convertWithProgress,
  probe,
  detectHardwareEncoder
};
