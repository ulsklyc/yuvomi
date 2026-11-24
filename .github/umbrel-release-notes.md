<!-- version: 2.95.0 -->
Passwords are now stored with Argon2id instead of bcrypt. Existing passwords keep working: each account switches over on its next successful sign-in, and nobody has to reset anything. A password longer than 72 bytes now counts in full. Please note: once you are on this version, going back to an older one means every account that has signed in or changed its password since has to reset it, because older versions cannot read the new hashes.

A request with broken JSON no longer writes part of its body into the server log. Before, that could put part of a password into the log at sign-in.

This update is otherwise mostly about the API. If you use it with your own scripts or integrations: the calendar, the tasks, the preferences and push, sign-in and your own account, account administration and the calendar feeds now check every request against the published API description, like the modules before them. Every list in a request has a maximum length, and calendar events with an unreadable attachment or an assignee without an account are refused with a 400 instead of an internal error. The app itself sends nothing that is refused. An undocumented "role": "admin" no longer creates an administrator; use "system_admin": true.

Editing a task moves its "last changed" time again; this had been frozen since a much older update. A member whose stored colour is in an old format can change their profile again.

This update changes the database once on start to restore the task timestamp. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.95.0
