export interface PanelServiceConfig {
  id: string;
  label?: string;
  entry: string;
  cwd?: string;
  args?: string[];
  healthPath: string;
  urlPath?: string;
  portEnv?: string;
}

export interface PanelConfig {
  schemaVersion: 1;
  runtimeRoot: string;
  ports: {
    preferredBase: number;
    searchSpan: number;
  };
  browser: {
    openByDefault: boolean;
  };
  services: PanelServiceConfig[];
  primaryService: string;
  worktree?: {
    setupCandidates?: string[];
    runCandidates?: string[];
  };
}

export interface OwnedServiceRuntime {
  id: string;
  label?: string;
  pid: number;
  port: number;
  url: string;
  healthUrl: string;
  logPath: string;
  startedAt: string;
}

export interface PanelRuntimeRegistry {
  schemaVersion: 1;
  checkoutId: string;
  checkoutRoot: string;
  repoRoot: string;
  branch?: string;
  runtimeDir: string;
  services: OwnedServiceRuntime[];
  updatedAt: string;
}
