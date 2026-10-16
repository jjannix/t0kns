import { open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { QuotaError } from "../quota/errors";

export interface ResolvedExecutable {
  /** Absolute path of the binary to spawn. Never a shell command line. */
  command: string;
  /** How the binary was located, for diagnostics. */
  origin: "preference" | "search";
  /** `npm-package` when a JavaScript launcher was resolved to its bundled native binary. */
  kind: "native" | "npm-package";
}

export interface ResolveOptions {
  /** Optional user-configured path from preferences. */
  override?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** The machine being searched. t0kns runs on Windows only. */
interface Target {
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

/** What differs between the CLIs t0kns starts. */
interface CliSpec {
  /** Product name used in messages. */
  name: string;
  /** Title of the preference that overrides the search. */
  preference: string;
  /** Executable name without extension. */
  binary: string;
  /**
   * Resolves a Node launcher script to the native binary it starts. Without it, a launcher is reported as
   * unusable, because `node` is often missing from a GUI app's PATH.
   */
  binaryForLauncher?: (script: string, target: Target) => Promise<string>;
}

const CODEX_PACKAGE = "@openai/codex";
const MAX_SHIM_BYTES = 64 * 1024;
const LAUNCHER_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/** Target triples of the native binaries in Codex's Windows npm platform packages, by architecture. */
const WINDOWS_TRIPLES: Record<string, string> = {
  arm64: "aarch64-pc-windows-msvc",
  x64: "x86_64-pc-windows-msvc",
};

const CODEX: CliSpec = {
  name: "Codex",
  preference: "Codex Executable",
  binary: "codex",
  binaryForLauncher: codexBinaryForLauncher,
};

/** Claude Code's native installer and current npm packages both provide a native binary. */
const CLAUDE: CliSpec = { name: "Claude Code", preference: "Claude Executable", binary: "claude" };

class UnusableCandidate extends Error {}

export function resolveCodexExecutable(options: ResolveOptions = {}): Promise<ResolvedExecutable> {
  return resolveExecutable(CODEX, options);
}

export function resolveClaudeExecutable(options: ResolveOptions = {}): Promise<ResolvedExecutable> {
  return resolveExecutable(CLAUDE, options);
}

async function resolveExecutable(spec: CliSpec, options: ResolveOptions): Promise<ResolvedExecutable> {
  const target: Target = {
    arch: options.arch ?? process.arch,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  };

  const override = options.override ? normalizeUserPath(options.override, target.homeDir) : undefined;
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new QuotaError("invalid-config", `The ${spec.name} executable path must be absolute.`);
    }
    if (!(await isFile(override))) {
      throw new QuotaError("cli-missing", `No file exists at the configured ${spec.name} executable path.`, {
        code: "path:not-found",
      });
    }
    try {
      return { ...(await inspectCandidate(spec, override, target)), origin: "preference" };
    } catch (error) {
      if (error instanceof UnusableCandidate) {
        throw new QuotaError("invalid-config", error.message, { code: "path:unusable" });
      }
      throw error;
    }
  }

  let firstProblem: string | undefined;
  for (const candidate of await searchCandidates(spec, target)) {
    try {
      return { ...(await inspectCandidate(spec, candidate, target)), origin: "search" };
    } catch (error) {
      if (!(error instanceof UnusableCandidate)) {
        throw error;
      }
      firstProblem ??= error.message;
    }
  }

  throw new QuotaError(
    "cli-missing",
    firstProblem ?? `${spec.name} CLI was not found in PATH or common install locations.`,
    {
      code: firstProblem ? "search:unusable" : "search:not-found",
    },
  );
}

/** Expands `~`, strips surrounding quotes from pasted paths, and returns undefined for blank input. */
export function normalizeUserPath(value: string, homeDir: string = homedir()): string | undefined {
  let trimmed = value.trim();
  if (trimmed.length >= 2 && /^(["']).*\1$/.test(trimmed)) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

async function inspectCandidate(
  spec: CliSpec,
  file: string,
  target: Target,
): Promise<Omit<ResolvedExecutable, "origin">> {
  const resolved = await realpath(file);
  const extension = path.extname(resolved).toLowerCase();

  if (LAUNCHER_EXTENSIONS.has(extension)) {
    return fromLauncher(spec, resolved, target);
  }

  if (extension === ".cmd" || extension === ".bat") {
    const launched = await targetFromCmdShim(spec, resolved);
    if (LAUNCHER_EXTENSIONS.has(path.extname(launched).toLowerCase())) {
      return fromLauncher(spec, launched, target);
    }
    if (!(await isFile(launched))) {
      throw new UnusableCandidate(
        `Found ${path.basename(resolved)}, but the ${spec.name} binary it launches is missing. Reinstall ${spec.name}, or set the ${spec.preference} preference to ${spec.binary}.exe.`,
      );
    }
    return { command: launched, kind: "native" };
  }
  if (extension !== ".exe") {
    throw new UnusableCandidate(
      `Found ${path.basename(resolved)}, which t0kns can't run directly. Set the ${spec.preference} preference to ${spec.binary}.exe.`,
    );
  }
  return { command: resolved, kind: "native" };
}

async function fromLauncher(
  spec: CliSpec,
  script: string,
  target: Target,
): Promise<Omit<ResolvedExecutable, "origin">> {
  if (!spec.binaryForLauncher) {
    throw new UnusableCandidate(
      `${path.basename(script)} runs ${spec.name} through Node.js, which t0kns doesn't start. Update ${spec.name}, or set the ${spec.preference} preference to its native binary.`,
    );
  }
  return { command: await spec.binaryForLauncher(script, target), kind: "npm-package" };
}

/**
 * npm, pnpm, and bun install `@openai/codex` as a Node launcher (`bin/codex.js`) plus a platform package
 * containing the native binary. Spawning the binary directly avoids needing `node` on the GUI PATH and
 * lets t0kns terminate the process it started instead of a wrapper.
 */
async function codexBinaryForLauncher(script: string, target: Target): Promise<string> {
  const packageRoot = path.dirname(path.dirname(script));
  if ((await readPackageName(packageRoot)) !== CODEX_PACKAGE) {
    throw new UnusableCandidate(
      `${path.basename(script)} is not part of the ${CODEX_PACKAGE} package. Set the Codex Executable preference to the native codex binary.`,
    );
  }

  const arches = [target.arch, ...Object.keys(WINDOWS_TRIPLES).filter((arch) => arch !== target.arch)];

  for (const arch of arches) {
    const triple = WINDOWS_TRIPLES[arch];
    if (!triple) {
      continue;
    }
    const platformPackage = path.join("@openai", `codex-win32-${arch}`);
    const candidates = [
      ...nodeModulesLookupDirs(packageRoot).map((dir) => path.join(dir, platformPackage, "vendor", triple, "bin")),
      path.join(packageRoot, "vendor", triple, "bin"),
    ];
    for (const dir of candidates) {
      const binary = path.join(dir, "codex.exe");
      if (await isFile(binary)) {
        return binary;
      }
    }
  }

  throw new UnusableCandidate(
    "Codex is installed, but its native binary is missing. Reinstall Codex (for example `npm install -g @openai/codex`).",
  );
}

/** Mirrors Node's module lookup: `<dir>/node_modules` for the package root and each ancestor. */
function nodeModulesLookupDirs(start: string): string[] {
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      dirs.push(path.join(dir, "node_modules"));
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return dirs;
    }
    dir = parent;
  }
}

/**
 * Reads the program an npm/pnpm `cmd-shim` starts without executing it: a JavaScript entry point that the
 * shim runs with Node, or a native binary it runs directly.
 */
async function targetFromCmdShim(spec: CliSpec, shim: string): Promise<string> {
  const text = await readPrefix(shim, MAX_SHIM_BYTES);
  const targets = [
    ...Array.from(text.matchAll(/"%~?dp0%?\\([^"%]+?\.(?:js|exe))"/gi), (match) =>
      path.resolve(path.dirname(shim), match[1]),
    ),
    ...Array.from(text.matchAll(/"([a-z]:\\[^"%]+?\.(?:js|exe))"/gi), (match) => match[1]),
  ];
  // A shim that runs a script names `node.exe` too; the script, not Node, is what it launches.
  const target =
    targets.find((file) => /\.js$/i.test(file)) ??
    targets.find((file) => path.basename(file).toLowerCase() !== "node.exe");
  if (target) {
    return target;
  }
  throw new UnusableCandidate(
    `Found ${path.basename(shim)}, but couldn't locate the ${spec.name} binary it launches. Set the ${spec.preference} preference to ${spec.binary}.exe.`,
  );
}

async function searchCandidates(spec: CliSpec, target: Target): Promise<string[]> {
  const names = [`${spec.binary}.exe`, `${spec.binary}.cmd`];
  const candidates: string[] = [];
  for (const dir of searchDirectories(target)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (await isFile(file)) {
        candidates.push(file);
      }
    }
  }
  return candidates;
}

/** PATH first, then install locations a GUI app's PATH commonly lacks. */
function searchDirectories({ env, homeDir }: Target): string[] {
  const fromPath = (readEnv(env, "PATH") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir && path.isAbsolute(dir));

  const appData = readEnv(env, "APPDATA") ?? path.join(homeDir, "AppData", "Roaming");
  const localAppData = readEnv(env, "LOCALAPPDATA") ?? path.join(homeDir, "AppData", "Local");
  const known = [
    path.join(appData, "npm"),
    path.join(localAppData, "pnpm"),
    path.join(homeDir, ".bun", "bin"),
    path.join(localAppData, "Microsoft", "WinGet", "Links"),
    path.join(homeDir, "scoop", "shims"),
    path.join(localAppData, "Volta", "bin"),
    path.join(homeDir, ".local", "bin"),
  ];

  // Windows paths are case-insensitive.
  const seen = new Set<string>();
  return [...fromPath, ...known].filter((dir) => {
    const key = path.normalize(dir).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Windows environment keys are case-insensitive; a copied env object is not. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  const value = key ? env[key] : undefined;
  return value || undefined;
}

async function readPackageName(packageRoot: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && "name" in manifest && typeof manifest.name === "string"
      ? manifest.name
      : undefined;
  } catch {
    return undefined;
  }
}

async function readPrefix(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
