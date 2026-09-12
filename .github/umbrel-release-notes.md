<!-- version: 2.65.3 -->
This is a security release for the Housekeeping module, and it changes nothing about how Yuvomi looks day to day. Once a visit is marked paid, only an admin can change or delete it. A household member could get around that by unchecking the visit's payment task in Tasks, which marked the visit as unpaid again and opened it up for changes. Unchecking the payment task of a paid visit now needs an admin as well. Checking the task off stays open to everyone who could do so before.

One thing to know after updating: if members of your household used to correct an accidental payment by unchecking its task, an admin now has to do that.

Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.65.3
