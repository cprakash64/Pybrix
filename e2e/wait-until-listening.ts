import { connect } from 'node:net';
import type { ChildProcess } from 'node:child_process';

/**
 * WAITS UNTIL A SPAWNED SERVER IS LISTENING, not until a guess about how long that takes.
 *
 * `release-isolation.spec.ts` used to sleep a fixed 1,200 ms after `spawn`. On a loaded host, or a cold start from a synced folder,
 * a Node process takes longer than that to bind, and the worker's first navigation was refused (`ERR_CONNECTION_REFUSED`, once in
 * 453 packaged tests on a quiet host). A refusal there said nothing about isolation.
 *
 * A TCP connect is the readiness signal: it needs no HTTP client and sends nothing. A server that exits before it listens is
 * reported as exactly that, at once, instead of as a navigation error. Plain Node, no Playwright, so it can be tested directly.
 */
export const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

export async function waitUntilListening(
  child: ChildProcess,
  port: number,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  let exitedWith: number | null | undefined;
  child.once('exit', (code) => {
    exitedWith = code;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedWith !== undefined)
      throw new Error(
        `the server exited (code ${String(exitedWith)}) before it listened on ${String(port)}`,
      );
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: 'localhost' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`the server did not listen on ${String(port)} within ${String(timeoutMs)} ms`);
}
