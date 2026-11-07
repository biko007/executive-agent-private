/**
 * briefing/aktionen — Welche Owner-Aktionen aus Reportköpfen sind noch offen?
 *
 * ANLASS (Owner-Rüge 29.10.2026 21:43, „Hier sind mails erwähnt, die ich längst
 * versendet habe"): Das Briefing nahm `status: aktion` und `aktion:` aus dem
 * Reportkopf und listete sie, ohne zu prüfen, ob der Owner schon gehandelt hat.
 * Zwei Entwürfe (Porsche, Maxim) waren am Morgen gesendet, standen abends aber
 * noch als „Ihre Aktion: … senden" da.
 *
 * REGELN (Owner-Auftrag 29.10.2026):
 *   1. Lautet die Aktion „Entwurf … senden", wird das Postfach geprüft: Gibt es
 *      eine gesendete Mail an den Empfänger des Entwurfs mit demselben Betreff,
 *      ist die Aktion erledigt und erscheint nicht mehr. Das wird vermerkt
 *      (Merkdatei, nicht im Report — eine Änderung am Report liesse den
 *      Report-Watcher ihn erneut zustellen).
 *   2. Aktionen aus Reports, die älter als 7 Tage sind, stehen nicht mehr
 *      einzeln da, sondern als eine Zeile „ältere offene Aktionen: n".
 *      Einzeln steht nur das eigene Fenster des Briefings (Abend: heute,
 *      Morgen: seit gestern); offene der Vortage bis 7 Tage als eine Zeile.
 *
 * Reine Funktionen ohne Netz und Dateisystem; Abruf in quellen.ts und index.ts.
 */
import type { CcReport } from './abschnitte.js';

export const AKTION_TAGE = 7;
/** Höchstens so viele offene Aktionen einzeln — Telegram lehnt Nachrichten über 4.096 Zeichen ab. */
export const AKTION_ZEILEN_MAX = 12;
/** Aktionstext je Zeile höchstens so lang (gleicher Grund). */
export const AKTION_TEXT_MAX = 160;

/** Empfänger und Betreff, wie der Report den Entwurf beschreibt. */
export interface MailZiel {
  an: string[];
  /** vergleichbar gemacht (ohne RE:/AW: usw.) */
  betreffe: string[];
  /** wie im Report, nur Gross/klein und Leerraum angeglichen — für den Vorrang des genauen Treffers */
  genau?: string[];
}

export interface MailKurz {
  betreff: string;
  an: string[];
  /** ISO, Versand- bzw. Änderungszeit */
  zeit: string;
}

export type EntwurfStand =
  | { stand: 'gesendet'; zeit: string; an: string }
  | { stand: 'entwurf' }
  | { stand: 'fehlt' };

/** Aktion verlangt, einen Entwurf zu senden? */
export function istSendeAktion(aktion: string): boolean {
  return /entw(u|ü)rf/i.test(aktion) && /send/i.test(aktion);
}

const ADRESSE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Empfänger und Betreff aus dem Reporttext. Die Reports schreiben sie als
 * Aufzählung („- **An:** x · **Cc:** y", „- **Betreff:** …") oder als
 * Tabellenzeile („| An / Cc | x / y | gleich |", „| Betreff | … | gleich |").
 * Cc zählt nicht: Massgeblich ist, an wen die Mail ging.
 */
export function mailZiele(text: string): MailZiel {
  const an = new Set<string>();
  const betreffe = new Set<string>();
  const genau = new Set<string>();
  for (const roh of String(text || '').split('\n')) {
    const z = roh.trim();
    const anListe = /\*\*An:\*\*(.*)$/.exec(z)?.[1] ?? /^\|\s*An(\s*\/\s*Cc)?\s*\|([^|]*)\|/.exec(z)?.[2];
    if (anListe !== undefined) {
      // Nur der Teil vor „Cc" bzw. vor dem „/" der Tabellenspalte „An / Cc".
      const nurAn = anListe.split(/\*\*Cc:\*\*|·\s*Cc|\s\/\s/)[0];
      for (const a of nurAn.match(ADRESSE) ?? []) an.add(a.toLowerCase());
    }
    /* Kopfzeile `betreff:` (Pflicht bei „Entwurf … senden“ seit 07.11.2026, Vorschlag 4b). */
    const betreff = /\*\*Betreff:\*\*(.*)$/.exec(z)?.[1] ?? /^\|\s*Betreff\s*\|([^|]*)\|/.exec(z)?.[1]
      ?? /^betreff:\s*(.*)$/.exec(z)?.[1]?.replace(/^["']|["']$/g, '');
    if (betreff !== undefined && betreff.trim()) {
      // Mit und ohne Schlussklammer: „… (unverändert)" ist eine Notiz,
      // „Nebenkosten 2025 (MG24)" gehört zum Betreff.
      for (const kern of new Set([betreffKern(betreff), betreffKern(betreff, false)])) {
        betreffe.add(betreffNormal(kern));
        genau.add(betreffGenau(kern));
      }
    }
  }
  return { an: [...an], betreffe: [...betreffe].filter(Boolean), genau: [...genau].filter(Boolean) };
}

/**
 * Den eigentlichen Betreff aus einer Reportzeile lösen. Reports hängen Notizen
 * an: „… zur Prüfung (unverändert)" oder „„RE: …“: Antwort auf ihre Mail …".
 * In Anführungszeichen gilt der Inhalt; sonst fällt eine Klammer am Ende weg.
 */
export function betreffKern(roh: string, ohneKlammer = true): string {
  const s = String(roh || '').trim();
  const zitiert = /^[„"»]([^“"«]+)[“"«]/.exec(s);
  if (zitiert) return zitiert[1];
  return ohneKlammer ? s.replace(/\s*\([^()]*\)\s*$/, '') : s;
}

/** Nur Gross/klein und Leerraum angleichen; RE:/AW: bleiben. */
export function betreffGenau(b: string): string {
  return String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Betreff vergleichbar machen: Anführungszeichen, RE:/AW:/WG:/FW:, Gross/klein, Leerraum. */
export function betreffNormal(b: string): string {
  let s = String(b || '').trim().replace(/^[„“"'»«]+|[„“"'»«]+$/g, '').trim();
  while (/^(re|aw|wg|fw|fwd)\s*:\s*/i.test(s)) s = s.replace(/^(re|aw|wg|fw|fwd)\s*:\s*/i, '');
  return s.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Steht der Entwurf noch in „Entwürfe", oder ist er gesendet?
 *
 * Vorsichtig, weil ein Vermerk „gesendet" die Aktion dauerhaft ausblendet:
 *   - Liegt noch ein Entwurf an den Empfänger mit diesem Betreff, ist nichts
 *     gesendet — auch wenn eine ältere Mail im selben Strang den gleichen
 *     vergleichbaren Betreff trägt (Review 29.10.2026).
 *   - Gesendet = für JEDEN Empfänger eine Mail ab `seit` mit gleichem Betreff.
 *   - Nennt der Report keinen Betreff (Vorschlag 4b, Owner-Freigabe 07.11.2026;
 *     Anlass: Fehr-Mail 06.11. stand trotz Versand als offen da): gesendet ist,
 *     was NACH der Reportzeit `berichtZeit` an JEDEN An-Empfänger ging — und nur,
 *     wenn an keinen von ihnen mehr ein Entwurf liegt (oben geprüft). Eine
 *     frühere Mail an denselben Empfänger zählt nicht. Ohne `berichtZeit`
 *     bleibt es wie bisher bei „fehlt“.
 */
export function entwurfStand(
  ziel: MailZiel, gesendet: MailKurz[], entwuerfe: MailKurz[], seit: string, berichtZeit?: string,
): EntwurfStand {
  const passt = (m: MailKurz, an: string) =>
    m.an.some(x => x.toLowerCase() === an)
    && (ziel.betreffe.length === 0 || ziel.betreffe.includes(betreffNormal(m.betreff)));
  if (entwuerfe.some(m => ziel.an.some(a => passt(m, a)))) return { stand: 'entwurf' };
  if (ziel.betreffe.length === 0) {
    if (!berichtZeit || ziel.an.length === 0) return { stand: 'fehlt' };
    const ab = Date.parse(berichtZeit);
    const erste = ziel.an.map(a => gesendet
      .filter(m => Date.parse(m.zeit) > ab && m.an.some(x => x.toLowerCase() === a))
      .sort((x, y) => x.zeit.localeCompare(y.zeit))[0]);
    if (!erste.every(Boolean)) return { stand: 'fehlt' };
    const spaetester = erste.reduce((x, y) => (y!.zeit > x!.zeit ? y : x))!;
    return { stand: 'gesendet', zeit: spaetester.zeit, an: ziel.an.join(', ') };
  }
  /* Vorrang hat der genaue Betreff: Eine Antwort im selben Strang („RE: …")
     und die Erstmail haben denselben vergleichbaren Betreff. Doris bekam am
     28.10. um 05:57 die v4 und um 20:38 die v5 als „RE: …" — ohne Vorrang
     hätte der v5-Report die Uhrzeit der v4 bekommen. */
  const genau = new Set(ziel.genau ?? []);
  const treffer = ziel.an.map(a => {
    const kandidaten = gesendet.filter(m => m.zeit >= seit && passt(m, a)).sort((x, y) => x.zeit.localeCompare(y.zeit));
    return kandidaten.find(m => genau.has(betreffGenau(m.betreff))) ?? kandidaten[0];
  });
  if (ziel.an.length > 0 && treffer.every(Boolean)) {
    const spaetester = treffer.reduce((x, y) => (y!.zeit > x!.zeit ? y : x))!;
    return { stand: 'gesendet', zeit: spaetester.zeit, an: ziel.an.join(', ') };
  }
  return { stand: 'fehlt' };
}

/** Berichtstag: Datum im Dateinamen (…-20261029.md), sonst Änderungstag in Berlin. */
export function berichtTag(datei: string, zeitIso: string): string {
  const m = /(20\d{2})(\d{2})(\d{2})(?:-\d{4})?\.md$/.exec(datei) ?? /-(20\d{2})(\d{2})(\d{2})/.exec(datei);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(String(zeitIso || ''));
  if (!Number.isFinite(t)) return String(zeitIso || '').slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

export interface OffeneAktionen {
  /** einzeln aufzuführen (Berichtstag ab `abTag`), neueste zuerst */
  aktuell: (CcReport & { hinweis?: string })[];
  /** offen, Berichtstag vor `abTag`, aber höchstens AKTION_TAGE alt */
  vortage: number;
  /** offen, älter als AKTION_TAGE */
  aelter: number;
}

/**
 * Offene Reports nach Alter trennen. Einzeln stehen nur die des eigenen
 * Fensters (Abend: heute, Morgen: seit gestern) — ältere offene Reports
 * tragen meist Entscheidungen, die längst gefallen sind, ohne dass ihr Kopf
 * das weiss; sie erscheinen nur als Anzahl. `erledigt` enthält Schlüssel
 * `<strang>:<datei>` aus der Merkdatei, `hinweise` je Schlüssel einen Zusatz.
 */
export function offeneAktionen(
  reports: CcReport[], heute: string, abTag: string, erledigt: Set<string>, hinweise: Map<string, string> = new Map(),
): OffeneAktionen {
  const aktuell: OffeneAktionen['aktuell'] = [];
  let vortage = 0;
  let aelter = 0;
  for (const r of reports) {
    const schluessel = `${r.strang}:${r.datei}`;
    if (erledigt.has(schluessel)) continue;
    const tag = berichtTag(r.datei, r.zeit);
    const alter = Math.round((Date.parse(`${heute}T00:00:00Z`) - Date.parse(`${tag}T00:00:00Z`)) / 86_400_000);
    if (alter > AKTION_TAGE) aelter++;
    else if (tag < abTag) vortage++;
    else aktuell.push({ ...r, hinweis: hinweise.get(schluessel) });
  }
  aktuell.sort((a, b) => b.zeit.localeCompare(a.zeit));
  return { aktuell, vortage, aelter };
}
