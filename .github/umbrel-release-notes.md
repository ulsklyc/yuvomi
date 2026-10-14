<!-- version: 2.77.1 -->
This update fixes calendar sync details, makes error messages on the health pages speak your language, and tightens how reminder and task sync talk to a CalDAV server.

A "last day of the month" series now keeps the date you entered: it goes out with the same start on every upload, and the next sync no longer writes the start that came back into Yuvomi or moves its reminders. A timed series that ends on a date ends on the same occurrence in Google as in Yuvomi. Renaming an event no longer shifts it when the app and the server run in different time zones and no household time zone is set.

The health pages and the waste source dialog now explain a failed save or refresh in the language of the app instead of showing the server's text. A contact or shopping item already deleted on a CalDAV or CardDAV server no longer blocks its sync, and reminder and task sync check every request against the account's address, as event sync already did.

The update runs three database migrations on first start. They add columns the calendar sync and the waste sources need; no action is needed. As always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.77.1
