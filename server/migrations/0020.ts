// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 20,
    description: 'User profile pictures',
    up: `
      ALTER TABLE users ADD COLUMN avatar_data TEXT;
    `,
  };
