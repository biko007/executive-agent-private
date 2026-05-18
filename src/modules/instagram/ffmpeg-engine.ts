/**
 * ffmpeg-engine.ts — Hardened ffmpeg/ffprobe spawn wrapper (E4a).
 *
 * Security guarantees:
 * - No shell strings (spawn, never exec/execSync)
 * - Path validation: all path-like args must resolve under mediaRoot
 * - Disk space check before write operations (5 GiB free AND 20% threshold)
 * - Hard timeout: 180s SIGTERM, +5s SIGKILL
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 180_000;   // 3 minutes
const KILL_GRACE_MS = 5_000;          // 5s after SIGTERM before SIGKILL
const MIN_FREE_BYTES = 5_368_709_120; // 5 GiB
const MIN_FREE_PERCENT = 0.20;        // 20%

const MEDIA_ROOT = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/instagram/raw',
);

// ── Error Class ──────────────────────────────────────────────────────────────

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode?: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FfmpegResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;       // default 180_000
  mediaRoot?: string;       // override MEDIA_ROOT (for tests)
  skipDiskCheck?: boolean;  // skip disk space check
}

// ── Path Validation ──────────────────────────────────────────────────────────

/**
 * Validate that all path-like arguments resolve under mediaRoot.
 * Heuristic: any arg containing '/' is treated as a path.
 */
function validatePaths(args: string[], mediaRoot: string): void {
  const resolvedRoot = path.resolve(mediaRoot);
  for (const arg of args) {
    if (!arg.includes('/')) continue;
    const resolved = path.resolve(arg);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + '/')) {
      throw new FfmpegError(
        `Path outside media root: ${arg}`,
        'EPATH_OUTSIDE_ROOT',
      );
    }
  }
}

// ── Disk Space Check ─────────────────────────────────────────────────────────

/**
 * Check sufficient disk space. Throws EDISK_LOW only when BOTH conditions
 * are violated: < 5 GiB free AND < 20% of total.
 */
function checkDiskSpace(mediaRoot: string): void {
  const stats = fs.statfsSync(mediaRoot);
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  const freePercent = totalBytes > 0 ? freeBytes / totalBytes : 0;

  if (freeBytes < MIN_FREE_BYTES && freePercent < MIN_FREE_PERCENT) {
    const freeGb = (freeBytes / 1_073_741_824).toFixed(2);
    const pct = (freePercent * 100).toFixed(1);
    throw new FfmpegError(
      `Insufficient disk space: ${freeGb} GB free (${pct}%)`,
      'EDISK_LOW',
    );
  }
}

// ── Hardened Spawn ───────────────────────────────────────────────────────────

/**
 * Shared spawn logic for ffmpeg and ffprobe. No shell, timeout with
 * SIGTERM → SIGKILL escalation.
 */
function spawnHardened(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<FfmpegResult> {
  return new Promise<FfmpegResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (killed) {
        reject(new FfmpegError(
          `${binary} timed out after ${timeoutMs}ms`,
          'ETIMEOUT',
          exitCode ?? undefined,
          stderr,
        ));
        return;
      }

      if (exitCode !== 0) {
        reject(new FfmpegError(
          `${binary} exited with code ${exitCode}`,
          'EFFMPEG',
          exitCode ?? undefined,
          stderr,
        ));
        return;
      }

      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new FfmpegError(
        `${binary} spawn error: ${err.message}`,
        'ESPAWN',
      ));
    });

    // Close stdin immediately (no input piping)
    child.stdin.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run ffmpeg with hardened spawn (no shell).
 * Validates paths, checks disk space, enforces timeout.
 */
export async function runFfmpeg(
  args: string[],
  options: RunOptions = {},
): Promise<FfmpegResult> {
  const mediaRoot = options.mediaRoot ?? MEDIA_ROOT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  validatePaths(args, mediaRoot);
  if (!options.skipDiskCheck) checkDiskSpace(mediaRoot);

  return spawnHardened('ffmpeg', args, timeoutMs);
}

/**
 * Run ffprobe with hardened spawn (no shell).
 * Path validation only — no disk check (reads only).
 */
export async function runFfprobe(
  args: string[],
  options: RunOptions = {},
): Promise<FfmpegResult> {
  const mediaRoot = options.mediaRoot ?? MEDIA_ROOT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  validatePaths(args, mediaRoot);

  return spawnHardened('ffprobe', args, timeoutMs);
}
