/**
 * Pure helpers for the Outline panel: stable keys, initial expansion from the model's
 * `open` flags, and flattening of the visible rows (APG tree with a flat DOM: every row
 * carries its own `aria-level` / `aria-setsize` / `aria-posinset`).
 */
import type { OutlineNode } from '@pdf-editor/document-model';

export interface OutlineRow {
  /** Index path from the root, e.g. `1.0.2`. Stable while the outline is unchanged. */
  readonly key: string;
  readonly node: OutlineNode;
  /** 1-based, as `aria-level`. */
  readonly level: number;
  readonly parentKey: string | null;
  readonly setSize: number;
  /** 1-based, as `aria-posinset`. */
  readonly posInSet: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

/** Keys of the nodes whose `open` flag is set (the document's authored expansion). */
export function initiallyExpanded(nodes: readonly OutlineNode[]): Set<string> {
  const keys = new Set<string>();
  const visit = (list: readonly OutlineNode[], prefix: string) => {
    list.forEach((node, index) => {
      const key = prefix === '' ? String(index) : `${prefix}.${index}`;
      if (node.open && node.children.length > 0) keys.add(key);
      visit(node.children, key);
    });
  };
  visit(nodes, '');
  return keys;
}

/** Visible rows in document order: children of collapsed nodes are skipped. */
export function flattenOutline(
  nodes: readonly OutlineNode[],
  expanded: ReadonlySet<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (list: readonly OutlineNode[], prefix: string, level: number) => {
    list.forEach((node, index) => {
      const key = prefix === '' ? String(index) : `${prefix}.${index}`;
      const hasChildren = node.children.length > 0;
      const isExpanded = hasChildren && expanded.has(key);
      rows.push({
        key,
        node,
        level,
        parentKey: prefix === '' ? null : prefix,
        setSize: list.length,
        posInSet: index + 1,
        hasChildren,
        expanded: isExpanded,
      });
      if (isExpanded) visit(node.children, key, level + 1);
    });
  };
  visit(nodes, '', 1);
  return rows;
}

/** Schemes an outline link may open. Anything else (javascript:, file:, …) is refused. */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The parsed URL when `uri` is safe to open in a new tab, else undefined. */
export function openableUrl(uri: string): URL | undefined {
  try {
    const url = new URL(uri);
    return OPENABLE_SCHEMES.has(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
