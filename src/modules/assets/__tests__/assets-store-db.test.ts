/**
 * Assets Store DB Roundtrip Test (Sprint 5 §7.2)
 *
 * Verifies: CRUD roundtrips + constraint checks against a real Postgres test database.
 * 7 tests covering the befüllte tables (properties, units, tenants, leases,
 * lease_tenants, cost_categories, expense_bookings).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let listProperties: typeof import('../store.js')['listProperties'];
let getProperty: typeof import('../store.js')['getProperty'];
let createProperty: typeof import('../store.js')['createProperty'];
let updateProperty: typeof import('../store.js')['updateProperty'];
let deleteProperty: typeof import('../store.js')['deleteProperty'];
let addUnit: typeof import('../store.js')['addUnit'];
let removeUnit: typeof import('../store.js')['removeUnit'];
let setLease: typeof import('../store.js')['setLease'];
let getLeaseByUnit: typeof import('../store.js')['getLeaseByUnit'];
let deleteLease: typeof import('../store.js')['deleteLease'];
let setOperatingCosts: typeof import('../store.js')['setOperatingCosts'];
let getOperatingCosts: typeof import('../store.js')['getOperatingCosts'];
let dbQuery: typeof import('../../../shared/db/index.js')['query'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  const store = await import('../store.js');
  listProperties = store.listProperties;
  getProperty = store.getProperty;
  createProperty = store.createProperty;
  updateProperty = store.updateProperty;
  deleteProperty = store.deleteProperty;
  addUnit = store.addUnit;
  removeUnit = store.removeUnit;
  setLease = store.setLease;
  getLeaseByUnit = store.getLeaseByUnit;
  deleteLease = store.deleteLease;
  setOperatingCosts = store.setOperatingCosts;
  getOperatingCosts = store.getOperatingCosts;

  const db = await import('../../../shared/db/index.js');
  dbQuery = db.query;
});

afterAll(async () => {
  await cleanup();
});

describe('Assets Store DB Roundtrip (Sprint 5 §7.2)', () => {
  test('1. Property CRUD: create → list → get → update → delete', async () => {
    // Create
    const prop = await createProperty('t01', 'Teststr. 1', 'Teststr. 1, 78532 Tuttlingen', 'residential', 'personal');
    expect(prop.id).toBe('t01');
    expect(prop.label).toBe('Teststr. 1');
    expect(prop.address).toContain('Teststr. 1');
    expect(prop.type).toBe('residential');
    expect(prop.owner).toBe('personal');

    // List
    const all = await listProperties();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some(p => p.id === 't01')).toBe(true);

    // Get
    const loaded = await getProperty('t01');
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe('Teststr. 1');

    // Update
    const updated = await updateProperty('t01', { label: 'Teststr. 1a' });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe('Teststr. 1a');

    // Delete (soft)
    const deleted = await deleteProperty('t01');
    expect(deleted).toBe(true);
    const gone = await getProperty('t01');
    expect(gone).toBeNull();
  });

  test('2. Unit CRUD: addUnit → verify → removeUnit → verify', async () => {
    // Setup property
    await createProperty('t02', 'UnitTest', 'UnitStr. 2, 78532 Tuttlingen', 'residential', 'personal');

    // Add unit
    const prop = await addUnit('t02', {
      id: 't02-w1', label: 'W1 — EG', floor: 'EG', sqm: 65,
      rentType: 'vacant', tenant: '', lease: null, currentRent: null,
    });
    expect(prop).not.toBeNull();
    expect(prop!.units.length).toBe(1);
    expect(prop!.units[0].id).toBe('t02-w1');
    expect(prop!.units[0].label).toBe('W1 — EG');
    expect(prop!.units[0].floor).toBe('EG');

    // Remove unit (soft)
    const after = await removeUnit('t02', 't02-w1');
    expect(after).not.toBeNull();
    expect(after!.units.length).toBe(0);

    // Cleanup
    await deleteProperty('t02');
  });

  test('3. Lease CRUD: setLease → getLeaseByUnit → deleteLease', async () => {
    // Setup property + unit
    await createProperty('t03', 'LeaseTest', 'LeaseStr. 3, 78532 Tuttlingen', 'residential', 'personal');
    await addUnit('t03', {
      id: 't03-w1', label: 'W1', floor: 'EG', sqm: 50,
      rentType: 'vacant', tenant: '', lease: null, currentRent: null,
    });

    // Set lease
    const lease = await setLease('t03', 't03-w1', {
      tenant: 'Max Mustermann',
      startDate: '2025-01-01',
      endDate: null,
      rentNet: 850,
      operatingCosts: 200,
      depositAmount: 2550,
      linkedDocs: [],
    });
    expect(lease.unitId).toBe('t03-w1');
    expect(lease.propertyId).toBe('t03');
    expect(lease.tenant).toBe('Max Mustermann');
    expect(lease.rentNet).toBe(850);
    expect(lease.operatingCosts).toBe(200);

    // Get by unit
    const found = await getLeaseByUnit('t03-w1');
    expect(found).not.toBeNull();
    expect(found!.tenant).toBe('Max Mustermann');
    expect(found!.rentNet).toBe(850);

    // Verify unit shows lease data in property
    const prop = await getProperty('t03');
    expect(prop).not.toBeNull();
    const unit = prop!.units.find(u => u.id === 't03-w1');
    expect(unit).toBeTruthy();
    expect(unit!.rentType).toBe('permanent');
    expect(unit!.tenant).toBe('Max Mustermann');
    expect(unit!.currentRent).toBe(850);

    // Delete lease
    const deleted = await deleteLease(lease.id);
    expect(deleted).toBe(true);
    const gone = await getLeaseByUnit('t03-w1');
    expect(gone).toBeNull();

    // Cleanup
    await deleteProperty('t03');
  });

  test('4. Operating costs: setOperatingCosts → getOperatingCosts', async () => {
    await createProperty('t04', 'CostsTest', 'CostStr. 4, 78532 Tuttlingen', 'residential', 'personal');

    // Set costs (using legacy codes — mapping translates to DB codes)
    const oc = await setOperatingCosts('t04', 2025, {
      heizung: 1200,
      wasser: 800,
      versicherung: 500,
    }, '');

    expect(oc.propertyId).toBe('t04');
    expect(oc.year).toBe(2025);
    expect(oc.costs.heizung).toBe(1200);
    expect(oc.costs.wasser).toBe(800);
    expect(oc.costs.versicherung).toBe(500);

    // Get back
    const loaded = await getOperatingCosts('t04', 2025);
    expect(loaded).not.toBeNull();
    expect(loaded!.costs.heizung).toBe(1200);
    expect(loaded!.costs.wasser).toBe(800);
    expect(loaded!.costs.versicherung).toBe(500);

    // Cleanup
    await deleteProperty('t04');
  });

  test('5. Constraint: invalid tenant_type rejected', async () => {
    try {
      await dbQuery(
        `INSERT INTO tenants (tenant_type, last_name) VALUES ('invalid_type', 'Test')`,
      );
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain('violates check constraint');
    }
  });

  test('6. Constraint: invalid lease_type rejected', async () => {
    // Need a valid unit first
    await createProperty('t06', 'ConstraintTest', 'CStr. 6, 78532 Tuttlingen', 'residential', 'personal');
    await addUnit('t06', {
      id: 't06-w1', label: 'W1', floor: 'EG', sqm: 40,
      rentType: 'vacant', tenant: '', lease: null, currentRent: null,
    });

    // Get unit DB id
    const { rows } = await dbQuery<{ id: number }>(
      `SELECT u.id FROM units u JOIN properties p ON u.property_id = p.id
       WHERE u.code = 't06-w1' AND p.code = 't06'`,
    );
    const unitDbId = rows[0].id;

    try {
      await dbQuery(
        `INSERT INTO leases (unit_id, lease_type, status, start_date)
         VALUES ($1, 'invalid_lease', 'active', '2025-01-01')`,
        [unitDbId],
      );
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain('violates check constraint');
    }

    // Cleanup
    await deleteProperty('t06');
  });

  test('7. cost_categories pre-seed: 23 entries', async () => {
    const { rows } = await dbQuery<{ count: string }>('SELECT count(*)::text AS count FROM cost_categories');
    expect(parseInt(rows[0].count)).toBe(23);

    // Verify specific entries
    const { rows: heizung } = await dbQuery<{ code: string; heating_cost_relevant: boolean }>(
      `SELECT code, heating_cost_relevant FROM cost_categories WHERE code = 'heizung'`,
    );
    expect(heizung.length).toBe(1);
    expect(heizung[0].heating_cost_relevant).toBe(true);

    // Verify BetrKV §2 Nr. 6 exists
    const { rows: nr6 } = await dbQuery<{ code: string }>(
      `SELECT code FROM cost_categories WHERE code = 'verbundene_heizung_warmwasser'`,
    );
    expect(nr6.length).toBe(1);
  });
});
