import type { TenantLoginContext, TenantLoginTone } from "@/lib/auth";

interface ToneNarrative {
  kicker: string;
  headline: string;
  description: string;
  principles: [string, string, string];
}

export interface TenantLoginProfile {
  tenantName: string;
  tenantSlug?: string;
  tone: TenantLoginTone;
  kicker: string;
  headlineLead: string;
  headline: string;
  description: string;
  welcome: string;
  welcomeDescription: string;
  spaceLabel: string;
  monogram: string;
  signature: string;
  principles: [string, string, string];
  isTenant: boolean;
}

const tones: TenantLoginTone[] = ["violet", "azure", "jade", "amber", "rose"];

const narratives: Record<TenantLoginTone, ToneNarrative> = {
  violet: {
    kicker: "让知识有来处，让判断有依据",
    headline: "让每一次判断，都站在经验之上",
    description: "把散落在文档里的事实、方法与上下文，沉淀为团队随时可用的共同认知。",
    principles: ["可信引用", "上下文完整", "经验复用"],
  },
  azure: {
    kicker: "复杂资料，自有清晰脉络",
    headline: "把分散的信息，整理成共同的方向",
    description: "连接业务资料与真实语境，让团队更快找到线索，也更从容地作出判断。",
    principles: ["快速定位", "清晰脉络", "协同判断"],
  },
  jade: {
    kicker: "沉淀经验，延续专业",
    headline: "让组织记忆，持续回应今天的问题",
    description: "保存知识背后的原因与过程，让专业经验跨越项目、角色与时间继续生长。",
    principles: ["专业沉淀", "权限清晰", "持续生长"],
  },
  amber: {
    kicker: "从文档现场，到行动答案",
    headline: "让每一份资料，都更接近下一步行动",
    description: "从海量信息中提炼关键依据，把搜索、理解与行动串联成完整的知识路径。",
    principles: ["关键提炼", "行动导向", "过程可溯"],
  },
  rose: {
    kicker: "汇聚洞见，也保留温度",
    headline: "让团队的经验，成为彼此可靠的回声",
    description: "将个人洞察汇入组织知识，让每一次分享都能在需要时被重新看见。",
    principles: ["洞见汇聚", "团队共享", "可靠回应"],
  },
};

const genericNarrative: ToneNarrative = {
  kicker: "企业知识，持续生长",
  headline: "把散落的知识，变成清晰的判断",
  description: "让企业文档可追溯、可对话，也让重要经验在每一次使用中继续生长。",
  principles: ["知识检索", "引用定位", "多轮追问"],
};

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tenantMonogram(name: string) {
  const characters = Array.from(name.replace(/[\s·•—_-]/g, ""));
  return characters.slice(0, 2).join("") || "知";
}

export function createTenantLoginProfile(context: TenantLoginContext | null): TenantLoginProfile {
  if (!context) {
    return {
      tenantName: "DocuMind",
      tone: "violet",
      kicker: genericNarrative.kicker,
      headlineLead: "知识不止被保存，",
      headline: genericNarrative.headline,
      description: genericNarrative.description,
      welcome: "欢迎回来",
      welcomeDescription: "登录后继续探索你的企业知识。",
      spaceLabel: "DocuMind 企业知识空间",
      monogram: "知",
      signature: "知识中枢",
      principles: genericNarrative.principles,
      isTenant: false,
    };
  }

  const hash = stableHash(`${context.slug}:${context.name}`);
  const tone = context.branding.tone ?? tones[hash % tones.length];
  const narrative = narratives[tone];
  const tenantName = context.name.trim();

  return {
    tenantName,
    tenantSlug: context.slug,
    tone,
    kicker: context.branding.kicker ?? narrative.kicker,
    headlineLead: `${tenantName} 的知识，`,
    headline: context.branding.headline ?? narrative.headline,
    description: context.branding.description ?? narrative.description,
    welcome: context.branding.welcome ?? `欢迎回到 ${tenantName}`,
    welcomeDescription: `进入 ${tenantName} 的专属知识空间。`,
    spaceLabel: `${tenantName} · 专属知识空间`,
    monogram: tenantMonogram(tenantName),
    signature: `空间印记 ${String(hash % 1000).padStart(3, "0")}`,
    principles: narrative.principles,
    isTenant: true,
  };
}
