const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function ingest(listings, INGEST_URL, INGEST_SECRET) {
  if (!listings.length) {
    console.log("Aucune annonce à ingérer.");
    return;
  }
  console.log(`→ Envoi de ${listings.length} annonces vers ${INGEST_URL}`);
  
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-ingest-secret": INGEST_SECRET,          // Ajouté pour Base44
      "Authorization": `Bearer ${INGEST_SECRET}` // Ajouté pour Base44
    },
    body: JSON.stringify({ secret: INGEST_SECRET, listings }),
  });
  
  const data = await res.json().catch(() => ({}));
  
  if (!res.ok) {
    console.error(`✖ Ingestion échouée (${res.status}) :`, data?.error || res.statusText);
    process.exit(1);
  }
  console.log(`✓ Ingestion OK :`, JSON.stringify(data));
}

(async () => {
  console.log('Lancement du scraper Centris (Multi-pages)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allListings = new Set();
  const maxPages = parseInt(process.env.MAX_PAGES || "10", 10);

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);

    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && pageNum <= maxPages) {
      console.log(`--- Scraping de la page ${pageNum} / ${maxPages} ---`);
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      const rawLinks = await page.$$eval('a', links => links.map(l => l.href).filter(Boolean));
      const propertyLinks = rawLinks.filter(href => href.includes('centris.ca') && href.includes('~'));
      
      propertyLinks.forEach(link => allListings.add(link));
      console.log(`Total cumulé de terrains uniques : ${allListings.size}`);

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

    const INGEST_URL = process.env.INGEST_URL || 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const INGEST_SECRET = process.env.CENTRIS_INGEST_SECRET || process.env.INGEST_SECRET || '';

    // --- DÉBUT DU BLOC DE DÉBOGAGE ---
    console.log("🔍 Longueur du secret reçu par le script :", INGEST_SECRET ? INGEST_SECRET.length : "VIDE ou UNDEFINED");
    if (INGEST_SECRET && INGEST_SECRET.length > 3) {
      console.log("🔍 Début du secret :", INGEST_SECRET.substring(0, 3) + "***");
    }
    // --- FIN DU BLOC DE DÉBOGAGE ---

    await ingest(uniqueListings, INGEST_URL, INGEST_SECRET);

  } catch (error) {
    console.error('Erreur lors du scraping:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
