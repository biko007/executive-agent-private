/**
 * Instagram Store DB Roundtrip Test (Sprint 3 §6.1)
 *
 * Verifies: insert → query → update → query cycle works correctly
 * against a real Postgres test database (no temp-HOME file tricks).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let createDraft: typeof import('../store.js')['createDraft'];
let loadDraft: typeof import('../store.js')['loadDraft'];
let saveDraft: typeof import('../store.js')['saveDraft'];
let listDrafts: typeof import('../store.js')['listDrafts'];
let validateDraftApproval: typeof import('../store.js')['validateDraftApproval'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  const store = await import('../store.js');
  createDraft = store.createDraft;
  loadDraft = store.loadDraft;
  saveDraft = store.saveDraft;
  listDrafts = store.listDrafts;
  validateDraftApproval = store.validateDraftApproval;
});

afterAll(async () => {
  await cleanup();
});

describe('Instagram Store Roundtrip (Sprint 3 §6.1)', () => {
  test('insert → load → update → load roundtrip', async () => {
    // 1. Insert
    const draft = await createDraft({ caption: 'Roundtrip test caption' });
    expect(draft.id).toBeTruthy();
    expect(draft.status).toBe('draft');
    expect(draft.caption).toBe('Roundtrip test caption');

    // 2. Load from DB
    const loaded = await loadDraft(draft.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(draft.id);
    expect(loaded!.caption).toBe('Roundtrip test caption');
    expect(loaded!.status).toBe('draft');

    // 3. Update
    loaded!.caption = 'Updated caption';
    loaded!.hashtags = ['test', 'roundtrip'];
    loaded!.status = 'approved' as any;
    await saveDraft(loaded!);

    // 4. Load again — verify update persisted in DB
    const reloaded = await loadDraft(draft.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.caption).toBe('Updated caption');
    expect(reloaded!.hashtags).toEqual(['test', 'roundtrip']);
    expect(reloaded!.status).toBe('approved');
  });

  test('listDrafts filters by status', async () => {
    const d1 = await createDraft({ caption: 'Alpengluehen filter test' });
    const d2 = await createDraft({ caption: 'Bergwanderung filter test' });
    d2.status = 'approved' as any;
    await saveDraft(d2);

    const allDrafts = await listDrafts('draft');
    const allApproved = await listDrafts('approved');

    // d1 should be in drafts, d2 should be in approved
    expect(allDrafts.some((d: any) => d.id === d1.id)).toBe(true);
    expect(allApproved.some((d: any) => d.id === d2.id)).toBe(true);
    expect(allDrafts.some((d: any) => d.id === d2.id)).toBe(false);
  });

  test('validateDraftApproval enforces approved status', async () => {
    const draft = await createDraft({ caption: 'Approval roundtrip' });
    expect(() => validateDraftApproval(draft)).toThrow('approval required');

    draft.status = 'approved' as any;
    await saveDraft(draft);
    const loaded = (await loadDraft(draft.id))!;
    expect(() => validateDraftApproval(loaded)).not.toThrow();
  });

  test('loadDraft returns null for non-existent id', async () => {
    const result = await loadDraft('nonexistent-id-12345');
    expect(result).toBeNull();
  });

  test('listDrafts respects limit', async () => {
    // Create several drafts
    await createDraft({ caption: 'Limit test eins' });
    await createDraft({ caption: 'Limit test zwei' });
    await createDraft({ caption: 'Limit test drei' });

    const limited = await listDrafts(undefined, 2);
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});
