<!-- version: 2.68.1 -->
This is a security release, and it changes nothing about how Yuvomi looks or works day to day. It closes a way for a household member to take over another member's account, including an admin's, through the email addresses stored on that person's contact.

The email addresses of a contact that belongs to a household member can now only be changed by that person or by an admin, and not through an API token that is limited to certain modules. Adding a contact to a shared-expense group now makes that person a guest of the group instead of a full household member.

One thing to check after updating: accounts that were created from a contact in shared expenses before this update stay as they are, because some of them may be in real use. Look through the household members under Settings for people who were only meant to share expenses, and remove them or add them again as guests. Turning on two-factor sign-in for admins is a good idea either way.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.68.1
