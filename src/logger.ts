import * as fs from 'fs';
import * as fancyLog from 'fancy-log';

const debugFile = './config/debug.log';

/** Lazily reads log_level from config.yaml directly (avoids circular dep via cache). */
let cachedLogLevel: string | undefined;
function getLogLevel(): string {
  if (cachedLogLevel !== undefined) return cachedLogLevel;
  try {
    const YAML = require('yaml');
    const content = fs.readFileSync('./config/config.yaml', 'utf8');
    const parsed = YAML.parse(content);
    cachedLogLevel = (parsed.log_level as string) || 'NONE';
  } catch (_e) {
    cachedLogLevel = 'NONE';
  }
  return cachedLogLevel;
}

function ts(): string {
  return new Date().toISOString();
}

function redact(value: string): string {
  return value
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '<REDACTED_TELEGRAM_TOKEN>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer <REDACTED>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, '<REDACTED_API_KEY>');
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return redact(arg);
  if (arg instanceof Error) return redact(`${arg.name}: ${arg.message}`);
  if (arg === null || arg === undefined) return String(arg);
  return '[object]';
}

function appendToFile(msg: string, level: 'info' | 'error'): void {
  const lvl = getLogLevel();
  if (lvl === 'NONE') return;
  if (lvl === 'ERROR' && level === 'info') return;

  try {
    fs.appendFileSync(debugFile, `[${ts()}] ${msg}\n`, 'utf8');
  } catch (_e) {
    // Ignore file write errors; logging must never crash the bot.
  }
}

function info(...args: unknown[]): void {
  if (getLogLevel() !== 'INFO') return;
  const safeArgs = args.map(formatArg);
  appendToFile(safeArgs.join(' '), 'info');
  fancyLog.info(...safeArgs);
}

function error(...args: unknown[]): void {
  if (getLogLevel() === 'NONE') return;
  const safeArgs = args.map(formatArg);
  appendToFile(safeArgs.join(' '), 'error');
  fancyLog.error(...safeArgs);
}

export { info, error };
