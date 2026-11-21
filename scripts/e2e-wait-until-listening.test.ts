import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitUntilListening } from '../e2e/wait-until-listening';

/*
 * The packaged suite's `release-isolation` spec started a helper server and slept a fixed 1.2 s before the first navigation. A server
 * that binds later than that was refused. These tests start real child servers that bind LATE, EARLY or NEVER, and hold the
 * readiness wait to what it says: wait for the bind, report an early exit as an early exit, give up with the limit it gave up at.
 */
const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill();
});

/** A Node process that binds `port` after `delayMs`, or exits with `exitCode` after it when `bind` is false. */
function server(port: number, delayMs: number, bind = true, exitCode = 3): ChildProcess {
  const code = bind
    ? `setTimeout(() => require('node:net').createServer().listen(${String(port)}, 'localhost'), ${String(delayMs)});`
    : `setTimeout(() => process.exit(${String(exitCode)}), ${String(delayMs)});`;
  const child = spawn('node', ['-e', code], { stdio: 'ignore' });
  started.push(child);
  return child;
}
/** A port the kernel hands out, released again. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, 'localhost', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}
const refusedNow = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
  });

describe('waiting for a spawned server to listen', () => {
  it('REPRODUCES THE RACE: a server that binds after 1.2 s is refused by a fixed 1.2 s wait', async () => {
    const port = await freePort();
    server(port, 2_500);
    await new Promise((resolve) => setTimeout(resolve, 1_200)); // the old behaviour
    expect(await refusedNow(port)).toBe(true);
  });

  it('waits for that same slow server and returns only once it is listening', async () => {
    const port = await freePort();
    const child = server(port, 2_500);
    await waitUntilListening(child, port);
    expect(await refusedNow(port)).toBe(false);
  }, 20_000);

  it('returns promptly for a server that binds at once', async () => {
    const port = await freePort();
    const child = server(port, 0);
    await waitUntilListening(child, port);
    expect(await refusedNow(port)).toBe(false);
  }, 20_000);

  it('reports a server that exits before it listens as exactly that, with its exit code', async () => {
    const port = await freePort();
    const child = server(port, 200, false, 7);
    await expect(waitUntilListening(child, port)).rejects.toThrow(
      /exited \(code 7\) before it listened/,
    );
  }, 20_000);

  it('gives up at the limit it was given, and names the port and the limit', async () => {
    const port = await freePort();
    const child = server(port, 60_000);
    await expect(waitUntilListening(child, port, 600)).rejects.toThrow(
      new RegExp(`did not listen on ${String(port)} within 600 ms`),
    );
  }, 20_000);
});
