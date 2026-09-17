// Hono 应用环境类型
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';

export interface AppEnv {
  Variables: {
    appState: AppState;
    actor: CurrentActor;
  };
}
