import { useState, useRef, useCallback } from 'react';
import Tesseract from 'tesseract.js';
import './App.css';

const ROW_COLORS = [
  { name: 'Purple', bg: '#7B2D8B', text: '#fff' },
  { name: 'Lilac', bg: '#C8A2D4', text: '#000' },
  { name: 'Yellow', bg: '#F9DF6D', text: '#000' },
  { name: 'Green', bg: '#A0C35A', text: '#000' },
];

const IGNORED_WORDS = new Set([
  'CREATE', 'FOUR', 'GROUPS', 'OF', 'GROUP', 'SHUFFLE', 'SUBMIT',
  'DESELECT', 'ALL', 'MISTAKES', 'REMAINING', 'MISTAKESREMAINING',
  // Common browser / NYT UI fragments OCR picks up
  'NYTIMES', 'COM', 'GAMES', 'COR', 'HTTPS', 'WWW', 'THE', 'NEW',
  'YORK', 'CONNECTIONS', 'MENU', 'PLAY', 'TODAY', 'YESTERDAY',
]);

function extractWords(text: string): string[] {
  const words = text
    .split(/\s+/)
    .map(w => w.replace(/[^A-Z]/g, ''))
    .filter(w =>
      w.length >= 3 &&        // skip 1-2 char OCR noise
      w.length <= 12 &&       // skip long URL/UI fragments
      !IGNORED_WORDS.has(w)
    );

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
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
      const { data } = await Tesseract.recognize(file, 'eng', {
        logger: () => {},
      });
      const extracted = extractWords(data.text.toUpperCase());
      if (extracted.length >= 16) {
        setWords(extracted.slice(0, 16));
        setHistory([]);
        setLockedRows(new Set());
        setSelectedIndex(null);
      } else {
        setScanError(`Found ${extracted.length} words — need 16. You can fix them manually.`);
        // Pre-fill edit mode with what we found
        const padded = [...extracted];
        while (padded.length < 16) padded.push('');
        setEditText(padded.join('\n'));
        setEditMode(true);
      }
    } catch {
      setScanError('OCR failed. Try entering words manually.');
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
