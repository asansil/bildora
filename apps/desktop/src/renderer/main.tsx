import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShellApi } from '../preload/api.js';

declare global {
  interface Window {
    readonly bildora: ShellApi;
  }
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing root element');
}

createRoot(container).render(
  <StrictMode>
    <main>
      <h1>Bildora</h1>
      <p data-testid="platform">{window.bildora.platform}</p>
    </main>
  </StrictMode>,
);
