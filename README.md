# @colorhythm/exiftool-wasm

[ExifTool](https://exiftool.org) powered by WebAssembly to extract and write metadata from files in browsers and Node.js environments using [zeroperl](https://github.com/colorhythm/zeroperl).

## Installation

```
npm install @colorhythm/exiftool-wasm
```

## Description

This package provides a WebAssembly-based implementation of ExifTool that works in both browser and Node.js environments. It leverages [zeroperl](https://github.com/colorhythm/zeroperl) to execute ExifTool without requiring any native binaries or system dependencies.

## Usage

### Basic Usage

```typescript
import { parseMetadata } from '@colorhythm/exiftool-wasm';

// Browser usage with File API
document.querySelector('input[type="file"]').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const result = await parseMetadata(file);

  if (result.success) {
    console.log(result.data);
  } else {
    console.error('Error:', result.error);
  }
});
```

### Writing Metadata

```typescript
import { writeMetadata } from '@colorhythm/exiftool-wasm';

const result = await writeMetadata(file, {
  'Author': 'John Doe',
  'Title': 'My Photo',
  'Keywords': 'nature,photography'
});

if (result.success) {
  // result.data contains the modified file as Uint8Array
  const modifiedBlob = new Blob([result.data]);
}
```

### Extracting Specific Metadata

```typescript
import { parseMetadata } from '@colorhythm/exiftool-wasm';

const result = await parseMetadata(file, {
  args: ['-Author', '-CreateDate', '-Make', '-Model']
});

if (result.success) {
  console.log(result.data);
}
```

### JSON Output

```typescript
import { parseMetadata } from '@colorhythm/exiftool-wasm';

const result = await parseMetadata(file, {
  args: ['-json', '-n'],
  transform: (data) => JSON.parse(data)
});

if (result.success) {
  // Typed access to properties
  console.log(result.data); // { ... }
}
```

### Extracting Embedded Binaries

Pass `binary: true` to receive stdout as a raw `Uint8Array` — required for
ExifTool's `-b` output (embedded thumbnails/previews, MPF images and HDR
gain maps, depth maps, ICC profiles, trailer payloads), which is not UTF-8
and would be corrupted by text decoding.

```typescript
import { parseMetadata } from '@colorhythm/exiftool-wasm';

const result = await parseMetadata(file, {
  // -m ignores minor warnings, -q suppresses info messages — recommended,
  // since any stderr output is treated as failure.
  args: ['-b', '-ThumbnailImage', '-m', '-q'],
  binary: true,
});

if (result.success) {
  const blob = new Blob([result.data], { type: 'image/jpeg' });
  // result.data is a byte-exact Uint8Array
}
```

Notes:

- `transform` is not applied in binary mode.
- Extracting multiple `-b` tags in one call concatenates their bytes on
  stdout with no delimiter — extract one tag per call, or use
  `args: ['-json', '-b', ...]` (without `binary`) to get each tag as a
  `base64:`-prefixed string in JSON.

## Important Notes

- In browser environments, pass the `File` object directly from file inputs. Do not convert it to an ArrayBuffer or Uint8Array.
- This package uses asynchronous web APIs for file processing which allows handling files over 2GB without loading them entirely into memory.
- ExifTool is executed entirely within the browser or Node.js environment - no server requests are made for metadata extraction.

## API Reference

### parseMetadata()

```typescript
async function parseMetadata<TReturn = string>(
  file: Binaryfile | File,
  options: ExifToolOptions<TReturn> = {}
): Promise<ExifToolOutput<TReturn>>
```

#### Parameters

- `file`: Either a browser `File` object or a `Binaryfile` object with `name` and `data` properties.
- `options`: Configuration options for the metadata extraction.

### writeMetadata()

```typescript
async function writeMetadata(
  file: Binaryfile | File,
  tags: ExifTags,
  options: ExifToolOptions = {}
): Promise<ExifToolOutput<ArrayBuffer>>
```

#### Parameters

- `file`: Either a browser `File` object or a `Binaryfile` object with `name` and `data` properties.
- `tags`: Object containing metadata tags to write, where keys are tag names and values are tag values.
- `options`: Configuration options for the write operation.

#### Return Value

Returns a Promise that resolves to an `ExifToolOutput` object:

```typescript
type ExifToolOutput<TOutput> =
  | {
      success: true;
      data: TOutput;
      error: string;
      exitCode: 0;
    }
  | {
      success: false;
      data: undefined;
      error: string;
      exitCode: number | undefined;
    };
```

## Acknowledgements

This package stands on the shoulders of three projects, with our thanks:

- **[ExifTool](https://exiftool.org)** by **Phil Harvey** — three decades
  of metadata craft; everything here is a delivery mechanism for his work.
- **[uswriting/exiftool](https://github.com/uswriting/exiftool)** by
  **Andrew Sampson** — the original ExifTool-in-WebAssembly wrapper this
  package is forked from.
- **[zeroperl](https://github.com/6over3/zeroperl)** (6over3 / Andrew
  Sampson) — the sandboxed Perl-to-WASI runtime that makes running
  ExifTool in a browser possible at all.

Our fork adds byte-safe binary extraction (`binary: true`), Worker-scope
support, `-config`-first handling, and packaging fixes — see the commit
history.

## License

Apache License, Version 2.0
