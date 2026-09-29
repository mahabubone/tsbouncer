import { EvaluationLimitError } from './errors.js';

export type LimitKind = 'depth' | 'nodes' | 'deadline';

export interface EvaluationLimits {
  /**
   * Maximum rewrite nesting. A model is validated so same-type cycles cannot
   * exist, but tuple-to-userset crosses types and can revisit a node.
   */
  readonly maxDepth: number;
  /**
   * Ceiling on the work a single request may do.
   *
   * The budget is per-*request*, not per-branch and not per-candidate: a
   * tuple-to-userset fans out multiplicatively, and `listResources` evaluates
   * every candidate, so anything narrower is a budget a wide graph walks straight
   * past. One `Budget` instance is shared by every part of a request, and it
   * counts *charges*, not just reads — a walk step, a store read, and an
   * evaluation frame each spend one.
   */
  readonly maxNodes: number;
  /** Wall-clock ceiling in milliseconds. */
  readonly maxDurationMs: number;
}

export const DEFAULT_LIMITS: EvaluationLimits = Object.freeze({
  maxDepth: 25,
  maxNodes: 10_000,
  maxDurationMs: 1_000,
});

/**
 * Per-request evaluation budget.
 *
 * Every limit is checked, not just depth: a model can be shallow and still
 * terminate slowly, and a single request must never be able to pin a CPU
 * indefinitely. Exhausting any limit resolves to *not allowed* — the budget
 * is a safety valve, and failing open on exhaustion is exactly backwards.
 */
export class Budget {
  #nodes = 0;
  readonly #deadline: number;
  readonly #limits: EvaluationLimits;

  constructor(limits: EvaluationLimits = DEFAULT_LIMITS) {
    this.#limits = limits;
    this.#deadline = Date.now() + limits.maxDurationMs;
  }

  get nodes(): number {
    return this.#nodes;
  }

  get limits(): EvaluationLimits {
    return this.#limits;
  }

  depth(depth: number): void {
    if (depth > this.#limits.maxDepth) {
      throw new EvaluationLimitError('depth', this.#limits.maxDepth);
    }
  }

  node(): void {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maxNodes) {
      throw new EvaluationLimitError('nodes', this.#limits.maxNodes);
    }
    if (Date.now() > this.#deadline) {
      throw new EvaluationLimitError('deadline', this.#limits.maxDurationMs);
    }
  }

  /** Remaining time, for the client's own bookkeeping. */
  get expired(): boolean {
    return Date.now() > this.#deadline;
  }
}

export function resolveLimits(overrides?: Partial<EvaluationLimits>): EvaluationLimits {
  return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}
