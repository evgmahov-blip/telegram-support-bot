import type { Context } from './interfaces';
import * as middleware from './middleware';
import * as log from './logger';

/** Persistence has succeeded: presentation failures must never invite a second write. */
export async function presentAfterWrite(ctx: Context, present: () => Promise<void>, savedMessage: string): Promise<void> {
  try { await present(); }
  catch (err) {
    log.error('Write succeeded but follow-up failed:', err);
    try { await middleware.reply(ctx, ctx.from?.id ? `Для пользователя ${ctx.from.id}: ${savedMessage}` : savedMessage, {
      parse_mode: undefined,
      message_thread_id: ctx.callbackQuery?.message?.message_thread_id ?? ctx.message?.message_thread_id,
    }); }
    catch (feedbackErr) { log.error('Could not report successful write:', feedbackErr); }
  }
}
