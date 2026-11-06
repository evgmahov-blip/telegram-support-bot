import { businessDeadline, isBusinessTime, validateRoutingPolicy, validateSchedule } from '../src/routing-policy';
const week = { enabled:true,start:'09:00',end:'18:00',timezone:'Europe/Moscow',days:[1,2,3,4,5] };
describe('business-time offer deadlines', () => {
  it('counts ten actual working minutes and preserves seconds', () => {
    expect(businessDeadline(new Date('2026-11-06T06:01:30.100Z'),10,week).toISOString()).toBe('2026-11-06T06:11:30.100Z');
  });
  it('pauses at closing and weekends, resuming on the next configured day', () => {
    expect(businessDeadline(new Date('2026-11-06T14:55:00Z'),10,week).toISOString()).toBe('2026-11-09T06:05:00.000Z');
    expect(isBusinessTime(new Date('2026-11-06T15:00:00Z'),week)).toBe(false);
  });
  it('waits before opening and supports overnight shifts attached to the start day', () => {
    expect(businessDeadline(new Date('2026-11-06T05:00:00Z'),10,week).toISOString()).toBe('2026-11-06T06:10:00.000Z');
    const overnight={...week,start:'22:00',end:'06:00',days:[5]};
    expect(isBusinessTime(new Date('2026-11-06T23:00:00Z'),overnight)).toBe(true);
    expect(isBusinessTime(new Date('2026-11-07T20:00:00Z'),overnight)).toBe(false);
  });
  it.each([
    ['2026-03-29T00:55:00Z','2026-03-29T01:05:00.000Z'],
    ['2026-10-25T00:55:00Z','2026-10-25T01:05:00.000Z'],
  ])('uses real UTC intervals through DST at %s',(start,end) => {
    expect(businessDeadline(new Date(start),10,{enabled:true,start:'01:00',end:'04:00',timezone:'Europe/Berlin',days:[0]}).toISOString()).toBe(end);
  });
  it('accepts explicitly configured 24/7 without inventing it for absent configuration', () => {
    expect(businessDeadline(new Date('2026-11-06T15:00:00Z'),10,{...week,enabled:false}).toISOString()).toBe('2026-11-06T15:10:00.000Z');
    expect(()=>validateSchedule(undefined as any)).toThrow('schedule_unconfigured');
  });
  it.each([0,-1,1.5,1441,NaN,'10'])('rejects bad acceptance interval %p',n=>{
    expect(()=>validateRoutingPolicy({acceptance_minutes:n as number,reminder_before_minutes:null,schedule:week})).toThrow();
  });
  it.each([0,10,11,-1,1.2])('rejects bad reminder interval %p',n=>{
    expect(()=>validateRoutingPolicy({acceptance_minutes:10,reminder_before_minutes:n,schedule:week})).toThrow();
  });
  it.each([{start:'24:00'},{end:'18:99'},{days:[]},{days:[1,1]},{days:[7]},{start:'09:00',end:'09:00'},{timezone:'No/SuchZone'}])('rejects invalid schedule %p',delta=>{
    expect(()=>validateSchedule({...week,...delta})).toThrow();
  });
});
