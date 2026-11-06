import { randomUUID } from 'crypto';
import * as db from './db';
import * as team from './team';
import { organizationRoutingOwner, validRoutingOrgRef } from './routing-contract';
import type { RoutingOrgRef } from './routing-contract';
export async function confirmClientOrganization(input: {
  actor: string; messenger: string; userid: string; declared: string; expectedVersion: number;
  orgRef: RoutingOrgRef; humanVerified: boolean;
}): Promise<db.IClientProfile | null> {
  const allowed = () => team.canPerformAction(input.actor,'manage_team');
  if (!allowed() || input.humanVerified !== true || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return null;
  const owner = organizationRoutingOwner();
  if (!owner?.ticketPartitioningReady || !validRoutingOrgRef(input.orgRef,owner.registeredInstance)) return null;
  const org = await owner.getOrganization(input.orgRef);
  if (!org || !Number.isSafeInteger(org.owner_version) || org.owner_version < 1 || org.status !== 'active' || !validRoutingOrgRef(org.org_ref,owner.registeredInstance) || org.org_ref.id !== input.orgRef.id || !allowed()) return null;
  return await db.ClientProfile.findOneAndUpdate({
    messenger: input.messenger, userid: input.userid, organization: input.declared,
    org_input: null,
    $and: [
      input.expectedVersion === 0 ? { $or: [{org_binding_version:0},{org_binding_version:{$exists:false}}] } : {org_binding_version:input.expectedVersion},
      input.expectedVersion === 0 ? { $or: [{organization_verification:'pending'},{organization_verification:{$exists:false}}] } : {organization_verification:'pending'},
    ],
  }, { $set: { organization_verification:'confirmed', confirmed_org_ref:org.org_ref, org_binding_audit_pending:true },
    $inc: { org_binding_version:1 },
    $push: { org_binding_audit: { event_id:randomUUID(), action:'confirmed', actor:input.actor, at:new Date(), version:input.expectedVersion + 1,
      old_org_ref:null, new_org_ref:org.org_ref, declared:input.declared, platform:input.messenger, user:input.userid } },
  }, {new:true}) as db.IClientProfile | null;
}
export async function rejectClientOrganization(actor: string, messenger: string, userid: string, expectedVersion: number) {
  if (!team.canPerformAction(actor,'manage_team') || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  return await db.ClientProfile.findOneAndUpdate({ messenger,userid,org_input:null,$and:[
      expectedVersion===0?{$or:[{org_binding_version:0},{org_binding_version:{$exists:false}}]}:{org_binding_version:expectedVersion},
      expectedVersion===0?{$or:[{organization_verification:'pending'},{organization_verification:{$exists:false}}]}:{organization_verification:'pending'},
    ] },
    { $set:{organization_verification:'rejected',confirmed_org_ref:null,org_binding_audit_pending:true}, $inc:{org_binding_version:1},
      $push:{org_binding_audit:{event_id:randomUUID(),action:'rejected',actor,at:new Date(),platform:messenger,user:userid,version:expectedVersion+1}} },{new:true});
}

/** Recoverable projection into the existing journal; profile and outbox share the same CAS write. */
export async function flushOrganizationBindingAudit(): Promise<void> {
  let after = '';
  for (;;) {
    const rows = await db.ClientProfile.find({org_binding_audit_pending:true,...(after?{_id:{$gt:after}}:{})}).sort({_id:1}).limit(200);
    if(!rows.length)return;
    after=String(rows[rows.length-1]._id);
    for(const p of rows) {
      for(const h of p.org_binding_audit ?? []) {
        if(typeof h.event_id !== 'string' || typeof h.action !== 'string' || typeof h.actor !== 'string') continue;
        await db.recordOrganizationBindingEvent(h.event_id,h.action,h.actor,{platform:p.messenger,user:p.userid,
          old:h.old_org_ref??null,new:h.new_org_ref??null,old_declared:h.old_organization??null,
          new_declared:h.new_organization??h.declared??null,occurred_at:h.at});
      }
      await db.ClientProfile.updateOne({_id:p._id,org_binding_version:p.org_binding_version},
        {$set:{org_binding_audit_pending:false}});
    }
  }
}
