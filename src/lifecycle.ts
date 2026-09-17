import mongoose from 'mongoose';
import type { Addon } from './interfaces';
import * as eventsApi from './events-api';
import * as log from './logger';

export type ManagedTimer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
export type StoppableAddon = Addon & { stop?: () => void | Promise<void> };

export function createGracefulShutdown(
  addons: StoppableAddon[],
  timers: Set<ManagedTimer> = new Set(),
): (reason?: string) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return async (reason = 'shutdown') => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      log.info(`Graceful shutdown started (${reason}).`);

      for (const timer of timers) {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        clearInterval(timer as ReturnType<typeof setInterval>);
      }
      timers.clear();

      const errors: unknown[] = [];
      const stopResults = await Promise.allSettled(
        addons.map(async (addon) => {
          if (typeof addon.stop === 'function') await addon.stop();
        }),
      );
      for (const result of stopResults) {
        if (result.status === 'rejected') {
          errors.push(result.reason);
          log.error('Addon shutdown failed:', result.reason);
        }
      }

      try {
        await eventsApi.stopEventsApi();
      } catch (err) {
        errors.push(err);
        log.error('Event API shutdown failed:', err);
      }

      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.disconnect();
        }
      } catch (err) {
        errors.push(err);
        log.error('MongoDB shutdown failed:', err);
      }

      if (errors.length > 0) {
        throw new Error(`Graceful shutdown completed with ${errors.length} error(s).`);
      }

      log.info('Graceful shutdown completed.');
    })();

    return shutdownPromise;
  };
}

export function installSignalHandlers(
  shutdown: (reason?: string) => Promise<void>,
): () => void {
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    void shutdown(signal).catch((err) => {
      log.error(`Graceful shutdown failed after ${signal}:`, err);
      process.exitCode = 1;
    });
  };

  const onSigInt = () => onSignal('SIGINT');
  const onSigTerm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  return () => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  };
}
