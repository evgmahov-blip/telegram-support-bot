import { createHash, createHmac } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { canonicalWorkloadRequest } from '../src/organization-auth';

jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/db', () => ({
  Supportee: { collection: { name: 'existing_owner' }, db: { models: {}, model: jest.fn(() => ({})) } },
  getEventsSince: jest.fn(async () => []),
}));
jest.mock('/test-only/private-organization-binding.cjs', () => {
  const seen = new Set<string>();
  return {
    sourceInstance: 'test-owner', audience: 'test-private-read',
    keys: { 'test-key': 'w'.repeat(32) }, allowedKeyIds: ['test-key'], cursorSecret: 'c'.repeat(32),
    consumeNonce: jest.fn(async (key: string, nonce: string) => {
      const identity = `${key}:${nonce}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    }),
    centralAuthorizer: { authorize: jest.fn(async () => ({ allowed: true, principal_enabled: true,
      rbac_enabled: true, denied: false, org_refs: [], scope_version: 'scope-1' })) },
  };
}, { virtual: true });

import cache from '../src/cache';
import * as db from '../src/db';
import { startEventsApi, stopEventsApi } from '../src/events-api';

it('mounts private reads on the existing server only with a trusted binding and rejects missing proof and replay', async () => {
  const express = require('express');
  let app: any;
  const listen = jest.spyOn(express.application, 'listen').mockImplementation(function (this: any, ...args: any[]) {
    app = this;
    args[2]();
    return { close: (callback: () => void) => callback() };
  });
  const config = cache.config as any;
  Object.assign(config, { api_enabled: true, api_token: 'legacy-test-token', api_host: '127.0.0.1' });
  const start = async (modulePath?: string) => {
    config.organization_private_runtime_module = modulePath;
    startEventsApi();
  };
  const get = (path: string, headers = {}): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    // Exercise the real Express stack without opening a socket (executor has no loopback ingress).
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(socket);
    req.method = 'GET'; req.url = path; req.headers = headers;
    const res = new ServerResponse(req);
    res.end = ((body: string) => {
      try { resolve({ status: res.statusCode, body: JSON.parse(String(body)) }); }
      catch (error) { reject(error); }
      return res;
    }) as typeof res.end;
    app.handle(req, res);
  });
  try {
    for (const binding of [undefined, 'relative/untrusted.cjs']) {
      await start(binding);
      expect((await get('/internal/v1/organizations', { authorization: 'Bearer legacy-test-token' })).status).toBe(503);
      expect((await get('/healthz')).status).toBe(200);
      expect((await get('/events', { authorization: 'Bearer legacy-test-token' })).status).toBe(200);
      await stopEventsApi();
    }
    await start('/test-only/private-organization-binding.cjs');
    expect((await get('/internal/v1/organizations', { authorization: 'Bearer legacy-test-token' })).status).toBe(401);
    const timestamp = new Date().toISOString();
    const nonce = 'test_nonce_00000001';
    const headers = {
      'x-ainoc-key-id': 'test-key', 'x-ainoc-timestamp': timestamp, 'x-ainoc-nonce': nonce,
      'x-ainoc-actor': 'workspace:test-user', 'x-ainoc-audience': 'test-private-read',
      'x-ainoc-source-instance': 'test-owner',
      'x-ainoc-signature': createHmac('sha256', 'w'.repeat(32)).update(canonicalWorkloadRequest({
        method: 'GET', path: '/internal/v1/organizations', query: '', actor: 'workspace:test-user',
        audience: 'test-private-read', sourceInstance: 'test-owner', timestamp, nonce,
        bodyDigest: createHash('sha256').update('').digest('hex'),
      })).digest('base64url'),
    };
    const result = await get('/internal/v1/organizations', headers);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ source: { authority: 'support-bot', instance: 'test-owner' },
      scope_version: 'scope-1', items: [] });
    const binding = require('/test-only/private-organization-binding.cjs');
    expect(binding.centralAuthorizer.authorize).toHaveBeenCalledWith({
      principal_ref: 'workspace:test-user', permission: 'organizations.read',
    });
    expect(binding.consumeNonce).toHaveBeenCalledWith('test-key', nonce, expect.any(Number));
    expect(db.Supportee.db.model).toHaveBeenCalledWith('existing_owner_OrganizationOwner', expect.anything(),
      'existing_owner_organizations', { overwriteModels: false });
    expect((await get('/internal/v1/organizations', headers)).status).toBe(401);
  } finally {
    await stopEventsApi(); listen.mockRestore();
    delete config.organization_private_runtime_module;
  }
});
