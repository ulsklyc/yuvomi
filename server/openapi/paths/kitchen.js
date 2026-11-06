import { op } from '../helpers.js';

export function kitchenPaths() {
  return {
    '/api/v1/kitchen/summary': {
      get: op({
        summary: 'Kitchen cycle state for the shared tab bar (open shopping items, pantry attention)',
        tag: 'Kitchen',
      }),
    },
  };
}
