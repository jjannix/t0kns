export type QuotaErrorKind =
  | "cli-missing"
  | "invalid-config"
  | "signed-out"
  | "unsupported-auth"
  | "unsupported-version"
  | "rate-limited"
  | "timeout"
  | "cancelled"
  | "malformed-response"
  | "unavailable";

export interface QuotaFailure {
  kind: QuotaErrorKind;
  /** Short technical summary. Must not contain credentials or account identifiers. */
  message: string;
  /** Extra context shown in the UI only; never cached or copied into diagnostics. */
  detail?: string;
  /** Allowlisted machine-readable code for diagnostics, e.g. `rpc:-32600` or `exit:1`. */
  code?: string;
  /** Epoch milliseconds before which the provider should not be asked again. */
  retryAfter?: number;
}

export class QuotaError extends Error {
  readonly kind: QuotaErrorKind;
  readonly detail?: string;
  readonly code?: string;
  readonly retryAfter?: number;

  constructor(
    kind: QuotaErrorKind,
    message: string,
    options: { detail?: string; code?: string; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "QuotaError";
    this.kind = kind;
    this.detail = options.detail;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }

  toFailure(): QuotaFailure {
    return {
      kind: this.kind,
      message: this.message,
      detail: this.detail,
      code: this.code,
      retryAfter: this.retryAfter,
    };
  }
}

export function toQuotaFailure(error: unknown): QuotaFailure {
  if (error instanceof QuotaError) {
    return error.toFailure();
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "cancelled", message: "The request was cancelled." };
  }
  return {
    kind: "unavailable",
    message: "Unexpected error while reading limits.",
    detail: error instanceof Error ? error.message : undefined,
  };
}
