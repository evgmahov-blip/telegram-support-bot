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
import { staffDisplayName } from './staff-names';
import { isManualTicket, MANUAL_SOURCE_LABELS } from './manual-ticket-guard';
import { randomUUID } from 'crypto';

const PAGE = 6;
const PROMPT_MS = 15 * 60 * 1000;
export const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export type Button = { text: string; callback_data?: string; url?: string };
const kb = (rows: Button[][]) => ({ inline_keyboard: rows });
export const STAFF_HOME: Button = { text: '🏠 Главная', callback_data: 'tm:home:0' };
const USER_HOME: Button = { text: '🏠 Главная', callback_data: 'um:home:0' };
const statusName: Record<string, string> = { open: 'Открыт', waiting_user: 'Ждём клиента', closed: 'Закрыт' };
const priorityName: Record<string, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const eventName: Record<string, string> = {
  'ticket.closed': 'Тикет закрыт', 'ticket.reopened': 'Тикет открыт снова',
  'ticket.taken': 'Тикет взят в работу', 'ticket.assigned': 'Назначен инженер',
  'ticket.transferred': 'Тикет передан', 'ticket.waiting': 'Ожидание клиента',
  'ticket.resumed': 'Работа продолжена', 'ticket.created': 'Тикет создан',
};
const doneText: Record<string, string> = { close: 'Тикет закрыт:', xfer: 'Тикет передан:', cancel: 'Ожидание ответа отменено:' };

/** Staff-only actor label for history/audit rows; the Telegram ID is never rendered. */
function actorLabel(actor: unknown, metadata?: Record<string, unknown>): string {
  if (metadata?.closed_by === 'user') return 'клиент';
  return staffDisplayName(actor as string);
}
const fmt = (d: unknown) => d ? new Date(d as string).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : '—';

function staffButtons(t: ISupportee) {
  const id = t.ticketId;
  if (t.status === 'closed') return kb([
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '🔓 Вернуть в работу', callback_data: `tc:reopen:${id}` }],
    [{ text: '⬅️ Назад', callback_data: 'tm:closed:0' }, STAFF_HOME],
  ]);
  return kb([
    // A manual ticket has no client channel: «reply» only records work in its history.
    [{ text: '🙋 Взять', callback_data: `tc:take:${id}` }, { text: isManualTicket(t) ? '✍️ Записать ответ' : '✍️ Ответить', callback_data: `tc:reply:${id}` }],
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
  const manual = isManualTicket(ticket)
    ? `Ручная заявка · источник: ${e(MANUAL_SOURCE_LABELS[ticket.manual_source ?? 'other'] || 'Другое')}\n` +
      `Клиент: ${e(ticket.external_client || '—')}\nКонтакт: ${e(ticket.external_contact || '—')}\n` +
      `Создал: ${e(staffDisplayName(ticket.created_by))}\nКлиенту ничего не отправляется — ответы записываются в историю.\n`
    : '';
  return `<b>Тикет #T${String(ticket.ticketId).padStart(6, '0')}</b>\n` + manual +
    `Статус: <b>${e(statusName[ticket.status] || ticket.status)}</b>\n` +
    `Категория / очередь: ${e(ticket.category || 'Общая')}\n` +
    `Инженер: ${e(owner)}\nПриоритет: ${e(priorityName[ticket.priority] || ticket.priority)}\n` +
    `Создан: ${e(fmt(ticket.created_at))}\nОбновлён: ${e(fmt(ticket.updated_at))}\n\n` +
    `<b>Последнее сообщение</b>\n${e(preview)}`;
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
        await TelegramAddon.getInstance().editMessage(cardChatId, cardMessageId, text, opts);
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

export async function answer(ctx: Context, text: string, rows: Button[][]) {
  const q = ctx.callbackQuery?.message;
  if (q) {
    try {
      const correlated = typeof db.getTicketByInternalId === 'function' ? await db.getTicketByInternalId(q.message_id) : null;
      const canonical = correlated?.staff_card_message_id === q.message_id
        && String(correlated.staff_card_chat_id) === String(q.chat.id)
        && (correlated.staff_card_thread_id || null) === (q.message_thread_id || null);
      if (!canonical) {
        await TelegramAddon.getInstance().editMessage(q.chat.id, q.message_id, text, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
        });
        return;
      }
    } catch (err) {
      log.error('Не удалось обновить окно навигации, отправляю новое:', err);
    }
  }
  await middleware.reply(ctx, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    message_thread_id: ctx.message?.message_thread_id ?? q?.message_thread_id ?? undefined });
}

export async function showUserHome(ctx: Context) {
  await answer(ctx, '<b>Поддержка</b>\nВыберите действие:', [
    [{ text: '➕ Новое обращение', callback_data: 'um:new:0' }],
    [{ text: '📋 Мои обращения', callback_data: 'um:list:0' }, { text: '❓ Помощь', callback_data: 'um:help:0' }],
  ]);
}

export async function showStaffHome(ctx: Context) {
  await answer(ctx, '<b>Панель поддержки</b>', [
    [{ text: '🆕 Новые', callback_data: 'tm:new:0' }, { text: '🙋 Мои тикеты', callback_data: 'tm:mine:0' }],
    [{ text: '📂 Все активные', callback_data: 'tm:active:0' }, { text: '✅ Закрытые', callback_data: 'tm:closed:0' }],
    [{ text: '📝 Создать заявку вручную', callback_data: 'tm:manual:0' }],
  ]);
}

async function staffList(ctx: Context, view: 'new'|'mine'|'active'|'closed', page: number) {
  const fetched = await db.listStaffTickets(view, ctx.from.id.toString(), page, PAGE + 1, PAGE);
  const more = fetched.length > PAGE; const list = fetched.slice(0, PAGE);
  const rows: Button[][] = list.map(t => [{ text: `#${t.ticketId} · ${statusName[t.status]} · ${String(t.category || 'Общая').slice(0, 18)}${isManualTicket(t) ? ' · вручную' : ''}`, callback_data: `tc:open:${t.ticketId}` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `tm:${view}:${page-1}` });
  nav.push({ text: `${page+1}`, callback_data: 'noop' });
  if (more) nav.push({ text: '▶️', callback_data: `tm:${view}:${page+1}` });
  rows.push(nav);
  rows.push([{ text: '🏠 Главная', callback_data: 'tm:home:0' }]);
  await answer(ctx, `<b>${list.length ? 'Тикеты' : 'Тикетов нет'}</b>`, rows);
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
        ? (x.text === 'ticket.created' && x.metadata?.source === 'manual' ? 'Заявка создана вручную' : eventName[x.text] || 'Изменение тикета')
        : String(x.text).slice(0, 500);
      return `<b>${e(fmt(x.at))}</b>\n${e(`${label}: ${content}${owner}`)}`;
    }).join('\n\n') || 'История пуста.';
    const nav: Button[] = [
      ...(page > 0 ? [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page-1}` }] : []),
      ...(more ? [{ text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }] : []),
    ];
    await answer(ctx, `<b>История #T${ticket.ticketId}</b>\n\n${body}`, [
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
      .map(x => ({ at: x.timestamp, text: `Событие: ${eventName[x.type] || 'Изменение тикета'}${staff && x.agent_id ? ` · ${actorLabel(x.agent_id, x.metadata)}` : ''}${staff && x.metadata?.owner ? ` · владелец ${staffDisplayName(x.metadata.owner)}` : ''}` })),
    ...notes.map(n => ({ at: n.timestamp, text: `🔒 Заметка (${actorLabel(n.author_id)}): ${n.text.slice(0, 100)}` })),
  ].sort((a,b) => +new Date(a.at) - +new Date(b.at));
  const slice = items.slice(page * PAGE, page * PAGE + PAGE);
  const body = slice.map(x => `<b>${e(fmt(x.at))}</b>\n${e(x.text)}`).join('\n\n') || 'История пуста.';
  await answer(ctx, `<b>История #T${ticket.ticketId}</b>\n\n${body}`, [
    [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${Math.max(0,page-1)}` }, { text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }],
    [{ text: '⬅️ Назад', callback_data: `${staff?'tc':'uc'}:open:${ticket.ticketId}` }, { text: '🏠 Главная', callback_data: staff?'tm:home:0':'um:home:0' }],
  ]);
}

export async function handleCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery.data || '';
  if (data === 'noop') { await ctx.answerCbQuery(); return true; }
  const p = data.split(':');
  if (p[0] === 'um') {
    if (ctx.chat.type !== 'private') { await ctx.answerCbQuery('Доступно только в личном чате.', true); return true; }
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
    await ctx.answerCbQuery(); return true;
  }
  if (p[0] === 'uc') {
    const ticket = await db.getTicketById(Number(p[2]), null);
    if (!ticket || ticket.userid !== ctx.from.id.toString() || ctx.chat.type !== 'private') { await ctx.answerCbQuery('Обращение недоступно.', true); return true; }
    if (p[1] === 'h') await history(ctx, ticket, Number(p[3]) || 0, false);
    else {
      // Clients never reopen tickets themselves: a recurring problem goes through a new request or staff «Вернуть в работу».
      const closed = ticket.status === 'closed';
      await answer(ctx, `<b>Обращение #T${ticket.ticketId}</b>\nСтатус: ${e(statusName[ticket.status])}\nКатегория: ${e(ticket.category || 'Общая')}\nОбновлено: ${e(fmt(ticket.updated_at))}`
        + (closed ? '\n\nЕсли проблема повторилась, создайте новое обращение — поддержка сможет вернуть этот тикет в работу.' : ''), [
        [{ text: '📜 Сообщения', callback_data: `uc:h:${ticket.ticketId}:0` }],
        ...(closed ? [[{ text: '➕ Новое обращение', callback_data: 'um:new:0' }]] : []),
        [{ text: '⬅️ Назад', callback_data: 'um:list:0' }, USER_HOME],
      ]);
    }
    await ctx.answerCbQuery(); return true;
  }
  if (p[0] === 'tm') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    if (p[1] === 'manual') return await manualIntake.startDraft(ctx);
    if (p[1] === 'home') { await manualIntake.cancelActiveForHome(ctx); await showStaffHome(ctx); }
    else await staffList(ctx, p[1] as never, Number(p[2]) || 0);
    await ctx.answerCbQuery(); return true;
  }
  if (p[0] === 'mi') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    return await manualIntake.handleDraftCallback(ctx, p);
  }
  if (p[0] !== 'tc') return false;
  if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
  const action = p[1], id = Number(p[2]); const ticket = await db.getTicketById(id, null);
  if (!ticket) { await ctx.answerCbQuery('Тикет не найден.', true); return true; }
  const actor = ctx.from.id.toString();
  const qmsg = ctx.callbackQuery.message;
  const canonicalBinding = ticket.staff_card_message_id === qmsg?.message_id && String(ticket.staff_card_chat_id) === String(qmsg?.chat.id)
    && (ticket.staff_card_thread_id || null) === (qmsg?.message_thread_id || null);
  if (!['open','h','xfer','close','cancel'].includes(action) && !canonicalBinding) {
    await refreshStaffCard(id); await ctx.answerCbQuery('Кнопка устарела. Откройте актуальную карточку.', true); return true;
  }
  if (action === 'open') {
    await refreshStaffCard(id);
    const current = await db.getTicketById(id, null) || ticket;
    const raw = String(current.staff_card_chat_id || cache.config.staffchat_id).replace(/^-100/, '');
    const url = current.staff_card_message_id ? `https://t.me/c/${raw}/${current.staff_card_message_id}${current.staff_card_thread_id ? `?thread=${current.staff_card_thread_id}` : ''}` : undefined;
    // Lifecycle buttons live only on the canonical card (stale-button guard); for a closed ticket point there for «Вернуть в работу».
    const closed = current.status === 'closed';
    await answer(ctx, await cardText(current) + (closed ? '\n\nЧтобы вернуть тикет в работу, откройте постоянную карточку и нажмите «Вернуть в работу».' : ''), [
      ...(url ? [[{ text: closed ? 'Перейти к карточке → «Вернуть в работу»' : 'Перейти к постоянной карточке', url }]] : []),
      [{ text: '📜 История', callback_data: `tc:h:${id}:0` }],
      [{ text: '⬅️ Назад', callback_data: closed ? 'tm:closed:0' : 'tm:active:0' }, STAFF_HOME]]);
    await ctx.answerCbQuery(); return true;
  }
  if (action === 'h') { await history(ctx, ticket, Number(p[3]) || 0, true); await ctx.answerCbQuery(); return true; }
  if (action === 'take') {
    const changed = await ownership.takeTicket(id, actor); if (!changed) { await ctx.answerCbQuery('Тикет уже взят или неактивен.', true); return true; }
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
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Нет прав или тикет уже закрыт.', true); return true; }
    const token = randomUUID().replace(/-/g,'').slice(0,12);
    await db.setPendingTicketAction(id, 'close', token, actor, new Date(Date.now()+PROMPT_MS));
    await answer(ctx, `Закрыть тикет #T${id}?`, [[{text:'Да, закрыть',callback_data:`tc:close:${id}:${token}`},{text:'Отмена',callback_data:`tc:open:${id}`}], [STAFF_HOME]]); await ctx.answerCbQuery(); return true;
  } else if (action === 'close' && team.canManageTicket(actor, ticket.assigned_to)) {
    if (!await db.consumePendingTicketAction(id, 'close', p[3], actor)) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    const result = await ticketState.closeTicketLifecycle(ticket, actor, team.getStaffRole(actor)==='agent'?actor:undefined);
    if (result.outcome !== 'closed') { await refreshStaffCard(id); await ctx.answerCbQuery(result.outcome === 'already_closed' ? 'Тикет уже закрыт.' : 'Владелец или состояние изменились.', true); return true; }
    if (result.notificationFailed) await middleware.reply(ctx, 'Тикет закрыт, но уведомление клиенту не доставлено.');
    if (isManualTicket(ticket)) await middleware.reply(ctx, `Ручная заявка #T${id} закрыта. Клиент не уведомлялся: канала доставки нет.`);
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
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Сначала возьмите активный тикет.', true); return true; }
    const mention = `<a href="tg://user?id=${e(actor)}">${e(staffDisplayName(actor))}</a>`;
    const manual = isManualTicket(ticket);
    const prompt = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
      action === 'note' ? `${mention}, 🔒 заметка для #T${id}: ответьте на это сообщение текстом заметки.`
        : manual ? `${mention}, запишите ответ/результат по ручной заявке #T${id}: ответьте на это сообщение. Текст сохранится в истории; клиенту ничего не отправляется.`
        : `${mention}, ответ для #T${id}: ответьте на это сообщение. Другие сообщения группы не будут отправлены клиенту.`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: qmsg!.message_id },
        message_thread_id: cache.config.staffchat_thread_id || undefined });
    if (!prompt) { await ctx.answerCbQuery('Не удалось создать подсказку ответа.', true); return true; }
    const bound = await db.setReplyPrompt(id, actor, Number(prompt), new Date(Date.now()+PROMPT_MS), action,
      team.getStaffRole(actor)==='agent'?actor:undefined);
    if (!bound) {
      await TelegramAddon.getInstance().editMessage(cache.config.staffchat_id, Number(prompt), 'Эта подсказка отменена: владелец или состояние тикета изменились.').catch(log.error);
      await ctx.answerCbQuery('Владелец или состояние тикета изменились.', true); return true;
    }
    // Telegram cannot attach inline buttons to the ForceReply prompt, so this separate panel carries cancel/navigation.
    await answer(ctx, `${action === 'note' ? 'Ожидаю заметку' : manual ? 'Ожидаю запись ответа' : 'Ожидаю ответ'} для #T${id} 15 минут: ответьте на подсказку бота.`, [
      [{text:'Отменить',callback_data:`tc:cancel:${id}:${prompt}`}],
      [{ text: '⬅️ К тикету', callback_data: `tc:open:${id}` }, STAFF_HOME],
    ]); await ctx.answerCbQuery(); return true;
  } else if (action === 'cancel') {
    if (ticket.pending_reply_prompt_id !== Number(p[3]) || ticket.pending_reply_staff_id !== actor) { await ctx.answerCbQuery('Эта кнопка отмены устарела.', true); return true; }
    await db.clearReplyPrompt(id, actor);
  }
  else { await ctx.answerCbQuery('Действие недоступно или нет прав.', true); return true; }
  await refreshStaffCard(id);
  // close/xfer/cancel arrive from transient panels: replace their now-spent buttons with navigation.
  if (!canonicalBinding) await answer(ctx, `${doneText[action] || 'Готово.'} #T${id}`, [[{ text: '⬅️ К тикету', callback_data: `tc:open:${id}` }, STAFF_HOME]]);
  await ctx.answerCbQuery('Готово.'); return true;
}
