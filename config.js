// config.js · Colorado Referees Hub · the only file with settings in it
//
// Two things to fill in when this goes live: the publishable key (safe to be
// public; row-level security protects the data) and nothing else. Everything
// about an event comes from the database.
window.HUB = {
  org: 'csa',
  supabaseUrl: 'https://dtjnwdlzxzvwsccwcmkw.supabase.co',
  publishableKey: 'sb_publishable_eH2WN0U_uZFDxAOXW6U1tg_JKwpbJAW',
  // The current backend. Check-ins and Help still go through it this week so
  // the sheet and the database both get them. Retires with the Command Center.
  backend: 'https://script.google.com/macros/s/AKfycbxQXvVq-gtGfUvgXF3NJXkFU_4aVlqFclU0bF0B0dQWbpjb42tstU7UnbKLf5DFP3PY/exec',
  // The current hub, for the pages not rebuilt yet (score entry, incident report, maps).
  oldHub: 'https://jareferee.com/ref/',
  hotline: '3035297718',
  hotlineShown: '303-529-7718',
  // Rules page by game-number prefix. Moves into the events table with Setup.
  rules: { UCH: 'rules-uchealth.html' },
  marks: { csa: 'assets/csa-mark.png', program: 'assets/co-referee-program.png', ja: 'assets/jareferee-mark.png' }
};
