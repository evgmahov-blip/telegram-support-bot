import { withStaffAccess } from '../src/staff-access-gate';
it('waits for in-flight assignment before revocation and fences later requests', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const assignment = withStaffAccess('read', async () => { order.push('assign'); await waiting; order.push('assigned'); });
  const disable = withStaffAccess('write', async () => { order.push('disable'); });
  const stale = withStaffAccess('read', async () => { order.push('recheck'); });
  await Promise.resolve(); expect(order).toEqual(['assign']);
  release(); await Promise.all([assignment,disable,stale]);
  expect(order).toEqual(['assign','assigned','disable','recheck']);
});
it('supports nested write, releases failures, and rejects unsafe read upgrade', async () => {
  await withStaffAccess('write', () => withStaffAccess('write', async () => undefined));
  await expect(withStaffAccess('read', () => withStaffAccess('write', async () => undefined))).rejects.toThrow('team_gate_upgrade_denied');
  await expect(withStaffAccess('write', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  await withStaffAccess('read', async () => undefined);
});
