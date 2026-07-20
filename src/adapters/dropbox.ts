/**
 * Dropbox API adapter — fetch-based, no npm SDK.
 *
 * App-Folder scope: all paths relative to /Apps/<app-name>/.
 * Token refresh: lazy, in-memory caching with proactive refresh.
 * Upload: simple (<=150MB) or chunked session (>150MB).
 */

import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DropboxErrorReason =
  | "auth_expired"
  | "auth_refresh_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "network_error"
  | "timeout"
  | "server_error";

export class DropboxError extends Error {
  constructor(
    public readonly reason: DropboxErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

export interface DropboxUploadResult {
  readonly pathDisplay: string;
  readonly size: number;
  readonly contentHash: string;
}

export interface DropboxAdapter {
  uploadFile(params: {
    path: string;
    body: Buffer;
    contentType: string;
  }): Promise<DropboxUploadResult>;

  uploadFileStream(params: {
    path: string;
    body: Readable;
    totalBytes: number;
  }): Promise<DropboxUploadResult>;

  createFolder(path: string): Promise<void>;

  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.dropboxapi.com";
const CONTENT_BASE = "https://content.dropboxapi.com";
const SIMPLE_UPLOAD_LIMIT = 150 * 1024 * 1024; // 150 MB
const CHUNK_TIMEOUT_MS = 120_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min before expiry

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export function createDropboxAdapter(params: {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): DropboxAdapter {
  const { appKey, appSecret, refreshToken } = params;
  const fetchFn = params.fetchImpl ?? fetch;
  let tokenCache: TokenCache | null = null;

  async function refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    });

    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      response = await fetchFn(`${API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DropboxError("timeout", "Token refresh timed out");
      }
      throw new DropboxError("network_error", `Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      throw new DropboxError("auth_refresh_failed", `Token refresh returned ${String(response.status)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = data["access_token"] as string;
    const expiresIn = (data["expires_in"] as number) ?? 14400;

    tokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_BUFFER_MS) {
      return tokenCache.accessToken;
    }
    return refreshAccessToken();
  }

  function mapError(status: number, body: string): DropboxError {
    if (status === 401) return new DropboxError("auth_expired", "Dropbox token expired or revoked");
    if (status === 429) return new DropboxError("rate_limited", "Dropbox rate limit exceeded");
    if (status >= 500) return new DropboxError("server_error", `Dropbox server error ${String(status)}`);

    // Check for specific error tags in the body
    if (body.includes("insufficient_space")) {
      return new DropboxError("quota_exceeded", "Dropbox storage quota exceeded");
    }

    return new DropboxError("server_error", `Dropbox API error ${String(status)}: ${body.slice(0, 200)}`);
  }

  async function apiCall(
    url: string,
    token: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: Buffer | string | null;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    try {
      return await fetchFn(url, {
        method: options.method ?? "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
        body: options.body as BodyInit | null | undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DropboxError("timeout", "Dropbox API call timed out");
      }
      throw new DropboxError("network_error", `Dropbox network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Execute an API call with automatic token refresh on 401. */
  async function apiCallWithRefresh(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: Buffer | string | null;
      timeoutMs?: number;
    },
  ): Promise<Response> {
    let token = await getAccessToken();
    let response = await apiCall(url, token, options);

    if (response.status === 401) {
      // Token expired — refresh and retry once
      tokenCache = null;
      token = await refreshAccessToken();
      response = await apiCall(url, token, options);
    }

    return response;
  }

  return {
    async uploadFile(uploadParams): Promise<DropboxUploadResult> {
      const apiArg = JSON.stringify({
        path: uploadParams.path,
        mode: "overwrite",
        autorename: false,
        mute: true,
      });

      const response = await apiCallWithRefresh(
        `${CONTENT_BASE}/2/files/upload`,
        {
          headers: {
            "Dropbox-API-Arg": apiArg,
            "Content-Type": "application/octet-stream",
          },
          body: uploadParams.body,
          timeoutMs: CHUNK_TIMEOUT_MS,
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw mapError(response.status, errorBody);
      }

      const data = (await response.json()) as Record<string, unknown>;
      return {
        pathDisplay: (data["path_display"] as string) ?? uploadParams.path,
        size: (data["size"] as number) ?? uploadParams.body.length,
        contentHash: (data["content_hash"] as string) ?? "",
      };
    },

    async uploadFileStream(streamParams): Promise<DropboxUploadResult> {
      if (streamParams.totalBytes <= SIMPLE_UPLOAD_LIMIT) {
        // Collect stream to buffer and use simple upload
        const chunks: Buffer[] = [];
        for await (const chunk of streamParams.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const buffer = Buffer.concat(chunks);
        return this.uploadFile({
          path: streamParams.path,
          body: buffer,
          contentType: "application/octet-stream",
        });
      }

      // Chunked session upload
      let token = await getAccessToken();
      let sessionId: string | undefined;
      let offset = 0;

      for await (const rawChunk of streamParams.body) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);

        if (sessionId === undefined) {
          // Start session with first chunk
          const response = await apiCall(
            `${CONTENT_BASE}/2/files/upload_session/start`,
            token,
            {
              headers: {
                "Dropbox-API-Arg": JSON.stringify({ close: false }),
                "Content-Type": "application/octet-stream",
              },
              body: chunk,
              timeoutMs: CHUNK_TIMEOUT_MS,
            },
          );
          if (response.status === 401) {
            tokenCache = null;
            token = await refreshAccessToken();
            const retryResp = await apiCall(
              `${CONTENT_BASE}/2/files/upload_session/start`,
              token,
              {
                headers: {
                  "Dropbox-API-Arg": JSON.stringify({ close: false }),
                  "Content-Type": "application/octet-stream",
                },
                body: chunk,
                timeoutMs: CHUNK_TIMEOUT_MS,
              },
            );
            if (!retryResp.ok) {
              const errorBody = await retryResp.text();
              throw mapError(retryResp.status, errorBody);
            }
            const data = (await retryResp.json()) as Record<string, unknown>;
            sessionId = data["session_id"] as string;
          } else if (!response.ok) {
            const errorBody = await response.text();
            throw mapError(response.status, errorBody);
          } else {
            const data = (await response.json()) as Record<string, unknown>;
            sessionId = data["session_id"] as string;
          }
          offset = chunk.length;
        } else {
          // Append chunk
          const apiArg = JSON.stringify({
            cursor: { session_id: sessionId, offset },
            close: false,
          });
          const response = await apiCall(
            `${CONTENT_BASE}/2/files/upload_session/append_v2`,
            token,
            {
              headers: {
                "Dropbox-API-Arg": apiArg,
                "Content-Type": "application/octet-stream",
              },
              body: chunk,
              timeoutMs: CHUNK_TIMEOUT_MS,
            },
          );
          if (!response.ok) {
            const errorBody = await response.text();
            throw mapError(response.status, errorBody);
          }
          offset += chunk.length;
        }
      }

      // Finish session
      if (sessionId === undefined) {
        throw new DropboxError("network_error", "No data received from stream");
      }

      const finishArg = JSON.stringify({
        cursor: { session_id: sessionId, offset },
        commit: {
          path: streamParams.path,
          mode: "overwrite",
          autorename: false,
          mute: true,
        },
      });

      const finishResp = await apiCall(
        `${CONTENT_BASE}/2/files/upload_session/finish`,
        token,
        {
          headers: {
            "Dropbox-API-Arg": finishArg,
            "Content-Type": "application/octet-stream",
          },
          body: null,
          timeoutMs: CHUNK_TIMEOUT_MS,
        },
      );

      if (!finishResp.ok) {
        const errorBody = await finishResp.text();
        throw mapError(finishResp.status, errorBody);
      }

      const finishData = (await finishResp.json()) as Record<string, unknown>;
      return {
        pathDisplay: (finishData["path_display"] as string) ?? streamParams.path,
        size: (finishData["size"] as number) ?? offset,
        contentHash: (finishData["content_hash"] as string) ?? "",
      };
    },

    async createFolder(folderPath): Promise<void> {
      const response = await apiCallWithRefresh(
        `${API_BASE}/2/files/create_folder_v2`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: folderPath, autorename: false }),
        },
      );

      if (response.ok) return;

      const errorBody = await response.text();

      // 409 path/conflict/folder is idempotent — ignore
      if (response.status === 409 && errorBody.includes("conflict")) {
        return;
      }

      throw mapError(response.status, errorBody);
    },

    async healthCheck(): Promise<boolean> {
      const testPath = "/healthcheck.txt";
      const testBody = Buffer.from(`bikosoc Dropbox connection verified: ${new Date().toISOString()}\n`);

      await this.uploadFile({ path: testPath, body: testBody, contentType: "text/plain" });

      // Delete the test file
      const response = await apiCallWithRefresh(
        `${API_BASE}/2/files/delete_v2`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: testPath }),
        },
      );

      return response.ok;
    },
  };
}
