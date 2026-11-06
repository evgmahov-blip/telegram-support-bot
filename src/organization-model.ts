import mongoose, { Model } from 'mongoose';
import type { OrgRef } from './organization-domain';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export interface EngineerRelationship {
  principal_ref: string;
  engineer_name: string;
  service_contact?: string | null;
  real_telegram_identity?: string | null;
  priority?: number;
}
export interface SubstituteRelationship extends EngineerRelationship {
  replaces_ref: string;
  valid_from: Date;
  valid_until: Date;
}
export interface OrganizationRecord {
  org_ref: OrgRef;
  owner_version: number;
  status: 'active' | 'archived';
  display_name: string;
  service_contact?: string | null;
  primary_engineer?: EngineerRelationship | null;
  backup_engineers: EngineerRelationship[];
  substitutes: SubstituteRelationship[];
  created_at?: Date;
  updated_at?: Date;
}

const safeText = { type: String, maxlength: 256, trim: true };
const EngineerSchema = new mongoose.Schema({
  principal_ref: { type: String, required: true, maxlength: 256, match: PRINCIPAL_PATTERN },
  engineer_name: { ...safeText, required: true },
  service_contact: { ...safeText, default: null },
  real_telegram_identity: { ...safeText, default: null },
  priority: { type: Number, min: 1 },
}, { _id: false });
const SubstituteSchema = new mongoose.Schema({
  principal_ref: { type: String, required: true, maxlength: 256, match: PRINCIPAL_PATTERN },
  engineer_name: { ...safeText, required: true },
  service_contact: { ...safeText, default: null },
  real_telegram_identity: { ...safeText, default: null },
  replaces_ref: { type: String, required: true, maxlength: 256, match: PRINCIPAL_PATTERN },
  valid_from: { type: Date, required: true },
  valid_until: { type: Date, required: true },
}, { _id: false });

export const OrganizationSchema = new mongoose.Schema<OrganizationRecord>({
  org_ref: {
    authority: { type: String, enum: ['support-bot'], required: true },
    instance: { type: String, required: true, maxlength: 128, match: INSTANCE_PATTERN },
    id: { type: String, required: true, lowercase: true, match: UUID_PATTERN },
  },
  owner_version: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  status: { type: String, enum: ['active', 'archived'], required: true },
  display_name: { ...safeText, required: true },
  service_contact: { ...safeText, default: null },
  primary_engineer: { type: EngineerSchema, default: null },
  backup_engineers: { type: [EngineerSchema], default: [] },
  substitutes: { type: [SubstituteSchema], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, autoCreate: false, autoIndex: false });

OrganizationSchema.index({ 'org_ref.authority': 1, 'org_ref.instance': 1, 'org_ref.id': 1 }, { unique: true });
OrganizationSchema.pre('validate', function validateRelationships(next) {
  const backups = this.backup_engineers || [];
  const priorities = backups.map((b) => b.priority);
  const relationshipRefs = [this.primary_engineer?.principal_ref, ...backups.map((b) => b.principal_ref)].filter(Boolean) as string[];
  if (priorities.some((p) => !Number.isSafeInteger(p) || Number(p) < 1) || new Set(priorities).size !== priorities.length ||
      priorities.some((p, i) => i > 0 && Number(priorities[i - 1]) >= Number(p))) {
    return next(new Error('backup priorities must be unique, positive, and ordered'));
  }
  if (new Set(relationshipRefs).size !== relationshipRefs.length) return next(new Error('engineer relationships must be unique'));
  if ((this.substitutes || []).some((s) => !(s.valid_from instanceof Date) || !(s.valid_until instanceof Date) ||
      !Number.isFinite(s.valid_from.getTime()) || !Number.isFinite(s.valid_until.getTime()) || s.valid_from >= s.valid_until ||
      !relationshipRefs.includes(s.replaces_ref))) return next(new Error('invalid substitute interval or replacement'));
  next();
});

type ExistingModel = Pick<Model<any>, 'collection' | 'db'>;
export function createOrganizationModel(ticketModel: ExistingModel): Model<OrganizationRecord> {
  if (!ticketModel?.collection?.name || !ticketModel.db) throw new Error('existing ticket model is required');
  const collection = `${ticketModel.collection.name}_organizations`;
  const modelName = `${ticketModel.collection.name}_OrganizationOwner`;
  return (ticketModel.db.models[modelName] as Model<OrganizationRecord> | undefined) ||
    ticketModel.db.model<OrganizationRecord>(modelName, OrganizationSchema, collection, { overwriteModels: false });
}
