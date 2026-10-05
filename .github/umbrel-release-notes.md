<!-- version: 2.73.0 -->
This update is a round of fixes on top of 2.72.0.

A browser or system that announces Norwegian as `no` or `nn` now gets the Norwegian translation instead of English. Refused requests explain themselves in your language: a locked task, a recipe mirrored from Mealie or Tandoor and an expired page each have their own sentence, and the misleading advice to sign in again is gone.

In the budget, a loan created from "New entry" can now say how many installments are already paid, and the suggestion for that number works when the first due month lies in the past. Editing a shared expense shows amounts in your household's number format. Guests of a shared-expense group are no longer stuck behind the back button.

In the calendar, closing an event dialog on a wide screen no longer moves the address to the previous page. A direct link to a module that is switched off opens the overview, and a wrong address below the pairing or invitation page leads to that page instead of the sign-in page. Housekeeping reads the check-in of visits that were imported by hand correctly for "today" and "last visit".

There are no database migrations in this update and no action is needed.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.73.0
