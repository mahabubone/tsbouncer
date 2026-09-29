import type { LimitKind } from './limits.js';
import type { ReadTupleQuery, Tuple } from './store.js';

export type ExplainOp =
  | 'direct'
  | 'userset'
  | 'computed'
  | 'ttu'
  | 'union'
  | 'intersection'
  | 'exclusion'
  | 'condition'
  | 'cycle'
  | 'limit';

/**
 * One step of the decision trace.
 *
 * Every node is JSON-serializable and carries the same core fields, so a
 * consumer can walk the tree generically without switching on shape. A leaf that
 * produced an answer cites the tuples responsible; a leaf that did not cites
 * the query that came back empty. That distinction is the whole point of
 * `explain` — knowing *why* is the question.
 */
export interface ExplainNode {
  readonly op: ExplainOp;
  readonly result: boolean;
  readonly children: readonly ExplainNode[];
  /** Tuples that satisfied this node. Empty when unresolved. */
  readonly tuples: readonly Tuple[];
  /** The read this node issued, so an unresolved node is still actionable. */
  readonly query?: ReadTupleQuery | undefined;
  /** Relation or permission name, for `computed`. */
  readonly name?: string | undefined;
  /** Relation traversed, for `ttu`. */
  readonly through?: string | undefined;
  /** Relation or permission taken on the related object, for `ttu`. */
  readonly target?: string | undefined;
  /** Which budget was exhausted, for `limit`. */
  readonly limit?: LimitKind | undefined;
  /** Why a node could not be evaluated. */
  readonly reason?: string | undefined;
}

export interface ExplainResult {
  readonly allowed: boolean;
  readonly subject: string;
  readonly permission: string;
  readonly resource: string;
  readonly tree: ExplainNode;
  /** Reads issued. Useful for spotting a hot query path. */
  readonly reads: number;
}

const INDENT = '  ';

const symbol = (result: boolean): string => (result ? '+' : '-');

/**
 * Render a trace as indented text.
 *
 * Deliberately a formatter over the structure, not a separate code path — the
 * tree is the product and the text is a view of it, so the two cannot disagree.
 */
export function formatExplain(result: ExplainResult): string {
  const lines: string[] = [];
  const header = `${result.allowed ? 'ALLOWED' : 'DENIED'}  ${result.subject} -> ${result.resource}#${result.permission}`;
  lines.push(header);
  lines.push(walk(result.tree, 1));
  if (result.reads > 0)
    lines.push(`${INDENT}(${result.reads} read${result.reads === 1 ? '' : 's'})`);
  return lines.join('\n');
}

function walk(node: ExplainNode, depth: number): string {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];

  switch (node.op) {
    case 'union':
      lines.push(`${pad}${symbol(node.result)} union`);
      break;
    case 'intersection':
      lines.push(`${pad}${symbol(node.result)} intersection`);
      break;
    case 'exclusion':
      lines.push(`${pad}${symbol(node.result)} except`);
      break;
    case 'computed':
      lines.push(`${pad}${symbol(node.result)} ${node.name ?? '?'}`);
      break;
    case 'ttu':
      lines.push(
        `${pad}${symbol(node.result)} ttu ${node.through ?? '?'}.${node.target ?? '?'}`,
      );
      break;
    case 'condition':
      lines.push(`${pad}${symbol(node.result)} condition`);
      break;
    case 'limit':
      lines.push(`${pad}${symbol(node.result)} limit ${node.limit ?? '?'} exhausted`);
      break;
    case 'cycle':
      lines.push(`${pad}${symbol(node.result)} cycle`);
      break;
    default:
      lines.push(`${pad}${symbol(node.result)} ${node.op}`);
  }

  if (node.reason !== undefined) lines.push(`${pad}${INDENT}${node.reason}`);

  for (const tuple of node.tuples) {
    lines.push(`${pad}${INDENT}${tuple.subject}#${tuple.relation}@${tuple.resource}`);
  }

  for (const child of node.children) lines.push(walk(child, depth + 1));
  return lines.join('\n');
}
