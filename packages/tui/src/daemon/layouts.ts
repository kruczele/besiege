import { callDaemon } from "./client.js";
import type { TerminalLayout } from "./types.js";
import type { PaneNode } from "daemon/layout-tree.js";

export const fetchLayouts = (campaignId: number) =>
  callDaemon<TerminalLayout[]>("GET", `/campaigns/${campaignId}/layouts`);
export const createLayout = (campaignId: number, name: string, tree: PaneNode) =>
  callDaemon<TerminalLayout>("POST", `/campaigns/${campaignId}/layouts`, { name, tree });
export const updateLayout = (
  id: number,
  fields: Partial<{ name: string; isNameCustom: boolean; tree: PaneNode }>,
) => callDaemon<TerminalLayout>("PATCH", `/layouts/${id}`, fields);
export const deleteLayout = (id: number) => callDaemon<void>("DELETE", `/layouts/${id}`);
