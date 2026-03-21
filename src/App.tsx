import { useState, useRef, useCallback } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

const ROW_COLORS = [
  { name: 'Purple', bg: '#7B2D8B', text: '#fff' },
  { name: 'Lilac', bg: '#9BADE5', text: '#000' },
  { name: 'Yellow', bg: '#F9DF6D', text: '#000' },
  { name: 'Green', bg: '#A0C35A', text: '#000' },
];

const IGNORED_WORDS = new Set([
  'CREATE', 'FOUR', 'GROUPS', 'OF', 'GROUP', 'SHUFFLE', 'SUBMIT',
  'DESELECT', 'ALL', 'MISTAKES', 'REMAINING',
  'NYTIMES', 'COM', 'GAMES', 'HTTPS', 'WWW', 'THE', 'NEW',
  'YORK', 'CONNECTIONS', 'MENU', 'PLAY', 'TODAY', 'YESTERDAY',
]);

/** Load a File as an Image element */
function loadImage(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/** Crop the image to the grid area using OCR bounding boxes */
function cropToGrid(img: HTMLImageElement, data: Tesseract.Page): HTMLCanvasElement | null {
  if (!data.blocks) return null;

  // Collect bounding boxes of all candidate tile words
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const block of data.blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          const clean = word.text.toUpperCase().replace(/[^A-Z]/g, '');
          if (clean.length >= 3 && clean.length <= 12 && word.confidence > 50) {
            boxes.push(word.bbox);
          }
        }
      }
    }
  }

  if (boxes.length < 10) return null; // Not enough words found

  // Find the bounding box of the grid (where the cluster of words is)
  const ys = boxes.map(b => b.y0).concat(boxes.map(b => b.y1)).sort((a, b) => a - b);
  // Use the 10th percentile as top and 90th as bottom to exclude outliers
  const topY = ys[Math.floor(ys.length * 0.1)];
  const bottomY = ys[Math.floor(ys.length * 0.9)];

  // Add some padding
  const pad = Math.floor((bottomY - topY) * 0.15);
  const cropTop = Math.max(0, topY - pad);
  const cropBottom = Math.min(img.height, bottomY + pad);
  const cropHeight = cropBottom - cropTop;

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, cropTop, img.width, cropHeight, 0, 0, img.width, cropHeight);
  return canvas;
}

/** Extract tile labels from OCR data, preserving order and supporting multi-word tiles */
function extractTiles(data: Tesseract.Page): string[] {
  if (!data.blocks) return [];

  // Collect all candidate words with their positions
  const candidates: { text: string; confidence: number; y: number; x: number }[] = [];
  for (const block of data.blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          candidates.push({
            text: word.text.toUpperCase().replace(/[^A-Z]/g, ''),
            confidence: word.confidence,
            y: word.bbox.y0,
            x: word.bbox.x0,
          });
        }
      }
    }
  }

  // Filter to plausible tile words
  const filtered = candidates.filter(w =>
    w.text.length >= 2 &&
    w.text.length <= 12 &&
    w.confidence > 50 &&
    !IGNORED_WORDS.has(w.text)
  );

  // Group words into rows by similar y position (within 5% of image height)
  // Then within each row, sort by x position
  // This preserves the grid reading order
  if (filtered.length === 0) return [];

  // Sort by y then x
  filtered.sort((a, b) => a.y - b.y || a.x - b.x);

  // Group into rows: words within close y are on the same row
  const rows: typeof filtered[number][][] = [];
  let currentRow: typeof filtered[number][] = [filtered[0]];

  for (let i = 1; i < filtered.length; i++) {
    const prevY = currentRow[0].y;
    // If y is within ~30px, same row (tiles are usually 80-150px tall)
    if (Math.abs(filtered[i].y - prevY) < 40) {
      currentRow.push(filtered[i]);
    } else {
      rows.push(currentRow);
      currentRow = [filtered[i]];
    }
  }
  rows.push(currentRow);

  // Sort each row by x, then flatten
  const results: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);

    // Try to group adjacent words in this row that might form a multi-word tile
    // For now: each word is its own tile unless they're very close horizontally
    for (const w of row) {
      if (!seen.has(w.text)) {
        seen.add(w.text);
        results.push(w.text);
      }
    }
  }

  return results;
}

function App() {
  const [words, setWords] = useState<string[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [lockedRows, setLockedRows] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<string[][]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSwap = useCallback((from: number, to: number) => {
    if (from === to) return;
    const fromRow = Math.floor(from / 4);
    const toRow = Math.floor(to / 4);
    if (lockedRows.has(fromRow) || lockedRows.has(toRow)) return;

    setWords(prev => {
      if (!prev) return prev;
      setHistory(h => [...h, prev]);
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, [lockedRows]);

  // Tap-to-swap
  const handleTileTap = (index: number) => {
    const row = Math.floor(index / 4);
    if (lockedRows.has(row)) return;

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
    const row = Math.floor(index / 4);
    if (lockedRows.has(row)) {
      e.preventDefault();
      return;
    }
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

  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setWords(prev);
  };

  const toggleLockRow = (row: number) => {
    setLockedRows(prev => {
      const next = new Set(prev);
      if (next.has(row)) {
        next.delete(row);
      } else {
        next.add(row);
      }
      return next;
    });
    setSelectedIndex(null);
  };

  // OCR
  const handleScan = async (file: File) => {
    setScanning(true);
    setScanError(null);
    try {
      const img = await loadImage(file);

      // First pass: OCR on full image to find word positions
      const { data: fullData } = await Tesseract.recognize(file, 'eng', {
        logger: () => {},
      });

      // Try to crop to just the grid area using detected word positions
      const croppedCanvas = cropToGrid(img, fullData);
      let extracted: string[];

      if (croppedCanvas) {
        // Second pass: OCR on cropped grid for better accuracy
        const croppedBlob = await new Promise<Blob>((res, rej) =>
          croppedCanvas.toBlob(b => b ? res(b) : rej(new Error('crop failed')), 'image/png')
        );
        const { data: croppedData } = await Tesseract.recognize(croppedBlob, 'eng', {
          logger: () => {},
        });
        extracted = extractTiles(croppedData);
      } else {
        // Fallback: use the full image results
        extracted = extractTiles(fullData);
      }
      // Always show edit screen so user can verify/fix
      const display = extracted.slice(0, 16);
      if (extracted.length < 16) {
        setScanError(`Found ${extracted.length} words — need 16. Please fix below.`);
      } else if (extracted.length > 16) {
        setScanError(`Found ${extracted.length} words — trimmed to 16. Please verify below.`);
      }
      setEditText(display.join('\n'));
      setEditMode(true);
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
      setLockedRows(new Set());
      setSelectedIndex(null);
      setEditMode(false);
    } else {
      alert(`Need exactly 16 words (got ${newWords.length})`);
    }
  };

  const handleShuffle = () => {
    setWords(prev => {
      if (!prev) return prev;
      setHistory(h => [...h, prev]);
      const next = [...prev];
      // Only shuffle unlocked tiles
      const unlocked = next
        .map((w, i) => ({ w, i }))
        .filter(({ i }) => !lockedRows.has(Math.floor(i / 4)));
      const unlockedWords = unlocked.map(u => u.w);
      for (let i = unlockedWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unlockedWords[i], unlockedWords[j]] = [unlockedWords[j], unlockedWords[i]];
      }
      unlocked.forEach((u, idx) => {
        next[u.i] = unlockedWords[idx];
      });
      return next;
    });
  };

  // Landing screen
  if (!words && !editMode) {
    return (
      <div className="app">
        <h1>Purple First</h1>
        <p className="subtitle">Solve Connections — hardest category first!</p>

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
  return (
    <div className="app">
      <h1>Purple First</h1>
      <p className="hint">Tap a tile, then tap another to swap them</p>

      <div className="grid">
        {words!.map((word, i) => {
          const row = Math.floor(i / 4);
          const color = ROW_COLORS[row];
          const isSelected = selectedIndex === i;
          const isLocked = lockedRows.has(row);

          return (
            <div
              key={i}
              data-tile-index={i}
              className={`tile${isSelected ? ' selected' : ''}${isLocked ? ' locked' : ''}`}
              style={{
                backgroundColor: color.bg,
                color: color.text,
              }}
              onClick={() => handleTileTap(i)}
              draggable={!isLocked}
              onDragStart={e => handleDragStart(e, i)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDrop(e, i)}
            >
              {word}
            </div>
          );
        })}
      </div>

      <div className="row-locks">
        {ROW_COLORS.map((c, i) => (
          <button
            key={i}
            className={`lock-btn${lockedRows.has(i) ? ' active' : ''}`}
            style={{
              borderColor: c.bg,
              backgroundColor: lockedRows.has(i) ? c.bg : 'transparent',
              color: lockedRows.has(i) ? c.text : c.bg,
            }}
            onClick={() => toggleLockRow(i)}
          >
            {lockedRows.has(i) ? '🔒' : '🔓'} {c.name}
          </button>
        ))}
      </div>

      <div className="button-row">
        <button onClick={handleUndo} disabled={history.length === 0}>Undo</button>
        <button onClick={handleShuffle}>Shuffle</button>
        <button onClick={handleEditOpen}>Edit</button>
        <button onClick={() => { setWords(null); setHistory([]); setLockedRows(new Set()); setSelectedIndex(null); }}>New</button>
      </div>
    </div>
  );
}

export default App;
