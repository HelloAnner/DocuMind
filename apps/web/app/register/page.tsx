"use client";

import Link from "next/link";
import { BrandMark } from "@/components/ui/brand-mark";

/** 公开注册关闭后，注册页只说明账号来源；新账号由 Portal 邀请链接创建。 */
export default function RegisterPage() {
  return (
    <main className="dm-login-page">
      <header className="dm-login-brandbar"><BrandMark /></header>
      <section className="dm-login-story" aria-label="DocuMind 邀请开通说明">
        <div className="dm-login-story-copy">
          <div className="dm-login-story-kicker"><span />账号由邀请开通</div>
          <h2><span>没有公开</span><strong>注册入口</strong></h2>
          <p>请使用企业管理员发送的邀请链接创建账号并加入企业空间。已有账号可直接登录。</p>
        </div>
      </section>
      <section className="dm-login-card">
        <div className="dm-login-card-heading">
          <span className="dm-login-eyebrow">邀请制</span>
          <h1>账号由企业管理员邀请开通</h1>
          <p>邀请链接会同时完成注册和加入空间，不需要单独注册。</p>
        </div>
        <Link className="dm-button primary dm-login-submit" href="/login">返回登录</Link>
      </section>
    </main>
  );
}
