import { op } from '../helpers.js';

export function searchPaths() {
  return {
    '/api/v1/search': {
      get: op({
        summary: 'Search across modules',
        description: 'Query `q` (at least 2 characters). Every word must match (AND); from 3 characters a word also matches inside longer words ("milk" finds "oatmilk"), accents and ß/ss are folded. Returns one list per result type, at most 5 hits each: `tasks`, `events`, `notes`, `contacts`, `items`, `meds`, `activities`, `waste`, `recipes`, `pantry`, `inventory`, `documents`, `birthdays`, `budget`. A type stays an empty list when its module is denied to the caller (role or token scope) or switched off for the household; rows follow the visibility rules of the module list they come from. A hit whose words are not all in its `title` carries `excerpt`: a short piece of the first visible field that holds a missing word (description, note text, notes), cut at word boundaries with `…` where it was shortened.',
        tag: 'Search',
      }),
    },
  };
}
