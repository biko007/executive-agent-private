/**
 * middleware/approval-registry — Approval endpoint configuration.
 * Defines which mutation endpoints require approval previews.
 */

export interface ApprovalSpec {
  endpointKey: string;
  method: string;
  pathPattern: string;
  requiresApproval: boolean;
  idempotency: boolean;
  description: string;
}

/**
 * Registry of all mutation endpoints and their approval requirements.
 * Each endpoint that mutates data must be listed here.
 */
export const APPROVAL_ENDPOINTS: Record<string, ApprovalSpec> = {
  // Properties
  'properties.update': { endpointKey: 'properties.update', method: 'PATCH', pathPattern: '/api/assets/properties/:id', requiresApproval: true, idempotency: false, description: 'Update property details' },

  // Units
  'units.create': { endpointKey: 'units.create', method: 'POST', pathPattern: '/api/assets/properties/:id/units', requiresApproval: true, idempotency: false, description: 'Create unit' },
  'units.update': { endpointKey: 'units.update', method: 'PATCH', pathPattern: '/api/assets/properties/:id/units/:unitId', requiresApproval: true, idempotency: false, description: 'Update unit' },
  'units.archive': { endpointKey: 'units.archive', method: 'POST', pathPattern: '/api/assets/properties/:id/units/:unitId/archive', requiresApproval: true, idempotency: false, description: 'Archive unit' },

  // Unit Residents
  'unit-residents.create': { endpointKey: 'unit-residents.create', method: 'POST', pathPattern: '/api/assets/properties/:id/units/:unitId/residents', requiresApproval: false, idempotency: false, description: 'Add resident to unit' },
  'unit-residents.update': { endpointKey: 'unit-residents.update', method: 'PATCH', pathPattern: '/api/assets/properties/:id/units/:unitId/residents', requiresApproval: false, idempotency: false, description: 'Update resident entry' },

  // Tenants
  'tenants.create': { endpointKey: 'tenants.create', method: 'POST', pathPattern: '/api/assets/tenants', requiresApproval: true, idempotency: false, description: 'Create tenant' },
  'tenants.update': { endpointKey: 'tenants.update', method: 'PATCH', pathPattern: '/api/assets/tenants/:id', requiresApproval: true, idempotency: false, description: 'Update tenant' },
  'tenants.archive': { endpointKey: 'tenants.archive', method: 'POST', pathPattern: '/api/assets/tenants/:id/archive', requiresApproval: true, idempotency: false, description: 'Archive tenant' },

  // Leases
  'leases.create': { endpointKey: 'leases.create', method: 'POST', pathPattern: '/api/assets/leases', requiresApproval: true, idempotency: false, description: 'Create lease' },
  'leases.update': { endpointKey: 'leases.update', method: 'PATCH', pathPattern: '/api/assets/leases/:id', requiresApproval: true, idempotency: false, description: 'Update lease' },
  'leases.end': { endpointKey: 'leases.end', method: 'POST', pathPattern: '/api/assets/leases/:id/end', requiresApproval: true, idempotency: false, description: 'End lease' },
  'leases.revoke-end': { endpointKey: 'leases.revoke-end', method: 'POST', pathPattern: '/api/assets/leases/:id/revoke-end', requiresApproval: true, idempotency: false, description: 'Revoke lease termination' },
  'leases.move-out': { endpointKey: 'leases.move-out', method: 'POST', pathPattern: '/api/assets/leases/:id/move-out', requiresApproval: true, idempotency: false, description: 'Record move-out' },

  // Lease Charges
  'lease-charges.create': { endpointKey: 'lease-charges.create', method: 'POST', pathPattern: '/api/assets/leases/:id/charges', requiresApproval: true, idempotency: false, description: 'Create lease charge' },

  // Expense Bookings
  'expense-bookings.create': { endpointKey: 'expense-bookings.create', method: 'POST', pathPattern: '/api/assets/properties/:id/expense-bookings', requiresApproval: true, idempotency: false, description: 'Create expense booking' },

  // Allocation Rules
  'allocation-rules.create': { endpointKey: 'allocation-rules.create', method: 'POST', pathPattern: '/api/assets/properties/:id/allocation-rules', requiresApproval: true, idempotency: false, description: 'Create allocation rule' },
  'allocation-rules.update': { endpointKey: 'allocation-rules.update', method: 'PATCH', pathPattern: '/api/assets/allocation-rules/:id', requiresApproval: true, idempotency: false, description: 'Update allocation rule' },
  'allocation-rules.archive': { endpointKey: 'allocation-rules.archive', method: 'POST', pathPattern: '/api/assets/allocation-rules/:id/archive', requiresApproval: true, idempotency: false, description: 'Archive allocation rule' },

  // Allocation Shares
  'allocation-shares.create': { endpointKey: 'allocation-shares.create', method: 'POST', pathPattern: '/api/assets/allocation-rules/:id/shares', requiresApproval: false, idempotency: false, description: 'Create allocation share' },
  'allocation-shares.update': { endpointKey: 'allocation-shares.update', method: 'PATCH', pathPattern: '/api/assets/allocation-rules/:id/shares/:shareId', requiresApproval: false, idempotency: false, description: 'Update allocation share' },

  // Meters
  'meters.create': { endpointKey: 'meters.create', method: 'POST', pathPattern: '/api/assets/meters', requiresApproval: true, idempotency: false, description: 'Create meter' },
  'meters.update': { endpointKey: 'meters.update', method: 'PATCH', pathPattern: '/api/assets/meters/:id', requiresApproval: true, idempotency: false, description: 'Update meter' },
  'meters.archive': { endpointKey: 'meters.archive', method: 'POST', pathPattern: '/api/assets/meters/:id/archive', requiresApproval: true, idempotency: false, description: 'Archive meter' },

  // Meter Readings
  'meter-readings.create': { endpointKey: 'meter-readings.create', method: 'POST', pathPattern: '/api/assets/meters/:id/readings', requiresApproval: false, idempotency: false, description: 'Create meter reading' },
  'meter-readings.bulk': { endpointKey: 'meter-readings.bulk', method: 'POST', pathPattern: '/api/assets/meters/:id/readings/bulk', requiresApproval: false, idempotency: false, description: 'Bulk create meter readings' },
  'meter-readings.update': { endpointKey: 'meter-readings.update', method: 'PATCH', pathPattern: '/api/assets/meters/:id/readings', requiresApproval: false, idempotency: false, description: 'Update meter reading' },

  // Heating Config
  'heating-config.upsert': { endpointKey: 'heating-config.upsert', method: 'PUT', pathPattern: '/api/assets/properties/:id/heating-config', requiresApproval: true, idempotency: false, description: 'Set heating configuration' },

  // NK Period Obligations
  'nk-obligations.update': { endpointKey: 'nk-obligations.update', method: 'PATCH', pathPattern: '/api/assets/nk-period-obligations/:id', requiresApproval: true, idempotency: false, description: 'Update NK obligation status' },

  // Lease Changeovers (composite)
  'lease-changeovers.create': { endpointKey: 'lease-changeovers.create', method: 'POST', pathPattern: '/api/assets/lease-changeovers', requiresApproval: true, idempotency: true, description: 'Lease changeover (composite)' },

  // Approval Preview
  'approval-preview.create': { endpointKey: 'approval-preview.create', method: 'POST', pathPattern: '/api/assets/approval-preview', requiresApproval: false, idempotency: false, description: 'Create approval preview token' },
};

/**
 * Get the approval spec for a given endpoint key.
 */
export function getApprovalSpec(endpointKey: string): ApprovalSpec | undefined {
  return APPROVAL_ENDPOINTS[endpointKey];
}

/**
 * Check if an endpoint requires approval.
 */
export function requiresApproval(endpointKey: string): boolean {
  const spec = APPROVAL_ENDPOINTS[endpointKey];
  return spec?.requiresApproval ?? false;
}

/**
 * Boot-time coverage check: verify all registered endpoint keys are in the registry.
 * Called during Core startup to fail fast on missing entries.
 */
export function validateCoverage(registeredEndpointKeys: string[]): string[] {
  const missing: string[] = [];
  for (const key of registeredEndpointKeys) {
    if (!APPROVAL_ENDPOINTS[key]) {
      missing.push(key);
    }
  }
  return missing;
}
