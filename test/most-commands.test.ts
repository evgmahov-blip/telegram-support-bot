const mockGetTicketByInternalId = jest.fn();
const mockGetTicketById = jest.fn();
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
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
const mockReply = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: mockGetTicketById,
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
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

jest.mock('../src/middleware', () => ({
  reply: mockReply,
}));

import { Context } from '../src/interfaces';
import * as commands from '../src/most-commands';

const makeCtx = (reply: Record<string, unknown>, match?: string): Context => ({
  message: {
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

  it('/queue rejects unknown queues', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ticketId: 18, assigned_to: 'agent-1' });
    const ctx = makeCtx({ message_id: 503, text: '', caption: '' }, 'unknown');

    await commands.queueCommand(ctx);

    expect(mockMoveTicketToQueue).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Unknown queue. Available: general, billing, infra');
  });
});
