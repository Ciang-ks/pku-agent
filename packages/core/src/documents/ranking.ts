export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export function reciprocalRankFusion(...rankings: string[][]): { blockId: string; score: number }[] {
  const scores = new Map<string, number>();
  const k = 60;
  for (const ranking of rankings) {
    ranking.forEach((blockId, index) => scores.set(blockId, (scores.get(blockId) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()]
    .map(([blockId, score]) => ({ blockId, score }))
    .sort((left, right) => right.score - left.score || left.blockId.localeCompare(right.blockId));
}

