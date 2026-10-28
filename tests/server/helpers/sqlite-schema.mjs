import {openDatabase} from '../../../server/db.mjs';
import {installSurveys} from '../../../server/surveys.mjs';
import {installAmbassadors} from '../../../server/ambassadors.mjs';
import {installManualPayments} from '../../../server/manual-payments.mjs';
import {installLegalConsents} from '../../../server/legal-consents.mjs';
import {installEnterpriseIntake} from '../../../server/enterprise-intake.mjs';
import {createWebWechat} from '../../../server/web-wechat.mjs';

// Purely synthetic configuration; no provider call is made by createWebWechat.
export function completeSqliteSchema(path = ':memory:') {
  const db = openDatabase(path);
  for (const install of [installSurveys, installAmbassadors, installManualPayments, installLegalConsents, installEnterpriseIntake]) install(db);
  createWebWechat(db, {appId:'wx0000000000000000', appSecret:'0'.repeat(32)}, {origin:'https://fixture.invalid', legal:{id:'fixture'}});
  return db;
}
