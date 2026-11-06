import cache from './cache';
import * as team from './team';
import * as middleware from './middleware';
import * as log from './logger';
import { Messenger } from './interfaces';
import type { ISupportee } from './db';

type VisibleTicket = Pick<ISupportee, 'assigned_to'> & { common_visible?: boolean | null; routing?: ISupportee['routing'] };

/**
 * Common work is the unassigned queue or an owned ticket explicitly shared by
 * its owner/supervisor. Everything else is personal to its owner.
 */
export function isCommonTicket(ticket: VisibleTicket): boolean {
  if (ticket.routing?.state === 'offered') return false;
  return !ticket.assigned_to || ticket.common_visible === true;
}

/**
 * Registered staff only: supervisors/admins keep their full authority; agents
 * see their own and common tickets, open or closed alike.
 */
export function canViewTicket(actorId: string, ticket: VisibleTicket): boolean {
  const role = team.getStaffRole(actorId);
  if (role === 'admin' || role === 'supervisor') return true;
  return role === 'agent' && (ticket.assigned_to === actorId || ticket.routing?.offered_to === actorId || isCommonTicket(ticket));
}

/** List scope for an actor; a shared chat only ever lists common tickets. */
export function listScope(actorId: string, sharedSurface: boolean): 'common' | 'visible' | 'all' {
  if (sharedSurface) return 'common';
  const role = team.getStaffRole(actorId);
  return role === 'admin' || role === 'supervisor' ? 'all' : 'visible';
}

export const PRIVATE_UNAVAILABLE = 'Не удалось написать вам в личный чат с ботом. Откройте бота, нажмите /start и повторите. В общий чат личные данные не отправляются.';

/**
 * Deliver a private staff view to a registered engineer's own bot DM.
 * Returns the message id, or null when the DM is unsupported, blocked or never
 * started. Never falls back to a shared chat.
 */
export async function sendToStaffPrivate(staffId: string | null | undefined, text: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  if (!staffId || !team.getStaffRole(String(staffId))) return null;
  if (cache.config.staffchat_type && cache.config.staffchat_type !== Messenger.TELEGRAM) return null;
  try {
    return await middleware.sendMessage(String(staffId), Messenger.TELEGRAM, text, extra);
  } catch (err) {
    const description = String((err as { description?: string }).description || err);
    log.error(`Личный чат сотрудника недоступен: ${description}`);
    return null;
  }
}

/**
 * Route a staff notification about a ticket: common tickets go to the shared
 * staff chat, personal tickets only to their owner's DM. When the DM fails the
 * shared chat receives a content-free notice and nothing else.
 */
export async function notifyTicketStaff(ticket: ISupportee, text: string, extra: Record<string, unknown> = {},
  sharedFallbackNotice?: string): Promise<{ route: 'shared' | 'owner' | 'undelivered'; messageId: string | null }> {
  if (isCommonTicket(ticket)) {
    const messageId = await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type, text, extra);
    return { route: 'shared', messageId };
  }
  const messageId = await sendToStaffPrivate(ticket.routing?.state === 'offered' ? ticket.routing.offered_to : ticket.assigned_to, text, extra);
  if (messageId) return { route: 'owner', messageId };
  await middleware.sendMessage(cache.config.staffchat_id, cache.config.staffchat_type,
    sharedFallbackNotice || personalUndeliveredNotice(ticket.ticketId), {}).catch(log.error);
  return { route: 'undelivered', messageId: null };
}

export function personalUndeliveredNotice(ticketId: number): string {
  return `Новое событие по личной заявке № ${ticketId}: владельцу не удалось написать в личный чат с ботом. Владельцу нужно открыть бота и нажать /start; содержимое в общий чат не отправляется.`;
}
