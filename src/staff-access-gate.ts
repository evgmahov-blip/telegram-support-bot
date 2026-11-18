import { AsyncLocalStorage } from 'async_hooks';

// Single bot process: let concurrent requests finish before changing authority.
// This also closes the assignment-check / disable-write race across Telegram updates.
// FIFO prevents a stream of readers from starving a role change.
type Mode = 'read' | 'write';
const context = new AsyncLocalStorage<{ mode: Mode; active: boolean }>();
let readers = 0, writer = false;
const queue: Array<{ mode: Mode; grant: () => void }> = [];
function drain() {
  if (writer) return;
  while (queue.length) {
    const first = queue[0];
    if (first.mode === 'write') {
      if (readers) return;
      writer = true; queue.shift(); first.grant(); return;
    }
    readers++; queue.shift(); first.grant();
  }
}
export async function withStaffAccess<T>(mode: Mode, action: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (parent?.active) {
    if (parent.mode === 'read' && mode === 'write') throw new Error('team_gate_upgrade_denied');
    return action();
  }
  await new Promise<void>(grant => { queue.push({ mode, grant }); drain(); });
  const scope = { mode, active: true };
  try { return await context.run(scope, action); }
  finally { scope.active = false; if (mode === 'write') writer = false; else readers--; drain(); }
}
