import { randomBytes, randomUUID } from 'crypto';
import cache from './cache';
import * as db from './db';
import * as ai from './ai-engineer';
import * as middleware from './middleware';
import { Context } from './interfaces';
import { EngineerStore, EngineerTicket, readEngineerRevision } from './ai-engineer-store';
import { engineerPolicy } from './ai-engineer-bridge';
import { readCatalog, requireCatalogBinding } from './ai-engineer-catalog';
import { engineerReady } from './ai-engineer-readiness';
import { refreshStaffCard } from './ticket-ui';

export interface EngineerDraft {
  token: string; version: number; compose_version: number; mode: 'new' | 'rework';
  step: 'input' | 'binding' | 'preview'; goal: string; options: ai.Binding[]; selected: ai.Binding | null;
  owner: string | null; epoch: number; fingerprint: string; base_request: string | null;
  task_id: string; request_id: string; operation_id: string;
}
const store = new EngineerStore(engineerPolicy);
const escape = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const actor = (ctx: Context) => String(ctx.from.id);
const thread = (ctx: Context) => ctx.callbackQuery?.message?.message_thread_id ?? ctx.message?.message_thread_id ?? null;
type Button = { text: string; callback_data: string };
async function panel(ctx: Context, text: string, rows: Button[][] = []) {
  await middleware.reply(ctx, text, { parse_mode: 'HTML', message_thread_id: thread(ctx) ?? undefined,
    reply_markup: { inline_keyboard: rows } });
}
function surface(ctx: Context): boolean {
  return Boolean(ctx.session.admin && String(ctx.chat.id) === String(cache.config.staffchat_id)
    && (!cache.config.staffchat_thread_id || thread(ctx) === cache.config.staffchat_thread_id));
}
function access(ctx: Context, ticket: EngineerTicket): void {
  ai.requireEngineer(surface(ctx) && engineerReady() && ai.authorized(engineerPolicy(), ticket, actor(ctx)), 'not_authorized');
}
function draftAccess(ctx: Context, ticket: db.ISupportee & EngineerTicket, token: string, version?: number): EngineerDraft {
  access(ctx, ticket);
  const draft = ticket.ai_engineer_draft;
  ai.requireEngineer(draft && draft.token === token && (version === undefined || draft.version === version)
    && ticket.pending_reply_staff_id === actor(ctx) && ticket.pending_reply_kind === 'note'
    && ticket.pending_reply_chat_id === String(ctx.chat.id) && ticket.pending_reply_thread_id === thread(ctx)
    && draft.compose_version === ticket.pending_reply_version
    && +new Date(ticket.pending_reply_expires_at!) > Date.now()
    && draft.owner === (ticket.assigned_to ?? null) && draft.epoch === (ticket.ai_epoch ?? 0)
    && draft.fingerprint === ai.policyFingerprint(engineerPolicy())
    && (draft.base_request === (ticket.ai_engineer?.request_id ?? null)
      || (draft.mode === 'new' && draft.request_id === ticket.ai_engineer?.request_id
        && ticket.ai_engineer.requested_by === actor(ctx))), 'draft_stale');
  return draft;
}
async function saveDraft(ticket: db.ISupportee, draft: EngineerDraft, next: EngineerDraft): Promise<void> {
  const changed = await db.Supportee.findOneAndUpdate({ ticketId: ticket.ticketId,
    assigned_to: ticket.assigned_to ?? null, status: ticket.status,
    $expr: { $eq: [{ $ifNull: ['$ai_epoch', 0] }, draft.epoch] },
    pending_reply_staff_id: ticket.pending_reply_staff_id, pending_reply_kind: 'note',
    pending_reply_version: draft.compose_version, pending_reply_expires_at: { $gt: new Date() },
    'ai_engineer_draft.token': draft.token, 'ai_engineer_draft.version': draft.version,
  }, { $set: { ai_engineer_draft: next } }, { new: true });
  ai.requireEngineer(changed, 'draft_stale');
}
const back = (id: number): Button[] => [{ text: 'К заявке', callback_data: `tc:open:${id}` }];
function cancelButton(id: number, draft: EngineerDraft): Button[] {
  return [{ text: 'Отменить ввод', callback_data: `ae:abort:${id}:${draft.token}:${draft.version}` }];
}
async function showDraft(ctx: Context, id: number, d: EngineerDraft, page = 0): Promise<void> {
  if (d.step === 'input') {
    await panel(ctx, `Задание ИИ · заявка №${id}\n${d.mode === 'rework' ? 'Опишите, что исправить в заключении' : 'Опишите симптомы и вопрос для диагностики'} одним обычным сообщением в этой теме. До 1000 символов. Не включайте пароли и ключи.`, [cancelButton(id, d)]);
    return;
  }
  if (d.step === 'binding') {
    const start = page * 6;
    await panel(ctx, 'Выберите объект из каталога АИНОК. Доступна только проверка сведений о хосте.', [
      ...d.options.slice(start, start + 6).map((b, i) => [{ text: b.display_label,
        callback_data: `ae:bind:${id}:${d.token}:${d.version}:${start + i}` }]),
      [...(page > 0 ? [{ text: '◀', callback_data: `ae:page:${id}:${d.token}:${d.version}:${page - 1}` }] : []),
        ...(start + 6 < d.options.length ? [{ text: '▶', callback_data: `ae:page:${id}:${d.token}:${d.version}:${page + 1}` }] : [])],
      cancelButton(id, d),
    ].filter(r => r.length));
    return;
  }
  await panel(ctx, `<b>${d.mode === 'rework' ? 'Доработка заключения' : 'Передача задания ИИ'}</b> · №${id}\nОбъект: ${escape(d.selected?.display_label)}\nПроверка: сведения о хосте, только чтение.\n\n${escape(d.goal)}\n\nИстория переписки не передаётся. Заключение останется внутри команды. Ответственный оператор сохраняется.`, [
    [{ text: 'Подтвердить задание', callback_data: `ae:confirm:${id}:${d.token}:${d.version}` }], cancelButton(id, d),
  ]);
}
async function begin(ctx: Context, ticket: db.ISupportee & EngineerTicket, mode: 'new' | 'rework'): Promise<void> {
  access(ctx, ticket);
  const chat = String(ctx.chat.id), topic = thread(ctx), who = actor(ctx);
  const collisions = await Promise.all([
    db.findActiveReplyCompose(who, chat, topic), db.findAnyActiveManualDraft(who, chat, topic),
    db.findStaffNameEdit(who, chat, topic), db.findResolutionIntent(who, chat, topic),
  ]);
  ai.requireEngineer(!collisions.some(Boolean), 'compose_exists');
  const catalog = await readCatalog(engineerPolicy().scope);
  ai.requireEngineer(catalog.entries.length, 'catalog_unavailable');
  const job = await store.repair(ticket.ticketId);
  ai.requireEngineer(!job?.projection_pending, 'not_ready');
  if (mode === 'new') ai.requireEngineer(!job || ai.TERMINAL.has(job.state), 'task_exists');
  else ai.requireEngineer(job && ['awaiting_operator', 'handed_off', 'failed'].includes(job.state)
    && !job.continuation && ai.current(job, ticket, engineerPolicy()), 'not_ready');
  if (mode === 'rework') await requireCatalogBinding(engineerPolicy().scope, job!.binding);
  // Canary: this ordinary staff path carries the owner-approved request UUID and binding,
  // only for the admitted actor/ticket/owner/epoch/revision. Store.submit re-checks all of it.
  const policy = engineerPolicy(), admission = ai.canaryWindow(policy, Date.now());
  let options = catalog.entries;
  if (admission) {
    ai.requireEngineer(mode === 'new', 'canary_rework_denied');
    options = options.filter(b => b.binding_id === admission.binding_id && b.binding_version === admission.binding_version
      && b.profile_id === admission.profile_id);
    ai.requireEngineer(options.length === 1 && ai.canaryMatches(policy, { scope: policy.scope, ticket_id: ticket.ticketId,
      request_id: admission.request_id, revision: (job?.revision ?? 0) + 1, expected_owner: ticket.assigned_to ?? null,
      ticket_epoch: ticket.ai_epoch ?? 0, requested_by: who, binding: options[0] }), 'canary_not_admitted');
  }
  const draft: EngineerDraft = { token: randomBytes(8).toString('hex'), version: 1, compose_version: 0,
    mode, step: 'input', goal: '', options, selected: mode === 'rework' ? job!.binding : null,
    owner: ticket.assigned_to ?? null, epoch: ticket.ai_epoch ?? 0, fingerprint: ai.policyFingerprint(policy),
    base_request: job?.request_id ?? null, task_id: job?.task_id ?? randomUUID(),
    request_id: admission ? admission.request_id : randomUUID(), operation_id: randomUUID() };
  const prompt = await middleware.sendMessage(chat, cache.config.staffchat_type,
    `Задание ИИ · заявка №${ticket.ticketId}. Внутренний ввод для оператора.`, { message_thread_id: topic ?? undefined });
  ai.requireEngineer(prompt, 'prompt_unavailable');
  const bound = await db.setReplyPrompt(ticket.ticketId, who, Number(prompt), new Date(Date.now() + ai.REQUEST_MS), 'note',
    ticket.assigned_to ?? undefined, chat, topic, ctx.callbackQuery.message!.message_id, draft);
  ai.requireEngineer(bound?.ai_engineer_draft, 'draft_stale');
  await showDraft(ctx, ticket.ticketId, bound.ai_engineer_draft);
}
export function engineerStatus(ticket: db.ISupportee): string {
  const job = ticket.ai_engineer;
  if (!job) return 'Задание не передано';
  if (!ai.current(job, ticket, engineerPolicy())) return 'Задание устарело';
  const labels: Record<ai.EngineerState, string> = { queued: 'В очереди', collecting: 'Диагностика АИНОК',
    summarizing: 'Готовится заключение', awaiting_operator: 'Заключение готово — ждёт оператора',
    handed_off: 'Принято оператором', reworked: 'Возвращено на доработку', failed: 'Диагностика не завершена',
    cancelled: 'Задание отменено', stale: 'Задание устарело' };
  return `${labels[job.state]} · редакция ${job.revision}`;
}
/** In canary mode the start entry is shown only on the admitted ticket; standard mode is unchanged. */
export function engineerOffered(ticket: db.ISupportee): boolean {
  const canary = engineerPolicy().canary;
  return cache.config.ai_engineer_enabled === true && (!canary || canary.admission?.ticket_id === ticket.ticketId);
}
export function engineerCanStart(ticket: db.ISupportee): boolean {
  return !ticket.ai_engineer || !ai.current(ticket.ai_engineer, ticket, engineerPolicy()) || ai.TERMINAL.has(ticket.ai_engineer.state);
}
export function conclusionText(job: Pick<ai.EngineerTask, 'revision' | 'state' | 'input' | 'conclusion' | 'checks'>): string {
  const c = job.conclusion;
  const lines = [`<b>ИИ-инженер · редакция ${job.revision}</b>`, `Задание: ${escape(job.input.goal)}`,
    job.input.feedback ? `Доработка: ${escape(job.input.feedback)}` : '',
    c ? escape(c.summary) : 'Заключение пока недоступно. Можно повторить диагностику или продолжить вручную.',
    c ? `<b>Подтверждено</b>\n${c.verified_findings.map(f => `${escape(f.text)} [${escape(f.evidence_refs.join(', '))}]`).join('\n') || 'Нет'}` : '',
    c ? `<b>Гипотезы</b>\n${escape(c.hypotheses.join('\n')) || 'Нет'}` : '',
    c ? `<b>Неизвестно</b>\n${escape(c.unknowns.join('\n')) || 'Нет'}` : '',
    c ? `<b>Рекомендации оператору</b>\n${escape(c.recommended_next_steps.join('\n')) || 'Нет'}` : '',
    c ? `<b>Черновик ответа — клиенту не отправлен</b>\n${escape(c.customer_reply_draft)}` : '',
  ];
  // Paragraph-level truncation preserves valid HTML; full sections remain in the stored revision.
  let output = '';
  for (const line of lines.filter(Boolean)) {
    if (output.length + line.length + 2 > 3600) { output += '\n\nЧасть разделов скрыта из-за длины.'; break; }
    output += `${output ? '\n\n' : ''}${line}`;
  }
  return output;
}
export async function handleEngineerCallback(ctx: Context, p: string[]): Promise<boolean> {
  try {
    ai.requireEngineer(surface(ctx), 'not_authorized');
    const id = Number(p[2]), action = p[1];
    const ticket = await store.read(id) as db.ISupportee & EngineerTicket;
    ai.requireEngineer(engineerPolicy().staff.some(s => s.telegram_id === actor(ctx)), 'not_authorized');
    if (action === 'view') {
      const job = ticket.ai_engineer;
      ai.requireEngineer(job, 'task_missing');
      const token = randomBytes(8).toString('hex');
      const canAct = engineerReady() && ai.authorized(engineerPolicy(), ticket, actor(ctx)) && ai.current(job, ticket, engineerPolicy());
      if (canAct) await db.setPendingTicketAction(id, `ae:${job.request_id}`, token, actor(ctx), new Date(Date.now() + ai.REQUEST_MS));
      await panel(ctx, conclusionText(job), [
        ...(canAct && job.state === 'awaiting_operator' ? [[{ text: 'Принять оператору', callback_data: `ae:handoff:${id}:${token}` }]] : []),
        ...(canAct && ['awaiting_operator', 'handed_off', 'failed'].includes(job.state) && !job.continuation
          && !engineerPolicy().canary ? [[{ text: 'Вернуть на доработку', callback_data: `ae:rework:${id}:${token}` }]] : []),
        ...(canAct && !ai.TERMINAL.has(job.state) ? [[{ text: 'Отменить задание', callback_data: `ae:cancel:${id}:${token}` }]] : []),
        [{ text: 'Все разделы заключения', callback_data: `ae:section:${id}:${job.revision}:0` }],
        ...(job.revision > 1 ? [[{ text: 'Предыдущая редакция', callback_data: `ae:section:${id}:${job.revision - 1}:0` }]] : []),
        back(id),
      ]);
    } else if (action === 'section') {
      const revision = Number(p[3]), section = Number(p[4]), current = ticket.ai_engineer;
      ai.requireEngineer(current && Number.isSafeInteger(revision) && revision > 0 && revision <= current.revision, 'invalid_revision');
      const job = revision === current.revision ? current : await readEngineerRevision(current.scope, id, current.task_id, revision);
      ai.requireEngineer(job && Number.isSafeInteger(section) && section >= 0 && section < 9, 'invalid_section');
      const c = job.conclusion;
      const sections = [job.input.goal, job.input.feedback || 'Нет', c?.summary || 'Заключение недоступно',
        c?.verified_findings.map((f: any) => `${f.text} [${f.evidence_refs.join(', ')}]`).join('\n') || 'Нет',
        c?.hypotheses.join('\n') || 'Нет', c?.unknowns.join('\n') || 'Нет',
        c?.recommended_next_steps.join('\n') || 'Нет', c?.customer_reply_draft || 'Нет',
        job.checks ? JSON.stringify(job.checks, null, 2) : 'Проверки пока не получены'];
      const labels = ['Задание', 'Доработка', 'Итог', 'Подтверждено', 'Гипотезы', 'Неизвестно', 'Рекомендации', 'Черновик ответа — не отправлен', 'Технические детали — разрешённые факты'];
      // Each contract section is bounded; escape before splitting to keep entities intact.
      const raw = String(sections[section]);
      const chunks = raw.match(/[\s\S]{1,650}/g) || ['Нет'];
      const page = p[5] === undefined ? 0 : Number(p[5]);
      ai.requireEngineer(Number.isSafeInteger(page) && page >= 0 && page < chunks.length, 'invalid_page');
      await panel(ctx, `<b>Редакция ${revision} · ${labels[section]}</b>\n${escape(chunks[page])}`, [
        [...(page > 0 ? [{ text: '◀ Страница', callback_data: `ae:section:${id}:${revision}:${section}:${page - 1}` }] : []),
          ...(page + 1 < chunks.length ? [{ text: 'Страница ▶', callback_data: `ae:section:${id}:${revision}:${section}:${page + 1}` }] : [])],
        [...(section > 0 ? [{ text: '◀ Раздел', callback_data: `ae:section:${id}:${revision}:${section - 1}` }] : []),
          ...(section < 8 ? [{ text: 'Раздел ▶', callback_data: `ae:section:${id}:${revision}:${section + 1}` }] : [])],
        [...(revision > 1 ? [{ text: '◀ Редакция', callback_data: `ae:section:${id}:${revision - 1}:0` }] : []),
          ...(revision < current.revision ? [{ text: 'Редакция ▶', callback_data: `ae:section:${id}:${revision + 1}:0` }] : [])], back(id),
      ].filter(r => r.length));
    } else if (action === 'start') {
      const q = ctx.callbackQuery.message;
      ai.requireEngineer(q && String(q.chat.id) === ticket.staff_card_chat_id && q.message_id === ticket.staff_card_message_id
        && (q.message_thread_id ?? null) === (ticket.staff_card_thread_id ?? null), 'card_stale');
      await begin(ctx, ticket, 'new');
    } else if (['handoff', 'rework', 'cancel'].includes(action)) {
      access(ctx, ticket);
      const job = ticket.ai_engineer; ai.requireEngineer(job, 'task_missing');
      ai.requireEngineer(await db.consumePendingTicketAction(id, `ae:${job.request_id}`, p[3], actor(ctx)), 'action_stale');
      if (action === 'rework') await begin(ctx, ticket, 'rework');
      else {
        if (action === 'handoff') await store.handoff(id, job.request_id, actor(ctx));
        else await store.cancel(id, job.request_id, actor(ctx));
        await panel(ctx, action === 'handoff' ? 'Заключение принято оператором. Дальнейшие действия выполняются вручную.'
          + (!ticket.assigned_to ? ' У заявки пока нет ответственного: откройте карточку и нажмите «Взять».' : '') : 'Задание отменено.', [back(id)]);
        await refreshStaffCard(id);
      }
    } else {
      if (action === 'abort') {
        const d = ticket.ai_engineer_draft;
        ai.requireEngineer(d && d.token === p[3] && d.version === Number(p[4])
          && d.compose_version === ticket.pending_reply_version && ticket.pending_reply_staff_id === actor(ctx)
          && ticket.pending_reply_chat_id === String(ctx.chat.id) && ticket.pending_reply_thread_id === thread(ctx), 'draft_stale');
        await db.clearReplyPrompt(id, actor(ctx), d.compose_version);
        await panel(ctx, 'Ввод задания отменён.', [back(id)]);
        await ctx.answerCbQuery(); return true;
      }
      const d = draftAccess(ctx, ticket, p[3], Number(p[4]));
      if (action === 'page') {
        const page = Number(p[5]); ai.requireEngineer(d.step === 'binding' && Number.isSafeInteger(page)
          && page >= 0 && page * 6 < d.options.length, 'invalid_page');
        await showDraft(ctx, id, d, page);
      } else if (action === 'bind') {
        const index = Number(p[5]); ai.requireEngineer(d.step === 'binding' && Number.isSafeInteger(index) && d.options[index], 'binding_missing');
        const binding = d.options[index]; await requireCatalogBinding(engineerPolicy().scope, binding);
        const next: EngineerDraft = { ...d, selected: binding, step: 'preview', version: d.version + 1 };
        await saveDraft(ticket, d, next); await showDraft(ctx, id, next);
      } else if (action === 'confirm') {
        ai.requireEngineer(d.step === 'preview' && d.selected, 'draft_stale');
        await requireCatalogBinding(engineerPolicy().scope, d.selected);
        const fence = { owner: d.owner, epoch: d.epoch, base_request: d.base_request,
          draft: { token: d.token, version: d.version, compose_version: d.compose_version,
            actor: actor(ctx), chat: String(ctx.chat.id), thread: thread(ctx) } };
        if (d.mode === 'new') await store.submit(id, actor(ctx), d.selected, { goal: d.goal, history: '', feedback: '' },
          { task_id: d.task_id, request_id: d.request_id }, fence);
        else await store.rework(id, d.base_request!, actor(ctx), d.operation_id, d.goal,
          fence);
        await db.clearReplyPrompt(id, actor(ctx), d.compose_version);
        await panel(ctx, 'Задание передано ИИ-инженеру. АИНОК выполнит только проверку на чтение; заключение появится в этой заявке.', [back(id)]);
        await refreshStaffCard(id);
      } else throw new ai.EngineerError('unknown_action');
    }
    await ctx.answerCbQuery();
  } catch (error) {
    const code = error instanceof ai.EngineerError ? error.code : 'temporarily_unavailable';
    const message = code === 'compose_exists' ? 'Сначала завершите или отмените текущий ввод.'
      : code === 'catalog_unavailable' || code === 'binding_unavailable' ? 'Каталог АИНОК недоступен. Повторите позже.'
      : 'Действие недоступно или устарело. Откройте актуальную карточку и повторите.';
    await ctx.answerCbQuery(message, true);
  }
  return true;
}
/** Intercept before generic note/reply handling. An AI form can never become a customer reply. */
export async function handleEngineerText(ctx: Context): Promise<boolean> {
  if (!surface(ctx) || !db.Supportee || typeof ctx.message?.text !== 'string' || ctx.message.text.startsWith('/')) return false;
  const replied = (ctx.message.reply_to_message as { message_id?: number } | undefined)?.message_id;
  const ticket = await db.Supportee.findOne({ pending_reply_staff_id: actor(ctx), pending_reply_chat_id: String(ctx.chat.id),
    pending_reply_thread_id: thread(ctx), pending_reply_kind: 'note', ai_engineer_draft: { $ne: null },
    ...(replied ? { pending_reply_prompt_id: replied } : {}),
    $expr: { $eq: ['$ai_engineer_draft.compose_version', '$pending_reply_version'] },
  }).lean() as db.ISupportee | null;
  if (!ticket?.ai_engineer_draft) return false;
  try {
    const live = await store.read(ticket.ticketId) as db.ISupportee & EngineerTicket;
    const d = draftAccess(ctx, live, ticket.ai_engineer_draft.token);
    ai.requireEngineer(d.step === 'input', 'input_not_expected');
    const goal = ai.text(ai.redactEngineerText(ctx.message.text, [cache.config.bot_token, cache.config.llm_api_key]), 1000);
    const next: EngineerDraft = { ...d, goal, version: d.version + 1, step: d.mode === 'new' ? 'binding' : 'preview' };
    await saveDraft(live, d, next); await showDraft(ctx, ticket.ticketId, next);
  } catch (error) {
    // Retire expired/disabled/invalidated AI compose before returning: otherwise
    // it would intercept every later staff text and block ordinary support.
    if (!(error instanceof ai.EngineerError) || !['invalid_text', 'input_not_expected'].includes(error.code)) {
      await db.clearReplyPrompt(ticket.ticketId, actor(ctx), ticket.pending_reply_version ?? undefined).catch(() => undefined);
    }
    await panel(ctx, 'Текст для задания ИИ не принят. Проверьте права, срок ввода и длину текста; откройте карточку для повтора.', [back(ticket.ticketId)]);
  }
  return true;
}
