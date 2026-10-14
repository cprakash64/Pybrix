/** TEST ONLY: visually annotated from the six actual truck renders, never a production matcher.
 * Source raw SHA256 3b9d3aaa3523f75c8e1a079e3aa3e50086d0f2cf9c5abbf78b8790df0a143e73.
 * +Y is truck up, +Z is truck forward. View names are file-camera names, not vehicle directions.
 * An infinite plane splits front/rear assemblies, including fused wheel/body portions. Labels say so.
 */
import type {
  SemanticHierarchy,
  SemanticPart,
  SemanticRegion,
  ViewName,
} from '@cadfixer/auto-split-contract';
export const SEMANTIC_TRUCK_ANNOTATION_MARKER = 'ACTUAL_TRUCK_SEMANTIC_ANNOTATION_TEST_ONLY';
const region = (
  view: ViewName,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): SemanticRegion => ({
  view,
  polygons: [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  ],
});
const part = (
  id: string,
  label: string,
  views: SemanticRegion[],
  parentId: string | null = null,
): SemanticPart => ({
  id,
  label,
  parentId,
  importance: parentId ? 'detail' : 'major',
  confidence: 0.97,
  instances: 1,
  views,
  componentIds: [],
  expectedGeometry: { kind: 'solid_part', likelySeparable: false },
  cut: null,
});
const sides = ['front', 'rear', 'left', 'right'] as const;
const cabin = {
  ...part('cabin', 'Cabin / front assembly', [
    ...sides.map((v) => region(v, 0, 0, 1, 0.5)),
    region('top', 0, 0, 1, 1),
  ]),
  expectedGeometry: { kind: 'solid_part' as const, likelySeparable: true },
  cut: { normal: [0, 0, 1] as const, origin: [0, 0, 0] as const },
};
const bed = {
  ...part('bed', 'Rear bed assembly', [
    ...sides.map((v) => region(v, 0, 0.5, 1, 1)),
    region('bottom', 0, 0, 1, 1),
  ]),
  expectedGeometry: { kind: 'solid_part' as const, likelySeparable: true },
  cut: { normal: [0, 0, -1] as const, origin: [0, 0, 0] as const },
};
const wheels = [
  part(
    'wheel-front-left',
    'Front wheel, left',
    [
      region('front', 0.265, 0.16, 0.383, 0.405),
      region('left', 0.49, 0.17, 0.745, 0.4),
      region('top', 0.265, 0.51, 0.383, 0.745),
    ],
    'wheels',
  ),
  part(
    'wheel-front-right',
    'Front wheel, right',
    [
      region('front', 0.615, 0.16, 0.735, 0.405),
      region('right', 0.255, 0.17, 0.5, 0.4),
      region('top', 0.615, 0.51, 0.735, 0.745),
    ],
    'wheels',
  ),
  part(
    'wheel-rear-left',
    'Rear wheel, left',
    [
      region('front', 0.265, 0.585, 0.383, 0.82),
      region('left', 0.49, 0.585, 0.745, 0.82),
      region('bottom', 0.265, 0.255, 0.383, 0.49),
    ],
    'wheels',
  ),
  part(
    'wheel-rear-right',
    'Rear wheel, right',
    [
      region('front', 0.615, 0.585, 0.735, 0.82),
      region('right', 0.255, 0.585, 0.5, 0.82),
      region('bottom', 0.615, 0.255, 0.735, 0.49),
    ],
    'wheels',
  ),
];
export const SEMANTIC_TRUCK_ANSWER: SemanticHierarchy = {
  object: { label: 'Dump truck', confidence: 0.99 },
  parts: [
    bed,
    cabin,
    {
      ...part('wheels', 'Wheels', [
        {
          view: 'left',
          polygons: [
            [
              [0.49, 0.17],
              [0.745, 0.17],
              [0.745, 0.4],
              [0.49, 0.4],
            ],
            [
              [0.49, 0.585],
              [0.745, 0.585],
              [0.745, 0.82],
              [0.49, 0.82],
            ],
          ],
        },
        {
          view: 'right',
          polygons: [
            [
              [0.255, 0.17],
              [0.5, 0.17],
              [0.5, 0.4],
              [0.255, 0.4],
            ],
            [
              [0.255, 0.585],
              [0.5, 0.585],
              [0.5, 0.82],
              [0.255, 0.82],
            ],
          ],
        },
      ]),
      instances: 4,
      expectedGeometry: { kind: 'repeated_part', likelySeparable: false },
    },
    ...wheels,
    part('chassis', 'Chassis / body', [
      region('front', 0.37, 0.1, 0.63, 0.85),
      region('left', 0.53, 0.38, 0.68, 0.6),
    ]),
    {
      ...part('door-left', 'Door, left', [region('left', 0.34, 0.26, 0.44, 0.405)]),
      importance: 'detail',
      expectedGeometry: { kind: 'surface_part', likelySeparable: false },
    },
    {
      ...part('door-right', 'Door, right', [region('right', 0.56, 0.26, 0.66, 0.405)]),
      importance: 'detail',
      expectedGeometry: { kind: 'surface_part', likelySeparable: false },
    },
  ],
};
