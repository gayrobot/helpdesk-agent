/**
 * `npm run dev:worker [-- --port 8787]`: run the Worker locally in workerd.
 *
 * Started through wrangler's API rather than `wrangler dev`, because only the API can
 * turn the devtools inspector off: an inspector port on a process that holds the key
 * would let any local program read it. Also: loopback only, the local explorer API off,
 * telemetry off.
 *
 * With the real key (Skylar only): op run --env-file=.env.tpl -- npm --prefix web run dev:worker
 */
import { parseArgs } from "node:util";

export const HOST = "127.0.0.1";

/** `persist`: a folder for Durable Object state (default .wrangler/state; tests pass a
 * temporary one, and pass the same one twice to simulate a restart). */
export async function startLocalWorker(port: number, configPath?: string, persist?: string) {
  // Read by wrangler when the worker starts; set here so no one has to remember them.
  process.env.X_LOCAL_EXPLORER = "false";
  process.env.WRANGLER_SEND_METRICS = "false";
  const { unstable_startWorker } = await import("wrangler");
  const worker = await unstable_startWorker({
    config: configPath ?? new URL("../../wrangler.jsonc", import.meta.url).pathname,
    dev: {
      inspector: false,
      server: { hostname: HOST, port },
      watch: false,
      ...(persist ? { persist } : {}),
    },
  });
  await worker.ready;
  return worker;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8787" } } });
  const worker = await startLocalWorker(Number.parseInt(values.port, 10));
  process.stdout.write(`Worker on ${(await worker.url).href}  (local only; Ctrl-C to stop)\n`);
  const stop = async () => {
    await worker.dispose();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
