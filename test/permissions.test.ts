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
