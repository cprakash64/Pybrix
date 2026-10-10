import type { LimitConfig } from './config';

/**
 * THE SPEND GUARD: how often and how many at once, per client and overall. In memory, bounded, and
 * deliberately simple: one anonymous browser must not be able to burn unlimited provider spend, and
 * the limiter itself must not be a way to exhaust the service's memory.
 */
export type Admission =
  | { readonly allowed: true; readonly release: () => void }
  | {
      readonly allowed: false;
      readonly reason: 'rate' | 'busy';
      readonly retryAfterSeconds: number;
    };

interface ClientState {
  /** Start times inside the window, oldest first. */
  started: number[];
  running: number;
}

export class AnalysisLimiter {
  private readonly clients = new Map<string, ClientState>();
  private running = 0;
  private readonly config: LimitConfig;
  private readonly now: () => number;

  public constructor(config: LimitConfig, now: () => number = () => Date.now()) {
    this.config = config;
    this.now = now;
  }

  /** The number of analyses running now, across every client. */
  public get inFlight(): number {
    return this.running;
  }

  public get trackedClients(): number {
    return this.clients.size;
  }

  /** True when this client has used its allowance, so the body need not even be read. */
  public wouldRefuse(client: string): { reason: 'rate'; retryAfterSeconds: number } | undefined {
    const state = this.clients.get(client);
    if (state === undefined) return undefined;
    this.prune(state);
    if (state.started.length < this.config.perClientMax) return undefined;
    return { reason: 'rate', retryAfterSeconds: this.retryAfter(state) };
  }

  public admit(client: string): Admission {
    const at = this.now();
    let state = this.clients.get(client);
    if (state === undefined) {
      state = { started: [], running: 0 };
      this.clients.set(client, state);
      this.evict();
    } else {
      // Refresh recency: a client in use is not the one to forget.
      this.clients.delete(client);
      this.clients.set(client, state);
    }
    this.prune(state);
    if (state.started.length >= this.config.perClientMax)
      return { allowed: false, reason: 'rate', retryAfterSeconds: this.retryAfter(state) };
    if (
      state.running >= this.config.perClientConcurrent ||
      this.running >= this.config.globalConcurrent
    )
      return { allowed: false, reason: 'busy', retryAfterSeconds: 5 };
    state.started.push(at);
    state.running += 1;
    this.running += 1;
    let released = false;
    const held = state;
    return {
      allowed: true,
      release: (): void => {
        if (released) return;
        released = true;
        held.running -= 1;
        this.running -= 1;
      },
    };
  }

  private prune(state: ClientState): void {
    const cutoff = this.now() - this.config.windowMs;
    while (state.started.length > 0 && (state.started[0] ?? 0) <= cutoff) state.started.shift();
  }

  private retryAfter(state: ClientState): number {
    const oldest = state.started[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.config.windowMs - this.now()) / 1000));
  }

  private evict(): void {
    while (this.clients.size > this.config.maxTrackedClients) {
      const oldest = this.clients.keys().next();
      if (oldest.done) return;
      const state = this.clients.get(oldest.value);
      // A client with work running is never forgotten: its release must find its own state.
      if (state !== undefined && state.running > 0) {
        this.clients.delete(oldest.value);
        this.clients.set(oldest.value, state);
        return;
      }
      this.clients.delete(oldest.value);
    }
  }
}
