/**
 * One runtime-native identity key shared by the Notes API and browser picker.
 * NFKC unifies equivalent spellings; repeated locale-independent case conversion
 * also handles expansions such as ß -> SS. Keep both runtimes on this function.
 */
export function categoryNameKey(name) {
  return String(name)
    .normalize('NFKC')
    .toUpperCase().toLowerCase()
    .toUpperCase().toLowerCase()
    .normalize('NFKC');
}
