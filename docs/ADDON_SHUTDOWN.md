# Realtime addon shutdown contract

Signal, Slack, and Discord are long-lived ingress adapters. Their `stop()` methods follow the same shutdown contract used by the core lifecycle:

1. mark the addon as stopping before closing transport resources;
2. cancel scheduled reconnects so a close/error callback cannot resurrect ingress;
3. clear platform timers such as Discord heartbeats and Signal typing fallbacks;
4. close the active WebSocket;
5. drain message handling that was already accepted before `stop()` returns.

Incoming platform callbacks are tracked through `AsyncWorkTracker`. The tracker uses a stable drain loop, so work registered while a drain is already waiting is included before shutdown continues.

The adapters await registered async command/message/hears handlers. This is required so the core lifecycle does not disconnect MongoDB while an accepted support operation is still running.

`start()` registers common handlers once per addon singleton to avoid duplicate dispatch when an adapter is restarted after a transient runtime failure.
