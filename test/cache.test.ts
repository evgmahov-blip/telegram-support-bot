import cache from '../src/cache';
import { mergeLanguage } from '../src/language';
import { defaultMongoUri } from '../src/defaults';
import * as fs from 'fs';
import * as YAML from 'yaml';

// Mock file system and YAML
jest.mock('fs');
jest.mock('yaml');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockYAML = YAML as jest.Mocked<typeof YAML>;

describe('Cache Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have default cache structure', () => {
    expect(cache).toHaveProperty('userId');
    expect(cache).toHaveProperty('ticketIDs');
    expect(cache).toHaveProperty('ticketStatus');
    expect(cache).toHaveProperty('ticketSent');
    expect(cache).toHaveProperty('io');
    expect(cache).toHaveProperty('config');
  });

  it('should initialize with correct default values', () => {
    expect(typeof cache.userId).toBe('number');
    expect(Array.isArray(cache.ticketIDs)).toBe(true);
    expect(Array.isArray(cache.ticketStatus)).toBe(true);
    expect(Array.isArray(cache.ticketSent)).toBe(true);
    expect(typeof cache.io).toBe('object');
    expect(typeof cache.config).toBe('object');
  });

  it('should have config with language properties', () => {
    expect(cache.config).toHaveProperty('language');
    expect(cache.config.language).toHaveProperty('dear');
    expect(cache.config.language).toHaveProperty('regards');
  });

  it('should be a singleton instance', () => {
    const cache1 = require('../src/cache').default;
    const cache2 = require('../src/cache').default;
    expect(cache1).toBe(cache2);
  });

  it('should allow modification of cache properties', () => {
    const originalUserId = cache.userId;
    cache.userId = 'test123';
    expect(cache.userId).toBe('test123');
    
    // Reset for other tests
    cache.userId = originalUserId;
  });

  it('should allow adding items to arrays', () => {
    const originalLength = cache.ticketIDs.length;
    cache.ticketIDs.push('T001');
    expect(cache.ticketIDs.length).toBe(originalLength + 1);
    expect(cache.ticketIDs).toContain('T001');
    
    // Clean up
    cache.ticketIDs.pop();
  });

  it('should have configuration properties', () => {
    expect(cache.config).toHaveProperty('parse_mode');
    expect(cache.config).toHaveProperty('categories');
    expect(cache.config).toHaveProperty('anonymous_replies');
    expect(cache.config).toHaveProperty('clean_replies');
  });
});

describe('mergeLanguage', () => {
  const legacyEnglishLanguage = {
    startCommandText: '/start - Start the bot', faqCommandText: '/faq - Frequently Asked Questions',
    helpCommandText: '/help - Get help',
    confirmationMessage: 'Your message has been sent. We will get back to you as soon as possible.',
    contactMessage: '', blockedSpam: 'You are blocked due to spam.', ticket: 'Ticket', closed: 'Closed',
    acceptedBy: 'Accepted by', dear: 'Dear', regards: 'Regards', from: 'from', language: 'Language',
    msg_sent: 'Message sent!', file_sent: 'File sent!', usr_with_ticket: 'User with ticket', banned: 'Banned',
    replyPrivate: 'Reply in private chat', services: 'Services', customer: 'Customer',
    msgForwarding: 'Message forwarding', back: 'Back', whatSubCategory: 'What sub-category?',
    prvChatEnded: 'Private chat ended.', prvChatOpened: 'Private chat opened.', prvChatEnd: 'End private chat',
    prvChatOpenedCustomer: 'Staff has opened a private chat with you.', instructionsSent: 'Instructions sent!',
    openTickets: 'Open Tickets', support: 'Support', prvChatOnly: 'Private chat only', ticketClosed: 'Ticket closed',
    links: 'Links', textFirst: 'Please send a text message first.',
    ticketClosedError: 'This ticket is closed. Please open a new one.', automatedReply: 'Automated Reply',
    automatedReplyAuthor: 'Support Team', doesntHelp: "That doesn't help",
    automatedReplySent: 'An automated reply has been sent.', ticketReopened: 'Ticket reopened!',
    yourTicketId: 'Your Ticket ID', helpCommandStaffText: '/help - Staff commands reference',
    regardsGroup: 'Regards, Support Team', csatRatingRequest: 'Please rate your support experience (1-5):',
    csatThankYou: 'Thank you for your feedback!', triagePriority: 'Priority', triageSummary: 'Triage Summary',
    sentimentAlert: 'Sentiment Alert', ticketAssignedTo: 'Ticket assigned to', ticketUnassigned: 'Ticket unassigned',
    assignedBy: 'Assigned by', internalNote: 'Internal Note', noteAddedBy: 'Note added by',
    offlineMessage: "We're currently offline. We'll get back to you when we're available.",
    businessHoursClosed: 'Our support hours are from {start} to {end}.',
    escalationNotify: 'This ticket has been escalated.', replied: 'replied', ticketDetails: 'Ticket details',
    editedMessage: 'edited their message', broadcastSent: 'Broadcast sent to', closedByUser: 'closed by the user',
  };

  it('applies all default language strings when the config has no language block', () => {
    const language = mergeLanguage(undefined);
    expect(language.confirmationMessage).toBeTruthy();
    expect(language.back).toBeTruthy();
    expect(language.dear).toBeDefined();
  });

  it('keeps user overrides while filling missing language keys', () => {
    const language = mergeLanguage({ ticket: 'Anfrage', helpCommandText: 'English help for our customers' });
    expect(language.ticket).toBe('Anfrage');
    expect(language.helpCommandText).toBe('English help for our customers');
    expect(language.confirmationMessage).toBeTruthy();
  });

  it('migrates a full legacy stock English dictionary to all Russian defaults', () => {
    expect(mergeLanguage(legacyEnglishLanguage)).toEqual(mergeLanguage(undefined));
  });

  it('falls back to the legacy contactMessage for confirmationMessage', () => {
    const language = mergeLanguage({ contactMessage: 'Danke für Ihre Nachricht' });
    expect(language.confirmationMessage).toBe('Danke für Ihre Nachricht');
  });
});

describe('defaultMongoUri', () => {
  it('prefers MONGO_URI from the environment over the built-in default', () => {
    expect(defaultMongoUri({ MONGO_URI: 'mongodb://from-env:27017/support' } as NodeJS.ProcessEnv)).toBe('mongodb://from-env:27017/support');
    expect(defaultMongoUri({} as NodeJS.ProcessEnv)).toBe('mongodb://mongodb:27017/support');
    expect(defaultMongoUri({ MONGO_URI: '' } as NodeJS.ProcessEnv)).toBe('mongodb://mongodb:27017/support');
  });
});
