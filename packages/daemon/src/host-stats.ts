import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";

export interface HostStats {
  platform: string;
  cpus: number;
  load1: number;
  load5: number;
  memTotalBytes: number;
  memAvailableBytes: number;
}

// os.freemem() is the wrong number on both platforms we care about: on Linux
// it ignores reclaimable page cache, and on macOS "free" is near zero by
// design while inactive/speculative pages are effectively available.
function availableMemory(): number {
  try {
    if (platform() === "linux") {
      const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
      if (match) return Number(match[1]) * 1024;
    } else if (platform() === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
      const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
      const pages = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
      return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * pageSize;
    }
  } catch {
    // fall through to the generic number
  }
  return freemem();
}

export function hostStats(): HostStats {
  const [load1, load5] = loadavg();
  return {
    platform: platform(),
    cpus: cpus().length,
    load1,
    load5,
    memTotalBytes: totalmem(),
    memAvailableBytes: availableMemory(),
  };
}

export interface TreeUsage {
  rssBytes: number;
  cpuPercent: number;
}

// Sums RSS and %CPU over each root's whole descendant tree. Walking ppid
// links rather than grouping by session/process group, because agents and
// the shells they start freely create new process groups for subprocesses.
export function processTreeUsage(rootPids: number[]): Map<number, TreeUsage> {
  const result = new Map<number, TreeUsage>();
  if (rootPids.length === 0) return result;

  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8", timeout: 3000 });
  } catch {
    return result;
  }

  const children = new Map<number, number[]>();
  const usage = new Map<number, TreeUsage>();
  for (const line of out.split("\n")) {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    usage.set(pid, { rssBytes: (rss || 0) * 1024, cpuPercent: cpu || 0 });
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }

  for (const root of rootPids) {
    if (!usage.has(root)) continue;
    const total: TreeUsage = { rssBytes: 0, cpuPercent: 0 };
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const own = usage.get(pid);
      if (own) {
        total.rssBytes += own.rssBytes;
        total.cpuPercent += own.cpuPercent;
      }
      stack.push(...(children.get(pid) ?? []));
    }
    result.set(root, total);
  }
  return result;
}
