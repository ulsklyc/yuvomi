<!-- version: 2.93.0 -->
This update is about the API. If you use it with your own scripts or integrations: the inventory, housekeeping, rewards, waste collection and the shift schedule now check every request against the published API description, like the modules before them. Input that was quietly accepted or reinterpreted before, such as an id like "12abc", a number sent as text or "true" as text for a switch, is now refused with a 400 that names the field. The app itself sends nothing that is refused.

Some requests could change data by accident and are refused now instead. Saving waste reminder settings without the "enabled" field switched the reminder off; it now needs all three fields. Saving a reward participant without "enabled" switched the participation off. Replacing an inventory item with a wrong value for its tracked dates or documents removed them all.

This update does not change the database. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.93.0
