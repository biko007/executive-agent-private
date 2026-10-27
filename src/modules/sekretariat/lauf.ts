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
  /** Nur solange es wartet: das Element selbst, damit der nächste Lauf es bewerten kann. */
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
    return fs.readFileSync(P(zustand).kosten, 'utf-8').split('\n').filter(Boolean)
      .map((z) => JSON.parse(z)).filter((k) => Date.parse(k.zeit) > grenze)
      .reduce((a, k) => a + (k.aufrufe ?? 0), 0);
  } catch { return 0; }
}

/** Thread-Regel (hart): gehört eine der Thread-IDs zu einem Element mit Vorgang? */
export function vorgangPerThread(e: Element, s: Speicher): string | null {
  const ids = new Set((e.threadIds ?? []).map((x) => x.trim().toLowerCase()));
  if (!ids.size) return null;
  for (const st of Object.values(s.elemente)) {
    if (!st.vorgang) continue;
    const mid = st.messageId?.trim().toLowerCase();
    if (mid && ids.has(mid)) return st.vorgang;
    /* Auch umgekehrt: Ein früheres Element verweist auf diese Mail? Dann nicht —
       nur Vorgänger zählen. Gleicher Thread-Anfang (erste References-ID) zählt. */
    if (st.threadIds?.length && e.threadIds?.length
      && st.threadIds[0].toLowerCase() === e.threadIds[0].toLowerCase()) return st.vorgang;
  }
  return null;
}

export async function verarbeite(neu: Element[], d: SekretariatDeps): Promise<LaufErgebnis> {
  const jetzt = d.jetzt ?? new Date();
  const zeit = jetzt.toISOString();
  const log = d.log ?? (() => {});
  const s = ladeSpeicher(d.zustand);
  const z: Zaehler = { erfasst: 0, vorgefiltert: 0, bewertet: 0, abgelegtKi: 0, vorschlag: 0, netzEinzeln: 0, wartet: 0, fehler: 0 };
  const ergebnis: LaufErgebnis = { zaehler: z, vorgaenge: [], einzeln: [], tokensEin: 0, tokensAus: 0, kostenUsd: 0, alarm: [], elemente: [] };
  const beruehrt = new Set<string>();
  const nichtRelevant: unknown[] = [];
  let aufrufe = 0;
  const schonAufrufe = d.deckelProStunde == null ? 0 : aufrufeLetzteStunde(d.zustand, jetzt);

  /* Wartende aus früheren Läufen kommen zuerst wieder dran; dann das Neue.
     Fertig Bewertetes wird nie zweimal angefasst. */
  const wartende = Object.values(s.elemente).filter((x) => (x.status === 'wartet' || x.status === 'fehler') && x.wartend)
    .map((x) => x.wartend!) as Element[];
  const liste = [...wartende, ...neu.filter((e) => !s.elemente[e.kennung]
    || s.elemente[e.kennung].status === 'erfasst')]
    .filter((e, i, a) => a.findIndex((x) => x.kennung === e.kennung) === i)
    .sort((a, b) => a.datum.localeCompare(b.datum));

  for (const e of liste) {
    z.erfasst++;
    const beleg = e.typ === 'mail' ? `${e.kennung} (${e.quelle})` : `${e.quelle}:${e.pfad ?? e.titel}`;
    const st: ElementStand = s.elemente[e.kennung] ?? {
      kennung: e.kennung, typ: e.typ, quelle: e.quelle, datum: e.datum, titel: e.titel, von: e.von,
      messageId: e.messageId, threadIds: e.threadIds, status: 'erfasst', kette: { erfasst: zeit },
      netz: [], begruendung: '', beleg,
    };
    s.elemente[e.kennung] = st;
    delete st.fehler;

    const vf = vorfilter(e, d.regeln, d.dokRegeln);
    if (vf) {
      Object.assign(st, { status: 'abgelegt', vorfilter: vf, begruendung: `Vorfilter: ${vf}`, wartend: undefined });
      st.kette.abgelegt = zeit;
      z.vorgefiltert++;
      nichtRelevant.push({ zeit, kennung: e.kennung, titel: e.titel, von: e.von, grund: `Vorfilter: ${vf}`, beleg });
      continue;
    }
    st.netz = zweitesNetz(e, d.bankVersicherer);

    if (d.deckelProStunde != null && schonAufrufe + aufrufe >= d.deckelProStunde) {
      Object.assign(st, { status: 'wartet', begruendung: 'Deckel erreicht — nächster Lauf', wartend: e });
      st.kette.wartet = zeit;
      z.wartet++;
      continue;
    }

    const kontext: Kontext = { ...d.kontext, vorgaenge: vorgangsListe(s, jetzt) };
    let antwort;
    try {
      aufrufe++;
      antwort = await bewerteMitKi(e, kontext, d.ki);
    } catch (x: any) {
      antwort = { bewertung: null, fehler: String(x?.message ?? x).slice(0, 200), tokensEin: 0, tokensAus: 0 };
    }
    ergebnis.tokensEin += antwort.tokensEin;
    ergebnis.tokensAus += antwort.tokensAus;
    if (!antwort.bewertung) {
      Object.assign(st, { status: 'fehler', fehler: antwort.fehler ?? 'unbekannt', begruendung: 'KI-Bewertung fehlgeschlagen — nächster Lauf', wartend: e });
      st.kette.fehler = zeit;
      z.fehler++;
      continue;
    }
    const b = antwort.bewertung;
    z.bewertet++;
    st.bewertung = b;
    st.begruendung = b.begruendung;

    if (!b.relevant && !st.netz.length) {
      Object.assign(st, { status: 'abgelegt', wartend: undefined });
      st.kette.abgelegt = zeit;
      z.abgelegtKi++;
      nichtRelevant.push({ zeit, kennung: e.kennung, titel: e.titel, von: e.von, grund: `KI: ${b.begruendung}`, beleg });
      continue;
    }
    if (!b.relevant) {
      /* Zweites Netz schlägt an, die KI nicht: immer melden, als Einzelzeile. */
      Object.assign(st, { status: 'netz', wartend: undefined,
        begruendung: `Netz: ${st.netz.map((n) => n.grund).join(', ')} — KI: ${b.begruendung}` });
      st.kette.netz = zeit;
      z.netzEinzeln++;
      ergebnis.einzeln.push(st);
      continue;
    }

    /* Vorgang: Thread-ID hart, sonst KI (nur bestehende Kennung), sonst
       gleicher Titel und Objekt, sonst neu. */
    const perThread = e.typ === 'mail' ? vorgangPerThread(e, s) : null;
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
    /* Das jüngste Element bestimmt den nächsten Schritt; die früheste Frist gilt. */
    if (e.datum >= (v.elemente.map((k) => s.elemente[k]?.datum ?? '').sort().slice(-1)[0] ?? '')) {
      v.vorschlag = b.vorschlag; v.naechsterSchritt = b.naechsterSchritt; v.begruendung = b.begruendung;
    }
    const fristen = [b.bis, ...b.fakten.fristen.map((f) => f.datum), v.frist].filter((x): x is string => !!x).sort();
    v.frist = fristen[0] ?? null;
    if (!v.objekt && b.objekt) v.objekt = b.objekt;
    Object.assign(st, { status: 'vorschlag', vorgang: v.kennung, wartend: undefined });
    st.kette.vorschlag = zeit;
    z.vorschlag++;
    beruehrt.add(v.kennung);
    log(`[sekretariat] ${e.kennung} → ${v.kennung} ${v.titel} (${b.vorschlag})${perThread ? ' [Thread]' : ''}`);
  }

  ergebnis.vorgaenge = s.vorgaenge.filter((v) => beruehrt.has(v.kennung));
  ergebnis.elemente = liste.map((e) => s.elemente[e.kennung]);
  ergebnis.kostenUsd = kostenUsd(ergebnis.tokensEin, ergebnis.tokensAus);

  /* Statuskette: Jede erfasste Neuheit muss genau einen Ausgang haben. */
  const ausgang = z.vorgefiltert + z.abgelegtKi + z.vorschlag + z.netzEinzeln + z.wartet + z.fehler;
  if (ausgang !== z.erfasst) ergebnis.alarm.push(`Statuskette lückenhaft: erfasst ${z.erfasst}, Ausgänge ${ausgang}`);
  if (z.bewertet !== z.abgelegtKi + z.vorschlag + z.netzEinzeln) ergebnis.alarm.push(`bewertet ${z.bewertet} ≠ abgelegt+Vorschlag+Netz`);
  if (z.fehler) ergebnis.alarm.push(`${z.fehler} KI-Bewertung(en) fehlgeschlagen — werden im nächsten Lauf wiederholt`);
  const altWartend = Object.values(s.elemente).filter((x) => x.status === 'wartet' && x.kette.wartet
    && jetzt.getTime() - Date.parse(x.kette.wartet) > 3 * 3_600_000).length;
  if (altWartend) ergebnis.alarm.push(`${altWartend} Neuheit(en) warten länger als 3 h auf die KI (Deckel)`);

  if (!d.probe) {
    const p = P(d.zustand);
    fs.mkdirSync(d.zustand, { recursive: true });
    schreibeJson(p.elemente, s.elemente);
    schreibeJson(p.vorgaenge, { vorgaenge: s.vorgaenge });
    if (nichtRelevant.length) fs.appendFileSync(p.nichtRelevant, nichtRelevant.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.appendFileSync(p.kosten, JSON.stringify({ zeit, aufrufe, tokensEin: ergebnis.tokensEin, tokensAus: ergebnis.tokensAus,
      kostenUsd: ergebnis.kostenUsd, modell: 'claude-sonnet-4-6', deckel: d.deckelProStunde }) + '\n');
    fs.appendFileSync(p.laeufe, JSON.stringify({ zeit, ...z, alarm: ergebnis.alarm }) + '\n');
  }
  return ergebnis;
}

export function vorschlagKurz(v: Pick<Vorgang, 'vorschlag'>): string {
  return `${v.vorschlag}) ${VORSCHLAG_TEXT[v.vorschlag]}`;
}
