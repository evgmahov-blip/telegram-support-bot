import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as log from './logger';
import * as ticketUi from './ticket-ui';
import TelegramAddon from './addons/telegram';
import { Context } from './interfaces';
import { MANUAL_SOURCE_LABELS } from './manual-ticket-guard';
import { staffDisplayName } from './staff-names';
import { randomBytes } from 'crypto';

/**
 * «Создать заявку вручную»: staff record a phone/email/in-person request as a
 * normal ticket. Flow: source buttons → one selective ForceReply with labeled
 * fields → preview → explicit Create. Every step is bound to the actor, the
 * exact staff chat/topic and an unguessable expiring draft token.
 */
const DRAFT_MS = 15 * 60 * 1000;
export const LIMITS = { client: 200, contact: 200, description: 3000 };
const FIELD_RE = /^\s*(клиент(?:\s*\/\s*организация)?|организация|контакт|описание)\s*[:：]\s*(.*)$/i;

const token = (bytes: number) => randomBytes(bytes).toString('hex');
const pad = (id: number) => String(id).padStart(6, '0');
type Rows = ticketUi.Button[][];

export type ManualFields = { client: string; contact: string | null; description: string };

/** Parse the labeled multiline form; a field continues until the next label. */
export function parseManualForm(text: string): { fields?: ManualFields; error?: string } {
  const values: Record<'client' | 'contact' | 'description', string[]> = { client: [], contact: [], description: [] };
  let current: keyof typeof values | null = null;
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[1].toLowerCase();
      current = label.startsWith('контакт') ? 'contact' : label.startsWith('описание') ? 'description' : 'client';
      values[current].push(m[2]);
    } else if (current) {
      values[current].push(line);
    }
  }
  const clean = (v: string[]) => v.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  const client = clean(values.client).replace(/\s+/g, ' ');
  const contact = clean(values.contact).replace(/\s+/g, ' ');
  const description = clean(values.description);
  const missing = [!client && '«Клиент»', !description && '«Описание»'].filter(Boolean);
  if (missing.length) return { error: `Не заполнено обязательное поле ${missing.join(' и ')}.` };
  if (client.length > LIMITS.client) return { error: `«Клиент» длиннее ${LIMITS.client} символов.` };
  if (contact.length > LIMITS.contact) return { error: `«Контакт» длиннее ${LIMITS.contact} символов.` };
  if (description.length > LIMITS.description) return { error: `«Описание» длиннее ${LIMITS.description} символов.` };
  return { fields: { client, contact: contact || null, description } };
}

function canCreate(actor: string): boolean {
  return Boolean(team.getStaffRole(actor)) && team.canPerformAction(actor, 'reply');
}

const cancelRow = (t: string): Rows => [[{ text: '✖️ Отмена', callback_data: `mi:x:${t}` }, ticketUi.STAFF_HOME]];

/** Home → «Создать заявку вручную». Creates only a draft; never a ticket. */
export async function startDraft(ctx: Context): Promise<boolean> {
  const actor = ctx.from.id.toString();
  if (!canCreate(actor) || typeof db.startManualDraft !== 'function') {
    await ctx.answerCbQuery('Нет прав на создание заявок.', true); return true;
  }
  const t = token(8);
  await db.startManualDraft(t, actor, String(cache.config.staffchat_id), cache.config.staffchat_thread_id || null,
    new Date(Date.now() + DRAFT_MS));
  await ticketUi.answer(ctx, '<b>Новая ручная заявка</b>\nОткуда пришло обращение?', [
    [{ text: '📞 Телефон', callback_data: `mi:s:${t}:phone` }, { text: '✉️ Email', callback_data: `mi:s:${t}:email` }],
    [{ text: '🤝 Лично', callback_data: `mi:s:${t}:in_person` }, { text: '📎 Другое', callback_data: `mi:s:${t}:other` }],
    ...cancelRow(t),
  ]);
  await ctx.answerCbQuery(); return true;
}

/** mi:s (source), mi:ok (create), mi:x (cancel). The caller has already checked the staff surface. */
export async function handleDraftCallback(ctx: Context, p: string[]): Promise<boolean> {
  const actor = ctx.from.id.toString();
  const [, action, t] = p;
  if (!canCreate(actor)) { await ctx.answerCbQuery('Нет прав на создание заявок.', true); return true; }
  const draft = t ? await db.getManualDraft(t) : null;
  if (!draft || draft.actor_id !== actor) { await ctx.answerCbQuery('Черновик устарел или принадлежит другому сотруднику.', true); return true; }

  if (action === 'x') {
    if (!await db.cancelManualDraft(t, actor)) { await ctx.answerCbQuery('Черновик уже завершён.', true); return true; }
    if (draft.prompt_message_id) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, draft.prompt_message_id,
        'Создание ручной заявки отменено.').catch(log.error);
    }
    await ticketUi.answer(ctx, 'Создание ручной заявки отменено.', [[ticketUi.STAFF_HOME]]);
    await ctx.answerCbQuery('Отменено.'); return true;
  }

  if (action === 's') {
    const source = p[3] as db.ManualSource;
    if (!db.MANUAL_SOURCES.includes(source) || !['source', 'form'].includes(draft.status)
      || +new Date(draft.expires_at) <= Date.now()) {
      await ctx.answerCbQuery('Черновик устарел. Начните заново с «Главная».', true); return true;
    }
    const mention = `<a href="tg://user?id=${ticketUi.e(actor)}">${ticketUi.e(staffDisplayName(actor))}</a>`;
    const prompt = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
      `${mention}, ручная заявка (источник: ${ticketUi.e(MANUAL_SOURCE_LABELS[source])}). Ответьте на это сообщение, заполнив поля:\n\n`
      + `Клиент: имя или организация\nКонтакт: телефон/email (необязательно)\nОписание: суть обращения\n\n`
      + `Описание может занимать несколько строк. Другие сообщения группы не учитываются.`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true },
        message_thread_id: cache.config.staffchat_thread_id || undefined });
    if (!prompt) { await ctx.answerCbQuery('Не удалось создать подсказку.', true); return true; }
    const bound = await db.bindManualDraftPrompt(t, actor, source, Number(prompt), new Date(Date.now() + DRAFT_MS));
    if (!bound) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(prompt), 'Эта подсказка отменена: черновик устарел.').catch(log.error);
      await ctx.answerCbQuery('Черновик устарел. Начните заново с «Главная».', true); return true;
    }
    if (draft.prompt_message_id && draft.prompt_message_id !== Number(prompt)) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, draft.prompt_message_id, 'Эта подсказка заменена новой.').catch(log.error);
    }
    await ticketUi.answer(ctx, `Ожидаю данные ручной заявки 15 минут: ответьте на подсказку бота.`, cancelRow(t));
    await ctx.answerCbQuery(); return true;
  }

  if (action === 'ok') {
    if (draft.status === 'created' && draft.ticketId) {
      await ctx.answerCbQuery(`Заявка уже создана: #T${pad(draft.ticketId)}.`, true); return true;
    }
    const claimed = await db.claimManualDraftConfirm(t, actor, p[3]);
    if (!claimed || !claimed.source || !claimed.client || !claimed.description) {
      await ctx.answerCbQuery('Подтверждение устарело. Проверьте актуальный предпросмотр.', true); return true;
    }
    // Idempotent by draft token: a duplicate or post-crash confirm returns the same ticket.
    const { ticket } = await db.createManualTicket(t, { source: claimed.source, client: claimed.client,
      contact: claimed.contact, description: claimed.description, createdBy: actor });
    await db.completeManualDraft(t, ticket.ticketId);
    await ticketUi.refreshStaffCard(ticket.ticketId);
    await ticketUi.answer(ctx, `Ручная заявка #T${pad(ticket.ticketId)} создана. Клиенту ничего не отправлялось.`, [
      [{ text: '⬅️ К тикету', callback_data: `tc:open:${ticket.ticketId}` }, ticketUi.STAFF_HOME],
    ]);
    await ctx.answerCbQuery('Готово.'); return true;
  }

  await ctx.answerCbQuery('Действие недоступно.', true); return true;
}

/**
 * Staff-group reply to a manual intake ForceReply prompt. Returns false when
 * the replied message is not an intake prompt so ticket routing proceeds.
 * Only the exact prompt in the configured chat/topic, from its owner, counts.
 */
export async function handleFormReply(ctx: Context, promptId: number): Promise<boolean> {
  if (typeof db.findManualDraftByPrompt !== 'function') return false;
  const chatId = String(ctx.chat.id);
  if (chatId !== String(cache.config.staffchat_id)) return false;
  const draft = await db.findManualDraftByPrompt(chatId, promptId);
  if (!draft) return false;
  const actor = ctx.from.id.toString();
  const thread = cache.config.staffchat_thread_id || null;
  if (thread && ctx.message?.message_thread_id !== thread) {
    await middleware.reply(ctx, 'Ручная заявка принимается только в настроенной теме поддержки.'); return true;
  }
  if (draft.actor_id !== actor || !canCreate(actor)) {
    await middleware.reply(ctx, 'Эта подсказка принадлежит другому сотруднику; данные не сохранены.'); return true;
  }
  if (!['form', 'preview'].includes(draft.status) || +new Date(draft.expires_at) <= Date.now()) {
    await middleware.reply(ctx, 'Черновик ручной заявки устарел. Начните заново: «Главная» → «Создать заявку вручную».'); return true;
  }
  const parsed = parseManualForm(ctx.message?.text || '');
  if (!parsed.fields) {
    await middleware.reply(ctx, `${parsed.error} Ответьте на ту же подсказку ещё раз.`); return true;
  }
  const nonce = token(6);
  const saved = await db.submitManualDraftForm(draft.token, actor, promptId, parsed.fields, nonce, new Date(Date.now() + DRAFT_MS));
  if (!saved) {
    await middleware.reply(ctx, 'Черновик ручной заявки устарел. Начните заново: «Главная» → «Создать заявку вручную».'); return true;
  }
  const f = parsed.fields;
  await middleware.reply(ctx, `<b>Проверьте ручную заявку</b>\n`
    + `Источник: ${ticketUi.e(MANUAL_SOURCE_LABELS[saved.source ?? 'other'] || 'Другое')}\n`
    + `Клиент: ${ticketUi.e(f.client)}\nКонтакт: ${ticketUi.e(f.contact || '—')}\n\n`
    + `<b>Описание</b>\n${ticketUi.e(f.description)}\n\n`
    + `После создания заявка появится в «Новые». Клиенту ничего не отправляется.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Создать', callback_data: `mi:ok:${draft.token}:${nonce}` }, { text: '✖️ Отмена', callback_data: `mi:x:${draft.token}` }],
      [ticketUi.STAFF_HOME],
    ] },
  });
  return true;
}
