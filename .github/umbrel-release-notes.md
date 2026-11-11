<!-- version: 2.89.0 -->
This update is a foundation release: it changes how Yuvomi is tested and operated, not what it does. It brings no new feature; pages, data and settings look and work as before.

For monitoring there is a new readiness check at `/readyz` next to `/health`. It says whether Yuvomi can serve right now and answers with a reason while a restore is running or the data folder refuses writes. The existing `/health` does not change.

The status of the last backup now survives a restart. Until now the backup page said "never" after a restart until the next scheduled run.

Requests the server has to refuse, such as a corrupt upload, are now answered as a client error instead of a server error, and the details stay in the server log.

This update does not change the database, and the way back to 2.88.1 was tried before the release. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.89.0
