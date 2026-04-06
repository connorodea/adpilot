import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR = path.join(os.homedir(), '.adpilot', 'logs');

export interface LogEntry {
  timestamp: string;
  method: string;
  endpoint: string;
  params?: Record<string, any>;
  status: 'success' | 'error';
  responseId?: string;
  error?: string;
  durationMs: number;
}

/**
 * Ensure the log directory exists.
 */
export function initLogger(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Returns the log file path for a given date (YYYY-MM-DD).
 * Defaults to today.
 */
function logFilePath(date?: string): string {
  const d = date || new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${d}.jsonl`);
}

/**
 * Append a JSON line to today's log file.
 */
export function logApiCall(entry: LogEntry): void {
  try {
    initLogger();
    const filePath = logFilePath();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch {
    // Logging should never crash the CLI
  }
}

/**
 * Read entries from a specific date's log file.
 */
export function getLogEntries(date?: string): LogEntry[] {
  const filePath = logFilePath(date);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map((line) => JSON.parse(line) as LogEntry);
}

/**
 * List available log files (sorted, newest first).
 */
export function getLogFiles(): string[] {
  initLogger();
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();
}

/**
 * Delete a specific log file.
 */
export function deleteLogFile(filename: string): void {
  const filePath = path.join(LOG_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Delete all log files, or those before a specific date.
 */
export function clearLogs(options: { before?: string; all?: boolean }): number {
  const files = getLogFiles();
  let deleted = 0;
  for (const file of files) {
    const fileDate = file.replace('.jsonl', '');
    if (options.all || (options.before && fileDate < options.before)) {
      deleteLogFile(file);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Check if logging is enabled via env var or config.
 */
export function isLoggingEnabled(): boolean {
  if (process.env.ADPILOT_LOG === 'true') return true;
  // Check config store — import lazily to avoid circular deps
  try {
    const { config } = require('./config');
    return config.get('enableLogging') === true;
  } catch {
    return false;
  }
}

/**
 * Sanitize params to never include access tokens.
 */
export function sanitizeParams(params: Record<string, any>): Record<string, any> {
  const sanitized = { ...params };
  delete sanitized.access_token;
  return sanitized;
}
