import { isAbsolute } from 'path';
import type { Model } from 'mongoose';
import { createCursorCodec, createHmacWorkloadVerifier, type ConsumeNonce } from './organization-auth';
import { createOrganizationModel } from './organization-model';
import { createMongooseOrganizationRepository } from './organization-repository';
import { createOrganizationReadRouter, type CentralAuthorizer } from './organization-router';
import * as log from './logger';

/** Server-owned dependencies, never supplied by a request or a browser. */
export interface PrivateOrganizationRuntimeBinding {
  sourceInstance: string;
  audience: string;
  keys: Readonly<Record<string, Buffer | string>>;
  allowedKeyIds: readonly string[];
  cursorSecret: Buffer | string;
  consumeNonce: ConsumeNonce;
  centralAuthorizer: CentralAuthorizer;
}

/** Mount on the existing HTTP server; an unavailable binding closes only this API. */
export function mountOrganizationRuntime(app: any, modulePath: unknown, ticketModel: Model<any>): void {
  let router: any;
  if (modulePath) {
    try {
      if (typeof modulePath !== 'string' || !isAbsolute(modulePath)) throw new Error('absolute binding path required');
      // This is explicitly configured trusted server code, not a request-selected adapter.
      const binding: PrivateOrganizationRuntimeBinding = require(modulePath);
      if (typeof binding.consumeNonce !== 'function' || typeof binding.centralAuthorizer?.authorize !== 'function') {
        throw new Error('private dependencies unavailable');
      }
      const workloadVerifier = createHmacWorkloadVerifier(binding);
      const cursorCodec = createCursorCodec(binding.cursorSecret);
      const repository = createMongooseOrganizationRepository({
        organizationModel: createOrganizationModel(ticketModel), ticketModel,
        registeredInstance: binding.sourceInstance,
      });
      router = createOrganizationReadRouter({ sourceInstance: binding.sourceInstance,
        repository, workloadVerifier, cursorCodec, centralAuthorizer: binding.centralAuthorizer });
    } catch {
      // Never log key material, adapter errors, or central credentials.
      log.error('Private organization API binding unavailable; access disabled');
    }
  }
  app.use((req: any, res: any, next: any) => {
    if (req.path !== '/internal/v1' && !req.path.startsWith('/internal/v1/')) return next();
    if (!router) return res.status(503).json({ schema_version: 1, error: 'source unavailable' });
    // Keep the original full path: it is part of the workload signature.
    return router(req, res, next);
  });
}
