const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Debug Liens)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    
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

    const rawLinks = await page.$$eval('a', links => links.map(l => l.href).filter(Boolean));
    console.log(`Total de liens bruts trouvés : ${rawLinks.length}`);

    // Afficher 5 exemples de liens pour comprendre leur format exact dans les logs GitHub
    console.log("Exemples de liens bruts:", rawLinks.slice(0, 5));

    // Filtre élargi : les fiches sur Centris contiennent généralement '~' ou 'terrain'
    const propertyLinks = rawLinks.filter(href => href.includes('centris.ca') && (href.includes('~') || href.includes('terrain')));
    const uniqueListings = Array.from(new Set(propertyLinks)).map(url => ({
      url,
      price: '',
      address: ''
    }));

    console.log(`Terrains uniques prêts à envoyer : ${uniqueListings.length}`);

    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const secretValue = process.env.CENTRIS_INGEST_SECRET ? process.env.CENTRIS_INGEST_SECRET.trim() : '';

    console.log('Envoi vers Base44...');
    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': secretValue,
        'Authorization': `Bearer ${secretValue}` // Sécurité au cas où Base44 lit le header Bearer
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
