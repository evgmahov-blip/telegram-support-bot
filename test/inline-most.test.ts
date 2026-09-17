const mockAssignTicketCommand = jest.fn();
const mockUnassignTicketCommand = jest.fn();
const mockCanPerformAction = jest.fn().mockReturnValue(true);
const mockReply = jest.fn();

jest.mock('../src/team', () => ({
  assignTicketCommand: mockAssignTicketCommand,
  unassignTicketCommand: mockUnassignTicketCommand,
  canPerformAction: mockCanPerformAction,
}));

jest.mock('../src/middleware', () => ({
  reply: mockReply,
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      parse_mode: 'MarkdownV2',
      categories: [],
      language: {
        back: 'Back',
        msgForwarding: 'Forwarding',
        whatSubCategory: 'Choose',
      },
    },
  },
}));

import { Context } from '../src/interfaces';
import { callbackQuery } from '../src/inline';

const makeCtx = (data: string): Context => ({
  callbackQuery: {
    data,
    from: { id: 'agent-1' },
    id: 'cb-1',
  },
  session: {
    admin: true,
    mode: 'private_reply',
    modeData: {
      ticketid: '42',
      userid: '123',
      name: 'Alice',
      category: 'support',
    },
  },
  answerCbQuery: jest.fn().mockResolvedValue(undefined),
} as unknown as Context);

describe('MOST inline callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanPerformAction.mockReturnValue(true);
  });

  it('rejects historical private-reply callbacks and clears legacy session state', async () => {
    const ctx = makeCtx('123---Alice---support---42');

    await callbackQuery(ctx);

    expect(ctx.session.mode).toBeNull();
    expect(ctx.session.modeData).toEqual({});
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('This action is no longer available.', true);
    expect(mockAssignTicketCommand).not.toHaveBeenCalled();
    expect(mockUnassignTicketCommand).not.toHaveBeenCalled();
  });

  it('keeps supported assignment callbacks working', async () => {
    const ctx = makeCtx('assign:agent-2:42');

    await callbackQuery(ctx);

    expect(mockAssignTicketCommand).toHaveBeenCalledWith(ctx, 'agent-2', 42);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Ticket assigned!', true);
  });
});
