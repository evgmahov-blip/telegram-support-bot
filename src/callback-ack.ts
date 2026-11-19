// Transport acknowledgement is independent of business success and update leases.
const acknowledged = new WeakSet<object>();
export const hasEarlyCallbackAck = (ctx: object): boolean => acknowledged.has(ctx);
export async function acknowledgeCallbackIngress(ctx: {
  callbackQuery?: unknown; answerCallbackQuery: (options: object) => Promise<unknown>;
}, onError: (err: unknown) => void): Promise<void> {
  if (!ctx.callbackQuery || acknowledged.has(ctx)) return;
  acknowledged.add(ctx);
  try { await ctx.answerCallbackQuery({}); }
  catch (err) { onError(err); } // An expired query must not prevent an authorized operation.
}
