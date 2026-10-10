/**
 * PLATFORM GLOBALS, DECLARED NARROWLY FOR TESTS AND FIXTURES.
 *
 * The contract compiles with `lib: ES2023` and no DOM or Node types so it stays platform-free: the
 * service and the browser both import it, and neither a `Buffer` nor an `atob` may leak into it. Tests
 * need a deflater to make a real PNG, so the one primitive they use is declared here, not widened.
 */
interface StreamReaderLike {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}
interface StreamWriterLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface TransformStreamLike {
  readonly readable: { getReader(): StreamReaderLike };
  readonly writable: { getWriter(): StreamWriterLike };
}
declare const CompressionStream: new (format: string) => TransformStreamLike;
