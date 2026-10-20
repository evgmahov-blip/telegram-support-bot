import mongoose from 'mongoose';
import * as ai from './ai-engineer';

export interface EngineerCatalog {
  deployment_scope: string; version: number; generated_at: number; expires_at: number; entries: ai.Binding[];
}
function model(): mongoose.Model<any> {
  if (mongoose.models.AIEngineerCatalog) return mongoose.models.AIEngineerCatalog;
  return mongoose.model('AIEngineerCatalog', new mongoose.Schema({
    _id: { type: String }, version: { type: Number, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true }, digest: { type: String, required: true },
  }));
}
export function validateCatalog(value: unknown, scope: string, now: number): EngineerCatalog {
  ai.exact(value, ['deployment_scope', 'version', 'generated_at', 'expires_at', 'entries']);
  ai.requireEngineer(value.deployment_scope === scope && Number.isSafeInteger(value.version) && Number(value.version) > 0, 'catalog_scope_or_version');
  ai.requireEngineer(typeof value.generated_at === 'number' && typeof value.expires_at === 'number'
    && value.generated_at <= now + 5000 && value.expires_at > now
    && value.expires_at > value.generated_at && value.expires_at - value.generated_at <= ai.FACTS_MS, 'catalog_expired');
  ai.requireEngineer(Array.isArray(value.entries) && value.entries.length <= 100 && ai.byteSize(value) <= 24 * 1024, 'catalog_too_large');
  const entries = value.entries.map(ai.validateBinding);
  ai.requireEngineer(new Set(entries.map(b => b.binding_id)).size === entries.length, 'binding_duplicate');
  return { deployment_scope: scope, version: Number(value.version), generated_at: value.generated_at,
    expires_at: value.expires_at, entries };
}
export async function publishCatalog(value: unknown, scope: string, now = Date.now()): Promise<EngineerCatalog> {
  const catalog = validateCatalog(value, scope, now), hash = ai.digest(catalog), collection = model();
  try {
    const updated = await collection.findOneAndUpdate({ _id: scope, version: { $lt: catalog.version } },
      { $set: { payload: catalog, digest: hash, version: catalog.version } }, { upsert: true, new: true }).lean();
    if (updated) return catalog;
  } catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
  const previous = await collection.findById(scope).lean() as any;
  ai.requireEngineer(previous?.version === catalog.version && previous.digest === hash
    && ai.digest(previous.payload) === hash, 'catalog_conflict');
  return catalog;
}
export async function readCatalog(scope: string, now = Date.now()): Promise<EngineerCatalog> {
  const result = await model().findById(scope).lean() as any;
  ai.requireEngineer(result?.payload && result.digest === ai.digest(result.payload), 'catalog_missing');
  return validateCatalog(result.payload, scope, now);
}
export async function requireCatalogBinding(scope: string, binding: ai.Binding, now = Date.now()): Promise<void> {
  const catalog = await readCatalog(scope, now);
  ai.requireEngineer(catalog.entries.some(entry => ai.digest(entry) === ai.digest(binding)), 'binding_unavailable');
}
