<!-- version: 2.88.0 -->
This update renews what Yuvomi is built on. It brings no new feature; pages, data and settings look and work as before.

The app now arrives pre-built. Pages and modules the app already holds on your device open from that copy without asking the server first, and what is available offline stays the same.

Yuvomi now needs Chrome or Edge 105, Firefox 115 or Safari 15.4 (iOS 15.4 on iPhone and iPad). An older browser shows a short page that names these versions instead of an empty app; update the browser or the device's system, or use another browser. On Firefox ESR 115 and Safari 15.4 to 16, the menus behind a button, the account menu, filters and the date picker now open; they stayed closed there before.

Three fixes come along. Birthdays no longer rewrite their calendar entries every minute, which spares the disk constant small writes. The in-app changelog shows a summary whole when it runs over two lines. On a phone, the tool row above recipes, pantry, meals and shopping folds away on scroll in every supported browser.

If you added a module of your own, it may now import only `/api.js`, `/i18n.js` and `/utils/html.js`; a module that imports another app file stops loading until it is changed.

This update does not change the database, and the way back to 2.87.0 was tried before the release. No action is needed from you.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.88.0
