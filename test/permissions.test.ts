import { checkPermissions, checkRights } from '../src/permissions';
import * as db from '../src/db';

// --- Permissions Module Tests --- //
describe('Permissions Module', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkRights', () => {
    it('should grant permission when a matching category is found', async () => {
      const ctx: any = { chat: { id: 'group1', type: 'group' }, session: {}, from: { username: 'user1' } };
      const config = { categories: [{ group_id: 'group1', name: 'Test' }], staffchat_id: 'staff1' };
      const result = await checkRights(ctx, config);
      expect(result).toBe(true);
      expect(ctx.session.groupAdmin).toBe('Test');
    });

    it('should deny permission if no matching group exists', async () => {
      const ctx: any = { chat: { id: 'group2', type: 'group' }, session: {} };
      const config = { categories: [{ group_id: 'group1', name: 'Test' }], staffchat_id: 'staff1' };
      const result = await checkRights(ctx, config);
      expect(result).toBe(false);
    });
  });

  it('does not resolve until downstream middleware has completed', async () => {
    jest.spyOn(db, 'checkBan').mockResolvedValue(null);
    let releaseDownstream: (() => void) | undefined;
    const next = jest.fn(() => new Promise<void>((resolve) => {
      releaseDownstream = resolve;
    }));
    const ctx: any = {
      chat: { id: 'user1', type: 'private' },
      session: {},
      from: { id: 'user1', username: 'user1' },
      messenger: 'telegram',
    };
    const config: any = { categories: [], staffchat_id: 'staff1' };

    let settled = false;
    const pending = checkPermissions(ctx, next, config).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseDownstream?.();
    await pending;
    expect(settled).toBe(true);
  });
});

import cache from '../src/cache';
it('does not treat presence in staffchat or a stale session as staff authority', async () => {
  const ctx: any = { from:{id:999}, chat:{id:'staff1',type:'supergroup'}, session:{admin:true,staffRole:'admin'}, messenger:'telegram' };
  const next=jest.fn();
  await checkPermissions(ctx,next,{categories:[],staffchat_id:'staff1'} as any);
  expect(ctx.session.admin).toBe(false); expect(ctx.session.staffRole).toBeUndefined();
});
it('refreshes active role on every DM entry and revokes it on the next update', async () => {
  const ctx: any = { from:{id:999}, chat:{id:999,type:'private'}, session:{}, messenger:'telegram' };
  cache.staffMembers.set('999',{telegram_id:'999',name:'Test',role:'agent',active:true} as any);
  try {
    await checkPermissions(ctx,jest.fn(),{categories:[],staffchat_id:'staff1'} as any);
    expect(ctx.session.admin).toBe(true); expect(ctx.session.staffRole).toBe('agent');
    cache.staffMembers.get('999').active=false;
    await checkPermissions(ctx,jest.fn(),{categories:[],staffchat_id:'staff1'} as any);
    expect(ctx.session.admin).toBe(false); expect(ctx.session.staffRole).toBeUndefined();
  } finally { cache.staffMembers.delete('999'); }
});
