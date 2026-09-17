const mockGetResponseFromLLM = jest.fn();
const mockAnalyzeMessage = jest.fn();
const mockSendMessage = jest.fn().mockResolvedValue('staff-msg');
const mockAddTicketMessage = jest.fn().mockResolvedValue(undefined);
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/addons/llm', () => ({
  getResponseFromLLM: mockGetResponseFromLLM,
}));

jest.mock('../src/triage', () => ({
  analyzeMessage: mockAnalyzeMessage,
}));

jest.mock('../src/middleware', () => ({
  sendMessage: mockSendMessage,
}));

jest.mock('../src/db', () => ({
  addTicketMessage: mockAddTicketMessage,
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
}));

jest.mock('../src/logger', () => ({
  error: jest.fn(),
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      use_llm: true,
      auto_triage: true,
      staffchat_id: 'staff-group',
      staffchat_type: 'telegram',
    },
  },
}));

import * as aiDraft from '../src/ai-draft';

const ticket: any = { ticketId: 41 };
const ctx: any = { message: { text: 'The service is down' } };

describe('AI draft-only assistance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetResponseFromLLM.mockResolvedValue('Please check the service status.');
    mockAnalyzeMessage.mockResolvedValue({
      category: 'infra',
      priority: 'urgent',
      summary: 'Service outage',
      sentimentScore: 2,
    });
  });

  it('publishes suggestions only to the staff chat and stores reply as AI draft history', async () => {
    await aiDraft.createAIDraft(ticket, ctx);

    expect(mockAnalyzeMessage).toHaveBeenCalledWith('The service is down');
    expect(mockGetResponseFromLLM).toHaveBeenCalledWith(ctx);
    expect(mockSendMessage).toHaveBeenCalledWith(
      'staff-group',
      'telegram',
      expect.stringContaining('AI DRAFT #T000041'),
      {},
    );
    expect(mockAddTicketMessage).toHaveBeenCalledWith(
      41,
      'ai',
      'draft',
      'Please check the service status.',
    );
    expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
      'ai.draft_created',
      41,
      null,
      { reply: true, triage: true },
    );
  });

  it('never passes ticketId into triage, so the suggestion cannot persist itself', async () => {
    await aiDraft.createAIDraft(ticket, ctx);

    expect(mockAnalyzeMessage).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeMessage.mock.calls[0]).toEqual(['The service is down']);
  });
});
