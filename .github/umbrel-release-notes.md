<!-- version: 2.90.0 -->
This update makes the global search show what your pages show. It now finds tasks and notes that someone shared with everyone, tasks you are assigned to together with others, and the medications and activities of a person you care for. An archived task is marked as archived in the results. The search also no longer finds a task that someone else set to "only me".

The backup card in Settings > Household > Backup and restore tells you more. It shows why the last scheduled run failed, keeps the date of the last backup that succeeded, names the next scheduled run, and warns when at least two scheduled backups have been missed. "Create backup now" no longer reports success when the backup failed.

Admins find a new diagnostics section in the "System" sheet. One button copies version, database and backup state as plain text for a bug report; it contains no password, key or path and nothing about members.

If you connect an AI assistant over MCP, it now creates tasks, shopping items and events exactly as the app does. Writing over MCP now needs an API token; a client that signs in with a browser session cookie alone is refused.

Behind the scenes, all access rules now live in one place and are checked by a test for every kind of account. This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.90.0
