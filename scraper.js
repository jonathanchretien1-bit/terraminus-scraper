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
    
    await page.waitForTimeout(5000);

    // Recherche de n'importe quel lien pointant vers une propriété pour inspecter la structure
    const listings = await page.$$eval('a', links => {
      return links
        .map(link => ({ href: link.href, text: link.innerText }))
        .filter(item => item.href.includes('/en/') || item.href.includes('/fr/') && item.href.includes('-a-vendre/'))
        .map(item => ({ url: item.href, price: '', address: item.text }));
    });

    // Supprimer les doublons d'URL
    const uniqueListings = Array.from(new Set(listings.map(s => s.url)))
      .map(url => listings.find(s => s.url === url));

    console.log(`${uniqueListings.length} liens de propriétés extraits.`);

    // Envoi vers Base44
    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    
    console.log('Envoi vers Base44 (Valeur du secret présente ?:', !!process.env.CENTRIS_INGEST_SECRET, ')');
    
    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': process.env.CENTRIS_INGEST_SECRET || ''
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
