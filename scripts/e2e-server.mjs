// Test runner only. Never imports the normal startup or touches work/data/club.sqlite.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.mjs';
import { createApplication } from '../server/app.mjs';
import { insertUser, hashPassword, createOrder, applyVerifiedPayment } from '../server/domain.mjs';
mkdirSync('work/e2e',{recursive:true});
const directory=mkdtempSync(resolve('work/e2e/run-'));
const db=openDatabase(join(directory,'isolated.sqlite'));
const hash=await hashPassword('OnlyInIsolatedTests1');
insertUser(db,'test_admin',hash,'admin');
const paid=insertUser(db,'test_paid_member',hash);
const source=insertUser(db,'test_referrer',hash);
// Deterministic referral belongs exclusively to the isolated test database.
db.prepare("UPDATE users SET referral_code='TESTAA' WHERE id=?").run(source.id);
const order=createOrder(db,paid.id,{planId:'basic',consent:true,form:{name:'隔离测试会员',phone:'13800000000',city:'上海'}},randomUUID());
applyVerifiedPayment(db,{transactionId:randomUUID(),orderId:order.id,merchantId:'TEST_ONLY',appId:'TEST_ONLY',currency:'CNY',amountCents:36500,status:'SUCCESS',paidAt:new Date().toISOString()}, {merchantId:'TEST_ONLY',appId:'TEST_ONLY'});
const server=createApplication(db,{hosts:['127.0.0.1:5188','127.0.0.1:5189'],origins:['http://127.0.0.1:5188']});
server.listen(5189,'127.0.0.1',()=>console.log('Isolated browser-test data service on 5189; fixtures are not real payments.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
