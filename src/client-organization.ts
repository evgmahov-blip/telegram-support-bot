import * as db from './db';
import * as middleware from './middleware';
import { Context, Messenger } from './interfaces';

/**
 * Self-declared client organization. It identifies who is asking; it is never
 * verified membership, an OrgRef or a permission, and it never changes past tickets.
 */
export const ORG_MIN = 2;
export const ORG_MAX = 120;
const EDIT_MS = 15 * 60 * 1000;
const USER_HOME = { text: '🏠 Главная', callback_data: 'um:home:0' };
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = (rows: Array<Array<{ text: string; callback_data: string }>>) => ({ parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });

/** Returns the bounded single-line name, or null when the input cannot be an organization name. */
export function normalizeOrganization(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (value.length < ORG_MIN || value.length > ORG_MAX) return null;
  if (value.startsWith('/')) return null;
  if (!/[\p{L}\p{N}]/u.test(value)) return null;
  return value;
}

/** Organization collection applies to Telegram private chats; other transports keep working without it. */
function applies(ctx: Context): boolean {
  return ctx.messenger === Messenger.TELEGRAM && ctx.chat?.type === 'private'
    && typeof db.getClientProfile === 'function';
}

const userKey = (ctx: Context) => String(ctx.from.id);

function activeInput(profile: db.IClientProfile | null): boolean {
  if (!profile?.org_input) return false;
  return !profile.org_input_expires_at || new Date(profile.org_input_expires_at).getTime() > Date.now();
}

export async function getProfile(ctx: Context): Promise<db.IClientProfile | null> {
  if (!applies(ctx)) return null;
  return await db.getClientProfile(userKey(ctx), ctx.messenger);
}

type AskReason = 'start' | 'request' | 'menu';
async function askFirst(ctx: Context, reason: AskReason) {
  const profile = await db.startOrganizationInput(userKey(ctx), ctx.messenger, 'first', null);
  if (!profile) return;
  const lead = reason === 'request'
    ? 'Перед созданием обращения укажите вашу организацию. Ваше сообщение пока не отправлено — после сохранения отправьте его ещё раз.'
    : reason === 'menu' ? 'Перед созданием обращения укажите вашу организацию.'
      : 'Чтобы мы понимали, кто обращается, укажите вашу организацию.';
  await middleware.reply(ctx, `${lead}\n\nОтправьте название одним сообщением (от ${ORG_MIN} до ${ORG_MAX} символов).`, html([[USER_HOME]]));
}

/** /start: ask once when the organization is unknown. Returns true when a prompt was shown. */
export async function promptIfMissing(ctx: Context): Promise<boolean> {
  const profile = await getProfile(ctx);
  if (!applies(ctx) || profile?.organization) return false;
  await askFirst(ctx, 'start');
  return true;
}

/**
 * Gate before any new ticket is created. ok=false means the client was asked
 * for the organization and no ticket must be created for this update.
 */
export async function requireForNewTicket(ctx: Context, reason: 'request' | 'menu' = 'request'): Promise<{ ok: boolean; organization: string | null | undefined }> {
  // undefined: not collected on this transport; the ticket keeps the legacy shape.
  if (!applies(ctx)) return { ok: true, organization: undefined };
  const profile = await db.getClientProfile(userKey(ctx), ctx.messenger);
  if (profile?.organization) return { ok: true, organization: profile.organization };
  await askFirst(ctx, reason);
  return { ok: false, organization: null };
}

/** Current declared organization for snapshotting into a ticket, without prompting. */
export async function currentOrganization(ctx: Context): Promise<string | null | undefined> {
  if (!applies(ctx)) return undefined;
  return (await db.getClientProfile(userKey(ctx), ctx.messenger))?.organization ?? null;
}

/**
 * Consumes ordinary private text only while an organization input is armed.
 * Commands never reach this value; media and callbacks are not text.
 */
export async function handleTextInput(ctx: Context): Promise<boolean> {
  if (!applies(ctx) || ctx.session?.admin) return false;
  const text = ctx.message?.text;
  if (typeof text !== 'string' || text.startsWith('/')) return false;
  const profile = await db.getClientProfile(userKey(ctx), ctx.messenger);
  if (!activeInput(profile)) return false;
  const value = normalizeOrganization(text);
  if (!value) {
    await middleware.reply(ctx, `Название организации не сохранено: нужно от ${ORG_MIN} до ${ORG_MAX} символов, одной строкой, с буквами или цифрами.`,
      html(profile!.org_input === 'edit'
        ? [[{ text: '✖️ Отмена', callback_data: `um:orgcancel:${profile!.org_input_version}` }], [USER_HOME]] : [[USER_HOME]]));
    return true;
  }
  const saved = await db.saveOrganization(userKey(ctx), ctx.messenger, profile!.org_input_version, value);
  if (!saved) {
    await middleware.reply(ctx, 'Ввод организации устарел. Откройте «🏢 Организация» в меню и повторите.', html([[USER_HOME]]));
    return true;
  }
  const next = profile!.org_input === 'first' ? '\n\nОрганизация пока не подтверждена. Теперь опишите вопрос одним сообщением; обращение попадёт в общую очередь.' : '\n\nНазвание отправлено на проверку администратору. До подтверждения новые обращения идут в общую очередь; прежние обращения не меняются.';
  await middleware.reply(ctx, `Организация сохранена: <b>${esc(value)}</b>${next}`, html([
    [{ text: '✏️ Изменить организацию', callback_data: 'um:orgedit:0' }], [USER_HOME],
  ]));
  return true;
}

/** «🏢 Организация» menu callbacks: um:org, um:orgedit, um:orgcancel:<version>. */
export async function handleCallback(ctx: Context, p: string[]): Promise<void> {
  if (!applies(ctx)) { await ctx.answerCbQuery('Недоступно.', true); return; }
  const user = userKey(ctx);
  if (p[1] === 'orgedit') {
    const profile = await db.startOrganizationInput(user, ctx.messenger, profile0(await db.getClientProfile(user, ctx.messenger)), new Date(Date.now() + EDIT_MS));
    await ctx.answerCbQuery();
    await middleware.reply(ctx, `Отправьте новое название организации одним сообщением (от ${ORG_MIN} до ${ORG_MAX} символов).`, html([
      [{ text: '✖️ Отмена', callback_data: `um:orgcancel:${profile?.org_input_version ?? 0}` }], [USER_HOME],
    ]));
    return;
  }
  if (p[1] === 'orgcancel') {
    const cancelled = await db.cancelOrganizationInput(user, ctx.messenger, Number(p[2]));
    await ctx.answerCbQuery(cancelled ? 'Изменение отменено.' : 'Кнопка устарела.', !cancelled);
    if (cancelled) await showOrganization(ctx, cancelled);
    return;
  }
  await ctx.answerCbQuery();
  await showOrganization(ctx, await db.getClientProfile(user, ctx.messenger));
}

/** First-entry prompts stay «first» so the follow-up hint is kept; otherwise it is an edit. */
function profile0(profile: db.IClientProfile | null): db.OrganizationInputMode {
  return profile?.organization ? 'edit' : 'first';
}

async function showOrganization(ctx: Context, profile: db.IClientProfile | null) {
  const current = profile?.organization
    ? `Заявленная организация: <b>${esc(profile.organization)}</b>\nСтатус: ${profile?.organization_verification === 'confirmed' ? 'подтверждено администратором' : profile?.organization_verification === 'rejected' ? 'привязка отклонена' : 'не подтверждено'}.`
    : 'Организация не указана.';
  await middleware.reply(ctx, current, html([
    [{ text: profile?.organization ? '✏️ Изменить организацию' : '✏️ Указать организацию', callback_data: 'um:orgedit:0' }], [USER_HOME],
  ]));
}
