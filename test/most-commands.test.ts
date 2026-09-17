const mockGetTicketByInternalId = jest.fn();
const mockGetTicketById = jest.fn();
const mockTakeTicketCommand = jest.fn();
const mockTransferTicketCommand = jest.fn();
const mockWaitingUserCommand = jest.fn();
const mockReply = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: mockGetTicketById,
}));

jest.mock('../src/team', () => ({
  takeTicketCommand: mockTakeTicketCommand,
  transferTicketCommand: mockTransferTicketCommand,
  waitingUserCommand: mockWaitingUserCommand,
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
});
