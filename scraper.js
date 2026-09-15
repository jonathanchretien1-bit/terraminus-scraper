const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Mode Stealth)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigation sur Centris
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'domcontentloaded' });
    
    // Attendre que les éléments de propriétés s'affichent
    await page.waitForSelector('.teaser, .property-card-container, div[data-id]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Extraction élargie pour attraper les fiches Centris
    const listings = await page.$$eval('.teaser, .property-card-container, div[data-id]', cards => {
      return cards.map(card => {
        const priceEl = card.querySelector('.price, [itemprop="price"]');
        const linkEl = card.querySelector('a.property-thumbnail, a.thumbnail');
        const addressEl = card.querySelector('.address, [itemprop="address"]');
        
        return {
          url: linkEl ? linkEl.href : '',
          price: priceEl ? priceEl.innerText.trim() : '',
          address: addressEl ? addressEl.innerText.trim() : ''
        };
      }).filter(item => item.url); // Garde uniquement ceux qui ont un lien valide
    });

    console.log(`${listings.length} terrains extraits de la page.`);

    // Envoi sécurisé vers ton endpoint Base44
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    
    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': process.env.CENTRIS_INGEST_SECRET
      },
      body: JSON.stringify({ listings })
    });

    const result = await response.json();
    console.log('Réponse de Base44:', result);

  } catch (error) {
    console.error('Erreur lors du scraping:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
