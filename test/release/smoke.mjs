function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function successful(result, operation) {
    assert(result.success, `${operation}: ${result.error ?? 'operation failed'}`);
    return result.data;
}

function equalBytes(actual, expected, label) {
    assert(actual instanceof Uint8Array, `${label}: output is not Uint8Array`);
    assert(actual.length === expected.length, `${label}: byte lengths differ`);
    for (let index = 0; index < actual.length; index += 1) {
        assert(actual[index] === expected[index], `${label}: mismatch at byte ${index}`);
    }
}

async function digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runSmoke(api, { customOnly = false, expectedVersion, fetchRuntime, fixture, scope, thumbnail }) {
    const cases = [];
    const original = fixture.slice();
    const file = new File([fixture], 'metadata-π.jpg', { type: 'image/jpeg' });
    const report = { cases, expectedVersion, scope };
    const options = (value = {}) => fetchRuntime ? { ...value, fetch: fetchRuntime } : value;
    const check = async (name, operation) => {
        const started = performance.now();
        try {
            const result = await operation();
            cases.push({ name, passed: true, durationMs: performance.now() - started, ...result });
        } catch (error) {
            cases.push({ name, passed: false, durationMs: performance.now() - started, error: error.message });
            throw error;
        }
    };
    try {
        await check('exact runtime version string', async () => {
            const text = successful(await api.parseMetadata(file, options({ args: ['-ver'] })), '-ver');
            // The wrapper appends a filename, so -ver is followed by file metadata.
            const value = text.split(/\r?\n/, 1)[0].trim();
            assert(value === expectedVersion, `Expected ${expectedVersion}, executing ${value}`);
            report.observedVersion = value;
            return { value };
        });
        if (customOnly) {
            report.passed = true;
            return report;
        }
        await check('default text output', async () => {
            const text = successful(await api.parseMetadata(file, options()), 'text');
            assert(/ExifTool Version Number/.test(text), 'No ExifTool version in text metadata');
            return { firstLine: text.split('\n')[0] };
        });
        await check('JSON metadata and numeric version representation', async () => {
            const text = successful(await api.parseMetadata(file, options({ args: ['-json', '-ExifToolVersion', '-ImageWidth', '-ImageHeight'] })), 'JSON');
            const row = JSON.parse(text)[0];
            assert(row.ExifToolVersion === Number(expectedVersion), 'JSON runtime version differs');
            assert(row.ImageWidth === 300 && row.ImageHeight === 400, 'Unexpected fixture dimensions');
            return { height: row.ImageHeight, numericVersion: row.ExifToolVersion, width: row.ImageWidth };
        });
        await check('config-first user-defined composite', async () => {
            const config = `%Image::ExifTool::UserDefined = (
    'Image::ExifTool::Composite' => {
        ConfigProof => {
            Require => 'ImageWidth',
            ValueConv => '$val * 2',
        },
    },
);
1;
`;
            const text = successful(await api.parseMetadata(file, options({
                args: ['-json', '-ImageWidth', '-ConfigProof', '-m', '-q'],
                config: new File([config], 'proof.config'),
            })), 'config');
            const row = JSON.parse(text)[0];
            assert(row.ConfigProof === row.ImageWidth * 2, 'User-defined composite did not load');
            return { configProof: row.ConfigProof };
        });
        let binary;
        await check('raw binary extraction equals golden bytes and ignores transform', async () => {
            let transformCalls = 0;
            binary = successful(await api.parseMetadata(file, options({
                args: ['-b', '-ThumbnailImage', '-m', '-q'],
                binary: true,
                transform: () => {
                    transformCalls += 1;
                    throw new Error('Text transform must not run in binary mode');
                },
            })), 'binary');
            equalBytes(binary, thumbnail, 'ThumbnailImage');
            assert(transformCalls === 0, 'Binary mode called the text transform');
            return { byteLength: binary.length, sha256: await digest(binary), transformCalls };
        });
        await check('base64 extraction equals raw bytes', async () => {
            const text = successful(await api.parseMetadata(file, options({ args: ['-json', '-b', '-ThumbnailImage', '-m', '-q'] })), 'base64');
            const value = JSON.parse(text)[0].ThumbnailImage;
            assert(value.startsWith('base64:'), 'Missing base64 prefix');
            const decoded = Uint8Array.from(atob(value.slice(7)), (character) => character.charCodeAt(0));
            equalBytes(decoded, binary, 'Base64/raw parity');
            return { byteLength: decoded.length };
        });
        await check('Unicode write/read roundtrip preserves original input', async () => {
            const title = 'WASM proof Ω 日本語';
            const written = successful(await api.writeMetadata({ name: 'input-π.jpg', data: fixture }, { 'XMP-dc:Title': title }, options()), 'write');
            const text = successful(await api.parseMetadata({ name: 'written.jpg', data: new Uint8Array(written) }, options({ args: ['-json', '-XMP-dc:Title'] })), 'read written');
            assert(JSON.parse(text)[0].Title === title, 'Unicode title failed roundtrip');
            equalBytes(fixture, original, 'Original input ownership');
            return { inputPreserved: true, outputBytes: written.byteLength, title };
        });
        report.passed = true;
    } catch (error) {
        report.error = error.stack ?? String(error);
        report.passed = false;
    } finally {
        await api.dispose();
    }
    return report;
}
