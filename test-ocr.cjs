const Tesseract = require('tesseract.js');

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
    .filter(w => w.length >= 2);

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
    name: 'Sample 1 - single word tiles',
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
];

async function run() {
  let allPassed = true;

  for (const test of tests) {
    console.log(`\n=== ${test.name} ===`);
    const { data } = await Tesseract.recognize(test.file, 'eng');

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
