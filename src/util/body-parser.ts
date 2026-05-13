/**
 * util/body-parser — JSON body parser for Node.js IncomingMessage.
 * Collects request body chunks and parses as JSON.
 */
import type { IncomingMessage } from 'node:http';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export async function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw.trim()) {
          reject(new Error('Empty request body'));
          return;
        }
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`));
      }
    });

    req.on('error', reject);
  });
}
