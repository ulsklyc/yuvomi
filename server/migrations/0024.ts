// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 24,
    description: 'Use tooth icon for dentist calendar events',
    up: `
      UPDATE calendar_events SET icon = 'tooth' WHERE icon = 'drill';
    `,
  };
