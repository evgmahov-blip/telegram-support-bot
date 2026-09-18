import { getTicketMessageSourceId } from '../src/ticket-message-source';

function context(overrides: Record<string, any> = {}): any {
  const base = {
    messenger: 'telegram',
    update: { update_id: 123 },
    update_id: 0,
    message: {
      web_msg: false,
      message_id: 55,
      from: { id: 'user-1' },
      chat: { id: 'chat-1' },
    },
    editedMessage: {
      web_msg: false,
      message_id: 55,
      from: { id: 'user-1' },
      chat: { id: 'chat-1' },
    },
    chat: { id: 'chat-1' },
    from: { id: 'user-1' },
    callbackQuery: { id: '' },
  };

  return {
    ...base,
    ...overrides,
    message: { ...base.message, ...(overrides.message || {}) },
    editedMessage: overrides.editedMessage === null
      ? undefined
      : { ...base.editedMessage, ...(overrides.editedMessage || {}) },
    chat: { ...base.chat, ...(overrides.chat || {}) },
    from: { ...base.from, ...(overrides.from || {}) },
    callbackQuery: { ...base.callbackQuery, ...(overrides.callbackQuery || {}) },
  };
}

describe('ticket message ingress source ids', () => {
  it('uses Telegram update id scoped by chat for normal messages', () => {
    expect(getTicketMessageSourceId(context())).toBe(
      'telegram:message:chat-1:update:123',
    );
  });

  it('separates an edited update from the original message source namespace', () => {
    expect(getTicketMessageSourceId(context(), 'edited')).toBe(
      'telegram:edited:chat-1:update:123',
    );
  });

  it('keeps separate history rows for two Telegram edits of the same message', () => {
    const firstEdit = context({
      update: { update_id: 201 },
      editedMessage: { message_id: 55 },
    });
    const secondEdit = context({
      update: { update_id: 202 },
      editedMessage: { message_id: 55 },
    });

    expect(getTicketMessageSourceId(firstEdit, 'edited')).toBe(
      'telegram:edited:chat-1:update:201',
    );
    expect(getTicketMessageSourceId(secondEdit, 'edited')).toBe(
      'telegram:edited:chat-1:update:202',
    );
  });

  it('uses the exact Slack event id when update_id is unavailable', () => {
    expect(getTicketMessageSourceId(context({
      messenger: 'slack',
      update_id: 0,
      message: {
        message_id: 1712345678123456,
        chat: { id: 'C123' },
      },
      callbackQuery: { id: '1712345678.123456' },
    }))).toBe(
      'slack:message:C123:event:1712345678.123456',
    );
  });

  it('uses the exact Discord snowflake string instead of its lossy numeric id', () => {
    expect(getTicketMessageSourceId(context({
      messenger: 'discord',
      update_id: 0,
      message: {
        message_id: 1234567890123456800,
        chat: { id: 'channel-9' },
      },
      callbackQuery: { id: '1234567890123456789' },
    }))).toBe(
      'discord:message:channel-9:event:1234567890123456789',
    );
  });

  it('keeps Signal timestamp identity even though its mapped message has web_msg=true', () => {
    expect(getTicketMessageSourceId(context({
      messenger: 'signal',
      update_id: 1726650000123,
      message: {
        web_msg: true,
        from: { id: '+358401234567' },
        chat: { id: '+358401234567' },
      },
    }))).toBe(
      'signal:message:+358401234567:update:1726650000123',
    );
  });

  it('does not deduplicate the mutable WEB fake context with static ids', () => {
    expect(getTicketMessageSourceId(context({
      messenger: 'telegram',
      update_id: 617718635,
      message: {
        web_msg: true,
        from: { id: 'WEBsocket-123' },
        chat: { id: 'WEBsocket-123' },
      },
    }))).toBeUndefined();
  });

  it('falls back to a safe numeric message id when no update or exact event id exists', () => {
    expect(getTicketMessageSourceId(context({
      messenger: 'telegram',
      update_id: 0,
      message: {
        message_id: 88,
        chat: { id: 'chat-2' },
      },
      callbackQuery: { id: '' },
    }))).toBe(
      'telegram:message:chat-2:message:88',
    );
  });

  it('returns undefined rather than inventing an unstable source identity', () => {
    expect(getTicketMessageSourceId(context({
      update_id: 0,
      message: {
        message_id: 0,
        chat: { id: '' },
      },
      chat: { id: '' },
      callbackQuery: { id: '' },
    }))).toBeUndefined();
  });
});
