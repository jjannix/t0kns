import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started. */
  error?: NodeJS.ErrnoException;
}

export interface ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves once the process has exited or failed to start. Never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Closes stdin, waits briefly for a graceful exit, then terminates the process tree. */
  terminate(): Promise<void>;
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long to wait for a graceful exit after stdin closes. */
  gracePeriodMs?: number;
}

const KILL_WAIT_MS = 2_000;

/**
 * Spawns `command` with an argument array and no shell. Cleanup uses `taskkill /T`, which reaches helpers the
 * child starts. Only the tree rooted at the spawned process is touched, never other running CLI sessions.
 */
export function spawnManaged(command: string, args: string[], options: SpawnOptions = {}): ManagedProcess {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

  // A child that exits mid-write raises EPIPE on its streams; failures surface through `exited` instead.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on("error", () => undefined);
  }

  let spawnFailed = false;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    // `on`, not `once`: a failed kill also emits "error", and an unhandled second event would throw.
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) {
        spawnFailed = true;
        resolve({ code: null, signal: null, error });
      }
    });
  });

  const hasExited = () => spawnFailed || child.exitCode !== null || child.signalCode !== null;

  // Helpers a gracefully exiting child leaves behind aren't swept: after exit, a reused PID could belong
  // to anything.
  let termination: Promise<void> | undefined;
  const terminate = () => {
    termination ??= (async () => {
      if (hasExited()) {
        return;
      }
      child.stdin.end();
      if (await settlesWithin(exited, options.gracePeriodMs ?? 1_500)) {
        return;
      }
      await killTree(child);
      await settlesWithin(exited, KILL_WAIT_MS);
    })();
    return termination;
  };

  return { child, exited, terminate };
}

/** Force-ends the child and everything it started, falling back to the child alone if taskkill fails. */
async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const taskkill = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  const done = new Promise<void>((resolve) => {
    taskkill.once("exit", () => resolve());
    taskkill.once("error", () => resolve());
  });
  if (!(await settlesWithin(done, KILL_WAIT_MS))) {
    taskkill.kill();
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
