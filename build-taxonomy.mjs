// Emits filter-taxonomy.json (labels + cascade structure) for the storefront rail. No API calls.
import { writeFileSync } from 'node:fs';
import { MAP, KEYS } from './lib.mjs';
const dimLabels = Object.fromEntries(KEYS); // {category:'Category', capacity:'Capacity', ...}
writeFileSync(new URL('./filter-taxonomy.json', import.meta.url), JSON.stringify({ dimLabels, globals: MAP.globals, categories: MAP.categories }));
console.log('wrote filter-taxonomy.json — dims:', Object.keys(dimLabels).length, '| categories:', Object.keys(MAP.categories).length);
