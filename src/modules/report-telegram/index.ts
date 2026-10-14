/**
 * Telegram-Nachrichten der Report- und Inbox-Pipeline.
 *
 * ZIEL (Owner-Vorgabe 14.10.2026): Je Auftrag genau ZWEI Nachrichten — eine beim
 * Abholen, eine beim Abschluss. Vorher waren es bis zu fuenf: Quittung als
 * Dokument, Quittungstext, Report als Dokument, Reporttext oder Digest und die
 * Go-Nachricht mit Link.
 *
 * KEIN PROSA-PARSING. Die Zahlen und Saetze kommen aus einem festen Kopfblock am
 * Anfang jedes Reports (YAML-Frontmatter). Der Bot liest ihn und formt daraus die
 * Nachricht. Fehlt der Block, sagt die Nachricht das — geraten wird nichts.
 * Vorher las der Bot den Fliesstext und schnitt ihn zurecht; das Ergebnis hing
 * davon ab, wie ein Report formuliert war.
 */

/** Status eines abgeschlossenen Auftrags. */
export type Status = 'ok' | 'aktion' | 'hinweis' | 'fehler' | 'wartet';

export interface Kopfblock {
  /** `uebernahme` = Nachricht beim Abholen, `ergebnis` = Nachricht bei Abschluss. */
  typ: 'uebernahme' | 'ergebnis';
  titel: string;
  status: Status;
  aufgabe: string;
  ergebnis: string[];
  aktion: string;
  tests: 'ok' | 'fehler' | 'n/a';
  roteZone: boolean;
  dauerMin: number | null;
  /** Nur bei typ = uebernahme. */
  datei?: string;
  zeit?: string;
  warteschlange?: string;
  /** true, wenn kein Kopfblock gefunden wurde und Vorgabewerte gelten. */
  fehlt?: boolean;
}

const SYMBOLE: Record<Status, string> = {
  ok: '✅',
  aktion: '👉',
  hinweis: '⚠️',
  fehler: '❌',
  wartet: '⏸',
};

export function statusSymbol(s: Status): string {
  return SYMBOLE[s] ?? SYMBOLE.hinweis;
}

/** Telegram-HTML vertraegt nur &, < und > maskiert. Mehr nicht — und nicht weniger. */
export function htmlEscape(roh: unknown): string {
  return String(roh ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Dateiname ohne die Praefixe, die beim Weg durch Dropbox und Inbox entstehen.
 *
 * Aus `2026-10-13T12-10-20-922Z-dropbox-20261013-140920-mg24-pellet.txt` wird
 * `mg24-pellet.txt`. Der Owner liest den Auftragsnamen, nicht die Transportspur.
 */
export function dateiKlartext(name: string): string {
  let n = String(name || '').trim();
  n = n.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '');          // ISO-Zeitstempel
  n = n.replace(/^dropbox-\d{8}-\d{6}-/, '');                 // Dropbox-Uebergabe
  n = n.replace(/^\d{8}-\d{6}-/, '');                         // blanker Zeitstempel
  return n;
}

/** Kuerzt auf hoechstens `max` Zeichen und setzt ein Auslassungszeichen. */
export function kuerzen(text: string, max: number): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/* ── Kopfblock lesen ─────────────────────────────────────────────────────── */

/**
 * Maskierungen aufloesen, die innerhalb von Anfuehrungszeichen noetig sind.
 *
 * Aufgefallen am 14.10.2026 an der eigenen Testnachricht: `"Knopf \\"claude.ai\\"
 * neben dem Kopierknopf"` kam mit sichtbaren Rueckstrichen beim Owner an. Wer
 * einen Begriff im Kopfblock in Anfuehrungszeichen setzt, muss sie maskieren —
 * dann muessen sie hier auch wieder verschwinden.
 */
function entmaskieren(w: string): string {
  return w.replace(/\\(["'\\])/g, '$1');
}

/** Eine Zeile `schluessel: wert` — Anfuehrungszeichen aussen werden entfernt. */
function wertVon(zeile: string): [string, string] | null {
  const m = zeile.match(/^([a-z_]+):\s*(.*)$/);
  if (!m) return null;
  let w = m[2].trim();
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) {
    w = w.slice(1, -1);
  }
  return [m[1], entmaskieren(w)];
}

/** Liste in der Form `[ "a", "b" ]` oder als Folge von `- a`-Zeilen. */
function listeVon(wert: string, folgezeilen: string[]): string[] {
  const w = wert.trim();
  if (w.startsWith('[')) {
    const innen = w.replace(/^\[/, '').replace(/\]$/, '');
    /* Trennt nur an Anfuehrungszeichen, denen KEIN Rueckstrich vorangeht —
       sonst zerfaellt ein Eintrag mit maskiertem Zitat in zwei. */
    return innen.split(/(?<!\\)",\s*"|(?<!\\)',\s*'/)
      .map(s => entmaskieren(s.replace(/^\s*["']?/, '').replace(/["']?\s*$/, '').trim()))
      .filter(Boolean);
  }
  return folgezeilen
    .filter(z => /^\s*-\s+/.test(z))
    .map(z => z.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

/**
 * Liest den Kopfblock aus einem Report.
 *
 * Erwartet `---` in der ERSTEN Zeile und ein zweites `---` als Abschluss. Steht
 * dort nichts, liefert die Funktion null; die Nachricht faellt dann auf den
 * Dateinamen zurueck und meldet „Kopfblock fehlt".
 */
export function kopfblockLesen(markdown: string): Kopfblock | null {
  const text = String(markdown ?? '');
  const zeilen = text.split('\n');
  if (zeilen[0]?.trim() !== '---') return null;
  const ende = zeilen.findIndex((z, i) => i > 0 && z.trim() === '---');
  if (ende < 1) return null;

  const block = zeilen.slice(1, ende);
  const felder = new Map<string, string>();
  let ergebnis: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const p = wertVon(block[i]);
    if (!p) continue;
    const [k, v] = p;
    if (k === 'ergebnis') ergebnis = listeVon(v, block.slice(i + 1));
    else felder.set(k, v);
  }

  const status = (felder.get('status') || 'hinweis').toLowerCase();
  const gueltig: Status[] = ['ok', 'aktion', 'hinweis', 'fehler', 'wartet'];
  const typ = (felder.get('typ') || 'ergebnis') === 'uebernahme' ? 'uebernahme' : 'ergebnis';
  const tests = (felder.get('tests') || 'n/a').toLowerCase();
  const dauer = felder.get('dauer_min');

  return {
    typ,
    titel: felder.get('titel') || '',
    status: (gueltig as string[]).includes(status) ? status as Status : 'hinweis',
    aufgabe: felder.get('aufgabe') || '',
    ergebnis,
    aktion: felder.get('aktion') || 'keine',
    tests: ['ok', 'fehler', 'n/a'].includes(tests) ? tests as any : 'n/a',
    roteZone: /^(ja|true|yes)$/i.test(felder.get('rote_zone') || ''),
    dauerMin: dauer && /^\d+$/.test(dauer) ? parseInt(dauer, 10) : null,
    datei: felder.get('datei'),
    zeit: felder.get('zeit'),
    warteschlange: felder.get('warteschlange'),
  };
}

/* ── Nachricht 1: Abholen ────────────────────────────────────────────────── */

export function uebernahmeNachricht(k: Kopfblock): string {
  const zeilen = [
    '📥 <b>Aufgabe übernommen</b>',
    htmlEscape(k.titel || '(ohne Titel)'),
  ];
  if (k.datei) zeilen.push(`📄 ${htmlEscape(dateiKlartext(k.datei))}`);
  const warte = k.warteschlange?.trim() || 'leer';
  zeilen.push(`🕐 ${htmlEscape(k.zeit || '')} · Warteschlange: ${htmlEscape(warte)}`);
  return zeilen.join('\n');
}

/* ── Nachricht 2: Abschluss ──────────────────────────────────────────────── */

export const ERGEBNIS_MAX = 800;

/**
 * Baut die Abschlussnachricht.
 *
 * Reihenfolge nach Owner-Vorgabe: Bei Status `aktion` steht „Ihre Aktion"
 * unmittelbar unter dem Titel — wer handeln muss, soll es im ersten Blick sehen
 * und nicht erst nach drei Spiegelstrichen.
 */
export function ergebnisNachricht(k: Kopfblock, dateiname: string): string {
  const titel = htmlEscape(k.titel || dateiKlartext(dateiname));
  const zeilen: string[] = [`${statusSymbol(k.status)} <b>Ergebnis</b> · ${titel}`];

  const aktionText = (k.aktion || 'keine').trim();
  const aktionZeile = `<b>Ihre Aktion:</b> ${htmlEscape(aktionText)}`;
  if (k.status === 'aktion') zeilen.push(aktionZeile);

  if (k.aufgabe) zeilen.push(`<b>Aufgabe:</b> ${htmlEscape(k.aufgabe)}`);
  if (k.ergebnis.length > 0) {
    zeilen.push('<b>Ergebnis:</b>');
    for (const e of k.ergebnis.slice(0, 3)) zeilen.push(`• ${htmlEscape(e)}`);
  }
  if (k.status !== 'aktion') zeilen.push(aktionZeile);

  const tests = k.tests === 'ok' ? 'Tests ✓' : k.tests === 'fehler' ? 'Tests ✗' : 'Tests –';
  const fuss = [tests, `Rote Zone: ${k.roteZone ? 'ja' : 'nein'}`];
  if (k.dauerMin !== null) fuss.push(`${k.dauerMin} Min.`);
  zeilen.push(`⚙️ ${fuss.join(' · ')}`);

  return kuerzen(zeilen.join('\n'), ERGEBNIS_MAX);
}

/* ── Knoepfe unter der Ergebnisnachricht ─────────────────────────────────── */

export const CLAUDE_URL = 'https://claude.ai/new';

/** Vollstaendiger Go-Befehl: Grundbefehl plus Dateiname des Reports. */
export function goBefehl(dateiname: string): string {
  const basis = String(dateiname || '').split('/').pop()?.trim() ?? '';
  return basis ? `go bikosoc ${basis}` : 'go bikosoc';
}

/**
 * Inline-Keyboard der Ergebnisnachricht: Kopierknopf, dann Link.
 *
 * WARUM DER LINK EIN KNOPF IST (Owner-Korrektur 14.10.2026): In der alten Form
 * stand `https://claude.ai/new` als Textzeile in der Go-Nachricht. Die ist
 * entfallen, der Link wurde dabei versehentlich mit entfernt — er wird aber
 * gebraucht: Der Owner tippt den Befehl in die Zwischenablage und braucht
 * unmittelbar danach die Claude-App. Als URL-Knopf steht er in derselben
 * Nachricht und oeffnet die App statt Safari.
 *
 * UNTEREINANDER, NICHT NEBENEINANDER (Owner 14.10.2026): Nebeneinander teilen
 * sich beide Knoepfe die Zeilenbreite und werden schmal — auf dem Telefon trifft
 * man sie schlechter, und der Kopierknopf ist der, der oft getippt wird. Jeder
 * Knopf bekommt deshalb eine eigene Zeile und damit die volle Breite. Die
 * Reihenfolge bleibt fest: erst kopieren, dann oeffnen, wie der Owner arbeitet.
 */
export function ergebnisKnoepfe(dateiname: string): unknown {
  return {
    inline_keyboard: [
      [{ text: 'go bikosoc kopieren', copy_text: { text: goBefehl(dateiname) } }],
      [{ text: 'claude.ai', url: CLAUDE_URL }],
    ],
  };
}

/** Ersatz-Kopfblock, wenn der Report keinen traegt. */
export function kopfblockFallback(dateiname: string): Kopfblock {
  return {
    typ: 'ergebnis',
    titel: dateiKlartext(dateiname).replace(/^report-/, '').replace(/\.md$/, ''),
    status: 'hinweis',
    aufgabe: 'Kopfblock fehlt — Angaben konnten nicht gelesen werden.',
    ergebnis: [],
    aktion: 'Report im Anhang lesen',
    tests: 'n/a',
    roteZone: false,
    dauerMin: null,
    fehlt: true,
  };
}
