/**
 * Shared job watching for GET /jobs/{id}/events (SSE): ONE Mongo poll per job id, however many streams
 * follow it, plus a per-client cap on concurrent streams. Without it every stream ran its own 2 s poll
 * and one client could hold any number of sockets.
 */
import type { JobDoc } from './types.ts';

export type JobListener = (doc: JobDoc | null) => void;

interface Watch {
  listeners: Set<JobListener>;
  timer: NodeJS.Timeout;
  inFlight: boolean;
  /** A notify() arrived while a load was in flight: load again right after it. */
  again: boolean;
}

export class JobWatchers {
  private readonly watches = new Map<string, Watch>();
  private readonly perClient = new Map<string, number>();
  private readonly load: (jobId: string) => Promise<JobDoc | null>;
  private readonly pollMs: number;

  constructor(load: (jobId: string) => Promise<JobDoc | null>, pollMs: number) {
    this.load = load;
    this.pollMs = pollMs;
  }

  /** Open streams of `client`. */
  streams(client: string): number {
    return this.perClient.get(client) ?? 0;
  }

  /** Number of job ids being polled (one timer each). */
  polledJobs(): number {
    return this.watches.size;
  }

  /** Reserve a stream slot for `client`; false when it already holds `max`. Pair with release(). */
  acquire(client: string, max: number): boolean {
    const n = this.streams(client);
    if (n >= max) return false;
    this.perClient.set(client, n + 1);
    return true;
  }

  release(client: string): void {
    const n = this.streams(client) - 1;
    if (n <= 0) this.perClient.delete(client);
    else this.perClient.set(client, n);
  }

  /** Follow a job; returns the unsubscribe function. Listeners get the doc on every poll / notify(). */
  subscribe(jobId: string, listener: JobListener): () => void {
    let w = this.watches.get(jobId);
    if (!w) {
      const created: Watch = { listeners: new Set(), inFlight: false, again: false, timer: setInterval(() => this.notify(jobId), this.pollMs) };
      created.timer.unref();
      this.watches.set(jobId, created);
      w = created;
    }
    w.listeners.add(listener);
    return () => {
      const cur = this.watches.get(jobId);
      if (!cur) return;
      cur.listeners.delete(listener);
      if (cur.listeners.size === 0) {
        clearInterval(cur.timer);
        this.watches.delete(jobId);
      }
    };
  }

  /** Load the job once and fan it out to its listeners (the runner's change events call this too). */
  notify(jobId: string): void {
    const w = this.watches.get(jobId);
    if (!w) return;
    if (w.inFlight) {
      w.again = true;
      return;
    }
    w.inFlight = true;
    const done = (doc: JobDoc | null): void => {
      w.inFlight = false;
      for (const l of [...w.listeners]) l(doc);
      if (w.again && this.watches.get(jobId) === w) {
        w.again = false;
        this.notify(jobId);
      }
    };
    this.load(jobId).then(done, () => done(null));
  }

  close(): void {
    for (const w of this.watches.values()) clearInterval(w.timer);
    this.watches.clear();
    this.perClient.clear();
  }
}
