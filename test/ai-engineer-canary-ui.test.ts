const mockRead = jest.fn(), mockRepair = jest.fn(), mockSubmit = jest.fn(), mockRework = jest.fn();
const mockReply = jest.fn(), mockSend = jest.fn(), mockSetPrompt = jest.fn(), mockClear = jest.fn();
const mockCatalog = jest.fn(), mockBinding = jest.fn(), mockPending = jest.fn();
let mockPolicy: any;
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_thread_id: 5, staffchat_type: 'telegram', ai_engineer_enabled: true,
} } }));
jest.mock('../src/db', () => ({
  Supportee: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
  findActiveReplyCompose: jest.fn(async () => null), findAnyActiveManualDraft: jest.fn(async () => null),
  findStaffNameEdit: jest.fn(async () => null), findResolutionIntent: jest.fn(async () => null),
  setReplyPrompt: mockSetPrompt, clearReplyPrompt: mockClear, setPendingTicketAction: mockPending,
  consumePendingTicketAction: jest.fn(),
}));
jest.mock('../src/ai-engineer-store', () => ({ EngineerStore: jest.fn(() => ({
  read: mockRead, repair: mockRepair, submit: mockSubmit, rework: mockRework,
})), readEngineerRevision: jest.fn() }));
jest.mock('../src/ai-engineer-bridge', () => ({ engineerPolicy: () => mockPolicy }));
jest.mock('../src/ai-engineer-readiness', () => ({ engineerReady: () => true }));
jest.mock('../src/ai-engineer-catalog', () => ({ requireCatalogBinding: mockBinding, readCatalog: mockCatalog }));
jest.mock('../src/middleware', () => ({ reply: mockReply, sendMessage: mockSend }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: jest.fn() }));
import * as ai from '../src/ai-engineer';
import { handleEngineerCallback, engineerOffered, EngineerDraft } from '../src/ai-engineer-ui';

// Mocked staff UI: proves the existing start/confirm path carries the pre-selected UUID. Not a live E2E.
describe('canary through the existing staff start/confirm path', () => {
  const REQUEST = '40000000-0000-4000-8000-000000000004';
  const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
  const other: ai.Binding = { binding_id: 'customer-host', binding_version: 1, display_label: 'Customer', profile_id: ai.PROFILE };
  const base: ai.EngineerPolicy = { enabled: true, scope: 'most-support-vm3902',
    staff: [{ telegram_id: '1', role: 'admin' }, { telegram_id: '2', role: 'agent' }] };
  let ticket: any, ctx: any;
  const admit = (patch: Record<string, unknown> = {}) => {
    const issued = Date.now() - 1000;
    mockPolicy = { ...base, canary: ai.parseCanaryPolicy('canary', { schema: ai.CANARY_SCHEMA, deployment_scope: base.scope,
      ticket_id: 4242, request_id: REQUEST, revision: 1, expected_owner: '2', ticket_epoch: 3, requested_by: '2',
      binding_id: 'canary', binding_version: 1, profile_id: ai.PROFILE, base_policy_digest: ai.basePolicyDigest(base),
      issued_at: issued, expires_at: issued + 30 * 60_000, ...patch }, base) };
  };
  beforeEach(() => {
    jest.clearAllMocks(); admit();
    ticket = { ticketId: 4242, status: 'open', assigned_to: '2', ai_epoch: 3, ai_engineer: null, ai_engineer_draft: null,
      staff_card_chat_id: '-100', staff_card_thread_id: 5, staff_card_message_id: 8 };
    ctx = { session: { admin: true }, from: { id: 2 }, chat: { id: -100 }, messenger: 'telegram',
      callbackQuery: { message: { chat: { id: -100 }, message_id: 8, message_thread_id: 5 } }, answerCbQuery: jest.fn() };
    mockRead.mockImplementation(async () => ticket); mockRepair.mockResolvedValue(null);
    mockCatalog.mockResolvedValue({ entries: [other, binding] }); mockBinding.mockResolvedValue(undefined);
    mockSend.mockResolvedValue(77); mockReply.mockResolvedValue(undefined);
    mockSetPrompt.mockImplementation(async (...args: any[]) => ({ ai_engineer_draft: args[9] }));
  });
  it('binds the draft to the admitted request UUID and binding only', async () => {
    expect(mockPolicy.canary.error).toBeNull();
    await handleEngineerCallback(ctx, ['ae', 'start', '4242']);
    const draft: EngineerDraft = mockSetPrompt.mock.calls[0][9];
    expect(draft.request_id).toBe(REQUEST); expect(draft.options).toEqual([binding]);
    expect(draft.fingerprint).toBe(ai.policyFingerprint(mockPolicy)); expect(draft.mode).toBe('new');
  });
  it.each([
    ['another ticket', () => { ticket.ticketId = 43; }],
    ['another actor', () => { ctx.from.id = 1; }],
    ['another owner', () => { ticket.assigned_to = '1'; ctx.from.id = 1; }],
    ['another epoch', () => { ticket.ai_epoch = 4; }],
    ['another revision', () => { mockRepair.mockResolvedValue({ revision: 1, state: 'handed_off', task_id: 'x', request_id: 'y' }); }],
    ['missing binding', () => { mockCatalog.mockResolvedValue({ entries: [other] }); }],
    ['expired admission', () => { admit({ issued_at: Date.now() - 20 * 60_000, expires_at: Date.now() - 1 }); }],
    ['future admission', () => { admit({ issued_at: Date.now() + 60_000, expires_at: Date.now() + 120_000 }); }],
    ['missing admission', () => { mockPolicy = { ...base, canary: ai.parseCanaryPolicy('canary', null, base) }; }],
  ])('opens no form for %s', async (_name, mutate) => {
    mutate();
    await handleEngineerCallback(ctx, ['ae', 'start', String(ticket.ticketId)]);
    expect(mockSend).not.toHaveBeenCalled(); expect(mockSetPrompt).not.toHaveBeenCalled();
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.any(String), true);
  });
  it('confirms through the existing Store.submit with the admitted ids and sends nothing to a customer', async () => {
    const draft: EngineerDraft = { token: '0123456789abcdef', version: 2, compose_version: 3, mode: 'new', step: 'preview',
      goal: 'Synthetic check', options: [binding], selected: binding, owner: '2', epoch: 3,
      fingerprint: ai.policyFingerprint(mockPolicy), base_request: null, task_id: '50000000-0000-4000-8000-000000000005',
      request_id: REQUEST, operation_id: '00000000-0000-4000-8000-000000000003' };
    Object.assign(ticket, { ai_engineer_draft: draft, pending_reply_staff_id: '2', pending_reply_kind: 'note',
      pending_reply_chat_id: '-100', pending_reply_thread_id: 5, pending_reply_version: 3,
      pending_reply_expires_at: new Date(Date.now() + 60000) });
    await handleEngineerCallback(ctx, ['ae', 'confirm', '4242', draft.token, '2']);
    expect(mockSubmit).toHaveBeenCalledWith(4242, '2', binding, { goal: 'Synthetic check', history: '', feedback: '' },
      { task_id: draft.task_id, request_id: REQUEST }, expect.objectContaining({ owner: '2', epoch: 3, base_request: null }));
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('offers the start entry only on the admitted ticket and hides rework', async () => {
    expect(engineerOffered({ ticketId: 4242 } as any)).toBe(true);
    expect(engineerOffered({ ticketId: 43 } as any)).toBe(false);
    const job = ai.createTask(ticket, mockPolicy, '2', binding, ai.snapshotInput('Synthetic'), Date.now(),
      { task_id: '50000000-0000-4000-8000-000000000005', request_id: REQUEST });
    job.state = 'awaiting_operator'; job.projection_pending = null; ticket.ai_engineer = job;
    await handleEngineerCallback(ctx, ['ae', 'view', '4242']);
    const markup = JSON.stringify(mockReply.mock.calls[0][2].reply_markup);
    expect(markup).toContain('ae:handoff:'); expect(markup).not.toContain('ae:rework:');
    mockPolicy = base;
    expect(engineerOffered({ ticketId: 43 } as any)).toBe(true);
  });
});
