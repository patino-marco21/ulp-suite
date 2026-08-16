export class MaxBytesExceededError extends Error {
  constructor(public limitBytes: number) {
    super(`request body exceeded ${limitBytes} bytes`)
    this.name = 'MaxBytesExceededError'
  }
}

/**
 * Wrap a request body stream with a running byte-count cap, enforced against
 * bytes actually seen — not the client-supplied Content-Length header, which
 * is only a pre-flight claim: it can be omitted entirely (legal with chunked
 * transfer-encoding, and then any pre-check that gates on `contentLength &&`
 * is silently skipped) or simply not match what the client actually sends.
 * Errors the stream once limitBytes is exceeded, which both Readable.fromWeb
 * (Node pipeline consumers) and direct async-iteration (processTextStream)
 * surface as a normal stream error carrying this MaxBytesExceededError.
 */
export function capWebStream(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > limitBytes) {
          controller.error(new MaxBytesExceededError(limitBytes))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}
