import type { TwinLogEntry } from "@trip/clients/contracts";

export class RequestLog {
  #entries: TwinLogEntry[] = [];
  #seq = 0;

  append(entry: Omit<TwinLogEntry, "seq">): void {
    this.#seq += 1;
    this.#entries.push({ seq: this.#seq, ...entry });
  }

  list(afterSeq = 0): TwinLogEntry[] {
    return this.#entries.filter((e) => e.seq > afterSeq);
  }

  clear(): void {
    this.#entries = [];
    this.#seq = 0;
  }
}
