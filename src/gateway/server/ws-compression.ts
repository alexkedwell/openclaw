import { kMaxLength } from "node:buffer";
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from "node:zlib";
import type { WebSocket } from "ws";
import { gatewayReceiver } from "./ws-receiver.js";

/**
 * Peers that offer permessage-deflate (browsers, ws, Foundation, OkHttp) get
 * frames from the threshold up compressed; others are unaffected. No context
 * takeover in either direction keeps every message independent, which the
 * per-connection codec below relies on.
 */
export const GATEWAY_PER_MESSAGE_DEFLATE = {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 16 * 1024,
};

type ZlibCallback = (error: Error | null, result?: Buffer) => void;
type PerMessageDeflateCodec = {
  params: Record<string, unknown>;
  compress(data: Buffer | string, fin: boolean, callback: ZlibCallback): void;
  decompress(data: Buffer, fin: boolean, callback: ZlibCallback): void;
};

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const EMPTY = Buffer.alloc(0);
const Z_SYNC_FLUSH = zlibConstants.Z_SYNC_FLUSH;
const DEFLATE_LEVEL = 1;

function isPerMessageDeflateCodec(value: unknown): value is PerMessageDeflateCodec {
  const codec = value as Partial<PerMessageDeflateCodec> | undefined;
  return (
    typeof codec?.compress === "function" &&
    typeof codec.decompress === "function" &&
    typeof codec.params === "object" &&
    codec.params !== null
  );
}

/**
 * Replaces ws's streaming zlib path on a negotiated connection with one inline
 * zlib call per message. ws's streams need a threadpool round trip, and so a
 * busy event-loop turn, per call and per 16 KiB of output while the socket
 * stops parsing or sending; inline level-1 zlib costs about 3 ms per MiB
 * deflated and less inflated. Returns false when the peer negotiated
 * compression but the ws extension no longer has the expected shape; ws then
 * keeps its slower path.
 */
export function installGatewayDeflateCodec(socket: WebSocket): boolean {
  // SAFETY: ws owns the negotiated extension; validate its shape before replacing methods.
  const codec = (socket as WebSocket & { _extensions?: Record<string, unknown> })["_extensions"]?.[
    "permessage-deflate"
  ];
  if (codec === undefined) {
    return true;
  }
  const receiver = gatewayReceiver(socket);
  if (
    !receiver ||
    !isPerMessageDeflateCodec(codec) ||
    codec.params.client_no_context_takeover !== true ||
    codec.params.server_no_context_takeover !== true
  ) {
    return false;
  }
  const streamDecompress = codec.decompress.bind(codec);
  const streamCompress = codec.compress.bind(codec);
  // Never call back synchronously: ws would re-enter its frame loop. Admitted
  // operators parse a whole burst in one turn; other receivers yield one turn
  // per message, matching uncompressed delivery.
  const deliver = (callback: ZlibCallback, result: Buffer) => {
    if (receiver["_allowSynchronousEvents"] === true) {
      process.nextTick(callback, null, result);
    } else {
      setImmediate(callback, null, result);
    }
  };

  let inbound: Buffer[] = [];
  codec.decompress = (data, fin, callback) => {
    inbound.push(data);
    if (!fin) {
      deliver(callback, EMPTY);
      return;
    }
    const input = Buffer.concat([...inbound, TRAILER]);
    inbound = [];
    let output: Buffer;
    try {
      output = inflateRawSync(input, {
        finishFlush: Z_SYNC_FLUSH,
        // ws treats 0 as unlimited; the limit bounds the inflated size.
        maxOutputLength: receiver["_maxPayload"] || kMaxLength,
      });
    } catch {
      // ws's own path reproduces its canonical error and close code (1007/1009).
      streamDecompress(input.subarray(0, -TRAILER.length), true, callback);
      return;
    }
    deliver(callback, output);
  };

  let fragmentedSend = false;
  codec.compress = (data, fin, callback) => {
    if (fragmentedSend || !fin) {
      fragmentedSend = !fin;
      streamCompress(data, fin, callback);
      return;
    }
    const output = deflateRawSync(data, { finishFlush: Z_SYNC_FLUSH, level: DEFLATE_LEVEL });
    // Z_SYNC_FLUSH ends with the empty block that permessage-deflate strips.
    process.nextTick(callback, null, output.subarray(0, -TRAILER.length));
  };
  return true;
}
