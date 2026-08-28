// besiege CLI — operator dispatch tool.
// Usage: besiege dispatch <campaign-id> <step-id> <repo> [--cwd <dir>] [--note <text>] [-- <claude args>...]
//
// Claims a PR in the daemon, spawns `claude` in the target directory with the
// besiege MCP server wired in, heartbeats the claim every 30 s while claude
// runs, and releases on exit (normal or signal).
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getJson, postJson, deleteJson } from "./hooks/client.js";
import { stripInheritedAgentEnv } from "./env.js";

interface CampaignRepo {
  id: number;
  campaignId: number;
  githubFullName: string;
  createdAt: string;
}

interface Pr {
  id: number;
  stepId: number;
  repoId: number;
  lifecycle: string;
}

interface Claim {
  id: number;
  agentId: string;
  sessionId: string;
  note: string | null;
  claimedAt: string;
  heartbeatAt: string;
}

function printUsage() {
  process.stderr.write(
    "Usage: besiege dispatch <campaign-id> <step-id> <repo> [--cwd <dir>] [--note <text>] [-- <claude args>...]\n",
  );
}

function parseArgs(argv: string[]): {
  campaignId: string;
  stepId: string;
  repo: string;
  cwd: string;
  note: string | undefined;
  claudeArgs: string[];
} {
  const args = argv.slice(2);

  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }
  if (command !== "dispatch") {
    process.stderr.write(`besiege: unknown command '${command}'\n`);
    printUsage();
    process.exit(1);
  }

  const separatorIdx = args.indexOf("--");
  const claudeArgs = separatorIdx >= 0 ? args.slice(separatorIdx + 1) : [];
  const rest = separatorIdx >= 0 ? args.slice(1, separatorIdx) : args.slice(1);

  const positionals: string[] = [];
  let cwd = process.cwd();
  let note: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    if ((rest[i] === "--cwd" || rest[i] === "-C") && i + 1 < rest.length) {
      cwd = rest[++i];
    } else if (rest[i] === "--note" && i + 1 < rest.length) {
      note = rest[++i];
    } else if (!rest[i].startsWith("-")) {
      positionals.push(rest[i]);
    } else {
      process.stderr.write(`besiege: unknown flag '${rest[i]}'\n`);
      printUsage();
      process.exit(1);
    }
  }

  if (positionals.length < 3) {
    process.stderr.write("besiege: dispatch requires <campaign-id> <step-id> <repo>\n");
    printUsage();
    process.exit(1);
  }

  return {
    campaignId: positionals[0],
    stepId: positionals[1],
    repo: positionals[2],
    cwd: resolve(cwd),
    note,
    claudeArgs,
  };
}

async function dispatch(opts: {
  campaignId: string;
  stepId: string;
  repo: string;
  cwd: string;
  note: string | undefined;
  claudeArgs: string[];
}) {
  const { campaignId, stepId, repo, cwd, note, claudeArgs } = opts;

  // 1. Look up the campaign_repo record by name, registering it into the
  // campaign on the fly if this is the first time it's been dispatched —
  // requiring it to be pre-registered would defeat the point of a campaign
  // spanning however many repos turn out to need one.
  const repos = await getJson<CampaignRepo[]>(
    `/campaigns/${campaignId}/repos?name=${encodeURIComponent(repo)}`,
  ).catch(() => null);

  const repoRecord =
    repos?.[0] ??
    (await postJson<CampaignRepo>(`/campaigns/${campaignId}/repos`, { github_full_name: repo }).catch(
      (err: Error) => {
        process.stderr.write(`besiege: failed to register repo '${repo}' — ${err.message}\n`);
        process.exit(1);
      },
    ));

  // 2. Upsert PR record for (step, repo) — idempotent.
  const pr = await postJson<Pr>("/prs", {
    step_id: Number(stepId),
    repo_id: repoRecord.id,
  }).catch((err: Error) => {
    process.stderr.write(`besiege: failed to register PR — ${err.message}\n`);
    process.exit(1);
  });

  // 3. Check for existing claim (advisory warning).
  const existing = await getJson<Claim>(`/prs/${pr.id}/claim`).catch(() => null);
  if (existing) {
    process.stderr.write(
      `besiege: ⚠  PR ${pr.id} (${repo}) is already claimed by ${existing.agentId} ` +
        `(since ${existing.claimedAt}).\n` +
        `  Proceeding anyway — claim is advisory.\n`,
    );
  }

  // 4. Claim the PR.
  const agentId = `${hostname()}:${process.pid}`;
  const sessionId = randomUUID();

  await postJson<Claim>(`/prs/${pr.id}/claim`, {
    agent_id: agentId,
    session_id: sessionId,
    note: note ?? `dispatch from ${cwd}`,
  }).catch((err: Error) => {
    process.stderr.write(`besiege: failed to claim PR — ${err.message}\n`);
    process.exit(1);
  });

  process.stderr.write(
    `besiege: claimed PR ${pr.id} · ${repo} · step ${stepId} · agent ${agentId}\n`,
  );

  // 5. Spawn claude.
  const child = spawn("claude", claudeArgs, {
    cwd,
    stdio: "inherit",
    env: {
      ...stripInheritedAgentEnv(process.env),
      // Propagate campaign/step/PR context so the SessionStart hook and MCP
      // tools have it available without needing flags on every call.
      BESIEGE_CAMPAIGN_ID: campaignId,
      BESIEGE_STEP_ID: stepId,
      BESIEGE_PR_ID: String(pr.id),
      BESIEGE_REPO: repo,
      BESIEGE_SESSION_ID: sessionId,
    },
  });

  // 6. Heartbeat every 30 s while claude runs.
  const heartbeatInterval = setInterval(() => {
    postJson(`/prs/${pr.id}/claim/heartbeat`, {}).catch(() => {
      // Best-effort; daemon might be temporarily unreachable.
    });
  }, 30_000);

  let released = false;

  async function release() {
    if (released) return;
    released = true;
    clearInterval(heartbeatInterval);
    await deleteJson(`/prs/${pr.id}/claim`).catch(() => {
      // Already expired or released — not an error.
    });
    process.stderr.write(`besiege: released claim on PR ${pr.id}\n`);
  }

  // 7. Forward signals to child, then release on exit.
  const forwardSignal = (sig: NodeJS.Signals) => {
    child.kill(sig);
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      const desc = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
      process.stderr.write(`besiege: claude exited (${desc})\n`);
      resolve();
    });
    child.on("error", (err) => {
      process.stderr.write(`besiege: failed to spawn claude — ${err.message}\n`);
      process.stderr.write("  Is 'claude' on your PATH? Install Claude Code: https://claude.ai/code\n");
      resolve();
    });
  });

  await release();
}

const opts = parseArgs(process.argv);
dispatch(opts).catch((err) => {
  process.stderr.write(`besiege: unexpected error — ${err}\n`);
  process.exit(1);
});
