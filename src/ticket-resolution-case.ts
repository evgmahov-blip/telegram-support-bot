import { randomUUID } from 'crypto';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as ui from './ticket-ui';
import * as ticketState from './ticket-state';
import * as visibility from './ticket-visibility';
import * as log from './logger';
import { Context } from './interfaces';
import { ISupportee } from './db';
import { staffDisplayName } from './staff-names';
import { isManualTicket } from './manual-ticket-guard';

const INTENT_MS = 15 * 60 * 1000;
const limits = { cause: 1000, actions: 2000, check: 1000 } as const;
const titles = { cause: 'Причина', actions: 'Что сделали', check: 'Как проверили результат' } as const;
type Step = keyof typeof limits;
/** Written only when the engineer explicitly says so; never filled in automatically. */
export const UNKNOWN_CAUSE = 'не установлена';
const ACTIVE = ['open', 'waiting_user'];
const threadOf = (ctx: Context) => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
const expires = () => new Date(Date.now() + INTENT_MS);
const clean = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const isClose = (intent: any) => intent?.mode === 'close';
const stamp = (d: unknown) => new Date(d as string).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

async function notify(ctx: Context, text?: string, alert = false) {
  if (ctx.callbackQuery) await ctx.answerCbQuery(text, alert);
  else if (text) await middleware.reply(ctx, text);
}

/** record mode: a closed ticket the actor may manage. */
async function valid(ctx: Context, ticketId: number) {
  const actor = ctx.from.id.toString();
  const ticket = await db.getTicketById(ticketId, null);
  return ticket && ticket.status === 'closed' && team.canPerformAction(actor, 'reply')
    && team.canManageTicket(actor, ticket.assigned_to) ? ticket : null;
}

/** close mode: still active, manageable, and owned by the same engineer as when the explanation started. */
async function validForClose(ctx: Context, ticketId: number, expectedOwner: string | null | undefined) {
  const actor = ctx.from.id.toString();
  const ticket = await db.getTicketById(ticketId, null);
  return ticket && ACTIVE.includes(ticket.status) && team.canPerformAction(actor, 'reply')
    && team.canManageTicket(actor, ticket.assigned_to) && (ticket.assigned_to ?? null) === (expectedOwner ?? null) ? ticket : null;
}

const usable = (ctx: Context, intent: any) => isClose(intent)
  ? validForClose(ctx, intent.ticketId, intent.expected_owner) : valid(ctx, intent.ticketId);

function nav(intent: any): ui.Button[][] {
  return [[{ text: '⬅️ Назад', callback_data: `rs:back:${intent.token}:${intent.version}` },
    { text: '✖️ Отмена', callback_data: `rs:cancel:${intent.token}:${intent.version}` }], [ui.STAFF_HOME]];
}

function stepRows(intent: any): ui.Button[][] {
  const extra: ui.Button[][] = !isClose(intent) ? []
    : intent.step === 'cause' ? [[{ text: '❔ Причина не установлена', callback_data: `rs:unknown:${intent.token}:${intent.version}` }]]
      : intent.step === 'check' ? [[{ text: '⏭ Без проверки', callback_data: `rs:skip:${intent.token}:${intent.version}` }]] : [];
  return [...extra, ...nav(intent)];
}

function stepText(intent: any): string {
  const step = intent.step as Step;
  if (!isClose(intent)) {
    return `<b>Запись решения · заявка № ${intent.ticketId}</b>\nШаг: ${ui.e(titles[step])}\n\nОтправьте обычный текст в этой теме. Лимит: ${limits[step]} символов.`;
  }
  const n = step === 'cause' ? 1 : step === 'actions' ? 2 : 3;
  const hint = step === 'cause' ? '\nЕсли причина неизвестна, нажмите «Причина не установлена» — так и будет записано.'
    : step === 'check' ? '\nНеобязательно: можно пропустить.' : '';
  return `<b>Закрытие заявки № ${intent.ticketId}</b>\nШаг ${n} из 3: ${ui.e(titles[step])}${hint}\n\nОтправьте обычный текст в этом чате. Лимит: ${limits[step]} символов.`;
}

async function showStep(ctx: Context, intent: any) {
  await ui.answer(ctx, stepText(intent), stepRows(intent));
}

async function showPreview(ctx: Context, intent: any) {
  if (isClose(intent)) {
    await ui.answer(ctx, `<b>Проверьте закрытие · заявка № ${intent.ticketId}</b>\nАвтор: ${ui.e(staffDisplayName(intent.actor_id))}\n\n<b>Причина</b>\n${ui.e(intent.cause)}\n\n<b>Что сделали</b>\n${ui.e(intent.actions)}\n\n<b>Как проверили результат</b>\n${intent.check ? ui.e(intent.check) : 'не указано'}\n\nЗаявка закроется только вместе с этим решением. Клиент получит лишь уведомление о закрытии; причина и работы остаются внутренними.`, [
      [{ text: '✅ Закрыть заявку', callback_data: `rs:save:${intent.token}:${intent.version}` }, { text: '✏️ Изменить', callback_data: `rs:edit:${intent.token}:${intent.version}` }],
      [{ text: '✖️ Отмена', callback_data: `rs:cancel:${intent.token}:${intent.version}` }, ui.STAFF_HOME],
    ]);
    return;
  }
  await ui.answer(ctx, `<b>Проверьте решение · заявка № ${intent.ticketId}</b>\n\n<b>Причина</b>\n${ui.e(intent.cause)}\n\n<b>Что сделали</b>\n${ui.e(intent.actions)}\n\n<b>Как проверили результат</b>\n${ui.e(intent.check)}\n\nЭто сохранит внутренний случай, записанный сотрудником. Закрытие заявки само по себе не подтверждает причину. Случай не становится автоматически одобренным навыком.`, [
    [{ text: '✅ Сохранить', callback_data: `rs:save:${intent.token}:${intent.version}` }, { text: '✏️ Изменить', callback_data: `rs:edit:${intent.token}:${intent.version}` }],
    [{ text: '✖️ Отмена', callback_data: `rs:cancel:${intent.token}:${intent.version}` }, ui.STAFF_HOME],
  ]);
}

async function otherInputActive(actor: string, chat: string, thread: number | null) {
  const [compose, intake, name] = await Promise.all([
    db.findActiveReplyCompose?.(actor, chat, thread), db.findAnyActiveManualDraft?.(actor, chat, thread), db.findStaffNameEdit?.(actor, chat, thread),
  ]);
  return Boolean(compose || intake || name);
}

/**
 * Arm one explanation intent. A personal ticket's explanation is collected only
 * in the actor's bot DM; a common ticket's stays on the current surface.
 */
async function beginIntent(ctx: Context, ticket: ISupportee, mode: db.ResolutionMode): Promise<boolean> {
  const actor = ctx.from.id.toString();
  const personal = !visibility.isCommonTicket(ticket) && !ui.isStaffPrivate(ctx);
  const chat = personal ? actor : String(ctx.chat.id), thread = personal ? null : threadOf(ctx);
  if (await otherInputActive(actor, chat, thread)) { await notify(ctx, 'Сначала завершите или отмените другой активный ввод.', true); return true; }
  const token = randomUUID().replace(/-/g, '');
  const intent = mode === 'close'
    ? await db.startResolutionIntent(token, actor, chat, thread, ticket.ticketId, expires(), 'close', ticket.assigned_to ?? null)
    : await db.startResolutionIntent(token, actor, chat, thread, ticket.ticketId, expires());
  if (personal) {
    const sent = await visibility.sendToStaffPrivate(actor, stepText(intent),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: stepRows(intent) } });
    if (!sent) {
      await db.cancelResolutionIntent(actor, chat, thread, intent.version);
      await notify(ctx, visibility.PRIVATE_UNAVAILABLE, true); return true;
    }
    await notify(ctx, 'Заполните причину и выполненные работы в личном чате с ботом.'); return true;
  }
  await showStep(ctx, intent); await notify(ctx); return true;
}

export async function start(ctx: Context, ticketId: number): Promise<boolean> {
  const ticket = await valid(ctx, ticketId);
  if (!ticket) { await ctx.answerCbQuery('Заявка должна быть закрыта и доступна вам.', true); return true; }
  return beginIntent(ctx, ticket, 'record');
}

/**
 * The only way an engineer closes a ticket: cause and performed work are
 * collected first, then one confirmation saves them and closes the same ticket.
 */
export async function startClose(ctx: Context, ticket: ISupportee): Promise<boolean> {
  const actor = ctx.from.id.toString();
  if (!ACTIVE.includes(ticket.status) || !team.canPerformAction(actor, 'reply') || !team.canManageTicket(actor, ticket.assigned_to)) {
    await notify(ctx, 'Закрыть может владелец активной заявки, руководитель или администратор.', true); return true;
  }
  return beginIntent(ctx, ticket, 'close');
}

export async function view(ctx: Context, ticketId: number): Promise<boolean> {
  const actor = ctx.from.id.toString();
  const ticket = await db.getTicketById(ticketId, null);
  // Closed cases stay readable to everyone who may see the ticket, including after a reopen.
  if (!ticket || !(team.canManageTicket(actor, ticket.assigned_to) || visibility.canViewTicket(actor, ticket))) {
    await ctx.answerCbQuery('Решение недоступно: нет доступа к заявке.', true); return true;
  }
  const resolution = await db.getTicketResolution(ticketId);
  const latest = resolution?.versions?.[resolution.versions.length - 1];
  if (!latest) { await ctx.answerCbQuery('Сохранённое решение не найдено.', true); return true; }
  const canEdit = ticket.status === 'closed' && team.canManageTicket(actor, ticket.assigned_to);
  await ui.answerForTicket(ctx, ticket, `<b>Решение · заявка № ${ticketId}</b>\nВерсия: ${latest.version} из ${resolution!.versions.length}${latest.closure ? ' · записано при закрытии' : ''}\nАвтор: ${ui.e(staffDisplayName(latest.author_id))}\nЗаписано: ${ui.e(stamp(latest.saved_at))}\n\n<b>Причина</b>\n${ui.e(latest.cause)}\n\n<b>Что сделали</b>\n${ui.e(latest.actions)}\n\n<b>Как проверили результат</b>\n${latest.check ? ui.e(latest.check) : 'не указано'}\n\nЭто внутренний случай, записанный сотрудником, а не автоматически одобренный навык.`, [
    ...(canEdit ? [[{ text: '✏️ Изменить решение', callback_data: `rs:start:${ticketId}` }]] : []),
    [{ text: '⬅️ К заявке', callback_data: `tc:open:${ticketId}` }, ui.STAFF_HOME],
  ]); return true;
}

async function saveAndClose(ctx: Context, intent: any, token: string, version: number): Promise<boolean> {
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  const claimed = await db.claimResolutionSave(token, actor, chat, thread, version);
  if (!claimed) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
  const ticket = await validForClose(ctx, claimed.ticketId, claimed.expected_owner);
  if (!ticket || !clean(claimed.cause || '') || !clean(claimed.actions || '')) {
    await db.abandonClaimedResolution(token, actor, version);
    await ctx.answerCbQuery(ticket ? 'Причина и выполненные работы обязательны. Заявка осталась открытой.'
      : 'Заявка уже закрыта, изменилась или сменился владелец. Ничего не сохранено.', true); return true;
  }
  let saved: db.ITicketResolution | null;
  try { saved = await db.saveClaimedResolution(claimed); }
  catch (err) {
    // The claim stays retryable: the same confirmation either saves now or replays the saved version.
    log.error(`Не удалось сохранить решение #T${claimed.ticketId}:`, err);
    await ctx.answerCbQuery('Решение не сохранено, заявка осталась открытой. Нажмите «Закрыть заявку» ещё раз.', true); return true;
  }
  if (!saved) {
    await db.abandonClaimedResolution(token, actor, version);
    await ctx.answerCbQuery('Решение изменено в другом окне. Заявка осталась открытой; начните закрытие заново.', true); return true;
  }
  const resolutionVersion = saved.versions?.find(v => v.intent_token === token)?.version ?? saved.current_version;
  let result: Awaited<ReturnType<typeof ticketState.closeTicketLifecycle>>;
  try {
    result = await ticketState.closeTicketLifecycle(ticket, actor, claimed.expected_owner ?? null,
      { resolutionVersion, metadata: { resolution_version: resolutionVersion } });
  } catch (err) {
    log.error(`Не удалось закрыть заявку #T${claimed.ticketId}:`, err);
    await ctx.answerCbQuery('Решение сохранено, но заявка не закрыта. Нажмите «Закрыть заявку» ещё раз.', true); return true;
  }
  if (result.outcome !== 'closed') {
    await db.abandonClaimedResolution(token, actor, version);
    await ui.refreshStaffCard(claimed.ticketId);
    await ctx.answerCbQuery(result.outcome === 'already_closed'
      ? 'Заявка уже закрыта другим действием; эта запись к закрытию не привязана.'
      : 'Владелец или состояние изменились: заявка не закрыта.', true); return true;
  }
  await db.completeResolutionIntent(token);
  db.recordAnalyticsEventBestEffort('ticket.resolution_saved', claimed.ticketId, actor, { version: resolutionVersion, closure: true });
  await ui.refreshStaffCard(claimed.ticketId);
  const notes = [
    result.notificationFailed ? 'Уведомление клиенту не доставлено.' : '',
    isManualTicket(ticket) ? 'Ручная заявка: клиент не уведомлялся, канала доставки нет.' : '',
  ].filter(Boolean).map(n => `\n${n}`).join('');
  await ui.answer(ctx, `Заявка № ${claimed.ticketId} закрыта. Решение сохранено (версия ${resolutionVersion}).${notes}`, [[
    { text: '📘 Решение', callback_data: `rs:view:${claimed.ticketId}` }, ui.STAFF_HOME,
  ]]);
  await ctx.answerCbQuery('Заявка закрыта.'); return true;
}

export async function handleCallback(ctx: Context, p: string[]): Promise<boolean> {
  const action = p[1];
  if (action === 'start') return start(ctx, Number(p[2]));
  if (action === 'view') return view(ctx, Number(p[2]));
  const token = p[2], version = Number(p[3]); const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  const intent = await db.getResolutionIntent(token);
  if (!intent || intent.actor_id !== actor || intent.chat_id !== chat || (intent.thread_id ?? null) !== thread || intent.version !== version) {
    await ctx.answerCbQuery('Кнопка устарела или принадлежит другому сотруднику.', true); return true;
  }
  const closing = isClose(intent);
  if (!await usable(ctx, intent)) {
    await db.cancelResolutionIntent(actor, chat, thread, version);
    await ctx.answerCbQuery(closing ? 'Заявка уже закрыта, изменилась или сменился владелец. Ввод отменён.'
      : 'Заявка снова открыта или изменились права. Ввод отменён.', true); return true;
  }
  if (action === 'cancel') {
    if (!await db.cancelResolutionIntent(actor, chat, thread, version)) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
    await ui.answer(ctx, closing ? `Закрытие отменено. Заявка № ${intent.ticketId} осталась открытой.` : 'Запись решения отменена.',
      [[{ text: '⬅️ К заявке', callback_data: `tc:open:${intent.ticketId}` }, ui.STAFF_HOME]]);
    await ctx.answerCbQuery('Отменено.'); return true;
  }
  if (action === 'save' && closing) return saveAndClose(ctx, intent, token, version);
  if (action === 'save') {
    const claimed = await db.claimResolutionSave(token, actor, chat, thread, version);
    if (!claimed) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    if (!await valid(ctx, claimed.ticketId)) {
      await db.abandonClaimedResolution(token, actor, version);
      await ctx.answerCbQuery('Заявка снова открыта или изменились права. Решение не сохранено.', true); return true;
    }
    const saved = await db.saveClaimedResolution(claimed);
    if (!saved) { await ctx.answerCbQuery('Решение изменено в другом окне. Откройте актуальную версию.', true); return true; }
    db.recordAnalyticsEventBestEffort('ticket.resolution_saved', claimed.ticketId, actor, { version: saved.current_version });
    await ui.refreshStaffCard(claimed.ticketId);
    await ui.answer(ctx, `Решение по заявке № ${claimed.ticketId} сохранено как внутренний случай. Оно не стало автоматически одобренным навыком.`, [[
      { text: '📘 Решение', callback_data: `rs:view:${claimed.ticketId}` }, ui.STAFF_HOME,
    ]]); await ctx.answerCbQuery('Сохранено.'); return true;
  }
  let saved: any = null;
  if (action === 'edit' && intent.status === 'preview') {
    await ui.answer(ctx, '<b>Что изменить?</b>', [[
      { text: 'Причину', callback_data: `rs:field:${token}:${version}:cause` },
      { text: 'Действия', callback_data: `rs:field:${token}:${version}:actions` },
    ], [{ text: 'Проверку', callback_data: `rs:field:${token}:${version}:check` }], ...nav(intent)]);
    await ctx.answerCbQuery(); return true;
  }
  if (action === 'field' && ['cause','actions','check'].includes(p[4])) saved = await db.transitionResolutionIntent(token, actor, chat, thread, version,
    { status: 'preview' }, { status: 'input', step: p[4], edit_return: true }, expires());
  if (action === 'unknown' && closing && intent.status === 'input' && intent.step === 'cause') {
    saved = await db.transitionResolutionIntent(token, actor, chat, thread, version, { status: 'input', step: 'cause' },
      intent.edit_return ? { cause: UNKNOWN_CAUSE, status: 'preview', step: null, edit_return: false }
        : { cause: UNKNOWN_CAUSE, status: 'input', step: 'actions' }, expires());
  }
  if (action === 'skip' && closing && intent.status === 'input' && intent.step === 'check') {
    saved = await db.transitionResolutionIntent(token, actor, chat, thread, version, { status: 'input', step: 'check' },
      { check: '', status: 'preview', step: null, edit_return: false }, expires());
  }
  if (action === 'back') {
    const prior = intent.status === 'preview' ? 'check' : intent.step === 'check' ? 'actions' : intent.step === 'actions' ? 'cause' : null;
    if (prior) saved = await db.transitionResolutionIntent(token, actor, chat, thread, version,
      { status: intent.status, step: intent.step }, { status: 'input', step: prior, edit_return: false }, expires());
    else { await ctx.answerCbQuery('Это первый шаг.', true); return true; }
  }
  if (!saved) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
  if (saved.status === 'preview') await showPreview(ctx, saved); else await showStep(ctx, saved);
  await ctx.answerCbQuery(); return true;
}

export async function handleTextInput(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  // Group input requires the staff chat session; a DM explanation requires a registered engineer.
  const surface = ctx.session?.admin || (ctx.chat?.type === 'private' && Boolean(team.getStaffRole(ctx.from.id.toString())));
  if (!text || text.startsWith('/') || ctx.message?.reply_to_message || !surface) return false;
  if (typeof db.findResolutionIntent !== 'function') return false;
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  const intent = await db.findResolutionIntent(actor, chat, thread);
  if (!intent || intent.status !== 'input' || !intent.step) return false;
  if (!await usable(ctx, intent)) {
    await db.cancelResolutionIntent(actor, chat, thread, intent.version);
    await middleware.reply(ctx, isClose(intent) ? 'Текст не сохранён: заявка уже закрыта, изменилась или сменился владелец.'
      : 'Текст не сохранён: заявка снова открыта или изменились права.'); return true;
  }
  if (await otherInputActive(actor, chat, thread)) { await middleware.reply(ctx, 'Текст не использован: одновременно активен другой ввод. Отмените один из вводов.'); return true; }
  const step = intent.step as Step, value = clean(text);
  if (!value || value.length > limits[step]) { await middleware.reply(ctx, `Поле «${titles[step]}» должно содержать от 1 до ${limits[step]} символов без управляющих символов.`); return true; }
  const next = intent.edit_return ? null : step === 'cause' ? 'actions' : step === 'actions' ? 'check' : null;
  const saved = await db.consumeResolutionInput(intent.token, actor, chat, thread, intent.version, step, ctx.message.message_id, value, next, expires());
  if (!saved) { await middleware.reply(ctx, 'Этот ввод устарел. Используйте актуальную панель.'); return true; }
  if (saved.status === 'preview') await showPreview(ctx, saved); else await showStep(ctx, saved);
  return true;
}

export async function cancelForHome(ctx: Context) {
  if (typeof db.cancelResolutionIntent === 'function')
    await db.cancelResolutionIntent(ctx.from.id.toString(), String(ctx.chat.id), threadOf(ctx));
}
