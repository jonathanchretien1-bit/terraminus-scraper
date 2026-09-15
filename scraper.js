const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Mode Stealth)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigation sur Centris (page des terrains)
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'domcontentloaded' });
    
    // Attendre le chargement des fiches ou de la carte
    await page.waitForTimeout(5000);

    // Extraction des données de base
    const listings = await page.$$eval('.property-card', cards => {
      return cards.map(card => {
        return {
          url: card.querySelector('a')?.href || '',
          price: card.querySelector('.price')?.innerText || '',
        };
      });
    });

    console.log(`${listings.length} terrains trouvés. Envoi vers Base44...`);

    // Envoi des données vers ton endpoint Base44 sécurisé
    const response = await fetch('https://earth-minus-scale.base44.app/functions/runCentrisScrape', {
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
