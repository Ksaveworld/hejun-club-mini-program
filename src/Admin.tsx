import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ClipboardList,
  FileText,
  Search,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { plans } from "./data";
import type { DemoOrder, DemoState, OrderStatus } from "./types";
import "./admin.css";

type AdminTab = "orders" | "applications" | "posts";

const orderStatusLabels: Record<OrderStatus, string> = {
  pending: "待模拟付款",
  paid: "模拟已开通",
  cancelled: "已取消",
  review: "待业务确认",
};
const postStatusLabels = {
  pending: "待审核",
  published: "已通过",
  rejected: "已驳回",
};
const tabs: { id: AdminTab; label: string }[] = [
  { id: "orders", label: "会员订单" },
  { id: "applications", label: "机构与星级申请" },
  { id: "posts", label: "内容审核" },
];

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function OrderDetails({ order }: { order: DemoOrder }) {
  const fields = [
    ["订单编号", order.id],
    ["联系电话", order.form.phone],
    ["城市", order.form.city],
    ["企业 / 机构", order.form.company],
    ["所属行业", order.form.industry],
    [
      "申请身份",
      order.planId === "organization"
        ? order.form.organizationType
        : plans.find((plan) => plan.id === order.planId)?.name,
    ],
    ["推荐码", order.form.referral],
    ["提交时间", formatDate(order.createdAt)],
    ["模拟开通时间", formatDate(order.paidAt)],
    ["演示有效期至", formatDate(order.expiresAt)],
    ["跨境需求", order.form.need],
  ];
  return (
    <div className="admin-detail-panel">
      <dl className="admin-detail-grid">
        {fields.map(([label, value]) => (
          <div
            key={label}
            className={label === "跨境需求" ? "admin-detail-wide" : ""}
          >
            <dt>{label}</dt>
            <dd>{value || "未填写"}</dd>
          </div>
        ))}
      </dl>
      {order.status === "review" && (
        <p className="admin-inline-note">
          申请已记录。星级及机构会员的审核、收款和开通规则待业务确认。
        </p>
      )}
    </div>
  );
}

export default function Admin({
  state,
  onReviewPost,
  onReset,
}: {
  state: DemoState;
  onReviewPost: (
    id: string,
    status: "published" | "rejected",
    reason?: string,
  ) => void;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<AdminTab>("orders");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");

  const paidMembers = new Set(
    state.orders
      .filter((order) => order.status === "paid")
      .map((order) => order.form.phone),
  ).size;
  const stats = [
    {
      label: "模拟会员数",
      value: paidMembers,
      icon: Users,
      note: "按已开通手机号去重",
    },
    {
      label: "待模拟付款",
      value: state.orders.filter((order) => order.status === "pending").length,
      icon: Wallet,
      note: "尚未完成演示付款",
    },
    {
      label: "待审核申请",
      value: state.orders.filter((order) => order.status === "review").length,
      icon: ClipboardList,
      note: "等待业务确认规则",
    },
    {
      label: "待审投稿",
      value: state.posts.filter((post) => post.status === "pending").length,
      icon: FileText,
      note: "可体验通过或驳回",
    },
  ];
  const searchTerm = query.trim().toLocaleLowerCase();
  const sourceOrders = state.orders.filter(
    (order) => tab !== "applications" || order.planId !== "basic",
  );
  const filteredOrders = sourceOrders
    .filter(
      (order) =>
        (status === "all" || order.status === status) &&
        [order.form.name, order.form.phone, order.id].some((value) =>
          value.toLocaleLowerCase().includes(searchTerm),
        ),
    )
    .slice()
    .reverse();
  const filteredPosts = state.posts
    .filter(
      (post) =>
        (status === "all" || post.status === status) &&
        [post.title, post.author, post.id].some((value) =>
          value.toLocaleLowerCase().includes(searchTerm),
        ),
    )
    .slice()
    .reverse();
  const resultCount =
    tab === "posts" ? filteredPosts.length : filteredOrders.length;
  const hasFilter = query.trim() !== "" || status !== "all";

  function switchTab(next: AdminTab) {
    setTab(next);
    setQuery("");
    setStatus("all");
    setExpanded(null);
    setFeedback("");
  }

  function reviewPost(id: string, nextStatus: "published" | "rejected") {
    const reason = (reasons[id] || "").trim();
    if (nextStatus === "rejected" && !reason) {
      setErrors((previous) => ({
        ...previous,
        [id]: "请填写驳回理由，让投稿人知道需要修改什么。",
      }));
      return;
    }
    setErrors((previous) => ({ ...previous, [id]: "" }));
    onReviewPost(
      id,
      nextStatus,
      nextStatus === "rejected" ? reason : undefined,
    );
    setFeedback(
      nextStatus === "published"
        ? "演示投稿已通过，会员端可查看审核结果。"
        : "演示投稿已驳回，理由已保存。",
    );
  }

  return (
    <div className="admin-page">
      <div className="admin-topline">
        <a className="text-button admin-back" href="#/">
          <ArrowLeft size={16} />
          返回会员端
        </a>
        <span className="admin-preview-mark">
          <span />
          本机演示
        </span>
      </div>
      <header className="admin-header">
        <div>
          <p className="eyebrow">CLUB OPERATIONS</p>
          <h1 id="page-title" tabIndex={-1}>
            运营工作台
          </h1>
          <p className="admin-description">
            当前浏览器的演示记录 · 正式管理员登录尚未接入
          </p>
        </div>
        <button className="button secondary admin-reset" onClick={onReset}>
          <Trash2 size={15} />
          清空本机演示记录
        </button>
      </header>

      <section className="admin-stats" aria-label="演示数据概览">
        {stats.map(({ label, value, icon: Icon, note }) => (
          <div className="admin-stat" key={label}>
            <div className="admin-stat-heading">
              <span>{label}</span>
              <Icon size={19} />
            </div>
            <strong>
              {value}
              <span> {label === "模拟会员数" ? "人" : "条"}</span>
            </strong>
            <p>{note}</p>
          </div>
        ))}
      </section>

      <section className="admin-records" aria-label="业务记录">
        <div className="admin-tabs" role="tablist" aria-label="业务分类">
          {tabs.map((item) => (
            <button
              key={item.id}
              id={`admin-tab-${item.id}`}
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="admin-record-panel"
              tabIndex={tab === item.id ? 0 : -1}
              className={
                tab === item.id ? "admin-tab admin-tab-active" : "admin-tab"
              }
              onClick={() => switchTab(item.id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const index = tabs.findIndex((value) => value.id === tab);
                const targetIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          tabs.length) %
                        tabs.length;
                const next = tabs[targetIndex];
                switchTab(next.id);
                document.getElementById(`admin-tab-${next.id}`)?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="admin-record-panel"
          aria-labelledby={`admin-tab-${tab}`}
        >
          <div className="admin-toolbar">
            <label className="admin-search">
              <Search size={17} aria-hidden="true" />
              <span className="admin-sr-only">
                {tab === "posts"
                  ? "搜索标题、作者或投稿编号"
                  : "搜索姓名、电话或订单号"}
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  tab === "posts"
                    ? "搜索标题、作者或投稿编号"
                    : "搜索姓名、电话或订单号"
                }
              />
            </label>
            <label className="admin-filter">
              <span>状态</span>
              <select
                aria-label="筛选记录状态"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">全部状态</option>
                {Object.entries(
                  tab === "posts" ? postStatusLabels : orderStatusLabels,
                ).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="admin-result-count" aria-live="polite">
              共 {resultCount} 条
            </span>
          </div>

          {tab === "applications" && (
            <p className="admin-context-note">
              星级和机构申请集中在这里查看。当前仅记录申请，后续审核及开通方式待业务确认。
            </p>
          )}
          {tab === "posts" && (
            <p className="admin-context-note">
              审核操作仅为流程演示，结果保存在当前浏览器。通过的投稿可在会员端查看。
            </p>
          )}
          <p className="admin-feedback" role="status">
            {feedback}
          </p>

          {resultCount === 0 ? (
            <div className="admin-empty">
              {hasFilter ? (
                <Search size={30} strokeWidth={1.4} />
              ) : (
                <ClipboardList size={32} strokeWidth={1.4} />
              )}
              <h2>
                {hasFilter
                  ? "没有找到匹配记录"
                  : tab === "posts"
                    ? "还没有投稿记录"
                    : tab === "applications"
                      ? "还没有入会申请"
                      : "第一笔演示订单，从会员端开始"}
              </h2>
              <p>
                {hasFilter
                  ? "换一个关键词或状态，再试一次。"
                  : tab === "posts"
                    ? "在会员中心提交一篇演示投稿，即可在这里体验审核。"
                    : "提交后的记录会出现在这里，你可以查看申请资料和当前状态。"}
              </p>
              {hasFilter ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    setQuery("");
                    setStatus("all");
                  }}
                >
                  清除筛选
                </button>
              ) : (
                <a
                  className="button secondary"
                  href={tab === "posts" ? "#/account" : "#/members"}
                >
                  前往会员端
                  <ArrowUpRight size={16} />
                </a>
              )}
            </div>
          ) : tab === "posts" ? (
            <div className="admin-post-list">
              {filteredPosts.map((post) => (
                <article className="admin-post" key={post.id}>
                  <div className="admin-post-head">
                    <div>
                      <span className="admin-post-author">
                        投稿人 · {post.author}
                      </span>
                      <h2>{post.title}</h2>
                    </div>
                    <span className={`status-pill admin-status-${post.status}`}>
                      {postStatusLabels[post.status]}
                    </span>
                  </div>
                  <p className="admin-post-body">{post.body}</p>
                  {post.reason && (
                    <p className="admin-rejection">
                      <strong>驳回理由：</strong>
                      {post.reason}
                    </p>
                  )}
                  {post.status === "pending" && (
                    <div className="admin-review-controls">
                      <label htmlFor={`reason-${post.id}`}>
                        驳回理由 <span>驳回时必填</span>
                      </label>
                      <textarea
                        id={`reason-${post.id}`}
                        rows={2}
                        maxLength={500}
                        value={reasons[post.id] || ""}
                        placeholder="例如：请补充企业介绍和具体合作需求。"
                        aria-invalid={Boolean(errors[post.id])}
                        aria-describedby={
                          errors[post.id] ? `error-${post.id}` : undefined
                        }
                        onChange={(event) => {
                          setReasons((previous) => ({
                            ...previous,
                            [post.id]: event.target.value,
                          }));
                          setErrors((previous) => ({
                            ...previous,
                            [post.id]: "",
                          }));
                        }}
                      />
                      {errors[post.id] && (
                        <p
                          className="admin-error"
                          id={`error-${post.id}`}
                          role="alert"
                        >
                          {errors[post.id]}
                        </p>
                      )}
                      <div className="admin-review-actions">
                        <button
                          className="button secondary"
                          onClick={() => reviewPost(post.id, "rejected")}
                        >
                          <X size={16} />
                          驳回投稿
                        </button>
                        <button
                          className="button primary"
                          onClick={() => reviewPost(post.id, "published")}
                        >
                          <Check size={16} />
                          通过投稿
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <caption className="admin-sr-only">
                  {tab === "orders" ? "会员订单记录" : "机构与星级申请记录"}
                </caption>
                <thead>
                  <tr>
                    <th>申请人</th>
                    <th>会员套餐</th>
                    <th>演示金额</th>
                    <th>状态</th>
                    <th>提交时间</th>
                    <th>推荐码</th>
                    <th>
                      <span className="admin-sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => (
                    <OrderRows
                      key={order.id}
                      order={order}
                      expanded={expanded === order.id}
                      onToggle={() =>
                        setExpanded(expanded === order.id ? null : order.id)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <footer className="admin-footer">
        <span>中国—东盟跨境企业家俱乐部</span>
        <span>一期页面样稿 · 所有款项均为模拟</span>
      </footer>
    </div>
  );
}

function OrderRows({
  order,
  expanded,
  onToggle,
}: {
  order: DemoOrder;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={
          expanded ? "admin-order-row admin-order-expanded" : "admin-order-row"
        }
      >
        <td data-label="申请人">
          <div className="admin-person">
            <strong>{order.form.name}</strong>
            <span>{order.form.phone}</span>
          </div>
        </td>
        <td data-label="会员套餐">
          {plans.find((plan) => plan.id === order.planId)?.name || order.planId}
        </td>
        <td data-label="演示金额" className="admin-amount">
          ¥{order.amount.toLocaleString("zh-CN")}
        </td>
        <td data-label="状态">
          <span className={`status-pill admin-status-${order.status}`}>
            {orderStatusLabels[order.status]}
          </span>
        </td>
        <td data-label="提交时间" className="admin-date">
          {formatDate(order.createdAt)}
        </td>
        <td data-label="推荐码" className="admin-referral">
          {order.form.referral || "—"}
        </td>
        <td className="admin-order-action">
          <button
            className="text-button admin-detail-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`details-${order.id}`}
            aria-label={`${expanded ? "收起" : "查看"}${order.form.name}的订单详情`}
          >
            {expanded ? "收起" : "详情"}
            <ChevronDown
              size={15}
              className={expanded ? "admin-chevron-open" : ""}
            />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="admin-detail-row" id={`details-${order.id}`}>
          <td colSpan={7}>
            <OrderDetails order={order} />
          </td>
        </tr>
      )}
    </>
  );
}
