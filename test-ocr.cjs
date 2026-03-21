const Tesseract = require('tesseract.js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');

/** Preprocess image for OCR: adaptive threshold + border removal for dark mode (mirrors preprocessImage in App.tsx) */
async function preprocessImage(filePath) {
  const img = await loadImage(filePath);
  const w = img.width, h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;

  // Compute grayscale and average brightness
  const gray = new Float32Array(w * h);
  let totalBrightness = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[y * w + x] = g;
      totalBrightness += g;
    }
  const avgBrightness = totalBrightness / (w * h);

  // Only apply heavy preprocessing for dark images (e.g. iPhone dark mode)
  if (avgBrightness < 160) {
    // Build integral image for fast local average
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++)
      for (let x = 1; x <= w; x++)
        integral[y * (w + 1) + x] = gray[(y - 1) * w + (x - 1)]
          + integral[(y - 1) * (w + 1) + x]
          + integral[y * (w + 1) + (x - 1)]
          - integral[(y - 1) * (w + 1) + (x - 1)];

    function getAvg(x1, y1, x2, y2) {
      x1 = Math.max(0, x1); y1 = Math.max(0, y1);
      x2 = Math.min(w, x2); y2 = Math.min(h, y2);
      const area = (x2 - x1) * (y2 - y1);
      if (area <= 0) return 128;
      return (integral[y2 * (w + 1) + x2] - integral[y1 * (w + 1) + x2]
            - integral[y2 * (w + 1) + x1] + integral[y1 * (w + 1) + x1]) / area;
    }

    // Adaptive threshold: dark bg areas → white, light tile areas → preserve text
    const radius = 60;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const localAvg = getAvg(x - radius, y - radius, x + radius, y + radius);
        const px = gray[y * w + x];
        let val;
        if (localAvg < 110) val = px > localAvg + 50 ? 0 : 255;
        else val = px < localAvg - 30 ? 0 : 255;
        d[i] = val; d[i + 1] = val; d[i + 2] = val;
      }

    // Remove long horizontal black lines (tile borders confuse Tesseract segmentation)
    for (let y = 0; y < h; y++) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const isBlack = x < w && d[(y * w + x) * 4] < 128;
        if (isBlack && runStart < 0) runStart = x;
        if (!isBlack && runStart >= 0) {
          if (x - runStart > 100) {
            for (let xx = runStart; xx < x; xx++)
              for (let dy = -2; dy <= 2; dy++) {
                const yy = y + dy;
                if (yy >= 0 && yy < h) {
                  const ii = (yy * w + xx) * 4;
                  d[ii] = 255; d[ii + 1] = 255; d[ii + 2] = 255;
                }
              }
          }
          runStart = -1;
        }
      }
    }

    // Remove long vertical black lines
    for (let x = 0; x < w; x++) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const isBlack = y < h && d[(y * w + x) * 4] < 128;
        if (isBlack && runStart < 0) runStart = y;
        if (!isBlack && runStart >= 0) {
          if (y - runStart > 100) {
            for (let yy = runStart; yy < y; yy++)
              for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < w) {
                  const ii = (yy * w + xx) * 4;
                  d[ii] = 255; d[ii + 1] = 255; d[ii + 2] = 255;
                }
              }
          }
          runStart = -1;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  return canvas.toBuffer('image/png');
}

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
    .filter(w => w.length >= 3);

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

const tests = [
  {
    name: 'Sample 1 - single word tiles (light mode)',
    file: 'test-images/sample1.jpg',
    expectedTiles: ['POUND', 'PLAIN', 'OBJECT', 'CROWN', 'JUMP', 'MARK', 'FRANK', 'RICH', 'GOAL', 'STRAIGHT', 'POINT', 'BISHOP', 'KING', 'BLUNT', 'FROST', 'CAPTURE'],
    expectedConfidence: 'high',
  },
  {
    name: 'Sample 2 - has multi-word tiles (HOT WATER, TEA BAG, YO-YO)',
    file: 'test-images/sample2.jpg',
    expectedTiles: ['HOT', 'KITE', 'WIND', 'WATER', 'KEY', 'TEABAG', 'LIGHTNING', 'BALLOON', 'JAM', 'PITCH', 'ARROW', 'BIND', 'SCALE', 'YO-YO', 'TONE', 'ROCKET', 'PICKLE'],
    expectedConfidence: 'low', // 17 words, needs user edit
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
];

async function run() {
  let allPassed = true;

  for (const test of tests) {
    console.log(`\n=== ${test.name} ===`);

    const processed = await preprocessImage(test.file);
    const { data } = await Tesseract.recognize(processed, 'eng');

    const result = extractTilesFromText(data.text);
    console.log(`Extracted ${result.tiles.length} tiles: ${result.tiles.join(', ')}`);
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
