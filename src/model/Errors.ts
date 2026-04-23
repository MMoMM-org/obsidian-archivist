// ArchivistError hierarchy — split per ROB-005.
// Each subclass represents a recovery strategy, not just a category of message.
// Historical note: IntegrityError was the original super-class for all of
// Corruption / Chain / Conflict. Post-review split because each requires a
// distinct recovery path: Corruption → treat-as-absent or user-visible hard
// error; Chain → history-warning, no-delete; Conflict → user must toggle device.

export class ArchivistError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ArchivistError {}
export class NetworkError extends ArchivistError {}

export class RateLimitError extends ArchivistError {
  constructor(
    code: string,
    message: string,
    public readonly retryAfterSeconds: number,
    cause?: unknown,
  ) {
    super(code, message, true, cause);
  }
}

export class QuotaExceededError extends ArchivistError {}
export class PathError extends ArchivistError {}
export class CorruptionError extends ArchivistError {}
export class ChainError extends ArchivistError {}
export class ConflictError extends ArchivistError {}
export class ConfigError extends ArchivistError {}

// Small helper used by parseX guards throughout the model package.
// The field-path is surfaced in the message so operators can locate the bad field.
export function configInvalid(path: string, reason: string): ConfigError {
  return new ConfigError('SCHEMA_INVALID', `${path}: ${reason}`, false);
}
