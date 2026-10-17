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

const mockStrictEscape = jest.fn((text) => text);
(middleware as any).strictEscape = mockStrictEscape;

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

  it('does not export the legacy private engineer reply handler', () => {
    expect((staff as any).privateReply).toBeUndefined();
  });

  describe('ticketMsg', () => {
    it('formats every normal reply with support-team identity only', () => {
      const message = {
        text: 'Hello world',
        from: { first_name: 'John Engineer' }
      };

      const result = (staff as any).ticketMsg('Jane', message);

      expect(result).toContain('Dear Jane!');
      expect(result).toContain('Hello world');
      expect(result).toContain('Support Team');
      expect(result).not.toContain('John Engineer');
    });

    it('renders the reviewed Russian reply exactly once without changing engineer text', () => {
      (cache as any).config.language.dear = 'Здравствуйте,';
      (cache as any).config.language.regards = 'С уважением,';
      (cache as any).config.language.regardsGroup = 'Команда поддержки МОСТ';
      const result = (staff as any).ticketMsg('Женя', {
        text: 'всё будет хорошо не очкуй', from: { first_name: 'Скрытый инженер' },
      });
      expect(result).toBe('Здравствуйте, Женя!\n\nвсё будет хорошо не очкуй\n\nКоманда поддержки МОСТ');
      expect(result).not.toContain('С уважением');
      expect(result).not.toContain('Скрытый инженер');
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
