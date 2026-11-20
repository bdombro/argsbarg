/*
Stable application-domain error shared by native transport encoders.
The core records app metadata and leaves protocol or process encoding to adapters.
*/

/** Optional stable fields carried by an {@link AppError}. */
interface AppErrorOptions {
  /** Stable application-facing error code. */
  code: string;
  /** Optional HTTP status for an HTTP encoder. */
  httpStatus?: number;
  /** Optional transport-safe details. */
  details?: unknown;
  /** Optional original cause. */
  cause?: unknown;
}

/** Domain error preserving stable application metadata and its original cause. */
export class AppError extends Error {
  /** Stable application-facing error code. */
  readonly code: string;
  /** Optional HTTP status for a native encoder. */
  readonly httpStatus?: number;
  /** Optional application details. */
  readonly details?: unknown;

  /** Creates an error without flattening its structured fields or cause. */
  constructor(
    /** Human-readable message. */
    message: string,
    /** Stable code and optional transport metadata. */
    options: AppErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
  }
}
