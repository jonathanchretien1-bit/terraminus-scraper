const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const INGEST_URL = process.env.INGEST_URL || 'https://earth-minus-scale.base44.app/functions/runCentrisScrape';
const INGEST_SECRET = process.env.CENTRIS_INGEST_SECRET || process.env.INGEST_SECRET || '';

// 1. Fonction qui demande à Base44 la liste des URLs incomplètes
async function getIncompleteUrls() {
  console.log("→ Récupération des annonces incomplètes depuis Base44...");
  try {
    const res = await fetch(`${INGEST_URL}?action=getIncomplete`, {
      method: "GET",
      headers: { 
        "x-ingest-secret": INGEST_SECRET,
        "Authorization": `Bearer ${INGEST_SECRET}`
      }
    });
    
    if (!res.ok) {
      console.error("Impossible de récupérer la liste des URLs depuis Base44.");
      return [];
    }
    
    const data = await res.json();
    // Attend un tableau d'URLs ou d'objets [{ url: "..." }]
    return data.urls || data.listings?.map(l => l.url) || [];
  } catch (err) {
    console.error("Erreur lors de l'appel à Base44 :", err.message);
    return [];
  }
}

// 2. Fonction d'ingestion pour renvoyer les données mises à jour
async function ingest(listings) {
  if (!listings.length) return;
  console.log(`→ Envoi de ${listings.length} annonces mises à jour vers Base44...`);
  
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
  console.log(`✓ Ingestion OK :`, JSON.stringify(data));
}

(async () => {
  // Récupération dynamique des URLs à corriger
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
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(1000);

      const propertyData = await page.evaluate((currentUrl) => {
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

        return { broker_name, broker_agency, broker_phone };
      }, url);

      console.log(`[OK] ${url} -> Courtier: "${propertyData.broker_name}" | Agence: "${propertyData.broker_agency}"`);

      finalResults.push({
        url: url,
        broker_name: propertyData.broker_name,
        courtier: propertyData.broker_name,
        broker_agency: propertyData.broker_agency,
        agence: propertyData.broker_agency,
        broker_phone: propertyData.broker_phone,
        telephone: propertyData.broker_phone
      });

    } catch (err) {
      console.error(`✖ Erreur pour ${url}:`, err.message);
    }
  }

  await ingest(finalResults);
  await browser.close();
})();
