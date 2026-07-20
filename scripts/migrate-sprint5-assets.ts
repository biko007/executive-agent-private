#!/usr/bin/env bun
/**
 * Sprint 5 Migration — Assets JSON → Postgres
 *
 * Usage:
 *   npm run migrate:sprint5 -- --dry-run   # Inventur + Mapping-Datei generieren
 *   npm run migrate:sprint5 -- --apply     # Migrieren (fail-closed)
 *
 * Environment:
 *   POSTGRES_URL  — connection string (reads from ~/.config/openclaw/env if missing)
 *   DB_NAME       — override database name (for test runs)
 */
import pg from 'pg';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertSafeDbUrl } from '../src/core/db-guard.js';

// ── Config ──────────────────────────────────────────────────────────────────

const ASSETS_DIR = join(homedir(), '.openclaw/workspace/artifacts/personal/assets');
const PROPERTIES_FILE = join(ASSETS_DIR, 'properties.json');
const LEASES_FILE = join(ASSETS_DIR, 'leases.json');
const COSTS_DIR = join(ASSETS_DIR, 'operating-costs');
const MAPPING_FILE = join(homedir(), '.openclaw/workspace/artifacts/migration_cost_mapping.json');
const MIGRATION_SQL = join(import.meta.dir, '../src/modules/assets/migrations/V022__assets_tables.sql');

const AVAILABLE_CODES = [
  'grundsteuer', 'wasser', 'entwaesserung', 'heizung', 'warmwasser',
  'verbundene_heizung_warmwasser', 'aufzug', 'strassenreinigung_muell',
  'gebaeudereinigung', 'gartenpflege', 'beleuchtung', 'schornstein',
  'versicherung', 'hauswart', 'antenne_kabel', 'waeschepflege',
  'sonstige_betrkv', 'instandhaltung', 'modernisierung', 'verwaltung',
  'schuldzinsen', 'afa', 'leerstand',
];

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

function getConnectionString(): string {
  let url = loadEnv();
  const dbOverride = process.env.DB_NAME;
  if (dbOverride) {
    url = url.replace(/\/[^/?]+(\?|$)/, `/${dbOverride}$1`);
  }
  return url;
}

interface JsonProperty {
  id: string;
  label: string;
  address: string;
  type: string;
  owner: string;
  purchasePrice?: number;
  units: JsonUnit[];
  distributionKeys: JsonDistKey[];
  createdAt: string;
  updatedAt: string;
}

interface JsonUnit {
  id: string;
  label: string;
  floor: string;
  sqm: number | null;
  rentType: string;
  tenant: string;
  lease: string | null;
  currentRent: number | null;
}

interface JsonDistKey {
  id: string;
  label: string;
  values: Record<string, number>;
}

interface JsonLease {
  id: string;
  unitId: string;
  propertyId: string;
  tenant: string;
  startDate: string;
  endDate: string | null;
  rentNet: number;
  operatingCosts: number;
  depositAmount: number;
  linkedDocs: string[];
  createdAt: string;
  updatedAt: string;
}

interface JsonOperatingCosts {
  propertyId: string;
  year: number;
  distributionKeyId: string;
  costs: Record<string, number>;
  updatedAt: string;
}

// ── Data Loading ────────────────────────────────────────────────────────────

function loadProperties(): JsonProperty[] {
  if (!existsSync(PROPERTIES_FILE)) return [];
  return JSON.parse(readFileSync(PROPERTIES_FILE, 'utf-8'));
}

function loadLeases(): JsonLease[] {
  if (!existsSync(LEASES_FILE)) return [];
  return JSON.parse(readFileSync(LEASES_FILE, 'utf-8'));
}

function loadOperatingCosts(): { file: string; data: JsonOperatingCosts }[] {
  if (!existsSync(COSTS_DIR)) return [];
  const files = readdirSync(COSTS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => ({
    file: f,
    data: JSON.parse(readFileSync(join(COSTS_DIR, f), 'utf-8')),
  }));
}

function parseAddress(address: string): { street: string; postal_code: string; city: string } {
  // Format: "Straße Nr, PLZ Stadt"
  const parts = address.split(',').map(s => s.trim());
  if (parts.length < 2) return { street: address, postal_code: '', city: '' };
  const street = parts[0];
  const rest = parts.slice(1).join(', ').trim();
  const plzMatch = rest.match(/^(\d{5})\s+(.+)$/);
  if (plzMatch) {
    return { street, postal_code: plzMatch[1], city: plzMatch[2] };
  }
  return { street, postal_code: '', city: rest };
}

function mapPropertyType(type: string): string {
  const map: Record<string, string> = {
    residential: 'residential',
    commercial: 'commercial',
    mixed: 'mixed',
    industrial: 'industrial',
  };
  return map[type] || 'residential';
}

function mapUnitType(unitId: string, propertyType: string): string {
  if (unitId.includes('-h')) return 'industrial_hall';
  if (unitId.includes('-g')) return 'garage';
  if (unitId.includes('-s')) return 'storage';
  if (propertyType === 'commercial') return 'office';
  return 'apartment';
}

function mapLeaseType(rentType: string, propertyType: string): string {
  if (propertyType === 'commercial' || propertyType === 'industrial') return 'commercial';
  if (rentType === 'temporary') return 'temporary';
  return 'residential';
}

// ── Dry-Run ─────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('\n Sprint 5 Migration — Assets JSON → Postgres [DRY-RUN]\n');

  const properties = loadProperties();
  const leases = loadLeases();
  const opCosts = loadOperatingCosts();

  // ── Properties ──
  console.log(`Properties: ${properties.length}`);
  for (const p of properties) {
    const addr = parseAddress(p.address);
    console.log(`  ${p.id}: "${p.label}" | ${addr.street}, ${addr.postal_code} ${addr.city} | ${p.type} | ${p.owner}`);
    console.log(`    Units: ${p.units.length}, DistKeys: ${p.distributionKeys.length}`);
    console.log(`    NULL fields: purchase_price, building_value, land_value, afa_rate, areas, heating_type, ownership_start`);
  }

  // ── Units ──
  const allUnits = properties.flatMap(p => p.units.map(u => ({ ...u, propertyId: p.id, propertyType: p.type })));
  console.log(`\nUnits: ${allUnits.length}`);
  for (const u of allUnits) {
    console.log(`  ${u.id}: "${u.label}" | floor=${u.floor} | sqm=${u.sqm ?? 'NULL'} | type=${mapUnitType(u.id, u.propertyType)} | rent=${u.rentType}`);
  }

  // ── Leases ──
  console.log(`\nLeases: ${leases.length}`);
  if (leases.length === 0) {
    console.log('  (keine leases.json vorhanden — Leases werden in Etappe d manuell angelegt)');
  }
  let unverifiedCount = 0;
  for (const l of leases) {
    const hasComponents = l.rentNet != null && l.operatingCosts != null;
    const status = hasComponents ? 'OK' : 'unverified_legacy';
    if (!hasComponents) unverifiedCount++;
    console.log(`  ${l.id}: unit=${l.unitId} | tenant="${l.tenant}" | kaltmiete=${l.rentNet ?? 'NULL'} | nk=${l.operatingCosts ?? 'NULL'} | ${status}`);
  }

  // ── Tenants ──
  const tenantNames = new Set<string>();
  for (const u of allUnits) { if (u.tenant) tenantNames.add(u.tenant); }
  for (const l of leases) { if (l.tenant) tenantNames.add(l.tenant); }
  console.log(`\nTenants (unique names): ${tenantNames.size}`);
  for (const name of tenantNames) {
    console.log(`  "${name}" — wird als person mit last_name migriert`);
  }

  // ── Operating Costs ──
  console.log(`\nOperating Costs files: ${opCosts.length}`);
  const allFreitexte = new Set<string>();
  let totalBookings = 0;
  for (const { file, data } of opCosts) {
    const entries = Object.entries(data.costs).filter(([, v]) => v != null && v > 0);
    totalBookings += entries.length;
    console.log(`  ${file}: property=${data.propertyId}, year=${data.year}, entries=${entries.length}`);
    for (const [key] of entries) {
      allFreitexte.add(key);
    }
  }
  console.log(`\nExpense bookings total: ${totalBookings}`);
  console.log(`Unique Kostenarten-Freitexte: ${allFreitexte.size}`);
  for (const ft of allFreitexte) {
    console.log(`  "${ft}"`);
  }

  // ── Generate/update Mapping File ──
  let existingMapping: Record<string, string | null> = {};
  if (existsSync(MAPPING_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(MAPPING_FILE, 'utf-8'));
      existingMapping = existing.mapping || {};
      console.log(`\nMapping-Datei existiert: ${MAPPING_FILE}`);
      console.log(`  Bestehende Einträge: ${Object.keys(existingMapping).length}`);
    } catch {
      console.log('\nMapping-Datei existiert aber ist fehlerhaft — wird neu generiert');
    }
  }

  // Merge: keep existing values, add new ones as null
  const mergedMapping: Record<string, string | null> = { ...existingMapping };
  let newCount = 0;
  for (const ft of allFreitexte) {
    if (!(ft in mergedMapping)) {
      mergedMapping[ft] = null;
      newCount++;
    }
  }

  const mappingOutput = {
    _instructions: 'Trage für jeden Freitext den passenden cost_categories.code ein. Apply läuft erst wenn alle Werte ≠ null sind.',
    _available_codes: AVAILABLE_CODES,
    mapping: mergedMapping,
  };

  writeFileSync(MAPPING_FILE, JSON.stringify(mappingOutput, null, 2), 'utf-8');
  console.log(`\nMapping-Datei geschrieben: ${MAPPING_FILE}`);
  console.log(`  Gesamt: ${Object.keys(mergedMapping).length} Einträge (${newCount} neu)`);
  const unmapped = Object.entries(mergedMapping).filter(([, v]) => v === null);
  if (unmapped.length > 0) {
    console.log(`  ⚠️  ${unmapped.length} noch unmapped:`);
    for (const [key] of unmapped) {
      console.log(`    "${key}" → null`);
    }
  } else if (Object.keys(mergedMapping).length > 0) {
    console.log('  ✅ Alle Freitexte gemappt');
  } else {
    console.log('  (keine Freitexte — keine operating-costs-Dateien vorhanden)');
  }

  // ── Summary ──
  console.log('\n--- ZUSAMMENFASSUNG ---');
  console.log(`Properties:        ${properties.length}`);
  console.log(`Units:             ${allUnits.length}`);
  console.log(`Tenants:           ${tenantNames.size}`);
  console.log(`Leases:            ${leases.length} (${unverifiedCount} unverified_legacy)`);
  console.log(`Expense bookings:  ${totalBookings}`);
  console.log(`Cost categories:   23 (Pre-Seed)`);
  console.log(`Kostenarten-Map:   ${allFreitexte.size} Freitexte`);
  console.log('\nNULL-migrierte Felder pro Property: ~12 (Finanzen, Flächen, Heizung)');
  console.log('NULL-migrierte Felder pro Unit: ~6 (sqm, rooms, area)');

  if (leases.length === 0 && totalBookings === 0) {
    console.log('\n✅ Keine Lease- oder Kosten-Daten vorhanden.');
    console.log('   Migration beschränkt sich auf: Schema + cost_categories Pre-Seed + Properties + Units.');
    console.log('   Leases, Tenants und Expense-Bookings werden in Etappe d manuell angelegt.');
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('\n Sprint 5 Migration — Assets JSON → Postgres [APPLY]\n');

  const properties = loadProperties();
  const leases = loadLeases();
  const opCosts = loadOperatingCosts();

  // ── Validate Mapping File (if operating costs exist) ──
  let costMapping: Record<string, string> = {};
  if (opCosts.length > 0) {
    if (!existsSync(MAPPING_FILE)) {
      console.error('❌ ABBRUCH: Mapping-Datei fehlt. Zuerst --dry-run ausführen.');
      process.exit(1);
    }
    const mappingData = JSON.parse(readFileSync(MAPPING_FILE, 'utf-8'));
    costMapping = mappingData.mapping || {};

    const unmapped = Object.entries(costMapping).filter(([, v]) => v === null);
    if (unmapped.length > 0) {
      console.error(`❌ ABBRUCH: ${unmapped.length} Freitexte unmapped:`);
      for (const [key] of unmapped) {
        console.error(`  "${key}" → null`);
      }
      console.error('\nBitte artifacts/migration_cost_mapping.json editieren und erneut --apply ausführen.');
      process.exit(1);
    }

    // Validate all mapped codes exist in AVAILABLE_CODES
    for (const [key, code] of Object.entries(costMapping)) {
      if (!AVAILABLE_CODES.includes(code)) {
        console.error(`❌ ABBRUCH: Unbekannter Code "${code}" für Freitext "${key}". Verfügbare Codes: ${AVAILABLE_CODES.join(', ')}`);
        process.exit(1);
      }
    }
  }

  // ── Collect tenant names from leases ──
  const tenantNames = new Set<string>();
  for (const l of leases) { if (l.tenant) tenantNames.add(l.tenant); }

  // ── Connect ──
  const connStr = getConnectionString();
  if (process.env.OPENCLAW_TEST === '1') assertSafeDbUrl(connStr);
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] || '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // ── Ensure schema_version table exists ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
      )
    `);

    // ── Apply Schema ──
    console.log('Running schema migration (V022__assets_tables.sql)...');
    const schemaSql = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(schemaSql);

    await client.query('BEGIN');

    // ── Insert Properties ──
    console.log(`Inserting ${properties.length} properties...`);
    const propertyIdMap = new Map<string, number>(); // code → DB id
    for (const p of properties) {
      const addr = parseAddress(p.address);
      const res = await client.query(
        `INSERT INTO properties (code, name, street, postal_code, city, property_type, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [p.id, p.label, addr.street, addr.postal_code, addr.city,
         mapPropertyType(p.type),
         p.owner !== 'personal' ? `Owner: ${p.owner}` : null,
         p.createdAt, p.updatedAt]
      );
      propertyIdMap.set(p.id, res.rows[0].id);
    }

    // ── Insert Units ──
    const allUnits = properties.flatMap(p => p.units.map(u => ({ ...u, propertyId: p.id, propertyType: p.type })));
    console.log(`Inserting ${allUnits.length} units...`);
    const unitIdMap = new Map<string, number>(); // json-id → DB id
    for (const u of allUnits) {
      const propDbId = propertyIdMap.get(u.propertyId);
      if (!propDbId) throw new Error(`Property ${u.propertyId} not found for unit ${u.id}`);
      const res = await client.query(
        `INSERT INTO units (property_id, code, unit_type, floor, living_area_qm, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         ON CONFLICT (property_id, code) DO UPDATE SET unit_type = EXCLUDED.unit_type
         RETURNING id`,
        [propDbId, u.id, mapUnitType(u.id, u.propertyType), u.floor,
         u.sqm, u.label !== u.id ? `Label: ${u.label}` : null]
      );
      unitIdMap.set(u.id, res.rows[0].id);
    }

    // ── Insert Tenants (from leases) ──
    const tenantIdMap = new Map<string, number>(); // name → DB id
    if (tenantNames.size > 0) {
      console.log(`Inserting ${tenantNames.size} tenants...`);
      for (const name of tenantNames) {
        const nameParts = name.trim().split(/\s+/);
        const lastName = nameParts.pop() || name;
        const firstName = nameParts.join(' ') || null;
        const res = await client.query(
          `INSERT INTO tenants (tenant_type, first_name, last_name, created_at, updated_at)
           VALUES ('person', $1, $2, now(), now())
           RETURNING id`,
          [firstName, lastName]
        );
        tenantIdMap.set(name, res.rows[0].id);
      }
    }

    // ── Insert Leases ──
    if (leases.length > 0) {
      console.log(`Inserting ${leases.length} leases...`);
      const leaseIdMap = new Map<string, number>();
      for (const l of leases) {
        const unitDbId = unitIdMap.get(l.unitId);
        if (!unitDbId) throw new Error(`Unit ${l.unitId} not found for lease ${l.id}`);

        const hasComponents = l.rentNet != null && l.operatingCosts != null;
        const prop = properties.find(p => p.id === l.propertyId);
        const unit = prop?.units.find(u => u.id === l.unitId);
        const leaseType = mapLeaseType(unit?.rentType || 'permanent', prop?.type || 'residential');

        const res = await client.query(
          `INSERT INTO leases (lease_number, unit_id, lease_type, status, start_date, end_date,
                               kaltmiete, nk_vorauszahlung, kaution, billing_mode,
                               created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            l.id, unitDbId, leaseType,
            hasComponents ? 'active' : 'unverified_legacy',
            l.startDate, l.endDate || null,
            hasComponents ? l.rentNet : null,
            hasComponents ? l.operatingCosts : null,
            l.depositAmount || null,
            'vorauszahlung',
            l.createdAt, l.updatedAt,
          ]
        );
        leaseIdMap.set(l.id, res.rows[0].id);

        // ── Insert lease_tenants junction ──
        if (l.tenant && tenantIdMap.has(l.tenant)) {
          await client.query(
            `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from)
             VALUES ($1, $2, 'contract_party', true, $3)`,
            [res.rows[0].id, tenantIdMap.get(l.tenant), l.startDate]
          );
        }
      }
    }

    // ── Insert Expense Bookings ──
    if (opCosts.length > 0) {
      console.log(`Inserting expense bookings from ${opCosts.length} operating-cost files...`);
      let bookingCount = 0;
      for (const { data } of opCosts) {
        const propDbId = propertyIdMap.get(data.propertyId);
        if (!propDbId) {
          console.warn(`  ⚠️ Property ${data.propertyId} not found — skipping ${Object.keys(data.costs).length} bookings`);
          continue;
        }

        let idx = 0;
        for (const [category, amount] of Object.entries(data.costs)) {
          if (amount == null || amount <= 0) continue;

          const mappedCode = costMapping[category];
          if (!mappedCode) {
            throw new Error(`Kostenart "${category}" nicht in Mapping-Datei gefunden`);
          }

          const sourceKey = `${data.propertyId}-${data.year}-${idx}`;
          const periodStart = `${data.year}-01-01`;
          const periodEnd = `${data.year}-12-31`;

          await client.query(
            `INSERT INTO expense_bookings (source_key, property_id, cost_category_id, amount_gross,
                                           umlagefaehig, service_period_start, service_period_end,
                                           notes, created_at, updated_at)
             SELECT $1, $2, cc.id, $3, cc.umlagefaehig_default, $4, $5, $6, now(), now()
             FROM cost_categories cc WHERE cc.code = $7
             ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`,
            [sourceKey, propDbId, amount, periodStart, periodEnd,
             `Migriert aus ${data.propertyId}-${data.year}.json, Position "${category}"`,
             mappedCode]
          );
          bookingCount++;
          idx++;
        }
      }
      console.log(`  ${bookingCount} expense bookings inserted`);
    }

    // ── Post-Insert Validation ──
    console.log('Post-insert validation...');
    const counts = await client.query(`
      SELECT 'properties' AS t, count(*)::int AS c FROM properties UNION ALL
      SELECT 'units', count(*)::int FROM units UNION ALL
      SELECT 'tenants', count(*)::int FROM tenants UNION ALL
      SELECT 'leases', count(*)::int FROM leases UNION ALL
      SELECT 'lease_tenants', count(*)::int FROM lease_tenants UNION ALL
      SELECT 'cost_categories', count(*)::int FROM cost_categories UNION ALL
      SELECT 'expense_bookings', count(*)::int FROM expense_bookings
    `);

    // ── Audit Log (SAVEPOINT to avoid aborting transaction if table missing) ──
    try {
      await client.query('SAVEPOINT audit_sp');
      await client.query(
        `INSERT INTO audit_log (module, action, entity_type, entity_id, after_data, source)
         VALUES ('assets', 'system.sprint5_migration', 'migration', 'sprint5',
                 $1::jsonb, 'system')`,
        [JSON.stringify({
          properties: properties.length,
          units: allUnits.length,
          tenants: tenantNames.size,
          leases: leases.length,
          cost_categories: 23,
          expense_bookings: opCosts.reduce((sum, oc) => sum + Object.values(oc.data.costs).filter(v => v != null && v > 0).length, 0),
        })]
      );
      await client.query('RELEASE SAVEPOINT audit_sp');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT audit_sp');
      console.log('  (audit_log Eintrag übersprungen — Tabelle/Schema ggf. nicht vorhanden in Test-DB)');
    }

    await client.query('COMMIT');

    console.log('\n✅ Migration complete!');
    for (const row of counts.rows) {
      console.log(`  ${row.t}: ${row.c}`);
    }
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`\n❌ Migration FAILED — ROLLBACK executed: ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'dry-run') {
  dryRun();
} else {
  apply().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
