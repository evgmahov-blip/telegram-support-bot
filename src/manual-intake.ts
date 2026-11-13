import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import * as ticketUi from './ticket-ui';
import { Context } from './interfaces';
import { MANUAL_SOURCE_LABELS } from './manual-ticket-guard';
import { randomBytes } from 'crypto';
import * as visibility from './ticket-visibility';
import * as ticketClient from './ticket-client-binding';
import { staffDisplayName } from './staff-names';

const DRAFT_MS = 15 * 60 * 1000;
export const LIMITS = { client: 200, contact: 200, description: 3000 };
type Rows = ticketUi.Button[][];
type Step = 'client'|'description'|'contact';
const threadOf = (ctx: Context): number | null => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
export type ManualFields = { client: string; contact: string | null; description: string };
const token = (bytes: number) => randomBytes(bytes).toString('hex');
const pad = (id: number) => String(id).padStart(6, '0');
const expires = () => new Date(Date.now() + DRAFT_MS);
const clean = (value: string, multiline = false) => {
  const safe = String(value || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return multiline ? safe : safe.replace(/\s+/g, ' ');
};

/* Compatibility parser for historical forms; the wizard itself needs no labels. */
export function parseManualForm(text: string): { fields?: ManualFields; error?: string } {
  const found: Record<string, string[]> = { client: [], contact: [], description: [] }; let field = '';
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^\s*(клиент(?:\s*\/\s*организация)?|организация|контакт|описание)\s*[:：]\s*(.*)$/i);
    if (m) { field = m[1].toLowerCase().startsWith('контакт') ? 'contact' : m[1].toLowerCase().startsWith('описание') ? 'description' : 'client'; found[field].push(m[2]); }
    else if (field) found[field].push(line);
  }
  const client = clean(found.client.join('\n')); const contact = clean(found.contact.join('\n'));
  const description = clean(found.description.join('\n'), true);
  if (!client || !description) return { error: 'Старая форма больше не используется. Начните новый пошаговый ввод.' };
  return { fields: { client, contact: contact || null, description } };
}

function allowedSurface(ctx: Context) {
  return (ctx.chat?.type === 'private' && String(ctx.chat.id) === String(ctx.from.id) && ctx.messenger === 'telegram')
    || (ctx.session.admin && String(ctx.chat.id) === String(cache.config.staffchat_id)
      && (!cache.config.staffchat_thread_id || threadOf(ctx) === cache.config.staffchat_thread_id));
}
function canCreate(actor: string) { return Boolean(team.getStaffRole(actor)) && team.canPerformAction(actor, 'reply'); }
const nav = (d: any, back = true): Rows => [[
  ...(back ? [{ text: '⬅️ Назад', callback_data: `mi:b:${d.token}:${d.version}` }] : []),
  { text: '✖️ Отмена', callback_data: `mi:x:${d.token}:${d.version}` }, ticketUi.STAFF_HOME,
]];
const stepTitle: Record<Step, string> = { client: 'Кто обратился?', description: 'Что случилось?', contact: 'Контакт' };
const stepLimit: Record<Step, number> = { client: LIMITS.client, description: LIMITS.description, contact: LIMITS.contact };

async function showStep(ctx: Context, d: any) {
  const step = d.step as Step;
  const hint = step === 'client' ? 'Выберите существующий профиль или «Без клиента». Можно отправить краткое имя как справку; текст сам по себе не устанавливает связь.' : step === 'description'
    ? 'Отправьте обычный текст; можно несколько строк.' : 'Телефон, email или другой способ связи. Это поле необязательно.';
  const rows = nav(d);
  if (step === 'client') rows.unshift([
    { text: 'Выбрать клиента', callback_data: `mi:clients:${d.token}:${d.version}:0` },
    { text: 'Без клиента', callback_data: `mi:none:${d.token}:${d.version}` },
  ]);
  if (step === 'contact') rows.unshift([{ text: 'Пропустить', callback_data: `mi:skip:${d.token}:${d.version}` }]);
  await ticketUi.answer(ctx, `<a href="tg://user?id=${ticketUi.e(d.actor_id)}">${ticketUi.e(staffDisplayName(d.actor_id))}</a>\n<b>${stepTitle[step]}</b>\n${hint}\n\nЛимит: ${stepLimit[step]} символов. Ожидаю следующее обычное текстовое сообщение в этой теме.`, rows);
}

async function showSource(ctx: Context, d: any) {
  await ticketUi.answer(ctx, '<b>Новая ручная заявка</b>\nОткуда пришло обращение?', [
    [{ text: '📞 Телефон', callback_data: `mi:s:${d.token}:${d.version}:phone` }, { text: '✉️ Почта', callback_data: `mi:s:${d.token}:${d.version}:email` }],
    [{ text: '🤝 Лично', callback_data: `mi:s:${d.token}:${d.version}:in_person` }, { text: '📎 Другое', callback_data: `mi:s:${d.token}:${d.version}:other` }], ...nav(d, false),
  ]);
}

async function showPreview(ctx: Context, d: any) {
  const source = MANUAL_SOURCE_LABELS[d.source as db.ManualSource] || 'Другое';
  await ticketUi.answer(ctx, `<b>Проверьте ручную заявку</b>\nСвязь с профилем: ${ticketUi.e(d.linked_client_id || 'без клиента')}\nИсточник: ${ticketUi.e(source)}\nКто обратился: ${ticketUi.e(d.client)}\nКонтакт: ${ticketUi.e(d.contact || '—')}\n\n<b>Что случилось</b>\n${ticketUi.e(d.description)}\n\nЗаявка появится в разделе «Новые». Клиенту ничего не отправляется.`, [
    [{ text: '✅ Создать', callback_data: `mi:ok:${d.token}:${d.version}` }, { text: '✏️ Изменить', callback_data: `mi:edit:${d.token}:${d.version}` }], ...nav(d),
  ]);
}

export async function startDraft(ctx: Context): Promise<boolean> {
  const actor = ctx.from.id.toString();
  if (!allowedSurface(ctx) || !canCreate(actor)) { await ctx.answerCbQuery('Нет прав на создание заявок.', true); return true; }
  const thread = threadOf(ctx);
  if (typeof db.clearExpiredReplyComposes === 'function')
    await db.clearExpiredReplyComposes(actor, String(ctx.chat.id), thread);
  if (typeof db.findActiveReplyCompose === 'function'
    && await db.findActiveReplyCompose(actor, String(ctx.chat.id), thread)) {
    await ctx.answerCbQuery('Сначала отправьте или отмените текущий ответ клиенту/заметку.', true);
    return true;
  }
  if (typeof db.findStaffNameEdit === 'function'
    && await db.findStaffNameEdit(actor, String(ctx.chat.id), thread)) {
    await ctx.answerCbQuery('Сначала сохраните или отмените изменение имени.', true);
    return true;
  }
  if (typeof db.findResolutionIntent === 'function'
    && await db.findResolutionIntent(actor, String(ctx.chat.id), thread)) {
    await ctx.answerCbQuery('Сначала сохраните или отмените запись решения.', true);
    return true;
  }
  const d = await db.startManualDraft(token(8), actor, String(ctx.chat.id), thread, expires());
  await showSource(ctx, d);
  await ctx.answerCbQuery(); return true;
}

export async function cancelActiveForHome(ctx: Context) {
  if (typeof db.cancelActiveManualDraft === 'function')
    await db.cancelActiveManualDraft(ctx.from.id.toString(), String(ctx.chat.id), threadOf(ctx));
  if (typeof db.cancelActiveReplyCompose === 'function')
    await db.cancelActiveReplyCompose(ctx.from.id.toString(), String(ctx.chat.id), threadOf(ctx));
}

export async function handleDraftCallback(ctx: Context, p: string[]): Promise<boolean> {
  const actor = ctx.from.id.toString(), action = p[1], t = p[2];
  if (!allowedSurface(ctx) || !canCreate(actor)) { await ctx.answerCbQuery('Нет прав на создание заявок.', true); return true; }
  const d = t ? await db.getManualDraft(t) : null;
  if (!d || d.actor_id !== actor || d.chat_id !== String(ctx.chat.id) || (d.thread_id ?? null) !== threadOf(ctx)) { await ctx.answerCbQuery('Черновик устарел или принадлежит другому сотруднику.', true); return true; }
  const version = Number(p[3]);
  if (action === 'x') {
    const cancelled = d.version === version && await db.cancelManualDraft(t, actor, version);
    if (!cancelled) await ctx.answerCbQuery('Кнопка устарела.', true); else { await ticketUi.answer(ctx, 'Создание ручной заявки отменено.', [[ticketUi.STAFF_HOME]]); await ctx.answerCbQuery('Отменено.'); }
    return true;
  }
  if (action === 'ok') {
    if (d.status === 'created' && d.ticketId) { await ctx.answerCbQuery(`Заявка уже создана: #T${pad(d.ticketId)}.`, true); return true; }
    if (d.linked_client_id && !await ticketClient.accessibleClient(actor, d.linked_client_id)) {
      await ctx.answerCbQuery('Клиент больше недоступен. Выберите заново.', true); return true;
    }
    const claimed = await db.claimManualDraftConfirm(t, actor, String(version));
    if (!claimed?.source || !claimed.client || !claimed.description) { await ctx.answerCbQuery('Подтверждение устарело. Откройте актуальный предпросмотр.', true); return true; }
    if (!canCreate(actor) || !allowedSurface(ctx)
      || (claimed.linked_client_id && !await ticketClient.accessibleClient(actor, claimed.linked_client_id))) {
      await ctx.answerCbQuery('Права изменились. Создание не выполнено.', true); return true;
    }
    const { ticket } = await db.createManualTicket(t, { source: claimed.source, client: claimed.client, contact: claimed.contact, description: claimed.description, createdBy: actor, linkedClientId: claimed.linked_client_id });
    await db.completeManualDraft(t, ticket.ticketId); await ticketUi.refreshStaffCard(ticket.ticketId);
    await ticketUi.answer(ctx, `Ручная заявка № ${ticket.ticketId} создана. Клиенту ничего не отправлялось.`, [[{ text: '⬅️ К заявке', callback_data: `tc:open:${ticket.ticketId}` }, ticketUi.STAFF_HOME]]);
    await ctx.answerCbQuery('Готово.'); return true;
  }
  let saved: any = null;
  if (['clients','pick','selected'].includes(action)) {
    if (d.version !== version || d.status !== 'input' || d.step !== 'client' || +new Date(d.expires_at) <= Date.now()) {
      await ctx.answerCbQuery('Кнопка устарела.', true); return true;
    }
    if (!ticketUi.isStaffPrivate(ctx)) {
      if (action !== 'clients') { await ctx.answerCbQuery('Подтверждение доступно в личном чате.', true); return true; }
      const moved = await db.transitionManualDraft(t, actor, version, { status: 'input', step: 'client' },
        { chat_id: actor, thread_id: null }, expires());
      const sent = moved && await visibility.sendToStaffPrivate(actor, 'Продолжить выбор клиента для ручной заявки. Список доступен только в личном чате.', {
        reply_markup: { inline_keyboard: [[{ text: 'Выбрать клиента', callback_data: `mi:clients:${t}:${moved.version}:0` }, ticketUi.STAFF_HOME]] },
      });
      await ctx.answerCbQuery(sent ? 'Продолжите в личном чате с ботом.' : visibility.PRIVATE_UNAVAILABLE, true); return true;
    }
    if (action === 'clients') {
      await ticketClient.showClients(ctx, actor, Number(p[4]), (id) => `mi:pick:${t}:${version}:${id}`,
        (page) => `mi:clients:${t}:${version}:${page}`);
      await ctx.answerCbQuery(); return true;
    }
    const profile = await ticketClient.accessibleClient(actor, p[4]);
    if (!profile) { await ctx.answerCbQuery('Клиент недоступен.', true); return true; }
    if (action === 'pick') {
      await ticketUi.answer(ctx, `Связать заявку с профилем ${ticketUi.e(profile.messenger)}:${ticketUi.e(profile.userid)}? Это не подтверждает организацию и не отправляет сообщение.`,
        [[{ text: 'Подтвердить клиента', callback_data: `mi:selected:${t}:${version}:${p[4]}` }], ...nav(d)]);
      await ctx.answerCbQuery(); return true;
    }
    saved = await db.transitionManualDraft(t, actor, version, { status: 'input', step: 'client' },
      { linked_client_id: p[4], client: profile.organization || 'Клиент', step: d.edit_return || d.client_after_contact ? null : 'description', status: d.edit_return || d.client_after_contact ? 'preview' : 'input', edit_return: false, confirm_nonce: d.edit_return || d.client_after_contact ? String(version + 1) : null }, expires());
  } else if (action === 'none') {
    saved = await db.transitionManualDraft(t, actor, version, { status: 'input', step: 'client' },
      { linked_client_id: null, client: 'Без клиента', step: d.edit_return || d.client_after_contact ? null : 'description', status: d.edit_return || d.client_after_contact ? 'preview' : 'input', edit_return: false, confirm_nonce: d.edit_return || d.client_after_contact ? String(version + 1) : null }, expires());
  } else if (action === 's') {
    const source = p[4] as db.ManualSource;
    if (db.MANUAL_SOURCES.includes(source)) saved = await db.transitionManualDraft(t, actor, version, { status: 'source' }, { source, status: 'input', step: d.client_after_contact ? 'description' : 'client', edit_return: false }, expires());
  } else if (action === 'skip') saved = await db.transitionManualDraft(t, actor, version, { status: 'input', step: 'contact' }, { contact: null, status: d.client_after_contact && !d.edit_return ? 'input' : 'preview', step: d.client_after_contact && !d.edit_return ? 'client' : null, edit_return: false, confirm_nonce: d.client_after_contact && !d.edit_return ? null : String(version + 1) }, expires());
  else if (action === 'b') {
    const previous = d.client_after_contact
      ? (d.status === 'preview' ? 'client' : d.step === 'client' ? 'contact' : d.step === 'contact' ? 'description' : d.step === 'description' ? 'source' : null)
      : d.status === 'preview' ? 'contact' : d.step === 'contact' ? 'description' : d.step === 'description' ? 'client' : d.step === 'client' ? 'source' : null;
    if (previous) saved = await db.transitionManualDraft(t, actor, version, { status: d.status, step: d.step },
      previous === 'source' ? { status: 'source', step: null, edit_return: false, confirm_nonce: null } : { status: 'input', step: previous, edit_return: false, confirm_nonce: null }, expires());
  } else if (action === 'edit') {
    if (d.status === 'preview' && d.version === version) {
      await ticketUi.answer(ctx, '<b>Что изменить?</b>', [[{ text: 'Кто обратился', callback_data: `mi:f:${t}:${version}:client` }, { text: 'Что случилось', callback_data: `mi:f:${t}:${version}:description` }], [{ text: 'Контакт', callback_data: `mi:f:${t}:${version}:contact` }], ...nav(d)]);
      await ctx.answerCbQuery(); return true;
    }
  } else if (action === 'f' && ['client','description','contact'].includes(p[4])) saved = await db.transitionManualDraft(t, actor, version, { status: 'preview' }, { status: 'input', step: p[4], edit_return: true, confirm_nonce: null }, expires());
  if (!saved) { await ctx.answerCbQuery('Кнопка устарела. Используйте актуальный экран.', true); return true; }
  if (saved.status === 'preview') await showPreview(ctx, saved); else if (saved.status === 'source') await showSource(ctx, saved); else await showStep(ctx, saved);
  await ctx.answerCbQuery(); return true;
}

/** Consume only a plain, non-command, non-reply message on an explicitly active step. */
export async function handleTextInput(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith('/') || ctx.message?.reply_to_message) return false;
  const actor = ctx.from.id.toString(), chat = String(ctx.chat.id), thread = threadOf(ctx);
  if (!allowedSurface(ctx) || !canCreate(actor)) return false;
  const d = await db.findActiveManualDraft(actor, chat, thread); if (!d?.step) return false;
  const step = d.step as Step; const value = clean(text, step === 'description');
  if (!value) { await middleware.reply(ctx, `Поле «${stepTitle[step]}» не может быть пустым.`, { message_thread_id: thread ?? undefined }); return true; }
  if (value.length > stepLimit[step]) { await middleware.reply(ctx, `Поле «${stepTitle[step]}» длиннее ${stepLimit[step]} символов. Значение не изменено; отправьте короче.`, { message_thread_id: thread ?? undefined }); return true; }
  const next = d.edit_return ? null : d.client_after_contact
    ? (step === 'description' ? 'contact' : step === 'contact' ? 'client' : null)
    : step === 'client' ? 'description' : step === 'description' ? 'contact' : null;
  const saved = await db.consumeManualDraftInput(d.token, actor, chat, thread, d.version, step, ctx.message.message_id, value, next, expires());
  if (!saved) return true;
  if (saved.status === 'preview') await showPreview(ctx, saved);
  else await showStep(ctx, saved);
  return true;
}

/** Historical ForceReply prompts fail closed and direct the engineer to the wizard. */
export async function handleFormReply(ctx: Context, promptId: number): Promise<boolean> {
  if (typeof db.findManualDraftByPrompt !== 'function') return false;
  const old = await db.findManualDraftByPrompt(String(ctx.chat.id), promptId);
  if (!old) return false;
  await middleware.reply(ctx, 'Эта подсказка относится к старой форме. Откройте «Главная» → «Создать заявку вручную» и пройдите пошаговый ввод.', { message_thread_id: threadOf(ctx) ?? undefined });
  return true;
}
