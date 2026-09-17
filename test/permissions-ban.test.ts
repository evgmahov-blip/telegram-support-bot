const mockCheckBan = jest.fn();
const mockGetStaffRole = jest.fn().mockReturnValue(null);

jest.mock('../src/db', () => ({
  checkBan: mockCheckBan,
}));

jest.mock('../src/team', () => ({
  getStaffRole: mockGetStaffRole,
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: { staffchat_thread_id: null },
  },
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

import { checkPermissions } from '../src/permissions';
import { Messenger } from '../src/interfaces';

const makeCtx = (): any => ({
  chat: { id: 'user-1', type: 'private' },
  from: { id: 'user-1', username: 'user' },
  session: { admin: false, groupAdmin: null },
  messenger: Messenger.TELEGRAM,
});

const config: any = {
  categories: [],
  staffchat_id: 'staff-group',
};

describe('permission middleware ban enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks a separate UserBan record even though it has no ticket status', async () => {
    mockCheckBan.mockResolvedValue({ userid: 'user-1', messenger: 'telegram' });
    const next = jest.fn();

    await checkPermissions(makeCtx(), next, config);

    expect(next).not.toHaveBeenCalled();
  });

  it('continues when no ban record exists', async () => {
    mockCheckBan.mockResolvedValue(null);
    const next = jest.fn();

    await checkPermissions(makeCtx(), next, config);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
