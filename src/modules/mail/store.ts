/**
 * mail/store — file-based draft store + processed-mail deduplication store.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MailDraft, Account, ProcessedMails } from './types.js';

let draftsDir = '';
let processedMailPath = '';

/** Must be called once before any store operation. */
export function initMailStore(workspace: string): void {
  draftsDir = path.join(workspace, 'artifacts', 'mail-drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  processedMailPath = path.join(workspace, 'artifacts', 'personal', 'mail-parsing', 'processed.json');
}

// ── Draft Store ───────────────────────────────────────────────────────────

const draftPath = (id: string) => path.join(draftsDir, `${id}.json`);

export function saveDraft(d: MailDraft): void {
  fs.writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2), 'utf-8');
}

export function loadDraft(id: string): MailDraft | null {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export function listDrafts(status?: MailDraft['status'], limit: number = 5): MailDraft[] {
  if (!fs.existsSync(draftsDir)) return [];
  const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.json'));
  const out: MailDraft[] = [];

  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(draftsDir, f), 'utf-8');
      const d = JSON.parse(raw);
      if (!d?.id || !d?.status) continue;
      if (status && d.status !== status) continue;
      out.push(d as MailDraft);
    } catch {
      // ignore broken draft file
    }
  }

  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, Math.max(1, Math.min(20, limit)));
}

// ── Processed-Mail Deduplication Store ────────────────────────────────────

export function loadProcessed(): ProcessedMails {
  try {
    if (fs.existsSync(processedMailPath)) {
      return JSON.parse(fs.readFileSync(processedMailPath, 'utf-8'));
    }
  } catch {}
  return { version: 1, ids: [] };
}

export function saveProcessed(p: ProcessedMails): void {
  fs.mkdirSync(path.dirname(processedMailPath), { recursive: true });
  fs.writeFileSync(processedMailPath, JSON.stringify(p, null, 2), 'utf-8');
}

export function isProcessed(source: Account, id: string): boolean {
  const key = `${source}::${id}`;
  return loadProcessed().ids.includes(key);
}

export function markProcessed(source: Account, id: string): void {
  const p = loadProcessed();
  const key = `${source}::${id}`;
  if (!p.ids.includes(key)) {
    p.ids.push(key);
    if (p.ids.length > 2000) p.ids = p.ids.slice(-2000);
    saveProcessed(p);
  }
}
