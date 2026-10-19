// R4 · B23: the privacy and terms pages — open without signing in, in English or Tamil. Nothing here talks to the shop.
const blocks = [...document.querySelectorAll('[lang-block]')];
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const paint = () => {
  document.documentElement.lang = lang;
  for (const b of blocks) b.hidden = b.dataset.lang !== lang;
};
document.getElementById('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; paint(); });
paint();
