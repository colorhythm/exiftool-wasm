import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const FIXTURES = [
    'Canon.jpg',
    'DNG.dng',
    'ExifTool.tif',
    'ICC_Profile.icc',
    'Jpeg2000.jp2',
    'MP3.mp3',
    'Nikon.jpg',
    'PDF.pdf',
    'PNG.png',
    'QuickTime.heic',
    'QuickTime.mov',
    'RIFF.webp',
    'XMP.xmp',
];

function normalize(row) {
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'SourceFile' && !key.startsWith('System:')));
}

export async function compareNative(api, { expectedVersion, source }) {
    const args = ['-json', '-a', '-s', '-n', '-G1'];
    const environment = { ...process.env };
    delete environment.PERL5LIB;
    delete environment.PERL5OPT;
    const native = (arguments_) => execFileSync('perl', [join(source, 'exiftool'), ...arguments_], {
        encoding: 'utf8',
        env: environment,
        maxBuffer: 8 * 1024 * 1024,
    });
    const nativeVersion = native(['-ver']).trim();
    if (nativeVersion !== expectedVersion) throw new Error(`Native source version ${nativeVersion} differs from expected ${expectedVersion}.`);
    const report = {
        args,
        cases: [],
        excludedFields: ['SourceFile', 'System:* (host filesystem metadata)'],
        expectedVersion,
        nativePerl: execFileSync('perl', ['-e', 'print $^V'], { encoding: 'utf8', env: environment }),
        nativeVersion,
    };
    try {
        for (const name of FIXTURES) {
            const path = join(source, 't/images', name);
            const bytes = await readFile(path);
            const reference = normalize(JSON.parse(native([...args, path]))[0]);
            const result = await api.parseMetadata({ name, data: new Uint8Array(bytes) }, { args });
            const observed = result.success ? normalize(JSON.parse(result.data)[0]) : null;
            const differences = observed ? [...new Set([...Object.keys(reference), ...Object.keys(observed)])]
                .filter((key) => !isDeepStrictEqual(reference[key], observed[key]))
                .map((key) => ({ key, native: reference[key], wasm: observed[key] })) : [];
            // Do not exempt character-set fields: QuickTime.mov detects missing MacRoman tables.
            const entry = {
                fieldCount: Object.keys(reference).length,
                name,
                passed: result.success && differences.length === 0,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                ...(result.success ? { differences } : { error: result.error }),
            };
            report.cases.push(entry);
            console.log(`${entry.passed ? 'PASS' : 'FAIL'} native parity ${name}: ${entry.fieldCount} fields`);
        }
        report.passed = report.cases.every((entry) => entry.passed);
    } finally {
        await api.dispose();
    }
    return report;
}
