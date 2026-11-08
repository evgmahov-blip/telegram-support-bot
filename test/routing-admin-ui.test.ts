const read=jest.fn(),save=jest.fn(),reply=jest.fn(),dm=jest.fn();
const ticket=jest.fn();
jest.mock('../src/routing-settings',()=>({readRoutingSettings:(...a:any[])=>read(...a),saveRoutingSetting:(...a:any[])=>save(...a)}));
jest.mock('../src/team',()=>({getStaffRole:(id:string)=>id==='admin'?'admin':['a','b'].includes(id)?'agent':null,
  canPerformAction:(id:string,a:string)=>id==='admin'&&a==='manage_team'}));
jest.mock('../src/ticket-ui',()=>({refreshStaffCard:jest.fn(),refreshPrivateRoutingPanel:jest.fn(),answer:(c:any,t:any,r:any)=>reply(c,t,{parse_mode:'HTML',reply_markup:{inline_keyboard:r}})}));
jest.mock('../src/middleware',()=>({reply:(...a:any[])=>reply(...a),sendMessage:jest.fn()}));
jest.mock('../src/ticket-visibility',()=>({sendToStaffPrivate:(...a:any[])=>dm(...a),
  canViewTicket:(id:string,t:any)=>id==='admin'||t.routing?.offered_to===id||t.assigned_to===id}));
jest.mock('../src/db',()=>({getTicketById:(...a:any[])=>ticket(...a),ClientProfile:{find:jest.fn()}}));
import cache from '../src/cache';
import { handleAdminCallback, handleRoutingCallback } from '../src/routing-admin-ui';
const etag='a'.repeat(24);
function ctx(data:string,id='admin',group=false):any {return {from:{id},chat:{id:group?'-1001':id,type:group?'supergroup':'private'},messenger:'telegram',
  callbackQuery:{data},answerCbQuery:jest.fn().mockResolvedValue(undefined)};}
beforeEach(()=>{
  jest.clearAllMocks();cache.staffMembers=new Map([['admin',{telegram_id:'admin',role:'admin',name:'Admin'}],['a',{telegram_id:'a',role:'agent',name:'A'}],['b',{telegram_id:'b',role:'agent',name:'B'}]] as any);
  read.mockResolvedValue({etag,acceptance_minutes:10,reminder_before_minutes:null,schedule:null,history:[]});
  ticket.mockResolvedValue({ticketId:1,assigned_to:null,routing:{state:'offered',offered_to:'a',version:2}});
});
it('denies forged administrator callbacks before any settings read/write',async()=>{
  await handleAdminCallback(ctx('cfg:save:acceptance_minutes:15:'+etag,'a'));
  expect(read).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(reply).not.toHaveBeenCalled();
});
it('does not render personal settings or client bindings in a shared group',async()=>{
  await handleAdminCallback(ctx('cfg:bindings','admin',true));
  expect(read).not.toHaveBeenCalled();expect(reply).not.toHaveBeenCalled();expect(dm).toHaveBeenCalledTimes(1);
});
it('shows current values and no generated callback exceeds Telegram 64-byte limit',async()=>{
  for(const data of ['cfg:home','cfg:timeout','cfg:reminder'])await handleAdminCallback(ctx(data));
  for(const call of reply.mock.calls)for(const row of call[2].reply_markup.inline_keyboard)for(const b of row)
    expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  expect(reply.mock.calls[0][1]).toContain('10 рабочих минут');
  expect(reply.mock.calls[0][1]).toContain('не задано');
});
it('rejects stale preview without writing and cancel just reads the current menu',async()=>{
  await handleAdminCallback(ctx('cfg:preview:acceptance_minutes:15:'+'b'.repeat(24)));
  await handleAdminCallback(ctx('cfg:home'));
  expect(save).not.toHaveBeenCalled();
});
it('keeps another engineer from taking or inspecting an offered ticket',async()=>{
  const c=ctx('rt:take:1:2','b');await handleRoutingCallback(c);
  expect(c.answerCbQuery).toHaveBeenCalledWith('Заявка недоступна или кнопка устарела.',true);
});
it('refuses routing callbacks in a group and after staff disablement',async()=>{
  const c=ctx('rt:take:1:2','a',true);await handleRoutingCallback(c);expect(ticket).not.toHaveBeenCalled();
  cache.staffMembers.get('a')!.active=false;await handleRoutingCallback(ctx('rt:take:1:2','a'));expect(ticket).not.toHaveBeenCalled();
});
