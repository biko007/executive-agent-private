/**
 * banking/commands — Telegram command handlers for the Banking module.
 * Sprint 7b Etappe d: /banking, /banking connect, /tan ok, /tan <code>.
 *
 * Hard rules:
 *   - /banking connect NEVER accepts PIN/User-ID in Telegram — only sends Dashboard deep-link
 *   - TAN code values NEVER persisted or logged — in-memory only, audit with after: null
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { listInstitutions, listAccounts } from './store.js';
import { completeTan } from './tan-bridge.js';
import type { SessionRow } from './types.js';

// ── Dependencies injected from index.ts ────────────────────────────────────

export interface BankingCommandDeps {
  sendTelegram: (chatId: string, text: string) => Promise<boolean>;
  telegramChatId: () => string | undefined;
}

let _deps: BankingCommandDeps | null = null;

export function initBankingCommands(deps: BankingCommandDeps): void {
  _deps = deps;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Find the session with a pending challenge (single-user system — at most one). */
async function findPendingChallengeSession(): Promise<{ id: number; type: string } | null> {
  const { rows } = await dbQuery<Pick<SessionRow, 'id' | 'pending_challenge_type'>>(
    `SELECT id, pending_challenge_type FROM banking_sessions
     WHERE pending_challenge_type IS NOT NULL
     ORDER BY pending_challenge_at DESC LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id as number, type: rows[0].pending_challenge_type! };
}

// ── Command handlers ───────────────────────────────────────────────────────

/** /banking — Status overview: institutions, accounts, pending challenges. */
async function handleBankingStatus(): Promise<{ text: string }> {
  const institutions = await listInstitutions();
  const accounts = await listAccounts({ status: 'active' });
  const pending = await findPendingChallengeSession();

  const lines: string[] = ['🏦 Banking Status\n'];

  if (institutions.length === 0) {
    lines.push('Keine Banken konfiguriert.');
  } else {
    lines.push(`${institutions.length} Bank(en):`);
    for (const inst of institutions) {
      const instAccounts = accounts.filter(a => a.institutionId === inst.id);
      lines.push(`  • ${inst.name} (BLZ ${inst.blz}) — ${instAccounts.length} Konto(en)`);
    }
  }

  if (accounts.length > 0) {
    lines.push(`\n${accounts.length} aktive(s) Konto(en):`);
    for (const acct of accounts) {
      const balance = acct.currentBalance != null
        ? ` — ${acct.currentBalance.toLocaleString('de-DE', { minimumFractionDigits: 2 })} ${acct.currency}`
        : '';
      lines.push(`  • ${acct.displayName} (${acct.iban.slice(-4)})${balance}`);
    }
  }

  if (pending) {
    lines.push(`\n⏳ Ausstehende TAN-Challenge: ${pending.type}`);
    lines.push('Verwende /tan ok oder /tan <code> zum Bestätigen.');
  }

  return { text: lines.join('\n') };
}

/**
 * /banking connect — NEVER accepts credentials in Telegram.
 * Only sends a Dashboard deep-link.
 */
async function handleBankingConnect(): Promise<{ text: string }> {
  const dashboardToken = process.env.DASHBOARD_TOKEN || '';
  const text = `🏦 Bank verbinden:\nhttps://app.bikobickel.de/dashboard/?token=${dashboardToken}&tab=banking-connect\n\nBitte dort BLZ, Benutzerkennung und PIN eingeben.`;
  return { text };
}

/** /tan ok — For pushTAN: confirm the pending challenge. */
async function handleTanOk(): Promise<{ text: string }> {
  const pending = await findPendingChallengeSession();
  if (!pending) {
    return { text: '❌ Keine ausstehende TAN-Challenge.' };
  }

  const result = await completeTan(pending.id, 'pushTAN_confirmed');

  if (result.status === 'connected') {
    return { text: `✅ Verbindung erfolgreich! ${result.accountCount ?? 0} Konto(en) gefunden.` };
  }
  return { text: `❌ Fehler: ${result.error || 'Unbekannter Fehler'}` };
}

/** /tan <code> — For code-based TAN: submit the TAN code. */
async function handleTanCode(code: string): Promise<{ text: string }> {
  const pending = await findPendingChallengeSession();
  if (!pending) {
    return { text: '❌ Keine ausstehende TAN-Challenge.' };
  }

  if (!code.trim()) {
    return { text: '❌ Bitte TAN-Code angeben: /tan <code>' };
  }

  const result = await completeTan(pending.id, code.trim());

  if (result.status === 'connected') {
    return { text: `✅ Verbindung erfolgreich! ${result.accountCount ?? 0} Konto(en) gefunden.` };
  }
  // TAN value NEVER in response text
  return { text: `❌ Fehler: ${result.error || 'Unbekannter Fehler'}` };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerBankingCommands(api: any): void {
  api.registerCommand({
    name: 'banking',
    acceptsArgs: true,
    description: 'Banking-Status anzeigen oder /banking connect',
    handler: async (ctx: any) => {
      try {
        const args = String(ctx.args || '').trim().toLowerCase();
        if (args === 'connect') {
          return await handleBankingConnect();
        }
        return await handleBankingStatus();
      } catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'tan',
    acceptsArgs: true,
    description: 'TAN bestätigen: /tan ok oder /tan <code>',
    handler: async (ctx: any) => {
      try {
        const args = String(ctx.args || '').trim();
        if (args.toLowerCase() === 'ok') {
          return await handleTanOk();
        }
        return await handleTanCode(args);
      } catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });
}
