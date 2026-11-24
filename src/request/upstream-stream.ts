import { NEXT, type Anthropic, type Handle, type NextAnswer, type Stream } from "../contract.js";

const NOTHING = new Uint8Array(0);

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * An upstream event stream read as IR events: each piece of the body goes through `anthropic`'s stream decoder, and
 * the events it completes are handed out one per `next`, never the body buffered whole.
 */
export class UpstreamStream implements Stream {
  readonly #anthropic: Anthropic;
  readonly #decoder: Handle;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #upstream: AbortController;
  readonly #pending: unknown[] = [];
  #finished = false;
  #released = false;

  constructor(anthropic: Anthropic, decoder: Handle, body: ReadableStream<Uint8Array>, upstream: AbortController) {
    this.#anthropic = anthropic;
    this.#decoder = decoder;
    this.#reader = body.getReader();
    this.#upstream = upstream;
  }

  /** The next event, the end once the body ended and every event went out, or why the stream broke. */
  async next(): Promise<NextAnswer> {
    try {
      while (this.#pending.length === 0 && !this.#finished) await this.#readMore();
    } catch (cause) {
      this.release();
      return { kind: NEXT.FAILURE, failure: `the upstream stream broke: ${messageOf(cause)}` };
    }
    const event = this.#pending.shift();
    return event === undefined ? { kind: NEXT.END } : { kind: NEXT.EVENT, event };
  }

  /** Ends the upstream request when it has not ended, and frees the decoder; a second call does nothing. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#upstream.abort(new Error("the stream was released"));
    void this.#reader.cancel().catch(() => undefined);
    this.#decoder.release();
  }

  async #readMore(): Promise<void> {
    if (this.#released) throw new Error("the stream was released");
    const piece = await this.#reader.read();
    const argument = { decoder: this.#decoder, bytes: piece.done ? NOTHING : piece.value };
    const answer = piece.done ? await this.#anthropic.stream_decode_finish({ argument }) : await this.#anthropic.stream_decode({ argument });
    this.#pending.push(...answer.events);
    this.#finished = piece.done;
  }
}
