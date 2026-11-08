/** A projection of already-authorized server output. No ticket reads or local lifecycle state. */
export interface ProjectionButton { text: string; callback_data?: string; url?: string; }
/** Built only after the caller has checked actor, surface and ticket visibility. */
export interface ScreenViewModel {
  readonly bodyHtml: string;
  readonly buttons: ProjectionButton[][];
}
export function renderClassic(view: ScreenViewModel): { text: string; rows: ProjectionButton[][] } {
  validateButtons(view.buttons);
  return { text: view.bodyHtml, rows: view.buttons };
}
export function renderRich(view: ScreenViewModel): string | undefined {
  return optionalRichProjection(view.bodyHtml, view.buttons);
}
export const boundedText = (value: unknown, limit = 300): string => Array.from(String(value ?? '')).slice(0, limit).join('');
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function richProjection(classic: string, rows: ProjectionButton[][]): string {
  // The classic body is server-generated HTML with escaped dynamic values. Reject
  // unexpected tags rather than letting a new caller introduce executable markup.
  if (classic.length > 16000 || /[<>]/.test(classic.replace(/<\/?b>/g, ''))) throw new Error('unsupported_projection_markup');
  const heading = classic.match(/^<b>([^<>]*)<\/b>(?:\n|$)/);
  const rest = heading ? classic.slice(heading[0].length) : classic;
  const body = (heading ? '<h3>' + heading[1] + '</h3>' : '') + '<p>' + rest.replace(/\n/g, '<br>') + '</p>';
  const buttons = rows.map(row => '<tg-button-row>' + row.map(b => {
    const label = escape(boundedText(b.text, 100));
    if (b.callback_data !== undefined && b.url === undefined) {
      const bytes = Buffer.byteLength(b.callback_data, 'utf8');
      if (bytes < 1 || bytes > 64 || /[\u0000-\u001f]/.test(b.callback_data)) throw new Error('invalid_callback');
      return `<tg-button type="callback_data" style="primary" data="${escape(b.callback_data)}">${label}</tg-button>`;
    }
    if (b.url && b.callback_data === undefined && /^https:\/\/t\.me\/c\/\d+\/\d+(?:\?thread=\d+)?$/.test(b.url)) {
      return `<tg-button type="url" url="${escape(b.url)}">${label}</tg-button>`;
    }
    throw new Error('invalid_projection_button');
  }).join('') + '</tg-button-row>').join('');
  return body + buttons;
}

/** Only a definite API rejection permits a second transport attempt. */
export function richRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { error_code?: number; description?: string };
  return (e.error_code === 404 && /method.*not found|unknown method/i.test(e.description || ''))
    || (e.error_code === 400 && /rich.*(?:unsupported|not supported)|can't parse|unsupported.*tag|rich_message.*invalid/i.test(e.description || ''));
}

/** Unsupported local markup stays classic before any request has been made. */
export function optionalRichProjection(classic: string, rows: ProjectionButton[][]): string | undefined {
  try { return richProjection(classic, rows); } catch { return undefined; }
}

/** Classic and rich transports share these callback constraints. No truncation of commands. */
export function validateButtons(rows: ProjectionButton[][]): void {
  for (const row of rows) for (const b of row) {
    if (b.callback_data !== undefined) {
      const n = Buffer.byteLength(b.callback_data, 'utf8');
      if (n < 1 || n > 64 || /[\u0000-\u001f]/.test(b.callback_data)) throw new Error('invalid_callback');
    }
    if (Array.from(b.text).length > 150) throw new Error('button_label_too_long');
  }
}
