# Независимое ревью архитектуры передачи задания ИИ-инженеру

Дата: 2026-10-19. Объект: [AI_ENGINEER_ARCHITECTURE.md](../AI_ENGINEER_ARCHITECTURE.md).
Формат: независимый агент-ревьюер `architecture_review`, read-only анализ документа и существующих модулей бота. Автор архитектуры исправляет документ; ревьюер его не редактирует.
Это архитектурное ревью для последующей реализации. Проверка production/canary в него не входит.

## Раунд 1 — v1.0

Вердикт ревьюера: **REQUEST CHANGES**.

| Приоритет | Замечание независимого ревьюера | Исправление в v1.1 |
|---|---|---|
| P1 | Конфиг и роли кешируются на старте, поэтому обещанные live disable/revocation не имеют источника authority | Явная startup policy generation, fingerprint и fail-closed mismatch; согласованный restart с epoch invalidation, без обещания hot-reload |
| P1 | Возврат из awaiting_operator не достигает terminal состояния, необходимого для archive→replace | CAS в reworked с одноразовым continuation intent; archive terminal snapshot; guard replacement и повтор того же request_id после crash |
| P1 | Нет пути доставки ограниченного списка bindings из SQLite АИНОК в бот | Фиксированная publish-catalog по выбранному admin transport; scope/version/TTL, только display refs и profile, независимая финальная проверка контроллером |
| P1 | Единственный projection_pending может быть перезаписан следующими переходами | Любой normal AI transition ждёт drain; close/transfer меняют epoch без перезаписи pending; acknowledgement по stable projection_id |

Дополнительно внесены SDK-level timeout/maxRetries и перечень прямых mutation paths `db.ts`, `ticket-state.ts`, `ticket-ownership.ts`, которые должны инвалидировать старую authority.

Ревьюер подтвердил выбранные швы: authority текущей revision в Supportee, отдельный immutable archive, controller pull без нового HTTP listener, LLM в боте без tools, внутренний вывод и человеческий handoff.

## Раунд 2 — v1.1

Вердикт: исходные четыре P1 закрыты; **REQUEST CHANGES** по одному дополнительному P1.

Каталог с TTL 5 минут не мог обновляться без изменения mapping: равная version с изменившимися timestamps/digest конфликтовала, а точный replay не продлевал TTL.
Исправление v1.2: publication version повышается на каждый новый refresh, точные bytes/version сохраняются до dispatch, retry не продлевает TTL; binding_version остаётся версией authority mapping. Уточнены также неизменяемый digest архива (исходящий continuation не входит) и projection repair при выключенной функции.

Ревьюер указал: после исправления refresh protocol других blockers для реализации в v1.1 не обнаружено. Запрошена итоговая проверка v1.2.

## Раунд 3 — v1.2

Окончательный вердикт независимого ревьюера: **APPROVED FOR IMPLEMENTATION. Blocking findings нет.**

Подтверждены исправления refresh/version/TTL каталога, исключение outgoing continuation из immutable digest и возможность projection/archive repair при disabled без LLM/инфраструктурных проверок.
Все пять P1 предыдущих раундов закрыты. Разрешение на production edits, deployment или canary в этот вердикт не входит.

## Предпосылки, требующие проверки при реализации

- Текущие deployed SHA/image и версия MongoDB; готовность аддитивных schema/unique indexes.
- Stdin, лимиты envelope, timeouts и read-only canary фиксированного QGA/admin маршрута.
- Фактические metadata/schema/output первой read-only capability.
- Явно опубликованный scope binding для одной canary-цели.
- Полная проверка всех writes lifecycle/owner, не только путей новой карточки.

На этапе архитектурного ревью runtime-код и включение AI не выполнялись. Последующая локальная реализация описана ниже; production этим ревью не разрешён.

## Локальная реализация — 2026-10-20

- A, состояния/store/authority: исправлены восстановление устаревшего задания и продолжение после утратившего authority continuation. Повторное ревью разрешило следующий локальный этап.
- B, bridge/catalog/controller: исправлены блокировка очереди устаревшей заявкой и общий deadline контроллера. Повторное ревью разрешило следующий локальный этап.
- C, LLM/worker: исправлены starvation maintenance и передача URI credentials. Используются actionable round-robin repair, очищенные goal/feedback и typed facts; history исключена. Повторное ревью: blockers нет, разрешены локальные UI/runtime hooks после build.
- D, UI/runtime: первоначально REQUEST CHANGES — отмена/expiry формы не входили в admission CAS, CLI обходил проверку индексов, закрытие/disable скрывали заключения. Исправлены атомарный draft fence, index preparation в CLI, навигация при closed/disabled и предложение «Взять» для неназначенной заявки. Повторный вердикт: «Blocking findings больше нет», разрешены полный локальный gate и финальное интеграционное ревью.

После D дополнительно исправлено освобождение expired/disabled формы, добавлены отмена без разрешения новых работ, страницы разделов/технические детали и Compose grace period. Эти уточнения входят в финальную интеграционную проверку.

## Финальное интеграционное ревью

Найден и исправлен P1: disabled startup отзывал только первый batch из десяти заданий, поэтому быстрый возврат прежней policy мог оживить остальные. До repair/readiness добавлен общий epoch fence незавершённых заданий и continuation; тест 12 заданий доказывает сохранение отзыва после немедленного stop/re-enable.
Итог независимого ревьюера: **«Локальный патч одобрен. Оставшихся P1/P2 не обнаружил.»** Реальная MongoDB, новый QGA bridge и отдельный production допуск остаются обязательными.

Доказательства и production gates: [AI_ENGINEER_IMPLEMENTATION.md](../AI_ENGINEER_IMPLEMENTATION.md).
