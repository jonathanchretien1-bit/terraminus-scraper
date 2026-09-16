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
      "x-ingest-secret": INGEST_SECRET,
      "Authorization": `Bearer ${INGEST_SECRET}`
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
  console.log('Lancement du scraper Centris robuste (Multi-pages)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Utilisation d'un Map pour éviter les doublons basés sur l'URL
  const allListings = new Map();
  const maxPages = parseInt(process.env.MAX_PAGES || "10", 10);

  try {
    console.log('Navigation sur Centris...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && pageNum <= maxPages) {
      console.log(`--- Scraping de la page ${pageNum} / ${maxPages} ---`);
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // --- DÉBUT DU SCRAPING ROBUSTE ---
      const pageListings = await page.evaluate(() => {
        // Cibler les conteneurs de cartes de propriétés
        const cards = Array.from(document.querySelectorAll('div.thumbnailItem, div.property-thumbnail-item, article'));
        const results = [];

        for (const card of cards) {
          const linkEl = card.querySelector('a[href*="/fr/terrain~"]');
          if (!linkEl) continue;

          const url = linkEl.href;
          const priceEl = card.querySelector('.price, [itemprop="price"]');
          const addressEl = card.querySelector('.address, .location, [itemprop="address"]');

          let price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
          let fullAddress = addressEl ? addressEl.textContent.trim().replace(/\s+/g, ' ') : '';

          // Extraction de la municipalité directement depuis l'URL (Failsafe 100% fiable)
          let municipality = '';
          const match = url.match(/~a-vendre~([^/]+)/);
          if (match && match[1]) {
             // Remplace les tirets par des espaces et met une majuscule au début
             municipality = match[1]
               .split('-')
               .map(word => word.charAt(0).toUpperCase() + word.slice(1))
               .join(' ');
          }

          results.push({
            url,
            price,
            address: fullAddress,
            municipality // On s'assure d'envoyer la municipalité pour passer ta validation
          });
        }
        return results;
      });
      // --- FIN DU SCRAPING ROBUSTE ---
      
      // Ajout au Map (écrase les doublons potentiels)
      pageListings.forEach(listing => {
        allListings.set(listing.url, listing);
      });
      
      console.log(`Total cumulé de terrains uniques extraits : ${allListings.size}`);

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

    const uniqueListings = Array.from(allListings.values());

    const INGEST_URL = process.env.INGEST_URL || 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const INGEST_SECRET = process.env.CENTRIS_INGEST_SECRET || process.env.INGEST_SECRET || '';

    await ingest(uniqueListings, INGEST_URL, INGEST_SECRET);

  } catch (error) {
    console.error('Erreur lors du scraping:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
