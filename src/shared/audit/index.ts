/**
 * shared/audit — Audit log writer
 *
 * Mandatory for all state-changing operations:
 * - Banking: transactions, matches, CSV uploads
 * - Instagram: approvals, posts, rejections
 * - Assets: tenants, leases, cost billings
 * - Health: manual symptom entries
 * - Auth: token rotation, login attempts
 *
 * NOT logged: Withings auto-sync, weather, briefings, read-only queries.
 */
import { query } from '../db/index.js';
import { getRequestId, getCorrelationId, getActor, getSource } from '../correlation/index.js';

export interface AuditEntry {
  actor?: string;
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: string;
  correlationId?: string;
  requestId?: string;
}

// ── Sensitive field masking ────────────────────────────────────────────────

/** Fields that are safe to log unmasked. Everything else matching sensitive patterns gets masked. */
const SAFE_FIELDS = new Set([
  'id', 'code', 'name', 'street', 'postal_code', 'city', 'country',
  'property_type', 'owner', 'heating_type', 'billing_period_start_month',
  'co2_cost_relevant', 'active', 'archived', 'archived_at', 'status',
  'unit_id', 'property_id', 'lease_id', 'tenant_id', 'meter_id',
  'cost_category_id', 'allocation_rule_id',
  'start_date', 'end_date', 'move_in', 'move_out', 'actual_move_out',
  'ownership_start', 'ownership_end',
  'living_area_qm', 'rooms', 'floor', 'position', 'unit_type',
  'medium', 'meter_number', 'is_main_meter', 'submetering_purpose',
  'reading_type', 'read_at', 'value', 'is_estimated',
  'key_type', 'base_share_percent', 'consumption_share_percent',
  'share_value', 'valid_from', 'valid_until',
  'charge_type', 'amount', 'amount_cents', 'currency', 'interval',
  'service_period_start', 'service_period_end',
  'year', 'due_date', 'result_amount', 'served_at',
  'billing_mode', 'rent_amount', 'prepayment_amount',
  'notes', 'description', 'label',
  'created_at', 'updated_at', 'ts',
  'first_name', 'last_name', 'company_name', 'tenant_type', 'salutation',
  'is_primary_contact', 'resident_count',
  'co2_emissions_kg', 'co2_cost_total', 'hot_water_via_heating',
  'heating_system', 'energy_source', 'fuel_type',
  'calibration_valid_until', 'installation_date',
  // Fleet (Sprint 6c)
  'vehicle_id', 'vehicle_code', 'display_name', 'license_plate', 'make', 'model',
  'first_registration', 'holder', 'current_mileage_km',
  'archived_at', 'archived_reason', 'source_payload',
  'service_date', 'service_type', 'workshop', 'cost', 'document_url',
  'company', 'coverage_type', 'annual_premium',
  'tax_year', 'paid_at',
  'inspection_date', 'result', 'next_due_date',
  'doc_type', 'title', 'url',
  'created_by', 'updated_by',
  // Banking (Sprint 7b)
  'institution_id', 'account_id', 'account_type', 'display_name', 'owner_name',
  'current_balance', 'last_sync_at', 'booking_date', 'value_date',
  'counterparty_name', 'reference', 'transaction_code', 'bank_transaction_id',
  'raw_payload', 'imported_at', 'blz', 'bic', 'fints_url',
  'key_version', 'tan_medium_name', 'product_id', 'session_format',
  'fints_lib_version', 'session_expires_at', 'last_success_at',
]);

/** Fields where only the last 4 characters are shown, rest masked as ***. */
const TAIL_MASK_FIELDS = new Set([
  'vin', 'policy_number',
  // Banking (Sprint 7b)
  'iban', 'account_number', 'counterparty_iban',
]);

/** Fields stripped entirely from audit payloads (encrypted data — never logged, not even masked). */
const STRIP_FIELDS = new Set([
  // Banking (Sprint 7b) — encrypted at-rest, must not appear in audit
  'user_id_encrypted', 'pin_encrypted', 'session_state_encrypted',
]);

/** Patterns that indicate a sensitive value regardless of field name. */
const SENSITIVE_PATTERNS = [
  /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/,  // IBAN
  /\b[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?\b/,       // BIC/SWIFT
  /\bBearer\s+[a-zA-Z0-9._\-]+/i,                          // Bearer token
  /\b[a-f0-9]{32,}\b/,                                      // hex tokens/hashes (32+ chars)
];

function isSensitiveValue(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  return SENSITIVE_PATTERNS.some(p => p.test(val));
}

/**
 * Recursively mask sensitive fields in an object.
 * Safe-listed field names pass through; others matching sensitive patterns get masked.
 */
export function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (STRIP_FIELDS.has(key)) {
      continue; // encrypted fields — never logged
    } else if (val == null) {
      result[key] = val;
    } else if (TAIL_MASK_FIELDS.has(key) && typeof val === 'string') {
      result[key] = val.length > 4 ? '***' + val.slice(-4) : '***';
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      result[key] = maskSensitiveFields(val as Record<string, unknown>);
    } else if (SAFE_FIELDS.has(key)) {
      result[key] = val;
    } else if (isSensitiveValue(val)) {
      result[key] = '***';
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Write an audit log entry.
 * Auto-injects requestId, correlationId, actor, source from AsyncLocalStorage
 * if not explicitly provided. Applies whitelist masking to before/after payloads.
 */
export async function log(entry: AuditEntry): Promise<void> {
  const requestId = entry.requestId ?? getRequestId();
  const correlationId = entry.correlationId ?? getCorrelationId();
  const actor = entry.actor ?? getActor();
  const source = entry.source ?? getSource();

  const maskedBefore = entry.before ? maskSensitiveFields(entry.before) : null;
  const maskedAfter = entry.after ? maskSensitiveFields(entry.after) : null;

  await query(
    `INSERT INTO audit_log
       (actor, module, action, entity_type, entity_id,
        before_jsonb, after_jsonb, source, correlation_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor,
      entry.module,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      maskedBefore ? JSON.stringify(maskedBefore) : null,
      maskedAfter ? JSON.stringify(maskedAfter) : null,
      source,
      correlationId,
      requestId,
    ],
  );
}

/**
 * Query recent audit entries for an entity.
 */
export async function getHistory(
  entityType: string,
  entityId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  const { rows } = await query(
    `SELECT actor, module, action, entity_type, entity_id,
            before_jsonb AS before, after_jsonb AS after,
            source, correlation_id, request_id, ts
     FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY ts DESC
     LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows;
}
