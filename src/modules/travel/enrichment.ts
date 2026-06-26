/**
 * travel/enrichment — AI-powered trip enrichment, free-text parsing, booking analysis.
 */
import { fetchWithTimeout, readAnthropicKey, ANTHROPIC_MODEL } from '../../shared/utils/index.js';
import type { TripEnrichment, TripParseResult, ParsedBooking, BookingType } from './types.js';
import { BOOKING_EMOJI } from './types.js';

// ── AI Trip Enrichment ─────────────────────────────────────────────────────

export async function enrichTripWithOpenAI(name: string): Promise<TripEnrichment> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt (in ~/.config/openclaw/env eintragen)');

  const prompt =
    `Du hilfst bei der Reiseplanung. Der Nutzer plant eine Reise nach "${name}".\n` +
    `Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text davor/danach):\n` +
    `{\n` +
    `  "destination": "<Hauptstadt oder bekannteste Stadt des Ziels>",\n` +
    `  "country": "<Land auf Deutsch>",\n` +
    `  "country_code": "<ISO-3166-1-Alpha-2-Ländercode, z.B. JP>",\n` +
    `  "lat": <Breitengrad der Destination als Dezimalzahl, z.B. 35.6895>,\n` +
    `  "lon": <Längengrad der Destination als Dezimalzahl, z.B. 139.6917>,\n` +
    `  "climate": "<eines von: tropical|temperate|cold|desert|mixed>",\n` +
    `  "activities": ["<eines oder mehrere von: business|leisure|outdoor|beach|city>"],\n` +
    `  "currency": "<Währungsname und Symbol, z.B. Japanischer Yen (¥)>",\n` +
    `  "visa_de": "<Visapflicht für deutschen Pass, z.B. 'kein Visum erforderlich (bis 90 Tage)'>",\n` +
    `  "distance_km": <Luftlinie in km von Tuttlingen (48.0641°N, 8.8236°E) als ganze Zahl>,\n` +
    `  "travel_mode": "<Empfohlenes Hauptverkehrsmittel, z.B. Flugzeug, Zug, Auto>",\n` +
    `  "door_to_door_estimate": "<Haustür-zu-Haustür Zeitschätzung ab Tuttlingen, z.B. 'ca. 14-16 Stunden (Flug FRA + Transfers)'>",\n` +
    `  "exchange_rate_eur": "<Wechselkurs: wie viel Landeswährung bekommt man für 1 EUR, z.B. '1 EUR ≈ 160 JPY' oder '1 EUR ≈ 1,08 USD'>"\n` +
    `}`;

  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    30000
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const content: string = data?.content?.[0]?.text || '';

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Anthropic: kein JSON in Antwort — ${content.slice(0, 200)}`);

  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e: any) {
    throw new Error(`Anthropic: JSON parse fehlgeschlagen — ${e.message}`);
  }

  return {
    destination:           String(parsed.destination || name),
    country_code:          String(parsed.country_code || '').toUpperCase(),
    lat:                   Number(parsed.lat) || 0,
    lon:                   Number(parsed.lon) || 0,
    climate:               String(parsed.climate || 'temperate'),
    activities:            Array.isArray(parsed.activities) ? parsed.activities.map(String) : ['leisure'],
    currency:              String(parsed.currency || ''),
    visa_de:               String(parsed.visa_de || ''),
    distance_km:           Number(parsed.distance_km) || 0,
    travel_mode:           String(parsed.travel_mode || ''),
    door_to_door_estimate: String(parsed.door_to_door_estimate || ''),
    exchange_rate_eur:     String(parsed.exchange_rate_eur || ''),
  };
}

// ── Free-text → date parser (Anthropic) ────────────────────────────────────

export async function parseTripFreeText(
  text: string
): Promise<TripParseResult | { unclear: true; question: string }> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const todayBerlin = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Compute concrete Monday anchors so Haiku has no ambiguity
  const [ty, tm, td] = todayBerlin.split('-').map(Number);
  const todayUtc = new Date(Date.UTC(ty, tm - 1, td));
  const isoDow = todayUtc.getUTCDay() === 0 ? 7 : todayUtc.getUTCDay(); // Mon=1…Sun=7
  const daysToNextMon = 8 - isoDow; // always 2..8
  const msDay = 86_400_000;
  const nextMonMs     = todayUtc.getTime() + daysToNextMon * msDay;
  const nextNextMonMs = nextMonMs + 7 * msDay;
  const monNext     = new Date(nextMonMs).toISOString().slice(0, 10);
  const monNextNext = new Date(nextNextMonMs).toISOString().slice(0, 10);

  const prompt =
    `Heute ist der ${todayBerlin} (Wochentag: ${['So','Mo','Di','Mi','Do','Fr','Sa'][todayUtc.getUTCDay()]}, Zeitzone Europe/Berlin).\n\n` +
    `WICHTIG — Deutsche Wochenreferenzen (verbindlich):\n` +
    `  "nächste Woche"      = Montag ${monNext} bis Sonntag (7 Tage ab ${monNext})\n` +
    `  "übernächste Woche"  = Montag ${monNextNext} bis Sonntag — das ist ZWEI Wochen ab heute, NICHT eine\n` +
    `  "übermorgen"         = ${new Date(todayUtc.getTime() + 2 * msDay).toISOString().slice(0, 10)}\n` +
    `  "Anfang <Monat>"     = 1. des Monats\n` +
    `  "Mitte <Monat>"      = 15. des Monats\n` +
    `  "Ende <Monat>"       = letzter Tag des Monats\n` +
    `  "nächsten <Wochentag>"     = der kommende <Wochentag> in der Woche ab ${monNext}\n` +
    `  "übernächsten <Wochentag>" = der <Wochentag> in der Woche ab ${monNextNext}\n\n` +
    `Der Nutzer beschreibt eine Reise in freiem Text:\n` +
    `"${text}"\n\n` +
    `Extrahiere Reiseziel, Startdatum und Enddatum. Wende die obigen Regeln exakt an.\n` +
    `Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text davor/danach).\n\n` +
    `Wenn alle drei Felder eindeutig erkennbar sind:\n` +
    `{ "destination": "<Reiseziel>", "start": "<YYYY-MM-DD>", "end": "<YYYY-MM-DD>" }\n\n` +
    `Wenn etwas unklar oder fehlend ist:\n` +
    `{ "unclear": true, "question": "<kurze Rückfrage auf Deutsch>" }`;

  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    20000
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const content: string = data?.content?.[0]?.text || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Haiku: kein JSON in Antwort — ${content.slice(0, 200)}`);

  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e: any) {
    throw new Error(`Haiku: JSON parse fehlgeschlagen — ${e.message}`);
  }

  if (parsed.unclear) {
    return { unclear: true, question: String(parsed.question || 'Bitte Reiseziel und Daten angeben.') };
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!parsed.destination || !dateRe.test(parsed.start) || !dateRe.test(parsed.end)) {
    return { unclear: true, question: 'Ich konnte Ziel oder Datum nicht eindeutig erkennen. Bitte nochmal mit Reiseziel und konkreten Daten.' };
  }

  return {
    destination: String(parsed.destination),
    start: String(parsed.start),
    end: String(parsed.end),
  };
}

// ── Mail Booking Analysis (Haiku) ──────────────────────────────────────────

export async function analyzeMailForBooking(subject: string, from: string, bodyText: string): Promise<ParsedBooking | null> {
  const apiKey = readAnthropicKey();
  if (!apiKey) return null;

  const prompt =
    `Analysiere die folgende E-Mail. Handelt es sich um eine Reise-Buchungsbestätigung ` +
    `(Flug, Hotel, Bahn, Mietwagen, Event/Veranstaltung)?\n\n` +
    `Falls JA, antworte NUR mit einem JSON-Objekt:\n` +
    `{\n` +
    `  "type": "FLIGHT" | "HOTEL" | "TRAIN" | "CAR" | "EVENT",\n` +
    `  "title": "<Kurzbezeichnung, z.B. 'LH1234 München → Frankfurt'>",\n` +
    `  "destination": "<Zielort>",\n` +
    `  "startDate": "<ISO8601 Datum/Zeit>",\n` +
    `  "endDate": "<ISO8601 Datum/Zeit oder null>",\n` +
    `  "confirmationNumber": "<Buchungsnummer oder null>",\n` +
    `  "provider": "<Anbieter, z.B. Lufthansa, Booking.com>"\n` +
    `}\n\n` +
    `Falls NEIN (Newsletter, Werbung, normale Korrespondenz), antworte NUR mit: null\n\n` +
    `--- E-Mail ---\n` +
    `Von: ${from}\n` +
    `Betreff: ${subject}\n\n` +
    `${bodyText.slice(0, 3000)}\n` +
    `--- Ende ---`;

  try {
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      30000,
    );

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[travel] Haiku booking-analysis HTTP ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    const data: any = await res.json();
    const content: string = data?.content?.[0]?.text || '';

    // "null" response means no booking
    if (content.trim() === 'null' || content.trim() === '`null`') return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: any = JSON.parse(jsonMatch[0]);

    const validTypes: BookingType[] = ['FLIGHT', 'HOTEL', 'TRAIN', 'CAR', 'EVENT'];
    const type = validTypes.includes(parsed.type) ? parsed.type as BookingType : null;
    if (!type) return null;

    return {
      type,
      title: String(parsed.title || subject),
      destination: String(parsed.destination || ''),
      startDate: String(parsed.startDate || ''),
      endDate: parsed.endDate ? String(parsed.endDate) : null,
      confirmationNumber: parsed.confirmationNumber ? String(parsed.confirmationNumber) : null,
      provider: String(parsed.provider || ''),
    };
  } catch (e: any) {
    console.warn(`[travel] analyzeMailForBooking Fehler: ${e.message}`);
    return null;
  }
}

// ── Booking Message Formatting ─────────────────────────────────────────────

export function formatBookingMessage(booking: ParsedBooking): string {
  const emoji = BOOKING_EMOJI[booking.type] || '📧';
  const lines = [`${emoji} *Buchungsbestätigung erkannt*`];
  lines.push(`${booking.provider} — ${booking.title}`);

  if (booking.startDate) {
    try {
      const start = new Date(booking.startDate);
      const fmtDate = new Intl.DateTimeFormat('de-DE', {
        weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
      }).format(start);
      let dateLine = fmtDate;
      if (booking.endDate) {
        const end = new Date(booking.endDate);
        const fmtEnd = new Intl.DateTimeFormat('de-DE', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
        }).format(end);
        dateLine += ` → ${fmtEnd}`;
      }
      lines.push(dateLine);
    } catch {
      lines.push(booking.startDate);
    }
  }

  if (booking.destination) lines.push(`Ziel: ${booking.destination}`);
  if (booking.confirmationNumber) lines.push(`Bestätigung: ${booking.confirmationNumber}`);

  return lines.join('\n');
}
