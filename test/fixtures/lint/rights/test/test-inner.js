// Rights fixture (phase 2, B5): a test may import an inner seam to check it on its own.
import { moduleAccessVerdict } from '../server/authorize/modules.ts';
export const probe = moduleAccessVerdict;
