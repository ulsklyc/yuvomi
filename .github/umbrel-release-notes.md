<!-- version: 2.77.0 -->
This update brings several local calendars, a calmer shopping list and a wall mode that says more, and it makes calendar and reminder sync considerably more careful.

Events can now be kept in several local calendars, each with its own subscription link, and an ICS import asks which calendar it should go to. On the shopping list, checked-off items collect in one collapsed section at the end, and an item can be moved to another list without typing it again. Tasks can be dragged into an order of your own within a category, tapping a category in the budget overview filters the transactions, and the Netherlands get the date format DD-MM-YYYY.

Wall mode now names today's tasks under each person and shows only what the whole household may see, whoever opened it. The photo screensaver can show the time and fill the screen, can be started by hand from the wall footer, and works on a paired wall tablet once an administrator switches it on for that tablet.

Sync with CalDAV, iCloud and Google loses fewer changes: an entry edited, moved or deleted while it is being uploaded ends up where you last put it, a deleted entry no longer comes back after an interrupted upload, and with several CalDAV accounts an event belongs to the account that brought it. A waste calendar address that stops serving its calendar no longer wipes your pickups, and error messages on the shopping and waste pages are in your language.

The update runs eight database migrations on first start. They add the new calendars and the columns the sync needs, and assign existing CalDAV events to their account; no action is needed. With more than one CalDAV account, an event that cannot be assigned with certainty stays without an account until the next sync delivers it. As always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.77.0
