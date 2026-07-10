/* ============================================================
   zones.js — port → zone mapping (shared)
   Groups dely ports into desk zones so the matcher and NATL
   board can filter geographically even when the sheet's region
   column is blank, stale, or holding a status (GONE/ONSUB...).

   Zone of a vessel = zone of its dely port, falling back to the
   sheet's own region tag. Port lists seeded from Tyler's tool
   (ECSA / N CONT / W MED / E MED / NCSA) plus the desk's usual
   suspects for the rest. Not exhaustive — unknown ports simply
   fall back to the sheet region, and additions are one line here.
   ============================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.Zones = api;
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  const PORT_ZONES = {
    'ECSA': [
      'santos', 'itaguai', 'puerto madryn', 'praia mole', 'porto sudeste', 'aps ecsa',
      'rio grande', 'paranagua', 'sao francisco do sul', 'sao francisco', 'imbituba',
      'tubarao', 'vitoria', 'rio de janeiro', 'acu', 'ponta do ubu',
      'recalada', 'san lorenzo', 'rosario', 'up river', 'upriver',
      'bahia blanca', 'necochea', 'quequen', 'buenos aires', 'montevideo', 'la plata',
    ],
    'N CONT': [
      'skaw', 'lulea', 'eemshaven', 'liverpool', 'wilhelmshaven', 'rotterdam',
      'dunkirk', 'stade', 'amsterdam', 'aughinish', 'aughinish is', 'ghent', 'brake',
      'hansaport', 'hamburg', 'reydarfjordur', 'bremen', 'immingham', 'belfast',
      'lorient', 'la coruna', 'lisbon', 'gijon',
      'antwerp', 'flushing', 'vlissingen', 'ijmuiden', 'terneuzen', 'moerdijk',
      'bremerhaven', 'cuxhaven', 'brunsbuttel', 'emden', 'esbjerg', 'aarhus',
      'rouen', 'le havre', 'la pallice', 'bordeaux', 'montoir', 'nantes', 'brest',
      'hull', 'teesport', 'tyne', 'newcastle (uk)', 'glasgow', 'hunterston',
      'dublin', 'cork', 'foynes', 'birkenhead', 'port talbot', 'bristol',
      'leixoes', 'setubal', 'sines', 'aviles', 'bilbao', 'santander', 'ferrol', 'pasajes',
      'grundartangi', 'straumsvik',
    ],
    'BALTIC': [
      'ust luga', 'st petersburg', 'vysotsk', 'vyborg', 'kaliningrad',
      'gdansk', 'gdynia', 'poland', 'swinoujscie', 'szczecin', 'police',
      'klaipeda', 'riga', 'ventspils', 'liepaja', 'tallinn', 'muuga', 'sillamae',
      'helsinki', 'kotka', 'hamina', 'rauma', 'pori', 'oxelosund', 'gavle',
      'stockholm', 'norrkoping', 'gdansk (pl)', 'rostock', 'stralsund', 'lubeck', 'kiel',
      'copenhagen', 'kalundborg', 'stigsnaes', 'fredericia',
    ],
    'W MED': [
      'safi', 'jorf lasfar', 'gibraltar', 'passero', 'ceuta',
      'casablanca', 'agadir', 'tangier', 'nador', 'oran', 'algiers', 'bejaia',
      'annaba', 'skikda', 'mostaganem', 'tunis', 'rades', 'sfax', 'gabes', 'bizerte',
      'algeciras', 'huelva', 'cadiz', 'seville', 'malaga', 'motril', 'almeria',
      'cartagena (es)', 'alicante', 'valencia', 'castellon', 'sagunto', 'tarragona',
      'barcelona', 'palma', 'fos', 'marseille', 'sete', 'port la nouvelle', 'toulon',
      'genoa', 'savona', 'vado', 'la spezia', 'livorno', 'piombino', 'civitavecchia',
      'naples', 'salerno', 'gioia tauro', 'milazzo', 'palermo', 'catania', 'augusta',
      'cagliari', 'porto torres', 'oristano', 'olbia',
    ],
    'E MED': [
      'port said', 'piraeus', 'alexandria', 'iskenderun', 'tuzla', 'suez canal',
      'isdemir', 'toros gubre', 'el dekheila', 'damietta', 'otranto',
      'canakkale', 'gemlik', 'bandirma', 'izmir', 'aliaga', 'nemrut bay', 'mersin',
      'antalya', 'samsun', 'derince', 'yalova', 'ambarli', 'marmara', 'gebze', 'diliskelesi',
      'limassol', 'vasiliko', 'beirut', 'tripoli (lb)', 'lattakia', 'tartous',
      'haifa', 'ashdod', 'eilat',
      'thessaloniki', 'volos', 'eleusis', 'agioi theodoroi', 'kavala', 'stylis',
      'bari', 'brindisi', 'taranto', 'ancona', 'ravenna', 'venice', 'monfalcone',
      'trieste', 'koper', 'rijeka', 'ploce', 'split', 'bar', 'durres', 'vlore',
      'valletta', 'marsaxlokk', 'benghazi', 'misurata', 'tripoli (ly)', 'mylaki', 'aspropyrgos',
    ],
    'NCSA': [
      'balboa', 'pecem', 'point lisas',
      'puerto drummond', 'santa marta', 'barranquilla', 'cartagena (col)', 'puerto bolivar',
      'rio orinoco', 'puerto ordaz', 'palua', 'matanzas', 'guanta', 'jose', 'la guaira',
      'puerto cabello', 'maracaibo', 'amuay',
      'port of spain', 'point a pierre', 'georgetown', 'paramaribo', 'new amsterdam',
      'itaqui', 'sao luis', 'ponta da madeira', 'belem', 'vila do conde', 'barcarena',
      'santarem', 'macapa', 'fortaleza', 'aratu', 'salvador', 'suape', 'recife',
      'cristobal', 'colon', 'panama',
    ],
    'USG': [
      'nola', 'new orleans', 'sw pass', 'southwest pass', 'mississippi river', 'miss river',
      'burnside', 'convent', 'destrehan', 'myrtle grove', 'davant', 'reserve', 'ama',
      'baton rouge', 'darrow', 'gramercy',
      'houston', 'galveston', 'texas city', 'freeport (tx)', 'corpus christi', 'brownsville',
      'beaumont', 'port arthur', 'lake charles', 'mobile', 'pascagoula', 'gulfport',
      'tampa', 'port manatee', 'panama city (us)', 'veracruz', 'altamira', 'tampico', 'tuxpan',
    ],
    'USEC': [
      'norfolk', 'newport news', 'hampton roads', 'baltimore', 'sparrows point',
      'philadelphia', 'fairless hills', 'camden', 'paulsboro', 'wilmington (nc)',
      'morehead city', 'savannah', 'brunswick', 'charleston', 'georgetown (sc)',
      'jacksonville', 'port everglades', 'new york', 'albany', 'new haven', 'providence',
      'boston', 'portland (me)', 'searsport',
    ],
    'EC CAN': [
      'sept iles', 'seven islands', 'port cartier', 'quebec', 'montreal', 'sorel',
      'trois rivieres', 'baie comeau', 'les escoumins', 'contrecoeur', 'becancour',
      'halifax', 'saint john', 'belledune', 'sydney (ca)', 'come by chance', 'long harbour',
    ],
    'BSEA': [
      'constanta', 'varna', 'burgas', 'odessa', 'yuzhny', 'pivdennyi', 'chornomorsk',
      'mykolaiv', 'kherson', 'izmail', 'reni', 'galati', 'braila',
      'novorossiysk', 'taman', 'tuapse', 'rostov', 'azov', 'taganrog', 'kavkaz',
      'poti', 'batumi', 'supsa', 'zonguldak', 'eregli', 'trabzon',
    ],
    'WAFR': [
      'kamsar', 'conakry', 'boke', 'dakar', 'nouakchott', 'nouadhibou', 'banjul',
      'freetown', 'monrovia', 'buchanan', 'abidjan', 'san pedro (ci)', 'takoradi',
      'tema', 'lome', 'cotonou', 'lagos', 'apapa', 'port harcourt', 'onne', 'warri',
      'douala', 'libreville', 'pointe noire', 'luanda', 'lobito', 'walvis bay',
    ],
    'RSEA': [
      'jeddah', 'yanbu', 'king abdullah', 'rabigh', 'jizan', 'aqaba', 'adabiya',
      'sokhna', 'ain sukhna', 'safaga', 'port sudan', 'massawa', 'djibouti',
      'aden', 'hodeidah', 'salalah', 'suez',
    ],
  };

  // Build normalized lookup
  function norm(p) {
    return String(p || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
      .replace(/\(.*?\)/g, ' ')                            // drop "(UK)" etc for input ports
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const LOOKUP = {};
  for (const [zone, ports] of Object.entries(PORT_ZONES)) {
    for (const p of ports) {
      // Keys keep their parenthetical disambiguators; inputs lose theirs.
      const key = String(p).toLowerCase().replace(/[^a-z0-9()]+/g, ' ').trim();
      LOOKUP[key] = zone;
      const bare = norm(p);
      // Bare form only wins if not already claimed (keeps "cartagena (es)"
      // vs "cartagena (col)" from colliding silently — bare "cartagena"
      // resolves to whichever was listed first, W MED).
      if (!(bare in LOOKUP)) LOOKUP[bare] = zone;
    }
  }

  /** Zone for a port name, or null if unknown. */
  function zoneOfPort(port) {
    if (!port) return null;
    const n = norm(port);
    if (!n) return null;
    if (LOOKUP[n]) return LOOKUP[n];
    // "liverpool uk" → "liverpool"
    const first = n.replace(/\b(uk|fr|es|de|nl|be|pt|ie|us|ca|br|ar|uy|co|ve|tt|eg|tr|gr|it|ma|is)\b/g, '').trim();
    return LOOKUP[first] || null;
  }

  // Sheet region tags → canonical zone names, so fallbacks don't split
  // pills ("EMED" vs "E MED")
  const REGION_ALIASES = {
    'WMED': 'W MED', 'EMED': 'E MED', 'ARAG/CONTI': 'N CONT', 'ARAG/CONT': 'N CONT',
    'ECCAN': 'EC CAN', 'BALTIC/BSEA': 'BALTIC', 'APS ECSA': 'ECSA', 'APS USG': 'USG',
  };

  /** Zone for a vessel: dely port first, sheet region tag as fallback. */
  function zoneOfVessel(v, regionField) {
    const byPort = zoneOfPort(v && v.dely_port);
    if (byPort) return byPort;
    const raw = (regionField || (v && v.region) || '').toUpperCase().trim();
    if (!raw) return null;
    return REGION_ALIASES[raw] || raw;
  }

  return { zoneOfPort, zoneOfVessel, PORT_ZONES, ZONE_LIST: Object.keys(PORT_ZONES) };
});
