/**
 * assets/commands — Telegram command handlers for the Assets (Immobilien) module.
 */
import {
  listProperties, getProperty, getLeaseByUnit, setLease,
  getOperatingCosts, setOperatingCosts, calculateNk, seedInitialData,
  formatPropertyList, formatPropertyDetail, formatRentOverview, formatNkResult,
} from './store.js';
import type { CostCategory } from './types.js';
import { COST_CATEGORIES } from './types.js';

// ── Command handlers ───────────────────────────────────────────────────────

export function handleProperties(): { text: string } {
  const props = listProperties();
  return { text: formatPropertyList(props) };
}

export function handleProperty(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /property <id>\nBeispiel: /property l19' };
  const p = getProperty(id);
  if (!p) return { text: `❌ Gebäude "${id}" nicht gefunden.` };
  return { text: formatPropertyDetail(p) };
}

export function handlePropertyRent(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /propertyrent <id>' };
  const p = getProperty(id);
  if (!p) return { text: `❌ Gebäude "${id}" nicht gefunden.` };
  return { text: formatRentOverview(p) };
}

export function handleLease(argsStr: string): { text: string } {
  const unitId = argsStr.trim();
  if (!unitId) return { text: '❌ Verwendung: /lease <unit-id>\nBeispiel: /lease l19-w1' };
  const lease = getLeaseByUnit(unitId);
  if (!lease) return { text: `❌ Kein Mietvertrag für Einheit "${unitId}" gefunden.` };
  const lines = [
    `📄 Mietvertrag ${lease.id}`,
    `Einheit: ${lease.unitId} (${lease.propertyId})`,
    `Mieter: ${lease.tenant}`,
    `Beginn: ${lease.startDate}`,
    `Ende: ${lease.endDate || 'unbefristet'}`,
    `Kaltmiete: ${lease.rentNet.toLocaleString('de-DE')} €`,
    `NK-Vorauszahlung: ${lease.operatingCosts.toLocaleString('de-DE')} €`,
    `Kaution: ${lease.depositAmount.toLocaleString('de-DE')} €`,
  ];
  if (lease.linkedDocs.length) lines.push(`Dokumente: ${lease.linkedDocs.join(', ')}`);
  return { text: lines.join('\n') };
}

export function handleLeaseSet(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /leaseset <unit-id> mieter=Name miete=800 nk=200 kaution=2400 beginn=2025-01-01' };

  const unitId = parts[0];
  const fields: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) fields[p.slice(0, eq).toLowerCase()] = p.slice(eq + 1);
  }

  // Find property for this unit
  const allProps = listProperties();
  const prop = allProps.find(p => p.units.some(u => u.id === unitId));
  if (!prop) return { text: `❌ Einheit "${unitId}" nicht gefunden.` };

  const existing = getLeaseByUnit(unitId);
  const lease = setLease(prop.id, unitId, {
    tenant: fields.mieter || existing?.tenant || '',
    startDate: fields.beginn || existing?.startDate || new Date().toISOString().slice(0, 10),
    endDate: fields.ende || existing?.endDate || null,
    rentNet: fields.miete != null ? Number(fields.miete) : (existing?.rentNet || 0),
    operatingCosts: fields.nk != null ? Number(fields.nk) : (existing?.operatingCosts || 0),
    depositAmount: fields.kaution != null ? Number(fields.kaution) : (existing?.depositAmount || 0),
    linkedDocs: existing?.linkedDocs || [],
  });
  return { text: `✅ Mietvertrag ${lease.id} gespeichert.\nMieter: ${lease.tenant} | Miete: ${lease.rentNet} € | NK: ${lease.operatingCosts} €` };
}

export function handleCosts(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /costs <property-id> <jahr> heizung=1200 wasser=800 ...\nKategorien: heizung, wasser, abwasser, muell, hausmeister, versicherung, grundsteuer, allgemeinstrom, aufzug' };

  const propertyId = parts[0];
  const year = Number(parts[1]);
  if (!Number.isFinite(year)) return { text: '❌ Jahr muss eine Zahl sein.' };

  const prop = getProperty(propertyId);
  if (!prop) return { text: `❌ Gebäude "${propertyId}" nicht gefunden.` };

  const validKeys = COST_CATEGORIES.map(c => c.key);
  const costs: Partial<Record<CostCategory, number>> = {};
  const existing = getOperatingCosts(propertyId, year);

  // Start with existing costs
  if (existing) Object.assign(costs, existing.costs);

  for (const p of parts.slice(2)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).toLowerCase() as CostCategory;
    if (!validKeys.includes(key)) continue;
    costs[key] = Number(p.slice(eq + 1));
  }

  // Use first distribution key as default
  const dkId = existing?.distributionKeyId || prop.distributionKeys[0]?.id || '';
  if (!dkId) return { text: '❌ Kein Verteilungsschlüssel definiert. Bitte zuerst im Dashboard anlegen.' };

  const oc = setOperatingCosts(propertyId, year, costs, dkId);
  const total = Object.values(oc.costs).reduce((s, v) => s + (v || 0), 0);
  return { text: `✅ Nebenkosten ${propertyId}/${year} gespeichert.\nGesamt: ${total.toLocaleString('de-DE')} €` };
}

export function handleNebenkostenabrechnung(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /nebenkostenabrechnung <property-id> <jahr>' };

  const propertyId = parts[0];
  const year = Number(parts[1]);
  if (!Number.isFinite(year)) return { text: '❌ Jahr muss eine Zahl sein.' };

  const results = calculateNk(propertyId, year);
  if (!results.length) return { text: `❌ Keine abrechnungsrelevanten Einheiten für ${propertyId}/${year}.` };
  return { text: formatNkResult(propertyId, year, results) };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerAssetsCommands(api: any): void {
  // Seed initial data on module load
  try { seedInitialData(); } catch {}

  api.registerCommand({
    name: 'properties',
    description: 'Alle Gebäude Übersicht',
    handler: async () => {
      try { return handleProperties(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'property',
    acceptsArgs: true,
    description: 'Gebäude-Details: /property <id>',
    handler: async (ctx: any) => {
      try { return handleProperty(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'propertyrent',
    acceptsArgs: true,
    description: 'Mieteinnahmen Übersicht: /propertyrent <id>',
    handler: async (ctx: any) => {
      try { return handlePropertyRent(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'lease',
    acceptsArgs: true,
    description: 'Mietvertrag anzeigen: /lease <unit-id>',
    handler: async (ctx: any) => {
      try { return handleLease(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'leaseset',
    acceptsArgs: true,
    description: 'Mietvertrag anlegen/updaten: /leaseset <unit-id> mieter=Name miete=800 nk=200 kaution=2400 beginn=2025-01-01',
    handler: async (ctx: any) => {
      try { return handleLeaseSet(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'costs',
    acceptsArgs: true,
    description: 'Nebenkosten eingeben: /costs <property-id> <jahr> heizung=1200 wasser=800 ...',
    handler: async (ctx: any) => {
      try { return handleCosts(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'nebenkostenabrechnung',
    acceptsArgs: true,
    description: 'Abrechnung berechnen: /nebenkostenabrechnung <property-id> <jahr>',
    handler: async (ctx: any) => {
      try { return handleNebenkostenabrechnung(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });
}
