/** Types for `boundary-fill-fixture.mjs`, the REPAIR-CORE-02 qualification fixture. */

export interface HoledCube {
  readonly bytes: Uint8Array;
  readonly triangles: number;
  readonly simple: number;
  readonly branched: number;
}

export function gridForTriangles(target: number): number;

export function holedCubeStl(
  n: number,
  options?: {
    readonly simple?: number;
    readonly branched?: number;
    /** A separate closed tetrahedron: a second component Repair reports and never repairs. */
    readonly extraPiece?: boolean;
  },
): HoledCube;
