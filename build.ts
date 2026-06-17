await Bun.build({
    entrypoints: ['src/index.ts'],
    format: 'esm',
    loader: { '.wasm': 'file' as const },
    minify: true,
    naming: '[name].js',
    outdir: 'dist/esm',
    sourcemap: 'inline',
    target: 'browser',
});

export {};
