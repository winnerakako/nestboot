import { describe, expect, it } from 'vitest';
import { __NAME__Action } from '../actions/__KEBAB__.action.js';
import { __NAME__Schema } from '../dtos/__KEBAB__.dto.js';

/**
 * This test fails on purpose. Make it pass; that is the loop.
 */
describe('__NAME__', () => {
  it('validates its input through the DTO', () => {
    const result = __NAME__Schema.safeParse({});
    expect(result.success, 'describe the real input and assert on it').toBe(true);
  });

  it('does the thing it is for', async () => {
    const action = new __NAME__Action();
    await expect(action.run(__NAME__Schema.parse({}))).resolves.toBeDefined();
  });
});
