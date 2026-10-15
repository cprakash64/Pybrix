import { describe, it, expect } from 'vitest';
import { compileSemanticConceptMatcher } from './semantic-concepts';
const definitions = [
  { concept: 'plate', phrases: ['upper plate', 'top plate'] },
  { concept: 'base', phrases: ['lower plate', 'base'] },
  { concept: 'post', phrases: ['post', 'support post', 'l shaped member', 'ring support'] },
  { concept: 'ring', phrases: ['ring'] },
  { concept: 'shaft', phrases: ['shaft', 'cylindrical bar'] },
  { concept: 'wheel', phrases: ['wheel', 'wheel assembly'] },
];
const match = compileSemanticConceptMatcher(definitions);
describe('prospective phrase-level semantic matcher', () => {
  for (const [label, concept] of [
    ['upper rectangular plate', 'plate'],
    ['lower rectangular plate', 'base'],
    ['central L-shaped member', 'post'],
    ['upright ring', 'ring'],
    ['horizontal cylindrical bar', 'shaft'],
    ['upright post', 'post'],
    ['support post', 'post'],
    ['ring support', 'post'],
    ['support ring', 'ring'],
    ['Wheels', 'wheel'],
    ['wheel assembly', 'wheel'],
  ] as const)
    it(`${label} resolves prospectively`, () => {
      expect(match(label).concept).toBe(concept);
    });
  it('does not invent a noun role from an isolated adjective', () => {
    expect(match('upright').concept).toBeNull();
  });
  it('refuses two different named roles instead of a greedy first match', () => {
    expect(match('post and ring').reason).toBe('AMBIGUOUS');
  });
  it('keeps unrecognized labels unresolved', () => {
    expect(match('mysterious appliance').reason).toBe('NONE');
  });
  it('rejects ambiguous frozen definitions before any response', () => {
    expect(() =>
      compileSemanticConceptMatcher([
        { concept: 'a', phrases: ['ring'] },
        { concept: 'b', phrases: ['rings'] },
      ]),
    ).toThrow();
  });
  it('bounds both definitions and incoming labels', () => {
    expect(() =>
      compileSemanticConceptMatcher(
        Array.from({ length: 25 }, (_, i) => ({ concept: String(i), phrases: ['x'] })),
      ),
    ).toThrow();
    expect(match('x'.repeat(129)).concept).toBeNull();
  });
  it('keeps physical-role and explicit assembly phrases distinct', () => {
    const scoped = compileSemanticConceptMatcher([
      { concept: 'housing', phrases: ['housing'] },
      { concept: 'whole', phrases: ['housing assembly'] },
    ]);
    expect(scoped('housing assembly').concept).toBe('whole');
    expect(scoped('housing').concept).toBe('housing');
  });
  it('only a prospectively declared composite can combine named physical roles', () => {
    const scoped = compileSemanticConceptMatcher([
      { concept: 'seat', phrases: ['seat'] },
      { concept: 'back', phrases: ['back'] },
      { concept: 'whole', phrases: ['seat and back assembly'] },
    ]);
    expect(scoped('chair seat and back assembly').concept).toBe('whole');
    expect(scoped('seat and back').reason).toBe('AMBIGUOUS');
  });
  it('normalizes bounded common noun plurals without dropping the head noun', () => {
    const m = compileSemanticConceptMatcher([
      { concept: 'box', phrases: ['box'] },
      { concept: 'body', phrases: ['body'] },
      { concept: 'foot', phrases: ['foot'] },
    ]);
    expect(m('Boxes').concept).toBe('box');
    expect(m('Bodies').concept).toBe('body');
    expect(m('Feet').concept).toBe('foot');
  });
});

describe('prospective physical-role head phrases for plane ownership evaluation', () => {
  const role = compileSemanticConceptMatcher([
    { concept: 'base', phrases: ['base', 'base platform'] },
    { concept: 'platform', phrases: ['platform'] },
    { concept: 'body', phrases: ['body', 'body block'] },
    { concept: 'top', phrases: ['top block', 'upper part'] },
    { concept: 'bottom', phrases: ['lower part'] },
    { concept: 'member', phrases: ['member', 'central member'] },
    { concept: 'ring', phrases: ['ring'] },
  ]);
  for (const [label, concept] of [
    ['rectangular base platform', 'base'],
    ['raised central body block', 'body'],
    ['rectangular top block', 'top'],
    ['upper part', 'top'],
    ['lower part', 'bottom'],
    ['central member', 'member'],
    ['lower rectangular base platforms', 'base'],
    ['raised body blocks', 'body'],
    ['upright ring', 'ring'],
  ] as const)
    it(`matches ${label} by a frozen noun phrase`, () => {
      expect(role(label).concept).toBe(concept);
    });
  it('retains adjective role distinctions and avoids substring matches', () => {
    expect(role('upper platform').concept).toBe('platform');
    expect(role('lower top block').concept).toBe('top');
    expect(role('platformer').concept).toBeNull();
    expect(role('bodywork').concept).toBeNull();
    expect(role('upper part and lower part').reason).toBe('AMBIGUOUS');
  });
});
