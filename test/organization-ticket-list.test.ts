import { createHash, createHmac } from 'crypto';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import { canonicalQuery, canonicalWorkloadRequest, createCursorCodec, createHmacWorkloadVerifier } from '../src/organization-auth';
import { createOrganizationReadRouter } from '../src/organization-router';
import { createMongooseOrganizationRepository } from '../src/organization-repository';
const INSTANCE = 'owner-registry-01';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ref = (id = A) => ({ authority: 'support-bot' as const, instance: INSTANCE, id });
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


function fixture() {
  let now = Date.now(); let counter = 0;
  const order: string[] = []; const key = Buffer.alloc(32, 5);
  const codec = createCursorCodec(Buffer.alloc(32, 9), () => now, 1000);
  const decision: any = { allowed: true, denied: false, principal_enabled: true, rbac_enabled: true,
    org_refs: [ref(), ref(B)], scope_version: 'scope-1' };
  const authorize = jest.fn(async () => { order.push('authz'); return decision; });
  const consumeNonce = jest.fn(async () => { order.push('nonce'); return true; });
  const repository: any = { listTicketRefs: jest.fn(async () => { order.push('repo'); return { items: [], has_more: false }; }) };
  const app = require('express')();
  app.use(createOrganizationReadRouter({ sourceInstance: INSTANCE, repository, cursorCodec: codec,
    centralAuthorizer: { authorize }, workloadVerifier: createHmacWorkloadVerifier({ keys: { k: key }, allowedKeyIds: ['k'],
      audience: 'cabinet', sourceInstance: INSTANCE, now: () => now, consumeNonce }) }));
  const request = (query: Record<string, any> = {}, id = A, actor = 'p:1', method = 'GET', overrides = {}) => {
    const path = `/internal/v1/organizations/${id}/ticket-refs`; const q = canonicalQuery(query);
    const timestamp = new Date(now).toISOString(); const nonce = `unique-request-nonce-${++counter}`;
    const values = { method, path, query: q, actor, audience: 'cabinet', sourceInstance: INSTANCE, timestamp, nonce,
      bodyDigest: createHash('sha256').update('').digest('hex') };
    return inject(app, method, path + (q ? '?' + q : ''), { 'x-ainoc-key-id': 'k', 'x-ainoc-actor': actor,
      'x-ainoc-audience': 'cabinet', 'x-ainoc-source-instance': INSTANCE, 'x-ainoc-timestamp': timestamp,
      'x-ainoc-nonce': nonce, 'x-ainoc-signature': createHmac('sha256', key).update(canonicalWorkloadRequest(values)).digest('base64url'), ...overrides });
  };
  const binding = { actor: 'p:1', source: `support-bot:${INSTANCE}`,
    filter: JSON.stringify(['ticket-refs', 'support-bot', INSTANCE, A]), scope_version: 'scope-1' };
  return { request, repository, authorize, consumeNonce, decision, order, codec, binding, advance: () => { now += 1001; } };
}
const ticket = (id = 7) => ({ org_ref: ref(), owner_version: 2, ticket_id: id, status: 'open' });

test('exact list: HMAC/nonce then fresh requested-org authz then one-ref read, empty envelope', async () => {
  const f = fixture(); const result = await f.request({ limit: '2' });
  expect(result.status).toBe(200); expect(f.order).toEqual(['nonce', 'authz', 'repo']);
  expect(f.authorize).toHaveBeenCalledWith({ principal_ref: 'p:1', permission: 'ticket_refs.read', requested_org: ref() });
  expect(f.repository.listTicketRefs).toHaveBeenCalledWith([ref()], 2, undefined);
  expect(result.body).toMatchObject({ schema_version: 1, source: { authority: 'support-bot', instance: INSTANCE },
    scope_version: 'scope-1', source_status: 'fresh', items: [], page: { limit: 2, has_more: false } });
});
test('page roundtrip and DTO allowlist preserve ticket stamp independently of current org version', async () => {
  const f = fixture();
  f.repository.listTicketRefs.mockResolvedValueOnce({ items: [{ ...ticket(), assigned_to: 'secret', history: 'secret', telegramId: 'secret' }], has_more: true, next_key: '7' });
  const first = await f.request({ limit: '1' }); expect(first.status).toBe(200);
  expect(first.body.items).toEqual([ticket()]); expect(first.body).not.toHaveProperty('owner_version');
  const second = await f.request({ limit: '1', cursor: first.body.page.next_cursor });
  expect(second.status).toBe(200); expect(f.repository.listTicketRefs).toHaveBeenLastCalledWith([ref()], 1, 7);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
test.each(['org', 'actor', 'scope', 'source', 'expiry', 'tamper', 'zero', 'unsafe', 'decimal'])('cursor rejects %s before repository access', async (change) => {
  const f = fixture(); let binding = f.binding; let after = '7';
  if (change === 'source') binding = { ...binding, source: 'support-bot:other' };
  if (change === 'zero') after = '0'; if (change === 'unsafe') after = '9007199254740992'; if (change === 'decimal') after = '1.5';
  let cursor = f.codec.encode({ ...binding, after, expires_at: 0 });
  if (change === 'scope') f.decision.scope_version = 'scope-2';
  if (change === 'expiry') f.advance(); if (change === 'tamper') cursor += 'x';
  expect((await f.request({ cursor }, change === 'org' ? B : A, change === 'actor' ? 'p:2' : 'p:1')).status).toBe(400);
  expect(f.repository.listTicketRefs).not.toHaveBeenCalled();
});
test.each([
  [{ allowed: false }, 403], [{ denied: true }, 403], [{ principal_enabled: false }, 403], [{ rbac_enabled: false }, 403],
  [{ org_refs: [ref(B)] }, 403], [{ allowed: 'true' }, 503], [{ denied: 'false' }, 503], [{ principal_enabled: 1 }, 503],
  [{ rbac_enabled: 'true' }, 503], [{ scope_version: null }, 503], [{ org_refs: [{ ...ref(), instance: 'wrong' }] }, 503],
])('authz fails closed %j', async (patch, status) => {
  const f = fixture(); Object.assign(f.decision, patch);
  expect((await f.request()).status).toBe(status); expect(f.repository.listTicketRefs).not.toHaveBeenCalled();
});
test('authz/nonce/source outages and bad proof use bounded errors without unintended reads', async () => {
  const f = fixture(); f.authorize.mockRejectedValueOnce(new Error('secret'));
  expect(await f.request()).toEqual({ status: 503, body: { schema_version: 1, error: 'source unavailable' } });
  f.consumeNonce.mockRejectedValueOnce(new Error('secret')); expect((await f.request()).status).toBe(503);
  f.consumeNonce.mockResolvedValueOnce(false); expect((await f.request()).status).toBe(401);
  expect((await f.request({}, A, 'p:1', 'GET', { 'x-ainoc-signature': 'bad' })).status).toBe(401);
  expect(f.repository.listTicketRefs).not.toHaveBeenCalled();
  f.repository.listTicketRefs.mockRejectedValueOnce(new Error('secret')); expect((await f.request()).status).toBe(503);
});
test.each(['HEAD', 'POST', 'PUT', 'DELETE'])('%s refused before verifier', async (method) => {
  const f = fixture(); expect((await f.request({}, A, 'p:1', method)).status).toBe(405);
  expect(f.consumeNonce).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
});
test.each([{ extra: 'x' }, { limit: ['1', '2'] }, { cursor: '' }, { cursor: ['a', 'b'] }, { limit: '101' }, { limit: '0' }])('invalid query %j', async (query) => {
  const f = fixture(); expect((await f.request(query)).status).toBe(400); expect(f.repository.listTicketRefs).not.toHaveBeenCalled();
});
test('malformed org denied before authz; cross-org source rows fail whole page', async () => {
  const f = fixture(); expect((await f.request({}, 'not-a-uuid')).status).toBe(400); expect(f.authorize).not.toHaveBeenCalled();
  f.repository.listTicketRefs.mockResolvedValueOnce({ items: [ticket(), { ...ticket(8), org_ref: ref(B) }], has_more: false });
  expect(await f.request()).toEqual({ status: 503, body: { schema_version: 1, error: 'source unavailable' } });
});
test('actual Mongoose query casting retains exact predicates under strictQuery true without DB execution', async () => {
  const db = mongoose.createConnection();
  const model = db.model('ExactOrgTicketQuery', new mongoose.Schema({ ticketId: Number, status: String }, { strictQuery: true }));
  let captured: any;
  const exec = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function(this: any) {
    this.cast(this.model); captured = { filter: this.getFilter(), options: this.getOptions(), projection: this.projection() }; return [];
  } as any);
  try {
    const repo = createMongooseOrganizationRepository({ organizationModel: {} as any, ticketModel: model, registeredInstance: INSTANCE });
    await repo.listTicketRefs([ref()], 2, 7);
    expect(captured.filter).toEqual({ 'organization_ref.authority': 'support-bot', 'organization_ref.instance': INSTANCE,
      'organization_ref.id': { $in: [A] }, organization_owner_version: { $gte: 1 }, ticketId: { $gt: 7 } });
    expect(captured.options).toMatchObject({ strictQuery: false, sort: { ticketId: 1 }, limit: 3 });
    expect(Object.keys(captured.projection).sort()).toEqual(['_id', 'organization_owner_version', 'organization_ref', 'status', 'ticketId']);
  } finally { exec.mockRestore(); }
});
