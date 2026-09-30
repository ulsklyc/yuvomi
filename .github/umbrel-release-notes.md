<!-- version: 2.70.0 -->
This is a large interface update with security fixes, and updating is recommended.

Deleting a document folder no longer reveals documents or linked records you are not allowed to see. The WebDAV backup target and CalDAV accounts now ask for the password again when their server or username changes, instead of sending the stored password to the new address. Documents and images are no longer kept in the browser's cache after you sign out.

Settings are reorganised into Account, Household and Modules, with one sheet per module; on a desktop the list stays beside the open sheet. The web installer now looks and works like the app, and first-run setup keeps the language you chose.

The calendar gives phones more room: the header takes two rows, you can swipe between months, weeks and days, and the month shows the selected day below the grid. New events in the week and day views come from a double-click or a long press, so a click beside an event only closes it. On a phone the overview starts with what is due today, and the wall display keeps its exit button in view and leaves with the back button.

Search finds parts of words across every module and opens places and actions. Documents show a preview of the file itself, vital readings and lab values can be edited, and counted texts use the right plural forms in Czech, Polish, Russian, Ukrainian and Arabic. Many dates now follow the household's time zone instead of the device's or the server's, including medication reminders, housekeeping visits and "due today".

The update runs one database migration on first start. It removes shared-expense ledger rows whose expense no longer exists, so balances only count real expenses. No action is needed; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.70.0
