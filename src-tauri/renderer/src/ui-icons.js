const svg = paths => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const copyIconHtml = () => svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>');
export const checkIconHtml = () => svg('<path d="m5 12 4 4L19 6"/>');
export const errorIconHtml = () => svg('<path d="m6 6 12 12M6 18 18 6"/>');
