import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker for Web Share Target support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/PurpleFirst/sw.js').catch(() => {
    // SW registration failed — share target won't work but app is fine
  });
}
