#!/usr/bin/env bun
/**
 * Sprint 6.2 — Fleet Datenpflege Import
 *
 * Imports 7 vehicles (5 existing + 2 new) with TÜV, KFZ-Steuer, Versicherung
 * from ~/fleet-datenpflege-sprint-6.2.xlsx into Postgres.
 *
 * Usage:
 *   bun run scripts/import-sprint6.2-fleet.ts              # dry-run (default)
 *   bun run scripts/import-sprint6.2-fleet.ts --apply      # import into DB
 */
import pg from 'pg';
import xlsx from 'xlsx';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────────────────

const EXCEL_FILE = join(homedir(), 'fleet-datenpflege-sprint-6.2.xlsx');
const SOURCE = 'sprint6.2-import';

// ── Coverage type mapping per vehicle code ──────────────────────────────────

const COVERAGE_MAP: Record<string, string> = {
  'FZG-TESLA-X': 'vollkasko',
  'FZG-G580': 'vollkasko',
  'FZG-RANGER': 'haftpflicht',
  'FZG-911T': 'vollkasko',
  'FZG-560SL': 'teilkasko',
  'FZG-TESLA-M3': 'vollkasko',
  'FZG-MB/8': 'haftpflicht',
};

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

/** Convert Excel serial date number to ISO date string YYYY-MM-DD */
function excelDateToISO(serial: number | string | null | undefined): string | null {
  if (serial == null || serial === '') return null;
  if (typeof serial === 'string') {
    // Try DD.MM.YYYY format
    const m = serial.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return serial; // already ISO?
  }
  // Excel serial number → JS date
  const date = new Date((serial - 25569) * 86400 * 1000);
  return date.toISOString().slice(0, 10);
}

/** Split "Tesla Model X" → { make: "Tesla", model: "Model X" } */
function splitBrandModel(modell: string): { make: string; model: string } {
  const map: Record<string, [string, string]> = {
    'Tesla Model X': ['Tesla', 'Model X'],
    'Mercedes G580': ['Mercedes-Benz', 'G 580 G-Klasse'],
    'Polaris Ranger': ['Polaris', 'Ranger XP Kinetic'],
    'Porsche 911 T': ['Porsche', '911 Turbo'],
    'Mercedes 560 SL': ['Mercedes-Benz', '560 SL'],
    'Tesla Model 3': ['Tesla', 'Model 3'],
    'Mercedes-Benz /8': ['Mercedes-Benz', '/8'],
  };
  const entry = map[modell];
  if (entry) return { make: entry[0], model: entry[1] };
  // Fallback: first word = make, rest = model
  const parts = modell.split(' ');
  return { make: parts[0], model: parts.slice(1).join(' ') || modell };
}

interface VehicleRow {
  code: string;
  modell: string;
  kennzeichen: string;
  tuevDate: string | null;
  steuer: number;
  versAnbieter: string;
  versPreis: number;
  baujahr: number;
  vin: string;
}

// ── Parse Excel ─────────────────────────────────────────────────────────────

function parseExcel(): VehicleRow[] {
  if (!existsSync(EXCEL_FILE)) throw new Error(`Excel not found: ${EXCEL_FILE}`);

  const wb = xlsx.readFile(EXCEL_FILE);
  const sheet = wb.Sheets['Fleet Datenpflege'];
  if (!sheet) throw new Error('Sheet "Fleet Datenpflege" not found');

  const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, range: 1 }) as any[][];

  const vehicles: VehicleRow[] = [];
  for (const row of rawRows) {
    if (!row[0] || !String(row[0]).startsWith('FZG-')) continue;
    vehicles.push({
      code: String(row[0]).trim(),
      modell: String(row[1] || '').trim(),
      kennzeichen: String(row[2] || '').trim(),
      tuevDate: excelDateToISO(row[3]),
      steuer: Number(row[4]) || 0,
      versAnbieter: String(row[6] || '').trim(),
      versPreis: Number(row[7]) || 0,
      baujahr: Number(row[10]) || 0,
      vin: String(row[11] || '').trim(),
    });
  }

  return vehicles;
}

// ── Dry Run ─────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('=== Sprint 6.2 Fleet Import — DRY RUN ===\n');

  const vehicles = parseExcel();

  console.log(`Source: ${EXCEL_FILE}`);
  console.log(`Vehicles found: ${vehicles.length}\n`);

  console.log('--- Vehicle Data ---');
  console.log(
    'Code'.padEnd(14) + 'Make'.padEnd(16) + 'Model'.padEnd(20) +
    'Plate'.padEnd(14) + 'TÜV'.padEnd(13) + 'Tax €'.padEnd(8) +
    'Ins. Provider'.padEnd(12) + 'Ins. €'.padEnd(10) + 'Year'.padEnd(6) + 'VIN'
  );
  console.log('-'.repeat(130));

  for (const v of vehicles) {
    const { make, model } = splitBrandModel(v.modell);
    console.log(
      v.code.padEnd(14) + make.padEnd(16) + model.padEnd(20) +
      v.kennzeichen.padEnd(14) + (v.tuevDate || '-').padEnd(13) +
      String(v.steuer).padEnd(8) +
      v.versAnbieter.padEnd(12) + String(v.versPreis).padEnd(10) +
      String(v.baujahr).padEnd(6) + v.vin
    );
  }

  console.log('\n--- Coverage Type Mapping ---');
  for (const v of vehicles) {
    console.log(`  ${v.code}: ${COVERAGE_MAP[v.code] || 'UNKNOWN'}`);
  }

  console.log('\n--- Operations Summary ---');
  console.log(`  Vehicles UPSERT: ${vehicles.length} (existing get VIN/plate/year updated, new get INSERTed)`);
  console.log(`  TÜV records INSERT: ${vehicles.filter(v => v.tuevDate).length}`);
  console.log(`  Tax records UPSERT (year=2026): ${vehicles.length}`);
  console.log(`  Insurance UPSERT: ${vehicles.length}`);
  console.log(`  audit_log entries: ~${vehicles.length * 4}`);

  console.log('\nDry run complete. Use --apply to import.');
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('=== Sprint 6.2 Fleet Import — APPLY ===\n');

  const vehicles = parseExcel();
  console.log(`Vehicles to import: ${vehicles.length}\n`);

  const pool = new pg.Pool({ connectionString: loadEnv(), max: 5 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const v of vehicles) {
      const { make, model } = splitBrandModel(v.modell);
      const coverageType = COVERAGE_MAP[v.code] || 'haftpflicht';
      const firstReg = v.baujahr ? `${v.baujahr}-01-01` : null;

      // 1. UPSERT vehicle
      const { rows: [vehicle] } = await client.query<{ id: number; is_new: boolean }>(
        `INSERT INTO vehicles (vehicle_code, display_name, license_plate, make, model, vin, first_registration, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (vehicle_code) DO UPDATE SET
           license_plate = COALESCE(EXCLUDED.license_plate, vehicles.license_plate),
           vin = COALESCE(EXCLUDED.vin, vehicles.vin),
           first_registration = COALESCE(vehicles.first_registration, EXCLUDED.first_registration),
           updated_by = $8
         RETURNING id, (xmax = 0) AS is_new`,
        [v.code, `${make} ${model}`, v.kennzeichen, make, model, v.vin || null, firstReg, SOURCE],
      );

      const action = vehicle.is_new ? 'insert' : 'update';
      console.log(`  [${action}] vehicle ${v.code} → id=${vehicle.id}`);

      // audit_log for vehicle
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [SOURCE, 'fleet', action, 'vehicle', v.code,
          JSON.stringify({ code: v.code, make, model, plate: v.kennzeichen, vin: v.vin, year: v.baujahr }),
          SOURCE],
      );

      // 2. INSERT TÜV record (if date present)
      if (v.tuevDate) {
        await client.query(
          `INSERT INTO vehicle_tuev_records (vehicle_id, next_due_date, result, created_by)
           VALUES ($1, $2, 'pass', $3)
           ON CONFLICT DO NOTHING`,
          [vehicle.id, v.tuevDate, SOURCE],
        );
        console.log(`  [insert] tuev ${v.code} → next_due=${v.tuevDate}`);

        await client.query(
          `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [SOURCE, 'fleet', 'insert', 'vehicle_tuev_record', v.code,
            JSON.stringify({ next_due_date: v.tuevDate }), SOURCE],
        );
      }

      // 3. UPSERT tax record (year=2026)
      await client.query(
        `INSERT INTO vehicle_tax_records (vehicle_id, tax_year, amount, created_by)
         VALUES ($1, 2026, $2, $3)
         ON CONFLICT (vehicle_id, tax_year) DO UPDATE SET amount = EXCLUDED.amount, updated_by = $3`,
        [vehicle.id, v.steuer, SOURCE],
      );
      console.log(`  [upsert] tax ${v.code} → 2026: ${v.steuer}€`);

      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [SOURCE, 'fleet', 'upsert', 'vehicle_tax_record', v.code,
          JSON.stringify({ tax_year: 2026, amount: v.steuer }), SOURCE],
      );

      // 4. UPSERT insurance
      // Check if already exists for this vehicle + company + coverage
      const { rowCount: insExists } = await client.query(
        `SELECT 1 FROM vehicle_insurance_policies WHERE vehicle_id = $1 AND company = $2 AND coverage_type = $3 AND status = 'active'`,
        [vehicle.id, v.versAnbieter, coverageType],
      );

      if (insExists && insExists > 0) {
        await client.query(
          `UPDATE vehicle_insurance_policies SET annual_premium = $1, updated_by = $2
           WHERE vehicle_id = $3 AND company = $4 AND coverage_type = $5 AND status = 'active'`,
          [v.versPreis, SOURCE, vehicle.id, v.versAnbieter, coverageType],
        );
        console.log(`  [update] insurance ${v.code} → ${v.versAnbieter} ${coverageType} ${v.versPreis}€`);
      } else {
        await client.query(
          `INSERT INTO vehicle_insurance_policies (vehicle_id, company, coverage_type, annual_premium, status, created_by)
           VALUES ($1, $2, $3, $4, 'active', $5)`,
          [vehicle.id, v.versAnbieter, coverageType, v.versPreis, SOURCE],
        );
        console.log(`  [insert] insurance ${v.code} → ${v.versAnbieter} ${coverageType} ${v.versPreis}€`);
      }

      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [SOURCE, 'fleet', 'upsert', 'vehicle_insurance_policy', v.code,
          JSON.stringify({ company: v.versAnbieter, coverage_type: coverageType, annual_premium: v.versPreis }),
          SOURCE],
      );

      console.log('');
    }

    await client.query('COMMIT');
    console.log('Transaction committed.\n');

    // Verification
    console.log('--- Verification ---');
    const { rows: counts } = await pool.query(`
      SELECT 'vehicles' AS t, count(*)::int AS c FROM vehicles UNION ALL
      SELECT 'tuev_records', count(*) FROM vehicle_tuev_records UNION ALL
      SELECT 'tax_2026', count(*) FROM vehicle_tax_records WHERE tax_year = 2026 UNION ALL
      SELECT 'insurance', count(*) FROM vehicle_insurance_policies WHERE status = 'active'
    `);
    for (const r of counts) {
      console.log(`  ${r.t}: ${r.c}`);
    }

    const { rows: auditCounts } = await pool.query(
      `SELECT action, entity_type, COUNT(*)::int AS c FROM audit_log WHERE source = $1 GROUP BY action, entity_type ORDER BY entity_type, action`,
      [SOURCE],
    );
    console.log('\n--- Audit Log ---');
    for (const r of auditCounts) {
      console.log(`  ${r.action} ${r.entity_type}: ${r.c}`);
    }

  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\nImport complete.');
}

// ── Main ────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'apply') {
  apply().catch(e => {
    console.error(`\nFATAL: ${e.message}`);
    process.exit(1);
  });
} else {
  dryRun();
}
