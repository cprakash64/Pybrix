import { describe, expect, it } from 'vitest';
import {
  createWorkMeter,
  REPAIR_WORK_UNITS,
  RepairWorkPhase,
  WINDING_FACES_PER_UNIT,
  WorkLimitReached,
} from './repair-work-budget';

/**
 * The work meter is the product's only complexity guard. These tests pin what makes it safe to use
 * inside a repair: it is deterministic, charging never throws, and a limit is a typed stop that is
 * only raised where the caller asks.
 */
describe('RepairWorkMeter', () => {
  it('counts integer units from the operations it is charged for', () => {
    const meter = createWorkMeter(RepairWorkPhase.Primary, undefined);
    meter.chargeCandidate();
    meter.chargeCandidate();
    meter.chargeExactTest();
    meter.chargeWindingFaces(WINDING_FACES_PER_UNIT * 2 + 1);
    meter.chargePairs(REPAIR_WORK_UNITS.pairsPerUnit * 5 + 1);
    expect(meter.used()).toBe(
      2 * REPAIR_WORK_UNITS.candidate + REPAIR_WORK_UNITS.exactTest + 3 + 6,
    );
    expect(Number.isInteger(meter.used())).toBe(true);
    expect(meter.counters()).toEqual({
      candidates: 2,
      exactTests: 1,
      windingFaces: WINDING_FACES_PER_UNIT * 2 + 1,
      retryAttempts: 0,
      testedPairs: REPAIR_WORK_UNITS.pairsPerUnit * 5 + 1,
    });
  });

  it('prices an exact test by the pairs it classified, not by how many tests ran', () => {
    // The X11 finding: tests of equal wall cost differ 30x in count, so a flat charge misprices.
    const cheap = createWorkMeter(RepairWorkPhase.Primary, undefined);
    const dear = createWorkMeter(RepairWorkPhase.Primary, undefined);
    cheap.chargeExactTest();
    cheap.chargePairs(100);
    dear.chargeExactTest();
    dear.chargePairs(10_000);
    expect(dear.used()).toBeGreaterThan(cheap.used() * 10);
  });

  it('never refuses an unmetered run', () => {
    const meter = createWorkMeter(RepairWorkPhase.Primary, undefined);
    for (let i = 0; i < 10_000; i += 1) meter.chargeExactTest();
    expect(meter.exhausted()).toBe(false);
    expect(() => {
      meter.check();
    }).not.toThrow();
  });

  it('charging past the limit does not throw; only an explicit check does, with the phase', () => {
    const meter = createWorkMeter(RepairWorkPhase.Residual, 10);
    expect(() => {
      for (let i = 0; i < 5; i += 1) meter.chargeExactTest();
    }).not.toThrow();
    expect(meter.exhausted()).toBe(true);
    let caught: unknown;
    try {
      meter.check();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkLimitReached);
    expect((caught as WorkLimitReached).phase).toBe(RepairWorkPhase.Residual);
  });

  it('stops exactly at the limit: one unit under is not exhausted', () => {
    const meter = createWorkMeter(RepairWorkPhase.Primary, REPAIR_WORK_UNITS.exactTest);
    for (let i = 0; i < REPAIR_WORK_UNITS.exactTest - 1; i += 1) meter.chargeCandidate();
    expect(meter.exhausted()).toBe(false);
    meter.chargeCandidate();
    expect(meter.exhausted()).toBe(true);
  });

  it('notes retries without charging for them', () => {
    const meter = createWorkMeter(RepairWorkPhase.Primary, 100);
    meter.noteRetry();
    meter.noteRetry();
    expect(meter.used()).toBe(0);
    expect(meter.counters().retryAttempts).toBe(2);
  });

  it('is a pure function of what it was charged: two meters agree, whatever the order', () => {
    const a = createWorkMeter(RepairWorkPhase.Primary, undefined);
    const b = createWorkMeter(RepairWorkPhase.Primary, undefined);
    a.chargeCandidate();
    a.chargeExactTest();
    a.chargeWindingFaces(100);
    b.chargeWindingFaces(100);
    b.chargeExactTest();
    b.chargeCandidate();
    expect(a.used()).toBe(b.used());
  });

  it('treats a negative or fractional face count as the whole faces that were visited', () => {
    const meter = createWorkMeter(RepairWorkPhase.Primary, undefined);
    meter.chargeWindingFaces(-5);
    meter.chargeWindingFaces(10.9);
    expect(meter.counters().windingFaces).toBe(10);
  });
});
