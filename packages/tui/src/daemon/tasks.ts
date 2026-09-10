import { callDaemon } from "./client.js";
import type { TaskDefinition } from "./types.js";

export const fetchTasks = (campaignId: number, stepId: number) =>
  callDaemon<TaskDefinition[]>("GET", `/campaigns/${campaignId}/steps/${stepId}/tasks`);
export const createTask = (campaignId: number, stepId: number, name: string, context: string) =>
  callDaemon<TaskDefinition>("POST", `/campaigns/${campaignId}/steps/${stepId}/tasks`, { name, context });
export const retireTask = (campaignId: number, stepId: number, taskId: number) =>
  callDaemon<TaskDefinition>("POST", `/campaigns/${campaignId}/steps/${stepId}/tasks/${taskId}/retire`);
