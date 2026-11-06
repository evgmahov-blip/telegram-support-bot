import type { Model } from 'mongoose';
import { parseOrgRef, sameOrgRef, validateInstance, type OrgRef } from './organization-domain';
import type { OrganizationRecord } from './organization-model';

export interface Page<T> { items: T[]; has_more: boolean; next_key?: string; }
export interface TicketRef { org_ref: OrgRef; owner_version: number; ticket_id: number; status: string; }
export interface OrganizationReadRepository {
  listOrganizations(refs: OrgRef[], limit: number, afterId?: string): Promise<Page<OrganizationRecord>>;
  getOrganization(ref: OrgRef): Promise<OrganizationRecord | null>;
  listTicketRefs(refs: OrgRef[], limit: number, afterTicket?: number): Promise<Page<TicketRef>>;
  getTicketRef(ref: OrgRef, ticketId: number): Promise<TicketRef | null>;
}

function exactOrgQuery(ref: OrgRef): Record<string, unknown> {
  return { 'org_ref.authority': ref.authority, 'org_ref.instance': ref.instance, 'org_ref.id': ref.id };
}
// Nested allowlist: do not even fetch principal refs, Telegram identities, or future internal fields.
const ORG_PROJECTION = { _id: 0, org_ref: 1, owner_version: 1, status: 1, display_name: 1, service_contact: 1,
  'primary_engineer.engineer_name': 1, 'primary_engineer.service_contact': 1,
  'backup_engineers.engineer_name': 1, 'backup_engineers.service_contact': 1, 'backup_engineers.priority': 1,
  'substitutes.engineer_name': 1, 'substitutes.service_contact': 1, 'substitutes.valid_from': 1, 'substitutes.valid_until': 1 } as const;
const TICKET_PROJECTION = { _id: 0, organization_ref: 1, organization_owner_version: 1, ticketId: 1, status: 1 } as const;

export function createMongooseOrganizationRepository(options: {
  organizationModel: Model<any>; ticketModel: Model<any>; registeredInstance: string;
}): OrganizationReadRepository {
  const { organizationModel, ticketModel } = options;
  const registeredInstance = validateInstance(options.registeredInstance);
  const parseOrg = (row: any): OrganizationRecord => {
    if (!Number.isSafeInteger(row?.owner_version) || row.owner_version < 1 || !['active', 'archived'].includes(row?.status) ||
        typeof row?.display_name !== 'string' || row.display_name.length < 1 || row.display_name.length > 256 ||
        (row.service_contact != null && (typeof row.service_contact !== 'string' || row.service_contact.length > 256)) ||
        !Array.isArray(row?.backup_engineers) || !Array.isArray(row?.substitutes)) throw new Error('invalid source data');
    return { ...row, org_ref: parseOrgRef(row.org_ref, registeredInstance) };
  };
  const parseTicket = (row: any, expected?: OrgRef): TicketRef => {
    const org_ref = parseOrgRef(row?.organization_ref, registeredInstance);
    if (expected && !sameOrgRef(org_ref, expected)) throw new Error('invalid source data');
    if (!Number.isSafeInteger(row?.organization_owner_version) || row.organization_owner_version < 1 ||
        !Number.isSafeInteger(row?.ticketId) || row.ticketId < 1 || typeof row?.status !== 'string') throw new Error('invalid source data');
    return { org_ref, owner_version: row.organization_owner_version, ticket_id: row.ticketId, status: row.status };
  };
  return {
    async listOrganizations(refs, limit, afterId) {
      if (!refs.length) return { items: [], has_more: false };
      refs = refs.map((ref) => parseOrgRef(ref, registeredInstance));
      const ids = refs.map((r) => r.id);
      const query: any = { 'org_ref.authority': 'support-bot', 'org_ref.instance': registeredInstance, 'org_ref.id': { $in: ids } };
      if (afterId) query['org_ref.id'].$gt = afterId;
      const rows = await organizationModel.find(query, ORG_PROJECTION).sort({ 'org_ref.id': 1 }).limit(limit + 1).lean().exec();
      const items = rows.slice(0, limit).map(parseOrg);
      if (items.some((r: OrganizationRecord) => !ids.includes(r.org_ref.id))) throw new Error('invalid source data');
      return { items, has_more: rows.length > limit, next_key: rows.length > limit ? items.at(-1)?.org_ref.id : undefined };
    },
    async getOrganization(ref) {
      ref = parseOrgRef(ref, registeredInstance);
      const row = await organizationModel.findOne(exactOrgQuery(ref), ORG_PROJECTION).lean().exec();
      if (!row) return null;
      const parsed = parseOrg(row);
      if (!sameOrgRef(parsed.org_ref, ref)) throw new Error('invalid source data');
      return parsed;
    },
    async listTicketRefs(refs, limit, afterTicket) {
      if (!refs.length) return { items: [], has_more: false };
      refs = refs.map((ref) => parseOrgRef(ref, registeredInstance));
      const query: any = { 'organization_ref.authority': 'support-bot', 'organization_ref.instance': registeredInstance,
        'organization_ref.id': { $in: refs.map((r) => r.id) }, organization_owner_version: { $gte: 1 } };
      if (afterTicket) query.ticketId = { $gt: afterTicket };
      // These paths intentionally precede the legacy Supportee schema. Prevent a global
      // strictQuery setting from silently deleting the mandatory organization predicates.
      const rows = await ticketModel.find(query, TICKET_PROJECTION).setOptions({ strictQuery: false }).sort({ ticketId: 1 }).limit(limit + 1).lean().exec();
      const allowedIds = new Set(refs.map((r) => r.id));
      const items = rows.slice(0, limit).map((r: any) => parseTicket(r));
      if (items.some((r) => !allowedIds.has(r.org_ref.id))) throw new Error('invalid source data');
      return { items, has_more: rows.length > limit, next_key: rows.length > limit ? String(items.at(-1)?.ticket_id) : undefined };
    },
    async getTicketRef(ref, ticketId) {
      ref = parseOrgRef(ref, registeredInstance);
      const row = await ticketModel.findOne({ ...Object.fromEntries(Object.entries(exactOrgQuery(ref)).map(([k, v]) => [k.replace('org_ref.', 'organization_ref.'), v])), ticketId,
        organization_owner_version: { $gte: 1 } }, TICKET_PROJECTION).setOptions({ strictQuery: false }).lean().exec();
      return row ? parseTicket(row, ref) : null;
    },
  };
}
