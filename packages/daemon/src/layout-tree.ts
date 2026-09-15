// A layout's grid is a tree that strictly alternates row-lists and col-lists:
// a leaf is one pane (empty, or holding a terminal session); a split is an
// ordered, flat list of >= 2 same-orientation children (all "row" siblings
// side by side, or all "col" siblings stacked), each with a size (fraction of
// the split, summing to 1). Splitting a pane in the same direction as its
// immediate parent appends a flat sibling there instead of nesting; splitting
// in the other direction wraps just that pane in a new nested split — so a
// child split's dir is never equal to its parent's. Kept as pure functions
// with no DB access so both the daemon boot path (resume rewriting) and the
// route layer (CRUD, prune-on-delete) can reuse them without a circular
// import.
import { randomUUID } from "node:crypto";

// A note pinned into a leaf by the pin_note MCP tool — see routes/layouts.ts
// POST /pin-note. Mutually exclusive with sessionId by construction: a leaf
// either holds a live terminal session or a pinned note, never both.
export interface PaneNote {
  title: string;
  content: string;
  createdAt: string;
}

export interface PaneLeaf {
  type: "leaf";
  id: string;
  sessionId: number | null;
  note?: PaneNote | null;
}

export interface PaneSplit {
  type: "split";
  id: string;
  dir: "row" | "col";
  children: PaneNode[];
  sizes: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

export function emptyLeaf(): PaneLeaf {
  return { type: "leaf", id: randomUUID(), sessionId: null };
}

// What a brand-new tab starts with.
export function emptyTree(): PaneNode {
  return emptyLeaf();
}

function equalSizes(count: number): number[] {
  return Array(count).fill(1 / count);
}

// Migration 0019 backfill: turns an old flat, ordered session-id list into an
// equivalent tree (a single row split, all panes equal-width) so existing
// saved layouts survive the move to tree-shaped grids instead of coming back
// empty.
export function chainFromSessionIds(sessionIds: number[]): PaneNode {
  if (sessionIds.length === 0) return emptyLeaf();
  const leaves: PaneLeaf[] = sessionIds.map((sessionId) => ({ type: "leaf", id: randomUUID(), sessionId }));
  if (leaves.length === 1) return leaves[0];
  return { type: "split", id: randomUUID(), dir: "row", children: leaves, sizes: equalSizes(leaves.length) };
}

// Left/top-to-right/bottom leaf order — used both for "name this tab after
// its first pane" and for computing which session ids a tree references.
export function leavesInOrder(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(leavesInOrder);
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
  return { ...node, children: node.children.map((c) => remapSessionIds(c, map)) };
}

// Splits the leaf `targetId`. If its immediate parent already runs in `dir`,
// the new empty leaf is appended as a flat sibling there (equal-sizing the
// whole row/col); otherwise `targetId` is wrapped in a new nested split of
// two equal children. Returns the tree unchanged if targetId isn't found.
export function splitPane(node: PaneNode, targetId: string, dir: "row" | "col"): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return { type: "split", id: randomUUID(), dir, children: [node, emptyLeaf()], sizes: [0.5, 0.5] };
  }

  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx !== -1) {
    if (node.dir === dir) {
      const children = [...node.children.slice(0, idx + 1), emptyLeaf(), ...node.children.slice(idx + 1)];
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    const wrapped: PaneSplit = {
      type: "split",
      id: randomUUID(),
      dir,
      children: [node.children[idx], emptyLeaf()],
      sizes: [0.5, 0.5],
    };
    const children = [...node.children];
    children[idx] = wrapped;
    return { ...node, children };
  }

  return { ...node, children: node.children.map((c) => splitPane(c, targetId, dir)) };
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

// Pins `note` into a new leaf placed directly below (dir "col") the leaf
// `targetId` — same placement logic as splitPane(node, targetId, "col"), but
// the new leaf comes pre-filled with the note instead of empty. Returns null
// if targetId wasn't found in this tree, so the caller (POST /pin-note) can
// tell "pinned" apart from "no such pane".
export function pinNote(node: PaneNode, targetId: string, note: PaneNote): PaneNode | null {
  const noteLeaf: PaneLeaf = { type: "leaf", id: randomUUID(), sessionId: null, note };

  if (node.type === "leaf") {
    if (node.id !== targetId) return null;
    return { type: "split", id: randomUUID(), dir: "col", children: [node, noteLeaf], sizes: [0.5, 0.5] };
  }

  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx !== -1) {
    if (node.dir === "col") {
      const children = [...node.children.slice(0, idx + 1), noteLeaf, ...node.children.slice(idx + 1)];
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    const wrapped: PaneSplit = {
      type: "split",
      id: randomUUID(),
      dir: "col",
      children: [node.children[idx], noteLeaf],
      sizes: [0.5, 0.5],
    };
    const children = [...node.children];
    children[idx] = wrapped;
    return { ...node, children };
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== "split") continue;
    const result = pinNote(child, targetId, note);
    if (result) {
      const children = [...node.children];
      children[i] = result;
      return { ...node, children };
    }
  }
  return null;
}

export function findLeaf(node: PaneNode, targetId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === targetId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, targetId);
    if (found) return found;
  }
  return null;
}
