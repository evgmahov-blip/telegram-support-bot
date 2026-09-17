const mockGetTicketByInternalId = jest.fn();
const mockGetTicketById = jest.fn();
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const mockAddInternalNote = jest.fn().mockResolvedValue(undefined);
const mockGetInternalNotes = jest.fn().mockResolvedValue([]);
const mockGetTicketAuditHistory = jest.fn().mockResolvedValue([]);
const mockTakeTicketCommand = jest.fn();
const mockTransferTicketCommand = jest.fn();
const mockWaitingUserCommand = jest.fn();
const mockGetStaffRole = jest.fn().mockReturnValue('agent');
const mockCanManageTicket = jest.fn().mockReturnValue(true);
const mockListQueues = jest.fn().mockReturnValue(['general', 'billing', 'infra']);
const mockGetTicketQueue = jest.fn().mockResolvedValue('general');
const mockResolveQueueName = jest.fn((name: string) =>
  ['general', 'billing', 'infra'].find((q) => q === name.toLowerCase()) ?? null
);
const mockMoveTicketToQueue = jest.fn().mockResolvedValue(true);
const mockSetPriority = jest.fn();
const mockGetActiveManageableTicket = jest.fn();
const mockStaffChat = jest.fn().mockResolvedValue(undefined);
const mockReply = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: mockGetTicketById,
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
  addInternalNote: mockAddInternalNote,
  getInternalNotes: mockGetInternalNotes,
}));

jest.mock('../src/team', () => ({
  takeTicketCommand: mockTakeTicketCommand,
  transferTicketCommand: mockTransferTicketCommand,
  waitingUserCommand: mockWaitingUserCommand,
  getStaffRole: mockGetStaffRole,
  canManageTicket: mockCanManageTicket,
}));

jest.mock('../src/ticket-queue', () => ({
  listQueues: mockListQueues,
  getTicketQueue: mockGetTicketQueue,
  resolveQueueName: mockResolveQueueName,
  moveTicketToQueue: mockMoveTicketToQueue,
}));

jest.mock('../src/ticket-metadata', () => ({
  setPriority: mockSetPriority,
  getActiveManageableTicket: mockGetActiveManageableTicket,
}));

jest.mock('../src/ticket-audit', () => ({
  getTicketAuditHistory: mockGetTicketAuditHistory,
}));

jest.mock('../src/staff', () => ({
  chat: mockStaffChat,
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      parse_mode: 'MarkdownV2',
      language: { ticketClosedError: 'Ticket is closed.' },
    },
    staffMembers: new Map([
      ['agent-1', { telegram_id: 'agent-1', role: 'agent', name: 'Agent One' }],
    ]),
  },
}));

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  strictEscape: jest.fn((value: string) => value),
}));

import { Context, TicketPriority } from '../src/interfaces';
import * as commands from '../src/most-commands';

const makeCtx = (reply: Record<string, unknown>, match?: string): Context => ({
  message: {
    text: '',
    reply_to_message: reply,
  },
  session: { admin: true },
  from: { id: 'agent-1' },
  match,
} as unknown as Context);

describe('MOST ticket commands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStaffRole.mockReturnValue('agent');
    mockCanManageTicket.mockReturnValue(true);
    mockListQueues.mockReturnValue(['general', 'billing', 'infra']);
    mockGetTicketQueue.mockResolvedValue('general');
    mockResolveQueueName.mockImplementation((name: string) =>
      ['general', 'billing', 'infra'].find((q) => q === name.toLowerCase()) ?? null
    );
    mockMoveTicketToQueue.mockResolvedValue(true);
    mockSetPriority.mockResolvedValue({ ticketId: 19, priority: 'high' });
    mockGetActiveManageableTicket.mockResolvedValue({ ticketId: 20, status: 'open' });
    mockGetInternalNotes.mockResolvedValue([]);
    mockGetTicketAuditHistory.mockResolvedValue([]);
  });

  it('resolves a replied ticket by Telegram message id before parsing text', async () => {
    const ticket = { ticketId: 42 };
    mockGetTicketByInternalId.mockResolvedValue(ticket);

    const result = await commands.resolveRepliedTicket(makeCtx({
      message_id: 777,
      text: 'Ticket #T999999 from somebody',
      caption: '',
    }));

    expect(result).toBe(ticket);
    expect(mockGetTicketByInternalId).toHaveBeenCalledWith(777);
    expect(mockGetTicketById).not.toHaveBeenCalled();
  });

  it('uses strict ticket-id parsing only as compatibility fallback', async () => {
    mockGetTicketByInternalId.mockResolvedValue(null);
    const ticket = { ticketId: 42 };
    mockGetTicketById.mockResolvedValue(ticket);

    const result = await commands.resolveRepliedTicket(makeCtx({
      message_id: 778,
      text: 'Ticket #T000042 from Alice',
      caption: '',
    }));

    expect(result).toBe(ticket);
    expect(mockGetTicketByInternalId).toHaveBeenCalledWith(778);
    expect(mockGetTicketById).toHaveBeenCalledWith(42, null);
  });

  it('/take operates on the correlated ticket', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 15 });
    const ctx = makeCtx({ message_id: 500, text: '', caption: '' });

    await commands.takeCommand(ctx);

    expect(mockTakeTicketCommand).toHaveBeenCalledWith(ctx, 15);
  });

  it('/transfer requires a target staff id', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 16 });
    const ctx = makeCtx({ message_id: 501, text: '', caption: '' });

    await commands.transferCommand(ctx);

    expect(mockTransferTicketCommand).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Usage: /transfer <staff_telegram_id>');
  });

  it('/transfer passes target and ticket to the workflow', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 16 });
    const ctx = makeCtx({ message_id: 501, text: '', caption: '' }, 'agent-2');

    await commands.transferCommand(ctx);

    expect(mockTransferTicketCommand).toHaveBeenCalledWith(ctx, 'agent-2', 16);
  });

  it('/waiting operates on the correlated ticket', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 17 });
    const ctx = makeCtx({ message_id: 502, text: '', caption: '' });

    await commands.waitingCommand(ctx);

    expect(mockWaitingUserCommand).toHaveBeenCalledWith(ctx, 17);
  });

  it('/queue without a target shows current and available queues', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 18, assigned_to: 'agent-1' });
    const ctx = makeCtx({ message_id: 503, text: '', caption: '' });

    await commands.queueCommand(ctx);

    expect(mockReply).toHaveBeenCalledWith(
      ctx,
      'Queue: general. Available: general, billing, infra. Usage: /queue <name>',
    );
    expect(mockMoveTicketToQueue).not.toHaveBeenCalled();
  });

  it('/queue moves an owned agent ticket with an owner CAS guard', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 18, assigned_to: 'agent-1' });
    const ctx = makeCtx({ message_id: 503, text: '', caption: '' }, 'billing');

    await commands.queueCommand(ctx);

    expect(mockMoveTicketToQueue).toHaveBeenCalledWith(18, 'billing', 'agent-1');
    expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
      'ticket.queue_changed',
      18,
      'agent-1',
      { from: 'general', to: 'billing' },
    );
  });

  it('/queue refuses another agents ticket', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 18, assigned_to: 'agent-2' });
    mockCanManageTicket.mockReturnValue(false);
    const ctx = makeCtx({ message_id: 503, text: '', caption: '' }, 'infra');

    await commands.queueCommand(ctx);

    expect(mockMoveTicketToQueue).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(
      ctx,
      'Only the ticket owner, a supervisor, or an admin can change its queue.',
    );
  });

  it('/priority uses owner/state CAS and records an audit event', async () => {
    mockGetTicketByInternalId.mockResolvedValue({
      ticketId: 19,
      assigned_to: 'agent-1',
      priority: TicketPriority.NORMAL,
      status: 'open',
    });
    const ctx = makeCtx({ message_id: 504, text: '', caption: '' }, 'high');

    await commands.priorityCommand(ctx);

    expect(mockSetPriority).toHaveBeenCalledWith(19, TicketPriority.HIGH, 'agent-1');
    expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
      'ticket.priority_changed',
      19,
      'agent-1',
      { from: TicketPriority.NORMAL, to: TicketPriority.HIGH },
    );
  });

  it('/note writes only after the active owner guard and never echoes note text', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 20, assigned_to: 'agent-1', status: 'open' });
    const ctx = makeCtx({ message_id: 505, text: '', caption: '' }, 'secret internal note');

    await commands.noteCommand(ctx);

    expect(mockGetActiveManageableTicket).toHaveBeenCalledWith(20, 'agent-1');
    expect(mockAddInternalNote).toHaveBeenCalledWith(20, 'agent-1', 'secret internal note');
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Internal note added to #T000020.');
    expect(mockReply.mock.calls.some((call) => String(call[1]).includes('secret internal note'))).toBe(false);
  });

  it('/notes is owner-scoped and stays inside the staff reply surface', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 20, assigned_to: 'agent-1', status: 'open' });
    mockGetInternalNotes.mockResolvedValue([
      { author_id: 'agent-1', text: 'internal only' },
    ]);
    const ctx = makeCtx({ message_id: 506, text: '', caption: '' });

    await commands.notesCommand(ctx);

    expect(mockGetInternalNotes).toHaveBeenCalledWith(20);
    expect(mockReply).toHaveBeenCalledWith(
      ctx,
      'Internal notes #T000020:\n• Agent One: internal only',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('/history shows event type and actor without metadata payloads', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 20, assigned_to: 'agent-1', status: 'open' });
    mockGetTicketAuditHistory.mockResolvedValue([
      {
        type: 'ticket.priority_changed',
        ticketId: 20,
        timestamp: new Date('2026-09-17T10:00:00Z'),
        agent_id: 'agent-1',
        metadata: { secret: 'must not render' },
      },
    ]);
    const ctx = makeCtx({ message_id: 506, text: '', caption: '' });

    await commands.historyCommand(ctx);

    expect(mockGetTicketAuditHistory).toHaveBeenCalledWith(20, 20);
    const rendered = String(mockReply.mock.calls[0][1]);
    expect(rendered).toContain('ticket.priority_changed');
    expect(rendered).toContain('Agent One');
    expect(rendered).not.toContain('must not render');
  });

  it('sends a canned response through the normal staff reply path', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 21, assigned_to: 'agent-1', status: 'open' });
    const ctx = makeCtx({ message_id: 507, text: '', caption: '' });

    await commands.cannedResponseCommand(ctx, 'hello', 'Hello from support');

    expect(ctx.message.text).toBe('Hello from support');
    expect(mockStaffChat).toHaveBeenCalledWith(ctx);
    expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
      'ticket.canned_response',
      21,
      'agent-1',
      { key: 'hello' },
    );
  });

  it('never sends a canned response to a closed ticket', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 22, assigned_to: 'agent-1', status: 'closed' });
    const ctx = makeCtx({ message_id: 508, text: '', caption: '' });

    await commands.cannedResponseCommand(ctx, 'hello', 'Hello from support');

    expect(mockStaffChat).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Ticket is closed.');
  });
});
