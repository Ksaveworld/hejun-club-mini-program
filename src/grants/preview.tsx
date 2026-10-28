import { createRoot } from 'react-dom/client';
import { GrantPage } from './GrantPage';
import { createFixture } from './fixture';
const fixture = createFixture();
// Local preview only; test controls do not exist in the production entry/bundle.
Object.assign(window, { __grantFixture: fixture });
createRoot(document.getElementById('root')!).render(<>
  <nav className="grant-preview-guide" aria-label="模拟账号说明"><strong>本地页面验收 · 全部为虚构资料</strong><span>手机号示例：+9990000001</span><span>多匹配：+9990000099</span><span>缺绑定来源：+9990000004</span><span>可赠送：DEMO-001</span><span>已有会籍：DEMO-002</span><span>身份未核验：DEMO-003</span><span>多匹配：DEMO-MULTI</span></nav>
  <GrantPage actorId="demo-admin" gateway={fixture.api} mode="fixture" />
</>);
