import generated from './generated.js';
import batchFollowup from './batch-followup.js';
import settingsFollowup from './settings-followup.js';

// Generated catalogs contain the base translations; feature additions override them explicitly.
export const catalogs = Object.fromEntries(
  Object.entries(generated).map(([locale, messages]) => [
    locale,
    { ...messages, ...batchFollowup[locale], ...settingsFollowup[locale] },
  ]),
);
