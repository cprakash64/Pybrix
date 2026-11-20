import { describe, expect, it } from 'vitest';
import type { JointDescriptor } from '@cadfixer/geometry-runtime';
import {
  CONNECTOR_EDIT_COPY,
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
// The editor changes a size, swaps the male side and removes connectors. A sentence that says it moves one or adds one describes a control
// that does not exist.
const PROMISES_MORE = /\b(?:move|moves|moving|drag|add|adds|adding|reposition|place)\b/i;

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
  it('promises no more than the editor does', () => {
    for (const text of everything) expect(text, text).not.toMatch(PROMISES_MORE);
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
