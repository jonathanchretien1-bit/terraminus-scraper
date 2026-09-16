const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  console.log('Lancement du scraper Centris (Multi-pages)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allListings = new Set();

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);

    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && pageNum < 50) { // Limite de sécurité à 50 pages (ajustable)
      console.log(`--- Scraping de la page ${pageNum} ---`);
      
      // Petit scroll pour s'assurer que tout est chargé sur la page courante
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // Récupérer les liens de la page
      const rawLinks = await page.$$eval('a', links => links.map(l => l.href).filter(Boolean));
      const propertyLinks = rawLinks.filter(href => href.includes('centris.ca') && href.includes('~'));
      
      propertyLinks.forEach(link => allListings.add(link));
      console.log(`Total cumulé de terrains uniques : ${allListings.size}`);

      // Chercher le bouton "Suivant"
      const nextButton = await page.$('li.PagedList-skipToNext a, a.next, [rel="next"]');
      if (nextButton) {
        const isDisabled = await page.$eval('li.PagedList-skipToNext', el => el.classList.contains('disabled')).catch(() => false);
        if (isDisabled) {
          hasNextPage = false;
        } else {
          await nextButton.click();
          await page.waitForTimeout(4000);
          pageNum++;
        }
      } else {
        hasNextPage = false;
      }
    }

    const uniqueListings = Array.from(allListings).map(url => ({
      url,
      price: '',
      address: ''
    }));

    console.log(`Envoi de ${uniqueListings.length} terrains vers Base44...`);

    const base44Url = 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const secretValue = process.env.CENTRIS_INGEST_SECRET ? process.env.CENTRIS_INGEST_SECRET.trim() : '';

    const response = await fetch(base44Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': secretValue,
        'Authorization': `Bearer ${secretValue}`
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
