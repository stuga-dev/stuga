/**
 * Merging ranked lists from several workspaces. Scores from different
 * workspaces — let alone different nodes — are not comparable, and a document
 * lives in exactly one workspace, so rank is all there is to merge on: each
 * list's first, then each list's second, and so on. That is reciprocal-rank
 * fusion for lists that share no item.
 */
export function interleaveByRank<T>(lists: ReadonlyArray<readonly T[]>, limit: number): T[] {
  const out: T[] = [];
  for (let rank = 0; out.length < limit; rank++) {
    let any = false;
    for (const list of lists) {
      if (rank >= list.length) continue;
      any = true;
      out.push(list[rank]!);
      if (out.length === limit) break;
    }
    if (!any) break;
  }
  return out;
}
