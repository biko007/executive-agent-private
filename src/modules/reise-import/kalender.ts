/**
 * reise-import/kalender — Reise-Etappen als M365-Termine (Vorschlag 4c, Stufe 2).
 *
 * Owner-Freigabe 07.11.2026 11:53 („Freigabe Vorschlag 4c-Stufe2, nur Stufe 2,
 * kein Zwischenschritt"): Schreibweg in den Kalender juergen.bickel@.
 *
 * Je Flug, Umstieg (mit Ankunft und Weiterflug), Buchung der Art „termin" und
 * offener Frist der Art „termin" im Reisezeitraum entsteht genau ein Termin.
 *
 * Sicherheitsregel: Angefasst werden NUR Termine, deren Text den Marker
 * `bikosoc:reise:<reise>:<etappe>` trägt — nie fremde. Hinter dem Marker steht
 * ein Prüfwert (`h=…`) über den Inhalt; ist er gleich, bleibt der Termin
 * unberührt (Idempotenz). Entfällt eine Etappe, wird ihr Termin gelöscht —
 * auch das nur mit Marker.
 *
 * Zeiten: Abflug in der Ortszeit des Abflughafens, Ankunft in der Ortszeit des
 * Zielflughafens (Tabelle unten). Graph bekommt UTC; so hängt nichts an der
 * Zeitzonen-Erkennung von Outlook. Unbekannter Flughafen oder fehlende Uhrzeit:
 * ganztägiger Termin mit Hinweis. Eine Dauer wird nie erfunden: Buchungen mit
 * Beginn, aber ohne Ende werden ganztägig mit „ab HH:MM" im Betreff angelegt.
 *
 * Reine Funktionen bis auf `kalenderAbgleich`, der über die Schnittstelle
 * `KalenderApi` schreibt (Graph im Skript, Attrappe im Test).
 */
import crypto from 'node:crypto';
import type { Buchung, Flug, Frist, Umstieg } from './types.js';

/** Flughafen → IANA-Zone, Ortsname, Windows-Zone (für ganztägige Termine). */
export const FLUGHAEFEN: Record<string, { zone: string; name: string }> = {
  ZRH: { zone: 'Europe/Zurich', name: 'Flughafen Zürich' },
  FRA: { zone: 'Europe/Berlin', name: 'Flughafen Frankfurt' },
  MUC: { zone: 'Europe/Berlin', name: 'Flughafen München' },
  STR: { zone: 'Europe/Berlin', name: 'Flughafen Stuttgart' },
  YYZ: { zone: 'America/Toronto', name: 'Toronto Pearson' },
  YWG: { zone: 'America/Winnipeg', name: 'Winnipeg Richardson' },
  YVR: { zone: 'America/Vancouver', name: 'Vancouver International' },
  YYJ: { zone: 'America/Vancouver', name: 'Victoria International' },
  SFO: { zone: 'America/Los_Angeles', name: 'San Francisco International' },
  SJC: { zone: 'America/Los_Angeles', name: 'San José Mineta' },
  LAX: { zone: 'America/Los_Angeles', name: 'Los Angeles International' },
};

/** Stadt (Feld `ort` einer Buchung) → IANA-Zone. */
export const ORTE: Record<string, string> = {
  'zürich': 'Europe/Zurich', 'tuttlingen': 'Europe/Berlin', 'toronto': 'America/Toronto',
  'winnipeg': 'America/Winnipeg', 'vancouver': 'America/Vancouver', 'victoria': 'America/Vancouver',
  'san francisco': 'America/Los_Angeles', 'santa clara': 'America/Los_Angeles',
  'san josé': 'America/Los_Angeles', 'san jose': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles',
};

/** IANA → Windows-Zone; Graph braucht sie für ganztägige Termine. */
export const WINDOWS_ZONE: Record<string, string> = {
  'Europe/Zurich': 'W. Europe Standard Time', 'Europe/Berlin': 'W. Europe Standard Time',
  'America/Toronto': 'Eastern Standard Time', 'America/Winnipeg': 'Central Standard Time',
  'America/Vancouver': 'Pacific Standard Time', 'America/Los_Angeles': 'Pacific Standard Time',
};

export const MARKER_PRAEFIX = 'bikosoc:reise:';
const MARKER = /bikosoc:reise:(\d{6}-trip-[a-z0-9-]+):([a-z0-9._-]+)(?:\s+h=([0-9a-f]{8}))?/;

export interface ReiseFuerKalender {
  id: string;
  start_date: string;
  end_date: string;
  reise?: {
    version?: number;
    fluege?: Flug[];
    umstiege?: Umstieg[];
    buchungen?: Buchung[];
    fristen?: Frist[];
  };
  calendar_event_ids?: string[];
}

export interface SollTermin {
  /** Etappenkennung, stabil über Versionen */
  etappe: string;
  betreff: string;
  ort: string;
  /** Klartext ohne Markerzeile */
  text: string;
  ganztags: boolean;
  /** zeitlich: ISO UTC */
  startUtc?: string;
  endeUtc?: string;
  /** ganztägig: JJJJ-MM-TT, Ende exklusiv */
  tagVon?: string;
  tagBis?: string;
  /** IANA-Zone für Anzeige (zeitlich: des Beginns) bzw. des ganzen Tages */
  zone: string;
  zoneEnde?: string;
  hinweis?: string;
  /** Prüfwert über alle Felder oben */
  pruefwert: string;
}

export interface IstTermin {
  id: string;
  reise: string;
  etappe: string;
  pruefwert: string | null;
  betreff?: string;
  startUtc?: string;
  endeUtc?: string;
  ganztags?: boolean;
}

/* ── Zeitzonen ──────────────────────────────────────────────────────────── */

/** Versatz der Zone zum Zeitpunkt `utcMs` in Minuten (lokal − UTC). */
function versatzMin(zone: string, utcMs: number): number {
  const t = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const v = (k: string) => Number(t.find(p => p.type === k)?.value);
  const lokalAlsUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((lokalAlsUtc - utcMs) / 60_000);
}

/** Ortszeit (`2026-11-07`, `13:20`) in der Zone → ISO UTC. */
export function ortszeitNachUtc(datum: string, uhr: string, zone: string): string {
  const [j, m, t] = datum.split('-').map(Number);
  const [h, mi] = uhr.split(':').map(Number);
  const naiv = Date.UTC(j, m - 1, t, h, mi);
  let utc = naiv - versatzMin(zone, naiv) * 60_000;
  utc = naiv - versatzMin(zone, utc) * 60_000; // zweiter Schritt für Umstellungstage
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}

/** ISO UTC → „07.11. 13:20" in der Zone. */
export function ortszeitText(utcIso: string, zone: string): string {
  const t = new Intl.DateTimeFormat('de-DE', {
    timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(utcIso));
  return t.replace(',', '');
}

export function zoneVonFlughafen(iata: string | undefined): string | null {
  return FLUGHAEFEN[String(iata || '').trim().toUpperCase()]?.zone ?? null;
}

function zoneVonOrt(ort: string | undefined): string | null {
  return ORTE[String(ort || '').trim().toLowerCase()] ?? null;
}

const UHR = /^([01]\d|2[0-3]):[0-5]\d$/;

function naechsterTag(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function slug(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' } as Record<string, string>)[c])
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

/** Wo ist der Reisende an diesem Tag? Zone des letzten Ziels VOR diesem Tag, sonst des ersten Abflugs.
 *  Am Anreisetag selbst gilt noch der Ausgangsort („Abfahrt Tuttlingen" am 07.11. ist Europa, nicht Winnipeg). */
export function zoneAmTag(fluege: Flug[], tag: string): string {
  const sortiert = [...fluege].sort((a, b) => `${a.datum} ${a.ab_ortszeit ?? ''}`.localeCompare(`${b.datum} ${b.ab_ortszeit ?? ''}`));
  let zone = zoneVonFlughafen(sortiert[0]?.von) ?? 'Europe/Berlin';
  for (const f of sortiert) {
    const an = f.an_datum || f.datum;
    if (an < tag) zone = zoneVonFlughafen(f.nach) ?? zone;
  }
  return zone;
}

/* ── Planung ────────────────────────────────────────────────────────────── */

function mitPruefwert(t: Omit<SollTermin, 'pruefwert'>): SollTermin {
  const h = crypto.createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 8);
  return { ...t, pruefwert: h };
}

/** Buchungscode zu einem Flug: Buchung, die die Flugnummer nennt; sonst die einzige Flugbuchung ohne Flugliste. */
export function buchungZuFlug(f: Flug, alle: Flug[], buchungen: Buchung[]): Buchung | undefined {
  const flugBuchungen = buchungen.filter(b => b.art === 'flug' || (!b.art && b.ticket));
  const nennt = (b: Buchung, nr: string) => `${b.notiz ?? ''} ${b.tarif ?? ''} ${b.anbieter ?? ''}`.includes(nr);
  const direkt = flugBuchungen.find(b => nennt(b, f.flugnummer));
  if (direkt) return direkt;
  const ohneListe = flugBuchungen.filter(b => !alle.some(x => nennt(b, x.flugnummer)));
  return ohneListe.length === 1 ? ohneListe[0] : undefined;
}

function flugTermin(r: ReiseFuerKalender, f: Flug, alle: Flug[], buchungen: Buchung[]): SollTermin {
  const zAb = zoneVonFlughafen(f.von);
  const zAn = zoneVonFlughafen(f.nach);
  const b = buchungZuFlug(f, alle, buchungen);
  const name = (iata: string) => FLUGHAEFEN[iata]?.name ? `${FLUGHAEFEN[iata].name} (${iata})` : iata;
  const zeilen = [
    b?.code ? `Buchungscode: ${b.code}` : '',
    `Abflug: ${f.von}${f.von_terminal ? ` ${f.von_terminal}` : ''} ${f.ab_ortszeit ?? '–'} Ortszeit${zAb ? ` (${zAb})` : ''}`,
    `Ankunft: ${f.nach}${f.nach_terminal ? ` ${f.nach_terminal}` : ''} ${f.an_ortszeit ?? '–'} Ortszeit${f.an_datum ? ` am ${f.an_datum}` : ''}${zAn ? ` (${zAn})` : ''}`,
    f.betrieben_von ? `Betrieben von: ${f.betrieben_von}` : '',
    f.klasse ? `Klasse: ${f.klasse}${f.buchungsklasse ? ` (${f.buchungsklasse})` : ''}` : '',
    f.gepaeck ? `Gepäck: ${f.gepaeck}` : '',
    f.notiz ? `Hinweis: ${f.notiz}` : '',
  ];
  const basis = {
    etappe: `flug-${slug(f.flugnummer)}-${f.datum}`,
    betreff: `✈ ${f.flugnummer} ${f.von} → ${f.nach}`,
    ort: name(String(f.von).toUpperCase()),
  };
  if (zAb && zAn && f.ab_ortszeit && UHR.test(f.ab_ortszeit) && f.an_ortszeit && UHR.test(f.an_ortszeit)) {
    return mitPruefwert({
      ...basis, text: textMitQuelle(r, zeilen), ganztags: false,
      startUtc: ortszeitNachUtc(f.datum, f.ab_ortszeit, zAb),
      endeUtc: ortszeitNachUtc(f.an_datum || f.datum, f.an_ortszeit, zAn),
      zone: zAb, zoneEnde: zAn,
    });
  }
  const hinweis = !zAb || !zAn
    ? `Zeitzone für ${[!zAb && f.von, !zAn && f.nach].filter(Boolean).join(', ')} unbekannt – ganztägig angelegt`
    : 'Uhrzeit fehlt – ganztägig angelegt';
  return mitPruefwert({
    ...basis, text: textMitQuelle(r, [hinweis, ...zeilen]), ganztags: true,
    tagVon: f.datum, tagBis: naechsterTag(f.datum), zone: zAb ?? zoneAmTag(r.reise?.fluege ?? [], f.datum), hinweis,
  });
}

function umstiegTermin(r: ReiseFuerKalender, u: Umstieg, fluege: Flug[]): SollTermin | null {
  const iata = String(u.flughafen || '').trim().slice(0, 3).toUpperCase();
  const zone = zoneVonFlughafen(iata);
  const sortiert = [...fluege].sort((a, b) => `${a.datum} ${a.ab_ortszeit ?? ''}`.localeCompare(`${b.datum} ${b.ab_ortszeit ?? ''}`));
  const i = sortiert.findIndex((f, k) => f.nach === iata && sortiert[k + 1]?.von === iata);
  if (!zone || i < 0) return null;
  const an = sortiert[i];
  const weiter = sortiert[i + 1];
  if (!an.an_ortszeit || !weiter.ab_ortszeit || !UHR.test(an.an_ortszeit) || !UHR.test(weiter.ab_ortszeit)) return null;
  const zeilen = [
    `Ankunft ${an.flugnummer} ${an.an_ortszeit}, Weiterflug ${weiter.flugnummer} ${weiter.ab_ortszeit} (Ortszeit ${zone})`,
    u.dauer ? `Umsteigezeit: ${u.dauer}` : '',
    u.einreise ? `Einreise: ${u.einreise}` : '',
    u.puffer ? `Puffer: ${u.puffer}` : '',
    u.backup ? `Ersatz: ${u.backup}` : '',
    u.notiz ? `Hinweis: ${u.notiz}` : '',
  ];
  return mitPruefwert({
    etappe: `umstieg-${iata.toLowerCase()}-${an.an_datum || an.datum}`,
    betreff: `⇄ Umstieg ${iata}${u.dauer ? ` (${u.dauer})` : ''}`,
    ort: FLUGHAEFEN[iata] ? `${FLUGHAEFEN[iata].name} (${iata})` : iata,
    text: textMitQuelle(r, zeilen), ganztags: false,
    startUtc: ortszeitNachUtc(an.an_datum || an.datum, an.an_ortszeit, zone),
    endeUtc: ortszeitNachUtc(weiter.datum, weiter.ab_ortszeit, zone),
    zone,
  });
}

function buchungTermin(r: ReiseFuerKalender, b: Buchung): SollTermin | null {
  if (b.art !== 'termin' || !b.von) return null;
  const zone = zoneVonOrt(b.ort) ?? zoneAmTag(r.reise?.fluege ?? [], b.von);
  const titel = String(b.anbieter || b.code || 'Termin').trim();
  const zeilen = [
    b.code ? `Buchungscode: ${b.code}` : '',
    b.tarif ? `Tarif: ${b.tarif}` : '',
    b.status ? `Status: ${b.status}` : '',
    b.notiz ? `Hinweis: ${b.notiz}` : '',
    b.verwalten_url ? `Verwalten: ${b.verwalten_url}` : '',
  ];
  const etappe = `termin-${slug(b.code || titel)}-${b.von}-${b.zeit_von ? b.zeit_von.replace(':', '') : 'tag'}`;
  const ort = b.ort ?? '';
  const bis = b.bis ?? b.von;
  if (b.zeit_von && b.zeit_bis && UHR.test(b.zeit_von) && UHR.test(b.zeit_bis)) {
    return mitPruefwert({
      etappe, betreff: titel, ort, text: textMitQuelle(r, zeilen), ganztags: false,
      startUtc: ortszeitNachUtc(b.von, b.zeit_von, zone), endeUtc: ortszeitNachUtc(bis, b.zeit_bis, zone), zone,
    });
  }
  const ab = b.zeit_von && UHR.test(b.zeit_von) ? b.zeit_von : null;
  const hinweis = ab ? 'Ende in der Reisedatei nicht angegeben – ganztägig angelegt' : undefined;
  return mitPruefwert({
    etappe, betreff: ab ? `${titel} (ab ${ab})` : titel, ort,
    text: textMitQuelle(r, [hinweis ?? '', ...zeilen]), ganztags: true,
    tagVon: b.von, tagBis: naechsterTag(bis), zone, ...(hinweis ? { hinweis } : {}),
  });
}

function fristTermin(r: ReiseFuerKalender, f: Frist): SollTermin | null {
  if (f.art !== 'termin' || f.status === 'erledigt') return null;
  if (f.faellig < r.start_date || f.faellig > r.end_date) return null;
  const zone = zoneAmTag(r.reise?.fluege ?? [], f.faellig);
  return mitPruefwert({
    etappe: `frist-${f.faellig}-${slug(f.titel)}`,
    betreff: f.titel, ort: '', text: textMitQuelle(r, [f.notiz ? `Hinweis: ${f.notiz}` : '']),
    ganztags: true, tagVon: f.faellig, tagBis: naechsterTag(f.faellig), zone,
  });
}

function textMitQuelle(r: ReiseFuerKalender, zeilen: string[]): string {
  return [...zeilen.filter(Boolean), `Quelle: Reise ${r.id} v${r.reise?.version ?? 1} (Reise-Import)`].join('\n');
}

/** Alle Soll-Termine einer Reise. Doppelte Etappenkennungen bekommen eine laufende Nummer. */
export function planeTermine(r: ReiseFuerKalender): SollTermin[] {
  const fluege = r.reise?.fluege ?? [];
  const buchungen = r.reise?.buchungen ?? [];
  const liste: SollTermin[] = [
    ...fluege.map(f => flugTermin(r, f, fluege, buchungen)),
    ...(r.reise?.umstiege ?? []).map(u => umstiegTermin(r, u, fluege)).filter((t): t is SollTermin => !!t),
    ...buchungen.map(b => buchungTermin(r, b)).filter((t): t is SollTermin => !!t),
    ...(r.reise?.fristen ?? []).map(f => fristTermin(r, f)).filter((t): t is SollTermin => !!t),
  ];
  const zaehler = new Map<string, number>();
  for (const t of liste) {
    const n = (zaehler.get(t.etappe) ?? 0) + 1;
    zaehler.set(t.etappe, n);
    if (n > 1) t.etappe = `${t.etappe}-${n}`;
  }
  return liste;
}

/* ── Abgleich ───────────────────────────────────────────────────────────── */

export function markerZeile(reise: string, t: SollTermin): string {
  return `${MARKER_PRAEFIX}${reise}:${t.etappe} h=${t.pruefwert}`;
}

/** Marker aus dem Termintext (HTML oder Text) lesen. */
export function markerAus(text: string): { reise: string; etappe: string; pruefwert: string | null } | null {
  const m = MARKER.exec(String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
  return m ? { reise: m[1], etappe: m[2], pruefwert: m[3] ?? null } : null;
}

/** Graph-Nutzlast eines Soll-Termins. */
export function graphTermin(reise: string, t: SollTermin): Record<string, unknown> {
  const text = `${t.text}\n\n${markerZeile(reise, t)}`;
  const zeit = t.ganztags
    ? {
      isAllDay: true,
      start: { dateTime: `${t.tagVon}T00:00:00`, timeZone: WINDOWS_ZONE[t.zone] ?? 'W. Europe Standard Time' },
      end: { dateTime: `${t.tagBis}T00:00:00`, timeZone: WINDOWS_ZONE[t.zone] ?? 'W. Europe Standard Time' },
    }
    : {
      isAllDay: false,
      start: { dateTime: t.startUtc!.replace('Z', ''), timeZone: 'UTC' },
      end: { dateTime: t.endeUtc!.replace('Z', ''), timeZone: 'UTC' },
    };
  return {
    subject: t.betreff,
    body: { contentType: 'text', content: text },
    location: { displayName: t.ort },
    showAs: t.ganztags ? 'free' : 'busy',
    isReminderOn: false,
    categories: ['Reise'],
    ...zeit,
  };
}

export interface AbgleichPlan {
  anlegen: SollTermin[];
  aendern: Array<{ id: string; soll: SollTermin }>;
  gleich: Array<{ id: string; soll: SollTermin }>;
  loeschen: IstTermin[];
}

/** Soll gegen Ist. Ist enthält nur Termine mit Marker DIESER Reise. Doppelte Ist-Termine einer Etappe: einer bleibt, der Rest wird gelöscht. */
export function abgleich(reise: string, soll: SollTermin[], ist: IstTermin[]): AbgleichPlan {
  const eigene = ist.filter(i => i.reise === reise);
  const plan: AbgleichPlan = { anlegen: [], aendern: [], gleich: [], loeschen: [] };
  const vergeben = new Set<string>();
  for (const s of soll) {
    const kandidaten = eigene.filter(i => i.etappe === s.etappe && !vergeben.has(i.id));
    const treffer = kandidaten.find(i => i.pruefwert === s.pruefwert) ?? kandidaten[0];
    if (!treffer) { plan.anlegen.push(s); continue; }
    vergeben.add(treffer.id);
    (treffer.pruefwert === s.pruefwert ? plan.gleich : plan.aendern).push({ id: treffer.id, soll: s });
  }
  for (const i of eigene) if (!vergeben.has(i.id)) plan.loeschen.push(i);
  return plan;
}

/** Was der Abgleich vom Kalender braucht — im Skript Graph, im Test eine Attrappe. */
export interface KalenderApi {
  /** Termine mit Marker im Zeitraum (ISO, UTC) — der Aufrufer filtert nicht vor. */
  imZeitraum(vonIso: string, bisIso: string): Promise<Array<{ id: string; text: string; betreff?: string; startUtc?: string; endeUtc?: string; ganztags?: boolean }>>;
  /** Einzelnen Termin lesen; null, wenn es ihn nicht mehr gibt. */
  lies(id: string): Promise<{ id: string; text: string } | null>;
  anlegen(nutzlast: Record<string, unknown>): Promise<string>;
  aendern(id: string, nutzlast: Record<string, unknown>): Promise<void>;
  loeschen(id: string): Promise<void>;
}

export interface AbgleichErgebnis {
  plan: AbgleichPlan;
  geschrieben: boolean;
  /** Etappe → Termin-ID nach dem Abgleich */
  ids: Record<string, string>;
  fehler: string[];
}

/** Vorhandene Termine dieser Reise finden: Zeitraum der Reise ±3 Tage und bekannte IDs. Nur mit Marker. */
export async function istTermine(r: ReiseFuerKalender, api: KalenderApi): Promise<IstTermin[]> {
  const von = new Date(Date.parse(`${r.start_date}T00:00:00Z`) - 3 * 86_400_000).toISOString();
  const bis = new Date(Date.parse(`${r.end_date}T00:00:00Z`) + 4 * 86_400_000).toISOString();
  const gefunden = new Map<string, IstTermin>();
  const nimm = (e: { id: string; text: string; betreff?: string; startUtc?: string; endeUtc?: string; ganztags?: boolean }) => {
    const m = markerAus(e.text);
    if (m && m.reise === r.id) gefunden.set(e.id, { id: e.id, ...m, betreff: e.betreff, startUtc: e.startUtc, endeUtc: e.endeUtc, ganztags: e.ganztags });
  };
  for (const e of await api.imZeitraum(von, bis)) nimm(e);
  for (const id of r.calendar_event_ids ?? []) {
    if (gefunden.has(id)) continue;
    const e = await api.lies(id);
    if (e) nimm(e);
  }
  return [...gefunden.values()];
}

/** Reise mit dem Kalender abgleichen. Ohne `schreiben` nur der Plan. */
export async function kalenderAbgleich(r: ReiseFuerKalender, api: KalenderApi, opts: { schreiben: boolean }): Promise<AbgleichErgebnis> {
  const soll = planeTermine(r);
  const plan = abgleich(r.id, soll, await istTermine(r, api));
  const ids: Record<string, string> = {};
  for (const g of [...plan.gleich, ...plan.aendern]) ids[g.soll.etappe] = g.id;
  const fehler: string[] = [];
  if (opts.schreiben) {
    for (const s of plan.anlegen) {
      try { ids[s.etappe] = await api.anlegen(graphTermin(r.id, s)); } catch (e: any) { fehler.push(`anlegen ${s.etappe}: ${e?.message ?? e}`); }
    }
    for (const a of plan.aendern) {
      try { await api.aendern(a.id, graphTermin(r.id, a.soll)); } catch (e: any) { fehler.push(`ändern ${a.soll.etappe}: ${e?.message ?? e}`); }
    }
    for (const l of plan.loeschen) {
      try { await api.loeschen(l.id); } catch (e: any) { fehler.push(`löschen ${l.etappe}: ${e?.message ?? e}`); }
    }
  }
  return { plan, geschrieben: opts.schreiben, ids, fehler };
}

/**
 * Rückweg: alle Termine mit Marker dieser Reise löschen. Liest vorher jeden
 * Termin und prüft den Marker — eine bloße ID reicht nicht.
 */
export async function kalenderEntfernen(r: ReiseFuerKalender, api: KalenderApi, opts: { schreiben: boolean }): Promise<{ geloescht: IstTermin[]; fehler: string[] }> {
  const ist = await istTermine(r, api);
  const fehler: string[] = [];
  if (opts.schreiben) {
    for (const i of ist) {
      try { await api.loeschen(i.id); } catch (e: any) { fehler.push(`löschen ${i.etappe}: ${e?.message ?? e}`); }
    }
  }
  return { geloescht: ist, fehler };
}

/** Kennungen nach dem Abgleich in die Reisedatei übernehmen (Segmente der Flüge und Gesamtliste). */
export function idsUebernehmen(trip: Record<string, any>, ids: Record<string, string>): Record<string, any> {
  const fluege: Flug[] = trip?.reise?.fluege ?? [];
  const segmente = Array.isArray(trip.segments) ? trip.segments.map((s: any) => {
    const f: Flug | undefined = s?.flug;
    const id = f ? ids[`flug-${slug(f.flugnummer)}-${f.datum}`] : undefined;
    if (!f) return s;
    const { calendarEventId: _a, calendarWebLink: _b, ...rest } = s;
    return id ? { ...rest, calendarEventId: id } : rest;
  }) : trip.segments;
  void fluege;
  return { ...trip, segments: segmente, calendar_event_ids: Object.values(ids) };
}
