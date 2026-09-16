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
  console.log('Lancement du scraper Centris "Deep Scraping" (Multi-pages + Fiches + Courtiers)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allUrls = new Set();
  const maxPages = parseInt(process.env.MAX_PAGES || "10", 10);

  try {
    // =========================================================
    // ÉTAPE 1 : Récolte et filtrage strict des URLs de terrains
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

      const links = await page.$$eval('a[href*="/fr/terrain~"]', els => 
        els
          .map(el => el.href)
          .filter(href => href && /\/\d+$/.test(href))
      );
      
      links.forEach(link => allUrls.add(link));
      console.log(`Total d'URLs de terrains uniques trouvées : ${allUrls.size}`);

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
    // ÉTAPE 2 : Visite individuelle pour les Détails, Coordonnées et Courtiers
    // =========================================================
    console.log(`\nÉtape 2 : Deep Scraping de ${allUrls.size} fiches détaillées...`);
    const finalResults = [];
    let count = 1;

    for (const url of allUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000); // Pause anti-bot

        const propertyData = await page.evaluate((currentUrl) => {
          const priceEl = document.querySelector('[itemprop="price"], #BuyPrice');
          const addressEl = document.querySelector('[itemprop="address"]');
          
          const price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
          const fullAddress = addressEl ? addressEl.textContent.trim().replace(/\s+/g, ' ') : '';

          // Extraction Coordonnées GPS (Lat / Lng)
          let lat = document.querySelector('meta[itemprop="latitude"]')?.content || null;
          let lng = document.querySelector('meta[itemprop="longitude"]')?.content || null;

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

          // --- EXTRACTION ROBUSTE DU COURTIER & AGENCE ---
          let broker_name = '';
          let broker_agency = '';
          let broker_phone = '';

          // 1. Recherche via les éléments du DOM
          const nameCandidate = document.querySelector('.broker-name, .uniquebrokername, h4.text-bold, [itemprop="seller"] [itemprop="name"], span.text-bold');
          if (nameCandidate) {
             broker_name = nameCandidate.textContent.trim();
          }

          const agencyCandidate = document.querySelector('.broker-agency, .agency-name, [itemprop="seller"] [itemprop="memberOf"], span.agency');
          if (agencyCandidate) {
             broker_agency = agencyCandidate.textContent.trim();
          }

          const phoneCandidate = document.querySelector('a[href^="tel:"], .broker-phone, [itemprop="telephone"]');
          if (phoneCandidate) {
             broker_phone = phoneCandidate.textContent.trim() || phoneCandidate.getAttribute('href')?.replace('tel:', '').trim();
          }

          // 2. Plan B : Analyse de secours dans les scripts globaux si vide
          if (!broker_name || !broker_agency) {
             const scripts = Array.from(document.querySelectorAll('script'));
             for (const script of scripts) {
                const text = script.innerText;
                if (text.includes('FullName') || text.includes('BrokerName') || text.includes('NomCourtier')) {
                   const nameMatch = text.match(/"(?:FullName|BrokerName|NomCourtier)"\s*:\s*"([^"]+)"/i);
                   const agencyMatch = text.match(/"(?:AgencyName|NomAgence|BannerName)"\s*:\s*"([^"]+)"/i);
                   const phoneMatch = text.match(/"(?:Phone|Telephone|OfficePhone)"\s*:\s*"([^"]+)"/i);
                   
                   if (!broker_name && nameMatch) broker_name = nameMatch[1];
                   if (!broker_agency && agencyMatch) broker_agency = agencyMatch[1];
                   if (!broker_phone && phoneMatch) broker_phone = phoneMatch[1];
                }
             }
          }

          // Extraction de la Municipalité depuis l'URL
          let municipality = '';
          const match = currentUrl.match(/~a-vendre~([^/]+)/);
          if (match && match[1]) {
             municipality = match[1]
               .split('-')
               .map(word => word.charAt(0).toUpperCase() + word.slice(1))
               .join(' ');
          }

          return { price, address: fullAddress, municipality, lat, lng, broker_name, broker_agency, broker_phone };
        }, url);

        console.log(`[${count}/${allUrls.size}] Extrait -> Ville: "${propertyData.municipality}" | Courtier: "${propertyData.broker_name}" | Agence: "${propertyData.broker_agency}"`);

        // Construction du payload avec toutes les variantes demandées pour éviter les erreurs d'API
        finalResults.push({
          url: url,
          price: propertyData.price,
          address: propertyData.address,
          municipalite: propertyData.municipality,
          "municipalité": propertyData.municipality,
          city: propertyData.municipality,
          municipality: propertyData.municipality,
          lat: propertyData.lat,
          lng: propertyData.lng,
          // Champs courtier demandés et leurs équivalents
          broker_name: propertyData.broker_name,
          broker: propertyData.broker_name,
          agent: propertyData.broker_name,
          courtier: propertyData.broker_name,
          
          broker_agency: propertyData.broker_agency,
          agency: propertyData.broker_agency,
          agence: propertyData.broker_agency,
          brokerage: propertyData.broker_agency,
          
          broker_phone: propertyData.broker_phone,
          phone: propertyData.broker_phone,
          telephone: propertyData.broker_phone,
          tel: propertyData.broker_phone
        });

      } catch (err) {
        console.error(`✖ Erreur de chargement pour ${url}:`, err.message);
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
