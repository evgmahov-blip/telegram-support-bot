const mockSendMessage = jest.fn();
const mockGetTicketByUserId = jest.fn();
const mockPersistTicketMessage = jest.fn();
const mockRecordEventBestEffort = jest.fn();
const mockPersistCorrelation = jest.fn();
const mockLogError = jest.fn();

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      forward_edited_messages: true,
      staffchat_id: 'staff123',
      staffchat_type: 'telegram',
      anonymous_tickets: false,
      language: {
        ticket: 'Ticket',
        from: 'from',
        editedMessage: 'edited',
      },
    },
  },
}));

jest.mock('../src/db', () => ({
  getTicketByUserId: mockGetTicketByUserId,
  persistTicketMessage: mockPersistTicketMessage,
  recordAnalyticsEventBestEffort: mockRecordEventBestEffort,
}));

jest.mock('../src/middleware', () => ({
  strictEscape: jest.fn((value) => value),
  sendMessage: mockSendMessage,
}));

jest.mock('../src/logger', () => ({
  error: mockLogError,
}));

jest.mock('../src/staff-correlation', () => ({
  persistStaffMessageCorrelation: mockPersistCorrelation,
}));

import { handleEditedMessage } from '../src/edited';

function createContext(group = ''): any {
  return {
    messenger: 'telegram',
    update_id: 902,
    editedMessage: {
      message_id: 77,
      text: 'updated text',
      from: {
        id: 'user123',
        first_name: 'John',
      },
    },
    chat: { id: 'user123', type: 'private' },
    session: {
      admin: false,
      groupCategory: 'general',
      group,
    },
  };
}

describe('edited message reliability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTicketByUserId.mockResolvedValue({
      ticketId: 42,
      userid: 'user123',
      messenger: 'telegram',
      status: 'open',
    });
    mockPersistTicketMessage.mockResolvedValue(undefined);
    mockPersistCorrelation.mockResolvedValue(undefined);
  });

  it('persists history before any staff delivery', async () => {
    const error = new Error('history unavailable');
    mockPersistTicketMessage.mockRejectedValueOnce(error);

    await expect(handleEditedMessage(createContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledWith(
      42,
      'user',
      'user123',
      '[edited] updated text',
      'telegram:edited:user123:update:902',
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockPersistCorrelation).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('propagates primary staff delivery failure only after history is durable', async () => {
    const error = new Error('staff delivery failed');
    mockSendMessage.mockRejectedValueOnce(error);

    await expect(handleEditedMessage(createContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistCorrelation).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('waits for correlation before completing post-delivery work', async () => {
    mockSendMessage.mockResolvedValueOnce('777');

    let release!: () => void;
    mockPersistCorrelation.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    let settled = false;
    const processing = handleEditedMessage(createContext()).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockPersistTicketMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistCorrelation).toHaveBeenCalledWith(42, '777', 'John');
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    release();
    await expect(processing).resolves.toBe(true);
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.message.user',
      42,
      'user123',
    );
  });

  it('keeps a secondary category mirror best-effort', async () => {
    mockSendMessage
      .mockResolvedValueOnce('778')
      .mockRejectedValueOnce(new Error('mirror failed'));

    await expect(handleEditedMessage(createContext('group456'))).resolves.toBe(true);

    expect(mockSendMessage).toHaveBeenNthCalledWith(1, 'staff123', 'telegram', expect.any(String));
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, 'group456', 'telegram', expect.any(String));
    expect(mockLogError).toHaveBeenCalled();
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.message.user',
      42,
      'user123',
    );
  });
});
