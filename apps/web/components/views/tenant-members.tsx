"use client";

// 两个管理入口共用同一套成员与邀请操作，避免租户入口退化为只读列表。
export { AdminMembers as TenantMembers } from "./admin-members";
