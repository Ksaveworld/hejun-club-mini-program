const {api,hasSession,sessionStamp,isCurrentSession,money,paymentLoginCode}=require('../../utils/api');
const {legalConsent}=require('../../utils/legal');
const {openPublicDocument,showPublicDocuments,hidePublicDocuments,clearPublicDocuments}=require('../../utils/public-documents');
const {orderMembership,orderAftercare,memberNextStep}=require('../../utils/membership-display');
const {chineseDateTime}=require('../../utils/display-time');
const reconciliationMessage='已收到付款，需人工核对，请勿重复付款';
function needsReconciliation(order){return order?.paymentReconciliationRequired===true||order?.cancellation?.paymentReconciliationRequired===true;}
function paymentOrder(order){return Object.assign({},order,orderMembership(order),orderAftercare(order),{
  paymentReconciliationRequired:needsReconciliation(order),
  hasMemberNextStep:orderAftercare(order).hasMemberNextStep&&!needsReconciliation(order),
  refundCompletedLabel:order.aftercare?.refundCompletedAt?chineseDateTime(order.aftercare.refundCompletedAt):'',
  previousExpiryLabel:order.renewal?chineseDateTime(order.renewal.previousExpiresAt):'',
  expiryLabel:order.expiresAt?chineseDateTime(order.expiresAt):''
});}
function paymentResultMessage(order,exitedCashier=false){
  if(needsReconciliation(order))return reconciliationMessage;
  if(order.status==='cancelled')return '订单已取消，不能继续付款。原申请与订单记录已保留。';
  const aftercare=orderAftercare(order);
  if(aftercare.hasAftercare)return aftercare.aftercareMessage;
  if(order.status==='paid')return order.transactionKind==='renewal'?'微信支付已核实，同档续费已完成，请查看最新有效期':'微信支付已核实，会员权益已开通';
  return exitedCashier?'已退出收银台，订单已保留。未完成付款可点“重新办理付款”，原资料会自动带入；如已扣款，请先刷新核对，勿重复付款。':'付款结果核对中，尚未确认到账，请稍后刷新；若已扣款，请勿再次付款';
}
Page({
  data:{order:null,memberNextStep,hasMemberNextStep:false,amountLabel:'',enabled:false,paymentChannel:'ordinary',legal:null,legalReady:false,legalAccepted:false,
    policy:false,hongKong:false,details:false,loading:false,busy:false,error:'',message:'',
    clipboardBusy:false,showClipboardPrivacy:false,clipboardRequestId:'',privacyContractName:'《小程序用户隐私保护指引》'},
  onLoad(options){this._id=/^[A-Z0-9]+$/.test(options.id||'')?options.id:'';this._statusRequest=0;this._operationSequence=0;this._operation=null;this._clipboardGeneration=0;this._clipboardSequence=0;},
  onShow(){this._hidden=false;showPublicDocuments(this);return this.load();},
  onHide(){this._hidden=true;this.setData({hasMemberNextStep:false,message:''});this.clearClipboard();hidePublicDocuments(this);},
  onUnload(){this._disposed=true;this._clipboardGeneration++;this._clipboardRequest=null;clearPublicDocuments(this);},
  async onPullDownRefresh(){try{await this.load();}finally{wx.stopPullDownRefresh();}},
  assertContext(stamp){if(this._disposed || !hasSession() || !stamp || !isCurrentSession(stamp))throw new Error('登录状态已变化，请重新登录并刷新订单');},
  clearPaymentContext(){
    this._statusRequest++;this._operation=null;this._stamp=null;this.clearClipboard();
    this.setData({order:null,amountLabel:'',hasMemberNextStep:false,enabled:false,paymentChannel:'ordinary',
      legal:null,legalReady:false,legalAccepted:false,policy:false,hongKong:false,details:false,loading:false,busy:false,error:'',message:''});
  },
  clearChangedContext(){if(this._stamp&&(!hasSession()||!isCurrentSession(this._stamp)))this.clearPaymentContext();},
  beginOperation(){const operation={stamp:this._stamp,id:++this._operationSequence};this._operation=operation;this.setData({busy:true,error:'',message:''});return operation;},
  operationCurrent(operation){return !this._disposed&&this._operation===operation&&!!operation?.stamp&&hasSession()&&isCurrentSession(operation.stamp);},
  assertOperation(operation){if(!this.operationCurrent(operation))throw new Error('登录状态已变化，请重新登录并刷新订单');},
  readFailure(error,request){if(this._disposed||request!==this._statusRequest)return;
    if(!hasSession()||!isCurrentSession(this._stamp)||error.status===401||error.statusCode===401)this.clearPaymentContext();
    this.setData({error:error.message||'暂时无法核实，请稍后刷新'});
  },
  async load(){
    if(this._disposed)return;
    // Clear the previous identity before an in-flight cashier/read can block refresh.
    this.clearChangedContext();
    if(this.data.loading||this.data.busy)return;
    if(!this._id){this.setData({error:'订单编号不正确'});return;}
    this.clearClipboard();
    const request=++this._statusRequest;
    this.setData({loading:true,error:'',message:'',enabled:false,order:null,hasMemberNextStep:false,legalReady:false,legalAccepted:false,policy:false,hongKong:false,details:false});
    const stamp=sessionStamp();
    if(this._stamp && !isCurrentSession(this._stamp))this.setData({message:''});
    this._stamp=stamp;
    try{
      this.assertContext(stamp);
      const payment=await api('/orders/'+this._id+'/payment-status');
      if(request!==this._statusRequest)return;
      this.assertContext(stamp);
      this.setData({order:paymentOrder(payment.order),hasMemberNextStep:paymentOrder(payment.order).hasMemberNextStep,amountLabel:money((payment.order).amountCents),
        enabled:payment.enabled===true,paymentChannel:payment.paymentChannel||'ordinary',legal:payment.legal,legalReady:true,legalAccepted:payment.legalAccepted===true});
    }catch(error){this.readFailure(error,request);}
    finally{if(!this._disposed&&request===this._statusRequest)this.setData({loading:false});}
  },
  agreeLegal(event){if(this.data.busy)return;const id=event.currentTarget.dataset.id;if(['policy','hongKong','details'].includes(id))this.setData({[id]:event.detail.value.length>0,error:''});},
  async openLegal(event){try{await openPublicDocument('/legal/'+event.currentTarget.dataset.id+'/document','pdf',this);}catch(error){if(!this._disposed)this.setData({error:error.message});}},
  async acceptLegal(){
    if(this._disposed)return;
    this.clearChangedContext();
    if(this.data.busy||this.data.loading||!this.data.order||needsReconciliation(this.data.order)||!this._stamp)return;
    const operation=this.beginOperation();
    try{
      this.assertOperation(operation);
      const consent=legalConsent(this.data);
      if(!this.data.details)throw new Error('请确认订单联系资料、方案和金额无误');
      await api('/orders/'+this._id+'/legal-consent',{...consent,detailsConfirmed:true});
      this.assertOperation(operation);this.setData({legalAccepted:true});
    }catch(error){if(this.operationCurrent(operation))this.setData({error:error.message});}
    finally{if(this.operationCurrent(operation)){this._operation=null;this.setData({busy:false});}}
  },
  async payWechat(){
    if(this._disposed)return;
    this.clearChangedContext();
    if(this.data.busy||this.data.loading||this.data.clipboardBusy||this.data.showClipboardPrivacy||!this.data.enabled||this.data.order?.status!=='pending'||needsReconciliation(this.data.order))return;
    if(this.data.order.paymentAttempted)return this.reapplyPayment();
    const operation=this.beginOperation();
    let exitedCashier=false;
    try{
      this.assertOperation(operation);
      const latest=await api('/orders/'+this._id+'/payment-status');
      this.assertOperation(operation);
      const checked=paymentOrder(latest.order);
      this.setData({order:checked,hasMemberNextStep:checked.hasMemberNextStep,enabled:latest.enabled===true,
        paymentChannel:latest.paymentChannel||'ordinary',legal:latest.legal,legalAccepted:latest.legalAccepted===true});
      if(needsReconciliation(checked)){this.setData({message:reconciliationMessage});return;}
      if(checked.status!=='pending'||latest.enabled!==true||checked.paymentAttempted)throw new Error('订单付款状态已变化，请刷新核对后再操作');
      if(this.data.legal&&!this.data.legalAccepted)throw new Error('请先确认订单资料与协议');
      const channel=this.data.paymentChannel;
      if(!['ordinary','virtual'].includes(channel))throw new Error('支付渠道尚未确认，请刷新订单后重试');
      const body={};
      if(channel==='virtual'){
        if(typeof wx.requestVirtualPayment!=='function'||(wx.canIUse&&!wx.canIUse('requestVirtualPayment')))
          throw new Error('当前微信版本不支持虚拟支付，请更新微信后重试；本次未发起付款');
        if(typeof paymentLoginCode!=='function')throw new Error('支付身份服务正在更新，请重新打开小程序');
        body.code=await paymentLoginCode(()=>this.operationCurrent(operation));
        this.assertOperation(operation);
      }
      const result=await api('/orders/'+this._id+'/payment',body);
      this.assertOperation(operation);
      if(needsReconciliation(result.order)){const checked=paymentOrder(result.order);this.setData({order:checked,hasMemberNextStep:false,message:reconciliationMessage});return;}
      if((result.paymentChannel||'ordinary')!==channel)throw new Error('支付渠道已变化，请刷新订单核对结果');
      if(channel==='virtual'){
        const params=result.payment;
        if(params?.mode!=='short_series_goods'||typeof params.signData!=='string'||!params.signData
          ||!/^[a-f0-9]{64}$/.test(params.paySig||'')||!/^[a-f0-9]{64}$/.test(params.signature||''))
          throw new Error('虚拟支付参数未确认，请刷新订单结果');
        await new Promise((resolve,reject)=>wx.requestVirtualPayment({...params,success:resolve,fail:reject}));
      }else await new Promise((resolve,reject)=>wx.requestPayment({...result.payment,success:resolve,fail:reject}));
      this.assertOperation(operation);
      this.setData({message:'付款结果核对中，请勿重复付款'});
    }catch(error){exitedCashier=error.errCode===-2||!!error.errMsg?.includes('cancel');if(this.operationCurrent(operation))this.setData({error:exitedCashier?'已退出收银台，请刷新确认订单状态':error.message||'支付结果暂未确认，请刷新订单，勿重复付款'});}
    finally{
      if(this.operationCurrent(operation)){
        this.setData({busy:false});
        const request=++this._statusRequest;
        try{const result=await api('/orders/'+this._id+'/payment-status');if(request!==this._statusRequest||!this.operationCurrent(operation))return;const updated=paymentOrder(result.order);this.setData({order:updated,hasMemberNextStep:updated.hasMemberNextStep,enabled:result.enabled===true,paymentChannel:result.paymentChannel||'ordinary',message:paymentResultMessage(result.order,exitedCashier)});}
        catch(error){if(this.operationCurrent(operation))this.readFailure(error,request);}
        finally{if(this._operation===operation)this._operation=null;}
      }
    }
  },
  async reapplyPayment(){
    this.clearChangedContext();
    const order=this.data.order;
    if(this._disposed||this.data.busy||this.data.loading||!order||order.status!=='pending'||!order.paymentAttempted||needsReconciliation(order))return;
    const operation=this.beginOperation();
    try{
      this.assertOperation(operation);
      const decision=await new Promise((resolve,reject)=>wx.showModal({title:'重新办理付款？',content:'将取消这笔未付款订单，自动带入原资料。核对资料和协议后生成新订单付款，无需重新填写。如已扣款，请先核对支付结果。',confirmText:'继续办理',cancelText:'暂不办理',success:resolve,fail:reject}));
      this.assertOperation(operation);if(!decision.confirm)return;
      const latest=await api('/orders/'+this._id+'/payment-status');
      this.assertOperation(operation);
      const checked=paymentOrder(latest.order);
      this.setData({order:checked,hasMemberNextStep:checked.hasMemberNextStep});
      if(needsReconciliation(checked)){this.setData({message:reconciliationMessage});return;}
      if(checked.status!=='pending')throw new Error('订单状态已变化，请刷新核对后再操作');
      const result=await api('/orders/'+this._id+'/cancel',{});
      this.assertOperation(operation);
      const updated=paymentOrder(result.order);
      this.setData({order:updated,hasMemberNextStep:updated.hasMemberNextStep,message:paymentResultMessage(result.order)});
      if(result.order.status!=='cancelled'||needsReconciliation(result.order))throw new Error('原订单未确认可以重新办理，请刷新核对；如已扣款，请联系工作人员。');
      wx.redirectTo({url:'/pages/join/index?planId='+encodeURIComponent(order.planId)+'&reapplyId='+encodeURIComponent(order.id)+(order.transactionKind==='renewal'?'&transactionKind=renewal':'')});
    }catch(error){if(this.operationCurrent(operation))this.setData({error:error.message||'办理结果暂未确认，请刷新订单后核对，勿重复付款'});}
    finally{if(this.operationCurrent(operation)){this._operation=null;this.setData({busy:false});}}
  },
  clearClipboard(){this._clipboardGeneration++;this._clipboardRequest=null;this.setData({clipboardBusy:false,showClipboardPrivacy:false,clipboardRequestId:''});},
  clipboardCurrent(request){return this._clipboardRequest===request&&!this._disposed&&!this._hidden&&request.generation===this._clipboardGeneration
    &&hasSession()&&isCurrentSession(request.stamp)&&this.data.order?.id===request.orderId;},
  async copyOrder(){
    if(this.data.clipboardBusy||this.data.showClipboardPrivacy||this.data.loading||this.data.busy||!this.data.order||this._disposed||this._hidden||!isCurrentSession(this._stamp))return;
    const request={stamp:this._stamp,generation:this._clipboardGeneration,orderId:this.data.order.id,id:'order-'+(++this._clipboardSequence)+'-'+this._clipboardGeneration};
    this._clipboardRequest=request;this.setData({clipboardBusy:true,error:''});
    try{
      if(wx.getPrivacySetting){
        const privacy=await new Promise((resolve,reject)=>wx.getPrivacySetting({success:resolve,fail:reject}));
        if(!this.clipboardCurrent(request))return this.clipboardFailure(request,'登录状态已变化，请刷新订单后再复制');
        if(typeof privacy.needAuthorization!=='boolean')throw Error('invalid');
        if(privacy.needAuthorization){this.setData({clipboardBusy:false,showClipboardPrivacy:true,clipboardRequestId:request.id,
          privacyContractName:privacy.privacyContractName||'《小程序用户隐私保护指引》'});return;}
      }
      this.writeClipboard(request);
    }catch{this.clipboardFailure(request,'未能读取微信隐私授权状态，请稍后重新点击复制订单编号');}
  },
  agreeClipboardPrivacy(event){
    const request=this._clipboardRequest;
    if(!request||!this.data.showClipboardPrivacy||this.data.clipboardBusy||event?.currentTarget?.dataset?.privacyRequest!==request.id)return;
    if(!this.clipboardCurrent(request))return this.clipboardFailure(request,'登录状态已变化，请刷新订单后再复制');
    this.setData({showClipboardPrivacy:false,clipboardRequestId:'',clipboardBusy:true});this.writeClipboard(request);
  },
  cancelClipboardPrivacy(){
    const request=this._clipboardRequest;
    if(request&&this.data.showClipboardPrivacy)this.clipboardFailure(request,'未授权复制订单编号。订单保留，你仍可直接查看或联系客服');
  },
  openClipboardPrivacy(){
    const request=this._clipboardRequest;
    if(request&&this.clipboardCurrent(request)&&wx.openPrivacyContract)wx.openPrivacyContract({fail:()=>this.clipboardFailure(request,'微信隐私指引暂未打开，请稍后重试')});
  },
  writeClipboard(request){
    if(!this.clipboardCurrent(request))return this.clipboardFailure(request,'登录状态已变化，请刷新订单后再复制');
    wx.setClipboardData({data:request.orderId,success:()=>{
      if(this.clipboardCurrent(request)){this._clipboardRequest=null;this.setData({clipboardBusy:false,message:'订单编号已复制'});}
    },fail:()=>this.clipboardFailure(request,'订单编号未复制，可重新点击并按微信提示授权')});
  },
  clipboardFailure(request,message){
    if(this._clipboardRequest!==request||this._disposed||this._hidden||request.generation!==this._clipboardGeneration)return;
    this._clipboardRequest=null;this.setData({clipboardBusy:false,showClipboardPrivacy:false,clipboardRequestId:'',error:message});
  },
  openLogin(){wx.navigateTo({url:'/pages/login/index'});},
  openEnterprise(){if(this.data.hasMemberNextStep&&this.data.order?.status==='paid'&&!this._disposed&&!this._hidden&&hasSession()&&isCurrentSession(this._stamp))wx.navigateTo({url:'/pages/enterprise-intake/index'});},
  openHelp(){if(this._id)wx.navigateTo({url:'/pages/feedback/index?mode=new&relatedOrderId='+this._id});}
});
