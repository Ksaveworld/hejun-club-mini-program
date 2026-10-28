import {fail,one} from './common.mjs';
// Mandatory integration hook: invoke inside native identity transaction BEFORE
// linking, transferring, issuing a session or returning a member identity.
export async function requireConsumerIdentity(c,userId){
 fail(!await one(c,'SELECT user_id FROM collab_accounts WHERE user_id=$1',[userId]),'Operational account cannot become a consumer member',403,'OPERATIONAL_ACCOUNT');
}
// Mandatory for member lists/exports, not a substitute for their admin guard.
export const consumerMemberPredicate="u.role='member' AND NOT EXISTS (SELECT 1 FROM collab_accounts ca WHERE ca.user_id=u.id)";
