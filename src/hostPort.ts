/**
 * Host-side port for docker-compose publish (container keeps 8080).
 */

import { createServer } from 'node:net';

export const DEFAULT_GOLDEN_HOST_PORT = 8080;

/** Valid TCP port for the host mapping; falls back to DEFAULT_GOLDEN_HOST_PORT. */
export function normalizeGoldenHostPort(value: unknown): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return DEFAULT_GOLDEN_HOST_PORT;
  }
  return n;
}

/**
 * True if nothing is listening on 127.0.0.1:port (we can bind briefly).
 * On permission errors, returns true so export is not blocked.
 */
export function isLocalHostPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      resolve(true);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      resolve(true);
    }
  });
}
