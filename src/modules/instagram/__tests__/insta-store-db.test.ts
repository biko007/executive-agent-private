/**
 * Instagram Store DB Roundtrip Test (Sprint 3 §6.1)
 *
 * Verifies: insert → query → update → query cycle works correctly.
 * Uses temp HOME dir to isolate file-based fallback.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set HOME to temp dir BEFORE importing instagram-store
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-db-test-'));
const origHome = process.env.HOME;
process.env.HOME = TEST_HOME;

const { createDraft, saveDraft, loadDraft, listDrafts, validateDraftApproval } = await import('../../../../instagram-store.js');

describe('Instagram Store Roundtrip (Sprint 3 §6.1)', () => {
  afterAll(() => {
    process.env.HOME = origHome;
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  test('insert → load → update → load roundtrip', () => {
    // 1. Insert
    const draft = createDraft({ caption: 'Roundtrip test caption' });
    expect(draft.id).toBeTruthy();
    expect(draft.status).toBe('draft');
    expect(draft.caption).toBe('Roundtrip test caption');

    // 2. Load
    const loaded = loadDraft(draft.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(draft.id);
    expect(loaded!.caption).toBe('Roundtrip test caption');
    expect(loaded!.status).toBe('draft');

    // 3. Update
    loaded!.caption = 'Updated caption';
    loaded!.hashtags = ['test', 'roundtrip'];
    loaded!.status = 'approved' as any;
    saveDraft(loaded!);

    // 4. Load again
    const reloaded = loadDraft(draft.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.caption).toBe('Updated caption');
    expect(reloaded!.hashtags).toEqual(['test', 'roundtrip']);
    expect(reloaded!.status).toBe('approved');
  });

  test('listDrafts filters by status', () => {
    const d1 = createDraft({ caption: 'Alpengluehen filter test' });
    const d2 = createDraft({ caption: 'Bergwanderung filter test' });
    d2.status = 'approved' as any;
    saveDraft(d2);

    const allDrafts = listDrafts('draft');
    const allApproved = listDrafts('approved');

    // d1 should be in drafts, d2 should be in approved
    expect(allDrafts.some((d: any) => d.id === d1.id)).toBe(true);
    expect(allApproved.some((d: any) => d.id === d2.id)).toBe(true);
    expect(allDrafts.some((d: any) => d.id === d2.id)).toBe(false);
  });

  test('validateDraftApproval enforces approved status', () => {
    const draft = createDraft({ caption: 'Approval roundtrip' });
    expect(() => validateDraftApproval(draft)).toThrow('approval required');

    draft.status = 'approved' as any;
    saveDraft(draft);
    const loaded = loadDraft(draft.id)!;
    expect(() => validateDraftApproval(loaded)).not.toThrow();
  });
});
