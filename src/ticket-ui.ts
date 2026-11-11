import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as ownership from './ticket-ownership';
import * as ticketState from './ticket-state';
import * as middleware from './middleware';
import * as log from './logger';
import TelegramAddon from './addons/telegram';
import { Context, Messenger } from './interfaces';
import { ISupportee } from './db';
import * as ticketAudit from './ticket-audit';
import * as manualIntake from './manual-intake';
import * as staffNameEditor from './staff-name-editor';
import * as resolutionCase from './ticket-resolution-case';
import { staffDisplayName } from './staff-names';
import { isManualTicket, MANUAL_SOURCE_LABELS } from './manual-ticket-guard';
import { randomUUID } from 'crypto';
import * as engineerUI from './ai-engineer-ui';
import * as visibility from './ticket-visibility';
import * as clientOrganization from './client-organization';
import * as routingAdmin from './routing-admin-ui';
import * as routing from './ticket-routing';
import { renderClassic, renderRich, boundedText } from './ticket-rich-ui';

const PAGE = 6;
const PROMPT_MS = 15 * 60 * 1000;
const RENDER_CACHE_LIMIT = 256;
export const e = (v: unknown) => boundedText(v, 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export type Button = { text: string; callback_data?: string; url?: string };
const kb = (rows: Button[][]) => ({ inline_keyboard: rows });
export const STAFF_HOME: Button = { text: '🏠 Главная', callback_data: 'tm:home:0' };
const USER_HOME: Button = { text: '🏠 Главная', callback_data: 'um:home:0' };
const statusName: Record<string, string> = { open: 'Открыт', waiting_user: 'Ждём клиента', closed: 'Закрыт' };
const priorityName: Record<string, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const eventName: Record<string, string> = {
  'ticket.closed': 'Заявка закрыта', 'ticket.reopened': 'Заявка открыта снова',
  'ticket.taken': 'Заявка взята в работу', 'ticket.assigned': 'Назначен инженер',
  'ticket.transferred': 'Заявка передана', 'ticket.waiting': 'Ожидание клиента',
  'ticket.resumed': 'Работа продолжена', 'ticket.created': 'Заявка создана',
  'ticket.resolution_saved': 'Сохранено решение заявки',
  'ticket.visibility_changed': 'Изменена видимость заявки',
  'ticket.close_requested': 'Клиент просит закрыть заявку',
};
const doneText: Record<string, string> = { close: 'Заявка закрыта:', xfer: 'Заявка передана:', cancel: 'Ожидание ответа отменено:',
  share: 'Заявка стала общей:', unshare: 'Заявка стала личной:' };
// Screens that can carry personal-ticket data open only in the actor's private chat with the bot.
const PERSONAL_VIEWS = new Set(['mine', 'offered', 'active', 'closed']);
const LIST_VIEWS = new Set(['new', 'mine', 'offered', 'common', 'active', 'closed']);

/** Event label for history rows; bounded numbers only, no free text from metadata. */
function eventLabel(type: string, metadata?: Record<string, any>): string {
  const version = Number(metadata?.resolution_version ?? metadata?.version);
  const suffix = Number.isSafeInteger(version) && version > 0 ? ` (решение, версия ${version})` : '';
  if (type === 'ticket.closed') return `Заявка закрыта${suffix}`;
  if (type === 'ticket.resolution_saved') return `Сохранено решение заявки${suffix}`;
  if (type === 'ticket.visibility_changed') return metadata?.common ? 'Заявка сделана общей' : 'Заявка сделана личной';
  return eventName[type] || 'Изменение заявки';
}
const renderedMessages = new Map<string, string>();
const navigationPanels = new Map<string, number>();

/** Test isolation for process-local presentation state. */
export function resetRenderStateForTests() {
  if (process.env.NODE_ENV !== 'test') return;
  renderedMessages.clear(); navigationPanels.clear();
}

function boundedSet<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key); map.set(key, value);
  if (map.size > RENDER_CACHE_LIMIT) map.delete(map.keys().next().value!);
}
const messageKey = (chatId: string | number, messageId: number) => `${chatId}:${messageId}`;
const panelKey = (ctx: Context) => `${ctx.from.id}:${ctx.chat.id}:${ctx.callbackQuery?.message?.message_thread_id ?? ctx.message?.message_thread_id ?? ''}`;
function renderSignature(text: string, rows: Button[][], parseMode = 'HTML') {
  return JSON.stringify({ rich: cache.config.telegram_rich_ui === true, text, markup: { inline_keyboard: rows }, parseMode });
}

function missingMessage(err: unknown): boolean {
  const x = err as { error_code?: number; description?: string };
  return x.error_code === 400 && /message to edit not found/i.test(x.description || '');
}

async function editRendered(chatId: string | number, messageId: number, text: string, rows: Button[][]): Promise<boolean> {
  ({ text, rows } = renderClassic({ bodyHtml: text, buttons: rows }));
  const key = messageKey(chatId, messageId); const signature = renderSignature(text, rows);
  if (renderedMessages.get(key) === signature) return false;
  try {
    const rich = cache.config.telegram_rich_ui === true && Number(chatId) > 0 && rows.some(row => row.some(b => /^(tm|tc|rt):/.test(b.callback_data || '')));
    const extra = rich ? { most_rich_html: renderRich({ bodyHtml: text, buttons: rows }) } : {};
    await TelegramAddon.getInstance().editMessage(chatId, messageId, text, {
      ...extra,
      parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    });
    boundedSet(renderedMessages, key, signature); return true;
  } catch (err) {
    renderedMessages.delete(key); throw err;
  }
}

/** Staff-only actor label for history/audit rows; the Telegram ID is never rendered. */
function actorLabel(actor: unknown, metadata?: Record<string, unknown>): string {
  if (metadata?.closed_by === 'user') return 'клиент';
  return staffDisplayName(actor as string);
}
const fmt = (d: unknown) => d ? new Date(d as string).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit',
}) : '—';

async function staffButtons(t: ISupportee) {
  const id = t.ticketId;
  if (t.routing?.state === 'offered') return kb([
    [{ text: 'Открыть предложение в личном чате', callback_data: `tc:open:${id}` }],
  ]);
  if (t.status === 'closed') {
    const saved = typeof db.getTicketResolution === 'function' && await db.getTicketResolution(id);
    return kb([
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '🔓 Вернуть в работу', callback_data: `tc:reopen:${id}` }],
    [{ text: saved ? '📘 Решение' : '💾 Сохранить решение', callback_data: `rs:${saved ? 'view' : 'start'}:${id}` }],
    ...(t.ai_engineer ? [[{ text: 'Заключение ИИ', callback_data: `ae:view:${id}` }]] : []),
    [{ text: '⬅️ Назад', callback_data: 'tm:closed:0' }, STAFF_HOME],
  ]);
  }
  return kb([
    // A manual ticket has no client channel: «reply» only records work in its history.
    [...(!t.assigned_to ? [{ text: '🙋 Взять', callback_data: `tc:take:${id}` }] : []), { text: isManualTicket(t) ? '📝 Записать ответ' : '✉️ Написать клиенту', callback_data: `tc:reply:${id}` }],
    [{ text: t.status === 'waiting_user' ? '▶️ Продолжить работу' : '⏳ Ждём клиента', callback_data: `tc:${t.status === 'waiting_user' ? 'resume' : 'wait'}:${id}` }, { text: '👤 Передать', callback_data: `tc:transfer:${id}` }],
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '📝 Заметка', callback_data: `tc:note:${id}` }],
    [{ text: '🔒 Закрыть', callback_data: `tc:closeask:${id}` }],
    ...(t.assigned_to ? [[t.common_visible
      ? { text: '🔒 Сделать личной', callback_data: `tc:unshare:${id}` }
      : { text: '🤝 Сделать общей', callback_data: `tc:share:${id}` }]] : []),
    ...(engineerUI.engineerOffered(t) ? [[{ text: 'ИИ-инженер', callback_data: `ae:${engineerUI.engineerCanStart(t) ? 'start' : 'view'}:${id}` }]] : []),
    ...(t.ai_engineer ? [[{ text: 'Заключение ИИ', callback_data: `ae:view:${id}` }]] : []),
    [{ text: '⬅️ Назад', callback_data: 'tm:common:0' }, STAFF_HOME],
  ]);
}

async function privateButtons(ticket: ISupportee): Promise<Button[][]> {
  const rows = (await staffButtons(ticket)).inline_keyboard;
  const version = ticket.routing?.version ?? +new Date(ticket.updated_at);
  return rows.map(row => row.map(button => ({ ...button,
    ...(button.callback_data?.startsWith('tc:') && !/^tc:(open|h):/.test(button.callback_data)
      ? { callback_data: `${button.callback_data}:v${version}` } : {}),
  })));
}
/**
 * Canonical card text for the shared staff chat. A personal ticket shows no
 * client content there: the owner and supervisors open it in their bot DM.
 */
export async function sharedCardText(ticket: ISupportee): Promise<string> {
  if (visibility.isCommonTicket(ticket)) return cardText(ticket, undefined, true);
  return '🔒 Личная заявка.';
}

function offerDeadline(ticket: ISupportee): string {
  const r = ticket.routing;
  const zone = r?.policy?.schedule?.timezone;
  if (!r?.deadline_at || !zone || !r.policy) return 'Ожидает принятия · срок не задан';
  return 'Ожидает принятия · принять до ' + e(new Date(r.deadline_at).toLocaleString('ru-RU', { timeZone: zone }))
    + ' (' + e(zone) + ') · ' + r.policy.acceptance_minutes + ' рабочих минут; это не срок решения';
}

export async function cardText(ticket: ISupportee, viewerId?: string, publicCard = false): Promise<string> {
  const latest = typeof db.getLatestTicketMessage === 'function' ? await db.getLatestTicketMessage(ticket.ticketId) : null;
  const owner = ticket.assigned_to ? staffDisplayName(ticket.assigned_to) : ticket.routing?.state === 'offered' ? 'Предложено: ' + staffDisplayName(ticket.routing.offered_to) : 'Не назначен';
  const sharedAt = ticket.common_visible_since ?? [...(ticket.routing?.audit ?? [])].reverse().find(event => event.type === 'ticket.routing_common')?.at;
  const publicPreview = !publicCard || (!ticket.common_visible && !sharedAt) || Boolean(sharedAt && latest?.timestamp && +new Date(latest.timestamp) > +new Date(sharedAt));
  const preview = publicPreview && latest?.text && (!publicCard || !latest.text.startsWith(`[${cache.config.language.editedMessage}]`)) ? boundedText(latest.text.replace(/\s+/g, ' '), 240) : 'Сообщений пока нет';
  // External client data is rendered on the staff card only; clients never see manual tickets.
  const manual = isManualTicket(ticket);
  const client = manual ? (ticket.external_client || ticket.name || 'Не указан') : (ticket.name || 'Не указан');
  const details = [
    ticket.routing?.state === 'offered' ? offerDeadline(ticket) : '',
    viewerId && ticket.assigned_to === viewerId ? '🔵 Моя' : visibility.isCommonTicket(ticket) ? '🟢 Общая' : '',
    manual && ticket.manual_source ? `Источник: ${e(MANUAL_SOURCE_LABELS[ticket.manual_source] || 'Другое')}` : '',
    `Клиент: ${e(client)}`,
    ticket.declared_organization ? `Организация (со слов клиента): ${e(ticket.declared_organization)}` : '',
    ticket.organization_ref && ticket.organization_binding_version ? 'Привязка организации: подтверждена человеком' : 'Привязка организации: не подтверждена',
    manual && ticket.external_contact ? `Контакт: ${e(ticket.external_contact)}` : '',
    ticket.assigned_to && ticket.common_visible ? 'Видимость: общая' : '',
    ticket.category && !/^(общая|general|common)$/i.test(ticket.category) ? `Категория: ${e(ticket.category)}` : '',
    `Приоритет: ${e(priorityName[ticket.priority || 'normal'] || ticket.priority)}`,
  ].filter(Boolean).join('\n');
  return `<b>Заявка #${ticket.ticketId}</b>\n` +
    `Статус: <b>${e(statusName[ticket.status] || ticket.status)}</b>\n` +
    `${details}\nИнженер: ${e(owner)}\n${cache.config.ai_engineer_enabled === true ? `ИИ: ${e(engineerUI.engineerStatus(ticket))}\n` : ''}\n` +
    `<b>${manual ? 'Описание / последняя запись' : 'Последнее сообщение'}</b>\n${e(preview)}`;
}

export async function refreshStaffCard(ticketId: number): Promise<void> {
  try {
    if (typeof db.getTicketById !== 'function') return;
    let ticket = await db.getTicketById(ticketId, null);
    if (!ticket) return;
    if (ticket.routing?.state === 'offered' && !ticket.staff_card_message_id) return;
    if (ticket.staff_card_message_id && ticket.staff_card_chat_id) {
      const cardChatId = ticket.staff_card_chat_id;
      const cardMessageId = ticket.staff_card_message_id;
      try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const text = await sharedCardText(ticket);
        const opts = { parse_mode: 'HTML', disable_notification: true, reply_markup: visibility.isCommonTicket(ticket) ? await staffButtons(ticket) : kb([]) };
        const rows = (opts.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard;
        if (!await visibility.freshTicket(ticket)) return;
        await editRendered(cardChatId, cardMessageId, text, rows);
        const current = await db.getTicketById(ticketId, null);
        if (!current || +new Date(current.updated_at) <= +new Date(ticket.updated_at)) return;
        ticket = current;
      }
      log.error(`Карточка #T${ticketId} изменилась во время повторного обновления.`);
      return;
      } catch (err) {
        const description = String((err as { description?: string }).description || err);
        if (!/message to edit not found|message can't be edited|message can.t be edited/i.test(description)
          || typeof db.clearStaffCardBinding !== 'function') {
          log.error(`Не удалось обновить карточку #T${ticketId}:`, err);
          return; // Ambiguous failure: never risk a duplicate canonical card.
        }
        const cleared = await db.clearStaffCardBinding(ticketId, String(cardChatId), cardMessageId);
        if (!cleared) return; // Another worker already repaired or replaced it.
        renderedMessages.delete(messageKey(cardChatId, cardMessageId));
        ticket = cleared;
      }
    }
    if (!visibility.isCommonTicket(ticket)) return;
    const text = await sharedCardText(ticket);
    const opts = { parse_mode: 'HTML', disable_notification: true, reply_markup: visibility.isCommonTicket(ticket) ? await staffButtons(ticket) : kb([]) };
    if (typeof db.claimStaffCard !== 'function') return;
    const claim = randomUUID();
    const claimed = await db.claimStaffCard(ticketId, claim);
    if (!claimed) return;
    let messageId: string | null = null;
    try { if (!await visibility.freshTicket(ticket)) { await db.releaseStaffCardClaim(ticketId, claim); return; } messageId = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type, text, opts); }
    catch (err) { await db.releaseStaffCardClaim(ticketId, claim); throw err; }
    if (!messageId) { await db.releaseStaffCardClaim(ticketId, claim); return; }
    let bound: ISupportee | null = null;
    try {
      bound = await db.bindStaffCard(ticketId, claim, String(cache.config.staffchat_id), Number(messageId), cache.config.staffchat_thread_id || null);
    } catch (err) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(messageId),
        `Карточка #T${ticketId} не активна. Откройте актуальную карточку из меню.`, { reply_markup: kb([[STAFF_HOME]]) }).catch(log.error);
      await db.releaseStaffCardClaim(ticketId, claim).catch(log.error);
      throw err;
    }
    if (bound) {
      const rows = (opts.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard;
      boundedSet(renderedMessages, messageKey(cache.config.staffchat_id, Number(messageId)), renderSignature(text, rows));
    }
    if (!bound) {
      log.error(`Duplicate card candidate ${messageId} for #T${ticketId}; canonical binding was already present.`);
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(messageId),
        `Карточка #T${ticketId} устарела. Откройте актуальную карточку из меню.`, { reply_markup: kb([[STAFF_HOME]]) }).catch(log.error);
      await db.releaseStaffCardClaim(ticketId, claim).catch(log.error);
    }
  } catch (err) {
    // Card presentation is best-effort and must never turn a completed action into a reported failure.
    log.error(`Не удалось синхронизировать карточку #T${ticketId}:`, err);
  }
}

const NOTICE_ATTEMPTS = 5;
const NOTICE_CLAIM_MS = 60_000;
/** Telegram answered with an error, so the message definitely was not posted; network failures stay ambiguous. */
const rejectedByTelegram = (err: unknown) => Number.isInteger((err as { error_code?: number })?.error_code);

/**
 * Refreshes the canonical card and publishes the pending «returned to common» record.
 * A newly created common card is itself the record; an edited old card is not, so a
 * separate number-only notice goes to the configured staff chat/topic. Success needs a
 * Telegram message id; Telegram rejections retry, ambiguous results never auto-repeat.
 */
export async function publishCommonReturn(ticketId: number): Promise<void> {
  let claimed: ISupportee | null = null;
  try {
    const ticket = typeof db.claimCommonReturnNotice === 'function' ? await db.getTicketById(ticketId, null) : null;
    const notice = ticket?.common_return_notice;
    if (notice?.state === 'pending') {
      const prior = notice.prior_card !== undefined ? notice.prior_card : ticket.staff_card_message_id ?? null;
      claimed = await db.claimCommonReturnNotice(ticketId, notice.key, prior);
    }
  } catch (err) { log.error(`Не удалось занять запись о возврате #T${ticketId}:`, err); }
  await refreshStaffCard(ticketId);
  if (!claimed) return;
  const { key, attempts = 0, prior_card: prior = null } = claimed.common_return_notice!;
  try {
    const current = await db.getTicketById(ticketId, null);
    if (current?.common_return_notice?.key !== key) return; // A newer transition owns the record now.
    if (!visibility.isCommonTicket(current) || current.status === 'closed') {
      await db.settleCommonReturnNotice(ticketId, key, 'superseded'); return;
    }
    if (current.staff_card_message_id && current.staff_card_message_id !== prior) {
      await db.settleCommonReturnNotice(ticketId, key, 'sent', { message_id: current.staff_card_message_id, via: 'card' }); return;
    }
    let messageId: string | null = null, definite = true;
    try {
      // Number and action only: pre-return conversation, files and contacts stay private.
      messageId = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
        `♻️ <b>Заявка возвращена в общие</b>\nЗаявка № ${ticketId}`, { parse_mode: 'HTML', disable_notification: false,
          reply_markup: kb([[{ text: 'Открыть заявку', callback_data: `tc:open:${ticketId}:n` }]]) });
    } catch (err) {
      definite = rejectedByTelegram(err);
      log.error(`Запись о возврате #T${ticketId} не доставлена${definite ? '' : ' (результат неизвестен)'}:`, err);
    }
    if (messageId) await db.settleCommonReturnNotice(ticketId, key, 'sent', { message_id: Number(messageId), via: 'notice' });
    else if (!definite) await db.settleCommonReturnNotice(ticketId, key, 'unknown');
    else await db.settleCommonReturnNotice(ticketId, key, attempts + 1 >= NOTICE_ATTEMPTS ? 'failed' : 'pending', { attempts: attempts + 1 });
  } catch (err) {
    log.error(`Не удалось опубликовать возврат #T${ticketId}:`, err);
  }
}

/** Periodic recovery through the workflow loop; the per-key claim prevents duplicate posts. */
export async function recoverCommonReturns(): Promise<void> {
  if (typeof db.listPendingCommonReturnNotices !== 'function') return;
  await db.expireCommonReturnNoticeClaims(new Date(Date.now() - NOTICE_CLAIM_MS));
  for (const id of await db.listPendingCommonReturnNotices(50)) await publishCommonReturn(id);
}

function staffSurface(ctx: Context): boolean {
  const q = ctx.callbackQuery.message;
  if (!ctx.session.admin || !team.getStaffRole(ctx.from.id.toString()) || !q) return false;
  if (String(q.chat.id) !== String(cache.config.staffchat_id)) return false;
  return !cache.config.staffchat_thread_id || q.message_thread_id === cache.config.staffchat_thread_id;
}

/** A registered engineer's own private staff workspace. */
export function isStaffPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && String(ctx.chat.id) === String(ctx.from?.id) && ctx.messenger === Messenger.TELEGRAM
    && Boolean(team.getStaffRole(String(ctx.from?.id)));
}

async function acknowledge(ctx: Context, text?: string, alert = false) {
  if (ctx.callbackQuery) await ctx.answerCbQuery(text, alert);
  else if (text) await middleware.reply(ctx, text);
}

/** Send a screen to the actor's own bot DM; never falls back to the shared chat. */
async function answerPrivately(ctx: Context, text: string, rows: Button[][]): Promise<boolean> {
  const sent = await visibility.sendToStaffPrivate(String(ctx.from.id), text,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  await acknowledge(ctx, sent ? 'Открыто в личном чате с ботом.' : visibility.PRIVATE_UNAVAILABLE, !sent);
  return Boolean(sent);
}

/**
 * Render a ticket screen and acknowledge the callback. Common tickets render in
 * place; a personal ticket requested from the shared chat goes only to the DM.
 */
export async function answerForTicket(ctx: Context, ticket: ISupportee, text: string, rows: Button[][]): Promise<boolean> {
  const current = await visibility.freshTicket(ticket);
  if (!current || !visibility.canViewTicket(String(ctx.from.id), current)) { await acknowledge(ctx, 'Заявка изменилась.', true); return false; }
  if (isStaffPrivate(ctx) || visibility.isCommonTicket(current)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await answer(ctx, text, rows);
    return true;
  }
  return answerPrivately(ctx, text, rows);
}

/** keepClicked: the clicked message is a feed record that must stay visible, like the canonical card. */
export async function answer(ctx: Context, text: string, rows: Button[][], visibleFlow = false, keepClicked = false) {
  ({ text, rows } = renderClassic({ bodyHtml: text, buttons: rows }));
  const q = ctx.callbackQuery?.message;
  if (q) {
    try {
      const correlated = typeof db.getTicketByInternalId === 'function' ? await db.getTicketByInternalId(q.message_id) : null;
      const canonical = correlated?.staff_card_message_id === q.message_id
        && String(correlated.staff_card_chat_id) === String(q.chat.id)
        && (correlated.staff_card_thread_id || null) === (q.message_thread_id || null);
      if (!canonical && !keepClicked) {
        await editRendered(q.chat.id, q.message_id, text, rows);
        boundedSet(navigationPanels, panelKey(ctx), q.message_id);
        return;
      }
      const existingPanel = visibleFlow ? undefined : navigationPanels.get(panelKey(ctx));
      if (existingPanel) {
        try { await editRendered(q.chat.id, existingPanel, text, rows); return; }
        catch (err) {
          navigationPanels.delete(panelKey(ctx));
          renderedMessages.delete(messageKey(q.chat.id, existingPanel));
          if (!missingMessage(err)) throw err;
        }
      }
    } catch (err) {
      if (!missingMessage(err)) throw err;
    }
  }
  const options = { ...(isStaffPrivate(ctx) && cache.config.telegram_rich_ui === true ? { most_rich_html: renderRich({ bodyHtml: text, buttons: rows }) } : {}), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    message_thread_id: ctx.message?.message_thread_id ?? q?.message_thread_id ?? undefined };
  if (q) {
    const sent = await middleware.sendMessage(q.chat.id, ctx.messenger, text, options);
    if (sent) {
      const messageId = Number(sent);
      boundedSet(navigationPanels, panelKey(ctx), messageId);
      boundedSet(renderedMessages, messageKey(q.chat.id, messageId), renderSignature(text, rows));
    }
    return;
  }
  await middleware.reply(ctx, text, options);
}

export async function showUserHome(ctx: Context) {
  // undefined: organization is not collected on this surface (non-Telegram or legacy test doubles).
  const organization = await clientOrganization.currentOrganization(ctx);
  const profile = organization ? await clientOrganization.getProfile(ctx) : null;
  const verification = profile?.organization_verification === 'confirmed' ? 'подтверждено администратором' : profile?.organization_verification === 'rejected' ? 'привязка отклонена' : 'не подтверждено';
  await answer(ctx, `<b>Поддержка</b>${organization ? `\nОрганизация: ${e(organization) + ' (' + e(verification) + ')'}` : ''}\nВыберите действие:`, [
    [{ text: '➕ Новое обращение', callback_data: 'um:new:0' }],
    [{ text: '📋 Мои обращения', callback_data: 'um:list:0' }, { text: '❓ Помощь', callback_data: 'um:help:0' }],
    ...(organization !== undefined ? [[{ text: '🏢 Организация', callback_data: 'um:org:0' }]] : []),
  ]);
}

export async function showStaffHome(ctx: Context, visibleFlow = false) {
  const rows: Button[][] = [
    [{ text: '🆕 Новые', callback_data: 'tm:new:0' }, { text: '🔵 Мои заявки', callback_data: 'tm:mine:0' }],
    [{ text: '🟢 Общие заявки', callback_data: 'tm:common:0' }, { text: '📂 Все активные', callback_data: 'tm:active:0' }],
    [{ text: '✅ Закрытые', callback_data: 'tm:closed:0' }],
    [{ text: '📝 Создать заявку вручную', callback_data: 'tm:manual:0' }],
  ];
  if (team.canPerformAction(ctx.from.id.toString(), 'manage_team')) {
    rows.push([{ text: '👥 Инженеры', callback_data: 'sn:list:0' }]);
    rows.push([{ text: '⚙️ Настройки', callback_data: 'cfg:home' }]);
  }
  await answer(ctx, '<b>Панель поддержки</b>\n«Мои», «Все активные» и «Закрытые» открываются в личном чате с ботом.', rows, visibleFlow);
}

/** Staff home in the engineer's own bot DM. */
export async function showStaffPrivateHome(ctx: Context) {
  if (!isStaffPrivate(ctx)) return;
  await staffList(ctx, 'mine', 0);

}

async function renderTicketOnClickedCard(ctx: Context, ticket: ISupportee, outcome?: string) {
  const q = ctx.callbackQuery.message!;
  const personalSurface = isStaffPrivate(ctx);
  const text = personalSurface ? await cardText(ticket, String(ctx.from.id)) : await sharedCardText(ticket);
  if (!await visibility.freshTicket(ticket)) return;
  const rows = personalSurface ? await privateButtons(ticket)
    : visibility.isCommonTicket(ticket) ? (await staffButtons(ticket)).inline_keyboard : [];
  await editRendered(q.chat.id, q.message_id, text + (outcome ? `\n\n${outcome}` : ''), rows);
}

async function dashboardTabs(actor: string, scope: db.StaffListScope, selected: db.StaffListView): Promise<Button[][]> {
  const views: db.StaffListView[] = ['mine', 'offered', 'common'];
  const counts = await Promise.all(views.map(v => typeof db.countStaffTickets === 'function' ? db.countStaffTickets(v, actor, scope) : null));
  return views.map((v, i) => [{ text: (v === selected ? '✓ ' : '') + ['🔵 Мои в работе', '⏳ Ожидают принятия', '🟢 Общие'][i]
    + (counts[i] == null ? '' : ` (${counts[i]})`), callback_data: `tm:${v}:0` }]);
}

async function staffList(ctx: Context, view: db.StaffListView, page: number) {
  const actor = ctx.from.id.toString();
  const privateSurface = isStaffPrivate(ctx);
  const toPrivate = !privateSurface && PERSONAL_VIEWS.has(view);
  const scope = visibility.listScope(actor, !privateSurface && !toPrivate);
  const fetched = await db.listStaffTickets(view, actor, page, PAGE + 1, PAGE, scope);
  const more = fetched.length > PAGE;
  const checked = await Promise.all(fetched.slice(0, PAGE).map(t => visibility.freshTicket(t)));
  const list = checked.filter((t): t is ISupportee => Boolean(t && visibility.canViewTicket(actor, t)
    && (privateSurface || toPrivate || visibility.isCommonTicket(t))));
  const rows: Button[][] = list.map(t => [{ text: (privateSurface || toPrivate ? (t.routing?.state === 'offered' ? 'Ожидает принятия · ' : t.assigned_to === actor ? '🔵 Моя · ' : visibility.isCommonTicket(t) ? '🟢 Общая · ' : '') : '') + `#${t.ticketId} · ${statusName[t.status]} · ${boundedText(t.category || 'Общая', 18)}${isManualTicket(t) ? ' · вручную' : ''}`, callback_data: `tc:open:${t.ticketId}` }]);
  if (privateSurface || toPrivate) rows.unshift(...await dashboardTabs(actor, scope, view));
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `tm:${view}:${page-1}` });
  if (more) nav.push({ text: '▶️', callback_data: `tm:${view}:${page+1}` });
  if (nav.length) rows.push(nav);
  if (privateSurface || toPrivate) {
    rows.push([{ text: '👁 Пример Rich HTML', callback_data: 'tm:richdemo:0' }]);
    rows.push([{ text: '📂 Все активные', callback_data: 'tm:active:0' }, { text: '✅ Закрытые', callback_data: 'tm:closed:0' }]);
    if (team.canPerformAction(actor, 'manage_team')) rows.push([{ text: '⚙️ Настройки', callback_data: 'cfg:home' }]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: `tm:${view}:${page}` }, { text: '🏠 Главная', callback_data: 'tm:home:0' }]);
  const pageText = page > 0 || more ? `\nСтраница ${page + 1}` : '';
  const label = ({mine:'Мои в работе', offered:'Ожидают принятия', common:'Общие', active:'Все активные', closed:'Закрытые', new:'Новые'} as const)[view];
  const text = `<b>${label}</b>\n${list.length ? 'Заявки' : 'Заявок нет'}${pageText}`;
  if (toPrivate) await answerPrivately(ctx, text, rows);
  else await answer(ctx, text, rows);
}

async function history(ctx: Context, ticket: ISupportee, page: number, staff: boolean) {
  // Requested staff history is private, including history from before explicit sharing.
  const deliver = async (text: string, rows: Button[][]) => {
    if (staff && !isStaffPrivate(ctx)) {
      const current = await visibility.freshTicket(ticket);
      if (!current || !visibility.canViewTicket(String(ctx.from.id), current)) return;
      return answerPrivately(ctx, text, rows);
    }
    return staff ? answerForTicket(ctx, ticket, text, rows) : answer(ctx, text, rows);
  };
  const resolutionRow: Button[][] = staff && ticket.status === 'closed' ? [[{ text: '📘 Решение', callback_data: `rs:view:${ticket.ticketId}` }]] : [];
  if (typeof db.getTicketTimelinePage === 'function') {
    const fetched = await db.getTicketTimelinePage(ticket.ticketId, page, PAGE + 1, staff, PAGE);
    const more = fetched.length > PAGE; const timeline = fetched.slice(0, PAGE);
    const manual = isManualTicket(ticket);
    const body = timeline.map((x: any) => {
      // Staff names appear only in the staff view; the client view keeps the anonymous «Поддержка».
      const label = x.kind === 'user' ? (manual ? 'Обращение (записано вручную)' : 'Клиент')
        : x.kind === 'staff' ? (staff ? `${manual ? 'Записанный ответ' : 'Поддержка'} · ${actorLabel(x.actor)}` : 'Поддержка')
        : x.kind === 'note' ? `🔒 Заметка (${actorLabel(x.actor)})`
        : x.kind === 'ai' ? '🤖 AI-черновик'
        : `Событие${staff && x.actor ? ` · ${actorLabel(x.actor, x.metadata)}` : ''}`;
      const owner = staff && x.metadata?.owner ? ` · владелец ${staffDisplayName(x.metadata.owner)}` : '';
      const content = x.kind === 'event'
        ? (x.text === 'ticket.created' && x.metadata?.source === 'manual' ? 'Заявка создана вручную'
          : staff ? eventLabel(x.text, x.metadata) : eventName[x.text] || 'Изменение заявки')
        : String(x.text).slice(0, 500);
      return `<b>${e(fmt(x.at))}</b>\n${e(`${label}: ${content}${owner}`)}`;
    }).join('\n\n') || 'История пуста.';
    const nav: Button[] = [
      ...(page > 0 ? [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page-1}` }] : []),
      ...(more ? [{ text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }] : []),
    ];
    await deliver(`<b>История заявки № ${ticket.ticketId}</b>\n\n${body}`, [
      ...(nav.length ? [nav] : []),
      ...resolutionRow,
      [{ text: '⬅️ Назад', callback_data: `${staff?'tc':'uc'}:open:${ticket.ticketId}` }, { text: '🏠 Главная', callback_data: staff?'tm:home:0':'um:home:0' }],
    ]);
    return;
  }
  const [messages, events, notes] = await Promise.all([
    db.getTicketMessageHistory(ticket.ticketId, 0), ticketAudit.getTicketAuditHistory(ticket.ticketId, 0),
    staff ? db.getInternalNotes(ticket.ticketId) : Promise.resolve([]),
  ]);
  const visibleMessages = staff ? messages : messages.filter(m =>
    (m.sender === 'user' || m.sender === 'staff')
    && (m.sender === 'user' || Boolean(m.delivered_at) || m.delivery_key === undefined));
  const items = [
    ...visibleMessages.map(m => ({ at: m.timestamp, text: `${m.sender === 'user' ? 'Клиент' : 'Поддержка'}: ${m.text.slice(0, 100)}` })),
    ...events.filter(x => /ticket\.(closed|reopened|taken|assigned|transferred|waiting|resumed)/.test(x.type))
      .map(x => ({ at: x.timestamp, text: `Событие: ${eventName[x.type] || 'Изменение заявки'}${staff && x.agent_id ? ` · ${actorLabel(x.agent_id, x.metadata)}` : ''}${staff && x.metadata?.owner ? ` · владелец ${staffDisplayName(x.metadata.owner)}` : ''}` })),
    ...notes.map(n => ({ at: n.timestamp, text: `🔒 Заметка (${actorLabel(n.author_id)}): ${n.text.slice(0, 100)}` })),
  ].sort((a,b) => +new Date(a.at) - +new Date(b.at));
  const slice = items.slice(page * PAGE, page * PAGE + PAGE);
  const body = slice.map(x => `<b>${e(fmt(x.at))}</b>\n${e(x.text)}`).join('\n\n') || 'История пуста.';
  await deliver(`<b>История заявки № ${ticket.ticketId}</b>\n\n${body}`, [
    [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${Math.max(0,page-1)}` }, { text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }],
    ...resolutionRow,
    [{ text: '⬅️ Назад', callback_data: `${staff?'tc':'uc'}:open:${ticket.ticketId}` }, { text: '🏠 Главная', callback_data: staff?'tm:home:0':'um:home:0' }],
  ]);
}

export async function handleCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery.data || '';
  if (Buffer.byteLength(data, 'utf8') > 64) { await ctx.answerCbQuery('Некорректная кнопка.', true); return true; }
  if (data.startsWith('rt:')) return routingAdmin.handleRoutingCallback(ctx);
  if (data.startsWith('cfg:')) return routingAdmin.handleAdminCallback(ctx);
  if (data === 'noop') { await ctx.answerCbQuery('Это номер страницы. Используйте стрелки для перехода.', true); return true; }
  const p = data.split(':');
  if (p[0] === 'um') {
    if (ctx.chat.type !== 'private') { await ctx.answerCbQuery('Доступно только в личном чате.', true); return true; }
    if (['org', 'orgedit', 'orgcancel'].includes(p[1])) { await clientOrganization.handleCallback(ctx, p); return true; }
    const navigation = p[1] !== 'new';
    if (navigation) await ctx.answerCbQuery();
    if (p[1] === 'home') await showUserHome(ctx);
    else if (p[1] === 'new') {
      // The request intent survives the organization prompt: the next question opens the new ticket.
      await db.requestNewTicket(ctx.from.id.toString(), ctx.messenger);
      const gate = await clientOrganization.requireForNewTicket(ctx, 'menu');
      if (gate.ok) await middleware.reply(ctx, 'Опишите вопрос одним сообщением. Обращение будет создано после отправки.', {
        reply_markup: { inline_keyboard: [[USER_HOME]] },
      });
    }
    else if (p[1] === 'help') await answer(ctx, e(cache.config.language.helpCommandText), [[USER_HOME]]);
    else {
      const page = Number(p[2]) || 0; const fetched = await db.listUserTickets(ctx.from.id.toString(), page, PAGE + 1, PAGE);
      const more = fetched.length > PAGE; const list = fetched.slice(0, PAGE);
      const nav: Button[] = [...(page > 0 ? [{ text: '◀️', callback_data: `um:list:${page-1}` }] : []),
        ...(more ? [{ text: '▶️', callback_data: `um:list:${page+1}` }] : [])];
      await answer(ctx, list.length ? '<b>Мои обращения</b>' : '<b>Мои обращения</b>\nОбращений пока нет.', [
        ...list.map(t => [{ text: `#${t.ticketId} · ${statusName[t.status]}`, callback_data: `uc:open:${t.ticketId}` }]),
        ...(nav.length ? [nav] : []),
        ...(list.length ? [] : [[{ text: '➕ Новое обращение', callback_data: 'um:new:0' }]]),
        [USER_HOME],
      ]);
    }
    if (!navigation) await ctx.answerCbQuery();
    return true;
  }
  if (p[0] === 'uc') {
    const ticket = await db.getTicketById(Number(p[2]), null);
    if (!ticket || ticket.userid !== ctx.from.id.toString() || ctx.chat.type !== 'private') { await ctx.answerCbQuery('Обращение недоступно.', true); return true; }
    await ctx.answerCbQuery();
    if (p[1] === 'h') await history(ctx, ticket, Number(p[3]) || 0, false);
    else {
      // Clients never reopen tickets themselves: a recurring problem goes through a new request or staff «Вернуть в работу».
      const closed = ticket.status === 'closed';
      const category = ticket.category && !/^(общая|general|common)$/i.test(ticket.category)
        ? `\nКатегория: ${e(ticket.category)}` : '';
      const organization = ticket.declared_organization ? `\nОрганизация: ${e(ticket.declared_organization)}` : '';
      await answer(ctx, `<b>Обращение № ${ticket.ticketId}</b>\nСтатус: ${e(statusName[ticket.status])}${category}${organization}`
        + (closed ? '\n\nЕсли проблема повторилась, создайте новое обращение — поддержка сможет вернуть эту заявку в работу.' : ''), [
        [{ text: '📜 Сообщения', callback_data: `uc:h:${ticket.ticketId}:0` }],
        ...(closed ? [[{ text: '➕ Новое обращение', callback_data: 'um:new:0' }]] : []),
        [{ text: '⬅️ Назад', callback_data: 'um:list:0' }, USER_HOME],
      ]);
    }
    return true;
  }
  if (p[0] === 'tm') {
    const privateStaff = isStaffPrivate(ctx);
    if (p[1] === 'richdemo') {
      if (!privateStaff) { await ctx.answerCbQuery('Доступно только сотруднику в личном чате.', true); return true; }
      await ctx.answerCbQuery('Демо: отправляю пример.');
      const bodyHtml = '<b>Демо · Заявка #DEMO</b>\nОрганизация: ООО «Вымышленный маяк»\nКлиент: Алексей Примеров\nСтатус: В работе\nОписание: синтетический пример обращения.\nВсе данные вымышлены.';
      const buttons = [[STAFF_HOME]];
      try {
        await middleware.sendMessage(ctx.from.id, Messenger.TELEGRAM, bodyHtml, {
          parse_mode: 'HTML', reply_markup: kb(buttons),
          most_rich_html: renderRich({ bodyHtml, buttons }),
          most_rich_fallback_notice: 'Демо: Rich HTML недоступен или отклонён сервером. Ниже обычная classic-карточка.',
        });
      } catch (err) {
        log.error('Rich demo delivery was not confirmed:', err);
        await middleware.reply(ctx, 'Не удалось подтвердить отправку демо. При неопределённом результате повторная отправка автоматически не выполняется.');
      }
      return true;
    }
    if (!privateStaff && !staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    if (p[1] === 'manual') {
      if (privateStaff) { await ctx.answerCbQuery('Ручная заявка создаётся в рабочей группе.', true); return true; }
      return await manualIntake.startDraft(ctx);
    }
    const view = (LIST_VIEWS.has(p[1]) ? p[1] : 'common') as db.StaffListView;
    // A personal list requested from the shared chat acknowledges after its DM delivery.
    if (p[1] === 'home' || privateStaff || !PERSONAL_VIEWS.has(view)) {
      if (privateStaff && LIST_VIEWS.has(p[1])) await ctx.answerCbQuery('Обновляю список заявок.');
      else await ctx.answerCbQuery();
    }
    if (p[1] === 'home') {
      await Promise.all([manualIntake.cancelActiveForHome(ctx), staffNameEditor.cancelForHome(ctx), resolutionCase.cancelForHome(ctx)]);
      if (privateStaff) await showStaffPrivateHome(ctx); else await showStaffHome(ctx);
    }
    else {
      const page = Number(p[2] ?? 0);
      if (!Number.isSafeInteger(page) || page < 0 || page > 100000) { await ctx.answerCbQuery('Некорректная страница.', true); return true; }
      await staffList(ctx, view, page);
    }
    return true;
  }
  if (p[0] === 'sn') return staffNameEditor.handleCallback(ctx, p);
  if (p[0] === 'ae') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    const aiTicket = await db.getTicketById(Number(p[2]), null);
    if (!aiTicket || !visibility.isCommonTicket(aiTicket) || !visibility.canViewTicket(String(ctx.from.id), aiTicket)) {
      await ctx.answerCbQuery('ИИ-панель личной заявки недоступна в общей группе.', true); return true;
    }
    return engineerUI.handleEngineerCallback(ctx, p);
  }
  if (p[0] === 'rs') {
    if (!staffSurface(ctx) && !isStaffPrivate(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    return resolutionCase.handleCallback(ctx, p);
  }
  if (p[0] === 'mi') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    return await manualIntake.handleDraftCallback(ctx, p);
  }
  if (p[0] !== 'tc') return false;
  const privateStaff = isStaffPrivate(ctx);
  if (!privateStaff && !staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
  const action = p[1], id = Number(p[2]);
  const ticket = await db.getTicketById(id, null);
  if (!ticket) { await ctx.answerCbQuery('Заявка не найдена.', true); return true; }
  const actor = ctx.from.id.toString();
  // Reads are denied before any ticket content is rendered; writes keep their owner/role checks below.
  if (!visibility.canViewTicket(actor, ticket)) {
    await ctx.answerCbQuery('Заявка недоступна: она личная у другого инженера.', true); return true;
  }
  if (!visibility.isCommonTicket(ticket) && !privateStaff && !['open', 'h', 'take'].includes(action)) {
    await ctx.answerCbQuery('Откройте личную карточку заявки в боте.', true); return true;
  }
  const mutation = !['open', 'h', 'cancel', 'closecancel', 'closehome', 'close'].includes(action);
  const version = ticket.routing?.version ?? +new Date(ticket.updated_at);
  if (privateStaff && mutation && p[p.length - 1] !== `v${version}`) {
    await ctx.answerCbQuery('Кнопка устарела. Обновите личную карточку.', true); return true;
  }
  const qmsg = ctx.callbackQuery.message;
  const canonicalBinding = ticket.staff_card_message_id === qmsg?.message_id && String(ticket.staff_card_chat_id) === String(qmsg?.chat.id)
    && (ticket.staff_card_thread_id || null) === (qmsg?.message_thread_id || null);
  if (!['open','h','xfer','close','closecancel','closehome','cancel'].includes(action) && !canonicalBinding && !privateStaff) {
    await refreshStaffCard(id); await ctx.answerCbQuery('Кнопка устарела. Откройте актуальную карточку.', true); return true;
  }
  if (action === 'open') {
    const ownPanel = privateStaff || visibility.isCommonTicket(ticket);
    if (ownPanel) await ctx.answerCbQuery();
    await refreshStaffCard(id);
    const current = await db.getTicketById(id, null) || ticket;
    if (!visibility.canViewTicket(actor, current)) { await ctx.answerCbQuery('Заявка больше недоступна.', true); return true; }
    const raw = String(current.staff_card_chat_id || cache.config.staffchat_id).replace(/^-100/, '');
    const url = current.staff_card_message_id ? `https://t.me/c/${raw}/${current.staff_card_message_id}${current.staff_card_thread_id ? `?thread=${current.staff_card_thread_id}` : ''}` : undefined;
    // Lifecycle buttons live only on the canonical card (stale-button guard); for a closed ticket point there for «Вернуть в работу».
    const closed = current.status === 'closed';
    const text = await cardText(current, privateStaff ? actor : undefined, !privateStaff)
      + (closed && !privateStaff ? '\n\nЧтобы вернуть заявку в работу, откройте постоянную карточку и нажмите «Вернуть в работу».' : '');
    const route = current.routing;
    const routeRows: Button[][] = privateStaff && route && current.status !== 'closed' ? [
      ...(!current.assigned_to ? [[{ text: 'Взять', callback_data: 'rt:take:' + id + ':' + route.version }]] : []),
      ...((route.offered_to === actor || current.assigned_to === actor || team.canPerformAction(actor, 'assign')) ? [
        [{ text: 'Передать', callback_data: 'rt:transfer:' + id + ':' + route.version },
          { text: 'Сделать общей', callback_data: 'rt:common:' + id + ':' + route.version }],
      ] : []),
    ] : [];
    const rows: Button[][] = privateStaff ? await privateButtons(current) : [
      ...routeRows,
      ...(url ? [[{ text: closed ? 'Перейти к карточке → «Вернуть в работу»' : 'Перейти к постоянной карточке', url }]] : []),
      [{ text: '🔄 Обновить', callback_data: `tc:open:${id}` }, { text: '📜 История', callback_data: `tc:h:${id}:0` }],
      [{ text: '⬅️ Назад', callback_data: closed ? 'tm:closed:0' : 'tm:common:0' }, STAFF_HOME]];
    if (!await visibility.freshTicket(current)) { await acknowledge(ctx, 'Заявка изменилась.', true); return true; }
    // «Открыть заявку» on a return record opens a fresh panel; the record stays in the feed for others.
    const fromNotice = p[3] === 'n' && !privateStaff;
    if (privateStaff || visibility.isCommonTicket(current)) await answer(ctx, text, rows, fromNotice, fromNotice);
    else await answerForTicket(ctx, current, text, rows);
    return true;
  }
  if (action === 'h') { await history(ctx, ticket, Number(p[3]) || 0, true); return true; }
  if (action === 'take') {
    const changed = ticket.routing ? await routing.routingCommand(id, actor, ticket.routing.version, 'take') : await ownership.takeTicket(id, actor); if (!changed) { await ctx.answerCbQuery('Заявка уже взята или неактивна.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.taken', id, actor, { owner: actor });
  } else if (action === 'wait' && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'open', 'waiting_user', ticket.assigned_to ?? undefined, undefined, ticket.routing?.version);
    if (!changed) { await ctx.answerCbQuery('Состояние изменилось. Карточка обновлена.', true); await refreshStaffCard(id); return true; }
    db.recordAnalyticsEventBestEffort('ticket.waiting', id, actor);
  } else if (action === 'resume' && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'waiting_user', 'open', ticket.assigned_to ?? undefined, undefined, ticket.routing?.version);
    if (!changed) { await ctx.answerCbQuery('Состояние изменилось. Карточка обновлена.', true); await refreshStaffCard(id); return true; }
    db.recordAnalyticsEventBestEffort('ticket.resumed', id, actor);
  } else if (action === 'closeask') {
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Нет прав или заявка уже закрыта.', true); return true; }
    // Closing always goes through the required explanation: cause and performed work first.
    return await resolutionCase.startClose(ctx, ticket);
  } else if (action === 'share' || action === 'unshare') {
    if (!ticket.assigned_to || !team.canManageTicket(actor, ticket.assigned_to)) {
      await ctx.answerCbQuery('Видимость меняет владелец заявки, руководитель или администратор.', true); return true;
    }
    if (ticket.routing && action === 'unshare') { await ctx.answerCbQuery('Общую заявку нужно взять в работу в личном чате.', true); return true; }
    const changed = ticket.routing ? await routing.routingCommand(id, actor, ticket.routing.version, 'common')
      : await db.setTicketCommonVisibility(id, action === 'share', ticket.assigned_to);
    if (changed?.routing) await routing.flushRoutingAudit(changed);
    if (!changed) { await refreshStaffCard(id); await ctx.answerCbQuery('Владелец или видимость заявки изменились.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.visibility_changed', id, actor, { common: action === 'share', owner: ticket.assigned_to });
  } else if (action === 'closecancel' || action === 'closehome') {
    if (!await db.clearPendingTicketAction(id, 'close', p[3], actor)) {
      await ctx.answerCbQuery('Подтверждение устарело.', true); return true;
    }
    const current = await db.getTicketById(id, null) || ticket;
    await renderTicketOnClickedCard(ctx, current);
    await ctx.answerCbQuery(action === 'closecancel' ? 'Закрытие отменено.' : undefined);
    if (action === 'closehome') await showStaffHome(ctx, true);
    return true;
  } else if (action === 'close') {
    // Historical «Да, закрыть» confirmations predate the required explanation: retire them, never close.
    if (!await db.clearPendingTicketAction(id, 'close', p[3], actor)) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    if (canonicalBinding) await renderTicketOnClickedCard(ctx, await db.getTicketById(id, null) || ticket);
    await ctx.answerCbQuery('Закрытие требует причины и выполненных работ. Нажмите «🔒 Закрыть» на карточке.', true); return true;
  }
  else if (action === 'reopen' && team.canPerformAction(actor, 'reply') && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'closed', 'open', ticket.assigned_to ?? undefined, undefined, ticket.routing?.version);
    if (!changed) { await refreshStaffCard(id); await ctx.answerCbQuery('Владелец или состояние изменились.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.reopened', id, actor);
  }
  else if (action === 'transfer') {
    if (!team.canManageTicket(actor, ticket.assigned_to)) { await ctx.answerCbQuery('Нет прав на передачу.', true); return true; }
    const token = randomUUID().replace(/-/g,'').slice(0,12);
    await db.setPendingTicketAction(id, 'transfer', token, actor, new Date(Date.now()+PROMPT_MS));
    const pending = await db.getTicketById(id, null);
    if (!pending || !visibility.canViewTicket(actor, pending)) return true;
    const transferVersion = pending.routing?.version ?? +new Date(pending.updated_at);
    const members = [...cache.staffMembers.values()];
    await answer(ctx, `Кому передать #T${id}?`, [
      ...members.map(m => [{ text: staffDisplayName(m.telegram_id), callback_data: `tc:xfer:${id}:${m.telegram_id}:${token}${privateStaff ? `:v${transferVersion}` : ''}` }]),
      [{ text: 'Отмена', callback_data: `tc:open:${id}` }, STAFF_HOME],
    ]); await ctx.answerCbQuery(); return true;
  } else if (action === 'xfer') {
    if (!team.getStaffRole(p[3]) || !await db.consumePendingTicketAction(id, 'transfer', p[4], actor)) { await ctx.answerCbQuery('Выбор устарел или сотрудник недоступен.', true); return true; }
    const expected = team.getStaffRole(actor) === 'agent' ? actor : undefined;
    const moved = ticket.routing ? await routing.routingCommand(id, actor, ticket.routing.version, 'transfer', p[3])
      : await ownership.transferTicket(id, p[3], expected);
    if (moved?.routing) { await routing.flushRoutingAudit(moved); await routing.deliverOffer(moved); }
    if (!moved) { await ctx.answerCbQuery('Владелец или состояние изменились.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.transferred', id, actor, { owner: p[3] });
  }
  else if (action === 'reply' || action === 'note') {
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Сначала возьмите активную заявку.', true); return true; }
    const chatId = String(ctx.chat.id), threadId = privateStaff ? null : qmsg!.message_thread_id || null;
    if (typeof db.clearExpiredReplyComposes === 'function')
      await db.clearExpiredReplyComposes(actor, chatId, threadId);
    if (typeof db.findAnyActiveManualDraft === 'function'
      && await db.findAnyActiveManualDraft(actor, chatId, threadId)) {
      await ctx.answerCbQuery('Сначала завершите или отмените создание ручной заявки.', true); return true;
    }
    if (typeof db.findActiveReplyCompose === 'function') {
      const active = await db.findActiveReplyCompose(actor, chatId, threadId);
      if (active) {
        await ctx.answerCbQuery(`У вас уже ожидается текст для #T${active.ticketId}. Сначала отправьте или отмените его.`, true);
        return true;
      }
    }
    if (typeof db.findStaffNameEdit === 'function' && await db.findStaffNameEdit(actor, chatId, threadId)) {
      await ctx.answerCbQuery('Сначала сохраните или отмените изменение имени.', true); return true;
    }
    if (typeof db.findResolutionIntent === 'function' && await db.findResolutionIntent(actor, chatId, threadId)) {
      await ctx.answerCbQuery('Сначала сохраните или отмените запись решения.', true); return true;
    }
    const mention = `<a href="tg://user?id=${e(actor)}">${e(staffDisplayName(actor))}</a>`;
    const manual = isManualTicket(ticket);
    // Compose is bound to the actor and the current private/group surface.
    const recipient = !visibility.isCommonTicket(ticket) ? 'личная заявка'
      : manual ? (ticket.external_client || ticket.name || 'ручная заявка') : (ticket.name || `ID ${ticket.userid}`);
    if (!await visibility.freshTicket(ticket)) { await ctx.answerCbQuery('Заявка изменилась.', true); return true; }
    const prompt = await middleware.sendMessage(chatId, ctx.messenger,
      action === 'note' ? `${mention}, 🔒 заметка для #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме. Заметка останется внутри команды.`
        : manual ? `${mention}, запишите результат по ручной заявке #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме. Клиенту ничего не отправляется.`
        : `${mention}, ответ клиенту по #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме — отвечать на сообщение Telegram не требуется.`,
      { parse_mode: 'HTML', reply_parameters: { message_id: qmsg!.message_id },
        message_thread_id: threadId || undefined });
    if (!prompt) { await ctx.answerCbQuery('Не удалось создать подсказку ответа.', true); return true; }
    const expectedOwner = ticket.assigned_to ?? undefined;
    let bound: ISupportee | null = null;
    try {
      bound = await db.setReplyPrompt(id, actor, Number(prompt), new Date(Date.now()+PROMPT_MS), action,
        expectedOwner, chatId, threadId, qmsg!.message_id, undefined, ticket.routing?.version, ticket.updated_at);
    } catch (err) {
      await TelegramAddon.getInstance().editMessage(chatId, Number(prompt),
        'Эта подсказка отменена: у вас уже есть активный ввод на этой поверхности.').catch(log.error);
      await ctx.answerCbQuery('У вас уже есть активный ввод. Сначала отправьте или отмените его.', true);
      return true;
    }
    if (!bound) {
      await TelegramAddon.getInstance().editMessage(chatId, Number(prompt), 'Эта подсказка отменена: владелец или состояние заявки изменились.').catch(log.error);
      await ctx.answerCbQuery('Владелец или состояние заявки изменились.', true); return true;
    }
    // The durable prompt itself explains the input; keep the panel free of duplicate hints.
    const fence = bound.pending_reply_version ?? prompt;
    await answer(ctx, 'Ввод открыт на 15 минут.', [
      [{text:'✖️ Отменить',callback_data:`tc:cancel:${id}:${fence}`}],
      [{ text: '⬅️ К заявке', callback_data: `tc:open:${id}` }, STAFF_HOME],
    ]); await ctx.answerCbQuery(); return true;
  } else if (action === 'cancel') {
    const fence = Number(p[3]);
    const matches = ticket.pending_reply_staff_id === actor
      && (ticket.pending_reply_version === fence || (ticket.pending_reply_version == null && ticket.pending_reply_prompt_id === fence));
    if (!matches) { await ctx.answerCbQuery('Эта кнопка отмены устарела.', true); return true; }
    const cleared = ticket.pending_reply_version == null
      ? await db.clearReplyPrompt(id, actor)
      : await db.clearReplyPrompt(id, actor, fence);
    if (ticket.pending_reply_version != null && !cleared) { await ctx.answerCbQuery('Эта кнопка отмены устарела.', true); return true; }
  }
  else { await ctx.answerCbQuery('Действие недоступно или нет прав.', true); return true; }
  if (action === 'share') await publishCommonReturn(id); else await refreshStaffCard(id);
  // close/xfer/cancel arrive from transient panels: replace their now-spent buttons with navigation.
  if (!canonicalBinding && (privateStaff || visibility.isCommonTicket(ticket))) await answer(ctx, `${doneText[action] || 'Готово.'} № ${id}`, [[{ text: '⬅️ К заявке', callback_data: `tc:open:${id}` }, STAFF_HOME]]);
  if (action === 'take') {
    const current = await db.getTicketById(id, null);
    if (current && current.assigned_to === actor) {
      const text = await cardText(current, actor), rows = await privateButtons(current);
      if (await visibility.freshTicket(current) && visibility.canViewTicket(actor, current)) await answerPrivately(ctx, text, rows);
    }
  }
  await ctx.answerCbQuery('Готово.'); return true;
}

/** Re-read after a command: ownership may have changed again before presentation. */
export async function refreshPrivateRoutingPanel(ctx: Context, ticketId: number): Promise<void> {
  if (!isStaffPrivate(ctx)) return;
  const t = await db.getTicketById(ticketId, null);
  const actor = String(ctx.from.id);
  if (!t || !visibility.canViewTicket(actor, t)) {
    await answer(ctx, 'Заявка больше недоступна.', [[STAFF_HOME]]); return;
  }
  const r = t.routing;
  const offered = r?.state === 'offered' && (r.offered_to === actor || team.canPerformAction(actor, 'assign'));
  const text = await cardText(t, actor);
  const rows: Button[][] = [
    ...(!offered ? await privateButtons(t) : []),
    ...(offered ? [[{text:'Взять',callback_data:`rt:take:${ticketId}:${r.version}`},
      {text:'Передать',callback_data:`rt:transfer:${ticketId}:${r.version}`},
      {text:'Сделать общей',callback_data:`rt:common:${ticketId}:${r.version}`}]] : []),
    [{text:'🔄 Обновить / открыть карточку',callback_data:`tc:open:${ticketId}`}], [STAFF_HOME],
  ];
  if (!await visibility.freshTicket(t) || !visibility.canViewTicket(actor, t)) return;
  await answer(ctx, text, rows);
}
