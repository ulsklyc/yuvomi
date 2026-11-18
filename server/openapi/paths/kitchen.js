import { op, withValidationRefusal } from '../helpers.js';
import { OPTIONAL_DATE_PATTERN } from '../../utils/datetime-pattern.js';

export function kitchenPaths() {
  return {
    '/api/v1/kitchen/summary': {
      get: withValidationRefusal(op({
        summary: 'Kitchen cycle state for the shared tab bar (open shopping items, pantry attention)',
        description: '`pantry.expired` counts expired batches; `pantry.low` and `pantry.out` count household products, read over the sum of their batches '
          + 'against the minimum of the product (a product without batches is out only when it has a minimum above 0). `pantry.attention` counts each product once: a product needs attention '
          + 'when it is out, running low, or has at least one expired batch, so a product that is low and has two expired batches is one. '
          + 'The parts do not add up to `attention`.',
        tag: 'Kitchen',
        params: [{
          name: 'today',
          in: 'query',
          required: false,
          description: 'The caller\'s calendar day `YYYY-MM-DD`, given once; "expired" is counted against it. Left out or empty, the household day is used. The shape is checked, not the calendar: a day of that shape is compared as text.',
          schema: { type: 'string', pattern: OPTIONAL_DATE_PATTERN },
        }],
      })),
    },
  };
}
