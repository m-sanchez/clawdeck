import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkspaceInfo } from "../../../types";

type ThreadDeepLink = {
  workspaceId: string;
  threadId: string;
  notifiedAt: number;
};

type Params = {
  hasLoadedWorkspaces: boolean;
  workspacesById: Map<string, WorkspaceInfo>;
  refreshWorkspaces: () => Promise<WorkspaceInfo[] | undefined>;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  openThreadLink: (workspaceId: string, threadId: string) => void;
  maxAgeMs?: number;
};

type Result = {
  recordPendingThreadLink: (workspaceId: string, threadId: string) => void;
  openThreadLinkOrQueue: (workspaceId: string, threadId: string) => void;
};

export function useSystemNotificationThreadLinks({
  hasLoadedWorkspaces,
  workspacesById,
  refreshWorkspaces,
  connectWorkspace,
  openThreadLink,
  maxAgeMs = 120_000,
}: Params): Result {
  const pendingLinkRef = useRef<ThreadDeepLink | null>(null);
  const refreshInFlightRef = useRef(false);

  const queuePendingThreadLink = useCallback((workspaceId: string, threadId: string) => {
    pendingLinkRef.current = { workspaceId, threadId, notifiedAt: Date.now() };
  }, []);

  const tryNavigateToLink = useCallback(async () => {
    const link = pendingLinkRef.current;
    if (!link) {
      return;
    }
    if (Date.now() - link.notifiedAt > maxAgeMs) {
      pendingLinkRef.current = null;
      return;
    }

    let workspace = workspacesById.get(link.workspaceId) ?? null;
    if (!workspace && hasLoadedWorkspaces && !refreshInFlightRef.current) {
      refreshInFlightRef.current = true;
      try {
        const refreshed = await refreshWorkspaces();
        workspace =
          refreshed?.find((entry) => entry.id === link.workspaceId) ?? null;
      } finally {
        refreshInFlightRef.current = false;
      }
    }

    if (!workspace) {
      pendingLinkRef.current = null;
      return;
    }

    if (!workspace.connected) {
      try {
        await connectWorkspace(workspace);
      } catch {
        // Ignore connect failures; user can retry manually.
      }
    }

    openThreadLink(link.workspaceId, link.threadId);
    pendingLinkRef.current = null;
  }, [
    connectWorkspace,
    hasLoadedWorkspaces,
    maxAgeMs,
    openThreadLink,
    refreshWorkspaces,
    workspacesById,
  ]);

  const openThreadLinkOrQueue = useCallback(
    (workspaceId: string, threadId: string) => {
      queuePendingThreadLink(workspaceId, threadId);
      if (hasLoadedWorkspaces) {
        void tryNavigateToLink();
      }
    },
    [hasLoadedWorkspaces, queuePendingThreadLink, tryNavigateToLink],
  );

  const focusHandler = useMemo(() => () => void tryNavigateToLink(), [tryNavigateToLink]);

  useEffect(() => {
    window.addEventListener("focus", focusHandler);
    return () => window.removeEventListener("focus", focusHandler);
  }, [focusHandler]);

  useEffect(() => {
    if (!pendingLinkRef.current) {
      return;
    }
    if (!hasLoadedWorkspaces) {
      return;
    }
    void tryNavigateToLink();
  }, [hasLoadedWorkspaces, tryNavigateToLink]);

  return {
    recordPendingThreadLink: queuePendingThreadLink,
    openThreadLinkOrQueue,
  };
}
