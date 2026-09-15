const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Mode Stealth)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    
    // Attendre un peu pour laisser le JS de Centris s'exécuter
    await page.waitForTimeout(5000);

    // Afficher le titre de la page pour voir si on est bloqué ou non
    const pageTitle = await page.title();
    console.log('Titre de la page récupérée :', pageTitle);

    // Extraction large de tous les blocs potentiels
    const listings = await page.$$eval('.property-card-container, .teaser, div[data-id]', cards => {
      return cards.map(card => {
        const priceEl = card.querySelector('.price, [itemprop="price"]');
        const linkEl = card.querySelector('a.property-thumbnail, a');
        const addressEl = card.querySelector('.address, [itemprop="address"]');
        
        return {
          url: linkEl ? linkEl.href : '',
          price: priceEl ? priceEl.innerText.trim() : '',
          address: addressEl ? addressEl.innerText.trim() : ''
        };
      }).filter(item => item.url && item.url.includes('/property/'));
    });

    console.log(`${listings.length} terrains extraits de la page.`);

    // Envoi vers Base44 (même si listings est vide, pour tester si le secret passe enfin)
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    
    console.log('Envoi vers Base44 avec le secret...');
    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': process.env.CENTRIS_INGEST_SECRET || ''
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
