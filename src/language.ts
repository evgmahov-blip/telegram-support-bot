import { Language } from './interfaces';

// Russian defaults used when config doesn't provide an explicit override.
export const defaultLanguage: Partial<Language> = {
  startCommandText: '/start — начать работу с ботом',
  faqCommandText: '/faq — частые вопросы',
  helpCommandText: '/help — помощь',
  confirmationMessage: 'Ваше сообщение отправлено. Мы ответим как можно скорее.',
  contactMessage: '',
  blockedSpam: 'Отправка сообщений временно ограничена из-за слишком частых обращений.',
  ticket: 'Заявка', closed: 'закрыта', acceptedBy: 'Принята сотрудником',
  dear: 'Здравствуйте,', regards: 'С уважением,', from: 'от', language: 'язык',
  msg_sent: 'Сообщение отправлено!', file_sent: 'Файл отправлен!',
  usr_with_ticket: 'Клиент с заявкой', banned: 'заблокирован',
  replyPrivate: 'Ответить в личном чате', services: 'Сервисы', customer: 'Клиент',
  msgForwarding: 'Пересылка сообщений', back: 'Назад', whatSubCategory: 'Выберите подкатегорию:',
  prvChatEnded: 'Личный чат завершён.', prvChatOpened: 'Личный чат открыт.',
  prvChatEnd: 'Завершить личный чат', prvChatOpenedCustomer: 'Сотрудник поддержки открыл с вами личный чат.',
  instructionsSent: 'Инструкции отправлены!', openTickets: 'Открытые заявки', support: 'Поддержка',
  prvChatOnly: 'Только личный чат', ticketClosed: 'Заявка закрыта', links: 'Ссылки',
  textFirst: 'Сначала отправьте текстовое сообщение.',
  ticketClosedError: 'Эта заявка закрыта. Создайте новую.',
  automatedReply: 'Автоматический ответ', automatedReplyAuthor: 'Команда поддержки МОСТ',
  doesntHelp: 'Это не помогло', automatedReplySent: 'Отправлен автоматический ответ.',
  ticketReopened: 'Заявка снова открыта!', yourTicketId: 'Номер вашей заявки',
  helpCommandStaffText: '/help — команды сотрудников поддержки',
  regardsGroup: 'Команда поддержки МОСТ',
  csatRatingRequest: 'Оцените работу поддержки от 1 до 5:',
  csatThankYou: 'Спасибо за оценку!', triagePriority: 'Приоритет',
  triageSummary: 'Краткое описание', sentimentAlert: 'Негативная оценка сообщения',
  ticketAssignedTo: 'Заявка назначена сотруднику', ticketUnassigned: 'Назначение снято',
  assignedBy: 'Назначил', internalNote: 'Внутренняя заметка', noteAddedBy: 'Добавил',
  offlineMessage: 'Сейчас поддержка не работает. Мы ответим в рабочее время.',
  businessHoursClosed: 'Поддержка работает с {start} до {end}. Мы ответим в рабочее время.',
  escalationNotify: 'Заявка передана на следующий уровень поддержки.', replied: 'есть ответ',
  ticketDetails: 'Сведения о заявке', editedMessage: 'изменил(а) сообщение',
  broadcastSent: 'Рассылка отправлена получателям:', closedByUser: 'закрыта клиентом',
};

/**
 * Merges the user's language block over the defaults so every string is defined,
 * even when the config has no language block at all.
 * Older configs customised the confirmation text via the legacy contactMessage key.
 */
export function mergeLanguage(userLanguage: unknown): Language {
  const user: Partial<Language> =
    userLanguage && typeof userLanguage === 'object' ? { ...(userLanguage as Partial<Language>) } : {};
  if (!user.confirmationMessage && user.contactMessage) {
    user.confirmationMessage = user.contactMessage;
  }
  return { ...defaultLanguage, ...user } as unknown as Language;
}
