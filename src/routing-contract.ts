import { randomUUID } from 'crypto';
import type { RoutingPolicy } from './routing-policy';
/** Structural compatibility with PR37 OrgRef. No registry or organization authority is created here. */
export interface RoutingOrgRef { authority: 'support-bot'; instance: string; id: string; }
export interface RoutingOrganization {
  org_ref: RoutingOrgRef; owner_version: number; status: 'active' | 'archived'; display_name: string;
  primary_engineer?: { principal_ref: string; real_telegram_identity?: string | null } | null;
}
export interface OrganizationRoutingOwner {
  readonly registeredInstance: string;
  readonly ticketPartitioningReady: boolean;
  getOrganization(ref: RoutingOrgRef): Promise<RoutingOrganization | null>;
}
let organizationOwner: OrganizationRoutingOwner | null = null;
export function organizationRoutingOwner(): OrganizationRoutingOwner | null { return organizationOwner; }
/** No production binding until independent owner/cutover review. Fixtures cannot grant runtime authority. */
export function installOrganizationRoutingOwner(owner: OrganizationRoutingOwner | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('organization_owner_integration_requires_review');
  organizationOwner = owner;
}
export function validRoutingOrgRef(value: unknown, instance: string): value is RoutingOrgRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'authority,id,instance' && v.authority === 'support-bot'
    && v.instance === instance && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instance)
    && typeof v.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.id);
}
export interface RoutingAudit {
  event_id: string; type: string; at: Date; actor: string | null; reason: string;
  from: string | null; to: string | null; version: number;
}
export interface TicketRouting {
  state: 'common' | 'offered' | 'accepted'; version: number; offered_to: string | null;
  first_offered_at: Date | null; deadline_at: Date | null; reminder_at: Date | null;
  policy: RoutingPolicy | null; transfers: number;
  delivery: 'pending' | 'sending' | 'delivered' | 'undelivered' | 'unknown';
  reminder: 'pending' | 'sending' | 'sent' | 'disabled' | 'unknown';
  audit: RoutingAudit[];
  audit_pending?: boolean;
}

export function commonRouting(reason: string, now = new Date()): TicketRouting {
  return { state:'common',version:1,offered_to:null,first_offered_at:null,deadline_at:null,reminder_at:null,policy:null,
    transfers:0,delivery:'pending',reminder:'disabled',audit_pending:true,
    audit:[{event_id:randomUUID(),type:'ticket.routing_common',at:now,actor:null,reason,from:null,to:null,version:1}] };
}
export interface RoutingPlan {
  routing: TicketRouting; organization_ref?: RoutingOrgRef; organization_owner_version?: number; organization_binding_version?: number;
}
