const answer = jest.fn().mockResolvedValue(undefined);
const refresh = jest.fn().mockResolvedValue(undefined);
const reply = jest.fn().mockResolvedValue(undefined);
const cb = jest.fn().mockResolvedValue(undefined);
const ticket: any = { ticketId: 7, status: 'closed', assigned_to: '42' };
const intent: any = { token: 'tok', actor_id: '42', chat_id: '-100', thread_id: 9, ticketId: 7,
  status: 'input', step: 'cause', version: 3, base_version: 0, cause: null, actions: null, check: null };

jest.mock('../src/cache', () => ({ config: { staffchat_id: '-100', staffchat_thread_id: 9 } }));
jest.mock('../src/team', () => ({
  canPerformAction: jest.fn((id: string) => id === '42'),
  canManageTicket: jest.fn((id: string, owner: string) => id === owner),
}));
jest.mock('../src/middleware', () => ({ reply: (...a: any[]) => reply(...a) }));
jest.mock('../src/ticket-ui', () => ({
  STAFF_HOME: { text: '🏠 Главная', callback_data: 'tm:home:0' },
  e: (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  answer: (...a: any[]) => answer(...a), refreshStaffCard: (...a: any[]) => refresh(...a),
}));
jest.mock('../src/db', () => ({
  getTicketById: jest.fn().mockResolvedValue(ticket), getTicketResolution: jest.fn(),
  findActiveReplyCompose: jest.fn().mockResolvedValue(null), findAnyActiveManualDraft: jest.fn().mockResolvedValue(null),
  findStaffNameEdit: jest.fn().mockResolvedValue(null), findResolutionIntent: jest.fn(), getResolutionIntent: jest.fn(),
  startResolutionIntent: jest.fn(), transitionResolutionIntent: jest.fn(), consumeResolutionInput: jest.fn(),
  cancelResolutionIntent: jest.fn(), claimResolutionSave: jest.fn(), saveClaimedResolution: jest.fn(),
  abandonClaimedResolution: jest.fn(),
  recordAnalyticsEventBestEffort: jest.fn(),
}));

import * as flow from '../src/ticket-resolution-case';
const db: any = jest.requireMock('../src/db');
const team: any = jest.requireMock('../src/team');
const ctx = (data = '', text?: string, actor = 42): any => ({ from: { id: actor }, chat: { id: -100 }, session: { admin: true },
  callbackQuery: { data, message: { chat: { id: -100 }, message_id: 55, message_thread_id: 9 } },
  message: text ? { text, message_id: 901, message_thread_id: 9 } : undefined, answerCbQuery: cb });

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

  it('renders bounded stored fields escaped and exposes Home', async () => {
    db.getTicketResolution.mockResolvedValue({ versions: [{ version: 2, cause: '<script>', actions: 'Исправили', check: 'Тест', saved_at: new Date() }] });
    await flow.view(ctx('rs:view:7'), 7);
    const [rendered, rows] = [answer.mock.calls.at(-1)[1], answer.mock.calls.at(-1)[2]];
    expect(rendered).toContain('&lt;script&gt;'); expect(rendered).not.toContain('<script>');
    expect(rows.flat()).toContainEqual({ text: '🏠 Главная', callback_data: 'tm:home:0' });
  });
});
