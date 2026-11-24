<!-- version: 2.94.0 -->
This update is mostly about the API. If you use it with your own scripts or integrations: shared expenses, backup, health, contacts, the meal plan, the shopping list, documents and the budget with its subscriptions now check every request against the published API description, like the modules before them. Input that was quietly accepted or reinterpreted before, such as an id like "1abc", a month 13, a number sent as text or an empty amount, is now refused with a 400 that names the field. The app itself sends nothing that is refused.

Some requests could change data by accident and are refused now instead. Editing a document without its access list removed everyone it was shared with, saving the cycle settings with a field left out reset it, editing a shared expense with fields left out cleared its exchange rate and split it equally, and renaming a contact with only some name parts dropped the others. These requests now need the whole record.

In the app, saving a contact keeps its middle name, title and suffix, and shared expenses converted into a currency with other decimal places show and accept the converted amount correctly.

This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.94.0
