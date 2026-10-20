import cache from './cache';

/** Invalidate AI authority only when the written authority fields change. */
export function authorityUpdate(values: Record<string, unknown>): any {
  if (cache.config.ai_engineer_enabled !== true) return { $set: values };
  const keys = Object.keys(values).filter(k => ['status', 'assigned_to', 'category'].includes(k));
  const differs = keys.map(key => ({ $ne: [{ $ifNull: [`$${key}`, null] }, { $literal: values[key] }] }));
  return [{ $set: {
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { $literal: value }])),
    ai_epoch: { $add: [{ $ifNull: ['$ai_epoch', 0] }, { $cond: [{ $or: differs }, 1, 0] }] },
  } }];
}
