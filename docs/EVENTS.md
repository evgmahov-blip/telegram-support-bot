# Event replay API

Enable the read-only event feed in `config.yaml`:

```yaml
api_enabled: true
api_token: "replace-with-a-long-random-secret"
```

The default listener is port `8080`. Docker publishes it as `127.0.0.1:8080` on the host.

Request:

```text
GET /events?since=123&limit=100
Authorization: Bearer <api_token>
```

Response events are ordered by ascending `seq` and include `event_id`, `seq`, `type`, `ticket_id`, `actor_id`, `timestamp`, and `metadata`. Persist the returned `next_since` and use it for the next catch-up request.

Ticket message bodies are not copied into event metadata. Full conversation history remains in the append-only `TicketMessage` collection; `llm_memory_depth` only limits AI reads.
