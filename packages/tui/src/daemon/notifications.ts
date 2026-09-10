import { callDaemon } from "./client.js";
import type { Notification } from "./types.js";

export const fetchNotifications = (unacknowledgedOnly: boolean) =>
  callDaemon<Notification[]>("GET", `/notifications${unacknowledgedOnly ? "?unacknowledged=true" : ""}`);
export const acknowledgeNotification = (id: number) =>
  callDaemon<Notification>("POST", `/notifications/${id}/ack`);
