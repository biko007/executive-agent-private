/**
 * memory/extract — Owner-Memory extraction engine
 *
 * resolveTranscript: Voice-Transkript aus [Audio transcript] Block parsen
 * shouldExtractMemory: Guard — soll fuer diesen Turn extrahiert werden?
 * extractFacts: LLM-gestuetzte Fakten-Extraktion aus einem Turn
 * runExtractSweep: Asynchroner Retry-Sweep fuer pending/failed Jobs
 *
 * LLM calls go through the gateway's api.runtime.llm.complete() — no direct
 * provider API calls. The gateway resolves provider, model, and credentials
 * from its configuration (agents.defaults.model.primary or plugin overrides).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getActiveOwnerFacts,
  insertOwnerFact,
  supersedeFact,
  updateExtractStatus,
  getPendingExtractionJobs,
  tryAdvisoryLock48,
  releaseAdvisoryLock48,
  normalizeFact,
  hashFact,
} from './store.js';

const PROMPT_VERSION = 'v1';

// ── Types for gateway LLM call ─────────────────────────────────────────────

/** Minimal contract for api.runtime.llm.complete() */
export interface LlmCompleteFunc {
  (params: {
    messages: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    purpose?: string;
  }): Promise<{ text: string; model: string; provider: string }>;
}

// ── resolveTranscript ──────────────────────────────────────────────────────

export interface TranscriptResult {
  text: string;
  source: 'audio_block' | 'inbound_claim' | 'fallback';
  ok: boolean;
}

/**
 * Resolve voice transcript from user message content.
 *
 * The framework (tools.media.audio) transcribes audio before the agent runs
 * and sets firstUser.content to:
 *   [Audio transcript (machine-generated, untrusted)]: "actual speech text"
 *
 * Primary: parse the [Audio transcript ...]: "..." pattern from rawContent.
 * Secondary: inbound_claim stash (kept for future framework versions).
 * Fallback: '[Voice message]' placeholder.
 */
export function resolveTranscript(
  stash: Map<string, { text: string; ts: number }>,
  sessionKey: string,
  rawContent?: string,
): TranscriptResult {
  // 1. Parse [Audio transcript ...]: "..." from firstUser.content (primary)
  if (rawContent) {
    const match = rawContent.match(/\[Audio transcript[^\]]*\]:\s*"([\s\S]+)"\s*$/);
    if (match) {
      const text = match[1].trim();
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && text.length >= 5) {
        return { text, source: 'audio_block', ok: true };
      }
    }
  }

  // 2. inbound_claim stash (secondary)
  if (sessionKey && stash.has(sessionKey)) {
    const entry = stash.get(sessionKey)!;
    stash.delete(sessionKey);
    const text = entry.text;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && text.length >= 5) {
      return { text, source: 'inbound_claim', ok: true };
    }
  }

  // 3. Fallback placeholder
  return { text: '[Voice message]', source: 'fallback', ok: false };
}

// ── shouldExtractMemory ────────────────────────────────────────────────────

export type ExtractDecision = 'extract' | 'skip';

export interface ExtractGuardResult {
  decision: ExtractDecision;
  reason: string;
}

/** Decide whether to extract memory from this turn. */
export function shouldExtractMemory(
  userText: string,
  senderId: string,
  ownerSenderIds: string[] = [],
): ExtractGuardResult {
  // Non-owner: never extract
  if (!ownerSenderIds.includes(senderId)) {
    return { decision: 'skip', reason: 'non_owner' };
  }

  const trimmed = userText.trim();

  // Voice placeholder
  if (trimmed === '[Voice message]') {
    return { decision: 'skip', reason: 'voice_placeholder' };
  }

  // Command turns (/-prefix)
  if (/^\s*\/[a-z]/i.test(trimmed)) {
    return { decision: 'skip', reason: 'command' };
  }

  // Too short (< 20 chars)
  if (trimmed.length < 20) {
    return { decision: 'skip', reason: 'too_short' };
  }

  // Codeblock-dominant (>50% of text in code blocks)
  const codeBlocks = trimmed.match(/```[\s\S]*?```/g);
  if (codeBlocks) {
    const codeLen = codeBlocks.reduce((sum, b) => sum + b.length, 0);
    if (codeLen / trimmed.length > 0.5) {
      return { decision: 'skip', reason: 'codeblock_dominant' };
    }
  }

  // Explicit negative signals
  const lower = trimmed.toLowerCase();
  const negativePatterns = [
    'merk dir das nicht',
    'vergiss das',
    'das war nur ein test',
    'ignore das',
    'nicht merken',
  ];
  for (const pat of negativePatterns) {
    if (lower.includes(pat)) {
      return { decision: 'skip', reason: 'negative_signal' };
    }
  }

  // Bare media / forwarded content markers
  if (/^\[user sent media/i.test(trimmed) || /^\[media attached:/i.test(trimmed)) {
    return { decision: 'skip', reason: 'bare_media' };
  }

  return { decision: 'extract', reason: 'ok' };
}

// ── extractFacts ───────────────────────────────────────────────────────────

interface ExtractedFact {
  fact: string;
  category: string;
  confidence: number;
  evidence_quote: string;
  action: 'insert' | 'supersede' | 'noop';
  target_fact_id?: number;
}

interface ExtractionResult {
  facts: ExtractedFact[];
}

/** Sensitive pattern filter — never store these as facts. */
function containsSensitiveSecret(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b[a-f0-9]{32,}\b/i.test(text) || // long hex strings (tokens, hashes)
    /\b(password|passwort|kennwort|pin)\s*[:=]/i.test(text) ||
    /\b[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2}\b/.test(text) || // IBAN
    /\bsk[-_][a-z0-9]{20,}/i.test(text) || // API keys (sk-...)
    /\b(secret|token|key)\s*[:=]\s*\S{10,}/i.test(lower)
  );
}

/** Load owner-facts.md content (capped at 12 KB). */
function loadOwnerFactsContent(): string {
  try {
    const factsPath = path.join(process.env.HOME || '/root', '.openclaw/owner-facts.md');
    const content = fs.readFileSync(factsPath, 'utf-8');
    if (content.length > 12_288) {
      return content.slice(0, 12_288) + '\n[... gekuerzt auf 12 KB ...]';
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Extract facts from a conversation turn via gateway LLM call.
 * Uses api.runtime.llm.complete() — provider/model resolved by gateway config.
 * Writes results directly to owner_memory.
 */
export async function extractFacts(
  logId: number,
  ownerSenderId: string,
  userText: string,
  agentText: string | null,
  llmComplete: LlmCompleteFunc,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  // Load existing active facts for dedup context
  const activeFacts = await getActiveOwnerFacts(ownerSenderId);
  const activeFactsContext = activeFacts
    .slice(0, 50)
    .map(f => `[${f.id}] ${f.fact}`)
    .join('\n');

  // Load owner-facts.md for exclusion
  const ownerFactsContent = loadOwnerFactsContent();

  // Deterministic pre-check: if user text repeats an existing fact verbatim, skip LLM
  const userNorm = normalizeFact(userText);
  const userHash = hashFact(userNorm);
  const existingHashes = new Set(activeFacts.map(f => hashFact(normalizeFact(f.fact))));
  if (existingHashes.has(userHash)) {
    await updateExtractStatus(logId, 'done');
    logger?.info(`[memory-extract] logId=${logId} exact-dedup, skipped LLM call`);
    return;
  }

  const systemPrompt = `Du bist ein Fakten-Extraktor fuer ein persoenliches Gedaechtnis-System.
Extrahiere DAUERHAFTE persoenliche Fakten aus der User-Nachricht.

REGELN:
- Nur Fakten, die DAUERHAFT gelten (keine Tagesbefindlichkeiten, keine temporaeren Aussagen)
- Jeder Fakt muss ein atomarer, deklarativer Satz sein (max 200 Zeichen)
- Pronomen aufloesen (statt "Er mag das" → konkreter Name + Gegenstand)
- Keine Anweisungen oder Befehle als Fakten speichern
- Keine Passwoerter, Tokens, Keys, IBANs, Einmalcodes als Fakten
- Gesundheits-/Beziehungsdetails: sensitivity="sensitive"
- Max 5 Fakten pro Nachricht
- evidence_quote MUSS woertlich aus der User-Nachricht stammen

DEDUP/UPDATE-REGELN:
- Vergleiche mit den bestehenden Fakten und owner-facts.md
- Fakt existiert bereits (inhaltlich/paraphrasiert)? → action="noop"
- Fakt steht in owner-facts.md? → action="noop"
- Widerspruch/Update zu bestehendem Fakt? → action="supersede", target_fact_id=<id des alten>
- Neuer Fakt? → action="insert"

Antworte NUR mit validem JSON (kein Markdown, kein Text):
{ "facts": [{ "fact": "...", "category": "person|preference|project|health|business|other", "confidence": 0.0-1.0, "evidence_quote": "...", "action": "insert|supersede|noop", "target_fact_id": null }] }

Wenn keine extrahierbaren Fakten: { "facts": [] }`;

  const userPrompt = `BESTEHENDE FAKTEN (id + text):
${activeFactsContext || '(keine)'}

OWNER-FACTS.MD (verbindlich, nicht nochmals speichern):
${ownerFactsContent || '(leer)'}

USER-NACHRICHT:
${userText}

AGENT-ANTWORT (nur zur Referenz, Fakten stammen aus User-Nachricht):
${agentText || '(keine)'}`;

  // LLM call with retry (gateway handles timeout/auth/provider internally)
  let parsed: ExtractionResult | null = null;
  let resolvedModel = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await llmComplete({
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt,
        maxTokens: 1024,
        temperature: 0.2,
        purpose: 'executive-agent.memory-extraction',
      });

      resolvedModel = `${result.provider}/${result.model}`;
      const raw = result.text;

      // Extract JSON from response (may be wrapped in markdown code fences)
      let jsonStr = raw.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      parsed = JSON.parse(jsonStr) as ExtractionResult;

      if (!parsed?.facts || !Array.isArray(parsed.facts)) {
        throw new Error('Invalid response structure: missing facts array');
      }
      break; // Success
    } catch (err: any) {
      if (attempt === 0) {
        logger?.warn(`[memory-extract] logId=${logId} attempt=${attempt} retry: ${err.message}`);
        continue;
      }
      throw err; // Second attempt failed
    }
  }

  if (!parsed) {
    throw new Error('extraction_parse_failed');
  }

  // Process extracted facts (max 5)
  const facts = parsed.facts.slice(0, 5);
  let insertedCount = 0;
  let supersededCount = 0;

  for (const f of facts) {
    if (f.action === 'noop') continue;

    // Validate fact
    if (!f.fact || typeof f.fact !== 'string' || f.fact.trim().length === 0) continue;
    if (f.fact.length > 200) continue;
    if (containsSensitiveSecret(f.fact)) continue;

    // Validate category
    const validCategories = ['person', 'preference', 'project', 'health', 'business', 'other'];
    const category = validCategories.includes(f.category) ? f.category : 'other';

    // Determine sensitivity
    let sensitivity = 'normal';
    if (category === 'health') sensitivity = 'sensitive';
    if (containsSensitiveSecret(f.evidence_quote || '')) sensitivity = 'never_inject';

    const factNorm = normalizeFact(f.fact);
    const factHash = hashFact(factNorm);
    const confidence = typeof f.confidence === 'number'
      ? Math.max(0, Math.min(1, f.confidence))
      : 0.5;

    const params = {
      ownerSenderId,
      fact: f.fact.trim(),
      factNorm,
      factHash,
      category,
      sensitivity,
      evidenceQuote: typeof f.evidence_quote === 'string' ? f.evidence_quote.slice(0, 500) : null,
      sourceLogId: logId,
      confidence,
      supersedesId: null as number | null,
      modelUsed: resolvedModel,
      promptVersion: PROMPT_VERSION,
    };

    if (f.action === 'supersede' && typeof f.target_fact_id === 'number') {
      const newId = await supersedeFact(f.target_fact_id, params);
      if (newId) supersededCount++;
    } else if (f.action === 'insert') {
      const newId = await insertOwnerFact(params);
      if (newId) insertedCount++;
    }
  }

  await updateExtractStatus(logId, 'done');

  // Log counts only — no fact content (log discipline)
  logger?.info(
    `[memory-extract] logId=${logId} model=${resolvedModel} done: ${insertedCount} inserted, ${supersededCount} superseded, ${facts.length} total`,
  );

  // Invalidate recall cache on writes
  if (insertedCount > 0 || supersededCount > 0) {
    invalidateRecallCache();
  }
}

// ── runExtractSweep ────────────────────────────────────────────────────────

/**
 * Process pending/failed extraction jobs. Uses pg_advisory_lock(48)
 * for multi-load serialization.
 */
export async function runExtractSweep(
  llmComplete: LlmCompleteFunc,
  ownerSenderIds: string[],
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  sendTelegram?: (chatId: string, text: string) => Promise<boolean>,
  chatId?: string,
): Promise<void> {
  const acquired = await tryAdvisoryLock48();
  if (!acquired) return; // Another instance is running

  try {
    const jobs = await getPendingExtractionJobs(ownerSenderIds, 5);
    if (jobs.length === 0) return;

    logger?.info(`[memory-sweep] Processing ${jobs.length} job(s)`);

    for (const job of jobs) {
      try {
        const guard = shouldExtractMemory(job.user_text, job.sender_id, ownerSenderIds);
        if (guard.decision === 'skip') {
          await updateExtractStatus(job.id, 'skipped');
          continue;
        }

        await extractFacts(job.id, job.sender_id, job.user_text, job.agent_text, llmComplete, logger);
      } catch (err: any) {
        const errorMsg = err?.message?.slice(0, 200) ?? 'unknown';
        await updateExtractStatus(job.id, 'failed', errorMsg);

        // After 3 attempts: Telegram hint (error class only, no content)
        if (job.memory_extract_attempts + 1 >= 3 && sendTelegram && chatId) {
          const errorClass = errorMsg.includes('API') ? 'api_error'
            : errorMsg.includes('parse') ? 'parse_error'
            : errorMsg.includes('timeout') ? 'timeout'
            : 'unknown';
          sendTelegram(
            chatId,
            `\u26A0\uFE0F Memory-Extraktion fehlgeschlagen (logId=${job.id}, Fehlerklasse: ${errorClass}). 3 Versuche erschoepft.`,
          ).catch(() => {});
        }
      }
    }
  } finally {
    await releaseAdvisoryLock48().catch(() => {});
  }
}

// ── Recall Cache ───────────────────────────────────────────────────────────

/** Invalidate the shared recall cache (called after owner_memory writes). */
export function invalidateRecallCache(): void {
  const g = globalThis as any;
  if (g.__ea_memoryRecallCache) {
    g.__ea_memoryRecallCache.ts = 0;
  }
}
