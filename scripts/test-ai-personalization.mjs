import assert from 'node:assert/strict';
import { personalization } from '../src-tauri/renderer/src/ai-personalization.js';
const defaults = { warmth: 'neutral', emoji: 'few', length: 'short', tone: 'neutral', customInstructions: '' };
assert.deepEqual(personalization({}), defaults);
assert.deepEqual(personalization({ aiPersonalization: { warmth: 'warm', emoji: 'none', length: 'detailed', tone: 'casual', customInstructions: '  Be kind  ' } }),
  { warmth: 'warm', emoji: 'none', length: 'detailed', tone: 'casual', customInstructions: 'Be kind' });
assert.deepEqual(personalization({ aiPersonalization: { warmth: 'evil', emoji: null, length: 'forever', tone: 'other' } }), defaults);
assert.equal(personalization({ aiPersonalization: { customInstructions: 'x'.repeat(5000) } }).customInstructions.length, 4000);
console.log('PASS: personalization defaults, stored preferences, invalid enums and instruction limit');
