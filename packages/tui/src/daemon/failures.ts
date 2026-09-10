import { callDaemon } from "./client.js";
import type { FailureSignature } from "./types.js";

export const fetchFailures = (campaignId: number) =>
  callDaemon<FailureSignature[]>("GET", `/campaigns/${campaignId}/failures`);
export const lookupFailure = (campaignId: number, signature: string) =>
  callDaemon<FailureSignature | null>(
    "GET",
    `/campaigns/${campaignId}/failures?signature=${encodeURIComponent(signature)}`,
  );
export const upsertFailure = (campaignId: number, signature: string, fixContext: string) =>
  callDaemon<FailureSignature>("POST", `/campaigns/${campaignId}/failures`, {
    signature,
    fix_context: fixContext,
  });
export const deleteFailure = (campaignId: number, id: number) =>
  callDaemon<void>("DELETE", `/campaigns/${campaignId}/failures/${id}`);
