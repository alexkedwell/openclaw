import type { Page } from "playwright";

type Step = { kind: string; start: number; end?: number; streamDeltas: number; teamEvents: number };
type EventTiming = {
  name: string;
  startTime: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
  interactionId: number;
};
type InteractionCapture = {
  steps: Step[];
  events: EventTiming[];
  frames: Array<{
    startTime: number;
    duration: number;
    blockingDuration: number;
    scripts: unknown[];
  }>;
  dispatches: Array<{ name: string; start: number; inputDelayMs: number }>;
};

export function summarizeInteractionLatency(capture: InteractionCapture) {
  const distribution = (values: number[]) => {
    const xs = values.toSorted((a, b) => a - b);
    const quantile = (q: number) => {
      const at = (xs.length - 1) * q;
      const lo = Math.floor(at);
      return xs.length ? xs[lo]! + (xs[Math.ceil(at)]! - xs[lo]!) * (at - lo) : null;
    };
    return { count: xs.length, p50: quantile(0.5), p90: quantile(0.9), max: xs.at(-1) ?? null };
  };
  return Object.fromEntries(
    [...new Set(capture.steps.map((step) => step.kind))].map((kind) => {
      const steps = capture.steps.filter((step) => step.kind === kind);
      const contains = (at: number) => steps.some((step) => at >= step.start && at <= step.end!);
      const interactions = new Map<number, EventTiming>();
      for (const event of capture.events) {
        if (
          contains(event.startTime) &&
          event.interactionId &&
          event.duration > (interactions.get(event.interactionId)?.duration ?? -1)
        ) {
          interactions.set(event.interactionId, event);
        }
      }
      const events = [...interactions.values()];
      const parts = events.map((event) => {
        const paint = event.startTime + event.duration;
        // Event Timing rounds to 8 ms; include the other handlers presented in this frame.
        const frameEvents = capture.events.filter(
          (entry) => Math.abs(entry.startTime + entry.duration - paint) <= 8,
        );
        const start = event.processingStart;
        const nextPaint = Math.max(paint, start);
        const end = Math.max(
          start,
          Math.min(nextPaint, Math.max(...frameEvents.map((entry) => entry.processingEnd))),
        );
        return {
          inputDelayMs: start - event.startTime,
          processingMs: end - start,
          presentationDelayMs: nextPaint - end,
        };
      });
      return [
        kind,
        {
          steps: steps.length,
          // Capture-listener delay covers fast events too; Event Timing has a 16 ms floor.
          nativeInputDelayMs: distribution(
            capture.dispatches
              .filter(
                (event) =>
                  contains(event.start) &&
                  (event.name === "keydown" || event.name === "pointerdown"),
              )
              .map((event) => event.inputDelayMs),
          ),
          observedEventTiming: {
            latencyMs: distribution(events.map((event) => event.duration)),
            inputDelayMs: distribution(parts.map((part) => part.inputDelayMs)),
            processingMs: distribution(parts.map((part) => part.processingMs)),
            presentationDelayMs: distribution(parts.map((part) => part.presentationDelayMs)),
          },
          blockingFrames: capture.frames.filter((frame) =>
            events.some(
              (event) =>
                frame.startTime < event.startTime + event.duration &&
                frame.startTime + frame.duration > event.startTime,
            ),
          ),
        },
      ];
    }),
  );
}

/** Serialized into the disposable benchmark page before application startup. */
export function installInteractionLatencyProbe() {
  if (window !== window.top) {
    return;
  }
  const steps: Step[] = [];
  const events: object[] = [];
  const frames: object[] = [];
  const dispatches: Array<{ name: string; start: number; inputDelayMs: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "event") {
        events.push(entry.toJSON());
      } else {
        frames.push(entry.toJSON());
      }
    }
  });
  const options: PerformanceObserverInit & { durationThreshold: number } = {
    type: "event",
    durationThreshold: 16,
  };
  observer.observe(options);
  observer.observe({ type: "long-animation-frame" });
  for (const name of ["keydown", "keyup", "pointerdown", "pointerup", "click"]) {
    document.addEventListener(
      name,
      (event) => {
        if (event.isTrusted && steps.at(-1)?.end === undefined && steps.length) {
          dispatches.push({
            name: event.type,
            start: event.timeStamp,
            inputDelayMs: Math.max(0, performance.now() - event.timeStamp),
          });
        }
      },
      true,
    );
  }
  Reflect.set(window, "__interactionLatency", {
    begin(kind: string) {
      const streamDeltas = Reflect.get(window, "__streamingReply").read().delivered;
      steps.push({
        kind,
        start: performance.now(),
        streamDeltas,
        teamEvents: Reflect.get(window, "__coldLoad").readLive().sentEvents - streamDeltas,
      });
    },
    end() {
      const step = steps.at(-1);
      if (step) {
        step.end = performance.now();
      }
    },
    read() {
      for (const entry of observer.takeRecords()) {
        (entry.entryType === "event" ? events : frames).push(entry.toJSON());
      }
      return { steps, events, frames, dispatches };
    },
  });
}

/** Native clocks and trusted input: this is a benchmark, not a timing-gated test. */
export async function runInteractionLatencyScenario(
  page: Page,
  input: {
    selectedSessionKey: string;
    otherSessionKey: string;
    teamEventCount: number;
    stream: { deltas: string[]; deltasPerSecond: number; runId: string };
  },
) {
  const active = page.locator(".chat-pane-cache__pane--active");
  const composer = active.locator(".agent-chat__composer-combobox textarea");
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  const step = async (kind: string, act: () => Promise<void>) => {
    await page.evaluate(
      (interactionKind) => Reflect.get(window, "__interactionLatency").begin(interactionKind),
      kind,
    );
    await act();
    await frame();
    await page.evaluate(() => Reflect.get(window, "__interactionLatency").end());
  };
  await composer.fill("");
  await composer.focus();
  await page.evaluate((scenario) => {
    Reflect.get(window, "__streamingReply").start({
      ...scenario.stream,
      deltas: [],
      sessionKey: scenario.selectedSessionKey,
    });
    Reflect.get(window, "__coldLoad").startLive(false);
  }, input);
  const started = Date.now();
  for (let round = 0; round < 7; round++) {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, started + round * 8000 - Date.now()));
    });
    await composer.focus();
    await step("typing", async () => {
      for (const key of "abcdefghij") {
        await page.keyboard.press(key);
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
      }
    });
    if ((await composer.inputValue()) !== "abcdefghij".repeat(round + 1)) {
      throw new Error("Native composer input was lost during live traffic");
    }
    const thread = active.locator(".chat-thread");
    // Read existing history away from the growing reply's moving end.
    await thread.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    });
    await frame();
    const beforeScroll = await thread.evaluate((element) => element.scrollTop);
    if (beforeScroll <= 0) {
      throw new Error("Interaction scenario has no upward transcript scroll range");
    }
    await step("scroll", () => thread.press("PageUp"));
    await page.waitForFunction((before) => {
      const transcript = document.querySelector(".chat-pane-cache__pane--active .chat-thread");
      return transcript && transcript.scrollTop < before;
    }, beforeScroll);
    await step("scroll", () => thread.press("PageDown"));
    await step("menu", async () => {
      await active.locator(".chat-header-session-menu__trigger").click();
      await active
        .locator('openclaw-chat-header-session-menu [role^="menuitem"]')
        .first()
        .waitFor();
    });
    await page.keyboard.press("Escape");
    for (const key of [input.otherSessionKey, input.selectedSessionKey]) {
      await step("switch-session", async () => {
        await page.locator(`.sidebar-rail [data-sidebar-entry="session:${key}"]`).click();
        await page.waitForFunction((sessionKey) => {
          const pane = document.querySelector(".chat-pane-cache__pane--active");
          return (
            pane &&
            Reflect.get(pane, "sessionKey") === sessionKey &&
            Reflect.get(pane, "transcriptReady")
          );
        }, key);
        await composer.waitFor();
      });
    }
  }
  await page.waitForFunction(
    (count) => Reflect.get(window, "__streamingReply").read().delivered >= count,
    input.stream.deltas.length,
    { timeout: 60_000 },
  );
  await frame();
  await active.locator(".chat-thread").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(() => {
    const text = document.querySelector(
      ".chat-pane-cache__pane--active .chat-bubble.streaming .chat-text",
    );
    return text && ["h2", "pre", "table"].every((tag) => text.querySelectorAll(tag).length === 24);
  });
  // Event Timing entries are published asynchronously after paint (up to 104 ms).
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  const probe: InteractionCapture = await page.evaluate(() =>
    Reflect.get(window, "__interactionLatency").read(),
  );
  const stream = await page.evaluate(() => Reflect.get(window, "__streamingReply").finish());
  await page.evaluate(() => Reflect.get(window, "__coldLoad").finishLive());
  if (
    !stream.finalHtml ||
    stream.deltas.length !== input.stream.deltas.length ||
    ["<h2", "<table", "<pre"].some((tag) => stream.finalHtml.split(tag).length - 1 !== 24)
  ) {
    throw new Error("Interaction scenario did not retain the streamed reply");
  }
  if (
    probe.steps.some(
      (interaction) =>
        interaction.streamDeltas >= input.stream.deltas.length ||
        interaction.teamEvents >= input.teamEventCount,
    )
  ) {
    throw new Error("Interaction scenario outlasted its simultaneous reply/Team traffic");
  }
  return {
    probe,
    summary: summarizeInteractionLatency(probe),
    measurement:
      "Trusted native keyboard typing, PageUp/PageDown scrolling, session-menu clicks and pinned-session switches during a 30 Hz cumulative answer plus the Team live-event mix (excluding competing chat deltas). Event Timing is censored below 16 ms and rounded to 8 ms; reported event distributions include only observed interactions, grouped by interactionId using the longest event. Native capture-listener input delay includes fast events. PageUp/PageDown Event Timing measures keyboard-to-paint, not completion of smooth scrolling. Overlapping LoAFs identify candidate blockers, not exclusive causal attribution.",
    stream,
    live: await page.evaluate(() => Reflect.get(window, "__coldLoad").readLive()),
    rig: await page.evaluate(() => Reflect.get(window, "__readColdLoadRigProbes")?.()),
  };
}
