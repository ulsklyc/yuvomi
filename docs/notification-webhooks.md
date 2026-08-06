# Notification webhooks

Yuvomi can deliver every due reminder to a generic HTTP webhook in addition to
Web Push, Gotify, and ntfy. Webhook channels use the same per-channel delivery
tracking, retry, and deduplication flow as the other notification providers.

## Configure a channel

Only administrators can manage household notification channels.

1. Open **Settings → Personal → Notifications**.
2. Under **Household channels**, select **Add channel**.
3. Choose **Webhook** as the provider and enter a name.
4. Enter the complete HTTP or HTTPS endpoint URL.
5. Optionally enter a Bearer token. Yuvomi stores it as a write-only secret and
   sends it as `Authorization: Bearer <token>`.
6. Save the channel, enable it, and use **Send test** to verify the endpoint.

The receiver must return a successful HTTP status (`2xx`). Failed deliveries
are retried by the notification scheduler with the same backoff and attempt
limit used for Gotify and ntfy. Secrets are never returned by the channel API
or written into delivery error messages.

## Request format

Yuvomi sends an HTTP `POST` with `Content-Type: application/json`:

```json
{
  "event": "notification",
  "notification": {
    "title": "Yuvomi",
    "body": "Take out the bins",
    "url": "/reminders",
    "tag": "reminder-42",
    "priority": "default"
  },
  "sentAt": "2026-08-06T20:30:00.000Z"
}
```

`sentAt` is generated for each delivery attempt. The notification `tag`
identifies the reminder and can be used by receivers for their own
deduplication. The `url` is relative to the Yuvomi application.

## Security notes

- Use HTTPS whenever the endpoint is outside a trusted private network.
- Give the webhook a dedicated, revocable token with only the permissions it
  needs.
- Treat notification bodies as household data. The receiving service gets the
  reminder title and, for subscriptions, the name, amount, currency, and next
  renewal date.
- Rotate a token by entering a replacement in the channel form. Leaving the
  field empty preserves the stored token.

