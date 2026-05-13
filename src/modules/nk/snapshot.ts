/**
 * nk/snapshot — Build and write NK statement snapshots.
 * Sprint 5.5b — Etappe f
 */
import { createHash } from 'node:crypto';
import { writeFile, mkdir, rename, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import type { EngineOutput } from './types.js';

const SNAPSHOT_DIR = join(homedir(), '.openclaw/workspace/artifacts/personal/nk-snapshots');

/**
 * Build the full snapshot JSON from engine output.
 */
export function buildSnapshot(
  engineOutput: EngineOutput,
  heatingConfig: unknown,
): Record<string, unknown> {
  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    run: engineOutput.run,
    statements: engineOutput.statements,
    warnings: engineOutput.warnings,
    excluded_leases: engineOutput.excluded_leases,
    heating_config: heatingConfig,
  };
}

/**
 * Write snapshot to gzipped JSON file.
 * Returns path, sha256, and size in bytes.
 */
export async function writeSnapshot(
  runId: number,
  data: Record<string, unknown>,
): Promise<{ path: string; sha256: string; size_bytes: number }> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  const jsonStr = JSON.stringify(data, null, 2);
  const compressed = gzipSync(Buffer.from(jsonStr, 'utf-8'));
  const sha256 = createHash('sha256').update(compressed).digest('hex');

  const filename = `${runId}.json.gz`;
  const targetPath = join(SNAPSHOT_DIR, filename);
  const tmpPath = targetPath + '.tmp';

  // Atomic write: tmp → rename
  await writeFile(tmpPath, compressed);
  await rename(tmpPath, targetPath);

  return {
    path: targetPath,
    sha256,
    size_bytes: compressed.length,
  };
}

/**
 * Read and decompress a snapshot file.
 */
export async function readSnapshot(path: string): Promise<Record<string, unknown>> {
  const compressed = await readFile(path);
  const jsonStr = gunzipSync(compressed).toString('utf-8');
  return JSON.parse(jsonStr);
}
