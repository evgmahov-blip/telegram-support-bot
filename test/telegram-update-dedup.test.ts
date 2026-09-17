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

  it('claims a fresh update with a scoped durable fencing token', async () => {
    const claimId = await deduper.claim(42);
    expect(claimId).toEqual(expect.any(String));
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'bot-test:telegram:42',
      update_id: 42,
      claim_id: claimId,
      state: 'processing',
      attempts: 1,
    }));
    expect(store.reclaim).not.toHaveBeenCalled();
  });

  it('suppresses a duplicate with an active or completed receipt', async () => {
    store.create.mockRejectedValueOnce({ code: 11000 });
    store.reclaim.mockResolvedValueOnce(false);

    await expect(deduper.claim(42)).resolves.toBeNull();
    expect(store.reclaim).toHaveBeenCalledWith(
      'bot-test:telegram:42',
      expect.any(String),
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('reclaims an expired processing lease with a new fencing token', async () => {
    store.create.mockRejectedValueOnce({ code: 11000 });
    store.reclaim.mockResolvedValueOnce(true);

    const claimId = await deduper.claim(42);
    expect(claimId).toEqual(expect.any(String));
    expect(store.reclaim).toHaveBeenCalledWith(
      'bot-test:telegram:42',
      claimId,
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('does not hide non-duplicate storage errors', async () => {
    const error = new Error('mongo unavailable');
    store.create.mockRejectedValueOnce(error);
    await expect(deduper.claim(42)).rejects.toBe(error);
  });

  it('uses the fencing token for completion and release', async () => {
    await expect(deduper.complete(42, 'claim-1')).resolves.toBeUndefined();
    expect(store.complete).toHaveBeenCalledWith(
      'bot-test:telegram:42',
      'claim-1',
      expect.any(Date),
      expect.any(Date),
    );

    await expect(deduper.release(42, 'claim-1')).resolves.toBeUndefined();
    expect(store.release).toHaveBeenCalledWith('bot-test:telegram:42', 'claim-1');
  });

  it('rejects completion after ownership was lost to a newer claim', async () => {
    store.complete.mockResolvedValueOnce(false);
    await expect(deduper.complete(42, 'stale-claim')).rejects.toThrow('no longer owned');
  });

  it('fails open for malformed synthetic update ids without touching storage', async () => {
    await expect(deduper.claim(-1)).resolves.toBe('synthetic');
    expect(store.create).not.toHaveBeenCalled();
  });
});
