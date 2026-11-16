<!-- version: 2.91.0 -->
This update makes the backup card tell one time. On a server that runs in another time zone than your household, the card in Settings > Household > Backup and restore said "Daily at 02:00" above "Next backup 03:00" for the same run. The schedule now reads in your household's time zone, like the next backup below it.

Four household settings are now for administrators only: the currency, the app name, the housekeeping payment tasks and the default length of new events. In the app, members never saw these controls; they could only be changed through the API. On the Appearance page members now see the household currency as a read-only row.

A wall display now reads only the tasks and events the whole household sees, on every page and in every list, count and countdown. In the app a display could not be assigned to a task or an event, so nothing changes on a wall you have set up.

If you use the API with your own scripts: every "administrators only" refusal now has the same answer, `403` with `reason: "admin_required"`. Scripts that compared the error text should read the `reason` instead.

This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.91.0
