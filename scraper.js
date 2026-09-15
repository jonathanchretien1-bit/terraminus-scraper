const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Scroll & Debug)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    
    // Attendre que la page charge et faire un scroll pour déclencher le chargement des fiches
    await page.waitForTimeout(5000);
    console.log('Défilement de la page pour charger les fiches...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= 3000 || totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 300);
      });
    });

    await page.waitForTimeout(3000);

    // Extraction des liens de propriétés
    const rawLinks = await page.$$eval('a', links => links.map(l => l.href));
    console.log(`Total de liens bruts trouvés sur la page : ${rawLinks.length}`);

    // Filtrer les liens d'annonces
    const propertyLinks = rawLinks.filter(href => href && (href.includes('/propriete/') || href.includes('-a-vendre/')));
    const uniqueListings = Array.from(new Set(propertyLinks)).map(url => ({
      url,
      price: '',
      address: ''
    }));

    console.log(`Terrains uniques filtrés : ${uniqueListings.length}`);

    // Envoi vers Base44
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const secretValue = process.env.CENTRIS_INGEST_SECRET ? process.env.CENTRIS_INGEST_SECRET.trim() : '';

    console.log('Envoi vers Base44...');
    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': secretValue
      },
      body: JSON.stringify({ listings: uniqueListings })
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
