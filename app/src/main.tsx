import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import engineWorkerUrl from './engine/worker.ts?worker&url';
import workletUrl from './audio/worklet.ts?worker&url';
import wasmUrl from './wasm/pkg/hb_wasm_bg.wasm?url';
import { createServices, ServicesProvider, type Services } from './ui/state/app';

const root = createRoot(document.getElementById('root') as HTMLElement);

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="app-main" style={{ height: '100%' }}>
      <div className="app-main-inner">
        <h1>{title}</h1>
        <p className="dim">{text}</p>
      </div>
    </div>
  );
}

root.render(<Message title="Hurricane Brain" text="Loading." />);

createServices().then(
  (services: Services) => {
    root.render(
      <StrictMode>
        <ServicesProvider services={services}>
          <App />
        </ServicesProvider>
      </StrictMode>,
    );
  },
  (e: unknown) => {
    root.render(
      <Message
        title="Storage is not available"
        text={`The app keeps everything on this device and needs the browser's local storage. It could not be opened (${e instanceof Error ? e.message : String(e)}). If you are in a private window, open the app in a normal window.`}
      />,
    );
  },
);

// Offline support: a small service worker, registered only in the built app.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Ask the worker to cache every file this page has loaded so far, so a first visit works offline.
        // The engine worker, its WebAssembly and the audio worklet are only fetched when a device
        // connects or a sound starts, so they are named here and cached on the first visit.
        const urls = [...performance.getEntriesByType('resource').map((e) => e.name), engineWorkerUrl, workletUrl, wasmUrl].map((u) => new URL(u, document.baseURI).href);
        reg.active?.postMessage({ type: 'cache-urls', urls });
      })
      .catch(() => {
        /* the app still works online */
      });
  });
}
