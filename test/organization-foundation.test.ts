import { createHash, createHmac } from 'crypto';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import { canonicalUuid, issueOrgRef, parseOrgRef } from '../src/organization-domain';
import { OrganizationSchema, createOrganizationModel } from '../src/organization-model';
import { canonicalQuery, canonicalWorkloadRequest, createCursorCodec, createHmacWorkloadVerifier } from '../src/organization-auth';
import { createMongooseOrganizationRepository } from '../src/organization-repository';
import { createOrganizationReadRouter, projectOrganization, unavailableCentralAuthorizer } from '../src/organization-router';

const INSTANCE = 'owner-registry-01';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ref = (id = A) => ({ authority: 'support-bot' as const, instance: INSTANCE, id });

function queryChain(result: any[]) {
  const exec = jest.fn().mockResolvedValue(result);
  const chain: any = { setOptions: jest.fn(), sort: jest.fn(), limit: jest.fn(), lean: jest.fn(), exec };
  chain.setOptions.mockReturnValue(chain); chain.sort.mockReturnValue(chain); chain.limit.mockReturnValue(chain); chain.lean.mockReturnValue(chain);
  return chain;
}

async function inject(app: any, method: string, url: string, headers: Record<string, string> = {}) {
  const req: any = new Readable({ read() { this.push(null); } });
  Object.assign(req, { method, url, originalUrl: url, headers, connection: {}, socket: {} });
  const responseHeaders = new Map<string, any>();
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const res: any = {
      statusCode: 200, setHeader: (k: string, v: any) => responseHeaders.set(k.toLowerCase(), v),
      getHeader: (k: string) => responseHeaders.get(k.toLowerCase()), getHeaders: () => Object.fromEntries(responseHeaders),
      removeHeader: (k: string) => responseHeaders.delete(k.toLowerCase()),
      write: (chunk: any) => { chunks.push(Buffer.from(chunk)); return true; },
      end: (chunk?: any) => { if (chunk) chunks.push(Buffer.from(chunk)); const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined }); },
    };
    app.handle(req, res, reject);
  });
}

describe('organization source-owner foundation', () => {
  test('canonical tuple is owner-issued and registered-instance bound', () => {
    expect(issueOrgRef(INSTANCE, () => A)).toEqual(ref());
    expect(canonicalUuid(A.toUpperCase())).toBe(A);
    expect(() => parseOrgRef(ref(), 'another-instance')).toThrow();
    expect(() => parseOrgRef({ ...ref(), extra: true }, INSTANCE)).toThrow();
  });

  test('schema disables automatic DB effects and validates relationship invariants', async () => {
    expect(OrganizationSchema.get('autoCreate')).toBe(false);
    expect(OrganizationSchema.get('autoIndex')).toBe(false);
    const Model = mongoose.model(`OrgValidation${Date.now()}`, OrganizationSchema);
    const base: any = { org_ref: ref(), owner_version: 1, status: 'active', display_name: 'Acme' };
    await expect(new Model({ ...base, backup_engineers: [
      { principal_ref: 'p:a', engineer_name: 'A', priority: 2 }, { principal_ref: 'p:b', engineer_name: 'B', priority: 1 },
    ] }).validate()).rejects.toThrow('backup priorities');
    await expect(new Model({ ...base, substitutes: [{ principal_ref: 'p:s', engineer_name: 'S', replaces_ref: 'p:a',
      valid_from: new Date('2026-01-02Z'), valid_until: new Date('2026-01-01Z') }] }).validate()).rejects.toThrow('substitute interval');
    await expect(new Model({ ...base, primary_engineer: { principal_ref: 'p:a', engineer_name: 'A' }, backup_engineers: [
      { principal_ref: 'p:a', engineer_name: 'duplicate', priority: 1 },
    ] }).validate()).rejects.toThrow('unique');
    await expect(new Model({ ...base, primary_engineer: { principal_ref: 'p:a', engineer_name: 'A' }, substitutes: [
      { principal_ref: 'p:s', engineer_name: 'S', replaces_ref: 'p:missing', valid_from: new Date('2026-01-01Z'), valid_until: new Date('2026-01-02Z') },
    ] }).validate()).rejects.toThrow('replacement');
  });

  test('model namespace derives only from injected ticket collection', () => {
    const db = mongoose.createConnection();
    const ticket = db.model('InjectedTicket', new mongoose.Schema({}), 'bot_owner_tickets');
    const org = createOrganizationModel(ticket);
    expect(org.collection.name).toBe('bot_owner_tickets_organizations');
    expect(org.schema.get('autoCreate')).toBe(false);
  });

  test('organization modules import without connecting, registering default models, or listening', () => {
    const beforeModels = mongoose.modelNames(); const connect = jest.spyOn(mongoose, 'connect');
    const express = require('express'); const listen = jest.spyOn(express.application, 'listen');
    jest.isolateModules(() => {
      require('../src/organization-domain'); require('../src/organization-auth'); require('../src/organization-model');
      require('../src/organization-repository'); require('../src/organization-router');
    });
    expect(mongoose.connection.readyState).toBe(0);
    expect(mongoose.modelNames()).toEqual(beforeModels);
    expect(connect).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled();
    connect.mockRestore(); listen.mockRestore();
  });

  test('organization list query binds authority, instance, and authorized ids before limit', async () => {
    const orgChain = queryChain([]);
    const organizationModel: any = { find: jest.fn(() => orgChain), findOne: jest.fn() };
    const repo = createMongooseOrganizationRepository({ organizationModel, ticketModel: {} as any, registeredInstance: INSTANCE });
    await repo.listOrganizations([ref(A), ref(B)], 6);
    expect(organizationModel.find.mock.calls[0][0]).toEqual({ 'org_ref.authority': 'support-bot',
      'org_ref.instance': INSTANCE, 'org_ref.id': { $in: [A, B] } });
    expect(orgChain.limit).toHaveBeenCalledWith(7);
  });

  test('repository scopes before limit and excludes legacy-null tickets', async () => {
    const orgChain = queryChain([]); const ticketChain = queryChain([]);
    const organizationModel: any = { find: jest.fn(() => orgChain), findOne: jest.fn(() => queryChain([])) };
    const ticketModel: any = { find: jest.fn(() => ticketChain), findOne: jest.fn(() => queryChain([])) };
    const repo = createMongooseOrganizationRepository({ organizationModel, ticketModel, registeredInstance: INSTANCE });
    await repo.listTicketRefs([ref()], 10);
    expect(ticketModel.find).toHaveBeenCalledWith(expect.objectContaining({
      'organization_ref.authority': 'support-bot', 'organization_ref.instance': INSTANCE,
      'organization_ref.id': { $in: [A] }, organization_owner_version: { $gte: 1 },
    }), expect.not.objectContaining({ text: 1, internalNotes: 1 }));
    expect(ticketChain.limit).toHaveBeenCalledWith(11);
    expect(ticketChain.setOptions).toHaveBeenCalledWith({ strictQuery: false });
    expect(ticketModel.find.mock.calls[0][1]).not.toHaveProperty('assigned_to');
  });

  test('cross-org detail is rejected even if storage returns it', async () => {
    const row = { organization_ref: ref(B), organization_owner_version: 1, ticketId: 7, status: 'open' };
    const ticketModel: any = { findOne: jest.fn(() => queryChain(row as any)), find: jest.fn() };
    const orgModel: any = { findOne: jest.fn(), find: jest.fn() };
    const repo = createMongooseOrganizationRepository({ organizationModel: orgModel, ticketModel, registeredInstance: INSTANCE });
    await expect(repo.getTicketRef(ref(A), 7)).rejects.toThrow('invalid source data');
    expect(ticketModel.findOne.mock.calls[0][0]).toEqual(expect.objectContaining({ 'organization_ref.id': A, ticketId: 7 }));
  });

  test('cross-org list rows are rejected rather than filtered or exposed', async () => {
    const row = { organization_ref: ref(B), organization_owner_version: 1, ticketId: 8, status: 'open' };
    const ticketModel: any = { find: jest.fn(() => queryChain([row])), findOne: jest.fn() };
    const orgModel: any = { findOne: jest.fn(), find: jest.fn() };
    const repo = createMongooseOrganizationRepository({ organizationModel: orgModel, ticketModel, registeredInstance: INSTANCE });
    await expect(repo.listTicketRefs([ref(A)], 10)).rejects.toThrow('invalid source data');
  });

  test('ticket projection never returns stored assignment or raw fields', async () => {
    const row = { organization_ref: ref(), organization_owner_version: 1, ticketId: 8, status: 'open',
      assigned_to: 'telegram-user-123', text: 'private' };
    const ticketModel: any = { find: jest.fn(() => queryChain([row])), findOne: jest.fn() };
    const repo = createMongooseOrganizationRepository({ organizationModel: {} as any, ticketModel, registeredInstance: INSTANCE });
    const result: any = await repo.listTicketRefs([ref()], 10);
    expect(result.items[0]).toEqual({ org_ref: ref(), owner_version: 1, ticket_id: 8, status: 'open' });
    expect(JSON.stringify(result)).not.toMatch(/assigned|telegram|private/);
  });

  test('client projections strip malicious nested/internal fields', () => {
    const output: any = projectOrganization({ org_ref: ref(), owner_version: 2, status: 'active', display_name: 'A',
      personal_phone: 'secret', internal_notes: 'secret', primary_engineer: { engineer_name: 'E', service_contact: 'desk',
        principal_ref: 'opaque', real_telegram_identity: '123', raw_text: 'secret' } }, 'engineer_relationships.read');
    expect(output.primary_engineer).toEqual({ engineer_name: 'E', service_contact: 'desk' });
    expect(JSON.stringify(output)).not.toMatch(/secret|telegram|principal|raw_text|personal_phone/);
  });

  test('workload proof is actor/route bound and replay protected', async () => {
    const key = Buffer.alloc(32, 7); const consumed = new Set<string>(); const now = Date.parse('2026-10-29T12:00:00.000Z');
    const verifier = createHmacWorkloadVerifier({ keys: { k1: key }, allowedKeyIds: ['k1'], audience: 'ainoc-cabinet', sourceInstance: INSTANCE,
      now: () => now, consumeNonce: async (_k, n) => !consumed.has(n) && !!consumed.add(n) });
    const values = { method: 'GET', path: '/internal/v1/organizations', query: '', actor: 'ainoc:principal:7', audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE, timestamp: '2026-10-29T12:00:00.000Z', nonce: 'abcdefghijklmnop', bodyDigest: createHash('sha256').update('').digest('hex') };
    const signature = createHmac('sha256', key).update(canonicalWorkloadRequest(values)).digest('base64url');
    expect(canonicalWorkloadRequest(values)).toBe('3:GET\n26:/internal/v1/organizations\n0:\n17:ainoc:principal:7\n13:ainoc-cabinet\n17:owner-registry-01\n24:2026-10-29T12:00:00.000Z\n16:abcdefghijklmnop\n64:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(signature).toBe('Dj99BAaofEjNY6b1nao93XYLaBOzjMBPf83d0WVa-a4');
    expect(canonicalQuery({ limit: '10', cursor: 'a/b' })).toBe('cursor=a%2Fb&limit=10');
    expect(canonicalQuery({ q: 'a b' })).toBe('q=a%20b');
    expect(canonicalQuery({ q: 'a+b' })).toBe('q=a%2Bb');
    expect(canonicalQuery({ q: "!*'()~" })).toBe('q=%21%2A%27%28%29~');
    expect(canonicalQuery({ q: 'café' })).toBe('q=caf%C3%A9');
    expect(canonicalQuery({ q: ['z', 'a'] })).toBe('q=a&q=z');
    const queryCanonical = canonicalWorkloadRequest({ ...values, query: 'cursor=a%2Fb&limit=10' });
    expect(createHmac('sha256', key).update(queryCanonical).digest('base64url')).toBe('1KU3B1fSTobRZ_sU5xVr-gzrh7j42UcYMV7s9DVvfC8');
    const request: any = { method: values.method, path: values.path, query: '', bodyDigest: values.bodyDigest, headers: {
      'x-ainoc-key-id': 'k1', 'x-ainoc-timestamp': values.timestamp, 'x-ainoc-nonce': values.nonce, 'x-ainoc-actor': values.actor,
      'x-ainoc-audience': values.audience, 'x-ainoc-source-instance': INSTANCE, 'x-ainoc-signature': signature } };
    await expect(verifier.verify(request)).resolves.toEqual({ principal_ref: values.actor });
    await expect(verifier.verify(request)).rejects.toThrow('invalid workload proof');
    await expect(verifier.verify({ ...request, path: '/internal/v1/ticket-refs' })).rejects.toThrow();
    expect(() => createHmacWorkloadVerifier({ keys: { k1: 'short' }, allowedKeyIds: ['k1'], audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE, consumeNonce: async () => true })).toThrow('configuration unavailable');
    expect(() => createHmacWorkloadVerifier({ keys: { k1: key }, allowedKeyIds: ['k1'], audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE })).toThrow('nonce store');
  });

  test('workload proof rejects every changed binding before nonce consumption', async () => {
    const key = Buffer.alloc(32, 7); const now = Date.parse('2026-10-29T12:00:00.000Z'); const consumeNonce = jest.fn().mockResolvedValue(true);
    const verifier = createHmacWorkloadVerifier({ keys: { k1: key }, allowedKeyIds: ['k1'], audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE, now: () => now, consumeNonce });
    const base = { method: 'GET', path: '/internal/v1/organizations', query: 'limit=10', actor: 'ainoc:principal:7', audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE, timestamp: '2026-10-29T12:00:00.000Z', nonce: 'abcdefghijklmnop', bodyDigest: createHash('sha256').update('').digest('hex') };
    const signed = (values: typeof base, overrides: Record<string, string> = {}): any => ({ method: values.method, path: values.path,
      query: values.query, bodyDigest: values.bodyDigest, headers: { 'x-ainoc-key-id': 'k1', 'x-ainoc-timestamp': values.timestamp,
        'x-ainoc-nonce': values.nonce, 'x-ainoc-actor': values.actor, 'x-ainoc-audience': values.audience,
        'x-ainoc-source-instance': values.sourceInstance,
        'x-ainoc-signature': createHmac('sha256', key).update(canonicalWorkloadRequest(values)).digest('base64url'), ...overrides } });
    const baseline = signed(base);
    const changes = [
      { ...baseline, path: '/internal/v1/ticket-refs' }, { ...baseline, query: 'limit=11' },
      signed(base, { 'x-ainoc-actor': 'ainoc:principal:8' }), signed(base, { 'x-ainoc-audience': 'wrong' }),
      signed(base, { 'x-ainoc-source-instance': 'wrong' }), signed(base, { 'x-ainoc-key-id': 'k2' }),
      signed(base, { 'x-ainoc-timestamp': '2026-10-29T11:00:00.000Z' }), signed(base, { 'x-ainoc-actor': 'bad actor' }),
      signed(base, { 'x-ainoc-signature': 'not-a-signature' }),
    ];
    for (const changed of changes) await expect(verifier.verify(changed)).rejects.toThrow();
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  test('real Express stack is GET-only and maps proof, nonce-store, deny, and authz outages without reads', async () => {
    const express = require('express');
    const repository: any = { listOrganizations: jest.fn(), getOrganization: jest.fn(), listTicketRefs: jest.fn(), getTicketRef: jest.fn() };
    const decision = { allowed: false, denied: true, principal_enabled: true, rbac_enabled: true, org_refs: [ref()], scope_version: 's1' };
    const centralAuthorizer = { authorize: jest.fn().mockResolvedValue(decision) };
    const makeApp = (workloadVerifier: any, authorizer: any = centralAuthorizer) => { const app = express(); app.use(createOrganizationReadRouter({
      sourceInstance: INSTANCE, repository, cursorCodec: createCursorCodec(Buffer.alloc(32, 3)), workloadVerifier, centralAuthorizer: authorizer })); return app; };
    const headVerifier = { verify: jest.fn() };
    expect((await inject(makeApp(headVerifier), 'HEAD', '/internal/v1/organizations')).status).toBe(405);
    expect(headVerifier.verify).not.toHaveBeenCalled();
    const invalid = { verify: jest.fn().mockRejectedValue(new Error('invalid workload proof')) };
    expect(await inject(makeApp(invalid), 'GET', '/internal/v1/organizations')).toEqual({
      status: 401, body: { schema_version: 1, error: 'unauthorized' } });
    const unavailableVerifier = createHmacWorkloadVerifier({ keys: { k1: Buffer.alloc(32, 1) }, allowedKeyIds: ['k1'],
      audience: 'a', sourceInstance: INSTANCE, consumeNonce: async () => { throw new Error('store down'); } });
    const timestamp = new Date().toISOString(); const values = { method: 'GET', path: '/internal/v1/organizations', query: '', actor: 'p:1',
      audience: 'a', sourceInstance: INSTANCE, timestamp, nonce: 'abcdefghijklmnop', bodyDigest: createHash('sha256').update('').digest('hex') };
    const headers = { 'x-ainoc-key-id': 'k1', 'x-ainoc-timestamp': timestamp, 'x-ainoc-nonce': values.nonce, 'x-ainoc-actor': values.actor,
      'x-ainoc-audience': values.audience, 'x-ainoc-source-instance': INSTANCE,
      'x-ainoc-signature': createHmac('sha256', Buffer.alloc(32, 1)).update(canonicalWorkloadRequest(values)).digest('base64url') };
    expect(await inject(makeApp(unavailableVerifier), 'GET', '/internal/v1/organizations', headers)).toEqual({
      status: 503, body: { schema_version: 1, error: 'source unavailable' } });
    const valid = { verify: jest.fn().mockResolvedValue({ principal_ref: 'p:1' }) };
    expect((await inject(makeApp(valid), 'GET', '/internal/v1/organizations')).status).toBe(403);
    expect((await inject(makeApp(valid, unavailableCentralAuthorizer), 'GET', '/internal/v1/organizations')).status).toBe(503);
    expect(repository.listOrganizations).not.toHaveBeenCalled();
  });

  test('real Express stack verifies HMAC before fresh authz and scoped ticket reads', async () => {
    const express = require('express'); const key = Buffer.alloc(32, 5); const order: string[] = []; let nonceCounter = 0;
    const repository: any = {
      listOrganizations: jest.fn(async () => { order.push('repository'); return { items: [], has_more: false }; }),
      getOrganization: jest.fn(), listTicketRefs: jest.fn(async () => ({ items: [], has_more: false })),
      getTicketRef: jest.fn(async (_ref: any, id: number) => id === 7 ? { org_ref: ref(), owner_version: 3, ticket_id: 7, status: 'open' } : null),
    };
    let scopeVersion = 'scope-1';
    const centralAuthorizer = { authorize: jest.fn(async () => { order.push('authorizer'); return { allowed: true, denied: false,
      principal_enabled: true, rbac_enabled: true, org_refs: [ref()], scope_version: scopeVersion }; }) };
    const verifier = createHmacWorkloadVerifier({ keys: { k1: key }, allowedKeyIds: ['k1'], audience: 'ainoc-cabinet',
      sourceInstance: INSTANCE, consumeNonce: async () => { order.push('verifier'); return true; } });
    const app = express(); app.use(createOrganizationReadRouter({ sourceInstance: INSTANCE, repository,
      cursorCodec: createCursorCodec(Buffer.alloc(32, 3)), workloadVerifier: verifier, centralAuthorizer }));
    const signedHeaders = (path: string, query = '') => {
      const timestamp = new Date().toISOString(); const nonce = `nonce-for-request-${++nonceCounter}`;
      const values = { method: 'GET', path, query, actor: 'ainoc:principal:7', audience: 'ainoc-cabinet', sourceInstance: INSTANCE,
        timestamp, nonce, bodyDigest: createHash('sha256').update('').digest('hex') };
      return { 'x-ainoc-key-id': 'k1', 'x-ainoc-timestamp': timestamp, 'x-ainoc-nonce': nonce, 'x-ainoc-actor': values.actor,
        'x-ainoc-audience': values.audience, 'x-ainoc-source-instance': INSTANCE,
        'x-ainoc-signature': createHmac('sha256', key).update(canonicalWorkloadRequest(values)).digest('base64url') };
    };
    const list = await inject(app, 'GET', '/internal/v1/organizations?limit=2', signedHeaders('/internal/v1/organizations', 'limit=2'));
    expect(list.status).toBe(200); expect(order).toEqual(['verifier', 'authorizer', 'repository']);
    expect(repository.listOrganizations).toHaveBeenCalledWith([ref()], 2, undefined);
    const invalid = await inject(app, 'GET', '/internal/v1/organizations?unknown=x',
      signedHeaders('/internal/v1/organizations', 'unknown=x'));
    expect(invalid).toEqual({ status: 400, body: { schema_version: 1, error: 'invalid request' } });
    const ticketPath = `/internal/v1/organizations/${A}/ticket-refs/7`;
    const ticket = await inject(app, 'GET', ticketPath, signedHeaders(ticketPath));
    expect(ticket.status).toBe(200); expect(ticket.body.item).toEqual({ org_ref: ref(), owner_version: 3, ticket_id: 7, status: 'open' });
    const missingPath = `/internal/v1/organizations/${A}/ticket-refs/8`;
    expect((await inject(app, 'GET', missingPath, signedHeaders(missingPath))).status).toBe(404);
    const codec = createCursorCodec(Buffer.alloc(32, 3));
    const cursor = codec.encode({ actor: 'ainoc:principal:7', source: `support-bot:${INSTANCE}`, filter: 'organizations:all',
      scope_version: 'scope-1', after: A, expires_at: 0 });
    scopeVersion = 'scope-2'; const query = canonicalQuery({ cursor });
    const changedScope = await inject(app, 'GET', `/internal/v1/organizations?cursor=${encodeURIComponent(cursor)}`,
      signedHeaders('/internal/v1/organizations', query));
    expect(changedScope.status).toBe(400);
  });

  test('cursor binds actor/source/filter/scope and expires', () => {
    let now = 1000; const codec = createCursorCodec(Buffer.alloc(32, 9), () => now, 100);
    const binding = { actor: 'p:1', source: `support-bot:${INSTANCE}`, filter: 'organizations:all', scope_version: 'v1' };
    const token = codec.encode({ ...binding, after: A, expires_at: 1100 });
    expect(codec.decode(token, binding).after).toBe(A);
    expect(() => codec.decode(token, { ...binding, actor: 'p:2' })).toThrow('invalid cursor');
    expect(() => codec.decode(token, { ...binding, source: 'support-bot:other' })).toThrow('invalid cursor');
    expect(() => codec.decode(token, { ...binding, filter: 'tickets:all' })).toThrow('invalid cursor');
    expect(() => codec.decode(token, { ...binding, scope_version: 'v2' })).toThrow('invalid cursor');
    expect(() => codec.decode(token.slice(0, -1) + 'x', binding)).toThrow('invalid cursor');
    now = 1101; expect(() => codec.decode(token, binding)).toThrow('invalid cursor');
  });

  test('default central authorizer is unavailable, never allow-by-default', async () => {
    await expect(unavailableCentralAuthorizer.authorize({ principal_ref: 'p:1', permission: 'organizations.read' })).rejects.toThrow();
  });

  test('router factory requires both trust seams and validates registered instance', () => {
    const repository: any = {};
    const cursorCodec: any = {};
    expect(() => createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec })).toThrow('workload verifier');
    expect(() => createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec,
      workloadVerifier: { verify: jest.fn() } })).toThrow('central authorizer');
    expect(() => createOrganizationReadRouter({ sourceInstance: '', repository, cursorCodec,
      workloadVerifier: { verify: jest.fn() }, centralAuthorizer: unavailableCentralAuthorizer })).toThrow('source instance');
  });

  test('valid service proof is insufficient: central deny makes zero repository reads', async () => {
    const layers: { uses: any[]; gets: Record<string, any> } = { uses: [], gets: {} };
    const fakeRouter: any = { use: jest.fn((fn) => layers.uses.push(fn)), get: jest.fn((path, fn) => { layers.gets[path] = fn; }) };
    const express = require('express'); const routerSpy = jest.spyOn(express, 'Router').mockReturnValue(fakeRouter);
    const repository: any = { listOrganizations: jest.fn(), getOrganization: jest.fn(), listTicketRefs: jest.fn(), getTicketRef: jest.fn() };
    const centralAuthorizer: any = { authorize: jest.fn().mockResolvedValue({ allowed: false, denied: true, principal_enabled: true,
      rbac_enabled: true, org_refs: [ref()], scope_version: 'scope-1' }) };
    createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec: createCursorCodec(Buffer.alloc(32, 3)),
      workloadVerifier: { verify: jest.fn().mockResolvedValue({ principal_ref: 'ainoc:principal:7' }) }, centralAuthorizer });
    const req: any = { method: 'GET', baseUrl: '', path: '/internal/v1/organizations', query: {}, headers: {} };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await layers.uses[0](req, res, jest.fn());
    await layers.gets['/internal/v1/organizations'](req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(centralAuthorizer.authorize).toHaveBeenCalledWith(expect.objectContaining({ permission: 'organizations.read' }));
    expect(repository.listOrganizations).not.toHaveBeenCalled();
    routerSpy.mockRestore();
  });

  test('malformed central response is 503 and never reaches repository', async () => {
    const layers: { uses: any[]; gets: Record<string, any> } = { uses: [], gets: {} };
    const fakeRouter: any = { use: jest.fn((fn) => layers.uses.push(fn)), get: jest.fn((path, fn) => { layers.gets[path] = fn; }) };
    const express = require('express'); const routerSpy = jest.spyOn(express, 'Router').mockReturnValue(fakeRouter);
    const repository: any = { listOrganizations: jest.fn(), getOrganization: jest.fn(), listTicketRefs: jest.fn(), getTicketRef: jest.fn() };
    const centralAuthorizer: any = { authorize: jest.fn().mockResolvedValue({ allowed: 'true', principal_enabled: true,
      rbac_enabled: true, org_refs: [ref()], scope_version: 'scope-1' }) };
    createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec: createCursorCodec(Buffer.alloc(32, 3)),
      workloadVerifier: { verify: jest.fn().mockResolvedValue({ principal_ref: 'ainoc:principal:7' }) }, centralAuthorizer });
    const req: any = { method: 'GET', baseUrl: '', path: '/internal/v1/organizations', query: {}, headers: {},
      organizationActor: { principal_ref: 'ainoc:principal:7' } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await layers.gets['/internal/v1/organizations'](req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(repository.listOrganizations).not.toHaveBeenCalled();
    routerSpy.mockRestore();
  });

  test('authorized refs and limit are passed to repository before list response', async () => {
    const layers: { uses: any[]; gets: Record<string, any> } = { uses: [], gets: {} };
    const fakeRouter: any = { use: jest.fn((fn) => layers.uses.push(fn)), get: jest.fn((path, fn) => { layers.gets[path] = fn; }) };
    const express = require('express'); const routerSpy = jest.spyOn(express, 'Router').mockReturnValue(fakeRouter);
    const repository: any = { listOrganizations: jest.fn().mockResolvedValue({ items: [], has_more: false }), getOrganization: jest.fn(),
      listTicketRefs: jest.fn(), getTicketRef: jest.fn() };
    const centralAuthorizer: any = { authorize: jest.fn().mockResolvedValue({ allowed: true, denied: false, principal_enabled: true,
      rbac_enabled: true, org_refs: [ref()], scope_version: 'scope-1' }) };
    createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec: createCursorCodec(Buffer.alloc(32, 3)),
      workloadVerifier: { verify: jest.fn() }, centralAuthorizer });
    const req: any = { query: { limit: '7' }, organizationActor: { principal_ref: 'ainoc:principal:7' } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await layers.gets['/internal/v1/organizations'](req, res);
    expect(repository.listOrganizations).toHaveBeenCalledWith([ref()], 7, undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 1, source_status: 'fresh', scope_version: 'scope-1' }));
    await layers.gets['/internal/v1/organizations']({ ...req, query: { unexpected: 'x' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(repository.listOrganizations).toHaveBeenCalledTimes(1);
    routerSpy.mockRestore();
  });

  test('detail reauthorizes exact org and cross-org deny performs no read', async () => {
    const layers: { uses: any[]; gets: Record<string, any> } = { uses: [], gets: {} };
    const fakeRouter: any = { use: jest.fn((fn) => layers.uses.push(fn)), get: jest.fn((path, fn) => { layers.gets[path] = fn; }) };
    const express = require('express'); const routerSpy = jest.spyOn(express, 'Router').mockReturnValue(fakeRouter);
    const repository: any = { listOrganizations: jest.fn(), getOrganization: jest.fn(), listTicketRefs: jest.fn(), getTicketRef: jest.fn() };
    const centralAuthorizer: any = { authorize: jest.fn().mockResolvedValue({ allowed: true, denied: false, principal_enabled: true,
      rbac_enabled: true, org_refs: [ref(B)], scope_version: 'scope-2' }) };
    createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec: createCursorCodec(Buffer.alloc(32, 3)),
      workloadVerifier: { verify: jest.fn() }, centralAuthorizer });
    const req: any = { query: {}, params: { organizationId: A }, organizationActor: { principal_ref: 'ainoc:principal:7' } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await layers.gets['/internal/v1/organizations/:organizationId'](req, res);
    expect(centralAuthorizer.authorize).toHaveBeenCalledWith(expect.objectContaining({ requested_org: ref(A) }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(repository.getOrganization).not.toHaveBeenCalled();
    routerSpy.mockRestore();
  });
});
