<!-- version: 2.96.0 -->
This update is mostly about reliability when two things happen at the same moment. Several actions check something, wait for a server or a file upload, and only then save; a change made in that moment could be lost, overruled or saved twice. That is fixed across the app: a sync no longer undoes an edit made while it runs, a reminder is no longer sent twice when a push service answers slowly, Outlook, CardDAV and recipe provider syncs of one account no longer get in each other's way, and a calendar attachment upload no longer writes back an older version of the event. A password reset link now works exactly once, and rights count at the moment of saving, not only when the request arrived.

When a recurring event or a CalDAV account is changed elsewhere while you save it, the app now says "changed elsewhere, please save again" instead of showing a general error.

Large shopping lists, calendars and task lists change quickly again; renaming or clearing thousands of items no longer takes seconds.

Under the hood, the database code was reorganised: every migration is now its own file, and a new installation starts from a schema baseline instead of replaying all migrations. Existing installations are not affected by this part.

This update changes the database once on start and rebuilds the search index. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.96.0
