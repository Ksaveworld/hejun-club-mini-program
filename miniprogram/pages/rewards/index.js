const {api,hasSession,sessionStamp,isCurrentSession,newKey}=require('../../utils/api');
const labels={applied:'已申请',submitted:'已申请',reviewing:'审核中',awaiting_payment:'待打款',paid:'已打款',rejected:'已驳回',failed:'打款失败',pending:'待确认',confirmed:'已确认',reversed:'已冲回',frozen:'已冻结'};
function money(value){return Number.isSafeInteger(value)&&value>=0?(value/100).toFixed(2):'';}
function amount(value){
  if(typeof value!=='string'||!/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim()))throw new Error('请输入最多两位小数的提现金额。');
  const [whole,fraction='']=value.trim().split('.');
  const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(cents)||cents<=0)throw new Error('提现金额应大于零。');
  return cents;
}
function rows(items){return Array.isArray(items)?items.map(item=>({...item,amountLabel:money(item.amountCents),statusLabel:labels[item.status]||'待核对'})):[];}
function monthNow(){return new Date(Date.now()+8*3600000).toISOString().slice(0,7);}
function signedMoney(value){return Number.isSafeInteger(value)?(value<0?'-':'')+money(Math.abs(value)):'';}
const statementLabels={reward_accrued:'新增奖励',reward_confirmed:'奖励确认',reward_reversed:'奖励冲回',refund_frozen:'退款处理中冻结',refund_unfrozen:'退款核实解冻',withdrawal_submitted:'申请提现（占用）',finance_reviewed:'财务审核（未转出）',secretary_approved:'秘书长批准（未转出）',withdrawal_rejected:'申请驳回（释放占用）',withdrawal_failed:'未转出核实／申请失败',withdrawal_paid:'已核实实际转出',payout_reconciliation_required:'退款关联打款待核对'};
function beijingTime(value){const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed+8*3600000).toISOString().slice(0,19).replace('T',' '):'';}
function statementView(statement,month){
  const totals=['earnedCents','confirmedCents','reversedCents','requestedCents','paidCents','releasedCents','feesCoveredByClubCents'];
  const balanceFields=['pendingCents','withdrawableCents','frozenCents','reservedCents','debtCents'];
  if(!statement||statement.month!==month||signedMoney(statement.openingBalance?.netCents)===''||signedMoney(statement.closingBalance?.netCents)===''
    ||totals.some(key=>money(statement.totals?.[key])==='')||balanceFields.some(key=>money(statement.closingBalance?.[key])===''))throw new Error('月账单金额暂未核对，请重试。');
  return {...statement,openingLabel:signedMoney(statement.openingBalance.netCents),closingLabel:signedMoney(statement.closingBalance.netCents),asOfLabel:beijingTime(statement.asOf),
    totalsLabels:Object.fromEntries(totals.map(key=>[key,money(statement.totals[key])])),closingLabels:Object.fromEntries(balanceFields.map(key=>[key,money(statement.closingBalance[key])])),
    entries:(Array.isArray(statement.entries)?statement.entries:[]).map(row=>({...row,typeLabel:statementLabels[row.type]||'待核对',amountLabel:row.amountCents===undefined?'':money(row.amountCents),timeLabel:beijingTime(row.at),paidAtLabel:beijingTime(row.paidAt)}))};
}
Page({
  data:{loggedIn:false,loading:false,busy:false,error:'',message:'',enabled:false,reason:'',balance:null,entries:[],withdrawals:[],recipients:[],recipientIndex:0,amount:'',consent:false,canWithdraw:false,minLabel:'100.00',hasPending:false,
    statement:null,statementMonth:monthNow(),statementEnd:monthNow(),statementLoading:false,statementError:'',statementReason:''},
  onShow(){this._hidden=false;return this.refresh();},
  onHide(){this._hidden=true;this._generation=(this._generation||0)+1;this.clearView();},
  onUnload(){this._unloaded=true;this._generation=(this._generation||0)+1;this._pending=null;this.clearView();},
  clearView(){this._stamp=null;this._statementRequest=(this._statementRequest||0)+1;this.setData({loggedIn:false,loading:false,busy:false,error:'',message:'',enabled:false,reason:'',balance:null,entries:[],withdrawals:[],recipients:[],recipientIndex:0,amount:'',consent:false,canWithdraw:false,hasPending:false,
    statement:null,statementMonth:monthNow(),statementEnd:monthNow(),statementLoading:false,statementError:'',statementReason:''});},
  current(generation,stamp){
    if(this._hidden||this._unloaded||generation!==this._generation)return false;
    if(hasSession()&&isCurrentSession(stamp))return true;
    this._pending=null;this.clearView();return false;
  },
  async refresh(){
    if(this._hidden||this._unloaded||this.data.loading||this.data.busy)return;
    if(!hasSession()){this._pending=null;this.clearView();return;}
    if(this._pending&&!isCurrentSession(this._pending.stamp))this._pending=null;
    const selectedMonth=this._stamp&&isCurrentSession(this._stamp)?this.data.statementMonth:monthNow();
    const stamp=sessionStamp(),generation=this._generation=(this._generation||0)+1;
    this.clearView();this.setData({loading:true,statementMonth:selectedMonth});
    try{
      const result=await api('/rewards');
      if(!this.current(generation,stamp))return;
      this._stamp=stamp;
      const balance=result.balance;
      const fields=['pendingCents','availableCents','reservedCents','paidCents','debtCents'];
      if(result.enabled===true&&(!balance||fields.some(key=>money(balance[key])==='')))throw new Error('奖励金额暂未核对，请稍后刷新。');
      const recipients=Array.isArray(result.verifiedRecipients)?result.verifiedRecipients.filter(item=>typeof item.id==='string'&&typeof item.maskedLabel==='string'):[];
      this.setData({loggedIn:true,enabled:result.enabled===true,reason:result.reason||'',
        balance:balance&&fields.every(key=>money(balance[key])!=='')?Object.fromEntries(fields.map(key=>[key,money(balance[key])])):null,
        entries:rows(result.entries),withdrawals:rows(result.withdrawals),recipients,
        canWithdraw:result.enabled===true&&result.canWithdraw===true&&recipients.length>0,
        minLabel:money(result.minWithdrawalCents)||'100.00',hasPending:!!this._pending});
      if(result.enabled===true)await this.loadStatement(generation,stamp,selectedMonth);
      else this.setData({statementReason:result.reason||'奖励账本尚未启用，暂无可查询账单。'});
      if(this._pending){
        const status=await api('/rewards/withdrawals/status?key='+encodeURIComponent(this._pending.key));
        if(!this.current(generation,stamp))return;
        if(status.found===true){this._pending=null;this.setData({hasPending:false,message:'提现申请已保存，请查看申请进度。'});}
        else this.setData({hasPending:true,message:'上次提交结果尚未确认，可刷新或重试原申请，请勿另建重复申请。'});
      }
    }catch(error){if(this.current(generation,stamp))this.setData({error:error.message||'暂时无法读取奖励记录，请刷新。',hasPending:!!this._pending});}
    finally{if(this.current(generation,stamp))this.setData({loading:false});}
  },
  async loadStatement(generation=this._generation,stamp=this._stamp,month=this.data.statementMonth){
    if(!stamp||!this.current(generation,stamp)||!this.data.enabled)return;
    const request=this._statementRequest=(this._statementRequest||0)+1;
    const active=()=>this.current(generation,stamp)&&request===this._statementRequest;
    this.setData({statement:null,statementLoading:true,statementError:'',statementReason:'',statementMonth:month,statementEnd:monthNow()});
    try{
      const result=await api('/rewards/statements?month='+encodeURIComponent(month));
      if(!active())return;
      if(result.enabled!==true){this.setData({statementReason:result.reason||'账单尚未启用，请稍后查询。'});return;}
      this.setData({statement:statementView(result.statement,month)});
    }catch(error){if(active())this.setData({statementError:error.message||'月账单暂未读取，请重试。'});}
    finally{if(active())this.setData({statementLoading:false});}
  },
  changeMonth(event){
    if(this.data.loading||this.data.busy||!this.data.enabled)return;
    const month=event.detail.value;
    if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'1970-01'||month>monthNow()){this.setData({statementError:'请选择已经开始的账单月份。'});return;}
    return this.loadStatement(this._generation,this._stamp,month);
  },
  retryStatement(){if(!this.data.loading&&!this.data.busy)return this.loadStatement();},
  async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh();}},
  changeAmount(event){if(!this.data.busy&&!this._pending)this.setData({amount:event.detail.value,error:''});},
  changeRecipient(event){if(!this.data.busy&&!this._pending)this.setData({recipientIndex:Number(event.detail.value),error:''});},
  changeConsent(event){if(!this.data.busy&&!this._pending)this.setData({consent:event.detail.value.includes('agree')});},
  async submit(){
    if(this.data.busy||this.data.loading||this._pending||this._confirming||!this.data.canWithdraw)return;
    const stamp=this._stamp,generation=this._generation;
    if(!stamp||!this.current(generation,stamp)){this.clearView();return;}
    let input;this._confirming=true;
    try{
      const recipient=this.data.recipients[this.data.recipientIndex];
      if(!recipient||!this.data.consent)throw new Error('请选择已登记的收款方式，并确认提现说明。');
      input={amountCents:amount(this.data.amount),recipientRef:recipient.id};
      const decision=await new Promise((resolve,reject)=>wx.showModal({title:'提交提现申请',content:'申请金额 ¥'+money(input.amountCents)+'。需经财务审核与秘书长审批；审批通过后仍需实际打款。',confirmText:'提交申请',success:resolve,fail:reject}));
      if(!this.current(generation,stamp)||!decision.confirm)return;
      await this.send({key:newKey(),input,stamp},generation);
    }catch(error){if(this.current(generation,stamp))this.setData({error:error.message||'提现申请未提交。'});}
    finally{this._confirming=false;}
  },
  async retryPending(){
    if(this.data.busy||this.data.loading||!this._pending)return;
    if(!this.current(this._generation,this._pending.stamp)){this._pending=null;this.clearView();return;}
    return this.send(this._pending,this._generation);
  },
  async send(pending,generation){
    this._pending=pending;this.setData({busy:true,error:'',message:'',hasPending:true});
    try{
      await api('/rewards/withdrawals',pending.input,pending.key);
      if(!this.current(generation,pending.stamp))return;
      this._pending=null;this.setData({busy:false,hasPending:false,amount:'',consent:false});
      await this.refresh();
      if(!this._hidden&&!this._unloaded&&isCurrentSession(pending.stamp))this.setData({message:'提现申请已保存，审批不代表已到账。'});
    }catch(error){
      if(!this.current(generation,pending.stamp))return;
      // Definite business rejection can be edited; ambiguous transport errors keep
      // the original non-sensitive recipient reference and key for safe retry.
      const status=error.status||error.statusCode;
      if(status>=400&&status<500){this._pending=null;this.setData({hasPending:false,error:error.message||'提现申请未通过校验。'});}
      else this.setData({hasPending:true,error:'提交结果尚未确认，请刷新进度或重试原申请。'});
    }finally{if(this.current(generation,pending.stamp))this.setData({busy:false});}
  },
  openLogin(){wx.navigateTo({url:'/pages/login/index?returnTo='+encodeURIComponent('/pages/rewards/index')});},
  openFeedback(){wx.navigateTo({url:'/pages/feedback/index'});}
});
