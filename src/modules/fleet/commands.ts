/**
 * fleet/commands — Telegram command handlers for the Fleet module.
 * Sprint 6c: All handlers async, new /tuev and /versicherung commands.
 */
import {
  listVehicles, getVehicleByCode, createVehicle, updateVehicle,
  archiveVehicle, addServiceRecord, addInsurancePolicy, addTuevRecord,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
} from './store.js';
import type { VehicleType } from './types.js';

// ── Dependencies injected from index.ts ────────────────────────────────────

export interface FleetDeps {
  getLinksForEntity: (entityType: string, entityId: string) => any[];
  formatLinksForTelegram: (links: any[]) => string;
}

let _deps: FleetDeps | null = null;

export function initFleetCommands(deps: FleetDeps): void {
  _deps = deps;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseDateDE(s: string): string | null {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function formatDE(isoDate: string): string {
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fmtEur(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ── Command handlers ───────────────────────────────────────────────────────

export async function handleFleetList(): Promise<{ text: string }> {
  const vehicles = await listVehicles();
  const text = formatVehicleList(vehicles);
  return { text };
}

export async function handleFleetAdd(argsStr: string): Promise<{ text: string }> {
  const args = argsStr.trim().split(/\s+/);
  if (args.length < 4) return { text: '❌ Verwendung: /fleetadd <car|bike> <Hersteller> <Modell...> <Baujahr>' };
  const type = args[0].toLowerCase();
  if (type !== 'car' && type !== 'bike') return { text: '❌ Typ muss "car" oder "bike" sein.' };
  const make = args[1];
  const yearStr = args[args.length - 1];
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 1900 || year > 2100) return { text: '❌ Ungültiges Baujahr (4-stellige Zahl erwartet).' };
  const model = args.slice(2, -1).join(' ');
  if (!model) return { text: '❌ Modell fehlt.' };

  // Generate vehicle code from make+model
  const slug = `FZG-${make}-${model}`.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);
  const displayName = `${make} ${model}`;

  const v = await createVehicle({
    vehicleCode: slug,
    displayName,
    make,
    model,
    firstRegistration: `${year}-01-01`,
    sourcePayload: { vehicle_type: type as VehicleType, model_year: year },
  }, 'telegram');
  return { text: `✅ Fahrzeug angelegt:\n\n${formatVehicleDetail(v)}` };
}

export async function handleFleetShow(argsStr: string): Promise<{ text: string }> {
  const code = argsStr.trim();
  if (!code) return { text: '❌ Verwendung: /fleetshow <id>' };
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };
  let text = formatVehicleDetail(v);
  if (_deps) {
    const links = _deps.getLinksForEntity('fleet', code);
    if (links.length) {
      text += `\n\n📎 Verknüpfte Dokumente:\n${_deps.formatLinksForTelegram(links)}`;
    }
  }
  return { text };
}

export async function handleFleetEdit(argsStr: string): Promise<{ text: string }> {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /fleetedit <id> <feld> <wert>' };
  const [code, field, ...rest] = parts;
  const value = rest.join(' ');
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };

  const updates: Record<string, unknown> = {};
  switch (field.toLowerCase()) {
    case 'name':     updates.display_name = value; break;
    case 'plate':    updates.license_plate = value; break;
    case 'mileage':  {
      const km = parseInt(value, 10);
      if (isNaN(km)) return { text: '❌ km-Stand muss eine Zahl sein.' };
      updates.current_mileage_km = km;
      break;
    }
    case 'color':    {
      const sp = v.sourcePayload || {};
      sp.color = value;
      updates.source_payload = sp;
      break;
    }
    case 'vin':      updates.vin = value; break;
    case 'holder':   updates.holder = value; break;
    case 'notes':    updates.notes = value; break;
    default: return { text: `❌ Unbekanntes Feld: ${field}\nErlaubt: name, plate, mileage, color, vin, holder, notes` };
  }

  const updated = await updateVehicle(code, updates, 'telegram');
  return { text: `✅ Aktualisiert:\n\n${formatVehicleDetail(updated!)}` };
}

export async function handleFleetDel(argsStr: string): Promise<{ text: string }> {
  const code = argsStr.trim();
  if (!code) return { text: '❌ Verwendung: /fleetdel <id>' };
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };
  await archiveVehicle(code, 'Deleted via Telegram', 'telegram');
  return { text: `🗑 Fahrzeug **${v.name}** (${v.vehicleCode}) archiviert.` };
}

export async function handleFleetService(argsStr: string): Promise<{ text: string }> {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /fleetservice <id> <typ> [kosten] [notiz]' };
  const [code, typ, ...rest] = parts;
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };

  let cost: number | undefined;
  let noteParts: string[] = [];
  if (rest.length > 0) {
    const maybeCost = parseFloat(rest[0]);
    if (!isNaN(maybeCost)) {
      cost = maybeCost;
      noteParts = rest.slice(1);
    } else {
      noteParts = rest;
    }
  }

  const updated = await addServiceRecord(code, {
    service_date: new Date().toISOString().slice(0, 10),
    service_type: typ,
    mileage_km: v.mileage,
    cost,
    notes: noteParts.length ? noteParts.join(' ') : undefined,
  }, 'telegram');

  return { text: `✅ Service-Eintrag hinzugefügt:\n🔧 ${typ}${cost != null ? ` | ${cost} €` : ''}${noteParts.length ? ` — ${noteParts.join(' ')}` : ''}\n\nFahrzeug: ${updated.name}` };
}

export async function handleFleetInsurance(argsStr: string): Promise<{ text: string }> {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]' };
  const [code, provider, coverageType, ...rest] = parts;
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };

  let annualPremium: number | undefined;
  if (rest.length > 0) {
    const c = parseFloat(rest[0]);
    if (!isNaN(c)) annualPremium = c;
  }

  // Map German coverage types to DB enum
  const typeMap: Record<string, string> = {
    haftpflicht: 'haftpflicht',
    teilkasko: 'teilkasko',
    vollkasko: 'vollkasko',
  };
  const dbCoverageType = typeMap[coverageType.toLowerCase()] || coverageType.toLowerCase();

  const updated = await addInsurancePolicy(code, {
    company: provider,
    coverage_type: dbCoverageType,
    annual_premium: annualPremium,
  }, 'telegram');

  return { text: `✅ Versicherung gesetzt:\n🛡 ${provider} (${coverageType})${annualPremium != null ? ` | ${annualPremium} €/Jahr` : ''}\n\nFahrzeug: ${updated.name}` };
}

export async function handleFleetTuev(argsStr: string): Promise<{ text: string }> {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /fleettuev <id> <DD.MM.YYYY>' };
  const [code, dateStr] = parts;
  const iso = parseDateDE(dateStr);
  if (!iso) return { text: '❌ Datum im Format DD.MM.YYYY erwartet.' };
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };
  await addTuevRecord(code, { next_due_date: iso }, 'telegram');
  return { text: `✅ TÜV-Datum gesetzt: ${dateStr}\n\nFahrzeug: ${v.name}` };
}

export async function handleFleetDocs(argsStr: string): Promise<{ text: string }> {
  const code = argsStr.trim();
  if (!code) return { text: '❌ Verwendung: /fleetdocs <id>' };
  const v = await getVehicleByCode(code);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${code}` };
  if (!v.documents.length) return { text: `📎 Keine Dokumente für **${v.name}**.` };
  const lines = v.documents.map(d => `   • ${d.title} (${d.docType})${d.createdAt ? ` — ${d.createdAt.slice(0, 10)}` : ''}`);
  return { text: `📎 Dokumente für **${v.name}** (${v.documents.length}):\n\n${lines.join('\n')}` };
}

export async function handleFleetLink(argsStr: string): Promise<{ text: string }> {
  const code = argsStr.trim();
  if (!code) return { text: '❌ Verwendung: /fleetlink <id>' };
  if (!_deps) return { text: '❌ Link-System nicht initialisiert.' };
  const links = _deps.getLinksForEntity('fleet', code);
  if (!links.length) return { text: `📎 Keine Dokumente verknüpft mit Fahrzeug ${code}.` };
  return { text: `📎 Fahrzeug-Dokumente (${code}):\n\n${_deps.formatLinksForTelegram(links)}` };
}

// ── New commands: /tuev and /versicherung ───────────────────────────────────

export async function handleTuevOverview(): Promise<{ text: string }> {
  const vehicles = await listVehicles();
  if (!vehicles.length) return { text: '🔧 Keine Fahrzeuge im Fuhrpark.' };

  const lines: string[] = ['🔧 TÜV-Übersicht:\n'];

  for (const v of vehicles) {
    let tuevInfo: string;
    let indicator: string;

    if (v.tuevDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const d = new Date(v.tuevDate);
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);

      tuevInfo = formatDE(v.tuevDate);
      if (days < 0) indicator = '🔴';
      else if (days <= 30) indicator = '⚠️';
      else indicator = '✅';
    } else {
      tuevInfo = 'kein TÜV-Datum';
      indicator = '❓';
    }

    lines.push(`🚗 ${v.vehicleCode} (${v.name}) — ${tuevInfo} ${indicator}`);
  }

  return { text: lines.join('\n') };
}

export async function handleVersicherungOverview(): Promise<{ text: string }> {
  const vehicles = await listVehicles();
  if (!vehicles.length) return { text: '🛡 Keine Fahrzeuge im Fuhrpark.' };

  const lines: string[] = ['🛡 Versicherungs-Übersicht:\n'];

  for (const v of vehicles) {
    const activePolicy = v.insurancePolicies.find(p => p.status === 'active');
    if (activePolicy) {
      const premium = activePolicy.annualCost != null ? ` | ${fmtEur(activePolicy.annualCost)}/Jahr` : '';
      const coverageLabel = activePolicy.type.charAt(0).toUpperCase() + activePolicy.type.slice(1);
      lines.push(`🚗 ${v.vehicleCode} — ${activePolicy.provider} | ${coverageLabel}${premium}`);
    } else {
      lines.push(`🚗 ${v.vehicleCode} — keine Versicherung hinterlegt`);
    }
  }

  return { text: lines.join('\n') };
}

// ── Reifen Overview ─────────────────────────────────────────────────────────

export async function handleReifenOverview(): Promise<{ text: string }> {
  const vehicles = await listVehicles();
  if (!vehicles.length) return { text: '🛞 Keine Fahrzeuge im Fuhrpark.' };

  const typeLabel: Record<string, string> = {
    summer: 'Sommer',
    winter: 'Winter',
    all_season: 'Ganzjahr',
    spike: 'Spike',
  };

  const lines: string[] = ['🛞 Reifen-Übersicht:\n'];

  for (const v of vehicles) {
    const activeSets = (v.tireSets || []).filter(t => !t.removedAt);
    if (activeSets.length > 0) {
      const t = activeSets[0]; // most recent active set
      const typeName = t.tireType ? (typeLabel[t.tireType] || t.tireType) : '?';
      const brandModel = [t.brand, t.model].filter(Boolean).join(' ') || '–';
      const depth = t.treadDepthMm != null ? `${t.treadDepthMm}mm` : '–';
      lines.push(`🚗 ${v.vehicleCode} | ${typeName} ${brandModel} | ${depth}`);
    } else {
      lines.push(`🚗 ${v.vehicleCode} | (kein Eintrag)`);
    }
  }

  return { text: lines.join('\n') };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerFleetCommands(api: any): void {
  api.registerCommand({
    name: 'fleet',
    description: 'Alle Fahrzeuge im Fuhrpark anzeigen',
    handler: async () => {
      try { return await handleFleetList(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetadd',
    acceptsArgs: true,
    description: 'Fahrzeug hinzufügen: /fleetadd <car|bike> <Hersteller> <Modell...> <Baujahr>',
    handler: async (ctx: any) => {
      try { return await handleFleetAdd(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetshow',
    acceptsArgs: true,
    description: 'Fahrzeug-Details anzeigen: /fleetshow <id>',
    handler: async (ctx: any) => {
      try { return await handleFleetShow(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetedit',
    acceptsArgs: true,
    description: 'Fahrzeug bearbeiten: /fleetedit <id> <feld> <wert>  (name, plate, mileage, color, vin, holder, notes)',
    handler: async (ctx: any) => {
      try { return await handleFleetEdit(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetdel',
    acceptsArgs: true,
    description: 'Fahrzeug archivieren: /fleetdel <id>',
    handler: async (ctx: any) => {
      try { return await handleFleetDel(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetservice',
    acceptsArgs: true,
    description: 'Service-Eintrag: /fleetservice <id> <typ> [kosten] [notiz]',
    handler: async (ctx: any) => {
      try { return await handleFleetService(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetinsurance',
    acceptsArgs: true,
    description: 'Versicherung setzen: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]',
    handler: async (ctx: any) => {
      try { return await handleFleetInsurance(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleettuev',
    acceptsArgs: true,
    description: 'TÜV-Datum setzen: /fleettuev <id> <DD.MM.YYYY>',
    handler: async (ctx: any) => {
      try { return await handleFleetTuev(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetdocs',
    acceptsArgs: true,
    description: 'Dokumente eines Fahrzeugs anzeigen: /fleetdocs <id>',
    handler: async (ctx: any) => {
      try { return await handleFleetDocs(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetlink',
    acceptsArgs: true,
    description: 'Fahrzeug-Dokumente anzeigen: /fleetlink <id>',
    handler: async (ctx: any) => {
      try { return await handleFleetLink(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  // ── New Sprint 6c commands ────────────────────────────────────────────────

  api.registerCommand({
    name: 'tuev',
    description: 'TÜV-Übersicht aller Fahrzeuge',
    handler: async () => {
      try { return await handleTuevOverview(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'versicherung',
    description: 'Versicherungs-Übersicht aller Fahrzeuge',
    handler: async () => {
      try { return await handleVersicherungOverview(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'reifen',
    description: 'Reifen-Übersicht aller Fahrzeuge',
    handler: async () => {
      try { return await handleReifenOverview(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });
}
