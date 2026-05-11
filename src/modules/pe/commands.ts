/**
 * pe/commands — Telegram command handlers for Private Equity module.
 */
import {
  getAllInvestments, getInvestment, createInvestment, updateInvestment,
  addValuation, getValuationHistory, calculateIRR,
  formatInvestmentList, formatInvestmentDetail,
} from './store.js';

// ── Command handlers ───────────────────────────────────────────────────────

export function handlePE(): { text: string } {
  const investments = getAllInvestments();
  return { text: formatInvestmentList(investments) };
}

export function handlePEShow(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /peshow <id>' };
  const inv = getInvestment(id);
  if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
  const history = getValuationHistory(id);
  let text = formatInvestmentDetail(inv);
  if (history.length) {
    text += '\n\n📊 Bewertungshistorie:\n';
    for (const h of history.slice(-10)) {
      const amt = h.amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      text += `   • ${h.date} — ${amt} € (${h.method || '–'})${h.notes ? ' — ' + h.notes : ''}\n`;
    }
    if (history.length > 10) text += `   ... und ${history.length - 10} weitere\n`;
  }
  return { text };
}

export function handlePENew(argsStr: string): { text: string } {
  const parts = argsStr.trim().split(/\s+/);
  if (parts.length < 5) return { text: '❌ Verwendung: /penew <Firma> <Sektor> <Betrag> <Anteile> <Gesamt-Anteile>\nBeispiel: /penew TobaGrown Cannabis 50000 500 10000' };
  const [company, sector, amtStr, sharesStr, totalStr] = parts;
  const amount = Number(amtStr);
  const shares = Number(sharesStr);
  const total = Number(totalStr);
  if (!Number.isFinite(amount) || amount <= 0) return { text: '❌ Betrag muss eine positive Zahl sein.' };
  if (!Number.isFinite(shares) || shares <= 0) return { text: '❌ Anteile müssen eine positive Zahl sein.' };
  if (!Number.isFinite(total) || total <= 0) return { text: '❌ Gesamt-Anteile müssen eine positive Zahl sein.' };
  const inv = createInvestment(company, sector.replace(/-/g, ' / '), amount, shares, total);
  return { text: `✅ Beteiligung angelegt!\n\n${formatInvestmentDetail(inv)}` };
}

export function handlePEEdit(argsStr: string): { text: string } {
  const parts = argsStr.trim().split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /peedit <id> <feld> <wert>\nFelder: company, sector, status, contact, notes, shares, ownershipPct' };
  const [id, field, ...rest] = parts;
  const value = rest.join(' ');
  const inv = getInvestment(id);
  if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
  const allowed: Record<string, string> = {
    company: 'company', sector: 'sector', status: 'status',
    contact: 'contactPerson', notes: 'notes',
    shares: 'shares', ownershippct: 'ownershipPct',
  };
  const key = allowed[field.toLowerCase()];
  if (!key) return { text: `❌ Unbekanntes Feld: ${field}\nErlaubt: ${Object.keys(allowed).join(', ')}` };
  let patch: any = {};
  if (key === 'shares') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return { text: '❌ Anteile müssen eine Zahl sein.' };
    patch.shares = n;
  } else if (key === 'status') {
    if (!['active', 'exited', 'written-off'].includes(value)) return { text: '❌ Status: active | exited | written-off' };
    patch.status = value;
  } else {
    patch[key] = value;
  }
  const updated = updateInvestment(id, patch);
  return { text: `✅ Aktualisiert: ${field} → ${value}\n\n${formatInvestmentDetail(updated!)}` };
}

export function handlePEValue(argsStr: string): { text: string } {
  const parts = argsStr.trim().split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /pevalue <id> <betrag> [methode]' };
  const [id, amtStr, ...methodParts] = parts;
  const amount = Number(amtStr);
  if (!Number.isFinite(amount) || amount < 0) return { text: '❌ Betrag muss eine positive Zahl sein.' };
  const inv = getInvestment(id);
  if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
  const method = methodParts.length ? methodParts.join(' ') : undefined;
  addValuation(id, amount, method);
  const updated = getInvestment(id)!;
  const irr = calculateIRR(updated.investedAmount, updated.currentValuation, updated.investmentDate, updated.valuationDate);
  return { text: `✅ Bewertung aktualisiert: ${amount.toLocaleString('de-DE')} €\nIRR: ${irr.toFixed(1)}%\n\n${formatInvestmentDetail(updated)}` };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerPECommands(api: any): void {
  api.registerCommand({
    name: 'pe',
    description: 'Private-Equity-Beteiligungen anzeigen',
    handler: async () => {
      try { return handlePE(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'peshow',
    acceptsArgs: true,
    description: 'Detail einer Beteiligung: /peshow <id>',
    handler: async (ctx: any) => {
      try { return handlePEShow(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'penew',
    acceptsArgs: true,
    description: 'Neue Beteiligung: /penew <Firma> <Sektor> <Betrag> <Anteile> <Gesamt-Anteile>',
    handler: async (ctx: any) => {
      try { return handlePENew(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'peedit',
    acceptsArgs: true,
    description: 'Beteiligung bearbeiten: /peedit <id> <feld> <wert>',
    handler: async (ctx: any) => {
      try { return handlePEEdit(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'pevalue',
    acceptsArgs: true,
    description: 'Neue Bewertung: /pevalue <id> <betrag> [methode]',
    handler: async (ctx: any) => {
      try { return handlePEValue(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });
}
