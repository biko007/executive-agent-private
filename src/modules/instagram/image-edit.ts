/**
 * image-edit.ts — Sharp crop pipelines (E3 + E5).
 *
 * centerCrop4x5: 1080x1350 JPEG (4:5) center-crop (E3).
 * subjectAwareCrop4x5: 1080x1350 JPEG (4:5) subject-centered crop (E5).
 *
 * Auto-orients via EXIF rotation, strips all EXIF (including GPS),
 * preserves ICC profile for color accuracy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sessionDir } from './commands.js';

// ── Constants ────────────────────────────────────────────────────────────────

const TARGET_W = 1080;
const TARGET_H = 1350;
const TARGET_ASPECT = TARGET_W / TARGET_H; // 0.8
const JPEG_QUALITY = 90;

const RAW_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram/raw');

// ── Types ────────────────────────────────────────────────────────────────────

export interface CenterCropResult {
  outputPath: string;       // absolute path
  relativePath: string;     // e.g. "{sessionId}/edited/260517-jb-01-center_4x5.jpg"
  sha256Output: string;
  outputSize: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function centerCrop4x5(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;       // absolute path to original
  mediaName: string;        // e.g. "260517-jb-01.jpg"
}): Promise<CenterCropResult> {
  const { sessionId, sourcePath, mediaName } = params;

  // 1. Load + auto-orient (applies EXIF rotation, strips orientation tag)
  const pipeline = sharp(sourcePath).rotate();

  // 2. Read dimensions of the rotated image
  const meta = await pipeline.metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) {
    throw new Error(`Cannot read image dimensions from ${mediaName}`);
  }

  // 3. Compute center-crop region
  const srcAspect = w / h;
  let cropW: number, cropH: number, left: number, top: number;

  if (srcAspect > TARGET_ASPECT) {
    // Wider than 4:5 — crop sides
    cropW = Math.round(h * TARGET_ASPECT);
    cropH = h;
    left = Math.round((w - cropW) / 2);
    top = 0;
  } else if (srcAspect < TARGET_ASPECT) {
    // Taller than 4:5 — crop top/bottom
    cropW = w;
    cropH = Math.round(w / TARGET_ASPECT);
    left = 0;
    top = Math.round((h - cropH) / 2);
  } else {
    // Already 4:5
    cropW = w;
    cropH = h;
    left = 0;
    top = 0;
  }

  // 4. Extract → resize → JPEG
  //    .keepIccProfile() preserves color accuracy
  //    No .keepExif() → all EXIF (including GPS) stripped from output
  const outputBuffer = await sharp(sourcePath)
    .rotate()
    .extract({ left, top, width: cropW, height: cropH })
    .resize(TARGET_W, TARGET_H)
    .keepIccProfile()
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  // 5. SHA256 from output buffer
  const sha256Output = createHash('sha256').update(outputBuffer).digest('hex');

  // 6. Output filename + path
  const baseName = mediaName.replace(/\.[^.]+$/, '');
  const outputName = `${baseName}-center_4x5.jpg`;
  const editedDir = path.join(sessionDir(sessionId), 'edited');
  fs.mkdirSync(editedDir, { recursive: true });

  const finalPath = path.join(editedDir, outputName);
  const tmpPath = `${finalPath}.tmp`;

  // 7. Path security — ensure output is under RAW_DIR
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(RAW_DIR);
  if (!resolvedFinal.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  // 8. Atomic write: tmp → rename
  try {
    fs.writeFileSync(tmpPath, outputBuffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Cleanup on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  const relativePath = `${sessionId}/edited/${outputName}`;

  return {
    outputPath: finalPath,
    relativePath,
    sha256Output,
    outputSize: outputBuffer.length,
  };
}

// ── Subject-Aware Crop (E5) ───────────────────────────────────────────────

export async function subjectAwareCrop4x5(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;
  mediaName: string;
  bbox: { x: number; y: number; w: number; h: number };
}): Promise<CenterCropResult> {
  const { sessionId, sourcePath, mediaName, bbox } = params;

  // 1. Load + auto-orient
  const pipeline = sharp(sourcePath).rotate();
  const meta = await pipeline.metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) {
    throw new Error(`Cannot read image dimensions from ${mediaName}`);
  }

  // 2. Convert relative bbox to pixel center
  const bboxCenterX = Math.round((bbox.x + bbox.w / 2) * w);
  const bboxCenterY = Math.round((bbox.y + bbox.h / 2) * h);

  // 3. Compute max 4:5 crop region (same aspect logic as centerCrop4x5)
  const srcAspect = w / h;
  let cropW: number, cropH: number;

  if (srcAspect > TARGET_ASPECT) {
    // Wider than 4:5 — crop sides
    cropW = Math.round(h * TARGET_ASPECT);
    cropH = h;
  } else if (srcAspect < TARGET_ASPECT) {
    // Taller than 4:5 — crop top/bottom
    cropW = w;
    cropH = Math.round(w / TARGET_ASPECT);
  } else {
    cropW = w;
    cropH = h;
  }

  // 4. Position crop centered on subject, clamped to image bounds
  const left = Math.max(0, Math.min(bboxCenterX - Math.round(cropW / 2), w - cropW));
  const top = Math.max(0, Math.min(bboxCenterY - Math.round(cropH / 2), h - cropH));

  // 5. Extract → resize → JPEG (same pipeline as centerCrop4x5)
  const outputBuffer = await sharp(sourcePath)
    .rotate()
    .extract({ left, top, width: cropW, height: cropH })
    .resize(TARGET_W, TARGET_H)
    .keepIccProfile()
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  // 6. SHA256 from output buffer
  const sha256Output = createHash('sha256').update(outputBuffer).digest('hex');

  // 7. Output filename + path
  const baseName = mediaName.replace(/\.[^.]+$/, '');
  const outputName = `${baseName}-vision_4x5.jpg`;
  const editedDir = path.join(sessionDir(sessionId), 'edited');
  fs.mkdirSync(editedDir, { recursive: true });

  const finalPath = path.join(editedDir, outputName);
  const tmpPath = `${finalPath}.tmp`;

  // 8. Path security — ensure output is under RAW_DIR
  const resolvedFinal = path.resolve(finalPath);
  const resolvedRoot = path.resolve(RAW_DIR);
  if (!resolvedFinal.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  // 9. Atomic write: tmp → rename
  try {
    fs.writeFileSync(tmpPath, outputBuffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  const relativePath = `${sessionId}/edited/${outputName}`;

  return {
    outputPath: finalPath,
    relativePath,
    sha256Output,
    outputSize: outputBuffer.length,
  };
}
