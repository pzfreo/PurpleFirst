const Tesseract = require('tesseract.js');

function extractTilesFromText(text) {
  const upper = text.toUpperCase();
  const startMarker = upper.indexOf('FOUR!');
  const endMarker = upper.indexOf('MISTAKES');
  const gridText = startMarker >= 0 && endMarker > startMarker
    ? text.substring(startMarker + 5, endMarker)
    : text;

  const words = gridText.split(/\s+/)
    .map(w => w.toUpperCase().replace(/[^A-Z-]/g, '').replace(/^-+|-+$/g, ''))
    .filter(w => w.length >= 2);

  const seen = new Set();
  return words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

const tests = [
  {
    name: 'Sample 1 - single word tiles',
    file: 'test-images/sample1.jpg',
    expected: ['POUND', 'PLAIN', 'OBJECT', 'CROWN', 'JUMP', 'MARK', 'FRANK', 'RICH', 'GOAL', 'STRAIGHT', 'POINT', 'BISHOP', 'KING', 'BLUNT', 'FROST', 'CAPTURE'],
  },
  {
    name: 'Sample 2 - has multi-word tiles (HOT WATER, TEA BAG, YO-YO)',
    file: 'test-images/sample2.jpg',
    // Multi-word tiles come through as separate words, user fixes in edit screen
    // YO-YO keeps hyphen, TEABAG is OCR artifact (merged)
    expected: ['HOT', 'KITE', 'WIND', 'WATER', 'KEY', 'TEABAG', 'LIGHTNING', 'BALLOON', 'JAM', 'PITCH', 'ARROW', 'BIND', 'SCALE', 'YO-YO', 'TONE', 'ROCKET', 'PICKLE'],
  },
];

async function run() {
  let allPassed = true;

  for (const test of tests) {
    console.log(`\n=== ${test.name} ===`);
    console.log(`File: ${test.file}`);
    const { data } = await Tesseract.recognize(test.file, 'eng');
    console.log('Raw text:', JSON.stringify(data.text));

    const result = extractTilesFromText(data.text);
    console.log(`Extracted ${result.length} tiles:`, result.join(', '));
    console.log(`Expected ${test.expected.length} tiles:`, test.expected.join(', '));

    const missing = test.expected.filter(w => !result.includes(w));
    const junk = result.filter(w => !test.expected.includes(w));

    if (missing.length === 0 && junk.length === 0) {
      console.log('✅ PASS');
    } else {
      allPassed = false;
      if (missing.length > 0) console.log('❌ MISSING:', missing.join(', '));
      if (junk.length > 0) console.log('❌ JUNK:', junk.join(', '));
    }

    // Additional check: count should be 16 or close
    if (result.length < 16) {
      console.log(`⚠️  Only ${result.length} tiles (need 16)`);
    } else if (result.length > 16) {
      console.log(`⚠️  ${result.length} tiles (expected ~16, user trims in edit screen)`);
    }
  }

  console.log(allPassed ? '\n✅ ALL TESTS PASSED' : '\n❌ SOME TESTS FAILED');
  process.exit(allPassed ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
