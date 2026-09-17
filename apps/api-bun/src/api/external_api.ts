// 桩文件：由移植代理（认证组）替换
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';

/** 对应 Rust api/external_api.rs 的 actor_from_api_headers。 */
export async function actorFromApiHeaders(
  _state: AppState, _headers: Headers,
): Promise<CurrentActor | null> {
  return null;
}
