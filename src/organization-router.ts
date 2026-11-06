import { createHash } from 'crypto';
import { parseOrgRef, sameOrgRef, validateInstance, type OrgRef } from './organization-domain';
import { canonicalQuery, WorkloadVerifierUnavailableError, type CursorCodec, type WorkloadVerifier } from './organization-auth';
import type { OrganizationReadRepository } from './organization-repository';

export type OrganizationPermission = 'organizations.read' | 'contacts.read' | 'engineer_relationships.read' | 'ticket_refs.read' | 'staff_internal.read';
export interface AuthorizationDecision { allowed: boolean; principal_enabled: boolean; rbac_enabled: boolean; denied?: boolean; org_refs: OrgRef[]; scope_version: string; }
export interface CentralAuthorizer { authorize(input: { principal_ref: string; permission: OrganizationPermission; requested_org?: OrgRef }): Promise<AuthorizationDecision>; }
export const unavailableCentralAuthorizer: CentralAuthorizer = { async authorize() { throw new Error('central authorization unavailable'); } };

function validateDecision(value: unknown, instance: string): { decision: AuthorizationDecision; refs: OrgRef[] } {
  if (!value || typeof value !== 'object') throw new Error('invalid authorization response');
  const decision = value as AuthorizationDecision;
  if (typeof decision.allowed !== 'boolean' || typeof decision.principal_enabled !== 'boolean' ||
      typeof decision.rbac_enabled !== 'boolean' || (decision.denied !== undefined && typeof decision.denied !== 'boolean') ||
      !Array.isArray(decision.org_refs) || typeof decision.scope_version !== 'string' || !decision.scope_version) {
    throw new Error('invalid authorization response');
  }
  return { decision, refs: decision.org_refs.map((ref) => parseOrgRef(ref, instance)) };
}

function clientEngineer(v: any) { return v ? { engineer_name: String(v.engineer_name || '').slice(0, 256), service_contact: v.service_contact ? String(v.service_contact).slice(0, 256) : null } : null; }
export function projectOrganization(row: any, permission: OrganizationPermission) {
  const base: any = { org_ref: row.org_ref, owner_version: row.owner_version, status: row.status,
    display_name: String(row.display_name || '').slice(0, 256), service_contact: row.service_contact ? String(row.service_contact).slice(0, 256) : null };
  if (permission === 'contacts.read') return { org_ref: base.org_ref, owner_version: base.owner_version, display_name: base.display_name, service_contact: base.service_contact };
  if (permission === 'engineer_relationships.read') return { org_ref: base.org_ref, owner_version: base.owner_version,
    primary_engineer: clientEngineer(row.primary_engineer), backup_engineers: (row.backup_engineers || []).map(clientEngineer),
    substitutes: (row.substitutes || []).map((s: any) => ({ ...clientEngineer(s), valid_from: new Date(s.valid_from).toISOString(), valid_until: new Date(s.valid_until).toISOString() })) };
  return base;
}
type Request = any;
type Response = any;
type RouterInstance = any;
function fail(res: Response, status: number, error: string) { res.status(status).json({ schema_version: 1, error }); }
function sourceEnvelope(instance: string, data: object) { return { schema_version: 1, source: { authority: 'support-bot', instance },
  as_of: new Date().toISOString(), source_status: 'fresh', ...data }; }
function strictLimit(req: Request): number { const keys = Object.keys(req.query); if (keys.some((k) => !['limit', 'cursor'].includes(k))) throw new Error('invalid request');
  const raw = req.query.limit === undefined ? '50' : String(req.query.limit); if (!/^\d+$/.test(raw)) throw new Error('invalid request'); const n = Number(raw);
  if (n < 1 || n > 100) throw new Error('invalid request'); return n; }

export function createOrganizationReadRouter(config: {
  sourceInstance: string; repository: OrganizationReadRepository; workloadVerifier?: WorkloadVerifier;
  centralAuthorizer?: CentralAuthorizer; cursorCodec: CursorCodec;
}): RouterInstance {
  if (!config.workloadVerifier) throw new Error('workload verifier is required');
  if (!config.centralAuthorizer) throw new Error('central authorizer is required');
  const sourceInstance = validateInstance(config.sourceInstance);
  // Express is loaded only when the factory is called; importing this module has no runtime side effects.
  const router = require('express').Router();
  router.use(async (req: any, res: any, next: any) => {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    try {
      const query = canonicalQuery(req.query);
      req.organizationActor = await config.workloadVerifier!.verify({ method: req.method, path: req.baseUrl + req.path, query,
        headers: req.headers, bodyDigest: createHash('sha256').update('').digest('hex') }); next();
    } catch (error) { fail(res, error instanceof WorkloadVerifierUnavailableError ? 503 : 401,
      error instanceof WorkloadVerifierUnavailableError ? 'source unavailable' : 'unauthorized'); }
  });
  const list = (kind: 'organizations' | 'tickets', permission: OrganizationPermission) => async (req: any, res: Response) => {
    try {
      const limit = strictLimit(req); const actor = req.organizationActor.principal_ref;
      let decision: AuthorizationDecision; try { decision = await config.centralAuthorizer!.authorize({ principal_ref: actor, permission }); }
      catch { return fail(res, 503, 'source unavailable'); }
      let refs: OrgRef[]; try { refs = validateDecision(decision, sourceInstance).refs; }
      catch { return fail(res, 503, 'source unavailable'); }
      if (decision.allowed !== true || decision.denied === true || decision.principal_enabled !== true || decision.rbac_enabled !== true) {
        return fail(res, 403, 'forbidden');
      }
      const binding = { actor, source: `support-bot:${sourceInstance}`, filter: `${kind}:all`, scope_version: decision.scope_version };
      let after: string | undefined; if (req.query.cursor) after = config.cursorCodec.decode(String(req.query.cursor), binding).after;
      let page; try { page = kind === 'organizations' ? await config.repository.listOrganizations(refs, limit, after) :
        await config.repository.listTicketRefs(refs, limit, after ? Number(after) : undefined); }
      catch { return fail(res, 503, 'source unavailable'); }
      const items = kind === 'organizations' ? page.items.map((r) => projectOrganization(r, permission)) : page.items;
      const next_cursor = page.next_key ? config.cursorCodec.encode({ ...binding, after: page.next_key, expires_at: 0 }) : undefined;
      res.json(sourceEnvelope(sourceInstance, { scope_version: decision.scope_version, items, page: { limit, has_more: page.has_more, next_cursor } }));
    } catch (e) { fail(res, 400, 'invalid request'); }
  };
  const detailAuth = async (req: any, res: Response, permission: OrganizationPermission, read: (ref: OrgRef) => Promise<any>) => {
    let ref: OrgRef; try { if (Object.keys(req.query).length) throw new Error(); ref = parseOrgRef({ authority: 'support-bot', instance: sourceInstance, id: req.params.organizationId }, sourceInstance); }
    catch { return fail(res, 400, 'invalid request'); }
    let decision: AuthorizationDecision; try { decision = await config.centralAuthorizer!.authorize({ principal_ref: req.organizationActor.principal_ref, permission, requested_org: ref }); }
    catch { return fail(res, 503, 'source unavailable'); }
    let authorizedRefs: OrgRef[]; try { authorizedRefs = validateDecision(decision, sourceInstance).refs; }
    catch { return fail(res, 503, 'source unavailable'); }
    if (decision.allowed !== true || decision.denied === true || decision.principal_enabled !== true || decision.rbac_enabled !== true) {
      return fail(res, 403, 'forbidden');
    }
    if (!authorizedRefs.some((r) => r.authority === ref.authority && r.instance === ref.instance && r.id === ref.id)) return fail(res, 403, 'forbidden');
    try { const item = await read(ref); if (!item) return fail(res, 404, 'not found'); res.json(sourceEnvelope(sourceInstance,
      { owner_version: item.owner_version, item: permission === 'ticket_refs.read' ? item : projectOrganization(item, permission) })); }
    catch { fail(res, 503, 'source unavailable'); }
  };
  router.get('/internal/v1/organizations', list('organizations', 'organizations.read'));
  router.get('/internal/v1/organizations/:organizationId', (req: any, res: any) => detailAuth(req, res, 'organizations.read', (r) => config.repository.getOrganization(r)));
  router.get('/internal/v1/organizations/:organizationId/contacts', (req: any, res: any) => detailAuth(req, res, 'contacts.read', (r) => config.repository.getOrganization(r)));
  router.get('/internal/v1/organizations/:organizationId/engineer-relationships', (req: any, res: any) => detailAuth(req, res, 'engineer_relationships.read', (r) => config.repository.getOrganization(r)));
  router.get('/internal/v1/ticket-refs', list('tickets', 'ticket_refs.read'));
  router.get('/internal/v1/organizations/:organizationId/ticket-refs', async (req: any, res: Response) => {
    let ref: OrgRef; let limit: number;
    try {
      limit = strictLimit(req);
      if (Object.values(req.query).some((v) => typeof v !== 'string')) throw new Error();
      if (req.query.cursor !== undefined && !req.query.cursor) throw new Error();
      ref = parseOrgRef({ authority: 'support-bot', instance: sourceInstance, id: req.params.organizationId }, sourceInstance);
      if (ref.id !== req.params.organizationId) throw new Error();
    } catch { return fail(res, 400, 'invalid request'); }
    const actor = req.organizationActor.principal_ref;
    let decision: AuthorizationDecision; let refs: OrgRef[];
    try {
      const validated = validateDecision(await config.centralAuthorizer!.authorize({
        principal_ref: actor, permission: 'ticket_refs.read', requested_org: ref,
      }), sourceInstance);
      decision = validated.decision; refs = validated.refs;
    } catch { return fail(res, 503, 'source unavailable'); }
    if (decision.allowed !== true || decision.denied === true || decision.principal_enabled !== true ||
        decision.rbac_enabled !== true || !refs.some((r) => sameOrgRef(r, ref))) return fail(res, 403, 'forbidden');
    const binding = { actor, source: `support-bot:${sourceInstance}`,
      filter: JSON.stringify(['ticket-refs', ref.authority, ref.instance, ref.id]), scope_version: decision.scope_version };
    let after: number | undefined;
    try {
      if (req.query.cursor !== undefined) {
        const key = config.cursorCodec.decode(req.query.cursor, binding).after;
        if (!/^[1-9]\d{0,15}$/.test(key) || !Number.isSafeInteger(Number(key))) throw new Error();
        after = Number(key);
      }
    } catch { return fail(res, 400, 'invalid request'); }
    try {
      const page = await config.repository.listTicketRefs([ref], limit, after);
      // Reject the entire response on a broken source boundary; never return a partial page.
      const items = page.items.map((row) => {
        const org = parseOrgRef(row.org_ref, sourceInstance);
        if (!sameOrgRef(org, ref) || !Number.isSafeInteger(row.owner_version) || row.owner_version < 1 ||
            !Number.isSafeInteger(row.ticket_id) || row.ticket_id < 1 || typeof row.status !== 'string') throw new Error();
        return { org_ref: org, owner_version: row.owner_version, ticket_id: row.ticket_id, status: row.status };
      });
      if (items.length > limit || items.some((row, i) => row.ticket_id <= (i ? items[i - 1].ticket_id : after ?? 0)) ||
          typeof page.has_more !== 'boolean' || (page.has_more && (!items.length || page.next_key !== String(items.at(-1)!.ticket_id)))) throw new Error();
      const next_cursor = page.has_more ? config.cursorCodec.encode({ ...binding, after: page.next_key!, expires_at: 0 }) : undefined;
      return res.json(sourceEnvelope(sourceInstance, { scope_version: decision.scope_version, items,
        page: { limit, has_more: page.has_more, next_cursor } }));
    } catch { return fail(res, 503, 'source unavailable'); }
  });

  router.get('/internal/v1/organizations/:organizationId/ticket-refs/:ticketId', (req: any, res: any) => {
    const id = String(req.params.ticketId); if (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) return fail(res, 400, 'invalid request');
    return detailAuth(req, res, 'ticket_refs.read', (r) => config.repository.getTicketRef(r, Number(id)));
  });
  router.use((_req: any, res: any) => fail(res, 404, 'not found'));
  return router;
}
