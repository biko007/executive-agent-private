#!/usr/bin/env bun
/**
 * Sprint 6 Migration — Fleet JSON -> Postgres
 *
 * Usage:
 *   bun run src/modules/fleet/migrate-v025.ts --dry-run       # Validate + manifest
 *   bun run src/modules/fleet/migrate-v025.ts --schema-only   # Apply DDL only
 *   bun run src/modules/fleet/migrate-v025.ts --apply         # DDL + data insert
 *
 * Environment:
 *   POSTGRES_URL — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { FleetVehiclesFileSchema, type FleetVehicle } from './fleet-json-schema.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WORKSPACE = join(homedir(), '.openclaw/workspace');
const VEHICLES_JSON = join(WORKSPACE, 'artifacts/personal/fleet/vehicles.json');
const MIGRATION_SQL = join(import.meta.dir, 'migrations/V025__fleet_tables.sql');
const DRY_RUN_REPORT = join(homedir(), 'tmp/fleet-dry-run-report.md');

const VEHICLE_CODE_MAP: Record<string, string> = {
  'v-1c31e6': 'FZG-TESLA-X',
  'v-mercdes-benz-g-580-g-klasse': 'FZG-G580',
  'v-polaris-ranger-xp-kinetic': 'FZG-RANGER',
  'v-porsche-911-turbo': 'FZG-911T',
  'v-mercedes-benz-560-sl': 'FZG-560SL',
};

const TYPO_CORRECTIONS: Record<string, Record<string, string>> = {
  make: { 'Mercdes-Benz': 'Mercedes-Benz' },
  insurance_company: { 'Gothear': 'Gothaer' },
};

const EXPECTED_COUNTS = {
  vehicles: 5,
  vehicle_service_records: 1,
  vehicle_insurance_policies: 4,
  vehicle_tuev_records: 0,
  vehicle_tax_records: 0,
  fleet_documents: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

function correctMake(make: string): string {
  return TYPO_CORRECTIONS.make[make] ?? make;
}

function correctInsuranceCompany(company: string): string {
  return TYPO_CORRECTIONS.insurance_company[company] ?? company;
}

function parseInsuranceProvider(provider: string): { company: string; policyNumber: string | null } {
  const m = provider.match(/^(.+?)\s+Nr\.\s+([\d.]+)$/);
  if (m) {
    return { company: correctInsuranceCompany(m[1]), policyNumber: m[2] };
  }
  return { company: correctInsuranceCompany(provider), policyNumber: null };
}

function mapCoverageType(type: string): string {
  const map: Record<string, string> = {
    'Vollkasko': 'vollkasko',
    'Teilkasko': 'teilkasko',
    'Haftpflicht': 'haftpflicht',
  };
  return map[type] ?? type.toLowerCase();
}

function buildSourcePayload(v: FleetVehicle): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: v.type,
    original_json_id: v.id,
    model_year: v.year,
  };
  if (v.color !== undefined) payload.color = v.color;
  if (v.purchasePrice !== undefined) payload.purchase_price = v.purchasePrice;
  if (v.vehicleTax !== undefined) payload.tax_amount_legacy_no_year = v.vehicleTax;
  if (v.tuevDate !== undefined) payload.tuev_next_due_legacy_no_inspection = v.tuevDate;
  return payload;
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function loadVehicles(): FleetVehicle[] {
  if (!existsSync(VEHICLES_JSON)) throw new Error(`vehicles.json not found: ${VEHICLES_JSON}`);
  const raw = readFileSync(VEHICLES_JSON, 'utf-8');
  return JSON.parse(raw) as FleetVehicle[];
}

// ── Dry-Run ──────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('\n Sprint 6 Migration — Fleet JSON -> Postgres [DRY-RUN]\n');

  // 1. Load and validate with Zod
  const rawContent = readFileSync(VEHICLES_JSON, 'utf-8');
  const parsed = JSON.parse(rawContent);
  const result = FleetVehiclesFileSchema.safeParse(parsed);

  if (!result.success) {
    console.error('Zod validation FAILED:');
    console.error(result.error.issues);
    process.exit(1);
  }

  const vehicles = result.data;
  console.log(`Zod validation: ${vehicles.length}/${vehicles.length} pass\n`);

  // 2. SHA-256 manifest
  const fileHash = sha256(rawContent);
  const now = new Date().toISOString();
  const dateStamp = now.slice(0, 10).replace(/-/g, '');
  const archiveDir = join(WORKSPACE, `artifacts/.archive/fleet-pre-S6-${dateStamp}`);
  mkdirSync(archiveDir, { recursive: true });

  const manifest = {
    files: [{ path: 'artifacts/personal/fleet/vehicles.json', sha256: fileHash }],
    created_at: now,
  };
  writeFileSync(join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`SHA-256 manifest written to ${archiveDir}/manifest.json`);
  console.log(`  vehicles.json SHA-256: ${fileHash}\n`);

  // 3. Per-vehicle mapping table
  const report: string[] = [];
  report.push('# Fleet Dry-Run Report');
  report.push(`Generated: ${now}`);
  report.push('');
  report.push(`## Zod Validation: ${vehicles.length}/${vehicles.length} PASS`);
  report.push('');
  report.push(`## SHA-256: \`${fileHash}\``);
  report.push('');
  report.push('## Vehicle Mapping');
  report.push('');
  report.push('| Source ID | Vehicle Code | Display Name | Make | Corrections |');
  report.push('|---|---|---|---|---|');

  console.log('Vehicle mapping:');
  console.log('  Source ID                              -> Code         Display Name       Make              Corrections');
  console.log('  ' + '-'.repeat(110));

  for (const v of vehicles) {
    const code = VEHICLE_CODE_MAP[v.id];
    if (!code) {
      console.error(`  ERROR: No vehicle code mapping for ${v.id}`);
      process.exit(1);
    }
    const correctedMake = correctMake(v.make);
    const corrections: string[] = [];
    if (correctedMake !== v.make) corrections.push(`make: "${v.make}" -> "${correctedMake}"`);
    if (v.insurance) {
      const { company } = parseInsuranceProvider(v.insurance.provider);
      if (company !== v.insurance.provider && !v.insurance.provider.includes('Nr.')) {
        corrections.push(`insurance.company: "${v.insurance.provider}" -> "${company}"`);
      } else if (v.insurance.provider.includes('Nr.')) {
        const rawCompany = v.insurance.provider.match(/^(.+?)\s+Nr\./)?.[1] ?? '';
        const corrected = correctInsuranceCompany(rawCompany);
        if (corrected !== rawCompany) {
          corrections.push(`insurance.company: "${rawCompany}" -> "${corrected}"`);
        }
      }
    }
    const corrStr = corrections.length > 0 ? corrections.join('; ') : '-';
    console.log(`  ${v.id.padEnd(40)} -> ${code.padEnd(13)} ${v.name.padEnd(18)} ${correctedMake.padEnd(17)} ${corrStr}`);
    report.push(`| ${v.id} | ${code} | ${v.name} | ${correctedMake} | ${corrStr} |`);
  }

  // 4. Expected row counts
  console.log('\nExpected row counts:');
  report.push('');
  report.push('## Expected Row Counts');
  report.push('');
  report.push('| Table | Count |');
  report.push('|---|---|');
  for (const [table, count] of Object.entries(EXPECTED_COUNTS)) {
    console.log(`  ${table.padEnd(35)} ${count}`);
    report.push(`| ${table} | ${count} |`);
  }

  // 5. source_payload per vehicle
  console.log('\nsource_payload per vehicle:');
  report.push('');
  report.push('## source_payload Contents');
  report.push('');
  for (const v of vehicles) {
    const code = VEHICLE_CODE_MAP[v.id]!;
    const payload = buildSourcePayload(v);
    console.log(`  ${code}: ${JSON.stringify(payload)}`);
    report.push(`**${code}:** \`${JSON.stringify(payload)}\``);
    report.push('');
  }

  // 6. Insurance mapping
  console.log('\nInsurance mapping (4 policies expected):');
  report.push('## Insurance Mapping');
  report.push('');
  report.push('| Vehicle | Company | Policy # | Coverage | Premium |');
  report.push('|---|---|---|---|---|');
  let insuranceCount = 0;
  for (const v of vehicles) {
    if (!v.insurance) continue;
    insuranceCount++;
    const code = VEHICLE_CODE_MAP[v.id]!;
    const { company, policyNumber } = parseInsuranceProvider(v.insurance.provider);
    const coverage = mapCoverageType(v.insurance.type);
    console.log(`  ${code}: ${company} | ${policyNumber ?? 'NULL'} | ${coverage} | ${v.insurance.annualCost ?? 'NULL'}`);
    report.push(`| ${code} | ${company} | ${policyNumber ?? 'NULL'} | ${coverage} | ${v.insurance.annualCost ?? 'NULL'} |`);
  }
  console.log(`  Total: ${insuranceCount} policies`);

  // 7. Service records
  console.log('\nService records (1 expected):');
  report.push('');
  report.push('## Service Records');
  report.push('');
  let serviceCount = 0;
  for (const v of vehicles) {
    for (const s of v.serviceLog) {
      serviceCount++;
      const code = VEHICLE_CODE_MAP[v.id]!;
      console.log(`  ${code}: ${s.date} | ${s.type} | mileage=${s.mileage ?? 'NULL'} | cost=${s.cost ?? 'NULL'} | ${s.notes ?? ''}`);
      report.push(`- **${code}:** ${s.date} | ${s.type} | mileage=${s.mileage ?? 'NULL'} | cost=${s.cost ?? 'NULL'} | ${s.notes ?? ''}`);
    }
  }
  console.log(`  Total: ${serviceCount} records`);

  // 8. TUeV — no separate records, tuevDate goes to source_payload
  console.log('\nTUeV: 0 records (tuevDate -> source_payload.tuev_next_due_legacy_no_inspection)');
  report.push('');
  report.push('## TUeV');
  report.push('');
  report.push('No `vehicle_tuev_records` rows. `tuevDate` stored in `source_payload.tuev_next_due_legacy_no_inspection`.');
  report.push('');
  for (const v of vehicles) {
    if (!v.tuevDate) continue;
    const code = VEHICLE_CODE_MAP[v.id]!;
    console.log(`  ${code}: source_payload.tuev_next_due_legacy_no_inspection = ${v.tuevDate}`);
    report.push(`- **${code}:** tuev_next_due_legacy_no_inspection = ${v.tuevDate}`);
  }

  // Write report
  mkdirSync(dirname(DRY_RUN_REPORT), { recursive: true });
  writeFileSync(DRY_RUN_REPORT, report.join('\n') + '\n', 'utf-8');
  console.log(`\nReport written to ${DRY_RUN_REPORT}`);

  // Assertions
  const allGood =
    vehicles.length === EXPECTED_COUNTS.vehicles &&
    serviceCount === EXPECTED_COUNTS.vehicle_service_records &&
    insuranceCount === EXPECTED_COUNTS.vehicle_insurance_policies;

  if (allGood) {
    console.log('\nAll assertions PASS.');
  } else {
    console.error('\nAssertion MISMATCH:');
    if (vehicles.length !== EXPECTED_COUNTS.vehicles)
      console.error(`  vehicles: expected ${EXPECTED_COUNTS.vehicles}, got ${vehicles.length}`);
    if (serviceCount !== EXPECTED_COUNTS.vehicle_service_records)
      console.error(`  service_records: expected ${EXPECTED_COUNTS.vehicle_service_records}, got ${serviceCount}`);
    if (insuranceCount !== EXPECTED_COUNTS.vehicle_insurance_policies)
      console.error(`  insurance_policies: expected ${EXPECTED_COUNTS.vehicle_insurance_policies}, got ${insuranceCount}`);
    process.exit(1);
  }
}

// ── Schema-Only ──────────────────────────────────────────────────────────────

async function schemaOnly(): Promise<void> {
  console.log('\n Sprint 6 Migration — Fleet DDL [SCHEMA-ONLY]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Ensure schema_version table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
      )
    `);

    // Check if already applied
    const { rows: existing } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'fleet' AND version = 25"
    );

    if (existing.length > 0) {
      console.log('V025 already applied (fleet, 25 in schema_version). Verifying tables...');
    } else {
      console.log('Applying V025__fleet_tables.sql...');
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      await client.query(ddl);
      console.log('DDL applied.');
    }

    // Verify 6 tables
    const { rows: tables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'vehicle%' OR table_name IN ('vehicles', 'fleet_documents'))
      ORDER BY table_name
    `);

    console.log(`\nTables found: ${tables.length}`);
    for (const t of tables) {
      console.log(`  ${t.table_name}`);
    }

    if (tables.length !== 6) {
      console.error(`ERROR: Expected 6 tables, found ${tables.length}`);
      process.exit(1);
    }

    // Verify triggers
    const { rows: triggers } = await client.query<{ trigger_name: string; event_object_table: string }>(`
      SELECT trigger_name, event_object_table
      FROM information_schema.triggers
      WHERE trigger_name LIKE 'trg_%_updated_at'
        AND event_object_table IN ('vehicles', 'vehicle_service_records',
          'vehicle_insurance_policies', 'vehicle_tax_records',
          'vehicle_tuev_records', 'fleet_documents')
      ORDER BY event_object_table
    `);

    console.log(`\nTriggers found: ${triggers.length}`);
    for (const t of triggers) {
      console.log(`  ${t.trigger_name} ON ${t.event_object_table}`);
    }

    if (triggers.length !== 6) {
      console.error(`ERROR: Expected 6 triggers, found ${triggers.length}`);
      process.exit(1);
    }

    // Verify indexes
    const { rows: indexes } = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_%vehicle%' OR indexname LIKE 'idx_fleet_%'
      ORDER BY indexname
    `);

    console.log(`\nIndexes found: ${indexes.length}`);
    for (const i of indexes) {
      console.log(`  ${i.indexname}`);
    }

    // Verify schema_version
    const { rows: sv } = await client.query<{ module: string; version: number; applied_at: Date }>(
      "SELECT module, version, applied_at FROM schema_version WHERE module = 'fleet'"
    );
    console.log(`\nschema_version entry:`);
    for (const r of sv) {
      console.log(`  module=${r.module}, version=${r.version}, applied_at=${r.applied_at}`);
    }

    console.log('\nSchema-only verification PASS.');
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Apply (Full migration) ───────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('\n Sprint 6 Migration — Fleet JSON -> Postgres [APPLY]\n');

  const vehicles = loadVehicles();
  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);
  console.log(`Vehicles to migrate: ${vehicles.length}`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Ensure schema_version
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
      )
    `);

    // Apply DDL
    console.log('Applying V025 DDL...');
    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(ddl);

    await client.query('BEGIN');

    // ── Insert vehicles ──
    console.log(`Inserting ${vehicles.length} vehicles...`);
    const vehicleDbIds = new Map<string, number>();

    for (const v of vehicles) {
      const code = VEHICLE_CODE_MAP[v.id];
      if (!code) throw new Error(`No vehicle code mapping for ${v.id}`);

      const make = correctMake(v.make);
      const payload = buildSourcePayload(v);

      const res = await client.query<{ id: number }>(
        `INSERT INTO vehicles
          (vehicle_code, display_name, license_plate, make, model, vin,
           first_registration, current_mileage_km, status, source_payload,
           created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
         ON CONFLICT (vehicle_code) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [
          code,
          v.name,
          v.plate ?? null,
          make,
          v.model,
          v.vin ?? null,
          null, // first_registration — year is model year, not registration
          v.mileage ?? null,
          'active',
          JSON.stringify(payload),
          v.createdAt,
          v.updatedAt,
          'system:sprint6_migration',
        ]
      );
      vehicleDbIds.set(v.id, res.rows[0].id);
      console.log(`  ${code} (id=${res.rows[0].id})`);
    }

    // ── Insert insurance policies ──
    let insuranceCount = 0;
    for (const v of vehicles) {
      if (!v.insurance) continue;
      const dbId = vehicleDbIds.get(v.id)!;
      const { company, policyNumber } = parseInsuranceProvider(v.insurance.provider);
      const coverage = mapCoverageType(v.insurance.type);

      await client.query(
        `INSERT INTO vehicle_insurance_policies
          (vehicle_id, company, policy_number, coverage_type, annual_premium, status,
           created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          dbId,
          company,
          policyNumber,
          coverage,
          v.insurance.annualCost ?? null,
          'active',
          'system:sprint6_migration',
        ]
      );
      insuranceCount++;
    }
    console.log(`  ${insuranceCount} insurance policies inserted`);

    // ── Insert service records ──
    let serviceCount = 0;
    for (const v of vehicles) {
      for (const s of v.serviceLog) {
        const dbId = vehicleDbIds.get(v.id)!;
        await client.query(
          `INSERT INTO vehicle_service_records
            (vehicle_id, service_date, service_type, mileage_km, cost, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            dbId,
            s.date,
            s.type,
            s.mileage ?? null,
            s.cost ?? null,
            s.notes ?? null,
            'system:sprint6_migration',
          ]
        );
        serviceCount++;
      }
    }
    console.log(`  ${serviceCount} service records inserted`);

    // TUeV: no separate records — tuevDate stored in source_payload

    // ── Validate counts ──
    console.log('\nPost-insert validation...');
    const counts = await client.query<{ t: string; c: number }>(`
      SELECT 'vehicles' AS t, count(*)::int AS c FROM vehicles UNION ALL
      SELECT 'vehicle_service_records', count(*)::int FROM vehicle_service_records UNION ALL
      SELECT 'vehicle_insurance_policies', count(*)::int FROM vehicle_insurance_policies UNION ALL
      SELECT 'vehicle_tuev_records', count(*)::int FROM vehicle_tuev_records UNION ALL
      SELECT 'vehicle_tax_records', count(*)::int FROM vehicle_tax_records UNION ALL
      SELECT 'fleet_documents', count(*)::int FROM fleet_documents
    `);

    let allMatch = true;
    for (const row of counts.rows) {
      const expected = EXPECTED_COUNTS[row.t as keyof typeof EXPECTED_COUNTS];
      const status = row.c === expected ? 'OK' : 'MISMATCH';
      if (status === 'MISMATCH') allMatch = false;
      console.log(`  ${row.t.padEnd(35)} ${row.c} (expected ${expected}) ${status}`);
    }

    if (!allMatch) {
      throw new Error('Row count validation FAILED');
    }

    // ── Audit log (SAVEPOINT) ──
    try {
      await client.query('SAVEPOINT audit_sp');
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ('system', 'fleet', 'system.sprint6_migration', 'migration', 'sprint6', $1::jsonb, 'system')`,
        [JSON.stringify({
          vehicles: vehicles.length,
          vehicle_service_records: serviceCount,
          vehicle_insurance_policies: insuranceCount,
          vehicle_tuev_records: 0,
          vehicle_tax_records: 0,
          fleet_documents: 0,
        })]
      );
      await client.query('RELEASE SAVEPOINT audit_sp');
      console.log('  audit_log entry written');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT audit_sp');
      console.log('  (audit_log entry skipped — table/schema may not exist in test DB)');
    }

    await client.query('COMMIT');
    console.log('\nMigration complete!');

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`\nMigration FAILED — ROLLBACK executed: ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--schema-only')
    ? 'schema-only'
    : 'dry-run';

if (mode === 'dry-run') {
  dryRun();
} else if (mode === 'schema-only') {
  schemaOnly().catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  apply().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
