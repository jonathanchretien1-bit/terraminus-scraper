const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Mode Debug & API)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let capturedListings = [];

  // Intercepter toutes les réponses pour capturer le JSON de Centris peu importe son nom
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('centris.ca') && (url.includes('PropertyList') || url.includes('Search') || url.includes('Get'))) {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const json = await response.json();
          // Chercher un tableau de propriétés dans la réponse JSON
          const data = json.d?.Result?.Properties || json.Result?.Properties || json.d || json.Result || json;
          if (Array.isArray(data)) {
            console.log(`Données JSON interceptées sur l'URL: ${url} (${data.length} éléments)`);
            capturedListings = data.map(p => ({
              url: `https://www.centris.ca/fr/propriete~a-vendre~.../${p.Id || p.MLS || ''}`,
              price: String(p.Price || p.FormattedPrice || ''),
              address: String(p.Address || p.FullAddress || '')
            }));
          }
        }
      } catch (e) {
        // Ignorer les erreurs de parsing
      }
    }
  });

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    await page.waitForTimeout(7000);

    // Fallback de secours : si l'API n'a pas intercepté, on récupère les liens visibles sur la page
    if (capturedListings.length === 0) {
      console.log("Tentative de récupération directe dans le DOM...");
      const domListings = await page.$$eval('a', links => {
        return links
          .map(l => ({ href: l.href, text: l.innerText }))
          .filter(l => l.href && l.href.includes('-a-vendre/'))
          .map(l => ({ url: l.href, price: '', address: l.text.trim() }));
      });
      
      // Dédoublonner
      const uniqueMap = new Map();
      domListings.forEach(item => uniqueMap.set(item.url, item));
      capturedListings = Array.from(uniqueMap.values());
    }

    console.log(`Total terrains prêts à envoyer : ${capturedListings.length}`);

    // Envoi vers Base44
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const secretValue = process.env.CENTRIS_INGEST_SECRET ? process.env.CENTRIS_INGEST_SECRET.trim() : '';

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
