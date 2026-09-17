// UUID 生成与校验（唯一入口，禁止引入 uuid 包）
export function newUuid(): string {
  return crypto.randomUUID();
}
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
