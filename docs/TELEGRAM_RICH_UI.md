# Личная главная и Rich HTML карточки МОСТ

Личная главная инженера открывает шесть строк «Мои в работе», отдельную очередь «Ожидают принятия» и общую очередь. Счётчики и страницы используют один `staffTicketFilter`. В «Мои» нет offered; руководители сохраняют полный scope в «Все активные» и очереди предложений. Общая группа не получает персональные счётчики или содержимое личных заявок.

Classic включён по умолчанию. `telegram_rich_ui: true` в YAML включает Rich HTML только на приватных панелях сотрудников. Образец оставлен с `false`; production не изменяется. Оба представления получают один `ScreenViewModel` после существующих проверок сотрудника, поверхности и видимости. `ticket-rich-ui.ts` содержит pure renderers, ограничения текста по Unicode code points, whitelist тегов и кнопок, проверку callback_data в 1–64 UTF-8 bytes. Незнакомая локальная разметка остаётся classic до отправки запроса.

Карточка показывает статус, объявленную организацию отдельно от подтверждённой привязки, приоритет, инженера и краткое последнее сообщение. Переписка, решение и прежние действия открываются существующими кнопками; скрытая история заранее не загружается. Offered показывает сохранённый deadline, рабочий timezone и интервал принятия. Accepted не показывает таймер принятия. «Взять / Передать / Сделать общей» используют прежний routing command с version/CAS; reply/wait/transfer/close сохраняют прежний путь постоянной карточки и обязательное решение при закрытии.

После routing-команды приватная панель перечитывает durable запись и повторно проверяет права. Панель редактируется на месте. Явный refresh перечитывает данные; периодических серверных циклов нет. При UNKNOWN результата редактирования ошибка передаётся вызывающему коду, новое сообщение не отправляется. Новая навигационная панель допускается после подтверждённого `400 message to edit not found`. `message is not modified` считается завершённым редактированием. После restart сервер восстанавливает проекцию из сохранённой заявки; локальный cache содержит только сигнатуры отображения и номера панелей.

## Telegram контракт

[Telegram Bot API](https://core.telegram.org/bots/api#sendrichmessage) документирует `sendRichMessage(chat_id, rich_message)`; [InputRichMessage](https://core.telegram.org/bots/api#inputrichmessage) требует ровно одно из `html`, `markdown`, `blocks`. [editMessageText](https://core.telegram.org/bots/api#editmessagetext) принимает `rich_message`. Установленные типы `@grammyjs/types` содержат эти параметры. Адаптер вызывает штатные `bot.api.raw.sendRichMessage` и `bot.api.raw.editMessageText`, сохраняя текущий токен, endpoint и middleware SDK. В rich-запросе нет classic `parse_mode` и дублирующей клавиатуры: кнопки находятся в HTML.

[Rich HTML](https://core.telegram.org/bots/api#rich-html-style) поддерживает использованные `h3`, `p`, `br`, `b`, `tg-button-row`, `tg-button type="callback_data" data="…"` и Telegram URL-кнопки. Подпись кнопки сохраняет смысл без цвета; `primary` задаёт только тему Telegram. Нет CSS, JavaScript или внешних ресурсов.

Отсутствующий метод SDK или определённый отказ API в поддержке/разборе rich payload допускает classic fallback. Timeout, transport error, 5xx, Forbidden и отсутствие редактируемого сообщения не вызывают повторную classic отправку. Runtime ошибки не возвращаются как успешная доставка.

[Desktop v7.4.0 от 05.11.2026](https://github.com/telegramdesktop/tdesktop/releases/tag/v7.4.0) сообщает об HTML widgets. Это не подтверждает публичный транспорт произвольного HTML/CSS/JS. Такой bubble runtime остаётся зависимостью от доказанного публичного API и реальных owner-gated E2E. Live Telegram, MongoDB и внешние LLM/provider подключения в проверках не используются. Клиентская совместимость Rich HTML требует отдельного E2E перед включением opt-in.

## Проверки и примеры

`test/fixtures/telegram-rich-ui.json` содержит небольшие примеры главной и offered-карточки в classic и Rich HTML. Это синтетические fixture payload, а не screenshots реального клиента. `ticket-rich-ui.test.ts` проверяет их воспроизводимость и whitelist; `telegram-addon.test.ts` проверяет фактические SDK payload, deterministic fallback и UNKNOWN без дубля. `ticket-visibility-ui.test.ts`, `ticket-ui-callbacks.test.ts`, `db.test.ts` проверяют A/B/руководителя, отзыв сотрудника, личку/группу, scope, счётчики, шесть строк, пагинацию, durable deadline, restart, stale callbacks и отказ редактирования. Существующие routing-owner проверки сохраняют replay/concurrent CAS.

Команды: `npm run build`, профильные `npm test -- test/ticket-rich-ui.test.ts test/telegram-addon.test.ts test/ticket-visibility-ui.test.ts test/ticket-ui-callbacks.test.ts test/db.test.ts test/routing-admin-ui.test.ts` и полный `npm test`. Фактический итог под Node 24.22.2: build успешен; полный набор — 64/64 suites, 775/775 tests. Профильный прогон перед последней проверкой конкурентной смены видимости — 6/6 suites, 148/148 tests; эта дополнительная проверка также входит в полный набор. Сводка исполнения: [TELEGRAM_RICH_UI_VALIDATION.txt](TELEGRAM_RICH_UI_VALIDATION.txt). Node 24 запускался из подготовленного npm cache с `npx --offline --package=node@24 -c`; тесты использовали только моки.

## Передача AOR

Parent: `8316bfeabaa19ffded1d25316e566faf551cac33`, tree `dac2feb0974b8eaeded234b56b0b0b99362adcc9`, [исходный draft PR38](https://github.com/evgmahov-blip/telegram-support-bot/pull/38), ветка `feature/most-routing-settings-20261106`; источник принят по trusted managed-editor handoff для `ao-rem-2c6fa14017ea`. Git исполнителем не используется. Итоговый SHA и PR назначает AOR после сохранения файлов; здесь они не выдумываются.

Исторические ссылки: `support-bot-htmlbubbles-ui-20261108` (26.681 s) и `ao-rem-ef7022d40732` (27.194 s), обе `ESCALATED/executor_no_changes`, без кандидатов и использованных review. Это сохранённые остановки до правок; расходы не объявлены возвращёнными. Исходная `support-bot-org-visibility-resolution-20261106` и кандидат `2e7b1fa39c77456d65b132fb6bfc22c2a6436f63` остаются историей. Исправленный вход автоматически не повторяется.

Изменения не включают canonical organization owner PR37, AOR, ACL/RBAC, PR36/37, production конфигурацию или deployment. ClientProfile, snapshots, ручная верификация OrgRef, обязательные cause/actions, routing policy/deadlines/transfer caps, delivery UNKNOWN, reminders и YAML settings/history сохраняются. Approvals исходника не наследуются.

AOR выполняет независимый review всего итогового delta с учётом авторства PR38 (Anthropic и OpenAI) и текущих изменений OpenAI, выбирая допустимого зарегистрированного reviewer штатным route; затем CI на exact итоговом SHA. Результат редактора не является APPROVE или CI gate. Commit, публикация, reviewer selection и gates принадлежат AOR; merge/release/deploy не выполняются.
