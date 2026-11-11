import cache from './cache';
import * as team from './team';
import * as db from './db';
import * as middleware from './middleware';
import * as visibility from './ticket-visibility';
import * as routing from './ticket-routing';
import { readRoutingSettings, saveRoutingSetting } from './routing-settings';
import type { SettingField } from './routing-settings';
import { validateSchedule } from './routing-policy';
import { refreshStaffCard, refreshPrivateRoutingPanel, answer, publishCommonReturn } from './ticket-ui';
import { Messenger, Context } from './interfaces';

const esc = (v: unknown) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const back = [{ text: '⬅️ Настройки', callback_data: 'cfg:home' }, { text: '🏠 Главная', callback_data: 'tm:home:0' }];
const privateStaff = (ctx: Context) => ctx.messenger === Messenger.TELEGRAM && ctx.chat?.type === 'private'
  && String(ctx.chat.id) === String(ctx.from.id) && routing.activeEngineer(String(ctx.from.id));
async function screen(ctx: Context, text: string, rows: Array<Array<{text: string; callback_data: string}>>) {
  await middleware.reply(ctx, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}
export async function handleRoutingCallback(ctx: Context): Promise<boolean> {
  const p = String(ctx.callbackQuery?.data ?? '').split(':');
  if (p[0] !== 'rt') return false;
  const actor = String(ctx.from.id), id = Number(p[2]), version = Number(p[3]);
  if (!privateStaff(ctx) || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(version) || version < 1) {
    await ctx.answerCbQuery('Доступно зарегистрированному инженеру в личном чате.', true); return true;
  }
  const t = await db.getTicketById(id, null);
  if (!t || !visibility.canViewTicket(actor,t) || t.routing?.version !== version) {
    await ctx.answerCbQuery('Заявка недоступна или кнопка устарела.', true); return true;
  }
  if (p[1] === 'transfer') {
    if (t.routing?.offered_to !== actor && t.assigned_to !== actor && !team.canPerformAction(actor,'assign')) {
      await ctx.answerCbQuery('Нет прав на передачу.',true); return true;
    }
    const rows = [...cache.staffMembers.values()].filter(m => m.telegram_id !== actor && routing.activeEngineer(m.telegram_id))
      .slice(0,40).map(m => [{ text: m.name, callback_data: 'rt:to:' + id + ':' + version + ':' + m.telegram_id }]);
    rows.push([{ text: 'Отмена', callback_data: 'tm:mine:0' }]);
    await ctx.answerCbQuery(); await answer(ctx,'Кому предложить заявку № ' + id + '? Срок текущего предложения не продлевается.',rows); return true;
  }
  const action = p[1] === 'to' ? 'transfer' : p[1];
  if (!['take','transfer','common'].includes(action)) { await ctx.answerCbQuery('Неизвестное действие.',true);return true; }
  const changed = await routing.routingCommand(id,actor,version,action as 'take'|'transfer'|'common',p[4]);
  if (!changed) { await ctx.answerCbQuery('Состояние, срок или полномочия изменились.',true); return true; }
  await routing.flushRoutingAudit(changed);
  if (changed.routing?.state === 'offered') await routing.deliverOffer(changed);
  if (action === 'common') await publishCommonReturn(id); else await refreshStaffCard(id);
  await refreshPrivateRoutingPanel(ctx, id);
  await ctx.answerCbQuery(changed.routing?.state === 'accepted' ? 'Заявка взята в работу.' : changed.routing?.state === 'common' ? 'Заявка в общей очереди.' : 'Предложение передано.');
  return true;
}
export async function handleAdminCallback(ctx: Context): Promise<boolean> {
  const p = String(ctx.callbackQuery?.data ?? '').split(':');
  if (p[0] !== 'cfg') return false;
  const actor = String(ctx.from.id);
  if (!team.canPerformAction(actor,'manage_team')) { await ctx.answerCbQuery('Настройки доступны администратору.',true);return true; }
  if (!privateStaff(ctx)) {
    await visibility.sendToStaffPrivate(actor,'⚙️ Настройки доступны в личном чате с ботом.',{
      reply_markup: { inline_keyboard: [[{text:'⚙️ Настройки',callback_data:'cfg:home'}]] } });
    await ctx.answerCbQuery('Откройте настройки в личном чате с ботом.'); return true;
  }
  try {
    const s = await readRoutingSettings(actor);
    if (p[1] === 'schedule-save' || p[1] === 'timezone-save' || p[1] === 'always-save') {
      if (p[p.length-1] !== s.etag) throw new Error('settings_stale');
      if (p[1] === 'timezone-save') await saveRoutingSetting(actor,s.etag,'timezone',decodeURIComponent(p[2]));
      else {
        if (!s.schedule?.timezone) throw new Error('schedule_timezone_required');
        const schedule = p[1] === 'always-save' ? { ...s.schedule,enabled:false } : validateSchedule({
          ...s.schedule,enabled:true,days:[0,1,2,3,4,5,6].filter(d => (Number(p[2]) & (1 << d)) !== 0),
          start:p[3].slice(0,2)+':'+p[3].slice(2),end:p[4].slice(0,2)+':'+p[4].slice(2),
        });
        await saveRoutingSetting(actor,s.etag,'schedule',schedule);
      }
      await ctx.answerCbQuery('Сохранено. Только для новых предложений.');return true;
    }
    if (p[1] === 'restore' || p[1] === 'undo') {
      if (p[3] !== s.etag) throw new Error('settings_stale');
      const h=s.history.find(x=>x.id===p[2]);
      if (!h || (h.before===null && h.field!=='reminder_before_minutes')) throw new Error('settings_previous_value_unavailable');
      if (p[1] === 'undo') {
        await saveRoutingSetting(actor,s.etag,h.field,h.before);await ctx.answerCbQuery('Прежнее значение восстановлено для новых предложений.');return true;
      }
      await ctx.answerCbQuery();
      await screen(ctx,'Вернуть прежнее значение '+esc(h.field)+': '+esc(JSON.stringify(h.before))+'?\nСроки существующих предложений сохраняются.',
        [[{text:'✅ Вернуть',callback_data:'cfg:undo:'+h.id+':'+s.etag}],[{text:'Отмена',callback_data:'cfg:home'}]]);return true;
    }
    if (p[1] === 'schedule' || p[1] === 'always') {
      await ctx.answerCbQuery();
      if (p[1] === 'always') {
        if (!s.schedule?.timezone) throw new Error('schedule_timezone_required');
        await screen(ctx,'Установить круглосуточную поддержку 24/7? Только новые предложения.',
          [[{text:'✅ 24/7',callback_data:'cfg:always-save:'+s.etag}],[{text:'Отмена',callback_data:'cfg:home'}]]);return true;
      }
      await screen(ctx,'Рабочее расписание: '+esc(JSON.stringify(s.schedule))+
        '\nЧасовой пояс: '+esc(s.schedule?.timezone??'не задан')+
        '\nДни: 0=воскресенье, 1=понедельник, …, 6=суббота. Часы вводятся в указанном часовом поясе.'+
        '\nИзменить: /routing_schedule ДНИ ЧЧ:ММ ЧЧ:ММ'+
        '\nЧасовой пояс: /routing_timezone IANA_ZONE\nНовые правила относятся только к новым предложениям.',
      [[{text:'Установить 24/7',callback_data:'cfg:always'}],back]);return true;
    }
    if (p[1] === 'save') {
      const field = p[2] as SettingField, input = p[3] === 'off' ? null : Number(p[3]);
      if (!['acceptance_minutes','reminder_before_minutes'].includes(field)) throw new Error('settings_field_denied');
      await saveRoutingSetting(actor,p[4],field,input);
      await ctx.answerCbQuery('Сохранено. Новое правило действует на новые предложения.'); return true;
    }
    await ctx.answerCbQuery();
    if (p[1] === 'preview') {
      const field = p[2] as SettingField, n = p[3] === 'off' ? 'off' : String(Number(p[3]));
      if (!['acceptance_minutes','reminder_before_minutes'].includes(field) || p[4] !== s.etag) throw new Error('settings_stale');
      await screen(ctx,'Изменить ' + (field === 'acceptance_minutes' ? 'время принятия' : 'напоминание')
        + ' на ' + esc(n === 'off' ? 'выключено' : n + ' мин') + '?\nТолько новые предложения. Уже ожидающие сохранят прежний срок; взятые заявки не освобождаются.',
      [[{text:'✅ Подтвердить',callback_data:'cfg:save:' + field + ':' + n + ':' + s.etag}], [{text:'Отмена',callback_data:'cfg:home'}]]); return true;
    }
    if (p[1] === 'timeout' || p[1] === 'reminder') {
      const field: SettingField = p[1] === 'timeout' ? 'acceptance_minutes' : 'reminder_before_minutes';
      const presets: Array<number|'off'> = p[1] === 'timeout' ? [5,10,15,30] : ['off',1,2,5];
      await screen(ctx, p[1] === 'timeout'
        ? 'Время принятия: ' + s.acceptance_minutes + ' рабочих минут. Это срок ответа на предложение, а не решения заявки.\nДругой интервал: /routing_timeout МИНУТЫ'
        : 'Напоминание: ' + (s.reminder_before_minutes === null ? 'выключено' : 'за ' + s.reminder_before_minutes + ' рабочих минут') + '.\nДругой интервал: /routing_reminder МИНУТЫ',
      [...presets.map(n => [{text:n === 'off'?'Выключить':String(n)+' мин',callback_data:'cfg:preview:' + field + ':' + n + ':' + s.etag}]),back]); return true;
    }
    if (p[1] === 'bindings') {
      const profiles = await db.ClientProfile.find({ organization_verification: { $ne:'confirmed' }, organization: { $ne:null } })
        .sort({ organization_updated_at:1 }).limit(20).lean();
      await screen(ctx,'Ожидающие проверки (до 20):\n' + profiles.map(x => esc(x.messenger + ':' + x.userid) + ' — ' + esc(x.organization)).join('\n')
        + '\n\nПодтверждение требует точного OrgRef и проверки доверенного контакта человеком. Канонический owner организаций пока не подключён; создание организаций недоступно.',[back]);return true;
    }
    const bh = s.schedule;
    await screen(ctx,'⚙️ Настройки\nВремя принятия: ' + s.acceptance_minutes + ' рабочих минут.\nНапоминание: '
      + (s.reminder_before_minutes === null ? 'выключено' : 'за ' + s.reminder_before_minutes + ' мин') + '.\nРасписание: '
      + (bh ? esc(JSON.stringify({enabled:bh.enabled,days:bh.days,start:bh.start,end:bh.end,timezone:bh.timezone})) : 'не задано — часы поддержки не предполагаются')
      + '\nМеняются только новые предложения. Причина и выполненные работы при закрытии обязательны.',
    [[{text:'Время принятия',callback_data:'cfg:timeout'},{text:'Напоминание',callback_data:'cfg:reminder'}],
      [{text:'Рабочее расписание',callback_data:'cfg:schedule'}],
      [{text:'Организации → ответственные / привязки',callback_data:'cfg:bindings'}],
      ...(s.history.length && (s.history.at(-1)!.before!==null || s.history.at(-1)!.field==='reminder_before_minutes')
        ? [[{text:'Вернуть предыдущее значение',callback_data:'cfg:restore:'+s.history.at(-1)!.id+':'+s.etag}]] : []),back]); return true;
  } catch (err) {
    const code = (err as Error).message;
    await screen(ctx,'Изменение не подтверждено: ' + esc(code) + '. Проверьте актуальное значение в настройках.',[back]);
    return true;
  }
}
export async function handleSettingsCommand(ctx: Context, kind: 'acceptance_minutes' | 'reminder_before_minutes'): Promise<void> {
  const actor = String(ctx.from.id);
  if (!privateStaff(ctx) || !team.canPerformAction(actor,'manage_team')) { await middleware.reply(ctx,'Настройки доступны администратору в личном чате.');return; }
  const n = String(ctx.message?.text ?? '').trim().split(/\s+/)[1];
  if (!/^\d{1,4}$/.test(n ?? '')) { await middleware.reply(ctx,'Введите целое количество минут.');return; }
  const s = await readRoutingSettings(actor);
  await screen(ctx,'Подтвердите ' + n + ' мин. Изменение применяется только к новым предложениям.',[
    [{text:'✅ Подтвердить',callback_data:'cfg:save:' + kind + ':' + Number(n) + ':' + s.etag}],[{text:'Отмена',callback_data:'cfg:home'}],
  ]);
}

export async function handleScheduleCommand(ctx: Context, timezoneOnly=false): Promise<void> {
  const actor=String(ctx.from.id);
  if (!privateStaff(ctx) || !team.canPerformAction(actor,'manage_team')) { await middleware.reply(ctx,'Настройки доступны администратору в личном чате.');return; }
  try {
    const s=await readRoutingSettings(actor), args=String(ctx.message?.text??'').trim().split(/\s+/);
    let data:string, preview:string;
    if (timezoneOnly) {
      const zone=args[1]; if(!zone || zone.length>32) throw new Error('invalid_timezone');
      new Intl.DateTimeFormat('en',{timeZone:zone}).format(0);
      data='cfg:timezone-save:'+encodeURIComponent(zone)+':'+s.etag;
      preview='Часовой пояс: '+zone;
    } else {
      if(!s.schedule?.timezone) throw new Error('Сначала задайте часовой пояс командой /routing_timezone');
      if(!/^[0-6](?:,[0-6])*$/.test(args[1]??'') || !args[2] || !args[3]) throw new Error('Формат: /routing_schedule 1,2,3,4,5 09:00 18:00');
      const days=args[1].split(',').map(Number);
      const schedule=validateSchedule({...s.schedule,enabled:true,days,start:args[2],end:args[3]});
      const mask=days.reduce((n,d)=>n|(1<<d),0);
      data='cfg:schedule-save:'+mask+':'+args[2].replace(':','')+':'+args[3].replace(':','')+':'+s.etag;
      preview='Расписание: '+JSON.stringify(schedule);
    }
    if(Buffer.byteLength(data)>64)throw new Error('Значение слишком длинное для подтверждения Telegram');
    await screen(ctx,esc(preview)+'\nПрименится только к новым предложениям. Подтвердить?',[
      [{text:'✅ Подтвердить',callback_data:data}],[{text:'Отмена',callback_data:'cfg:home'}],
    ]);
  } catch(err) { await middleware.reply(ctx,'Настройки не изменены: '+(err as Error).message); }
}
