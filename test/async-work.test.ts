import { AsyncWorkTracker } from '../src/async-work';

describe('AsyncWorkTracker', () => {
  it('waits for tracked work and work added while draining', async () => {
    const tracker = new AsyncWorkTracker();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    tracker.track(new Promise<void>((resolve) => { releaseFirst = resolve; }), jest.fn());

    let drained = false;
    const draining = tracker.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    tracker.track(new Promise<void>((resolve) => { releaseSecond = resolve; }), jest.fn());
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseSecond();
    await draining;
    expect(drained).toBe(true);
  });

  it('reports rejected work without making drain reject', async () => {
    const tracker = new AsyncWorkTracker();
    const onError = jest.fn();
    const error = new Error('handler failed');

    tracker.track(Promise.reject(error), onError);
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('does not turn a throwing error reporter into an unhandled tracked failure', async () => {
    const tracker = new AsyncWorkTracker();
    tracker.track(Promise.reject(new Error('handler failed')), () => {
      throw new Error('reporter failed');
    });

    await expect(tracker.drain()).resolves.toBeUndefined();
  });
  it('returns after the configured deadline when tracked work never settles', async () => {
    jest.useFakeTimers();
    try {
      const tracker = new AsyncWorkTracker();
      tracker.track(new Promise<void>(() => {}), jest.fn());

      let drained = false;
      const draining = tracker.drain(5000).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);

      await jest.advanceTimersByTimeAsync(5000);
      await draining;
      expect(drained).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

});
