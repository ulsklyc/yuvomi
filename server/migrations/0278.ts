// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 278,
    description: 'Wall displays: centrally managed night hours and screensaver options (#2436)',
    // NULL preserves existing device-local choices until an administrator saves.
    up: `ALTER TABLE display_accounts ADD COLUMN device_settings TEXT CHECK(device_settings IS NULL OR json_valid(device_settings));`,
  };
