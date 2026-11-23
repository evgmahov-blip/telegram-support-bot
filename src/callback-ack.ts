/** Start before database, session and lock middleware. Business replies stay private. */
export function acknowledgeCallbackIngress(ctx: {
  callbackQuery?: unknown; answerCallbackQuery: (options: object) => Promise<unknown>;
}, onError: (err: unknown) => void): () => Promise<void> {
  if (!ctx.callbackQuery) return async () => {};
  const answer = ctx.answerCallbackQuery.bind(ctx);
  let businessAnswered = false;
  let fallback: Promise<void> | undefined;
  const neutral = () => {
    if (businessAnswered || fallback) return;
    fallback = (async () => {
      try { await answer({}); } catch (err) { onError(err); }
    })();
  };
  ctx.answerCallbackQuery = async (options: object) => {
    if (businessAnswered) return;
    businessAnswered = true;
    clearTimeout(timer);
    // Even after the fallback, never turn private alerts into chat messages.
    try { return await answer(options); }
    catch (err) {
      onError(err); // Transport failure must never change the business outcome.
    }
  };
  const timer = setTimeout(neutral, 1500);
  return async () => {
    clearTimeout(timer);
    neutral(); // Also acknowledge duplicate or ignored updates with no business reply.
    await fallback;
  };
}
