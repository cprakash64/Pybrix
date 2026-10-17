import { it, expect } from 'vitest';
import {
  qualificationResponseFailure as failure,
  runQualificationCampaign as run,
  type QualificationResponse,
} from './semantic-qualification-guard';
const good = (): QualificationResponse => ({
  serviceValidation: 'PASS',
  score: {
    status: 'SCORED',
    qualificationEligible: true,
    metrics: {},
    operations: [{ attributionStatus: 'EXACT' }],
  },
  fixtureValid: true,
  contextValid: true,
  privacyValid: true,
  integrityValid: true,
});
it.each(['CURRENT_UNSUPPORTED', 'LEGACY_SCORED'] as const)(
  'late-discovery %s stops after A before B and truck, durable exact ledger',
  async (shape) => {
    await Promise.resolve();
    const called: string[] = [],
      saved: unknown[] = [],
      stops: unknown[] = [];
    const bad = good();
    bad.score = {
      status: shape === 'LEGACY_SCORED' ? 'SCORED' : 'ATTRIBUTION_UNSUPPORTED',
      qualificationEligible: shape === 'LEGACY_SCORED',
      metrics: shape === 'LEGACY_SCORED' ? {} : null,
      operations: [{ attributionStatus: 'UNSUPPORTED' }],
    };
    const r = await run({
      primary: ['A', 'B'],
      truck: 'TRUCK',
      completed: [],
      priorAttempts: 0,
      dispatch: async (id) => {
        await Promise.resolve();
        called.push(id);
        return bad;
      },
      persistCompleted: async (r) => {
        await Promise.resolve();
        saved.push(r);
      },
      persistStop: async (r) => {
        await Promise.resolve();
        stops.push(r);
      },
    });
    expect(called).toEqual(['A']);
    expect(saved).toHaveLength(1);
    expect(stops).toEqual([r]);
    expect(r).toEqual({
      status: 'INFRASTRUCTURE_STOP',
      firstAffectedCase: 'A',
      reason:
        shape === 'LEGACY_SCORED'
          ? 'UNSUPPORTED_READY_ATTRIBUTION'
          : 'SCORE_ATTRIBUTION_UNSUPPORTED',
      attemptsAlreadyMade: 1,
      undispatchedCases: ['B', 'TRUCK'],
      truckDispatched: false,
    });
  },
);
it('resume refuses any prior unsupported completion and unresolved prior attempt', async () => {
  await Promise.resolve();
  let called = 0;
  const bad = good();
  bad.score.operations = [{ attributionStatus: 'UNSUPPORTED' }];
  for (const completed of [[{ id: 'A', response: bad }], []]) {
    const r = await run({
      primary: ['A', 'B'],
      truck: 'T',
      completed,
      priorAttempts: 1,
      dispatch: async () => {
        await Promise.resolve();
        called++;
        return good();
      },
      persistCompleted: async () => {
        await Promise.resolve();
      },
      persistStop: async () => {
        await Promise.resolve();
      },
    });
    expect(r.status).toBe('INFRASTRUCTURE_STOP');
  }
  expect(called).toBe(0);
});
it('all guard predicates fail closed independently; fractional supported succeeds', () => {
  expect(failure(good())).toBeNull();
  for (const field of ['fixtureValid', 'contextValid', 'privacyValid', 'integrityValid'] as const) {
    const r = good();
    r[field] = false;
    expect(failure(r)).not.toBeNull();
  }
  for (const state of ['INVALID', 'UNSUPPORTED', undefined]) {
    const r = good();
    r.score.operations = [state ? { attributionStatus: state } : {}];
    expect(failure(r)).not.toBeNull();
  }
  const r = good();
  r.score.operations = [{ attributionStatus: 'FRACTIONAL_CLIPPED' }];
  expect(failure(r)).toBeNull();
  r.score.qualificationEligible = false;
  expect(failure(r)).not.toBeNull();
});
it('eligible completion persists each result before next dispatch', async () => {
  await Promise.resolve();
  const events: string[] = [];
  const r = await run({
    primary: ['A', 'B'],
    truck: 'T',
    completed: [],
    priorAttempts: 0,
    dispatch: async (id) => {
      await Promise.resolve();
      events.push('dispatch:' + id);
      return good();
    },
    persistCompleted: async (r) => {
      await Promise.resolve();
      events.push('persist:' + r.id);
    },
    persistStop: async () => {
      await Promise.resolve();
      throw Error('unexpected');
    },
  });
  expect(r).toEqual({ status: 'COMPLETE', attemptsAlreadyMade: 3 });
  expect(events).toEqual([
    'dispatch:A',
    'persist:A',
    'dispatch:B',
    'persist:B',
    'dispatch:T',
    'persist:T',
  ]);
});
it('service, status, null metrics and a later invalid completed response all stop', async () => {
  for (const mutate of [
    (r: QualificationResponse): void => {
      r.serviceValidation = 'FAIL';
    },
    (r: QualificationResponse): void => {
      r.score.status = 'ATTRIBUTION_INVALID';
    },
    (r: QualificationResponse): void => {
      r.score.metrics = null;
    },
  ]) {
    const r = good();
    mutate(r);
    expect(failure(r)).not.toBeNull();
  }
  const bad = good();
  bad.score.qualificationEligible = false;
  let dispatched = 0;
  const r = await run({
    primary: ['A', 'B', 'C'],
    truck: 'T',
    completed: [
      { id: 'A', response: good() },
      { id: 'B', response: bad },
    ],
    priorAttempts: 2,
    dispatch: () => {
      dispatched++;
      return Promise.resolve(good());
    },
    persistCompleted: () => Promise.resolve(),
    persistStop: () => Promise.resolve(),
  });
  expect(r).toMatchObject({
    status: 'INFRASTRUCTURE_STOP',
    firstAffectedCase: 'B',
    attemptsAlreadyMade: 2,
    truckDispatched: false,
  });
  expect(dispatched).toBe(0);
});
