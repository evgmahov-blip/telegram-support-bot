// Mock OpenAI before importing anything else
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: 'Test response' } }]
          })
        }
      }
    }))
  };
});

import * as staff from '../src/staff';
import cache from '../src/cache';
import * as middleware from '../src/middleware';

jest.mock('../src/cache');
jest.mock('../src/middleware');
jest.mock('../src/db', () => ({
    Supportee: { findOneAndUpdate: jest.fn() },
    addTicketMessage: jest.fn().mockResolvedValue(undefined),
    recordAnalyticsEvent: jest.fn().mockResolvedValue(undefined),
    setFirstResponseAt: jest.fn().mockResolvedValue(undefined),
    transitionTicketStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/team', () => ({
    canPerformAction: jest.fn().mockReturnValue(true),
    canManageTicket: jest.fn().mockReturnValue(true),
    addInternalNoteCommand: jest.fn(),
}));
jest.mock('fancy-log');

const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockStrictEscape = jest.fn((text) => text);
const mockReply = jest.fn();

(middleware as any).sendMessage = mockSendMessage;
(middleware as any).strictEscape = mockStrictEscape;
(middleware as any).reply = mockReply;

describe('Staff Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (cache as any).config = {
      clean_replies: false,
      anonymous_replies: false,
      language: {
        dear: 'Dear',
        regards: 'Best regards',
        regardsGroup: 'Support Team',
        msg_sent: 'Sent',
      },
      parse_mode: 'MarkdownV2'
    };
  });

  const createMockContext = (): any => ({
    message: {
      text: 'Test message',
      from: {
        id: 123,
        first_name: 'John Engineer',
        is_bot: false
      },
      date: Date.now(),
    },
    chat: { id: 456, type: 'group' },
    update_id: 1,
    messenger: 'telegram',
    session: {
      modeData: {
        userid: 'user123',
        name: 'Jane Doe',
        ticketid: 'T001',
        category: 'support',
      }
    },
    reply: mockReply,
    from: { id: 123, first_name: 'John Engineer' }
  });

  describe('privateReply', () => {
    it('routes through the bot without engineer identity or direct-link markup', () => {
      const ctx = createMockContext();

      (staff as any).privateReply(ctx);

      expect(mockSendMessage).toHaveBeenCalledWith(
        'user123',
        'telegram',
        expect.stringContaining('Dear Jane Doe'),
        { parse_mode: 'MarkdownV2' },
      );
      const userMessage = mockSendMessage.mock.calls[0][2] as string;
      expect(userMessage).toContain('Support Team');
      expect(userMessage).not.toContain('John Engineer');
      expect(mockSendMessage.mock.calls[0][3]).not.toHaveProperty('reply_markup');
    });

    it('should handle clean replies mode without adding identity', () => {
      const ctx = createMockContext();
      (cache as any).config.clean_replies = true;

      (staff as any).privateReply(ctx);

      expect(mockSendMessage).toHaveBeenCalledWith(
        'user123',
        'telegram',
        'Test message',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it('should use custom message while preserving anonymous support identity', () => {
      const ctx = createMockContext();
      const customMsg = {
        text: 'Custom response',
        from: { first_name: 'Another Engineer' }
      };

      (staff as any).privateReply(ctx, customMsg);

      const userMessage = mockSendMessage.mock.calls[0][2] as string;
      expect(userMessage).toContain('Custom response');
      expect(userMessage).toContain('Support Team');
      expect(userMessage).not.toContain('Another Engineer');
    });
  });

  describe('ticketMsg', () => {
    it('formats every normal reply with support-team identity only', () => {
      const message = {
        text: 'Hello world',
        from: { first_name: 'John Engineer' }
      };

      const result = (staff as any).ticketMsg('Jane', message);

      expect(result).toContain('Dear Jane');
      expect(result).toContain('Hello world');
      expect(result).toContain('Support Team');
      expect(result).not.toContain('John Engineer');
    });

    it('should handle clean replies', () => {
      (cache as any).config.clean_replies = true;
      const message = {
        text: 'Clean message',
        from: { first_name: 'John Engineer' }
      };

      const result = (staff as any).ticketMsg('Jane', message);

      expect(result).toBe('Clean message');
      expect(result).not.toContain('John Engineer');
    });
  });
});