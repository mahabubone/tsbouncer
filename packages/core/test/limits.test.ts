import { describe, expect, it } from 'vitest';
import { Budget, DEFAULT_LIMITS, resolveLimits } from '../src/index.js';

describe('resolveLimits', () => {
  it('fills in the defaults', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });

  it('accepts a partial override', () => {
    expect(resolveLimits({ maxDepth: 3 }).maxDepth).toBe(3);
    expect(resolveLimits({ maxDepth: 3 }).maxNodes).toBe(DEFAULT_LIMITS.maxNodes);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(resolveLimits({ maxDepth: 1 }))).toBe(true);
  });
});

describe('Budget', () => {
  it('counts nodes up to the limit', () => {
    const budget = new Budget({ maxDepth: 10, maxNodes: 3, maxDurationMs: 1_000 });
    budget.node();
    budget.node();
    expect(budget.nodes).toBe(2);
    // The third is the last one inside the budget; the fourth exhausts it.
    budget.node();
    expect(() => budget.node()).toThrow(/nodes budget exhausted/);
  });

  it('enforces depth', () => {
    const budget = new Budget({ maxDepth: 2, maxNodes: 100, maxDurationMs: 1_000 });
    budget.depth(2);
    expect(() => budget.depth(3)).toThrow(/depth budget exhausted/);
  });

  it('enforces the deadline', () => {
    const budget = new Budget({ maxDepth: 100, maxNodes: 100, maxDurationMs: -1 });
    expect(() => budget.node()).toThrow(/deadline budget exhausted/);
  });

  it('reports expiry', () => {
    const budget = new Budget({ maxDepth: 1, maxNodes: 1, maxDurationMs: -1 });
    expect(budget.expired).toBe(true);
  });

  it('exposes its limits', () => {
    const limits = { maxDepth: 1, maxNodes: 2, maxDurationMs: 3 };
    expect(new Budget(limits).limits).toEqual(limits);
  });
});
