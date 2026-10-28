/* =================================================================
   pyterm-helper.js — hjälpfil till pyodide-terminal.html
   Lägg den i SAMMA mapp som HTML-filen.

   Filen har två roller:

   1. Service worker: lägger på huvudena
        Cross-Origin-Opener-Policy: same-origin
        Cross-Origin-Embedder-Policy: require-corp
      på terminalsidan. De krävs för att input() ska kunna vänta
      på användaren som i en riktig terminal. En vanlig HTML-fil
      kan inte skicka dem själv (det kan PHP-versionen).
      Den påverkar bara terminalsidan, inte resten av webbplatsen.

   2. Bakgrundstråd (Web Worker): kör Python (Pyodide) så att
      sidan inte fryser och så att Stoppa-knappen fungerar.
   ================================================================= */

if (typeof ServiceWorkerGlobalScope !== "undefined" &&
    self instanceof ServiceWorkerGlobalScope) {

  /* ------------------------- Roll 1 ---------------------------- */
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", (e) => {
    const r = e.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

    // Bakgrundstråden startas som "sidan?__pyterm_worker" så att den
    // hamnar under den här service workerns kontroll. Svara då
    // med denna fils egen kod.
    const url = new URL(r.url);
    const isWorker = url.origin === self.location.origin &&
                     url.searchParams.has("__pyterm_worker");
    const target = isWorker ? self.location.href : r;

    e.respondWith(
      fetch(target)
        .then((res) => {
          if (res.status === 0) return res;   // opakt svar, kan inte ändras
          const h = new Headers(res.headers);
          h.set("Cross-Origin-Embedder-Policy", "require-corp");
          h.set("Cross-Origin-Opener-Policy", "same-origin");
          h.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: h,
          });
        })
        .catch(() => Response.error())
    );
  });

} else {

  /* ------------------------- Roll 2 ---------------------------- */
  let pyodide = null;
  let ctrl = null;   // Int32Array: [0] = tillstånd, [1] = längd på inmatning
  let data = null;   // Uint8Array: själva inmatningen (UTF-8)
  let intr = null;   // Uint8Array: Pyodides avbrottssignal
  const decoder = new TextDecoder();

  const WAITING = 0, STOPPED = 2;

  // Stoppa trycktes medan vi väntade: input()/sleep() avbryter
  // själva, så den extra avbrottssignalen ska inte slå till igen
  function clearInterrupt() { if (intr) intr[0] = 0; }

  // Blockerar tråden tills användaren tryckt Enter (eller Stoppa).
  // Returnerar strängen, eller null om körningen avbröts.
  self.readLine = function () {
    Atomics.store(ctrl, 0, WAITING);
    postMessage({ type: "input" });
    Atomics.wait(ctrl, 0, WAITING);
    if (Atomics.load(ctrl, 0) === STOPPED) { clearInterrupt(); return null; }
    const len = Atomics.load(ctrl, 1);
    return decoder.decode(data.slice(0, len));
  };

  // Riktig time.sleep() som inte fryser sidan och som går att avbryta
  self.sleepMs = function (ms) {
    Atomics.store(ctrl, 0, WAITING);
    const end = performance.now() + ms;
    while (true) {
      const left = end - performance.now();
      if (left <= 0) return true;
      Atomics.wait(ctrl, 0, WAITING, Math.min(left, 50));
      if (Atomics.load(ctrl, 0) === STOPPED) { clearInterrupt(); return false; }
    }
  };

  self.onmessage = async (e) => {
    const msg = e.data;

    if (msg.type === "init") {
      ctrl = new Int32Array(msg.ctrlBuf);
      data = new Uint8Array(msg.dataBuf);
      try {
        let loadPyodide;
        try {
          ({ loadPyodide } = await import(msg.pyodideUrl));
        } catch (err) {
          throw new Error("kunde inte hämta Pyodide från " + msg.pyodideUrl + " (" + err + ")");
        }
        pyodide = await loadPyodide();
        intr = new Uint8Array(msg.interruptBuf);
        pyodide.setInterruptBuffer(intr);
        const out = (stream) => (buf) => {
          postMessage({ type: stream, text: decoder.decode(buf, { stream: true }) });
          return buf.length;
        };
        pyodide.setStdout({ write: out("stdout") });
        pyodide.setStderr({ write: out("stderr") });
        pyodide.setStdin({
          stdin: () => {
            const s = self.readLine();
            return s === null ? null : s + "\n";
          },
        });
        pyodide.runPython(msg.setup);
        postMessage({ type: "ready" });
      } catch (err) {
        postMessage({ type: "fatal", text: String(err) });
      }
    }

    if (msg.type === "run") {
      try {
        pyodide.globals.get("_run_program")(msg.code);
      } catch (err) {
        postMessage({ type: "stderr", text: "\n[Internt fel] " + String(err) + "\n" });
      }
      clearInterrupt();
      postMessage({ type: "done" });
    }
  };
}
