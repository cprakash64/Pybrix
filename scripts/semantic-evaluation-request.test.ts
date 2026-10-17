import { requiredValue } from '../packages/repair-evaluation/src/semantic-invariant';
import { it, expect } from 'vitest';
import {
  independentControl,
  familyControl,
} from '../packages/repair-evaluation/src/semantic-controls';
import { freezeSemanticFixture } from '../packages/repair-evaluation/src/semantic-fixture';
import { buildValidatedEvaluationRequest } from './semantic-evaluation-request.qualify';
it('validates freeze before rendering and exports only the unchanged production request fields', async () => {
  const f = independentControl();
  f.id = 'PRIVATE_FIXTURE_SENTINEL';
  requiredValue(f.roles[0]).naming.canonical = 'PRIVATE_TRUTH_SENTINEL';
  const e = { planes: [], connectors: [] },
    freeze = freezeSemanticFixture(f, e);
  const r = await buildValidatedEvaluationRequest(f, e, freeze.sha256),
    wire = JSON.stringify(r);
  expect(r.views).toHaveLength(6);
  expect(r.componentViews).toHaveLength(6);
  expect(Object.keys(r).sort()).toEqual([
    'componentViews',
    'mode',
    'protocolVersion',
    'requestId',
    'semantic',
    'summary',
    'views',
  ]);
  for (const token of [
    'PRIVATE_FIXTURE_SENTINEL',
    'PRIVATE_TRUTH_SENTINEL',
    'sourceHash',
    'provenance',
    'aliases',
    'connectors',
    'planes',
    'sourceFaces',
    '/Users/',
  ])
    expect(wire).not.toContain(token);
  f.expected.components = 1;
  await expect(buildValidatedEvaluationRequest(f, e, freeze.sha256)).rejects.toThrow('UNVALIDATED');
}, 15000);

it('grounds frozen family visibility in actual production source rasters before any dispatch', async () => {
  const f = familyControl(),
    e = { planes: [], connectors: [] };
  const valid = freezeSemanticFixture(f, e);
  expect((await buildValidatedEvaluationRequest(f, e, valid.sha256)).views).toHaveLength(6);
  requiredValue(f.roles.find((r) => r.id === 'supports')).observableMembers = ['left'];
  const wrong = freezeSemanticFixture(f, e);
  await expect(buildValidatedEvaluationRequest(f, e, wrong.sha256)).rejects.toThrow(
    'FROZEN_VISIBILITY_MISMATCH',
  );
}, 15000);
