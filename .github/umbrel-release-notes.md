<!-- version: 2.71.0 -->
This update adds Brazilian Portuguese and fixes several things people ran into after 2.70.0.

Brazilian Portuguese is now its own language in the app, next to the existing Portuguese. A browser set to Brazilian Portuguese picks it on its own.

Changing a recurring budget payment for all future months no longer rewrites its first booking, which could lie years back and move old amounts to another account. Members who may edit the meal plan can now edit and delete recipes that someone else added; before, saving failed with "Not authorized", even for an admin.

When the weather service cannot be reached, the weather tile now stays on the overview and says the weather is currently unavailable, instead of disappearing without a trace. In the app added to an iPhone home screen, the dark strip below the tab bar is gone. Switches that are off are easier to see, and in Arabic and Persian "on" sits on the left.

The update runs one database migration on first start. It gives every recurring budget payment a definition of its own, without changing any existing entry. No action is needed; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.71.0
