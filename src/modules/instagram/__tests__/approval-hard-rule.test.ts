/**
 * Approval-Hard-Rule Test (Spec §17.2)
 *
 * Verifies that Instagram posts CANNOT be published without prior approval.
 * This test MUST remain green — CI rejects merge if it fails or is removed.
 *
 * Three scenarios:
 * a) Draft without approval → publish() throws "approval required"
 * b) Draft with approval (status=approved) → publish() passes validation
 * c) Draft with revoked approval → publish() throws "approval required"
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set HOME to temp dir BEFORE importing instagram-store (which reads HOME at import time)
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
const origHome = process.env.HOME;
process.env.HOME = TEST_HOME;

// Now import — paths will resolve to TEST_HOME
const { createDraft, publish, saveDraft, validateDraftApproval } = await import('../../../../instagram-store.js');

describe('Approval-Hard-Rule (Spec §17.2)', () => {
  afterAll(() => {
    // Restore HOME and clean up temp dir
    process.env.HOME = origHome;
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  test('a) cannot post without approval — draft status "draft"', async () => {
    const draft = createDraft({ caption: 'Test post without approval' });
    expect(draft.status).toBe('draft');

    await expect(publish(draft.id)).rejects.toThrow('approval required');
  });

  test('b) can post with approval — draft status "approved"', async () => {
    const draft = createDraft({ caption: 'Test post with approval' });
    draft.status = 'approved';
    saveDraft(draft);

    // publish() should pass approval validation and return the draft
    const result = await publish(draft.id);
    expect(result.status).toBe('approved');
    expect(result.id).toBe(draft.id);
  });

  test('c) cannot post with revoked approval — status reset to "draft"', async () => {
    const draft = createDraft({ caption: 'Test post with revoked approval' });
    // First approve, then revoke
    draft.status = 'approved';
    saveDraft(draft);
    draft.status = 'draft';
    saveDraft(draft);

    await expect(publish(draft.id)).rejects.toThrow('approval required');
  });

  test('validateDraftApproval throws for unapproved draft', () => {
    const draft = createDraft({ caption: 'Direct validation test' });
    expect(() => validateDraftApproval(draft)).toThrow('approval required');
  });

  test('validateDraftApproval passes for approved draft', () => {
    const draft = createDraft({ caption: 'Direct validation approved' });
    draft.status = 'approved';
    expect(() => validateDraftApproval(draft)).not.toThrow();
  });
});
