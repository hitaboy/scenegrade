// SPDX-License-Identifier: Apache-2.0
// Undo / redo for grades. Continuous edits (dragging a wheel) are coalesced into one step when
// they share a `coalesce` key and arrive within `windowMs` of each other, or, inside a gesture
// (`hold()` … `break()`, i.e. pointer down … up), however slowly they arrive.

import { cloneGrade, type Grade } from './model.js';

export interface HistoryOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

export class GradeHistory {
  private past: Grade[] = [];
  private future: Grade[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;
  private holding = false;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: HistoryOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.windowMs = opts.windowMs ?? 800;
    this.now = opts.now ?? (() => performance.now());
  }

  /**
   * Records `before` (the grade being replaced). With the same `coalesce` key as the previous
   * record and within the time window, the step merges into the previous one.
   */
  record(before: Grade, coalesce?: string): void {
    const t = this.now();
    const merge =
      coalesce != null &&
      coalesce === this.lastKey &&
      (this.holding || t - this.lastTime < this.windowMs);
    this.lastKey = coalesce ?? null;
    this.lastTime = t;
    this.future = [];
    if (merge && this.past.length) return;
    this.past.push(cloneGrade(before));
    if (this.past.length > this.limit) this.past.shift();
  }

  /** Starts a gesture (pointer down): its edits form one new step until `break()`. */
  hold(): void {
    this.lastKey = null;
    this.holding = true;
  }

  /** Ends any coalescing run (e.g. on pointer up) so the next edit is a new step. */
  break(): void {
    this.lastKey = null;
    this.holding = false;
  }

  undo(current: Grade): Grade | null {
    const g = this.past.pop();
    if (!g) return null;
    this.future.push(cloneGrade(current));
    this.break();
    return g;
  }

  redo(current: Grade): Grade | null {
    const g = this.future.pop();
    if (!g) return null;
    this.past.push(cloneGrade(current));
    this.break();
    return g;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.break();
  }
}
