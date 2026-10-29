import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
    compareVersions,
    finalizeRelease,
    parseChecksum,
    parseUpstreamVersion,
    planRelease,
    readTarball,
    updateReadmeVersion,
    verifyIntegrity,
    verifyReceipt,
    verifyReceiptWithRetry,
} from '../scripts/release.mjs';

const NAME = '@colorhythm/exiftool-wasm';
const REGISTRY = 'https://registry.npmjs.org';
const SCRIPT = Buffer.from("#!/usr/bin/env perl\nmy $version = '13.60';\n");
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 0]);
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 4)}\n`);
const upstream = (version = '13.60') => ({
    version,
    url: `https://sourceforge.net/projects/exiftool/files/Image-ExifTool-${version}.tar.gz`,
    sha256: 'a'.repeat(64),
    revision: 'b'.repeat(40),
});
const plan = (version = '1.0.5') => ({ schemaVersion: 1, packageName: NAME, packageVersion: version, upstream: upstream() });
const fileRecord = (path, bytes) => ({ path, bytes: bytes.length, sha256: hash(bytes) });

function tar(entries) {
    const blocks = [];
    for (const { path, bytes = Buffer.alloc(0), type = '0' } of entries) {
        const header = Buffer.alloc(512);
        header.write(path, 0, 100);
        header.write('0000644\0', 100, 8);
        header.write('0000000\0', 108, 8);
        header.write('0000000\0', 116, 8);
        header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
        header.write('00000000000\0', 136, 12);
        header.fill(32, 148, 156);
        header.write(type, 156, 1);
        header.write('ustar\0', 257, 6);
        header.write('00', 263, 2);
        const checksum = header.reduce((sum, value) => sum + value, 0);
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
        blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

function publication({ version = '1.0.5', manifest = true, upstreamVersion = '13.60', mutate } = {}) {
    const files = new Map([
        ['package/package.json', json({ name: NAME, version })],
        ['package/dist/esm/index.js', Buffer.from('export const ready = true;\n')],
        ['package/dist/esm/zeroperl.wasm', WASM],
    ]);
    const metadata = {
        schemaVersion: 1,
        package: { name: NAME, version },
        upstream: upstream(upstreamVersion),
        build: {
            perlVersion: '5.42.0',
            runUrl: 'https://github.com/colorhythm/exiftool-wasm/actions/runs/123',
            sourceRevision: 'c'.repeat(40),
            zeroperlRevision: 'd'.repeat(40),
            zeroperlTsRevision: 'e'.repeat(40),
        },
        artifacts: {
            script: fileRecord('src/exiftool', SCRIPT),
            wasm: fileRecord('src/zeroperl/zeroperl.wasm', WASM),
        },
        distribution: [...files.entries()].filter(([path]) => path.startsWith('package/dist/'))
            .map(([path, bytes]) => fileRecord(path.slice(8), bytes)),
    };
    if (mutate) mutate(metadata, files);
    if (manifest) files.set('package/exiftool-build.json', json(metadata));
    const bytes = tar([...files.entries()].map(([path, bytes_]) => ({ path, bytes: bytes_ })));
    return {
        bytes,
        files,
        manifest: metadata,
        record: {
            name: NAME,
            version,
            dist: {
                integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
                tarball: `${REGISTRY}/@colorhythm/exiftool-wasm/-/exiftool-wasm-${version}.tgz`,
            },
        },
    };
}

async function rootFixture(t, { version = '1.0.4', manifest } = {}) {
    const root = await mkdtemp(resolve(tmpdir(), 'exiftool-release-test-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    await writeFile(resolve(root, 'package.json'), json({ name: NAME, version }));
    await writeFile(resolve(root, 'README.md'), `# ${NAME}\n\n<!-- exiftool-version:start -->\nBuilt with **ExifTool 13.60** · wrapper **${version}**.\n<!-- exiftool-version:end -->\n\nPackage documentation.\n`);
    if (manifest) await writeFile(resolve(root, 'exiftool-build.json'), json(manifest));
    return root;
}

function sources(publications, { latest = publications.at(-1).record.version, version = '13.60' } = {}) {
    const entries = new Map([
        ['https://exiftool.org/ver.txt', Buffer.from(version)],
        ['https://exiftool.org/checksums.txt', Buffer.from(`SHA2-256(Image-ExifTool-${version}.tar.gz)= ${'a'.repeat(64)}\n`)],
        [`https://api.github.com/repos/exiftool/exiftool/git/ref/tags/${version}`, json({ ref: `refs/tags/${version}`, object: { type: 'commit', sha: 'b'.repeat(40) } })],
        [`${REGISTRY}/${encodeURIComponent(NAME)}`, json({ 'dist-tags': { latest }, versions: Object.fromEntries(publications.map((item) => [item.record.version, item.record])) })],
    ]);
    for (const item of publications) {
        entries.set(item.record.dist.tarball, item.bytes);
        entries.set(`${REGISTRY}/${encodeURIComponent(NAME)}/${item.record.version}`, json(item.record));
    }
    const requests = [];
    const fetch = async (url, options) => {
        requests.push({ url, options });
        if (!entries.has(url)) return new Response('missing fixture', { status: 404 });
        return new Response(entries.get(url));
    };
    return { entries, fetch, requests };
}

test('official checksum parsing handles SHA2-256, SHA256, and GNU formats with exact names', () => {
    const value = 'abc01234'.repeat(8);
    for (const text of [
        `SHA2-256(Image-ExifTool-13.60.tar.gz)= ${value}`,
        `SHA256 (Image-ExifTool-13.60.tar.gz) = ${value.toUpperCase()}\r\n`,
        `${value}  Image-ExifTool-13.60.tar.gz`,
        `${value} *Image-ExifTool-13.60.tar.gz`,
    ]) assert.equal(parseChecksum(text, '13.60'), value);
    for (const text of [
        `SHA1(Image-ExifTool-13.60.tar.gz)= ${value}`,
        `SHA2-256(Image-ExifTool-13.6.tar.gz)= ${value}`,
        `SHA2-256(exiftool-13.60_64.zip)= ${value}`,
        `SHA2-256(Image-ExifTool-13.60.tar.gz)= ${value}\nSHA256(Image-ExifTool-13.60.tar.gz)= ${'b'.repeat(64)}`,
    ]) assert.throws(() => parseChecksum(text, '13.60'), /unambiguous/);
});

test('version parsing preserves two fractional digits and ordering is numeric', () => {
    assert.equal(parseUpstreamVersion('13.60\n'), '13.60');
    for (const value of ['13.6', '13.600', '013.60', '13.60beta', '../13.60', '']) assert.throws(() => parseUpstreamVersion(value));
    assert.equal(compareVersions('13.60', '13.59'), 1);
    assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
});

test('tarball integrity is checked before interpreting archive contents', () => {
    const item = publication();
    assert.equal(verifyIntegrity(item.bytes, item.record.dist.integrity), item.record.dist.integrity);
    assert.throws(() => verifyIntegrity(Buffer.concat([item.bytes, Buffer.from('x')]), item.record.dist.integrity), /SHA-512/);
    assert.throws(() => verifyIntegrity(item.bytes, `sha1-${'a'.repeat(40)}`), /SHA-512/);
    assert.ok(readTarball(item.bytes).has('package/exiftool-build.json'));
});

test('in-memory tar reader rejects traversal, duplicate members, and links', () => {
    for (const entries of [
        [{ path: '../outside', bytes: Buffer.from('x') }],
        [{ path: 'package/../outside', bytes: Buffer.from('x') }],
        [{ path: 'package/file', bytes: Buffer.from('a') }, { path: 'package/file', bytes: Buffer.from('b') }],
        [{ path: 'package/link', type: '2' }],
        [{ path: '/package/absolute', bytes: Buffer.from('x') }],
    ]) assert.throws(() => readTarball(tar(entries)));
});

test('PAX paths receive the same extraction-free safety checks', () => {
    const record = 'path=package/../outside\n';
    let length = record.length + 2;
    while (`${length} ${record}`.length !== length) length = `${length} ${record}`.length;
    const bytes = tar([
        { path: 'PaxHeader', type: 'x', bytes: Buffer.from(`${length} ${record}`) },
        { path: 'package/placeholder', bytes: Buffer.from('x') },
    ]);
    assert.throws(() => readTarball(bytes), /Unsafe/);
});

test('tar reader rejects data hidden after the archive terminator', () => {
    const first = tar([{ path: 'package/file', bytes: Buffer.from('x') }]);
    const trailing = gzipSync(Buffer.concat([gunzipSync(first), Buffer.from('hidden payload')]));
    assert.throws(() => readTarball(trailing), /after the tar archive terminator/);
});

test('legacy publication lacking a manifest forces a build and chooses the next package patch', async (t) => {
    const root = await rootFixture(t);
    const source = sources([publication({ version: '1.0.4', manifest: false })]);
    const result = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(result.packageVersion, '1.0.5');
    assert.equal(result.shouldBuild, true);
    assert.equal(result.shouldRecover, false);
    assert.ok(source.requests.some(({ url }) => url.endsWith('.tgz')));
});

test('blank optional upstream version uses the official current version', async (t) => {
    const root = await rootFixture(t);
    const source = sources([publication({ version: '1.0.4', manifest: false })]);
    const result = await planRelease({ root, fetch: source.fetch, version: '', environment: {} });
    assert.equal(result.upstream.version, '13.60');
    assert.ok(source.requests.some(({ url }) => url.endsWith('/ver.txt')));
});

test('an unpublished committed candidate keeps its package version on retry', async (t) => {
    const pending = publication({ version: '1.0.5' });
    const root = await rootFixture(t, { version: '1.0.5', manifest: pending.manifest });
    const source = sources([publication({ version: '1.0.4', manifest: false })]);
    const result = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(result.packageVersion, '1.0.5');
    assert.equal(result.reason, 'retry-unpublished-candidate');
});

test('a package newer than both registry and source advances from the maximum stable version', async (t) => {
    const root = await rootFixture(t, { version: '1.0.8' });
    const source = sources([publication({ version: '1.0.4', manifest: false }), publication({ version: '1.0.9', manifest: false })], { latest: '1.0.4' });
    const result = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(result.packageVersion, '1.0.10');
});

test('verified publication avoids rebuilding and enables recovery only for the exact local manifest', async (t) => {
    const published = publication({ version: '1.0.5' });
    const root = await rootFixture(t, { version: '1.0.5', manifest: published.manifest });
    const source = sources([published]);
    const result = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(result.shouldBuild, false);
    assert.equal(result.shouldRecover, true);
    assert.equal(result.packageVersion, '1.0.5');
    await rm(resolve(root, 'exiftool-build.json'));
    const absent = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(absent.shouldBuild, false);
    assert.equal(absent.shouldRecover, false);
});

test('an already-published candidate is recognized even before latest dist-tag advances', async (t) => {
    const published = publication({ version: '1.0.5' });
    const root = await rootFixture(t, { version: '1.0.5', manifest: published.manifest });
    const source = sources([publication({ version: '1.0.4', manifest: false }), published], { latest: '1.0.4' });
    const result = await planRelease({ root, fetch: source.fetch, environment: {} });
    assert.equal(result.packageVersion, '1.0.5');
    assert.equal(result.shouldBuild, false);
});

test('source or registry provenance cannot silently change or downgrade an upstream release', async (t) => {
    const root = await rootFixture(t);
    const future = sources([publication({ upstreamVersion: '13.61' })]);
    await assert.rejects(planRelease({ root, fetch: future.fetch, environment: {} }), /downgrade/);
    const changed = sources([publication({ mutate: (manifest) => { manifest.upstream.sha256 = 'f'.repeat(64); } })]);
    await assert.rejects(planRelease({ root, fetch: changed.fetch, environment: {} }), /different archive or Git provenance/);
});

test('published upstream versions must retain exact string identity', async (t) => {
    const root = await rootFixture(t);
    const source = sources([publication({ mutate: (manifest) => { manifest.upstream.version = 13.6; } })]);
    await assert.rejects(planRelease({ root, fetch: source.fetch, environment: {} }), /exact X.YY string/);
});

test('registry artifact hashes and paired WASM are checked even during planning', async (t) => {
    const root = await rootFixture(t);
    const source = sources([publication({ mutate: (_manifest, files) => { files.set('package/dist/esm/zeroperl.wasm', Buffer.from('wrong')); } })]);
    await assert.rejects(planRelease({ root, fetch: source.fetch, environment: {} }), /artifact mismatch/);
});

test('annotated upstream tags resolve to a fixed commit and authentication stays on GitHub', async (t) => {
    const root = await rootFixture(t);
    const source = sources([publication({ version: '1.0.4', manifest: false })]);
    source.entries.set('https://api.github.com/repos/exiftool/exiftool/git/ref/tags/13.60', json({ ref: 'refs/tags/13.60', object: { type: 'tag', sha: 'f'.repeat(40) } }));
    source.entries.set(`https://api.github.com/repos/exiftool/exiftool/git/tags/${'f'.repeat(40)}`, json({ object: { type: 'commit', sha: 'b'.repeat(40) } }));
    const result = await planRelease({ root, fetch: source.fetch, environment: { GITHUB_TOKEN: 'fake-test-token' } });
    assert.equal(result.upstream.revision, 'b'.repeat(40));
    for (const { url, options } of source.requests) {
        assert.equal(Boolean(options.headers.Authorization), url.startsWith('https://api.github.com/'));
        assert.equal(options.redirect, 'error');
    }
});

async function finalizable(t) {
    const root = await rootFixture(t, { version: '1.0.5' });
    const files = new Map([
        ['src/exiftool', SCRIPT],
        ['src/zeroperl/zeroperl.wasm', WASM],
        ['dist/esm/index.js', Buffer.from('export const ready = true;\n')],
        ['dist/esm/zeroperl.wasm', WASM],
    ]);
    for (const [path, bytes] of files) {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), bytes);
    }
    return {
        root,
        plan: plan(),
        perlVersion: '5.42.0',
        runUrl: 'https://github.com/colorhythm/exiftool-wasm/actions/runs/123',
        sourceRevision: 'c'.repeat(40),
        zeroperlRevision: 'd'.repeat(40),
        zeroperlTsRevision: 'e'.repeat(40),
    };
}

test('finalization records exact source pairs and all bundle hashes deterministically', async (t) => {
    const options = await finalizable(t);
    const first = await finalizeRelease(options);
    const firstBytes = await readFile(resolve(options.root, 'exiftool-build.json'));
    assert.equal(first.upstream.version, '13.60');
    assert.equal(first.artifacts.wasm.sha256, hash(WASM));
    assert.deepEqual(first.distribution.map((item) => item.path), ['dist/esm/index.js', 'dist/esm/zeroperl.wasm']);
    await finalizeRelease(options);
    assert.deepEqual(await readFile(resolve(options.root, 'exiftool-build.json')), firstBytes);
});

test('finalization refreshes README for the next upstream and wrapper release without stale versions', async (t) => {
    const options = await finalizable(t);
    const original = await readFile(resolve(options.root, 'README.md'), 'utf8');
    options.plan = { ...plan('1.0.6'), upstream: upstream('14.00') };
    await writeFile(resolve(options.root, 'package.json'), json({ name: NAME, version: '1.0.6' }));
    await writeFile(resolve(options.root, 'src/exiftool'), SCRIPT.toString().replace('13.60', '14.00'));
    const manifest = await finalizeRelease(options);
    const updated = await readFile(resolve(options.root, 'README.md'), 'utf8');
    assert.equal(updated, original.replace('ExifTool 13.60', 'ExifTool 14.00').replace('wrapper **1.0.5**', 'wrapper **1.0.6**'));
    assert.equal(manifest.upstream.version, '14.00');
    assert.ok(updated.includes('Built with **ExifTool 14.00** · wrapper **1.0.6**.'));
    assert.ok(!updated.includes('13.60'));
    assert.ok(!updated.includes('1.0.5'));
});

test('README updates reject missing, duplicate, or misplaced markers', () => {
    const start = '<!-- exiftool-version:start -->';
    const end = '<!-- exiftool-version:end -->';
    for (const readme of [
        '# Package\n',
        `# Package\n${start}\n${start}\n${end}\n`,
        `# Package\n${start}\n${end}\n${end}\n`,
        `# Package\n${end}\n${start}\n`,
        `${start}\n${end}\n# Package\n`,
        `# Package\nIntro before version.\n${start}\n${end}\n`,
    ]) assert.throws(() => updateReadmeVersion(readme, '14.00', '1.0.6'), /README/);
});

test('invalid README markers fail finalization before README or manifest is changed', async (t) => {
    const options = await finalizable(t);
    await finalizeRelease(options);
    const originalManifest = await readFile(resolve(options.root, 'exiftool-build.json'));
    const invalidReadme = '# Package\n\nNo version markers.\n';
    await writeFile(resolve(options.root, 'README.md'), invalidReadme);
    await assert.rejects(finalizeRelease(options), /exactly one/);
    assert.equal(await readFile(resolve(options.root, 'README.md'), 'utf8'), invalidReadme);
    assert.deepEqual(await readFile(resolve(options.root, 'exiftool-build.json')), originalManifest);
});

test('finalization rejects mismatched script, stale WASM, and wrong planned package version', async (t) => {
    const options = await finalizable(t);
    await writeFile(resolve(options.root, 'src/exiftool'), SCRIPT.toString().replace('13.60', '13.59'));
    await assert.rejects(finalizeRelease(options), /script does not match/);
    await writeFile(resolve(options.root, 'src/exiftool'), SCRIPT);
    await writeFile(resolve(options.root, 'dist/esm/zeroperl.wasm'), Buffer.from('stale'));
    await assert.rejects(finalizeRelease(options), /paired WASM/);
    await writeFile(resolve(options.root, 'dist/esm/zeroperl.wasm'), WASM);
    await writeFile(resolve(options.root, 'package.json'), json({ name: NAME, version: '1.0.4' }));
    await assert.rejects(finalizeRelease(options), /planned package version/);
});

test('receipt proves the registry tarball exactly matches the tested tarball and manifest', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    await writeFile(resolve(root, 'tested.tgz'), item.bytes);
    const source = sources([item]);
    const result = await verifyReceipt({ root, plan: plan(), tarball: 'tested.tgz', fetch: source.fetch, environment: {} });
    assert.equal(result.status, 'verified');
    assert.equal(result.testedTarballMatched, true);
    assert.equal(result.manifestSha256, hash(item.files.get('package/exiftool-build.json')));
    await writeFile(resolve(root, 'tested.tgz'), Buffer.concat([item.bytes, Buffer.from('different')]));
    await assert.rejects(verifyReceipt({ root, plan: plan(), tarball: 'tested.tgz', fetch: source.fetch, environment: {} }), /exact tested tarball/);
});

test('receipt fails when published build metadata differs or contains unrecorded bundles', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    const different = publication({ mutate: (manifest) => { manifest.build.sourceRevision = 'f'.repeat(40); } });
    await assert.rejects(verifyReceipt({ root, plan: plan(), fetch: sources([different]).fetch, environment: {} }), /manifest differs/);
    const extra = publication({ mutate: (_manifest, files) => { files.set('package/dist/esm/stale.wasm', WASM); } });
    await assert.rejects(verifyReceipt({ root, plan: plan(), fetch: sources([extra]).fetch, environment: {} }), /unrecorded/);
});

test('receipt retries transient registry absence but fails integrity mismatches immediately', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    const source = sources([item]);
    let attempts = 0;
    let sleeps = 0;
    const options = {
        root,
        plan: plan(),
        environment: {},
        fetch: async (...args) => {
            attempts += 1;
            return attempts === 1 ? new Response('not propagated', { status: 404 }) : source.fetch(...args);
        },
    };
    const result = await verifyReceiptWithRetry(options, { sleep: async () => { sleeps += 1; } });
    assert.equal(result.status, 'verified');
    assert.equal(sleeps, 1);
    source.entries.set(item.record.dist.tarball, Buffer.from('corrupt'));
    sleeps = 0;
    await assert.rejects(verifyReceiptWithRetry({ ...options, fetch: source.fetch }, { sleep: async () => { sleeps += 1; } }), /SHA-512/);
    assert.equal(sleeps, 0);
});

test('receipt retry bounds prevent indefinite polling', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    let count = 0;
    await assert.rejects(verifyReceiptWithRetry({ root, plan: plan(), fetch: async () => { count += 1; return new Response('', { status: 503 }); } }, {
        attempts: 2,
        sleep: async () => {},
    }), /HTTP 503/);
    assert.equal(count, 2);
});

test('receipt allows ten minutes of propagation waits by default and accepts the explicit 61-attempt bound', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    for (const attempts of [undefined, 61]) {
        let count = 0;
        const delays = [];
        await assert.rejects(verifyReceiptWithRetry({
            root,
            plan: plan(),
            fetch: async () => {
                count += 1;
                return new Response('still processing', { status: 404 });
            },
        }, {
            attempts,
            sleep: async (delay) => { delays.push(delay); },
        }), /HTTP 404/);
        assert.equal(count, 61);
        assert.equal(delays.length, 60);
        assert.ok(delays.every((delay) => delay === 10000));
        assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 600000);
    }
});

test('receipt rejects retry settings beyond 61 attempts or ten-second intervals before polling', async () => {
    let count = 0;
    const options = { fetch: async () => { count += 1; } };
    for (const settings of [{ attempts: 62 }, { attempts: 0 }, { delayMs: 10001 }]) {
        await assert.rejects(verifyReceiptWithRetry(options, settings), /Invalid bounded receipt retry settings/);
    }
    assert.equal(count, 0);
});

test('receipt provenance mismatch fails immediately despite the extended processing window', async (t) => {
    const item = publication();
    const root = await rootFixture(t, { version: '1.0.5', manifest: item.manifest });
    const different = publication({ mutate: (manifest) => { manifest.build.sourceRevision = 'f'.repeat(40); } });
    const source = sources([different]);
    let sleeps = 0;
    await assert.rejects(verifyReceiptWithRetry({ root, plan: plan(), fetch: source.fetch, environment: {} }, {
        sleep: async () => { sleeps += 1; },
    }), /manifest differs/);
    assert.equal(sleeps, 0);
    assert.equal(source.requests.length, 2);
});
