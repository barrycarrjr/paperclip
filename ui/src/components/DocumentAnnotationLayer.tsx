import React from "react";

export type PendingAnchor = any;
export type AnnotationAnchorRect = any;

export interface DocumentAnnotationLayerProps {
  containerRef?: React.RefObject<HTMLElement | null>;
  markdown?: string;
  threads?: any[];
  focusedThreadId?: string | null;
  onThreadFocus?: (id: string | null) => void;
  pendingAnchor?: any;
  onPendingAnchorChange?: (anchor: any) => void;
  onRequestComment?: (anchor: any) => void;
  hideResolved?: boolean;
}

export function DocumentAnnotationLayer(_props: DocumentAnnotationLayerProps) {
  return null;
}
