/**
 * fleet/store — Postgres-backed persistence for Fleet module.
 * Sprint 6c: Replaces JSON file-based store with DB pool queries.
 */
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import { maskSensitiveFields } from '../../shared/audit/index.js';
import { getRequestId, getCorrelationId, getActor, getSource } from '../../shared/correlation/index.js';
import type {
  Vehicle, VehicleType, ServiceEntry, VehicleDocument, Insurance,
  TuevRecord, TaxRecord, TireSet, DeadlineWarning,
  VehicleRow, ServiceRecordRow, InsurancePolicyRow, TuevRecordRow,
  TaxRecordRow, FleetDocumentRow, TireSetRow,
} from './types.js';

// ── Internal helpers ────────────────────────────────────────────────────────

function dateStr(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  return new Date(d).toISOString().slice(0, 10);
}

function ts(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  return new Date(d).toISOString();
}

// ── Resolve vehicle_code → DB id ────────────────────────────────────────────

export async function resolveVehicleCodeToId(code: string): Promise<number> {
  const { rows } = await dbQuery<{ id: number }>(
    'SELECT id FROM vehicles WHERE vehicle_code = $1 AND status = $2',
    [code, 'active'],
  );
  if (rows.length === 0) {
    throw new Error(`Fahrzeug nicht gefunden: ${code}`);
  }
  return rows[0].id;
}

// ── Assemble Vehicle from DB row ────────────────────────────────────────────

async function assembleVehicle(row: VehicleRow): Promise<Vehicle> {
  const vehicleDbId = row.id;

  // Service records
  const { rows: serviceRows } = await dbQuery<ServiceRecordRow>(
    'SELECT * FROM vehicle_service_records WHERE vehicle_id = $1 ORDER BY service_date DESC',
    [vehicleDbId],
  );

  // Insurance policies
  const { rows: insuranceRows } = await dbQuery<InsurancePolicyRow>(
    'SELECT * FROM vehicle_insurance_policies WHERE vehicle_id = $1 ORDER BY created_at DESC',
    [vehicleDbId],
  );

  // TÜV records
  const { rows: tuevRows } = await dbQuery<TuevRecordRow>(
    'SELECT * FROM vehicle_tuev_records WHERE vehicle_id = $1 ORDER BY COALESCE(next_due_date, inspection_date) DESC',
    [vehicleDbId],
  );

  // Tax records
  const { rows: taxRows } = await dbQuery<TaxRecordRow>(
    'SELECT * FROM vehicle_tax_records WHERE vehicle_id = $1 ORDER BY tax_year DESC',
    [vehicleDbId],
  );

  // Documents
  const { rows: docRows } = await dbQuery<FleetDocumentRow>(
    'SELECT * FROM fleet_documents WHERE vehicle_id = $1 ORDER BY created_at DESC',
    [vehicleDbId],
  );

  // Tire sets
  const { rows: tireRows } = await dbQuery<TireSetRow>(
    'SELECT * FROM vehicle_tire_sets WHERE vehicle_id = $1 ORDER BY installed_at DESC NULLS LAST',
    [vehicleDbId],
  );

  const serviceLog: ServiceEntry[] = serviceRows.map(s => ({
    date: dateStr(s.service_date) || '',
    type: s.service_type,
    mileage: s.mileage_km ?? undefined,
    cost: s.cost ? parseFloat(s.cost) : undefined,
    workshop: s.workshop ?? undefined,
    notes: s.notes ?? undefined,
    documentUrl: s.document_url ?? undefined,
  }));

  const insurancePolicies: Insurance[] = insuranceRows.map(i => ({
    id: i.id,
    provider: i.company,
    policyNumber: i.policy_number ?? undefined,
    type: i.coverage_type,
    validFrom: dateStr(i.valid_from),
    validUntil: dateStr(i.valid_to),
    annualCost: i.annual_premium ? parseFloat(i.annual_premium) : undefined,
    status: i.status,
  }));

  const activeInsurance = insurancePolicies.find(i => i.status === 'active');

  const tuevRecords: TuevRecord[] = tuevRows.map(t => ({
    id: t.id,
    inspectionDate: dateStr(t.inspection_date),
    result: t.result as TuevRecord['result'] ?? undefined,
    nextDueDate: dateStr(t.next_due_date),
    mileageKm: t.mileage_km ?? undefined,
    notes: t.notes ?? undefined,
    documentUrl: t.document_url ?? undefined,
  }));

  const taxRecords: TaxRecord[] = taxRows.map(t => ({
    id: t.id,
    taxYear: t.tax_year,
    amount: parseFloat(t.amount),
    paidAt: t.paid_at ? ts(t.paid_at) : undefined,
    notes: t.notes ?? undefined,
  }));

  const documents: VehicleDocument[] = docRows.map(d => ({
    id: d.id,
    docType: d.doc_type,
    title: d.title || d.url,
    url: d.url,
    notes: d.notes ?? undefined,
    createdAt: ts(d.created_at),
  }));

  const tireSets: TireSet[] = tireRows.map(t => ({
    id: t.id,
    tireType: t.tire_type ?? undefined,
    brand: t.brand ?? undefined,
    model: t.model ?? undefined,
    treadDepthMm: t.tread_depth_mm ? parseFloat(t.tread_depth_mm) : undefined,
    installedAt: dateStr(t.installed_at),
    removedAt: dateStr(t.removed_at),
    notes: t.notes ?? undefined,
  }));

  // Determine tuevDate from latest tuev record or source_payload fallback
  let tuevDate: string | undefined;
  if (tuevRows.length > 0 && tuevRows[0].next_due_date) {
    tuevDate = dateStr(tuevRows[0].next_due_date);
  } else if (row.source_payload?.tuev_next_due_legacy_no_inspection) {
    tuevDate = String(row.source_payload.tuev_next_due_legacy_no_inspection);
  }

  // Determine year from first_registration or source_payload
  let year: number | undefined;
  if (row.first_registration) {
    year = new Date(row.first_registration).getFullYear();
  } else if (row.source_payload?.model_year) {
    year = Number(row.source_payload.model_year);
  }

  // Aggregations from sub-records
  const tuevNextDueDate = tuevRows.length > 0 && tuevRows[0].next_due_date
    ? dateStr(tuevRows[0].next_due_date)
    : undefined;

  const currentYearTaxAmount = (() => {
    const yr = new Date().getFullYear();
    const match = taxRows.find(t => t.tax_year === yr);
    return match ? parseFloat(match.amount) : undefined;
  })();

  const activeInsurancePremium = activeInsurance?.annualCost;

  return {
    id: row.vehicle_code,
    vehicleCode: row.vehicle_code,
    type: (row.source_payload?.vehicle_type as VehicleType) || 'car',
    name: row.display_name,
    plate: row.license_plate ?? undefined,
    vin: row.vin ?? undefined,
    make: row.make,
    model: row.model,
    year,
    color: row.source_payload?.color as string | undefined,
    mileage: row.current_mileage_km ?? undefined,
    holder: row.holder ?? undefined,
    status: row.status as 'active' | 'archived',
    archivedAt: row.archived_at ? ts(row.archived_at) : undefined,
    archivedReason: row.archived_reason ?? undefined,
    notes: row.notes ?? undefined,
    sourcePayload: row.source_payload ?? undefined,
    fuelType: row.fuel_type ?? undefined,
    tuevDate,
    purchasePrice: row.source_payload?.purchase_price as number | undefined,
    vehicleTax: row.source_payload?.vehicle_tax as number | undefined,
    tuevNextDueDate,
    currentYearTaxAmount,
    activeInsurancePremium,
    insurance: activeInsurance,
    insurancePolicies,
    serviceLog,
    tuevRecords,
    taxRecords,
    documents,
    tireSets,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

// ── Vehicle CRUD ────────────────────────────────────────────────────────────

export async function listVehicles(opts?: { status?: string }): Promise<Vehicle[]> {
  const status = opts?.status || 'active';
  const { rows } = status === 'all'
    ? await dbQuery<VehicleRow>('SELECT * FROM vehicles ORDER BY vehicle_code')
    : await dbQuery<VehicleRow>('SELECT * FROM vehicles WHERE status = $1 ORDER BY vehicle_code', [status]);
  return Promise.all(rows.map(assembleVehicle));
}

export async function getVehicleByCode(code: string): Promise<Vehicle | null> {
  const { rows } = await dbQuery<VehicleRow>(
    'SELECT * FROM vehicles WHERE vehicle_code = $1',
    [code],
  );
  if (rows.length === 0) return null;
  return assembleVehicle(rows[0]);
}

export interface CreateVehicleInput {
  vehicleCode: string;
  displayName: string;
  make: string;
  model: string;
  licensePlate?: string;
  vin?: string;
  firstRegistration?: string;
  holder?: string;
  currentMileageKm?: number;
  notes?: string;
  sourcePayload?: Record<string, unknown>;
}

export async function createVehicle(input: CreateVehicleInput, actor?: string): Promise<Vehicle> {
  const { rows } = await dbQuery<VehicleRow>(
    `INSERT INTO vehicles
       (vehicle_code, display_name, make, model, license_plate, vin,
        first_registration, holder, current_mileage_km, notes, source_payload,
        status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $12)
     RETURNING *`,
    [
      input.vehicleCode, input.displayName, input.make, input.model,
      input.licensePlate || null, input.vin || null,
      input.firstRegistration || null, input.holder || null,
      input.currentMileageKm ?? null, input.notes || null,
      input.sourcePayload ? JSON.stringify(input.sourcePayload) : null,
      actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'vehicle.create',
    entityType: 'vehicle', entityId: input.vehicleCode,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return assembleVehicle(rows[0]);
}

export async function updateVehicle(
  code: string,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<Vehicle | null> {
  const { rows: before } = await dbQuery<VehicleRow>(
    'SELECT * FROM vehicles WHERE vehicle_code = $1',
    [code],
  );
  if (before.length === 0) return null;

  const FIELD_MAP: Record<string, string> = {
    vehicle_code: 'vehicle_code',
    display_name: 'display_name',
    license_plate: 'license_plate',
    make: 'make',
    model: 'model',
    vin: 'vin',
    first_registration: 'first_registration',
    holder: 'holder',
    current_mileage_km: 'current_mileage_km',
    notes: 'notes',
    source_payload: 'source_payload',
    fuel_type: 'fuel_type',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const [key, value] of Object.entries(patch)) {
    const dbField = FIELD_MAP[key];
    if (dbField) {
      sets.push(`${dbField} = $${pi++}`);
      params.push(key === 'source_payload' && value ? JSON.stringify(value) : value);
    }
  }

  if (actor) {
    sets.push(`updated_by = $${pi++}`);
    params.push(actor);
  }

  if (sets.length === 0) return getVehicleByCode(code);

  // If vehicle_code is being changed, we need the new code
  const newCode = (patch.vehicle_code as string) || code;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    params.push(before[0].id);
    const { rows: after } = await client.query<VehicleRow>(
      `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
      params,
    );

    // Audit log INSIDE transaction (Hard Rule)
    const maskedBefore = maskSensitiveFields(before[0] as unknown as Record<string, unknown>);
    const maskedAfter = maskSensitiveFields(after[0] as unknown as Record<string, unknown>);
    const requestId = getRequestId();
    const correlationId = getCorrelationId();
    const auditActor = actor ?? getActor();
    const source = getSource();

    await client.query(
      `INSERT INTO audit_log (actor, module, action, entity_type, entity_id,
        before_jsonb, after_jsonb, source, correlation_id, request_id)
       VALUES ($1, 'fleet', 'vehicle.update', 'vehicle', $2, $3, $4, $5, $6, $7)`,
      [auditActor, code, JSON.stringify(maskedBefore), JSON.stringify(maskedAfter),
       source, correlationId, requestId],
    );

    await client.query('COMMIT');

    return assembleVehicle(after[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function archiveVehicle(code: string, reason?: string, actor?: string): Promise<Vehicle | null> {
  const { rows: before } = await dbQuery<VehicleRow>(
    'SELECT * FROM vehicles WHERE vehicle_code = $1 AND status = $2',
    [code, 'active'],
  );
  if (before.length === 0) return null;

  const { rows: after } = await dbQuery<VehicleRow>(
    `UPDATE vehicles SET status = 'archived', archived_at = now(),
     archived_reason = $1, updated_by = $2 WHERE id = $3 RETURNING *`,
    [reason || null, actor || 'system', before[0].id],
  );

  await audit.log({
    module: 'fleet', action: 'vehicle.archive',
    entityType: 'vehicle', entityId: code,
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return assembleVehicle(after[0]);
}

export async function unarchiveVehicle(code: string, actor?: string): Promise<Vehicle | null> {
  const { rows: before } = await dbQuery<VehicleRow>(
    'SELECT * FROM vehicles WHERE vehicle_code = $1 AND status = $2',
    [code, 'archived'],
  );
  if (before.length === 0) return null;

  const { rows: after } = await dbQuery<VehicleRow>(
    `UPDATE vehicles SET status = 'active', archived_at = null,
     archived_reason = null, updated_by = $1 WHERE id = $2 RETURNING *`,
    [actor || 'system', before[0].id],
  );

  await audit.log({
    module: 'fleet', action: 'vehicle.unarchive',
    entityType: 'vehicle', entityId: code,
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return assembleVehicle(after[0]);
}

// ── Service Records CRUD ────────────────────────────────────────────────────

export async function addServiceRecord(
  code: string,
  input: {
    service_date: string; service_type: string; mileage_km?: number;
    workshop?: string; cost?: number; notes?: string; document_url?: string;
  },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  const { rows } = await dbQuery<ServiceRecordRow>(
    `INSERT INTO vehicle_service_records
       (vehicle_id, service_date, service_type, mileage_km, workshop, cost, notes, document_url, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [
      vehicleId, input.service_date, input.service_type,
      input.mileage_km ?? null, input.workshop || null,
      input.cost ?? null, input.notes || null, input.document_url || null,
      actor || 'system',
    ],
  );

  // Auto-update mileage if higher
  if (input.mileage_km != null) {
    await dbQuery(
      `UPDATE vehicles SET current_mileage_km = $1, updated_by = $2
       WHERE id = $3 AND (current_mileage_km IS NULL OR current_mileage_km < $1)`,
      [input.mileage_km, actor || 'system', vehicleId],
    );
  }

  await audit.log({
    module: 'fleet', action: 'service_record.create',
    entityType: 'service_record', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function updateServiceRecord(
  recordId: number,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<{ id: number }> {
  const { rows: before } = await dbQuery<ServiceRecordRow>(
    'SELECT * FROM vehicle_service_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Service-Eintrag nicht gefunden: ${recordId}`);

  const FIELDS = ['service_date', 'service_type', 'mileage_km', 'workshop', 'cost', 'notes', 'document_url'];
  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const f of FIELDS) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${pi++}`); params.push(patch[f]); }
  }
  if (actor) { sets.push(`updated_by = $${pi++}`); params.push(actor); }
  if (sets.length === 0) return { id: recordId };

  params.push(recordId);
  const { rows: after } = await dbQuery<ServiceRecordRow>(
    `UPDATE vehicle_service_records SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
    params,
  );

  await audit.log({
    module: 'fleet', action: 'service_record.update',
    entityType: 'service_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return { id: recordId };
}

export async function deleteServiceRecord(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<ServiceRecordRow>(
    'SELECT * FROM vehicle_service_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Service-Eintrag nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM vehicle_service_records WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'service_record.delete',
    entityType: 'service_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

// ── Insurance Policies CRUD ─────────────────────────────────────────────────

export async function addInsurancePolicy(
  code: string,
  input: {
    company: string; coverage_type: string; policy_number?: string;
    annual_premium?: number; valid_from?: string; valid_to?: string;
    notes?: string;
  },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  // Deactivate previous active policies
  await dbQuery(
    `UPDATE vehicle_insurance_policies SET status = 'expired', updated_by = $1
     WHERE vehicle_id = $2 AND status = 'active'`,
    [actor || 'system', vehicleId],
  );

  const { rows } = await dbQuery<InsurancePolicyRow>(
    `INSERT INTO vehicle_insurance_policies
       (vehicle_id, company, policy_number, coverage_type, annual_premium,
        valid_from, valid_to, status, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $9) RETURNING *`,
    [
      vehicleId, input.company, input.policy_number || null,
      input.coverage_type, input.annual_premium ?? null,
      input.valid_from || null, input.valid_to || null,
      input.notes || null, actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'insurance_policy.create',
    entityType: 'insurance_policy', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function updateInsurancePolicy(
  recordId: number,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<{ id: number }> {
  const { rows: before } = await dbQuery<InsurancePolicyRow>(
    'SELECT * FROM vehicle_insurance_policies WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Versicherungs-Police nicht gefunden: ${recordId}`);

  const FIELDS = ['company', 'policy_number', 'coverage_type', 'annual_premium', 'valid_from', 'valid_to', 'status', 'notes'];
  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const f of FIELDS) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${pi++}`); params.push(patch[f]); }
  }
  if (actor) { sets.push(`updated_by = $${pi++}`); params.push(actor); }
  if (sets.length === 0) return { id: recordId };

  params.push(recordId);
  const { rows: after } = await dbQuery<InsurancePolicyRow>(
    `UPDATE vehicle_insurance_policies SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
    params,
  );

  await audit.log({
    module: 'fleet', action: 'insurance_policy.update',
    entityType: 'insurance_policy', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return { id: recordId };
}

export async function deleteInsurancePolicy(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<InsurancePolicyRow>(
    'SELECT * FROM vehicle_insurance_policies WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Versicherungs-Police nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM vehicle_insurance_policies WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'insurance_policy.delete',
    entityType: 'insurance_policy', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

// ── TÜV Records CRUD ───────────────────────────────────────────────────────

export async function addTuevRecord(
  code: string,
  input: {
    inspection_date?: string; result?: string; next_due_date?: string;
    mileage_km?: number; notes?: string; document_url?: string;
  },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  const { rows } = await dbQuery<TuevRecordRow>(
    `INSERT INTO vehicle_tuev_records
       (vehicle_id, inspection_date, result, next_due_date, mileage_km, notes, document_url, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [
      vehicleId, input.inspection_date || null, input.result || null,
      input.next_due_date || null, input.mileage_km ?? null,
      input.notes || null, input.document_url || null,
      actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'tuev_record.create',
    entityType: 'tuev_record', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function updateTuevRecord(
  recordId: number,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<{ id: number }> {
  const { rows: before } = await dbQuery<TuevRecordRow>(
    'SELECT * FROM vehicle_tuev_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`TÜV-Eintrag nicht gefunden: ${recordId}`);

  const FIELDS = ['inspection_date', 'result', 'next_due_date', 'mileage_km', 'notes', 'document_url'];
  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const f of FIELDS) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${pi++}`); params.push(patch[f]); }
  }
  if (actor) { sets.push(`updated_by = $${pi++}`); params.push(actor); }
  if (sets.length === 0) return { id: recordId };

  params.push(recordId);
  const { rows: after } = await dbQuery<TuevRecordRow>(
    `UPDATE vehicle_tuev_records SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
    params,
  );

  await audit.log({
    module: 'fleet', action: 'tuev_record.update',
    entityType: 'tuev_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return { id: recordId };
}

export async function deleteTuevRecord(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<TuevRecordRow>(
    'SELECT * FROM vehicle_tuev_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`TÜV-Eintrag nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM vehicle_tuev_records WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'tuev_record.delete',
    entityType: 'tuev_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

// ── Tax Records CRUD ────────────────────────────────────────────────────────

export async function addTaxRecord(
  code: string,
  input: { tax_year: number; amount: number; paid_at?: string; notes?: string },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  const { rows } = await dbQuery<TaxRecordRow>(
    `INSERT INTO vehicle_tax_records
       (vehicle_id, tax_year, amount, paid_at, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [
      vehicleId, input.tax_year, input.amount,
      input.paid_at || null, input.notes || null,
      actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'tax_record.create',
    entityType: 'tax_record', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function updateTaxRecord(
  recordId: number,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<{ id: number }> {
  const { rows: before } = await dbQuery<TaxRecordRow>(
    'SELECT * FROM vehicle_tax_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Steuer-Eintrag nicht gefunden: ${recordId}`);

  const FIELDS = ['tax_year', 'amount', 'paid_at', 'notes'];
  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const f of FIELDS) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${pi++}`); params.push(patch[f]); }
  }
  if (actor) { sets.push(`updated_by = $${pi++}`); params.push(actor); }
  if (sets.length === 0) return { id: recordId };

  params.push(recordId);
  const { rows: after } = await dbQuery<TaxRecordRow>(
    `UPDATE vehicle_tax_records SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
    params,
  );

  await audit.log({
    module: 'fleet', action: 'tax_record.update',
    entityType: 'tax_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return { id: recordId };
}

export async function deleteTaxRecord(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<TaxRecordRow>(
    'SELECT * FROM vehicle_tax_records WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Steuer-Eintrag nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM vehicle_tax_records WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'tax_record.delete',
    entityType: 'tax_record', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

// ── Documents CRUD ──────────────────────────────────────────────────────────

export async function addDocument(
  code: string,
  input: { doc_type: string; url: string; title?: string; notes?: string },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  const { rows } = await dbQuery<FleetDocumentRow>(
    `INSERT INTO fleet_documents
       (vehicle_id, doc_type, title, url, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [
      vehicleId, input.doc_type, input.title || null,
      input.url, input.notes || null, actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'document.create',
    entityType: 'fleet_document', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function deleteDocument(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<FleetDocumentRow>(
    'SELECT * FROM fleet_documents WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Dokument nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM fleet_documents WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'document.delete',
    entityType: 'fleet_document', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

// ── Tire Sets CRUD ─────────────────────────────────────────────────────────

export async function addTireSet(
  code: string,
  input: {
    tire_type?: string; brand?: string; model?: string;
    tread_depth_mm?: number; installed_at?: string; removed_at?: string;
    notes?: string;
  },
  actor?: string,
): Promise<Vehicle> {
  const vehicleId = await resolveVehicleCodeToId(code);

  const { rows } = await dbQuery<TireSetRow>(
    `INSERT INTO vehicle_tire_sets
       (vehicle_id, tire_type, brand, model, tread_depth_mm, installed_at, removed_at, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [
      vehicleId, input.tire_type || null, input.brand || null,
      input.model || null, input.tread_depth_mm ?? null,
      input.installed_at || null, input.removed_at || null,
      input.notes || null, actor || 'system',
    ],
  );

  await audit.log({
    module: 'fleet', action: 'tire_set.create',
    entityType: 'tire_set', entityId: code,
    after: rows[0] as unknown as Record<string, unknown>,
  });

  return (await getVehicleByCode(code))!;
}

export async function updateTireSet(
  recordId: number,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<{ id: number }> {
  const { rows: before } = await dbQuery<TireSetRow>(
    'SELECT * FROM vehicle_tire_sets WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Reifensatz nicht gefunden: ${recordId}`);

  const FIELDS = ['tire_type', 'brand', 'model', 'tread_depth_mm', 'installed_at', 'removed_at', 'notes'];
  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const f of FIELDS) {
    if (patch[f] !== undefined) { sets.push(`${f} = $${pi++}`); params.push(patch[f]); }
  }
  if (actor) { sets.push(`updated_by = $${pi++}`); params.push(actor); }
  if (sets.length === 0) return { id: recordId };

  params.push(recordId);
  const { rows: after } = await dbQuery<TireSetRow>(
    `UPDATE vehicle_tire_sets SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`,
    params,
  );

  await audit.log({
    module: 'fleet', action: 'tire_set.update',
    entityType: 'tire_set', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
    after: after[0] as unknown as Record<string, unknown>,
  });

  return { id: recordId };
}

export async function deleteTireSet(recordId: number, actor?: string): Promise<void> {
  const { rows: before } = await dbQuery<TireSetRow>(
    'SELECT * FROM vehicle_tire_sets WHERE id = $1', [recordId],
  );
  if (before.length === 0) throw new Error(`Reifensatz nicht gefunden: ${recordId}`);

  await dbQuery('DELETE FROM vehicle_tire_sets WHERE id = $1', [recordId]);

  await audit.log({
    module: 'fleet', action: 'tire_set.delete',
    entityType: 'tire_set', entityId: String(recordId),
    before: before[0] as unknown as Record<string, unknown>,
  });
}

export async function listTireSets(
  code: string,
  opts?: { status?: 'active' },
): Promise<TireSet[]> {
  const vehicleId = await resolveVehicleCodeToId(code);
  let sql = 'SELECT * FROM vehicle_tire_sets WHERE vehicle_id = $1';
  if (opts?.status === 'active') {
    sql += ' AND removed_at IS NULL';
  }
  sql += ' ORDER BY installed_at DESC NULLS LAST';
  const { rows } = await dbQuery<TireSetRow>(sql, [vehicleId]);
  return rows.map(t => ({
    id: t.id,
    tireType: t.tire_type ?? undefined,
    brand: t.brand ?? undefined,
    model: t.model ?? undefined,
    treadDepthMm: t.tread_depth_mm ? parseFloat(t.tread_depth_mm) : undefined,
    installedAt: dateStr(t.installed_at),
    removedAt: dateStr(t.removed_at),
    notes: t.notes ?? undefined,
  }));
}

// ── Deadline check ──────────────────────────────────────────────────────────

export async function checkDeadlines(): Promise<DeadlineWarning[]> {
  const warnings: DeadlineWarning[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const vehicles = await listVehicles();

  for (const v of vehicles) {
    // TÜV deadline — from tuevRecords or source_payload fallback
    let tuevDueDate: string | undefined;
    if (v.tuevRecords.length > 0 && v.tuevRecords[0].nextDueDate) {
      tuevDueDate = v.tuevRecords[0].nextDueDate;
    } else if (v.sourcePayload?.tuev_next_due_legacy_no_inspection) {
      tuevDueDate = String(v.sourcePayload.tuev_next_due_legacy_no_inspection);
    }

    if (tuevDueDate) {
      const d = new Date(tuevDueDate);
      d.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (daysLeft <= 90) {
        warnings.push({
          vehicleId: v.vehicleCode,
          vehicleName: v.name,
          vehicleType: v.type,
          field: 'tuev',
          date: tuevDueDate,
          daysLeft,
          severity: daysLeft < 0 ? 'overdue' : daysLeft <= 30 ? 'warning' : 'info',
        });
      }
    }

    // Insurance deadline — from active policy valid_to
    const activePolicy = v.insurancePolicies.find(p => p.status === 'active');
    if (activePolicy?.validUntil) {
      const d = new Date(activePolicy.validUntil);
      d.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (daysLeft <= 90) {
        warnings.push({
          vehicleId: v.vehicleCode,
          vehicleName: v.name,
          vehicleType: v.type,
          field: 'insurance',
          date: activePolicy.validUntil,
          daysLeft,
          severity: daysLeft < 0 ? 'overdue' : daysLeft <= 30 ? 'warning' : 'info',
        });
      }
    }
  }

  warnings.sort((a, b) => a.daysLeft - b.daysLeft);
  return warnings;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function vehicleIcon(type: VehicleType): string {
  return type === 'car' ? '🚗' : type === 'boat' ? '🚤' : '🚲';
}

function formatDE(isoDate: string): string {
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function tuevStatus(tuevDate?: string): string {
  if (!tuevDate) return '❓ kein TÜV-Datum';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(tuevDate);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const dateStr = formatDE(tuevDate);
  if (days < 0) return `🔴 überfällig seit ${Math.abs(days)} Tagen`;
  if (days <= 30) return `⚠️ in ${days} Tagen (${dateStr})`;
  if (days <= 90) return `ℹ️ in ${days} Tagen (${dateStr})`;
  return `✅ ${dateStr}`;
}

export function formatVehicleList(vehicles: Vehicle[]): string {
  if (!vehicles.length) return '🚗 Keine Fahrzeuge im Fuhrpark.';

  const lines = vehicles.map(v => {
    const icon = vehicleIcon(v.type);
    const plate = v.plate ? ` [${v.plate}]` : '';
    const km = v.mileage != null ? ` | ${v.mileage.toLocaleString('de')} km` : '';
    const tuev = v.tuevDate ? ` | TÜV: ${tuevStatus(v.tuevDate)}` : '';
    return `${icon} **${v.name}**${plate} (${v.year || '?'})${km}${tuev}\n   ID: \`${v.vehicleCode}\``;
  });

  return `🚗 Fuhrpark (${vehicles.length}):\n\n${lines.join('\n\n')}`;
}

export function formatVehicleDetail(v: Vehicle): string {
  const icon = vehicleIcon(v.type);
  const lines: string[] = [
    `${icon} **${v.name}**`,
    '',
    `Typ: ${v.type === 'car' ? 'Auto' : v.type === 'boat' ? 'Boot' : 'Fahrrad'}`,
    `Hersteller: ${v.make}`,
    `Modell: ${v.model}`,
  ];

  if (v.year) lines.push(`Baujahr: ${v.year}`);
  if (v.plate) lines.push(`Kennzeichen: ${v.plate}`);
  if (v.vin) lines.push(`FIN: ${v.vin}`);
  if (v.color) lines.push(`Farbe: ${v.color}`);
  if (v.mileage != null) lines.push(`km-Stand: ${v.mileage.toLocaleString('de')} km`);
  if (v.tuevDate) lines.push(`TÜV: ${tuevStatus(v.tuevDate)}`);
  if (v.holder) lines.push(`Halter: ${v.holder}`);

  if (v.insurance) {
    lines.push('');
    lines.push('🛡 Versicherung:');
    lines.push(`   Anbieter: ${v.insurance.provider}`);
    lines.push(`   Typ: ${v.insurance.type}`);
    if (v.insurance.policyNumber) lines.push(`   Policen-Nr: ${v.insurance.policyNumber}`);
    if (v.insurance.validUntil) lines.push(`   Gültig bis: ${formatDE(v.insurance.validUntil)}`);
    if (v.insurance.annualCost != null) lines.push(`   Kosten/Jahr: ${v.insurance.annualCost} €`);
  }

  if (v.serviceLog.length) {
    lines.push('');
    lines.push(`🔧 Service-Historie (${v.serviceLog.length}):`);
    for (const s of v.serviceLog.slice(0, 5)) {
      const km = s.mileage != null ? ` | ${s.mileage.toLocaleString('de')} km` : '';
      const cost = s.cost != null ? ` | ${s.cost} €` : '';
      const notes = s.notes ? ` — ${s.notes}` : '';
      lines.push(`   • ${formatDE(s.date)} ${s.type}${km}${cost}${notes}`);
    }
    if (v.serviceLog.length > 5) lines.push(`   ... und ${v.serviceLog.length - 5} weitere`);
  }

  if (v.tuevRecords.length) {
    lines.push('');
    lines.push(`🔍 TÜV-Historie (${v.tuevRecords.length}):`);
    for (const t of v.tuevRecords.slice(0, 3)) {
      const date = t.inspectionDate ? formatDE(t.inspectionDate) : '–';
      const result = t.result === 'pass' ? '✅' : t.result === 'fail' ? '❌' : t.result === 'conditional' ? '⚠️' : '';
      const next = t.nextDueDate ? ` → nächster: ${formatDE(t.nextDueDate)}` : '';
      lines.push(`   • ${date} ${result}${next}`);
    }
  }

  if (v.documents.length) {
    lines.push('');
    lines.push(`📎 Dokumente (${v.documents.length}):`);
    for (const d of v.documents) {
      lines.push(`   • ${d.title} (${d.docType})`);
    }
  }

  lines.push('');
  lines.push(`ID: \`${v.vehicleCode}\` | Status: ${v.status} | Erstellt: ${formatDE(v.createdAt)}`);

  return lines.join('\n');
}
