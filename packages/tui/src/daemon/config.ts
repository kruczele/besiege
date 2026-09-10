import { callDaemon } from "./client.js";
import type { ConfigRule } from "./types.js";

export const fetchConfigRules = () => callDaemon<ConfigRule[]>("GET", "/config/rules");
export const createConfigRule = (pattern: string, context: string, besiegeOnly?: boolean) =>
  callDaemon<ConfigRule>("POST", "/config/rules", { pattern, context, besiege_only: besiegeOnly });
export const updateConfigRule = (
  id: number,
  fields: Partial<{ pattern: string; context: string; besiege_only: boolean }>,
) => callDaemon<ConfigRule>("PATCH", `/config/rules/${id}`, fields);
export const deleteConfigRule = (id: number) => callDaemon<void>("DELETE", `/config/rules/${id}`);
