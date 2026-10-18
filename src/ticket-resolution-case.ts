import { randomUUID } from 'crypto';
import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as ui from './ticket-ui';
import { Context } from './interfaces';

const INTENT_MS = 15 * 60 * 1000;
const limits = { cause: 1000, actions: 2000, check: 1000 } as const;
const titles = { cause: 'Причина', actions: 'Что сделали', check: 'Как проверили результат' } as const;
type Step = keyof typeof limits;
const threadOf = (ctx: Context) => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
const expires = () => new Date(Date.now() + INTENT_MS);
const clean = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

async function valid(ctx: Context, ticketId: number) {
  const actor = ctx.from.id.toString();
  const ticket = await db.getTicketById(ticketId, null);
  return ticket && ticket.status === 'closed' && team.canPerformAction(actor, 'reply')
    && team.canManageTicket(actor, ticket.assigned_to) ? ticket : null;
}

function nav(intent: any): ui.Button[][] {
  return [[{ text: '⬅️ Назад', callback_data: `rs:back:${intent.token}:${intent.version}` },
    { text: '✖️ Отмена', callback_data: `rs:cancel:${intent.token}:${intent.version}` }], [ui.STAFF_HOME]];
}

async function showStep(ctx: Context, intent: any) {
  const step = intent.step as Step;
  await ui.answer(ctx, `<b>Запись решения · заявка № ${intent.ticketId}</b>\nШаг: ${ui.e(titles[step])}\n\nОтправьте обычный текст в этой теме. Лимит: ${limits[step]} символов.`, nav(intent));
}

async function showPreview(ctx: Context, intent: any) {
  await ui.answer(ctx, `<b>Проверьте решение · заявка № ${intent.ticketId}</b>\n\n<b>Причина</b>\n${ui.e(intent.cause)}\n\n<b>Что сделали</b>\n${ui.e(intent.actions)}\n\n<b>Как проверили результат</b>\n${ui.e(intent.check)}\n\nЭто сохранит внутренний случай, записанный сотрудником. Закрытие заявки само по себе не подтверждает причину. Случай не становится автоматически одобренным навыком.`, [
    [{ text: '✅ Сохранить', callback_data: `rs:save:${intent.token}:${intent.version}` }, { text: '✏️ Изменить', callback_data: `rs:edit:${intent.token}:${intent.version}` }],
    [{ text: '✖️ Отмена', callback_data: `rs:cancel:${intent.token}:${intent.version}` }, ui.STAFF_HOME],
  ]);
}

export async function start(ctx: Context, ticketId: number): Promise<boolean> {
  const ticket = await valid(ctx, ticketId);
  if (!ticket) { await ctx.answerCbQuery('Заявка должна быть закрыта и доступна вам.', true); return true; }
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  const [compose, intake, name] = await Promise.all([
    db.findActiveReplyCompose?.(actor, chat, thread), db.findAnyActiveManualDraft?.(actor, chat, thread), db.findStaffNameEdit?.(actor, chat, thread),
  ]);
  if (compose || intake || name) { await ctx.answerCbQuery('Сначала завершите или отмените другой активный ввод.', true); return true; }
  const intent = await db.startResolutionIntent(randomUUID().replace(/-/g, ''), actor, chat, thread, ticketId, expires());
  await showStep(ctx, intent); await ctx.answerCbQuery(); return true;
}

export async function view(ctx: Context, ticketId: number): Promise<boolean> {
  if (!await valid(ctx, ticketId)) { await ctx.answerCbQuery('Решение недоступно: заявка открыта или изменились права.', true); return true; }
  const resolution = await db.getTicketResolution(ticketId);
  const latest = resolution?.versions?.[resolution.versions.length - 1];
  if (!latest) { await ctx.answerCbQuery('Сохранённое решение не найдено.', true); return true; }
  await ui.answer(ctx, `<b>Решение · заявка № ${ticketId}</b>\nВерсия: ${latest.version} из ${resolution!.versions.length}\nЗаписано: ${ui.e(new Date(latest.saved_at).toLocaleString('ru-RU'))}\n\n<b>Причина</b>\n${ui.e(latest.cause)}\n\n<b>Что сделали</b>\n${ui.e(latest.actions)}\n\n<b>Как проверили результат</b>\n${ui.e(latest.check)}\n\nЭто внутренний случай, записанный сотрудником, а не автоматически одобренный навык.`, [
    [{ text: '✏️ Изменить решение', callback_data: `rs:start:${ticketId}` }],
    [{ text: '⬅️ К заявке', callback_data: `tc:open:${ticketId}` }, ui.STAFF_HOME],
  ]); await ctx.answerCbQuery(); return true;
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
  if (!await valid(ctx, intent.ticketId)) {
    await db.cancelResolutionIntent(actor, chat, thread, version);
    await ctx.answerCbQuery('Заявка снова открыта или изменились права. Ввод отменён.', true); return true;
  }
  if (action === 'cancel') {
    if (!await db.cancelResolutionIntent(actor, chat, thread, version)) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
    await ui.answer(ctx, 'Запись решения отменена.', [[{ text: '⬅️ К заявке', callback_data: `tc:open:${intent.ticketId}` }, ui.STAFF_HOME]]);
    await ctx.answerCbQuery('Отменено.'); return true;
  }
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
  if (action === 'back') {
    const prior = intent.status === 'preview' ? 'check' : intent.step === 'check' ? 'actions' : intent.step === 'actions' ? 'cause' : null;
    if (prior) saved = await db.transitionResolutionIntent(token, actor, chat, thread, version,
      { status: intent.status, step: intent.step }, { status: 'input', step: prior, edit_return: false }, expires());
    else { await ctx.answerCbQuery('Это первый шаг.', true); return true; }
  }
  if (!saved) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
  await showStep(ctx, saved); await ctx.answerCbQuery(); return true;
}

export async function handleTextInput(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith('/') || ctx.message?.reply_to_message || !ctx.session.admin) return false;
  if (typeof db.findResolutionIntent !== 'function') return false;
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  const intent = await db.findResolutionIntent(actor, chat, thread);
  if (!intent || intent.status !== 'input' || !intent.step) return false;
  if (!await valid(ctx, intent.ticketId)) {
    await db.cancelResolutionIntent(actor, chat, thread, intent.version);
    await middleware.reply(ctx, 'Текст не сохранён: заявка снова открыта или изменились права.'); return true;
  }
  const [compose, intake, name] = await Promise.all([
    db.findActiveReplyCompose?.(actor, chat, thread), db.findAnyActiveManualDraft?.(actor, chat, thread), db.findStaffNameEdit?.(actor, chat, thread),
  ]);
  if (compose || intake || name) { await middleware.reply(ctx, 'Текст не использован: одновременно активен другой ввод. Отмените один из вводов.'); return true; }
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
