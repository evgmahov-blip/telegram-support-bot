const mockFind = jest.fn(), mockUpdate = jest.fn(), mockRead = jest.fn(), mockRepair = jest.fn();
const mockSubmit = jest.fn(), mockRework = jest.fn(), mockHandoff = jest.fn(), mockCancel = jest.fn();
const mockReply = jest.fn(), mockBinding = jest.fn(), mockConsume = jest.fn(), mockClear = jest.fn();
const mockReadRevision = jest.fn();
let mockReady = true, mockPolicy: any;
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_thread_id: 5, staffchat_type: 'telegram', bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUV', llm_api_key: 'sk-secret-key-value',
} } }));
jest.mock('../src/db', () => ({
  Supportee: { findOne: mockFind, findOneAndUpdate: mockUpdate },
  findActiveReplyCompose: jest.fn(async () => null), findAnyActiveManualDraft: jest.fn(async () => null),
  findStaffNameEdit: jest.fn(async () => null), findResolutionIntent: jest.fn(async () => null),
  clearReplyPrompt: mockClear, setPendingTicketAction: jest.fn(), consumePendingTicketAction: mockConsume,
}));
jest.mock('../src/ai-engineer-store', () => ({ EngineerStore: jest.fn(() => ({
  read: mockRead, repair: mockRepair, submit: mockSubmit, rework: mockRework, handoff: mockHandoff, cancel: mockCancel,
})), readEngineerRevision: mockReadRevision }));
jest.mock('../src/ai-engineer-bridge', () => ({ engineerPolicy: () => mockPolicy }));
jest.mock('../src/ai-engineer-readiness', () => ({ engineerReady: () => mockReady }));
jest.mock('../src/ai-engineer-catalog', () => ({ requireCatalogBinding: mockBinding, readCatalog: jest.fn() }));
jest.mock('../src/middleware', () => ({ reply: mockReply }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: jest.fn() }));
import * as ai from '../src/ai-engineer';
import { handleEngineerCallback, handleEngineerText, EngineerDraft, engineerStatus, engineerCanStart } from '../src/ai-engineer-ui';

describe('staff-only AI engineer task flow', () => {
  const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
  let ticket: any, ctx: any, draft: EngineerDraft;
  beforeEach(() => {
    jest.clearAllMocks(); mockReady = true;
    mockPolicy = { enabled: true, scope: 'most-support-vm3902', staff: [{ telegram_id: '1', role: 'agent' }, { telegram_id: '2', role: 'agent' }] };
    draft = { token: '0123456789abcdef', version: 1, compose_version: 3, mode: 'new', step: 'input', goal: '',
      options: [binding], selected: null, owner: '1', epoch: 0, fingerprint: ai.policyFingerprint(mockPolicy),
      base_request: null, task_id: '00000000-0000-4000-8000-000000000001',
      request_id: '00000000-0000-4000-8000-000000000002', operation_id: '00000000-0000-4000-8000-000000000003' };
    ticket = { ticketId: 42, status: 'open', assigned_to: '1', ai_epoch: 0, ai_engineer: null, ai_engineer_draft: draft,
      pending_reply_staff_id: '1', pending_reply_kind: 'note', pending_reply_chat_id: '-100', pending_reply_thread_id: 5,
      pending_reply_version: 3, pending_reply_prompt_id: 7, pending_reply_expires_at: new Date(Date.now() + 60000),
      staff_card_chat_id: '-100', staff_card_thread_id: 5, staff_card_message_id: 8 };
    ctx = { session: { admin: true }, from: { id: 1 }, chat: { id: -100 }, messenger: 'telegram',
      message: { text: 'Проверить доступность', message_thread_id: 5 },
      callbackQuery: { message: { chat: { id: -100 }, message_id: 8, message_thread_id: 5 } }, answerCbQuery: jest.fn() };
    mockFind.mockImplementation(() => ({ lean: async () => ticket }));
    mockRead.mockImplementation(async () => ticket); mockUpdate.mockResolvedValue(ticket);
    mockReply.mockResolvedValue(undefined); mockBinding.mockResolvedValue(binding);
    mockConsume.mockResolvedValue(ticket); mockClear.mockResolvedValue(ticket);
  });
  it('consumes AI input before generic routing and persists sanitized text only', async () => {
    ctx.message.text = 'Сбой mongodb://user:secret@host/db password=private';
    expect(await handleEngineerText(ctx)).toBe(true);
    const next = mockUpdate.mock.calls[0][1].$set.ai_engineer_draft;
    expect(next.goal).not.toMatch(/secret|private|user/); expect(next.step).toBe('binding');
    expect(mockFind.mock.calls[0][0].pending_reply_kind).toBe('note');
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'owner', 'epoch', 'expired', 'policy', 'not_ready'])('rejects %s input without falling through to a client reply', async reason => {
    if (reason === 'disabled') mockPolicy.enabled = false;
    if (reason === 'owner') ticket.assigned_to = '2';
    if (reason === 'epoch') ticket.ai_epoch = 2;
    if (reason === 'expired') ticket.pending_reply_expires_at = new Date(0);
    if (reason === 'policy') draft.fingerprint = 'old';
    if (reason === 'not_ready') mockReady = false;
    expect(await handleEngineerText(ctx)).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled(); expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalled();
    expect(mockClear).toHaveBeenCalledWith(42, '1', 3);
  });
  it('ignores an unrelated explicit Telegram reply', async () => {
    ctx.message.reply_to_message = { message_id: 100 };
    mockFind.mockImplementation(query => ({ lean: async () => query.pending_reply_prompt_id === 7 ? ticket : null }));
    expect(await handleEngineerText(ctx)).toBe(false); expect(mockUpdate).not.toHaveBeenCalled();
  });
  it('permits cancelling own form after the feature is disabled without admitting work', async () => {
    mockPolicy.enabled = false; mockReady = false;
    await handleEngineerCallback(ctx, ['ae', 'abort', '42', draft.token, '1']);
    expect(mockClear).toHaveBeenCalledWith(42, '1', 3); expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('keeps a valid input form when only the text length is invalid', async () => {
    ctx.message.text = 'x'.repeat(1001);
    expect(await handleEngineerText(ctx)).toBe(true); expect(mockClear).not.toHaveBeenCalled();
  });
  it('losing concurrent input cannot show an unpersisted preview', async () => {
    mockUpdate.mockResolvedValue(null);
    expect(await handleEngineerText(ctx)).toBe(true);
    expect(mockReply.mock.calls[0][1]).toMatch(/не принят/);
  });
  it('confirms only the persisted binding and explicit task with a final admission fence', async () => {
    Object.assign(draft, { step: 'preview', selected: binding, goal: 'Проверить хост' });
    await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    expect(mockBinding).toHaveBeenCalledWith(mockPolicy.scope, binding);
    expect(mockSubmit).toHaveBeenCalledWith(42, '1', binding, { goal: draft.goal, history: '', feedback: '' },
      { task_id: draft.task_id, request_id: draft.request_id }, expect.objectContaining({ owner: '1', epoch: 0, base_request: null,
        draft: { token: draft.token, version: 1, compose_version: 3, actor: '1', chat: '-100', thread: 5 } }));
    expect(mockClear).toHaveBeenCalledWith(42, '1', 3);
  });
  it('does not confirm a revoked binding', async () => {
    Object.assign(draft, { step: 'preview', selected: binding, goal: 'Проверить' });
    mockBinding.mockRejectedValue(new ai.EngineerError('binding_unavailable'));
    await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    expect(mockSubmit).not.toHaveBeenCalled(); expect(mockClear).not.toHaveBeenCalled();
  });
  it('saves rework through a stable operation identity and never submits a parallel task', async () => {
    const job = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('Проверить'), Date.now());
    job.state = 'awaiting_operator'; job.projection_pending = null; ticket.ai_engineer = job;
    Object.assign(draft, { mode: 'rework', step: 'preview', selected: binding, goal: 'Уточнить вывод', base_request: job.request_id });
    await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    expect(mockRework).toHaveBeenCalledWith(42, job.request_id, '1', draft.operation_id, draft.goal,
      expect.objectContaining({ owner: '1', epoch: 0, base_request: job.request_id,
        draft: { token: draft.token, version: 1, compose_version: 3, actor: '1', chat: '-100', thread: 5 } }));
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('rejects another actor, surface and stale confirmation version', async () => {
    Object.assign(draft, { step: 'preview', selected: binding, goal: 'Проверить' });
    ctx.from.id = 2; await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    ctx.from.id = 1; ctx.chat.id = -200; await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    ctx.chat.id = -100; await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '0']);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('requires actor-bound one-shot intent before accepting a conclusion', async () => {
    const job = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('Проверить'), Date.now());
    job.state = 'awaiting_operator'; ticket.ai_engineer = job; mockConsume.mockResolvedValue(null);
    await handleEngineerCallback(ctx, ['ae', 'handoff', '42', 'obsolete']);
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockConsume).toHaveBeenCalledWith(42, `ae:${job.request_id}`, 'obsolete', '1');
  });
  it('shows an unavailable standard conclusion with retry only when rework is actually offered', async () => {
    const job = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('Проверить'), Date.now());
    job.state = 'failed'; job.failure_code = 'model_unavailable'; job.projection_pending = null;
    ticket.ai_engineer = job;
    await handleEngineerCallback(ctx, ['ae', 'view', '42']);
    const text = String(mockReply.mock.calls[0][1]);
    const markup = JSON.stringify(mockReply.mock.calls[0][2].reply_markup);
    expect(text).toContain('Можно повторить диагностику или продолжить вручную.');
    expect(markup).toContain('ae:rework:');
  });
  it('renders the stored conclusion as a staff draft with escaping', async () => {
    const job = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('Проверить <host>'), Date.now());
    job.state = 'awaiting_operator'; job.projection_pending = null;
    job.conclusion = { summary: 'Доступен <host>', verified_findings: [{ text: 'Факт & проверен', evidence_refs: ['check-1'] }],
      hypotheses: [], unknowns: [], recommended_next_steps: ['Проверить вручную'],
      customer_reply_draft: 'Черновик <ответа>' };
    ticket.ai_engineer = job;
    await handleEngineerCallback(ctx, ['ae', 'view', '42']);
    const text = String(mockReply.mock.calls[0][1]);
    expect(text).toContain('Доступен &lt;host&gt;');
    expect(text).toContain('Факт &amp; проверен');
    expect(text).toContain('Черновик ответа — клиенту не отправлен');
    expect(text).toContain('Черновик &lt;ответа&gt;');
  });
  it('opens a stored previous revision through the existing history entrypoint', async () => {
    const current = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('Текущая'), Date.now());
    current.revision = 2; current.state = 'awaiting_operator'; current.projection_pending = null;
    const previous = { ...current, revision: 1, input: ai.snapshotInput('Предыдущая редакция') };
    ticket.ai_engineer = current; mockReadRevision.mockResolvedValue(previous);
    await handleEngineerCallback(ctx, ['ae', 'section', '42', '1', '0']);
    expect(mockReadRevision).toHaveBeenCalledWith(current.scope, 42, current.task_id, 1);
    expect(String(mockReply.mock.calls[0][1])).toContain('Редакция 1 · Задание');
    expect(String(mockReply.mock.calls[0][1])).toContain('Предыдущая редакция');
  });
  it('shows bounded failure reasons and retry text only when rework exists', () => {
    const job = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('x'), Date.now());
    job.revision = 2;
    for (const [code, fragment] of Object.entries({
      request_expired: 'Срок задания истёк', facts_stale: 'Данные диагностики устарели',
      attempts_exhausted: 'Попытки исчерпаны', checks_denied: 'Диагностика отклонена', checks_failed: 'Диагностика не удалась',
      model_unavailable: 'Модель недоступна', model_output_invalid: 'Ответ модели не принят',
    })) {
      job.state = 'failed'; job.failure_code = code as ai.EngineerTask['failure_code'];
      expect(engineerStatus({ ...ticket, ai_engineer: job })).toContain(fragment);
      expect(engineerStatus({ ...ticket, ai_engineer: job })).toContain('можно повторить');
    }
    const base = mockPolicy;
    const fixture = require('./fixtures/support-engineer-canary-admission-v1.json');
    const admission = { ...fixture.config.ai_engineer_canary_admission,
      ticket_id: ticket.ticketId, expected_owner: '1', ticket_epoch: 0, requested_by: '1',
      base_policy_digest: ai.basePolicyDigest(base), issued_at: Date.now() - 1000, expires_at: Date.now() + 60000 };
    mockPolicy = { ...base, canary: ai.parseCanaryPolicy('canary', admission, base) };
    const canaryJob = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('x'), Date.now(),
      { task_id: job.task_id, request_id: admission.request_id });
    canaryJob.state = 'failed'; canaryJob.failure_code = 'model_unavailable';
    expect(engineerStatus({ ...ticket, ai_engineer: canaryJob })).toContain('можно продолжить вручную');
    expect(engineerStatus({ ...ticket, ai_engineer: canaryJob })).not.toContain('можно повторить');
    mockPolicy = base;
    job.failure_code = 'model_unavailable';
    mockPolicy = { enabled: true, scope: 'most-support-vm3902', staff: mockPolicy.staff };
    job.failure_code = 'unknown_code' as any;
    expect(engineerStatus({ ...ticket, ai_engineer: job })).toContain('Диагностика не завершена');
    job.state = 'cancelled'; job.failure_code = null;
    expect(engineerStatus({ ...ticket, ai_engineer: job })).toContain('Задание отменено');
    job.state = 'stale';
    expect(engineerStatus({ ...ticket, ai_engineer: job })).toContain('Задание устарело');
  });
  it('answers canary and readiness callbacks in Russian without raw codes or secrets', async () => {
    const { readCatalog } = jest.requireMock('../src/ai-engineer-catalog');
    readCatalog.mockResolvedValue({ entries: [binding] });
    mockPolicy = { ...mockPolicy, canary: { admission: null, error: 'canary_expired' } };
    await handleEngineerCallback(ctx, ['ae', 'start', '42']);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Окно проверки завершено.', true);
    mockReady = false;
    mockPolicy = { enabled: true, scope: 'most-support-vm3902', staff: mockPolicy.staff };
    await handleEngineerCallback(ctx, ['ae', 'start', '42']);
    const hint = String(ctx.answerCbQuery.mock.calls.at(-1)[0]);
    expect(hint).toContain('не готов');
    expect(hint).not.toMatch(/canary|sk-secret|123456:ABCDEF/);
    mockReady = true;
    Object.assign(draft, { step: 'preview', selected: binding, goal: 'Проверить' });
    mockBinding.mockRejectedValue(new ai.EngineerError('catalog_unavailable'));
    await handleEngineerCallback(ctx, ['ae', 'confirm', '42', draft.token, '1']);
    expect(String(ctx.answerCbQuery.mock.calls.at(-1)[0])).toContain('Каталог');
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it.each([
    ['compose_exists', 'Сначала завершите или отмените текущий ввод.'],
    ['catalog_unavailable', 'Каталог АИНОК недоступен. Повторите позже.'],
    ['binding_unavailable', 'Каталог АИНОК недоступен. Повторите позже.'],
    ['canary_not_started', 'Окно проверки ещё не открыто.'],
    ['canary_expired', 'Окно проверки завершено.'],
    ['canary_admission_missing', 'Пробный режим не настроен.'],
    ['canary_admission_invalid', 'Неверные параметры пробного режима.'],
    ['canary_policy_mismatch', 'Политика пробного режима не совпадает с конфигурацией.'],
    ['canary_not_admitted', 'Эта заявка не входит в пробный режим.'],
    ['canary_rework_denied', 'Доработка в пробном режиме недоступна.'],
    ['not_ready', 'ИИ-инженер ещё не готов. Повторите через минуту.'],
    ['task_exists', 'Задание уже передано.'],
    ['unknown_secret_code', 'Действие недоступно или устарело. Откройте актуальную карточку и повторите.'],
  ])('maps callback failure %s to bounded Russian text', async (code, text) => {
    const { readCatalog } = jest.requireMock('../src/ai-engineer-catalog');
    readCatalog.mockRejectedValueOnce(new ai.EngineerError(code));
    await handleEngineerCallback(ctx, ['ae', 'start', '42']);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(text, true);
    expect(text).not.toMatch(/canary|unknown_secret_code|sk-secret|123456:ABCDEF/);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it('keeps standard start available after a real cancellation', () => {
    const created = ai.createTask(ticket, mockPolicy, '1', binding, ai.snapshotInput('x'), Date.now());
    const ready = ai.acknowledge(created, created.projection_pending!.id);
    const cancelled = ai.cancel(ready, '1', Date.now());
    ticket.ai_engineer = ai.acknowledge(cancelled, cancelled.projection_pending!.id);
    expect(engineerCanStart(ticket)).toBe(true);
  });
  it('cannot start from a copied or obsolete ticket card', async () => {
    ctx.callbackQuery.message.message_id = 9;
    await handleEngineerCallback(ctx, ['ae', 'start', '42']);
    expect(mockRepair).not.toHaveBeenCalled(); expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.any(String), true);
  });
});
