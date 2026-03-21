import { useState, useRef, useCallback } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

const COLORS = [
  { name: 'Purple', bg: '#7B2D8B', text: '#fff' },
  { name: 'Lilac', bg: '#9BADE5', text: '#000' },
  { name: 'Yellow', bg: '#F9DF6D', text: '#000' },
  { name: 'Green', bg: '#A0C35A', text: '#000' },
];

const NEUTRAL = { bg: '#E8E4DE', text: '#000' };

interface OcrResult {
  tiles: string[];
  confidence: 'high' | 'low';
  reason?: string;
}

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
    .filter(w => w.length >= 2);

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
      const { data } = await Tesseract.recognize(file, 'eng', {
        logger: () => {},
      });
      const { tiles, confidence, reason } = extractTilesFromText(data.text);

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
          : 'Tap a tile, then tap another to swap them'}
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
    </div>
  );
}

export default App;
