import cache from '../src/cache';
import * as db from '../src/db';
import * as middleware from '../src/middleware';
import { generateDailySummary, sendDailySummary } from '../src/analytics';

const getAnalyticsEvents = db.getAnalyticsEvents as jest.MockedFunction<typeof db.getAnalyticsEvents>;

describe('daily support summary', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    getAnalyticsEvents.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders Russian plain text and splits rounded resolution minutes correctly', async () => {
    getAnalyticsEvents
      .mockResolvedValueOnce([{}, {}, {}] as any)
      .mockResolvedValueOnce(Array(9).fill({}) as any)
      .mockResolvedValueOnce([{ ticketId: 1, timestamp: '2026-10-19T10:00:00Z' }] as any)
      .mockResolvedValueOnce([{ ticketId: 1, timestamp: '2026-10-19T10:12:30Z' }] as any)
      .mockResolvedValueOnce([{ ticketId: 2, timestamp: '2026-10-19T10:00:00Z' }] as any)
      .mockResolvedValueOnce([{ ticketId: 2, timestamp: '2026-10-19T10:59:36Z' }] as any)
      .mockResolvedValueOnce([{ metadata: { rating: 4.8 } }] as any);

    await expect(generateDailySummary()).resolves.toBe(
      '📊 Ежедневная сводка поддержки МОСТ\n\n' +
      '📋 Обращения сегодня: 3\n\n' +
      'За последние 7 дней:\n' +
      '📈 Обращения: 9\n' +
      '⏱️ Среднее время первого ответа: 12.5 мин\n' +
      '✅ Среднее время решения: 1 ч 0 мин\n' +
      '⭐ Удовлетворённость клиентов: 4.8/5.0\n',
    );
  });

  it('omits unavailable optional metrics and sends without a parse mode', async () => {
    getAnalyticsEvents.mockResolvedValue([] as any);
    const sendMessage = jest.spyOn(middleware, 'sendMessage').mockResolvedValue('1');
    Object.assign(cache.config, { staffchat_id: '-100123', staffchat_type: 'telegram' });

    await sendDailySummary();

    expect(sendMessage).toHaveBeenCalledWith(
      '-100123',
      'telegram',
      '📊 Ежедневная сводка поддержки МОСТ\n\n' +
      '📋 Обращения сегодня: 0\n\n' +
      'За последние 7 дней:\n' +
      '📈 Обращения: 0\n',
      {},
    );
  });
});
