/**
 * `@cadfixer/mesh-core/spatial` — shared spatial infrastructure.
 *
 * A SUBPATH, deliberately NOT re-exported from the package index: the page bundle imports `@cadfixer/mesh-core`, and a
 * broadphase that only workers use must not become reachable from it. A test holds that boundary.
 */
export { boxesOverlap, createCounters, faceBoxOf, FaceBvh } from './face-bvh';
export type { BroadphaseBudget, BroadphaseCounters } from './face-bvh';
