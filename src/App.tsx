import { useState, useRef, useCallback } from 'react';
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

// rowColors: map from row index (0-3) to color index (0-3), or null if unassigned
type RowColorMap = Record<number, number | null>;

function App() {
  const [words, setWords] = useState<string[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [rowColors, setRowColors] = useState<RowColorMap>({ 0: null, 1: null, 2: null, 3: null });
  const [paintingColor, setPaintingColor] = useState<number | null>(null);
  const [history, setHistory] = useState<{ words: string[]; rowColors: RowColorMap }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pushHistory = useCallback(() => {
    if (words) {
      setHistory(h => [...h, { words: [...words], rowColors: { ...rowColors } }]);
    }
  }, [words, rowColors]);

  const handleSwap = useCallback((from: number, to: number) => {
    if (from === to) return;
    pushHistory();
    setWords(prev => {
      if (!prev) return prev;
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, [pushHistory]);

  // Tap-to-swap
  const handleTileTap = (index: number) => {
    // If in painting mode, paint the row
    if (paintingColor !== null) {
      const row = Math.floor(index / 4);
      const existingRow = Object.entries(rowColors).find(([, c]) => c === paintingColor);
      pushHistory();

      const nextColors: RowColorMap = { ...rowColors };
      if (existingRow) {
        nextColors[Number(existingRow[0])] = null;
      }
      nextColors[row] = paintingColor;
      setRowColors(nextColors);
      setPaintingColor(null);

      // If all four colours are now assigned, reorder rows: Purple first
      const allAssigned = Object.values(nextColors).every(c => c !== null);
      if (allAssigned && words) {
        // Build new word order: row with colour 0 (Purple) first, then 1 (Lilac), etc.
        const rowOrder = COLORS.map((_, ci) =>
          Number(Object.entries(nextColors).find(([, c]) => c === ci)![0])
        );
        const reordered: string[] = [];
        const finalColors: RowColorMap = { 0: null, 1: null, 2: null, 3: null };
        rowOrder.forEach((oldRow, newRow) => {
          for (let col = 0; col < 4; col++) {
            reordered.push(words[oldRow * 4 + col]);
          }
          finalColors[newRow] = nextColors[oldRow];
        });
        setWords(reordered);
        setRowColors(finalColors);
      }
      return;
    }

    if (selectedIndex === null) {
      setSelectedIndex(index);
    } else if (selectedIndex === index) {
      setSelectedIndex(null);
    } else {
      handleSwap(selectedIndex, index);
      setSelectedIndex(null);
    }
  };

  // Desktop drag and drop
  const dragIndexRef = useRef<number | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = 'move';
    dragIndexRef.current = index;
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndexRef.current !== null) {
      handleSwap(dragIndexRef.current, toIndex);
    }
    dragIndexRef.current = null;
  };

  // Mobile touch drag and drop (Waffle-style: lift tile, follow finger, highlight target)
  const touchDragRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    tile: HTMLElement | null;
    moved: boolean;
    lastTarget: HTMLElement | null;
  } | null>(null);

  const handleTouchStart = (e: React.TouchEvent, index: number) => {
    if (paintingColor !== null) return;
    const touch = e.touches[0];
    const tile = (e.target as HTMLElement).closest('.tile') as HTMLElement;
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    touchDragRef.current = {
      index,
      startX: touch.clientX,
      startY: touch.clientY,
      originX: rect.left + rect.width / 2,
      originY: rect.top + rect.height / 2,
      tile,
      moved: false,
      lastTarget: null,
    };
  };

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const ref = touchDragRef.current;
    if (!ref || !ref.tile) return;
    const touch = e.touches[0];
    const dx = touch.clientX - ref.startX;
    const dy = touch.clientY - ref.startY;

    // Only start drag after 8px movement
    if (!ref.moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (!ref.moved) {
      ref.moved = true;
      ref.tile.classList.add('dragging');
    }
    e.preventDefault();

    // Move the actual tile with transform
    ref.tile.style.transform = `translate(${dx}px, ${dy}px) scale(1.15)`;

    // Find tile under finger (hide dragged tile briefly for elementFromPoint)
    ref.tile.style.pointerEvents = 'none';
    const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
    ref.tile.style.pointerEvents = '';
    const targetTile = el?.closest('[data-tile-index]') as HTMLElement;

    // Highlight drop target
    if (ref.lastTarget && ref.lastTarget !== targetTile) {
      ref.lastTarget.classList.remove('drag-over');
    }
    if (targetTile && targetTile !== ref.tile) {
      targetTile.classList.add('drag-over');
      ref.lastTarget = targetTile;
    } else {
      ref.lastTarget = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const ref = touchDragRef.current;
    if (!ref) return;

    // Clean up drag styles
    if (ref.tile) {
      ref.tile.classList.remove('dragging');
      ref.tile.style.transform = '';
    }
    if (ref.lastTarget) {
      ref.lastTarget.classList.remove('drag-over');
    }

    if (ref.moved) {
      e.preventDefault();
      // Find which tile we're over
      const touch = e.changedTouches[0];
      if (ref.tile) ref.tile.style.pointerEvents = 'none';
      const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
      if (ref.tile) ref.tile.style.pointerEvents = '';
      const targetTile = dropTarget?.closest('[data-tile-index]') as HTMLElement;
      if (targetTile) {
        const toIndex = Number(targetTile.dataset.tileIndex);
        handleSwap(ref.index, toIndex);
      }
    }

    touchDragRef.current = null;
  }, [handleSwap]);

  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setWords(prev.words);
    setRowColors(prev.rowColors);
  };

  const handlePaintClick = (colorIdx: number) => {
    if (paintingColor === colorIdx) {
      // Toggle off
      setPaintingColor(null);
    } else {
      setPaintingColor(colorIdx);
      setSelectedIndex(null);
    }
  };

  const handleClearColor = (row: number) => {
    pushHistory();
    setRowColors(prev => ({ ...prev, [row]: null }));
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
        setRowColors({ 0: null, 1: null, 2: null, 3: null });
        setSelectedIndex(null);
        setPaintingColor(null);
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
      setRowColors({ 0: null, 1: null, 2: null, 3: null });
      setSelectedIndex(null);
      setPaintingColor(null);
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
      // Only shuffle unpainted tiles
      const unpainted = next
        .map((w, i) => ({ w, i }))
        .filter(({ i }) => rowColors[Math.floor(i / 4)] === null);
      const unpaintedWords = unpainted.map(u => u.w);
      for (let i = unpaintedWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unpaintedWords[i], unpaintedWords[j]] = [unpaintedWords[j], unpaintedWords[i]];
      }
      unpainted.forEach((u, idx) => {
        next[u.i] = unpaintedWords[idx];
      });
      return next;
    });
  };

  const handleNew = () => {
    setWords(null);
    setHistory([]);
    setRowColors({ 0: null, 1: null, 2: null, 3: null });
    setSelectedIndex(null);
    setPaintingColor(null);
  };

  // Landing screen
  if (!words && !editMode) {
    return (
      <div className="app">
        <h1>Purple First</h1>
        <p className="subtitle">A helper for the NYT Connections puzzle — scan or enter the 16 words, swap tiles to group them, then paint each row with a colour to lock in your answer.</p>
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
  const usedColors = new Set(Object.values(rowColors).filter(c => c !== null));

  return (
    <div className="app">
      <h1>Purple First</h1>
      <p className="hint">
        {paintingColor !== null
          ? `Tap a row to paint it ${COLORS[paintingColor].name}`
          : 'Tap or drag tiles to swap them'}
      </p>

      <div className="grid">
        {words!.map((word, i) => {
          const row = Math.floor(i / 4);
          const colorIdx = rowColors[row];
          const color = colorIdx !== null ? COLORS[colorIdx] : NEUTRAL;
          const isSelected = selectedIndex === i;
          const isPainted = colorIdx !== null;

          return (
            <div
              key={i}
              data-tile-index={i}
              className={`tile${isSelected ? ' selected' : ''}${isPainted ? ' painted' : ''}${paintingColor !== null ? ' paint-mode' : ''}`}
              style={{
                backgroundColor: color.bg,
                color: color.text,
              }}
              onClick={() => handleTileTap(i)}
              draggable={paintingColor === null}
              onDragStart={e => handleDragStart(e, i)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDrop(e, i)}
              onTouchStart={e => handleTouchStart(e, i)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {word}
            </div>
          );
        })}
      </div>

      <div className="color-bar">
        <span className="color-bar-label">Paint row:</span>
        {COLORS.map((c, i) => {
          const assignedRow = Object.entries(rowColors).find(([, ci]) => ci === i);
          return (
            <button
              key={i}
              className={`color-btn${paintingColor === i ? ' active' : ''}${assignedRow ? ' used' : ''}`}
              style={{
                backgroundColor: c.bg,
                color: c.text,
                borderColor: paintingColor === i ? '#333' : c.bg,
              }}
              onClick={() => handlePaintClick(i)}
              title={assignedRow ? `${c.name} (row ${Number(assignedRow[0]) + 1}) — tap to reassign` : c.name}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      {usedColors.size > 0 && (
        <div className="painted-rows">
          {[0, 1, 2, 3].map(row => {
            const ci = rowColors[row];
            if (ci === null) return null;
            return (
              <div key={row} className="painted-row-tag" style={{ backgroundColor: COLORS[ci].bg, color: COLORS[ci].text }}>
                Row {row + 1}: {COLORS[ci].name}
                <button className="clear-tag" onClick={() => handleClearColor(row)} style={{ color: COLORS[ci].text }}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="button-row">
        <button onClick={handleUndo} disabled={history.length === 0}>Undo</button>
        <button onClick={handleShuffle}>Shuffle</button>
        <button onClick={handleEditOpen}>Edit</button>
        <button onClick={handleNew}>New</button>
      </div>

      <div className="version">v{__APP_VERSION__}</div>
    </div>
  );
}

export default App;
