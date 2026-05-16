#!/usr/bin/env bun
/**
 * Sprint 9 Migration — links.json → Postgres entity_links
 *
 * Usage:
 *   bun run scripts/migrate-sprint9-links.ts              # dry-run (default)
 *   bun run scripts/migrate-sprint9-links.ts --apply      # import into DB
 *
 * Environment:
 *   POSTGRES_URL  — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────────────────

const LINKS_FILE = join(homedir(), '.openclaw/workspace/artifacts/personal/links/links.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env');
  return match[1];
}

interface LinkEntry {
  id: string;
  entityType?: string;
  entityId?: string;
  docType: string;
  label: string;
  createdAt: string;
  spItemId?: string;
  spDriveId?: string;
  spName?: string;
  spWebUrl?: string;
  localPath?: string;
  localName?: string;
}

// ── Parse ───��───────────────────────────────────────────────────────────────

function parseLinksFile(): { valid: LinkEntry[]; skipped: LinkEntry[] } {
  if (!existsSync(LINKS_FILE)) {
    throw new Error(`links.json not found: ${LINKS_FILE}`);
  }

  const raw = readFileSync(LINKS_FILE, 'utf-8');
  const entries: LinkEntry[] = JSON.parse(raw);

  const valid: LinkEntry[] = [];
  const skipped: LinkEntry[] = [];

  for (const entry of entries) {
    if (!entry.entityType || !entry.entityId) {
      skipped.push(entry);
    } else {
      valid.push(entry);
    }
  }

  return { valid, skipped };
}

// ── Dry Run ─────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('=== Sprint 9 Links Migration — DRY RUN ===\n');

  const { valid, skipped } = parseLinksFile();

  console.log(`Source:         ${LINKS_FILE}`);
  console.log(`Total entries:  ${valid.length + skipped.length}`);
  console.log(`Valid entries:  ${valid.length}`);
  console.log(`Skipped (missing entityType/entityId): ${skipped.length}`);

  // Entity type distribution
  const typeCounts: Record<string, number> = {};
  for (const v of valid) {
    typeCounts[v.entityType!] = (typeCounts[v.entityType!] || 0) + 1;
  }
  console.log('\n--- Entity type distribution ---');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Doc type distribution
  const docCounts: Record<string, number> = {};
  for (const v of valid) {
    docCounts[v.docType] = (docCounts[v.docType] || 0) + 1;
  }
  console.log('\n--- Doc type distribution ---');
  for (const [type, count] of Object.entries(docCounts)) {
    console.log(`  ${type}: ${count}`);
  }

  if (skipped.length > 0) {
    console.log('\n--- Skipped entries ---');
    for (const s of skipped) {
      console.log(`  id=${s.id} entityType=${s.entityType ?? 'MISSING'} entityId=${s.entityId ?? 'MISSING'}`);
    }
  }

  // Sample entries
  if (valid.length > 0) {
    console.log('\n--- Sample entries (first 3) ---');
    for (const v of valid.slice(0, 3)) {
      console.log(`  ${v.id} | ${v.entityType}/${v.entityId} | ${v.docType} | ${v.label}`);
    }
    console.log('\n--- Sample entries (last 3) ---');
    for (const v of valid.slice(-3)) {
      console.log(`  ${v.id} | ${v.entityType}/${v.entityId} | ${v.docType} | ${v.label}`);
    }
  }

  console.log('\nDry run complete. Use --apply to import.');
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('=== Sprint 9 Links Migration — APPLY ===\n');

  const { valid, skipped } = parseLinksFile();

  console.log(`Valid: ${valid.length} | Skipped: ${skipped.length}`);

  const pool = new pg.Pool({ connectionString: loadEnv(), max: 5 });

  try {
    // Verify table exists
    const { rows: tableCheck } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_links') AS ok`,
    );
    if (!tableCheck[0]?.ok) {
      throw new Error('Table entity_links does not exist. Run the gateway first to apply migrations.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert valid entries
      let inserted = 0;
      for (const entry of valid) {
        const { rowCount } = await client.query(
          `INSERT INTO entity_links (link_code, entity_type, entity_id, doc_type, label,
             sp_item_id, sp_drive_id, sp_name, sp_web_url,
             local_path, local_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
           ON CONFLICT (link_code) DO NOTHING`,
          [
            entry.id,
            entry.entityType,
            entry.entityId,
            entry.docType,
            entry.label || '',
            entry.spItemId ?? null,
            entry.spDriveId ?? null,
            entry.spName ?? null,
            entry.spWebUrl ?? null,
            entry.localPath ?? null,
            entry.localName ?? null,
            entry.createdAt || new Date().toISOString(),
          ],
        );
        inserted += rowCount ?? 0;
      }

      // Audit-log skipped entries
      for (const entry of skipped) {
        await client.query(
          `INSERT INTO audit_log (actor, module, action, entity_type, after_jsonb, source)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'migration-sprint9',
            'links',
            'import_skip',
            'entity_link',
            JSON.stringify({ id: entry.id, entityType: entry.entityType, entityId: entry.entityId, reason: 'missing entityType/entityId' }),
            'migrate-sprint9-links',
          ],
        );
      }

      await client.query('COMMIT');

      console.log(`\nInserted: ${inserted} entity links`);
      console.log(`Audit-logged: ${skipped.length} skipped entries`);

      // ── Post-import verification ────────────────────────────────────────
      console.log('\n--- Verification ---');

      const { rows: countRows } = await pool.query('SELECT COUNT(*) AS cnt FROM entity_links');
      console.log(`DB count: ${countRows[0].cnt}`);

      const { rows: distRows } = await pool.query(
        'SELECT entity_type, COUNT(*) AS cnt FROM entity_links GROUP BY entity_type ORDER BY cnt DESC',
      );
      console.log('\nEntity type distribution:');
      for (const r of distRows) {
        console.log(`  ${r.entity_type}: ${r.cnt}`);
      }

      // 3 random spot-checks
      const { rows: samples } = await pool.query(
        `SELECT link_code, entity_type, entity_id, doc_type, label, sp_name, created_at
         FROM entity_links ORDER BY RANDOM() LIMIT 3`,
      );
      console.log('\nSpot-checks:');
      for (const s of samples) {
        console.log(`  ${s.link_code} | ${s.entity_type}/${s.entity_id} | ${s.doc_type} | ${s.label} | ${s.sp_name ?? s.link_code}`);
      }

      // Schema version check
      const { rows: svRows } = await pool.query(
        `SELECT version FROM schema_version WHERE module = 'links' ORDER BY version DESC LIMIT 1`,
      );
      if (svRows.length > 0) {
        console.log(`\nschema_version (links): ${svRows[0].version}`);
      }

    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log('\nMigration complete.');
}

// ── Main ────────��────────────────────────────��──────────────────────────────

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'apply') {
  apply().catch(e => {
    console.error(`\nFATAL: ${e.message}`);
    process.exit(1);
  });
} else {
  dryRun();
}
