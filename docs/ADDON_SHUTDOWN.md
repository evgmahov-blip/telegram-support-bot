# Realtime addon shutdown contract

Signal, Slack, and Discord are long-lived ingress adapters. Their `stop()` methods follow the same shutdown contract used by the core lifecycle:

1. mark the addon as stopping before closing transport resources;
2. cancel scheduled reconnects so a close/error callback cannot resurrect ingress;
3. clear platform timers such as Discord heartbeats and Signal typing fallbacks;
4. close the active WebSocket;
5. drain message handling that was already accepted, subject to the bounded shutdown deadline.

Incoming platform callbacks are tracked through `AsyncWorkTracker`. The tracker uses a stable drain loop, so work registered while a drain is already waiting is included. The drain has a 5-second deadline so one stuck integration cannot block the rest of graceful shutdown indefinitely.

Signal, Slack, and Discord HTTP clients use a 10-second Axios request timeout as a source-level bound for stalled network calls. If accepted work still has not settled when the tracker deadline expires, addon shutdown yields to the remaining core shutdown stages instead of preventing persisted-event, webhook, HTTP server, and MongoDB cleanup.

The adapters await registered async command/message/hears handlers during normal operation so accepted work is tracked as a complete async chain rather than detached callbacks.

`start()` registers common handlers once per addon singleton to avoid duplicate dispatch when an adapter is restarted after a transient runtime failure.
