// Real production schema hydration, with no connection or persisted documents.
import mongoose from 'mongoose';
import * as db from '../src/db';
import { freshTicket } from '../src/ticket-visibility';

const { SupporteeSchema } = jest.requireActual('../src/db');
const Model = mongoose.model('LegacyVisibilityRegression', SupporteeSchema);
const legacy: any = { ticketId: 7, userid: 'synthetic', messenger: 'telegram', status: 'open', assigned_to: '42' };

beforeEach(() => jest.clearAllMocks());

it('accepts legacy lean and hydrated defaults in either direction without changing the lean snapshot', async () => {
  const snapshot = { ...legacy };
  const hydrated = Model.hydrate(snapshot);
  expect(hydrated).toMatchObject({ pending_reply_version: 0, common_visible: false, common_visible_since: null });
  (db.getTicketById as jest.Mock).mockResolvedValue(hydrated);
  expect(await freshTicket(snapshot)).toBe(hydrated);
  expect(snapshot).toEqual(legacy);
  (db.getTicketById as jest.Mock).mockResolvedValue(snapshot);
  expect(await freshTicket(hydrated)).toBe(snapshot);
});

it('accepts a legacy unassigned ticket hydrated with a null owner', async () => {
  const { assigned_to, ...unassigned } = legacy;
  const hydrated = Model.hydrate(unassigned);
  (db.getTicketById as jest.Mock).mockResolvedValue(hydrated);
  expect(await freshTicket(unassigned as any)).toBe(hydrated);
});

it.each([
  ['owner', { assigned_to: '43' }], ['status', { status: 'closed' }],
  ['reply version', { pending_reply_version: 1 }], ['visibility', { common_visible: true }],
  ['visibility timestamp', { common_visible_since: new Date('2026-11-14T10:00:00Z') }],
  ['routing version', { routing: { state: 'offered', version: 2 } }],
  ['routing state', { routing: { state: 'accepted', version: 1 } }],
])('rejects changed %s even with legacy/default hydration', async (_label, changed) => {
  const snapshot = { ...legacy, routing: { state: 'offered', version: 1 } };
  (db.getTicketById as jest.Mock).mockResolvedValue(Model.hydrate({ ...snapshot, ...changed }));
  expect(await freshTicket(snapshot as any)).toBeNull();
});

it('does not equate explicit null versions with the missing-field default', async () => {
  (db.getTicketById as jest.Mock).mockResolvedValue(Model.hydrate({ ...legacy, pending_reply_version: null }));
  expect(await freshTicket(legacy)).toBeNull();
});

it('rejects a deleted ticket', async () => {
  (db.getTicketById as jest.Mock).mockResolvedValue(null);
  expect(await freshTicket(legacy)).toBeNull();
});
