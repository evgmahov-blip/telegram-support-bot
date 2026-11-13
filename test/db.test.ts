// test/mocks.ts (jest setupFiles) replaces ../src/db with stubs; this suite needs the real module.
jest.unmock('../src/db');

// Mock Mongoose first
const mockFindOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockSupporteeFindOneAndUpdate = jest.fn();
const mockCounterFindOneAndUpdate = jest.fn();
const mockBanFindOne = jest.fn();
const mockBanFindOneAndUpdate = jest.fn();
const mockBanDeleteOne = jest.fn();
const mockCreate = jest.fn();
const mockEventSave = jest.fn().mockResolvedValue(undefined);
const mockEventFindOne = jest.fn(() => query({ seq: 0 }));
const mockFind = jest.fn();
const mockCountDocuments = jest.fn();
const mockUpdateOne = jest.fn().mockResolvedValue({});

/** Minimal chainable, awaitable query like mongoose returns from findOne(). */
const query = (result: unknown, reject = false) => {
  const q: Record<string, unknown> = {};
  q.sort = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
    (reject ? Promise.reject(result) : Promise.resolve(result)).then(onOk, onErr);
  return q;
};

jest.mock('mongoose', () => {
  const Schema = jest.fn().mockImplementation(() => ({ plugin: jest.fn(), index: jest.fn() }));
  (Schema as unknown as { Types: unknown }).Types = { Mixed: {}, ObjectId: {} };

  const supporteeModel = {
    findOne: mockFindOne,
    updateMany: mockUpdateMany,
    findOneAndUpdate: mockSupporteeFindOneAndUpdate,
    create: mockCreate,
    find: mockFind,
    countDocuments: mockCountDocuments,
    updateOne: mockUpdateOne,
  };

  const counterModel = {
    findOneAndUpdate: mockCounterFindOneAndUpdate,
  };


const analyticsEventModel: any = jest.fn(function (this: any, data: any) {
  Object.assign(this, data);
  this.save = mockEventSave;
});
analyticsEventModel.findOne = mockEventFindOne;
analyticsEventModel.find = jest.fn();
analyticsEventModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

  const userBanModel = {
    findOne: mockBanFindOne,
    findOneAndUpdate: mockBanFindOneAndUpdate,
    deleteOne: mockBanDeleteOne,
  };

  return {
    __esModule: true,
    default: undefined as unknown, // set below
    connect: jest.fn().mockResolvedValue({}),
    Schema,
    model: jest.fn((name: string) => {
      if (name === 'TicketCounter') return counterModel;
      if (name === 'AnalyticsEvent') return analyticsEventModel;
      if (name === 'UserBan') return userBanModel;
      return supporteeModel;
    }),
    connection: {
      on: jest.fn(),
    },
  };
});
// db.ts uses the default import: make it the same object as the namespace
const mongooseMock = jest.requireMock('mongoose');
mongooseMock.default = mongooseMock;

// Mock cache
jest.mock('../src/cache', () => ({
  config: {
    mongodb_uri: 'mongodb://localhost:27017/test',
  },
  recoveryBaseline: 0,
}));

// Import the module after mocking
import * as db from '../src/db';

describe('Database Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getNextTicketId', () => {
    it('raises the counter to the DB baseline and increments it atomically', async () => {
      mockFindOne.mockReturnValue(query({ ticketId: 7 }));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 7 })
        .mockResolvedValueOnce({ seq: 8 });

      const ticketId = await db.getNextTicketId();

      expect(ticketId).toBe(8);
      expect(mockCounterFindOneAndUpdate).toHaveBeenNthCalledWith(
        1,
        { _id: 'bot_support:ticketId' },
        { $max: { seq: 7 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      expect(mockCounterFindOneAndUpdate).toHaveBeenNthCalledWith(
        2,
        { _id: 'bot_support:ticketId' },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });
  });

  describe('ticket lifecycle', () => {
    it('moves OPEN to WAITING_USER with an atomic guarded update', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 5, status: 'waiting_user' });

      const result = await db.transitionTicketStatus(5, 'waiting_user');

      expect(result).toEqual({ ticketId: 5, status: 'waiting_user' });
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 5, status: { $in: ['open', 'waiting_user'] } },
        { $set: { status: 'waiting_user', closed_at: null } },
        { new: true },
      );
    });

    it('does not allow CLOSED as a source for WAITING_USER', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue(null);

      await db.transitionTicketStatus(8, 'waiting_user');

      const filter = mockSupporteeFindOneAndUpdate.mock.calls[0][0];
      expect(filter.status.$in).not.toContain('closed');
    });

    it('sets closed_at when closing a ticket', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 9, status: 'closed' });

      await db.transitionTicketStatus(9, 'closed');

      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 9, status: { $in: ['open', 'waiting_user', 'closed'] } },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
        { new: true },
      );
    });
  });

  describe('user bans', () => {
    it('stores bans outside the ticket collection', async () => {
      mockBanFindOneAndUpdate.mockResolvedValue({ userid: 'user1', messenger: 'telegram' });

      await db.banUser('user1', 'telegram');

      expect(mockBanFindOneAndUpdate).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1' },
        { $setOnInsert: { messenger: 'telegram', userid: 'user1' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('checks the dedicated ban collection first', async () => {
      const ban = { userid: 'user1', messenger: 'telegram' };
      mockBanFindOne.mockResolvedValue(ban);

      const result = await db.checkBan('user1', 'telegram');

      expect(result).toBe(ban);
      expect(mockBanFindOne).toHaveBeenCalledWith({ messenger: 'telegram', userid: 'user1' });
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('unbans without reopening a ticket', async () => {
      mockBanDeleteOne.mockResolvedValue({ deletedCount: 1 });
      mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

      await db.unbanUser('user1', 'telegram');

      expect(mockBanDeleteOne).toHaveBeenCalledWith({ messenger: 'telegram', userid: 'user1' });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1', status: 'banned' },
        { $set: { status: 'closed', category: null, closed_at: expect.any(Date) } },
      );
    });
  });

  describe('getTicketByUserId', () => {
    it('should find ticket by user ID and category', async () => {
      const mockTicket = { id: 1, userid: 'user1', category: 'support' };
      mockFindOne.mockReturnValue(query(mockTicket));

      const result = await db.getTicketByUserId('user1', 'support');
      expect(result).toEqual(mockTicket);
      expect(mockFindOne).toHaveBeenCalledWith({
        $or: [{ userid: 'user1' }],
        category: 'support',
      });
    });

    it('should match uncategorised tickets when category is null', async () => {
      const mockTicket = { id: 1, userid: 'user1' };
      mockFindOne.mockReturnValue(query(mockTicket));

      const result = await db.getTicketByUserId('user1', null);
      expect(result).toEqual(mockTicket);
      expect(mockFindOne).toHaveBeenCalledWith({
        $or: [{ userid: 'user1' }],
        category: null,
      });
    });
  });

  describe('closeAll', () => {
    it('closes only active lifecycle states', async () => {
      await db.closeAll();
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { status: { $in: ['open', 'waiting_user'] } },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
      );
    });
  });

  describe('reopen', () => {
    it('reopens only closed matching tickets', async () => {
      await db.reopen('user1', 'support', 'telegram');
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          messenger: 'telegram',
          $or: [{ userid: 'user1' }, { ticketId: 'user1' }],
          status: 'closed',
          category: 'support',
        },
        { $set: { status: 'open', closed_at: null } },
      );
    });
  });

  describe('add', () => {
    it('opens without replacing an existing ticket document', async () => {
      mockFindOne.mockReturnValue(query(null));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 0 })
        .mockResolvedValueOnce({ seq: 1 });
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 1 });

      const result = await db.add('user1', 'open', 'support', 'telegram');

      expect(result).toBe(1);
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1' },
        {
          $setOnInsert: { userid: 'user1', messenger: 'telegram', ticketId: 1 },
          $set: { status: 'open', category: 'support', closed_at: null },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('closes only OPEN or WAITING_USER matches', async () => {
      mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
      const result = await db.add('user1', 'closed', 'support', 'telegram');
      expect(result).toBe(2);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          messenger: 'telegram',
          $or: [{ userid: 'user1' }, { ticketId: 'user1' }],
          status: { $in: ['open', 'waiting_user'] },
          category: 'support',
        },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
      );
    });

    it('keeps the legacy banned API but stores it in UserBan', async () => {
      mockBanFindOneAndUpdate.mockResolvedValue({ userid: 'user1', messenger: 'telegram' });

      const result = await db.add('user1', 'banned', null, 'telegram');

      expect(result).toBe(1);
      expect(mockBanFindOneAndUpdate).toHaveBeenCalled();
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('addNewTicket (ticket_per_message)', () => {
    it('inserts a new document instead of updating the existing one', async () => {
      mockFindOne.mockReturnValue(query({ ticketId: 7 }));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 7 })
        .mockResolvedValueOnce({ seq: 8 });
      mockCreate.mockResolvedValue({});

      const ticketId = await db.addNewTicket('user1', 'support', 'telegram');

      expect(ticketId).toBe(8);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        userid: 'user1',
        messenger: 'telegram',
        ticketId: 8,
        status: 'open',
        category: 'support',
        routing: expect.objectContaining({ state: 'common', offered_to: null, deadline_at: null,
          audit: [expect.objectContaining({ reason: 'organization_unconfirmed', type: 'ticket.routing_common' })] }),
      }));
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('stores a null category when none is given', async () => {
      mockFindOne.mockReturnValue(query(null));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 0 })
        .mockResolvedValueOnce({ seq: 1 });
      mockCreate.mockResolvedValue({});

      await db.addNewTicket('user1', undefined as unknown as null, 'telegram');

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 1, category: null }));
    });
  });

  describe('declared organization, visibility scope and closure explanation', () => {
    const chain = () => { const c: any = {}; c.sort = jest.fn(() => c); c.skip = jest.fn(() => c); c.limit = jest.fn(() => c);
      c.lean = jest.fn().mockResolvedValue([]); return c; };
    const common = { $and: [{ 'routing.state': { $ne: 'offered' } }, { $or: [{ assigned_to: null }, { common_visible: true }] }] };
    const active = { status: { $in: ['open', 'waiting_user'] } };

    it('snapshots the declared organization only on the new ticket document', async () => {
      mockFindOne.mockReturnValue(query({ ticketId: 7 }));
      mockCounterFindOneAndUpdate.mockResolvedValueOnce({ seq: 7 }).mockResolvedValueOnce({ seq: 8 });
      await db.addNewTicket('user1', null, 'telegram', 'ООО Ромашка');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 8, declared_organization: 'ООО Ромашка' }));
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('puts visibility into every staff list query', async () => {
      mockFind.mockImplementation(chain);
      await db.listStaffTickets('mine', '42', 0, 7, 6, 'common');
      expect(mockFind).toHaveBeenLastCalledWith({ $and: [{ ...active, assigned_to: '42', 'routing.state': { $ne: 'offered' } }, common] });
      await db.listStaffTickets('closed', '43', 0, 7, 6);
      expect(mockFind).toHaveBeenLastCalledWith({ $and: [{ status: 'closed' },
        { $or: [{ assigned_to:'43' }, { 'routing.state':'offered', 'routing.offered_to':'43' }, common] }] });
      await db.listStaffTickets('active', '50', 0, 7, 6, 'all');
      expect(mockFind).toHaveBeenLastCalledWith(active);
      await db.listStaffTickets('common', '43', 0, 7, 6, 'visible');
      expect(mockFind).toHaveBeenLastCalledWith({ $and: [{ ...active, ...common },
        { $or: [{ assigned_to:'43' }, { 'routing.state':'offered', 'routing.offered_to':'43' }, common] }] });
    });

    it('changing the declaration clears confirmation atomically and retains the previous binding in audit', async () => {
      await db.saveOrganization('user1','telegram',4,'$literal client name');
      const call=(db.ClientProfile.findOneAndUpdate as jest.Mock).mock.calls.at(-1)!;
      expect(call[0]).toEqual({messenger:'telegram',userid:'user1',org_input:{$ne:null},org_input_version:4});
      const set=call[1][0].$set;
      expect(set.organization).toEqual({$literal:'$literal client name'});
      expect(set.organization_verification).toBe('pending');
      expect(set.confirmed_org_ref).toBeNull();
      expect(set.org_binding_audit.$concatArrays[1][0]).toMatchObject({
        action:'declared',old_org_ref:'$confirmed_org_ref',old_organization:'$organization',
        new_organization:{$literal:'$literal client name'},new_org_ref:null,
      });
      expect(set.org_binding_audit_pending).toBe(true);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('changes explicit common visibility only under the expected owner', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValueOnce(null);
      await expect(db.setTicketCommonVisibility(7, true, '42')).resolves.toBeNull();
      const at = mockSupporteeFindOneAndUpdate.mock.calls.at(-1)![1].$set.common_visible_since;
      expect(at).toBeInstanceOf(Date);
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 7, assigned_to: '42', common_visible: { $ne: true } }, { $set: { pending_reply_staff_id: null, pending_reply_prompt_id: null, pending_reply_expires_at: null, pending_reply_kind: null, pending_reply_chat_id: null, pending_reply_thread_id: null, pending_reply_origin_message_id: null, pending_reply_claim: null, pending_reply_claimed_at: null, common_visible: true, common_visible_since: at, common_return_notice: { state: 'pending', attempts: 0, key: 's' + at.getTime(), at } }, $inc: { pending_reply_version: 1 } }, { new: true });
    });

    it('appends a closure version and leaves the intent claimable until the ticket really closes', async () => {
      mockFindOne.mockReturnValue(query(null));
      mockSupporteeFindOneAndUpdate.mockResolvedValueOnce({ current_version: 2, versions: [{ version: 2, intent_token: 'tok' }] });
      const intent: any = { token: 'tok', ticketId: 7, base_version: 1, mode: 'close', actor_id: '42',
        cause: 'не установлена', actions: 'Перезапустили службу', check: '' };
      const saved = await db.saveClaimedResolution(intent);
      expect(saved?.current_version).toBe(2);
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 7, current_version: 1, 'versions.intent_token': { $ne: 'tok' } },
        { $push: { versions: expect.objectContaining({ version: 2, cause: 'не установлена', actions: 'Перезапустили службу',
          check: '', author_id: '42', intent_token: 'tok', closure: true }) }, $set: { current_version: 2 } }, { new: true });
      expect(mockUpdateOne).not.toHaveBeenCalled();
      await db.completeResolutionIntent('tok');
      expect(mockUpdateOne).toHaveBeenCalledWith({ token: 'tok', status: 'saving' }, { $set: { status: 'saved' } });
    });
  });

  describe('getTicketByUserId ordering', () => {
    it('returns the newest ticket first so per-message tickets resolve to the latest one', async () => {
      const q = query({ ticketId: 3 });
      mockFindOne.mockReturnValue(q);
      await db.getTicketByUserId('user1', null);
      expect(q.sort).toHaveBeenCalledWith({ ticketId: -1 });
    });
  });

  describe('Error handling', () => {
    it('should handle database connection errors gracefully', async () => {
      mockFindOne.mockReturnValue(query(new Error('Database connection failed'), true));
      await expect(db.getTicketByUserId('user1', 'support')).rejects.toThrow('Database connection failed');
    });

    it('should handle null results gracefully', async () => {
      mockFindOne.mockReturnValue(query(null));
      const result = await db.getTicketByUserId('nonexistent', 'support');
      expect(result).toBeNull();
    });
  });
});


describe('dashboard database scopes and counters', () => {
  const data = [
    {ticketId:1, assigned_to:'A', status:'open'},
    {ticketId:2, assigned_to:'B', status:'open'},
    {ticketId:3, assigned_to:null, status:'open'},
    {ticketId:4, assigned_to:'B', common_visible:true, status:'waiting_user'},
    {ticketId:5, assigned_to:null, routing:{state:'offered',offered_to:'A'},status:'open'},
    {ticketId:6, assigned_to:null, routing:{state:'offered',offered_to:'B'},status:'open'},
    {ticketId:7, assigned_to:'A', status:'closed'},
  ];
  function matches(t:any,q:any):boolean {
    return Object.entries(q).every(([k,v]:[string,any]) => {
      if(k==='$and')return v.every((x:any)=>matches(t,x));
      if(k==='$or')return v.some((x:any)=>matches(t,x));
      const value=k.split('.').reduce((a,key)=>a?.[key],t);
      if(v && typeof v==='object')return '$ne' in v ? value!==v.$ne : v.$in.includes(value);
      return v===null ? value==null : value===v;
    });
  }
  it.each([
    ['mine','A','visible',[1]],['offered','A','visible',[5]],['common','A','visible',[3,4]],
    ['active','A','visible',[1,3,4,5]],['active','B','visible',[2,3,4,6]],
    ['active','boss','all',[1,2,3,4,5,6]],['offered','boss','all',[5,6]],
    ['active','A','common',[3,4]],['closed','B','visible',[]],
  ] as const)('filters %s for %s in %s without foreign records', async(view,actor,scope,ids) => {
    const filter=db.staffTicketFilter(view,actor,scope);
    expect(data.filter(t=>matches(t,filter)).map(t=>t.ticketId)).toEqual(ids);
    mockCountDocuments.mockResolvedValueOnce(ids.length);
    await expect(db.countStaffTickets(view,actor,scope)).resolves.toBe(ids.length);
    expect(mockCountDocuments).toHaveBeenLastCalledWith(filter);
  });
});
