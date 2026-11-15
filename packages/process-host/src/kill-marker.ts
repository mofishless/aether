// killedByUs 标记：handle 公共形状不可变，标记走 WeakSet（模块内部通道）。
// spawnTracked.kill() 与 killTree(handle) 都会打标；ExitProof 在 exit 事件时读取。
const killedHandles = new WeakSet<object>();

export function markKilledByUs(handle: object): void {
  killedHandles.add(handle);
}

export function wasKilledByUs(handle: object): boolean {
  return killedHandles.has(handle);
}
