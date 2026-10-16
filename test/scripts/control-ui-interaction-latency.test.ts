import { describe, expect, it } from "vitest";
import { summarizeInteractionLatency } from "../../scripts/lib/control-ui-interaction-latency.ts";

describe("live interaction latency summary", () => {
  it("groups a pointer interaction and includes handlers sharing its quantized paint", () => {
    const result = summarizeInteractionLatency({
      steps: [{ kind: "menu", start: 100, end: 200, streamDeltas: 1, teamEvents: 1 }],
      events: [
        {
          name: "pointerdown",
          startTime: 110,
          duration: 64,
          processingStart: 112,
          processingEnd: 114,
          interactionId: 7,
        },
        {
          name: "click",
          startTime: 120,
          duration: 56,
          processingStart: 121,
          processingEnd: 160,
          interactionId: 7,
        },
      ],
      dispatches: [{ name: "pointerdown", start: 110, inputDelayMs: 2 }],
      frames: [
        { startTime: 105, duration: 60, blockingDuration: 10, scripts: [] },
        { startTime: 200, duration: 60, blockingDuration: 10, scripts: [] },
      ],
    }).menu!;
    expect(result.observedEventTiming).toEqual({
      latencyMs: { count: 1, p50: 64, p90: 64, max: 64 },
      inputDelayMs: { count: 1, p50: 2, p90: 2, max: 2 },
      processingMs: { count: 1, p50: 48, p90: 48, max: 48 },
      presentationDelayMs: { count: 1, p50: 14, p90: 14, max: 14 },
    });
    expect(result.blockingFrames).toHaveLength(1);
  });

  it("retains fast native inputs without inventing missing Event Timing samples", () => {
    const result = summarizeInteractionLatency({
      steps: [{ kind: "typing", start: 100, end: 200, streamDeltas: 1, teamEvents: 1 }],
      events: [],
      frames: [],
      dispatches: [
        { name: "keydown", start: 110, inputDelayMs: 1 },
        { name: "keyup", start: 115, inputDelayMs: 99 },
        { name: "keydown", start: 150, inputDelayMs: 3 },
        { name: "keydown", start: 210, inputDelayMs: 99 },
      ],
    }).typing!;
    expect(result.nativeInputDelayMs).toEqual({ count: 2, p50: 2, p90: 2.8, max: 3 });
    expect(result.observedEventTiming.latencyMs).toEqual({
      count: 0,
      p50: null,
      p90: null,
      max: null,
    });
  });

  it("preserves queued-input delay when an earlier interaction shares the paint", () => {
    const result = summarizeInteractionLatency({
      steps: [{ kind: "typing", start: 110, end: 200, streamDeltas: 1, teamEvents: 1 }],
      events: [
        {
          name: "keydown",
          startTime: 100,
          duration: 80,
          processingStart: 102,
          processingEnd: 120,
          interactionId: 1,
        },
        {
          name: "keydown",
          startTime: 110,
          duration: 72,
          processingStart: 140,
          processingEnd: 160,
          interactionId: 2,
        },
      ],
      dispatches: [],
      frames: [],
    }).typing!;
    expect(result.observedEventTiming.inputDelayMs.p50).toBe(30);
    expect(result.observedEventTiming.processingMs.p50).toBe(20);
    expect(result.observedEventTiming.presentationDelayMs.p50).toBe(22);
  });
});
