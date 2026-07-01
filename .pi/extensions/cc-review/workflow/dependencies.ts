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
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  const executing = new Set<Promise<void>>();
  const started: Promise<void>[] = [];
  let firstError: unknown;

  for (let i = 0; i < items.length; i++) {
    if (firstError !== undefined) break;
    const p = fn(items[i], i);
    started.push(p);
    executing.add(p);
    p.then(
      () => executing.delete(p),
      (error) => {
        executing.delete(p);
        if (firstError === undefined) firstError = error;
      }
    );
    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing).catch((error) => {
        if (firstError === undefined) firstError = error;
      });
    }
  }

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
