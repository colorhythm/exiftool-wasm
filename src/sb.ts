/**
 * A lightweight StringBuilder
 */
export class StringBuilder {
  private parts: string[];

  /**
   * Creates a new StringBuilder instance
   * @param initialValue Optional initial string value
   */
  constructor(initialValue = "") {
    this.parts = initialValue ? [initialValue] : [];
  }

  /**
   * Appends a string to the builder
   * @param str The string to append
   * @returns The StringBuilder instance for chaining
   */
  append(str: string): StringBuilder {
    this.parts.push(str);
    return this;
  }

  /**
 * Clears all content from the builder
 * @returns The StringBuilder instance for chaining
 */
  clear(): StringBuilder {
    this.parts = [];
    return this;
  }

  /**
   * Appends a string followed by a newline character
   * @param str The string to append
   * @returns The StringBuilder instance for chaining
   */
  appendLine(str = ""): StringBuilder {
    this.parts.push(`${str}\n`);
    return this;
  }

  /**
   * Returns the current length of the string
   */
  get length(): number {
    return this.toString().length;
  }

  /**
   * Converts the StringBuilder to a string
   * @returns The built string
   */
  toString(): string {
    return this.parts.join("");
  }

  /**
   * Checks if a string contains or ends with line breaks
   * @param str The string to check
   * @returns True if the string contains any line breaks
   */
  static isMultiline(str: string): boolean {
    // Count all line breaks in the string
    let lineBreakCount = 0;

    for (let i = 0; i < str.length; i++) {
      // Check for \n (Line Feed)
      if (str[i] === "\n") {
        lineBreakCount++;
      }
      // Check for \r (Carriage Return) not followed by \n (to avoid double counting \r\n)
      else if (
        str[i] === "\r" &&
        (i === str.length - 1 || str[i + 1] !== "\n")
      ) {
        lineBreakCount++;
      }
    }

    return lineBreakCount > 0;
  }
}

/**
 * A lightweight byte accumulator for raw stdout/stderr capture.
 *
 * Chunks are stored as-is and only joined (and, for text consumers,
 * decoded) once at the end. Decoding the CONCATENATED buffer in one
 * pass — rather than per-chunk — is what keeps multi-byte UTF-8
 * sequences that straddle a chunk boundary intact, and what keeps
 * binary payloads (exiftool -b) byte-exact.
 */
export class ByteBuilder {
  private chunks: Uint8Array[] = [];
  private decoder = new TextDecoder("utf-8");
  private encoder = new TextEncoder();

  /**
   * Appends a chunk. Strings are encoded to UTF-8 bytes so mixed
   * producers still accumulate into one coherent byte stream.
   * @returns The ByteBuilder instance for chaining
   */
  append(chunk: Uint8Array | string): ByteBuilder {
    this.chunks.push(
      typeof chunk === "string" ? this.encoder.encode(chunk) : chunk,
    );
    return this;
  }

  /**
   * Clears all accumulated bytes
   * @returns The ByteBuilder instance for chaining
   */
  clear(): ByteBuilder {
    this.chunks = [];
    return this;
  }

  /**
   * Total accumulated size in bytes
   */
  get byteLength(): number {
    return this.chunks.reduce((acc, c) => acc + c.byteLength, 0);
  }

  /**
   * Returns the accumulated bytes as a single Uint8Array
   */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  /**
   * Decodes the accumulated bytes as UTF-8 text (single-pass decode)
   */
  toString(): string {
    return this.decoder.decode(this.toBytes());
  }
}
