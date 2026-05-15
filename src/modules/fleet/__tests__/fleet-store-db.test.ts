/**
 * Fleet Store DB Tests — Sprint 6c
 * Tests the Postgres-backed fleet store against a real test database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;

// Store module must be imported AFTER setupTestDb() sets POSTGRES_URL
let store: typeof import('../store.js');
let auditModule: typeof import('../../../shared/audit/index.js');

beforeAll(async () => {
  const setup = await setupTestDb();
  cleanup = setup.cleanup;
  // Dynamic import after POSTGRES_URL is set to test DB
  store = await import('../store.js');
  auditModule = await import('../../../shared/audit/index.js');
});

afterAll(async () => {
  await cleanup();
});

describe('Fleet Store — Vehicle CRUD', () => {
  it('should create a vehicle', async () => {
    const v = await store.createVehicle({
      vehicleCode: 'FZG-TEST-1',
      displayName: 'Test Car One',
      make: 'Tesla',
      model: 'Model 3',
      licensePlate: 'TUT-T 123',
      currentMileageKm: 15000,
      sourcePayload: { vehicle_type: 'car', model_year: 2023 },
    }, 'test-actor');

    expect(v.vehicleCode).toBe('FZG-TEST-1');
    expect(v.name).toBe('Test Car One');
    expect(v.make).toBe('Tesla');
    expect(v.model).toBe('Model 3');
    expect(v.plate).toBe('TUT-T 123');
    expect(v.mileage).toBe(15000);
    expect(v.status).toBe('active');
  });

  it('should list active vehicles', async () => {
    const vehicles = await store.listVehicles();
    expect(vehicles.length).toBeGreaterThanOrEqual(1);
    expect(vehicles.some(v => v.vehicleCode === 'FZG-TEST-1')).toBe(true);
  });

  it('should get vehicle by code', async () => {
    const v = await store.getVehicleByCode('FZG-TEST-1');
    expect(v).not.toBeNull();
    expect(v!.vehicleCode).toBe('FZG-TEST-1');
    expect(v!.make).toBe('Tesla');
  });

  it('should return null for non-existent vehicle', async () => {
    const v = await store.getVehicleByCode('FZG-NOPE');
    expect(v).toBeNull();
  });

  it('should update a vehicle', async () => {
    const v = await store.updateVehicle('FZG-TEST-1', {
      display_name: 'Updated Test Car',
      current_mileage_km: 20000,
    }, 'test-actor');

    expect(v).not.toBeNull();
    expect(v!.name).toBe('Updated Test Car');
    expect(v!.mileage).toBe(20000);
  });
});

describe('Fleet Store — Code→ID Resolver', () => {
  it('should resolve valid code to ID', async () => {
    const id = await store.resolveVehicleCodeToId('FZG-TEST-1');
    // BIGSERIAL returns as string in pg driver, Number() converts it
    expect(Number(id)).toBeGreaterThan(0);
  });

  it('should throw for invalid code', async () => {
    expect(store.resolveVehicleCodeToId('FZG-INVALID')).rejects.toThrow('Fahrzeug nicht gefunden');
  });
});

describe('Fleet Store — Archive Flow', () => {
  it('should archive a vehicle', async () => {
    // Create a vehicle to archive
    await store.createVehicle({
      vehicleCode: 'FZG-ARCHIVE-1',
      displayName: 'Archive Me',
      make: 'BMW',
      model: 'X5',
    }, 'test-actor');

    const archived = await store.archiveVehicle('FZG-ARCHIVE-1', 'Test archive', 'test-actor');
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe('archived');
    expect(archived!.archivedReason).toBe('Test archive');
    expect(archived!.archivedAt).toBeTruthy();
  });

  it('should not list archived vehicles by default', async () => {
    const vehicles = await store.listVehicles();
    expect(vehicles.some(v => v.vehicleCode === 'FZG-ARCHIVE-1')).toBe(false);
  });

  it('should list archived vehicles with status filter', async () => {
    const vehicles = await store.listVehicles({ status: 'archived' });
    expect(vehicles.some(v => v.vehicleCode === 'FZG-ARCHIVE-1')).toBe(true);
  });

  it('should unarchive a vehicle', async () => {
    const unarchived = await store.unarchiveVehicle('FZG-ARCHIVE-1', 'test-actor');
    expect(unarchived).not.toBeNull();
    expect(unarchived!.status).toBe('active');
    expect(unarchived!.archivedAt).toBeUndefined();
    expect(unarchived!.archivedReason).toBeUndefined();
  });

  // Clean up
  afterAll(async () => {
    try { await store.archiveVehicle('FZG-ARCHIVE-1', 'cleanup', 'test'); } catch {}
  });
});

describe('Fleet Store — Service Records', () => {
  it('should add a service record', async () => {
    const v = await store.addServiceRecord('FZG-TEST-1', {
      service_date: '2026-05-01',
      service_type: 'Oil Change',
      mileage_km: 25000,
      cost: 80,
      notes: 'Regular maintenance',
    }, 'test-actor');

    expect(v.serviceLog.length).toBeGreaterThanOrEqual(1);
    const latest = v.serviceLog.find(s => s.type === 'Oil Change');
    expect(latest).toBeTruthy();
    expect(latest!.cost).toBe(80);
  });

  it('should auto-update mileage when service mileage is higher', async () => {
    const v = await store.getVehicleByCode('FZG-TEST-1');
    expect(v!.mileage).toBe(25000);
  });

  it('should update a service record', async () => {
    const v = await store.getVehicleByCode('FZG-TEST-1');
    const record = v!.serviceLog.find(s => s.type === 'Oil Change');
    // Find the record ID from DB
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM vehicle_service_records WHERE service_type = 'Oil Change' LIMIT 1"
    );
    expect(rows.length).toBeGreaterThan(0);

    await store.updateServiceRecord(rows[0].id, { notes: 'Updated note' }, 'test-actor');
    // Verify update
    const { rows: updated } = await dbQuery(
      'SELECT notes FROM vehicle_service_records WHERE id = $1', [rows[0].id]
    );
    expect(updated[0].notes).toBe('Updated note');
  });

  it('should delete a service record', async () => {
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM vehicle_service_records WHERE service_type = 'Oil Change' LIMIT 1"
    );
    expect(rows.length).toBeGreaterThan(0);

    await store.deleteServiceRecord(rows[0].id, 'test-actor');

    const { rows: after } = await dbQuery(
      'SELECT id FROM vehicle_service_records WHERE id = $1', [rows[0].id]
    );
    expect(after.length).toBe(0);
  });
});

describe('Fleet Store — Insurance Policies', () => {
  it('should add an insurance policy', async () => {
    const v = await store.addInsurancePolicy('FZG-TEST-1', {
      company: 'Gothaer',
      coverage_type: 'vollkasko',
      annual_premium: 1905,
      policy_number: 'POL-2026-3613',
    }, 'test-actor');

    expect(v.insurancePolicies.length).toBeGreaterThanOrEqual(1);
    expect(v.insurance).toBeTruthy();
    expect(v.insurance!.provider).toBe('Gothaer');
    expect(v.insurance!.annualCost).toBe(1905);
  });

  it('should deactivate old policy when adding new one', async () => {
    const v = await store.addInsurancePolicy('FZG-TEST-1', {
      company: 'Helvetia',
      coverage_type: 'haftpflicht',
      annual_premium: 500,
    }, 'test-actor');

    expect(v.insurance!.provider).toBe('Helvetia');
    // Old policy should be expired
    const expired = v.insurancePolicies.find(p => p.provider === 'Gothaer');
    expect(expired).toBeTruthy();
    expect(expired!.status).toBe('expired');
  });

  it('should delete an insurance policy', async () => {
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM vehicle_insurance_policies WHERE company = 'Gothaer' LIMIT 1"
    );
    expect(rows.length).toBeGreaterThan(0);

    await store.deleteInsurancePolicy(rows[0].id, 'test-actor');
    const { rows: after } = await dbQuery(
      'SELECT id FROM vehicle_insurance_policies WHERE id = $1', [rows[0].id]
    );
    expect(after.length).toBe(0);
  });
});

describe('Fleet Store — TÜV Records', () => {
  it('should add a TÜV record', async () => {
    const v = await store.addTuevRecord('FZG-TEST-1', {
      inspection_date: '2026-05-01',
      result: 'pass',
      next_due_date: '2028-05-01',
      mileage_km: 25000,
    }, 'test-actor');

    expect(v.tuevRecords.length).toBeGreaterThanOrEqual(1);
    expect(v.tuevRecords[0].result).toBe('pass');
    expect(v.tuevDate).toBe('2028-05-01');
  });

  it('should delete a TÜV record', async () => {
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM vehicle_tuev_records WHERE result = 'pass' LIMIT 1"
    );
    await store.deleteTuevRecord(rows[0].id, 'test-actor');
    const { rows: after } = await dbQuery(
      'SELECT id FROM vehicle_tuev_records WHERE id = $1', [rows[0].id]
    );
    expect(after.length).toBe(0);
  });
});

describe('Fleet Store — Tax Records', () => {
  it('should add a tax record', async () => {
    const v = await store.addTaxRecord('FZG-TEST-1', {
      tax_year: 2026,
      amount: 350.00,
      notes: 'Annual vehicle tax',
    }, 'test-actor');

    expect(v.taxRecords.length).toBeGreaterThanOrEqual(1);
    expect(v.taxRecords[0].taxYear).toBe(2026);
    expect(v.taxRecords[0].amount).toBe(350);
  });

  it('should delete a tax record', async () => {
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM vehicle_tax_records WHERE tax_year = 2026 LIMIT 1"
    );
    await store.deleteTaxRecord(rows[0].id, 'test-actor');
    const { rows: after } = await dbQuery(
      'SELECT id FROM vehicle_tax_records WHERE id = $1', [rows[0].id]
    );
    expect(after.length).toBe(0);
  });
});

describe('Fleet Store — Documents', () => {
  it('should add a document', async () => {
    const v = await store.addDocument('FZG-TEST-1', {
      doc_type: 'vehicle_registration',
      url: 'https://example.com/doc.pdf',
      title: 'Registration Certificate',
    }, 'test-actor');

    expect(v.documents.length).toBeGreaterThanOrEqual(1);
    expect(v.documents[0].title).toBe('Registration Certificate');
    expect(v.documents[0].docType).toBe('vehicle_registration');
  });

  it('should delete a document', async () => {
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    const { rows } = await dbQuery(
      "SELECT id FROM fleet_documents WHERE doc_type = 'vehicle_registration' LIMIT 1"
    );
    await store.deleteDocument(rows[0].id, 'test-actor');
    const { rows: after } = await dbQuery(
      'SELECT id FROM fleet_documents WHERE id = $1', [rows[0].id]
    );
    expect(after.length).toBe(0);
  });
});

describe('Fleet Store — Deadline Check', () => {
  it('should detect upcoming TÜV deadline', async () => {
    // Add a TÜV record due in 30 days
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const iso = futureDate.toISOString().slice(0, 10);

    await store.addTuevRecord('FZG-TEST-1', {
      next_due_date: iso,
    }, 'test-actor');

    const warnings = await store.checkDeadlines();
    const tuevWarning = warnings.find(w => w.vehicleId === 'FZG-TEST-1' && w.field === 'tuev');
    expect(tuevWarning).toBeTruthy();
    expect(tuevWarning!.daysLeft).toBeLessThanOrEqual(31);
    expect(tuevWarning!.severity).toBe('warning');
  });
});

describe('Fleet Store — Formatting', () => {
  it('should format vehicle list', async () => {
    const vehicles = await store.listVehicles();
    const text = store.formatVehicleList(vehicles);
    expect(text).toContain('Fuhrpark');
    expect(text).toContain('FZG-TEST-1');
  });

  it('should format vehicle detail', async () => {
    const v = await store.getVehicleByCode('FZG-TEST-1');
    const text = store.formatVehicleDetail(v!);
    expect(text).toContain('Updated Test Car');
    expect(text).toContain('Tesla');
    expect(text).toContain('Model 3');
  });

  it('should format empty list', () => {
    const text = store.formatVehicleList([]);
    expect(text).toContain('Keine Fahrzeuge');
  });
});

describe('Fleet Store — Audit Masking', () => {
  it('should mask VIN with tail-only visibility', () => {
    const masked = auditModule.maskSensitiveFields({
      vin: 'WVWZZZ3CZWE901132',
      vehicle_code: 'FZG-TEST',
    });
    expect(masked.vin).toBe('***1132');
    expect(masked.vehicle_code).toBe('FZG-TEST');
  });

  it('should mask policy_number with tail-only visibility', () => {
    const masked = auditModule.maskSensitiveFields({
      policy_number: 'POL-2026-3613',
      company: 'Gothaer',
    });
    expect(masked.policy_number).toBe('***3613');
    expect(masked.company).toBe('Gothaer');
  });

  it('should mask short VIN completely', () => {
    const masked = auditModule.maskSensitiveFields({ vin: 'AB12' });
    expect(masked.vin).toBe('***');
  });
});

describe('Fleet Store — Cleanup Verification', () => {
  it('should clean up all test data', async () => {
    // Archive all test vehicles
    try { await store.archiveVehicle('FZG-TEST-1', 'cleanup', 'test'); } catch {}
    try { await store.archiveVehicle('FZG-ARCHIVE-1', 'cleanup', 'test'); } catch {}

    // Delete remaining sub-entity records
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    await dbQuery("DELETE FROM vehicle_service_records WHERE created_by = 'test-actor'");
    await dbQuery("DELETE FROM vehicle_insurance_policies WHERE created_by = 'test-actor'");
    await dbQuery("DELETE FROM vehicle_tuev_records WHERE created_by = 'test-actor'");
    await dbQuery("DELETE FROM vehicle_tax_records WHERE created_by = 'test-actor'");
    await dbQuery("DELETE FROM fleet_documents WHERE created_by = 'test-actor'");
    await dbQuery("DELETE FROM vehicles WHERE created_by = 'test-actor'");

    const { rows } = await dbQuery('SELECT COUNT(*)::int AS cnt FROM vehicles');
    expect(rows[0].cnt).toBe(0);
  });
});
