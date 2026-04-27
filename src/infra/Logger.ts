import { ArchivistError } from '../model/Errors';

// Gated logger. Path-like fields are redacted by default; users must opt in
// via Advanced → diagnostic_logging before paths appear in logs (SDD
// Cross-Cutting/Logging + ADR-7 disclosure gate).

export interface LogPayload {
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  error(message: string, payload?: LogPayload): void;
  /** Diagnostic-only. Suppressed entirely unless diagnostic_logging is enabled. */
  debug(message: string, payload?: LogPayload): void;
}

// Keys whose values are assumed to be vault paths. Redacted to
// `<dir>/<redacted>` so operators can still see where in the tree the event
// occurred without leaking note names. Exact-match only; callers that want
// path redaction should use one of these keys.
const PATH_KEYS: ReadonlySet<string> = new Set([
  'path',
  'prev_path',
  'from',
  'to',
  'vault_path',
  'file',
  'filename',
  'dir',
]);

function redactPath(p: unknown): unknown {
  if (typeof p !== 'string') return p;
  if (p.length === 0) return p;
  const idx = p.lastIndexOf('/');
  if (idx === -1) return '<redacted>';
  return `${p.slice(0, idx)}/<redacted>`;
}

function redactPayload(payload: LogPayload | undefined): LogPayload | undefined {
  if (!payload) return payload;
  const out: LogPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    if (PATH_KEYS.has(k)) {
      if (Array.isArray(v)) {
        out[k] = v.map(redactPath);
      } else {
        out[k] = redactPath(v);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeError(payload: LogPayload | undefined): LogPayload | undefined {
  if (!payload) return payload;
  const err = payload.error;
  if (err instanceof ArchivistError) {
    return { ...payload, error: { name: err.name, code: err.code, message: err.message, retryable: err.retryable } };
  }
  if (err instanceof Error) {
    return { ...payload, error: { name: err.name, message: err.message } };
  }
  return payload;
}

export interface CreateLoggerOptions {
  sink?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createLogger(
  getDiagnosticFlag: () => boolean,
  options: CreateLoggerOptions = {},
): Logger {
  const sink = options.sink ?? console;
  const emit = (level: 'log' | 'warn' | 'error', message: string, payload?: LogPayload): void => {
    const diagnostic = getDiagnosticFlag();
    const normalized = normalizeError(payload);
    const redacted = diagnostic ? normalized : redactPayload(normalized);
    if (redacted === undefined) {
      sink[level](`[archivist] ${message}`);
    } else {
      sink[level](`[archivist] ${message}`, redacted);
    }
  };

  return {
    info: (m, p) => emit('log', m, p),
    warn: (m, p) => emit('warn', m, p),
    error: (m, p) => emit('error', m, p),
    debug: (m, p) => {
      if (!getDiagnosticFlag()) return;
      emit('log', m, p);
    },
  };
}
