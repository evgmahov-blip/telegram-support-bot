export class AsyncWorkTracker {
  private pending = new Set<Promise<void>>();

  track(work: Promise<unknown>, onError: (error: unknown) => void): void {
    const tracked = Promise.resolve(work).then(
      () => undefined,
      (error) => {
        try {
          onError(error);
        } catch {
          // Error reporting must never create a second unhandled rejection.
        }
      },
    );

    this.pending.add(tracked);
    void tracked.then(
      () => { this.pending.delete(tracked); },
      () => { this.pending.delete(tracked); },
    );
  }

  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
        timer.unref?.();
      });

      await Promise.race([
        Promise.allSettled(Array.from(this.pending)).then(() => undefined),
        expiry,
      ]);
      if (timer) clearTimeout(timer);
    }
  }
}
