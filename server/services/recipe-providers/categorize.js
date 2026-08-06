/**
 * Modul: Zutaten-Kategorisierung für importierte Rezepte
 * Zweck: Best-effort Zuordnung von Zutaten aus gespiegelten Rezepten (Mealie,
 *        Tandoor, ...) zu den bestehenden shopping_categories-Namen (server/db.js
 *        Migration v5). Ein vom Provider mitgeliefertes Zutaten-Label (vom Nutzer
 *        dort frei vergeben) wird zuerst versucht, dann eine Keyword-Liste auf dem
 *        Zutatennamen - beides ist Raten, kein Abgleich gegen eine feste Taxonomie.
 *        Fällt beides durch, landet die Zutat unter 'Sonstiges', genau wie jede
 *        andere unkategorisierte Zutat im Haushalt.
 * Dependencies: keine
 */

const FALLBACK_CATEGORY = 'Sonstiges';

// Deutsche und englische Stichworte, da Provider-Instanzen in beiden Sprachen
// befüllt sein können. Reihenfolge ist irrelevant, die erste Übereinstimmung zählt.
const KEYWORDS = {
  'Obst & Gemüse': [
    'apple', 'apfel', 'banana', 'banane', 'tomato', 'tomate', 'onion', 'zwiebel',
    'garlic', 'knoblauch', 'potato', 'kartoffel', 'carrot', 'karotte', 'lemon',
    'zitrone', 'lime', 'pepper', 'paprika', 'lettuce', 'salat', 'spinach', 'spinat',
    'cucumber', 'gurke', 'vegetable', 'gemüse', 'fruit', 'obst', 'herb', 'kräuter',
    'basil', 'basilikum', 'parsley', 'petersilie', 'mushroom', 'pilz',
  ],
  'Backwaren': [
    'flour', 'mehl', 'bread', 'brot', 'baking powder', 'backpulver', 'yeast',
    'hefe', 'bun', 'brötchen', 'tortilla', 'noodle', 'nudel', 'pasta',
  ],
  'Milchprodukte': [
    'milk', 'milch', 'cheese', 'käse', 'butter', 'cream', 'sahne', 'yogurt',
    'joghurt', 'egg', 'ei', 'eier',
  ],
  'Fleisch & Fisch': [
    'chicken', 'hähnchen', 'huhn', 'beef', 'rind', 'pork', 'schwein', 'fish',
    'fisch', 'salmon', 'lachs', 'shrimp', 'garnele', 'bacon', 'speck', 'sausage',
    'wurst', 'meat', 'fleisch',
  ],
  'Tiefkühl': ['frozen', 'tiefkühl', 'tiefgefroren', 'ice cream', 'eis'],
  'Getränke': ['juice', 'saft', 'wine', 'wein', 'beer', 'bier', 'water', 'wasser', 'soda', 'cola'],
  'Haushalt': ['foil', 'folie', 'napkin', 'serviette', 'detergent', 'waschmittel'],
  'Drogerie': ['soap', 'seife', 'shampoo', 'toothpaste', 'zahnpasta'],
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wortgrenzen statt reinem .includes(): sonst matcht das kurze Stichwort 'ei'
// (Ei/Eier) versehentlich mitten in 'Fleisch' ('fl-ei-sch'). \p{L}/\p{N} statt
// des ASCII-\b, damit Umlaute (ä/ö/ü) keine falsche Wortgrenze erzeugen.
function containsWord(text, keyword) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(keyword)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

function matchKeywords(text) {
  if (!text) return null;
  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    if (keywords.some((kw) => containsWord(text, kw))) return category;
  }
  return null;
}

/**
 * @param {{ labelName?: string, foodName?: string }} ingredient
 * @returns {string} Name aus shopping_categories, oder 'Sonstiges' als Fallback.
 */
export function categorizeIngredient({ labelName, foodName } = {}) {
  return matchKeywords(labelName) || matchKeywords(foodName) || FALLBACK_CATEGORY;
}
