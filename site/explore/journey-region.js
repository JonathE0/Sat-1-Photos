/**
 * A coarse name for the place under a point on Earth: an ocean, a large
 * sea, or a continent ("the North Pacific Ocean", "the Mediterranean Sea", "North America"),
 * meant for a sentence like "Right now it's over ___".
 *
 * Water or land comes from a one-degree mask made from the Blue Marble day
 * texture (site/globe/textures/earth-day-2048.jpg, NASA Earth Observatory):
 * blue-dominant cells, keeping only water joined to a sea (lakes count as
 * land). Names come from hand-written boundaries below. Near a coast the
 * answer can be either side (cells are about 110 km); far from one it is
 * right. regionAt returns null where no rule applies, and callers then fall
 * back to coordinates.
 */

// 180 rows (90 N first) x 360 columns (180 W first), one bit per cell, 1 = sea.
const MASK_B64 =
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////AwDw/38AAPz///////////////////////////////////////////////8DAAA8' +
  'AAAAAODD/////////////////////////////////////////////x8GAIADAAAAAAD4/////////////////+H/////////////' +
  '/////////////w8AAPgHAAAAAAD+////zsP//////////wP/////////////////////////D3cQAA4AAAAAAID/////Cf3/////' +
  '///////x///////////////////////v/+8fwD8AAAAAAAD/////x/v////////////v/////////////////////4f//88O4H8A' +
  'AAAAAID/////////////P/////+B+f///////////////////38AfNxg8P//AQAAAAD///////////9/+P//fwAAwP//H+D/////' +
  '//////////v3///P////BwAAAAD///////////+P////AwAA+P/////g/////////////wD/exjOzf//DwAAAID////////////n' +
  '//8/AAAAQP74/+H/////////////fyCAeJBDCP//HwAAAOD////////////x/2EcAAAAAADA/wD8/////v///////zgA8I0DAPz/' +
  '3wAAAMD////////////w/wAAAAAAAADAAADg//////8P8P////8B4A8HAID//wEAAMD//////2/8////fwAAAAAAAAAAAAAAwP//' +
  '//8BAIAPQHkAwAt+fAD/vwEAAPD/////fwH4////+QAAAAAAAAAAAAAAAG7g/j8AAAAAAAAA+ANw/AH//wEAAP//////DwAA/P8B' +
  'gAEAAAAAAAAAAAAAAAAA4P8AAAAAAAAAAAAQfA74fwAA+P//////BwAA4B4AAAAAAAAAAAAAAAAAAAAAIP4DAAAAAAAAAAAA/gfA' +
  'fwAA/v//////AwAA4AAAAAAAAAAAAAAAAAAAAAAADx8AAAAAAAAAAACg/wPm/wDg/x/A////ARwAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'v/8HAAAAAAAAAAAwPAD8/wD4/z/g//9/AB4AAAAAAAAAAAAAAAAAAAAAAACA//8HAAAAAAAAAAA8/w/4/wH4///8//8/AAcAAAAA' +
  'AAAAAAAAAAAAAAAAAACA/38AAAAAAAAAAAD//3/+/wP8//////8PwAEAAAAAAAAAAAAAAAAAAAAAAADg/z8AAAAAAAAAAMD/P/D/' +
  '/wf+//////8B4AMAAAAAAAAAAAAAAAAAAAAAzgD+/38AAAMAAAAAAMD/P8D//3/+//////8BwAMAAAAAAAAAAAAAAAAAAACAf7D/' +
  '//8D/P8BAAAAAOD/f8D3//////////8DgP8AAAAAAAAAAAAAAAAAAADGn/////8//P8fAAAAAID/PwDj//////////9j4A8AAAAA' +
  'AAAAAAAAAAAAAP7/z/////8///9/AAAAAAD//wDA////////f/z/4B8AAAAAAAAAAAAAAAAAgP//gf/////f////AAAAAADw/wCA' +
  '////////f/yf8QEAAAAAAAAAAAAAAAAAwP//gP//////////AQAAAADAfwCA////////f/zP/wEAAAAAAAAAAAAAAAAA8P//wP//' +
  '////////AwAAAAAAHAAA/P//////z/nf3wAAAAAAAAAAAAAAAAAA8P//wP//////////AwAAAAAAHAAA+P//////w/EHAAAAAAAA' +
  'AAAAAAAAAAAAYP7/8P//////////DwAAAAAAGAAA8P//////w8ABAAAAAAAAAAAAAAAAAAAAAPj/+P//////////HwAAAAAAAAAA' +
  '+P///////+AAAAAAAAAAAAAAAAAAAAAAAPr/////////////HwAAAAAAAAAA9////////z4AAAAAAAAAAAAAAAAAAAAAAPP/////' +
  '////////vwAAAAAAAAD+8////////w8AAAAAAAAAAAAAAAAAAAAAAPP//////////////wMAAAAAAAD4w////////wIAAAAAAAAA' +
  'AAAAAAAAAAAAAP///////////////wAAAAAAAAD43////////wEAAAAAAAAAAAAAAAAAAAAAgP///////////////wAAAAAAAAD4' +
  '/////////wMAAAAIA4AAAAAAAAAAAAAAwP///////////////wAAAAAAAADA/////////wcAAgCcA/AAAAAAAAAAAAAA4P//////' +
  '/////////wAAAAAAAAD3/////////wcABwD+A3gAAAAAAAAAAAAA8Pv//////////////wAAAAAAAMD/////////7wc4DgD/D3gA' +
  'AAAAAAAAAAAA+OP//////////////wAAAAAAAOD/////////B4B/fAD/P/ABAAAAAAAAAACA//v//////////////wAAAAAAAPD/' +
  '////////B8D/8QAPP+ABAAAAAAAAAADA/////////////////wAAAAAAAPz/////////B+Df5zABAMABAAAAAAAAAADg////////' +
  '/////////wAAAAAAAP7/////////B/Df73gAAOABAAAAAAAAAJjx//z//////////////wEAAAAAAP7/////////B/D//3EAAOAD' +
  'AAAAAAAAAPjx//7//////////////wMAAAAAAP//////////B/j/+XsAAOADAAAAAAAAAODjf/7//////////////wMAAAAAAP//' +
  '////////vx+A///JAAAAAAAAAAAAAODHH/7//////////////wcAAAAAAP//////////vweA////AAAAAAAAAAAAAPDnD///////' +
  '/////////w8AAAAAgP//////////PwCA////AAAAAAAAAAAAAPD75P///////////////z8AAAAA4P//////////DwCA//9/AAAA' +
  'AAAAAAAAAMC//////////////////38AAAAA8P//////////BwAA+Pl/AAAAAAAAAAAAAMA//////////////////38AAAAA+P//' +
  '////////AwAA8MA/AAAAAAAAAAAAAMD///////////////////8AAAAA/P//////////AwAAgAAAAAAAAAAAAAAAAID/////////' +
  '//////////8BAMD8+f//////////AwAAAAAAAHAAAAAAAAAAAMD///////////////////8DAPD/+f//////////AQAAAAAAAGAA' +
  'AAAAAAAAAMD///////////////////8DAPj/8/////////9/AAAAAADAAOAAAAAAAAAAAOD///////////////////9nAPj/8///' +
  '//////8/AAAAAADAAMAfAAAAAAAAAPD///////////////////9vAPj/9/////////8fAAAAAACAAQB/AAAAAAAAAPD/////////' +
  '///////////vAPz///////////8fAAAAAACAAQDnfwAAAAAAANj/////////////////////A/z///////////8PAAAAAAAABwCA' +
  '/wAAAAAAAM7/////////////////////A/z/4v////////8PAAAAAAAABwAA/wEAAAAAgP//////////////////////B/z/n///' +
  '//////8HAAAAAAAABgAA/wMAAAAA8P//////////////////////B/jjf/7///////8HAAAAAAAADgCA/wcA+AGA////////////' +
  '/////v//////B/Dz/8////////8PAAAAAAAAHgDA/x8A/gPA+f//////////////////////D+Dw/4////////8PAAAAAAAAHADg' +
  '/x8A/wPA/f//////////////////////fwDw//////////8PAAAAAAAAOADw/x+A/weA/9///////////////////////wHw////' +
  '//////8PAAAAAAAAeAD+/z/A/wcA/9///////////////////////38A//////////8HAAAAAAAAcAD//z/w/z8A/8//////////' +
  '//////////////8A/v////////8HAAAAAAAAYMD//3/w/z8A/t////////////////////////8H//////////8HAAAAAAAAQPj/' +
  '/3/w/z8A/v////////////////////////8f//////////8HAAAAAAAAgP///3/w/38D/v////////////////////////8//7f/' +
  '//////8PAAAAAAAAgL/////w/38H/v////////////////////////8//gH///////8fAAAAAAAAAID////w//8P////////////' +
  '/////////////////gCA//////8/AAAAAAAAAID////4//+f////////////////////////////EQAA//////9/AAAAAAAAAMD/' +
  '///t/3/////9////////////////////////NwAA/v//////AAAAAAAAAMD////P/3/+///8////////////////////////fwAA' +
  '/P//////AQAAAAAAAOD////P///8///+////////////////////////fwAAgP//////A/ABAAAAAOD////////4//j/////////' +
  '////////////////fwAAAP//////7/8DAAAAAPD//////8/5f/z/////////////////////////fwAAAP7///////8/AAAAAPj/' +
  '/////5/xP/z/////////////////////////PwAAAPz///////8/AAAAAPz//////z/wD/z/////////////////////////HwAA' +
  'APj///////8/AAAAAP7//////3/wA/z/////////////////////////DwAAAPD///////8/AAAAgP///////3/wAdz/////////' +
  '////////////////DwAAAPD///////8fAAAAgP/////////wAfz/////////////////////////BwAAAID///////8fAAAAwP//' +
  '///////xA85//P//////////////////////DwAAAAD+//////8/AAAA4P/////////BA8f/Hf//////////////////////DwAA' +
  'AADg//////9/AAAA8P/////////DP9f/Afj/////////////////////BwAAAADA////////AAAA8P/////////H/7//D+D/////' +
  '////////////////BwAAAAAA/v//////AAAA+P/////////P////P8D3////////////////////DwAAAAAA/v//////AQAA+P//' +
  '//////8/////fwD/////////////////////HwAAAAAA/v//////AQAA8P////////9/4P//P4D/////////////////////HwAA' +
  'AAAA/v//////AQAA8P//////////////vzD/////////////////////PwAAAAAA/v//////AQAA8P/////////////+/3/+////' +
  '////////////////PwAAAAAA////////AwAA8P//////////////////////////////////////fwAAAACA////////AwAA4P//' +
  '//////////////v/////////////////////fwAAAADA////////AwAA4P////////////9/8Pv//////////////////////wAA' +
  'AADg////////AQAA4N////////////8/8Pv//////////////////////wAAAADg////////AAAA4M////////////8T8PP/////' +
  '/////////////////wEAAADg////////AAAA4Mf///////////8B8OP//////////////////////wcAAADg////////AAAA8MH/' +
  '//////////8AwMH//////////////////////x8AAADg////////AAAA/MD//////////z8AAMH//////////////////////z8A' +
  'AADw////////AAAA/uD//////////z8AAMD//////////////////////z8AAADw////////AQCA/+D//////////x8AAID/////' +
  '/////////////////z8AAADw////////AQCA/+D//////////wMAAAD+/////////////////////z8AAAD4////////AwCA//D/' +
  '/////////wAAAAD+/////////////////////z8AAAD8////////AwAAf/D/////////PwAAAAD8/////////////////////z8A' +
  'AID/////////AwAA//D/////////PwAAAAD4/////////////////////z8AAOD/////////BwCA//j/////////PwAAAADw////' +
  '/////////////////x8AAPD/////////BwDg//3/////////PwAAAADg/////////////////////x8AAPj/////////BwDg////' +
  '////////PwAAAADg/////////////////////x8AAPj/////////BwDg////////////PwAAAADg/////////////////////x8A' +
  'APj/////////DwDw////////////PwAAAADA/////////////////////x8AAPz/////////HwD4////////////fwAAAADg////' +
  '/////////////////w8AAPz/////////HwD4////////////fwAAAADg/////////////////////x8AAP7/////////PwD8////' +
  '/////////wAAAADg/////////////////////x8AAP//////////PwD+/////////////wD8AwDw/////////////////////w8A' +
  'gP//////////P4D//////////////wD/BwD4/////////////////////w8AwP//////////f/7///////////////j/PwD4////' +
  '/////////////////w8A+P//////////////////////////////fwD8/////////////////////wcA+P//////////////////' +
  '/////////////wD8/////////////////////wcA+P///////////////////////////////wD+///3/////////////////wcA' +
  '/P///////////////////////////////7f////H/////////////////wfA///////////////////////////////////////j' +
  '/////////////////wPA///////////////////////////////////////n/////////////////wP4////////////////////' +
  '/////////////x/////8/////////////////w/4/////////////////////////////////z/////8/////////////////wf4' +
  '/////////////////////////////////////z/+/////////////////wf4/////////////////////////////////////4//' +
  '/////////////////wf+/////////////////////////////////////4f//////////////////wP+////////////////////' +
  '/////////////////8///////////////////wP8/////////////////////////////////////////////////////////wH+' +
  '/////////////////////////////////////////////////////////wH/////////////////////////////////////////' +
  '/////////////////4P//////////////////////////////////////////////////////////4P/////////////////////' +
  '/////////////////////////////////////4P//////////////////////////////////////////////////////////zf/' +
  '/////////////////////////////////////////////////////////x/8////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////////////9//v//////////////////////////////////////' +
  '///////////////////P/////////////////////////4/v////5/////////////////////////+D/////////////////3/w' +
  '////+weABz8ggP////////////////////////8B/////////////////x8A//8/AAAAAAAAAID8//////////////////////+B' +
  '////////////////fwAAAPwHAAAAAAAAAADA/////////////////////88A////////////9/8TDAAAAMABAAAAAAAAAAAA+P//' +
  '/////////////////wEA////////PwEAAAAAAAAAAAAAAAAAAAAAAAAAAPj//////////////////wMA//////9/AAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAMD/////////////H+D//wcA//////8PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMD/////////n///HwCABwAA' +
  '//////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOD////////7AAAABwAAAACA/////wcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7/' +
  '////fwAAAAAAAAAAAAAA/////wMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////DwAAAAAAAAAAAAAA4P/7fwAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAP////8/AAAAAAAAAAAAAAAAAPj/AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIL/APgDAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const ROWS = 180;
const COLS = 360;
let mask = null;

function decodeMask() {
  const bin = atob(MASK_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** True when the one-degree cell holding this point is sea. */
export function isSea(latDeg, lonDeg) {
  if (!mask) mask = decodeMask();
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor(90 - latDeg)));
  const col = ((Math.floor(lonDeg + 180) % COLS) + COLS) % COLS;
  const i = row * COLS + col;
  return (mask[i >> 3] & (1 << (i & 7))) !== 0;
}

/** Piecewise-linear y(x) through points [[x, y], ...] sorted by x; clamped. */
function piece(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

const between = (v, lo, hi) => v >= lo && v <= hi;

// Longitude halfway between the Pacific and Caribbean/Gulf coasts of Mexico
// and Central America, by latitude: water west of it is the Pacific.
const ISTHMUS = [[7, -81], [9.15, -83], [11, -84.6], [12.5, -85.5], [13.5, -87], [14.5, -89.5], [16, -92],
  [18.3, -95], [20, -100], [25, -103], [30, -106], [32.5, -110]];
// Between the Andaman Sea and the Gulf of Thailand down the Malay Peninsula.
const MALAY = [[1.4, 103.9], [4, 102], [6.5, 100.7], [8, 99.3], [10, 98.8], [13, 99.3], [16.5, 98]];
// South coast of Java and the Lesser Sunda Islands: south of it is the Indian Ocean.
const SUNDA = [[105.5, -6.6], [106.5, -7.2], [108, -7.8], [110, -8.2], [112, -8.4], [114.5, -8.8], [116, -9.0],
  [117, -9.1], [119, -10.2], [121, -10.3], [123, -10.8], [124, -10.4], [125, -9.5], [127, -8.6], [129.5, -8.3]];
// West coast of Borneo's north tip, Palawan, Mindoro and Luzon (latitude -> longitude).
const PHILIPPINES = [[3, 117], [7, 117], [8.3, 117.2], [10.5, 119], [12.5, 120.3], [14, 120.5], [18.5, 120.6], [22, 120.8]];
// West coast of Japan and Sakhalin: west of it is the Sea of Japan.
const JAPAN = [[33.5, 130.5], [34, 131], [35.5, 133], [36, 136], [37, 137], [38, 139.5], [41, 140], [43, 140.4],
  [45.5, 141.7], [52, 141.7]];
// Greater Caucasus ridge (longitude -> latitude): Europe north of it.
const CAUCASUS = [[39.5, 43.6], [42, 43.3], [44.5, 42.8], [46.5, 41.9], [48.5, 41.3]];
// Aleutian Islands and the Alaska Peninsula (longitude east, 0..360 -> latitude).
const ALEUTIANS = [[162.5, 55], [172, 52.8], [180, 51.5], [185, 51.8], [190, 52.5], [195, 54], [197, 55], [202, 56.5]];

function redSeaMid(lat) {
  return lat > 28 ? 33.5 : 34 + (28 - lat) * 0.587;
}

function seaName(lat, lon) {
  if (lat <= -60) return 'the Southern Ocean';

  // Seas inside or between the continents.
  if (between(lat, 36.5, 47.5) && between(lon, 46.5, 55.5)) return 'the Caspian Sea';
  if (between(lat, 41, 47.5) && between(lon, 28, 42)) return 'the Black Sea';
  if (between(lat, 30, 46) && between(lon, -5.6, 36.5) && (lat < 43 || lon > 3)) return 'the Mediterranean Sea';
  if (between(lat, 13, 30) && between(lon, 32, 44) && Math.abs(lon - redSeaMid(lat)) < 2) return 'the Red Sea';
  if (between(lat, 23.8, 30.5) && between(lon, 47.5, 56.6)) return 'the Persian Gulf';
  if ((between(lat, 53.5, 66) && between(lon, 13.5, 30.5)) || (between(lat, 54, 57.8) && between(lon, 10.5, 13.5))) {
    return 'the Baltic Sea';
  }
  if (between(lat, 51, 61)) {
    const west = lat < 55.8 ? -1 : lat < 58.7 ? -3.5 : -2;
    const east = lat >= 57.5 ? 11 : 9;
    if (lon > west && lon < east && !(lat > 60.5 && lon > 4.8)) return 'the North Sea';
  }
  if (between(lat, 51, 66) && between(lon, -95.5, -76.5)) return 'Hudson Bay';
  if (between(lat, 63, 66.5) && between(lon, 30, 45)) return 'the Arctic Ocean'; // White Sea

  // Gulf of Mexico and the Caribbean.
  if (between(lon, -98, -80.5)) {
    if ((between(lat, 22.8, 31) && lon < -81) || (between(lat, 21.3, 22.8) && lon < -86.8) ||
        (between(lat, 18, 21.3) && lon < -88)) {
      return 'the Gulf of Mexico';
    }
  }
  if (lat >= 7 && lat <= 32.5 && lon > -125 && lon < -60 && lon < piece(ISTHMUS, lat)) return 'the Pacific';
  if ((between(lat, 10.5, 18.3) && between(lon, -89, -61.2)) || (between(lat, 9.15, 10.5) && between(lon, -84, -62)) ||
      (between(lat, 18.3, 21.8) && between(lon, -88, -74))) {
    return 'the Caribbean Sea';
  }

  // East Asia.
  if (between(lat, 33.5, 52) && lon >= 127.5 && lon < piece(JAPAN, lat)) return 'the Sea of Japan';
  if (between(lat, 33, 41) && between(lon, 117, 127)) return 'the Yellow Sea';
  if (between(lat, 22, 33) && between(lon, 117, 131)) return 'the East China Sea';
  if (between(lat, 43.5, 60) && between(lon, 135, 163)) {
    const kuril = lon < 145.5 ? 43.5 : 43.5 + (lon - 145.5) * 0.67;
    const kamchatka = lat < 51 ? 157 : 156.5 + (lat - 51) * 0.6;
    if (lat > kuril && lon < kamchatka) return 'the Sea of Okhotsk';
  }
  const east = lon < 0 ? lon + 360 : lon;
  if (between(lat, 51, 66) && between(east, 162.5, 202) && lat > piece(ALEUTIANS, east)) return 'the Bering Sea';

  if (lat > 66) return 'the Arctic Ocean';

  // Australia and New Guinea.
  if (between(lat, -11.5, -5) && between(lon, 130, 141.5)) return 'the Arafura Sea';
  if (between(lat, -17.8, -11.5) && between(lon, 135.5, 142)) return 'the Gulf of Carpentaria';

  // Southeast Asia: the Indian Ocean side of Sumatra, Java and the Malay
  // Peninsula; the Philippine Sea to the east; the seas in between.
  if (between(lat, -11.5, 22) && between(lon, 92, 131)) {
    if (lat > 16.5 && lon < 99) return 'the Indian Ocean';
    if (between(lat, 1.4, 16.5) && lon < piece(MALAY, lat)) return 'the Indian Ocean';
    if (between(lat, -6, 5.5) && lon < 95.3 + (5.5 - lat) * 0.921) return 'the Indian Ocean';
    if (lat < -6 && lat < piece(SUNDA, lon)) return 'the Indian Ocean';
    if (lat < -6 && lon < 105.5) return 'the Indian Ocean';
    if (lon > 127 && lat > 6.5) return 'the Pacific';
    if (between(lat, 6.1, 13.8) && lon < 104.8 && (lat > 8.6 || lon < 102.3 + (lat - 6.1) * 0.96)) {
      return 'the Gulf of Thailand';
    }
    // west of the Philippines and Palawan, north of Borneo
    const borneo = lon < 109 ? 2.5 : 2.5 + (lon - 109) * 0.55;
    if (lat >= 3 && lat > borneo && lon >= 102 && lon < piece(PHILIPPINES, lat)) return 'the South China Sea';
    return 'Southeast Asia';
  }

  // The open oceans.
  if (lon < -20) {
    if (lat < 7) return lon < (lat < -56 ? -67.3 : -69) ? 'the Pacific' : 'the Atlantic';
    if (lat <= 32.5) return lon < piece(ISTHMUS, lat) ? 'the Pacific' : 'the Atlantic';
    return lon < -100 ? 'the Pacific' : 'the Atlantic';
  }
  if (lat < -34.8) return lon < 20 ? 'the Atlantic' : lon < 146.9 ? 'the Indian Ocean' : 'the Pacific';
  if (lon < 20) return 'the Atlantic';
  if (lon < 100) return lat < 30 ? 'the Indian Ocean' : null;
  if (lon < 146.9 && lat < -11.5) return lon < 129.5 || lat < -25 ? 'the Indian Ocean' : 'the Pacific';
  return 'the Pacific';
}

function landName(lat, lon) {
  if (lat <= -60) return 'Antarctica';
  if (between(lat, 63, 67) && between(lon, -25, -13)) return 'Iceland';
  const greenlandWest = lat < 75 ? -59 : lat < 79 ? -74.5 : lat < 81 ? -69 : -63;
  if (lat >= 59.5 && lon < -11 && lon > greenlandWest) return 'Greenland';
  if (between(lat, -11, -0.5) && between(lon, 130.8, 151) && (lat > -9.3 || lon > 147)) return 'New Guinea';
  if (between(lat, -45, -10) && between(lon, 112, 155)) return 'Australia';
  if (between(lat, -48, -34) && between(lon, 166, 179)) return 'New Zealand';
  if (between(lat, -26, -11.8) && between(lon, 43, 50.7)) return 'Madagascar';
  if (between(lat, 18.5, 22.5) && between(lon, -160.5, -154.5)) return 'Hawaii';
  if (between(lat, -11, 21.5) && between(lon, 92.5, 141)) return 'Southeast Asia';
  if (lon < -168.5 && lat > 64.4) return 'Asia'; // Chukotka, across the date line
  const americas =
    (lat > 50 && (between(lon, -170, -52) || lon > 172)) ||
    (between(lat, 7.5, 50) && between(lon, -125, -50)) ||
    (lat < 7.5 && between(lon, -92, -34));
  if (americas) return lat < 7.5 || (lat < 12.6 && lon > -77.5) ? 'South America' : 'North America';

  const africa =
    between(lon, -18.5, 52) &&
    (lat < 12.3 ||
      (lat < 28 && lon < 32.5 + (30 - lat) * 0.617) ||
      (lat < 31.7 && lon < 32.4) ||
      (lat < 33.6 && between(lon, 11.5, 32.4)) ||
      (lat < 37.5 && between(lon, -0.5, 11.5)) ||
      (lat < 35.95 && lon < -0.5));
  if (africa) return 'Africa';

  if (lat >= 34.8 && lon >= -32) {
    let europe = false;
    if (lon < 26.5) europe = true;
    else if (lon < 29.1) europe = lat > 40.7;
    else if (lon < 39.5) europe = lat > 43.2;
    else if (lon < 48.5) europe = lat > piece(CAUCASUS, lon);
    else if (lat < 46) europe = false;
    else if (lat < 51.5) europe = lon < 51.5;
    else if (lat < 64) europe = lon < 59.5;
    else if (lat < 68.5) europe = lon < 59.5 + (lat - 64) * 1.5;
    else europe = lon < (lat < 72 ? 66.5 : 69);
    if (europe) return 'Europe';
  }
  if (lon >= 26 && (lat >= 30 || lon < 141) && lat > -11) return 'Asia';
  if ((lon > 141 || lon < -100) && between(lat, -50, 30)) return 'Oceania';
  return null;
}

/**
 * "the Pacific", "the Mediterranean", "North America", ... for a point, or
 * null when no rule covers it.
 */
export function regionAt(latDeg, lonDeg) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  const name = isSea(latDeg, lon) ? seaName(latDeg, lon) : landName(latDeg, lon);
  if (name === 'the Pacific') return latDeg >= 0 ? 'the North Pacific Ocean' : 'the South Pacific Ocean';
  if (name === 'the Atlantic') return latDeg >= 0 ? 'the North Atlantic Ocean' : 'the South Atlantic Ocean';
  return name;
}

// ---- countries and place search (the Orbit page) ---------------------------------
//
// Countries come from Natural Earth's 1:110m Admin 0 outlines (public domain),
// in countries-110m.json next to this file (scripts/make_countries.mjs). They
// load on request, so the front page's regionAt costs nothing extra. Small
// islands and microstates are not in the 1:110m set.

/** Every name regionAt can give, sea first. */
export const REGION_NAMES = Object.freeze([
  'the North Pacific Ocean', 'the South Pacific Ocean', 'the North Atlantic Ocean', 'the South Atlantic Ocean',
  'the Indian Ocean', 'the Southern Ocean', 'the Arctic Ocean', 'the Mediterranean Sea', 'the Caribbean Sea',
  'the Gulf of Mexico', 'the North Sea', 'the Baltic Sea', 'the Black Sea', 'the Caspian Sea', 'the Red Sea',
  'the Persian Gulf', 'Hudson Bay', 'the Sea of Japan', 'the Yellow Sea', 'the East China Sea', 'the South China Sea',
  'the Sea of Okhotsk', 'the Bering Sea', 'the Arafura Sea', 'the Gulf of Carpentaria', 'the Gulf of Thailand',
  'Southeast Asia', 'Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Australia',
  'Antarctica', 'Greenland', 'Iceland', 'New Zealand', 'Madagascar', 'New Guinea', 'Hawaii',
]);

let countries = null;
let countriesLoading = null;

/** Use already-parsed country data (countries-110m.json's object). */
export function setCountries(data) {
  countries = Array.isArray(data?.countries) ? data.countries : null;
  places = null;
  return !!countries;
}

/** Load the country outlines once; resolves to true when they are in. */
export function loadCountries(url = new URL('countries-110m.json', import.meta.url).href) {
  if (countries) return Promise.resolve(true);
  if (!countriesLoading) {
    countriesLoading = fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status} for ${url}`))))
      .then(setCountries)
      .catch((err) => {
        countriesLoading = null;
        console.warn('Places: no country outlines', err);
        return false;
      });
  }
  return countriesLoading;
}

/** Even-odd test against every ring of a country, so holes stay holes. */
function insideRings(rings, lat, lon) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1];
      const yj = r[j + 1];
      if (yi > lat !== yj > lat && lon < ((r[j] - r[i]) * (lat - yi)) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

function countryContains(c, lat, lon) {
  const [w, s, e, n] = c.bbox;
  return lat >= s && lat <= n && lon >= w && lon <= e && insideRings(c.rings, lat, lon);
}

/** The country under a point, or null (sea, a place too small for the
 * 1:110m outlines, or the outlines not loaded yet). */
export function countryAt(latDeg, lonDeg) {
  if (!countries || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return countries.find((c) => countryContains(c, latDeg, lon))?.name ?? null;
}

// ---- places the 1:110m set leaves out ------------------------------------------------
//
// Small countries and territories: [name, lat, lon, km from the middle to the coast or
// border, other names]. Then a few provinces and states people will look for, Alberta
// first, as coarse outlines ([lon, lat, ...]) drawn by hand: right to within a few tens
// of kilometres, which is about the satellite's own precision over a place this size.
// Other names stay long or are codes (which count only typed in full): "Alta" would be
// a typo away from "Malta", and "Man" from "Oman".

const SMALL_PLACES = [
  ['Singapore', 1.35, 103.82, 25], ['Malta', 35.9, 14.4, 20], ['Bahrain', 26.05, 50.55, 25],
  ['Mauritius', -20.3, 57.55, 35], ['Maldives', 3.2, 73.22, 250], ['Seychelles', -4.68, 55.49, 30],
  ['Barbados', 13.19, -59.54, 20], ['Cape Verde', 15.1, -23.6, 150, ['Cabo Verde']], ['Comoros', -11.9, 43.87, 100],
  ['Samoa', -13.76, -172.1, 60], ['Tonga', -21.18, -175.2, 60], ['Monaco', 43.73, 7.42, 3], ['Andorra', 42.55, 1.6, 15],
  ['Liechtenstein', 47.16, 9.55, 12], ['San Marino', 43.94, 12.46, 6], ['Vatican City', 41.9, 12.45, 1, ['The Vatican']],
];
const SMALL_TERRITORIES = [
  ['Hong Kong', 22.32, 114.17, 30, ['HK']], ['Macau', 22.16, 113.55, 10, ['Macao']], ['Bermuda', 32.3, -64.78, 15],
  ['Guam', 13.44, 144.79, 30], ['Reunion', -21.11, 55.53, 35, ['La Reunion']],
];
/** A search needs something to find: the smallest of these count as this wide for passes. */
const SMALL_PLACE_MIN_KM = 40;

const OUTLINES = [
  ['Alberta', ['AB'], [-120, 60, -110, 60, -110, 49, -114.06, 49, -114.7, 50, -115.7, 51, -117, 52, -118.5, 53, -120, 54]],
  ['British Columbia', ['BC'], [-139, 60, -120, 60, -120, 54, -118.5, 53, -117, 52, -115.7, 51, -114.7, 50, -114.06, 49,
    -123.3, 49, -125.5, 48.3, -128.5, 50.5, -133.5, 53, -133.5, 54.6, -130, 54.7, -130, 56, -135, 59.4]],
  ['Saskatchewan', ['SK'], [-110, 60, -102, 60, -101.4, 49, -110, 49]],
  ['Manitoba', ['MB'], [-102, 60, -94.8, 60, -88.9, 56.85, -95.15, 52.85, -95.15, 49, -101.4, 49]],
  ['Ontario', ['ON'], [-95.15, 52.85, -88.9, 56.85, -82.2, 55.1, -79.5, 51.5, -79.5, 47.5, -74.4, 45.3, -76.2, 43.6,
    -79, 43.2, -79.3, 42.7, -83, 41.7, -83.2, 43, -82.4, 45.3, -84.7, 46.5, -89.5, 48, -95.15, 49]],
  ['Quebec', ['QC', 'PQ'], [-79.5, 51.5, -79, 55, -78.5, 58.7, -77.5, 62.5, -70, 61, -64.5, 60.3, -67.5, 54, -60, 52, -57.1, 51.4,
    -64.5, 49.9, -64.2, 48.8, -67, 47.9, -70, 46.7, -71.5, 45, -74.4, 45, -74.4, 45.3, -79.5, 47.5]],
  ['New Brunswick', ['NB'], [-69, 47.4, -67, 47.9, -64.2, 47.9, -64, 46, -66, 45, -67.5, 45.2]],
  ['Nova Scotia', ['NS'], [-66.4, 43.4, -64, 44, -60, 45.2, -59.7, 46.2, -60.5, 47.1, -61.5, 45.8, -64, 45.9, -66.3, 44.5]],
  ['Prince Edward Island', ['PEI', 'PE'], [-64.5, 46.7, -63.8, 47.1, -62, 46.5, -62.5, 45.9, -64, 46.2]],
  ['Newfoundland and Labrador', ['NL', 'Newfoundland', 'Labrador'], [-64.5, 60.3, -55.6, 53, -52.5, 47.5, -53.5, 46.6, -59.5, 47.6,
    -57.1, 51.4, -60, 52, -67.5, 54]],
  ['Yukon', ['YT', 'Yukon Territory'], [-141, 69.7, -134, 69.3, -124, 60, -141, 60]],
  ['Northwest Territories', ['NT', 'NWT'], [-124, 60, -134, 69.3, -125, 71, -120, 75, -110, 78, -110, 70, -120, 69.4, -110, 65.5, -102, 64.2, -102, 60]],
  ['Nunavut', ['NU'], [-102, 60, -102, 64.2, -110, 65.5, -120, 69.4, -110, 70, -110, 78, -100, 83, -61, 83, -60, 66, -65, 61, -78, 62.5, -82, 68, -90, 63, -94.8, 60]],
  ['Alaska', ['AK'], [-168.5, 65.5, -162, 71, -156, 71.5, -141, 69.7, -141, 60, -130, 55, -133, 54.7, -150, 59, -165, 54, -158, 58.5, -166, 60]],
  ['California', ['CA'], [-124.5, 42, -120, 42, -120, 39, -114.6, 35, -114.5, 32.7, -117.1, 32.5, -120.6, 34.5, -122.5, 37, -124.3, 40.3]],
  ['Texas', ['TX'], [-106.65, 32, -103, 32, -103, 36.5, -100, 36.5, -100, 34.6, -94.1, 33.6, -93.6, 29.8, -97.2, 27.5, -97.3, 25.9, -99.5, 27.5, -101.4, 29.8, -103.2, 29, -104.9, 30.6, -106.65, 31.7]],
  ['Florida', ['FL'], [-87.6, 31, -85, 31, -82, 30.7, -81.3, 30.7, -80, 26.8, -80.2, 25.2, -81.7, 25.1, -82.9, 28, -84, 30, -87.6, 30.3]],
  ['New York', ['NY', 'New York State'], [-79.8, 42.3, -79, 43.3, -76.3, 43.6, -75, 45, -73.3, 45, -73.5, 42, -71.9, 41, -74, 40.5, -75.3, 42]],
].map(([name, also, ring]) => ({ name, also, ring }));

const kmBetween = (lat1, lon1, lat2, lon2) => {
  const k = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * k) / 2) ** 2 + Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(((lon2 - lon1) * k) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
};

function smallPlaceAt(lat, lon) {
  for (const list of [SMALL_PLACES, SMALL_TERRITORIES]) {
    for (const [name, pLat, pLon, km] of list) {
      if (Math.abs(lat - pLat) < 3 && kmBetween(lat, lon, pLat, pLon) <= km) return name;
    }
  }
  return null;
}

/** Kilometres from a point to a country's outline; flat near the point, which is fine this close. */
function kmToOutline(c, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180) * 111.2;
  let best = Infinity;
  for (const r of c.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = (r[j] - lon) * k;
      const ay = (r[j + 1] - lat) * 111.2;
      const dx = (r[i] - r[j]) * k;
      const dy = (r[i + 1] - r[j + 1]) * 111.2;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** The closest country within `km` of a point, or null. */
function countryNear(lat, lon, km) {
  const dLat = km / 111.2;
  const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  let best = null;
  let bestKm = km;
  for (const c of countries) {
    const [w, s, e, n] = c.bbox;
    if (lat < s - dLat || lat > n + dLat || lon < w - dLon || lon > e + dLon) continue;
    const d = kmToOutline(c, lat, lon);
    if (d < bestKm) {
      best = c.name;
      bestKm = d;
    }
  }
  return best;
}

/**
 * The 1:110m outlines cut corners, so a point can fall just outside its country.
 * Where the coarse answer is land ("Asia") or vague ("Southeast Asia"), a country in
 * reach is better. Where it is a named sea, the reach is short, so real water off a
 * coast stays water.
 */
const NEAR_FROM_LAND_KM = 100;
const NEAR_FROM_SEA_KM = 25;

/** What's under a point: a small place or country if there is one, else regionAt's sea or
 * continent: "Canada", "the North Pacific Ocean". */
export function placeAt(latDeg, lonDeg) {
  const coarse = regionAt(latDeg, lonDeg);
  if (!countries || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return coarse;
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return smallPlaceAt(latDeg, lon)
    ?? countryAt(latDeg, lon)
    ?? countryNear(latDeg, lon, /Ocean|Sea|Gulf|Bay/.test(coarse) ? NEAR_FROM_SEA_KM : NEAR_FROM_LAND_KM)
    ?? coarse;
}

const NEEDS_THE = new Set(['Bahamas', 'Central African Republic', 'Czech Republic', 'Democratic Republic of the Congo',
  'Dominican Republic', 'Falkland Islands', 'French Southern and Antarctic Lands', 'Maldives', 'Netherlands', 'Philippines',
  'Republic of the Congo', 'Seychelles', 'Solomon Islands', 'United Arab Emirates', 'United Kingdom', 'United States',
  'Vatican City']);

/** A place's name as it reads after "over": "the United States", "the Gambia", "Canada". */
export function placeInSentence(name) {
  if (!name) return name;
  if (name.startsWith('The ')) return `the ${name.slice(4)}`;
  return NEEDS_THE.has(name) ? `the ${name}` : name;
}

/** Lower case, no accents, no "the", punctuation as spaces. */
export function normalise(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Edits (insert, delete, change, swap two neighbours) between two short strings. */
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

let places = null;

/** Countries (when loaded) and regionAt's seas and continents, one list. */
function placeList() {
  if (places) return places;
  const list = [];
  for (const c of countries || []) {
    list.push({ id: `country:${c.name}`, kind: 'country', name: c.name, label: c.name, keys: [c.name, ...c.also], country: c });
  }
  const have = new Set(list.map((p) => normalise(p.name)));
  for (const name of REGION_NAMES) {
    const label = name.replace(/^the /, '');
    if (have.has(normalise(label))) continue; // Australia, Iceland ... are countries too
    const kind = /Ocean|Sea|Gulf|Bay/.test(name) ? 'sea' : 'land';
    list.push({ id: `region:${name}`, kind, name, label: label.charAt(0).toUpperCase() + label.slice(1), keys: [label] });
  }
  const addSmall = (kind) => ([name, lat, lon, km, also = []]) => {
    list.push({ id: `place:${name}`, kind, name, label: name, keys: [name, ...also], circle: { lat, lon, km } });
  };
  SMALL_PLACES.forEach(addSmall('country'));
  SMALL_TERRITORIES.forEach(addSmall('land'));
  for (const o of OUTLINES) {
    list.push({ id: `place:${o.name}`, kind: 'land', name: o.name, label: o.name, keys: [o.name, ...o.also], outline: o.ring });
  }
  for (const p of list) {
    // two- and three-letter codes count only when typed exactly
    p.match = p.keys.map((k) => ({ text: normalise(k), code: /^[A-Z]{2,3}$/.test(k) }));
  }
  places = list;
  return list;
}

/** How well a typed query fits a place: 0 exact, 1 its start, 2 a word's
 * start, 3+ with typos; Infinity when it doesn't. */
function fit(q, p) {
  let best = Infinity;
  // two typos in a short word make it a different word ("alberta" is two from "algeria")
  const typos = q.length <= 3 ? 0 : q.length <= 8 ? 1 : 2;
  for (const { text, code } of p.match) {
    if (text === q) return 0;
    if (code) continue;
    if (text.startsWith(q)) best = Math.min(best, 1);
    const words = text.split(' ');
    // word by word: "s korea" for South Korea, "n mariana" ...
    const qWords = q.split(' ');
    if (qWords.length > 1 && qWords.length <= words.length && qWords.every((w, i) => words[i].startsWith(w))) {
      best = Math.min(best, 1);
    }
    if (words.some((w, i) => i > 0 && words.slice(i).join(' ').startsWith(q))) best = Math.min(best, 2);
    if (typos) {
      for (const start of [text, ...words.map((_, i) => words.slice(i).join(' ')).slice(1)]) {
        // the same length, or one more for a dropped letter ("jpan" for "japan")
        const e = Math.min(edits(q, start.slice(0, q.length)), edits(q, start.slice(0, q.length + 1)));
        if (e <= typos) best = Math.min(best, 3 + e);
      }
    }
  }
  return best;
}

/**
 * Places for a typed query, best first: [{ id, kind, name, label }].
 * Prefix matching that forgives a typo or two ("jpan", "Austrailia").
 */
export function findPlaces(query, limit = 6) {
  const q = normalise(query);
  if (!q) return [];
  return placeList()
    .map((p) => ({ p, score: fit(q, p) }))
    .filter((x) => x.score < Infinity)
    .sort((a, b) => a.score - b.score || (a.p.kind === 'country' ? 0 : 1) - (b.p.kind === 'country' ? 0 : 1) ||
      a.p.label.length - b.p.label.length || a.p.label.localeCompare(b.p.label))
    .slice(0, limit)
    .map(({ p }) => ({ id: p.id, kind: p.kind, name: p.name, label: p.label }));
}

const regionShapes = new Map();

/** Box and middle of one of regionAt's names, from its one-degree cells. */
function regionShape(name) {
  if (regionShapes.has(name)) return regionShapes.get(name);
  let [w, s, e, n] = [180, 90, -180, -90];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let lat = -89.5; lat < 90; lat += 1) {
    const c = Math.cos(lat * (Math.PI / 180));
    for (let lon = -179.5; lon < 180; lon += 1) {
      if (regionAt(lat, lon) !== name) continue;
      w = Math.min(w, lon - 0.5);
      e = Math.max(e, lon + 0.5);
      s = Math.min(s, lat - 0.5);
      n = Math.max(n, lat + 0.5);
      x += c * Math.cos(lon * (Math.PI / 180));
      y += c * Math.sin(lon * (Math.PI / 180));
      z += Math.sin(lat * (Math.PI / 180));
    }
  }
  const middle = [Math.atan2(y, x) * (180 / Math.PI), Math.atan2(z, Math.hypot(x, y)) * (180 / Math.PI)];
  const shape = { bbox: [w, s, e, n], middle };
  regionShapes.set(name, shape);
  return shape;
}

/**
 * A place to test points against: { id, kind, name, label, bbox: [w, s, e, n],
 * middle: [lon, lat], contains(lat, lon) }. `middle` is Natural Earth's label
 * point for a country, the centre of the cells for a sea or continent.
 */
export function getPlace(id) {
  const p = placeList().find((x) => x.id === id);
  if (!p) return null;
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  if (p.country) {
    const c = p.country;
    return { id, kind: p.kind, name: p.name, label: p.label, bbox: c.bbox, middle: c.middle,
      contains: (lat, lon) => countryContains(c, lat, wrap(lon)) };
  }
  if (p.circle) {
    const { lat, lon } = p.circle;
    const km = Math.max(p.circle.km, SMALL_PLACE_MIN_KM);
    const dLat = km / 111.2;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    return { id, kind: p.kind, name: p.name, label: p.label, bbox: [lon - dLon, lat - dLat, lon + dLon, lat + dLat], middle: [lon, lat],
      contains: (la, lo) => kmBetween(la, wrap(lo), lat, lon) <= km };
  }
  if (p.outline) {
    const r = p.outline;
    const lons = r.filter((_, i) => i % 2 === 0);
    const lats = r.filter((_, i) => i % 2 === 1);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    // the middle of its widest stretch at mid latitude, which always lies inside
    const midLat = (bbox[1] + bbox[3]) / 2;
    const crossings = [];
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if (r[i + 1] > midLat !== r[j + 1] > midLat) crossings.push(((r[j] - r[i]) * (midLat - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]);
    }
    crossings.sort((a, b) => a - b);
    let middle = [(bbox[0] + bbox[2]) / 2, midLat];
    for (let i = 0, widest = 0; i + 1 < crossings.length; i += 2) {
      if (crossings[i + 1] - crossings[i] > widest) {
        widest = crossings[i + 1] - crossings[i];
        middle = [(crossings[i] + crossings[i + 1]) / 2, midLat];
      }
    }
    return { id, kind: p.kind, name: p.name, label: p.label, bbox, middle,
      contains: (lat, lon) => insideRings([r], lat, wrap(lon)) };
  }
  const shape = regionShape(p.name);
  return { id, kind: p.kind, name: p.name, label: p.label, bbox: shape.bbox, middle: shape.middle,
    contains: (lat, lon) => regionAt(lat, lon) === p.name };
}
