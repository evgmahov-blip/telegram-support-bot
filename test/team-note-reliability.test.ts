const addInternalNote = jest.fn();
const recordAnalyticsEventBestEffort = jest.fn();
const sendMessage = jest.fn().mockResolvedValue('1');

jest.mock('../src/db', () => ({ addInternalNote, recordAnalyticsEventBestEffort }));
jest.mock('../src/middleware', () => ({ strictEscape: (value: string) => value, sendMessage, reply: jest.fn() }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { staffchat_id: '-100', staffchat_type: 'telegram', parse_mode: 'HTML', language: {
    internalNote: 'Заметка', noteAddedBy: 'добавил',
  } }, staffMembers: new Map(), mutedTickets: new Set(),
} }));

import { addInternalNoteCommand } from '../src/team';

const ctx: any = { from: { id: 42 }, message: { from: { first_name: 'Иван' } } };

describe('internal note durability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps a persisted note successful when best-effort analytics rejects', async () => {
    addInternalNote.mockResolvedValueOnce(true);
    // The DB best-effort facade absorbs its underlying analytics rejection.
    recordAnalyticsEventBestEffort.mockReturnValueOnce(undefined);
    await expect(addInternalNoteCommand(ctx, 7, 'private', 'telegram:10:ticket:7')).resolves.toBeUndefined();
    expect(addInternalNote).toHaveBeenCalledWith(7, '42', 'private', 'telegram:10:ticket:7');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not repeat note side effects when the same delivery key already exists', async () => {
    addInternalNote.mockResolvedValueOnce(false);
    await addInternalNoteCommand(ctx, 7, 'private', 'telegram:10:ticket:7');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordAnalyticsEventBestEffort).not.toHaveBeenCalled();
  });
});
