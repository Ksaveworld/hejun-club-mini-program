# GRANT-03 实际 HTTP 前端适配

本增量在 GRANT-02 页面上接入真实 HTTP 网关，不修改宿主导航、认证端点或共享路由。导出：

```ts
import {createGrantHttpGateway} from './grants/http-gateway';
const gateway=createGrantHttpGateway({
  actorId: currentAdmin.id,
  checkSession: async () => {
    const current=await readExistingAdminSession();
    return {actorId:current.user?.id ?? '',canGrant:current.user?.role==='admin'};
  }
});
// <GrantPage actorId={currentAdmin.id} gateway={gateway} mode="connected" />
```

`readExistingAdminSession` 是宿主现有后台会话读取方法的示意名，接入者必须映射到真实端点。不能用页面缓存用户或固定 `canGrant:true` 替代当前服务端会话。后台每项操作仍独立重新授权。

## 请求与响应

- 默认路径 `/api/admin/membership-grants`；只允许同源相对路径。
- POST 自动带 JSON、`x-club-request:1`、当前 `x-club-actor`，使用浏览器同源 Cookie。Origin 由浏览器产生，不手造凭据。
- 基础/星级必须显式选择；预检/确认原样传递 level。服务器 `actorId` 映射页面 actor；scheduled/expired 映射未撤销记录，页面依实际起止显示未开始/已到期。
- lookup 只将服务端可靠核验成功的一项绑定映射为 matches；姓名显示稳定 userId，不编造个人姓名。手机号只展示返回的脱敏值。
- revoke 请求只传 reason；页面本地恢复编号、userId 不发送给撤销接口。
- 采用 15 秒请求超时，不自动重试。超时、网络中断、503、无效 JSON、畸形成功或成功返回后账号变化均视为结果未确认。

## 恢复行为

页面在首次写请求前保存原请求和编号。新增“核对原操作结果”先调用 `recover(pending)`：

1. 赠送按原 idempotencyKey GET `/operations/:key`；committed 映射原记录，unknown 保留待核对，不能当成失败或生成新编号。
2. 撤销按保存的 userId 分页读取历史并定位 grantId；查到已撤销才确认。旧恢复记录缺 userId 时返回 unknown，不伪造结果。
3. 明确选择“核对并重试原操作”时，只重放原请求/原编号；撤销以原 grantId 重放。
4. 恢复过程中的拒绝也不清除原未知结果；否则原请求可能已成功，后续权限失效会错误丢失恢复依据。
5. 未知结果期间保持表单锁定。确认结果后清理当前管理员的本地恢复记录；刷新历史失败不把已完成写操作当作未完成。

## 实测边界

`tests/ui/grant-http-gateway.test.mjs` 使用真实 Node HTTP、现有权限和赠送服务、内存虚构数据库。通过实际服务提交后丢弃 HTTP 响应，验证按原编号恢复且数据库只有一条记录。该测试验证 HTTP 适配，不等于已完成宿主导航、浏览器控件、手机或真实 PostgreSQL 并发验收；后者由集成验证分别记录。

本增量不启用生产写开关、不修改真实账号、不部署。
