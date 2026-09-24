/** Run pieces of work one at a time, in the order they were asked for; one that fails does not stop the next. */
export type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

export function createExclusive(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}
