const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Mode API Intercept)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let capturedListings = [];

  // Intercepter l'appel API interne de Centris qui renvoie les données JSON des propriétés
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('GetListing') || url.includes('Search') || url.includes('ajax')) {
      try {
        const json = await response.json();
        if (json && (json.d?.Result?.Properties || json.Result?.Properties || Array.isArray(json))) {
          const props = json.d?.Result?.Properties || json.Result?.Properties || json;
          if (Array.isArray(props)) {
            capturedListings = props.map(p => ({
              url: `https://www.centris.ca/fr/propriete~a-vendre~.../${p.Id || p.MLS}`,
              price: p.Price || p.FormattedPrice || '',
              address: p.Address || ''
            }));
          }
        }
      } catch (e) {
        // Ignorer les réponses non-JSON
      }
    }
  });

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    await page.waitForTimeout(6000);

    console.log(`${capturedListings.length} terrains capturés via l'API.`);

    // Envoi vers Base44
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const secretValue = process.env.CENTRIS_INGEST_SECRET || '';
    
    console.log('Vérification du secret (présent ?):', secretValue.length > 0);

    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': secretValue
      },
      body: JSON.stringify({ listings: capturedListings })
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
