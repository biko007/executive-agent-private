/**
 * sekretariat/lauf — Verstehen und Verknüpfen (Spec v1, Stufe 1 des Baus).
 *
 * Je Neuheit: Vorfilter (nur Offensichtliches, Gesundheit immer raus) →
 * zweites Netz (deterministisch) → KI-Bewertung mit Kontext → Vorgang
 * (Thread-IDs hart, sonst KI-Zuordnung oder neu) → Vorschlag. Was nicht
 * relevant ist, landet mit Begründung in der Nicht-relevant-Ablage.
 *
 * Speicher bis zur Migration (Tabellen `vorgaenge`, `vorgang_elemente`, Rote
 * Zone, wartet auf /arm): Dateien unter artifacts/personal/sekretariat/.
 *   elemente.json        Kennung → Element mit Statuskette und Bewertung
 *   vorgaenge.json       Vorgänge mit Elementen
 *   nicht-relevant.jsonl Ablage mit Begründung und Beleg
 *   kosten.jsonl         Tokens und geschätzte Kosten je Lauf
 *   laeufe.jsonl         Zähler je Stufe und Lauf (Statuskette)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ladeJson, schreibeJson } from '../neuheiten/bericht.js';
import { vorfilter, zweitesNetz, type Element, type NetzTreffer } from './element.js';
import { bewerteMitKi, kostenUsd, type Kontext, type KiClient } from './ki.js';
import { VORSCHLAG_TEXT, type Bewertung, type Vorschlag } from './schema.js';
import type { Regelwerk } from '../mail-register/relevanz.js';
import type { DokRegeln } from '../doc-register/relevanz.js';

export type Status = 'erfasst' | 'abgelegt' | 'wartet' | 'fehler' | 'vorschlag' | 'netz';

export interface ElementStand {
  kennung: string;
  typ: Element['typ'];
  quelle: string;
  datum: string;
  titel: string;
  von: string;
  messageId?: string;
  threadIds?: string[];
  status: Status;
  /** Zeitpunkte der Statuskette. */
  kette: Partial<Record<Status, string>>;
  vorfilter?: string;
  netz: NetzTreffer[];
  bewertung?: Bewertung;
  vorgang?: string;
  /** Ein Satz Begründung — Pflicht für jede Entscheidung (Spec, Sicherstellen 5). */
  begruendung: string;
  /** Mail-Kennung bzw. Dateipfad. */
  beleg: string;
  fehler?: string;
  /** KI-Versuche bisher (Obergrenze 3, dann Einzelmeldung). */
  versuche?: number;
  /** Solange nicht fertig bewertet: das Element selbst, damit ein späterer Lauf es bewerten kann. */
  wartend?: Element;
}

export interface Vorgang {
  kennung: string;
  titel: string;
  objekt: string | null;
  status: 'offen' | 'freigegeben' | 'erledigt' | 'abgelegt';
  erstellt: string;
  aktualisiert: string;
  frist: string | null;
  vorschlag: Vorschlag;
  naechsterSchritt: string;
  begruendung: string;
  elemente: string[];
}

interface Speicher {
  elemente: Record<string, ElementStand>;
  vorgaenge: Vorgang[];
}

export interface SekretariatDeps {
  zustand: string;
  regeln: Regelwerk;
  dokRegeln: DokRegeln;
  ki: KiClient;
  /** Kontext ohne die offenen Vorgänge — die ergänzt der Lauf. */
  kontext: Omit<Kontext, 'vorgaenge'>;
  /** Deckel: KI-Bewertungen je Stunde (Spec 60). `null` = ohne Deckel (Nachlauf). */
  deckelProStunde: number | null;
  jetzt?: Date;
  probe?: boolean;
  bankVersicherer?: RegExp;
  log?: (m: string) => void;
}

export interface Zaehler {
  erfasst: number;
  vorgefiltert: number;
  bewertet: number;
  abgelegtKi: number;
  vorschlag: number;
  netzEinzeln: number;
  wartet: number;
  fehler: number;
}

export interface LaufErgebnis {
  zaehler: Zaehler;
  /** Vorgänge, die in diesem Lauf neu entstanden oder ein Element bekamen. */
  vorgaenge: Vorgang[];
  /** Netz-Treffer ohne Vorgang (KI: nicht relevant) — immer melden. */
  einzeln: ElementStand[];
  tokensEin: number;
  tokensAus: number;
  kostenUsd: number;
  /** Lücke in der Statuskette oder KI-Fehler → Alarm. */
  alarm: string[];
  elemente: ElementStand[];
}

const P = (z: string) => ({
  elemente: path.join(z, 'elemente.json'),
  vorgaenge: path.join(z, 'vorgaenge.json'),
  nichtRelevant: path.join(z, 'nicht-relevant.jsonl'),
  kosten: path.join(z, 'kosten.jsonl'),
  laeufe: path.join(z, 'laeufe.jsonl'),
});

export function ladeSpeicher(zustand: string): Speicher {
  const p = P(zustand);
  return {
    elemente: ladeJson<Record<string, ElementStand>>(p.elemente, {}),
    vorgaenge: ladeJson<{ vorgaenge: Vorgang[] }>(p.vorgaenge, { vorgaenge: [] }).vorgaenge,
  };
}

export function vorgangKennung(titel: string, erstellt: string): string {
  return 'v-' + crypto.createHash('sha1').update(`${titel}|${erstellt}`).digest('hex').slice(0, 8);
}

/** Vorgänge der letzten 90 Tage für den Prompt. */
export function vorgangsListe(s: Speicher, jetzt: Date): string[] {
  const grenze = new Date(jetzt.getTime() - 90 * 86_400_000).toISOString();
  return s.vorgaenge.filter((v) => v.aktualisiert >= grenze && v.status !== 'abgelegt').map((v) => {
    const el = v.elemente.slice(-4).map((k) => s.elemente[k]).filter(Boolean)
      .map((e) => `${e.datum.slice(0, 10)} ${e.typ === 'mail' ? 'Mail' : 'Dok'} „${e.titel.slice(0, 60)}"`).join('; ');
    return `${v.kennung} | ${v.titel} | ${v.objekt ?? '–'} | ${el}`;
  });
}

/** Kosten-/Deckelzählung: KI-Aufrufe in der letzten Stunde (aus kosten.jsonl). */
export function aufrufeLetzteStunde(zustand: string, jetzt: Date): number {
  try {
    const grenze = jetzt.getTime() - 3_600_000;
    /* Kaputte Zeilen einzeln überspringen — sonst wäre der Deckel offen. */
    return fs.readFileSync(P(zustand).kosten, 'utf-8').split('\n').filter(Boolean)
      .map((z) => { try { return JSON.parse(z); } catch { return null; } })
      .filter((k) => k && Date.parse(k.zeit) > grenze)
      .reduce((a, k) => a + (Number(k.aufrufe) || 0), 0);
  } catch { return 0; }
}

/**
 * Thread-Regel (hart): Verweist die Mail (In-Reply-To/References) auf die
 * Message-ID eines Elements, das schon in einem Vorgang steht, gehört sie
 * dazu. Nur direkte Verweise auf eine bekannte Nachricht zählen — eine bloß
 * gemeinsame References-Kette (Ticketsysteme) führt nichts zusammen.
 */
export function vorgangPerThread(e: Element, s: Speicher): string | null {
  const ids = new Set((e.threadIds ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (!ids.size) return null;
  const treffer = Object.values(s.elemente)
    .filter((st) => st.vorgang && st.messageId && ids.has(st.messageId.trim().toLowerCase()))
    .sort((a, b) => b.datum.localeCompare(a.datum));
  return treffer[0]?.vorgang ?? null;
}

/** Zwischenstand sichern — nach jedem Element, damit ein Abbruch nichts verliert. */
function sichere(d: SekretariatDeps, s: Speicher): void {
  if (d.probe) return;
  const p = P(d.zustand);
  fs.mkdirSync(d.zustand, { recursive: true });
  schreibeJson(p.elemente, s.elemente);
  schreibeJson(p.vorgaenge, { vorgaenge: s.vorgaenge });
}
function haenge(d: SekretariatDeps, datei: 'nichtRelevant' | 'kosten', zeile: unknown): void {
  if (d.probe) return;
  fs.mkdirSync(d.zustand, { recursive: true });
  fs.appendFileSync(P(d.zustand)[datei], JSON.stringify(zeile) + '\n');
}

const MAX_VERSUCHE = 3;

export async function verarbeite(neu: Element[], d: SekretariatDeps): Promise<LaufErgebnis> {
  const jetzt = d.jetzt ?? new Date();
  const zeit = jetzt.toISOString();
  const log = d.log ?? (() => {});
  const s = ladeSpeicher(d.zustand);
  const z: Zaehler = { erfasst: 0, vorgefiltert: 0, bewertet: 0, abgelegtKi: 0, vorschlag: 0, netzEinzeln: 0, wartet: 0, fehler: 0 };
  const ergebnis: LaufErgebnis = { zaehler: z, vorgaenge: [], einzeln: [], tokensEin: 0, tokensAus: 0, kostenUsd: 0, alarm: [], elemente: [] };
  const beruehrt = new Set<string>();
  let aufrufe = 0;
  const schonAufrufe = d.deckelProStunde == null ? 0 : aufrufeLetzteStunde(d.zustand, jetzt);

  /* Offenes aus früheren Läufen (erfasst, wartet, fehler) kommt zuerst wieder
     dran; dann das Neue. Fertig Bewertetes wird nie zweimal angefasst. */
  const offen = Object.values(s.elemente).filter((x) => ['erfasst', 'wartet', 'fehler'].includes(x.status) && x.wartend)
    .map((x) => x.wartend!) as Element[];
  const liste = [...offen, ...neu.filter((e) => !s.elemente[e.kennung] || ['erfasst', 'wartet', 'fehler'].includes(s.elemente[e.kennung].status))]
    .filter((e, i, a) => a.findIndex((x) => x.kennung === e.kennung) === i)
    .map((e) => ({ ...e, titel: e.titel ?? '', datum: e.datum || zeit, text: e.text ?? '' }))
    .sort((a, b) => a.datum.localeCompare(b.datum));

  /* Erst alles als „erfasst" sichern — mit Inhalt. Bricht der Lauf danach ab,
     findet der nächste Lauf jede Neuheit wieder (Review 27.10.2026). */
  for (const e of liste) {
    const beleg = e.typ === 'mail' ? `${e.kennung} (${e.quelle})` : `${e.quelle}:${e.pfad ?? e.titel}`;
    s.elemente[e.kennung] ??= {
      kennung: e.kennung, typ: e.typ, quelle: e.quelle, datum: e.datum, titel: e.titel, von: e.von,
      messageId: e.messageId, threadIds: e.threadIds, status: 'erfasst', kette: { erfasst: zeit },
      netz: [], begruendung: '', beleg, wartend: e,
    };
    s.elemente[e.kennung].wartend = e;
  }
  sichere(d, s);

  for (const e of liste) {
    z.erfasst++;
    const st = s.elemente[e.kennung];
    delete st.fehler;

    const vf = vorfilter(e, d.regeln, d.dokRegeln);
    if (vf) {
      Object.assign(st, { status: 'abgelegt', vorfilter: vf, begruendung: `Vorfilter: ${vf}`, wartend: undefined });
      st.kette.abgelegt = zeit;
      z.vorgefiltert++;
      haenge(d, 'nichtRelevant', { zeit, kennung: e.kennung, titel: e.titel, von: e.von, grund: `Vorfilter: ${vf}`, beleg: st.beleg });
      sichere(d, s);
      continue;
    }
    st.netz = zweitesNetz(e, d.bankVersicherer);

    if (d.deckelProStunde != null && schonAufrufe + aufrufe >= d.deckelProStunde) {
      Object.assign(st, { status: 'wartet', begruendung: 'Deckel erreicht — nächster Lauf' });
      st.kette.wartet = zeit;
      z.wartet++;
      sichere(d, s);
      continue;
    }

    /* Thread-Regel VOR der Relevanz: eine Antwort im Thread gehört zum Vorgang,
       auch wenn das Modell sie für sich allein unwichtig findet. */
    const perThread = e.typ === 'mail' ? vorgangPerThread(e, s) : null;
    const kontext: Kontext = { ...d.kontext, vorgaenge: vorgangsListe(s, jetzt) };
    let antwort;
    try {
      antwort = await bewerteMitKi(e, kontext, d.ki);
    } catch (x: any) {
      antwort = { bewertung: null, fehler: String(x?.message ?? x).slice(0, 200), tokensEin: 0, tokensAus: 0, aufrufe: 1 };
    }
    aufrufe += antwort.aufrufe;
    ergebnis.tokensEin += antwort.tokensEin;
    ergebnis.tokensAus += antwort.tokensAus;
    haenge(d, 'kosten', { zeit: new Date().toISOString(), kennung: e.kennung, aufrufe: antwort.aufrufe, tokensEin: antwort.tokensEin,
      tokensAus: antwort.tokensAus, kostenUsd: kostenUsd(antwort.tokensEin, antwort.tokensAus), modell: 'claude-sonnet-4-6', deckel: d.deckelProStunde });

    if (!antwort.bewertung) {
      st.versuche = (st.versuche ?? 0) + 1;
      if (st.versuche >= MAX_VERSUCHE) {
        /* Nicht endlos wiederholen — aber auch nicht still verlieren: als
           Einzelmeldung mit dem Netz-Befund (Review 27.10.2026). */
        Object.assign(st, { status: 'netz', wartend: undefined, fehler: antwort.fehler ?? 'unbekannt',
          begruendung: `KI ${st.versuche}× nicht bewertbar${st.netz.length ? ` — Netz: ${st.netz.map((n) => n.grund).join(', ')}` : ''}` });
        st.kette.netz = zeit;
        z.netzEinzeln++;
        ergebnis.einzeln.push(st);
        ergebnis.alarm.push(`${e.kennung}: KI ${st.versuche}× fehlgeschlagen — als Einzelmeldung ausgegeben`);
      } else {
        Object.assign(st, { status: 'fehler', fehler: antwort.fehler ?? 'unbekannt', begruendung: 'KI-Bewertung fehlgeschlagen — nächster Lauf' });
        st.kette.fehler = zeit;
        z.fehler++;
      }
      sichere(d, s);
      continue;
    }
    const b = antwort.bewertung;
    z.bewertet++;
    st.bewertung = b;
    st.begruendung = b.begruendung;

    if (!b.relevant && !st.netz.length && !perThread) {
      Object.assign(st, { status: 'abgelegt', wartend: undefined });
      st.kette.abgelegt = zeit;
      z.abgelegtKi++;
      haenge(d, 'nichtRelevant', { zeit, kennung: e.kennung, titel: e.titel, von: e.von, grund: `KI: ${b.begruendung}`, beleg: st.beleg });
      sichere(d, s);
      continue;
    }
    if (!b.relevant && !perThread) {
      /* Zweites Netz schlägt an, die KI nicht: immer melden, als Einzelzeile. */
      Object.assign(st, { status: 'netz', wartend: undefined,
        begruendung: `Netz: ${st.netz.map((n) => n.grund).join(', ')} — KI: ${b.begruendung}` });
      st.kette.netz = zeit;
      z.netzEinzeln++;
      ergebnis.einzeln.push(st);
      sichere(d, s);
      continue;
    }

    /* Vorgang: Thread-ID hart, sonst KI (nur bestehende Kennung), sonst
       gleicher Titel und Objekt, sonst neu. */
    const perKi = b.vorgang.bestehend && s.vorgaenge.some((v) => v.kennung === b.vorgang.bestehend) ? b.vorgang.bestehend : null;
    const perTitel = s.vorgaenge.find((v) => v.titel.toLowerCase() === b.vorgang.titel.toLowerCase()
      && (v.objekt ?? '') === (b.objekt ?? ''))?.kennung ?? null;
    let v = s.vorgaenge.find((x) => x.kennung === (perThread ?? perKi ?? perTitel));
    if (!v) {
      v = { kennung: vorgangKennung(b.vorgang.titel, `${zeit}|${e.kennung}`), titel: b.vorgang.titel, objekt: b.objekt,
        status: 'offen', erstellt: zeit, aktualisiert: zeit, frist: null, vorschlag: b.vorschlag,
        naechsterSchritt: b.naechsterSchritt, begruendung: b.begruendung, elemente: [] };
      s.vorgaenge.push(v);
    }
    if (!v.elemente.includes(e.kennung)) v.elemente.push(e.kennung);
    v.aktualisiert = zeit;
    /* Das jüngste relevante Element bestimmt den nächsten Schritt; die früheste Frist gilt. */
    const juengstes = v.elemente.map((k) => s.elemente[k]?.datum ?? '').sort().slice(-1)[0] ?? '';
    if (b.relevant && e.datum >= juengstes) {
      v.vorschlag = b.vorschlag; v.naechsterSchritt = b.naechsterSchritt; v.begruendung = b.begruendung;
    }
    const fristen = [b.bis, ...b.fakten.fristen.map((f) => f.datum), v.frist].filter((x): x is string => !!x).sort();
    v.frist = fristen[0] ?? null;
    if (!v.objekt && b.objekt) v.objekt = b.objekt;
    Object.assign(st, { status: 'vorschlag', vorgang: v.kennung, wartend: undefined });
    st.kette.vorschlag = zeit;
    z.vorschlag++;
    beruehrt.add(v.kennung);
    sichere(d, s);
    log(`[sekretariat] ${e.kennung} → ${v.kennung} ${v.titel} (${b.vorschlag})${perThread ? ' [Thread]' : ''}`);
  }

  ergebnis.vorgaenge = s.vorgaenge.filter((v) => beruehrt.has(v.kennung));
  ergebnis.elemente = liste.map((e) => s.elemente[e.kennung]);
  ergebnis.kostenUsd = kostenUsd(ergebnis.tokensEin, ergebnis.tokensAus);

  /* Statuskette: Jede erfasste Neuheit muss genau einen Ausgang haben. */
  const ausgang = z.vorgefiltert + z.abgelegtKi + z.vorschlag + z.netzEinzeln + z.wartet + z.fehler;
  if (ausgang !== z.erfasst) ergebnis.alarm.push(`Statuskette lückenhaft: erfasst ${z.erfasst}, Ausgänge ${ausgang}`);
  if (z.fehler) ergebnis.alarm.push(`${z.fehler} KI-Bewertung(en) fehlgeschlagen — werden im nächsten Lauf wiederholt`);
  const altWartend = Object.values(s.elemente).filter((x) => ['wartet', 'erfasst'].includes(x.status)
    && jetzt.getTime() - Date.parse(x.kette.wartet ?? x.kette.erfasst ?? zeit) > 3 * 3_600_000).length;
  if (altWartend) ergebnis.alarm.push(`${altWartend} Neuheit(en) warten länger als 3 h auf die Bewertung`);

  if (!d.probe) {
    sichere(d, s);
    fs.appendFileSync(P(d.zustand).laeufe, JSON.stringify({ zeit, ...z, aufrufe, tokensEin: ergebnis.tokensEin,
      tokensAus: ergebnis.tokensAus, kostenUsd: ergebnis.kostenUsd, alarm: ergebnis.alarm }) + '\n');
  }
  return ergebnis;
}

/** Abgleich (Sicherstellen 1): Kennungen aus den Registern, die das Sekretariat nicht kennt. */
export function fehlendeKennungen(zustand: string, registerKennungen: string[]): string[] {
  const s = ladeSpeicher(zustand);
  return [...new Set(registerKennungen)].filter((k) => !s.elemente[k]);
}

export function vorschlagKurz(v: Pick<Vorgang, 'vorschlag'>): string {
  return `${v.vorschlag}) ${VORSCHLAG_TEXT[v.vorschlag]}`;
}
