const reply = jest.fn();
const error = jest.fn();
jest.mock('../src/middleware', () => ({ reply: (...args: any[]) => reply(...args) }));
jest.mock('../src/logger', () => ({ error: (...args: any[]) => error(...args) }));
import { presentAfterWrite } from '../src/write-presentation';

beforeEach(() => { jest.clearAllMocks(); reply.mockResolvedValue(undefined); });
it('leaves successful presentation alone', async () => {
  const present = jest.fn().mockResolvedValue(undefined);
  await presentAfterWrite({} as any, present, 'Сохранено.');
  expect(present).toHaveBeenCalledTimes(1); expect(reply).not.toHaveBeenCalled();
});
it('reports a committed write accurately when the screen fails', async () => {
  await presentAfterWrite({} as any, async () => { throw new Error('screen'); }, 'Сохранено.');
  expect(reply).toHaveBeenCalledWith({}, 'Сохранено.', { parse_mode: undefined, message_thread_id: undefined }); expect(error).toHaveBeenCalledTimes(1);
});
it('does not turn a feedback delivery failure into a mutation failure or retry', async () => {
  reply.mockRejectedValue(new Error('delivery'));
  const present = jest.fn().mockRejectedValue(new Error('screen'));
  await expect(presentAfterWrite({} as any, present, 'Сохранено.')).resolves.toBeUndefined();
  expect(present).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(2);
});

it('keeps failure feedback in the source topic', async () => {
  const ctx = { callbackQuery: { message: { message_thread_id: 11 } } } as any;
  await presentAfterWrite(ctx, async () => { throw new Error('screen'); }, 'Сохранено.');
  expect(reply).toHaveBeenCalledWith(ctx, 'Сохранено.', { parse_mode: undefined, message_thread_id: 11 });
});
