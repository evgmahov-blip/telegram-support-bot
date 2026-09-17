import {
  TelegramUpdateDeduper,
  TelegramUpdateReceiptStore,
} from '../src/telegram-update-dedup';

describe('TelegramUpdateDeduper', () => {
  let store: jest.Mocked<TelegramUpdateReceiptStore>;
  let deduper: TelegramUpdateDeduper;

  beforeEach(() => {
    store = {
      create: jest.fn().mockResolvedValue(undefined),
      reclaim: jest.fn().mockResolvedValue(false),
      complete: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    deduper = new TelegramUpdateDeduper(store, () => 'bot-test', 1_000, 10_000);
  });

  it('claims a fresh update with a scoped durable receipt', async () => {
    await expect(deduper.claim(42)).resolves.toBe(true);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'bot-test:telegram:42',
      update_id: 42,
      state: 'processing',
      attempts: 1,
    }));
    expect(store.reclaim).not.toHaveBeenCalled();
  });

  it('suppresses a duplicate with an active or completed receipt', async () => {
    store.create.mockRejectedValueOnce({ code: 11000 });
    store.reclaim.mockResolvedValueOnce(false);

    await expect(deduper.claim(42)).resolves.toBe(false);
    expect(store.reclaim).toHaveBeenCalledWith(
      'bot-test:telegram:42',
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('reclaims an expired processing lease', async () => {
    store.create.mockRejectedValueOnce({ code: 11000 });
    store.reclaim.mockResolvedValueOnce(true);

    await expect(deduper.claim(42)).resolves.toBe(true);
  });

  it('does not hide non-duplicate storage errors', async () => {
    const error = new Error('mongo unavailable');
    store.create.mockRejectedValueOnce(error);
    await expect(deduper.claim(42)).rejects.toBe(error);
  });

  it('marks a claimed update complete and releases failed work', async () => {
    await expect(deduper.complete(42)).resolves.toBeUndefined();
    expect(store.complete).toHaveBeenCalledWith(
      'bot-test:telegram:42',
      expect.any(Date),
      expect.any(Date),
    );

    await expect(deduper.release(42)).resolves.toBeUndefined();
    expect(store.release).toHaveBeenCalledWith('bot-test:telegram:42');
  });

  it('fails completion when the claim disappeared', async () => {
    store.complete.mockResolvedValueOnce(false);
    await expect(deduper.complete(42)).rejects.toThrow('claim disappeared');
  });

  it('fails open for malformed synthetic update ids without touching storage', async () => {
    await expect(deduper.claim(-1)).resolves.toBe(true);
    expect(store.create).not.toHaveBeenCalled();
  });
});
