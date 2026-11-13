import { randomUUID } from 'crypto';
import cache from './cache';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';
import { Messenger } from './interfaces';
import { authorityUpdate } from './ai-engineer-authority';
import { businessDeadline, validateRoutingPolicy } from './routing-policy';
import { organizationRoutingOwner, validRoutingOrgRef, commonRouting } from './routing-contract';
import type { RoutingAudit, TicketRouting } from './routing-contract';
import type { ISupportee } from './db';

export { commonRouting } from './routing-contract';
export const MAX_OFFER_TRANSFERS = 3;
const active = { $in: ['open', 'waiting_user'] };
export function activeEngineer(id: string): boolean {
  return Boolean(team.getStaffRole(id)) && cache.staffMembers?.get(id)?.active !== false;
}
export function currentRoutingPolicy() {
  const schedule = cache.config.web_chat?.business_hours;
  if (!schedule) throw new Error('schedule_unconfigured');
  return validateRoutingPolicy({ acceptance_minutes: cache.config.routing?.acceptance_minutes ?? 10,
    reminder_before_minutes: cache.config.routing?.reminder_before_minutes ?? null, schedule });
}
function audit(r: TicketRouting, type: string, actor: string | null, reason: string, from: string | null, to: string | null, now: Date): TicketRouting {
  const event: RoutingAudit = { event_id: randomUUID(), type, at: now, actor, reason, from, to, version: r.version };
  return { ...r, audit: [...r.audit, event], audit_pending: true };
}
/** Declarations never select an organization. Exact canonical owner lookup only. */
export async function planNewTicketRouting(userid: string, messenger: string, declared: string | null | undefined, now = new Date()):
Promise<import('./routing-contract').RoutingPlan> {
  const common = (reason: string) => ({ routing: commonRouting(reason, now) });
  let profile: db.IClientProfile | null;
  try { profile = await db.getClientProfile(userid, messenger); } catch { return common('client_profile_unavailable'); }
  if (!profile || profile.organization !== declared || profile.organization_verification !== 'confirmed' || !profile.confirmed_org_ref) return common('organization_unconfirmed');
  const owner = organizationRoutingOwner();
  if (!owner?.ticketPartitioningReady) return common('organization_owner_unavailable');
  if (!validRoutingOrgRef(profile.confirmed_org_ref, owner.registeredInstance)) return common('organization_reference_invalid');
  try {
    const org = await owner.getOrganization(profile.confirmed_org_ref);
    if (!org || !validRoutingOrgRef(org.org_ref, owner.registeredInstance) || org.org_ref.id !== profile.confirmed_org_ref.id
      || org.status !== 'active' || !Number.isSafeInteger(org.owner_version) || org.owner_version < 1) return common('organization_unavailable');
    const id = org.primary_engineer?.real_telegram_identity;
    if (!id || !activeEngineer(id)) return common('responsible_engineer_unavailable');
    if (messenger !== Messenger.TELEGRAM || cache.config.staffchat_type !== Messenger.TELEGRAM) return common('private_offer_transport_unavailable');
    const policy = currentRoutingPolicy();
    const deadline = businessDeadline(now, policy.acceptance_minutes, policy.schedule);
    const reminderAt = policy.reminder_before_minutes === null ? null : businessDeadline(now, policy.acceptance_minutes - policy.reminder_before_minutes, policy.schedule);
    const routing = audit({ state: 'offered', version: 1, offered_to: id, first_offered_at: now, deadline_at: deadline,
      reminder_at: reminderAt, policy, transfers: 0, delivery: 'pending', reminder: reminderAt ? 'pending' : 'disabled', audit: [] },
    'ticket.routing_offered', null, 'confirmed_organization_responsible', null, id, now);
    return { routing, organization_ref: org.org_ref, organization_owner_version: org.owner_version, organization_binding_version: profile.org_binding_version };
  } catch { return common('organization_or_schedule_unavailable'); }
}
/** Version, owner and active-state CAS. Audit outbox and transition commit in the same owner row. */
async function cas(ticket: ISupportee, next: TicketRouting, assigned: string | null,
  extra: Record<string, unknown> = {}): Promise<ISupportee | null> {
  if ((assigned && !activeEngineer(assigned)) || (next.state === 'offered' && (!next.offered_to || !activeEngineer(next.offered_to)))) return null;
  return await db.Supportee.findOneAndUpdate({ ticketId: ticket.ticketId, status: active,
    assigned_to: ticket.assigned_to ?? null, 'routing.version': ticket.routing!.version },
  authorityUpdate({ routing: next, assigned_to: assigned, common_visible: false, ...extra }), { new: true }) as ISupportee | null;
}
export async function routingCommand(ticketId: number, actor: string, expectedVersion: number,
  action: 'take' | 'common' | 'transfer', target?: string, now = new Date()): Promise<ISupportee | null> {
  if (!activeEngineer(actor) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return null;
  const t = await db.getTicketById(ticketId, null); const r = t?.routing;
  if (!t || !r || r.version !== expectedVersion || !['open','waiting_user'].includes(t.status)) return null;
  const role = team.getStaffRole(actor), manager = role === 'admin' || role === 'supervisor';
  if (r.state === 'offered' && (!r.deadline_at || +new Date(r.deadline_at) <= +now || t.assigned_to)) return null;
  const recipient = r.state === 'offered' ? r.offered_to : t.assigned_to;
  if (action === 'take') {
    if (t.assigned_to || (r.state === 'offered' && recipient !== actor) || !['common','offered'].includes(r.state)) return null;
    return cas(t, audit({ ...r, state: 'accepted', version: r.version + 1, offered_to: null, deadline_at: null,
      reminder_at: null, reminder: 'disabled' }, 'ticket.routing_taken', actor, 'accepted', recipient, actor, now), actor);
  }
  if (!manager && recipient !== actor) return null;
  if (action === 'common' || (action === 'transfer' && r.transfers >= MAX_OFFER_TRANSFERS)) {
    // An explicit return commits its shared-feed record in the same CAS as the transition.
    return cas(t, audit({ ...r, state: 'common', version: r.version + 1, offered_to: null,
      deadline_at: null, reminder_at: null, reminder: 'disabled' }, 'ticket.routing_common', actor,
    action === 'common' ? 'explicit_common' : 'transfer_limit', recipient, null, now), null,
    action === 'common' ? { common_return_notice: { key: 'r' + (r.version + 1), state: 'pending', at: now, attempts: 0 } satisfies db.CommonReturnNotice } : {});
  }
  if (!target || target === recipient || !activeEngineer(target)) return null;
  let policy = r.policy, deadline = r.deadline_at, first = r.first_offered_at, reminderAt = r.reminder_at;
  if (r.state !== 'offered') {
    try {
      policy = currentRoutingPolicy(); first = now; deadline = businessDeadline(now, policy.acceptance_minutes, policy.schedule);
      reminderAt = policy.reminder_before_minutes === null ? null : businessDeadline(now, policy.acceptance_minutes - policy.reminder_before_minutes, policy.schedule);
    } catch { return null; }
  }
  return cas(t, audit({ ...r, state: 'offered', version: r.version + 1, offered_to: target, first_offered_at: first,
    deadline_at: deadline, reminder_at: reminderAt, policy, transfers: r.state === 'offered' ? r.transfers + 1 : 0,
    delivery: 'pending', reminder: reminderAt ? 'pending' : 'disabled' }, 'ticket.routing_transferred', actor, 'offer_transferred', recipient, target, now), null);
}
export async function flushRoutingAudit(ticket: ISupportee): Promise<void> {
  for (const event of ticket.routing?.audit ?? []) await db.recordRoutingEvent(event.event_id, event.type, ticket.ticketId, event.actor,
    { reason: event.reason, from: event.from, to: event.to, routing_version: event.version, occurred_at: event.at });
  if (ticket.routing) await db.Supportee.updateOne({ ticketId: ticket.ticketId, 'routing.version': ticket.routing.version },
    { $set: { 'routing.audit_pending': false } });
}
export type OfferSender = (id: string, text: string, extra: Record<string, unknown>) => Promise<string | null>;
const defaultSender: OfferSender = (id, text, extra) => middleware.sendMessage(id, Messenger.TELEGRAM, text, extra);
function definiteNonDelivery(err: unknown): boolean {
  const e = err as { error_code?: number; description?: string };
  return (e?.error_code === 403 && /blocked|deactivated|forbidden/i.test(e.description ?? ''))
    || (e?.error_code === 400 && /chat not found|bot can't initiate/i.test(e.description ?? ''));
}
export async function deliverOffer(ticket: ISupportee, send: OfferSender = defaultSender, now = new Date()): Promise<void> {
  const r = ticket.routing;
  if (!r || r.state !== 'offered' || r.delivery !== 'pending' || !r.offered_to || !activeEngineer(r.offered_to)
    || !r.deadline_at || +new Date(r.deadline_at) <= +now) return;
  const claimed = await cas(ticket, { ...r, version: r.version + 1, delivery: 'sending' }, null);
  if (!claimed) return;
  const current = claimed.routing!;
  let delivery: TicketRouting['delivery'] = 'unknown';
  try {
    const prefix = 'rt:', suffix = ':' + ticket.ticketId + ':' + current.version;
    const text = 'Заявка № ' + ticket.ticketId + ': ожидает принятия.\nСрок: ' + new Date(r.deadline_at).toISOString()
      + ' (' + r.policy!.schedule.timezone + ').\nЭто предложение, работа ещё не закреплена.';
    const result = await send(r.offered_to, text, { disable_notification: false, reply_markup: { inline_keyboard: [
      [{ text: 'Взять', callback_data: prefix + 'take' + suffix }, { text: 'Передать', callback_data: prefix + 'transfer' + suffix }],
      [{ text: 'Сделать общей', callback_data: prefix + 'common' + suffix }],
    ] } });
    delivery = result ? 'delivered' : 'unknown';
  } catch (err) { delivery = definiteNonDelivery(err) ? 'undelivered' : 'unknown'; }
  // Metadata has a separate exact CAS; no bump, so the delivered buttons retain their version.
  await db.Supportee.updateOne({ ticketId: ticket.ticketId, 'routing.version': current.version, 'routing.state': 'offered', 'routing.delivery': 'sending' },
    { $set: { 'routing.delivery': delivery } });
  if (delivery === 'undelivered') {
    const latest = await db.getTicketById(ticket.ticketId, null);
    if (latest?.routing?.state === 'offered' && latest.routing.version === current.version) await makeCommonSystem(latest, 'offer_undelivered', now);
  }
}
async function makeCommonSystem(ticket: ISupportee, reason: string, now: Date) {
  const r = ticket.routing!;
  return cas(ticket, audit({ ...r, state: 'common', version: r.version + 1, offered_to: null, deadline_at: null,
    reminder_at: null, reminder: 'disabled' }, 'ticket.routing_common', null, reason, r.offered_to, null, now), null);
}
/** Uses the existing workflow; pending sends have a durable claim, uncertain effects never auto-repeat. */
export async function maintainRouting(now = new Date(), send: OfferSender = defaultSender,
  onTransition: (ticket: ISupportee) => Promise<void> = async () => undefined): Promise<void> {
  let after = 0;
  for (;;) {
  const tickets: ISupportee[] = await db.Supportee.find({ ticketId: { $gt: after }, $or: [
    { status: active, 'routing.state': 'offered' }, { 'routing.audit_pending': true },
  ] }).sort({ ticketId: 1 }).limit(200);
  if (!tickets.length) break;
  after = tickets[tickets.length - 1].ticketId;
  for (const initial of tickets) {
    let ticket: ISupportee | null = initial;
    const r = ticket!.routing!;
    await flushRoutingAudit(ticket!);
    if (r.state !== 'offered' || ticket!.assigned_to) continue;
    if (!r.offered_to || !activeEngineer(r.offered_to)) ticket = await makeCommonSystem(ticket!, 'engineer_disabled', now);
    else if (!r.deadline_at || +new Date(r.deadline_at) <= +now) ticket = await makeCommonSystem(ticket!, 'acceptance_timeout', now);
    else if (r.delivery === 'undelivered') ticket = await makeCommonSystem(ticket!, 'offer_undelivered', now);
    else {
      if (r.delivery === 'pending') await deliverOffer(ticket!, send, now);
      // Reload after the send claim, which intentionally changes the routing version.
      ticket = await db.getTicketById(ticket!.ticketId, null);
      const live = ticket?.routing;
      if (ticket && live?.state === 'offered' && live.delivery === 'delivered' && live.reminder === 'pending'
        && live.reminder_at && +new Date(live.reminder_at) <= +now) {
        const claimed = await db.Supportee.findOneAndUpdate({ ticketId: ticket.ticketId, assigned_to: null, status: active,
          'routing.version': live.version, 'routing.state': 'offered', 'routing.reminder': 'pending' },
        { $set: { 'routing.reminder': 'sending' } }, { new: true });
        if (claimed) {
          let result = 'unknown';
          try { if (await send(live.offered_to!, 'Напоминание: заявка № ' + ticket.ticketId + ' ожидает принятия. Срок не меняется.', {})) result = 'sent'; } catch { /* UNKNOWN, no retry */ }
          await db.Supportee.updateOne({ ticketId: ticket.ticketId, 'routing.version': live.version, 'routing.reminder': 'sending' },
            { $set: { 'routing.reminder': result } });
        }
      }
    }
    if (ticket) { await flushRoutingAudit(ticket); if (ticket.routing?.version !== r.version) await onTransition(ticket); }
  }
  }
}
