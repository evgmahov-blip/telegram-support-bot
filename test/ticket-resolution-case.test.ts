const answer = jest.fn().mockResolvedValue(undefined);
const refresh = jest.fn().mockResolvedValue(undefined);
const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn().mockResolvedValue('5');
const cb = jest.fn().mockResolvedValue(undefined);
const closeLifecycle = jest.fn();
const ticket: any = { ticketId: 7, status: 'closed', assigned_to: '42', common_visible: true };
const intent: any = { token: 'tok', actor_id: '42', chat_id: '-100', thread_id: 9, ticketId: 7,
  status: 'input', step: 'cause', version: 3, base_version: 0, cause: null, actions: null, check: null };

jest.mock('../src/cache', () => ({ config: { staffchat_id: '-100', staffchat_thread_id: 9 } }));
jest.mock('../src/team', () => ({
  canPerformAction: jest.fn((id: string) => id === '42'),
  canManageTicket: jest.fn((id: string, owner: string) => id === owner),
  getStaffRole: jest.fn(() => 'agent'),
}));
jest.mock('../src/middleware', () => ({ reply: (...a: any[]) => reply(...a), sendMessage: (...a: any[]) => send(...a) }));
jest.mock('../src/ticket-state', () => ({ closeTicketLifecycle: (...a: any[]) => closeLifecycle(...a) }));
jest.mock('../src/ticket-ui', () => ({
  STAFF_HOME: { text: '🏠 Главная', callback_data: 'tm:home:0' },
  e: (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  answer: (...a: any[]) => answer(...a), refreshStaffCard: (...a: any[]) => refresh(...a),
  answerForTicket: (c: any, _t: any, text: string, rows: any) => answer(c, text, rows),
  isStaffPrivate: (c: any) => c.chat?.type === 'private',
}));
jest.mock('../src/db', () => ({
  getTicketById: jest.fn().mockResolvedValue(ticket), getTicketResolution: jest.fn(),
  findActiveReplyCompose: jest.fn().mockResolvedValue(null), findAnyActiveManualDraft: jest.fn().mockResolvedValue(null),
  findStaffNameEdit: jest.fn().mockResolvedValue(null), findResolutionIntent: jest.fn(), getResolutionIntent: jest.fn(),
  startResolutionIntent: jest.fn(), transitionResolutionIntent: jest.fn(), consumeResolutionInput: jest.fn(),
  cancelResolutionIntent: jest.fn(), claimResolutionSave: jest.fn(), saveClaimedResolution: jest.fn(),
  abandonClaimedResolution: jest.fn(), completeResolutionIntent: jest.fn(),
  recordAnalyticsEventBestEffort: jest.fn(),
}));

import * as flow from '../src/ticket-resolution-case';
const db: any = jest.requireMock('../src/db');
const team: any = jest.requireMock('../src/team');
const ctx = (data = '', text?: string, actor = 42): any => ({ from: { id: actor }, chat: { id: -100 }, session: { admin: true },
  callbackQuery: { data, message: { chat: { id: -100 }, message_id: 55, message_thread_id: 9 } },
  message: text ? { text, message_id: 901, message_thread_id: 9 } : undefined, answerCbQuery: cb });
const dm = (data = '', text?: string, actor = 42): any => ({ from: { id: actor }, chat: { id: actor, type: 'private' }, session: { admin: false },
  messenger: 'telegram',
  callbackQuery: text ? undefined : { data, message: { chat: { id: actor }, message_id: 70 } },
  message: text ? { text, message_id: 902 } : undefined, answerCbQuery: cb });

describe('human-recorded ticket resolution flow', () => {
  beforeEach(() => { jest.clearAllMocks(); db.getTicketById.mockResolvedValue(ticket); team.canPerformAction.mockReturnValue(true);
    team.canManageTicket.mockReturnValue(true); });

  it('isolates ordinary text by actor/chat/topic and consumes it with version/message fences', async () => {
    db.findResolutionIntent.mockResolvedValue(intent);
    db.consumeResolutionInput.mockResolvedValue({ ...intent, version: 4, step: 'actions', cause: 'Сбой <БД>' });
    await expect(flow.handleTextInput(ctx('', '  Сбой <БД>  '))).resolves.toBe(true);
    expect(db.consumeResolutionInput).toHaveBeenCalledWith('tok', '42', '-100', 9, 3, 'cause', 901, 'Сбой <БД>', 'actions', expect.any(Date));
    expect(answer.mock.calls.at(-1)[1]).toContain('Что сделали');
  });

  it('rejects stale/foreign callbacks before any write', async () => {
    db.getResolutionIntent.mockResolvedValue(intent);
    await flow.handleCallback(ctx('rs:cancel:tok:2'), ['rs','cancel','tok','2']);
    expect(db.cancelResolutionIntent).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('Кнопка устарела или принадлежит другому сотруднику.', true);
  });

  it('cancels without saving when the ticket was reopened mid-flow', async () => {
    db.getResolutionIntent.mockResolvedValue({ ...intent, status: 'preview' }); db.getTicketById.mockResolvedValue({ ...ticket, status: 'open' });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.cancelResolutionIntent).toHaveBeenCalledWith('42', '-100', 9, 3);
    expect(db.claimResolutionSave).not.toHaveBeenCalled();
  });

  it('freshly checks ACL at save and audits one human case without client delivery', async () => {
    const preview = { ...intent, status: 'preview', cause: 'Причина', actions: 'Действия', check: 'Проверка' };
    db.getResolutionIntent.mockResolvedValue(preview); db.claimResolutionSave.mockResolvedValue(preview);
    db.saveClaimedResolution.mockResolvedValue({ current_version: 1, versions: [preview] });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.saveClaimedResolution).toHaveBeenCalledTimes(1);
    expect(db.recordAnalyticsEventBestEffort).toHaveBeenCalledWith('ticket.resolution_saved', 7, '42', { version: 1 });
    expect(refresh).toHaveBeenCalledWith(7); expect(reply).not.toHaveBeenCalled();
    expect(answer.mock.calls.at(-1)[1]).toContain('не стало автоматически одобренным навыком');
  });

  it('abandons an atomic save claim if the ticket reopens between preview and persistence', async () => {
    const preview = { ...intent, status: 'preview', cause: 'Причина', actions: 'Действия', check: 'Проверка' };
    db.getResolutionIntent.mockResolvedValue(preview); db.claimResolutionSave.mockResolvedValue(preview);
    db.getTicketById.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ ...ticket, status: 'open' });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.abandonClaimedResolution).toHaveBeenCalledWith('tok', '42', 3);
    expect(db.saveClaimedResolution).not.toHaveBeenCalled();
  });

  it('renders bounded stored fields escaped with author/time and exposes Home', async () => {
    db.getTicketResolution.mockResolvedValue({ versions: [{ version: 2, cause: '<script>', actions: 'Исправили', check: 'Тест', saved_at: new Date(), closure: true, author_id: '42' }] });
    await flow.view(ctx('rs:view:7'), 7);
    const [rendered, rows] = [answer.mock.calls.at(-1)[1], answer.mock.calls.at(-1)[2]];
    expect(rendered).toContain('&lt;script&gt;'); expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('записано при закрытии'); expect(rendered).toContain('Автор:'); expect(rendered).toContain('Записано:');
    expect(rows.flat()).toContainEqual({ text: '🏠 Главная', callback_data: 'tm:home:0' });
  });

  it('keeps an existing closed case readable after the ticket is reopened', async () => {
    db.getTicketById.mockResolvedValue({ ...ticket, status: 'open' });
    db.getTicketResolution.mockResolvedValue({ versions: [{ version: 1, cause: 'Причина', actions: 'Работы', check: '', saved_at: new Date(), author_id: '42' }] });
    await flow.view(ctx('rs:view:7'), 7);
    expect(answer.mock.calls.at(-1)[1]).toContain('Работы');
    expect(JSON.stringify(answer.mock.calls.at(-1)[2])).not.toContain('rs:start:7');
  });
});

describe('required closure explanation (close mode)', () => {
  const open: any = { ticketId: 7, status: 'open', assigned_to: '42', common_visible: true, userid: 'client', messenger: 'telegram' };
  const closeIntent: any = { ...intent, mode: 'close', expected_owner: '42' };
  const ready: any = { ...closeIntent, status: 'preview', step: null, cause: 'Истёк сертификат', actions: 'Перевыпустили сертификат', check: '' };
  beforeEach(() => { jest.clearAllMocks(); db.getTicketById.mockResolvedValue(open); team.canPerformAction.mockReturnValue(true);
    team.canManageTicket.mockReturnValue(true); send.mockResolvedValue('5'); });

  it('starts a common ticket closure in place with the explicit «unknown cause» choice', async () => {
    const common = { ...open, assigned_to: null };
    db.getTicketById.mockResolvedValue(common);
    db.startResolutionIntent.mockResolvedValue({ ...closeIntent, expected_owner: null });
    await flow.startClose(ctx('tc:closeask:7'), common);
    expect(db.startResolutionIntent).toHaveBeenCalledWith(expect.any(String), '42', '-100', 9, 7, expect.any(Date), 'close', null, undefined);
    expect(answer.mock.calls.at(-1)[1]).toContain('Закрытие заявки № 7');
    expect(JSON.stringify(answer.mock.calls.at(-1)[2])).toContain('rs:unknown:tok:3');
    expect(send).not.toHaveBeenCalled(); expect(closeLifecycle).not.toHaveBeenCalled();
  });

  it('collects a personal ticket explanation only in the actor DM', async () => {
    db.startResolutionIntent.mockResolvedValue({ ...closeIntent, chat_id: '42', thread_id: null });
    await flow.startClose(ctx('tc:closeask:7'), { ...open, common_visible: false });
    expect(db.startResolutionIntent).toHaveBeenCalledWith(expect.any(String), '42', '42', null, 7, expect.any(Date), 'close', '42', undefined);
    expect(send).toHaveBeenCalledWith('42', 'telegram', expect.stringContaining('Закрытие заявки № 7'), expect.anything());
    expect(answer).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('Заполните причину и выполненные работы в личном чате с ботом.', false);
  });

  it('cancels the intent and never falls back to the shared chat when the DM is blocked', async () => {
    db.startResolutionIntent.mockResolvedValue({ ...closeIntent, chat_id: '42', thread_id: null });
    send.mockRejectedValueOnce({ description: 'Forbidden: bot was blocked by the user' });
    await flow.startClose(ctx('tc:closeask:7'), { ...open, common_visible: false });
    expect(db.cancelResolutionIntent).toHaveBeenCalledWith('42', '42', null, 3);
    expect(answer).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.stringContaining('/start'), true);
  });

  it('refuses to start for a non-owner agent or an already closed ticket', async () => {
    team.canManageTicket.mockReturnValue(false);
    await flow.startClose(ctx('tc:closeask:7'), open);
    team.canManageTicket.mockReturnValue(true);
    await flow.startClose(ctx('tc:closeask:7'), { ...open, status: 'closed' });
    expect(db.startResolutionIntent).not.toHaveBeenCalled();
  });

  it('records «не установлена» only when the engineer explicitly chooses it', async () => {
    db.getResolutionIntent.mockResolvedValue(closeIntent);
    db.transitionResolutionIntent.mockResolvedValue({ ...closeIntent, version: 4, step: 'actions', cause: flow.UNKNOWN_CAUSE });
    await flow.handleCallback(ctx('rs:unknown:tok:3'), ['rs','unknown','tok','3']);
    expect(db.transitionResolutionIntent).toHaveBeenCalledWith('tok', '42', '-100', 9, 3, { status: 'input', step: 'cause' },
      { cause: 'не установлена', status: 'input', step: 'actions' }, expect.any(Date));
    expect(answer.mock.calls.at(-1)[1]).toContain('Что сделали');
  });

  it('lets the optional check be skipped straight to the preview', async () => {
    db.getResolutionIntent.mockResolvedValue({ ...closeIntent, step: 'check', cause: 'Причина', actions: 'Работы' });
    db.transitionResolutionIntent.mockResolvedValue({ ...ready, version: 4 });
    await flow.handleCallback(ctx('rs:skip:tok:3'), ['rs','skip','tok','3']);
    expect(db.transitionResolutionIntent).toHaveBeenCalledWith('tok', '42', '-100', 9, 3, { status: 'input', step: 'check' },
      { check: '', status: 'preview', step: null, edit_return: false }, expect.any(Date));
    const preview = answer.mock.calls.at(-1)[1];
    expect(preview).toContain('Проверьте закрытие'); expect(preview).toContain('Автор:'); expect(preview).toContain('не указано');
    expect(JSON.stringify(answer.mock.calls.at(-1)[2])).toContain('rs:save:tok:4');
  });

  it('rejects an empty cause or performed-work text without consuming it', async () => {
    db.findResolutionIntent.mockResolvedValue(closeIntent);
    await flow.handleTextInput(ctx('', '   \u0007  '));
    db.findResolutionIntent.mockResolvedValue({ ...closeIntent, step: 'actions', cause: 'Причина' });
    await flow.handleTextInput(ctx('', '  '));
    expect(db.consumeResolutionInput).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('«Причина» должно содержать'));
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('«Что сделали» должно содержать'));
  });

  it('accepts the explanation typed in the engineer DM', async () => {
    db.findResolutionIntent.mockResolvedValue({ ...closeIntent, chat_id: '42', thread_id: null });
    db.consumeResolutionInput.mockResolvedValue({ ...closeIntent, chat_id: '42', thread_id: null, version: 4, step: 'actions', cause: 'Причина' });
    await expect(flow.handleTextInput(dm('', 'Причина'))).resolves.toBe(true);
    expect(db.findResolutionIntent).toHaveBeenCalledWith('42', '42', null);
    expect(db.consumeResolutionInput).toHaveBeenCalledWith('tok', '42', '42', null, 3, 'cause', 902, 'Причина', 'actions', expect.any(Date));
  });

  it('saves the explanation first and binds it to the same owner-guarded closure', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(ready);
    db.saveClaimedResolution.mockResolvedValue({ current_version: 3, versions: [{ version: 3, intent_token: 'tok' }] });
    closeLifecycle.mockResolvedValue({ outcome: 'closed', ticket: { ...open, status: 'closed' } });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.saveClaimedResolution.mock.invocationCallOrder[0]).toBeLessThan(closeLifecycle.mock.invocationCallOrder[0]);
    expect(closeLifecycle).toHaveBeenCalledWith(open, '42', '42', { resolutionVersion: 3, metadata: { resolution_version: 3 } });
    expect(db.completeResolutionIntent).toHaveBeenCalledWith('tok');
    expect(db.recordAnalyticsEventBestEffort).toHaveBeenCalledWith('ticket.resolution_saved', 7, '42', { version: 3, closure: true });
    expect(answer.mock.calls.at(-1)[1]).toContain('Заявка № 7 закрыта');
    // Internal cause/actions are never sent to the client by this flow.
    expect(send).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
    expect(JSON.stringify(closeLifecycle.mock.calls[0][3])).not.toContain('сертификат');
  });

  it('leaves the ticket open and the claim retryable when persistence fails', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(ready);
    db.saveClaimedResolution.mockRejectedValue(new Error('mongo down'));
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(closeLifecycle).not.toHaveBeenCalled();
    expect(db.abandonClaimedResolution).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.stringContaining('заявка осталась открытой'), true);
  });

  it('refuses to save or close after an ownership change', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(ready);
    db.getTicketById.mockResolvedValueOnce(open).mockResolvedValueOnce({ ...open, assigned_to: '99' });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.abandonClaimedResolution).toHaveBeenCalledWith('tok', '42', 3);
    expect(db.saveClaimedResolution).not.toHaveBeenCalled(); expect(closeLifecycle).not.toHaveBeenCalled();
  });

  it('cancels the flow when the owner changed before the confirmation', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.getTicketById.mockResolvedValue({ ...open, assigned_to: null });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.cancelResolutionIntent).toHaveBeenCalledWith('42', '-100', 9, 3);
    expect(db.claimResolutionSave).not.toHaveBeenCalled(); expect(closeLifecycle).not.toHaveBeenCalled();
  });

  it('cannot replay a spent confirmation', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(null);
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.saveClaimedResolution).not.toHaveBeenCalled(); expect(closeLifecycle).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('Подтверждение устарело.', true);
  });

  it('does not overwrite another engineer\'s newer explanation', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(ready);
    db.saveClaimedResolution.mockResolvedValue(null);
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(closeLifecycle).not.toHaveBeenCalled();
    expect(db.abandonClaimedResolution).toHaveBeenCalledWith('tok', '42', 3);
  });

  it('abandons the intent when the CAS closure loses a race', async () => {
    db.getResolutionIntent.mockResolvedValue(ready); db.claimResolutionSave.mockResolvedValue(ready);
    db.saveClaimedResolution.mockResolvedValue({ current_version: 1, versions: [{ version: 1, intent_token: 'tok' }] });
    closeLifecycle.mockResolvedValue({ outcome: 'stale', ticket: { ...open, assigned_to: '99' } });
    await flow.handleCallback(ctx('rs:save:tok:3'), ['rs','save','tok','3']);
    expect(db.completeResolutionIntent).not.toHaveBeenCalled();
    expect(db.abandonClaimedResolution).toHaveBeenCalledWith('tok', '42', 3);
    expect(cb).toHaveBeenCalledWith('Владелец или состояние изменились: заявка не закрыта.', true);
  });

  it('cancel keeps the ticket open', async () => {
    db.getResolutionIntent.mockResolvedValue(closeIntent); db.cancelResolutionIntent.mockResolvedValue({});
    await flow.handleCallback(ctx('rs:cancel:tok:3'), ['rs','cancel','tok','3']);
    expect(answer.mock.calls.at(-1)[1]).toContain('осталась открытой');
    expect(closeLifecycle).not.toHaveBeenCalled();
  });
});
