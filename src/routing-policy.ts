import type { BusinessHoursConfig } from './interfaces';
export interface RoutingPolicy {
  acceptance_minutes: number;
  reminder_before_minutes: number | null;
  schedule: BusinessHoursConfig;
}
export function validateSchedule(raw: BusinessHoursConfig): BusinessHoursConfig {
  if (!raw || typeof raw.enabled !== 'boolean' || typeof raw.timezone !== 'string') throw new Error('schedule_unconfigured');
  try { new Intl.DateTimeFormat('en', { timeZone: raw.timezone }).format(0); } catch { throw new Error('invalid_timezone'); }
  if (!raw.enabled) return { ...raw, days: raw.days ? [...raw.days] : undefined };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.end) || raw.start === raw.end) throw new Error('invalid_hours');
  const days = raw.days ?? [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(days) || !days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length) throw new Error('invalid_days');
  return { ...raw, days: [...days] };
}
export function validateRoutingPolicy(raw: RoutingPolicy): RoutingPolicy {
  if (!Number.isSafeInteger(raw.acceptance_minutes) || raw.acceptance_minutes < 1 || raw.acceptance_minutes > 1440) throw new Error('invalid_acceptance_minutes');
  const reminder = raw.reminder_before_minutes;
  if (reminder !== null && (!Number.isSafeInteger(reminder) || reminder < 1 || reminder >= raw.acceptance_minutes)) throw new Error('invalid_reminder_minutes');
  return { acceptance_minutes: raw.acceptance_minutes, reminder_before_minutes: reminder, schedule: validateSchedule(raw.schedule) };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function isBusinessTime(at: Date, raw: BusinessHoursConfig): boolean {
  return businessAt(at, validateSchedule(raw));
}
function businessAt(at: Date, schedule: BusinessHoursConfig): boolean {
  if (!Number.isFinite(at.getTime())) throw new Error('invalid_date');
  if (!schedule.enabled) return true;
  let formatter = formatters.get(schedule.timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(schedule.timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const parse = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const start = parse(schedule.start), end = parse(schedule.end), days = schedule.days!;
  return start < end ? days.includes(day) && minute >= start && minute < end
    : (days.includes(day) && minute >= start) || (days.includes((day + 6) % 7) && minute < end);
}
/** UTC minute boundaries preserve actual elapsed time through local DST gaps/folds. */
export function businessDeadline(start: Date, minutes: number, raw: BusinessHoursConfig): Date {
  const schedule = validateSchedule(raw);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(minutes) || minutes < 0) throw new Error('invalid_deadline');
  let cursor = +start, left = minutes * 60_000;
  if (!schedule.enabled) return new Date(cursor + left);
  const horizon = cursor + 366 * 86400_000;
  while (left > 0 && cursor < horizon) {
    const next = Math.floor(cursor / 60_000) * 60_000 + 60_000;
    if (businessAt(new Date(cursor), schedule)) {
      const used = Math.min(left, next - cursor); cursor += used; left -= used;
    } else cursor = next;
  }
  if (left > 0) throw new Error('schedule_deadline_out_of_range');
  return new Date(cursor);
}
