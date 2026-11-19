import { acknowledgeCallbackIngress } from '../src/callback-ack';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('preserves a fast private alert and cancels the fallback', async () => {
  const answer = jest.fn().mockResolvedValue(true);
  const ctx = { callbackQuery: {}, answerCallbackQuery: answer };
  const finish = acknowledgeCallbackIngress(ctx, jest.fn());
  await ctx.answerCallbackQuery({ text: 'Доступ запрещён', show_alert: true });
  await finish();
  await jest.advanceTimersByTimeAsync(2000);
  expect(answer).toHaveBeenCalledTimes(1);
  expect(answer).toHaveBeenCalledWith({ text: 'Доступ запрещён', show_alert: true });
});
it.each(['database', 'writer lock'])('ACKs during a held %s and tolerates an expired late answer', async () => {
  const answer = jest.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('query is too old'));
  const error = jest.fn();
  const ctx = { callbackQuery: {}, answerCallbackQuery: answer };
  const finish = acknowledgeCallbackIngress(ctx, error);
  await jest.advanceTimersByTimeAsync(1499);
  expect(answer).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(answer).toHaveBeenCalledWith({});
  await expect(ctx.answerCallbackQuery({ text: 'Сохранено' })).resolves.toBeUndefined();
  await ctx.answerCallbackQuery({ text: 'Повтор' });
  await finish();
  expect(answer).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(1);
});
it('cleans up and ACKs when the upstream database claim fails', async () => {
  const answer = jest.fn().mockResolvedValue(true);
  const finish = acknowledgeCallbackIngress({ callbackQuery: {}, answerCallbackQuery: answer }, jest.fn());
  await finish();
  await jest.advanceTimersByTimeAsync(2000);
  expect(answer).toHaveBeenCalledTimes(1);
});
it('does not turn a fast committed save into failure on an ACK network error', async () => {
  const error = jest.fn();
  const ctx = { callbackQuery: {}, answerCallbackQuery: jest.fn().mockRejectedValue(new Error('network')) };
  const finish = acknowledgeCallbackIngress(ctx, error);
  await expect(ctx.answerCallbackQuery({ text: 'Сохранено' })).resolves.toBeUndefined();
  await finish();
  expect(error).toHaveBeenCalledTimes(1);
});
