const result = await Bun.build({
    entrypoints: ['src/index.ts'],
    format: 'esm',
    loader: { '.wasm': 'file' as const },
    minify: true,
    naming: '[name].js',
    outdir: 'dist/esm',
    sourcemap: 'inline',
    target: 'browser',
});

if (!result.success) {
    throw new AggregateError(result.logs, 'The ExifTool bundle failed to build.');
}

export {};
