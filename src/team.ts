import { Context } from './interfaces';
import cache from './cache';
import * as db from './db';
import * as ownership from './ticket-ownership';
import * as middleware from './middleware';
import * as log from './logger'

/**
 * Initializes staff member cache from config on startup.
 */
export function initStaffCache(): void {
    const staffRoles = cache.config.staff_roles || [];
    cache.staffMembers = new Map();
    cache.mutedTickets = new Set();

    for (const member of staffRoles) {
        cache.staffMembers.set(member.telegram_id, member);
    }

    log.info(`Loaded ${cache.staffMembers.size} staff members from config.`);
}

/**
 * Gets the role of a staff member by their Telegram ID.
 */
export function getStaffRole(telegramId: string): 'admin' | 'supervisor' | 'agent' | null {
    const member = cache.staffMembers.get(telegramId);
    if (!member) return null;
    return member.role as 'admin' | 'supervisor' | 'agent';
}

/**
 * Checks if a user has permission to perform an action.
 */
export function canPerformAction(
    telegramId: string,
    action: 'reply' | 'assign' | 'take' | 'transfer' | 'wait_user' | 'view_analytics' | 'manage_team',
): boolean {
    const role = getStaffRole(telegramId);

    switch (action) {
        case 'reply':
        case 'take':
        case 'transfer':
        case 'wait_user':
            return ['admin', 'supervisor', 'agent'].includes(role || '');
        case 'assign':
            return ['admin', 'supervisor'].includes(role || '');
        case 'view_analytics':
            return ['admin', 'supervisor'].includes(role || '');
        case 'manage_team':
            return role === 'admin';
        default:
            return false;
    }
}

/**
 * Agents may operate only on their own tickets; supervisors/admins may operate
 * on any ticket. Unowned tickets must be taken before an agent manages them.
 */
export function canManageTicket(telegramId: string, assignedTo: string | null): boolean {
    const role = getStaffRole(telegramId);
    if (role === 'admin' || role === 'supervisor') return true;
    return role === 'agent' && assignedTo === telegramId;
}

/**
 * Takes an unowned active ticket for the current staff member.
 */
export async function takeTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    const actorId = ctx.from.id.toString();
    if (!canPerformAction(actorId, 'take')) {
        middleware.reply(ctx, 'You do not have permission to take tickets.');
        return;
    }

    const ticket = await ownership.takeTicket(ticketId, actorId);
    if (!ticket) {
        const current = await db.getTicketById(ticketId, null);
        if (current?.assigned_to) {
            const owner = cache.staffMembers.get(current.assigned_to);
            middleware.reply(ctx, `Ticket is already owned by ${owner?.name || current.assigned_to}.`);
        } else {
            middleware.reply(ctx, 'Ticket is not active or its state changed.');
        }
        return;
    }

    const actor = cache.staffMembers.get(actorId);
    const actorName = actor?.name || actorId;
    middleware.reply(ctx, `Ticket #T${ticketId.toString().padStart(6, '0')} taken by ${actorName}.`);
    await db.recordAnalyticsEvent('ticket.taken', ticketId, actorId, { owner: actorId });
}

/**
 * Transfers an active ticket to another registered staff member.
 * Agents may transfer only tickets they currently own.
 */
export async function transferTicketCommand(
    ctx: Context,
    targetId: string,
    ticketId: number,
): Promise<void> {
    const actorId = ctx.from.id.toString();
    if (!canPerformAction(actorId, 'transfer')) {
        middleware.reply(ctx, 'You do not have permission to transfer tickets.');
        return;
    }

    const targetRole = getStaffRole(targetId);
    if (!targetRole) {
        middleware.reply(ctx, `User ${targetId} is not a registered staff member.`);
        return;
    }

    const current = await db.getTicketById(ticketId, null);
    if (!current) {
        middleware.reply(ctx, 'Ticket not found.');
        return;
    }
    if (!canManageTicket(actorId, current.assigned_to)) {
        middleware.reply(ctx, 'Only the ticket owner, a supervisor, or an admin can transfer it.');
        return;
    }

    const actorRole = getStaffRole(actorId);
    const expectedOwner = actorRole === 'agent' ? actorId : undefined;
    const transferred = await ownership.transferTicket(ticketId, targetId, expectedOwner);
    if (!transferred) {
        middleware.reply(ctx, 'Ticket owner or state changed before the transfer completed.');
        return;
    }

    const target = cache.staffMembers.get(targetId);
    const targetName = target?.name || targetId;
    middleware.reply(ctx, `Ticket #T${ticketId.toString().padStart(6, '0')} transferred to ${targetName}.`);

    if (targetId !== actorId) {
        middleware.sendMessage(
            targetId,
            cache.config.staffchat_type,
            `📋 Ticket #T${ticketId.toString().padStart(6, '0')} was transferred to you.`,
            { parse_mode: cache.config.parse_mode },
        ).catch(log.error);
    }

    await db.recordAnalyticsEvent('ticket.transferred', ticketId, actorId, {
        from: current.assigned_to,
        to: targetId,
    });
}

/**
 * Marks an active ticket as waiting for the user. Agents may do this only for
 * tickets they own. A user reply moves WAITING_USER back to OPEN in text.ts.
 */
export async function waitingUserCommand(ctx: Context, ticketId: number): Promise<void> {
    const actorId = ctx.from.id.toString();
    if (!canPerformAction(actorId, 'wait_user')) {
        middleware.reply(ctx, 'You do not have permission to change ticket state.');
        return;
    }

    const current = await db.getTicketById(ticketId, null);
    if (!current) {
        middleware.reply(ctx, 'Ticket not found.');
        return;
    }
    if (!canManageTicket(actorId, current.assigned_to)) {
        middleware.reply(ctx, 'Take the ticket first, or ask a supervisor/admin to change its state.');
        return;
    }

    const updated = await db.transitionTicketStatus(ticketId, 'waiting_user');
    if (!updated) {
        middleware.reply(ctx, 'Closed tickets cannot be moved to WAITING_USER.');
        return;
    }

    middleware.reply(ctx, `Ticket #T${ticketId.toString().padStart(6, '0')} → WAITING_USER.`);
    await db.recordAnalyticsEvent('ticket.waiting_user', ticketId, actorId);
}

/**
 * Assigns a ticket to a specific staff member.
 */
export async function assignTicketCommand(ctx: Context, targetId: string, ticketId: number): Promise<void> {
    const role = getStaffRole(targetId);
    if (!role) {
        middleware.reply(ctx, `User ${targetId} is not a registered staff member.`);
        return;
    }

    await db.assignTicket(ticketId, targetId);

    const member = cache.staffMembers.get(targetId);
    const memberName = member?.name || targetId;
    middleware.reply(ctx, `${cache.config.language.ticketAssignedTo} ${memberName}`);

    // Notify the assigned agent
    if (targetId !== ctx.from.id) {
        middleware.sendMessage(
            targetId,
            cache.config.staffchat_type,
            `📋 You have been assigned ticket #T${ticketId.toString().padStart(6, '0')} by ${ctx.message?.from?.first_name || 'staff'}.`,
            { parse_mode: cache.config.parse_mode },
        ).catch(log.error);
    }

    await db.recordAnalyticsEvent('ticket.assigned', ticketId, targetId, { assigned_by: ctx.from.id });
}

/**
 * Unassigns a ticket from its current assignee.
 */
export async function unassignTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    await db.unassignTicket(ticketId);
    middleware.reply(ctx, cache.config.language.ticketUnassigned);
}

/**
 * Adds tags to a ticket.
 */
export async function addTagsCommand(ctx: Context, ticketId: number, tags: string[]): Promise<void> {
    await db.addTags(ticketId, tags);
    middleware.reply(ctx, `Tags added: ${tags.join(', ')}`);
}

/**
 * Removes a tag from a ticket.
 */
export async function removeTagCommand(ctx: Context, ticketId: number, tag: string): Promise<void> {
    await db.removeTag(ticketId, tag);
    middleware.reply(ctx, `Tag removed: ${tag}`);
}

/**
 * Sets the priority of a ticket.
 */
export async function setPriorityCommand(
    ctx: Context,
    ticketId: number,
    priority: 'low' | 'normal' | 'high' | 'urgent',
): Promise<void> {
    await db.setPriority(ticketId, priority as any);

    const icons: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🟡', low: '⚪' };
    middleware.reply(ctx, `${icons[priority]} Priority set to ${priority.toUpperCase()}`);
}

/**
 * Mutes notifications for a ticket.
 */
export async function muteTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    cache.mutedTickets.add(ticketId.toString());
    middleware.reply(ctx, `🔇 Ticket #T${ticketId.toString().padStart(6, '0')} muted.`);
}

/**
 * Unmutes notifications for a ticket.
 */
export async function unmuteTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    cache.mutedTickets.delete(ticketId.toString());
    middleware.reply(ctx, `🔊 Ticket #T${ticketId.toString().padStart(6, '0')} unmuted.`);
}

/**
 * Adds an internal note to a ticket (not forwarded to user).
 */
export async function addInternalNoteCommand(ctx: Context, ticketId: number, text: string): Promise<void> {
    await db.addInternalNote(ticketId, ctx.from.id.toString(), text);

    // Show note in staff chat
    const esc = middleware.strictEscape;
    middleware.sendMessage(
        cache.config.staffchat_id,
        cache.config.staffchat_type,
        `📝 ${cache.config.language.internalNote} #T${ticketId.toString().padStart(6, '0')} (${cache.config.language.noteAddedBy} ${esc(ctx.message?.from?.first_name || 'staff')}):\n${esc(text)}`,
        { parse_mode: cache.config.parse_mode },
    ).catch(log.error);

    await db.recordAnalyticsEvent('ticket.note_added', ticketId, ctx.from.id.toString());
}

/**
 * Shows all internal notes for a ticket.
 */
export async function showNotesCommand(ctx: Context, ticketId: number): Promise<void> {
    const notes = await db.getInternalNotes(ticketId);
    if (notes.length === 0) {
        middleware.reply(ctx, `No internal notes for ticket #T${ticketId.toString().padStart(6, '0')}.`);
        return;
    }

    const esc = middleware.strictEscape;
    let output = `📝 ${cache.config.language.internalNote} #T${ticketId.toString().padStart(6, '0')}:\n\n`;
    for (const note of notes) {
        const author = cache.staffMembers.get(note.author_id);
        const authorName = author?.name || note.author_id;
        output += `• [${authorName}] ${esc(note.text)}\n`;
    }

    middleware.reply(ctx, output.trim());
}

/**
 * Lists all staff members and their roles.
 */
export async function listStaffCommand(ctx: Context): Promise<void> {
    if (cache.staffMembers.size === 0) {
        middleware.reply(ctx, 'No staff members configured.');
        return;
    }

    let output = '👥 *Staff Members*:\n\n';
    for (const [id, member] of cache.staffMembers) {
        const roleIcons: Record<string, string> = { admin: '👑', supervisor: '⭐', agent: '🔧' };
        output += `${roleIcons[member.role] || ''} ${member.name} (${member.role})\n`;
    }

    middleware.reply(ctx, output.trim(), { parse_mode: cache.config.parse_mode });
}

/**
 * Checks if a ticket is muted (no notifications should be sent).
 */
export function isTicketMuted(ticketId: number): boolean {
    return cache.mutedTickets.has(ticketId.toString());
}
