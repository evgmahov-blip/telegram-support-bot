import { Context } from './interfaces';
import cache from './cache';
import * as db from './db';
import * as ownership from './ticket-ownership';
import * as middleware from './middleware';
import * as log from './logger'
import { staffDisplayName } from './staff-names';
const safeStaffName = (id: string) => middleware.strictEscape(staffDisplayName(id));

/**
 * Initializes staff member cache from config on startup.
 */
export async function initStaffCache(): Promise<void> {
    const staffRoles = cache.config.staff_roles || [];
    cache.staffMembers = new Map();
    cache.mutedTickets = new Set();
    cache.staffNameOverrides = new Map();

    for (const member of staffRoles) {
        cache.staffMembers.set(member.telegram_id, member);
    }

    const overrides = await db.getStaffDisplayNameOverrides([...cache.staffMembers.keys()]);
    for (const override of overrides) {
        if (cache.staffMembers.has(override.telegram_id)) {
            cache.staffNameOverrides.set(override.telegram_id, override.display_name);
        }
    }

    log.info(`Loaded ${cache.staffMembers.size} staff members from config and ${cache.staffNameOverrides.size} display-name overrides.`);
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
        await middleware.reply(ctx, 'У вас нет прав брать заявки в работу.');
        return;
    }

    const ticket = await ownership.takeTicket(ticketId, actorId);
    if (!ticket) {
        const current = await db.getTicketById(ticketId, null);
        if (current?.assigned_to) {
            await middleware.reply(ctx, `Заявка уже назначена сотруднику ${safeStaffName(current.assigned_to)}.`);
        } else {
            await middleware.reply(ctx, 'Заявка неактивна или её состояние изменилось.');
        }
        return;
    }

    const actorName = safeStaffName(actorId);
    await middleware.reply(ctx, `Заявка № ${ticketId} взята в работу сотрудником ${actorName}.`);
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
        await middleware.reply(ctx, 'У вас нет прав передавать заявки.');
        return;
    }

    const targetRole = getStaffRole(targetId);
    if (!targetRole) {
        await middleware.reply(ctx, 'Выбранный пользователь не зарегистрирован как сотрудник.');
        return;
    }

    const current = await db.getTicketById(ticketId, null);
    if (!current) {
        await middleware.reply(ctx, 'Заявка не найдена.');
        return;
    }
    if (!canManageTicket(actorId, current.assigned_to)) {
        await middleware.reply(ctx, 'Передать заявку может её владелец, руководитель или администратор.');
        return;
    }

    const actorRole = getStaffRole(actorId);
    const expectedOwner = actorRole === 'agent' ? actorId : undefined;
    const transferred = await ownership.transferTicket(ticketId, targetId, expectedOwner);
    if (!transferred) {
        await middleware.reply(ctx, 'Владелец или состояние заявки изменились.');
        return;
    }

    const targetName = safeStaffName(targetId);
    await middleware.reply(ctx, `Заявка № ${ticketId} передана сотруднику ${targetName}.`);

    if (targetId !== actorId) {
        middleware.sendMessage(
            targetId,
            cache.config.staffchat_type,
            `📋 Вам передана заявка № ${ticketId}.`,
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
        await middleware.reply(ctx, 'У вас нет прав менять состояние заявки.');
        return;
    }

    const current = await db.getTicketById(ticketId, null);
    if (!current) {
        await middleware.reply(ctx, 'Заявка не найдена.');
        return;
    }
    if (!canManageTicket(actorId, current.assigned_to)) {
        await middleware.reply(ctx, 'Сначала возьмите заявку или попросите руководителя изменить её состояние.');
        return;
    }

    const updated = await db.transitionTicketStatus(ticketId, 'waiting_user');
    if (!updated) {
        await middleware.reply(ctx, 'Закрытую заявку нельзя перевести в ожидание клиента.');
        return;
    }

    await middleware.reply(ctx, `Заявка № ${ticketId}: ожидаем ответ клиента.`);
    await db.recordAnalyticsEvent('ticket.waiting_user', ticketId, actorId);
}

/**
 * Assigns a ticket to a specific staff member.
 */
export async function assignTicketCommand(ctx: Context, targetId: string, ticketId: number): Promise<void> {
    const role = getStaffRole(targetId);
    if (!role) {
        await middleware.reply(ctx, 'Выбранный пользователь не зарегистрирован как сотрудник.');
        return;
    }

    await db.assignTicket(ticketId, targetId);

    const memberName = safeStaffName(targetId);
    await middleware.reply(ctx, `${cache.config.language.ticketAssignedTo} ${memberName}`);

    // Notify the assigned agent
    if (targetId !== ctx.from.id) {
        middleware.sendMessage(
            targetId,
            cache.config.staffchat_type,
            `📋 Вам назначена заявка № ${ticketId}. Назначил: ${ctx.message?.from?.first_name || 'сотрудник'}.`,
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
    await middleware.reply(ctx, cache.config.language.ticketUnassigned);
}

/**
 * Adds tags to a ticket.
 */
export async function addTagsCommand(ctx: Context, ticketId: number, tags: string[]): Promise<void> {
    await db.addTags(ticketId, tags);
    await middleware.reply(ctx, `Метки добавлены: ${tags.join(', ')}`);
}

/**
 * Removes a tag from a ticket.
 */
export async function removeTagCommand(ctx: Context, ticketId: number, tag: string): Promise<void> {
    await db.removeTag(ticketId, tag);
    await middleware.reply(ctx, `Метка удалена: ${tag}`);
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
    const names = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочный' };
    await middleware.reply(ctx, `${icons[priority]} Приоритет: ${names[priority]}`);
}

/**
 * Mutes notifications for a ticket.
 */
export async function muteTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    cache.mutedTickets.add(ticketId.toString());
    await middleware.reply(ctx, `🔇 Уведомления по заявке № ${ticketId} отключены.`);
}

/**
 * Unmutes notifications for a ticket.
 */
export async function unmuteTicketCommand(ctx: Context, ticketId: number): Promise<void> {
    cache.mutedTickets.delete(ticketId.toString());
    await middleware.reply(ctx, `🔊 Уведомления по заявке № ${ticketId} включены.`);
}

/**
 * Adds an internal note to a ticket (not forwarded to user).
 */
export async function addInternalNoteCommand(ctx: Context, ticketId: number, text: string, deliveryKey?: string): Promise<void> {
    const created = await db.addInternalNote(ticketId, ctx.from.id.toString(), text, deliveryKey);
    if (created === false) return;

    // Show note in staff chat
    const esc = middleware.strictEscape;
    middleware.sendMessage(
        cache.config.staffchat_id,
        cache.config.staffchat_type,
        `📝 ${cache.config.language.internalNote} #T${ticketId.toString().padStart(6, '0')} (${cache.config.language.noteAddedBy} ${esc(staffDisplayName(ctx.from.id.toString()))}):\n${esc(text)}`,
        { parse_mode: cache.config.parse_mode },
    ).catch(log.error);

    db.recordAnalyticsEventBestEffort('ticket.note_added', ticketId, ctx.from.id.toString());
}

/**
 * Shows all internal notes for a ticket.
 */
export async function showNotesCommand(ctx: Context, ticketId: number): Promise<void> {
    const notes = await db.getInternalNotes(ticketId);
    if (notes.length === 0) {
        await middleware.reply(ctx, `У заявки № ${ticketId} нет внутренних заметок.`);
        return;
    }

    const esc = middleware.strictEscape;
    let output = `📝 ${cache.config.language.internalNote} #T${ticketId.toString().padStart(6, '0')}:\n\n`;
    for (const note of notes) {
        output += `• [${esc(staffDisplayName(note.author_id))}] ${esc(note.text)}\n`;
    }

    await middleware.reply(ctx, output.trim());
}

/**
 * Lists all staff members and their roles.
 */
export async function listStaffCommand(ctx: Context): Promise<void> {
    if (cache.staffMembers.size === 0) {
        await middleware.reply(ctx, 'Сотрудники не настроены.');
        return;
    }

    let output = '👥 *Сотрудники*:\n\n';
    for (const [id, member] of cache.staffMembers) {
        const roleIcons: Record<string, string> = { admin: '👑', supervisor: '⭐', agent: '🔧' };
        const roleNames = { admin: 'администратор', supervisor: 'руководитель', agent: 'инженер' };
        output += `${roleIcons[member.role] || ''} ${safeStaffName(id)} (${roleNames[member.role]})\n`;
    }

    await middleware.reply(ctx, output.trim(), { parse_mode: cache.config.parse_mode });
}

/**
 * Checks if a ticket is muted (no notifications should be sent).
 */
export function isTicketMuted(ticketId: number): boolean {
    return cache.mutedTickets.has(ticketId.toString());
}
