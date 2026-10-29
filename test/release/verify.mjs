import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const parameters = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--expected-version', '--output', '--source'].includes(key) || !value || value.startsWith('--') || parameters.has(key)) {
        throw new Error('Usage: npm run test:release -- --expected-version 13.60 --source /path/to/official-source [--output artifacts/release-validation]');
    }
    parameters.set(key, value);
}
const expectedVersion = parameters.get('--expected-version');
if (!/^\d+\.\d+$/.test(expectedVersion ?? '') || !parameters.has('--source')) {
    throw new Error('An exact --expected-version and the verified official --source directory are required.');
}
const output = resolve(parameters.get('--output') ?? join(root, 'artifacts/release-validation'));
const source = resolve(parameters.get('--source'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).some((name) => name.endsWith('.tgz'))) {
    throw new Error(`A package tarball already exists in ${output}; use a new empty output directory to avoid publishing stale evidence.`);
}
const scratch = await mkdtemp(join(output, 'consumer-'));
const packageDirectory = join(scratch, 'node_modules/@colorhythm/exiftool-wasm');
const writeJson = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 4)}\n`);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const report = { expectedVersion, generatedAt: new Date().toISOString(), nodeVersion: process.version, phases: {} };

// No lifecycle scripts or installation are needed: this package has no runtime dependencies.
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output, '--cache', join(output, 'npm-cache')], {
    cwd: root,
    encoding: 'utf8',
}));
if (packed.length !== 1) throw new Error('Expected exactly one npm tarball.');
const tarball = join(output, packed[0].filename);
await mkdir(packageDirectory, { recursive: true });
execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageDirectory]);
const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
if (Object.keys(packageJson.dependencies ?? {}).length > 0) throw new Error('The isolated consumer must install and verify any newly introduced runtime dependencies.');
const esm = join(packageDirectory, 'dist/esm');
const assets = (await readdir(esm)).filter((name) => name.endsWith('.wasm'));
if (assets.length !== 1) throw new Error('Expected one packaged WASM asset; clean dist before building.');
const wasm = assets[0];
const wasmBytes = await readFile(join(esm, wasm));
const bundle = await readFile(join(esm, 'index.js'));
const buildInfo = JSON.parse(await readFile(join(packageDirectory, 'exiftool-build.json'), 'utf8'));
await stat(join(packageDirectory, packageJson.types));
report.package = {
    buildInfo,
    bundleSha256: hash(bundle),
    integrity: packed[0].integrity,
    name: packageJson.name,
    scriptSha256: hash(await readFile(join(root, 'src/exiftool'))),
    tarball: packed[0].filename,
    tarballSha512: hash(await readFile(tarball), 'sha512'),
    version: packageJson.version,
    wasm,
    wasmBytes: wasmBytes.length,
    wasmSha256: hash(wasmBytes),
};

// Import by package name from the clean consumer so package exports are exercised.
const nodeEntry = join(scratch, 'verify-consumer.mjs');
const smokeUrl = pathToFileURL(join(root, 'test/release/smoke.mjs')).href;
const nativeUrl = pathToFileURL(join(root, 'test/release/native-parity.mjs')).href;
await writeFile(nodeEntry, `import * as api from '@colorhythm/exiftool-wasm';
import buildInfo from '@colorhythm/exiftool-wasm/build-info' with { type: 'json' };
import { readFile, stat, writeFile } from 'node:fs/promises';
import { runSmoke } from ${JSON.stringify(smokeUrl)};
import { compareNative } from ${JSON.stringify(nativeUrl)};
const options = JSON.parse(process.argv[2]);
const save = (name, value) => writeFile(options.output + '/' + name, JSON.stringify(value, null, 4) + '\\n');
const asset = import.meta.resolve('@colorhythm/exiftool-wasm/dist/esm/' + options.wasm);
await stat(new URL(asset));
let passed = true;
for (const [name, run] of [
    ['node-smoke.json', async () => ({
        ...await runSmoke(api, {
            expectedVersion: options.expectedVersion,
            fixture: new Uint8Array(await readFile(options.fixture)),
            scope: 'node',
            thumbnail: new Uint8Array(await readFile(options.thumbnail)),
        }),
        buildInfoExport: buildInfo,
        wasmExport: asset,
    })],
    ['native-parity.json', () => compareNative(api, options)],
]) {
    try {
        const result = await run();
        await save(name, result);
        passed &&= result.passed;
    } catch (error) {
        await save(name, { passed: false, error: error.stack ?? String(error) });
        passed = false;
    }
}
if (!passed) process.exitCode = 1;
`);
try {
    execFileSync(process.execPath, [nodeEntry, JSON.stringify({
        expectedVersion,
        fixture: join(root, 'test/data/thumb_embedded.jpg'),
        output,
        source,
        thumbnail: join(root, 'test/data/thumb_groundtruth.jpg'),
        wasm,
    })], { cwd: scratch, stdio: 'inherit', timeout: 240000 });
} catch (error) {
    report.phases.nodeProcess = { passed: false, error: error.message };
}
for (const name of ['native-parity', 'node-smoke']) {
    try {
        report.phases[name] = JSON.parse(await readFile(join(output, `${name}.json`), 'utf8'));
    } catch (error) {
        report.phases[name] = { passed: false, error: error.message };
    }
}

const requests = [];
const roots = new Map([
    ['/fixtures/', join(root, 'test/data')],
    ['/harness/', join(root, 'test/release')],
    ['/package/', packageDirectory],
]);
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const prefix = [...roots.keys()].find((value) => pathname.startsWith(value));
        if (!prefix || pathname.split('/').some((part) => part.startsWith('.'))) throw new Error('Invalid path');
        const baseDirectory = roots.get(prefix);
        const path = resolve(baseDirectory, pathname.slice(prefix.length));
        if (!path.startsWith(`${baseDirectory}${sep}`) || !(await stat(path)).isFile()) throw new Error('Invalid file');
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
        const bytes = await readFile(path);
        requests.push({ path: pathname, status: 200 });
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
        response.end(bytes);
    } catch {
        requests.push({ path: request.url, status: 404 });
        response.writeHead(404).end('Not found');
    }
});
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browserReport = { browsers: [], expectedVersion, requests };
const environment = { ...process.env };
delete environment.DYLD_LIBRARY_PATH;
delete environment.DYLD_FALLBACK_LIBRARY_PATH;
try {
    for (const { browserType, launch, name } of [
        { browserType: chromium, launch: { channel: 'chrome', headless: true }, name: 'chrome' },
        { browserType: webkit, launch: { headless: true }, name: 'webkit' },
    ]) {
        let browser;
        const entry = { cases: [], errors: [], name };
        browserReport.browsers.push(entry);
        try {
            browser = await browserType.launch({ ...launch, env: environment });
            entry.version = browser.version();
            for (const loader of ['default', 'custom']) {
                // Fresh contexts exercise each loader normally; no forced garbage collection.
                const context = await browser.newContext();
                try {
                    const page = await context.newPage();
                    page.setDefaultTimeout(120000);
                    page.on('pageerror', (error) => entry.errors.push(error.message));
                    await page.goto(`${baseUrl}/harness/browser.html`);
                    await page.waitForFunction(() => typeof window.runExiftoolRelease === 'function');
                    const options = {
                        expectedVersion,
                        fixtureUrl: `${baseUrl}/fixtures/thumb_embedded.jpg`,
                        loader,
                        moduleUrl: `${baseUrl}/package/dist/esm/index.js`,
                        rawWasmPath: `./${wasm}`,
                        thumbnailUrl: `${baseUrl}/fixtures/thumb_groundtruth.jpg`,
                        wasmUrl: `${baseUrl}/package/dist/esm/${wasm}`,
                    };
                    for (const scope of ['window', 'module-worker']) {
                        try {
                            const result = await page.evaluate(({ options, scope }) => scope === 'window'
                                ? window.runExiftoolRelease(options)
                                : window.runExiftoolWorkerRelease(options), { options, scope });
                            entry.cases.push(result);
                            console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name} ${scope} ${loader} loader`);
                        } catch (error) {
                            entry.cases.push({ error: error.stack ?? String(error), loader, passed: false, scope });
                        }
                    }
                } finally {
                    await context.close();
                }
            }
            entry.passed = entry.cases.length === 4 && entry.cases.every((result) => result.passed) && entry.errors.length === 0;
        } catch (error) {
            entry.error = error.stack ?? String(error);
            entry.passed = false;
        } finally {
            await browser?.close();
        }
    }
} finally {
    await new Promise((resolve) => server.close(resolve));
}
browserReport.passed = browserReport.browsers.length === 2 && browserReport.browsers.every((entry) => entry.passed);
await writeJson('browsers.json', browserReport);
report.phases.browsers = browserReport;
report.passed = Object.values(report.phases).every((phase) => phase.passed);
await writeJson('validation.json', report);
console.log(`${report.passed ? 'PASS' : 'FAIL'} packed-package release validation: ${join(output, 'validation.json')}`);
if (!report.passed) process.exitCode = 1;
