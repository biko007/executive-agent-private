/**
 * video-edit.ts — Video 4:5 crop + cover frame extraction (E4b).
 *
 * probeVideo: hardened ffprobe wrapper returning VideoProbe.
 * cropVideoTo4x5: H.264 1080x1350, audio passthrough or -an.
 * extractCoverFrame: JPEG at position (default 1s), black-frame retry,
 *   sharp 4:5 resize.
 * computeVideoParamsHash: deterministic hash for dedup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { runFfmpeg, runFfprobe } from './ffmpeg-engine.js';
import { sessionDir } from './commands.js';
import type { VideoProbe } from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const TARGET_W = 1080;
const TARGET_H = 1350;     // 4:5
const COVER_JPEG_QUALITY = 90;
const BLACK_THRESHOLD = 15; // mean pixel brightness below this = "black frame"
const DEFAULT_COVER_POS = 1.0;

const RAW_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram/raw');

// ── Types ────────────────────────────────────────────────────────────────────

export interface VideoCropResult {
  outputPath: string;       // absolute
  relativePath: string;     // "{sessionId}/edited/{name}-video_4x5.mp4"
  sha256Output: string;
}

export interface CoverFrameResult {
  outputPath: string;
  relativePath: string;
  sha256Output: string;
  positionSec: number;      // actual position used
}

// ── probeVideo ───────────────────────────────────────────────────────────────

export async function probeVideo(
  sourcePath: string,
  options?: { mediaRoot?: string },
): Promise<VideoProbe> {
  const result = await runFfprobe(
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', sourcePath],
    { mediaRoot: options?.mediaRoot },
  );

  const parsed = JSON.parse(result.stdout);
  const videoStream = (parsed.streams ?? []).find(
    (s: any) => s.codec_type === 'video',
  );
  if (!videoStream) {
    throw new Error(`No video stream found in ${path.basename(sourcePath)}`);
  }

  const audioStream = (parsed.streams ?? []).find(
    (s: any) => s.codec_type === 'audio',
  );

  const duration = parseFloat(parsed.format?.duration ?? videoStream.duration ?? '0');
  const fps = parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate || '30/1');

  return {
    duration_s: duration,
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    codec: videoStream.codec_name ?? 'unknown',
    fps,
    has_audio: !!audioStream,
  };
}

function parseFps(rate: string): number {
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return Math.round((num / den) * 100) / 100;
  }
  return parseFloat(rate) || 30;
}

// ── cropVideoTo4x5 ──────────────────────────────────────────────────────────

export async function cropVideoTo4x5(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;       // absolute
  mediaName: string;
  mediaRoot?: string;
}): Promise<VideoCropResult> {
  const { sessionId, sourcePath, mediaName } = params;
  const mediaRoot = params.mediaRoot ?? RAW_DIR;

  // 1. Probe
  const probe = await probeVideo(sourcePath, { mediaRoot });

  // 2. Build output path
  const baseName = mediaName.replace(/\.[^.]+$/, '');
  const outputName = `${baseName}-video_4x5.mp4`;
  const editedDir = path.join(sessionDir(sessionId), 'edited');
  fs.mkdirSync(editedDir, { recursive: true });

  const finalPath = path.join(editedDir, outputName);
  const tmpPath = path.join(editedDir, `${baseName}-video_4x5.tmp.mp4`);

  // 3. Path security
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(mediaRoot);
  if (!resolvedFinal.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  // 4. Build ffmpeg args
  const vf = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H}`;
  const args = [
    '-y', '-i', sourcePath,
    '-vf', vf,
    '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
  ];

  if (probe.has_audio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', tmpPath);

  // 5. Run ffmpeg
  await runFfmpeg(args, { mediaRoot });

  // 6. Atomic rename
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`Failed to rename video output for ${mediaName}`);
  }

  // 7. SHA256
  const sha256Output = createHash('sha256')
    .update(fs.readFileSync(finalPath))
    .digest('hex');

  const relativePath = `${sessionId}/edited/${outputName}`;

  return { outputPath: finalPath, relativePath, sha256Output };
}

// ── extractCoverFrame ────────────────────────────────────────────────────────

export async function extractCoverFrame(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;       // absolute
  mediaName: string;
  positionSec?: number;
  mediaRoot?: string;
}): Promise<CoverFrameResult> {
  const { sessionId, sourcePath, mediaName } = params;
  const mediaRoot = params.mediaRoot ?? RAW_DIR;
  const requestedPos = params.positionSec ?? DEFAULT_COVER_POS;

  // 1. Probe
  const probe = await probeVideo(sourcePath, { mediaRoot });

  // 2. Effective position
  let pos = probe.duration_s <= requestedPos ? 0.0 : requestedPos;

  // 3. Output paths
  const baseName = mediaName.replace(/\.[^.]+$/, '');
  const outputName = `${baseName}-cover_frame.jpg`;
  const editedDir = path.join(sessionDir(sessionId), 'edited');
  fs.mkdirSync(editedDir, { recursive: true });

  const finalPath = path.join(editedDir, outputName);
  const tmpJpg = `${finalPath}.tmp.jpg`;

  // Path security
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(mediaRoot);
  if (!resolvedFinal.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  // 4. Extract frame via ffmpeg
  await runFfmpeg(
    ['-y', '-ss', String(pos), '-i', sourcePath, '-vframes', '1', '-q:v', '2', tmpJpg],
    { mediaRoot },
  );

  // 5. Black frame detection via sharp (max 1 retry)
  let retried = false;
  const stats = await sharp(tmpJpg).stats();
  const mean = stats.channels.reduce((s, c) => s + c.mean, 0) / stats.channels.length;

  if (mean < BLACK_THRESHOLD && !retried) {
    retried = true;
    const retryPos = Math.min(pos + 0.5, probe.duration_s);
    if (retryPos !== pos) {
      pos = retryPos;
      await runFfmpeg(
        ['-y', '-ss', String(pos), '-i', sourcePath, '-vframes', '1', '-q:v', '2', tmpJpg],
        { mediaRoot },
      );
    }
  }

  // 6. Resize to 1080x1350 via sharp (center crop to 4:5)
  const meta = await sharp(tmpJpg).metadata();
  const w = meta.width!;
  const h = meta.height!;

  const targetAspect = TARGET_W / TARGET_H; // 0.8
  const srcAspect = w / h;
  let cropW: number, cropH: number, left: number, top: number;

  if (srcAspect > targetAspect) {
    cropW = Math.round(h * targetAspect);
    cropH = h;
    left = Math.round((w - cropW) / 2);
    top = 0;
  } else if (srcAspect < targetAspect) {
    cropW = w;
    cropH = Math.round(w / targetAspect);
    left = 0;
    top = Math.round((h - cropH) / 2);
  } else {
    cropW = w;
    cropH = h;
    left = 0;
    top = 0;
  }

  const outputBuffer = await sharp(tmpJpg)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(TARGET_W, TARGET_H)
    .keepIccProfile()
    .jpeg({ quality: COVER_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  // 7. Cleanup tmp, atomic write
  try { fs.unlinkSync(tmpJpg); } catch { /* ignore */ }

  const sha256Output = createHash('sha256').update(outputBuffer).digest('hex');

  const tmpFinal = `${finalPath}.tmp`;
  try {
    fs.writeFileSync(tmpFinal, outputBuffer);
    fs.renameSync(tmpFinal, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpFinal); } catch { /* ignore */ }
    throw err;
  }

  const relativePath = `${sessionId}/edited/${outputName}`;

  return {
    outputPath: finalPath,
    relativePath,
    sha256Output,
    positionSec: pos,
  };
}

// ── computeVideoParamsHash ───────────────────────────────────────────────────

export function computeVideoParamsHash(
  variant: 'video_4x5' | 'cover_frame',
  positionSec?: number,
): string {
  const input = variant === 'video_4x5'
    ? 'video_4x5:1080x1350:h264:crf23'
    : `cover_frame:pos=${positionSec ?? 1}`;
  return createHash('sha256').update(input).digest('hex');
}
