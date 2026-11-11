<!-- version: 2.88.1 -->
This update closes a gap in medication reminders. A reminder sent to a person's own notification channel (Gotify, ntfy or a webhook) now passes the same protection against requests into the local network as every other reminder. Nothing changes on screen.

If such a channel lives in your local network, medication reminders to it now need the setting `NOTIFICATION_ALLOW_PRIVATE_NETWORK=true`, as every other reminder to that channel already does. If your other reminders arrive there today, the setting is in place and there is nothing to do.

The next update will be a foundation release. It changes how Yuvomi is tested and operated, adds a readiness check for monitoring and keeps the status of the last backup across a restart. It brings no visible change and does not touch the database.

This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.88.1
