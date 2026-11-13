import * as db from './db';
import * as team from './team';
import * as visibility from './ticket-visibility';
import * as ui from './ticket-ui';
import { Context } from './interfaces';
import { isManualTicket } from './manual-ticket-guard';

const validId = (id: string) => /^[a-f0-9]{24}$/i.test(id || '');
/** A profile is discoverable only through tickets the actor can currently read. */
export async function accessibleClient(actor: string, id: string): Promise<db.IClientProfile | null> {
  if (!team.getStaffRole(actor) || !validId(id)) return null;
  const profile = await db.ClientProfile.findById(id);
  if (!profile) return null;
  const tickets = await db.Supportee.find({ userid: profile.userid, messenger: profile.messenger });
  return tickets.some(t => visibility.canViewTicket(actor, t)) && team.getStaffRole(actor) ? profile : null;
}

export async function showClients(ctx: Context, actor: string, page: number,
  select: (id: string) => string, navigate: (page: number) => string) {
  if (!ui.isStaffPrivate(ctx) || !Number.isSafeInteger(page) || page < 0 || page > 100000) return;
  // Page before rendering, and recheck every row; never expose inaccessible profile fields.
  const profiles = await db.ClientProfile.find({}).sort({ _id: 1 }).skip(page * 6).limit(7);
  const rows: ui.Button[][] = [];
  for (const profile of profiles.slice(0, 6)) {
    if (await accessibleClient(actor, String(profile._id))) rows.push([{
      text: String(profile.organization || 'Клиент').slice(0, 70) + ' · ' + profile.messenger + ':' + profile.userid,
      callback_data: select(String(profile._id)),
    }]);
  }
  rows.push([
    ...(page ? [{ text: '◀️', callback_data: navigate(page - 1) }] : []),
    ...(profiles.length > 6 ? [{ text: '▶️', callback_data: navigate(page + 1) }] : []),
  ]);
  rows.push([ui.STAFF_HOME]);
  if (!team.getStaffRole(actor)) return;
  await ui.answer(ctx, 'Выберите доступный профиль клиента. Совпадение имени или контакта не устанавливает связь.\nПустая страница: перейдите дальше.', rows.filter(r => r.length));
}

function canBind(actor: string, t: db.ISupportee) {
  return visibility.canViewTicket(actor, t) && team.canPerformAction(actor, 'reply')
    && (team.canManageTicket(actor, t.assigned_to) || (!t.assigned_to && t.created_by === actor && isManualTicket(t)));
}
export async function handleCallback(ctx: Context, p: string[]): Promise<boolean> {
  const actor = String(ctx.from.id), id = Number(p[2]);
  const privateSurface = ui.isStaffPrivate(ctx);
  if (!privateSurface && !ui.staffSurface(ctx)) {
    await ctx.answerCbQuery('Недоступно вне рабочей группы/темы.', true); return true;
  }
  const t = Number.isSafeInteger(id) && id > 0 ? await db.getTicketById(id, null) : null;
  if (!t || !visibility.canViewTicket(actor, t)) {
    await ctx.answerCbQuery('Заявка недоступна.', true); return true;
  }
  if (!privateSurface) {
    const sent = await visibility.sendToStaffPrivate(actor, 'Продолжить работу со связью заявки № ' + id + ' в личном чате.', {
      reply_markup: { inline_keyboard: [[{ text: 'Открыть заявку', callback_data: `tc:open:${id}` },
        { text: p[1] === 'org' ? 'Проверка организации профиля' : 'Привязать клиента', callback_data: p[1] === 'org' ? `cl:org:${id}` : `cl:list:${id}:0` }]] },
    });
    await ctx.answerCbQuery(sent ? 'Продолжите в личном чате с ботом.' : visibility.PRIVATE_UNAVAILABLE, true);
    return true;
  }
  if (p[1] === 'org') {
    await ui.answer(ctx, 'Связь заявки с клиентом не подтверждает принадлежность профиля организации. Проверку доверенного контакта и подтверждение выполняет администратор.',
      [...(team.canPerformAction(actor, 'manage_team') ? [[{ text: 'Проверка профилей организаций', callback_data: 'cfg:bindings' }]] : []), [ui.STAFF_HOME]]);
    await ctx.answerCbQuery(); return true;
  }
  if (!canBind(actor, t) || t.linked_client_id) {
    await ctx.answerCbQuery('Связь уже установлена или нет прав на изменение.', true); return true;
  }
  const version = +new Date(t.updated_at);
  if (p[1] === 'list') {
    await showClients(ctx, actor, Number(p[3]), cid => `cl:pick:${id}:${version}:${cid}`, page => `cl:list:${id}:${page}`);
    await ctx.answerCbQuery(); return true;
  }
  if (!['pick', 'ok'].includes(p[1]) || Number(p[3]) !== version) {
    await ctx.answerCbQuery('Кнопка устарела. Обновите карточку.', true); return true;
  }
  const profile = await accessibleClient(actor, p[4]);
  if (!profile) { await ctx.answerCbQuery('Клиент недоступен.', true); return true; }
  if (p[1] === 'pick') {
    await ui.answer(ctx, `Связать заявку № ${id} с профилем ${ui.e(profile.messenger)}:${ui.e(profile.userid)}?\nСообщение клиенту не отправляется. Организация не подтверждается.`,
      [[{ text: 'Подтвердить связь', callback_data: `cl:ok:${id}:${version}:${p[4]}` }], [ui.STAFF_HOME]]);
  } else {
    const current = await db.getTicketById(id, null);
    if (!current || !canBind(actor, current) || !await accessibleClient(actor, p[4])) {
      await ctx.answerCbQuery('Права изменились.', true); return true;
    }
    // Link and audit are one atomic write. Transport, routing and number stay intact.
    const changed = await db.Supportee.findOneAndUpdate({
      ticketId: id, updated_at: t.updated_at, linked_client_id: null,
      // Mongo null equality matches both explicit null and a missing legacy field.
      assigned_to: t.assigned_to ?? null,
      // Mongoose hydrates the absent legacy field as false; match its stored form too.
      common_visible: t.common_visible === true ? true : { $ne: true },
    }, { $set: { linked_client_id: p[4] }, $push: {
      client_link_audit: { actor, at: new Date(), from: null, to: p[4] },
    } }, { new: true });
    if (!changed) { await ctx.answerCbQuery('Заявка изменилась. Обновите карточку.', true); return true; }
    await ui.refreshStaffCard(id);
    await ui.answer(ctx, 'Клиент привязан. Номер и история сохранены. Клиенту ничего не отправлено.',
      [[{ text: 'Открыть заявку', callback_data: `tc:open:${id}` }, ui.STAFF_HOME]]);
  }
  await ctx.answerCbQuery(); return true;
}
