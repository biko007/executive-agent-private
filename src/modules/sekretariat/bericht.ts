/**
 * sekretariat/bericht — Stundenreport und Telegram je VORGANG (Spec v1).
 *
 * Je Vorgang eine Zeile: Titel, Objekt, Begründung in einem Satz, nächster
 * Schritt, Frist, Freigabezeile `Freigabe Vorgang <Kennung>`. Einzelzeilen nur
 * für Netz-Treffer ohne Vorgang. „nur zur Kenntnis" (f) bleibt ein Zähler.
 * In Stufe 1 löst die Freigabe einen cc-Auftrag über den Chat aus — hier wird
 * nichts ausgeführt.
 */

import { zelle, datumKurz } from '../neuheiten/bericht.js';
import { VORSCHLAG_TEXT } from './schema.js';
import type { ElementStand, LaufErgebnis, Vorgang } from './lauf.js';

const tag = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–');

export function elementKurz(e: ElementStand): string {
  return `${e.typ === 'mail' ? '✉' : '📄'} ${datumKurz(e.datum).slice(0, 6)} ${zelle(e.typ === 'mail' ? e.von.split('@')[0] : e.titel).slice(0, 40)}`;
}

/** Zeilen je Vorgang (f ausgenommen) und die Zahl der Kenntnis-Vorgänge. */
export function vorgangsZeilen(vorgaenge: Vorgang[], elemente: Record<string, ElementStand>):
{ zeilen: Array<{ v: Vorgang; el: ElementStand[] }>; kenntnis: number } {
  const zeilen = vorgaenge.filter((v) => v.vorschlag !== 'f')
    .map((v) => ({ v, el: v.elemente.map((k) => elemente[k]).filter(Boolean) }))
    .sort((a, b) => (a.v.frist ?? '9999').localeCompare(b.v.frist ?? '9999') || b.v.aktualisiert.localeCompare(a.v.aktualisiert));
  return { zeilen, kenntnis: vorgaenge.filter((v) => v.vorschlag === 'f').length };
}

export function vorgangsTabelle(z: Array<{ v: Vorgang; el: ElementStand[] }>): string[] {
  const t = ['| Kennung | Vorgang | Objekt | Elemente | Begründung | Nächster Schritt | Frist |', '|---|---|---|---|---|---|---|'];
  for (const { v, el } of z) {
    t.push(`| \`${v.kennung}\` | ${zelle(v.titel)} | ${v.objekt ?? '–'} | ${el.map(elementKurz).join('<br>')} | ${zelle(v.begruendung)} `
      + `| **${v.vorschlag})** ${zelle(v.naechsterSchritt).slice(0, 400)} | ${tag(v.frist)} |`);
  }
  return t;
}

export function einzelTabelle(einzeln: ElementStand[]): string[] {
  const t = ['| Kennung | Neuheit | Netz | KI-Begründung |', '|---|---|---|---|'];
  for (const e of einzeln) {
    t.push(`| \`${e.kennung}\` | ${elementKurz(e)}: ${zelle(e.titel).slice(0, 70)} | ${e.netz.map((n) => n.grund).join(', ')} | ${zelle(e.bewertung?.begruendung ?? '')} |`);
  }
  return t;
}

export function stundenReportSekretariat(p: {
  ergebnis: LaufErgebnis; elemente: Record<string, ElementStand>; jetzt: Date; hinweise: string[];
}): string {
  const { zeilen, kenntnis } = vorgangsZeilen(p.ergebnis.vorgaenge, p.elemente);
  const z = p.ergebnis.zaehler;
  const out = [
    `# Neuheiten ${p.jetzt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `**${zeilen.length} Vorgang/Vorgänge zur Freigabe**${kenntnis ? `, + ${kenntnis} zur Kenntnis` : ''}`
      + `${p.ergebnis.einzeln.length ? `, ${p.ergebnis.einzeln.length} Netz-Treffer` : ''}. Nichts wurde ausgeführt.`,
    '',
  ];
  if (zeilen.length) {
    out.push('## Vorgänge', '', ...vorgangsTabelle(zeilen), '', ...zeilen.map(({ v }) => `- \`Freigabe Vorgang ${v.kennung}\``), '');
  }
  if (p.ergebnis.einzeln.length) {
    out.push('## Netz-Treffer ohne Vorgang (KI: nicht relevant — zur Prüfung)', '', ...einzelTabelle(p.ergebnis.einzeln), '');
  }
  out.push('## Statuskette dieses Laufs', '',
    `erfasst ${z.erfasst} · vorgefiltert ${z.vorgefiltert} · KI bewertet ${z.bewertet} (nicht relevant ${z.abgelegtKi}, Vorschlag ${z.vorschlag}, Netz ${z.netzEinzeln}) · wartet ${z.wartet} · Fehler ${z.fehler}`,
    '', `KI: ${p.ergebnis.tokensEin} Tokens ein / ${p.ergebnis.tokensAus} aus, ≈ ${p.ergebnis.kostenUsd.toFixed(3)} $ (claude-sonnet-4-6).`, '');
  if (p.ergebnis.alarm.length || p.hinweise.length) out.push('## Hinweis', '', ...[...p.ergebnis.alarm, ...p.hinweise].map((h) => `- ${h}`), '');
  out.push('Freigabe in Stufe 1: `Freigabe Vorgang <Kennung>` im Chat — cc führt den Schritt als Auftrag aus (Entwurf, Buchungs- oder Fristvorschlag; nie senden, nie löschen).',
    'Nicht relevant Bewertetes liegt mit Begründung in `artifacts/personal/sekretariat/nicht-relevant.jsonl`.', '');
  return out.join('\n');
}

export function telegramZeilen(p: { ergebnis: LaufErgebnis; elemente: Record<string, ElementStand> }): { titel: string; zeilen: string[] } {
  const { zeilen, kenntnis } = vorgangsZeilen(p.ergebnis.vorgaenge, p.elemente);
  const out = zeilen.slice(0, 10).map(({ v }) =>
    `📁 ${zelle(v.titel).slice(0, 50)}${v.frist ? ` (bis ${tag(v.frist).slice(0, 6)})` : ''} → ${v.vorschlag}) ${VORSCHLAG_TEXT[v.vorschlag]}: ${zelle(v.begruendung).slice(0, 90)}`);
  if (zeilen.length > 10) out.push(`… und ${zeilen.length - 10} weitere`);
  for (const e of p.ergebnis.einzeln.slice(0, 3)) out.push(`🔎 Netz: ${zelle(e.titel).slice(0, 50)} (${e.netz.map((n) => n.grund).join(', ')})`);
  if (kenntnis) out.push(`+ ${kenntnis} zur Kenntnis`);
  return { titel: `Neu: ${zeilen.length} Vorgang/Vorgänge${p.ergebnis.einzeln.length ? `, ${p.ergebnis.einzeln.length} Netz-Treffer` : ''}`, zeilen: out };
}
