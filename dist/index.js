import fs from "node:fs";
import { execSync } from "node:child_process";
import SunCalc from "suncalc";
import { createTrip, listTrips, fetchWeatherBriefing, analyzeMailForBooking, formatBookingMessage, registerTravelCommands, initTravelCommands, addBookingAsSegment, handleSegmentDeletionCallback, BOOKING_EMOJI, } from "./src/modules/travel/index.js";
import { registerAssetsCommands } from "./src/modules/assets/index.js";
import { registerAssetsHttpRoutes } from "./src/modules/assets/routes.js";
import { readEntries, lastEntry, getWeightTrend, getSleepTrend, getHeartrateTrend, getHrvTrend, checkHealthAlerts, registerHealthCommands, initHealthCommands, syncWithingsForBriefing, syncOuraForBriefing, triggerWithingsSync, triggerOuraSync, getSyncStatus, getOuraSyncStatus, } from "./src/modules/health/index.js";
import { listVehicles, checkDeadlines, registerFleetCommands, initFleetCommands, registerFleetHttpRoutes, } from "./src/modules/fleet/index.js";
import { registerBankingHttpRoutes, initBankingCommands, registerBankingCommands, initTanBridge, initSyncEngine, cleanupExpiredChallenges, } from "./src/modules/banking/index.js";
import { registerLinksHttpRoutes } from "./src/modules/links/routes.js";
import { registerSharePointHttpRoutes } from "./src/modules/sharepoint/routes.js";
import { registerPECommands } from "./src/modules/pe/index.js";
import { registerCalendarCommands, initCalendarCommands } from "./src/modules/calendar/index.js";
import { registerMailCommands, initMailCommands, m365Unread, yahooUnread, listDrafts, scanMailsForBookings, pendingBookings, pendingTripSelections, } from "./src/modules/mail/index.js";
import { registerSharePointCommands, initSharePointCommands, getLinksForEntity, formatLinksForTelegram, } from "./src/modules/sharepoint/index.js";
import { registerInstagramCommands, initInstagramCommands, bootstrapInstagramToken, 
// State exports for command-guard
instaSubmitActive, instaSubmitLastActivatedAt, pendingInstaSubmits, activeCraftDialogs, 
// Helpers for command-guard
detectMediaType, formatFileSize, saveRawSession, sessionDir, 
// Session + naming helpers (E2a)
getOrCreateActiveSession, nextMediaIndex, buildMediaName, recordMediaUpload, computeFileSha256, 
// Inbox HTTP endpoint (E2b)
registerInboxHttpRoute, 
// Edit Queue (E4a)
registerEditQueueRoutes, recoverStaleJobs, 
// Store re-exports for system-health DI
tokenDaysRemaining, loadInstaTokens, ensureInstaToken, 
// Token Guardian (Sprint 3 §5.2)
getTokenHealth, } from "./src/modules/instagram/index.js";
import { closeBrowser } from "./browser-agent.js";
import { initSystemHealth, runStartupChecks, formatHealthReport, runDailyHealthCheck, } from "./system-health.js";
import { insertConversationTurn } from './src/modules/memory/store.js';
import { HealthMonitor, LOCATION_STALE_THRESHOLD_MS } from "./src/modules/executive/index.js";
import * as audit from "./src/shared/audit/index.js";
import { runMigrations, query as dbQuery } from "./src/shared/db/index.js";
import { insertLocationEvent } from "./src/modules/location/store.js";
import { sleep, fetchWithTimeout, berlinDate, } from "./src/shared/utils/index.js";
import { loadSettings, getLocationSettings, DEFAULT_LOCATION, setSetting, refreshSettingsCache, startSettingsCacheRefresh, } from "./src/shared/settings/index.js";
import { graphGet, graphPost, graphDelete, } from "./src/shared/m365/index.js";
import { parseCallbackEvent } from './src/shared/telegram-callback/index.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
// ESM polyfill: __dirname = plugin root (one level up from dist/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(path.dirname(__filename), '..');
function getAstroData(date, location = DEFAULT_LOCATION) {
    const tz = 'Europe/Berlin';
    const fmt = (d) => new Intl.DateTimeFormat('de-DE', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
    const sun = SunCalc.getTimes(date, location.lat, location.lon);
    const moonTimes = SunCalc.getMoonTimes(date, location.lat, location.lon);
    const moon = SunCalc.getMoonIllumination(date);
    const phase = moon.phase;
    let moonIcon;
    let moonPhase;
    if (phase < 0.03 || phase >= 0.97) {
        moonIcon = '🌑';
        moonPhase = 'Neumond';
    }
    else if (phase < 0.22) {
        moonIcon = '🌒';
        moonPhase = 'Zunehmende Sichel';
    }
    else if (phase < 0.28) {
        moonIcon = '🌓';
        moonPhase = 'Erstes Viertel';
    }
    else if (phase < 0.47) {
        moonIcon = '🌔';
        moonPhase = 'Zunehmender Mond';
    }
    else if (phase < 0.53) {
        moonIcon = '🌕';
        moonPhase = 'Vollmond';
    }
    else if (phase < 0.72) {
        moonIcon = '🌖';
        moonPhase = 'Abnehmender Mond';
    }
    else if (phase < 0.78) {
        moonIcon = '🌗';
        moonPhase = 'Letztes Viertel';
    }
    else {
        moonIcon = '🌘';
        moonPhase = 'Abnehmende Sichel';
    }
    return {
        sunrise: fmt(sun.sunrise),
        sunset: fmt(sun.sunset),
        moonrise: moonTimes.rise ? fmt(moonTimes.rise) : null,
        moonset: moonTimes.set ? fmt(moonTimes.set) : null,
        moonIcon,
        moonPhase,
        illumination: Math.round(moon.fraction * 100),
    };
}
/* ---------------- Plugin ---------------- */
export default function (api) {
    // ── Global Error Safety Net — register FIRST, before any async work ──
    // Prevents socket timeouts, IMAP errors, and Telegram fetch failures from killing the process.
    process.on("uncaughtException", (err) => {
        const isSocketTimeout = err.message?.includes("Socket timeout") || err.message?.includes("ETIMEDOUT");
        const isFetchError = err.message?.includes("fetch failed") || err.message?.includes("ECONNRESET");
        const severity = (isSocketTimeout || isFetchError) ? "warn" : "error";
        api.logger[severity](`[executive-agent] Uncaught exception (${severity}, not crashing): ${err.message}`);
        if (!isSocketTimeout && !isFetchError) {
            api.logger.error(`[executive-agent] Stack: ${err.stack}`);
        }
    });
    process.on("unhandledRejection", (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : undefined;
        const isNetworkError = msg.includes("fetch failed") || msg.includes("Socket timeout")
            || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED")
            || msg.includes("UND_ERR_SOCKET") || msg.includes("AbortError");
        const severity = isNetworkError ? "warn" : "error";
        api.logger[severity](`[executive-agent] Unhandled rejection (${severity}, not crashing): ${msg}`);
        if (!isNetworkError && stack) {
            api.logger.error(`[executive-agent] Rejection stack: ${stack}`);
        }
    });
    const workspace = api?.config?.agents?.defaults?.workspace || "/home/biko/.openclaw/workspace";
    // pluginConfig maps to: plugins.entries.executive-agent.config
    const pcfg = api.pluginConfig || {};
    const mailCfg = pcfg.mail || {};
    const m365 = mailCfg.m365 || {};
    const yahoo = mailCfg.yahoo || {};
    const signatures = mailCfg.signatures || {};
    const sendPolicy = mailCfg.sendPolicy || {};
    const requireApproval = sendPolicy.requireApproval !== false; // default true
    // ---- M365 config
    // ---- M365 config
    const m365Enabled = !!m365.enabled;
    const tenantId = process.env.M365_TENANT_ID || m365.tenantId || "";
    const clientId = process.env.M365_CLIENT_ID || m365.clientId || "";
    const m365User = process.env.M365_USER || m365.email || "";
    const m365Secret = process.env.M365_CLIENT_SECRET || "";
    // ---- Yahoo config
    const yahooEnabled = !!yahoo.enabled;
    const yahooUser = yahoo.email || "";
    const yahooPass = process.env.YAHOO_APP_PASSWORD || "";
    const yahooImapHost = yahoo.imapHost || "";
    const yahooImapPort = yahoo.imapPort || 993;
    const yahooSmtpHost = yahoo.smtpHost || "";
    const yahooSmtpPort = yahoo.smtpPort || 587;
    const yahooSmtpSecure = (yahooSmtpPort === 465);
    // ---- Signatures (normalize literal "\n" to real newlines)
    const sigM365 = String(signatures.m365 || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");
    const sigYahoo = String(signatures.yahoo || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");
    // ---- Telegram Bot Token (for direct API fallback)
    let telegramBotToken = '';
    try {
        const ocCfgPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
        if (fs.existsSync(ocCfgPath)) {
            const ocCfg = JSON.parse(fs.readFileSync(ocCfgPath, 'utf-8'));
            telegramBotToken = ocCfg?.channels?.telegram?.botToken || '';
        }
    }
    catch { /* ignore */ }
    // ── Owner-Profil (statisches Fakten-File, mtime-cached) ──
    const ownerTelegramId = process.env.OWNER_TELEGRAM_ID || '';
    const OWNER_PROFILE_PATH = path.join(process.env.HOME || '/root', '.openclaw/owner-facts.md');
    let ownerProfileCache = null;
    function loadOwnerProfile() {
        try {
            const stat = fs.statSync(OWNER_PROFILE_PATH);
            if (ownerProfileCache && ownerProfileCache.mtimeMs === stat.mtimeMs) {
                return ownerProfileCache.content;
            }
            const content = fs.readFileSync(OWNER_PROFILE_PATH, 'utf-8').trim();
            if (!content)
                return null;
            ownerProfileCache = { content, mtimeMs: stat.mtimeMs };
            api.logger.info(`[executive-agent] owner-profile: geladen (${content.length} Bytes, mtime=${new Date(stat.mtimeMs).toISOString()})`);
            return content;
        }
        catch {
            if (ownerProfileCache) {
                api.logger.warn(`[executive-agent] owner-profile: ${OWNER_PROFILE_PATH} nicht mehr lesbar — Cache gelöscht`);
                ownerProfileCache = null;
            }
            return null;
        }
    }
    /**
     * Send a Telegram message with fallback: plugin API → direct Bot API.
     * Retries up to 3 times with exponential backoff on network failures.
     * Returns true if the message was sent successfully.
     */
    const TELEGRAM_RETRY_DELAYS = [2_000, 5_000, 15_000];
    async function sendTelegram(chatId, text) {
        for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS.length; attempt++) {
            // Try plugin API first
            try {
                if (api.runtime?.channel?.telegram?.sendMessageTelegram) {
                    await api.runtime.channel.telegram.sendMessageTelegram(chatId, text);
                    return true;
                }
            }
            catch (err) {
                const isRetryable = isRetryableError(err);
                if (attempt === 0) {
                    api.logger.warn(`[executive-agent] plugin telegram-send failed: ${err.message}, trying direct API...`);
                }
                if (!isRetryable)
                    break; // non-retryable → fall through to direct API
            }
            // Fallback: direct Telegram Bot API
            if (!telegramBotToken) {
                api.logger.error('[executive-agent] No bot token available for direct Telegram send');
                return false;
            }
            try {
                const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
                }, 15000);
                if (res.ok) {
                    if (attempt > 0)
                        api.logger.info(`[executive-agent] Telegram sent after ${attempt + 1} attempts`);
                    return true;
                }
                const body = await res.text().catch(() => '');
                // 4xx client errors (except 429) are not retryable
                if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    api.logger.error(`[executive-agent] direct telegram-send HTTP ${res.status}: ${body}`);
                    return false;
                }
                api.logger.warn(`[executive-agent] telegram-send HTTP ${res.status} (attempt ${attempt + 1}): ${body}`);
            }
            catch (err) {
                api.logger.warn(`[executive-agent] telegram-send failed (attempt ${attempt + 1}): ${err.message}`);
            }
            // Backoff before retry
            if (attempt < TELEGRAM_RETRY_DELAYS.length) {
                await sleep(TELEGRAM_RETRY_DELAYS[attempt]);
            }
        }
        api.logger.error(`[executive-agent] telegram-send failed after ${TELEGRAM_RETRY_DELAYS.length + 1} attempts`);
        return false;
    }
    function isRetryableError(err) {
        const msg = err?.message || '';
        return msg.includes('fetch failed') || msg.includes('Socket timeout')
            || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
            || msg.includes('ECONNREFUSED') || msg.includes('UND_ERR_SOCKET')
            || msg.includes('AbortError') || msg.includes('fetch_timeout');
    }
    /**
     * Send Telegram message with inline keyboard buttons.
     */
    async function sendTelegramWithKeyboard(chatId, text, keyboard) {
        if (!telegramBotToken) {
            api.logger.error('[executive-agent] No bot token for keyboard message');
            return false;
        }
        for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS.length; attempt++) {
            try {
                const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard },
                    }),
                }, 15000);
                if (res.ok)
                    return true;
                const body = await res.text().catch(() => '');
                if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    api.logger.error(`[executive-agent] keyboard-send HTTP ${res.status}: ${body}`);
                    return false;
                }
                api.logger.warn(`[executive-agent] keyboard-send HTTP ${res.status} (attempt ${attempt + 1}): ${body}`);
            }
            catch (err) {
                api.logger.warn(`[executive-agent] keyboard-send failed (attempt ${attempt + 1}): ${err.message}`);
            }
            if (attempt < TELEGRAM_RETRY_DELAYS.length) {
                await sleep(TELEGRAM_RETRY_DELAYS[attempt]);
            }
        }
        api.logger.error(`[executive-agent] keyboard-send failed after ${TELEGRAM_RETRY_DELAYS.length + 1} attempts`);
        return false;
    }
    async function answerCallbackQuery(callbackQueryId, text) {
        if (!telegramBotToken)
            return;
        try {
            await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callback_query_id: callbackQueryId,
                    text: text || '',
                }),
            }, 10000);
        }
        catch { }
    }
    async function sendTelegramPhoto(chatId, photoPath, caption) {
        if (!telegramBotToken)
            return false;
        try {
            const photoData = fs.readFileSync(photoPath);
            const blob = new Blob([photoData], { type: 'image/png' });
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('photo', blob, 'screenshot.png');
            if (caption)
                form.append('caption', caption);
            const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
                method: 'POST',
                body: form,
            });
            return res.ok;
        }
        catch (e) {
            api.logger.error(`[executive-agent] sendTelegramPhoto failed: ${e.message}`);
            return false;
        }
    }
    /* ---------------- Command Guard: suppress AI agent for registered commands ---------------- */
    // All registered plugin commands. When user sends one of these,
    // the AI agent must NOT respond — the command handler handles it.
    const REGISTERED_COMMANDS = new Set([
        'calendar', 'meet', 'meetf', 'free',
        'inbox', 'yinbox', 'yverify', 'mailstatus', 'scanmail',
        'draftcreate', 'draftedit', 'draftlist', 'draftshow', 'draftapprove', 'draftsend', 'ytest',
        'screenshot', 'browse',
        'costs', 'lease', 'leaseset', 'nebenkostenabrechnung',
        'properties', 'property', 'propertyrent',
        'healthalerts', 'healthreportday', 'healthsync', 'healthtrend',
        'withingsauth', 'withingstoken',
        'sharepoint', 'spdocs', 'sprecent', 'spsync',
        'fleet', 'fleetadd', 'fleetdel', 'fleetdocs', 'fleetedit',
        'fleetinsurance', 'fleetlink', 'fleetservice', 'fleetshow', 'fleettuev',
        'tuev', 'versicherung',
        'link', 'linkadd', 'linkdel', 'triplink', 'fleetlink',
        'pe', 'peedit', 'penew', 'peshow', 'pevalue',
        'insta', 'instaapprove', 'instadraft', 'instadrafts', 'instaedit',
        'instaplan', 'instapost', 'instaposts', 'instastyle', 'instasubmit', 'instasync',
        'instacraft', 'instaforensic', 'instaraw', 'instascan', 'instatokentest', 'instatop', 'instatrend', 'instavariants',
        'trade', 'tradedebug', 'tradeindex', 'trademode', 'tradeorders',
        'tradepaper', 'tradeperf', 'tradepos', 'tradescan', 'tradescanstatus',
        'tradetop', 'tradeuniverse', 'tradeunwatch', 'tradewatch', 'tradewatchlist',
        'briefing', 'briefingtime',
    ]);
    /** Set of runIds already persisted — guards against multi-load duplicate writes */
    const persistedRuns = new Set();
    // before_agent_start: fires before every AI agent turn.
    // - For registered commands: instructs AI to stay silent (NO_REPLY) so plugin handler responds.
    // - For voice messages: sets voice flag (framework transcribes natively via tools.media.audio).
    // - For bare media (image/video): saves to raw session and suppresses AI commentary.
    api.on('before_agent_start', async (event) => {
        const prompt = event?.prompt ?? '';
        // Suppress AI for callback-button content (Framework v2026.2 delivers callbacks as text).
        // Framework wraps prompts in "[Telegram sender timestamp] body" envelope.
        // We match the envelope boundary "] " followed by the callback prefix.
        const CALLBACK_PREFIXES = ['icraft_', 'iscan_', 'isub_', 'segdel_', 'booking_', 'bsync_', 'bweekly_'];
        if (CALLBACK_PREFIXES.some(p => prompt.includes('] ' + p))) {
            api.logger.info(`[executive-agent] command-guard: Callback erkannt — AI agent wird unterdrückt (prompt: ${prompt.slice(0, 80)})`);
            return {
                prependContext: 'SYSTEM: This message is a Telegram inline-button callback, already handled by a plugin hook. ' +
                    'You MUST NOT generate any response. Reply with exactly: NO_REPLY',
            };
        }
        // Suppress AI when user is in active craft dialog (any step, TTL-guarded).
        // Step-agnostic because message_received handler mutates step synchronously
        // before before_agent_start fires (~575ms race window).
        const senderIdMatch = prompt.match(/id:(\d{5,})/);
        if (senderIdMatch) {
            const senderId = senderIdMatch[1];
            const craftState = activeCraftDialogs.get(senderId);
            api.logger.debug(`[E4b] dialog-check senderId=${senderId} dialog=${!!craftState} step=${craftState?.step} expiresAt=${craftState?.expiresAt}`);
            if (craftState && Date.now() <= craftState.expiresAt) {
                api.logger.debug(`[E4b] suppress LLM for active craft dialog (senderId=${senderId}, step=${craftState.step})`);
                return {
                    prependContext: 'SYSTEM: This message is direction input for an active Instagram craft dialog, already handled by a plugin hook. ' +
                        'You MUST NOT generate any response. Reply with exactly: NO_REPLY',
                };
            }
        }
        // Suppress AI for registered commands
        const match = prompt.match(/^\s*\/([a-z_]+)/i);
        if (match) {
            const cmd = match[1].toLowerCase();
            if (REGISTERED_COMMANDS.has(cmd)) {
                api.logger.info(`[executive-agent] command-guard: /${cmd} erkannt — AI agent wird unterdrückt`);
                return {
                    prependContext: `CRITICAL INSTRUCTION: The user message is the registered command /${cmd}. ` +
                        `A plugin command handler will respond to this command. ` +
                        `You MUST NOT generate any response. Reply with exactly: NO_REPLY`,
                };
            }
        }
        // Voice messages: no branch needed — framework transcribes natively via tools.media.audio,
        // voice falls through to owner-profile injection (Branch 6). Detection happens in agent_end via stash.content.
        // Bare media (image/video): save to raw session and suppress AI commentary.
        // The prompt contains [media attached: /path/to/file.jpg (image/jpeg) | ...] after media understanding.
        const IMAGE_VIDEO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'mp4', 'mov', 'avi', 'mkv', 'webm'];
        const mediaMatches = [...prompt.matchAll(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\s|)]+)/gi)];
        const mediaFiles = mediaMatches
            .map(m => m[1])
            .filter(p => {
            const ext = p.split('.').pop()?.toLowerCase() || '';
            return IMAGE_VIDEO_EXTS.includes(ext);
        });
        if (mediaFiles.length > 0) {
            // Bare media detection: the gateway uses <media:image>/<media:video> placeholders
            // ONLY when the message has no user-provided text (no caption).
            // If the user sends an image with a caption, the placeholder is replaced by the caption text.
            const isBareMedia = prompt.includes('<media:image>') || prompt.includes('<media:video>');
            api.logger.info(`[executive-agent] command-guard: Media erkannt (${mediaFiles.length} Dateien), bare=${isBareMedia}`);
            if (isBareMedia) {
                // Skip if instasubmit flow is active
                if (instaSubmitActive.size > 0 || Date.now() - instaSubmitLastActivatedAt < 120_000) {
                    api.logger.info(`[executive-agent] command-guard: Media übersprungen — instasubmit aktiv`);
                    return; // Let AI handle normally (instasubmit flow)
                }
                // Check for pending instasubmit
                for (const [, pending] of pendingInstaSubmits) {
                    if (Date.now() < pending.expiresAt) {
                        api.logger.info(`[executive-agent] command-guard: Media übersprungen — pending instasubmit`);
                        return; // Let instasubmit-media-handler deal with it
                    }
                }
                // Extract chatId from prompt metadata
                const chatIdMatch = prompt.match(/id:(\d{5,})/);
                const chatId = chatIdMatch?.[1] || '';
                try {
                    // Find or create active raw session for this sender (E2a helpers)
                    const senderId = chatId;
                    const { session, isNew } = getOrCreateActiveSession(senderId, 'telegram');
                    if (isNew) {
                        api.logger.info(`[executive-agent] command-guard: Neue Raw-Session erstellt: ${session.id}`);
                    }
                    // Copy each media file to session/original/ with speaking names
                    const saved = [];
                    const origDir = path.join(sessionDir(session.id), 'original');
                    for (const filePath of mediaFiles) {
                        if (!fs.existsSync(filePath)) {
                            api.logger.warn(`[executive-agent] command-guard: Media-Datei nicht gefunden: ${filePath}`);
                            continue;
                        }
                        const mediaIndex = await nextMediaIndex(session.id);
                        const ext = path.extname(filePath).toLowerCase() || '.bin';
                        const newName = buildMediaName(session.id, mediaIndex, ext);
                        const destPath = path.join(origDir, newName);
                        fs.copyFileSync(filePath, destPath);
                        const fileSize = fs.statSync(destPath).size;
                        const fileType = detectMediaType(newName) || 'document';
                        session.files.push({
                            name: newName,
                            size: fileSize,
                            type: fileType,
                            addedAt: new Date().toISOString(),
                        });
                        saved.push(`${newName} (${formatFileSize(fileSize)})`);
                        // Record in insta_media_edits (fire-and-forget)
                        const sha256 = computeFileSha256(destPath);
                        recordMediaUpload({
                            sessionId: session.id,
                            mediaIndex,
                            sourcePath: destPath,
                            sha256,
                            source: 'telegram',
                        }).catch(err => {
                            api.logger.error(`[executive-agent] command-guard: recordMediaUpload fehlgeschlagen: ${err?.message}`);
                        });
                    }
                    if (saved.length > 0) {
                        saveRawSession(session);
                        api.logger.info(`[executive-agent] command-guard: ${saved.length} Dateien → ${session.id}`);
                        // Send Telegram confirmation with inline submit button
                        if (chatId) {
                            const msg = saved.length === 1
                                ? `📥 ${saved[0]} → Session ${session.id}`
                                : `📥 ${saved.length} Dateien → Session ${session.id}`;
                            const keyboard = [[
                                    { text: '▶️ Jetzt submitten', callback_data: `isub_${session.id}`.slice(0, 64) },
                                ]];
                            sendTelegramWithKeyboard(chatId, msg, keyboard).catch(err => {
                                // Fallback to plain text if keyboard fails
                                sendTelegram(chatId, msg).catch(() => { });
                                api.logger.error(`[executive-agent] command-guard: Telegram-Bestätigung fehlgeschlagen: ${err?.message}`);
                            });
                        }
                        // Suppress AI commentary — media was handled
                        return {
                            prependContext: `SYSTEM: The user sent ${saved.length} media file(s) which have been automatically saved to raw material session "${session.id}". ` +
                                `A confirmation message has already been sent to the user. ` +
                                `You MUST NOT describe, analyze, or comment on the image/video content. ` +
                                `Reply with exactly: NO_REPLY`,
                        };
                    }
                }
                catch (e) {
                    api.logger.error(`[executive-agent] command-guard: Raw-Session-Speicherung fehlgeschlagen: ${e?.message}\n${e?.stack || ''}`);
                    // Fall through — let AI handle normally
                }
            }
            // If not bare media (has caption text), let AI respond normally
        }
        // ========== BRANCH 6: Owner-Profil-Injektion ==========
        // Inject owner facts for owner DM sessions (free-text messages only).
        // Commands/callbacks/media are handled by branches 1-5 above; voice falls through (framework transcribes natively).
        if (ownerTelegramId) {
            const ownerMatch = prompt.match(/id:(\d{5,})/);
            if (ownerMatch && ownerMatch[1] === ownerTelegramId) {
                const profile = loadOwnerProfile();
                if (profile) {
                    api.logger.debug(`[executive-agent] owner-profile: injiziert für senderId=${ownerMatch[1]}`);
                    return {
                        prependContext: 'Verbindliches Owner-Profil (Stand siehe Datei):\n' + profile,
                    };
                }
            }
        }
    }, { priority: 100 });
    /* ---------------- Commands ---------------- */
    // Executive brief: inbox unread + next events + open drafts
    api.registerCommand({
        name: "brief",
        description: "Executive snapshot: unread inbox + next events + open drafts. Usage: /brief",
        requireAuth: true,
        handler: async () => {
            const tz = "Europe/Berlin";
            const now = new Date();
            const fmtNow = new Intl.DateTimeFormat("de-DE", {
                timeZone: tz,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const parts = [];
            parts.push(`🧠 Brief — ${fmtNow.format(now)}`);
            parts.push("");
            // (A) Unread unified inbox (top 5)
            try {
                const n = 5;
                const perSource = 10;
                const [mMsgs, yMsgs] = await Promise.all([
                    m365Enabled ? m365Unread(perSource) : Promise.resolve([]),
                    yahooEnabled ? yahooUnread(perSource) : Promise.resolve([]),
                ]);
                const combined = [...mMsgs, ...yMsgs].sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1)).slice(0, n);
                parts.push("📥 Unread Inbox (top 5)");
                if (!combined.length) {
                    parts.push("• keine ungelesenen Mails");
                }
                else {
                    for (const m of combined) {
                        const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
                        const dt = m.dateIso.replace("T", " ").replace("Z", "Z");
                        parts.push(`• ${src} ${dt} — ${m.from} — ${m.subject}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
                parts.push("📥 Unread Inbox");
                parts.push("• ❌ Fehler beim Laden");
                parts.push("");
            }
            // (B) Next events (top 3, next 7 days)
            try {
                if (!m365Enabled || !tenantId || !clientId || !m365User || !m365Secret)
                    throw new Error("m365_disabled");
                const start = new Date();
                const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
                    `/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
                    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
                    `&$select=subject,start,end,location` +
                    `&$orderby=start/dateTime`;
                const events = [];
                for (let i = 0; i < 10 && events.length < 3; i++) {
                    const json = await graphGet(tenantId, clientId, m365Secret, url);
                    if (Array.isArray(json?.value))
                        events.push(...json.value);
                    const next = json?.["@odata.nextLink"];
                    if (!next)
                        break;
                    url = next;
                }
                const fmtDate = new Intl.DateTimeFormat("de-DE", {
                    timeZone: tz,
                    weekday: "short",
                    month: "2-digit",
                    day: "2-digit",
                });
                const fmtTime = new Intl.DateTimeFormat("de-DE", {
                    timeZone: tz,
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                });
                parts.push("📅 Next Events (top 3)");
                const top = events.slice(0, 3);
                if (!top.length) {
                    parts.push("• keine Termine (7 Tage)");
                }
                else {
                    for (const ev of top) {
                        const subj = ev?.subject || "(ohne Titel)";
                        const sdt = ev?.start?.dateTime ? new Date(ev.start.dateTime) : null;
                        const edt = ev?.end?.dateTime ? new Date(ev.end.dateTime) : null;
                        const when = sdt && edt
                            ? `${fmtDate.format(sdt)} ${fmtTime.format(sdt)}–${fmtTime.format(edt)}`
                            : "(time?)";
                        const loc = ev?.location?.displayName ? ` | ${ev.location.displayName}` : "";
                        parts.push(`• ${when} — ${subj}${loc}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
                parts.push("📅 Next Events");
                parts.push("• ❌ Fehler beim Laden");
                parts.push("");
            }
            // (C) Open drafts (status=draft, top 5)
            try {
                const ds = listDrafts("draft", 5);
                parts.push("📝 Drafts (open, top 5)");
                if (!ds.length) {
                    parts.push("• keine offenen Drafts");
                }
                else {
                    for (const d of ds) {
                        parts.push(`• ${d.id} [${d.account}] — To: ${(d.to || []).join(", ")} — ${d.subject}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
                parts.push("📝 Drafts");
                parts.push("• ❌ Fehler beim Laden");
                parts.push("");
            }
            return { text: parts.join("\n").trim() };
        },
    });
    // ── Travel → src/modules/travel/commands.ts ──────────────────────────────
    initTravelCommands({
        sendTelegram,
        sendTelegramWithKeyboard,
        answerCallbackQuery,
        graphPost,
        graphDelete,
        getLinksForEntity,
        formatLinksForTelegram,
        m365Enabled,
        tenantId,
        clientId,
        m365Secret,
        m365User,
    });
    registerTravelCommands(api);
    // ── Calendar → src/modules/calendar/commands.ts ──────────────────────────
    initCalendarCommands({ m365Enabled, tenantId, clientId, m365Secret, m365User });
    registerCalendarCommands(api);
    // ── Mail → src/modules/mail/commands.ts ───────────────────────────────────
    initMailCommands({
        m365Enabled, tenantId, clientId, m365Secret, m365User,
        yahooEnabled, yahooUser, yahooPass,
        yahooImapHost, yahooImapPort, yahooSmtpHost, yahooSmtpPort, yahooSmtpSecure,
        sigM365, sigYahoo, requireApproval, workspace,
        sendTelegram, sendTelegramWithKeyboard,
        analyzeMailForBooking, formatBookingMessage,
        logger: api.logger,
    });
    registerMailCommands(api);
    // ── Health + Withings → src/modules/health/commands.ts ────────────────────
    initHealthCommands({ sendTelegram });
    registerHealthCommands(api);
    // ── SharePoint + Links → src/modules/sharepoint/commands.ts ──────────────
    initSharePointCommands({
        m365Enabled, tenantId, clientId, m365Secret, m365User,
        sendTelegram, logger: api.logger,
    });
    registerSharePointCommands(api);
    // ── Instagram → src/modules/instagram/commands.ts ─────────────────────────
    const metaAppId = process.env.META_APP_ID || '';
    const metaAppSecret = process.env.META_APP_SECRET || '';
    const igBusinessId = process.env.INSTAGRAM_BUSINESS_ID || '';
    initInstagramCommands({
        sendTelegram,
        sendTelegramWithKeyboard,
        answerCallbackQuery,
        telegramBotToken,
        metaAppId,
        metaAppSecret,
        igBusinessId,
    });
    bootstrapInstagramToken(api).catch(() => { });
    registerInstagramCommands(api);
    // ── Briefing ───────────────────────────────────────────────────────────────
    // syncWithingsForBriefing → src/modules/health/commands.ts (imported)
    async function getBestEffortLocationForBriefing(now) {
        const loc = await getLocationSettings();
        // Standort-Frische prüfen, aber NICHT abbrechen
        const updatedAtMs = loc.updatedAt ? Date.parse(loc.updatedAt) : NaN;
        if (!Number.isFinite(updatedAtMs)) {
            return { loc, isStale: true };
        }
        const ageMs = now.getTime() - updatedAtMs;
        const maxAgeMs = LOCATION_STALE_THRESHOLD_MS;
        return { loc, isStale: ageMs > maxAgeMs };
    }
    async function generateBriefingText() {
        const tz = 'Europe/Berlin';
        const now = new Date();
        const SEP = '━━━━━━━━━━━━━━━━━━━━';
        const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
        const fmtDateFull = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const parts = [];
        // ── Header: Datum + Uhrzeit + Standort + Astronomie (immer) ──
        const locInfo = await getBestEffortLocationForBriefing(now);
        const loc = locInfo.loc;
        const locAgeMs = loc.updatedAt ? now.getTime() - Date.parse(loc.updatedAt) : Infinity;
        const locLabel = !Number.isFinite(locAgeMs)
            ? `⚠️ ${loc.label} (geschätzt)`
            : locAgeMs > 6 * 3600_000
                ? `⚠️ ${loc.label} (Stand: vor ${Math.round(locAgeMs / 3600_000)}h)`
                : loc.label;
        const astro = getAstroData(now, loc);
        parts.push(`📅 *${fmtDateFull.format(now)} — ${fmtTime.format(now)} Uhr*`);
        parts.push(`📍 ${locLabel}`);
        parts.push(`☀️ Aufgang ${astro.sunrise}  •  Untergang ${astro.sunset}`);
        parts.push(`${astro.moonIcon} ${astro.moonPhase} (${astro.illumination}%)`);
        const moonTimeParts = [];
        if (astro.moonrise)
            moonTimeParts.push(`Aufgang ${astro.moonrise}`);
        if (astro.moonset)
            moonTimeParts.push(`Untergang ${astro.moonset}`);
        const moonTimeStr = moonTimeParts.length ? moonTimeParts.join('  ·  ') : 'nicht sichtbar';
        parts.push(`🌙 ${moonTimeStr}`);
        // ── WETTER + INBOX + KALENDER parallel fetchen ──
        const rangeStart = new Date(now);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(rangeStart);
        rangeEnd.setDate(rangeEnd.getDate() + 7);
        rangeEnd.setHours(23, 59, 59, 999);
        const calUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
            `/calendarView?startDateTime=${encodeURIComponent(rangeStart.toISOString())}` +
            `&endDateTime=${encodeURIComponent(rangeEnd.toISOString())}` +
            `&$select=subject,start,end,location&$orderby=start/dateTime&$top=50`;
        const perSource = 10;
        const [weatherResult, inboxResult, calendarResult] = await Promise.all([
            fetchWeatherBriefing(loc.lat, loc.lon).catch(() => null),
            Promise.all([
                m365Enabled ? m365Unread(perSource).catch(() => []) : [],
                yahooEnabled ? yahooUnread(perSource).catch(() => []) : [],
            ]),
            m365Enabled ? graphGet(tenantId, clientId, m365Secret, calUrl).catch(() => null) : null,
        ]);
        // ── WETTER (reiner Text, Zeilenformat) ──
        if (weatherResult) {
            const w = weatherResult;
            const [td, tm, tu] = w.days;
            parts.push('');
            parts.push(SEP);
            parts.push(`🌤 *WETTER — ${loc.label}*`);
            parts.push(SEP);
            parts.push(`Jetzt: ${w.currentTemp}°C, ${w.currentDesc}`);
            if (w.todayRainHour !== null)
                parts.push(`🌧 Regen ab ${String(w.todayRainHour).padStart(2, '0')}:00`);
            parts.push('');
            parts.push(`Heute: ${td.min}–${td.max}°C · Wind ${td.wind} · Regen ${td.precip}mm · UV ${td.uv}`);
            parts.push(`Morgen: ${tm.min}–${tm.max}°C · Wind ${tm.wind} · Regen ${tm.precip}mm · UV ${tm.uv}`);
            parts.push(`Überm.: ${tu.min}–${tu.max}°C · Wind ${tu.wind} · Regen ${tu.precip}mm · UV ${tu.uv}`);
            parts.push('');
            parts.push(`Druck: ${w.pressureHpa} hPa (${w.pressureTrend})`);
        }
        // ── INBOX ──
        {
            const [mMsgs, yMsgs] = inboxResult;
            const m365Count = mMsgs.length;
            const yahooCount = yMsgs.length;
            if (m365Count > 0 || yahooCount > 0) {
                const combined = [...mMsgs, ...yMsgs].sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1));
                const newest = combined[0];
                parts.push('');
                parts.push(SEP);
                parts.push('📬 *INBOX*');
                parts.push(SEP);
                if (m365Count > 0)
                    parts.push(`- ${m365Count} ungelesene M365-Mail${m365Count > 1 ? 's' : ''}`);
                if (yahooCount > 0)
                    parts.push(`- ${yahooCount} ungelesene Yahoo-Mail${yahooCount > 1 ? 's' : ''}`);
                if (newest)
                    parts.push(`  → Neueste: "${newest.subject}" — ${newest.from}`);
            }
        }
        // ── KALENDER (nächste 7 Tage, kompakt) ──
        {
            const allEvs = calendarResult?.value || [];
            if (allEvs.length > 0) {
                const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
                const fmtWeekday = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'short' });
                const fmtDayMonth = new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit' });
                const byDay = new Map();
                for (const ev of allEvs) {
                    const evDate = new Date(ev.start.dateTime);
                    const key = fmtDayKey.format(evDate);
                    if (!byDay.has(key))
                        byDay.set(key, []);
                    byDay.get(key).push(ev);
                }
                parts.push('');
                parts.push(SEP);
                parts.push('📆 *KALENDER*');
                parts.push(SEP);
                for (const [dayKey, evs] of byDay) {
                    const dayDate = new Date(dayKey + 'T12:00:00');
                    const wd = fmtWeekday.format(dayDate);
                    const dm = fmtDayMonth.format(dayDate);
                    const dayLabel = `${wd} ${dm}.`;
                    for (let i = 0; i < evs.length; i++) {
                        const ev = evs[i];
                        const s = new Date(ev.start.dateTime);
                        const e = new Date(ev.end.dateTime);
                        const diffH = Math.round((e.getTime() - s.getTime()) / 3600000 * 10) / 10;
                        const dur = diffH >= 1 ? `(${diffH}h)` : `(${Math.round(diffH * 60)}min)`;
                        const prefix = i === 0 ? dayLabel : ' '.repeat(dayLabel.length);
                        parts.push(`${prefix}  ${fmtTime.format(s)} ${ev.subject || '(kein Titel)'} ${dur}`);
                    }
                }
            }
        }
        // ── DRAFTS ──
        try {
            const ds = listDrafts('draft', 5);
            if (ds.length > 0) {
                parts.push('');
                parts.push(SEP);
                parts.push('✏️ *DRAFTS*');
                parts.push(SEP);
                parts.push(`- ${ds.length} Entwürf${ds.length > 1 ? 'e' : ''} offen`);
                for (let i = 0; i < ds.length; i++) {
                    const to = ds[i].to?.join(', ') || '?';
                    parts.push(`  → #${i + 1}: "${ds[i].subject}" an ${to}`);
                }
            }
        }
        catch { /* drafts optional */ }
        // ── HEALTH ──
        {
            const healthLines = [];
            const wt7 = await getWeightTrend(7);
            const lastWeight = await lastEntry('weight');
            if (lastWeight && wt7) {
                const arrow = wt7.direction === 'up' ? '↗' : wt7.direction === 'down' ? '↘' : '→';
                const sign = wt7.change > 0 ? '+' : '';
                healthLines.push(`- Gewicht:  ${wt7.current} kg  (Trend: ${arrow} ${sign}${wt7.change} kg/Woche)`);
            }
            else if (lastWeight) {
                healthLines.push(`- Gewicht:  ${lastWeight.value?.toFixed(1)} kg`);
            }
            // Last night sleep (dedup by day, pick longest)
            const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const sleepEntries = (await readEntries(since7d)).filter(e => e.type === 'sleep');
            const sleepByDay = new Map();
            for (const s of sleepEntries) {
                const day = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
                }).format(new Date(s.timestamp));
                const prev = sleepByDay.get(day);
                if (!prev || (Number(s.value || 0) > Number(prev.value || 0)))
                    sleepByDay.set(day, s);
            }
            // 7-day average
            const sleepDays = Array.from(sleepByDay.values())
                .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
            const lastSleep = sleepDays.length ? sleepDays[sleepDays.length - 1] : null;
            const todayStr = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const lastSleepDay = lastSleep ? new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date(lastSleep.timestamp)) : null;
            if (lastSleep && lastSleepDay === todayStr) {
                const val = Number(lastSleep.value || 0);
                const hours = Math.floor(val);
                const mins = Math.round((val - hours) * 60);
                let sleepLine = `- Schlaf:   ${hours}h ${String(mins).padStart(2, '0')}min`;
                const last7 = sleepDays.slice(-7);
                if (last7.length >= 2) {
                    const avg = last7.reduce((sum, e) => sum + Number(e.value || 0), 0) / last7.length;
                    const avgH = Math.floor(avg);
                    const avgM = Math.round((avg - avgH) * 60);
                    sleepLine += `  (Ø 7 Tage: ${avgH}h ${String(avgM).padStart(2, '0')}min)`;
                }
                healthLines.push(sleepLine);
            }
            else {
                healthLines.push('- Schlaf:   Keine Schlafdaten (letzte Nacht)');
            }
            // HRV (D2: display only, no new alerts)
            const hrvTrend = await getHrvTrend(7).catch(() => null);
            const lastHrv = await lastEntry('hrv').catch(() => null);
            if (lastHrv && lastHrv.hrv_ms != null) {
                let hrvLine = `- HRV:      ${lastHrv.hrv_ms} ms`;
                if (hrvTrend && hrvTrend.dataPoints >= 2) {
                    hrvLine += `  (Ø 7 Tage: ${hrvTrend.avg} ms)`;
                }
                healthLines.push(hrvLine);
            }
            // Readiness (D2: display only, no new alerts)
            const lastReadiness = await lastEntry('readiness').catch(() => null);
            if (lastReadiness && lastReadiness.readiness_score != null) {
                healthLines.push(`- Readiness: ${lastReadiness.readiness_score}/100`);
            }
            // Temperature deviation
            const lastTemp = await lastEntry('temperature').catch(() => null);
            if (lastTemp && lastTemp.temp_deviation != null) {
                const sign = lastTemp.temp_deviation > 0 ? '+' : '';
                healthLines.push(`- Temperatur: ${sign}${lastTemp.temp_deviation.toFixed(1)} °C`);
            }
            // Alerts
            const alerts = await checkHealthAlerts();
            const activeAlerts = alerts.filter(a => a.severity === 'critical' || a.severity === 'warning');
            if (activeAlerts.length > 0) {
                const alertIcons = { critical: '🔴', warning: '⚠️' };
                healthLines.push(`- Alerts:   ${activeAlerts.length > 1 ? `${activeAlerts.length} aktiv` : '⚠️ 1 aktiv'} → "${activeAlerts[0].message}"`);
            }
            if (healthLines.length > 0) {
                parts.push('');
                parts.push(SEP);
                parts.push('❤️ *HEALTH*');
                parts.push(SEP);
                parts.push(...healthLines);
            }
        }
        // ── FUHRPARK — FRISTEN (nur wenn innerhalb 60 Tage) ──
        try {
            const allDeadlines = await checkDeadlines();
            const deadlines = allDeadlines.filter((w) => w.severity === 'overdue' || w.daysLeft <= 60);
            if (deadlines.length > 0) {
                parts.push('');
                parts.push(SEP);
                parts.push('🚗 *FUHRPARK — FRISTEN*');
                parts.push(SEP);
                for (const w of deadlines) {
                    const icon = w.vehicleType === 'car' ? '🚗' : '🏍';
                    const label = w.field === 'tuev' ? 'TÜV' : 'Versicherung';
                    if (w.severity === 'overdue') {
                        parts.push(`- ${icon} ${w.vehicleName} — ${label} überfällig seit ${Math.abs(w.daysLeft)} Tagen 🔴`);
                    }
                    else {
                        const dateDE = `${w.date.slice(8, 10)}.${w.date.slice(5, 7)}.${w.date.slice(0, 4)}`;
                        parts.push(`- ${icon} ${w.vehicleName} — ${label} in ${w.daysLeft} Tagen (${dateDE}) ⚠️`);
                    }
                }
                // Add "Alle anderen: kein Handlungsbedarf" if there are vehicles without deadlines
                const allVehicles = await listVehicles();
                const vehiclesWithDeadlines = new Set(deadlines.map((d) => d.vehicleName));
                if (allVehicles.length > deadlines.length) {
                    parts.push('- Alle anderen: kein Handlungsbedarf');
                }
            }
        }
        catch { /* fleet deadlines optional */ }
        return parts.join('\n').trim();
    }
    api.registerCommand({
        name: 'briefing',
        description: 'Tages-Briefing: Wetter + Kalender + Gesundheit + Drafts',
        handler: async () => {
            try {
                const BRIEFING_TIMEOUT_MS = 45000;
                const briefingWork = async () => {
                    // Sync both providers before generating briefing (may fail independently)
                    await Promise.allSettled([
                        syncWithingsForBriefing().catch((e) => {
                            api.logger.warn(`[executive-agent] Briefing Withings-Sync Fehler: ${e.message}`);
                        }),
                        syncOuraForBriefing().catch((e) => {
                            api.logger.warn(`[executive-agent] Briefing Oura-Sync Fehler: ${e.message}`);
                        }),
                    ]);
                    return await generateBriefingText();
                };
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('briefing_timeout')), BRIEFING_TIMEOUT_MS));
                const text = await Promise.race([briefingWork(), timeoutPromise]);
                return { text };
            }
            catch (e) {
                if (e?.message === 'briefing_timeout') {
                    return { text: '⏱️ Briefing abgebrochen: Timeout nach 45s. Bitte erneut versuchen.' };
                }
                return { text: `❌ /briefing fehlgeschlagen: ${e.message}` };
            }
        },
    });
    // ── Fuhrpark-Befehle → src/modules/fleet/commands.ts ──────────────────────
    initFleetCommands({ getLinksForEntity, formatLinksForTelegram });
    registerFleetCommands(api);
    // ── Banking → src/modules/banking/commands.ts ──────────────────────────
    const bankingTelegramChatId = () => loadSettings().telegramChatId;
    initBankingCommands({ sendTelegram, telegramChatId: bankingTelegramChatId });
    registerBankingCommands(api);
    initTanBridge({ sendTelegram, telegramChatId: bankingTelegramChatId });
    initSyncEngine({ sendTelegram, sendTelegramWithKeyboard, telegramChatId: bankingTelegramChatId });
    // Banking: expire stale TAN challenges every 60s
    setInterval(() => { cleanupExpiredChallenges().catch(() => { }); }, 60_000);
    // ── Private Equity → src/modules/pe/commands.ts ──────────────────────────
    registerPECommands(api);
    // ── Trading ─────────────────────────────────────────────────────────────────
    const TRADING_URL = 'http://127.0.0.1:18793';
    async function tradingFetch(path, opts) {
        try {
            const { timeoutMs, ...fetchOpts } = opts || {};
            const r = await fetch(`${TRADING_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs || 5000), ...fetchOpts });
            if (!r.ok)
                return null;
            return await r.json();
        }
        catch {
            return null;
        }
    }
    function fmtTradingNum(n, d = 2) {
        return n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function pnlSign(n) {
        return n >= 0 ? `+${fmtTradingNum(n)}` : fmtTradingNum(n);
    }
    api.registerCommand({
        name: 'trade',
        description: 'Trading-Status: Modus, Positionen, P&L',
        handler: async () => {
            const s = await tradingFetch('/status');
            if (!s)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            const modeLabel = s.mode === 1 ? 'Monitoring' : s.mode === 2 ? 'Semi-Auto' : 'Full-Auto';
            return {
                text: [
                    `📈 *Trading Status*`,
                    ``,
                    `Modus: ${s.mode} — ${modeLabel}`,
                    `Verbindung: ${s.connected ? '✅ Verbunden' : '❌ Nicht verbunden'}`,
                    `Paper: ${s.paperMode ? 'Ja' : 'Nein'}`,
                    `Konto: ${s.account || '—'}`,
                    ``,
                    `Net Liquidation: ${fmtTradingNum(s.netLiquidation)} $`,
                    `Cash: ${fmtTradingNum(s.cashBalance)} $`,
                    `Tages-P&L: ${pnlSign(s.dailyPnl)} $`,
                    `Unrealisiert: ${pnlSign(s.unrealizedPnl)} $`,
                    `Realisiert: ${pnlSign(s.realizedPnl)} $`,
                    ``,
                    `Positionen: ${s.positions.length}`,
                    `Stand: ${s.timestamp}`,
                ].join('\n'),
            };
        },
    });
    api.registerCommand({
        name: 'tradepos',
        description: 'Offene Trading-Positionen',
        handler: async () => {
            const s = await tradingFetch('/status');
            if (!s)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (!s.positions || s.positions.length === 0)
                return { text: 'Keine offenen Positionen.' };
            const lines = s.positions.map((p) => `${p.symbol} | ${p.quantity} @ ${fmtTradingNum(p.avgCost)} | Markt: ${fmtTradingNum(p.marketPrice)} | P&L: ${pnlSign(p.unrealizedPnl)}`);
            return { text: ['📊 *Positionen*', '', ...lines].join('\n') };
        },
    });
    api.registerCommand({
        name: 'tradeorders',
        description: 'Offene Trading-Orders',
        handler: async () => {
            return { text: 'Keine offenen Orders. (Phase 1 — nur Monitoring)' };
        },
    });
    api.registerCommand({
        name: 'trademode',
        acceptsArgs: true,
        description: 'Trading-Modus anzeigen/setzen: /trademode [1|2|3]',
        handler: async (ctx) => {
            const raw = String(ctx.args || '').trim();
            if (!raw) {
                const s = await tradingFetch('/status');
                if (!s)
                    return { text: '⚠️ Trading-Service nicht erreichbar.' };
                const labels = { 1: 'Monitoring', 2: 'Semi-Auto', 3: 'Full-Auto' };
                return { text: `Trading-Modus: ${s.mode} — ${labels[s.mode] || '?'}` };
            }
            const mode = Number(raw);
            if (![1, 2, 3].includes(mode))
                return { text: '❌ Verwendung: /trademode 1|2|3\n1=Monitoring, 2=Semi-Auto, 3=Full-Auto' };
            const result = await tradingFetch('/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
            });
            if (!result)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            return { text: `✅ Trading-Modus auf ${result.mode} — ${result.label} gesetzt.` };
        },
    });
    api.registerCommand({
        name: 'tradewatch',
        acceptsArgs: true,
        description: 'Symbol zur Watchlist: /tradewatch AAPL [SMART] [USD]',
        handler: async (ctx) => {
            const raw = String(ctx.args || '').trim();
            if (!raw)
                return { text: '❌ Verwendung: /tradewatch AAPL [SMART] [USD]' };
            const parts = raw.split(/\s+/);
            const symbol = parts[0].toUpperCase();
            const exchange = parts[1] || 'SMART';
            const currency = parts[2] || 'USD';
            const list = await tradingFetch('/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol, exchange, currency }),
            });
            if (!list)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            return { text: `✅ ${symbol} zur Watchlist hinzugefügt. (${list.length} Einträge)` };
        },
    });
    api.registerCommand({
        name: 'tradeunwatch',
        acceptsArgs: true,
        description: 'Symbol von Watchlist entfernen: /tradeunwatch AAPL',
        handler: async (ctx) => {
            const symbol = String(ctx.args || '').trim().toUpperCase();
            if (!symbol)
                return { text: '❌ Verwendung: /tradeunwatch AAPL' };
            const list = await tradingFetch(`/watchlist/${symbol}`, { method: 'DELETE' });
            if (!list)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            return { text: `✅ ${symbol} von Watchlist entfernt. (${list.length} Einträge)` };
        },
    });
    api.registerCommand({
        name: 'tradewatchlist',
        description: 'Aktuelle Trading-Watchlist',
        handler: async () => {
            const list = await tradingFetch('/watchlist');
            if (!list)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (!list.length)
                return { text: 'Watchlist ist leer.' };
            const lines = list.map((w) => `${w.symbol} (${w.exchange}/${w.currency})${w.lastPrice ? ` — ${fmtTradingNum(w.lastPrice)}` : ''}`);
            return { text: ['👁 *Watchlist*', '', ...lines].join('\n') };
        },
    });
    api.registerCommand({
        name: 'tradepaper',
        description: 'Paper-Trading Status',
        handler: async () => {
            const h = await tradingFetch('/health');
            if (!h)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            return {
                text: [
                    '📋 *Paper-Trading Status*',
                    '',
                    `Service: ${h.ok ? '✅ Läuft' : '❌ Fehler'}`,
                    `IBKR-Verbindung: ${h.connected ? '✅ Verbunden' : '❌ Nicht verbunden'}`,
                    `Modus: Paper Trading (Port 7497)`,
                    '',
                    'Phase 1: Nur Monitoring, keine Order-Ausführung.',
                ].join('\n'),
            };
        },
    });
    api.registerCommand({
        name: 'tradeperf',
        description: 'Trading-Performance (Tag/Woche/Monat)',
        handler: async () => {
            const s = await tradingFetch('/status');
            if (!s)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            return {
                text: [
                    '📊 *Trading Performance*',
                    '',
                    `Tages-P&L: ${pnlSign(s.dailyPnl)} $`,
                    `Unrealisiert: ${pnlSign(s.unrealizedPnl)} $`,
                    `Realisiert: ${pnlSign(s.realizedPnl)} $`,
                    `Net Liquidation: ${fmtTradingNum(s.netLiquidation)} $`,
                    `Cash: ${fmtTradingNum(s.cashBalance)} $`,
                ].join('\n'),
            };
        },
    });
    // ── Universe Commands ────────────────────────────────────────────────────────
    api.registerCommand({
        name: 'tradeuniverse',
        description: 'Aktives Trading-Universum anzeigen',
        handler: async () => {
            const data = await tradingFetch('/universe');
            if (!data)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (!data.symbols || data.symbols.length === 0) {
                return { text: '🌐 Universum ist leer. Noch kein Scan durchgeführt.\n\nManual: /tradescan' };
            }
            const byIndex = {};
            for (const s of data.symbols) {
                byIndex[s.index] = (byIndex[s.index] || 0) + 1;
            }
            const indexLines = Object.entries(byIndex).map(([idx, cnt]) => `  ${idx}: ${cnt}`);
            const topSymbols = data.symbols.slice(0, 10).map((s) => s.symbol).join(', ');
            return {
                text: [
                    '🌐 *Aktives Universum*',
                    '',
                    `Gesamt: ${data.symbols.length} Symbole`,
                    ...indexLines,
                    '',
                    `Top: ${topSymbols}`,
                    `Letzter Build: ${data.lastBuild ? data.lastBuild.slice(0, 19).replace('T', ' ') : '—'}`,
                ].join('\n'),
            };
        },
    });
    api.registerCommand({
        name: 'tradeindex',
        acceptsArgs: true,
        description: 'Index aktivieren/deaktivieren: /tradeindex on DAX40',
        handler: async (ctx) => {
            const raw = String(ctx.args || '').trim();
            const parts = raw.split(/\s+/);
            if (parts.length < 2 || !['on', 'off'].includes(parts[0])) {
                return { text: '❌ Verwendung: /tradeindex on|off <DAX40|MDAX|SP500|NASDAQ100>' };
            }
            const enabled = parts[0] === 'on';
            const index = parts[1].toUpperCase();
            const result = await tradingFetch('/universe/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ indices: { [index]: { enabled } } }),
            });
            if (!result)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            const status = result.indices?.[index]?.enabled ? '✅ aktiviert' : '❌ deaktiviert';
            return { text: `${index}: ${status}` };
        },
    });
    api.registerCommand({
        name: 'tradescan',
        description: 'Manuellen Universe-Scan auslösen',
        handler: async () => {
            const result = await tradingFetch('/universe/scan', { method: 'POST' });
            if (!result)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (result.status === 'running') {
                return { text: '📡 Scan läuft bereits. Status prüfen mit /tradescanstatus' };
            }
            return { text: '📡 Scan gestartet. Ergebnis in ~2 Min. Prüfen mit /tradescanstatus' };
        },
    });
    api.registerCommand({
        name: 'tradescanstatus',
        description: 'Status des letzten Universe-Scans',
        handler: async () => {
            const result = await tradingFetch('/universe/scan/status');
            if (!result)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            const statusLabel = result.status === 'running' ? '⏳ Läuft...' : result.status === 'done' ? '✅ Fertig' : result.status === 'error' ? '❌ Fehler' : '💤 Idle';
            return {
                text: [
                    '📡 *Scan-Status*',
                    '',
                    `Status: ${statusLabel}`,
                    `Universum: ${result.universe} Symbole`,
                    `Momentum: ${result.momentum}`,
                    `Mean-Reversion: ${result.meanReversion}`,
                    `Zeit: ${result.timestamp?.slice(0, 19).replace('T', ' ') || '—'}`,
                ].join('\n'),
            };
        },
    });
    api.registerCommand({
        name: 'tradetop',
        description: 'Top Trading-Kandidaten anzeigen',
        handler: async () => {
            const results = await tradingFetch('/universe/top?limit=10');
            if (!results)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (!results.length)
                return { text: 'Keine aktuellen Scan-Kandidaten (letzte 2h).' };
            const lines = results.map((r) => `${r.symbol} | ${r.signal} | Stärke: ${Number(r.strength).toFixed(1)} | ${r.timestamp?.slice(11, 19) || ''}`);
            return { text: ['🏆 *Top-Kandidaten*', '', ...lines].join('\n') };
        },
    });
    api.registerCommand({
        name: 'tradedebug',
        description: 'Scanner-Debug: zeigt wieviele Symbole jede Bedingung erfüllen',
        handler: async () => {
            const stats = await tradingFetch('/debug/scan');
            if (!stats)
                return { text: '⚠️ Trading-Service nicht erreichbar.' };
            if (stats.error)
                return { text: `⚠️ ${stats.error}` };
            const m = stats.momentum;
            const mr = stats.meanReversion;
            const ts = stats.timestamp?.slice(0, 19).replace('T', ' ') || '—';
            return {
                text: [
                    '🔬 *Scanner Debug*',
                    `Analysiert: ${stats.totalAnalyzed} Symbole | ${ts}`,
                    '',
                    '*Momentum (2 von 3 nötig):*',
                    `EMA bullish: ${m.emaBullish} | Cross: ${m.emaCross}`,
                    `RSI 50-70: ${m.rsiInZone}`,
                    `Vol >120%: ${m.volumeAbove120}`,
                    `→ Pass: ${m.passed}`,
                    '',
                    '*Mean-Reversion (RSI + 1 weitere):*',
                    `RSI <35: ${mr.rsiBelow35} | <30: ${mr.rsiBelow30}`,
                    `< BB lower: ${mr.belowBBLower} | unteres Drittel: ${mr.inLowerThird}`,
                    `Vol >120%: ${mr.volumeAbove120}`,
                    `→ Pass: ${mr.passed}`,
                ].join('\n'),
            };
        },
    });
    // ── Briefing-Zeit konfigurieren ────────────────────────────────────────────
    api.registerCommand({
        name: 'briefingtime',
        acceptsArgs: true,
        description: 'Briefing-Uhrzeit setzen: /briefingtime HH:MM  (Europe/Berlin, Standard: 07:00)',
        handler: async (ctx) => {
            const raw = String(ctx.args || '').trim();
            if (!/^\d{1,2}:\d{2}$/.test(raw))
                return { text: '❌ Verwendung: /briefingtime 07:30' };
            const [h, m] = raw.split(':').map(Number);
            if (h < 0 || h > 23 || m < 0 || m > 59)
                return { text: '❌ Ungültige Uhrzeit.' };
            const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            await setSetting('briefing_time', time);
            const s = loadSettings();
            return {
                text: `⏰ Tägliches Briefing auf ${time} Uhr (Europe/Berlin) gesetzt.\n` +
                    `Chat-ID: ${s.telegramChatId || '(noch nicht erfasst — sende irgendeine Nachricht)'}`,
            };
        },
    });
    // ── healthreportday → src/modules/health/commands.ts ──────────────────────
    // ── Assets: Immobilienverwaltung → src/modules/assets/commands.ts ────────
    registerAssetsCommands(api);
    // ── Mail-Scanner: Buchungsbestätigungen → Trip-Segmente ────────────────
    // formatBookingMessage → src/modules/travel/enrichment.ts
    // ── Message Sink: persist conversation turns to Postgres ──────────────────
    // Baustein 1 fuer dynamisches Gedaechtnis. Fire-and-forget — Schreibfehler
    // blockieren den Agenten nie. Scope: Owner-only (senderId 133260792).
    const OWNER_SENDER_ID = '133260792';
    api.on('agent_end', async (event, ctx) => {
        try {
            if (!event.success || !event.messages || event.messages.length === 0)
                return;
            // Dedup guard: runId-based, survives multi-load (Set is per-module, shared across loads)
            const runId = String(event.runId || ctx?.runId || '');
            if (!runId || persistedRuns.has(runId))
                return;
            persistedRuns.add(runId);
            // Evict old entries to prevent unbounded growth
            if (persistedRuns.size > 100) {
                const first = persistedRuns.values().next().value;
                if (first)
                    persistedRuns.delete(first);
            }
            // Extract senderId from first user message (self-contained, no cross-event stash)
            const firstUser = event.messages.find((m) => m?.role === 'user');
            if (!firstUser)
                return;
            const senderId = String(firstUser.senderId || ctx?.channelId || '').trim();
            if (senderId !== OWNER_SENDER_ID)
                return;
            // User content and voice detection
            const rawContent = typeof firstUser.content === 'string' ? firstUser.content : '';
            const mediaPath = String(firstUser.MediaPath || firstUser.mediaPath || '');
            const isVoice = /\.(?:ogg|oga|opus)$/i.test(mediaPath);
            let userText = rawContent;
            // Voice: user content is "[User sent media without caption]" — use marker
            if (isVoice) {
                userText = '[Voice message]';
            }
            if (!userText || !userText.trim())
                return;
            // Bare media without text — skip (images/video without caption)
            if (/^\[User sent media/i.test(userText.trim()) && !isVoice)
                return;
            if (/^\[media attached:/i.test(userText.trim()) && !isVoice)
                return;
            if (/^<media:(image|video|audio)>/i.test(userText.trim()) && !isVoice)
                return;
            // Extract agent response from last assistant message toolCall or text block
            let agentText = null;
            for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i];
                if (!msg || msg.role !== 'assistant')
                    continue;
                const content = msg.content;
                if (typeof content === 'string') {
                    agentText = content;
                    break;
                }
                if (Array.isArray(content)) {
                    // Prefer message toolCall (framework sends responses via message tool)
                    const msgCall = content.find((b) => b?.type === 'toolCall' && b?.name === 'message');
                    if (msgCall) {
                        agentText = msgCall.arguments?.message || msgCall.input?.message || null;
                        break;
                    }
                    // Fallback: plain text block
                    const textBlock = content.find((b) => b?.type === 'text' && typeof b?.text === 'string');
                    if (textBlock) {
                        agentText = textBlock.text;
                        break;
                    }
                }
            }
            // Skip suppressed turns (NO_REPLY from callback/command guard)
            if (!agentText || agentText.trim() === 'NO_REPLY')
                return;
            await insertConversationTurn({
                senderId,
                userText,
                agentText,
                sessionKey: ctx.sessionKey ?? null,
                channel: 'telegram',
                metadata: isVoice ? { voice: true } : null,
            });
            api.logger.debug(`[message-sink] Turn persisted (sender=${senderId} voice=${isVoice})`);
        }
        catch (err) {
            // NEVER block the agent — log warning only
            api.logger.warn(`[message-sink] Write failed: ${err.message}`);
        }
    });
    // ── Chat-ID aus eingehenden Nachrichten erfassen ───────────────────────────
    api.on('message_received', (event) => {
        try {
            // Prefer real chat id; fallback to sender id.
            const id = String(event?.metadata?.senderId || '').trim();
            if (!id)
                return;
            const s = loadSettings();
            if (s.telegramChatId !== id) {
                setSetting('telegram_chat_id', id).catch(() => { });
                api.logger.info(`[executive-agent] telegramChatId gespeichert: ${id}`);
            }
        }
        catch { }
    });
    // ── Standort via Telegram Location Message speichern ──────────────────────
    api.on('message_received', async (event) => {
        try {
            // The gateway formats location messages as text in event.content:
            //   Live:  "🛰 Live location: LAT, LON ±Xm"
            //   Pin:   "📍 LAT, LON ±Xm"
            //   Place: "📍 Name — Address (LAT, LON ±Xm)"
            const content = event?.content ?? '';
            if (!content)
                return;
            // Only process location messages (start with 📍 or 🛰)
            if (!content.startsWith('📍') && !content.startsWith('🛰'))
                return;
            // Extract coordinates: match "LAT, LON" pattern (decimal numbers)
            const coordMatch = content.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
            if (!coordMatch)
                return;
            const lat = Number(coordMatch[1]);
            const lon = Number(coordMatch[2]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon))
                return;
            const label = await resolveLocationLabel(lat, lon);
            await insertLocationEvent({ lat, lon, label, source: 'telegram' });
            api.logger.info(`[executive-agent] Standort gespeichert: ${label} (${lat}, ${lon})`);
            const chatId = loadSettings().telegramChatId;
            if (chatId) {
                sendTelegram(chatId, `📍 Standort gespeichert: ${label}`).catch(() => { });
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Location-Handler Fehler: ${e?.message}`);
        }
    });
    // ── Booking Callback Handler (Telegram Inline Buttons) ─────────────────────
    // addBookingAsSegment → src/modules/travel/commands.ts
    async function handleBookingCallback(chatId, bookingKey, action) {
        const pending = pendingBookings.get(bookingKey);
        if (!pending || Date.now() > pending.expiresAt) {
            pendingBookings.delete(bookingKey);
            await sendTelegram(chatId, '⏰ Buchung abgelaufen.');
            return;
        }
        const { booking } = pending;
        const emoji = BOOKING_EMOJI[booking.type] || '📧';
        if (action === 'ignore') {
            pendingBookings.delete(bookingKey);
            await sendTelegram(chatId, `${emoji} ${booking.title} — ignoriert.`);
            return;
        }
        if (action === 'new') {
            pendingBookings.delete(bookingKey);
            try {
                const tripName = booking.destination || booking.title;
                const startDate = booking.startDate.slice(0, 10); // YYYY-MM-DD
                const endDate = booking.endDate ? booking.endDate.slice(0, 10) : startDate;
                const trip = createTrip(tripName, startDate, endDate, booking.destination);
                await addBookingAsSegment(trip.id, booking);
                await sendTelegram(chatId, `✅ Reise *${trip.name}* erstellt (${trip.id})\n${emoji} ${booking.title} als Segment hinzugefügt.`);
            }
            catch (e) {
                await sendTelegram(chatId, `❌ Fehler beim Erstellen der Reise: ${e.message}`);
            }
            return;
        }
        if (action === 'existing') {
            const trips = listTrips();
            if (!trips.length) {
                pendingBookings.delete(bookingKey);
                await sendTelegram(chatId, '❌ Keine bestehenden Reisen gefunden. Nutze "Neue Reise" stattdessen.');
                return;
            }
            // Store pending selection and present numbered list
            pendingTripSelections.set(chatId, {
                bookingKey,
                trips: trips.map(t => ({ id: t.id, name: t.name })),
                expiresAt: Date.now() + 5 * 60_000,
            });
            const lines = trips.map((t, i) => `${i + 1}) ${t.name} (${t.start_date} — ${t.end_date})`);
            await sendTelegram(chatId, `📋 Bestehende Reisen:\n\n${lines.join('\n')}\n\nAntwort mit Nummer zum Zuordnen:`);
            return;
        }
        // Handle trip selection by number (from callback with trip index)
        if (action.startsWith('trip_')) {
            const tripIdx = parseInt(action.slice(5), 10);
            const trips = listTrips();
            if (isNaN(tripIdx) || tripIdx < 0 || tripIdx >= trips.length) {
                await sendTelegram(chatId, '❌ Ungültige Auswahl.');
                return;
            }
            pendingBookings.delete(bookingKey);
            const trip = trips[tripIdx];
            await addBookingAsSegment(trip.id, booking);
            await sendTelegram(chatId, `✅ ${emoji} ${booking.title} zu Reise *${trip.name}* hinzugefügt.`);
            return;
        }
    }
    // Hook to handle numeric replies for trip selection (text message after inline button)
    api.on('message_received', async (event) => {
        try {
            const chatId = String(event?.metadata?.senderId || '');
            if (!chatId)
                return;
            const pending = pendingTripSelections.get(chatId);
            if (!pending || Date.now() > pending.expiresAt) {
                if (pending)
                    pendingTripSelections.delete(chatId);
                return;
            }
            const text = String(event?.content || '').trim();
            const num = parseInt(text, 10);
            if (isNaN(num) || num < 1 || num > pending.trips.length)
                return;
            const selectedTrip = pending.trips[num - 1];
            const bookingEntry = pendingBookings.get(pending.bookingKey);
            pendingTripSelections.delete(chatId);
            if (!bookingEntry) {
                sendTelegram(chatId, '❌ Buchung nicht mehr verfügbar (abgelaufen).').catch(() => { });
                return;
            }
            const { booking } = bookingEntry;
            pendingBookings.delete(pending.bookingKey);
            const emoji = BOOKING_EMOJI[booking.type] || '📧';
            await addBookingAsSegment(selectedTrip.id, booking);
            sendTelegram(chatId, `✅ ${emoji} ${booking.title} zu Reise *${selectedTrip.name}* hinzugefügt.`).catch(() => { });
        }
        catch { }
    });
    // Hook to handle callback_query from Telegram (content-event pattern, E3)
    api.on('message_received', async (event) => {
        try {
            // ── segdel_ callbacks (Travel segment deletion) ──
            const segdelCb = parseCallbackEvent(event, 'segdel');
            if (segdelCb) {
                const chatId = segdelCb.senderId;
                if (segdelCb.args.length < 2)
                    return;
                const delKey = `segdel_${segdelCb.args[0]}`;
                const action = segdelCb.args[1];
                await handleSegmentDeletionCallback(chatId, delKey, action);
                return;
            }
            // ── booking_ callbacks (Mail booking → trip assignment) ──
            const bookingCb = parseCallbackEvent(event, 'booking');
            if (bookingCb) {
                const chatId = bookingCb.senderId;
                if (bookingCb.args.length < 2)
                    return;
                const bookingKey = `booking_${bookingCb.args[0]}`;
                const action = bookingCb.args[1];
                await handleBookingCallback(chatId, bookingKey, action);
                return;
            }
            // ── bweekly_ callbacks (Banking weekly sync start, E3) ──
            const bweeklyCb = parseCallbackEvent(event, 'bweekly');
            if (bweeklyCb) {
                const chatId = bweeklyCb.senderId;
                if (bweeklyCb.payload === 'start') {
                    await sendTelegram(chatId, '\uD83D\uDD04 Umsatzabruf wird gestartet...');
                    const { startWeeklySync } = await import('./src/modules/banking/sync-engine.js');
                    const result = await startWeeklySync({ runPhase: 'manual' });
                    if (result.status === 'SUCCESS_FULL') {
                        const totalTx = result.accounts.reduce((s, a) => s + a.transactions_inserted, 0);
                        await sendTelegram(chatId, `\u2705 Sync erfolgreich! ${totalTx} neue Umsaetze.`);
                    }
                    else if (result.status === 'TAN_REQUIRED') {
                        // Alert with bsync_ button was already sent by startWeeklySync
                        await sendTelegram(chatId, '\u23F3 Bank verlangt TAN. Bitte Button oben nutzen.');
                    }
                    else {
                        await sendTelegram(chatId, `\u2139\uFE0F Sync-Status: ${result.status}`);
                    }
                }
                return;
            }
            // ── bsync_ callbacks (Banking re-sync after TAN confirmation) ──
            const bsyncCb = parseCallbackEvent(event, 'bsync');
            if (bsyncCb) {
                const chatId = bsyncCb.senderId;
                const dbRunId = parseInt(bsyncCb.payload, 10);
                if (isNaN(dbRunId)) {
                    await sendTelegram(chatId, '\u274C Ungueltige Sync-Run-ID.');
                    return;
                }
                const { validateResyncRequest, eventResync } = await import('./src/modules/banking/sync-engine.js');
                const { updateSyncRun } = await import('./src/modules/banking/store.js');
                const validation = await validateResyncRequest(dbRunId);
                if (!validation.ok) {
                    await sendTelegram(chatId, `\u274C ${validation.reason}`);
                    return;
                }
                // Idempotency: mark original run as consumed before starting resync.
                // Second tap on same button finds status != TAN_REQUIRED → rejected.
                await updateSyncRun(dbRunId, { status: 'RESYNC_TRIGGERED' });
                await sendTelegram(chatId, '\uD83D\uDD04 Re-Sync wird gestartet...');
                const result = await eventResync(validation.institutionId, 'telegram_button', String(dbRunId));
                if (result.status === 'SUCCESS_FULL') {
                    const totalTx = result.accounts.reduce((s, a) => s + a.transactions_inserted, 0);
                    await sendTelegram(chatId, `\u2705 Re-Sync erfolgreich! ${totalTx} neue Umsaetze.`);
                }
                else if (result.status === 'TAN_REQUIRED') {
                    // Alert with new bsync_ button was already sent by eventResync (E3 §2.8a).
                }
                else {
                    await sendTelegram(chatId, `\u26A0\uFE0F Re-Sync Status: ${result.status}`);
                }
                return;
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] callback Fehler: ${e?.message}`);
        }
    });
    // ── Mail-Scanner Hintergrund-Task (alle 30 Minuten) ───────────────────────
    setInterval(async () => {
        try {
            if (!m365Enabled && !yahooEnabled)
                return;
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            const { found } = await scanMailsForBookings(s.telegramChatId);
            if (found > 0) {
                api.logger.info(`[executive-agent] Mail-Scanner: ${found} Buchung(en) erkannt`);
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Mail-Scanner Fehler: ${e.message}`);
        }
    }, 30 * 60_000);
    // ── Tägliches Briefing (Scheduler, prüft jede Minute) ─────────────────────
    let lastBriefingDate = '';
    let pendingBriefingRetry = null;
    setInterval(async () => {
        try {
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            // ── Briefing-Retry: zuvor fehlgeschlagene Zustellung nochmal versuchen ──
            if (pendingBriefingRetry && pendingBriefingRetry.attempts < 5) {
                const retry = pendingBriefingRetry;
                const backoffMs = Math.min(1000 * Math.pow(2, retry.attempts), 60000);
                retry.attempts++;
                api.logger.info(`[executive-agent] Briefing-Retry Versuch ${retry.attempts} (Backoff ${backoffMs}ms)`);
                await sleep(backoffMs);
                const sent = await sendTelegram(retry.chatId, retry.text);
                if (sent) {
                    api.logger.info(`[executive-agent] Briefing-Retry erfolgreich (Versuch ${retry.attempts})`);
                    pendingBriefingRetry = null;
                }
                return; // Don't run normal briefing logic during retry
            }
            else if (pendingBriefingRetry && pendingBriefingRetry.attempts >= 5) {
                api.logger.error(`[executive-agent] Briefing-Retry aufgegeben nach 5 Versuchen`);
                pendingBriefingRetry = null;
            }
            // Aktuelle Berliner Zeit als HH:MM
            const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
            const hh = String(inBerlin.getHours()).padStart(2, '0');
            const mm = String(inBerlin.getMinutes()).padStart(2, '0');
            const nowHHMM = `${hh}:${mm}`;
            const today = berlinDate(0);
            if (nowHHMM === s.briefingTime && lastBriefingDate !== today) {
                // Withings-Sync parallel zum Briefing starten (darf fehlschlagen)
                const BRIEFING_TIMEOUT_MS = 45000;
                const briefingWork = async () => {
                    // Sync both providers before generating briefing (may fail independently)
                    await Promise.allSettled([
                        syncWithingsForBriefing().catch((syncErr) => {
                            api.logger.warn(`[executive-agent] Briefing Withings-Sync Fehler (ignoriert): ${syncErr.message}`);
                        }),
                        syncOuraForBriefing().catch((syncErr) => {
                            api.logger.warn(`[executive-agent] Briefing Oura-Sync Fehler (ignoriert): ${syncErr.message}`);
                        }),
                    ]);
                    return await generateBriefingText();
                };
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('briefing_timeout')), BRIEFING_TIMEOUT_MS));
                const text = await Promise.race([briefingWork(), timeoutPromise]);
                const sent = await sendTelegram(s.telegramChatId, text);
                if (sent) {
                    lastBriefingDate = today;
                    api.logger.info(`[executive-agent] Tägliches Briefing gesendet (${today} ${nowHHMM})`);
                }
                else {
                    // Zustellung fehlgeschlagen → Retry-Queue
                    pendingBriefingRetry = { text, chatId: s.telegramChatId, attempts: 0 };
                    lastBriefingDate = today; // Prevent re-generating, retry the existing text
                    api.logger.warn(`[executive-agent] Briefing generiert aber Zustellung fehlgeschlagen — Retry geplant`);
                }
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Briefing-Scheduler Fehler: ${e.message}`);
        }
    }, 60_000);
    // ── Daily Health Check (08:00 Berlin) ─────────────────────────────────────
    let lastDailyHealthDate = '';
    setInterval(async () => {
        try {
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
            const hh = String(inBerlin.getHours()).padStart(2, '0');
            const mm = String(inBerlin.getMinutes()).padStart(2, '0');
            const nowHHMM = `${hh}:${mm}`;
            const today = berlinDate(0);
            if (nowHHMM === '08:00' && lastDailyHealthDate !== today) {
                lastDailyHealthDate = today;
                const report = await runDailyHealthCheck();
                api.logger.info(`[executive-agent] Daily Health Check: ${report.status.toUpperCase()}`);
                if (report.status === 'green') {
                    await sendTelegram(s.telegramChatId, '🟢 Daily Health Check — alle Systeme OK');
                }
                else {
                    await sendTelegram(s.telegramChatId, formatHealthReport(report, 'Daily Health Check'));
                }
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Daily Health Check Fehler: ${e.message}`);
        }
    }, 60_000);
    // ── Banking Reminder (Mo 12:00 Berlin, E3 — NO bank contact) ──────────────
    let lastBankingReminderDate = '';
    setInterval(async () => {
        try {
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
            const hh = String(inBerlin.getHours()).padStart(2, '0');
            const mm = String(inBerlin.getMinutes()).padStart(2, '0');
            const nowHHMM = `${hh}:${mm}`;
            const today = berlinDate(0);
            // Montag = getDay() === 1
            if (nowHHMM === '12:00' && inBerlin.getDay() === 1 && lastBankingReminderDate !== today) {
                lastBankingReminderDate = today;
                await sendTelegramWithKeyboard(s.telegramChatId, '\uD83C\uDFE6 W\u00f6chentlicher Umsatzabruf\n\nButton dr\u00fccken, um den Sync zu starten.', [[{ text: '\uD83C\uDFE6 Umsatzabruf starten', callback_data: 'bweekly_start' }]]);
            }
        }
        catch (e) {
            api.logger.error(`[banking-reminder] ${e.message}`);
        }
    }, 60_000);
    // ── Wöchentlicher Health-Report → src/modules/health/commands.ts (Timer) ──
    // ── Plugin HTTP routes on gateway port 18789 ─────────────────────────────
    // Register /health, /ready, /version, /location via api.registerHttpRoute()
    // so they run on the gateway's main port. The gateway checks plugin routes
    // BEFORE the Control UI SPA fallback, so JSON endpoints coexist with HTML.
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/health',
        handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'executive-agent', uptime: process.uptime() }));
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/ready',
        handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, service: 'executive-agent' }));
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/version',
        handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ service: 'executive-agent', node: process.version, uptime: process.uptime() }));
        },
    });
    // ── System Status (aggregated data for Dashboard Status Widget) ───────────
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/system-status',
        handler: async (_req, res) => {
            try {
                // 1. Service health from DB + live checks for Postgres and IB Gateway
                const serviceRows = await dbQuery('SELECT service, status, last_change FROM service_health').then(r => r.rows).catch(() => []);
                const services = serviceRows.map(r => ({
                    name: r.service,
                    status: r.status,
                    uptime_seconds: r.status === 'up' && r.last_change
                        ? Math.round((Date.now() - new Date(r.last_change).getTime()) / 1000) : 0,
                }));
                // Live-check Postgres
                let pgOk = false;
                try {
                    await dbQuery('SELECT 1');
                    pgOk = true;
                }
                catch { }
                const pgEntry = services.find(s => s.name === 'Postgres');
                if (!pgEntry)
                    services.push({ name: 'Postgres', status: pgOk ? 'up' : 'down', uptime_seconds: pgOk ? Math.round(process.uptime()) : 0 });
                // Live-check IB Gateway (port 7497)
                let ibOk = false;
                try {
                    const r = await fetch('http://127.0.0.1:18793/health', { signal: AbortSignal.timeout(3000) });
                    if (r.ok) {
                        const data = await r.json();
                        ibOk = data.ibkr?.connected === true;
                    }
                }
                catch { }
                const ibEntry = services.find(s => s.name === 'IB Gateway');
                if (!ibEntry)
                    services.push({ name: 'IB Gateway', status: ibOk ? 'up' : 'down', uptime_seconds: 0 });
                // 2. Token expiry
                const tokens = [];
                try {
                    const { rows: itRows } = await dbQuery(`SELECT expires_at FROM insta_tokens WHERE active = true LIMIT 1`);
                    if (itRows.length && itRows[0].expires_at) {
                        const expiresAt = new Date(itRows[0].expires_at).getTime();
                        tokens.push({ name: 'Meta', days_remaining: Math.floor((expiresAt - Date.now()) / 86_400_000) });
                    }
                }
                catch { }
                // Withings: NOT included. expires_at tracks the 3h access token (auto-rotated
                // by syncWithingsForBriefing), not the refresh token. days_remaining always ~0.
                // Real auth signal: retry-on-401 + "Auth verloren" Telegram in withings.ts.
                // 3. Workflows pending
                let workflowsPending = 0;
                let workflowTypes = [];
                try {
                    const wf = await dbQuery(`SELECT count(*)::text, array_agg(DISTINCT type) as types FROM workflows WHERE status IN ('pending','running','awaiting_approval')`);
                    if (wf.rows[0]) {
                        workflowsPending = parseInt(wf.rows[0].count, 10);
                        workflowTypes = (wf.rows[0].types || []).filter(Boolean);
                    }
                }
                catch { }
                // 4. Last backup (from systemd timer)
                let lastBackup = null;
                try {
                    const timerOut = execSync("systemctl --user show openclaw-backup-daily.service --property=ExecMainStartTimestamp --value", { encoding: 'utf-8', timeout: 3000 }).trim();
                    if (timerOut)
                        lastBackup = new Date(timerOut).toISOString();
                }
                catch { }
                // Fallback: check borg list (slow, only if no systemd data)
                if (!lastBackup) {
                    try {
                        const borgOut = execSync('BORG_PASSPHRASE=$(grep BORG_PASSPHRASE ~/.config/openclaw/env | cut -d= -f2) BORG_RSH="ssh -p 23" borg list ssh://u591557@u591557.your-storagebox.de:23/./openclaw/daily --last 1 --format "{time}" 2>/dev/null', { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' }).trim();
                        if (borgOut)
                            lastBackup = new Date(borgOut).toISOString();
                    }
                    catch { }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    services,
                    tokens,
                    workflows: { pending: workflowsPending, types: workflowTypes },
                    backup: { last: lastBackup },
                    timestamp: new Date().toISOString(),
                }));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    // ── Token Guardian (Sprint 3 §5.2) ─────────────────────────────────────────
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/instagram/token-health',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            // Bearer token auth
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const health = await getTokenHealth();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(health));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/instagram/token-refresh',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            // Bearer token auth
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                if (!metaAppId || !metaAppSecret) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'META_APP_ID/META_APP_SECRET not configured' }));
                    return;
                }
                const refreshed = await ensureInstaToken(metaAppId, metaAppSecret, true);
                audit.log({ module: 'instagram', action: 'instagram.token_refreshed', entityType: 'token', entityId: 'meta_instagram', after: { expires_at: new Date(refreshed.expires_at).toISOString(), source: 'api' } }).catch(() => { });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, expires_at: new Date(refreshed.expires_at).toISOString() }));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        },
    });
    // ── Health: Withings Sync (Sprint 4 §4) ──────────────────────────────────────
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/withings-sync',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const result = await triggerWithingsSync();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...result }));
            }
            catch (err) {
                api.logger.error(`[health] withings-sync failed: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/sync-status',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const status = await getSyncStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    // ── Health: Oura Sync ──────────────────────────────────────────────────────
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/oura-sync',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const result = await triggerOuraSync();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...result }));
            }
            catch (err) {
                api.logger.error(`[health] oura-sync failed: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/oura-sync-status',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const status = await getOuraSyncStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    // ── Health Dashboard Endpoints (Postgres-backed, used by Dashboard proxy) ──
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/entries',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const url = new URL(req.url, 'http://localhost');
                const days = Math.min(Math.max(1, Number(url.searchParams.get('days')) || 30), 365);
                const since = new Date(Date.now() - days * 86_400_000);
                let entries = await readEntries(since);
                // Aggregate sleep sessions per night
                const sleepByNight = new Map();
                const nonSleep = [];
                for (const e of entries) {
                    if (e.type === 'sleep' && e.value != null) {
                        const day = e.timestamp.slice(0, 10);
                        const prev = sleepByNight.get(day);
                        if (prev) {
                            prev.value = (prev.value || 0) + (e.value || 0);
                            prev.deep_sleep_h = (prev.deep_sleep_h || 0) + (e.deep_sleep_h || 0);
                            prev.rem_sleep_h = (prev.rem_sleep_h || 0) + (e.rem_sleep_h || 0);
                            prev.light_sleep_h = (prev.light_sleep_h || 0) + (e.light_sleep_h || 0);
                            if (e.quality && e.quality > (prev.quality || 0))
                                prev.quality = e.quality;
                        }
                        else {
                            sleepByNight.set(day, { ...e });
                        }
                    }
                    else {
                        nonSleep.push(e);
                    }
                }
                let normalized = [...nonSleep, ...sleepByNight.values()];
                // Normalize entries for dashboard display
                normalized = normalized.map((e) => {
                    if (e.type === 'steps') {
                        e.value = e.steps ?? 0;
                        e.unit = 'Schritte';
                    }
                    if (e.type === 'heartrate') {
                        e.value = e.hr_avg ?? 0;
                        e.unit = 'bpm';
                    }
                    if (e.type === 'activity') {
                        const parts = [];
                        if (e.duration_min)
                            parts.push(`${e.duration_min} min`);
                        if (e.steps)
                            parts.push(`${e.steps} Schritte`);
                        if (e.distance_m)
                            parts.push(`${(e.distance_m / 1000).toFixed(1)} km`);
                        if (e.calories)
                            parts.push(`${e.calories} kcal`);
                        e.value = parts.join(', ') || null;
                        e.unit = '';
                        e.text = e.activity_type || '';
                    }
                    if (e.type === 'sleep') {
                        e.value = Math.round((e.value || 0) * 10) / 10;
                    }
                    if (e.type === 'hrv') {
                        e.value = e.hrv_ms ?? 0;
                        e.unit = 'ms';
                    }
                    if (e.type === 'readiness') {
                        e.value = e.readiness_score ?? 0;
                        e.unit = 'score';
                    }
                    if (e.type === 'temperature') {
                        e.value = e.temp_deviation ?? 0;
                        e.unit = '°C';
                    }
                    return e;
                }).filter((e) => {
                    if (e.type !== 'activity')
                        return true;
                    return e.steps || e.distance_m || e.calories || e.hr_avg;
                }).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(normalized));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/trends',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const url = new URL(req.url, 'http://localhost');
                const daysRaw = Math.min(Math.max(1, Number(url.searchParams.get('days')) || 30), 365);
                // Snap to valid trend period
                const days = daysRaw <= 7 ? 7 : daysRaw <= 30 ? 30 : 90;
                const [weight, sleep, heartrate, hrv] = await Promise.all([
                    getWeightTrend(days),
                    getSleepTrend(days),
                    getHeartrateTrend(days),
                    getHrvTrend(days),
                ]);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ weight, sleep, heartrate, hrv }));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/alerts',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const alerts = await checkHealthAlerts();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(alerts));
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/health/chart-data',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            const auth = req.headers?.authorization || '';
            if (!coreServiceToken || auth !== `Bearer ${coreServiceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            try {
                const url = new URL(req.url, 'http://localhost');
                const type = url.searchParams.get('type') || 'weight';
                const days = Math.min(Math.max(1, Number(url.searchParams.get('days')) || 90), 365);
                const since = new Date(Date.now() - days * 86_400_000);
                const entries = await readEntries(since);
                if (type === 'weight') {
                    const data = entries
                        .filter(e => e.type === 'weight' && e.value != null)
                        .map(e => ({ date: e.timestamp.slice(0, 10), value: e.value }))
                        .sort((a, b) => a.date.localeCompare(b.date));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                }
                else if (type === 'sleep') {
                    const byDay = new Map();
                    for (const e of entries.filter(e => e.type === 'sleep' && e.value != null)) {
                        const day = e.timestamp.slice(0, 10);
                        const prev = byDay.get(day);
                        if (prev) {
                            prev.duration += e.value;
                            if (e.quality != null && e.quality > (prev.quality || 0))
                                prev.quality = e.quality;
                        }
                        else {
                            byDay.set(day, { date: day, duration: e.value, quality: e.quality ?? null });
                        }
                    }
                    for (const v of byDay.values())
                        v.duration = Math.round(v.duration * 10) / 10;
                    const data = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                }
                else if (type === 'hrv') {
                    const data = entries
                        .filter(e => e.type === 'hrv' && e.hrv_ms != null)
                        .map(e => ({ date: e.timestamp.slice(0, 10), value: e.hrv_ms }))
                        .sort((a, b) => a.date.localeCompare(b.date));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                }
                else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'type must be weight, sleep, or hrv' }));
                }
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        },
    });
    // ── Internal Notify (localhost only — nginx allow 127.0.0.1; deny all) ─────
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/api/internal/notify',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            try {
                const chunks = [];
                for await (const chunk of req)
                    chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const message = body.message;
                if (!message || typeof message !== 'string' || message.length > 4000) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'message required (string, max 4000 chars)' }));
                    return;
                }
                const severity = ['info', 'warn', 'error'].includes(body.severity) ? body.severity : 'info';
                const defaultEmoji = { info: 'ℹ️', warn: '⚠️', error: '🔴' };
                const emoji = typeof body.emoji === 'string' && body.emoji.length > 0 ? body.emoji : defaultEmoji[severity];
                const text = `${emoji} ${message}`;
                const s = loadSettings();
                const chatId = s.telegramChatId;
                if (!chatId) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'telegramChatId not configured' }));
                    return;
                }
                // Send via direct Telegram API to capture message_id
                if (!telegramBotToken) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'no bot token available' }));
                    return;
                }
                const tgRes = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
                }, 15000);
                const tgBody = await tgRes.json();
                if (!tgRes.ok) {
                    api.logger.error(`[notify] Telegram error: ${JSON.stringify(tgBody)}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Telegram send failed', details: tgBody.description }));
                    return;
                }
                audit.log({
                    module: 'executive',
                    action: 'executive.internal_notify',
                    entityType: 'notification',
                    source: 'system',
                    after: { severity, sent: true },
                }).catch(() => { });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message_id: tgBody.result?.message_id }));
            }
            catch (err) {
                api.logger.error(`[notify] Error: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        },
    });
    // ── Location: shared Nominatim reverse-geocoding helper ────────────────
    async function resolveLocationLabel(lat, lon, cityHint) {
        const rawCity = cityHint != null ? String(cityHint).trim() : '';
        if (rawCity && !/^\d+(\.\d+)?$/.test(rawCity))
            return rawCity;
        let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        try {
            const geoRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`, { method: 'GET', headers: { 'User-Agent': 'openclaw-executive-agent/1.0' } }, 10000);
            if (geoRes.ok) {
                const geo = await geoRes.json();
                label = geo?.address?.city
                    || geo?.address?.town
                    || geo?.address?.village
                    || geo?.address?.municipality
                    || geo?.display_name?.split(',')[0]
                    || label;
            }
        }
        catch { /* geocoding optional, keep coordinate label */ }
        return label;
    }
    api.registerHttpRoute({
        auth: 'plugin', match: 'exact',
        path: '/location',
        handler: async (req, res) => {
            // CORS preflight
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                });
                res.end();
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
                return;
            }
            // Auth check
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!gatewayToken || token !== gatewayToken) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
                return;
            }
            // Parse JSON body
            let body = '';
            try {
                await new Promise((resolve, reject) => {
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', resolve);
                    req.on('error', reject);
                    setTimeout(() => reject(new Error('timeout')), 10000);
                });
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
                return;
            }
            const lat = parseFloat(String(parsed.lat));
            const lon = parseFloat(String(parsed.lon));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'lat/lon required' }));
                return;
            }
            const label = await resolveLocationLabel(lat, lon, parsed.city);
            const altitude = parsed.altitude != null ? parseFloat(String(parsed.altitude)) : null;
            await insertLocationEvent({ lat, lon, label, altitude: Number.isFinite(altitude) ? altitude : null });
            api.logger.info(`[executive-agent] Location-API: Standort gespeichert: ${label} (${lat}, ${lon})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, label }));
        },
    });
    api.logger.info('[executive-agent] HTTP routes registered on gateway port 18789 (/health, /ready, /version, /location)');
    // ── Assets HTTP API (Sprint 5.5a-1) ──────────────────────────────────────
    registerAssetsHttpRoutes(api);
    // ── Fleet HTTP API (Sprint 6c) ──────────────────────────────────────────
    registerFleetHttpRoutes(api);
    // ── Banking HTTP API (Sprint 7b) ──────────────────────────────────────────
    registerBankingHttpRoutes(api);
    // ── Links HTTP API (Sprint 9) ──────────────────────────────────────────
    registerLinksHttpRoutes(api);
    // ── SharePoint HTTP API (Sprint 10) ──────────────────────────────────────
    registerSharePointHttpRoutes(api);
    // ── Instagram Inbox HTTP API (E2b) ──────────────────────────────────────
    registerInboxHttpRoute(api);
    // ── Instagram Edit Queue HTTP API (E4a) ────────────────────────────────
    registerEditQueueRoutes(api);
    // ── Startup Canary ───────────────────────────────────────────────────────
    if (!coreServiceToken) {
        api.logger.error('[executive-agent] CRITICAL: CORE_SERVICE_TOKEN not set — assets API will reject all requests');
    }
    // ── Public Location HTTP Endpoint (POST /location, 0.0.0.0:18790) ────────
    const publicLocationPort = 18790;
    const publicLocationServer = http.createServer(async (req, res) => {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            });
            res.end();
            return;
        }
        if (req.method !== 'POST' || (req.url && !req.url.startsWith('/location'))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Not found' }));
            return;
        }
        // Auth check
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!gatewayToken || token !== gatewayToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }
        // Parse JSON body
        let body = '';
        try {
            await new Promise((resolve, reject) => {
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', resolve);
                req.on('error', reject);
                setTimeout(() => reject(new Error('timeout')), 10000);
            });
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
            return;
        }
        const lat = parseFloat(String(parsed.lat));
        const lon = parseFloat(String(parsed.lon));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'lat/lon required' }));
            return;
        }
        const label = await resolveLocationLabel(lat, lon, parsed.city);
        const altitude = parsed.altitude != null ? parseFloat(String(parsed.altitude)) : null;
        await insertLocationEvent({ lat, lon, label, altitude: Number.isFinite(altitude) ? altitude : null });
        api.logger.info(`[executive-agent] Public Location-API: Standort gespeichert: ${label} (${lat}, ${lon})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, label }));
    });
    publicLocationServer.on('error', (e) => {
        api.logger.error(`[executive-agent] Public Location-Server Fehler: ${e.message}`);
    });
    publicLocationServer.listen(publicLocationPort, '127.0.0.1', () => {
        api.logger.info(`[executive-agent] Location-API gestartet auf 127.0.0.1:${publicLocationPort} (via nginx/HTTPS)`);
    });
    // ── Browser Cleanup ──────────────────────────────────────────────────────
    process.on("beforeExit", () => { closeBrowser().catch(() => { }); });
    process.on("SIGTERM", () => { closeBrowser().catch(() => { }); });
    // ── Inject Instagram token adapter into system-health (K1 fix) ──────────
    initSystemHealth({
        loadTokens: loadInstaTokens,
        tokenDaysRemaining,
        ensureFreshToken: ensureInstaToken,
    });
    api.logger.info("[executive-agent] loaded v33 (craft engine)");
    // ── Startup Self-Test (async, non-blocking) ────────────────────────────
    (async () => {
        try {
            const report = await runStartupChecks();
            const summary = report.checks.map(c => `${c.status}: ${c.name}`).join(', ');
            api.logger.info(`[executive-agent] Startup Self-Test: ${report.status.toUpperCase()} — ${summary}`);
            if (report.status === 'red') {
                const s = loadSettings();
                if (s.telegramChatId) {
                    await sendTelegram(s.telegramChatId, formatHealthReport(report));
                }
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Startup Self-Test Fehler: ${e.message}`);
        }
        // ── Settings Migration + Cache Init (Sprint 11) ─────────────────────────
        try {
            const settingsMigrationsDir = path.join(__dirname, 'src/shared/settings/migrations');
            const settingsApplied = await runMigrations(settingsMigrationsDir, 'settings');
            if (settingsApplied > 0)
                api.logger.info(`[settings] Applied ${settingsApplied} migration(s)`);
            await refreshSettingsCache();
            startSettingsCacheRefresh();
            api.logger.info('[settings] DB cache initialized');
        }
        catch (e) {
            api.logger.error(`[settings] Init failed: ${e.message} — file fallback`);
        }
        // ── Location Migrations (Sprint 8) ─────���──────���───────────────────────
        try {
            const locationMigrationsDir = path.join(__dirname, 'src/modules/location/migrations');
            const locationApplied = await runMigrations(locationMigrationsDir, 'location');
            if (locationApplied > 0)
                api.logger.info(`[location] Applied ${locationApplied} migration(s)`);
        }
        catch (e) {
            api.logger.error(`[location] Migration failed: ${e.message}`);
        }
        // ── Links Migrations (Sprint 9) ──────────────────────────────────────
        try {
            const linksMigrationsDir = path.join(__dirname, 'src/modules/links/migrations');
            const linksApplied = await runMigrations(linksMigrationsDir, 'links');
            if (linksApplied > 0)
                api.logger.info(`[links] Applied ${linksApplied} migration(s)`);
        }
        catch (e) {
            api.logger.error(`[links] Migration failed: ${e.message}`);
        }
        // ── SharePoint Migrations (Sprint 10) ─────────────────────────────────
        try {
            const spMigrationsDir = path.join(__dirname, 'src/modules/sharepoint/migrations');
            const spApplied = await runMigrations(spMigrationsDir, 'sharepoint');
            if (spApplied > 0)
                api.logger.info(`[sharepoint] Applied ${spApplied} migration(s)`);
        }
        catch (e) {
            api.logger.error(`[sharepoint] Migration failed: ${e.message}`);
        }
        // ── Memory Migrations (Message-Sink) ──────────────────────────────────
        try {
            const memoryMigrationsDir = path.join(__dirname, 'src/modules/memory/migrations');
            const memoryApplied = await runMigrations(memoryMigrationsDir, 'memory');
            if (memoryApplied > 0)
                api.logger.info(`[memory] Applied ${memoryApplied} migration(s)`);
        }
        catch (e) {
            api.logger.error(`[memory] Migration failed: ${e.message}`);
        }
        // ── Instagram Edit Queue Recovery (E4a) ────────────────────────────────
        try {
            const recovered = await recoverStaleJobs();
            if (recovered > 0)
                api.logger.info(`[edit-queue] Recovered ${recovered} stale job(s)`);
        }
        catch (e) {
            api.logger.error(`[edit-queue] Recovery failed: ${e.message}`);
        }
        // ── Health Monitor ────────────────────────────────────────────────────
        try {
            const migrationsDir = path.join(__dirname, 'src/modules/executive/migrations');
            const applied = await runMigrations(migrationsDir, 'executive');
            api.logger.info(`[health-monitor] Applied ${applied} migration(s)`);
            const monitor = new HealthMonitor({
                sendTelegram,
                getChatId: () => loadSettings().telegramChatId,
                logger: api.logger,
            });
            await monitor.start();
        }
        catch (e) {
            api.logger.error(`[health-monitor] Failed to start: ${e.message}`);
        }
    })();
}
