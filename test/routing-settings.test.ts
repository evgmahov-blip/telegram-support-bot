const allowed=new Set(['admin']);
jest.mock('../src/team',()=>({canPerformAction:(actor:string,action:string)=>action==='manage_team'&&allowed.has(actor)}));
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readRoutingSettings, saveRoutingSetting } from '../src/routing-settings';
let dir:string,file:string;
beforeEach(async()=>{
  allowed.add('admin');dir=await fs.mkdtemp(path.join(os.tmpdir(),'routing-settings-'));file=path.join(dir,'config.yaml');
  await fs.writeFile(file,'# existing comment\nbot_token: FIXTURE_ONLY\nweb_chat:\n  business_hours:\n    enabled: true\n    start: "09:00"\n    end: "18:00"\n    timezone: Europe/Moscow\n    days: [1, 2, 3, 4, 5]\n',{mode:0o600});
});
afterEach(async()=>{await fs.rm(dir,{recursive:true,force:true});});
it('denies nonadmins before reading or writing',async()=>{
  await expect(readRoutingSettings('engineer',file)).rejects.toThrow('settings_forbidden');
  await expect(saveRoutingSetting('engineer','a'.repeat(24),'acceptance_minutes',20,file)).rejects.toThrow('settings_forbidden');
});
it('persists to the existing YAML, preserves unrelated fields/comments and records author/old/new',async()=>{
  const start=await readRoutingSettings('admin',file);
  const saved=await saveRoutingSetting('admin',start.etag,'acceptance_minutes',17,file);
  expect(saved.acceptance_minutes).toBe(17);expect(saved.schedule!.timezone).toBe('Europe/Moscow');
  expect(saved.history[0]).toMatchObject({actor:'admin',field:'acceptance_minutes',after:17});
  const raw=await fs.readFile(file,'utf8');expect(raw).toContain('# existing comment');expect(raw).toContain('bot_token: FIXTURE_ONLY');
  expect((await fs.stat(file)).mode&0o777).toBe(0o600);
  expect((await readRoutingSettings('admin',file)).acceptance_minutes).toBe(17);
});
it('replay of the same confirmation is idempotent; a different stale write is rejected',async()=>{
  const start=await readRoutingSettings('admin',file);
  await saveRoutingSetting('admin',start.etag,'acceptance_minutes',15,file);
  const replay=await saveRoutingSetting('admin',start.etag,'acceptance_minutes',15,file);
  expect(replay.history).toHaveLength(1);
  await expect(saveRoutingSetting('admin',start.etag,'acceptance_minutes',30,file)).rejects.toThrow('settings_stale');
});
it('allows one concurrent writer without lost updates',async()=>{
  const start=await readRoutingSettings('admin',file);
  const r=await Promise.allSettled([saveRoutingSetting('admin',start.etag,'acceptance_minutes',15,file),
    saveRoutingSetting('admin',start.etag,'acceptance_minutes',30,file)]);
  expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((await readRoutingSettings('admin',file)).history).toHaveLength(1);
});
it.each([0,-5,1441,1.5,'10'])('rejects bad minutes %p without changing the source',async(n)=>{
  const start=await readRoutingSettings('admin',file);
  await expect(saveRoutingSetting('admin',start.etag,'acceptance_minutes',n,file)).rejects.toThrow();
  expect((await readRoutingSettings('admin',file)).etag).toBe(start.etag);
});
it('validates reminder interval relative to the acceptance window and cannot disable required closure fields',async()=>{
  const start=await readRoutingSettings('admin',file);
  await expect(saveRoutingSetting('admin',start.etag,'reminder_before_minutes',10,file)).rejects.toThrow('invalid_reminder_minutes');
  await expect(saveRoutingSetting('admin',start.etag,'auto_close_tickets' as any,true,file)).rejects.toThrow('settings_field_denied');
  const saved=await saveRoutingSetting('admin',start.etag,'reminder_before_minutes',2,file);
  expect(saved.reminder_before_minutes).toBe(2);
});
it('refuses invalid schedules and lock uncertainty, without stealing a prior process lock',async()=>{
  const start=await readRoutingSettings('admin',file);
  await expect(saveRoutingSetting('admin',start.etag,'schedule',{...start.schedule,start:'25:00'},file)).rejects.toThrow('invalid_hours');
  await fs.writeFile(file+'.routing-lock','interrupted writer');
  await expect(saveRoutingSetting('admin',start.etag,'acceptance_minutes',20,file)).rejects.toThrow('settings_busy');
  expect((await readRoutingSettings('admin',file)).etag).toBe(start.etag);
});
it('rechecks role revocation on save',async()=>{
  const start=await readRoutingSettings('admin',file);allowed.delete('admin');
  await expect(saveRoutingSetting('admin',start.etag,'acceptance_minutes',20,file)).rejects.toThrow('settings_forbidden');
});
