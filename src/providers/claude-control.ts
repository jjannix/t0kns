import { Readable, Writable } from "node:stream";
import { RpcClosedError, RpcProtocolError, RpcTimeoutError } from "./codex-rpc";
import { isRecord } from "./probe-support";

/** Claude Code answered a control request with an error. */
export class ControlResponseError extends Error {
  constructor(
    readonly subtype: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlResponseError";
  }
}

export interface ControlClientOptions {
  /** Maximum length of one buffered line, in UTF-16 code units. */
  maxLineLength?: number;
}

interface PendingRequest {
  subtype: string;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

/**
 * The control protocol Claude Code speaks on stdin/stdout with `--input-format stream-json`, as used by the
 * Claude Agent SDK: newline-delimited JSON in which each `control_request` is answered by a `control_response`
 * carrying the same `request_id`. Other output (keep-alives, system events) is ignored, requests from the CLI
 * are declined because t0kns never starts a turn, and unterminated output is bounded.
 */
export class ClaudeControlClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly maxLineLength: number;
  private buffer = "";
  private nextId = 1;
  private closedError?: Error;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: ControlClientOptions = {},
  ) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    input.setEncoding("utf8");
    input.on("data", this.handleData);
    input.once("end", () => this.close(new RpcClosedError("Claude Code closed its output")));
    input.once("error", (error) => this.close(new RpcClosedError("Claude Code output failed", { cause: error })));
    output.once("error", (error) => this.close(new RpcClosedError("Claude Code input failed", { cause: error })));
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  /** Sends `{ subtype, ...params }` and resolves with the success response's payload. */
  request(
    subtype: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }

    const id = `t0kns-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(() => reject(new RpcTimeoutError(subtype, options.timeoutMs))),
        options.timeoutMs,
      );
      const onAbort = () => settle(() => reject(options.signal?.reason));
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        finish();
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        subtype,
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      });
      this.write({ request_id: id, type: "control_request", request: { ...params, subtype } });
    });
  }

  /** Rejects every pending request and stops processing input. Safe to call repeatedly. */
  close(reason: Error = new RpcClosedError()): void {
    if (this.closedError) {
      return;
    }
    this.closedError = reason;
    this.buffer = "";
    this.input.off("data", this.handleData);
    for (const request of [...this.pending.values()]) {
      request.reject(reason);
    }
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private readonly handleData = (chunk: string) => {
    this.buffer += chunk;
    let newline: number;
    while (!this.closedError && (newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
    }
    if (!this.closedError && this.buffer.length > this.maxLineLength) {
      this.close(new RpcProtocolError(`Claude Code sent a line longer than ${this.maxLineLength} characters`));
    }
  };

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.length > this.maxLineLength) {
      this.close(new RpcProtocolError(`Claude Code sent a line longer than ${this.maxLineLength} characters`));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not protocol output. A response we need would time out rather than be misattributed.
      return;
    }
    if (!isRecord(message)) {
      return;
    }

    if (message.type === "control_request") {
      if (typeof message.request_id === "string") {
        // t0kns registers no tools, hooks, or MCP servers, so it has nothing to answer. Decline instead of
        // leaving the CLI waiting.
        this.write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: message.request_id,
            error: "t0kns does not handle control requests",
          },
        });
      }
      return;
    }

    if (message.type !== "control_response" || !isRecord(message.response)) {
      return;
    }
    const response = message.response;
    const request = typeof response.request_id === "string" ? this.pending.get(response.request_id) : undefined;
    if (!request) {
      return;
    }
    if (response.subtype === "success") {
      request.resolve(response.response);
    } else if (response.subtype === "error") {
      const errorMessage = typeof response.error === "string" && response.error ? response.error : "Unknown error";
      request.reject(new ControlResponseError(request.subtype, errorMessage));
    }
  }
}
