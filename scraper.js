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
  console.log('Lancement du scraper Centris "Deep Scraping" (Prix + GPS + Courtiers Complète)...');
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
    // ÉTAPE 2 : Visite individuelle (Extraction Prix, GPS, Courtiers)
    // =========================================================
    console.log(`\nÉtape 2 : Deep Scraping de ${allUrls.size} fiches détaillées...`);
    const finalResults = [];
    let count = 1;

    for (const url of allUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000); // Temps pour l'hydratation de la page

        // Defillement doux vers le bas pour declencher le chargement lazy-loading des cartes courtiers
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(1000);

        const propertyData = await page.evaluate((currentUrl) => {
          // --- 1. EXTRACTION DU PRIX ---
          let price = '';
          const priceSelectors = [
            'span[itemprop="price"]', 
            '#BuyPrice', 
            '.price-value', 
            '[data-price]', 
            'itemprop="price"',
            '.property-price span',
            'span.text-price'
          ];
          
          for (const sel of priceSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
              price = el.textContent.trim().replace(/\s+/g, ' ');
              break;
            }
          }

          if (!price) {
            const priceEl = Array.from(document.querySelectorAll('span, div')).find(el => 
              el.textContent.match(/\d{1,3}(?:[ \xA0]\d{3})*\s*\$/) && el.textContent.length < 30
            );
            if (priceEl) price = priceEl.textContent.trim().replace(/\s+/g, ' ');
          }

          const addressEl = document.querySelector('[itemprop="address"], .address-text');
          const fullAddress = addressEl ? addressEl.textContent.trim().replace(/\s+/g, ' ') : '';

          // --- 2. EXTRACTION GPS ---
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

          // --- 3. EXTRACTION ROBUSTE COURTIER, AGENCE, TÉLÉPHONE ---
          let broker_name = '';
          let broker_agency = '';
          let broker_phone = '';

          // Stratégie A : ciblage DOM dans le bloc d'informations du courtier
          const brokerContainer = document.querySelector('.broker-info, .brokerDetailsContainer, .agency-container, [itemtype*="RealEstateAgent"], .contact-broker, .teaser-item');
          const searchContext = brokerContainer || document;

          const nameEl = searchContext.querySelector('a[href*="/courtier-immobilier/"] span, .broker-name, [itemprop="name"], .name, h4.text-bold, .uniquebrokername');
          if (nameEl) broker_name = nameEl.textContent.trim().replace(/\s+/g, ' ');

          const agencyEl = searchContext.querySelector('.agency-name, .broker-agency, [itemprop="memberOf"], .agency, .banner-name, .broker-agency-name');
          if (agencyEl) broker_agency = agencyEl.textContent.trim().replace(/\s+/g, ' ');

          const phoneEl = searchContext.querySelector('a[href^="tel:"], [itemprop="telephone"], .broker-phone, .phone-number');
          if (phoneEl) {
             broker_phone = phoneEl.textContent.trim() || phoneEl.getAttribute('href')?.replace('tel:', '').trim();
          }

          // Stratégie B : Analyse des scripts de données JSON internes à la page
          if (!broker_name || !broker_agency) {
             const scripts = Array.from(document.querySelectorAll('script'));
             for (const script of scripts) {
                const text = script.innerText || '';
                if (text.includes('Broker') || text.includes('Courtier') || text.includes('Agency') || text.includes('Agence')) {
                   const nameMatch = text.match(/"(?:FullName|BrokerName|NomCourtier|Name)"\s*:\s*"([^"]+)"/i);
                   const agencyMatch = text.match(/"(?:AgencyName|NomAgence|BannerName|Agency)"\s*:\s*"([^"]+)"/i);
                   const phoneMatch = text.match(/"(?:Phone|Telephone|OfficePhone|CellPhone)"\s*:\s*"([^"]+)"/i);
                   
                   if (!broker_name && nameMatch && nameMatch[1].length > 2) broker_name = nameMatch[1];
                   if (!broker_agency && agencyMatch && agencyMatch[1].length > 2) broker_agency = agencyMatch[1];
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

        console.log(`[${count}/${allUrls.size}] Ville: "${propertyData.municipality}" | Prix: "${propertyData.price}" | Courtier: "${propertyData.broker_name}" | Agence: "${propertyData.broker_agency}" | Tél: "${propertyData.broker_phone}"`);

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
