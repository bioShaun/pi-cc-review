export interface Task {
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** 1-based task numbers this task depends on. Missing means preserve ordered handoff semantics. */
  dependsOn?: number[];
}

export interface AfterAllExecutionBatchItem {
  task: Task;
  index: number;
}

export async function runWithConcurrencyLimit<T>(
  concurrencyLimit: number,
  items: T[],
  fn: (item: T, index: number, signal: AbortSignal) => Promise<void>
): Promise<void> {
  const executing = new Set<Promise<void>>();
  const started: Promise<void>[] = [];
  let firstError: unknown;
  // Batch-level abort controller: aborted on first rejection so in-flight
  // siblings receive a cancellation signal promptly (R3). We still await
  // allSettled so no background task keeps editing the workspace after return.
  const batchController = new AbortController();

  const failFast = (error: unknown) => {
    if (firstError === undefined) {
      firstError = error;
      batchController.abort();
    }
  };

  for (let i = 0; i < items.length; i++) {
    if (firstError !== undefined) break;
    const p = fn(items[i], i, batchController.signal);
    started.push(p);
    executing.add(p);
    p.then(
      () => executing.delete(p),
      (error) => {
        executing.delete(p);
        failFast(error);
      }
    );
    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing).catch((error) => {
        failFast(error);
      });
    }
  }

  // Wait for all started callbacks to settle — even after abort — so no
  // background task can keep editing the workspace after we return (R3).
  const settled = await Promise.allSettled(started);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (firstError !== undefined) throw firstError;
  if (rejected) throw rejected.reason;
}

export function buildAfterAllExecutionBatches(
  tasks: readonly Task[]
): AfterAllExecutionBatchItem[][] {
  const dependencySets = tasks.map((task, index) => {
    if (!Array.isArray(task.dependsOn)) {
      return index === 0 ? new Set<number>() : new Set<number>([index - 1]);
    }

    const normalized = new Set<number>();
    for (const value of task.dependsOn) {
      const dependencyNumber = Number(value);
      if (
        Number.isInteger(dependencyNumber) &&
        dependencyNumber >= 1 &&
        dependencyNumber <= tasks.length
      ) {
        normalized.add(dependencyNumber - 1);
      }
    }
    return normalized;
  });

  const remaining = new Set(tasks.map((_, index) => index));
  const batches: AfterAllExecutionBatchItem[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((index) => [...dependencySets[index]].every((dependency) => !remaining.has(dependency)))
      .sort((a, b) => a - b);

    if (ready.length === 0) {
      const blockedTaskNumbers = [...remaining].map((index) => index + 1).join(", ");
      throw new Error(
        `Invalid task dependency graph: cycle detected among tasks ${blockedTaskNumbers}`
      );
    }

    batches.push(ready.map((index) => ({ task: tasks[index], index })));
    for (const index of ready) remaining.delete(index);
  }

  return batches;
}

/**
 * Provider-independent structural validator for planner output (R4).
 * Accepts `unknown` and returns either validated `Task[]` or a precise error.
 * Does NOT coerce types or silently discard invalid dependencies.
 */
export function validatePlannerTasks(raw: unknown): { ok: true; tasks: Task[] } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Planner output is not a JSON object" };
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) {
    return { ok: false, error: "Planner output does not contain a \"tasks\" array" };
  }

  const rawTasks = obj.tasks as unknown[];
  if (rawTasks.length === 0) {
    return { ok: false, error: "Planner returned an empty task list" };
  }

  const tasks: Task[] = [];

  for (let i = 0; i < rawTasks.length; i++) {
    const item = rawTasks[i];
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `Task ${i + 1} is not an object` };
    }

    const record = item as Record<string, unknown>;

    // title must be a non-empty string
    if (typeof record.title !== "string" || record.title.trim().length === 0) {
      return { ok: false, error: `Task ${i + 1} has an invalid or missing "title" (must be a non-empty string)` };
    }

    // description must be a non-empty string
    if (typeof record.description !== "string" || record.description.trim().length === 0) {
      return { ok: false, error: `Task ${i + 1} has an invalid or missing "description" (must be a non-empty string)` };
    }

    // acceptanceCriteria must be a non-empty string
    if (typeof record.acceptanceCriteria !== "string" || record.acceptanceCriteria.trim().length === 0) {
      return { ok: false, error: `Task ${i + 1} has an invalid or missing "acceptanceCriteria" (must be a non-empty string)` };
    }

    const task: Task = {
      title: record.title,
      description: record.description,
      acceptanceCriteria: record.acceptanceCriteria,
    };

    // dependsOn is optional; if present must be an array of integers in 1..tasks.length
    if (record.dependsOn !== undefined) {
      if (!Array.isArray(record.dependsOn)) {
        return { ok: false, error: `Task ${i + 1} "dependsOn" must be an array of integers` };
      }

      const deps: number[] = [];
      for (let d = 0; d < record.dependsOn.length; d++) {
        const dep = record.dependsOn[d];
        if (typeof dep !== "number" || !Number.isInteger(dep)) {
          return { ok: false, error: `Task ${i + 1} "dependsOn" contains a non-integer value: ${JSON.stringify(dep)}` };
        }
        if (dep < 1 || dep > rawTasks.length) {
          return { ok: false, error: `Task ${i + 1} "dependsOn" contains an out-of-range value: ${dep} (must be 1..${rawTasks.length})` };
        }
        // Self-reference check
        if (dep === i + 1) {
          return { ok: false, error: `Task ${i + 1} depends on itself` };
        }
        deps.push(dep);
      }
      task.dependsOn = deps;
    }

    tasks.push(task);
  }

  // Acyclic check: verify the dependency graph has no cycles
  const remaining = new Set(tasks.map((_, index) => index));
  const dependencySets = tasks.map((task, index) => {
    if (!Array.isArray(task.dependsOn)) {
      return index === 0 ? new Set<number>() : new Set<number>([index - 1]);
    }
    return new Set(task.dependsOn.map((d) => d - 1));
  });

  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    const ready = [...remaining]
      .filter((index) => [...dependencySets[index]].every((dep) => !remaining.has(dep)));
    for (const index of ready) {
      remaining.delete(index);
      progressed = true;
    }
  }

  if (remaining.size > 0) {
    const blockedTaskNumbers = [...remaining].map((index) => index + 1).join(", ");
    return { ok: false, error: `Task dependency graph has a cycle among tasks ${blockedTaskNumbers}` };
  }

  return { ok: true, tasks };
}
