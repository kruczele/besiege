// A layout's grid is an arbitrary tmux-style binary split tree rather than a
// flat, fixed-size square grid: a leaf is one pane (empty, or holding a
// terminal session); a split is a row/col division of two child nodes at a
// given ratio. Kept as pure functions with no DB access so both the daemon
// boot path (resume rewriting) and the route layer (CRUD, prune-on-delete)
// can reuse them without a circular import.
import { randomUUID } from "node:crypto";

export interface PaneLeaf {
  type: "leaf";
  id: string;
  sessionId: number | null;
}

export interface PaneSplit {
  type: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export function emptyLeaf(): PaneLeaf {
  return { type: "leaf", id: randomUUID(), sessionId: null };
}

// What a brand-new tab starts with.
export function emptyTree(): PaneNode {
  return emptyLeaf();
}

// Migration 0019 backfill: turns an old flat, ordered session-id list into an
// equivalent tree (a left-leaning chain of row-splits) so existing saved
// layouts survive the move to tree-shaped grids instead of coming back empty.
export function chainFromSessionIds(sessionIds: number[]): PaneNode {
  if (sessionIds.length === 0) return emptyLeaf();
  const leaves: PaneLeaf[] = sessionIds.map((sessionId) => ({ type: "leaf", id: randomUUID(), sessionId }));
  let node: PaneNode = leaves[leaves.length - 1];
  for (let i = leaves.length - 2; i >= 0; i--) {
    node = { type: "split", id: randomUUID(), dir: "row", ratio: 0.5, a: leaves[i], b: node };
  }
  return node;
}

// Left/top-to-right/bottom leaf order — used both for "name this tab after
// its first pane" and for computing which session ids a tree references.
export function leavesInOrder(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return [...leavesInOrder(node.a), ...leavesInOrder(node.b)];
}

export function sessionIdsInTree(node: PaneNode): number[] {
  return leavesInOrder(node)
    .map((leaf) => leaf.sessionId)
    .filter((id): id is number => id !== null);
}

// Rewrites sessionId references per `map` (oldId -> newId, or null to clear
// it). Used both to null out a leaf whose session was deleted, and to swap
// in the new session id produced by a boot-time agent resume.
export function remapSessionIds(node: PaneNode, map: Map<number, number | null>): PaneNode {
  if (node.type === "leaf") {
    if (node.sessionId === null || !map.has(node.sessionId)) return node;
    return { ...node, sessionId: map.get(node.sessionId) ?? null };
  }
  return { ...node, a: remapSessionIds(node.a, map), b: remapSessionIds(node.b, map) };
}

// Splits the leaf `targetId` into a two-pane split (the target keeps its
// session, the new sibling starts empty). Returns the tree unchanged if
// targetId isn't found.
export function splitPane(node: PaneNode, targetId: string, dir: "row" | "col"): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return { type: "split", id: randomUUID(), dir, ratio: 0.5, a: node, b: emptyLeaf() };
  }
  return { ...node, a: splitPane(node.a, targetId, dir), b: splitPane(node.b, targetId, dir) };
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

export function findLeaf(node: PaneNode, targetId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === targetId ? node : null;
  return findLeaf(node.a, targetId) ?? findLeaf(node.b, targetId);
}
