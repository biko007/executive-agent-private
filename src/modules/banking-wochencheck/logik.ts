/**
 * banking-wochencheck/logik — reine Rechenregeln des Montags-Wochenchecks.
 *
 * Kein Datenbankzugriff, keine Dateien: alles hier ist mit festen Eingaben
 * testbar. Das Skript `scripts/banking-wochencheck.ts` liest die Daten und
 * ruft diese Funktionen auf.
 */

/** Letzte vier Stellen einer Kontokennung — nie die volle IBAN (C5). */
export function kontoKurz(kennung: string | null | undefined): string {
  const s = String(kennung || '').replace(/\s+/g, '');
  return s.length > 4 ? '…' + s.slice(-4) : (s || '–');
}

/* Gesundheit zuerst (C5): Krankenkassen, Praxen, Apotheken, Abrechnungsstellen
   erscheinen nie mit Namen — auch nicht, wenn sie eine Rechtsform tragen. */
const GESUNDHEIT = /apothek|praxis|klinik|klinikum|\bmvz\b|\bpvs\b|verrechnungsstelle|\barzt|ärzt|zahn|physio|kranken|\baok\b|\bikk\b|knappschaft|\bbkk\b|\bdak\b|techniker krankenkasse|therap|labor|optik|hörgerät|orthop|sanitätshaus|pflegedienst|pflegeheim/i;

/* Gegenparteien, die erkennbar keine Privatperson sind. Alles andere wird im
   Report als „Privatperson" ausgegeben — keine Namen Dritter im Report.
   Alle Begriffe mit Wortgrenze, damit „Bankowski" keine Bank ist. */
const FIRMA = new RegExp(
  '\\b(gmbh|mbh|ag|kg|ohg|se|ug|e\\.?\\s?v\\.?|e\\.?\\s?k\\.?|gbr|ltd|limited|inc|llc|s\\.?a\\.?r\\.?l|'
  + 'b\\.?v\\.?|oy|ab|srl|spa|s\\.?p\\.?a\\.?|plc|sa|nv|d\\.?d\\.?|eg)\\b|'
  + '\\b(stadt|landkreis|gemeinde|finanzamt|bundeskasse|landesoberkasse|zollamt|'
  + 'sparkasse|volksbank|bank|versicherung|stadtwerke|paypal|amazon|apple|google|telekom|vodafone|'
  + 'energie|rundfunk)\\b',
  'i',
);

export const GESUNDHEIT_ANZEIGE = 'Gesundheit (privat)';

export function gegenparteiAnzeige(name: string | null | undefined): string {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(ohne Gegenpartei)';
  if (/\d{10,}|[A-Z]{2}\d{2}[\d ]{12,}/.test(s)) return '(Kennung entfernt)';
  if (GESUNDHEIT.test(s)) return GESUNDHEIT_ANZEIGE;
  return FIRMA.test(s) ? s.slice(0, 40) : 'Privatperson';
}

/** Darf der Verwendungszweck neben dieser Gegenpartei im Report stehen? */
export function zweckErlaubt(anzeige: string): boolean {
  return !['Privatperson', '(Kennung entfernt)', '(ohne Gegenpartei)', GESUNDHEIT_ANZEIGE].includes(anzeige);
}

/** Verwendungszweck ohne IBAN und lange Ziffernfolgen, gekürzt. */
export function zweckAnzeige(zweck: string | null | undefined, max = 70): string {
  return String(zweck || '')
    .replace(/\s+/g, ' ')
    .replace(/(?<![A-Z0-9])[A-Z]{2}\d{2}[\d ]{8,}\d/g, '(IBAN entfernt)')
    .replace(/\d{10,}/g, '(Nr. entfernt)')
    // Steuernummern („021/101/55659") gehören in keinen Report (stehende Regel 8)
    .replace(/\b\d{2,3}\s?\/\s?\d{3,4}\s?\/\s?\d{4,5}\b/g, '(Steuernr. entfernt)')
    .trim()
    .slice(0, max);
}

export function euro(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * Anzahl fälliger Monatsabschläge: fällig zum 1., gezählt erst ab dem
 * `nachfristTage`-ten Tag — sonst stünde am ersten Montag eines Monats ein
 * Rückstand im Report, der noch keiner ist.
 */
export function faelligeAbschlaege(ab: string, stichtag: string, nachfristTage = 5): number {
  const a = new Date(ab + 'T00:00:00Z');
  const s = new Date(stichtag + 'T00:00:00Z');
  if (s < a) return 0;
  let n = (s.getUTCFullYear() - a.getUTCFullYear()) * 12 + (s.getUTCMonth() - a.getUTCMonth()) + 1;
  if (s.getUTCDate() < nachfristTage) n -= 1;
  return Math.max(0, n);
}

/**
 * Offene Abschläge. Mahngebühren (8 € je Mahnung) laufen über dasselbe Konto
 * und würden einen Teilbetrag vortäuschen — deshalb zählt nur, wie viele
 * VOLLE Abschläge die Zahlungen abdecken.
 */
export function offeneAbschlaege(faellig: number, gezahlt: number, abschlag: number): { gedeckt: number; offen: number; offenEuro: number } {
  const gedeckt = Math.min(faellig, Math.floor((gezahlt + 0.005) / abschlag));
  const offen = Math.max(0, faellig - gedeckt);
  return { gedeckt, offen, offenEuro: Math.round(offen * abschlag * 100) / 100 };
}

export interface Umsatz {
  konto: number;
  datum: string;          // YYYY-MM-DD
  betrag: number;
  gegenpartei: string;
  zweck: string;
}

/**
 * Schlüssel einer wiederkehrenden Zahlung: Konto + Gegenpartei (verdichtet) + Betrag.
 * Dieselbe Gegenpartei kommt je nach Quelle verschieden geschrieben an
 * („AXA Lebensversicherung Aktiengesellschaft" aus dem PDF-Import,
 * „AXA Lebensversicherung AG" aus FinTS) — deshalb zählen nur die ersten
 * zwölf Buchstaben ohne Rechtsform.
 */
export function serienSchluessel(u: Umsatz): string {
  const g = (u.gegenpartei || u.zweck.slice(0, 30)).toLowerCase()
    .replace(/\b(gmbh|mbh|ag|aktiengesellschaft|kg|se|co|und|&|e\.?v\.?)\b/g, '')
    .replace(/[^a-z0-9äöüß]+/g, '')
    .slice(0, 12);
  return `${u.konto}|${g}|${u.betrag.toFixed(2)}`;
}

export interface Serie {
  schluessel: string;
  konto: number;
  gegenpartei: string;
  betrag: number;
  tag: number;            // typischer Buchungstag im Monat (Median)
  monate: string[];       // YYYY-MM, in denen sie lief
}

/** Typischer Tag im Monat `ym`, auf die Monatslänge begrenzt (Tag 31 im November → 30). */
function erwartetAm(ym: string, tag: number): Date {
  const [j, m] = ym.split('-').map(Number);
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return new Date(Date.UTC(j, m - 1, Math.min(tag, letzter)));
}

function monatVersetzt(s: Date, k: number): string {
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + k, 1)).toISOString().slice(0, 7);
}

/**
 * Erwartete monatliche Zahlungen: dieselbe Gegenpartei mit demselben Betrag in
 * drei aufeinanderfolgenden Monaten. Geprüft wird der laufende UND der
 * Vormonat: Eine Zahlung zum Monatsende (Tag 28) ist erst im Folgemonat
 * überfällig — würde nur der laufende Monat geprüft, fiele sie nie auf.
 */
export function ausgebliebeneSerien(umsaetze: Umsatz[], stichtag: string, toleranzTage = 5): Serie[] {
  const s = new Date(stichtag + 'T00:00:00Z');

  const gruppen = new Map<string, Umsatz[]>();
  for (const u of umsaetze) {
    const k = serienSchluessel(u);
    if (!gruppen.has(k)) gruppen.set(k, []);
    gruppen.get(k)!.push(u);
  }

  const fehlend: Serie[] = [];
  for (const [k, liste] of gruppen) {
    const monate = [...new Set(liste.map(u => u.datum.slice(0, 7)))].sort();
    for (const versatz of [0, -1]) {               // laufender Monat, dann Vormonat
      const pruefmonat = monatVersetzt(s, versatz);
      const vormonate = [-3, -2, -1].map(d => monatVersetzt(s, versatz + d));
      if (!vormonate.every(m => monate.includes(m))) continue;
      if (monate.includes(pruefmonat)) continue;
      const tage = liste.filter(u => vormonate.includes(u.datum.slice(0, 7)))
        .map(u => Number(u.datum.slice(8, 10))).sort((a, b) => a - b);
      const tag = tage[Math.floor(tage.length / 2)];
      const faelligBis = erwartetAm(pruefmonat, tag).getTime() + toleranzTage * 86_400_000;
      if (s.getTime() <= faelligBis) continue;
      fehlend.push({ schluessel: k, konto: liste[0].konto, gegenpartei: liste[0].gegenpartei, betrag: liste[0].betrag, tag, monate });
      break;
    }
  }
  return fehlend.sort((a, b) => a.betrag - b.betrag);
}

/**
 * Saldenprobe ohne bekannten Anfangsstand: „Anfangswert" = Banksaldo minus
 * Summe aller gespeicherten Umsätze. Er muss von Woche zu Woche gleich
 * bleiben. Ändert er sich, fehlen Umsätze oder sind doppelt — genau das
 * Muster der Schlüsselkollision vom 20.10.2026.
 */
export function anfangswert(banksaldo: number, summeUmsaetze: number): number {
  return Math.round((banksaldo - summeUmsaetze) * 100) / 100;
}

export function saldenUrteil(jetzt: number, vorher: number | undefined, erwartet?: number): string {
  /* Bei bekanntem Anfangsstand (Stromkonto MG24: 0,00 €) zählt nur dieser —
     der gespeicherte Bezug kann selbst schon eine Lücke enthalten. */
  if (erwartet !== undefined) {
    return Math.abs(jetzt - erwartet) < 0.01 ? 'stimmt' : `weicht um ${euro(jetzt - erwartet)} vom bekannten Anfangsstand ab`;
  }
  if (vorher === undefined) return 'erste Messung';
  if (Math.abs(jetzt - vorher) < 0.01) return 'stimmt';
  return `verschoben um ${euro(jetzt - vorher)} seit dem letzten Check`;
}
