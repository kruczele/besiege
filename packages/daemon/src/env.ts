// Split out from terminals.ts so cli.ts (a lightweight dispatcher) doesn't
// have to pull in node-pty just for this.
//
// Both the daemon and `besiege dispatch` are very likely themselves running
// inside a Claude Code session (e.g. started from a Claude Code terminal),
// which means process.env carries that *parent* session's own identity —
// CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, etc. Left
// alone, every spawned pty/child process inherits them, and a freshly
// launched `claude` inside one sees CLAUDE_CODE_CHILD_SESSION=1 and
// concludes it's a nested child of that parent session (disabling
// transcript saving, among other behavior changes) instead of an
// independent top-level one.
export function stripInheritedAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|AI_AGENT)/i.test(key)));
}
