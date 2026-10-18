import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as ownership from './ticket-ownership';
import * as ticketState from './ticket-state';
import * as middleware from './middleware';
import * as log from './logger';
import TelegramAddon from './addons/telegram';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as ticketAudit from './ticket-audit';
import * as manualIntake from './manual-intake';
import * as staffNameEditor from './staff-name-editor';
import { staffDisplayName } from './staff-names';
import { isManualTicket, MANUAL_SOURCE_LABELS } from './manual-ticket-guard';
import { randomUUID } from 'crypto';

const PAGE = 6;
const PROMPT_MS = 15 * 60 * 1000;
const RENDER_CACHE_LIMIT = 256;
export const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
};
const doneText: Record<string, string> = { close: 'Заявка закрыта:', xfer: 'Заявка передана:', cancel: 'Ожидание ответа отменено:' };
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
  return JSON.stringify({ text, markup: { inline_keyboard: rows }, parseMode });
}

async function editRendered(chatId: string | number, messageId: number, text: string, rows: Button[][]): Promise<boolean> {
  const key = messageKey(chatId, messageId); const signature = renderSignature(text, rows);
  if (renderedMessages.get(key) === signature) return false;
  try {
    await TelegramAddon.getInstance().editMessage(chatId, messageId, text, {
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

function staffButtons(t: ISupportee) {
  const id = t.ticketId;
  if (t.status === 'closed') return kb([
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '🔓 Вернуть в работу', callback_data: `tc:reopen:${id}` }],
    [{ text: '⬅️ Назад', callback_data: 'tm:closed:0' }, STAFF_HOME],
  ]);
  return kb([
    // A manual ticket has no client channel: «reply» only records work in its history.
    [{ text: '🙋 Взять', callback_data: `tc:take:${id}` }, { text: isManualTicket(t) ? '📝 Записать ответ' : '✉️ Написать клиенту', callback_data: `tc:reply:${id}` }],
    [{ text: t.status === 'waiting_user' ? '▶️ Продолжить работу' : '⏳ Ждём клиента', callback_data: `tc:${t.status === 'waiting_user' ? 'resume' : 'wait'}:${id}` }, { text: '👤 Передать', callback_data: `tc:transfer:${id}` }],
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '📝 Заметка', callback_data: `tc:note:${id}` }],
    [{ text: '🔒 Закрыть', callback_data: `tc:closeask:${id}` }],
    [{ text: '⬅️ Назад', callback_data: 'tm:active:0' }, STAFF_HOME],
  ]);
}

export async function cardText(ticket: ISupportee): Promise<string> {
  const latest = typeof db.getLatestTicketMessage === 'function' ? await db.getLatestTicketMessage(ticket.ticketId) : null;
  const owner = ticket.assigned_to ? staffDisplayName(ticket.assigned_to) : 'Не назначен';
  const preview = latest?.text ? latest.text.replace(/\s+/g, ' ').slice(0, 240) : 'Сообщений пока нет';
  // External client data is rendered on the staff card only; clients never see manual tickets.
  const manual = isManualTicket(ticket);
  const client = manual ? (ticket.external_client || ticket.name || 'Не указан') : (ticket.name || 'Не указан');
  const details = [
    manual && ticket.manual_source ? `Источник: ${e(MANUAL_SOURCE_LABELS[ticket.manual_source] || 'Другое')}` : '',
    `Клиент: ${e(client)}`,
    manual && ticket.external_contact ? `Контакт: ${e(ticket.external_contact)}` : '',
    ticket.category && !/^(общая|general|common)$/i.test(ticket.category) ? `Категория: ${e(ticket.category)}` : '',
    ticket.priority && ticket.priority !== 'normal' ? `Приоритет: ${e(priorityName[ticket.priority] || ticket.priority)}` : '',
  ].filter(Boolean).join('\n');
  return `<b>Заявка #${ticket.ticketId}</b>\n` +
    `Статус: <b>${e(statusName[ticket.status] || ticket.status)}</b>\n` +
    `${details}\nИнженер: ${e(owner)}\n\n` +
    `<b>${manual ? 'Описание / последняя запись' : 'Последнее сообщение'}</b>\n${e(preview)}`;
}

export async function refreshStaffCard(ticketId: number): Promise<void> {
  try {
    if (typeof db.getTicketById !== 'function') return;
    let ticket = await db.getTicketById(ticketId, null);
    if (!ticket) return;
    if (ticket.staff_card_message_id && ticket.staff_card_chat_id) {
      const cardChatId = ticket.staff_card_chat_id;
      const cardMessageId = ticket.staff_card_message_id;
      try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const text = await cardText(ticket);
        const opts = { parse_mode: 'HTML', reply_markup: staffButtons(ticket) };
        const rows = (opts.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard;
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
    const text = await cardText(ticket);
    const opts = { parse_mode: 'HTML', reply_markup: staffButtons(ticket) };
    if (typeof db.claimStaffCard !== 'function') return;
    const claim = randomUUID();
    const claimed = await db.claimStaffCard(ticketId, claim);
    if (!claimed) return;
    let messageId: string | null = null;
    try { messageId = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type, text, opts); }
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

function staffSurface(ctx: Context): boolean {
  const q = ctx.callbackQuery.message;
  if (!ctx.session.admin || !team.getStaffRole(ctx.from.id.toString()) || !q) return false;
  if (String(q.chat.id) !== String(cache.config.staffchat_id)) return false;
  return !cache.config.staffchat_thread_id || q.message_thread_id === cache.config.staffchat_thread_id;
}

export async function answer(ctx: Context, text: string, rows: Button[][], visibleFlow = false) {
  const q = ctx.callbackQuery?.message;
  if (q) {
    try {
      const correlated = typeof db.getTicketByInternalId === 'function' ? await db.getTicketByInternalId(q.message_id) : null;
      const canonical = correlated?.staff_card_message_id === q.message_id
        && String(correlated.staff_card_chat_id) === String(q.chat.id)
        && (correlated.staff_card_thread_id || null) === (q.message_thread_id || null);
      if (!canonical) {
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
          log.error('Не удалось переиспользовать окно навигации, отправляю новое:', err);
        }
      }
    } catch (err) {
      log.error('Не удалось обновить окно навигации, отправляю новое:', err);
    }
  }
  const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
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
  await answer(ctx, '<b>Поддержка</b>\nВыберите действие:', [
    [{ text: '➕ Новое обращение', callback_data: 'um:new:0' }],
    [{ text: '📋 Мои обращения', callback_data: 'um:list:0' }, { text: '❓ Помощь', callback_data: 'um:help:0' }],
  ]);
}

export async function showStaffHome(ctx: Context, visibleFlow = false) {
  const rows: Button[][] = [
    [{ text: '🆕 Новые', callback_data: 'tm:new:0' }, { text: '🙋 Мои заявки', callback_data: 'tm:mine:0' }],
    [{ text: '📂 Все активные', callback_data: 'tm:active:0' }, { text: '✅ Закрытые', callback_data: 'tm:closed:0' }],
    [{ text: '📝 Создать заявку вручную', callback_data: 'tm:manual:0' }],
  ];
  if (team.canPerformAction(ctx.from.id.toString(), 'manage_team')) rows.push([{ text: '👥 Инженеры', callback_data: 'sn:list:0' }]);
  await answer(ctx, '<b>Панель поддержки</b>', rows, visibleFlow);
}

async function renderTicketOnClickedCard(ctx: Context, ticket: ISupportee, outcome?: string) {
  const q = ctx.callbackQuery.message!;
  const text = await cardText(ticket) + (outcome ? `\n\n${e(outcome)}` : '');
  await editRendered(q.chat.id, q.message_id, text,
    (staffButtons(ticket).inline_keyboard as Button[][]));
}

async function staffList(ctx: Context, view: 'new'|'mine'|'active'|'closed', page: number) {
  const fetched = await db.listStaffTickets(view, ctx.from.id.toString(), page, PAGE + 1, PAGE);
  const more = fetched.length > PAGE; const list = fetched.slice(0, PAGE);
  const rows: Button[][] = list.map(t => [{ text: `#${t.ticketId} · ${statusName[t.status]} · ${String(t.category || 'Общая').slice(0, 18)}${isManualTicket(t) ? ' · вручную' : ''}`, callback_data: `tc:open:${t.ticketId}` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `tm:${view}:${page-1}` });
  if (more) nav.push({ text: '▶️', callback_data: `tm:${view}:${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🏠 Главная', callback_data: 'tm:home:0' }]);
  const pageText = page > 0 || more ? `\nСтраница ${page + 1}` : '';
  await answer(ctx, `<b>${list.length ? 'Заявки' : 'Заявок нет'}</b>${pageText}`, rows);
}

async function history(ctx: Context, ticket: ISupportee, page: number, staff: boolean) {
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
        ? (x.text === 'ticket.created' && x.metadata?.source === 'manual' ? 'Заявка создана вручную' : eventName[x.text] || 'Изменение заявки')
        : String(x.text).slice(0, 500);
      return `<b>${e(fmt(x.at))}</b>\n${e(`${label}: ${content}${owner}`)}`;
    }).join('\n\n') || 'История пуста.';
    const nav: Button[] = [
      ...(page > 0 ? [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page-1}` }] : []),
      ...(more ? [{ text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }] : []),
    ];
    await answer(ctx, `<b>История заявки № ${ticket.ticketId}</b>\n\n${body}`, [
      ...(nav.length ? [nav] : []),
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
  await answer(ctx, `<b>История заявки № ${ticket.ticketId}</b>\n\n${body}`, [
    [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${Math.max(0,page-1)}` }, { text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }],
    [{ text: '⬅️ Назад', callback_data: `${staff?'tc':'uc'}:open:${ticket.ticketId}` }, { text: '🏠 Главная', callback_data: staff?'tm:home:0':'um:home:0' }],
  ]);
}

export async function handleCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery.data || '';
  if (data === 'noop') { await ctx.answerCbQuery('Это номер страницы. Используйте стрелки для перехода.', true); return true; }
  const p = data.split(':');
  if (p[0] === 'um') {
    if (ctx.chat.type !== 'private') { await ctx.answerCbQuery('Доступно только в личном чате.', true); return true; }
    const navigation = p[1] !== 'new';
    if (navigation) await ctx.answerCbQuery();
    if (p[1] === 'home') await showUserHome(ctx);
    else if (p[1] === 'new') {
      await db.requestNewTicket(ctx.from.id.toString(), ctx.messenger);
      await middleware.reply(ctx, 'Опишите вопрос одним сообщением. Обращение будет создано после отправки.', {
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
      await answer(ctx, `<b>Обращение № ${ticket.ticketId}</b>\nСтатус: ${e(statusName[ticket.status])}${category}`
        + (closed ? '\n\nЕсли проблема повторилась, создайте новое обращение — поддержка сможет вернуть эту заявку в работу.' : ''), [
        [{ text: '📜 Сообщения', callback_data: `uc:h:${ticket.ticketId}:0` }],
        ...(closed ? [[{ text: '➕ Новое обращение', callback_data: 'um:new:0' }]] : []),
        [{ text: '⬅️ Назад', callback_data: 'um:list:0' }, USER_HOME],
      ]);
    }
    return true;
  }
  if (p[0] === 'tm') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    if (p[1] === 'manual') return await manualIntake.startDraft(ctx);
    await ctx.answerCbQuery();
    if (p[1] === 'home') { await Promise.all([manualIntake.cancelActiveForHome(ctx), staffNameEditor.cancelForHome(ctx)]); await showStaffHome(ctx); }
    else await staffList(ctx, p[1] as never, Number(p[2]) || 0);
    return true;
  }
  if (p[0] === 'sn') return staffNameEditor.handleCallback(ctx, p);
  if (p[0] === 'mi') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    return await manualIntake.handleDraftCallback(ctx, p);
  }
  if (p[0] !== 'tc') return false;
  if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
  const action = p[1], id = Number(p[2]); const ticket = await db.getTicketById(id, null);
  if (!ticket) { await ctx.answerCbQuery('Заявка не найдена.', true); return true; }
  const actor = ctx.from.id.toString();
  const qmsg = ctx.callbackQuery.message;
  const canonicalBinding = ticket.staff_card_message_id === qmsg?.message_id && String(ticket.staff_card_chat_id) === String(qmsg?.chat.id)
    && (ticket.staff_card_thread_id || null) === (qmsg?.message_thread_id || null);
  if (!['open','h','xfer','close','closecancel','closehome','cancel'].includes(action) && !canonicalBinding) {
    await refreshStaffCard(id); await ctx.answerCbQuery('Кнопка устарела. Откройте актуальную карточку.', true); return true;
  }
  if (action === 'open') {
    await ctx.answerCbQuery();
    await refreshStaffCard(id);
    const current = await db.getTicketById(id, null) || ticket;
    const raw = String(current.staff_card_chat_id || cache.config.staffchat_id).replace(/^-100/, '');
    const url = current.staff_card_message_id ? `https://t.me/c/${raw}/${current.staff_card_message_id}${current.staff_card_thread_id ? `?thread=${current.staff_card_thread_id}` : ''}` : undefined;
    // Lifecycle buttons live only on the canonical card (stale-button guard); for a closed ticket point there for «Вернуть в работу».
    const closed = current.status === 'closed';
    await answer(ctx, await cardText(current) + (closed ? '\n\nЧтобы вернуть заявку в работу, откройте постоянную карточку и нажмите «Вернуть в работу».' : ''), [
      ...(url ? [[{ text: closed ? 'Перейти к карточке → «Вернуть в работу»' : 'Перейти к постоянной карточке', url }]] : []),
      [{ text: '📜 История', callback_data: `tc:h:${id}:0` }],
      [{ text: '⬅️ Назад', callback_data: closed ? 'tm:closed:0' : 'tm:active:0' }, STAFF_HOME]]);
    return true;
  }
  if (action === 'h') { await ctx.answerCbQuery(); await history(ctx, ticket, Number(p[3]) || 0, true); return true; }
  if (action === 'take') {
    const changed = await ownership.takeTicket(id, actor); if (!changed) { await ctx.answerCbQuery('Заявка уже взята или неактивна.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.taken', id, actor, { owner: actor });
  } else if (action === 'wait' && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'open', 'waiting_user', team.getStaffRole(actor)==='agent'?actor:undefined);
    if (!changed) { await ctx.answerCbQuery('Состояние изменилось. Карточка обновлена.', true); await refreshStaffCard(id); return true; }
    db.recordAnalyticsEventBestEffort('ticket.waiting', id, actor);
  } else if (action === 'resume' && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'waiting_user', 'open', team.getStaffRole(actor)==='agent'?actor:undefined);
    if (!changed) { await ctx.answerCbQuery('Состояние изменилось. Карточка обновлена.', true); await refreshStaffCard(id); return true; }
    db.recordAnalyticsEventBestEffort('ticket.resumed', id, actor);
  } else if (action === 'closeask') {
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Нет прав или заявка уже закрыта.', true); return true; }
    const token = randomUUID().replace(/-/g,'').slice(0,12);
    const pending = await db.setPendingTicketAction(id, 'close', token, actor, new Date(Date.now()+PROMPT_MS));
    if (!pending) { await ctx.answerCbQuery('Состояние изменилось. Карточка обновлена.', true); await refreshStaffCard(id); return true; }
    try {
      await editRendered(qmsg!.chat.id, qmsg!.message_id,
        `${await cardText(ticket)}\n\n<b>Закрыть заявку № ${id}?</b>`, [
          [{text:'Да, закрыть',callback_data:`tc:close:${id}:${token}`},{text:'Отмена',callback_data:`tc:closecancel:${id}:${token}`}],
          [{text:'🏠 Главная',callback_data:`tc:closehome:${id}:${token}`}],
        ]);
    } catch (err) {
      await db.clearPendingTicketAction(id, 'close', token, actor).catch(log.error);
      throw err;
    }
    await ctx.answerCbQuery(); return true;
  } else if (action === 'closecancel' || action === 'closehome') {
    if (!await db.clearPendingTicketAction(id, 'close', p[3], actor)) {
      await ctx.answerCbQuery('Подтверждение устарело.', true); return true;
    }
    const current = await db.getTicketById(id, null) || ticket;
    await renderTicketOnClickedCard(ctx, current);
    await ctx.answerCbQuery(action === 'closecancel' ? 'Закрытие отменено.' : undefined);
    if (action === 'closehome') await showStaffHome(ctx, true);
    return true;
  } else if (action === 'close' && team.canManageTicket(actor, ticket.assigned_to)) {
    if (!await db.consumePendingTicketAction(id, 'close', p[3], actor)) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    let result;
    try {
      result = await ticketState.closeTicketLifecycle(ticket, actor, team.getStaffRole(actor)==='agent'?actor:undefined);
    } catch (err) {
      log.error(`Не удалось закрыть заявку #T${id}:`, err);
      const current = await db.getTicketById(id, null) || ticket;
      await renderTicketOnClickedCard(ctx, current, 'Не удалось закрыть заявку. Попробуйте ещё раз.');
      await ctx.answerCbQuery('Не удалось закрыть заявку.', true); return true;
    }
    if (result.outcome !== 'closed') {
      const current = await db.getTicketById(id, null) || result.ticket || ticket;
      await renderTicketOnClickedCard(ctx, current);
      await ctx.answerCbQuery(result.outcome === 'already_closed' ? 'Заявка уже закрыта.' : 'Владелец или состояние изменились.', true); return true;
    }
    await renderTicketOnClickedCard(ctx, result.ticket!, 'Заявка закрыта.');
    if (result.notificationFailed) await middleware.reply(ctx, 'Заявка закрыта, но уведомление клиенту не доставлено.');
    if (isManualTicket(ticket)) await middleware.reply(ctx, `Ручная заявка #T${id} закрыта. Клиент не уведомлялся: канала доставки нет.`);
    await ctx.answerCbQuery('Готово.'); return true;
  }
  else if (action === 'reopen' && team.canPerformAction(actor, 'reply') && team.canManageTicket(actor, ticket.assigned_to)) {
    const changed = await ticketState.transitionTicketStateFrom(id, 'closed', 'open', team.getStaffRole(actor)==='agent'?actor:undefined);
    if (!changed) { await refreshStaffCard(id); await ctx.answerCbQuery('Владелец или состояние изменились.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.reopened', id, actor);
  }
  else if (action === 'transfer') {
    if (!team.canManageTicket(actor, ticket.assigned_to)) { await ctx.answerCbQuery('Нет прав на передачу.', true); return true; }
    const token = randomUUID().replace(/-/g,'').slice(0,12);
    await db.setPendingTicketAction(id, 'transfer', token, actor, new Date(Date.now()+PROMPT_MS));
    const members = [...cache.staffMembers.values()];
    await answer(ctx, `Кому передать #T${id}?`, [
      ...members.map(m => [{ text: staffDisplayName(m.telegram_id), callback_data: `tc:xfer:${id}:${m.telegram_id}:${token}` }]),
      [{ text: 'Отмена', callback_data: `tc:open:${id}` }, STAFF_HOME],
    ]); await ctx.answerCbQuery(); return true;
  } else if (action === 'xfer') {
    if (!team.getStaffRole(p[3]) || !await db.consumePendingTicketAction(id, 'transfer', p[4], actor)) { await ctx.answerCbQuery('Выбор устарел или сотрудник недоступен.', true); return true; }
    const expected = team.getStaffRole(actor) === 'agent' ? actor : undefined;
    const moved = await ownership.transferTicket(id, p[3], expected);
    if (!moved) { await ctx.answerCbQuery('Владелец или состояние изменились.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.transferred', id, actor, { owner: p[3] });
  }
  else if (action === 'reply' || action === 'note') {
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Сначала возьмите активную заявку.', true); return true; }
    const chatId = String(qmsg!.chat.id), threadId = qmsg!.message_thread_id || null;
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
    const mention = `<a href="tg://user?id=${e(actor)}">${e(staffDisplayName(actor))}</a>`;
    const manual = isManualTicket(ticket);
    const recipient = manual ? (ticket.external_client || ticket.name || 'ручная заявка') : (ticket.name || `ID ${ticket.userid}`);
    const prompt = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
      action === 'note' ? `${mention}, 🔒 заметка для #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме. Заметка останется внутри команды.`
        : manual ? `${mention}, запишите результат по ручной заявке #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме. Клиенту ничего не отправляется.`
        : `${mention}, ответ клиенту по #T${id} (${e(recipient)}). Отправьте следующим обычным текстовым сообщением в этой теме — отвечать на сообщение Telegram не требуется.`,
      { parse_mode: 'HTML', reply_parameters: { message_id: qmsg!.message_id },
        message_thread_id: threadId || undefined });
    if (!prompt) { await ctx.answerCbQuery('Не удалось создать подсказку ответа.', true); return true; }
    const expectedOwner = team.getStaffRole(actor)==='agent'?actor:undefined;
    let bound: ISupportee | null = null;
    try {
      bound = typeof db.findActiveReplyCompose === 'function'
        ? await db.setReplyPrompt(id, actor, Number(prompt), new Date(Date.now()+PROMPT_MS), action,
          expectedOwner, chatId, threadId, qmsg!.message_id)
        : await db.setReplyPrompt(id, actor, Number(prompt), new Date(Date.now()+PROMPT_MS), action, expectedOwner);
    } catch (err) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(prompt),
        'Эта подсказка отменена: у вас уже есть активный ввод на этой поверхности.').catch(log.error);
      await ctx.answerCbQuery('У вас уже есть активный ввод. Сначала отправьте или отмените его.', true);
      return true;
    }
    if (!bound) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(prompt), 'Эта подсказка отменена: владелец или состояние заявки изменились.').catch(log.error);
      await ctx.answerCbQuery('Владелец или состояние заявки изменились.', true); return true;
    }
    // A separate panel keeps cancellation/navigation visible while the next ordinary text is awaited.
    const fence = bound.pending_reply_version ?? prompt;
    await answer(ctx, `${action === 'note' ? 'Ожидаю заметку' : manual ? 'Ожидаю запись ответа' : 'Ожидаю ответ'} для #T${id} (${e(recipient)}) 15 минут: отправьте следующий обычный текст в этой теме.`, [
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
  await refreshStaffCard(id);
  // close/xfer/cancel arrive from transient panels: replace their now-spent buttons with navigation.
  if (!canonicalBinding) await answer(ctx, `${doneText[action] || 'Готово.'} № ${id}`, [[{ text: '⬅️ К заявке', callback_data: `tc:open:${id}` }, STAFF_HOME]]);
  await ctx.answerCbQuery('Готово.'); return true;
}
