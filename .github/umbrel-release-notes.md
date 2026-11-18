<!-- version: 2.92.0 -->
This update fixes the calendar search. With more than 100 matching events it kept the oldest ones, so an old series or a year of past events could push upcoming events out of the result. Upcoming events and series now come first. Lists in search and on the overview also keep the same order on every load when two entries share a date or a title.

Taking checked shopping items into the pantry no longer fails when a storage location was deleted while the dialog was open. Yuvomi now says that the location is gone and takes nothing over.

If you use the API with your own scripts or integrations: notes, birthdays, quick links, reminders, notification channels, modules, permissions, e-mail, weather, family, search, kitchen, screensaver, wall displays, recipes, recipe providers and the pantry now check every request against the published API description. Input that was quietly accepted or reinterpreted before, such as an id like "12abc" or a number sent as text, is now refused with a 400 that names the field. The app itself sends nothing that is refused.

This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.92.0
