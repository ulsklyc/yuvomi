// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 22,
    description: 'Normalize calendar dentist icon',
    up: `
      UPDATE calendar_events SET icon = 'drill' WHERE icon = 'tooth';
    `,
  };
