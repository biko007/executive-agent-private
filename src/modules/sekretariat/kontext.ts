/**
 * sekretariat/kontext — was die KI über die Welt des Owners wissen muss.
 *
 * Nur lesend aus bikosoc: Objekte mit Adresse, Kontakte (Regeldatei,
 * Lieferanten der Kostenbuchungen, Mieter mit Einheit), laufende Fristen.
 * Die offenen Vorgänge kommen aus dem Sekretariats-Speicher (lauf.ts).
 */

import type { Regelwerk } from '../mail-register/relevanz.js';
import type { Kontext } from './ki.js';

export type Abfrage = (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>;

export const OWNER_VORGABEN = [
  'Objektkürzel intern: MG24, MG22, N24, L19, S28, D4, I83, ZZ5 (Zelterweg 5 = Privatadresse des Owners; Lieferungen dorthin sind kein Objektbezug), abc-raum.',
  'Private Käufe und Abos (PayPal, Amazon, Lieferando, Vodafone, Midjourney, Oura, Yahoo, NYT, Starlink, Getränke, Gemüsekiste …): nur eine Rechnung/ein Beleg ist relevant, Vorschlag a mit Objekt „privat" (Privatausgaben); Bestell- und Versandbestätigungen sind nicht relevant.',
  'Vereins- und Ehrenamtspost (FoTA/Tower Ateliers, BvCW, Historische Fahrräder, Rotary) ist nicht relevant, außer sie verlangt eine Zahlung oder Frist vom Owner.',
  'Angelegenheiten der Eltern des Owners (Ordner Papa/Mama, Rente, Witwenrente) sind kein Objektbezug.',
  'Mails werden nie gesendet, nur als Entwurf vorbereitet. Buchungen und Fristen nur als Vorschlag.',
];

export async function ladeKontext(q: Abfrage, regeln: Regelwerk, vorgaenge: string[]): Promise<Kontext> {
  const objekte = (await q(`SELECT code, name, street, postal_code, city FROM properties WHERE active ORDER BY code`)).rows
    .map((r: any) => ({ kuerzel: String(r.name || r.code).toUpperCase().replace('ABC-RAUM', 'abc-raum'), adresse: `${r.street}, ${r.postal_code} ${r.city}` }));
  const lieferanten = (await q(`SELECT DISTINCT p.name obj, eb.vendor_name v FROM expense_bookings eb JOIN properties p ON p.id = eb.property_id
    WHERE eb.archived_at IS NULL AND eb.vendor_name IS NOT NULL AND eb.vendor_name NOT ILIKE 'noch offen%'
      AND eb.service_period_end >= '2024-01-01' ORDER BY 2`)).rows;
  const mieter = (await q(`SELECT p.name obj, u.code einheit, t.first_name, t.last_name, t.company_name
    FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
    JOIN lease_tenants lt ON lt.lease_id = l.id JOIN tenants t ON t.id = lt.tenant_id
    WHERE l.status = 'active' OR l.end_date >= CURRENT_DATE - 400 ORDER BY 1, 2`)).rows;
  const nk = (await q(`SELECT p.name obj, o.year, o.service_deadline_at::date::text d FROM nk_period_obligations o
    JOIN properties p ON p.id = o.property_id WHERE o.status NOT IN ('served','expired') AND o.service_deadline_at IS NOT NULL
    GROUP BY 1, 2, 3 ORDER BY 3`)).rows;
  const fristen = (await q(`SELECT p.name obj, f.bezeichnung, f.termin::text d FROM objekt_fristen f JOIN properties p ON p.id = f.property_id
    WHERE f.erledigt_am IS NULL ORDER BY f.termin`)).rows;

  const kontakte: string[] = [];
  const mieterZeilen: string[] = [];
  for (const k of regeln.kontakte) kontakte.push(`${k.name} — Kontakt (Absendermuster ${k.absender})`);
  const lief = new Map<string, Set<string>>();
  for (const r of lieferanten) { const s = lief.get(r.v) ?? new Set(); s.add(r.obj); lief.set(r.v, s); }
  for (const [v, o] of lief) kontakte.push(`${v} — Dienstleister/Lieferant (${[...o].join(', ')})`);
  for (const m of mieter) {
    const name = m.company_name || `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim();
    /* Nur Name und Einheit — keine Mailadresse (Review 27.10.2026: Datensparsamkeit). */
    if (name) mieterZeilen.push(`${name} — Mieter ${m.obj} ${m.einheit}`);
  }
  return {
    objekte,
    /* Mieter vor den Lieferanten, damit eine Kürzung sie nicht zufällig trifft. */
    kontakte: [...kontakte.slice(0, regeln.kontakte.length), ...new Set(mieterZeilen), ...kontakte.slice(regeln.kontakte.length)],
    fristen: [
      ...nk.map((r: any) => `${r.d} ${r.obj}: NK-Abrechnung ${r.year} muss zugegangen sein`),
      ...fristen.map((r: any) => `${r.d} ${r.obj}: ${r.bezeichnung}`),
    ],
    vorgaenge,
    vorgaben: OWNER_VORGABEN,
  };
}

/**
 * Reports, Dropbox und Telegram tragen keine Mieternamen (Owner-Regel). Die KI
 * kennt sie aus dem Kontext und kann sie in Begründung oder Titel nennen —
 * dieser Ersetzer macht daraus „Mieter <Objekt> <Einheit>". Ersetzt werden der
 * volle Name und der Nachname (ab 4 Zeichen), ohne Rücksicht auf Groß-/Kleinschreibung.
 */
export function mieterErsetzer(kontakte: string[]): (text: string) => string {
  const paare: Array<[RegExp, string]> = [];
  for (const k of kontakte) {
    const m = k.match(/^(.+?) — Mieter (\S+ \S+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const ersatz = `Mieter ${m[2]}`;
    /* Firmen nur mit vollem Namen — sonst träfe „GmbH" jede Firma. */
    const firma = /\b(gmbh|mbh|ag|kg|ug|gbr|ohg|e\.\s?v\.|co\.?|ltd|inc|se|stiftung|verein)\b/i.test(name);
    const teile = [name, ...(firma ? [] : [name.split(/\s+/).slice(-1)[0]])].filter((t, i, a) => t.length >= 4 && a.indexOf(t) === i);
    for (const t of teile) paare.push([new RegExp(`(?<![\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'), ersatz]);
  }
  /* Längere Namen zuerst, damit „Firma Muster GmbH" vor „GmbH"-Resten greift. */
  paare.sort((a, b) => b[0].source.length - a[0].source.length);
  return (text) => paare.reduce((t, [re, e]) => t.replace(re, e), text);
}
