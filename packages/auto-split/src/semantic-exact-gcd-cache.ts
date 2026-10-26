import type { Checkpoint } from './checkpoint';

const CAPACITY = 32768;
const WAYS = 4;
const LIMIT = (1n << 512n) - 1n;
const NEGATIVE_LIMIT = -LIMIT;

/** Bounded, invocation-local storage of completed exact primitive results.
 * Hashes choose a set only; ordered signed full-key equality authorizes reuse.
 * Oversized operands always fall back to the caller's original primitive.
 */
export class InvocationExactGcdCache {
  private readonly checkpoint: Checkpoint;
  private readonly capacity: number;
  private readonly keys: (string | undefined)[];
  private readonly values: (bigint | undefined)[];
  private readonly iterations: Uint32Array;
  private readonly next: Uint8Array;
  private calls = 0;
  private hits = 0;
  private misses = 0;
  private oversized = 0;
  private evictions = 0;
  private collisions = 0;
  private entries = 0;
  private avoided = 0;
  private completedIterations = 0;

  constructor(checkpoint: Checkpoint, capacity = CAPACITY) {
    this.checkpoint = checkpoint;
    this.capacity = capacity;
    if (
      !Number.isInteger(capacity) ||
      capacity < WAYS ||
      capacity > CAPACITY ||
      (capacity & (capacity - 1)) !== 0
    )
      throw Error('Unsupported exact GCD cache capacity');
    this.keys = new Array<string | undefined>(capacity);
    this.values = new Array<bigint | undefined>(capacity);
    this.iterations = new Uint32Array(capacity);
    this.next = new Uint8Array(capacity / WAYS);
  }

  private key(a: bigint, b: bigint): string | undefined {
    if (a > LIMIT || a < NEGATIVE_LIMIT || b > LIMIT || b < NEGATIVE_LIMIT) return undefined;
    return `${a.toString(16)}:${b.toString(16)}`;
  }

  private base(key: string): number {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return ((hash >>> 0) & (this.capacity / WAYS - 1)) * WAYS;
  }

  get(a: bigint, b: bigint): bigint | undefined {
    if ((this.calls++ & 255) === 0) this.checkpoint();
    const key = this.key(a, b);
    if (key === undefined) {
      this.misses++;
      this.oversized++;
      return undefined;
    }
    const base = this.base(key);
    let full = true;
    for (let i = base; i < base + WAYS; i++) {
      if (this.keys[i] === key) {
        this.hits++;
        this.avoided += this.iterations[i] ?? 0;
        return this.values[i];
      }
      if (this.keys[i] === undefined) full = false;
    }
    this.misses++;
    if (full) this.collisions++;
    return undefined;
  }

  /** Called only after the original primitive returns normally. */
  store(a: bigint, b: bigint, value: bigint, iterations: number): void {
    this.completedIterations += iterations;
    const key = this.key(a, b);
    if (key === undefined) return;
    const base = this.base(key);
    let slot = -1;
    for (let i = base; i < base + WAYS; i++) {
      if (this.keys[i] === key) {
        slot = i;
        break;
      }
      if (slot === -1 && this.keys[i] === undefined) slot = i;
    }
    if (slot === -1) {
      const set = base / WAYS;
      slot = base + (this.next[set] ?? 0);
      this.next[set] = ((this.next[set] ?? 0) + 1) % WAYS;
      this.evictions++;
    } else if (this.keys[slot] === undefined) this.entries++;
    this.keys[slot] = key;
    this.values[slot] = value;
    this.iterations[slot] = iterations;
  }

  get estimatedPeakBytes(): number {
    return this.capacity * 20 + this.next.byteLength + 4096 + this.entries * 1004;
  }

  snapshot(): {
    capacity: number;
    ways: number;
    maxRetainedOperandBits: number;
    calls: number;
    cacheHits: number;
    cacheMisses: number;
    actualGcdExecutions: number;
    completedGcdIterations: number;
    avoidedHistoricalIterations: number;
    evictions: number;
    collisionMisses: number;
    oversizedMisses: number;
    peakEntries: number;
    estimatedPeakBytes: number;
    estimatedMaximumBytes: number;
    fixedReferenceArraySlots: number;
    fixedTypedArrayBytes: number;
  } {
    return {
      capacity: this.capacity,
      ways: WAYS,
      maxRetainedOperandBits: 512,
      calls: this.calls,
      cacheHits: this.hits,
      cacheMisses: this.misses,
      actualGcdExecutions: this.misses,
      completedGcdIterations: this.completedIterations,
      avoidedHistoricalIterations: this.avoided,
      evictions: this.evictions,
      collisionMisses: this.collisions,
      oversizedMisses: this.oversized,
      peakEntries: this.entries,
      estimatedPeakBytes: this.estimatedPeakBytes,
      estimatedMaximumBytes: this.capacity * 1024 + this.next.byteLength + 4096,
      fixedReferenceArraySlots: this.keys.length + this.values.length,
      fixedTypedArrayBytes: this.iterations.byteLength + this.next.byteLength,
    };
  }
}
