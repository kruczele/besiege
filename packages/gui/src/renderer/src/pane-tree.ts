// Renderer-side pure functions over PaneNode — mirrors (duplicated, not
// shared: different runtime/build target) packages/daemon/src/layout-tree.ts,
// which owns the authoritative versions used for server-side persistence and
// the boot-time resume rewrite.
import type { PaneLeaf, PaneNode } from "../../shared/types.js";

export function emptyLeaf(): PaneLeaf {
  return { type: "leaf", id: crypto.randomUUID(), sessionId: null };
}

export function emptyTree(): PaneNode {
  return emptyLeaf();
}

export function leavesInOrder(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return [...leavesInOrder(node.a), ...leavesInOrder(node.b)];
}

export function findLeaf(node: PaneNode, targetId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === targetId ? node : null;
  return findLeaf(node.a, targetId) ?? findLeaf(node.b, targetId);
}

// Splits the leaf `targetId` into a two-pane split (the target keeps its
// session, the new sibling starts empty). Returns the new tree plus the new
// empty leaf's id (so the caller can focus it), or null if targetId wasn't
// found in this tree.
export function splitPane(
  node: PaneNode,
  targetId: string,
  dir: "row" | "col",
): { tree: PaneNode; newLeafId: string } | null {
  if (node.type === "leaf") {
    if (node.id !== targetId) return null;
    const sibling = emptyLeaf();
    return {
      tree: { type: "split", id: crypto.randomUUID(), dir, ratio: 0.5, a: node, b: sibling },
      newLeafId: sibling.id,
    };
  }
  const left = splitPane(node.a, targetId, dir);
  if (left) return { tree: { ...node, a: left.tree }, newLeafId: left.newLeafId };
  const right = splitPane(node.b, targetId, dir);
  if (right) return { tree: { ...node, b: right.tree }, newLeafId: right.newLeafId };
  return null;
}

// Removes the leaf `targetId`, collapsing its parent split into just the
// sibling. Returns null if the whole tree collapsed away (targetId was the
// tree's only leaf) so the caller can decide what replaces it.
export function closePane(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === "leaf") return node.id === targetId ? null : node;
  const a = closePane(node.a, targetId);
  const b = closePane(node.b, targetId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

export function setPaneSession(node: PaneNode, targetId: string, sessionId: number): PaneNode {
  if (node.type === "leaf") return node.id === targetId ? { ...node, sessionId } : node;
  return { ...node, a: setPaneSession(node.a, targetId, sessionId), b: setPaneSession(node.b, targetId, sessionId) };
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}
