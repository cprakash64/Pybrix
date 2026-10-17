import { planeSourceFaces } from './semantic-source';
import { requiredValue, contractValueEquals } from './semantic-invariant';
/** OFFLINE RESEARCH ONLY. This contract and its truth must never enter a provider body. */
import { createHash } from 'node:crypto';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  type TopologyReport,
  type ComponentSummary,
  analyseTopology,
} from '@cadfixer/mesh-topology';
import { uncancellable } from '@cadfixer/shared';
import { soup, type Point, type Triangle } from './geometry';
export type RoleScope =
  | 'EXACT_PART'
  | 'REPEATED_FAMILY'
  | 'ASSEMBLY_SCOPE'
  | 'FUSED_VISIBLE_REGION'
  | 'DETAIL'
  | 'WHOLE_OBJECT'
  | 'NON_EXECUTABLE_UNKNOWN';
export type OperationClass =
  | 'EXACT_COMPONENT'
  | 'EXACT_COMPONENT_GROUP'
  | 'QUALIFIED_PLANE'
  | 'FUSED_NONEXECUTABLE'
  | 'UNKNOWN_NONEXECUTABLE';
export interface NamingTruth {
  canonical: string;
  policy: 'REQUIRED_FUNCTIONAL_NAME' | 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE';
  synonyms: string[];
  structural: string[];
  notEquivalent: string[];
}
export interface RoleTruth {
  id: string;
  scope: RoleScope;
  faces: number[];
  operation: OperationClass;
  naming: NamingTruth;
  parent: string | null;
  children: string[];
  parentPolicy: 'INCLUDE_CHILDREN' | 'EXCLUDE_CHILDREN' | 'AGGREGATE_ONLY';
  /** Explicit frozen visibility, independent of model annotations. */
  observableMembers: string[];
}
export interface FamilyTruth {
  id: string;
  count: number;
  members: string[];
  subfamilies: {
    id: string;
    members: string[];
  }[];
  distractors: string[];
  spareRoles: string[];
  rootExecutable: boolean;
}
export interface GridBox {
  role: string;
  lo: Point;
  hi: Point;
}
export interface SourceFace {
  owner: string;
  cell: Point;
  axis: number;
  side: number;
  kind: 'ORIGINAL_ROLE_SURFACE';
}
export interface InterfaceTruth {
  a: string;
  b: string;
  cellA: Point;
  cellB: Point;
  area: number;
  kind: 'REMOVED_INTERNAL_INTERFACE';
}
export interface PlaneTruth {
  role: string;
  normal: Point;
  origin: Point;
  connector: boolean;
}
export interface FusionTruth {
  roles: [string, string];
  minimumInterfaceArea: number;
}
export interface NonPlaneTruth {
  role: string;
  other: string;
  /** Same convex combination of source vertices in both roles proves no strict linear separator. */
  witness: {
    roleFacesVertices: {
      face: number;
      corner: number;
      weight: number;
    }[];
    otherFacesVertices: {
      face: number;
      corner: number;
      weight: number;
    }[];
  };
}
export interface SemanticFixture {
  version: 1;
  id: string;
  construction: {
    kind: 'SHARED_INTEGER_GRID';
    cell: number;
    boxes: GridBox[];
  };
  mesh: CanonicalMesh;
  provenance: SourceFace[];
  interfaces: InterfaceTruth[];
  roles: RoleTruth[];
  families: FamilyTruth[];
  planes: PlaneTruth[];
  noPlane: NonPlaneTruth[];
  fused: FusionTruth[];
  separate: [string, string][];
  expected: {
    triangles: number;
    components: number;
    closed: true;
    positiveOrientation: true;
  };
  strictUnknown: boolean;
  units: 'millimeter' | 'unknown';
}
const key = (p: Point): string => p.join(',');
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function meshDigest(mesh: CanonicalMesh): string {
  return digest({ positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) });
}
const directions: Point[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];
/** Finite positive cell size, exact integer bounds, disjoint role-owned occupied cells.
 * Overlap is permitted only within ONE role (idempotent set union). Cell limit is intentional:
 * this audited construction is for local qualification, never arbitrary imported solids. */
export function buildGridSource(
  boxes: readonly GridBox[],
  cell = 1,
): {
  mesh: CanonicalMesh;
  provenance: SourceFace[];
  interfaces: InterfaceTruth[];
} {
  if (!Number.isFinite(cell) || cell <= 0) throw Error('INVALID_CELL');
  const occupied = new Map<
    string,
    {
      p: Point;
      role: string;
    }
  >();
  let budget = 0;
  for (const b of boxes) {
    if (
      !b.role ||
      ![...b.lo, ...b.hi].every(Number.isSafeInteger) ||
      b.hi.some((v, a) => v <= requiredValue(b.lo[a]))
    )
      throw Error('SHARED_INTEGER_GRID_REQUIRED');
    budget += (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2]);
    if (budget > 200000) throw Error('FIXTURE_CELL_BUDGET');
    for (let x = b.lo[0]; x < b.hi[0]; x++)
      for (let y = b.lo[1]; y < b.hi[1]; y++)
        for (let z = b.lo[2]; z < b.hi[2]; z++) {
          const p: Point = [x, y, z],
            prior = occupied.get(key(p));
          if (prior && prior.role !== b.role) throw Error('AMBIGUOUS_CELL_OWNERSHIP');
          occupied.set(key(p), { p, role: b.role });
        }
  }
  const triangles: Triangle[] = [],
    provenance: SourceFace[] = [],
    interfaces: InterfaceTruth[] = [];
  for (const {
    p: [x, y, z],
    role,
  } of occupied.values()) {
    const quads: Point[][] = [
      [
        [x, y, z],
        [x, y, z + 1],
        [x, y + 1, z + 1],
        [x, y + 1, z],
      ],
      [
        [x + 1, y, z],
        [x + 1, y + 1, z],
        [x + 1, y + 1, z + 1],
        [x + 1, y, z + 1],
      ],
      [
        [x, y, z],
        [x + 1, y, z],
        [x + 1, y, z + 1],
        [x, y, z + 1],
      ],
      [
        [x, y + 1, z],
        [x, y + 1, z + 1],
        [x + 1, y + 1, z + 1],
        [x + 1, y + 1, z],
      ],
      [
        [x, y, z],
        [x, y + 1, z],
        [x + 1, y + 1, z],
        [x + 1, y, z],
      ],
      [
        [x, y, z + 1],
        [x + 1, y, z + 1],
        [x + 1, y + 1, z + 1],
        [x, y + 1, z + 1],
      ],
    ];
    for (const [d, delta] of directions.entries()) {
      const neighbor: Point = [x + delta[0], y + delta[1], z + delta[2]],
        other = occupied.get(key(neighbor));
      if (other) {
        if (d % 2 === 1 && other.role !== role)
          interfaces.push({
            a: role,
            b: other.role,
            cellA: [x, y, z],
            cellB: neighbor,
            area: cell * cell,
            kind: 'REMOVED_INTERNAL_INTERFACE',
          });
        continue;
      }
      const q = requiredValue(quads[d]).map((p) => p.map((v) => v * cell) as unknown as Point);
      triangles.push(
        [requiredValue(q[0]), requiredValue(q[1]), requiredValue(q[2])],
        [requiredValue(q[0]), requiredValue(q[2]), requiredValue(q[3])],
      );
      const entry: SourceFace = {
        owner: role,
        cell: [x, y, z],
        axis: Math.floor(d / 2),
        side: d % 2 === 0 ? -1 : 1,
        kind: 'ORIGINAL_ROLE_SURFACE',
      };
      provenance.push(entry, entry);
    }
  }
  return { mesh: soup(triangles), provenance, interfaces };
}
export function buildSemanticFixture(
  spec: Omit<SemanticFixture, 'version' | 'mesh' | 'provenance' | 'interfaces' | 'roles'> & {
    roles: Omit<RoleTruth, 'faces'>[];
  },
): SemanticFixture {
  const source = buildGridSource(spec.construction.boxes, spec.construction.cell);
  const roles = spec.roles.map((r) => ({
    ...r,
    faces: source.provenance.flatMap((p, f) => (p.owner === r.id ? [f] : [])),
  }));
  const byId = new Map(roles.map((r) => [r.id, r]));
  const include = (r: RoleTruth, seen = new Set<string>()): number[] => {
    if (seen.has(r.id)) throw Error('ROLE_CYCLE');
    if (r.parentPolicy === 'EXCLUDE_CHILDREN') return r.faces;
    return [
      ...new Set([
        ...r.faces,
        ...r.children.flatMap((id) =>
          include(requiredValue(byId.get(id)), new Set([...seen, r.id])),
        ),
      ]),
    ].sort((a, b) => a - b);
  };
  for (const r of roles) r.faces = include(r);
  return { ...spec, version: 1, ...source, roles };
}
/** Exact stored-coordinate edge connectivity; independent from semantic labels and fixture roles. */
export function faceComponents(mesh: CanonicalMesh): number[][] {
  const n = mesh.indices.length / 3,
    parent = Array.from({ length: n }, (_, i) => i),
    edges = new Map<string, number>();
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = requiredValue(parent[requiredValue(parent[a])]);
      a = requiredValue(parent[a]);
    }
    return a;
  };
  for (let f = 0; f < n; f++) {
    const vertices = [0, 1, 2].map((c) => {
      const v = requiredValue(mesh.indices[f * 3 + c]) * 3;
      return key([
        requiredValue(mesh.positions[v]),
        requiredValue(mesh.positions[v + 1]),
        requiredValue(mesh.positions[v + 2]),
      ]);
    });
    for (let c = 0; c < 3; c++) {
      const k = [requiredValue(vertices[c]), requiredValue(vertices[(c + 1) % 3])].sort().join('|'),
        prior = edges.get(k);
      if (prior !== undefined) parent[find(f)] = find(prior);
      else edges.set(k, f);
    }
  }
  const result = new Map<number, number[]>();
  for (let f = 0; f < n; f++) {
    const p = find(f);
    const faces = result.get(p) ?? [];
    faces.push(f);
    result.set(p, faces);
  }
  return [...result.values()];
}
export interface FixtureTopology {
  report: Omit<TopologyReport, 'analysisMilliseconds'>;
  components: {
    faces: number[];
    bounds: { lo: number[]; hi: number[] };
    summary: ComponentSummary | null;
  }[];
}
export interface FixtureValidation {
  status: 'VALID_FIXTURE' | 'INVALID_FIXTURE';
  errors: string[];
  sourceHash: string;
  topology: FixtureTopology;
  truthHash: string;
  evidenceHash: string;
}
export interface FrozenSemanticFixture {
  payload: {
    version: number;
    fixture: Omit<SemanticFixture, 'mesh'> & {
      mesh: { positions: number[]; indices: number[]; metadata: CanonicalMesh['metadata'] };
    };
    evidence: FixtureEvidence;
    validation: FixtureValidation;
  };
  sha256: string;
}
export interface UnprovenFixtureAudit {
  status: 'INVALID_FIXTURE';
  qualificationEligible: boolean;
  errors: string[];
  expectedComponents: number;
  actualComponents: number;
  topology: FixtureTopology;
  metrics: null;
}
export function auditFixtureTopology(mesh: CanonicalMesh): FixtureTopology {
  const { report } = analyseTopology(mesh, {
    documentId: 'offline-fixture',
    partId: 'source',
    documentRevision: 0,
    cancellation: uncancellable,
    sampleLimit: 100000,
  });
  const stable = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== 'analysisMilliseconds'),
  ) as Omit<TopologyReport, 'analysisMilliseconds'>;
  const components = faceComponents(mesh).map((faces, i) => {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const f of faces)
      for (let c = 0; c < 3; c++)
        for (let a = 0; a < 3; a++) {
          const v = requiredValue(mesh.positions[requiredValue(mesh.indices[f * 3 + c]) * 3 + a]);
          lo[a] = Math.min(requiredValue(lo[a]), v);
          hi[a] = Math.max(requiredValue(hi[a]), v);
        }
    return { faces, bounds: { lo, hi }, summary: report.components[i] ?? null };
  });
  return { report: stable, components };
}
export interface PlaneEvidence {
  role: string;
  selected: number[];
  complement: number[];
  nativeValid: boolean;
  closedOutputs: boolean;
  plane: PlaneTruth;
  sourceHash: string;
  detail: unknown;
}
export interface ConnectorEvidence {
  role: string;
  sourceHash: string;
  plane: PlaneTruth;
  knownUnits: boolean;
  closedOutputs: boolean;
  interfaceArea: number;
  wallDepthClearance: boolean;
  automaticPlan: boolean;
  centersMatch: boolean;
  maleFemaleBoolean: boolean;
  undoExact: boolean;
  detail: unknown;
}
export interface FixtureEvidence {
  planes: PlaneEvidence[];
  connectors: ConnectorEvidence[];
}
export function sourceAgreement(
  selected: readonly number[],
  truth: readonly number[],
): { precision: number; recall: number } {
  const s = new Set(selected),
    t = new Set(truth);
  let hits = 0;
  for (const f of s) if (t.has(f)) hits++;
  return { precision: s.size ? hits / s.size : 0, recall: t.size ? hits / t.size : 0 };
}
export function validateSemanticFixture(
  f: SemanticFixture,
  evidence: FixtureEvidence = { planes: [], connectors: [] },
): FixtureValidation {
  const errors: string[] = [],
    fail = (s: string): number => errors.push(s),
    hash = meshDigest(f.mesh),
    topology = auditFixtureTopology(f.mesh),
    r = topology.report,
    byId = new Map(f.roles.map((r) => [r.id, r]));
  if (
    !contractValueEquals(f.version, 1) ||
    !contractValueEquals(f.construction.kind, 'SHARED_INTEGER_GRID') ||
    !Number.isSafeInteger(f.expected.triangles) ||
    f.expected.triangles <= 0 ||
    !Number.isSafeInteger(f.expected.components) ||
    f.expected.components <= 0 ||
    !contractValueEquals(f.expected.closed, true) ||
    !contractValueEquals(f.expected.positiveOrientation, true)
  )
    fail('FIXTURE_CONTRACT');
  for (const role of f.roles) {
    if (
      ![
        'EXACT_PART',
        'REPEATED_FAMILY',
        'ASSEMBLY_SCOPE',
        'FUSED_VISIBLE_REGION',
        'DETAIL',
        'WHOLE_OBJECT',
        'NON_EXECUTABLE_UNKNOWN',
      ].includes(role.scope) ||
      ![
        'EXACT_COMPONENT',
        'EXACT_COMPONENT_GROUP',
        'QUALIFIED_PLANE',
        'FUSED_NONEXECUTABLE',
        'UNKNOWN_NONEXECUTABLE',
      ].includes(role.operation) ||
      !['INCLUDE_CHILDREN', 'EXCLUDE_CHILDREN', 'AGGREGATE_ONLY'].includes(role.parentPolicy) ||
      !['REQUIRED_FUNCTIONAL_NAME', 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE'].includes(
        role.naming.policy,
      ) ||
      !role.naming.canonical.trim()
    )
      fail(`ROLE_CONTRACT:${role.id}`);
  }
  for (const plane of f.planes) {
    if (byId.get(plane.role)?.operation !== 'QUALIFIED_PLANE') fail(`PLANE_ROLE:${plane.role}`);
    try {
      planeSourceFaces(f.mesh, plane);
    } catch {
      fail(`PLANE_SOURCE_MEMBERSHIP:${plane.role}`);
    }
  }
  let rebuilt: ReturnType<typeof buildGridSource> | undefined;
  try {
    rebuilt = buildGridSource(f.construction.boxes, f.construction.cell);
    if (meshDigest(rebuilt.mesh) !== hash) fail('GEOMETRY_PROVENANCE_MISMATCH');
    if (
      digest(rebuilt.provenance) !== digest(f.provenance) ||
      digest(rebuilt.interfaces) !== digest(f.interfaces)
    )
      fail('SOURCE_PROVENANCE_MISMATCH');
  } catch (e) {
    fail(String(e));
  }
  if (r.sourceFaceCount !== f.expected.triangles || r.componentCount !== f.expected.components)
    fail('TOPOLOGY_EXPECTATION_MISMATCH');
  if (r.componentsTruncated || r.componentCount !== topology.components.length)
    fail('INCOMPLETE_COMPONENT_ANALYSIS');
  if (
    !r.isBoundaryFree ||
    !r.isEdgeManifold ||
    !r.isVertexManifold ||
    !r.isWindingConsistent ||
    r.zeroAreaFaceCount ||
    r.repeatedPositionFaceCount ||
    r.sameOrientationDuplicateCount ||
    r.reversedOrientationDuplicateCount
  )
    fail('TOPOLOGY_DEFECT');
  if (r.components.some((c) => c.signedVolume <= 0)) fail('REVERSED_OR_ZERO_VOLUME');
  if (!f.roles.length || byId.size !== f.roles.length) fail('ROLE_IDS');
  const validFaces = (faces: readonly number[]): boolean =>
    faces.length > 0 &&
    new Set(faces).size === faces.length &&
    faces.every((v) => Number.isInteger(v) && v >= 0 && v < r.sourceFaceCount);
  const ancestor = (a: RoleTruth, b: RoleTruth, seen = new Set<string>()): boolean => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return (
      a.children.includes(b.id) ||
      a.children.some((c) => {
        const child = byId.get(c);
        return child ? ancestor(child, b, seen) : false;
      })
    );
  };
  for (const role of f.roles) {
    if (!validFaces(role.faces)) fail(`ROLE_MEMBERSHIP:${role.id}`);
    if (
      role.children.some((id) => byId.get(id)?.parent !== role.id) ||
      (role.parent !== null && !byId.get(role.parent)?.children.includes(role.id))
    )
      fail(`PARENT_RELATION:${role.id}`);
    if (ancestor(role, role)) fail(`ROLE_CYCLE:${role.id}`);
    const expected = f.provenance.flatMap((p, i) => (p.owner === role.id ? [i] : []));
    for (const c of role.children) {
      const child = byId.get(c);
      if (child && role.parentPolicy !== 'EXCLUDE_CHILDREN') expected.push(...child.faces);
    }
    if (
      digest([...new Set(expected)].sort((a, b) => a - b)) !==
      digest([...role.faces].sort((a, b) => a - b))
    )
      fail(`OWNERSHIP_CONFLICT:${role.id}`);
    if (
      role.naming.notEquivalent.some((n) =>
        [role.naming.canonical, ...role.naming.synonyms, ...role.naming.structural].includes(n),
      )
    )
      fail(`ONTOLOGY_CONFLICT:${role.id}`);
    const comps = topology.components.filter((c) => c.faces.some((v) => role.faces.includes(v)));
    if (role.operation === 'EXACT_COMPONENT' || role.operation === 'EXACT_COMPONENT_GROUP') {
      const exact = comps.flatMap((c) => c.faces);
      if (role.faces.length === r.sourceFaceCount) fail(`EMPTY_COMPONENT_COMPLEMENT:${role.id}`);
      if (
        digest([...exact].sort((a, b) => a - b)) !==
          digest([...role.faces].sort((a, b) => a - b)) ||
        (role.operation === 'EXACT_COMPONENT' && comps.length !== 1)
      )
        fail(`COMPONENT_SCOPE:${role.id}`);
    }
    if (role.operation === 'QUALIFIED_PLANE') {
      const candidates = evidence.planes.filter(
        (e) =>
          e.role === role.id &&
          e.sourceHash === hash &&
          f.planes.some((p) => digest(p) === digest(e.plane)),
      );
      if (
        !candidates.some((e) => {
          const a = sourceAgreement(e.selected, role.faces);
          let actual: number[];
          try {
            actual = planeSourceFaces(f.mesh, e.plane);
          } catch {
            return false;
          }
          if (
            digest([...actual].sort((a, b) => a - b)) !==
            digest([...e.selected].sort((a, b) => a - b))
          )
            return false;
          return (
            e.nativeValid &&
            e.closedOutputs &&
            a.precision >= 0.9 &&
            a.recall >= 0.9 &&
            validFaces(e.selected) &&
            validFaces(e.complement) &&
            new Set([...e.selected, ...e.complement]).size === r.sourceFaceCount &&
            !e.selected.some((v) => e.complement.includes(v))
          );
        })
      )
        fail(`PLANE_UNQUALIFIED:${role.id}`);
    }
    if (
      (role.scope === 'FUSED_VISIBLE_REGION' || role.operation === 'FUSED_NONEXECUTABLE') &&
      !f.fused.some((v) => v.roles.includes(role.id))
    )
      fail(`MISSING_FUSION_EXPECTATION:${role.id}`);
    if (
      role.operation === 'UNKNOWN_NONEXECUTABLE' &&
      !['NON_EXECUTABLE_UNKNOWN', 'WHOLE_OBJECT'].includes(role.scope)
    )
      fail(`UNKNOWN_SCOPE:${role.id}`);
  }
  for (const [i, a] of f.roles.entries())
    for (const b of f.roles.slice(i + 1))
      if (
        a.faces.some((v) => b.faces.includes(v)) &&
        !(
          (ancestor(a, b) && a.parentPolicy !== 'EXCLUDE_CHILDREN') ||
          (ancestor(b, a) && b.parentPolicy !== 'EXCLUDE_CHILDREN')
        )
      )
        fail(`DUPLICATE_SOURCE_MEMBERSHIP:${a.id}:${b.id}`);
  for (const p of f.provenance) if (!byId.has(p.owner)) fail('UNOWNED_SOURCE');
  const roleComps = (id: string): Set<number> =>
    new Set(
      topology.components.flatMap((c, i) =>
        c.faces.some((v) => byId.get(id)?.faces.includes(v)) ? [i] : [],
      ),
    );
  for (const fusion of f.fused) {
    const [a, b] = fusion.roles,
      ac = roleComps(a),
      bc = roleComps(b),
      area = f.interfaces
        .filter((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))
        .reduce((n, x) => n + x.area, 0);
    if (
      ac.size !== 1 ||
      bc.size !== 1 ||
      [...ac][0] !== [...bc][0] ||
      !Number.isFinite(fusion.minimumInterfaceArea) ||
      fusion.minimumInterfaceArea <= 0 ||
      area < fusion.minimumInterfaceArea
    )
      fail(`FUSION_EXPECTATION:${a}:${b}`);
  }
  for (const [a, b] of f.separate) {
    const ac = roleComps(a),
      bc = roleComps(b);
    if (!ac.size || !bc.size || [...ac].some((v) => bc.has(v)))
      fail(`SEPARATION_EXPECTATION:${a}:${b}`);
  }
  for (const family of f.families) {
    const members = family.members.map((id) => byId.get(id));
    if (
      family.count < 2 ||
      family.count !== members.length ||
      new Set(family.members).size !== members.length ||
      members.some((m) => !m)
    )
      fail(`FAMILY_SOURCE_MISSING:${family.id}`);
    if (members.some((m) => m && !validFaces(m.faces))) fail(`FAMILY_MEMBER_INVALID:${family.id}`);
    const union = members.flatMap((m) => m?.faces ?? []);
    if (new Set(union).size !== union.length) fail(`FAMILY_MEMBER_OVERLAP:${family.id}`);
    if (
      digest([...union].sort((a, b) => a - b)) !==
      digest([...(byId.get(family.id)?.faces ?? [])].sort((a, b) => a - b))
    )
      fail(`FAMILY_ROOT_MEMBERSHIP:${family.id}`);
    for (const id of [...family.distractors, ...family.spareRoles])
      if (!byId.has(id) || requiredValue(byId.get(id)).faces.some((v) => union.includes(v)))
        fail(`FAMILY_DISTRACTOR:${family.id}`);
    if (
      family.subfamilies.some(
        (s) =>
          !s.members.length ||
          new Set(s.members).size !== s.members.length ||
          s.members.some((id) => !family.members.includes(id)),
      )
    )
      fail(`SUBFAMILY:${family.id}`);
    if (
      family.rootExecutable !==
      ['EXACT_COMPONENT', 'EXACT_COMPONENT_GROUP', 'QUALIFIED_PLANE'].includes(
        byId.get(family.id)?.operation ?? '',
      )
    )
      fail(`FAMILY_EXECUTABILITY:${family.id}`);
  }
  for (const n of f.noPlane) {
    const point = (
      items: NonPlaneTruth['witness']['roleFacesVertices'],
      id: string,
    ): number[] | null => {
      if (
        !items.length ||
        Math.abs(items.reduce((s, x) => s + x.weight, 0) - 1) > 1e-12 ||
        items.some(
          (x) =>
            !Number.isFinite(x.weight) ||
            x.weight <= 0 ||
            !byId.get(id)?.faces.includes(x.face) ||
            ![0, 1, 2].includes(x.corner),
        )
      )
        return null;
      return [0, 1, 2].map((a) =>
        items.reduce(
          (s, x) =>
            s +
            requiredValue(
              f.mesh.positions[requiredValue(f.mesh.indices[x.face * 3 + x.corner]) * 3 + a],
            ) *
              x.weight,
          0,
        ),
      );
    };
    const a = point(n.witness.roleFacesVertices, n.role),
      b = point(n.witness.otherFacesVertices, n.other);
    if (
      !a ||
      !b ||
      a.some((v, i) => Math.abs(v - requiredValue(b[i])) > 1e-9) ||
      byId.get(n.role)?.operation !== 'FUSED_NONEXECUTABLE'
    )
      fail(`NO_PLANE_WITNESS:${n.role}`);
  }
  for (const p of f.planes.filter((p) => p.connector)) {
    const e = evidence.connectors.find(
      (e) => e.role === p.role && e.sourceHash === hash && digest(e.plane) === digest(p),
    );
    if (
      f.units !== 'millimeter' ||
      !e ||
      !e.knownUnits ||
      !e.closedOutputs ||
      e.interfaceArea <= 0 ||
      !e.wallDepthClearance ||
      !e.automaticPlan ||
      !e.centersMatch ||
      !e.maleFemaleBoolean ||
      !e.undoExact
    )
      fail(`CONNECTOR_UNQUALIFIED:${p.role}`);
  }
  return {
    status: errors.length ? ('INVALID_FIXTURE' as const) : ('VALID_FIXTURE' as const),
    errors,
    sourceHash: hash,
    topology,
    truthHash: digest({ ...f, mesh: hash }),
    evidenceHash: digest(evidence),
  };
}
/** Revalidates NOW. Mutating mesh/truth/evidence after validation cannot reuse a previous pass. */
export function freezeSemanticFixture(
  f: SemanticFixture,
  evidence: FixtureEvidence = { planes: [], connectors: [] },
): FrozenSemanticFixture {
  const validation = validateSemanticFixture(f, evidence);
  if (validation.status !== 'VALID_FIXTURE')
    throw Error(`INVALID_FIXTURE: ${validation.errors.join('; ')}`);
  const payload = {
    version: 1,
    fixture: {
      ...f,
      mesh: {
        positions: Array.from(f.mesh.positions),
        indices: Array.from(f.mesh.indices),
        metadata: f.mesh.metadata,
      },
    },
    evidence,
    validation,
  };
  return { payload, sha256: digest(payload) };
}
/** Legacy/imported geometry has no trusted provenance contract. Topology can diagnose it but
 * can NEVER mint legal-operation truth. In particular, do not turn a consumed run into a pass. */
export function auditUnprovenFixture(
  mesh: CanonicalMesh,
  expectedComponents: number,
): UnprovenFixtureAudit {
  const topology = auditFixtureTopology(mesh);
  return {
    status: 'INVALID_FIXTURE' as const,
    qualificationEligible: false,
    errors: [
      ...(topology.report.componentCount !== expectedComponents
        ? ['INTENDED_COMPONENT_COUNT_MISMATCH']
        : []),
      'MISSING_AUDITED_PROVENANCE_AND_LEGAL_OPERATION_TRUTH',
    ],
    expectedComponents,
    actualComponents: topology.report.componentCount,
    topology,
    metrics: null,
  };
}
