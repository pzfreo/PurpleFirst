import { useState, useRef, useCallback, useEffect } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

const COLORS = [
  { name: 'Purple', bg: '#7B2D8B', text: '#fff' },
  { name: 'Lilac', bg: '#9BADE5', text: '#000' },
  { name: 'Yellow', bg: '#F9DF6D', text: '#000' },
  { name: 'Green', bg: '#A0C35A', text: '#000' },
];

const NEUTRAL = { bg: '#E8E4DE', text: '#000' };

// --- Grid detection and per-tile OCR ---

interface OcrResult {
  tiles: string[];
  confidence: 'high' | 'low';
  reason?: string;
}

function filterBands(bands: number[][], expected: number): number[][] {
  if (bands.length <= expected) return bands;
  const sorted = bands.map(b => ({ start: b[0], end: b[1], h: b[1] - b[0] }))
    .sort((a, b) => b.h - a.h).slice(0, expected);
  sorted.sort((a, b) => a.start - b.start);
  return sorted.map(b => [b.start, b.end]);
}

function detectGrid(gray: Uint8Array, w: number, h: number, isDark: boolean) {
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

  const rawBands: number[][] = [];
  let inBand = false, bandStart = 0;
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

  const rawVBands: number[][] = [];
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

/** Load image, detect 4x4 grid, OCR each tile individually */
function extractTilesFromImage(file: File): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const w = img.width, h = img.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        // Compute grayscale
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
        if (!grid) {
          // Fallback: full-image OCR with text extraction
          const blob = await new Promise<Blob>((res, rej) => {
            canvas.toBlob(b => b ? res(b) : rej(new Error('Failed')), 'image/png');
          });
          const { data: ocrData } = await Tesseract.recognize(blob, 'eng', { logger: () => {} });
          resolve(extractTilesFromText(ocrData.text));
          return;
        }

        const { rows, cols } = grid;
        const margin = 3;
        const tiles: string[] = [];

        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            const x1 = cols[c][0] + margin, y1 = rows[r][0] + margin;
            const tw = cols[c][1] - cols[c][0] - margin * 2;
            const th = rows[r][1] - rows[r][0] - margin * 2;
            const tileCanvas = document.createElement('canvas');
            tileCanvas.width = tw;
            tileCanvas.height = th;
            const tileCtx = tileCanvas.getContext('2d')!;
            tileCtx.drawImage(img, x1, y1, tw, th, 0, 0, tw, th);

            const tileBlob = await new Promise<Blob>((res, rej) => {
              tileCanvas.toBlob(b => b ? res(b) : rej(new Error('Failed')), 'image/png');
            });
            const result = await Tesseract.recognize(tileBlob, 'eng', { logger: () => {} });
            const text = result.data.text.trim().split(/\n/).map((l: string) => l.trim()).join(' ')
              .toUpperCase().replace(/[^A-Z -]/g, '').trim();
            tiles.push(text);
          }
        }

        const nonEmpty = tiles.filter(t => t.length > 0);
        if (nonEmpty.length !== 16) {
          resolve({ tiles: nonEmpty, confidence: 'low', reason: `${16 - nonEmpty.length} tiles could not be read` });
          return;
        }
        const oddLength = tiles.filter(t => t.length < 3 || t.length > 20);
        if (oddLength.length > 0) {
          resolve({ tiles, confidence: 'low', reason: `Unusual words: ${oddLength.join(', ')}` });
          return;
        }
        resolve({ tiles, confidence: 'high' });
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(img.src);
      }
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/** Text-based fallback extraction from full-image OCR text */
function extractTilesFromText(text: string): OcrResult {
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

  const seen = new Set<string>();
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

function App() {
  const [words, setWords] = useState<string[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [selectedTiles, setSelectedTiles] = useState<Set<number>>(new Set());
  const [tileColors, setTileColors] = useState<(number | null)[]>(Array(16).fill(null));
  const [history, setHistory] = useState<{ words: string[]; tileColors: (number | null)[] }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Check for updates on load and every 5 minutes
  useEffect(() => {
    const checkUpdate = () => {
      fetch(`${import.meta.env.BASE_URL}version.json?_=${Date.now()}`)
        .then(r => r.json())
        .then(data => {
          if (data.version && data.version !== __APP_VERSION__) {
            setUpdateAvailable(true);
          }
        })
        .catch(() => {}); // silently ignore fetch errors
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Pick up shared image from Web Share Target
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('shared') !== '1') return;

    // Clean up the URL so refreshing doesn't re-trigger
    window.history.replaceState({}, '', window.location.pathname);

    caches.open('share-target-v1').then(async (cache) => {
      const response = await cache.match('/shared-image');
      if (!response) return;
      const blob = await response.blob();
      await cache.delete('/shared-image');
      const file = new File([blob], 'shared-screenshot.png', { type: blob.type });
      handleScan(file);
    }).catch(() => {});
  }, []);
  const [scanError, setScanError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pushHistory = useCallback(() => {
    if (words) {
      setHistory(h => [...h, { words: [...words], tileColors: [...tileColors] }]);
    }
  }, [words, tileColors]);

  // Tap to toggle tile selection (max 4)
  const handleTileTap = (index: number) => {
    setSelectedTiles(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else if (next.size < 4) {
        next.add(index);
      }
      return next;
    });
  };

  // Assign selected tiles to a color group
  const handleAssignColor = (colorIdx: number) => {
    if (selectedTiles.size !== 4) return;
    pushHistory();

    const nextColors = [...tileColors];
    // Clear this color from any previously assigned tiles
    for (let i = 0; i < 16; i++) {
      if (nextColors[i] === colorIdx) nextColors[i] = null;
    }
    // Assign to selected tiles
    selectedTiles.forEach(i => { nextColors[i] = colorIdx; });

    // Check if all 16 tiles are now assigned — auto-reorder
    const allAssigned = nextColors.every(c => c !== null);
    if (allAssigned && words) {
      const reordered: string[] = [];
      const finalColors: (number | null)[] = [];
      // Group by color: Purple (0) first, then Lilac (1), Yellow (2), Green (3)
      for (let ci = 0; ci < 4; ci++) {
        for (let i = 0; i < 16; i++) {
          if (nextColors[i] === ci) {
            reordered.push(words[i]);
            finalColors.push(ci);
          }
        }
      }
      setWords(reordered);
      setTileColors(finalColors);
    } else {
      setTileColors(nextColors);
    }
    setSelectedTiles(new Set());
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setWords(prev.words);
    setTileColors(prev.tileColors);
    setSelectedTiles(new Set());
  };

  const handleDeselectAll = () => {
    setSelectedTiles(new Set());
  };

  // OCR
  const handleScan = async (file: File) => {
    setScanning(true);
    setScanError(null);
    try {
      const { tiles, confidence, reason } = await extractTilesFromImage(file);

      if (confidence === 'high') {
        setWords(tiles);
        setHistory([]);
        setTileColors(Array(16).fill(null));
        setSelectedTiles(new Set());
      } else {
        setScanError(reason || `Found ${tiles.length} words — please verify.`);
        setEditText(tiles.slice(0, 16).join('\n'));
        setEditMode(true);
      }
    } catch {
      setScanError('OCR failed. Try entering words manually.');
      setEditMode(true);
      setEditText('');
    } finally {
      setScanning(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleScan(file);
    e.target.value = '';
  };

  const handleEditOpen = () => {
    setEditText(words ? words.join('\n') : '');
    setEditMode(true);
  };

  const handleEditSave = () => {
    const newWords = editText
      .split('\n')
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length > 0);
    if (newWords.length === 16) {
      setWords(newWords);
      setHistory([]);
      setTileColors(Array(16).fill(null));
      setSelectedTiles(new Set());
      setEditMode(false);
    } else {
      alert(`Need exactly 16 words (got ${newWords.length})`);
    }
  };

  const handleShuffle = () => {
    pushHistory();
    setWords(prev => {
      if (!prev) return prev;
      const next = [...prev];
      // Only shuffle ungrouped tiles
      const ungrouped = next
        .map((w, i) => ({ w, i, c: tileColors[i] }))
        .filter(({ c }) => c === null);
      const ungroupedWords = ungrouped.map(u => u.w);
      for (let i = ungroupedWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ungroupedWords[i], ungroupedWords[j]] = [ungroupedWords[j], ungroupedWords[i]];
      }
      ungrouped.forEach((u, idx) => {
        next[u.i] = ungroupedWords[idx];
      });
      return next;
    });
    setSelectedTiles(new Set());
  };

  const handleNew = () => {
    setWords(null);
    setHistory([]);
    setTileColors(Array(16).fill(null));
    setSelectedTiles(new Set());
  };

  // Landing screen
  if (!words && !editMode) {
    return (
      <div className="app">
        <h1>Purple First</h1>
        <p className="subtitle">A helper for the NYT Connections puzzle — scan or enter the 16 words, select 4 tiles at a time and assign them a colour to form groups.</p>
        <div className="landing">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            hidden
          />
          <button
            className="primary-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : '📷 Scan Screenshot'}
          </button>
          <button className="secondary-btn" onClick={handleEditOpen}>
            Enter Manually
          </button>
          {scanError && <p className="error">{scanError}</p>}
        </div>
        <div className="version">
          v{__APP_VERSION__}
          {updateAvailable && (
            <button className="update-btn" onClick={() => window.location.reload()}>
              Update available — tap to refresh
            </button>
          )}
        </div>
      </div>
    );
  }

  // Edit screen
  if (editMode) {
    return (
      <div className="app">
        <h1>Purple First</h1>
        <div className="edit-panel">
          <p>Enter 16 words, one per line:</p>
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            rows={16}
            autoFocus
          />
          {scanError && <p className="error">{scanError}</p>}
          <div className="button-row">
            <button onClick={handleEditSave}>Save</button>
            <button onClick={() => { setEditMode(false); setScanError(null); }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // Main grid
  const usedColorSet = new Set(tileColors.filter(c => c !== null));

  return (
    <div className="app">
      <h1>Purple First</h1>
      <p className="hint">
        {selectedTiles.size === 0
          ? 'Select 4 tiles to form a group'
          : selectedTiles.size < 4
            ? `${selectedTiles.size}/4 selected — pick ${4 - selectedTiles.size} more`
            : 'Choose a colour for this group'}
      </p>

      <div className="grid">
        {words!.map((word, i) => {
          const colorIdx = tileColors[i];
          const color = colorIdx !== null ? COLORS[colorIdx] : NEUTRAL;
          const isSelected = selectedTiles.has(i);
          const isGrouped = colorIdx !== null;

          return (
            <div
              key={i}
              data-tile-index={i}
              className={`tile${isSelected ? ' selected' : ''}${isGrouped ? ' grouped' : ''}`}
              style={{
                backgroundColor: color.bg,
                color: color.text,
              }}
              onClick={() => handleTileTap(i)}
            >
              {word}
            </div>
          );
        })}
      </div>

      <div className="color-bar">
        {COLORS.map((c, i) => {
          const hasGroup = usedColorSet.has(i);
          return (
            <button
              key={i}
              className={`color-btn${hasGroup ? ' used' : ''}`}
              style={{
                backgroundColor: c.bg,
                color: c.text,
                borderColor: c.bg,
              }}
              onClick={() => handleAssignColor(i)}
              disabled={selectedTiles.size !== 4}
              title={c.name}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      <div className="button-row">
        {selectedTiles.size > 0 && (
          <button onClick={handleDeselectAll}>Deselect</button>
        )}
        <button onClick={handleUndo} disabled={history.length === 0}>Undo</button>
        <button onClick={handleShuffle}>Shuffle</button>
        <button onClick={handleEditOpen}>Edit</button>
        <button onClick={handleNew}>New</button>
      </div>

      <div className="version">
          v{__APP_VERSION__}
          {updateAvailable && (
            <button className="update-btn" onClick={() => window.location.reload()}>
              Update available — tap to refresh
            </button>
          )}
        </div>
    </div>
  );
}

export default App;
