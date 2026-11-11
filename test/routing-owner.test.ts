const rows = new Map<number,any>();
const profiles = new Map<string,any>();
const events = new Map<string,any>();
const clone = (v:any):any => v == null ? v : structuredClone(v);
function get(row:any,key:string) { return key.split('.').reduce((v,k)=>v?.[k],row); }
function matches(row:any,q:any):boolean {
  return Object.entries(q).every(([key,value]:any)=>{
    if(key==='$or')return value.some((x:any)=>matches(row,x));
    if(key==='$and')return value.every((x:any)=>matches(row,x));
    const v=get(row,key);
    if(value && typeof value==='object' && !Array.isArray(value)){
      if('$in' in value)return value.$in.includes(v);
      if('$ne' in value)return v!==value.$ne;
      if('$gt' in value)return v>value.$gt;
      if('$exists' in value)return (v!==undefined)===value.$exists;
    }
    return value===null ? v==null : v===value;
  });
}
function update(row:any,u:any) {
  for(const [key,value] of Object.entries(u.$set??{})) {
    const parts=key.split('.'),last=parts.pop()!;let target=row;
    for(const p of parts)target=target[p]??=( {} ); target[last]=clone(value);
  }
  for(const [key,n] of Object.entries(u.$inc??{})) row[key]=(row[key]??0)+(n as number);
  for(const [key,v] of Object.entries(u.$push??{})) (row[key]??=[]).push(clone(v));
}
jest.mock('../src/db',()=>({
  getClientProfile:jest.fn(async(u:string,m:string)=>clone(profiles.get(m+':'+u)??null)),
  getTicketById:jest.fn(async(id:number)=>clone(rows.get(id)??null)),
  recordRoutingEvent:jest.fn(async(id:string,type:string,ticketId:number,actor:string,metadata:any)=>{events.set(id,{type,ticketId,actor,metadata});}),
  ClientProfile:{findOneAndUpdate:jest.fn(async(q:any,u:any)=>{
    const row=profiles.get(q.messenger+':'+q.userid);
    if(!row||!matches(row,q))return null;update(row,u);return clone(row);
  })},
  Supportee:{
    findOneAndUpdate:jest.fn(async(q:any,u:any)=>{const row=rows.get(q.ticketId);if(!row||!matches(row,q))return null;update(row,u);return clone(row);}),
    updateOne:jest.fn(async(q:any,u:any)=>{const row=rows.get(q.ticketId);if(!row||!matches(row,q))return {matchedCount:0};update(row,u);return {matchedCount:1};}),
    find:jest.fn((q:any)=>({sort:()=>({limit:async(n:number)=>[...rows.values()].filter(row=>matches(row,q)).sort((a,b)=>a.ticketId-b.ticketId).slice(0,n).map(clone)})})),
  },
}));
jest.unmock('../src/team');
import cache from '../src/cache';
import * as routing from '../src/ticket-routing';
import * as visibility from '../src/ticket-visibility';
import { installOrganizationRoutingOwner } from '../src/routing-contract';
import { confirmClientOrganization, rejectClientOrganization } from '../src/client-organization-binding';
import type { RoutingOrgRef } from '../src/routing-contract';
const ref:RoutingOrgRef={authority:'support-bot',instance:'fixture-owner',id:'13345678-1234-4234-8234-123456789abc'};
const now=new Date('2026-11-06T07:00:00Z');
const owner=()=>({registeredInstance:ref.instance,ticketPartitioningReady:true,getOrganization:jest.fn(async()=>({
  org_ref:ref,owner_version:7,status:'active' as const,display_name:'Known client',
  primary_engineer:{principal_ref:'ainoc:staff:a',real_telegram_identity:'a'},
}))});
function offer(extra:any={}) {
  return {ticketId:1,status:'open',assigned_to:null,common_visible:false,...extra,
    routing:{...routing.commonRouting('fixture',now),state:'offered',offered_to:'a',deadline_at:new Date(+now+600000),
      first_offered_at:now,policy:routing.currentRoutingPolicy(),delivery:'pending',...extra.routing}};
}
beforeEach(()=>{
  rows.clear();profiles.clear();events.clear();jest.clearAllMocks();
  cache.staffMembers=new Map([
    ['a',{telegram_id:'a',name:'A',role:'agent'}],['b',{telegram_id:'b',name:'B',role:'agent'}],
    ['boss',{telegram_id:'boss',name:'Boss',role:'supervisor'}],['admin',{telegram_id:'admin',name:'Admin',role:'admin'}],
  ] as any);
  cache.config.staffchat_type='telegram' as any;
  cache.config.web_chat={business_hours:{enabled:false,start:'',end:'',timezone:'Europe/Moscow'}} as any;
  cache.config.routing={acceptance_minutes:10,reminder_before_minutes:null};
  installOrganizationRoutingOwner(null);
});
describe('exact client identity and routing plan',()=>{
  it('never matches a declaration by spelling, similarity, company name or username',async()=>{
    const o=owner();installOrganizationRoutingOwner(o);
    profiles.set('telegram:c',{organization:'Known cllent',organization_verification:'pending'});
    expect((await routing.planNewTicketRouting('c','telegram','Known cllent',now)).routing.state).toBe('common');
    expect(o.getOrganization).not.toHaveBeenCalled();
  });
  it('requires explicit human admin confirmation, exact identity and version',async()=>{
    installOrganizationRoutingOwner(owner());
    profiles.set('telegram:c',{messenger:'telegram',userid:'c',organization:'Known',organization_verification:'pending',org_input:null,org_binding_version:1});
    const input={actor:'admin',messenger:'telegram',userid:'c',declared:'Known',expectedVersion:1,orgRef:ref,humanVerified:true};
    expect(await confirmClientOrganization({...input,actor:'a'})).toBeNull();
    expect(await confirmClientOrganization({...input,humanVerified:false})).toBeNull();
    expect(await confirmClientOrganization({...input,declared:'Known typo'})).toBeNull();
    expect(await confirmClientOrganization({...input,messenger:'web'})).toBeNull();
    const results=await Promise.all([confirmClientOrganization(input),confirmClientOrganization(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await confirmClientOrganization(input)).toBeNull();
    expect(profiles.get('telegram:c').org_binding_audit[0]).toMatchObject({action:'confirmed',actor:'admin',platform:'telegram',user:'c'});
  });
  it('supports version zero on pre-existing unconfirmed profiles without resetting history',async()=>{
    installOrganizationRoutingOwner(owner());
    profiles.set('telegram:c',{messenger:'telegram',userid:'c',organization:'Known',org_input:null});
    const input={actor:'admin',messenger:'telegram',userid:'c',declared:'Known',expectedVersion:0,orgRef:ref,humanVerified:true};
    expect(await confirmClientOrganization(input)).toMatchObject({organization_verification:'confirmed',org_binding_version:1});
    expect(await confirmClientOrganization(input)).toBeNull();
  });
  it('routes a confirmed new request and stamps the current canonical owner version',async()=>{
    installOrganizationRoutingOwner(owner());
    profiles.set('telegram:c',{organization:'Known',organization_verification:'confirmed',confirmed_org_ref:ref,org_binding_version:2});
    const p=await routing.planNewTicketRouting('c','telegram','Known',now);
    expect(p).toMatchObject({organization_ref:ref,organization_owner_version:7,organization_binding_version:2,routing:{state:'offered',offered_to:'a'}});
    expect(p.routing.deadline_at).toEqual(new Date(+now+600000));
    expect((await routing.planNewTicketRouting('c','telegram','New declaration',now)).routing.state).toBe('common');
  });
  it('uses common on unavailable owner, inactive engineer or missing schedule without losing a ticket',async()=>{
    profiles.set('telegram:c',{organization:'Known',organization_verification:'confirmed',confirmed_org_ref:ref});
    expect((await routing.planNewTicketRouting('c','telegram','Known',now)).routing.state).toBe('common');
    installOrganizationRoutingOwner(owner());cache.staffMembers.get('a')!.active=false;
    expect((await routing.planNewTicketRouting('c','telegram','Known',now)).routing.state).toBe('common');
    cache.staffMembers.get('a')!.active=true;delete cache.config.web_chat.business_hours;
    expect((await routing.planNewTicketRouting('c','telegram','Known',now)).routing.state).toBe('common');
  });
  it('can reject pending confirmation without granting membership or touching old tickets',async()=>{
    profiles.set('telegram:c',{messenger:'telegram',userid:'c',organization:'Known',organization_verification:'pending',org_input:null,org_binding_version:1});
    rows.set(1,{ticketId:1,declared_organization:'Historical'});
    expect(await rejectClientOrganization('a','telegram','c',1)).toBeNull();
    expect(await rejectClientOrganization('admin','telegram','c',1)).toMatchObject({organization_verification:'rejected'});
    expect(rows.get(1).declared_organization).toBe('Historical');
  });
});
describe('CAS routing ownership and scope',()=>{
  it('shows an offer only to its recipient and managers, despite its null work owner',()=>{
    const t=offer();
    expect(visibility.isCommonTicket(t)).toBe(false);
    expect(visibility.canViewTicket('a',t)).toBe(true);
    expect(visibility.canViewTicket('b',t)).toBe(false);
    expect(visibility.canViewTicket('boss',t)).toBe(true);
  });
  it('rejects a forged take and a stale callback; accepting disables the timeout',async()=>{
    rows.set(1,offer());
    expect(await routing.routingCommand(1,'b',1,'take',undefined,now)).toBeNull();
    const taken=await routing.routingCommand(1,'a',1,'take',undefined,now);
    expect(taken).toMatchObject({assigned_to:'a',routing:{state:'accepted',deadline_at:null,reminder:'disabled'}});
    expect(await routing.routingCommand(1,'a',1,'take',undefined,now)).toBeNull();
    await routing.maintainRouting(new Date(+now+3600000),jest.fn());
    expect(rows.get(1).assigned_to).toBe('a');
  });
  it('allows one winner when two engineers atomically take the common queue',async()=>{
    rows.set(1,{ticketId:1,status:'open',assigned_to:null,routing:routing.commonRouting('fixture',now)});
    const taken=await Promise.all([routing.routingCommand(1,'a',1,'take',undefined,now),routing.routingCommand(1,'b',1,'take',undefined,now)]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect(['a','b']).toContain(rows.get(1).assigned_to);
  });
  it('expires exactly at the ten-minute boundary, never accepting at or after the deadline',async()=>{
    rows.set(1,offer());
    const at=new Date(+now+600000);
    const [take]=await Promise.all([routing.routingCommand(1,'a',1,'take',undefined,at),routing.maintainRouting(at,jest.fn())]);
    expect(take).toBeNull();
    expect(rows.get(1)).toMatchObject({assigned_to:null,routing:{state:'common'}});
    expect(rows.get(1).routing.audit.at(-1).reason).toBe('acceptance_timeout');
  });
  it('preserves deadline and policy across transfers and changing current configuration',async()=>{
    rows.set(1,offer());cache.config.routing!.acceptance_minutes=60;
    const moved=await routing.routingCommand(1,'a',1,'transfer','b',new Date(+now+300000));
    expect(moved!.routing!.deadline_at).toEqual(new Date(+now+600000));
    expect(moved!.routing!.policy!.acceptance_minutes).toBe(10);
    expect(await routing.routingCommand(1,'a',2,'take',undefined,now)).toBeNull();
    expect((await routing.routingCommand(1,'b',2,'take',undefined,now))!.assigned_to).toBe('b');
  });
  it('bounds repeated transfer chains and publishes to common',async()=>{
    rows.set(1,offer({routing:{transfers:3}}));
    const moved=await routing.routingCommand(1,'a',1,'transfer','b',now);
    expect(moved!.routing!.state).toBe('common');
    expect(moved!.routing!.audit.at(-1)!.reason).toBe('transfer_limit');
    expect(moved!.common_return_notice).toBeUndefined();
  });
  it('commits a pending feed record with each explicit return, keyed by the new routing version',async()=>{
    rows.set(1,{ticketId:1,status:'open',assigned_to:null,routing:routing.commonRouting('fixture',now)});
    const taken=await routing.routingCommand(1,'a',1,'take',undefined,now);
    expect(taken!.common_return_notice).toBeUndefined();
    const back=await routing.routingCommand(1,'a',2,'common',undefined,now);
    expect(back).toMatchObject({assigned_to:null,common_visible:false,routing:{state:'common',version:3},
      common_return_notice:{key:'r3',state:'pending',attempts:0}});
    expect(await routing.routingCommand(1,'a',2,'common',undefined,now)).toBeNull();
    await routing.routingCommand(1,'b',3,'take',undefined,now);
    expect((await routing.routingCommand(1,'b',4,'common',undefined,now))!.common_return_notice!.key).toBe('r5');
  });
  it('a system fallback to common does not claim an explicit return record',async()=>{
    rows.set(1,offer());
    await routing.maintainRouting(new Date(+now+600000),jest.fn());
    expect(rows.get(1).routing.state).toBe('common');
    expect(rows.get(1).common_return_notice).toBeUndefined();
  });
  it('disabled engineer falls back with audit; accepted work remains assigned',async()=>{
    rows.set(1,offer());cache.staffMembers.get('a')!.active=false;
    await routing.maintainRouting(now,jest.fn());
    expect(rows.get(1).routing.audit.at(-1).reason).toBe('engineer_disabled');
  });
});
describe('delivery claims, UNKNOWN and restart-safe maintenance',()=>{
  it.each(['null','transport','crashed'])('does not blindly resend a %s delivery',async(kind)=>{
    rows.set(1,offer({routing:kind==='crashed'?{delivery:'sending'}:{}}));
    const send=jest.fn(async()=>{if(kind==='transport')throw new Error('timeout');return null;});
    await routing.maintainRouting(now,send);await routing.maintainRouting(new Date(+now+1000),send);
    expect(send).toHaveBeenCalledTimes(kind==='crashed'?0:1);
    expect(rows.get(1).routing.state).toBe('offered');
    await routing.maintainRouting(new Date(+now+600000),send);
    expect(rows.get(1).routing.state).toBe('common');
    expect(events.size).toBe(2);
  });
  it('publishes immediately on confirmed non-delivery',async()=>{
    rows.set(1,offer());const send=jest.fn(async()=>{throw {error_code:403,description:'bot was blocked by the user'};});
    await routing.deliverOffer(rows.get(1),send,now);
    expect(rows.get(1).routing.state).toBe('common');expect(send).toHaveBeenCalledTimes(1);
    expect(rows.get(1).routing.audit.at(-1).reason).toBe('offer_undelivered');
  });
  it('does not release work accepted while an offer send is in flight, even on late non-delivery',async()=>{
    rows.set(1,offer());
    const send=jest.fn(async()=>{
      const current=rows.get(1);
      expect(await routing.routingCommand(1,'a',current.routing.version,'take',undefined,now)).not.toBeNull();
      throw {error_code:403,description:'bot was blocked by the user'};
    });
    await routing.deliverOffer(rows.get(1),send,now);
    expect(rows.get(1)).toMatchObject({assigned_to:'a',routing:{state:'accepted',deadline_at:null}});
  });
  it('reminds at most once even across repeated maintenance after restart',async()=>{
    rows.set(1,offer({routing:{delivery:'delivered',reminder:'pending',reminder_at:new Date(+now+480000)}}));
    const send=jest.fn(async()=> '123');
    await routing.maintainRouting(new Date(+now+480000),send);
    await routing.maintainRouting(new Date(+now+490000),send);
    expect(send).toHaveBeenCalledTimes(1);expect(rows.get(1).routing.reminder).toBe('sent');
    expect(rows.get(1).routing.deadline_at).toEqual(new Date(+now+600000));
  });
});
