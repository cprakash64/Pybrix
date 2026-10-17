/** Prospective CONTEXTUAL examples, never a global alias dictionary. Copy one into a specific
 * frozen role only when its visual/function assumptions apply. IDs encode extent, not English. */
import type { NamingTruth } from './semantic-fixture';
export const CONTEXTUAL_NAMING: Readonly<Record<string, NamingTruth>> = Object.freeze({
  chair_armrests: {
    canonical: 'Armrests',
    policy: 'REQUIRED_FUNCTIONAL_NAME',
    synonyms: ['Chair arms'],
    structural: [],
    notEquivalent: ['Upper limbs', 'Arms of a figure', 'Backrest'],
  },
  cart_push_handle: {
    canonical: 'Push handle',
    policy: 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE',
    synonyms: ['Cart handle'],
    structural: ['Upper handle', 'U-shaped handle'],
    notEquivalent: ['Carry handle', 'Vehicle body'],
  },
  ambiguous_upper_block: {
    canonical: 'Upper block',
    policy: 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE',
    synonyms: [],
    structural: ['Top block', 'Upper housing'],
    notEquivalent: ['Whole pedestal', 'Base'],
  },
  plate_shaped_cover: {
    canonical: 'Cover',
    policy: 'FUNCTIONAL_OR_STRUCTURAL_ACCEPTABLE',
    synonyms: ['Top cover'],
    structural: ['Top plate'],
    notEquivalent: ['Whole housing', 'Base plate'],
  },
  feet_only: {
    canonical: 'Feet',
    policy: 'REQUIRED_FUNCTIONAL_NAME',
    synonyms: ['Foot pieces'],
    structural: [],
    notEquivalent: ['Legs', 'Lower limbs', 'Lower-limb assembly'],
  },
  lower_limb_assembly: {
    canonical: 'Lower-limb assembly',
    policy: 'REQUIRED_FUNCTIONAL_NAME',
    synonyms: ['Leg assembly', 'Leg and foot assembly'],
    structural: [],
    notEquivalent: ['Feet', 'Foot pieces'],
  },
});
