import type { CmuxApi } from './index';

declare global {
  interface Window {
    cmux: CmuxApi;
  }
}

export {};
