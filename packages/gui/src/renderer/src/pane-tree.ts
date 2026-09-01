// Renderer-side pure functions over PaneNode — mirrors (duplicated, not
// shared: different runtime/build target) packages/daemon/src/layout-tree.ts,
// which owns the authoritative versions used for server-side persistence and
// the boot-time resume rewrite.
import type { PaneLeaf, PaneNode, PaneSplit } from "../../shared/types.js";

export function emptyLeaf(): PaneLeaf {
  return { type: "leaf", id: crypto.randomUUID(), sessionId: null };
}

export function emptyTree(): PaneNode {
  return emptyLeaf();
}

export function leavesInOrder(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(leavesInOrder);
}

export function findLeaf(node: PaneNode, targetId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === targetId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, targetId);
    if (found) return found;
  }
  return null;
}

function equalSizes(count: number): number[] {
  return Array(count).fill(1 / count);
}

// Splits the leaf `targetId`. If its immediate parent already runs in `dir`,
// the new empty leaf is appended as a flat sibling there (equal-sizing the
// whole row/col); otherwise `targetId` is wrapped in a new nested split of
// two equal children. Returns the new tree plus the new empty leaf's id (so
// the caller can focus it), or null if targetId wasn't found in this tree.
export function splitPane(
  node: PaneNode,
  targetId: string,
  dir: "row" | "col",
): { tree: PaneNode; newLeafId: string } | null {
  if (node.type === "leaf") {
    if (node.id !== targetId) return null;
    const sibling = emptyLeaf();
    const split: PaneSplit = { type: "split", id: crypto.randomUUID(), dir, children: [node, sibling], sizes: [0.5, 0.5] };
    return { tree: split, newLeafId: sibling.id };
  }

  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx !== -1) {
    if (node.dir === dir) {
      const sibling = emptyLeaf();
      const children = [...node.children.slice(0, idx + 1), sibling, ...node.children.slice(idx + 1)];
      return { tree: { ...node, children, sizes: equalSizes(children.length) }, newLeafId: sibling.id };
    }
    const sibling = emptyLeaf();
    const wrapped: PaneSplit = {
      type: "split",
      id: crypto.randomUUID(),
      dir,
      children: [node.children[idx], sibling],
      sizes: [0.5, 0.5],
    };
    const children = [...node.children];
    children[idx] = wrapped;
    return { tree: { ...node, children }, newLeafId: sibling.id };
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== "split") continue;
    const result = splitPane(child, targetId, dir);
    if (result) {
      const children = [...node.children];
      children[i] = result.tree;
      return { tree: { ...node, children }, newLeafId: result.newLeafId };
    }
  }
  return null;
}

// Removes the leaf `targetId`, collapsing its parent split into just its
// remaining children (or, if only one remains, into that child directly —
// which itself may cascade a grandparent's collapse). Remaining siblings'
// sizes are rescaled proportionally, not reset to equal. Returns null if the
// whole tree collapsed away (targetId was the tree's only leaf) so the caller
// can decide what replaces it.
export function closePane(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === "leaf") return node.id === targetId ? null : node;
  const survivors: { child: PaneNode; size: number }[] = [];
  node.children.forEach((child, i) => {
    const result = closePane(child, targetId);
    if (result !== null) survivors.push({ child: result, size: node.sizes[i] });
  });
  if (survivors.length === 0) return null;
  if (survivors.length === 1) return survivors[0].child;
  const total = survivors.reduce((sum, s) => sum + s.size, 0);
  return { ...node, children: survivors.map((s) => s.child), sizes: survivors.map((s) => s.size / total) };
}

export function setPaneSession(node: PaneNode, targetId: string, sessionId: number): PaneNode {
  if (node.type === "leaf") return node.id === targetId ? { ...node, sessionId } : node;
  return { ...node, children: node.children.map((c) => setPaneSession(c, targetId, sessionId)) };
}

export function setSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)) };
}
