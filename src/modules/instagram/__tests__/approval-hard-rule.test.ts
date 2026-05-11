/**
 * Approval-Hard-Rule Test (Spec §17.2)
 *
 * Verifies that Instagram posts CANNOT be published without prior approval.
 * This test MUST remain green — CI rejects merge if it fails or is removed.
 *
 * Uses a real Postgres test database (no temp-HOME file tricks).
 *
 * Three scenarios:
 * a) Draft without approval → publish() throws "approval required"
 * b) Draft with approval (status=approved) → publish() passes validation
 * c) Draft with revoked approval → publish() throws "approval required"
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let createDraft: typeof import('../store.js')['createDraft'];
let publish: typeof import('../store.js')['publish'];
let saveDraft: typeof import('../store.js')['saveDraft'];
let validateDraftApproval: typeof import('../store.js')['validateDraftApproval'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  // Import store AFTER POSTGRES_URL points to test DB
  const store = await import('../store.js');
  createDraft = store.createDraft;
  publish = store.publish;
  saveDraft = store.saveDraft;
  validateDraftApproval = store.validateDraftApproval;
});

afterAll(async () => {
  await cleanup();
});

describe('Approval-Hard-Rule (Spec §17.2)', () => {
  test('a) cannot post without approval — draft status "draft"', async () => {
    const draft = await createDraft({ caption: 'Test post without approval' });
    expect(draft.status).toBe('draft');

    await expect(publish(draft.id)).rejects.toThrow('approval required');
  });

  test('b) can post with approval — draft status "approved"', async () => {
    const draft = await createDraft({ caption: 'Test post with approval' });
    draft.status = 'approved' as any;
    await saveDraft(draft);

    // publish() should pass approval validation and return the draft
    const result = await publish(draft.id);
    expect(result.status).toBe('approved');
    expect(result.id).toBe(draft.id);
  });

  test('c) cannot post with revoked approval — status reset to "draft"', async () => {
    const draft = await createDraft({ caption: 'Test post with revoked approval' });
    // First approve, then revoke
    draft.status = 'approved' as any;
    await saveDraft(draft);
    draft.status = 'draft' as any;
    await saveDraft(draft);

    await expect(publish(draft.id)).rejects.toThrow('approval required');
  });

  test('validateDraftApproval throws for unapproved draft', async () => {
    const draft = await createDraft({ caption: 'Direct validation test' });
    expect(() => validateDraftApproval(draft)).toThrow('approval required');
  });

  test('validateDraftApproval passes for approved draft', async () => {
    const draft = await createDraft({ caption: 'Direct validation approved' });
    draft.status = 'approved' as any;
    expect(() => validateDraftApproval(draft)).not.toThrow();
  });
});
