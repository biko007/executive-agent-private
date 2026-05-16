/**
 * travel/commands — Telegram command handlers for Travel module.
 */
import crypto from 'node:crypto';
import {
  createTrip, getTrip, listTrips, addSegment, removeSegment,
  updateSegment, updateTrip, generatePacklist,
} from './store.js';
import { enrichTripWithOpenAI, parseTripFreeText } from './enrichment.js';
import { fetchWeatherForecast } from './weather.js';
import type { ParsedBooking, TripParseResult } from './types.js';
import { SEGMENT_EMOJI, BOOKING_TO_SEGMENT, BOOKING_EMOJI } from './types.js';

// ── Dependency Injection ───────────────────────────────────────────────────

export interface TravelDeps {
  sendTelegram: (chatId: string, text: string) => Promise<any>;
  sendTelegramWithKeyboard: (chatId: string, text: string, keyboard: any[][]) => Promise<any>;
  answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
  graphPost: (tenantId: string, clientId: string, secret: string, url: string, body: any) => Promise<any>;
  graphDelete: (tenantId: string, clientId: string, secret: string, url: string) => Promise<void>;
  getLinksForEntity: (entityType: string, entityId: string) => Promise<any[]>;
  formatLinksForTelegram: (links: any[]) => string;
  m365Enabled: boolean;
  tenantId: string;
  clientId: string;
  m365Secret: string;
  m365User: string;
}

let deps: TravelDeps;

export function initTravelCommands(d: TravelDeps): void {
  deps = d;
}

// ── Pending State (Telegram Inline Keyboard) ───────────────────────────────

const pendingSegmentDeletions = new Map<string, {
  tripId: string;
  segmentId: string;
  calendarEventId: string;
  expiresAt: number;
}>();

// ── Calendar Sync for Trip Segments ────────────────────────────────────────

async function createSegmentCalendarEvent(
  tripId: string,
  segmentId: string,
): Promise<{ eventId: string; webLink: string } | null> {
  if (!deps.m365Enabled || !deps.tenantId || !deps.clientId || !deps.m365Secret || !deps.m365User) return null;
  const trip = getTrip(tripId);
  if (!trip) return null;
  const seg = trip.segments.find(s => s.id === segmentId);
  if (!seg) return null;

  const emoji = SEGMENT_EMOJI[seg.type] || '📋';
  const subject = `${trip.name} — ${emoji} ${seg.title}`;
  const isHotel = seg.type === 'hotel';
  const startDt = seg.datetime_local || trip.start_date + 'T12:00:00';
  const endDate = new Date(startDt);
  endDate.setHours(endDate.getHours() + (isHotel ? 24 : 1));
  const endDt = endDate.toISOString().replace('Z', '');

  const bodyParts = [
    seg.confirmation && `Bestätigung: ${seg.confirmation}`,
    seg.notes && `Notizen: ${seg.notes}`,
    `Trip: ${trip.name} (${trip.id})`,
  ].filter(Boolean);

  try {
    const calUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}/events`;
    const event = await deps.graphPost(deps.tenantId, deps.clientId, deps.m365Secret, calUrl, {
      subject,
      start: { dateTime: startDt, timeZone: seg.timezone || 'Europe/Berlin' },
      end: { dateTime: endDt, timeZone: seg.timezone || 'Europe/Berlin' },
      location: trip.destination ? { displayName: trip.destination } : undefined,
      body: bodyParts.length ? { contentType: 'Text', content: bodyParts.join('\n') } : undefined,
    });
    if (event?.id) {
      updateSegment(tripId, segmentId, {
        calendarEventId: event.id,
        calendarWebLink: event.webLink || '',
      });
      return { eventId: event.id, webLink: event.webLink || '' };
    }
  } catch (e: any) {
    console.error(`[travel] createSegmentCalendarEvent failed: ${e.message}`);
  }
  return null;
}

async function deleteSegmentCalendarEvent(calendarEventId: string): Promise<boolean> {
  if (!deps.m365Enabled || !deps.tenantId || !deps.clientId || !deps.m365Secret || !deps.m365User) return false;
  try {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}/events/${encodeURIComponent(calendarEventId)}`;
    await deps.graphDelete(deps.tenantId, deps.clientId, deps.m365Secret, url);
    return true;
  } catch (e: any) {
    console.error(`[travel] deleteSegmentCalendarEvent failed: ${e.message}`);
    return false;
  }
}

// ── Exported helpers for mail-scanner ──────────────────────────────────────

export async function addBookingAsSegment(tripId: string, booking: ParsedBooking): Promise<string | null> {
  const segmentType = BOOKING_TO_SEGMENT[booking.type];
  const seg = addSegment(tripId, {
    type: segmentType,
    datetime_local: booking.startDate,
    datetime_utc: booking.startDate, // best effort; mail data usually has local time
    timezone: 'Europe/Berlin',
    title: booking.title,
    confirmation: booking.confirmationNumber || undefined,
    notes: `Provider: ${booking.provider}${booking.destination ? ' | Ziel: ' + booking.destination : ''}`,
  });
  if (!seg) return null;
  const newSegId = seg.segments[seg.segments.length - 1].id;
  createSegmentCalendarEvent(tripId, newSegId).catch(e => {
    console.error(`[travel] calendar event for booking segment failed: ${e?.message}`);
  });
  return newSegId;
}

// ── Segment Deletion Callback Handler ──────────────────────────────────────

export async function handleSegmentDeletionCallback(
  callbackQueryId: string,
  chatId: string,
  data: string,
): Promise<boolean> {
  if (!data.startsWith('segdel_')) return false;

  const sepIdx = data.indexOf('::');
  if (sepIdx === -1) return false;
  const delKey = data.slice(0, sepIdx);
  const action = data.slice(sepIdx + 2);
  const pending = pendingSegmentDeletions.get(delKey);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingSegmentDeletions.delete(delKey);
    await deps.answerCallbackQuery(callbackQueryId, 'Abgelaufen.');
    return true;
  }
  pendingSegmentDeletions.delete(delKey);
  if (action === 'yes') {
    await deps.answerCallbackQuery(callbackQueryId, 'Wird gelöscht...');
    const ok = await deleteSegmentCalendarEvent(pending.calendarEventId);
    await deps.sendTelegram(chatId, ok
      ? '✅ Kalendereintrag gelöscht.'
      : '❌ Kalendereintrag konnte nicht gelöscht werden.');
  } else {
    await deps.answerCallbackQuery(callbackQueryId, 'Beibehalten');
    await deps.sendTelegram(chatId, '📅 Kalendereintrag beibehalten.');
  }
  return true;
}

// ── Command Registration ───────────────────────────────────────────────────

export function registerTravelCommands(api: any): void {

  api.registerCommand({
    name: "trips",
    description: "Alle Reisen anzeigen",
    handler: async () => {
      const trips = listTrips();
      if (!trips.length) return { text: "📭 Keine Reisen gespeichert. Mit /tripnew anlegen." };
      const lines = trips.map((t: any) =>
        `✈️ *${t.name}* (${t.id})\n   📅 ${t.start_date} → ${t.end_date}\n   📍 ${t.destination || "–"}  🌡 ${t.climate}  🎯 ${t.activities.join(", ")}\n   📦 ${t.segments.length} Segment(e)`
      );
      return { text: `🗺 Deine Reisen:\n\n${lines.join("\n\n")}` };
    },
  });

  api.registerCommand({
    name: "tripnew",
    acceptsArgs: true,
    description: "Neue Reise anlegen: /tripnew <name> <start> <end> — bei nur 3 Args: KI-Anreicherung via OpenAI",
    handler: async (ctx: any) => {
      const raw = (ctx.args || "").trim();
      const tokens = raw.split(/\s+/);

      // Finde den ersten Token im Format YYYY-MM-DD → alles davor ist der Name
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const firstDateIdx = tokens.findIndex((t: string) => datePattern.test(t));
      if (firstDateIdx < 1 || firstDateIdx + 1 >= tokens.length) {
        return { text: "❌ Verwendung: /tripnew New York 2026-03-03 2026-03-05\nOder manuell: /tripnew Tokyo 2026-03-10 2026-03-18 Japan temperate leisure,city" };
      }

      const name       = tokens.slice(0, firstDateIdx).join(" ");
      const start_date = tokens[firstDateIdx];
      const end_date   = tokens[firstDateIdx + 1];
      const rest       = tokens.slice(firstDateIdx + 2); // optionale manuelle Params

      const isAutoMode = rest.length === 0;

      if (isAutoMode) {
        // ── KI-Anreicherung ──
        try {
          const info = await enrichTripWithOpenAI(name);

          // ── Wettervorschau (7 Tage) ──
          let weatherLines = '(nicht verfügbar)';
          if (info.lat && info.lon) {
            try {
              const forecast = await fetchWeatherForecast(info.lat, info.lon);
              if (forecast.length) {
                weatherLines = forecast
                  .map(d => `  ${d.date}: ${d.tmin}–${d.tmax}°C, 🌧 ${d.precip} mm`)
                  .join('\n');
              }
            } catch (_) { /* Wetter optional */ }
          }

          const trip = createTrip(name, start_date, end_date, info.destination, info.climate as any, info.activities as any[]);
          updateTrip(trip.id, {
            country_code:          info.country_code,
            currency:              info.currency,
            visa_de:               info.visa_de,
            distance_km:           info.distance_km,
            travel_mode:           info.travel_mode,
            door_to_door_estimate: info.door_to_door_estimate,
            exchange_rate_eur:     info.exchange_rate_eur,
          } as any);

          return {
            text:
              `✅ Reise *${trip.name}* angelegt (KI-angereichert)!\n` +
              `📅 ${trip.start_date} → ${trip.end_date}\n` +
              `📍 ${info.destination} (${info.country_code})\n` +
              `💶 Währung: ${info.currency}\n` +
              `💱 Wechselkurs: ${info.exchange_rate_eur}\n` +
              `🛂 Visum (DE-Pass): ${info.visa_de}\n` +
              `📏 Luftlinie ab Tuttlingen: ${info.distance_km} km\n` +
              `🚀 Verkehrsmittel: ${info.travel_mode}\n` +
              `⏱ Haustür-zu-Haustür: ${info.door_to_door_estimate}\n` +
              `🌡 Klima: ${info.climate}\n` +
              `🎯 Aktivitäten: ${info.activities.join(", ")}\n` +
              `☁️ Wetter (7-Tage-Vorschau):\n${weatherLines}\n` +
              `🔑 ID: ${trip.id}`,
          };
        } catch (e: any) {
          return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nTipp: /tripnew ${name} ${start_date} ${end_date} <destination> <climate> <activities>` };
        }
      }

      // ── Manueller Modus ──
      const destination   = rest[0] || "";
      const climate       = rest[1] || "temperate";
      const activitiesRaw = rest[2] || "leisure";
      const activities = activitiesRaw.split(",").map((a: string) => a.trim()) as any[];
      const trip = createTrip(name, start_date, end_date, destination, climate as any, activities);
      return { text: `✅ Reise *${trip.name}* angelegt!\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 Klima: ${trip.climate}\n🎯 Aktivitäten: ${trip.activities.join(", ")}\n🔑 ID: ${trip.id}` };
    },
  });

  // ── /trip: Free-text Reise anlegen via Haiku ──────────────────────────────
  api.registerCommand({
    name: "trip",
    acceptsArgs: true,
    description: "Reise per Freitext anlegen: /trip Ich fahre nächste Woche nach Barcelona bis zum 3. März",
    handler: async (ctx: any) => {
      const raw = (ctx.args || "").trim();
      if (!raw) {
        return { text: "Bitte beschreibe deine Reise, z. B.:\n/trip Ich fliege nächsten Montag nach Tokyo und komme am 15. März zurück" };
      }

      // Haiku parst Freitext → { destination, start, end } oder { unclear, question }
      let parsed: TripParseResult | { unclear: true; question: string };
      try {
        parsed = await parseTripFreeText(raw);
      } catch (e: any) {
        return { text: `❌ Haiku-Parsing fehlgeschlagen: ${e.message}` };
      }

      if ("unclear" in parsed) {
        return { text: `❓ ${parsed.question}` };
      }

      const { destination, start, end } = parsed;

      // KI-Anreicherung via enrichTripWithOpenAI (gleiche Logik wie /tripnew auto)
      try {
        const info = await enrichTripWithOpenAI(destination);

        let weatherLines = '(nicht verfügbar)';
        if (info.lat && info.lon) {
          try {
            const forecast = await fetchWeatherForecast(info.lat, info.lon);
            if (forecast.length) {
              weatherLines = forecast
                .map(d => `  ${d.date}: ${d.tmin}–${d.tmax}°C, 🌧 ${d.precip} mm`)
                .join('\n');
            }
          } catch (_) { /* Wetter optional */ }
        }

        const trip = createTrip(destination, start, end, info.destination, info.climate as any, info.activities as any[]);
        updateTrip(trip.id, {
          country_code:          info.country_code,
          currency:              info.currency,
          visa_de:               info.visa_de,
          distance_km:           info.distance_km,
          travel_mode:           info.travel_mode,
          door_to_door_estimate: info.door_to_door_estimate,
          exchange_rate_eur:     info.exchange_rate_eur,
        } as any);

        return {
          text:
            `✅ Reise *${trip.name}* angelegt (via Freitext + KI)!\n` +
            `📅 ${trip.start_date} → ${trip.end_date}\n` +
            `📍 ${info.destination} (${info.country_code})\n` +
            `💶 Währung: ${info.currency}\n` +
            `💱 Wechselkurs: ${info.exchange_rate_eur}\n` +
            `🛂 Visum (DE-Pass): ${info.visa_de}\n` +
            `📏 Luftlinie ab Tuttlingen: ${info.distance_km} km\n` +
            `🚀 Verkehrsmittel: ${info.travel_mode}\n` +
            `⏱ Haustür-zu-Haustür: ${info.door_to_door_estimate}\n` +
            `🌡 Klima: ${info.climate}\n` +
            `🎯 Aktivitäten: ${info.activities.join(", ")}\n` +
            `☁️ Wetter (7-Tage-Vorschau):\n${weatherLines}\n` +
            `🔑 ID: ${trip.id}`,
        };
      } catch (e: any) {
        return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nFallback: /tripnew ${destination} ${start} ${end}` };
      }
    },
  });

  api.registerCommand({
    name: "tripshow",
    acceptsArgs: true,
    description: "Reise anzeigen: /tripshow <id>",
    handler: async (ctx: any) => {
      const id = (ctx.args || "").trim();
      if (!id) return { text: "❌ Verwendung: /tripshow <trip-id>" };
      const trip = getTrip(id);
      if (!trip) return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
      const segs = trip.segments.length
        ? trip.segments.map((s: any) => `  • [${s.type}] ${s.title} — ${s.datetime_local}${s.confirmation ? " ✔ " + s.confirmation : ""}`).join("\n")
        : "  (noch keine Segmente)";
      let text = `✈️ *${trip.name}*\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 ${trip.climate} | 🎯 ${trip.activities.join(", ")}\n\n📋 Segmente:\n${segs}`;
      const links = await deps.getLinksForEntity("trip", id);
      if (links.length) {
        text += `\n\n📎 Verknüpfte Dokumente:\n${deps.formatLinksForTelegram(links)}`;
      }
      return { text };
    },
  });

  api.registerCommand({
    name: "tripadd",
    acceptsArgs: true,
    description: "Segment hinzufügen: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]",
    handler: async (ctx: any) => {
      const parts = (ctx.args || "").trim().split(/\s+/);
      if (parts.length < 5) return { text: "❌ Verwendung: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]\nBeispiel: /tripadd tokyo-2026-03 flight 2026-03-10T10:30 Europe/Berlin LH716-FRA-NRT ABC123" };
      const [tripId, type, datetime_local, timezone, ...rest] = parts;
      const confirmation = rest.length > 1 ? rest[rest.length - 1] : undefined;
      const title = confirmation ? rest.slice(0, -1).join(" ") : rest.join(" ");
      const dt = new Date(datetime_local);
      const datetime_utc = isNaN(dt.getTime()) ? datetime_local : dt.toISOString();
      const trip = addSegment(tripId, { type: type as any, datetime_local, datetime_utc, timezone, title, confirmation });
      if (!trip) return { text: `❌ Reise "${tripId}" nicht gefunden.` };
      const newSeg = trip.segments[trip.segments.length - 1];
      let calInfo = '';
      if (newSeg) {
        const cal = await createSegmentCalendarEvent(tripId, newSeg.id);
        if (cal) calInfo = `\n  📅 Kalendereintrag erstellt`;
      }
      return { text: `✅ Segment hinzugefügt zu *${trip.name}*:\n• [${type}] ${title}\n  📅 ${datetime_local} (${timezone})${confirmation ? "\n  ✔ Bestaetigung: " + confirmation : ""}${calInfo}` };
    },
  });

  api.registerCommand({
    name: "tripdel",
    acceptsArgs: true,
    description: "Segment entfernen: /tripdel <trip-id> <segment-id>",
    handler: async (ctx: any) => {
      const parts = (ctx.args || "").trim().split(/\s+/);
      if (parts.length < 2) return { text: "❌ Verwendung: /tripdel <trip-id> <segment-id>" };
      const [tripId, segmentId] = parts;
      const result = removeSegment(tripId, segmentId);
      if (!result) return { text: `❌ Segment "${segmentId}" in Reise "${tripId}" nicht gefunden.` };
      const { trip, removed } = result;
      const emoji = SEGMENT_EMOJI[removed.type] || '📋';

      if (removed.calendarEventId) {
        const delKey = `segdel_${crypto.randomBytes(6).toString('hex')}`;
        pendingSegmentDeletions.set(delKey, {
          tripId,
          segmentId,
          calendarEventId: removed.calendarEventId,
          expiresAt: Date.now() + 30 * 60_000,
        });
        const chatId = ctx.chatId || ctx.threadId || ctx.conversationId || '';
        if (chatId) {
          await deps.sendTelegramWithKeyboard(
            chatId,
            `✅ Segment entfernt: ${emoji} ${removed.title}\n\n📅 Kalendereintrag ebenfalls löschen?`,
            [[
              { text: '✅ Ja, löschen', callback_data: `${delKey}::yes` },
              { text: '❌ Nein, behalten', callback_data: `${delKey}::no` },
            ]],
          );
          return { text: '' };
        }
      }
      return { text: `✅ Segment entfernt aus *${trip.name}*:\n${emoji} ${removed.title}` };
    },
  });

  api.registerCommand({
    name: "tripsync",
    acceptsArgs: true,
    description: "Kalender-Sync für alle Segmente: /tripsync <trip-id>",
    handler: async (ctx: any) => {
      const tripId = (ctx.args || "").trim();
      if (!tripId) return { text: "❌ Verwendung: /tripsync <trip-id>" };
      const trip = getTrip(tripId);
      if (!trip) return { text: `❌ Reise "${tripId}" nicht gefunden.` };
      let created = 0, skipped = 0, failed = 0;
      for (const seg of trip.segments) {
        if (seg.calendarEventId) { skipped++; continue; }
        const cal = await createSegmentCalendarEvent(tripId, seg.id);
        if (cal) { created++; } else { failed++; }
      }
      return { text: `📅 Kalender-Sync für *${trip.name}*:\n✅ ${created} erstellt, ⏭ ${skipped} vorhanden, ❌ ${failed} fehlgeschlagen` };
    },
  });

  api.registerCommand({
    name: "pack",
    acceptsArgs: true,
    description: "Packliste für eine Reise: /pack <trip-id>",
    handler: async (ctx: any) => {
      const id = (ctx.args || "").trim();
      if (!id) return { text: "❌ Verwendung: /pack <trip-id>" };
      const trip = getTrip(id);
      if (!trip) return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
      return { text: generatePacklist(trip) };
    },
  });
}
