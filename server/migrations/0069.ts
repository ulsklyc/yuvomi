// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 69,
    description: 'Reward-System: optionaler Punktewert je Aufgabe',
    up: `
      ALTER TABLE tasks ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
    `,
  };
