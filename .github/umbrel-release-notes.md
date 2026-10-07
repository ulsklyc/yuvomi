<!-- version: 2.74.0 -->
This update brings a handful of new functions and a broad tidy-up of how the app looks and moves.

A planned meal can name the member who cooks it, and the week plan and the overview show who that is. A household can put its members in an order of its own, and every list of people follows it. A loan can carry a due day, so "Mark paid" dates an installment on that day in its own month, and an installment whose month is already over no longer lands in the month you tapped in. The Singapore dollar and Singapore as a region are new, the calendar tile on the overview can list 8 or 12 appointments instead of 5, each device chooses how long it waits before the photo screensaver starts, and revoked or expired API tokens can be removed from the list.

Removing a member no longer takes their entries with it: an account that has left traces in shared data is deactivated instead of deleted. Deleting a shared expense leaves a trace instead of rewriting the books, a monthly shared expense on the 29th, 30th or 31st no longer skips a month, and resuming a paused one no longer books every date it missed.

Across the modules, headers, tabs, dialogs and lists now share one layout and one kind of movement, and many pages show more on the first screen of a phone. With read-only access, the meal plan, recipes, pantry, inventory and documents no longer offer buttons that end in an error message. A module that is switched off for the household is left out of the overview and no longer works in the background.

The update runs five database migrations on first start. They add the deactivated state and the order of household members, the due day of a loan, the anchor day of a recurring shared expense and the cook of a meal. No existing entry is lost and no action is needed; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.74.0
