<!-- version: 2.84.0 -->
This update lays the groundwork for a native phone app, lets documents name the person they are about and brings a broad round of fixes across the app and the installer.

A document can now say who it is about, and documents that are about to expire show up in Key dates. For a coming native client, the server can now sign in a phone as a device of its own, pair it with a short code or QR code from a browser for households without passwords, and list upcoming reminders so the phone can schedule them. Nothing changes for browsers or existing API tokens.

Reminders of a recurring event stay where they belong when the event is saved, a shared event or waste pickup reminds a household channel only once, and a reminder you have already seen stays seen. Resetting a subscribed calendar event restores it at once, repeating tasks keep their time on CalDAV servers, and vitals accept units Yuvomi can convert. Titles in Tasks and Budget stand in full on narrow phones, and error messages in Settings speak your language.

The admin routes for notification channels can no longer reach a member's personal channel, so a member's private reminders stay out of reach of anything an admin sets up. The container now also starts with no-new-privileges.

This update changes the database. The changes are applied automatically on the first start and need no action from you; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.84.0
