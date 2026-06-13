import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="dm-login-page">
      <div className="dm-login-hero">
        <div className="dm-login-orb" />
        <h1 className="dm-login-brand">DocuMind</h1>
        <p className="dm-login-subtitle">向你的文档提问，获取精准答案</p>
      </div>

      <div className="dm-login-card">
        <h2>登录到你的工作空间</h2>

        <div className="dm-login-field">
          <label htmlFor="email">邮箱</label>
          <input id="email" type="email" placeholder="name@company.com" />
        </div>

        <div className="dm-login-field">
          <label htmlFor="password">密码</label>
          <input id="password" type="password" placeholder="••••••••" />
        </div>

        <Link className="dm-login-button" href="/chat">
          登录
        </Link>
      </div>
    </main>
  );
}
