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
import { randomUUID } from 'crypto';

const PAGE = 6;
const PROMPT_MS = 15 * 60 * 1000;
const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type Button = { text: string; callback_data?: string; url?: string };
const kb = (rows: Button[][]) => ({ inline_keyboard: rows });
const statusName: Record<string, string> = { open: 'Открыт', waiting_user: 'Ждём клиента', closed: 'Закрыт' };
const priorityName: Record<string, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const eventName: Record<string, string> = {
  'ticket.closed': 'Тикет закрыт', 'ticket.reopened': 'Тикет открыт снова',
  'ticket.taken': 'Тикет взят в работу', 'ticket.assigned': 'Назначен инженер',
  'ticket.transferred': 'Тикет передан', 'ticket.waiting': 'Ожидание клиента',
  'ticket.resumed': 'Работа продолжена',
};
const fmt = (d: unknown) => d ? new Date(d as string).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC' : '—';

function staffButtons(t: ISupportee) {
  const id = t.ticketId;
  if (t.status === 'closed') return kb([
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '🔓 Открыть снова', callback_data: `tc:reopen:${id}` }],
    [{ text: '⬅️ Назад', callback_data: 'tm:active:0' }, { text: '🏠 Главная', callback_data: 'tm:home:0' }],
  ]);
  return kb([
    [{ text: '🙋 Взять', callback_data: `tc:take:${id}` }, { text: '✍️ Ответить', callback_data: `tc:reply:${id}` }],
    [{ text: '⏳ Ждём клиента', callback_data: `tc:wait:${id}` }, { text: '👤 Передать', callback_data: `tc:transfer:${id}` }],
    [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '📝 Заметка', callback_data: `tc:note:${id}` }],
    [{ text: '🔒 Закрыть', callback_data: `tc:closeask:${id}` }],
    [{ text: '⬅️ Назад', callback_data: 'tm:active:0' }, { text: '🏠 Главная', callback_data: 'tm:home:0' }],
  ]);
}

export async function cardText(ticket: ISupportee): Promise<string> {
  const latest = typeof db.getLatestTicketMessage === 'function' ? await db.getLatestTicketMessage(ticket.ticketId) : null;
  const owner = ticket.assigned_to ? cache.staffMembers.get(ticket.assigned_to)?.name || ticket.assigned_to : 'Не назначен';
  const preview = latest?.text ? latest.text.replace(/\s+/g, ' ').slice(0, 240) : 'Сообщений пока нет';
  return `<b>Тикет #T${String(ticket.ticketId).padStart(6, '0')}</b>\n` +
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
    const text = await cardText(ticket);
    const opts = { parse_mode: 'HTML', reply_markup: staffButtons(ticket) };
    if (ticket.staff_card_message_id && ticket.staff_card_chat_id) {
      try {
      await TelegramAddon.getInstance().editMessage(ticket.staff_card_chat_id, ticket.staff_card_message_id, text, opts);
      return;
      } catch (err) {
        const description = String((err as { description?: string }).description || err);
        if (!/message to edit not found|message can't be edited|message can.t be edited/i.test(description)
          || typeof db.clearStaffCardBinding !== 'function') {
          log.error(`Не удалось обновить карточку #T${ticketId}:`, err);
          return; // Ambiguous failure: never risk a duplicate canonical card.
        }
        const cleared = await db.clearStaffCardBinding(ticketId, String(ticket.staff_card_chat_id), ticket.staff_card_message_id);
        if (!cleared) return; // Another worker already repaired or replaced it.
        ticket = cleared;
      }
    }
    if (typeof db.claimStaffCard !== 'function') return;
    const claim = randomUUID();
    const claimed = await db.claimStaffCard(ticketId, claim);
    if (!claimed) return;
    let messageId: string | null = null;
    try { messageId = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type, text, opts); }
    catch (err) { await db.releaseStaffCardClaim(ticketId, claim); throw err; }
    if (!messageId) { await db.releaseStaffCardClaim(ticketId, claim); return; }
    const bound = await db.bindStaffCard(ticketId, claim, String(cache.config.staffchat_id), Number(messageId), cache.config.staffchat_thread_id || null);
    if (!bound) log.error(`Duplicate card candidate ${messageId} for #T${ticketId}; canonical binding was already present.`);
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

async function answer(ctx: Context, text: string, rows: Button[][]) {
  await middleware.reply(ctx, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
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
  ]);
}

async function staffList(ctx: Context, view: 'new'|'mine'|'active'|'closed', page: number) {
  const list = await db.listStaffTickets(view, ctx.from.id.toString(), page, PAGE);
  const rows = list.map(t => [{ text: `#${t.ticketId} · ${statusName[t.status]} · ${String(t.category || 'Общая').slice(0, 18)}`, callback_data: `tc:open:${t.ticketId}` }]);
  rows.push([{ text: '◀️', callback_data: `tm:${view}:${Math.max(0,page-1)}` }, { text: `${page+1}`, callback_data: 'noop' }, { text: '▶️', callback_data: `tm:${view}:${page+1}` }]);
  rows.push([{ text: '🏠 Главная', callback_data: 'tm:home:0' }]);
  await answer(ctx, `<b>${list.length ? 'Тикеты' : 'Тикетов нет'}</b>`, rows);
}

async function history(ctx: Context, ticket: ISupportee, page: number, staff: boolean) {
  if (typeof db.getTicketTimelinePage === 'function') {
    const timeline = await db.getTicketTimelinePage(ticket.ticketId, page, PAGE, staff);
    const body = timeline.map((x: any) => {
      const label = x.kind === 'user' ? 'Клиент' : x.kind === 'staff' ? 'Поддержка' : x.kind === 'note' ? `🔒 Заметка (${x.actor})` : `Событие${staff && x.actor ? ` · ${x.actor}` : ''}`;
      const owner = staff && x.metadata?.owner ? ` · владелец ${x.metadata.owner}` : '';
      const content = x.kind === 'event' ? eventName[x.text] || 'Изменение тикета' : String(x.text).slice(0, 500);
      return `<b>${e(fmt(x.at))}</b>\n${e(`${label}: ${content}${owner}`)}`;
    }).join('\n\n') || 'История пуста.';
    await answer(ctx, `<b>История #T${ticket.ticketId}</b>\n\n${body}`, [
      [{ text: '◀️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${Math.max(0,page-1)}` }, { text: '▶️', callback_data: `${staff?'tc':'uc'}:h:${ticket.ticketId}:${page+1}` }],
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
      .map(x => ({ at: x.timestamp, text: `Событие: ${eventName[x.type] || 'Изменение тикета'}${x.agent_id ? ` · сотрудник ${x.agent_id}` : ''}${x.metadata?.owner ? ` · владелец ${x.metadata.owner}` : ''}` })),
    ...notes.map(n => ({ at: n.timestamp, text: `🔒 Заметка (${n.author_id}): ${n.text.slice(0, 100)}` })),
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
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'um:home:0' }]] },
      });
    }
    else if (p[1] === 'help') await answer(ctx, e(cache.config.language.helpCommandText), [
      [{ text: '⬅️ Назад', callback_data: 'um:home:0' }],
    ]);
    else {
      const page = Number(p[2]) || 0; const list = await db.listUserTickets(ctx.from.id.toString(), page, PAGE);
      await answer(ctx, '<b>Мои обращения</b>', [
        ...list.map(t => [{ text: `#${t.ticketId} · ${statusName[t.status]}`, callback_data: `uc:open:${t.ticketId}` }]),
        [{ text: '◀️', callback_data: `um:list:${Math.max(0,page-1)}` }, { text: '▶️', callback_data: `um:list:${page+1}` }],
        [{ text: '🏠 Главная', callback_data: 'um:home:0' }],
      ]);
    }
    await ctx.answerCbQuery(); return true;
  }
  if (p[0] === 'uc') {
    const ticket = await db.getTicketById(Number(p[2]), null);
    if (!ticket || ticket.userid !== ctx.from.id.toString() || ctx.chat.type !== 'private') { await ctx.answerCbQuery('Обращение недоступно.', true); return true; }
    if (p[1] === 'h') await history(ctx, ticket, Number(p[3]) || 0, false);
    else await answer(ctx, `<b>Обращение #T${ticket.ticketId}</b>\nСтатус: ${e(statusName[ticket.status])}\nКатегория: ${e(ticket.category || 'Общая')}\nОбновлено: ${e(fmt(ticket.updated_at))}`, [
      [{ text: '📜 Сообщения', callback_data: `uc:h:${ticket.ticketId}:0` }], [{ text: '⬅️ Назад', callback_data: 'um:list:0' }, { text: '🏠 Главная', callback_data: 'um:home:0' }],
    ]);
    await ctx.answerCbQuery(); return true;
  }
  if (p[0] === 'tm') {
    if (!staffSurface(ctx)) { await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true; }
    if (p[1] === 'home') await showStaffHome(ctx); else await staffList(ctx, p[1] as never, Number(p[2]) || 0);
    await ctx.answerCbQuery(); return true;
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
    await answer(ctx, await cardText(current), [...(url ? [[{ text: 'Перейти к постоянной карточке', url }]] : []),
      [{ text: '📜 История', callback_data: `tc:h:${id}:0` }, { text: '🏠 Главная', callback_data: 'tm:home:0' }]]);
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
  } else if (action === 'closeask') {
    if (!team.canManageTicket(actor, ticket.assigned_to) || ticket.status === 'closed') { await ctx.answerCbQuery('Нет прав или тикет уже закрыт.', true); return true; }
    const token = randomUUID().replace(/-/g,'').slice(0,12);
    await db.setPendingTicketAction(id, 'close', token, actor, new Date(Date.now()+PROMPT_MS));
    await answer(ctx, `Закрыть тикет #T${id}?`, [[{text:'Да, закрыть',callback_data:`tc:close:${id}:${token}`},{text:'Отмена',callback_data:`tc:open:${id}`}]]); await ctx.answerCbQuery(); return true;
  } else if (action === 'close' && team.canManageTicket(actor, ticket.assigned_to)) {
    if (!await db.consumePendingTicketAction(id, 'close', p[3], actor)) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    const result = await ticketState.closeTicketLifecycle(ticket, actor, team.getStaffRole(actor)==='agent'?actor:undefined);
    if (result.outcome !== 'closed') { await refreshStaffCard(id); await ctx.answerCbQuery(result.outcome === 'already_closed' ? 'Тикет уже закрыт.' : 'Владелец или состояние изменились.', true); return true; }
    if (result.notificationFailed) await middleware.reply(ctx, 'Тикет закрыт, но уведомление клиенту не доставлено.');
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
      ...members.map(m => [{ text: m.name || m.telegram_id, callback_data: `tc:xfer:${id}:${m.telegram_id}:${token}` }]),
      [{ text: 'Отмена', callback_data: `tc:open:${id}` }],
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
    const prompt = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
      action === 'note' ? `🔒 Заметка для #T${id}: ответьте на это сообщение текстом заметки.` : `Ответ для #T${id}: ответьте на это сообщение. Другие сообщения группы не будут отправлены клиенту.`,
      { reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: qmsg!.message_id },
        message_thread_id: cache.config.staffchat_thread_id || undefined });
    if (!prompt) { await ctx.answerCbQuery('Не удалось создать подсказку ответа.', true); return true; }
    const bound = await db.setReplyPrompt(id, actor, Number(prompt), new Date(Date.now()+PROMPT_MS), team.getStaffRole(actor)==='agent'?actor:undefined);
    if (!bound) { await ctx.answerCbQuery('Владелец или состояние тикета изменились.', true); return true; }
    await answer(ctx, 'Ожидаю ответ 15 минут.', [[{text:'Отменить',callback_data:`tc:cancel:${id}:${prompt}`}]]); await ctx.answerCbQuery(); return true;
  } else if (action === 'cancel') {
    if (ticket.pending_reply_prompt_id !== Number(p[3]) || ticket.pending_reply_staff_id !== actor) { await ctx.answerCbQuery('Эта кнопка отмены устарела.', true); return true; }
    await db.clearReplyPrompt(id, actor);
  }
  else { await ctx.answerCbQuery('Действие недоступно или нет прав.', true); return true; }
  await refreshStaffCard(id); await ctx.answerCbQuery('Готово.'); return true;
}
