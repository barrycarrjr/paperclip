import React from "react";

export interface IssueDocumentAnnotationsProps {
  issueId?: string;
  doc?: any;
  bodyMarkdown?: string;
  draftDirty?: boolean;
  draftConflicted?: boolean;
  historicalPreview?: boolean;
  locationHash?: string;
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
  agentMap?: Record<string, any>;
  userProfileMap?: Record<string, any>;
  initialComposerAnchor?: any;
  onInitialComposerAnchorConsumed?: () => void;
  children?: React.ReactNode;
}

export function IssueDocumentAnnotations({ children }: IssueDocumentAnnotationsProps) {
  return <>{children}</>;
}

export function DocumentAnnotationsCountChip(_props: any) {
  return null;
}
