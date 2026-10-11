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
      /**
       * `rate`: this client's own allowance. `capacity`: the SERVICE-WIDE ceiling (hourly or daily), which
       * no choice of client identity changes. `busy`: too many analyses running at this moment.
       */
      readonly reason: 'rate' | 'capacity' | 'busy';
      readonly retryAfterSeconds: number;
    };

/**
 * A SLIDING WINDOW OF AT MOST `max` EVENTS in a fixed-size ring: its memory is `max` numbers for the life
 * of the process, whatever arrives, and nothing a request carries is stored in it. Timestamps are those of
 * the limiter's clock, which the service makes monotonic.
 */
export class WindowCounter {
  private readonly stamps: Float64Array;
  private head = 0;
  private size = 0;
  private readonly max: number;
  private readonly windowMs: number;

  public constructor(max: number, windowMs: number) {
    if (!Number.isInteger(max) || max < 1)
      throw new RangeError('A window needs at least one slot.');
    if (!Number.isFinite(windowMs) || windowMs <= 0)
      throw new RangeError('A window needs a duration.');
    this.max = max;
    this.windowMs = windowMs;
    this.stamps = new Float64Array(max);
  }

  /** Forgets events that have left the window. */
  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.size > 0 && (this.stamps[this.head] ?? 0) <= cutoff) {
      this.head = (this.head + 1) % this.max;
      this.size -= 1;
    }
  }

  public isFull(at: number): boolean {
    this.prune(at);
    return this.size >= this.max;
  }

  /** Records one event. The caller has checked `isFull`; recording into a full window is refused. */
  public record(at: number): void {
    this.prune(at);
    if (this.size >= this.max) throw new RangeError('The window is full.');
    this.stamps[(this.head + this.size) % this.max] = at;
    this.size += 1;
  }

  /** Whole seconds until the oldest event leaves the window (at least one). */
  public secondsUntilRoom(at: number): number {
    this.prune(at);
    if (this.size < this.max) return 0;
    return Math.max(1, Math.ceil(((this.stamps[this.head] ?? at) + this.windowMs - at) / 1000));
  }

  public get count(): number {
    return this.size;
  }
}

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
  /**
   * THE SERVICE-WIDE CEILINGS. They are process-local (one service process serves Auto Split), they reset
   * when the process restarts, and they take no input from the client: not its address, not a header.
   */
  private readonly hourly: WindowCounter;
  private readonly daily: WindowCounter;

  public constructor(config: LimitConfig, now: () => number = () => performance.now()) {
    this.config = config;
    this.now = now;
    this.hourly = new WindowCounter(config.globalRateMax, config.globalRateWindowMs);
    this.daily = new WindowCounter(config.globalDailyMax, config.globalDailyWindowMs);
  }

  /** Spends and its counts, for tests and the health route's `inFlight` only; never sent to a caller. */
  public get globalUsage(): { readonly hourly: number; readonly daily: number } {
    return { hourly: this.hourly.count, daily: this.daily.count };
  }

  /** True when either service-wide window has no room. Reads, never records. */
  private atCapacity(at: number): boolean {
    return this.hourly.isFull(at) || this.daily.isFull(at);
  }

  private capacityRetry(at: number): number {
    return Math.max(this.hourly.secondsUntilRoom(at), this.daily.secondsUntilRoom(at), 1);
  }

  /**
   * One MORE provider attempt for an analysis that is already running (a retry of a transient failure).
   * It spends from the same service-wide windows, so a retry cannot be a way past them: when there is
   * no room the retry is not made and the first failure stands.
   */
  public tryConsumeRetry(): boolean {
    const at = this.now();
    if (this.atCapacity(at)) return false;
    this.hourly.record(at);
    this.daily.record(at);
    return true;
  }

  /** The number of analyses running now, across every client. */
  public get inFlight(): number {
    return this.running;
  }

  public get trackedClients(): number {
    return this.clients.size;
  }

  /** True when this client has used its allowance, so the body need not even be read. */
  public wouldRefuse(
    client: string,
  ): { reason: 'rate' | 'capacity'; retryAfterSeconds: number } | undefined {
    const state = this.clients.get(client);
    if (state !== undefined) {
      this.prune(state);
      if (state.started.length >= this.config.perClientMax)
        return { reason: 'rate', retryAfterSeconds: this.retryAfter(state) };
    }
    // A service already at capacity is told so before its body is read: shedding costs nothing.
    const at = this.now();
    if (this.atCapacity(at))
      return { reason: 'capacity', retryAfterSeconds: this.capacityRetry(at) };
    return undefined;
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
    // The service-wide ceilings come BEFORE concurrency: a request that would be refused for capacity
    // must be refused for capacity, and must not spend anything.
    if (this.atCapacity(at))
      return { allowed: false, reason: 'capacity', retryAfterSeconds: this.capacityRetry(at) };
    if (
      state.running >= this.config.perClientConcurrent ||
      this.running >= this.config.globalConcurrent
    )
      return { allowed: false, reason: 'busy', retryAfterSeconds: 5 };
    // ADMITTED: this is the moment a slot is spent, in both service-wide windows and the client's own.
    // Whatever happens next (an error, a cancel, a malformed answer) does not give it back.
    this.hourly.record(at);
    this.daily.record(at);
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
