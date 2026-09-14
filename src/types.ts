export type PlanId = "basic" | "star" | "organization";
export type OrderStatus = "pending" | "paid" | "cancelled" | "review";

export interface Plan {
  id: PlanId;
  name: string;
  english: string;
  price: number;
  summary: string;
  audience: string;
  benefits: string[];
  actionLabel: string;
  ruleNote?: string;
}
export interface Service {
  id: string;
  title: string;
  category: string;
  summary: string;
  detail: string;
  availability: string;
}
export interface Story {
  id: string;
  tag: string;
  title: string;
  summary: string;
  paragraphs: string[];
}
export interface JoinForm {
  name: string;
  phone: string;
  city: string;
  company: string;
  industry: string;
  need: string;
  referral: string;
  organizationType: string;
}
export interface DemoOrder {
  id: string;
  planId: PlanId;
  form: JoinForm;
  amount: number;
  createdAt: string;
  paidAt?: string;
  expiresAt?: string;
  status: OrderStatus;
}
export interface DemoPost {
  id: string;
  title: string;
  body: string;
  author: string;
  status: "pending" | "published" | "rejected";
  reason?: string;
}
export interface DemoState {
  version: 1;
  orders: DemoOrder[];
  posts: DemoPost[];
  memberOrderId: string | null;
}
