import { QuotaError } from "../quota/errors";
import { ProcessExit } from "../system/processes";

/** Reported to the CLIs t0kns starts so they can identify it. */
export const EXTENSION_VERSION = "0.1.0";

/** Keeps only the last `limit` characters of a stream, e.g. a CLI's stderr. */
export class BoundedTail {
  private value = "";

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.value = (this.value + chunk).slice(-this.limit);
  }

  text(): string {
    return this.value;
  }

  lastLine(): string | undefined {
    return this.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
  }
}

/** Maps a CLI that could not be started at all to a typed failure. */
export function spawnFailure(name: string, error: NodeJS.ErrnoException): QuotaError {
  const code = error.code;
  if (code === "ENOENT") {
    return new QuotaError("cli-missing", `The ${name} executable could not be found.`, { code: "spawn:ENOENT" });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new QuotaError("invalid-config", `The ${name} executable could not be started (permission denied).`, {
      code: `spawn:${code}`,
    });
  }
  return new QuotaError("unavailable", `The ${name} executable could not be started.`, {
    code: `spawn:${code ?? "unknown"}`,
  });
}

export function exitCode(exit: ProcessExit | undefined): string | number {
  return exit?.code ?? exit?.signal ?? "unknown";
}

export function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}
