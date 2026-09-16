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
  console.log('Lancement du scraper Centris "Deep Scraping" (Multi-pages + Fiches)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allUrls = new Set();
  const maxPages = parseInt(process.env.MAX_PAGES || "10", 10);

  try {
    // =========================================================
    // ÉTAPE 1 : Récolte rapide de toutes les URLs des terrains
    // =========================================================
    console.log('Étape 1 : Récolte des URLs sur les pages de recherche...');
    await page.goto('https://www.centris.ca/fr/terrain~a-vendre', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && pageNum <= maxPages) {
      console.log(`--- Scan de la page de résultats ${pageNum} / ${maxPages} ---`);
      
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // Trouve tous les liens menant vers une fiche de terrain
      const links = await page.$$eval('a[href*="/fr/terrain~"]', els => els.map(el => el.href));
      links.forEach(link => allUrls.add(link));

      console.log(`Total d'URLs uniques trouvées jusqu'à présent : ${allUrls.size}`);

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

    // =========================================================
    // ÉTAPE 2 : Visite individuelle pour les Coordonnées Géospatiales
    // =========================================================
    console.log(`\nÉtape 2 : Deep Scraping de ${allUrls.size} fiches détaillées...`);
    const finalResults = [];
    let count = 1;

    for (const url of allUrls) {
      console.log(`[${count}/${allUrls.size}] Extraction : ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000); // Pause vitale pour éviter les blocages

        const propertyData = await page.evaluate((currentUrl) => {
          // Extraction du Prix et Adresse
          const priceEl = document.querySelector('[itemprop="price"], #BuyPrice');
          const addressEl = document.querySelector('[itemprop="address"]');
          
          const price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
          const fullAddress = addressEl ? addressEl.textContent.trim().replace(/\s+/g, ' ') : '';

          // Extraction des coordonnées Lat/Lng de la carte
          let lat = document.querySelector('meta[itemprop="latitude"]')?.content || null;
          let lng = document.querySelector('meta[itemprop="longitude"]')?.content || null;

          // Si les balises meta sont absentes, on cherche dans les scripts de la page
          if (!lat || !lng) {
             const scripts = Array.from(document.querySelectorAll('script'));
             for (const script of scripts) {
                const text = script.innerText;
                if (text.includes('Latitude') && text.includes('Longitude')) {
                   const latMatch = text.match(/"Latitude"\s*:\s*([\d.-]+)/i);
                   const lngMatch = text.match(/"Longitude"\s*:\s*([\d.-]+)/i);
                   if (latMatch && lngMatch) {
                       lat = latMatch[1];
                       lng = lngMatch[1];
                       break;
                   }
                }
             }
          }

          // Extraction infaillible de la municipalité depuis l'URL
          let municipality = '';
          const match = currentUrl.match(/~a-vendre~([^/]+)/);
          if (match && match[1]) {
             municipality = match[1]
               .split('-')
               .map(word => word.charAt(0).toUpperCase() + word.slice(1))
               .join(' ');
          }

          return { price, address: fullAddress, municipality, lat, lng };
        }, url);

        // Intégration stricte de ton bloc de code avec le support des coordonnées
        finalResults.push({
          url: url,
          price: propertyData.price,
          address: propertyData.address,
          municipalite: propertyData.municipality, // Sans accent
          "municipalité": propertyData.municipality, // Avec accent
          lat: propertyData.lat,
          lng: propertyData.lng
        });

      } catch (err) {
        console.error(`✖ Erreur de chargement pour ${url}:`, err.message);
        // On continue la boucle même si une page plante
      }
      count++;
    }

    // =========================================================
    // ÉTAPE 3 : Ingestion vers Base44
    // =========================================================
    const INGEST_URL = process.env.INGEST_URL || 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
    const INGEST_SECRET = process.env.CENTRIS_INGEST_SECRET || process.env.INGEST_SECRET || '';

    await ingest(finalResults, INGEST_URL, INGEST_SECRET);

  } catch (error) {
    console.error('Erreur globale lors du scraping:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
