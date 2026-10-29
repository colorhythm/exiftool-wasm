import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

const PACKAGE_NAME = '@colorhythm/exiftool-wasm';
const RECEIPT_MAX_ATTEMPTS = 61;
const REGISTRY = 'https://registry.npmjs.org';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function parseUpstreamVersion(value) {
    const version = String(value).trim();
    if (!/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(version)) throw new Error('Expected an ExifTool release in X.YY format.');
    return version;
}

export function updateReadmeVersion(readme, upstreamVersion, wrapperVersion) {
    const startMarker = '<!-- exiftool-version:start -->';
    const endMarker = '<!-- exiftool-version:end -->';
    if (readme.split(startMarker).length !== 2 || readme.split(endMarker).length !== 2) {
        throw new Error('README must contain exactly one ExifTool version marker pair.');
    }
    const start = readme.indexOf(startMarker);
    const end = readme.indexOf(endMarker);
    const heading = /^# [^\r\n]+/m.exec(readme);
    if (end < start || !heading || start < heading.index + heading[0].length
        || readme.slice(heading.index + heading[0].length, start).trim()) {
        throw new Error('README version markers must be ordered immediately after the main heading.');
    }
    const line = `Built with **ExifTool ${parseUpstreamVersion(upstreamVersion)}** · wrapper **${packageVersion(wrapperVersion)}**.`;
    return `${readme.slice(0, start)}${startMarker}\n${line}\n${endMarker}${readme.slice(end + endMarker.length)}`;
}

export function parseChecksum(text, version) {
    const filename = `Image-ExifTool-${parseUpstreamVersion(version)}.tar.gz`;
    const matches = [];
    for (const line of text.split(/\r?\n/)) {
        const bsd = /^\s*SHA(?:2-)?256\s*\(\s*([^()]+?)\s*\)\s*=\s*([a-f0-9]{64})\s*$/i.exec(line);
        const gnu = /^\s*([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
        if (bsd?.[1] === filename) matches.push(bsd[2].toLowerCase());
        if (gnu?.[2] === filename) matches.push(gnu[1].toLowerCase());
    }
    const unique = [...new Set(matches)];
    if (unique.length !== 1) throw new Error(`Expected one unambiguous official SHA-256 for ${filename}.`);
    return unique[0];
}

function packageVersion(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`Expected a stable package version, received ${value}.`);
    }
    return value;
}

export function compareVersions(left, right) {
    const a = left.split('.').map(BigInt);
    const b = right.split('.').map(BigInt);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0n) - (b[index] ?? 0n);
        if (difference) return difference > 0n ? 1 : -1;
    }
    return 0;
}

function nextPatch(version) {
    const [major, minor, patch] = packageVersion(version).split('.');
    return `${major}.${minor}.${BigInt(patch) + 1n}`;
}

function revision(value, label) {
    if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error(`Expected a full ${label} Git revision.`);
    return value;
}

function requireHttps(url, host) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.port
        || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`Unexpected URL for ${host}.`);
    }
    return parsed;
}

async function request(url, fetch, environment = {}) {
    const host = new URL(url).hostname;
    if (!['api.github.com', 'exiftool.org', 'registry.npmjs.org'].includes(host)) throw new Error('Unexpected release source.');
    requireHttps(url, host);
    const headers = { 'User-Agent': 'colorhythm-exiftool-release' };
    if (host === 'api.github.com') {
        headers.Accept = 'application/vnd.github+json';
        if (environment.GITHUB_TOKEN) headers.Authorization = `Bearer ${environment.GITHUB_TOKEN}`;
    }
    let response;
    try {
        response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch (cause) {
        const error = new Error(`Release source request failed: ${url}`, { cause });
        error.retryable = ['AbortError', 'TimeoutError', 'TypeError'].includes(cause.name);
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`Release source returned HTTP ${response.status}: ${url}`);
        error.retryable = [404, 408, 429].includes(response.status) || response.status >= 500;
        throw error;
    }
    if (response.url) requireHttps(response.url, host);
    try {
        return Buffer.from(await response.arrayBuffer());
    } catch (cause) {
        const error = new Error(`Release source download failed: ${url}`, { cause });
        error.retryable = ['AbortError', 'TimeoutError', 'TypeError'].includes(cause.name);
        throw error;
    }
}

export function verifyIntegrity(bytes, integrity) {
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
        throw new Error('The npm registry must provide one SHA-512 integrity value.');
    }
    const observed = `sha512-${digest(bytes, 'sha512', 'base64')}`;
    if (observed !== integrity) throw new Error('The downloaded npm tarball failed registry SHA-512 verification.');
    return observed;
}

function tarNumber(bytes) {
    const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported tar numeric field.');
    const number = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(number)) throw new Error('Oversized tar numeric field.');
    return number;
}

function paxFields(bytes) {
    const fields = {};
    for (let offset = 0; offset < bytes.length;) {
        const space = bytes.indexOf(32, offset);
        const lengthText = bytes.subarray(offset, space).toString('ascii');
        if (space < offset || !/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Malformed tar PAX header.');
        const length = Number(lengthText);
        const end = offset + length;
        if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) {
            throw new Error('Malformed tar PAX record.');
        }
        const record = bytes.subarray(space + 1, end - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals <= 0) throw new Error('Malformed tar PAX key.');
        fields[record.slice(0, equals)] = record.slice(equals + 1);
        offset = end;
    }
    return fields;
}

export function readTarball(compressed) {
    // Read members in memory; never extract archive paths or links onto the runner.
    const bytes = gunzipSync(compressed, { maxOutputLength: 128_000_000 });
    const files = new Map();
    let pending = {};
    let terminated = false;
    for (let offset = 0; offset + 512 <= bytes.length;) {
        const header = bytes.subarray(offset, offset + 512);
        if (header.every((value) => value === 0)) {
            if (bytes.subarray(offset).some((value) => value !== 0)) throw new Error('Unexpected data after the tar archive terminator.');
            terminated = true;
            break;
        }
        const expected = tarNumber(header.subarray(148, 156));
        const observed = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
        if (expected !== observed) throw new Error('Invalid tar header checksum.');
        const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '');
        const size = tarNumber(header.subarray(124, 136));
        const type = String.fromCharCode(header[156]);
        const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
        const start = offset + 512;
        const end = start + size;
        if (end > bytes.length) throw new Error('Truncated tar member.');
        const data = bytes.subarray(start, end);
        offset = start + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            pending = paxFields(data);
            continue;
        }
        if (type === 'g') {
            const global = paxFields(data);
            if (global.path || global.linkpath || global.size) throw new Error('Unsupported global tar paths or sizes.');
            continue;
        }
        if (pending.linkpath || (pending.size && Number(pending.size) !== size)) throw new Error('Unsupported tar link or size override.');
        const path = (pending.path || name).replace(/\/$/, '');
        pending = {};
        if (path !== 'package' && (!path.startsWith('package/') || posix.normalize(path) !== path
            || path.includes('\\') || path.includes('\0'))) throw new Error('Unsafe npm tarball path.');
        if (type === '5') continue;
        if (type !== '0' && type !== '\0') throw new Error('Links and special files are not allowed in npm release tarballs.');
        if (path === 'package' || files.has(path)) throw new Error('Duplicate or invalid npm tarball member.');
        files.set(path, data);
    }
    if (!terminated || Object.keys(pending).length) throw new Error('Incomplete npm tarball.');
    return files;
}

function validateUpstream(upstream) {
    if (typeof upstream?.version !== 'string') throw new Error('Upstream ExifTool versions must retain their exact X.YY string.');
    parseUpstreamVersion(upstream?.version);
    revision(upstream.revision, 'ExifTool');
    if (!/^[a-f0-9]{64}$/.test(upstream.sha256 ?? '')
        || upstream.url !== `https://sourceforge.net/projects/exiftool/files/Image-ExifTool-${upstream.version}.tar.gz`) {
        throw new Error('Invalid upstream archive identity.');
    }
}

function validateManifest(manifest, version) {
    if (manifest?.schemaVersion !== 1 || manifest.package?.name !== PACKAGE_NAME
        || manifest.package.version !== packageVersion(version)) throw new Error('Invalid published build manifest identity.');
    validateUpstream(manifest.upstream);
    revision(manifest.build?.sourceRevision, 'source');
    revision(manifest.build?.zeroperlRevision, 'zeroperl');
    revision(manifest.build?.zeroperlTsRevision, 'zeroperl-ts');
    if (!/^5\.[0-9]+\.[0-9]+$/.test(manifest.build.perlVersion ?? '')) throw new Error('Invalid Perl version.');
    for (const [name, path] of [['script', 'src/exiftool'], ['wasm', 'src/zeroperl/zeroperl.wasm']]) {
        const artifact = manifest.artifacts?.[name];
        if (artifact?.path !== path || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
            || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new Error(`Invalid ${name} artifact provenance.`);
    }
    if (!Array.isArray(manifest.distribution) || !manifest.distribution.length) throw new Error('Missing packed distribution hashes.');
}

function verifyManifestFiles(manifest, files) {
    const paths = new Set();
    for (const artifact of manifest.distribution) {
        if (typeof artifact.path !== 'string' || !artifact.path.startsWith('dist/esm/')
            || posix.normalize(artifact.path) !== artifact.path || paths.has(artifact.path)) throw new Error('Invalid distribution path.');
        paths.add(artifact.path);
        const bytes = files.get(`package/${artifact.path}`);
        if (!bytes || bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw new Error(`Published artifact mismatch: ${artifact.path}`);
    }
    const packedPaths = [...files.keys()].filter((path) => path.startsWith('package/dist/')).map((path) => path.slice(8)).sort();
    if (!isDeepStrictEqual([...paths].sort(), packedPaths)) throw new Error('The npm distribution contains unrecorded or missing files.');
    const wasm = manifest.distribution.filter((artifact) => artifact.path.endsWith('.wasm'));
    if (!paths.has('dist/esm/index.js') || wasm.length !== 1
        || wasm[0].bytes !== manifest.artifacts.wasm.bytes || wasm[0].sha256 !== manifest.artifacts.wasm.sha256) {
        throw new Error('The packed bundle and paired WASM do not match the source manifest.');
    }
}

async function publishedPackage(record, version, fetch, environment) {
    if (record?.name !== PACKAGE_NAME || record.version !== version) throw new Error('Unexpected registry package identity.');
    const url = record.dist?.tarball;
    const parsed = requireHttps(url, 'registry.npmjs.org');
    if (parsed.pathname !== `/@colorhythm/exiftool-wasm/-/exiftool-wasm-${version}.tgz`) throw new Error('Unexpected registry tarball path.');
    const bytes = await request(url, fetch, environment);
    const integrity = verifyIntegrity(bytes, record.dist.integrity);
    const files = readTarball(bytes);
    const packageBytes = files.get('package/package.json');
    if (!packageBytes) throw new Error('The registry tarball has no package.json.');
    const metadata = JSON.parse(packageBytes);
    if (metadata.name !== PACKAGE_NAME || metadata.version !== version) throw new Error('The packed package identity differs from the registry.');
    const manifestBytes = files.get('package/exiftool-build.json');
    const manifest = manifestBytes ? JSON.parse(manifestBytes) : null;
    if (manifest) {
        validateManifest(manifest, version);
        verifyManifestFiles(manifest, files);
    }
    return { bytes, files, integrity, manifest, manifestBytes, url };
}

async function upstreamRevision(version, fetch, environment) {
    const base = 'https://api.github.com/repos/exiftool/exiftool/git';
    const reference = JSON.parse(await request(`${base}/ref/tags/${version}`, fetch, environment));
    if (reference.ref !== `refs/tags/${version}`) throw new Error('The GitHub tag does not match the selected ExifTool release.');
    let object = reference.object;
    const seen = new Set();
    for (let count = 0; count < 5; count += 1) {
        revision(object?.sha, 'ExifTool tag');
        if (object.type === 'commit') return object.sha;
        if (object.type !== 'tag' || seen.has(object.sha)) throw new Error('The upstream tag does not resolve to a commit.');
        seen.add(object.sha);
        object = JSON.parse(await request(`${base}/tags/${object.sha}`, fetch, environment)).object;
    }
    throw new Error('The upstream annotated tag chain is too deep.');
}

export async function planRelease({ root = ROOT, fetch = globalThis.fetch, version, environment = process.env } = {}) {
    const metadata = JSON.parse(await readFile(resolve(root, 'package.json')));
    if (metadata.name !== PACKAGE_NAME) throw new Error('Unexpected local package identity.');
    packageVersion(metadata.version);
    const localBytes = await readFile(resolve(root, 'exiftool-build.json')).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    const localManifest = localBytes ? JSON.parse(localBytes) : null;
    if (localManifest) validateManifest(localManifest, metadata.version);
    const selected = parseUpstreamVersion(String(version ?? '').trim() || (await request('https://exiftool.org/ver.txt', fetch, environment)).toString());
    const upstream = {
        version: selected,
        url: `https://sourceforge.net/projects/exiftool/files/Image-ExifTool-${selected}.tar.gz`,
        sha256: parseChecksum((await request('https://exiftool.org/checksums.txt', fetch, environment)).toString(), selected),
        revision: await upstreamRevision(selected, fetch, environment),
    };
    const registry = JSON.parse(await request(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}`, fetch, environment));
    const latestVersion = packageVersion(registry['dist-tags']?.latest);
    const stableVersions = Object.keys(registry.versions ?? {}).filter((value) => /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value)).sort(compareVersions);
    const highestVersion = stableVersions.at(-1);
    if (!highestVersion || !registry.versions[latestVersion]) throw new Error('The registry has no stable latest package.');
    const published = [];
    for (const candidate of [...new Set([highestVersion, latestVersion])]) {
        published.push({ version: candidate, ...await publishedPackage(registry.versions[candidate], candidate, fetch, environment) });
    }
    for (const value of [...published.map((item) => item.manifest), localManifest].filter(Boolean)) {
        if (compareVersions(value.upstream.version, selected) > 0) throw new Error('Refusing to downgrade the recorded ExifTool release.');
        if (value.upstream.version === selected && !isDeepStrictEqual(value.upstream, upstream)) {
            throw new Error('An existing ExifTool release has different archive or Git provenance; manual review is required.');
        }
    }
    const completed = published.find((item) => item.manifest?.upstream.version === selected);
    const maximum = compareVersions(metadata.version, highestVersion) > 0 ? metadata.version : highestVersion;
    const pending = localManifest?.upstream.version === selected && compareVersions(metadata.version, highestVersion) > 0;
    return {
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        packageVersion: completed?.version ?? (pending ? metadata.version : nextPatch(maximum)),
        shouldBuild: !completed,
        shouldRecover: Boolean(completed && localBytes?.equals(completed.manifestBytes)),
        reason: completed ? 'verified-registry-publication' : pending ? 'retry-unpublished-candidate' : 'unpublished-upstream-release',
        registry: { latestVersion, highestVersion, publishedVersion: completed?.version ?? null },
        upstream,
    };
}

function validatePlan(plan) {
    if (plan?.schemaVersion !== 1 || plan.packageName !== PACKAGE_NAME) throw new Error('Invalid release plan.');
    packageVersion(plan.packageVersion);
    validateUpstream(plan.upstream);
}

async function describe(root, path) {
    const bytes = await readFile(resolve(root, path));
    return { path, bytes: bytes.length, sha256: digest(bytes) };
}

async function distributionPaths(root, path = 'dist/esm') {
    const paths = [];
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...await distributionPaths(root, child));
        else if (entry.isFile()) paths.push(child);
        else throw new Error(`The distribution may only contain regular files: ${child}`);
    }
    return paths.sort();
}

export async function finalizeRelease({ root = ROOT, plan, zeroperlRevision, zeroperlTsRevision, perlVersion, sourceRevision, runUrl }) {
    validatePlan(plan);
    const metadata = JSON.parse(await readFile(resolve(root, 'package.json')));
    if (metadata.name !== PACKAGE_NAME || metadata.version !== plan.packageVersion) throw new Error('Set the planned package version before building and finalizing.');
    const script = await readFile(resolve(root, 'src/exiftool'));
    const versions = [...script.toString().matchAll(/(?:^|\n)(?:my\s+)?\$(?:version|VERSION)\s*=\s*['"]([0-9]+\.[0-9]{2})['"]/g)];
    if (versions.length !== 1 || versions[0][1] !== plan.upstream.version) throw new Error('The source ExifTool script does not match the release plan.');
    const wasm = await readFile(resolve(root, 'src/zeroperl/zeroperl.wasm'));
    if (wasm.length <= 8 || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('The paired source WASM is invalid.');
    const paths = await distributionPaths(root);
    const distribution = await Promise.all(paths.map((path) => describe(root, path)));
    const manifest = {
        schemaVersion: 1,
        package: { name: PACKAGE_NAME, version: plan.packageVersion },
        upstream: structuredClone(plan.upstream),
        build: {
            perlVersion,
            runUrl,
            sourceRevision: revision(sourceRevision, 'source'),
            zeroperlRevision: revision(zeroperlRevision, 'zeroperl'),
            zeroperlTsRevision: revision(zeroperlTsRevision, 'zeroperl-ts'),
        },
        artifacts: {
            script: await describe(root, 'src/exiftool'),
            wasm: await describe(root, 'src/zeroperl/zeroperl.wasm'),
        },
        distribution,
    };
    const run = requireHttps(runUrl, 'github.com');
    if (!/^\/colorhythm\/exiftool-wasm\/actions\/runs\/[0-9]+$/.test(run.pathname)) throw new Error('Expected this repository’s GitHub Actions run URL.');
    validateManifest(manifest, plan.packageVersion);
    const files = new Map(await Promise.all(paths.map(async (path) => [`package/${path}`, await readFile(resolve(root, path))])));
    verifyManifestFiles(manifest, files);
    const readmePath = resolve(root, 'README.md');
    const readme = updateReadmeVersion(await readFile(readmePath, 'utf8'), plan.upstream.version, plan.packageVersion);
    await writeFile(readmePath, readme);
    await writeFile(resolve(root, 'exiftool-build.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    return manifest;
}

export async function verifyReceipt({ root = ROOT, plan, tarball, fetch = globalThis.fetch, environment = process.env }) {
    validatePlan(plan);
    const localBytes = await readFile(resolve(root, 'exiftool-build.json'));
    const localManifest = JSON.parse(localBytes);
    validateManifest(localManifest, plan.packageVersion);
    if (!isDeepStrictEqual(localManifest.upstream, plan.upstream)) throw new Error('The committed manifest does not match the release plan.');
    const record = JSON.parse(await request(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/${plan.packageVersion}`, fetch, environment));
    const published = await publishedPackage(record, plan.packageVersion, fetch, environment);
    if (!published.manifestBytes?.equals(localBytes)) throw new Error('The npm tarball manifest differs from the committed candidate manifest.');
    if (tarball) {
        const tested = await readFile(resolve(root, tarball));
        if (!tested.equals(published.bytes)) throw new Error('The published tarball differs from the exact tested tarball.');
    }
    return {
        schemaVersion: 1,
        status: 'verified',
        package: localManifest.package,
        upstream: localManifest.upstream,
        manifestSha256: digest(localBytes),
        tarball: { bytes: published.bytes.length, integrity: published.integrity, url: published.url },
        distribution: localManifest.distribution,
        testedTarballMatched: Boolean(tarball),
    };
}

export async function verifyReceiptWithRetry(options, {
    attempts = RECEIPT_MAX_ATTEMPTS,
    delayMs = 10000,
    onRetry = () => {},
    sleep = (duration) => new Promise((resolve_) => setTimeout(resolve_, duration)),
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > RECEIPT_MAX_ATTEMPTS || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
        throw new Error('Invalid bounded receipt retry settings.');
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await verifyReceipt(options);
        } catch (error) {
            if (!error.retryable || attempt === attempts) throw error;
            onRetry(attempt, error);
            await sleep(delayMs);
        }
    }
}

async function saveOutput(path, value) {
    const content = `${JSON.stringify(value, null, 4)}\n`;
    if (path) {
        await mkdir(dirname(resolve(path)), { recursive: true });
        await writeFile(path, content);
    }
    process.stdout.write(content);
}

async function main() {
    const [command, ...arguments_] = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < arguments_.length; index += 2) {
        const name = arguments_[index];
        const value = arguments_[index + 1];
        if (!/^--[a-z-]+$/.test(name) || value === undefined || value.startsWith('--') || name in options) throw new Error('Expected distinct --option value pairs.');
        options[name] = value;
    }
    const allowed = {
        finalize: ['--output', '--perl-version', '--plan', '--run-url', '--source-revision', '--zeroperl-revision', '--zeroperl-ts-revision'],
        plan: ['--github-output', '--output', '--version'],
        receipt: ['--attempts', '--delay-ms', '--output', '--plan', '--tarball'],
    };
    if (!allowed[command] || Object.keys(options).some((name) => !allowed[command].includes(name))) throw new Error('Usage: release.mjs plan|finalize|receipt [options].');
    let result;
    if (command === 'plan') {
        result = await planRelease({ version: options['--version'] });
        if (options['--github-output']) {
            const outputs = {
                package_version: result.packageVersion,
                sha256: result.upstream.sha256,
                should_build: result.shouldBuild,
                should_recover: result.shouldRecover,
                upstream_revision: result.upstream.revision,
                upstream_url: result.upstream.url,
                version: result.upstream.version,
            };
            await appendFile(options['--github-output'], Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
        }
    } else {
        if (!options['--plan']) throw new Error('A saved --plan is required.');
        const plan = JSON.parse(await readFile(options['--plan']));
        if (command === 'finalize') {
            result = await finalizeRelease({
                plan,
                perlVersion: options['--perl-version'],
                runUrl: options['--run-url'],
                sourceRevision: options['--source-revision'],
                zeroperlRevision: options['--zeroperl-revision'],
                zeroperlTsRevision: options['--zeroperl-ts-revision'],
            });
        } else {
            result = await verifyReceiptWithRetry({ plan, tarball: options['--tarball'] }, {
                attempts: Number(options['--attempts'] ?? RECEIPT_MAX_ATTEMPTS),
                delayMs: Number(options['--delay-ms'] ?? 10000),
                onRetry: (attempt, error) => console.error(`Receipt attempt ${attempt} is temporarily unavailable: ${error.message}`),
            });
        }
    }
    await saveOutput(options['--output'], result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
