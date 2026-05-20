/**
 * Banking Approval-Hard-Rule CI-Test (Sprint 2.10-B Etappe e0)
 *
 * Verifies that all banking mutation endpoints require approval.
 * This test MUST remain green — CI rejects merge if it fails or is removed.
 *
 * Pattern analog src/modules/instagram/__tests__/approval-hard-rule.test.ts
 *
 * Three scenarios:
 * a) banking-connect.initiate requiresApproval = true
 * b) banking-accounts.archive requiresApproval = true
 * c) banking-accounts.delete  requiresApproval = true
 */
import { describe, test, expect } from 'bun:test';
import { requiresApproval, getApprovalSpec } from '../../../middleware/approval-registry.js';

describe('Banking Approval-Hard-Rule (Sprint 2.10-B)', () => {
  test('a) banking-connect.initiate requires approval', () => {
    expect(requiresApproval('banking-connect.initiate')).toBe(true);

    const spec = getApprovalSpec('banking-connect.initiate');
    expect(spec).toBeDefined();
    expect(spec!.method).toBe('POST');
    expect(spec!.pathPattern).toBe('/api/banking/connect');
  });

  test('b) banking-accounts.archive requires approval', () => {
    expect(requiresApproval('banking-accounts.archive')).toBe(true);

    const spec = getApprovalSpec('banking-accounts.archive');
    expect(spec).toBeDefined();
    expect(spec!.method).toBe('POST');
    expect(spec!.pathPattern).toBe('/api/banking/accounts/:id/archive');
  });

  test('c) banking-accounts.delete requires approval', () => {
    expect(requiresApproval('banking-accounts.delete')).toBe(true);

    const spec = getApprovalSpec('banking-accounts.delete');
    expect(spec).toBeDefined();
    expect(spec!.method).toBe('DELETE');
    expect(spec!.pathPattern).toBe('/api/banking/accounts/:id');
  });
});
