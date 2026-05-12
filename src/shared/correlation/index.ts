/**
 * shared/correlation — Request and correlation ID tracking
 *
 * Uses AsyncLocalStorage to propagate request_id and correlation_id
 * through the call stack without explicit parameter passing.
 *
 * Sources:
 * - Telegram update → new request_id
 * - Dashboard request → new request_id
 * - n8n trigger → X-Correlation-ID header adopted
 * - Internal cron → Core generates
 *
 * Long-running workflows keep their correlation_id across days.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  actor?: string;   // e.g. 'telegram:12345', 'dashboard', 'n8n', 'system'
  source?: string;  // 'telegram' | 'dashboard' | 'n8n' | 'system'
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Generate a new UUID v4. */
export function generateId(): string {
  return randomUUID();
}

/** Run a function with request context available via getContext(). */
export function withContext<T>(
  ctx: Partial<RequestContext> & { correlationId?: string },
  fn: () => T,
): T {
  const full: RequestContext = {
    requestId: ctx.requestId ?? generateId(),
    correlationId: ctx.correlationId ?? ctx.requestId ?? generateId(),
    actor: ctx.actor,
    source: ctx.source,
  };
  return storage.run(full, fn);
}

/** Get the current request context, or undefined if outside withContext(). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Get the current request ID, or generate a one-off if no context. */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? generateId();
}

/** Get the current correlation ID, or generate a one-off if no context. */
export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? generateId();
}

/** Get the current actor, or 'system' as default. */
export function getActor(): string {
  return storage.getStore()?.actor ?? 'system';
}

/** Get the current source, or 'system' as default. */
export function getSource(): string {
  return storage.getStore()?.source ?? 'system';
}
