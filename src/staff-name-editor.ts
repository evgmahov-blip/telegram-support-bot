import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as ticketUi from './ticket-ui';
import * as log from './logger';
import { Context, Messenger, StaffMemberConfig } from './interfaces';
import { randomUUID } from 'crypto';
import { readTeamSettings, saveTeamMember, undoTeamChange } from './team-settings';
import { staffDisplayName } from './staff-names';

const PAGE = 6;
const INTENT_MS = 15 * 60 * 1000;
const roleLabel: Record<string, string> = { admin: 'Администратор', supervisor: 'Супервизор', agent: 'Инженер' };
const threadOf = (ctx: Context) => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
const expires = () => new Date(Date.now() + INTENT_MS);
const canManage = (actor: string) => team.canPerformAction(actor, 'manage_team');
const surface = (ctx: Context) => ctx.messenger === Messenger.TELEGRAM && ((ctx.chat?.type === 'private' && String(ctx.chat.id) === String(ctx.from.id)) || (ctx.session.admin && String(ctx.chat.id) === String(cache.config.staffchat_id)
  && (!cache.config.staffchat_thread_id || threadOf(ctx) === cache.config.staffchat_thread_id)));

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
  page = Number.isSafeInteger(page) ? Math.min(Math.max(0, page), Math.max(0, Math.ceil(members.length / PAGE) - 1)) : 0;
  const names = labels(members); const start = page * PAGE; const visible = members.slice(start, start + PAGE);
  const nav: ticketUi.Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `sn:list:${page - 1}` });
  if (start + PAGE < members.length) nav.push({ text: '▶️', callback_data: `sn:list:${page + 1}` });
  await ctx.answerCbQuery();
  const pageText = page > 0 || start + PAGE < members.length ? `\nСтраница ${page + 1}` : '';
  await ticketUi.answer(ctx, `<b>Инженеры</b>\nВыберите сотрудника:${pageText}`, [
    ...visible.map((member) => [{ text: names.get(member.telegram_id)!, callback_data: `sn:pick:${member.telegram_id}:${page}` }]),
    ...(nav.length ? [nav] : []), [{ text: '➕ Подключить инженера', callback_data: 'sn:connect' }],
    [{ text: '↩️ Откат последнего изменения прав', callback_data: 'sn:undo' }],
    [{ text: '⬅️ Настройки', callback_data: 'cfg:home' }, ticketUi.STAFF_HOME],
  ]);
  return true;
}

async function showMember(ctx: Context, targetId: string, page: number) {
  const member = cache.staffMembers.get(targetId)!;
  await ticketUi.answer(ctx, `<b>${ticketUi.e(staffDisplayName(targetId))}</b>\nРоль: ${ticketUi.e(roleLabel[member.role] || member.role)}\nСостояние: ${member.active === false ? 'Отключён' : 'Включён'}`, [
    [{ text: '🔐 Уровень доступа / состояние', callback_data: `sn:access:${targetId}` }],
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
  if (['connect','access','change','apply','undo','undoapply','join'].includes(action)) {
    try { return await handleAccess(ctx, p); }
    catch (err) {
      const reasons: Record<string, string> = {
        team_forbidden: 'Полномочия изменились. Откройте раздел заново.',
        team_stale: 'Кнопка устарела. Откройте карточку заново.',
        team_busy: 'Другое изменение ещё сохраняется. Повторите позже.',
        team_readonly: 'Конфигурация недоступна для записи. Права не сохранены. Обратитесь к оператору стенда.',
        team_owner_protected: 'Нельзя отключить или понизить владельца.',
        team_self_change_denied: 'Изменять собственные полномочия запрещено.',
        team_last_admin: 'Нельзя отключить последнего администратора.',
        team_has_assignments: 'Сначала передайте активные заявки и предложения инженера.',
        team_already_connected: 'Инженер уже подключён. Откройте его карточку.',
        team_finish_ticket_input: 'Сначала завершите или отмените ввод заявки.',
        team_no_history: 'Изменений для отката пока нет.',
      };
      const code = String((err as Error).message);
      if (!reasons[code]) log.error('Team edit failed:', err);
      await ctx.answerCbQuery(reasons[code] || 'Изменение не подтверждено. Откройте раздел заново.', true); return true;
    }
  }
  if (action === 'list') return showList(ctx, Number(p[2]) || 0);
  if (action === 'pick') {
    if (!cache.staffMembers.has(p[2])) { await ctx.answerCbQuery('Сотрудник больше не зарегистрирован.', true); return true; }
    await ctx.answerCbQuery(); await showMember(ctx, p[2], Number(p[3]) || 0); return true;
  }
  if (action === 'edit') {
    if (!cache.staffMembers.has(p[2])) { await ctx.answerCbQuery('Сотрудник больше не зарегистрирован.', true); return true; }
    if ((typeof db.findActiveReplyCompose === 'function' && await db.findActiveReplyCompose(actor, chat, thread))
      || (typeof db.findAnyActiveManualDraft === 'function' && await db.findAnyActiveManualDraft(actor, chat, thread))
      || (typeof db.findResolutionIntent === 'function' && await db.findResolutionIntent(actor, chat, thread))) {
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
  connections.delete(connectionKey(ctx));
  if (typeof db.cancelStaffNameEdit === 'function')
    await db.cancelStaffNameEdit(ctx.from.id.toString(), String(ctx.chat.id), threadOf(ctx));
}

/** Consumes only the ordinary text bound to this actor/chat/forum topic. */
export async function handleTextInput(ctx: Context): Promise<boolean> {
  if (await handleConnectionInput(ctx)) return true;
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

// Only Telegram's authenticated forward origin supplies identity. Hidden senders,
// copied text, arbitrary usernames and numeric input cannot connect an employee.
const connections = new Map<string, { until: number; token: string; member?: StaffMemberConfig; etag: string }>();
const connectionKey = (ctx: Context) => `${ctx.from.id}:${ctx.chat.id}:${threadOf(ctx)}`;
async function handleConnectionInput(ctx: Context): Promise<boolean> {
  const pending = connections.get(connectionKey(ctx));
  if (!pending) return false;
  if (pending.until < Date.now() || !surface(ctx) || !canManage(String(ctx.from.id))) { connections.delete(connectionKey(ctx)); return false; }
  const origin = (ctx.message as any)?.forward_origin;
  if (origin?.type !== 'user' || origin.sender_user?.is_bot || !Number.isSafeInteger(origin.sender_user?.id)) {
    await middleware.reply(ctx, 'Перешлите сообщение самого инженера с открытым автором. Имя пользователя или скрытый автор не подтверждают Telegram ID.'); return true;
  }
  const user = origin.sender_user;
  pending.token = randomUUID(); // Every preview confirms exactly this identity.
  pending.member = { telegram_id: String(user.id), name: String(user.first_name || 'Инженер').replace(/[\u0000-\u001f\u007f]/g, '').slice(0,80), role: 'agent' as any, active: false };
  await ticketUi.answer(ctx, `Подключить <b>${ticketUi.e(pending.member.name)}</b> (Telegram ID ${pending.member.telegram_id})?\nНачальный уровень: инженер, доступ отключён. Проверьте личность до включения.`, [
    [{ text: 'Подтвердить подключение', callback_data: `sn:join:${pending.token}` }], [ticketUi.STAFF_HOME],
  ]); return true;
}
async function handleAccess(ctx: Context, p: string[]): Promise<boolean> {
  const actor = String(ctx.from.id), action = p[1];
  const s = await readTeamSettings(actor);
  if (action === 'connect') {
    const chat = String(ctx.chat.id), thread = threadOf(ctx);
    if ((typeof db.findActiveReplyCompose === 'function' && await db.findActiveReplyCompose(actor, chat, thread))
      || (typeof db.findAnyActiveManualDraft === 'function' && await db.findAnyActiveManualDraft(actor, chat, thread))
      || (typeof db.findResolutionIntent === 'function' && await db.findResolutionIntent(actor, chat, thread))) throw new Error('team_finish_ticket_input');
    await cancelForHome(ctx);
    // Bound memory; only unfinished enrollment lives here. Persisted staff stays in YAML.
    for (const [key, value] of connections) if (value.until < Date.now()) connections.delete(key);
    if (connections.size >= 100) throw new Error('team_busy');
    connections.set(connectionKey(ctx), { until: Date.now() + INTENT_MS, token: randomUUID(), etag: s.etag });
    await ticketUi.answer(ctx, 'Перешлите текстовое сообщение инженера с видимым автором. Затем подтвердите Telegram ID. Подключение само по себе не даёт доступа.', [[ticketUi.STAFF_HOME]]);
  } else if (action === 'join') {
    const pending = connections.get(connectionKey(ctx));
    if (!pending?.member || pending.token !== p[2] || pending.until < Date.now()) throw new Error('team_stale');
    if (s.members.some(m => m.telegram_id === pending.member!.telegram_id)) throw new Error('team_already_connected');
    await saveTeamMember(actor, pending.etag, pending.member, true);
    connections.delete(connectionKey(ctx));
    await showMember(ctx, pending.member.telegram_id, 0).catch(err => log.error('Team saved, screen refresh failed:', err));
    await ctx.answerCbQuery('Сохранено.');
  } else if (action === 'undo' || action === 'undoapply') {
    if (action === 'undoapply') {
      await undoTeamChange(actor, p[2]);
      await ticketUi.answer(ctx, 'Откат сохранён в истории.', [[ticketUi.STAFF_HOME]])
        .catch(err => log.error('Team rollback saved, screen refresh failed:', err));
      await ctx.answerCbQuery('Откат сохранён.');
    } else {
      const last = s.history.at(-1); if (!last) throw new Error('team_no_history');
      await ticketUi.answer(ctx, `Вернуть предыдущее состояние сотрудника ${ticketUi.e(last.after.name)}? Откат проходит те же проверки прав и назначений.`, [
        [{ text: 'Подтвердить откат', callback_data: `sn:undoapply:${s.etag}` }], [ticketUi.STAFF_HOME],
      ]);
    }
  } else {
    const m = s.members.find(m => m.telegram_id === p[2]); if (!m) throw new Error('team_missing');
    if (action === 'access') {
      await ticketUi.answer(ctx, `Уровень доступа: ${ticketUi.e(staffDisplayName(m.telegram_id))}`, [
        ...['agent','supervisor','admin'].map(role => [{ text: roleLabel[role], callback_data: `sn:change:${m.telegram_id}:${role}:${s.etag}` }]),
        [{ text: m.active === false ? 'Включить' : 'Отключить', callback_data: `sn:change:${m.telegram_id}:${m.active === false ? 'on' : 'off'}:${s.etag}` }], [ticketUi.STAFF_HOME],
      ]);
    } else {
      if (s.etag !== p[4] || !['agent','supervisor','admin','on','off'].includes(p[3])) throw new Error('team_stale');
      const next = { ...m, ...(['on','off'].includes(p[3]) ? { active: p[3] === 'on' } : { role: p[3] as any, active: m.active !== false }) };
      if (action === 'apply') {
        await saveTeamMember(actor, s.etag, next);
        await showMember(ctx, m.telegram_id, 0).catch(err => log.error('Team saved, screen refresh failed:', err));
        await ctx.answerCbQuery('Сохранено.');
      } else {
        await ticketUi.answer(ctx, `Подтвердите: ${ticketUi.e(staffDisplayName(m.telegram_id))} → ${ticketUi.e(roleLabel[next.role])}, ${next.active ? 'включён' : 'отключён'}.\nПеред отключением передайте все активные назначения и предложения.`, [
          [{ text: 'Сохранить', callback_data: `sn:apply:${m.telegram_id}:${p[3]}:${s.etag}` }], [ticketUi.STAFF_HOME],
        ]);
      }
    }
  }
  await ctx.answerCbQuery(); return true;
}
