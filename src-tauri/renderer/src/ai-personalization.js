export const PERSONALIZATION_DEFAULTS = Object.freeze({ warmth: 'neutral', emoji: 'few', length: 'short', tone: 'neutral', customInstructions: '' });
export function personalization(settings) {
  const raw = settings?.aiPersonalization ?? {};
  const choices = { warmth: ['neutral', 'warm'], emoji: ['none', 'few', 'many'], length: ['short', 'balanced', 'detailed'], tone: ['neutral', 'casual', 'formal'] };
  const result = { ...PERSONALIZATION_DEFAULTS };
  for (const [key, values] of Object.entries(choices)) if (values.includes(raw[key])) result[key] = raw[key];
  result.customInstructions = String(raw.customInstructions ?? '').trim().slice(0, 4000);
  return result;
}
export function readPersonalization(dialog) {
  const raw = Object.fromEntries([...dialog.querySelectorAll('[data-ai-personality]')].map(node => [node.dataset.aiPersonality, node.value]));
  return personalization({ aiPersonalization: raw });
}
export function populatePersonalization(dialog, settings) {
  const config = personalization(settings);
  for (const node of dialog.querySelectorAll('[data-ai-personality]')) node.value = config[node.dataset.aiPersonality] ?? '';
}
