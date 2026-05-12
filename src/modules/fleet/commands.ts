/**
 * fleet/commands — Telegram command handlers for the Fleet module.
 */
import {
  getAllVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
  addServiceEntry, setInsurance, setTuevDate,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
  changeVehicleId, migrateHexIds,
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

// ── Command handlers ───────────────────────────────────────────────────────

export function handleFleetList(): { text: string } {
  const migrated = migrateHexIds();
  const vehicles = getAllVehicles();
  let text = formatVehicleList(vehicles);
  if (migrated.length > 0) {
    text += '\n\n🔄 IDs migriert:\n' + migrated.map(m => `  ${m.oldId} → ${m.newId}`).join('\n');
  }
  return { text };
}

export function handleFleetAdd(argsStr: string): { text: string } {
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
  const v = createVehicle(type as VehicleType, make, model, year);
  return { text: `✅ Fahrzeug angelegt:\n\n${formatVehicleDetail(v)}` };
}

export function handleFleetShow(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /fleetshow <id>' };
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
  let text = formatVehicleDetail(v);
  if (_deps) {
    const links = _deps.getLinksForEntity('fleet', id);
    if (links.length) {
      text += `\n\n📎 Verknüpfte Dokumente:\n${_deps.formatLinksForTelegram(links)}`;
    }
  }
  return { text };
}

export function handleFleetEdit(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /fleetedit <id> <feld> <wert>' };
  const [id, field, ...rest] = parts;
  const value = rest.join(' ');
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

  const updates: Record<string, any> = {};
  switch (field.toLowerCase()) {
    case 'name':     updates.name = value; break;
    case 'plate':    updates.plate = value; break;
    case 'mileage':  {
      const km = parseInt(value, 10);
      if (isNaN(km)) return { text: '❌ km-Stand muss eine Zahl sein.' };
      updates.mileage = km;
      break;
    }
    case 'tuev': {
      const iso = parseDateDE(value);
      if (!iso) return { text: '❌ Datum im Format DD.MM.YYYY erwartet.' };
      updates.tuevDate = iso;
      break;
    }
    case 'color':    updates.color = value; break;
    case 'vin':      updates.vin = value; break;
    case 'id': {
      const newId = value.toLowerCase().startsWith('v-') ? value.toLowerCase() : `v-${value.toLowerCase()}`;
      if (!/^v-[a-z0-9]+(-[a-z0-9]+)*$/.test(newId))
        return { text: '❌ ID darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten.' };
      const result = changeVehicleId(id, newId);
      if (!result) return { text: `❌ ID '${newId}' ist bereits vergeben oder ungültig.` };
      return { text: `✅ ID geändert: ${id} → ${newId}\n\n${formatVehicleDetail(result)}` };
    }
    default: return { text: `❌ Unbekanntes Feld: ${field}\nErlaubt: name, plate, mileage, tuev, color, vin, id` };
  }

  const updated = updateVehicle(id, updates);
  return { text: `✅ Aktualisiert:\n\n${formatVehicleDetail(updated!)}` };
}

export function handleFleetDel(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /fleetdel <id>' };
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
  deleteVehicle(id);
  return { text: `🗑 Fahrzeug **${v.name}** (${v.id}) gelöscht.` };
}

export function handleFleetService(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /fleetservice <id> <typ> [kosten] [notiz]' };
  const [id, typ, ...rest] = parts;
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

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

  const entry = {
    date: new Date().toISOString().slice(0, 10),
    type: typ,
    mileage: v.mileage,
    cost,
    notes: noteParts.length ? noteParts.join(' ') : undefined,
  };

  const updated = addServiceEntry(id, entry);
  return { text: `✅ Service-Eintrag hinzugefügt:\n🔧 ${typ}${cost != null ? ` | ${cost} €` : ''}${entry.notes ? ` — ${entry.notes}` : ''}\n\nFahrzeug: ${updated!.name}` };
}

export function handleFleetInsurance(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return { text: '❌ Verwendung: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]' };
  const [id, provider, type, ...rest] = parts;
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

  let annualCost: number | undefined;
  if (rest.length > 0) {
    const c = parseFloat(rest[0]);
    if (!isNaN(c)) annualCost = c;
  }

  const insurance = { provider, type, annualCost };
  const updated = setInsurance(id, insurance);
  return { text: `✅ Versicherung gesetzt:\n🛡 ${provider} (${type})${annualCost != null ? ` | ${annualCost} €/Jahr` : ''}\n\nFahrzeug: ${updated!.name}` };
}

export function handleFleetTuev(argsStr: string): { text: string } {
  const raw = argsStr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return { text: '❌ Verwendung: /fleettuev <id> <DD.MM.YYYY>' };
  const [id, dateStr] = parts;
  const iso = parseDateDE(dateStr);
  if (!iso) return { text: '❌ Datum im Format DD.MM.YYYY erwartet.' };
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
  const updated = setTuevDate(id, iso);
  return { text: `✅ TÜV-Datum gesetzt: ${dateStr}\n\nFahrzeug: ${updated!.name}` };
}

export function handleFleetDocs(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /fleetdocs <id>' };
  const v = getVehicle(id);
  if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
  if (!v.documents.length) return { text: `📎 Keine Dokumente für **${v.name}**.` };
  const lines = v.documents.map(d => `   • ${d.label} (${d.filename}) — ${d.uploadedAt.slice(0, 10)}`);
  return { text: `📎 Dokumente für **${v.name}** (${v.documents.length}):\n\n${lines.join('\n')}` };
}

export function handleFleetLink(argsStr: string): { text: string } {
  const id = argsStr.trim();
  if (!id) return { text: '❌ Verwendung: /fleetlink <id>' };
  if (!_deps) return { text: '❌ Link-System nicht initialisiert.' };
  const links = _deps.getLinksForEntity('fleet', id);
  if (!links.length) return { text: `📎 Keine Dokumente verknüpft mit Fahrzeug ${id}.` };
  return { text: `📎 Fahrzeug-Dokumente (${id}):\n\n${_deps.formatLinksForTelegram(links)}` };
}

// ── Command registration ───────────────────────────────────────────────────

export function registerFleetCommands(api: any): void {
  api.registerCommand({
    name: 'fleet',
    description: 'Alle Fahrzeuge im Fuhrpark anzeigen',
    handler: async () => {
      try { return handleFleetList(); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetadd',
    acceptsArgs: true,
    description: 'Fahrzeug hinzufügen: /fleetadd <car|bike> <Hersteller> <Modell...> <Baujahr>',
    handler: async (ctx: any) => {
      try { return handleFleetAdd(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetshow',
    acceptsArgs: true,
    description: 'Fahrzeug-Details anzeigen: /fleetshow <id>',
    handler: async (ctx: any) => {
      try { return handleFleetShow(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetedit',
    acceptsArgs: true,
    description: 'Fahrzeug bearbeiten: /fleetedit <id> <feld> <wert>  (name, plate, mileage, tuev, color, vin, id)',
    handler: async (ctx: any) => {
      try { return handleFleetEdit(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetdel',
    acceptsArgs: true,
    description: 'Fahrzeug löschen: /fleetdel <id>',
    handler: async (ctx: any) => {
      try { return handleFleetDel(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetservice',
    acceptsArgs: true,
    description: 'Service-Eintrag: /fleetservice <id> <typ> [kosten] [notiz]',
    handler: async (ctx: any) => {
      try { return handleFleetService(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetinsurance',
    acceptsArgs: true,
    description: 'Versicherung setzen: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]',
    handler: async (ctx: any) => {
      try { return handleFleetInsurance(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleettuev',
    acceptsArgs: true,
    description: 'TÜV-Datum setzen: /fleettuev <id> <DD.MM.YYYY>',
    handler: async (ctx: any) => {
      try { return handleFleetTuev(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetdocs',
    acceptsArgs: true,
    description: 'Dokumente eines Fahrzeugs anzeigen: /fleetdocs <id>',
    handler: async (ctx: any) => {
      try { return handleFleetDocs(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: 'fleetlink',
    acceptsArgs: true,
    description: 'Fahrzeug-Dokumente anzeigen: /fleetlink <id>',
    handler: async (ctx: any) => {
      try { return handleFleetLink(String(ctx.args || '')); }
      catch (e: any) { return { text: `❌ Fehler: ${e.message}` }; }
    },
  });
}
