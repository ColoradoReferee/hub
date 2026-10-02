// config.js · Colorado Referees Hub · the only file with settings in it
//
// One thing to fill in: publishableKey. Supabase → Project Settings → API Keys →
// Publishable key. It is safe to be public; row-level security protects the data.
window.HUB = {
  org: 'csa',
  supabaseUrl: 'https://dtjnwdlzxzvwsccwcmkw.supabase.co',
  publishableKey: 'sb_publishable_eH2WN0U_uZFDxAOXW6U1tg_JKwpbJAW',
  // The current backend. Check-ins, Help, scores and notes go through it so
  // the sheet and the database both get them. Retires with the old pages.
  backend: 'https://script.google.com/macros/s/AKfycbxQXvVq-gtGfUvgXF3NJXkFU_4aVlqFclU0bF0B0dQWbpjb42tstU7UnbKLf5DFP3PY/exec',
  // The old hub, for the pages not rebuilt yet (maps).
  oldHub: 'https://jareferee.com/ref/',
  // The Reference Library.
  library: 'https://coloradoreferee.github.io/CREST_Reference/',
  hotline: '3035297718',
  hotlineShown: '303-529-7718',
  // Rules page by game-number prefix. Moves into the events table with Setup.
  rules: { UCH: 'rules-uchealth.html', NAT: 'rules-nat1.html' },
  marks: { csa: 'assets/csa-mark.png', program: 'assets/co-referee-program.png', ja: 'assets/jareferee-mark.png' }
};
