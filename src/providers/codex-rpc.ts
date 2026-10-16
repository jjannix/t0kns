import { Readable, Writable } from "node:stream";

/** The server answered a request with a JSON-RPC error object. */
export class RpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcResponseError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} did not respond within ${timeoutMs} ms`);
    this.name = "RpcTimeoutError";
  }
}

/** The connection closed (or was closed) before a response arrived. */
export class RpcClosedError extends Error {
  constructor(message = "Connection closed", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RpcClosedError";
  }
}

/** The peer violated the line protocol, e.g. by exceeding the line-length cap. */
export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export interface RpcClientOptions {
  /** Maximum length of one buffered line, in UTF-16 code units. */
  maxLineLength?: number;
  onNotification?: (method: string, params: unknown) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;
const METHOD_NOT_FOUND = -32601;

/**
 * JSON-RPC over newline-delimited JSON, as spoken by `codex app-server`. Correlates responses by id,
 * tolerates partial lines and unrelated notifications, declines server-initiated requests, and bounds
 * how much unterminated output it buffers.
 */
export class JsonRpcLineClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly maxLineLength: number;
  private readonly onNotification?: (method: string, params: unknown) => void;
  private buffer = "";
  private nextId = 1;
  private closedError?: Error;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: RpcClientOptions = {},
  ) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.onNotification = options.onNotification;
    input.setEncoding("utf8");
    input.on("data", this.handleData);
    input.once("end", () => this.close(new RpcClosedError("Server closed its output")));
    input.once("error", (error) => this.close(new RpcClosedError("Server output failed", { cause: error })));
    output.once("error", (error) => this.close(new RpcClosedError("Server input failed", { cause: error })));
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  request(method: string, params: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(() => reject(new RpcTimeoutError(method, options.timeoutMs))),
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
        method,
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closedError) {
      this.write(params === undefined ? { method } : { method, params });
    }
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
      this.close(new RpcProtocolError(`Server sent a line longer than ${this.maxLineLength} characters`));
    }
  };

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.length > this.maxLineLength) {
      this.close(new RpcProtocolError(`Server sent a line longer than ${this.maxLineLength} characters`));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not protocol output. A response we need would time out rather than be misattributed.
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return;
    }

    const record = message as Record<string, unknown>;
    const id = record.id;
    const hasId = typeof id === "number" || typeof id === "string";

    if (typeof record.method === "string") {
      if (hasId) {
        // t0kns never starts turns, so it has nothing to approve or answer. Decline instead of hanging the server.
        this.write({ id, error: { code: METHOD_NOT_FOUND, message: "t0kns does not handle server requests" } });
      } else {
        this.onNotification?.(record.method, record.params);
      }
      return;
    }

    if (typeof id !== "number") {
      return;
    }
    const request = this.pending.get(id);
    if (!request) {
      return;
    }
    if ("error" in record) {
      const error = record.error as Record<string, unknown> | null;
      const code = typeof error?.code === "number" ? error.code : 0;
      const errorMessage = typeof error?.message === "string" ? error.message : "Unknown error";
      request.reject(new RpcResponseError(request.method, code, errorMessage));
    } else if ("result" in record) {
      request.resolve(record.result);
    }
  }
}
