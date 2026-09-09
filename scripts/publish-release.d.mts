// 类型声明：让 TypeScript 测试可以导入 scripts/publish-release.mjs 并注入假的 npm 执行器。
export const registry: string;
export const releasePackages: string[];

export function tarballIntegrity(value: Uint8Array | string): string;

export interface ReleasePackageResult {
  name: string;
  status: "published" | "skipped";
  integrity: string | null;
}

export interface ReleaseResult {
  ok: true;
  version: string;
  registry: string;
  packages: ReleasePackageResult[];
}

export interface PublishReleaseOptions {
  directory: string;
  root?: string;
  exec?: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr?: string }>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function publishRelease(options: PublishReleaseOptions): Promise<ReleaseResult>;
