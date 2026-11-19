import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as YAML from 'yaml';
import cache from '../src/cache';
import { StaffRole } from '../src/interfaces';
import { readTeamSettings, saveTeamMember, undoTeamChange } from '../src/team-settings';
const assignments = jest.fn().mockResolvedValue(false);
jest.mock('../src/db', () => ({ hasActiveStaffAssignments: (...args: unknown[]) => assignments(...args) }));
let dir: string, file: string;
const admin = { telegram_id: '1', name: 'Owner', role: StaffRole.ADMIN, active: true };
const other = { telegram_id: '2', name: 'Admin', role: StaffRole.ADMIN, active: true };
const agent = { telegram_id: '3', name: 'Engineer', role: StaffRole.AGENT, active: true };
beforeEach(async () => {
  assignments.mockResolvedValue(false);
  cache.config.owner_id = 1 as any;
  cache.staffMembers = new Map([admin,other,agent].map(m => [m.telegram_id, {...m}]));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-settings-')); file = path.join(dir,'config.yaml');
  await fs.writeFile(file, '# preserved\nstaff_roles:\n' + YAML.stringify([admin,other,agent]).split('\n').filter(Boolean).map(x => '  '+x).join('\n')+'\n', {mode:0o600});
});
afterEach(async () => { await fs.rm(dir, {recursive:true,force:true}); });
it.each(['3','4'])('rejects nonadmin %s before reading config', async actor => {
  await expect(readTeamSettings(actor,file)).rejects.toThrow('team_forbidden');
});
it('persists audited roles, preserves comments/mode and projects the sole source after restart', async () => {
  const s = await readTeamSettings('1',file);
  await saveTeamMember('1',s.etag,{...agent,role:StaffRole.SUPERVISOR},false,file);
  const saved = await readTeamSettings('1',file);
  expect(saved.history[0]).toMatchObject({actor:'1',before:agent,after:{...agent,role:'supervisor'}});
  expect(cache.staffMembers.get('3')?.role).toBe('supervisor');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(file,'utf8')).toContain('# preserved');
  cache.staffMembers.clear();
  const disk = YAML.parse(await fs.readFile(file,'utf8'));
  cache.staffMembers = new Map(disk.staff_roles.map((m: any) => [m.telegram_id,m]));
  expect((await readTeamSettings('1',file)).members.find(m=>m.telegram_id==='3')?.role).toBe('supervisor');
});
it('rejects stale and duplicate confirmation and concurrent changes', async () => {
  const s = await readTeamSettings('1',file);
  const result = await Promise.allSettled([
    saveTeamMember('1',s.etag,{...agent,role:StaffRole.SUPERVISOR},false,file),
    saveTeamMember('1',s.etag,{...agent,active:false},false,file),
  ]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await expect(saveTeamMember('1',s.etag,agent,false,file)).rejects.toThrow('team_stale');
});
it('protects owner and self role changes', async () => {
  const s = await readTeamSettings('1',file);
  await expect(saveTeamMember('2',s.etag,{...admin,active:false},false,file)).rejects.toThrow('team_owner_protected');
  await expect(saveTeamMember('2',s.etag,{...other,role:StaffRole.AGENT},false,file)).rejects.toThrow('team_self_change_denied');
});
it('requires verified identity and initial disabled agent; cannot grant by username', async () => {
  const s = await readTeamSettings('1',file), next = {...agent,telegram_id:'4',active:false};
  await expect(saveTeamMember('1',s.etag,next,false,file)).rejects.toThrow('team_identity_required');
  await expect(saveTeamMember('1',s.etag,{...next,telegram_id:'@username'},true,file)).rejects.toThrow('team_invalid');
  await expect(saveTeamMember('1',s.etag,{...next,active:true},true,file)).rejects.toThrow('team_identity_required');
  await saveTeamMember('1',s.etag,next,true,file);
  expect(cache.staffMembers.get('4')?.active).toBe(false);
});
it('blocks disable while accepted or offered work remains, then supports audited rollback', async () => {
  const s = await readTeamSettings('1',file); assignments.mockResolvedValue(true);
  await expect(saveTeamMember('1',s.etag,{...agent,active:false},false,file)).rejects.toThrow('team_has_assignments');
  expect((await readTeamSettings('1',file)).etag).toBe(s.etag);
  assignments.mockResolvedValue(false);
  await saveTeamMember('1',s.etag,{...agent,active:false},false,file);
  expect(cache.staffMembers.get('3')?.active).toBe(false);
  const next = await readTeamSettings('1',file); await undoTeamChange('1',next.etag,file);
  expect(cache.staffMembers.get('3')?.active).toBe(true);
  expect((await readTeamSettings('1',file)).history).toHaveLength(2);
});
it('rechecks durable authority even if runtime cache is stale', async () => {
  const doc = YAML.parse(await fs.readFile(file,'utf8')); doc.staff_roles[1].active=false;
  await fs.writeFile(file,YAML.stringify(doc));
  const s = await readTeamSettings('2',file);
  await expect(saveTeamMember('2',s.etag,{...agent,active:false},false,file)).rejects.toThrow('team_forbidden');
});

it('cannot remove the sole active administrator even when a stale cache claims another admin', async () => {
  const doc=YAML.parse(await fs.readFile(file,'utf8'));
  doc.staff_roles[0].active=false; await fs.writeFile(file,YAML.stringify(doc));
  const s=await readTeamSettings('2',file);
  await expect(saveTeamMember('2',s.etag,{...other,active:false},false,file)).rejects.toThrow(/team_self_change_denied|team_last_admin/);
  await expect(saveTeamMember('1',s.etag,{...other,role:StaffRole.AGENT},false,file)).rejects.toThrow('team_forbidden');
  expect((await readTeamSettings('2',file)).members.find(m=>m.telegram_id==='2')?.active).toBe(true);
});

it('rechecks revoked authority after waiting for the assignment database check', async () => {
  const s = await readTeamSettings('2', file);
  let release!: (value: boolean) => void;
  assignments.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
  const pending = saveTeamMember('2', s.etag, {...agent, active:false}, false, file);
  // Wait for the actual database gate, not a wall-clock timeout.
  while (!release) await new Promise(resolve => setImmediate(resolve));
  cache.staffMembers.set('2', {...other, active:false});
  release(false);
  await expect(pending).rejects.toThrow('team_forbidden');
  expect((await readTeamSettings('1', file)).etag).toBe(s.etag);
});

it('keeps an existing writer lock and makes no change while it is held', async () => {
  const s = await readTeamSettings('1', file);
  await fs.writeFile(file + '.routing-lock', 'another writer');
  await expect(saveTeamMember('1', s.etag, {...agent, active:false}, false, file)).rejects.toThrow('team_busy');
  expect(await fs.readFile(file + '.routing-lock', 'utf8')).toBe('another writer');
  expect((await readTeamSettings('1', file)).etag).toBe(s.etag);
});
