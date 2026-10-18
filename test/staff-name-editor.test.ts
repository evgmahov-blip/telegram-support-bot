const reply = jest.fn().mockResolvedValue(undefined);
const answer = jest.fn().mockResolvedValue(undefined);
const findIntent = jest.fn();
const stage = jest.fn();
const cancel = jest.fn();
const save = jest.fn();
const revise = jest.fn();
const compose = jest.fn().mockResolvedValue(null);
const intake = jest.fn().mockResolvedValue(null);

jest.mock('../src/middleware', () => ({ reply }));
jest.mock('../src/ticket-ui', () => ({
  answer, e: (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  STAFF_HOME: { text: '🏠 Главная', callback_data: 'tm:home:0' }, refreshStaffCard: jest.fn(),
}));
jest.mock('../src/db', () => ({
  findStaffNameEdit: findIntent, stageStaffNameEdit: stage, cancelStaffNameEdit: cancel,
  saveStaffNameEdit: save, reviseStaffNameEdit: revise, startStaffNameEdit: jest.fn(),
  findActiveReplyCompose: compose, findAnyActiveManualDraft: intake, listTicketsAssignedTo: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { staffchat_id: '-100', staffchat_thread_id: 7 },
  staffMembers: new Map([
    ['1', { telegram_id: '1', role: 'admin', name: 'Админ' }],
    ['2', { telegram_id: '2', role: 'agent', name: 'Иван' }],
  ]), staffNameOverrides: new Map(),
} }));

import cache from '../src/cache';
import { Context, Messenger } from '../src/interfaces';
import { handleCallback, handleTextInput, showList } from '../src/staff-name-editor';

function context(actor = 1, text = 'Новое имя', thread = 7, chat = -100): Context {
  return { messenger: Messenger.TELEGRAM, update_id: 1, from: { id: actor } as any,
    chat: { id: chat, type: 'supergroup' } as any, session: { admin: true } as any,
    message: { text, message_id: 50, message_thread_id: thread } as any,
    callbackQuery: { data: '', message: { chat: { id: chat }, message_thread_id: thread } } as any,
    answerCbQuery: jest.fn().mockResolvedValue(undefined) } as Context;
}

describe('staff display-name editor', () => {
  beforeEach(() => { jest.clearAllMocks(); cache.staffNameOverrides?.clear(); findIntent.mockResolvedValue(null); compose.mockResolvedValue(null); intake.mockResolvedValue(null); });

  it('shows the list only to a currently configured admin and never renders raw IDs', async () => {
    const admin = context(); await showList(admin, 0);
    const buttonTexts = answer.mock.calls[0][2].flat().map((button: any) => button.text);
    expect(buttonTexts).not.toContain('2');
    const agent = context(2); await showList(agent, 0);
    expect(agent.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('администратору'), true);
  });

  it('omits singleton pagination and shows page text only with real destinations', async () => {
    const original = [...cache.staffMembers.entries()];
    try {
      cache.staffMembers = new Map([original[0]]) as any;
      await showList(context(), 0);
      expect(JSON.stringify(answer.mock.calls.at(-1)?.[2])).not.toContain('callback_data":"noop');
      expect(answer.mock.calls.at(-1)?.[1]).not.toContain('Страница');
      cache.staffMembers = new Map(Array.from({ length: 7 }, (_, i) => [String(i + 1),
        { telegram_id: String(i + 1), role: i ? 'agent' : 'admin', name: `N${i}` }])) as any;
      await showList(context(), 0);
      const first = JSON.stringify(answer.mock.calls.at(-1)?.[2]);
      expect(first).not.toContain('callback_data":"noop'); expect(first).toContain('sn:list:1'); expect(first).not.toContain('sn:list:-1');
      expect(answer.mock.calls.at(-1)?.[1]).toContain('Страница 1');
      await showList(context(), 1);
      const second = JSON.stringify(answer.mock.calls.at(-1)?.[2]);
      expect(second).toContain('sn:list:0'); expect(second).not.toContain('sn:list:2');
      expect(answer.mock.calls.at(-1)?.[1]).toContain('Страница 2');
    } finally { cache.staffMembers = new Map(original) as any; }
  });

  it('binds ordinary text to actor/chat/topic, validates it, and escapes preview HTML', async () => {
    findIntent.mockResolvedValue({ actor_id: '1', target_id: '2', version: 4 });
    stage.mockResolvedValue({ target_id: '2', draft_name: '<b>Иван & Co</b>', version: 5 });
    expect(await handleTextInput(context(1, '<b>Иван & Co</b>'))).toBe(true);
    expect(stage).toHaveBeenCalledWith('1', '-100', 7, 4, '<b>Иван & Co</b>');
    expect(answer.mock.calls.at(-1)?.[1]).toContain('&lt;b&gt;Иван &amp; Co&lt;/b&gt;');
    expect(await handleTextInput(context(1, 'bad\nname'))).toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('без переносов'));
    expect(await handleTextInput(context(1, 'Wrong topic', 8))).toBe(false);
  });

  it('refuses ambiguous compose/intake routing and removed employees', async () => {
    findIntent.mockResolvedValue({ target_id: '2', version: 3 }); compose.mockResolvedValue({ ticketId: 9 });
    await handleTextInput(context()); expect(stage).not.toHaveBeenCalled(); expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Текст не использован'));
    compose.mockResolvedValue(null); (cache.staffMembers as Map<string, any>).delete('2');
    await handleTextInput(context()); expect(cancel).toHaveBeenCalledWith('1', '-100', 7, 3);
    (cache.staffMembers as Map<string, any>).set('2', { telegram_id: '2', role: 'agent', name: 'Иван' });
  });

  it('uses version CAS for stale cancel/save and updates cache only after durable save', async () => {
    const ctx = context(); ctx.callbackQuery.data = 'sn:save:8';
    findIntent.mockResolvedValue({ target_id: '2', version: 8, status: 'preview' }); save.mockResolvedValue(null);
    await handleCallback(ctx, ['sn','save','8']); expect(ctx.answerCbQuery).toHaveBeenCalledWith('Подтверждение устарело.', true);
    expect(cache.staffNameOverrides?.has('2')).toBe(false);
    save.mockResolvedValue({ telegram_id: '2', display_name: 'Новый Иван' });
    await handleCallback(ctx, ['sn','save','8']); expect(cache.staffNameOverrides?.get('2')).toBe('Новый Иван');
  });
});
