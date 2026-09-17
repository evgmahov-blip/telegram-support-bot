import cache from './cache';
import { Context, TicketPriority } from './interfaces';
import { ISupportee } from './db';
import * as db from './db';
import * as team from './team';
import * as ticketQueue from './ticket-queue';
import * as ticketMetadata from './ticket-metadata';
import * as ticketAudit from './ticket-audit';
import * as staff from './staff';
import * as middleware from './middleware';
import { resolveTicketFromReply } from './ticket-resolution';

async function resolveRepliedTicket(ctx: Context): Promise<ISupportee | null> {
  const resolved = await resolveTicketFromReply(ctx, null);
  return resolved?.ticket ?? null;
}

async function requireRepliedTicket(ctx: Context): Promise<ISupportee | null> {
  const ticket = await resolveRepliedTicket(ctx);
  if (!ticket) {
    await middleware.reply(ctx, 'Reply to a ticket message.');
    return null;
  }
  return ticket;
}

async function requireManageableTicket(
  ctx: Context,
  ticket: ISupportee,
  action: string,
): Promise<{ actorId: string; role: 'admin' | 'supervisor' | 'agent'; expectedOwner?: string } | null> {
  const actorId = ctx.from.id.toString();
  const role = team.getStaffRole(actorId);
  if (!role) {
    await middleware.reply(ctx, `You do not have permission to ${action}.`);
    return null;
  }
  if (!team.canManageTicket(actorId, ticket.assigned_to)) {
    await middleware.reply(ctx, ticket.assigned_to
      ? 'This ticket is owned by another engineer.'
      : 'Take the ticket first with /take.');
    return null;
  }
  return {
    actorId,
    role,
    expectedOwner: role === 'agent' ? actorId : undefined,
  };
}

export async function takeCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.takeTicketCommand(ctx, ticket.ticketId);
}

export async function transferCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const targetId = ctx.match?.trim();
  if (!targetId) {
    await middleware.reply(ctx, 'Usage: /transfer <staff_telegram_id>');
    return;
  }

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.transferTicketCommand(ctx, targetId, ticket.ticketId);
}

export async function waitingCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.waitingUserCommand(ctx, ticket.ticketId);
}

/**
 * Shows or changes the queue for the replied active ticket.
 * Agents may move only tickets they own; supervisors/admins may move any ticket.
 */
export async function queueCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;

  const actorId = ctx.from.id.toString();
  const role = team.getStaffRole(actorId);
  if (!role) {
    await middleware.reply(ctx, 'You do not have permission to manage queues.');
    return;
  }

  const requested = ctx.match?.trim() || '';
  const available = ticketQueue.listQueues();
  const currentQueue = await ticketQueue.getTicketQueue(ticket.ticketId);

  if (!requested) {
    await middleware.reply(
      ctx,
      `Queue: ${currentQueue}. Available: ${available.join(', ')}. Usage: /queue <name>`,
    );
    return;
  }

  const targetQueue = ticketQueue.resolveQueueName(requested);
  if (!targetQueue) {
    await middleware.reply(ctx, `Unknown queue. Available: ${available.join(', ')}`);
    return;
  }

  if (!team.canManageTicket(actorId, ticket.assigned_to)) {
    await middleware.reply(ctx, ticket.assigned_to
      ? 'Only the ticket owner, a supervisor, or an admin can change its queue.'
      : 'Take the ticket first with /take.');
    return;
  }

  if (currentQueue === targetQueue) {
    await middleware.reply(ctx, `Ticket is already in queue ${targetQueue}.`);
    return;
  }

  const expectedOwner = role === 'agent' ? actorId : undefined;
  const moved = await ticketQueue.moveTicketToQueue(ticket.ticketId, targetQueue, expectedOwner);
  if (!moved) {
    await middleware.reply(ctx, 'Ticket owner or state changed before the queue move completed.');
    return;
  }

  await middleware.reply(
    ctx,
    `Ticket #T${ticket.ticketId.toString().padStart(6, '0')} → queue ${targetQueue}.`,
  );
  await db.recordAnalyticsEvent('ticket.queue_changed', ticket.ticketId, actorId, {
    from: currentQueue,
    to: targetQueue,
  });
}

/** Set priority on an active ticket using owner/state CAS. */
export async function priorityCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;

  const raw = ctx.match?.trim().toLowerCase() || '';
  const priorities = Object.values(TicketPriority);
  if (!priorities.includes(raw as TicketPriority)) {
    await middleware.reply(ctx, 'Usage: /priority <low|normal|high|urgent>');
    return;
  }

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  const access = await requireManageableTicket(ctx, ticket, 'change ticket priority');
  if (!access) return;

  const priority = raw as TicketPriority;
  const updated = await ticketMetadata.setPriority(
    ticket.ticketId,
    priority,
    access.expectedOwner,
  );
  if (!updated) {
    await middleware.reply(ctx, 'Ticket owner or state changed before the priority update completed.');
    return;
  }

  const icons: Record<TicketPriority, string> = {
    [TicketPriority.URGENT]: '🔴',
    [TicketPriority.HIGH]: '🟠',
    [TicketPriority.NORMAL]: '🟡',
    [TicketPriority.LOW]: '⚪',
  };
  await middleware.reply(ctx, `${icons[priority]} Priority → ${priority.toUpperCase()}.`);
  await db.recordAnalyticsEvent('ticket.priority_changed', ticket.ticketId, access.actorId, {
    from: ticket.priority || TicketPriority.NORMAL,
    to: priority,
  });
}

/** Add an internal-only note to an active manageable ticket. */
export async function noteCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const text = ctx.match?.trim() || '';
  if (!text) {
    await middleware.reply(ctx, 'Usage: /note <internal note text>');
    return;
  }

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  const access = await requireManageableTicket(ctx, ticket, 'add internal notes');
  if (!access) return;

  const guarded = await ticketMetadata.getActiveManageableTicket(
    ticket.ticketId,
    access.expectedOwner,
  );
  if (!guarded) {
    await middleware.reply(ctx, 'Ticket owner or state changed before the note was added.');
    return;
  }

  await db.addInternalNote(ticket.ticketId, access.actorId, text);
  await db.recordAnalyticsEvent('ticket.note_added', ticket.ticketId, access.actorId);
  await middleware.reply(
    ctx,
    `Internal note added to #T${ticket.ticketId.toString().padStart(6, '0')}.`,
  );
}

/** Show internal notes only to staff who may manage the ticket. */
export async function notesCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  const access = await requireManageableTicket(ctx, ticket, 'view internal notes');
  if (!access) return;

  const notes = await db.getInternalNotes(ticket.ticketId);
  if (notes.length === 0) {
    await middleware.reply(
      ctx,
      `No internal notes for #T${ticket.ticketId.toString().padStart(6, '0')}.`,
    );
    return;
  }

  const esc = middleware.strictEscape;
  const lines = notes.map((note) => {
    const author = cache.staffMembers.get(note.author_id);
    return `• ${esc(author?.name || note.author_id)}: ${esc(note.text)}`;
  });
  await middleware.reply(
    ctx,
    `Internal notes #T${ticket.ticketId.toString().padStart(6, '0')}:\n${lines.join('\n')}`,
    { parse_mode: cache.config.parse_mode },
  );
}

/** Read the ticket audit trail without exposing event metadata payloads. */
export async function historyCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  const access = await requireManageableTicket(ctx, ticket, 'view ticket history');
  if (!access) return;

  const events = await ticketAudit.getTicketAuditHistory(ticket.ticketId, 20);
  if (events.length === 0) {
    await middleware.reply(
      ctx,
      `No audit events for #T${ticket.ticketId.toString().padStart(6, '0')}.`,
    );
    return;
  }

  const esc = middleware.strictEscape;
  const lines = events.map((event) => {
    const when = event.timestamp
      ? new Date(event.timestamp).toISOString().slice(0, 16).replace('T', ' ')
      : '-';
    const member = event.agent_id ? cache.staffMembers.get(event.agent_id) : undefined;
    const actor = event.agent_id ? (member?.name || event.agent_id) : 'system/user';
    return `• ${esc(when)} · ${esc(event.type)} · ${esc(actor)}`;
  });

  await middleware.reply(
    ctx,
    `Audit #T${ticket.ticketId.toString().padStart(6, '0')}:\n${lines.join('\n')}`,
    { parse_mode: cache.config.parse_mode },
  );
}

/**
 * Sends a configured canned response through the normal staff reply path.
 * Without a replied ticket it only previews the template inside the staff chat.
 */
export async function cannedResponseCommand(
  ctx: Context,
  key: string,
  cannedText: string,
): Promise<void> {
  if (!ctx.session.admin) return;

  if (!ctx.message?.reply_to_message) {
    await middleware.reply(ctx, `Template "${key}":\n\n${cannedText}`, {
      parse_mode: cache.config.parse_mode,
    });
    return;
  }

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  const access = await requireManageableTicket(ctx, ticket, 'send canned responses');
  if (!access) return;
  if (ticket.status === 'closed') {
    await middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }

  ctx.message.text = cannedText;
  await staff.chat(ctx);
  await db.recordAnalyticsEvent('ticket.canned_response', ticket.ticketId, access.actorId, { key });
}

export { resolveRepliedTicket };
