// Renderer-side pure functions over PaneNode — mirrors (duplicated, not
// shared: different runtime/build target) packages/daemon/src/layout-tree.ts,
// which owns the authoritative versions used for server-side persistence and
// the boot-time resume rewrite.
import type { PaneEditor, PaneLeaf, PaneNode, PaneSplit } from "../../shared/types.js";

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

export function setPaneEditor(node: PaneNode, targetId: string, editor: PaneEditor): PaneNode {
  if (node.type === "leaf") return node.id === targetId ? { ...node, editor } : node;
  return { ...node, children: node.children.map((c) => setPaneEditor(c, targetId, editor)) };
}

export function setSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)) };
}

export type DropEdge = "left" | "right" | "top" | "bottom";

// Inserts `leaf` next to the leaf `targetId`: left/right land it in a row,
// top/bottom in a column. When the target's parent already runs in that
// direction the leaf joins it as a flat sibling and takes half of the
// target's share (every other size is untouched); otherwise the target is
// wrapped in a new two-child split. `leaf` must not already be in `node` —
// callers move a pane by closePane-ing it first. Null if targetId isn't found.
export function insertBeside(node: PaneNode, targetId: string, leaf: PaneLeaf, edge: DropEdge): PaneNode | null {
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const wrap = (target: PaneNode): PaneSplit => ({
    type: "split",
    id: crypto.randomUUID(),
    dir,
    children: before ? [leaf, target] : [target, leaf],
    sizes: [0.5, 0.5],
  });

  if (node.type === "leaf") return node.id === targetId ? wrap(node) : null;

  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx !== -1) {
    if (node.dir === dir) {
      const at = before ? idx : idx + 1;
      const children = [...node.children.slice(0, at), leaf, ...node.children.slice(at)];
      const sizes = [...node.sizes];
      sizes.splice(idx, 1, node.sizes[idx] / 2, node.sizes[idx] / 2);
      return { ...node, children, sizes };
    }
    const children = [...node.children];
    children[idx] = wrap(node.children[idx]);
    return { ...node, children };
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== "split") continue;
    const result = insertBeside(child, targetId, leaf, edge);
    if (result) {
      const children = [...node.children];
      children[i] = result;
      return { ...node, children };
    }
  }
  return null;
}

// Adds `leaf` as a new rightmost column of a tab's tree, keeping whatever is
// already there (including an empty pane).
export function appendLeaf(node: PaneNode, leaf: PaneLeaf): PaneNode {
  if (node.type === "leaf") {
    return { type: "split", id: crypto.randomUUID(), dir: "row", children: [node, leaf], sizes: [0.5, 0.5] };
  }
  if (node.dir === "row") {
    const n = node.children.length;
    return {
      ...node,
      children: [...node.children, leaf],
      sizes: [...node.sizes.map((s) => (s * n) / (n + 1)), 1 / (n + 1)],
    };
  }
  return { type: "split", id: crypto.randomUUID(), dir: "row", children: [node, leaf], sizes: [0.5, 0.5] };
}
