# GRANT-01：既有虚拟支付测试失败核对

日期：2026-10-28。范围：三个指定的既有虚拟支付测试，只读诊断共享实现；没有修改共享支付源码或原测试。使用 Node 24、内存 PGlite、虚构微信响应和本机 HTTP；未调用真实支付、微信服务或客户数据库。

## 结果

当前工作区与冻结基线 `306d1ac53f06ff8315c35e7a05673a9abaf1d241` 的独立 Git archive 快照，分别运行下列定向命令，均为 **3 项失败，0 项通过**；基线运行约 5.1 秒结束，没有挂起：

```sh
node --test --test-name-pattern='missing availability|issued virtual parameters|authority query activates' --test-timeout=30000 tests/server/postgres-virtual-payment.test.mjs
```

| 测试 | 实际失败 | 定位 |
| --- | --- | --- |
| `missing availability cannot issue parameters...` | 恢复后 `delivery_state` 仍为 `pending`，预期 `confirmed` | 测试第 111 行；假微信发货接口与当前实现的签名约定冲突 |
| `issued virtual parameters cannot be locally cancelled...` | 取消返回 HTTP 200，预期 409 | 测试第 159 行；测试仍要求禁止已发参数订单的本地取消，当前实现已允许部分权威状态下关闭本地申请 |
| `authority query activates once...` | 恢复后 `delivery_state` 仍为 `pending`，预期 `confirmed` | 测试第 189 行；同第一项签名夹具冲突 |

这些失败在赠送模块改动之前已存在；不能把它们计为本轮赠送引入的回归，也不能因此忽略整个产品的发布风险。当前只能确认上述三个失败归因，不代表全仓测试已经通过。

## 直接原因与对照实验

### 发货恢复两项

`tests/server/postgres-virtual-payment.test.mjs` 的假微信接口，在 `/xpay/notify_provide_goods` 分支断言 URL **没有** `pay_sig`；而 `server/wechat-virtual-pay.mjs` 的 `confirmDelivery` 明确调用 `call(DELIVER, ..., {signed:true,noPayload:true})`。

假接口断言失败被适配器按上游失败处理，因此发货未确认且持久化状态保留 `pending`。它不是本次检查观察到的时钟过期：夹具使用当前 `Date.now()`，付款时间以秒取整；实现已按订单创建时间的秒粒度验证。

在冻结快照内单独生成临时诊断测试副本，只把该夹具断言改为核对当前实现发送的 HMAC 签名，其余测试和全部产品源码保持原样。定向执行这两项结果为 **2/2 通过，约 3.3 秒**。这个对照证明当前失败由夹具/实现不一致触发；不证明现有发货请求符合微信最新协议。

候选修复：由支付接入负责人核对适用的官方发货协议，明确该接口签名约定，再同步适配器及夹具。若保留当前已签名实现，夹具应验证正确签名，不能简单删除断言。保留失败恢复、重复查单和进程重建的行为测试。

### 本地取消一项

`server/postgres-virtual-payment.mjs` 的 `cancel` 当前接受权威查询状态 `[0,1,6]`，对 0/1 只关闭本地申请并记录 `virtual_application_cancelled`，保留支付尝试，以便晚到真实付款转 `needs_reconciliation`。旧测试仍要求发出收银台参数后一律拒绝本地取消，因此立即在 200/409 断言处失败。

候选修复：先以已确认业务规则核对本地取消策略，再修正旧测试或实现。若当前本地关闭申请策略应保留，需分别验证权威未付款的本地取消、关停支付渠道时的处理、权威关闭后的取消，以及本地取消后晚到真实付款的持久化对账；不能把所有 409 机械改为 200。该问题不应通过修改赠送模块来规避。

## 基线一致性证据

以下文件的当前 Git blob 与冻结提交相同：

| 文件 | Git blob |
| --- | --- |
| `tests/server/postgres-virtual-payment.test.mjs` | `4d1024a6001c11aeff7dea4238207b791350227e` |
| `server/postgres-virtual-payment.mjs` | `7716d4a8c91f4170e4a52752306c727f991981ff` |
| `server/wechat-virtual-pay.mjs` | `28b6192244ab8c0ebd1ae2e36bd8c963ffee8f18` |
| `server/postgres-core.mjs` | `0fef563c04764cbcdc0058a96368302c9bcbf430` |
| `server/postgres-app.mjs` | `1e1564b09761fab2290e28be233b67eca05ea765` |

原始冻结快照与修改夹具的临时诊断副本分开保留，未把诊断副本作为产品修复提交。定向执行有 30 秒测试上限；没有重跑全部服务端测试。本记录不改变支付启用、真实收款或发布授权。
