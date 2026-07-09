const RECIPE_MEAL_TYPE_KEYS = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

function normalizeRecipeMealTypes(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  const unique = [...new Set(source.filter((type) => RECIPE_MEAL_TYPE_KEYS.includes(type)))];
  return unique.length ? unique : [...RECIPE_MEAL_TYPE_KEYS];
}

function recipeSupportsMealType(recipe, mealType) {
  return normalizeRecipeMealTypes(recipe?.meal_types).includes(mealType);
}

export { RECIPE_MEAL_TYPE_KEYS, normalizeRecipeMealTypes, recipeSupportsMealType };
