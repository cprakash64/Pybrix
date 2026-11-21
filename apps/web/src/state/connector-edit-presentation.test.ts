import { describe, expect, it } from 'vitest';
import type { JointDescriptor } from '@cadfixer/geometry-runtime';
import {
  CONNECTOR_EDIT_COPY,
  connectorLimitSentence,
  describeChange,
  describeEditRefusal,
  disclosureFor,
  JOINT_LIST_UNAVAILABLE,
  jointSummary,
  RETIRE_DISCLOSURE,
  RETIRE_DISCLOSURE_PLAIN_CUT,
  retirementSentence,
} from './connector-edit-presentation';

/*
 * Stage EC-4. Wording is a correctness concern here: a sentence that says a connector holds, fits or is strong claims something Pybrix
 * never examined, and a sentence that offers an edit describes a control that does not exist. Every string this file can emit is held to
 * both.
 */
const REASONS = ['GEOMETRY_CHANGED', 'PART_REMOVED', 'PLACEMENT_CHANGED', 'UNIT_CHANGED'] as const;
const BANNED =
  /printable|watertight|\bfits?\b|\bstrong|secure|will hold|holds? up|tolerance verified|\bhole\b|defect|damage|broken|error[- ]free/i;
// The editor lets a person place connectors, and the worker alone judges a place. A sentence that calls a place good, safe or recommended
// before the check says what only the check knows, and one that says Pybrix chose a place describes a control that does not exist.
const JUDGES_A_PLACE =
  /\b(?:safe|safely|good position|best|optimal|recommended|automatically|ideal|suitable)\b/i;

function descriptor(overrides: Partial<JointDescriptor> = {}): JointDescriptor {
  return {
    jointId: 'doc/joint/1',
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 1,
    retainedBytes: 0,
    ...overrides,
  };
}

describe('connector wording', () => {
  const everything = [
    RETIRE_DISCLOSURE,
    RETIRE_DISCLOSURE_PLAIN_CUT,
    JOINT_LIST_UNAVAILABLE,
    ...REASONS.map(retirementSentence),
    ...REASONS.map((reason) => jointSummary(descriptor({ status: 'RETIRED', reason }))),
    jointSummary(descriptor({ status: 'RETIRED' })),
    jointSummary(descriptor({ pinCount: 0 })),
    jointSummary(descriptor({ pinCount: 1 })),
    jointSummary(descriptor({ pinCount: 3 })),
    ...Object.values(CONNECTOR_EDIT_COPY),
    connectorLimitSentence(4),
    ...[
      'JOINT_SPEC_STALE',
      'JOINT_RETIRED',
      'JOINT_UNKNOWN',
      'JOINT_EDIT_NO_CHANGE',
      'JOINT_EDIT_UNKNOWN_PIN',
    ].map((code) => describeEditRefusal(code, 'worker')),
  ];
  it('emits no claim about use', () => {
    for (const text of everything) expect(text, text).not.toMatch(BANNED);
  });
  it('calls no position good before the check has said so', () => {
    for (const text of everything) expect(text, text).not.toMatch(JUDGES_A_PLACE);
  });
  it('has a different sentence for every reason a record can end', () => {
    expect(new Set(REASONS.map(retirementSentence)).size).toBe(REASONS.length);
  });
  it('says Undo brings the record back, in both disclosures', () => {
    expect(RETIRE_DISCLOSURE).toMatch(/Undo brings the record back/);
    expect(RETIRE_DISCLOSURE_PLAIN_CUT).toMatch(/Undo brings the record back/);
  });
});

describe('summaries', () => {
  it('counts the connectors of an attached cut and says a plain cut has none', () => {
    expect(jointSummary(descriptor({ pinCount: 1 }))).toBe('1 connector recorded.');
    expect(jointSummary(descriptor({ pinCount: 3 }))).toBe('3 connectors recorded.');
    expect(jointSummary(descriptor({ pinCount: 0 }))).toBe('A cut with no connectors.');
  });
  it('gives the reason when a record has ended', () => {
    expect(jointSummary(descriptor({ status: 'RETIRED', reason: 'PART_REMOVED' }))).toBe(
      `These connectors can no longer be changed here. ${retirementSentence('PART_REMOVED')}`,
    );
  });
});

describe('a refusal of an edit', () => {
  it("says the joint's own refusals in our words and passes the engine's through", () => {
    expect(describeEditRefusal('JOINT_SPEC_STALE', 'x')).toMatch(/changed since/);
    expect(describeEditRefusal('JOINT_EDIT_NO_CHANGE', 'x')).toBe(CONNECTOR_EDIT_COPY.unchanged);
    expect(
      describeEditRefusal('CONNECTOR_SOCKET_BREAKTHROUGH', 'The socket would break through.'),
    ).toBe('The socket would break through.');
    expect(describeEditRefusal(undefined, 'whatever it said')).toBe('whatever it said');
  });
  it('never names a code in a sentence a person reads', () => {
    for (const code of [
      'JOINT_SPEC_STALE',
      'JOINT_RETIRED',
      'JOINT_UNKNOWN',
      'JOINT_EDIT_NO_CHANGE',
    ])
      expect(describeEditRefusal(code, 'x')).not.toMatch(/JOINT_|CONNECTOR_/);
  });
});

describe('disclosureFor', () => {
  const withPins = descriptor({ pinCount: 2 });
  const plain = descriptor({ jointId: 'doc/joint/2', aPartId: 'c', bPartId: 'd', pinCount: 0 });
  const ended = descriptor({
    jointId: 'doc/joint/3',
    aPartId: 'e',
    bPartId: 'f',
    status: 'RETIRED',
    reason: 'GEOMETRY_CHANGED',
  });
  it('speaks for a piece on either side of a cut that has connectors', () => {
    expect(disclosureFor([withPins, plain, ended], 'a')).toBe(RETIRE_DISCLOSURE);
    expect(disclosureFor([withPins, plain, ended], 'b')).toBe(RETIRE_DISCLOSURE);
  });
  it('speaks, more gently, for a piece of a plain recorded cut', () => {
    expect(disclosureFor([withPins, plain, ended], 'c')).toBe(RETIRE_DISCLOSURE_PLAIN_CUT);
  });
  it('is silent for a piece nothing was recorded for, and for a record that has already ended', () => {
    expect(disclosureFor([withPins, plain, ended], 'z')).toBeUndefined();
    expect(disclosureFor([withPins, plain, ended], 'e')).toBeUndefined();
    expect(disclosureFor([], 'a')).toBeUndefined();
  });
});

describe('what a change says it does', () => {
  const pin = (
    pinId: string,
    u: number,
    v: number,
    diameterMm = 4,
  ): NonNullable<JointDescriptor['connector']>['pins'][number] => ({
    pinId,
    u,
    v,
    center: [0, u, v],
    diameterMm,
    depthMm: 6,
    clearanceMm: 0.2,
  });
  const jointWith = (
    pins: readonly NonNullable<JointDescriptor['connector']>['pins'][number][],
    maleSide: 'A' | 'B' = 'A',
  ): JointDescriptor =>
    descriptor({
      pinCount: pins.length,
      connector: { maleSide, axis: [1, 0, 0], mmPerSceneUnit: 1, pins },
    });
  const side = (s: 'A' | 'B'): string => `Piece ${s}`;

  it('names a connector added, taken out and moved, by its name and not by its place in a list', () => {
    const before = jointWith([pin('pin-1', 0, 0), pin('pin-2', 5, 5)]);
    expect(
      describeChange(before, jointWith([pin('pin-1', 0, 0), pin('pin-2', 6, 5)]), side),
    ).toMatch(/^1 connector moved\./);
    expect(describeChange(before, jointWith([pin('pin-2', 5, 5)]), side)).toMatch(
      /^1 connector taken out\./,
    );
    expect(
      describeChange(
        before,
        jointWith([pin('pin-1', 0, 0), pin('pin-2', 5, 5), pin('pin-3', 1, 1)]),
        side,
      ),
    ).toMatch(/^1 connector added\./);
    expect(
      describeChange(
        before,
        jointWith([pin('pin-2', 1, 1), pin('pin-3', 2, 2), pin('pin-4', 3, 3)]),
        side,
      ),
    ).toMatch(/^2 connectors added; 1 connector taken out; 1 connector moved\./);
  });

  it('says a first connector was added to a cut with none, and a size and a side beside a move', () => {
    const plain = descriptor({ pinCount: 0 });
    expect(describeChange(plain, jointWith([pin('pin-1', 0, 0)]), side)).toMatch(
      /^1 connector added\./,
    );
    expect(
      describeChange(
        jointWith([pin('pin-1', 0, 0)]),
        jointWith([pin('pin-1', 1, 0, 3)], 'B'),
        side,
      ),
    ).toMatch(/^1 connector moved; pin diameter 4 to 3 mm; the pin moves to Piece B\./);
  });

  it('says the connectors come off when none are left', () => {
    expect(describeChange(jointWith([pin('pin-1', 0, 0)]), descriptor({ pinCount: 0 }), side)).toBe(
      CONNECTOR_EDIT_COPY.removeReady,
    );
  });
});
