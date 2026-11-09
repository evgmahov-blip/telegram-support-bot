import cache from './cache';

/** Invalidate AI authority only when the written authority fields change. */
export function authorityUpdate(values: Record<string, unknown>): any {
  const invalidateCompose = ['assigned_to', 'common_visible', 'routing'].some(key => key in values);
  const retired = invalidateCompose ? {
    pending_reply_staff_id: null, pending_reply_prompt_id: null, pending_reply_expires_at: null,
    pending_reply_kind: null, pending_reply_chat_id: null, pending_reply_thread_id: null,
    pending_reply_origin_message_id: null, pending_reply_claim: null, pending_reply_claimed_at: null,
  } : {};
  if (cache.config.ai_engineer_enabled !== true) return { $set: { ...retired, ...values },
    ...(invalidateCompose ? { $inc: { pending_reply_version: 1 } } : {}) };
  const keys = Object.keys(values).filter(k => ['status', 'assigned_to', 'category'].includes(k));
  const differs = keys.map(key => ({ $ne: [{ $ifNull: [`$${key}`, null] }, { $literal: values[key] }] }));
  return [{ $set: {
    ...retired,
    ...(invalidateCompose ? { pending_reply_version: { $add: [{ $ifNull: ['$pending_reply_version', 0] }, 1] } } : {}),
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { $literal: value }])),
    ai_epoch: { $add: [{ $ifNull: ['$ai_epoch', 0] }, { $cond: [{ $or: differs }, 1, 0] }] },
  } }];
}
