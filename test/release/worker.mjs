import { runBrowserSmoke } from './browser-entry.mjs';

self.onmessage = async ({ data }) => {
    try {
        self.postMessage(await runBrowserSmoke(data));
    } catch (error) {
        self.postMessage({ error: error.stack ?? String(error), passed: false, scope: 'module-worker' });
    }
};
