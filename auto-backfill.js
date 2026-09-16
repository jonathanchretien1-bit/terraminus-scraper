const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const INGEST_URL = process.env.INGEST_URL || 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
const INGEST_SECRET = process.env.CENTRIS_INGEST_SECRET || process.env.INGEST_SECRET || '';

// 1. Récupération dynamique des URLs incomplètes depuis Base44
async function getIncompleteUrls() {
  console.log("→ Récupération des annonces incomplètes depuis Base44...");
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET,
        "Authorization": `Bearer ${INGEST_SECRET}`
      },
      body: JSON.stringify({ 
        action: "getIncomplete", 
        getIncomplete: true,
        secret: INGEST_SECRET 
      })
    });
    
    const data = await res.json().catch(() => ({}));
    console.log("Réponse de Base44 (urls incomplètes) :", JSON.stringify(data));
    
    const rawList = data.urls || data.listings || data.items || data.data || [];
    return rawList
      .map(item => (typeof item === 'string' ? item : item.listing_url || item.url))
      .filter(Boolean);

  } catch (err) {
    console.error("Erreur de connexion à Base44 :", err.message);
    return [];
  }
}

// 2. Ingestion des fiches complétées avec le mode UPSERT actif
async function ingest(listings) {
  if (!listings.length) return;
  console.log(`→ Envoi de ${listings.length} annonces mises à jour vers Base44 (upsert = true)...`);
  
  const payload = {
    secret: INGEST_SECRET,
    upsert: true, // Clé requise pour mettre à jour les fiches existantes
    listings: listings.map(item => ({
      listing_url: item.url,
      url: item.url,
      price: item.price,
      broker_name: item.broker_name,
      broker_agency: item.broker_agency,
      broker_phone: item.broker_phone,
      municipality: item.municipality,
      latitude: item.lat || null,
      longitude: item.lng || null
    }))
  };

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-ingest-secret": INGEST_SECRET,
      "Authorization": `Bearer ${INGEST_SECRET}`
    },
    body: JSON.stringify(payload),
  });
  
  const data = await res.json().catch(() => ({}));
  console.log(`✓ Ingestion OK :`, JSON.stringify(data));
}

(async () => {
  const urlsToFix = await getIncompleteUrls();

  if (!urlsToFix.length) {
    console.log("Aucune annonce incomplète trouvée. Tout est à jour !");
    return;
  }

  console.log(`Lancement du rattrapage automatique pour ${urlsToFix.length} annonces...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const finalResults = [];

  for (const url of urlsToFix) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(1000);

      const propertyData = await page.evaluate((currentUrl) => {
        // --- PRIX ---
        let price = '';
        const priceSelectors = [
          'span[itemprop="price"]', 
          '#BuyPrice', 
          '.price-value', 
          '[data-price]', 
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

        // --- COURTIER / AGENCE / TÉLÉPHONE ---
        let broker_name = '';
        let broker_agency = '';
        let broker_phone = '';

        const brokerContainer = document.querySelector('.broker-info, .brokerDetailsContainer, .agency-container, [itemtype*="RealEstateAgent"], .contact-broker') || document;

        const nameEl = brokerContainer.querySelector('a[href*="/courtier-immobilier/"] span, .broker-name, [itemprop="name"], .name, h4.text-bold');
        if (nameEl) broker_name = nameEl.textContent.trim().replace(/\s+/g, ' ');

        const agencyEl = brokerContainer.querySelector('.agency-name, .broker-agency, [itemprop="memberOf"], .agency, .banner-name');
        if (agencyEl) broker_agency = agencyEl.textContent.trim().replace(/\s+/g, ' ');

        const phoneEl = brokerContainer.querySelector('a[href^="tel:"], [itemprop="telephone"], .broker-phone');
        if (phoneEl) broker_phone = phoneEl.textContent.trim() || phoneEl.getAttribute('href')?.replace('tel:', '').trim();

        // Plan B : Extraction dans les scripts internes JSON/React
        if (!broker_name || !broker_agency) {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            const text = script.innerText || '';
            if (text.includes('Broker') || text.includes('Courtier')) {
              const nameMatch = text.match(/"(?:FullName|BrokerName|NomCourtier|Name)"\s*:\s*"([^"]+)"/i);
              const agencyMatch = text.match(/"(?:AgencyName|NomAgence|BannerName|Agency)"\s*:\s*"([^"]+)"/i);
              const phoneMatch = text.match(/"(?:Phone|Telephone|OfficePhone|CellPhone)"\s*:\s*"([^"]+)"/i);
              
              if (!broker_name && nameMatch && nameMatch[1].length > 2) broker_name = nameMatch[1];
              if (!broker_agency && agencyMatch && agencyMatch[1].length > 2) broker_agency = agencyMatch[1];
              if (!broker_phone && phoneMatch) broker_phone = phoneMatch[1];
            }
          }
        }

        // Municipalité depuis l'URL
        let municipality = '';
        const match = currentUrl.match(/~a-vendre~([^/]+)/);
        if (match && match[1]) {
          municipality = match[1]
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        }

        return { price, broker_name, broker_agency, broker_phone, municipality };
      }, url);

      console.log(`[OK] ${url} -> Prix: "${propertyData.price}" | Courtier: "${propertyData.broker_name}" | Agence: "${propertyData.broker_agency}"`);

      finalResults.push({
        url: url,
        price: propertyData.price,
        broker_name: propertyData.broker_name,
        broker_agency: propertyData.broker_agency,
        broker_phone: propertyData.broker_phone,
        municipality: propertyData.municipality
      });

    } catch (err) {
      console.error(`✖ Erreur pour ${url}:`, err.message);
    }
  }

  await ingest(finalResults);
  await browser.close();
})();
