import type { LogEntry } from './types.js';

const DEFAULT_CAPACITY = 1000;

export class LogStore {
  private buffer: LogEntry[] = [];
  private capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  append(stream: 'stdout' | 'stderr', line: string): void {
    this.buffer.push({ timestamp: Date.now(), stream, line });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  getLines(count?: number, filter?: string): LogEntry[] {
    let entries = count ? this.buffer.slice(-count) : [...this.buffer];
    if (filter) {
      entries = entries.filter(e => e.line.includes(filter));
    }
    return entries;
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}
