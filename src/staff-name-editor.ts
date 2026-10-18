import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as ticketUi from './ticket-ui';
import * as log from './logger';
import { Context, StaffMemberConfig } from './interfaces';
import { staffDisplayName } from './staff-names';

const PAGE = 6;
const INTENT_MS = 15 * 60 * 1000;
const roleLabel: Record<string, string> = { admin: 'Администратор', supervisor: 'Супервизор', agent: 'Инженер' };
const threadOf = (ctx: Context) => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
const expires = () => new Date(Date.now() + INTENT_MS);
const canManage = (actor: string) => team.canPerformAction(actor, 'manage_team');
const surface = (ctx: Context) => ctx.session.admin && String(ctx.chat.id) === String(cache.config.staffchat_id)
  && (!cache.config.staffchat_thread_id || threadOf(ctx) === cache.config.staffchat_thread_id);

function labels(members: StaffMemberConfig[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(staffDisplayName(member.telegram_id), (counts.get(staffDisplayName(member.telegram_id)) || 0) + 1);
  return new Map(members.map((member) => {
    const name = staffDisplayName(member.telegram_id);
    return [member.telegram_id, counts.get(name)! > 1 ? `${name} · ${roleLabel[member.role] || member.role}` : name];
  }));
}

export async function showList(ctx: Context, page = 0): Promise<boolean> {
  const actor = ctx.from.id.toString();
  if (!surface(ctx) || !canManage(actor)) { await ctx.answerCbQuery('Доступно только администратору команды.', true); return true; }
  const members = [...cache.staffMembers.values()];
  const names = labels(members); const start = Math.max(0, page) * PAGE; const visible = members.slice(start, start + PAGE);
  const nav: ticketUi.Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `sn:list:${page - 1}` });
  if (start + PAGE < members.length) nav.push({ text: '▶️', callback_data: `sn:list:${page + 1}` });
  await ctx.answerCbQuery();
  const pageText = page > 0 || start + PAGE < members.length ? `\nСтраница ${page + 1}` : '';
  await ticketUi.answer(ctx, `<b>Инженеры</b>\nВыберите сотрудника:${pageText}`, [
    ...visible.map((member) => [{ text: names.get(member.telegram_id)!, callback_data: `sn:pick:${member.telegram_id}:${page}` }]),
    ...(nav.length ? [nav] : []), [ticketUi.STAFF_HOME],
  ]);
  return true;
}

async function showMember(ctx: Context, targetId: string, page: number) {
  const member = cache.staffMembers.get(targetId)!;
  await ticketUi.answer(ctx, `<b>${ticketUi.e(staffDisplayName(targetId))}</b>\nРоль: ${ticketUi.e(roleLabel[member.role] || member.role)}`, [
    [{ text: '✏️ Изменить имя', callback_data: `sn:edit:${targetId}:${page}` }],
    [{ text: '⬅️ Назад', callback_data: `sn:list:${page}` }, ticketUi.STAFF_HOME],
  ]);
}

async function showPreview(ctx: Context, intent: any) {
  await ticketUi.answer(ctx, `<b>Новое отображаемое имя</b>\n${ticketUi.e(intent.draft_name)}`, [
    [{ text: '✅ Сохранить', callback_data: `sn:save:${intent.version}` }, { text: '✏️ Изменить', callback_data: `sn:revise:${intent.version}` }],
    [{ text: '✖️ Отмена', callback_data: `sn:cancel:${intent.version}` }, ticketUi.STAFF_HOME],
  ]);
}

export async function handleCallback(ctx: Context, p: string[]): Promise<boolean> {
  const actor = ctx.from.id.toString(), action = p[1], chat = String(ctx.chat.id), thread = threadOf(ctx);
  if (!surface(ctx) || !canManage(actor)) { await ctx.answerCbQuery('Доступно только администратору команды.', true); return true; }
  if (action === 'list') return showList(ctx, Number(p[2]) || 0);
  if (action === 'pick') {
    if (!cache.staffMembers.has(p[2])) { await ctx.answerCbQuery('Сотрудник больше не зарегистрирован.', true); return true; }
    await ctx.answerCbQuery(); await showMember(ctx, p[2], Number(p[3]) || 0); return true;
  }
  if (action === 'edit') {
    if (!cache.staffMembers.has(p[2])) { await ctx.answerCbQuery('Сотрудник больше не зарегистрирован.', true); return true; }
    if ((typeof db.findActiveReplyCompose === 'function' && await db.findActiveReplyCompose(actor, chat, thread))
      || (typeof db.findAnyActiveManualDraft === 'function' && await db.findAnyActiveManualDraft(actor, chat, thread))) {
      await ctx.answerCbQuery('Сначала завершите или отмените текущий ввод заявки.', true); return true;
    }
    const intent = await db.startStaffNameEdit(actor, chat, thread, p[2], expires());
    await ticketUi.answer(ctx, `<b>Изменение имени</b>\nТекущее имя: ${ticketUi.e(staffDisplayName(p[2]))}\n\nОтправьте новое имя обычным текстовым сообщением в этой теме.`, [
      [{ text: '✖️ Отмена', callback_data: `sn:cancel:${intent.version}` }, ticketUi.STAFF_HOME],
    ]); await ctx.answerCbQuery(); return true;
  }
  const version = Number(p[2]); const intent = await db.findStaffNameEdit(actor, chat, thread);
  if (!intent || intent.version !== version || !cache.staffMembers.has(intent.target_id)) {
    await ctx.answerCbQuery('Кнопка устарела или сотрудник больше не зарегистрирован.', true); return true;
  }
  if (action === 'cancel') {
    if (!await db.cancelStaffNameEdit(actor, chat, thread, version)) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
    await ticketUi.answer(ctx, 'Изменение имени отменено.', [[ticketUi.STAFF_HOME]]); await ctx.answerCbQuery('Отменено.'); return true;
  }
  if (action === 'revise') {
    const revised = await db.reviseStaffNameEdit(actor, chat, thread, version);
    if (!revised) { await ctx.answerCbQuery('Кнопка устарела.', true); return true; }
    await ticketUi.answer(ctx, 'Отправьте другое имя обычным текстовым сообщением в этой теме.', [[
      { text: '✖️ Отмена', callback_data: `sn:cancel:${revised.version}` }, ticketUi.STAFF_HOME,
    ]]); await ctx.answerCbQuery(); return true;
  }
  if (action === 'save') {
    const saved = await db.saveStaffNameEdit(actor, chat, thread, version);
    if (!saved || !cache.staffMembers.has(saved.telegram_id)) { await ctx.answerCbQuery('Подтверждение устарело.', true); return true; }
    cache.staffNameOverrides ??= new Map(); cache.staffNameOverrides.set(saved.telegram_id, saved.display_name);
    await ticketUi.answer(ctx, `Имя сохранено: <b>${ticketUi.e(saved.display_name)}</b>`, [[
      { text: '⬅️ К инженерам', callback_data: 'sn:list:0' }, ticketUi.STAFF_HOME,
    ]]).catch((err) => log.error('Имя сохранено, но экран подтверждения не обновлён:', err));
    ctx.answerCbQuery('Сохранено.').catch(log.error);
    db.listTicketsAssignedTo(saved.telegram_id).then((ids) => Promise.all(ids.map((id) => ticketUi.refreshStaffCard(id))))
      .catch((err) => log.error('Имя сохранено, но карточки обновлены не полностью:', err));
    return true;
  }
  await ctx.answerCbQuery('Действие недоступно.', true); return true;
}

export async function cancelForHome(ctx: Context) {
  if (typeof db.cancelStaffNameEdit === 'function')
    await db.cancelStaffNameEdit(ctx.from.id.toString(), String(ctx.chat.id), threadOf(ctx));
}

/** Consumes only the ordinary text bound to this actor/chat/forum topic. */
export async function handleTextInput(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith('/') || ctx.message?.reply_to_message) return false;
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  if (!surface(ctx) || !canManage(actor)) return false;
  if (typeof db.findStaffNameEdit !== 'function') return false;
  const intent = await db.findStaffNameEdit(actor, chat, thread); if (!intent) return false;
  if (!cache.staffMembers.has(intent.target_id)) {
    await db.cancelStaffNameEdit(actor, chat, thread, intent.version);
    await middleware.reply(ctx, 'Сотрудник больше не зарегистрирован; изменение отменено.'); return true;
  }
  const [compose, intake] = await Promise.all([
    typeof db.findActiveReplyCompose === 'function' ? db.findActiveReplyCompose(actor, chat, thread) : null,
    typeof db.findAnyActiveManualDraft === 'function' ? db.findAnyActiveManualDraft(actor, chat, thread) : null,
  ]);
  if (compose || intake) {
    await middleware.reply(ctx, 'Текст не использован: одновременно активен ввод заявки. Отмените один из вводов через его панель или Главную.'); return true;
  }
  const name = text.trim();
  if (!name || name.length > 80 || /[\r\n\u0000-\u001f\u007f]/.test(name)) {
    await middleware.reply(ctx, 'Имя должно содержать от 1 до 80 символов, без переносов строк и управляющих символов.'); return true;
  }
  const staged = await db.stageStaffNameEdit(actor, chat, thread, intent.version, name);
  if (!staged) { await middleware.reply(ctx, 'Этот ввод устарел. Откройте редактор имени заново.'); return true; }
  await showPreview(ctx, staged); return true;
}
