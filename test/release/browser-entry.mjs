import { runSmoke } from './smoke.mjs';

export async function runBrowserSmoke(options) {
    const api = await import(options.moduleUrl);
    const fixture = new Uint8Array(await (await fetch(options.fixtureUrl)).arrayBuffer());
    const thumbnail = new Uint8Array(await (await fetch(options.thumbnailUrl)).arrayBuffer());
    const customFetchArguments = [];
    const fetchRuntime = options.loader === 'custom' ? (path) => {
        if (typeof path !== 'string' || path !== options.rawWasmPath) throw new Error('Custom fetch argument changed.');
        customFetchArguments.push(path);
        return fetch(options.wasmUrl);
    } : undefined;
    const report = await runSmoke(api, {
        customOnly: options.loader === 'custom',
        expectedVersion: options.expectedVersion,
        fetchRuntime,
        fixture,
        scope: typeof document === 'undefined' ? 'module-worker' : 'window',
        thumbnail,
    });
    report.loader = options.loader;
    report.customFetchArguments = customFetchArguments;
    if (options.loader === 'custom' && customFetchArguments.length === 0) {
        report.error = 'Custom fetch was not exercised.';
        report.passed = false;
    }
    return report;
}
