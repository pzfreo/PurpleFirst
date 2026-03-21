const Tesseract = require('tesseract.js');
const { createCanvas, loadImage } = require('canvas');

// --- Grid detection helpers ---

function filterBands(bands, expected) {
  if (bands.length <= expected) return bands;
  const sorted = bands.map(b => ({ start: b[0], end: b[1], h: b[1] - b[0] }))
    .sort((a, b) => b.h - a.h).slice(0, expected);
  sorted.sort((a, b) => a.start - b.start);
  return sorted.map(b => [b.start, b.end]);
}

function detectGrid(gray, w, h, isDark) {
  // Horizontal projection: fraction of tile-colored pixels per row
  const hProj = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      const g = gray[y * w + x];
      if (isDark ? (g > 150 && g < 230) : (g > 200 && g < 250)) count++;
    }
    hProj[y] = count / w;
  }

  let rawBands = [], inBand = false, bandStart = 0;
  for (let y = 0; y < h; y++) {
    if (hProj[y] > 0.3 && !inBand) { inBand = true; bandStart = y; }
    if (hProj[y] < 0.1 && inBand) {
      if (y - bandStart > 30) rawBands.push([bandStart, y]);
      inBand = false;
    }
  }
  if (inBand && h - bandStart > 30) rawBands.push([bandStart, h]);
  const rows = filterBands(rawBands, 4);
  if (rows.length !== 4) return null;

  // Vertical projection within grid bounds
  const gridTop = rows[0][0], gridBot = rows[3][1];
  const vProj = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = gridTop; y < gridBot; y++) {
      const g = gray[y * w + x];
      if (isDark ? (g > 150 && g < 230) : (g > 200 && g < 250)) count++;
    }
    vProj[x] = count / (gridBot - gridTop);
  }

  let rawVBands = [];
  inBand = false;
  for (let x = 0; x < w; x++) {
    if (vProj[x] > 0.3 && !inBand) { inBand = true; bandStart = x; }
    if (vProj[x] < 0.1 && inBand) {
      if (x - bandStart > 30) rawVBands.push([bandStart, x]);
      inBand = false;
    }
  }
  if (inBand && w - bandStart > 30) rawVBands.push([bandStart, w]);
  const cols = filterBands(rawVBands, 4);
  if (cols.length !== 4) return null;

  return { rows, cols };
}

// --- Grid-based extraction (primary): OCR each tile individually ---

async function extractTilesFromGrid(filePath) {
  const img = await loadImage(filePath);
  const w = img.width, h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  let totalBrightness = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      gray[y * w + x] = g;
      totalBrightness += g;
    }
  const isDark = (totalBrightness / (w * h)) < 160;

  const grid = detectGrid(gray, w, h, isDark);
  if (!grid) return null;

  const { rows, cols } = grid;
  const margin = 8;
  const tiles = [];
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({ tessedit_pageseg_mode: '6' });

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x1 = cols[c][0] + margin, y1 = rows[r][0] + margin;
      const tw = cols[c][1] - cols[c][0] - margin * 2;
      const th = rows[r][1] - rows[r][0] - margin * 2;
      const tileCanvas = createCanvas(tw, th);
      const tileCtx = tileCanvas.getContext('2d');
      tileCtx.drawImage(img, x1, y1, tw, th, 0, 0, tw, th);
      const result = await worker.recognize(tileCanvas.toBuffer('image/png'));
      const text = result.data.text.trim().split(/\n/).map(l => l.trim()).join(' ')
        .toUpperCase().replace(/[^A-Z -]/g, '').trim();
      tiles.push(text);
    }
  }
  await worker.terminate();

  const nonEmpty = tiles.filter(t => t.length > 0);
  if (nonEmpty.length !== 16) {
    return { tiles: nonEmpty, confidence: 'low', reason: `${16 - nonEmpty.length} tiles could not be read` };
  }
  const oddLength = tiles.filter(t => t.length < 3 || t.length > 15);
  if (oddLength.length > 0) {
    return { tiles, confidence: 'low', reason: `Unusual words: ${oddLength.join(', ')}` };
  }
  return { tiles, confidence: 'high' };
}

// --- Text-based extraction (fallback) ---

function extractTilesFromText(text) {
  const upper = text.toUpperCase();
  const startMarker = upper.indexOf('FOUR!');
  const endMarker = upper.indexOf('MISTAKES');

  const hasMarkers = startMarker >= 0 && endMarker > startMarker;
  const gridText = hasMarkers
    ? text.substring(startMarker + 5, endMarker)
    : text;

  const words = gridText.split(/\s+/)
    .map(w => w.toUpperCase().replace(/[^A-Z-]/g, '').replace(/^-+|-+$/g, ''))
    .filter(w => w.length >= 3)
    .filter(w => {
      const unique = new Set(w.replace(/-/g, ''));
      return unique.size >= 2 || w.length <= 3;
    });

  const seen = new Set();
  const tiles = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  if (!hasMarkers) {
    return { tiles, confidence: 'low', reason: 'Could not find grid markers in image' };
  }
  if (tiles.length !== 16) {
    return { tiles, confidence: 'low', reason: `Found ${tiles.length} words instead of 16` };
  }
  const oddLength = tiles.filter(t => t.length < 3 || t.length > 10);
  if (oddLength.length > 0) {
    return { tiles, confidence: 'low', reason: `Unusual words: ${oddLength.join(', ')}` };
  }
  return { tiles, confidence: 'high' };
}

// --- Tests ---

const tests = [
  {
    name: 'Sample 1 - single word tiles (light mode)',
    file: 'test-images/sample1.jpg',
    expectedTiles: ['POUND', 'PLAIN', 'OBJECT', 'CROWN', 'JUMP', 'MARK', 'FRANK', 'RICH', 'GOAL', 'STRAIGHT', 'POINT', 'BISHOP', 'KING', 'BLUNT', 'FROST', 'CAPTURE'],
    expectedConfidence: 'high',
  },
  {
    name: 'Sample 2 - multi-word tiles (HOT WATER, TEA BAG, YO-YO)',
    file: 'test-images/sample2.jpg',
    expectedTiles: ['KITE', 'WIND', 'HOT WATER', 'KEY', 'TEA BAG', 'LIGHTNING', 'BALLOON', 'JAM', 'PITCH', 'ARROW', 'BIND', 'SCALE', 'YO-YO', 'TONE', 'ROCKET', 'PICKLE'],
    expectedConfidence: 'high',
  },
  {
    name: 'Sample 3 - iPhone dark mode (same words as sample 1)',
    file: 'test-images/sample3.jpg',
    expectedTiles: ['POUND', 'PLAIN', 'OBJECT', 'CROWN', 'JUMP', 'MARK', 'FRANK', 'RICH', 'GOAL', 'STRAIGHT', 'POINT', 'BISHOP', 'KING', 'BLUNT', 'FROST', 'CAPTURE'],
    expectedConfidence: 'high',
  },
  {
    name: 'Sample 4 - iPhone dark mode (user-reported)',
    file: 'test-images/sample4.jpg',
    expectedTiles: ['POUND', 'PLAIN', 'OBJECT', 'CROWN', 'JUMP', 'MARK', 'FRANK', 'RICH', 'GOAL', 'STRAIGHT', 'POINT', 'BISHOP', 'KING', 'BLUNT', 'FROST', 'CAPTURE'],
    expectedConfidence: 'high',
  },
  {
    name: 'Sample 5 - Android light mode (with overlay thumbnail)',
    file: 'test-images/sample5.jpg',
    expectedTiles: ['PLASTER', 'SLING', 'HIDE', 'BLANKET', 'PELT', 'SINK', 'RED', 'COAT', 'SKIN', 'COVER', 'CAST', 'INKS', 'SIMON', 'HURL', 'KINS', 'CAPTURE'],
    expectedConfidence: 'high',
  },
];

async function run() {
  let allPassed = true;

  for (const test of tests) {
    console.log(`\n=== ${test.name} ===`);

    // Try grid-based extraction first
    let result = await extractTilesFromGrid(test.file);
    let method = 'grid';

    if (!result || result.confidence === 'low') {
      // Fallback to text-based extraction
      const { data } = await Tesseract.recognize(test.file, 'eng');
      const textResult = extractTilesFromText(data.text);
      // Use text result if it's better
      if (!result || (textResult.confidence === 'high' && result.confidence === 'low')) {
        result = textResult;
        method = 'text-fallback';
      }
    }

    console.log(`[${method}] Extracted ${result.tiles.length} tiles: ${result.tiles.join(', ')}`);
    console.log(`Confidence: ${result.confidence}${result.reason ? ` (${result.reason})` : ''}`);

    const missing = test.expectedTiles.filter(w => !result.tiles.includes(w));
    const junk = result.tiles.filter(w => !test.expectedTiles.includes(w));
    const confOk = result.confidence === test.expectedConfidence;

    if (missing.length === 0 && junk.length === 0 && confOk) {
      console.log('✅ PASS');
    } else {
      allPassed = false;
      if (missing.length > 0) console.log('❌ MISSING:', missing.join(', '));
      if (junk.length > 0) console.log('❌ JUNK:', junk.join(', '));
      if (!confOk) console.log(`❌ CONFIDENCE: got ${result.confidence}, expected ${test.expectedConfidence}`);
    }
  }

  console.log(allPassed ? '\n✅ ALL TESTS PASSED' : '\n❌ SOME TESTS FAILED');
  process.exit(allPassed ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
