/**
 * United States National Grid (USNG) coordinates, the FEMA and National
 * Search and Rescue standard for ground operations. USNG is MGRS on WGS84
 * written with spaces, e.g. "15R TN 70857 94589" (1 m precision).
 *
 * Conversion: WGS84 geographic -> UTM (Snyder transverse Mercator series) ->
 * 100 km grid-square letters. Coordinates truncate, as the standard requires.
 */

const BAND_LETTERS = 'CDEFGHJKLMNPQRSTUVWXX';
const COLUMN_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return Math.min(60, Math.max(1, zone));
}

export function toUtm(lat: number, lon: number) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const zone = utmZone(lat, lon);
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep2 * cos * cos;
  const A = cos * (lambda - lambda0);
  const M = a * (
    (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi)
  );
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing = k0 * (M + N * tan * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  return { zone, easting, northing };
}

/** USNG string for a WGS84 coordinate; empty outside the UTM latitudes (UPS polar caps). */
export function toUsng(lat: number, lon: number, digits: 1 | 2 | 3 | 4 | 5 = 5): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -80 || lat > 84) return '';
  const { zone, easting, northing } = toUtm(lat, lon);
  const band = BAND_LETTERS[Math.floor((lat + 80) / 8)];
  const column = COLUMN_SETS[(zone - 1) % 3][Math.floor(easting / 100000) - 1];
  const rowIndex = (Math.floor(northing / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20;
  const row = ROW_LETTERS[rowIndex];
  const scale = 10 ** (5 - digits);
  const pad = (value: number) => String(Math.floor((value % 100000) / scale)).padStart(digits, '0');
  return `${zone}${band} ${column}${row} ${pad(easting)} ${pad(northing)}`;
}

export function formatLatLon(lat: number, lon: number, decimals = 5): string {
  return `${Math.abs(lat).toFixed(decimals)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(decimals)}° ${lon >= 0 ? 'E' : 'W'}`;
}
