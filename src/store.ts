import type { DemoState } from "./types";

export const storageKey = "china-asean-club-preview-v1";
export const emptyState = (): DemoState => ({
  version: 1,
  orders: [],
  posts: [],
  memberOrderId: null,
});

export function readState(): DemoState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (
      value?.version === 1 &&
      Array.isArray(value.orders) &&
      Array.isArray(value.posts) &&
      value.orders.every((o: unknown) => isOrder(o)) &&
      value.posts.every(
        (p: Record<string, unknown>) =>
          p &&
          typeof p.id === "string" &&
          typeof p.title === "string" &&
          typeof p.body === "string" &&
          typeof p.author === "string" &&
          ["pending", "published", "rejected"].includes(String(p.status)),
      )
    ) {
      return {
        ...value,
        memberOrderId:
          typeof value.memberOrderId === "string" ? value.memberOrderId : null,
      };
    }
  } catch {
    /* Unavailable or incompatible preview storage starts with an empty session. */
  }
  return emptyState();
}

function isOrder(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const f = o.form as Record<string, unknown> | undefined;
  return (
    typeof o.id === "string" &&
    ["basic", "star", "organization"].includes(String(o.planId)) &&
    ["pending", "paid", "cancelled", "review"].includes(String(o.status)) &&
    typeof o.amount === "number" &&
    Number.isFinite(o.amount) &&
    typeof o.createdAt === "string" &&
    Number.isFinite(Date.parse(o.createdAt)) &&
    (o.status !== "paid" ||
      (typeof o.expiresAt === "string" &&
        Number.isFinite(Date.parse(o.expiresAt)))) &&
    f &&
    [
      "name",
      "phone",
      "city",
      "company",
      "industry",
      "need",
      "referral",
      "organizationType",
    ].every((k) => typeof f[k] === "string")
  );
}

export function saveState(state: DemoState): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function newId(prefix: string) {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}
export const money = (amount: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(amount);
export const dateLabel = (date?: string) =>
  date
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(date))
    : "—";
