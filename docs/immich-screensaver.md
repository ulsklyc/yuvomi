# Immich photo screensaver

Yuvomi can replace the dashboard with photos from an [Immich](https://immich.app/) server after
five minutes without keyboard, pointer, touch, or scroll activity. It requests a random set of
photos, changes the photo every 20 seconds, and returns to Yuvomi on the next interaction. Photo
metadata moves between corners so that the screensaver does not introduce another fixed bright
area. If Immich is unavailable, Yuvomi leaves the current screen visible and tries again after a
later idle period.

## Before you start

Create an Immich API key with these permissions:

- `asset.read`, to select random image assets;
- `asset.view`, to retrieve preview-sized thumbnails.

The Immich server must be reachable from the Yuvomi server or container. A URL that works only in
your browser is not sufficient. For two containers on the same Docker network, this may be an
internal service URL such as `http://immich-server:2283`; otherwise use the HTTPS address at which
Yuvomi's server can reach Immich.

## Configure in Yuvomi

1. Sign in as an administrator.
2. Open **Settings → Administration → Immich**.
3. Enter the Immich server URL. Both the server root and a URL ending in `/api` are accepted.
4. Enter the API key.
5. Optionally enter an Immich album UUID. Leave it empty to use the whole library.
6. Select **Test** to verify the credentials and optional album filter.
7. Select **Preview** to save the current values and open the real screensaver immediately.

The API key is write-only: after it is saved, the browser receives only an indication that a key
exists. Leaving the field empty preserves the saved key.

The album UUID is the UUID portion of an Immich album URL. Only image assets are selected; videos
are not shown by the screensaver.

## Configure through environment variables

```env
IMMICH_URL=https://photos.example.com
IMMICH_API_KEY=your-api-key
IMMICH_SCREENSAVER_ALBUM_ID=optional-album-uuid
```

The album ID is optional. Non-empty environment variables take precedence over database values,
and their matching controls become read-only in Settings. Restart Yuvomi after changing them.

## Security and troubleshooting

- Enable `DB_ENCRYPTION_KEY` to encrypt a key saved through Settings at rest. Without database
  encryption, Yuvomi logs a warning when it stores an Immich API key.
- Yuvomi proxies thumbnails so the API key is never placed in image URLs or sent to the tablet.
- Use **Test** first if **Preview** cannot load a photo. Verify the permissions, server
  reachability, album UUID, and that the library or album contains images.
- A successful test with an empty album is valid, but Preview needs at least one accessible image.
- The screensaver applies throughout the authenticated app, not only on the dashboard route.
