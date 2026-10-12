<!-- version: 2.76.0 -->
This update makes the app quieter to look at and quicker to start, and fixes a number of sync problems.

Lists carry fewer buttons: editing, deleting and the other actions of a row now sit behind one menu or a swipe. Fields, settings rows, dialogs and the sidebar share one look, the reading views of events, tasks, notes, documents and recipes show what matters first, and the budget screens each have one leading figure. Rows and cards answer a tap, sheets and deeper pages move in a direction, and the app starts faster on a slow connection because an update now transfers only the files that changed.

There are a few new things. Loans can be put in order by interest rate or by remaining balance, the payment reminder can be turned off for a single subscription, the shopping tile on the overview shows the lists you choose, and "Grant bonus" is on the Rewards overview. On a wall tablet, today's programme names the calendar and the time span of an appointment.

Sync is more careful. A calendar or reminder server that refuses a change is no longer taken for a success, an entry no longer doubles when the server's answer gets lost, and an event written to Google keeps its time when the Google calendar is set to another time zone, provided the household time zone is set in the settings. A subscription now shows in every month of the budget it is due in, and a wall tablet shows events again when the overview is set to "Assigned to me". Single sign-on no longer fails over the spelling of the redirect address.

The update runs one database migration on first start, which adds the reminder switch to subscriptions. No existing entry is changed and no action is needed; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.76.0
